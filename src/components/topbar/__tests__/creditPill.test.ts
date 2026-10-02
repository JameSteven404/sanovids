// The credit pill's states (docs/SPEC-v2.md §9): demo is clearly play money, the real canvasapp balance is never
// invented ("—" until known), login-required becomes an action.
import { describe, expect, it } from 'vitest'
import { DEMO_CREDIT_HINT } from '../../../lib/credits'
import { clockText, creditPillView, LOW_CREDITS, type CreditPillInput } from '../creditPillModel'

const real = (patch: Partial<CreditPillInput>): CreditPillInput => ({
  kind: 'canvasapp',
  balance: null,
  status: 'loading',
  updatedAt: null,
  error: null,
  refreshing: false,
  ...patch,
})

const demo = (balance: number): CreditPillInput => ({ kind: 'demo', balance, status: 'ok', updatedAt: null, error: null, refreshing: false })

describe('creditPillView — demo', () => {
  it('shows the demo wallet as play money with a DEMO tone and the hint', () => {
    const v = creditPillView(demo(1000), { spent: 120 })
    expect(v.tone).toBe('demo')
    expect(v.value).toBe('1.000')
    expect(v.unit).toBe('credit')
    expect(v.source).toBeNull()
    expect(v.action).toBe('settings')
    expect(v.low).toBe(false)
    expect(v.title).toContain(DEMO_CREDIT_HINT)
    expect(v.title).toContain('1.000 credit demo')
    expect(v.title).toContain('đã dùng 120 credit demo')
    expect(v.ariaLabel).toContain('credit demo')
  })

  it('flags a low demo balance', () => {
    expect(creditPillView(demo(LOW_CREDITS - 1)).low).toBe(true)
    expect(creditPillView(demo(LOW_CREDITS)).low).toBe(false)
  })
})

describe('creditPillView — canvasapp', () => {
  const at = new Date(2026, 9, 2, 14, 5, 30).getTime()

  it('shows the confirmed real balance with ≈ đồng and the update time', () => {
    const v = creditPillView(real({ status: 'ok', balance: 1234, updatedAt: at }), { now: at })
    expect(v.tone).toBe('real')
    expect(v.source).toBe('canvasapp')
    expect(v.value).toBe('1.234')
    expect(v.unit).toBe('credit')
    expect(v.action).toBe('refresh')
    expect(v.title).toContain('1.234 credit ≈ 1.234.000đ')
    expect(v.title).toContain('cập nhật lúc 14:05')
    expect(v.title).not.toContain('demo')
    expect(v.busy).toBe(false)
  })

  it('spins while a background read is in flight but keeps the number', () => {
    const v = creditPillView(real({ status: 'ok', balance: 50, updatedAt: at, refreshing: true }), { now: at })
    expect(v.value).toBe('50')
    expect(v.busy).toBe(true)
  })

  it('never invents a number before the first answer', () => {
    const v = creditPillView(real({ status: 'loading', refreshing: true }))
    expect(v.tone).toBe('loading')
    expect(v.value).toBe('—')
    expect(v.unit).toBeNull()
    expect(v.busy).toBe(true)
  })

  it('turns into a login action after a 401', () => {
    const v = creditPillView(real({ status: 'login-required', error: 'Chưa đăng nhập' }))
    expect(v.tone).toBe('login')
    expect(v.source).toBe('canvasapp')
    expect(v.value).toBe('Đăng nhập')
    expect(v.action).toBe('login')
  })

  it('keeps the last confirmed balance on an error, with the problem in the tooltip', () => {
    const v = creditPillView(real({ status: 'error', balance: 377, updatedAt: at, error: 'Mất kết nối.' }), { now: at })
    expect(v.tone).toBe('problem')
    expect(v.value).toBe('377')
    expect(v.action).toBe('refresh')
    expect(v.title).toContain('Mất kết nối')
    expect(v.title).toContain('Số cuối cùng: 377 credit ≈ 377.000đ')
  })

  it('shows "—" on an error without any known balance', () => {
    const v = creditPillView(real({ status: 'error', balance: null, error: 'Lỗi máy chủ' }))
    expect(v.value).toBe('—')
    expect(v.unit).toBeNull()
    expect(v.low).toBe(false)
  })

  it('sends the user to Settings when the gateway is unavailable', () => {
    const v = creditPillView(real({ status: 'unavailable', error: 'Chỉ có trong bản desktop.' }))
    expect(v.tone).toBe('problem')
    expect(v.value).toBe('—')
    expect(v.action).toBe('settings')
    expect(v.title).toContain('Chỉ có trong bản desktop')
  })

  it('flags a low real balance too', () => {
    expect(creditPillView(real({ status: 'ok', balance: 5, updatedAt: at })).low).toBe(true)
  })
})

describe('clockText', () => {
  it('formats today as HH:MM and adds the date otherwise', () => {
    const now = new Date(2026, 9, 2, 18, 0).getTime()
    expect(clockText(new Date(2026, 9, 2, 9, 7).getTime(), now)).toBe('09:07')
    expect(clockText(new Date(2026, 8, 30, 23, 59).getTime(), now)).toBe('23:59 · 30/09')
    expect(clockText(null, now)).toBe('—')
  })
})
