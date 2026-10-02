// In-app top-up of the user's OWN canvasapp.io.vn credits — pure rules (docs/SPEC-v2.md §10).
//
// SanoVids never sees, asks for or types bank/card data. It only asks canvasapp to create a top-up order, opens the
// checkout page canvasapp returns (SePay, real page, in a modal window of the desktop app — electron/main.cjs
// 'canvasapp:checkout') and then reads the order status back from canvasapp. Payments are never auto-confirmed.
//
// ---- API ----
//   TOPUP_PRESETS                        [30000, 50000, 100000, 200000] (VND).
//   TOPUP_MIN_VND / TOPUP_MAX_VND / TOPUP_STEP_VND   10.000 / 10.000.000 / 1.000.
//   TOPUP_VND_PER_CREDIT                 1.000 (credits = amount / 1.000).
//   TOPUP_ORDER_TTL_MS                   10 min: an order not paid by then expires on canvasapp.
//   TOPUP_POLL_MS                        2 s: status poll period after returning from checkout (canvasapp's own page
//                                        polls every 2 s for up to 2 min — TOPUP_POLL_MAX_MS).
//   TOPUP_HISTORY_KINDS                  'all' | 'topup' | 'video' | 'refund' | 'adjustment' (+ Vietnamese labels).
//   validateTopupAmount(input)           string | number → { ok, amount, credits, error }. Accepts "50000", "50.000",
//                                        "50,000", "50 000", "50k", "1,5tr", "50.000đ". amount = parsed VND (null
//                                        when unreadable), credits = only when ok, error = Vietnamese text or null.
//   creditsForAmount(vnd)                50000 → 50.
//   formatVnd(vnd)                       50000 → "50.000đ" (takes đồng; lib/credits formatVnd takes CREDITS).
//   mapTopupStatus(status)               canvasapp order status → { phase, label, final }.
//   checkoutUrlAllowed(url)              https + hostname sepay.vn / *.sepay.vn, no userinfo / port / odd chars.
//   parsePaymentReturn(url)              https://canvasapp.io.vn/…?payment=success|cancel|error&topup_order=<id>
//                                        → { result, orderId } | null.
// electron/main.cjs duplicates checkoutUrlAllowed / parsePaymentReturn in CJS (main never trusts the renderer):
// keep both copies in sync.

export const TOPUP_PRESETS: readonly number[] = [30_000, 50_000, 100_000, 200_000]
export const TOPUP_MIN_VND = 10_000
export const TOPUP_MAX_VND = 10_000_000
export const TOPUP_STEP_VND = 1_000
export const TOPUP_VND_PER_CREDIT = 1_000
export const TOPUP_ORDER_TTL_MS = 10 * 60_000
export const TOPUP_POLL_MS = 2_000
export const TOPUP_POLL_MAX_MS = 2 * 60_000

export const CHECKOUT_HOST_SUFFIX = 'sepay.vn'
export const CANVASAPP_HOST = 'canvasapp.io.vn'

export type TopupHistoryKind = 'all' | 'topup' | 'video' | 'refund' | 'adjustment'
export const TOPUP_HISTORY_KINDS: readonly TopupHistoryKind[] = ['all', 'topup', 'video', 'refund', 'adjustment']
export const TOPUP_HISTORY_KIND_LABEL: Record<TopupHistoryKind, string> = {
  all: 'Tất cả',
  topup: 'Nạp',
  video: 'Tạo video',
  refund: 'Hoàn',
  adjustment: 'Điều chỉnh',
}
export const isTopupHistoryKind = (k: unknown): k is TopupHistoryKind => typeof k === 'string' && (TOPUP_HISTORY_KINDS as readonly string[]).includes(k)

// ---------------------------------------------------------------------------------------------
// Amount
// ---------------------------------------------------------------------------------------------

export interface TopupAmountCheck {
  ok: boolean
  /** Parsed amount in VND; null when the input could not be read as a whole number. */
  amount: number | null
  /** amount / 1.000 — only when ok. */
  credits: number | null
  /** Vietnamese explanation when not ok. */
  error: string | null
}

const group = (n: number) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

/** 50000 → "50.000đ". Not a finite number → "—". */
export function formatVnd(vnd: number | null | undefined): string {
  if (typeof vnd !== 'number' || !Number.isFinite(vnd)) return '—'
  const r = Math.round(vnd)
  return `${r < 0 ? '-' : ''}${group(Math.abs(r))}đ`
}

/** Credits added by a top-up of `vnd` đồng (1 credit = 1.000đ, rounded down). */
export function creditsForAmount(vnd: number): number {
  if (!Number.isFinite(vnd) || vnd <= 0) return 0
  return Math.floor(vnd / TOPUP_VND_PER_CREDIT)
}

const MSG = {
  empty: 'Nhập số tiền muốn nạp.',
  invalid: 'Số tiền không hợp lệ — chỉ nhập số, ví dụ 50.000 hoặc 50k.',
  min: `Tối thiểu ${formatVnd(TOPUP_MIN_VND)}.`,
  max: `Tối đa ${formatVnd(TOPUP_MAX_VND)} mỗi lần nạp.`,
  step: `Số tiền phải là bội số của ${formatVnd(TOPUP_STEP_VND)}.`,
}

