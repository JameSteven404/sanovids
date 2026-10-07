// "Giữ đăng nhập canvasapp trên máy này" (Cài đặt → Cổng canvasapp.io.vn, GatewaySection) and the canvasapp login /
// logout results: pure texts and payload checks (tested in __tests__/gatewayLogin.test.ts).
// The choice itself is held by the main process (electron/main.cjs canvasapp:keepLogin, userData/canvasapp-prefs.json)
// — or by the simulated bridge in development mode — never by the page, so it is not in the settings export / reset.
import { KEEP_LOGIN_DAYS, type BridgeStatus, type KeepLoginState } from '../../providers/canvasapp/transport'

export const KEEP_LOGIN_LABEL = 'Giữ đăng nhập canvasapp trên máy này'
/** Extra search words of the gateway group (SettingsDialog GROUPS). */
export const KEEP_LOGIN_KEYWORDS = 'giữ đăng nhập ghi nhớ nhớ đăng nhập đăng nhập lại'
/** Settings group id of "Cổng canvasapp.io.vn" (openSettings deep link). */
export const GATEWAY_SETTINGS_GROUP = 'gateway'

export const KEEP_LOGIN_HINT_ON = `Tắt rồi mở lại SanoVids không phải đăng nhập lại (tối đa ${KEEP_LOGIN_DAYS} ngày, hoặc đến khi canvasapp kết thúc phiên). Phiên được mã hoá bằng tài khoản Windows của bạn; Đăng xuất xoá ngay.`
export const KEEP_LOGIN_HINT_OFF = 'Mỗi lần mở SanoVids cần đăng nhập canvasapp lại. Nên tắt khi dùng máy chung, hoặc khi nhiều người dùng chung một tài khoản Windows.'
export const KEEP_LOGIN_HINT_PORTABLE = 'Bản Portable (hoặc chạy từ thư mục tạm) mặc định không giữ đăng nhập — hay được chạy trên máy người khác.'
export const KEEP_LOGIN_UNAVAILABLE = 'Máy này không mã hoá được phiên đăng nhập nên SanoVids không giữ — mỗi lần mở app cần đăng nhập lại.'
/** Added while the choice stays on: SanoVids tries again (the switch can still be turned off). */
export const KEEP_LOGIN_UNAVAILABLE_ON = 'SanoVids sẽ thử lại ở lần đăng nhập sau; tắt nếu không muốn giữ đăng nhập trên máy này.'
export const KEEP_LOGIN_TOAST_ON = 'Đã bật giữ đăng nhập canvasapp trên máy này.'
export const KEEP_LOGIN_TOAST_OFF = 'Đã tắt: lần mở SanoVids sau sẽ cần đăng nhập canvasapp lại. Phiên hiện tại vẫn dùng được.'
const BAD_STATE = 'Không đọc được cài đặt giữ đăng nhập.'
const LOGOUT_FAILED = 'Không đăng xuất được canvasapp — thử lại.'

export type KeepLoginView = Extract<KeepLoginState, { ok: true }>

/** Untrusted payload of keepLogin() / setKeepLogin() → a KeepLoginState (anything odd → ok:false). */
export function parseKeepLoginState(raw: unknown): KeepLoginState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'bad-response', message: BAD_STATE }
  const r = raw as Record<string, unknown>
  if (r.ok === true && typeof r.keepLogin === 'boolean' && typeof r.available === 'boolean') {
    return { ok: true, keepLogin: r.keepLogin, available: r.available, chosen: r.chosen === true }
  }
  if (r.ok === false) {
    return { ok: false, code: typeof r.code === 'string' ? r.code : 'error', message: typeof r.message === 'string' && r.message.trim() ? r.message : BAD_STATE }
  }
  return { ok: false, code: 'bad-response', message: BAD_STATE }
}

/** The hint under the switch: why it is on / off / disabled (the Portable default when the user never chose). */
export function keepLoginHint(v: KeepLoginView): string {
  if (!v.available) return v.keepLogin ? `${KEEP_LOGIN_UNAVAILABLE} ${KEEP_LOGIN_UNAVAILABLE_ON}` : KEEP_LOGIN_UNAVAILABLE
  if (v.keepLogin) return KEEP_LOGIN_HINT_ON
  return v.chosen ? KEEP_LOGIN_HINT_OFF : `${KEEP_LOGIN_HINT_OFF} ${KEEP_LOGIN_HINT_PORTABLE}`
}

/**
 * The switch shows the choice — also when encryption failed in this run (the hint then says nothing is kept), so it can
 * always be switched OFF.
 */
export const keepLoginChecked = (v: KeepLoginView): boolean => v.keepLogin

/** Only switching ON is refused when this computer cannot encrypt (switching OFF always works). */
export const keepLoginDisabled = (v: KeepLoginView): boolean => !v.available && !v.keepLogin

/**
 * What logout() answered → ok, or the message to show (never "Đã đăng xuất" then). `notCleared`: logged out, but the
 * kept copy could not be deleted — the toast offers "Thử lại" (logout again). An old desktop build's { ok: true } is ok.
 */
export function logoutOutcome(res: unknown): { ok: true } | { ok: false; message: string; notCleared: boolean } {
  if (res && typeof res === 'object' && (res as { ok?: unknown }).ok === true) return { ok: true }
  const r = res && typeof res === 'object' ? (res as { code?: unknown; message?: unknown }) : null
  const message = r && typeof r.message === 'string' && r.message.trim() ? r.message : LOGOUT_FAILED
  return { ok: false, message, notCleared: !!r && r.code === 'keep-login-not-cleared' }
}

/**
 * The toast after a successful login: when SanoVids keeps it on this computer, say so (before this fix closing the app
 * always logged out — someone on a shared PC must learn it does not any more) and offer Cài đặt (`settings`).
 */
export function loginSuccessToast(name: string, st: BridgeStatus): { text: string; settings: boolean } {
  if (st.ok && st.authenticated && st.keepLogin === true) {
    return {
      text: `Đã đăng nhập ${name}. SanoVids giữ đăng nhập trên máy này tới khi bạn Đăng xuất (tối đa ${KEEP_LOGIN_DAYS} ngày). Máy dùng chung? Tắt trong Cài đặt → Cổng canvasapp.io.vn.`,
      settings: true,
    }
  }
  return { text: `Đã đăng nhập ${name}.`, settings: false }
}
