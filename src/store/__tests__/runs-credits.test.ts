// Demo wallet rules of store/runs (docs/SPEC-v2.md §9): default for new data, reset, and canvasapp takes never
// touching (or being blocked by) the demo balance. Engine events used by store/credits.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/imageStore', () => {
  let n = 0
  return {
    putBlob: vi.fn(async (_b: Blob, prefix = 'img') => `${prefix}_${++n}`),
    getBlob: vi.fn(async () => null),
    getUrl: vi.fn(async () => null),
    cachedUrl: () => null,
    deleteMedia: vi.fn(async () => undefined),
    dataUrlToBlob: () => new Blob(),
    useMediaUrl: () => null,
  }
})

import type { Project, Scene, Take } from '../../core/types'
import { capabilitiesFromModels } from '../../providers/capabilities'
import { getProvider, registerProvider, useProviderPrefs } from '../../providers'
import type { RemoteStatus, VideoProvider } from '../../providers/types'
import { useProject } from '../project'
import { DEMO_CREDITS_DEFAULT, onRunEvent, setEngineHooks, setEngineLockManager, useRuns, type RunEvent } from '../runs'

const scene = (id: string, order: number): Scene => ({
  id,
  order,
  title: 'Cảnh ' + order,
  prompt: 'A hero walks',
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

const project = (): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [],
  scenes: [scene('s1', 1), scene('s2', 2)],
})

function fakeProvider(id: 'mock' | 'canvasapp' | 'dev') {
  const statuses = new Map<string, RemoteStatus>()
  const p: VideoProvider = {
    id,
    label: id,
    available: async () => ({ ok: true }),
    capabilities: (m) => capabilitiesFromModels(m, { maxConcurrency: 2, pollIntervalMs: id === 'mock' ? 0 : 15_000, maxRefVideos: 0 }),
    submit: async (req) => {
      const remoteId = 'r_' + req.key
      statuses.set(remoteId, { remoteId, state: 'queued' })
      return { remoteId }
    },
    poll: async (ids) => ids.map((rid) => statuses.get(rid)!).filter(Boolean),
    fetchResult: async () => ({ video: new Blob(['v'], { type: 'video/mp4' }), poster: new Blob(['p'], { type: 'image/jpeg' }) }),
  }
  return { p, statuses }
}

const realMock = getProvider('mock')
const realDev = getProvider('dev')
const g = globalThis as { window?: unknown }
const useCanvasapp = () => {
  g.window = { bdpDesktop: { canvasapp: { request: async () => ({}) } } }
  const f = fakeProvider('canvasapp')
  registerProvider(f.p)
  useProviderPrefs.setState({ provider: 'canvasapp' })
  return f
}

let events: RunEvent[] = []
let off: () => void = () => undefined

beforeEach(() => {
  setEngineLockManager(null)
  setEngineHooks({})
  vi.useFakeTimers()
  useProject.getState().loadProject(project())
  useRuns.getState().loadRuns(null)
  events = []
  off = onRunEvent((e) => events.push(e))
})
afterEach(() => {
  off()
  useRuns.getState().loadRuns(null)
  vi.advanceTimersByTime(250)
  vi.useRealTimers()
  registerProvider(realMock)
  registerProvider(realDev)
  useProviderPrefs.setState({ provider: 'dev' })
  delete g.window
})
afterAll(() => {
  setEngineLockManager(undefined)
})

describe('demo wallet', () => {
  it('new runs data start with 1000 demo credits; saved balances are kept', () => {
    expect(DEMO_CREDITS_DEFAULT).toBe(1000)
    expect(useRuns.getState()).toMatchObject({ credits: 1000, spent: 0 })
    useRuns.getState().loadRuns({ takes: [], credits: 377, spent: 12 })
    expect(useRuns.getState()).toMatchObject({ credits: 377, spent: 12 })
    useRuns.getState().loadRuns({ takes: [], credits: 0, spent: 0 })
    expect(useRuns.getState().credits).toBe(0)
    // unreadable numbers are not a balance
    useRuns.getState().loadRuns({ takes: [], credits: Number.NaN, spent: Number.NaN })
    expect(useRuns.getState()).toMatchObject({ credits: 1000, spent: 0 })
  })

  it('resetDemoCredits → 1000, spent 0; addCredits still adds', () => {
    useRuns.getState().loadRuns({ takes: [], credits: 7, spent: 400 })
    useRuns.getState().addCredits(100)
    expect(useRuns.getState().credits).toBe(107)
    useRuns.getState().addCredits(Number.NaN)
    expect(useRuns.getState().credits).toBe(107)
    useRuns.getState().resetDemoCredits()
    expect(useRuns.getState()).toMatchObject({ credits: 1000, spent: 0 })
  })

  it('new takes run in development mode and never touch (or wait for) the demo balance', () => {
    registerProvider(fakeProvider('dev').p)
    useRuns.getState().loadRuns({ takes: [], credits: 1, spent: 0 })
    const r = useRuns.getState().enqueue(['s1'])
    expect(r.error).toBeUndefined()
    expect(r.queued).toBe(1)
    expect(useRuns.getState().takes[0]).toMatchObject({ provider: 'dev', charged: false })
    expect(useRuns.getState()).toMatchObject({ credits: 1, spent: 0 })
  })
})

