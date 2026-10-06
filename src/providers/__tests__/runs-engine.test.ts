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
import { clearableTakes, isParkedTake, setEngineHooks, setEngineLockManager, UNKNOWN_SUBMIT_ERROR, useRuns } from '../../store/runs'
import type { LockManagerLike } from '../../store/engineLock'
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

/** Fake provider: statuses are set by the test. 'dev' declares no poll floor (polled every engine tick). */
function fakeProvider(id: 'mock' | 'canvasapp' | 'dev', pollIntervalMs = 0) {
  const statuses = new Map<string, RemoteStatus>()
  const submitted: JobRequest[] = []
  const cancelled: string[] = []
  let polls = 0
  const p: VideoProvider = {
    id,
    label: id,
    ...(id === 'dev' ? { minPollIntervalMs: 0 } : {}),
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
const realDev = getProvider('dev')
const take = (id: string) => useRuns.getState().takes.find((t) => t.id === id) as RunTake

/**
 * A take of the old demo provider as an older version saved it (queued, paid with demo credits): new takes never run
 * on 'mock' any more, but saved ones still run, refund and cancel as before.
 */
const legacyTake = (id: string, sceneId: string, over: Partial<Take> = {}): Take => ({
  id,
  sceneId,
  number: 1,
  status: 'queued',
  progress: 0,
  createdAt: 1,
  startedAt: null,
  finishedAt: null,
  promptSnapshot: 'A hero walks',
  rawPromptSnapshot: 'A hero walks',
  refsSnapshot: [],
  videoRefsSnapshot: [],
  settings: project().scenes[1].settings,
  cost: 4,
  starred: false,
  posterId: null,
  videoId: null,
  error: null,
  position: null,
  provider: 'mock',
  remoteId: null,
  charged: true,
  ...over,
})

/** Web Locks stand-in shared by "tabs": `otherTab(name)` holds a lock until the returned function is called. */
function fakeLocks() {
  const held = new Set<string>()
  const m: LockManagerLike & { held: Set<string>; otherTab: (name: string) => () => void } = {
    held,
    request: async (name, _opts, cb) => {
      await Promise.resolve() // granted asynchronously, like the browser
      if (held.has(name)) return cb(null)
      held.add(name)
      try {
        return await cb({ name })
      } finally {
        held.delete(name)
      }
    },
    otherTab: (name) => {
      held.add(name)
      return () => held.delete(name)
    },
  }
  return m
}

beforeEach(() => {
  // Default: no Web Locks API (this tab owns the engine). Tests of the lock install a fake one.
  setEngineLockManager(null)
  setEngineHooks({})
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
  registerProvider(realDev)
  useProviderPrefs.setState({ provider: 'dev' })
  delete (globalThis as { window?: unknown }).window
})
afterAll(() => {
  registerProvider(realMock)
  registerProvider(realDev)
  setEngineLockManager(undefined)
  setEngineHooks({})
})

describe('runs engine with a provider', () => {
  it('submits, stores the remote id, follows progress and stores the result (new takes run on dev mode)', async () => {
    const f = fakeProvider('dev')
    registerProvider(f.p)
    const r = useRuns.getState().enqueue(['s1'])
    expect(r.queued).toBe(1)
    expect(useRuns.getState().credits).toBe(100) // the old demo wallet is never charged by new takes
    const id = useRuns.getState().takes[0].id
    expect(take(id)).toMatchObject({ provider: 'dev', charged: false })

    await vi.advanceTimersByTimeAsync(250)
    expect(take(id).status).toBe('processing')
    expect(take(id).remoteId).toBe('r_' + id)
    expect(take(id).provider).toBe('dev')
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

  it('an old demo take still runs, and a failure reported by the provider refunds its demo credits', async () => {
    const f = fakeProvider('mock')
    registerProvider(f.p)
    useRuns.getState().loadRuns({ takes: [legacyTake('old1', 's2')], credits: 96, spent: 4 })
    const id = 'old1'
    await vi.advanceTimersByTimeAsync(250)
    expect(take(id)).toMatchObject({ status: 'processing', remoteId: 'r_old1' })
    f.statuses.set('r_' + id, { remoteId: 'r_' + id, state: 'failed', progress: 55, error: 'boom' })
    await vi.advanceTimersByTimeAsync(250)
    expect(take(id)).toMatchObject({ status: 'failed', error: 'boom', progress: 55 })
    expect(useRuns.getState()).toMatchObject({ credits: 100, spent: 0 })
  })

  it('cancelling an old demo take refunds and tells the provider', async () => {
    const f = fakeProvider('mock')
    registerProvider(f.p)
    useRuns.getState().loadRuns({ takes: [legacyTake('old1', 's2')], credits: 96, spent: 4 })
    const id = 'old1'
    await vi.advanceTimersByTimeAsync(250)
    useRuns.getState().cancel(id)
    expect(take(id).status).toBe('cancelled')
    expect(f.cancelled).toEqual(['r_' + id])
    expect(useRuns.getState().credits).toBe(100)
  })

  it('respects the mock concurrency setting (old demo takes)', async () => {
    const f = fakeProvider('mock')
    registerProvider(f.p)
    useRuns.getState().setMock({ concurrency: 1 })
    useRuns.getState().loadRuns({ takes: [legacyTake('old1', 's1'), legacyTake('old2', 's2', { createdAt: 2 })], credits: 92, spent: 8 })
    await vi.advanceTimersByTimeAsync(450)
    expect(useRuns.getState().takes.map((t) => t.status).sort()).toEqual(['processing', 'queued'])
    useRuns.getState().setMock({ concurrency: 3 })
  })

  it('a submit error fails an old demo take and refunds', async () => {
    const f = fakeProvider('mock')
    f.p.submit = async () => {
      throw new Error('Không gửi được')
    }
    registerProvider(f.p)
    useRuns.getState().loadRuns({ takes: [legacyTake('old1', 's2')], credits: 96, spent: 4 })
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

  it('enqueue keeps the full image key list of the refs (before the model cap)', () => {
    useRuns.getState().enqueue(['s1', 's2'])
    const [a, b] = useRuns.getState().takes
    expect(a.imageKeysSnapshot).toEqual(['a:i1', 'a:i2'])
    expect(b.imageKeysSnapshot).toEqual([])
    expect(a).toMatchObject({ provider: 'dev', remoteId: null, charged: false, framesSnapshot: { first: null, last: null } })
  })

  it('a remote take left running without a remote id fails and is never submitted again', async () => {
    ;(globalThis as { window?: unknown }).window = { bdpDesktop: { canvasapp: { request: async () => ({}) } } }
    const f = fakeProvider('canvasapp', 20_000)
    f.p.submit = (req) => {
      f.submitted.push(req)
      return new Promise(() => undefined) // the page "closes" while submitting
    }
    registerProvider(f.p)
    useProviderPrefs.setState({ provider: 'canvasapp' })
    useRuns.getState().enqueue(['s2'])
    const id = useRuns.getState().takes[0].id
    await vi.advanceTimersByTimeAsync(250)
    expect(f.submitted.length).toBe(1)
    expect(take(id)).toMatchObject({ status: 'processing', remoteId: null })

    // reload with the data saved meanwhile
    useRuns.getState().loadRuns({ takes: useRuns.getState().takes, credits: 100, spent: 0 })
    expect(take(id)).toMatchObject({ status: 'failed', error: UNKNOWN_SUBMIT_ERROR })
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.submitted.length).toBe(1)
    expect(useRuns.getState().credits).toBe(100)
  })

  it('only the tab holding the engine lock runs jobs; another tab takes over when it is released', async () => {
    const locks = fakeLocks()
    setEngineLockManager(locks)
    const takeover = vi.fn(async () => true)
    setEngineHooks({ beforeTakeover: takeover })
    const releaseOther = locks.otherTab('sanovids-engine:p')
    const f = fakeProvider('dev')
    registerProvider(f.p)

    useRuns.getState().enqueue(['s2'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.submitted.length).toBe(0)
    expect(useRuns.getState().engineElsewhere).toBe(true)
    expect(useRuns.getState().takes[0].status).toBe('queued')

    releaseOther()
    await vi.advanceTimersByTimeAsync(3500)
    expect(takeover).toHaveBeenCalledWith('p')
    expect(useRuns.getState().engineElsewhere).toBe(false)
    expect(f.submitted.length).toBe(1)
    expect(locks.held.has('sanovids-engine:p')).toBe(true)

    // done → idle → the lock is let go
    const id = useRuns.getState().takes[0].id
    f.statuses.set('r_' + id, { remoteId: 'r_' + id, state: 'completed', progress: 100 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(take(id).status).toBe('completed')
    expect(locks.held.has('sanovids-engine:p')).toBe(false)
  })

  it('a tab that only displays progress leaves running takes alone', async () => {
    const locks = fakeLocks()
    setEngineLockManager(locks)
    locks.otherTab('sanovids-engine:p')
    const t = {
      id: 'old', sceneId: 's1', number: 1, status: 'processing', progress: 50, createdAt: 1, startedAt: 5, finishedAt: null,
      promptSnapshot: '', rawPromptSnapshot: '', refsSnapshot: [], videoRefsSnapshot: [], settings: project().scenes[0].settings,
      cost: 4, starred: false, posterId: null, videoId: null, error: null, position: null, provider: 'mock', remoteId: 'old',
    } as Take
    useRuns.getState().loadRuns({ takes: [t], credits: 10, spent: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(take('old')).toMatchObject({ status: 'processing', progress: 50, startedAt: 5 })
    expect(useRuns.getState().engineElsewhere).toBe(true)
  })

  it('beforeTakeover = false: nothing runs and the lock is given back', async () => {
    const locks = fakeLocks()
    setEngineLockManager(locks)
    setEngineHooks({ beforeTakeover: async () => false })
    const f = fakeProvider('dev')
    registerProvider(f.p)
    useRuns.getState().enqueue(['s2'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.submitted.length).toBe(0)
    expect(locks.held.size).toBe(0)
  })
})

describe('takes of a newer SanoVids build (foreignProvider)', () => {
  /** A take as a newer build saved it: a provider this build does not know, maybe still running there. */
  const newerTake = (id: string, status: Take['status'], over: Record<string, unknown> = {}) =>
    ({ ...legacyTake(id, 's2'), status, provider: 'seedvis', remoteId: 'job-' + id, charged: true, ...over }) as unknown as Take

  it('loaded queued / running: parked as failed, never submitted, polled, refunded or counted as work', async () => {
    const f = fakeProvider('mock')
    registerProvider(f.p)
    useRuns.getState().loadRuns({
      takes: [newerTake('q', 'queued'), newerTake('p', 'processing', { progress: 40 }), newerTake('done', 'completed', { remoteId: null })],
      credits: 100,
      spent: 0,
    })
    for (const id of ['q', 'p']) {
      expect(take(id)).toMatchObject({ status: 'failed', foreignStatus: id === 'q' ? 'queued' : 'processing', foreignProvider: 'seedvis', provider: 'mock', charged: false, remoteId: 'job-' + id })
      expect(take(id).error).toContain('SanoVids bản mới hơn')
    }
    expect(take('done')).toMatchObject({ status: 'completed', foreignProvider: 'seedvis', charged: false })
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.submitted).toEqual([])
    expect(f.polls()).toBe(0)
    expect(take('p')).toMatchObject({ status: 'failed', progress: 40 })
    // cancelling / removing them gives back no demo credit (they were never paid here)
    useRuns.getState().cancel('p')
    useRuns.getState().removeTakes(['q'])
    expect(useRuns.getState()).toMatchObject({ credits: 100, spent: 0 })
  })

  it('the engine parks one it finds running (backstop of migrate) instead of adopting or running it', async () => {
    const f = fakeProvider('mock')
    registerProvider(f.p)
    const dev = fakeProvider('dev')
    registerProvider(dev.p)
    const raw = { ...newerTake('x', 'processing'), provider: 'mock', foreignProvider: 'seedvis', charged: false } as Take
    const queued = { ...raw, id: 'y', status: 'queued', remoteId: null } as Take
    useRuns.setState({ takes: [raw, queued] })
    useRuns.getState().enqueue(['s1']) // starts the engine (a dev take of this build)
    await vi.advanceTimersByTimeAsync(1000)
    expect(take('x')).toMatchObject({ status: 'failed', foreignStatus: 'processing', remoteId: 'job-x' })
    expect(take('y')).toMatchObject({ status: 'failed', foreignStatus: 'queued' })
    expect(f.submitted).toEqual([]) // the mock provider never saw them
    expect(dev.submitted.map((r) => r.sceneCode)).toEqual(['S01']) // this build's own take ran as usual
  })
})

describe('takes of a newer build’s model on a provider this build knows (foreignModel)', () => {
  const kling = { model: 'kling_3', mode: 't2v', duration: 10, resolution: '1080p', ratio: '16:9' }
  const newerModelTake = (id: string, status: Take['status'], over: Record<string, unknown> = {}) =>
    ({ ...legacyTake(id, 's2'), status, provider: 'canvasapp', remoteId: null, charged: true, settings: kling, ...over }) as unknown as Take

  it('loaded queued / running (no remote id yet): parked, never submitted, looked up or failed over it', async () => {
    const canvas = fakeProvider('canvasapp')
    const recovered: JobRequest[] = []
    canvas.p.recover = async (req) => (recovered.push(req), null)
    registerProvider(canvas.p)
    useRuns.getState().loadRuns({ takes: [newerModelTake('q', 'queued'), newerModelTake('p', 'processing', { startedAt: 5 })], credits: 100, spent: 0 })
    for (const id of ['q', 'p']) {
      expect(take(id)).toMatchObject({ status: 'failed', foreignStatus: id === 'q' ? 'queued' : 'processing', foreignModel: 'kling_3', provider: 'canvasapp' })
    }
    await vi.advanceTimersByTimeAsync(2000)
    expect(canvas.submitted).toEqual([])
    expect(recovered).toEqual([])
    expect(canvas.polls()).toBe(0)
    expect(useRuns.getState()).toMatchObject({ credits: 100, spent: 0 })
  })

  it('backstop: a take with an unknown model that reaches the engine is never sent (failed before the provider sees it)', async () => {
    const dev = fakeProvider('dev')
    registerProvider(dev.p)
    // no marker (as if it never went through migrate): the engine itself refuses it
    useRuns.setState({ takes: [{ ...newerModelTake('z', 'queued'), provider: 'dev' } as Take] })
    useRuns.getState().enqueue(['s1'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(take('z')).toMatchObject({ status: 'failed' })
    expect(take('z').error).toContain('Model của video này không có trong bản SanoVids này')
    expect(dev.submitted.map((r) => r.model)).toEqual(['seedance_2_5']) // only this build's own take
  })

  it('"Dọn job lỗi/đã huỷ" never deletes a parked take of a newer build (it may still be running — and paid — there)', () => {
    useRuns.getState().loadRuns({
      takes: [
        newerModelTake('parked', 'processing', { remoteId: 'prj:job' }),
        { ...legacyTake('f', 's2'), status: 'failed', error: 'boom' },
        { ...legacyTake('c', 's2'), status: 'cancelled' },
        { ...legacyTake('done', 's2'), status: 'completed' },
        { ...legacyTake('newerDone', 's2'), status: 'failed', provider: 'seedvis' } as unknown as Take, // failed there: an ordinary failed take
      ],
      credits: 100,
      spent: 0,
    })
    expect(take('parked')).toMatchObject({ status: 'failed', foreignStatus: 'processing' })
    expect(isParkedTake(take('parked'))).toBe(true)
    expect(clearableTakes(useRuns.getState().takes).map((t) => t.id)).toEqual(['f', 'c', 'newerDone'])
  })

  it('backstop: a running one without a remote id is parked, never looked up', async () => {
    const canvas = fakeProvider('canvasapp')
    const recovered: JobRequest[] = []
    canvas.p.recover = async (req) => (recovered.push(req), null)
    registerProvider(canvas.p)
    const dev = fakeProvider('dev')
    registerProvider(dev.p)
    useRuns.setState({ takes: [newerModelTake('r', 'processing', { startedAt: 5 })] })
    useRuns.getState().enqueue(['s1'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(recovered).toEqual([])
    expect(take('r')).toMatchObject({ status: 'failed', foreignStatus: 'processing', foreignModel: 'kling_3' })
  })
})
