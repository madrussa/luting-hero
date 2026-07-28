import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sun, Moon, Settings as Cog, X } from 'lucide-react'
import { SongPicker } from './game/SongPicker'
import { InstrumentPicker } from './game/InstrumentPicker'
import { Results } from './game/Results'
import { SettingsPanel } from './game/SettingsPanel'
import { buildChart } from './game/chart'
import type { Track } from './game/chart'
import { addLuting } from './game/library'
import type { LibrarySong } from './game/library'
import type { Stats } from './game/judge'
import { toggleTheme, useSettings } from './game/settings'
import { lutingHash } from './game/hash'
import { playableTrack } from './game/easy'
import { hasSongLink, readSongLink } from './game/share'
import { bestKey, emptyRecord, loadSongRecord, saveSongRecord, withBest } from './game/songStore'
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
  // What a shared link did, said once and then dropped.
  const [linkNotice, setLinkNotice] = useState<string | null>(null)
  // The binding store is a module singleton, so it needs the record by ref
  // rather than through a closure that would go stale on the next edit.
  const recordRef = useRef<SongRecord | null>(null)
  recordRef.current = record

  // Key bindings belong to the song. Opening one installs its mapping (falling
  // back to whatever you last used); leaving puts that back.
  useEffect(() => leaveSongScope, [])

  /**
   * A shared song arrives in the URL's fragment, whole.
   *
   * On load *and* on every fragment change, because those are two different
   * arrivals: a cold open, and a link followed while the app is already running.
   * The second is a same-document navigation — nothing reloads, no effect re-runs
   * — so without `hashchange` the commonest case of all, clicking a friend's link
   * with the game open in a tab, would silently do nothing.
   *
   * The fragment is then taken out of the address bar: left there it would re-add
   * the song on every refresh, and travel on to whoever the tab or the URL were
   * passed to next.
   *
   * Adding without asking is safe, because the library is keyed by a hash of the
   * notation — a song you already have is recognised rather than duplicated — and
   * going straight to its instrument picker is the whole point of being sent a
   * link.
   */
  useEffect(() => {
    const openShared = () => {
      if (!hasSongLink(location.hash)) return
      const shared = readSongLink(location.hash)
      history.replaceState(null, '', location.pathname + location.search)
      if (!shared) {
        setLinkNotice('That shared link couldn’t be read — it may have been cut short on the way.')
        return
      }
      void addLuting(shared).then((res) => {
        const added = res.song ?? res.existing
        if (!added) {
          setLinkNotice('That shared link didn’t hold a playable luting.')
          return
        }
        setLinkNotice(
          res.status === 'duplicate'
            ? `“${added.title}” was already in your collection.`
            : `Added “${added.title}” from a shared link.`
        )
        pickSong(added)
      })
    }
    openShared()
    window.addEventListener('hashchange', openShared)
    return () => window.removeEventListener('hashchange', openShared)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Long enough to read, then out of the way.
  useEffect(() => {
    if (!linkNotice) return
    const t = setTimeout(() => setLinkNotice(null), 9000)
    return () => clearTimeout(t)
  }, [linkNotice])

  // Parsing is the expensive step, so it happens once per song rather than on
  // every screen change.
  const chart = useMemo(() => (song ? buildChart(song.text) : null), [song])

  // The chosen keyboard decides what the part actually is: easy mode folds it
  // onto at most eight keys and merges the notes that share one. Everything
  // downstream — the judge, the highway, the score, the results — sees the
  // folded part and nothing else, which is why it is resolved here, once,
  // rather than by each of them.
  const play = useMemo(
    () => (track ? playableTrack(track, settings.keyboard) : null),
    [track, settings.keyboard]
  )

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
      if (!record || !play) return
      const total = play.track.notes.length
      // Bests are kept per keyboard, not just per instrument: the same part on
      // eight folded keys and on the full chromatic keyboard are different
      // things to have done, and a score from one says nothing about the other.
      const next = withBest(record, bestKey(play.track.instrument, settings.keyboard), {
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
    [record, play, settings.keyboard]
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

      {!playing && linkNotice && <p className="notice link-notice">{linkNotice}</p>}

      {screen === 'songs' && <SongPicker onPick={pickSong} />}

      {screen === 'instruments' && chart && song && (
        <InstrumentPicker
          chart={chart}
          song={song}
          record={record}
          onBack={backToSongs}
          onPick={pickTrack}
        />
      )}

      {screen === 'play' && chart && play && song && (
        <Suspense fallback={<div className="loading-stage">Warming up the highway…</div>}>
          <GameScreen
            key={runKey}
            chart={chart}
            track={play.track}
            easy={play.easy}
            songTitle={song.title}
            best={record?.best[bestKey(play.track.instrument, settings.keyboard)]}
            onQuit={() => setScreen('instruments')}
            onFinish={onFinish}
          />
        </Suspense>
      )}

      {screen === 'results' && stats && play && song && (
        <Results
          stats={stats}
          track={play.track}
          song={song}
          keyboard={settings.keyboard}
          hitWindow={settings.hitWindow}
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
