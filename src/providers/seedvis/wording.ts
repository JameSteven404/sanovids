// Plan §7.7 / §12.6 (+ §6.4, §6.10, §7.3, §7.4). Fixed money texts; case-specific explanations belong in detail.
export const SEEDVIS_UNKNOWN_SUBMIT_ERROR = 'Không rõ yêu cầu đã tới seedvis chưa (có thể đã bị trừ credit).'
export const SEEDVIS_UNVERIFIABLE_SUBMIT_ERROR = 'Không kiểm tra được lần gửi trước của take này nữa — seedvis có thể đã nhận và trừ credit. SanoVids sẽ không gửi lại take này. Xem số dư và lịch sử trên seedvis.com trước khi bấm “Tạo lại” để tạo một take MỚI (nếu lần trước đã bị trừ thì sẽ trừ thêm một lần).'

// Simulation words (§7.8 / §11.1 / §13): site "seedvis giả lập", unit "credit dev seedvis", and the Dev panel tab
// "Bảng phát triển › seedvis giả lập" instead of Settings or seedvis.com. One pass, longest phrase first, and every
// replacement maps to itself on a second pass, so the function is idempotent.
const DEV_WORDS: Readonly<Record<string, string>> = {
  'mở Cài đặt › seedvis.com': 'mở Bảng phát triển › seedvis giả lập',
  'trên seedvis.com': 'trong Bảng phát triển › seedvis giả lập',
  'seedvis.com': 'Bảng phát triển › seedvis giả lập',
  'credit dev seedvis': 'credit dev seedvis',
  'credit seedvis': 'credit dev seedvis',
  'seedvis giả lập': 'seedvis giả lập',
  'credit dev': 'credit dev',
  seedvis: 'seedvis giả lập',
  credit: 'credit dev',
}
const DEV_ALTERNATIVES = Object.keys(DEV_WORDS)
  .sort((a, b) => b.length - a.length)
  .map(word => word.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&'))
  .join('|')
// Whole words only ("credits" in a server message stays as it is).
const DEV_RE = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${DEV_ALTERNATIVES})(?![\\p{L}\\p{N}_])`, 'gu')

/** Simulation messages never direct the user to a real wallet, account or Settings path. */
export function seedvisDevWording(text: string): string {
  return text.replace(DEV_RE, word => DEV_WORDS[word] ?? word)
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
  /** §7.3 step 8: the body was not fully uploaded (`sent: false`). */
  uploadIncomplete: 'Mạng chậm hoặc mất khi đang tải ảnh lên seedvis — chưa gửi gì, không bị trừ credit.',
  /** §7.3 step 6: take note while the automatic same-key re-sends run. */
  resending: 'Mất kết nối lúc gửi — SanoVids đang gửi lại cùng mã (an toàn, seedvis trả lại job cũ nếu đã nhận)',
  /** §7.4: creditText variant of "SanoVids tìm job cũ trước khi gửi lại". */
  resendSameKey: 'gửi lại cùng mã — seedvis trả lại job cũ nếu còn nhớ mã',
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
  /** detail of a 2xx submit answer that holds no readable job (the take stays uncertain). */
  invalidResponse: 'seedvis trả lời không hợp lệ — chưa xác định được trạng thái job.',
  /** A refusal or a failed job without any message. */
  noReason: 'seedvis báo lỗi nhưng không nói lý do.',
  /** §6.10 grouped toast button, §6.4 (c) refusal button. */
  rerunAll: 'Chạy lại tất cả',
  openProject: 'Mở dự án',
} as const

/** "<problem> Chưa gửi gì, không bị trừ credit." — unless the problem already states the money fact. */
export function withPreSend(problem: string): string {
  const bare = problem.trim()
  if (/(?:chưa|không) bị trừ/i.test(bare)) return bare
  return `${/[.…!?]$/.test(bare) ? bare : `${bare}.`} ${SEEDVIS_TEXT.preSend}`
}

/**
 * A refusal decided before anything was sent. `message` (= `problem`) is the bare reason and never claims anything
 * about money; `text` adds "Chưa gửi gì, không bị trừ credit." The adapter shows `text` only when nothing was ever
 * sent with this take's key: a same-key re-send reuses the stored body and bytes (M2) and is never rebuilt with a
 * newer (narrowed) spec, so a rebuild that throws must not tell the user the take was free.
 */
export class SeedvisPreSendError extends Error {
  readonly problem: string
  readonly text: string
  constructor(problem: string) {
    super(problem)
    this.name = 'SeedvisPreSendError'
    this.problem = problem
    this.text = withPreSend(problem)
  }
}

const imageRule = (slot: string) => `Ảnh ${slot} không dùng được trên seedvis (PNG/JPEG/WebP, ≤ 20 MB)`
/** Pre-send (bare, see SeedvisPreSendError). */
export const seedvisImageProblem = (slot: string) => `${imageRule(slot)}.`
/** seedvis answered 400 invalid_image. */
export const seedvisImageText = (slot: string) => `${imageRule(slot)} — chưa bị trừ credit.`
export const seedvisParameterText = (message: string) => message.trim()
  ? `seedvis không nhận tham số: ${message.trim()} — chưa bị trừ credit.`
  : 'seedvis không nhận tham số — chưa bị trừ credit.'
export const seedvisImageRuleText = (mode: string, model: string, message: string) => message.trim()
  ? `Số ảnh không hợp với chế độ ${mode} của ${model}: ${message.trim()}`
  : `Số ảnh không hợp với chế độ ${mode} của ${model}.`
export const seedvisPermissionText = (model: string) => `Gói seedvis hoặc khoá API không có quyền dùng ${model}.`
export const seedvisModelText = (model: string) => `seedvis đang không nhận ${model} (bảo trì hoặc gói chưa mở) — thử lại sau. Chưa bị trừ credit.`
/** Settings issue (rule 9 / editor) for a model a /models read does not list. */
export const seedvisModelOffText = (model: string) => `seedvis hiện không nhận ${model} (bảo trì hoặc gói chưa mở).`
export const seedvisFailureText = (message: string) => message.trim()
  ? `seedvis báo tạo video thất bại: ${message.trim()}`
  : 'seedvis báo tạo video thất bại.'
export const seedvisRemoteText = (message: string) => message.trim() ? `seedvis: ${message.trim()}` : SEEDVIS_TEXT.noReason
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
/** Pre-send (bare); with SeedvisPreSendError.text it reads "… PNG/JPEG/WebP. Chưa gửi gì, không bị trừ credit." */
export const seedvisFormatText = (slot: string, format: string) => `Ảnh ${slot} là ${format} — seedvis chỉ nhận PNG/JPEG/WebP.`

// §7.4 rerunTake confirmations ({take} = the take's label).
export const seedvisRerunSameKeyText = (take: string) => `${take}: không rõ lần gửi trước đã tới seedvis chưa. SanoVids gửi lại NGAY với CÙNG mã: nếu seedvis đã nhận, nó trả lại đúng job đó, không trừ lần hai. Gửi lại?`
export const seedvisRerunNewTakeText = (take: string) => `${take}: SanoVids không kiểm tra được lần gửi trước — seedvis có thể đã nhận và trừ credit, và seedvis không cho tra job theo mã. Trước khi tạo lại, xem số dư và lịch sử trên seedvis.com: video có thể đã có ở đó. “Tạo lại” tạo một take MỚI (xem chi phí trước khi gửi); nếu lần trước đã bị trừ thì lần này trừ thêm. Tạo lại?`
/** §6.10 grouped toast (button SEEDVIS_TEXT.rerunAll). */
export const seedvisNotStartedGroupText = (scenes: number) => `${scenes} cảnh seedvis chưa bắt đầu (không bị trừ credit)`
/** §6.4 (b) a take deleted while its POST was in flight; only the two outcomes the plan words. */
export const seedvisOrphanText = (remoteId: string, outcome: 'refunded' | 'running') =>
  `Một take bị xoá lúc đang gửi: job seedvis …${remoteId.slice(0, 8)} ${outcome === 'refunded' ? 'đã huỷ, đã hoàn credit' : 'vẫn chạy và bị trừ credit'}`
/** §6.4 (c) project delete refused (button SEEDVIS_TEXT.openProject). */
export const seedvisProjectBusyText = (takes: number) => `Dự án còn ${takes} take seedvis chưa xong — mở dự án, huỷ hoặc đợi xong rồi xoá`
/** §6.4 (e) removing / replacing the API key while seedvis takes run. */
export const seedvisKeyInUseText = (takes: number, hint: string) => `${takes} take seedvis đang chạy bằng khoá …${hint} — xoá thì SanoVids không theo dõi / tải được chúng cho đến khi bạn dán lại đúng khoá này`
