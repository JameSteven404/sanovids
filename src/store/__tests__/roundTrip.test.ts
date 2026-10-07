// D1 (stress invariant "a saved project reads back the same"): every store change leaves the project in the shape
// core/migrate reads back, so save → reopen gives the same project. migrate writes no `folders` key without folders;
// deleting the last folder node (removeFolders, a Delete on the canvas) used to leave `folders: []` (monkey runs:
// "Dự án đọc lại khác bản đang mở ở .folders").
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateProject } from '../../core/migrate'
import type { Project, Scene } from '../../core/types'
import { redo, undo, useProject } from '../project'

const scene = (id: string, order: number): Scene => ({
  id, order, title: '', prompt: 'a field', refs: [], videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position: { x: 464, y: 60 + order * 352 }, note: '',
})
const initial = useProject.getState().project
const st = () => useProject.getState()
/** The open project as saved (JSON) and as read back (migrateProject of that JSON). */
function savedAndReopened(): { saved: unknown; reopened: unknown } {
  const saved = JSON.parse(JSON.stringify(st().project))
  const reopened = JSON.parse(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(st().project)))))
  return { saved, reopened }
}
const expectStable = () => {
  const { saved, reopened } = savedAndReopened()
  expect(reopened).toEqual(saved)
}

beforeEach(() => {
  const p: Project = { ...initial, id: 'rt', name: 'RT', scenes: [scene('s1', 1), scene('s2', 2)], assets: [] }
  delete (p as Partial<Project>).folders
  st().loadProject(migrateProject(JSON.parse(JSON.stringify(p))))
  useProject.temporal.getState().clear()
})
afterEach(() => {
  st().loadProject(initial)
  useProject.temporal.getState().clear()
})

describe('save → reopen gives the same project after folder changes', () => {
  it('the last folder removed (removeFolders): no `folders: []` left behind', () => {
    expectStable()
    const id = st().addFolder({ name: 'Xuất', path: null, position: { x: 1200, y: 60 } })
    expectStable()
    st().removeFolders([id])
    expect('folders' in st().project).toBe(false)
    expectStable()
    // undo / redo walk through the same shapes
    undo()
    expect(st().project.folders?.map((f) => f.id)).toEqual([id])
    expectStable()
    redo()
    expect('folders' in st().project).toBe(false)
    expectStable()
  })

  it('the last folder deleted with Delete on the canvas (deleteItems), its auto-save wires with it', () => {
    const id = st().addFolder({ name: 'Xuất', path: null, position: { x: 1200, y: 60 }, autoScenes: ['s1'] })
    st().deleteItems({ folderIds: [id] })
    expect('folders' in st().project).toBe(false)
    expectStable()
  })

  it('one of two folders removed, a scene with an auto-save wire deleted: still stable', () => {
    const a = st().addFolder({ name: 'A', path: null, position: { x: 1200, y: 60 }, autoScenes: ['s1', 's2'] })
    st().addFolder({ name: 'B', path: null, position: { x: 1200, y: 400 } })
    st().removeFolders([a])
    expect(st().project.folders).toHaveLength(1)
    expectStable()
    st().addFolder({ name: 'C', path: null, position: { x: 1200, y: 800 }, autoScenes: ['s2'] })
    st().removeScenes(['s2'])
    expectStable()
  })
})
