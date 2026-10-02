// Pure view helpers of the "Nạp credit canvasapp" sheet (topupModel.ts). No stores, no network.
import { describe, expect, it } from 'vitest'
import type { CreditHistoryItem, CreditHistoryPage } from '../../../providers/canvasapp/api'
import { CHECKOUT_UNSUPPORTED } from '../../../providers/canvasapp/transport'
import { TOPUP_FLOW_INITIAL, type TopupFlowState } from '../topupFlow'
import {
  amountFieldText,
  amountHint,
  AMOUNT_RULE_TEXT,
  formatCountdown,
  formatDelta,
  formatHistoryTime,
  GATE_WEB_TEXT,
  HISTORY_INITIAL,
  historyEmptyText,
  historyItemKind,
  historyReducer,
  historyRowView,
  historyStatusView,
  mergeHistoryItems,
  parseHistoryTime,
  presetView,
  remainingMs,
  statusView,
  topupGate,
  type AuthProbe,
  type GateInput,
  type HistoryState,
} from '../topupModel'

const ok = (authenticated = true, topupEnabled = true): AuthProbe => ({ state: 'ok', authenticated, topupEnabled })
const desk = (over: Partial<GateInput> = {}): GateInput => ({ desktop: true, bridge: true, checkout: true, auth: ok(), ...over })

describe('topupGate', () => {
  it('is ready on a desktop build with the bridge, logged in, top-up open', () => {
    expect(topupGate(desk())).toMatchObject({ ok: true, state: 'ready', action: null })
    expect(topupGate(desk(), 'history').ok).toBe(true)
  })

  it('development mode (simulated gateway, web too): same gate, texts name the simulation and the dev panel', () => {
    // the dev bridge exists everywhere, so a web build is not refused
    const web = { desktop: false, bridge: true, checkout: true, simulated: true }
    expect(topupGate({ ...web, auth: ok() })).toMatchObject({ ok: true, state: 'ready' })
    const login = topupGate({ ...web, auth: ok(false) })
    expect(login).toMatchObject({ state: 'login', action: 'login', actionLabel: 'Đăng nhập (giả lập)' })
    expect(login.title).toContain('giả lập')
    expect(login.message).not.toContain('canvasapp.io.vn')
    const off = topupGate({ ...web, auth: ok(true, false) })
    expect(off.state).toBe('disabled')
    expect(off.message).toContain('Bảng phát triển')
    expect(topupGate({ ...web, auth: { state: 'error', message: 'Mất mạng (giả lập).', loginRequired: false } }).message).toContain('Bảng phát triển')
    expect(topupGate({ ...web, auth: { state: 'loading' } }).title).toContain('giả lập')
  })

  it('web build: explains and points to the gateway settings', () => {
    const g = topupGate({ desktop: false, bridge: false, checkout: false, auth: { state: 'idle' } })
    expect(g).toMatchObject({ ok: false, state: 'web', action: 'settings', message: GATE_WEB_TEXT })
    expect(topupGate({ desktop: false, bridge: false, checkout: false, auth: { state: 'idle' } }, 'history').state).toBe('web')
  })

  it('desktop build without the canvasapp bridge, or without checkout()', () => {
    expect(topupGate(desk({ bridge: false })).state).toBe('old-desktop')
    expect(topupGate(desk({ checkout: false }))).toMatchObject({ state: 'unsupported', message: CHECKOUT_UNSUPPORTED, action: null })
    // the history only needs the request bridge
    expect(topupGate(desk({ checkout: false }), 'history').ok).toBe(true)
  })

  it('waits for the auth state, then asks to log in when needed', () => {
    expect(topupGate(desk({ auth: { state: 'idle' } })).state).toBe('checking')
    expect(topupGate(desk({ auth: { state: 'loading' } })).state).toBe('checking')
    expect(topupGate(desk({ auth: ok(false) }))).toMatchObject({ state: 'login', action: 'login', actionLabel: 'Đăng nhập canvasapp' })
    expect(topupGate(desk({ auth: { state: 'error', message: 'x', loginRequired: true } })).state).toBe('login')
    // the real-credit store saw a 401 after the auth check
    expect(topupGate(desk({ loginRequired: true })).state).toBe('login')
    expect(topupGate(desk({ auth: ok(false) }), 'history').state).toBe('login')
  })

  it('auth check failure → retry; topup_enabled false → disabled (history still works)', () => {
    expect(topupGate(desk({ auth: { state: 'error', message: 'Mất mạng', loginRequired: false } }))).toMatchObject({ state: 'error', action: 'retry', message: 'Mất mạng' })
    expect(topupGate(desk({ auth: ok(true, false) }))).toMatchObject({ state: 'disabled', action: 'retry' })
    expect(topupGate(desk({ auth: ok(true, false) }), 'history').ok).toBe(true)
  })
})

