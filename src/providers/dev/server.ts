// Development mode: a simulated canvasapp.io.vn that lives inside SanoVids (no network at all). The REAL gateway code
// (providers/canvasapp: api.ts, adapter.ts, mapping.ts, transport.ts) talks to it through the dev bridge (bridge.ts),
// so every path of the real mode — login, credits, uploads, bridge canvas, jobs, polling, download, idempotency after
// a lost answer, top-up through SePay, credit history — runs and can be broken on purpose to find bugs.
//
// It is as strict as canvasapp (validate.ts, shared with the e2e test's fake): a canvas that is not canvasPayload()'s
// shape → 400 "Invalid canvas payload (<why>)"; a job body that is not runVideoNode()'s → 400/422; non-UUID ids, 30+
// images, too-long prompts, models / modes the profile disables → refused. Credits use the real price table
// (core/models costOf), charged when a job is accepted and refunded when it fails.
//
// Time is wall clock (deps.now): jobs go queued → processing (progress %) → completed in ≈ 8 s ('fast') or 60–90 s
// ('realistic'); top-up orders expire after 10 minutes. The finished video is rendered in the page (deps.render: the
// demo renderer of lib/mockProvider, wired in providers/dev/index.ts) from the job's uploaded pictures IN upload_ids
// ORDER, each labelled @image_N — so character sync can be checked by eye — and cached.
//
// Persistence (deps.storage, deps.blobs): account, balance, projects + canvases, jobs, upload metadata, history, top-up
// orders and the settings survive a reload like a real server; blobs (uploads, rendered videos) live in IndexedDB.
// reset() wipes the account. Defaults on the first run: logged OUT, balance 1000, top-up on, speed 'fast'.
// ONE account for every tab: each tab of SanoVids runs its own copy of this server on the same storage, so every
// request / change first re-reads what another tab saved (load → change → save; sync() on the 'storage' event) —
// like the one shared canvasapp. A state too big for localStorage drops its oldest finished jobs; a save that still
// fails is reported (snapshot().persistProblem). Trimmed jobs / uploads take their blobs with them.
//
// Faults (for the dev UI): per-endpoint rules, one-shot or sticky — 'network' (never reaches the server),
// 'lost-response' (handled, answer lost), 'processed-then' {status, json} (handled, then e.g. a 502 or a 200 without
// job_id), 'response' {status, json} (answered without handling: 402, 422, 400 Invalid canvas payload, 429…),
// 'slow' {ms}; and job-level ones: the next job fails / expires, the next N downloads fail, the session expires.
//
// ---- API ----
//   createDevCanvasapp(deps?): DevCanvasapp      see the interface below (request() is what the bridge calls).
//   DEV_CONFIG_DEFAULT, DEV_SPEED_LABEL, DEV_FAULT_PRESETS, imageIdFromUploadFilename(filename)
import { costOf, MODELS } from '../../core/models'
import { creditsForAmount, formatVnd, isTopupHistoryKind, TOPUP_MAX_VND, TOPUP_MIN_VND, TOPUP_ORDER_TTL_MS, TOPUP_STEP_VND } from '../../core/topup'
import type { Mode, ModelId } from '../../core/types'
import { memoryStorage, type KeyValueStorage } from '../canvasapp/adapter'
import type { TransportRequest, VideoProfile } from '../canvasapp/api'
import type { BridgeResponse } from '../canvasapp/transport'
import { ALLOWED_IMAGE_TYPES, uuidFromKey } from '../canvasapp/mapping'
import { pushDevLog, summarizeForLog } from './log'
import type { DevTopupOutcome } from './prompts'
import { matchDevRoute, MAX_UPLOAD_BYTES, type DevEndpoint } from './routes'
import { canvasProblem, canvasUploadIds, isFramesJob, isObj, jobBodyProblem, jobKeyProblem, profileProblem, sameKeys } from './validate'

// ---------------------------------------------------------------------------------------------
// Settings, faults
// ---------------------------------------------------------------------------------------------

export type DevSpeed = 'fast' | 'realistic'

export const DEV_SPEED_LABEL: Record<DevSpeed, string> = { fast: 'Nhanh (~8 giây)', realistic: 'Thực tế (60–90 giây)' }

/** Queue wait and total time of a job (ms, random within the range). */
export const DEV_SPEED_MS: Record<DevSpeed, { queued: [number, number]; total: [number, number] }> = {
  fast: { queued: [1_000, 2_000], total: [7_000, 9_000] },
  realistic: { queued: [5_000, 12_000], total: [60_000, 90_000] },
}

export interface DevModelToggle {
  /** /api/video-profiles can_create (false = canvasapp's page and SanoVids refuse the model). */
  can_create: boolean
  /** Modes switched off (/api/video-profiles disabled_modes). */
  disabled_modes: Mode[]
  /**
   * Values left out of the profile's lists (durations / resolutions / aspect_ratios), like canvasapp narrowing what a
   * model offers. canvasapp's page (and SanoVids) uses Seedance's lists as sent, but replaces MiniMax-H3's lists that are
   * narrower than its built-in ones — so for H3 these change nothing (mapping.profileSpecOf). Only values of the model
   * are kept; missing = none.
   */
  off_durations?: number[]
  off_resolutions?: string[]
  off_ratios?: string[]
}

export interface DevConfig {
  speed: DevSpeed
  /** /api/auth/state topup_enabled. */
  topupEnabled: boolean
  /** Same client_request_id → the same job and no second charge (a careful server). Off: every POST creates and bills. */
  dedupe: boolean
  /** Job list items carry client_request_id (unknown on the live site: off by default). */
  exposeKey: boolean
  /** HTTP status of "not enough credits". */
  insufficientStatus: 400 | 402
  /** Latency added to every request (ms). */
  latencyMs: number
  /** Probability (0..1) that a job fails by itself. */
  failRate: number
  models: Record<ModelId, DevModelToggle>
}

export const DEV_CONFIG_DEFAULT: DevConfig = {
  speed: 'fast',
  topupEnabled: true,
  dedupe: true,
  exposeKey: false,
  insufficientStatus: 402,
  latencyMs: 150,
  failRate: 0,
  models: {
    seedance_2_5: { can_create: true, disabled_modes: [], off_durations: [], off_resolutions: [], off_ratios: [] },
    minimax_h3: { can_create: true, disabled_modes: [], off_durations: [], off_resolutions: [], off_ratios: [] },
  },
}

export type DevFault =
  /** Nothing reaches the server (offline / connection refused): the app gets a network error, nothing changes. */
  | { kind: 'network' }
  /** The server handles the request (state changes!), but the answer is lost (timeout / connection reset). */
  | { kind: 'lost-response' }
  /** The server handles the request, then answers with this instead (e.g. Cloudflare 502, a 200 without job_id). */
  | { kind: 'processed-then'; status: number; json?: unknown }
  /** Answered with this without being handled (e.g. 402 not enough credits, 422 validation, 429, 400). */
  | { kind: 'response'; status: number; json?: unknown }
  /** Extra latency before the request is handled. */
  | { kind: 'slow'; ms: number }

export interface DevFaultRule {
  id: string
  /** Endpoint it applies to (routes.ts); '*' = every endpoint. */
  endpoint: DevEndpoint | '*'
  fault: DevFault
  /** true: stays until removed. false: one-shot — removed once it fired `remaining` more times. */
  sticky: boolean
  /** One-shot rules: requests it still applies to (0 for sticky rules). */
  remaining: number
  /** Times it fired so far. */
  hits: number
  label: string | null
}

export interface DevFaultInput {
  endpoint: DevEndpoint | '*'
  fault: DevFault
  sticky?: boolean
  /** One-shot rules: how many requests it applies to (default 1). */
  times?: number
  label?: string
}

export interface DevJobFaults {
  /** The next job created fails with this error_message (then cleared). null = none. */
  failNext: string | null
  /** The next job created ends 'expired' instead of 'completed' (then cleared). */
  expireNext: boolean
  /** The next N video downloads (stream) fail with 503. */
  streamFailures: number
}

const NO_JOB_FAULTS: DevJobFaults = { failNext: null, expireNext: false, streamFailures: 0 }

