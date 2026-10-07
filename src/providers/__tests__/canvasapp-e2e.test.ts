// End-to-end proof of the REAL-credit path, without any network:
//   the real queue engine (store/runs) → the real canvasapp adapter / api / desktop transport (providers/canvasapp)
//   → window.bdpDesktop.canvasapp → an in-memory FAKE canvasapp.io.vn that behaves like the server + electron/main.cjs
//   (401, 402, network errors, lost answers, job progression, MP4 stream) and records every request. Videos come
//   through main's OWN streamed downloads (its <canvasapp-downloads> + <canvasapp-lanes> blocks, run as-is: pieces,
//   slots, idle timeout, 1 GB cap, Range only with the ETag); canvasapp:request refuses the stream like main does
//   (matchCanvasappRequest), so a video can only come in pieces.
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

import { createSceneFromTake, rerunTake, restoreFromTake, runNow, takeFileBase } from '../../actions'
import { importSiteJobs, scanForImport } from '../../siteJobActions'
import { defaultPicks } from '../../components/runs/importJobsModel'
import { restoreBlock, takeSettingsText } from '../../components/runs/importedTake'
import { NO_VIDEO_REFS_REASON } from '../../core/runGate'
import { costOf, MODELS } from '../../core/models'
import type { Asset, Mode, ModelId, Project, Scene, Take } from '../../core/types'
import { takeFiles } from '../../lib/downloads'
import { refreshRealCredits, resetRealCredits, startRealCreditsSync, useRealCredits } from '../../store/credits'
import { transferPercent, useTakeTransfers } from '../../store/takeTransfers'
import { useTakeWaits } from '../../store/takeWaits'
import type { LockManagerLike } from '../../store/engineLock'
import { undo, useProject } from '../../store/project'
import { useUI } from '../../store/ui'
import { takeCostLine } from '../../components/runs/creditText'
import { heldBackSubmitError, isUncertainSubmit, MAX_REMOTE_CONCURRENCY, onRunEvent, setEngineHooks, setEngineLockManager, UNKNOWN_SUBMIT_ERROR, useRuns, type RunEvent } from '../../store/runs'
import mainSource from '../../../electron/main.cjs?raw'
import { createCanvasappApi, type CanvasPayload, type TransportRequest } from '../canvasapp/api'
import {
  CANVAS_NOT_SAVED_TEXT,
  createCanvasappProvider,
  JOBS_KEY,
  MAX_CONCURRENCY,
  memoryStorage,
  PROFILES_TTL_MS,
  STATE_KEY,
  LOOKUP_FAILED_TEXT,
  RIVAL_PENDING_TEXT,
  STILL_SENDING_TEXT,
  type KeyValueStorage,
} from '../canvasapp/adapter'
import { canvasNodeId, clientRequestIdFor, sceneNodeId } from '../canvasapp/mapping'
import { createDesktopTransport, type BridgeDownloadOpen, type BridgeDownloadRead, type BridgeResponse, type CanvasappBridge } from '../canvasapp/transport'
import type * as DownloadsPort from '../dev/downloads'
import type { ByteReader, ResponseLike } from '../dev/downloads'
import { getProvider, providerLimits, refreshProviderLimits, registerProvider, useProviderPrefs } from '../index'
import type { JobRequest } from '../types'
import { canvasProblem, isObj, jobBodyProblem, jobKeyProblem, sameKeys } from '../dev/validate'
import { applyNodeEdit, siteJobBody, type SiteNodeEdit } from '../dev/siteClient'

// ---------------------------------------------------------------------------------------------------------------
// Fake canvasapp.io.vn (server + what electron/main.cjs returns over IPC)
// ---------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>

/**
 * electron/main.cjs's own endpoint allowlist (the <canvasapp-routes> block, run as-is): `match` for downloads,
 * `matchRequest` for canvasapp:request (never the video stream).
 */
function loadMainRoutes(): { match: (method: string, path: string) => unknown; matchRequest: (method: string, path: string) => unknown; maxJsonBytes: number } {
  const m = /\/\/ <canvasapp-routes>[^\n]*\n([\s\S]*?)\/\/ <\/canvasapp-routes>/.exec(mainSource)
  if (!m) throw new Error('canvasapp-routes block not found in electron/main.cjs')
  const factory = new Function(
    'CANVASAPP_ORIGIN',
    `${m[1]}\nreturn { match: matchCanvasappRoute, matchRequest: matchCanvasappRequest, maxJsonBytes: CANVASAPP_MAX_JSON_BYTES }`,
  ) as (origin: string) => { match: (method: string, path: string) => unknown; matchRequest: (method: string, path: string) => unknown; maxJsonBytes: number }
  return factory('https://canvasapp.io.vn')
}
const mainRoutes = loadMainRoutes()

function mainBlock(name: string): string {
  const m = new RegExp(`// <${name}>[^\\n]*\\n([\\s\\S]*?)// </${name}>`).exec(mainSource)
  if (!m) throw new Error(`${name} block not found in electron/main.cjs`)
  return m[1]
}
/** electron/main.cjs's video downloads (the <canvasapp-downloads> block, run as-is). */
const mainDownloads = new Function(`${mainBlock('canvasapp-downloads')}\nreturn { createDownloadSessions, CANVASAPP_VIDEO_MAX_BYTES }`)() as Pick<
  typeof DownloadsPort,
  'createDownloadSessions' | 'CANVASAPP_VIDEO_MAX_BYTES'
>
/** A fresh 'download' lane of main's <canvasapp-lanes> block (as-is). */
function mainDownloadLane() {
  const l = new Function(`${mainBlock('canvasapp-lanes')}\nreturn { withSlot: withCanvasappSlot, lanes: canvasappLanes }`)() as {
    withSlot: (lane: string, fn: () => Promise<unknown>) => Promise<unknown>
    lanes: { download: { active: number } }
  }
  return { withSlot: (fn: () => Promise<unknown>) => l.withSlot('download', fn), active: () => l.lanes.download.active }
}

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
  /** Video download: the connection breaks after `after` bytes of the body. */
  | { kind: 'cut'; after: number }
  /** Video download: the server stops sending after `after` bytes. */
  | { kind: 'stall'; after: number }
  /** Video download: the answer announces more than 1 GB. */
  | { kind: 'oversize' }

const DEFAULT_SCRIPT: Partial<FakeJob>[] = [
  { status: 'queued', progress: 0 },
  { status: 'processing', progress: 40 },
  { status: 'completed', progress: 100, download_available: true },
]

interface Logged extends TransportRequest {
  at: number
  /** Streamed video download: the Range header sent (continue from that byte). */
  range?: string
}

