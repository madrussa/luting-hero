// The 3D note highway.
//
// This is deliberately not a React component. It owns a Three.js scene and is
// driven imperatively by the game loop, one `frame(songTime)` call per rAF, so
// nothing about the rendering path goes through React's scheduler — at eight
// notes a second with a ±16 ms judging window, a re-render sitting between the
// clock and the draw is a visible desync.
//
// Notes are drawn from a fixed pool of instances rather than one mesh each.
// Charts run to thousands of notes; only the second or two on screen needs
// geometry, so a cursor walks the time-sorted chart and hands the visible slice
// to two InstancedMeshes — the solid bar, and an oversized additive copy that
// gives the neon bloom without a post-processing pass.

import * as THREE from 'three'
import type { Layout } from './lanes'
import type { NoteState } from './judge'
import { sampleEnvelope } from './backing'
import type { BackingPulse, BackingVoice, Envelope } from './backing'

// World units. The highway is a fixed slab and time is mapped onto its depth,
// so changing the approach speed changes how much song is on screen, never the
// geometry. The camera is then fitted to the slab (see fitCamera), which is
// what keeps the near edge lined up with the keyboard at any window shape.
const WIDTH = 10
const NOTE_Y = 0.09
const NOTE_THICKNESS = 0.16

/**
 * The runway's depth is *derived*, not chosen: it's fitted so the far end of
 * the approach lands just inside the top of the frame, which means the whole of
 * `approachSec` is on screen and none of it is wasted beyond the edge. It
 * therefore changes with the camera angle, so everything sized by it is built
 * one unit long and scaled — see applyDepth.
 */
const DEFAULT_DEPTH = 18

/**
 * The playfield's palette.
 *
 * There is only one, and it is dark, in both app themes. Every glow in here —
 * the note bloom, the rails, the hit line, the lane flashes, the hit rings — is
 * additive, because that is what a glow is: light added to what's behind it. On
 * a light floor additive has nowhere to go, so all of it saturates to flat
 * white and the effects simply vanish. Rebuilding them as darkening marks would
 * mean opaque quads occluding the notes they sit under. Rhythm games keep the
 * playfield dark for exactly this reason, so light mode themes the chrome — the
 * menus, the settings, the results — and `.game` re-declares the dark tokens
 * for the HUD that sits over the highway.
 *
 * Three.js Color parses `rgba()` but silently throws the alpha away, so
 * translucency is carried alongside the colour and composited by hand: against
 * the floor for the flat marks, by scaling the colour for the additive ones.
 */
export interface HighwayTheme {
  bg: string
  floor: string
  /** ink for lane dividers and beat lines, blended onto the floor */
  ink: string
  gridAlpha: number
  beatAlpha: number
  barAlpha: number
  /** lane dividers at each C, and the side rails */
  accent: string
  accentAlpha: number
  /** notes in white-key lanes / black-key lanes */
  noteA: string
  noteB: string
  hitLine: string
  missed: string
}

export const HIGHWAY_THEME: HighwayTheme = {
  bg: '#14121f',
  floor: '#1d1a2e',
  ink: '#ffffff',
  gridAlpha: 0.09,
  beatAlpha: 0.07,
  barAlpha: 0.2,
  accent: '#9d7bff',
  accentAlpha: 0.45,
  noteA: '#9d7bff',
  noteB: '#5ad1b3',
  hitLine: '#e8e4f5',
  missed: '#ff7a90',
}

const MAX_NOTES = 900
const MAX_BEATS = 96
const MAX_BURSTS = 24

// ---- the backing band ------------------------------------------------------
/**
 * Each backing instrument is a wave running along its own side of the highway,
 * scrolling toward you on exactly the same time axis as the notes: the point at
 * depth z is that instrument's activity at the song time the notes arriving
 * there will land on. So the shape of the next couple of seconds of the
 * arrangement is visible before you hear it — a section starting is a swell
 * rolling in from the distance, and a section stopping is the wave going flat
 * ahead of the silence.
 */
const WAVE_SAMPLES = 110
const WAVE_HEIGHT = 2.4
/** how far off the highway edge the innermost wave stands, and the gap per row */
const WAVE_X0 = WIDTH / 2 + 0.9
const WAVE_GAP = 1.7
const MAX_BACKING_VOICES = 8
/** seconds for the drum flash driving the rails to fall back */
const DRUM_DECAY = 0.26
/** how long a judged note lingers before the pool stops drawing it */
const HIT_FLASH_SEC = 0.22
/**
 * Drum bars are a fixed length rather than their written duration. A kick's
 * `durSec` is the slot it occupies in the notation, not how long the drum
 * sounds or how long you hold anything — drawing a half-bar rest as a bar the
 * length of the highway says something about the music that isn't true.
 */
const DRUM_NOTE_LEN = 0.9

/**
 * How much silence in front of a note counts as "no seam you can see", and so
 * earns it a strike mark — as a fraction of the approach, because that is what
 * the runway's whole length is. A twentieth of the screen's worth of gap is a
 * few pixels at the far end and still thin where it matters, which is exactly
 * the case where a run of notes on one key reads as a single held bar.
 */
const MARK_GAP = 0.05

/** The biggest a strike mark gets, whatever the lane is wide. */
const MARK_MAX_SIZE = 0.8
const STRIKE_SEC = 0.4
const BURST_SEC = 0.45

export interface HighwayOptions {
  layout: Layout
  theme: HighwayTheme
  approachSec: number
  /** seconds per song beat, for the scrolling beat lines */
  beatSec: number
  /**
   * The Good window in seconds: how the highway knows when a note is overdue,
   * and how far back from the hit line the hit zone reaches — depth here *is*
   * time, so a window is a distance.
   */
  goodSec: number
  showGuides: boolean
  /**
   * How far the camera tilts down, in degrees. Steeper is more top-down, which
   * spreads the approach more evenly across the screen; shallower is more
   * cinematic but crushes the far half of every note's travel into a thin band
   * at the horizon.
   */
  pitchDeg: number
}

/** A hit or miss the highway should react to. */
export interface HighwayEvent {
  lane: number
  verdict: 'perfect' | 'great' | 'good' | 'miss'
  atSec: number
}

/** Colours that only change when the theme does, built once per theme. */
interface Palette {
  noteA: THREE.Color
  noteB: THREE.Color
  missed: THREE.Color
  beat: THREE.Color
  bar: THREE.Color
  strikeHit: THREE.Color
  strikeMiss: THREE.Color
  /** what a note's colour is pushed toward for its strike mark: the dark behind it */
  mark: THREE.Color
  burstPerfect: THREE.Color
  burstOther: THREE.Color
}

/** Composite an ink colour over the opaque floor at the given alpha. */
const over = (floor: string, ink: string, alpha: number): THREE.Color =>
  new THREE.Color(floor).lerp(new THREE.Color(ink), alpha)

/**
 * Hand an instanced mesh's freshly written instances to the GPU — and *only*
 * those.
 *
 * The pools are sized for the worst case a chart can throw at the screen, which
 * is an order of magnitude more than a typical frame uses: at eight to thirty
 * notes a second and a second or two of approach, fifty of the nine hundred note
 * slots are live. `needsUpdate` alone re-uploads the whole buffer regardless of
 * `count`, so the note bars, their bloom, the strike marks and the flames
 * between them were pushing a quarter of a megabyte per frame to say something
 * about three kilobytes' worth of instances. An update range says how far the
 * writes actually went, and three.js uploads that slice instead.
 *
 * Ranges are cleared by the renderer once it has read them, so they have to be
 * declared each frame, after the writes and before the draw.
 */
function uploaded(mesh: THREE.InstancedMesh): void {
  const { instanceMatrix, instanceColor, count } = mesh
  instanceMatrix.clearUpdateRanges()
  instanceMatrix.addUpdateRange(0, count * 16)
  instanceMatrix.needsUpdate = true
  if (instanceColor) {
    instanceColor.clearUpdateRanges()
    instanceColor.addUpdateRange(0, count * 3)
    instanceColor.needsUpdate = true
  }
}

/**
 * A soft wash, brightest at the far end and fading both toward the player and
 * out to the sides. Painted rather than shaded: one small canvas costs nothing
 * and keeps the material a plain MeshBasicMaterial whose colour the band can
 * tint per frame.
 */
function farGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 128
  const g = c.getContext('2d')!
  // v: 0 at the far edge, 1 nearest the player
  const depth = g.createLinearGradient(0, 0, 0, 128)
  depth.addColorStop(0, 'rgba(255,255,255,1)')
  depth.addColorStop(0.35, 'rgba(255,255,255,0.42)')
  depth.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = depth
  g.fillRect(0, 0, 128, 128)
  // taper the sides so it reads as a spill of light, not a painted rectangle
  const sides = g.createLinearGradient(0, 0, 128, 0)
  sides.addColorStop(0, 'rgba(0,0,0,1)')
  sides.addColorStop(0.28, 'rgba(0,0,0,0)')
  sides.addColorStop(0.72, 'rgba(0,0,0,0)')
  sides.addColorStop(1, 'rgba(0,0,0,1)')
  g.globalCompositeOperation = 'destination-out'
  g.fillStyle = sides
  g.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
}

/**
 * The hit zone's wash: nothing where the window opens, strongest at the hit line.
 *
 * A gradient rather than a flat quad because a hard far edge on the floor reads
 * as a step to be walked onto rather than a region of time, and because the
 * brightness gradient is itself the information: the closer to the line, the
 * better the hit.
 */
function hitZoneTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 4
  c.height = 128
  const g = c.getContext('2d')!
  // v: 0 at the far edge, where the window opens; 1 at the hit line
  const grad = g.createLinearGradient(0, 0, 0, 128)
  grad.addColorStop(0, 'rgba(255,255,255,0)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0.35)')
  grad.addColorStop(1, 'rgba(255,255,255,1)')
  g.fillStyle = grad
  g.fillRect(0, 0, 4, 128)
  return new THREE.CanvasTexture(c)
}

/**
 * The flame trail licking off a burning note: brightest at the near end, where
 * the note is, fading out behind it and tapering at the sides.
 */
