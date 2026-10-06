import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { synthProject } from '../../perf/synth'

const db = vi.hoisted(() => ({ values: new Map<string, unknown>(), writes: [] as string[], fail: false }))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => db.values.get(key),
  set: async (key: string, value: unknown) => { db.values.set(key, value) },
  update: async (key: string, fn: (value: unknown) => unknown) => { db.values.set(key, fn(db.values.get(key))) },
  createStore: () => (_mode: string, callback: (store: unknown) => unknown) => {
    let pending = 0
    const writes: [string, unknown][] = []
    const transaction = { oncomplete: () => {}, onerror: () => {}, onabort: () => {}, error: new Error('quota') }
    const store = {
      transaction,
      get(key: string) {
        pending++
        const request = { result: db.values.get(key), onsuccess: () => {} }
        queueMicrotask(() => {
          request.onsuccess()
          if (--pending === 0) queueMicrotask(() => {
            if (db.fail) transaction.onerror()
            else { for (const [k, v] of writes) { db.values.set(k, v); db.writes.push(k) }; transaction.oncomplete() }
          })
        })
        return request
      },
      put(value: unknown, key: string) { writes.push([key, structuredClone(value)]) },
    }
    return callback(store)
  },
}))
vi.mock('../runs', async () => {
  const { create } = await import('zustand')
  const useRuns = create<any>((set) => ({ takes: [], credits: 1000, spent: 0, loadRuns: (data: unknown) => set(data ?? { takes: [], credits: 1000, spent: 0 }) }))
  return { useRuns, setEngineHooks: vi.fn(), stopEngine: vi.fn() }
})
vi.mock('../project', async () => {
  const { create } = await import('zustand')
  const useProject = create<any>((set) => ({ project: { id: 'before' }, loadProject: (project: unknown) => set({ project }) }))
  return { useProject, clearHistory: vi.fn(), emptyProject: vi.fn() }
})
vi.mock('../ui', () => ({ useUI: { getState: () => ({ clearSelection: vi.fn(), toast: vi.fn() }) } }))
vi.mock('../../lib/imageStore', () => ({ deleteMedia: vi.fn(), getBlob: vi.fn(), putBlob: vi.fn(), dataUrlToBlob: vi.fn() }))
vi.mock('../../lib/saveFolders', () => ({ copyFolderHandle: vi.fn() }))
vi.mock('../../core/seed', () => ({ createDemoProject: vi.fn() }))
import { bootstrap, flush, progressOnlyChange, useSave } from '../persist'
import { useRuns } from '../runs'
import { useProject } from '../project'

const data = synthProject({ scenes: 2, takes: 4 })
const { project, runs } = data
const runsWrites = () => db.writes.filter((k) => k.startsWith('runs:')).length
const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
beforeAll(async () => {
  vi.useFakeTimers()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k), length: 0 })
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  vi.stubGlobal('document', { addEventListener: vi.fn() })
  vi.stubGlobal('navigator', {})
  db.values.set('index', [{ id: project.id, name: project.name, scenes: 2, updatedAt: project.updatedAt }])
  db.values.set(`project:${project.id}`, project)
  db.values.set(`runs:${project.id}`, runs)
  await bootstrap()
})
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('progress-only autosave', () => {
  it('ignores only progress, never a persisted field, credits, insertion, deletion or reordering', () => {
    expect(progressOnlyChange(runs, { ...runs, takes: runs.takes.map((t) => ({ ...t, progress: 12 })) })).toBe(true)
    for (const patch of [{ status: 'processing' }, { remoteId: 'job' }, { posterId: 'poster' }, { videoId: 'video' },
      { starred: true }, { position: { x: 1, y: 2 } }, { submitUnknown: true }, { futureField: 'preserve' }]) {
      const changed = { ...runs, takes: [{ ...runs.takes[0], starred: false, ...patch }, ...runs.takes.slice(1)] }
      expect(progressOnlyChange(changed as typeof runs, { ...runs, takes: [{ ...runs.takes[0], starred: false }, ...runs.takes.slice(1)] })).toBe(false)
    }
    expect(progressOnlyChange({ ...runs, credits: 1 }, runs)).toBe(false)
    expect(progressOnlyChange({ ...runs, spent: 1 }, runs)).toBe(false)
    expect(progressOnlyChange({ ...runs, takes: runs.takes.slice(1) }, runs)).toBe(false)
    expect(progressOnlyChange({ ...runs, takes: [...runs.takes].reverse() }, runs)).toBe(false)
  })
  it('does not schedule or flush writes for repeated progress changes', async () => {
    const before = runsWrites()
    for (let i = 0; i < 8; i++) {
      useRuns.setState((s) => ({ takes: s.takes.map((t) => ({ ...t, progress: i })) }))
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(await flush()).toBe(true)
    expect(runsWrites()).toBe(before)
  })
  it('progress ticks do not delay an already scheduled remoteId/status save', async () => {
    const before = runsWrites()
    useRuns.setState((s) => ({ takes: s.takes.map((t, i) => i ? t : { ...t, status: 'processing', remoteId: 'remote-1' }) }))
    await vi.advanceTimersByTimeAsync(600)
    useRuns.setState((s) => ({ takes: s.takes.map((t) => ({ ...t, progress: 53 })) }))
    await vi.advanceTimersByTimeAsync(200)
    expect(runsWrites()).toBe(before + 1)
    expect((db.values.get(`runs:${project.id}`) as typeof runs).takes[0]).toMatchObject({ remoteId: 'remote-1', status: 'processing', progress: 53 })
  })
  it('keeps failed meaningful edits dirty through subsequent progress and retries on flush', async () => {
    db.fail = true
    useRuns.setState((s) => ({ takes: s.takes.map((t, i) => i ? t : { ...t, videoId: 'ready-video', status: 'completed' }) }))
    expect(await flush()).toBe(false)
    const before = runsWrites()
    useRuns.setState((s) => ({ takes: s.takes.map((t) => ({ ...t, progress: 100 })) }))
    db.fail = false
    expect(await flush()).toBe(true)
    expect(runsWrites()).toBe(before + 1)
    expect((db.values.get(`runs:${project.id}`) as typeof runs).takes[0].videoId).toBe('ready-video')
  })
  it('notifies saving once while a sequence of project edits is already saving', async () => {
    await flush()
    let saving = 0
    const unsubscribe = useSave.subscribe((s) => { if (s.status === 'saving') saving++ })
    for (let i = 0; i < 3; i++) useProject.setState((s) => ({ project: { ...s.project, name: `Edit ${i}` } }))
    await turn()
    expect(saving).toBe(1)
    unsubscribe()
    await flush()
  })
})
