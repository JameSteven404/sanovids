// Typed wrappers over canvasapp.io.vn's internal web API (see docs/canvasapp-api-notes.md).
// Unofficial endpoints: they can change without notice. Every call goes through a Transport — in the desktop
// app that is Electron IPC into a dedicated session (electron/main.cjs), which adds the CSRF header and
// enforces an endpoint allowlist. The renderer never sees cookies or passwords.
import { isTopupHistoryKind, TOPUP_MAX_VND, TOPUP_MIN_VND, TOPUP_STEP_VND, type TopupHistoryKind } from '../../core/topup'
import type { ProviderAvailability } from '../types'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface TransportRequest {
  method: HttpMethod
  /** Path + optional query, starting with /api/ (e.g. "/api/video-jobs?project_id=abc"). */
  path: string
  /** JSON body. */
  json?: unknown
  /** Multipart body with one file field (image upload). */
  form?: { field: string; filename: string; contentType: string; bytes: Uint8Array }
  /** Return the body as bytes (video stream). */
  binary?: boolean
}

export interface TransportResponse {
  status: number
  contentType: string
  json?: unknown
  text?: string
  bytes?: Uint8Array
}

export interface Transport {
  available(): Promise<ProviderAvailability>
  request(req: TransportRequest): Promise<TransportResponse>
}

export type CanvasappErrorCode =
  | 'login-required'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'bad-request'
  | 'server'
  | 'network'
  | 'unavailable'
  | 'unsupported'
  | 'bad-response'
  | 'busy'
  | 'cancelled'

export class CanvasappError extends Error {
  readonly code: CanvasappErrorCode
  readonly status?: number
  readonly detail?: string
  /** A video job may have been created (and billed) although no job id came back — see providers/types isSubmitUncertain. */
  readonly uncertain?: boolean
  constructor(code: CanvasappErrorCode, message: string, opts: { status?: number; detail?: string; uncertain?: boolean } = {}) {
    super(message)
    this.name = 'CanvasappError'
    this.code = code
    this.status = opts.status
    this.detail = opts.detail
    if (opts.uncertain) this.uncertain = true
  }
}

export const isLoginRequired = (e: unknown) => e instanceof CanvasappError && e.code === 'login-required'

const CODE_TEXT: Record<CanvasappErrorCode, string> = {
  'login-required': 'Chưa đăng nhập canvasapp.io.vn hoặc phiên đã hết hạn — vào Cài đặt → Cổng canvasapp để đăng nhập lại.',
  forbidden: 'canvasapp.io.vn từ chối yêu cầu (403).',
  'not-found': 'canvasapp.io.vn không tìm thấy dữ liệu (404).',
  'rate-limited': 'canvasapp.io.vn đang giới hạn tần suất (429) — thử lại sau ít phút.',
  'bad-request': 'canvasapp.io.vn không nhận yêu cầu này.',
  server: 'canvasapp.io.vn đang lỗi máy chủ — thử lại sau.',
  network: 'Không kết nối được tới canvasapp.io.vn.',
  unavailable: 'Cổng canvasapp chỉ dùng được trong bản desktop SanoVids.',
  unsupported: 'Yêu cầu này chưa được cổng canvasapp hỗ trợ.',
  'bad-response': 'canvasapp.io.vn trả về dữ liệu không đúng định dạng mong đợi.',
  busy: 'Đang có một cửa sổ thanh toán mở — hoàn tất hoặc đóng nó trước.',
  cancelled: 'Đã huỷ trước khi gửi sang canvasapp — không bị trừ credit.',
}

/** Shown when canvasapp refuses a job for lack of credits (HTTP 402, or a 4xx whose detail talks about the balance). */
export const NOT_ENOUGH_CREDITS_TEXT = 'Tài khoản canvasapp không đủ credit để tạo video này — nạp thêm credit rồi chạy lại.'
const CREDIT_DETAIL_RE = /credit|insufficient|balance|số dư|không đủ/i

/** Map an HTTP response to an error (401 → 'login-required'). The server's `detail` is appended when present. */
export function errorFromResponse(res: TransportResponse): CanvasappError {
  const detail = detailOf(res)
  let code: CanvasappErrorCode
  if (res.status === 401) code = 'login-required'
  else if (res.status === 403) code = 'forbidden'
  else if (res.status === 404) code = 'not-found'
  else if (res.status === 429) code = 'rate-limited'
  else if (res.status >= 500) code = 'server'
  else code = 'bad-request'
  const noCredit = code === 'bad-request' && (res.status === 402 || (!!detail && CREDIT_DETAIL_RE.test(detail)))
  const text = noCredit ? NOT_ENOUGH_CREDITS_TEXT : CODE_TEXT[code]
  const msg = detail && code !== 'login-required' ? `${text} ${detail}` : text
  return new CanvasappError(code, msg, { status: res.status, detail })
}

