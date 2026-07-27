// The song clock and the backing track.
//
// One AudioContext runs the whole game. Song time is derived from
// ctx.currentTime rather than performance.now() or requestAnimationFrame, so
// the notes on the highway, the judge's windows and the backing audio can never
// drift apart — they are all reading the same oscillator that is producing the
// sound. A frame that arrives late moves the highway, not the music.
//
// Backing notes are scheduled just-in-time in a rolling window. Charts like
// Rush E carry thousands of notes; building every node upfront stalls the audio
// thread for seconds, and the stall lands exactly on the countdown.

import { scheduleNote } from '../luting-core/player'
import { BASE_GAIN, getMasterVolume } from '../luting-core/player'
import { getPlaybackMode, loadBank } from '../luting-core/samples'
import type { ScheduledNote } from '../luting-core/luting'
import { LiveVoices } from './liveVoice'

/** How far ahead of the playhead backing notes are handed to Web Audio. */
const SCHEDULE_AHEAD_SEC = 4
const PUMP_MS = 500

export interface TransportOptions {
  backing: ScheduledNote[]
  /** silence before the first note, for the count-in */
  leadInSec: number
  /** instrument codes to warm sample packs for, in Quality mode */
  prewarm: string[]
  onEnded?: () => void
  /** song time (seconds) the whole chart is over */
  durationSec: number
}

export class Transport {
  readonly ctx: AudioContext
  readonly voices: LiveVoices
  private readonly master: GainNode
  private readonly backingGain: GainNode
  private readonly queue: ScheduledNote[]
  private readonly opts: TransportOptions

  /** ctx.currentTime that corresponds to song time 0 */
  private startedAt = 0
  private idx = 0
  private pump = 0
  private endTimer = 0
  private running = false
  private pausedAt: number | null = null
  /** stop() is irreversible; every entry point checks this first. React's
   *  StrictMode mounts, unmounts and remounts, so a start() already in flight
   *  can land after its own transport has been thrown away. */
  private closed = false

  constructor(opts: TransportOptions) {
    this.opts = opts
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.master.gain.value = BASE_GAIN * getMasterVolume()
    const comp = this.ctx.createDynamicsCompressor()
    this.master.connect(comp)
    comp.connect(this.ctx.destination)

    // The backing sits slightly under the player's own notes so you can hear
    // yourself against it — the point of the game is your performance.
    this.backingGain = this.ctx.createGain()
    this.backingGain.gain.value = 0.65
    this.backingGain.connect(this.master)

    this.voices = new LiveVoices(this.ctx, this.master)
    this.queue = [...opts.backing].sort((a, b) => a.timeSec - b.timeSec)

    if (getPlaybackMode() === 'quality') {
      for (const code of new Set(opts.prewarm)) void loadBank(code)
    }
  }

  /** Song time in seconds; negative during the count-in. */
  now(): number {
    if (this.pausedAt !== null) return this.pausedAt
    if (!this.running) return -this.opts.leadInSec
    return this.ctx.currentTime - this.startedAt
  }

  get audioLatencySec(): number {
    // outputLatency is the honest figure but isn't implemented everywhere;
    // baseLatency is the fallback, and both can be absent.
    return this.ctx.outputLatency || this.ctx.baseLatency || 0
  }

  /**
   * Wake the audio context up front, before anything is awaited.
   *
   * Sample packs are fetched between choosing an instrument and the count-in,
   * which puts a network round-trip between the player's click and the first
   * resume(). Browsers keep user activation sticky once a page has been
   * interacted with, so that would very probably work anyway — but "very
   * probably" here means a silent song, and resuming while the click is still
   * fresh costs nothing.
   */
  async prepare(): Promise<void> {
    if (this.closed) return
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  async start(): Promise<void> {
    if (this.closed) return
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    if (this.closed) return // stopped while we were waiting on resume()
    // Song time 0 is leadInSec into the future, so the count-in has real time
    // to run and the first note isn't already late when the highway appears.
    this.startedAt = this.ctx.currentTime + this.opts.leadInSec
    this.running = true
    this.pausedAt = null
    this.scheduleWindow()
    this.pump = window.setInterval(() => this.scheduleWindow(), PUMP_MS)
    this.armEnd()
  }

  pause(): void {
    if (!this.running || this.pausedAt !== null) return
    this.pausedAt = this.now()
    window.clearInterval(this.pump)
    window.clearTimeout(this.endTimer)
    this.voices.allOff()
    void this.ctx.suspend()
  }

  async resume(): Promise<void> {
    if (this.closed || this.pausedAt === null) return
    await this.ctx.resume()
    if (this.closed) return
    // Re-anchor to where the clock actually is now; suspend() freezes
    // currentTime, but not reliably to the microsecond across browsers.
    this.startedAt = this.ctx.currentTime - this.pausedAt
    this.pausedAt = null
    this.scheduleWindow()
    this.pump = window.setInterval(() => this.scheduleWindow(), PUMP_MS)
    this.armEnd()
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    this.running = false
    window.clearInterval(this.pump)
    window.clearTimeout(this.endTimer)
    this.voices.allOff()
    void this.ctx.close().catch(() => {
      // already closing; nothing left to release
    })
  }

  /** Mute or unmute the backing without rebuilding the schedule. */
  setBackingEnabled(on: boolean): void {
    if (this.closed) return
    this.backingGain.gain.setTargetAtTime(on ? 0.65 : 0, this.ctx.currentTime, 0.05)
  }

  private scheduleWindow(): void {
    if (this.closed) return
    const limit = this.now() + SCHEDULE_AHEAD_SEC
    while (this.idx < this.queue.length && this.queue[this.idx].timeSec <= limit) {
      scheduleNote(this.ctx, this.backingGain, this.queue[this.idx++], this.startedAt)
    }
  }

  private armEnd(): void {
    const remainingMs = (this.opts.durationSec - this.now() + 1.5) * 1000
    this.endTimer = window.setTimeout(() => this.opts.onEnded?.(), Math.max(0, remainingMs))
  }
}
