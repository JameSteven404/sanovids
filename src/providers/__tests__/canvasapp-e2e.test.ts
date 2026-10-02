// End-to-end proof of the REAL-credit path, without any network:
//   the real queue engine (store/runs) → the real canvasapp adapter / api / desktop transport (providers/canvasapp)
//   → window.bdpDesktop.canvasapp → an in-memory FAKE canvasapp.io.vn that behaves like the server + electron/main.cjs
//   (401, 402, network errors, lost answers, job progression, MP4 stream) and records every request.
// The fake is strict where canvasapp is: the canvas must have exactly canvasPayload()'s keys ("Invalid canvas
// payload" otherwise), a job body exactly runVideoNode()'s, ids must be UUIDs — the SAME validators the in-app dev
// server uses (providers/dev/validate.ts) — and every request must pass the endpoint allowlist of electron/main.cjs
// itself (its <canvasapp-routes> block is run as-is).
// The real-balance store (store/credits) reads /api/me through the same fake bridge.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const media = vi.hoisted(() => new Map<string, Blob>())
vi.mock('../../lib/imageStore', () => {
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

import { takeFileBase } from '../../actions'
import { costOf, MODELS } from '../../core/models'
import type { Asset, Mode, ModelId, Project, Scene, Take } from '../../core/types'
import { takeFiles } from '../../lib/downloads'
import { refreshRealCredits, resetRealCredits, startRealCreditsSync, useRealCredits } from '../../store/credits'
import type { LockManagerLike } from '../../store/engineLock'
import { undo, useProject } from '../../store/project'
import { takeCostLine } from '../../components/runs/creditText'
import { isUncertainSubmit, MAX_REMOTE_CONCURRENCY, onRunEvent, setEngineHooks, setEngineLockManager, UNKNOWN_SUBMIT_ERROR, useRuns, type RunEvent } from '../../store/runs'
import mainSource from '../../../electron/main.cjs?raw'
import { createCanvasappApi, type CanvasPayload, type TransportRequest } from '../canvasapp/api'
import { CANVAS_NOT_SAVED_TEXT, createCanvasappProvider, MAX_CONCURRENCY, memoryStorage, type KeyValueStorage } from '../canvasapp/adapter'
import { canvasNodeId, clientRequestIdFor } from '../canvasapp/mapping'
import { createDesktopTransport, type BridgeResponse, type CanvasappBridge } from '../canvasapp/transport'
import { getProvider, registerProvider, useProviderPrefs } from '../index'
import { canvasProblem, isObj, jobBodyProblem, jobKeyProblem, sameKeys } from '../dev/validate'

// ---------------------------------------------------------------------------------------------------------------
// Fake canvasapp.io.vn (server + what electron/main.cjs returns over IPC)
// ---------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>

/** electron/main.cjs's own endpoint allowlist (the <canvasapp-routes> block, run as-is). */
function loadMainRoutes(): { match: (method: string, path: string) => unknown; maxJsonBytes: number } {
  const m = /\/\/ <canvasapp-routes>[^\n]*\n([\s\S]*?)\/\/ <\/canvasapp-routes>/.exec(mainSource)
  if (!m) throw new Error('canvasapp-routes block not found in electron/main.cjs')
  const factory = new Function('CANVASAPP_ORIGIN', `${m[1]}\nreturn { match: matchCanvasappRoute, maxJsonBytes: CANVASAPP_MAX_JSON_BYTES }`) as (
    origin: string,
  ) => { match: (method: string, path: string) => unknown; maxJsonBytes: number }
  return factory('https://canvasapp.io.vn')
}
const mainRoutes = loadMainRoutes()

interface FakeJob {
  job_id: string
  project_id: string
  canvas_node_id: string
  client_request_id: string
  model_profile: string
  duration: number
  aspect_ratio: string | null
  status: string
  submission_state: string
  progress: number
  download_available: boolean
  error_message: string | null
  created_at: string
  cost: number
  body: Json
  /** Applied one step per job-list read (queued → processing → completed…). */
  script: Partial<FakeJob>[]
}

/** How the fake answers one request (see fakeCanvasapp().state.fault). */
type Fault =
  /** Nothing reaches the server (offline / connection refused). */
  | { kind: 'network' }
  /** The server handles the request, but the answer is lost (timeout, connection reset). */
  | { kind: 'lost-response' }
  /** The server handles the request, then answers with this status/body instead (e.g. Cloudflare 502, odd 200). */
  | { kind: 'processed-then'; status: number; json?: unknown }
  /** Never answers (the app is closed meanwhile). `process`: whether the server got it. */
  | { kind: 'hang'; process: boolean }
  /** Answered (normally) once `until` resolves. */
  | { kind: 'wait'; until: Promise<void> }
  /** Answered with this status/body without being handled. */
  | { kind: 'response'; status: number; json?: unknown }

const DEFAULT_SCRIPT: Partial<FakeJob>[] = [
  { status: 'queued', progress: 0 },
  { status: 'processing', progress: 40 },
  { status: 'completed', progress: 100, download_available: true },
]

interface Logged extends TransportRequest {
  at: number
}

function fakeCanvasapp() {
  const log: Logged[] = []
  const state = {
    authenticated: true,
    balance: 100,
    /** Status for "not enough credits" (canvasapp: VERIFY 400 or 402). */
    insufficientStatus: 402,
    /** The server honours client_request_id (same key → same job, no second charge). VERIFY on the live site. */
    dedupe: true,
    /** Job list items carry client_request_id. VERIFY on the live site. */
    exposeKey: false,
    /** GET /api/video-profiles answer (`profiles` key, as canvasapp's page reads it). */
    profiles: Object.values(MODELS).map((m) => ({
      model_profile: m.id as string,
      display_name: m.name,
      visible: true,
      enabled: true,
      can_create: true,
      options: { modes: [...m.modes] as string[], disabled_modes: [] as string[], durations: [...m.durations], resolutions: [...m.resolutions], aspect_ratios: [...m.ratios] },
    })),
    /** Pixel size the adapter reads for a picture, by its content (H3 transform frames' ratio); default 1920 × 1080. */
    imageSizes: new Map<string, { width: number; height: number } | null>(),
    projects: [] as { project_id: string; name: string }[],
    canvases: new Map<string, CanvasPayload>(),
    uploads: new Map<string, { content: string; type: string; filename: string }>(),
    jobs: [] as FakeJob[],
    script: DEFAULT_SCRIPT,
    /** Requests electron/main.cjs would have refused (not allowlisted / too large): must stay empty. */
    refusedByMain: [] as string[],
    rejected: [] as { path: string; status: number; detail: string }[],
    fault: null as null | ((req: TransportRequest) => Fault | undefined),
  }
  const ok = (json: unknown, status = 200): BridgeResponse => ({ ok: true, status, contentType: 'application/json', json })
  const refuse = (status: number, detail: string, path: string): BridgeResponse => {
    state.rejected.push({ path, status, detail })
    return ok({ detail }, status)
  }

  function advance(j: FakeJob): FakeJob {
    const step = j.script.shift()
    if (step) Object.assign(j, step)
    return j
  }
  function publicJob(j: FakeJob): Json {
    const { body: _b, script: _s, cost: _c, project_id: _p, client_request_id, ...pub } = j
    return state.exposeKey ? { ...pub, client_request_id } : pub
  }

  function createJob(b: Json): BridgeResponse {
    const path = '/api/video-jobs'
    const keyProblem = jobKeyProblem(b)
    if (keyProblem) return refuse(keyProblem.status, keyProblem.detail, path)
    const key = b.client_request_id as string
    if (state.dedupe) {
      const dup = state.jobs.find((j) => j.client_request_id === key)
      if (dup) return ok({ job_id: dup.job_id, status: dup.status })
    }
    const project = state.projects.find((p) => p.project_id === b.project_id)
    if (!project) return refuse(404, 'Project not found', path)
    const canvas = state.canvases.get(project.project_id)
    if (!canvas?.nodes.some((n) => n.id === b.canvas_node_id && n.type === 'video')) return refuse(400, 'canvas_node_id is not a video node of the project canvas', path)
    // every other rule (model, prompt, mode, duration, resolution, exact keys per input shape, uploads): shared
    const problem = jobBodyProblem(b, { hasUpload: (id) => state.uploads.has(id) })
    if (problem) return refuse(problem.status, problem.detail, path)
    const model = b.model_profile as ModelId
    const ratio = typeof b.aspect_ratio === 'string' ? b.aspect_ratio : null
    const cost = costOf({ model, mode: b.mode as Mode, duration: b.duration as number, resolution: b.resolution as string, ratio: ratio ?? '16:9' })
    if (state.balance < cost) return refuse(state.insufficientStatus, `Số dư không đủ: cần ${cost} credit, còn ${state.balance}`, path)
    state.balance -= cost
    const job: FakeJob = {
      job_id: 'job' + (state.jobs.length + 1),
      project_id: project.project_id,
      canvas_node_id: String(b.canvas_node_id),
      client_request_id: key,
      model_profile: model,
      duration: b.duration as number,
      aspect_ratio: ratio,
      status: 'queued',
      submission_state: 'accepted',
      progress: 0,
      download_available: false,
      error_message: null,
      created_at: new Date(Date.now()).toISOString(),
      cost,
      body: b,
      script: state.script.map((s) => ({ ...s })),
    }
    state.jobs.push(job)
    return ok({ job_id: job.job_id, status: job.status })
  }

  function handle(req: TransportRequest): BridgeResponse {
    const [path, query = ''] = req.path.split('?')
    if (path === '/api/auth/state') return ok({ authenticated: state.authenticated, topup_enabled: true })
    if (!state.authenticated) return refuse(401, 'Not authenticated', path)
    if (path === '/api/me' && req.method === 'GET') return ok({ credits_balance: state.balance })
    if (path === '/api/video-profiles' && req.method === 'GET') return ok({ profiles: state.profiles })
    if (path === '/api/projects' && req.method === 'GET') return ok(state.projects)
    if (path === '/api/projects' && req.method === 'POST') {
      // canvasapp's page posts no body; the project gets a default name until PATCH {name}
      if (req.json !== undefined) return refuse(422, 'no body expected', path)
      const p = { project_id: 'proj' + (state.projects.length + 1), name: 'Phiên mới' }
      state.projects.push(p)
      return ok({ project_id: p.project_id })
    }
    const named = /^\/api\/projects\/([^/]+)$/.exec(path)
    if (named && req.method === 'PATCH') {
      const p = state.projects.find((x) => x.project_id === named[1])
      if (!p) return refuse(404, 'Project not found', path)
      const body = req.json as Json
      if (!isObj(body) || !sameKeys(body, ['name']) || typeof body.name !== 'string' || !body.name.trim()) return refuse(422, 'name required', path)
      p.name = body.name
      return ok({ ok: true })
    }
    const canvas = /^\/api\/projects\/([^/]+)\/canvas$/.exec(path)
    if (canvas && req.method === 'PUT') {
      if (!state.projects.some((p) => p.project_id === canvas[1])) return refuse(404, 'Project not found', path)
      const problem = canvasProblem(req.json)
      if (problem) return refuse(422, `Invalid canvas payload (${problem})`, path)
      state.canvases.set(canvas[1], req.json as CanvasPayload)
      return ok({ ok: true })
    }
    if (path === '/api/uploads/images' && req.method === 'POST') {
      const f = req.form
      if (!f || f.field !== 'file' || !['image/png', 'image/jpeg', 'image/webp'].includes(f.contentType)) return refuse(400, 'bad file', path)
      const id = 'up' + (state.uploads.size + 1)
      state.uploads.set(id, { content: new TextDecoder().decode(f.bytes), type: f.contentType, filename: f.filename })
      return ok({ upload_id: id })
    }
    if (path === '/api/video-jobs' && req.method === 'POST') return createJob(req.json as Json)
    if (path === '/api/video-jobs' && req.method === 'GET') {
      const pid = new URLSearchParams(query).get('project_id')
      return ok(state.jobs.filter((j) => j.project_id === pid).map(advance).map(publicJob))
    }
    const stream = /^\/api\/video-jobs\/([^/]+)\/stream$/.exec(path)
    if (stream && req.method === 'GET') {
      const job = state.jobs.find((j) => j.job_id === stream[1])
      if (!job) return refuse(404, 'Job not found', path)
      if (job.status !== 'completed' || !job.download_available) return refuse(409, 'Video chưa sẵn sàng', path)
      return { ok: true, status: 200, contentType: 'video/mp4', bytes: new TextEncoder().encode('MP4:' + job.job_id) }
    }
    const one = /^\/api\/video-jobs\/([^/]+)$/.exec(path)
    if (one && req.method === 'DELETE') {
      state.jobs = state.jobs.filter((j) => j.job_id !== one[1])
      return ok({ ok: true })
    }
    return refuse(404, 'Not found', path)
  }

  const bridge: CanvasappBridge = {
    status: async () => ({ ok: true, authenticated: state.authenticated }),
    login: async () => {
      state.authenticated = true
      return { ok: true, authenticated: true }
    },
    logout: async () => {
      state.authenticated = false
      return { ok: true }
    },
    request: async (req) => {
      log.push({ ...req, at: Date.now() })
      // what electron/main.cjs checks before anything leaves the computer
      if (!mainRoutes.match(req.method, req.path)) {
        state.refusedByMain.push(`${req.method} ${req.path}`)
        return { ok: false, code: 'not-allowed', message: `SanoVids không được phép gọi ${req.method} ${req.path}.` }
      }
      if (req.json !== undefined && new TextEncoder().encode(JSON.stringify(req.json)).byteLength > mainRoutes.maxJsonBytes) {
        state.refusedByMain.push(`${req.method} ${req.path} (too large)`)
        return { ok: false, code: 'too-large', message: 'Dữ liệu gửi đi quá lớn.' }
      }
      const fault = state.fault?.(req)
      if (fault?.kind === 'network') return { ok: false, code: 'network', message: 'Không kết nối được tới canvasapp.io.vn (offline).' }
      if (fault?.kind === 'response') return ok(fault.json ?? {}, fault.status)
      if (fault?.kind === 'hang') {
        if (fault.process) handle(req)
        return new Promise<BridgeResponse>(() => undefined)
      }
      if (fault?.kind === 'wait') await fault.until
      const res = handle(req)
      if (fault?.kind === 'lost-response') return { ok: false, code: 'network', message: 'canvasapp.io.vn không phản hồi (quá thời gian chờ).' }
      if (fault?.kind === 'processed-then') return ok(fault.json ?? {}, fault.status)
      return res
    },
  }

  const is = (method: string, path: string | RegExp) => (c: Logged) =>
    c.method === method && (typeof path === 'string' ? c.path.split('?')[0] === path : path.test(c.path))
  return {
    bridge,
    state,
    log,
    count: (method: string, path: string | RegExp) => log.filter(is(method, path)).length,
    jobPosts: () => log.filter(is('POST', '/api/video-jobs')).map((c) => c.json as Json),
    listReads: () => log.filter(is('GET', '/api/video-jobs')),
    /** Requests a job engine would send (everything but auth/state and /api/me). */
    engineCalls: () => log.filter((c) => !['/api/me', '/api/auth/state'].includes(c.path.split('?')[0])),
  }
}

/** A gate the test opens by hand. */
function gate() {
  let open: () => void = () => undefined
  const until = new Promise<void>((r) => (open = r))
  return { until, open }
}

/** Web Locks stand-in: `otherTab(name)` holds a lock until the returned function is called. */
function fakeLocks() {
  const held = new Set<string>()
  const m: LockManagerLike & { held: Set<string>; otherTab: (name: string) => () => void } = {
    held,
    request: async (name, _opts, cb) => {
      await Promise.resolve()
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

// ---------------------------------------------------------------------------------------------------------------
// Project: 3 characters, Lumi with 2 images → @image_1 Elara, @image_2 Lumi#1, @image_3 Lumi#2, @image_4 Village
// ---------------------------------------------------------------------------------------------------------------

const asset = (id: string, name: string, imageIds: string[]): Asset => ({ id, kind: 'character', name, tag: name, description: '', imageIds, color: '#fff', position: null })

const scene = (id: string, order: number, over: Partial<Scene> = {}): Scene => ({
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
  ...over,
})

const PROMPT = '@image_1 ôm @image_3 trước @image_4, trời mưa'
const S1_COST = 20 // Seedance 2.5 · 15 s · 1080p

const project = (): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [asset('elara', 'Elara', ['img_e1']), asset('lumi', 'Lumi', ['img_l1', 'img_l2']), asset('village', 'Village', ['img_v1'])],
  scenes: [
    scene('s1', 1, {
      title: 'Ôm nhau',
      prompt: PROMPT,
      refs: ['elara', 'lumi', 'village'],
      settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
    }),
    scene('s2', 2, { prompt: 'Hai người đi dạo' }),
    scene('s3', 3, { prompt: 'Mặt trời lặn' }),
    scene('s4', 4, {
      title: 'Biến hình',
      prompt: 'Cô gái hoá thành ngôi làng',
      settings: { model: 'minimax_h3', mode: 'transform', duration: 5, resolution: '768p', ratio: '16:9' },
      firstFrame: 'elara',
      lastFrame: 'village',
    }),
  ],
})

const OWNER: Record<string, string> = { img_e1: 'Elara', img_l1: 'Lumi', img_l2: 'Lumi', img_v1: 'Village', img_e0: 'Elara' }

function seedMedia() {
  media.clear()
  for (const id of ['img_e0', 'img_e1', 'img_l1', 'img_l2', 'img_v1']) media.set(id, new Blob(['IMG:' + id], { type: id === 'img_l2' ? 'image/jpeg' : 'image/png' }))
}

// ---------------------------------------------------------------------------------------------------------------

const realMock = getProvider('mock')
const realDev = getProvider('dev')
const g = globalThis as { window?: unknown }
let fake: ReturnType<typeof fakeCanvasapp>
let storage: KeyValueStorage
let stopSync: () => void = () => undefined
let events: RunEvent[] = []
let offEvents: () => void = () => undefined

/** A fresh adapter instance (as after an app restart): only its persisted state (localStorage) survives. */
function installProvider() {
  const p = createCanvasappProvider({
    api: createCanvasappApi(createDesktopTransport()),
    getBlob: async (id) => media.get(id) ?? null,
    storage,
    imageSize: async (blob) => {
      const content = await blob.text()
      return fake.state.imageSizes.has(content) ? fake.state.imageSizes.get(content)! : { width: 1920, height: 1080 }
    },
  })
  registerProvider(p)
  return p
}

const takes = () => useRuns.getState().takes
const take = (id: string) => takes().find((t) => t.id === id)!
/** What store/persist would have written (a JSON copy). */
const saved = (): Take[] => JSON.parse(JSON.stringify(takes()))
/** App restart: new adapter instance (same localStorage), the engine reloads the saved takes. */
function restart(savedTakes: Take[]) {
  installProvider()
  const { credits, spent } = useRuns.getState()
  useRuns.getState().loadRuns({ takes: savedTakes, credits, spent })
}
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const enqueue = (...ids: string[]) => {
  const r = useRuns.getState().enqueue(ids)
  expect(r.error).toBeUndefined()
  return takes().slice(-r.queued)
}
/** Which character (and image) each @image_N of a sent body points to, through the uploaded files. */
function sentCharacters(body: Json): string[] {
  return [...String(body.prompt).matchAll(/@image_(\d+)/g)].map((m) => {
    const up = (body.upload_ids as string[])[Number(m[1]) - 1]
    const content = fake.state.uploads.get(up)?.content ?? ''
    const imageId = content.replace(/^IMG:/, '')
    return content ? `${OWNER[imageId]}#${imageId}` : '(none)'
  })
}
const uploadedContents = (body: Json) => (body.upload_ids as string[]).map((id) => fake.state.uploads.get(id)?.content)

beforeEach(() => {
  vi.useFakeTimers()
  setEngineLockManager(null)
  setEngineHooks({})
  seedMedia()
  fake = fakeCanvasapp()
  g.window = { bdpDesktop: { canvasapp: fake.bridge } }
  storage = memoryStorage()
  installProvider()
  useProviderPrefs.setState({ provider: 'canvasapp' })
  useProject.getState().loadProject(project())
  useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
  resetRealCredits()
  stopSync = startRealCreditsSync()
  events = []
  offEvents = onRunEvent((e) => events.push(e))
})

afterEach(async () => {
  // checked after the clean-up below, so one failing test never leaves timers / providers behind
  const refusedByMain = [...fake.state.refusedByMain]
  const malformed = fake.state.rejected.filter((r) => r.status === 422)
  offEvents()
  stopSync()
  useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
  await run(250)
  vi.useRealTimers()
  registerProvider(realMock)
  registerProvider(realDev)
  useProviderPrefs.setState({ provider: 'dev' })
  resetRealCredits()
  delete g.window
  expect(refusedByMain).toEqual([]) // every request passes electron/main.cjs's allowlist
  expect(malformed).toEqual([]) // never an invalid canvas / job body
})

afterAll(() => {
  setEngineLockManager(undefined)
  setEngineHooks({})
})

// ---------------------------------------------------------------------------------------------------------------

describe('gateway e2e: happy path + character sync', () => {
  it('uploads each image once, sends upload_ids in @image order with the prompt as compiled, completes, refreshes the real balance', async () => {
    const [t] = enqueue('s1')
    expect(t).toMatchObject({ provider: 'canvasapp', charged: false, status: 'queued', cost: S1_COST })
    expect(useRuns.getState()).toMatchObject({ credits: 1000, spent: 0 }) // demo wallet untouched

    await run(300)
    // order of the submit: video profiles (like canvasapp's page at boot) → bridge project → uploads (sequential) →
    // canvas → job
    expect(fake.engineCalls().map((c) => `${c.method} ${c.path.split('?')[0]}`).slice(0, 10)).toEqual([
      'GET /api/video-profiles',
      'GET /api/projects',
      'POST /api/projects',
      'PATCH /api/projects/proj1',
      'POST /api/uploads/images',
      'POST /api/uploads/images',
      'POST /api/uploads/images',
      'POST /api/uploads/images',
      'PUT /api/projects/proj1/canvas',
      'POST /api/video-jobs',
    ])
    expect([...fake.state.uploads.values()].map((u) => u.content)).toEqual(['IMG:img_e1', 'IMG:img_l1', 'IMG:img_l2', 'IMG:img_v1'])
    expect(fake.state.uploads.get('up3')).toMatchObject({ type: 'image/jpeg' })

    const [body] = fake.jobPosts()
    expect(body).toMatchObject({
      project_id: 'proj1',
      model_profile: 'seedance_2_5',
      canvas_node_id: canvasNodeId('s1'),
      prompt: PROMPT, // exactly as written / compiled
      mode: 't2v',
      duration: 15,
      resolution: '1080p',
      aspect_ratio: '16:9',
      generate_audio: true,
      client_request_id: clientRequestIdFor(t.id),
    })
    expect(Object.keys(body)).toEqual([
      'project_id',
      'model_profile',
      'canvas_node_id',
      'prompt',
      'mode',
      'duration',
      'resolution',
      'generate_audio',
      'upload_ids',
      'aspect_ratio',
      'client_request_id',
    ])
    expect(fake.state.projects).toEqual([{ project_id: 'proj1', name: 'SanoVids bridge' }])
    expect(take(t.id).promptSnapshot).toBe(PROMPT)
    expect(uploadedContents(body)).toEqual(['IMG:img_e1', 'IMG:img_l1', 'IMG:img_l2', 'IMG:img_v1'])
    expect(sentCharacters(body)).toEqual(['Elara#img_e1', 'Lumi#img_l2', 'Village#img_v1'])
    // the bridge canvas wires the same uploads in the same order onto that node
    const canvas = fake.state.canvases.get('proj1')!
    const refs = canvas.connections.filter((c) => c.to === canvasNodeId('s1') && c.target_handle === 'reference').sort((a, b) => a.order - b.order)
    const uploadOfNode = (id: string) => {
      const n = canvas.nodes.find((x) => x.id === id)
      return n?.type === 'images' ? n.data.upload_ids[0] : undefined
    }
    expect(refs.map((c) => c.order)).toEqual([1, 2, 3, 4])
    expect(refs.map((c) => uploadOfNode(c.from))).toEqual(body.upload_ids)
    expect(fake.state.rejected).toEqual([])
    expect(fake.state.balance).toBe(100 - S1_COST)
    expect(take(t.id)).toMatchObject({ status: 'processing', remoteId: 'proj1:job1' })
    expect(events).toContainEqual({ type: 'submitted', takeId: t.id, provider: 'canvasapp' })
    // the real balance was re-read after the job was accepted
    const meAfterPost = fake.log.findIndex((c) => c.path === '/api/me' && fake.log.indexOf(c) > fake.log.findIndex((x) => x.path === '/api/video-jobs' && x.method === 'POST'))
    expect(meAfterPost).toBeGreaterThan(-1)
    expect(useRealCredits.getState()).toMatchObject({ status: 'ok', balance: 80 })

    // queued → processing 40 % → completed (one step per poll, every ≥ 15 s)
    await run(300)
    expect(take(t.id).progress).toBe(1)
    await run(20_000)
    expect(take(t.id).progress).toBe(40)
    await run(20_000)
    const done = take(t.id)
    expect(done.status).toBe('completed')
    expect(done.progress).toBe(100)
    const video = media.get(done.videoId!)!
    expect(video.type).toBe('video/mp4')
    expect(await video.text()).toBe('MP4:job1')
    expect(fake.count('GET', '/api/video-jobs/job1/stream')).toBe(1)
    expect(events).toContainEqual({ type: 'completed', takeId: t.id, provider: 'canvasapp' })
    expect(useRealCredits.getState().balance).toBe(80)
    expect(useRuns.getState()).toMatchObject({ credits: 1000, spent: 0 })

    // a second take of the same scene: no new upload, no new bridge project, same upload_ids, new idempotency key
    const [t2] = enqueue('s1')
    await run(300)
    expect(fake.state.uploads.size).toBe(4)
    expect(fake.count('GET', '/api/projects') + fake.count('POST', '/api/projects') + fake.count('PATCH', /^\/api\/projects\/[^/]+$/)).toBe(3)
    const second = fake.jobPosts()[1]
    expect(second.upload_ids).toEqual(body.upload_ids)
    expect(second.client_request_id).toBe(clientRequestIdFor(t2.id))
    expect(second.client_request_id).not.toBe(body.client_request_id)
    expect(fake.state.balance).toBe(100 - 2 * S1_COST)
    expect(useRealCredits.getState().balance).toBe(60)
    expect(useRuns.getState()).toMatchObject({ credits: 1000, spent: 0 })
  })

  it('edits while the take waits (new image, reordered refs, rename) never change what it sends', async () => {
    // long jobs occupy every slot (MAX_CONCURRENCY), so s1 really waits in the queue
    fake.state.script = [{ status: 'queued' }, { status: 'processing', progress: 10 }, { status: 'processing', progress: 50 }, { status: 'completed', progress: 100, download_available: true }]
    const fillers = Array.from({ length: MAX_CONCURRENCY - 2 }, (_, i) => `f${i + 1}`)
    useProject.getState().loadProject({ ...project(), scenes: [...project().scenes, ...fillers.map((id, i) => scene(id, 5 + i))] })
    enqueue('s2', 's3', ...fillers)
    await run(3000) // one new submit per engine tick (each waits for the previous one's job id)
    expect(takes().filter((x) => x.status === 'processing')).toHaveLength(MAX_CONCURRENCY)
    const [t] = enqueue('s1')
    await run(1000)
    expect(take(t.id).status).toBe('queued')

    const ps = useProject.getState()
    ps.updateAsset('elara', { imageIds: ['img_e0', 'img_e1'] }) // a new FIRST image for Elara
    ps.moveRef('s1', 2, 0) // Village first
    ps.updateAsset('lumi', { name: 'Lumi (đổi tên)' })
    const now = useProject.getState().project.scenes.find((s) => s.id === 's1')!
    expect(now.refs).toEqual(['village', 'elara', 'lumi'])
    expect(now.prompt).not.toBe(PROMPT) // the scene prompt was renumbered for the NEXT run

    await run(70_000) // the running jobs complete → s1 is submitted
    const body = fake.jobPosts().find((b) => b.client_request_id === clientRequestIdFor(t.id))!
    expect(body.prompt).toBe(PROMPT)
    expect(uploadedContents(body)).toEqual(['IMG:img_e1', 'IMG:img_l1', 'IMG:img_l2', 'IMG:img_v1'])
    expect(sentCharacters(body)).toEqual(['Elara#img_e1', 'Lumi#img_l2', 'Village#img_v1'])
    expect([...fake.state.uploads.values()].some((u) => u.content === 'IMG:img_e0')).toBe(false)

    // a NEW take compiles the edited scene: its own numbering, still in sync
    const [t2] = enqueue('s1')
    await run(25_000) // (the jobs were sent one per tick: the last ones end a poll later, then t2 goes)
    const b2 = fake.jobPosts().find((b) => b.client_request_id === clientRequestIdFor(t2.id))!
    expect(b2.prompt).toBe(now.prompt)
    expect(sentCharacters(b2)).toEqual(['Elara#img_e1', 'Lumi#img_l2', 'Village#img_v1'])
  })
})

describe('gateway e2e: failures', () => {
  it('401 while submitting: clear Vietnamese login message, nothing paid, nothing resubmitted', async () => {
    fake.state.authenticated = false
    const [t] = enqueue('s1')
    await run(300)
    expect(take(t.id).status).toBe('failed')
    expect(take(t.id).error).toMatch(/đăng nhập/i)
    expect(fake.count('POST', '/api/video-jobs')).toBe(0)
    const before = fake.engineCalls().length
    await run(5 * 60_000)
    expect(fake.engineCalls().length).toBe(before) // no retry loop
    expect(fake.state.jobs).toHaveLength(0)
    expect(useRuns.getState().providerIssue).toMatchObject({ provider: 'canvasapp', code: 'login-required' })
  })

  it('401 while polling: the take keeps running, polling resumes right after login, never resubmitted', async () => {
    const [t] = enqueue('s1')
    await run(300)
    expect(take(t.id).remoteId).toBe('proj1:job1')
    fake.state.authenticated = false
    await run(20_500)
    expect(take(t.id).status).toBe('processing')
    expect(useRuns.getState().providerIssue).toMatchObject({ provider: 'canvasapp', code: 'login-required' })

    // the user logs in again (Settings / credit pill: bridge.login() then a forced balance refresh) — without that,
    // the back-off after the 401 would wait a minute or more
    await fake.bridge.login()
    await refreshRealCredits({ force: true })
    expect(useRuns.getState().providerIssue).toBeNull()
    await run(45_000)
    expect(take(t.id).status).toBe('completed')
    expect(useRuns.getState().providerIssue).toBeNull()
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })

  it('job failed on canvasapp: take failed with canvasapp’s message, real balance re-read, demo wallet untouched', async () => {
    fake.state.script = [{ status: 'queued' }, { status: 'failed', error_message: 'Nội dung vi phạm chính sách' }]
    const [t] = enqueue('s1')
    await run(300)
    const meBefore = fake.count('GET', '/api/me')
    await run(21_000)
    expect(take(t.id)).toMatchObject({ status: 'failed', error: 'canvasapp: Nội dung vi phạm chính sách', remoteId: 'proj1:job1' })
    expect(fake.count('GET', '/api/me')).toBeGreaterThan(meBefore)
    expect(events).toContainEqual({ type: 'failed', takeId: t.id, provider: 'canvasapp' })
    expect(useRuns.getState()).toMatchObject({ credits: 1000, spent: 0 })
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })

  it.each([402, 400])('not enough canvasapp credits (HTTP %i): clear message, no retry loop, no job', async (status) => {
    fake.state.balance = 5
    fake.state.insufficientStatus = status
    const [t] = enqueue('s1')
    await run(300)
    expect(take(t.id).status).toBe('failed')
    expect(take(t.id).error).toMatch(/không đủ credit/i)
    expect(take(t.id).error).toContain('cần 20 credit') // canvasapp's own detail is kept
    await run(5 * 60_000)
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
    expect(fake.state.jobs).toHaveLength(0)
    expect(fake.state.balance).toBe(5)
    expect(useRealCredits.getState().balance).toBe(5)
  })

  it('missing image blob: loud failure before uploading or posting anything', async () => {
    media.delete('img_l2')
    const [t] = enqueue('s1')
    await run(300)
    expect(take(t.id).status).toBe('failed')
    expect(take(t.id).error).toMatch(/Không tìm thấy ảnh tham chiếu/)
    expect(fake.count('POST', '/api/uploads/images')).toBe(0)
    expect(fake.count('POST', '/api/video-jobs')).toBe(0)
  })
})

describe('gateway e2e: idempotency when POST /api/video-jobs fails mid-way', () => {
  it.each([
    ['answer lost (timeout), server ignores client_request_id', { dedupe: false, exposeKey: false }],
    ['answer lost (timeout), job list exposes client_request_id', { dedupe: false, exposeKey: true }],
  ])('%s → the created job is found and adopted, never a second paid job', async (_label, opts) => {
    Object.assign(fake.state, opts)
    let first = true
    fake.state.fault = (req) => {
      if (req.method === 'POST' && req.path === '/api/video-jobs' && first) {
        first = false
        return { kind: 'lost-response' }
      }
    }
    const [t] = enqueue('s1')
    await run(2 * 60_000)
    expect(fake.state.jobs).toHaveLength(1)
    expect(fake.state.balance).toBe(100 - S1_COST)
    expect(new Set(fake.jobPosts().map((b) => b.client_request_id))).toEqual(new Set([clientRequestIdFor(t.id)]))
    expect(take(t.id).remoteId).toBe('proj1:job1')
    expect(['processing', 'completed']).toContain(take(t.id).status)
  })

  it('Cloudflare 502 after the server created the job, or a 200 without job id → adopted, not paid twice', async () => {
    fake.state.dedupe = false
    let n = 0
    fake.state.fault = (req) => {
      if (req.method === 'POST' && req.path === '/api/video-jobs') {
        n++
        if (n === 1) return { kind: 'processed-then', status: 502, json: { detail: 'Bad gateway' } }
        if (n === 2) return { kind: 'processed-then', status: 200, json: { ok: true } }
      }
    }
    const [a] = enqueue('s1')
    await run(2 * 60_000)
    const [b] = enqueue('s2')
    await run(2 * 60_000)
    expect(fake.state.jobs.map((j) => j.client_request_id)).toEqual([a.id, b.id].map(clientRequestIdFor))
    expect(take(a.id).remoteId).toBe('proj1:job1')
    expect(take(b.id).remoteId).toBe('proj1:job2')
    expect(fake.state.balance).toBe(100 - S1_COST - costOf(project().scenes[1].settings))
  })

  it('offline when posting → retried with the SAME client_request_id; one job', async () => {
    let first = true
    fake.state.fault = (req) => {
      if (req.method === 'POST' && req.path === '/api/video-jobs' && first) {
        first = false
        return { kind: 'network' }
      }
    }
    const [t] = enqueue('s1')
    await run(2 * 60_000)
    const posts = fake.jobPosts()
    expect(posts.length).toBe(2)
    expect(posts.every((b) => b.client_request_id === clientRequestIdFor(t.id))).toBe(true)
    expect(posts[1]).toEqual(posts[0]) // the same request, byte for byte
    expect(fake.state.jobs).toHaveLength(1)
    expect(take(t.id).remoteId).toBe('proj1:job1')
  })

  it('still unreachable → the take is marked "unknown" (never silently re-posted); retry re-sends the SAME take id', async () => {
    fake.state.fault = (req) => (req.method === 'POST' && req.path === '/api/video-jobs' ? { kind: 'network' } : undefined)
    const [t] = enqueue('s1')
    await run(3 * 60_000)
    expect(take(t.id)).toMatchObject({ status: 'failed', error: UNKNOWN_SUBMIT_ERROR, remoteId: null })
    const posted = fake.jobPosts().length
    expect(posted).toBeGreaterThanOrEqual(1)
    expect(posted).toBeLessThanOrEqual(2)
    await run(5 * 60_000)
    expect(fake.jobPosts().length).toBe(posted) // nothing more by itself
    expect(fake.state.jobs).toHaveLength(0)

    // network back; the user asks to retry THIS take: same id → same client_request_id, no new take
    fake.state.fault = null
    const r = useRuns.getState().retry(t.id)
    expect(r).toMatchObject({ queued: 1 })
    expect(takes()).toHaveLength(1)
    await run(2 * 60_000)
    expect(new Set(fake.jobPosts().map((b) => b.client_request_id))).toEqual(new Set([clientRequestIdFor(t.id)]))
    expect(fake.state.jobs).toHaveLength(1)
    expect(take(t.id).remoteId).toBe('proj1:job1')
  })

  it.each([
    ['409 duplicate', 409],
    ['400 refusal', 400],
  ])('retry after a lost answer, re-sent request refused (%s) → still "maybe billed", never "không bị trừ credit"', async (_label, status) => {
    const post = (req: TransportRequest) => req.method === 'POST' && req.path === '/api/video-jobs'
    fake.state.fault = (req) => (post(req) ? { kind: 'network' } : undefined)
    const [t] = enqueue('s1')
    await run(3 * 60_000)
    expect(take(t.id)).toMatchObject({ status: 'failed', submitUnknown: true, remoteId: null })
    fake.state.fault = (req) => (post(req) ? { kind: 'response', status, json: { detail: 'Duplicate request' } } : undefined)
    useRuns.getState().retry(t.id)
    await run(3 * 60_000)
    const after = take(t.id)
    expect(after).toMatchObject({ status: 'failed', error: UNKNOWN_SUBMIT_ERROR, submitUnknown: true, remoteId: null })
    expect(isUncertainSubmit(after)).toBe(true)
    expect(takeCostLine(after)).toMatchObject({ struck: false })
    expect(takeCostLine(after).note).toContain('không rõ')
  })

  it('retry of a "maybe billed" take then cancelled before it is sent: still "maybe billed" (Chạy lại re-sends the same take)', async () => {
    fake.state.fault = (req) => (req.method === 'POST' && req.path === '/api/video-jobs' ? { kind: 'network' } : undefined)
    const [t] = enqueue('s1')
    await run(3 * 60_000)
    useRuns.getState().retry(t.id)
    useRuns.getState().cancel(t.id)
    await run(60_000)
    const after = take(t.id)
    expect(after.status).toBe('cancelled')
    expect(isUncertainSubmit(after)).toBe(true)
    expect(takeCostLine(after)).toMatchObject({ struck: false })
    // an explicit retry re-queues THIS take (same key), it never becomes a new one
    expect(useRuns.getState().retry(t.id)).toMatchObject({ queued: 1 })
    expect(takes()).toHaveLength(1)
  })
})

describe('gateway e2e: app restart', () => {
  it('a job in flight (remote id saved) resumes polling after a restart and is never submitted again', async () => {
    const [t] = enqueue('s1')
    await run(300)
    expect(take(t.id).remoteId).toBe('proj1:job1')
    restart(saved())
    await run(45_000)
    expect(take(t.id).status).toBe('completed')
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
    expect(fake.state.uploads.size).toBe(4)
  })

  it('remote id accepted but not yet saved when the app closed (debounced save) → found again, not failed, not re-posted', async () => {
    const g1 = gate()
    fake.state.fault = (req) => (req.method === 'POST' && req.path === '/api/video-jobs' ? { kind: 'wait', until: g1.until } : undefined)
    const [t] = enqueue('s1')
    await run(300)
    const beforeAnswer = saved() // what was on disk: processing, no remote id
    expect(beforeAnswer[0]).toMatchObject({ status: 'processing', remoteId: null })
    g1.open()
    await run(300)
    expect(take(t.id).remoteId).toBe('proj1:job1')

    restart(beforeAnswer)
    await run(45_000)
    expect(take(t.id)).toMatchObject({ status: 'completed', remoteId: 'proj1:job1' })
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })

  it.each([
    ['canvasapp got the job', true],
    ['canvasapp never got it', false],
  ])('closed while posting (%s): never re-posted silently', async (_label, processed) => {
    fake.state.fault = (req) => (req.method === 'POST' && req.path === '/api/video-jobs' ? { kind: 'hang', process: processed } : undefined)
    const [t] = enqueue('s1')
    await run(300)
    const onDisk = saved()
    fake.state.fault = null
    restart(onDisk)
    await run(60_000)
    expect(fake.count('POST', '/api/video-jobs')).toBe(1) // only the request that hung
    if (processed) {
      expect(take(t.id)).toMatchObject({ remoteId: 'proj1:job1' })
      expect(take(t.id).status).toBe('completed')
    } else {
      expect(take(t.id)).toMatchObject({ status: 'failed', error: UNKNOWN_SUBMIT_ERROR, remoteId: null })
      expect(fake.state.jobs).toHaveLength(0)
      // explicit retry of that take: same key, one job
      useRuns.getState().retry(t.id)
      await run(60_000)
      expect(fake.state.jobs.map((j) => j.client_request_id)).toEqual([clientRequestIdFor(t.id)])
      expect(take(t.id).remoteId).toBe('proj1:job1')
    }
  })
})

describe('gateway e2e: project switches, deleted scenes, frames', () => {
  it('switching project while a submit is on its way: the job id is not lost, reopening resumes it (no second POST)', async () => {
    const g1 = gate()
    fake.state.fault = (req) => (req.method === 'POST' && req.path === '/api/video-jobs' ? { kind: 'wait', until: g1.until } : undefined)
    const [t] = enqueue('s1')
    await run(300)
    const leftOnDisk = saved() // persist writes the runs of the project being left
    useProject.getState().loadProject({ ...project(), id: 'q', scenes: [scene('q1', 1)] })
    useRuns.getState().loadRuns(null)
    g1.open()
    await run(300)
    expect(fake.state.jobs).toHaveLength(1) // the request went on: the user did not cancel anything

    useProject.getState().loadProject(project())
    useRuns.getState().loadRuns({ takes: leftOnDisk, credits: 1000, spent: 0 })
    await run(45_000)
    expect(take(t.id)).toMatchObject({ status: 'completed', remoteId: 'proj1:job1' })
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })

  it('switching away and back before canvasapp answered: the reopened take waits for that answer', async () => {
    const g1 = gate()
    fake.state.fault = (req) => (req.method === 'POST' && req.path === '/api/video-jobs' ? { kind: 'wait', until: g1.until } : undefined)
    const [t] = enqueue('s1')
    await run(300)
    const leftOnDisk = saved()
    useProject.getState().loadProject({ ...project(), id: 'q', scenes: [scene('q1', 1)] })
    useRuns.getState().loadRuns(null)
    await run(1000)
    useProject.getState().loadProject(project())
    useRuns.getState().loadRuns({ takes: leftOnDisk, credits: 1000, spent: 0 })
    await run(1000)
    expect(take(t.id)).toMatchObject({ status: 'processing', remoteId: null })
    g1.open()
    await run(45_000)
    expect(take(t.id)).toMatchObject({ status: 'completed', remoteId: 'proj1:job1' })
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })

  it('a queued take of a deleted scene is never sent; Undo of the delete lets it run (once)', async () => {
    const [t] = enqueue('s1')
    useProject.getState().removeScenes(['s1'])
    await run(60_000)
    expect(fake.engineCalls()).toHaveLength(0)
    expect(take(t.id).status).toBe('queued')
    undo()
    expect(useProject.getState().project.scenes.some((s) => s.id === 's1')).toBe(true)
    await run(45_000)
    expect(fake.jobPosts().map((b) => b.client_request_id)).toEqual([clientRequestIdFor(t.id)])
    expect(take(t.id).status).toBe('completed')
  })

  it('deleting the scene while its submit is on the way: not posted, the take waits in the queue', async () => {
    const g1 = gate()
    fake.state.fault = (req) => (req.path === '/api/uploads/images' ? { kind: 'wait', until: g1.until } : undefined)
    const [t] = enqueue('s1')
    await run(300)
    expect(take(t.id).status).toBe('processing')
    useProject.getState().removeScenes(['s1'])
    g1.open()
    await run(60_000)
    expect(fake.count('POST', '/api/video-jobs')).toBe(0)
    expect(take(t.id)).toMatchObject({ status: 'queued', startedAt: null, remoteId: null })
    fake.state.fault = null
    undo()
    await run(45_000)
    expect(fake.jobPosts().map((b) => b.client_request_id)).toEqual([clientRequestIdFor(t.id)])
    expect(take(t.id).status).toBe('completed')
  })

  it('H3 transform: the frames sent are the pictures chosen at enqueue; a frame without a picture is blocked before running', async () => {
    const [t] = enqueue('s4')
    expect(take(t.id).framesSnapshot).toEqual({ first: 'elara:img_e1', last: 'village:img_v1' })
    useProject.getState().updateAsset('elara', { imageIds: ['img_e0', 'img_e1'] }) // a new primary picture meanwhile
    await run(300)
    const [body] = fake.jobPosts()
    expect(body).toMatchObject({ model_profile: 'minimax_h3', mode: 'transform', client_request_id: clientRequestIdFor(t.id) })
    expect(body).not.toHaveProperty('upload_ids')
    expect(body).not.toHaveProperty('aspect_ratio')
    const canvas = fake.state.canvases.get('proj1')!
    expect(canvas.connections.filter((c) => c.to === canvasNodeId('s4')).map((c) => [c.target_handle, c.order])).toEqual([
      ['first_frame', 1],
      ['last_frame', 2],
    ])
    expect(fake.state.uploads.get(body.first_frame_upload_id as string)?.content).toBe('IMG:img_e1')
    expect(fake.state.uploads.get(body.last_frame_upload_id as string)?.content).toBe('IMG:img_v1')
    expect(fake.state.balance).toBe(100 - costOf(project().scenes[3].settings))

    useProject.getState().updateAsset('village', { imageIds: [] })
    const [c] = useRuns.getState().check(['s4'])
    expect(c).toMatchObject({ ok: false, reason: 'Khung đầu/cuối chưa có ảnh' })
  })
})

describe('gateway e2e: gentleness and engine ownership', () => {
  it('at most 10 jobs in flight; one job-list read per poll for all of them, never closer than 15 s', async () => {
    expect(MAX_CONCURRENCY).toBe(10)
    expect(MAX_REMOTE_CONCURRENCY).toBe(10)
    fake.state.script = [
      { status: 'queued' },
      { status: 'processing', progress: 20 },
      { status: 'processing', progress: 50 },
      { status: 'processing', progress: 80 },
      { status: 'completed', progress: 100, download_available: true },
    ]
    // 12 scenes (more than the cap): Seedance 2.5 · 5 s · 480p each
    const ids = Array.from({ length: 12 }, (_, i) => `m${i + 1}`)
    useProject.getState().loadProject({ ...project(), scenes: ids.map((id, i) => scene(id, i + 1)) })
    const all = enqueue(...ids)
    const keys = (list: Take[]) => list.map((t) => clientRequestIdFor(t.id))
    await run(60_000)
    expect(fake.jobPosts().map((x) => x.client_request_id)).toEqual(keys(all.slice(0, 10)))
    expect(takes().filter((x) => x.status === 'processing')).toHaveLength(10)
    expect(all.slice(10).map((t) => take(t.id).status)).toEqual(['queued', 'queued'])
    // ten running jobs, still one read of the job list per poll cycle (not one per job)
    const reads = fake.listReads().length
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(4)
    await run(60_000) // the first ten complete → the last two go
    expect(fake.jobPosts().map((x) => x.client_request_id)).toEqual(keys(all))
    await run(120_000)
    expect(takes().every((x) => x.status === 'completed')).toBe(true)
    expect(fake.count('POST', '/api/video-jobs')).toBe(12)
    const at = fake.listReads().map((x) => x.at)
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(15_000)
  })

  it('only the tab holding the engine lock talks to canvasapp', async () => {
    const locks = fakeLocks()
    setEngineLockManager(locks)
    const release = locks.otherTab('sanovids-engine:p')
    enqueue('s1')
    await run(30_000)
    expect(fake.engineCalls()).toHaveLength(0)
    expect(useRuns.getState().engineElsewhere).toBe(true)
    release()
    await run(3_500)
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })
})

describe('gateway e2e: up to 10 jobs at once on one bridge canvas', () => {
  /** `n` scenes, each with `k` characters of its own (one picture each, all different): Seedance 2.5 · 5 s · 480p. */
  function crowd(n: number, k: number): string[] {
    const assets: Asset[] = []
    const scenes: Scene[] = []
    for (let i = 1; i <= n; i++) {
      const refs: string[] = []
      for (let c = 1; c <= k; c++) {
        const id = `c${i}_${c}`
        media.set(`img_${id}`, new Blob([`IMG:${id}`], { type: 'image/png' }))
        assets.push(asset(id, `Nhân vật ${i}.${c}`, [`img_${id}`]))
        refs.push(id)
      }
      scenes.push(scene(`m${i}`, i, { refs, prompt: `${refs.map((_, c) => `@image_${c + 1}`).join(' ')} đi dạo` }))
    }
    useProject.getState().loadProject({ ...project(), assets, scenes })
    return scenes.map((s) => s.id)
  }
  const ENDED = ['completed', 'failed', 'cancelled', 'expired']
  const videosOf = (c: CanvasPayload) => c.nodes.filter((n) => n.type === 'video').map((n) => n.id)
  /**
   * Checks every canvas PUT against the jobs canvasapp runs at that moment: none may lose its node (whether canvasapp
   * cancels or loses such a job is not known). `refuse`: answers some requests instead of the fake (Fault).
   */
  function watchRunningNodes(refuse?: (req: TransportRequest) => Fault | undefined) {
    const lost: string[] = []
    const puts: CanvasPayload[] = []
    fake.state.fault = (req) => {
      if (req.method === 'PUT' && /\/canvas$/.test(req.path)) {
        const canvas = req.json as CanvasPayload
        puts.push(canvas)
        const videos = new Set(videosOf(canvas))
        for (const j of fake.state.jobs) if (!ENDED.includes(j.status) && !videos.has(j.canvas_node_id)) lost.push(`${j.job_id} (${j.status})`)
      }
      return refuse?.(req)
    }
    return { lost, puts }
  }

  it('10 scenes × 4 different characters: a running job never loses its node; the 8th waits in the queue for room', async () => {
    fake.state.script = [{ status: 'queued' }, { status: 'processing', progress: 30 }, { status: 'processing', progress: 60 }, { status: 'completed', progress: 100, download_available: true }]
    const watch = watchRunningNodes()
    const all = enqueue(...crowd(10, 4))
    await run(5_000)
    // 7 scenes fill the canvas (7 × 4 = 28 of the 30 pictures it may hold): the 8th would push a running scene off
    expect(fake.count('POST', '/api/video-jobs')).toBe(7)
    expect(all.slice(0, 7).every((t) => take(t.id).status === 'processing' && !!take(t.id).remoteId)).toBe(true)
    expect(all.slice(7).map((t) => take(t.id).status)).toEqual(['queued', 'queued', 'queued']) // honestly waiting
    expect(fake.count('POST', '/api/uploads/images')).toBe(28) // the waiting scenes uploaded nothing yet
    await run(300_000) // running jobs end → room → the others go, three more PUTs
    expect(takes().every((t) => t.status === 'completed')).toBe(true)
    expect(new Set(fake.jobPosts().map((b) => b.client_request_id)).size).toBe(10)
    expect(fake.jobPosts()).toHaveLength(10)
    expect(watch.puts.length).toBeGreaterThanOrEqual(10)
    expect(watch.lost).toEqual([])
    expect(fake.state.rejected).toEqual([]) // never "canvas_node_id is not a video node", never past 40 nodes / 30 pictures
    expect(fake.state.balance).toBe(100 - 10 * costOf({ model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' }))
  })

  it.each([
    ['once', 1, true],
    ['twice', 2, false],
  ])('canvas refused %s while 9 jobs run: only the ended scene may go — every running node stays', async (_label, refusals, sent) => {
    const ids = crowd(11, 1)
    const [first] = enqueue(ids[0]) // default script: done after three job-list reads
    await run(90_000)
    expect(take(first.id).status).toBe('completed')
    fake.state.script = Array.from({ length: 50 }, () => ({ status: 'processing', progress: 10 }))
    enqueue(...ids.slice(1, 10))
    await run(5_000)
    expect(takes().filter((t) => t.status === 'processing' && !!t.remoteId)).toHaveLength(9)

    let left = refusals
    const watch = watchRunningNodes((req) => (req.method === 'PUT' && left-- > 0 ? { kind: 'response', status: 400, json: { detail: 'Invalid canvas payload' } } : undefined))
    const [last] = enqueue(ids[10])
    await run(1_000)
    expect(watch.puts).toHaveLength(2)
    expect(videosOf(watch.puts[0]).sort()).toEqual(ids.map(canvasNodeId).sort()) // refused: every scene
    expect(videosOf(watch.puts[1]).sort()).toEqual(ids.slice(1).map(canvasNodeId).sort()) // without m1 only
    expect(watch.lost).toEqual([])
    const onCanvasapp = videosOf(fake.state.canvases.get('proj1')!)
    for (const id of ids.slice(1, 10)) expect(onCanvasapp).toContain(canvasNodeId(id)) // the 9 running nodes
    if (sent) {
      expect(take(last.id).remoteId).toBe('proj1:job11')
    } else {
      // refused again: nothing billed, nothing taken off the canvas on canvasapp
      expect(take(last.id).status).toBe('failed')
      expect(take(last.id).error!.startsWith(CANVAS_NOT_SAVED_TEXT)).toBe(true)
      expect(fake.jobPosts()).toHaveLength(10)
      expect(onCanvasapp.sort()).toEqual(ids.slice(0, 10).map(canvasNodeId).sort())
    }
  })

  it('10 takes queued while the first upload hangs: only that take is "running"; after a restart only it is unsure', async () => {
    let hang = true
    fake.state.fault = (req) => {
      if (req.path !== '/api/uploads/images' || !hang) return undefined
      hang = false
      return { kind: 'hang', process: false }
    }
    const all = enqueue(...crowd(10, 1))
    await run(3_000)
    // the others stay honestly "queued" behind it (they cancel cleanly, nothing of them is on the way)
    expect(all.map((t) => take(t.id).status)).toEqual(['processing', ...Array<string>(9).fill('queued')])
    restart(saved()) // the app closes while that upload hangs
    await run(60_000)
    // the first take cannot be proven unsent (no POST record): flagged as before — the 9 others run normally
    expect(take(all[0].id)).toMatchObject({ status: 'failed', error: UNKNOWN_SUBMIT_ERROR, remoteId: null })
    expect(all.slice(1).every((t) => !!take(t.id).remoteId && !isUncertainSubmit(take(t.id)))).toBe(true)
    expect(fake.jobPosts()).toHaveLength(9)
  })
})

describe('gateway e2e: cancel', () => {
  it('cancelling a queued take never posts it', async () => {
    const [t] = enqueue('s1')
    useRuns.getState().cancel(t.id)
    await run(60_000)
    expect(fake.engineCalls()).toHaveLength(0)
    expect(take(t.id).status).toBe('cancelled')
  })

  it('cancelling while its submit is still on the way (uploading / waiting for another take) never posts it', async () => {
    const g1 = gate()
    fake.state.fault = (req) => (req.path === '/api/uploads/images' ? { kind: 'wait', until: g1.until } : undefined)
    const [a, b] = enqueue('s1', 's2')
    await run(1000)
    expect(take(a.id).status).toBe('processing')
    // one submit at a time: b honestly waits in the queue while a uploads (not "running" while nothing was sent)
    expect(take(b.id).status).toBe('queued')
    useRuns.getState().cancel(a.id)
    useRuns.getState().cancel(b.id)
    g1.open()
    await run(60_000)
    expect(fake.count('POST', '/api/video-jobs')).toBe(0)
    expect(fake.state.balance).toBe(100)
    // the take says it was never sent (UI: "huỷ trước khi gửi sang canvasapp — không bị trừ credit")
    expect(take(a.id)).toMatchObject({ status: 'cancelled', remoteId: null, startedAt: null })
    expect(take(b.id)).toMatchObject({ status: 'cancelled', remoteId: null, startedAt: null })
  })

  it('cancelling a running take only stops tracking it (as the UI says): no DELETE, the job stays on canvasapp', async () => {
    const [t] = enqueue('s1')
    await run(300)
    useRuns.getState().cancel(t.id)
    expect(take(t.id)).toMatchObject({ status: 'cancelled', remoteId: 'proj1:job1' })
    const reads = fake.listReads().length
    await run(60_000)
    expect(fake.count('DELETE', /^\/api\/video-jobs\//)).toBe(0)
    expect(fake.state.jobs).toHaveLength(1)
    expect(fake.listReads().length).toBe(reads) // nothing left to follow
  })
})

describe('gateway e2e: download', () => {
  it('a completed take saves as "S01_T1 - <title>.mp4" + prompt .txt, also after a restart', async () => {
    const [t] = enqueue('s1')
    await run(45_000)
    expect(take(t.id).status).toBe('completed')
    const files = await takeFiles(take(t.id), takeFileBase(t.id), true)
    expect(files.map((f) => f.name)).toEqual(['S01_T1 - Ôm nhau.mp4', 'S01_T1 - Ôm nhau.txt'])
    expect(files[1].data).toBe(PROMPT)

    restart(saved())
    await run(60_000)
    const again = await takeFiles(take(t.id), takeFileBase(t.id), false)
    expect(again.map((f) => f.name)).toEqual(['S01_T1 - Ôm nhau.mp4'])
    expect(await (again[0].data as Blob).text()).toBe('MP4:job1')
    expect(fake.count('GET', '/api/video-jobs/job1/stream')).toBe(1) // nothing downloaded twice
  })

  it('a take whose video file is gone from this computer gives no files (never a lone prompt .txt)', async () => {
    const [t] = enqueue('s1')
    await run(45_000)
    media.delete(take(t.id).videoId!)
    expect(await takeFiles(take(t.id), takeFileBase(t.id), true)).toEqual([])
  })

  it('a download that keeps failing ends with a message saying the video is paid and where to get it', async () => {
    fake.state.fault = (req) => (req.path.endsWith('/stream') ? { kind: 'network' } : undefined)
    const [t] = enqueue('s1')
    await run(30 * 60_000)
    expect(take(t.id)).toMatchObject({ status: 'failed', remoteId: 'proj1:job1' })
    expect(take(t.id).error).toMatch(/đã trừ credit/)
    expect(take(t.id).error).toMatch(/canvasapp\.io\.vn/)
    expect(fake.count('GET', '/api/video-jobs/job1/stream')).toBe(5)
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })

  it('a failed download of a finished (paid) video is retried — never turned into a failed take that invites a paid re-run', async () => {
    let failures = 2
    fake.state.fault = (req) => (req.path.endsWith('/stream') && failures-- > 0 ? { kind: 'network' } : undefined)
    const [t] = enqueue('s1')
    await run(45_000)
    expect(take(t.id).status).toBe('processing')
    await run(10 * 60_000)
    expect(take(t.id).status).toBe('completed')
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })
})

describe('gateway e2e: request shapes canvasapp accepts', () => {
  it('the strict fake refuses what v0.2.0 sent (extra title, {x, y, zoom} viewport, non-UUID ids) — as canvasapp did', () => {
    const v020 = {
      nodes: [
        { id: 'sv_s1', type: 'video', x: 570, y: 0, w: 360, h: 300, data: { model_profile: 'seedance_2_5', duration: 30, resolution: '480p', aspect_ratio: '16:9', mode: 't2v', prompt: 'x', title: 'S01 · T1' } },
        { id: 'sv_s1_r1', type: 'images', x: 0, y: 0, data: { upload_ids: ['up1'] } },
      ],
      connections: [{ from: 'sv_s1_r1', to: 'sv_s1', target_handle: 'reference', order: 1 }],
      viewport: { x: 0, y: 0, zoom: 1 },
    }
    expect(canvasProblem(v020)).toBe('viewport')
    const viewportFixed = { ...v020, viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 } }
    expect(canvasProblem(viewportFixed)).toBe('node id')
    const ids = { sv_s1: canvasNodeId('s1'), sv_s1_r1: canvasNodeId('s1-r1') }
    const uuidOnly = {
      ...viewportFixed,
      nodes: viewportFixed.nodes.map((n) => ({ ...n, id: ids[n.id as keyof typeof ids] })),
      connections: [{ from: ids.sv_s1_r1, to: ids.sv_s1, target_handle: 'reference', order: 1 }],
    }
    expect(canvasProblem(uuidOnly)).toBe('video node data keys') // the extra `title`
    const { title: _t, ...data } = uuidOnly.nodes[0].data as Json
    expect(canvasProblem({ ...uuidOnly, nodes: [{ ...uuidOnly.nodes[0], data }, uuidOnly.nodes[1]] })).toBeNull()
  })

  it('electron/main.cjs allows every endpoint the gateway uses, and nothing next to them', () => {
    const allowed = (method: string, path: string) => !!mainRoutes.match(method, path)
    const id = canvasNodeId('x')
    expect(allowed('GET', '/api/projects')).toBe(true)
    expect(allowed('POST', '/api/projects')).toBe(true)
    expect(allowed('PATCH', `/api/projects/${id}`)).toBe(true)
    expect(allowed('PUT', `/api/projects/${id}/canvas`)).toBe(true)
    expect(allowed('POST', '/api/uploads/images')).toBe(true)
    expect(allowed('POST', '/api/video-jobs')).toBe(true)
    expect(allowed('GET', `/api/video-jobs?project_id=${id}`)).toBe(true)
    expect(allowed('GET', `/api/video-jobs/${id}/stream`)).toBe(true)
    expect(allowed('DELETE', `/api/projects/${id}`)).toBe(false)
    expect(allowed('PATCH', `/api/projects/${id}/canvas`)).toBe(false)
    expect(allowed('PATCH', '/api/projects')).toBe(false)
    expect(allowed('PATCH', '/api/me')).toBe(false)
    expect(mainRoutes.maxJsonBytes).toBe(2 * 1024 * 1024)
  })

  it('the first real test — Seedance 2.5 · t2v · 30 s · 480p · 16:9 · one reference image — is accepted end to end', async () => {
    const ps = useProject.getState()
    ps.loadProject({
      ...project(),
      scenes: [
        scene('r1', 1, { title: 'Thử thật', prompt: '  @image_1 đi dạo trong mưa  ', refs: ['elara'], settings: { model: 'seedance_2_5', mode: 't2v', duration: 30, resolution: '480p', ratio: '16:9' } }),
      ],
    })
    const [t] = enqueue('r1')
    await run(300)
    expect(fake.state.rejected).toEqual([])
    const canvas = fake.state.canvases.get('proj1')!
    expect(canvasProblem(canvas)).toBeNull()
    const video = canvas.nodes.find((n) => n.type === 'video')!
    expect(video).toMatchObject({ id: canvasNodeId('r1'), w: 390, h: 600 })
    expect(video.data).toEqual({ model_profile: 'seedance_2_5', duration: 30, resolution: '480p', aspect_ratio: '16:9', mode: 't2v', prompt: take(t.id).promptSnapshot })
    const [body] = fake.jobPosts()
    expect(body).toEqual({
      project_id: 'proj1',
      model_profile: 'seedance_2_5',
      canvas_node_id: canvasNodeId('r1'),
      prompt: take(t.id).promptSnapshot.trim(),
      mode: 't2v',
      duration: 30,
      resolution: '480p',
      generate_audio: true,
      upload_ids: ['up1'],
      aspect_ratio: '16:9',
      client_request_id: clientRequestIdFor(t.id),
    })
    expect(take(t.id)).toMatchObject({ status: 'processing', remoteId: 'proj1:job1' })
    expect(fake.state.balance).toBe(100 - costOf({ model: 'seedance_2_5', mode: 't2v', duration: 30, resolution: '480p', ratio: '16:9' }))
  })
})

describe('gateway e2e: what canvasapp’s own page would refuse, and which request a refusal came from', () => {
  it('MiniMax-H3 that cannot create (video profiles) is refused before anything is uploaded or paid; Seedance still runs', async () => {
    fake.state.profiles = fake.state.profiles.map((p) => (p.model_profile === 'minimax_h3' ? { ...p, can_create: false } : p))
    const [h3, sd] = enqueue('s4', 's2')
    await run(600) // s4 is refused, then s2 is sent (one submit at a time)
    expect(take(h3.id).status).toBe('failed')
    expect(take(h3.id).error).toMatch(/MiniMax-H3 hiện không khả dụng/)
    expect(takeCostLine(take(h3.id)).note).toMatch(/không bị trừ credit/)
    expect(fake.count('POST', '/api/uploads/images')).toBe(0) // s4's frames never uploaded; s2 has no picture
    expect(fake.jobPosts().map((b) => b.model_profile)).toEqual(['seedance_2_5'])
    expect(take(sd.id).remoteId).toBe('proj1:job1')
    expect(fake.count('GET', '/api/video-profiles')).toBe(1) // read once, then cached
  })

  it('video profiles unreadable → canvasapp’s fallbacks, like its page: Seedance runs, MiniMax-H3 locked (and why)', async () => {
    fake.state.fault = (req) => (req.path === '/api/video-profiles' ? { kind: 'response', status: 500, json: { detail: 'boom' } } : undefined)
    const [h3, sd] = enqueue('s4', 's2')
    await run(600)
    expect(take(h3.id).status).toBe('failed')
    expect(take(h3.id).error).toMatch(/MiniMax-H3 hiện không khả dụng/)
    expect(take(h3.id).error).toContain('Không đọc được cấu hình model')
    expect(take(sd.id).remoteId).toBe('proj1:job1')
    expect(fake.jobPosts()).toHaveLength(1)
  })

  it('H3 transform with frames of different ratios is refused before uploading; matching frames give the node their ratio', async () => {
    fake.state.imageSizes.set('IMG:img_v1', { width: 1080, height: 1920 })
    const [bad] = enqueue('s4')
    await run(300)
    expect(take(bad.id).status).toBe('failed')
    expect(take(bad.id).error).toMatch(/khác tỷ lệ \(16:9 \/ 9:16\)/)
    expect(fake.count('POST', '/api/uploads/images')).toBe(0)
    expect(fake.count('POST', '/api/video-jobs')).toBe(0)

    // both frames portrait: canvasapp's page runs it, the transform node's aspect_ratio is the frames' (not the scene's 16:9)
    fake.state.imageSizes.set('IMG:img_e1', { width: 1080, height: 1920 })
    const [good] = enqueue('s4')
    await run(300)
    expect(take(good.id).remoteId).toBe('proj1:job1')
    const node = fake.state.canvases.get('proj1')!.nodes.find((n) => n.id === canvasNodeId('s4'))!
    expect(node.type === 'video' && node.data.aspect_ratio).toBe('9:16')
    expect(fake.jobPosts()[0]).not.toHaveProperty('aspect_ratio')
  })

  it('canvas refused at PUT: the take names the request and the field, says nothing was billed, and posts no job', async () => {
    const detail = [{ type: 'extra_forbidden', loc: ['body', 'nodes', 0, 'data', 'title'], msg: 'Extra inputs are not permitted', input: 'PROMPT-ECHO' }]
    fake.state.fault = (req) => (req.method === 'PUT' ? { kind: 'response', status: 422, json: { detail } } : undefined)
    const [t] = enqueue('s2')
    await run(300)
    const error = take(t.id).error!
    expect(take(t.id).status).toBe('failed')
    expect(error.startsWith(CANVAS_NOT_SAVED_TEXT)).toBe(true)
    expect(error).toContain('nodes.0.data.title: Extra inputs are not permitted')
    expect(error).toContain('[PUT /api/projects/{id}/canvas · HTTP 422]')
    expect(error).not.toContain('PROMPT-ECHO') // never what was sent
    expect(error).not.toContain('proj1') // nor ids
    expect(takeCostLine(take(t.id)).note).toMatch(/không bị trừ credit/)
    expect(fake.count('POST', '/api/video-jobs')).toBe(0)
    expect(fake.state.balance).toBe(100)

    // canvasapp accepts the next canvas: the next take runs (the refused scene was never remembered)
    fake.state.fault = null
    const [next] = enqueue('s3')
    await run(300)
    expect(take(next.id).remoteId).toBe('proj1:job1')
    expect(fake.state.canvases.get('proj1')!.nodes.map((n) => n.id)).toEqual([canvasNodeId('s3')])
  })
})
