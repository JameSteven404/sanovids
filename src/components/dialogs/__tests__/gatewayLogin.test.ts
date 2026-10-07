// The canvasapp gateway section reads its login state from the shared real-credit store (no own /api/me call);
// "Giữ đăng nhập canvasapp trên máy này", the logout result and the login toast (keepLoginModel.ts).
import { describe, expect, it } from 'vitest'
import settingsSource from '../../../lib/settings.ts?raw'
import gatewaySource from '../GatewaySection.tsx?raw'
import creditPillSource from '../../topbar/CreditPill.tsx?raw'
import {
  KEEP_LOGIN_HINT_OFF,
  KEEP_LOGIN_HINT_ON,
  KEEP_LOGIN_HINT_PORTABLE,
  KEEP_LOGIN_LABEL,
  KEEP_LOGIN_UNAVAILABLE,
  KEEP_LOGIN_UNAVAILABLE_ON,
  keepLoginChecked,
  keepLoginDisabled,
  keepLoginHint,
  loginSuccessToast,
  logoutOutcome,
  parseKeepLoginState,
} from '../keepLoginModel'
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

describe('"Giữ đăng nhập canvasapp trên máy này"', () => {
  it('payloads are checked strictly (booleans only; anything odd is an error, never "on")', () => {
    expect(parseKeepLoginState({ ok: true, keepLogin: true, available: true, chosen: false })).toEqual({ ok: true, keepLogin: true, available: true, chosen: false })
    expect(parseKeepLoginState({ ok: true, keepLogin: false, available: true })).toEqual({ ok: true, keepLogin: false, available: true, chosen: false })
    expect(parseKeepLoginState({ ok: true, keepLogin: 'yes', available: true })).toMatchObject({ ok: false, code: 'bad-response' })
    expect(parseKeepLoginState({ ok: false, code: 'keep-login-not-cleared', message: 'x' })).toEqual({ ok: false, code: 'keep-login-not-cleared', message: 'x' })
    expect(parseKeepLoginState({ ok: false })).toMatchObject({ ok: false, code: 'error' })
    for (const bad of [null, undefined, 'on', 1, [], { keepLogin: true }]) expect(parseKeepLoginState(bad)).toMatchObject({ ok: false })
  })

  it('the hint says why: unavailable, on, off by choice, off by the Portable default', () => {
    const v = (keepLogin: boolean, available: boolean, chosen: boolean) => ({ ok: true as const, keepLogin, available, chosen })
    expect(keepLoginHint(v(true, false, true))).toBe(`${KEEP_LOGIN_UNAVAILABLE} ${KEEP_LOGIN_UNAVAILABLE_ON}`)
    expect(keepLoginHint(v(false, false, true))).toBe(KEEP_LOGIN_UNAVAILABLE)
    expect(keepLoginHint(v(true, true, false))).toBe(KEEP_LOGIN_HINT_ON)
    expect(keepLoginHint(v(false, true, true))).toBe(KEEP_LOGIN_HINT_OFF)
    expect(keepLoginHint(v(false, true, false))).toBe(`${KEEP_LOGIN_HINT_OFF} ${KEEP_LOGIN_HINT_PORTABLE}`)
    expect(KEEP_LOGIN_HINT_ON).toContain('30 ngày')
    expect(KEEP_LOGIN_HINT_ON).toContain('mã hoá')
    // the switch shows the choice; when this computer cannot encrypt, only switching ON is refused — an "on" choice
    // can always be switched OFF (the hint says nothing is kept meanwhile)
    expect(keepLoginChecked(v(true, true, true))).toBe(true)
    expect(keepLoginChecked(v(true, false, true))).toBe(true)
    expect(keepLoginChecked(v(false, true, true))).toBe(false)
    expect(keepLoginDisabled(v(true, false, true))).toBe(false)
    expect(keepLoginDisabled(v(true, false, false))).toBe(false)
    expect(keepLoginDisabled(v(false, false, true))).toBe(true)
    expect(keepLoginDisabled(v(false, true, false))).toBe(false)
    expect(keepLoginDisabled(v(true, true, true))).toBe(false)
    expect(KEEP_LOGIN_LABEL).toBe('Giữ đăng nhập canvasapp trên máy này')
  })

  it('logout: only { ok: true } is "Đã đăng xuất"; a copy that could not be deleted is said, with "Thử lại"', () => {
    expect(logoutOutcome({ ok: true })).toEqual({ ok: true })
    expect(logoutOutcome({ ok: false, code: 'keep-login-not-cleared', message: 'Chưa xoá được.' })).toEqual({ ok: false, message: 'Chưa xoá được.', notCleared: true })
    expect(logoutOutcome({ ok: false, code: 'error', message: 'boom' })).toEqual({ ok: false, message: 'boom', notCleared: false })
    for (const bad of [undefined, null, {}, { ok: false }, 'ok', { ok: 'true' }]) expect(logoutOutcome(bad)).toMatchObject({ ok: false, notCleared: false })
  })

  it('the login toast says the login is kept on this computer (and offers Cài đặt) only when it is', () => {
    const kept = loginSuccessToast('canvasapp.io.vn', { ok: true, authenticated: true, keepLogin: true })
    expect(kept.settings).toBe(true)
    expect(kept.text).toBe(
      'Đã đăng nhập canvasapp.io.vn. SanoVids giữ đăng nhập trên máy này tới khi bạn Đăng xuất (tối đa 30 ngày). Máy dùng chung? Tắt trong Cài đặt → Cổng canvasapp.io.vn.',
    )
    expect(loginSuccessToast('canvasapp.io.vn', { ok: true, authenticated: true, keepLogin: false })).toEqual({ text: 'Đã đăng nhập canvasapp.io.vn.', settings: false })
    // an older desktop build does not say: the plain toast
    expect(loginSuccessToast('canvasapp.io.vn', { ok: true, authenticated: true })).toEqual({ text: 'Đã đăng nhập canvasapp.io.vn.', settings: false })
  })

  it('wiring: Đăng xuất reads the result (no success toast on a failure), the pill toast uses loginSuccessToast', () => {
    const doLogout = gatewaySource.slice(gatewaySource.indexOf('const doLogout = async'), gatewaySource.indexOf('const choose ='))
    expect(doLogout).toContain('const outcome = logoutOutcome(await bridgeLogout(bridge))')
    expect(doLogout).toMatch(/if \(!outcome\.ok\) showLogoutProblem\(outcome, bridge\)\s+else toast\(/)
    expect(gatewaySource).toContain("typeof gwBridge.keepLogin === 'function' && <KeepLoginRow")
    // disabled only for switching ON; re-read when the login state changes (a login may flip "available")
    expect(gatewaySource).toContain('disabled={keepLoginDisabled(view) || saving}')
    expect(gatewaySource).toContain('loginState={login.state}')
    expect(gatewaySource).toContain('}, [bridge, loginState])')
    expect(creditPillSource).toContain('const t = loginSuccessToast(name, st)')
  })

  it('the choice is held by the main process: never in the settings file / reset (lib/settings.ts)', () => {
    expect(settingsSource).not.toMatch(/keepLogin|keep-login|canvasapp-prefs|bdp:dev:keepLogin/i)
  })
})
