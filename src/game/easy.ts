// Easy mode: folding a part onto a keyboard you can actually reach.
//
// Hard mode already draws only the pitches a part plays, which is a big cut —
// but "only the pitches it plays" is still seventeen keys for a bass line and
// more for anything chordal. That's fine on a controller and hopeless on a
// computer keyboard, where about eight keys is what one hand holds without
// moving. Owning the hardware shouldn't be the price of admission.
//
// So easy mode folds neighbouring pitches together until at most
// MAX_EASY_KEYS keys are left, and a chord whose notes land on the same key
// becomes a single press. Two rules keep the fold honest:
//
//   * **Order is preserved.** A key covers a contiguous run of pitches, so
//     going up in the part still means going right on the keyboard, and the
//     highway still reads as the shape of the music. A fold that sorted by
//     anything else would be a different song.
//   * **The busiest pitches keep their own key.** The fold minimises how far
//     each note sits from the centre of its group *weighted by how often it is
//     played*, so a pitch struck three hundred times is never merged away to
//     spare a key for one struck twice. That is one-dimensional k-means with an
//     order constraint, which a dynamic program solves exactly — and an exact
//     answer means a part always folds the same way.
//
// What you *hear* is not folded. A press sounds the notes it actually claimed —
// the real pitch, and the whole chord when a chord folded onto that key — so
// easy mode changes what you press, never what the song is.

import { SIMULTANEITY_SEC, mergeSimultaneous, rateDifficulty } from './chart'
import type { GameNote, NoteSound, Track } from './chart'
import { isBlackKey, noteName } from './lanes'
import type { KeyboardMode } from './settings'
import { DRUM_SOUNDS } from '../luting-core/luting'

/**
 * The most keys easy mode will draw. Eight is the home row minus the reach: a
 * hand covers it without moving, and eight lanes are still wide enough to read
 * at a glance on the highway.
 */
export const MAX_EASY_KEYS = 8

/**
 * Super EZ: four. One per finger, no thumb, nothing to learn — the floor of the
 * game, for playing along to a song you have never seen.
 */
export const MAX_SUPER_EZ_KEYS = 4

/**
 * The closest together Super EZ will ask for two presses of the same key.
 *
 * Folding onto four keys puts far more of a part on each one, and a run that was
 * comfortable spread over the keyboard becomes one finger tapping faster than it
 * can go. So on that setting notes landing on one key within a re-strike of each
 * other are one press — the same rule as a chord folding onto one key, with the
 * window opened from "at the same instant" to "as good as". They all still
 * sound, so the run is heard in full and struck once.
 *
 * A tenth of a second is about the limit of one finger repeating; the other
 * keyboards leave this alone and merge only what is genuinely simultaneous.
 */
export const RESTRIKE_SEC = 0.11

/** How many keys a mode folds onto, or null where nothing is folded. */
export const keyBudget = (mode: KeyboardMode): number | null =>
  mode === 'superez' ? MAX_SUPER_EZ_KEYS : mode === 'easy' ? MAX_EASY_KEYS : null

/**
 * What each keyboard is called. In one place because it is named in three — the
 * picker, the results screen and the shared score card — and a keyboard that
 * goes by two names is a keyboard nobody can compare scores on.
 */
export const KEYBOARD_LABELS: Record<KeyboardMode, string> = {
  superez: 'Super EZ',
  easy: 'Easy',
  hard: 'Hard',
  impossible: 'Impossible',
}

export interface EasyKey {
  /** lane id — 0-based, left to right, which is also its binding slot */
  lane: number
  /** the pitches folded onto this key, ascending; empty on a kit */
  midis: number[]
  /** the kit pieces folded onto this key, in kit order; empty when melodic */
  drums: string[]
  /** what the key sounds when it hasn't claimed a note: its busiest member */
  voice: NoteSound
  /** "C4", "C4–E4", "Kick", "Kick +2" */
  label: string
  /** more than one pitch or piece folded onto this key */
  folded: boolean
  /** the tint, taken from the busiest member so the pattern still varies */
  black: boolean
  /** octave of the busiest member, for the highway's anchor lines */
  octave: number
}

