// The project store with seedvis switched on (core/seedvisFlag mocked on for this file): a route change is one undo
// step and never cuts references; the image cap follows the scene's route (plan §16.2).
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../core/seedvisFlag', () => ({ SEEDVIS_ENABLED: true }))

import { sceneRunBlockReason } from '../../core/runRules'
import type { Asset, Project, Scene } from '../../core/types'
import { scenePosition, setTakeHeightSource, undo, useProject } from '../project'

const asset = (id: string, images: number): Asset => ({
  id,
  kind: 'character',
  name: id,
  tag: id,
  description: '',
  imageIds: Array.from({ length: images }, (_, i) => `${id}-${i}`),
  color: '#fff',
  position: null,
})

const scene = (i: number, over: Partial<Scene> = {}): Scene => ({
  id: 's' + (i + 1),
  order: i + 1,
  title: '',
  prompt: 'x',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: scenePosition(i),
  note: '',
  ...over,
})

const project = (): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  // 6 + 4 + 2 pictures
  assets: [asset('a', 6), asset('b', 4), asset('c', 2)],
  scenes: [scene(0, { refs: ['a', 'b', 'c'], prompt: '@image_1 @image_12' }), scene(1)],
})

const st = () => useProject.getState()
const history = () => useProject.temporal.getState()
const sc = (id: string) => st().project.scenes.find((s) => s.id === id)!

beforeEach(() => {
  setTakeHeightSource(() => 0)
  st().loadProject(project())
  history().clear()
})

describe('seedvis routes in the project store', () => {
  it('picking a seedvis route is one undo step (several scenes too) and keeps every reference', () => {
    st().updateSettings(['s1', 's2'], { model: 'seedvis/seedance_2.5' })
    expect(history().pastStates.length).toBe(1)
    expect(sc('s1').settings).toEqual({ model: 'seedvis/seedance_2.5', mode: 't2v', duration: 15, resolution: 'auto', ratio: '16:9' })
    expect(sc('s2').settings.model).toBe('seedvis/seedance_2.5')
    // 12 pictures on a 10-image route: nothing is cut — the run rule names what is not sent
    expect(sc('s1').refs).toEqual(['a', 'b', 'c'])
    expect(sc('s1').prompt).toBe('@image_1 @image_12')
    expect(sceneRunBlockReason(st().project.assets, sc('s1'))).toContain('@image_12')
    st().updateSettings(['s1'], { model: 'seedvis/veo_3.1', mode: 'first' })
    expect(sc('s1').settings).toEqual({ model: 'seedvis/veo_3.1', mode: 'first', duration: 8, resolution: 'auto', ratio: '16:9' })
    undo()
    undo()
    expect(sc('s1').settings.model).toBe('seedance_2_5')
    expect(sc('s2').settings.model).toBe('seedance_2_5')
  })

  it('addRefs follows the route’s cap: 10 pictures on Seedance · seedvis, 3 on Veo 3.1', () => {
    st().updateSettings(['s2'], { model: 'seedvis/seedance_2.5' })
    expect(st().addRefs(['s2'], ['a', 'b', 'c'])).toEqual({ added: 2, skipped: 1, scenes: 1 })
    expect(sc('s2').refs).toEqual(['a', 'b'])
    st().loadProject(project())
    st().updateSettings(['s2'], { model: 'seedvis/veo_3.1', mode: 'i2v' })
    expect(st().addRefs(['s2'], ['c', 'b'])).toEqual({ added: 1, skipped: 1, scenes: 1 })
    expect(sc('s2').refs).toEqual(['c'])
  })
})
