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
import type { EasyMap } from './easy'
import type { KeyboardMode } from './settings'

const BLACK_PCS = new Set([1, 3, 6, 8, 10])
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

export const isBlackKey = (midi: number): boolean => BLACK_PCS.has(((midi % 12) + 12) % 12)
export const noteName = (midi: number): string =>
  `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`

export interface Lane {
  /**
   * The game's coordinate: what the judge, the highway and the input router all
   * agree this key is. A pitch on the chromatic and per-pitch keyboards, a
   * position on a kit or a folded one.
   */
  lane: number
  /**
   * Which computer-keyboard binding slot this key occupies — a position on a
   * positional keyboard, a semitone offset on the chromatic one. Click-to-remap
   * reads it, so it has to be the same number the router looks the key up by.
   */
  slot: number
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
  /** equal-width keys addressed by position: the easy and hard keyboards */
  compact: boolean
  /** melodic only: the lowest key drawn, which the computer keyboard starts on */
  lowMidi: number
  highMidi: number
}

/**
 * slot -> lane for a positional keyboard — a kit, the folded keyboard, or the
 * one-key-per-pitch keyboard — or null for the chromatic one, where a computer
 * key means a semitone offset from the base octave instead of a position.
 *
 * The router and `buildLayout` both read this, and they have to agree: if they
 * didn't, a key would light one lane and play another.
 */
export function keyboardSlots(
  track: Track,
  mode: KeyboardMode,
  easy: EasyMap | null
): number[] | null {
  if (easy) return easy.keys.map((k) => k.lane)
  if (track.isDrums) return track.drums.map((_, i) => i)
  if (mode !== 'impossible' && track.pitches.length > 0) return track.pitches
  return null
}

/**
 * Build the layout for a track. On the chromatic keyboard melodic tracks get a
 * real piano: white keys share the width evenly and black keys straddle the
 * seams between them, which is what makes the pattern readable at a glance.
 * Everything positional — a kit, a fold, one key per pitch — gets equal lanes
 * in its own order, lowest at the left.
 */
export function buildLayout(
  track: Track,
  computerBaseMidi: number,
  mode: KeyboardMode = 'impossible',
  easy: EasyMap | null = null
): Layout {
  // Easy mode: the folded keyboard. At most MAX_EASY_KEYS keys whatever the
  // part's range, several pitches or kit pieces on some of them, and the lane
  // is the key's position rather than a pitch — which is the one thing the rest
  // of the game reads, so nothing else has to know a fold happened.
  if (easy) {
    const n = easy.keys.length
    const slots = slotLabels(track.isDrums ? 'drums' : 'compact')
    return {
      isDrums: track.isDrums,
      compact: !track.isDrums,
      lowMidi: track.lowMidi,
      highMidi: track.highMidi,
      lanes: easy.keys.map((key, i) => ({
        lane: key.lane,
        slot: i,
        center: (i + 0.5) / n,
        width: 1 / n,
        black: key.black,
        label: key.label,
        binding: slots.get(i),
        anchor: i === 0 || (!track.isDrums && key.octave !== easy.keys[i - 1].octave),
      })),
    }
  }

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
        slot: i,
        center: (i + 0.5) / n,
        width: 1 / n,
        black: false,
        label: DRUM_SOUNDS[key]?.name ?? key,
        binding: pads.get(i),
        anchor: i === 0,
      })),
    }
  }

  // Hard mode: one key per pitch the part plays, all the same width. The lane
  // is still the MIDI note, so the judge, the chart and MIDI input are
  // untouched — only which keys get drawn, and where, changes.
  if (mode !== 'impossible' && track.pitches.length > 0) {
    const n = track.pitches.length
    const slots = slotLabels('compact')
    return {
      isDrums: false,
      compact: true,
      lowMidi: track.pitches[0],
      highMidi: track.pitches[n - 1],
      lanes: track.pitches.map((midi, i) => ({
        lane: midi,
        slot: i,
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
      slot: semi,
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
