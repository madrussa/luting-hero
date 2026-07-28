// A stable identity for a luting.
//
// Songs arrive from three places — bundled, dropped as a file, pasted as text —
// and none of those gives a durable id. The notation itself does: hash the
// music and the same song is the same song however it got here, so per-song
// settings and scores survive a re-paste, and two people with the same luting
// can exchange a setup for it.
//
// Comments and whitespace are stripped first, so retitling a luting or
// reflowing it doesn't orphan its record. Changing a *note* deliberately does
// — that's a different chart to play.

import { reassembleMultilute } from '../luting-core/luting'

const HASH_HEADER = /#lute\s*(\d+)/

/**
 * Remove comments, tolerating both conventions in the wild.
 *
 * LuteBoi's syntax treats `//` as a *paired* delimiter — `// like this //` —
 * and the vendored parser implements that by splitting on `//` and keeping the
 * even-numbered pieces. But every real .lute file opens with unpaired line
 * comments (`//Title`, `//Author: …`), and that rule only survives them by
 * accident: with an even number of markers before the music the halves line up,
 * with an odd number the split inverts and the *music* is discarded as comment.
 * A luting with a single `//Title` line parses to silence.
 *
 * With the usual two header lines the split keeps everything after the *second*
 * `//` — which is the author's name followed by the music. So the byline has
 * been parsed as notation: in `//Author: JustAnAnnoyingCat`, `i` sets the
 * instrument to the `n` after it, `r` inserts a rest, `o` an octave, and `g`
 * and `a` are notes. A file signed "JustAnAnnoyingCat" reported "Macro A/J/C
 * used before being defined" and grew a phantom instrument, because J, A and C
 * are the capitals in the name.
 *
 * So comments are stripped here, before the parser sees them: paired spans
 * first (they bind tighter), then anything left from `//` to end of line. The
 * parser's own rule is then a no-op over text that has none left.
 *
 * The character class is `[^\r\n]`, not `.`, and there is no `$` anchor —
 * these files are CRLF, and in JavaScript `\r` counts as a line terminator, so
 * `.` refuses to cross it and an unanchored-by-`m` `$` only matches the very
 * end of the input. `/\/\/.*$/` therefore matched nothing at all on a CRLF
 * line, which is a silent no-op rather than an error.
 */
export function stripComments(text: string): string {
  return text.replace(/\/\/[^\r\n]*?\/\//g, '').replace(/\/\/[^\r\n]*/g, '')
}

/**
 * Rejoin a multilute — the `#lute m BPM …` several-messages format the LuteBoi
 * optimiser emits when a song won't fit in one Twitch cheer.
 *
 * Parts are raw character splits, so a cut can land mid-token, and the pieces
 * only mean anything concatenated. The vendored parser doesn't do this itself
 * (Luting Studio does it at its own import boundary), so pasting a multilute
 * would otherwise read only as far as the first part's header and drop the rest.
 * A single-message luting passes through untouched.
 */
export function joinMultilute(text: string): { text: string; warnings: string[] } {
  const warnings: string[] = []
  return { text: reassembleMultilute(stripComments(text), warnings), warnings }
}

/**
 * The notation, ready to parse: comments gone and any multilute rejoined.
 * Everything that reads a luting goes through here, so a song is the same song
 * whether it arrived as one message or five.
 */
export const prepareLuting = (text: string): { text: string; warnings: string[] } =>
  joinMultilute(text)

/** The bytes that actually determine what you play. */
export function normaliseLuting(text: string): string {
  return joinMultilute(text).text.replace(/\s+/g, '')
}

/**
 * FNV-1a, run twice with different offset bases and concatenated, for a 64-bit
 * hex digest. Not cryptographic and not trying to be: this only has to keep a
 * personal library of a few hundred lutings apart, where a 32-bit hash would
 * already be comfortable and 64 bits makes a collision a non-issue. Synchronous,
 * unlike SubtleCrypto, so callers stay simple.
 */
function fnv1a(input: string, offset: number): string {
  let h = offset >>> 0
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    // h *= 16777619, in 32-bit pieces to stay exact under float64
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** A 16-character hex id for a luting. */
export function lutingHash(text: string): string {
  const src = normaliseLuting(text)
  return fnv1a(src, 0x811c9dc5) + fnv1a(src, 0x01000193)
}

/**
 * A six-character digest of anything, for fingerprints that are read by eye
 * rather than stored — see `conditionCode`. Short on purpose: it has to be
 * comparable at a glance on a shared image.
 */
export const shortHash = (input: string): string => fnv1a(input, 0x811c9dc5).slice(0, 6)

/** The BPM header, handy for showing a stored record without re-parsing. */
export function lutingBpm(text: string): number {
  const m = text.match(HASH_HEADER)
  return m ? parseInt(m[1], 10) : 120
}
