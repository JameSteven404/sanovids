// Queue engine (store/runs.ts) driving a fake provider through the VideoProvider interface.
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
import { getProvider, registerProvider, useProviderPrefs } from '../index'
import type { JobRequest, RemoteStatus, RunTake, VideoProvider } from '../types'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { capabilitiesFromModels } from '../capabilities'

const scene = (id: string, order: number, over: Partial<Scene> = {}): Scene => ({
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
  ...over,
})

const project = (): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [{ id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1', 'i2'], color: '#fff', position: null }],
  scenes: [scene('s1', 1, { refs: ['a'], prompt: '@image_1 runs' }), scene('s2', 2)],
})

/** Fake provider: statuses are set by the test. */
function fakeProvider(id: 'mock' | 'canvasapp', pollIntervalMs = 0) {
  const statuses = new Map<string, RemoteStatus>()
  const submitted: JobRequest[] = []
  const cancelled: string[] = []
  let polls = 0
  const p: VideoProvider = {
    id,
    label: id,
    available: async () => ({ ok: true }),
    capabilities: (m) => capabilitiesFromModels(m, { maxConcurrency: 2, pollIntervalMs, maxRefVideos: id === 'mock' ? 10 : 0 }),
    submit: async (req) => {
      submitted.push(req)
      const remoteId = 'r_' + req.key
      statuses.set(remoteId, { remoteId, state: 'queued' })
      return { remoteId }
    },
    poll: async (ids) => {
      polls++
      return ids.map((rid) => statuses.get(rid)!).filter(Boolean)
    },
    fetchResult: async () => ({ video: new Blob(['v'], { type: 'video/mp4' }), poster: new Blob(['p'], { type: 'image/jpeg' }) }),
    cancel: (rid) => void cancelled.push(rid),
  }
  return { p, statuses, submitted, cancelled, polls: () => polls }
}

const realMock = getProvider('mock')
const take = (id: string) => useRuns.getState().takes.find((t) => t.id === id) as RunTake

beforeEach(() => {
  vi.useFakeTimers()
  useProject.getState().loadProject(project())
  useRuns.getState().loadRuns({ takes: [], credits: 100, spent: 0 })
})
afterEach(() => {
  useRuns.getState().loadRuns({ takes: [], credits: 377, spent: 0 })
  // let the (fake-timer) engine see the empty queue and stop, so the next test starts a fresh one
  vi.advanceTimersByTime(250)
  vi.useRealTimers()
  registerProvider(realMock)
  useProviderPrefs.setState({ provider: 'mock' })
  delete (globalThis as { window?: unknown }).window
})
afterAll(() => registerProvider(realMock))

