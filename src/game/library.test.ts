import { describe, it, expect } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import {
  exportCollection, looksLikeLuting, luteFilename, readLuteHeader, toLuteFile,
} from './library'
import type { LibrarySong } from './library'
import { lutingHash } from './hash'

const song = (over: Partial<LibrarySong> = {}): LibrarySong => ({
  hash: 'h',
  title: 'A Song',
  artist: 'Someone',
  text: '#lute 480 ilceg',
  addedAt: 0,
  ...over,
})

describe('looksLikeLuting', () => {
  it('accepts a real luting', () => {
    expect(looksLikeLuting('#lute 480 ilcegcegceg')).toBe(true)
  })

  it('sees past the header comments', () => {
    expect(looksLikeLuting('//Title\r\n//Author: X\r\n#lute 480 ilcegcegceg')).toBe(true)
  })

  it('rejects prose and empty input', () => {
    expect(looksLikeLuting('just some text')).toBe(false)
    expect(looksLikeLuting('')).toBe(false)
    // a header with nothing after it is not a song
    expect(looksLikeLuting('#lute 480')).toBe(false)
  })
})

describe('readLuteHeader', () => {
  it('reads the conventional title and byline', () => {
    expect(readLuteHeader('//Gerudo Valley\r\n//Author: Someone\r\n#lute 480 ilc', 'x')).toEqual({
      title: 'Gerudo Valley',
      artist: 'Someone',
    })
  })

  it('accepts Artist: and By: as well', () => {
    expect(readLuteHeader('//T\n//Artist: A\n#lute 480 ilc', 'x').artist).toBe('A')
    expect(readLuteHeader('//T\n//By: B\n#lute 480 ilc', 'x').artist).toBe('B')
  })

  it('falls back to the given title when there is no header', () => {
    expect(readLuteHeader('#lute 480 ilc', 'From Filename')).toEqual({
      title: 'From Filename',
      artist: '',
    })
  })
})

describe('toLuteFile', () => {
  it('writes the stored metadata as the header, not whatever was there before', () => {
    // The title can be edited after import; the export has to reflect that.
    const out = toLuteFile(song({ title: 'Renamed', text: '//Old Title\r\n#lute 480 ilceg' }))
    expect(out).toContain('//Renamed')
    expect(out).not.toContain('Old Title')
  })

  it('omits the byline when there is no artist', () => {
    expect(toLuteFile(song({ artist: '' }))).not.toContain('Author:')
  })

  it('round-trips to the same hash, so a re-import still dedupes', () => {
    const s = song({ text: '//Whatever\r\n//Author: Old\r\n#lute 480 ilceg' })
    expect(lutingHash(toLuteFile(s))).toBe(lutingHash(s.text))
  })
})

describe('luteFilename', () => {
  it('strips characters a filesystem would object to', () => {
    const taken = new Set<string>()
    expect(luteFilename(song({ title: 'A/B: "C" <D>' }), taken)).toBe('AB C D.lute')
  })

  it('never collides within one export', () => {
    const taken = new Set<string>()
    expect(luteFilename(song({ title: 'Same' }), taken)).toBe('Same.lute')
    expect(luteFilename(song({ title: 'Same' }), taken)).toBe('Same (2).lute')
    expect(luteFilename(song({ title: 'Same' }), taken)).toBe('Same (3).lute')
  })

  it('falls back when a title has no usable characters', () => {
    expect(luteFilename(song({ title: '///' }), new Set())).toBe('luting.lute')
  })
})

describe('exportCollection', () => {
  it('produces one .lute per song, readable back out', async () => {
    const songs = [
      song({ hash: 'a', title: 'First', text: '#lute 480 ilceg' }),
      song({ hash: 'b', title: 'Second', artist: '', text: '#lute 240 ibo2ccc' }),
    ]
    const bytes = new Uint8Array(await exportCollection(songs).arrayBuffer())
    const entries = unzipSync(bytes)
    expect(Object.keys(entries).sort()).toEqual(['First.lute', 'Second.lute'])

    const first = strFromU8(entries['First.lute'])
    expect(first).toContain('//First')
    expect(first).toContain('//Author: Someone')
    expect(first).toContain('#lute 480')
    // and the notation survives well enough to be recognised as the same song
    expect(lutingHash(first)).toBe(lutingHash(songs[0].text))
  })

  it('handles an empty collection', async () => {
    const bytes = new Uint8Array(await exportCollection([]).arrayBuffer())
    expect(Object.keys(unzipSync(bytes))).toEqual([])
  })
})