export interface EasyMap {
  keys: EasyKey[]
  /** the key a chart note lands on */
  laneOf: (note: NoteSound) => number
  /**
   * The key an incoming MIDI note lands on. Melodic keys carry on to meet their
   * neighbours, covering the whole pitch axis between them, so a controller
   * sitting an octave out still lands on the key the music is heading for
   * instead of nowhere at all. Kits fold by piece, not by pitch, so they answer
   * -1 here and go through `laneOf` once the drum is known.
   */
  laneOfMidi: (midi: number) => number
}

/**
 * How a part is folded onto `maxKeys` keys. Melodic parts fold by pitch, kits by
 * piece.
 */
export function buildEasyMap(track: Track, maxKeys = MAX_EASY_KEYS): EasyMap {
  return track.isDrums ? kitMap(track, maxKeys) : pitchMap(track, maxKeys)
}

/** How often each distinct value appears, for weighting the fold. */
function tally<T>(values: (T | undefined)[]): Map<T, number> {
  const counts = new Map<T, number>()
  for (const v of values) if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1)
  return counts
}

function pitchMap(track: Track, maxKeys: number): EasyMap {
  const counts = tally(track.notes.map((n) => n.midi))
  const pitches = [...counts.keys()].sort((a, b) => a - b)
  const groups = partition(pitches, pitches.map((p) => counts.get(p)!), maxKeys)

  const keys: EasyKey[] = groups.map((midis, lane) => {
    const voice = busiest(midis, counts)
    return {
      lane,
      midis,
      drums: [],
      voice: { midi: voice },
      label:
        midis.length === 1
          ? noteName(midis[0])
          : `${noteName(midis[0])}–${noteName(midis[midis.length - 1])}`,
      folded: midis.length > 1,
      black: isBlackKey(voice),
      octave: Math.floor(voice / 12),
    }
  })

  const laneByPitch = new Map<number, number>()
  keys.forEach((k) => k.midis.forEach((m) => laneByPitch.set(m, k.lane)))

  // Where one key hands over to the next: halfway between the two pitches
  // either side of the seam, so every pitch in between belongs to the nearer.
  const cuts: number[] = []
  for (let i = 1; i < keys.length; i++) {
    const below = keys[i - 1].midis
    cuts.push((below[below.length - 1] + keys[i].midis[0]) / 2)
  }
  const laneOfMidi = (midi: number): number => {
    let lane = 0
    while (lane < cuts.length && midi > cuts[lane]) lane++
    return lane
  }

  return {
    keys,
    laneOf: (note) => (note.midi === undefined ? -1 : laneByPitch.get(note.midi) ?? laneOfMidi(note.midi)),
    laneOfMidi,
  }
}

function kitMap(track: Track, maxKeys: number): EasyMap {
  const counts = tally(track.notes.map((n) => n.drum))
  // Kit order, not pitch: a fold has to keep the kick leftmost, and the
  // positions are what "neighbouring" means on a kit.
  const pieces = track.drums
  const groups = partition(
    pieces.map((_, i) => i),
    pieces.map((d) => counts.get(d) ?? 0),
    maxKeys
  )

  const name = (d: string) => DRUM_SOUNDS[d]?.name ?? d
  const keys: EasyKey[] = groups.map((positions, lane) => {
    const drums = positions.map((i) => pieces[i])
    const voice = drums.reduce((a, b) => ((counts.get(b) ?? 0) > (counts.get(a) ?? 0) ? b : a))
    return {
      lane,
      midis: [],
      drums,
      voice: { drum: voice },
      label: drums.length === 1 ? name(drums[0]) : `${name(drums[0])} +${drums.length - 1}`,
      folded: drums.length > 1,
      black: false,
      octave: 0,
    }
  })

  const laneByDrum = new Map<string, number>()
  keys.forEach((k) => k.drums.forEach((d) => laneByDrum.set(d, k.lane)))

  return {
    keys,
    laneOf: (note) => (note.drum === undefined ? -1 : laneByDrum.get(note.drum) ?? -1),
    laneOfMidi: () => -1,
  }
}

