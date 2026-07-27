// The player's own collection of lutings.
//
// Nothing ships with the app — every song here was added by whoever is using
// it, and lives in their browser. A luting is identified by a hash of its
// notation, so adding the same music twice is recognised as the same song
// however it arrived: pasted, dropped as a file, or restored from a collection
// zip exported months earlier.

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { lutingHash, prepareLuting, stripComments } from './hash'
import { LIBRARY, tx } from './db'

export interface LibrarySong {
  /** lutingHash of the notation; the primary key */
  hash: string
  title: string
  /** whoever transcribed or wrote it; blank if unknown */
  artist: string
  /** the luting, as typed */
  text: string
  addedAt: number
}

/** A luting has to have a tempo header and at least something after it. */
export function looksLikeLuting(text: string): boolean {
  const body = prepareLuting(text).text
  return /#lute\s*\d+/.test(body) && body.replace(/\s+/g, '').length > 8
}

export async function listLibrary(): Promise<LibrarySong[]> {
  const all = (await tx<LibrarySong[]>(LIBRARY, 'readonly', (s) => s.getAll())) ?? []
  return all.sort((a, b) => a.title.localeCompare(b.title))
}

export const getLibrarySong = (hash: string): Promise<LibrarySong | null> =>
  tx<LibrarySong>(LIBRARY, 'readonly', (s) => s.get(hash)).then((r) => r ?? null)

export const deleteLibrarySong = (hash: string): Promise<unknown> =>
  tx(LIBRARY, 'readwrite', (s) => s.delete(hash))

export interface AddResult {
  status: 'added' | 'duplicate' | 'invalid'
  song?: LibrarySong
  /** on a duplicate, what was already there */
  existing?: LibrarySong
}

/**
 * Add one luting. The hash is of the notation alone — comments and whitespace
 * stripped — so re-importing the same music under a different title is still
 * recognised as a duplicate, and the copy already in the collection wins.
 */
export async function addLuting(input: {
  title: string
  artist?: string
  text: string
}): Promise<AddResult> {
  // Stored in its rejoined form, so a multilute is a single playable luting
  // from here on and an export of it re-imports as one file.
  const text = prepareLuting(input.text).text.trim()
  if (!looksLikeLuting(text)) return { status: 'invalid' }

  const hash = lutingHash(text)
  const existing = await getLibrarySong(hash)
  if (existing) return { status: 'duplicate', existing }

  const song: LibrarySong = {
    hash,
    title: input.title.trim() || 'Untitled luting',
    artist: (input.artist ?? '').trim(),
    text,
    addedAt: Date.now(),
  }
  await tx(LIBRARY, 'readwrite', (s) => s.put(song))
  return { status: 'added', song }
}

// ---------------------------------------------------------------------------
// .lute files

/**
 * Read the `//Title` / `//Author:` header lines a .lute file conventionally
 * opens with, so an imported file doesn't have to be described by hand.
 */
export function readLuteHeader(text: string, fallbackTitle: string): { title: string; artist: string } {
  let title = ''
  let artist = ''
  for (const raw of text.split('\n').slice(0, 6)) {
    const line = raw.trim()
    if (!line.startsWith('//')) continue
    const body = line.replace(/^\/+/, '').replace(/\/+$/, '').trim()
    const byline = body.match(/^(?:author|artist|by)\s*:\s*(.+)$/i)
    if (byline) artist ||= byline[1].trim()
    else if (!title && body) title = body
  }
  return { title: title || fallbackTitle, artist }
}

/**
 * Serialise for export. The header lines are rewritten from the stored
 * metadata rather than kept from the original, so a title edited here survives
 * the round trip — and since the hash ignores comments, re-importing still
 * dedupes against the same song.
 */
export function toLuteFile(song: LibrarySong): string {
  const head = [`//${song.title}`]
  if (song.artist) head.push(`//Author: ${song.artist}`)
  return `${head.join('\r\n')}\r\n${stripComments(song.text).replace(/^\s+/, '')}`
}

/** A filename that survives every filesystem, unique within one export. */
export function luteFilename(song: LibrarySong, taken: Set<string>): string {
  const base =
    song.title
      .replace(/[^A-Za-z0-9 _-]+/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 60) || 'luting'
  let name = `${base}.lute`
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n}).lute`
  taken.add(name.toLowerCase())
  return name
}

// ---------------------------------------------------------------------------
// Import / export

export interface ImportSummary {
  added: number
  duplicates: number
  invalid: string[]
}

const emptySummary = (): ImportSummary => ({ added: 0, duplicates: 0, invalid: [] })

async function addFromFile(name: string, text: string, into: ImportSummary): Promise<void> {
  const fallback = name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    // "GerudoValley" -> "Gerudo Valley", so a bare filename still reads
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  const { title, artist } = readLuteHeader(text, fallback)
  const res = await addLuting({ title, artist, text })
  if (res.status === 'added') into.added++
  else if (res.status === 'duplicate') into.duplicates++
  else into.invalid.push(name)
}

/**
 * Import whatever was dropped: loose .lute files, a collection zip, or a mix.
 * Everything is reported rather than thrown — one unreadable file in a zip of
 * fifty shouldn't lose the other forty-nine.
 */
export async function importFiles(files: File[]): Promise<ImportSummary> {
  const summary = emptySummary()
  for (const file of files) {
    const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip'
    if (isZip) {
      try {
        const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
        for (const [path, bytes] of Object.entries(entries)) {
          // zip directory entries are zero-length; skip anything not a luting
          if (!/\.lute$/i.test(path) || bytes.length === 0) continue
          await addFromFile(path.split('/').pop()!, strFromU8(bytes), summary)
        }
      } catch {
        summary.invalid.push(file.name)
      }
      continue
    }
    try {
      await addFromFile(file.name, await file.text(), summary)
    } catch {
      summary.invalid.push(file.name)
    }
  }
  return summary
}

/** The whole collection as a zip of .lute files. */
export function exportCollection(songs: LibrarySong[]): Blob {
  const taken = new Set<string>()
  const files: Record<string, Uint8Array> = {}
  for (const song of songs) files[luteFilename(song, taken)] = strToU8(toLuteFile(song))
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' })
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // Revoked on a later tick: revoking synchronously can beat the download in
  // some browsers and produce an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
