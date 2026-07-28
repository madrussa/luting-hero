// Choosing which instrument to play. Every track here is one instrument's
// whole part, however many luting voices it was written across.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Play, Layers, Volume2, Loader, Trophy, Square, Copy, Check } from 'lucide-react'
import type { SongRecord } from './songStore'
import { toLuteFile } from './library'
import type { LibrarySong } from './library'
import type { Chart, Track } from './chart'
import { noteName } from './lanes'
import { DRUM_SOUNDS } from '../luting-core/luting'
import {
  previewInstrument,
  stopPlayback,
  playLuting,
  getActivePlaybackId,
  subscribePlayback,
} from '../luting-core/player'
import { getPlaybackMode, loadBank } from '../luting-core/samples'
import { updateSettings, useSettings } from './settings'
import type { KeyboardMode } from './settings'
import { KEYBOARD_LABELS, MAX_EASY_KEYS, MAX_SUPER_EZ_KEYS, playableTrack } from './easy'
import type { EasyMap } from './easy'
import { bestKey } from './songStore'
import { copyText } from './clipboard'
import { ShareLinkButton } from './ShareLinkButton'
import conducting from '../assets/conducting.webp'

interface Props {
  chart: Chart
  /** the whole library entry: its notation previews, and its metadata shares */
  song: LibrarySong
  /** what we remember about this song; null until IndexedDB answers */
  record: SongRecord | null
  onBack: () => void
  onPick: (track: Track) => void
}

/** playback id for the whole-song preview, so its button knows it's live */
const PREVIEW_ID = 'song-preview'

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * What this part will ask your hands for on the chosen keyboard: how many keys,
 * and — when they were folded to get there — how many pitches went onto them.
 * The fold is the whole reason easy mode exists, so it says so out loud rather
 * than quietly drawing a smaller keyboard.
 */
function describeKeys(track: Track, easy: EasyMap | null, mode: KeyboardMode): string {
  if (easy) {
    const covered = track.isDrums ? track.drums.length : track.pitches.length
    const keys = plural(easy.keys.length, track.isDrums ? 'pad' : 'key')
    const folded = easy.keys.some((k) => k.folded)
      ? ` · ${covered} ${track.isDrums ? 'pieces' : 'pitches'} folded in`
      : ''
    return track.isDrums
      ? `${keys}: ${easy.keys.map((k) => k.label).slice(0, 4).join(', ')}${easy.keys.length > 4 ? '…' : ''}${folded}`
      : `${keys} · ${noteName(track.lowMidi)}–${noteName(track.highMidi)}${folded}`
  }
  if (track.isDrums) {
    const names = track.drums.slice(0, 4).map((k) => DRUM_SOUNDS[k]?.name ?? k)
    return `${plural(track.drums.length, 'kit piece')}: ${names.join(', ')}${track.drums.length > 4 ? '…' : ''}`
  }
  const range = `${noteName(track.lowMidi)}–${noteName(track.highMidi)}`
  return mode === 'hard'
    ? `${plural(track.pitches.length, 'key')} · ${range}`
    : `${range} · ${track.difficulty.span} semitones`
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="stars" title={`${rating} of 10`} aria-label={`Difficulty ${rating} of 10`}>
      {Array.from({ length: 10 }, (_, i) => (
        <i key={i} className={i < rating ? 'on' : ''} />
      ))}
    </span>
  )
}

