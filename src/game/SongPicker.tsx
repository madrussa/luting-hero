// Your collection.
//
// Nothing ships with the app: every luting here was added by you, and lives in
// this browser. So this screen is as much a library manager as a menu — add,
// import, export, delete — and its empty state has to teach the whole thing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Upload, Search, ClipboardPaste, Music, Download, Trash2, Plus, X, Loader,
} from 'lucide-react'
import {
  addLuting, deleteLibrarySong, downloadBlob, exportCollection, importFiles,
  listLibrary, looksLikeLuting, readLuteHeader,
} from './library'
import type { LibrarySong } from './library'
import { buildChart } from './chart'
import mascot from '../assets/luting.webp'

interface Props {
  onPick: (song: LibrarySong) => void
}

/** Cheap enough to run over the whole collection, and it makes the list honest. */
function summarise(text: string): { notes: number; instruments: number; durationSec: number } | null {
  try {
    const chart = buildChart(text)
    return {
      notes: chart.allNotes.length,
      instruments: chart.tracks.length,
      durationSec: chart.durationSec,
    }
  } catch {
    return null
  }
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

export function SongPicker({ onPick }: Props) {
  const [songs, setSongs] = useState<LibrarySong[] | null>(null)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // the paste form
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [text, setText] = useState('')
  // Whether the player has typed in a field themselves. A luting copied from
  // here (or exported as a .lute) carries its `//Title` / `//Author:` lines, so
  // pasting one can fill these in — but only while they're still ours to fill.
  // Once you've typed a title, no amount of re-pasting overwrites it.
  const [edited, setEdited] = useState({ title: false, artist: false })

  const pasteLuting = (value: string) => {
    setText(value)
    const head = readLuteHeader(value, '')
    if (!edited.title) setTitle(head.title)
    if (!edited.artist) setArtist(head.artist)
  }

  const refresh = useCallback(async () => setSongs(await listLibrary()), [])
  useEffect(() => void refresh(), [refresh])

  const summaries = useMemo(() => {
    const out = new Map<string, ReturnType<typeof summarise>>()
    for (const s of songs ?? []) out.set(s.hash, summarise(s.text))
    return out
  }, [songs])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return songs ?? []
    return (songs ?? []).filter(
      (s) => s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)
    )
  }, [songs, query])

  const say = (msg: string) => {
    setNotice(msg)
    setError(null)
  }

  const submitPaste = async () => {
    if (!looksLikeLuting(text)) {
      return setError('That doesn’t look like a luting — there’s no "#lute BPM" header in it.')
    }
    if (buildChart(text).tracks.length === 0) {
      return setError('That luting parsed, but it has no playable notes.')
    }
    const res = await addLuting({ title, artist, text })
    if (res.status === 'duplicate') {
      return setError(`You already have that luting, as “${res.existing!.title}”.`)
    }
    if (res.status === 'invalid') return setError('That luting could not be read.')
    setAdding(false)
    setTitle('')
    setArtist('')
    setText('')
    setEdited({ title: false, artist: false })
    say(`Added “${res.song!.title}”.`)
    await refresh()
  }

  const openFiles = async (list: FileList | null) => {
    const files = [...(list ?? [])]
    if (!files.length) return
    setBusy(true)
    setError(null)
    try {
      const r = await importFiles(files)
      await refresh()
      const bits = [`${r.added} added`]
      if (r.duplicates) bits.push(`${r.duplicates} already in your collection`)
      if (r.invalid.length) bits.push(`${r.invalid.length} couldn’t be read`)
      say(bits.join(' · '))
    } finally {
      setBusy(false)
    }
  }

  const exportAll = () => {
    if (!songs?.length) return
    const stamp = new Date().toISOString().slice(0, 10)
    downloadBlob(exportCollection(songs), `lutings-${stamp}.zip`)
    say(`Exported ${songs.length} luting${songs.length === 1 ? '' : 's'}.`)
  }

  const remove = async (song: LibrarySong) => {
    if (!confirm(`Remove “${song.title}” from your collection?`)) return
    await deleteLibrarySong(song.hash)
    await refresh()
    say(`Removed “${song.title}”.`)
  }

  const empty = songs !== null && songs.length === 0

  return (
    <div
      className={`picker ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void openFiles(e.dataTransfer.files)
      }}
    >
      <div className="picker-head">
        <label className="search">
          <Search size={15} />
          <input
            type="search"
            placeholder="Search your collection"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search your collection"
          />
        </label>
        <button type="button" className="btn primary" onClick={() => setAdding((v) => !v)}>
          <Plus size={15} /> Add a luting
        </button>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? <Loader size={15} className="spin" /> : <Upload size={15} />} Import
        </button>
        <button type="button" className="btn ghost" onClick={exportAll} disabled={!songs?.length}>
          <Download size={15} /> Export collection
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".lute,.zip,.txt,text/plain,application/zip"
          multiple
          hidden
          onChange={(e) => {
            void openFiles(e.target.files)
            e.target.value = '' // so re-picking the same file fires again
          }}
        />
      </div>

      {adding && (
        <div className="add-form">
          <div className="add-head">
            <h3>Add a luting</h3>
            <button type="button" className="icon-btn" onClick={() => setAdding(false)} aria-label="Close">
              <X size={15} />
            </button>
          </div>
          <div className="add-fields">
            <label className="field">
              <span>Title</span>
              <input
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value)
                  setEdited((p) => ({ ...p, title: true }))
                }}
                placeholder="Song name, or paste a luting below"
              />
            </label>
            <label className="field">
              <span>Artist</span>
              <input
                value={artist}
                onChange={(e) => {
                  setArtist(e.target.value)
                  setEdited((p) => ({ ...p, artist: true }))
                }}
                placeholder="Who wrote or transcribed it"
              />
            </label>
          </div>
          <label className="field">
            <span>Luting</span>
            <textarea
              rows={5}
              value={text}
              onChange={(e) => pasteLuting(e.target.value)}
              placeholder={'//Song name\n//Author: whoever wrote it\n#lute 480 il ceg…\n\nA multilute pasted as several "#lute m …" messages is joined back into one.'}
            />
          </label>
          <p className="hint">
            Paste one message or a whole multilute — the <code>#lute m …</code> parts are
            rejoined automatically. If it opens with <code>//Title</code> and{' '}
            <code>//Author:</code> lines, as a <code>.lute</code> file or a luting copied from
            this app does, the fields above fill themselves in. Adding a luting you already
            have is recognised as the same song, whatever you call it.
          </p>
          <button type="button" className="btn primary" disabled={!text.trim()} onClick={() => void submitPaste()}>
            Add to collection
          </button>
        </div>
      )}

      {error && <p className="error-note">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}

      {empty && !adding && (
        <div className="empty">
          <img src={mascot} alt="" />
          <h2>Your collection is empty</h2>
          <p>
            Luting Hero doesn’t come with any songs — you bring your own. Paste one from{' '}
            <a href="https://luteboi.com/">luteboi.com</a>, drop <code>.lute</code> files
            anywhere on this page, or import a collection zip you exported before.
          </p>
          <div className="empty-actions">
            <button type="button" className="btn primary" onClick={() => setAdding(true)}>
              <ClipboardPaste size={15} /> Paste a luting
            </button>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              <Upload size={15} /> Import files
            </button>
          </div>
        </div>
      )}

      <div className="song-grid">
        {filtered.map((song) => {
          const info = summaries.get(song.hash)
          return (
            <div key={song.hash} className="song-card">
              <button type="button" className="song-open" onClick={() => onPick(song)}>
                <span className="song-title">{song.title}</span>
                {song.artist && <span className="song-author">{song.artist}</span>}
                {info && (
                  <span className="song-meta">
                    <Music size={12} /> {info.instruments} instrument{info.instruments === 1 ? '' : 's'} ·{' '}
                    {info.notes.toLocaleString()} notes · {mmss(info.durationSec)}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="song-remove"
                aria-label={`Remove ${song.title}`}
                title="Remove from collection"
                onClick={() => void remove(song)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          )
        })}
        {songs !== null && !empty && filtered.length === 0 && (
          <p className="hint">Nothing in your collection matches “{query}”.</p>
        )}
      </div>
    </div>
  )
}
