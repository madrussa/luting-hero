// The screen between choosing an instrument and the count-in.
//
// Nothing starts until you press Space. That matters more than it sounds: the
// run used to begin the instant the sample packs finished, so the clock was
// already going while you were still finding the home row.
//
// Crucially the gate does *not* cover the instrument. It sits over the highway
// only, leaving the keyboard live underneath — so you can play it, hear it,
// watch a MIDI controller light the keys, and shift the transpose until the
// octaves line up, all before committing to a run. Remapping works the same
// way: click the key you mean on the instrument itself, then press the computer
// key you want on it.

import { useEffect, useRef } from 'react'
import { Play, Keyboard, RotateCcw, Trophy, Settings as Cog } from 'lucide-react'
import { isBindable, resetBindings, setBinding, useBindings } from './bindings'
import type { BindingKind } from './bindings'
import type { Track } from './chart'
import type { SongBest } from './songStore'
import mascot from '../assets/luting.webp'

interface Props {
  track: Track
  /** easy mode: keys are bound by position, not by semitone */
  compact: boolean
  songTitle: string
  best?: SongBest
  remapping: boolean
  capturing: number | null
  /** the settings overlay is up in front of the gate, so keys aren't ours */
  settingsOpen: boolean
  onToggleRemap: () => void
  onCapture: (slot: number | null) => void
  onSettings: () => void
  onStart: () => void
}

export function StartGate({
  track,
  compact,
  songTitle,
  best,
  remapping,
  capturing,
  settingsOpen,
  onToggleRemap,
  onCapture,
  onSettings,
  onStart,
}: Props) {
  useBindings() // re-render when a binding changes
  const kind: BindingKind = track.isDrums ? 'drums' : compact ? 'compact' : 'piano'

  const capturingRef = useRef(capturing)
  capturingRef.current = capturing
  const settingsRef = useRef(settingsOpen)
  settingsRef.current = settingsOpen

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Hands off while settings are open: Space belongs to whatever has focus
      // in there, and it must not start the run out from under them.
      if (settingsRef.current) return
      const slot = capturingRef.current
      if (slot !== null) {
        // Capture mode swallows everything, so Space can't start the level out
        // from under a rebind in progress — and so the key being assigned
        // doesn't also play its old note on the way through.
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') return onCapture(null)
        if (e.key === 'Backspace' || e.key === 'Delete') {
          setBinding(kind, slot, null)
          return onCapture(null)
        }
        if (!isBindable(e.key)) return
        setBinding(kind, slot, e.key.toLowerCase())
        onCapture(null)
        return
      }
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        onStart()
      }
    }
    // Capture phase, so this runs before the game's own key handling.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [kind, onCapture, onStart])

  return (
    <div className="start-gate" role="dialog" aria-label="Ready to play">
      <div className="start-card">
        <img src={mascot} alt="" className="start-mascot" />
        <h2>
          {songTitle}
          <span className="sub">
            {track.icon} {track.name} · {track.difficulty.label} ·{' '}
            {track.notes.length.toLocaleString()} notes
          </span>
        </h2>

        {best && (
          <p className="start-best">
            <Trophy size={14} /> Your best: <strong>{best.score.toLocaleString()}</strong> ·{' '}
            {best.grade} · {(best.accuracy * 100).toFixed(1)}%
          </p>
        )}

        {remapping ? (
          <p className="hint start-hint">
            {capturing === null ? (
              <>
                Click any {track.isDrums ? 'pad' : 'key'} below, then press the computer key
                you want on it — the whole {track.isDrums ? 'kit' : 'keyboard'} can be mapped
                {compact
                  ? ', and in easy mode that is only the notes this part plays.'
                  : ', including the notes under the home row, which suit the Z–M row.'}
              </>
            ) : (
              <>
                Press a key to bind it. <kbd>Backspace</kbd> clears it, <kbd>Esc</kbd> cancels.
                Saved against this song.
              </>
            )}
          </p>
        ) : (
          <p className="hint start-hint">
            Play the instrument below to warm up — it sounds, and a MIDI controller lights the
            keys it&rsquo;s sending, so you can check your octave with the transpose control
            before anything is scored.
          </p>
        )}

        <div className="start-actions">
          <button type="button" className="btn primary start-btn" onClick={onStart}>
            <Play size={17} /> Press <kbd>Space</kbd> to start
          </button>
          <button type="button" className="btn ghost" onClick={onToggleRemap}>
            <Keyboard size={15} /> {remapping ? 'Done mapping' : 'Remap keys'}
          </button>
          {/* The toolbar's cog is behind the gate, and this is exactly where
              you want the speed, the hit window and the MIDI device: before
              the run, not after losing one to the wrong setting. */}
          <button type="button" className="btn ghost" onClick={onSettings}>
            <Cog size={15} /> Settings
          </button>
          {remapping && (
            <button type="button" className="btn ghost" onClick={() => resetBindings(kind)}>
              <RotateCcw size={14} /> Reset
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
