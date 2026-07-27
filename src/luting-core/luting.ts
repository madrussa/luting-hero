// Core luting model: instruments, pitch math, serializer (events -> luting text)
// and parser (luting text -> playable note schedule).
// Syntax reference: https://luteboi.com/ tutorial modal.

export interface Instrument {
  code: string
  name: string
  icon: string
  hint: string
}

export const INSTRUMENTS: Instrument[] = [
  { code: 'l', name: 'Lute', icon: '🪕', hint: 'The classic. Default instrument.' },
  { code: 'b', name: 'Bass', icon: '🎸', hint: 'Low plucked bass.' },
  { code: 'f', name: 'Flute', icon: '🪈', hint: 'Soft sustained wind.' },
  { code: 'k', name: 'Keyboard', icon: '🎹', hint: 'Piano-like keys.' },
  { code: 'c', name: 'Chiptune', icon: '👾', hint: '8-bit square lead.' },
  { code: 'm', name: 'The Cat', icon: '🐱', hint: 'Meow.' },
  { code: 't', name: 'The Bean', icon: '🫘', hint: 'Bean.' },
  { code: 'p', name: 'Percussion', icon: '🪘', hint: 'Pitched percussion.' },
  { code: 'd', name: 'Drumkit', icon: '🥁', hint: 'Note+octave picks the drum sound.' },
  { code: 'a', name: 'Bell', icon: '🔔', hint: 'Ringing bells.' },
  { code: 'o', name: 'Organ', icon: '⛪', hint: 'Sustained organ.' },
  { code: 'e', name: 'Choir', icon: '👥', hint: 'Voices, aah.' },
  { code: 'v', name: 'Violin', icon: '🎻', hint: 'Bowed strings.' },
  { code: 'g', name: 'Ocarina', icon: '🏺', hint: 'Breathy whistle.' },
  { code: 'h', name: 'Horn', icon: '📯', hint: 'Brass.' },
  { code: 'i', name: 'Vibraphone', icon: '🛎️', hint: 'Mallet shimmer.' },
  { code: 'j', name: 'Overdriven Guitar', icon: '🤘', hint: 'Crunchy lead.' },
  { code: 's', name: 'Saxophone', icon: '🎷', hint: 'Smooth reed.' },
  { code: 'n', name: 'Harmonica', icon: '🪗', hint: 'Reedy blues.' },
  { code: 'q', name: 'Slap Bass', icon: '👋', hint: 'Funky slap.' },
]

export const instrumentByCode = (code: string): Instrument | undefined =>
  INSTRUMENTS.find((i) => i.code === code)

export const TWITCH_LIMIT = 493

// ---------------------------------------------------------------------------
// Pitch math. o4 c = middle C = MIDI 60. Letters run c..b within an octave.
// Flats are written with a trailing apostrophe: d' = C#/Db.

const LETTER_SEMITONE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
const PC_TO_TOKEN = ['c', "d'", 'd', "e'", 'e', 'f', "g'", 'g', "a'", 'a', "b'", 'b']

// The chromatic order luteboi uses inside a chord: notes are assumed to ascend,
// and the implied octave rolls over whenever the next note isn't above the
// previous one. A flat sits one step *below* its natural (e' below e), so a
// run like e' e g keeps climbing and stays in one octave. Mirrors LuteBoi's
// NOTE_ORDER table exactly — comparing letters alone would treat e' and e as
// equal and wrongly roll the octave (emitting a stray '<').
const NOTE_ORDER: Record<string, number> = {
  c: 0, "d'": 1, d: 2, "e'": 3, e: 4, "f'": 5, f: 6,
  "g'": 7, g: 8, "a'": 9, a: 10, "b'": 11, b: 12, "c'": 13,
}
const noteOrder = (letter: string) => NOTE_ORDER[letter] ?? 0

export interface Pitch {
  octave: number
  /** letter plus optional flat apostrophe, e.g. "c" or "d'" */
  letter: string
}

