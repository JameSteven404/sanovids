// A stress run that fails before its own (temporary) project is open must leave the open project — the user's — alone:
// emptying the runs store there would be autosaved over the user's takes (their videos left unreferenced).
// Covers the runner's own clean-up (headless) and the in-app sandbox's (store/persist mocked: no IndexedDB here).
import { afterEach, describe, expect, it, vi } from 'vitest'

const media = vi.hoisted(() => new Map<string, Blob>())
vi.mock('../../../lib/imageStore', () => {
  let n = 0
  return {
    putBlob: vi.fn(async (b: Blob, prefix = 'img') => {
      const id = `${prefix}_${++n}`
      media.set(id, b)
      return id
    }),
    getBlob: vi.fn(async (id: string) => media.get(id) ?? null),
    getUrl: vi.fn(async () => null),
    cachedUrl: () => null,
    deleteMedia: vi.fn(async (id: string) => void media.delete(id)),
    dataUrlToBlob: () => new Blob(),
    useMediaUrl: () => null,
  }
})
const persist = vi.hoisted(() => ({
  flush: vi.fn(async () => true),
  importProjectFile: vi.fn(async (_file: File): Promise<void> => undefined),
  switchProject: vi.fn(async (_id: string): Promise<void> => undefined),
  deleteProject: vi.fn(async (_id: string): Promise<void> => undefined),
  useSave: { getState: () => ({ ready: true, stale: false, status: 'saved' }) },
}))
vi.mock('../../../store/persist', () => persist)
vi.mock('../../../store/credits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../store/credits')>()),
  refreshRealCredits: vi.fn(async () => undefined),
}))

import type { Project, Scene, Take } from '../../../core/types'
import { memoryStorage } from '../../../providers/canvasapp/adapter'
import { createDevCanvasapp, memoryBlobStore, setDevServer } from '../../../providers/dev'
import { useProviderPrefs } from '../../../providers'
import { useProject } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import { runStress } from '../runner'
import { runInSandbox } from '../sandbox'
import { sessionActive } from '../session'
import { createHeadless, type Headless } from './headlessEnv'

const FULL = 'Không tạo được dự án: không ghi được vào bộ nhớ trình duyệt (bộ nhớ đầy?).'

const scene = (id: string, order: number): Scene => ({
  id,
  order,
  title: 'Cảnh ' + order,
  prompt: 'Một con đường vắng',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: order * 300 },
  note: '',
})

const userProject = (): Project => ({
  id: 'p_user',
  name: 'Phim của tôi',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [],
  scenes: [scene('s1', 1), scene('s2', 2)],
})

const userTake = (id: string, sceneId: string, number: number): Take => ({
  id,
  sceneId,
  number,
  status: 'completed',
  progress: 100,
  createdAt: number,
  startedAt: 1,
  finishedAt: 2,
  promptSnapshot: 'Một con đường vắng',
  rawPromptSnapshot: 'Một con đường vắng',
  refsSnapshot: [],
  videoRefsSnapshot: [],
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' },
  cost: 5,
  starred: false,
  posterId: null,
  videoId: `vid_${id}`,
  error: null,
  position: null,
})

/** The user's project and its takes, as open in the app. */
function openUser() {
  useProject.getState().loadProject(userProject())
  useRuns.getState().loadRuns({ takes: [userTake('t1', 's1', 1), userTake('t2', 's2', 1)], credits: 7, spent: 3 })
}

const OPTIONS = { scenarios: ['monkey'], steps: 20, maxMs: 0, checkEvery: 10, stopOnFirst: true, tier: 'S' as const }

let h: Headless | null = null
afterEach(() => {
  h?.dispose()
  h = null
  media.clear()
  vi.unstubAllGlobals()
  setDevServer(null)
  useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
  for (const f of [persist.flush, persist.importProjectFile, persist.switchProject, persist.deleteProject]) f.mockClear()
})

