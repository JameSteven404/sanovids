// Real canvasapp balance (store/credits) with a fake desktop bridge: status transitions, throttle, dedupe, sync.
// Never touches the live canvasapp API.
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCanvasappApi, type TransportRequest } from '../../providers/canvasapp/api'
import { createDesktopTransport, type BridgeResponse, type CanvasappBridge } from '../../providers/canvasapp/transport'
import { useProviderPrefs } from '../../providers'
import { useRuns, type RunEvent } from '../runs'
import {
  CREDITS_MIN_REFRESH_MS,
  CREDITS_SYNC_INTERVAL_MS,
  createCreditsSync,
  createRealCredits,
  creditInfoFrom,
  getCreditInfo,
  useCreditInfo,
  type CreditInfo,
  type RealCreditsState,
} from '../credits'

const ok = (json: unknown, status = 200): BridgeResponse => ({ ok: true, status, contentType: 'application/json', json })

/** Fake window.bdpDesktop.canvasapp: answers /api/me with `answer(req)`; `hold()` keeps answers until `release()`. */
function fakeBridge(answer: (req: TransportRequest) => BridgeResponse = () => ok({ credits_balance: 1234 })) {
  const calls: TransportRequest[] = []
  let held = false
  const waiting: (() => void)[] = []
  const state = { answer }
  const bridge: CanvasappBridge = {
    status: async () => ({ ok: true, authenticated: true }),
    login: async () => ({ ok: true, authenticated: true }),
    logout: async () => ({ ok: true }),
    request: async (req) => {
      calls.push(req)
      if (held) await new Promise<void>((r) => waiting.push(r))
      return state.answer(req)
    },
  }
  return {
    bridge,
    calls,
    state,
    hold: () => {
      held = true
    },
    release: () => {
      held = false
      for (const r of waiting.splice(0)) r()
    },
  }
}

