// The band you're playing with.
//
// Everything you didn't pick keeps playing behind you, and until now it was
// audible but invisible — which makes the long stretches where your part rests
// feel like the game has stopped. So each backing instrument gets a colour and
// a place in the scene, and its notes drive it.
//
// This module is the bridge: it turns a chart plus your chosen instrument into
// the list of voices to light up and a time-sorted stream of pulses to light
// them with. It knows nothing about how they're drawn.

import { instrumentByCode } from '../luting-core/luting'
import type { Chart } from './chart'

/**
 * Colours are assigned per song, by position in that song's own backing list,
 * rather than fixed per instrument. A song with three backing voices then gets
 * three maximally distinct colours instead of whichever three the global table
 * happened to put next to each other. All of them are bright enough to read on
 * the dark playfield and sit in the app's purple/mint/coral family.
 */
export const BACKING_COLORS = [
  '#9d7bff', // accent purple
  '#5ad1b3', // accent mint
  '#ff7a90', // coral
  '#ffc266', // amber
  '#6fb1ff', // sky
  '#d67bff', // magenta
  '#7bffcf', // aqua
  '#ffa07b', // peach
]

export interface BackingVoice {
  instrument: string
  name: string
  icon: string
  color: string
  /** how many notes it plays, so the quiet ones can sit further out */
  noteCount: number
}

export interface BackingPulse {
  timeSec: number
  /** index into the voices array */
  voice: number
  /** 0..1 */
  volume: number
  /** drums drive the wider flashes; pitched notes drive their own pillar */
  drum: boolean
}

export interface Backing {
  voices: BackingVoice[]
  /** every backing note, time-sorted, ready for a single forward cursor */
  pulses: BackingPulse[]
  /** one activity envelope per voice, for the scrolling side waves */
  envelopes: Envelope[]
}

/** Samples per second in an activity envelope. */
export const ENVELOPE_HZ = 24

/** A voice's activity over the whole song, sampled on a fixed grid. */
export interface Envelope {
  /** 0..1 per bin */
  data: Float32Array
  hz: number
}

/**
 * Turn one voice's notes into a continuous 0..1 activity curve.
 *
 * The waves are there to answer "is this instrument playing, and is it about
 * to?", so the curve is normalised per voice against its own busiest moment
 * rather than against the mix. A quiet triangle part gets a wave as tall as the
 * bass's — what matters is that it's *doing something*, not how loud it is.
 *
 * Each note leaves a short rise and a longer fall, and a little of it bleeds
 * backwards in time so a wave visibly swells into a phrase instead of snapping
 * on at the first note.
 */
export function buildEnvelope(
  pulses: BackingPulse[],
  voice: number,
  durationSec: number,
  hz = ENVELOPE_HZ
): Envelope {
  const bins = Math.max(1, Math.ceil((durationSec + 2) * hz))
  const data = new Float32Array(bins)
  for (const p of pulses) {
    if (p.voice !== voice) continue
    const i = Math.min(bins - 1, Math.max(0, Math.round(p.timeSec * hz)))
    data[i] += 0.4 + 0.6 * p.volume
  }

  // Fall: each bin keeps some of the previous one, so a note rings on.
  const fall = Math.exp(-1 / (0.34 * hz))
  for (let i = 1; i < bins; i++) data[i] = Math.max(data[i], data[i - 1] * fall)
  // Rise: a shorter bleed backwards, so the wave leans into the phrase.
  const rise = Math.exp(-1 / (0.12 * hz))
  for (let i = bins - 2; i >= 0; i--) data[i] = Math.max(data[i], data[i + 1] * rise)

  let peak = 0
  for (let i = 0; i < bins; i++) peak = Math.max(peak, data[i])
  if (peak > 0) for (let i = 0; i < bins; i++) data[i] = Math.min(1, data[i] / peak)

  return { data, hz }
}

/** Read an envelope at a song time, interpolating between bins. */
export function sampleEnvelope(env: Envelope, timeSec: number): number {
  if (timeSec < 0) return 0
  const x = timeSec * env.hz
  const i = Math.floor(x)
  if (i < 0 || i >= env.data.length - 1) {
    return i >= 0 && i < env.data.length ? env.data[i] : 0
  }
  const f = x - i
  return env.data[i] * (1 - f) + env.data[i + 1] * f
}

/**
 * Split a chart into the voices behind the player and the pulses that animate
 * them. Voices are ordered busiest-first so the instrument carrying the song
 * gets the first colour and the nearest position, and a two-note triangle part
 * ends up out at the edge where it belongs.
 */
export function buildBacking(chart: Chart, playing: string): Backing {
  const counts = new Map<string, number>()
  for (const n of chart.allNotes) {
    if (n.instrument === playing) continue
    counts.set(n.instrument, (counts.get(n.instrument) ?? 0) + 1)
  }

  const voices: BackingVoice[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, noteCount], i) => ({
      instrument: code,
      name: instrumentByCode(code)?.name ?? 'Voice',
      icon: instrumentByCode(code)?.icon ?? '🎵',
      color: BACKING_COLORS[i % BACKING_COLORS.length],
      noteCount,
    }))

  const index = new Map(voices.map((v, i) => [v.instrument, i]))
  const pulses: BackingPulse[] = []
  for (const n of chart.allNotes) {
    if (n.instrument === playing) continue
    const voice = index.get(n.instrument)
    if (voice === undefined) continue
    pulses.push({ timeSec: n.timeSec, voice, volume: n.volume, drum: !!n.drum })
  }
  pulses.sort((a, b) => a.timeSec - b.timeSec)

  const envelopes = voices.map((_, i) => buildEnvelope(pulses, i, chart.durationSec))

  return { voices, pulses, envelopes }
}
