// Top-up (Nạp credit) over the canvasapp gateway: api.ts normalization with a fake transport, the checkout bridge
// wrapper, and the URL / form rules duplicated in electron/main.cjs. Never touches the live canvasapp API.
import { describe, expect, it } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'
import { checkoutUrlAllowed, parsePaymentReturn } from '../../core/topup'
import {
  CanvasappError,
  createCanvasappApi,
  creditHistoryPath,
  normalizeCreditHistory,
  normalizeTopupCheckout,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../canvasapp/api'
import { openCheckout, type BridgeCheckoutResponse, type CanvasappBridge, type CheckoutArgs } from '../canvasapp/transport'

function fakeTransport(answer: (req: TransportRequest) => TransportResponse) {
  const calls: TransportRequest[] = []
  const transport: Transport = {
    available: async () => ({ ok: true }),
    request: async (req) => {
      calls.push(req)
      return answer(req)
    },
  }
  return { transport, calls, api: createCanvasappApi(transport) }
}

const json = (body: unknown, status = 200): TransportResponse => ({ status, contentType: 'application/json', json: body })

const CHECKOUT = {
  checkout_url: 'https://pay.sepay.vn/v1/checkout/init',
  fields: { merchant: 'CANVAS', order_amount: 50000, order_invoice_number: 'TOP123', signature: 'abc==', flag: true },
  topup_order: 'TOP123',
}

describe('api: top-up', () => {
  it('authState exposes topup_enabled', async () => {
    const f = fakeTransport(() => json({ authenticated: true, topup_enabled: true }))
    expect(await f.api.authState()).toMatchObject({ authenticated: true, topup_enabled: true })
  })

  it('createTopup posts the amount and normalizes the checkout form', async () => {
    const f = fakeTransport(() => json(CHECKOUT))
    const r = await f.api.createTopup(50000)
    expect(f.calls).toEqual([{ method: 'POST', path: '/api/payments/topups', json: { amount_vnd: 50000 } }])
    expect(r.checkout_url).toBe('https://pay.sepay.vn/v1/checkout/init')
    expect(r.fields).toEqual({ merchant: 'CANVAS', order_amount: '50000', order_invoice_number: 'TOP123', signature: 'abc==', flag: 'true' })
    expect(r.order_id).toBe('TOP123')
  })

  it('createTopup refuses bad amounts before calling canvasapp', async () => {
    const f = fakeTransport(() => json(CHECKOUT))
    for (const bad of [9000, 50500, 10_001_000, 50000.5, Number.NaN, -1]) await expect(f.api.createTopup(bad)).rejects.toMatchObject({ code: 'bad-request' })
    expect(f.calls.length).toBe(0)
  })

  it('checkout responses with a wrong shape are refused', () => {
    expect(() => normalizeTopupCheckout(null)).toThrow(CanvasappError)
    expect(() => normalizeTopupCheckout({ fields: {} })).toThrow(/checkout_url/)
    expect(() => normalizeTopupCheckout({ checkout_url: 'https://pay.sepay.vn/', fields: [] })).toThrow(/fields/)
    expect(() => normalizeTopupCheckout({ checkout_url: 'https://pay.sepay.vn/', fields: { 'a"><script>': 'x' } })).toThrow(/tên field/)
    expect(() => normalizeTopupCheckout({ checkout_url: 'https://pay.sepay.vn/', fields: { a: { nested: 1 } } })).toThrow(/giá trị/)
    expect(() => normalizeTopupCheckout({ checkout_url: 'https://pay.sepay.vn/', fields: { a: 'x'.repeat(5000) } })).toThrow(/giá trị/)
    expect(normalizeTopupCheckout({ checkout_url: ' https://pay.sepay.vn/ ', fields: {} })).toMatchObject({ checkout_url: 'https://pay.sepay.vn/', order_id: null })
    expect(normalizeTopupCheckout({ checkout_url: 'https://pay.sepay.vn/', fields: {}, order_id: '../x' }).order_id).toBeNull()
  })

  it('createTopup maps HTTP errors like the rest (401 → login-required)', async () => {
    const f = fakeTransport(() => json({ detail: 'Not authenticated' }, 401))
    await expect(f.api.createTopup(50000)).rejects.toMatchObject({ code: 'login-required' })
    const g = fakeTransport(() => json({ detail: 'Top-up disabled' }, 403))
    await expect(g.api.createTopup(50000)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('Top-up disabled') })
  })

  it('getTopup reads and normalizes the order status', async () => {
    const f = fakeTransport(() => json({ status: ' PAID ', amount_vnd: '50000', credits: 50 }))
    expect(await f.api.getTopup('TOP123')).toMatchObject({ status: 'paid', amount_vnd: 50000, credits: 50 })
    expect(f.calls[0]).toEqual({ method: 'GET', path: '/api/payments/topups/TOP123' })
    await expect(f.api.getTopup('../me')).rejects.toMatchObject({ code: 'bad-request' })
    expect(f.calls.length).toBe(1)
    const g = fakeTransport(() => json({ amount_vnd: 1 }))
    await expect(g.api.getTopup('x')).rejects.toMatchObject({ code: 'bad-response' })
  })

  it('creditHistory builds a safe query and normalizes the page', async () => {
    const f = fakeTransport(() =>
      json({
        balance: '120.5',
        items: [
          { type: 'topup', description: 'Nạp 50.000đ', status: 'paid', delta: 50, amount_vnd: 50000, created_at: '2026-10-02T03:00:00Z' },
          { type: 'video', description: 'Seedance', delta: '-10', created_at: '2026-10-02T04:00:00Z' },
          'junk',
        ],
        next_offset: 20,
      }),
    )
    const page = await f.api.creditHistory({ kind: 'topup', offset: 0, limit: 20 })
    expect(f.calls[0]).toEqual({ method: 'GET', path: '/api/credits/history?kind=topup&offset=0&limit=20' })
    expect(page).toEqual({
      balance: 120.5,
      next_offset: 20,
      items: [
        { type: 'topup', description: 'Nạp 50.000đ', status: 'paid', delta: 50, amount_vnd: 50000, created_at: '2026-10-02T03:00:00Z' },
        { type: 'video', description: 'Seedance', status: null, delta: -10, amount_vnd: null, created_at: '2026-10-02T04:00:00Z' },
      ],
    })
  })

  it('history paths are clamped and kinds are checked', () => {
    expect(creditHistoryPath()).toBe('/api/credits/history?kind=all&offset=0&limit=20')
    expect(creditHistoryPath({ offset: -5, limit: 1000 })).toBe('/api/credits/history?kind=all&offset=0&limit=100')
    expect(creditHistoryPath({ offset: 40.7, limit: 0 })).toBe('/api/credits/history?kind=all&offset=40&limit=20')
    expect(() => creditHistoryPath({ kind: 'all&x=1' as never })).toThrow(CanvasappError)
  })

  it('history: no next page, bare arrays, wrong shapes', () => {
    expect(normalizeCreditHistory({ items: [], next_offset: null })).toEqual({ balance: null, items: [], next_offset: null })
    expect(normalizeCreditHistory({ items: [], next_offset: -1 }).next_offset).toBeNull()
    expect(normalizeCreditHistory([{ type: 'refund', delta: 5 }]).items[0]).toMatchObject({ type: 'refund', delta: 5 })
    expect(() => normalizeCreditHistory({ balance: 3 })).toThrow(CanvasappError)
  })
})

