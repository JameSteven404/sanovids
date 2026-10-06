import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Asset, Scene, VideoSettings } from '../../../core/types'
import { undo, useProject } from '../../../store/project'
import { assetGraphOf, GRAPH_FIELDS, NON_GRAPH_FIELDS, sceneAssetsOf, sceneGraphOf } from '../canvasModel'

const scene: Scene = {
  id: 's1', order: 1, title: 'Cảnh', prompt: 'Rừng', note: '', refs: [], videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '720p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: 0 }, size: null,
  foreignModel: undefined, foreignSettings: undefined,
}
const asset: Asset = { id: 'a1', kind: 'character', name: 'An', tag: 'An', description: '', imageIds: ['img'], color: 'var(--ref)', position: { x: 0, y: 0 }, size: null }
const initial = useProject.getState().project
beforeEach(() => {
  useProject.setState({ project: { ...initial, scenes: [scene, { ...scene, id: 's2', order: 2 }], assets: [asset], presets: [{ ...scene.settings, id: 'p', name: 'Preset', duration: 10 }] } })
  useProject.temporal.getState().clear()
})
afterEach(() => { useProject.setState({ project: initial }); useProject.temporal.getState().clear() })
const signature = () => sceneGraphOf(useProject.getState().project.scenes)

describe('scene graph signatures', () => {
  it('classifies every Scene/settings field exactly once, including future type additions', () => {
    type Classified = typeof GRAPH_FIELDS[number] | typeof NON_GRAPH_FIELDS[number]
    type Fields = Exclude<keyof Scene, 'settings'> | `settings.${keyof VideoSettings}`
    const exhaustive: Exclude<Fields, Classified> extends never ? true : never = true
    expect(exhaustive).toBe(true)
    const fields = Object.keys(scene).flatMap((key) => key === 'settings' ? Object.keys(scene.settings).map((k) => `settings.${k}`) : [key])
    const classified = [...GRAPH_FIELDS, ...NON_GRAPH_FIELDS]
    expect(new Set(classified).size).toBe(classified.length)
    expect([...classified].sort()).toEqual(fields.sort())
  })

  it('retains identity after real prompt/title/note/settings/preset actions', () => {
    const before = signature()
    const p = useProject.getState()
    p.setScenePrompt('s1', 'Máy quay tiến vào rừng')
    expect(signature()).toBe(before)
    p.updateScene('s1', { title: 'Tên mới', note: 'Ghi chú' })
    expect(signature()).toBe(before)
    p.updateSettings(['s1'], { duration: 10, resolution: '1080p', ratio: '9:16' })
    expect(signature()).toBe(before)
    p.applyPreset('p', ['s1'])
    expect(signature()).toBe(before)
  })

  it.each([
    { id: 'other' }, { order: 3 }, { position: { x: 16, y: 32 } }, { size: { w: 300, h: 220 } },
    { refs: ['a1'] }, { videoRefs: ['t1'] }, { settings: { ...scene.settings, mode: 'transform' as const } },
    { firstFrame: 'a1' }, { lastFrame: 'a1' }, { color: 'var(--accent)' },
  ])('invalidates graph for %j', (patch) => {
    const before = sceneGraphOf([scene])
    expect(sceneGraphOf([{ ...scene, ...patch }])).not.toBe(before)
  })

  it('tracks actual move, resize, reorder and undo; arrays and unchanged value copies are cached', () => {
    const before = signature()
    useProject.getState().setPositions({ s1: { x: 200, y: 100 } })
    expect(signature()).not.toBe(before)
    undo()
    expect(signature()).toBe(before)
    useProject.getState().setNodeSizes({ s1: { w: 300, h: 220 } })
    const resized = signature()
    expect(resized).not.toBe(before)
    useProject.getState().moveScene('s1', 2)
    expect(signature()).not.toBe(resized)
    const list = useProject.getState().project.scenes
    expect(sceneGraphOf(list)).toBe(signature())
    expect(sceneGraphOf(structuredClone(list))).toBe(signature())
  })

  it('does not collide when ids/ref ids contain signature separators', () => {
    expect(sceneGraphOf([{ ...scene, refs: ['a:b', 'c'] }])).not.toBe(sceneGraphOf([{ ...scene, refs: ['a', 'b:c'] }]))
  })
})

describe('asset graph / selective scene inputs', () => {
  it('ignores asset copy changes but tracks placement, kind, color and size', () => {
    const before = assetGraphOf([asset])
    expect(assetGraphOf([{ ...asset, name: 'Tên khác', tag: 'Other', description: 'Note', imageIds: ['new'] }])).toBe(before)
    for (const patch of [{ id: 'a2' }, { position: null }, { size: { w: 200, h: 300 } }, { color: 'var(--accent)' }, { kind: 'prop' as const }]) {
      expect(assetGraphOf([{ ...asset, ...patch }])).not.toBe(before)
    }
  })

  it('includes refs, unlinked frame assets and legacy mentions while ignoring unrelated edits', () => {
    const frame = { ...asset, id: 'frame', tag: 'Frame' }
    const legacy = { ...asset, id: 'legacy', tag: 'Legacy' }
    const unused = { ...asset, id: 'unused', tag: 'Unused' }
    const s = { ...scene, refs: ['a1'], firstFrame: 'frame', prompt: '@Legacy @image_1' }
    const inputs = sceneAssetsOf([asset, frame, legacy, unused], s)
    expect(inputs).toEqual([asset, frame, legacy])
    expect(sceneAssetsOf([asset, frame, legacy, { ...unused, name: 'Đổi' }], s)).toEqual(inputs)
    expect(sceneAssetsOf([asset, { ...frame, imageIds: [] }, legacy, unused], s)).not.toEqual(inputs)
  })
})
