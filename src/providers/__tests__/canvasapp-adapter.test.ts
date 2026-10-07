import { describe, expect, it, vi } from 'vitest'
import {
  createCanvasappApi,
  CanvasappError,
  errorFromResponse,
  NOT_ENOUGH_CREDITS_TEXT,
  requestLabel,
  type CanvasPayload,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../canvasapp/api'
import {
  CANVAS_NOT_SAVED_TEXT,
  createCanvasappProvider,
  JOBS_KEY,
  LEDGER_NOT_SAVED_TEXT,
  LIST_FIRST_TEXT,
  LIST_NEEDED_AFTER_LOST_TEXT,
  LIST_NEEDED_TEXT,
  LOOKUP_FAILED_TEXT,
  memoryStorage,
  MIN_POLL_MS,
  type KeyValueStorage,
  PROFILES_FALLBACK_TEXT,
  PROFILES_FORCE_MIN_MS,
  PROFILES_RETRY_MS,
  PROFILES_TTL_MS,
  RIVAL_PENDING_TEXT,
  STATE_KEY,
  STILL_SENDING_TEXT,
  type SiteScanInput,
} from '../canvasapp/adapter'
import type { SiteJobClaim } from '../canvasapp/siteJobs'
import {
  BRIDGE_PROJECT_NAME,
  bridgeEntriesFrom,
  canvasNodeId,
  clientRequestIdFor,
  isUuid,
  MAX_BRIDGE_NODES,
  parseSceneNodeKey,
  sceneNodeId,
  sceneNodeKey,
} from '../canvasapp/mapping'
import { createDesktopTransport, type CanvasappBridge } from '../canvasapp/transport'
import { CANVASAPP_MAX_REF_VIDEOS } from '../capabilities'
import { MODELS } from '../../core/models'
import type { VideoSettings } from '../../core/types'
import { isRecoverNotSent, isSubmitHeldBack, NO_LIMITS, type JobRequest } from '../types'

type Handler = (req: TransportRequest) => TransportResponse | undefined

const json = (body: unknown, status = 200): TransportResponse => ({ status, contentType: 'application/json', json: body })

/** In-memory fake of the canvasapp endpoints SanoVids uses. Records every call. */
function fakeServer(opts: { authenticated?: boolean; projects?: { project_id: string; name: string }[] } = {}) {
  const calls: TransportRequest[] = []
  const state = {
    authenticated: opts.authenticated ?? true,
    projects: [...(opts.projects ?? [])],
    uploads: 0,
    canvases: new Map<string, unknown>(),
    jobs: [] as {
      job_id: string
      status: string
      progress?: number
      download_available?: boolean
      project_id: string
      canvas_node_id?: string
      created_at?: string
      // a job made on canvasapp's own page lists these too (siteJob in the "Nhập job" tests)
      model_profile?: string
      duration?: number
      aspect_ratio?: string | null
      creation_mode?: string
      body: Record<string, unknown>
    }[],
    extra: null as Handler | null,
    /** The server's clock (created_at of new jobs). */
    now: () => 1_000_000,
    /** How created_at is written (default ISO with 'Z'). */
    stamp: (ms: number): string => new Date(ms).toISOString(),
    /** Same client_request_id → the same job (no second one). */
    dedupe: false,
    /** POST /api/video-jobs answers lost AFTER the server handled them (timeout / connection reset). */
    loseAnswers: 0,
    /** POST /api/video-jobs requests that never reach the server (connection refused). */
    unreachablePosts: 0,
  }
  const transport: Transport = {
    available: async () => ({ ok: true }),
    request: async (req) => {
      calls.push(req)
      const extra = state.extra?.(req)
      if (extra) return extra
      const post = req.method === 'POST' && req.path === '/api/video-jobs'
      if (post && state.unreachablePosts > 0) {
        state.unreachablePosts--
        throw new Error('connection refused')
      }
      const res = handle(req)
      if (post && state.loseAnswers > 0) {
        state.loseAnswers--
        throw new Error('timeout')
      }
      return res
    },
  }
  function handle(req: TransportRequest): TransportResponse {
    if (!state.authenticated && req.path !== '/api/auth/state') return json({ detail: 'Not authenticated' }, 401)
    const [path, query] = req.path.split('?')
    if (path === '/api/auth/state') return json({ authenticated: state.authenticated })
    if (path === '/api/me') return json({ credits_balance: 120 })
    if (path === '/api/video-profiles') return json({ profiles: [{ model_profile: 'seedance_2_5', options: { durations: [5, 10, 15, 30] } }] })
    if (path === '/api/projects' && req.method === 'GET') return json(state.projects)
    if (path === '/api/projects' && req.method === 'POST') {
      // canvasapp's page posts no body and gets a default name ("Phiên mới")
      const p = { project_id: 'proj' + (state.projects.length + 1), name: 'Phiên mới' }
      state.projects.push(p)
      return json({ project_id: p.project_id })
    }
    const one = /^\/api\/projects\/([^/]+)$/.exec(path)
    if (one && req.method === 'GET') {
      const p = state.projects.find((x) => x.project_id === one[1])
      return p ? json({ ...p, canvas: state.canvases.get(p.project_id) ?? { nodes: [], connections: [], viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 } } }) : json({ detail: 'Project not found' }, 404)
    }
    if (one && req.method === 'PATCH') {
      const p = state.projects.find((x) => x.project_id === one[1])
      if (!p) return json({ detail: 'Project not found' }, 404)
      p.name = String((req.json as { name?: unknown }).name)
      return json({ ok: true })
    }
    const canvas = /^\/api\/projects\/([^/]+)\/canvas$/.exec(path)
    if (canvas && req.method === 'PUT') {
      if (!state.projects.some((p) => p.project_id === canvas[1])) return json({ detail: 'Project not found' }, 404)
      state.canvases.set(canvas[1], req.json)
      return json({ ok: true })
    }
    if (path === '/api/uploads/images') {
      state.uploads++
      return json({ upload_id: 'up' + state.uploads })
    }
    if (path === '/api/video-jobs' && req.method === 'POST') {
      const body = req.json as Record<string, unknown>
      const dup = state.dedupe ? state.jobs.find((j) => j.body.client_request_id === body.client_request_id) : undefined
      if (dup) return json({ job_id: dup.job_id })
      const job = {
        job_id: 'job' + (state.jobs.length + 1),
        status: 'queued',
        project_id: String(body.project_id),
        canvas_node_id: String(body.canvas_node_id),
        created_at: state.stamp(state.now()),
        body,
      }
      state.jobs.push(job)
      return json({ job_id: job.job_id })
    }
    if (path === '/api/video-jobs' && req.method === 'GET') {
      const pid = new URLSearchParams(query).get('project_id')
      return json(state.jobs.filter((j) => j.project_id === pid).map(({ body: _b, ...j }) => j))
    }
    const prompt = /^\/api\/video-jobs\/([^/]+)\/prompt$/.exec(path)
    if (prompt) {
      const j = state.jobs.find((x) => x.job_id === prompt[1])
      return j ? json({ prompt: j.body.prompt }) : json({ detail: 'Job not found' }, 404)
    }
    const stream = /^\/api\/video-jobs\/([^/]+)\/stream$/.exec(path)
    if (stream) return { status: 200, contentType: 'video/mp4', bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]) }
    return json({ detail: 'nope' }, 404)
  }
  return { transport, calls, state }
}

/**
 * The adapter's waits after an unanswered POST, released by the test (`wakers`): a wait of `ms` ends at clock + ms —
 * or later, when the test moved the clock past that meanwhile.
 */
function heldSleep(clock: { t: number }, wakers: (() => void)[]) {
  return (ms: number) => {
    const until = clock.t + ms
    return new Promise<void>((resolve) =>
      void wakers.push(() => {
        if (clock.t < until) clock.t = until
        resolve()
      }),
    )
  }
}

const blobs: Record<string, Blob> = {
  img_a: new Blob(['a'], { type: 'image/png' }),
  img_b: new Blob(['b'], { type: 'image/jpeg' }),
  img_gif: new Blob(['g'], { type: 'image/gif' }),
}

const req = (over: Partial<JobRequest> = {}): JobRequest => ({
  key: 'take_1',
  takeId: 'take_1',
  sceneId: 'scene_a',
  sanovidsProjectId: 'prj_a',
  sceneCode: 'S01',
  takeNumber: 1,
  title: '',
  color: '#fff',
  model: 'seedance_2_5',
  mode: 't2v',
  duration: 15,
  resolution: '1080p',
  ratio: '16:9',
  prompt: '@image_1 and @image_2',
  rawPrompt: '@image_1 and @image_2',
  images: [
    { n: 1, assetId: 'a', imageId: 'img_a' },
    { n: 2, assetId: 'b', imageId: 'img_b' },
  ],
  videos: [],
  firstFrame: null,
  lastFrame: null,
  startedAt: 0,
  ...over,
})

function setup(server = fakeServer(), clock = { t: 1_000_000 }, sizes: Record<string, { width: number; height: number } | null> = {}) {
  const storage = memoryStorage()
  server.state.now = () => clock.t
  const provider = createCanvasappProvider({
    api: createCanvasappApi(server.transport),
    getBlob: async (id) => blobs[id] ?? null,
    storage,
    now: () => clock.t,
    imageSize: async (blob) => {
      const content = await blob.text()
      return content in sizes ? sizes[content] : { width: 1920, height: 1080 }
    },
  })
  return { provider, server, storage, clock }
}

const isPut = (r: TransportRequest) => r.method === 'PUT' && /\/canvas$/.test(r.path)
const uploadsIn = (r: TransportRequest) => (r.json as CanvasPayload).nodes.flatMap((n) => (n.type === 'images' ? n.data.upload_ids : []))
/** Keys of the remembered bridge entries, as stored (node keys; a bare scene id = a legacy entry). */
const rawEntries = (storage: ReturnType<typeof memoryStorage>) => Object.keys(JSON.parse(storage.get(STATE_KEY)!).entries)
/** ...as scene ids. */
const savedEntries = (storage: ReturnType<typeof memoryStorage>) => rawEntries(storage).map((k) => parseSceneNodeKey(k)?.sceneId ?? k)
/** Canvas node id of a scene of req()'s project ('prj_a'). */
const node = (sceneId: string) => sceneNodeId('prj_a', sceneId)
const videosOf = (c: unknown) => (c as CanvasPayload).nodes.filter((n) => n.type === 'video').map((n) => n.id)
const jobPosts = (server: ReturnType<typeof fakeServer>) => server.calls.filter((c) => c.method === 'POST' && c.path === '/api/video-jobs')
const h3Profiles = (over: Record<string, unknown> = {}) =>
  json({
    profiles: [
      { model_profile: 'seedance_2_5', can_create: true },
      { model_profile: 'minimax_h3', display_name: 'MiniMax-H3', enabled: true, can_create: true, options: { disabled_modes: [] }, ...over },
    ],
  })
const transformReq = (over: Partial<JobRequest> = {}) =>
  req({
    model: 'minimax_h3',
    mode: 'transform',
    duration: 5,
    resolution: '768p',
    prompt: 'biến hình',
    images: [],
    firstFrame: { assetId: 'a', imageId: 'img_a' },
    lastFrame: { assetId: 'b', imageId: 'img_b' },
    ...over,
  })

