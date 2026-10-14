// Transport keys shared by every in-app video player (Premiere-style, plan "Phím tắt Premiere" §3.5 / KP-B): the take
// viewer (components/runs/TakeViewer), a take node's player in fullscreen ("Phóng to", components/canvas/TakePlayer)
// and "Phát liền" (components/player/FilmPlayer). This is the ONLY key table of the players: they ask transportKey()
// what a key means and only add what is theirs (Tab inside a fullscreen bar, a focused slider, Esc closing a dialog).
// The canvas column is the contract for the canvas listener (J / K / L, ↑ / ↓ / Home / End; Space there is a tap,
// core/spaceTap — not this table). Pure, no DOM: unit-tested in core/__tests__/transportKeys.test.ts.
import { chordFromEvent, type KeyEventLike } from './keyChord'

export type Player = 'viewer' | 'node-full' | 'film' | 'canvas'

export type TransportOp =
  | 'toggle' // Space: play / pause (while shuttling: stop)
  | 'stop' // K: pause and leave the J / L shuttle
  | 'forward' // L: play forward, again for 2× then 4×
  | 'reverse' // J: play backwards, again for 2× then 4×
  | 'frame-back'
  | 'frame-fwd'
  | 'frame-back5'
  | 'frame-fwd5'
  | 'clip-prev' // ↑: previous take of the scene (viewer) / previous scene (film, canvas)
  | 'clip-next'
  | 'start' // Home
  | 'end' // End
  | 'volume-up' // ↑ / ↓ in a node's fullscreen player (one clip only: nothing to switch to)
  | 'volume-down'
  | 'fullscreen' // Ctrl+` (Windows) or `: toggle fullscreen (in a node's fullscreen player: leave it)
  | 'exit' // Esc (and F in a node's fullscreen player): leave fullscreen; the viewer / film then close on Esc
  | 'star' // the "★ take" chords (M)
  | 'download' // the "Tải video" chords (Ctrl+M; ⌘E on Mac)

/** A row of the table: the chord (core/keymap format, exact modifiers), what it does and where. */
interface Row {
  chord: string
  op: TransportOp
  players: readonly Player[]
  /** Windows / Linux only (Ctrl+` is macOS' "next window" as ⌘`; ⌃ never makes a chord there). */
  notMac?: boolean
}

const PLAYERS: readonly Player[] = ['viewer', 'node-full', 'film']
const ALL: readonly Player[] = ['viewer', 'node-full', 'film', 'canvas']

/** The table (KP §3.5.1). Order matters only for the docs: a chord appears once per player. */
const TABLE: readonly Row[] = [
  { chord: 'Space', op: 'toggle', players: PLAYERS },
  { chord: 'KeyK', op: 'stop', players: ALL },
  { chord: 'KeyL', op: 'forward', players: ALL },
  { chord: 'KeyJ', op: 'reverse', players: ALL },
  { chord: 'ArrowLeft', op: 'frame-back', players: PLAYERS },
  { chord: 'ArrowRight', op: 'frame-fwd', players: PLAYERS },
  { chord: 'Shift+ArrowLeft', op: 'frame-back5', players: PLAYERS },
  { chord: 'Shift+ArrowRight', op: 'frame-fwd5', players: PLAYERS },
  { chord: 'ArrowUp', op: 'clip-prev', players: ['viewer', 'film', 'canvas'] },
  { chord: 'ArrowDown', op: 'clip-next', players: ['viewer', 'film', 'canvas'] },
  { chord: 'ArrowUp', op: 'volume-up', players: ['node-full'] },
  { chord: 'ArrowDown', op: 'volume-down', players: ['node-full'] },
  { chord: 'Home', op: 'start', players: ALL },
  { chord: 'End', op: 'end', players: ALL },
  { chord: 'Ctrl+Backquote', op: 'fullscreen', players: PLAYERS, notMac: true },
  { chord: 'Backquote', op: 'fullscreen', players: PLAYERS },
  // F leaves a node's fullscreen player (the node plan's key; F is "Vừa màn hình" on the canvas).
  { chord: 'KeyF', op: 'exit', players: ['node-full'] },
  { chord: 'Escape', op: 'exit', players: PLAYERS },
]

