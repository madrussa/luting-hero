// The input router, exercised through the *MIDI* path in particular.
//
// A hardware controller is the one input I can't click on in a browser, so it
// gets the coverage instead. These drive the vendored midi.ts simulator, which
// dispatches through exactly the same `subscribeMidiNotes` fan-out that a real
// MIDIInput message does — so a note here takes the same route to the router,
// the judge and the key lighting as a note off a keyboard.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The router attaches window/document listeners for the computer keyboard, and
// vitest runs in Node. A couple of stubs are cheaper than a whole DOM.
const listeners = new Map<string, Set<EventListener>>()
vi.stubGlobal('window', {
  addEventListener: (t: string, fn: EventListener) => {
    if (!listeners.has(t)) listeners.set(t, new Set())
    listeners.get(t)!.add(fn)
  },
  removeEventListener: (t: string, fn: EventListener) => listeners.get(t)?.delete(fn),
})
vi.stubGlobal('document', { activeElement: null })

const { InputRouter, LaneMap } = await import('./input')
const { setSimActive, simNote, setMidiInput, resetMirrorState } = await import('../luting-core/midi')
const { keyboardSlots } = await import('./lanes')
const { buildEasyMap } = await import('./easy')
import type { PlayEvent } from './input'
import type { EasyMap } from './easy'
import type { GameNote, Track } from './chart'

function melodicTrack(midis: number[]): Track {
  return {
    instrument: 'k',
    name: 'Keyboard',
    icon: '🎹',
    notes: midis.map((midi, id): GameNote => ({ id, timeSec: id, durSec: 0.2, midi, volume: 1, voice: 0 })),
    voices: [0],
    isDrums: false,
    lowMidi: Math.min(...midis),
    highMidi: Math.max(...midis),
    pitches: [...new Set(midis)].sort((a, b) => a - b),
    drums: [],
    difficulty: { rating: 1, label: '', nps: 0, peakNps: 0, maxChord: 0, span: 0, keys: 0 },
  }
}

function drumTrack(drums: string[]): Track {
  return {
    ...melodicTrack([60]),
    instrument: 'd',
    name: 'Drumkit',
    isDrums: true,
    drums,
    notes: drums.map((drum, id): GameNote => ({ id, timeSec: id, durSec: 0.2, drum, volume: 1, voice: 0 })),
  }
}

/**
 * Spin up a router over a track and collect everything it emits. `easy` folds
 * the track first, exactly as the game does, so the router and the lane map see
 * the same keyboard the player would.
 */
function harness(track: Track, baseMidi = 60, easy: EasyMap | null = null) {
  const events: PlayEvent[] = []
  const lanes = new LaneMap(track, easy)
  const router = new InputRouter({
    lanes,
    track,
    keyboardBaseMidi: baseMidi,
    slots: keyboardSlots(track, easy ? 'easy' : 'impossible', easy),
    onPlay: (e) => events.push(e),
  })
  return { router, events, lanes }
}

/** Fire a computer-keyboard event at whatever the router has listening. */
function typeKey(key: string, kind: 'keydown' | 'keyup' = 'keydown') {
  const ev = { key, repeat: false, preventDefault: () => {} } as KeyboardEvent
  for (const fn of listeners.get(kind) ?? []) fn(ev)
}

beforeEach(() => {
  resetMirrorState()
  setMidiInput('all')
  setSimActive(true)
})
afterEach(() => {
  setSimActive(false)
  listeners.clear()
})

describe('MIDI input', () => {
  it('turns a MIDI note into a play event on the matching lane', () => {
    const { router, events } = harness(melodicTrack([60, 64, 67]))
    simNote('on', 64, 0.8)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'on', lane: 64, midi: 64, source: 'midi' })
    expect(events[0].velocity).toBeCloseTo(0.8, 5)
    router.dispose()
  })

  it('marks the lane held, so the on-screen key lights up, until note-off', () => {
    const { router } = harness(melodicTrack([60]))
    simNote('on', 60, 0.9)
    expect(router.held.has(60)).toBe(true)
    simNote('off', 60, 0)
    expect(router.held.has(60)).toBe(false)
    router.dispose()
  })

  it('notifies subscribers when the held set changes', () => {
    const { router } = harness(melodicTrack([60]))
    const seen: number[] = []
    router.subscribeHeld(() => seen.push(router.held.size))
    simNote('on', 60, 0.9)
    simNote('off', 60, 0)
    expect(seen).toEqual([1, 0])
    router.dispose()
  })

  it('carries velocity through, so a soft touch plays softly', () => {
    const { router, events } = harness(melodicTrack([60]))
    simNote('on', 60, 0.2)
    expect(events[0].velocity).toBeCloseTo(0.2, 5)
    router.dispose()
  })

  it('applies the transpose to hardware notes', () => {
    const { router, events } = harness(melodicTrack([60]))
    router.setTranspose(12)
    simNote('on', 48, 0.8) // an octave low on the controller
    expect(events[0].lane).toBe(60)
    router.dispose()
  })

  it('releases anything held when the transpose moves', () => {
    // Otherwise the held note's off arrives at the new pitch and strands a voice.
    const { router, events } = harness(melodicTrack([60]))
    simNote('on', 60, 0.8)
    router.setTranspose(12)
    expect(router.held.size).toBe(0)
    expect(events[events.length - 1]).toMatchObject({ kind: 'off', lane: 60 })
    router.dispose()
  })

  it('reports a press with no lane so it can be judged a wrong note', () => {
    const { router, events } = harness(drumTrack(['o0a', 'o3c']))
    simNote('on', 49, 0.8) // GM crash — not in this song's two-piece kit
    expect(events).toHaveLength(1)
    expect(events[0].lane).toBe(-1)
    router.dispose()
  })

  it('does not emit a second note-on for a key already sounding', () => {
    const { router, events } = harness(melodicTrack([60]))
    simNote('on', 60, 0.8)
    simNote('on', 60, 0.8)
    expect(events.filter((e) => e.kind === 'on')).toHaveLength(1)
    router.dispose()
  })

  it('stops listening once disposed', () => {
    const { router, events } = harness(melodicTrack([60]))
    router.dispose()
    simNote('on', 60, 0.8)
    expect(events).toHaveLength(0)
  })

  it('releases held notes on dispose, so nothing is left sounding', () => {
    const { router, events } = harness(melodicTrack([60]))
    simNote('on', 60, 0.8)
    router.dispose()
    expect(events[events.length - 1]).toMatchObject({ kind: 'off', lane: 60 })
  })
})

