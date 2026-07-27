// The playfield: highway on top, instrument along the bottom, overlays on top
// of both.

import { useEffect, useState } from 'react'
import {
  Pause, Play, RotateCcw, LogOut, Settings as Cog,
  Minus, Plus, ChevronLeft, ChevronRight,
} from 'lucide-react'
import { Hud } from './Hud'
import { Instrument } from './Instrument'
import { StartGate } from './StartGate'
import { SettingsPanel } from './SettingsPanel'
import type { SongBest } from './songStore'
import { useGame } from './useGame'
import { useSettings } from './settings'
import { noteName } from './lanes'
import type { Chart, Track } from './chart'
import type { Stats } from './judge'
import mascot from '../assets/luting.webp'

interface Props {
  chart: Chart
  track: Track
  songTitle: string
  /** your best previous run on this instrument, if this song has been played */
  best?: SongBest
  onQuit: () => void
  onFinish: (stats: Stats) => void
}

export function GameScreen({ chart, track, songTitle, best, onQuit, onFinish }: Props) {
  const game = useGame(chart, track, onQuit)
  const settings = useSettings()
  const [showSettings, setShowSettings] = useState(false)
  // Remapping only happens at the gate, and the instrument is the surface for
  // it, so the state lives here where both can see it.
  const [remapping, setRemapping] = useState(false)
  const [capturing, setCapturing] = useState<number | null>(null)

  // The results screen is the parent's business; hand it the stats once the
  // run is over. In an effect, not in render — the parent switches screens on
  // this, and a setState during another component's render is a re-entrancy
  // React is entitled to complain about.
  const { phase, finalStats } = game
  useEffect(() => {
    if (phase === 'finished' && finalStats) onFinish(finalStats)
  }, [phase, finalStats, onFinish])

  const paused = game.phase === 'paused'

  // Which binding slot a lane sits in, for click-to-remap on the instrument.
  // Every drawn key has one: offsets run negative as well as positive, so a
  // note below the home row is bound like any other rather than being out of
  // reach until you shift the octave.
  const slotOf = (lane: number): number | null => {
    if (track.isDrums) return lane
    // Easy mode names keys by position in the part's own pitches, so that's
    // what a click has to select.
    if (game.layout.compact) {
      const i = track.pitches.indexOf(lane)
      return i === -1 ? null : i
    }
    return lane - game.computerBaseMidi
  }

  return (
    <div className="game">
      {/* The stage is everything above the instrument. The start gate covers
          only this, so the keyboard underneath stays playable while it's up. */}
      <div className="stage">
        {/* Decorative to a screen reader: the HUD carries the state that matters. */}
        <canvas ref={game.canvasRef} className="highway-canvas" aria-hidden="true" />

        <Hud
          hud={game.hud}
          track={track}
          songTitle={songTitle}
          band={game.band}
          toolbar={
            <>
              {/* A kit has no octave to move, so the transpose group is only
                  meaningful for pitched instruments. */}
              {/* Easy mode has nothing to shift: the keys already name the
                  part's own pitches. */}
              {!track.isDrums && !game.layout.compact && (
                <div className="octave" role="group" aria-label="Octave and MIDI transpose">
                  <span className="octave-range">
                    {noteName(game.computerBaseMidi - 12)}–{noteName(game.computerBaseMidi + 17)}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Octave down"
                    title="Shift the computer keyboard down an octave (←)"
                    onClick={() => game.shiftOctave(-12)}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Octave up"
                    title="Shift the computer keyboard up an octave (→)"
                    onClick={() => game.shiftOctave(12)}
                  >
                    <ChevronRight size={14} />
                  </button>
                  <span className="octave-sep" aria-hidden="true" />
                  <span className="octave-label">MIDI</span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Transpose MIDI input down an octave"
                    onClick={() => game.setTranspose(Math.max(-36, game.transposeSemis - 12))}
                  >
                    <Minus size={13} />
                  </button>
                  <span className="octave-value">
                    {game.transposeSemis === 0
                      ? '0'
                      : `${game.transposeSemis > 0 ? '+' : ''}${game.transposeSemis / 12}`}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Transpose MIDI input up an octave"
                    onClick={() => game.setTranspose(Math.min(36, game.transposeSemis + 12))}
                  >
                    <Plus size={13} />
                  </button>
                </div>
              )}
              <button
                type="button"
                className="icon-btn"
                onClick={paused ? game.resume : game.pause}
                aria-label={paused ? 'Resume' : 'Pause'}
                title={paused ? 'Resume (Esc)' : 'Pause (Esc)'}
              >
                {paused ? <Play size={16} /> : <Pause size={16} />}
              </button>
              <button type="button" className="icon-btn" onClick={game.restart} aria-label="Restart" title="Restart">
                <RotateCcw size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowSettings((v) => !v)}
                aria-label="Settings"
                title="Settings"
              >
                <Cog size={16} />
              </button>
              <button type="button" className="icon-btn" onClick={onQuit} aria-label="Quit to menu" title="Quit to menu">
                <LogOut size={16} />
              </button>
            </>
          }
        />

      {game.phase === 'loading' && (
        <div className="countdown" aria-live="polite">
          <img src={mascot} alt="" className="countdown-mascot" />
          <span className="loading-label">
            Tuning up{game.loading.total > 1 && ` · ${game.loading.done}/${game.loading.total}`}
          </span>
          <span className="loading-sub">loading the real LuteBoi samples</span>
        </div>
      )}

      {game.phase === 'ready' && (
        <StartGate
          track={track}
          compact={game.layout.compact}
          songTitle={songTitle}
          best={best}
          remapping={remapping}
          capturing={capturing}
          settingsOpen={showSettings}
          onSettings={() => setShowSettings(true)}
          onToggleRemap={() => {
            setRemapping((v) => !v)
            setCapturing(null)
          }}
          onCapture={setCapturing}
          onStart={game.begin}
        />
      )}

      {game.phase === 'countdown' && game.hud.countdown > 0 && (
        <div className="countdown" aria-live="polite">
          <img src={mascot} alt="" className="countdown-mascot" />
          <span className="countdown-number">{game.hud.countdown}</span>
        </div>
      )}
      </div>

      {paused && (
        <div className="overlay" role="dialog" aria-label="Paused">
          <div className="overlay-card">
            <h2>Paused</h2>
            {showSettings ? (
              <SettingsPanel />
            ) : (
              <p className="hint">
                <kbd>Esc</kbd> again quits to the menu.
              </p>
            )}
            <div className="overlay-actions">
              <button type="button" className="btn primary" onClick={game.resume}>
                <Play size={15} /> Resume
              </button>
              <button type="button" className="btn" onClick={() => setShowSettings((v) => !v)}>
                <Cog size={15} /> {showSettings ? 'Hide settings' : 'Settings'}
              </button>
              <button type="button" className="btn ghost" onClick={game.restart}>
                <RotateCcw size={15} /> Restart
              </button>
              <button type="button" className="btn ghost" onClick={onQuit}>
                <LogOut size={15} /> Quit
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettings && !paused && (
        <div className="overlay" role="dialog" aria-label="Settings" onClick={() => setShowSettings(false)}>
          <div className="overlay-card" onClick={(e) => e.stopPropagation()}>
            <h2>Settings</h2>
            <SettingsPanel />
            <div className="overlay-actions">
              <button type="button" className="btn primary" onClick={() => setShowSettings(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inset to match where the highway's near corners land, so every key
          sits directly beneath the lane its notes fall down. */}
      <div
        className="stage-foot"
        style={{ paddingLeft: `${game.edgeInsetPct}%`, paddingRight: `${game.edgeInsetPct}%` }}
      >
        {/* Floats over the keys rather than taking a row, so the keyboard can
            sit flush against the lanes. */}
        {game.outOfRange !== null && (
          <span className="range-warn" role="status">
            {track.isDrums
              ? 'This song’s kit has no pad for that drum'
              : `${noteName(game.outOfRange)} is off this keyboard — transpose to reach it`}
          </span>
        )}

        <Instrument
          layout={game.layout}
          held={game.held}
          flashes={game.flashes}
          showGuides={settings.guides}
          remap={
            game.phase === 'ready' && remapping
              ? { slotOf, capturing, onSelect: setCapturing }
              : undefined
          }
          onPress={game.press}
          onRelease={game.release}
        />
      </div>
    </div>
  )
}
