// In-browser preview synth. Not luteboi's real soundfonts — a Web Audio
// approximation so lutings can be auditioned without leaving the page.

import { parseLuting, DRUM_SOUNDS } from './luting'
import type { ScheduledNote } from './luting'
import { getPlaybackMode, getBank, loadBank, scheduleSampled } from './samples'

export interface SynthConfig {
  wave: OscillatorType
  style: 'pluck' | 'sustain'
  /** lowpass cutoff as a multiple of the note frequency */
  cutoff: number
  /** absolute lowpass cutoff in Hz; overrides cutoff*freq when set, so brightness
   * stays fixed as pitch rises (matches luteboi's fixed one-pole filters) */
  cutoffHz?: number
  release: number
  /** attack time in seconds (default: 5ms for pluck, 40ms for sustain) */
  attack?: number
  gain: number
  /** add an oscillator one octave down */
  sub?: boolean
  /** vibrato depth in cents */
  vibrato?: number
  /** shift the whole instrument up/down by octaves */
  octaveShift?: number
  /** onset glide in cents (positive = start sharp, negative = start flat) */
  glide?: number
  /** roughness: detuned second oscillator + breathy noise */
  grain?: boolean
  /** pluck decay: seconds to fall to ~5% (default: rings for the note length) */
  decay?: number
  /**
   * vocal/instrumental formant: a bandpass resonance at mul x the
   * fundamental, clamped to [min, max] Hz, with a quiet direct "body" path
   * whose gain is body/freq. All values measured from real luteboi renders
   * (e.g. The Cat peaks at h4 ~1.04kHz, Choir at h2, Harmonica at h5).
   */
  formant?: { mul: number; q: number; min: number; max: number; body: number }
}