export function midiToPitch(midi: number): Pitch {
  return { octave: Math.floor(midi / 12) - 1, letter: PC_TO_TOKEN[((midi % 12) + 12) % 12] }
}

export function pitchToMidi(p: Pitch): number {
  const base = (p.octave + 1) * 12 + LETTER_SEMITONE[p.letter[0]]
  return p.letter.includes("'") ? base - 1 : base
}

/** Clamp a melodic MIDI note into the playable o1..o7 range by octave shifts. */
export function clampMidi(midi: number): number {
  let m = midi
  while (m < 24) m += 12
  while (m > 107) m -= 12
  return m
}


// ---------------------------------------------------------------------------
// Voice events -> luting body text.
// Durations are integer multiples of the t1 grid unit (one luting beat).

export interface VoiceEvent {
  type: 'note' | 'rest' | 'chord'
  pitches: Pitch[]
  duration: number
}

export interface SerializeOptions {
  /** v1..v9, omitted/10 = full volume */
  volume?: number
}

/**
 * A duration as luting text: integers as-is, halves/thirds/quarters as
 * fractions ("5/2"). Swing pairs and other off-grid feels need these.
 */
function durStr(d: number): string {
  if (Number.isInteger(d)) return String(d)
  for (const den of [2, 3, 4]) {
    const n = d * den
    if (Math.abs(n - Math.round(n)) < 1e-9) return `${Math.round(n)}/${den}`
  }
  // last resort: nearest quarter-unit so the output always parses
  return `${Math.max(1, Math.round(d * 4))}/4`
}

export function serializeVoiceBody(events: VoiceEvent[], opts: SerializeOptions = {}): string {
  if (events.length === 0) return ''

  const durCounts = new Map<number, number>()
  for (const e of events) durCounts.set(e.duration, (durCounts.get(e.duration) ?? 0) + 1)
  let defaultDur = 1
  let best = -1
  for (const [d, n] of durCounts) {
    if (n > best || (n === best && d < defaultDur)) {
      best = n
      defaultDur = d
    }
  }

  let out = ''
  if (opts.volume && opts.volume >= 1 && opts.volume <= 9) out += `v${opts.volume}`
  if (defaultDur !== 1) out += `t${durStr(defaultDur)}`

  let oct = 4
  let octKnown = true

  const moveOctave = (target: number): string => {
    let s = ''
    if (!octKnown || Math.abs(target - oct) > 1) s = `o${target}`
    else if (target === oct + 1) s = '>'
    else if (target === oct - 1) s = '<'
    oct = target
    octKnown = true
    return s
  }

  for (const e of events) {
    const durSuffix = e.duration === defaultDur ? '' : durStr(e.duration)
    if (e.type === 'rest') {
      out += `r${durSuffix}`
      continue
    }

    const pitches = [...e.pitches]
      .sort((a, b) => pitchToMidi(a) - pitchToMidi(b))
      .filter((p, i, arr) => i === 0 || pitchToMidi(p) !== pitchToMidi(arr[i - 1]))

    if (pitches.length === 0) {
      out += `r${durSuffix}`
      continue
    }

    out += moveOctave(pitches[0].octave)

    if (pitches.length === 1) {
      out += pitches[0].letter + durSuffix
      continue
    }

    // Chord: notes ascend; luteboi bumps the implied octave whenever the next
    // letter is not above the previous one. Explicit '>' covers larger jumps.
    out += '(' + pitches[0].letter
    let impliedOct = pitches[0].octave
    let prev = pitches[0]
    for (const p of pitches.slice(1)) {
      // luteboi bumps the implied octave when the next note isn't above the
      // previous one in NOTE_ORDER (so e' -> e ascends and stays put; e -> e'
      // or a wrap like b -> c rolls over). '>' covers larger jumps up.
      let implied = impliedOct + (noteOrder(p.letter) <= noteOrder(prev.letter) ? 1 : 0)
      while (implied < p.octave) {
        out += '>'
        implied++
      }
      while (implied > p.octave) {
        out += '<'
        implied--
      }
      out += p.letter
      impliedOct = implied
      prev = p
    }
    out += ')' + durSuffix
    // The octave state after a chord is murky; force an explicit o next time.
    octKnown = false
  }

  return out
}

