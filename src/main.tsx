import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyAudioDefaults } from './game/settings'
import { claimAudioSession } from './game/audioSession'
import { restoreMidi } from './game/midiPrefs'
import './styles.css'

// Before any audio context exists, so every one of them is media rather than a
// system sound — otherwise an iPhone's silent switch mutes the whole game and
// nothing on the page can tell that it has.
claimAudioSession()
applyAudioDefaults()
// Silently only, and only if a controller was connected last time — see
// midiPrefs.ts. Deliberately not awaited: nothing on screen waits for MIDI.
void restoreMidi()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
