// Web MIDI input: connect a hardware keyboard/controller and stream its
// note-on/note-off events to subscribers (the live synth and the recorder).
//
// Chrome, Edge and Firefox (108+) ship the Web MIDI API. Safari doesn't, on any
// platform, and WebKit has no plans to — a MIDI device list is a fingerprint.
// The on-screen keyboard simulator further down is the fallback there.
//
// Access is a permission everywhere it exists: Firefox has always gated it, and
// Chrome has prompted for plain access since 124 rather than only for sysex. We
// ask for non-sysex access, which is the weaker grant — sysex can reprogram a
// device's firmware, and reading note on/off doesn't need it. (In an iframe the
// embedding page would also have to allow="midi"; the game isn't embedded.)

export interface MidiDevice {
  id: string
  name: string
}

export interface MidiNoteEvent {
  kind: 'on' | 'off'
  midi: number
  /** 0..1 */
  velocity: number
  /** DOMHighResTimeStamp of the message (performance.now() clock) */
  timeMs: number
  /** the input port this came from, so downstream state never merges devices */
  deviceId: string
}

export const isMidiSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator

/** Shared so the UI and the thrown error can't drift apart. */
export const MIDI_UNSUPPORTED =
  "This browser has no Web MIDI — Safari doesn't ship it. Chrome, Edge or Firefox will see a controller."

/**
 * A failed access request, carrying whether the browser *refused* (permission
 * denied, or Firefox declining because nothing is plugged in) as opposed to the
 * device layer falling over. Callers use it to decide whether the remembered
 * connection is now wrong or just unavailable this once.
 */
export class MidiAccessError extends Error {
  constructor(
    message: string,
    readonly denied: boolean
  ) {
    super(message)
    this.name = 'MidiAccessError'
  }
}

/**
 * Turn a rejected requestMIDIAccess into something a player can act on.
 *
 * Firefox is the case worth knowing: it refuses MIDI outright when no device is
 * attached — no prompt at all — and delays the rejection by a random 3–13
 * seconds so a page can't time it to learn whether the machine has devices. So
 * "plug it in first" is the advice that actually unblocks people, and a Connect
 * that appears to hang for ten seconds is the browser, not us.
 */
function accessError(e: unknown): MidiAccessError {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return new MidiAccessError(
      'The browser blocked MIDI access. Plug the controller in before connecting — Firefox refuses when nothing is attached — then allow MIDI when asked.',
      true
    )
  }
  if (name === 'NotSupportedError') {
    return new MidiAccessError('This system has no MIDI support the browser can reach.', false)
  }
  const detail = e instanceof Error && e.message ? e.message : ''
  return new MidiAccessError(detail || 'Could not reach any MIDI devices.', false)
}

let access: MIDIAccess | null = null
let selectedInput = 'all'

const noteSubs = new Set<(ev: MidiNoteEvent) => void>()
const deviceSubs = new Set<() => void>()

export const isMidiEnabled = (): boolean => access !== null

export function getMidiDevices(): MidiDevice[] {
  const list: MidiDevice[] = []
  if (simActive) list.push({ id: SIM_DEVICE_ID, name: 'On-screen keyboard' })
  if (access) {
    for (const i of access.inputs.values()) {
      list.push({ id: i.id, name: i.name || i.manufacturer || 'MIDI device' })
    }
  }
  return list
}

export function getMidiInput(): string {
  return selectedInput
}

/** 'all' listens to every connected device. */
export function setMidiInput(id: string) {
  selectedInput = id
  resetMirrorState() // whatever was mid-press on a now-muted port is moot
}

// ---------------------------------------------------------------------------
// Mirror-port collapsing.
//
// A single controller often exposes more than one input port (a keys port plus
// a "DAW"/MIDIIN2 port), and virtual buses (macOS IAC, DAW loopbacks) re-emit
// whatever they receive. With "All devices" that means one physical key press
// arrives two or three times, a few hundred microseconds apart. Left alone
// those duplicates double every live voice and every recorded note.
//
// So: a note-on for a key that another port just announced is dropped, and the
// duplicate's note-off is remembered and dropped too — a swallowed note-on
// whose note-off got through would strand a voice with nothing left holding
// its key. Two people playing the same key on two keyboards land outside the
// window in practice, and both are kept if they don't.

const MIRROR_WINDOW_MS = 6

/** key -> the port that currently owns it, and when it claimed it */
const keyOwner = new Map<number, { deviceId: string; timeMs: number }>()
/** `deviceId:midi` of note-ons dropped as mirrors, awaiting their note-off */
const mirrored = new Set<string>()

const mirrorKey = (deviceId: string, midi: number) => `${deviceId}:${midi}`

export function resetMirrorState() {
  keyOwner.clear()
  mirrored.clear()
}

/**
 * True when this event is a mirror of one already accounted for and should be
 * dropped. Stateful: tracks which port owns each sounding key.
 */
