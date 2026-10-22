// What mounted components select on EVERY project change stays cheap while a prompt is typed (perf, 300 / 1000 scenes:
// src/perf/__tests__/typingPath.timing.test.ts): the answers derived from the scene graph or from order / title come
// back as the same object (so useShallow compares nothing and no list is rebuilt), and per-scene lookups use the one
// map built per scenes array instead of a scan each. They still change as soon as what they show changes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sceneCountsOf, usageOf } from '../components/canvas/canvasModel'
import { sceneOptionKeys } from '../components/inspector/SceneInspector'
import { sceneFieldOf } from '../components/inspector/shared'
import { tokenLabelsOf } from '../components/sidebar/AssetLibrary'
import { assetSceneCounts } from '../core/libraryDelete'
import { sceneMapOf } from '../core/sceneIndex'
import type { Asset, Project, Scene } from '../core/types'
import { useProject } from '../store/project'

const scene = (id: string, order: number, over: Partial<Scene> = {}): Scene => ({
  id, order, title: `Cảnh ${order}`, prompt: 'a field', refs: [], videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position: { x: 464, y: order * 352 }, note: '', ...over,
})
const asset = (id: string): Asset => ({ id, kind: 'character', name: id, tag: id, description: '', imageIds: ['i_' + id], color: '#fff', position: null })
const initial = useProject.getState().project
const st = () => useProject.getState()
const scenes = () => st().project.scenes

beforeEach(() => {
  const p: Project = { ...initial, id: 'sel', scenes: [scene('s1', 1, { refs: ['a', 'b'] }), scene('s2', 2, { refs: ['a'], firstFrame: 'c' }), scene('s3', 3)], assets: [asset('a'), asset('b'), asset('c')] }
  st().loadProject(p)
})
afterEach(() => st().loadProject(initial))

describe('typing in a prompt: the same answers, nothing recounted', () => {
  it('library badge counts and tile usage: the same object until a link / frame changes', () => {
    const counts = sceneCountsOf(scenes())
    const usage = usageOf(scenes())
    expect(counts).toEqual(assetSceneCounts(scenes()))
    st().setScenePrompt('s3', 'a field at dusk')
    expect(sceneCountsOf(scenes())).toBe(counts)
    expect(usageOf(scenes())).toBe(usage)
    st().addRefs(['s3'], ['b'])
    expect(sceneCountsOf(scenes())).not.toBe(counts)
    expect(sceneCountsOf(scenes())).toEqual({ a: 2, b: 2, c: 1 })
    expect(usageOf(scenes()).get('b')).toBe(2)
  })

  it("the header's scene picker keys: the same array while only prompts change, new when a title or the order does", () => {
    const keys = sceneOptionKeys(scenes())
    st().setScenePrompt('s1', 'other words')
    expect(sceneOptionKeys(scenes())).toBe(keys)
    st().updateScene('s2', { title: 'Đêm' })
    const renamed = sceneOptionKeys(scenes())
    expect(renamed).not.toBe(keys)
    expect(renamed[1]).toContain('Đêm')
    st().moveScene('s3', 1)
    expect(sceneOptionKeys(scenes())).not.toBe(renamed)
  })

  it('per-scene lookups (inspector fields, run gate, library labels) read the one map of this scenes array', () => {
    expect(sceneMapOf(scenes())).toBe(sceneMapOf(scenes()))
    expect(sceneFieldOf(scenes(), 's2', (s) => s.firstFrame)).toBe('c')
    expect(sceneFieldOf(scenes(), 'gone', (s) => s.prompt)).toBeUndefined()
    st().setScenePrompt('s2', 'new words')
    expect(sceneFieldOf(scenes(), 's2', (s) => s.prompt)).toBe('new words')
    // the @image labels of a scene: the same object while its refs and the assets stay
    const s1 = sceneMapOf(scenes()).get('s1')!
    const labels = tokenLabelsOf(st().project.assets, s1.refs)
    st().setScenePrompt('s1', '@image_1 runs')
    expect(tokenLabelsOf(st().project.assets, sceneMapOf(scenes()).get('s1')!.refs)).toBe(labels)
  })
})
