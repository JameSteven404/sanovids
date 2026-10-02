import { afterEach, describe, expect, it } from 'vitest'
import type { Scene, Take } from '../../../core/types'
import { useImageMeta } from '../../../lib/imageMeta'
import { defaultTakePosition, LAYOUT, NODE_SIZE } from '../../../store/project'
import {
  ASSET_CHROME,
  ASSET_DEFAULT_W,
  ASSET_MAX_ASPECT,
  ASSET_MIN_ASPECT,
  ASSET_PAD_X,
  assetDefaultLayout,
  assetNodeHeight,
  autoTakePosition,
  avatarSlots,
  DEFAULT_AVATARS,
  DOT_TOP,
  excerptChars,
  fitMedia,
  layoutTakes,
  orphanTakePosition,
  placePopover,
  PREVIEW_MAX_H,
  PREVIEW_MAX_W,
  previewSize,
  promptLines,
  PROMPT_LINE_H,
  RESIZE_DOT_GAP,
  resizeEdgeClip,
  SCENE_CHROME,
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
      { id: 'a', anchorId: 's', orphan: false },
      { id: 'b', anchorId: 's', orphan: false },
      { id: 'c', anchorId: 's', orphan: false },
    ]
    const slots = takeSlots(items, () => LAYOUT.takeW)
    items.forEach((it, i) => expect(autoTakePosition(pos, LAYOUT.sceneW, slots.get(it.id)!)).toEqual(defaultTakePosition(pos, i)))
  })

  it('accumulates each take width so resized takes never overlap, per scene row', () => {
    const items = [
      { id: 'a', anchorId: 's1', orphan: false },
      { id: 'b', anchorId: 's1', orphan: false },
      { id: 'c', anchorId: 's1', orphan: false },
      { id: 'x', anchorId: 's2', orphan: false },
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

  it('counts orphans separately and places them leftwards by their own width', () => {
    const items = [
      { id: 'a', anchorId: 's1', orphan: false },
      { id: 'o1', anchorId: 's1', orphan: true },
      { id: 'o2', anchorId: 's1', orphan: true },
    ]
    const slots = takeSlots(items, (id) => (id === 'o1' ? 360 : LAYOUT.takeW))
    expect(slots.get('o1')).toBe(0)
    expect(slots.get('o2')).toBe(360 + LAYOUT.takeGapX)
    const anchor = { x: 420, y: 0 }
    const o1 = orphanTakePosition(anchor, 0, slots.get('o1')!, 360)
    const o2 = orphanTakePosition(anchor, 1, slots.get('o2')!, LAYOUT.takeW)
    expect(o1.x + 360).toBe(anchor.x - LAYOUT.takeOffsetX)
    expect(o2.x + LAYOUT.takeW + LAYOUT.takeGapX).toBe(o1.x)
    // Defaults keep the previous fixed-width placement.
    expect(orphanTakePosition(anchor, 1)).toEqual({ x: anchor.x - LAYOUT.takeOffsetX - 2 * LAYOUT.takeW - LAYOUT.takeGapX, y: 0 })
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

describe('scene card content', () => {
  it('shows more prompt lines when taller (at least 2)', () => {
    expect(promptLines(NODE_SIZE.scene.minH)).toBe(2)
    expect(promptLines(SCENE_CHROME + 5 * PROMPT_LINE_H)).toBe(5)
    expect(promptLines(SCENE_CHROME + 5 * PROMPT_LINE_H, true)).toBeLessThan(5)
    expect(promptLines(600)).toBeGreaterThan(promptLines(300))
  })

  it('renders enough prompt text for the lines shown', () => {
    expect(excerptChars(2, LAYOUT.sceneW)).toBe(280)
    expect(excerptChars(20, 600)).toBeGreaterThan(1500)
  })

  it('shows more avatars when wider, fewer when @video thumbs need room', () => {
    expect(avatarSlots(LAYOUT.sceneW)).toBe(DEFAULT_AVATARS)
    expect(avatarSlots(600)).toBeGreaterThan(DEFAULT_AVATARS)
    expect(avatarSlots(600, 4)).toBeLessThan(avatarSlots(600))
    expect(avatarSlots(NODE_SIZE.scene.minW, 4)).toBeGreaterThanOrEqual(2)
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

describe('asset node: whole image at its own aspect ratio', () => {
  const inner = ASSET_DEFAULT_W - ASSET_PAD_X

  it('default card: image fills the width at its aspect, card = image + name/meta rows', () => {
    const square = assetDefaultLayout(1)
    expect(square).toEqual({ w: ASSET_DEFAULT_W, h: inner + ASSET_CHROME, imgW: inner, imgH: inner })
    const portrait = assetDefaultLayout(9 / 16)
    expect(portrait.imgW).toBe(inner)
    expect(portrait.imgH).toBe(Math.round((inner * 16) / 9))
    expect(portrait.h).toBe(portrait.imgH + ASSET_CHROME)
    const landscape = assetDefaultLayout(16 / 9)
    expect(landscape.imgH).toBe(Math.round((inner * 9) / 16))
    expect(landscape.h).toBeLessThan(square.h)
    expect(portrait.h).toBeGreaterThan(square.h)
  })

  it('stays within NODE_SIZE.asset (very wide images get a letterboxed, minH-tall card)', () => {
    const l = NODE_SIZE.asset
    for (const a of [ASSET_MIN_ASPECT, 0.5, 1, 1.5, ASSET_MAX_ASPECT, 10, 0.05]) {
      const box = assetDefaultLayout(a)
      expect(box.h).toBeGreaterThanOrEqual(l.minH)
      expect(box.h).toBeLessThanOrEqual(l.maxH)
      expect(box.w).toBeGreaterThanOrEqual(l.minW)
      expect(box.w).toBeLessThanOrEqual(l.maxW)
    }
    expect(assetDefaultLayout(ASSET_MAX_ASPECT).h).toBe(l.minH)
    // A tall strip in a wide card hits maxH.
    expect(assetDefaultLayout(ASSET_MIN_ASPECT, l.maxW).h).toBe(l.maxH)
    // Width is clamped too.
    expect(assetDefaultLayout(1, 40).w).toBe(l.minW)
  })

  it('falls back to a square for an unknown / broken aspect', () => {
    expect(assetDefaultLayout(Number.NaN)).toEqual(assetDefaultLayout(1))
    expect(assetDefaultLayout(0)).toEqual(assetDefaultLayout(1))
  })

  it('a default square card still fits the asset column slots (seed, saved projects, "add to canvas")', () => {
    expect(assetDefaultLayout(1).h).toBeLessThan(LAYOUT.assetH + LAYOUT.assetGapY)
  })

  describe('assetNodeHeight (asset column layout)', () => {
    afterEach(() => useImageMeta.setState({ sizes: {} }))

    it('uses the stored size, else the default card for the known image aspect', () => {
      expect(assetNodeHeight({ size: { w: 300, h: 400 }, imageIds: ['img_a'] }, 999)).toBe(400)
      useImageMeta.setState({ sizes: { img_a: { w: 900, h: 1600 } } })
      // Known aspect wins over a stale measurement (taken while the card was still square).
      expect(assetNodeHeight({ size: null, imageIds: ['img_a'] }, 227)).toBe(assetDefaultLayout(9 / 16).h)
    })

    it('falls back to the measured card, then to a square card', () => {
      expect(assetNodeHeight({ size: null, imageIds: ['img_b'] }, 333)).toBe(333)
      expect(assetNodeHeight({ size: null, imageIds: ['img_b'] })).toBe(assetDefaultLayout(1).h)
      expect(assetNodeHeight({ size: null, imageIds: [] }, 500)).toBe(assetDefaultLayout(1).h)
    })
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
