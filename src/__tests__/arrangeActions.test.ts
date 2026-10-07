import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { arrangeCanvas, autoLayoutCanvas, buildArrangeInput } from '../arrangeActions'
import { useCanvasLocal } from '../components/canvas/canvasModel'
import { LEGACY_ROWS } from '../core/arrange'
import type { Take } from '../core/types'
import { useArrangePrefs } from '../lib/arrangePrefs'
import { emptyProject, LAYOUT, redo, undo, useProject } from '../store/project'
import { useRuns } from '../store/runs'
import { useUI } from '../store/ui'

let sceneIds: string[] = []
const take = (id: string, sceneId = sceneIds[0], number = 1, extra: Partial<Take> = {}): Take => ({
  id, sceneId, number, status: 'completed', progress: 100, createdAt: number, startedAt: null, finishedAt: null,
  promptSnapshot: '', rawPromptSnapshot: '', refsSnapshot: [], videoRefsSnapshot: [], settings: useProject.getState().project.presets[0],
  cost: 1, starred: false, posterId: null, videoId: null, error: null, position: { x: 9000, y: 9000 }, ...extra,
})
const project = () => useProject.getState().project
const takePos = (id = 't') => useRuns.getState().takes.find((t) => t.id === id)?.position
const depth = () => useProject.temporal.getState().pastStates.length

beforeEach(() => {
  vi.useFakeTimers()
  useProject.setState({ project: emptyProject() })
  useRuns.setState({ takes: [] })
  useUI.setState({ selectedIds: [], takeDisplay: 'all', toasts: [] })
  useCanvasLocal.setState({ measured: {} })
  useArrangePrefs.getState().reset()
  sceneIds = Array.from({ length: 4 }, (_, i) => useProject.getState().addScene({ position: { x: i * 31, y: i * 29 } }))
  useRuns.setState({ takes: [take('t')] })
  useProject.temporal.getState().clear()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); useProject.temporal.getState().clear() })

