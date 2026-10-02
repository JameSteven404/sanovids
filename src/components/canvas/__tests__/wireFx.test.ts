// Wires: click vs drag (click-to-cut), the cut animation's split, what a dragged wire would do over a card, new wires.
import { Position } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import {
  CLICK_MAX_MS,
  CLICK_SLOP,
  cubicAt,
  cubicPath,
  isFreshWire,
  isWireClick,
  isWireReconnecting,
  markFreshWires,
  MAX_FRESH_WIRES,
  nearestT,
  newWireIds,
  parseCubicPath,
  pickNodeAt,
  refDotTones,
  setWireReconnecting,
  snapHandleFor,
  splitCubic,
  splitWirePath,
  SPLIT_MIN_T,
  trimCubic,
  wireClickAction,
  wireDragColor,
  WIRE_HIT_TRIM,
  wireHitPath,
  wirePath,
  wireVerdict,
  wireZ,
  type Cubic,
  type WirePress,
} from '../wireFx'

const press = (over: Partial<WirePress> = {}): WirePress => ({ x: 100, y: 100, t: 1000, pointerType: 'mouse', edgeId: 'ref:a->s', multi: false, ...over })
const up = (over: Partial<{ x: number; y: number; t: number; edgeId: string | null }> = {}) => ({ x: 100, y: 100, t: 1100, edgeId: 'ref:a->s', ...over })

describe('isWireClick: a click, not the end of a pan / drag / pinch', () => {
  it('a press and release in place on the same wire is a click', () => {
    expect(isWireClick(press(), up())).toBe(true)
    expect(isWireClick(press(), up({ x: 103, y: 102 }))).toBe(true)
  })
  it('moving more than the slop is a drag (mouse 4px, pen 8px, touch 10px)', () => {
    expect(isWireClick(press(), up({ x: 100 + CLICK_SLOP.mouse + 1 }))).toBe(false)
    expect(isWireClick(press({ pointerType: 'touch' }), up({ x: 108 }))).toBe(true)
    expect(isWireClick(press({ pointerType: 'touch' }), up({ x: 100 + CLICK_SLOP.touch + 1 }))).toBe(false)
    expect(isWireClick(press({ pointerType: 'pen' }), up({ y: 107 }))).toBe(true)
    expect(isWireClick(press({ pointerType: 'pen' }), up({ y: 110 }))).toBe(false)
    // Unknown pointer types use the mouse slop.
    expect(isWireClick(press({ pointerType: '' }), up({ x: 106 }))).toBe(false)
  })
  it('a press that started elsewhere (pane, another wire) or with two fingers is not a click', () => {
    expect(isWireClick(null, up())).toBe(false)
    expect(isWireClick(press({ edgeId: null }), up())).toBe(false)
    expect(isWireClick(press({ edgeId: 'vref:t->s' }), up())).toBe(false)
    expect(isWireClick(press(), up({ edgeId: null }))).toBe(false)
    expect(isWireClick(press({ multi: true }), up())).toBe(false)
  })
  it('a long press is not a click', () => {
    expect(isWireClick(press(), up({ t: 1000 + CLICK_MAX_MS }))).toBe(true)
    expect(isWireClick(press(), up({ t: 1000 + CLICK_MAX_MS + 1 }))).toBe(false)
    expect(isWireClick(press(), up({ t: 900 }))).toBe(false)
  })
})

describe('wireClickAction', () => {
  const base = { clickToCut: true, kind: 'ref' as const, modifier: false, onGrip: false, click: true }
  it('cuts reference, frame, @video and folder wires on a plain click', () => {
    for (const kind of ['ref', 'first', 'last', 'vref', 'save', 'autosave'] as const) expect(wireClickAction({ ...base, kind })).toBe('cut')
  })
  it('never cuts a scene → take wire', () => {
    expect(wireClickAction({ ...base, kind: 'out' })).toBe('default')
    expect(wireClickAction({ ...base, kind: null })).toBe('default')
  })
  it('pref off, Ctrl/Shift click, a reconnect grip or a drag: React Flow selects as before', () => {
    expect(wireClickAction({ ...base, clickToCut: false })).toBe('default')
    expect(wireClickAction({ ...base, modifier: true })).toBe('default')
    expect(wireClickAction({ ...base, onGrip: true })).toBe('default')
    expect(wireClickAction({ ...base, click: false })).toBe('default')
  })
})

