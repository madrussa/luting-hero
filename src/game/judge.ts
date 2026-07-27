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

/**
 * Notes shorter than this are struck, not held — a staccato sixteenth has no
 * sustain to hold and demanding one would be unplayable. Anything longer is
 * worth its onset points again for being held to the end, so a full-value note
 * means hitting it *and* keeping it down.
 */
export const HOLD_MIN_SEC = 0.25

/** The share of a holdable note's value that the sustain is worth. */
export const HOLD_SHARE = 1

/**
 * What a late save is worth, against a Good. It's a hit, and it keeps the
 * combo — but it isn't a Good, so it doesn't score like one or count as one.
 * Half applies to the whole note, sustain included: a late note is worth half
 * throughout rather than half at the onset and full for the hold.
 */
export const LATE_SHARE = 0.5

export const isHoldable = (note: GameNote): boolean => note.durSec >= HOLD_MIN_SEC

/** Combo multiplier steps, Guitar Hero style: x1 up to 9, then x2, x3, x4. */
export const comboMultiplier = (combo: number): number => Math.min(4, 1 + Math.floor(combo / 10))

/**
 * The score for a flawless run: every note Perfect, every sustain held to the
 * end, and the combo never dropping — so the multiplier climbs 1→4 over the
 * first thirty notes and stays there. Holdable notes count double, which is
 * what makes "hold it for full points" true rather than just encouraged.
 */
export function maxScoreFor(notes: GameNote[]): number {
  let total = 0
  notes.forEach((note, i) => {
    const base = VERDICT_POINTS.perfect * comboMultiplier(i)
    total += isHoldable(note) ? base * (1 + HOLD_SHARE) : base
  })
  return total
}

export interface Judgement {
  noteId: number
  verdict: Verdict
  /**
   * Claimed after the Good window, off a note that was still sounding. It
   * counts as a hit and keeps the combo, but it isn't a Good: it scores half
   * of one and is tallied on its own, because calling it a Good would hide
   * the mistake the player just made and recovered from.
   */
  late?: boolean
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
  /** notes long enough to need holding, and how much of them was held (0..1) */
  holdable: number
  heldFraction: number
  /** hits claimed after the Good window, off a note that was still sounding */
  late: number
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
  /** long enough that the sustain is scored */
  holdable: boolean
  /** combo multiplier at the onset, reused for the hold bonus */
  mult: number
  /** points the onset earned before the multiplier; the hold bonus matches it */
  base: number
  /** song time the key currently holding this note went down */
  holdingFrom?: number
  /** seconds of the note actually held down */
  heldSec: number
  /** the sustain is over and its bonus has been paid */
  settled: boolean
}