// Every config below is tuned against real luteboi renders (C3/C4/C5 test
// lutings, analyzed for pitch offset, envelope, decay rate, vibrato and
// harmonic spectrum). Notable measured truths: Bean/Overdriven/Slap Bass play
// an octave below written; Choir/Harmonica/Horn/Slap Bass/Bean/Cat have
// formant resonances; Bell/Vibraphone/Ocarina are near-pure sines.
export const SYNTHS: Record<string, SynthConfig> = {
  // bright plucked string: strong h2/h4 (1, .79, .17, .39), decays to ~17% by 0.85s
  l: { wave: 'sawtooth', style: 'pluck', cutoff: 4.5, release: 0.3, gain: 0.9, decay: 1.3 },
  // additive in luteboi (pysynth_b): h2 dominant (~.5) + h3/h4 (~.12/.14), no
  // sub-octave; upper harmonics decay ~3x faster (bright→mellow). Sawtooth
  // supplies the even harmonics a triangle lacks; static filter can't do the
  // bright→mellow sweep, so this matches the body, not the evolution.
  b: { wave: 'sawtooth', style: 'pluck', cutoff: 3, release: 0.25, gain: 1.3, decay: 2.3 },
  // sine plus a healthy octave partial (h2 .55)
  f: { wave: 'triangle', style: 'sustain', cutoff: 3.5, release: 0.12, gain: 1.0 },
  // the octave harmonic DOMINATES the fundamental (h2 1.0 vs h1 .54)
  k: { wave: 'sawtooth', style: 'pluck', cutoff: 5, release: 0.3, gain: 0.9, decay: 0.9 },
  // 50% square through luteboi's FIXED ~740Hz one-pole lowpass (pysynth_d), so
  // higher notes get darker — an absolute cutoffHz, not freq-relative. ~800Hz
  // for our steeper biquad. Near-instant onset (no sustain swell).
  c: { wave: 'square', style: 'sustain', cutoff: 4, cutoffHz: 800, release: 0.02, gain: 0.55, attack: 0.003 },
  // meow: written pitch, rises ~70 cents into the note, formant at h4 (~1kHz)
  m: { wave: 'sawtooth', style: 'sustain', cutoff: 6, release: 0.1, gain: 1.5, vibrato: 15, glide: -70, grain: true, formant: { mul: 4, q: 5, min: 1000, max: 2600, body: 18 } },
  // plays an OCTAVE DOWN; vocal formant around 2x the (shifted) fundamental
  t: { wave: 'sawtooth', style: 'sustain', cutoff: 5, release: 0.1, gain: 0.9, octaveShift: -1, formant: { mul: 2, q: 2.5, min: 150, max: 1200, body: 60 } },
  // a 0.2s inharmonic thwack
  p: { wave: 'triangle', style: 'pluck', cutoff: 8, release: 0.1, gain: 0.5, decay: 0.18 },
  d: { wave: 'triangle', style: 'pluck', cutoff: 5, release: 0.1, gain: 1 }, // unused; drums use generators
  // near-pure sine (h2 .01) ringing past 2 seconds
  a: { wave: 'sine', style: 'pluck', cutoff: 10, release: 0.5, gain: 1.0, decay: 2.2 },
  // drawbar stack: strong h2/h4/h8 partials
  o: { wave: 'sawtooth', style: 'sustain', cutoff: 4.5, release: 0.15, gain: 0.65, sub: true },
  // "aah": h2 dominates, fundamental almost absent (h1 .04)
  e: { wave: 'sawtooth', style: 'sustain', cutoff: 6, release: 0.25, gain: 0.75, vibrato: 12, formant: { mul: 2, q: 6, min: 200, max: 1600, body: 8 } },
  // bright saw-like bowed spectrum (h2 .97)
  v: { wave: 'sawtooth', style: 'sustain', cutoff: 5, release: 0.2, gain: 0.85, vibrato: 15 },
  // confirmed near-pure sine
  g: { wave: 'sine', style: 'sustain', cutoff: 6, release: 0.08, gain: 1.1 },
  // brassy resonance around h2-h3
  h: { wave: 'sawtooth', style: 'sustain', cutoff: 3, release: 0.15, gain: 0.7, formant: { mul: 2.5, q: 2, min: 300, max: 2000, body: 90 } },
  // near-pure sine, ~1.5s ring, no audible tremolo
  i: { wave: 'sine', style: 'pluck', cutoff: 12, release: 0.6, gain: 1.0, decay: 1.5 },
  // OCTAVE DOWN, dense distorted spectrum
  j: { wave: 'square', style: 'sustain', cutoff: 4, release: 0.1, gain: 0.55, octaveShift: -1, grain: true },
  // far mellower than a raw saw (h2 .3, little above)
  s: { wave: 'sawtooth', style: 'sustain', cutoff: 2.5, release: 0.12, gain: 0.8, vibrato: 10 },
  // striking reed resonance at the FIFTH harmonic (~1.3kHz)
  n: { wave: 'sawtooth', style: 'sustain', cutoff: 7, release: 0.1, gain: 0.7, formant: { mul: 5, q: 3.5, min: 800, max: 3500, body: 200 } },
  // OCTAVE DOWN, slap formant at h3
  q: { wave: 'sawtooth', style: 'pluck', cutoff: 4, release: 0.15, gain: 1.0, octaveShift: -1, decay: 1.0, formant: { mul: 3, q: 3, min: 200, max: 1500, body: 70 } },
}

let noiseBuffer: AudioBuffer | null = null
function getNoise(ctx: BaseAudioContext): AudioBuffer {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  return noiseBuffer
}

/**
 * Build the oscillator/filter/vibrato graph for a melodic instrument, started
 * at `start` with the envelope gain node left at 0 for the caller to automate.
 * Shared by the scheduled preview (which knows the note's duration upfront)
 * and the live MIDI synth (which doesn't — a key release ends the note).
 * `stop(at)` (re-)schedules the end of every source in the graph.
 */
export interface MelodicGraph {
  gain: GainNode
  stop: (at: number) => void
}

