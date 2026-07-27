// End-of-run summary.

import { RotateCcw, ListMusic, Home } from 'lucide-react'
import { accuracy, grade, maxScoreFor } from './judge'
import type { Stats } from './judge'
import type { Track } from './chart'
import dumb from '../assets/dumb.webp'
import mascot from '../assets/luting.webp'

interface Props {
  stats: Stats
  track: Track
  songTitle: string
  onRetry: () => void
  onChangeInstrument: () => void
  onHome: () => void
}

export function Results({ stats, track, songTitle, onRetry, onChangeInstrument, onHome }: Props) {
  const total = track.notes.length
  const g = grade(stats, total)
  const acc = accuracy(stats, total)
  const fullCombo = stats.maxCombo === total && total > 0

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
        <span className="sub">
          {track.icon} {track.name}
        </span>
      </h2>

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

      <div className="overlay-actions">
        <button type="button" className="btn primary" onClick={onRetry}>
          <RotateCcw size={15} /> Play again
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