/** Ready-made faults for the dev UI (label / hint in Vietnamese). */
export const DEV_FAULT_PRESETS: { id: string; label: string; hint: string; rule: DevFaultInput }[] = [
  {
    id: 'job-network',
    label: 'Mất mạng khi tạo job (1 lần)',
    hint: 'Yêu cầu tạo job không tới được máy chủ — SanoVids phải gửi lại đúng mã client_request_id.',
    rule: { endpoint: 'job-create', fault: { kind: 'network' } },
  },
  {
    id: 'job-lost',
    label: 'Mất câu trả lời khi tạo job (1 lần)',
    hint: 'Máy chủ ĐÃ tạo job và trừ credit nhưng câu trả lời bị mất — SanoVids phải tìm lại job, không trả hai lần.',
    rule: { endpoint: 'job-create', fault: { kind: 'lost-response' } },
  },
  {
    id: 'job-502',
    label: '502 sau khi đã tạo job (1 lần)',
    hint: 'Cloudflare trả 502 dù job đã được tạo.',
    rule: { endpoint: 'job-create', fault: { kind: 'processed-then', status: 502, json: { detail: 'Bad gateway' } } },
  },
  {
    id: 'job-no-id',
    label: '200 nhưng không có job_id (1 lần)',
    hint: 'Job được tạo nhưng câu trả lời không có job_id.',
    rule: { endpoint: 'job-create', fault: { kind: 'processed-then', status: 200, json: { ok: true } } },
  },
  {
    id: 'job-402',
    label: 'Không đủ credit (402, 1 lần)',
    hint: 'Từ chối tạo job vì số dư — không trừ gì.',
    rule: { endpoint: 'job-create', fault: { kind: 'response', status: 402, json: { detail: 'Số dư không đủ để tạo video (giả lập).' } } },
  },
  {
    id: 'job-422',
    label: 'Lỗi kiểm tra dữ liệu 422 (1 lần)',
    hint: 'FastAPI trả danh sách lỗi (detail là mảng).',
    rule: {
      endpoint: 'job-create',
      fault: { kind: 'response', status: 422, json: { detail: [{ type: 'missing', loc: ['body', 'prompt'], msg: 'Field required', input: null }] } },
    },
  },
  {
    id: 'canvas-400',
    label: 'Canvas bị từ chối (400, 2 lần)',
    // Two refusals: when older scenes are on the bridge canvas SanoVids retries once with only this scene (adapter),
    // and a one-shot fault would be absorbed by that retry — the job would be sent and billed after all.
    hint:
      '"Invalid canvas payload" khi lưu canvas cầu nối — 2 lần liền, vì SanoVids tự thử lại một lần chỉ với cảnh này: take báo lỗi, không gửi job, không trừ credit. (Canvas cầu nối còn trống thì chỉ lưu 1 lần — lần còn lại vẫn bật, tắt ở “Đang bật”.)',
    rule: { endpoint: 'canvas-put', fault: { kind: 'response', status: 400, json: { detail: 'Invalid canvas payload' } }, times: 2 },
  },
  {
    id: 'rate-429',
    label: 'Quá tần suất 429 (1 lần, mọi yêu cầu)',
    hint: 'Yêu cầu kế tiếp bị giới hạn tần suất.',
    rule: { endpoint: '*', fault: { kind: 'response', status: 429, json: { detail: 'Too many requests' } } },
  },
  {
    id: 'profiles-500',
    label: 'Cấu hình model lỗi 500 (giữ)',
    hint: 'Không đọc được /api/video-profiles — SanoVids dùng cấu hình dự phòng như trang canvasapp (MiniMax-H3 khoá): inspector và hộp Chạy chỉ cảnh báo “có thể bị từ chối”, take MiniMax-H3 bị từ chối khi gửi (không tốn credit).',
    rule: { endpoint: 'video-profiles', fault: { kind: 'response', status: 500, json: { detail: 'boom' } }, sticky: true },
  },
  {
    id: 'list-network',
    label: 'Mất mạng khi đọc danh sách job (giữ)',
    hint: 'Tiến độ không cập nhật được; take vẫn chạy, SanoVids lùi thời gian thử lại.',
    rule: { endpoint: 'jobs-list', fault: { kind: 'network' }, sticky: true },
  },
  {
    id: 'stream-network',
    label: 'Mất mạng khi tải video (3 lần)',
    hint: 'Video đã xong (đã trừ credit) nhưng tải về lỗi — SanoVids phải thử lại, không coi là take lỗi ngay.',
    rule: { endpoint: 'job-stream', fault: { kind: 'network' }, times: 3 },
  },
  {
    id: 'slow-all',
    label: 'Mạng chậm 3 giây (giữ, mọi yêu cầu)',
    hint: 'Mỗi yêu cầu chờ thêm 3 giây.',
    rule: { endpoint: '*', fault: { kind: 'slow', ms: 3_000 }, sticky: true },
  },
  {
    id: 'offline',
    label: 'Mất mạng hoàn toàn (giữ)',
    hint: 'Không yêu cầu nào tới được máy chủ.',
    rule: { endpoint: '*', fault: { kind: 'network' }, sticky: true },
  },
]

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired'
type TopupStatus = 'pending' | 'paid' | 'reconciled' | 'reconcile_required' | 'expired' | 'rejected'
type HistoryType = 'topup' | 'video' | 'refund' | 'adjustment'

interface DevUpload {
  upload_id: string
  filename: string
  content_type: string
  size: number
  created_at: number
}

interface DevProject {
  project_id: string
  name: string
  created_at: number
  canvas: unknown | null
  canvas_saved_at: number | null
}

interface JobPlan {
  queuedMs: number
  totalMs: number
  /** Fraction of the processing time at which it fails (with failMessage). */
  failAt: number
  failMessage: string | null
  expire: boolean
}

interface DevJob {
  job_id: string
  number: number
  project_id: string
  canvas_node_id: string
  client_request_id: string
  model_profile: ModelId
  mode: Mode
  duration: number
  resolution: string
  aspect_ratio: string | null
  prompt: string
  generate_audio: boolean
  upload_ids: string[]
  first_frame_upload_id: string | null
  last_frame_upload_id: string | null
  cost: number
  created_at: number
  plan: JobPlan
  status: JobStatus
  progress: number
  finished_at: number | null
  error_message: string | null
  download_available: boolean
  refunded: boolean
}

interface DevHistoryItem {
  type: HistoryType
  description: string
  status: string | null
  delta: number | null
  amount_vnd: number | null
  created_at: number
  /** Job / order id it belongs to. */
  ref: string | null
}

interface DevTopup {
  order_id: string
  amount_vnd: number
  credits: number
  status: TopupStatus
  created_at: number
  expires_at: number
  /** What canvasapp says after the payment page, and from when (simulatePayment). */
  settle: { outcome: 'paid' | 'reconcile_required' | 'rejected' | 'expired'; at: number } | null
  settled_at: number | null
}

interface DevState {
  v: 1
  /** Random per account: ids stay unique across resets. */
  salt: string
  seq: number
  authenticated: boolean
  /** The session was ended from the dev panel (expireSession): an armed fault until the next login. */
  sessionExpired: boolean
  balance: number
  projects: DevProject[]
  uploads: DevUpload[]
  jobs: DevJob[]
  history: DevHistoryItem[]
  topups: DevTopup[]
}

export const DEV_STATE_KEY = 'bdp:dev:state'
export const DEV_CONFIG_KEY = 'bdp:dev:config'
export const DEV_INITIAL_BALANCE = 1000
export const DEV_EMAIL = 'dev@sanovids.local'
/** Fake SePay host: under sepay.vn (so the real checkoutUrlAllowed rules run) but a name that does not exist. */
export const DEV_CHECKOUT_ORIGIN = 'https://sanovids-dev-sim.sepay.vn'
const CANVASAPP_RETURN = 'https://canvasapp.io.vn/'

const MAX_JOBS = 200
const MAX_HISTORY = 1000
const MAX_TOPUPS = 200
const MAX_UPLOADS = 3000
/**
 * Largest saved state (characters). localStorage holds ~5M per site and SanoVids' emergency project backup needs its
 * share: past this the oldest finished jobs (long prompts) are let go.
 */
export const DEV_STATE_MAX_CHARS = 1_500_000

const RANDOM_FAILURES = ['Nội dung vi phạm chính sách (giả lập).', 'Nhà cung cấp quá tải, thử lại sau (giả lập).', 'Ảnh tham chiếu không hợp lệ (giả lập).']

// ---------------------------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------------------------

/** Blob storage of the dev server (IndexedDB in the app, a Map in tests). Keys 'dev:upload:<id>' / 'dev:video:<jobId>'. */
export interface DevBlobStore {
  get(key: string): Promise<Blob | null>
  set(key: string, blob: Blob): Promise<void>
  del(key: string): Promise<void>
  clear(): Promise<void>
}

export function memoryBlobStore(): DevBlobStore {
  const m = new Map<string, Blob>()
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, b) => void m.set(k, b),
    del: async (k) => void m.delete(k),
    clear: async () => m.clear(),
  }
}

