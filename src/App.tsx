import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sun, Moon, Settings as Cog, X } from 'lucide-react'
import { SongPicker } from './game/SongPicker'
import { InstrumentPicker } from './game/InstrumentPicker'
import { Results } from './game/Results'
import { SettingsPanel } from './game/SettingsPanel'
import { buildChart } from './game/chart'
import type { Track } from './game/chart'
import type { LibrarySong } from './game/library'
import type { Stats } from './game/judge'
import { toggleTheme, useSettings } from './game/settings'
import { lutingHash } from './game/hash'
import { emptyRecord, loadSongRecord, saveSongRecord, withBest } from './game/songStore'
import { enterSongScope, leaveSongScope } from './game/bindings'
import type { SongRecord } from './game/songStore'
import { accuracy, grade } from './game/judge'
import mascot from './assets/luting.webp'

// The playfield pulls in Three.js, which is most of the bundle and none of
// what the song and instrument pickers need. Splitting it out lets the menus
// paint immediately; picking a song then warms the chunk in the background, so
// by the time an instrument is chosen it is almost always already there.
const loadGameScreen = () => import('./game/GameScreen')
const GameScreen = lazy(() => loadGameScreen().then((m) => ({ default: m.GameScreen })))

type Screen = 'songs' | 'instruments' | 'play' | 'results'

export default function App() {
  const settings = useSettings()
  const [screen, setScreen] = useState<Screen>('songs')
  const [song, setSong] = useState<LibrarySong | null>(null)
  const [track, setTrack] = useState<Track | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // Bumped to force a fresh GameScreen (and so a fresh run) on replay.
  const [runKey, setRunKey] = useState(0)
  // What we remember about this song, keyed by a hash of its notation.
  const [record, setRecord] = useState<SongRecord | null>(null)
  // The binding store is a module singleton, so it needs the record by ref
  // rather than through a closure that would go stale on the next edit.
  const recordRef = useRef<SongRecord | null>(null)
  recordRef.current = record

  // Key bindings belong to the song. Opening one installs its mapping (falling
  // back to whatever you last used); leaving puts that back.
  useEffect(() => leaveSongScope, [])

  // Parsing is the expensive step, so it happens once per song rather than on
  // every screen change.
  const chart = useMemo(() => (song ? buildChart(song.text) : null), [song])

  const pickSong = (s: LibrarySong) => {
    setSong(s)
    setTrack(null)
    setStats(null)
    setRecord(null)
    setScreen('instruments')
    void loadGameScreen() // warm the playfield chunk while they choose
    // The hash is of the notation, so a song recognises itself however it
    // arrived — bundled, dropped as a file, or pasted back in later.
    const hash = lutingHash(s.text)
    void loadSongRecord(hash).then((r) => {
      const rec = r ?? emptyRecord(hash, s.title)
      setRecord(rec)
      enterSongScope(rec.bindings, (b) => {
        const current = recordRef.current
        if (!current || current.hash !== hash) return // a different song has been opened
        const next = { ...current, bindings: b }
        setRecord(next)
        void saveSongRecord(next)
      })
    })
  }

  const backToSongs = () => {
    leaveSongScope()
    setRecord(null)
    setScreen('songs')
  }

  const pickTrack = (t: Track) => {
    setTrack(t)
    setStats(null)
    setRunKey((n) => n + 1)
    setScreen('play')
    if (record) void saveSongRecord({ ...record, lastInstrument: t.instrument })
  }

  const onFinish = useCallback(
    (s: Stats) => {
      setStats(s)
      setScreen('results')
      if (!record || !track) return
      const total = track.notes.length
      const next = withBest(record, track.instrument, {
        score: s.score,
        grade: grade(s, total),
        accuracy: accuracy(s, total),
        maxCombo: s.maxCombo,
        notes: total,
        at: Date.now(),
      })
      setRecord(next)
      void saveSongRecord(next)
    },
    [record, track]
  )

  const playing = screen === 'play'

  return (
    <div className={`app ${playing ? 'playing' : ''}`}>
      {!playing && (
        <header className="topbar">
          <button
            type="button"
            className="brand"
            onClick={() => {
              backToSongs()
              setSong(null)
            }}
          >
            <img src={mascot} alt="" className="brand-icon" />
            <h1>Luting Hero</h1>
            <span className="tagline">play your lutings</span>
          </button>
          <div className="topbar-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={toggleTheme}
              aria-label={settings.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title="Theme"
            >
              {settings.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
              title="Settings"
            >
              <Cog size={16} />
            </button>
          </div>
        </header>
      )}

      {screen === 'songs' && <SongPicker onPick={pickSong} />}

      {screen === 'instruments' && chart && song && (
        <InstrumentPicker
          chart={chart}
          songTitle={song.title}
          songText={song.text}
          record={record}
          onBack={backToSongs}
          onPick={pickTrack}
        />
      )}

      {screen === 'play' && chart && track && song && (
        <Suspense fallback={<div className="loading-stage">Warming up the highway…</div>}>
          <GameScreen
            key={runKey}
            chart={chart}
            track={track}
            songTitle={song.title}
            best={record?.best[track.instrument]}
            onQuit={() => setScreen('instruments')}
            onFinish={onFinish}
          />
        </Suspense>
      )}

      {screen === 'results' && stats && track && song && (
        <Results
          stats={stats}
          track={track}
          songTitle={song.title}
          onRetry={() => {
            setRunKey((n) => n + 1)
            setScreen('play')
          }}
          onChangeInstrument={() => setScreen('instruments')}
          onHome={backToSongs}
        />
      )}

      {showSettings && (
        <div className="overlay" role="dialog" aria-label="Settings" onClick={() => setShowSettings(false)}>
          <div className="overlay-card" onClick={(e) => e.stopPropagation()}>
            <div className="overlay-head">
              <h2>Settings</h2>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowSettings(false)}
                aria-label="Close settings"
              >
                <X size={16} />
              </button>
            </div>
            <SettingsPanel />
          </div>
        </div>
      )}

      {!playing && (
        <footer className="credits">
          Built on <a href="https://luteboi.com/">LuteBoi</a>’s luting notation.
        </footer>
      )}
    </div>
  )
}
