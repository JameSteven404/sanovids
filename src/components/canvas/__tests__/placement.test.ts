// v0.2.5 — canvas side of "new nodes appear next to where the user works": take slots, multi-card drops, the asset
// column, and viewport moves that keep the zoom (old → new numbers from the investigation's probes).
import { beforeEach, describe, expect, it } from 'vitest'
import type { Asset, Project } from '../../../core/types'
import { LAYOUT } from '../../../store/project'
import { nextAssetPosition } from '../../sidebar/shared'
import {
  useCanvasLocal,
  ASSET_TILE,
  autoTakePosition,
  boxOnScreen,
  columnSpots,
  fallbackNodeSize,
  focusViewport,
  gridPositions,
  imageColumnX,
  imageDropSpots,
  revealViewport,
  sceneColumnLeft,
  sceneRowImageSpots,
  snap,
  TILE_STEP,
  WIRE_GAP,
  takeSlots,
  unionBox,
  visibleFlowRect,
  type StageSize,
} from '../canvasModel'
import { readFileSync } from 'node:fs'

describe('take slots', () => {
  const pos = { x: 900, y: 300 }
  it('[P3a] videos dragged away leave the row: the 10th take lands next to its scene (was 2160px into the row)', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: 't' + (i + 1), anchorId: 's1', orphan: false, explicit: i < 9 ? { x: 5000, y: 100 * i } : null }))
    const slots = takeSlots(items, () => LAYOUT.takeW)
    expect(slots.get('t10')).toBe(0)
    expect(autoTakePosition(pos, LAYOUT.sceneW, slots.get('t10')!)).toEqual({ x: 900 + LAYOUT.sceneW + 64, y: 300 }) // was (3404, 300)
  })
  it('a take only nudged on its slot keeps it, so the next one does not slide under it', () => {
    const items = [
      { id: 'a', anchorId: 's1', orphan: false, explicit: null },
      { id: 'b', anchorId: 's1', orphan: false, explicit: { x: 1, y: 2 } },
      { id: 'c', anchorId: 's1', orphan: false, explicit: null },
    ]
    expect(takeSlots(items, () => 224, (id) => id === 'b').get('c')).toBe(480)
    // dragged away: c takes b's place, b's own slot is where it would go back (dropping it there re-attaches it)
    const free = takeSlots(items, () => 224, () => false)
    expect(free.get('b')).toBe(240)
    expect(free.get('c')).toBe(240)
  })
})

describe('several library cards dropped at once', () => {
  it('[P6a] 23 cards go in rows of 4 from the drop point (the last one was at x 5176)', () => {
    const card = { w: 180, h: 227 }
    const spots = gridPositions({ x: 600, y: 400 }, Array.from({ length: 23 }, () => card), 4, 28)
    expect(spots[0]).toEqual({ x: 600, y: 400 })
    expect(spots[3]).toEqual({ x: 600 + 3 * 208, y: 400 })
    expect(spots[4]).toEqual({ x: 600, y: 400 + 227 + 28 })
    expect(spots[22]).toEqual({ x: 600 + 2 * 208, y: 400 + 5 * (227 + 28) }) // was (5176, 400)
    expect(Math.max(...spots.map((s) => s.x))).toBe(600 + 3 * 208)
  })
  it('a tall (portrait) card makes its row taller so the next row does not overlap it', () => {
    const spots = gridPositions({ x: 0, y: 0 }, [{ w: 180, h: 470 }, { w: 180, h: 227 }, { w: 180, h: 227 }, { w: 180, h: 227 }, { w: 180, h: 227 }])
    expect(spots[4]).toEqual({ x: 0, y: 470 + LAYOUT.assetGapY })
  })
})

