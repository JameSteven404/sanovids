// Canvas bug fixes (round 4): selection mirror, auto layout rows + take-position undo, toolbar density, theming
// helpers, drop blockers, inline title save on Ctrl+S.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project, Scene, Take } from '../../../core/types'
import { LAYOUT, redo, undo, useProject } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import { useUI } from '../../../store/ui'
import {
  DROP_BLOCKERS,
  inlineEditSavesDraft,
  layoutRowHeights,
  layoutTakes,
  MINIMAP_LIFT_W,
  selectionSeed,
  toolbarDensity,
  withAlpha,
} from '../canvasModel'
import { autoLayoutCanvas } from '../CanvasToolbar'

const scene = (id: string, order: number, over: Partial<Scene> = {}): Scene => ({
  id,
  order,
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

describe('selectionSeed', () => {
  const onCanvas = (id: string) => id !== 'hidden'
  it('a replacing selection (plain click, box) keeps only ids that have a canvas node', () => {
    expect(selectionSeed(['hidden', 's1', 't1'], true, onCanvas)).toEqual(['s1', 't1'])
  })
  it('an additive one (Ctrl / Shift+click) keeps everything', () => {
    expect(selectionSeed(['hidden', 's1'], false, onCanvas)).toEqual(['hidden', 's1'])
  })
})

describe('layoutRowHeights', () => {
  it('per scene: the tallest of its card and the takes shown in its row (stored size, else measured)', () => {
    const scenes = [scene('s1', 1), scene('s2', 2, { size: { w: 280, h: 330 } }), scene('s3', 3)]
    const takes = [
      take('t1', 's1', 1, { size: { w: 224, h: 420 } }),
      take('t2', 's1', 2),
      take('t3', 's2', 1),
      take('t4', 's3', 1, { starred: true }),
      take('t5', 's3', 2, { size: { w: 224, h: 500 } }), // hidden by "Chỉ take chọn" below
    ]
    const measured: Record<string, number> = { s1: 180, t2: 210, t3: 260, s3: 150, t4: 190 }
    const all = layoutRowHeights(scenes, layoutTakes(takes, scenes, 'all'), (id) => measured[id])
    expect(all).toEqual({ s1: 420, s2: 330, s3: 500 })
    const chosen = layoutRowHeights(scenes, layoutTakes(takes, scenes, 'chosen'), (id) => measured[id])
    expect(chosen.s3).toBe(190) // t5 is hidden: it does not make the row taller
  })
  it('leaves out rows with nothing known and ignores orphans (they sit next to another scene)', () => {
    const scenes = [scene('s2', 1, { videoRefs: ['t1'] })]
    const takes = [take('t1', 'gone', 1, { size: { w: 224, h: 520 } })]
    expect(layoutRowHeights(scenes, layoutTakes(takes, scenes, 'all'), () => undefined)).toEqual({})
  })
})

describe('autoLayoutCanvas', () => {
  const project = (): Project => ({
    id: 'p-layout',
    name: 'P',
    schemaVersion: 2,
    createdAt: 0,
    updatedAt: 0,
    presets: [],
    settings: { autoRenumber: true },
    assets: [],
    scenes: [scene('s1', 1, { position: { x: 900, y: 700 } }), scene('s2', 2, { position: { x: 100, y: 40 } })],
  })
  const initialProject = useProject.getState().project
  const initialTakes = useRuns.getState().takes
  const initialMeasured = useUI.getState().measured
  beforeEach(() => {
    useProject.setState({ project: project() })
    useProject.temporal.getState().clear()
    // t1 has CSS auto height (no stored size): only React Flow's measurement knows it is 380px tall.
    useRuns.setState({ takes: [take('t1', 's1', 1, { position: { x: 1600, y: 1200 } }), take('t2', 's2', 1)] })
    useUI.setState({ measured: { t1: { width: 224, height: 380 } } })
  })
  afterEach(() => {
    useProject.setState({ project: initialProject })
    useProject.temporal.getState().clear()
    useRuns.setState({ takes: initialTakes })
    useUI.setState({ measured: initialMeasured })
  })
  const sc = (id: string) => useProject.getState().project.scenes.find((s) => s.id === id)!
  const tk = (id: string) => useRuns.getState().takes.find((t) => t.id === id)!

  it('makes a row as tall as its tallest take, so the next scene is not covered', () => {
    autoLayoutCanvas()
    expect(sc('s1').position).toEqual({ x: LAYOUT.scenesX, y: LAYOUT.scenesY })
    expect(sc('s2').position.y).toBeGreaterThanOrEqual(LAYOUT.scenesY + 380 + LAYOUT.gapY)
    expect(tk('t1').position).toBeNull() // back to its auto slot next to S01
  })

  it('undo puts hand-placed takes back (redo snaps them again); takes moved since are left alone', () => {
    autoLayoutCanvas()
    undo()
    expect(sc('s1').position).toEqual({ x: 900, y: 700 })
    expect(tk('t1').position).toEqual({ x: 1600, y: 1200 })
    redo()
    expect(tk('t1').position).toBeNull()
    // Moved by hand after the layout: an undo of the layout must not override it.
    useRuns.getState().setTakePositions({ t1: { x: 5, y: 5 } })
    undo()
    expect(tk('t1').position).toEqual({ x: 5, y: 5 })
  })
})

describe('toolbarDensity', () => {
  it('full labels on a wide canvas, compact then tight as it narrows; unmeasured = full', () => {
    expect(toolbarDensity(0)).toBe('full')
    expect(toolbarDensity(1400)).toBe('full')
    expect(toolbarDensity(1000)).toBe('full')
    expect(toolbarDensity(999)).toBe('compact')
    expect(toolbarDensity(720)).toBe('compact')
    expect(toolbarDensity(700)).toBe('tight')
    expect(MINIMAP_LIFT_W).toBeGreaterThan(1000)
  })
})

describe('inlineEditSavesDraft', () => {
  const k = (key: string, mod: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, ...mod })
  it('only Ctrl/Cmd+S (the global save) writes the title being typed', () => {
    expect(inlineEditSavesDraft(k('s', { ctrlKey: true }))).toBe(true)
    expect(inlineEditSavesDraft(k('S', { metaKey: true }))).toBe(true)
    expect(inlineEditSavesDraft(k('s'))).toBe(false)
    expect(inlineEditSavesDraft(k('c', { ctrlKey: true }))).toBe(false)
    expect(inlineEditSavesDraft(k('z', { ctrlKey: true }))).toBe(false)
    expect(inlineEditSavesDraft(k('s', { ctrlKey: true, altKey: true }))).toBe(false)
  })
})

describe('withAlpha', () => {
  it('hex colors get an alpha byte, theme tokens go through color-mix', () => {
    expect(withAlpha('#4fb6a8', 0.7)).toBe('#4fb6a8b3')
    expect(withAlpha('var(--ref)', 0.7)).toBe('color-mix(in srgb, var(--ref) 70%, transparent)')
    expect(withAlpha('#4fb6a8', 2)).toBe('#4fb6a8ff')
  })
})

describe('DROP_BLOCKERS', () => {
  it('includes the floating selection hint (a wire dropped on it must not cut / move the reference)', () => {
    const list = DROP_BLOCKERS.split(',').map((s) => s.trim())
    expect(list).toEqual(expect.arrayContaining(['.cv-toolbar', '.cv-sel-hint', '.cv-menu', '.react-flow__minimap']))
  })
})
