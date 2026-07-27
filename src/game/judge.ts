// Hit judging and scoring.
//
// The judge owns the only authoritative view of how the run is going. It is
// deliberately pure and clock-agnostic: every entry point takes an explicit
// song time in seconds, so the game loop can feed it the AudioContext clock
// and the tests can feed it whatever they like.
//
// Notes are judged on their onsets. A note is claimed by the *first* unjudged
// press in its lane that lands inside the Good window, nearest-first — with
// chords and fast repeats, "nearest" is what stops one press from stealing the
// note a later press was aiming for.

import type { GameNote, Track } from './chart'
import type { HitWindow } from './settings'

export type Verdict = 'perfect' | 'great' | 'good' | 'miss'
/**
 * What a press can earn. A miss is never one of them — a miss is a note whose
 * window closed untouched, which only `expire` can decide — so `press` returns
 * this narrower type and callers don't have to handle a case that can't happen.
 */
export type HitVerdict = Exclude<Verdict, 'miss'>

export const VERDICT_POINTS: Record<Exclude<Verdict, 'miss'>, number> = {
  perfect: 300,
  great: 200,
  good: 100,
}

/** Combo multiplier steps, Guitar Hero style: x1 up to 9, then x2, x3, x4. */
export const comboMultiplier = (combo: number): number => Math.min(4, 1 + Math.floor(combo / 10))

/**
 * The score for a flawless run of `noteCount` notes: every note Perfect with
 * the combo never dropping, so the multiplier climbs 1→4 over the first thirty
 * notes and stays there.
 */
export function maxScoreFor(noteCount: number): number {
  let total = 0
  for (let i = 0; i < noteCount; i++) total += VERDICT_POINTS.perfect * comboMultiplier(i)
  return total
}

export interface Judgement {
  noteId: number
  verdict: Verdict
  /** signed ms the press landed relative to the note (negative = early) */
  deltaMs: number
  lane: number
  /** song time the judgement was made, for the floating hit text */
  atSec: number
}

export interface Stats {
  perfect: number
  great: number
  good: number
  miss: number
  /** presses in a lane with no note anywhere near — counted, never scored */
  wrong: number
  score: number
  combo: number
  maxCombo: number
  /** mean absolute timing error over judged hits, ms */
  meanErrorMs: number
  /** mean signed error: negative = you rush, positive = you drag */
  biasMs: number
}

export interface NoteState {
  note: GameNote
  lane: number
  /** unset until judged */
  verdict?: Verdict
  /** song time it was hit, for the highway's hit flash */
  hitAtSec?: number
}

const emptyStats = (): Stats => ({
  perfect: 0, great: 0, good: 0, miss: 0, wrong: 0,
  score: 0, combo: 0, maxCombo: 0, meanErrorMs: 0, biasMs: 0,
})

export class Judge {
  readonly states: NoteState[]
  /** note indices per lane, in time order, so a press scans only its own lane */
  private readonly byLane = new Map<number, number[]>()
  /** per-lane index of the earliest note not yet judged or expired */
  private readonly cursor = new Map<number, number>()
  private readonly window: HitWindow
  private readonly offsetSec: number

  private stats = emptyStats()
  private absErrorSum = 0
  private errorSum = 0
  private judged = 0

  /** judgements made since the renderer last drained them */
  private pending: Judgement[] = []

  constructor(track: Track, laneOf: (note: GameNote) => number, window: HitWindow, offsetMs: number) {
    this.window = window
    this.offsetSec = offsetMs / 1000
    this.states = track.notes.map((note) => ({ note, lane: laneOf(note) }))
    this.states.forEach((s, i) => {
      const list = this.byLane.get(s.lane)
      if (list) list.push(i)
      else this.byLane.set(s.lane, [i])
    })
    for (const lane of this.byLane.keys()) this.cursor.set(lane, 0)
  }

  /** The live combo, without building a whole Stats object for it. */
  get combo(): number {
    return this.stats.combo
  }

  getStats(): Stats {
    return {
      ...this.stats,
      meanErrorMs: this.judged ? Math.round(this.absErrorSum / this.judged) : 0,
      biasMs: this.judged ? Math.round(this.errorSum / this.judged) : 0,
    }
  }

  /** Score attainable on this chart, for the results screen's "x / y". */
  maxScore(): number {
    return maxScoreFor(this.states.length)
  }

  drainJudgements(): Judgement[] {
    if (this.pending.length === 0) return []
    const out = this.pending
    this.pending = []
    return out
  }