function setup(answer?: (req: TransportRequest) => BridgeResponse, bridgeOn = true) {
  const fake = fakeBridge(answer)
  let t = 1_000_000
  const api = createCanvasappApi(createDesktopTransport(() => (bridgeOn ? fake.bridge : null)))
  const rc = createRealCredits({ api: () => api, now: () => t })
  return { ...fake, rc, s: () => rc.store.getState(), advance: (ms: number) => (t += ms), now: () => t }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('real credits: status transitions', () => {
  it('idle → loading → ok, with the balance and when it was confirmed', async () => {
    const f = setup()
    expect(f.s()).toMatchObject({ status: 'idle', balance: null, updatedAt: null, refreshing: false })
    f.hold()
    const p = f.rc.refresh()
    expect(f.s()).toMatchObject({ status: 'loading', balance: null, refreshing: true })
    f.release()
    const done = await p
    expect(done).toMatchObject({ status: 'ok', balance: 1234, updatedAt: f.now(), error: null, refreshing: false })
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/me'])
  })

  it('a background re-read keeps "ok" (no flicker) and only flags refreshing', async () => {
    const f = setup()
    await f.rc.refresh()
    f.hold()
    const p = f.rc.refresh({ force: true })
    expect(f.s()).toMatchObject({ status: 'ok', balance: 1234, refreshing: true })
    f.state.answer = () => ok({ credits_balance: 1214 })
    f.release()
    expect(await p).toMatchObject({ status: 'ok', balance: 1214, refreshing: false })
  })

  it('401 → login-required (balance cleared), then ok again after logging in', async () => {
    const f = setup(() => ok({ detail: 'Not authenticated' }, 401))
    const s = await f.rc.refresh()
    expect(s).toMatchObject({ status: 'login-required', balance: null })
    expect(s.error).toMatch(/đăng nhập/i)

    f.state.answer = () => ok({ credits_balance: 50 })
    expect(await f.rc.refresh({ force: true })).toMatchObject({ status: 'ok', balance: 50, error: null })

    // session expires later: the old number must not stay on screen
    f.state.answer = () => ok({ detail: 'expired' }, 401)
    expect(await f.rc.refresh({ force: true })).toMatchObject({ status: 'login-required', balance: null })
  })

  it('outside the desktop app → unavailable, without sending anything', async () => {
    const f = setup(undefined, false)
    const s = await f.rc.refresh()
    expect(s).toMatchObject({ status: 'unavailable', balance: null })
    expect(s.error).toMatch(/desktop/)
    expect(f.calls).toHaveLength(0)
  })

  it('network / server trouble → error, the last confirmed balance is kept with its time', async () => {
    const f = setup()
    await f.rc.refresh()
    const confirmedAt = f.s().updatedAt
    f.advance(CREDITS_MIN_REFRESH_MS)
    f.state.answer = () => ({ ok: false, code: 'network', message: 'offline' })
    expect(await f.rc.refresh()).toMatchObject({ status: 'error', balance: 1234, updatedAt: confirmedAt, error: 'offline' })

    f.state.answer = () => ok({ detail: 'boom' }, 500)
    const s = await f.rc.refresh({ force: true })
    expect(s).toMatchObject({ status: 'error', balance: 1234 })
    expect(s.error).toMatch(/máy chủ/)
  })

  it('an answer without a usable balance is an error, never a made-up number', async () => {
    const f = setup(() => ok({ email: 'x@y.z' }))
    expect(await f.rc.refresh()).toMatchObject({ status: 'error', balance: null })
    f.state.answer = () => ok({ credits_balance: '377' })
    expect(await f.rc.refresh({ force: true })).toMatchObject({ status: 'ok', balance: 377 })
    f.state.answer = () => ok({ credits_balance: 'nhiều' })
    expect(await f.rc.refresh({ force: true })).toMatchObject({ status: 'error', balance: null })
  })

  it('reset forgets the balance and ignores a read still in flight', async () => {
    const f = setup()
    await f.rc.refresh()
    f.hold()
    const p = f.rc.refresh({ force: true })
    f.rc.reset()
    expect(f.s()).toMatchObject({ status: 'idle', balance: null, refreshing: false })
    f.release()
    await p
    expect(f.s()).toMatchObject({ status: 'idle', balance: null })
    // and the throttle starts over
    await f.rc.refresh()
    expect(f.s()).toMatchObject({ status: 'ok', balance: 1234 })
  })
})

describe('real credits: throttle and dedupe', () => {
  it('no second read within 15 s unless forced', async () => {
    const f = setup()
    await f.rc.refresh()
    await f.rc.refresh()
    expect(f.calls).toHaveLength(1)
    f.advance(CREDITS_MIN_REFRESH_MS - 1)
    await f.rc.refresh()
    expect(f.calls).toHaveLength(1)
    f.advance(1)
    await f.rc.refresh()
    expect(f.calls).toHaveLength(2)
    await f.rc.refresh({ force: true })
    expect(f.calls).toHaveLength(3)
  })

  it('failed reads count for the throttle too (a logged-out app is not hammered)', async () => {
    const f = setup(() => ok({}, 401))
    await f.rc.refresh()
    await f.rc.refresh()
    expect(f.calls).toHaveLength(1)
  })

  it('concurrent calls share one request', async () => {
    const f = setup()
    f.hold()
    const a = f.rc.refresh()
    const b = f.rc.refresh()
    expect(b).toBe(a)
    f.release()
    await Promise.all([a, b])
    expect(f.calls).toHaveLength(1)
  })

  it('forced calls during a read queue exactly one more read after it', async () => {
    const f = setup()
    f.hold()
    const first = f.rc.refresh()
    const x = f.rc.refresh({ force: true })
    const y = f.rc.refresh({ force: true })
    expect(y).toBe(x)
    expect(f.rc.refresh()).toBe(first) // not forced: the read in flight is enough
    f.state.answer = () => ok({ credits_balance: 1200 }) // e.g. a job was just charged
    f.release()
    await first
    await flush()
    expect(await x).toMatchObject({ status: 'ok', balance: 1200 })
    expect(f.calls).toHaveLength(2)
  })
})

describe('real credits: background sync', () => {
  function env(visibility: 'visible' | 'hidden' = 'visible') {
    const win = new EventTarget()
    const doc = Object.assign(new EventTarget(), { visibilityState: visibility as string })
    return { win, doc }
  }

  function syncSetup(active = true) {
    const refresh = vi.fn(async (_opts?: { force?: boolean }) => undefined)
    const e = env()
    const activeListeners = new Set<() => void>()
    const jobListeners = new Set<(ev: RunEvent) => void>()
    const state = { active }
    const sync = createCreditsSync({
      refresh,
      isActive: () => state.active,
      subscribeActive: (l) => {
        activeListeners.add(l)
        return () => activeListeners.delete(l)
      },
      subscribeJobs: (l) => {
        jobListeners.add(l)
        return () => jobListeners.delete(l)
      },
      env: () => ({ window: e.win, document: e.doc }),
    })
    return {
      refresh,
      sync,
      ...e,
      setActive: (v: boolean) => {
        state.active = v
        for (const l of activeListeners) l()
      },
      job: (ev: RunEvent) => {
        for (const l of jobListeners) l(ev)
      },
      listenerCount: () => activeListeners.size + jobListeners.size,
    }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes on start, on focus, when visible again and every 60 s while visible — only for canvasapp', () => {
    vi.useFakeTimers()
    const s = syncSetup(true)
    const stop = s.sync.start()
    expect(s.refresh).toHaveBeenCalledTimes(1)
    expect(s.refresh).toHaveBeenLastCalledWith()

    s.win.dispatchEvent(new Event('focus'))
    expect(s.refresh).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(CREDITS_SYNC_INTERVAL_MS)
    expect(s.refresh).toHaveBeenCalledTimes(3)

    s.doc.visibilityState = 'hidden'
    s.doc.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(CREDITS_SYNC_INTERVAL_MS * 3)
    expect(s.refresh).toHaveBeenCalledTimes(3) // hidden: no background reads

    s.doc.visibilityState = 'visible'
    s.doc.dispatchEvent(new Event('visibilitychange'))
    expect(s.refresh).toHaveBeenCalledTimes(4)

    // demo chosen: nothing is read in the background
    s.setActive(false)
    s.win.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(CREDITS_SYNC_INTERVAL_MS * 2)
    expect(s.refresh).toHaveBeenCalledTimes(4)

    // canvasapp chosen again in Settings → read
    s.setActive(true)
    expect(s.refresh).toHaveBeenCalledTimes(5)
    stop()
  })

  it('forces a read after canvasapp job events, whatever the active provider; ignores demo jobs', () => {
    const s = syncSetup(false)
    const stop = s.sync.start()
    expect(s.refresh).not.toHaveBeenCalled()
    s.job({ type: 'submitted', takeId: 't1', provider: 'canvasapp' })
    expect(s.refresh).toHaveBeenLastCalledWith({ force: true })
    s.job({ type: 'completed', takeId: 't1', provider: 'canvasapp' })
    s.job({ type: 'failed', takeId: 't2', provider: 'canvasapp' })
    expect(s.refresh).toHaveBeenCalledTimes(3)
    s.job({ type: 'completed', takeId: 't3', provider: 'mock' })
    expect(s.refresh).toHaveBeenCalledTimes(3)
    stop()
  })

  it('is ref-counted: listeners and the timer go away with the last stop', () => {
    vi.useFakeTimers()
    const s = syncSetup(true)
    const stopA = s.sync.start()
    const stopB = s.sync.start()
    expect(s.refresh).toHaveBeenCalledTimes(1) // set up once
    stopA()
    stopA() // twice is harmless
    expect(s.sync.running()).toBe(true)
    s.win.dispatchEvent(new Event('focus'))
    expect(s.refresh).toHaveBeenCalledTimes(2)
    stopB()
    expect(s.sync.running()).toBe(false)
    expect(s.listenerCount()).toBe(0)
    s.win.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(CREDITS_SYNC_INTERVAL_MS * 2)
    s.job({ type: 'completed', takeId: 't', provider: 'canvasapp' })
    expect(s.refresh).toHaveBeenCalledTimes(2)
  })
})