describe('canvasapp adapter', () => {
  it('creates the bridge project once, uploads images once, saves the canvas, then posts the job', async () => {
    const { provider, server, storage } = setup()
    const { remoteId } = await provider.submit(req())
    expect(remoteId).toBe('proj1:job1')
    expect(server.state.projects).toEqual([{ project_id: 'proj1', name: BRIDGE_PROJECT_NAME }])
    expect(server.state.uploads).toBe(2)

    // created like canvasapp's page does: empty POST, then PATCH {name}
    const create = server.calls.find((c) => c.method === 'POST' && c.path === '/api/projects')!
    expect(create.json).toBeUndefined()
    expect(server.calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/projects/proj1', json: { name: BRIDGE_PROJECT_NAME } })

    const job = server.state.jobs[0].body
    expect(job.upload_ids).toEqual(['up1', 'up2'])
    expect(job.client_request_id).toBe(clientRequestIdFor('take_1'))
    expect(isUuid(job.client_request_id)).toBe(true)
    expect(job.canvas_node_id).toBe(node('scene_a'))
    expect(isUuid(job.canvas_node_id)).toBe(true)
    // the canvas was saved BEFORE the job and contains that node id
    const order = server.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)
    expect(order.indexOf('PUT /api/projects/proj1/canvas')).toBeLessThan(order.indexOf('POST /api/video-jobs'))
    const canvas = server.state.canvases.get('proj1') as { nodes: { id: string }[] }
    expect(canvas.nodes.some((n) => n.id === node('scene_a'))).toBe(true)
    expect(rawEntries(storage)).toEqual([sceneNodeKey('prj_a', 'scene_a')])

    // second take of another scene with the same images: no new upload, no new project
    await provider.submit(req({ key: 'take_2', takeId: 'take_2', sceneId: 'scene_b' }))
    expect(server.state.uploads).toBe(2)
    expect(server.state.projects.length).toBe(1)
    expect(server.state.jobs[1].body.upload_ids).toEqual(['up1', 'up2'])
    expect(JSON.parse(storage.get(STATE_KEY)!).projectId).toBe('proj1')
  })

  it('reuses an existing "SanoVids bridge" project and the remembered state after a restart', async () => {
    const server = fakeServer({ projects: [{ project_id: 'old', name: BRIDGE_PROJECT_NAME }] })
    const first = setup(server)
    await first.provider.submit(req())
    expect(server.state.projects.length).toBe(1)
    const listCalls = server.calls.filter((c) => c.method === 'GET' && c.path === '/api/projects').length

    const again = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage: first.storage })
    await again.submit(req({ key: 'take_9', takeId: 'take_9' }))
    expect(server.calls.filter((c) => c.method === 'GET' && c.path === '/api/projects').length).toBe(listCalls)
    expect(server.state.uploads).toBe(2)
  })

  it('a failed rename does not stop the submit (the project id is remembered)', async () => {
    const server = fakeServer()
    server.state.extra = (r) => (r.method === 'PATCH' ? json({ detail: 'nope' }, 500) : undefined)
    const { provider } = setup(server)
    expect((await provider.submit(req())).remoteId).toBe('proj1:job1')
    expect(provider.bridgeProjectId()).toBe('proj1')
  })

  it('state saved by v0.2.0 (old entries, "sv_" node ids in the ledger) is rebuilt, never sent as is', async () => {
    const server = fakeServer({ projects: [{ project_id: 'old', name: BRIDGE_PROJECT_NAME }] })
    const storage = memoryStorage()
    const oldEntry = {
      sceneId: 'scene_z',
      label: 'S09 · T1',
      model: 'seedance_2_5',
      mode: 't2v',
      duration: 5,
      resolution: '480p',
      ratio: '16:9',
      prompt: 'old',
      uploadIds: ['upOld'],
      firstFrameUploadId: null,
      lastFrameUploadId: null,
      usedAt: 1,
    }
    storage.set(STATE_KEY, JSON.stringify({ projectId: 'old', uploads: { img_a: 'upA', broken: 7 }, entries: { scene_z: oldEntry, junk: { sceneId: 'junk' } } }))
    storage.set(JOBS_KEY, JSON.stringify({ jobs: {}, sent: { take_old: { projectId: 'old', nodeId: 'sv_scene_z', at: 1 } } }))
    const provider = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage, now: () => 1_000_000 })
    await provider.submit(req())
    expect(provider.uploadCacheSize()).toBe(2) // img_a cached (upA) + img_b uploaded; the broken record dropped
    const canvas = server.state.canvases.get('old') as { nodes: { id: string; data: Record<string, unknown> }[]; connections: { from: string; to: string }[] }
    expect(canvas.nodes.every((n) => isUuid(n.id))).toBe(true)
    expect(canvas.nodes.some((n) => n.id === canvasNodeId('scene_z'))).toBe(true)
    expect(canvas.nodes.every((n) => !('title' in n.data) && !('label' in n.data))).toBe(true)
    expect(JSON.stringify(canvas)).not.toContain('sv_')
    expect(server.state.jobs[0].body.client_request_id).toBe(clientRequestIdFor('take_1'))
    // the old "sent" record (v0.2.0 node id) is still looked up by its own node id — no job there → nothing adopted
    expect(await provider.recover!(req({ key: 'take_old', takeId: 'take_old', sceneId: 'scene_z' }))).toBeNull()
    // an explicit retry of it: nothing found on that node → sent on the scene's node of its project (never "sv_…")
    await provider.submit(req({ key: 'take_old', takeId: 'take_old', sceneId: 'scene_z' }))
    expect(server.state.jobs[1].body.canvas_node_id).toBe(node('scene_z'))
  })

  it('a lost answer is matched by the UUID client_request_id — or by the bare take id v0.2.0 sent', async () => {
    for (const listed of [clientRequestIdFor('take_1'), 'take_1']) {
      const server = fakeServer()
      const { provider, storage } = setup(server)
      await provider.submit(req({ key: 'warmup', takeId: 'warmup', sceneId: 'scene_w' })) // creates the bridge project
      storage.set(JOBS_KEY, JSON.stringify({ jobs: {}, sent: { take_1: { projectId: 'proj1', nodeId: canvasNodeId('scene_a'), at: 1 } } }))
      server.state.jobs.push({ job_id: 'lost', status: 'queued', project_id: 'proj1', body: {} })
      server.state.extra = (r) =>
        r.method === 'GET' && r.path.startsWith('/api/video-jobs?')
          ? json([
              { job_id: 'job1', status: 'queued', client_request_id: clientRequestIdFor('warmup') },
              { job_id: 'lost', status: 'queued', client_request_id: listed },
            ])
          : undefined
      const again = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage })
      expect(await again.recover!(req())).toEqual({ remoteId: 'proj1:lost' })
    }
  })

  it('recreates the bridge project when the remembered one was deleted (404)', async () => {
    const { provider, server } = setup()
    await provider.submit(req())
    server.state.projects = []
    const { remoteId } = await provider.submit(req({ key: 'take_2', takeId: 'take_2' }))
    expect(remoteId.startsWith('proj1:')).toBe(true)
    expect(server.state.projects.length).toBe(1)
  })

  it('refuses unsupported requests before spending anything', async () => {
    const { provider, server } = setup()
    await expect(provider.submit(req({ videos: [{ n: 1, takeId: 't', videoId: 'v', posterId: null }] }))).rejects.toThrow(/video tham chiếu/)
    await expect(provider.submit(req({ images: [{ n: 1, assetId: 'g', imageId: 'img_gif' }] }))).rejects.toThrow(/JPG\/PNG\/WEBP/)
    expect(server.state.jobs.length).toBe(0)
  })

  it('reference videos: maxRefVideos is 0 for both models whatever /api/video-profiles says; a submit with one sends nothing', async () => {
    const server = fakeServer()
    const { provider, storage } = setup(server)
    const caps = () => (['seedance_2_5', 'minimax_h3'] as const).map((m) => provider.capabilities(m).maxRefVideos)
    expect(CANVASAPP_MAX_REF_VIDEOS).toBe(0) // opened only with a captured request shape (docs/canvasapp-api-notes.md)
    expect(caps()).toEqual([0, 0])
    // a profile hint alone never opens @video: it does not say how a video would be sent
    const videoKeys = { max_reference_videos: 3, reference_videos: true, video_inputs: ['reference'] }
    server.state.extra = (r) =>
      r.path === '/api/video-profiles'
        ? json({
            profiles: [
              { model_profile: 'seedance_2_5', can_create: true, options: { modes: ['t2v'], ...videoKeys } },
              { model_profile: 'minimax_h3', display_name: 'MiniMax-H3', enabled: true, can_create: true, options: { disabled_modes: [], ...videoKeys } },
            ],
          })
        : undefined
    await provider.refreshProfiles()
    expect(caps()).toEqual([0, 0])
    const before = server.calls.length
    const video = { n: 1, takeId: 't', videoId: 'v', posterId: null }
    for (const over of [{}, { model: 'minimax_h3' as const, mode: 'i2v' as const, resolution: '768p', duration: 5 }]) {
      await expect(provider.submit(req({ ...over, prompt: '@video_1 @image_1', videos: [video] }))).rejects.toMatchObject({
        code: 'unsupported',
        message: expect.stringContaining('chưa hỗ trợ video tham chiếu'),
      })
    }
    expect(server.calls.slice(before)).toEqual([]) // no upload, no canvas, no job (the profiles were fresh)
    expect(server.state.uploads).toBe(0)
    expect(server.state.jobs).toHaveLength(0)
    const ledger = JSON.parse(storage.get(JOBS_KEY) ?? '{}') as { jobs?: object; sent?: object }
    expect(Object.keys(ledger.jobs ?? {})).toEqual([])
    expect(Object.keys(ledger.sent ?? {})).toEqual([])
  })

  it('maps 401 to login-required', async () => {
    const { provider } = setup(fakeServer({ authenticated: false }))
    await expect(provider.submit(req())).rejects.toMatchObject({ code: 'login-required' })
    expect(await provider.available()).toEqual({ ok: false, reason: 'Chưa đăng nhập canvasapp.io.vn.' })
  })

  it('polls with one list request per project and never more often than every 15 s', async () => {
    const { provider, server, clock } = setup()
    const a = await provider.submit(req())
    const b = await provider.submit(req({ key: 'take_2', takeId: 'take_2', sceneId: 'scene_b' }))
    // each submit read the list once, right before its POST
    const submitted = 2
    const listCount = () => server.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/video-jobs?')).length - submitted
    expect(listCount()).toBe(0)

    server.state.jobs[0].status = 'processing'
    server.state.jobs[0].progress = 30
    let st = await provider.poll([a.remoteId, b.remoteId])
    expect(listCount()).toBe(1)
    expect(st).toEqual([
      { remoteId: a.remoteId, state: 'processing', progress: 30 },
      { remoteId: b.remoteId, state: 'queued', progress: undefined },
    ])

    server.state.jobs[0].status = 'completed'
    server.state.jobs[0].download_available = true
    clock.t += 5_000
    st = await provider.poll([a.remoteId])
    expect(listCount()).toBe(1) // cached
    expect(st[0].state).toBe('processing')

    clock.t += MIN_POLL_MS
    st = await provider.poll([a.remoteId])
    expect(listCount()).toBe(2)
    expect(st[0].state).toBe('completed')

    const result = await provider.fetchResult(a.remoteId)
    expect(result.video?.type).toBe('video/mp4')
    expect(result.video?.size).toBe(8)
  })

  it('reports a job missing from the list as failed after a few polls', async () => {
    const { provider, server, clock } = setup()
    const { remoteId } = await provider.submit(req())
    server.state.jobs = []
    const states: string[] = []
    for (let i = 0; i < 3; i++) {
      clock.t += MIN_POLL_MS + 1
      states.push((await provider.poll([remoteId]))[0].state)
    }
    expect(states).toEqual(['processing', 'processing', 'failed'])
  })

  it('reset() forgets the bridge project and the upload cache', async () => {
    const { provider, storage } = setup()
    await provider.submit(req())
    expect(provider.uploadCacheSize()).toBe(2)
    provider.reset()
    expect(provider.bridgeProjectId()).toBeNull()
    expect(provider.uploadCacheSize()).toBe(0)
    expect(storage.get(STATE_KEY)).toBeNull()
  })

  it('a key that already got its job is never posted again (also after a restart, also after logout)', async () => {
    const { provider, server, storage } = setup()
    const a = await provider.submit(req())
    expect(await provider.submit(req())).toEqual(a)
    const [same1, same2] = await Promise.all([provider.submit(req({ key: 'take_2', takeId: 'take_2' })), provider.submit(req({ key: 'take_2', takeId: 'take_2' }))])
    expect(same1).toEqual(same2)
    expect(server.state.jobs.length).toBe(2)

    provider.reset() // logout: bridge project + uploads forgotten, the job ledger kept
    expect(storage.get(STATE_KEY)).toBeNull()
    expect(JSON.parse(storage.get(JOBS_KEY)!).jobs.take_1.remoteId).toBe(a.remoteId)
    const again = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage })
    expect(await again.submit(req())).toEqual(a)
    expect(await again.recover!(req())).toEqual(a)
    expect(await again.recover!(req({ key: 'never_sent', takeId: 'never_sent' }))).toBeNull()
    expect(server.state.jobs.length).toBe(2)
  })

  it('stops before posting when the take is cancelled; a refused job leaves no "sent" record', async () => {
    const { provider, server, storage } = setup()
    await expect(provider.submit(req(), { isCancelled: () => true })).rejects.toMatchObject({ code: 'cancelled' })
    expect(server.calls.filter((c) => c.path === '/api/video-jobs' && c.method === 'POST').length).toBe(0)

    server.state.extra = (r) => (r.method === 'POST' && r.path === '/api/video-jobs' ? json({ detail: 'Không đủ credit' }, 402) : undefined)
    await expect(provider.submit(req())).rejects.toMatchObject({ code: 'bad-request', message: expect.stringMatching(/không đủ credit/i) })
    expect(JSON.parse(storage.get(JOBS_KEY)!).sent).toEqual({})
    // not enough credits says nothing about the uploads: kept (no pointless re-upload after a top-up)
    expect(provider.uploadCacheSize()).toBe(2)

    server.state.extra = (r) => (r.method === 'POST' && r.path === '/api/video-jobs' ? json({ detail: 'upload_ids không hợp lệ' }, 400) : undefined)
    await expect(provider.submit(req())).rejects.toMatchObject({ code: 'bad-request' })
    expect(provider.uploadCacheSize()).toBe(0) // re-uploaded next time (an upload may have been the problem)
  })

  it('a canvas refused at PUT is never remembered: the next scene is not blocked by it (also after a restart)', async () => {
    const server = fakeServer()
    // canvasapp refuses every canvas holding upload "up1" (scene A's only reference)
    server.state.extra = (r) => (isPut(r) && uploadsIn(r).includes('up1') ? json({ detail: 'Invalid canvas payload' }, 422) : undefined)
    const { provider, storage } = setup(server)
    const a = provider.submit(req({ images: [{ n: 1, assetId: 'a', imageId: 'img_a' }], prompt: '@image_1' }))
    await expect(a).rejects.toMatchObject({ code: 'bad-request' })
    const message = (await a.catch((e: Error) => e.message)) as string
    expect(message.startsWith(CANVAS_NOT_SAVED_TEXT)).toBe(true)
    expect(message).toContain('Invalid canvas payload [PUT /api/projects/{id}/canvas · HTTP 422]')
    expect(savedEntries(storage)).toEqual([])
    expect(server.state.jobs).toHaveLength(0)

    // scene B (no picture): accepted, and its canvas does not carry scene A
    const b = await provider.submit(req({ key: 'take_b', takeId: 'take_b', sceneId: 'scene_b', images: [], prompt: 'trời mưa' }))
    expect(b.remoteId).toBe('proj1:job1')
    expect(savedEntries(storage)).toEqual(['scene_b'])
    const again = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage })
    expect((await again.submit(req({ key: 'take_c', takeId: 'take_c', sceneId: 'scene_c', images: [], prompt: 'nắng' }))).remoteId).toBe('proj1:job2')
  })

  it('an older scene whose job has ended and that canvasapp now refuses is dropped: the PUT is retried once without it', async () => {
    const server = fakeServer()
    const { provider, storage, clock } = setup(server)
    await provider.submit(req({ images: [{ n: 1, assetId: 'a', imageId: 'img_a' }], prompt: '@image_1' })) // scene A: up1
    expect(savedEntries(storage)).toEqual(['scene_a'])
    server.state.jobs[0].status = 'completed' // A's job has ended: its node may leave the canvas
    clock.t += MIN_POLL_MS // (a job list read less than that ago is used as it is)
    // later canvasapp refuses up1 (e.g. expired): every canvas still holding scene A's node is refused
    server.state.extra = (r) => (isPut(r) && uploadsIn(r).includes('up1') ? json({ detail: 'Invalid canvas payload' }, 422) : undefined)
    const b = await provider.submit(req({ key: 'take_b', takeId: 'take_b', sceneId: 'scene_b', images: [{ n: 1, assetId: 'b', imageId: 'img_b' }], prompt: '@image_1' }))
    expect(b.remoteId).toBe('proj1:job2')
    const puts = server.calls.filter(isPut)
    expect(puts.slice(-2).map((r) => uploadsIn(r).sort())).toEqual([['up1', 'up2'], ['up2']])
    expect(savedEntries(storage)).toEqual(['scene_b'])
    // refused again even alone: nothing remembered, the error says nothing was billed
    server.state.extra = (r) => (isPut(r) ? json({ detail: 'Invalid canvas payload' }, 422) : undefined)
    await expect(provider.submit(req({ key: 'take_c', takeId: 'take_c', sceneId: 'scene_c', images: [], prompt: 'x' }))).rejects.toThrow(CANVAS_NOT_SAVED_TEXT)
    expect(savedEntries(storage)).toEqual(['scene_b'])
    expect(server.state.jobs).toHaveLength(2)
  })

  it('a refused PUT never takes a running job’s node off the canvas: retried without the ended scenes only, else refused', async () => {
    const server = fakeServer()
    const { provider, storage, clock } = setup(server)
    const one = (scene: string, key: string) => req({ key, takeId: key, sceneId: scene, images: [], prompt: scene })
    await provider.submit(one('scene_a', 'take_a')) // job1: still running (queued)
    await provider.submit(one('scene_b', 'take_b')) // job2: ends below
    server.state.jobs[1].status = 'completed'
    clock.t += MIN_POLL_MS // (a job list read less than that ago is used as it is)
    // canvasapp refuses the first canvas (with every scene): once more without the ended scene B — A stays
    let refusals = 1
    server.state.extra = (r) => (isPut(r) && refusals-- > 0 ? json({ detail: 'Invalid canvas payload' }, 422) : undefined)
    expect((await provider.submit(one('scene_c', 'take_c'))).remoteId).toBe('proj1:job3')
    const nodesOf = (r: TransportRequest) => (r.json as CanvasPayload).nodes.map((n) => n.id)
    const puts = server.calls.filter(isPut)
    expect(nodesOf(puts.at(-2)!)).toEqual(['scene_c', 'scene_a', 'scene_b'].map(node))
    expect(nodesOf(puts.at(-1)!)).toEqual(['scene_c', 'scene_a'].map(node))
    expect(savedEntries(storage).sort()).toEqual(['scene_a', 'scene_c'])
    // refused while only running scenes are there (A and C): nothing may go → no PUT without them, nothing billed
    server.state.extra = (r) => (isPut(r) ? json({ detail: 'Invalid canvas payload' }, 422) : undefined)
    const before = server.calls.filter(isPut).length
    await expect(provider.submit(one('scene_c', 'take_c2'))).rejects.toThrow(CANVAS_NOT_SAVED_TEXT)
    expect(server.calls.filter(isPut).length).toBe(before + 1)
    expect(savedEntries(storage).sort()).toEqual(['scene_a', 'scene_c'])
    expect(server.state.canvases.get('proj1')).toMatchObject({ nodes: [{ id: node('scene_c') }, { id: node('scene_a') }] })
    expect(server.state.jobs).toHaveLength(3)
  })

  it('a refused POST forgets the uploads but keeps the scene’s entry while an earlier take of it still runs', async () => {
    const server = fakeServer()
    const { provider, storage } = setup(server)
    await provider.submit(req()) // scene_a: job1 running, uploads up1 + up2
    server.state.extra = (r) => (r.method === 'POST' && r.path === '/api/video-jobs' ? json({ detail: 'unknown upload_id' }, 400) : undefined)
    await expect(provider.submit(req({ key: 'take_2', takeId: 'take_2' }))).rejects.toThrow()
    expect(savedEntries(storage)).toEqual(['scene_a']) // its node stays: job1 still needs it
    expect(provider.uploadCacheSize()).toBe(0) // uploaded again next time
    // no earlier job of the scene: the entry goes with the uploads (as before)
    await expect(provider.submit(req({ key: 'take_3', takeId: 'take_3', sceneId: 'scene_b' }))).rejects.toThrow()
    expect(savedEntries(storage)).toEqual(['scene_a'])
  })

  it('a refused PUT while re-sending a take whose earlier POST lost its answer never claims "not billed"', async () => {
    const server = fakeServer()
    const { provider, storage } = setup(server)
    await provider.submit(req({ key: 'warmup', takeId: 'warmup', sceneId: 'scene_w', images: [] })) // bridge project
    storage.set(JOBS_KEY, JSON.stringify({ jobs: {}, sent: { take_1: { projectId: 'proj1', nodeId: canvasNodeId('scene_a'), at: 1, before: [] } } }))
    server.state.extra = (r) => (isPut(r) ? json({ detail: 'Invalid canvas payload' }, 422) : undefined)
    const again = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage })
    const refused = (await again.submit(req()).catch((e: unknown) => e)) as CanvasappError
    expect(refused.message).toContain('lần gửi trước vẫn chưa rõ đã bị trừ credit chưa')
    expect(refused.message).not.toContain(CANVAS_NOT_SAVED_TEXT)
    // held back like every "nothing sent this time" of a take in doubt: still "không rõ", with the reason
    expect(isSubmitHeldBack(refused)).toBe(true)
    expect(JSON.parse(storage.get(JOBS_KEY)!).sent.take_1).toBeTruthy() // still looked for before any later POST
  })

  it('a job refused for its uploads also drops the scene’s bridge entry naming them', async () => {
    const server = fakeServer()
    const { provider, storage } = setup(server)
    server.state.extra = (r) => (r.method === 'POST' && r.path === '/api/video-jobs' ? json({ detail: 'upload_ids không hợp lệ' }, 400) : undefined)
    await expect(provider.submit(req())).rejects.toMatchObject({ code: 'bad-request' })
    expect(provider.uploadCacheSize()).toBe(0)
    expect(savedEntries(storage)).toEqual([])
  })

  it('a credit refusal answered with 400 keeps the uploads too (no re-upload after a top-up)', async () => {
    const server = fakeServer()
    const { provider } = setup(server)
    server.state.extra = (r) => (r.method === 'POST' && r.path === '/api/video-jobs' ? json({ detail: 'Không đủ credit: cần 60' }, 400) : undefined)
    const run = provider.submit(req())
    await expect(run).rejects.toMatchObject({ code: 'bad-request', status: 400, noCredit: true })
    expect(((await run.catch((e: Error) => e.message)) as string).startsWith(NOT_ENOUGH_CREDITS_TEXT)).toBe(true)
    expect(provider.uploadCacheSize()).toBe(2)
    server.state.extra = null
    await provider.submit(req({ key: 'take_2', takeId: 'take_2' }))
    expect(server.state.uploads).toBe(2)
  })

  it('reads /api/video-profiles before the first submit (cached), and refuses what canvasapp’s page would not run', async () => {
    const server = fakeServer()
    const { provider, clock } = setup(server)
    server.state.extra = (r) => (r.path === '/api/video-profiles' ? h3Profiles({ options: { disabled_modes: ['transform'] } }) : undefined)
    const profileReads = () => server.calls.filter((c) => c.path === '/api/video-profiles').length
    await expect(provider.submit(transformReq())).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/tạm ngừng/) })
    expect(server.calls.filter((c) => c.path !== '/api/video-profiles')).toEqual([]) // nothing else was sent
    await provider.submit(req({ key: 'i2v', takeId: 'i2v', model: 'minimax_h3', mode: 'i2v', resolution: '768p', duration: 5 }))
    expect(profileReads()).toBe(1)
    expect(provider.capabilities('minimax_h3').modes).toEqual(['t2v', 'i2v'])

    // canvasapp locks MiniMax-H3: seen once the cache is older than PROFILES_TTL_MS
    server.state.extra = (r) => (r.path === '/api/video-profiles' ? h3Profiles({ can_create: false }) : undefined)
    clock.t += PROFILES_TTL_MS
    await expect(provider.submit(req({ key: 'i2v_2', takeId: 'i2v_2', model: 'minimax_h3', mode: 'i2v', resolution: '768p', duration: 5 }))).rejects.toThrow(
      /MiniMax-H3 hiện không khả dụng/,
    )
    expect(profileReads()).toBe(2)
    expect(server.state.jobs).toHaveLength(1)
  })

  it('a malformed Seedance profile (used as sent, like the client) neither breaks a submit nor capabilities()', async () => {
    const server = fakeServer()
    const { provider } = setup(server)
    server.state.extra = (r) =>
      r.path === '/api/video-profiles' ? json({ profiles: [null, { model_profile: 'seedance_2_5', can_create: true, options: { durations: 'all', modes: 5, resolutions: ['1080p', 7] } }] }) : undefined
    expect((await provider.submit(req())).remoteId).toBe('proj1:job1')
    const caps = provider.capabilities('seedance_2_5')
    expect(caps).toMatchObject({ modes: ['t2v'], durations: [5, 10, 15, 30], resolutions: ['1080p'] })
  })

  it('video profiles unreadable → canvasapp’s fallbacks (MiniMax-H3 locked, said why), read again a minute later; 401 → login', async () => {
    const server = fakeServer()
    const { provider, clock } = setup(server)
    server.state.extra = (r) => (r.path === '/api/video-profiles' ? json({ detail: 'boom' }, 500) : undefined)
    const h3 = (key: string) => req({ key, takeId: key, model: 'minimax_h3', mode: 'i2v', resolution: '768p', duration: 5 })
    await expect(provider.submit(h3('a'))).rejects.toThrow(PROFILES_FALLBACK_TEXT)
    expect((await provider.submit(req())).remoteId).toBe('proj1:job1') // Seedance runs on its fallback profile
    server.state.extra = (r) => (r.path === '/api/video-profiles' ? h3Profiles() : undefined)
    await expect(provider.submit(h3('b'))).rejects.toThrow(/không khả dụng/) // still within the retry delay
    clock.t += 60_000
    expect((await provider.submit(h3('c'))).remoteId).toBe('proj1:job2')

    const out = setup(fakeServer({ authenticated: false }))
    await expect(out.provider.submit(req())).rejects.toMatchObject({ code: 'login-required' })
    expect(out.server.calls.map((c) => c.path)).toEqual(['/api/video-profiles'])
  })

  it('H3 transform: frames must share a supported ratio (canvasapp’s page), checked before uploading; the node gets that ratio', async () => {
    const profiles = (r: TransportRequest) => (r.path === '/api/video-profiles' ? h3Profiles() : undefined)
    const portrait = { width: 1080, height: 1920 }
    const mixed = setup(fakeServer(), undefined, { b: portrait })
    mixed.server.state.extra = profiles
    await expect(mixed.provider.submit(transformReq())).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/khác tỷ lệ \(16:9 \/ 9:16\)/) })
    expect(mixed.server.state.uploads).toBe(0)
    const odd = setup(fakeServer(), undefined, { a: { width: 2560, height: 1080 } })
    odd.server.state.extra = profiles
    await expect(odd.provider.submit(transformReq())).rejects.toThrow(/chưa thuộc danh sách/)
    const unreadable = setup(fakeServer(), undefined, { a: null })
    unreadable.server.state.extra = profiles
    await expect(unreadable.provider.submit(transformReq())).rejects.toThrow(/Không đọc được kích thước ảnh khung đầu/)
    expect(odd.server.state.uploads + unreadable.server.state.uploads).toBe(0)

    const ok = setup(fakeServer(), undefined, { a: portrait, b: portrait })
    ok.server.state.extra = profiles
    await ok.provider.submit(transformReq({ ratio: '16:9' }))
    const canvas = ok.server.state.canvases.get('proj1') as CanvasPayload
    expect(canvas.nodes.find((n) => n.type === 'video')?.data).toMatchObject({ mode: 'transform', aspect_ratio: '9:16' })
    expect(ok.server.state.jobs[0].body).not.toHaveProperty('aspect_ratio')
  })

  it('serialises concurrent submits (uploads of one take never interleave with another)', async () => {
    const { provider, server } = setup()
    await Promise.all([provider.submit(req()), provider.submit(req({ key: 'take_2', takeId: 'take_2', sceneId: 'scene_b' }))])
    expect(server.state.projects.length).toBe(1)
    expect(server.state.uploads).toBe(2)
    expect(server.state.jobs.length).toBe(2)
  })
})

