// Typed wrappers over canvasapp.io.vn's internal web API (see docs/canvasapp-api-notes.md).
// Unofficial endpoints: they can change without notice. Every call goes through a Transport — in the desktop
// app that is Electron IPC into a dedicated session (electron/main.cjs), which adds the CSRF header and
// enforces an endpoint allowlist. The renderer never sees cookies or passwords.
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

export class CanvasappError extends Error {
  readonly code: CanvasappErrorCode
  readonly status?: number
  readonly detail?: string
  constructor(code: CanvasappErrorCode, message: string, opts: { status?: number; detail?: string } = {}) {
    super(message)
    this.name = 'CanvasappError'
    this.code = code
    this.status = opts.status
    this.detail = opts.detail
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
}

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
  const msg = detail && code !== 'login-required' ? `${CODE_TEXT[code]} ${detail}` : CODE_TEXT[code]
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

// ---------------------------------------------------------------------------------------------

const enc = encodeURIComponent

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
  }
}

export type CanvasappApi = ReturnType<typeof createCanvasappApi>
