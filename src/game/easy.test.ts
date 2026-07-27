// The fold: what easy mode does to a part, and what it refuses to do to it.

import { describe, it, expect } from 'vitest'
import { MAX_EASY_KEYS, buildEasyMap, playableTrack } from './easy'
import { buildChart, rateDifficulty, soundsOf } from './chart'
import type { GameNote, Track } from './chart'

function melodic(notes: GameNote[]): Track {
  const midis = notes.map((n) => n.midi!).filter((m) => m !== undefined)
  return {
    instrument: 'k',
    name: 'Keyboard',
    icon: '🎹',
    notes,
    voices: [0],
    isDrums: false,
    lowMidi: Math.min(...midis),
    highMidi: Math.max(...midis),
    pitches: [...new Set(midis)].sort((a, b) => a - b),
    drums: [],
    difficulty: rateDifficulty(notes, false),
  }
}

const note = (timeSec: number, midi: number, durSec = 0.2): GameNote => ({
  id: Math.round(timeSec * 1000) * 128 + midi,
  timeSec,
  durSec,
  midi,
  volume: 1,
  voice: 0,
})

/** A part playing every semitone of two octaves, one note at a time. */
const chromatic = () =>
  melodic(Array.from({ length: 25 }, (_, i) => note(i * 0.5, 48 + i)))

describe('buildEasyMap', () => {
  it('folds a part down to at most eight keys', () => {
    const easy = buildEasyMap(chromatic())
    expect(easy.keys).toHaveLength(MAX_EASY_KEYS)
    expect(easy.keys.every((k) => k.folded)).toBe(true)
  })

  it('leaves a part that already fits alone, one key per pitch', () => {
    const easy = buildEasyMap(melodic([note(0, 60), note(1, 64), note(2, 67)]))
    expect(easy.keys.map((k) => k.midis)).toEqual([[60], [64], [67]])
    expect(easy.keys.some((k) => k.folded)).toBe(false)
  })

  it('keeps the pitches in order, so up is still right', () => {
    const easy = buildEasyMap(chromatic())
    const flat = easy.keys.flatMap((k) => k.midis)
    expect(flat).toEqual([...flat].sort((a, b) => a - b))
    // and every key is a contiguous run: no key reaches over another
    for (const k of easy.keys) {
      expect(k.midis[k.midis.length - 1] - k.midis[0]).toBe(k.midis.length - 1)
    }
  })

  it('covers every pitch exactly once', () => {
    const track = chromatic()
    const easy = buildEasyMap(track)
    expect(easy.keys.flatMap((k) => k.midis)).toEqual(track.pitches)
  })

  it('gives the pitches that carry the part their own keys', () => {
    // A bass line that lives on two notes and visits ten others in passing.
    // Folding by range alone would put the two hot pitches on one key and spend
    // the rest on notes struck twice; weighting by how often each is played is
    // what stops that.
    const notes: GameNote[] = []
    let t = 0
    for (let i = 0; i < 60; i++) {
      notes.push(note(t++, 36), note(t++, 38))
      if (i % 6 === 0) notes.push(note(t++, 40 + (i % 10)))
    }
    const easy = buildEasyMap(melodic(notes))
    expect(easy.keys.find((k) => k.midis.includes(36))!.midis).toEqual([36])
    expect(easy.keys.find((k) => k.midis.includes(38))!.midis).toEqual([38])
  })

  it('sounds a folded key as its busiest pitch when nothing is claimed', () => {
    const notes = [note(0, 60), note(1, 61), note(2, 61), note(3, 61)]
    const easy = buildEasyMap(melodic([...notes, ...Array.from({ length: 20 }, (_, i) => note(10 + i, 72 + i))]))
    const key = easy.keys.find((k) => k.midis.includes(61))!
    expect(key.voice.midi).toBe(61)
  })

  it('names a folded key by the range it covers', () => {
    const easy = buildEasyMap(chromatic())
    expect(easy.keys[0].label).toMatch(/^[A-G]♯?\d–[A-G]♯?\d$/)
    expect(buildEasyMap(melodic([note(0, 60)])).keys[0].label).toBe('C4')
  })

  it('sends a pitch off the end of the part to the nearest key', () => {
    const easy = buildEasyMap(chromatic())
    expect(easy.laneOfMidi(0)).toBe(0)
    expect(easy.laneOfMidi(127)).toBe(easy.keys.length - 1)
  })

  it('folds a kit by piece, not by pitch', () => {
    const chart = buildChart(
      `#lute 240 id${'o0ao0bo1co1do2co3co3do4co4ao5d'.repeat(4)}`
    )
    const kit = chart.tracks.find((t) => t.instrument === 'd')!
    expect(kit.drums.length).toBeGreaterThan(MAX_EASY_KEYS)
    const easy = buildEasyMap(kit)
    expect(easy.keys).toHaveLength(MAX_EASY_KEYS)
    // kit order survives the fold, so the kick is still the leftmost pad
    expect(easy.keys[0].drums[0]).toBe('o0a')
    expect(easy.keys.flatMap((k) => k.drums)).toEqual(kit.drums)
  })
})

