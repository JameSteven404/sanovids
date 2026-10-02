// What the "Nạp credit canvasapp" sheet shows — pure, no stores, no React (tested in __tests__/topupModel.test.ts).
// docs/SPEC-v2.md §10. The order lifecycle itself lives in topupFlow.ts.
//
// ---- API ----
//   topupGate(input, scope)        can the tab be used here: desktop build + canvasapp bridge (+ checkout() for the
//                                  top-up tab), logged in, topup_enabled (top-up tab) → GateView with the reason and
//                                  the one action that helps ('settings' | 'login' | 'retry' | null).
//   amountHint(text)               live check of the custom amount: "= 150 credit" | Vietnamese error | idle hint.
//   presetView(vnd)                { vnd, label "50.000đ", credits "50 credit" }.
//   statusView(state, now)         the status card of a flow state (tone, icon, title, detail, countdown?).
//   formatCountdown(ms)            "9:58" (never negative). remainingMs(expiresAt, now).
//   historyItemKind(type)          canvasapp history `type` → 'topup' | 'video' | 'refund' | 'adjustment' | 'other'.
//   historyStatusView(status)      { label, tone } | null.
//   formatDelta(delta)             { text "+50 credit" | "−20 credit", sign } | null.
//   formatHistoryTime(iso, now)    { text "Hôm nay, 14:05" | "Hôm qua, 09:12" | "02/10/2026, 14:05", title }.
//   historyRowView(item, now)      everything one history row shows.
//   mergeHistoryItems(prev, next)  append a page, dropping rows already shown (pages can shift as new rows arrive).
//   historyReducer                 paging state of the history tab (stale answers ignored by request id).
//   historyEmptyText(kind)         empty-state text per filter.
import { creditsForAmount, formatVnd, mapTopupStatus, TOPUP_MAX_VND, TOPUP_MIN_VND, TOPUP_STEP_VND, validateTopupAmount, type TopupHistoryKind } from '../../core/topup'
import { formatCreditNumber } from '../../lib/credits'
import type { CreditHistoryItem, CreditHistoryPage } from '../../providers/canvasapp/api'
import { CHECKOUT_UNSUPPORTED } from '../../providers/canvasapp/transport'
import type { TopupFlowState } from './topupFlow'

// ---------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------

/** Result of GET /api/auth/state, as the dialog keeps it. */
export type AuthProbe =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; authenticated: boolean; topupEnabled: boolean }
  | { state: 'error'; message: string; loginRequired: boolean }

export interface GateInput {
  /** Running inside the desktop build (usePwaInstall().desktop). */
  desktop: boolean
  /** window.bdpDesktop.canvasapp exists. */
  bridge: boolean
  /** The bridge has checkout() (desktop builds made after top-up landed). */
  checkout: boolean
  auth: AuthProbe
  /** The real-credit store got a 401 (store/credits status 'login-required'). */
  loginRequired?: boolean
  /** Development mode: the gateway is the in-app simulated canvasapp (texts say so and point at the dev panel). */
  simulated?: boolean
}

export type GateState = 'ready' | 'checking' | 'web' | 'old-desktop' | 'unsupported' | 'login' | 'disabled' | 'error'
export type GateAction = 'settings' | 'login' | 'retry'

export interface GateView {
  state: GateState
  ok: boolean
  title: string
  message: string
  action: GateAction | null
  actionLabel: string | null
}

const gate = (state: GateState, title: string, message: string, action: GateAction | null = null, actionLabel: string | null = null): GateView => ({
  state,
  ok: state === 'ready',
  title,
  message,
  action,
  actionLabel,
})

export const GATE_WEB_TEXT =
  'Nạp credit canvasapp chỉ dùng được trong bản desktop SanoVids (.exe): trang thanh toán mở trong một cửa sổ riêng của app, bằng phiên đăng nhập canvasapp của bạn. Trên trình duyệt, hãy nạp trực tiếp trên canvasapp.io.vn.'

