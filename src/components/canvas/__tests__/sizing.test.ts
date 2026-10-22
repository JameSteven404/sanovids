import { afterEach, describe, expect, it } from 'vitest'
import type { Scene, Take } from '../../../core/types'
import { defaultTakePosition, LAYOUT, NEAR_SPOT_MAX, NODE_SIZE, ROW_H, rowHeightOf, setTakeHeightSource } from '../../../store/project'
import {
  ASSET_DEFAULT_W,
  ASSET_TILE,
  assetDefaultLayout,
  assetFrame,
  assetNodeHeight,
  autoTakePosition,
  DOT_TOP,
  fitMedia,
  layoutTakes,
  placePopover,
  PREVIEW_MAX_H,
  PREVIEW_MAX_W,
  previewSize,
  RESIZE_DOT_GAP,
  resizeEdgeClip,
  sceneNodeSize,
  TAKE_BAR_H,
  TAKE_CHROME,
  takeDotTop,
  takeLayoutSig,
  TAKE_POSTER_H,
  takeSlots,
  useCanvasLocal,
} from '../canvasModel'

const scene = (id: string, over: Partial<Scene> = {}): Scene => ({
  id,
  order: 1,
  title: '',
  prompt: '',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: 0 },
  note: '',
  ...over,
})

const take = (id: string, sceneId: string, number: number, over: Partial<Take> = {}): Take => ({
  id,
  sceneId,
  number,
  status: 'completed',
  progress: 100,
  createdAt: number,
  startedAt: null,
  finishedAt: null,
  promptSnapshot: '',
  rawPromptSnapshot: '',
  refsSnapshot: [],
  videoRefsSnapshot: [],
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  cost: 1,
  starred: false,
  posterId: null,
  videoId: null,
  error: null,
  position: null,
  ...over,
})

describe('takeSlots / autoTakePosition', () => {
  const pos = { x: 420, y: 60 }

  it('matches defaultTakePosition when every take has the default width', () => {
    const items = [
      { id: 'a', sceneId: 's' },
      { id: 'b', sceneId: 's' },
      { id: 'c', sceneId: 's' },
    ]
    const slots = takeSlots(items, () => LAYOUT.takeW)
    items.forEach((it, i) => expect(autoTakePosition(pos, LAYOUT.sceneW, slots.get(it.id)!)).toEqual(defaultTakePosition(pos, i)))
  })

  it('accumulates each take width so resized takes never overlap, per scene row', () => {
    const items = [
      { id: 'a', sceneId: 's1' },
      { id: 'b', sceneId: 's1' },
      { id: 'c', sceneId: 's1' },
      { id: 'x', sceneId: 's2' },
    ]
    const widths: Record<string, number> = { a: 400, b: 224, c: 300, x: 500 }
    const slots = takeSlots(items, (id) => widths[id])
    expect(slots.get('a')).toBe(0)
    expect(slots.get('b')).toBe(400 + LAYOUT.takeGapX)
    expect(slots.get('c')).toBe(400 + 224 + 2 * LAYOUT.takeGapX)
    expect(slots.get('x')).toBe(0) // another scene's row starts over
    const a = autoTakePosition(pos, LAYOUT.sceneW, slots.get('a')!)
    const b = autoTakePosition(pos, LAYOUT.sceneW, slots.get('b')!)
    expect(b.x - (a.x + widths.a)).toBe(LAYOUT.takeGapX)
  })

  it('starts right of a widened scene card', () => {
    const wide = autoTakePosition(pos, 600, 0)
    expect(wide).toEqual(defaultTakePosition(pos, 0, 600))
    expect(wide.x).toBe(pos.x + 600 + LAYOUT.takeOffsetX)
  })
})

describe('take sizes in the layout', () => {
  it('layoutTakes carries the take size and takeLayoutSig tracks it', () => {
    const t = take('t', 's', 1)
    const sized = { ...t, size: { w: 400, h: 300 } }
    expect(takeLayoutSig([sized])).not.toBe(takeLayoutSig([t]))
    const l = layoutTakes([sized, take('u', 's', 2)], [scene('s')], 'all')
    expect(l.byId.get('t')!.size).toEqual({ w: 400, h: 300 })
    expect(l.byId.get('u')!.size).toBeNull()
  })
})

