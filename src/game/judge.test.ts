import { describe, it, expect } from 'vitest'
import { Judge, accuracy, comboMultiplier, grade, VERDICT_POINTS } from './judge'
import type { GameNote, Track } from './chart'

const HARSH = { id: 't', label: 'test', hint: '', perfect: 20, great: 50, good: 100 }

/** A melodic track whose lanes are simply the MIDI notes. */
function track(notes: [time: number, midi: number][], durSec = 0.2): Track {
  return {
    instrument: 'l',
    name: 'Lute',
    icon: '🪕',
    notes: notes.map(([timeSec, midi], id): GameNote => ({
      id, timeSec, durSec, midi, volume: 1, voice: 0,
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

/** press() can also return 'resumed'; these tests are about the hit case. */
const hit = (r: ReturnType<Judge['press']>) => (r && r !== 'resumed' ? r : null)

describe('Judge.press', () => {
  it('grades by how close the press was', () => {
    const j = judgeFor([[1, 60], [2, 60], [3, 60]])
    expect(hit(j.press(60, 1.005))?.verdict).toBe('perfect')
    expect(hit(j.press(60, 2.04))?.verdict).toBe('great')
    expect(hit(j.press(60, 3.09))?.verdict).toBe('good')
  })

  it('reports a signed delta: negative early, positive late', () => {
    const j = judgeFor([[1, 60], [2, 60]])
    expect(hit(j.press(60, 0.97))?.deltaMs).toBe(-30)
    expect(hit(j.press(60, 2.03))?.deltaMs).toBe(30)
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
    const first = hit(j.press(60, 1.055))
    expect(first?.noteId).toBe(1) // the 1.06 note, 5 ms away — not the 1.0 one
    const second = hit(j.press(60, 1.001))
    expect(second?.noteId).toBe(0)
  })

  it('never judges the same note twice', () => {
    const j = judgeFor([[1, 60]])
    expect(hit(j.press(60, 1.0))).not.toBeNull()
    expect(j.press(60, 1.01)).toBeNull()
    expect(j.getStats().perfect).toBe(1)
  })

  it('judges each note of a chord separately', () => {
    const j = judgeFor([[1, 60], [1, 64], [1, 67]])
    for (const m of [60, 64, 67]) expect(hit(j.press(m, 1.002))?.verdict).toBe('perfect')
    expect(j.getStats().perfect).toBe(3)
    expect(j.getStats().combo).toBe(3)
  })

  it('shifts every window by the calibration offset', () => {
    // +40 ms offset: a press 40 ms "late" by the clock is dead on the note.
    const j = judgeFor([[1, 60]], 40)
    expect(hit(j.press(60, 1.04))?.verdict).toBe('perfect')
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
    expect(hit(j.press(60, 1.06))?.verdict).toBe('good')
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
    holdable: 0, heldFraction: 0, late: 0,
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


describe('sustains', () => {
  // 1-second notes: comfortably over HOLD_MIN_SEC, so they have to be held.
  const heldJudge = (notes: [number, number][] = [[1, 60]]) =>
    new Judge(track(notes, 1), (n) => n.midi ?? -1, HARSH, 0)

  it('pays the onset immediately and the sustain when the note ends', () => {
    const j = heldJudge()
    j.press(60, 1)
    // only the onset so far — the note is still sounding
    expect(j.getStats().score).toBe(VERDICT_POINTS.perfect)
    j.expire(2.1) // note ran 1..2, held throughout
    expect(j.getStats().score).toBe(VERDICT_POINTS.perfect * 2)
    expect(j.getStats().heldFraction).toBeCloseTo(1, 5)
  })

  it('pays less for letting go early', () => {
    const j = heldJudge()
    j.press(60, 1)
    j.release(60, 1.5) // half of a 1s note
    j.expire(2.1)
    expect(j.getStats().heldFraction).toBeCloseTo(0.5, 5)
    expect(j.getStats().score).toBe(VERDICT_POINTS.perfect * 1.5)
  })

  it('pays nothing extra for a note dropped at once', () => {
    const j = heldJudge()
    j.press(60, 1)
    j.release(60, 1)
    j.expire(2.1)
    expect(j.getStats().heldFraction).toBe(0)
    expect(j.getStats().score).toBe(VERDICT_POINTS.perfect)
  })

  it('lets a dropped sustain be picked back up', () => {
    const j = heldJudge()
    j.press(60, 1)
    j.release(60, 1.25)
    expect(j.press(60, 1.5)).toBe('resumed') // not a wrong note
    j.expire(2.1)
    // 0.25 before the drop plus 0.5 after picking it up again
    expect(j.getStats().heldFraction).toBeCloseTo(0.75, 5)
    expect(j.getStats().wrong).toBe(0)
    expect(j.getStats().combo).toBe(1) // and the combo survives
  })

  it('names the note a lane is sustaining, so a re-grab sounds it', () => {
    // On a folded keyboard one key covers several pitches, so which note is
    // sounding is what decides the pitch a press picks back up.
    const j = heldJudge()
    expect(j.noteSustaining(60, 1.5)).toBeNull() // nothing struck yet
    j.press(60, 1)
    expect(j.noteSustaining(60, 1.5)?.midi).toBe(60)
    expect(j.noteSustaining(60, 2.5)).toBeNull() // the note has finished
  })

  it('does not credit holding past the end of the note', () => {
    const j = heldJudge()
    j.press(60, 1)
    j.release(60, 9) // still down long after it finished
    j.expire(9)
    expect(j.getStats().heldFraction).toBeCloseTo(1, 5)
  })

  it('does not credit holding from before the onset', () => {
    // Hitting early shouldn't buy extra sustain: the hold is measured from the
    // note's own onset, so this is a full hold and no more.
    const j = heldJudge()
    j.press(60, 0.985) // 15 ms early — still a Perfect in this window
    j.expire(2.1)
    expect(j.getStats().heldFraction).toBeCloseTo(1, 5)
    expect(j.getStats().score).toBe(VERDICT_POINTS.perfect * 2)
  })

  it('asks nothing of a note too short to hold', () => {
    // The default fixture is 0.2s — under HOLD_MIN_SEC.
    const j = judgeFor([[1, 60]])
    j.press(60, 1)
    j.expire(5)
    expect(j.getStats().holdable).toBe(0)
    expect(j.getStats().score).toBe(VERDICT_POINTS.perfect)
  })

  it('gives a missed note no sustain to hold', () => {
    const j = heldJudge()
    j.expire(5)
    expect(j.getStats().miss).toBe(1)
    expect(j.getStats().holdable).toBe(0)
    expect(j.getStats().score).toBe(0)
  })

  it('a press with nothing sustaining is still a wrong note', () => {
    const j = heldJudge()
    expect(j.press(65, 1)).toBeNull()
    expect(j.getStats().wrong).toBe(1)
  })

  it('maxScore counts every sustain as doubling its note', () => {
    const notes: [number, number][] = Array.from({ length: 12 }, (_, i) => [i, 60])
    const j = new Judge(track(notes, 1), (n) => n.midi ?? -1, HARSH, 0)
    for (let i = 0; i < 12; i++) {
      j.press(60, i)
      j.expire(i + 1.001)
    }
    expect(j.getStats().score).toBe(j.maxScore())
  })
})


describe('claiming a long note late', () => {
  const longJudge = (dur = 1) =>
    new Judge(track([[1, 60]], dur), (n) => n.midi ?? -1, HARSH, 0)

  it('marks the judgement late, so the HUD can say so', () => {
    // Calling it a Good on screen would hide the mistake the player just made
    // and recovered from.
    const j = longJudge()
    expect(hit(j.press(60, 1.4))?.late).toBe(true)
    expect(hit(j.press(60, 1.4))).toBeNull() // already claimed
  })

  it('does not mark an in-window hit late', () => {
    const j = longJudge()
    expect(hit(j.press(60, 1.02))?.late).toBe(false)
  })

  it('counts late saves separately, not as Goods', () => {
    const j = longJudge()
    j.press(60, 1.4)
    expect(j.getStats().late).toBe(1)
    expect(j.getStats().good).toBe(0)
  })

  it('pays half a Good for the save, and half for its sustain', () => {
    const j = longJudge()
    j.press(60, 1.4)
    expect(j.getStats().score).toBe(VERDICT_POINTS.good / 2)
    j.expire(2.1) // held the 0.6 s that was left
    expect(j.getStats().score).toBe(VERDICT_POINTS.good / 2 + Math.round(VERDICT_POINTS.good / 2 * 0.6))
  })

  it('weights a late save below a Good in the accuracy', () => {
    const late = longJudge()
    late.press(60, 1.4)
    const good = longJudge()
    good.press(60, 1.06) // 60 ms out: a Good
    expect(accuracy(late.getStats(), 1)).toBeLessThan(accuracy(good.getStats(), 1))
  })

  it('does not count an in-window hit as late', () => {
    const j = longJudge()
    j.press(60, 1.02)
    expect(j.getStats().late).toBe(0)
  })

  it('counts a press well past the window while the note still sounds', () => {
    // HARSH's Good window is 100 ms; this is 400 ms late, but the note runs a
    // full second so the player is plainly playing it.
    const j = longJudge()
    expect(hit(j.press(60, 1.4))?.verdict).toBe('good')
    expect(j.getStats().wrong).toBe(0)
    expect(j.getStats().combo).toBe(1)
  })

  it('credits only the sustain left after a late grab', () => {
    const j = longJudge()
    j.press(60, 1.4)
    j.expire(2.1)
    expect(j.getStats().heldFraction).toBeCloseTo(0.6, 5)
  })

  it('does not miss a long note while it can still be claimed', () => {
    const j = longJudge()
    j.expire(1.5) // half way through the note
    expect(j.getStats().miss).toBe(0)
    expect(hit(j.press(60, 1.5))?.verdict).toBe('good')
  })

  it('misses it once the note has finished', () => {
    const j = longJudge()
    j.expire(2.2)
    expect(j.getStats().miss).toBe(1)
    expect(j.press(60, 2.3)).toBeNull()
  })

  it('still holds short notes to the Good window', () => {
    // A struck note has no sustain to be late into.
    const j = judgeFor([[1, 60]]) // 0.2s
    expect(j.press(60, 1.4)).toBeNull()
    expect(j.getStats().wrong).toBe(1)
  })

  it('keeps a late claim out of the calibration figures', () => {
    // One deliberate late grab would otherwise swamp the average and have the
    // results screen advise a wildly wrong offset.
    const j = new Judge(track([[1, 60], [4, 62]], 1), (n) => n.midi ?? -1, HARSH, 0)
    j.press(60, 1.02) // 20 ms late, real timing data
    j.press(62, 4.5) // 500 ms late, a grab
    expect(j.getStats().biasMs).toBe(20)
  })

  it('prefers a note in the window over an older one still sounding', () => {
    // A long note in a lane must not swallow the press aimed at the next note.
    const j = new Judge(track([[1, 60], [2, 60]], 1), (n) => n.midi ?? -1, HARSH, 0)
    expect(hit(j.press(60, 2.01))?.noteId).toBe(1)
  })
})