export interface DevRenderInput {
  jobId: string
  jobNumber: number
  /** "Seedance 2.5 · t2v · 15s · 1080p" */
  title: string
  prompt: string
  ratio: string
  durationLabel: string
  color: string
  /** The job's pictures in the order canvasapp received them: @image_1… (or khung đầu / khung cuối). */
  images: { uploadId: string; blob: Blob | null; label: string }[]
}

/** Makes the finished video (null = cannot record a video here). */
export type DevRenderer = (input: DevRenderInput) => Promise<Blob | null>

export interface DevCanvasappDeps {
  /** JSON state + settings (localStorage in the app). Default: in memory. */
  storage?: KeyValueStorage
  /** Uploaded pictures + rendered videos (IndexedDB in the app). Default: in memory. */
  blobs?: DevBlobStore
  render?: DevRenderer
  now?: () => number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Write requests to the request log (default true). */
  log?: boolean
}

export interface DevJobView {
  job_id: string
  /** 1, 2, 3… in creation order (also on the rendered video). */
  number: number
  project_id: string
  canvas_node_id: string
  client_request_id: string
  model_profile: ModelId
  mode: Mode
  duration: number
  resolution: string
  aspect_ratio: string | null
  prompt: string
  upload_ids: string[]
  first_frame_upload_id: string | null
  last_frame_upload_id: string | null
  cost: number
  status: JobStatus
  progress: number
  created_at: number
  finished_at: number | null
  error_message: string | null
  download_available: boolean
  refunded: boolean
  /** Planned to fail / expire (fault or random failure) — shown in the dev UI. */
  planned: 'fail' | 'expire' | null
}

export interface DevUploadView {
  upload_id: string
  filename: string
  content_type: string
  size: number
  created_at: number
  /** SanoVids media-store image id the upload came from (uploadFilename()), null when unknown. */
  imageId: string | null
}

export interface DevTopupView {
  order_id: string
  amount_vnd: number
  credits: number
  status: TopupStatus
  created_at: number
  expires_at: number
  /** Pending outcome scheduled by the payment page (simulatePayment), with when it lands. */
  settle: DevTopup['settle']
}

export interface DevServerSnapshot {
  authenticated: boolean
  /** Logged out by "Hết phiên (401)" (an armed fault) rather than by the user. */
  sessionExpired: boolean
  balance: number
  config: DevConfig
  faults: DevFaultRule[]
  jobFaults: DevJobFaults
  projects: { project_id: string; name: string; nodes: number; savedAt: number | null }[]
  /** Newest first. */
  jobs: DevJobView[]
  /** Newest first. */
  uploads: DevUploadView[]
  /** Newest first. */
  topups: DevTopupView[]
  historyCount: number
  /** The account could not be saved (storage full / blocked): it lives in this tab only until it can. */
  persistProblem: string | null
}

export interface DevCanvasapp {
  /** One request as it reaches canvasapp (after the gateway): faults, latency, handling, request log. */
  request(req: TransportRequest): Promise<BridgeResponse>
  // ---- account ----
  isAuthenticated(): boolean
  login(): void
  logout(): void
  /** The session ends on the server side: every request answers 401 until login() again. */
  expireSession(): void
  balance(): number
  /** Set the balance (adds an "adjustment" history line). */
  setBalance(credits: number): void
  // ---- settings ----
  config(): DevConfig
  setConfig(patch: Partial<DevConfig>): void
  // ---- faults ----
  faults(): DevFaultRule[]
  addFault(input: DevFaultInput): DevFaultRule
  removeFault(id: string): void
  clearFaults(): void
  jobFaults(): DevJobFaults
  setJobFaults(patch: Partial<DevJobFaults>): void
  // ---- jobs / top-up (dev UI shortcuts) ----
  /** Finish / fail / expire a job now (fail refunds, like a failure on canvasapp). False = unknown or already ended. */
  forceJob(jobId: string, action: 'complete' | 'fail' | 'expire', message?: string): boolean
  /** What canvasapp says about a pending order `delayMs` from now (the checkout page calls it). False = not pending. */
  simulatePayment(orderId: string, outcome: DevTopupOutcome, delayMs?: number): boolean
  /** An uploaded picture (dev UI previews). */
  uploadBlob(uploadId: string): Promise<Blob | null>
  // ---- inspection / lifecycle ----
  /** Current state for the dev UI (job statuses brought up to now). */
  snapshot(): DevServerSnapshot
  /** Called after every change (state, settings, faults). Returns unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Wipe the account (projects, jobs, uploads, history, orders, blobs, faults); back to the first-run defaults. */
  reset(opts?: { keepConfig?: boolean }): Promise<void>
  /** Re-read the account another tab saved (call on the window 'storage' event). True (and listeners told) if it changed. */
  sync(): boolean
}

/** SanoVids media-store image id from the upload's filename (adapter uploadFilename(): "<imageId>.<ext>"). */
export function imageIdFromUploadFilename(filename: string): string | null {
  const m = /^([A-Za-z0-9_-]{1,60})\.(png|jpg|jpeg|webp)$/i.exec(filename)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------------------------

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const json = (body: unknown, status = 200): BridgeResponse => ({ ok: true, status, contentType: 'application/json', json: body })
const detail = (status: number, text: unknown): BridgeResponse => json({ detail: text }, status)

function mergeConfig(raw: unknown): DevConfig {
  const c = isObj(raw) ? raw : {}
  const d = DEV_CONFIG_DEFAULT
  const models = { ...d.models }
  if (isObj(c.models)) {
    for (const id of Object.keys(d.models) as ModelId[]) {
      const m = c.models[id]
      if (!isObj(m)) continue
      const spec = MODELS[id]
      /** The items of `v` that the model has (anything else is dropped), each once. */
      const only = <T,>(v: unknown, values: readonly T[]): T[] => (Array.isArray(v) ? values.filter((x) => v.includes(x)) : [])
      models[id] = {
        can_create: typeof m.can_create === 'boolean' ? m.can_create : d.models[id].can_create,
        disabled_modes: Array.isArray(m.disabled_modes) ? (m.disabled_modes.filter((x) => typeof x === 'string') as Mode[]) : [],
        off_durations: only(m.off_durations, spec.durations),
        off_resolutions: only(m.off_resolutions, spec.resolutions),
        off_ratios: only(m.off_ratios, spec.ratios),
      }
    }
  }
  const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback)
  return {
    speed: c.speed === 'realistic' ? 'realistic' : 'fast',
    topupEnabled: typeof c.topupEnabled === 'boolean' ? c.topupEnabled : d.topupEnabled,
    dedupe: typeof c.dedupe === 'boolean' ? c.dedupe : d.dedupe,
    exposeKey: typeof c.exposeKey === 'boolean' ? c.exposeKey : d.exposeKey,
    insufficientStatus: c.insufficientStatus === 400 ? 400 : 402,
    latencyMs: num(c.latencyMs, d.latencyMs, 0, 60_000),
    failRate: num(c.failRate, d.failRate, 0, 1),
    models,
  }
}

/** /api/video-profiles of the simulated site for these model toggles (every model of SanoVids' table). */
export function devVideoProfiles(models: DevConfig['models']): VideoProfile[] {
  return (Object.values(MODELS) as (typeof MODELS)[ModelId][]).map((m) => {
    const t = models[m.id] ?? DEV_CONFIG_DEFAULT.models[m.id]
    return {
      model_profile: m.id,
      display_name: m.name,
      visible: true,
      enabled: t.can_create,
      can_create: t.can_create,
      options: {
        modes: [...m.modes],
        disabled_modes: [...t.disabled_modes],
        durations: m.durations.filter((x) => !(t.off_durations ?? []).includes(x)),
        resolutions: m.resolutions.filter((x) => !(t.off_resolutions ?? []).includes(x)),
        aspect_ratios: m.ratios.filter((x) => !(t.off_ratios ?? []).includes(x)),
        pricing: m.pricing,
      },
    }
  })
}

function faultLabel(f: DevFault): string {
  switch (f.kind) {
    case 'network':
    case 'lost-response':
      return f.kind
    case 'processed-then':
    case 'response':
      return `${f.kind} ${f.status}`
    case 'slow':
      return `slow ${f.ms}ms`
  }
}

// ---- persisted records, item by item (a bad record is dropped — never fatal for the snapshot / the panel) ----

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null)
const JOB_STATUSES: readonly JobStatus[] = ['queued', 'processing', 'completed', 'failed', 'cancelled', 'expired']
const TOPUP_STATUSES: readonly TopupStatus[] = ['pending', 'paid', 'reconciled', 'reconcile_required', 'expired', 'rejected']
const SETTLE_OUTCOMES = ['paid', 'reconcile_required', 'rejected', 'expired'] as const

