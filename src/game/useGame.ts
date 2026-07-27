// The game loop.
//
// The loop owns the transport, the judge, the highway and the input router, and
// drives them from one rAF callback. React sees almost none of it: the HUD is
// pushed a throttled snapshot a few times a second, and everything that has to
// be frame-accurate — the note positions, the hit flashes, the lane lights —
// is written straight to the scene. That split is what keeps a press and the
// bar it hit on the same frame.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Judge, accuracy } from './judge'
import type { Judgement, Stats } from './judge'
import { Transport } from './transport'
import { InputRouter, LaneMap } from './input'
import type { PlayEvent } from './input'
import { Highway, HIGHWAY_THEME } from './highway'
import type { HighwayEvent } from './highway'
import { buildLayout, keyboardSlots } from './lanes'
import type { Layout } from './lanes'
import { backingFor, keyboardRange, soundsOf } from './chart'
import { buildBacking } from './backing'
import type { BackingVoice } from './backing'
import type { Chart, NoteSound, Track } from './chart'
import type { EasyMap } from './easy'
import { getSettings, hitWindowById, useSettings } from './settings'
import { useBindings } from './bindings'
import { getMidiTranspose, setMidiTranspose } from './midiPrefs'
import { setSimActive } from '../luting-core/midi'
import { loadBank } from '../luting-core/samples'

export type Phase = 'loading' | 'ready' | 'countdown' | 'playing' | 'paused' | 'finished'

/**
 * What a key on the on-screen instrument should flash when you play it.
 *
 * Only presses appear here, never misses: a miss is a note you *didn't* play,
 * and lighting the key you failed to reach turns a hard passage into a strobe.
 * The highway already shows misses in red, which is where the eye is anyway.
 */
export type Flash = 'perfect' | 'great' | 'good' | 'late' | 'wrong'
export type FlashMap = Record<number, { verdict: Flash; seq: number }>

/** How long a key's flash lasts; must outlast the CSS animation. */
const FLASH_MS = 450

/** Beats of count-in before the first note, on top of the chart's own lead-in. */
const COUNT_IN_BEATS = 4

export interface HudSnapshot {
  stats: Stats
  accuracy: number
  /** 0..1 through the song */
  progress: number
  /** the countdown number, or 0 once the song is under way */
  countdown: number
  /** most recent judgement, for the floating verdict text */
  last?: Judgement
}

export interface GameApi {
  phase: Phase
  /** sample-pack progress while `phase` is 'loading' */
  loading: { done: number; total: number }
  hud: HudSnapshot
  layout: Layout
  lanes: LaneMap
  /** lanes currently held down, for lighting the on-screen instrument */
  held: Set<number>
  /** recently played lanes and how they were judged, for the key flash */
  flashes: FlashMap
  /** a MIDI note arrived that this track's keyboard doesn't cover */
  outOfRange: number | null
  /** the instruments playing behind you, with the colours they light up in */
  band: BackingVoice[]
  /** lowest MIDI note the computer keyboard is bound to */
  computerBaseMidi: number
  /** how far in from each edge the highway's near corners sit, as a % */
  edgeInsetPct: number
  transposeSemis: number
  setTranspose: (semis: number) => void
  /** move the computer keyboard's base octave */
  shiftOctave: (delta: number) => void
  press: (lane: number) => void
  release: (lane: number) => void
  /** leave the start gate and run the count-in */
  begin: () => void
  pause: () => void
  resume: () => void
  restart: () => void
  canvasRef: (el: HTMLCanvasElement | null) => void
  finalStats: Stats | null
}

/**
 * `track` is the part as it will be played — already folded, in easy mode — and
 * `easy` is the fold it was folded by, or null on the keyboards where a lane is
 * simply the pitch. Both come from `playableTrack`, together, because a fold and
 * the notes it merged only make sense as a pair.
 */
