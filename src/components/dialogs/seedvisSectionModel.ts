import type { SeedvisAccountInfo, SeedvisBridgeErrorCode, SeedvisKeyStatus } from '../../providers/seedvis/contract'

/** 'save-unverified' = "Lưu mà chưa kiểm tra" after a network failure while verifying a pasted / entered key (§10.3). */
export type SeedvisSectionAction = 'paste' | 'enter' | 'save-unverified' | 'check' | 'clear' | 'billing'
export type SeedvisKeyAction = Extract<SeedvisSectionAction, 'paste' | 'enter' | 'save-unverified' | 'clear'>
export type SeedvisPlatform = 'windows' | 'mac' | 'web'
export interface SeedvisSpendingGuard { takes: number; seconds: number }
export const DEFAULT_SEEDVIS_GUARD: Readonly<SeedvisSpendingGuard> = { takes: 10, seconds: 120 }

/**
 * Key-entry outcomes the bridge contract has no code for (§10.3): 403 / `api_enabled: false` and a failed format check
 * (main's `keyFormatOk`). The host maps main's answer onto these.
 */
export type SeedvisSectionErrorCode = SeedvisBridgeErrorCode | 'api-disabled' | 'bad-format'
export interface SeedvisSectionError {
  code: SeedvisSectionErrorCode
  /** SeedvisBridgeFailure.message: main's fixed Vietnamese text, shown instead of the local one. */
  message?: string
  /** The action that failed: a network failure while saving a key offers "Lưu mà chưa kiểm tra". */
  action?: SeedvisSectionAction
}

export const SEEDVIS_CLIPBOARD_NOTE = 'SanoVids chỉ xoá key khỏi clipboard hiện tại. Windows vẫn có thể giữ key trong lịch sử clipboard: bấm Win+V và xoá dòng chứa key (và trên máy khác nếu bạn bật đồng bộ clipboard).'
/** §10.3, shown after a paste once main cleared the clipboard ("có thể": the Windows clipboard history may be off). */
export const SEEDVIS_CLIPBOARD_CLEARED_NOTE = 'Đã xoá key khỏi clipboard. Windows vẫn có thể giữ nó trong lịch sử clipboard: bấm Win+V và xoá dòng đó (và trên máy khác nếu bạn bật đồng bộ clipboard).'
const OTHER_CLIPBOARD_NOTE = 'Nếu dùng ứng dụng lưu hoặc đồng bộ clipboard, hãy xoá dòng chứa key ở đó sau khi dán.'
const OTHER_CLIPBOARD_CLEARED_NOTE = 'Đã xoá key khỏi clipboard. Nếu dùng ứng dụng lưu hoặc đồng bộ clipboard, hãy xoá dòng chứa key ở đó.'
export const SEEDVIS_PRIVACY_NOTE = 'Ảnh tham chiếu được gửi và lưu trên seedvis. API key chỉ được lưu mã hoá trên máy này, không nằm trong dự án hay file xuất cài đặt.'
export const SEEDVIS_FORMAT_HINT = 'Khoá seedvis thường bắt đầu bằng sv_live_.'

/** One clipboard note, never two that repeat each other. */
export function seedvisClipboardNote(platform: SeedvisPlatform, cleared: boolean): string {
  if (platform === 'windows') return cleared ? SEEDVIS_CLIPBOARD_CLEARED_NOTE : SEEDVIS_CLIPBOARD_NOTE
  return cleared ? OTHER_CLIPBOARD_CLEARED_NOTE : OTHER_CLIPBOARD_NOTE
}

const keyHint = (hint: string | null) => hint ? ` …${hint.slice(-4)}` : ''