/** Can this tab be used here? `scope` 'history' does not need checkout() nor topup_enabled. */
export function topupGate(input: GateInput, scope: 'topup' | 'history' = 'topup'): GateView {
  const what = scope === 'topup' ? 'Nạp credit' : 'Lịch sử credit'
  if (!input.bridge) {
    if (!input.desktop) return gate('web', 'Chỉ có trong bản desktop', GATE_WEB_TEXT, 'settings', 'Mở Cài đặt cổng canvasapp')
    return gate(
      'old-desktop',
      'Bản desktop này chưa có cổng canvasapp',
      `${what} cần cổng canvasapp.io.vn của bản desktop mới — hãy cập nhật SanoVids, hoặc nạp trực tiếp trên canvasapp.io.vn.`,
      'settings',
      'Mở Cài đặt',
    )
  }
  if (scope === 'topup' && !input.checkout) return gate('unsupported', 'Cần cập nhật SanoVids', CHECKOUT_UNSUPPORTED)
  const { auth } = input
  const sim = !!input.simulated
  if (auth.state === 'idle' || auth.state === 'loading') {
    return sim
      ? gate('checking', 'Đang kiểm tra tài khoản giả lập…', 'Đang hỏi canvasapp giả lập (chế độ Phát triển) trạng thái đăng nhập.')
      : gate('checking', 'Đang kiểm tra tài khoản canvasapp…', 'Đang hỏi canvasapp.io.vn trạng thái đăng nhập.')
  }
  const login = () =>
    sim
      ? gate(
          'login',
          'Chưa đăng nhập tài khoản giả lập',
          `Đăng nhập trên trang đăng nhập giả lập (không cần mật khẩu, không gọi mạng) để dùng ${what}.`,
          'login',
          'Đăng nhập (giả lập)',
        )
      : gate(
          'login',
          'Chưa đăng nhập canvasapp.io.vn',
          `Đăng nhập trên trang của canvasapp (cửa sổ riêng — SanoVids không thấy mật khẩu) để dùng ${what}.`,
          'login',
          'Đăng nhập canvasapp',
        )
  if (auth.state === 'error') {
    if (auth.loginRequired) return login()
    return sim
      ? gate(
          'error',
          'Không kiểm tra được tài khoản giả lập',
          `${auth.message || 'Không kết nối được tới canvasapp giả lập.'} — có thể do một lỗi giả đang bật trong Bảng phát triển.`,
          'retry',
          'Thử lại',
        )
      : gate('error', 'Không kiểm tra được tài khoản canvasapp', auth.message || 'Không kết nối được tới canvasapp.io.vn.', 'retry', 'Thử lại')
  }
  if (!auth.authenticated || input.loginRequired) return login()
  if (scope === 'topup' && !auth.topupEnabled) {
    return sim
      ? gate(
          'disabled',
          'canvasapp giả lập đang tắt nạp credit',
          'Máy chủ giả lập đang trả topup_enabled = false. Bật lại trong Bảng phát triển › Trạng thái › “Cho phép nạp credit”.',
          'retry',
          'Kiểm tra lại',
        )
      : gate(
          'disabled',
          'canvasapp đang tạm đóng nạp credit',
          'canvasapp.io.vn đang không mở chức năng nạp credit (topup_enabled = false). Thử lại sau, hoặc xem thông báo trên canvasapp.io.vn.',
          'retry',
          'Kiểm tra lại',
        )
  }
  return gate('ready', '', '')
}

// ---------------------------------------------------------------------------------------------
// Amount form
// ---------------------------------------------------------------------------------------------

export const AMOUNT_RULE_TEXT = `Từ ${formatVnd(TOPUP_MIN_VND)} đến ${formatVnd(TOPUP_MAX_VND)}, bội số của ${formatVnd(TOPUP_STEP_VND)}.`

export interface AmountHint {
  tone: 'idle' | 'ok' | 'error'
  text: string
  /** Valid amount in VND, else null. */
  amount: number | null
  credits: number | null
}

