import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { compatFixtures, jsonCopy } from '../../core/__tests__/fixtures/compat'
import { compileScene, imageKey, imageSlots } from '../../core/compile'
import { migrateProject, migrateTake } from '../../core/migrate'
import type { Project, Take } from '../../core/types'

// Same transaction-shaped double as persistProgress.test.ts; all storage is process-local.
const db = vi.hoisted(() => {
  vi.stubGlobal('BroadcastChannel', undefined)
  return { values: new Map<string, unknown>(), media: new Map<string, Blob>(), writes: [] as string[] }
})
vi.mock('idb-keyval', () => ({
  get: async (key: string) => structuredClone(db.values.get(key)),
  set: async (key: string, value: unknown) => { db.values.set(key, structuredClone(value)) },
  update: async (key: string, fn: (v: unknown) => unknown) => { db.values.set(key, structuredClone(fn(db.values.get(key)))) },
  createStore: () => (_mode: string, callback: (store: unknown) => unknown) => {
    let pending = 0
    const writes: [string, unknown][] = []
    const transaction = { oncomplete: () => {}, onerror: () => {}, onabort: () => {}, error: null }
    const store = {
      transaction,
      get(key: string) {
        pending++
        const request = { result: structuredClone(db.values.get(key)), onsuccess: () => {} }
        queueMicrotask(() => {
          request.onsuccess()
          if (--pending === 0) queueMicrotask(() => {
            for (const [k, value] of writes) { db.values.set(k, value); db.writes.push(k) }
            transaction.oncomplete()
          })
        })
        return request
      },
      put(value: unknown, key: string) { writes.push([key, structuredClone(value)]) },
    }
    return callback(store)
  },
}))
// Keep real loadRuns/migrateTake and position/history logic; prevent queue ownership and provider activity.
vi.mock('../runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runs')>()
  actual.setEngineHooks({ mayRun: () => false })
  return { ...actual, setEngineHooks: (hooks: Parameters<typeof actual.setEngineHooks>[0]) => actual.setEngineHooks({ ...hooks, mayRun: () => false }) }
})
vi.mock('../../lib/imageStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/imageStore')>()
  return { ...actual, putBlob: async (blob: Blob) => {
    const id = `imported-image-${db.media.size + 1}`
    db.media.set(id, blob)
    return id
  } }
})

import { maybeSpaceRows, planRowSpacing, showsOldLayout } from '../../components/canvas/rowSpacing'
import { bootstrap, flush, importedProject, importProjectFile, projectForExport, switchProject } from '../persist'
import { clearHistory, LAYOUT, redo, ROW_H, undo, useProject } from '../project'
import { stopEngine, useRuns } from '../runs'

const storage = new Map<string, string>()
const savedRuns = () => {
  const { takes, credits, spent } = useRuns.getState()
  return { takes, credits, spent }
}
const meta = (p: { id: string; name: string; updatedAt: number; scenes: unknown[] }) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, scenes: p.scenes.length })

