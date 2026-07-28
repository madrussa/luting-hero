// End-of-run summary.

import { useEffect, useState } from 'react'
import { RotateCcw, ListMusic, Home, Share2, Check, Download, Copy } from 'lucide-react'
import { accuracy, grade, maxScoreFor } from './judge'
import type { Stats } from './judge'
import type { Track } from './chart'
import { KEYBOARD_LABELS } from './easy'
import { hitWindowById } from './settings'
import type { KeyboardMode } from './settings'
import { conditionCode } from './share'
import { drawScoreCard, shareScoreCard } from './scoreCard'
import type { ShareOutcome } from './scoreCard'
import dumb from '../assets/dumb.webp'
import mascot from '../assets/luting.webp'

interface Props {
  stats: Stats
  track: Track
  songTitle: string
  artist: string
  /** lutingHash of the song, for the condition code */
  songHash: string
  /** the keyboard it was played on */
  keyboard: KeyboardMode
  /** HitWindow id it was judged by */
  hitWindow: string
  onRetry: () => void
  onChangeInstrument: () => void
  onHome: () => void
}

/** What a shared image did, so the button can say so. */
const SHARE_SAID: Record<ShareOutcome, string> = {
  shared: 'Shared',
  copied: 'Copied',
  downloaded: 'Saved',
  failed: 'Couldn’t share',
}

export function Results({
  stats,
  track,
  songTitle,
  artist,
  songHash,
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
  const code = conditionCode({ songHash, instrument: track.instrument, keyboard, hitWindow })

  // The card is drawn as soon as the run ends, not when Share is clicked: a
  // share sheet has to open inside the gesture that asked for it, and awaiting a
  // canvas in between is enough for a browser to refuse.
  const [card, setCard] = useState<Blob | null>(null)
  const [said, setSaid] = useState<ShareOutcome | null>(null)
  useEffect(() => {
    let live = true
    void drawScoreCard({
      songTitle,
      artist,
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

  const share = async () => {
    if (!card) return
    const name = `${songTitle} — ${track.name} (${keyboardLabel}).png`.replace(/[/\\?%*:|"<>]/g, '-')
    setSaid(
      await shareScoreCard(
        card,
        name,
        `${songTitle} — ${track.name} · ${keyboardLabel} · ${stats.score.toLocaleString()} · ${g} · ${code}`
      )
    )
    setTimeout(() => setSaid(null), 2600)
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
        {songTitle}
        {artist && <span className="sub">{artist}</span>}
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
        <button
          type="button"
          className="btn"
          onClick={() => void share()}
          disabled={!card}
          title="A score card with the code on it, to share or save"
        >
          {said === null ? (
            <Share2 size={15} />
          ) : said === 'copied' ? (
            <Copy size={15} />
          ) : said === 'downloaded' ? (
            <Download size={15} />
          ) : (
            <Check size={15} />
          )}
          {said === null ? 'Share score' : SHARE_SAID[said]}
        </button>
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
