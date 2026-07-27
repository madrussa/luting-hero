// Turning a luting into playable charts.
//
// A luting is a set of voices, each of which is strictly monophonic in time —
// the syntax has no way to overlap two notes within one voice, only to stack
// them into a chord that shares one duration. That's a limitation of the
// notation, not of the music, so composers work around it by writing the same
// instrument across several voices. The game has no such limit: a chart is just
// a bag of timed notes, so every voice sharing an instrument code is merged
// back into one track. Play "Lute" and you play all of the lute, however many
// voices it was spread over.
//
// Each track is then rated for difficulty from what it actually asks of the
// player, and the leftovers become the backing track.

import { parseLuting, DRUM_SOUNDS, INSTRUMENTS, instrumentByCode } from '../luting-core/luting'
import type { ScheduledNote } from '../luting-core/luting'
import { prepareLuting } from './hash'

/** Two onsets closer than this are "the same moment" for merging and chords. */
export const SIMULTANEITY_SEC = 0.012

/**
 * Below this, an instrument isn't offered as something to play.
 *
 * Arrangements are full of two- and three-note parts — a cymbal at the end, a
 * held pad, a single stab — and picking one means a minute of watching someone
 * else's song go by. They still *sound*: they're excluded from the instrument
 * list, not from the music, so they keep playing in the backing.
 */
export const MIN_PLAYABLE_NOTES = 10

export interface GameNote {
  /** stable within a chart; the judge and the renderer both key off it */
  id: number
  timeSec: number
  durSec: number
  /** melodic pitch; absent on drum notes */
  midi?: number
  /** DRUM_SOUNDS key; absent on melodic notes */
  drum?: string
  /** 0..1, carried through so hit notes sound at the written volume */
  volume: number
  /** which merged voice it came from, for the "N voices merged" readout */
  voice: number
}

export interface Difficulty {
  /** 1..10, the headline number */
  rating: number
  label: string
  /**
   * Onsets per second across the track's sounding span. Counted as onsets, not
   * notes, because that's what the hands actually do — a three-note chord is
   * one strike — and because counting notes here would let a chordy track
   * report an average above its own peak.
   */
  nps: number
  /** onsets in the busiest one-second window */
  peakNps: number
  /** widest simultaneous stack */
  maxChord: number
  /** semitones between the lowest and highest note (0 for drums) */
  span: number
  /** distinct keys to cover: pitches played, or kit pieces used */
  keys: number
}

export interface Track {
  /** luting instrument code */
  instrument: string
  name: string
  icon: string
  notes: GameNote[]
  /** source voice indices that were merged into this track */
  voices: number[]
  /** true when the notes are drum hits rather than pitches */
  isDrums: boolean
  /** melodic range, inclusive; both 0 for drum tracks */
  lowMidi: number
  highMidi: number
  /**
   * Every distinct pitch the part actually plays, ascending. Easy mode draws a
   * key per entry instead of a full chromatic keyboard — most parts use a small
   * fraction of their range, and the unused keys are only there to be missed.
   */
  pitches: number[]
  /** DRUM_SOUNDS keys used, low to high; empty for melodic tracks */
  drums: string[]
  difficulty: Difficulty
}

export interface Chart {
  bpm: number
  durationSec: number
  tracks: Track[]
  /** every note, so a track's backing is "all of these minus mine" */
  allNotes: ScheduledNote[]
  warnings: string[]
}

/** Order drum keys the way they sit on a kit: kick low, cymbals high. */
const drumOrder = (key: string): number => {
  const keys = Object.keys(DRUM_SOUNDS)
  const i = keys.indexOf(key)
  return i === -1 ? keys.length : i
}

/**
 * Merge notes that land on the same pitch at the same instant. Two voices
 * doubling a melody would otherwise put two bars in one lane, and the player
 * can only press the key once — so they collapse into a single note holding
 * the longest duration and the loudest volume.
 */
function mergeUnisons(notes: GameNote[]): GameNote[] {
  const out: GameNote[] = []
  // notes arrive sorted by time; only scan back over the simultaneity window
  for (const n of notes) {
    const lane = n.drum ?? n.midi
    let merged = false
    for (let i = out.length - 1; i >= 0; i--) {
      const p = out[i]
      if (n.timeSec - p.timeSec > SIMULTANEITY_SEC) break
      if ((p.drum ?? p.midi) !== lane) continue
      p.durSec = Math.max(p.durSec, n.durSec)
      p.volume = Math.max(p.volume, n.volume)
      merged = true
      break
    }
    if (!merged) out.push({ ...n })
  }
  return out
}

