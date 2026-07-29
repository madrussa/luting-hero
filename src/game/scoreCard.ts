// The shareable score card: a run drawn onto a canvas and handed to whatever
// the browser can hand it to.
//
// Drawn rather than screenshotted. A screenshot of the results screen would be
// the wrong shape for a chat window, would carry the buttons, and would depend on
// the window it happened to be in. This is a fixed 1200×630 — the aspect every
// chat client and social preview expects — so it looks the same wherever it lands.

import { grade as gradeOf, accuracy as accuracyOf, maxScoreFor } from './judge'
import type { Stats } from './judge'
import type { Track } from './chart'
import mascot from '../assets/luting.webp'

export interface ScoreCard {
  songTitle: string
  artist: string
  track: Track
  stats: Stats
  /** "Super EZ", "Easy" … — the keyboard it was played on */
  keyboardLabel: string
  /** "Normal ±130 ms" — the timing window it was judged by */
  windowLabel: string
  /** the condition code, printed so two players can compare rules */
  code: string
}

const W = 1200
const H = 630

// The playfield's palette, because that is what the player was looking at.
const INK = '#e8e4f5'
const DIM = '#9b93b8'
const ACCENT = '#9d7bff'
const MINT = '#5ad1b3'
const DANGER = '#ff7a90'
const PANEL = '#242038'

/**
 * Where the card came from, printed on it. A score card is the one thing here
 * that travels — it gets pasted into chats by people who have never seen the
 * app — and without this it is a picture of a game nobody can go and find.
 * Scheme dropped because every client linkifies it anyway and `https://` is
 * three syllables of nothing on a poster.
 */
const SITE = 'madrussa.github.io/luting-hero'

const SANS = "'Avenir Next', 'Segoe UI', system-ui, sans-serif"
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace"

const font = (size: number, weight = 400, family = SANS) => `${weight} ${size}px ${family}`

/** Grade colours, matching the results screen so the two read as one thing. */
const gradeColour = (g: string): string => (g === 'S' ? MINT : g === 'D' || g === 'F' ? DANGER : ACCENT)

/** Draw `text` at most `max` wide, trimming to an ellipsis rather than spilling. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let cut = text
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > max) cut = cut.slice(0, -1)
  return `${cut}…`
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** A bordered label — the keyboard and the timing window. Returns its width. */
function pill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, colour: string): number {
  ctx.font = font(21, 600)
  const w = ctx.measureText(text).width + 36
  const h = 44
  ctx.fillStyle = PANEL
  roundRect(ctx, x, y, w, h, h / 2)
  ctx.fill()
  ctx.strokeStyle = colour
  ctx.lineWidth = 2
  roundRect(ctx, x + 1, y + 1, w - 2, h - 2, (h - 2) / 2)
  ctx.stroke()
  ctx.fillStyle = colour
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + 18, y + h / 2 + 1)
  ctx.textBaseline = 'alphabetic'
  return w
}

/** One tally: a dim label with a value under it. */
function stat(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  value: string,
  colour = INK
): void {
  ctx.fillStyle = DIM
  ctx.font = font(17, 600)
  ctx.fillText(label.toUpperCase(), x, y)
  ctx.fillStyle = colour
  ctx.font = font(34, 700)
  ctx.fillText(value, x, y + 40)
}

const loadMascot = (): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null) // the card is fine without it
    img.src = mascot
  })

/**
 * Render the card. Async only because of the mascot: everything else is drawn
 * synchronously, so the caller can have the blob ready before the player clicks
 * Share — which matters, because a share sheet has to open inside the gesture
 * that asked for it and an await in between can lose that right.
 */