/** The member of a group that gets played most; the lowest of them on a tie. */
function busiest(values: number[], counts: Map<number, number>): number {
  return values.reduce((a, b) => ((counts.get(b) ?? 0) > (counts.get(a) ?? 0) ? b : a))
}

/**
 * Split ascending `values` into at most `k` contiguous groups, minimising the
 * weighted sum of squared distances from each group's own centre.
 *
 * The recurrence is the usual one — the best partition of the first j values
 * into g groups is the best partition of some prefix into g-1 groups plus one
 * group covering the rest — and prefix sums make each candidate group's cost
 * O(1), so the whole thing is O(k·n²) over a few dozen pitches. Small enough to
 * run on every track in the picker.
 */
function partition(values: number[], weights: number[], k: number): number[][] {
  const n = values.length
  if (n === 0) return []
  // Already reachable: every value keeps its own key, which is exactly hard
  // mode's keyboard. Easy mode isn't obliged to fold, only to fit.
  if (n <= k) return values.map((v) => [v])

  const w = [0]
  const wx = [0]
  const wxx = [0]
  for (let i = 0; i < n; i++) {
    w.push(w[i] + weights[i])
    wx.push(wx[i] + weights[i] * values[i])
    wxx.push(wxx[i] + weights[i] * values[i] * values[i])
  }
  /** weighted variance of values[i..j], from the sums above */
  const cost = (i: number, j: number): number => {
    const sw = w[j + 1] - w[i]
    if (sw <= 0) return 0
    const sx = wx[j + 1] - wx[i]
    return wxx[j + 1] - wxx[i] - (sx * sx) / sw
  }

  /** best[g][j]: cost of covering values[0..j] with g groups */
  const best: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n).fill(Infinity))
  /** where the last of those g groups starts */
  const start: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n).fill(0))
  for (let j = 0; j < n; j++) best[1][j] = cost(0, j)
  for (let g = 2; g <= k; g++) {
    for (let j = g - 1; j < n; j++) {
      for (let i = g - 1; i <= j; i++) {
        const c = best[g - 1][i - 1] + cost(i, j)
        if (c < best[g][j]) {
          best[g][j] = c
          start[g][j] = i
        }
      }
    }
  }

  const groups: number[][] = []
  let j = n - 1
  for (let g = k; g >= 1 && j >= 0; g--) {
    const i = start[g][j]
    groups.unshift(values.slice(i, j + 1))
    j = i - 1
  }
  return groups
}

export interface Playable {
  /** the part as it will be drawn, judged and scored */
  track: Track
  /** easy mode's folded keyboard; null in every other mode, where a lane is the pitch */
  easy: EasyMap | null
}

/**
 * The part as the chosen keyboard mode will actually ask you to play it.
 *
 * Only the folded modes change anything: the notes that landed on one key at one
 * moment become a single note that sounds all of them, and the difficulty is
 * re-rated against the folded keyboard, because a part you play on eight keys is
 * not the part you play on seventeen and the picker shouldn't claim it is.
 */
export function playableTrack(track: Track, mode: KeyboardMode): Playable {
  const maxKeys = keyBudget(mode)
  if (maxKeys === null) return { track, easy: null }
  const easy = buildEasyMap(track, maxKeys)
  // Nothing to fold onto: a part with no pitches and no kit isn't playable
  // anyway, and an empty keyboard has no geometry.
  if (easy.keys.length === 0) return { track, easy: null }

  const laneOf = (n: GameNote) => easy.laneOf(n)
  const notes = mergeSimultaneous(
    track.notes,
    laneOf,
    mode === 'superez' ? RESTRIKE_SEC : SIMULTANEITY_SEC
  )
  // A part that came through untouched is drawn on exactly the keyboard hard
  // mode would draw for it, so it is the same part and keeps the same rating.
  // Re-measuring it in keys instead of semitones could otherwise nudge it a step
  // *up* on the easier setting, which is worse than saying nothing.
  if (notes.length === track.notes.length && !easy.keys.some((k) => k.folded)) {
    return { track, easy }
  }
  return {
    track: { ...track, notes, difficulty: rateDifficulty(notes, track.isDrums, laneOf) },
    easy,
  }
}