export function seedvisKeyLabel(status: SeedvisKeyStatus, platform: SeedvisPlatform): string {
  if (platform === 'web') return 'API key seedvis chỉ dùng trong bản desktop.'
  if (status.problem === 'unreadable') return 'Không đọc được khoá đã lưu — dán lại đúng khoá để tiếp tục theo dõi và tải video.'
  if (status.problem === 'unknown') return 'Chưa đọc được trạng thái khoá — thử kiểm tra lại.'
  if (status.storage === 'unavailable') return 'Không có nơi lưu mã hoá an toàn — chưa thể lưu API key.'
  if (!status.hasKey) return 'Chưa lưu API key seedvis.'
  return `Đã lưu${keyHint(status.hint)} · mã hoá bằng ${platform === 'mac' ? 'Keychain' : 'Windows'}${status.verifiedAt === null ? ' · chưa kiểm tra' : ''}`
}

/** A saved key the running takes can use right now: replacing it (a different key) would hold them (§6.9). */
const usableKey = (status: Pick<SeedvisKeyStatus, 'hasKey' | 'problem'>) => status.hasKey && status.problem !== 'unreadable'

/**
 * Confirmation before Xoá key / a different key while seedvis takes run (§6.4e). Pasting with no key saved, or over an
 * unreadable one, is how the user puts the right key back: no confirmation then (seedvisRestoreNote says what to do).
 */
export function seedvisKeyWarning(action: SeedvisKeyAction, activeTakes: number, status: Pick<SeedvisKeyStatus, 'hasKey' | 'hint' | 'problem'>): string | null {
  if (activeTakes <= 0) return null
  if (action !== 'clear' && !usableKey(status)) return null
  const operation = action === 'clear' ? 'Xoá khoá' : 'Đổi sang khoá khác'
  return `${activeTakes} take seedvis đang chạy${status.hint ? ` bằng khoá${keyHint(status.hint)}` : ''}. ${operation} thì SanoVids không theo dõi / tải được chúng cho đến khi bạn dán lại đúng khoá này. Job vẫn có thể tiếp tục và bị trừ credit.`
}

/** Neutral note while takes wait for their key (none saved, or unreadable): the paste that restores it needs no warning. */
export function seedvisRestoreNote(status: Pick<SeedvisKeyStatus, 'hasKey' | 'hint' | 'problem'>, activeTakes: number, platform: SeedvisPlatform): string | null {
  if (platform === 'web' || activeTakes <= 0 || usableKey(status)) return null
  return status.hint
    ? `Dán lại đúng khoá${keyHint(status.hint)} để tiếp tục theo dõi và tải ${activeTakes} take seedvis.`
    : `${activeTakes} take seedvis đang chờ khoá đã gửi chúng — dán lại đúng khoá đó để tiếp tục theo dõi và tải video.`
}

export function seedvisActionBlock(action: SeedvisSectionAction, status: SeedvisKeyStatus, platform: SeedvisPlatform, busy: boolean): string | null {
  if (busy) return 'Đang xử lý — vui lòng đợi.'
  if (platform === 'web') return 'Chỉ có trong bản desktop.'
  if (action === 'billing') return null
  if (action === 'clear') return status.hasKey || status.problem ? null : 'Chưa có khoá để xoá.'
  if (action === 'check') return status.hasKey || status.problem ? null : 'Dán API key trước khi kiểm tra.'
  return status.storage === 'unavailable' ? 'Không có nơi lưu mã hoá an toàn.' : null
}

