import { describe, expect, it } from 'vitest'
import { createCanvasappApi, CanvasappError, errorFromResponse, type Transport, type TransportRequest, type TransportResponse } from '../canvasapp/api'
import { createCanvasappProvider, memoryStorage, MIN_POLL_MS, STATE_KEY } from '../canvasapp/adapter'
import { BRIDGE_PROJECT_NAME, canvasNodeId } from '../canvasapp/mapping'
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
        const p = { project_id: 'proj' + (state.projects.length + 1), name: (req.json as { name: string }).name }
        state.projects.push(p)
        return json({ project_id: p.project_id })
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

function setup(server = fakeServer(), clock = { t: 1_000_000 }) {
  const storage = memoryStorage()
  const provider = createCanvasappProvider({
    api: createCanvasappApi(server.transport),
    getBlob: async (id) => blobs[id] ?? null,
    storage,
    now: () => clock.t,
  })
  return { provider, server, storage, clock }
}

describe('canvasapp adapter', () => {
  it('creates the bridge project once, uploads images once, saves the canvas, then posts the job', async () => {
    const { provider, server, storage } = setup()
    const { remoteId } = await provider.submit(req())
    expect(remoteId).toBe('proj1:job1')
    expect(server.state.projects).toEqual([{ project_id: 'proj1', name: BRIDGE_PROJECT_NAME }])
    expect(server.state.uploads).toBe(2)

    const job = server.state.jobs[0].body
    expect(job.upload_ids).toEqual(['up1', 'up2'])
    expect(job.client_request_id).toBe('take_1')
    expect(job.canvas_node_id).toBe(canvasNodeId('scene_a'))
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
    await expect(t.request({ method: 'DELETE', path: '/api/projects/x' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})
