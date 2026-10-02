// Pure helpers behind the canvas wires' interactions and effects (no React, no DOM — tested in __tests__/wireFx.test.ts):
// - click vs drag on a wire (click-to-cut must never fire at the end of a pan, a drag or a pinch),
// - the cut animation's geometry (split the drawn bezier where it was clicked),
// - what a wire being dragged would do where it is (valid / invalid target, its color, the handle it snaps to),
// - which wires just appeared (they draw themselves in once).
import type { EdgeKind } from '../../actions'

export type Pt = { x: number; y: number }

// ---------------------------------------------------------------- click vs drag
/** Where and how a press started (pointerdown on the canvas). */
export interface WirePress {
  x: number
  y: number
  /** performance.now() of the press. */
  t: number
  pointerType: string
  /** The wire under the press (edge id), if any. */
  edgeId: string | null
  /** Another finger / pointer was down during the press (pinch, two-finger pan): never a click. */
  multi: boolean
}

/** How far (px on screen) a press may move and still count as a click: a finger wobbles more than a mouse. */
export const CLICK_SLOP: Readonly<Record<string, number>> = { mouse: 4, pen: 8, touch: 10 }
/** A longer press is not a click (long-press, hesitation while aiming). */
export const CLICK_MAX_MS = 750

/** Did this press end as a plain click on the same wire (not a pan / drag / pinch / long press)? */
export function isWireClick(press: WirePress | null, up: { x: number; y: number; t: number; edgeId: string | null }): boolean {
  if (!press || !up.edgeId || press.edgeId !== up.edgeId || press.multi) return false
  const slop = CLICK_SLOP[press.pointerType] ?? CLICK_SLOP.mouse
  const dx = up.x - press.x
  const dy = up.y - press.y
  if (dx * dx + dy * dy > slop * slop) return false
  const dt = up.t - press.t
  return dt >= 0 && dt <= CLICK_MAX_MS
}

/**
 * What a click on a wire does: 'cut' it, or 'default' (React Flow selects it — the old behaviour). Never cut a scene →
 * take wire ('out'), a click on a reconnect grip, a Ctrl / Shift / Cmd click (selects, so a wire among several at a
 * handle can still be picked and reconnected) or anything that was not a real click.
 */
export function wireClickAction(o: {
  clickToCut: boolean
  kind: EdgeKind | null | undefined
  modifier: boolean
  onGrip: boolean
  click: boolean
}): 'cut' | 'default' {
  if (!o.clickToCut || !o.kind || o.kind === 'out' || o.modifier || o.onGrip || !o.click) return 'default'
  return 'cut'
}

// ---------------------------------------------------------------- bezier geometry
export type Cubic = readonly [Pt, Pt, Pt, Pt]

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

/** "M x,y C x1,y1 x2,y2 x,y" (absolute, as getBezierPath draws a wire) → its 4 points; anything else → null. */
export function parseCubicPath(d: string): Cubic | null {
  if (!/^\s*M[\d\s.,eE+-]*C[\d\s.,eE+-]*$/.test(d)) return null
  const n = (d.match(NUM) ?? []).map(Number)
  if (n.length !== 8 || n.some((v) => !Number.isFinite(v))) return null
  return [
    { x: n[0], y: n[1] },
    { x: n[2], y: n[3] },
    { x: n[4], y: n[5] },
    { x: n[6], y: n[7] },
  ]
}

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

export function cubicAt(c: Cubic, t: number): Pt {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const d = 3 * u * t * t
  const e = t * t * t
  return { x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y }
}

const dist2 = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2

/** Curve parameter (0..1) of the point of `c` nearest to `p`: coarse sampling, then a local ternary refinement. */
export function nearestT(c: Cubic, p: Pt, samples = 48): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const d = dist2(cubicAt(c, t), p)
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  let lo = Math.max(0, best - 1 / samples)
  let hi = Math.min(1, best + 1 / samples)
  for (let i = 0; i < 24; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (dist2(cubicAt(c, m1), p) <= dist2(cubicAt(c, m2), p)) hi = m2
    else lo = m1
  }
  return (lo + hi) / 2
}

/** de Casteljau: the two cubics that together draw `c`, split at `t`. */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const p01 = lerp(c[0], c[1], t)
  const p12 = lerp(c[1], c[2], t)
  const p23 = lerp(c[2], c[3], t)
  const p012 = lerp(p01, p12, t)
  const p123 = lerp(p12, p23, t)
  const mid = lerp(p012, p123, t)
  return [
    [c[0], p01, p012, mid],
    [mid, p123, p23, c[3]],
  ]
}

const r2 = (v: number) => Math.round(v * 100) / 100
export function cubicPath(c: Cubic): string {
  return `M${r2(c[0].x)},${r2(c[0].y)} C${r2(c[1].x)},${r2(c[1].y)} ${r2(c[2].x)},${r2(c[2].y)} ${r2(c[3].x)},${r2(c[3].y)}`
}

/** The cut never happens right at an end: both halves keep something to animate. */
export const SPLIT_MIN_T = 0.04

/**
 * Split a drawn wire where it was cut (`at`, flow coordinates; null = its middle) for the cut animation: `toSource` is
 * drawn from the source to the cut, `toTarget` from the cut to the target. null when the path is not a single cubic.
 */