describe('amount form', () => {
  it('empty field shows the rule, not an error', () => {
    expect(amountHint('')).toEqual({ tone: 'idle', text: AMOUNT_RULE_TEXT, amount: null, credits: null })
    expect(amountHint('   ').tone).toBe('idle')
  })
  it('valid amounts show "= N credit" live', () => {
    expect(amountHint('50k')).toEqual({ tone: 'ok', text: '50.000đ = 50 credit', amount: 50_000, credits: 50 })
    expect(amountHint('1.500.000')).toMatchObject({ tone: 'ok', text: '1.500.000đ = 1.500 credit', amount: 1_500_000 })
  })
  it('invalid amounts show the Vietnamese reason', () => {
    expect(amountHint('abc')).toMatchObject({ tone: 'error', amount: null })
    expect(amountHint('5000').text).toMatch(/Tối thiểu/)
    expect(amountHint('50500').text).toMatch(/bội số/)
    expect(amountHint('20tr').text).toMatch(/Tối đa/)
  })
  it('presets', () => {
    expect(presetView(30_000)).toEqual({ vnd: 30_000, label: '30.000đ', credits: '30 credit' })
    expect(amountFieldText(200_000)).toBe('200.000')
    expect(amountHint(amountFieldText(100_000)).amount).toBe(100_000)
  })
})

const flow = (over: Partial<TopupFlowState>): TopupFlowState => ({ ...TOPUP_FLOW_INITIAL, amount: 50_000, credits: 50, ...over })

describe('statusView', () => {
  it('never says paid before canvasapp does', () => {
    for (const phase of ['creating', 'checkout', 'waiting', 'untracked', 'cancelled', 'expired', 'rejected', 'review', 'error'] as const) {
      const v = statusView(flow({ phase }))
      expect(v.tone).not.toBe('ok')
      expect(v.title).not.toMatch(/Đã nhận tiền/)
    }
    // coming back from SePay with success is only "confirming"
    expect(statusView(flow({ phase: 'waiting', lastCheckout: 'success' }))).toMatchObject({ title: 'Đang xác nhận thanh toán…', countdown: true })
  })

  it('paid shows the credits canvasapp confirmed', () => {
    const v = statusView(flow({ phase: 'paid', paidCredits: 50, serverStatus: 'paid' }))
    expect(v).toMatchObject({ tone: 'ok', icon: 'check', title: 'Đã nhận tiền ✓' })
    expect(v.detail).toContain('+50 credit')
    expect(v.detail).toContain('50.000đ')
    expect(statusView(flow({ phase: 'paid', paidCredits: 50, serverStatus: 'reconciled' })).detail).toMatch(/đối soát/)
  })

  it('waiting after the window closed early invites to reopen, and names a timeout', () => {
    const closed = statusView(flow({ phase: 'waiting', windowClosedEarly: true, lastCheckout: 'closed' }))
    expect(closed.title).toBe('Đang chờ thanh toán')
    expect(closed.detail).toMatch(/Mở lại trang thanh toán/)
    expect(statusView(flow({ phase: 'waiting', windowClosedEarly: true, lastCheckout: 'timeout' })).detail).toMatch(/15 phút/)
    expect(statusView(flow({ phase: 'waiting', serverStatus: 'weird' })).detail).toContain('weird')
  })

  it('other phases', () => {
    expect(statusView(flow({ phase: 'checkout' }))).toMatchObject({ icon: 'qr', countdown: true })
    expect(statusView(flow({ phase: 'review' }))).toMatchObject({ tone: 'warn', title: 'Đang đối soát' })
    expect(statusView(flow({ phase: 'expired' })).title).toBe('Hết hạn')
    expect(statusView(flow({ phase: 'expired', expiredLocally: true })).detail).toMatch(/ngừng kiểm tra/)
    expect(statusView(flow({ phase: 'rejected' }))).toMatchObject({ tone: 'danger', title: 'Bị từ chối' })
    expect(statusView(flow({ phase: 'cancelled', cancelReason: 'sepay' })).detail).toMatch(/SePay/)
    expect(statusView(flow({ phase: 'cancelled', cancelReason: 'user' })).detail).toMatch(/ngừng theo dõi/)
    expect(statusView(flow({ phase: 'untracked' })).title).toBe('Chưa xác nhận được')
    expect(statusView(flow({ phase: 'error', error: { message: 'Hỏng rồi', code: null, retry: null } })).detail).toBe('Hỏng rồi')
  })
})

