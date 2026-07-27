import { describe, it, expect } from 'vitest'
import { Judge, comboMultiplier, grade, VERDICT_POINTS } from './judge'
import type { GameNote, Track } from './chart'

const HARSH = { id: 't', label: 'test', hint: '', perfect: 20, great: 50, good: 100 }

/** A melodic track whose lanes are simply the MIDI notes. */
function track(notes: [time: number, midi: number][]): Track {
  return {
    instrument: 'l',
    name: 'Lute',
    icon: '🪕',
    notes: notes.map(([timeSec, midi], id): GameNote => ({
      id, timeSec, durSec: 0.2, midi, volume: 1, voice: 0,
    })),
    voices: [0],
    isDrums: false,
    lowMidi: 0,
    highMidi: 127,
    pitches: [...new Set(notes.map(([, m]) => m))].sort((a, b) => a - b),
    drums: [],
    difficulty: { rating: 1, label: '', nps: 0, peakNps: 0, maxChord: 0, span: 0, keys: 0 },
  }
}

const judgeFor = (notes: [number, number][], offsetMs = 0) =>
  new Judge(track(notes), (n) => n.midi ?? -1, HARSH, offsetMs)

describe('Judge.press', () => {
  it('grades by how close the press was', () => {
    const j = judgeFor([[1, 60], [2, 60], [3, 60]])
    expect(j.press(60, 1.005)?.verdict).toBe('perfect')
    expect(j.press(60, 2.04)?.verdict).toBe('great')
    expect(j.press(60, 3.09)?.verdict).toBe('good')
  })

  it('reports a signed delta: negative early, positive late', () => {
    const j = judgeFor([[1, 60], [2, 60]])
    expect(j.press(60, 0.97)?.deltaMs).toBe(-30)
    expect(j.press(60, 2.03)?.deltaMs).toBe(30)
  })

  it('returns null and breaks the combo on a note that is not there', () => {
    const j = judgeFor([[1, 60]])
    j.press(60, 1)
    expect(j.getStats().combo).toBe(1)
    expect(j.press(65, 1)).toBeNull()
    expect(j.getStats().wrong).toBe(1)
    expect(j.getStats().combo).toBe(0)
  })

  it('ignores a press far outside the window', () => {
    const j = judgeFor([[1, 60]])
    expect(j.press(60, 1.5)).toBeNull()
    expect(j.getStats().perfect + j.getStats().great + j.getStats().good).toBe(0)
  })

  it('claims the nearest note, not merely the earliest in range', () => {
    // Two notes 60 ms apart, both inside the ±100 ms window of this press.
    const j = judgeFor([[1.0, 60], [1.06, 60]])
    const first = j.press(60, 1.055)
    expect(first?.noteId).toBe(1) // the 1.06 note, 5 ms away — not the 1.0 one
    const second = j.press(60, 1.001)
    expect(second?.noteId).toBe(0)
  })

  it('never judges the same note twice', () => {
    const j = judgeFor([[1, 60]])
    expect(j.press(60, 1.0)).not.toBeNull()
    expect(j.press(60, 1.01)).toBeNull()
    expect(j.getStats().perfect).toBe(1)
  })

  it('judges each note of a chord separately', () => {
    const j = judgeFor([[1, 60], [1, 64], [1, 67]])
    for (const m of [60, 64, 67]) expect(j.press(m, 1.002)?.verdict).toBe('perfect')
    expect(j.getStats().perfect).toBe(3)
    expect(j.getStats().combo).toBe(3)
  })

  it('shifts every window by the calibration offset', () => {
    // +40 ms offset: a press 40 ms "late" by the clock is dead on the note.
    const j = judgeFor([[1, 60]], 40)
    expect(j.press(60, 1.04)?.verdict).toBe('perfect')
  })
})

