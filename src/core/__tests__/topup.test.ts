// Pure top-up rules (docs/SPEC-v2.md §10). No network.
import { describe, expect, it } from 'vitest'
import {
  checkoutUrlAllowed,
  creditsForAmount,
  formatVnd,
  isTopupHistoryKind,
  mapTopupStatus,
  parsePaymentReturn,
  TOPUP_ORDER_TTL_MS,
  TOPUP_PRESETS,
  validateTopupAmount,
} from '../topup'

describe('top-up amount', () => {
  it('presets are valid and convert 1 credit per 1.000đ', () => {
    expect(TOPUP_PRESETS).toEqual([30000, 50000, 100000, 200000])
    for (const p of TOPUP_PRESETS) expect(validateTopupAmount(p)).toEqual({ ok: true, amount: p, credits: p / 1000, error: null })
    expect(creditsForAmount(50000)).toBe(50)
    expect(creditsForAmount(-5)).toBe(0)
    expect(TOPUP_ORDER_TTL_MS).toBe(600000)
  })

  it.each([
    ['50000', 50000],
    ['50.000', 50000],
    ['50,000', 50000],
    ['50 000', 50000],
    [' 50k ', 50000],
    ['50K', 50000],
    ['50.000đ', 50000],
    ['50000 VND', 50000],
    ['1,5tr', 1500000],
    ['2 triệu', 2000000],
    ['10.000.000', 10000000],
    ['10000', 10000],
  ])('accepts %j', (input, amount) => {
    expect(validateTopupAmount(input)).toEqual({ ok: true, amount, credits: amount / 1000, error: null })
  })

  it('explains what is wrong', () => {
    expect(validateTopupAmount('')).toMatchObject({ ok: false, amount: null, credits: null, error: 'Nhập số tiền muốn nạp.' })
    expect(validateTopupAmount(null).ok).toBe(false)
    for (const bad of ['abc', '50.5', '5.00.000', '1e5', '-50000', '50,00', '0x10', '50kk', '5.0000']) {
      const r = validateTopupAmount(bad)
      expect(r.ok, bad).toBe(false)
      expect(r.amount, bad).toBeNull()
      expect(r.error, bad).toMatch(/không hợp lệ/)
    }
    expect(validateTopupAmount('9.000')).toMatchObject({ ok: false, amount: 9000, error: 'Tối thiểu 10.000đ.' })
    expect(validateTopupAmount('10.001.000')).toMatchObject({ ok: false, amount: 10001000, error: expect.stringContaining('Tối đa 10.000.000đ') })
    expect(validateTopupAmount('50500')).toMatchObject({ ok: false, amount: 50500, error: 'Số tiền phải là bội số của 1.000đ.' })
    expect(validateTopupAmount(50000.5).ok).toBe(false)
    expect(validateTopupAmount(Number.NaN).ok).toBe(false)
    expect(validateTopupAmount(Infinity).ok).toBe(false)
  })

  it('formats đồng', () => {
    expect(formatVnd(50000)).toBe('50.000đ')
    expect(formatVnd(10000000)).toBe('10.000.000đ')
    expect(formatVnd(0)).toBe('0đ')
    expect(formatVnd(Number.NaN)).toBe('—')
    expect(formatVnd(null)).toBe('—')
  })

  it('knows the history kinds', () => {
    expect(isTopupHistoryKind('topup')).toBe(true)
    expect(isTopupHistoryKind('all')).toBe(true)
    expect(isTopupHistoryKind('bonus')).toBe(false)
  })
})