describe('canvasapp adapter: what canvasapp runs now for the UI (settingsLimits / refreshLimits)', () => {
  const H3: VideoSettings = { model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' }
  const h3Req = (key: string) => req({ key, takeId: key, model: 'minimax_h3', mode: 'i2v', resolution: '768p', duration: 5 })
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const profilesAre = (server: ReturnType<typeof fakeServer>, answer: TransportResponse | (() => TransportResponse)) => {
    server.state.extra = (r) => (r.path === '/api/video-profiles' ? (typeof answer === 'function' ? answer() : answer) : undefined)
  }

  /** The adapter over a transport whose /api/video-profiles answers can be held (the server handles it at once). */
  function limitsSetup(opts: { authenticated?: boolean } = {}) {
    const server = fakeServer(opts)
    const clock = { t: 1_000_000 }
    server.state.now = () => clock.t
    let gate: Promise<void> | null = null
    let available = true
    const transport: Transport = {
      available: async () => (available ? { ok: true } : { ok: false, reason: 'web' }),
      request: async (r) => {
        const res = await server.transport.request(r)
        if (r.path === '/api/video-profiles' && gate) await gate
        return res
      },
    }
    const onLimitsChange = vi.fn()
    const provider = createCanvasappProvider({
      api: createCanvasappApi(transport),
      getBlob: async (id) => blobs[id] ?? null,
      storage: memoryStorage(),
      now: () => clock.t,
      onLimitsChange,
      imageSize: async () => ({ width: 1920, height: 1080 }),
    })
    /** Hold the next /api/video-profiles answers until the returned function is called. */
    const hold = () => {
      let release: () => void = () => undefined
      gate = new Promise<void>((r) => (release = r))
      return () => {
        gate = null
        release()
      }
    }
    const reads = () => server.calls.filter((c) => c.path === '/api/video-profiles').length
    return { server, clock, provider, onLimitsChange, hold, reads, setAvailable: (v: boolean) => (available = v) }
  }

  it("'none' before any read; the first submit's read makes it 'server' (firm), said through onLimitsChange", async () => {
    const { provider, server, onLimitsChange } = limitsSetup()
    expect(provider.settingsLimits()).toBe(NO_LIMITS)
    expect(provider.limitsInfo()).toMatchObject({ source: 'none', at: null, firmUntil: null, lastAttempt: null, reading: false })
    profilesAre(server, h3Profiles({ can_create: false }))
    await provider.submit(req())
    expect(onLimitsChange).toHaveBeenCalledTimes(2) // read started, read ended
    const limits = provider.settingsLimits()
    expect(limits).toMatchObject({ source: 'server', firm: true })
    expect(limits.issues(H3)).toEqual([{ field: 'model', reason: 'MiniMax-H3 hiện không khả dụng trên canvasapp.' }])
    expect(limits.issues(req())).toEqual([])
    expect(provider.limitsInfo()).toMatchObject({ source: 'server', at: 1_000_000, firmUntil: 1_000_000 + PROFILES_TTL_MS, lastAttempt: { result: 'read' } })
    expect(provider.settingsLimits()).toBe(limits) // same object until something changes
  })

  it('TTL-gated: nothing is sent while fresh; read once when old; a UI refresh and a submit share ONE request', async () => {
    const { provider, server, clock, reads, hold } = limitsSetup()
    profilesAre(server, h3Profiles())
    expect(await provider.refreshLimits()).toBe('read')
    expect(await provider.refreshLimits()).toBe('fresh')
    expect(reads()).toBe(1)
    clock.t += PROFILES_TTL_MS
    expect(provider.settingsLimits()).toMatchObject({ source: 'server', firm: false }) // older: a guess until read again
    const release = hold()
    const ui = provider.refreshLimits()
    const sent = provider.submit(h3Req('h3'))
    await tick()
    release()
    expect(await ui).toBe('read')
    expect((await sent).remoteId).toBe('proj1:job1')
    expect(reads()).toBe(2)
    expect(provider.settingsLimits()).toMatchObject({ source: 'server', firm: true })
  })

  it('the same answer read again keeps the SAME limits object (memos keyed on it re-run nothing); another answer → another', async () => {
    const { provider, server, clock } = limitsSetup()
    profilesAre(server, h3Profiles())
    await provider.refreshLimits()
    const first = provider.settingsLimits()
    clock.t += PROFILES_FORCE_MIN_MS
    expect(await provider.refreshLimits({ force: true })).toBe('read')
    expect(provider.settingsLimits()).toBe(first)
    profilesAre(server, h3Profiles({ options: { disabled_modes: ['i2v'] } }))
    clock.t += PROFILES_FORCE_MIN_MS
    await provider.refreshLimits({ force: true })
    const second = provider.settingsLimits()
    expect(second).not.toBe(first)
    expect(second.issues(H3).map((i) => i.field)).toEqual(['mode'])
  })

  it('401 → "login" (what was read stays); automatic reads wait a minute, "Đọc lại" waits 5 s, then reads', async () => {
    const { provider, server, clock, reads } = limitsSetup({ authenticated: false })
    expect(await provider.refreshLimits()).toBe('login')
    expect(provider.settingsLimits()).toBe(NO_LIMITS)
    expect(provider.limitsInfo().lastAttempt).toMatchObject({ result: 'login' })
    expect(await provider.refreshLimits()).toBe('login')
    expect(await provider.refreshLimits({ force: true })).toBe('login') // a second click within seconds: nothing sent
    expect(reads()).toBe(1)
    clock.t += PROFILES_FORCE_MIN_MS
    server.state.authenticated = true
    profilesAre(server, h3Profiles())
    expect(await provider.refreshLimits({ force: true })).toBe('read')
    expect(reads()).toBe(2)
    // the session ends: a 401 keeps the last read (logout → reset() drops it)
    server.state.extra = null
    server.state.authenticated = false
    clock.t += PROFILES_TTL_MS
    expect(await provider.refreshLimits()).toBe('login')
    expect(provider.settingsLimits()).toMatchObject({ source: 'server', firm: false })
    clock.t += PROFILES_RETRY_MS
    expect(await provider.refreshLimits()).toBe('login')
    expect(reads()).toBe(4)
  })

  it('a read after a login (`changed`) goes out at once: never the 5 s limit of "Đọc lại", never a read sent before it', async () => {
    const { provider, server, clock, reads, hold } = limitsSetup({ authenticated: false })
    expect(await provider.refreshLimits()).toBe('login') // the inspector's own read, logged out
    // logged in seconds later
    server.state.authenticated = true
    profilesAre(server, h3Profiles({ can_create: false }))
    expect(await provider.refreshLimits({ force: true })).toBe('login') // a quick "Đọc lại" click: its answer, nothing sent
    expect(await provider.refreshLimits()).toBe('login') // automatic reads still wait out the 401
    expect(reads()).toBe(1)
    expect(await provider.refreshLimits({ changed: true })).toBe('read') // the login's read
    expect(reads()).toBe(2)
    expect(provider.settingsLimits()).toMatchObject({ source: 'server', firm: true })
    expect(provider.settingsLimits().issues(H3).map((i) => i.field)).toEqual(['model'])
    // a second change at once is read too (development mode: toggle, "Đọc lại ngay", toggle, "Đọc lại ngay")
    profilesAre(server, h3Profiles({ options: { disabled_modes: ['i2v'] } }))
    expect(await provider.refreshLimits({ force: true })).toBe('fresh') // a click: nothing sent
    expect(await provider.refreshLimits({ changed: true })).toBe('read')
    expect(reads()).toBe(3)
    expect(provider.settingsLimits().issues(H3).map((i) => i.field)).toEqual(['mode'])
    // a forced read in flight was sent before the change: the `changed` read goes after it and gets the newer answer
    clock.t += PROFILES_FORCE_MIN_MS
    const release = hold()
    const click = provider.refreshLimits({ force: true })
    await tick()
    expect(provider.limitsInfo().reading).toBe(true)
    profilesAre(server, h3Profiles())
    const changed = provider.refreshLimits({ changed: true })
    await tick()
    release()
    expect(await click).toBe('read')
    expect(await changed).toBe('read')
    expect(reads()).toBe(5)
    expect(provider.settingsLimits().issues(H3)).toEqual([])
  })

  it('a failed UI read with nothing fresh → "failed" (fallbacks, a guess) — but a submit still reads first', async () => {
    const { provider, server, reads } = limitsSetup()
    profilesAre(server, json({ detail: 'boom' }, 500))
    expect(await provider.refreshLimits()).toBe('failed')
    const limits = provider.settingsLimits()
    expect(limits).toMatchObject({ source: 'fallback', firm: false })
    expect(limits.issues({ ...H3, mode: 'transform' }).map((i) => i.field)).toEqual(['model', 'mode'])
    expect(await provider.refreshLimits()).toBe('failed') // within a minute: nothing sent
    expect(reads()).toBe(1)
    // canvasapp answers again: the submit does not wait out a failure only the UI saw
    profilesAre(server, h3Profiles())
    expect((await provider.submit(h3Req('h3'))).remoteId).toBe('proj1:job1')
    expect(reads()).toBe(2)
    expect(provider.settingsLimits()).toMatchObject({ source: 'server', firm: true })
  })

  it('"Đọc lại" failing while the last read is fresh keeps it ("kept"): a submit accepts what it accepted a second earlier', async () => {
    const { provider, server, clock, reads } = limitsSetup()
    profilesAre(server, h3Profiles())
    await provider.refreshLimits()
    const limits = provider.settingsLimits()
    profilesAre(server, json({ detail: 'Too many requests' }, 429))
    clock.t += PROFILES_FORCE_MIN_MS
    expect(await provider.refreshLimits({ force: true })).toBe('kept')
    expect(provider.settingsLimits()).toBe(limits)
    expect(provider.limitsInfo()).toMatchObject({ source: 'server', at: 1_000_000, lastAttempt: { result: 'kept' } })
    const before = reads()
    expect((await provider.submit(h3Req('h3'))).remoteId).toBe('proj1:job1') // no PROFILES_FALLBACK_TEXT
    expect(reads()).toBe(before)
    // past the TTL the submit reads again and a failure there brings the fallbacks, as before
    clock.t += PROFILES_TTL_MS
    await expect(provider.submit(h3Req('h3_2'))).rejects.toThrow(PROFILES_FALLBACK_TEXT)
    expect(provider.settingsLimits()).toMatchObject({ source: 'fallback' })
  })

  it('"Đọc lại" during an automatic read sends ONE more read after it and returns the newer answer; two clicks share it', async () => {
    const { provider, server, reads, hold } = limitsSetup()
    profilesAre(server, h3Profiles())
    const release = hold()
    const auto = provider.refreshLimits()
    await tick()
    expect(provider.limitsInfo().reading).toBe(true)
    // canvasapp locks H3 while that read is on its way back
    profilesAre(server, h3Profiles({ can_create: false }))
    const forced = [provider.refreshLimits({ force: true }), provider.refreshLimits({ force: true })]
    release()
    expect(await auto).toBe('read')
    expect(await Promise.all(forced)).toEqual(['read', 'read'])
    expect(reads()).toBe(2)
    expect(provider.settingsLimits().issues(H3).map((i) => i.field)).toEqual(['model'])
  })

  it('reset() (logout) while a read is in flight: its answer is ignored — back to "none", no extra signal', async () => {
    const { provider, server, onLimitsChange, hold } = limitsSetup()
    profilesAre(server, h3Profiles())
    const release = hold()
    const p = provider.refreshLimits()
    await tick()
    expect(provider.limitsInfo().reading).toBe(true)
    provider.reset()
    const calls = onLimitsChange.mock.calls.length
    expect(provider.limitsInfo()).toMatchObject({ source: 'none', reading: false, lastAttempt: null })
    release()
    await p
    expect(provider.settingsLimits()).toBe(NO_LIMITS)
    expect(provider.limitsInfo()).toMatchObject({ source: 'none', reading: false, lastAttempt: null })
    expect(onLimitsChange.mock.calls.length).toBe(calls)
  })

  it('unavailable here (web build) → "unavailable", nothing sent; a thrown non-401 error → "failed", never "login"', async () => {
    const { provider, server, reads, setAvailable } = limitsSetup()
    setAvailable(false)
    expect(await provider.refreshLimits()).toBe('unavailable')
    expect(reads()).toBe(0)
    setAvailable(true)
    server.state.extra = (r) => {
      if (r.path === '/api/video-profiles') throw new CanvasappError('unavailable', 'Cổng canvasapp chỉ dùng được trong bản desktop SanoVids.')
      return undefined
    }
    expect(await provider.refreshLimits()).toBe('failed')
    expect(provider.settingsLimits()).toMatchObject({ source: 'fallback' })
  })

  it('a malformed profile never breaks a render: issues() answers [] instead of throwing', async () => {
    const { provider, server } = limitsSetup()
    profilesAre(server, json({ profiles: [{ model_profile: 'seedance_2_5', can_create: true, options: { durations: [5], get resolutions(): never { throw new Error('boom') } } }] }))
    expect(await provider.refreshLimits()).toBe('read')
    expect(provider.settingsLimits().issues({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' })).toEqual([])
    expect(provider.capabilities('seedance_2_5').resolutions).toEqual(MODELS.seedance_2_5.resolutions) // nothing left out on a throw
  })

  it('capabilities() follows the same rule: SanoVids values only, any-case resolutions, refused ones left out', async () => {
    const { provider, server } = limitsSetup()
    profilesAre(
      server,
      json({
        profiles: [
          { model_profile: 'seedance_2_5', can_create: true, options: { modes: ['t2v'], durations: [5, 10, 20], resolutions: ['1080P', '4K'], aspect_ratios: ['16:9', '21:9'] } },
          { model_profile: 'minimax_h3', can_create: true, options: { disabled_modes: ['i2v'] } },
        ],
      }),
    )
    await provider.refreshLimits()
    expect(provider.capabilities('seedance_2_5')).toMatchObject({ modes: ['t2v'], durations: [5, 10], resolutions: ['1080p'], ratios: ['16:9'] })
    const h3 = provider.capabilities('minimax_h3')
    expect(h3.modes).toEqual(['t2v', 'transform'])
    for (const k of ['durations', 'resolutions', 'ratios'] as const) expect(h3[k]).toEqual(MODELS.minimax_h3[k])
  })
})

describe('canvasapp adapter: one video node per scene of a project', () => {
  /** An entry as builds before per-project nodes saved it: keyed by the bare scene id. */
  const legacyEntry = (sceneId: string, usedAt: number, prompt = 'bản cũ') => ({
    sceneId,
    model: 'seedance_2_5',
    mode: 't2v',
    duration: 15,
    resolution: '1080p',
    ratio: '16:9',
    prompt,
    uploadIds: [],
    firstFrameUploadId: null,
    lastFrameUploadId: null,
    usedAt,
  })
  /** A provider over `storage` as left by an earlier run (an app restart / an update), on bridge project proj1. */
  function restarted(state: { entries?: Record<string, unknown>; ledger?: { jobs?: Record<string, unknown>; sent?: Record<string, unknown> } } = {}) {
    const server = fakeServer({ projects: [{ project_id: 'proj1', name: BRIDGE_PROJECT_NAME }] })
    const storage = memoryStorage()
    const clock = { t: 10_000_000 }
    server.state.now = () => clock.t
    storage.set(STATE_KEY, JSON.stringify({ projectId: 'proj1', uploads: {}, entries: state.entries ?? {} }))
    storage.set(JOBS_KEY, JSON.stringify({ jobs: state.ledger?.jobs ?? {}, sent: state.ledger?.sent ?? {} }))
    const wakers: (() => void)[] = []
    /** A provider over these records (called again = the app restarted). */
    const restart = () =>
      createCanvasappProvider({
        api: createCanvasappApi(server.transport),
        getBlob: async (id) => blobs[id] ?? null,
        storage,
        now: () => clock.t,
        // the waits after an unanswered POST are released by the test (wake)
        sleep: heldSleep(clock, wakers),
      })
    const provider = restart()
    const waiting = () => vi.waitFor(() => expect(wakers.length).toBeGreaterThan(0))
    const wake = () => wakers.splice(0).forEach((w) => w())
    /** Both waits after an unanswered POST. */
    const wakeTwice = async () => {
      await waiting()
      wake()
      await waiting()
      wake()
    }
    return { server, storage, clock, provider, restart, waiting, wake, wakeTwice }
  }
  /**
   * The job list (GET /api/video-jobs) answers 503 while `list` is set; `reads` decides the next reads first
   * (true = answered). A POST /api/video-jobs sets `list` when `afterPost` is set (the network drops right then).
   */
  function flakyList(server: ReturnType<typeof fakeServer>) {
    const down = { list: false, afterPost: false, reads: [] as boolean[] }
    server.state.extra = (r) => {
      if (r.method === 'POST' && r.path === '/api/video-jobs' && down.afterPost) down.list = true
      if (r.method !== 'GET' || !r.path.startsWith('/api/video-jobs?')) return undefined
      const ok = down.reads.length ? down.reads.shift() : !down.list
      return ok ? undefined : json({ detail: 'Service unavailable' }, 503)
    }
    return down
  }
  const sentRecords = (storage: ReturnType<typeof memoryStorage>) => JSON.parse(storage.get(JOBS_KEY)!).sent as Record<string, { at: number }>

  it('two projects with the same scene id (Nhân bản dự án) get two video nodes, each with its own prompt', async () => {
    const { provider, server, storage } = setup()
    await provider.submit(req({ prompt: 'dự án A' }))
    await provider.submit(req({ key: 'take_2', takeId: 'take_2', sanovidsProjectId: 'prj_b', prompt: 'dự án B' }))
    const [a, b] = server.state.jobs.map((j) => j.body.canvas_node_id)
    expect([a, b]).toEqual([sceneNodeId('prj_a', 'scene_a'), sceneNodeId('prj_b', 'scene_a')])
    const canvas = server.state.canvases.get('proj1') as CanvasPayload
    expect(canvas.nodes.flatMap((n) => (n.type === 'video' ? [[n.id, n.data.prompt]] : []))).toEqual([
      [b, 'dự án B'],
      [a, 'dự án A'],
    ])
    expect(server.state.uploads).toBe(2) // the pictures (and their image nodes) are shared
    expect(rawEntries(storage)).toEqual([sceneNodeKey('prj_a', 'scene_a'), sceneNodeKey('prj_b', 'scene_a')])
    // what an older build reads back (downgrade): every entry kept (key === sceneId), each naming a node on the canvas
    const stored = JSON.parse(storage.get(STATE_KEY)!).entries as Record<string, { sceneId: string }>
    expect(Object.keys(bridgeEntriesFrom(stored))).toEqual(Object.keys(stored))
    for (const [k, e] of Object.entries(stored)) {
      expect(e.sceneId).toBe(k)
      expect(videosOf(canvas)).toContain(canvasNodeId(e.sceneId))
    }
  })

  it('after an update, a job running on its old node (named by the scene id alone) keeps it until it ends and is never posted again', async () => {
    const legacyNode = canvasNodeId('scene_a')
    // the scene's old entry, and 38 other remembered scenes whose jobs have ended
    const others = Object.fromEntries(Array.from({ length: 38 }, (_, i) => [`old_${i}`, legacyEntry(`old_${i}`, 2 + i, `cũ ${i}`)]))
    const { provider, server, storage, clock } = restarted({
      entries: { scene_a: legacyEntry('scene_a', 1), ...others },
      ledger: { jobs: { take_old: { remoteId: 'proj1:job_old', at: 1, nodeId: legacyNode } } },
    })
    server.state.jobs.push({ job_id: 'job_old', status: 'processing', project_id: 'proj1', canvas_node_id: legacyNode, body: {} })
    const old = req({ key: 'take_old', takeId: 'take_old' })
    expect(await provider.submit(old)).toEqual({ remoteId: 'proj1:job_old' })
    expect(await provider.recover!(old)).toEqual({ remoteId: 'proj1:job_old' })
    expect(jobPosts(server)).toHaveLength(0)

    // a new take of that scene: on the project's node; the old node stays next to it (its job runs), the oldest idle
    // scenes make room (39 + 1 video nodes + 2 pictures > 40)
    expect((await provider.submit(req({ key: 'take_new', takeId: 'take_new' }))).remoteId).toBe('proj1:job2')
    expect(server.state.jobs[1].body.canvas_node_id).toBe(node('scene_a'))
    let videos = videosOf(server.state.canvases.get('proj1'))
    expect(videos.slice(0, 2)).toEqual([node('scene_a'), legacyNode])
    expect(videos).not.toContain(canvasNodeId('old_0'))
    expect(videos).not.toContain(canvasNodeId('old_1'))
    // only what is on the canvas is remembered (the dropped idle scenes are rebuilt by their next submit)
    let keys = rawEntries(storage)
    expect(keys).toHaveLength(38)
    expect(keys).toContain('scene_a')
    expect(keys).toContain(sceneNodeKey('prj_a', 'scene_a'))
    expect(keys).not.toContain('old_0')
    expect(jobPosts(server)).toHaveLength(1)

    // the old job ends: when room is needed, its node may go now (the oldest idle entry)
    server.state.jobs[0].status = 'completed'
    clock.t += MIN_POLL_MS
    await provider.submit(req({ key: 'take_b', takeId: 'take_b', sceneId: 'scene_b' }))
    videos = videosOf(server.state.canvases.get('proj1'))
    expect(videos).not.toContain(legacyNode)
    expect(videos.slice(0, 2)).toEqual([node('scene_b'), node('scene_a')]) // take_new still runs: kept
    keys = rawEntries(storage)
    expect(keys).not.toContain('scene_a')
    expect(keys.length).toBeLessThanOrEqual(MAX_BRIDGE_NODES)
    expect(jobPosts(server)).toHaveLength(2)
  })

  it('a take re-sent after an older build lost its answer goes to THAT node again (same canvas_node_id)', async () => {
    const { provider, server, storage } = restarted({
      ledger: { sent: { take_1: { projectId: 'proj1', nodeId: canvasNodeId('scene_a'), at: 1, before: [] } } },
    })
    // nothing found for it on its node → posted again, with the same node id and key as the first time
    await provider.submit(req())
    const [first] = jobPosts(server)
    expect(first.json).toMatchObject({ canvas_node_id: canvasNodeId('scene_a'), client_request_id: clientRequestIdFor('take_1') })
    expect(videosOf(server.state.canvases.get('proj1'))).toEqual([canvasNodeId('scene_a')])
    expect(rawEntries(storage)).toEqual(['scene_a'])
    expect(JSON.parse(storage.get(JOBS_KEY)!).sent).toEqual({})
    // the next take of the scene: the project's own node, next to the one that runs
    await provider.submit(req({ key: 'take_2', takeId: 'take_2' }))
    expect(jobPosts(server)[1].json).toMatchObject({ canvas_node_id: node('scene_a') })
    expect(videosOf(server.state.canvases.get('proj1'))).toEqual([node('scene_a'), canvasNodeId('scene_a')])
  })

  it('remembers at most one canvas of entries, however many scenes and projects ran — never a running job’s entry', async () => {
    const { provider, server, storage, clock } = setup()
    const one = (i: number, project: string) => req({ key: `t${i}`, takeId: `t${i}`, sceneId: `s${i}`, sanovidsProjectId: project, images: [], prompt: `cảnh ${i}` })
    await provider.submit(one(0, 'prj_a')) // job1 keeps running: the oldest entry
    for (let i = 1; i < 80; i++) {
      clock.t += MIN_POLL_MS
      for (const j of server.state.jobs.slice(1)) j.status = 'completed'
      await provider.submit(one(i, i % 2 ? 'prj_a' : 'prj_b'))
    }
    expect(server.state.jobs).toHaveLength(80)
    const keys = rawEntries(storage)
    expect(keys).toHaveLength(MAX_BRIDGE_NODES)
    expect(keys).toContain(sceneNodeKey('prj_a', 's0'))
    expect(keys).toContain(sceneNodeKey('prj_b', 's78'))
    expect(keys).toContain(sceneNodeKey('prj_a', 's79'))
    expect(videosOf(server.state.canvases.get('proj1'))).toContain(node('s0'))
    expect(new Set(keys.map(canvasNodeId))).toEqual(new Set(videosOf(server.state.canvases.get('proj1'))))
  })

  it.each([
    ['server deduplicates client_request_id', true],
    ['server does not deduplicate', false],
  ])('a lookup never takes the job of a take whose answer is still on its way (same node, %s): one job', async (_label, dedupe) => {
    // take_a: an older take of the scene whose POST was cut off (page closed) ten minutes ago and never reached canvasapp
    const { provider, server, storage, clock, waiting, wake } = restarted({
      ledger: { sent: { take_a: { projectId: 'proj1', nodeId: node('scene_a'), at: 10_000_000 - 10 * 60_000, before: [] } } },
    })
    server.state.dedupe = dedupe
    server.state.loseAnswers = 1
    // take_b, a new take of the same scene: canvasapp creates its job, the answer is lost → it waits, then looks
    const b = provider.submit(req({ key: 'take_b', takeId: 'take_b' }))
    await waiting()
    expect(server.state.jobs).toHaveLength(1)
    // meanwhile the page reopens and looks for take_a's job: the new job on that node may be take_b's → not adopted
    clock.t += 5_000
    expect(await provider.recover!(req({ key: 'take_a', takeId: 'take_a' }))).toBeNull()
    wake()
    expect(await b).toEqual({ remoteId: 'proj1:job1' })
    expect(jobPosts(server)).toHaveLength(1) // never posted again
    expect(server.state.jobs).toHaveLength(1)
    // take_b's job is known now: take_a finds nothing of its own — an explicit retry sends it, once, and it gets its own job
    expect(await provider.recover!(req({ key: 'take_a', takeId: 'take_a' }))).toBeNull()
    expect(await provider.submit(req({ key: 'take_a', takeId: 'take_a' }))).toEqual({ remoteId: 'proj1:job2' })
    expect(jobPosts(server)).toHaveLength(2)
    expect(jobPosts(server)[1].json).toMatchObject({ canvas_node_id: node('scene_a'), client_request_id: clientRequestIdFor('take_a') })
    expect(server.state.jobs).toHaveLength(2)
    expect(sentRecords(storage)).toEqual({})
  })

  it('a job already listed before a POST is never taken for it (even a job of an older take still in doubt)', async () => {
    // take_c, older, in doubt: its job job_c exists on the scene's node (the answer was lost, then the app closed)
    const { provider, server, clock, waiting, wake } = restarted({
      ledger: { sent: { take_c: { projectId: 'proj1', nodeId: node('scene_a'), at: 10_000_000 - 60_000, endedAt: 10_000_000 - 58_000, before: [] } } },
    })
    const at = new Date(10_000_000 - 59_000).toISOString()
    server.state.jobs.push({ job_id: 'job_c', status: 'processing', project_id: 'proj1', canvas_node_id: node('scene_a'), created_at: at, body: {} })
    await provider.poll(['proj1:job_c']) // a job-list read: job_c is there
    clock.t += 60_000
    await provider.submit(req({ key: 'take_w', takeId: 'take_w', sceneId: 'scene_w', images: [] })) // the cache is dropped after a POST
    // take_b, a new take of the scene: its POST never reaches canvasapp → looks twice → nothing of its own → posts once more
    server.state.unreachablePosts = 1
    const b = provider.submit(req({ key: 'take_b', takeId: 'take_b' }))
    await waiting()
    wake()
    await waiting()
    wake()
    expect(await b).toEqual({ remoteId: 'proj1:job3' })
    expect(server.state.jobs.map((j) => j.job_id)).toEqual(['job_c', 'job2', 'job3'])
    // job_c stays take_c's to find
    expect(await provider.recover!(req({ key: 'take_c', takeId: 'take_c' }))).toEqual({ remoteId: 'proj1:job_c' })
  })

  it('the same for two takes an older build left on the scene’s old node: the newer one’s re-send keeps its job', async () => {
    const legacy = canvasNodeId('scene_a')
    const { provider, server, waiting, wake } = restarted({
      ledger: {
        sent: {
          take_a: { projectId: 'proj1', nodeId: legacy, at: 10_000_000 - 20 * 60_000, before: [] },
          take_b: { projectId: 'proj1', nodeId: legacy, at: 10_000_000 - 10 * 60_000, before: [] },
        },
      },
    })
    server.state.loseAnswers = 1
    const b = provider.submit(req({ key: 'take_b', takeId: 'take_b' })) // explicit retry: nothing found → re-sent
    await waiting()
    expect(jobPosts(server).map((c) => (c.json as { canvas_node_id: string }).canvas_node_id)).toEqual([legacy])
    expect(await provider.recover!(req({ key: 'take_a', takeId: 'take_a' }))).toBeNull()
    wake()
    expect(await b).toEqual({ remoteId: 'proj1:job1' })
    expect(server.state.jobs).toHaveLength(1)
  })

  /**
   * Take A of scene_a: canvasapp creates its job, the answer is lost and the job list cannot be read → "không rõ".
   * Take B of the same scene 30 s later: the list answers right before its POST (A's job is there), then B's POST never
   * reaches canvasapp and the list is down again → "không rõ" too. One job on the node, two takes in doubt.
   */
  async function twoInDoubt() {
    const t = restarted()
    const down = flakyList(t.server)
    const A = req({ key: 'take_a', takeId: 'take_a', prompt: 'take A' })
    const B = req({ key: 'take_b', takeId: 'take_b', prompt: 'take B' })
    t.server.state.loseAnswers = 1
    down.afterPost = true // (the read right before A's POST answers, then the network drops)
    const a = t.provider.submit(A)
    await t.wakeTwice()
    await expect(a).rejects.toMatchObject({ uncertain: true })
    t.clock.t += 30_000
    down.list = false
    down.afterPost = true
    t.server.state.unreachablePosts = 1
    const b = t.provider.submit(B)
    await t.wakeTwice()
    await expect(b).rejects.toMatchObject({ uncertain: true })
    expect(jobPosts(t.server)).toHaveLength(2)
    expect(t.server.state.jobs.map((j) => j.body.prompt)).toEqual(['take A'])
    expect(Object.keys(sentRecords(t.storage))).toEqual(['take_a', 'take_b'])
    // the network is back
    down.list = false
    down.afterPost = false
    t.clock.t += 60_000
    return { ...t, down, A, B }
  }

  it.each(['the newer one first', 'the older one first', 'both looked up at once after a restart'])(
    'two takes of a scene in doubt one after the other: each finds its own job, never the other’s, and nothing is paid twice (%s)',
    async (order) => {
      const { provider, restart, server, storage, A, B } = await twoInDoubt()
      if (order === 'the newer one first') {
        // B: A's job was listed right before B's POST → not B's → B is sent again (once) and gets its own job
        expect(await provider.submit(B)).toEqual({ remoteId: 'proj1:job2' })
        expect(await provider.submit(A)).toEqual({ remoteId: 'proj1:job1' })
      } else if (order === 'the older one first') {
        expect(await provider.submit(A)).toEqual({ remoteId: 'proj1:job1' })
        expect(await provider.submit(B)).toEqual({ remoteId: 'proj1:job2' })
      } else {
        const again = restart()
        expect(await Promise.all([again.recover!(A), again.recover!(B)])).toEqual([{ remoteId: 'proj1:job1' }, null])
        expect(await again.submit(B)).toEqual({ remoteId: 'proj1:job2' })
      }
      expect(server.state.jobs.map((j) => [j.job_id, j.body.prompt, j.body.client_request_id])).toEqual([
        ['job1', 'take A', clientRequestIdFor('take_a')],
        ['job2', 'take B', clientRequestIdFor('take_b')],
      ])
      expect(jobPosts(server)).toHaveLength(3) // A once, B's lost POST, B again
      expect(sentRecords(storage)).toEqual({})
    },
  )

  it('the job list cannot be read right before posting next to a take in doubt: not sent (nothing billed, not “không rõ”)', async () => {
    const { provider, server, storage, clock, wakeTwice } = restarted()
    const down = flakyList(server)
    const A = req({ key: 'take_a', takeId: 'take_a', prompt: 'take A' })
    const B = req({ key: 'take_b', takeId: 'take_b', prompt: 'take B' })
    server.state.loseAnswers = 1
    down.afterPost = true // (the read right before A's POST answers, then the network drops)
    const a = provider.submit(A)
    await wakeTwice()
    await expect(a).rejects.toMatchObject({ uncertain: true })
    down.afterPost = false
    clock.t += 30_000
    // B while the list is still down: posting now could leave two takes that never tell their jobs apart → not sent
    const refused = (await provider.submit(B).catch((e: unknown) => e)) as CanvasappError
    expect(refused).toBeInstanceOf(CanvasappError)
    expect(refused).toMatchObject({ code: 'server', status: 503 })
    expect(refused.uncertain).toBeUndefined()
    expect(refused.message.startsWith(LIST_NEEDED_TEXT)).toBe(true)
    expect(jobPosts(server)).toHaveLength(1)
    expect(Object.keys(sentRecords(storage))).toEqual(['take_a'])
    // back: A finds its job, B is sent and gets its own
    down.list = false
    expect(await provider.submit(A)).toEqual({ remoteId: 'proj1:job1' })
    expect(await provider.submit(B)).toEqual({ remoteId: 'proj1:job2' })
    expect(server.state.jobs.map((j) => j.body.prompt)).toEqual(['take A', 'take B'])
  })

  it('an old take in doubt that a good read already covers never blocks a POST whose read before it fails (its job, if any, is in `before`)', async () => {
    const old = 10_000_000 // (restarted()'s clock) a POST of three weeks ago: "không rõ", never retried (or deleted)
    const later = old + 21 * 24 * 3600_000
    const { provider, server, storage, clock } = restarted({
      ledger: { sent: { take_old: { projectId: 'proj1', nodeId: node('scene_a'), at: old, endedAt: old + 2_000, before: [] } } },
    })
    clock.t = later
    const down = flakyList(server)
    // a poll reads the list (it shows what existed long after that old POST ended)
    await provider.poll(['proj1:nothing'])
    // 20 s later the scene is run again and the read right before its POST fails once
    clock.t += 20_000
    down.reads = [false]
    const B = req({ key: 'take_b', takeId: 'take_b', images: [], prompt: 'take B' })
    expect(await provider.submit(B)).toEqual({ remoteId: 'proj1:job1' })
    expect(jobPosts(server)).toHaveLength(1)
    expect(Object.keys(sentRecords(storage))).toEqual(['take_old'])
    // no read covering it (the first POST since the app started) → still needed: not sent
    const again = restarted({
      ledger: { sent: { take_old: { projectId: 'proj1', nodeId: node('scene_a'), at: old, endedAt: old + 2_000, before: [] } } },
    })
    again.clock.t = later
    const down2 = flakyList(again.server)
    down2.list = true
    const refused = (await again.provider.submit(B).catch((e: unknown) => e)) as CanvasappError
    expect(refused.message.startsWith(LIST_NEEDED_TEXT)).toBe(true)
    expect(jobPosts(again.server)).toHaveLength(0)
  })

  it('a take in doubt sent again next to another take whose POST may still be on its way: it waits (nothing sent) until a read can surely show that job — and is not sent again when the read before its POST then fails', async () => {
    const T = 10_000_000 // restarted()'s clock
    const NODE = node('scene_a')
    // B's POST lost its answer a minute ago; A's was still being sent by main when the page reloaded 10 s ago (its
    // job may not be listed for minutes: no read covers it yet)
    const { provider, server, storage, clock } = restarted({
      ledger: {
        sent: {
          take_b: { projectId: 'proj1', nodeId: NODE, at: T - 60_000, endedAt: T - 55_000, before: [], beforeAt: T - 75_000 },
          take_a: { projectId: 'proj1', nodeId: NODE, at: T - 10_000, before: [], beforeAt: T - 25_000 },
        },
      },
    })
    const down = flakyList(server)
    const B = req({ key: 'take_b', takeId: 'take_b', prompt: 'take B' })
    const before = sentRecords(storage).take_b
    // A's POST ends 5 min after it was sent at the latest, its job is listed 30 s after that, and a read sent 15 s later
    // (main's cache) surely shows it: until then B goes back to the queue — nothing sent, its first POST still looked for
    const waits = (await provider.submit(B).catch((e: unknown) => e)) as CanvasappError
    expect(waits).toBeInstanceOf(CanvasappError)
    expect(waits).toMatchObject({ code: 'deferred', message: RIVAL_PENDING_TEXT, retryAfterMs: 335_000 })
    expect(waits.uncertain).toBeUndefined()
    expect(jobPosts(server)).toHaveLength(0)
    expect(sentRecords(storage).take_b).toEqual(before)
    // just before then, B's lookup read answers (nothing of B's) but only 2 s later — so it does not surely show A's
    // job; saving the canvas takes a while (that read is too old to stand for the read before the POST), which fails
    clock.t = T + 334_000
    down.reads = [true, false]
    const flaky = server.state.extra!
    let slow = true
    server.state.extra = (r) => {
      if (isPut(r)) clock.t += MIN_POLL_MS
      if (slow && r.method === 'GET' && r.path.startsWith('/api/video-jobs?')) (slow = false), (clock.t += 2_000)
      return flaky(r)
    }
    const refused = (await provider.submit(B).catch((e: unknown) => e)) as CanvasappError
    expect(refused.message).toMatch(/^Không đọc được danh sách job .* Lần này chưa gửi lại yêu cầu tạo video \(lần gửi trước vẫn chưa rõ/)
    expect(refused.message.startsWith(LIST_NEEDED_AFTER_LOST_TEXT)).toBe(true)
    expect(isSubmitHeldBack(refused)).toBe(true) // still "không rõ", with the reason
    expect(jobPosts(server)).toHaveLength(0)
    expect(sentRecords(storage).take_b).toEqual(before) // its first POST is still looked for
    expect(Object.keys(sentRecords(storage)).sort()).toEqual(['take_a', 'take_b'])
  })

  it('a take in doubt sent again when the other take’s job, if any, is surely in the last good read: sent even when the read before its POST fails — each its own job', async () => {
    const { provider, server, clock, down, A, B } = await twoInDoubt()
    down.reads = [true, false] // B's lookup answers (A's job is listed: not B's), the read before its POST fails
    const flaky = server.state.extra!
    server.state.extra = (r) => {
      if (isPut(r)) clock.t += MIN_POLL_MS
      return flaky(r)
    }
    // that lookup read shows what existed well after A's POST ended: A's job is in B's `before`
    expect(await provider.submit(B)).toEqual({ remoteId: 'proj1:job2' })
    expect(await provider.submit(A)).toEqual({ remoteId: 'proj1:job1' })
    expect(server.state.jobs.map((j) => j.body.prompt)).toEqual(['take A', 'take B'])
    expect(jobPosts(server)).toHaveLength(3) // A's, B's (never arrived), B again
  })

  it('a POST sent again after nothing was found carries its own time (a take posting next to it later knows when to look)', async () => {
    const { provider, server, storage, clock, waiting, wake } = restarted()
    server.state.unreachablePosts = 2
    const run = provider.submit(req())
    const first = clock.t
    await waiting()
    expect(sentRecords(storage).take_1.at).toBe(first)
    wake() // +15 s: nothing
    await waiting()
    wake() // +45 s: a read that surely shows its job, if any (30 s + main's 15 s cache) — nothing → sent once more
    await waiting()
    expect(jobPosts(server)).toHaveLength(2)
    expect(sentRecords(storage).take_1.at).toBe(first + 45_000)
    wake()
    await waiting()
    wake()
    await expect(run).rejects.toMatchObject({ uncertain: true })
    expect(jobPosts(server)).toHaveLength(2)
  })

  it('two takes in doubt from a build that did not note when it read the list: a job either could own goes to neither — never posted again', async () => {
    const T = 10_000_000
    const { provider, restart, server } = restarted({
      ledger: {
        sent: {
          take_a: { projectId: 'proj1', nodeId: node('scene_a'), at: T - 120_000, before: [] },
          take_b: { projectId: 'proj1', nodeId: node('scene_a'), at: T - 60_000, before: [] },
        },
      },
    })
    // made right after A's POST — but created_at may be hours off (no time zone), so it could be B's as well
    const createdAt = new Date(T - 119_000).toISOString()
    server.state.jobs.push({ job_id: 'job_a', status: 'processing', project_id: 'proj1', canvas_node_id: node('scene_a'), created_at: createdAt, body: {} })
    const A = req({ key: 'take_a', takeId: 'take_a' })
    const B = req({ key: 'take_b', takeId: 'take_b' })
    expect(await Promise.all([provider.recover!(A), provider.recover!(B)])).toEqual([null, null])
    for (const r of [B, A, B]) await expect(provider.submit(r)).rejects.toMatchObject({ uncertain: true })
    const again = restart()
    expect(await Promise.all([again.recover!(B), again.recover!(A)])).toEqual([null, null])
    expect(jobPosts(server)).toHaveLength(0)
    expect(server.state.jobs).toHaveLength(1)
  })

  /**
   * electron/main.cjs in front of the fake: GET /api/video-jobs answered from a cache for 15 s (timed from when the
   * request was SENT), dropped at every POST /api/video-jobs (CANVASAPP_JOBS_MIN_MS, <canvasapp-job-list-cache>).
   * `answerMs`: how long a job-list answer takes to come back AFTER canvasapp built it (the clock moves meanwhile).
   */
  function mainListCache(server: ReturnType<typeof fakeServer>, clock: { t: number }, answerMs = 0) {
    const cache = new Map<string, { at: number; res: TransportResponse }>()
    let epoch = 0
    const inner = server.transport.request
    server.transport.request = async (r) => {
      const list = r.method === 'GET' && r.path.startsWith('/api/video-jobs?')
      const post = r.method === 'POST' && r.path === '/api/video-jobs'
      const hit = list ? cache.get(r.path) : undefined
      if (hit && clock.t - hit.at < MIN_POLL_MS) return hit.res
      if (post) epoch++, cache.clear()
      const ticket = epoch
      const sentAt = clock.t
      try {
        const res = await inner(r)
        if (list) clock.t += answerMs
        if (list && res.status === 200 && ticket === epoch) cache.set(r.path, { at: sentAt, res })
        return res
      } finally {
        if (post) epoch++, cache.clear()
      }
    }
  }

  /** A take A of scene_a whose POST made job_a at `at` (local and canvasapp time) and lost its answer right away. */
  function lostA(at: number) {
    const t = restarted({
      ledger: { sent: { take_a: { projectId: 'proj1', nodeId: node('scene_a'), at, endedAt: at, before: [], beforeAt: at - MIN_POLL_MS } } },
    })
    t.server.state.jobs.push({
      job_id: 'job_a',
      status: 'processing',
      project_id: 'proj1',
      canvas_node_id: node('scene_a'),
      created_at: new Date(at).toISOString(),
      body: { prompt: 'take A' },
    })
    /** canvasapp lists job_a only from `from` on (inside the 30 s the lookups bet on). */
    const listedFrom = (from: number) => {
      t.server.state.extra = (r) =>
        r.method === 'GET' && r.path.startsWith('/api/video-jobs?') && t.clock.t < from
          ? json(t.server.state.jobs.filter((j) => j.job_id !== 'job_a').map(({ body: _b, ...j }) => j))
          : undefined
    }
    const A = req({ key: 'take_a', takeId: 'take_a', prompt: 'take A' })
    const B = req({ key: 'take_b', takeId: 'take_b', prompt: 'take B', images: [] })
    return { ...t, listedFrom, A, B }
  }

  it('a job-list answer main may have cached (15 s) never counts as fresher than it is: a later take of the scene waits until a read surely shows the earlier take’s job — each its own job', async () => {
    const T0 = 10_000_000 // restarted()'s clock
    const { provider, server, clock, waiting, wake, listedFrom, A, B } = lostA(T0)
    mainListCache(server, clock)
    listedFrom(T0 + 20_000)
    // +16 s: a read (a poll) — A's job not listed yet; main caches that answer until +31 s
    clock.t = T0 + 16_000
    await provider.poll(['proj1:job_a'])
    // B, same scene, at +30.5 s: a read now (main would answer with that cached list) cannot surely show A's job → B
    // waits until +45 s (A's outcome + 30 s + main's 15 s), nothing sent
    clock.t = T0 + 30_500
    await expect(provider.submit(B)).rejects.toMatchObject({ code: 'deferred', retryAfterMs: 14_500 })
    expect(jobPosts(server)).toHaveLength(0)
    // a poll at +31 s fills main's cache again (A's job is listed by then)
    clock.t = T0 + 31_000
    await provider.poll(['proj1:job_a'])
    // +45 s: the read before B's POST is main's cached answer of +31 s, which shows A's job: it is in B's `before`;
    // B's own POST never reaches canvasapp → nothing of B's → sent once more, its own job
    clock.t = T0 + 45_000
    server.state.unreachablePosts = 1
    const b = provider.submit(B)
    await waiting()
    wake()
    await waiting()
    wake()
    expect(await b).toEqual({ remoteId: 'proj1:job2' })
    expect(await provider.submit(A)).toEqual({ remoteId: 'proj1:job_a' })
    expect(server.state.jobs.map((j) => j.body.prompt)).toEqual(['take A', 'take B'])
    expect(jobPosts(server)).toHaveLength(2) // B's (never arrived), B again
  })

  it('the read before a POST is reused only while main would still answer from its cache (timed from when it was SENT): a site job made after a slow answer is never taken for the take’s job', async () => {
    const { provider, server, clock, waiting, wake } = restarted()
    mainListCache(server, clock, 10_000) // each job-list answer arrives 10 s after canvasapp built it
    const T0 = clock.t
    // a poll at T0: sent at T0, its answer arrives at +10 s
    await provider.poll(['proj1:nothing'])
    expect(clock.t).toBe(T0 + 10_000)
    // +12 s: the user runs the scene's node on canvasapp's own page
    clock.t = T0 + 12_000
    server.state.jobs.push({
      job_id: 'site1',
      status: 'processing',
      project_id: 'proj1',
      canvas_node_id: node('scene_a'),
      created_at: new Date(clock.t).toISOString(),
      model_profile: 'seedance_2_5',
      duration: 15,
      creation_mode: 'canvas',
      body: { prompt: 'trên trang' },
    })
    // +20 s: take X of that scene — 10 s after that answer arrived but 20 s after it was sent: main would read afresh,
    // so the read before X's POST is sent too (the site job is in X's `before`); X's POST never reaches canvasapp
    clock.t = T0 + 20_000
    const reads = () => server.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/video-jobs?')).length
    const before = reads()
    server.state.unreachablePosts = 1
    const x = provider.submit(req({ key: 'take_x', takeId: 'take_x', images: [], prompt: 'take X' }))
    await waiting()
    expect(reads()).toBe(before + 1)
    wake()
    await waiting()
    wake() // nothing of X's → sent once more: its own job, never the site's
    expect(await x).toEqual({ remoteId: 'proj1:job2' })
    expect(server.state.jobs.map((j) => j.job_id)).toEqual(['site1', 'job2'])
  })

  it('a slow job-list answer main cached is timed from when it was sent: after a reload, a later take never settles on an earlier take’s job', async () => {
    const T0 = 10_000_000
    const { restart, server, clock, waiting, wake, listedFrom, A, B } = lostA(T0)
    mainListCache(server, clock, 3_000) // each job-list answer arrives 3 s after canvasapp built it
    listedFrom(T0 + 29_500)
    // 28 s after A's POST a read goes out (a poll): built before A's job shows, it arrives at +31 s
    clock.t = T0 + 28_000
    await restart().poll(['proj1:job_a'])
    expect(clock.t).toBe(T0 + 31_000)
    // the page reloads (main keeps its cache, the page's reads are gone); B, same scene, at +45.5 s: 14.5 s after
    // that answer arrived but 17.5 s after it was sent → read again, A's job is in B's `before`
    const page = restart()
    clock.t = T0 + 45_500
    server.state.unreachablePosts = 1
    const b = page.submit(B)
    await waiting()
    wake()
    await waiting()
    wake() // B finds nothing of its own (A's job was listed before its POST) → sent once more
    expect(await b).toEqual({ remoteId: 'proj1:job2' })
    // A finds its own job: one each, nothing paid twice
    expect(await page.submit(A)).toEqual({ remoteId: 'proj1:job_a' })
    expect(server.state.jobs.map((j) => j.body.prompt)).toEqual(['take A', 'take B'])
    expect(jobPosts(server)).toHaveLength(2) // B's (never arrived), B again
  })

  it('a reload during the lookups after a lost answer: the job listed a few seconds later is still found (a second look once a read can surely show it) — never “không rõ” for a job that exists', async () => {
    const T0 = 10_000_000
    const { restart, clock, waiting, wake, listedFrom, A } = lostA(T0)
    listedFrom(T0 + 20_000)
    // +16 s: the new page looks at once (not listed yet: too early to say), then once more at +45 s
    clock.t = T0 + 16_000
    const recovered = restart().recover!(A)
    expect(await Promise.race([recovered, waiting().then(() => 'looks again')])).toBe('looks again')
    wake()
    expect(clock.t).toBe(T0 + 45_000)
    expect(await recovered).toEqual({ remoteId: 'proj1:job_a' })
  })

  it('the clock set back during the lookups after a lost answer: the last look still waits at most 45 s — “không rõ”, never a second POST', async () => {
    const { server, storage, clock } = restarted()
    const wakers: (() => void)[] = []
    const asked: number[] = []
    const held = heldSleep(clock, wakers)
    const p = createCanvasappProvider({
      api: createCanvasappApi(server.transport),
      getBlob: async (id) => blobs[id] ?? null,
      storage,
      now: () => clock.t,
      sleep: (ms) => (asked.push(ms), held(ms)),
    })
    server.state.unreachablePosts = 1
    const run = p.submit(req({ images: [] }))
    await vi.waitFor(() => expect(wakers.length).toBeGreaterThan(0))
    // the clock is set back 7 hours while the first look is on its way
    server.state.extra = (r) => {
      if (r.method === 'GET' && r.path.startsWith('/api/video-jobs?')) {
        server.state.extra = null
        clock.t -= 7 * 3600_000
      }
      return undefined
    }
    wakers.splice(0).forEach((w) => w())
    await vi.waitFor(() => expect(wakers.length).toBeGreaterThan(0))
    expect(asked).toEqual([15_000, 45_000])
    wakers.splice(0).forEach((w) => w())
    await expect(run).rejects.toMatchObject({ uncertain: true })
    expect(jobPosts(server)).toHaveLength(1)
  })

  it('a record stamped on a clock set back 2 h since: a later take of the scene waits 45 s from now, not 2 h (the record is rewritten to now)', async () => {
    const T = 10_000_000 // restarted()'s clock
    const ahead = T + 2 * 3600_000
    const { provider, server, storage, clock } = restarted({
      ledger: { sent: { take_a: { projectId: 'proj1', nodeId: node('scene_a'), at: ahead, endedAt: ahead + 1_000, before: [], beforeAt: ahead - 15_000 } } },
    })
    const B = req({ key: 'take_b', takeId: 'take_b', prompt: 'take B', images: [] })
    await expect(provider.submit(B)).rejects.toMatchObject({ code: 'deferred', retryAfterMs: 45_000 })
    // its times are now (never earlier than what happened); the read's time, stamped on that clock, is not trusted
    expect(sentRecords(storage).take_a).toEqual({ projectId: 'proj1', nodeId: node('scene_a'), at: T, endedAt: T, before: [] })
    clock.t = T + 45_000
    expect(await provider.submit(B)).toEqual({ remoteId: 'proj1:job1' })
    expect(jobPosts(server)).toHaveLength(1)
  })

  it('the page reloads while main is still sending a POST: a later take of the scene waits until that job surely shows, and “Chạy lại” never posts it twice — each its own job', async () => {
    const { provider, restart, server, clock, waiting, wake } = restarted()
    const T0 = clock.t
    const A = req({ key: 'take_a', takeId: 'take_a', prompt: 'take A' })
    const B = req({ key: 'take_b', takeId: 'take_b', prompt: 'take B' })
    // A's POST waits in main (a slow canvasapp, a busy 'api' lane); main goes on with it after the page is gone
    const inner = server.transport.request
    let release = () => undefined as void
    let hang = true
    server.transport.request = async (r) => {
      if (hang && r.method === 'POST' && r.path === '/api/video-jobs') {
        hang = false
        await new Promise<void>((resolve) => (release = resolve))
        await inner(r) // canvasapp makes A's job…
        return new Promise<TransportResponse>(() => undefined) // …and its answer reaches no page
      }
      return inner(r)
    }
    void provider.submit(A)
    await vi.waitFor(() => expect(hang).toBe(false))
    // the page reloads: A is looked up at once (nothing yet), and once more 45 s later — the most the lookups after a
    // lost answer wait, not the minutes main may still be sending it (nothing yet) → "không rõ"
    const page = restart()
    const recovered = page.recover!(A)
    await waiting()
    // "Chạy lại" of A 20 s later: its POST may still be on its way → not posted again (no second charge): A waits
    // (nothing sent THIS time) until a read sent then can surely show that POST's job — 5 min 45 s after it
    clock.t = T0 + 20_000
    const held = await page.submit(A).catch((e: unknown) => e)
    expect(held).toMatchObject({ code: 'deferred', message: STILL_SENDING_TEXT, retryAfterMs: 5 * 60_000 + 45_000 - 20_000 })
    expect(isSubmitHeldBack(held)).toBe(false)
    expect(jobPosts(server)).toHaveLength(0) // (A's first one is still in main)
    clock.t = T0 + 45_000
    wake()
    expect(await recovered).toBeNull()
    // B, same scene, 50 s after A's POST: main may be sending A's for minutes yet (5 min), its job listed 30 s later, a
    // read surely showing it 15 s after that → B waits (back to the queue), nothing sent
    clock.t = T0 + 50_000
    await expect(page.submit(B)).rejects.toMatchObject({ code: 'deferred', retryAfterMs: 5 * 60_000 + 30_000 + 15_000 - 50_000 })
    expect(jobPosts(server)).toHaveLength(0)
    // canvasapp creates A's job only now (55 s after A's POST)
    clock.t = T0 + 55_000
    release()
    await vi.waitFor(() => expect(server.state.jobs).toHaveLength(1))
    // B, once a read surely shows A's job: it is in B's `before`; B's own POST never reaches canvasapp
    clock.t = T0 + 5 * 60_000 + 45_000
    server.state.unreachablePosts = 1
    const b = page.submit(B)
    await waiting()
    wake()
    await waiting()
    wake() // nothing of B's → sent once more: its own job, never A's
    expect(await b).toEqual({ remoteId: 'proj1:job2' })
    // ...and A, retried, finds its own: one job each, nothing paid twice
    expect(await page.submit(A)).toEqual({ remoteId: 'proj1:job1' })
    expect(jobPosts(server)).toHaveLength(3) // A's (main), B's (never arrived), B again
    expect(server.state.jobs.map((j) => j.body.prompt)).toEqual(['take A', 'take B'])
  })

  it.each([
    ['canvasapp lists the job 20 s after the error, the second look fails', false],
    ['a poll right after the error fills main’s 15 s cache, the second look fails', true],
  ])('a lost answer is posted again only after a read that surely shows its job found nothing (%s): never two jobs', async (_label, polled) => {
    const { provider, server, clock, waiting, wake } = restarted()
    // canvasapp makes the job; main gives up on the POST 60 s after sending it — the error comes back at E
    let E = Infinity
    const inner = server.transport.request
    server.transport.request = async (r) => {
      if (r.method === 'POST' && r.path === '/api/video-jobs') {
        await inner(r)
        clock.t += 60_000
        E = clock.t
        throw new Error('timeout')
      }
      return inner(r)
    }
    mainListCache(server, clock)
    const down = flakyList(server)
    const flaky = server.state.extra!
    const listedAfter = polled ? 5_000 : 20_000
    server.state.extra = (r) =>
      flaky(r) ?? (r.method === 'GET' && r.path.startsWith('/api/video-jobs?') && clock.t >= E && clock.t < E + listedAfter ? json([]) : undefined)
    const run = provider.submit(req({ images: [] }))
    await waiting()
    if (polled) {
      // other takes run: the engine's poll 0.5 s after the error reads the list (main caches that answer until +15.5 s)
      clock.t = E + 500
      await provider.poll(['proj1:other'])
    }
    wake() // +15 s: not there (the job is not listed yet, or main answers with the list it cached before)
    await waiting()
    down.list = true // the network drops again: the next look fails
    wake()
    // nothing surely shows the job is not there: "không rõ", not posted a second time
    const outcome = await Promise.race([run.catch((e: unknown) => e), waiting().then(() => 'looking again after a second POST')])
    expect(outcome).toMatchObject({ uncertain: true })
    expect(jobPosts(server)).toHaveLength(1)
    expect(server.state.jobs).toHaveLength(1)
    // the network is back: "Chạy lại" finds that job
    down.list = false
    clock.t += 60_000
    expect(await provider.submit(req({ images: [] }))).toEqual({ remoteId: 'proj1:job1' })
    expect(jobPosts(server)).toHaveLength(1)
  })

  it.each(['the older one first', 'the newer one first'])(
    'a take sent right after another take of its scene ended “không rõ”, its answer lost too: each later finds its own job (%s)',
    async (order) => {
      const { provider, server, storage, clock, waiting, wake } = restarted()
      const down = flakyList(server)
      const A = req({ key: 'take_a', takeId: 'take_a', prompt: 'take A', images: [] })
      const B = req({ key: 'take_b', takeId: 'take_b', prompt: 'take B', images: [] })
      // A's POST cannot connect and the job list cannot be read: "không rõ" (nothing was made)
      server.state.unreachablePosts = 1
      down.afterPost = true // (the read right before A's POST answers, then the network drops)
      const a = provider.submit(A)
      await waiting()
      wake()
      await waiting()
      wake()
      await expect(a).rejects.toMatchObject({ uncertain: true })
      // 0.5 s later the engine sends B: the list reads again, canvasapp makes B's job, the answer is lost, the list is
      // down again
      clock.t += 500
      down.list = false
      down.afterPost = true
      server.state.loseAnswers = 1
      const b = provider.submit(B)
      await waiting()
      wake()
      await waiting()
      wake()
      await expect(b).rejects.toMatchObject({ uncertain: true })
      expect(server.state.jobs.map((j) => j.body.prompt)).toEqual(['take B'])
      // the network is back: "Chạy lại" of each settles it — B on its job, A (nothing of its own) sent once more
      down.list = false
      down.afterPost = false
      clock.t += 10 * 60_000
      if (order === 'the older one first') {
        expect(await provider.submit(A)).toEqual({ remoteId: 'proj1:job2' })
        expect(await provider.submit(B)).toEqual({ remoteId: 'proj1:job1' })
      } else {
        expect(await provider.submit(B)).toEqual({ remoteId: 'proj1:job1' })
        expect(await provider.submit(A)).toEqual({ remoteId: 'proj1:job2' })
      }
      expect(server.state.jobs.map((j) => [j.job_id, j.body.prompt])).toEqual([
        ['job1', 'take B'],
        ['job2', 'take A'],
      ])
      expect(sentRecords(storage)).toEqual({})
    },
  )

  it('“Chạy lại” whose job list cannot be read is held back (LOOKUP_FAILED_TEXT): still “maybe billed”, nothing sent', async () => {
    const T = 10_000_000
    const { provider, server, storage } = restarted({
      ledger: { sent: { take_1: { projectId: 'proj1', nodeId: node('scene_a'), at: T - 60_000, endedAt: T - 59_000, before: [], beforeAt: T - 75_000 } } },
    })
    flakyList(server).list = true
    const held = (await provider.submit(req()).catch((e: unknown) => e)) as CanvasappError
    expect(held).toBeInstanceOf(CanvasappError)
    expect(held).toMatchObject({ code: 'network', uncertain: true, heldBack: true })
    expect(isSubmitHeldBack(held)).toBe(true)
    expect(held.message.startsWith(`${LOOKUP_FAILED_TEXT} (`)).toBe(true)
    expect(jobPosts(server)).toHaveLength(0)
    expect(Object.keys(sentRecords(storage))).toEqual(['take_1']) // still looked for next time
  })

  it('the job list cannot be read before the first POST since the app started: not sent (every POST has a `before`), nothing billed', async () => {
    const { provider, server, storage } = restarted()
    flakyList(server).list = true
    const refused = (await provider.submit(req()).catch((e: unknown) => e)) as CanvasappError
    expect(refused).toBeInstanceOf(CanvasappError)
    expect(refused).toMatchObject({ code: 'server', status: 503 })
    expect(refused.uncertain).toBeUndefined()
    expect(refused.message.startsWith(LIST_FIRST_TEXT)).toBe(true)
    expect(jobPosts(server)).toHaveLength(0)
    expect(sentRecords(storage)).toEqual({})
  })

  it.each([
    ['no created_at', { created_at: undefined }],
    ['an unreadable created_at', { created_at: 'hôm qua' }],
    ['no duration', { duration: null }],
    ['a duration that is not a number', { duration: '15s' }],
    ['no model', { model_profile: null }],
  ])('“Chạy lại” of a record without `before` (an older build): its job listed with %s is still its own — never posted again', async (_label, over) => {
    const T = 10_000_000 // restarted()'s clock
    const { provider, server, storage } = restarted({
      ledger: { sent: { take_1: { projectId: 'proj1', nodeId: node('scene_a'), at: T - 10 * 60_000, endedAt: T - 10 * 60_000 + 1_000 } } },
    })
    server.state.jobs.push({
      job_id: 'job_lost',
      status: 'processing',
      project_id: 'proj1',
      canvas_node_id: node('scene_a'),
      created_at: new Date(T - 10 * 60_000 + 500).toISOString(),
      body: {},
      ...(over as object),
    })
    expect(await provider.submit(req())).toEqual({ remoteId: 'proj1:job_lost' })
    expect(jobPosts(server)).toHaveLength(0)
    expect(sentRecords(storage)).toEqual({})
  })

  it('a lost answer whose job lists created_at as a Unix time in SECONDS is found at the first look — posted once, billed once', async () => {
    const { provider, server, clock, waiting, wake } = restarted()
    clock.t = Date.parse('2026-10-07T10:00:00Z')
    server.state.stamp = (ms) => Math.floor(ms / 1000) as unknown as string
    server.state.loseAnswers = 1
    const run = provider.submit(req({ images: [] }))
    await waiting()
    wake()
    const outcome = await Promise.race([run, waiting().then(() => 'not found at the first look')])
    expect(outcome).toEqual({ remoteId: 'proj1:job1' })
    expect(jobPosts(server)).toHaveLength(1)
    expect(server.state.jobs).toHaveLength(1)
  })

  it('a job list without canvas_node_id (VERIFY) never rules a lost answer’s job out — and a job listed before the POST stays out: posted once', async () => {
    const { provider, server, waiting, wake } = restarted()
    // the list leaves out where each job is (missing / null on canvasapp's side)
    server.state.extra = (r) =>
      r.method === 'GET' && r.path.startsWith('/api/video-jobs?') ? json(server.state.jobs.map(({ body: _b, canvas_node_id: _n, ...j }) => j)) : undefined
    // a job of another scene, listed in the read right before the POST: it may be on any node, so it is in `before`
    server.state.jobs.push({ job_id: 'job_x', status: 'processing', project_id: 'proj1', canvas_node_id: node('scene_x'), created_at: new Date(10_000_000).toISOString(), body: {} })
    server.state.loseAnswers = 1
    const run = provider.submit(req({ images: [] }))
    await waiting()
    wake()
    const outcome = await Promise.race([run, waiting().then(() => 'not found at the first look')])
    expect(outcome).toEqual({ remoteId: 'proj1:job2' })
    expect(jobPosts(server)).toHaveLength(1)
    expect(server.state.jobs).toHaveLength(2)
  })

  it('“sent” records are never capped: the oldest take in doubt still finds its job after 100 newer ones, nothing posted again', async () => {
    const T = 10_000_000
    const sent: Record<string, unknown> = { take_old: { projectId: 'proj1', nodeId: node('scene_a'), at: T - 60 * 60_000, endedAt: T - 60 * 60_000 + 1_000, before: [] } }
    for (let i = 0; i < 100; i++) sent[`take_${i}`] = { projectId: 'proj1', nodeId: node(`scene_${i}`), at: T - 30 * 60_000 + i, endedAt: T - 30 * 60_000 + i + 1_000, before: [] }
    const { provider, server, storage } = restarted({ ledger: { sent } })
    server.state.jobs.push({ job_id: 'job_old', status: 'completed', project_id: 'proj1', canvas_node_id: node('scene_a'), created_at: new Date(T - 60 * 60_000 + 500).toISOString(), body: {} })
    // an unrelated take is sent: the ledger is written (101 records in doubt)
    expect(await provider.submit(req({ key: 'take_new', takeId: 'take_new', sceneId: 'scene_z', images: [] }))).toEqual({ remoteId: 'proj1:job2' })
    expect(Object.keys(sentRecords(storage))).toHaveLength(101)
    expect(sentRecords(storage)).toHaveProperty('take_old')
    // "Chạy lại" of the oldest: its job is found — never posted at once without looking
    expect(await provider.submit(req({ key: 'take_old', takeId: 'take_old', images: [] }))).toEqual({ remoteId: 'proj1:job_old' })
    expect(jobPosts(server)).toHaveLength(1)
  })

  it('a take whose POST never arrived never adopts a site job made after a later take of the scene settled: that take’s read still rules it out', async () => {
    const T = 10_000_000
    // take_a: sent an hour ago, never reached canvasapp ("không rõ")
    const { provider, server, storage, clock } = restarted({
      ledger: { sent: { take_a: { projectId: 'proj1', nodeId: node('scene_a'), at: T - 60 * 60_000, endedAt: T - 60 * 60_000 + 1_000, before: [] } } },
    })
    // take_c of the same scene runs fine now: its read before the POST surely shows take_a's job, if any (none)
    expect(await provider.submit(req({ key: 'take_c', takeId: 'take_c', images: [], prompt: 'take C' }))).toEqual({ remoteId: 'proj1:job1' })
    // 10 min later the user presses "Tạo video" on that node on canvasapp's page (the node holds take C's prompt)
    clock.t += 10 * 60_000
    server.state.jobs.push({ job_id: 'job_s', status: 'completed', project_id: 'proj1', canvas_node_id: node('scene_a'), created_at: new Date(clock.t).toISOString(), body: {} })
    // "Chạy lại" of take_a: job_s was made after take_c's read, which would show take_a's job → not take_a's: posted, as itself
    expect(await provider.submit(req({ key: 'take_a', takeId: 'take_a', images: [], prompt: 'take A' }))).toEqual({ remoteId: 'proj1:job3' })
    expect(server.state.jobs.map((j) => j.body.prompt)).toEqual(['take C', undefined, 'take A'])
    // job_s is nobody's: it stays importable ("Nhập job")
    expect(JSON.stringify(JSON.parse(storage.get(JOBS_KEY)!).jobs)).not.toContain('job_s')
    expect(sentRecords(storage)).toEqual({})
  })

  it('recover() of a take whose submit surely sent nothing (deferred, refused): that error, flagged notSent — never "không rõ"', async () => {
    const T = 10_000_000
    // take_a, same scene, sent just now without a known answer: take_b must wait
    const { provider, server, clock } = restarted({ ledger: { sent: { take_a: { projectId: 'proj1', nodeId: node('scene_a'), at: T, before: [] } } } })
    const B = req({ key: 'take_b', takeId: 'take_b', images: [] })
    const wait = 5 * 60_000 + 45_000
    // while its submit runs (the page switched project, then came back), and after it ended
    const [submitted, joined] = await Promise.allSettled([provider.submit(B), provider.recover!(B)])
    expect(submitted).toMatchObject({ status: 'rejected', reason: { code: 'deferred', retryAfterMs: wait } })
    expect(joined).toMatchObject({ status: 'rejected', reason: { code: 'deferred', message: RIVAL_PENDING_TEXT, notSent: true } })
    expect(isRecoverNotSent((joined as PromiseRejectedResult).reason)).toBe(true)
    clock.t += 60_000
    await expect(provider.recover!(B)).rejects.toMatchObject({ code: 'deferred', notSent: true, retryAfterMs: wait - 60_000 })
    // a sure refusal (402: nothing created) — its words come back
    const C = req({ key: 'take_c', takeId: 'take_c', sceneId: 'scene_c', images: [] })
    server.state.extra = (r) => (r.method === 'POST' && r.path === '/api/video-jobs' ? json({ detail: 'Insufficient credits' }, 402) : undefined)
    await expect(provider.submit(C)).rejects.toMatchObject({ noCredit: true })
    await expect(provider.recover!(C)).rejects.toMatchObject({ noCredit: true, notSent: true, message: expect.stringContaining(NOT_ENOUGH_CREDITS_TEXT) })
    // an answer lost (may be billed): never "not sent" — looked for instead
    const D = req({ key: 'take_d', takeId: 'take_d', sceneId: 'scene_d', images: [] })
    const fresh = restarted()
    fresh.server.state.loseAnswers = 1
    fresh.server.state.extra = (r) => (r.method === 'GET' && r.path.startsWith('/api/video-jobs?') && jobPosts(fresh.server).length ? json({ detail: 'down' }, 503) : undefined)
    const d = fresh.provider.submit(D)
    await fresh.wakeTwice()
    await expect(d).rejects.toMatchObject({ uncertain: true })
    fresh.server.state.extra = null
    expect(await fresh.provider.recover!(D)).toEqual({ remoteId: 'proj1:job1' })
  })

  it('a “sent” record without a readable time is made “now” once (malformed ones dropped): the scene waits a bounded time, never forever', async () => {
    const { provider, storage, clock } = restarted({
      ledger: { sent: { take_a: { projectId: 'proj1', nodeId: node('scene_a'), before: [], endedAt: 'soon' }, junk: { at: 5 } } },
    })
    const B = req({ key: 'take_b', takeId: 'take_b', images: [] })
    // take_a's POST is taken as sent now, not answered: main may send it for 5 min, listed 30 s later, read 15 s after
    await expect(provider.submit(B)).rejects.toMatchObject({ code: 'deferred', retryAfterMs: 5 * 60_000 + 45_000 })
    expect(sentRecords(storage)).toEqual({ take_a: { projectId: 'proj1', nodeId: node('scene_a'), before: [], at: 10_000_000 } })
    clock.t += 5 * 60_000 + 45_000
    expect(await provider.submit(B)).toEqual({ remoteId: 'proj1:job1' })
  })

  it('the job list cannot be read when room is needed: every remembered entry counts as running — nothing taken off, nothing sent', async () => {
    // a full canvas: 40 remembered scenes, the oldest one's job still running on canvasapp
    const entries = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`old_${i}`, legacyEntry(`old_${i}`, 1 + i, `cũ ${i}`)]))
    const { provider, server, storage } = restarted({
      entries,
      ledger: { jobs: { take_old: { remoteId: 'proj1:job_old', at: 1, nodeId: canvasNodeId('old_0') } } },
    })
    server.state.jobs.push({ job_id: 'job_old', status: 'processing', project_id: 'proj1', canvas_node_id: canvasNodeId('old_0'), body: {} })
    const down = flakyList(server)
    down.list = true
    const fresh = req({ key: 'take_new', takeId: 'take_new', sceneId: 'scene_new', images: [], prompt: 'mới' })
    await expect(provider.submit(fresh)).rejects.toMatchObject({ code: 'deferred' })
    expect(server.calls.filter(isPut)).toHaveLength(0)
    expect(jobPosts(server)).toHaveLength(0)
    expect(rawEntries(storage)).toEqual(Object.keys(entries))
    // readable again: the running scene keeps its node, the oldest idle one makes room
    down.list = false
    expect(await provider.submit(fresh)).toEqual({ remoteId: 'proj1:job2' })
    const videos = videosOf(server.state.canvases.get('proj1'))
    expect(videos.slice(0, 2)).toEqual([node('scene_new'), canvasNodeId('old_0')])
    expect(videos).not.toContain(canvasNodeId('old_1'))
    expect(rawEntries(storage)).toContain('old_0')
    expect(rawEntries(storage)).not.toContain('old_1')
  })
})

describe('canvasapp adapter: "Nhập job" (jobs made on canvasapp’s own page)', () => {
  const NODE = node('scene_a')
  const input = (over: Partial<SiteScanInput> = {}): SiteScanInput => ({
    sceneByNode: new Map([[NODE, 'scene_a']]),
    sceneOrder: new Map([['scene_a', 1]]),
    takeJobIds: new Set(),
    takeIds: new Set(),
    ...over,
  })
  /** A job made on canvasapp's page (random client_request_id), the way the job list shows it. */
  function siteJob(server: ReturnType<typeof fakeServer>, over: Partial<(typeof server.state.jobs)[number]> = {}) {
    const j = {
      job_id: 'site' + (server.state.jobs.length + 1),
      status: 'processing',
      progress: 30,
      project_id: 'proj1',
      canvas_node_id: NODE,
      created_at: new Date(server.state.now()).toISOString(),
      model_profile: 'seedance_2_5',
      duration: 15,
      aspect_ratio: '16:9',
      creation_mode: 'canvas',
      body: { prompt: '@image_1 trên trang', client_request_id: '0b9d3c55-1d2a-4a6e-9f7e-2a1c4b5d6e7f' },
      ...over,
    }
    server.state.jobs.push(j)
    return j
  }
  const claim = (key: string, jobId: string, over: Partial<SiteJobClaim> = {}): SiteJobClaim => ({
    key,
    remoteId: `proj1:${jobId}`,
    nodeId: NODE,
    job: { job_id: jobId, canvas_node_id: NODE, status: 'processing', created_at: new Date(1_000_000).toISOString() },
    reimport: false,
    ...over,
  })
  const imported = (storage: ReturnType<typeof memoryStorage>) => JSON.parse(storage.get(JOBS_KEY) ?? '{}').imported as Record<string, { remoteId: string; at: number }>
  const writes = (server: ReturnType<typeof fakeServer>) => server.calls.filter((c) => c.method !== 'GET')

  it('the scan only reads: no bridge session → nothing (never created, never remembered); one found by name → read, not kept', async () => {
    const { provider, server } = setup()
    expect(await provider.scanSiteJobs(input())).toEqual({ projectId: null, listHasKeys: false, candidates: [], skipped: [] })
    expect(server.state.projects).toEqual([])
    server.state.projects.push({ project_id: 'proj1', name: BRIDGE_PROJECT_NAME })
    siteJob(server)
    const scan = await provider.scanSiteJobs(input())
    expect(scan.projectId).toBe('proj1')
    expect(scan.candidates.map((c) => [c.jobId, c.sceneId])).toEqual([['site1', 'scene_a']])
    expect(provider.bridgeProjectId()).toBeNull() // looked up only
    expect(await provider.siteJobPrompts(['site1'])).toEqual({ site1: '@image_1 trên trang' })
    expect(writes(server)).toEqual([])
    expect(server.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([
      'GET /api/projects',
      'GET /api/projects',
      'GET /api/video-jobs',
      'GET /api/projects/proj1', // the saved canvas (hints), only because there is a candidate
      'GET /api/video-jobs/site1/prompt',
    ])
  })

  it('hints come from the saved canvas and SanoVids’ entry: references mapped back to SanoVids pictures', async () => {
    const { provider, server } = setup()
    await provider.submit(req()) // scene_a on the bridge canvas with img_a / img_b
    siteJob(server, { body: { prompt: '@image_1 and @image_2' } })
    const scan = await provider.scanSiteJobs(input({ takeIds: new Set(['take_1']) }))
    expect(scan.skipped).toEqual([{ jobId: 'job1', sceneId: 'scene_a', code: 'sanovids' }])
    const [c] = scan.candidates
    expect(c.hints.map((h) => [h.source, h.refImages])).toEqual([
      ['canvas', ['img_a', 'img_b']],
      ['entry', ['img_a', 'img_b']],
    ])
    expect(c.hints[0]).toMatchObject({ resolution: '1080p', duration: 15, prompt: '@image_1 and @image_2' })
  })

  it('401 → login-required (nothing claimed); a list error other than 404 is thrown; an unreadable prompt is unknown', async () => {
    const { provider, server } = setup(fakeServer({ projects: [{ project_id: 'proj1', name: BRIDGE_PROJECT_NAME }] }))
    siteJob(server)
    server.state.authenticated = false
    await expect(provider.scanSiteJobs(input())).rejects.toMatchObject({ code: 'login-required' })
    server.state.authenticated = true
    server.state.extra = (r) => (r.path.startsWith('/api/video-jobs?') ? json({ detail: 'boom' }, 503) : undefined)
    await expect(provider.scanSiteJobs(input())).rejects.toMatchObject({ code: 'server' })
    server.state.extra = (r) => (r.path.endsWith('/prompt') ? json({}, 200) : undefined)
    expect(await provider.siteJobPrompts(['site1'])).toEqual({ site1: null }) // {} → '' → unknown
    server.state.extra = (r) => (r.path.endsWith('/prompt') ? json({ detail: 'x' }, 429) : undefined)
    expect(await provider.siteJobPrompts(['site1'])).toEqual({ site1: null })
    server.state.extra = (r) => (r.path.endsWith('/prompt') ? json({ detail: 'Not authenticated' }, 401) : undefined)
    await expect(provider.siteJobPrompts(['site1'])).rejects.toMatchObject({ code: 'login-required' })
    expect(writes(server)).toEqual([])
  })

  it('the scan always reads the job list (a job just made on the site must show); the poll reuses that read', async () => {
    const { provider, server } = setup(fakeServer({ projects: [{ project_id: 'proj1', name: BRIDGE_PROJECT_NAME }] }))
    await provider.poll(['proj1:other'])
    siteJob(server)
    const scan = await provider.scanSiteJobs(input())
    expect(scan.candidates.map((c) => c.jobId)).toEqual(['site1'])
    await provider.poll(['proj1:other'])
    expect(server.calls.filter((c) => c.path.startsWith('/api/video-jobs?'))).toHaveLength(2)
  })

  it('claims: written to ledger.imported (survives a restart); never the same job twice, a claimed one unless re-imported, SanoVids’ own, a used key', async () => {
    const { provider, server, storage } = setup()
    await provider.submit(req()) // take_1 → job1 (SanoVids')
    expect(provider.claimSiteJobs([claim('t_a', 'site9'), claim('t_b', 'site9'), claim('t_c', 'job1'), claim('take_1', 'site8'), claim('t_d', 'site8', { remoteId: 'proj1:other' })])).toEqual(['t_a'])
    expect(provider.claimSiteJobs([claim('t_e', 'site9')])).toEqual([]) // claimed before
    expect(provider.claimSiteJobs([claim('t_e', 'site9', { reimport: true })])).toEqual(['t_e'])
    expect(provider.claimSiteJobs([claim('t_a', 'site7')])).toEqual([]) // that key already has a job
    expect(Object.keys(imported(storage))).toEqual(['t_a', 't_e'])
    // a new instance (app restart) reads them back; a ledger written before "Nhập job" loads without them
    const again = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage })
    expect(again.claimSiteJobs([claim('t_f', 'site9')])).toEqual([])
    storage.set(JOBS_KEY, JSON.stringify({ jobs: {}, sent: {} }))
    const old = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage })
    expect(old.claimSiteJobs([claim('t_g', 'site9')])).toEqual(['t_g'])
    storage.set(JOBS_KEY, JSON.stringify({ jobs: {}, sent: {}, imported: { bad: { remoteId: 5 }, worse: 'x', ok: { remoteId: 'proj1:site5', at: 1, nodeId: NODE } } }))
    const mixed = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage })
    expect(mixed.claimSiteJobs([claim('t_h', 'site5'), claim('t_i', 'site6')])).toEqual(['t_i'])
  })

  it('an imported key is never posted: submit / recover return its job (0 POST) — also after another take settles', async () => {
    const { provider, server, storage } = setup()
    expect(provider.claimSiteJobs([claim('t_imp', 'site9')])).toEqual(['t_imp'])
    await provider.submit(req()) // a normal submit settles take_1: the ledger write keeps the claims
    expect(imported(storage).t_imp.remoteId).toBe('proj1:site9')
    expect(await provider.submit(req({ key: 't_imp', takeId: 't_imp' }))).toEqual({ remoteId: 'proj1:site9' })
    expect(await provider.recover!(req({ key: 't_imp', takeId: 't_imp' }))).toEqual({ remoteId: 'proj1:site9' })
    expect(jobPosts(server)).toHaveLength(1)
  })

  it('a job an unanswered POST may own is refused at claim time even when the scan offered it (a POST sent after the scan, its read from before the site job)', async () => {
    const { server, clock } = setup(fakeServer({ projects: [{ project_id: 'proj1', name: BRIDGE_PROJECT_NAME }] }))
    const wakers: (() => void)[] = []
    // a provider whose waits after an unanswered POST hang until the test releases them
    const p = createCanvasappProvider({
      api: createCanvasappApi(server.transport),
      getBlob: async (id) => blobs[id] ?? null,
      storage: memoryStorage(),
      now: () => clock.t,
      sleep: heldSleep(clock, wakers),
    })
    // take_b's read right before its POST: canvasapp builds its answer (no site job yet), which arrives only later
    let release: (() => void) | null = null
    const inner = server.transport.request
    server.transport.request = async (r) => {
      if (!release && r.method === 'GET' && r.path.startsWith('/api/video-jobs?')) {
        const res = await inner(r)
        await new Promise<void>((resolve) => (release = resolve))
        return res
      }
      return inner(r)
    }
    server.state.loseAnswers = 1
    const b = p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))
    await vi.waitFor(() => expect(release).not.toBeNull())
    // meanwhile the site job is made and "Nhập job" offers it (no POST in doubt yet)
    siteJob(server)
    const scan = await p.scanSiteJobs(input())
    const [c] = scan.candidates
    expect(c.jobId).toBe('site1')
    // that read's answer arrives: take_b's POST goes out without the site job in its `before`, and its answer is lost —
    // its "sent" record may own the site job (made within the time window, after the read)
    release!()
    await vi.waitFor(() => expect(wakers.length).toBeGreaterThan(0))
    expect(p.claimSiteJobs([{ key: 't_x', remoteId: c.remoteId, nodeId: NODE, job: c.job, reimport: false }])).toEqual([])
    const again = await p.scanSiteJobs(input())
    expect(again.skipped).toContainEqual({ jobId: 'site1', sceneId: 'scene_a', code: 'maybe-pending', pendingTakeId: 'take_b', windowHours: 14 })
    wakers.splice(0).forEach((w) => w())
    // two jobs could be take_b's (its own + the site's): never guessed, never posted again
    await expect(b).rejects.toMatchObject({ uncertain: true })
    expect(jobPosts(server)).toHaveLength(1)
  })

  it('a site job listed before a POST is no job of that POST: still claimable, and the take finds its own job', async () => {
    const { server, clock } = setup(fakeServer({ projects: [{ project_id: 'proj1', name: BRIDGE_PROJECT_NAME }] }))
    const wakers: (() => void)[] = []
    const p = createCanvasappProvider({
      api: createCanvasappApi(server.transport),
      getBlob: async (id) => blobs[id] ?? null,
      storage: memoryStorage(),
      now: () => clock.t,
      sleep: heldSleep(clock, wakers),
    })
    siteJob(server)
    const [c] = (await p.scanSiteJobs(input())).candidates // this read is the "before" of the POST below
    server.state.loseAnswers = 1
    const b = p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))
    await vi.waitFor(() => expect(wakers.length).toBeGreaterThan(0))
    expect(p.claimSiteJobs([{ key: 't_x', remoteId: c.remoteId, nodeId: NODE, job: c.job, reimport: false }])).toEqual(['t_x'])
    wakers.splice(0).forEach((w) => w())
    expect(await b).toEqual({ remoteId: 'proj1:job2' })
    expect(jobPosts(server)).toHaveLength(1)
  })

  describe('the lost-answer lookup with a site job on the node, imported or not (server without dedupe, list without keys)', () => {
    function world() {
      const server = fakeServer({ projects: [{ project_id: 'proj1', name: BRIDGE_PROJECT_NAME }] })
      const storage = memoryStorage()
      const clock = { t: 10_000_000 }
      server.state.now = () => clock.t
      const wakers: (() => void)[] = []
      /** A provider over `storage` (called again = an app restart: what it read of the job list is gone). */
      const start = () =>
        createCanvasappProvider({
          api: createCanvasappApi(server.transport),
          getBlob: async (id) => blobs[id] ?? null,
          storage,
          now: () => clock.t,
          sleep: heldSleep(clock, wakers),
        })
      const w = { server, storage, clock, provider: start(), wakeTwice: async () => undefined as void }
      w.wakeTwice = async () => {
        for (let i = 0; i < 2; i++) {
          await vi.waitFor(() => expect(wakers.length).toBeGreaterThan(0))
          wakers.splice(0).forEach((x) => x())
        }
      }
      return { ...w, restart: () => (w.provider = start()), get p() { return w.provider } }
    }
    /** Import a site job on scene_a's node, then restart the app a minute later (no job-list read in memory). */
    const importSite = async (w: ReturnType<typeof world>) => {
      siteJob(w.server)
      const scan = await w.p.scanSiteJobs(input())
      const [c] = scan.candidates
      expect(w.p.claimSiteJobs([{ key: 't_imp', remoteId: c.remoteId, nodeId: c.nodeId, job: c.job, reimport: false }])).toEqual(['t_imp'])
      w.clock.t += 60_000
      w.restart()
    }

    it('(a) the POST never reached canvasapp: the imported job is not taken for it — posted once more, billed once', async () => {
      const w = world()
      await importSite(w)
      w.server.state.unreachablePosts = 1
      const b = w.p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))
      await w.wakeTwice()
      expect(await b).toEqual({ remoteId: 'proj1:job2' })
      expect(w.server.state.jobs.map((j) => j.job_id)).toEqual(['site1', 'job2'])
      expect(jobPosts(w.server)).toHaveLength(2) // the first never arrived
    })

    it('(b) the POST reached canvasapp but its answer was lost: it finds its own job, not “ambiguous”', async () => {
      const w = world()
      await importSite(w)
      w.server.state.loseAnswers = 1
      const b = w.p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))
      await vi.waitFor(() => expect(w.server.state.jobs).toHaveLength(2))
      await w.wakeTwice().catch(() => undefined)
      expect(await b).toEqual({ remoteId: 'proj1:job2' })
      expect(jobPosts(w.server)).toHaveLength(1)
    })

    it('(c) a site job made after that POST was sent is never claimable while its answer is unknown', async () => {
      const w = world()
      w.storage.set(JOBS_KEY, JSON.stringify({ jobs: {}, sent: { take_b: { projectId: 'proj1', nodeId: NODE, at: w.clock.t } }, imported: {} }))
      const p = createCanvasappProvider({ api: createCanvasappApi(w.server.transport), getBlob: async (id) => blobs[id] ?? null, storage: w.storage, now: () => w.clock.t })
      w.clock.t += 5_000
      const j = siteJob(w.server)
      const scan = await p.scanSiteJobs(input())
      expect(scan.candidates).toEqual([])
      expect(p.claimSiteJobs([{ key: 't_x', remoteId: `proj1:${j.job_id}`, nodeId: NODE, job: { ...j, body: undefined } as never, reimport: false }])).toEqual([])
      // take_b's own lookup still sees it (the one job on its node): "Chạy lại" of take_b settles onto it, no POST
      expect(await p.recover!(req({ key: 'take_b', takeId: 'take_b', images: [] }))).toEqual({ remoteId: `proj1:${j.job_id}` })
      expect(jobPosts(w.server)).toHaveLength(0)
    })

    /**
     * take_b's POST lost its answer at t0 (nothing known before it on the node); 15 h later — past what that POST may own
     * (CREATED_SKEW_MS + POST_WINDOW_MS) — the user makes a job on that node on canvasapp's page and imports it.
     */
    const importLater = async (w: ReturnType<typeof world>) => {
      const t0 = w.clock.t
      w.storage.set(JOBS_KEY, JSON.stringify({ jobs: {}, sent: { take_b: { projectId: 'proj1', nodeId: NODE, at: t0, before: [] } }, imported: {} }))
      w.restart()
      w.clock.t = t0 + 15 * 3600_000
      const site = siteJob(w.server)
      const scan = await w.p.scanSiteJobs(input())
      expect(scan.candidates.map((c) => c.jobId)).toEqual([site.job_id])
      const [c] = scan.candidates
      expect(w.p.claimSiteJobs([{ key: 't_imp', remoteId: c.remoteId, nodeId: c.nodeId, job: c.job, reimport: false }])).toEqual(['t_imp'])
      return { t0, site }
    }

    it('(d) imported long after a POST that never arrived: "Chạy lại" never takes the imported job — posted once, its own job', async () => {
      const w = world()
      const { site } = await importLater(w)
      expect(await w.p.recover!(req({ key: 'take_b', takeId: 'take_b', images: [] }))).toBeNull()
      expect(await w.p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))).toEqual({ remoteId: 'proj1:job2' })
      expect(w.server.state.jobs.map((j) => j.job_id)).toEqual([site.job_id, 'job2'])
      expect(jobPosts(w.server)).toHaveLength(1)
    })

    it('(e) imported long after a POST whose answer was lost: the take still finds its own job (never “không rõ” for good)', async () => {
      const w = world()
      // take_b's POST did create job1 a second after it was sent (paid); the answer never came back
      w.server.state.jobs.push({
        job_id: 'job1',
        status: 'processing',
        project_id: 'proj1',
        canvas_node_id: NODE,
        created_at: new Date(w.clock.t + 1_000).toISOString(),
        model_profile: 'seedance_2_5',
        duration: 15,
        body: {},
      })
      await importLater(w)
      const again = await w.p.scanSiteJobs(input())
      expect(again.skipped).toContainEqual({ jobId: 'job1', sceneId: 'scene_a', code: 'maybe-pending', pendingTakeId: 'take_b', windowHours: 14 })
      expect(await w.p.recover!(req({ key: 'take_b', takeId: 'take_b', images: [] }))).toEqual({ remoteId: 'proj1:job1' })
      expect(await w.p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))).toEqual({ remoteId: 'proj1:job1' })
      expect(jobPosts(w.server)).toHaveLength(0)
    })

    /**
     * The user made a job on scene_a's node on canvasapp's page and did not import it; SanoVids' last read of the job
     * list is an hour older than that job, or there is none (the first POST since the app started).
     */
    const siteJobUnread = async (w: ReturnType<typeof world>, lastRead: boolean) => {
      if (lastRead) await w.p.poll(['proj1:job_x'])
      w.clock.t += 30 * 60_000
      const site = siteJob(w.server, { status: 'completed', progress: 100, download_available: true })
      w.clock.t += 60 * 60_000
      if (!lastRead) w.restart()
      return site
    }
    const runsOf = [
      ['the last read is older than the site job', true],
      ['the first POST since the app started', false],
    ] as const

    it.each(runsOf)('(f) a site job not imported, the POST never reached canvasapp: the take never settles on it — sent again, its own job (%s)', async (_, lastRead) => {
      const w = world()
      const site = await siteJobUnread(w, lastRead)
      w.server.state.unreachablePosts = 1
      const b = w.p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))
      await w.wakeTwice()
      expect(await b).toEqual({ remoteId: 'proj1:job2' })
      expect(jobPosts(w.server)).toHaveLength(2) // the first never arrived
      // the site job is still the user's to import
      expect((await w.p.scanSiteJobs(input())).candidates.map((c) => c.jobId)).toEqual([site.job_id])
    })

    it.each(runsOf)('(g) a site job not imported, the POST reached canvasapp but its answer was lost: it finds its own job, never “không rõ” for good (%s)', async (_, lastRead) => {
      const w = world()
      const site = await siteJobUnread(w, lastRead)
      w.server.state.loseAnswers = 1
      const b = w.p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))
      await vi.waitFor(() => expect(w.server.state.jobs).toHaveLength(2))
      await w.wakeTwice().catch(() => undefined)
      expect(await b).toEqual({ remoteId: 'proj1:job2' })
      expect(jobPosts(w.server)).toHaveLength(1)
      expect((await w.p.scanSiteJobs(input())).candidates.map((c) => c.jobId)).toEqual([site.job_id])
    })

    it('(h) a site job made long after a POST that never arrived, not imported: "Chạy lại" never takes it — posted once, its own job', async () => {
      const w = world()
      const t0 = w.clock.t
      w.storage.set(JOBS_KEY, JSON.stringify({ jobs: {}, sent: { take_b: { projectId: 'proj1', nodeId: NODE, at: t0, before: [] } }, imported: {} }))
      w.restart()
      // a day later — past what that POST may own (inPostWindow) — the user runs the node on canvasapp's page
      w.clock.t = t0 + 24 * 3600_000
      const site = siteJob(w.server)
      expect((await w.p.scanSiteJobs(input())).candidates.map((c) => c.jobId)).toEqual([site.job_id])
      expect(await w.p.recover!(req({ key: 'take_b', takeId: 'take_b', images: [] }))).toBeNull()
      expect(await w.p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))).toEqual({ remoteId: 'proj1:job2' })
      expect(jobPosts(w.server)).toHaveLength(1)
      // the lookup and the import agree: still importable, never both a POST's and a new take's
      expect((await w.p.scanSiteJobs(input())).candidates.map((c) => c.jobId)).toEqual([site.job_id])
    })
  })
})