  /**
   * Judge a press in `lane` at `atSec`. Returns the judgement, or null when
   * there was nothing to hit (which the caller shows as a wrong note).
   */
  press(lane: number, atSec: number): (Judgement & { verdict: HitVerdict }) | null {
    const t = atSec - this.offsetSec
    const list = this.byLane.get(lane)
    if (!list) {
      this.registerWrong()
      return null
    }
    const goodSec = this.window.good / 1000

    // Walk from the lane's cursor and take the nearest unjudged note in range.
    let bestIdx = -1
    let bestAbs = Infinity
    for (let k = this.cursor.get(lane) ?? 0; k < list.length; k++) {
      const s = this.states[list[k]]
      if (s.note.timeSec - t > goodSec) break // the rest are further into the future
      if (s.verdict) continue
      const abs = Math.abs(s.note.timeSec - t)
      if (abs <= goodSec && abs < bestAbs) {
        bestAbs = abs
        bestIdx = list[k]
      }
    }
    if (bestIdx === -1) {
      this.registerWrong()
      return null
    }

    const s = this.states[bestIdx]
    const deltaSec = t - s.note.timeSec
    const absMs = Math.abs(deltaSec) * 1000
    const verdict: Verdict =
      absMs <= this.window.perfect ? 'perfect' : absMs <= this.window.great ? 'great' : 'good'

    s.verdict = verdict
    s.hitAtSec = atSec

    this.stats.combo += 1
    this.stats.maxCombo = Math.max(this.stats.maxCombo, this.stats.combo)
    this.stats.score += VERDICT_POINTS[verdict] * comboMultiplier(this.stats.combo - 1)
    this.stats[verdict] += 1
    this.absErrorSum += absMs
    this.errorSum += deltaSec * 1000
    this.judged += 1

    const j: Judgement & { verdict: HitVerdict } = {
      noteId: s.note.id,
      verdict,
      deltaMs: Math.round(deltaSec * 1000),
      lane,
      atSec,
    }
    this.pending.push(j)
    this.advance(lane)
    return j
  }

  /**
   * Expire notes whose Good window has closed. Call every frame with the
   * current song time; each newly missed note breaks the combo.
   */
  expire(atSec: number) {
    const t = atSec - this.offsetSec
    const goodSec = this.window.good / 1000
    for (const [lane, list] of this.byLane) {
      let k = this.cursor.get(lane) ?? 0
      while (k < list.length) {
        const s = this.states[list[k]]
        if (s.verdict) {
          k++
          continue
        }
        if (t - s.note.timeSec <= goodSec) break
        s.verdict = 'miss'
        this.stats.miss += 1
        this.stats.combo = 0
        this.pending.push({
          noteId: s.note.id,
          verdict: 'miss',
          deltaMs: 0,
          lane,
          atSec: s.note.timeSec + goodSec,
        })
        k++
      }
      this.cursor.set(lane, k)
    }
  }

  /** Every note has a verdict — the run can end without waiting out the tail. */
  isComplete(): boolean {
    return this.states.every((s) => s.verdict !== undefined)
  }

  /** Advance a lane's cursor past notes that are already resolved. */
  private advance(lane: number) {
    const list = this.byLane.get(lane)
    if (!list) return
    let k = this.cursor.get(lane) ?? 0
    while (k < list.length && this.states[list[k]].verdict) k++
    this.cursor.set(lane, k)
  }

  private registerWrong() {
    this.stats.wrong += 1
    this.stats.combo = 0
  }
}

// ---------------------------------------------------------------------------
// Results

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F'

export function grade(stats: Stats, totalNotes: number): Grade {
  if (totalNotes === 0) return 'F'
  const hit = stats.perfect + stats.great + stats.good
  // Accuracy weights the verdicts rather than counting any hit as a hit, so a
  // full-combo run of scrappy Goods lands a grade below a clean one.
  const weighted = (stats.perfect + stats.great * 0.7 + stats.good * 0.4) / totalNotes
  if (hit === totalNotes && stats.wrong === 0 && weighted >= 0.95) return 'S'
  if (weighted >= 0.85) return 'A'
  if (weighted >= 0.7) return 'B'
  if (weighted >= 0.55) return 'C'
  if (weighted >= 0.35) return 'D'
  return 'F'
}

export const accuracy = (stats: Stats, totalNotes: number): number =>
  totalNotes === 0
    ? 0
    : (stats.perfect + stats.great * 0.7 + stats.good * 0.4) / totalNotes