// getBezierPath's format: "M sx,sy C c1x,c1y c2x,c2y tx,ty".
const WIRE = 'M10,20 C60,20 40,120 90,120'
const C: Cubic = [
  { x: 10, y: 20 },
  { x: 60, y: 20 },
  { x: 40, y: 120 },
  { x: 90, y: 120 },
]
const close = (a: { x: number; y: number }, b: { x: number; y: number }, eps = 0.02) => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps)
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps)
}

describe('bezier geometry of the cut', () => {
  it('parses the wires React Flow draws (decimals, negatives, spaces, exponents)', () => {
    expect(parseCubicPath(WIRE)).toEqual(C)
    expect(parseCubicPath('M-10.5,20.25 C 60,20 40,-1.2e2 90 , 120')).toEqual([
      { x: -10.5, y: 20.25 },
      { x: 60, y: 20 },
      { x: 40, y: -120 },
      { x: 90, y: 120 },
    ])
  })
  it('refuses paths that are not one absolute cubic', () => {
    expect(parseCubicPath('')).toBeNull()
    expect(parseCubicPath('M0,0 L10,10')).toBeNull()
    expect(parseCubicPath('M0,0 c1,1 2,2 3,3')).toBeNull()
    expect(parseCubicPath('M0,0 C1,1 2,2 3,3 C4,4 5,5 6,6')).toBeNull()
    expect(parseCubicPath('M0,0 C1,1 2,2')).toBeNull()
  })
  it('finds where on the wire a point is', () => {
    for (const t of [0.1, 0.33, 0.5, 0.8]) expect(Math.abs(nearestT(C, cubicAt(C, t)) - t)).toBeLessThan(0.002)
    // Off the wire: the closest point; past the ends: the ends.
    expect(nearestT(C, { x: -50, y: 20 })).toBeLessThan(0.01)
    expect(nearestT(C, { x: 200, y: 130 })).toBeGreaterThan(0.99)
  })
  it('splits into two halves that meet at the cut and keep the ends', () => {
    const [a, b] = splitCubic(C, 0.3)
    close(a[0], C[0])
    close(b[3], C[3])
    close(a[3], cubicAt(C, 0.3))
    close(b[0], a[3])
    // Same curve: points of the halves are points of the original.
    close(cubicAt(a, 0.5), cubicAt(C, 0.15))
    close(cubicAt(b, 0.5), cubicAt(C, 0.65))
  })
  it('splitWirePath: where clicked, the middle without a point, never at an end', () => {
    const at = cubicAt(C, 0.7)
    const s = splitWirePath(WIRE, { x: at.x + 3, y: at.y })
    expect(s).not.toBeNull()
    close(s!.point, cubicAt(C, nearestT(C, { x: at.x + 3, y: at.y })), 0.05)
    expect(parseCubicPath(s!.toSource)![0]).toEqual(C[0])
    expect(parseCubicPath(s!.toTarget)![3]).toEqual(C[3])
    close(splitWirePath(WIRE, null)!.point, cubicAt(C, 0.5))
    close(splitWirePath(WIRE, { x: -100, y: 0 })!.point, cubicAt(C, SPLIT_MIN_T), 0.05)
    close(splitWirePath(WIRE, { x: 500, y: 500 })!.point, cubicAt(C, 1 - SPLIT_MIN_T), 0.05)
    expect(splitWirePath('M0,0 L1,1', null)).toBeNull()
  })
  it('cubicPath writes what parseCubicPath reads (2 decimals)', () => {
    expect(parseCubicPath(cubicPath(C))).toEqual(C)
    expect(cubicPath([{ x: 1.23456, y: 0 }, C[1], C[2], C[3]])).toBe('M1.23,0 C60,20 40,120 90,120')
  })
})

