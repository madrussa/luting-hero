import { describe, it, expect, beforeEach, vi } from 'vitest'

// The store reads localStorage at import time.
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
})

const {
  DEFAULT_BINDINGS, getBindings, setBinding, resetBindings, slotLabels,
  isBindable, encodeSetup, decodeSetup, applyBindings,
  enterSongScope, leaveSongScope,
} = await import('./bindings')

beforeEach(() => {
  leaveSongScope()
  resetBindings('piano')
  resetBindings('drums')
  leaveSongScope()
})

describe('setBinding', () => {
  it('points a key at a slot', () => {
    setBinding('piano', 0, 'q')
    expect(getBindings().piano.q).toBe(0)
    expect(slotLabels('piano').get(0)).toBe('q')
  })

  it('drops the slot’s previous key, so a slot has exactly one', () => {
    // 'a' is C by default; moving C to 'q' must not leave 'a' also playing it.
    expect(DEFAULT_BINDINGS.piano.a).toBe(0)
    setBinding('piano', 0, 'q')
    expect(getBindings().piano.a).toBeUndefined()
  })

  it('drops the key’s previous slot, so one key never plays two notes', () => {
    // 's' is D by default; reassigning it to C must free it from D.
    setBinding('piano', 0, 's')
    const b = getBindings()
    expect(b.piano.s).toBe(0)
    expect(Object.values(b.piano).filter((v) => v === 2)).toHaveLength(0)
  })

  it('clears a slot when given null', () => {
    setBinding('piano', 0, null)
    expect(slotLabels('piano').get(0)).toBeUndefined()
  })

  it('keeps piano and drums independent', () => {
    setBinding('drums', 0, 'q')
    expect(getBindings().drums.q).toBe(0)
    expect(getBindings().piano.q).toBeUndefined()
  })

  it('persists', () => {
    setBinding('piano', 5, 'n')
    expect(JSON.parse(mem.get('luting-hero-bindings')!).piano.n).toBe(5)
  })

  it('resets one kind without touching the other', () => {
    setBinding('piano', 0, 'q')
    setBinding('drums', 0, 'q')
    resetBindings('piano')
    expect(getBindings().piano).toEqual(DEFAULT_BINDINGS.piano)
    expect(getBindings().drums.q).toBe(0)
  })
})

describe('isBindable', () => {
  it('refuses only the keys the game needs for itself', () => {
    for (const k of [' ', 'Escape', 'Enter', 'Tab']) expect(isBindable(k)).toBe(false)
  })

  it('refuses the arrows, which shift the octave', () => {
    // Octave shifting lives on keys that can't be bound, so a remap can never
    // strand a player on a range they have no way to leave.
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp']) expect(isBindable(k)).toBe(false)
  })

  it('accepts the bottom row, so notes below the home row can be played', () => {
    for (const k of ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/']) {
      expect(isBindable(k)).toBe(true)
    }
  })

  it('refuses modifiers', () => {
    // They report as their own key on the way down and so look bindable, but a
    // note on Shift is unplayable with anything else and eats every capital.
    for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) {
      expect(isBindable(k)).toBe(false)
    }
  })

  it('accepts ordinary keys', () => {
    for (const k of ['a', 'q', ';', '1']) expect(isBindable(k)).toBe(true)
  })
})

