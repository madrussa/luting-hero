// End-of-run summary.

import { useEffect, useState } from 'react'
import { RotateCcw, ListMusic, Home, Share2, Check, Download, Copy, X, ImageIcon } from 'lucide-react'
import { accuracy, grade, maxScoreFor } from './judge'
import type { Stats } from './judge'
import type { Track } from './chart'
import type { LibrarySong } from './library'
import { ShareLinkButton } from './ShareLinkButton'
import { KEYBOARD_LABELS } from './easy'
import { hitWindowById } from './settings'
import type { KeyboardMode } from './settings'
import { conditionCode } from './share'
import { copyScoreCard, drawScoreCard, shareScoreCard } from './scoreCard'
import type { ShareOutcome } from './scoreCard'
import dumb from '../assets/dumb.webp'
import mascot from '../assets/luting.webp'

interface Props {
  stats: Stats
  track: Track
  /** the library entry: its title and artist for the card, its notation for the link */
  song: LibrarySong
  /** the keyboard it was played on */
  keyboard: KeyboardMode
  /** HitWindow id it was judged by */
  hitWindow: string
  onRetry: () => void
  onChangeInstrument: () => void
  onHome: () => void
}

/** What the card ended up doing, so the button can say so. */
const SHARE_SAID: Record<ShareOutcome, string> = {
  shared: 'Shared',
  copied: 'Copied',
  downloaded: 'Saved',
  failed: 'Couldn’t share',
}

/** The clipboard half can only fail one way, and it isn't "couldn't share". */
const saidWord = (from: 'share' | 'copy', outcome: ShareOutcome): string =>
  from === 'copy' && outcome === 'failed' ? 'Couldn’t copy' : SHARE_SAID[outcome]

/** The route the card took, so the icon agrees with the word beside it. */
const SaidIcon = ({ outcome }: { outcome: ShareOutcome }) =>
  outcome === 'copied' ? (
    <Copy size={15} />
  ) : outcome === 'downloaded' ? (
    <Download size={15} />
  ) : outcome === 'failed' ? (
    <X size={15} />
  ) : (
    <Check size={15} />
  )

