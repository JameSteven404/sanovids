// Development mode: "Giữ đăng nhập canvasapp trên máy này" simulated, so what the app does after a restart can be tried
// without the real site (the cookie code itself is electron/keeplogin-rules.cjs, tested with fakes and the lab).
// The real rule, in words: canvasapp's login cookie is a SESSION cookie (lost when the desktop app quits) unless it has
// an expiry; SanoVids puts it back after a restart only when "Giữ đăng nhập" is on, this computer can encrypt the copy,
// the copy can be decrypted, and it was saved at most KEEP_LOGIN_DAYS ago (login or canvasapp's last renewal).
// Used by server.ts simulateRestart, bridge.ts keepLogin / setKeepLogin / simulateRestart and the dev panel.
import { KEEP_LOGIN_DAYS } from '../canvasapp/transport'

export { KEEP_LOGIN_DAYS }

/** How the simulated site sets its login cookie: like the real site as currently believed ('session'), or with an expiry. */
export type DevLoginCookie = 'session' | 'persistent'
/** safeStorage on this (simulated) computer: works, is unavailable, or cannot decrypt the copy (another account / reset). */
export type DevEncryption = 'ok' | 'unavailable' | 'decrypt-fails'

export const DEV_LOGIN_COOKIES: readonly DevLoginCookie[] = ['session', 'persistent']
export const DEV_ENCRYPTIONS: readonly DevEncryption[] = ['ok', 'unavailable', 'decrypt-fails']

/** localStorage key of the simulated switch (the real one lives in the main process: userData/canvasapp-prefs.json). */
export const DEV_KEEP_LOGIN_KEY = 'bdp:dev:keepLogin'

/** Same default as electron/keeplogin-rules.cjs defaultKeepLogin: installed / source on, Portable / temp copy / unknown off. */
export function defaultKeepLogin(placementKind: string | null | undefined): boolean {
  return placementKind === 'installer' || placementKind === 'dev'
}

/** Same text as electron/keeplogin-rules.cjs KEEP_LOGIN_NOT_CLEARED_TEXT (the fault "Đăng xuất: không xoá được bản sao"). */
export const KEEP_LOGIN_NOT_CLEARED_TEXT =
  'Đã đăng xuất, nhưng chưa xoá được bản sao đăng nhập trên máy (tệp đang bị khoá). Bấm “Thử lại”; nếu vẫn lỗi, khởi động lại máy rồi đăng xuất lần nữa.'

/** Why the login did or did not survive a (simulated) restart. */
export type DevRestartOutcome = 'not-logged-in' | 'persistent' | 'kept' | 'keep-off' | 'encryption-unavailable' | 'decrypt-fails' | 'expired'

export interface DevRestartInput {
  authenticated: boolean
  loginCookie: DevLoginCookie
  keepLogin: boolean
  encryption: DevEncryption
  /** Days since the copy was saved (the login, or canvasapp's last renewal). */
  daysSinceSaved: number
}

export function restartOutcome(o: DevRestartInput): DevRestartOutcome {
  if (!o.authenticated) return 'not-logged-in'
  if (o.loginCookie === 'persistent') return 'persistent'
  if (!o.keepLogin) return 'keep-off'
  if (o.encryption === 'unavailable') return 'encryption-unavailable'
  if (o.encryption === 'decrypt-fails') return 'decrypt-fails'
  if (!(o.daysSinceSaved <= KEEP_LOGIN_DAYS)) return 'expired'
  return 'kept'
}

/** Still logged in after the restart? */
export function loginSurvivesRestart(o: DevRestartInput): boolean {
  const r = restartOutcome(o)
  return r === 'persistent' || r === 'kept'
}

/** localStorage text → the switch the user chose, or null (never chose / anything odd). */
export function parseDevKeepLogin(raw: string | null): boolean | null {
  return raw === 'true' ? true : raw === 'false' ? false : null
}