describe('canvasapp adapter: two tabs on one ledger (web development mode: the engine lock is per project)', () => {
  function tabs() {
    const server = fakeServer({ projects: [{ project_id: 'proj1', name: BRIDGE_PROJECT_NAME }] })
    const storage = memoryStorage()
    const clock = { t: 10_000_000 }
    server.state.now = () => clock.t
    storage.set(STATE_KEY, JSON.stringify({ projectId: 'proj1', uploads: {}, entries: {} }))
    const wakers: (() => void)[] = []
    const open = () =>
      createCanvasappProvider({
        api: createCanvasappApi(server.transport),
        getBlob: async (id) => blobs[id] ?? null,
        storage,
        now: () => clock.t,
        sleep: heldSleep(clock, wakers),
      })
    const wakeTwice = async () => {
      for (let i = 0; i < 2; i++) {
        await vi.waitFor(() => expect(wakers.length).toBeGreaterThan(0))
        wakers.splice(0).forEach((w) => w())
      }
    }
    let listDown = false
    /** The network drops as a job POST goes out: the job list cannot be read from then on. */
    let dropOnPost = false
    server.state.extra = (r) => {
      if (dropOnPost && r.method === 'POST' && r.path === '/api/video-jobs') listDown = true
      return listDown && r.method === 'GET' && r.path.startsWith('/api/video-jobs?') ? json({ detail: 'Service unavailable' }, 503) : undefined
    }
    /** Take A (tab A, project prj_a): canvasapp makes its job, the answer is lost and the list cannot be read → "không rõ". */
    const inDoubt = async (tab: ReturnType<typeof open>) => {
      server.state.loseAnswers = 1
      dropOnPost = true
      const a = tab.submit(A)
      await wakeTwice()
      await expect(a).rejects.toMatchObject({ uncertain: true })
      dropOnPost = false
      listDown = false
      clock.t += 60_000
    }
    return { server, storage, clock, open, inDoubt }
  }
  const A = req({ key: 'take_a', takeId: 'take_a', images: [], prompt: 'take A' })
  const W = req({ key: 'take_w', takeId: 'take_w', sanovidsProjectId: 'prj_b', sceneId: 'scene_w', images: [], prompt: 'tab B' })

  it('another tab’s write never erases a take in doubt: after a reload it still finds its job — never posted twice', async () => {
    const { server, open, inDoubt } = tabs()
    const tabB = open() // opened first: its copy of the ledger has no record of take A
    const tabA = open()
    await inDoubt(tabA)
    expect(await tabB.submit(W)).toEqual({ remoteId: 'proj1:job2' }) // tab B runs a take of its own project
    const reloaded = open() // tab A reloads
    expect(await reloaded.recover!(A)).toEqual({ remoteId: 'proj1:job1' })
    expect(await reloaded.submit(A)).toEqual({ remoteId: 'proj1:job1' })
    expect(jobPosts(server)).toHaveLength(2)
    expect(server.state.jobs.map((j) => j.body.client_request_id)).toEqual([clientRequestIdFor('take_a'), clientRequestIdFor('take_w')])
  })

  it('“Nhập job” in another tab checks the ledger as it is NOW: a job a take in doubt may own is never claimed', async () => {
    const { open, inDoubt } = tabs()
    const tabB = open()
    const tabA = open()
    await inDoubt(tabA)
    const job = { job_id: 'job1', canvas_node_id: node('scene_a'), status: 'processing', created_at: new Date(10_000_000).toISOString() }
    expect(tabB.claimSiteJobs([{ key: 't_imp', remoteId: 'proj1:job1', nodeId: node('scene_a'), job, reimport: false }])).toEqual([])
    // ...and what tab B writes keeps tab A's records
    expect(await tabB.submit(W)).toEqual({ remoteId: 'proj1:job2' })
    expect(await tabA.submit(A)).toEqual({ remoteId: 'proj1:job1' })
  })

  /** `storage`, refusing every write of the job ledger while `full.on` (localStorage full / blocked: set() throws, swallowed). */
  const fullable = (storage: KeyValueStorage) => {
    const full = { on: false }
    const s: KeyValueStorage = {
      get: (k) => storage.get(k),
      set: (k, v) => {
        if (!(full.on && k === JOBS_KEY)) storage.set(k, v)
      },
      remove: (k) => storage.remove(k),
    }
    return { s, full }
  }

  it('a POST is only sent once its record is saved: storage refusing the ledger → not sent, nothing billed (never paid twice after a reload)', async () => {
    const { server, storage } = tabs()
    const { s, full } = fullable(storage)
    full.on = true
    const tab = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage: s, now: () => 10_000_000 })
    const refused = (await tab.submit(A).catch((e: unknown) => e)) as CanvasappError
    expect(refused).toBeInstanceOf(CanvasappError)
    expect(refused).toMatchObject({ code: 'unavailable', message: LEDGER_NOT_SAVED_TEXT })
    expect(refused.uncertain).toBeUndefined()
    expect(jobPosts(server)).toHaveLength(0)
    // a reload: nothing to look for, and nothing was paid
    const reloaded = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage: s, now: () => 10_000_000 })
    expect(await reloaded.recover!(A)).toBeNull()
    expect(server.state.jobs).toHaveLength(0)
  })

  it('a POST sent again after nothing was found is not sent when its record cannot be saved: the take stays “không rõ”', async () => {
    const { server, storage, clock } = tabs()
    const { s, full } = fullable(storage)
    const wakers: (() => void)[] = []
    const tab = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage: s, now: () => clock.t, sleep: heldSleep(clock, wakers) })
    // the record of the first POST is saved; storage is full from then on, and that POST never reaches canvasapp
    server.state.unreachablePosts = 1
    server.state.extra = (r) => void (r.method === 'POST' && r.path === '/api/video-jobs' && (full.on = true))
    const run = tab.submit(A)
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(wakers.length).toBeGreaterThan(0))
      wakers.splice(0).forEach((w) => w())
    }
    await expect(run).rejects.toMatchObject({ uncertain: true })
    expect(jobPosts(server)).toHaveLength(1)
    // storage takes records again: "Chạy lại" finds nothing of its own and sends it — once
    full.on = false
    server.state.extra = null
    clock.t += 60_000
    expect(await tab.submit(A)).toEqual({ remoteId: 'proj1:job1' })
    expect(jobPosts(server)).toHaveLength(2)
    expect(server.state.jobs).toHaveLength(1)
  })

  it('records written after the POST stand in this tab when storage stops keeping them, and a reset elsewhere is followed', async () => {
    const { server, storage, open } = tabs()
    const { s, full } = fullable(storage)
    const tab = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage: s, now: () => 10_000_000 })
    // the record of the POST is saved, then storage is full: the job it made stays known here
    server.state.extra = (r) => void (r.method === 'POST' && r.path === '/api/video-jobs' && (full.on = true))
    expect(await tab.submit(A)).toEqual({ remoteId: 'proj1:job1' })
    expect(await tab.submit(A)).toEqual({ remoteId: 'proj1:job1' }) // still known: never posted again
    expect(jobPosts(server)).toHaveLength(1)
    // another tab wipes the dev records (resetDevMode removes the key): this tab follows
    server.state.extra = null
    const tabA = open()
    expect(await tabA.submit(W)).toEqual({ remoteId: 'proj1:job2' })
    storage.remove(JOBS_KEY)
    await new Promise((resolve) => setTimeout(resolve, 0)) // (its submit is no longer in flight)
    expect(await tabA.recover!(W)).toBeNull()
  })
})