export function buildMelodicGraph(
  ctx: BaseAudioContext,
  dest: AudioNode,
  cfg: SynthConfig,
  freq: number,
  start: number
): MelodicGraph {
  const gain = ctx.createGain()
  const filter = ctx.createBiquadFilter()
  let bodyFilter: BiquadFilterNode | null = null
  if (cfg.formant) {
    const f = cfg.formant
    filter.type = 'bandpass'
    filter.frequency.value = Math.min(f.max, Math.max(f.min, freq * f.mul))
    filter.Q.value = f.q
    // a quiet direct path keeps the fundamental's body, stronger on low notes
    bodyFilter = ctx.createBiquadFilter()
    bodyFilter.type = 'lowpass'
    bodyFilter.frequency.value = freq * 2.5
    const bodyGain = ctx.createGain()
    bodyGain.gain.value = Math.min(0.5, f.body / freq)
    bodyFilter.connect(bodyGain)
    bodyGain.connect(gain)
  } else {
    filter.type = 'lowpass'
    filter.frequency.value = cfg.cutoffHz ?? Math.min(16000, freq * cfg.cutoff)
  }
  filter.connect(gain)
  gain.connect(dest)
  gain.gain.value = 0

  const sources: AudioScheduledSourceNode[] = []
  const oscs: OscillatorNode[] = []
  const main = ctx.createOscillator()
  main.type = cfg.wave
  if (cfg.glide) {
    main.frequency.setValueAtTime(freq * Math.pow(2, cfg.glide / 1200), start)
    main.frequency.exponentialRampToValueAtTime(freq, start + 0.22)
  } else {
    main.frequency.value = freq
  }
  oscs.push(main)
  if (cfg.sub) {
    const sub = ctx.createOscillator()
    sub.type = 'sine'
    sub.frequency.value = freq / 2
    oscs.push(sub)
  }
  if (cfg.grain) {
    // beating detuned partner for roughness
    const rough = ctx.createOscillator()
    rough.type = cfg.wave
    rough.frequency.value = freq
    rough.detune.value = 15
    oscs.push(rough)
    // breathy band of noise riding the same envelope
    const noise = ctx.createBufferSource()
    noise.buffer = getNoise(ctx)
    noise.loop = true
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = Math.min(9000, freq * 3)
    band.Q.value = 1.5
    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0.3
    noise.connect(band)
    band.connect(noiseGain)
    noiseGain.connect(filter)
    sources.push(noise)
  }
  if (cfg.vibrato) {
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 5.5
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = (cfg.vibrato / 1200) * freq
    lfo.connect(lfoGain)
    lfoGain.connect(main.frequency)
    sources.push(lfo)
  }
  for (const o of oscs) {
    o.connect(filter)
    if (bodyFilter) o.connect(bodyFilter)
    sources.push(o)
  }
  for (const s of sources) s.start(start)
  return {
    gain,
    stop: (at: number) => {
      for (const s of sources) {
        try {
          s.stop(at)
        } catch {
          // source already ended; nothing to stop
        }
      }
    },
  }
}

function scheduleMelodic(ctx: BaseAudioContext, dest: AudioNode, n: ScheduledNote, t0: number) {
  const cfg = SYNTHS[n.instrument] ?? SYNTHS.l
  const freq = 440 * Math.pow(2, ((n.midi ?? 60) - 69) / 12 + (cfg.octaveShift ?? 0))
  const start = t0 + n.timeSec
  const holdEnd = start + Math.max(0.03, n.durSec - 0.02)
  const stopAt = holdEnd + (cfg.style === 'pluck' ? Math.max(cfg.release, 0.1) : cfg.release) + 0.05

  const { gain, stop } = buildMelodicGraph(ctx, dest, cfg, freq, start)
  const peak = cfg.gain * n.volume * 0.22
  const atk = cfg.attack ?? (cfg.style === 'pluck' ? 0.005 : 0.04)
  const g = gain.gain
  g.setValueAtTime(0, start)
  if (cfg.style === 'pluck') {
    g.linearRampToValueAtTime(peak, start + atk)
    // decay at the instrument's own rate, cut short by the note's end
    const decayEnd = Math.min(start + atk + (cfg.decay ?? 2.5), holdEnd + cfg.release)
    g.exponentialRampToValueAtTime(Math.max(peak * 0.05, 0.001), decayEnd)
    g.linearRampToValueAtTime(0, stopAt)
  } else {
    g.linearRampToValueAtTime(peak, start + atk)
    g.setValueAtTime(peak, holdEnd)
    g.linearRampToValueAtTime(0, holdEnd + cfg.release)
  }
  stop(stopAt)
}

