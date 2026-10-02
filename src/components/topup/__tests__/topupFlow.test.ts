// The top-up order flow (topupFlow.ts) with a fake canvasapp client and a fake checkout window.
// Never touches the live canvasapp API, never opens anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOPUP_ORDER_TTL_MS } from '../../../core/topup'
import { CanvasappError, type TopupCheckout, type TopupOrder } from '../../../providers/canvasapp/api'
import { CHECKOUT_REFUSED, type CheckoutArgs } from '../../../providers/canvasapp/transport'
import {
  canReopen,
  createTopupFlow,
  TOPUP_FLOW_INITIAL,
  TOPUP_MAX_POLL_ERRORS,
  TOPUP_POLL_GRACE_MS,
  TOPUP_REOPEN_MARGIN_MS,
  TOPUP_UI_POLL_MS,
  type CheckoutOutcome,
  type TopupFlowState,
} from '../topupFlow'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const CHECKOUT: TopupCheckout = {
  checkout_url: 'https://pay.sepay.vn/v1/checkout/init',
  fields: { merchant: 'CANVAS', order_amount: '50000', signature: 'abc==' },
  order_id: 'TOP123',
}

type Answer<T> = T | Error | (() => T | Promise<T>)

function harness(opts: { checkout?: Answer<TopupCheckout>; orders?: Answer<TopupOrder>[]; windows?: Answer<CheckoutOutcome>[] } = {}) {
  const created: number[] = []
  const polled: string[] = []
  const opened: CheckoutArgs[] = []
  const settled: TopupFlowState[] = []
  const orders = [...(opts.orders ?? [])]
  const windows = [...(opts.windows ?? [])]
  const answer = async <T,>(a: Answer<T> | undefined, fallback: T): Promise<T> => {
    const v = a === undefined ? fallback : a
    if (v instanceof Error) throw v
    return typeof v === 'function' ? (v as () => T | Promise<T>)() : v
  }
  const pending: TopupOrder = { status: 'pending', amount_vnd: 50_000 }
  const flow = createTopupFlow({
    api: () => ({
      createTopup: async (amount: number) => {
        created.push(amount)
        return answer(opts.checkout, CHECKOUT)
      },
      getTopup: async (id: string) => {
        polled.push(id)
        return answer(orders.length > 1 ? orders.shift() : orders[0], pending)
      },
    }),
    checkout: async (args) => {
      opened.push(args)
      return answer(windows.shift(), { result: 'closed', orderId: null, blockedHost: null })
    },
    onSettled: (s) => settled.push({ ...s }),
  })
  return { flow, created, polled, opened, settled, state: () => flow.store.getState() }
}

const ret = (result: CheckoutOutcome['result'], orderId: string | null = 'TOP123', blockedHost: string | null = null): CheckoutOutcome => ({ result, orderId, blockedHost })
const order = (status: string, amount_vnd: number | null = 50_000): TopupOrder => ({ status, amount_vnd })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 2, 12, 0, 0))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('topup flow: one order at a time', () => {
  it('refuses a second order while one is in flight (double click included)', async () => {
    const win = deferred<CheckoutOutcome>()
    const h = harness({ windows: [() => win.promise] })
    const first = h.flow.start(50_000)
    expect(h.state().phase).toBe('creating') // synchronously
    expect(await h.flow.start(50_000)).toBe(false)
    expect(await h.flow.start(100_000)).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.state().phase).toBe('checkout')
    expect(await h.flow.start(30_000)).toBe(false)
    expect(h.flow.reset()).toBe(false)
    expect(h.created).toEqual([50_000])
    win.resolve(ret('success'))
    await first
    expect(h.state().phase).toBe('waiting')
    expect(await h.flow.start(30_000)).toBe(false)
    expect(h.created).toEqual([50_000])
    h.flow.dispose()
  })

  it('refuses bad amounts without calling canvasapp', async () => {
    const h = harness()
    for (const bad of [0, 5_000, 50_500, 20_000_000, 1.5, Number.NaN]) expect(await h.flow.start(bad)).toBe(false)
    expect(h.created).toEqual([])
    expect(h.state().phase).toBe('idle')
  })
})