const ERROR_TEXT: Record<SeedvisSectionErrorCode, string> = {
  'not-allowed': 'Thao tác chưa được cho phép.', 'no-key': 'Chưa lưu API key seedvis.',
  'key-unreadable': 'Không đọc được khoá đã lưu — dán lại đúng khoá.', 'bad-key': 'API key không đúng.',
  'api-disabled': 'Gói không có quyền dùng API.',
  'bad-format': 'Đây không phải API key seedvis hợp lệ (20–200 ký tự: chữ, số, _ hoặc -, không có khoảng trắng).',
  'bad-request': 'Yêu cầu không hợp lệ.', 'too-large': 'Dữ liệu vượt giới hạn.', 'bad-image': 'Ảnh không hợp lệ.',
  'rate-limited': 'seedvis đang giới hạn lượt gọi — thử lại sau.', 'network': 'Không kết nối được seedvis — thử lại sau.',
  'timeout': 'seedvis chưa trả lời kịp — thử kiểm tra lại.', 'deadline': 'Đã hết thời gian gửi yêu cầu.',
  'bad-response': 'Chưa đọc được câu trả lời của seedvis.', 'expired-link': 'Link video đã hết hạn.',
  'offline': 'Máy đang ngoại tuyến.', 'unknown-output': 'Chưa xác định được video trả về.',
  'idempotency-conflict': 'Mã gửi đã được dùng cho yêu cầu khác.', 'busy': 'Đang xử lý — vui lòng đợi.',
  'gone': 'Phiên tải đã kết thúc.', 'too-slow': 'Quá trình tải quá chậm.',
  'storage-unavailable': 'Không có nơi lưu mã hoá an toàn — chưa thể lưu API key.',
  'storage-failed': 'Không lưu hoặc xoá được khoá — kiểm tra lại trạng thái trước khi tiếp tục.',
}
const errorInfo = (error: SeedvisSectionErrorCode | SeedvisSectionError): SeedvisSectionError =>
  typeof error === 'string' ? { code: error } : error

/** Main's fixed text when it sent one, else the section's own; a format error always carries the sv_live_ hint. */
export function seedvisErrorText(error: SeedvisSectionErrorCode | SeedvisSectionError): string {
  const info = errorInfo(error)
  const text = info.message?.trim() || ERROR_TEXT[info.code] || ERROR_TEXT['bad-response']
  return info.code === 'bad-format' && !text.includes('sv_live_') ? `${text} ${SEEDVIS_FORMAT_HINT}` : text
}

const UNVERIFIED_CODES: ReadonlySet<SeedvisSectionErrorCode> = new Set(['network', 'offline', 'timeout'])
/** "Lưu mà chưa kiểm tra" only after the verification of a new key could not reach seedvis (§10.3). */
export function seedvisCanSaveUnverified(error: SeedvisSectionErrorCode | SeedvisSectionError | null | undefined): boolean {
  if (!error) return false
  const info = errorInfo(error)
  return (info.action === 'paste' || info.action === 'enter' || info.action === 'save-unverified') && UNVERIFIED_CODES.has(info.code)
}

export function seedvisAccountRows(account: SeedvisAccountInfo | null, retention?: string): { label: string; value: string }[] {
  const number = (value: number | undefined, unit: string) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? `${value.toLocaleString('vi-VN')} ${unit}` : 'Chưa rõ'
  return [
    { label: 'Gói', value: account?.plan || 'Chưa rõ' },
    { label: 'Quyền dùng API', value: account?.api_enabled === undefined ? 'Chưa rõ' : account.api_enabled ? 'Có' : 'Gói không có quyền dùng API' },
    { label: 'Số dư', value: number(account?.credit_balance, 'credit seedvis') },
    { label: 'Luồng chạy đồng thời', value: number(account?.concurrency_limit, 'luồng') },
    { label: 'Hàng đợi', value: number(account?.queue_limit, 'job') },
    { label: 'Lượt gọi API / phút', value: number(account?.rate_limit_per_minute, 'lượt') },
    { label: 'Lượt kiểm tra job / phút', value: number(account?.poll_rate_limit_per_minute, 'lượt') },
    { label: 'Lượt kiểm tra mỗi job / phút', value: number(account?.poll_rate_limit_per_job_per_minute, 'lượt') },
    { label: 'Thời hạn link video', value: retention || 'Chưa rõ — tuỳ gói seedvis' },
  ]
}

export function seedvisGuardValue(text: string): number | null {
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Committing a spending-guard field (blur / Enter): a valid draft becomes the value, anything else (empty, 0, "1.5")
 * goes back to the last valid value. Keystrokes only edit the draft, so "10" → "" → "5" ends at 5, never 15.
 */
export function seedvisGuardCommit(draft: string, current: number): { value: number; draft: string } {
  const value = seedvisGuardValue(draft.trim()) ?? current
  return { value, draft: String(value) }
}
