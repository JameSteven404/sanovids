import { afterEach, describe, expect, it } from 'vitest'
import type { Scene, Take } from '../../../core/types'
import { ASSETS_MIME, TAKES_MIME } from '../../../lib/dnd'
import { defaultTakePosition, LAYOUT } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import {
  chooseTake,
  hasAssetDrag,
  hasTakeDrag,
  inlineEditKeyBubbles,
  isAutoSlot,
  isEmptyCanvasTarget,
  layoutTakes,
  orphanTakePosition,
  readAssetIds,
  readTakeIds,
  takeIndexOf,
  takeLayoutSig,
  takesUsableFor,
  takeSummary,
  videoUsageOf,
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
  posterId: `p_${id}`,
  videoId: null,
  error: null,
  position: null,
  ...over,
})

describe('chooseTake', () => {
  it('prefers the starred take, then the latest completed, then the latest', () => {
    const a = take('a', 's', 1)
    const b = take('b', 's', 2)
    const c = take('c', 's', 3, { status: 'failed' })
    expect(chooseTake([a, b, c])?.id).toBe('b')
    expect(chooseTake([{ ...a, starred: true }, b, c])?.id).toBe('a')
    expect(chooseTake([{ ...a, status: 'queued' }, c])?.id).toBe('c')
    expect(chooseTake([])).toBeUndefined()
  })
})

describe('takeIndexOf / takeSummary', () => {
  it('groups takes per scene sorted by number and is cached per array', () => {
    const takes = [take('t3', 's', 3, { status: 'processing', progress: 40 }), take('t1', 's', 1), take('t2', 's', 2, { starred: true })]
    const idx = takeIndexOf(takes)
    expect(idx.byScene.get('s')!.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    expect(idx.chosen.get('s')!.id).toBe('t2')
    expect(takeIndexOf(takes)).toBe(idx)
    const sum = takeSummary(takes, 's')
    expect(sum).toMatchObject({ count: 3, status: 'processing', progress: 40, starredNumber: 2, active: 1, posterId: 'p_t2' })
    expect(takeSummary(takes, 'nope').count).toBe(0)
  })
})

describe('takeLayoutSig', () => {
  it('ignores progress but tracks position, star and status', () => {
    const t = take('t', 's', 1, { status: 'processing', progress: 10 })
    const base = takeLayoutSig([t])
    expect(takeLayoutSig([{ ...t, progress: 60 }])).toBe(base)
    expect(takeLayoutSig([{ ...t, status: 'completed' }])).not.toBe(base)
    expect(takeLayoutSig([{ ...t, starred: true }])).not.toBe(base)
    expect(takeLayoutSig([{ ...t, position: { x: 1, y: 2 } }])).not.toBe(base)
  })
})

describe('layoutTakes', () => {
  const scenes = [scene('s1'), scene('s2', { videoRefs: ['a1'] })]
  const takes = [take('a1', 's1', 1), take('a2', 's1', 2), take('a3', 's1', 3, { status: 'failed' }), take('b1', 's2', 1), take('orphan', 'gone', 1)]

  it('all: every take of an existing scene, slot = rank by number', () => {
    const l = layoutTakes(takes, scenes, 'all')
    expect(l.items.map((i) => [i.id, i.index])).toEqual([
      ['a1', 0],
      ['a2', 1],
      ['a3', 2],
      ['b1', 0],
    ])
    expect(l.byId.has('orphan')).toBe(false)
    expect(l.items.every((i) => i.hidden === 0)).toBe(true)
  })

  it('chosen: the chosen take + takes used as @video, with the hidden count on the chosen one', () => {
    const l = layoutTakes(takes, scenes, 'chosen')
    // s1: chosen = a2 (latest completed); a1 stays because s2 uses it as @video.
    expect(l.items.map((i) => [i.id, i.index, i.hidden])).toEqual([
      ['a1', 0, 0],
      ['a2', 1, 1],
      ['b1', 0, 0],
    ])
  })

  it('keeps explicit positions', () => {
    const l = layoutTakes([take('x', 's1', 1, { position: { x: 5, y: 6 } })], scenes, 'all')
    expect(l.items[0].explicit).toEqual({ x: 5, y: 6 })
    expect(l.items[0]).toMatchObject({ orphan: false, anchorId: 's1' })
  })

  it('keeps takes of a deleted scene while a scene uses them as @video (anchored at the first user by order)', () => {
    // Array order is not scene order: s3 (order 3) comes first but s2 (order 2) is the anchor.
    const withOrphans = [
      scene('s3', { order: 3, videoRefs: ['o1'] }),
      scene('s1', { order: 1 }),
      scene('s2', { order: 2, videoRefs: ['o2', 'o1'] }),
    ]
    const list = [take('a1', 's1', 1), take('o1', 'gone', 1, { position: { x: 7, y: 8 } }), take('o2', 'gone', 2), take('o3', 'gone', 3)]
    for (const mode of ['all', 'chosen'] as const) {
      const l = layoutTakes(list, withOrphans, mode)
      expect(l.items.map((i) => [i.id, i.orphan, i.anchorId, i.index, i.hidden])).toEqual([
        ['a1', false, 's1', 0, 0],
        ['o1', true, 's2', 0, 0],
        ['o2', true, 's2', 1, 0],
      ])
      expect(l.byId.get('o1')).toMatchObject({ sceneId: 'gone', explicit: { x: 7, y: 8 } })
      expect(l.byId.has('o3')).toBe(false) // not used by any scene
    }
  })
})

describe('orphanTakePosition', () => {
  it('sits left of the scene that uses it, one slot further left per orphan', () => {
    const anchor = { x: 420, y: 308 }
    const first = orphanTakePosition(anchor, 0)
    const second = orphanTakePosition(anchor, 1)
    expect(first.y).toBe(anchor.y)
    expect(first.x + LAYOUT.takeW).toBeLessThan(anchor.x)
    expect(second.x + LAYOUT.takeW).toBeLessThanOrEqual(first.x)
  })
})

describe('isAutoSlot', () => {
  /** React Flow's snapPosition (@xyflow/system) with snapGrid [16, 16]. */
  const rfSnap = (p: { x: number; y: number }) => ({ x: 16 * Math.round(p.x / 16), y: 16 * Math.round(p.y / 16) })

  it('counts the grid point a snapped click-drag lands on as the slot, but not a real move', () => {
    // Auto slots of a grid-aligned scene (x ≡ 8 mod 16) and of auto-layout rows (x ≡ 12, y ≡ 12 / 4 mod 16).
    const scenes = [
      { x: 416, y: 64 },
      { x: 420, y: 60 },
      { x: 420, y: 308 },
      { x: -400, y: -188 },
    ]
    for (const sp of scenes) {
      for (const index of [0, 1, 2]) {
        const auto = defaultTakePosition(sp, index)
        expect(isAutoSlot(auto, auto)).toBe(true)
        // A drag that starts and ends at the node: React Flow snaps the node to the grid point nearest its start.
        expect(isAutoSlot(auto, rfSnap(auto))).toBe(true)
        // Arrow keys move one grid step (then snap); dragging a cell or more away is a real move.
        for (const d of [
          { x: 16, y: 0 },
          { x: -16, y: 0 },
          { x: 0, y: 16 },
          { x: 0, y: -16 },
          { x: 40, y: 40 },
        ]) {
          expect(isAutoSlot(auto, rfSnap({ x: auto.x + d.x, y: auto.y + d.y }))).toBe(false)
        }
      }
    }
  })
})

describe('inlineEditKeyBubbles', () => {
  const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) => ({ key: k, ctrlKey: false, metaKey: false, ...mods })
  it('lets Ctrl/Cmd shortcuts reach the global handler, keeps typing keys and Escape in the field', () => {
    expect(inlineEditKeyBubbles(key('s', { ctrlKey: true }))).toBe(true)
    expect(inlineEditKeyBubbles(key('Enter', { metaKey: true }))).toBe(true)
    expect(inlineEditKeyBubbles(key('Escape', { ctrlKey: true }))).toBe(false)
    for (const k of ['a', 'Delete', 'Backspace', 'Enter', 'Escape', 'c', 'n']) expect(inlineEditKeyBubbles(key(k))).toBe(false)
  })
})

