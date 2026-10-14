import { SEEDVIS_IPC_ROUTES, type SeedvisIpcRoute } from '../../seedvis/contract'
import { isObj } from '../validate'

export type SeedvisFaultEndpoint = SeedvisIpcRoute | 'download' | '*'
export type SeedvisDevFault =
  | { kind: 'lost-response' | 'offline' | 'oversize' | 'insecure-redirect' | 'expired-link' | 'hold' | 'revoke-key' | 'html-404' | 'not-found' | 'empty-outputs' | 'short-echo' }
  | { kind: 'slow-upload'; bytesPerSecond: number }
  | { kind: 'poll-404'; polls: number }
  | { kind: 'not-started'; afterMs: number }
  /** Refuses the create that meets it (422, slots + queue full) and keeps refusing for forMs (0 = this request only). */
  | { kind: 'slots-full'; forMs: number }
  | { kind: 'response'; status: number; code: string; retryAfterSeconds?: number; format?: 'native' | 'openai' | 'google'; field?: string; afterProcessing?: boolean }
  | { kind: 'fail-job'; code: string }
  | { kind: 'cancel-partial' }
export type SeedvisFaultKind = SeedvisDevFault['kind']

export interface SeedvisFaultInput { endpoint: SeedvisFaultEndpoint; fault: SeedvisDevFault; times?: number; sticky?: boolean }
export interface SeedvisFaultRule extends SeedvisFaultInput { id: string; remaining: number; hits: number }

/** Modifiers shape the job a create makes; they are used up only when a NEW job is created (slow-upload: when a body is uploaded). */
export const SEEDVIS_JOB_MODIFIERS = ['hold', 'not-started', 'poll-404', 'fail-job', 'empty-outputs', 'short-echo'] as const
export const isSeedvisModifier = (kind: SeedvisFaultKind) => kind === 'slow-upload' || (SEEDVIS_JOB_MODIFIERS as readonly string[]).includes(kind)

const DOWNLOAD_OUTCOMES: readonly SeedvisFaultKind[] = ['offline', 'oversize', 'insecure-redirect', 'expired-link', 'lost-response', 'response']
const API_OUTCOMES: readonly SeedvisFaultKind[] = ['offline', 'lost-response', 'response', 'revoke-key', 'html-404', 'not-found']

/** Whether an outcome fault can act on this endpoint. One that cannot never shadows (or uses up) one that can. */
export function seedvisOutcomeApplies(kind: SeedvisFaultKind, endpoint: SeedvisIpcRoute | 'download'): boolean {
  if (endpoint === 'download') return DOWNLOAD_OUTCOMES.includes(kind)
  if (kind === 'slots-full') return endpoint === 'generations.create'
  if (kind === 'cancel-partial') return endpoint === 'generations.cancel'
  return API_OUTCOMES.includes(kind)
}

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\[\d{1,3}\])?$/
const MAX_MS = 30 * 86_400_000
const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max
const ENDPOINTS: readonly string[] = [...Object.keys(SEEDVIS_IPC_ROUTES), 'download', '*']

/**
 * Checks a fault against the same bounds the persisted state enforces, and rebuilds it from the known fields only.
 * A NaN / Infinity time or an over-long code would otherwise reach the saved state and make every later read fail.
 */
