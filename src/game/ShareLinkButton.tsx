// The song as a link, wherever it's offered.
//
// One component because it appears in two places — the song page and the results
// screen — and a share control that behaved differently in each would be a small
// mystery every time. Split in half like the score card's: the wide side takes
// the best route the browser offers, the icon side goes straight to the
// clipboard, which is what most people want on a desktop.

import { useState } from 'react'
import { Check, Copy, Link2 } from 'lucide-react'
import type { LibrarySong } from './library'
import { copyText } from './clipboard'
import { songLink } from './share'

export function ShareLinkButton({ song }: { song: LibrarySong }) {
  /** which half acted, and what it managed; one message for one control */
  const [said, setSaid] = useState<{ from: 'share' | 'copy'; word: string } | null>(null)

  const report = (from: 'share' | 'copy', word: string) => {
    setSaid({ from, word })
    setTimeout(() => setSaid(null), 2000)
  }

  // Built at the moment of asking rather than per render: it deflates the whole
  // luting, and nothing needs it until a button is pressed.
  const url = () => songLink(song, `${location.origin}${location.pathname}`)

  const copy = async () => report('copy', (await copyText(url())) ? 'Link copied' : 'Couldn’t copy')

  const share = async () => {
    // On a phone this offers the messaging apps; everywhere else it copies.
    if (navigator.share) {
      try {
        await navigator.share({ title: song.title, text: `${song.title} on Luting Hero`, url: url() })
        return report('share', 'Shared')
      } catch (err) {
        // A cancelled share sheet is not a failure to fall back from.
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    }
    return copy()
  }

  return (
    <span className="btn-split">
      <button
        type="button"
        className="btn"
        onClick={() => void share()}
        title="A link with the whole song in it — opening it adds the song"
      >
        {said ? <Check size={15} /> : <Link2 size={15} />}
        {said ? said.word : 'Share song'}
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => void copy()}
        aria-label="Copy the song link to the clipboard"
        title="Copy the song link to the clipboard"
      >
        {said?.from === 'copy' ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </span>
  )
}