// ---------------------------------------------------------------------------
// Drum sounds (Drumkit instrument 'd'): note+octave -> sound.

export interface DrumSound {
  key: string
  name: string
  gen: 'kick' | 'hollowkick' | 'tom' | 'wood' | 'bongo' | 'rim' | 'snare' | 'brush' | 'clap' | 'hhclosed' | 'hhopen' | 'cymbal' | 'crash' | 'tambourine' | 'triangle' | 'cowbell' | 'ding'
  freq?: number
}

export const DRUM_SOUNDS: Record<string, DrumSound> = {
  o0a: { key: 'o0a', name: 'Kick', gen: 'kick' },
  o0b: { key: 'o0b', name: 'Hollow Kick', gen: 'hollowkick' },
  o1c: { key: 'o1c', name: 'Low Tom', gen: 'tom', freq: 95 },
  o1d: { key: 'o1d', name: 'Wood Block 1', gen: 'wood', freq: 850 },
  o1e: { key: 'o1e', name: 'Wood Block 2', gen: 'wood', freq: 750 },
  o1f: { key: 'o1f', name: 'Wood Block 3', gen: 'wood', freq: 650 },
  o1g: { key: 'o1g', name: 'Wood Block 4', gen: 'wood', freq: 550 },
  o1a: { key: 'o1a', name: 'Mid Tom', gen: 'tom', freq: 140 },
  o1b: { key: 'o1b', name: 'Wood Block 5', gen: 'wood', freq: 450 },
  o2c: { key: 'o2c', name: 'High Tom', gen: 'tom', freq: 190 },
  o2d: { key: 'o2d', name: 'Bongo Low', gen: 'bongo', freq: 210 },
  o2e: { key: 'o2e', name: 'Bongo High', gen: 'bongo', freq: 300 },
  o2a: { key: 'o2a', name: 'Rim', gen: 'rim' },
  o3c: { key: 'o3c', name: 'Snare', gen: 'snare' },
  o3d: { key: 'o3d', name: 'Snare with Brush', gen: 'brush' },
  o3a: { key: 'o3a', name: 'Clap', gen: 'clap' },
  o4c: { key: 'o4c', name: 'Closed High Hat', gen: 'hhclosed' },
  o4a: { key: 'o4a', name: 'Open High Hat', gen: 'hhopen' },
  o5c: { key: 'o5c', name: 'Cymbal', gen: 'cymbal' },
  o5d: { key: 'o5d', name: 'Cymbal Crash', gen: 'crash' },
  o5e: { key: 'o5e', name: 'Tambourine', gen: 'tambourine' },
  o5f: { key: 'o5f', name: 'Triangle Low', gen: 'triangle', freq: 3200 },
  o5g: { key: 'o5g', name: 'Triangle High', gen: 'triangle', freq: 4100 },
  o5a: { key: 'o5a', name: 'Cowbell', gen: 'cowbell' },
  o6c: { key: 'o6c', name: 'Ding', gen: 'ding' },
}

// ---------------------------------------------------------------------------
// Import: luting text -> editable voices (instrument + body) for the board.

export interface ImportedVoice {
  instrument: string
  body: string
  label: string
}

export interface ImportResult {
  bpm: number
  voices: ImportedVoice[]
  warnings: string[]
}