export function cleanSeedvisFault(input: unknown): { rule: Omit<SeedvisFaultRule, 'id' | 'hits'> } | null {
  if (!isObj(input) || typeof input.endpoint !== 'string' || !ENDPOINTS.includes(input.endpoint) || !isObj(input.fault)) return null
  if (input.sticky !== undefined && typeof input.sticky !== 'boolean') return null
  if (input.times !== undefined && (typeof input.times !== 'number' || !Number.isFinite(input.times))) return null
  const endpoint = input.endpoint as SeedvisFaultEndpoint
  const f = input.fault
  let fault: SeedvisDevFault
  switch (f.kind) {
    case 'lost-response': case 'offline': case 'oversize': case 'insecure-redirect': case 'expired-link': case 'hold': case 'revoke-key':
    case 'html-404': case 'not-found': case 'empty-outputs': case 'short-echo': case 'cancel-partial':
      fault = { kind: f.kind }
      break
    case 'slow-upload':
      if (typeof f.bytesPerSecond !== 'number' || !Number.isFinite(f.bytesPerSecond) || f.bytesPerSecond < 1 || f.bytesPerSecond > 1e12) return null
      fault = { kind: f.kind, bytesPerSecond: f.bytesPerSecond }
      break
    case 'poll-404':
      if (!int(f.polls, 0, 10_000)) return null
      fault = { kind: f.kind, polls: f.polls }
      break
    case 'not-started':
      if (!int(f.afterMs, 0, MAX_MS)) return null
      fault = { kind: f.kind, afterMs: f.afterMs }
      break
    case 'slots-full':
      if (!int(f.forMs, 0, MAX_MS)) return null
      fault = { kind: f.kind, forMs: f.forMs }
      break
    case 'fail-job':
      if (typeof f.code !== 'string' || !CODE_RE.test(f.code)) return null
      fault = { kind: f.kind, code: f.code }
      break
    case 'response':
      if (!int(f.status, 100, 599) || typeof f.code !== 'string' || !CODE_RE.test(f.code)
        || (f.retryAfterSeconds !== undefined && !int(f.retryAfterSeconds, 0, 86_400))
        || (f.format !== undefined && f.format !== 'native' && f.format !== 'openai' && f.format !== 'google')
        || (f.field !== undefined && (typeof f.field !== 'string' || !FIELD_RE.test(f.field)))
        || (f.afterProcessing !== undefined && typeof f.afterProcessing !== 'boolean')) return null
      fault = { kind: f.kind, status: f.status, code: f.code,
        ...(f.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: f.retryAfterSeconds as number }),
        ...(f.format === undefined ? {} : { format: f.format as 'native' | 'openai' | 'google' }),
        ...(f.field === undefined ? {} : { field: f.field as string }),
        ...(f.afterProcessing === undefined ? {} : { afterProcessing: f.afterProcessing as boolean }) }
      break
    default:
      return null
  }
  // A fault that can never act on its endpoint would sit in the list forever.
  if (endpoint !== '*') {
    const fits = isSeedvisModifier(fault.kind) ? endpoint === 'generations.create' : seedvisOutcomeApplies(fault.kind, endpoint)
    if (!fits) return null
  }
  const sticky = input.sticky === true
  const times = input.times as number | undefined
  return { rule: { endpoint, fault, sticky, ...(times === undefined ? {} : { times }), remaining: sticky ? 0 : Math.min(10_000, Math.max(1, Math.trunc(times ?? 1) || 1)) } }
}