describe('dragging a wire: verdict, color, snap handle', () => {
  const scene = { id: 's1', type: 'scene' }
  const scene2 = { id: 's2', type: 'scene' }
  const folder = { id: 'f1', type: 'folder' }
  const takeNode = { id: 't9', type: 'take' }
  const asset = { id: 'a2', type: 'asset' }
  it('images go to scenes only', () => {
    const src = { type: 'asset' as const, id: 'a1' }
    expect(wireVerdict(src, scene)).toBe('valid')
    expect(wireVerdict(src, folder)).toBe('invalid')
    expect(wireVerdict(src, takeNode)).toBe('invalid')
    expect(wireVerdict(src, asset)).toBe('invalid')
    expect(wireVerdict(src, null)).toBe('idle')
    expect(wireVerdict(src, { id: 'a1', type: 'asset' })).toBe('idle')
  })
  it('a finished video goes to another scene or into a folder', () => {
    const src = { type: 'take' as const, id: 't1', takeReady: true, takeSceneId: 's1' }
    expect(wireVerdict(src, scene2)).toBe('valid')
    expect(wireVerdict(src, scene)).toBe('invalid') // its own scene
    expect(wireVerdict({ ...src, takeReady: false }, scene2)).toBe('invalid')
    expect(wireVerdict(src, folder)).toBe('valid')
    expect(wireVerdict(src, takeNode)).toBe('invalid')
  })
  it('moving the scene end of an existing @video / image wire: only to another scene, never into a folder', () => {
    const vref = { type: 'take' as const, id: 't1', takeReady: true, takeSceneId: 's1', reconnect: true }
    expect(wireVerdict(vref, folder)).toBe('invalid')
    expect(wireVerdict(vref, scene2)).toBe('valid')
    expect(wireVerdict(vref, scene)).toBe('invalid')
    expect(wireVerdict(vref, takeNode)).toBe('invalid')
    expect(wireVerdict({ type: 'asset', id: 'a1', reconnect: true }, folder)).toBe('invalid')
    expect(wireVerdict({ type: 'asset', id: 'a1', reconnect: true }, scene2)).toBe('valid')
    expect(wireVerdict(vref, null)).toBe('idle')
    // the flag CanvasView sets for the connection line
    expect(isWireReconnecting()).toBe(false)
    setWireReconnecting(true)
    expect(isWireReconnecting()).toBe(true)
    setWireReconnecting(false)
  })
  it("a scene's right dot goes into folders; a folder's dot to videos and scenes", () => {
    expect(wireVerdict({ type: 'scene', id: 's1' }, folder)).toBe('valid')
    expect(wireVerdict({ type: 'scene', id: 's1' }, scene2)).toBe('invalid')
    expect(wireVerdict({ type: 'folder', id: 'f1' }, takeNode)).toBe('valid')
    expect(wireVerdict({ type: 'folder', id: 'f1' }, scene)).toBe('valid')
    expect(wireVerdict({ type: 'folder', id: 'f1' }, asset)).toBe('invalid')
    expect(wireVerdict({ type: 'folder', id: 'f1' }, { id: 'f2', type: 'folder' })).toBe('invalid')
  })
  it('colors follow the source (and the H3 frame handle it is over)', () => {
    expect(wireDragColor('asset')).toBe('var(--ref)')
    expect(wireDragColor('asset', 'first')).toBe('var(--first)')
    expect(wireDragColor('asset', 'last')).toBe('var(--last)')
    expect(wireDragColor('take')).toBe('var(--video)')
    expect(wireDragColor('scene')).toBe('var(--save)')
    expect(wireDragColor('folder')).toBe('var(--save)')
    expect(wireDragColor(undefined)).toBe('var(--ref)')
  })
  it('the end snaps to the handle the wire will be drawn to', () => {
    expect(snapHandleFor('asset', 'scene')).toEqual({ type: 'target', id: 'ref' })
    expect(snapHandleFor('take', 'scene')).toEqual({ type: 'target', id: 'ref' })
    expect(snapHandleFor('take', 'folder')).toEqual({ type: 'target', id: 'in' })
    expect(snapHandleFor('scene', 'folder')).toEqual({ type: 'target', id: 'in' })
    expect(snapHandleFor('folder', 'take')).toEqual({ type: 'source', id: 'out' })
    expect(snapHandleFor('folder', 'scene')).toEqual({ type: 'source', id: 'take' })
    expect(snapHandleFor('asset', 'folder')).toBeNull()
    expect(snapHandleFor('folder', 'asset')).toBeNull()
  })
  it('pickNodeAt: the topmost shown, measured node under the point', () => {
    const n = (id: string, x: number, y: number, w: number, h: number, extra: object = {}) => ({
      id,
      type: 'scene',
      measured: { width: w, height: h },
      internals: { positionAbsolute: { x, y }, z: 0 },
      ...extra,
    })
    const nodes = [n('a', 0, 0, 100, 100), n('b', 50, 50, 100, 100), n('c', 300, 0, 50, 50, { hidden: true }), n('d', 400, 0, 0, 0)]
    expect(pickNodeAt(nodes, { x: 10, y: 10 })?.id).toBe('a')
    expect(pickNodeAt(nodes, { x: 60, y: 60 })?.id).toBe('b') // drawn later
    expect(pickNodeAt(nodes, { x: 60, y: 60 }, 'b')?.id).toBe('a') // the source itself is skipped
    expect(pickNodeAt([n('hi', 0, 0, 100, 100, { internals: { positionAbsolute: { x: 0, y: 0 }, z: 1000 } }), n('lo', 0, 0, 100, 100)], { x: 5, y: 5 })?.id).toBe('hi')
    expect(pickNodeAt(nodes, { x: 310, y: 10 })).toBeNull() // hidden
    expect(pickNodeAt(nodes, { x: 400, y: 0 })).toBeNull() // not measured
    expect(pickNodeAt(nodes, { x: 200, y: 200 })).toBeNull()
    // Unmeasured nodes fall back to their stored size.
    expect(pickNodeAt([{ id: 'w', width: 20, height: 20, internals: { positionAbsolute: { x: 0, y: 0 } } }], { x: 5, y: 5 })?.id).toBe('w')
  })
})