export async function drawScoreCard(card: ScoreCard): Promise<Blob> {
  const { stats, track } = card
  const total = track.notes.length
  const g = gradeOf(stats, total)
  const acc = accuracyOf(stats, total)

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  // Background: the highway's own dark, with its glow behind the grade.
  const bg = ctx.createLinearGradient(0, 0, W * 0.4, H)
  bg.addColorStop(0, '#14121f')
  bg.addColorStop(1, '#1d1a2e')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  const glow = ctx.createRadialGradient(W - 250, 230, 20, W - 250, 230, 420)
  glow.addColorStop(0, 'rgba(157, 123, 255, 0.28)')
  glow.addColorStop(1, 'rgba(157, 123, 255, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, H)

  // One place for the vertical rhythm, so nothing lands on top of anything
  // else: the bottom strip in particular has to hold six tallies and the code
  // side by side, and eyeballing that is how they end up overlapping.
  const pad = 64
  const y = {
    brand: 70,
    title: 150,
    artist: 188,
    instrument: 256,
    voices: 284,
    pills: 306,
    score: 448,
    accuracy: 490,
    stripLabel: 552,
    stripValue: 594,
  }
  /** the left column stops short of the grade and the mascot */
  const textMax = W - pad - 380
  ctx.textBaseline = 'alphabetic'

  // Branding, small and out of the way, with the address opposite it: same
  // size and weight so the two read as one line across the top rather than as
  // a title and a footnote that wandered up there.
  ctx.fillStyle = DIM
  ctx.font = font(19, 700)
  ctx.letterSpacing = '3px'
  ctx.fillText('LUTING HERO', pad, y.brand)
  ctx.letterSpacing = '1px'
  ctx.fillStyle = MINT
  ctx.textAlign = 'right'
  ctx.fillText(SITE, W - pad, y.brand)
  ctx.textAlign = 'left'
  ctx.letterSpacing = '0px'

  // The song.
  ctx.fillStyle = INK
  ctx.font = font(56, 800)
  ctx.fillText(fit(ctx, card.songTitle, textMax), pad, y.title)
  if (card.artist) {
    ctx.fillStyle = DIM
    ctx.font = font(24, 500)
    ctx.fillText(fit(ctx, card.artist, textMax), pad, y.artist)
  }

  // The instrument, given the room it deserves: it is the answer to "what did
  // you play", which a score alone never tells you.
  ctx.fillStyle = INK
  ctx.font = font(48)
  ctx.fillText(track.icon, pad, y.instrument)
  const iconW = ctx.measureText(track.icon).width
  ctx.fillStyle = MINT
  ctx.font = font(40, 800)
  ctx.fillText(fit(ctx, track.name, textMax - iconW - 18), pad + iconW + 18, y.instrument - 3)
  if (track.voices.length > 1) {
    ctx.fillStyle = DIM
    ctx.font = font(20, 500)
    ctx.fillText(`${track.voices.length} voices merged`, pad + iconW + 20, y.voices)
  }

  // The rules it was played under.
  const used = pill(ctx, pad, y.pills, card.keyboardLabel, ACCENT)
  pill(ctx, pad + used + 14, y.pills, card.windowLabel, DIM)

  // Score and accuracy.
  const score = stats.score.toLocaleString()
  ctx.fillStyle = INK
  ctx.font = font(76, 800)
  ctx.fillText(score, pad, y.score)
  const scoreW = ctx.measureText(score).width
  ctx.fillStyle = DIM
  ctx.font = font(26, 500)
  ctx.fillText(`/ ${maxScoreFor(track.notes).toLocaleString()}`, pad + scoreW + 14, y.score)
  ctx.fillStyle = MINT
  ctx.font = font(30, 700)
  ctx.fillText(`${(acc * 100).toFixed(1)}% accuracy`, pad, y.accuracy)

  // The tallies, along the bottom left. Six columns of 130 stop at 844, which is
  // what leaves the bottom right for the code.
  const cols = [
    ['Perfect', String(stats.perfect), MINT],
    ['Great', String(stats.great), ACCENT],
    ['Good', String(stats.good), INK],
    ['Missed', String(stats.miss), DANGER],
    ['Wrong', String(stats.wrong), DIM],
    ['Best combo', `${stats.maxCombo}`, stats.maxCombo === total && total > 0 ? MINT : INK],
  ] as const
  cols.forEach(([label, value, colour], i) =>
    stat(ctx, pad + i * 130, y.stripLabel, label, value, colour)
  )

  // The grade, in the glow.
  const cx = W - 232
  const cy = 216
  ctx.beginPath()
  ctx.arc(cx, cy, 96, 0, Math.PI * 2)
  ctx.fillStyle = '#191630'
  ctx.fill()
  ctx.strokeStyle = gradeColour(g)
  ctx.lineWidth = 5
  ctx.stroke()
  ctx.fillStyle = gradeColour(g)
  ctx.font = font(104, 800)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(g, cx, cy + 6)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  // The mascot, mirrored. He is drawn facing right, and sitting in the bottom
  // right corner that points him off the edge of the card; flipped, he faces
  // back across it, at the grade and the score.
  const img = await loadMascot()
  if (img) {
    const mx = W - 176
    const my = cy + 112
    ctx.save()
    ctx.translate(mx + 128, my)
    ctx.scale(-1, 1)
    ctx.drawImage(img, 0, 0, 128, 128)
    ctx.restore()
  }

  // The code, bottom right and clear of the tallies, with what it means beside
  // it: a code nobody can read is decoration, and this one is the whole point of
  // sharing a picture.
  ctx.textAlign = 'right'
  ctx.fillStyle = DIM
  ctx.font = font(16, 600)
  ctx.letterSpacing = '1px'
  ctx.fillText('SAME CHART, SAME RULES', W - pad, y.stripLabel)
  ctx.letterSpacing = '0px'
  ctx.fillStyle = INK
  ctx.font = font(32, 700, MONO)
  ctx.fillText(card.code, W - pad, y.stripValue)
  ctx.textAlign = 'left'

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas'))), 'image/png')
  })
}

export type ShareOutcome = 'shared' | 'copied' | 'downloaded' | 'failed'

/**
 * Put the card on the clipboard, ready to paste into a chat.
 *
 * Its own function because it is also its own button: pasting is what most
 * people actually do with a score card on a desktop, and going through the share
 * sheet to get there is two dialogs too many. Fails rather than falling back —
 * the button that asked for the clipboard specifically shouldn't quietly do
 * something else, and the other half of the control still offers a file.
 */
export async function copyScoreCard(blob: Blob): Promise<'copied' | 'failed'> {
  try {
    if (navigator.clipboard && 'write' in navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return 'copied'
    }
  } catch {
    // no image clipboard here (Firefox, or an insecure origin)
  }
  return 'failed'
}

/**
 * Get the card to wherever it can go, best first: the system share sheet, the
 * clipboard, then a download. Three paths because support is genuinely uneven —
 * file sharing is a phone and Windows feature, image-to-clipboard is a desktop
 * one — and a Share button that silently does nothing is worse than one that
 * saves a file.
 */
export async function shareScoreCard(blob: Blob, filename: string, text: string): Promise<ShareOutcome> {
  const file = new File([blob], filename, { type: 'image/png' })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text })
      return 'shared'
    } catch (err) {
      // A cancelled share sheet is not a failure to fall back from.
      if (err instanceof DOMException && err.name === 'AbortError') return 'shared'
    }
  }
  if ((await copyScoreCard(blob)) === 'copied') return 'copied'
  try {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return 'downloaded'
  } catch {
    return 'failed'
  }
}