export function Results({
  stats,
  track,
  song,
  keyboard,
  hitWindow,
  onRetry,
  onChangeInstrument,
  onHome,
}: Props) {
  const total = track.notes.length
  const g = grade(stats, total)
  const acc = accuracy(stats, total)
  const fullCombo = stats.maxCombo === total && total > 0

  const window_ = hitWindowById(hitWindow)
  const keyboardLabel = KEYBOARD_LABELS[keyboard]
  const windowLabel = `${window_.label} ±${window_.good} ms`
  const code = conditionCode({
    songHash: song.hash,
    instrument: track.instrument,
    keyboard,
    hitWindow,
  })

  // The card is drawn as soon as the run ends, not when Share is clicked: a
  // share sheet has to open inside the gesture that asked for it, and awaiting a
  // canvas in between is enough for a browser to refuse.
  const [card, setCard] = useState<Blob | null>(null)
  // Which half of the split button acted, and what came of it. The message goes
  // on the label whichever half it was — they are one control, so one answer.
  const [said, setSaid] = useState<{ from: 'share' | 'copy'; outcome: ShareOutcome } | null>(null)
  useEffect(() => {
    let live = true
    void drawScoreCard({
      songTitle: song.title,
      artist: song.artist,
      track,
      stats,
      keyboardLabel,
      windowLabel,
      code,
    })
      .then((blob) => live && setCard(blob))
      .catch(() => {})
    return () => {
      live = false
    }
    // Drawn once for this run; nothing in it changes while the screen is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const report = (from: 'share' | 'copy', outcome: ShareOutcome) => {
    setSaid({ from, outcome })
    setTimeout(() => setSaid(null), 2600)
  }

  const share = async () => {
    if (!card) return
    const name = `${song.title} — ${track.name} (${keyboardLabel}).png`.replace(/[/\\?%*:|"<>]/g, '-')
    report(
      'share',
      await shareScoreCard(
        card,
        name,
        `${song.title} — ${track.name} · ${keyboardLabel} · ${stats.score.toLocaleString()} · ${g} · ${code}`
      )
    )
  }

  const copy = async () => {
    if (!card) return
    report('copy', await copyScoreCard(card))
  }

  // A consistent bias is worth calling out — it's a setting away from fixed,
  // and players otherwise spend a long time blaming themselves for latency.
  const bias = stats.biasMs
  const biasAdvice =
    Math.abs(bias) < 18 || stats.perfect + stats.great + stats.good < 8
      ? null
      : bias > 0
        ? `You're landing ${bias} ms late on average. Try a calibration offset of ${-bias} ms.`
        : `You're landing ${-bias} ms early on average. Try a calibration offset of ${-bias} ms.`

  return (
    <div className="results">
      <div className={`grade grade-${g}`}>
        <span>{g}</span>
      </div>

      <h2>
        {song.title}
        {song.artist && <span className="sub">{song.artist}</span>}
      </h2>

      {/* The instrument is the other half of what you just did — a score with no
          part attached says nothing — so it gets its own line at its own size. */}
      <p className="results-instrument">
        <span aria-hidden="true">{track.icon}</span> {track.name}
        {track.voices.length > 1 && <em>{track.voices.length} voices merged</em>}
      </p>

      {/* And the rules it was played under, which change what the number means. */}
      <p className="results-rules">
        <span className="rule keyboard">{keyboardLabel}</span>
        <span className="rule" title={`Perfect ±${window_.perfect} ms · Great ±${window_.great} ms · Good ±${window_.good} ms`}>
          {windowLabel}
        </span>
      </p>

      <img src={g === 'F' || g === 'D' ? dumb : mascot} alt="" className="results-mascot" />

      {fullCombo && <p className="full-combo">Full combo!</p>}

      <div className="score-big">
        {stats.score.toLocaleString()}
        <em> / {maxScoreFor(track.notes).toLocaleString()}</em>
      </div>
      <div className="acc-big">{(acc * 100).toFixed(1)}% accuracy</div>

      <dl className="tally">
        <div className="perfect">
          <dt>Perfect</dt>
          <dd>{stats.perfect}</dd>
        </div>
        <div className="great">
          <dt>Great</dt>
          <dd>{stats.great}</dd>
        </div>
        <div className="good">
          <dt>Good</dt>
          <dd>{stats.good}</dd>
        </div>
        <div className="miss">
          <dt>Missed</dt>
          <dd>{stats.miss}</dd>
        </div>
        <div>
          <dt>Wrong notes</dt>
          <dd>{stats.wrong}</dd>
        </div>
        {stats.late > 0 && (
          <div className="late">
            <dt>Late saves</dt>
            <dd>
              {stats.late}
              <em> at half value</em>
            </dd>
          </div>
        )}
        {stats.holdable > 0 && (
          <div className="held">
            <dt>Sustains held</dt>
            <dd>
              {Math.round(stats.heldFraction * 100)}
              <em>% of {stats.holdable}</em>
            </dd>
          </div>
        )}
        <div>
          <dt>Best combo</dt>
          <dd>
            {stats.maxCombo}
            <em> / {total}</em>
          </dd>
        </div>
        <div>
          <dt>Average error</dt>
          <dd>
            {stats.meanErrorMs}
            <em> ms</em>
          </dd>
        </div>
        <div>
          <dt>Timing bias</dt>
          <dd>
            {bias > 0 ? `+${bias}` : bias}
            <em> ms {bias === 0 ? '' : bias > 0 ? 'late' : 'early'}</em>
          </dd>
        </div>
      </dl>

      {biasAdvice && <p className="hint calibrate">{biasAdvice}</p>}

      {/* The code, on screen as well as on the image, so it can be quoted in a
          chat without sending a picture at all. */}
      <p className="results-code">
        <code>{code}</code>
        <span>
          Same code, same song, part, keyboard and window — so a score is worth
          comparing. It isn’t proof: nothing the game prints about itself can be.
        </span>
      </p>

      <div className="overlay-actions">
        <button type="button" className="btn primary" onClick={onRetry}>
          <RotateCcw size={15} /> Play again
        </button>
        {/* Share, and — because pasting into a chat is what most people are
            actually doing — a second half that goes straight to the clipboard
            instead of through the share sheet. */}
        <span className="btn-split">
          <button
            type="button"
            className="btn"
            onClick={() => void share()}
            disabled={!card}
            title="A score card with the code on it, to share or save"
          >
            {said === null ? <Share2 size={15} /> : <SaidIcon outcome={said.outcome} />}
            {said === null ? 'Share score' : saidWord(said.from, said.outcome)}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void copy()}
            disabled={!card}
            aria-label="Copy the score card to the clipboard"
            title="Copy the score card to the clipboard"
          >
            {said?.from === 'copy' && said.outcome === 'copied' ? (
              <Check size={15} />
            ) : (
              <ImageIcon size={15} />
            )}
          </button>
        </span>
        {/* The song itself, so whoever you just sent a score to can play it. */}
        <ShareLinkButton song={song} />
        <button type="button" className="btn" onClick={onChangeInstrument}>
          <ListMusic size={15} /> Another instrument
        </button>
        <button type="button" className="btn ghost" onClick={onHome}>
          <Home size={15} /> Song list
        </button>
      </div>
    </div>
  )
}
