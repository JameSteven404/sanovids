import { afterEach, describe, expect, it } from 'vitest'
import type { Scene, Take } from '../../../core/types'
import { defaultTakePosition, LAYOUT, NODE_SIZE } from '../../../store/project'
import {
  assetImageSide,
  autoTakePosition,
  avatarSlots,
  DEFAULT_AVATARS,
  excerptChars,
  fitMedia,
  layoutTakes,
  orphanTakePosition,
  promptLines,
  PROMPT_LINE_H,
  SCENE_CHROME,
  TAKE_CHROME,
  takeLayoutSig,
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

  it('asset image stays square and grows with the node', () => {
    expect(assetImageSide(300, 500)).toBe(282)
    expect(assetImageSide(400, 200)).toBeLessThan(200)
    expect(assetImageSide(400, 420)).toBeGreaterThan(assetImageSide(200, 420))
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
