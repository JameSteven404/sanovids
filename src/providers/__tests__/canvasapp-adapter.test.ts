import { describe, expect, it } from 'vitest'
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
  memoryStorage,
  MIN_POLL_MS,
  PROFILES_FALLBACK_TEXT,
  PROFILES_TTL_MS,
  STATE_KEY,
} from '../canvasapp/adapter'
import { adoptedKey, BRIDGE_PROJECT_NAME, canvasNodeId, clientRequestIdFor, isUuid } from '../canvasapp/mapping'
import { createDesktopTransport, type CanvasappBridge } from '../canvasapp/transport'
import type { JobRequest } from '../types'

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
    jobs: [] as { job_id: string; status: string; progress?: number; download_available?: boolean; project_id: string; body: Record<string, unknown> }[],
    extra: null as Handler | null,
  }
  const transport: Transport = {
    available: async () => ({ ok: true }),
    request: async (req) => {
      calls.push(req)
      const extra = state.extra?.(req)
      if (extra) return extra
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
        if (!p) return json({ detail: 'Project not found' }, 404)
        return json({ project_id: p.project_id, name: p.name, canvas: state.canvases.get(p.project_id) ?? null })
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
        const job = { job_id: 'job' + (state.jobs.length + 1), status: 'queued', project_id: String(body.project_id), body }
        state.jobs.push(job)
        return json({ job_id: job.job_id })
      }
      if (path === '/api/video-jobs' && req.method === 'GET') {
        const pid = new URLSearchParams(query).get('project_id')
        return json(state.jobs.filter((j) => j.project_id === pid).map(({ body: _b, ...j }) => j))
      }
      const stream = /^\/api\/video-jobs\/([^/]+)\/stream$/.exec(path)
      if (stream) return { status: 200, contentType: 'video/mp4', bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]) }
      return json({ detail: 'nope' }, 404)
    },
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
const savedEntries = (storage: ReturnType<typeof memoryStorage>) => Object.keys(JSON.parse(storage.get(STATE_KEY)!).entries)
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
    expect(job.canvas_node_id).toBe(canvasNodeId('scene_a'))
    expect(isUuid(job.canvas_node_id)).toBe(true)
    // the canvas was saved BEFORE the job and contains that node id
    const order = server.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)
    expect(order.indexOf('PUT /api/projects/proj1/canvas')).toBeLessThan(order.indexOf('POST /api/video-jobs'))
    const canvas = server.state.canvases.get('proj1') as { nodes: { id: string }[] }
    expect(canvas.nodes.some((n) => n.id === canvasNodeId('scene_a'))).toBe(true)

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

  it('maps 401 to login-required', async () => {
    const { provider } = setup(fakeServer({ authenticated: false }))
    await expect(provider.submit(req())).rejects.toMatchObject({ code: 'login-required' })
    expect(await provider.available()).toEqual({ ok: false, reason: 'Chưa đăng nhập canvasapp.io.vn.' })
  })

  it('polls with one list request per project and never more often than every 15 s', async () => {
    const { provider, server, clock } = setup()
    const a = await provider.submit(req())
    const b = await provider.submit(req({ key: 'take_2', takeId: 'take_2', sceneId: 'scene_b' }))
    const listCount = () => server.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/video-jobs?')).length

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
    expect(videos(after).map((n) => n.id)).toEqual([canvasNodeId('scene_b'), canvasNodeId('scene_a')])
    // scene A's node exactly as it was, still wired to its pictures in @image order
    expect(videos(after)[1].data).toEqual(videos(before)[0].data)
    expect(uploadsIn(server.calls.filter(isPut).at(-1)!)).toEqual(['up3', 'up1', 'up2'])
    expect(after.connections.filter((c) => c.to === canvasNodeId('scene_a')).map((c) => c.order)).toEqual([1, 2])
    expect(savedEntries(storage)).toEqual([adoptedKey(canvasNodeId('scene_a')), 'scene_b'])

    // scene A again while job1 still runs, its job refused: its node (now its own entry again, never two) stays
    let refuse = 1
    server.state.extra = (r) => (r.method === 'POST' && r.path === '/api/video-jobs' && refuse-- > 0 ? json({ detail: 'unknown upload_id' }, 400) : undefined)
    await expect(provider.submit(req({ key: 'take_a2', takeId: 'take_a2' }))).rejects.toMatchObject({ code: 'bad-request' })
    expect(videos(server.state.canvases.get('proj1') as CanvasPayload).map((n) => n.id)).toEqual([canvasNodeId('scene_a'), canvasNodeId('scene_b')])
    expect(savedEntries(storage)).toEqual(['scene_b', 'scene_a'])
    await provider.submit(req({ key: 'take_c', takeId: 'take_c', sceneId: 'scene_c', images: [], prompt: 'mưa' }))
    expect(videos(server.state.canvases.get('proj1') as CanvasPayload).map((n) => n.id).sort()).toEqual(['scene_a', 'scene_b', 'scene_c'].map(canvasNodeId).sort())
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
    expect((server.state.canvases.get('proj1') as CanvasPayload).nodes.map((n) => n.id)).toContain(canvasNodeId('scene_a'))
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
            { job_id: 'job1', status: 'queued', canvas_node_id: canvasNodeId('scene_a') },
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
    expect(videos().sort()).toEqual([canvasNodeId('scene_a'), canvasNodeId('scene_b'), elsewhere].sort())
    expect((server.state.canvases.get('proj1') as CanvasPayload).nodes.find((n) => n.id === elsewhere)?.data).toEqual(data)
    // held from now on: not read again
    await provider.submit(req({ key: 'take_c', takeId: 'take_c', sceneId: 'scene_c', images: [], prompt: 'nắng' }))
    expect(reads()).toBe(1)
    expect(videos()).toContain(elsewhere)
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
    clock.t += 1_000
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
    clock.t += 1_000
    // canvasapp refuses the first canvas (with every scene): once more without the ended scene B — A stays
    let refusals = 1
    server.state.extra = (r) => (isPut(r) && refusals-- > 0 ? json({ detail: 'Invalid canvas payload' }, 422) : undefined)
    expect((await provider.submit(one('scene_c', 'take_c'))).remoteId).toBe('proj1:job3')
    const nodesOf = (r: TransportRequest) => (r.json as CanvasPayload).nodes.map((n) => n.id)
    const puts = server.calls.filter(isPut)
    expect(nodesOf(puts.at(-2)!)).toEqual(['scene_c', 'scene_a', 'scene_b'].map(canvasNodeId))
    expect(nodesOf(puts.at(-1)!)).toEqual(['scene_c', 'scene_a'].map(canvasNodeId))
    expect(savedEntries(storage).sort()).toEqual(['scene_a', 'scene_c'])
    // refused while only running scenes are there (A and C): nothing may go → no PUT without them, nothing billed
    server.state.extra = (r) => (isPut(r) ? json({ detail: 'Invalid canvas payload' }, 422) : undefined)
    const before = server.calls.filter(isPut).length
    await expect(provider.submit(one('scene_c', 'take_c2'))).rejects.toThrow(CANVAS_NOT_SAVED_TEXT)
    expect(server.calls.filter(isPut).length).toBe(before + 1)
    expect(savedEntries(storage).sort()).toEqual(['scene_a', 'scene_c'])
    expect(server.state.canvases.get('proj1')).toMatchObject({ nodes: [{ id: canvasNodeId('scene_c') }, { id: canvasNodeId('scene_a') }] })
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