describe('stress runner: clean-up only on its own project', () => {
  it('a load that fails before the run’s project is open leaves the open project’s takes alone', async () => {
    h = createHeadless('5afe0001')
    openUser()
    const before = useRuns.getState().takes
    const r = await runStress({ ...OPTIONS, seed: '5afe0001' }, h.env, {
      load: async () => {
        throw new Error(FULL)
      },
    })
    expect(r.result).toBe('harness-error')
    expect(r.failure?.message).toContain('bộ nhớ đầy')
    expect(useProject.getState().project.id).toBe('p_user')
    expect(useRuns.getState().takes).toBe(before) // not emptied (the autosave would write that over the user's runs)
    expect(useRuns.getState()).toMatchObject({ credits: 7, spent: 3 })
    expect(sessionActive()).toBe(false)
  })

  it('a load that opened the run’s project and then failed: the run’s takes are still stopped', async () => {
    h = createHeadless('5afe0002')
    openUser()
    const r = await runStress({ ...OPTIONS, seed: '5afe0002' }, h.env, {
      load: async (gen) => {
        useProject.getState().loadProject(gen.project)
        useRuns.getState().loadRuns({ takes: gen.takes, credits: 1000, spent: 0 })
        throw new Error('boom')
      },
    })
    expect(r.result).toBe('harness-error')
    expect(useRuns.getState().takes).toEqual([])
    expect(sessionActive()).toBe(false)
  })
})

describe('stress sandbox (in the app): the user’s takes survive a run that never got its temporary project', () => {
  /** Just enough of a browser page for the sandbox's guards (node has no DOM). */
  function stubPage() {
    vi.stubGlobal('window', {
      fetch: async () => new Response(''),
      confirm: () => true,
      alert: () => undefined,
      prompt: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        open() {}
      },
    )
    vi.stubGlobal(
      'HTMLAnchorElement',
      class {
        click() {}
        hasAttribute() {
          return false
        }
      },
    )
    // the app's own dev server (a session restores it): an in-memory one, nothing stored
    setDevServer(createDevCanvasapp({ storage: memoryStorage(), blobs: memoryBlobStore(), render: async () => new Blob(['v'], { type: 'video/webm' }) }))
    useProviderPrefs.setState({ provider: 'dev' })
  }

  it('the import of the temporary project fails before switching (storage full): nothing of the user’s is touched', async () => {
    stubPage()
    openUser()
    const before = useRuns.getState().takes
    persist.importProjectFile.mockImplementationOnce(async () => {
      throw new Error(FULL)
    })
    const r = await runInSandbox({ ...OPTIONS, seed: '5afe0003' })
    expect(r.result).toBe('harness-error')
    expect(persist.importProjectFile).toHaveBeenCalledTimes(1)
    expect(useProject.getState().project.id).toBe('p_user')
    expect(useRuns.getState().takes).toBe(before)
    expect(useRuns.getState()).toMatchObject({ credits: 7, spent: 3 })
    expect(persist.switchProject).not.toHaveBeenCalled()
    expect(persist.deleteProject).not.toHaveBeenCalled()
    expect(sessionActive()).toBe(false)
  })

  it('the import opened the temporary project and then threw: that project is stopped, the user’s reopened, the temporary one deleted', async () => {
    stubPage()
    openUser()
    persist.importProjectFile.mockImplementationOnce(async () => {
      useProject.getState().loadProject({ ...userProject(), id: 'p_temp', name: 'Thử nghiệm', scenes: [] })
      useRuns.getState().loadRuns(null)
      throw new Error('toast failed')
    })
    persist.switchProject.mockImplementationOnce(async (id: string) => {
      expect(useRuns.getState().takes).toEqual([]) // the temporary project's runs were stopped first
      expect(id).toBe('p_user')
      openUser()
    })
    const r = await runInSandbox({ ...OPTIONS, seed: '5afe0004' })
    expect(r.result).toBe('harness-error')
    expect(persist.switchProject).toHaveBeenCalledWith('p_user')
    expect(persist.deleteProject).toHaveBeenCalledWith('p_temp')
    expect(useProject.getState().project.id).toBe('p_user')
    expect(useRuns.getState().takes.map((t) => t.id)).toEqual(['t1', 't2'])
  })
})
