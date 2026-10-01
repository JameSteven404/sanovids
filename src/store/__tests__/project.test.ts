import { beforeEach, describe, expect, it } from 'vitest'
import type { Project, Scene, XY } from '../../core/types'
import { LAYOUT, redo, undo, useProject } from '../project'

const step = { x: LAYOUT.sceneW + LAYOUT.gapX, y: LAYOUT.sceneH + LAYOUT.gapY }
const grid = (i: number): XY => ({
  x: LAYOUT.scenesX + (i % LAYOUT.perRow) * step.x,
  y: LAYOUT.scenesY + Math.floor(i / LAYOUT.perRow) * step.y,
})

const scene = (i: number, over: Partial<Scene> = {}): Scene => ({
  id: 's' + (i + 1), order: i + 1, title: '', prompt: '', refs: [], blockOverrides: {}, presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  continueFrom: i ? 's' + i : null, firstFrame: null, lastFrame: null, color: null, position: grid(i), note: '', ...over,
})

const project = (n = 8): Project => ({
  id: 'p', name: 'P', schemaVersion: 1, createdAt: 0, updatedAt: 0, presets: [], blocks: [],
  settings: { referencesTemplate: '{list}', autoReferences: true, autoContinuity: true },
  assets: [
    { id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1', 'i2', 'i3', 'i4', 'i5'], color: '#fff', position: null },
    { id: 'b', kind: 'character', name: 'Lumi', tag: 'Lumi', description: '', imageIds: ['i6', 'i7', 'i8', 'i9', 'i10'], color: '#fff', position: null },
  ],
  scenes: Array.from({ length: n }, (_, i) => scene(i)),
})

const st = () => useProject.getState()
const history = () => useProject.temporal.getState()

/** Pairs of scene ids whose cards overlap. */
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
  it('next scene in the middle of a row makes room instead of covering the neighbour', () => {
    const id = st().createNextScene('s2')
    const scenes = st().project.scenes
    expect(overlapping(scenes)).toEqual([])
    const pos = (sid: string) => scenes.find((s) => s.id === sid)!.position
    expect(pos(id)).toEqual(grid(2))
    expect(pos('s3')).toEqual({ x: grid(3).x, y: grid(3).y })
    expect(pos('s5').x).toBe(grid(4).x + step.x)
    expect(pos('s6')).toEqual(grid(5)) // next row untouched
    history().undo()
    expect(st().project.scenes.find((s) => s.id === 's3')!.position).toEqual(grid(2))
  })

  it('making room leaves unrelated (even overlapping) cards alone', () => {
    const copy = { x: grid(6).x + 36, y: grid(6).y + 36 } // like a duplicate of S07
    st().setPositions({ s8: copy })
    st().createNextScene('s2')
    const pos = (sid: string) => st().project.scenes.find((s) => s.id === sid)!.position
    expect(pos('s8')).toEqual(copy)
    expect(pos('s7')).toEqual(grid(6))
  })

  it('an explicit position is kept as is', () => {
    const id = st().createNextScene('s2', { x: 5, y: 5 })
    expect(st().project.scenes.find((s) => s.id === id)!.position).toEqual({ x: 5, y: 5 })
  })

  it('add scene after a deletion does not land on an existing card', () => {
    st().removeScenes(['s3'])
    const id = st().addScene()
    expect(overlapping(st().project.scenes)).toEqual([])
    expect(st().project.scenes.find((s) => s.id === id)!.position).toEqual(grid(8))
  })

  it('import after a deletion does not stack scenes on existing cards', () => {
    st().removeScenes(['s3'])
    st().applyImport({ blocks: [], scenes: [{ prompt: 'one' }, { prompt: 'two' }, { prompt: 'three' }] })
    expect(st().project.scenes).toHaveLength(10)
    expect(overlapping(st().project.scenes)).toEqual([])
  })
})

describe('restoreScene', () => {
  it('is one undo step and drops refs to deleted assets', () => {
    st().updateScene('s1', { prompt: 'current', refs: ['a'] })
    history().clear()
    st().restoreScene('s1', {
      prompt: 'old',
      refs: ['b', 'gone'],
      settings: { model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' },
    })
    let s = st().project.scenes.find((x) => x.id === 's1')!
    expect(s.prompt).toBe('old')
    expect(s.refs).toEqual(['b'])
    expect(s.settings.model).toBe('minimax_h3')
    expect(history().pastStates).toHaveLength(1)
    undo()
    s = st().project.scenes.find((x) => x.id === 's1')!
    expect(s.prompt).toBe('current')
    expect(s.refs).toEqual(['a'])
    expect(s.settings.model).toBe('seedance_2_5')
  })
})

describe('undo history', () => {
  it('an edit right after undo gets its own step and clears redo', () => {
    st().setScenePrompt('s1', 'a')
    st().setScenePrompt('s1', 'ab')
    undo()
    expect(st().project.scenes[0].prompt).toBe('')
    st().setScenePrompt('s1', 'NEW')
    expect(history().futureStates).toHaveLength(0)
    redo()
    expect(st().project.scenes[0].prompt).toBe('NEW')
    undo()
    expect(st().project.scenes[0].prompt).toBe('')
  })

  it('the temporal store undo (used directly by some toasts) also ends the typing burst', () => {
    st().setScenePrompt('s1', 'a')
    history().undo()
    st().setScenePrompt('s1', 'b')
    expect(history().pastStates).toHaveLength(1)
    expect(history().futureStates).toHaveLength(0)
  })
})

describe('moveRefToScene', () => {
  it('keeps the original link when the target is over its image limit', () => {
    const h3 = { model: 'minimax_h3' as const, mode: 'i2v' as const, duration: 5 as const, resolution: '768p' as const, ratio: '16:9' as const }
    st().loadProject({ ...project(), scenes: [scene(0, { refs: ['a'] }), scene(1, { refs: ['b'], settings: h3 })] })
    history().clear()
    st().moveRefToScene('a', 's1', 's2')
    expect(st().project.scenes.map((s) => s.refs)).toEqual([['a'], ['b']])
    expect(history().pastStates).toHaveLength(0)
  })

  it('still moves when the target has room', () => {
    st().loadProject({ ...project(), scenes: [scene(0, { refs: ['a'] }), scene(1)] })
    st().moveRefToScene('a', 's1', 's2')
    expect(st().project.scenes.map((s) => s.refs)).toEqual([[], ['a']])
  })
})
