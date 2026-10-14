import type { SeedvisModelId } from '../../core/services'
import type { SeedvisImageField, SeedvisImageMime, SeedvisRatio } from '../../core/seedvisRoutes'

export { SEEDVIS_ROUTE_TABLE, SEEDVIS_IMAGE_LIMITS } from '../../core/seedvisRoutes'
export type { SeedvisRemoteModel, SeedvisRemoteMode, SeedvisRouteSpec } from '../../core/seedvisRoutes'

// Plan §14. Changes require Claude review and the M5 simulation checks.
// No same-key re-send until seedvis confirms its key memory in writing.
export const SEEDVIS_KEY_MEMORY_MS: number | null = null
export const SEEDVIS_SAME_KEY_MARGIN_MS = 20_000
export const SEEDVIS_RESEND_SCHEDULE_MS = [15_000, 45_000, 90_000] as const
export const SEEDVIS_ANSWER_WAIT_MS = 45_000
export const SEEDVIS_ECHO_AUTOCANCEL = false

export interface SeedvisPriceRow {
  model: SeedvisModelId
  duration: number
  upscale?: 'none' | '1080p'
  credits: number
}

export type SeedvisPriceReference =
  | { measuredAt: null; source: null; rows: readonly [] }
  | { measuredAt: string; source: 'live-test' | 'support' | 'site'; rows: readonly SeedvisPriceRow[] }

// No measurements yet: neither a date, a source nor a price is invented.
export const SEEDVIS_PRICE_REFERENCE: SeedvisPriceReference = { measuredAt: null, source: null, rows: [] }

export const SEEDVIS_ORIGIN = 'https://seedvis.com'
export const SEEDVIS_API_BASE = '/api/v1'

// Symbolic routes only. Main constructs paths, including the fixed wait=0 query.
export const SEEDVIS_IPC_ROUTES = {
  models: { method: 'GET', path: '/models' },
  'account.info': { method: 'GET', path: '/account/info' },
  'account.usage': { method: 'GET', path: '/account/usage' },
  'generations.create': { method: 'POST', path: '/developer/generations' },
  'generations.get': { method: 'GET', path: '/developer/generations/{id}?wait=0' },
  'generations.cancel': { method: 'POST', path: '/developer/generations/{id}/cancel' },
} as const
export type SeedvisIpcRoute = keyof typeof SEEDVIS_IPC_ROUTES

export const SEEDVIS_RESPONSE_HEADERS = ['Retry-After', 'Idempotency-Replayed', 'X-Request-Id'] as const
export type SeedvisResponseHeaders = Partial<Record<typeof SEEDVIS_RESPONSE_HEADERS[number], string>>

// Plan §10: separate image/base64 limits are in SEEDVIS_IMAGE_LIMITS.
export const SEEDVIS_IPC_LIMITS = {
  bodyBytes: 256 * 1024, jsonBytes: 2 * 1024 * 1024,
  videoBytes: 1024 * 1024 * 1024, imageBytes: 50 * 1024 * 1024,
  chunkBytes: 4 * 1024 * 1024, inFlightBytes: 64 * 1024 * 1024,
  promptChars: 20_000, idChars: 100, pathChars: 300,
} as const

// Body excludes image fields. Main adds base64/file_name from the separate byte payload.
export type SeedvisGenerationBody = {
  prompt: string
  count: 1
} & (
  | {
    model: 'seedance_2.5'; mode: 'text-to-video' | 'image-to-video'
    aspect_ratio: SeedvisRatio; duration: 5 | 10 | 15 | 20 | 25 | 30
  }
  | {
    model: 'seedance_2.0_fast'; mode: 'text-to-video' | 'image-to-video'
    aspect_ratio: SeedvisRatio; duration: 5 | 10 | 15
  }
  | {
    model: 'Veo-3.1'; mode: 'text-to-video' | 'image-to-video' | 'multi-image-to-video' | 'batch-frame'
    aspect_ratio: '16:9' | '9:16'; duration: '4s' | '6s' | '8s'; upscale_video: 'none' | '1080p'
  }
)

export interface SeedvisRequestImage {
  field: SeedvisImageField
  /** Zero-based within an array field; 0 for image / lastFrame. */
  index: number
  mime: SeedvisImageMime
  bytes: Uint8Array
}

export type SeedvisRequest =
  | { route: 'models' | 'account.info' | 'account.usage' }
  | { route: 'generations.get' | 'generations.cancel'; id: string }
  | {
    route: 'generations.create'
    idempotencyKey: string
    body: SeedvisGenerationBody
    images?: readonly SeedvisRequestImage[]
    /** Client epoch milliseconds: main aborts an incomplete upload at this deadline. */
    mustFinishBy?: number
  }