// The lute has no sample pack — LuteBoi synthesizes it with Karplus-Strong
// plucked-string modeling (pysynth_s.py), which is what gives it the twang: a
// broadband noise-burst "pick" excites a feedback delay whose in-loop averaging
// lowpass makes high harmonics decay faster than low ones (bright onset → mellow
// tail). A subtractive sawtooth can't reproduce that, so we run the same
// recurrence in JS and play the result as a buffer — a Web Audio DelayNode
// feedback loop can't, because its 128-sample render-quantum latency breaks
// pitch above ~344Hz. Ported from pysynth_s render2; decay is calibrated to the
// note length (a short note damps fast, a long one rings), then bounded so the
// natural ring doesn't overlap forever. Cached per pitch+length like LuteBoi's.
const ksCache = new Map<string, AudioBuffer>()

export function karplusBuffer(ctx: BaseAudioContext, freq: number, durSec: number): AudioBuffer {
  const sr = ctx.sampleRate
  const key = `${sr}:${Math.round(freq * 100)}:${Math.round(durSec * 100)}`
  const hit = ksCache.get(key)
  if (hit) return hit

  const lf = Math.log(freq)
  const period = sr / freq
  const numPeriods = Math.max(1, Math.round(durSec * freq))
  const q = period * numPeriods
  let sndLen = Math.round((10 - lf) * q)
  if (lf < 4) sndLen *= 2
  sndLen = Math.min(sndLen, Math.round((durSec + 2.5) * sr)) // bound the ring
  sndLen = Math.max(sndLen, Math.round(0.05 * sr))

  const kpLen = Math.max(2, Math.round(period))
  const sm = 10 // noise-burst pre-smoothing window
  const falloff = Math.pow((4 / lf) * 0.25, 1 / numPeriods) // per-period loop gain
  const volfac = 1 + 0.8 * ((lf - 3) / 5.5) * Math.cos((Math.PI / 5.3) * (lf - 3))

  const kps1 = new Float32Array(sndLen)
  const kps2 = new Float32Array(sndLen)
  for (let i = 0; i < kpLen && i < sndLen; i++) kps1[i] = Math.random() * 2 - 1
  for (let t = 0; t < kpLen && t < sndLen; t++) {
    let s = 0
    for (let k = 0; k < sm; k++) s += t + k < sndLen ? kps1[t + k] : 0
    kps2[t] = s / sm
  }
  const li = Math.floor(period)
  const hi = Math.ceil(period)
  const ifac = period - li
  const delt2 = (period * (li - 1)) / li
  const ifac2 = delt2 - Math.floor(delt2)
  for (let t = hi; t < sndLen; t++) {
    const v1 = ifac * kps2[t - hi] + (1 - ifac) * kps2[t - li]
    const v2 = ifac2 * kps2[t - hi + 1] + (1 - ifac2) * kps2[t - li + 1]
    kps2[t] += 0.5 * (v1 + v2) * falloff
  }
  const fade = Math.min(Math.round(0.02 * sr), sndLen) // anti-click at the bounded end
  for (let i = 0; i < fade; i++) kps2[sndLen - 1 - i] *= i / fade

  const buf = ctx.createBuffer(1, sndLen, sr)
  const d = buf.getChannelData(0)
  for (let i = 0; i < sndLen; i++) d[i] = kps2[i] * volfac
  ksCache.set(key, buf)
  return buf
}

function scheduleKarplus(ctx: BaseAudioContext, dest: AudioNode, n: ScheduledNote, t0: number) {
  const cfg = SYNTHS.l
  const freq = 440 * Math.pow(2, ((n.midi ?? 60) - 69) / 12 + (cfg.octaveShift ?? 0))
  const start = t0 + n.timeSec
  const src = ctx.createBufferSource()
  src.buffer = karplusBuffer(ctx, freq, Math.max(0.05, n.durSec))
  const g = ctx.createGain()
  // The buffer already carries the string's decay; the gain just sets level,
  // with a 2ms attack to avoid a click from the noise burst's first sample.
  const peak = cfg.gain * n.volume * 0.5
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(peak, start + 0.002)
  src.connect(g)
  g.connect(dest)
  src.start(start)
  src.stop(start + src.buffer.duration + 0.02)
}

