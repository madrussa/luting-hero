import { describe, it, expect } from 'vitest'
import { buildChart, backingFor, keyboardRange, rateDifficulty } from './chart'
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

describe('rateDifficulty', () => {
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
