# Vendored luting core — do not edit

Every `.ts` file in this directory is a **verbatim copy** from
[Luting Studio](https://github.com/madrussa/luting-studio)'s `src/lib/`:

| file          | upstream            | what the game uses it for                            |
| ------------- | ------------------- | ---------------------------------------------------- |
| `luting.ts`   | `src/lib/luting.ts` | `.lute` parser → `ScheduledNote[]`, instrument + drum tables, pitch math |
| `player.ts`   | `src/lib/player.ts` | Web Audio engine: `scheduleNote`, the synth configs, Karplus-Strong lute |
| `samples.ts`  | `src/lib/samples.ts`| lazy-loads the real LuteBoi sample packs from `public/samples/` |
| `midi.ts`     | `src/lib/midi.ts`   | Web MIDI input, mirror-port de-duplication, the on-screen device simulator |
| `gmDrum.ts`   | `src/lib/convert.ts`| **extract only** — the `GM_DRUM` table, so drum pads land on the right kit piece |

`gmDrum.ts` is the one file that isn't a whole-file copy: upstream `convert.ts`
imports `@tonejs/midi` for the MIDI-file converter, which the game has no use
for, so only the table came across.

Keeping these unedited is what makes an upstream fix a re-copy rather than a
merge. Game-specific behaviour that *looks* like it belongs here goes in
`src/game/` instead — `liveVoice.ts`, for instance, is the game's own
equivalent of upstream `liveSynth.ts`, rebuilt on the primitives `player.ts`
exports so that live notes and the backing track share one `AudioContext` (and
therefore one clock, which the judge depends on).

## Re-syncing

```sh
./scripts/sync-core.sh            # assumes ../luting
./scripts/sync-core.sh ~/src/luting-studio
git diff src/luting-core          # review before committing
```

The script also refreshes `public/samples/`, `src/assets/` and `src/songs/`,
and warns if the upstream `GM_DRUM` table has drifted from the extract here.
