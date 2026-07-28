// Telling iOS what kind of audio this is.
//
// On an iPhone, Web Audio is a *system sound* by default — which means the little
// switch on the side of the phone silences it, exactly as it silences a
// notification. Nothing about the page can tell: the context reports `running`,
// the clock runs, notes are scheduled, and no sound comes out. Every other
// browser plays perfectly, so the bug looks like it's in the game.
//
// The Audio Session API is how a page says otherwise. `playback` means "this is
// media, like a video" — it ignores the silent switch and it takes over from
// whatever else was playing, both of which are what a rhythm game wants: you
// cannot play along to a song you can't hear, and you certainly can't play along
// to two.
//
// Safari 16.4 and later; everywhere else the property simply isn't there, which
// is fine, because nowhere else mutes Web Audio by hardware switch.

/** The slice of the Audio Session API this needs, which TS's DOM lib lacks. */
interface AudioSessionish {
  audioSession?: { type?: string }
}

/**
 * Claim the session for media playback. Safe to call before any AudioContext
 * exists — the type belongs to the page, not to a context, which is what lets one
 * call at startup cover the three contexts this app ends up with: the game's, the
 * song preview's, and the sample decoder's.
 */
export function claimAudioSession(): void {
  try {
    const nav = navigator as Navigator & AudioSessionish
    if (nav.audioSession) nav.audioSession.type = 'playback'
  } catch {
    // A browser that has the property but refuses the value is no worse off than
    // one that never had it.
  }
}