/**
 * Rate how hard a track is to play, 1..10.
 *
 * Four things make a chart hard, and they're close to independent: how many
 * notes per second come at you, how many keys you have to hold down at once,
 * how far your hands travel between them, and how irregular the rhythm is.
 * Each is scored on its own 0..1 curve and then weighted, rather than summed
 * raw — a 500-note track isn't hard if the notes are spread over five minutes,
 * and density alone would rank a fast hi-hat pattern above a slow wide-voiced
 * piano part.
 */
export function rateDifficulty(notes: GameNote[], isDrums: boolean): Difficulty {
  if (notes.length === 0) {
    return { rating: 1, label: 'Empty', nps: 0, peakNps: 0, maxChord: 0, span: 0, keys: 0 }
  }

  const start = notes[0].timeSec
  const end = notes.reduce((m, n) => Math.max(m, n.timeSec + n.durSec), 0)
  const span = Math.max(1, end - start)

  // Group into onsets so chords count once for density and once for width.
  const onsets: { t: number; pitches: number[] }[] = []
  for (const n of notes) {
    const last = onsets[onsets.length - 1]
    if (last && n.timeSec - last.t <= SIMULTANEITY_SEC) last.pitches.push(n.midi ?? 0)
    else onsets.push({ t: n.timeSec, pitches: [n.midi ?? 0] })
  }

  // Busiest one-second window, by sliding over onsets rather than sampling on a
  // grid — a burst that straddles two grid cells still registers at full height.
  let peakNps = 0
  for (let i = 0, j = 0; i < onsets.length; i++) {
    while (onsets[j].t < onsets[i].t - 1) j++
    peakNps = Math.max(peakNps, i - j + 1)
  }

  const nps = onsets.length / span
  const maxChord = onsets.reduce((m, o) => Math.max(m, o.pitches.length), 0)

  const midis = notes.map((n) => n.midi).filter((m): m is number => m !== undefined)
  const pitchSpan = midis.length ? Math.max(...midis) - Math.min(...midis) : 0

  // Hand travel per second. For pitched parts that's semitones moved between
  // consecutive onsets; for a kit it's how often the hit moves to a different
  // pad, since the distance between pads means nothing.
  let travel = 0
  if (isDrums) {
    let switches = 0
    for (let i = 1; i < notes.length; i++) if (notes[i].drum !== notes[i - 1].drum) switches++
    travel = Math.min(1, switches / span / 4)
  } else {
    let jumped = 0
    for (let i = 1; i < onsets.length; i++) {
      jumped += Math.abs(Math.min(...onsets[i].pitches) - Math.min(...onsets[i - 1].pitches))
    }
    travel = Math.min(1, jumped / span / 24) // 2 octaves of movement a second = max
  }

  // How many distinct keys there are to cover. This is *not* the pitch span: a
  // part can range over two octaves and still only use four notes, and a part
  // can sit inside one octave and use every semitone in it. The second is much
  // harder to play, and until this was counted separately the rating couldn't
  // tell them apart. Fourteen-odd keys is about where a part stops fitting
  // under the hands.
  const keyCount = isDrums
    ? new Set(notes.map((n) => n.drum)).size
    : new Set(midis).size
  const spread = Math.min(1, Math.max(0, keyCount - 1) / 11)

  // Rhythmic irregularity: how many distinct inter-onset gaps appear, rounded
  // to 10ms. A straight sixteenth run has one; a syncopated part has many.
  const gaps = new Set<number>()
  for (let i = 1; i < onsets.length; i++) {
    const g = Math.round((onsets[i].t - onsets[i - 1].t) * 100)
    if (g > 0) gaps.add(g)
  }
  const irregularity = Math.min(1, gaps.size / 12)

  const density = Math.min(1, peakNps / 14)
  const chords = Math.min(1, (maxChord - 1) / 4)
  const reach = Math.min(1, pitchSpan / 36)

  // Span carries less weight now that the key count is measured directly — it
  // was standing in for "how much keyboard is involved", and doing it badly.
  const score =
    0.3 * density + 0.3 * spread + 0.14 * chords + 0.1 * travel + 0.06 * reach + 0.1 * irregularity
  // Sparse tracks stay easy however wide they reach: a two-note-per-bar bass
  // line shouldn't inherit a hard rating from its octave leaps.
  const sustained = Math.min(1, nps / 3)
  const rating = Math.max(1, Math.min(10, Math.round(1 + score * 9 * (0.55 + 0.45 * sustained))))

  return {
    rating,
    label: DIFFICULTY_LABELS[rating - 1],
    nps: Math.round(nps * 10) / 10,
    peakNps,
    maxChord,
    span: pitchSpan,
    keys: keyCount,
  }
}