describe('scene node size (0.6.0: the node is the editor, 352 × 304)', () => {
  it('defaults and resize limits of the approved design (E0 v3, 1A)', () => {
    expect(LAYOUT.sceneW).toBe(352)
    expect(LAYOUT.sceneH).toBe(304)
    expect(NODE_SIZE.scene).toEqual({ minW: 320, maxW: 720, minH: 256, maxH: 900 })
  })
  it('a size of the old 280 × 200 cards (below today’s minimum) reads as the default node', () => {
    expect(sceneNodeSize(null)).toBeNull()
    expect(sceneNodeSize(undefined)).toBeNull()
    expect(sceneNodeSize({ w: 280, h: 200 })).toBeNull()
    expect(sceneNodeSize({ w: 600, h: 200 })).toBeNull()
    expect(sceneNodeSize({ w: 300, h: 500 })).toBeNull()
    expect(sceneNodeSize({ w: 320, h: 256 })).toEqual({ w: 320, h: 256 })
    expect(sceneNodeSize({ w: 500, h: 640 })).toEqual({ w: 500, h: 640 })
  })
})

describe('take / asset media', () => {
  it('keeps the poster 16:9, limited by width or by the height above the controls', () => {
    const wide = fitMedia(402, 600, TAKE_CHROME)
    expect(wide).toEqual({ w: 400, h: 225 })
    const short = fitMedia(640, 200, TAKE_CHROME)
    expect(short.h).toBe(200 - 2 - TAKE_CHROME)
    expect(short.w / short.h).toBeCloseTo(16 / 9, 1)
    expect(fitMedia(10, 10, TAKE_CHROME)).toEqual({ w: 0, h: 0 })
  })
})

describe('take node geometry (player bar under the picture)', () => {
  afterEach(() => setTakeHeightSource(() => 0))
  it('the 30px bar is part of the chrome below the poster; the default card holds poster + chrome', () => {
    expect(TAKE_BAR_H).toBe(30)
    // footer 30 + big button 34 + its 8px padding + 2px rounding room = 74, plus the bar
    expect(TAKE_CHROME).toBe(TAKE_BAR_H + 74)
    // natural height of the default card: 1px borders + poster + chrome (≈ 228.9), within LAYOUT.takeH
    expect(LAYOUT.takeH).toBeGreaterThanOrEqual(2 + TAKE_POSTER_H + TAKE_CHROME - 2)
    expect(LAYOUT.takeH - (2 + TAKE_POSTER_H + TAKE_CHROME - 2)).toBeLessThan(2)
  })
  it('the smallest take still shows a usable picture (as tall as before the bar)', () => {
    expect(fitMedia(NODE_SIZE.take.minW, NODE_SIZE.take.minH, TAKE_CHROME).h).toBeGreaterThanOrEqual(74)
  })
  it('rows without takes keep the scene height; rows with takes grow with them', () => {
    const s = { id: 's1', size: null }
    setTakeHeightSource(() => 0)
    expect(rowHeightOf(s)).toBe(LAYOUT.sceneH)
    setTakeHeightSource(() => LAYOUT.takeH)
    expect(rowHeightOf(s)).toBe(Math.max(LAYOUT.sceneH, LAYOUT.takeH))
    // how far a pointed-at spot may move: one scene row and a gap (the 352 × 304 scene node of 0.6.0: 304 + 2 × 48)
    expect(NEAR_SPOT_MAX).toBe(LAYOUT.sceneH + 2 * LAYOUT.gapY)
    expect(NEAR_SPOT_MAX).toBe(400)
    // seed / migrate positions keep room for takes
    expect(ROW_H).toBe(Math.max(LAYOUT.sceneH, LAYOUT.takeH) + LAYOUT.gapY)
  })
  it('an old row 248px apart still leaves room for the title line above the next row (17px)', () => {
    const oldRow = 248
    expect(oldRow - (2 + TAKE_POSTER_H + TAKE_CHROME - 2)).toBeGreaterThanOrEqual(17)
  })
})