describe('topup flow: never confirms locally', () => {
  it('success from SePay only starts polling; paid only when canvasapp says so', async () => {
    const h = harness({ windows: [ret('success')], orders: [order('pending'), order('pending'), order('paid', 50_000)] })
    expect(await h.flow.start(50_000)).toBe(true)
    expect(h.opened).toEqual([{ checkoutUrl: CHECKOUT.checkout_url, fields: CHECKOUT.fields }])
    expect(h.state()).toMatchObject({ phase: 'waiting', windowClosedEarly: false, orderId: 'TOP123', amount: 50_000, credits: 50 })
    expect(h.state().expiresAt! - h.state().createdAt!).toBe(TOPUP_ORDER_TTL_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.polled).toEqual(['TOP123'])
    expect(h.state().phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(TOPUP_UI_POLL_MS)
    expect(h.state().phase).toBe('waiting')
    expect(h.settled).toEqual([])
    await vi.advanceTimersByTimeAsync(TOPUP_UI_POLL_MS)
    expect(h.state()).toMatchObject({ phase: 'paid', paidCredits: 50, serverStatus: 'paid' })
    expect(h.settled.map((s) => s.phase)).toEqual(['paid'])
    // no more polling once final
    await vi.advanceTimersByTimeAsync(TOPUP_UI_POLL_MS * 5)
    expect(h.polled.length).toBe(3)
  })

  it('credits come from the amount canvasapp confirmed; reconciled counts as paid', async () => {
    const h = harness({ windows: [ret('success')], orders: [order('reconciled', 100_000)] })
    await h.flow.start(50_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.state()).toMatchObject({ phase: 'paid', paidCredits: 100 })
    const g = harness({ windows: [ret('success')], orders: [order('paid', null)] })
    await g.flow.start(50_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(g.state().paidCredits).toBe(50)
  })

  it('keeps waiting while pending, then gives up after the TTL + grace (expired locally)', async () => {
    const h = harness({ windows: [ret('success')], orders: [order('pending')] })
    await h.flow.start(50_000)
    await vi.advanceTimersByTimeAsync(TOPUP_ORDER_TTL_MS)
    expect(h.state().phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(TOPUP_POLL_GRACE_MS + TOPUP_UI_POLL_MS)
    expect(h.state()).toMatchObject({ phase: 'expired', expiredLocally: true })
    expect(h.settled.map((s) => s.phase)).toEqual(['expired'])
    const n = h.polled.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.polled.length).toBe(n)
  })

  it('final answers: review / expired / rejected stop polling', async () => {
    for (const [status, phase] of [
      ['reconcile_required', 'review'],
      ['expired', 'expired'],
      ['rejected', 'rejected'],
    ] as const) {
      const h = harness({ windows: [ret('success')], orders: [order(status)] })
      await h.flow.start(50_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.state()).toMatchObject({ phase, expiredLocally: false })
      expect(h.settled.length).toBe(1)
    }
  })

  it('an unknown status keeps polling (not final)', async () => {
    const h = harness({ windows: [ret('success')], orders: [order('processing_by_bank'), order('paid')] })
    await h.flow.start(50_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.state()).toMatchObject({ phase: 'waiting', serverStatus: 'processing_by_bank' })
    await vi.advanceTimersByTimeAsync(TOPUP_UI_POLL_MS)
    expect(h.state().phase).toBe('paid')
  })
})

describe('topup flow: checkout URL and window outcomes', () => {
  it('never opens a checkout URL that is not SePay', async () => {
    for (const url of ['https://evil.example/pay', 'http://pay.sepay.vn/x', 'https://sepay.vn.evil.com/', 'javascript:alert(1)']) {
      const h = harness({ checkout: { ...CHECKOUT, checkout_url: url } })
      expect(await h.flow.start(50_000)).toBe(false)
      expect(h.opened).toEqual([])
      expect(h.state()).toMatchObject({ phase: 'error', error: { message: CHECKOUT_REFUSED, code: 'forbidden', retry: null } })
      expect(await h.flow.retry()).toBe(false)
    }
  })

  it('the order id from the return URL wins over the one from createTopup', async () => {
    const h = harness({ windows: [ret('success', 'RET999')], orders: [order('pending')] })
    await h.flow.start(50_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.polled).toEqual(['RET999'])
    h.flow.dispose()
  })

  it('window closed early with an order id → keep waiting, offer to reopen the same form', async () => {
    const h = harness({ windows: [ret('closed', null), ret('success')], orders: [order('pending')] })
    await h.flow.start(50_000)
    expect(h.state()).toMatchObject({ phase: 'waiting', windowClosedEarly: true, lastCheckout: 'closed', orderId: 'TOP123' })
    expect(canReopen(h.state(), Date.now())).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.polled).toEqual(['TOP123'])
    expect(await h.flow.reopen()).toBe(true)
    expect(h.opened.length).toBe(2)
    expect(h.opened[1]).toEqual(h.opened[0])
    expect(h.state()).toMatchObject({ phase: 'waiting', windowClosedEarly: false })
    // after SePay sent the user back there is nothing to reopen
    expect(canReopen(h.state(), Date.now())).toBe(false)
    h.flow.dispose()
  })

  it('timeout of the window is treated like closed', async () => {
    const h = harness({ windows: [ret('timeout', null)] })
    await h.flow.start(50_000)
    expect(h.state()).toMatchObject({ phase: 'waiting', windowClosedEarly: true, lastCheckout: 'timeout' })
    h.flow.dispose()
  })

  it('no order id at all → untracked (cannot confirm), a new order is allowed', async () => {
    const h = harness({ checkout: { ...CHECKOUT, order_id: null }, windows: [ret('closed', null)] })
    await h.flow.start(50_000)
    expect(h.state().phase).toBe('untracked')
    expect(h.polled).toEqual([])
    expect(h.flow.inFlight()).toBe(false)
    expect(canReopen(h.state(), Date.now())).toBe(true)
    expect(h.flow.reset()).toBe(true)
    expect(h.state()).toEqual(TOPUP_FLOW_INITIAL)
  })

  it('cancel on SePay → one status check; pending → cancelled, paid → paid', async () => {
    const h = harness({ windows: [ret('cancel')], orders: [order('pending')] })
    expect(await h.flow.start(50_000)).toBe(true)
    expect(h.state()).toMatchObject({ phase: 'cancelled', cancelReason: 'sepay' })
    expect(h.polled.length).toBe(1)
    await vi.advanceTimersByTimeAsync(TOPUP_UI_POLL_MS * 3)
    expect(h.polled.length).toBe(1)

    const late = harness({ windows: [ret('cancel')], orders: [order('paid')] })
    await late.flow.start(50_000)
    expect(late.state().phase).toBe('paid')
    expect(late.settled.length).toBe(1)
  })

  it('error from SePay → error with retry that reopens the same order', async () => {
    const h = harness({ windows: [ret('error'), ret('success')], orders: [order('pending')] })
    expect(await h.flow.start(50_000)).toBe(false)
    expect(h.state()).toMatchObject({ phase: 'error', error: { retry: 'checkout' } })
    expect(await h.flow.retry()).toBe(true)
    expect(h.created).toEqual([50_000])
    expect(h.opened.length).toBe(2)
    expect(h.state().phase).toBe('waiting')
    h.flow.dispose()
  })

  it('retry of a checkout after the order expired creates a new order', async () => {
    const h = harness({ windows: [ret('error'), ret('success')], orders: [order('pending')] })
    await h.flow.start(50_000)
    vi.setSystemTime(Date.now() + TOPUP_ORDER_TTL_MS)
    expect(canReopen(h.state(), Date.now())).toBe(false)
    expect(await h.flow.retry()).toBe(true)
    expect(h.created).toEqual([50_000, 50_000])
    h.flow.dispose()
  })

  it('checkout window refused: busy → retry; forbidden / unsupported → nothing to retry', async () => {
    const busy = harness({ windows: [new CanvasappError('busy', 'Đang có cửa sổ'), ret('success')] })
    await busy.flow.start(50_000)
    expect(busy.state()).toMatchObject({ phase: 'error', error: { code: 'busy', retry: 'checkout' } })
    expect(await busy.flow.retry()).toBe(true)
    expect(busy.opened.length).toBe(2)
    busy.flow.dispose()

    for (const code of ['forbidden', 'unsupported'] as const) {
      const h = harness({ windows: [new CanvasappError(code, 'không')] })
      await h.flow.start(50_000)
      expect(h.state()).toMatchObject({ phase: 'error', error: { code, retry: null } })
      expect(canReopen(h.state(), Date.now())).toBe(false)
      expect(await h.flow.retry()).toBe(false)
    }
  })

  it('records the host the checkout window refused', async () => {
    const h = harness({ windows: [ret('closed', null, 'napas.com.vn')] })
    await h.flow.start(50_000)
    expect(h.state().blockedHost).toBe('napas.com.vn')
    h.flow.dispose()
  })
})

describe('topup flow: errors and recovery', () => {
  it('createTopup fails → retry creates the order again with the same amount', async () => {
    let n = 0
    const h = harness({
      checkout: () => {
        n++
        if (n === 1) throw new CanvasappError('server', 'canvasapp lỗi')
        return CHECKOUT
      },
      windows: [ret('success')],
    })
    expect(await h.flow.start(100_000)).toBe(false)
    expect(h.state()).toMatchObject({ phase: 'error', error: { code: 'server', retry: 'create' }, amount: 100_000 })
    expect(h.opened).toEqual([])
    expect(await h.flow.retry()).toBe(true)
    expect(h.created).toEqual([100_000, 100_000])
    h.flow.dispose()
  })

  it('401 while polling → error asking to log in; retry resumes polling', async () => {
    const h = harness({ windows: [ret('success')], orders: [new CanvasappError('login-required', 'Hết phiên'), order('paid')] })
    await h.flow.start(50_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.state()).toMatchObject({ phase: 'error', error: { code: 'login-required', retry: 'poll' } })
    expect(await h.flow.retry()).toBe(true)
    expect(h.state().phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.state().phase).toBe('paid')
  })

  it('transient read errors back off with a warning, then clear on the next answer', async () => {
    const h = harness({ windows: [ret('success')], orders: [new CanvasappError('network', 'Mất mạng'), order('pending'), order('paid')] })
    await h.flow.start(50_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.state()).toMatchObject({ phase: 'waiting', pollErrors: 1 })
    expect(h.state().pollWarning).toMatch(/Mất mạng/)
    await vi.advanceTimersByTimeAsync(TOPUP_UI_POLL_MS) // backoff is 2 × poll: not yet
    expect(h.polled.length).toBe(1)
    await vi.advanceTimersByTimeAsync(TOPUP_UI_POLL_MS)
    expect(h.state()).toMatchObject({ phase: 'waiting', pollErrors: 0, pollWarning: null })
    await vi.advanceTimersByTimeAsync(TOPUP_UI_POLL_MS)
    expect(h.state().phase).toBe('paid')
  })

  it(`${TOPUP_MAX_POLL_ERRORS} failed reads in a row → error with retry`, async () => {
    const h = harness({ windows: [ret('success')], orders: [new CanvasappError('server', 'Lỗi máy chủ')] })
    await h.flow.start(50_000)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.state()).toMatchObject({ phase: 'error', pollErrors: TOPUP_MAX_POLL_ERRORS, error: { retry: 'poll' } })
    expect(h.polled.length).toBe(TOPUP_MAX_POLL_ERRORS)
  })

  it('stop tracking frees the flow for a new order; checkNow still reports a late payment', async () => {
    const h = harness({ windows: [ret('closed'), ret('success')], orders: [order('pending')] })
    await h.flow.start(50_000)
    expect(h.flow.stopTracking()).toBe(true)
    expect(h.state()).toMatchObject({ phase: 'cancelled', cancelReason: 'user' })
    const polls = h.polled.length
    await vi.advanceTimersByTimeAsync(TOPUP_UI_POLL_MS * 3)
    expect(h.polled.length).toBe(polls)
    expect(h.flow.inFlight()).toBe(false)

    const late = harness({ windows: [ret('closed')], orders: [order('pending'), order('paid')] })
    await late.flow.start(50_000)
    await vi.advanceTimersByTimeAsync(0)
    late.flow.stopTracking()
    await late.flow.checkNow()
    expect(late.state().phase).toBe('paid')
  })

  it('"Kiểm tra ngay" clicked many times while a read is in flight sends no extra request', async () => {
    const slow = deferred<TopupOrder>()
    const h = harness({ windows: [ret('success')], orders: [() => slow.promise] })
    await h.flow.start(50_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.polled.length).toBe(1)
    for (let i = 0; i < 5; i++) await h.flow.checkNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.polled.length).toBe(1)
    slow.resolve(order('paid'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.state().phase).toBe('paid')
    expect(h.settled.length).toBe(1)
  })

  it('answers that arrive after the flow moved on are ignored', async () => {
    const create = deferred<TopupCheckout>()
    const h = harness({ checkout: () => create.promise })
    const p = h.flow.start(50_000)
    h.flow.dispose()
    create.resolve(CHECKOUT)
    expect(await p).toBe(false)
    expect(h.opened).toEqual([])
  })
})