describe('credit info for the UI', () => {
  const real = (over: Partial<RealCreditsState> = {}): RealCreditsState => ({
    balance: null,
    status: 'idle',
    updatedAt: null,
    error: null,
    refreshing: false,
    ...over,
  })

  it('demo: the local play-money balance, always ok', () => {
    const info = creditInfoFrom('demo', 1000, real({ balance: 5, status: 'login-required' }))
    expect(info).toMatchObject({ kind: 'demo', balance: 1000, status: 'ok', error: null, updatedAt: null })
  })

  it('canvasapp: the real balance; unknown until the first answer', () => {
    expect(creditInfoFrom('canvasapp', 1000, real())).toMatchObject({ kind: 'canvasapp', balance: null, status: 'loading' })
    expect(creditInfoFrom('canvasapp', 1000, real({ status: 'ok', balance: 377, updatedAt: 5 }))).toMatchObject({ balance: 377, status: 'ok', updatedAt: 5 })
    expect(creditInfoFrom('canvasapp', 1000, real({ status: 'login-required', error: 'x' }))).toMatchObject({ balance: null, status: 'login-required', error: 'x' })
  })

  it('kind follows the active provider (canvasapp only with the desktop bridge)', () => {
    const g = globalThis as { window?: unknown }
    try {
      useRuns.setState({ credits: 1000 })
      useProviderPrefs.setState({ provider: 'canvasapp' })
      expect(getCreditInfo()).toMatchObject({ kind: 'demo', balance: 1000 }) // web: canvasapp cannot run here
      g.window = { bdpDesktop: { canvasapp: { request: async () => ok({}) } } }
      expect(getCreditInfo()).toMatchObject({ kind: 'canvasapp', balance: null, status: 'loading' })
      useProviderPrefs.setState({ provider: 'mock' })
      expect(getCreditInfo().kind).toBe('demo')
    } finally {
      useProviderPrefs.setState({ provider: 'mock' })
      delete g.window
    }
  })

  it('useCreditInfo renders the demo wallet by default', () => {
    // Server rendering reads the stores' initial state: a fresh demo wallet holds DEMO_CREDITS_DEFAULT.
    let seen: CreditInfo | null = null
    const Probe = () => {
      seen = useCreditInfo()
      return null
    }
    renderToString(createElement(Probe))
    expect(seen).toMatchObject({ kind: 'demo', balance: 1000, status: 'ok' })
  })
})