const emptyStats = (): Stats => ({
  perfect: 0, great: 0, good: 0, miss: 0, wrong: 0,
  holdable: 0, heldFraction: 0, late: 0,
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
    this.states = track.notes.map((note) => ({
      note,
      lane: laneOf(note),
      holdable: isHoldable(note),
      mult: 1,
      base: 0,
      heldSec: 0,
      settled: false,
    }))
    this.states.forEach((s, i) => {
      const list = this.byLane.get(s.lane)
      if (list) list.push(i)
      else this.byLane.set(s.lane, [i])
    })
    for (const lane of this.byLane.keys()) this.cursor.set(lane, 0)
  }

  /**
   * How long after its onset a note can still be claimed.
   *
   * For a struck note that's just the Good window. For a *held* one it's the
   * whole note: while a second-long note is still sounding, a press in its lane
   * is obviously you playing it, only late — counting that as a miss plus a
   * wrong note is wrong twice over. Landing late costs you anyway, because the
   * sustain is credited from the press.
   */
  private claimEnd(s: NoteState): number {
    const goodSec = this.window.good / 1000
    return s.note.timeSec + (s.holdable ? Math.max(goodSec, s.note.durSec) : goodSec)
  }

  /** The live combo, without building a whole Stats object for it. */
  get combo(): number {
    return this.stats.combo
  }

  getStats(): Stats {
    return {
      ...this.stats,
      heldFraction: this.stats.holdable ? this.heldSum / this.stats.holdable : 0,
      meanErrorMs: this.judged ? Math.round(this.absErrorSum / this.judged) : 0,
      biasMs: this.judged ? Math.round(this.errorSum / this.judged) : 0,
    }
  }

  /** Score attainable on this chart, for the results screen's "x / y". */
  maxScore(): number {
    return maxScoreFor(this.states.map((s) => s.note))
  }

  drainJudgements(): Judgement[] {
    if (this.pending.length === 0) return []
    const out = this.pending
    this.pending = []
    return out
  }

  /**
   * Judge a press in `lane` at `atSec`.
   *
   * Returns the judgement for a new note, the string `'resumed'` when the press
   * picked a sustain back up — letting go and grabbing a long note again must
   * not read as a wrong note — or null when there was nothing there at all.
   */
  press(lane: number, atSec: number): (Judgement & { verdict: HitVerdict }) | 'resumed' | null {
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
    // Nothing landed in the Good window. Before calling it a wrong note, look
    // for a long one still sounding in this lane and take that instead — first
    // one already struck (the player grabbing it again), then one not yet
    // claimed at all (a late but unmistakable hit).
    if (bestIdx === -1) {
      if (this.resume(lane, t)) return 'resumed'
      for (let k = this.cursor.get(lane) ?? 0; k < list.length; k++) {
        const s = this.states[list[k]]
        if (s.note.timeSec > t) break
        if (s.verdict || !s.holdable) continue
        if (t < this.claimEnd(s)) {
          bestIdx = list[k]
          break
        }
      }
    }
    if (bestIdx === -1) {
      this.registerWrong()
      return null
    }

    const s = this.states[bestIdx]
    const deltaSec = t - s.note.timeSec
    const absMs = Math.abs(deltaSec) * 1000
    // Past the Good window means this was claimed late off a sounding note. It
    // still counts, for half of what a Good would pay.
    const late = absMs > this.window.good
    const verdict: Verdict =
      absMs <= this.window.perfect ? 'perfect' : absMs <= this.window.great ? 'great' : 'good'

    s.verdict = verdict
    s.hitAtSec = atSec
    s.mult = comboMultiplier(this.stats.combo)
    // The sustain starts from the note's own onset, not from the press: being
    // 30 ms early shouldn't earn extra hold, and being 30 ms late shouldn't
    // cost any.
    if (s.holdable) {
      // A previous sustain in this lane is over the moment a new note starts.
      const prev = this.active.get(lane)
      if (prev && prev !== s && !prev.settled) this.settle(prev, t)
      s.holdingFrom = Math.max(t, s.note.timeSec)
      this.active.set(lane, s)
    }

    s.base = late ? Math.round(VERDICT_POINTS.good * LATE_SHARE) : VERDICT_POINTS[verdict]

    this.stats.combo += 1
    this.stats.maxCombo = Math.max(this.stats.maxCombo, this.stats.combo)
    this.stats.score += s.base * s.mult
    // A late save is its own category. Folding it into Goods would inflate the
    // Good count and the accuracy with notes that were, in fact, fumbled.
    if (!late) this.stats[verdict] += 1
    // Late claims are deliberate grabs at a sounding note, not evidence of
    // how your timing sits, so they stay out of the calibration figures —
    // otherwise one of them would swamp the average and the results screen
    // would advise a wildly wrong offset.
    if (late) {
      this.stats.late += 1
    } else {
      this.absErrorSum += absMs
      this.errorSum += deltaSec * 1000
      this.judged += 1
    }

    const j: Judgement & { verdict: HitVerdict } = {
      noteId: s.note.id,
      verdict,
      late,
      deltaMs: Math.round(deltaSec * 1000),
      lane,
      atSec,
    }
    this.pending.push(j)
    this.advance(lane)
    return j
  }

  /**
   * The note this lane is currently sustaining, if any.
   *
   * Held in its own map rather than found by scanning, because the lane cursor
   * has already stepped past the note by then — it exists to find the next
   * *unjudged* onset, and a sustaining note is by definition judged.
   */
  private sustaining(lane: number, t: number): NoteState | null {
    const s = this.active.get(lane)
    if (!s) return null
    if (t >= s.note.timeSec + s.note.durSec) return null
    return s
  }

  /**
   * The note a lane is sounding right now — what a press there takes hold of.
   * The caller needs it to know what to *play*: on easy mode's folded keyboard
   * a key covers several pitches, so which note is sustaining decides which
   * pitch a re-grab sounds.
   */
  noteSustaining(lane: number, atSec: number): GameNote | null {
    return this.sustaining(lane, atSec - this.offsetSec)?.note ?? null
  }

  private resume(lane: number, t: number): boolean {
    const s = this.sustaining(lane, t)
    if (!s || s.holdingFrom !== undefined) return false
    s.holdingFrom = t
    return true
  }

  /**
   * A key came up. Bank whatever was held; the note isn't settled yet, so
   * grabbing it again before it ends carries on adding to the same total.
   */
  release(lane: number, atSec: number): void {
    const t = atSec - this.offsetSec
    const s = this.sustaining(lane, t)
    if (!s || s.holdingFrom === undefined) return
    this.bank(s, t)
  }

  /** Add the time held so far to a note's total and stop the clock on it. */
  private bank(s: NoteState, t: number): void {
    if (s.holdingFrom === undefined) return
    const end = s.note.timeSec + s.note.durSec
    s.heldSec += Math.max(0, Math.min(t, end) - s.holdingFrom)
    s.holdingFrom = undefined
  }

  /**
   * The sustain is over: bank any hold still running and pay the bonus, in
   * proportion to how much of the note was actually held.
   */
  private settle(s: NoteState, t: number): void {
    this.bank(s, t)
    s.settled = true
    if (!s.holdable || !s.verdict || s.verdict === 'miss') return
    const held = Math.max(0, Math.min(1, s.heldSec / s.note.durSec))
    this.stats.holdable += 1
    this.heldSum += held
    this.stats.score += Math.round(s.base * s.mult * HOLD_SHARE * held)
  }

  /**
   * Expire notes whose Good window has closed, and settle sustains that have
   * run out. Call every frame with the current song time; each newly missed
   * note breaks the combo.
   */
  expire(atSec: number) {
    const t = atSec - this.offsetSec

    // Pay out any sustain whose note has now ended.
    for (const [lane, s] of [...this.active]) {
      if (s.settled) {
        this.active.delete(lane)
        continue
      }
      if (t >= s.note.timeSec + s.note.durSec) {
        this.settle(s, t)
        this.active.delete(lane)
      }
    }
    for (const [lane, list] of this.byLane) {
      // Scan every note whose onset has passed rather than stopping at the
      // first unresolved one: claim windows now vary by note length, so a short
      // note can expire while a long one before it is still claimable.
      for (let j = this.cursor.get(lane) ?? 0; j < list.length; j++) {
        const s = this.states[list[j]]
        if (s.note.timeSec > t) break
        if (s.verdict || t <= this.claimEnd(s)) continue
        s.verdict = 'miss'
        this.stats.miss += 1
        this.stats.combo = 0
        this.pending.push({
          noteId: s.note.id,
          verdict: 'miss',
          deltaMs: 0,
          lane,
          atSec: this.claimEnd(s),
        })
      }
      // The cursor only steps over notes that are fully resolved.
      let k = this.cursor.get(lane) ?? 0
      while (k < list.length && this.states[list[k]].verdict) k++
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

  private heldSum = 0
  /** the note each lane is currently sustaining, keyed by lane */
  private readonly active = new Map<number, NoteState>()
}

// ---------------------------------------------------------------------------
// Results

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F'

export function grade(stats: Stats, totalNotes: number): Grade {
  if (totalNotes === 0) return 'F'
  const hit = stats.perfect + stats.great + stats.good + stats.late
  // Accuracy weights the verdicts rather than counting any hit as a hit, so a
  // full-combo run of scrappy Goods lands a grade below a clean one — and a run
  // rescued by late saves lands below that again.
  const weighted = accuracy(stats, totalNotes)
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
    : (stats.perfect + stats.great * 0.7 + stats.good * 0.4 + stats.late * 0.2) / totalNotes
