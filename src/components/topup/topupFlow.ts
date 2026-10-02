// One top-up order from "Mở thanh toán QR" to canvasapp's answer — docs/SPEC-v2.md §10. No React, no app stores:
// everything it talks to is injected (tests use fakes; the app instance is appFlow.ts).
//
// Payment safety (mandatory):
//   - SanoVids never sees, asks for or types bank/card data. The user pays on the REAL SePay page that canvasapp's
//     own response points to, opened by the desktop checkout window (transport openCheckout → electron main).
//   - The checkout URL is checked (core/topup checkoutUrlAllowed) before anything is opened; main re-checks it.
//   - Nothing is ever confirmed locally: the phase becomes 'paid' ONLY when GET /api/payments/topups/{id} says
//     paid / reconciled. Coming back from SePay with ?payment=success only starts the status polling.
//   - At most ONE order in flight (creating / checkout window open / waiting for canvasapp): start() refuses
//     meanwhile, whatever the UI shows.
//
// ---- Phases ----
//   idle       nothing going on (the amount form).
//   creating   POST /api/payments/topups in flight.
//   checkout   the checkout window is open (the user pays there); TTL countdown.
//   waiting    polling the order every TOPUP_UI_POLL_MS (3 s) until canvasapp gives a final status or the order's
//              TTL (10 min) + TOPUP_POLL_GRACE_MS ran out. `windowClosedEarly` = the window was closed / timed out
//              before SePay sent the user back (offer "Mở lại trang thanh toán" while the order is still valid).
//   paid       canvasapp said paid / reconciled (`paidCredits` = credits added).
//   review     reconcile_required: money received, canvasapp checks it by hand (final, see Lịch sử credit).
//   expired    canvasapp said expired, or (expiredLocally) it never answered with a final status before the deadline.
//   rejected   canvasapp said rejected.
//   cancelled  cancelReason 'sepay' = the user cancelled on the SePay page; 'user' = the user stopped tracking the
//              order in SanoVids (the order itself just expires on canvasapp if unpaid).
//   untracked  the window ended but there is no order id to poll (canvasapp did not return one): cannot confirm.
//   error      `error.retry` says what "Thử lại" does: 'create' (new order, same amount), 'checkout' (open the same
//              checkout again while the order is valid, else a new order), 'poll' (read the status again), null
//              (nothing to retry: refused URL, desktop build too old…).
//
// ---- API ----
//   createTopupFlow(deps): TopupFlow
//     store                 zustand store of TopupFlowState (useStore(flow.store) in React).
//     start(amountVnd)      new order → checkout window → polling. false when refused (order in flight, bad amount)
//                           or when it ended in 'error'.
//     reopen()              open the same checkout form again (canReopen()).
//     retry()               see 'error' above.
//     checkNow()            read the order status now (waiting: next poll now; cancelled / error / locally expired:
//                           one read — a late 'paid' still shows as paid).
//     stopTracking()        waiting / untracked / error → cancelled ('user'). Frees the flow for a new order.
//     reset()               back to idle (refused while an order is in flight).
//     inFlight()            isOrderInFlight(phase).
//     dispose()             stop timers and ignore pending answers (tests).
//   canReopen(state, now)   the checkout form can be opened again (order still valid ≥ 20 s, no window open).
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { checkoutUrlAllowed, creditsForAmount, mapTopupStatus, TOPUP_ORDER_TTL_MS, validateTopupAmount } from '../../core/topup'
import { CanvasappError, canvasappErrorText, type CanvasappApi, type TopupCheckout, type TopupOrder } from '../../providers/canvasapp/api'
import { CHECKOUT_REFUSED, type CheckoutArgs, type CheckoutResult } from '../../providers/canvasapp/transport'

/** Status poll period while waiting for canvasapp (the order lives 10 minutes). */
export const TOPUP_UI_POLL_MS = 3_000
/** Keep polling this long after the order's TTL before giving up (canvasapp flips it to expired by itself). */
export const TOPUP_POLL_GRACE_MS = 30_000
/** Consecutive failed status reads before the flow stops with an error ("Thử lại" resumes). */
export const TOPUP_MAX_POLL_ERRORS = 5
/** Longest wait between two status reads while canvasapp keeps failing. */
export const TOPUP_POLL_BACKOFF_MAX_MS = 15_000
/** "Mở lại trang thanh toán" only while the order has at least this long left. */
export const TOPUP_REOPEN_MARGIN_MS = 20_000

