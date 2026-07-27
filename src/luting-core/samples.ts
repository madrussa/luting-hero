// Real-sample playback, converted from LuteBoi's recorded multisample banks
// (see tools/convert-samples.py). Packs are lazy-loaded per instrument and
// decoded once; the engine pitch-shifts from the nearest sampled note and
// ping-pong-loops the sustain region for long notes. Lute/Bass/Chiptune/
// Percussion have no packs — LuteBoi synthesizes them too, so they always use
// our synth.

import type { ScheduledNote } from './luting'

export type PlaybackMode = 'performance' | 'quality'

const MODE_KEY = 'luting-playback-mode'

let mode: PlaybackMode = (() => {
  try {
    return localStorage.getItem(MODE_KEY) === 'quality' ? 'quality' : 'performance'
  } catch {
    return 'performance'
  }
})()

const modeSubs = new Set<() => void>()
const notifyMode = () => modeSubs.forEach((cb) => cb())

export const getPlaybackMode = (): PlaybackMode => mode
export function setPlaybackMode(m: PlaybackMode) {
  mode = m
  try {
    localStorage.setItem(MODE_KEY, m)
  } catch {
    /* preference won't persist */
  }
  notifyMode()
}
export function subscribePlaybackMode(cb: () => void): () => void {
  modeSubs.add(cb)
  return () => modeSubs.delete(cb)
}

// ---- bank loading ----------------------------------------------------------

interface MelodicSample {
  midi: number
  buffer: AudioBuffer
  /** ping-pong loop region (seconds), baked at decode time; only used if the bank loops */
  loopStart: number
  loopEnd: number
}

interface Bank {
  loop: boolean
  /** melodic notes, ascending by MIDI */
  melodic: MelodicSample[]
  /** drum sounds keyed by our DRUM_SOUNDS key (o0a, o3c, …) */
  drums: Record<string, AudioBuffer>
}

const banks = new Map<string, Bank>()
const inflight = new Map<string, Promise<Bank | null>>()
let indexPromise: Promise<Set<string>> | null = null

const loadSubs = new Set<() => void>()
const notifyLoad = () => loadSubs.forEach((cb) => cb())
export function subscribeSampleLoading(cb: () => void): () => void {
  loadSubs.add(cb)
  return () => loadSubs.delete(cb)
}
export const isLoadingSamples = (): boolean => inflight.size > 0

const base = import.meta.env.BASE_URL || './'

// A persistent context just for decoding; AudioBuffers are reusable across the
// short-lived playback contexts.
let decodeCtx: AudioContext | null = null
const getDecodeCtx = (): AudioContext => (decodeCtx ??= new AudioContext())

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

/**
 * Bake a ping-pong sustain loop into a decoded sample. A native
 * AudioBufferSourceNode only loops forward, so the obvious approach — loop a
 * fixed slice [loopStart, loopEnd) — jumps the playhead back to loopStart every
 * pass. Even crossfaded clean of clicks, that *resets* the amplitude level each
 * loop (the slice's tail is quieter than its head), so the loudness sawtooths
 * with a constructive-overlap spike every loop period — an audible ~0.75s
 * throb. Instead we build a longer buffer whose loop region is the slice played
 * forward then in reverse; looping *that* forward retraces the contour up and
 * back down, so the amplitude swells smoothly (a triangle, no reset). The two
 * velocity-reversal turning points would leave a slope corner that pops, so we
 * round each over ±W samples (raised cosine) — continuous in value AND slope.
 * Returns a NEW buffer (ping-pong can't be done in place) plus loop points; the
 * intro [0, loopStart) plays once, then [loopStart, end) ping-pongs forever.
 */
