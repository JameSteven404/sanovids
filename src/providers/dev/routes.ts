// The endpoint allowlist of electron/main.cjs (its <canvasapp-routes> block), ported to TypeScript so the dev bridge
// refuses exactly what the desktop app refuses — a request the real gateway would never let through fails in dev mode
// too. Pure. providers/__tests__/dev-server.test.ts runs main.cjs's own block next to this one on many requests:
// keep both in sync.
//
// Each route also names its endpoint (DevEndpoint) — what the dev UI shows in the request log and what fault rules
// target.

export const DEV_ORIGIN = 'https://canvasapp.io.vn'
/** JSON bodies ≤ 2 MB, uploads ≤ 20 MB (main.cjs CANVASAPP_MAX_JSON_BYTES / CANVASAPP_MAX_UPLOAD_BYTES). */
export const MAX_JSON_BYTES = 2 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

const ID = '[A-Za-z0-9_-]{1,80}'
const ID_RE = new RegExp(`^${ID}$`)

export type DevEndpoint =
  | 'auth-state'
  | 'me'
  | 'video-profiles'
  | 'projects-list'
  | 'project-create'
  | 'project-get'
  | 'project-rename'
  | 'canvas-put'
  | 'upload'
  | 'jobs-list'
  | 'job-create'
  | 'job-prompt'
  | 'job-stream'
  | 'job-delete'
  | 'topup-create'
  | 'topup-get'
  | 'credit-history'

/** Vietnamese names for the dev UI (request log, fault picker). */
export const DEV_ENDPOINT_LABEL: Record<DevEndpoint, string> = {
  'auth-state': 'Trạng thái đăng nhập',
  me: 'Số dư (/api/me)',
  'video-profiles': 'Cấu hình model',
  'projects-list': 'Danh sách phiên',
  'project-create': 'Tạo phiên',
  'project-get': 'Đọc phiên',
  'project-rename': 'Đổi tên phiên',
  'canvas-put': 'Lưu canvas',
  upload: 'Tải ảnh lên',
  'jobs-list': 'Danh sách job',
  'job-create': 'Tạo job video',
  'job-prompt': 'Prompt của job',
  'job-stream': 'Tải video',
  'job-delete': 'Xoá job',
  'topup-create': 'Tạo đơn nạp',
  'topup-get': 'Trạng thái đơn nạp',
  'credit-history': 'Lịch sử credit',
}

export const DEV_ENDPOINTS = Object.keys(DEV_ENDPOINT_LABEL) as DevEndpoint[]

interface Route {
  methods: string[]
  path: RegExp
  /** Endpoint per method. */
  endpoint: Partial<Record<string, DevEndpoint>>
  query?: string[]
  queryValues?: Record<string, RegExp>
  multipart?: boolean
  binary?: boolean
}

const ROUTES: Route[] = [
  { methods: ['GET'], path: /^\/api\/me$/, endpoint: { GET: 'me' } },
  { methods: ['GET'], path: /^\/api\/auth\/state$/, endpoint: { GET: 'auth-state' } },
  { methods: ['GET'], path: /^\/api\/video-profiles$/, endpoint: { GET: 'video-profiles' } },
  { methods: ['GET', 'POST'], path: /^\/api\/projects$/, endpoint: { GET: 'projects-list', POST: 'project-create' } },
  { methods: ['GET', 'PATCH'], path: new RegExp(`^/api/projects/${ID}$`), endpoint: { GET: 'project-get', PATCH: 'project-rename' } },
  { methods: ['PUT'], path: new RegExp(`^/api/projects/${ID}/canvas$`), endpoint: { PUT: 'canvas-put' } },
  { methods: ['POST'], path: /^\/api\/uploads\/images$/, endpoint: { POST: 'upload' }, multipart: true },
  { methods: ['GET'], path: /^\/api\/video-jobs$/, endpoint: { GET: 'jobs-list' }, query: ['project_id'] },
  { methods: ['POST'], path: /^\/api\/video-jobs$/, endpoint: { POST: 'job-create' } },
  { methods: ['GET'], path: new RegExp(`^/api/video-jobs/${ID}/prompt$`), endpoint: { GET: 'job-prompt' } },
  { methods: ['GET'], path: new RegExp(`^/api/video-jobs/${ID}/stream$`), endpoint: { GET: 'job-stream' }, binary: true },
  { methods: ['DELETE'], path: new RegExp(`^/api/video-jobs/${ID}$`), endpoint: { DELETE: 'job-delete' } },
  { methods: ['POST'], path: /^\/api\/payments\/topups$/, endpoint: { POST: 'topup-create' } },
  { methods: ['GET'], path: new RegExp(`^/api/payments/topups/${ID}$`), endpoint: { GET: 'topup-get' } },
  {
    methods: ['GET'],
    path: /^\/api\/credits\/history$/,
    endpoint: { GET: 'credit-history' },
    query: ['kind', 'offset', 'limit'],
    queryValues: { kind: /^(all|topup|video|refund|adjustment)$/, offset: /^\d{1,6}$/, limit: /^\d{1,3}$/ },
  },
]

export interface RouteMatch {
  endpoint: DevEndpoint
  pathname: string
  query: URLSearchParams
  multipart: boolean
  binary: boolean
}

/** main.cjs matchCanvasappRoute(): the endpoint for an allowed request, or null (main answers 'not-allowed'). */
export function matchDevRoute(method: string, rawPath: unknown): RouteMatch | null {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/api/') || rawPath.length > 300) return null
  let url: URL
  try {
    url = new URL(rawPath, DEV_ORIGIN)
  } catch {
    return null
  }
  if (url.origin !== DEV_ORIGIN || url.hash) return null
  const route = ROUTES.find((r) => r.methods.includes(method) && r.path.test(url.pathname))
  if (!route) return null
  const seen = new Set<string>()
  for (const [key, value] of url.searchParams) {
    if (!(route.query ?? []).includes(key) || seen.has(key)) return null
    seen.add(key)
    const re = route.queryValues?.[key] ?? ID_RE
    if (!re.test(value)) return null
  }
  return { endpoint: route.endpoint[method]!, pathname: url.pathname, query: url.searchParams, multipart: !!route.multipart, binary: !!route.binary }
}
