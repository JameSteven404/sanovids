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
import type { FetchResultOptions, JobRequest, RemoteStatus, RunTake, SettingsLimits, VideoProvider } from '../types'
import { transferLabel, useTakeTransfers } from '../../store/takeTransfers'
import type { VideoSettings } from '../../core/types'
import { useProject } from '../../store/project'
import { remoteVideoReady, setEngineHooks, setEngineLockManager, UNKNOWN_SUBMIT_ERROR, useRuns } from '../../store/runs'
import type { LockManagerLike } from '../../store/engineLock'
import { capabilitiesFromModels } from '../capabilities'
import { NO_VIDEO_REFS_REASON } from '../../core/runGate'

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

/** A finished take of scene s1 (usable as a reference video). */
const finishedTake = (id: string): Take => ({
  id,
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
    // the take's own project + scene (the canvasapp gateway names its bridge node after them)
    expect(f.submitted[0]).toMatchObject({ sceneId: 's1', sanovidsProjectId: 'p' })

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
    useRuns.setState({ takes: [finishedTake('tk')] })
    useProject.getState().loadProject({ ...project(), scenes: [scene('s1', 1), scene('s2', 2, { videoRefs: ['tk'], prompt: '@video_1 again' })] })
    const [c] = useRuns.getState().check(['s2'])
    expect(c.ok).toBe(false)
    expect(c.reason).toBe(NO_VIDEO_REFS_REASON)
  })

  describe('what the gateway runs now (settingsLimits): a sure refusal skips, a guess only warns', () => {
    const H3: VideoSettings = { model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' }
    const LOCKED = 'MiniMax-H3 hiện không khả dụng trên canvasapp.'
    const limitsOf = (source: SettingsLimits['source'], firm: boolean): SettingsLimits => ({
      source,
      firm,
      issues: (s) => (source !== 'none' && s.model === 'minimax_h3' ? [{ field: 'model', reason: LOCKED }] : []),
    })
    const withLimits = (limits: SettingsLimits) => {
      const f = fakeProvider('dev')
      registerProvider({ ...f.p, settingsLimits: () => limits })
      useProject.getState().loadProject({ ...project(), scenes: [scene('s1', 1, { refs: ['a'], prompt: '@image_1 runs', settings: H3 }), scene('s2', 2)] })
      return f
    }

    it('a firm read: the scene is skipped with the reason (no final period), nothing is sent; all refused → error', async () => {
      const f = withLimits(limitsOf('server', true))
      const [h3, sd] = useRuns.getState().check(['s1', 's2'])
      expect(h3).toMatchObject({ ok: false, reason: 'MiniMax-H3 hiện không khả dụng trên canvasapp', warnings: [] })
      expect(sd).toMatchObject({ ok: true, reason: null })
      expect(useRuns.getState().enqueue(['s1'])).toEqual({ queued: 0, cost: 0, skipped: [{ sceneId: 's1', reason: h3.reason }], error: 'Không có cảnh nào chạy được.' })
      expect(useRuns.getState().enqueue(['s1', 's2'])).toMatchObject({ queued: 1, skipped: [{ sceneId: 's1' }] })
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.submitted.map((r) => r.sceneId)).toEqual(['s2'])
    })

    it('the scene’s own problems come first (an empty prompt says so, not the gateway)', () => {
      withLimits(limitsOf('server', true))
      useProject.getState().loadProject({ ...project(), scenes: [scene('s1', 1, { prompt: '  ', settings: H3 })] })
      expect(useRuns.getState().check(['s1'])[0].reason).toBe('Prompt trống')
    })

    it.each([
      ['an older read (not firm)', limitsOf('server', false), /theo lần đọc cấu hình model trước/],
      ['canvasapp’s fallbacks (unreadable)', limitsOf('fallback', false), /chưa đọc được cấu hình model/],
    ])('%s: runnable, with a "Có thể bị từ chối" warning (the submit reads again and decides)', async (_name, limits, why) => {
      const f = withLimits(limits)
      const [h3, sd] = useRuns.getState().check(['s1', 's2'])
      expect(h3.ok).toBe(true)
      expect(h3.warnings).toHaveLength(1)
      expect(h3.warnings[0]).toMatch(/^Có thể bị từ chối khi gửi \(không tốn credit\): MiniMax-H3 hiện không khả dụng trên canvasapp — /)
      expect(h3.warnings[0]).toMatch(why)
      expect(sd.warnings).toEqual([])
      expect(useRuns.getState().enqueue(['s1']).queued).toBe(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.submitted).toHaveLength(1)
    })

    it('nothing known ("none") or a provider without settingsLimits: as before', () => {
      withLimits(limitsOf('none', false))
      expect(useRuns.getState().check(['s1'])[0]).toMatchObject({ ok: true, warnings: [] })
      registerProvider(fakeProvider('dev').p)
      expect(useRuns.getState().check(['s1'])[0]).toMatchObject({ ok: true, warnings: [] })
    })

    it('retry() of an "unknown" take is never held back (it may only find the job it already has)', () => {
      withLimits(limitsOf('server', true))
      const unknown: Take = { ...finishedTake('u1'), sceneId: 's1', status: 'failed', videoId: null, error: UNKNOWN_SUBMIT_ERROR, provider: 'dev', remoteId: null, submitUnknown: true, settings: H3 }
      useRuns.setState({ takes: [unknown] })
      expect(useRuns.getState().retry('u1')).toMatchObject({ queued: 1, skipped: [] })
      expect(useRuns.getState().takes).toHaveLength(1)
      expect(useRuns.getState().takes[0]).toMatchObject({ id: 'u1', status: 'queued' })
    })
  })

  describe('@video: one gate (the gateway’s capabilities().maxRefVideos), only for videos really sent', () => {
    const load = (...scenes: Scene[]) => {
      useRuns.setState({ takes: [finishedTake('tk')] })
      useProject.getState().loadProject({ ...project(), scenes })
    }

    it('development mode: the reason names development mode (never "Cổng canvasapp chưa…" alone); nothing is submitted', async () => {
      const f = fakeProvider('dev')
      registerProvider(f.p)
      load(scene('s1', 1, { videoRefs: ['tk'], prompt: '@video_1 again' }), scene('s2', 2, { videoRefs: ['tk'], prompt: 'token removed' }))
      const checks = useRuns.getState().check(['s1', 's2'])
      // removing the @video token alone does not unblock: the reference itself is what would be sent
      expect(checks.map((c) => c.reason)).toEqual([NO_VIDEO_REFS_REASON, NO_VIDEO_REFS_REASON])
      expect(checks[0].reason).not.toMatch(/^Cổng canvasapp chưa/)
      const r = useRuns.getState().enqueue(['s1', 's2'])
      expect(r).toMatchObject({ queued: 0, skipped: [{ sceneId: 's1', reason: NO_VIDEO_REFS_REASON }, { sceneId: 's2', reason: NO_VIDEO_REFS_REASON }] })
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.submitted).toEqual([])
    })

    it('a gateway that takes videos (cap from capabilities) lets the same scene through', () => {
      const f = fakeProvider('dev')
      registerProvider({ ...f.p, capabilities: (m) => capabilitiesFromModels(m, { maxConcurrency: 2, pollIntervalMs: 0, maxRefVideos: 1 }) })
      load(scene('s1', 1, { videoRefs: ['tk'], prompt: '@video_1 again' }))
      expect(useRuns.getState().check(['s1'])[0]).toMatchObject({ ok: true, reason: null })
    })

    it('H3 t2v / transform with leftover references and no @video token run, and send no video', async () => {
      const f = fakeProvider('dev')
      registerProvider({ ...f.p, capabilities: (m) => capabilitiesFromModels(m, { maxConcurrency: 3, pollIntervalMs: 0, maxRefVideos: 0 }) })
      load(
        scene('s1', 1, { videoRefs: ['tk'], settings: { model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '768p', ratio: '16:9' } }),
        scene('s2', 2, {
          videoRefs: ['tk'],
          settings: { model: 'minimax_h3', mode: 'transform', duration: 5, resolution: '768p', ratio: '16:9' },
          firstFrame: 'a',
          lastFrame: 'a',
        }),
        // a leftover reference to a deleted take is not sent either: pinned as runnable
        scene('s3', 3, { videoRefs: ['deleted'], settings: { model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '768p', ratio: '16:9' } }),
      )
      expect(useRuns.getState().check(['s1', 's2', 's3']).map((c) => c.reason)).toEqual([null, null, null])
      const r = useRuns.getState().enqueue(['s1', 's2', 's3'])
      expect(r.queued).toBe(3)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.submitted).toHaveLength(3)
      for (const req of f.submitted) expect(req.videos).toEqual([])
    })
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

