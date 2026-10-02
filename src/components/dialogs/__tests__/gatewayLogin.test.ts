// The canvasapp gateway section reads its login state from the shared real-credit store (no own /api/me call).
import { describe, expect, it } from 'vitest'
import { gatewayLoginFromCredits, type GatewayCreditsView } from '../shared'

const view = (patch: Partial<GatewayCreditsView>): GatewayCreditsView => ({
  balance: null,
  status: 'idle',
  error: null,
  refreshing: false,
  updatedAt: null,
  ...patch,
})

describe('gatewayLoginFromCredits', () => {
  it('idle / loading → checking', () => {
    expect(gatewayLoginFromCredits(view({}))).toEqual({ state: 'checking' })
    expect(gatewayLoginFromCredits(view({ status: 'loading', refreshing: true }))).toEqual({ state: 'checking' })
  })

  it('a confirmed balance → logged in with that balance', () => {
    expect(gatewayLoginFromCredits(view({ status: 'ok', balance: 377, updatedAt: 1 }))).toEqual({ state: 'in', credits: 377, stale: null })
  })

  it('401 → logged out', () => {
    expect(gatewayLoginFromCredits(view({ status: 'login-required', error: 'Chưa đăng nhập' }))).toEqual({ state: 'out' })
  })

  it('a failed refresh keeps the last balance (stale) or reports the error', () => {
    expect(gatewayLoginFromCredits(view({ status: 'error', balance: 377, error: 'Mất kết nối' }))).toEqual({ state: 'in', credits: 377, stale: 'Mất kết nối' })
    expect(gatewayLoginFromCredits(view({ status: 'error', error: 'Lỗi máy chủ' }))).toEqual({ state: 'error', message: 'Lỗi máy chủ' })
  })

  it('unavailable → error with the reason', () => {
    expect(gatewayLoginFromCredits(view({ status: 'unavailable', error: 'Chỉ có trong bản desktop' }))).toEqual({ state: 'error', message: 'Chỉ có trong bản desktop' })
  })
})