export function canvasappErrorText(e: unknown): string {
  if (e instanceof CanvasappError) return e.message
  if (e instanceof Error && e.message) return e.message
  return CODE_TEXT.network
}

function detailOf(res: TransportResponse): string | undefined {
  const j = res.json as { detail?: unknown } | undefined
  if (j && typeof j === 'object') {
    if (typeof j.detail === 'string') return j.detail.slice(0, 300)
    if (Array.isArray(j.detail)) return j.detail.map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : String(d))).join('; ').slice(0, 300)
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Response shapes (only the fields SanoVids uses; everything else is kept as unknown)
// ---------------------------------------------------------------------------------------------

export interface AuthState {
  authenticated: boolean
  /** Top-up (Nạp credit) is open on canvasapp. Missing = treat as off. */
  topup_enabled?: boolean
  [k: string]: unknown
}

export interface Me {
  credits_balance?: number
  email?: string
  [k: string]: unknown
}

export interface VideoProfileOptions {
  modes?: string[]
  disabled_modes?: string[]
  durations?: number[]
  resolutions?: string[]
  aspect_ratios?: string[]
  pricing?: unknown
}

export interface VideoProfile {
  model_profile: string
  display_name?: string
  visible?: boolean
  enabled?: boolean
  can_create?: boolean
  options?: VideoProfileOptions
}

export interface CanvasProject {
  project_id: string
  name: string
}

export interface CanvasNode {
  id: string
  type: 'images' | 'video' | string
  x: number
  y: number
  w?: number
  h?: number
  data: Record<string, unknown>
}

export interface CanvasConnection {
  from: string
  to: string
  target_handle: 'reference' | 'first_frame' | 'last_frame'
  order: number
}

export interface CanvasPayload {
  nodes: CanvasNode[]
  connections: CanvasConnection[]
  viewport: { x: number; y: number; zoom: number }
}

export interface VideoJobBody {
  project_id: string
  model_profile: string
  canvas_node_id: string
  prompt: string
  mode: string
  duration: number
  resolution: string
  generate_audio: boolean
  upload_ids: string[]
  aspect_ratio: string
  first_frame_upload_id?: string
  last_frame_upload_id?: string
  client_request_id: string
}

export type CanvasJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired'

export interface CanvasJob {
  job_id: string
  job_name?: string
  canvas_node_id?: string
  model_profile?: string
  status: CanvasJobStatus | string
  submission_state?: 'not_submitted' | 'submitting' | 'accepted' | string
  progress?: number | null
  download_available?: boolean
  error_message?: string | null
  duration?: number
  aspect_ratio?: string
  created_at?: string
  finished_at?: string | null
  [k: string]: unknown
}

// ---- Top-up (Nạp credit, docs/SPEC-v2.md §10) ----

/** POST /api/payments/topups → the checkout form canvasapp's own page would auto-submit (SePay). */
export interface TopupCheckout {
  /** Where the form is POSTed. NOT checked here: the UI checks it with core/topup checkoutUrlAllowed, main re-checks. */
  checkout_url: string
  /** Hidden form fields, all as strings (numbers / booleans converted). */
  fields: Record<string, string>
  /** Order id when canvasapp returns one with the order (VERIFY which key); null otherwise. */
  order_id: string | null
  [k: string]: unknown
}

/** GET /api/payments/topups/{id}. `status`: pending | paid | reconciled | reconcile_required | expired | rejected. */
export interface TopupOrder {
  /** Lower-cased, trimmed. Map it with core/topup mapTopupStatus. */
  status: string
  amount_vnd: number | null
  [k: string]: unknown
}

export interface CreditHistoryItem {
  type: string
  description: string
  status: string | null
  /** Credits added (+) or spent (−). */
  delta: number | null
  amount_vnd: number | null
  created_at: string | null
}

export interface CreditHistoryPage {
  balance: number | null
  items: CreditHistoryItem[]
  /** Offset of the next page; null = no more. */
  next_offset: number | null
}

export interface CreditHistoryQuery {
  kind?: TopupHistoryKind
  offset?: number
  limit?: number
}

// ---------------------------------------------------------------------------------------------

const enc = encodeURIComponent

const FIELD_NAME_RE = /^[A-Za-z0-9_.[\]-]{1,100}$/
const MAX_FIELDS = 60
const MAX_FIELD_VALUE = 4000
const ORDER_KEYS = ['order_id', 'topup_order', 'topup_order_id', 'order', 'id'] as const