beforeAll(async () => {
  vi.useFakeTimers()
  // Any accidental network attempt fails the test; nothing is dispatched.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in compatibility tests') }))
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => storage.delete(k),
    key: (i: number) => [...storage.keys()][i] ?? null, get length() { return storage.size } })
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  vi.stubGlobal('document', { addEventListener: vi.fn() })
  vi.stubGlobal('navigator', {})
  const v1 = compatFixtures[0].autosave
  storage.set('bdp:projects', JSON.stringify([meta(v1.project)]))
  storage.set(`bdp:project:${v1.project.id}`, JSON.stringify(v1.project))
  storage.set(`bdp:runs:${v1.project.id}`, JSON.stringify(v1.runs))
  storage.set('bdp:active', v1.project.id)
  await bootstrap()
  for (const fixture of compatFixtures.slice(1)) {
    db.values.set(`project:${fixture.autosave.project.id}`, jsonCopy(fixture.autosave.project))
    db.values.set(`runs:${fixture.autosave.project.id}`, jsonCopy(fixture.autosave.runs))
  }
})
afterAll(() => {
  expect(fetch).not.toHaveBeenCalled()
  stopEngine()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('bootstraps actual v1 localStorage keys into IndexedDB without losing runs or credits', () => {
  const { project, runs } = compatFixtures[0].autosave
  expect(useProject.getState().project).toEqual(migrateProject(project))
  expect(savedRuns()).toEqual({ ...runs, takes: runs.takes.map(migrateTake) })
  expect(db.values.get(`project:${project.id}`)).toEqual(migrateProject(project))
  expect(db.values.get(`runs:${project.id}`)).toEqual(runs)
  expect(storage.has('bdp:projects')).toBe(false)
  expect(storage.has(`bdp:project:${project.id}`)).toBe(false)
  expect(storage.has(`bdp:runs:${project.id}`)).toBe(false)
})

describe.each(compatFixtures)('$source.version persistence', (fixture) => {
  it('opens, flushes both stores and reopens identically with all statuses and original folder paths', async () => {
    const { project: raw, runs } = fixture.autosave
    await switchProject(raw.id)
    const expected = migrateProject(raw)
    const expectedRuns = { ...runs, takes: runs.takes.map(migrateTake) }
    expect(useProject.getState().project).toEqual(expected)
    expect(savedRuns()).toEqual(expectedRuns)
    const writes = db.writes.length
    useProject.setState({ project: jsonCopy(expected) })
    useRuns.setState(jsonCopy(expectedRuns))
    expect(await flush()).toBe(true)
    expect(db.writes.slice(writes)).toEqual(expect.arrayContaining([`project:${raw.id}`, `runs:${raw.id}`]))
    expect(db.values.get(`project:${raw.id}`)).toEqual(expected)
    expect(db.values.get(`runs:${raw.id}`)).toEqual(expectedRuns)
    const other = compatFixtures.find((f) => f.autosave.project.id !== raw.id)!
    await switchProject(other.autosave.project.id)
    await switchProject(raw.id)
    expect(useProject.getState().project).toEqual(expected)
    expect(savedRuns()).toEqual(expectedRuns)
    expect(useProject.getState().project.scenes.map((s) => s.prompt)).toEqual(fixture.expected.prompts)
    const after = db.writes.length
    expect(await flush()).toBe(true)
    expect(db.writes).toHaveLength(after)
  })

  it('imports the historical export envelope, preserves embedded image bytes and round-trips the portable project', async () => {
    const file = jsonCopy(fixture.file)
    const before = JSON.stringify(file)
    const mediaStart = db.media.size
    await importProjectFile(new File([before], 'old.sanovids.json', { type: 'application/json' }))
    const project = useProject.getState().project
    expect(project.id).not.toBe(file.project.id)
    expect(savedRuns()).toEqual({ takes: [], credits: 1000, spent: 0 })
    expect(project.scenes.map((s) => s.prompt)).toEqual(fixture.expected.prompts)
    const oldImages = file.project.assets.flatMap((a) => a.imageIds)
    const newImages = project.assets.flatMap((a) => a.imageIds)
    expect(db.media.size - mediaStart).toBe(oldImages.length)
    const remap = new Map(oldImages.map((id, i) => [id, newImages[i]]))
    for (let i = 0; i < oldImages.length; i++) {
      expect(newImages[i]).not.toBe(oldImages[i])
      const url = file.media[oldImages[i] as keyof typeof file.media]
      expect(db.media.get(newImages[i])!.type).toBe('image/png')
      expect(new Uint8Array(await db.media.get(newImages[i])!.arrayBuffer())).toEqual(Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0)))
    }
    project.scenes.forEach((scene, index) => {
      expect(scene.videoRefs).toEqual([])
      expect(scene).not.toHaveProperty('legacyVideoRefs')
      const remapped = (keys: string[]) => keys.map((key) => {
        const [asset, image] = key.split(':')
        return `${asset}:${remap.get(image)}`
      })
      expect(imageSlots(project, scene).map(imageKey)).toEqual(remapped(fixture.expected.imageKeys[index]))
      expect(compileScene(project, scene).images.map(imageKey)).toEqual(remapped(fixture.expected.sentImageKeys[index]))
    })
    // presets (factory ones included) and the scenes' links to them travel with the file
    const migratedFile = migrateProject(jsonCopy(file.project))
    expect(project.presets).toEqual(migratedFile.presets)
    expect(project.scenes.map((s) => s.presetId)).toEqual(file.project.scenes.map((s) => s.presetId))
    expect(project.scenes[0].presetId).toBe('preset_draft')
    expect(project).not.toHaveProperty('presetNames')
    for (const folder of project.folders ?? []) {
      expect(folder.id).not.toBe('folder-output')
      expect(folder.path).toBeNull()
      expect(folder.takes ?? []).toEqual([])
      expect(folder.autoScenes).toEqual(['s1', 's2'])
    }
    const portable = projectForExport(project)
    expect(migrateProject(jsonCopy(portable))).toEqual(portable)
    expect(projectForExport(migrateProject(jsonCopy(portable)))).toEqual(portable)
    const importedAgain = importedProject(jsonCopy(portable))
    expect(importedAgain.scenes).toEqual(project.scenes)
    expect(importedAgain.assets).toEqual(project.assets)
    expect(importedAgain.presets).toEqual(project.presets)
    expect(importedAgain).not.toHaveProperty('presetNames')
    expect(JSON.stringify(file)).toBe(before)
    expect(db.values.get(`project:${project.id}`)).toEqual(project)
    await switchProject(fixture.autosave.project.id)
    await switchProject(project.id)
    expect(useProject.getState().project).toEqual(project)
  })

  it('exports only the intended folder redactions without mutating the autosaved project', () => {
    const project = migrateProject(fixture.autosave.project)
    const before = jsonCopy(project)
    const portable = projectForExport(project)
    expect(project).toEqual(before)
    expect(portable.scenes).toEqual(project.scenes)
    expect(portable.assets).toEqual(project.assets)
    expect(portable.presets).toEqual(project.presets)
    for (const folder of portable.folders ?? []) {
      const { takes: _takes, ...old } = project.folders!.find((f) => f.id === folder.id)!
      expect(folder).toEqual({ ...old, path: null })
    }
    expect(projectForExport(migrateProject(jsonCopy(portable)))).toEqual(portable)
  })
})