describe('canvasapp adapter: created_at without a time zone (VERIFY), read in this computer’s time zone', () => {
  /** created_at as a naive datetime in the server's own zone (UTC+`h`), the way FastAPI prints one. */
  const naive = (h: number) => (ms: number) => new Date(ms + h * 3600_000).toISOString().slice(0, 23) + '456'
  const zones = [
    ['Pacific/Honolulu', 7, '+17 h'],
    ['America/Los_Angeles', 7, '+15 h'],
    ['Pacific/Kiritimati', -8, '−22 h'],
    ['Asia/Ho_Chi_Minh', 7, '0 h'],
  ] as const

  it.each(zones)('a POST whose answer was lost finds its own job at the first look — posted once, billed once (%s, canvasapp on UTC%i: %s)', async (tz, h) => {
    const old = process.env.TZ
    process.env.TZ = tz
    try {
      const server = fakeServer({ projects: [{ project_id: 'proj1', name: BRIDGE_PROJECT_NAME }] })
      const storage = memoryStorage()
      const clock = { t: Date.parse('2026-01-15T12:00:00Z') } // winter: US Pacific time is UTC−8
      server.state.now = () => clock.t
      server.state.stamp = naive(h)
      storage.set(STATE_KEY, JSON.stringify({ projectId: 'proj1', uploads: {}, entries: {} }))
      const wakers: (() => void)[] = []
      const provider = createCanvasappProvider({
        api: createCanvasappApi(server.transport),
        getBlob: async (id) => blobs[id] ?? null,
        storage,
        now: () => clock.t,
        sleep: heldSleep(clock, wakers),
      })
      server.state.loseAnswers = 1
      const run = provider.submit(req({ images: [] }))
      await vi.waitFor(() => expect(wakers.length).toBeGreaterThan(0))
      clock.t += 15_000
      wakers.splice(0).forEach((w) => w())
      expect(await run).toEqual({ remoteId: 'proj1:job1' })
      expect(jobPosts(server)).toHaveLength(1)
      expect(server.state.jobs).toHaveLength(1)
      expect(JSON.parse(storage.get(JOBS_KEY)!).sent).toEqual({}) // settled: nothing left in doubt
    } finally {
      if (old === undefined) delete process.env.TZ
      else process.env.TZ = old
    }
  })
})

