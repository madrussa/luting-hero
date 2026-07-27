// Player settings, persisted to localStorage and shared through
// useSyncExternalStore so a change redraws the HUD and retunes the running
// game in the same frame.

import { useSyncExternalStore } from 'react'
import { setPlaybackMode } from '../luting-core/samples'

export type Theme = 'dark' | 'light'

/**
 * How much keyboard a part is drawn on — the one setting that changes what
 * playing it asks of you.
 *
 * `easy` folds the part onto at most eight keys, merging the pitches that share
 * one; `hard` draws a key per pitch the part plays; `impossible` draws the full
 * chromatic keyboard across its range, most of which exists only to be missed.
 */
export type KeyboardMode = 'easy' | 'hard' | 'impossible'

/**
 * There used to be two modes, `easy` and `full`. The fold arrived underneath
 * the first of them and kept its name, so anyone who was on it lands on the
 * folded keyboard — which is the default now, and one click from Hard. `full`
 * is the one worth preserving: it was chosen deliberately, and it is exactly
 * what `impossible` is.
 */
export function normaliseKeyboard(value: unknown): KeyboardMode {
  if (value === 'easy' || value === 'hard' || value === 'impossible') return value
  if (value === 'full') return 'impossible'
  return DEFAULTS.keyboard
}

/** Judging windows in milliseconds, widest ("Good") first. */
export interface HitWindow {
  id: string
  label: string
  hint: string
  /** ± ms for a Perfect / Great / Good verdict */
  perfect: number
  great: number
  good: number
}

export const HIT_WINDOWS: HitWindow[] = [
  { id: 'lenient', label: 'Lenient', hint: '±180 ms — learning a song', perfect: 60, great: 110, good: 180 },
  { id: 'normal', label: 'Normal', hint: '±130 ms — the default feel', perfect: 42, great: 80, good: 130 },
  { id: 'strict', label: 'Strict', hint: '±90 ms — tight, scores higher', perfect: 28, great: 55, good: 90 },
  { id: 'brutal', label: 'Brutal', hint: '±55 ms — frame-accurate', perfect: 16, great: 32, good: 55 },
]

export const hitWindowById = (id: string): HitWindow =>
  HIT_WINDOWS.find((w) => w.id === id) ?? HIT_WINDOWS[1]

export interface Settings {
  theme: Theme
  /** seconds a note is visible on the highway before it reaches the hit line */
  approachSec: number
  /** camera tilt in degrees; steeper spreads the approach more evenly */
  cameraPitch: number
  /** how much keyboard the part is folded onto; see KeyboardMode */
  keyboard: KeyboardMode
  hitWindow: string
  /** shift every judgement by this many ms to compensate for output latency */
  offsetMs: number
  /** play the backing voices behind you */
  backing: boolean
  /** sound your own notes when you hit them */
  hitSound: boolean
  /** a soft click on every miss */
  missSound: boolean
  /** draw the lane grid and note names on the keys */
  guides: boolean
}

export const PITCH_MIN = 28
export const PITCH_MAX = 56

const DEFAULTS: Settings = {
  theme: 'dark',
  approachSec: 1.6,
  // Steep enough that the far half of a note's travel is still readable. At the
  // original 34° the first half of every approach was squeezed into 17% of the
  // screen — notes were a smudge at the horizon and then arrived all at once.
  cameraPitch: 44,
  // Most parts ask for more keys than a hand covers, and a part you can't reach
  // isn't a difficulty setting — so the folded keyboard is the default.
  keyboard: 'easy',
  hitWindow: 'normal',
  offsetMs: 0,
  backing: true,
  hitSound: true,
  missSound: true,
  guides: true,
}

/** Scroll speed is stored as approach time; the UI shows it as a 1..10 speed. */
export const SPEED_MIN = 0.6
export const SPEED_MAX = 3.2
export const approachToSpeed = (sec: number): number =>
  Math.round(((SPEED_MAX - sec) / (SPEED_MAX - SPEED_MIN)) * 9 + 1)
export const speedToApproach = (speed: number): number =>
  SPEED_MAX - ((speed - 1) / 9) * (SPEED_MAX - SPEED_MIN)

const KEY = 'luting-hero-settings'

let settings: Settings = (() => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    // Merge over the defaults so a settings blob written by an older build
    // (missing keys added since) still loads instead of yielding undefineds.
    const saved = JSON.parse(raw) as Partial<Settings>
    return { ...DEFAULTS, ...saved, keyboard: normaliseKeyboard(saved.keyboard) }
  } catch {
    return { ...DEFAULTS }
  }
})()

const subs = new Set<() => void>()

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme
}
applyTheme()

export const getSettings = (): Settings => settings

export function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  if (patch.theme) applyTheme()
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // preferences just won't persist
  }
  subs.forEach((cb) => cb())
}

export const toggleTheme = () =>
  updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })

export const resetSettings = () => updateSettings({ ...DEFAULTS })

function subscribe(cb: () => void) {
  subs.add(cb)
  return () => subs.delete(cb)
}

export const useSettings = (): Settings => useSyncExternalStore(subscribe, getSettings)

/**
 * Turn the real LuteBoi sample packs on by default.
 *
 * The vendored engine defaults to its synth ("performance" mode), which is the
 * right call for Luting Studio — you're editing there, auditioning a bar at a
 * time, and want it instant. A game is the opposite: you hear the whole song
 * once, straight through, and the approximation is the first thing you notice.
 * So samples are the default here, and the setting only exists to turn them
 * off.
 *
 * Only applied when the player has never chosen, so an explicit "off" sticks.
 * The key is samples.ts's own; reading it directly is the only way to tell "not
 * set" from "set to performance", which its getter flattens together.
 */
export function applyAudioDefaults(): void {
  try {
    if (localStorage.getItem('luting-playback-mode') === null) setPlaybackMode('quality')
  } catch {
    // no storage (private mode): fall through to the engine's own default
    setPlaybackMode('quality')
  }
}