export type TopupFlowPhase =
  | 'idle'
  | 'creating'
  | 'checkout'
  | 'waiting'
  | 'paid'
  | 'review'
  | 'expired'
  | 'rejected'
  | 'cancelled'
  | 'untracked'
  | 'error'

export type TopupRetry = 'create' | 'checkout' | 'poll'

export interface TopupFlowError {
  /** Vietnamese, shown as is. */
  message: string
  /** CanvasappError code ('login-required' → offer the login button), null for other errors. */
  code: string | null
  retry: TopupRetry | null
}

export interface TopupFlowState {
  phase: TopupFlowPhase
  /** Amount of the order (VND) and the credits it buys. */
  amount: number | null
  credits: number | null
  /** canvasapp order id (from createTopup or the return URL); null = cannot poll. */
  orderId: string | null
  /** The checkout form canvasapp returned (kept to reopen the same order). Never shown. */
  form: CheckoutArgs | null
  /** When the order was created / expires on canvasapp (ms since epoch). */
  createdAt: number | null
  expiresAt: number | null
  /** How the last checkout window ended (null while open / before). */
  lastCheckout: CheckoutResult | null
  /** The window was closed / timed out before SePay sent the user back. */
  windowClosedEarly: boolean
  cancelReason: 'sepay' | 'user' | null
  /** 'expired' because SanoVids stopped waiting (canvasapp never said so). */
  expiredLocally: boolean
  /** Last raw status canvasapp returned (lower-cased) and when. */
  serverStatus: string | null
  checkedAt: number | null
  /** Consecutive failed status reads and the warning shown meanwhile. */
  pollErrors: number
  pollWarning: string | null
  error: TopupFlowError | null
  /** Main-frame navigation the checkout window refused (diagnostics). */
  blockedHost: string | null
  /** Credits canvasapp confirmed (phase 'paid'). */
  paidCredits: number | null
}

export const TOPUP_FLOW_INITIAL: TopupFlowState = {
  phase: 'idle',
  amount: null,
  credits: null,
  orderId: null,
  form: null,
  createdAt: null,
  expiresAt: null,
  lastCheckout: null,
  windowClosedEarly: false,
  cancelReason: null,
  expiredLocally: false,
  serverStatus: null,
  checkedAt: null,
  pollErrors: 0,
  pollWarning: null,
  error: null,
  blockedHost: null,
  paidCredits: null,
}

export type CheckoutOutcome = { result: CheckoutResult; orderId: string | null; blockedHost: string | null }

export interface TopupFlowDeps {
  /** canvasapp client (lazy: read on every call). */
  api: () => Pick<CanvasappApi, 'createTopup' | 'getTopup'>
  /** Opens the checkout window and resolves when it ends (transport openCheckout). */
  checkout: (args: CheckoutArgs) => Promise<CheckoutOutcome>
  /** A final answer from canvasapp: paid / review / expired / rejected. */
  onSettled?: (state: TopupFlowState) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  pollMs?: number
  ttlMs?: number
  graceMs?: number
  maxPollErrors?: number
}

export interface TopupFlow {
  store: UseBoundStore<StoreApi<TopupFlowState>>
  start: (amountVnd: number) => Promise<boolean>
  reopen: () => Promise<boolean>
  retry: () => Promise<boolean>
  checkNow: () => Promise<void>
  stopTracking: () => boolean
  reset: () => boolean
  inFlight: () => boolean
  dispose: () => void
}

/** An order is being created, paid (window open) or confirmed: no second order may start. */
export function isOrderInFlight(phase: TopupFlowPhase): boolean {
  return phase === 'creating' || phase === 'checkout' || phase === 'waiting'
}

const REOPEN_PHASES: readonly TopupFlowPhase[] = ['waiting', 'untracked', 'cancelled', 'error']

/** The same checkout form can be opened again: no window open, order valid for ≥ TOPUP_REOPEN_MARGIN_MS more. */
export function canReopen(s: Pick<TopupFlowState, 'phase' | 'form' | 'expiresAt' | 'windowClosedEarly' | 'error'>, now: number): boolean {
  if (!s.form || s.expiresAt === null || s.expiresAt - now < TOPUP_REOPEN_MARGIN_MS) return false
  if (!REOPEN_PHASES.includes(s.phase)) return false
  // While waiting after SePay sent the user back the payment went through on their side: nothing to reopen.
  if (s.phase === 'waiting' && !s.windowClosedEarly) return false
  // A refused URL / an old desktop build cannot be retried.
  if (s.phase === 'error' && s.error?.retry === null) return false
  return true
}

const codeOf = (e: unknown): string | null => (e instanceof CanvasappError ? e.code : null)

