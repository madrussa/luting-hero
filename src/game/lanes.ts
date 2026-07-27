// Lane geometry, in normalised 0..1 across the playfield.
//
// The 3D highway and the DOM instrument below it have to agree on where every
// lane sits to the pixel, or notes land next to the key they belong to. Both
// read this layout: the highway multiplies it into world units, the keyboard
// turns it into CSS percentages.

import { DRUM_SOUNDS } from '../luting-core/luting'
import type { Track } from './chart'
import { keyboardRange } from './chart'
import { slotLabels } from './bindings'

const BLACK_PCS = new Set([1, 3, 6, 8, 10])
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

export const isBlackKey = (midi: number): boolean => BLACK_PCS.has(((midi % 12) + 12) % 12)
export const noteName = (midi: number): string =>
  `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`

export interface Lane {
  /** melodic: the MIDI note. drums: index into track.drums. */
  lane: number
  /** centre, 0..1 left to right */
  center: number
  /** width, as a fraction of the playfield */
  width: number
  /** black piano keys sit raised, narrower and behind the whites */
  black: boolean
  /** "C4", or the drum's name */
  label: string
  /** shown on the key when it has a computer-keyboard binding */
  binding?: string
  /** true at each C, and at the kick — the eye needs anchors */
  anchor: boolean
}

export interface Layout {
  lanes: Lane[]
  isDrums: boolean
  /** easy mode: one equal-width key per pitch the part actually plays */
  compact: boolean
  /** melodic only: the lowest key drawn, which the computer keyboard starts on */
  lowMidi: number
  highMidi: number
}

/**
 * Build the layout for a track. Melodic tracks get a real piano: white keys
 * share the width evenly and black keys straddle the seams between them, which
 * is what makes the pattern readable at a glance. Kit tracks get equal lanes in
 * kit order, kick at the left.
 */
export function buildLayout(track: Track, computerBaseMidi: number, compact = false): Layout {
  if (track.isDrums) {
    const n = Math.max(1, track.drums.length)
    const pads = slotLabels('drums')
    return {
      isDrums: true,
      compact: false, // a kit is already only the pieces the song uses
      lowMidi: 0,
      highMidi: 0,
      lanes: track.drums.map((key, i) => ({
        lane: i,
        center: (i + 0.5) / n,
        width: 1 / n,
        black: false,
        label: DRUM_SOUNDS[key]?.name ?? key,
        binding: pads.get(i),
        anchor: i === 0,
      })),
    }
  }

  // Easy mode: one key per pitch the part plays, all the same width. The lane
  // is still the MIDI note, so the judge, the chart and MIDI input are
  // untouched — only which keys get drawn, and where, changes.
  if (compact && track.pitches.length > 0) {
    const n = track.pitches.length
    const slots = slotLabels('compact')
    return {
      isDrums: false,
      compact: true,
      lowMidi: track.pitches[0],
      highMidi: track.pitches[n - 1],
      lanes: track.pitches.map((midi, i) => ({
        lane: midi,
        center: (i + 0.5) / n,
        width: 1 / n,
        black: isBlackKey(midi),
        label: noteName(midi),
        binding: slots.get(i),
        // an anchor at each octave change still gives the eye something to
        // hold on to, even without the black-key pattern to read
        anchor: i === 0 || Math.floor(midi / 12) !== Math.floor(track.pitches[i - 1] / 12),
      })),
    }
  }

  const keys = slotLabels('piano')

  const { lowMidi, highMidi } = keyboardRange(track)
  const midis: number[] = []
  for (let m = lowMidi; m <= highMidi; m++) midis.push(m)

  const whites = midis.filter((m) => !isBlackKey(m))
  const whiteW = 1 / whites.length
  const whitesBelow = (midi: number) => midis.filter((m) => m < midi && !isBlackKey(m)).length

  const lanes: Lane[] = midis.map((midi) => {
    const black = isBlackKey(midi)
    const semi = midi - computerBaseMidi
    return {
      lane: midi,
      // A black key's centre is the seam between the two whites it sits over.
      center: black ? whitesBelow(midi) * whiteW : (whitesBelow(midi) + 0.5) * whiteW,
      width: black ? whiteW * 0.6 : whiteW,
      black,
      label: noteName(midi),
      binding: keys.get(semi),
      anchor: midi % 12 === 0,
    }
  })

  return { lanes, isDrums: false, compact: false, lowMidi, highMidi }
}
