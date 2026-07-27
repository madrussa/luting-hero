import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyAudioDefaults } from './game/settings'
import { restoreMidi } from './game/midiPrefs'
import './styles.css'

applyAudioDefaults()
// Silently only, and only if a controller was connected last time — see
// midiPrefs.ts. Deliberately not awaited: nothing on screen waits for MIDI.
void restoreMidi()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