export type SeedvisBridgeErrorCode =
  | 'not-allowed' | 'no-key' | 'key-unreadable' | 'bad-key' | 'bad-request'
  | 'too-large' | 'bad-image' | 'rate-limited' | 'network' | 'timeout' | 'deadline'
  | 'bad-response' | 'expired-link' | 'offline' | 'unknown-output' | 'idempotency-conflict'
  | 'busy' | 'gone' | 'too-slow' | 'storage-unavailable' | 'storage-failed'

export interface SeedvisBridgeFailure {
  ok: false
  code: SeedvisBridgeErrorCode
  /** Fixed Vietnamese text, never raw exceptions or secrets. */
  message: string
  retryAfterMs?: number
  /** Whether the complete body may have reached seedvis; omitted when not applicable. */
  sent?: boolean
  lastByteAt?: number | null
}

export type SeedvisResponse = {
  ok: true
  status: number
  /** Untrusted API data: consumers must parse it, not cast it to a trusted job/account. */
  json?: unknown
  headers: SeedvisResponseHeaders
  lastByteAt?: number | null
  uploadMs?: number
} | SeedvisBridgeFailure

export interface SeedvisKeyStatus {
  hasKey: boolean
  hint: string | null
  /** Per-install salted HMAC tag, never a bare hash or the key itself. */
  tag: string | null
  savedAt: number | null
  verifiedAt: number | null
  storage: 'safeStorage' | 'unavailable'
  problem?: 'unknown' | 'unreadable'
}

// Explicit allowlist, no account id/email. Retention fields await live verification (§19).
export const SEEDVIS_ACCOUNT_INFO_FIELDS = [
  'plan', 'api_enabled', 'credit_balance', 'concurrency_limit', 'queue_limit',
  'rate_limit_per_minute', 'poll_rate_limit_per_minute', 'poll_rate_limit_per_job_per_minute',
] as const
export type SeedvisAccountInfo = Partial<{
  plan: string
  api_enabled: boolean
  credit_balance: number
  concurrency_limit: number
  queue_limit: number
  rate_limit_per_minute: number
  poll_rate_limit_per_minute: number
  poll_rate_limit_per_job_per_minute: number
}>

export type SeedvisRemoteStatus = 'queued' | 'processing' | 'completed' | 'failed'
// Known codes from §7.7. Parsers must preserve other remote codes without promising a refund.
export type SeedvisKnownRemoteCode =
  | 'invalid_value' | 'validation_error' | 'invalid_image' | 'image_rule' | 'content_policy'
  | 'reference_image_missing' | 'invalid_request' | 'insufficient_credits' | 'model_not_found'
  | 'model_maintenance' | 'idempotency_conflict' | 'server_busy' | 'generation_failed'
  | 'server_error' | 'timeout' | 'not_started' | 'cancelled' | 'not_cancellable' | 'cancel_unavailable'

export interface SeedvisDownloadArgs { generationId: string; index: number }
export type SeedvisDownloadOpen =
  | { ok: true; id: string; total: number | null; mime: 'video/mp4' | 'video/quicktime' | 'video/webm' }
  | SeedvisBridgeFailure
export type SeedvisDownloadRead =
  | { ok: true; done: false; bytes: Uint8Array }
  | { ok: true; done: true }
  | SeedvisBridgeFailure
export type SeedvisActionResult = { ok: true } | SeedvisBridgeFailure
export type SeedvisKeyResult = { ok: true; status: SeedvisKeyStatus } | SeedvisBridgeFailure

/**
 * Contract only; main/transport/simulation implement it in later tracks. No key is ever returned.
 * `unverified: true` (A1, plan §10.3) = "Lưu mà chưa kiểm tra": save without GET /account/info, offered only after a
 * key check failed with code 'network' (main never skips the check on its own). Main accepts it only for that same
 * key (the clipboard / field must still hold it) within 2 minutes; otherwise 'bad-key' and nothing is saved.
 */
export interface SeedvisBridge {
  keyStatus(): Promise<SeedvisKeyStatus>
  pasteKey(args?: { unverified?: boolean }): Promise<SeedvisKeyResult>
  setKey(args: { key: string; unverified?: boolean }): Promise<SeedvisKeyResult>
  clearKey(): Promise<SeedvisKeyResult>
  request(args: SeedvisRequest): Promise<SeedvisResponse>
  downloadOpen(args: SeedvisDownloadArgs): Promise<SeedvisDownloadOpen>
  downloadRead(args: { id: string }): Promise<SeedvisDownloadRead>
  downloadClose(args: { id: string }): Promise<SeedvisActionResult>
  isOnline(): Promise<boolean>
  openBilling(): Promise<SeedvisActionResult>
}
