// The strict fake canvasapp.io.vn + electron/main.cjs over IPC, shared by the gateway's end-to-end tests
// (canvasapp-e2e.test.ts) and its seeded fault-injection simulation (canvasapp-fuzz.test.ts). Not a test file itself.
// The fake is strict where canvasapp is: the canvas must have exactly canvasPayload()'s keys ("Invalid canvas
// payload" otherwise), a job body exactly runVideoNode()'s, ids must be UUIDs — the SAME validators the in-app dev
// server uses (providers/dev/validate.ts) — and every request must pass the endpoint allowlist of electron/main.cjs
// itself (its <canvasapp-routes> block is run as-is). Videos come through main's OWN streamed downloads (its
// <canvasapp-downloads> + <canvasapp-lanes> blocks, run as-is).
import { costOf, MODELS } from '../../core/models'
import type { Mode, ModelId } from '../../core/types'
import mainSource from '../../../electron/main.cjs?raw'

export { mainSource }
import type { CanvasPayload, TransportRequest } from '../canvasapp/api'
import type { BridgeDownloadOpen, BridgeDownloadRead, BridgeResponse, CanvasappBridge } from '../canvasapp/transport'
import type * as DownloadsPort from '../dev/downloads'
import type { ByteReader, ResponseLike } from '../dev/downloads'
import { canvasProblem, isObj, jobBodyProblem, jobKeyProblem, sameKeys } from '../dev/validate'
import { applyNodeEdit, siteJobBody, type SiteNodeEdit } from '../dev/siteClient'

// ---------------------------------------------------------------------------------------------------------------
// Fake canvasapp.io.vn (server + what electron/main.cjs returns over IPC)
// ---------------------------------------------------------------------------------------------------------------

export type Json = Record<string, unknown>

/**
 * electron/main.cjs's own endpoint allowlist (the <canvasapp-routes> block, run as-is): `match` for downloads,
 * `matchRequest` for canvasapp:request (never the video stream).
 */
export function loadMainRoutes(): { match: (method: string, path: string) => unknown; matchRequest: (method: string, path: string) => unknown; maxJsonBytes: number } {
  const m = /\/\/ <canvasapp-routes>[^\n]*\n([\s\S]*?)\/\/ <\/canvasapp-routes>/.exec(mainSource)
  if (!m) throw new Error('canvasapp-routes block not found in electron/main.cjs')
  const factory = new Function(
    'CANVASAPP_ORIGIN',
    `${m[1]}\nreturn { match: matchCanvasappRoute, matchRequest: matchCanvasappRequest, maxJsonBytes: CANVASAPP_MAX_JSON_BYTES }`,
  ) as (origin: string) => { match: (method: string, path: string) => unknown; matchRequest: (method: string, path: string) => unknown; maxJsonBytes: number }
  return factory('https://canvasapp.io.vn')
}
export const mainRoutes = loadMainRoutes()

export function mainBlock(name: string): string {
  const m = new RegExp(`// <${name}>[^\\n]*\\n([\\s\\S]*?)// </${name}>`).exec(mainSource)
  if (!m) throw new Error(`${name} block not found in electron/main.cjs`)
  return m[1]
}
/** electron/main.cjs's video downloads (the <canvasapp-downloads> block, run as-is). */
export const mainDownloads = new Function(`${mainBlock('canvasapp-downloads')}\nreturn { createDownloadSessions, CANVASAPP_VIDEO_MAX_BYTES }`)() as Pick<
  typeof DownloadsPort,
  'createDownloadSessions' | 'CANVASAPP_VIDEO_MAX_BYTES'
>
/** A fresh 'download' lane of main's <canvasapp-lanes> block (as-is). */
export function mainDownloadLane() {
  const l = new Function(`${mainBlock('canvasapp-lanes')}\nreturn { withSlot: withCanvasappSlot, lanes: canvasappLanes }`)() as {
    withSlot: (lane: string, fn: () => Promise<unknown>) => Promise<unknown>
    lanes: { download: { active: number } }
  }
  return { withSlot: (fn: () => Promise<unknown>) => l.withSlot('download', fn), active: () => l.lanes.download.active }
}

export interface FakeJob {
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
  /** As the job list writes it (state.createdAt); undefined = not listed. */
  created_at: unknown
  cost: number
  body: Json
  /** Applied one step per job-list read (queued → processing → completed…). */
  script: Partial<FakeJob>[]
  /** When the server made it (this computer's clock; never listed). */
  madeAt: number
}