describe('videoUsageOf', () => {
  it('counts scenes per referenced take', () => {
    const m = videoUsageOf([scene('a', { videoRefs: ['t1', 't2'] }), scene('b', { videoRefs: ['t1'] })])
    expect(m.get('t1')).toBe(2)
    expect(m.get('t2')).toBe(1)
    expect(m.get('t3')).toBeUndefined()
  })
})

/** Minimal DataTransfer stand-in (node test environment). */
const transfer = (data: Record<string, string>) => ({ types: Object.keys(data), getData: (t: string) => data[t] ?? '' }) as unknown as DataTransfer

describe('drag payloads (shared MIME types)', () => {
  it('tells take drags from asset drags and reads their ids', () => {
    const takes = transfer({ [TAKES_MIME]: JSON.stringify(['t1', 't2', 3]) })
    const assets = transfer({ [ASSETS_MIME]: JSON.stringify(['a1']) })
    expect(hasTakeDrag(takes)).toBe(true)
    expect(hasAssetDrag(takes)).toBe(false)
    expect(readTakeIds(takes)).toEqual(['t1', 't2'])
    expect(readAssetIds(takes)).toBeNull()
    expect(hasTakeDrag(assets)).toBe(false)
    expect(readAssetIds(assets)).toEqual(['a1'])
    expect(readTakeIds(assets)).toEqual([])
    expect(readTakeIds(transfer({ [TAKES_MIME]: 'not json' }))).toEqual([])
    expect(hasTakeDrag(null)).toBe(false)
  })

  it('isEmptyCanvasTarget is false without a DOM element', () => {
    expect(isEmptyCanvasTarget(null)).toBe(false)
  })
})

describe('takesUsableFor', () => {
  const initial = useRuns.getState().takes
  afterEach(() => useRuns.setState({ takes: initial }))

  it('needs a finished take from another scene', () => {
    useRuns.setState({ takes: [take('done', 's1', 1), take('busy', 's1', 2, { status: 'processing', progress: 30 })] })
    expect(takesUsableFor(['done'], 's2')).toBe(true)
    expect(takesUsableFor(['done'], 's1')).toBe(false) // own scene
    expect(takesUsableFor(['busy'], 's2')).toBe(false) // not finished
    expect(takesUsableFor(['busy', 'done'], 's2')).toBe(true)
    expect(takesUsableFor(['gone'], 's2')).toBe(false)
  })
})