/** ★ and download default chords until the keymap carries `take.star` / `take.download` (plan KP-A). */
export const DEFAULT_STAR_CHORDS: readonly string[] = ['KeyM']
export const defaultDownloadChords = (mac: boolean): readonly string[] => (mac ? ['Ctrl+KeyE'] : ['Ctrl+KeyM'])

/** Where the registry chords apply: ★ in the viewer and a node's fullscreen player; download only in the viewer. */
const STAR_PLAYERS: readonly Player[] = ['viewer', 'node-full']
const DOWNLOAD_PLAYERS: readonly Player[] = ['viewer']

export interface TransportCtx {
  player: Player
  mac: boolean
  /** Chords of the ★ command (keymap `take.star` once it exists). */
  starChords?: readonly string[]
  /** Chords of the download command (keymap `take.download` once it exists). */
  downloadChords?: readonly string[]
}

/**
 * What a key does in a player: an operation, or null when it is not a transport key there (the player's own rules
 * decide: a node's fullscreen player swallows it, the viewer lets it through, "Phát liền" swallows it). Exact
 * modifiers (Shift+J is not J); a key an input method is composing, a dead key or a Meta (Windows) / Control (Mac)
 * combination is never one (core/keyChord chordFromEvent).
 */
export function transportKey(e: KeyEventLike, ctx: TransportCtx): TransportOp | null {
  const chord = chordFromEvent(e, ctx.mac)
  if (!chord) return null
  for (const row of TABLE) {
    if (row.chord !== chord || !row.players.includes(ctx.player)) continue
    if (row.notMac && ctx.mac) continue
    return row.op
  }
  if (STAR_PLAYERS.includes(ctx.player) && (ctx.starChords ?? DEFAULT_STAR_CHORDS).includes(chord)) return 'star'
  if (DOWNLOAD_PLAYERS.includes(ctx.player) && (ctx.downloadChords ?? defaultDownloadChords(ctx.mac)).includes(chord)) return 'download'
  return null
}

/** Every operation a player knows (from the table): what its key handler must implement. */
function supportOf(p: Player): readonly TransportOp[] {
  const ops = TABLE.filter((r) => r.players.includes(p)).map((r) => r.op)
  if (STAR_PLAYERS.includes(p)) ops.push('star')
  if (DOWNLOAD_PLAYERS.includes(p)) ops.push('download')
  return [...new Set(ops)]
}
export const TRANSPORT_SUPPORT: Readonly<Record<Player, readonly TransportOp[]>> = {
  viewer: supportOf('viewer'),
  'node-full': supportOf('node-full'),
  film: supportOf('film'),
  canvas: supportOf('canvas'),
}

// ---------------- J / K / L shuttle ----------------
export type ShuttleRate = 1 | 2 | 4
export interface Shuttle {
  /** -1 backwards (J), 1 forward (L), 0 none (normal playback at the user's speed, or paused). */
  dir: -1 | 0 | 1
  rate: ShuttleRate
}
export const SHUTTLE_IDLE: Shuttle = { dir: 0, rate: 1 }

/**
 * The shuttle after a key: L / J start at 1× and each press in the same direction doubles up to 4×; the other
 * direction starts over at 1×; K and Space (toggle) leave it.
 */
export function nextShuttle(s: Shuttle, op: 'forward' | 'reverse' | 'stop' | 'toggle'): Shuttle {
  if (op === 'stop' || op === 'toggle') return SHUTTLE_IDLE
  const dir = op === 'forward' ? 1 : -1
  if (s.dir !== dir) return { dir, rate: 1 }
  return { dir, rate: s.rate >= 4 ? 4 : ((s.rate * 2) as ShuttleRate) }
}

