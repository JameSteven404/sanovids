// Plan §7.7 / §12.6. Fixed money texts; case-specific explanations belong in detail.
export const SEEDVIS_UNKNOWN_SUBMIT_ERROR = 'Không rõ yêu cầu đã tới seedvis chưa (có thể đã bị trừ credit).'
export const SEEDVIS_UNVERIFIABLE_SUBMIT_ERROR = 'Không kiểm tra được lần gửi trước của take này nữa — seedvis có thể đã nhận và trừ credit. SanoVids sẽ không gửi lại take này. Xem số dư và lịch sử trên seedvis.com trước khi bấm “Tạo lại” để tạo một take MỚI (nếu lần trước đã bị trừ thì sẽ trừ thêm một lần).'

/** Simulation messages never direct the user to a real wallet or account. */
export function seedvisDevWording(text: string): string {
  return text.replace(/seedvis\.com/g, 'Bảng phát triển › seedvis')
    .replace(/seedvis(?! giả lập)/g, 'seedvis giả lập')
    .replace(/credit(?! dev)/g, 'credit dev')
}

export const SEEDVIS_SUBMIT_TEXT = {
  seedvis: { unknown: SEEDVIS_UNKNOWN_SUBMIT_ERROR, unverifiable: SEEDVIS_UNVERIFIABLE_SUBMIT_ERROR },
  'seedvis-dev': {
    unknown: seedvisDevWording(SEEDVIS_UNKNOWN_SUBMIT_ERROR),
    unverifiable: seedvisDevWording(SEEDVIS_UNVERIFIABLE_SUBMIT_ERROR),
  },
} as const

export const SEEDVIS_TEXT = {
  preSend: 'Chưa gửi gì, không bị trừ credit.',
  contentPolicy: 'seedvis (Dola) từ chối nội dung — sửa prompt hoặc ảnh…',
  keyRequired: 'Khoá API seedvis thiếu hoặc sai — mở Cài đặt › seedvis.com.',
  insufficientCredits: 'Tài khoản seedvis không đủ credit — nạp trên seedvis.com rồi bấm Chạy lại.',
  busy: 'seedvis đang đầy luồng — sẽ tự gửi khi job khác xong (chưa bị trừ).',
  notStarted: 'seedvis chưa bắt đầu job (chờ quá lâu) — không bị trừ credit.',
  cancelled: 'Đã huỷ trên seedvis — đã hoàn credit.',
  pollWaiting: 'seedvis chưa trả lời về job này — SanoVids sẽ hỏi lại',
  emptyOutputs: 'seedvis báo xong nhưng không có file.',
  cancelRequested: 'Đang huỷ…',
  cancelBlocked: 'Không huỷ được — đang tạo',
  fetchable: 'Chờ tải lại',
  cancelTitle: 'Huỷ trên seedvis — chỉ hoàn credit nếu job còn xếp hàng (hiếm); nếu đã bắt đầu tạo thì vẫn bị trừ và video vẫn được tải',
  cancelRunning: 'Job đã chạy ở seedvis — không huỷ được, vẫn bị trừ credit; video vẫn được tải về',
  cancelUnknown: 'Chưa huỷ được trên seedvis — thử lại',
  deleteSending: 'Đang gửi tới seedvis — đợi vài giây rồi xoá',
  noCharge: 'không bị trừ',
  refunded: 'đã hoàn',
  unknownCost: 'không rõ — xem số dư seedvis',
  uncertainCost: 'có thể đã bị trừ',
  fetchableCost: 'đã trả — chưa tải về (Tải lại video)',
  sendCode: 'Mã gửi',
  requestCode: 'Mã yêu cầu',
  retryExpired: 'đã hết thời gian gửi lại an toàn',
  keyMemoryUnknown: 'seedvis chưa xác nhận thời gian nhớ mã',
  retryDownload: 'Tải lại video',
  copyDiagnostics: 'Sao chép thông tin lỗi',
  storedImages: 'ảnh được lưu trên máy chủ seedvis',
  invalidResponse: 'seedvis trả lời không hợp lệ — chưa xác định được trạng thái job.',
} as const

export const seedvisParameterText = (message: string) => `seedvis không nhận tham số: ${message} — chưa bị trừ credit.`
export const seedvisImageText = (slot: string) => `Ảnh ${slot} không dùng được trên seedvis (PNG/JPEG/WebP, ≤ 20 MB) — chưa bị trừ credit.`
export const seedvisImageRuleText = (mode: string, model: string, message: string) => `Số ảnh không hợp với chế độ ${mode} của ${model}: ${message}`
export const seedvisPermissionText = (model: string) => `Gói seedvis hoặc khoá API không có quyền dùng ${model}.`
export const seedvisModelText = (model: string) => `seedvis đang không nhận ${model} (bảo trì hoặc gói chưa mở) — thử lại sau. Chưa bị trừ credit.`
export const seedvisFailureText = (message: string) => `seedvis báo tạo video thất bại: ${message}`
export const seedvisRemoteText = (message: string) => `seedvis: ${message}`
export const seedvisHeldText = (hint: string) => `Take này chạy bằng khoá …${hint} — dán lại khoá đó để tải video`
export const seedvisHeldStatus = (hint: string) => `Chờ khoá …${hint}`
export const seedvisPaidText = (credits: number) => `đã trả ≈ ${credits} credit seedvis`
export const seedvisSafeRetryText = (remainingMs: number) => {
  const seconds = Math.max(0, Math.floor(remainingMs / 1000))
  return `Gửi lại an toàn trong ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
export const seedvisDeletePaidText = (who: string) => `${who} đã tạo xong trên seedvis và đã trừ credit — SanoVids chưa tải về xong. Xoá sẽ bỏ video đó trong SanoVids; seedvis không cho tìm lại job qua API (xem lịch sử trên seedvis.com); chạy lại cảnh sẽ trừ credit lần nữa.`
export const seedvisDownloadFailedText = (why: string, days?: number) => `Video đã tạo xong trên seedvis (đã trừ credit) nhưng SanoVids chưa tải về được: ${why} Bấm “Tải lại video” — link còn dùng được đến khi hết hạn lưu của gói seedvis${days === undefined ? '' : ` (gói của bạn: ${days} ngày)`}. Đừng bấm Chạy lại: sẽ trừ credit lần nữa.`
export const seedvisExpiredLinkText = (days?: number) => `Link video trên seedvis đã hết hạn (${days === undefined ? 'theo gói' : `gói giữ ${days} ngày`}) — SanoVids không tải về được nữa.`
export const seedvisNotFoundText = (id: string) => `seedvis không còn tìm thấy job …${id.slice(0, 8)} — có thể đã bị trừ credit. Xem lịch sử trên seedvis.com trước khi chạy lại.`
export const seedvisEchoText = (received: number, sent: number) => `seedvis báo đã nhận ${received}/${sent} ảnh — xem lại video`
export const seedvisDownscaleText = (slots: readonly string[]) => `Đã thu nhỏ ${slots.length} ảnh (${slots.join(', ')}) để vừa giới hạn seedvis`
export const seedvisFormatText = (slot: string, format: string) => `Ảnh ${slot} là ${format} — seedvis chỉ nhận PNG/JPEG/WebP. ${SEEDVIS_TEXT.preSend}`