describe('Judge.expire', () => {
  it('misses a note once its window has closed, and breaks the combo', () => {
    const j = judgeFor([[1, 60], [2, 60]])
    j.press(60, 1)
    expect(j.getStats().combo).toBe(1)
    j.expire(2.5)
    expect(j.getStats().miss).toBe(1)
    expect(j.getStats().combo).toBe(0)
  })

  it('leaves a note alone while it is still hittable', () => {
    const j = judgeFor([[1, 60]])
    j.expire(1.05)
    expect(j.getStats().miss).toBe(0)
    expect(j.press(60, 1.06)?.verdict).toBe('good')
  })

  it('emits one judgement per missed note', () => {
    const j = judgeFor([[1, 60], [1.2, 62], [1.4, 64]])
    j.expire(5)
    const events = j.drainJudgements()
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.verdict === 'miss')).toBe(true)
    expect(j.drainJudgements()).toEqual([]) // drained once and once only
  })

  it('reports completion when every note has a verdict', () => {
    const j = judgeFor([[1, 60], [2, 62]])
    expect(j.isComplete()).toBe(false)
    j.press(60, 1)
    j.expire(5)
    expect(j.isComplete()).toBe(true)
  })
})

describe('scoring', () => {
  it('steps the multiplier every ten notes and caps at four', () => {
    expect(comboMultiplier(0)).toBe(1)
    expect(comboMultiplier(9)).toBe(1)
    expect(comboMultiplier(10)).toBe(2)
    expect(comboMultiplier(30)).toBe(4)
    expect(comboMultiplier(500)).toBe(4)
  })

  it('scores the first note at the base value', () => {
    const j = judgeFor([[1, 60]])
    j.press(60, 1)
    expect(j.getStats().score).toBe(VERDICT_POINTS.perfect)
  })

  it('tracks the best combo even after it is broken', () => {
    const j = judgeFor([[1, 60], [2, 62], [3, 64]])
    j.press(60, 1)
    j.press(62, 2)
    j.expire(3.5) // the third note is missed
    expect(j.getStats().maxCombo).toBe(2)
    expect(j.getStats().combo).toBe(0)
  })

  it('averages absolute error, and signs the bias', () => {
    const j = judgeFor([[1, 60], [2, 62]])
    j.press(60, 1.03) // 30 ms late
    j.press(62, 1.99) // 10 ms early
    expect(j.getStats().meanErrorMs).toBe(20)
    expect(j.getStats().biasMs).toBe(10)
  })

  it('maxScore matches a flawless run', () => {
    const notes: [number, number][] = Array.from({ length: 40 }, (_, i) => [i, 60 + (i % 5)])
    const j = judgeFor(notes)
    for (const [t, m] of notes) j.press(m, t)
    expect(j.getStats().score).toBe(j.maxScore())
  })
})

describe('grade', () => {
  const stats = (p: number, g: number, o: number, m: number, wrong = 0) => ({
    perfect: p, great: g, good: o, miss: m, wrong,
    score: 0, combo: 0, maxCombo: 0, meanErrorMs: 0, biasMs: 0,
  })

  it('awards S only for a clean sweep', () => {
    expect(grade(stats(100, 0, 0, 0), 100)).toBe('S')
    expect(grade(stats(99, 1, 0, 0), 100)).toBe('S')
    // one missed note is enough to lose it, however good the rest was
    expect(grade(stats(99, 0, 0, 1), 100)).toBe('A')
    // so is a stray wrong note
    expect(grade(stats(100, 0, 0, 0, 1), 100)).toBe('A')
  })

  it('weights scrappy hits below clean ones', () => {
    expect(grade(stats(0, 0, 100, 0), 100)).toBe('D')
    expect(grade(stats(100, 0, 0, 0), 100)).toBe('S')
  })

  it('fails an empty run', () => {
    expect(grade(stats(0, 0, 0, 0), 0)).toBe('F')
    expect(grade(stats(0, 0, 0, 100), 100)).toBe('F')
  })
})