export function useGame(
  chart: Chart,
  track: Track,
  easy: EasyMap | null,
  onQuit: () => void
): GameApi {
  const settings = useSettings()
  const [phase, setPhase] = useState<Phase>('loading')
  const [hud, setHud] = useState<HudSnapshot>({
    stats: {
      perfect: 0, great: 0, good: 0, miss: 0, wrong: 0,
      holdable: 0, heldFraction: 0, late: 0,
      score: 0, combo: 0, maxCombo: 0, meanErrorMs: 0, biasMs: 0,
    },
    accuracy: 0,
    progress: 0,
    countdown: COUNT_IN_BEATS,
  })
  const [held, setHeld] = useState<Set<number>>(new Set())
  const [finalStats, setFinalStats] = useState<Stats | null>(null)
  const [transposeSemis, setTransposeSemis] = useState(getMidiTranspose)
  const [runId, setRunId] = useState(0)
  const [edgeInsetPct, setEdgeInsetPct] = useState(0)
  const [loading, setLoading] = useState({ done: 0, total: 0 })
  const [flashes, setFlashes] = useState<FlashMap>({})
  const [outOfRange, setOutOfRange] = useState<number | null>(null)
  /** set by the setup effect once the packs are in; cleared once fired */
  const beginRef = useRef<null | (() => void)>(null)
  const flashSeq = useRef(0)
  const flashPrune = useRef(0)
  const rangePrune = useRef(0)
  /** what each held lane is currently sounding, so its release ends that */
  const soundingRef = useRef(new Map<number, NoteSound[]>())

  // How the computer keys address this keyboard: by position on a kit, a fold
  // or a key-per-pitch keyboard, by semitone on the chromatic one.
  const mode = settings.keyboard
  const slots = useMemo(() => keyboardSlots(track, mode, easy), [track, mode, easy])

  // The home row sits one octave above the drawn keyboard's bottom, not on it,
  // so the Z–M row underneath has somewhere real to point: at the base itself
  // those negative offsets fell off the left end of the keyboard and played
  // notes that were neither drawn nor in the chart.
  const initialBase = track.isDrums ? 0 : keyboardRange(track).lowMidi + 12
  const [computerBaseMidi, setComputerBaseMidi] = useState(initialBase)

  const lanesRef = useRef<LaneMap>(new LaneMap(track, easy))
  const [layout, setLayout] = useState<Layout>(() => buildLayout(track, initialBase, mode, easy))

  // The drawn keyboard follows from the track, the base octave and the key
  // bindings. Deriving it in one effect means a remap at the start gate
  // relabels the keys immediately — the input router already reads bindings
  // live, and without this the labels would keep describing the old mapping.
  const bindings = useBindings()
  useEffect(() => {
    setLayout(buildLayout(track, computerBaseMidi, mode, easy))
  }, [track, computerBaseMidi, bindings, mode, easy])

  // Read from the input handler, which must not be rebuilt (and so must not
  // close over `layout`) every time the keyboard shifts an octave.
  const laneOnKeyboardRef = useRef((lane: number) => layout.lanes.some((l) => l.lane === lane))
  laneOnKeyboardRef.current = (lane: number) => layout.lanes.some((l) => l.lane === lane)

  const transportRef = useRef<Transport | null>(null)
  const judgeRef = useRef<Judge | null>(null)
  const highwayRef = useRef<Highway | null>(null)
  const routerRef = useRef<InputRouter | null>(null)
  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const phaseRef = useRef<Phase>('loading')
  phaseRef.current = phase

  // Settings the loop reads every frame; a ref avoids re-running the whole
  // setup effect (which would restart the song) when one of them changes.
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const beatSec = chart.bpm > 0 ? 240 / chart.bpm : 0.5

  // A judgement names the note it claimed by id; playing it needs the note.
  const notesById = useMemo(() => new Map(track.notes.map((n) => [n.id, n])), [track])


  // Who's behind you and what they play. Derived once per song/track pair —
  // it's a full pass over the chart's notes.
  const backing = useMemo(() => buildBacking(chart, track.instrument), [chart, track])

  // ---- setup ---------------------------------------------------------------

  useEffect(() => {
    const s = getSettings()
    const lanes = new LaneMap(track, easy)
    lanesRef.current = lanes

    // A new router starts back at the track's own base octave, so the keyboard
    // it is drawn against has to come back with it — otherwise a restart after
    // a Z/X shift leaves the key labels describing the previous run's mapping.
    setComputerBaseMidi(initialBase)

    const judge = new Judge(track, lanes.laneOfNote, hitWindowById(s.hitWindow), s.offsetMs)
    judgeRef.current = judge

    const leadIn = COUNT_IN_BEATS * beatSec
    const transport = new Transport({
      backing: s.backing ? backingFor(chart, track.instrument) : [],
      leadInSec: leadIn,
      prewarm: [...new Set(chart.allNotes.map((n) => n.instrument))],
      durationSec: chart.durationSec,
      onEnded: () => finish(),
    })
    transportRef.current = transport

    const router = new InputRouter({
      lanes,
      track,
      keyboardBaseMidi: initialBase,
      slots,
      onPlay: handlePlay,
      // The layout follows from the base octave via the effect below, so this
      // only has to report the shift.
      onOctaveShift: setComputerBaseMidi,
    })
    routerRef.current = router
    const unsubHeld = router.subscribeHeld(() => setHeld(new Set(router.held)))

    // The on-screen instrument is a virtual MIDI device upstream, so switching
    // it on keeps the device picker honest about what's currently playable.
    setSimActive(true)

    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const t = transport.now()
      const j = judgeRef.current
      const hw = highwayRef.current
      if (!j) return

      if (phaseRef.current === 'playing') j.expire(t)

      const events = j.drainJudgements()
      if (events.length && hw) {
        hw.push(events.map((e): HighwayEvent => ({ lane: e.lane, verdict: e.verdict, atSec: e.atSec })))
      }
      if (settingsRef.current.missSound && events.some((e) => e.verdict === 'miss')) {
        transport.voices.missThud()
      }

      hw?.setApproach(settingsRef.current.approachSec)
      // The highway catches fire as the combo climbs; read it straight off the
      // judge each frame rather than through the throttled HUD snapshot.
      hw?.setCombo(j.combo)
      hw?.frame(t)

      pushHud(t, events[events.length - 1])

      if (phaseRef.current === 'countdown' && t >= 0) setPhase('playing')
      if (phaseRef.current === 'playing' && j.isComplete() && t > chart.durationSec - 0.1) finish()
    }

    // Throttle the HUD: score and combo don't need 120 Hz, and re-rendering
    // React that often is the one thing that can stall the frame the judge
    // needs. Seeded at -Infinity, not 0 or -1: song time starts *negative* (the
    // count-in), so any finite seed swallows every update until the clock
    // climbs past it — which is most of the count-in the player is meant to be
    // counting along with.
    let lastHud = -Infinity
    const pushHud = (t: number, last?: Judgement) => {
      if (t - lastHud < 0.06 && last === undefined) return
      lastHud = t
      const stats = judgeRef.current!.getStats()
      setHud((prev) => ({
        stats,
        accuracy: accuracy(stats, track.notes.length),
        progress: chart.durationSec > 0 ? Math.max(0, Math.min(1, t / chart.durationSec)) : 0,
        countdown: t < 0 ? Math.ceil(-t / beatSec) : 0,
        last: last ?? prev.last,
      }))
    }

    const finish = () => {
      if (phaseRef.current === 'finished') return
      // Settle any sustain still running, and mark anything untouched as
      // missed, so the final stats account for the whole chart.
      judgeRef.current?.expire(Number.POSITIVE_INFINITY)
      setPhase('finished')
      setFinalStats(judgeRef.current!.getStats())
      transport.voices.allOff()
    }

    let cancelled = false

    // Load every sample pack the song needs *before* the count-in. The engine
    // will happily start on the synth and swap each instrument over as its pack
    // lands, but that means the first bars of every song sound wrong and then
    // change under you — far more noticeable than a second of loading.
    const codes = [...new Set(chart.allNotes.map((n) => n.instrument))]
    setPhase('loading')
    setLoading({ done: 0, total: codes.length })
    void transport.prepare()
    void (async () => {
      let done = 0
      await Promise.all(
        codes.map((c) =>
          // resolves immediately for cached packs and for the four instruments
          // LuteBoi synthesizes too (Lute, Bass, Chiptune, Percussion)
          loadBank(c).then(() => {
            done += 1
            if (!cancelled) setLoading({ done, total: codes.length })
          })
        )
      )
      if (cancelled) return

      // Draw from here on, but don't run the clock: Transport.now() reports
      // -leadIn until start(), so the gate shows the first bars of the chart
      // sitting still on the highway while the player gets their hands ready.
      raf = requestAnimationFrame(tick)
      setPhase('ready')
      beginRef.current = () => {
        if (cancelled) return
        beginRef.current = null
        setPhase('countdown')
        void transport.start().catch(() => {})
      }
    })().catch(() => {
      // the context was torn down before it finished starting (a remount)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      unsubHeld()
      beginRef.current = null
      router.dispose()
      transport.stop()
      setSimActive(false)
      soundingRef.current.clear()
      transportRef.current = null
      judgeRef.current = null
      routerRef.current = null
    }
    // A fresh run is exactly what a change of song, track, keyboard or runId
    // should cause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, track, easy, slots, runId])

  // ---- input ---------------------------------------------------------------

  /**
   * Light a key with the verdict it earned. Driven from handlePlay, which every
   * input source funnels through, so a hardware controller, the on-screen
   * instrument and the computer keys all light the same way.
   */
  const flashLane = useCallback((lane: number, verdict: Flash) => {
    if (lane < 0) return
    flashSeq.current += 1
    const seq = flashSeq.current
    setFlashes((prev) => ({ ...prev, [lane]: { verdict, seq } }))
    // One rolling timer rather than one per flash: the CSS animation is shorter
    // than FLASH_MS, so anything still in the map has already finished playing
    // and is invisible — clearing them together costs nothing and keeps this to
    // a single timer no matter how fast the notes come.
    window.clearTimeout(flashPrune.current)
    flashPrune.current = window.setTimeout(() => setFlashes({}), FLASH_MS)
  }, [])

  const handlePlay = useCallback((ev: PlayEvent) => {
    const transport = transportRef.current
    const judge = judgeRef.current
    if (!transport || !judge) return
    const s = settingsRef.current

    if (ev.kind === 'off') {
      // Letting go ends the sustain as well as the sound.
      if (phaseRef.current === 'playing' || phaseRef.current === 'countdown') {
        judge.release(ev.lane, transport.now() + transport.audioLatencySec)
      }
      // Silence exactly what the press started, not what the lane means now: a
      // folded key's pitch depends on the note it claimed, so anything else
      // would leave a voice sounding with nothing to turn it off.
      const started = soundingRef.current.get(ev.lane) ?? [{ midi: ev.midi, drum: ev.drum }]
      soundingRef.current.delete(ev.lane)
      if (s.hitSound) for (const snd of started) transport.voices.noteOff(track.instrument, snd)
      return
    }

    // Judge against the moment the sound will actually reach the speakers, not
    // the moment the event was handled — on a high-latency output those differ
    // by tens of milliseconds, which is most of a Perfect window.
    const at = transport.now() + transport.audioLatencySec
    const live = phaseRef.current === 'playing' || phaseRef.current === 'countdown'
    const judged = live ? judge.press(ev.lane, at) : null
    // A press that claimed no note is a wrong note — but taking hold of a
    // sustain again is neither a hit nor a mistake, so it gets no flash at all.
    // Before the song is live there's nothing to be wrong about.
    if (live && judged !== 'resumed') {
      flashLane(ev.lane, judged ? (judged.late ? 'late' : judged.verdict) : 'wrong')
    }

    // A MIDI note outside the drawn keyboard has no key to light, so say so —
    // otherwise a controller sitting an octave off the part looks broken rather
    // than mistuned, and the transpose control right there is the fix.
    if (ev.lane < 0 || !laneOnKeyboardRef.current(ev.lane)) {
      if (ev.source === 'midi') {
        setOutOfRange(ev.midi ?? null)
        window.clearTimeout(rangePrune.current)
        rangePrune.current = window.setTimeout(() => setOutOfRange(null), 1600)
      }
    }

    // What the press sounds: the notes it actually claimed. On the unfolded
    // keyboards that is the lane's own pitch and nothing changes, but a folded
    // key covers several — so the claimed note is what keeps easy mode sounding
    // like the song rather than like eight notes of it, chords included.
    const claimed =
      judged === 'resumed'
        ? judge.noteSustaining(ev.lane, at)
        : judged
          ? notesById.get(judged.noteId) ?? null
          : null
    const sounds = claimed ? soundsOf(claimed) : [lanesRef.current.soundFor(ev.lane)]

    // The press sounds whatever it was, hit or not, and always as the
    // instrument you chose to play — the instrument answers you even when
    // you're wrong, which is what stops it feeling like a quiz.
    if (s.hitSound && ev.lane >= 0) {
      soundingRef.current.set(ev.lane, sounds)
      for (const snd of sounds) {
        transport.voices.noteOn(track.instrument, { ...snd, volume: 0.35 + 0.65 * ev.velocity })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, flashLane, notesById])

  // ---- canvas --------------------------------------------------------------

  // Deliberately not dependent on `layout`: an octave shift changes the
  // keyboard, and tearing down a WebGL context to redraw a few lane lines would
  // drop frames mid-song. The scene is updated in place by the effects below.
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const canvasRef = useCallback(
    (el: HTMLCanvasElement | null) => {
      canvasElRef.current = el
      highwayRef.current?.dispose()
      highwayRef.current = null
      if (!el) return
      const s = getSettings()
      const hw = new Highway(el, {
        layout: layoutRef.current,
        theme: HIGHWAY_THEME,
        approachSec: s.approachSec,
        beatSec,
        goodSec: hitWindowById(s.hitWindow).good / 1000,
        showGuides: s.guides,
        pitchDeg: s.cameraPitch,
      })
      hw.setNotes(judgeRef.current?.states ?? [])
      hw.setBacking(backingRef.current.voices, backingRef.current.pulses, backingRef.current.envelopes)
      highwayRef.current = hw
      setEdgeInsetPct(hw.edgeInsetPct)
    },
    [beatSec]
  )

  // Same reasoning as layoutRef: the canvas callback must not be rebuilt (and
  // so must not close over `backing`) or the WebGL context is torn down and
  // recreated whenever the band changes.
  const backingRef = useRef(backing)
  backingRef.current = backing
  useEffect(() => {
    highwayRef.current?.setBacking(backing.voices, backing.pulses, backing.envelopes)
  }, [backing])

  useEffect(() => {
    highwayRef.current?.setLayout(layout)
  }, [layout])

  // The judge is rebuilt by the setup effect, which may land after the canvas
  // callback; re-point the highway at whatever the current note states are.
  useEffect(() => {
    if (judgeRef.current) highwayRef.current?.setNotes(judgeRef.current.states)
  }, [runId, phase])

  useEffect(() => {
    const onResize = () => {
      const hw = highwayRef.current
      if (!hw) return
      hw.resize()
      setEdgeInsetPct(hw.edgeInsetPct)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    highwayRef.current?.setGuides(settings.guides)
    highwayRef.current?.setGoodSec(hitWindowById(settings.hitWindow).good / 1000)
    transportRef.current?.setBackingEnabled(settings.backing)
  }, [settings.guides, settings.backing, settings.hitWindow])

  // Re-tilting also re-fits the runway length, so the keyboard inset moves too.
  useEffect(() => {
    const hw = highwayRef.current
    if (!hw) return
    hw.setPitch(settings.cameraPitch)
    setEdgeInsetPct(hw.edgeInsetPct)
  }, [settings.cameraPitch])

  // Losing the tab mid-song would otherwise rack up misses you never saw.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && phaseRef.current === 'playing') pause()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- controls ------------------------------------------------------------

  const begin = useCallback(() => beginRef.current?.(), [])

  const pause = useCallback(() => {
    if (phaseRef.current !== 'playing' && phaseRef.current !== 'countdown') return
    transportRef.current?.pause()
    setPhase('paused')
  }, [])

  const resume = useCallback(() => {
    if (phaseRef.current !== 'paused') return
    void transportRef.current?.resume()
    setPhase(transportRef.current && transportRef.current.now() < 0 ? 'countdown' : 'playing')
  }, [])

  const restart = useCallback(() => {
    setFinalStats(null)
    setRunId((n) => n + 1)
  }, [])

  const setTranspose = useCallback((semis: number) => {
    setTransposeSemis(semis)
    setMidiTranspose(semis)
    routerRef.current?.setTranspose(semis)
  }, [])

  // Escape pauses, and pauses again to quit — the same key doing both is
  // muscle memory from every rhythm game.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Nothing has started yet at the gate, so there's nothing to pause —
      // Escape there means "I picked the wrong instrument".
      if (phaseRef.current === 'paused' || phaseRef.current === 'ready') onQuit()
      else pause()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pause, onQuit])

  return {
    phase,
    loading,
    hud,
    layout,
    lanes: lanesRef.current,
    held,
    flashes,
    outOfRange,
    band: backing.voices,
    computerBaseMidi,
    edgeInsetPct,
    transposeSemis,
    setTranspose,
    shiftOctave: (d) => routerRef.current?.shiftOctave(d),
    begin,
    press: (lane) => routerRef.current?.screenPress(lane),
    release: (lane) => routerRef.current?.screenRelease(lane),
    pause,
    resume,
    restart,
    canvasRef,
    finalStats,
  }
}