describe('runs engine with a provider', () => {
  it('submits, stores the remote id, follows progress and stores the result', async () => {
    const f = fakeProvider('mock')
    registerProvider(f.p)
    const r = useRuns.getState().enqueue(['s1'])
    expect(r.queued).toBe(1)
    expect(useRuns.getState().credits).toBe(100 - r.cost)
    const id = useRuns.getState().takes[0].id

    await vi.advanceTimersByTimeAsync(250)
    expect(take(id).status).toBe('processing')
    expect(take(id).remoteId).toBe('r_' + id)
    expect(take(id).provider).toBe('mock')
    // request built from the snapshot: @image order, compiled prompt, idempotency key
    expect(f.submitted[0]).toMatchObject({ key: id, prompt: '@image_1 runs', sceneCode: 'S01', images: [{ n: 1, imageId: 'i1' }, { n: 2, imageId: 'i2' }] })

    f.statuses.set('r_' + id, { remoteId: 'r_' + id, state: 'processing', progress: 40 })
    await vi.advanceTimersByTimeAsync(250)
    expect(take(id).progress).toBe(40)

    f.statuses.set('r_' + id, { remoteId: 'r_' + id, state: 'completed', progress: 100 })
    await vi.advanceTimersByTimeAsync(450)
    const done = take(id)
    expect(done.status).toBe('completed')
    expect(done.progress).toBe(100)
    expect(done.posterId).toMatch(/^poster_/)
    expect(done.videoId).toMatch(/^video_/)
  })

  it('refunds demo credits when the provider reports a failure', async () => {
    const f = fakeProvider('mock')
    registerProvider(f.p)
    const r = useRuns.getState().enqueue(['s2'])
    const id = useRuns.getState().takes[0].id
    await vi.advanceTimersByTimeAsync(250)
    f.statuses.set('r_' + id, { remoteId: 'r_' + id, state: 'failed', progress: 55, error: 'boom' })
    await vi.advanceTimersByTimeAsync(250)
    expect(take(id)).toMatchObject({ status: 'failed', error: 'boom', progress: 55 })
    expect(useRuns.getState().credits).toBe(100)
    expect(r.cost).toBeGreaterThan(0)
  })

  it('cancel refunds and tells the provider', async () => {
    const f = fakeProvider('mock')
    registerProvider(f.p)
    useRuns.getState().enqueue(['s2'])
    const id = useRuns.getState().takes[0].id
    await vi.advanceTimersByTimeAsync(250)
    useRuns.getState().cancel(id)
    expect(take(id).status).toBe('cancelled')
    expect(f.cancelled).toEqual(['r_' + id])
    expect(useRuns.getState().credits).toBe(100)
  })

  it('respects the mock concurrency setting', async () => {
    const f = fakeProvider('mock')
    registerProvider(f.p)
    useRuns.getState().setMock({ concurrency: 1 })
    useRuns.getState().enqueue(['s1', 's2'])
    await vi.advanceTimersByTimeAsync(450)
    expect(useRuns.getState().takes.map((t) => t.status).sort()).toEqual(['processing', 'queued'])
    useRuns.getState().setMock({ concurrency: 3 })
  })

  it('a submit error fails the take and refunds', async () => {
    const f = fakeProvider('mock')
    f.p.submit = async () => {
      throw new Error('Không gửi được')
    }
    registerProvider(f.p)
    useRuns.getState().enqueue(['s2'])
    await vi.advanceTimersByTimeAsync(250)
    expect(useRuns.getState().takes[0]).toMatchObject({ status: 'failed', error: 'Không gửi được' })
    expect(useRuns.getState().credits).toBe(100)
  })

  it('remote provider: no local credit, gentle polling, resume after reload without resubmitting', async () => {
    ;(globalThis as { window?: unknown }).window = { bdpDesktop: { canvasapp: { request: async () => ({}) } } }
    const f = fakeProvider('canvasapp', 20_000)
    registerProvider(f.p)
    useProviderPrefs.setState({ provider: 'canvasapp' })

    const r = useRuns.getState().enqueue(['s2'])
    expect(r.queued).toBe(1)
    expect(useRuns.getState().credits).toBe(100)
    const id = useRuns.getState().takes[0].id
    expect(take(id)).toMatchObject({ provider: 'canvasapp', charged: false })

    await vi.advanceTimersByTimeAsync(1000)
    expect(f.polls()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.polls()).toBe(1) // not before the provider's interval (≥ 15 s)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.polls()).toBe(2)

    // reload: a remote job that was processing keeps its remote id and is not submitted again
    const saved = useRuns.getState().takes
    useRuns.getState().loadRuns({ takes: saved, credits: 100, spent: 0 })
    expect(take(id).status).toBe('processing')
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.submitted.length).toBe(1)

    // failure of a remote job does not add demo credits
    f.statuses.set('r_' + id, { remoteId: 'r_' + id, state: 'failed', error: 'x' })
    await vi.advanceTimersByTimeAsync(21_000)
    expect(take(id).status).toBe('failed')
    expect(useRuns.getState().credits).toBe(100)
  })

  it('remote provider: scenes with @video refs are skipped (unsupported)', () => {
    ;(globalThis as { window?: unknown }).window = { bdpDesktop: { canvasapp: { request: async () => ({}) } } }
    registerProvider(fakeProvider('canvasapp', 20_000).p)
    useProviderPrefs.setState({ provider: 'canvasapp' })
    const done: Take = {
      id: 'tk',
      sceneId: 's1',
      number: 1,
      status: 'completed',
      progress: 100,
      createdAt: 0,
      startedAt: 0,
      finishedAt: 0,
      promptSnapshot: '',
      rawPromptSnapshot: '',
      refsSnapshot: [],
      videoRefsSnapshot: [],
      settings: project().scenes[0].settings,
      cost: 0,
      starred: false,
      posterId: null,
      videoId: 'v',
      error: null,
      position: null,
    }
    useRuns.setState({ takes: [done] })
    useProject.getState().loadProject({ ...project(), scenes: [scene('s1', 1), scene('s2', 2, { videoRefs: ['tk'], prompt: '@video_1 again' })] })
    const [c] = useRuns.getState().check(['s2'])
    expect(c.ok).toBe(false)
    expect(c.reason).toMatch(/video tham chiếu/)
  })

  it('loadRuns puts demo jobs that were processing back in the queue', () => {
    const t = { ...(useRuns.getState().takes[0] ?? {}), id: 'old', sceneId: 's1', number: 1, status: 'processing', progress: 50, startedAt: 5, createdAt: 1 } as Take
    useRuns.getState().loadRuns({ takes: [t], credits: 10, spent: 0 })
    expect(take('old')).toMatchObject({ status: 'queued', progress: 0, startedAt: null })
  })
})
