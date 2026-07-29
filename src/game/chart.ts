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

/** What a note sounds: a pitch, or a piece of the kit. */
export interface NoteSound {
  midi?: number
  drum?: string
}

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
  /**
   * Other notes this one swallowed when a chord folded onto a single key, so
   * easy mode still *sounds* the chord it made you press once. Absent unless
   * the keyboard was folded — see `easy.ts`.
   */
  also?: NoteSound[]
}

/** Everything a note sounds, its own pitch first. */
export const soundsOf = (note: GameNote): NoteSound[] => [
  { midi: note.midi, drum: note.drum },
  ...(note.also ?? []),
]

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

/** The lane a note occupies when the keyboard hasn't been folded: its own key. */
const ownKey = (n: GameNote): number | string => n.drum ?? n.midi ?? -1

/**
 * Merge notes that land in the same lane at the same moment. Two voices doubling
 * a melody would otherwise put two bars in one lane, and the player can only
 * press the key once — so they collapse into a single note holding the longest
 * duration and the loudest volume.
 *
 * `laneOf` is what makes this reusable: with one key per pitch it merges
 * unisons, and with a folded keyboard it merges the notes of a chord that landed
 * under one key. Those keep sounding — the survivor remembers them in `also` —
 * so folding changes what you press, not what you hear.
 *
 * `windowSec` is how much of a moment counts as one. It defaults to what the
 * notation can genuinely stack at one instant; the folded keyboards open it to a
 * re-strike, because a key you cannot hit twice that fast is a key you hit once.
 */
export function mergeSimultaneous(
  notes: GameNote[],
  laneOf: (n: GameNote) => number | string = ownKey,
  windowSec: number = SIMULTANEITY_SEC
): GameNote[] {
  const out: GameNote[] = []
  // notes arrive sorted by time, so the scan back only has to cover the window
  // — and it is measured from the survivor's own onset, which is what stops a
  // long run chaining into one enormous press.
  for (const n of notes) {
    const lane = laneOf(n)
    let merged = false
    for (let i = out.length - 1; i >= 0; i--) {
      const p = out[i]
      if (n.timeSec - p.timeSec > windowSec) break
      if (laneOf(p) !== lane) continue
      // The survivor lasts until the last of them stops sounding — reckoned as
      // an end, not as the longer duration, because the note being swallowed
      // started later. At a re-strike's width apart that difference is most of a
      // sixteenth, and taking the duration alone would cut the sustain short.
      p.durSec = Math.max(p.durSec, n.timeSec + n.durSec - p.timeSec)
      p.volume = Math.max(p.volume, n.volume)
      if (n.midi !== p.midi || n.drum !== p.drum) {
        const also = (p.also ??= [])
        if (!also.some((s) => s.midi === n.midi && s.drum === n.drum)) {
          also.push({ midi: n.midi, drum: n.drum })
        }
      }
      merged = true
      break
    }
    if (!merged) out.push({ ...n })
  }
  return out
}

/**
 * End every note where the next note on its key begins.
 *
 * A key can only sustain one note at a time, so two notes overlapping on one key
 * is not a thing a player can be asked for: striking the second means letting go
 * of the first, which under the sustain scoring costs the hold however well it was
 * played — and on the highway the two sustains are one tube in one lane, drawn
 * through each other.
 *
 * It arises two ways. A luting spreads one instrument over several voices, which
 * is the only way its syntax can overlap notes, and two of those voices can hold
 * the same pitch in turn; and a fold puts many pitches on one key, where the pitch
 * a part sustains is rarely the pitch it plays next.
 *
 * Nothing is dropped and no pitch moves. Every note is still there to be struck
 * and still sounds what it always sounded — it is simply only as long as it can
 * actually be held, which is what the judge has always assumed, since a press
 * settles the sustain already running in its lane. The overlap only ever existed
 * in the drawing, and in the sustain the player was being marked against.
 *
 * The notes come back copied if any needed shortening and untouched if none did,
 * so a part with no overlap in it costs nothing to run through here.
 */