describe('wires that just appeared', () => {
  it('newWireIds: the added ids, none on the first build or for a big batch', () => {
    expect(newWireIds(null, ['a', 'b'])).toEqual([])
    expect(newWireIds(new Set(['a']), ['a', 'b', 'c'])).toEqual(['b', 'c'])
    expect(newWireIds(new Set(['a', 'b']), ['a'])).toEqual([])
    const many = Array.from({ length: MAX_FRESH_WIRES + 1 }, (_, i) => `w${i}`)
    expect(newWireIds(new Set(), many)).toEqual([])
    expect(newWireIds(new Set(), many.slice(1))).toHaveLength(MAX_FRESH_WIRES)
  })
  it('a marked wire is fresh for a moment (and stays so for a second mount)', () => {
    markFreshWires(['x'], 10_000)
    expect(isFreshWire('x', 10_100)).toBe(true)
    expect(isFreshWire('x', 10_200)).toBe(true)
    expect(isFreshWire('x', 12_000)).toBe(false)
    expect(isFreshWire('y', 10_100)).toBe(false)
  })
})

describe('wires on the dots', () => {
  const dot = { x: 1840.5, y: 371 }
  const into = (sx: number, sy: number) =>
    wirePath({ sourceX: sx, sourceY: sy, sourcePosition: Position.Right, targetX: dot.x, targetY: dot.y, targetPosition: Position.Left })
  // A bundle like S08's: ten videos stacked in a column, one to the right of the scene (a backward wire), one far away.
  const sources = [...Array.from({ length: 10 }, (_, i) => ({ x: 1400, y: 40 + i * 120 })), { x: 1844, y: 900 }, { x: -600, y: -300 }]

  it('every wire into one dot ends at its center, arriving from its side (no fan-out beside the dot)', () => {
    for (const s of sources) {
      const c = parseCubicPath(into(s.x, s.y)[0])!
      expect(c[0]).toEqual({ x: s.x, y: s.y })
      expect(c[3]).toEqual(dot)
      // Horizontal tangent at both dots: the bundle merges smoothly into the dot from the left.
      expect(c[2].y).toBe(dot.y)
      expect(c[2].x).toBeLessThan(dot.x)
      expect(c[1].y).toBe(s.y)
      expect(c[1].x).toBeGreaterThan(s.x)
    }
  })

  it('the label point is on the wire', () => {
    const [d, x, y] = into(1400, 40)
    const c = parseCubicPath(d)!
    const p = cubicAt(c, nearestT(c, { x, y }))
    expect(Math.hypot(p.x - x, p.y - y)).toBeLessThan(0.5)
  })

  it('trimCubic keeps the same curve, minus the asked length at each end', () => {
    const c: Cubic = [
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 300 },
      { x: 240, y: 300 },
    ]
    const t = trimCubic(c, 7, 7)!
    expect(Math.hypot(t[0].x - c[0].x, t[0].y - c[0].y)).toBeCloseTo(7, 3)
    expect(Math.hypot(t[3].x - c[3].x, t[3].y - c[3].y)).toBeCloseTo(7, 3)
    // Points of the trimmed curve lie on the original one.
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const p = cubicAt(t, u)
      const q = cubicAt(c, nearestT(c, p))
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(0.05)
    }
    expect(trimCubic(c, 0, 0)).toEqual(c)
  })

  it('a wire shorter than both trims has no trimmed part', () => {
    const c: Cubic = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]
    expect(trimCubic(c, 7, 7)).toBeNull()
    expect(wireHitPath(cubicPath(c))).toBe(cubicPath(c))
  })

  it("the hit band stops at the dots' rims, so a click on a dot never cuts the wires under it", () => {
    for (const s of sources) {
      const hit = parseCubicPath(wireHitPath(into(s.x, s.y)[0]))!
      expect(Math.hypot(hit[3].x - dot.x, hit[3].y - dot.y)).toBeCloseTo(WIRE_HIT_TRIM, 1)
      expect(Math.hypot(hit[0].x - s.x, hit[0].y - s.y)).toBeCloseTo(WIRE_HIT_TRIM, 1)
      // It ends on the dot's left, the side the wire arrives from (level with the dot unless the wire comes back
      // from the right of the scene and turns at the last moment).
      expect(hit[3].x).toBeLessThan(dot.x)
      if (s.x < dot.x - 100) expect(Math.abs(hit[3].y - dot.y)).toBeLessThan(0.5)
    }
    expect(WIRE_HIT_TRIM).toBeGreaterThanOrEqual(6 + 1) // a 12px dot + its 1px outline
    expect(wireHitPath('M0,0 L10,10')).toBe('M0,0 L10,10')
  })

  it('wireZ: the wire in focus is stacked on top, every wire stays under the cards (z ≤ 0)', () => {
    const z = (selected: boolean, hovered: boolean, highlight: boolean) => wireZ({ selected, hovered, highlight })
    expect(z(true, false, false)).toBe(0)
    expect(z(true, true, true)).toBe(0)
    expect(z(false, true, false)).toBeLessThan(z(true, false, false))
    expect(z(false, false, true)).toBeLessThan(z(false, true, true))
    expect(z(false, false, false)).toBeLessThan(z(false, false, true))
    for (const a of [true, false]) for (const b of [true, false]) for (const c of [true, false]) expect(z(a, b, c)).toBeLessThanOrEqual(0)
  })
})