const badResponse = (why?: string) => new CanvasappError('bad-response', why ? `${CODE_TEXT['bad-response']} (${why})` : CODE_TEXT['bad-response'])

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Number from a number or a numeric string; else null. */
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)

/** Validate the checkout response. Exported for tests. */
export function normalizeTopupCheckout(raw: unknown): TopupCheckout {
  if (!isObject(raw)) throw badResponse('đơn nạp')
  const url = raw.checkout_url
  if (typeof url !== 'string' || !url.trim() || url.length > 4000) throw badResponse('thiếu checkout_url')
  const rawFields = raw.fields
  if (!isObject(rawFields)) throw badResponse('thiếu fields')
  const entries = Object.entries(rawFields)
  if (entries.length > MAX_FIELDS) throw badResponse('quá nhiều fields')
  const fields: Record<string, string> = {}
  for (const [name, value] of entries) {
    if (!FIELD_NAME_RE.test(name)) throw badResponse(`tên field lạ: ${name.slice(0, 40)}`)
    const v = typeof value === 'boolean' ? String(value) : str(value)
    if (v === null || v.length > MAX_FIELD_VALUE) throw badResponse(`giá trị field ${name}`)
    fields[name] = v
  }
  let order_id: string | null = null
  for (const k of ORDER_KEYS) {
    const v = str(raw[k])
    if (v && /^[A-Za-z0-9_-]{1,80}$/.test(v)) {
      order_id = v
      break
    }
  }
  return { ...raw, checkout_url: url.trim(), fields, order_id }
}

/** Validate a top-up order. Exported for tests. */
export function normalizeTopupOrder(raw: unknown): TopupOrder {
  if (!isObject(raw) || typeof raw.status !== 'string' || !raw.status.trim()) throw badResponse('trạng thái đơn nạp')
  return { ...raw, status: raw.status.trim().toLowerCase(), amount_vnd: num(raw.amount_vnd) }
}

/** Validate / normalize one page of credit history. Exported for tests. */
export function normalizeCreditHistory(raw: unknown): CreditHistoryPage {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.items) ? raw.items : null
  if (!list) throw badResponse('lịch sử credit')
  const items: CreditHistoryItem[] = list.filter(isObject).map((it) => ({
    type: str(it.type) ?? str(it.kind) ?? '',
    description: str(it.description) ?? '',
    status: str(it.status),
    delta: num(it.delta),
    amount_vnd: num(it.amount_vnd),
    created_at: str(it.created_at),
  }))
  const o = isObject(raw) ? raw : {}
  const next = num(o.next_offset)
  return {
    balance: num(o.balance),
    items,
    next_offset: next !== null && Number.isInteger(next) && next >= 0 ? next : null,
  }
}

/** Query string for GET /api/credits/history (only kind/offset/limit, the Electron allowlist enforces the same). */
export function creditHistoryPath(q: CreditHistoryQuery = {}): string {
  const kind = q.kind ?? 'all'
  if (!isTopupHistoryKind(kind)) throw new CanvasappError('bad-request', `Loại lịch sử không hợp lệ: ${String(kind).slice(0, 20)}`)
  const offset = Math.max(0, Math.min(999_999, Math.trunc(q.offset ?? 0) || 0))
  const limit = Math.max(1, Math.min(100, Math.trunc(q.limit ?? 20) || 20))
  return `/api/credits/history?kind=${kind}&offset=${offset}&limit=${limit}`
}

function checkTopupAmount(amountVnd: number): number {
  if (!Number.isSafeInteger(amountVnd) || amountVnd < TOPUP_MIN_VND || amountVnd > TOPUP_MAX_VND || amountVnd % TOPUP_STEP_VND !== 0) {
    throw new CanvasappError('bad-request', 'Số tiền nạp không hợp lệ (10.000đ – 10.000.000đ, bội số của 1.000đ).')
  }
  return amountVnd
}

/** Ids go into URL paths: keep them to a safe charset (the Electron allowlist enforces the same). */
function safeId(id: string, what: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new CanvasappError('bad-request', `Mã ${what} không hợp lệ: ${id.slice(0, 40)}`)
  return id
}

function asArray<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>)[key])) return (raw as Record<string, T[]>)[key]
  throw new CanvasappError('bad-response', CODE_TEXT['bad-response'])
}

