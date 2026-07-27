// One event stream for every way of playing: a hardware MIDI controller, the
// on-screen instrument, or the computer keyboard.
//
// Whatever the source, a press arrives as a lane plus what to sound. Lanes are
// the game's coordinate system — for a melodic track a lane *is* the MIDI note,
// for a kit track it's an index into the drums the song actually uses — so the
// judge, the highway and the on-screen instrument all agree without any of them
// knowing where the press came from.

import { subscribeMidiNotes } from '../luting-core/midi'
import type { MidiNoteEvent } from '../luting-core/midi'
import { drumKeyForMidi } from './liveVoice'
import { OCTAVE_DOWN_KEY, OCTAVE_UP_KEY, isTypingTarget } from './keymap'
import { getBindings } from './bindings'
import type { NoteSound, Track } from './chart'
import type { EasyMap } from './easy'

export type InputSource = 'midi' | 'screen' | 'keyboard'

export interface PlayEvent {
  kind: 'on' | 'off'
  /** melodic: the MIDI note. drums: index into track.drums. -1 = no lane here. */
  lane: number
  /** what to sound; drum tracks carry `drum`, melodic tracks carry `midi` */
  midi?: number
  drum?: string
  /** 0..1 */
  velocity: number
  source: InputSource
}

/**
 * Maps raw notes onto a track's lanes. A melodic track's lane is its pitch; a
 * kit track's is the position of that drum in the song's own kit, so a snare in
 * a two-piece song and a snare in a full-kit song are different lanes and each
 * song's pads sit next to each other.
 *
 * Easy mode folds several pitches (or kit pieces) onto one key, so there the
 * lane is the key's position and the fold decides which notes reach it. That is
 * the whole extent of what the rest of the game needs to know about folding.
 */
export class LaneMap {
  private readonly drumLane = new Map<string, number>()

  constructor(
    private readonly track: Track,
    private readonly easy: EasyMap | null = null
  ) {
    track.drums.forEach((d, i) => this.drumLane.set(d, i))
  }

  /** The lane a chart note occupies. */
  laneOfNote = (note: NoteSound): number => {
    if (this.easy) return this.easy.laneOf(note)
    return note.drum ? (this.drumLane.get(note.drum) ?? -1) : (note.midi ?? -1)
  }

  /** The lane an incoming MIDI note lands in, or -1 if nothing here answers to it. */
  laneOfMidi(midi: number): number {
    if (!this.track.isDrums) return this.easy ? this.easy.laneOfMidi(midi) : midi
    const key = drumKeyForMidi(midi)
    if (!key) return -1
    return this.easy ? this.easy.laneOf({ drum: key }) : (this.drumLane.get(key) ?? -1)
  }

  /**
   * What a lane should sound when played, knowing nothing about the chart. On a
   * folded key that's the pitch it plays most — the caller can do better once
   * the judge has said which note the press actually claimed.
   */
  soundFor(lane: number): NoteSound {
    if (this.easy) return this.easy.keys[lane]?.voice ?? {}
    return this.track.isDrums ? { drum: this.track.drums[lane] } : { midi: lane }
  }
}

export interface InputRouterOptions {
  lanes: LaneMap
  track: Track
  /** lowest key drawn on the on-screen instrument, for the keyboard binding */
  keyboardBaseMidi: number
  /**
   * slot -> lane on a positional keyboard, or null on the chromatic one, where
   * a computer key means a semitone offset from the base octave instead. Build
   * it with `keyboardSlots` so the drawn keyboard agrees.
   */
  slots: number[] | null
  onPlay: (ev: PlayEvent) => void
  /** the computer keyboard shifted its octave; the UI follows it */
  onOctaveShift?: (baseMidi: number) => void
}

/**
 * Wires up every input source and normalises them into PlayEvents.
 * `dispose()` unhooks all of them; the game screen calls it on unmount.
 */
export class InputRouter {
  /** lanes currently held, so the UI can light them up */
  readonly held = new Set<number>()

  private readonly cleanups: (() => void)[] = []
  private readonly opts: InputRouterOptions
  /** which computer key is holding which lane, so key-up releases the right one */
  private readonly keyLane = new Map<string, number>()
  private baseMidi: number
  /** semitone shift applied to hardware MIDI input */
  private transpose = 0
  private heldSubs = new Set<() => void>()