export const SEEDVIS_FAULT_PRESETS: { id: string; label: string; rule: SeedvisFaultInput }[] = [
  { id: 'lost', label: 'Mất câu trả lời sau khi tạo job', rule: { endpoint: 'generations.create', fault: { kind: 'lost-response' } } },
  { id: 'slow', label: 'Tải ảnh lên ở 2 Mbps', rule: { endpoint: 'generations.create', fault: { kind: 'slow-upload', bytesPerSecond: 250_000 } } },
  { id: 'slower', label: 'Lần gửi lại chậm còn một phần tư', rule: { endpoint: 'generations.create', fault: { kind: 'slow-upload', bytesPerSecond: 62_500 } } },
  { id: '404', label: 'Chưa tìm thấy job trong 4 lần hỏi', rule: { endpoint: 'generations.create', fault: { kind: 'poll-404', polls: 4 } } },
  { id: 'hold', label: 'Giữ job trong hàng chờ', rule: { endpoint: 'generations.create', fault: { kind: 'hold' } } },
  { id: 'not-started', label: 'Không bắt đầu sau 2 phút', rule: { endpoint: 'generations.create', fault: { kind: 'not-started', afterMs: 120_000 } } },
  { id: 'slots', label: 'Đầy luồng trong 2 phút', rule: { endpoint: 'generations.create', fault: { kind: 'slots-full', forMs: 120_000 } } },
  { id: 'slots-10min', label: 'Đầy luồng trong 10 phút', rule: { endpoint: 'generations.create', fault: { kind: 'slots-full', forMs: 600_000 } } },
  { id: 'slots-once', label: 'Đầy luồng một lần (422)', rule: { endpoint: 'generations.create', fault: { kind: 'slots-full', forMs: 0 } } },
  { id: 'offline', label: 'Mất mạng', rule: { endpoint: '*', fault: { kind: 'offline' }, sticky: true } },
  { id: 'revoked', label: 'Khoá bị thu hồi khi hỏi job', rule: { endpoint: 'generations.get', fault: { kind: 'revoke-key' } } },
  { id: 'maintenance-page', label: 'Trang bảo trì HTML 404', rule: { endpoint: 'generations.get', fault: { kind: 'html-404' } } },
  { id: 'missing', label: 'JSON không tìm thấy job mãi mãi', rule: { endpoint: 'generations.get', fault: { kind: 'not-found' }, sticky: true } },
  { id: 'oversize', label: 'Video vượt 1 GiB', rule: { endpoint: 'download', fault: { kind: 'oversize' } } },
  { id: 'redirect', label: 'Chuyển hướng tải video sang HTTP', rule: { endpoint: 'download', fault: { kind: 'insecure-redirect' } } },
  { id: 'expired', label: 'Link video hết hạn', rule: { endpoint: 'download', fault: { kind: 'expired-link' } } },
  { id: 'empty', label: 'Job xong nhưng thiếu video', rule: { endpoint: 'generations.create', fault: { kind: 'empty-outputs' } } },
  { id: 'echo', label: 'Thiếu ảnh trong câu trả lời', rule: { endpoint: 'generations.create', fault: { kind: 'short-echo' } } },
  { id: 'partial', label: 'Huỷ một phần, video vẫn đang chạy', rule: { endpoint: 'generations.cancel', fault: { kind: 'cancel-partial' } } },
  { id: 'schema', label: 'Sai tham số (422 validation_error)', rule: { endpoint: 'generations.create', fault: { kind: 'response', status: 422, code: 'validation_error', field: 'prompt' } } },
  ...([
    ['credits', 402, 'insufficient_credits'], ['conflict', 409, 'idempotency_conflict'],
    ['rate', 429, 'rate_limit_exceeded'], ['busy', 503, 'server_busy'], ['maintenance', 503, 'model_maintenance'],
    ['502', 502, 'generation_failed'], ['504', 504, 'timeout'], ['policy', 400, 'content_policy'],
  ] as const).map(([id, status, code]) => ({ id, label: `Giả lập ${status} · ${code}`, rule: { endpoint: 'generations.create' as const, fault: { kind: 'response' as const, status, code, retryAfterSeconds: 2 } } })),
  ...(['insufficient_credits', 'content_policy', 'generation_failed'] as const).map(code => ({ id: `poll-${code}`, label: `Job thất bại · ${code}`, rule: { endpoint: 'generations.create' as const, fault: { kind: 'fail-job' as const, code } } })),
  { id: 'cancel-busy', label: 'Huỷ chưa sẵn sàng, thử sau 2 giây', rule: { endpoint: 'generations.cancel', fault: { kind: 'response', status: 409, code: 'not_cancellable', retryAfterSeconds: 2 } } },
  { id: 'cancel-off', label: 'Dịch vụ huỷ tạm ngừng', rule: { endpoint: 'generations.cancel', fault: { kind: 'response', status: 503, code: 'cancel_unavailable', retryAfterSeconds: 2 } } },
]