function listOf<T>(v: unknown, read: (x: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(v)) return []
  const out: T[] = []
  for (const x of v) {
    const item = isObj(x) ? read(x) : null
    if (item) out.push(item)
  }
  return out
}

function readProject(x: Record<string, unknown>): DevProject | null {
  if (!isStr(x.project_id)) return null
  return {
    project_id: x.project_id,
    name: isStr(x.name) ? x.name : 'Phiên mới',
    created_at: isNum(x.created_at) ? x.created_at : 0,
    canvas: x.canvas ?? null,
    canvas_saved_at: numOrNull(x.canvas_saved_at),
  }
}

function readUpload(x: Record<string, unknown>): DevUpload | null {
  if (!isStr(x.upload_id) || !isStr(x.filename)) return null
  return {
    upload_id: x.upload_id,
    filename: x.filename,
    content_type: isStr(x.content_type) ? x.content_type : 'image/png',
    size: isNum(x.size) ? x.size : 0,
    created_at: isNum(x.created_at) ? x.created_at : 0,
  }
}

function readJob(x: Record<string, unknown>): DevJob | null {
  const p = x.plan
  if (
    !isStr(x.job_id) ||
    !isNum(x.number) ||
    !isStr(x.project_id) ||
    !isStr(x.client_request_id) ||
    !isStr(x.model_profile) ||
    !(x.model_profile in MODELS) ||
    !isStr(x.mode) ||
    !isNum(x.duration) ||
    !isStr(x.resolution) ||
    !isNum(x.cost) ||
    !isNum(x.created_at) ||
    !JOB_STATUSES.includes(x.status as JobStatus) ||
    !isObj(p) ||
    !isNum(p.queuedMs) ||
    !isNum(p.totalMs)
  ) {
    return null
  }
  return {
    job_id: x.job_id,
    number: x.number,
    project_id: x.project_id,
    canvas_node_id: isStr(x.canvas_node_id) ? x.canvas_node_id : '',
    client_request_id: x.client_request_id,
    model_profile: x.model_profile as ModelId,
    mode: x.mode as Mode,
    duration: x.duration,
    resolution: x.resolution,
    aspect_ratio: strOrNull(x.aspect_ratio),
    prompt: isStr(x.prompt) ? x.prompt : '',
    generate_audio: x.generate_audio === true,
    upload_ids: Array.isArray(x.upload_ids) ? x.upload_ids.filter(isStr) : [],
    first_frame_upload_id: strOrNull(x.first_frame_upload_id),
    last_frame_upload_id: strOrNull(x.last_frame_upload_id),
    cost: x.cost,
    created_at: x.created_at,
    plan: {
      queuedMs: p.queuedMs,
      totalMs: p.totalMs,
      failAt: isNum(p.failAt) ? p.failAt : 0.5,
      failMessage: strOrNull(p.failMessage),
      expire: p.expire === true,
    },
    status: x.status as JobStatus,
    progress: isNum(x.progress) ? x.progress : 0,
    finished_at: numOrNull(x.finished_at),
    error_message: strOrNull(x.error_message),
    download_available: x.download_available === true,
    refunded: x.refunded === true,
  }
}

function readHistory(x: Record<string, unknown>): DevHistoryItem | null {
  if (!isStr(x.type) || !isStr(x.description) || !isNum(x.created_at)) return null
  return {
    type: x.type as HistoryType,
    description: x.description,
    status: strOrNull(x.status),
    delta: numOrNull(x.delta),
    amount_vnd: numOrNull(x.amount_vnd),
    created_at: x.created_at,
    ref: strOrNull(x.ref),
  }
}

function readTopup(x: Record<string, unknown>): DevTopup | null {
  if (!isStr(x.order_id) || !isNum(x.amount_vnd) || !isNum(x.credits) || !TOPUP_STATUSES.includes(x.status as TopupStatus) || !isNum(x.created_at) || !isNum(x.expires_at)) {
    return null
  }
  const st = x.settle
  const settle =
    isObj(st) && SETTLE_OUTCOMES.includes(st.outcome as (typeof SETTLE_OUTCOMES)[number]) && isNum(st.at)
      ? { outcome: st.outcome as (typeof SETTLE_OUTCOMES)[number], at: st.at }
      : null
  return {
    order_id: x.order_id,
    amount_vnd: x.amount_vnd,
    credits: x.credits,
    status: x.status as TopupStatus,
    created_at: x.created_at,
    expires_at: x.expires_at,
    settle,
    settled_at: numOrNull(x.settled_at),
  }
}

/** A saved account (JSON text) → the state, or null when it is not one (unreadable, another version…). */
function parseState(raw: string | null): DevState | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as unknown
    if (!isObj(p) || p.v !== 1 || !isStr(p.salt) || !isNum(p.balance)) return null
    const authenticated = p.authenticated === true
    return {
      v: 1,
      salt: p.salt,
      seq: isNum(p.seq) ? p.seq : 0,
      authenticated,
      sessionExpired: !authenticated && p.sessionExpired === true,
      balance: p.balance,
      projects: listOf(p.projects, readProject),
      uploads: listOf(p.uploads, readUpload),
      jobs: listOf(p.jobs, readJob),
      history: listOf(p.history, readHistory),
      topups: listOf(p.topups, readTopup),
    }
  } catch {
    return null
  }
}

const keepLast = <T>(list: T[], max: number) => (list.length > max ? list.slice(list.length - max) : list)
const isRunning = (j: Pick<DevJob, 'status'>) => j.status === 'queued' || j.status === 'processing'