describe('image tiles dropped on the canvas (4A / 3L: one size, lined up)', () => {
  const S = (id: string, x: number, y: number) => ({ id, position: { x, y }, size: null })
  const scenes = [S('s1', LAYOUT.scenesX, 60), S('s2', LAYOUT.scenesX, 60 + 352), S('s3', LAYOUT.scenesX, 60 + 2 * 352)]
  const rowH = () => LAYOUT.sceneH
  const tile = (x: number, y: number) => ({ x, y, w: LAYOUT.assetW, h: LAYOUT.assetH })
  const sceneBoxes = scenes.map((s) => ({ ...s.position, w: LAYOUT.sceneW, h: LAYOUT.sceneH }))

  it('keeps ≥ 200px of wire room: the image column sits one tile + 204px left of the scene column', () => {
    expect(WIRE_GAP).toBe(204)
    expect(imageColumnX(LAYOUT.scenesX)).toBe(LAYOUT.assetX)
    // an old project's column at x 420: the tiles go to x 0, where its one-time spacing put the old tiles
    expect(imageColumnX(420)).toBe(0)
    // scenes moved far right: the column stays the default one; scenes moved far left: it follows them
    expect(imageColumnX(3000)).toBe(LAYOUT.assetX)
    expect(imageColumnX(-2000)).toBe(-2000 - 200 - LAYOUT.assetW)
    expect(sceneColumnLeft([])).toBe(LAYOUT.scenesX)
    expect(TILE_STEP).toEqual({ x: 244, y: 299 })
  })

  it('left of the scenes: one column, the first tile at the top of the scene row under the pointer', () => {
    const spots = imageDropSpots({ x: 200, y: 60 + 352 + 100 }, 3, scenes, sceneBoxes, rowH)
    expect(spots).toEqual([0, 1, 2].map((i) => ({ x: LAYOUT.assetX, y: 60 + 352 + i * TILE_STEP.y })))
  })

  it('…stepping down past tiles already there; no row under the pointer: centred on it', () => {
    const taken = [...sceneBoxes, tile(LAYOUT.assetX, 412), tile(LAYOUT.assetX, 412 + 299)]
    expect(imageDropSpots({ x: 100, y: 450 }, 1, scenes, taken, rowH)).toEqual([{ x: LAYOUT.assetX, y: 412 + 2 * 299 }])
    expect(imageDropSpots({ x: 100, y: 5000 }, 1, scenes, sceneBoxes, rowH)).toEqual([{ x: LAYOUT.assetX, y: snap(5000 - LAYOUT.assetH / 2) }])
  })

  it('left of scenes moved far right, but nowhere near the image column: the grid at the pointer, not a column 2000px away', () => {
    const far = [S('f1', 3000, 60)]
    expect(imageDropSpots({ x: 2500, y: 100 }, 1, far, [], rowH)).toEqual([{ x: snap(2500 - 110), y: snap(100 - 137.5) }])
  })

  it('elsewhere: a 2-column grid from the pointer (centre of the first tile), the whole block slid off a node', () => {
    const p = { x: 2000, y: 1000 }
    const spots = imageDropSpots(p, 3, scenes, sceneBoxes, rowH)
    const o = { x: snap(2000 - 110), y: snap(1000 - 137.5) }
    expect(spots).toEqual([o, { x: o.x + 244, y: o.y }, { x: o.x, y: o.y + 299 }])
    // dropped onto a scene's area (not on the node itself, which handles its own drop): the block moves off it
    const onScene = imageDropSpots({ x: LAYOUT.scenesX + 200, y: 200 }, 2, scenes, sceneBoxes, rowH)
    for (const t of onScene) for (const b of sceneBoxes) expect(t.x < b.x + b.w && b.x < t.x + LAYOUT.assetW && t.y < b.y + b.h && b.y < t.y + LAYOUT.assetH).toBe(false)
  })

  it('files dropped ON a scene node: tiles in the image column from that scene row', () => {
    expect(sceneRowImageSpots(scenes[2], 2, scenes, sceneBoxes)).toEqual([
      { x: LAYOUT.assetX, y: 60 + 2 * 352 },
      { x: LAYOUT.assetX, y: 60 + 2 * 352 + 299 },
    ])
    expect(columnSpots(0, 0, 0, [])).toEqual([])
  })
})

describe('"Đưa lên canvas": next slot of the asset column', () => {
  const asset = (id: string, x: number, y: number): Asset => ({ id, kind: 'character', name: id, tag: id, description: '', imageIds: [], color: '#fff', position: { x, y } })
  const project = (assets: Asset[]): Project => ({ id: 'p', name: 'P', schemaVersion: 2, createdAt: 0, updatedAt: 0, presets: [], settings: { autoRenumber: true }, assets, scenes: [] })
  // 0.6.0: every default tile is 220 × 275 (canvasModel ASSET_TILE), the column steps 275 + 24.
  const H = ASSET_TILE.h
  const G = LAYOUT.assetGapY
  beforeEach(() => useCanvasLocal.setState({ measured: {} }))
  it('[P4a] a card dragged next to a scene far below does not drag the column bottom there', () => {
    const p = project([asset('a1', 40, 60), asset('a2', 40, 60 + H + G), asset('a3', 1200, 2000)])
    expect(nextAssetPosition(p)).toEqual({ x: 40, y: 60 + 2 * (H + G) }) // was (40, 2255)
  })
  it('[P4b] a card moved far to the left does not move the column there', () => {
    const p = project([asset('a1', 40, 60), asset('a2', 48, 60 + H + G), asset('a3', -900, 60)])
    expect(nextAssetPosition(p)).toEqual({ x: 40, y: 60 + 2 * (H + G) }) // x was -900
  })
  it('the whole column moved by the user: new cards follow it', () => {
    const p = project([asset('a1', -400, 60), asset('a2', -400, 60 + H + G)])
    expect(nextAssetPosition(p)).toEqual({ x: -400, y: 60 + 2 * (H + G) })
  })
  it('a card a little to the side of the column (not counted in it) is stepped over, never covered', () => {
    // a4 is 116px right of the column: not a member (≥ half a tile), but a new tile at x 40 (40..260) overlaps it (156..376)
    const step = H + G
    const p = project([asset('a1', 40, 60), asset('a2', 40, 60 + step), asset('a3', 40, 60 + 2 * step), asset('a4', 156, 60 + 3 * step)])
    expect(nextAssetPosition(p)).toEqual({ x: 40, y: 60 + 3 * step + H + G }) // never on top of a4
    // the card being placed counts with its own size: a default tile clears a4 further down, a 480px tall one would
    // cover it → below it
    const q = project([asset('a1', 40, 60), asset('a2', 40, 60 + step), asset('a3', 40, 60 + 2 * step), asset('a4', 170, 1450)])
    expect(nextAssetPosition(q)).toEqual({ x: 40, y: 60 + 3 * step })
    expect(nextAssetPosition(q, { size: { w: 180, h: 480 }, imageIds: [] })).toEqual({ x: 40, y: 1450 + H + G })
  })
})

