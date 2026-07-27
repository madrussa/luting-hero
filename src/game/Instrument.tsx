// The on-screen instrument under the highway: a piano for melodic tracks, a
// pad grid for the kit. It shares its lane geometry with the 3D scene, so a
// key sits directly beneath the lane its notes fall down.

import { useRef } from 'react'
import type { Layout } from './lanes'
import type { FlashMap } from './useGame'

/**
 * Turns the instrument into a key-mapping surface: clicking a key picks the
 * slot to rebind instead of playing it. Far easier than a list of abstract
 * slot names — you point at the key you mean.
 */
export interface RemapMode {
  /** the binding slot a lane occupies, or null if the computer keys can't reach it */
  slotOf: (lane: number) => number | null
  /** the slot currently waiting for a keypress */
  capturing: number | null
  onSelect: (slot: number) => void
}

interface Props {
  layout: Layout
  held: Set<number>
  /** how each recently played lane was judged, whatever you played it with */
  flashes: FlashMap
  showGuides: boolean
  remap?: RemapMode
  onPress: (lane: number) => void
  onRelease: (lane: number) => void
}

export function Instrument({ layout, held, flashes, showGuides, remap, onPress, onRelease }: Props) {
  // A pointer that goes down on one key and slides onto the next should play
  // both — a glissando. That needs the browser to stop capturing the pointer to
  // its original target, and it needs to know whether a button is still down.
  const down = useRef(false)

  const handlers = (lane: number) => {
    if (remap) {
      // In remap mode a click means "rebind this one", so it must not also
      // sound — the note would just be noise over the thing you're aiming at.
      const slot = remap.slotOf(lane)
      return {
        onPointerDown: (e: React.PointerEvent) => {
          e.preventDefault()
          if (slot !== null) remap.onSelect(slot)
        },
      }
    }
    return {
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault()
        down.current = true
        const el = e.currentTarget as HTMLElement
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
        onPress(lane)
      },
      onPointerUp: () => {
        down.current = false
        onRelease(lane)
      },
      onPointerEnter: (e: React.PointerEvent) => {
        if (e.buttons & 1) onPress(lane)
      },
      onPointerLeave: () => onRelease(lane),
      onPointerCancel: () => onRelease(lane),
    }
  }

  /** Extra classes marking a key as bindable / awaiting a keypress. */
  const remapClass = (lane: number): string => {
    if (!remap) return ''
    const slot = remap.slotOf(lane)
    if (slot === null) return 'unreachable'
    return remap.capturing === slot ? 'capturing' : 'remappable'
  }

  /**
   * The verdict tint, as its own element rather than a class on the key.
   * Restarting a CSS animation needs the node to be remounted, and remounting
   * the key itself mid-press would strand the pointer that is holding it — so
   * the throwaway overlay carries `seq` as its React key and the button stays
   * put underneath.
   */
  const flash = (lane: number) => {
    const f = flashes[lane]
    return f ? <span key={f.seq} className={`key-flash ${f.verdict}`} /> : null
  }

  if (layout.isDrums) {
    return (
      <div className="instrument pads" role="group" aria-label="Drum pads">
        {layout.lanes.map((l) => (
          <button
            key={l.lane}
            type="button"
            className={`pad ${held.has(l.lane) ? 'held' : ''} ${remapClass(l.lane)}`}
            style={{ left: `${(l.center - l.width / 2) * 100}%`, width: `${l.width * 100}%` }}
            aria-label={l.label}
            aria-pressed={held.has(l.lane)}
            {...handlers(l.lane)}
          >
            {flash(l.lane)}
            <span className="pad-name">{l.label}</span>
            {l.binding && <kbd className="pad-bind">{l.binding}</kbd>}
          </button>
        ))}
      </div>
    )
  }

  if (layout.compact) {
    // No overlap to resolve — every key is the same size — so one pass in
    // order, and every key gets its name, since the black-key pattern is no
    // longer there to read the pitches off.
    return (
      <div className="instrument piano compact" role="group" aria-label="Keyboard">
        {layout.lanes.map((l) => (
          <button
            key={l.lane}
            type="button"
            className={`key ${l.black ? 'black' : 'white'} ${held.has(l.lane) ? 'held' : ''} ${
              l.anchor ? 'anchor' : ''
            } ${remapClass(l.lane)}`}
            style={{ left: `${(l.center - l.width / 2) * 100}%`, width: `${l.width * 100}%` }}
            aria-label={l.label}
            aria-pressed={held.has(l.lane)}
            {...handlers(l.lane)}
          >
            {flash(l.lane)}
            {showGuides && <span className="key-name">{l.label}</span>}
            {l.binding && <kbd className="key-bind">{l.binding}</kbd>}
          </button>
        ))}
      </div>
    )
  }

  // Whites first so the blacks paint over their seams.
  const whites = layout.lanes.filter((l) => !l.black)
  const blacks = layout.lanes.filter((l) => l.black)

  return (
    <div className="instrument piano" role="group" aria-label="Piano keyboard">
      {whites.map((l) => (
        <button
          key={l.lane}
          type="button"
          className={`key white ${held.has(l.lane) ? 'held' : ''} ${l.anchor ? 'anchor' : ''} ${remapClass(l.lane)}`}
          style={{ left: `${(l.center - l.width / 2) * 100}%`, width: `${l.width * 100}%` }}
          aria-label={l.label}
          aria-pressed={held.has(l.lane)}
          {...handlers(l.lane)}
        >
          {flash(l.lane)}
          {showGuides && l.anchor && <span className="key-name">{l.label}</span>}
          {l.binding && <kbd className="key-bind">{l.binding}</kbd>}
        </button>
      ))}
      {blacks.map((l) => (
        <button
          key={l.lane}
          type="button"
          className={`key black ${held.has(l.lane) ? 'held' : ''} ${remapClass(l.lane)}`}
          style={{ left: `${(l.center - l.width / 2) * 100}%`, width: `${l.width * 100}%` }}
          aria-label={l.label}
          aria-pressed={held.has(l.lane)}
          {...handlers(l.lane)}
        >
          {flash(l.lane)}
          {l.binding && <kbd className="key-bind">{l.binding}</kbd>}
        </button>
      ))}
    </div>
  )
}