export function createDevCanvasapp(deps: DevCanvasappDeps = {}): DevCanvasapp {
  const storage = deps.storage ?? memoryStorage()
  const blobs = deps.blobs ?? memoryBlobStore()
  const render: DevRenderer = deps.render ?? (async () => null)
  const now = deps.now ?? (() => Date.now())
  const random = deps.random ?? Math.random
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const logging = deps.log !== false

  /** The saved text `state` / `config` were last read from or written as: another tab's save shows as a difference. */
  let stateRaw: string | null = null
  let configRaw: string | null = null
  /** Why the last save failed (null = saved). */
  let persistProblem: string | null = null
  let config = loadConfig()
  let state = loadState()
  let faultRules: DevFaultRule[] = []
  let jobFaults: DevJobFaults = { ...NO_JOB_FAULTS }
  let faultSeq = 0
  const listeners = new Set<() => void>()
  const rendering = new Map<string, Promise<Blob | null>>()
  /** Bumped by reset(): requests in flight across a reset do not write into the new account. */
  let epoch = 0

  function fresh(): DevState {
    const t = now()
    const salt = Math.floor(random() * 0xffffffff).toString(16) + t.toString(16)
    return {
      v: 1,
      salt,
      seq: 0,
      authenticated: false,
      sessionExpired: false,
      balance: DEV_INITIAL_BALANCE,
      projects: [],
      uploads: [],
      jobs: [],
      history: [
        {
          type: 'adjustment',
          description: 'Số dư khởi tạo của chế độ Phát triển (credit giả lập)',
          status: 'completed',
          delta: DEV_INITIAL_BALANCE,
          amount_vnd: null,
          created_at: t,
          ref: null,
        },
      ],
      topups: [],
    }
  }

  function readKey(key: string): string | null {
    try {
      return storage.get(key)
    } catch {
      return null
    }
  }

  function parseConfig(raw: string | null): DevConfig {
    try {
      return mergeConfig(raw ? JSON.parse(raw) : null)
    } catch {
      return mergeConfig(null)
    }
  }

  /** The saved account, or a new one (nothing saved / unreadable). */
  function loadState(): DevState {
    stateRaw = readKey(DEV_STATE_KEY)
    return parseState(stateRaw) ?? fresh()
  }

  function loadConfig(): DevConfig {
    configRaw = readKey(DEV_CONFIG_KEY)
    return parseConfig(configRaw)
  }

  /**
   * Another tab (its own copy of this server, same storage) saved since we last read or wrote: take its version, so
   * every tab works on ONE account like the real site. Called before every request and change. True = changed.
   */
  function pull(): boolean {
    let changed = false
    const raw = readKey(DEV_STATE_KEY)
    if (raw !== null && raw !== stateRaw) {
      stateRaw = raw
      const next = parseState(raw)
      if (next) {
        state = next
        changed = true
      }
    }
    const craw = readKey(DEV_CONFIG_KEY)
    if (craw !== configRaw) {
      configRaw = craw
      config = parseConfig(craw)
      changed = true
    }
    if (changed) snap = null
    return changed
  }

  let snap: DevServerSnapshot | null = null
  function notify() {
    snap = null
    for (const l of [...listeners]) {
      try {
        l()
      } catch {
        /* a listener's problem is not the server's */
      }
    }
  }

  /** Uploads a kept job or a saved canvas still points at (never let go: the video / canvas would break). */
  function usedUploadIds(): Set<string> {
    const used = new Set<string>()
    for (const j of state.jobs) {
      for (const id of j.upload_ids) used.add(id)
      if (j.first_frame_upload_id) used.add(j.first_frame_upload_id)
      if (j.last_frame_upload_id) used.add(j.last_frame_upload_id)
    }
    for (const p of state.projects) for (const id of canvasUploadIds(p.canvas)) used.add(id)
    return used
  }

  /** Keep the lists bounded (and the saved text under DEV_STATE_MAX_CHARS); the blobs of what goes go too. */
  function compact(): string {
    const goneJobs: DevJob[] = []
    if (state.jobs.length > MAX_JOBS) {
      // over the cap: the oldest FINISHED jobs go (a running one is still polled by some take)
      let over = state.jobs.length - MAX_JOBS
      const kept: DevJob[] = []
      for (const j of state.jobs) {
        if (over > 0 && !isRunning(j)) {
          goneJobs.push(j)
          over--
        } else kept.push(j)
      }
      state = { ...state, jobs: kept }
    }
    state = { ...state, history: keepLast(state.history, MAX_HISTORY), topups: keepLast(state.topups, MAX_TOPUPS) }
    let raw = JSON.stringify(state)
    if (raw.length > DEV_STATE_MAX_CHARS) {
      // Too big for localStorage: the oldest finished jobs (and their long prompts) go first.
      let excess = raw.length - DEV_STATE_MAX_CHARS
      const drop = new Set<string>()
      for (const j of state.jobs) {
        if (excess <= 0) break
        if (isRunning(j)) continue
        drop.add(j.job_id)
        excess -= JSON.stringify(j).length + 1
      }
      if (drop.size) {
        goneJobs.push(...state.jobs.filter((j) => drop.has(j.job_id)))
        state = { ...state, jobs: state.jobs.filter((j) => !drop.has(j.job_id)) }
      }
    }
    const goneUploads: DevUpload[] = []
    if (state.uploads.length > MAX_UPLOADS) {
      const used = usedUploadIds()
      let over = state.uploads.length - MAX_UPLOADS
      const kept: DevUpload[] = []
      for (const u of state.uploads) {
        if (over > 0 && !used.has(u.upload_id)) {
          goneUploads.push(u)
          over--
        } else kept.push(u)
      }
      state = { ...state, uploads: kept }
    }
    if (goneJobs.length || goneUploads.length) raw = JSON.stringify(state)
    for (const j of goneJobs) void blobs.del(`dev:video:${j.job_id}`).catch(() => undefined)
    for (const u of goneUploads) void blobs.del(`dev:upload:${u.upload_id}`).catch(() => undefined)
    return raw
  }

  /** Write `raw` under `key`; a failure (storage full / blocked) is reported, never thrown. True = saved. */
  function write(key: string, raw: string): boolean {
    try {
      storage.set(key, raw)
      persistProblem = null
      return true
    } catch (e) {
      const why = e instanceof Error && e.name === 'QuotaExceededError' ? 'bộ nhớ trình duyệt (localStorage) đã đầy' : e instanceof Error ? e.message : String(e)
      persistProblem = `Không lưu được dữ liệu máy chủ giả lập: ${why}. Thay đổi chỉ còn trong tab này — “Xoá dữ liệu máy chủ giả lập” để bắt đầu lại.`
      return false
    }
  }

  function writeState() {
    const raw = compact()
    // Not saved: remember what IS saved, so the next pull() does not mistake it for another tab's newer version.
    stateRaw = write(DEV_STATE_KEY, raw) ? raw : readKey(DEV_STATE_KEY)
  }

  function save() {
    writeState()
    notify()
  }

  function saveConfig() {
    const raw = JSON.stringify(config)
    configRaw = write(DEV_CONFIG_KEY, raw) ? raw : readKey(DEV_CONFIG_KEY)
    notify()
  }

  /** A new UUID-shaped id (unique per account: salt + sequence). */
  function newUuid(kind: string): string {
    state.seq += 1
    return uuidFromKey(`sanovids-dev:${kind}:${state.salt}:${state.seq}`)
  }

  function addHistory(item: Omit<DevHistoryItem, 'created_at'> & { created_at?: number }) {
    state.history.push({ ...item, created_at: item.created_at ?? now() })
  }

  const between = ([lo, hi]: [number, number]) => lo + random() * (hi - lo)

  // ---- jobs ----

  function refund(j: DevJob, why: string) {
    if (j.refunded || j.cost <= 0) return
    j.refunded = true
    state.balance += j.cost
    addHistory({ type: 'refund', description: `Hoàn ${j.cost} credit — job #${j.number} lỗi: ${why}`, status: 'completed', delta: j.cost, amount_vnd: null, ref: j.job_id })
  }

  function endJob(j: DevJob, status: 'completed' | 'failed' | 'expired', at: number, message?: string | null) {
    j.status = status
    j.finished_at = at
    if (status === 'completed') {
      j.progress = 100
      j.download_available = true
      j.error_message = null
    } else if (status === 'expired') {
      j.progress = 100
      j.download_available = false
    } else {
      j.download_available = false
      j.error_message = message ?? 'Tạo video thất bại (giả lập).'
      refund(j, j.error_message)
    }
  }

  /** Bring a job up to time `t` (wall clock). True when it reached an end state now (state must be saved). */
  function advance(j: DevJob, t: number): boolean {
    if (j.status !== 'queued' && j.status !== 'processing') return false
    const { queuedMs, totalMs, failAt, failMessage, expire } = j.plan
    const elapsed = t - j.created_at
    if (elapsed < queuedMs) {
      j.status = 'queued'
      j.progress = 0
      return false
    }
    const span = Math.max(1, totalMs - queuedMs)
    const p = (elapsed - queuedMs) / span
    if (failMessage !== null && p >= failAt) {
      j.progress = Math.round(5 + failAt * 90)
      endJob(j, 'failed', j.created_at + queuedMs + Math.round(failAt * span), failMessage)
      return true
    }
    if (p >= 1) {
      endJob(j, expire ? 'expired' : 'completed', j.created_at + totalMs)
      return true
    }
    j.status = 'processing'
    j.progress = clamp(Math.round(5 + p * 90), 1, 99)
    return false
  }

  /**
   * Bring every job and pending top-up order up to now — the real site moves on by itself, so /api/me, the credit
   * history and every other answer see refunds and payments that are due. Saves when something ended.
   */
  function settleAll(): void {
    const t = now()
    let changed = false
    for (const j of state.jobs) if (advance(j, t)) changed = true
    for (const o of state.topups) if (settleTopup(o, t)) changed = true
    if (changed) save()
  }

  function publicJob(j: DevJob): Record<string, unknown> {
    return {
      job_id: j.job_id,
      job_name: `SanoVids dev #${j.number}`,
      canvas_node_id: j.canvas_node_id,
      model_profile: j.model_profile,
      status: j.status,
      submission_state: 'accepted',
      progress: j.progress,
      download_available: j.download_available,
      error_message: j.error_message,
      duration: j.duration,
      aspect_ratio: j.aspect_ratio,
      created_at: iso(j.created_at),
      finished_at: iso(j.finished_at),
      creation_mode: 'canvas',
      ...(config.exposeKey ? { client_request_id: j.client_request_id } : {}),
    }
  }

  const profilesNow = (): VideoProfile[] => devVideoProfiles(config.models)

  const hasUpload = (id: string) => state.uploads.some((u) => u.upload_id === id)

  function createJob(body: unknown): BridgeResponse {
    const keyProblem = jobKeyProblem(body)
    if (keyProblem) return detail(keyProblem.status, keyProblem.detail)
    const b = body as Record<string, unknown>
    const key = b.client_request_id as string
    if (config.dedupe) {
      const dup = state.jobs.find((j) => j.client_request_id === key)
      if (dup) return json({ job_id: dup.job_id, status: dup.status, submission_state: 'accepted' })
    }
    const project = state.projects.find((p) => p.project_id === b.project_id)
    if (!project) return detail(404, 'Project not found')
    const canvas = project.canvas as { nodes?: { id?: unknown; type?: unknown }[] } | null
    if (!canvas?.nodes?.some((n) => n.id === b.canvas_node_id && n.type === 'video')) return detail(400, 'canvas_node_id is not a video node of the project canvas')
    const bodyProblem = jobBodyProblem(b, { hasUpload })
    if (bodyProblem) return detail(bodyProblem.status, bodyProblem.detail)
    const pp = profileProblem(b, profilesNow())
    if (pp) return detail(pp.status, pp.detail)
    const model = b.model_profile as ModelId
    const frames = isFramesJob(b)
    const ratio = typeof b.aspect_ratio === 'string' ? b.aspect_ratio : null
    const cost = costOf({ model, mode: b.mode as Mode, duration: b.duration as number, resolution: b.resolution as string, ratio: ratio ?? '16:9' })
    if (state.balance < cost) return detail(config.insufficientStatus, `Số dư không đủ: cần ${cost} credit, còn ${state.balance}`)

    const speed = DEV_SPEED_MS[config.speed]
    const queuedMs = Math.round(between(speed.queued))
    const totalMs = Math.max(queuedMs + 1000, Math.round(between(speed.total)))
    let failMessage: string | null = null
    if (jobFaults.failNext !== null) {
      failMessage = jobFaults.failNext.trim() || 'Tạo video thất bại (giả lập).'
      jobFaults = { ...jobFaults, failNext: null }
    } else if (config.failRate > 0 && random() < config.failRate) {
      failMessage = RANDOM_FAILURES[Math.floor(random() * RANDOM_FAILURES.length)] ?? RANDOM_FAILURES[0]
    }
    const expire = jobFaults.expireNext
    if (expire) jobFaults = { ...jobFaults, expireNext: false }

    state.balance -= cost
    const number = state.jobs.reduce((n, j) => Math.max(n, j.number), 0) + 1
    const job: DevJob = {
      job_id: newUuid('job'),
      number,
      project_id: project.project_id,
      canvas_node_id: String(b.canvas_node_id),
      client_request_id: key,
      model_profile: model,
      mode: b.mode as Mode,
      duration: b.duration as number,
      resolution: b.resolution as string,
      aspect_ratio: ratio,
      prompt: b.prompt as string,
      generate_audio: b.generate_audio === true,
      upload_ids: frames ? [] : [...(b.upload_ids as string[])],
      first_frame_upload_id: frames ? (b.first_frame_upload_id as string) : null,
      last_frame_upload_id: frames ? (b.last_frame_upload_id as string) : null,
      cost,
      created_at: now(),
      plan: { queuedMs, totalMs, failAt: 0.3 + random() * 0.4, failMessage, expire },
      status: 'queued',
      progress: 0,
      finished_at: null,
      error_message: null,
      download_available: false,
      refunded: false,
    }
    state.jobs.push(job)
    addHistory({
      type: 'video',
      description: `Tạo video #${number} · ${MODELS[model].name} · ${job.mode} · ${job.duration}s · ${job.resolution}`,
      status: 'charged',
      delta: -cost,
      amount_vnd: null,
      ref: job.job_id,
    })
    save()
    return json({ job_id: job.job_id, status: job.status, submission_state: 'accepted' })
  }

  async function videoOf(j: DevJob): Promise<Blob | null> {
    const cacheKey = `dev:video:${j.job_id}`
    const cached = await blobs.get(cacheKey)
    if (cached) return cached
    let p = rendering.get(j.job_id)
    if (!p) {
      p = (async () => {
        const frames = j.first_frame_upload_id || j.last_frame_upload_id
        const items = frames
          ? [
              { uploadId: j.first_frame_upload_id, label: 'khung đầu' },
              { uploadId: j.last_frame_upload_id, label: 'khung cuối' },
            ].filter((x): x is { uploadId: string; label: string } => !!x.uploadId)
          : j.upload_ids.map((uploadId, i) => ({ uploadId, label: `@image_${i + 1}` }))
        const images = await Promise.all(items.map(async (x) => ({ ...x, blob: await blobs.get(`dev:upload:${x.uploadId}`) })))
        const spec = MODELS[j.model_profile]
        const video = await render({
          jobId: j.job_id,
          jobNumber: j.number,
          title: `${spec?.name ?? j.model_profile} · ${j.mode} · ${j.duration}s · ${j.resolution}`,
          prompt: j.prompt,
          ratio: j.aspect_ratio ?? '16:9',
          durationLabel: `${j.duration}s · ${j.resolution.toUpperCase()} · ${j.aspect_ratio ?? 'theo khung'}`,
          color: spec?.color ?? '#e8894a',
          images,
        })
        if (video) await blobs.set(cacheKey, video)
        return video
      })().finally(() => rendering.delete(j.job_id))
      rendering.set(j.job_id, p)
    }
    return p
  }

  // ---- top-up ----

  function settleTopup(o: DevTopup, t: number): boolean {
    if (o.status !== 'pending') return false
    if (o.settle && t >= o.settle.at) {
      const outcome = o.settle.outcome
      o.settle = null
      o.settled_at = t
      if (outcome === 'paid') {
        o.status = 'paid'
        state.balance += o.credits
        addHistory({ type: 'topup', description: `Nạp ${formatVnd(o.amount_vnd)} qua SePay (giả lập)`, status: 'paid', delta: o.credits, amount_vnd: o.amount_vnd, ref: o.order_id })
      } else if (outcome === 'reconcile_required') {
        o.status = 'reconcile_required'
        addHistory({ type: 'topup', description: `Nạp ${formatVnd(o.amount_vnd)} — đang đối soát (giả lập)`, status: 'reconcile_required', delta: 0, amount_vnd: o.amount_vnd, ref: o.order_id })
      } else o.status = outcome
      return true
    }
    if (t >= o.expires_at) {
      o.status = 'expired'
      o.settled_at = t
      return true
    }
    return false
  }

  function createTopup(body: unknown): BridgeResponse {
    if (!config.topupEnabled) return detail(403, 'Nạp credit đang tạm tắt.')
    if (!isObj(body) || !sameKeys(body, ['amount_vnd'])) return detail(422, [{ type: 'missing', loc: ['body', 'amount_vnd'], msg: 'Field required' }])
    const amount = body.amount_vnd
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) return detail(422, [{ type: 'int_type', loc: ['body', 'amount_vnd'], msg: 'Input should be a valid integer' }])
    if (amount < TOPUP_MIN_VND || amount > TOPUP_MAX_VND || amount % TOPUP_STEP_VND !== 0) {
      return detail(400, `Số tiền nạp phải từ ${formatVnd(TOPUP_MIN_VND)} đến ${formatVnd(TOPUP_MAX_VND)}, bội số của ${formatVnd(TOPUP_STEP_VND)}.`)
    }
    state.seq += 1
    const orderId = `DEVTOP${String(state.seq).padStart(5, '0')}${state.salt.slice(0, 4).toUpperCase()}`
    const t = now()
    const credits = creditsForAmount(amount)
    state.topups.push({ order_id: orderId, amount_vnd: amount, credits, status: 'pending', created_at: t, expires_at: t + TOPUP_ORDER_TTL_MS, settle: null, settled_at: null })
    save()
    const back = (payment: string) => `${CANVASAPP_RETURN}?payment=${payment}&topup_order=${orderId}`
    return json({
      checkout_url: `${DEV_CHECKOUT_ORIGIN}/checkout/${orderId}`,
      fields: {
        merchant: 'SANOVIDS-DEV',
        currency: 'VND',
        operation: 'PURCHASE',
        order_amount: String(amount),
        order_invoice_number: orderId,
        order_description: `Nap ${credits} credit canvasapp (gia lap)`,
        customer_id: 'dev',
        success_url: back('success'),
        error_url: back('error'),
        cancel_url: back('cancel'),
        signature: 'dev-simulation',
      },
      order_id: orderId,
    })
  }

  function topupView(o: DevTopup): Record<string, unknown> {
    return { order_id: o.order_id, status: o.status, amount_vnd: o.amount_vnd, credits: o.credits, created_at: iso(o.created_at), expires_at: iso(o.expires_at), paid_at: o.status === 'paid' ? iso(o.settled_at) : null }
  }

  function creditHistory(q: URLSearchParams): BridgeResponse {
    const kind = q.get('kind') ?? 'all'
    if (!isTopupHistoryKind(kind)) return detail(422, 'kind không hợp lệ')
    const offset = clamp(Math.trunc(Number(q.get('offset') ?? 0)) || 0, 0, 999_999)
    const limit = clamp(Math.trunc(Number(q.get('limit') ?? 20)) || 20, 1, 100)
    const all = state.history.filter((h) => kind === 'all' || h.type === kind).slice().reverse()
    const page = all.slice(offset, offset + limit).map((h) => ({ type: h.type, description: h.description, status: h.status, delta: h.delta, amount_vnd: h.amount_vnd, created_at: iso(h.created_at) }))
    return json({ balance: state.balance, items: page, next_offset: offset + limit < all.length ? offset + limit : null })
  }

  // ---- dispatch ----

  async function handle(req: TransportRequest, endpoint: DevEndpoint | null, path: string, query: URLSearchParams): Promise<BridgeResponse> {
    if (!endpoint) return detail(404, 'Not found')
    settleAll()
    if (endpoint === 'auth-state') {
      return json({ authenticated: state.authenticated, topup_enabled: config.topupEnabled, google_login_enabled: false, simple_mode: { enabled: false } })
    }
    if (!state.authenticated) return detail(401, 'Not authenticated')
    const idIn = (re: RegExp) => re.exec(path)?.[1] ?? ''
    switch (endpoint) {
      case 'me':
        return json({ credits_balance: state.balance, email: DEV_EMAIL, display_name: 'Tài khoản giả lập (chế độ Phát triển)' })
      case 'video-profiles':
        return json({ profiles: profilesNow() })
      case 'projects-list':
        return json(state.projects.map((p) => ({ project_id: p.project_id, name: p.name })))
      case 'project-create': {
        // canvasapp's page posts no body ("Phiên mới") and names it afterwards with PATCH {name}
        if (req.json !== undefined) return detail(422, 'no body expected')
        const p: DevProject = { project_id: newUuid('project'), name: 'Phiên mới', created_at: now(), canvas: null, canvas_saved_at: null }
        state.projects.push(p)
        save()
        return json({ project_id: p.project_id })
      }
      case 'project-get': {
        const p = state.projects.find((x) => x.project_id === idIn(/^\/api\/projects\/([^/]+)$/))
        if (!p) return detail(404, 'Project not found')
        return json({ project_id: p.project_id, name: p.name, canvas: p.canvas ?? { nodes: [], connections: [], viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 } } })
      }
      case 'project-rename': {
        const p = state.projects.find((x) => x.project_id === idIn(/^\/api\/projects\/([^/]+)$/))
        if (!p) return detail(404, 'Project not found')
        const body = req.json
        if (!isObj(body) || !sameKeys(body, ['name']) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) return detail(422, 'name required')
        p.name = body.name
        save()
        return json({ ok: true })
      }
      case 'canvas-put': {
        const p = state.projects.find((x) => x.project_id === idIn(/^\/api\/projects\/([^/]+)\/canvas$/))
        if (!p) return detail(404, 'Project not found')
        const problem = canvasProblem(req.json)
        if (problem) return detail(400, `Invalid canvas payload (${problem})`)
        if (canvasUploadIds(req.json).some((id) => !hasUpload(id))) return detail(400, 'Invalid canvas payload (unknown upload_id)')
        p.canvas = req.json
        p.canvas_saved_at = now()
        save()
        return json({ ok: true })
      }
      case 'upload': {
        const f = req.form
        if (!f || f.field !== 'file') return detail(422, [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required' }])
        if (!ALLOWED_IMAGE_TYPES.includes(f.contentType)) return detail(400, 'Chỉ nhận ảnh JPG/PNG/WEBP.')
        if (!f.bytes?.byteLength) return detail(400, 'File rỗng.')
        if (f.bytes.byteLength > MAX_UPLOAD_BYTES) return detail(413, 'Ảnh lớn hơn 20 MB.')
        const mine = epoch
        const salt = state.salt
        // Recorded (and saved) before the blob is written: another tab saving meanwhile cannot reuse the id.
        const id = newUuid('upload')
        state.uploads.push({ upload_id: id, filename: f.filename, content_type: f.contentType, size: f.bytes.byteLength, created_at: now() })
        save()
        try {
          await blobs.set(`dev:upload:${id}`, new Blob([f.bytes as BlobPart], { type: f.contentType }))
        } catch (e) {
          pull()
          if (state.uploads.some((u) => u.upload_id === id)) {
            state.uploads = state.uploads.filter((u) => u.upload_id !== id)
            save()
          }
          throw e
        }
        pull()
        if (mine !== epoch || state.salt !== salt) return detail(500, 'Máy chủ giả lập vừa được đặt lại.')
        return json({ upload_id: id })
      }
      case 'jobs-list': {
        const pid = query.get('project_id')
        if (!pid) return detail(422, 'project_id required')
        return json(state.jobs.filter((j) => j.project_id === pid).map(publicJob))
      }
      case 'job-create':
        return createJob(req.json)
      case 'job-prompt': {
        const j = state.jobs.find((x) => x.job_id === idIn(/^\/api\/video-jobs\/([^/]+)\/prompt$/))
        return j ? json({ prompt: j.prompt }) : detail(404, 'Job not found')
      }
      case 'job-stream': {
        const j = state.jobs.find((x) => x.job_id === idIn(/^\/api\/video-jobs\/([^/]+)\/stream$/))
        if (!j) return detail(404, 'Job not found')
        if (j.status !== 'completed' || !j.download_available) return detail(409, 'Video chưa sẵn sàng')
        if (jobFaults.streamFailures > 0) {
          jobFaults = { ...jobFaults, streamFailures: jobFaults.streamFailures - 1 }
          notify()
          return detail(503, 'Không tải được video lúc này (giả lập lỗi tải).')
        }
        const video = await videoOf(j)
        if (!video) return detail(500, 'Không tạo được video giả lập: trình duyệt này không ghi được video (MediaRecorder).')
        return { ok: true, status: 200, contentType: video.type || 'video/webm', bytes: new Uint8Array(await video.arrayBuffer()) }
      }
      case 'job-delete': {
        const id = idIn(/^\/api\/video-jobs\/([^/]+)$/)
        if (!state.jobs.some((j) => j.job_id === id)) return detail(404, 'Job not found')
        state.jobs = state.jobs.filter((j) => j.job_id !== id)
        void blobs.del(`dev:video:${id}`)
        save()
        return json({ ok: true })
      }
      case 'topup-create':
        return createTopup(req.json)
      case 'topup-get': {
        const o = state.topups.find((x) => x.order_id === idIn(/^\/api\/payments\/topups\/([^/]+)$/))
        if (!o) return detail(404, 'Order not found')
        if (settleTopup(o, now())) save()
        return json(topupView(o))
      }
      case 'credit-history':
        return creditHistory(query)
    }
  }

  /**
   * The faults one request meets. 'slow' rules add up (every matching one fires); of the others ONE decides what
   * happens — a rule for this endpoint before a '*' rule, then the oldest — so a sticky "slow" or "429 everywhere"
   * never hides a fault armed for this endpoint. One-shot rules count down when they fire.
   */
  function takeFaults(endpoint: DevEndpoint | null): { delayMs: number; rule: DevFaultRule | null; label: string | null } {
    if (!endpoint) return { delayMs: 0, rule: null, label: null }
    const matches = (r: DevFaultRule) => r.endpoint === '*' || r.endpoint === endpoint
    const outcome =
      faultRules.find((r) => r.endpoint === endpoint && r.fault.kind !== 'slow') ?? faultRules.find((r) => r.endpoint === '*' && r.fault.kind !== 'slow') ?? null
    const fires = (r: DevFaultRule) => r === outcome || (matches(r) && r.fault.kind === 'slow')
    if (!faultRules.some(fires)) return { delayMs: 0, rule: null, label: null }
    let delayMs = 0
    let rule: DevFaultRule | null = null
    const labels: string[] = []
    const after: DevFaultRule[] = []
    for (const r of faultRules) {
      if (!fires(r)) {
        after.push(r)
        continue
      }
      const fired: DevFaultRule = { ...r, hits: r.hits + 1, remaining: r.sticky ? r.remaining : r.remaining - 1 }
      if (fired.sticky || fired.remaining > 0) after.push(fired)
      if (r.fault.kind === 'slow') delayMs += r.fault.ms
      if (r === outcome) rule = fired
      labels.push(faultLabel(r.fault))
    }
    faultRules = after
    notify()
    return { delayMs, rule, label: labels.join(' + ') }
  }

  function logEntry(req: TransportRequest, endpoint: DevEndpoint | null, started: number, res: BridgeResponse, fault: string | null, processed: boolean) {
    if (!logging) return
    const reqBody = req.form ? { field: req.form.field, filename: req.form.filename, contentType: req.form.contentType, bytes: req.form.bytes?.byteLength ?? 0 } : req.json
    const resBody = res.ok ? (res.bytes ? { bytes: res.bytes.byteLength, contentType: res.contentType } : res.json ?? res.text ?? null) : { code: res.code, message: res.message }
    pushDevLog({
      at: started,
      method: req.method,
      path: req.path,
      endpoint,
      status: res.ok ? res.status : null,
      ms: Math.max(0, now() - started),
      req: summarizeForLog(reqBody ?? null),
      res: summarizeForLog(resBody),
      fault,
      processed,
    })
  }

  async function request(req: TransportRequest): Promise<BridgeResponse> {
    const started = now()
    const match = matchDevRoute(req.method, req.path)
    const endpoint = match?.endpoint ?? null
    pull()
    const fired = takeFaults(endpoint)
    const rule = fired.rule
    const wait = config.latencyMs + fired.delayMs
    if (wait > 0) await sleep(wait)
    const fault = fired.label
    if (rule?.fault.kind === 'network') {
      const res: BridgeResponse = { ok: false, code: 'network', message: 'Không kết nối được tới canvasapp giả lập (lỗi giả: mất mạng).' }
      logEntry(req, endpoint, started, res, fault, false)
      return res
    }
    if (rule?.fault.kind === 'response') {
      const res = json(rule.fault.json ?? {}, rule.fault.status)
      logEntry(req, endpoint, started, res, fault, false)
      return res
    }
    let res: BridgeResponse
    try {
      // Another tab may have changed the account while this request waited.
      pull()
      res = await handle(req, endpoint, match?.pathname ?? req.path.split('?')[0], match?.query ?? new URLSearchParams())
    } catch (e) {
      res = detail(500, `Lỗi máy chủ giả lập: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (rule?.fault.kind === 'lost-response') {
      const lost: BridgeResponse = { ok: false, code: 'network', message: 'canvasapp giả lập không phản hồi (quá thời gian chờ) — lỗi giả: mất câu trả lời.' }
      logEntry(req, endpoint, started, lost, fault, true)
      return lost
    }
    if (rule?.fault.kind === 'processed-then') {
      const other = json(rule.fault.json ?? {}, rule.fault.status)
      logEntry(req, endpoint, started, other, fault, true)
      return other
    }
    logEntry(req, endpoint, started, res, fault, true)
    return res
  }

  // ---- views ----

  function jobView(j: DevJob): DevJobView {
    return {
      job_id: j.job_id,
      number: j.number,
      project_id: j.project_id,
      canvas_node_id: j.canvas_node_id,
      client_request_id: j.client_request_id,
      model_profile: j.model_profile,
      mode: j.mode,
      duration: j.duration,
      resolution: j.resolution,
      aspect_ratio: j.aspect_ratio,
      prompt: j.prompt,
      upload_ids: [...j.upload_ids],
      first_frame_upload_id: j.first_frame_upload_id,
      last_frame_upload_id: j.last_frame_upload_id,
      cost: j.cost,
      status: j.status,
      progress: j.progress,
      created_at: j.created_at,
      finished_at: j.finished_at,
      error_message: j.error_message,
      download_available: j.download_available,
      refunded: j.refunded,
      planned: j.plan.failMessage !== null ? 'fail' : j.plan.expire ? 'expire' : null,
    }
  }

  function snapshot(): DevServerSnapshot {
    pull()
    settleAll()
    if (snap) {
      // job progress moves with the clock: refresh the views of running jobs only
      if (!state.jobs.some(isRunning)) return snap
    }
    snap = {
      authenticated: state.authenticated,
      sessionExpired: state.sessionExpired,
      balance: state.balance,
      config,
      faults: faultRules.map((r) => ({ ...r })),
      jobFaults: { ...jobFaults },
      projects: state.projects.map((p) => ({
        project_id: p.project_id,
        name: p.name,
        nodes: isObj(p.canvas) && Array.isArray(p.canvas.nodes) ? p.canvas.nodes.length : 0,
        savedAt: p.canvas_saved_at,
      })),
      jobs: state.jobs.map(jobView).reverse(),
      uploads: state.uploads.map((u) => ({ ...u, imageId: imageIdFromUploadFilename(u.filename) })).reverse(),
      topups: state.topups.map((o) => ({ order_id: o.order_id, amount_vnd: o.amount_vnd, credits: o.credits, status: o.status, created_at: o.created_at, expires_at: o.expires_at, settle: o.settle })).reverse(),
      historyCount: state.history.length,
      persistProblem,
    }
    return snap
  }

  /** pull() before a change made from the outside (dev panel, bridge): it applies to the shared account. */
  function change(fn: () => void): void {
    pull()
    fn()
  }

  return {
    request,
    isAuthenticated: () => {
      pull()
      return state.authenticated
    },
    login: () =>
      change(() => {
        if (state.authenticated && !state.sessionExpired) return
        state.authenticated = true
        state.sessionExpired = false
        save()
      }),
    logout: () =>
      change(() => {
        if (!state.authenticated && !state.sessionExpired) return
        state.authenticated = false
        state.sessionExpired = false
        save()
      }),
    expireSession: () =>
      change(() => {
        state.authenticated = false
        state.sessionExpired = true
        save()
      }),
    balance: () => {
      pull()
      return state.balance
    },
    setBalance: (credits) =>
      change(() => {
        if (!Number.isFinite(credits)) return
        const next = Math.round(credits * 100) / 100
        const delta = next - state.balance
        if (!delta) return
        state.balance = next
        addHistory({ type: 'adjustment', description: 'Điều chỉnh số dư trong chế độ Phát triển', status: 'completed', delta, amount_vnd: null, ref: null })
        save()
      }),
    config: () => {
      pull()
      return config
    },
    setConfig: (patch) =>
      change(() => {
        config = mergeConfig({ ...config, ...patch, models: { ...config.models, ...(patch.models ?? {}) } })
        saveConfig()
      }),
    faults: () => faultRules.map((r) => ({ ...r })),
    addFault: (input) => {
      const rule: DevFaultRule = {
        id: `f${++faultSeq}`,
        endpoint: input.endpoint,
        fault: input.fault,
        sticky: !!input.sticky,
        remaining: input.sticky ? 0 : Math.max(1, Math.trunc(input.times ?? 1) || 1),
        hits: 0,
        label: input.label ?? null,
      }
      faultRules = [...faultRules, rule]
      notify()
      return { ...rule }
    },
    removeFault: (id) => {
      faultRules = faultRules.filter((r) => r.id !== id)
      notify()
    },
    clearFaults: () => {
      faultRules = []
      jobFaults = { ...NO_JOB_FAULTS }
      notify()
    },
    jobFaults: () => ({ ...jobFaults }),
    setJobFaults: (patch) => {
      jobFaults = {
        failNext: patch.failNext !== undefined ? patch.failNext : jobFaults.failNext,
        expireNext: patch.expireNext ?? jobFaults.expireNext,
        streamFailures: Math.max(0, Math.trunc(patch.streamFailures ?? jobFaults.streamFailures)),
      }
      notify()
    },
    forceJob: (jobId, action, message) => {
      pull()
      const j = state.jobs.find((x) => x.job_id === jobId)
      if (!j) return false
      advance(j, now())
      if (j.status !== 'queued' && j.status !== 'processing') return false
      if (action === 'complete') endJob(j, 'completed', now())
      else if (action === 'expire') endJob(j, 'expired', now())
      else endJob(j, 'failed', now(), message?.trim() || 'Job bị đánh lỗi trong chế độ Phát triển.')
      save()
      return true
    },
    simulatePayment: (orderId, outcome, delayMs = 0) => {
      pull()
      const o = state.topups.find((x) => x.order_id === orderId)
      if (!o) return false
      settleTopup(o, now())
      if (o.status !== 'pending') return false
      if (outcome === 'none') return true
      o.settle = { outcome, at: now() + Math.max(0, delayMs) }
      save()
      return true
    },
    uploadBlob: (uploadId) => blobs.get(`dev:upload:${uploadId}`),
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    reset: async (opts = {}) => {
      epoch++
      rendering.clear()
      state = fresh()
      faultRules = []
      jobFaults = { ...NO_JOB_FAULTS }
      if (!opts.keepConfig) {
        config = mergeConfig(null)
        try {
          storage.remove(DEV_CONFIG_KEY)
        } catch {
          /* the defaults apply in this tab anyway */
        }
        configRaw = readKey(DEV_CONFIG_KEY)
      }
      writeState()
      try {
        await blobs.clear()
      } catch {
        /* blobs of the old account stay unreachable: every id is new */
      }
      notify()
    },
    sync: () => {
      if (!pull()) return false
      notify()
      return true
    },
  }
}