describe('connection dots', () => {
  it("a take's dots sit at the middle of its poster: default, resized and zoomed out", () => {
    // Default card: the CSS 16:9 poster inside the 1px borders.
    expect(TAKE_POSTER_H).toBeCloseTo(((LAYOUT.takeW - 2) * 9) / 16, 6)
    expect(takeDotTop(null, false)).toBe(DOT_TOP)
    expect(takeDotTop(null, true)).toBe(DOT_TOP)
    expect(DOT_TOP).toBeCloseTo(TAKE_POSTER_H / 2, 6)
    // Resized: the grown poster's middle, near or far (the far card has no controls under the poster).
    for (const box of [
      { w: 440, h: 360 },
      { w: 552, h: 312 },
      { w: 180, h: 150 },
      { w: 640, h: 560 },
    ]) {
      expect(takeDotTop(box, false)).toBe(fitMedia(box.w, box.h, TAKE_CHROME).h / 2)
      expect(takeDotTop(box, true)).toBe(fitMedia(box.w, box.h, 0).h / 2)
    }
  })

  it('resizing a take a little never makes its dots jump (one rule for default and resized takes)', () => {
    // The default size given explicitly, and a few px around it: the dots stay within a pixel of the default spot.
    for (const [w, h] of [
      [LAYOUT.takeW, LAYOUT.takeH],
      [LAYOUT.takeW + 4, LAYOUT.takeH],
      [LAYOUT.takeW, LAYOUT.takeH + 6],
      [LAYOUT.takeW - 2, LAYOUT.takeH - 2],
    ])
      expect(Math.abs(takeDotTop({ w, h }, false) - DOT_TOP)).toBeLessThanOrEqual(1.5)
  })

  it('resizeEdgeClip: no dot, no clip', () => {
    expect(resizeEdgeClip([])).toBeNull()
    expect(resizeEdgeClip([Number.NaN])).toBeNull()
  })

  it('resizeEdgeClip: a gap of ±RESIZE_DOT_GAP around each dot, the rest of the edge kept', () => {
    const a = 71 - RESIZE_DOT_GAP
    const b = 71 + RESIZE_DOT_GAP
    expect(resizeEdgeClip([71])).toBe(`polygon(0 0, 100% 0, 100% ${a}px, 0 ${a}px, 0 ${b}px, 100% ${b}px, 100% 100%, 0 100%)`)
    // Two dots far apart: two gaps, in order whatever the input order.
    const two = resizeEdgeClip([300, 63.44], 10)!
    expect(two).toBe('polygon(0 0, 100% 0, 100% 53.44px, 0 53.44px, 0 73.44px, 100% 73.44px, 100% 290px, 0 290px, 0 310px, 100% 310px, 100% 100%, 0 100%)')
  })

  it('resizeEdgeClip: close dots (H3 first / last frames) share one gap; a gap never starts above the node', () => {
    expect(resizeEdgeClip([119, 143], 12)).toBe('polygon(0 0, 100% 0, 100% 107px, 0 107px, 0 155px, 100% 155px, 100% 100%, 0 100%)')
    expect(resizeEdgeClip([5], 12)).toBe('polygon(0 0, 100% 0, 100% 0px, 0 0px, 0 17px, 100% 17px, 100% 100%, 0 100%)')
  })
})