describe('per-song scoping', () => {
  it('opens a song with its own stored mapping', () => {
    enterSongScope({ piano: { q: 0 } }, () => {})
    expect(getBindings().piano).toEqual({ q: 0 })
  })

  it('inherits the carried mapping for anything the song has not set', () => {
    enterSongScope({ piano: { q: 0 } }, () => {})
    // no drums map stored for this song, so it keeps the one you last used
    expect(getBindings().drums).toEqual(DEFAULT_BINDINGS.drums)
  })

  it('saves an edit into the song, not just globally', () => {
    let saved: unknown = null
    enterSongScope(undefined, (b) => (saved = b))
    setBinding('piano', 0, 'q')
    expect((saved as { piano: Record<string, number> }).piano.q).toBe(0)
  })

  it('keeps two songs’ mappings apart', () => {
    // The whole point: switching songs restores each one's layout rather than
    // making you configure it again.
    const songA: { piano: Record<string, number> }[] = []
    enterSongScope(undefined, (b) => songA.push(b as { piano: Record<string, number> }))
    setBinding('piano', 0, 'q')
    const aMap = getBindings().piano

    enterSongScope({ piano: { p: 0 } }, () => {})
    expect(getBindings().piano).toEqual({ p: 0 })

    // back to A with what it had
    enterSongScope(songA[songA.length - 1], () => {})
    expect(getBindings().piano).toEqual(aMap)
  })

  it('carries the last mapping into a song that has none', () => {
    enterSongScope(undefined, () => {})
    setBinding('piano', 0, 'q')
    const carried = getBindings().piano
    leaveSongScope()
    enterSongScope(undefined, () => {})
    expect(getBindings().piano).toEqual(carried)
  })

  it('stops writing to a song once it is closed', () => {
    let writes = 0
    enterSongScope(undefined, () => writes++)
    setBinding('piano', 0, 'q')
    leaveSongScope()
    setBinding('piano', 1, 'r')
    expect(writes).toBe(1)
  })
})

describe('stored bindings', () => {
  it('drops keys that are no longer bindable when loaded', async () => {
    // A binding written before a key became reserved would otherwise sit there
    // forever, holding a note that nothing can play.
    mem.set('luting-hero-bindings', JSON.stringify({
      piano: { a: 0, shift: 5, ArrowLeft: 7, q: 9 },
      drums: { a: 0, Control: 1 },
    }))
    vi.resetModules()
    const fresh = await import('./bindings')
    expect(fresh.getBindings().piano).toEqual({ a: 0, q: 9 })
    expect(fresh.getBindings().drums).toEqual({ a: 0 })
    mem.delete('luting-hero-bindings')
  })
})

describe('default piano layout', () => {
  it('reaches below the base octave on the bottom row', () => {
    // The point of negative offsets: a part sitting under the home row is
    // playable without shifting the whole layout away from the rest of it.
    expect(DEFAULT_BINDINGS.piano.z).toBe(-12)
    expect(DEFAULT_BINDINGS.piano.m).toBe(-1)
  })

  it('has no two keys on the same note', () => {
    const offsets = Object.values(DEFAULT_BINDINGS.piano)
    expect(new Set(offsets).size).toBe(offsets.length)
  })

  it('spans a shade under three octaves', () => {
    const offsets = Object.values(DEFAULT_BINDINGS.piano)
    expect(Math.min(...offsets)).toBe(-12)
    expect(Math.max(...offsets)).toBe(17)
  })
})

describe('setup sharing', () => {
  it('round-trips settings and bindings', () => {
    setBinding('piano', 0, 'q')
    const code = encodeSetup({ v: 1, settings: { approachSec: 2.1 }, bindings: getBindings() })
    const back = decodeSetup(code)
    expect(back?.bindings.piano.q).toBe(0)
    expect((back?.settings as { approachSec: number }).approachSec).toBe(2.1)
  })

  it('survives a copy-paste, producing no newlines or spaces', () => {
    const code = encodeSetup({ v: 1, settings: {}, bindings: getBindings() })
    expect(code).not.toMatch(/\s/)
  })

  it('tolerates surrounding whitespace on the way back in', () => {
    const code = encodeSetup({ v: 1, settings: {}, bindings: getBindings() })
    expect(decodeSetup(`\n  ${code}  \n`)).not.toBeNull()
  })

  it('rejects junk rather than throwing', () => {
    expect(decodeSetup('not a code')).toBeNull()
    expect(decodeSetup('')).toBeNull()
    expect(decodeSetup(btoa('{"v":99}'))).toBeNull()
  })

  it('applying a shared setup replaces the local bindings', () => {
    const theirs = { piano: { m: 0 }, compact: { b: 0 }, drums: { n: 0 } }
    applyBindings(theirs)
    expect(getBindings().piano).toEqual({ m: 0 })
    expect(getBindings().drums).toEqual({ n: 0 })
  })
})