// LuteBoi's percussion (pysynth_p) is filtered white noise, not a pitched tone:
// a noise burst through a gentle lowpass with a fast exponential ring-down
// (exp(-x/1000) ≈ 23ms time constant), gone by ~70ms. Pitch only set the burst
// length there, so we ignore it. A pitched triangle (the old SYNTHS.p) was the
// wrong primitive — no config could turn a harmonic tone into broadband noise.
export function scheduleNoisePerc(ctx: BaseAudioContext, dest: AudioNode, n: ScheduledNote, t0: number) {
  const start = t0 + n.timeSec
  const src = ctx.createBufferSource()
  src.buffer = getNoise(ctx)
  src.loop = true
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 5500 // ~the measured spectral centroid
  filter.Q.value = 0.7
  const g = ctx.createGain()
  const peak = n.volume * 0.6
  const tau = 0.023
  g.gain.setValueAtTime(peak, start)
  g.gain.exponentialRampToValueAtTime(Math.max(peak * Math.exp(-0.07 / tau), 0.0001), start + 0.07)
  g.gain.linearRampToValueAtTime(0, start + 0.085)
  src.connect(filter)
  filter.connect(g)
  g.connect(dest)
  src.start(start)
  src.stop(start + 0.1)
}

function noiseBurst(
  ctx: BaseAudioContext,
  dest: AudioNode,
  start: number,
  dur: number,
  vol: number,
  filterType: BiquadFilterType,
  freq: number,
  q = 1
) {
  const src = ctx.createBufferSource()
  src.buffer = getNoise(ctx)
  src.loop = true
  const filter = ctx.createBiquadFilter()
  filter.type = filterType
  filter.frequency.value = freq
  filter.Q.value = q
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(vol, start)
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur)
  src.connect(filter)
  filter.connect(gain)
  gain.connect(dest)
  src.start(start)
  src.stop(start + dur + 0.02)
}

function pitchedHit(
  ctx: BaseAudioContext,
  dest: AudioNode,
  start: number,
  dur: number,
  vol: number,
  freqFrom: number,
  freqTo: number,
  wave: OscillatorType = 'sine'
) {
  const osc = ctx.createOscillator()
  osc.type = wave
  osc.frequency.setValueAtTime(freqFrom, start)
  osc.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), start + dur)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(vol, start)
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur)
  osc.connect(gain)
  gain.connect(dest)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

