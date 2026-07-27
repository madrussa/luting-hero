// Live notes for the player's own performance.
//
// This is the game's counterpart to Luting Studio's liveSynth.ts, and it exists
// for one reason: liveSynth owns a private AudioContext, and the game cannot
// afford a second clock. The judge times presses against the backing track's
// context clock, so a note fired into a different context would drift against
// the very thing it's being judged for. So the same primitives that player.ts
// exports are rebuilt here against a context the caller supplies.
//
// Everything else follows liveSynth's shape: a note-on starts a voice that
// sustains until note-off for sustained instruments, while plucks and drums
// fire their natural decay immediately and a release only damps them early.

import {
  SYNTHS,
  buildMelodicGraph,
  karplusBuffer,
  scheduleDrum,
  scheduleNoisePerc,
} from '../luting-core/player'
import { DRUM_SOUNDS, midiToPitch } from '../luting-core/luting'
import { getPlaybackMode, getBank, loadBank } from '../luting-core/samples'
import { GM_DRUM } from '../luting-core/gmDrum'

interface Voice {
  release: (at: number) => void
  kill: (at: number) => void
}

const SILENT: Voice = { release: () => {}, kill: () => {} }

/** LuteBoi's note-end ring-down time constant, matching samples.ts. */
const SAMPLE_RELEASE_TAU = 3000 / 44100

/** The DRUM_SOUNDS key a MIDI note maps to on the kit. */
export function drumKeyForMidi(midi: number): string | null {
  const p = GM_DRUM[midi] ?? midiToPitch(midi)
  const key = `o${p.octave}${p.letter[0]}`
  return DRUM_SOUNDS[key] ? key : null
}

export class LiveVoices {
  private readonly held = new Map<string, Voice>()

  constructor(
    private readonly ctx: AudioContext,
    private readonly dest: AudioNode
  ) {}

  noteOn(instrument: string, opts: { midi?: number; drum?: string; volume: number }): void {
    const { ctx, dest } = this
    const start = ctx.currentTime
    const key = `${instrument}:${opts.drum ?? opts.midi}`
    this.held.get(key)?.kill(start) // retrigger damps the still-sounding one

    const quality = getPlaybackMode() === 'quality'
    if (quality) void loadBank(instrument) // no-op if loaded or synth-only

    let voice: Voice
    if (opts.drum) {
      voice = this.oneShotDrum(opts.drum, opts.volume)
    } else if (opts.midi === undefined) {
      return
    } else if (instrument === 'p') {
      scheduleNoisePerc(ctx, dest, this.stub(instrument, opts.volume), start)
      voice = SILENT
    } else {
      voice =
        (quality ? this.sampled(instrument, opts.midi, opts.volume, start) : null) ??
        (instrument === 'l'
          ? this.karplus(opts.midi, opts.volume, start)
          : this.melodic(instrument, opts.midi, opts.volume, start))
    }
    this.held.set(key, voice)
  }

  noteOff(instrument: string, opts: { midi?: number; drum?: string }): void {
    const key = `${instrument}:${opts.drum ?? opts.midi}`
    this.held.get(key)?.release(this.ctx.currentTime)
    this.held.delete(key)
  }

  /** Release every sounding voice (song over, paused, page hidden). */
  allOff(): void {
    const at = this.ctx.currentTime
    for (const v of this.held.values()) v.release(at)
    this.held.clear()
  }

