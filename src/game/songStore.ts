// Per-song memory, in IndexedDB, keyed by the luting's hash.
//
// Global preferences (theme, volume, key bindings) live in localStorage — they
// are small, synchronous, and wanted before the first paint. This store is for
// the things that belong to *one song*: which instrument you last played, what
// you scored on it, and any speed or timing you dialled in for that chart
// specifically. Those grow without bound and are worth keeping properly.

export interface SongBest {
  score: number
  grade: string
  /** 0..1 */
  accuracy: number
  maxCombo: number
  notes: number
  at: number
}

import type { Bindings } from './bindings'
import type { KeyboardMode } from './settings'
import { SONGS, tx } from './db'

/**
 * How a run is filed under `best`: by instrument, and by the keyboard it was
 * played on. The same part on eight folded keys and on the full chromatic
 * keyboard are different feats with different note counts, so one shouldn't
 * overwrite or flatter the other.
 *
 * Hard mode keeps the bare instrument code, because that is what every score
 * saved before the fold existed was played on — near enough, and it beats
 * orphaning them all.
 */
export const bestKey = (instrument: string, mode: KeyboardMode): string =>
  mode === 'hard' ? instrument : `${instrument}:${mode}`

export interface SongRecord {
  /** lutingHash of the notation */
  hash: string
  title: string
  updatedAt: number
  /** instrument code last chosen for this song */
  lastInstrument?: string
  /** best run per instrument code */
  best: Record<string, SongBest>
  /**
   * Per-song overrides of the global settings. A dense chart often wants a
   * different scroll speed from everything else, and re-dialling it every time
   * is exactly the sort of thing a computer should remember.
   */
  overrides: {
    approachSec?: number
    offsetMs?: number
    hitWindow?: string
  }
  /**
   * This song's own key mapping. Absent until you remap something, at which
   * point the song stops inheriting and keeps what you set — so switching
   * between songs restores each one's layout instead of making you redo it.
   */
  bindings?: Partial<Bindings>
}

export const emptyRecord = (hash: string, title: string): SongRecord => ({
  hash,
  title,
  updatedAt: Date.now(),
  best: {},
  overrides: {},
})

export async function loadSongRecord(hash: string): Promise<SongRecord | null> {
  const rec = (await tx<SongRecord>(SONGS, 'readonly', (s) => s.get(hash))) ?? null
  if (!rec) return null
  // Records written by an older build may predate a field.
  return { ...emptyRecord(rec.hash, rec.title), ...rec }
}

export async function saveSongRecord(rec: SongRecord): Promise<void> {
  await tx(SONGS, 'readwrite', (s) => s.put({ ...rec, updatedAt: Date.now() }))
}

export async function listSongRecords(): Promise<SongRecord[]> {
  const all = (await tx<SongRecord[]>(SONGS, 'readonly', (s) => s.getAll())) ?? []
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteSongRecord(hash: string): Promise<void> {
  await tx(SONGS, 'readwrite', (s) => s.delete(hash))
}

/** Keep a run only if it beat what's already stored. */
export function withBest(rec: SongRecord, instrument: string, run: SongBest): SongRecord {
  const prev = rec.best[instrument]
  if (prev && prev.score >= run.score) return rec
  return { ...rec, best: { ...rec.best, [instrument]: run } }
}