const SEPAY_ERROR = 'SePay báo thanh toán không thành công — chưa có credit nào được cộng. Bạn có thể mở lại trang thanh toán hoặc tạo đơn mới.'

export function createTopupFlow(deps: TopupFlowDeps): TopupFlow {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const pollMs = deps.pollMs ?? TOPUP_UI_POLL_MS
  const ttlMs = deps.ttlMs ?? TOPUP_ORDER_TTL_MS
  const graceMs = deps.graceMs ?? TOPUP_POLL_GRACE_MS
  const maxPollErrors = deps.maxPollErrors ?? TOPUP_MAX_POLL_ERRORS

  const store = create<TopupFlowState>()(() => ({ ...TOPUP_FLOW_INITIAL }))
  const get = store.getState
  const set = (patch: Partial<TopupFlowState>) => store.setState(patch)

  /** Bumped whenever the flow moves on: async answers from an older step are ignored. */
  let gen = 0
  let timer: unknown = null
  /** A status read (poll or "Kiểm tra") is in flight: "Kiểm tra ngay" does not send a second one. */
  let reading = false

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  const advance = () => {
    stopTimer()
    return ++gen
  }

  const settled = () => {
    try {
      deps.onSettled?.(get())
    } catch {
      /* a UI callback must never break the flow */
    }
  }

  const fail = (e: unknown, retry: TopupRetry | null) => {
    set({ phase: 'error', error: { message: canvasappErrorText(e), code: codeOf(e), retry } })
  }

  /** Apply canvasapp's answer. True when it was final (phase set, onSettled called). */
  function applyStatus(order: TopupOrder): boolean {
    const v = mapTopupStatus(order.status)
    set({ serverStatus: order.status, checkedAt: now(), pollErrors: 0, pollWarning: null })
    if (v.phase === 'paid') {
      const fromServer = order.amount_vnd !== null && order.amount_vnd > 0 ? creditsForAmount(order.amount_vnd) : null
      set({ phase: 'paid', paidCredits: fromServer ?? get().credits, error: null })
      settled()
      return true
    }
    if (v.final) {
      // review / expired / rejected
      set({ phase: v.phase as 'review' | 'expired' | 'rejected', error: null, expiredLocally: false })
      settled()
      return true
    }
    return false
  }

  function schedulePoll(g: number, delay: number) {
    stopTimer()
    timer = setTimer(() => {
      timer = null
      void pollOnce(g)
    }, delay)
  }

  async function pollOnce(g: number): Promise<void> {
    if (g !== gen) return
    const s = get()
    if (s.phase !== 'waiting' || !s.orderId) return
    let order: TopupOrder
    reading = true
    try {
      order = await deps.api().getTopup(s.orderId)
    } catch (e) {
      reading = false
      if (g !== gen) return
      const errors = get().pollErrors + 1
      if (codeOf(e) === 'login-required' || errors >= maxPollErrors) {
        set({ pollErrors: errors, pollWarning: null })
        fail(e, 'poll')
        return
      }
      set({ pollErrors: errors, pollWarning: `Chưa đọc được trạng thái đơn nạp (${canvasappErrorText(e)}) — đang thử lại…` })
      schedulePoll(g, Math.min(pollMs * 2 ** errors, TOPUP_POLL_BACKOFF_MAX_MS))
      return
    }
    reading = false
    if (g !== gen) return
    if (applyStatus(order)) return
    const { expiresAt } = get()
    if (expiresAt !== null && now() >= expiresAt + graceMs) {
      set({ phase: 'expired', expiredLocally: true })
      settled()
      return
    }
    schedulePoll(g, pollMs)
  }

  /** One status read after SePay said cancel / error: a final answer wins, else `otherwise`. */
  async function checkOnce(g: number, otherwise: () => void): Promise<void> {
    const id = get().orderId
    if (id) {
      try {
        const order = await deps.api().getTopup(id)
        if (g !== gen) return
        if (applyStatus(order)) return
      } catch {
        if (g !== gen) return
        /* cannot read it now: fall through, "Kiểm tra lại" reads it again */
      }
    }
    otherwise()
  }

  async function runCheckout(g: number): Promise<boolean> {
    const form = get().form
    if (!form) return false
    set({ phase: 'checkout', lastCheckout: null, windowClosedEarly: false, cancelReason: null, error: null, pollWarning: null, pollErrors: 0, blockedHost: null })
    let res: CheckoutOutcome
    try {
      res = await deps.checkout({ checkoutUrl: form.checkoutUrl, fields: { ...form.fields } })
    } catch (e) {
      if (g !== gen) return false
      const code = codeOf(e)
      fail(e, code === 'forbidden' || code === 'unsupported' || code === 'unavailable' ? null : 'checkout')
      return false
    }
    if (g !== gen) return false
    const orderId = res.orderId ?? get().orderId
    set({ lastCheckout: res.result, orderId, blockedHost: res.blockedHost })
    switch (res.result) {
      case 'success':
        // SePay sent the user back: only canvasapp's order status says whether the money arrived.
        set({ phase: 'waiting', windowClosedEarly: false })
        schedulePoll(g, 0)
        return true
      case 'closed':
      case 'timeout':
        // They may have paid on their phone before closing: keep asking canvasapp while the order is valid.
        set({ windowClosedEarly: true })
        if (orderId) {
          set({ phase: 'waiting' })
          schedulePoll(g, 0)
        } else set({ phase: 'untracked' })
        return true
      case 'cancel':
        await checkOnce(g, () => set({ phase: 'cancelled', cancelReason: 'sepay', windowClosedEarly: true }))
        return g === gen
      default:
        await checkOnce(g, () => set({ phase: 'error', windowClosedEarly: true, error: { message: SEPAY_ERROR, code: null, retry: 'checkout' } }))
        return false
    }
  }

  async function start(amountVnd: number): Promise<boolean> {
    if (isOrderInFlight(get().phase)) return false
    const check = validateTopupAmount(amountVnd)
    if (!check.ok || check.amount === null) return false
    const g = advance()
    // Synchronously, before any await: a double click finds the order in flight.
    store.setState({ ...TOPUP_FLOW_INITIAL, phase: 'creating', amount: check.amount, credits: check.credits })
    let checkout: TopupCheckout
    try {
      checkout = await deps.api().createTopup(check.amount)
    } catch (e) {
      if (g !== gen) return false
      const code = codeOf(e)
      fail(e, code === 'unavailable' || code === 'unsupported' ? null : 'create')
      return false
    }
    if (g !== gen) return false
    if (!checkoutUrlAllowed(checkout.checkout_url)) {
      // Never open a page that is not SePay (the unpaid order simply expires on canvasapp).
      set({ phase: 'error', error: { message: CHECKOUT_REFUSED, code: 'forbidden', retry: null } })
      return false
    }
    const t = now()
    set({ orderId: checkout.order_id, form: { checkoutUrl: checkout.checkout_url, fields: { ...checkout.fields } }, createdAt: t, expiresAt: t + ttlMs })
    return runCheckout(g)
  }

  async function reopen(): Promise<boolean> {
    if (!canReopen(get(), now())) return false
    return runCheckout(advance())
  }

  async function retry(): Promise<boolean> {
    const s = get()
    if (s.phase !== 'error' || !s.error?.retry) return false
    if (s.error.retry === 'poll' && s.orderId) {
      const g = advance()
      set({ phase: 'waiting', error: null, pollErrors: 0, pollWarning: null })
      schedulePoll(g, 0)
      return true
    }
    if (s.error.retry === 'checkout' && canReopen(s, now())) return runCheckout(advance())
    // 'create', or the order to reopen is no longer valid: a new order for the same amount.
    if (s.amount === null) return false
    return start(s.amount)
  }

  async function checkNow(): Promise<void> {
    const s = get()
    if (!s.orderId || reading) return
    if (s.phase === 'waiting') {
      schedulePoll(gen, 0)
      return
    }
    if (s.phase !== 'cancelled' && s.phase !== 'error' && !(s.phase === 'expired' && s.expiredLocally)) return
    const g = gen
    reading = true
    try {
      const order = await deps.api().getTopup(s.orderId)
      if (g !== gen) return
      applyStatus(order)
    } catch (e) {
      if (g !== gen) return
      set({ pollWarning: `Chưa đọc được trạng thái đơn nạp (${canvasappErrorText(e)}).` })
    } finally {
      reading = false
    }
  }

  function stopTracking(): boolean {
    const { phase } = get()
    if (phase !== 'waiting' && phase !== 'untracked' && phase !== 'error') return false
    advance()
    set({ phase: 'cancelled', cancelReason: 'user', pollWarning: null, error: null })
    return true
  }

  function reset(): boolean {
    if (isOrderInFlight(get().phase)) return false
    advance()
    store.setState({ ...TOPUP_FLOW_INITIAL })
    return true
  }

  return {
    store,
    start,
    reopen,
    retry,
    checkNow,
    stopTracking,
    reset,
    inFlight: () => isOrderInFlight(get().phase),
    dispose: () => {
      advance()
    },
  }
}