  /** A short dull thud for a missed note, so a miss is audible as well as seen. */
  missThud(): void {
    const { ctx, dest } = this
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(110, t)
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.09)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.09, t)
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.1)
    osc.connect(g)
    g.connect(dest)
    osc.start(t)
    osc.stop(t + 0.12)
  }

  private stub(instrument: string, volume: number) {
    return { timeSec: 0, durSec: 0.25, instrument, volume, pan: 0, voice: 0 }
  }

  private oneShotDrum(drum: string, volume: number): Voice {
    const { ctx, dest } = this
    const buffer = getPlaybackMode() === 'quality' ? getBank('d')?.drums[drum] : undefined
    if (buffer) {
      const src = ctx.createBufferSource()
      src.buffer = buffer
      const g = ctx.createGain()
      g.gain.value = volume * 0.9
      src.connect(g)
      g.connect(dest)
      src.start(ctx.currentTime)
      src.stop(ctx.currentTime + buffer.duration + 0.02)
    } else {
      scheduleDrum(ctx, dest, { ...this.stub('d', volume), drum }, ctx.currentTime)
    }
    return SILENT
  }

  private karplus(midi: number, volume: number, start: number): Voice {
    const { ctx, dest } = this
    const cfg = SYNTHS.l
    const freq = 440 * Math.pow(2, (midi - 69) / 12 + (cfg.octaveShift ?? 0))
    const src = ctx.createBufferSource()
    src.buffer = karplusBuffer(ctx, freq, 1.2)
    const g = ctx.createGain()
    const peak = cfg.gain * volume * 0.5
    g.gain.setValueAtTime(0, start)
    g.gain.linearRampToValueAtTime(peak, start + 0.002)
    src.connect(g)
    g.connect(dest)
    src.start(start)
    src.stop(start + src.buffer.duration + 0.02)
    const damp = (at: number, tau: number) => {
      g.gain.setTargetAtTime(0, at, tau)
      try {
        src.stop(at + tau * 8)
      } catch {
        // already ended
      }
    }
    return { release: (at) => damp(at, 0.05), kill: (at) => damp(at, 0.008) }
  }

  private melodic(instrument: string, midi: number, volume: number, start: number): Voice {
    const { ctx, dest } = this
    const cfg = SYNTHS[instrument] ?? SYNTHS.l
    const freq = 440 * Math.pow(2, (midi - 69) / 12 + (cfg.octaveShift ?? 0))
    const { gain, stop } = buildMelodicGraph(ctx, dest, cfg, freq, start)
    const peak = cfg.gain * volume * 0.22
    const atk = cfg.attack ?? (cfg.style === 'pluck' ? 0.005 : 0.04)
    const g = gain.gain
    g.setValueAtTime(0, start)
    g.linearRampToValueAtTime(peak, start + atk)
    if (cfg.style === 'pluck') g.setTargetAtTime(0, start + atk, (cfg.decay ?? 2.5) / 3)
    stop(start + 60) // stuck-note safety net
    const out = (at: number, tau: number) => {
      g.setTargetAtTime(0, at, tau)
      stop(at + tau * 8 + 0.05)
    }
    return {
      release: (at) => out(at, Math.max(cfg.release, 0.03) / 2),
      kill: (at) => out(at, 0.008),
    }
  }

  private sampled(instrument: string, midi: number, volume: number, start: number): Voice | null {
    const { ctx, dest } = this
    const bank = getBank(instrument)
    if (!bank || bank.melodic.length === 0) return null
    let best = bank.melodic[0]
    for (const e of bank.melodic) if (Math.abs(e.midi - midi) < Math.abs(best.midi - midi)) best = e

    const src = ctx.createBufferSource()
    src.buffer = best.buffer
    src.playbackRate.value = Math.pow(2, (midi - best.midi) / 12)
    if (bank.loop) {
      src.loop = true
      src.loopStart = best.loopStart
      src.loopEnd = best.loopEnd
    }
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, start)
    g.gain.linearRampToValueAtTime(volume * 0.8, start + 0.005)
    src.connect(g)
    g.connect(dest)
    src.start(start)
    if (bank.loop) src.stop(start + 120)
    else src.stop(start + best.buffer.duration / src.playbackRate.value + 0.02)

    const damp = (at: number, tau: number) => {
      g.gain.setTargetAtTime(0, at, tau)
      try {
        src.stop(at + tau * 8 + 0.05)
      } catch {
        // already ended
      }
    }
    return {
      release: (at) => damp(at, SAMPLE_RELEASE_TAU),
      kill: (at) => damp(at, 0.008),
    }
  }
}