/** Live hint under the custom amount field. Empty → the rule (not an error yet). */
export function amountHint(text: string): AmountHint {
  if (!text.trim()) return { tone: 'idle', text: AMOUNT_RULE_TEXT, amount: null, credits: null }
  const check = validateTopupAmount(text)
  if (!check.ok || check.amount === null || check.credits === null) return { tone: 'error', text: check.error ?? AMOUNT_RULE_TEXT, amount: null, credits: null }
  return { tone: 'ok', text: `${formatVnd(check.amount)} = ${formatCreditNumber(check.credits)} credit`, amount: check.amount, credits: check.credits }
}

export interface PresetView {
  vnd: number
  label: string
  credits: string
}

export function presetView(vnd: number): PresetView {
  return { vnd, label: formatVnd(vnd), credits: `${formatCreditNumber(creditsForAmount(vnd))} credit` }
}

/** "50.000" — what a preset writes into the amount field. */
export function amountFieldText(vnd: number): string {
  return formatVnd(vnd).replace(/đ$/, '')
}

// ---------------------------------------------------------------------------------------------
// Status card
// ---------------------------------------------------------------------------------------------

export type StatusTone = 'progress' | 'ok' | 'warn' | 'danger' | 'neutral'
export type StatusIcon = 'spinner' | 'qr' | 'check' | 'review' | 'expired' | 'rejected' | 'cancelled' | 'error' | 'unknown'

export interface StatusView {
  tone: StatusTone
  icon: StatusIcon
  title: string
  detail: string
  /** Show the order's TTL countdown. */
  countdown: boolean
}

export function remainingMs(expiresAt: number | null, now: number): number | null {
  return expiresAt === null ? null : Math.max(0, expiresAt - now)
}

