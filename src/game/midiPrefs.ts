// Remembering the MIDI controller between sessions.
//
// The vendored engine deliberately asks the browser for device access only
// when the player clicks Connect, so no permission prompt appears at page
// load. That is the right default for a first visit and the wrong one for the
// fifth: re-connecting the controller after every refresh, mid-practice, is a
// papercut. So the choice is remembered here, in game code, and reconnecting
// on load is gated on the permission *already* being granted — a restore can
// never be the thing that raises a prompt.
//
// This also wraps the core's module-level state in a store React can read, so
// a reconnect that finishes after the panel has mounted still redraws it.

import { useSyncExternalStore } from 'react'
import {
  disableMidi,
  enableMidi,
  getMidiDevices,
  getMidiInput,
  isMidiEnabled,
  isMidiSupported,
  setMidiInput,
  subscribeMidiDevices,
} from '../luting-core/midi'
import type { MidiDevice } from '../luting-core/midi'

const KEY = 'luting-hero-midi'

interface Prefs {
  /** a controller was connected when the player last left */
  connected: boolean
  /** the port they had selected, or 'all' */
  inputId: string
  /** and its name, so the same controller is found when the id has churned */
  inputName: string
  /**
   * Semitones the controller's input is shifted by. A property of the
   * hardware in front of the player — where its octave sits against the game's
   * keyboard — not of the song, so it's remembered with the device rather than
   * being dialled in again on every song and every refresh.
   */
  transpose: number
}

const DEFAULTS: Prefs = { connected: false, inputId: 'all', inputName: '', transpose: 0 }

let prefs: Prefs = (() => {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
})()

function write(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // no storage: the connection just won't outlive the tab
  }
}

export interface MidiState {
  enabled: boolean
  /** the selected port id, or 'all' */
  input: string
  devices: MidiDevice[]
  /** a silent reconnect is in flight, so the panel doesn't flash "Connect" */
  restoring: boolean
}

let restoring = prefs.connected && isMidiSupported()
let snapshot: MidiState = { enabled: false, input: 'all', devices: [], restoring }
const subs = new Set<() => void>()

// Recomputed rather than derived per render: useSyncExternalStore compares
// snapshots by identity, and getMidiDevices() builds a fresh array every call.
function refresh() {
  snapshot = {
    enabled: isMidiEnabled(),
    input: getMidiInput(),
    devices: getMidiDevices(),
    restoring,
  }
  for (const cb of [...subs]) cb()
}
refresh()

/**
 * Point the engine at the remembered port. Ids are per-origin and usually
 * stable, but a re-plug or a browser update can churn them, so the name is the
 * fallback handle. A controller that isn't plugged in yet leaves us on "all",
 * and the device subscription below picks it up the moment it appears.
 */
function applySelection() {
  if (prefs.inputId === 'all') return setMidiInput('all')
  const devices = getMidiDevices()
  const match =
    devices.find((d) => d.id === prefs.inputId) ??
    (prefs.inputName ? devices.find((d) => d.name === prefs.inputName) : undefined)
  setMidiInput(match ? match.id : 'all')
}

subscribeMidiDevices(() => {
  if (prefs.connected) applySelection()
  refresh()
})

export const getMidiTranspose = (): number => prefs.transpose

export function setMidiTranspose(semis: number): void {
  write({ transpose: semis })
}

export const useMidi = (): MidiState =>
  useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => snapshot
  )

export async function connectMidi(): Promise<void> {
  await enableMidi()
  write({ connected: true })
  applySelection()
  refresh()
}

export function disconnectMidi(): void {
  disableMidi()
  write({ connected: false })
  refresh()
}

export function selectMidiInput(id: string): void {
  setMidiInput(id)
  write({ inputId: id, inputName: getMidiDevices().find((d) => d.id === id)?.name ?? '' })
  refresh()
}

/**
 * Only reconnect silently. If the grant has lapsed, asking again would put a
 * permission prompt in front of a player who hasn't touched anything yet.
 */
async function alreadyGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'midi' } as PermissionDescriptor)
    return status.state === 'granted'
  } catch {
    return false // no Permissions API, or it doesn't know 'midi': don't risk it
  }
}

/** Call once at startup. Resolves whether or not anything was reconnected. */
export async function restoreMidi(): Promise<void> {
  try {
    if (!prefs.connected || !isMidiSupported() || isMidiEnabled()) return
    if (!(await alreadyGranted())) return
    await enableMidi()
    applySelection()
  } catch {
    // denied, or the device layer failed: stop trying on every load
    write({ connected: false })
  } finally {
    restoring = false
    refresh()
  }
}