export function isMirrorDuplicate(ev: MidiNoteEvent): boolean {
  if (ev.kind === 'on') {
    const owner = keyOwner.get(ev.midi)
    if (owner && owner.deviceId !== ev.deviceId && ev.timeMs - owner.timeMs < MIRROR_WINDOW_MS) {
      mirrored.add(mirrorKey(ev.deviceId, ev.midi))
      return true
    }
    keyOwner.set(ev.midi, { deviceId: ev.deviceId, timeMs: ev.timeMs })
    return false
  }
  if (mirrored.delete(mirrorKey(ev.deviceId, ev.midi))) return true
  const owner = keyOwner.get(ev.midi)
  if (owner && owner.deviceId === ev.deviceId) keyOwner.delete(ev.midi)
  return false
}

function dispatch(ev: MidiNoteEvent) {
  if (isMirrorDuplicate(ev)) return
  for (const cb of [...noteSubs]) cb(ev)
}

export function subscribeMidiNotes(cb: (ev: MidiNoteEvent) => void): () => void {
  noteSubs.add(cb)
  return () => noteSubs.delete(cb)
}

/** Fires when devices are (un)plugged. */
export function subscribeMidiDevices(cb: () => void): () => void {
  deviceSubs.add(cb)
  return () => deviceSubs.delete(cb)
}

// ---------------------------------------------------------------------------
// Simulator: a virtual input driven by the on-screen keyboard, so the whole
// MIDI path (device pick, live synth, recorder) is testable without hardware
// and in browsers without Web MIDI. Events flow through the same subscribers
// and honor the same input filter as real devices.

export const SIM_DEVICE_ID = 'simulator'

let simActive = false

export const isSimActive = (): boolean => simActive

export function setSimActive(on: boolean) {
  if (simActive === on) return
  simActive = on
  for (const cb of [...deviceSubs]) cb()
}

/** Emit a note from the simulated device (no-op while it's switched off). */
export function simNote(kind: 'on' | 'off', midi: number, velocity: number) {
  if (!simActive) return
  if (selectedInput !== 'all' && selectedInput !== SIM_DEVICE_ID) return
  dispatch({
    kind,
    midi,
    velocity: kind === 'on' ? Math.min(1, Math.max(0, velocity)) : 0,
    timeMs: performance.now(),
    deviceId: SIM_DEVICE_ID,
  })
}

function onMessage(this: MIDIInput, e: MIDIMessageEvent) {
  if (selectedInput !== 'all' && this.id !== selectedInput) return
  const data = e.data
  if (!data || data.length < 3) return
  const status = data[0] & 0xf0
  const midi = data[1]
  const vel = data[2]
  let ev: MidiNoteEvent | null = null
  if (status === 0x90 && vel > 0) {
    ev = { kind: 'on', midi, velocity: vel / 127, timeMs: e.timeStamp, deviceId: this.id }
  } else if (status === 0x80 || (status === 0x90 && vel === 0)) {
    // note-on with velocity 0 is the wire-saving spelling of note-off
    ev = { kind: 'off', midi, velocity: 0, timeMs: e.timeStamp, deviceId: this.id }
  }
  if (ev) dispatch(ev)
}

function bindInputs() {
  if (!access) return
  for (const input of access.inputs.values()) {
    input.onmidimessage = onMessage
  }
}

/**
 * Request MIDI access (which prompts the user) and start listening. Resolves to
 * the current device list; rejects with a MidiAccessError if unsupported,
 * refused, or unreachable. This is the ONLY place the browser is asked for
 * device access, and it must stay reachable from a click: nothing runs at page
 * load, so no permission prompt appears before the user acts, and the request
 * keeps the user activation Firefox's grant flow needs.
 */
export async function enableMidi(): Promise<MidiDevice[]> {
  if (!isMidiSupported()) throw new MidiAccessError(MIDI_UNSUPPORTED, false)
  if (!access) {
    // sysex stays off: see the note at the top of the file.
    try {
      access = await navigator.requestMIDIAccess({ sysex: false })
    } catch (e) {
      throw accessError(e)
    }
    access.onstatechange = () => {
      bindInputs() // newly plugged devices need their handler attached
      for (const cb of [...deviceSubs]) cb()
    }
    bindInputs()
  }
  return getMidiDevices()
}

/**
 * Release hardware access entirely: unhook and close every input port and
 * drop the MIDIAccess object, so the browser's "site is accessing MIDI/USB
 * devices" indicator clears. enableMidi() can re-acquire later (silently, if
 * the permission is already granted).
 */
export function disableMidi() {
  if (!access) return
  access.onstatechange = null
  for (const input of access.inputs.values()) {
    input.onmidimessage = null
    void input.close().catch(() => {})
  }
  access = null
  resetMirrorState()
  for (const cb of [...deviceSubs]) cb()
}