function flameTexture(): THREE.CanvasTexture {
  const N = 96
  const c = document.createElement('canvas')
  c.width = c.height = N
  const g = c.getContext('2d')!
  const img = g.createImageData(N, N)
  for (let y = 0; y < N; y++) {
    // v: 0 at the base, 1 at the tip
    const v = 1 - y / (N - 1)
    // A tongue: full width at the base, pinching to nothing at the tip. The
    // curve is what stops it reading as a rectangle with a gradient on it.
    const halfWidth = 0.5 * Math.pow(1 - v, 0.62)
    // brightest just above the base, dying off toward the tip
    const along = Math.pow(1 - v, 0.55) * (0.35 + 0.65 * Math.min(1, v * 6))
    for (let x = 0; x < N; x++) {
      const u = Math.abs(x / (N - 1) - 0.5)
      const across = halfWidth <= 0 ? 0 : Math.max(0, 1 - (u / halfWidth) ** 2)
      const a = Math.max(0, Math.min(1, along * across * across))
      const i = (y * N + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      img.data[i + 3] = a * 255
    }
  }
  g.putImageData(img, 0, 0)
  return new THREE.CanvasTexture(c)
}

/** A soft round dot, for the drifting stars and the larger wisps. */
function dotTexture(softness: number): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(softness, 'rgba(255,255,255,0.35)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

const STAR_COUNT = 620
const WISP_COUNT = 26

// ---- catching fire ---------------------------------------------------------
/**
 * The highway catches light as the combo climbs. It starts at the same place
 * the score multiplier does, so the fire *is* the multiplier made visible
 * rather than a second, competing signal, and reaches full blaze at 40.
 *
 * It's smoothed rather than switched: rising quickly is exciting, but dropping
 * instantly on a break would be a flicker on a single mistimed note. The fall
 * is slower than the rise so a broken combo visibly burns out.
 */
const FIRE_START_COMBO = 10
const FIRE_FULL_COMBO = 40
const FIRE_RISE_SEC = 0.28
const FIRE_FALL_SEC = 0.7
/**
 * The fire takes each note's *own* colour rather than a fire palette. Amber
 * flames on a purple highway read as a separate effect pasted on top; keeping
 * the hue and pushing it toward white at the core makes the note itself look
 * like it's burning.
 */
const FIRE_CORE = '#ffffff'
const EMBER_COUNT = 260
/** embers per second at full blaze */
const EMBER_RATE = 110
/**
 * Flames are emitted along the *length* of a note, not once at its centre — a
 * held bar should burn end to end rather than carry a single tongue in the
 * middle. One quad per FLAME_SPACING world units, capped so a very long note
 * can't flood the pool on its own.
 */
const FLAME_SPACING = 0.85
const MAX_FLAMES_PER_NOTE = 8
const MAX_FLAMES = 700

/**
 * Where the stars live: a wide, deep slab *below* the highway rather than a sky
 * above it.
 *
 * Pitched 44° down, the camera has no sky in frame at all — the floor plane
 * fills it edge to edge, and anything at or above the camera's own height sits
 * tens of degrees outside the frustum. But the floor is only ten units wide, so
 * the wedges either side of it are empty background, and that is where there is
 * room. Scattering the stars underneath and far out to the sides puts them in
 * those wedges; the ones that drift under the highway are hidden by the floor
 * itself, since it writes depth and they only test it. The highway ends up
 * looking like a bridge over open space.
 */
const SKY = { x: 80, yMin: -14, yMax: -0.6, zMin: -80, zMax: 10 }

export class Highway {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera

  private notes!: THREE.InstancedMesh
  private glow!: THREE.InstancedMesh
  /** one disc per note that follows another too closely to see the seam */
  private strikeMarks!: THREE.InstancedMesh
  private beats!: THREE.InstancedMesh
  private strikes!: THREE.InstancedMesh
  private bursts!: THREE.InstancedMesh
  private hitBar!: THREE.Mesh
  /** the judging windows, drawn on the floor: Good, Great, Perfect */
  private hitZone!: THREE.Mesh[]
  private rails: THREE.Mesh[] = []
  private gridLines?: THREE.LineSegments
  private floor!: THREE.Mesh

  /**
   * Scratch transform for every instanced draw.
   *
   * Instance matrices are composed in the InstancedMesh's own local space, so a
   * rotation on the *mesh* rotates instance positions too — a flat quad parented
   * at -90° about x turns an instance at z = -10 into one at y = -10, buried
   * under the floor. Everything flat therefore leaves its mesh unrotated and
   * tilts the instance instead, which keeps instance positions plain world
   * coordinates. Rotation is set explicitly on every use, since the dummy is
   * shared and would otherwise carry the last caller's tilt.
   */
  private readonly dummy = new THREE.Object3D()
  private readonly scratch = new THREE.Color()
  private readonly markInk = new THREE.Color()
  private readonly probe = new THREE.Vector3()

  private opts: HighwayOptions
  private palette!: Palette
  /** lane id -> lane, rebuilt only when the layout changes */
  private laneById: Map<number, Layout['lanes'][number]>
  private states: NoteState[] = []
  /** seconds of silence before each note in its own lane; see setNotes */
  private gapBefore: number[] = []
  /** index of the earliest note still worth drawing */
  private cursor = 0
  /** lane -> the most recent judgement there, for the lane flash */
  private readonly strikeAt = new Map<number, { at: number; verdict: string }>()
  private bursts_: { lane: number; at: number; verdict: string }[] = []

  /** the backing band: one scrolling wave per instrument, plus the far glow */
  private waves: {
    ribbon: THREE.Mesh
    crest: THREE.Line
    color: THREE.Color
    envelope: Envelope
    x: number
  }[] = []
  private farGlow?: THREE.Mesh
  /** drifting sky: small twinkling stars and a few big soft wisps */
  private stars?: THREE.Points
  private wisps?: THREE.Points
  private starDrift: number[] = []
  private starPhase: number[] = []
  private starBase = new Float32Array(0)
  private wispDrift: number[] = []
  private backingVoices: BackingVoice[] = []
  private pulses: BackingPulse[] = []
  private pulseCursor = 0
  private energy: number[] = []
  /** drum energy, shared across the kit — it drives the rails and the far glow */
  private drumEnergy = 0

  /** the highway catching light as the combo climbs, 0..1 */
  private fire = 0
  private fireTarget = 0
  private flames?: THREE.InstancedMesh
  private embers?: THREE.Points
  /** x, y, z, vx, vy, vz, life, maxLife per ember; life <= 0 means free */
  private emberState: Float32Array = new Float32Array(0)
  /** 0 = white-key colour, 1 = black-key colour, chosen when an ember lights */
  private emberTint: Uint8Array = new Uint8Array(0)
  private emberSpawn = 0
  /** embers still cooling, so a burnt-out pool can be skipped entirely */
  private emberLive = 0
  /** the white the fire goes at its core; a field, not a per-frame Color */
  private readonly fireCore = new THREE.Color(FIRE_CORE)

  /** camera shake accumulator, driven by misses */
  private shake = 0
  private skyClock = 0
  private lastFrameSec = 0
  /** half-width of the hit line in NDC, so the keyboard can match it */
  private nearHalfWidthNdc = 1
  /** runway length in world units; fitted to the camera angle by fitCamera */
  private depth = DEFAULT_DEPTH
  private disposed = false

  constructor(canvas: HTMLCanvasElement, opts: HighwayOptions) {
    this.opts = opts
    this.laneById = new Map(opts.layout.lanes.map((l) => [l.lane, l]))
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 200)
    this.buildPalette()
    this.build()
    this.resize()
  }

  // ---- construction --------------------------------------------------------

  private buildPalette(): void {
    const t = this.opts.theme
    this.palette = {
      noteA: new THREE.Color(t.noteA),
      noteB: new THREE.Color(t.noteB),
      missed: new THREE.Color(t.missed),
      beat: over(t.floor, t.ink, t.beatAlpha),
      bar: over(t.floor, t.ink, t.barAlpha),
      strikeHit: new THREE.Color(t.noteA),
      strikeMiss: new THREE.Color(t.missed),
      mark: new THREE.Color(t.bg),
      burstPerfect: new THREE.Color(t.noteB),
      burstOther: new THREE.Color(t.noteA),
    }
  }

  private build(): void {
    const { theme } = this.opts
    this.scene.background = new THREE.Color(theme.bg)
    // Fog does the heavy lifting for depth: distant notes dissolve into the
    // backdrop instead of piling up as unreadable confetti at the horizon.
    this.scene.fog = new THREE.Fog(theme.bg, this.depth * 0.5, this.depth * 1.1)

    // Built one unit deep and stretched by applyDepth, so a change of camera
    // angle is a scale rather than a rebuild of every buffer in the scene.
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH, 1),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.floor), fog: true })
    )
    this.floor.rotation.x = -Math.PI / 2
    this.scene.add(this.floor)

    this.buildSky()
    this.buildFire()
    this.buildGrid()
    this.buildRails()

    this.buildHitZone()

    this.hitBar = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH, 0.06),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(theme.hitLine),
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    )
    this.hitBar.rotation.x = -Math.PI / 2
    this.hitBar.position.set(0, 0.02, -0.03)
    this.scene.add(this.hitBar)

    this.beats = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(WIDTH, 0.045),
      new THREE.MeshBasicMaterial({ fog: true }),
      MAX_BEATS
    )
    this.beats.frustumCulled = false
    this.scene.add(this.beats)

    // Per-lane flash at the hit line. Additive over black means "off", so the
    // instance colour doubles as its opacity — InstancedMesh has no per-instance
    // alpha, and this needs none.
    this.strikes = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 3.4),
      new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      Math.max(1, this.opts.layout.lanes.length)
    )
    this.strikes.frustumCulled = false
    this.scene.add(this.strikes)

    this.bursts = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.4, 0.5, 24),
      new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      MAX_BURSTS
    )
    this.bursts.frustumCulled = false
    this.scene.add(this.bursts)

    this.buildBand()

    const noteGeo = new THREE.BoxGeometry(1, NOTE_THICKNESS, 1)
    this.notes = new THREE.InstancedMesh(noteGeo, new THREE.MeshBasicMaterial({ fog: true }), MAX_NOTES)
    this.notes.frustumCulled = false
    this.scene.add(this.notes)

    this.glow = new THREE.InstancedMesh(
      noteGeo,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: true,
      }),
      MAX_NOTES
    )
    this.glow.frustumCulled = false
    this.scene.add(this.glow)

    // The strike marks that sit on top of the bars. A disc, not a line across
    // the bar: a line reads as the seam it is trying to point out, where a disc
    // reads as a thing to hit.
    //
    // Marked transparent although it is opaque, purely to put it in the
    // transparent pass *after* the note bloom — an additive glow drawn over the
    // mark would wash out exactly the contrast the mark is made of, and on a big
    // combo the flames make that worse, not better.
    this.strikeMarks = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.5, 14),
      new THREE.MeshBasicMaterial({ fog: true, transparent: true, depthWrite: false }),
      MAX_NOTES
    )
    this.strikeMarks.frustumCulled = false
    this.strikeMarks.renderOrder = 2
    this.scene.add(this.strikeMarks)
  }

  /**
   * The backing band's fixtures. Built once at full capacity and simply left
   * unused when a song has fewer voices — rebuilding InstancedMeshes on a song
   * change would mean disposing GPU buffers mid-scene for no gain.
   */
  /**
   * Drifting stars and slower, larger wisps above the highway.
   *
   * Both are Points with a soft radial sprite and additive blending, so they
   * glow rather than sit flat. depthTest stays on and depthWrite off: the floor
   * must occlude anything behind it, but the stars must not occlude each other
   * into hard-edged discs where they overlap.
   *
   * Each star carries its own drift speed and twinkle phase, held in plain
   * arrays alongside the geometry. The alternative — a custom shader — would
   * move the animation onto the GPU, but a few hundred points is nothing to
   * update on the CPU and this keeps the whole scene on stock materials.
   */
  private buildSky(): void {
    const make = (count: number, size: number, softness: number, opacity: number) => {
      const pos = new Float32Array(count * 3)
      const col = new Float32Array(count * 3)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
      const points = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          size,
          map: dotTexture(softness),
          vertexColors: true,
          transparent: true,
          opacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
          fog: false,
        })
      )
      points.frustumCulled = false
      this.scene.add(points)
      return points
    }

    this.stars = make(STAR_COUNT, 0.7, 0.25, 1)
    this.wisps = make(WISP_COUNT, 20, 0.05, 0.2)

    // Deterministic-ish scatter. Stars are tinted between the two note colours
    // so the sky belongs to the same palette as everything else.
    const a = new THREE.Color(this.opts.theme.noteA)
    const b = new THREE.Color(this.opts.theme.noteB)
    const white = new THREE.Color('#ffffff')
    const seed = (n: number) => {
      const x = Math.sin(n * 12.9898) * 43758.5453
      return x - Math.floor(x)
    }

    for (const [pts, n, tintable] of [
      [this.stars, STAR_COUNT, true],
      [this.wisps, WISP_COUNT, false],
    ] as const) {
      const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute
      const col = pts.geometry.getAttribute('color') as THREE.BufferAttribute
      const p = pos.array as Float32Array
      const c = col.array as Float32Array
      const drift: number[] = []
      const phase: number[] = []
      for (let i = 0; i < n; i++) {
        p[i * 3] = (seed(i + 1) - 0.5) * SKY.x * 2
        p[i * 3 + 1] = SKY.yMin + seed(i + 7.3) * (SKY.yMax - SKY.yMin)
        p[i * 3 + 2] = SKY.zMin + seed(i + 3.1) * (SKY.zMax - SKY.zMin)
        // most stars stay near white; a few take the accent hues
        const t = seed(i + 5.7)
        this.scratch.copy(white).lerp(t < 0.5 ? a : b, tintable ? t * 0.7 : 0.55)
        const bright = tintable ? 0.35 + seed(i + 9.2) * 0.65 : 1
        c[i * 3] = this.scratch.r * bright
        c[i * 3 + 1] = this.scratch.g * bright
        c[i * 3 + 2] = this.scratch.b * bright
        drift.push(0.35 + seed(i + 11.4) * (tintable ? 1.5 : 0.4))
        phase.push(seed(i + 13.8) * Math.PI * 2)
      }
      pos.needsUpdate = true
      col.needsUpdate = true
      if (tintable) {
        this.starDrift = drift
        this.starPhase = phase
        this.starBase = Float32Array.from(c)
      } else {
        this.wispDrift = drift
      }
    }
  }

  /**
   * Drift the sky toward the player and wrap it, and twinkle the stars.
   * Independent of song time so the sky keeps moving while paused — it is
   * scenery, not information.
   */
  private updateSky(dt: number, t: number): void {
    if (!this.stars || !this.wisps) return

    const advance = (pts: THREE.Points, drift: number[], scale: number) => {
      const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute
      const p = pos.array as Float32Array
      for (let i = 0; i < drift.length; i++) {
        let z = p[i * 3 + 2] + drift[i] * scale * dt
        if (z > SKY.zMax) z = SKY.zMin
        p[i * 3 + 2] = z
      }
      pos.needsUpdate = true
    }
    advance(this.stars, this.starDrift, 1)
    advance(this.wisps, this.wispDrift, 0.35)

    // Twinkle: a slow sine per star over its own base colour.
    const col = this.stars.geometry.getAttribute('color') as THREE.BufferAttribute
    const c = col.array as Float32Array
    for (let i = 0; i < this.starPhase.length; i++) {
      const k = 0.55 + 0.45 * Math.sin(t * 1.7 + this.starPhase[i])
      c[i * 3] = this.starBase[i * 3] * k
      c[i * 3 + 1] = this.starBase[i * 3 + 1] * k
      c[i * 3 + 2] = this.starBase[i * 3 + 2] * k
    }
    col.needsUpdate = true
  }

  /**
   * Flame trails and embers. Both are allocated once at full capacity and left
   * with count 0 until the combo lights them, so nothing is built mid-run.
   */
  private buildFire(): void {
    this.flames = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: flameTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: true,
      }),
      MAX_FLAMES
    )
    this.flames.frustumCulled = false
    this.flames.count = 0
    this.scene.add(this.flames)

    const pos = new Float32Array(EMBER_COUNT * 3)
    const col = new Float32Array(EMBER_COUNT * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    this.embers = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.34,
        map: dotTexture(0.3),
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
        fog: false,
      })
    )
    this.embers.frustumCulled = false
    this.scene.add(this.embers)
    this.emberState = new Float32Array(EMBER_COUNT * 8)
    this.emberTint = new Uint8Array(EMBER_COUNT)
  }

  /**
   * Embers lifting off the hit line. Spawned at a rate set by how hard the
   * highway is burning, they rise, drift toward the player and cool from
   * white through amber as they go.
   */
  private updateEmbers(dt: number): void {
    if (!this.embers) return
    // Nothing burning and nothing still cooling: every slot is already parked
    // out of frame and black from the last frame that ran, so walking the pool
    // to park them again — and uploading both attributes to say so — buys
    // nothing. Below the fire's starting combo, which is most of a run, this is
    // the whole of the ember cost.
    if (this.fire === 0 && this.emberLive === 0) {
      this.embers.visible = false
      return
    }
    this.embers.visible = true

    const s = this.emberState
    const pos = this.embers.geometry.getAttribute('position') as THREE.BufferAttribute
    const col = this.embers.geometry.getAttribute('color') as THREE.BufferAttribute
    const p = pos.array as Float32Array
    const c = col.array as Float32Array

    this.emberSpawn += dt * EMBER_RATE * this.fire
    // Embers in the highway's own colours, so they read as the notes throwing
    // off sparks rather than as a separate fire effect over the top.
    const core = this.fireCore
    let live = 0

    for (let i = 0; i < EMBER_COUNT; i++) {
      const b = i * 8
      if (s[b + 6] <= 0) {
        // free slot: light a new one if there's spawn budget left this frame
        if (this.emberSpawn < 1) {
          p[i * 3 + 1] = -999 // park it out of frame
          c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = 0
          continue
        }
        this.emberSpawn -= 1
        const life = 0.7 + Math.random() * 0.8
        s[b] = (Math.random() - 0.5) * WIDTH * 0.98
        s[b + 1] = 0.05
        s[b + 2] = -Math.random() * this.depth * 0.5
        s[b + 3] = (Math.random() - 0.5) * 0.7
        s[b + 4] = 1.4 + Math.random() * 1.8
        s[b + 5] = 1.2 + Math.random() * 1.6
        s[b + 6] = life
        s[b + 7] = life
        // half take the white-key colour, half the black-key one
        s[b + 3] = (Math.random() - 0.5) * 0.7
        this.emberTint[i] = Math.random() < 0.5 ? 0 : 1
      }
      s[b + 6] -= dt
      s[b] += s[b + 3] * dt
      s[b + 1] += s[b + 4] * dt
      s[b + 2] += s[b + 5] * dt
      s[b + 4] += dt * 0.6 // embers accelerate upward as they lighten

      const k = Math.max(0, s[b + 6] / s[b + 7])
      if (k > 0) live++
      p[i * 3] = s[b]
      p[i * 3 + 1] = s[b + 1]
      p[i * 3 + 2] = s[b + 2]
      const tint = this.emberTint[i] ? this.palette.noteB : this.palette.noteA
      this.scratch.copy(tint).lerp(core, k * k * 0.6).multiplyScalar(k * 0.75)
      c[i * 3] = this.scratch.r
      c[i * 3 + 1] = this.scratch.g
      c[i * 3 + 2] = this.scratch.b
    }
    this.emberLive = live
    pos.needsUpdate = true
    col.needsUpdate = true
  }

  private buildBand(): void {
    // A light spilling across the far end of the highway, tinted by whichever
    // instruments are currently sounding. The camera never sees the horizon
    // (the tilt puts it above the top of the frame), so this lies flat on the
    // floor and fades toward the player rather than standing up behind it.
    const glowGeo = new THREE.PlaneGeometry(WIDTH * 2.6, 1)
    this.farGlow = new THREE.Mesh(
      glowGeo,
      new THREE.MeshBasicMaterial({
        map: farGlowTexture(),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    )
    this.farGlow.rotation.x = -Math.PI / 2
    this.scene.add(this.farGlow)

  }

  /**
   * Build one wave for a voice: a vertical ribbon standing on the floor beside
   * the highway, plus a bright line tracing its crest.
   *
   * The ribbon's vertex colours are a fixed white-to-black gradient from base
   * to crest, and the *material* colour carries the instrument's hue. Three
   * multiplies the two, so per-frame brightness is one colour assignment rather
   * than a rewrite of the whole colour attribute — the geometry only ever has
   * to update its heights.
   */
  private makeWave(color: THREE.Color, envelope: Envelope, x: number) {
    // Three rows, not two: a wash from the floor up to the crest, then a halo
    // fading out above it. Brightest along the crest with falloff either side
    // is what makes it read as light coming off the wave rather than a shape
    // painted on the air — and it's one extra strip, not a post-processing pass.
    const verts = WAVE_SAMPLES * 3
    const pos = new Float32Array(verts * 3)
    const col = new Float32Array(verts * 3)
    const index: number[] = []
    const ROW = [0.4, 1, 0] // base wash, crest, halo
    for (let i = 0; i < WAVE_SAMPLES; i++) {
      const b = i * 3
      for (let r = 0; r < 3; r++) {
        col[(b + r) * 3] = col[(b + r) * 3 + 1] = col[(b + r) * 3 + 2] = ROW[r]
      }
      if (i < WAVE_SAMPLES - 1) {
        const n = b + 3
        index.push(b, b + 1, n, b + 1, n + 1, n) // floor -> crest
        index.push(b + 1, b + 2, n + 1, b + 2, n + 2, n + 1) // crest -> halo
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geo.setIndex(index)
    const ribbon = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        color,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: true,
      })
    )
    ribbon.frustumCulled = false
    this.scene.add(ribbon)

    const crestGeo = new THREE.BufferGeometry()
    crestGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WAVE_SAMPLES * 3), 3))
    const crest = new THREE.Line(
      crestGeo,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: true,
      })
    )
    crest.frustumCulled = false
    this.scene.add(crest)

    return { ribbon, crest, color, envelope, x }
  }

  private clearWaves(): void {
    for (const w of this.waves) {
      this.scene.remove(w.ribbon, w.crest)
      w.ribbon.geometry.dispose()
      ;(w.ribbon.material as THREE.Material).dispose()
      w.crest.geometry.dispose()
      ;(w.crest.material as THREE.Material).dispose()
    }
    this.waves = []
  }

  private buildGrid(): void {
    if (this.gridLines) {
      this.scene.remove(this.gridLines)
      this.gridLines.geometry.dispose()
      ;(this.gridLines.material as THREE.Material).dispose()
      this.gridLines = undefined
    }
    if (!this.opts.showGuides) return

    const { layout, theme } = this.opts
    const plain = over(theme.floor, theme.ink, theme.gridAlpha)
    const anchor = over(theme.floor, theme.accent, theme.accentAlpha)

    // One divider per lane boundary.
    //
    // Skipping black lanes is a *piano* rule: there, a black key straddles the
    // seam between two whites, so its edges are not lane boundaries and drawing
    // them would double every line. On a compact keyboard or a kit every lane
    // is its own equal-width column, black or not — applying the piano rule
    // there dropped a line for every sharp, which on a part made mostly of
    // sharps meant almost no grid at all.
    const perLane = layout.compact || layout.isDrums
    const relevant = layout.lanes.filter((l) => perLane || !l.black)

    const edges = new Set<number>()
    for (const l of relevant) {
      edges.add(l.center - l.width / 2)
      edges.add(l.center + l.width / 2)
    }
    const anchors = new Set(
      relevant.filter((l) => l.anchor).map((l) => l.center - l.width / 2)
    )

    const pts: number[] = []
    const cols: number[] = []
    for (const e of edges) {
      const x = (e - 0.5) * WIDTH
      const c = anchors.has(e) ? anchor : plain
      pts.push(x, 0.015, 0, x, 0.015, -1)
      cols.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3))
    this.gridLines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, fog: true })
    )
    this.gridLines.frustumCulled = false
    this.scene.add(this.gridLines)
    // The geometry is one unit long and stretched onto the runway. Rebuilding
    // it here makes a fresh object with the default scale, so the stretch has
    // to be re-applied — without this a layout change left the lane lines as
    // one-unit stubs at the very bottom of the highway.
    this.gridLines.scale.set(1, 1, this.depth)
  }

  private buildRails(): void {
    for (const r of this.rails) {
      this.scene.remove(r)
      r.geometry.dispose()
      ;(r.material as THREE.Material).dispose()
    }
    this.rails = []
    const c = new THREE.Color(this.opts.theme.accent)
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.07, 0.07, 1),
        new THREE.MeshBasicMaterial({
          color: c,
          transparent: true,
          opacity: 0.7,
          blending: THREE.AdditiveBlending,
          fog: true,
        })
      )
      rail.position.x = (side * WIDTH) / 2
      rail.position.y = 0.04
      this.scene.add(rail)
      this.rails.push(rail)
    }
    this.applyDepth()
  }

  /** Stretch everything built at unit depth onto the current runway length. */
  /**
   * The hit zone: how much slack you have, drawn on the floor where it falls.
   *
   * Timing tolerance was the one thing on the highway you couldn't see. The hit
   * line says *when*, exactly, and players who keep missing usually aren't
   * misjudging the line — they don't know they have any margin around it, so they
   * either stab early or wait until they're certain and arrive late.
   *
   * Depth here *is* time, so the Good window is a band: it opens where the wash
   * begins and closes at the hit line. The moment it opens gets a **line**,
   * because that is a discrete event worth marking exactly — from there on, a
   * strike counts.
   *
   * Only the Good window is drawn. Perfect and Great were tried as nested bands
   * and as a second line, and neither survives contact with this geometry:
   * perspective crushes everything approaching the near edge, so a Perfect window
   * — a fortieth of the approach — is twenty pixels hiding behind the keyboard,
   * and as a line in mint it is the same colour as half the notes. The wash
   * brightening toward the line says "closer is better" without needing either.
   *
   * Only the early half is on screen, since the near edge of the runway is the
   * hit line — the keyboard starts there. That is the half worth drawing anyway:
   * it's the approach you can see coming and time yourself against.
   */
  private buildHitZone(): void {
    const { theme } = this.opts
    // A wash that fades in from nothing, rather than a slab: at these depths a
    // hard far edge reads as a step in the floor to be walked onto.
    const wash = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH, 1),
      new THREE.MeshBasicMaterial({
        map: hitZoneTexture(),
        // The highway's own accent, pooling at the line: near-white desaturates
        // against the purple floor into something that reads as a grey stain.
        color: new THREE.Color(theme.accent),
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    )
    // A thin bright edge where the window opens — the moment a note becomes
    // hittable, which is the one instant worth marking exactly.
    const opens = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH, 0.09),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(theme.hitLine),
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    )
    this.hitZone = [wash, opens]
    for (const mesh of this.hitZone) {
      mesh.rotation.x = -Math.PI / 2
      mesh.position.y = 0.008
      mesh.visible = false // until layoutHitZone has somewhere to put it
      this.scene.add(mesh)
    }
    this.layoutHitZone()
  }

  /**
   * Place the zone. Called whenever the runway's length or the mapping of time
   * onto it changes — a re-tilt, a scroll-speed change, a different hit window —
   * since each of those moves where a given number of milliseconds lands.
   */
  private layoutHitZone(): void {
    if (!this.hitZone) return
    const { approachSec, goodSec } = this.opts
    if (approachSec <= 0 || this.depth <= 0) return
    const [wash, opens] = this.hitZone

    // How far back from the line the window reaches, in world units.
    const good = (goodSec / approachSec) * this.depth
    wash.visible = good > 0.05
    wash.scale.set(1, good, 1)
    wash.position.z = -good / 2
    opens.visible = wash.visible
    opens.position.z = -good
  }

  private applyDepth(): void {
    const d = this.depth
    // Fog is set from how far the *camera* is from the end of the runway, not
    // from the runway's own length. Those diverge sharply once the depth is
    // fitted to the camera angle — a steep angle makes for a short runway, and
    // a fog distance keyed to that length ate most of the highway.
    const far = Math.hypot(this.baseCamera.y, this.baseCamera.z + d)
    this.scene.fog = new THREE.Fog(this.opts.theme.bg, far * 0.6, far * 1.04)
    this.floor.scale.set(1, d, 1)
    this.floor.position.z = -d / 2
    for (const rail of this.rails) {
      rail.scale.set(1, 1, d)
      rail.position.z = -d / 2
    }
    if (this.gridLines) this.gridLines.scale.set(1, 1, d)
    this.layoutHitZone()
    if (this.farGlow) {
      this.farGlow.scale.set(1, d * 0.55, 1)
      this.farGlow.position.set(0, 0.04, -d + d * 0.275)
    }
  }

  // ---- camera --------------------------------------------------------------

  /**
   * Place the camera so the highway's near edge spans (almost) the full width
   * of the canvas and sits just above its bottom edge — the classic rhythm-game
   * trapezoid, with the keyboard directly under it.
   *
   * Hand-tuned camera constants can't do this, because where the near edge
   * lands depends on the aspect ratio: one fixed camera crops the outer lanes
   * off a narrow window and strands the highway mid-screen on a wide one.
   *
   * The tilt is an artistic choice, so it's a constant. Everything else falls
   * out of it. A point sitting `a` below the view axis projects to
   * ndc.y = -tan(a)/tan(vfov/2) regardless of how far away it is, so fixing
   * where the hit line should land fixes `a` — and putting the camera at
   * elevation PITCH + a above the hit line then guarantees that vertical
   * placement at *any* distance. That leaves one free variable, the distance,
   * and one constraint, the width. Distance shrinks the near edge
   * monotonically, so a single bisection settles it. Runs on resize only.
   */
  private fitCamera(): void {
    const PITCH = (this.opts.pitchDeg * Math.PI) / 180 // view axis, below horizontal
    const TARGET_X = 0.98 // near edge in NDC: just inside the frame
    const TARGET_Y = -0.985 // hit line: hard against the bottom, so the keys meet it
    const TARGET_FAR = 0.97 // far end of the runway: just inside the top

    const halfV = (this.camera.fov / 2) * (Math.PI / 180)
    // the angle below the view axis that projects to TARGET_Y
    const drop = Math.atan(-TARGET_Y * Math.tan(halfV))
    const phi = PITCH + drop // camera elevation, seen from the hit line

    const place = (dist: number) => {
      const y = dist * Math.sin(phi)
      const z = dist * Math.cos(phi)
      this.camera.position.set(0, y, z)
      this.camera.lookAt(0, y - Math.sin(PITCH) * 10, z - Math.cos(PITCH) * 10)
      this.camera.updateMatrixWorld()
      return { y, z }
    }
    const nearEdgeX = () => this.probe.set(WIDTH / 2, 0, 0).project(this.camera).x

    let lo = 0.5
    let hi = 120
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      place(mid)
      if (nearEdgeX() > TARGET_X) lo = mid // too wide: pull back
      else hi = mid
    }

    const dist = (lo + hi) / 2
    const { y, z } = place(dist)
    this.baseCamera = { y, z, pitch: PITCH }
    this.nearHalfWidthNdc = Math.abs(nearEdgeX())

    // Now fit the runway itself: how far back can the far end sit and still be
    // inside the frame? Any further and the first part of every note's approach
    // happens off-screen; any nearer and screen space is left unused. Pushing
    // it back moves it up the frame monotonically, so one more bisection does
    // it. This is what keeps the whole of approachSec visible at any angle.
    const farNdcY = (depth: number) => this.probe.set(0, 0, -depth).project(this.camera).y
    let dlo = 2
    let dhi = 400
    for (let i = 0; i < 40; i++) {
      const mid = (dlo + dhi) / 2
      if (farNdcY(mid) < TARGET_FAR) dlo = mid
      else dhi = mid
    }
    this.depth = (dlo + dhi) / 2
    this.applyDepth()
  }

  private baseCamera = { y: 5, z: 7, pitch: 0.59 }

  private aimCamera(x: number, y: number, z: number): void {
    const { pitch } = this.baseCamera
    this.camera.position.set(x, y, z)
    this.camera.lookAt(x, y - Math.sin(pitch) * 10, z - Math.cos(pitch) * 10)
  }

  /**
   * How far in from each edge of the canvas the highway's near corners sit, as
   * a percentage. The on-screen instrument insets by the same amount, which is
   * what puts every key directly under the lane its notes fall down.
   */
  get edgeInsetPct(): number {
    return ((1 - this.nearHalfWidthNdc) / 2) * 100
  }

  // ---- public API ----------------------------------------------------------

  setNotes(states: NoteState[]): void {
    // The chart is time-sorted, which is what lets the cursor be a single
    // forward walk rather than a scan of the whole chart every frame.
    this.states = states
    this.cursor = 0

    // How much silence sits in front of each note in its own lane. A run of
    // notes on one key with no gaps between them draws as one unbroken bar —
    // the seam where you have to strike again is a line a pixel wide, if that —
    // so each note that follows another closely gets a strike mark. Precomputed
    // here: it's a property of the chart, not of the frame.
    const lastEnd = new Map<number, number>()
    this.gapBefore = states.map((s) => {
      const end = lastEnd.get(s.lane)
      lastEnd.set(s.lane, s.note.timeSec + s.note.durSec)
      return end === undefined ? Infinity : s.note.timeSec - end
    })
  }

  /** Hand over the band: who's playing behind you, and every note they play. */
  setBacking(voices: BackingVoice[], pulses: BackingPulse[], envelopes: Envelope[]): void {
    this.clearWaves()
    this.backingVoices = voices.slice(0, MAX_BACKING_VOICES)
    this.energy = this.backingVoices.map(() => 0)
    this.pulses = pulses
    this.pulseCursor = 0
    this.waves = this.backingVoices.map((v, i) => {
      // alternate sides, stepping outward, so the busiest voices sit nearest
      const side = i % 2 === 0 ? -1 : 1
      const x = side * (WAVE_X0 + Math.floor(i / 2) * WAVE_GAP)
      return this.makeWave(new THREE.Color(v.color), envelopes[i], x)
    })
  }

  setLayout(layout: Layout): void {
    this.opts.layout = layout
    this.laneById = new Map(layout.lanes.map((l) => [l.lane, l]))
    this.buildGrid()
  }

  setApproach(sec: number): void {
    // The loop reads the setting every frame and pushes it here rather than
    // watching for a change, so this is called at frame rate with the same
    // number almost every time — and re-laying the hit zone out for it would be
    // work done to arrive back where it already was.
    if (this.opts.approachSec === sec) return
    this.opts.approachSec = sec
    // Scroll speed changes how much song is on screen, so it moves where a
    // millisecond lands and with it the whole hit zone.
    this.layoutHitZone()
  }

  setGoodSec(sec: number): void {
    this.opts.goodSec = sec
    // The window is drawn on the floor, so a different one is a different zone.
    this.layoutHitZone()
  }

  /**
   * Tell the highway how big the combo is. Everything about the fire follows
   * from this one number.
   */
  setCombo(combo: number): void {
    this.fireTarget = Math.max(
      0,
      Math.min(1, (combo - FIRE_START_COMBO) / (FIRE_FULL_COMBO - FIRE_START_COMBO))
    )
  }

  /** Re-tilt the camera; the runway length is re-fitted to match. */
  setPitch(deg: number): void {
    if (this.opts.pitchDeg === deg) return
    this.opts.pitchDeg = deg
    this.fitCamera()
  }

  setGuides(on: boolean): void {
    if (this.opts.showGuides === on) return
    this.opts.showGuides = on
    this.buildGrid()
  }

  /** React to judgements: flash the lane, ring the hit, shake on a miss. */
  push(events: HighwayEvent[]): void {
    for (const e of events) {
      this.strikeAt.set(e.lane, { at: e.atSec, verdict: e.verdict })
      if (e.verdict === 'miss') {
        this.shake = Math.min(1, this.shake + 0.5)
      } else {
        this.bursts_.push({ lane: e.lane, at: e.atSec, verdict: e.verdict })
        if (this.bursts_.length > MAX_BURSTS) this.bursts_.shift()
      }
    }
  }

  resize(): void {
    const canvas = this.renderer.domElement
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.fitCamera()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose?.()
      const mat = m.material
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
      else mat?.dispose?.()
    })
    this.renderer.dispose()
  }

  /** Draw one frame at song time `t` (seconds; negative during the count-in). */
  frame(t: number): void {
    if (this.disposed) return
    const dt = Math.min(0.1, Math.abs(t - this.lastFrameSec))
    // A restart rewinds the clock; the backing cursor only walks forward, so it
    // has to be sent back to the start with it.
    if (t < this.lastFrameSec - 0.5) this.rewindBacking(t)
    this.lastFrameSec = t

    // The sky runs on wall-clock rather than song time, so it keeps drifting
    // through the count-in and while paused.
    this.skyClock += dt > 0 ? dt : 1 / 60
    this.updateSky(dt > 0 ? dt : 1 / 60, this.skyClock)

    // Rises faster than it falls, so a big combo lights up promptly but a
    // broken one visibly burns out rather than blinking off.
    const tau = this.fireTarget > this.fire ? FIRE_RISE_SEC : FIRE_FALL_SEC
    this.fire += (this.fireTarget - this.fire) * (1 - Math.exp(-dt / tau))
    if (this.fire < 0.002) this.fire = 0
    this.updateEmbers(dt > 0 ? dt : 1 / 60)

    this.updateBand(t, dt)
    this.drawNotes(t)
    this.drawBeats(t)
    this.drawStrikes(t)
    this.drawBursts(t)

    let flare = 0
    for (const s of this.strikeAt.values()) flare = Math.max(flare, 1 - (t - s.at) / 0.25)
    ;(this.hitBar.material as THREE.MeshBasicMaterial).opacity =
      0.34 + 0.4 * Math.max(0, flare) + 0.05 * Math.sin(t * 6)

    // The rails ride the backing drums, so the beat is felt at the edge of
    // vision without anything moving across the notes.
    const railGlow = 0.55 + 0.45 * Math.min(1, this.drumEnergy)
    for (const rail of this.rails) (rail.material as THREE.MeshBasicMaterial).opacity = railGlow

    // A miss knocks the camera; it settles back over a few hundred ms.
    this.shake = Math.max(0, this.shake - dt * 3.2)
    const k = this.shake * this.shake * 0.12
    const { y, z } = this.baseCamera
    this.aimCamera(Math.sin(t * 61) * k, y + Math.sin(t * 47) * k, z)

    this.renderer.render(this.scene, this.camera)
  }

  // ---- per-frame drawing ---------------------------------------------------

  /** Lay the scratch transform flat on the floor at a world position. */
  private flat(x: number, y: number, z: number, w: number, d: number): void {
    this.dummy.rotation.set(-Math.PI / 2, 0, 0)
    this.dummy.position.set(x, y, z)
    // after the tilt, the plane's local height runs along world z
    this.dummy.scale.set(w, d, 1)
    this.dummy.updateMatrix()
  }

  /** World x for a lane centre, from its normalised layout position. */
  private laneX(center: number): number {
    return (center - 0.5) * WIDTH
  }

  private rewindBacking(t: number): void {
    this.pulseCursor = 0
    while (this.pulseCursor < this.pulses.length && this.pulses[this.pulseCursor].timeSec < t) {
      this.pulseCursor++
    }
    this.energy = this.energy.map(() => 0)
    this.drumEnergy = 0
  }

  /**
   * Advance the backing band.
   *
   * Every note the other instruments play strikes its voice's pillars and then
   * decays, so the sides of the scene keep moving through the long stretches
   * where your own part rests — which is exactly when the playfield used to go
   * dead. Energy is capped rather than summed without limit: a dense chord
   * shouldn't peg a pillar for the next second.
   */
  private updateBand(t: number, dt: number): void {
    if (this.backingVoices.length === 0) return
    const { approachSec } = this.opts

    // Energy is what's sounding *now* — it drives the glow at the hit line and
    // the rails. The waves themselves are read straight from the envelopes, so
    // they show the future as well as the present.
    while (this.pulseCursor < this.pulses.length && this.pulses[this.pulseCursor].timeSec <= t) {
      const p = this.pulses[this.pulseCursor++]
      const hit = 0.45 + 0.55 * p.volume
      this.energy[p.voice] = Math.min(1.5, (this.energy[p.voice] ?? 0) + hit)
      if (p.drum) this.drumEnergy = Math.min(1.5, this.drumEnergy + hit)
    }
    const fall = Math.exp(-dt / DRUM_DECAY)
    this.drumEnergy *= fall

    let blendR = 0
    let blendG = 0
    let blendB = 0
    let total = 0

    for (let v = 0; v < this.waves.length; v++) {
      this.energy[v] *= fall
      const w = this.waves[v]
      const now = sampleEnvelope(w.envelope, t)

      const pos = w.ribbon.geometry.getAttribute('position') as THREE.BufferAttribute
      const crestPos = w.crest.geometry.getAttribute('position') as THREE.BufferAttribute
      const p = pos.array as Float32Array
      const c = crestPos.array as Float32Array

      for (let i = 0; i < WAVE_SAMPLES; i++) {
        const f = i / (WAVE_SAMPLES - 1)
        const z = -f * this.depth
        // The key line: depth maps to time exactly as it does for the notes, so
        // the wave and the notes at the same distance belong to the same moment.
        const amp = sampleEnvelope(w.envelope, t + f * approachSec)
        // A slow ripple along the crest keeps a sustained passage alive rather
        // than showing a flat-topped slab.
        const ripple = 1 + 0.12 * Math.sin(f * 22 - t * 3.4)
        const h = amp * WAVE_HEIGHT * ripple
        const halo = h + 0.35 + h * 0.7
        const b = i * 9
        p[b] = w.x
        p[b + 1] = 0
        p[b + 2] = z
        p[b + 3] = w.x
        p[b + 4] = h
        p[b + 5] = z
        p[b + 6] = w.x
        p[b + 7] = halo
        p[b + 8] = z
        c[i * 3] = w.x
        c[i * 3 + 1] = h
        c[i * 3 + 2] = z
      }
      pos.needsUpdate = true
      crestPos.needsUpdate = true

      // Brightness rides what's sounding now, so the near end of the wave
      // pulses with the beat while the far end just shows the shape to come.
      const lit = 0.25 + 0.75 * Math.min(1, now)
      ;(w.ribbon.material as THREE.MeshBasicMaterial).color.copy(w.color).multiplyScalar(lit * 0.9)
      ;(w.crest.material as THREE.LineBasicMaterial).color.copy(w.color).multiplyScalar(lit * 1.5)

      blendR += w.color.r * now
      blendG += w.color.g * now
      blendB += w.color.b * now
      total += now
    }

    // The far glow takes the blend of whatever is currently sounding, so the
    // colour at the end of the highway is the chord being played.
    if (this.farGlow) {
      const mat = this.farGlow.material as THREE.MeshBasicMaterial
      if (total > 0.001) mat.color.setRGB(blendR / total, blendG / total, blendB / total)
      mat.opacity = Math.min(0.5, 0.04 + total * 0.16 + this.drumEnergy * 0.1)
    }
  }

  private drawNotes(t: number): void {
    const { approachSec } = this.opts
    const p = this.palette
    const fire = this.fire
    const core = this.fireCore
    const tilt = -this.baseCamera.pitch // stands the flames up to face the camera
    let flameCount = 0

    // Retire notes whose bar has fully passed the hit line.
    while (this.cursor < this.states.length) {
      const s = this.states[this.cursor]
      if (s.note.timeSec + s.note.durSec >= t - 0.3) break
      this.cursor++
    }

    let n = 0
    let marks = 0
    for (let i = this.cursor; i < this.states.length && n < MAX_NOTES; i++) {
      const s = this.states[i]
      const lead = s.note.timeSec - t
      if (lead > approachSec) break // sorted: everything after is further out
      const lane = this.laneById.get(s.lane)
      if (!lane) continue

      const hitAge = s.hitAtSec !== undefined ? t - s.hitAtSec : -1

      // z runs -depth (just spawned) → 0 (on the hit line). The note's onset is
      // its leading edge and its duration trails away from the player, because
      // the far end of the bar is the part that arrives last.
      const z = (lead / approachSec) * -this.depth
      const lengthZ = this.opts.layout.isDrums
        ? DRUM_NOTE_LEN
        : Math.max(0.5, (s.note.durSec / approachSec) * this.depth)

      // The hit line eats the bar rather than the bar vanishing when struck:
      // the near end is pinned there once the onset has passed, so what's left
      // on screen is exactly the sustain still to be held. Gone when the far
      // end arrives.
      const zFar = z - lengthZ
      const zNear = Math.min(z, 0)
      if (zFar >= 0) continue
      const visibleLen = zNear - zFar

      const missAge = s.verdict === 'miss' ? t - (s.note.timeSec + 0.15) : -1
      // Past its window and still untouched. A long note can be rescued from
      // here, but until it is, it should look like what it is: a note you got
      // wrong. It pulses rather than sitting flat, to read as still savable.
      const overdue = !s.verdict && t > s.note.timeSec + this.opts.goodSec
      const holding = s.holdingFrom !== undefined
      // Only a *holdable* note can be dropped. A struck sixteenth has no
      // sustain to let go of, and dimming it the instant it was hit correctly
      // would read as a mistake.
      const dropped =
        s.holdable && s.verdict !== undefined && s.verdict !== 'miss' && !holding && lead < 0

      let scale = 1
      let intensity = 1
      // A short pop at the moment of the hit, then back to normal — the bar
      // stays, so the pop is punctuation rather than an exit.
      if (hitAge >= 0 && hitAge < HIT_FLASH_SEC) {
        scale = 1 + 0.5 * (1 - hitAge / HIT_FLASH_SEC)
      }
      if (missAge > 0) {
        intensity = Math.max(0.16, 1 - missAge / 0.6)
      } else if (overdue) {
        intensity = 0.7 + 0.3 * Math.sin(t * 12)
      } else if (dropped) {
        // let go early: the rest of the note is still there to be re-grabbed,
        // drawn dim so it's clear it isn't scoring
        intensity = 0.3
      } else if (holding) {
        intensity = 1.25
      }

      this.dummy.rotation.set(0, 0, 0)
      this.dummy.position.set(
        this.laneX(lane.center),
        NOTE_Y + (lane.black ? 0.05 : 0),
        zFar + visibleLen / 2
      )
      this.dummy.scale.set(lane.width * WIDTH * 0.84 * scale, scale, visibleLen)
      this.dummy.updateMatrix()
      this.notes.setMatrixAt(n, this.dummy.matrix)
      this.glow.setMatrixAt(n, this.dummy.matrix)

      this.scratch.copy(
        s.verdict === 'miss' || overdue ? p.missed : lane.black ? p.noteB : p.noteA
      )
      // On a combo the notes come in burning. They keep their own hue and go
      // white at the core rather than turning amber, so the fire looks like the
      // note itself alight instead of an effect laid over it. Each flickers on
      // its own phase. Misses stay red — a dropped note shouldn't be dressed up
      // as part of the streak.
      let flicker = 1
      if (fire > 0 && s.verdict !== 'miss' && !overdue) {
        flicker = 1 + 0.18 * fire * Math.sin(t * 17 + s.note.id * 1.7)
        this.scratch.lerp(core, 0.26 * fire * fire)
      }
      // Notes brighten as they approach, so the eye is pulled to what's next.
      const nearness = 1 - Math.max(0, Math.min(1, lead / approachSec))
      this.scratch.multiplyScalar(intensity * (0.5 + 0.5 * nearness) * flicker)
      this.notes.setColorAt(n, this.scratch)
      this.glow.setColorAt(n, this.scratch)

      // The strike mark: where you have to press *again*.
      //
      // Two notes on one key with no daylight between them draw as a single
      // unbroken bar — the seam is a line a pixel wide at best, and by the time
      // it is close enough to see you have already missed the second note. So a
      // note whose seam is too thin to read gets a disc at its leading edge.
      // Only until it's judged: once you've played it the mark has done its job,
      // and leaving it there would clutter the sustain you're still holding.
      if (marks < MAX_NOTES && z < 0 && !s.verdict && this.gapBefore[i] < approachSec * MARK_GAP) {
        // Sized in world units as well as lane widths: a two-lane part has
        // lanes five units wide, and a mark scaled only to the lane would be a
        // dinner plate. A third of the bar's width, and never more than this,
        // reads as a marking on the note at any lane count.
        const w = Math.min(lane.width * WIDTH * 0.28, MARK_MAX_SIZE, visibleLen * 0.5)
        // Lying on the floor, anything is foreshortened along z — so the disc is
        // stretched back to read round from where the player is sitting, up to a
        // point: past about half again it stops being a circle and starts being
        // a smear down the lane.
        const len = Math.min(w * 1.45, visibleLen * 0.6)
        this.dummy.rotation.set(-Math.PI / 2, 0, 0)
        this.dummy.position.set(
          this.laneX(lane.center),
          NOTE_Y + (lane.black ? 0.05 : 0) + NOTE_THICKNESS / 2 + 0.006,
          z - len / 2
        )
        this.dummy.scale.set(w, len, 1)
        this.dummy.updateMatrix()
        this.strikeMarks.setMatrixAt(marks, this.dummy.matrix)
        // Dark, and a fixed fraction of whatever the bar is doing — so it holds
        // the same contrast whether the bar is dim at the far end, dropped to
        // 30%, or white-hot in the middle of a combo. Going *lighter* was the
        // obvious choice and the wrong one: the fire takes the notes to white,
        // and a pale mark disappears into exactly the streak you most want to
        // keep. Keeping a trace of the note's own hue stops it reading as a hole
        // in the bar.
        this.markInk.copy(this.scratch).lerp(p.mark, 0.72)
        this.strikeMarks.setColorAt(marks, this.markInk)
        marks++
      }

      // Flames standing up off the note. Vertical and tilted to face the
      // camera, not lying on the floor: a flat wash reads as a stain on the
      // track, and the thing that makes fire look like fire is that it rises.
      // Two layers — a wide soft one behind a narrow bright one, flickering out
      // of phase — give it depth without a particle system per note.
      if (fire > 0 && this.flames && s.verdict !== 'miss' && !overdue && !dropped && flameCount < MAX_FLAMES) {
        const laneW = lane.width * WIDTH
        const hue = lane.black ? p.noteB : p.noteA
        const segments = Math.max(
          1,
          Math.min(MAX_FLAMES_PER_NOTE, Math.round(visibleLen / FLAME_SPACING))
        )
        for (let seg = 0; seg < segments && flameCount < MAX_FLAMES; seg++) {
          // spread evenly along the bar, from its far end to its near end
          const f01 = segments === 1 ? 0.5 : seg / (segments - 1)
          const segZ = zFar + visibleLen * f01
          // alternate a wide soft tongue with a narrow bright one so the run
          // has some variation instead of a row of identical flames
          const outer = seg % 2 === 0
          const phase = s.note.id * 2.3 + seg * 1.9
          const wobble = Math.sin(t * (outer ? 11 : 17) + phase)
          const h = (outer ? 1.25 : 0.8) * (0.5 + fire * 1.7) * (1 + 0.25 * wobble)
          this.dummy.rotation.set(tilt, 0, 0)
          this.dummy.position.set(
            this.laneX(lane.center) + wobble * 0.07 * laneW,
            h * 0.42,
            segZ
          )
          this.dummy.scale.set(laneW * (outer ? 1.25 : 0.7), h, 1)
          this.dummy.updateMatrix()
          this.flames.setMatrixAt(flameCount, this.dummy.matrix)
          this.scratch
            .copy(hue)
            .lerp(core, outer ? 0.1 : 0.4)
            .multiplyScalar(fire * (outer ? 0.2 : 0.32) * (0.5 + 0.5 * nearness) * flicker)
          this.flames.setColorAt(flameCount, this.scratch)
          flameCount++
        }
      }
      n++
    }

    if (this.flames) {
      this.flames.count = flameCount
      uploaded(this.flames)
    }

    this.notes.count = n
    this.glow.count = n
    uploaded(this.notes)
    uploaded(this.glow)

    this.strikeMarks.count = marks
    uploaded(this.strikeMarks)
  }

  private drawBeats(t: number): void {
    const { beatSec, approachSec } = this.opts
    if (beatSec <= 0) {
      this.beats.count = 0
      return
    }
    let n = 0
    // Only the beats currently on the highway: start at the first one still
    // ahead of the hit line and walk out to the far end.
    for (let b = Math.ceil(t / beatSec); n < MAX_BEATS; b++) {
      const lead = b * beatSec - t
      if (lead > approachSec) break
      this.flat(0, 0.012, (lead / approachSec) * -this.depth, 1, b % 4 === 0 ? 2.4 : 1)
      this.beats.setMatrixAt(n, this.dummy.matrix)
      this.beats.setColorAt(n, b % 4 === 0 ? this.palette.bar : this.palette.beat)
      n++
    }
    this.beats.count = n
    uploaded(this.beats)
  }

  private drawStrikes(t: number): void {
    let n = 0
    for (const [id, s] of this.strikeAt) {
      const age = t - s.at
      if (age > STRIKE_SEC) {
        this.strikeAt.delete(id)
        continue
      }
      if (age < 0) continue
      const lane = this.laneById.get(id)
      if (!lane) continue
      const k = 1 - age / STRIKE_SEC
      this.flat(this.laneX(lane.center), 0.03, -0.9, lane.width * WIDTH * 0.95, 1)
      this.strikes.setMatrixAt(n, this.dummy.matrix)
      this.scratch
        .copy(s.verdict === 'miss' ? this.palette.strikeMiss : this.palette.strikeHit)
        .multiplyScalar(k * k * 0.85)
      this.strikes.setColorAt(n, this.scratch)
      n++
    }
    this.strikes.count = n
    uploaded(this.strikes)
  }

  private drawBursts(t: number): void {
    let n = 0
    // Retired in place rather than by filtering into a fresh array: this runs
    // every frame, and the rings are the one thing here that would otherwise
    // hand the collector a new array a hundred-odd times a second for the sake
    // of dropping one or two entries off the front.
    let kept = 0
    for (const b of this.bursts_) {
      if (t - b.at <= BURST_SEC) this.bursts_[kept++] = b
    }
    this.bursts_.length = kept
    for (const b of this.bursts_) {
      if (n >= MAX_BURSTS) break
      const age = t - b.at
      if (age < 0) continue
      const lane = this.laneById.get(b.lane)
      if (!lane) continue
      const k = age / BURST_SEC
      const size = 0.55 + k * 2.4
      this.flat(this.laneX(lane.center), 0.05, -0.5, size, size)
      this.bursts.setMatrixAt(n, this.dummy.matrix)
      this.scratch
        .copy(b.verdict === 'perfect' ? this.palette.burstPerfect : this.palette.burstOther)
        .multiplyScalar((1 - k) * 0.85)
      this.bursts.setColorAt(n, this.scratch)
      n++
    }
    this.bursts.count = n
    uploaded(this.bursts)
  }
}