describe('canvasapp api + transport', () => {
  it('maps HTTP errors', () => {
    expect(errorFromResponse(json({ detail: 'x' }, 401)).code).toBe('login-required')
    expect(errorFromResponse(json({ detail: 'x' }, 403)).code).toBe('forbidden')
    expect(errorFromResponse(json({ detail: 'slow down' }, 429)).message).toContain('slow down')
    expect(errorFromResponse(json({}, 502)).code).toBe('server')
    expect(errorFromResponse(json({ detail: [{ msg: 'field required' }] }, 422)).message).toContain('field required')
  })

  it('says which request was refused and with which status — never ids, query, headers or body', () => {
    const put = { method: 'PUT' as const, path: '/api/projects/0b1c2d3e-aaaa-4bbb-8ccc-123456789abc/canvas' }
    expect(errorFromResponse(json({ detail: 'Invalid canvas payload' }, 422), put).message).toBe(
      'canvasapp.io.vn không nhận yêu cầu này. Invalid canvas payload [PUT /api/projects/{id}/canvas · HTTP 422]',
    )
    // a non-JSON refusal (nginx / Cloudflare page) still names the request and the status
    const html = { status: 413, contentType: 'text/html', text: '<html>413 Request Entity Too Large</html>' }
    expect(errorFromResponse(html, put).message).toBe('canvasapp.io.vn không nhận yêu cầu này. [PUT /api/projects/{id}/canvas · HTTP 413]')
    expect(requestLabel({ method: 'GET', path: '/api/video-jobs?project_id=p1' })).toBe('GET /api/video-jobs')
    expect(requestLabel({ method: 'GET', path: '/api/video-jobs/job_9/stream' })).toBe('GET /api/video-jobs/{id}/stream')
    expect(requestLabel({ method: 'PATCH', path: '/api/projects/p1' })).toBe('PATCH /api/projects/{id}')
    expect(requestLabel({ method: 'GET', path: '/api/payments/topups/ord_1' })).toBe('GET /api/payments/topups/{id}')
    expect(requestLabel({ method: 'POST', path: '/api/uploads/images' })).toBe('POST /api/uploads/images')
    // the login message stays clean
    expect(errorFromResponse(json({ detail: 'x' }, 401), put).message).not.toContain('[')
  })

  it('validation details keep their field (FastAPI loc) and never echo what was sent', () => {
    const detail = [
      { type: 'extra_forbidden', loc: ['body', 'nodes', 0, 'data', 'title'], msg: 'Extra inputs are not permitted', input: 'S01 · T1 — secret prompt' },
      { type: 'missing', loc: ['body', 'viewport', 'scrollLeft'], msg: 'Field required' },
    ]
    const e = errorFromResponse(json({ detail }, 422))
    expect(e.message).toContain('nodes.0.data.title: Extra inputs are not permitted; viewport.scrollLeft: Field required')
    expect(e.message).not.toContain('secret prompt')
    expect(errorFromResponse(json({ detail: [{ error: 'bad node' }] }, 422)).message).toContain('bad node')
    expect(errorFromResponse(json({ detail: [{ code: 7, input: 'secret' }] }, 422)).message).toContain('{"code":7}')
    expect(errorFromResponse(json({ detail: [{ code: 7 }] }, 422)).message).not.toContain('[object Object]')
    expect(errorFromResponse(json({ detail: { message: 'Invalid canvas payload', field: 'nodes' } }, 422)).message).toContain('Invalid canvas payload')
    // a field named like the balance is not a credit refusal; the server saying so is
    const field = errorFromResponse(json({ detail: [{ loc: ['body', 'credits'], msg: 'Field required' }] }, 422))
    expect(field.noCredit).toBeUndefined()
    expect(field.message).toContain('credits: Field required')
    expect(errorFromResponse(json({ detail: [{ loc: ['body'], msg: 'Insufficient balance' }] }, 400)).noCredit).toBe(true)
    expect(errorFromResponse(json({ detail: 'x'.repeat(500) }, 400)).detail).toHaveLength(300)
  })

  it('refuses unsafe ids before calling the transport', async () => {
    const server = fakeServer()
    const api = createCanvasappApi(server.transport)
    await expect(api.getProject('../me')).rejects.toBeInstanceOf(CanvasappError)
    expect(server.calls.length).toBe(0)
  })

  it('desktop transport is unavailable without the bridge and unwraps bridge responses', async () => {
    const none = createDesktopTransport(() => null)
    expect((await none.available()).ok).toBe(false)
    await expect(none.request({ method: 'GET', path: '/api/me' })).rejects.toMatchObject({ code: 'unavailable' })

    const bridge: CanvasappBridge = {
      status: async () => ({ ok: true, authenticated: true }),
      login: async () => ({ ok: true, authenticated: true }),
      logout: async () => ({ ok: true }),
      request: async (r) => (r.path === '/api/me' ? { ok: true, status: 200, contentType: 'application/json', json: { credits_balance: 5 } } : { ok: false, code: 'not-allowed', message: 'no' }),
    }
    const t = createDesktopTransport(() => bridge)
    expect(await t.request({ method: 'GET', path: '/api/me' })).toEqual({ status: 200, contentType: 'application/json', json: { credits_balance: 5 } })
    await expect(t.request({ method: 'DELETE', path: '/api/projects/x' })).rejects.toMatchObject({ code: 'forbidden', message: 'no [DELETE /api/projects/{id} · SanoVids desktop]' })
  })
})