describe('drum lanes', () => {
  it('maps GM percussion onto the song’s own kit positions', () => {
    const { router, events } = harness(drumTrack(['o0a', 'o3c', 'o4c']))
    simNote('on', 36, 0.9) // GM bass drum -> kick -> lane 0
    simNote('on', 38, 0.9) // GM acoustic snare -> lane 1
    simNote('on', 42, 0.9) // GM closed hi-hat -> lane 2
    expect(events.map((e) => e.lane)).toEqual([0, 1, 2])
    expect(events.map((e) => e.drum)).toEqual(['o0a', 'o3c', 'o4c'])
    router.dispose()
  })

  it('ignores the transpose on a kit, where pitch means nothing', () => {
    const { router, events } = harness(drumTrack(['o0a', 'o3c']))
    router.setTranspose(12)
    simNote('on', 36, 0.9)
    expect(events[0].lane).toBe(0)
    router.dispose()
  })
})

describe('lane mapping', () => {
  it('uses the pitch itself as the lane for a melodic track', () => {
    const lanes = new LaneMap(melodicTrack([60, 62]))
    expect(lanes.laneOfNote({ midi: 62 })).toBe(62)
    expect(lanes.laneOfMidi(62)).toBe(62)
    expect(lanes.soundFor(62)).toEqual({ midi: 62 })
  })

  it('uses kit position for a drum track, ordered low to high', () => {
    const lanes = new LaneMap(drumTrack(['o0a', 'o3c', 'o5d']))
    expect(lanes.laneOfNote({ drum: 'o3c' })).toBe(1)
    expect(lanes.soundFor(2)).toEqual({ drum: 'o5d' })
    expect(lanes.laneOfMidi(49)).toBe(2) // GM crash -> o5d
    expect(lanes.laneOfMidi(60)).toBe(-1) // hi bongo: not in this kit
  })
})

describe('the folded keyboard', () => {
  /** Twelve pitches, so the fold has to do something to reach eight keys. */
  const wide = () => melodicTrack([48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67])

  it('puts a note on the key its pitch folded onto', () => {
    const track = wide()
    const easy = buildEasyMap(track)
    const lanes = new LaneMap(track, easy)
    expect(easy.keys.length).toBe(8)
    for (const midi of track.pitches) {
      const lane = lanes.laneOfNote({ midi })
      expect(easy.keys[lane].midis).toContain(midi)
    }
  })

  it('sends a MIDI note to the key its pitch belongs to, however far out', () => {
    const track = wide()
    const easy = buildEasyMap(track)
    const { router, events } = harness(track, 60, easy)
    simNote('on', track.pitches[0], 0.8)
    simNote('off', track.pitches[0], 0)
    // A controller an octave below the part has nowhere exact to land, but the
    // key the music is heading for beats no key at all.
    simNote('on', 36, 0.8)
    simNote('off', 36, 0)
    simNote('on', 127, 0.8)
    const struck = events.filter((e) => e.kind === 'on').map((e) => e.lane)
    expect(struck).toEqual([0, 0, easy.keys.length - 1])
    router.dispose()
  })

  it('sounds a folded key as the pitch it plays most', () => {
    // The lane is a position now, so the lane number is not a pitch: without
    // this the instrument would answer a press with note 3.
    const track = wide()
    const easy = buildEasyMap(track)
    const lanes = new LaneMap(track, easy)
    const sound = lanes.soundFor(3)
    expect(easy.keys[3].midis).toContain(sound.midi)
  })

  it('binds the computer keys by position, with no octave to shift', () => {
    const track = wide()
    const easy = buildEasyMap(track)
    const { router, events } = harness(track, 60, easy)
    typeKey('a') // the first positional binding
    expect(events[0].lane).toBe(0)
    // Nothing to shift: the keys already name the part's own keys, so the arrow
    // keys and the HUD buttons can't strand the player on a range they can't
    // reach back from.
    router.shiftOctave(12)
    typeKey('a', 'keyup')
    typeKey('a')
    expect(events[events.length - 1].lane).toBe(0)
    router.dispose()
  })

  it('folds a kit by piece, keeping the kick leftmost', () => {
    // Ten pieces is two more than the eight pads easy mode will draw.
    const kit = drumTrack(['o0a', 'o0b', 'o1c', 'o1d', 'o2c', 'o3c', 'o3d', 'o4c', 'o4a', 'o5d'])
    const easy = buildEasyMap(kit)
    const lanes = new LaneMap(kit, easy)
    expect(easy.keys.length).toBe(8)
    expect(easy.keys[0].drums[0]).toBe('o0a')
    expect(lanes.laneOfNote({ drum: 'o0a' })).toBe(0)
    // and a GM note still finds its pad through the fold
    expect(lanes.laneOfMidi(36)).toBe(0)
  })
})