export function clipToNextPress(
  notes: GameNote[],
  laneOf: (n: GameNote) => number | string = ownKey
): GameNote[] {
  /** index of the note each key is currently holding */
  const holding = new Map<number | string, number>()
  /** what to shorten, decided before anything is copied */
  const clips: [index: number, durSec: number][] = []
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    const lane = laneOf(n)
    const held = holding.get(lane)
    if (held !== undefined) {
      const prev = notes[held]
      // Only ever the note immediately before this one on this key: anything
      // earlier was already given up to that one, so no note is clipped twice
      // and a chain of overlaps resolves in this one pass.
      if (prev.timeSec + prev.durSec > n.timeSec) clips.push([held, n.timeSec - prev.timeSec])
    }
    holding.set(lane, i)
  }
  if (clips.length === 0) return notes

  const out = notes.map((n) => ({ ...n }))
  for (const [i, durSec] of clips) out[i].durSec = durSec
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
 *
 * `laneOf` says which *key* each note falls on, for a keyboard where that isn't
 * simply its pitch — easy mode's folded one, where several pitches share a key.
 * Pass it and the rating is measured in keys rather than semitones, which is
 * how a kit has always been rated: the fold is only worth doing if the number
 * it produces reflects it.
 *
 * `wholeKeyboard` is for Impossible, the one mode that draws keys the part never
 * plays. Every other keyboard draws only what the part needs, so on them a jump is
 * to the next key along; there it is a jump across however many dead keys happen
 * to lie between, each of them a key that scores nothing and breaks the combo.
 * Without this the two rated identically, which is the one thing a difficulty
 * number on four modes must not do.
 */
