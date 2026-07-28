# Luting Hero

A rhythm game for **lutings** — the compact music notation used by
[luteboi.com](https://luteboi.com/). Add a luting, pick one of its instruments,
and play that part yourself on a MIDI controller, an on-screen piano, or your
computer keyboard while the rest of the song plays behind you.

**No songs ship with the app.** You bring your own, and they stay in your
browser. Nothing is uploaded anywhere.

Sibling project to [Luting Studio](https://github.com/madrussa/luting-studio),
whose parser, audio engine, sample packs, theme and mascot it shares.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
npm test
```

## How it plays

- **Build a collection** — paste a luting (its title and artist fill in from
  the `//` headers, if it has them), drop `.lute` files anywhere on the page,
  or import a collection zip. Copy any song back out to share it, or send a
  **link with the whole song inside it**. Every song in the picker is really
  parsed, so the note counts and durations shown are the real ones.
- **Pick an instrument** — each one is rated 1–10 for difficulty from what it
  actually asks of you *on the keyboard you picked*, which is also on this
  screen: **Super EZ** folds the part onto four keys, **Easy** onto eight,
  **Hard** gives it one key per note it plays, **Impossible** gives it the whole
  chromatic keyboard.
  **Preview song** plays the whole arrangement, and the speaker on each card
  auditions that instrument alone. Parts with fewer than ten notes aren't
  offered: picking a two-note triangle is a minute of watching someone else's
  song. They still play in the backing.
- **Play it** — notes fall down a 3D highway onto the keyboard. Hit them as
  they cross the line. Everything you didn't pick keeps playing behind you.
- **Share it** — the results screen names the part and the rules it was played
  under. **Share score** draws a card carrying both, plus a code that says two
  players were comparing the same thing, and **Share song** hands over the song
  itself as a link. Either button's second half copies straight to the clipboard.

## The design decisions worth knowing about

### Voices are merged back into instruments

A luting voice is strictly monophonic in time: the syntax can stack notes into a
chord that shares one duration, but it cannot overlap two notes freely. That is
a limitation of the notation, not of the music, so composers work around it by
writing the same instrument across several voices.

A chart has no such limit — it's just a bag of timed notes — so **every voice
sharing an instrument code is merged into one track**. Pick "Lute" and you play
all of the lute, however many voices it was spread over; the instrument picker
shows a "4 voices" badge when that's happened. Two voices doubling the same
pitch at the same instant collapse into one note, because you can only press the
key once.

### Lanes are pitches, not colours

With the full note range available there's no honest way to compress a part onto
five coloured buttons, so the highway is Synthesia-style: **a lane is a MIDI
note**, and bars land on the key they belong to. That makes a hardware keyboard,
the on-screen piano and the computer keys all mean the same thing. Drum tracks
instead get one lane per kit piece the song actually uses, ordered as they sit on
a kit, so the kick is always the leftmost pad.

The keyboard is rounded out to whole octaves around the part's range, so a wide
part gets a wide keyboard. `src/game/lanes.ts` is the single source of lane
geometry — the 3D scene and the DOM instrument both read it, which is what keeps
every key exactly under its lane at any window size.

Where a lane stops being a pitch is the folded keyboard, below: there it is a
key's *position*, as it always has been on a kit. Everything that reads a lane
reads it as an opaque id, so that costs nothing.

### The camera angle is the reaction-time control

Perspective does not distribute time evenly. At the original 34° tilt, the first
half of every note's approach was squeezed into **17% of the screen** — notes
were an unreadable smudge near the horizon and then arrived in a rush. Steeper
is flatter-looking but far more readable: 44° gives that first half 26% of the
screen, 56° gives it 33%.

So the tilt is a setting (**Camera angle**, default 44°), and the runway's depth
is *derived* from it rather than fixed: `fitCamera` bisects for the depth that
puts the far end of the approach just inside the top of the frame. That way the
whole of `approachSec` is on screen at any angle, and none of it is wasted past
the edge. Everything sized by depth is built one unit long and scaled, so
re-tilting is a handful of scale assignments rather than a scene rebuild.

Fog is keyed to the camera's distance from the end of the runway, not to the
runway's length — those diverge sharply once depth is fitted, and a fog distance
keyed to the length ate most of the highway at steep angles.

### Stars

A drifting starfield with a few larger, slower wisps, in a slab **below and
beside** the highway rather than above it. Pitched 44° down there is no sky in
frame at all — the floor fills it — but the floor is only ten units wide, so the
wedges either side are open background. The stars that drift under the highway
are hidden by the floor itself, which writes depth while they only test it. The
result reads as a bridge over open space.

### The band is visible, not just audible

Everything you didn't pick plays behind you, and each of those instruments gets
a **glowing wave running along its own side of the highway**, in its own colour
(named in the HUD). The waves scroll toward you on *exactly the same time axis
as the notes*: the wave at depth `z` shows that instrument's activity at the
song time the notes arriving there will land on.

That's the point of them. A section starting is a swell rolling in from the
distance; a section stopping is the wave going flat well before the silence
arrives. The arrangement becomes something you can read ahead, so the stretches
where your own part rests stop feeling like the game has paused.

Each wave is three vertex rows — a wash from the floor, a bright crest, a halo
fading above it — so the glow comes from the geometry rather than a
post-processing pass. Activity comes from a precomputed envelope per voice
(`buildEnvelope`), normalised against that voice's *own* busiest moment: the
question a wave answers is "is this instrument playing, and is it about to?",
not "how loud is it". A two-note triangle part gets a wave as tall as the bass.

The rails also pulse with the backing drums, and the far end of the highway
glows in the blend of whatever is currently sounding.

### Four keyboards, and four keys at the easy end

Most parts touch a fraction of their range — Gerudo Valley's bass covers 45
semitones but visits **17 notes**, and its percussion part plays 480 notes on a
single pitch. The keys in between are only there to be missed. So the picker
offers four keyboards:

| | |
| --- | --- |
| **Super EZ** | **Four keys**, one per finger, and never a re-strike faster than a hand can give one. |
| **Easy** (default) | The part folded onto **at most eight keys**, with the notes that share one merged. |
| **Hard** | One equal-width key per pitch the part actually plays. |
| **Impossible** | The full chromatic keyboard across the part's range. |

Easy is the default rather than Super EZ: four keys is the floor for whoever
needs it, not what everyone should meet the game on.

Drawing only the pitches a part plays was already a big cut, but "only the
pitches it plays" is still seventeen keys for a bass line and more for anything
chordal. That is fine on a controller and hopeless on a computer keyboard, where
about eight keys is what one hand holds without moving — and owning the hardware
shouldn't be the price of admission. Hence the fold, in `src/game/easy.ts`.

**How it folds.** Neighbouring pitches are grouped until the setting's key
budget is met, minimising how far each note sits from the centre of its group
*weighted by how often it is played*. That is one-dimensional k-means with an order
constraint, which a dynamic program solves exactly — so the same part always
folds the same way, and a pitch struck three hundred times is never merged away
to spare a key for one struck twice. Groups are contiguous, so going up in the
part still means going right on the keyboard; a fold that sorted by anything
else would be a different song. Kits fold the same way but by *piece*, in kit
order, so the kick stays leftmost.

**A chord that fits under one key becomes one press.** That falls out of the
fold rather than being a second mechanism: `mergeSimultaneous` already collapsed
two voices doubling a pitch, because you can only press a key once, and a folded
keyboard just gives it more pairs to collapse.

**Super EZ opens that window from "at the same instant" to "as good as".** Four
keys puts so much of a part on each one that runs which were comfortable spread
across a keyboard become a single finger tapping faster than it can go — so on
that setting alone, notes landing on one key within about a tenth of a second of
each other are one press. It is the same rule with a wider window, measured from
the press rather than from the note before it, so a long run is thinned to a
playable rate rather than collapsing into one enormous tap. Every note still
sounds. Nothing else is dropped, thinned or rewritten on any keyboard: the
picker's note count is the number of presses the part will ask you for, and the
card says how many notes rode along with them.

**What you hear is not folded.** A press sounds the notes it actually
*claimed* — the real pitch, and the whole chord where a chord folded onto that
key — which is why the judge can say which note a press took. Easy mode changes
what you press, never what the song is.

The lane stops being the MIDI note here: on a folded keyboard it is the key's
position, exactly as it has always been on a kit. That is the only thing the
judge, the highway and the input router know about any of this — `LaneMap`
answers "which lane" and "what does it sound", and nothing downstream has to
learn that a fold happened.

Bindings stay positional (the nth key drawn), so one map serves every melodic
keyboard drawn that way: Super EZ's four keys are the first four slots of the map
easy mode spreads over eight and hard mode over every pitch in the part. With the
factory layout that is <kbd>A</kbd>–<kbd>F</kbd>, <kbd>A</kbd>–<kbd>K</kbd>, and
onward — the home row. None of them has an octave to shift.

**Best scores are kept per keyboard**, because the same part on four folded keys
and on the full chromatic keyboard are different things to have done, with
different note counts, and a score from one says nothing about the other.

### Where the seam is invisible, a strike mark

Two notes on one key with no rest between them draw as a single unbroken bar.
The seam where you have to strike again is a line a pixel wide, and by the time
it is close enough to see, the second note has gone. Folding a part onto eight
keys makes this the common case rather than the odd one, because far more of the
part now shares a key.

So a note whose gap from the one before it — in its own lane — is under a
twentieth of the approach gets a **disc at its leading edge**: the moment to
press again. A disc rather than a line across the bar, because a line reads as
the very seam it is pointing out. It goes away once the note is judged, so it
never clutters a sustain you are already holding.

The disc is **darker** than the bar, not lighter, which is the opposite of the
obvious choice. Lighter was tried first and it disappears exactly when it is
most needed: past a combo of 10 the notes catch fire and go white at the core,
and a pale mark is swallowed by the streak. Dark holds up against a bar that is
dim at the horizon, dropped to 30%, or white-hot — it is a fixed fraction of
whatever the bar is doing, so the contrast is the same in all of them. It also
has to be drawn *after* the note bloom, or the additive glow washes out the one
thing it is made of.

### The highway catches fire

Past a combo of 10 — the same place the score multiplier starts, so the fire
*is* the multiplier made visible rather than a second competing signal — the
incoming notes start to burn. Full blaze is a combo of 40.

The flames take **each note's own colour**, pushed toward white at the core,
rather than a separate amber fire palette: amber flames on a purple highway read
as an effect pasted over the top, where keeping the hue makes the note itself
look alight. They stand up as camera-facing tongues rather than lying on the
floor — a flat wash reads as a stain on the track, and the thing that makes fire
look like fire is that it rises — and they're emitted along the *length* of each
bar, so a held note burns end to end. Embers lift off the hit line in the same
two colours.

It's smoothed rather than switched, and falls slower than it rises, so a big
combo lights up promptly but a broken one visibly burns out instead of blinking
off. Missed notes stay red throughout — a dropped note shouldn't be dressed up
as part of the streak.

### Difficulty is measured, not declared

`rateDifficulty` scores independent things and weights them: onset density
(peak, not just average), **how many distinct keys there are to cover**, chord
width, hand travel, pitch reach, and rhythmic irregularity.

Key count is deliberately separate from pitch *span*: a part can range over two
octaves and use four notes, or sit inside one octave and use every semitone in
it. The second is much harder, and until it was counted the rating couldn't tell
them apart — Gerudo Valley's one-pad 300-note drum part now reads Beginner while
its 17-key bass reads Hard. Sparse parts are still held back however far they
leap.

It rates **the part on the keyboard you chose**, because that is the thing in
front of you: fold seventeen keys onto eight and the same bass line drops from
Hard to Easy, chords included, and a card still quoting the unfolded numbers
would be describing a mode you aren't about to play. Fold it onto four and it
drops again. On a positional keyboard —
a kit, or a fold — the rating is measured in keys rather than semitones, since
every key is already under one hand.

Difficulty never rewrites the *music*. Nothing drops notes to make a chart
easier; the most a folded keyboard does is merge notes you could only have
pressed as one, and you still hear all of them.

### Real samples, loaded before the count-in

The songs play through LuteBoi's actual recorded instruments — 16 packs of 30
multisampled notes each, plus the full drum kit, in `public/samples/`. This is
**on by default**, unlike the vendored engine, which defaults to its synth: that
is the right call for Luting Studio, where you audition a bar at a time and want
it instant, and the wrong one for a game you hear straight through once.

The packs for a song are also fetched and decoded *before* the count-in rather
than lazily during playback. The engine will happily start on the synth and swap
each instrument over as its pack lands, but that makes the opening bars sound
wrong and then change under you — much more noticeable than a second of
"Tuning up".

Lute, Bass, Chiptune and Percussion have no packs and never will: LuteBoi
synthesises those itself (Karplus-Strong for the lute's twang), so the built-in
synth *is* the faithful sound for them. The other sixteen are recordings.

### One clock

`Transport` owns a single `AudioContext`, and song time comes from
`ctx.currentTime`, not `performance.now()` or the frame loop. The highway, the
judge and the backing audio all read the oscillator that is actually producing
the sound, so they cannot drift apart; a late frame moves the picture, never the
music. Presses are judged against `now() + outputLatency`, because on a
high-latency output the gap between handling an event and hearing it is most of
a Perfect window.

This is also why the game has its own `liveVoice.ts` rather than reusing Luting
Studio's `liveSynth.ts`: that module owns a private `AudioContext`, and a second
clock is the one thing the judge can't tolerate.

### Songs are let to ring out

A run doesn't end on its last note. Switching to the results screen tears the
audio context down, so on a song that finishes with a held chord that used to cut
the decay off — the one moment a song most wants to be left alone. `runEndSec`
keeps the clock going for **three seconds past the last note anyone plays**, yours
or the band's — long enough for a held chord to fall away, short enough that it
doesn't read as the game having hung.

It's a floor on the silence at the end, not three seconds added to whatever is
there, so a chart that already ends in a minute of nothing doesn't leave you
watching an empty highway for a minute and three. (The upstream parser reports a
song's length as exactly its last note's end — trailing rests don't extend it —
so today that distinction never comes up. It's the rule that was wanted, though,
and it costs a `Math.max`.)

### The playfield is always dark

Light mode themes the menus, settings and results. The highway stays dark in
both, because every effect on it — the note bloom, the rails, the hit line, the
lane flashes — is additive blending, which is to say *light added to what's
behind it*. On a pale floor it has nowhere to go and saturates to flat white.
`.game` re-declares the dark tokens so the HUD over the highway stays readable.

## The start gate

Nothing begins until you press <kbd>Space</kbd>. The gate covers the highway
only — **the instrument underneath stays live**, so before anything is scored
you can play it, hear it, watch a MIDI controller light the keys it's actually
sending, and shift the transpose until the octaves line up.

**Settings** opens the full panel over the gate. The toolbar's cog is behind
it, and the gate is exactly where the scroll speed, the hit window and the MIDI
device want deciding — before the run, not after losing one to the wrong
setting. While the panel is up the gate stops listening, so <kbd>Space</kbd>
can't start the level out from under you.

**Remap keys** turns the instrument into the mapping surface: click the key or
pad you mean, then press the computer key you want on it. <kbd>Backspace</kbd>
clears a binding, <kbd>Esc</kbd> cancels.

**Every** key on the drawn instrument can be mapped. Offsets run negative as
well as positive, so the <kbd>Z</kbd>–<kbd>M</kbd> row reaches the octave below
the home row — which is where a part sitting under your hands has to go. The
home row starts one octave up from the keyboard's bottom so those negative
offsets have somewhere real to point.

A key can only mean one thing, so binding a key that was already in use frees it
from its old slot — otherwise a careless remap silently plays two notes at once.
<kbd>Space</kbd> and <kbd>Esc</kbd> can't be bound (they start and pause), nor
can modifiers, nor the arrow keys — those shift the octave, and living on
unbindable keys is what stops a remap stranding you on a range you can't leave.

## Your collection

Songs live in IndexedDB, keyed by a hash of their notation, and the picker is
also the library manager: add, import, export, delete.

- **Paste** takes a title and artist, and **fills them in itself** when the
  luting opens with the conventional `//Title` / `//Author:` lines — the same
  headers a `.lute` file carries and **Copy luting** writes. Type in either
  field and it's yours: no amount of re-pasting overwrites what you wrote. One
  message or a whole **multilute** — the `#lute m …` several-message format the
  LuteBoi optimiser emits — is fine; the parts are rejoined and stored as a
  single luting.
- **Copy luting**, on the song page next to Preview, puts the whole thing on
  the clipboard *with* those headers, so sharing a song is one paste at each
  end rather than a luting plus a retyped title.
- **Share song**, beside it, puts the same song in a *URL* — see below.
- **Import** takes loose `.lute` files, a collection zip, or a mix, and reads
  the conventional `//Title` / `//Author:` headers so nothing has to be
  described by hand. A file with no headers falls back to its filename
  (`GerudoValley.lute` → "Gerudo Valley"). Anything unreadable is reported
  rather than thrown, so one bad file in a zip of fifty doesn't lose the other
  forty-nine.
- **Adding the same music twice is recognised**, however it arrived and
  whatever it's called — the hash is of the notation with comments and
  whitespace stripped, so a retitled copy, a reflowed copy and a multilute all
  collapse onto the song you already have.
- **Export** writes one `.lute` per song into a zip, with the headers rebuilt
  from the stored title and artist so an edited title survives the round trip.
  Re-importing your own export therefore dedupes cleanly against what's already
  there.

## Sharing

Two different things, deliberately apart: a **song** can be handed to someone,
and a **run** can be compared with someone.

### A song fits in a link

**Share song** — on the song page and again on the results screen, where you have
just given someone a score they might want to try — produces a URL with the entire
luting inside it. Opening it adds the song and lands on its instrument picker:
nothing to download, nothing hosted, no account.

The payload rides in the URL's **fragment**, which is the whole trick: a
fragment is never sent to a server, so a song shared this way stays as private as
one pasted by hand and no host has it in a log. It also isn't subject to anyone's
URL length limit but the browser's, which is far above what a luting needs. It is
deflated first, because notation is about as compressible as text gets — a
1,300-note song is 923 characters of notation and about 950 of link, which
survives a chat window. (A big song will still exceed Twitch's 500-character
message limit; that's what pasting the luting itself is for.)

Links are read **on load and on every fragment change**. The second is the case
that's easy to miss: following a link with the game already open in a tab is a
same-document navigation — nothing reloads and no effect re-runs — so without
`hashchange` the commonest way of all to open a shared link would silently do
nothing. The fragment is then taken *out* of the address bar, or it would re-add
the song on every refresh and travel on to whoever the tab was passed to next.
Adding needs no confirmation because the library is keyed by the notation's hash:
a song you already have is recognised, not duplicated.

### A run fits in a code

The results screen ends with a code like `LH1-8f3a2c`, and **Share score** draws
a 1200×630 card with the same code on it — the shape every chat client expects,
drawn rather than screenshotted so it doesn't depend on the window it happened to
be in, and carrying the instrument and the rules as prominently as the number.

The code is a digest of the four things that decide what a score *means*: the
song, the part, the keyboard, and the timing window. Two players compare codes,
and if they match they know they were playing the same thing — Super EZ on
Lenient is a different game from Impossible on Brutal, and one number without
that context says nothing.

It is **not** proof that a score is real, and the screen says so. There is no
server here and no secret, so anyone determined can edit the picture or run a
modified copy of the game, and no code the game prints about itself could stop
them. It is for comparing honestly among people who want to, which is the case
that actually comes up.

Sharing takes the best route the browser offers and says which one it took: the
system share sheet, then the clipboard, then a download. All three, because
support is genuinely uneven — file sharing is a phone and Windows feature,
image-to-clipboard is a desktop one — and a Share button that silently does
nothing is worse than one that saves a file. The card is drawn when the run ends
rather than when the button is pressed, because a share sheet has to open inside
the gesture that asked for it and awaiting a canvas in between is enough for a
browser to refuse.

### Both share buttons are split

Each is two halves of one control: the wide side takes that best-route path, and
the icon side goes **straight to the clipboard**. Pasting into a chat is what most
people are actually doing on a desktop, and reaching it through a share sheet is
a dialog too many.

The clipboard half **fails rather than falling back** — a button that asked for
the clipboard specifically shouldn't quietly download a file instead, and the
other half is right there if that's what you wanted. Feedback goes on the *label*
whichever half acted, because the two halves are one control and should give one
answer.

## What's remembered, and where

| | |
| --- | --- |
| **localStorage** | Global preferences, plus the *carried* key mapping — small, synchronous, wanted before first paint. |
| **IndexedDB** | Two stores, both keyed by the luting's hash. `library` is the notation you've added; `songs` is what happened when you played it — its own key mapping, last instrument, best score per instrument, per-song speed and timing. They're separate because deleting a song shouldn't have to decide whether your scores go with it. |

**Key mappings belong to the song.** Ranges and kits differ, so a layout that
suits one chart is wrong for the next, and redoing it on every switch is the
thing to avoid — each song keeps its own and gets it back when you return.

A brand-new song still has to start from something, though, and the factory
layout every time would annoy anyone who has arranged the keys to suit their
hands. So the *carried* mapping — the last one you touched — is what a song with
no mapping of its own inherits. Set your layout once and every new song opens
with it; change it inside a song and only that song changes.

Both maps are relative, which is what makes them portable: the piano map is
key → semitone above the base octave, the drum map is key → pad *position*
(0 is always the lowest kit piece).

`lutingHash` hashes the *notation* — comments and whitespace stripped — so a
song recognises itself however it arrived, and retitling a luting doesn't orphan
its scores. Changing a note deliberately does: that's a different chart.

**Copy setup** in Settings packs your preferences and key mapping into one
pasteable code, so a mapping can be shared with someone else.

> While implementing the hash I found a latent bug in the upstream parser's
> comment handling and worked around it — see `stripComments` in
> [`src/game/hash.ts`](src/game/hash.ts).

## Input

| | |
| --- | --- |
| **MIDI controller** | Chrome/Edge only (Web MIDI). Nothing is requested until you click Connect — after that it's remembered. Mirror ports are de-duplicated, and there's an octave transpose for short keyboards. |
| **On-screen instrument** | Any browser. Click or drag across the keys for a glissando. |
| **Computer keyboard** | Home row = white keys, the row above = black keys, the <kbd>Z</kbd>–<kbd>M</kbd> row = the octave below, <kbd>←</kbd>/<kbd>→</kbd> shift an octave. Drum pads bind left to right from <kbd>A</kbd>. All remappable. |

Whatever you play it with, a key does three things: it lights while held, it
flashes the verdict it earned — mint for Perfect, purple for Great, grey for
Good, amber for a late save, red for a note the chart didn't want — and it
sounds, as the instrument
you chose to play, whether you were right or not. All three run off the same
event, so a hardware controller behaves identically to a mouse click.

Misses are deliberately *not* flashed on the keyboard: a miss is a note you
didn't play, and lighting the key you failed to reach turns a hard passage into
a strobe. The highway shows those in red instead.

### The controller is remembered

Connect once and it comes back on the next visit: `midiPrefs.ts` stores the
fact that you connected, the port you chose and its transpose, and reconnects
at startup. Two rules keep that honest. **A restore never raises a prompt** —
it runs only when the permission is *already* granted, so a first visit still
asks nothing, and Disconnect clears the flag rather than silently undoing
itself next load. And the port is matched **by id, then by name**: ids are
per-origin and usually stable, but a re-plug can churn them. A controller
that's unplugged at load leaves you on "all devices", and is picked up the
moment it appears.

The transpose lives with the device rather than the song, because that's what
it describes: where your controller's octave sits against the game's keyboard.
Dialling it in once is enough.

If a MIDI note lands outside the drawn keyboard — a controller sitting an octave
below the part, or a pad for a drum this song's kit doesn't use — the strip
above the keys says so, rather than the note silently vanishing.

## Sustains

A note isn't finished when you hit it. Striking it pays the onset; **holding it
for its full length pays the same again**, in proportion to how much of it you
actually held. So a full-value note means hitting it *and* keeping it down, and
a perfect run's score assumes every sustain was held.

The bar doesn't vanish when struck — the hit line eats it, so what's still on
screen is exactly the sustain left to hold. Held notes read brighter; letting go
early dims the remainder rather than removing it, because it's still there to be
picked back up. Grabbing a sustain again carries on adding to the same total and
is not a wrong note.

Notes shorter than 250 ms are struck, not held: a staccato sixteenth has no
sustain to hold and demanding one would be unplayable, so those score in full at
the onset. The results screen reports what share of your sustains you held.

**A long note can be claimed late**, and until you do it looks like a mistake.
Once a note is past its Good window and still untouched it turns red and pulses
— clearly wrong, but clearly still savable — and reverts the moment you strike
it. While it's still sounding, a press in its lane is obviously you playing it,
and counting that as a miss *and* a wrong note is wrong twice over. So a
holdable note stays claimable for its whole duration and keeps the combo.
Struck notes have no sustain to be late into, so they still hold to the Good
window.

A late save is its own verdict — the HUD says **Late**, not Good — and it is
worth half of one, sustain included. It's on the results screen as its own
tally and it weighs less than a Good in the accuracy. Landing late costs you
twice over, in fact: the sustain is credited from the press, so grabbing a
second-long note 400 ms in earns 60% of an already-halved hold.

Late claims stay out of the calibration figures. They're deliberate grabs, not
evidence of how your timing sits, and one of them would swamp the average and
have the results screen advise a wildly wrong offset.

The hold itself is measured from the note's own onset, not from your press —
hitting 15 ms early shouldn't buy 15 ms of extra sustain, and hitting late
shouldn't cost any beyond the time actually lost.

## Calibration

The results screen reports your **timing bias** — the signed average of how
early or late you were. A consistent number there is latency, not you; put its
negative into the calibration offset in Settings and it goes away.

## `src/luting-core/` is vendored

That directory is a verbatim copy of Luting Studio's parser, audio engine,
sample loader and MIDI input, plus its sample packs, songs and mascot art.
**Don't edit it** — run `./scripts/sync-core.sh` to re-copy after an upstream
fix and review with `git diff`. See [`src/luting-core/README.md`](src/luting-core/README.md).

## Credits

Luting notation and the sampled instruments are [LuteBoi](https://luteboi.com/)'s
([syntax reference](https://github.com/AnAnnoyingCat/lutingsyntax)). The mascot
comes from Luting Studio. No music ships with this app.
