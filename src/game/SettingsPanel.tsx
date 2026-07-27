// Settings, shown both from the menu and from the pause overlay so a bad
// calibration can be fixed without abandoning the run.

import { RotateCcw, Copy, Check, ClipboardPaste } from 'lucide-react'
import {
  applyBindings,
  decodeSetup,
  encodeSetup,
  getBindings,
} from './bindings'
import { getSettings } from './settings'
import {
  HIT_WINDOWS,
  PITCH_MIN,
  PITCH_MAX,
  approachToSpeed,
  speedToApproach,
  resetSettings,
  updateSettings,
  useSettings,
} from './settings'
import {
  getPlaybackMode,
  setPlaybackMode,
  subscribePlaybackMode,
} from '../luting-core/samples'
import { getMasterVolume, setMasterVolume } from '../luting-core/player'
import { useSyncExternalStore, useState } from 'react'
import { MidiPanel } from './MidiPanel'

const usePlaybackMode = () => useSyncExternalStore(subscribePlaybackMode, getPlaybackMode)

export function SettingsPanel() {
  const s = useSettings()
  const mode = usePlaybackMode()
  const [volume, setVolume] = useState(getMasterVolume())
  const [copied, setCopied] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [code, setCode] = useState('')
  const [importError, setImportError] = useState<string | null>(null)

  const copySetup = async () => {
    const text = encodeSetup({ v: 1, settings: getSettings(), bindings: getBindings() })
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // clipboard blocked (insecure context, or permission denied): fall back
      // to showing the code so it can still be copied by hand
      setCode(text)
      setPasting(true)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const applyCode = () => {
    const parsed = decodeSetup(code)
    if (!parsed) return setImportError('That doesn’t look like a setup code.')
    setImportError(null)
    applyBindings(parsed.bindings)
    if (parsed.settings && typeof parsed.settings === 'object') {
      updateSettings(parsed.settings as Partial<ReturnType<typeof getSettings>>)
    }
    setPasting(false)
    setCode('')
  }

  return (
    <div className="settings">
      <section>
        <h3>Input</h3>
        <MidiPanel />
        <p className="hint">
          No controller? Play the on-screen instrument with the mouse, or with the computer
          keyboard — the home row is the white keys, the row above is the black keys, the{' '}
          <kbd>Z</kbd>–<kbd>M</kbd> row is the octave below, and <kbd>←</kbd>/<kbd>→</kbd>{' '}
          shift an octave. Drum pads bind left to right from <kbd>A</kbd>. Every key can be
          remapped on the start screen, by clicking the key you mean.
        </p>
      </section>

      <section>
        <h3>Timing</h3>
        <label className="field">
          <span>Hit window</span>
          <select value={s.hitWindow} onChange={(e) => updateSettings({ hitWindow: e.target.value })}>
            {HIT_WINDOWS.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label} — {w.hint}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>
            Calibration offset <em>{s.offsetMs > 0 ? `+${s.offsetMs}` : s.offsetMs} ms</em>
          </span>
          <input
            type="range"
            min={-150}
            max={150}
            step={5}
            value={s.offsetMs}
            onChange={(e) => updateSettings({ offsetMs: parseInt(e.target.value, 10) })}
          />
        </label>
        <p className="hint">
          If your hits read consistently early, raise this; consistently late, lower it. The
          results screen reports your average bias, which is the number to dial out.
        </p>
      </section>

      <section>
        <h3>Highway</h3>
        <label className="field">
          <span>
            Scroll speed <em>{approachToSpeed(s.approachSec)}</em>
          </span>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={approachToSpeed(s.approachSec)}
            onChange={(e) => updateSettings({ approachSec: speedToApproach(parseInt(e.target.value, 10)) })}
          />
        </label>
        <p className="hint">
          Higher is faster: notes spend {s.approachSec.toFixed(1)}s on screen. Faster spreads
          dense passages out and makes them easier to read, at the cost of less warning.
        </p>

        <label className="field">
          <span>
            Camera angle <em>{s.cameraPitch}°</em>
          </span>
          <input
            type="range"
            min={PITCH_MIN}
            max={PITCH_MAX}
            step={2}
            value={s.cameraPitch}
            onChange={(e) => updateSettings({ cameraPitch: parseInt(e.target.value, 10) })}
          />
        </label>
        <p className="hint">
          Steeper looks down on the highway and spreads the approach evenly, so notes are
          readable the whole way in — more warning, in practice. Shallower is more cinematic
          but squeezes the far half of every note’s travel into a thin band at the horizon.
        </p>

        <label className="check">
          <input
            type="checkbox"
            checked={s.guides}
            onChange={(e) => updateSettings({ guides: e.target.checked })}
          />
          Lane guides and note names
        </label>
      </section>

      <section>
        <h3>Sound</h3>
        <label className="field">
          <span>
            Volume <em>{Math.round(volume * 100)}%</em>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10) / 100
              setVolume(v)
              setMasterVolume(v)
            }}
          />
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={mode === 'quality'}
            onChange={(e) => setPlaybackMode(e.target.checked ? 'quality' : 'performance')}
          />
          Real LuteBoi samples
        </label>
        <p className="hint">
          On by default, and what the songs are meant to sound like — each instrument’s
          recorded pack loads before the count-in. Turning this off falls back to a built-in
          synth approximation: rougher, but nothing to download. Lute, Bass, Chiptune and
          Percussion are synthesised either way, exactly as LuteBoi does it.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={s.backing}
            onChange={(e) => updateSettings({ backing: e.target.checked })}
          />
          Play the other instruments behind you
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.hitSound}
            onChange={(e) => updateSettings({ hitSound: e.target.checked })}
          />
          Sound the notes you play
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.missSound}
            onChange={(e) => updateSettings({ missSound: e.target.checked })}
          />
          Thud on a missed note
        </label>
      </section>

      <section>
        <h3>Share your setup</h3>
        <p className="hint">
          Everything on this panel plus your key mapping, as one code. Songs are identified
          by a hash of their notation, so scores and per-song tweaks follow a luting even if
          you paste it in again later — they live in this browser&rsquo;s database.
        </p>
        <div className="share-row">
          <button type="button" className="btn" onClick={copySetup}>
            {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy setup'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setPasting((v) => !v)}>
            <ClipboardPaste size={15} /> Paste a setup
          </button>
        </div>
        {pasting && (
          <div className="paste-box">
            <textarea
              rows={3}
              value={code}
              placeholder="Paste a setup code here"
              onChange={(e) => setCode(e.target.value)}
              aria-label="Setup code"
            />
            <div className="share-row">
              <button type="button" className="btn primary" disabled={!code.trim()} onClick={applyCode}>
                Apply
              </button>
              {importError && <span className="midi-note compact error">{importError}</span>}
            </div>
          </div>
        )}
      </section>

      <button type="button" className="btn ghost" onClick={resetSettings}>
        <RotateCcw size={14} /> Reset to defaults
      </button>
    </div>
  )
}