/** How the fake answers one request (see fakeCanvasapp().state.fault). */
export type Fault =
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
  /** Video download: the connection breaks after `after` bytes of the body. */
  | { kind: 'cut'; after: number }
  /** Video download: the server stops sending after `after` bytes. */
  | { kind: 'stall'; after: number }
  /** Video download: the answer announces more than 1 GB. */
  | { kind: 'oversize' }

export const DEFAULT_SCRIPT: Partial<FakeJob>[] = [
  { status: 'queued', progress: 0 },
  { status: 'processing', progress: 40 },
  { status: 'completed', progress: 100, download_available: true },
]

export interface Logged extends TransportRequest {
  at: number
  /** Streamed video download: the Range header sent (continue from that byte). */
  range?: string
}

/** client_request_id of the jobs "made on canvasapp's own page" (siteJob): a random UUID there, numbered here. */
const SITE_KEY_PREFIX = '0b9d3c55-1d2a-4a6e-9f7e-'

export function fakeCanvasapp() {
  const log: Logged[] = []
  const state = {
    /** Video downloads honour Range + If-Range with an ETag (VERIFY on the live site). */
    rangeSupport: false,
    /** Video answers carry Content-Length. */
    sendLength: true,
    /** The video bytes of a job. */
    video: (jobId: string): Uint8Array => new TextEncoder().encode('MP4:' + jobId),
    authenticated: true,
    balance: 100,
    /** Status for "not enough credits" (canvasapp: VERIFY 400 or 402). */
    insufficientStatus: 402,
    /** The server honours client_request_id (same key → same job, no second charge). VERIFY on the live site. */
    dedupe: true,
    /** Job list items carry client_request_id. VERIFY on the live site. */
    exposeKey: false,
    /** Job list items omit canvas_node_id (VERIFY on the live site: the adapter must then treat a job as on any node). */
    hideNode: false,
    /** Without `exposeKey`: the jobs listed WITH their client_request_id anyway (a list that keys only some: VERIFY). */
    listKeyOf: null as null | ((j: FakeJob) => boolean),
    /** With `dedupe`: a second POST of a key is answered 409 instead of with the job it made (VERIFY). */
    dedupeConflict: false,
    /** Job list items omit model_profile and duration (VERIFY): never a reason to rule a job out. */
    hideSettings: false,
    /** created_at of a new job, from the time it is made (default ISO 8601 UTC; undefined = not listed). */
    createdAt: (ms: number): unknown => new Date(ms).toISOString(),
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

  let jobSeq = 0
  function advance(j: FakeJob): FakeJob {
    const step = j.script.shift()
    if (step) Object.assign(j, step)
    return j
  }
  function publicJob(j: FakeJob): Json {
    const { body: _b, script: _s, cost: _c, project_id: _p, madeAt: _m, client_request_id, canvas_node_id, created_at, ...pub } = j
    const { model_profile, duration, ...rest } = pub
    return {
      ...rest,
      ...(state.hideSettings ? {} : { model_profile, duration }),
      ...(state.hideNode ? {} : { canvas_node_id }),
      ...(created_at === undefined ? {} : { created_at }),
      ...(state.exposeKey || state.listKeyOf?.(j) ? { client_request_id } : {}),
    }
  }

  function createJob(b: Json): BridgeResponse {
    const path = '/api/video-jobs'
    const keyProblem = jobKeyProblem(b)
    if (keyProblem) return refuse(keyProblem.status, keyProblem.detail, path)
    const key = b.client_request_id as string
    if (state.dedupe) {
      const dup = state.jobs.find((j) => j.client_request_id === key)
      if (dup) return state.dedupeConflict ? refuse(409, 'Duplicate client_request_id', path) : ok({ job_id: dup.job_id, status: dup.status })
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
      job_id: 'job' + ++jobSeq,
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
      created_at: state.createdAt(Date.now()),
      cost,
      body: b,
      script: state.script.map((s) => ({ ...s })),
      madeAt: Date.now(),
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
    if (named && req.method === 'GET') {
      // loadProject(): the saved canvas
      const p = state.projects.find((x) => x.project_id === named[1])
      if (!p) return refuse(404, 'Project not found', path)
      return ok({ ...p, canvas: state.canvases.get(p.project_id) ?? { nodes: [], connections: [], viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 } } })
    }
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
    const promptOf = /^\/api\/video-jobs\/([^/]+)\/prompt$/.exec(path)
    if (promptOf && req.method === 'GET') {
      const job = state.jobs.find((j) => j.job_id === promptOf[1])
      return job ? ok({ prompt: job.body.prompt }) : refuse(404, 'Job not found', path)
    }
    const stream = /^\/api\/video-jobs\/([^/]+)\/stream$/.exec(path)
    if (stream && req.method === 'GET') {
      const job = state.jobs.find((j) => j.job_id === stream[1])
      if (!job) return refuse(404, 'Job not found', path)
      if (job.status !== 'completed' || !job.download_available) return refuse(409, 'Video chưa sẵn sàng', path)
      return { ok: true, status: 200, contentType: 'video/mp4', bytes: state.video(job.job_id) }
    }
    const one = /^\/api\/video-jobs\/([^/]+)$/.exec(path)
    if (one && req.method === 'DELETE') {
      state.jobs = state.jobs.filter((j) => j.job_id !== one[1])
      return ok({ ok: true })
    }
    return refuse(404, 'Not found', path)
  }

  // ---- streamed video downloads: main's own sessions in front of the fake server ----
  const lane = mainDownloadLane()
  /** canvasapp's answer to one GET …/stream (Range + If-Range when the gateway continues a download). */
  async function streamFetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<ResponseLike> {
    const path = new URL(url).pathname
    const req: TransportRequest = { method: 'GET', path, binary: true }
    log.push({ ...req, at: Date.now(), ...(init.headers.Range ? { range: init.headers.Range } : {}) })
    const aborted = new Promise<never>((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
    aborted.catch(() => undefined)
    const fault = state.fault?.(req)
    const text = (status: number, json: unknown): ResponseLike => {
      const body = new TextEncoder().encode(JSON.stringify(json ?? {}))
      const r = reader([body])
      return { status, headers: { get: (n) => (n === 'content-type' ? 'application/json' : null) }, body: { getReader: () => r } }
    }
    if (fault?.kind === 'network') throw new Error('offline')
    if (fault?.kind === 'response') return text(fault.status, fault.json)
    if (fault?.kind === 'hang') {
      if (fault.process) handle(req)
      return aborted
    }
    if (fault?.kind === 'wait') await Promise.race([fault.until, aborted])
    const res = handle(req)
    if (fault?.kind === 'lost-response') throw new Error('timeout')
    if (fault?.kind === 'processed-then') return text(fault.status, fault.json)
    if (!res.ok) throw new Error(res.message)
    if (!res.bytes) return text(res.status, res.json)
    const all = res.bytes
    const etag = `"fake-${all.byteLength}"`
    const h: Record<string, string> = { 'content-type': res.contentType }
    if (state.rangeSupport) {
      h['accept-ranges'] = 'bytes'
      h.etag = etag
    }
    const m = /^bytes=(\d+)-$/.exec(init.headers.Range ?? '')
    const from = m && state.rangeSupport && init.headers['If-Range'] === etag ? Number(m[1]) : 0
    const body = all.slice(from)
    if (from > 0) h['content-range'] = `bytes ${from}-${all.byteLength - 1}/${all.byteLength}`
    if (state.sendLength || from > 0) h['content-length'] = String(fault?.kind === 'oversize' ? mainDownloads.CANVASAPP_VIDEO_MAX_BYTES + 1 : body.byteLength)
    const steps: (Uint8Array | 'error' | 'hang')[] =
      fault?.kind === 'cut' ? [body.slice(0, fault.after), 'error'] : fault?.kind === 'stall' ? [body.slice(0, fault.after), 'hang'] : [body]
    const r = reader(steps)
    return { status: from > 0 ? 206 : 200, headers: { get: (n) => h[n] ?? null }, body: { getReader: () => r } }
  }
  /** A body: its pieces, then the end ('error' breaks the connection, 'hang' never sends more until cancelled). */
  function reader(steps: (Uint8Array | 'error' | 'hang')[]): ByteReader {
    let wake: (() => void) | null = null
    return {
      read: () => {
        const step = steps.shift()
        if (step === undefined) return Promise.resolve({ done: true })
        if (step === 'error') return Promise.reject(new Error('connection reset'))
        if (step === 'hang') return new Promise((resolve) => (wake = () => resolve({ done: true })))
        return Promise.resolve({ done: false, value: step })
      },
      cancel: () => {
        wake?.()
        wake = null
        return Promise.resolve()
      },
    }
  }
  const downloads = mainDownloads.createDownloadSessions({
    fetch: streamFetch,
    withSlot: lane.withSlot,
    matchRoute: (p) => {
      const m = mainRoutes.match('GET', String(p)) as { route: { binary?: boolean }; url: URL } | null
      return m ? { binary: !!m.route.binary, url: m.url.toString(), key: m.url.pathname } : null
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  })
  const downloadCalls: string[] = []

  const bridge: CanvasappBridge = {
    status: async () => ({ ok: true, authenticated: state.authenticated }),
    login: async () => {
      state.authenticated = true
      return { ok: true, authenticated: true }
    },
    logout: async () => {
      downloads.closeAll()
      state.authenticated = false
      return { ok: true }
    },
    downloadOpen: async (a: { id: string; path: string; from: number }) => {
      downloadCalls.push(`open ${a.from}`)
      const res = await downloads.open('page', a)
      if (!res.ok && res.code === 'not-allowed') state.refusedByMain.push(`GET ${a.path} (download)`)
      return res as BridgeDownloadOpen
    },
    downloadRead: async (a: { id: string }) => {
      downloadCalls.push('read')
      return (await downloads.read('page', a)) as BridgeDownloadRead
    },
    downloadClose: async (a: { id: string }) => {
      downloadCalls.push('close')
      return downloads.close('page', a)
    },
    request: async (req) => {
      log.push({ ...req, at: Date.now() })
      // what electron/main.cjs checks before anything leaves the computer (canvasapp:request: never the video stream)
      if (!mainRoutes.matchRequest(req.method, req.path)) {
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

  let siteKeys = 0
  /**
   * The user presses "Tạo video" on node `nodeId` of the bridge session on canvasapp's OWN page (after editing it,
   * which saveCanvas() stores first): the body runVideoNode() builds from the saved node (providers/dev/siteClient —
   * shared with the dev server), with a random client_request_id. Not a request SanoVids sent: not logged.
   */
  function siteJob(nodeId: string, edit?: SiteNodeEdit): FakeJob {
    const project = state.projects.find((p) => p.name === 'SanoVids bridge')
    if (!project) throw new Error('no bridge session')
    let canvas: unknown = state.canvases.get(project.project_id)
    if (edit) {
      const r = applyNodeEdit(canvas, nodeId, edit)
      if ('problem' in r) throw new Error(r.problem)
      if (canvasProblem(r.canvas)) throw new Error('edited canvas invalid')
      state.canvases.set(project.project_id, r.canvas as unknown as CanvasPayload)
      canvas = r.canvas
    }
    const key = `${SITE_KEY_PREFIX}${String(++siteKeys).padStart(12, '0')}`
    const built = siteJobBody(canvas, nodeId, project.project_id, key)
    if ('problem' in built) throw new Error(built.problem)
    const res = createJob(built.body)
    if (!res.ok || res.status >= 400) throw new Error(`site job refused: ${JSON.stringify(res.ok ? res.json : res)}`)
    return state.jobs[state.jobs.length - 1]
  }

  const is = (method: string, path: string | RegExp) => (c: Logged) =>
    c.method === method && (typeof path === 'string' ? c.path.split('?')[0] === path : path.test(c.path))
  return {
    bridge,
    state,
    log,
    siteJob,
    /** The server itself (what canvasapp answers a request that reached it), for a test's own model of main. */
    handle,
    /** A job as the job list shows it (what a client can know of it). */
    listView: (j: FakeJob) => publicJob(j),
    /** Stop every video download of the page (main does so when the page reloads, navigates or logs out). */
    closeDownloads: () => downloads.closeAll(),
    /** A client_request_id siteJob() made (canvasapp's own page), never one SanoVids sends. */
    isSiteKey: (key: unknown) => typeof key === 'string' && key.startsWith(SITE_KEY_PREFIX),
    /** downloadOpen / downloadRead / downloadClose as the page called them ("open <from>", "read", "close"). */
    downloadCalls,
    /** Video downloads holding a slot of main's 'download' lane right now. */
    downloadSlots: lane.active,
    count: (method: string, path: string | RegExp) => log.filter(is(method, path)).length,
    jobPosts: () => log.filter(is('POST', '/api/video-jobs')).map((c) => c.json as Json),
    listReads: () => log.filter(is('GET', '/api/video-jobs')),
    /** Requests a job engine would send (everything but auth/state and /api/me). */
    engineCalls: () => log.filter((c) => !['/api/me', '/api/auth/state'].includes(c.path.split('?')[0])),
  }
}

/** A gate the test opens by hand. */
export function gate() {
  let open: () => void = () => undefined
  const until = new Promise<void>((r) => (open = r))
  return { until, open }
}
