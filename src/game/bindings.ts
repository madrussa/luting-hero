// Remappable computer-keyboard bindings, scoped to the song being played.
//
// The piano map is key -> semitone above the keyboard's base octave; the drum
// map is key -> pad *position* (0 is always the leftmost, lowest kit piece).
// Both are relative, so a mapping stays meaningful whatever the chart's range
// or kit — but see the note on `carried` for why they still belong to a song.

import { useSyncExternalStore } from 'react'
import { PIANO_KEYS, DRUM_KEY_ORDER } from './keymap'

/**
 * `piano` maps a key to a semitone offset from the base octave — the full
 * chromatic keyboard. `compact` and `drums` map a key to a *position*: the nth
 * key drawn, or the nth piece of the kit. Positional maps are kept apart
 * because a five-pad kit and a twenty-key keyboard want the keys spread
 * differently.
 *
 * Being positional is what lets one map serve both melodic keyboards that are
 * drawn that way: the eight folded keys of easy mode are the first eight slots
 * of the same map hard mode spreads over every pitch in the part.
 */
export type BindingKind = 'piano' | 'compact' | 'drums'

export interface Bindings {
  /** computer key -> semitone offset from the base octave */
  piano: Record<string, number>
  /** computer key -> which drawn key, left to right (the folded and per-pitch keyboards) */
  compact: Record<string, number>
  /** computer key -> pad index */
  drums: Record<string, number>
}

const positional = () => Object.fromEntries(DRUM_KEY_ORDER.map((k, i) => [k, i]))

export const DEFAULT_BINDINGS: Bindings = {
  piano: { ...PIANO_KEYS },
  compact: positional(),
  drums: positional(),
}

/**
 * Space starts the level and Escape pauses it, so neither can be a note.
 *
 * Nothing else is reserved: every key on the drawn instrument can be bound to
 * any key on the computer keyboard, including the bottom row, which is how a
 * part sitting below the home row gets played at all. Octave shifting lives on
 * the arrow keys, which `isBindable` rejects, so a remap can never take it away.
 */
export const RESERVED_KEYS = new Set([' ', 'spacebar', 'escape', 'enter', 'tab'])

/**
 * Modifiers can't be notes. They report as their own `key` on the way down, so
 * they *look* bindable, but holding one changes what every other key reports —
 * a note bound to Shift would be unplayable in combination with anything, and
 * would swallow every capital letter besides.
 */
const MODIFIERS = new Set(['shift', 'control', 'alt', 'meta', 'capslock', 'contextmenu'])

/** True when this key can be assigned to a note at all. */
export const isBindable = (key: string): boolean => {
  const k = key.toLowerCase()
  return key.length > 0 && !RESERVED_KEYS.has(k) && !MODIFIERS.has(k) && !key.startsWith('Arrow')
}

/**
 * Drop anything unbindable from a stored map. Self-healing: a binding written
 * before a key became reserved would otherwise sit there forever, occupying a
 * note that nothing could play.
 */
const sanitise = (map: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(map).filter(([k]) => isBindable(k)))

const KEY = 'luting-hero-bindings'

const load = (): Bindings => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return structuredClone(DEFAULT_BINDINGS)
    const saved = JSON.parse(raw) as Partial<Bindings>
    return {
      piano: sanitise(saved.piano ?? DEFAULT_BINDINGS.piano),
      compact: sanitise(saved.compact ?? DEFAULT_BINDINGS.compact),
      drums: sanitise(saved.drums ?? DEFAULT_BINDINGS.drums),
    }
  } catch {
    return structuredClone(DEFAULT_BINDINGS)
  }
}

/**
 * Two levels, because both complaints are real.
 *
 * A mapping belongs to a *song*: ranges and kits differ, so a layout that suits
 * one chart is wrong for the next, and having to redo it every time you switch
 * is the thing to avoid. So each song keeps its own, in its IndexedDB record.
 *
 * But a brand-new song still has to start from something, and starting from the
 * factory layout every time would be just as annoying for anyone who has
 * arranged the keys to suit their hands. So `carried` — the last mapping you
 * touched, kept in localStorage — is what a song with no mapping of its own
 * inherits. Set your layout once and every new song opens with it; change it
 * inside a song and only that song changes.
 */
let carried: Bindings = load()
let active: Bindings = carried
/** set while a song is open; persists edits into that song's record */
let saveToSong: ((b: Bindings) => void) | null = null

const subs = new Set<() => void>()
const notify = () => subs.forEach((cb) => cb())

function persist() {
  carried = active
  try {
    localStorage.setItem(KEY, JSON.stringify(active))
  } catch {
    // bindings just won't survive the session
  }
  saveToSong?.(active)
  notify()
}

export const getBindings = (): Bindings => active

/**
 * Open a song's mapping. Anything the song hasn't defined falls back to the
 * carried mapping, so a new song opens with the keys you last used.
 */
export function enterSongScope(saved: Partial<Bindings> | null | undefined, save: (b: Bindings) => void): void {
  active = {
    piano: sanitise(saved?.piano ?? carried.piano),
    compact: sanitise(saved?.compact ?? carried.compact),
    drums: sanitise(saved?.drums ?? carried.drums),
  }
  saveToSong = save
  notify()
}

/** Back to the carried mapping; edits stop reaching any song record. */
export function leaveSongScope(): void {
  active = carried
  saveToSong = null
  notify()
}

/** slot -> key, for drawing the label on a key or pad. */
export function slotLabels(kind: BindingKind): Map<number, string> {
  const out = new Map<number, string>()
  for (const [key, slot] of Object.entries(active[kind])) out.set(slot, key)
  return out
}

/**
 * Point `key` at `slot`. A key can only mean one thing, so any previous use of
 * it is dropped — otherwise a careless remap silently plays two notes at once.
 * Passing null clears the slot instead.
 */
export function setBinding(kind: BindingKind, slot: number, key: string | null): void {
  const next: Record<string, number> = {}
  for (const [k, s] of Object.entries(active[kind])) {
    if (s === slot) continue // the slot's old key goes
    if (key !== null && k === key) continue // and the key's old slot goes
    next[k] = s
  }
  if (key !== null) next[key] = slot
  active = { ...active, [kind]: next }
  persist()
}

export function resetBindings(kind: BindingKind): void {
  active = { ...active, [kind]: { ...DEFAULT_BINDINGS[kind] } }
  persist()
}

function subscribe(cb: () => void) {
  subs.add(cb)
  return () => subs.delete(cb)
}

export const useBindings = (): Bindings => useSyncExternalStore(subscribe, getBindings)

// ---------------------------------------------------------------------------
// Sharing

export interface Shareable {
  v: 1
  settings: unknown
  bindings: Bindings
}

/** Pack a setup into a string that survives a copy-paste into a chat window. */
export function encodeSetup(payload: Shareable): string {
  const json = JSON.stringify(payload)
  // btoa is Latin-1 only; encodeURIComponent first so any character survives.
  return btoa(unescape(encodeURIComponent(json)))
}

export function decodeSetup(code: string): Shareable | null {
  try {
    const json = decodeURIComponent(escape(atob(code.trim())))
    const parsed = JSON.parse(json) as Shareable
    if (parsed?.v !== 1 || !parsed.bindings) return null
    return parsed
  } catch {
    return null
  }
}

export function applyBindings(next: Bindings): void {
  active = {
    piano: sanitise(next.piano),
    compact: sanitise(next.compact ?? DEFAULT_BINDINGS.compact),
    drums: sanitise(next.drums),
  }
  persist()
}