describe('canvasapp takes and the demo balance', () => {
  it('are never blocked by it and never change it (charged = false)', async () => {
    const f = useCanvasapp()
    useRuns.getState().loadRuns({ takes: [], credits: 0, spent: 3 })
    expect(useRuns.getState().check(['s1', 's2']).every((c) => c.ok)).toBe(true)
    const r = useRuns.getState().enqueue(['s1', 's2'])
    expect(r.error).toBeUndefined()
    expect(r.queued).toBe(2)
    expect(useRuns.getState()).toMatchObject({ credits: 0, spent: 3 })
    expect(useRuns.getState().takes.every((t) => t.provider === 'canvasapp' && t.charged === false)).toBe(true)

    await vi.advanceTimersByTimeAsync(250)
    const [a, b] = useRuns.getState().takes
    expect(events.filter((e) => e.type === 'submitted').map((e) => [e.takeId, e.provider]).sort()).toEqual(
      [
        [a.id, 'canvasapp'],
        [b.id, 'canvasapp'],
      ].sort(),
    )

    f.statuses.set('r_' + a.id, { remoteId: 'r_' + a.id, state: 'failed', error: 'x' })
    f.statuses.set('r_' + b.id, { remoteId: 'r_' + b.id, state: 'completed', progress: 100 })
    await vi.advanceTimersByTimeAsync(16_000)
    expect(useRuns.getState().takes.map((t) => t.status).sort()).toEqual(['completed', 'failed'])
    expect(events).toContainEqual({ type: 'failed', takeId: a.id, provider: 'canvasapp' })
    expect(events).toContainEqual({ type: 'completed', takeId: b.id, provider: 'canvasapp' })
    // no refund into the demo wallet
    expect(useRuns.getState()).toMatchObject({ credits: 0, spent: 3 })
  })

  it('a canvasapp take flagged charged by mistake still never refunds demo credits', () => {
    useCanvasapp()
    const t: Take = {
      id: 'tk',
      sceneId: 's1',
      number: 1,
      status: 'queued',
      progress: 0,
      createdAt: 0,
      startedAt: null,
      finishedAt: null,
      promptSnapshot: 'x',
      rawPromptSnapshot: 'x',
      refsSnapshot: [],
      videoRefsSnapshot: [],
      settings: project().scenes[0].settings,
      cost: 15,
      starred: false,
      posterId: null,
      videoId: null,
      error: null,
      position: null,
      provider: 'canvasapp',
      remoteId: null,
      charged: true,
    }
    useRuns.getState().loadRuns({ takes: [t], credits: 50, spent: 0 })
    useRuns.getState().cancel('tk')
    expect(useRuns.getState().takes[0].status).toBe('cancelled')
    expect(useRuns.getState()).toMatchObject({ credits: 50, spent: 0 })
    expect(events).toContainEqual({ type: 'cancelled', takeId: 'tk', provider: 'canvasapp' })
  })

  it('old demo takes (saved before development mode) still get refunded as before', async () => {
    const f = fakeProvider('mock')
    registerProvider(f.p)
    const old: Take = {
      id: 'old',
      sceneId: 's1',
      number: 1,
      status: 'queued',
      progress: 0,
      createdAt: 0,
      startedAt: null,
      finishedAt: null,
      promptSnapshot: 'x',
      rawPromptSnapshot: 'x',
      refsSnapshot: [],
      videoRefsSnapshot: [],
      settings: project().scenes[0].settings,
      cost: 4,
      starred: false,
      posterId: null,
      videoId: null,
      error: null,
      position: null,
      provider: 'mock',
      remoteId: null,
      charged: true,
    }
    useRuns.getState().loadRuns({ takes: [old], credits: 996, spent: 4 })
    await vi.advanceTimersByTimeAsync(250)
    const id = 'old'
    expect(events).toContainEqual({ type: 'submitted', takeId: id, provider: 'mock' })
    f.statuses.set('r_' + id, { remoteId: 'r_' + id, state: 'failed', error: 'boom' })
    await vi.advanceTimersByTimeAsync(250)
    expect(useRuns.getState()).toMatchObject({ credits: 1000, spent: 0 })
    expect(events).toContainEqual({ type: 'failed', takeId: id, provider: 'mock' })
  })

  it('a throwing event listener does not break the engine', async () => {
    const offBad = onRunEvent(() => {
      throw new Error('listener bug')
    })
    try {
      useCanvasapp()
      useRuns.getState().enqueue(['s1'])
      await vi.advanceTimersByTimeAsync(250)
      expect(useRuns.getState().takes[0]).toMatchObject({ status: 'processing', remoteId: expect.stringMatching(/^r_/) })
    } finally {
      offBad()
    }
  })
})