// 0.1.0 – 0.5.0 laid scenes out in one column, rows 248px apart (v1's grid is below).
describe.each(compatFixtures.slice(1))('$source.version canvas spacing', (fixture) => {
  it('spaces old rows once, saves the result, and undoes/redoes the complete project and take positions', async () => {
    const before = migrateProject(fixture.autosave.project)
    before.id += '-spacing'
    const runs = fixture.autosave.runs.takes.map(migrateTake)
    useProject.getState().loadProject(before)
    useRuns.setState({ takes: runs })
    clearHistory()
    expect(showsOldLayout(before)).toBe(true)
    expect(maybeSpaceRows()).toBe(true)
    const after = useProject.getState().project
    const afterTakes = jsonCopy(useRuns.getState().takes)
    expect(after.scenes.map((s) => s.position.y)).toEqual([60, 60 + ROW_H, 60 + 2 * ROW_H])
    expect(LAYOUT).toMatchObject({ sceneW: 352, sceneH: 304 })
    expect(after.scenes.map((s) => s.prompt)).toEqual(before.scenes.map((s) => s.prompt))
    expect(after.assets.map((a) => a.imageIds)).toEqual(before.assets.map((a) => a.imageIds))
    if (after.folders?.length) expect(after.folders[0].position).toEqual({ x: 1500, y: 60 + ROW_H })
    const placed = runs.find((t) => t.position)
    if (placed) expect(afterTakes.find((t) => t.id === placed.id)!.position).toEqual({ x: placed.position!.x + 72, y: 60 + ROW_H })
    expect(useProject.temporal.getState().pastStates).toHaveLength(1)
    expect(maybeSpaceRows()).toBe(false)
    undo()
    expect(useProject.getState().project).toEqual(before)
    expect(useRuns.getState().takes).toEqual(runs)
    expect(maybeSpaceRows()).toBe(false)
    redo()
    expect(useProject.getState().project).toEqual(after)
    expect(useRuns.getState().takes).toEqual(afterTakes)
    expect(await flush()).toBe(true)
    expect(db.values.get(`project:${after.id}`)).toEqual(after)
    expect((db.values.get(`runs:${after.id}`) as { takes: Take[] }).takes).toEqual(afterTakes)
    // A portable copy has a fresh id and no device marker: the layout itself must prevent a second spacing.
    const copy: Project = { ...migrateProject(jsonCopy(projectForExport(after))), id: after.id + '-copy' }
    useProject.getState().loadProject(copy)
    clearHistory()
    expect(showsOldLayout(copy)).toBe(false)
    expect(maybeSpaceRows()).toBe(false)
    expect(useProject.getState().project).toBe(copy)
    expect(useProject.temporal.getState().pastStates).toHaveLength(0)
  })
})

describe('v1 grid layout (ae04bea: 5 scenes per row, 328px apart, rows 266px apart)', () => {
  const v1Grid = [{ x: 420, y: 60 }, { x: 748, y: 60 }, { x: 1076, y: 60 }, { x: 1404, y: 60 }]
  const boxesAfter = (project: Project, plan: ReturnType<typeof planRowSpacing>) =>
    project.scenes.map((s) => ({ ...(plan.scenes[s.id] ?? s.position), w: LAYOUT.sceneW, h: LAYOUT.sceneH }))
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  it('keeps the v1 grid through migrate, autosave and export, and sees it as an old layout', () => {
    const project = migrateProject(jsonCopy(compatFixtures[0].autosave.project))
    expect(project.scenes.map((s) => s.position)).toEqual(v1Grid)
    expect(migrateProject(jsonCopy(compatFixtures[0].file.project)).scenes.map((s) => s.position)).toEqual(v1Grid)
    expect(showsOldLayout(project)).toBe(true)
  })

  // KNOWN ISSUE, outside the compat boundary (components/canvas/rowSpacing.ts): v1 cards 328px apart no longer fit the
  // 352px node side by side (24px overlap), and the one-time spacing only moves rows DOWN — pushDown turns a v1 row
  // into a zig-zag (420,60 / 748,420 / 1076,60 / 1404,420). Flip to `it` when rowSpacing handles side-by-side cards.
  it.fails('spaces a v1 grid row without overlapping cards and keeps it level', () => {
    const project = migrateProject(jsonCopy(compatFixtures[0].autosave.project))
    const plan = planRowSpacing({ scenes: project.scenes, assets: project.assets, takes: [], folders: project.folders })
    expect(plan.changed).toBe(true)
    const boxes = boxesAfter(project, plan)
    expect(new Set(boxes.map((b) => b.y)).size).toBe(1)
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${i}/${j}`).toBe(false)
  })
})