describe('playableTrack', () => {
  it('leaves the part alone on the unfolded keyboards', () => {
    const track = chromatic()
    for (const mode of ['hard', 'impossible'] as const) {
      const play = playableTrack(track, mode)
      expect(play.easy).toBeNull()
      expect(play.track).toBe(track)
    }
  })

  it('turns a chord that fits under one key into a single note', () => {
    // A triad inside one folded key: three simultaneous notes the player could
    // only press once.
    const track = chromatic()
    const easy = buildEasyMap(track)
    const under = easy.keys.find((k) => k.midis.length >= 3)!.midis.slice(0, 3)
    const chordal = melodic([
      ...track.notes,
      ...under.map((midi) => note(100, midi, 1)),
    ])
    const play = playableTrack(chordal, 'easy')
    const struck = play.track.notes.filter((n) => n.timeSec === 100)
    expect(struck).toHaveLength(1)
    // and it still sounds all three: what you press changes, not the music
    expect(soundsOf(struck[0]).map((s) => s.midi).sort((a, b) => a! - b!)).toEqual(under)
  })

  it('leaves a chord spread over two keys as two notes', () => {
    const track = chromatic()
    const easy = buildEasyMap(track)
    const wide = [easy.keys[0].midis[0], easy.keys[3].midis[0]]
    const play = playableTrack(
      melodic([...track.notes, ...wide.map((midi) => note(100, midi, 1))]),
      'easy'
    )
    expect(play.track.notes.filter((n) => n.timeSec === 100)).toHaveLength(2)
  })

  it('never drops a note that stands alone', () => {
    const track = chromatic()
    const play = playableTrack(track, 'easy')
    expect(play.track.notes).toHaveLength(track.notes.length)
    expect(play.track.notes.every((n) => n.also === undefined)).toBe(true)
  })

  it('keeps a part that already fits exactly as it was', () => {
    // Its keyboard is the one hard mode would draw, so it is the same part —
    // and re-measuring it in keys could nudge it a step *up* on the easy
    // setting, which is worse than saying nothing.
    const track = melodic([note(0, 60), note(1, 64), note(2, 67)])
    const play = playableTrack(track, 'easy')
    expect(play.easy).not.toBeNull()
    expect(play.track).toBe(track)
  })

  it('re-rates the part against the keyboard it will be played on', () => {
    // The rating exists to say how hard the thing in front of you is. Folding
    // twenty-five keys onto eight makes it easier, and the picker has to say so.
    const track = chromatic()
    const play = playableTrack(track, 'easy')
    expect(play.track.difficulty.keys).toBe(MAX_EASY_KEYS)
    expect(play.track.difficulty.rating).toBeLessThan(track.difficulty.rating)
    // the reported pitch span is still the part's own: the music didn't move
    expect(play.track.difficulty.span).toBe(track.difficulty.span)
  })

  it('rates a chord by the keys it needs, not the notes it has', () => {
    const track = chromatic()
    const easy = buildEasyMap(track)
    const under = easy.keys.find((k) => k.midis.length >= 3)!.midis.slice(0, 3)
    const chordal = melodic([...track.notes, ...under.map((midi) => note(100, midi, 1))])
    expect(chordal.difficulty.maxChord).toBe(3)
    expect(playableTrack(chordal, 'easy').track.difficulty.maxChord).toBe(1)
  })
})