/**
 * Joins the parts of a multilute back into one luting.
 *
 * Format (from the luteboi optimizer / VS Code extension): the first message
 * is "#lute m BPM ...", middle messages are "#lute m ..." and the last is
 * "#lute ..." without the marker. Parts are raw character splits — a cut can
 * land mid-token (even inside a chord) — so continuations are concatenated
 * verbatim after their header is removed.
 */
export function reassembleMultilute(input: string, warnings: string[]): string {
  // drop the VS Code extension's framing comments around each part
  const src = input.replace(/\/\/\s*(Multilute \d+:|Your Multilutes Sir:)\s*/gi, '')
  const starts: number[] = []
  for (let i = src.indexOf('#lute'); i !== -1; i = src.indexOf('#lute', i + 5)) starts.push(i)
  if (starts.length <= 1) return src

  let out = ''
  const markers: boolean[] = []
  starts.forEach((p, k) => {
    let rest = src.slice(p + 5, starts[k + 1] ?? src.length)
    // "m" + whitespace right after "#lute" marks a continuation-to-follow
    const hasMarker = /^\s*m\s/.test(rest)
    markers.push(hasMarker)
    if (hasMarker) rest = rest.replace(/^\s*m/, '')
    out += k === 0 ? '#lute' + rest : rest
  })

  warnings.push(`Joined ${starts.length} multilute parts into one luting.`)
  if (markers[markers.length - 1]) {
    warnings.push("The last part still has the 'm' marker — are later parts missing?")
  }
  if (markers.slice(0, -1).some((m) => !m)) {
    warnings.push("A part before the last has no 'm' marker — the parts may be out of order.")
  }
  return out
}

