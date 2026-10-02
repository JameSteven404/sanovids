// The app's top-up flow (appFlow.ts) and the gateway it talks to when the provider changes: an order in flight stays
// on its gateway; once it is over, an order of the other gateway is let go, so development mode never sends a request
// to the real canvasapp because of an old order (and the sheet never labels one gateway's credits as the other's).
// The "real" gateway here is a recording fake desktop bridge — nothing leaves the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/imageStore', () => ({
  putBlob: vi.fn(async () => 'x'),
  getBlob: vi.fn(async () => null),
  getUrl: vi.fn(async () => null),
  cachedUrl: () => null,
  deleteMedia: vi.fn(async () => undefined),
  dataUrlToBlob: () => new Blob(),
  useMediaUrl: () => null,
}))

import { activeProviderId, useProviderPrefs } from '../../../providers'
import { memoryStorage } from '../../../providers/canvasapp/adapter'
import type { BridgeResponse, CanvasappBridge } from '../../../providers/canvasapp/transport'
import { answerDevCheckout, closeDevPrompts, createDevCanvasapp, DEV_PAYMENT_DELAY_MS, memoryBlobStore, setDevServer, useDevPrompts, type DevCanvasapp } from '../../../providers/dev'
import { resetRealCredits } from '../../../store/credits'
import { useUI } from '../../../store/ui'
import { flowGateway, topupFlow } from '../appFlow'
import { TOPUP_FLOW_INITIAL } from '../topupFlow'

const g = globalThis as { window?: unknown }

const ok = (json: unknown): BridgeResponse => ({ ok: true, status: 200, contentType: 'application/json', json })

/** The real canvasapp gateway, faked: records every request, pays order TOP1 at once. */
function realGateway() {
  const calls: string[] = []
  const bridge: CanvasappBridge = {
    status: async () => ({ ok: true, authenticated: true }),
    login: async () => ({ ok: true, authenticated: true }),
    logout: async () => ({ ok: true }),
    request: async (req) => {
      calls.push(`${req.method} ${req.path}`)
      if (req.path === '/api/auth/state') return ok({ authenticated: true, topup_enabled: true })
      if (req.path === '/api/me') return ok({ credits_balance: 5000 })
      if (req.method === 'POST' && req.path === '/api/payments/topups') {
        return ok({ checkout_url: 'https://pay.sepay.vn/v1/checkout/init', fields: { merchant: 'CANVAS', order_amount: '50000', signature: 'abc' }, order_id: 'TOP1' })
      }
      if (req.path.startsWith('/api/payments/topups/')) return ok({ order_id: 'TOP1', status: 'paid', amount_vnd: 50_000 })
      return { ok: true, status: 404, contentType: 'application/json', json: { detail: 'Not found' } }
    },
    checkout: async () => ({ ok: true, result: 'success', orderId: 'TOP1', blockedHost: null }),
  }
  return { bridge, calls }
}

let real: ReturnType<typeof realGateway>
let server: DevCanvasapp
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const phase = () => topupFlow.store.getState().phase
const toastTexts = () => useUI.getState().toasts.map((t) => t.text)

beforeEach(() => {
  vi.useFakeTimers()
  real = realGateway()
  g.window = { bdpDesktop: { canvasapp: real.bridge } }
  server = createDevCanvasapp({ storage: memoryStorage(), blobs: memoryBlobStore() })
  server.setConfig({ latencyMs: 0 })
  server.login()
  setDevServer(server)
  resetRealCredits()
  useUI.setState({ toasts: [] })
})

afterEach(async () => {
  closeDevPrompts()
  topupFlow.dispose()
  topupFlow.store.setState({ ...TOPUP_FLOW_INITIAL })
  useProviderPrefs.setState({ provider: 'dev' })
  await run(100)
  vi.useRealTimers()
  setDevServer(null)
  resetRealCredits()
  delete g.window
})

describe('top-up flow across a provider change', () => {
  it('a finished real order is let go when the user switches to dev: the sheet then talks to the simulation only', async () => {
    useProviderPrefs.getState().setProvider('canvasapp')
    expect(activeProviderId()).toBe('canvasapp')
    expect(await topupFlow.start(50_000)).toBe(true)
    await run(4_000)
    expect(phase()).toBe('paid')
    expect(flowGateway().id).toBe('canvasapp') // still the active gateway: the sheet shows the paid order

    useProviderPrefs.getState().setProvider('dev')
    expect(phase()).toBe('idle')
    expect(flowGateway()).toMatchObject({ id: 'dev', simulated: true })
    const before = real.calls.length
    expect(await flowGateway().api.authState()).toMatchObject({ authenticated: true }) // what the sheet's probe does
    expect(real.calls.length).toBe(before) // never the real site
  })

  it('an order in flight stays on its gateway until it ends, then it is announced and let go', async () => {
    expect(activeProviderId()).toBe('dev')
    const started = topupFlow.start(50_000)
    await vi.waitFor(() => expect(useDevPrompts.getState().checkout).not.toBeNull())
    useProviderPrefs.getState().setProvider('canvasapp')
    expect(phase()).toBe('checkout')
    expect(flowGateway().id).toBe('dev') // money may be on its way: keep following THIS order
    answerDevCheckout('success')
    expect(await started).toBe(true)
    await run(DEV_PAYMENT_DELAY_MS + 4_000)
    expect(server.balance()).toBe(1050)
    // over → announced (the sheet will not show it) and let go
    expect(toastTexts().some((t) => t.includes('+50 credit') && t.includes('tài khoản giả lập'))).toBe(true)
    expect(phase()).toBe('idle')
    expect(flowGateway().id).toBe('canvasapp')
    expect(real.calls.filter((c) => c.includes('/api/payments/topups'))).toEqual([]) // the dev order never went to the real site
  })

  it('an order of the active gateway stays on screen when it ends (nothing changes for the usual case)', async () => {
    const started = topupFlow.start(50_000)
    await vi.waitFor(() => expect(useDevPrompts.getState().checkout).not.toBeNull())
    answerDevCheckout('success')
    await started
    await run(DEV_PAYMENT_DELAY_MS + 4_000)
    expect(phase()).toBe('paid')
    expect(flowGateway().id).toBe('dev')
  })
})