export const DIFFICULTY_LABELS = [
  'Beginner', 'Beginner', 'Easy', 'Easy',
  'Medium', 'Medium', 'Hard', 'Hard',
  'Expert', 'Luting Hero',
]

/** Parse a luting and split it into one playable track per instrument. */
export function buildChart(text: string): Chart {
  // Comments are stripped and multilutes rejoined before the parser sees the
  // text — see stripComments and joinMultilute for why neither can be left to it.
  const prepared = prepareLuting(text)
  const { bpm, notes, durationSec, warnings: raw } = parseLuting(prepared.text)
  // The parser reports per occurrence, so a macro used before its definition in
  // five voices is five identical lines. One is the useful information.
  const warnings = [...new Set([...prepared.warnings, ...raw])]

  const byInstrument = new Map<string, ScheduledNote[]>()
  for (const n of notes) {
    const list = byInstrument.get(n.instrument)
    if (list) list.push(n)
    else byInstrument.set(n.instrument, [n])
  }

  let nextId = 0
  const tracks: Track[] = []
  for (const [code, group] of byInstrument) {
    const instrument = instrumentByCode(code)
    if (!instrument) continue // a typo'd i<code>; it still plays in the backing

    const sorted = [...group].sort((a, b) => a.timeSec - b.timeSec)
    const merged = mergeUnisons(
      sorted.map((n) => ({
        id: 0,
        timeSec: n.timeSec,
        durSec: n.durSec,
        midi: n.midi,
        drum: n.drum,
        volume: n.volume,
        voice: n.voice,
      }))
    )
    for (const n of merged) n.id = nextId++
    if (merged.length === 0) continue

    const isDrums = code === 'd'
    const midis = merged.map((n) => n.midi).filter((m): m is number => m !== undefined)
    const drums = [...new Set(merged.map((n) => n.drum).filter((d): d is string => !!d))].sort(
      (a, b) => drumOrder(a) - drumOrder(b)
    )

    tracks.push({
      instrument: code,
      name: instrument.name,
      icon: instrument.icon,
      notes: merged,
      voices: [...new Set(group.map((n) => n.voice))].sort((a, b) => a - b),
      isDrums,
      lowMidi: midis.length ? Math.min(...midis) : 0,
      highMidi: midis.length ? Math.max(...midis) : 0,
      pitches: [...new Set(midis)].sort((a, b) => a - b),
      drums,
      difficulty: rateDifficulty(merged, isDrums),
    })
  }

  // Present in the palette's order so the picker reads consistently.
  const order = new Map(INSTRUMENTS.map((i, idx) => [i.code, idx]))
  tracks.sort((a, b) => (order.get(a.instrument) ?? 99) - (order.get(b.instrument) ?? 99))

  // Drop the parts too small to be worth playing — unless that would leave
  // nothing at all, in which case the busiest one is still better than an
  // empty picker.
  let playable = tracks.filter((t) => t.notes.length >= MIN_PLAYABLE_NOTES)
  if (playable.length === 0 && tracks.length > 0) {
    playable = [tracks.reduce((a, b) => (b.notes.length > a.notes.length ? b : a))]
  }

  return { bpm, durationSec, tracks: playable, allNotes: notes, warnings }
}

/** The notes that keep playing while you perform `instrument` yourself. */
export const backingFor = (chart: Chart, instrument: string): ScheduledNote[] =>
  chart.allNotes.filter((n) => n.instrument !== instrument)

/**
 * The keyboard range to draw for a track: the notes' own range, rounded out to
 * whole octaves and widened to at least two so a one-note track still looks
 * like a keyboard rather than a single key.
 */
export function keyboardRange(track: Track): { lowMidi: number; highMidi: number } {
  let low = Math.floor(track.lowMidi / 12) * 12
  let high = Math.ceil((track.highMidi + 1) / 12) * 12 - 1
  while (high - low < 23) {
    // grow downward first: melodies sit above their range's centre more often
    if (low > 12) low -= 12
    else high += 12
  }
  return { lowMidi: Math.max(0, low), highMidi: Math.min(127, high) }
}
