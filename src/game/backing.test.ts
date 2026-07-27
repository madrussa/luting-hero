import { describe, it, expect } from 'vitest'
import { buildBacking, buildEnvelope, sampleEnvelope, BACKING_COLORS } from './backing'
import type { BackingPulse } from './backing'
import { buildChart } from './chart'

const pulse = (timeSec: number, voice = 0, volume = 1, drum = false): BackingPulse => ({
  timeSec, voice, volume, drum,
})

describe('buildBacking', () => {
  const chart = buildChart('#lute 240 ilccccc|ibo2cc|ifo5c')

  it('leaves out the instrument you are playing', () => {
    const b = buildBacking(chart, 'l')
    expect(b.voices.map((v) => v.instrument)).not.toContain('l')
    expect(b.pulses.every((p) => p.timeSec >= 0)).toBe(true)
  })

  it('orders voices busiest first, so the loudest part sits nearest', () => {
    const b = buildBacking(chart, 'f')
    expect(b.voices.map((v) => v.instrument)).toEqual(['l', 'b'])
    expect(b.voices[0].noteCount).toBeGreaterThan(b.voices[1].noteCount)
  })

  it('gives each voice a distinct colour', () => {
    const b = buildBacking(chart, 'f')
    const colors = b.voices.map((v) => v.color)
    expect(new Set(colors).size).toBe(colors.length)
    expect(colors[0]).toBe(BACKING_COLORS[0])
  })

  it('emits time-sorted pulses, one per backing note', () => {
    const b = buildBacking(chart, 'f')
    const backingNotes = chart.allNotes.filter((n) => n.instrument !== 'f')
    expect(b.pulses).toHaveLength(backingNotes.length)
    for (let i = 1; i < b.pulses.length; i++) {
      expect(b.pulses[i].timeSec).toBeGreaterThanOrEqual(b.pulses[i - 1].timeSec)
    }
  })

  it('builds one envelope per voice', () => {
    const b = buildBacking(chart, 'f')
    expect(b.envelopes).toHaveLength(b.voices.length)
  })

  it('copes with a solo luting, where nothing plays behind you', () => {
    const solo = buildChart('#lute 240 ilccc')
    const b = buildBacking(solo, 'l')
    expect(b.voices).toEqual([])
    expect(b.pulses).toEqual([])
    expect(b.envelopes).toEqual([])
  })
})

describe('buildEnvelope', () => {
  it('rises where the instrument plays and is flat where it rests', () => {
    // busy for the first two seconds, silent for the next four
    const pulses = Array.from({ length: 16 }, (_, i) => pulse(i * 0.125))
    const env = buildEnvelope(pulses, 0, 6)
    expect(sampleEnvelope(env, 1)).toBeGreaterThan(0.8)
    expect(sampleEnvelope(env, 5)).toBeLessThan(0.05)
  })

  it('leans into a phrase, so the wave swells before the first note lands', () => {
    // This is the whole point of the side waves: you should see a section
    // coming, not have it snap on at the downbeat.
    const env = buildEnvelope([pulse(3)], 0, 6)
    expect(sampleEnvelope(env, 2.95)).toBeGreaterThan(0.3)
    expect(sampleEnvelope(env, 2.5)).toBeLessThan(sampleEnvelope(env, 2.9))
  })

  it('rings on after a note rather than cutting out', () => {
    const env = buildEnvelope([pulse(1)], 0, 6)
    expect(sampleEnvelope(env, 1.2)).toBeGreaterThan(0.3)
    expect(sampleEnvelope(env, 3)).toBeLessThan(sampleEnvelope(env, 1.2))
  })

  it('normalises per voice, so a quiet part still shows a full wave', () => {
    const loud = buildEnvelope([pulse(1, 0, 1)], 0, 4)
    const quiet = buildEnvelope([pulse(1, 0, 0.1)], 0, 4)
    expect(sampleEnvelope(loud, 1)).toBeCloseTo(1, 5)
    expect(sampleEnvelope(quiet, 1)).toBeCloseTo(1, 5)
  })

  it('only counts its own voice', () => {
    const env = buildEnvelope([pulse(1, 0), pulse(3, 1)], 0, 6)
    expect(sampleEnvelope(env, 1)).toBeGreaterThan(0.5)
    expect(sampleEnvelope(env, 3.4)).toBeLessThan(0.2)
  })

  it('stays in 0..1 everywhere, including on a dense chord', () => {
    const stacked = [pulse(1), pulse(1), pulse(1), pulse(1), pulse(2)]
    const env = buildEnvelope(stacked, 0, 4)
    for (const v of env.data) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('handles a voice that never plays', () => {
    const env = buildEnvelope([], 0, 4)
    expect(sampleEnvelope(env, 2)).toBe(0)
  })
})

describe('sampleEnvelope', () => {
  it('interpolates between bins', () => {
    const env = { data: new Float32Array([0, 1]), hz: 1 }
    expect(sampleEnvelope(env, 0.5)).toBeCloseTo(0.5, 5)
  })

  it('reads zero before the song and past the end', () => {
    const env = { data: new Float32Array([1, 1]), hz: 1 }
    expect(sampleEnvelope(env, -1)).toBe(0)
    expect(sampleEnvelope(env, 99)).toBe(0)
  })
})
