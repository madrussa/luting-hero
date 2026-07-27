// Computer-keyboard layouts for playing without a MIDI device.

/**
 * The classic DAW piano layout: the home row is the white keys, the row above
 * holds the black keys where they'd physically sit.
 *
 * Offsets are semitones from the keyboard's base octave and may be **negative**
 * — the bottom row reaches the octave below, which is the only way to play a
 * part that sits under the home row without shifting the whole layout. Any key
 * can be bound to any offset; these are only where it starts.
 */
export const PIANO_KEYS: Record<string, number> = {
  // octave below, on the row under the home row
  z: -12, x: -10, c: -8, v: -7, b: -5, n: -3, m: -1,
  // home row: white keys, with the black keys above them
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17,
}

/**
 * Drum lanes get keys in reading order across three rows. A kit track uses only
 * the sounds it actually plays, so lane 0 (the kick, since lanes are ordered
 * low to high) always lands on the same comfortable key whatever the song.
 */
export const DRUM_KEY_ORDER = [
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';',
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  'z', 'x', 'c', 'v', 'b',
]

/**
 * The arrow keys shift the whole layout by an octave. They used to be Z and X,
 * which are now needed for notes — and arrows can't be bound to a note anyway
 * (isBindable rejects them), so they can't be taken away by a remap.
 */
export const OCTAVE_DOWN_KEY = 'arrowleft'
export const OCTAVE_UP_KEY = 'arrowright'

/** True when a keystroke should go to a text field instead of the game. */
export function isTypingTarget(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable
}