export function splitWirePath(d: string, at: Pt | null): { toSource: string; toTarget: string; point: Pt } | null {
  const c = parseCubicPath(d)
  if (!c) return null
  const raw = at ? nearestT(c, at) : 0.5
  const t = Math.min(1 - SPLIT_MIN_T, Math.max(SPLIT_MIN_T, raw))
  const [a, b] = splitCubic(c, t)
  return { toSource: cubicPath(a), toTarget: cubicPath(b), point: a[3] }
}

// ---------------------------------------------------------------- dragging a wire
export type WireSourceType = 'asset' | 'take' | 'scene' | 'folder'

export interface WireSource {
  type: WireSourceType
  id: string
  /** Take sources: finished (only a finished video can become @video of a scene). */
  takeReady?: boolean
  /** Take sources: its own scene (a scene cannot reference its own video). */
  takeSceneId?: string | null
}

export type WireVerdict = 'valid' | 'invalid' | 'idle'

/**
 * What releasing a wire over this card would do — the same rules as CanvasView.onConnectEnd: images go to scenes;
 * a finished video goes to another scene (@video) or into a folder; a scene's right dot goes into a folder (auto-save);
 * a folder's dot goes to a video or a scene. 'idle' = over nothing / its own card (release opens the menu or does nothing).
 */
export function wireVerdict(src: WireSource, over: { id: string; type?: string | null } | null): WireVerdict {
  if (!over || over.id === src.id) return 'idle'
  switch (src.type) {
    case 'asset':
      return over.type === 'scene' ? 'valid' : 'invalid'
    case 'take':
      if (over.type === 'folder') return 'valid'
      if (over.type === 'scene') return src.takeReady && src.takeSceneId !== over.id ? 'valid' : 'invalid'
      return 'invalid'
    case 'scene':
      return over.type === 'folder' ? 'valid' : 'invalid'
    case 'folder':
      return over.type === 'scene' || over.type === 'take' ? 'valid' : 'invalid'
  }
}

/** Color of a wire being dragged (theme tokens): images teal (H3 frame handles their own color), videos purple, saving indigo. */
export function wireDragColor(type: string | undefined, toHandleId?: string | null): string {
  if (type === 'take') return 'var(--video)'
  if (type === 'scene' || type === 'folder') return 'var(--save)'
  if (toHandleId === 'first') return 'var(--first)'
  if (toHandleId === 'last') return 'var(--last)'
  return 'var(--ref)'
}

/** The handle a valid wire will be drawn to on the card under the pointer (where the line end "snaps"). */
export function snapHandleFor(srcType: WireSourceType, overType: string | undefined): { type: 'source' | 'target'; id: string } | null {
  if (overType === 'folder') return srcType === 'take' || srcType === 'scene' ? { type: 'target', id: 'in' } : null
  if (srcType === 'folder') {
    if (overType === 'take') return { type: 'source', id: 'out' }
    if (overType === 'scene') return { type: 'source', id: 'take' }
    return null
  }
  return overType === 'scene' ? { type: 'target', id: 'ref' } : null
}

/** What pickNodeAt needs of a React Flow internal node (structural: InternalNode fits). */
export interface NodeBoxLike {
  id: string
  type?: string
  hidden?: boolean
  width?: number | null
  height?: number | null
  measured?: { width?: number; height?: number }
  internals: { positionAbsolute: Pt; z?: number }
}

/** The topmost shown node whose box contains `pt` (flow coordinates), skipping `skipId`; null over empty canvas. */
export function pickNodeAt<N extends NodeBoxLike>(nodes: Iterable<N>, pt: Pt, skipId?: string): N | null {
  let best: N | null = null
  for (const n of nodes) {
    if (n.id === skipId || n.hidden) continue
    const w = n.measured?.width ?? n.width ?? 0
    const h = n.measured?.height ?? n.height ?? 0
    if (!w || !h) continue
    const p = n.internals.positionAbsolute
    if (pt.x < p.x || pt.x > p.x + w || pt.y < p.y || pt.y > p.y + h) continue
    // Later nodes are drawn on top; a higher z wins.
    if (!best || (n.internals.z ?? 0) >= (best.internals.z ?? 0)) best = n
  }
  return best
}

// ---------------------------------------------------------------- wires that just appeared
/** At most this many new wires at once animate (more = a project load / big paste: no effect). */
export const MAX_FRESH_WIRES = 12

/** Ids in `next` that were not in `prev` — when few enough to be a user action; none on the first build. */
export function newWireIds(prev: ReadonlySet<string> | null, next: readonly string[], max = MAX_FRESH_WIRES): string[] {
  if (!prev) return []
  const added = next.filter((id) => !prev.has(id))
  return added.length <= max ? added : []
}

/** A new wire must be drawn within this time to animate (it may mount a frame or two later). */
export const FRESH_WIRE_MS = 1500
const freshWires = new Map<string, number>()

export function markFreshWires(ids: readonly string[], now: number = Date.now()) {
  for (const [id, t] of freshWires) if (now - t > FRESH_WIRE_MS) freshWires.delete(id)
  for (const id of ids) freshWires.set(id, now)
}

/** Was this wire created a moment ago? (Not consumed: React may mount a component twice in StrictMode.) */
export function isFreshWire(id: string, now: number = Date.now()): boolean {
  const t = freshWires.get(id)
  return t !== undefined && now - t <= FRESH_WIRE_MS
}
