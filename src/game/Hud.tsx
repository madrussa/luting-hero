// The bar across the top of the playfield.
//
// Everything up here is laid out in one flow rather than absolutely positioned
// on top of each other: the controls used to be pinned to the top-right corner
// and the score was pinned there too, so the score sat underneath the buttons
// and could not be read. The toolbar (octave, transpose, transport buttons) is
// passed in as a slot so it shares the same row and the score gets its own
// space below it.

import type { ReactNode } from 'react'
import { comboMultiplier } from './judge'
import type { HudSnapshot } from './useGame'
import type { BackingVoice } from './backing'
import type { Track } from './chart'

interface Props {
  hud: HudSnapshot
  track: Track
  songTitle: string
  /** the instruments playing behind you; each lights its own colour on stage */
  band: BackingVoice[]
  /** transport buttons and the MIDI octave controls */
  toolbar: ReactNode
}

export function Hud({ hud, track, songTitle, band, toolbar }: Props) {
  const { stats, last } = hud
  const mult = comboMultiplier(stats.combo)

  return (
    <>
      <div className="hud">
        <div className="hud-left">
          <div className="hud-song">
            <span className="hud-title">{songTitle}</span>
            <span className="hud-track">
              {track.icon} {track.name}
              {track.voices.length > 1 && (
                <em className="hud-merged" title={`Voices ${track.voices.map((v) => v + 1).join(', ')} merged`}>
                  {track.voices.length} voices merged
                </em>
              )}
            </span>
          </div>
          {band.length > 0 && (
            // Static: the lights on stage do the animating. Re-rendering this
            // per note would put React in the middle of the frame loop.
            <ul className="hud-band" aria-label="Playing behind you">
              {band.map((v) => (
                <li key={v.instrument}>
                  <i style={{ background: v.color }} aria-hidden="true" />
                  {v.name}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="hud-right">
          <div className="hud-toolbar">{toolbar}</div>
          <div className="hud-scores">
            <div className="hud-score">{stats.score.toLocaleString()}</div>
            <div className={`hud-combo ${stats.combo >= 10 ? 'hot' : ''}`}>
              {stats.combo > 0 ? (
                <>
                  <strong>{stats.combo}</strong> combo {mult > 1 && <em>×{mult}</em>}
                </>
              ) : (
                <span className="hud-combo-idle">no combo</span>
              )}
            </div>
            <div className="hud-acc">{(hud.accuracy * 100).toFixed(1)}%</div>
          </div>
        </div>
      </div>

      {/* Centred over the highway, clear of both corners. */}
      <div className="hud-centre">
        {last && (
          // Keyed on the note so a repeat of the same verdict replays the
          // animation instead of sitting there looking frozen.
          <div key={last.noteId} className={`verdict ${last.verdict}`}>
            <span className="verdict-word">{last.verdict}</span>
            {last.verdict !== 'miss' && (
              <span className="verdict-delta">
                {last.deltaMs > 0 ? `+${last.deltaMs}` : last.deltaMs} ms
              </span>
            )}
          </div>
        )}
      </div>

      <div className="hud-progress" aria-hidden="true">
        <div className="hud-progress-fill" style={{ width: `${hud.progress * 100}%` }} />
      </div>
    </>
  )
}