describe('countdown', () => {
  it('formats m:ss and never goes negative', () => {
    expect(formatCountdown(600_000)).toBe('10:00')
    expect(formatCountdown(59_001)).toBe('1:00')
    expect(formatCountdown(1)).toBe('0:01')
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-5000)).toBe('0:00')
    expect(formatCountdown(null)).toBe('—')
    expect(remainingMs(10_000, 4_000)).toBe(6_000)
    expect(remainingMs(10_000, 12_000)).toBe(0)
    expect(remainingMs(null, 1)).toBeNull()
  })
})

describe('credit history rows', () => {
  it('maps canvasapp types to the filter kinds', () => {
    expect(historyItemKind('topup')).toBe('topup')
    expect(historyItemKind('credit_topup')).toBe('topup')
    expect(historyItemKind('payment')).toBe('topup')
    expect(historyItemKind('video')).toBe('video')
    expect(historyItemKind('video_job_charge')).toBe('video')
    expect(historyItemKind('video_refund')).toBe('refund')
    expect(historyItemKind('refund')).toBe('refund')
    expect(historyItemKind('adjustment')).toBe('adjustment')
    expect(historyItemKind('admin_bonus')).toBe('adjustment')
    expect(historyItemKind('')).toBe('other')
    expect(historyItemKind('mystery')).toBe('other')
  })

  it('status labels', () => {
    expect(historyStatusView('completed')).toEqual({ label: 'Hoàn tất', tone: 'ok' })
    expect(historyStatusView('PENDING')).toEqual({ label: 'Đang xử lý', tone: 'warn' })
    expect(historyStatusView('reconcile_required')).toEqual({ label: 'Đang đối soát', tone: 'warn' })
    expect(historyStatusView('failed')).toEqual({ label: 'Thất bại', tone: 'danger' })
    expect(historyStatusView('cancelled')?.label).toBe('Đã huỷ')
    expect(historyStatusView('something_new')).toEqual({ label: 'something_new', tone: 'neutral' })
    expect(historyStatusView(null)).toBeNull()
    expect(historyStatusView('  ')).toBeNull()
  })

  it('signed credit amounts', () => {
    expect(formatDelta(50)).toEqual({ text: '+50 credit', sign: 'plus' })
    expect(formatDelta(1234)).toEqual({ text: '+1.234 credit', sign: 'plus' })
    expect(formatDelta(-20)).toEqual({ text: '−20 credit', sign: 'minus' })
    expect(formatDelta(-2.5)).toEqual({ text: '−2,5 credit', sign: 'minus' })
    expect(formatDelta(0)).toEqual({ text: '0 credit', sign: 'zero' })
    expect(formatDelta(null)).toBeNull()
    expect(formatDelta(Number.NaN)).toBeNull()
  })

  it('times in Vietnamese, relative to today', () => {
    const now = new Date(2026, 9, 2, 20, 0).getTime()
    expect(formatHistoryTime('2026-10-02T14:05:00', now).text).toBe('Hôm nay, 14:05')
    expect(formatHistoryTime('2026-10-02 14:05:09', now)).toEqual({ text: 'Hôm nay, 14:05', title: '02/10/2026 14:05:09' })
    expect(formatHistoryTime('2026-10-01T23:59:00', now).text).toBe('Hôm qua, 23:59')
    expect(formatHistoryTime('2026-09-28T08:30:00', now).text).toBe('28/09/2026, 08:30')
    const epoch = new Date(2026, 9, 2, 9, 7).getTime()
    expect(formatHistoryTime(String(Math.floor(epoch / 1000)), now).text).toBe('Hôm nay, 09:07')
    expect(parseHistoryTime(String(epoch))).toBe(epoch)
    expect(formatHistoryTime(null, now).text).toBe('—')
    expect(formatHistoryTime('not a date', now).text).toBe('—')
  })

  it('one row', () => {
    const now = new Date(2026, 9, 2, 20, 0).getTime()
    const item: CreditHistoryItem = { type: 'topup', description: '  Nạp   credit qua SePay ', status: 'completed', delta: 50, amount_vnd: 50_000, created_at: '2026-10-02T14:05:00' }
    expect(historyRowView(item, now)).toEqual({
      kind: 'topup',
      title: 'Nạp credit qua SePay',
      status: { label: 'Hoàn tất', tone: 'ok' },
      delta: { text: '+50 credit', sign: 'plus' },
      amount: '50.000đ',
      time: { text: 'Hôm nay, 14:05', title: '02/10/2026 14:05:00' },
    })
    const bare = historyRowView({ type: 'video', description: '', status: null, delta: -20, amount_vnd: null, created_at: null }, now)
    expect(bare).toMatchObject({ title: 'Tạo video', status: null, amount: null, delta: { sign: 'minus' } })
    expect(historyRowView({ ...item, amount_vnd: 0 }, now).amount).toBeNull()
  })

  it('empty texts per filter', () => {
    expect(historyEmptyText('all')).toMatch(/giao dịch/)
    expect(historyEmptyText('topup')).toMatch(/nạp/)
    expect(historyEmptyText('video')).toMatch(/video/)
    expect(historyEmptyText('refund')).toMatch(/hoàn/)
    expect(historyEmptyText('adjustment')).toMatch(/điều chỉnh/)
  })
})

