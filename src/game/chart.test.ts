import { describe, it, expect } from 'vitest'
import {
  buildChart, backingFor, clipToNextPress, keyboardRange, rateDifficulty, ratedNoHarderThan,
  runEndSec, DIFFICULTY_LABELS, OUTRO_SEC,
} from './chart'
import type { GameNote } from './chart'

const note = (timeSec: number, midi: number, durSec = 0.25): GameNote => ({
  id: 0, timeSec, durSec, midi, volume: 1, voice: 0,
})

/** A voice long enough to clear the MIN_PLAYABLE_NOTES bar. */
const long = (body: string, times = 4) => body.repeat(times)

describe('buildChart', () => {
  it('splits a luting into one track per instrument', () => {
    const chart = buildChart(
      `#lute 240 il${long('ceg')}|ibo2${long('ccc')}|id${long('o0ao3c', 6)}`
    )
    expect(chart.tracks.map((t) => t.instrument).sort()).toEqual(['b', 'd', 'l'])
    expect(chart.bpm).toBe(240)
  })

  it('merges every voice that plays the same instrument into one track', () => {
    // Three voices, two of them Lute: the luting can't overlap notes within a
    // voice, so a composer spreads one part across several. The game can.
    const chart = buildChart(
      `#lute 240 il${long('ceg')}|ilo5${long('egb')}|ibo2${long('ccc')}`
    )
    const lute = chart.tracks.find((t) => t.instrument === 'l')!
    expect(lute.voices).toEqual([0, 1])
    expect(lute.notes).toHaveLength(24)
    // the two voices sound together — a chord the notation could not have written
    expect(lute.notes.filter((n) => n.timeSec === 0)).toHaveLength(2)
    expect(chart.tracks.find((t) => t.instrument === 'b')!.voices).toEqual([2])
  })

  it('does not offer an instrument with only a handful of notes', () => {
    // A two-note triangle part is a minute of watching someone else's song.
    const chart = buildChart(`#lute 240 il${long('ceg', 6)}|ifo5cc`)
    expect(chart.tracks.map((t) => t.instrument)).toEqual(['l'])
  })

  it('still plays those tiny parts in the backing', () => {
    // Excluded from the instrument list, not from the music.
    const chart = buildChart(`#lute 240 il${long('ceg', 6)}|ifo5cc`)
    expect(chart.allNotes.some((n) => n.instrument === 'f')).toBe(true)
    expect(backingFor(chart, 'l').some((n) => n.instrument === 'f')).toBe(true)
  })

  it('falls back to the busiest part rather than an empty picker', () => {
    const chart = buildChart('#lute 240 ilceg|ifo5c')
    expect(chart.tracks.map((t) => t.instrument)).toEqual(['l'])
  })

  it('records the distinct pitches a part plays, for the compact keyboard', () => {
    const chart = buildChart(`#lute 240 il${long('ceg')}`)
    const lute = chart.tracks[0]
    // c, e, g at o4 — repeated, but each pitch appears once and ascending
    expect(lute.pitches).toEqual([60, 64, 67])
  })

  it('collapses two voices doubling the same pitch into a single note', () => {
    const chart = buildChart('#lute 240 ilc4|ilc8')
    const lute = chart.tracks.find((t) => t.instrument === 'l')!
    expect(lute.notes).toHaveLength(1)
    // the longer of the two durations survives, so the bar is drawn full length
    expect(lute.notes[0].durSec).toBeCloseTo(8 * (60 / 240), 5)
  })

  it('keeps a drum track as drum hits, not pitches', () => {
    const chart = buildChart(`#lute 240 id${long('o0ao3co4c')}`)
    const kit = chart.tracks.find((t) => t.instrument === 'd')!
    expect(kit.isDrums).toBe(true)
    expect(kit.notes.every((n) => n.drum && n.midi === undefined)).toBe(true)
    // ordered as they sit on a kit: kick, snare, hi-hat
    expect(kit.drums).toEqual(['o0a', 'o3c', 'o4c'])
  })

  it('gives every note in a chart a distinct id', () => {
    const chart = buildChart(`#lute 240 il${long('cdefgab')}|ibo2${long('cdefgab')}`)
    const ids = chart.tracks.flatMap((t) => t.notes.map((n) => n.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('leaves everything but the chosen instrument in the backing', () => {
    const chart = buildChart(`#lute 240 il${long('ceg')}|ibo2${long('ccc')}`)
    const backing = backingFor(chart, 'l')
    expect(backing.length).toBeGreaterThan(0)
    expect(backing.every((n) => n.instrument === 'b')).toBe(true)
  })

  it('plays a luting whose title comment is unpaired', () => {
    // The parser's paired-`//` rule inverts on an odd number of markers and
    // discards the music instead of the comment. Real files open with one or
    // two unpaired header lines, so both counts have to work.
    for (const text of [
      '//Just a title\n#lute 240 ilceg',
      '//Title\n//Author: someone\n#lute 240 ilceg',
      '//A//\n//B//\n//C\n#lute 240 ilceg',
    ]) {
      const chart = buildChart(text)
      expect(chart.bpm).toBe(240)
      expect(chart.allNotes.length).toBe(3)
    }
  })

  it('still honours a paired inline comment', () => {
    const chart = buildChart('#lute 240 ilc//skip me//eg')
    expect(chart.allNotes.length).toBe(3)
  })

  it('survives a luting with no playable notes', () => {
    const chart = buildChart('#lute 240')
    expect(chart.tracks).toEqual([])
  })
})

describe('clipToNextPress', () => {
  it('ends a sustain where the next note on its key begins', () => {
    const notes = [note(0, 60, 4), note(1.5, 60, 1)]
    const out = clipToNextPress(notes)
    expect(out.map((n) => n.durSec)).toEqual([1.5, 1])
    // and the notes it was given are untouched: they belong to the chart
    expect(notes[0].durSec).toBe(4)
  })

  it('never loses a note, or what it sounds', () => {
    const notes = [note(0, 60, 4), note(1, 62, 4), note(2, 60, 1)]
    const out = clipToNextPress(notes)
    expect(out.map((n) => [n.timeSec, n.midi])).toEqual(notes.map((n) => [n.timeSec, n.midi]))
  })

  it('leaves an overlap across two keys alone', () => {
    const notes = [note(0, 60, 4), note(1.5, 67, 1)]
    expect(clipToNextPress(notes)).toBe(notes)
  })

  it('hands the part straight back when nothing overlaps', () => {
    // The picker re-derives every track whenever the keyboard changes, so the
    // common case has to cost nothing.
    const notes = Array.from({ length: 20 }, (_, i) => note(i, 60, 0.5))
    expect(clipToNextPress(notes)).toBe(notes)
  })

  it('resolves a chain of overlaps in one pass', () => {
    // Three sustains on one key, each starting inside the one before.
    const out = clipToNextPress([note(0, 60, 3), note(1, 60, 3), note(2, 60, 3)])
    expect(out.map((n) => n.durSec)).toEqual([1, 1, 3])
  })

  it('measures a kit by its pieces', () => {
    const hit = (timeSec: number, drum: string, durSec: number): GameNote => ({
      id: 0, timeSec, durSec, drum, volume: 1, voice: 0,
    })
    const out = clipToNextPress([hit(0, 'o0a', 2), hit(0.5, 'o1c', 2), hit(1, 'o0a', 1)])
    expect(out.map((n) => n.durSec)).toEqual([1, 2, 1])
  })
})

describe('ratedNoHarderThan', () => {
  it('pins a rating that came out above the keyboard it simplifies', () => {
    const d = rateDifficulty(Array.from({ length: 60 }, (_, i) => note(i * 0.12, 60 + (i % 9))), false)
    const held = ratedNoHarderThan(d, d.rating - 2)
    expect(held.rating).toBe(d.rating - 2)
    expect(held.label).toBe(DIFFICULTY_LABELS[d.rating - 3])
    // and nothing else about the measurement is rewritten
    expect(held.peakNps).toBe(d.peakNps)
    expect(held.keys).toBe(d.keys)
  })

  it('leaves a rating that was already under the ceiling exactly as it was', () => {
    const d = rateDifficulty([note(0, 60), note(1, 62)], false)
    expect(ratedNoHarderThan(d, 10)).toBe(d)
  })
})

describe('rateDifficulty', () => {
  it('counts the keys a part never plays, on the keyboard that draws them', () => {
    // The same forty notes: eight pitches five semitones apart. On the keyboard
    // that draws only those eight, they sit side by side; on the one that draws
    // every semitone, there are four dead keys between each pair.
    const notes = Array.from({ length: 40 }, (_, i) => note(i * 0.25, 48 + (i % 8) * 5))
    expect(rateDifficulty(notes, false, undefined, true).rating).toBeGreaterThan(
      rateDifficulty(notes, false).rating
    )
  })

  it('counts none when the part uses every key in its range', () => {
    const notes = Array.from({ length: 40 }, (_, i) => note(i * 0.25, 48 + (i % 12)))
    expect(rateDifficulty(notes, false, undefined, true).rating).toBe(
      rateDifficulty(notes, false).rating
    )
  })

  it('rates a slow single line easier than a fast one', () => {
    const slow = Array.from({ length: 20 }, (_, i) => note(i * 1.0, 60))
    const fast = Array.from({ length: 200 }, (_, i) => note(i * 0.1, 60))
    expect(rateDifficulty(slow, false).rating).toBeLessThan(rateDifficulty(fast, false).rating)
  })

  it('rates chords harder than the same rhythm played single-handed', () => {
    const single = Array.from({ length: 60 }, (_, i) => note(i * 0.25, 60))
    const chords = Array.from({ length: 60 }, (_, i) => [
      note(i * 0.25, 60), note(i * 0.25, 64), note(i * 0.25, 67),
    ]).flat()
    expect(rateDifficulty(chords, false).rating).toBeGreaterThan(
      rateDifficulty(single, false).rating
    )
    expect(rateDifficulty(chords, false).maxChord).toBe(3)
  })

  it('does not let a wide but sparse part inherit a hard rating', () => {
    // Two notes a bar, three octaves apart: lots of reach, no real difficulty.
    const sparse = Array.from({ length: 20 }, (_, i) => note(i * 2, i % 2 ? 36 : 72))
    expect(rateDifficulty(sparse, false).rating).toBeLessThanOrEqual(4)
  })

  it('measures the peak burst, not just the average', () => {
    // one dense second inside an otherwise empty minute
    const notes = [
      ...Array.from({ length: 16 }, (_, i) => note(10 + i * 0.06, 60 + i)),
      note(60, 60),
    ]
    const d = rateDifficulty(notes, false)
    expect(d.peakNps).toBeGreaterThanOrEqual(16)
    expect(d.nps).toBeLessThan(1)
  })

  it('never reports an average above the peak, even on a chordy part', () => {
    // Three notes per onset: counting notes for the average and onsets for the
    // peak would read "5.8/s avg, 3/s peak", which is nonsense on the card.
    const chords = Array.from({ length: 60 }, (_, i) => [
      note(i * 0.5, 48), note(i * 0.5, 52), note(i * 0.5, 55),
    ]).flat()
    const d = rateDifficulty(chords, false)
    expect(d.nps).toBeLessThanOrEqual(d.peakNps)
  })

  it('counts the keys, not just the span they cover', () => {
    // Same rhythm, same two-octave range. One part visits four notes, the other
    // every semitone — the second is far harder to play, and span alone said
    // they were identical.
    const four = [36, 43, 48, 55]
    const sparse = Array.from({ length: 80 }, (_, i) => note(i * 0.25, four[i % 4]))
    const chromatic = Array.from({ length: 80 }, (_, i) => note(i * 0.25, 36 + (i % 24)))
    expect(rateDifficulty(sparse, false).keys).toBe(4)
    expect(rateDifficulty(chromatic, false).keys).toBe(24)
    expect(rateDifficulty(chromatic, false).rating).toBeGreaterThan(
      rateDifficulty(sparse, false).rating
    )
  })

  it('treats a fourteen-key part as demanding', () => {
    const notes = Array.from({ length: 120 }, (_, i) => note(i * 0.3, 60 + (i % 14)))
    const d = rateDifficulty(notes, false)
    expect(d.keys).toBe(14)
    expect(d.rating).toBeGreaterThanOrEqual(5)
  })

  it('counts kit pieces as the keys of a drum part', () => {
    const kit = ['o0a', 'o3c', 'o4c']
    const notes = Array.from({ length: 60 }, (_, i) => ({
      ...note(i * 0.25, 0), drum: kit[i % 3], midi: undefined,
    }))
    expect(rateDifficulty(notes, true).keys).toBe(3)
  })

  it('handles an empty track', () => {
    const d = rateDifficulty([], false)
    expect(d.rating).toBe(1)
    expect(d.keys).toBe(0)
  })
})

describe('keyboardRange', () => {
  const track = (lowMidi: number, highMidi: number) =>
    ({ lowMidi, highMidi }) as Parameters<typeof keyboardRange>[0]

  it('rounds out to whole octaves', () => {
    const r = keyboardRange(track(62, 71))
    expect(r.lowMidi % 12).toBe(0)
    expect((r.highMidi + 1) % 12).toBe(0)
  })

  it('shows at least two octaves for a one-note part', () => {
    const r = keyboardRange(track(60, 60))
    expect(r.highMidi - r.lowMidi).toBeGreaterThanOrEqual(23)
  })

  it('covers the whole range of a wide part', () => {
    const r = keyboardRange(track(30, 100))
    expect(r.lowMidi).toBeLessThanOrEqual(30)
    expect(r.highMidi).toBeGreaterThanOrEqual(100)
  })
})

describe('runEndSec', () => {
  it('holds the run open for five seconds after the last note', () => {
    // Otherwise the results cut in over the final chord's decay.
    const chart = buildChart(`#lute 240 il${long('ceg')}`)
    const lastNote = Math.max(...chart.allNotes.map((n) => n.timeSec + n.durSec))
    expect(runEndSec(chart)).toBeCloseTo(lastNote + OUTRO_SEC, 5)
  })

  it("counts the band's notes too, not just the part being played", () => {
    // Your own part can finish long before the song does; it's the *song* that
    // needs to be left to ring.
    const chart = buildChart(`#lute 240 il${long('ceg')}|ibo2${long('ccc')}`)
    const lastNote = Math.max(...chart.allNotes.map((n) => n.timeSec + n.durSec))
    expect(runEndSec(chart)).toBeCloseTo(lastNote + OUTRO_SEC, 5)
  })

  it('adds nothing to a chart whose length already ends in silence', () => {
    // The upstream parser never reports one, but the rule is a floor on the
    // silence at the end rather than five seconds on top of it.
    const chart = buildChart(`#lute 240 il${long('ceg')}`)
    const padded = { ...chart, durationSec: chart.durationSec + 60 }
    expect(runEndSec(padded)).toBe(padded.durationSec)
  })
})
