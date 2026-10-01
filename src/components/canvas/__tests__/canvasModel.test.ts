import { describe, expect, it } from 'vitest'
import type { Scene, Take } from '../../../core/types'
import { chooseTake, layoutTakes, takeIndexOf, takeLayoutSig, takeSummary, videoUsageOf } from '../canvasModel'

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
