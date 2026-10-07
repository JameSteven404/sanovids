import type { SeedvisIpcRoute } from '../../seedvis/contract'

export type SeedvisFaultEndpoint = SeedvisIpcRoute | 'download' | '*'
export type SeedvisDevFault =
  | { kind: 'lost-response' | 'offline' | 'oversize' | 'insecure-redirect' | 'expired-link' | 'hold' | 'revoke-key' | 'html-404' | 'not-found' | 'empty-outputs' | 'short-echo' }
  | { kind: 'slow-upload'; bytesPerSecond: number }
  | { kind: 'poll-404'; polls: number }
  | { kind: 'not-started'; afterMs: number }
  | { kind: 'slots-full'; forMs: number }
  | { kind: 'response'; status: number; code: string; retryAfterSeconds?: number; format?: 'native' | 'openai' | 'google'; field?: string; afterProcessing?: boolean }
  | { kind: 'fail-job'; code: string }
  | { kind: 'cancel-partial' }

export interface SeedvisFaultInput { endpoint: SeedvisFaultEndpoint; fault: SeedvisDevFault; times?: number; sticky?: boolean }
export interface SeedvisFaultRule extends SeedvisFaultInput { id: string; remaining: number }

export const SEEDVIS_FAULT_PRESETS: { id: string; label: string; rule: SeedvisFaultInput }[] = [
  { id: 'lost', label: 'Mất câu trả lời sau khi tạo job', rule: { endpoint: 'generations.create', fault: { kind: 'lost-response' } } },
  { id: 'slow', label: 'Tải ảnh lên ở 2 Mbps', rule: { endpoint: 'generations.create', fault: { kind: 'slow-upload', bytesPerSecond: 250_000 } } },
  { id: 'slower', label: 'Lần gửi lại chậm còn một phần tư', rule: { endpoint: 'generations.create', fault: { kind: 'slow-upload', bytesPerSecond: 62_500 } } },
  { id: '404', label: 'Chưa tìm thấy job trong 4 lần hỏi', rule: { endpoint: 'generations.create', fault: { kind: 'poll-404', polls: 4 } } },
  { id: 'hold', label: 'Giữ job trong hàng chờ', rule: { endpoint: 'generations.create', fault: { kind: 'hold' } } },
  { id: 'not-started', label: 'Không bắt đầu sau 2 phút', rule: { endpoint: 'generations.create', fault: { kind: 'not-started', afterMs: 120_000 } } },
  { id: 'slots', label: 'Đầy luồng trong 2 phút', rule: { endpoint: 'generations.create', fault: { kind: 'slots-full', forMs: 120_000 } } },
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
  ...([
    ['credits', 402, 'insufficient_credits'], ['conflict', 409, 'idempotency_conflict'], ['slots-once', 422, 'validation_error'],
    ['rate', 429, 'rate_limit_exceeded'], ['busy', 503, 'server_busy'], ['maintenance', 503, 'model_maintenance'],
    ['502', 502, 'generation_failed'], ['504', 504, 'timeout'], ['policy', 400, 'content_policy'],
  ] as const).map(([id, status, code]) => ({ id, label: `Giả lập ${status} · ${code}`, rule: { endpoint: 'generations.create' as const, fault: { kind: 'response' as const, status, code, retryAfterSeconds: 2 } } })),
  ...(['insufficient_credits', 'content_policy', 'generation_failed'] as const).map(code => ({ id: `poll-${code}`, label: `Job thất bại · ${code}`, rule: { endpoint: 'generations.create' as const, fault: { kind: 'fail-job' as const, code } } })),
  { id: 'cancel-busy', label: 'Huỷ chưa sẵn sàng, thử sau 2 giây', rule: { endpoint: 'generations.cancel', fault: { kind: 'response', status: 409, code: 'not_cancellable', retryAfterSeconds: 2 } } },
  { id: 'cancel-off', label: 'Dịch vụ huỷ tạm ngừng', rule: { endpoint: 'generations.cancel', fault: { kind: 'response', status: 503, code: 'cancel_unavailable', retryAfterSeconds: 2 } } },
]