export function createCanvasappApi(transport: Transport) {
  async function call(req: TransportRequest): Promise<TransportResponse> {
    let res: TransportResponse
    try {
      res = await transport.request(req)
    } catch (e) {
      if (e instanceof CanvasappError) throw e
      throw new CanvasappError('network', CODE_TEXT.network + (e instanceof Error && e.message ? ` (${e.message})` : ''))
    }
    if (res.status < 200 || res.status >= 300) throw errorFromResponse(res)
    return res
  }
  async function json<T>(req: TransportRequest): Promise<T> {
    const res = await call(req)
    if (res.json === undefined) {
      if (res.status === 204) return undefined as T
      throw new CanvasappError('bad-response', CODE_TEXT['bad-response'], { status: res.status })
    }
    return res.json as T
  }

  return {
    transport,
    authState: () => json<AuthState>({ method: 'GET', path: '/api/auth/state' }),
    me: () => json<Me>({ method: 'GET', path: '/api/me' }),
    videoProfiles: async () => asArray<VideoProfile>(await json<unknown>({ method: 'GET', path: '/api/video-profiles' }), 'profiles'),

    listProjects: async () => asArray<CanvasProject>(await json<unknown>({ method: 'GET', path: '/api/projects' }), 'projects'),
    createProject: async (name: string) => {
      const r = await json<{ project_id?: string }>({ method: 'POST', path: '/api/projects', json: { name } })
      if (!r?.project_id) throw new CanvasappError('bad-response', CODE_TEXT['bad-response'])
      return r.project_id
    },
    getProject: async (projectId: string) => json<{ canvas?: CanvasPayload; [k: string]: unknown }>({ method: 'GET', path: `/api/projects/${safeId(projectId, 'phiên')}` }),
    putCanvas: async (projectId: string, canvas: CanvasPayload) => {
      await call({ method: 'PUT', path: `/api/projects/${safeId(projectId, 'phiên')}/canvas`, json: canvas })
    },

    uploadImage: async (blob: Blob, filename: string) => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const r = await json<{ upload_id?: string }>({
        method: 'POST',
        path: '/api/uploads/images',
        form: { field: 'file', filename, contentType: blob.type || 'image/png', bytes },
      })
      if (!r?.upload_id) throw new CanvasappError('bad-response', CODE_TEXT['bad-response'])
      return r.upload_id
    },

    createVideoJob: async (body: VideoJobBody) => json<unknown>({ method: 'POST', path: '/api/video-jobs', json: body }),
    listVideoJobs: async (projectId: string) =>
      asArray<CanvasJob>(await json<unknown>({ method: 'GET', path: `/api/video-jobs?project_id=${enc(safeId(projectId, 'phiên'))}` }), 'jobs'),
    jobPrompt: async (jobId: string) => (await json<{ prompt?: string }>({ method: 'GET', path: `/api/video-jobs/${safeId(jobId, 'job')}/prompt` }))?.prompt ?? '',
    streamPath: (jobId: string) => `/api/video-jobs/${safeId(jobId, 'job')}/stream`,
    fetchVideo: async (jobId: string): Promise<Blob> => {
      const res = await call({ method: 'GET', path: `/api/video-jobs/${safeId(jobId, 'job')}/stream`, binary: true })
      if (!res.bytes?.byteLength) throw new CanvasappError('bad-response', 'canvasapp.io.vn trả về video rỗng.')
      const type = res.contentType.split(';')[0].trim() || 'video/mp4'
      return new Blob([res.bytes as BlobPart], { type: type.startsWith('video/') ? type : 'video/mp4' })
    },
    deleteJob: async (jobId: string) => {
      await call({ method: 'DELETE', path: `/api/video-jobs/${safeId(jobId, 'job')}` })
    },

    // ---- Top-up (Nạp credit). The checkout page itself is opened by transport openCheckout() (Electron window). ----
    /** Create a top-up order of `amountVnd` đồng → the checkout form to open. Never opens anything by itself. */
    createTopup: async (amountVnd: number): Promise<TopupCheckout> =>
      normalizeTopupCheckout(await json<unknown>({ method: 'POST', path: '/api/payments/topups', json: { amount_vnd: checkTopupAmount(amountVnd) } })),
    /** Read an order's status (poll ~2 s after returning from checkout, see core/topup TOPUP_POLL_MS). */
    getTopup: async (orderId: string): Promise<TopupOrder> =>
      normalizeTopupOrder(await json<unknown>({ method: 'GET', path: `/api/payments/topups/${safeId(orderId, 'đơn nạp')}` })),
    /** One page of the credit history (newest first, as canvasapp returns it). */
    creditHistory: async (q: CreditHistoryQuery = {}): Promise<CreditHistoryPage> =>
      normalizeCreditHistory(await json<unknown>({ method: 'GET', path: creditHistoryPath(q) })),
  }
}

export type CanvasappApi = ReturnType<typeof createCanvasappApi>