export function rateDifficulty(
  notes: GameNote[],
  isDrums: boolean,
  laneOf?: (n: GameNote) => number,
  wholeKeyboard = false
): Difficulty {
  if (notes.length === 0) {
    return { rating: 1, label: 'Empty', nps: 0, peakNps: 0, maxChord: 0, span: 0, keys: 0 }
  }

  const start = notes[0].timeSec
  const end = notes.reduce((m, n) => Math.max(m, n.timeSec + n.durSec), 0)
  const span = Math.max(1, end - start)

  // A key is what the hand actually has to reach for: the pitch, the kit piece,
  // or the folded lane several pitches share.
  const keyOf = (n: GameNote): number | string => laneOf?.(n) ?? n.drum ?? n.midi ?? 0
  // On a positional keyboard every key is one of a handful sitting under the
  // hand, so distance means nothing there and only *changing* key costs
  // anything. That has always been true of a kit; a folded keyboard is the
  // same instrument in that respect.
  const positional = isDrums || laneOf !== undefined

  // Group into onsets so chords count once for density and once for width.
  const onsets: { t: number; keys: Set<number | string>; low: number }[] = []
  for (const n of notes) {
    const last = onsets[onsets.length - 1]
    if (last && n.timeSec - last.t <= SIMULTANEITY_SEC) {
      last.keys.add(keyOf(n))
      last.low = Math.min(last.low, n.midi ?? 0)
    } else onsets.push({ t: n.timeSec, keys: new Set([keyOf(n)]), low: n.midi ?? 0 })
  }

  // Busiest one-second window, by sliding over onsets rather than sampling on a
  // grid — a burst that straddles two grid cells still registers at full height.
  let peakNps = 0
  for (let i = 0, j = 0; i < onsets.length; i++) {
    while (onsets[j].t < onsets[i].t - 1) j++
    peakNps = Math.max(peakNps, i - j + 1)
  }

  const nps = onsets.length / span
  const maxChord = onsets.reduce((m, o) => Math.max(m, o.keys.size), 0)

  const midis = notes.map((n) => n.midi).filter((m): m is number => m !== undefined)
  const pitchSpan = midis.length ? Math.max(...midis) - Math.min(...midis) : 0

  // Hand travel per second: how far it has to move, in whatever unit the
  // keyboard is measured in.
  let travel = 0
  if (isDrums) {
    // On a kit the distance between pads means nothing, so all that costs
    // anything is moving to a different one at all.
    let switches = 0
    for (let i = 1; i < notes.length; i++) if (keyOf(notes[i]) !== keyOf(notes[i - 1])) switches++
    travel = Math.min(1, switches / span / 4)
  } else if (laneOf) {
    // A folded keyboard is measured in keys, and it is only a handful wide — so
    // the most a hand can be asked to do is cross the whole of it twice a
    // second, which is the same ceiling two octaves a second is below.
    const lanes = notes.map(laneOf)
    const laneSpan = Math.max(1, Math.max(...lanes) - Math.min(...lanes))
    let jumped = 0
    for (let i = 1; i < notes.length; i++) jumped += Math.abs(lanes[i] - lanes[i - 1])
    travel = Math.min(1, jumped / span / (2 * laneSpan))
  } else {
    let jumped = 0
    for (let i = 1; i < onsets.length; i++) {
      jumped += Math.abs(onsets[i].low - onsets[i - 1].low)
    }
    travel = Math.min(1, jumped / span / 24) // 2 octaves of movement a second = max
  }

  // How many distinct keys there are to cover. This is *not* the pitch span: a
  // part can range over two octaves and still only use four notes, and a part
  // can sit inside one octave and use every semitone in it. The second is much
  // harder to play, and until this was counted separately the rating couldn't
  // tell them apart. Fourteen-odd keys is about where a part stops fitting
  // under the hands.
  const keyCount = new Set(notes.map(keyOf)).size
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
  // Nothing to reach for when the keys are a handful under one hand.
  const reach = positional ? 0 : Math.min(1, pitchSpan / 36)

  // What share of the drawn keyboard is there only to be missed. Every keyboard
  // but Impossible draws the part's own keys and nothing else, so this is zero on
  // them by construction. On Impossible a chromatic run still scores zero — it
  // really does use every key in its range — while a part that visits eight
  // pitches across three octaves is threading past thirty keys that pay nothing
  // and end a combo, which is the whole of what makes that mode its name.
  const deadKeys = wholeKeyboard && pitchSpan > 0 ? 1 - Math.max(0, keyCount - 1) / pitchSpan : 0

  // Span carries less weight now that the key count is measured directly — it
  // was standing in for "how much keyboard is involved", and doing it badly.
  // The dead keys are added on top of the other weights rather than sharing them
  // out, because they are not a way of being hard that trades off against the
  // rest: they are the same part with more room to go wrong in.
  const score =
    0.3 * density + 0.3 * spread + 0.14 * chords + 0.1 * travel + 0.06 * reach + 0.1 * irregularity +
    0.16 * deadKeys
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

/**
 * Hold a rating at or below what the same part scores on a keyboard that asks for
 * more than this one does.
 *
 * The folded keyboards are measured in keys and the unfolded ones in semitones, so
 * the two numbers come off scales that aren't quite the same — and nothing in the
 * arithmetic itself stops the simpler keyboard landing on the higher number. It
 * doesn't happen on any part I can find, which is exactly why it is worth pinning:
 * the rating is there to help someone pick a mode, and a mode claiming to be
 * harder than the one it simplifies is worse than showing no number at all.
 */
export const ratedNoHarderThan = (d: Difficulty, ceiling: number): Difficulty =>
  d.rating <= ceiling ? d : { ...d, rating: ceiling, label: DIFFICULTY_LABELS[ceiling - 1] }

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
    const merged = mergeSimultaneous(
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

/**
 * How long a song is given to ring out after its last note before the run ends
 * and the results take over. Long enough for a held chord to fall away, short
 * enough that it doesn't read as the game having hung.
 */
export const OUTRO_SEC = 3

/**
 * The song time the run should end at.
 *
 * A run used to stop a second and a half after its last note, which on a song
 * that finishes on a held chord means cutting the results in over the decay —
 * the one moment a song most wants to be left alone. So it's held open for
 * OUTRO_SEC after the last note anyone plays, yours or the band's.
 *
 * The floor, not an addition: OUTRO_SEC of *silence* at the end, rather than
 * that much again on top of whatever silence is already there. A chart that ends
 * in a minute of nothing shouldn't leave the player watching an empty highway for
 * a minute and three.
 *
 * As it happens the upstream parser reports `durationSec` as exactly the end of
 * the last note — trailing rests don't extend it — so today the max always takes
 * the ring-out and the other branch never runs. It stays because it is the rule
 * that was wanted: if a chart ever does arrive with silence written into its
 * length, padding it further would be wrong.
 */
export function runEndSec(chart: Chart): number {
  const lastNote = chart.allNotes.reduce((end, n) => Math.max(end, n.timeSec + n.durSec), 0)
  return Math.max(chart.durationSec, lastNote + OUTRO_SEC)
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