describe('runs engine: downloading a finished video (abort, progress, refusals)', () => {
  /** A dev take that is processing on the fake provider, its job finished: the engine downloads it on the next tick. */
  async function finished(f: ReturnType<typeof fakeProvider>) {
    registerProvider(f.p)
    useRuns.getState().enqueue(['s2'])
    const id = useRuns.getState().takes[0].id
    await vi.advanceTimersByTimeAsync(250)
    f.statuses.set('r_' + id, { remoteId: 'r_' + id, state: 'completed', progress: 100 })
    return id
  }
  /** fetchResult that waits until settled by hand (and records the options it got). */
  function manualFetch(f: ReturnType<typeof fakeProvider>) {
    const calls: { opts: FetchResultOptions | undefined; resolve: () => void; reject: (e: unknown) => void }[] = []
    f.p.fetchResult = (_rid, opts) =>
      new Promise((resolve, reject) => calls.push({ opts, resolve: () => resolve({ video: new Blob(['v'], { type: 'video/mp4' }), poster: new Blob(['p']) }), reject }))
    return calls
  }

  it('passes a signal and a progress callback; progress shows as "Đang tải về …" and is cleared when it completes', async () => {
    const f = fakeProvider('dev')
    const calls = manualFetch(f)
    const id = await finished(f)
    await vi.advanceTimersByTimeAsync(250)
    expect(calls).toHaveLength(1)
    expect(calls[0].opts?.signal).toBeInstanceOf(AbortSignal)
    calls[0].opts!.onProgress!({ received: 45, total: 100 })
    expect(transferLabel(useTakeTransfers.getState().byTake[id])).toBe('Đang tải về 45%')
    calls[0].resolve()
    await vi.advanceTimersByTimeAsync(250)
    expect(take(id).status).toBe('completed')
    expect(useTakeTransfers.getState().byTake).toEqual({})
  })

  it('cancel() aborts the download; the aborted fetch is not a failure (no retry counted, take stays cancelled)', async () => {
    const f = fakeProvider('dev')
    const calls = manualFetch(f)
    const id = await finished(f)
    await vi.advanceTimersByTimeAsync(250)
    calls[0].opts!.onProgress!({ received: 10, total: null })
    useRuns.getState().cancel(id)
    expect(calls[0].opts!.signal!.aborted).toBe(true)
    calls[0].reject(Object.assign(new Error('Đã dừng tải video.'), { code: 'aborted' }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(take(id)).toMatchObject({ status: 'cancelled', error: 'Đã huỷ' })
    expect(calls).toHaveLength(1)
    expect(useTakeTransfers.getState().byTake).toEqual({})
  })

  it('a video over the size cap fails the take at once (paid wording), never five tries', async () => {
    const f = fakeProvider('dev')
    let tries = 0
    f.p.fetchResult = async () => {
      tries++
      throw Object.assign(new Error('Video lớn hơn 1 GB — SanoVids không tải về máy được.'), { code: 'too-large' })
    }
    const id = await finished(f)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(take(id).status).toBe('failed')
    expect(take(id).error).toContain('đã trừ credit dev')
    expect(take(id).error).toContain('Video lớn hơn 1 GB')
    expect(tries).toBe(1)
  })

  it('a download that outlived the gateway’s time limit and could not continue (too-slow) fails at once — no new try from 0', async () => {
    const f = fakeProvider('dev')
    let tries = 0
    f.p.fetchResult = async () => {
      tries++
      throw Object.assign(new Error('Tải video quá 60 phút nên SanoVids dừng lại.'), { code: 'too-slow' })
    }
    const id = await finished(f)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(take(id).status).toBe('failed')
    expect(take(id).error).toContain('đã trừ credit dev')
    expect(take(id).error).toContain('Tải video quá 60 phút')
    expect(tries).toBe(1)
  })

  it('remoteVideoReady: only once the job is finished — while it downloads and while it waits for the next try', async () => {
    const f = fakeProvider('dev')
    const calls = manualFetch(f)
    registerProvider(f.p)
    useRuns.getState().enqueue(['s2'])
    const id = useRuns.getState().takes[0].id
    expect(remoteVideoReady(id)).toBe(false) // queued
    await vi.advanceTimersByTimeAsync(250)
    expect(take(id).status).toBe('processing')
    expect(remoteVideoReady(id)).toBe(false) // the job still runs on the site
    f.statuses.set('r_' + id, { remoteId: 'r_' + id, state: 'completed', progress: 100 })
    await vi.advanceTimersByTimeAsync(250)
    expect(calls).toHaveLength(1)
    expect(remoteVideoReady(id)).toBe(true) // downloading
    calls[0].reject(Object.assign(new Error('Mất kết nối khi đang tải video.'), { code: 'network' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(take(id).status).toBe('processing')
    expect(remoteVideoReady(id)).toBe(true) // waiting for the next try: the video exists all the same
    await vi.advanceTimersByTimeAsync(31_000)
    expect(calls).toHaveLength(2)
    calls[1].resolve()
    await vi.advanceTimersByTimeAsync(250)
    expect(take(id).status).toBe('completed')
    expect(remoteVideoReady(id)).toBe(false)
  })

  it('"too many downloads at once" (deferred) is never counted as a failed try: five of them never fail the take', async () => {
    const f = fakeProvider('dev')
    let tries = 0
    f.p.fetchResult = async () => {
      tries++
      if (tries <= 6) throw Object.assign(new Error('Đang tải quá nhiều video cùng lúc — SanoVids tải video này sau.'), { code: 'deferred' })
      return { video: new Blob(['v'], { type: 'video/mp4' }), poster: new Blob(['p']) }
    }
    const id = await finished(f)
    await vi.advanceTimersByTimeAsync(6 * 16_000)
    expect(tries).toBe(7)
    expect(take(id).status).toBe('completed')
  })

  it('reloading the same project mid-download: the old download is aborted, and its late end never touches the new one', async () => {
    const f = fakeProvider('dev')
    const calls = manualFetch(f)
    const id = await finished(f)
    await vi.advanceTimersByTimeAsync(250)
    expect(calls).toHaveLength(1)
    useRuns.getState().loadRuns({ takes: useRuns.getState().takes, credits: 100, spent: 0 }) // persist reload, same project
    expect(calls[0].opts!.signal!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(calls).toHaveLength(2) // downloaded again by the restarted engine
    calls[1].opts!.onProgress!({ received: 30, total: 100 })
    calls[0].reject(Object.assign(new Error('Đã dừng tải video.'), { code: 'aborted' })) // the old one ends late
    await vi.advanceTimersByTimeAsync(0)
    expect(transferLabel(useTakeTransfers.getState().byTake[id])).toBe('Đang tải về 30%') // not cleared by the old one
    useRuns.getState().cancel(id)
    expect(calls[1].opts!.signal!.aborted).toBe(true) // its controller is still the one cancel() reaches
    calls[1].reject(new Error('aborted'))
    await vi.advanceTimersByTimeAsync(0)
    expect(take(id).status).toBe('cancelled')
  })

  it('a failed download clears its progress; the take keeps waiting at 99 % for the next try', async () => {
    const f = fakeProvider('dev')
    const calls = manualFetch(f)
    const id = await finished(f)
    await vi.advanceTimersByTimeAsync(250)
    calls[0].opts!.onProgress!({ received: 10, total: 100 })
    calls[0].reject(Object.assign(new Error('Mất kết nối khi đang tải video.'), { code: 'network' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(useTakeTransfers.getState().byTake).toEqual({})
    expect(take(id)).toMatchObject({ status: 'processing', progress: 99 })
  })
})