describe('arrange command history', () => {
  it('commits one project and at most one runs update; no-op keeps object identity and adds no step', () => {
    const p = vi.fn(), r = vi.fn(), stopP = useProject.subscribe(p), stopR = useRuns.subscribe(r)
    try {
      autoLayoutCanvas()
      expect(p).toHaveBeenCalledTimes(1); expect(r).toHaveBeenCalledTimes(1); expect(depth()).toBe(1)
      const arranged = project()
      autoLayoutCanvas()
      expect(project()).toBe(arranged); expect(depth()).toBe(1)
      expect(useUI.getState().toasts.at(-1)).toMatchObject({ text: 'Canvas đã gọn sẵn.' })
      expect(useUI.getState().toasts.at(-1)?.action).toBeUndefined()
      undo(); expect(takePos()).toEqual({ x: 9000, y: 9000 })
      redo(); expect(takePos()).toBeNull()
    } finally { stopP(); stopR() }
  })
  it('two arrangements undo and redo scenes, manual takes and display independently, even in one millisecond', () => {
    const initial = project()
    arrangeCanvas({ style: 'grid', video: 'chosen', gridCols: 2 })
    const grid = project()
    useRuns.getState().setTakePositions({ t: { x: 5000, y: 6000 } })
    arrangeCanvas({ style: 'strip', video: 'chosen' })
    const strip = project()
    expect(depth()).toBe(2)
    undo(); expect(project()).toBe(grid); expect(takePos()).toEqual({ x: 5000, y: 6000 })
    // A later manual move is deliberately retained when it differs from the older record's target.
    useRuns.getState().setTakePositions({ t: null })
    undo(); expect(project()).toBe(initial); expect(takePos()).toEqual({ x: 9000, y: 9000 }); expect(useUI.getState().takeDisplay).toBe('all')
    redo(); expect(project()).toBe(grid); expect(takePos()).toBeNull(); expect(useUI.getState().takeDisplay).toBe('chosen')
    useRuns.getState().setTakePositions({ t: { x: 5000, y: 6000 } })
    redo(); expect(project()).toBe(strip); expect(takePos()).toBeNull()
  })
  it('only take/display changes still make exactly one reversible step', () => {
    autoLayoutCanvas(); useProject.temporal.getState().clear()
    useRuns.getState().setTakePositions({ t: { x: 2000, y: 3000 } })
    const res = arrangeCanvas({ video: 'chosen' })
    expect(res.positions).toEqual({}); expect(depth()).toBe(1)
    undo(); expect(takePos()).toEqual({ x: 2000, y: 3000 }); expect(useUI.getState().takeDisplay).toBe('all')
    redo(); expect(takePos()).toBeNull(); expect(useUI.getState().takeDisplay).toBe('chosen')
  })
  it('does not overwrite a later manual take move or display choice', () => {
    arrangeCanvas({ style: 'grid', video: 'chosen' })
    useRuns.getState().setTakePositions({ t: { x: 1, y: 2 } })
    useUI.getState().setTakeDisplay('all')
    undo(); expect(takePos()).toEqual({ x: 1, y: 2 }); expect(useUI.getState().takeDisplay).toBe('all')
  })
  it('a discarded branch, cleared history or another project never replays stale take records', () => {
    autoLayoutCanvas(); undo()
    useRuns.getState().setTakePositions({ t: null })
    useProject.getState().setPositions({ [sceneIds[0]]: { x: LAYOUT.scenesX, y: LAYOUT.scenesY } })
    undo(); redo(); expect(takePos()).toBeNull()
    useProject.temporal.getState().clear()
    useProject.setState({ project: { ...project(), id: 'another' } })
    useProject.getState().setPositions({ [sceneIds[0]]: { x: 1, y: 2 } })
    undo(); expect(takePos()).toBeNull()
  })
  it('legacy entry point ignores preferences and preserves chosen display while measuring hidden takes', () => {
    useArrangePrefs.getState().set({ style: 'strip', spacing: 'roomy' })
    useUI.setState({ takeDisplay: 'chosen' })
    useRuns.setState({ takes: [take('tall', sceneIds[0], 1, { size: { w: 224, h: 560 } }), take('chosen', sceneIds[0], 2)] })
    autoLayoutCanvas()
    expect(project().scenes[1].position).toEqual({ x: LAYOUT.scenesX, y: LAYOUT.scenesY + 560 + LAYOUT.gapY })
    expect(useUI.getState().takeDisplay).toBe('chosen')
  })
  it('survives non-undoable folder changes and take deletion rewriting every history snapshot', () => {
    const folderId = useProject.getState().addFolder({ name: 'Test', path: null, position: { x: -1000, y: -1000 }, takes: ['deleted'] })
    useRuns.setState({ takes: [take('t'), take('deleted', sceneIds[1])] })
    useProject.temporal.getState().clear()
    arrangeCanvas({ style: 'grid', video: 'chosen' })
    arrangeCanvas({ style: 'strip', video: 'chosen' })
    useProject.getState().setFolderPlace(folderId, { name: 'Renamed', path: null })
    useRuns.getState().removeTakes(['deleted'])
    expect(depth()).toBe(2)
    undo(); undo()
    expect(takePos()).toEqual({ x: 9000, y: 9000 })
    expect(takePos('deleted')).toBeUndefined()
    expect(project().folders?.[0].name).toBe('Renamed')
    expect(project().folders?.[0].takes ?? []).not.toContain('deleted')
    redo(); redo(); expect(takePos()).toBeNull()
  })
  it('keeps take restoration aligned when the project history reaches its 200-step limit', () => {
    for (let i = 0; i < 200; i++) useProject.getState().setPositions({ [sceneIds[0]]: { x: i, y: i } })
    arrangeCanvas({ style: 'grid', video: 'chosen' })
    expect(depth()).toBe(200)
    useProject.getState().setPositions({ [sceneIds[0]]: { x: 777, y: 888 } })
    undo(); expect(takePos()).toBeNull()
    undo(); expect(takePos()).toEqual({ x: 9000, y: 9000 })
    redo(); expect(takePos()).toBeNull()
  })
  it('selection arranges only selected scenes and their takes, ignores selected takes alone', () => {
    const initial = project()
    useUI.setState({ selectedIds: [sceneIds[1], sceneIds[2], 't'] })
    const res = arrangeCanvas({ style: 'grid', video: 'chosen', scope: 'selection' })
    expect(project().scenes[0]).toBe(initial.scenes[0]); expect(project().scenes[3]).toBe(initial.scenes[3])
    expect(takePos()).toEqual({ x: 9000, y: 9000 })
    expect(res.fitIds).not.toContain('t')
  })
  it('uses actual scene sizes and measured tall takes, excludes takes of deleted scenes', () => {
    useCanvasLocal.setState({ measured: { t: { width: 224, height: 450 } } })
    useRuns.setState({ takes: [take('t'), take('orphan', 'missing')] })
    const i = buildArrangeInput(LEGACY_ROWS)
    expect(i.clusters[0].rowH).toBe(450)
    expect(i.clusters[0].cardW).toBe(LAYOUT.sceneW)
    expect(i.takes.map((t) => t.id)).toEqual(['t'])
  })
  it('shows one overlap notice after revealing hidden takes; undo itself shows none', () => {
    arrangeCanvas({ style: 'grid', video: 'chosen' })
    useUI.setState({ toasts: [] })
    useUI.getState().setTakeDisplay('all')
    expect(useUI.getState().toasts.at(-1)?.text).toContain('Video ẩn đã hiện lại')
    useUI.getState().setTakeDisplay('chosen'); useUI.getState().setTakeDisplay('all')
    expect(useUI.getState().toasts).toHaveLength(1)
    arrangeCanvas({ style: 'strip', video: 'chosen' })
    useUI.setState({ toasts: [] }); undo()
    expect(useUI.getState().toasts).toHaveLength(0)
  })
  it('warns once when videos outgrow the reserved slot in an all-takes grid', () => {
    useRuns.setState({ takes: [] })
    arrangeCanvas({ style: 'grid', video: 'all', gridCols: 2 })
    useUI.setState({ toasts: [] })
    useRuns.setState({ takes: [take('one', sceneIds[0], 1, { position: null })] })
    expect(useUI.getState().toasts).toHaveLength(0)
    useRuns.setState({ takes: [...useRuns.getState().takes, take('two', sceneIds[0], 2, { position: null })] })
    expect(useUI.getState().toasts.at(-1)?.text).toContain('Video mới của S01 đè lên cảnh bên cạnh.')
    useRuns.setState({ takes: [...useRuns.getState().takes, take('three', sceneIds[0], 3, { position: null })] })
    expect(useUI.getState().toasts).toHaveLength(1)
  })
})