// ---------------------------------------------------------------------------------------------

function bridgeWith(checkout?: (args: CheckoutArgs) => Promise<BridgeCheckoutResponse>) {
  const seen: CheckoutArgs[] = []
  const bridge: CanvasappBridge = {
    status: async () => ({ ok: true, authenticated: true }),
    login: async () => ({ ok: true, authenticated: true }),
    logout: async () => ({ ok: true }),
    request: async () => ({ ok: false, code: 'not-allowed', message: 'no' }),
  }
  if (checkout)
    bridge.checkout = async (args) => {
      seen.push(args)
      return checkout(args)
    }
  return { bridge, seen }
}

const ARGS: CheckoutArgs = { checkoutUrl: 'https://pay.sepay.vn/v1/checkout/init', fields: { a: '1' } }

describe('openCheckout (desktop bridge)', () => {
  it('passes the form through and returns the result', async () => {
    const b = bridgeWith(async () => ({ ok: true, result: 'success', orderId: 'TOP123' }))
    expect(await openCheckout(ARGS, () => b.bridge)).toEqual({ result: 'success', orderId: 'TOP123', blockedHost: null })
    expect(b.seen).toEqual([ARGS])
  })

  it('closed / timeout / weird answers', async () => {
    expect(await openCheckout(ARGS, () => bridgeWith(async () => ({ ok: true, result: 'closed', orderId: null, blockedHost: 'evil.com' })).bridge)).toEqual({
      result: 'closed',
      orderId: null,
      blockedHost: 'evil.com',
    })
    expect((await openCheckout(ARGS, () => bridgeWith(async () => ({ ok: true, result: 'timeout', orderId: null })).bridge)).result).toBe('timeout')
    const weird = await openCheckout(ARGS, () => bridgeWith(async () => ({ ok: true, result: 'paid' as never, orderId: '../x' })).bridge)
    expect(weird).toEqual({ result: 'error', orderId: null, blockedHost: null })
  })

  it('refuses a non-SePay URL without calling the bridge', async () => {
    const b = bridgeWith(async () => ({ ok: true, result: 'success', orderId: 'x' }))
    await expect(openCheckout({ ...ARGS, checkoutUrl: 'https://evil.example/pay' }, () => b.bridge)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(openCheckout({ ...ARGS, checkoutUrl: 'http://pay.sepay.vn/' }, () => b.bridge)).rejects.toMatchObject({ code: 'forbidden' })
    expect(b.seen.length).toBe(0)
  })

  it('no bridge / old desktop build / bridge errors', async () => {
    await expect(openCheckout(ARGS, () => null)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(openCheckout(ARGS, () => bridgeWith().bridge)).rejects.toMatchObject({ code: 'unsupported' })
    await expect(openCheckout(ARGS, () => bridgeWith(async () => ({ ok: false, code: 'busy', message: 'Đang mở' })).bridge)).rejects.toMatchObject({ code: 'busy' })
    await expect(openCheckout(ARGS, () => bridgeWith(async () => ({ ok: false, code: 'refused', message: 'x' })).bridge)).rejects.toMatchObject({ code: 'forbidden' })
  })
})

// ---------------------------------------------------------------------------------------------
// electron/main.cjs keeps its own copy of the rules (main never trusts the renderer). Run that block as-is.

interface MainRules {
  checkoutUrlAllowed(u: unknown): boolean
  parsePaymentReturn(u: unknown): { result: string; orderId: string } | null
  checkoutFieldList(f: unknown): [string, string][] | null
  checkoutPageUrl(url: string, fields: [string, string][]): string
  classifyCheckoutNavigation(u: unknown): { kind: 'return'; ret: { result: string; orderId: string } } | { kind: 'allow' } | { kind: 'deny'; host: string }
  checkoutExternalAllowed(u: unknown): boolean
  checkoutPermissionAllowed(p: string): boolean
  CANVASAPP_DENIED_PERMISSIONS: Set<string>
}

function loadMainRules(): MainRules {
  const m = /\/\/ <checkout-rules>[^\n]*\n([\s\S]*?)\/\/ <\/checkout-rules>/.exec(mainSource)
  if (!m) throw new Error('checkout-rules block not found in electron/main.cjs')
  const fakeCrypto = { createHash: () => ({ update: () => ({ digest: () => 'HASH' }) }) }
  const factory = new Function(
    'crypto',
    'CANVASAPP_ORIGIN',
    'CANVASAPP_ID_RE',
    `${m[1]}\nreturn { checkoutUrlAllowed, parsePaymentReturn, checkoutFieldList, checkoutPageUrl, classifyCheckoutNavigation, checkoutExternalAllowed, checkoutPermissionAllowed, CANVASAPP_DENIED_PERMISSIONS }`,
  ) as (c: unknown, origin: string, idRe: RegExp) => MainRules
  return factory(fakeCrypto, 'https://canvasapp.io.vn', /^[A-Za-z0-9_-]{1,80}$/)
}

describe('electron main: checkout rules', () => {
  const main = loadMainRules()

  const URLS: unknown[] = [
    'https://pay.sepay.vn/v1/checkout/init',
    'https://sepay.vn/x',
    'https://PAY.SEPAY.VN/x',
    'http://pay.sepay.vn/',
    'https://evilsepay.vn/',
    'https://sepay.vn.evil.com/',
    'https://u:p@pay.sepay.vn/',
    'https://pay.sepay.vn@evil.com/',
    'https://pay.sepay.vn:8443/',
    'https://pay.sepay.vn./',
    'javascript:alert(1)//sepay.vn',
    'data:text/html,x',
    ' https://pay.sepay.vn/',
    'https://pay.sepay.vn\\@evil.com/',
    'https://canvasapp.io.vn/?payment=success&topup_order=T1',
    'https://canvasapp.io.vn/?payment=cancel&topup_order=T1',
    'https://canvasapp.io.vn/?payment=odd&topup_order=T1',
    'https://canvasapp.io.vn/?payment=success',
    'https://canvasapp.io.vn/?payment=success&topup_order=../x',
    'http://canvasapp.io.vn/?payment=success&topup_order=T1',
    'https://canvasapp.io.vn.evil.com/?payment=success&topup_order=T1',
    // IDN / Unicode / parser tricks: both copies must agree
    'https://ѕepay.vn/',
    'https://pay.sepay.vn。evil.com/',
    'https://pay.s­epay.vn/',
    'https://pay.sepay.vn​/',
    'https://ｓｅｐａｙ.vn/',
    'https://evil.com#.sepay.vn',
    'https://evil.com?.sepay.vn',
    'https://evil.com/.sepay.vn',
    'https://evil.com%2F.sepay.vn/',
    'https://xn--sepay-xyz.vn/',
    'HTTPS://pay.sepay.vn/',
    'https:pay.sepay.vn/',
    'https:/pay.sepay.vn/',
    'https://pay.sepay.vn:443/',
    'https://[::1]/',
    'https://127.0.0.1/',
    'https://canvasapp.io.vn:443/?payment=success&topup_order=T1',
    'https://canvasapp.io.vn/?payment=success&topup_order=T1&topup_order=T2',
    'https://canvasapp.io.vn/#?payment=success&topup_order=T1',
    '',
    null,
    7,
  ]

  it('same answers as core/topup for every URL', () => {
    for (const u of URLS) {
      expect(main.checkoutUrlAllowed(u), String(u)).toBe(checkoutUrlAllowed(u))
      expect(main.parsePaymentReturn(u), String(u)).toEqual(parsePaymentReturn(u))
    }
  })

  it('look-alike hosts are refused by both copies', () => {
    for (const u of ['https://ѕepay.vn/', 'https://pay.sepay.vn。evil.com/', 'https://evil.com#.sepay.vn', 'https://evil.com?.sepay.vn', 'https://xn--sepay-xyz.vn/', 'https://canvasapp.io.vn/']) {
      expect(main.checkoutUrlAllowed(u), u).toBe(false)
      expect(checkoutUrlAllowed(u), u).toBe(false)
    }
    // the WHATWG parser maps fullwidth letters to the real host: still sepay.vn itself
    expect(checkoutUrlAllowed('https://ｓｅｐａｙ.vn/')).toBe(true)
    expect(parsePaymentReturn('https://canvasapp.io.vn/#?payment=success&topup_order=T1')).toBeNull()
  })

  it('navigation policy: return / allow / deny', () => {
    expect(main.classifyCheckoutNavigation('https://canvasapp.io.vn/?payment=success&topup_order=T1')).toEqual({ kind: 'return', ret: { result: 'success', orderId: 'T1' } })
    expect(main.classifyCheckoutNavigation('https://pay.sepay.vn/v1/qr')).toEqual({ kind: 'allow' })
    expect(main.classifyCheckoutNavigation('https://canvasapp.io.vn/credits')).toEqual({ kind: 'allow' })
    expect(main.classifyCheckoutNavigation('https://evil.com/x?card=1')).toEqual({ kind: 'deny', host: 'evil.com' })
    expect(main.classifyCheckoutNavigation('https://pay.sepay.vn:8443/')).toEqual({ kind: 'deny', host: 'pay.sepay.vn' })
    expect(main.classifyCheckoutNavigation('http://pay.sepay.vn/')).toEqual({ kind: 'deny', host: 'pay.sepay.vn' })
    expect(main.classifyCheckoutNavigation('vcbdigibank://pay?x=1')).toMatchObject({ kind: 'deny' })
    expect(main.classifyCheckoutNavigation('data:text/html,x')).toMatchObject({ kind: 'deny' })
    expect(main.classifyCheckoutNavigation('about:blank')).toMatchObject({ kind: 'deny' })
    expect(main.classifyCheckoutNavigation('https://www.canvasapp.io.vn/')).toMatchObject({ kind: 'deny', host: 'www.canvasapp.io.vn' })
    // diagnostics never carry the full URL
    const d = main.classifyCheckoutNavigation('https://evil.com/path?secret=abc')
    expect(JSON.stringify(d)).not.toContain('secret')
  })

  it('popups: only SePay / canvasapp links leave for the default browser', () => {
    expect(main.checkoutExternalAllowed('https://sepay.vn/huong-dan')).toBe(true)
    expect(main.checkoutExternalAllowed('https://canvasapp.io.vn/')).toBe(true)
    expect(main.checkoutExternalAllowed('https://evil.com/?amount=50000')).toBe(false)
    expect(main.checkoutExternalAllowed('http://sepay.vn/')).toBe(false)
    expect(main.checkoutExternalAllowed('mailto:x@y.z')).toBe(false)
    expect(main.checkoutExternalAllowed('file:///C:/x')).toBe(false)
  })

  it('permissions: the checkout window only gets clipboard writes; the login window never gets camera / location / devices', () => {
    expect(main.checkoutPermissionAllowed('clipboard-sanitized-write')).toBe(true)
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'hid', 'usb', 'serial', 'display-capture', 'fullscreen']) {
      expect(main.checkoutPermissionAllowed(p), p).toBe(false)
    }
    for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'hid', 'usb', 'serial', 'display-capture']) {
      expect(main.CANVASAPP_DENIED_PERMISSIONS.has(p), p).toBe(true)
    }
  })

  it('field list: strings only, safe names, bounded', () => {
    expect(main.checkoutFieldList({ a: '1', b_c: 'x y' })).toEqual([
      ['a', '1'],
      ['b_c', 'x y'],
    ])
    expect(main.checkoutFieldList({ a: 1 })).toBeNull()
    expect(main.checkoutFieldList({ 'a"': '1' })).toBeNull()
    expect(main.checkoutFieldList(['a'])).toBeNull()
    expect(main.checkoutFieldList(null)).toBeNull()
    expect(main.checkoutFieldList(Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`f${i}`, 'x'])))).toBeNull()
  })

  it('the auto-submit page escapes every value and pins its script with CSP', () => {
    const page = decodeURIComponent(
      main.checkoutPageUrl('https://pay.sepay.vn/init?a=1&b="x"', [['note', '"><script>alert(1)</script>&\'`']]).replace(/^data:text\/html;charset=utf-8,/, ''),
    )
    expect(page).toContain('action="https://pay.sepay.vn/init?a=1&amp;b=&quot;x&quot;"')
    expect(page).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39;&#96;"')
    expect(page.match(/<script>/g)?.length).toBe(1)
    expect(page).toContain("script-src &#39;sha256-HASH&#39;")
    expect(page).toContain('form-action https://sepay.vn https://*.sepay.vn https://canvasapp.io.vn')
    expect(page).toContain('method="POST"')
  })
})