describe('viewport moves', () => {
  const stage: StageSize = { w: 1000, h: 700, bottom: 92 }
  it('[P5a] a new node off-screen: pan only, the zoom stays (was zoomed 0.4 → 0.8, everything flew away)', () => {
    const box = { x: 420, y: 2000, w: 280, h: 210 }
    const vp = { x: 0, y: 0, zoom: 0.4 }
    const next = revealViewport(box, vp, stage)!
    expect(next).toEqual({ x: 0, y: -300, zoom: 0.4 })
    expect(boxOnScreen(box, next, stage)).toBe(true)
  })
  it('a new node already on screen: no move at all', () => {
    expect(revealViewport({ x: 100, y: 100, w: 280, h: 150 }, { x: 0, y: 0, zoom: 1 }, stage)).toBeNull()
  })
  it('the band covered by the toolbar / queue drawer does not count as on screen', () => {
    // bottom edge at 650 > 700 − 92: under the toolbar → panned up just enough (24px margin above the band)
    expect(revealViewport({ x: 100, y: 500, w: 280, h: 150 }, { x: 0, y: 0, zoom: 1 }, stage)).toEqual({ x: 0, y: -66, zoom: 1 })
  })
  it('zooms out only when the node cannot fit at the current zoom', () => {
    const next = revealViewport({ x: 0, y: 0, w: 3000, h: 200 }, { x: 500, y: 0, zoom: 1 }, stage)!
    expect(next.zoom).toBeCloseTo(936 / 3000)
    expect(boxOnScreen({ x: 0, y: 0, w: 3000, h: 200 }, next, stage)).toBe(true)
  })
  it('"Đi tới" (navigation) still centres the node at a readable zoom', () => {
    expect(focusViewport({ x: 420, y: 2000, w: 280, h: 200 }, { x: 0, y: 0, zoom: 0.4 }, stage)).toEqual({ x: 52, y: -1356, zoom: 0.8 })
  })
  it('[P5b] a node React Flow has not measured yet still has a real box (never the canvas origin)', () => {
    for (const type of ['scene', 'take', 'asset', undefined]) {
      const s = fallbackNodeSize(type)
      expect(s.w).toBeGreaterThan(0)
      expect(s.h).toBeGreaterThan(0)
    }
    expect(unionBox([{ x: 420, y: 1300, ...fallbackNodeSize('scene') }])).toEqual({ x: 420, y: 1300, w: LAYOUT.sceneW, h: LAYOUT.sceneH })
    expect(unionBox([])).toBeNull()
  })
  it('visible area in flow coordinates (for placing new scenes)', () => {
    expect(visibleFlowRect({ x: -200, y: 100, zoom: 0.5 }, stage)).toEqual({ x: 400, y: -200, w: 2000, h: 1216 })
  })
})

describe('toasts', () => {
  // (vitest does not load CSS, so the file is read as text)
  const toastCss = readFileSync(new URL('../../common/common.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const block = (sel: string) => new RegExp(`(^|\\n)${sel.replace('.', '\\.')} \\{([^}]*)\\}`).exec(toastCss)?.[2] ?? ''
  it('sit at the top center just below the top bar (no longer over the canvas toolbar at the bottom)', () => {
    const toasts = block('.toasts')
    expect(toasts).toMatch(/top: calc\(var\(--topbar-h\) \+ \d+px\)/)
    expect(toasts).not.toMatch(/bottom:/)
    expect(toasts).toMatch(/left: 50%/)
    expect(toasts).toMatch(/flex-direction: column-reverse/) // newest closest to the top bar
  })
  it('slide down when they appear; no animation with reduced motion', () => {
    expect(toastCss).toMatch(/@keyframes cm-toast-in \{\s*from \{\s*opacity: 0;\s*transform: translateY\(-8px\)/)
    expect(toastCss).toMatch(/prefers-reduced-motion: reduce\) \{[^}]*\.toast,[^}]*animation: none/)
  })
})