const row = (n: number, over: Partial<CreditHistoryItem> = {}): CreditHistoryItem => ({
  type: 'video',
  description: `Video ${n}`,
  status: 'completed',
  delta: -n,
  amount_vnd: null,
  created_at: `2026-10-02T10:${String(n).padStart(2, '0')}:00`,
  ...over,
})
const page = (items: CreditHistoryItem[], next: number | null, balance: number | null = 100): CreditHistoryPage => ({ items, next_offset: next, balance })

describe('credit history paging', () => {
  it('appending drops rows already shown', () => {
    expect(mergeHistoryItems([row(1), row(2)], [row(2), row(3)]).map((r) => r.description)).toEqual(['Video 1', 'Video 2', 'Video 3'])
    // same text but another time is another row
    expect(mergeHistoryItems([row(1)], [row(1, { created_at: '2026-10-01T10:00:00' })]).length).toBe(2)
  })

  it('first page, "Xem thêm", end of list', () => {
    let s: HistoryState = historyReducer(HISTORY_INITIAL, { type: 'request', req: 1, kind: 'all', append: false })
    expect(s).toMatchObject({ status: 'loading', req: 1 })
    s = historyReducer(s, { type: 'success', req: 1, page: page([row(1), row(2)], 2), append: false })
    expect(s).toMatchObject({ status: 'ok', nextOffset: 2, balance: 100 })
    s = historyReducer(s, { type: 'request', req: 2, kind: 'all', append: true })
    expect(s).toMatchObject({ loadingMore: true, status: 'ok' })
    s = historyReducer(s, { type: 'success', req: 2, page: page([row(3)], null, 90), append: true })
    expect(s.items.length).toBe(3)
    expect(s).toMatchObject({ nextOffset: null, loadingMore: false, balance: 90 })
  })

  it('ignores stale answers and a next offset that does not move forward', () => {
    let s = historyReducer(HISTORY_INITIAL, { type: 'request', req: 1, kind: 'all', append: false })
    s = historyReducer(s, { type: 'request', req: 2, kind: 'topup', append: false })
    const stale = historyReducer(s, { type: 'success', req: 1, page: page([row(1)], 20), append: false })
    expect(stale).toBe(s)
    s = historyReducer(s, { type: 'success', req: 2, page: page([row(5, { type: 'topup' })], 0), append: false })
    expect(s).toMatchObject({ kind: 'topup', nextOffset: null })
    s = historyReducer({ ...s, nextOffset: 20 }, { type: 'request', req: 3, kind: 'topup', append: true })
    s = historyReducer(s, { type: 'success', req: 3, page: page([row(6)], 20), append: true })
    expect(s.nextOffset).toBeNull()
  })

  it('another filter starts empty; reloading the same filter keeps the rows meanwhile', () => {
    let s = historyReducer(HISTORY_INITIAL, { type: 'request', req: 1, kind: 'all', append: false })
    s = historyReducer(s, { type: 'success', req: 1, page: page([row(1)], 20), append: false })
    const reload = historyReducer(s, { type: 'request', req: 2, kind: 'all', append: false })
    expect(reload.items.length).toBe(1)
    expect(reload.status).toBe('loading')
    const other = historyReducer(s, { type: 'request', req: 2, kind: 'refund', append: false })
    expect(other).toMatchObject({ items: [], nextOffset: null, kind: 'refund' })
  })

  it('errors: first page → error state; "Xem thêm" → rows kept with an inline error', () => {
    let s = historyReducer(HISTORY_INITIAL, { type: 'request', req: 1, kind: 'all', append: false })
    const failed = historyReducer(s, { type: 'failure', req: 1, message: 'Mất mạng', code: 'network', append: false })
    expect(failed).toMatchObject({ status: 'error', error: 'Mất mạng', errorCode: 'network' })
    s = historyReducer(s, { type: 'success', req: 1, page: page([row(1)], 1), append: false })
    s = historyReducer(s, { type: 'request', req: 2, kind: 'all', append: true })
    s = historyReducer(s, { type: 'failure', req: 2, message: 'Hết phiên', code: 'login-required', append: true })
    expect(s).toMatchObject({ status: 'ok', loadingMore: false, error: 'Hết phiên', errorCode: 'login-required', nextOffset: 1 })
    expect(s.items.length).toBe(1)
  })
})
