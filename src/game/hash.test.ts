import { describe, it, expect } from 'vitest'
import { lutingHash, normaliseLuting, stripComments } from './hash'
import { buildChart } from './chart'

describe('lutingHash', () => {
  it('is stable for the same notation', () => {
    const t = '#lute 480 ilceg|ibo2ccc'
    expect(lutingHash(t)).toBe(lutingHash(t))
  })

  it('ignores the title, the author and any other comment', () => {
    // Retitling a luting must not orphan its scores.
    const a = '//Gerudo Valley\n//Author: someone\n#lute 480 ilceg'
    const b = '//Renamed later\n#lute 480 ilceg'
    expect(lutingHash(a)).toBe(lutingHash(b))
  })

  it('ignores whitespace and line breaks', () => {
    expect(lutingHash('#lute 480 il ceg')).toBe(lutingHash('#lute480\n\tilceg'))
  })

  it('changes when a note changes', () => {
    expect(lutingHash('#lute 480 ilceg')).not.toBe(lutingHash('#lute 480 ilcef'))
  })

  it('changes when the tempo changes', () => {
    expect(lutingHash('#lute 480 ilceg')).not.toBe(lutingHash('#lute 240 ilceg'))
  })

  it('is a 16-character hex digest', () => {
    expect(lutingHash('#lute 480 ilceg')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('keeps a realistic library apart', () => {
    // A collision here would hand one song another's scores and settings.
    const songs = Array.from({ length: 3000 }, (_, i) => `#lute ${300 + (i % 400)} ilc${i}deg`)
    expect(new Set(songs.map(lutingHash)).size).toBe(songs.length)
  })

  it('handles an empty string', () => {
    expect(lutingHash('')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('stripComments', () => {
  it('strips CRLF header lines', () => {
    // `\r` is a line terminator to a JS regex, so `.` will not cross it and an
    // unanchored `$` will not match before it — a `/\/\/.*$/` strip is a silent
    // no-op on a CRLF file, and every .lute here is CRLF.
    expect(stripComments('//Title\r\n//Author: Someone\r\n#lute 480\r\nilceg').trim())
      .toBe('#lute 480\r\nilceg'.trim())
  })

  it('leaves the music alone when the byline contains note letters', () => {
    // "JustAnAnnoyingCat": `i` set the instrument from the `n` after it, `r`
    // inserted a rest and `g`/`a` became notes.
    const chart = buildChart('//Author: JustAnAnnoyingCat\r\n#lute 240 ilceg')
    expect(chart.warnings).toEqual([])
    expect(chart.allNotes).toHaveLength(3)
    expect(chart.allNotes.every((n) => n.instrument === 'l')).toBe(true)
  })
})

describe('multilutes', () => {
  // The optimiser splits a long song across several cheer messages, cutting at
  // raw character boundaries — so the parts only mean anything concatenated.
  const parts = [
    '#lute m 480 ilcde',
    '#lute m fgab',
    '#lute >cde',
  ].join('\n')
  const joined = '#lute 480 ilcdefgab>cde'

  it('hashes a multilute the same as its joined form', () => {
    expect(lutingHash(parts)).toBe(lutingHash(joined))
  })

  it('plays every part, not just the first message', () => {
    const chart = buildChart(parts)
    expect(chart.allNotes).toHaveLength(buildChart(joined).allNotes.length)
    expect(chart.allNotes).toHaveLength(10)
  })

  it('says that it joined them', () => {
    expect(buildChart(parts).warnings.some((w) => /Joined 3 multilute parts/.test(w))).toBe(true)
  })

  it('leaves a single-message luting alone', () => {
    expect(buildChart(joined).warnings).toEqual([])
  })

  it('survives the VS Code extension’s framing comments', () => {
    const framed = '// Your Multilutes Sir:\r\n// Multilute 1:\r\n#lute m 480 ilcde\r\n// Multilute 2:\r\n#lute fgab'
    expect(lutingHash(framed)).toBe(lutingHash('#lute 480 ilcdefgab'))
  })
})

describe('normaliseLuting', () => {
  it('strips paired comment markers and all whitespace', () => {
    expect(normaliseLuting('//hi// #lute 480\n il ceg')).toBe('#lute480ilceg')
  })
})