describe('canReopen', () => {
  const base = { ...TOPUP_FLOW_INITIAL, form: { checkoutUrl: CHECKOUT.checkout_url, fields: {} }, expiresAt: 1_000_000 }
  it('needs a form, a still-valid order and no open window', () => {
    expect(canReopen({ ...base, phase: 'waiting', windowClosedEarly: true }, 0)).toBe(true)
    expect(canReopen({ ...base, phase: 'waiting', windowClosedEarly: true }, 1_000_000 - TOPUP_REOPEN_MARGIN_MS + 1)).toBe(false)
    expect(canReopen({ ...base, phase: 'checkout' }, 0)).toBe(false)
    expect(canReopen({ ...base, phase: 'creating' }, 0)).toBe(false)
    expect(canReopen({ ...base, phase: 'paid' }, 0)).toBe(false)
    expect(canReopen({ ...base, phase: 'cancelled' }, 0)).toBe(true)
    expect(canReopen({ ...base, phase: 'untracked' }, 0)).toBe(true)
    expect(canReopen({ ...base, form: null, phase: 'cancelled' }, 0)).toBe(false)
    expect(canReopen({ ...base, phase: 'error', error: { message: 'x', code: null, retry: 'checkout' } }, 0)).toBe(true)
    expect(canReopen({ ...base, phase: 'error', error: { message: 'x', code: 'forbidden', retry: null } }, 0)).toBe(false)
  })
})