export function importLuting(input: string): ImportResult {
  const warnings: string[] = []

  // multilutes (several "#lute" messages) are joined back together first
  const joined = reassembleMultilute(input, warnings)

  // strip comments (// ... //)
  let src = joined
    .split('//')
    .filter((_, i) => i % 2 === 0)
    .join('')

  let bpm = 120
  const header = src.match(/#lute\s*(\d+)/)
  if (header) {
    bpm = parseInt(header[1], 10)
    src = src.replace(header[0], '')
  } else {
    warnings.push('No "#lute BPM" header found; assuming 120.')
  }
  src = src.replace(/\s+/g, '')

  const voices: ImportedVoice[] = []
  for (const rawVoice of src.split('|')) {
    if (rawVoice === '') continue

    // The instrument is set once per voice; pull the first i<code> out of the
    // body so the board's instrument selector owns it.
    let instrument = 'l'
    let body = rawVoice
    const at = rawVoice.indexOf('i')
    if (at !== -1) {
      const code = rawVoice[at + 1] ?? ''
      if (instrumentByCode(code)) {
        instrument = code
        body = rawVoice.slice(0, at) + rawVoice.slice(at + 2)
      } else {
        warnings.push(`Voice ${voices.length + 1}: unknown instrument "i${code}", using Lute.`)
        body = rawVoice.slice(0, at) + rawVoice.slice(at + 2)
      }
      if (body.indexOf('i') !== -1) {
        warnings.push(
          `Voice ${voices.length + 1}: has more than one instrument marker; the instrument can only be set once per voice.`
        )
      }
    }

    voices.push({
      instrument,
      body,
      label: instrumentByCode(instrument)?.name ?? 'Voice',
    })
  }

  if (voices.length === 0) warnings.push('No voices found in that luting.')
  return { bpm, voices, warnings }
}

// ---------------------------------------------------------------------------
// Parser: luting text -> schedule of notes for the preview synth.

export interface ScheduledNote {
  timeSec: number
  durSec: number
  /** present for melodic notes */
  midi?: number
  /** present for drumkit hits: key into DRUM_SOUNDS */
  drum?: string
  instrument: string
  volume: number
  pan: number
  /** index of the voice this note belongs to */
  voice: number
}

export interface ParseResult {
  bpm: number
  notes: ScheduledNote[]
  durationSec: number
  warnings: string[]
}

export function expandMacros(src: string, defs: Map<string, string>, depth: number, warnings: string[]): string {
  if (depth > 10) {
    warnings.push('Macro nesting too deep; stopped expanding.')
    return ''
  }
  let out = ''
  let i = 0
  while (i < src.length && out.length < 200000) {
    const ch = src[i]
    if (ch >= 'A' && ch <= 'Z') {
      i++
      if (src[i] === '{') {
        // definition: find matching brace
        let d = 1
        let j = i + 1
        while (j < src.length && d > 0) {
          if (src[j] === '{') d++
          else if (src[j] === '}') d--
          j++
        }
        const inner = expandMacros(src.slice(i + 1, j - 1), defs, depth + 1, warnings)
        defs.set(ch, inner)
        i = j
        let reps = ''
        while (i < src.length && src[i] >= '0' && src[i] <= '9') reps += src[i++]
        out += inner.repeat(reps ? parseInt(reps, 10) : 1)
      } else {
        let reps = ''
        while (i < src.length && src[i] >= '0' && src[i] <= '9') reps += src[i++]
        const body = defs.get(ch)
        if (body === undefined) warnings.push(`Macro ${ch} used before being defined.`)
        else out += body.repeat(reps ? parseInt(reps, 10) : 1)
      }
    } else {
      out += ch
      i++
    }
  }
  return out
}

interface Fraction {
  n: number
  d: number
}

/** Reads a duration like "5", "/2", "5/2" starting at i. Returns null if absent. */
function readFraction(src: string, i: number): { frac: Fraction; next: number } | null {
  let j = i
  let num = ''
  while (j < src.length && src[j] >= '0' && src[j] <= '9') num += src[j++]
  let den = ''
  if (src[j] === '/') {
    j++
    while (j < src.length && src[j] >= '0' && src[j] <= '9') den += src[j++]
  }
  if (!num && !den) return null
  return { frac: { n: num ? parseInt(num, 10) : 1, d: den ? parseInt(den, 10) : 1 }, next: j }
}

export interface ParseOptions {
  /**
   * Only emit notes for this voice index (0-based). All voices are still
   * macro-expanded so cross-voice macro definitions resolve.
   */
  soloVoice?: number
}

export function parseLuting(input: string, opts: ParseOptions = {}): ParseResult {
  const warnings: string[] = []

  // strip comments (// ... //) then whitespace
  let src = input
    .split('//')
    .filter((_, i) => i % 2 === 0)
    .join('')

  let bpm = 120
  const header = src.match(/#lute\s*(\d+)/)
  if (header) {
    bpm = parseInt(header[1], 10)
    src = src.replace(header[0], '')
  } else if (src.trim()) {
    warnings.push('No "#lute BPM" header found; assuming 120.')
  }
  src = src.replace(/\s+/g, '')

  const notes: ScheduledNote[] = []
  const defs = new Map<string, string>()

  for (const [vi, rawVoice] of src.split('|').entries()) {
    const voice = expandMacros(rawVoice, defs, 0, warnings)
    if (opts.soloVoice !== undefined && vi !== opts.soloVoice) continue
    let instrument = 'l'
    let oct = 4
    let dur: Fraction = { n: 1, d: 1 }
    let vol = 1
    let pan = 0
    let vBpm = bpm
    let tSec = 0
    let i = 0

    const noteSec = (f: Fraction) => (f.n / f.d) * (60 / vBpm)

    const emit = (pitches: Pitch[], f: Fraction) => {
      const durSec = noteSec(f)
      for (const p of pitches) {
        if (instrument === 'd') {
          const key = `o${p.octave}${p.letter[0]}`
          if (DRUM_SOUNDS[key]) {
            notes.push({ timeSec: tSec, durSec, drum: key, instrument, volume: vol, pan, voice: vi })
          } else {
            warnings.push(`No drum sound for ${key}.`)
          }
        } else {
          notes.push({ timeSec: tSec, durSec, midi: pitchToMidi(p), instrument, volume: vol, pan, voice: vi })
        }
      }
      tSec += durSec
    }

    while (i < voice.length) {
      const ch = voice[i]
      if (ch === 'i') {
        instrument = voice[i + 1] ?? 'l'
        i += 2
      } else if (ch === 'o') {
        i++
        if (voice[i] >= '0' && voice[i] <= '9') {
          oct = parseInt(voice[i], 10)
          i++
        } else {
          oct = 4
        }
      } else if (ch === '>') {
        // '>' up an octave, '>N' up N octaves (luteboi clamps to o8)
        i++
        if (voice[i] >= '0' && voice[i] <= '9') {
          oct = Math.min(8, oct + parseInt(voice[i], 10))
          i++
        } else oct++
      } else if (ch === '<') {
        i++
        if (voice[i] >= '0' && voice[i] <= '9') {
          oct = Math.max(0, oct - parseInt(voice[i], 10))
          i++
        } else oct--
      } else if (ch === 't') {
        i++
        const f = readFraction(voice, i)
        if (f) {
          dur = f.frac
          i = f.next
        }
      } else if (ch === 'v') {
        i++
        if (voice[i] >= '1' && voice[i] <= '9') {
          vol = parseInt(voice[i], 10) / 10
          i++
        } else {
          vol = 1
        }
      } else if (ch === 's') {
        i++
        if (voice[i] >= '1' && voice[i] <= '9') {
          pan = (parseInt(voice[i], 10) - 5) / 4
          i++
        }
      } else if (ch === '@') {
        i++
        let num = ''
        while (i < voice.length && voice[i] >= '0' && voice[i] <= '9') num += voice[i++]
        vBpm = num ? parseInt(num, 10) : bpm
      } else if (ch === '~') {
        // fades are approximated as an immediate switch in the preview
        i++
      } else if (ch === 'r') {
        i++
        const f = readFraction(voice, i)
        const frac = f ? f.frac : dur
        if (f) i = f.next
        tSec += noteSec(frac)
      } else if (ch >= 'a' && ch <= 'g' && ch !== 'i') {
        let letter = ch
        i++
        if (voice[i] === "'") {
          letter += "'"
          i++
        }
        const f = readFraction(voice, i)
        const frac = f ? f.frac : dur
        if (f) i = f.next
        emit([{ octave: oct, letter }], frac)
      } else if (ch === '(') {
        i++
        const pitches: Pitch[] = []
        let chordOct = oct
        let prevLetter: string | null = null
        while (i < voice.length && voice[i] !== ')') {
          const c = voice[i]
          if (c === '>') {
            // '>' / '>N' raise the chord's running octave (luteboi: notes after
            // it land N octaves up)
            i++
            if (voice[i] >= '0' && voice[i] <= '9') {
              chordOct += parseInt(voice[i], 10)
              i++
            } else chordOct++
          } else if (c === '<') {
            i++
            if (voice[i] >= '0' && voice[i] <= '9') {
              chordOct -= parseInt(voice[i], 10)
              i++
            } else chordOct--
          } else if (c >= 'a' && c <= 'g') {
            let letter = c
            i++
            if (voice[i] === "'") {
              letter += "'"
              i++
            }
            if (prevLetter !== null && noteOrder(letter) <= noteOrder(prevLetter)) chordOct++
            pitches.push({ octave: chordOct, letter })
            prevLetter = letter
          } else {
            i++
          }
        }
        i++ // closing paren
        const f = readFraction(voice, i)
        const frac = f ? f.frac : dur
        if (f) i = f.next
        if (pitches.length > 0) emit(pitches, frac)
      } else {
        i++
      }
    }
  }

  const durationSec = notes.reduce((m, n) => Math.max(m, n.timeSec + n.durSec), 0)
  return { bpm, notes, durationSec, warnings }
}