describe('top-up status', () => {
  it('maps every canvasapp status', () => {
    expect(mapTopupStatus('pending')).toMatchObject({ phase: 'waiting', final: false })
    expect(mapTopupStatus('paid')).toMatchObject({ phase: 'paid', final: true })
    expect(mapTopupStatus('reconciled')).toMatchObject({ phase: 'paid', final: true })
    expect(mapTopupStatus('reconcile_required')).toMatchObject({ phase: 'review', final: true })
    expect(mapTopupStatus('expired')).toMatchObject({ phase: 'expired', final: true })
    expect(mapTopupStatus('rejected')).toMatchObject({ phase: 'rejected', final: true })
    expect(mapTopupStatus(' PAID ')).toMatchObject({ phase: 'paid' })
  })

  it('unknown statuses keep polling', () => {
    expect(mapTopupStatus('refunding')).toMatchObject({ phase: 'unknown', final: false })
    expect(mapTopupStatus('refunding').label).toContain('refunding')
    expect(mapTopupStatus(undefined)).toMatchObject({ phase: 'unknown', final: false })
    expect(mapTopupStatus(42)).toMatchObject({ phase: 'unknown', final: false })
  })

  it('every label is Vietnamese text', () => {
    for (const s of ['pending', 'paid', 'reconciled', 'reconcile_required', 'expired', 'rejected', 'x']) expect(mapTopupStatus(s).label.length).toBeGreaterThan(5)
  })
})

describe('checkout URL', () => {
  it.each(['https://pay.sepay.vn/v1/checkout/init', 'https://sepay.vn/checkout', 'https://PAY.SEPAY.VN/x?y=1', 'https://a.b.sepay.vn/'])('allows %s', (url) => {
    expect(checkoutUrlAllowed(url)).toBe(true)
  })

  it.each([
    'http://pay.sepay.vn/checkout',
    'https://evilsepay.vn/checkout',
    'https://sepay.vn.evil.com/checkout',
    'https://pay.sepay.vn.evil.com/',
    'https://user:pw@pay.sepay.vn/',
    'https://pay.sepay.vn@evil.com/',
    'https://pay.sepay.vn:8443/',
    'https://pay.sepay.vn./',
    'javascript:alert(1)//sepay.vn',
    'data:text/html,<form action=https://pay.sepay.vn>',
    'file:///C:/sepay.vn',
    '//pay.sepay.vn/',
    ' https://pay.sepay.vn/',
    'https://pay.sepay.vn/\nx',
    'https://pay.sepay.vn\\@evil.com/',
    'https://canvasapp.io.vn/',
    '',
    42,
    null,
  ])('refuses %j', (url) => {
    expect(checkoutUrlAllowed(url)).toBe(false)
  })
})

describe('payment return', () => {
  it('reads the result and the order id from canvasapp URLs', () => {
    expect(parsePaymentReturn('https://canvasapp.io.vn/?payment=success&topup_order=ord_123')).toEqual({ result: 'success', orderId: 'ord_123' })
    expect(parsePaymentReturn('https://canvasapp.io.vn/credits?topup_order=A-9&payment=cancel')).toEqual({ result: 'cancel', orderId: 'A-9' })
    expect(parsePaymentReturn('https://canvasapp.io.vn/?payment=error&topup_order=x')).toEqual({ result: 'error', orderId: 'x' })
    expect(parsePaymentReturn('https://CANVASAPP.IO.VN/?payment=weird&topup_order=x')).toEqual({ result: 'error', orderId: 'x' })
  })

  it('ignores anything else', () => {
    expect(parsePaymentReturn('https://canvasapp.io.vn/?payment=success')).toBeNull()
    expect(parsePaymentReturn('https://canvasapp.io.vn/?topup_order=1')).toBeNull()
    expect(parsePaymentReturn('https://canvasapp.io.vn/?payment=success&topup_order=../x')).toBeNull()
    expect(parsePaymentReturn('http://canvasapp.io.vn/?payment=success&topup_order=1')).toBeNull()
    expect(parsePaymentReturn('https://evil.com/?payment=success&topup_order=1')).toBeNull()
    expect(parsePaymentReturn('https://canvasapp.io.vn.evil.com/?payment=success&topup_order=1')).toBeNull()
    expect(parsePaymentReturn('https://x@canvasapp.io.vn/?payment=success&topup_order=1')).toBeNull()
    expect(parsePaymentReturn('https://pay.sepay.vn/?payment=success&topup_order=1')).toBeNull()
    expect(parsePaymentReturn(undefined)).toBeNull()
  })
})
