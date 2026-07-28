// Share links and condition codes.

import { describe, it, expect } from 'vitest'
import { conditionCode, hasSongLink, readSongLink, songLink } from './share'
import { lutingHash } from './hash'

const BASE = 'https://example.com/luting-hero/'
const LUTING = '#lute 240 ilcdefgab|ibo2cccc|ido0ao3co4c'

describe('song links', () => {
  const song = { title: 'Gerudo Valley', artist: 'Koji Kondo', text: LUTING }

  it('round-trips a song through a URL', () => {
    const url = songLink(song, BASE)
    expect(readSongLink(new URL(url).hash)).toEqual(song)
  })

  it('puts the song in the fragment, where no server sees it', () => {
    const url = new URL(songLink(song, BASE))
    expect(url.search).toBe('')
    expect(url.hash.startsWith('#s=')).toBe(true)
    // and nothing of the notation is left readable in the URL itself
    expect(url.toString()).not.toContain('#lute')
  })

  it('compresses, because a link has to survive a chat window', () => {
    const long = {
      ...song,
      text: `#lute 240 il${'cdefgab'.repeat(120)}`,
    }
    const url = songLink(long, BASE)
    expect(url.length).toBeLessThan(long.text.length / 2)
    expect(readSongLink(new URL(url).hash)!.text).toBe(long.text)
  })

  it('survives a title and artist with anything in them', () => {
    const awkward = {
      title: 'Ai no Uta — 愛のうた (100% #1) & "friends"',
      artist: 'ふうか + Ünter/Over',
      text: LUTING,
    }
    expect(readSongLink(new URL(songLink(awkward, BASE)).hash)).toEqual(awkward)
  })

  it('replaces a fragment already on the base rather than appending to one', () => {
    const url = songLink(song, `${BASE}#s=stale`)
    expect(url.match(/#/g)).toHaveLength(1)
    expect(readSongLink(new URL(url).hash)).toEqual(song)
  })

  it('reads the same song whichever base it was shared from', () => {
    // The link is portable: a song shared from a local build opens on the hosted
    // one, because everything needed is in the payload.
    const local = readSongLink(new URL(songLink(song, 'http://localhost:5173/')).hash)
    const hosted = readSongLink(new URL(songLink(song, BASE)).hash)
    expect(local).toEqual(hosted)
  })

  it('is recognised without being decoded', () => {
    expect(hasSongLink(new URL(songLink(song, BASE)).hash)).toBe(true)
    expect(hasSongLink('#settings')).toBe(false)
    expect(hasSongLink('')).toBe(false)
  })

  it('reports a link it cannot read instead of throwing', () => {
    // A link cut short by whatever wrapped it is the likely case, and the app
    // has something to say about that — but only if it gets to say it.
    const url = songLink(song, BASE)
    expect(readSongLink(url.slice(0, url.length - 40))).toBeNull()
    expect(readSongLink('#s=not-base64-at-all!!')).toBeNull()
    expect(readSongLink('#s=')).toBeNull()
    expect(readSongLink('#other=x')).toBeNull()
  })

  it('keeps the song identical, so a shared copy is the same song', () => {
    // The receiving end hashes the notation to file it, so anything lost in the
    // round trip would land as a second copy of a song they already had.
    const back = readSongLink(new URL(songLink(song, BASE)).hash)!
    expect(lutingHash(back.text)).toBe(lutingHash(song.text))
  })
})

describe('condition codes', () => {
  const conditions = {
    songHash: lutingHash(LUTING),
    instrument: 'l',
    keyboard: 'easy' as const,
    hitWindow: 'normal',
  }

  it('is the same code for the same conditions', () => {
    expect(conditionCode(conditions)).toBe(conditionCode({ ...conditions }))
    expect(conditionCode(conditions)).toMatch(/^LH1-[0-9a-f]{6}$/)
  })

  it('changes when any of the four things that matter changes', () => {
    const base = conditionCode(conditions)
    expect(conditionCode({ ...conditions, keyboard: 'superez' })).not.toBe(base)
    expect(conditionCode({ ...conditions, hitWindow: 'brutal' })).not.toBe(base)
    expect(conditionCode({ ...conditions, instrument: 'b' })).not.toBe(base)
    expect(conditionCode({ ...conditions, songHash: lutingHash('#lute 240 ilcc') })).not.toBe(base)
  })

  it('does not confuse one field for another', () => {
    // Joined with a separator, so "ab" + "c" can't read as "a" + "bc" and two
    // different runs claim to have been the same.
    expect(conditionCode({ ...conditions, instrument: 'lx', keyboard: 'easy' })).not.toBe(
      conditionCode({ ...conditions, instrument: 'l', keyboard: 'xeasy' as never })
    )
  })
})