/** Whole number from user text, or null. See validateTopupAmount for the accepted forms. */
function parseAmount(raw: string): number | null {
  let s = raw.normalize('NFC').toLowerCase().replace(/[\s ]+/g, '')
  s = s.replace(/(vnđ|vnd|đồng|đ|d)$/, '')
  if (!s) return null
  // "50k", "1,5k", "1.5tr", "2triệu", "2m"
  const unit = /^(\d+)(?:[.,](\d{1,3}))?(k|nghìn|ngàn|tr|triệu|m)$/.exec(s)
  if (unit) {
    const mult = unit[3] === 'k' || unit[3] === 'nghìn' || unit[3] === 'ngàn' ? 1_000 : 1_000_000
    const frac = unit[2] ?? ''
    const value = Number(unit[1]) * mult + (frac ? Math.round((Number(frac) / 10 ** frac.length) * mult) : 0)
    return Number.isSafeInteger(value) ? value : null
  }
  // "50000", "50.000", "50,000", "10.000.000" (separators must group exactly 3 digits)
  if (/^\d+$/.test(s) || /^\d{1,3}(\.\d{3})+$/.test(s) || /^\d{1,3}(,\d{3})+$/.test(s)) {
    const value = Number(s.replace(/[.,]/g, ''))
    return Number.isSafeInteger(value) ? value : null
  }
  return null
}

/** Validate a top-up amount typed by the user (or a preset number). Integer VND, 10.000–10.000.000, step 1.000. */
export function validateTopupAmount(input: string | number | null | undefined): TopupAmountCheck {
  const fail = (error: string, amount: number | null = null): TopupAmountCheck => ({ ok: false, amount, credits: null, error })
  let amount: number | null
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return fail(MSG.invalid)
    if (!Number.isInteger(input)) return fail(MSG.invalid)
    amount = input
  } else {
    if (input == null || !String(input).trim()) return fail(MSG.empty)
    amount = parseAmount(String(input))
    if (amount === null) return fail(MSG.invalid)
  }
  if (amount < TOPUP_MIN_VND) return fail(MSG.min, amount)
  if (amount > TOPUP_MAX_VND) return fail(MSG.max, amount)
  if (amount % TOPUP_STEP_VND !== 0) return fail(MSG.step, amount)
  return { ok: true, amount, credits: creditsForAmount(amount), error: null }
}

// ---------------------------------------------------------------------------------------------
// Order status
// ---------------------------------------------------------------------------------------------

export type TopupPhase = 'waiting' | 'paid' | 'review' | 'expired' | 'rejected' | 'unknown'

export interface TopupStatusView {
  phase: TopupPhase
  /** Vietnamese, short, for the status view. */
  label: string
  /** No further change expected: stop polling. */
  final: boolean
}

/**
 * canvasapp order status → what the dialog shows.
 *   pending → waiting (keep polling) · paid / reconciled → paid · reconcile_required → review (money received but
 *   canvasapp must check it by hand: stop polling, point to the credit history) · expired · rejected.
 * Anything else → unknown (not final: keep polling until the order TTL runs out).
 */
export function mapTopupStatus(status: unknown): TopupStatusView {
  const s = typeof status === 'string' ? status.trim().toLowerCase() : ''
  switch (s) {
    case 'pending':
      return { phase: 'waiting', label: 'Đang chờ thanh toán…', final: false }
    case 'paid':
      return { phase: 'paid', label: 'Đã nhận tiền — credit đã được cộng.', final: true }
    case 'reconciled':
      return { phase: 'paid', label: 'Đã nhận tiền (đã đối soát) — credit đã được cộng.', final: true }
    case 'reconcile_required':
      return { phase: 'review', label: 'canvasapp đang đối soát giao dịch — credit sẽ được cộng sau khi kiểm tra. Xem Lịch sử credit.', final: true }
    case 'expired':
      return { phase: 'expired', label: 'Đơn nạp đã hết hạn (quá 10 phút). Nếu đã chuyển tiền, xem Lịch sử credit hoặc liên hệ canvasapp.', final: true }
    case 'rejected':
      return { phase: 'rejected', label: 'Thanh toán bị từ chối.', final: true }
    default:
      return { phase: 'unknown', label: s ? `Trạng thái chưa rõ (${s.slice(0, 40)}).` : 'Trạng thái chưa rõ.', final: false }
  }
}

// ---------------------------------------------------------------------------------------------
// URLs (checkout page / return to canvasapp)
// ---------------------------------------------------------------------------------------------

const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
// whitespace, control chars, backslash: the URL parser would silently drop / reinterpret them
const ODD_CHARS_RE = /[\s\u0000-\u001f\u007f\\]/

function parseHttps(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 4000 || ODD_CHARS_RE.test(raw)) return null
  if (!/^https:\/\//i.test(raw)) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '') return null
  return u
}

/** The checkout URL canvasapp returned may be opened: https, host sepay.vn or *.sepay.vn (exact suffix). */
export function checkoutUrlAllowed(url: unknown): boolean {
  const u = parseHttps(url)
  if (!u) return false
  const host = u.hostname.toLowerCase()
  return host === CHECKOUT_HOST_SUFFIX || host.endsWith('.' + CHECKOUT_HOST_SUFFIX)
}

export type PaymentReturnResult = 'success' | 'cancel' | 'error'

export interface PaymentReturn {
  result: PaymentReturnResult
  orderId: string
}

/**
 * SePay sends the browser back to canvasapp with `?payment=success|cancel|error&topup_order=<id>`.
 * Only https://canvasapp.io.vn with both params (and a safe order id) counts. An unexpected `payment` value is
 * treated as 'error' — the order status read from canvasapp decides anyway.
 */
export function parsePaymentReturn(url: unknown): PaymentReturn | null {
  const u = parseHttps(url)
  if (!u || u.hostname.toLowerCase() !== CANVASAPP_HOST) return null
  const payment = u.searchParams.get('payment')
  const orderId = u.searchParams.get('topup_order')
  if (payment === null || orderId === null || !ORDER_ID_RE.test(orderId)) return null
  const p = payment.trim().toLowerCase()
  const result: PaymentReturnResult = p === 'success' || p === 'cancel' ? p : 'error'
  return { result, orderId }
}
