// Quick unlink through the real stores (project + undo history, UI toasts): one undo step, the cut animation asked for
// BEFORE the store changes, prompt text kept (removed pictures become red placeholders), toast with Hoàn tác, and
// never a window.confirm.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
vi.mock('../lib/promptDrafts', async (orig) => {
  const real = await orig<typeof import('../lib/promptDrafts')>()
  return {
    ...real,
    flushScenes: (ids: Iterable<string>) => {
      calls.push(`flush:${[...ids].join(',')}`)
      real.flushScenes(ids)
    },
  }
})

import { canvasEvents, edgeId, WIRES_CUT_EVENT, type WireCutDetail } from '../actions'
import type { Asset, Project, Scene } from '../core/types'
import { hideAssets, linkedPairs, scenesUsingAsset, unlinkAllFromScene, unlinkAssetsFromScenes, unlinkSelection } from '../menuActions'
import { undo, useProject } from '../store/project'
import { useRuns } from '../store/runs'
import { useUI } from '../store/ui'

const SD = { model: 'seedance_2_5', mode: 'i2v', duration: 5, resolution: '480p', ratio: '16:9' } as const
const scene = (id: string, order: number, over: Partial<Scene> = {}): Scene => ({
  id,
  order,
  title: '',
  prompt: '',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { ...SD },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 420, y: order * 400 },
  note: '',
  ...over,
})
const asset = (id: string, name: string, over: Partial<Asset> = {}): Asset => ({
  id,
  kind: 'character',
  name,
  tag: name,
  description: '',
  imageIds: ['img_' + id],
  color: '#fff',
  position: { x: 0, y: 0 },
  ...over,
})
const project = (): Project => ({
  id: 'p1',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [asset('a', 'Elara'), asset('b', 'Bran')],
  scenes: [
    scene('s1', 1, { refs: ['a', 'b'], prompt: '@image_1 gặp @image_2 trong rừng' }),
    scene('s2', 2, { refs: ['b'], firstFrame: 'a', prompt: '@image_1 chạy' }),
    scene('s3', 3, { refs: ['a'], prompt: '@image_1 ngủ' }),
  ],
})

const st = () => useProject.getState()
const sc = (id: string) => st().project.scenes.find((s) => s.id === id)!
const steps = () => useProject.temporal.getState().pastStates.length
const lastToast = () => useUI.getState().toasts.at(-1)

const storage = new Map<string, string>()
beforeEach(() => {
  storage.clear()
  calls.length = 0
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) })
  // A menu command never asks: any question here is a bug.
  vi.stubGlobal('window', { confirm: () => { throw new Error('window.confirm must not be called by menuActions') } })
  st().loadProject(project())
  useProject.temporal.getState().clear()
  useRuns.setState({ takes: [] })
  useUI.setState({ selectedIds: [], selectedEdgeIds: [], view: 'canvas', toasts: [], dialog: { kind: 'none' } })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('linkedPairs', () => {
  it('finds references and first / last frames, only in the given scenes', () => {
    const pairs = linkedPairs(['a'], ['s1', 's2'])
    expect(pairs.refs).toEqual([{ sceneId: 's1', assetId: 'a' }])
    expect(pairs.frames).toEqual([{ sceneId: 's2', which: 'first', assetId: 'a' }])
    expect(pairs.edgeIds).toEqual([edgeId('ref', 'a', 's1'), edgeId('first', 'a', 's2')])
    expect(pairs.sceneIds).toEqual(['s1', 's2'])
    expect(scenesUsingAsset('a')).toEqual(['s1', 's2', 's3'])
    expect(linkedPairs(['zz'], ['s1']).refs).toEqual([])
  })
})