describe('image tile: one size for every picture (choice 3L, like canvasapp)', () => {
  it('is 220 × 275 with a 204 × 240 frame for the whole picture and one caption line', () => {
    expect(ASSET_DEFAULT_W).toBe(220)
    expect(ASSET_TILE).toMatchObject({ w: 220, h: 275 })
    expect(LAYOUT.assetW).toBe(ASSET_TILE.w)
    expect(LAYOUT.assetH).toBe(ASSET_TILE.h)
    expect(assetDefaultLayout()).toEqual({ w: 220, h: 275, imgW: 204, imgH: 240 })
    expect(assetFrame()).toEqual({ w: 204, h: 240 })
    // a resized tile: the frame follows, the caption keeps its line
    expect(assetFrame(400, 500)).toEqual({ w: 400 - 2 - 14, h: 500 - 2 - 7 - 26 })
    expect(assetFrame(10, 10)).toEqual({ w: 0, h: 0 })
  })

  it('fits the column step and the resize limits', () => {
    const l = NODE_SIZE.asset
    expect(ASSET_TILE.h + LAYOUT.assetGapY).toBe(299)
    expect(ASSET_TILE.w).toBeGreaterThanOrEqual(l.minW)
    expect(ASSET_TILE.h).toBeLessThanOrEqual(l.maxH)
  })

  it('assetNodeHeight: the stored size, else the tile (the picture’s shape no longer matters)', () => {
    expect(assetNodeHeight({ size: { w: 300, h: 400 } }, 999)).toBe(400)
    expect(assetNodeHeight({ size: null }, 333)).toBe(275)
    expect(assetNodeHeight({ size: undefined })).toBe(275)
  })

  it('keeps ~200px of wire room between the image column and the scene column', () => {
    expect(LAYOUT.scenesX - (LAYOUT.assetX + LAYOUT.assetW)).toBeGreaterThanOrEqual(200)
  })
})

describe('reference image hover preview', () => {
  it('keeps the image aspect inside the max box', () => {
    expect(previewSize(1)).toEqual({ w: Math.min(PREVIEW_MAX_W, PREVIEW_MAX_H), h: Math.min(PREVIEW_MAX_W, PREVIEW_MAX_H) })
    const wide = previewSize(16 / 9)
    expect(wide.w).toBe(PREVIEW_MAX_W)
    expect(wide.w / wide.h).toBeCloseTo(16 / 9, 1)
    const tall = previewSize(9 / 16)
    expect(tall.h).toBe(PREVIEW_MAX_H)
    expect(tall.w / tall.h).toBeCloseTo(9 / 16, 1)
    expect(previewSize(Number.NaN)).toEqual(previewSize(1))
  })

  it('sits centered above the anchor, flips below near the top and stays on screen', () => {
    const anchor = { left: 500, top: 400, right: 524, bottom: 424 }
    expect(placePopover(anchor, 200, 150, 1280, 800)).toEqual({ left: 412, top: 400 - 10 - 150 })
    const nearTop = placePopover({ ...anchor, top: 60, bottom: 84 }, 200, 150, 1280, 800)
    expect(nearTop.top).toBe(84 + 10)
    const nearLeft = placePopover({ left: 2, top: 400, right: 26, bottom: 424 }, 200, 150, 1280, 800)
    expect(nearLeft.left).toBe(8)
    const nearRight = placePopover({ left: 1270, top: 400, right: 1280, bottom: 424 }, 200, 150, 1280, 800)
    expect(nearRight.left).toBe(1280 - 200 - 8)
    // Too tall for either side: pinned inside the viewport.
    const cramped = placePopover({ left: 500, top: 100, right: 524, bottom: 124 }, 200, 300, 1280, 320)
    expect(cramped.top).toBe(320 - 300 - 8)
  })
})

describe('live resize box', () => {
  afterEach(() => useCanvasLocal.setState({ resizing: {} }))

  it('merges live boxes and clears one node', () => {
    const local = useCanvasLocal.getState()
    local.setResizing({ a: { w: 300, h: 200 } })
    local.setResizing({ b: { w: 250, h: 180, x: 10, y: 20 } })
    expect(Object.keys(useCanvasLocal.getState().resizing).sort()).toEqual(['a', 'b'])
    const before = useCanvasLocal.getState()
    before.clearResizing('missing')
    expect(useCanvasLocal.getState()).toBe(before) // no-op keeps the state object
    before.clearResizing('a')
    expect(useCanvasLocal.getState().resizing).toEqual({ b: { w: 250, h: 180, x: 10, y: 20 } })
  })
})
