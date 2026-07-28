// Sharing a run, and sharing a song.
//
// Two different things, deliberately kept apart. A **condition code** says what
// was played and under what rules, so two players can be sure they are comparing
// the same thing. A **song link** carries the whole luting in the URL, so the
// song itself can be handed to someone with nothing to download.

import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate'
import { shortHash } from './hash'
import type { KeyboardMode } from './settings'

// ---------------------------------------------------------------------------
// The condition code

/** Everything that decides what a run asked of the player. */
export interface RunConditions {
  /** lutingHash of the notation — the song's real identity */
  songHash: string
  /** luting instrument code */
  instrument: string
  keyboard: KeyboardMode
  /** HitWindow id */
  hitWindow: string
}

/**
 * A short code for the conditions of a run, printed on the shared score.
 *
 * What it is for: two people compare codes, and if they match they know they
 * played the same song, the same part, on the same keyboard, with the same
 * timing window — the four things that change what a score means. A leaderboard
 * of one number is meaningless without that, since Super EZ on a Lenient window
 * is a different game from Impossible on Brutal.
 *
 * What it is *not*: proof that a score is real. There is no server and no secret
 * key here, so anyone determined can edit the picture or run a modified copy of
 * the game, and no code printed by the game itself can prevent that. This is for
 * comparing honestly among people who want to, which is the case that actually
 * comes up.
 *
 * Six hex characters is 16 million: ample for "are these the same?", where the
 * only cost of a collision is two different charts looking alike, and the codes
 * being compared are two, not two million.
 */
export const conditionCode = (c: RunConditions): string =>
  `LH1-${shortHash([c.songHash, c.instrument, c.keyboard, c.hitWindow].join('|'))}`

// ---------------------------------------------------------------------------
// The song link

/** What a share link carries: enough to add the song, and nothing else. */
export interface SharedSong {
  title: string
  artist: string
  text: string
}

/**
 * The fragment marker. A fragment, not a query string, for two reasons: it never
 * reaches a server, so a song shared this way stays as private as one pasted by
 * hand and no host logs it; and it isn't subject to anyone's URL length limit but
 * the browser's own, which is far above what a luting needs.
 */
export const SHARE_KEY = 's'

const toBase64Url = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (text: string): Uint8Array => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  // atob is inconsistent about missing padding across engines; put it back.
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Pack a song into a link.
 *
 * Deflated before it is base64'd, because luting notation is about as
 * compressible as text gets — a 1,300-note song is 923 characters of notation and
 * 868 of link. That matters: the point of a link is that it survives being pasted
 * into a chat window, and an uncompressed one would not.
 *
 * The payload is a positional array rather than an object: at this size the key
 * names would be a real fraction of it, and the leading version number is what
 * lets the shape change later without silently misreading old links.
 */
export function songLink(song: SharedSong, base: string): string {
  const payload = JSON.stringify([1, song.title, song.artist, song.text])
  const packed = toBase64Url(deflateSync(strToU8(payload), { level: 9 }))
  // Anything already in the fragment is ours to replace, not to append to.
  const url = new URL(base)
  url.hash = `${SHARE_KEY}=${packed}`
  return url.toString()
}

/**
 * Read a song back out of a location fragment, or null if there isn't one in
 * there. Never throws: a truncated link — pasted through something that wrapped
 * it, most likely — is a thing to report, not a crash.
 */
export function readSongLink(fragment: string): SharedSong | null {
  const raw = fragment.replace(/^#/, '')
  if (!raw.startsWith(`${SHARE_KEY}=`)) return null
  try {
    const packed = raw.slice(SHARE_KEY.length + 1)
    const parsed = JSON.parse(strFromU8(inflateSync(fromBase64Url(packed)))) as unknown
    if (!Array.isArray(parsed) || parsed[0] !== 1) return null
    const [, title, artist, text] = parsed as [number, unknown, unknown, unknown]
    if (typeof text !== 'string' || !text) return null
    return {
      title: typeof title === 'string' ? title : '',
      artist: typeof artist === 'string' ? artist : '',
      text,
    }
  } catch {
    return null
  }
}

/** True when this location has a shared song in it, without decoding it. */
export const hasSongLink = (fragment: string): boolean =>
  fragment.replace(/^#/, '').startsWith(`${SHARE_KEY}=`)