  constructor(opts: InputRouterOptions) {
    this.opts = opts
    this.baseMidi = opts.keyboardBaseMidi
    this.cleanups.push(subscribeMidiNotes(this.onMidi))
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.releaseAll)
    this.cleanups.push(() => {
      window.removeEventListener('keydown', this.onKeyDown)
      window.removeEventListener('keyup', this.onKeyUp)
      window.removeEventListener('blur', this.releaseAll)
    })
  }

  dispose(): void {
    this.releaseAll()
    for (const fn of this.cleanups) fn()
    this.cleanups.length = 0
  }

  subscribeHeld(cb: () => void): () => void {
    this.heldSubs.add(cb)
    return () => this.heldSubs.delete(cb)
  }

  /** Move the computer keyboard's base octave, from the arrow keys or the HUD. */
  shiftOctave(delta: number): void {
    if (this.opts.slots) return // positional keys name their own notes: nothing to shift
    this.releaseAll() // held keys would otherwise note-off at the new pitch
    this.baseMidi = Math.max(12, Math.min(108, this.baseMidi + delta))
    this.opts.onOctaveShift?.(this.baseMidi)
  }

  setTranspose(semitones: number): void {
    this.releaseAll() // held keys would otherwise note-off at the new pitch
    this.transpose = semitones
  }

  /** Called by the on-screen instrument's pointer handlers. */
  screenPress = (lane: number, velocity = 0.85): void => this.fire('on', lane, velocity, 'screen')
  screenRelease = (lane: number): void => this.fire('off', lane, 0, 'screen')

  // ---- sources -------------------------------------------------------------

  private onMidi = (ev: MidiNoteEvent): void => {
    const lane = this.opts.lanes.laneOfMidi(ev.midi + (this.opts.track.isDrums ? 0 : this.transpose))
    this.fire(ev.kind, lane, ev.velocity, 'midi')
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget()) return
    const k = e.key.toLowerCase()

    // Nothing to shift when the keys already name the part's own notes.
    if (!this.opts.slots && (k === OCTAVE_DOWN_KEY || k === OCTAVE_UP_KEY)) {
      e.preventDefault()
      this.shiftOctave(k === OCTAVE_UP_KEY ? 12 : -12)
      return
    }

    const lane = this.laneForKey(k)
    if (lane === null) return
    e.preventDefault()
    if (this.keyLane.has(k)) return
    this.keyLane.set(k, lane)
    this.fire('on', lane, 0.85, 'keyboard')
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase()
    const lane = this.keyLane.get(k)
    if (lane === undefined) return
    this.keyLane.delete(k)
    this.fire('off', lane, 0, 'keyboard')
  }

  /**
   * Read live from the binding store rather than captured at construction, so a
   * remap on the start screen takes effect without rebuilding the router.
   */
  private laneForKey(k: string): number | null {
    const b = getBindings()
    const { track, slots } = this.opts
    if (slots) {
      // A positional keyboard: the binding is a slot, and the slot names the
      // lane. Kits keep their own map, since a five-pad kit and a twenty-key
      // keyboard want the keys spread differently.
      const i = b[track.isDrums ? 'drums' : 'compact'][k]
      return i !== undefined && i < slots.length ? slots[i] : null
    }
    const semi = b.piano[k]
    return semi === undefined ? null : this.baseMidi + semi
  }

  // ---- dispatch ------------------------------------------------------------

  private fire(kind: 'on' | 'off', lane: number, velocity: number, source: InputSource): void {
    if (lane < 0) {
      // A press with no lane here — an out-of-range key, or a drum this song's
      // kit doesn't use. Still reported, so the judge can count it as a wrong
      // note rather than pretending nothing happened.
      if (kind === 'on') this.opts.onPlay({ kind, lane: -1, velocity, source })
      return
    }
    if (kind === 'on') {
      if (this.held.has(lane)) return // a mirror port or a repeat; already sounding
      this.held.add(lane)
    } else if (!this.held.delete(lane)) {
      return
    }
    this.heldSubs.forEach((cb) => cb())
    this.opts.onPlay({ kind, lane, ...this.opts.lanes.soundFor(lane), velocity, source })
  }

  private releaseAll = (): void => {
    for (const lane of [...this.held]) this.fire('off', lane, 0, 'keyboard')
    this.keyLane.clear()
  }
}