export function scheduleDrum(ctx: BaseAudioContext, dest: AudioNode, n: ScheduledNote, t0: number) {
  const sound = DRUM_SOUNDS[n.drum ?? '']
  if (!sound) return
  const start = t0 + n.timeSec
  const v = n.volume * 0.5
  switch (sound.gen) {
    case 'kick':
      pitchedHit(ctx, dest, start, 0.18, v * 1.6, 130, 40)
      break
    case 'hollowkick':
      pitchedHit(ctx, dest, start, 0.28, v * 1.4, 90, 30)
      break
    case 'tom':
      pitchedHit(ctx, dest, start, 0.25, v * 1.2, (sound.freq ?? 120) * 1.4, sound.freq ?? 120)
      break
    case 'bongo':
      pitchedHit(ctx, dest, start, 0.12, v, (sound.freq ?? 220) * 1.2, sound.freq ?? 220)
      break
    case 'wood':
      pitchedHit(ctx, dest, start, 0.07, v, sound.freq ?? 700, (sound.freq ?? 700) * 0.9, 'triangle')
      break
    case 'rim':
      noiseBurst(ctx, dest, start, 0.04, v, 'bandpass', 2500, 4)
      pitchedHit(ctx, dest, start, 0.03, v * 0.6, 1700, 1500, 'triangle')
      break
    case 'snare':
      pitchedHit(ctx, dest, start, 0.1, v * 0.7, 220, 160)
      noiseBurst(ctx, dest, start, 0.16, v * 0.9, 'highpass', 1500)
      break
    case 'brush':
      noiseBurst(ctx, dest, start, 0.2, v * 0.6, 'highpass', 2500)
      break
    case 'clap':
      noiseBurst(ctx, dest, start, 0.02, v, 'bandpass', 1200, 2)
      noiseBurst(ctx, dest, start + 0.025, 0.12, v, 'bandpass', 1200, 2)
      break
    case 'hhclosed':
      noiseBurst(ctx, dest, start, 0.05, v * 0.7, 'highpass', 7000)
      break
    case 'hhopen':
      noiseBurst(ctx, dest, start, 0.35, v * 0.7, 'highpass', 7000)
      break
    case 'cymbal':
      noiseBurst(ctx, dest, start, 0.5, v * 0.5, 'highpass', 5000)
      break
    case 'crash':
      noiseBurst(ctx, dest, start, 1.1, v * 0.7, 'highpass', 4000)
      break
    case 'tambourine':
      noiseBurst(ctx, dest, start, 0.12, v * 0.6, 'bandpass', 6500, 2)
      break
    case 'triangle':
      pitchedHit(ctx, dest, start, 0.8, v * 0.5, sound.freq ?? 3500, sound.freq ?? 3500)
      break
    case 'cowbell':
      pitchedHit(ctx, dest, start, 0.18, v * 0.7, 800, 780, 'square')
      pitchedHit(ctx, dest, start, 0.18, v * 0.5, 540, 525, 'square')
      break
    case 'ding':
      pitchedHit(ctx, dest, start, 1.2, v * 0.6, 1860, 1850)
      break
  }
}

/**
 * Schedule one note into any context — the live preview or an offline
 * render: pan wrapper, sampled voice in Quality mode when its pack is
 * loaded, otherwise the matching synth path.
 */
export function scheduleNote(ctx: BaseAudioContext, master: AudioNode, n: ScheduledNote, t0: number) {
  let dest: AudioNode = master
  if (n.pan !== 0) {
    const pan = ctx.createStereoPanner()
    pan.pan.value = n.pan
    pan.connect(master)
    dest = pan
  }
  if (getPlaybackMode() === 'quality' && getBank(n.instrument) && scheduleSampled(ctx, dest, n, t0)) return
  if (n.drum) scheduleDrum(ctx, dest, n, t0)
  else if (n.instrument === 'l') scheduleKarplus(ctx, dest, n, t0)
  else if (n.instrument === 'p') scheduleNoisePerc(ctx, dest, n, t0)
  else scheduleMelodic(ctx, dest, n, t0)
}

export interface PlayHandle {
  stop: () => void
  durationSec: number
}

export interface PlayOptions {
  /** identifies who started playback, so UI buttons can show their own state */
  id?: string
  /** play only this voice index, with macros from all voices still resolving */
  soloVoice?: number
  /** start playback this many seconds into the luting */
  startAt?: number
  onEnded?: () => void
}

// ---- global volume --------------------------------------------------------

const VOL_KEY = 'luting-volume'
export const BASE_GAIN = 0.5

let masterVolume = (() => {
  try {
    const v = parseFloat(localStorage.getItem(VOL_KEY) ?? '')
    return isNaN(v) ? 0.8 : Math.min(1, Math.max(0, v))
  } catch {
    return 0.8
  }
})()

export const getMasterVolume = (): number => masterVolume

/** 0..1; applies live to whatever is currently playing */
export function setMasterVolume(v: number) {
  masterVolume = Math.min(1, Math.max(0, v))
  try {
    localStorage.setItem(VOL_KEY, String(masterVolume))
  } catch {
    // preference just won't persist
  }
  if (active) {
    active.master.gain.setTargetAtTime(BASE_GAIN * masterVolume, active.ctx.currentTime, 0.02)
  }
}

let active: {
  ctx: AudioContext
  timer: number
  pump: number
  id: string
  t0: number
  startAt: number
  total: number
  master: GainNode
} | null = null
const listeners = new Set<() => void>()