describe("refDotTones: a scene's reference dot takes the color of the wires drawn into it", () => {
  type Kind = 'ref' | 'vref' | 'first' | 'last' | 'out' | 'save' | 'autosave'
  const w = (kind: Kind, target: string, targetHandle = kind === 'ref' || kind === 'vref' ? 'ref' : 'in') => ({ kind, target, targetHandle })
  it('images only (or nothing) → no entry (teal); videos only → video; both → mixed', () => {
    const tones = refDotTones([w('ref', 'img'), w('vref', 'vid'), w('vref', 'vid'), w('ref', 'mix'), w('vref', 'mix')])
    expect(tones.has('img')).toBe(false)
    expect(tones.get('vid')).toBe('video')
    expect(tones.get('mix')).toBe('mixed')
    expect(tones.has('none')).toBe(false)
  })
  it('only wires into the reference dot count (frames, take / folder wires do not)', () => {
    const tones = refDotTones([w('vref', 's1'), w('first', 's1', 'first'), w('last', 's1', 'last'), w('ref', 's2', 'first'), w('save', 's3'), w('autosave', 's3')])
    expect(tones.get('s1')).toBe('video')
    expect(tones.size).toBe(1)
  })
  it('a reference with no wire on the canvas does not color the dot', () => {
    // The scene references an image that is not on the canvas: buildRawEdges draws no wire for it, so only @video wires arrive.
    expect(refDotTones([w('vref', 's8')]).get('s8')).toBe('video')
  })
})