describe('unlinkAssetsFromScenes (quick unlink)', () => {
  it('cuts the image off the given scenes only, in ONE undo step, keeping the prompt text as red placeholders', () => {
    const before = steps()
    const cut = unlinkAssetsFromScenes(['a'], ['s1', 's2'])
    expect(cut).toBe(2)
    expect(steps()).toBe(before + 1)
    expect(sc('s1').refs).toEqual(['b'])
    expect(sc('s2').firstFrame).toBeNull()
    expect(sc('s2').refs).toEqual(['b'])
    expect(sc('s3').refs).toEqual(['a']) // not selected: untouched
    // No prompt text deleted: the removed picture's token became a placeholder, the words stay.
    expect(sc('s1').prompt).toContain('trong rừng')
    expect(sc('s1').prompt).toMatch(/@image_\?\d/)
    expect(sc('s1').prompt).toContain('gặp')
  })

  it('asks the canvas to animate the cut wires BEFORE the store changes, after committing the typed prompt', () => {
    const seen: { ids: string[]; refsAtEvent: string[] }[] = []
    const on = (e: Event) => seen.push({ ids: (e as CustomEvent<WireCutDetail>).detail.ids, refsAtEvent: [...sc('s1').refs] })
    canvasEvents.addEventListener(WIRES_CUT_EVENT, on)
    try {
      unlinkAssetsFromScenes(['a'], ['s1', 's2'])
    } finally {
      canvasEvents.removeEventListener(WIRES_CUT_EVENT, on)
    }
    expect(seen).toHaveLength(1)
    expect(seen[0].ids).toEqual([edgeId('ref', 'a', 's1'), edgeId('first', 'a', 's2')])
    expect(seen[0].refsAtEvent).toEqual(['a', 'b']) // store not changed yet
    expect(calls).toEqual(['flush:s1,s2'])
  })

  it('says what was cut, with Hoàn tác that brings everything back', () => {
    unlinkAssetsFromScenes(['a'], ['s1', 's2'])
    const t = lastToast()!
    expect(t.text).toMatch(/^Đã bỏ nối Elara khỏi 2 cảnh/)
    expect(t.action?.label).toBe('Hoàn tác')
    t.action!.run()
    expect(sc('s1').refs).toEqual(['a', 'b'])
    expect(sc('s2').firstFrame).toBe('a')
    expect(sc('s1').prompt).toBe('@image_1 gặp @image_2 trong rừng')
  })

  it('one scene → names it; nothing linked → no change, no toast, no undo step', () => {
    unlinkAssetsFromScenes(['a'], ['s3'])
    expect(lastToast()!.text).toMatch(/^Đã bỏ nối Elara khỏi S03/)
    const n = steps()
    const toasts = useUI.getState().toasts.length
    expect(unlinkAssetsFromScenes(['a'], ['s3'])).toBe(0)
    expect(steps()).toBe(n)
    expect(useUI.getState().toasts.length).toBe(toasts)
  })

  it('drops the cut wires from the wire selection', () => {
    useUI.setState({ selectedEdgeIds: [edgeId('ref', 'a', 's1'), edgeId('ref', 'b', 's1')] })
    unlinkAssetsFromScenes(['a'], ['s1'])
    expect(useUI.getState().selectedEdgeIds).toEqual([edgeId('ref', 'b', 's1')])
  })
})

describe('unlinkSelection / unlinkAllFromScene / hideAssets', () => {
  it('unlinkSelection cuts the selected images off the selected scenes', () => {
    useUI.setState({ selectedIds: ['a', 's1', 's3'] })
    expect(unlinkSelection()).toBe(2)
    expect(sc('s1').refs).toEqual(['b'])
    expect(sc('s3').refs).toEqual([])
    expect(sc('s2').firstFrame).toBe('a')
  })

  it('unlinkSelection without a pair says what to select', () => {
    useUI.setState({ selectedIds: ['s1'] })
    expect(unlinkSelection()).toBe(0)
    expect(lastToast()!.tone).toBe('warning')
  })

  it('unlinkAllFromScene: every image and frame of one scene, one step', () => {
    const before = steps()
    expect(unlinkAllFromScene('s2')).toBe(2)
    expect(steps()).toBe(before + 1)
    expect(sc('s2').refs).toEqual([])
    expect(sc('s2').firstFrame).toBeNull()
    expect(lastToast()!.text).toMatch(/^Đã bỏ nối 2 ảnh khỏi S02/)
    undo()
    expect(sc('s2').refs).toEqual(['b'])
    expect(sc('s2').firstFrame).toBe('a')
  })

  it('hideAssets hides the cards (links kept), one step, with Hoàn tác', () => {
    useUI.setState({ selectedIds: ['a', 's1'] })
    const before = steps()
    expect(hideAssets(['a'])).toBe(1)
    expect(steps()).toBe(before + 1)
    expect(st().project.assets.find((a) => a.id === 'a')!.position).toBeNull()
    expect(sc('s1').refs).toEqual(['a', 'b'])
    expect(useUI.getState().selectedIds).toEqual(['s1'])
    expect(lastToast()!.action?.label).toBe('Hoàn tác')
  })
})
