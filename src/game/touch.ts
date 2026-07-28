// Is this a touch device, for the handful of places that say "press a key"?
//
// Not to gate behaviour — every key the game listens for still works if a
// keyboard is attached, and a phone with one is a real thing. This is only so
// that a button doesn't ask a phone to press Space, which is advice it cannot
// take. `hover: none` and `pointer: coarse` together are the pair that means
// "the primary input is a finger"; either alone catches things it shouldn't.

const COARSE = '(hover: none) and (pointer: coarse)'

export const isTouchPrimary = (): boolean =>
  typeof matchMedia === 'function' && matchMedia(COARSE).matches