/**
 * Was this 'ratechange' (the element's rate when handled) made by the running forward shuttle? Then a player must not
 * store it as the user's speed (usePlayback.setRate would keep a 2× of L, and clamp a 4× to 2×). The backwards shuttle
 * keeps the user's rate on the (paused) element, and after K the user's rate is back before a late event is handled.
 */
export function shuttleOwnsRate(s: Shuttle, rate: number): boolean {
  return s.dir === 1 && rate === s.rate
}

/** Seconds of one frame (the generated clips are 24 fps; a player may know the real frame length). */
export const FRAME_S = 1 / 24

/** Frames a frame operation moves (negative = back), or 0. */
export function frameDelta(op: TransportOp): number {
  return op === 'frame-back' ? -1 : op === 'frame-fwd' ? 1 : op === 'frame-back5' ? -5 : op === 'frame-fwd5' ? 5 : 0
}

/**
 * The time that shows the clip's last frame (0 for an unknown length). Never the length itself: a seek to the very end
 * ends the clip — and restarts it at 0 on a `loop` video (the canvas card's and the viewer's), so End / → would show
 * the first frame instead of the last.
 */
export function lastFrameTime(duration: number, frameS: number = FRAME_S): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  const step = Number.isFinite(frameS) && frameS > 0 ? frameS : FRAME_S
  return Math.max(0, duration - step)
}

/** Where a frame step lands: `frames` frames from `current`, kept inside the clip, at most its last frame (an unknown length only stops at 0). */
export function frameTarget(current: number, frames: number, duration: number, frameS: number = FRAME_S): number {
  const from = Number.isFinite(current) ? current : 0
  const step = Number.isFinite(frameS) && frameS > 0 ? frameS : FRAME_S
  const t = from + frames * step
  const max = Number.isFinite(duration) && duration > 0 ? lastFrameTime(duration, step) : Infinity
  return Math.min(max, Math.max(0, t))
}

/**
 * Home / End on a player's video: Home → the start (playing or paused, as it was); End → paused on the last frame
 * (Premiere's playhead at the end). null = nothing to do (End with an unknown length).
 */
export function edgeSeek(where: 'start' | 'end', duration: number, frameS: number = FRAME_S): { time: number; pause: boolean } | null {
  if (where === 'start') return { time: 0, pause: false }
  if (!Number.isFinite(duration) || duration <= 0) return null
  return { time: lastFrameTime(duration, frameS), pause: true }
}

/**
 * The backwards shuttle moves the picture by hand (Chromium cannot play backwards): where it is after `dtMs` of
 * real time at `rate`, and whether it reached the start (the shuttle then stops).
 */
export function reverseStep(current: number, rate: number, dtMs: number): { time: number; done: boolean } {
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, 250) : 0
  const time = Math.max(0, (Number.isFinite(current) ? current : 0) - (rate * dt) / 1000)
  return { time, done: time <= 0 }
}

/** Volume step of ↑ / ↓ in a node's fullscreen player. */
export const VOLUME_KEY_STEP = 0.05

// ---------------- Escape and fullscreen ----------------
/** An Escape this soon after the browser itself left fullscreen (its own Esc) is the same press: swallow it. */
export const ESC_AFTER_EXIT_MS = 250

/**
 * What an Escape does in a player: leave fullscreen, swallow it (fullscreen just ended on this very press — the dialog
 * must not close too), or its normal job (the viewer / "Phát liền" close).
 */
export function escapeDecision(s: { fullscreen: boolean; exitedAt: number; now: number }): 'exit-fullscreen' | 'swallow' | 'normal' {
  if (s.fullscreen) return 'exit-fullscreen'
  if (Number.isFinite(s.exitedAt) && s.now - s.exitedAt >= 0 && s.now - s.exitedAt < ESC_AFTER_EXIT_MS) return 'swallow'
  return 'normal'
}