/** "9:58" (m:ss), never negative. */
export function formatCountdown(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

type StatusInput = Pick<
  TopupFlowState,
  'phase' | 'amount' | 'credits' | 'lastCheckout' | 'windowClosedEarly' | 'cancelReason' | 'expiredLocally' | 'serverStatus' | 'error' | 'paidCredits'
>

const orderText = (s: Pick<TopupFlowState, 'amount' | 'credits'>) =>
  s.amount !== null && s.credits !== null ? `${formatVnd(s.amount)} = ${formatCreditNumber(s.credits)} credit` : 'đơn nạp'

/** The status card for a flow state. Never says "paid" unless canvasapp did (phase 'paid'). */
export function statusView(s: StatusInput): StatusView {
  switch (s.phase) {
    case 'idle':
      return { tone: 'neutral', icon: 'qr', title: 'Chưa có đơn nạp', detail: '', countdown: false }
    case 'creating':
      return { tone: 'progress', icon: 'spinner', title: 'Đang tạo đơn nạp…', detail: `Đang nhờ canvasapp tạo đơn ${orderText(s)}.`, countdown: false }
    case 'checkout':
      return {
        tone: 'progress',
        icon: 'qr',
        title: 'Đang chờ thanh toán',
        detail:
          'Quét mã QR trên trang SePay trong cửa sổ “Thanh toán nạp credit” bằng app ngân hàng của bạn. Cửa sổ tự đóng khi SePay xác nhận. SanoVids không thấy và không nhập thông tin ngân hàng.',
        countdown: true,
      }
    case 'waiting': {
      const unknown = s.serverStatus && mapTopupStatus(s.serverStatus).phase === 'unknown' ? ` (canvasapp báo: “${s.serverStatus.slice(0, 40)}”)` : ''
      if (!s.windowClosedEarly) {
        return {
          tone: 'progress',
          icon: 'spinner',
          title: 'Đang xác nhận thanh toán…',
          detail: `SePay đã chuyển về canvasapp — đang chờ canvasapp xác nhận đã nhận tiền${unknown}. Credit chỉ được tính khi canvasapp xác nhận.`,
          countdown: true,
        }
      }
      const closed = s.lastCheckout === 'timeout' ? 'Cửa sổ thanh toán đã tự đóng sau 15 phút.' : 'Cửa sổ thanh toán đã đóng.'
      return {
        tone: 'progress',
        icon: 'spinner',
        title: 'Đang chờ thanh toán',
        detail: `${closed} Nếu bạn đã quét QR và chuyển tiền, SanoVids sẽ báo ngay khi canvasapp nhận được${unknown}. Chưa thanh toán? Mở lại trang thanh toán.`,
        countdown: true,
      }
    }
    case 'paid': {
      const credits = s.paidCredits ?? s.credits
      return {
        tone: 'ok',
        icon: 'check',
        title: 'Đã nhận tiền ✓',
        detail:
          (credits !== null ? `+${formatCreditNumber(credits)} credit đã được cộng vào tài khoản canvasapp` : 'canvasapp đã cộng credit vào tài khoản') +
          (s.amount !== null ? ` (${formatVnd(s.amount)}).` : '.') +
          (s.serverStatus === 'reconciled' ? ' Giao dịch đã được đối soát.' : ''),
        countdown: false,
      }
    }
    case 'review':
      return { tone: 'warn', icon: 'review', title: 'Đang đối soát', detail: mapTopupStatus('reconcile_required').label, countdown: false }
    case 'expired':
      return {
        tone: 'warn',
        icon: 'expired',
        title: 'Hết hạn',
        detail: s.expiredLocally
          ? 'Đã quá 10 phút mà canvasapp chưa xác nhận thanh toán nên SanoVids ngừng kiểm tra. Nếu bạn đã chuyển tiền, xem Lịch sử credit hoặc liên hệ canvasapp.'
          : mapTopupStatus('expired').label,
        countdown: false,
      }
    case 'rejected':
      return { tone: 'danger', icon: 'rejected', title: 'Bị từ chối', detail: 'canvasapp từ chối thanh toán này — không có credit nào được cộng. Bạn có thể tạo đơn mới.', countdown: false }
    case 'cancelled':
      return {
        tone: 'neutral',
        icon: 'cancelled',
        title: 'Đã huỷ',
        detail:
          s.cancelReason === 'user'
            ? 'SanoVids đã ngừng theo dõi đơn này. Đơn chưa thanh toán sẽ tự hết hạn sau 10 phút; nếu bạn vẫn chuyển tiền cho đơn này, credit vẫn được cộng — xem Lịch sử credit.'
            : 'Bạn đã huỷ thanh toán trên trang SePay. Chưa có credit nào được cộng.',
        countdown: false,
      }
    case 'untracked':
      return {
        tone: 'warn',
        icon: 'unknown',
        title: 'Chưa xác nhận được',
        detail:
          'canvasapp không trả về mã đơn nên SanoVids không theo dõi được trạng thái. Nếu bạn đã thanh toán, credit sẽ được cộng sau ít phút — xem số dư hoặc Lịch sử credit.',
        countdown: true,
      }
    case 'error':
    default:
      return { tone: 'danger', icon: 'error', title: 'Lỗi', detail: s.error?.message ?? 'Đã có lỗi khi nạp credit.', countdown: false }
  }
}

// ---------------------------------------------------------------------------------------------
// Credit history
// ---------------------------------------------------------------------------------------------

export type HistoryItemKind = Exclude<TopupHistoryKind, 'all'> | 'other'

const KIND_TITLE: Record<HistoryItemKind, string> = {
  topup: 'Nạp credit',
  video: 'Tạo video',
  refund: 'Hoàn credit',
  adjustment: 'Điều chỉnh',
  other: 'Giao dịch credit',
}

/** canvasapp's `type` (exact values unverified: VERIFY) → one of the filter kinds. */
export function historyItemKind(type: string | null | undefined): HistoryItemKind {
  const t = (type ?? '').trim().toLowerCase()
  if (!t) return 'other'
  if (/refund|hoàn/.test(t)) return 'refund'
  if (/top.?up|deposit|payment|purchase|nạp/.test(t)) return 'topup'
  if (/adjust|bonus|admin|manual|grant|gift|promo|điều chỉnh/.test(t)) return 'adjustment'
  if (/video|job|generat|render|charge|spend|usage/.test(t)) return 'video'
  return 'other'
}

export type HistoryTone = 'ok' | 'warn' | 'danger' | 'neutral'

/** Status of a history row → short Vietnamese label. null / empty → no badge. */
export function historyStatusView(status: string | null | undefined): { label: string; tone: HistoryTone } | null {
  const s = (status ?? '').trim().toLowerCase()
  if (!s) return null
  switch (s) {
    case 'completed':
    case 'complete':
    case 'success':
    case 'succeeded':
    case 'done':
    case 'paid':
    case 'charged':
    case 'settled':
      return { label: 'Hoàn tất', tone: 'ok' }
    case 'reconciled':
      return { label: 'Đã đối soát', tone: 'ok' }
    case 'refunded':
      return { label: 'Đã hoàn', tone: 'ok' }
    case 'pending':
    case 'processing':
    case 'queued':
    case 'reserved':
    case 'held':
      return { label: 'Đang xử lý', tone: 'warn' }
    case 'reconcile_required':
      return { label: 'Đang đối soát', tone: 'warn' }
    case 'failed':
    case 'error':
      return { label: 'Thất bại', tone: 'danger' }
    case 'rejected':
      return { label: 'Bị từ chối', tone: 'danger' }
    case 'expired':
      return { label: 'Hết hạn', tone: 'neutral' }
    case 'cancelled':
    case 'canceled':
      return { label: 'Đã huỷ', tone: 'neutral' }
    default:
      return { label: s.slice(0, 24), tone: 'neutral' }
  }
}

export interface DeltaView {
  /** "+50 credit" | "−20 credit" | "0 credit". */
  text: string
  sign: 'plus' | 'minus' | 'zero'
}

export function formatDelta(delta: number | null | undefined): DeltaView | null {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return null
  const n = formatCreditNumber(Math.abs(delta))
  if (n === '0') return { text: '0 credit', sign: 'zero' }
  return delta > 0 ? { text: `+${n} credit`, sign: 'plus' } : { text: `−${n} credit`, sign: 'minus' }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** ISO text, "2026-10-02 07:05:00", or epoch seconds / ms → ms; null when unreadable. */
export function parseHistoryTime(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s)
    return s.length <= 10 ? n * 1000 : n
  }
  const t = Date.parse(s.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'))
  return Number.isFinite(t) ? t : null
}

/** "Hôm nay, 14:05" | "Hôm qua, 09:12" | "02/10/2026, 14:05" (local time); title = full date and time. */
export function formatHistoryTime(raw: string | null | undefined, now: number = Date.now()): { text: string; title: string } {
  const t = parseHistoryTime(raw)
  if (t === null) return { text: '—', title: raw ? `Thời gian: ${raw.slice(0, 40)}` : 'Không rõ thời gian' }
  const d = new Date(t)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((dayStart(new Date(now)) - dayStart(d)) / 86_400_000)
  const text = days === 0 ? `Hôm nay, ${hm}` : days === 1 ? `Hôm qua, ${hm}` : `${date}, ${hm}`
  return { text, title: `${date} ${hm}:${pad(d.getSeconds())}` }
}

export interface HistoryRowView {
  kind: HistoryItemKind
  title: string
  status: { label: string; tone: HistoryTone } | null
  delta: DeltaView | null
  /** "50.000đ" when the row has an amount in VND. */
  amount: string | null
  time: { text: string; title: string }
}

export function historyRowView(item: CreditHistoryItem, now: number = Date.now()): HistoryRowView {
  const kind = historyItemKind(item.type)
  const title = item.description.trim().replace(/\s+/g, ' ').slice(0, 200) || KIND_TITLE[kind]
  return {
    kind,
    title,
    status: historyStatusView(item.status),
    delta: formatDelta(item.delta),
    amount: typeof item.amount_vnd === 'number' && Number.isFinite(item.amount_vnd) && item.amount_vnd !== 0 ? formatVnd(item.amount_vnd) : null,
    time: formatHistoryTime(item.created_at, now),
  }
}

const itemKey = (it: CreditHistoryItem) => [it.type, it.created_at ?? '', it.delta ?? '', it.amount_vnd ?? '', it.status ?? '', it.description].join('|')

/** Append a page; rows already shown (same type, time, amounts, status and text) are not repeated. */
export function mergeHistoryItems(prev: readonly CreditHistoryItem[], next: readonly CreditHistoryItem[]): CreditHistoryItem[] {
  const seen = new Set(prev.map(itemKey))
  const out = [...prev]
  for (const it of next) {
    const k = itemKey(it)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(it)
  }
  return out
}

export function historyEmptyText(kind: TopupHistoryKind): string {
  switch (kind) {
    case 'topup':
      return 'Chưa có lần nạp credit nào.'
    case 'video':
      return 'Chưa có lần trừ credit cho video nào.'
    case 'refund':
      return 'Chưa có khoản hoàn credit nào.'
    case 'adjustment':
      return 'Chưa có điều chỉnh credit nào.'
    default:
      return 'Chưa có giao dịch credit nào.'
  }
}

/** Rows per "Xem thêm". */
export const HISTORY_PAGE_SIZE = 20

export interface HistoryState {
  kind: TopupHistoryKind
  items: CreditHistoryItem[]
  /** Offset of the next page; null = no more. */
  nextOffset: number | null
  /** First page of the current filter. */
  status: 'idle' | 'loading' | 'ok' | 'error'
  loadingMore: boolean
  /** First-page error (status 'error') or "Xem thêm" error (status stays 'ok'). */
  error: string | null
  errorCode: string | null
  /** Balance canvasapp sent with the last page. */
  balance: number | null
  /** Id of the request whose answer is awaited; older answers are ignored. */
  req: number
}

export const HISTORY_INITIAL: HistoryState = { kind: 'all', items: [], nextOffset: null, status: 'idle', loadingMore: false, error: null, errorCode: null, balance: null, req: 0 }

export type HistoryAction =
  | { type: 'request'; req: number; kind: TopupHistoryKind; append: boolean }
  | { type: 'success'; req: number; page: CreditHistoryPage; append: boolean }
  | { type: 'failure'; req: number; message: string; code: string | null; append: boolean }

export function historyReducer(s: HistoryState, a: HistoryAction): HistoryState {
  switch (a.type) {
    case 'request':
      if (a.append) return { ...s, req: a.req, loadingMore: true, error: null, errorCode: null }
      // Another filter: start from an empty list. Same filter (reload): keep the rows while loading.
      return {
        ...s,
        req: a.req,
        kind: a.kind,
        items: a.kind === s.kind ? s.items : [],
        nextOffset: a.kind === s.kind ? s.nextOffset : null,
        status: 'loading',
        loadingMore: false,
        error: null,
        errorCode: null,
      }
    case 'success': {
      if (a.req !== s.req) return s
      const items = a.append ? mergeHistoryItems(s.items, a.page.items) : a.page.items.slice()
      // A "next" offset that does not move forward would loop "Xem thêm" forever.
      const next = a.page.next_offset
      const prevOffset = a.append ? (s.nextOffset ?? 0) : 0
      return {
        ...s,
        items,
        nextOffset: next !== null && next > prevOffset && a.page.items.length > 0 ? next : null,
        status: 'ok',
        loadingMore: false,
        error: null,
        errorCode: null,
        balance: a.page.balance ?? s.balance,
      }
    }
    case 'failure':
      if (a.req !== s.req) return s
      if (a.append) return { ...s, loadingMore: false, error: a.message, errorCode: a.code }
      return { ...s, status: 'error', loadingMore: false, error: a.message, errorCode: a.code }
    default:
      return s
  }
}
