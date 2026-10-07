// Scene order without the Storyboard (▲▼ / "Dời tới vị trí…" in the inspector, Alt + ↑ / ↓): codes renumber, a
// burst of moves of one scene is ONE undo step and ONE toast, a move that changes nothing is no step at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sceneCode } from '../core/compile'
import type { Project, Scene } from '../core/types'
import { MOVE_BURST_MS, moveSceneBy, moveSceneTo, moveSelectedScene } from '../sceneOrderActions'
import { sortedScenes, undo, useProject } from '../store/project'
import { useUI } from '../store/ui'

const scene = (i: number): Scene => ({
  id: 's' + (i + 1),
  order: i + 1,
  title: '',
  prompt: '',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 10, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: i * 400 },
  note: '',
})
const project = (n: number): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [],
  scenes: Array.from({ length: n }, (_, i) => scene(i)),
})

const order = () => sortedScenes(useProject.getState().project).map((s) => s.id)
const codes = () => sortedScenes(useProject.getState().project).map((s) => sceneCode(s.order))
const steps = () => useProject.temporal.getState().pastStates.length
const toasts = () => useUI.getState().toasts.map((t) => t.text)
const moveToasts = () => toasts().filter((t) => t.startsWith('Đã dời cảnh'))
let now = 1_000_000
const later = (ms: number) => {
  now += ms
  vi.setSystemTime(now)
}

