import { beforeEach, describe, expect, it } from 'vitest'
import type { Project, Scene } from '../../core/types'
import { LAYOUT, redo, ROW_H, scenePosition, undo, useProject } from '../project'

const scene = (i: number, over: Partial<Scene> = {}): Scene => ({
  id: 's' + (i + 1),
  order: i + 1,
  title: '',
  prompt: '',
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

const project = (n = 6): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [
    { id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1', 'i2'], color: '#fff', position: null },
    { id: 'b', kind: 'character', name: 'Lumi', tag: 'Lumi', description: '', imageIds: ['i3'], color: '#fff', position: null },
    { id: 'c', kind: 'location', name: 'Cave', tag: 'Cave', description: '', imageIds: ['i4'], color: '#fff', position: null },
  ],
  scenes: Array.from({ length: n }, (_, i) => scene(i)),
})

const st = () => useProject.getState()
const history = () => useProject.temporal.getState()
const sc = (id: string) => st().project.scenes.find((s) => s.id === id)!

function overlapping(scenes: Scene[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < scenes.length; i++)
    for (let j = i + 1; j < scenes.length; j++) {
      const a = scenes[i].position
      const b = scenes[j].position
      if (Math.abs(a.x - b.x) < LAYOUT.sceneW && Math.abs(a.y - b.y) < LAYOUT.sceneH) out.push([scenes[i].id, scenes[j].id])
    }
  return out
}

beforeEach(() => {
  st().loadProject(project())
  history().clear()
})

describe('placing new scenes', () => {
  it('next scene goes below its source and pushes the following rows down', () => {
    const id = st().createNextScene('s2')
    const created = sc(id)
    expect(created.position).toEqual({ x: LAYOUT.scenesX, y: scenePosition(1).y + ROW_H })
    expect(created.order).toBe(3)
    expect(overlapping(st().project.scenes)).toEqual([])
    expect(sc('s3').position.y).toBeGreaterThan(created.position.y)
  })
  it('next scene inherits refs, video refs and settings with an empty prompt (overrides win)', () => {
    st().addRefs(['s1'], ['a'])
    st().addVideoRefs(['s1'], ['t1'])
    st().updateScene('s1', { prompt: 'x' })
    const id = st().createNextScene('s1', undefined, { prompt: 'Continue from @video_1: ' })
    expect(sc(id).refs).toEqual(['a'])
    expect(sc(id).videoRefs).toEqual(['t1'])
    expect(sc(id).prompt).toBe('Continue from @video_1: ')
  })
  it('add scene after a deletion does not land on an existing card', () => {
    st().removeScenes(['s2'])
    st().addScene()
    expect(overlapping(st().project.scenes)).toEqual([])
  })
})

describe('token renumbering', () => {
  beforeEach(() => {
    st().addRefs(['s1'], ['a', 'b', 'c']) // a=@image_1,2  b=@image_3  c=@image_4
    st().updateScene('s1', { prompt: '@image_1 @image_2 with @image_3 in @image_4' })
  })
  it('reordering refs keeps every token on its image', () => {
    st().moveRef('s1', 2, 0) // c, a, b → c=1 a=2,3 b=4
    expect(sc('s1').prompt).toBe('@image_2 @image_3 with @image_4 in @image_1')
  })
  it('removing a ref renumbers the rest and names the removed one', () => {
    st().removeRef('s1', 'a')
    expect(sc('s1').prompt).toBe('Elara Elara with @image_1 in @image_2')
    undo()
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_3 in @image_4')
  })
  it('adding an image to an asset shifts the following numbers in every scene using it', () => {
    st().updateAsset('a', { imageIds: ['i1', 'i2', 'i9'] })
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_4 in @image_5')
  })
  it('deleting an asset from the library renumbers', () => {
    st().removeAssets(['b'])
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with Lumi in @image_3')
  })
  it('can be turned off', () => {
    st().updateProjectSettings({ autoRenumber: false })
    st().moveRef('s1', 2, 0)
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_3 in @image_4')
  })
})

describe('video references', () => {
  it('respects the model limit and renumbers on removal', () => {
    const res = st().addVideoRefs(['s1'], ['t1', 't2', 't3'])
    expect(res.added).toBe(3)
    st().updateScene('s1', { prompt: '@video_1 then @video_3' })
    st().removeVideoRef('s1', 't1', 'video S01·T1')
    expect(sc('s1').videoRefs).toEqual(['t2', 't3'])
    expect(sc('s1').prompt).toBe('video S01·T1 then @video_2')
  })
  it('H3 accepts at most 3 videos and no videos in t2v', () => {
    st().updateSettings(['s2'], { model: 'minimax_h3', mode: 'i2v' })
    expect(st().addVideoRefs(['s2'], ['t1', 't2', 't3', 't4']).skipped).toBe(1)
    st().updateSettings(['s3'], { model: 'minimax_h3', mode: 't2v' })
    expect(st().addVideoRefs(['s3'], ['t1']).added).toBe(0)
  })
  it('removing a deleted take everywhere is not an undo step (undo must not bring back a dangling @video)', () => {
    st().addVideoRefs(['s1', 's2'], ['t1'])
    st().updateScene('s2', { prompt: 'from @video_1' })
    const steps = history().pastStates.length
    st().removeTakesEverywhere(['t1'], { t1: 'video S01·T1' })
    expect(sc('s1').videoRefs).toEqual([])
    expect(sc('s2').prompt).toBe('from video S01·T1')
    expect(history().pastStates.length).toBe(steps)
  })
})

describe('restoreScene', () => {
  it('is one undo step and drops dangling refs', () => {
    st().addRefs(['s1'], ['a'])
    st().restoreScene('s1', { prompt: 'old', refs: ['a', 'gone'], videoRefs: ['t1', 'dead'], settings: sc('s1').settings }, new Set(['t1']))
    expect(sc('s1').refs).toEqual(['a'])
    expect(sc('s1').videoRefs).toEqual(['t1'])
    undo()
    expect(sc('s1').prompt).toBe('')
  })
})

describe('undo history', () => {
  it('an edit right after undo gets its own step and clears redo', () => {
    st().setScenePrompt('s1', 'a')
    st().setScenePrompt('s1', 'ab')
    undo()
    st().setScenePrompt('s1', 'x')
    expect(history().futureStates.length).toBe(0)
    undo()
    expect(sc('s1').prompt).toBe('')
    redo()
    expect(sc('s1').prompt).toBe('x')
  })
})

describe('moveRefToScene', () => {
  it('keeps the original link when the target is over its image limit', () => {
    st().updateSettings(['s2'], { model: 'minimax_h3', mode: 'i2v' })
    st().addRefs(['s1'], ['a'])
    // H3 accepts 9 images: fill s2 with 9 one-image assets
    for (let i = 0; i < 9; i++) st().addAsset({ id: 'x' + i, name: 'X' + i, imageIds: ['m' + i] })
    st().addRefs(['s2'], Array.from({ length: 9 }, (_, i) => 'x' + i))
    st().moveRefToScene('a', 's1', 's2')
    expect(sc('s1').refs).toEqual(['a'])
  })
})