function fakeCanvasapp() {
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
    const key = `0b9d3c55-1d2a-4a6e-9f7e-${String(++siteKeys).padStart(12, '0')}`
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

/** Bridge canvas node of a scene of the test project 'p'. */
const nodeOf = (sceneId: string) => sceneNodeId('p', sceneId)

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
    // canvas → job list (what is on the node before the POST) → job
    expect(fake.engineCalls().map((c) => `${c.method} ${c.path.split('?')[0]}`).slice(0, 11)).toEqual([
      'GET /api/video-profiles',
      'GET /api/projects',
      'POST /api/projects',
      'PATCH /api/projects/proj1',
      'POST /api/uploads/images',
      'POST /api/uploads/images',
      'POST /api/uploads/images',
      'POST /api/uploads/images',
      'PUT /api/projects/proj1/canvas',
      'GET /api/video-jobs',
      'POST /api/video-jobs',
    ])
    expect([...fake.state.uploads.values()].map((u) => u.content)).toEqual(['IMG:img_e1', 'IMG:img_l1', 'IMG:img_l2', 'IMG:img_v1'])
    expect(fake.state.uploads.get('up3')).toMatchObject({ type: 'image/jpeg' })

    const [body] = fake.jobPosts()
    expect(body).toMatchObject({
      project_id: 'proj1',
      model_profile: 'seedance_2_5',
      canvas_node_id: nodeOf('s1'),
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
    const refs = canvas.connections.filter((c) => c.to === nodeOf('s1') && c.target_handle === 'reference').sort((a, b) => a.order - b.order)
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
      // an explicit retry right away: main may still be sending the request of the closed page — not posted again yet
      // — and the take says so (wait, try again later), still "unknown"
      useRuns.getState().retry(t.id)
      await run(1_000)
      expect(take(t.id)).toMatchObject({ status: 'failed', error: heldBackSubmitError('canvasapp', STILL_SENDING_TEXT), remoteId: null, submitUnknown: true })
      expect(take(t.id).error).toContain('Thử lại sau vài phút')
      expect(isUncertainSubmit(take(t.id))).toBe(true)
      expect(fake.count('POST', '/api/video-jobs')).toBe(1)
      // ...once that request is surely over: same key, one job
      await run(5 * 60_000)
      useRuns.getState().retry(t.id)
      await run(60_000)
      expect(fake.state.jobs.map((j) => j.client_request_id)).toEqual([clientRequestIdFor(t.id)])
      expect(take(t.id).remoteId).toBe('proj1:job1')
    }
  })

  it('closed while posting: another take of that scene waits — saying why and until when — while other scenes run, then it is posted once; each its own job', async () => {
    fake.state.fault = (req) => (req.method === 'POST' && req.path === '/api/video-jobs' ? { kind: 'hang', process: false } : undefined)
    const [a] = enqueue('s1')
    await run(300)
    const onDisk = saved()
    fake.state.fault = null
    restart(onDisk)
    // right after the restart: a new take of the same scene, and one of another scene
    const [b] = enqueue('s1')
    const [c] = enqueue('s2')
    // A is looked for (at once, then once more 45 s later): nothing → "không rõ"
    await run(50_000)
    expect(take(a.id)).toMatchObject({ status: 'failed', error: UNKNOWN_SUBMIT_ERROR, remoteId: null })
    // B waits (main may still be sending A's request for minutes): nothing sent, and it says why and until when
    expect(take(b.id)).toMatchObject({ status: 'queued', remoteId: null, error: null })
    const wait = useTakeWaits.getState().byTake[b.id]
    expect(wait).toMatchObject({ why: RIVAL_PENDING_TEXT, provider: 'canvasapp' })
    expect(wait.until).toBeGreaterThan(Date.now() + 4 * 60_000)
    // C, another scene, runs meanwhile
    await run(1_000)
    expect(take(c.id).remoteId).toBe('proj1:job1')
    // once a read surely shows A's job (if any): B is sent, once — the reason is gone
    await run(6 * 60_000)
    expect(take(b.id).remoteId).toBe('proj1:job2')
    expect(useTakeWaits.getState().byTake[b.id]).toBeUndefined()
    expect(fake.state.jobs.map((j) => j.client_request_id)).toEqual([clientRequestIdFor(c.id), clientRequestIdFor(b.id)])
    expect(fake.count('POST', '/api/video-jobs')).toBe(3) // A's (hung, never arrived), C's, B's
  })

  it('“Chạy lại” while the job list cannot be read: held back with the reason, still “không rõ”, nothing sent', async () => {
    fake.state.fault = (req) => (req.method === 'POST' && req.path === '/api/video-jobs' ? { kind: 'hang', process: false } : undefined)
    const [t] = enqueue('s1')
    await run(300)
    const onDisk = saved()
    fake.state.fault = null
    restart(onDisk)
    await run(60_000)
    expect(take(t.id)).toMatchObject({ status: 'failed', error: UNKNOWN_SUBMIT_ERROR, remoteId: null })
    // long after: that request is surely over — but the job list cannot be read to look for its job
    await run(6 * 60_000)
    fake.state.fault = (req) => (req.method === 'GET' && req.path.startsWith('/api/video-jobs?') ? { kind: 'response', status: 503, json: { detail: 'down' } } : undefined)
    useRuns.getState().retry(t.id)
    await run(1_000)
    const after = take(t.id)
    expect(after).toMatchObject({ status: 'failed', remoteId: null, submitUnknown: true })
    expect(after.error!.startsWith(`${heldBackSubmitError('canvasapp', LOOKUP_FAILED_TEXT)} (`)).toBe(true)
    expect(isUncertainSubmit(after)).toBe(true)
    expect(fake.count('POST', '/api/video-jobs')).toBe(1) // only the request that hung
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
    // on its own project's node (the request was built when it was sent), never on one of the project open now
    expect(fake.jobPosts()[0].canvas_node_id).toBe(nodeOf('s1'))
    expect(videosOf(fake.state.canvases.get('proj1')!)).toEqual([nodeOf('s1')])

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
    expect(fake.jobPosts()[0].canvas_node_id).toBe(nodeOf('s1'))
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
    expect(canvas.connections.filter((c) => c.to === nodeOf('s4')).map((c) => [c.target_handle, c.order])).toEqual([
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

describe('gateway e2e: projects sharing scene ids (Nhân bản dự án, a file imported twice)', () => {
  /** "Nhân bản dự án": the same scenes (ids included) under a new project id, s1's prompt edited in the copy. */
  const copy = (): Project => ({
    ...project(),
    id: 'p2',
    name: 'P (bản sao)',
    scenes: project().scenes.map((s) => (s.id === 's1' ? { ...s, prompt: '@image_1 ôm @image_3 trên bãi biển đêm' } : s)),
  })
  /** Bridge state as the build before per-project nodes left it: project proj1, entries / ledger as given. */
  function seedBridge(entries: Record<string, unknown>, ledger: { jobs?: Record<string, unknown>; sent?: Record<string, unknown> }) {
    fake.state.projects.push({ project_id: 'proj1', name: 'SanoVids bridge' })
    storage.set(STATE_KEY, JSON.stringify({ projectId: 'proj1', uploads: {}, entries }))
    storage.set(JOBS_KEY, JSON.stringify({ jobs: ledger.jobs ?? {}, sent: ledger.sent ?? {} }))
    installProvider() // the app starts with that state
  }
  /** A take of `sceneId` in the open project, as it was saved while "processing" (`remoteId` when known). */
  function savedProcessing(sceneId: string, remoteId: string | null): Take {
    const [t] = enqueue(sceneId)
    const left: Take = { ...JSON.parse(JSON.stringify(t)), status: 'processing', startedAt: Date.now() - 60_000, progress: 5, remoteId }
    useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
    return left
  }

  it('the original and its copy run the same scene: two nodes, each with its own prompt, two jobs — nothing lost, nothing re-posted', async () => {
    const watch = watchRunningNodes()
    const [a] = enqueue('s1')
    await run(300)
    const pOnDisk = saved()
    useProject.getState().loadProject(copy())
    useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
    const [b] = enqueue('s1')
    await run(300)
    expect(fake.jobPosts().map((x) => x.canvas_node_id)).toEqual([nodeOf('s1'), sceneNodeId('p2', 's1')])
    const canvas = fake.state.canvases.get('proj1')!
    expect(canvas.nodes.flatMap((n) => (n.type === 'video' ? [[n.id, n.data.prompt]] : []))).toEqual([
      [sceneNodeId('p2', 's1'), copy().scenes[0].prompt],
      [nodeOf('s1'), PROMPT], // the original's node keeps its prompt while its job runs
    ])
    expect(fake.state.uploads.size).toBe(4) // same pictures: uploaded once, one image node each
    await run(45_000)
    expect(take(b.id)).toMatchObject({ status: 'completed', remoteId: 'proj1:job2' })
    expect(await media.get(take(b.id).videoId!)!.text()).toBe('MP4:job2')
    useProject.getState().loadProject(project())
    useRuns.getState().loadRuns({ takes: pOnDisk, credits: 1000, spent: 0 })
    await run(45_000)
    expect(take(a.id)).toMatchObject({ status: 'completed', remoteId: 'proj1:job1' })
    expect(await media.get(take(a.id).videoId!)!.text()).toBe('MP4:job1')
    expect(fake.count('POST', '/api/video-jobs')).toBe(2)
    expect(watch.lost).toEqual([])
    expect(fake.state.balance).toBe(100 - 2 * S1_COST)
  })

  it('after an update, a take running on its old node keeps it (never re-posted, never lost); new takes use the project’s node', async () => {
    const legacy = canvasNodeId('s1')
    const old = savedProcessing('s1', 'proj1:job1')
    const idle = (i: number) => ({ sceneId: `x${i}`, model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9', prompt: `cũ ${i}`, uploadIds: [], firstFrameUploadId: null, lastFrameUploadId: null, usedAt: 10 + i })
    const legacyEntry = { ...idle(0), sceneId: 's1', prompt: PROMPT, usedAt: 1 }
    // what the earlier build left: s1's entry by scene id, 38 idle scenes, its ledger, the job running on canvasapp
    seedBridge({ s1: legacyEntry, ...Object.fromEntries(Array.from({ length: 38 }, (_, i) => [`x${i}`, idle(i)])) }, {
      jobs: { [old.id]: { remoteId: 'proj1:job1', at: Date.now() - 60_000, nodeId: legacy } },
    })
    fake.state.jobs.push({
      job_id: 'job1',
      project_id: 'proj1',
      canvas_node_id: legacy,
      client_request_id: clientRequestIdFor(old.id),
      model_profile: 'seedance_2_5',
      duration: 15,
      aspect_ratio: '16:9',
      status: 'processing',
      submission_state: 'accepted',
      progress: 40,
      download_available: false,
      error_message: null,
      created_at: new Date(Date.now() - 60_000).toISOString(),
      cost: S1_COST,
      body: {},
      script: [{ status: 'processing', progress: 60 }, { status: 'processing', progress: 80 }, { status: 'processing', progress: 90 }, { status: 'completed', progress: 100, download_available: true }],
    })
    useRuns.getState().loadRuns({ takes: [old], credits: 1000, spent: 0 })
    const watch = watchRunningNodes()
    // a new take of the same scene (4 pictures) + two more scenes: room is made from the idle scenes only
    const fresh = enqueue('s1', 's2', 's3')
    await run(5_000)
    expect(fake.jobPosts().map((x) => x.canvas_node_id)).toEqual(['s1', 's2', 's3'].map(nodeOf))
    expect(videosOf(fake.state.canvases.get('proj1')!)).toContain(legacy)
    await run(120_000)
    expect(take(old.id)).toMatchObject({ status: 'completed', remoteId: 'proj1:job1' })
    expect(fresh.every((t) => take(t.id).status === 'completed')).toBe(true)
    expect(fake.jobPosts().map((x) => x.client_request_id)).not.toContain(clientRequestIdFor(old.id))
    expect(fake.count('POST', '/api/video-jobs')).toBe(3)
    expect(watch.lost).toEqual([])
    expect(fake.state.balance).toBe(100 - S1_COST - costOf(project().scenes[1].settings) - costOf(project().scenes[2].settings))
  })

  it.each([
    ['its own node, server deduplicates', 'new', true],
    ['its own node, server does not deduplicate', 'new', false],
    ['an old node (sent by the build before), server does not deduplicate', 'legacy', false],
  ])(
    'a lost answer in the copy is never taken by an unsure take of the original (%s): one job, charged once',
    async (_label, where, dedupe) => {
      fake.state.dedupe = dedupe
      // the original: take A was being sent when the app closed — its POST never reached canvasapp
      const a = savedProcessing('s1', null)
      const aNode = where === 'legacy' ? canvasNodeId('s1') : nodeOf('s1')
      seedBridge({}, { sent: { [a.id]: { projectId: 'proj1', nodeId: aNode, at: Date.now() - 30_000, before: [] } } })
      // the copy: take B of the same scene, canvasapp creates its job but the answer is lost
      useProject.getState().loadProject(copy())
      useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
      let lose = true
      fake.state.fault = (req) => {
        if (req.method !== 'POST' || req.path !== '/api/video-jobs' || !lose) return undefined
        lose = false
        return { kind: 'lost-response' }
      }
      const [b] = enqueue('s1')
      await run(300)
      expect(fake.state.jobs).toHaveLength(1)
      const bOnDisk = saved()
      // while B waits to look for its job, the original is opened: A is looked up
      useProject.getState().loadProject(project())
      useRuns.getState().loadRuns({ takes: [a], credits: 1000, spent: 0 })
      await run(60_000)
      expect(take(a.id)).toMatchObject({ status: 'failed', error: UNKNOWN_SUBMIT_ERROR, remoteId: null })
      // back to the copy: B has its own job
      useProject.getState().loadProject(copy())
      useRuns.getState().loadRuns({ takes: bOnDisk, credits: 1000, spent: 0 })
      await run(60_000)
      expect(take(b.id)).toMatchObject({ status: 'completed', remoteId: 'proj1:job1' })
      expect(fake.count('POST', '/api/video-jobs')).toBe(1)
      expect(fake.state.jobs).toHaveLength(1)
      expect(fake.state.balance).toBe(100 - S1_COST)
    },
  )
})

describe('gateway e2e: gentleness and engine ownership', () => {
  it('at most 10 jobs in flight; one job-list read per poll for all of them, never closer than 15 s', async () => {
    expect(MAX_CONCURRENCY).toBe(10)
    expect(MAX_REMOTE_CONCURRENCY).toBe(10)
    // still running whatever the number of reads (this fake moves a job one step per job-list read)
    fake.state.script = [{ status: 'queued' }, ...Array.from({ length: 40 }, () => ({ status: 'processing', progress: 20 }))]
    // 12 scenes (more than the cap): Seedance 2.5 · 5 s · 480p each
    const ids = Array.from({ length: 12 }, (_, i) => `m${i + 1}`)
    useProject.getState().loadProject({ ...project(), scenes: ids.map((id, i) => scene(id, i + 1)) })
    const all = enqueue(...ids)
    const keys = (list: Take[]) => list.map((t) => clientRequestIdFor(t.id))
    await run(60_000)
    expect(fake.jobPosts().map((x) => x.client_request_id)).toEqual(keys(all.slice(0, 10)))
    expect(takes().filter((x) => x.status === 'processing')).toHaveLength(10)
    expect(all.slice(10).map((t) => take(t.id).status)).toEqual(['queued', 'queued'])
    // ten running jobs, still one read of the job list per poll cycle (not one per job) — plus the one right before
    // each POST (what is on the node before it)
    const reads = fake.listReads().length - fake.count('POST', '/api/video-jobs')
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(4)
    // the first ten complete → the last two go
    for (const j of fake.state.jobs) j.script = [{ status: 'completed', progress: 100, download_available: true }]
    fake.state.script = DEFAULT_SCRIPT
    await run(60_000)
    expect(fake.jobPosts().map((x) => x.client_request_id)).toEqual(keys(all))
    await run(120_000)
    expect(takes().every((x) => x.status === 'completed')).toBe(true)
    expect(fake.count('POST', '/api/video-jobs')).toBe(12)
    // two reads of the job list without a job POST between them are ≥ 15 s apart (after a POST, the list is read again
    // at once: electron/main.cjs drops its 15 s cache there too)
    const order = fake.log.filter((c) => c.path.split('?')[0] === '/api/video-jobs' && (c.method === 'GET' || c.method === 'POST'))
    for (let i = 1; i < order.length; i++) {
      if (order[i].method === 'GET' && order[i - 1].method === 'GET') expect(order[i].at - order[i - 1].at).toBeGreaterThanOrEqual(15_000)
    }
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

  it('10 scenes × 4 different characters: a running job never loses its node; the 8th waits in the queue for room', async () => {
    // still running whatever the number of reads (this fake moves a job one step per job-list read)
    fake.state.script = [{ status: 'queued' }, ...Array.from({ length: 40 }, () => ({ status: 'processing', progress: 30 }))]
    const watch = watchRunningNodes()
    const all = enqueue(...crowd(10, 4))
    await run(5_000)
    // 7 scenes fill the canvas (7 × 4 = 28 of the 30 pictures it may hold): the 8th would push a running scene off
    expect(fake.count('POST', '/api/video-jobs')).toBe(7)
    expect(all.slice(0, 7).every((t) => take(t.id).status === 'processing' && !!take(t.id).remoteId)).toBe(true)
    expect(all.slice(7).map((t) => take(t.id).status)).toEqual(['queued', 'queued', 'queued']) // honestly waiting
    expect(fake.count('POST', '/api/uploads/images')).toBe(28) // the waiting scenes uploaded nothing yet
    // running jobs end → room → the others go, three more PUTs
    for (const j of fake.state.jobs) j.script = [{ status: 'processing', progress: 60 }, { status: 'completed', progress: 100, download_available: true }]
    fake.state.script = [{ status: 'queued' }, { status: 'processing', progress: 30 }, { status: 'processing', progress: 60 }, { status: 'completed', progress: 100, download_available: true }]
    await run(300_000)
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
    expect(videosOf(watch.puts[0]).sort()).toEqual(ids.map(nodeOf).sort()) // refused: every scene
    expect(videosOf(watch.puts[1]).sort()).toEqual(ids.slice(1).map(nodeOf).sort()) // without m1 only
    expect(watch.lost).toEqual([])
    const onCanvasapp = videosOf(fake.state.canvases.get('proj1')!)
    for (const id of ids.slice(1, 10)) expect(onCanvasapp).toContain(nodeOf(id)) // the 9 running nodes
    if (sent) {
      expect(take(last.id).remoteId).toBe('proj1:job11')
    } else {
      // refused again: nothing billed, nothing taken off the canvas on canvasapp
      expect(take(last.id).status).toBe('failed')
      expect(take(last.id).error!.startsWith(CANVAS_NOT_SAVED_TEXT)).toBe(true)
      expect(fake.jobPosts()).toHaveLength(10)
      expect(onCanvasapp.sort()).toEqual(ids.slice(0, 10).map(nodeOf).sort())
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
    expect(fake.downloadCalls.length).toBeGreaterThan(0) // in pieces: never through canvasapp:request
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

describe('gateway e2e: streamed video download (main’s pieces, slots and timeouts)', () => {
  const streamGets = () => fake.log.filter((c) => c.method === 'GET' && c.path === '/api/video-jobs/job1/stream')
  /** A video bigger than one piece (4 MiB): 6 MiB. */
  const BIG = 6 * 1024 * 1024
  const big = (jobId: string) => {
    const b = new Uint8Array(BIG)
    b.fill(jobId.length)
    b[0] = 77
    b[BIG - 1] = 88
    return b
  }

  it('in pieces of ≤ 4 MiB, with "Đang tải về …%" while it comes; the same bytes end up stored', async () => {
    fake.state.video = big
    const seen: (number | null)[] = []
    const off = useTakeTransfers.subscribe((st) => {
      const t = Object.values(st.byTake)[0]
      if (t) seen.push(transferPercent(t))
    })
    const [t] = enqueue('s1')
    await run(45_000)
    off()
    expect(take(t.id).status).toBe('completed')
    const stored = new Uint8Array(await media.get(take(t.id).videoId!)!.arrayBuffer())
    expect(stored.byteLength).toBe(BIG)
    expect([stored[0], stored[BIG - 1]]).toEqual([77, 88])
    expect(media.get(take(t.id).videoId!)!.type).toBe('video/mp4')
    expect(fake.downloadCalls.filter((c) => c === 'read')).toHaveLength(3) // 4 MiB + 2 MiB + the end
    expect(seen.length).toBeGreaterThan(0)
    expect(useTakeTransfers.getState().byTake).toEqual({}) // cleared once done
    expect(fake.downloadSlots()).toBe(0)
  })

  it('cut half-way, canvasapp sends an ETag and takes Range → continues where it stopped, in the same attempt', async () => {
    fake.state.video = big
    fake.state.rangeSupport = true
    let cuts = 1
    fake.state.fault = (req) => (req.path.endsWith('/stream') && cuts-- > 0 ? { kind: 'cut', after: 5 * 1024 * 1024 } : undefined)
    const [t] = enqueue('s1')
    await run(45_000)
    expect(take(t.id).status).toBe('completed')
    expect(streamGets().map((c) => c.range ?? null)).toEqual([null, 'bytes=5242880-']) // nothing fetched twice
    const stored = new Uint8Array(await media.get(take(t.id).videoId!)!.arrayBuffer())
    expect([stored.byteLength, stored[0], stored[BIG - 1]]).toEqual([BIG, 77, 88])
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })

  it('Wi-Fi drops mid-download for a few seconds (cut, then reopens that cannot connect): continues where it stopped — nothing fetched twice', async () => {
    fake.state.video = big
    fake.state.rangeSupport = true
    const script: ('cut' | 'network')[] = ['cut', 'network', 'network']
    fake.state.fault = (req) => {
      if (!req.path.endsWith('/stream')) return undefined
      const next = script.shift()
      return next === 'cut' ? { kind: 'cut', after: 5 * 1024 * 1024 } : next === 'network' ? { kind: 'network' } : undefined
    }
    const [t] = enqueue('s1')
    await run(45_000)
    expect(take(t.id).status).toBe('processing') // waiting to reopen: kept at 99 %, the 5 MiB that came are kept
    await run(10_000) // 2 s + 5 s of waits
    expect(take(t.id).status).toBe('completed')
    expect(streamGets().map((c) => c.range ?? null)).toEqual([null, 'bytes=5242880-', 'bytes=5242880-', 'bytes=5242880-'])
    const stored = new Uint8Array(await media.get(take(t.id).videoId!)!.arrayBuffer())
    expect([stored.byteLength, stored[0], stored[BIG - 1]]).toEqual([BIG, 77, 88])
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
    expect(fake.downloadSlots()).toBe(0)
  })

  it('cut without Range support → no resume; the engine downloads it again later from the start (still one job)', async () => {
    let cuts = 1
    fake.state.fault = (req) => (req.path.endsWith('/stream') && cuts-- > 0 ? { kind: 'cut', after: 4 } : undefined)
    const [t] = enqueue('s1')
    await run(45_000)
    expect(take(t.id).status).toBe('processing') // paid video: kept at 99 %, never "failed"
    await run(60_000)
    expect(take(t.id).status).toBe('completed')
    expect(await media.get(take(t.id).videoId!)!.text()).toBe('MP4:job1')
    expect(streamGets().map((c) => c.range ?? null)).toEqual([null, null])
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })

  it('a stalled download stops after 60 s without data (its slot comes back), then succeeds on the next try', async () => {
    let stalls = 1
    fake.state.fault = (req) => (req.path.endsWith('/stream') && stalls-- > 0 ? { kind: 'stall', after: 2 } : undefined)
    const [t] = enqueue('s1')
    await run(45_000)
    expect(take(t.id).status).toBe('processing')
    expect(fake.downloadSlots()).toBe(1)
    await run(61_000)
    expect(fake.downloadSlots()).toBe(0)
    await run(60_000)
    expect(take(t.id).status).toBe('completed')
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })

  it('over 1 GB → the take fails at once (paid, where to get it) — not five tries of the same refusal', async () => {
    fake.state.fault = (req) => (req.path.endsWith('/stream') ? { kind: 'oversize' } : undefined)
    const [t] = enqueue('s1')
    await run(45_000)
    expect(take(t.id)).toMatchObject({ status: 'failed', remoteId: 'proj1:job1' })
    expect(take(t.id).error).toMatch(/đã trừ credit/)
    expect(take(t.id).error).toContain('Video lớn hơn 1 GB')
    await run(30 * 60_000)
    expect(streamGets()).toHaveLength(1)
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })

  it('cancelling a take while its video downloads closes the download (slot freed) — cancelled, not failed', async () => {
    const g1 = gate()
    fake.state.fault = (req) => (req.path === '/api/video-jobs/job1/stream' ? { kind: 'wait', until: g1.until } : undefined)
    const [a, b] = enqueue('s1', 's2')
    await run(45_000)
    expect(take(a.id).status).toBe('processing')
    expect(fake.downloadSlots()).toBeGreaterThan(0)
    useRuns.getState().cancel(a.id)
    await run(0)
    expect(fake.downloadCalls).toContain('close')
    expect(take(a.id)).toMatchObject({ status: 'cancelled' })
    await run(60_000)
    expect(take(b.id).status).toBe('completed') // the other take's download had a slot
    expect(take(a.id).status).toBe('cancelled')
    expect(events.filter((e) => e.type === 'failed')).toEqual([])
    g1.open()
    await run(1_000)
    expect(fake.downloadSlots()).toBe(0)
    expect(fake.count('POST', '/api/video-jobs')).toBe(2)
  })

  it('switching project mid-download stops it; reopening downloads it again and completes — still one POST', async () => {
    let stalls = 1
    fake.state.fault = (req) => (req.path.endsWith('/stream') && stalls-- > 0 ? { kind: 'stall', after: 2 } : undefined)
    const [t] = enqueue('s1')
    await run(45_000)
    expect(take(t.id).status).toBe('processing')
    expect(fake.downloadSlots()).toBe(1)
    const keep = saved()
    useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 }) // another project
    await run(0)
    expect(fake.downloadSlots()).toBe(0)
    expect(fake.downloadCalls).toContain('close')
    restart(keep)
    await run(60_000)
    expect(take(t.id).status).toBe('completed')
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })

  it('MONEY: a video of unknown size cut by a logout is never stored as finished; after logging in it downloads whole', async () => {
    fake.state.sendLength = false
    let stalls = 1
    fake.state.fault = (req) => (req.path.endsWith('/stream') && stalls-- > 0 ? { kind: 'stall', after: 4 } : undefined)
    const [t] = enqueue('s1')
    await run(45_000)
    expect(take(t.id).status).toBe('processing')
    await fake.bridge.logout() // main ends every download (the half-read body is never "done")
    await run(1_000)
    expect(take(t.id)).toMatchObject({ status: 'processing', videoId: null })
    expect(fake.downloadSlots()).toBe(0)
    await fake.bridge.login()
    await run(10 * 60_000)
    expect(take(t.id).status).toBe('completed')
    expect(await media.get(take(t.id).videoId!)!.text()).toBe('MP4:job1')
    expect(fake.count('POST', '/api/video-jobs')).toBe(1)
  })
})

describe('gateway e2e: reference videos (@video_N) — nothing on record says canvasapp takes one', () => {
  /** A finished canvasapp take of s2, ready to be a reference video; the fake's request log is cleared after it. */
  async function finishedTake(): Promise<Take> {
    const [t] = enqueue('s2')
    await run(60_000)
    expect(take(t.id).status).toBe('completed')
    fake.log.length = 0
    return take(t.id)
  }

  it('a scene that sends a video is skipped with the shared reason: not one request reaches canvasapp, nothing is paid', async () => {
    const t = await finishedTake()
    const balance = fake.state.balance
    useUI.setState({ toasts: [] })
    const id = createSceneFromTake(t.id)!
    expect(useUI.getState().toasts.at(-1)).toMatchObject({ tone: 'warning', text: expect.stringContaining('bỏ video tham chiếu (@video_1) khỏi cảnh') })
    useProject.getState().updateScene(id, { prompt: 'Continue from @video_1: trời tạnh mưa' })
    const r = useRuns.getState().enqueue([id])
    expect(r).toMatchObject({ queued: 0, skipped: [{ sceneId: id, reason: NO_VIDEO_REFS_REASON }] })
    await run(30_000)
    expect(fake.engineCalls()).toEqual([])
    expect(fake.state.balance).toBe(balance)
  })

  it('the adapter refuses a request carrying a video before any upload, canvas save or job POST', async () => {
    const t = await finishedTake()
    const req: JobRequest = {
      key: 'take_video',
      takeId: 'take_video',
      sceneId: 's1',
      sanovidsProjectId: 'p',
      sceneCode: 'S01',
      takeNumber: 9,
      title: '',
      color: '#fff',
      model: 'seedance_2_5',
      mode: 't2v',
      duration: 5,
      resolution: '480p',
      ratio: '16:9',
      prompt: '@image_1 tiếp nối @video_1',
      rawPrompt: '@image_1 tiếp nối @video_1',
      images: [{ n: 1, assetId: 'elara', imageId: 'img_e1' }],
      videos: [{ n: 1, takeId: t.id, videoId: t.videoId, posterId: t.posterId }],
      firstFrame: null,
      lastFrame: null,
      startedAt: 0,
    }
    await expect(getProvider('canvasapp').submit(req)).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('chưa hỗ trợ video tham chiếu') })
    expect(fake.count('POST', '/api/uploads/images')).toBe(0)
    expect(fake.count('PUT', /\/canvas$/)).toBe(0)
    expect(fake.count('POST', '/api/video-jobs')).toBe(0)
    expect(JSON.parse(storage.get(JOBS_KEY) ?? '{}').sent?.take_video).toBeUndefined()
  })

  it('MiniMax-H3 t2v with a leftover reference video (no @video token) runs, and its body carries no video', async () => {
    const t = await finishedTake()
    const h3 = { model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '768p', ratio: '16:9' } as const
    useProject.getState().loadProject({ ...project(), scenes: [...project().scenes, scene('s5', 5, { prompt: 'Một con mèo', videoRefs: [t.id], settings: { ...h3 } })] })
    const [t5] = enqueue('s5')
    await run(300)
    const [body] = fake.jobPosts()
    expect(body).toMatchObject({ model_profile: 'minimax_h3', mode: 't2v', upload_ids: [], client_request_id: clientRequestIdFor(t5.id) })
    expect(Object.keys(body).filter((k) => /video/i.test(k))).toEqual([])
    await run(60_000)
    expect(take(t5.id).status).toBe('completed')
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
    expect(video).toMatchObject({ id: nodeOf('r1'), w: 390, h: 600 })
    expect(video.data).toEqual({ model_profile: 'seedance_2_5', duration: 30, resolution: '480p', aspect_ratio: '16:9', mode: 't2v', prompt: take(t.id).promptSnapshot })
    const [body] = fake.jobPosts()
    expect(body).toEqual({
      project_id: 'proj1',
      model_profile: 'seedance_2_5',
      canvas_node_id: nodeOf('r1'),
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

  it('once a run has read that MiniMax-H3 cannot create, the run check skips H3 scenes up front (no take, nothing sent)', async () => {
    fake.state.profiles = fake.state.profiles.map((p) => (p.model_profile === 'minimax_h3' ? { ...p, can_create: false } : p))
    const [sd] = enqueue('s2')
    await run(300)
    expect(take(sd.id).remoteId).toBe('proj1:job1')
    expect(providerLimits('canvasapp')).toMatchObject({ source: 'server', firm: true })
    expect(useRuns.getState().check(['s4'])[0]).toMatchObject({ ok: false, reason: 'MiniMax-H3 hiện không khả dụng trên canvasapp' })
    expect(useRuns.getState().enqueue(['s4'])).toMatchObject({ queued: 0, error: 'Không có cảnh nào chạy được.', skipped: [{ sceneId: 's4' }] })
    expect(useRuns.getState().enqueue(['s4', 's3'])).toMatchObject({ queued: 1, skipped: [{ sceneId: 's4' }] })
    await run(600)
    expect(takes().map((t) => t.sceneId)).toEqual(['s2', 's3'])
    expect(fake.count('POST', '/api/uploads/images')).toBe(0) // s4's frames never uploaded
    expect(fake.jobPosts().map((b) => b.model_profile)).toEqual(['seedance_2_5', 'seedance_2_5'])
    expect(fake.count('GET', '/api/video-profiles')).toBe(1) // the run check never sends a request

    // older than the cache life: no longer sure — a warning only; the submit reads again and decides (still locked)
    await run(PROFILES_TTL_MS)
    const [later] = useRuns.getState().check(['s4'])
    expect(later.ok).toBe(true)
    expect(later.warnings.join(' ')).toMatch(/Có thể bị từ chối khi gửi \(không tốn credit\): MiniMax-H3 hiện không khả dụng/)
    const [h3] = enqueue('s4')
    await run(600)
    expect(take(h3.id).status).toBe('failed')
    expect(take(h3.id).error).toMatch(/MiniMax-H3 hiện không khả dụng/)
    expect(fake.count('GET', '/api/video-profiles')).toBe(2)
    expect(fake.jobPosts()).toHaveLength(2)
  })

  it('a take whose POST lost its answer is still found once its model is locked: retry looks the job up, never posts again', async () => {
    let lost = true
    const listDown = { on: false }
    fake.state.fault = (req) => {
      if (req.method === 'POST' && req.path === '/api/video-jobs' && lost) {
        lost = false
        listDown.on = true // (the read right before the POST answered; the network drops as it goes out)
        return { kind: 'lost-response' }
      }
      if (req.method === 'GET' && req.path.startsWith('/api/video-jobs?') && listDown.on) return { kind: 'network' }
      return undefined
    }
    const [t] = enqueue('s4')
    await run(3 * 60_000)
    expect(take(t.id)).toMatchObject({ status: 'failed', submitUnknown: true, remoteId: null })
    const posts = fake.jobPosts().length
    expect(fake.state.jobs).toHaveLength(1) // canvasapp did create (and bill) it

    // canvasapp locks MiniMax-H3 meanwhile, and SanoVids knows it (a firm read)
    listDown.on = false
    fake.state.profiles = fake.state.profiles.map((p) => (p.model_profile === 'minimax_h3' ? { ...p, can_create: false } : p))
    expect(await refreshProviderLimits('canvasapp', { force: true })).toBe('read')
    expect(useRuns.getState().check(['s4'])[0].ok).toBe(false)
    // "Chạy lại" of THIS take is not held back by the lock: the job it made is looked up first
    expect(useRuns.getState().retry(t.id)).toMatchObject({ queued: 1 })
    await run(2 * 60_000)
    expect(fake.jobPosts()).toHaveLength(posts)
    expect(take(t.id).remoteId).toBe(`proj1:${fake.state.jobs[0].job_id}`)
    // a NEW take of that scene is skipped by the run check
    expect(useRuns.getState().enqueue(['s4'])).toMatchObject({ queued: 0, error: 'Không có cảnh nào chạy được.' })
    expect(fake.state.jobs).toHaveLength(1)
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
    const node = fake.state.canvases.get('proj1')!.nodes.find((n) => n.id === nodeOf('s4'))!
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
    expect(fake.state.canvases.get('proj1')!.nodes.map((n) => n.id)).toEqual([nodeOf('s3')])
  })
})

describe('gateway e2e: "Nhập job" — jobs made on canvasapp’s own page become takes (read-only, never re-submitted)', () => {
  /** Let the engine poll (every ≥ 20 s) until take `id` finished. */
  async function finished(id: string) {
    for (let i = 0; i < 8 && take(id).status !== 'completed'; i++) await run(15_000)
    expect(take(id).status).toBe('completed')
  }
  /** Run a scene through SanoVids until it is done (the bridge session + its node exist). */
  async function done(sceneId: string) {
    const [t] = enqueue(sceneId)
    await finished(t.id)
    return t
  }
  const importedTakes = () => takes().filter((t) => t.imported)
  const claims = () => (JSON.parse(storage.get(JOBS_KEY) ?? '{}').imported ?? {}) as Record<string, { remoteId: string }>
  /** Requests other than GET sent since `from` (an index into the log). */
  const writesSince = (from: number) => fake.log.slice(from).filter((c) => c.method !== 'GET')
  const lastToast = () => useUI.getState().toasts.at(-1)

  it('imports a job made on the site: one take of that scene, settings from its node, polled and downloaded — never posted, billed once', async () => {
    const t1 = await done('s1')
    const balance = fake.state.balance
    const site = fake.siteJob(nodeOf('s1'))
    expect(fake.state.balance).toBe(balance - S1_COST) // the site billed it
    const mark = fake.log.length
    const scan = await scanForImport()
    expect(scan).toMatchObject({ pid: 'canvasapp', simulated: false, projectId: 'p' })
    expect(scan.scan.candidates.map((c) => [c.jobId, c.sceneId])).toEqual([[site.job_id, 's1']])
    expect(scan.scan.skipped).toEqual([{ jobId: 'job1', sceneId: 's1', code: 'in-project' }])
    const res = await importSiteJobs(scan, [site.job_id])
    expect(res).toMatchObject({ skipped: [] })
    // only reads: the job list, the saved canvas, the prompt
    expect(writesSince(mark)).toEqual([])
    expect(fake.log.slice(mark).map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual(['GET /api/video-jobs', 'GET /api/projects/proj1', `GET /api/video-jobs/${site.job_id}/prompt`])
    const [imp] = importedTakes()
    expect(imp).toMatchObject({
      sceneId: 's1',
      number: 2,
      status: 'processing',
      provider: 'canvasapp',
      charged: false,
      remoteId: `proj1:${site.job_id}`,
      promptSnapshot: PROMPT,
      rawPromptSnapshot: PROMPT,
      refsSnapshot: ['elara', 'lumi', 'village'],
      imageKeysSnapshot: ['elara:img_e1', 'lumi:img_l1', 'lumi:img_l2', 'village:img_v1'],
      settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
      cost: S1_COST,
      imported: { unknown: [], inferred: ['resolution', 'refs'] },
    })
    // the claim is in the ledger of the adapter that runs the takes (the registered instance)
    expect(Object.keys(claims())).toEqual([imp.id])
    expect(lastToast()).toMatchObject({ text: expect.stringMatching(/^Đã nhập 1 video từ canvasapp\.io\.vn vào S01 — không trừ credit\.$/), action: { label: 'Bỏ nhập' } })

    await finished(imp.id)
    expect(take(imp.id)).toMatchObject({ status: 'completed', remoteId: `proj1:${site.job_id}` })
    expect(await media.get(take(imp.id).videoId!)!.text()).toBe(`MP4:${site.job_id}`)
    expect(events).toContainEqual({ type: 'completed', takeId: imp.id, provider: 'canvasapp' })
    expect(events.filter((e) => e.takeId === imp.id && e.type === 'submitted')).toEqual([]) // SanoVids billed nothing
    expect(fake.jobPosts()).toHaveLength(1)
    expect(fake.state.balance).toBe(balance - S1_COST)
    expect(take(t1.id).status).toBe('completed')
    const line = takeCostLine(take(imp.id))
    expect(line).toMatchObject({ amount: '≈ 20 credit', struck: false })
    expect(line.note).toBe('trả trên canvasapp khi tạo job (ngoài SanoVids) — nhập không trừ thêm')
  })

  it('importing again offers nothing new; two clicks at once import once; the same scan used twice adds nothing', async () => {
    await done('s1')
    const site = fake.siteJob(nodeOf('s1'))
    const scan = await scanForImport()
    const [a, b] = await Promise.all([importSiteJobs(scan, [site.job_id]), importSiteJobs(scan, [site.job_id])])
    expect(a?.takeIds).toHaveLength(1)
    expect(b).toBeNull() // an import is already running
    expect(await importSiteJobs(scan, [site.job_id])).toMatchObject({ takeIds: [], skipped: [{ jobId: site.job_id, code: 'in-project' }] })
    expect(importedTakes()).toHaveLength(1)
    const again = await scanForImport()
    expect(again.scan.candidates).toEqual([])
    expect(again.scan.skipped.map((s) => s.code)).toEqual(['in-project', 'in-project'])
    expect(fake.jobPosts()).toHaveLength(1)
  })

  it('the Bảng phát triển’s import reads the simulated site whatever new takes use: nothing reaches canvasapp', async () => {
    await done('s1')
    fake.siteJob(nodeOf('s1'))
    const before = fake.log.length
    const scan = scanForImport('dev').catch((e: unknown) => e)
    await run(1_000) // the simulated site's latency (fake timers)
    expect(await scan).toMatchObject({ code: 'login-required', message: expect.stringContaining('canvasapp giả lập') })
    expect(fake.log.length).toBe(before)
  })

  it('“Chạy lại” / retry of an imported take make a NEW take (cost dialog, its own key); the imported one is never sent', async () => {
    await done('s1')
    const site = fake.siteJob(nodeOf('s1'))
    await importSiteJobs(await scanForImport(), [site.job_id])
    const [imp] = importedTakes()
    expect(isUncertainSubmit(take(imp.id))).toBe(false)
    rerunTake(imp.id)
    expect(useUI.getState().dialog).toMatchObject({ kind: 'runConfirm', sceneIds: ['s1'] })
    useUI.getState().closeDialog()
    runNow(['s1'])
    const fresh = takes().at(-1)!
    expect(fresh.id).not.toBe(imp.id)
    useRuns.getState().retry(imp.id)
    const third = takes().at(-1)!
    expect([fresh.id, imp.id]).not.toContain(third.id)
    await run(3_000)
    const keys = fake.jobPosts().map((b) => b.client_request_id)
    expect(keys).toEqual([keys[0], clientRequestIdFor(fresh.id), clientRequestIdFor(third.id)])
    expect(keys).not.toContain(clientRequestIdFor(imp.id))
    expect(take(imp.id).remoteId).toBe(`proj1:${site.job_id}`)
  })

  it('a node edited on the site (prompt + resolution): those settings, inferred from the saved canvas', async () => {
    await done('s1')
    const site = fake.siteJob(nodeOf('s1'), { prompt: '@image_2 chạy dưới mưa', resolution: '720p' })
    await importSiteJobs(await scanForImport(), [site.job_id])
    const [imp] = importedTakes()
    expect(imp).toMatchObject({ promptSnapshot: '@image_2 chạy dưới mưa', settings: { resolution: '720p' }, cost: 15, imported: { inferred: ['resolution', 'refs'], unknown: [] } })
    expect(takeSettingsText(imp)).toBe('15s · ≈720P · 16:9')
  })

  it('SanoVids runs the scene again (its PUT reverts the node): an older unedited job still matches; an edited one gets “?” and cost “—”, no restore', async () => {
    await done('s1')
    const plain = fake.siteJob(nodeOf('s1'))
    const edited = fake.siteJob(nodeOf('s1'), { prompt: '@image_2 chạy dưới mưa', resolution: '720p' })
    await done('s1') // the bridge canvas is saved again from SanoVids' scene: the node is PROMPT / 1080p again
    const scan = await scanForImport()
    await importSiteJobs(scan, [plain.job_id, edited.job_id])
    const byJob = (jobId: string) => importedTakes().find((t) => t.remoteId === `proj1:${jobId}`)!
    expect(byJob(plain.job_id)).toMatchObject({ settings: { resolution: '1080p' }, cost: S1_COST, imported: { inferred: ['resolution', 'refs'] } })
    const lost = byJob(edited.job_id)
    expect(lost).toMatchObject({ promptSnapshot: '@image_2 chạy dưới mưa', cost: 0, imported: { unknown: ['resolution', 'refs'], inferred: [] } })
    expect(takeCostLine(lost).amount).toBe('—')
    expect(takeSettingsText(lost)).toBe('15s · ? · 16:9')
    expect(restoreBlock(lost)).toMatch(/không rõ ảnh tham chiếu/)
    const before = useProject.getState().project.scenes.find((s) => s.id === 's1')!
    restoreFromTake(lost.id)
    expect(useProject.getState().project.scenes.find((s) => s.id === 's1')).toEqual(before)
  })

  it('only the resolution edited on the site, then the node reverted by SanoVids: the guess stays a guess (≈), restore keeps the scene’s resolution', async () => {
    await done('s1')
    const site = fake.siteJob(nodeOf('s1'), { resolution: '480p' })
    await done('s2') // its PUT carries s1's node again, from SanoVids' entry: 1080p
    await importSiteJobs(await scanForImport(), [site.job_id])
    const [imp] = importedTakes()
    // canvasapp's list does not tell the resolution: the node's (wrong) 1080p is only ever "inferred"
    expect(imp.imported).toMatchObject({ inferred: ['resolution', 'refs'], unknown: [] })
    expect(takeSettingsText(imp)).toBe('15s · ≈1080P · 16:9')
    expect(takeCostLine(imp).amount).toBe('≈ 20 credit')
    useProject.getState().updateSettings(['s1'], { resolution: '720p' })
    restoreFromTake(imp.id)
    const s1 = useProject.getState().project.scenes.find((s) => s.id === 's1')!
    expect(s1.settings.resolution).toBe('720p') // kept: never restored from a guess
    expect(s1.prompt).toBe(PROMPT)
    expect(lastToast()?.text).toMatch(/giữ độ phân giải của cảnh/)
  })

  it('MiniMax-H3 Text → Video (mode only guessed from the node), scene switched to Ảnh → Video since: restore keeps the scene’s mode, references and @video', async () => {
    useProject.getState().updateSettings(['s2'], { model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '768p', ratio: '16:9' })
    const t2 = await done('s2')
    const site = fake.siteJob(nodeOf('s2'))
    await importSiteJobs(await scanForImport(), [site.job_id])
    const [imp] = importedTakes()
    expect(imp).toMatchObject({ settings: { model: 'minimax_h3', mode: 't2v' }, refsSnapshot: [], imported: { inferred: expect.arrayContaining(['mode', 'refs']) } })
    // the user moves the scene on: Ảnh → Video with a character and a reference video
    useProject.getState().updateSettings(['s2'], { mode: 'i2v' })
    useProject.getState().restoreScene('s2', { prompt: '@image_1 đi dạo', refs: ['elara'], videoRefs: [t2.id], settings: { ...project().scenes[1].settings, model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' } })
    restoreFromTake(imp.id)
    const s2 = useProject.getState().project.scenes.find((s) => s.id === 's2')!
    expect(s2).toMatchObject({ prompt: 'Hai người đi dạo', refs: ['elara'], videoRefs: [t2.id], settings: { mode: 'i2v' } })
    expect(lastToast()?.text).toMatch(/giữ ảnh tham chiếu của cảnh \(job ≈Text → Video không gửi ảnh tham chiếu\)/)
  })

  it('a job an unanswered POST on that node may have made is never offered; that take’s retry never posts twice', async () => {
    await done('s1')
    fake.state.dedupe = false // a second POST would be billed
    let lose = true
    fake.state.fault = (req) => {
      if (req.method === 'POST' && req.path === '/api/video-jobs' && lose) {
        lose = false
        return { kind: 'lost-response' }
      }
    }
    const [a] = enqueue('s1')
    await run(300) // posted: job2 made and billed, its answer lost — the adapter waits before looking
    expect(fake.state.jobs).toHaveLength(2)
    const site = fake.siteJob(nodeOf('s1'))
    const scan = await scanForImport()
    expect(scan.scan.candidates).toEqual([])
    expect(scan.scan.skipped).toContainEqual({ jobId: site.job_id, sceneId: 's1', code: 'maybe-pending', pendingTakeId: a.id, windowHours: 14 })
    await run(40_000) // its lookups see two jobs it could own → "không rõ", nothing guessed
    expect(take(a.id)).toMatchObject({ status: 'failed', submitUnknown: true })
    expect((await scanForImport()).scan.candidates).toEqual([])
    useRuns.getState().retry(a.id)
    await run(3_000)
    expect(fake.jobPosts()).toHaveLength(2)
    expect(importedTakes()).toEqual([])
    expect(claims()).toEqual({})
  })

  it('after an app restart the imported take is polled again and finishes — never posted', async () => {
    await done('s1')
    const site = fake.siteJob(nodeOf('s1'))
    await importSiteJobs(await scanForImport(), [site.job_id])
    const [imp] = importedTakes()
    restart(saved())
    await finished(imp.id)
    expect(take(imp.id)).toMatchObject({ status: 'completed', imported: { inferred: ['resolution', 'refs'] } })
    expect(fake.jobPosts()).toHaveLength(1)
  })

  it('nothing is imported or claimed: scene deleted meanwhile, a 401 while reading the prompts, another project opened meanwhile', async () => {
    await done('s1')
    const site = fake.siteJob(nodeOf('s1'))
    // scene deleted between the scan and the import
    const scan = await scanForImport()
    useProject.getState().removeScenes(['s1'])
    expect(await importSiteJobs(scan, [site.job_id])).toMatchObject({ takeIds: [], skipped: [{ jobId: site.job_id, code: 'scene-gone' }] })
    undo()
    // 401 while reading the prompts
    fake.state.fault = (req) => (req.path.endsWith('/prompt') ? { kind: 'response', status: 401, json: { detail: 'Not authenticated' } } : undefined)
    await expect(importSiteJobs(await scanForImport(), [site.job_id])).rejects.toMatchObject({ code: 'login-required' })
    // another project (a copy with the same scene ids) opened while the prompt is read
    const gateOpen = gate()
    fake.state.fault = (req) => (req.path.endsWith('/prompt') ? { kind: 'wait', until: gateOpen.until } : undefined)
    const pending = importSiteJobs(await scanForImport(), [site.job_id])
    await run(10)
    useProject.getState().loadProject({ ...project(), id: 'p2', name: 'Bản sao' })
    useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
    gateOpen.open()
    expect(await pending).toMatchObject({ takeIds: [], skipped: [{ jobId: site.job_id, code: 'project-changed' }] })
    expect(lastToast()?.text).toBe('Đã mở dự án khác — chưa nhập gì.')
    expect(takes()).toEqual([])
    expect(claims()).toEqual({})
    expect(fake.jobPosts()).toHaveLength(1)
  })

  it('“Bỏ nhập” deletes the takes just imported (asks nothing); the job stays on the site and is offered again, unticked', async () => {
    await done('s1')
    const site = fake.siteJob(nodeOf('s1'))
    await importSiteJobs(await scanForImport(), [site.job_id])
    const said = lastToast()!
    const [imp] = importedTakes()
    await finished(imp.id) // (the toast timed out meanwhile: its button is still what "Bỏ nhập" runs)
    said.action!.run() // "Bỏ nhập" (no window.confirm here: it would throw)
    expect(importedTakes()).toEqual([])
    expect(lastToast()?.text).toMatch(/^Đã bỏ 1 take vừa nhập — job vẫn còn trên canvasapp\.io\.vn/)
    const again = await scanForImport()
    expect(again.scan.candidates.map((c) => [c.jobId, c.reimport])).toEqual([[site.job_id, true]])
    expect(defaultPicks(again.scan.candidates)).toEqual([])
    expect((await importSiteJobs(again, [site.job_id]))?.takeIds).toHaveLength(1)
    expect(fake.jobPosts()).toHaveLength(1)
  })

  it('imported takes never hold a submit slot: 10 of them running, a new SanoVids take still starts', async () => {
    await done('s2')
    fake.state.script = [{ status: 'queued', progress: 0 }, ...Array.from({ length: 40 }, () => ({ status: 'processing', progress: 50 }))]
    const sites = Array.from({ length: MAX_REMOTE_CONCURRENCY }, () => fake.siteJob(nodeOf('s2')))
    const scan = await scanForImport()
    expect((await importSiteJobs(scan, sites.map((j) => j.job_id)))?.takeIds).toHaveLength(MAX_REMOTE_CONCURRENCY)
    expect(takes().filter((t) => t.status === 'processing')).toHaveLength(MAX_REMOTE_CONCURRENCY)
    const [t] = enqueue('s3')
    await run(600)
    expect(take(t.id).status).toBe('processing')
    expect(take(t.id).remoteId).toMatch(/^proj1:job/)
    expect(fake.jobPosts()).toHaveLength(2)
  })
})
