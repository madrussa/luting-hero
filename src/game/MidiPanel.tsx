// MIDI device connection.
//
// Nothing here asks the browser for device access at page load — the prompt
// only follows a click on Connect. Once the player has connected, though, the
// choice is remembered and restored on the next visit; see midiPrefs.ts, which
// owns both the persistence and the state this reads.

import { useState } from 'react'
import { Usb, AlertTriangle } from 'lucide-react'
import { isMidiSupported } from '../luting-core/midi'
import { connectMidi, disconnectMidi, selectMidiInput, useMidi } from './midiPrefs'

export function MidiPanel({ compact = false }: { compact?: boolean }) {
  const { enabled, input, devices, restoring } = useMidi()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      await connectMidi()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach any MIDI devices.')
    } finally {
      setBusy(false)
    }
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
            onChange={(e) => selectMidiInput(e.target.value)}
          >
            <option value="all">All devices</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn ghost" onClick={disconnectMidi}>
            Disconnect
          </button>
          {hardware.length === 0 && (
            <span className="midi-note compact">No controller found — plug one in and it appears here.</span>
          )}
        </>
      ) : (
        <button type="button" className="btn" onClick={connect} disabled={busy || restoring}>
          <Usb size={15} />{' '}
          {restoring ? 'Reconnecting…' : busy ? 'Connecting…' : 'Connect a MIDI device'}
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