function bakePingpong(
  ctx: BaseAudioContext,
  buf: AudioBuffer
): { buffer: AudioBuffer; loopStart: number; loopEnd: number } {
  const sr = buf.sampleRate
  const len = buf.length
  // Ping-pong a stable slice of the sustain: clear of the attack and decay tail.
  const loopStart = Math.floor(len * 0.3)
  const loopEnd = Math.floor(len * 0.85)
  const L = loopEnd - loopStart // forward run length
  const P = 2 * L - 2 // ping-pong period (forward + reverse, shared endpoints dropped)
  const W = Math.min(Math.floor(sr * 0.008), L - 2) // 8ms turn-smoothing half-width
  const outLen = loopStart + P
  const out = ctx.createBuffer(buf.numberOfChannels, outLen, sr)
  const at = (d: Float32Array, i: number) => d[Math.max(0, Math.min(len - 1, i))]

  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch)
    const o = out.getChannelData(ch)
    for (let i = 0; i < loopStart; i++) o[i] = d[i] // intro, plays once
    for (let j = 0; j < L; j++) o[loopStart + j] = d[loopStart + j] // forward run
    for (let m = 1; m <= L - 2; m++) o[loopStart + L - 1 + m] = d[loopEnd - 1 - m] // reverse run

    // Round a turning point: the apex value is already continuous (it's a
    // mirror), so we blend the incoming stream into the outgoing one across the
    // window to make the slope continuous too, killing the corner pop.
    const smooth = (apexRegionIdx: number, apexBufIdx: number, incomingForward: boolean) => {
      for (let delta = -W; delta <= W; delta++) {
        const wt = 0.5 * (1 - Math.cos((Math.PI * (delta + W)) / (2 * W))) // 0→1, 0.5 at apex
        const pin = incomingForward ? at(d, apexBufIdx + delta) : at(d, apexBufIdx - delta)
        const pout = incomingForward ? at(d, apexBufIdx - delta) : at(d, apexBufIdx + delta)
        const idx = loopStart + (((apexRegionIdx + delta) % P) + P) % P
        o[idx] = (1 - wt) * pin + wt * pout
      }
    }
    smooth(L - 1, loopEnd - 1, true) // forward → reverse turn
    smooth(0, loopStart, false) // reverse → forward wrap turn
  }
  return { buffer: out, loopStart: loopStart / sr, loopEnd: outLen / sr }
}

