import type { SeedvisAccountInfo, SeedvisBridgeErrorCode, SeedvisKeyStatus } from '../../providers/seedvis/contract'

export type SeedvisSectionAction = 'paste' | 'enter' | 'check' | 'clear' | 'billing'
export type SeedvisKeyAction = Extract<SeedvisSectionAction, 'paste' | 'enter' | 'clear'>
export type SeedvisPlatform = 'windows' | 'mac' | 'web'
export interface SeedvisSpendingGuard { takes: number; seconds: number }
export const DEFAULT_SEEDVIS_GUARD: Readonly<SeedvisSpendingGuard> = { takes: 10, seconds: 120 }

export const SEEDVIS_CLIPBOARD_NOTE = 'SanoVids chỉ xoá key khỏi clipboard hiện tại. Windows vẫn có thể giữ key trong lịch sử clipboard: bấm Win+V và xoá dòng chứa key (và trên máy khác nếu bạn bật đồng bộ clipboard).'
export const SEEDVIS_PRIVACY_NOTE = 'Ảnh tham chiếu được gửi và lưu trên seedvis. API key chỉ được lưu mã hoá trên máy này, không nằm trong dự án hay file xuất cài đặt.'

export function seedvisKeyLabel(status: SeedvisKeyStatus, platform: SeedvisPlatform): string {
  if (platform === 'web') return 'API key seedvis chỉ dùng trong bản desktop.'
  if (status.problem === 'unreadable') return 'Không đọc được khoá đã lưu — dán lại đúng khoá để tiếp tục theo dõi và tải video.'
  if (status.problem === 'unknown') return 'Chưa đọc được trạng thái khoá — thử kiểm tra lại.'
  if (status.storage === 'unavailable') return 'Không có nơi lưu mã hoá an toàn — chưa thể lưu API key.'
  if (!status.hasKey) return 'Chưa lưu API key seedvis.'
  const hint = status.hint ? ` …${status.hint.slice(-4)}` : ''
  return `Đã lưu${hint} · mã hoá bằng ${platform === 'mac' ? 'Keychain' : 'Windows'}${status.verifiedAt === null ? ' · chưa kiểm tra' : ''}`
}

export function seedvisKeyWarning(action: SeedvisKeyAction, activeTakes: number, hint: string | null): string | null {
  if (activeTakes <= 0) return null
  const operation = action === 'clear' ? 'Xoá khoá' : 'Đổi sang khoá khác'
  return `${activeTakes} take seedvis đang chạy${hint ? ` bằng khoá …${hint.slice(-4)}` : ''}. ${operation} thì SanoVids không theo dõi / tải được chúng cho đến khi bạn dán lại đúng khoá này. Job vẫn có thể tiếp tục và bị trừ credit.`
}

export function seedvisActionBlock(action: SeedvisSectionAction, status: SeedvisKeyStatus, platform: SeedvisPlatform, busy: boolean): string | null {
  if (busy) return 'Đang xử lý — vui lòng đợi.'
  if (platform === 'web') return 'Chỉ có trong bản desktop.'
  if (action === 'billing') return null
  if (action === 'clear') return status.hasKey || status.problem ? null : 'Chưa có khoá để xoá.'
  if (action === 'check') return status.hasKey || status.problem ? null : 'Dán API key trước khi kiểm tra.'
  return status.storage === 'unavailable' ? 'Không có nơi lưu mã hoá an toàn.' : null
}

const ERROR_TEXT: Record<SeedvisBridgeErrorCode, string> = {
  'not-allowed': 'Thao tác chưa được cho phép.', 'no-key': 'Chưa lưu API key seedvis.',
  'key-unreadable': 'Không đọc được khoá đã lưu — dán lại đúng khoá.', 'bad-key': 'API key không đúng.',
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
export const seedvisErrorText = (code: SeedvisBridgeErrorCode): string => ERROR_TEXT[code]

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
