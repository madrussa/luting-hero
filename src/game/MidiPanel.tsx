// MIDI device connection. Nothing here runs at page load — the browser is only
// asked for device access when the player clicks Connect, so no permission
// prompt appears before they've chosen to use a controller.

import { useEffect, useState } from 'react'
import { Usb, AlertTriangle } from 'lucide-react'
import {
  enableMidi,
  disableMidi,
  getMidiDevices,
  getMidiInput,
  isMidiEnabled,
  isMidiSupported,
  setMidiInput,
  subscribeMidiDevices,
} from '../luting-core/midi'
import type { MidiDevice } from '../luting-core/midi'

export function MidiPanel({ compact = false }: { compact?: boolean }) {
  const [devices, setDevices] = useState<MidiDevice[]>([])
  const [enabled, setEnabled] = useState(isMidiEnabled())
  const [input, setInput] = useState(getMidiInput())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => subscribeMidiDevices(() => setDevices(getMidiDevices())), [])

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      setDevices(await enableMidi())
      setEnabled(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach any MIDI devices.')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = () => {
    disableMidi()
    setEnabled(false)
    setDevices(getMidiDevices())
  }

  if (!isMidiSupported()) {
    return (
      <p className={`midi-note ${compact ? 'compact' : ''}`}>
        <AlertTriangle size={14} /> This browser has no Web MIDI — use Chrome or Edge for a
        hardware controller. The on-screen instrument works everywhere.
      </p>
    )
  }

  const hardware = devices.filter((d) => d.id !== 'simulator')

  return (
    <div className={`midi-panel ${compact ? 'compact' : ''}`}>
      {enabled ? (
        <>
          <select
            value={input}
            aria-label="MIDI input device"
            onChange={(e) => {
              setInput(e.target.value)
              setMidiInput(e.target.value)
            }}
          >
            <option value="all">All devices</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn ghost" onClick={disconnect}>
            Disconnect
          </button>
          {hardware.length === 0 && (
            <span className="midi-note compact">No controller found — plug one in and it appears here.</span>
          )}
        </>
      ) : (
        <button type="button" className="btn" onClick={connect} disabled={busy}>
          <Usb size={15} /> {busy ? 'Connecting…' : 'Connect a MIDI device'}
        </button>
      )}
      {error && (
        <span className="midi-note compact error">
          <AlertTriangle size={14} /> {error}
        </span>
      )}
    </div>
  )
}