function ensureIndex(): Promise<Set<string>> {
  if (!indexPromise) {
    indexPromise = fetch(`${base}samples/index.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((arr: string[]) => new Set(arr))
      .catch(() => new Set<string>())
  }
  return indexPromise
}

export async function hasSamplePack(code: string): Promise<boolean> {
  return (await ensureIndex()).has(code)
}

/** A loaded bank, if present in memory (synchronous; null if not yet loaded). */
export const getBank = (code: string): Bank | undefined => banks.get(code)

/** Lazily fetch + decode an instrument pack. Deduped; cached. */
export function loadBank(code: string): Promise<Bank | null> {
  if (banks.has(code)) return Promise.resolve(banks.get(code)!)
  const existing = inflight.get(code)
  if (existing) return existing

  const p = (async (): Promise<Bank | null> => {
    if (!(await hasSamplePack(code))) return null
    const res = await fetch(`${base}samples/${code}.json`)
    if (!res.ok) return null
    const pack = (await res.json()) as { loop: boolean; notes: Record<string, string> }
    const ctx = getDecodeCtx()
    const melodic: Bank['melodic'] = []
    const drums: Bank['drums'] = {}
    await Promise.all(
      Object.entries(pack.notes).map(async ([key, b64]) => {
        try {
          const buf = await ctx.decodeAudioData(b64ToArrayBuffer(b64))
          if (/^\d+$/.test(key)) {
            if (pack.loop) {
              const { buffer, loopStart, loopEnd } = bakePingpong(ctx, buf)
              melodic.push({ midi: parseInt(key, 10), buffer, loopStart, loopEnd })
            } else {
              melodic.push({ midi: parseInt(key, 10), buffer: buf, loopStart: 0, loopEnd: 0 })
            }
          } else drums[key] = buf
        } catch {
          /* skip a note that won't decode */
        }
      })
    )
    melodic.sort((a, b) => a.midi - b.midi)
    const bank: Bank = { loop: pack.loop, melodic, drums }
    banks.set(code, bank)
    return bank
  })()
    .catch(() => null)
    .finally(() => {
      inflight.delete(code)
      notifyLoad()
    })

  inflight.set(code, p)
  notifyLoad()
  return p
}

/** Kick off loading for a set of instrument codes (fire and forget). */
export function prewarm(codes: Iterable<string>) {
  for (const c of new Set(codes)) void loadBank(c)
}

// ---- scheduling ------------------------------------------------------------

const RELEASE = 0.08

// LuteBoi's note-end envelope, applied uniformly to every sampled voice (it's
// not per-instrument there): hold the sample's own level until LEG_STAC of the
// note, then ring down with a fixed time constant over the remaining tail. The
// held sustain — the drone — is intentional and true to LuteBoi; short notes
// barely decay, long notes hold then ring out. Mirrors render2's
// `note[dec_ind:] *= exp(-arange/3000)` with dec_ind = leg_stac * length.
const LEG_STAC = 0.9
const DECAY_TAU = 3000 / 44100 // ≈68ms, LuteBoi's exp(-n/3000) at 44.1kHz

/**
 * Schedule a note from real samples. Returns false if no sample is available
 * (so the caller can fall back to the synth).
 */
export function scheduleSampled(ctx: BaseAudioContext, dest: AudioNode, n: ScheduledNote, t0: number): boolean {
  const bank = banks.get(n.instrument)
  if (!bank) return false
  const start = t0 + n.timeSec

  if (n.drum) {
    const buffer = bank.drums[n.drum]
    if (!buffer) return false
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const g = ctx.createGain()
    g.gain.value = n.volume * 0.9
    src.connect(g)
    g.connect(dest)
    src.start(start)
    src.stop(start + buffer.duration + 0.02)
    return true
  }

  const list = bank.melodic
  if (!list.length || n.midi === undefined) return false
  let best = list[0]
  for (const e of list) if (Math.abs(e.midi - n.midi) < Math.abs(best.midi - n.midi)) best = e

  const src = ctx.createBufferSource()
  src.buffer = best.buffer
  src.playbackRate.value = Math.pow(2, (n.midi - best.midi) / 12)

  const holdEnd = start + Math.max(0.03, n.durSec)
  const effectiveDur = best.buffer.duration / src.playbackRate.value
  if (bank.loop && effectiveDur < n.durSec + RELEASE) {
    src.loop = true
    src.loopStart = best.loopStart
    src.loopEnd = best.loopEnd
  }

  const g = ctx.createGain()
  const peak = n.volume * 0.8
  const attackEnd = start + 0.005
  // Hold flat until LEG_STAC of the note (the sample's own envelope shows
  // through — a held drone for sustained voices), then ring down with a fixed
  // ~68ms time constant over the last tail, like LuteBoi. Anchoring the decay's
  // target by that time constant (rather than letting the ramp stretch to fit)
  // keeps the ring-down sharp on long notes and barely-there on short ones.
  const decAt = Math.max(attackEnd, start + LEG_STAC * Math.max(0.03, n.durSec))
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(peak, attackEnd)
  if (peak > 0.0001) {
    g.gain.setValueAtTime(peak, decAt)
    const target = peak * Math.exp(-(holdEnd - decAt) / DECAY_TAU)
    g.gain.exponentialRampToValueAtTime(Math.max(target, 0.00001), holdEnd)
  } else {
    g.gain.setValueAtTime(peak, holdEnd)
  }
  g.gain.linearRampToValueAtTime(0, holdEnd + RELEASE)
  src.connect(g)
  g.connect(dest)
  src.start(start)
  src.stop(holdEnd + RELEASE + 0.02)
  return true
}