export function InstrumentPicker({ chart, song, record, onBack, onPick }: Props) {
  const { keyboard } = useSettings()
  const [copied, setCopied] = useState(false)

  // Every card describes the part *as the chosen keyboard will ask for it*.
  // That matters most in easy mode, where the fold genuinely changes the part —
  // fewer keys, chords collapsed, a lower rating — and a card still quoting the
  // unfolded numbers would be describing a mode you aren't about to play.
  const cards = useMemo(
    () =>
      chart.tracks
        .map((source) => ({ source, ...playableTrack(source, keyboard) }))
        .sort((a, b) => a.track.difficulty.rating - b.track.difficulty.rating),
    [chart, keyboard]
  )

  // Which instrument is being auditioned. In sample mode the preview waits for
  // that instrument's pack, so this doubles as the spinner — and warms the pack
  // the run is about to need.
  const [busy, setBusy] = useState<string | null>(null)

  // An audition or preview left running would play over the count-in.
  useEffect(() => stopPlayback, [])

  // The vendored engine allows one playback at a time, so a preview and an
  // instrument audition naturally interrupt each other — which is what you
  // want, and means one subscription covers both.
  const activeId = useSyncExternalStore(subscribePlayback, getActivePlaybackId)
  const previewing = activeId === PREVIEW_ID

  const togglePreview = async () => {
    if (previewing) return stopPlayback()
    setBusy(PREVIEW_ID)
    try {
      // Warm the packs first so the preview doesn't open on the synth and
      // change instrument under you a bar later.
      if (getPlaybackMode() === 'quality') {
        await Promise.all([...new Set(chart.allNotes.map((n) => n.instrument))].map(loadBank))
      }
      playLuting(song.text, { id: PREVIEW_ID })
    } finally {
      setBusy((b) => (b === PREVIEW_ID ? null : b))
    }
  }

  // Shared *with* its `//Title` / `//Author:` header lines, which is what lets
  // whoever receives it paste the one blob and have the fields fill themselves
  // in. The hash ignores comments, so a shared copy still dedupes against the
  // same song if they already have it under another name.
  const copySong = async () => {
    await copyText(toLuteFile(song))
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const audition = async (code: string) => {
    setBusy(code)
    try {
      await previewInstrument(code)
    } finally {
      setBusy((b) => (b === code ? null : b))
    }
  }

  return (
    <div className="instrument-picker">
      <div className="picker-head">
        <button type="button" className="btn ghost" onClick={onBack}>
          <ArrowLeft size={15} /> Songs
        </button>
        <h2>
          {song.title}
          <span className="sub">
            {chart.bpm} #lute · {mmss(chart.durationSec)} · {chart.allNotes.length.toLocaleString()} notes
          </span>
        </h2>
        <button
          type="button"
          className={`btn ${previewing ? 'primary' : ''}`}
          onClick={() => void togglePreview()}
          disabled={busy === PREVIEW_ID}
        >
          {busy === PREVIEW_ID ? (
            <Loader size={15} className="spin" />
          ) : previewing ? (
            <Square size={15} />
          ) : (
            <Play size={15} />
          )}
          {previewing ? 'Stop' : busy === PREVIEW_ID ? 'Loading…' : 'Preview song'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void copySong()}
          title="Copy the luting, with its title and artist, ready to paste"
        >
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy luting'}
        </button>
        <ShareLinkButton song={song} />
        <img src={conducting} alt="" className="picker-mascot" />
      </div>

      {/* Easy is the default, not Super EZ: four keys is the floor for whoever
          needs it, rather than what everyone should meet the game on. Most parts
          ask for more keys than one hand can hold, and a part you can't
          physically reach isn't a difficulty. */}
      <div className="mode-switch" role="radiogroup" aria-label="Keyboard">
        {(
          [
            ['superez', `${MAX_SUPER_EZ_KEYS} keys, never faster than a hand`],
            ['easy', `at most ${MAX_EASY_KEYS} keys, chords folded onto one`],
            ['hard', 'one key per note the part plays'],
            ['impossible', 'the full keyboard across its range'],
          ] as const
        ).map(([value, hint]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={keyboard === value}
            className={`mode-option ${keyboard === value ? 'on' : ''}`}
            onClick={() => updateSettings({ keyboard: value })}
          >
            <strong>{KEYBOARD_LABELS[value]}</strong>
            <span>{hint}</span>
          </button>
        ))}
      </div>

      {chart.warnings.length > 0 && (
        <ul className="warnings">
          {chart.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <div className="track-grid">
        {cards.map(({ source, track: t, easy }) => {
          const d = t.difficulty
          const best = record?.best[bestKey(t.instrument, keyboard)]
          return (
            // A div wrapping two buttons, not one button: the audition control
            // has to be independently clickable, and a button inside a button
            // is invalid markup that browsers resolve however they like.
            <div
              key={t.instrument}
              className={`track-card ${record?.lastInstrument === t.instrument ? 'last-played' : ''}`}
            >
              {/* The unfolded part is what's picked: the fold is a property of
                  the keyboard, and is re-derived from the setting downstream. */}
              <button type="button" className="track-pick" onClick={() => onPick(source)}>
              <span className="track-icon" aria-hidden="true">
                {t.icon}
              </span>
              <span className="track-body">
                <span className="track-name">
                  {t.name}
                  {t.voices.length > 1 && (
                    <em className="merged-badge" title={`Luting voices ${t.voices.map((v) => v + 1).join(', ')} play this instrument and are merged into one part`}>
                      <Layers size={11} /> {t.voices.length} voices
                    </em>
                  )}
                </span>
                <span className="track-diff">
                  <Stars rating={d.rating} />
                  <strong>{d.label}</strong>
                </span>
                <span className="track-meta">
                  {t.notes.length.toLocaleString()} notes
                  {/* Says why the count differs from the other keyboards': a
                      folded key can't be struck twice at once, or twice in a
                      hurry, so some of the part's notes ride along with a press
                      instead of asking for their own. */}
                  {source.notes.length > t.notes.length && (
                    <em
                      title={`${source.notes.length - t.notes.length} of this part's ${source.notes.length} notes land on a key that is already being struck — they still sound, but they need no press of their own`}
                    >
                      {' '}
                      ({(source.notes.length - t.notes.length).toLocaleString()} merged)
                    </em>
                  )}{' '}
                  · {d.nps}/s avg, {d.peakNps}/s peak
                  {d.maxChord > 1 && ` · up to ${d.maxChord} at once`}
                </span>
                {best && (
                  <span className="track-best">
                    <Trophy size={11} /> {best.score.toLocaleString()} · {best.grade} ·{' '}
                    {(best.accuracy * 100).toFixed(0)}%
                  </span>
                )}
                <span className="track-range">{describeKeys(t, easy, keyboard)}</span>
              </span>
                <span className="track-go" aria-hidden="true">
                  <Play size={16} />
                </span>
              </button>
              <button
                type="button"
                className={`track-audition ${busy === t.instrument ? 'busy' : ''}`}
                aria-label={`Hear the ${t.name}`}
                title={`Hear the ${t.name}`}
                onClick={() => void audition(t.instrument)}
              >
                {busy === t.instrument ? <Loader size={15} /> : <Volume2 size={15} />}
              </button>
            </div>
          )
        })}
      </div>

      <p className="hint">
        Everything you don’t pick keeps playing behind you. Where a luting spreads one
        instrument over several voices — the only way its syntax can overlap notes — those
        voices are merged back into a single part here, so you play all of it.
      </p>
    </div>
  )
}