export const getActivePlaybackId = (): string | null => active?.id ?? null

export interface PlaybackInfo {
  id: string
  position: number
  duration: number
}

/** Current playback position, for the timeline playhead. */
export function getPlaybackInfo(): PlaybackInfo | null {
  if (!active) return null
  const elapsed = active.ctx.currentTime - active.t0
  return {
    id: active.id,
    position: Math.max(active.startAt, Math.min(active.startAt + elapsed, active.total)),
    duration: active.total,
  }
}

export function subscribePlayback(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

const notify = () => {
  for (const cb of [...listeners]) cb()
}

export function stopPlayback() {
  if (active) {
    window.clearTimeout(active.timer)
    window.clearInterval(active.pump)
    void active.ctx.close()
    active = null
    notify()
  }
}

export function playLuting(text: string, opts: PlayOptions = {}): PlayHandle {
  stopPlayback()
  const { notes, durationSec } = parseLuting(text, { soloVoice: opts.soloVoice })
  const startAt = Math.max(0, Math.min(opts.startAt ?? 0, durationSec))
  const ctx = new AudioContext()
  const master = ctx.createGain()
  master.gain.value = BASE_GAIN * masterVolume
  const comp = ctx.createDynamicsCompressor()
  master.connect(comp)
  comp.connect(ctx.destination)

  const t0 = ctx.currentTime + 0.08

  // Clip the schedule to the seek point and sort it.
  const queue: ScheduledNote[] = []
  for (const n of notes) {
    const end = n.timeSec + n.durSec
    if (end <= startAt + 0.005) continue
    if (n.drum && n.timeSec < startAt) continue // don't re-fire half-played drums
    // a melodic note already sounding at the seek point plays its remainder
    queue.push(
      n.timeSec < startAt ? { ...n, timeSec: 0, durSec: end - startAt } : { ...n, timeSec: n.timeSec - startAt }
    )
  }
  queue.sort((a, b) => a.timeSec - b.timeSec)

  // In Quality mode, make sure the packs for every instrument in this luting
  // are loading. The rolling window re-checks getBank each tick, so a pack that
  // finishes mid-playback upgrades the rest of the notes from synth to samples.
  if (getPlaybackMode() === 'quality') {
    for (const code of new Set(queue.map((n) => n.instrument))) void loadBank(code)
  }

  // Schedule just-in-time in a rolling window. Creating every node upfront
  // chokes the audio thread on big songs (thousands of notes); a window keeps
  // the live node count bounded no matter how long the luting is.
  const AHEAD_SEC = 8
  let idx = 0
  const scheduleWindow = () => {
    const limit = ctx.currentTime - t0 + AHEAD_SEC
    while (idx < queue.length && queue[idx].timeSec <= limit) {
      scheduleNote(ctx, master, queue[idx++], t0)
    }
  }
  scheduleWindow()
  const pump = window.setInterval(scheduleWindow, 2000)

  const timer = window.setTimeout(() => {
    stopPlayback()
    opts.onEnded?.()
  }, (durationSec - startAt + 1.5) * 1000)
  active = { ctx, timer, pump, id: opts.id ?? 'main', t0, startAt, total: durationSec, master }
  notify()
  return { stop: stopPlayback, durationSec }
}

/**
 * Quick audition for the instrument palette. Toggles off when already playing.
 * In Quality mode it waits for the instrument's sample pack to load first, so
 * the audition always uses the real sample (the caller can show a spinner
 * while the returned promise is pending).
 */
export async function previewInstrument(code: string): Promise<void> {
  const id = `instrument:${code}`
  if (getActivePlaybackId() === id) {
    stopPlayback()
    return
  }
  if (getPlaybackMode() === 'quality') {
    await loadBank(code) // resolves instantly if cached or synth-only
    // a newer click may have superseded this one while the pack downloaded
    if (getActivePlaybackId() === id) return
  }
  const text = code === 'd' ? '#lute 240 ido0ao3co4co3c' : `#lute 480 i${code}t2ceg(ceg)4`
  playLuting(text, { id })
}
