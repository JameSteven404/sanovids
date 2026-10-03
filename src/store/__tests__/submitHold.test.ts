// store/runs holdNewSubmits / sendingCount (used by updateActions before restarting to install an app update):
// while held, queued takes are not sent, but running takes keep being polled; sendingCount counts the submits in flight.
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
import type { JobRequest, RemoteStatus, VideoProvider } from '../../providers/types'
import { useProject } from '../project'
import { currentRestartWork, holdNewSubmits, restartWork, sendingCount, setEngineHooks, setEngineLockManager, useRuns } from '../runs'

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

function fakeDevProvider() {
  const statuses = new Map<string, RemoteStatus>()
  const submitted: JobRequest[] = []
  let polls = 0
  const p: VideoProvider = {
    id: 'dev',
    label: 'dev',
    minPollIntervalMs: 0,
    available: async () => ({ ok: true }),
    capabilities: (m) => capabilitiesFromModels(m, { maxConcurrency: 2, pollIntervalMs: 0, maxRefVideos: 0 }),
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
  }
  return { p, statuses, submitted, polls: () => polls }
}

const realDev = getProvider('dev')
const take = (id: string) => useRuns.getState().takes.find((t) => t.id === id) as Take

beforeEach(() => {
  setEngineLockManager(null)
  setEngineHooks({})
  vi.useFakeTimers()
  useProject.getState().loadProject(project())
  useRuns.getState().loadRuns({ takes: [], credits: 100, spent: 0 })
})
afterEach(() => {
  holdNewSubmits(false)
  useRuns.getState().loadRuns({ takes: [], credits: 100, spent: 0 })
  vi.advanceTimersByTime(250)
  vi.useRealTimers()
  registerProvider(realDev)
  useProviderPrefs.setState({ provider: 'dev' })
})
afterAll(() => {
  registerProvider(realDev)
  setEngineLockManager(undefined)
  setEngineHooks({})
})

describe('holdNewSubmits', () => {
  it('queued takes wait while held; running takes keep being polled; released → sent', async () => {
    const f = fakeDevProvider()
    registerProvider(f.p)
    useRuns.getState().enqueue(['s1'])
    const first = useRuns.getState().takes[0].id
    await vi.advanceTimersByTimeAsync(250)
    expect(take(first)).toMatchObject({ status: 'processing', remoteId: 'r_' + first })

    holdNewSubmits(true)
    useRuns.getState().enqueue(['s2'])
    const second = useRuns.getState().takes.find((t) => t.id !== first)!.id
    f.statuses.set('r_' + first, { remoteId: 'r_' + first, state: 'processing', progress: 40 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(take(second).status).toBe('queued')
    expect(f.submitted).toHaveLength(1)
    expect(take(first).progress).toBe(40) // polling goes on
    expect(f.polls()).toBeGreaterThan(0)

    holdNewSubmits(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(take(second).status).toBe('processing')
    expect(f.submitted).toHaveLength(2)
  })
})

describe('sendingCount', () => {
  it('counts running remote takes without a remote id (old demo takes never count)', () => {
    const t = (id: string, patch: Partial<Take>): Take => ({
      id,
      sceneId: 's1',
      number: 1,
      status: 'processing',
      progress: 1,
      createdAt: 1,
      startedAt: 1,
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
      provider: 'dev',
      remoteId: null,
      charged: false,
      ...patch,
    })
    useRuns.setState({
      takes: [
        t('a', {}),
        t('b', { remoteId: 'r_b' }),
        t('c', { provider: 'mock' }),
        t('d', { status: 'queued' }),
        t('e', { provider: 'canvasapp' }),
      ],
    })
    expect(sendingCount()).toBe(2)
    useRuns.setState({ takes: [] })
    expect(sendingCount()).toBe(0)
  })
})

describe('restartWork', () => {
  it('counts running takes and the queued takes the queue will start (not those of deleted scenes)', () => {
    const t = (id: string, sceneId: string, status: Take['status'], patch: Partial<Take> = {}): Take =>
      ({ ...useRuns.getState().takes[0], id, sceneId, status, provider: 'dev', remoteId: null, ...patch }) as Take
    const takes = [
      t('a', 's1', 'processing'), // being sent (no remote id yet)
      t('b', 's1', 'processing', { remoteId: 'r_b' }),
      t('c', 's2', 'queued'),
      t('d', 'gone', 'queued'), // its scene was deleted: waits for an Undo, survives a restart
      t('e', 'gone', 'processing', { remoteId: 'r_e' }), // already running: still counted
      t('f', 's1', 'completed'),
      t('g', 's1', 'failed'),
    ]
    expect(restartWork(takes, new Set(['s1', 's2']))).toEqual({ queued: 1, processing: 3, sending: 1 })
    useRuns.setState({ takes })
    expect(currentRestartWork()).toEqual({ queued: 1, processing: 3, sending: 1 })
    useRuns.setState({ takes: [] })
    expect(currentRestartWork()).toEqual({ queued: 0, processing: 0, sending: 0 })
  })
})
