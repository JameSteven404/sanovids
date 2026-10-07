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
  CANVAS_NOT_READ_TEXT,
  CANVAS_NOT_SAVED_TEXT,
  createCanvasappProvider,
  JOBS_KEY,
  LEDGER_NOT_SAVED_TEXT,
  LIST_NEEDED_TEXT,
  RIVAL_SETTLING_TEXT,
  memoryStorage,
  MIN_POLL_MS,
  PROFILES_FALLBACK_TEXT,
  PROFILES_FORCE_MIN_MS,
  PROFILES_RETRY_MS,
  PROFILES_TTL_MS,
  STATE_KEY,
  type KeyValueStorage,
  type SiteScanInput,
} from '../canvasapp/adapter'
import type { SiteJobClaim } from '../canvasapp/siteJobs'
import {
  adoptedKey,
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
import { isSubmitUncertain, NO_LIMITS, type JobRequest } from '../types'

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
        created_at: new Date(state.now()).toISOString(),
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

/** A POST's anchor: job1 (warmup's job) had already ended — 'completed' — in the list read before it. */
const JOB1_DONE = { id: 'job1', status: 'completed' }

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
    // an explicit retry of it: nothing found, but a v0.2.0 record proves nothing about the list (no anchors) and is
    // long past → never posted again (neither on "sv_…" nor on any other node)
    await expect(provider.submit(req({ key: 'take_old', takeId: 'take_old', sceneId: 'scene_z' }))).rejects.toMatchObject({ uncertain: true, unverifiable: true })
    expect(server.state.jobs).toHaveLength(1)
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

  it('after reset() (logout → login) the bridge canvas is read back before the next PUT: a running job keeps its node', async () => {
    const server = fakeServer()
    const { provider, storage, clock } = setup(server)
    await provider.submit(req()) // scene A: job1 keeps running (queued), pictures up1 + up2
    const before = server.state.canvases.get('proj1') as CanvasPayload
    provider.reset()
    clock.t += 60_000
    const b = await provider.submit(req({ key: 'take_b', takeId: 'take_b', sceneId: 'scene_b', images: [{ n: 1, assetId: 'b', imageId: 'img_b' }], prompt: '@image_1' }))
    expect(b.remoteId).toBe('proj1:job2')
    expect(server.state.projects).toHaveLength(1) // found again by name, not created twice
    const calls = server.calls.map((c) => `${c.method} ${c.path}`)
    expect(calls.lastIndexOf('GET /api/projects/proj1')).toBeGreaterThan(calls.lastIndexOf('GET /api/projects'))
    expect(calls.lastIndexOf('GET /api/projects/proj1')).toBeLessThan(calls.lastIndexOf('PUT /api/projects/proj1/canvas'))
    const after = server.state.canvases.get('proj1') as CanvasPayload
    const videos = (c: CanvasPayload) => c.nodes.filter((n) => n.type === 'video')
    expect(videos(after).map((n) => n.id)).toEqual([node('scene_b'), node('scene_a')])
    // scene A's node exactly as it was, still wired to its pictures in @image order
    expect(videos(after)[1].data).toEqual(videos(before)[0].data)
    expect(uploadsIn(server.calls.filter(isPut).at(-1)!)).toEqual(['up3', 'up1', 'up2'])
    expect(after.connections.filter((c) => c.to === node('scene_a')).map((c) => c.order)).toEqual([1, 2])
    expect(savedEntries(storage)).toEqual([adoptedKey(node('scene_a')), 'scene_b'])

    // scene A again while job1 still runs, its job refused: its node (now its own entry again, never two) stays
    let refuse = 1
    server.state.extra = (r) => (r.method === 'POST' && r.path === '/api/video-jobs' && refuse-- > 0 ? json({ detail: 'unknown upload_id' }, 400) : undefined)
    await expect(provider.submit(req({ key: 'take_a2', takeId: 'take_a2' }))).rejects.toMatchObject({ code: 'bad-request' })
    expect(videos(server.state.canvases.get('proj1') as CanvasPayload).map((n) => n.id)).toEqual([node('scene_a'), node('scene_b')])
    expect(savedEntries(storage)).toEqual(['scene_b', 'scene_a'])
    await provider.submit(req({ key: 'take_c', takeId: 'take_c', sceneId: 'scene_c', images: [], prompt: 'mưa' }))
    expect(videos(server.state.canvases.get('proj1') as CanvasPayload).map((n) => n.id).sort()).toEqual(['scene_a', 'scene_b', 'scene_c'].map(node).sort())
    expect(server.state.jobs).toHaveLength(3)
  })

  it('a bridge canvas that cannot be read back is never overwritten: no PUT, no job, nothing remembered — read again next time', async () => {
    const server = fakeServer()
    const { provider, storage } = setup(server)
    await provider.submit(req()) // job1 keeps running on scene A
    provider.reset()
    const sceneB = () => req({ key: 'take_b', takeId: 'take_b', sceneId: 'scene_b', images: [], prompt: 'mưa' })
    const isGet = (r: TransportRequest) => r.method === 'GET' && r.path === '/api/projects/proj1'
    const puts = server.calls.filter(isPut).length

    server.state.extra = (r) => (isGet(r) ? json({ detail: 'boom' }, 500) : undefined)
    const failed = provider.submit(sceneB())
    await expect(failed).rejects.toMatchObject({ code: 'server' })
    const message = (await failed.catch((e: Error) => e.message)) as string
    expect(message.startsWith(`${CANVAS_NOT_SAVED_TEXT} ${CANVAS_NOT_READ_TEXT}`)).toBe(true)
    expect(message).toContain('[GET /api/projects/{id} · HTTP 500]')
    // an answer of another shape: unreadable too
    server.state.extra = (r) => (isGet(r) ? json({ canvas: { nodes: 'x' } }) : undefined)
    await expect(provider.submit(sceneB())).rejects.toMatchObject({ code: 'bad-response', message: expect.stringContaining(CANVAS_NOT_READ_TEXT) })
    // the login message stays as it is
    server.state.extra = (r) => (isGet(r) ? json({ detail: 'Not authenticated' }, 401) : undefined)
    await expect(provider.submit(sceneB())).rejects.toMatchObject({ code: 'login-required', message: expect.not.stringContaining(CANVAS_NOT_SAVED_TEXT) })
    expect(server.calls.filter(isPut).length).toBe(puts)
    expect(server.state.jobs).toHaveLength(1)
    expect(provider.bridgeProjectId()).toBeNull()
    expect(storage.get(STATE_KEY)).toBeNull()

    server.state.extra = null
    expect((await provider.submit(sceneB())).remoteId).toBe('proj1:job2')
    expect((server.state.canvases.get('proj1') as CanvasPayload).nodes.map((n) => n.id)).toContain(node('scene_a'))
  })

  it('a job the last job-list read shows running on a node this computer does not hold (another computer): read back and kept', async () => {
    const server = fakeServer()
    const { provider, clock } = setup(server)
    const a = await provider.submit(req()) // scene A on proj1
    // another computer on the same account puts its own scene on the bridge and runs a job on it
    const elsewhere = canvasNodeId('scene_elsewhere')
    const saved = server.state.canvases.get('proj1') as CanvasPayload
    const data = { model_profile: 'seedance_2_5', duration: 5, resolution: '480p', aspect_ratio: '16:9', mode: 't2v', prompt: 'ở máy khác' }
    server.state.canvases.set('proj1', { ...saved, nodes: [...saved.nodes, { id: elsewhere, type: 'video', x: 0, y: 2000, w: 390, h: 600, data }] })
    server.state.extra = (r) =>
      r.method === 'GET' && r.path.startsWith('/api/video-jobs?')
        ? json([
            { job_id: 'job1', status: 'queued', canvas_node_id: node('scene_a') },
            { job_id: 'other', status: 'processing', canvas_node_id: elsewhere },
          ])
        : undefined
    clock.t += MIN_POLL_MS
    await provider.poll([a.remoteId]) // the engine's poll: the job list is read
    const reads = () => server.calls.filter((c) => c.method === 'GET' && c.path === '/api/projects/proj1').length
    const videos = () => (server.state.canvases.get('proj1') as CanvasPayload).nodes.filter((n) => n.type === 'video').map((n) => n.id)
    expect(reads()).toBe(0)
    await provider.submit(req({ key: 'take_b', takeId: 'take_b', sceneId: 'scene_b', images: [], prompt: 'mưa' }))
    expect(reads()).toBe(1)
    expect(videos().sort()).toEqual([node('scene_a'), node('scene_b'), elsewhere].sort())
    expect((server.state.canvases.get('proj1') as CanvasPayload).nodes.find((n) => n.id === elsewhere)?.data).toEqual(data)
    // held from now on: not read again
    await provider.submit(req({ key: 'take_c', takeId: 'take_c', sceneId: 'scene_c', images: [], prompt: 'nắng' }))
    expect(reads()).toBe(1)
    expect(videos()).toContain(elsewhere)
  })

  it('a job running on a node that is NOT on the canvas (deleted on the site, stuck in queued): read back once, never again — not even to fail a take', async () => {
    const server = fakeServer()
    const { provider, clock } = setup(server)
    const a = await provider.submit(req()) // scene A on proj1
    const gone = canvasNodeId('scene_deleted_on_site')
    server.state.extra = (r) =>
      r.method === 'GET' && r.path.startsWith('/api/video-jobs?')
        ? json([
            { job_id: 'job1', status: 'queued', canvas_node_id: node('scene_a') },
            { job_id: 'stuck', status: 'queued', canvas_node_id: gone },
          ])
        : undefined
    const reads = () => server.calls.filter((c) => c.method === 'GET' && c.path === '/api/projects/proj1').length
    clock.t += MIN_POLL_MS
    await provider.poll([a.remoteId])
    await provider.submit(req({ key: 'take_b', takeId: 'take_b', sceneId: 'scene_b', images: [], prompt: 'mưa' }))
    expect(reads()).toBe(1) // looked for it once: not there
    // later polls show it again, and now the canvas cannot be read: the take is still sent (nothing there to keep)
    const lists = server.state.extra
    server.state.extra = (r) => (r.method === 'GET' && r.path === '/api/projects/proj1' ? json({ detail: 'boom' }, 503) : lists(r))
    for (let i = 0; i < 3; i++) {
      clock.t += MIN_POLL_MS
      await provider.poll([a.remoteId])
      await provider.submit(req({ key: `take_n${i}`, takeId: `take_n${i}`, sceneId: `scene_${i}`, images: [], prompt: `cảnh ${i}` }))
    }
    expect(reads()).toBe(1)
    expect(server.state.jobs.map((j) => j.body.client_request_id)).toEqual(['take_1', 'take_b', 'take_n0', 'take_n1', 'take_n2'].map(clientRequestIdFor))
  })

  it('logout → login with per-project nodes: the nodes read back of two projects sharing a scene id and a legacy node all stay; each scene replaces only its own', async () => {
    const server = fakeServer()
    const { provider, storage, clock } = setup(server)
    const t2v = (over: Partial<JobRequest>) => req({ images: [], prompt: 'mưa', ...over })
    await provider.submit(t2v({ key: 'take_a' })) // prj_a / scene_a: job1 runs
    await provider.submit(t2v({ key: 'take_b', takeId: 'take_b', sanovidsProjectId: 'prj_b', prompt: 'nắng' })) // prj_b / scene_a: job2 runs
    const mine = node('scene_a')
    const theirs = sceneNodeId('prj_b', 'scene_a')
    const legacy = canvasNodeId('scene_a') // an older build's node of that scene id, a job still running on it
    expect(new Set([mine, theirs, legacy]).size).toBe(3)
    const saved = server.state.canvases.get('proj1') as CanvasPayload
    const data = { model_profile: 'seedance_2_5', duration: 5, resolution: '480p', aspect_ratio: '16:9', mode: 't2v', prompt: 'bản cũ' }
    server.state.canvases.set('proj1', { ...saved, nodes: [...saved.nodes, { id: legacy, type: 'video', x: 0, y: 2000, w: 390, h: 600, data }] })
    server.state.jobs.push({ job_id: 'old', status: 'processing', project_id: 'proj1', canvas_node_id: legacy, body: {} })
    provider.reset() // Đăng xuất: entries forgotten, the job ledger kept
    clock.t += 60_000
    const videos = () => (server.state.canvases.get('proj1') as CanvasPayload).nodes.filter((n) => n.type === 'video').map((n) => n.id)

    // prj_a / scene_b: the canvas is read back first — all three running nodes stay next to the new one
    await provider.submit(t2v({ key: 'take_c', takeId: 'take_c', sceneId: 'scene_b', prompt: 'gió' }))
    expect(videos().sort()).toEqual([mine, theirs, legacy, node('scene_b')].sort())
    expect(rawEntries(storage).sort()).toEqual([adoptedKey(legacy), adoptedKey(mine), adoptedKey(theirs), sceneNodeKey('prj_a', 'scene_b')].sort())

    // prj_b / scene_a again: ITS node read back is replaced (one node per id), prj_a's and the legacy one are untouched
    await provider.submit(t2v({ key: 'take_b2', takeId: 'take_b2', sanovidsProjectId: 'prj_b', prompt: 'nắng 2' }))
    const after = server.state.canvases.get('proj1') as CanvasPayload
    expect(videos().sort()).toEqual([mine, theirs, legacy, node('scene_b')].sort())
    expect(after.nodes.find((n) => n.id === theirs)?.data).toMatchObject({ prompt: 'nắng 2' })
    expect(after.nodes.find((n) => n.id === mine)?.data).toMatchObject({ prompt: 'mưa' })
    expect(after.nodes.find((n) => n.id === legacy)?.data).toEqual(data)
    expect(rawEntries(storage)).toContain(sceneNodeKey('prj_b', 'scene_a'))
    expect(rawEntries(storage)).not.toContain(adoptedKey(theirs))
    expect(jobPosts(server).at(-1)!.json).toMatchObject({ canvas_node_id: theirs })
    // every take sent once
    expect(jobPosts(server).map((c) => (c.json as { client_request_id: string }).client_request_id)).toEqual(
      ['take_a', 'take_b', 'take_c', 'take_b2'].map(clientRequestIdFor),
    )
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
    server.state.jobs[0].status = 'completed'
    // the job list provably reaches back to that POST (job1 had already ended before it and is still listed): no job
    // was created → the take may go again, and its PUT is what fails here
    const warmup = { remoteId: 'proj1:job1', at: 1_000_000, nodeId: canvasNodeId('scene_w') }
    const lost = { projectId: 'proj1', nodeId: canvasNodeId('scene_a'), at: 1, before: [], anchors: { ended: [JOB1_DONE], open: [] } }
    storage.set(JOBS_KEY, JSON.stringify({ jobs: { warmup }, sent: { take_1: lost } }))
    server.state.extra = (r) => (isPut(r) ? json({ detail: 'Invalid canvas payload' }, 422) : undefined)
    const again = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage })
    const message = (await again.submit(req()).catch((e: Error) => e.message)) as string
    expect(message).toContain('lần gửi trước vẫn chưa rõ đã bị trừ credit chưa')
    expect(message).not.toContain(CANVAS_NOT_SAVED_TEXT)
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
        sleep: () => new Promise<void>((resolve) => void wakers.push(resolve)),
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
    // take_a: an older take of the scene whose POST was cut off (page closed) and never reached canvasapp; the list read
    // before it showed `old`, a job that had already ended (its anchor: a later list that still shows it reaches back)
    const { provider, server, storage, clock, waiting, wake } = restarted({
      ledger: { sent: { take_a: { projectId: 'proj1', nodeId: node('scene_a'), at: 10_000_000 - 60_000, before: [], anchors: { ended: [{ id: 'old', status: 'completed' }], open: [] } } } },
    })
    server.state.jobs.push({ job_id: 'old', status: 'completed', project_id: 'proj1', canvas_node_id: node('scene_w'), created_at: new Date(9_000_000).toISOString(), body: {} })
    server.state.dedupe = dedupe
    server.state.loseAnswers = 1
    // take_b, a new take of the same scene: canvasapp creates its job, the answer is lost → it waits, then looks
    const b = provider.submit(req({ key: 'take_b', takeId: 'take_b' }))
    await waiting()
    expect(server.state.jobs).toHaveLength(2)
    // meanwhile the page reopens and looks for take_a's job: the new job on that node may be take_b's → not adopted
    clock.t += 5_000
    expect(await provider.recover!(req({ key: 'take_a', takeId: 'take_a' }))).toBeNull()
    wake()
    expect(await b).toEqual({ remoteId: 'proj1:job2' })
    expect(jobPosts(server)).toHaveLength(1) // never posted again
    expect(server.state.jobs).toHaveLength(2)
    // take_b's job is known now: take_a finds nothing of its own, and the list still shows `old` (it reaches back to
    // take_a's POST) — an explicit retry sends it, once, and it gets its own job
    expect(await provider.recover!(req({ key: 'take_a', takeId: 'take_a' }))).toBeNull()
    expect(await provider.submit(req({ key: 'take_a', takeId: 'take_a' }))).toEqual({ remoteId: 'proj1:job3' })
    expect(jobPosts(server)).toHaveLength(2)
    expect(jobPosts(server)[1].json).toMatchObject({ canvas_node_id: node('scene_a'), client_request_id: clientRequestIdFor('take_a') })
    expect(server.state.jobs).toHaveLength(3)
    expect(sentRecords(storage)).toEqual({})
  })

  it('a job already listed before a POST is never taken for it (even a job of an older take still in doubt)', async () => {
    // take_c, older, in doubt: its job job_c exists on the scene's node (the answer was lost, then the app closed)
    const { provider, server, clock, waiting, wake } = restarted({
      ledger: { sent: { take_c: { projectId: 'proj1', nodeId: node('scene_a'), at: 10_000_000 - 60_000, before: [] } } },
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
          take_a: { projectId: 'proj1', nodeId: legacy, at: 10_000_000 - 120_000, before: [] },
          take_b: { projectId: 'proj1', nodeId: legacy, at: 10_000_000 - 60_000, before: [] },
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
   * Take B of the same scene 45 s later (sooner it waits: RIVAL_SETTLING_TEXT): the list answers right before its POST
   * (A's job is there), then B's POST never reaches canvasapp and the list is down again → "không rõ" too. One job on
   * the node, two takes in doubt.
   */
  async function twoInDoubt() {
    const t = restarted()
    const down = flakyList(t.server)
    const A = req({ key: 'take_a', takeId: 'take_a', prompt: 'take A' })
    const B = req({ key: 'take_b', takeId: 'take_b', prompt: 'take B' })
    t.server.state.loseAnswers = 1
    down.list = true
    const a = t.provider.submit(A)
    await t.wakeTwice()
    await expect(a).rejects.toMatchObject({ uncertain: true })
    t.clock.t += 45_000
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
    down.list = true
    const a = provider.submit(A)
    await wakeTwice()
    await expect(a).rejects.toMatchObject({ uncertain: true })
    clock.t += 45_000
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

  it('a take in doubt sent again next to another one: the list read before its POST fails → not sent again, still “maybe billed”', async () => {
    const { provider, server, storage, clock, down, A, B } = await twoInDoubt()
    const before = sentRecords(storage).take_b
    down.reads = [true, false] // B's lookup answers (A's job is not B's), the read before its POST fails
    // (saving the canvas takes a while: the lookup's read is too old to stand for the read before the POST)
    const flaky = server.state.extra!
    server.state.extra = (r) => {
      if (isPut(r)) clock.t += MIN_POLL_MS
      return flaky(r)
    }
    const message = (await provider.submit(B).catch((e: Error) => e.message)) as string
    expect(message).toMatch(/^Không đọc được danh sách job .* Lần này chưa gửi lại yêu cầu tạo video \(lần gửi trước vẫn chưa rõ/)
    expect(jobPosts(server)).toHaveLength(2)
    expect(sentRecords(storage).take_b).toEqual(before) // its first POST is still looked for
    expect(await provider.submit(A)).toEqual({ remoteId: 'proj1:job1' })
    expect(await provider.submit(B)).toEqual({ remoteId: 'proj1:job2' })
  })

  it('the lookups after a lost answer ask the gateway for a FRESH job list (never main’s cached one of up to 15 s ago); polls do not', async () => {
    const { provider, server, clock, waiting, wake } = restarted()
    // canvasapp makes the job but lists it only 20 s after the POST (inside the 30 s the lookups bet on)
    const T0 = clock.t
    server.state.extra = (r) =>
      r.method === 'GET' && r.path.startsWith('/api/video-jobs?') && clock.t < T0 + 20_000
        ? json(server.state.jobs.filter((j) => j.body.client_request_id !== clientRequestIdFor('take_1')).map(({ body: _b, ...j }) => j))
        : undefined
    // main in front: a list cached less than 15 s ago is reused — unless the read is `fresh` and the cache is ≥ 5 s old
    const cache = new Map<string, { at: number; res: TransportResponse }>()
    const inner = server.transport.request
    const lists: { at: number; fresh: boolean; served: 'cache' | 'site' }[] = []
    server.transport.request = async (r) => {
      const list = r.method === 'GET' && r.path.startsWith('/api/video-jobs?')
      const post = r.method === 'POST' && r.path === '/api/video-jobs'
      const hit = list ? cache.get(r.path) : undefined
      if (hit && clock.t - hit.at < (r.fresh === true ? 5_000 : MIN_POLL_MS)) {
        lists.push({ at: clock.t, fresh: r.fresh === true, served: 'cache' })
        return hit.res
      }
      if (post) cache.clear()
      const at = clock.t
      try {
        const res = await inner(r)
        if (list) {
          lists.push({ at, fresh: r.fresh === true, served: 'site' })
          if (res.status === 200) cache.set(r.path, { at, res })
        }
        return res
      } finally {
        if (post) cache.clear()
      }
    }
    server.state.loseAnswers = 1
    const run = provider.submit(req())
    await waiting()
    // the engine's poll right after the lost answer fills main's cache (the job is not listed yet)
    clock.t = T0 + 16_000
    await provider.poll(['proj1:other'])
    clock.t = T0 + 17_000
    wake() // lookup 1: fresh, but main may still give the poll's answer of a second ago (its fresh floor is 5 s)
    await waiting()
    clock.t = T0 + 30_000
    wake() // lookup 2: main still holds a list < 15 s old, but a fresh read never takes it → the job is there
    expect(await run).toEqual({ remoteId: 'proj1:job1' })
    expect(jobPosts(server)).toHaveLength(1) // never posted again
    expect(lists.filter((l) => l.at >= T0 + 30_000)).toEqual([{ at: T0 + 30_000, fresh: true, served: 'site' }])
    expect(lists.find((l) => l.at === T0 + 16_000)).toMatchObject({ fresh: false })
  })

  it('a POST sent again after nothing was found carries its own time (a take posting next to it later knows when to look)', async () => {
    const { provider, server, storage, clock, waiting, wake } = restarted()
    server.state.unreachablePosts = 2
    const run = provider.submit(req())
    const first = clock.t
    await waiting()
    expect(sentRecords(storage).take_1.at).toBe(first)
    clock.t += 15_000
    wake()
    await waiting()
    clock.t += 15_000
    wake() // nothing found twice → sent once more
    await waiting()
    expect(jobPosts(server)).toHaveLength(2)
    expect(sentRecords(storage).take_1.at).toBe(first + 30_000)
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
   * electron/main.cjs in front of the fake: GET /api/video-jobs answered from a cache for 15 s (stamped when the request
   * was SENT — never when its answer arrived), dropped at every POST /api/video-jobs (CANVASAPP_JOBS_MIN_MS,
   * canvasappJobListCache). `latency()`: how long the next job-list read takes (the clock moves after canvasapp
   * handled it).
   */
  function mainListCache(server: ReturnType<typeof fakeServer>, clock: { t: number }, latency: () => number = () => 0) {
    const cache = new Map<string, { at: number; res: TransportResponse }>()
    const inner = server.transport.request
    server.transport.request = async (r) => {
      const list = r.method === 'GET' && r.path.startsWith('/api/video-jobs?')
      const post = r.method === 'POST' && r.path === '/api/video-jobs'
      const hit = list ? cache.get(r.path) : undefined
      if (hit && clock.t - hit.at < MIN_POLL_MS) return hit.res
      if (post) cache.clear()
      const sentAt = clock.t
      try {
        const res = await inner(r)
        if (list) clock.t += latency()
        if (list && res.status === 200) cache.set(r.path, { at: sentAt, res })
        return res
      } finally {
        if (post) cache.clear()
      }
    }
  }

  it('a job-list answer main may have cached (15 s) never counts as fresher than it is: a later take never settles on an earlier take’s job', async () => {
    const { provider, server, storage, clock, wakeTwice } = restarted()
    mainListCache(server, clock)
    const T0 = clock.t
    const down = flakyList(server)
    // canvasapp lists take A's job only 20 s after its POST (inside the 30 s the lookups bet on)
    const flaky = server.state.extra!
    server.state.extra = (r) =>
      flaky(r) ??
      (r.method === 'GET' && r.path.startsWith('/api/video-jobs?') && clock.t < T0 + 20_000
        ? json(server.state.jobs.filter((j) => j.body.prompt !== 'take A').map(({ body: _b, ...j }) => j))
        : undefined)
    const A = req({ key: 'take_a', takeId: 'take_a', prompt: 'take A' })
    const B = req({ key: 'take_b', takeId: 'take_b', prompt: 'take B' })
    // A: canvasapp makes its job, the answer is lost and the list cannot be read → "không rõ"
    server.state.loseAnswers = 1
    down.list = true
    const a = provider.submit(A)
    await wakeTwice()
    await expect(a).rejects.toMatchObject({ uncertain: true })
    down.list = false
    // 16 s after A's POST: a read (A looked up again) — A's job not listed yet; main caches that answer
    clock.t = T0 + 16_000
    expect(await provider.recover!(A)).toBeNull()
    // B, same scene, 30.5 s after A's POST: no read could show yet whether A's POST made a job (that cached answer
    // least of all) → back to the queue, nothing sent
    clock.t = T0 + 30_500
    await expect(provider.submit(B)).rejects.toMatchObject({ code: 'deferred', message: RIVAL_SETTLING_TEXT })
    expect(jobPosts(server)).toHaveLength(1)
    // sent again 16 s later: the read right before its POST is fresh and shows A's job; B's POST never arrives
    clock.t = T0 + 46_500
    server.state.unreachablePosts = 1
    const b = provider.submit(B)
    await wakeTwice()
    // nothing of its own on the node (A's job was listed before it) → B posts once more and gets its own job
    expect(await b).toEqual({ remoteId: 'proj1:job2' })
    // ...and A finds its own: each take its video, nothing paid twice
    clock.t += 60_000
    expect(await provider.submit(A)).toEqual({ remoteId: 'proj1:job1' })
    expect(jobPosts(server)).toHaveLength(3) // A's, B's (never arrived), B again
    expect(server.state.jobs.map((j) => j.body.prompt)).toEqual(['take A', 'take B'])
    expect(sentRecords(storage)).toEqual({})
  })

  it('a slow job-list answer main cached is never taken for a newer one (the cache is stamped when its request left)', async () => {
    // the reviewer's case: a lookup sent at T0 + 27 s is answered 5 s later; a read at T0 + 46 s must not be served from
    // it as if it showed the list of T0 + 32 s
    const { provider, server, storage, clock, wakeTwice } = restarted()
    let slow = 0
    mainListCache(server, clock, () => {
      const ms = slow
      slow = 0
      return ms
    })
    const T0 = clock.t
    const down = flakyList(server)
    // canvasapp lists take A's job only 28 s after its POST (inside the 30 s the lookups bet on)
    const flaky = server.state.extra!
    server.state.extra = (r) =>
      flaky(r) ??
      (r.method === 'GET' && r.path.startsWith('/api/video-jobs?') && clock.t < T0 + 28_000
        ? json(server.state.jobs.filter((j) => j.body.prompt !== 'take A').map(({ body: _b, ...j }) => j))
        : undefined)
    const A = req({ key: 'take_a', takeId: 'take_a', prompt: 'take A' })
    const B = req({ key: 'take_b', takeId: 'take_b', prompt: 'take B' })
    server.state.loseAnswers = 1
    down.list = true
    const a = provider.submit(A)
    await wakeTwice()
    await expect(a).rejects.toMatchObject({ uncertain: true })
    down.list = false
    // a lookup sent at T0 + 27 s (A's job not listed yet), its answer 5 s later
    clock.t = T0 + 27_000
    slow = 5_000
    expect(await provider.recover!(A)).toBeNull()
    expect(clock.t).toBe(T0 + 32_000)
    // B at T0 + 46 s, 19 s after that read was sent: main's cache (stamped at 27 s) is over → a fresh read, which shows
    // A's job (B's `before`); B's POST never arrives
    clock.t = T0 + 46_000
    server.state.unreachablePosts = 1
    const b = provider.submit(B)
    await wakeTwice()
    expect(await b).toEqual({ remoteId: 'proj1:job2' }) // never A's job
    clock.t += 60_000
    expect(await provider.submit(A)).toEqual({ remoteId: 'proj1:job1' })
    expect(server.state.jobs.map((j) => [j.job_id, j.body.prompt])).toEqual([
      ['job1', 'take A'],
      ['job2', 'take B'],
    ])
    expect(sentRecords(storage)).toEqual({})
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
    const { provider, server, clock } = setup()
    await provider.submit(req()) // scene_a on the bridge canvas with img_a / img_b
    clock.t += 60_000 // the site job is the newest run of that node
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

  it('no hints for a job whose node SanoVids rewrote since (a later run of the scene, or a POST sent after it was listed)', async () => {
    const { provider, server, clock } = setup()
    await provider.submit(req()) // scene_a: img_a / img_b
    clock.t += 60_000
    const site = siteJob(server, { body: { prompt: '@image_1 and @image_2' } }) // made on the site from that node
    clock.t += 60_000
    // the user swaps a character and runs the scene again in SanoVids, same prompt: the node now holds img_a / img_x
    blobs.img_x = new Blob(['x'], { type: 'image/png' })
    await provider.submit(req({ key: 'take_2', takeId: 'take_2', images: [{ n: 1, imageId: 'img_a' }, { n: 2, imageId: 'img_x' }] as JobRequest['images'] }))
    const scan = await provider.scanSiteJobs(input({ takeIds: new Set(['take_1', 'take_2']) }))
    expect(scan.candidates.map((c) => [c.jobId, c.hints])).toEqual([[site.job_id, []]])
    // a POST whose answer is unknown, sent after a read that listed the job, rewrote the node too
    const s2 = setup()
    await s2.provider.submit(req())
    s2.clock.t += 60_000
    const later = siteJob(s2.server, { body: { prompt: '@image_1 and @image_2' } })
    const ledger = JSON.parse(s2.storage.get(JOBS_KEY)!)
    ledger.sent.take_9 = { projectId: 'proj1', nodeId: node('scene_a'), at: s2.clock.t, before: [later.job_id] }
    s2.storage.set(JOBS_KEY, JSON.stringify(ledger))
    const again = createCanvasappProvider({ api: createCanvasappApi(s2.server.transport), getBlob: async (id) => blobs[id] ?? null, storage: s2.storage, now: () => s2.clock.t })
    const scan2 = await again.scanSiteJobs(input({ takeIds: new Set(['take_1']) }))
    expect(scan2.candidates.map((c) => [c.jobId, c.hints])).toEqual([[later.job_id, []]])
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

  it('a job an unanswered POST may own is refused at claim time even when the scan offered it (a POST sent after the scan)', async () => {
    const { server, clock } = setup(fakeServer({ projects: [{ project_id: 'proj1', name: BRIDGE_PROJECT_NAME }] }))
    const wakers: (() => void)[] = []
    // a provider whose waits after an unanswered POST hang until the test releases them
    const p = createCanvasappProvider({
      api: createCanvasappApi(server.transport),
      getBlob: async (id) => blobs[id] ?? null,
      storage: memoryStorage(),
      now: () => clock.t,
      sleep: () => new Promise<void>((resolve) => void wakers.push(resolve)),
    })
    siteJob(server)
    const scan = await p.scanSiteJobs(input())
    const [c] = scan.candidates
    expect(c.jobId).toBe('site1')
    // logout + login meanwhile (what was read is forgotten), and the job list cannot be read right before take_b's POST
    // (sent all the same: no other take in doubt there): SanoVids does not know which jobs were on the node before it —
    // its answer is lost, so its "sent" record may own the site job (made within the time window, not known to be older)
    p.reset()
    let listDown = true
    server.state.extra = (r) => (listDown && r.method === 'GET' && r.path.startsWith('/api/video-jobs?') ? ((listDown = false), json({ detail: 'x' }, 503)) : undefined)
    server.state.loseAnswers = 1
    const b = p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))
    await vi.waitFor(() => expect(wakers.length).toBeGreaterThan(0))
    expect(p.claimSiteJobs([{ key: 't_x', remoteId: c.remoteId, nodeId: NODE, job: c.job, reimport: false }])).toEqual([])
    const again = await p.scanSiteJobs(input())
    expect(again.skipped).toContainEqual({ jobId: 'site1', sceneId: 'scene_a', code: 'maybe-pending', pendingTakeId: 'take_b' })
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
      sleep: () => new Promise<void>((resolve) => void wakers.push(resolve)),
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
          sleep: () => new Promise<void>((resolve) => void wakers.push(resolve)),
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
    /**
     * A job that had already ended when take_b's POST was sent (another session's node, never importable here): with
     * `anchored` take_b's record names it (`anchors`, the read before the POST) — a later list that still shows it
     * reaches back to that POST, so "not listed" there means "never created".
     */
    const endedBefore = (w: ReturnType<typeof world>, anchored: boolean) => {
      if (!anchored) return {}
      w.server.state.jobs.push({ job_id: 'old', status: 'completed', project_id: 'proj1', canvas_node_id: canvasNodeId('elsewhere'), created_at: new Date(w.clock.t - 3600_000).toISOString(), body: {} })
      return { anchors: { ended: [{ id: 'old', status: 'completed' }], open: [] } }
    }
    const importLater = async (w: ReturnType<typeof world>, anchored = false) => {
      const t0 = w.clock.t
      const anchors = endedBefore(w, anchored)
      w.storage.set(JOBS_KEY, JSON.stringify({ jobs: {}, sent: { take_b: { projectId: 'proj1', nodeId: NODE, at: t0, before: [], ...anchors } }, imported: {} }))
      w.restart()
      w.clock.t = t0 + 15 * 3600_000
      const site = siteJob(w.server)
      const scan = await w.p.scanSiteJobs(input())
      expect(scan.candidates.map((c) => c.jobId)).toEqual([site.job_id])
      const [c] = scan.candidates
      expect(w.p.claimSiteJobs([{ key: 't_imp', remoteId: c.remoteId, nodeId: c.nodeId, job: c.job, reimport: false }])).toEqual(['t_imp'])
      return { t0, site }
    }

    it('(d) imported long after a POST that never arrived: "Chạy lại" never takes the imported job — posted once (the list reaches back), its own job', async () => {
      const w = world()
      const { site } = await importLater(w, true)
      expect(await w.p.recover!(req({ key: 'take_b', takeId: 'take_b', images: [] }))).toBeNull()
      expect(await w.p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))).toEqual({ remoteId: 'proj1:job3' })
      expect(w.server.state.jobs.map((j) => j.job_id)).toEqual(['old', site.job_id, 'job3'])
      expect(jobPosts(w.server)).toHaveLength(1)
    })

    it('(d2) the same without anything older than that POST in the list (it may be cut): never posted again — "Tạo lại"', async () => {
      const w = world()
      const { site } = await importLater(w)
      await expect(w.p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))).rejects.toMatchObject({ uncertain: true, unverifiable: true })
      expect(w.server.state.jobs.map((j) => j.job_id)).toEqual([site.job_id])
      expect(jobPosts(w.server)).toHaveLength(0)
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
      expect(again.skipped).toContainEqual({ jobId: 'job1', sceneId: 'scene_a', code: 'maybe-pending', pendingTakeId: 'take_b' })
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

    it.each([
      ['the list reaches back to that POST: posted once, its own job', true],
      ['nothing older than that POST is listed (the list may be cut): never posted again — the stress tester’s double charge', false],
    ])('(h) a site job made long after a POST that never arrived, not imported: "Chạy lại" never takes it — %s', async (_label, anchored) => {
      const w = world()
      const t0 = w.clock.t
      const anchors = endedBefore(w, anchored)
      w.storage.set(JOBS_KEY, JSON.stringify({ jobs: {}, sent: { take_b: { projectId: 'proj1', nodeId: NODE, at: t0, before: [], ...anchors } }, imported: {} }))
      w.restart()
      // a day later — past what that POST may own (inPostWindow) — the user runs the node on canvasapp's page
      w.clock.t = t0 + 24 * 3600_000
      const site = siteJob(w.server)
      expect((await w.p.scanSiteJobs(input())).candidates.map((c) => c.jobId)).toEqual([site.job_id])
      expect(await w.p.recover!(req({ key: 'take_b', takeId: 'take_b', images: [] }))).toBeNull()
      if (anchored) {
        expect(await w.p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))).toEqual({ remoteId: 'proj1:job3' })
        expect(jobPosts(w.server)).toHaveLength(1)
      } else {
        await expect(w.p.submit(req({ key: 'take_b', takeId: 'take_b', images: [] }))).rejects.toMatchObject({ uncertain: true, unverifiable: true })
        expect(jobPosts(w.server)).toHaveLength(0)
      }
      // the lookup and the import agree: still importable, never both a POST's and a new take's
      expect((await w.p.scanSiteJobs(input())).candidates.map((c) => c.jobId)).toEqual([site.job_id])
    })
  })
})

describe('canvasapp adapter: "not in the job list" proves "never created" only when the list reaches back', () => {
  const NODE_A = node('scene_a')
  const NODE_W = node('scene_w')
  const isList = (r: TransportRequest) => r.method === 'GET' && r.path.startsWith('/api/video-jobs?')
  const isPost = (r: TransportRequest) => r.method === 'POST' && r.path === '/api/video-jobs'
  const posts = (server: ReturnType<typeof fakeServer>) => server.calls.filter(isPost).length
  /** warmup's job (job1, scene_w) as this computer's ledger holds it. */
  const warmupJob = { remoteId: 'proj1:job1', at: 1_000_000, nodeId: NODE_W }
  /** A POST of take_1 (scene_a) whose answer was lost long ago. */
  const lost = (over: Record<string, unknown> = {}) => ({ projectId: 'proj1', nodeId: NODE_A, at: 1, before: [], ...over })
  const unverifiable = { code: 'network', uncertain: true, unverifiable: true }

  /** The bridge project exists and job1 (warmup) ran there; then the app restarts with `ledger` persisted. */
  async function restartWith(ledger: Record<string, unknown>, list?: unknown[]) {
    const s = setup()
    await s.provider.submit(req({ key: 'warmup', takeId: 'warmup', sceneId: 'scene_w', images: [] }))
    s.server.state.jobs[0].status = 'completed'
    if (list) s.server.state.extra = (r) => (isList(r) ? json(list) : undefined)
    s.storage.set(JOBS_KEY, JSON.stringify(ledger))
    const provider = createCanvasappProvider({
      api: createCanvasappApi(s.server.transport),
      getBlob: async (id) => blobs[id] ?? null,
      storage: s.storage,
      now: () => s.clock.t,
      sleep: async () => undefined,
    })
    return { ...s, provider }
  }

  it('retry long after: an ended job older than the request is still listed → sent again with the SAME key', async () => {
    const s = await restartWith({ jobs: { warmup: warmupJob }, sent: { take_1: lost({ anchors: { ended: [JOB1_DONE], open: [] } }) } })
    expect((await s.provider.submit(req())).remoteId).toBe('proj1:job2')
    expect(s.server.state.jobs[1].body.client_request_id).toBe(clientRequestIdFor('take_1'))
  })

  it('retry long after: the list no longer shows anything older than the request (cut) → never posted again', async () => {
    // job1 had ended before the POST, but the list now shows only newer jobs (cut to its newest)
    const newer = [{ job_id: 'job7', status: 'completed', canvas_node_id: NODE_W, created_at: new Date(2_000_000).toISOString() }]
    const s = await restartWith({ jobs: { warmup: warmupJob }, sent: { take_1: lost({ anchors: { ended: [JOB1_DONE], open: [] } }) } }, newer)
    await expect(s.provider.submit(req())).rejects.toMatchObject(unverifiable)
    expect(posts(s.server)).toBe(1) // warmup only
    expect(JSON.parse(s.storage.get(JOBS_KEY)!).sent.take_1).toBeTruthy() // still remembered
  })

  it('a record written before anchors existed (older builds), retried long after → never posted again; damaged anchors count as none', async () => {
    const s = await restartWith({ jobs: { warmup: warmupJob }, sent: { take_1: lost() } })
    await expect(s.provider.submit(req())).rejects.toMatchObject(unverifiable)
    expect(posts(s.server)).toBe(1)
    const d = await restartWith({ jobs: { warmup: warmupJob }, sent: { take_1: lost({ anchors: 'job1' }) } })
    await expect(d.provider.submit(req())).rejects.toMatchObject(unverifiable)
    // ids without the status they had cannot be checked for changes: they count as none
    const f = await restartWith({ jobs: { warmup: warmupJob }, sent: { take_1: lost({ anchors: { ended: ['job1'], open: [] } }) } })
    await expect(f.provider.submit(req())).rejects.toMatchObject(unverifiable)
    expect(posts(f.server)).toBe(1)
    const e = await restartWith({
      jobs: { warmup: warmupJob },
      sent: { take_1: lost({ anchors: { ended: [1, null, 'job1', { id: 'job1' }, { id: 'job1', status: 'completed', finished: 7 }, JOB1_DONE] } }) },
    })
    expect((await e.provider.submit(req())).remoteId).toBe('proj1:job2') // the one valid anchor is used
  })

  it('an empty list proves nothing when this computer knows a job of that project', async () => {
    const s = await restartWith({ jobs: { warmup: warmupJob }, sent: { take_1: lost({ anchors: { ended: [], open: [] } }) } }, [])
    await expect(s.provider.submit(req())).rejects.toMatchObject(unverifiable)
    expect(posts(s.server)).toBe(1)
  })

  it('one of this computer’s jobs made after the request is missing from the list (cut / out of order) → never posted again', async () => {
    const later = { remoteId: 'proj1:job9', at: 3_000_000, nodeId: NODE_W }
    const s = await restartWith({ jobs: { warmup: warmupJob, later }, sent: { take_1: lost({ at: 2_000_000, anchors: { ended: [JOB1_DONE], open: [] } }) } })
    s.clock.t = 4_000_000
    await expect(s.provider.submit(req())).rejects.toMatchObject(unverifiable)
    expect(posts(s.server)).toBe(1)
  })

  it('a job the list cannot tell apart (no canvas_node_id, no time) is never read as "not there"', async () => {
    const s = await restartWith({ jobs: { warmup: warmupJob }, sent: { take_1: lost({ anchors: { ended: [JOB1_DONE], open: [] } }) } }, [
      { job_id: 'job1', status: 'completed' },
      { job_id: 'mystery', status: 'queued' }, // could be take_1's: no node, no time
    ])
    await expect(s.provider.submit(req())).rejects.toMatchObject(unverifiable)
    expect(posts(s.server)).toBe(1)
  })

  it('right after a lost answer: no resend while an unknown job cannot be told apart; ONE resend (same key) when the list reaches back', async () => {
    for (const listed of [[{ job_id: 'mystery', status: 'queued' }], []]) {
      const s = setup()
      const provider = createCanvasappProvider({
        api: createCanvasappApi(s.server.transport),
        getBlob: async (id) => blobs[id] ?? null,
        storage: s.storage,
        now: () => s.clock.t,
        sleep: async () => undefined,
      })
      await provider.submit(req({ key: 'warmup', takeId: 'warmup', sceneId: 'scene_w', images: [] }))
      // the next POST is answered 502 without reaching canvasapp; the list shows job1 (this computer's, older) + `listed`
      s.server.state.extra = (r) =>
        isPost(r) && posts(s.server) === 2 ? json({ detail: 'Bad gateway' }, 502) : isList(r) ? json([{ job_id: 'job1', status: 'completed' }, ...listed]) : undefined
      if (listed.length) {
        await expect(provider.submit(req())).rejects.toMatchObject({ uncertain: true })
        expect(posts(s.server)).toBe(2)
      } else {
        expect((await provider.submit(req())).remoteId).toBe('proj1:job2')
        expect(posts(s.server)).toBe(3) // the lost one + ONE resend
        const keys = s.server.calls.filter(isPost).slice(1).map((c) => (c.json as { client_request_id: string }).client_request_id)
        expect(new Set(keys)).toEqual(new Set([clientRequestIdFor('take_1')]))
      }
    }
  })

  it('a POST records the last list read as anchors: the newest ended / not-ended jobs, at most 6 of each', async () => {
    const { provider, server, storage } = setup()
    await provider.submit(req({ key: 'warmup', takeId: 'warmup', sceneId: 'scene_w', images: [] }))
    const at = (n: number) => new Date(1_000_000 + n * 1000).toISOString()
    const listed = [
      ...Array.from({ length: 8 }, (_, i) => ({
        job_id: `done${i}`,
        status: i % 2 ? 'failed' : 'completed',
        created_at: at(i),
        ...(i === 6 ? { finished_at: at(30) } : i === 5 ? { finished_at: null } : {}),
      })),
      { job_id: 'run1', status: 'processing', created_at: at(20) },
      { job_id: 'run0', status: 'queued', created_at: at(10) },
    ]
    server.state.extra = (r) => (isList(r) ? json(listed) : undefined)
    await provider.poll(['proj1:job1']) // a job-list read
    let sent: Record<string, { anchors?: unknown }> = {}
    server.state.extra = (r) => {
      if (isPost(r)) sent = JSON.parse(storage.get(JOBS_KEY)!).sent
      return undefined
    }
    await provider.submit(req({ key: 'take_2', takeId: 'take_2', sceneId: 'scene_b' }))
    // ended ones with the status (and finished_at, when listed) they had: a later list must show them unchanged
    expect(sent.take_2.anchors).toEqual({
      ended: [
        { id: 'done7', status: 'failed' },
        { id: 'done6', status: 'completed', finished: at(30) },
        { id: 'done5', status: 'failed' },
        { id: 'done4', status: 'completed' },
        { id: 'done3', status: 'failed' },
        { id: 'done2', status: 'completed' },
      ],
      open: ['run1', 'run0'],
    })
  })

  it('a key whose ledger record was trimmed is never posted again (also after a restart)', async () => {
    // 100 newer "sent" records push take_1's out as soon as the ledger is saved again
    const sent: Record<string, unknown> = { take_1: lost() }
    for (let i = 0; i < 100; i++) sent[`other_${i}`] = lost({ at: 10 + i })
    const s = await restartWith({ jobs: { warmup: warmupJob }, sent })
    expect((await s.provider.submit(req({ key: 'take_x', takeId: 'take_x', sceneId: 'scene_x', images: [] }))).remoteId).toBe('proj1:job2')
    const ledger = JSON.parse(s.storage.get(JOBS_KEY)!)
    expect(ledger.sent.take_1).toBeUndefined()
    expect(ledger.dropped).toContain('take_1')
    await expect(s.provider.submit(req())).rejects.toMatchObject(unverifiable)
    expect(posts(s.server)).toBe(2) // warmup + take_x
    const again = createCanvasappProvider({ api: createCanvasappApi(s.server.transport), getBlob: async (id) => blobs[id] ?? null, storage: s.storage })
    await expect(again.submit(req())).rejects.toMatchObject(unverifiable)
    expect(posts(s.server)).toBe(2)
  })

  it('a retry (opts.retryOfUnknown) of a key this computer has no record of — ledger lost, written over or forgotten — is never posted', async () => {
    const s = setup()
    const make = (storage: KeyValueStorage) =>
      createCanvasappProvider({ api: createCanvasappApi(s.server.transport), getBlob: async (id) => blobs[id] ?? null, storage, now: () => s.clock.t, sleep: async () => undefined })
    const provider = make(s.storage)
    await provider.submit(req({ key: 'warmup', takeId: 'warmup', sceneId: 'scene_w', images: [] }))
    // take_1's POST is processed, then answered 502, and the job list cannot be read: "maybe billed"
    s.server.state.extra = (r) => {
      if (isPost(r)) {
        const body = r.json as Record<string, unknown>
        s.server.state.jobs.push({ job_id: 'job' + (s.server.state.jobs.length + 1), status: 'queued', project_id: String(body.project_id), body })
        return json({ detail: 'Bad gateway' }, 502)
      }
      return isList(r) ? json({ detail: 'Service unavailable' }, 503) : undefined
    }
    await expect(provider.submit(req())).rejects.toMatchObject({ uncertain: true })
    s.server.state.extra = null
    const billed = () => s.server.state.jobs.filter((j) => j.body.client_request_id === clientRequestIdFor('take_1'))
    expect(billed()).toHaveLength(1)
    // the app restarts without that ledger (localStorage cleared, or written over); the engine retries the take
    const fresh = make(memoryStorage())
    await expect(fresh.submit(req(), { retryOfUnknown: true })).rejects.toMatchObject(unverifiable)
    expect(billed()).toHaveLength(1)
    expect(posts(s.server)).toBe(2) // warmup + the lost one
    // a take sent for the first time still goes
    expect((await fresh.submit(req({ key: 'take_2', takeId: 'take_2', sceneId: 'scene_b' }))).remoteId).toBe('proj1:job3')
  })

  it('the "about to post" record cannot be stored (storage full): nothing is posted, nothing billed — the take goes once it can be', async () => {
    const backing = memoryStorage()
    let full = false
    const storage: KeyValueStorage = { get: backing.get, set: (k, v) => void (full && k === JOBS_KEY ? undefined : backing.set(k, v)), remove: backing.remove }
    const server = fakeServer()
    const provider = createCanvasappProvider({ api: createCanvasappApi(server.transport), getBlob: async (id) => blobs[id] ?? null, storage })
    await provider.submit(req({ key: 'warmup', takeId: 'warmup', sceneId: 'scene_w', images: [] }))
    full = true
    const e = await provider.submit(req()).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'storage', message: LEDGER_NOT_SAVED_TEXT })
    expect(isSubmitUncertain(e)).toBe(false) // nothing was sent
    expect(posts(server)).toBe(1)
    expect(JSON.parse(storage.get(JOBS_KEY)!).sent.take_1).toBeUndefined()
    full = false
    expect((await provider.submit(req())).remoteId).toBe('proj1:job2') // a plain first send: no record of an earlier one
    expect(posts(server)).toBe(2)
  })

  it('the second POST after a lost answer (provably nothing created) is not sent when its record cannot be stored either', async () => {
    const backing = memoryStorage()
    let full = false
    const storage: KeyValueStorage = { get: backing.get, set: (k, v) => void (full && k === JOBS_KEY ? undefined : backing.set(k, v)), remove: backing.remove }
    const server = fakeServer()
    // the waits after the lost answer pass on this clock (the second record then differs from the first by its time)
    const clock = { t: 5_000_000 }
    const provider = createCanvasappProvider({
      api: createCanvasappApi(server.transport),
      getBlob: async (id) => blobs[id] ?? null,
      storage,
      now: () => clock.t,
      sleep: async (ms) => void (clock.t += ms),
    })
    await provider.submit(req({ key: 'warmup', takeId: 'warmup', sceneId: 'scene_w', images: [] }))
    // take_1's first POST never reaches canvasapp (its record was stored before it); the storage fills up right then
    server.state.unreachablePosts = 1
    server.state.extra = (r) => {
      if (r.method === 'POST' && r.path === '/api/video-jobs') full = true
      return undefined
    }
    const e = await provider.submit(req()).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'storage', message: LEDGER_NOT_SAVED_TEXT })
    expect(isSubmitUncertain(e)).toBe(false) // the lookups proved the first one created nothing
    expect(posts(server)).toBe(2) // warmup + the one that never arrived: never sent a second time
    expect(server.state.jobs).toHaveLength(1)
    // the first record (with its own time) stays: once the storage holds again, the retry looks first, then sends
    expect(JSON.parse(storage.get(JOBS_KEY)!).sent.take_1).toMatchObject({ projectId: 'proj1' })
    full = false
    server.state.extra = null
    expect((await provider.submit(req())).remoteId).toBe('proj1:job2')
    expect(posts(server)).toBe(3)
    expect(server.state.jobs[1].body.client_request_id).toBe(clientRequestIdFor('take_1'))
  })

  it('an ended anchor updated since the POST (completed → expired, another finished_at) proves nothing: it may have moved up a list cut by update time', async () => {
    const at = (t: number) => new Date(t).toISOString()
    // the list shows only job1 — expired since the POST: take_1's own job may have been cut below it
    const expired = [{ job_id: 'job1', status: 'expired', canvas_node_id: NODE_W, created_at: at(1_000_000) }]
    const s = await restartWith({ jobs: { warmup: warmupJob }, sent: { take_1: lost({ anchors: { ended: [JOB1_DONE], open: [] } }) } }, expired)
    await expect(s.provider.submit(req())).rejects.toMatchObject(unverifiable)
    expect(posts(s.server)).toBe(1)
    // recorded with its finished_at: listed with another one → nothing proven; with the same one → sent again (same key)
    const done = { id: 'job1', status: 'completed', finished: at(1_500_000) }
    const moved = { job_id: 'job1', status: 'completed', canvas_node_id: NODE_W, created_at: at(1_000_000), finished_at: at(9_000_000) }
    const m = await restartWith({ jobs: { warmup: warmupJob }, sent: { take_1: lost({ anchors: { ended: [done], open: [] } }) } }, [moved])
    await expect(m.provider.submit(req())).rejects.toMatchObject(unverifiable)
    expect(posts(m.server)).toBe(1)
    const k = await restartWith({ jobs: { warmup: warmupJob }, sent: { take_1: lost({ anchors: { ended: [done], open: [] } }) } }, [{ ...moved, finished_at: at(1_500_000) }])
    expect((await k.provider.submit(req())).remoteId).toBe('proj1:job2')
    expect(k.server.state.jobs[1].body.client_request_id).toBe(clientRequestIdFor('take_1'))
  })

  it('several jobs with this take’s exact client_request_id (a server without dedupe got it twice): one is adopted — never "unknown", never posted again', async () => {
    const key = clientRequestIdFor('take_1')
    const at = (t: number) => new Date(1_000_000 + t * 1000).toISOString()
    const job = (id: string, status: string, t: number) => ({ job_id: id, status, client_request_id: key, canvas_node_id: NODE_A, created_at: at(t) })
    const cases: [unknown[], string][] = [
      [[job('jA', 'failed', 3), job('jB', 'completed', 1), job('jC', 'processing', 2)], 'proj1:jB'], // a completed one first
      [[job('jA', 'failed', 3), job('jC', 'processing', 2), job('jD', 'queued', 4)], 'proj1:jD'], // then the newest still running
      [[job('jA', 'failed', 3), job('jE', 'failed', 5)], 'proj1:jE'], // else the newest
    ]
    for (const [list, adopted] of cases) {
      const s = await restartWith({ jobs: { warmup: warmupJob }, sent: { take_1: lost() } }, [{ job_id: 'job1', status: 'completed', client_request_id: 'other' }, ...list])
      expect((await s.provider.submit(req(), { retryOfUnknown: true })).remoteId).toBe(adopted)
      expect(posts(s.server)).toBe(1)
      expect(JSON.parse(s.storage.get(JOBS_KEY)!).jobs.take_1.remoteId).toBe(adopted)
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