beforeEach(() => {
  vi.useFakeTimers()
  now += 60_000 // far from any earlier burst
  vi.setSystemTime(now)
  useProject.getState().loadProject(project(6))
  useProject.temporal.getState().clear()
  useUI.setState({ toasts: [], selectedIds: [], dialog: { kind: 'none' } })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('moveSceneBy / moveSceneTo', () => {
  it('moves one place, renumbers the codes, one undo step that undo takes back', () => {
    expect(moveSceneBy('s3', -1)).toBe(true)
    expect(order()).toEqual(['s1', 's3', 's2', 's4', 's5', 's6'])
    expect(codes()).toEqual(['S01', 'S02', 'S03', 'S04', 'S05', 'S06'])
    expect(steps()).toBe(1)
    expect(moveToasts()).toEqual(['Đã dời cảnh: S03 → S02.'])
    undo()
    expect(order()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
  })

  it('a move that changes nothing is refused and adds no undo step', () => {
    expect(moveSceneBy('s1', -1)).toBe(false)
    expect(moveSceneBy('s6', 1)).toBe(false)
    expect(moveSceneTo('s4', 4)).toBe(false)
    expect(moveSceneBy('nope', 1)).toBe(false)
    expect(moveSceneTo('s2', Number.NaN)).toBe(false)
    expect(moveSceneBy('s2', 0)).toBe(false)
    expect(steps()).toBe(0)
    expect(toasts()).toEqual([])
  })

  it('moveSceneTo clamps the place to [1, N]', () => {
    expect(moveSceneTo('s3', 99)).toBe(true)
    expect(order().at(-1)).toBe('s3')
    later(MOVE_BURST_MS + 100)
    expect(moveSceneTo('s3', -5)).toBe(true)
    expect(order()[0]).toBe('s3')
    // Already first: clamped to the same place → nothing.
    later(MOVE_BURST_MS + 100)
    expect(moveSceneTo('s3', 0)).toBe(false)
  })

  it('a burst (same scene, < 1.5 s apart) is one step and one toast; Hoàn tác / undo takes back the whole burst', () => {
    moveSceneBy('s5', -1)
    later(400)
    moveSceneBy('s5', -1)
    later(400)
    moveSceneBy('s5', -1)
    expect(order()).toEqual(['s1', 's5', 's2', 's3', 's4', 's6'])
    expect(steps()).toBe(1)
    // The older toasts were dismissed: one toast, from where the burst started to where the scene is now.
    expect(moveToasts()).toEqual(['Đã dời cảnh: S05 → S02.'])
    useUI.getState().toasts.find((t) => t.text.startsWith('Đã dời cảnh'))!.action!.run()
    expect(order()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
    expect(steps()).toBe(0)
  })

  it('more than 1.5 s later, or another scene, starts a new step', () => {
    moveSceneBy('s5', -1)
    later(400)
    moveSceneBy('s4', -1) // s5 is now at place 4: s4 sits at place 5 → moves to 4
    expect(steps()).toBe(2)
    later(MOVE_BURST_MS + 100)
    moveSceneBy('s4', -1)
    expect(steps()).toBe(3)
    expect(moveToasts()).toHaveLength(1)
    undo()
    undo()
    undo()
    expect(order()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
  })

  it('a long burst never pushes older steps out of the 200-step history', () => {
    for (let i = 0; i < 5; i++) {
      useProject.getState().updateScene('s1', { note: 'n' + i })
      later(MOVE_BURST_MS + 100)
    }
    expect(steps()).toBe(5)
    const oldest = useProject.temporal.getState().pastStates[0]
    // Back and forth between places 2 and 1, never back to 3 (where it started: that would end the burst, see below).
    for (let i = 0; i < 300; i++) {
      moveSceneBy('s3', i > 0 && i % 2 === 0 ? 1 : -1)
      later(30)
    }
    expect(order()[0]).toBe('s3')
    expect(steps()).toBe(6)
    expect(useProject.temporal.getState().pastStates[0]).toBe(oldest)
    expect(moveToasts()).toEqual(['Đã dời cảnh: S03 → S01.'])
    undo()
    expect(order()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
  })

  it('a burst that ends where it started leaves no undo step and offers no Hoàn tác', () => {
    useProject.getState().updateScene('s1', { note: 'older edit' })
    later(MOVE_BURST_MS + 100)
    expect(steps()).toBe(1)
    useUI.getState().select(['s5'])
    moveSelectedScene(-1) // Alt + ↑: S05 → S04
    later(300)
    moveSelectedScene(1) // Alt + ↓: back to S05
    expect(order()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
    // The burst's step is gone (the older edit is still the newest step) and nothing offers to undo a no-op.
    expect(steps()).toBe(1)
    expect(moveToasts()).toEqual([])
    const shown = useUI.getState().toasts
    expect(shown.map((t) => t.text)).toEqual(['S05 đã về chỗ cũ.'])
    expect(shown[0].action).toBeUndefined()
    // Ctrl+Z takes back the older edit at once, not an invisible step.
    undo()
    expect(useProject.getState().project.scenes.find((s) => s.id === 's1')!.note).toBe('')
    expect(order()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
  })

  it('after a round trip the next move gets its own step, never merged into an older burst of the same scene', () => {
    useUI.getState().select(['s5'])
    moveSelectedScene(-1) // burst A: S05 → S04 (step 1)
    later(MOVE_BURST_MS + 100)
    moveSelectedScene(-1) // burst B: S04 → S03 (step 2)
    later(300)
    moveSelectedScene(1) // back to S04: burst B changed nothing, its step goes
    expect(steps()).toBe(1)
    later(300)
    moveSelectedScene(1) // S04 → S05, still inside the window of the dropped step: a new step all the same
    expect(order()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
    expect(steps()).toBe(2)
    // The "về chỗ cũ" toast made way for the new burst's.
    expect(toasts()).toEqual(['Đã dời cảnh: S04 → S05.'])
    undo()
    expect(order()).toEqual(['s1', 's2', 's3', 's5', 's4', 's6'])
    undo()
    expect(order()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
    expect(steps()).toBe(0)
  })
})

describe('moveSelectedScene (Alt + ↑ / ↓)', () => {
  it('moves the single selected scene', () => {
    useUI.getState().select(['s2'])
    moveSelectedScene(1)
    expect(order()).toEqual(['s1', 's3', 's2', 's4', 's5', 's6'])
    expect(useUI.getState().selectedIds).toEqual(['s2'])
  })

  it('needs exactly one selected scene (other selected items do not count)', () => {
    moveSelectedScene(1)
    useUI.getState().select(['s1', 's2'])
    moveSelectedScene(-1)
    expect(order()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
    expect(steps()).toBe(0)
    // A held key does not stack the same hint.
    expect(toasts()).toEqual(['Chọn đúng một cảnh để dời.'])
    useUI.getState().select(['asset-1', 's4'])
    moveSelectedScene(-1)
    expect(order()).toEqual(['s1', 's2', 's4', 's3', 's5', 's6'])
  })

  it('at the first / last place: a hint, no step', () => {
    useUI.getState().select(['s1'])
    moveSelectedScene(-1)
    moveSelectedScene(-1)
    useUI.getState().select(['s6'])
    moveSelectedScene(1)
    expect(steps()).toBe(0)
    expect(toasts()).toEqual(['S01 đã là cảnh đầu.', 'S06 đã là cảnh cuối.'])
  })
})
