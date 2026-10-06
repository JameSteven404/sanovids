// v0.2.5 — canvas side of "new nodes appear next to where the user works": take slots, multi-card drops, the asset
// column, and viewport moves that keep the zoom (old → new numbers from the investigation's probes).
import { beforeEach, describe, expect, it } from 'vitest'
import type { Asset, Project } from '../../../core/types'
import { LAYOUT } from '../../../store/project'
import { nextAssetPosition } from '../../sidebar/shared'
import {
  useCanvasLocal,
  assetDefaultLayout,
  autoTakePosition,
  boxOnScreen,
  fallbackNodeSize,
  focusViewport,
  gridPositions,
  revealViewport,
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
    expect(autoTakePosition(pos, LAYOUT.sceneW, slots.get('t10')!)).toEqual({ x: 900 + 280 + 64, y: 300 }) // was (3404, 300)
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
    const card = { w: 180, h: assetDefaultLayout(1).h }
    const spots = gridPositions({ x: 600, y: 400 }, Array.from({ length: 23 }, () => card))
    expect(spots[0]).toEqual({ x: 600, y: 400 })
    expect(spots[3]).toEqual({ x: 600 + 3 * 208, y: 400 })
    expect(spots[4]).toEqual({ x: 600, y: 400 + 227 + 28 })
    expect(spots[22]).toEqual({ x: 600 + 2 * 208, y: 400 + 5 * (227 + 28) }) // was (5176, 400)
    expect(Math.max(...spots.map((s) => s.x))).toBe(600 + 3 * 208)
  })
  it('a tall (portrait) card makes its row taller so the next row does not overlap it', () => {
    const spots = gridPositions({ x: 0, y: 0 }, [{ w: 180, h: 470 }, { w: 180, h: 227 }, { w: 180, h: 227 }, { w: 180, h: 227 }, { w: 180, h: 227 }])
    expect(spots[4]).toEqual({ x: 0, y: 470 + 28 })
  })
})

describe('"Đưa lên canvas": next slot of the asset column', () => {
  const asset = (id: string, x: number, y: number): Asset => ({ id, kind: 'character', name: id, tag: id, description: '', imageIds: [], color: '#fff', position: { x, y } })
  const project = (assets: Asset[]): Project => ({ id: 'p', name: 'P', schemaVersion: 2, createdAt: 0, updatedAt: 0, presets: [], settings: { autoRenumber: true }, assets, scenes: [] })
  const H = assetDefaultLayout(1).h
  beforeEach(() => useCanvasLocal.setState({ measured: {} }))
  it('[P4a] a card dragged next to a scene far below does not drag the column bottom there', () => {
    const p = project([asset('a1', 40, 60), asset('a2', 40, 60 + H + 28), asset('a3', 1200, 2000)])
    expect(nextAssetPosition(p)).toEqual({ x: 40, y: 60 + 2 * (H + 28) }) // was (40, 2255)
  })
  it('[P4b] a card moved far to the left does not move the column there', () => {
    const p = project([asset('a1', 40, 60), asset('a2', 48, 60 + H + 28), asset('a3', -900, 60)])
    expect(nextAssetPosition(p)).toEqual({ x: 40, y: 60 + 2 * (H + 28) }) // x was -900
  })
  it('the whole column moved by the user: new cards follow it', () => {
    const p = project([asset('a1', -400, 60), asset('a2', -400, 60 + H + 28)])
    expect(nextAssetPosition(p)).toEqual({ x: -400, y: 60 + 2 * (H + 28) })
  })
  it('a card a little to the side of the column (not counted in it) is stepped over, never covered', () => {
    // a4 is 96px right of the column: not a member, but a new card at x 40 (40..220) overlaps it (136..316)
    const p = project([asset('a1', 40, 60), asset('a2', 40, 315), asset('a3', 40, 570), asset('a4', 136, 825)])
    expect(nextAssetPosition(p)).toEqual({ x: 40, y: 825 + H + 28 }) // was (40, 825), on top of a4
    // the card being placed counts with its own size: a default card (825..1052) clears a4 at y 1150, a 480px tall
    // one (825..1305) would cover it → below it
    const q = project([asset('a1', 40, 60), asset('a2', 40, 315), asset('a3', 40, 570), asset('a4', 150, 1150)])
    expect(nextAssetPosition(q)).toEqual({ x: 40, y: 825 })
    expect(nextAssetPosition(q, { size: { w: 180, h: 480 }, imageIds: [] })).toEqual({ x: 40, y: 1150 + H + 28 })
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
    expect(unionBox([{ x: 420, y: 1300, ...fallbackNodeSize('scene') }])).toEqual({ x: 420, y: 1300, w: 280, h: 150 })
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