// ---------------- what the focused element keeps for itself ----------------
/** The focused element, described without the DOM (tag, input type, ARIA role, editable, focus ring shown). */
export interface FocusDesc {
  tag?: string
  type?: string
  role?: string | null
  editable?: boolean
  /** It shows a keyboard focus ring (`:focus-visible`): reached with Tab, not clicked. */
  focusVisible?: boolean
  /**
   * A media element with its built-in controls (`<video controls>`): the key's target while the focus is on the video
   * or inside those controls (their timeline / volume sliders are out of the page's reach).
   */
  mediaControls?: boolean
  /** The player saw Tab since the last pointer press (what decides for `mediaControls`, see focusKind). */
  keyboard?: boolean
}

export type FocusKind = 'typing' | 'slider' | 'control-key' | 'control-mouse' | 'none'

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'])
const CONTROL_TAGS = new Set(['BUTTON', 'A', 'SUMMARY'])
const CONTROL_ROLES = new Set(['button', 'link', 'checkbox', 'switch', 'menuitem', 'tab', 'option'])

/** Classify the focused element for the players' key rules. */
export function focusKind(d: FocusDesc | null | undefined): FocusKind {
  if (!d || !d.tag) return 'none'
  const tag = d.tag.toUpperCase()
  if (d.editable || tag === 'TEXTAREA' || tag === 'SELECT') return 'typing'
  // Tabbed into a video's own controls: its sliders keep the arrows, Home and End (↑ / ↓ = its volume, not another
  // take). After a click on the picture every transport key stays the player's (← / → frames after a click to pause).
  if (d.mediaControls) return d.keyboard ? 'slider' : 'none'
  if (tag === 'INPUT') {
    const type = (d.type || 'text').toLowerCase()
    if (type === 'range') return 'slider'
    if (!NON_TEXT_INPUTS.has(type)) return 'typing'
    return d.focusVisible ? 'control-key' : 'control-mouse'
  }
  if (d.role === 'slider' || d.role === 'spinbutton') return 'slider'
  if (CONTROL_TAGS.has(tag) || (d.role && CONTROL_ROLES.has(d.role))) return d.focusVisible ? 'control-key' : 'control-mouse'
  return 'none'
}

const SLIDER_KEY = /^(Shift\+)?(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/

/**
 * Viewer / "Phát liền": the operation a key runs, or null to leave it alone. Typing keeps every key; a focused slider
 * keeps its arrows / Home / End; a control reached with Tab keeps Space / Enter (they press it, as screen-reader users
 * expect) — a control only CLICKED (a mouse focus, like "Xoá take") never takes Space: it plays / pauses instead.
 */
export function playerKey(e: KeyEventLike, focus: FocusKind, ctx: TransportCtx): TransportOp | null {
  if (focus === 'typing') return null
  const chord = chordFromEvent(e, ctx.mac)
  if (focus === 'slider' && chord && SLIDER_KEY.test(chord)) return null
  if (focus === 'control-key' && (chord === 'Space' || chord === 'Enter')) return null
  return transportKey(e, ctx)
}

/** A node's fullscreen player decides every key (none may reach the canvas or the app shortcuts behind it). */
export type NodeFullKey =
  | { kind: 'op'; op: TransportOp }
  | { kind: 'slider' } // the focused timeline / volume slider keeps its native arrows, Home and End
  | { kind: 'tab' } // Tab / Shift+Tab: cycle through the bar's controls
  | { kind: 'default' } // Enter on a focused control: the browser presses it
  | { kind: 'block' } // anything else: swallowed

/** The rule of a node's fullscreen player for one keydown (`focus`: the focused element inside the stage, or 'none'). */
export function nodeFullKey(e: KeyEventLike, focus: FocusKind, ctx: Omit<TransportCtx, 'player'>): NodeFullKey {
  const chord = chordFromEvent(e, ctx.mac)
  if (chord === 'Tab' || chord === 'Shift+Tab') return { kind: 'tab' }
  if (focus === 'slider' && chord && SLIDER_KEY.test(chord)) return { kind: 'slider' }
  if (chord === 'Enter' && (focus === 'control-key' || focus === 'control-mouse')) return { kind: 'default' }
  const op = transportKey(e, { ...ctx, player: 'node-full' })
  return op ? { kind: 'op', op } : { kind: 'block' }
}
