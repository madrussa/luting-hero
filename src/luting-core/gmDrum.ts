// GM percussion key -> drumkit pitch (octave + letter).
//
// EXTRACT, not a whole-file copy: upstream this lives in Luting Studio's
// src/lib/convert.ts, which also pulls in @tonejs/midi for the MIDI-file
// converter. The game only needs the table (so drum pads and the on-screen kit
// land on the right LuteBoi drum), so only the table came across. See
// ./README.md before editing anything in this directory.

import type { Pitch } from './luting'

export const GM_DRUM: Record<number, Pitch> = {
  35: { octave: 0, letter: 'b' }, // acoustic bass drum -> hollow kick
  36: { octave: 0, letter: 'a' }, // bass drum -> kick
  37: { octave: 2, letter: 'a' }, // side stick -> rim
  38: { octave: 3, letter: 'c' }, // acoustic snare
  39: { octave: 3, letter: 'a' }, // hand clap
  40: { octave: 3, letter: 'c' }, // electric snare
  41: { octave: 1, letter: 'c' }, // low floor tom
  42: { octave: 4, letter: 'c' }, // closed hi-hat
  43: { octave: 1, letter: 'c' }, // high floor tom
  44: { octave: 4, letter: 'c' }, // pedal hi-hat
  45: { octave: 1, letter: 'a' }, // low tom
  46: { octave: 4, letter: 'a' }, // open hi-hat
  47: { octave: 1, letter: 'a' }, // low-mid tom
  48: { octave: 2, letter: 'c' }, // hi-mid tom
  49: { octave: 5, letter: 'd' }, // crash 1
  50: { octave: 2, letter: 'c' }, // high tom
  51: { octave: 5, letter: 'c' }, // ride 1
  52: { octave: 5, letter: 'd' }, // chinese cymbal
  53: { octave: 6, letter: 'c' }, // ride bell -> ding
  54: { octave: 5, letter: 'e' }, // tambourine
  55: { octave: 5, letter: 'd' }, // splash
  56: { octave: 5, letter: 'a' }, // cowbell
  57: { octave: 5, letter: 'd' }, // crash 2
  58: { octave: 1, letter: 'b' }, // vibraslap -> wood block
  59: { octave: 5, letter: 'c' }, // ride 2
  60: { octave: 2, letter: 'e' }, // hi bongo
  61: { octave: 2, letter: 'd' }, // low bongo
  62: { octave: 2, letter: 'e' }, // mute hi conga
  63: { octave: 2, letter: 'd' }, // open hi conga
  64: { octave: 1, letter: 'c' }, // low conga
  65: { octave: 2, letter: 'c' }, // high timbale
  66: { octave: 1, letter: 'a' }, // low timbale
  67: { octave: 5, letter: 'a' }, // high agogo
  68: { octave: 5, letter: 'a' }, // low agogo
  69: { octave: 5, letter: 'e' }, // cabasa
  70: { octave: 5, letter: 'e' }, // maracas
  75: { octave: 1, letter: 'd' }, // claves
  76: { octave: 1, letter: 'd' }, // hi wood block
  77: { octave: 1, letter: 'e' }, // low wood block
  80: { octave: 5, letter: 'f' }, // mute triangle
  81: { octave: 5, letter: 'g' }, // open triangle
}
