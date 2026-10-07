// Every text and small rule of the development-mode lock UI — pure, no stores, no React (tested in
// __tests__/devUnlockModel.test.ts). Used by DevUnlock.tsx (the hidden unlock box of Cài đặt → Giới thiệu),
// DevTotpLink.tsx (linking an authenticator app), DevAccessRows.tsx (the top of "Chế độ Phát triển" in Cài đặt),
// GatewaySection (the canvasapp switch while locked) and devAccessActions.ts (lock toasts, the one-time notice).
// No sentence names an e-mail address (tested: no '@').
import { platformText } from '../../lib/platformText'
import type { DevAccessResult, DevAccessState, DevKeepDays, DevLockReason } from '../../providers/devAccess'

// ---- the hidden gesture ----

/** Taps on the version line that open the unlock box: 5 within 3 s. */
export const UNLOCK_TAPS = 5
export const UNLOCK_TAP_WINDOW_MS = 3000

/** The taps kept after one more at `now` (older than the window dropped); `fire` = the 5th within the window. */
export function nextTaps(times: readonly number[], now: number, needed = UNLOCK_TAPS, windowMs = UNLOCK_TAP_WINDOW_MS): { times: number[]; fire: boolean } {
  const kept = [...times.filter((t) => now - t < windowMs && t <= now), now]
  if (kept.length >= needed) return { times: [], fire: true }
  return { times: kept, fire: false }
}

// ---- formatting ----

const pad = (n: number) => String(n).padStart(2, '0')

/** "05:00" — minutes:seconds of a wait (rounded up, never negative). */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

/** "m:ss" of a short countdown (the link window). */
export function mss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${pad(s % 60)}`
}

/** "14/10/2026 09:05" (local time). */
export function dateTimeText(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---- the unlock box ----

export const DEV_UNLOCK_TITLE = 'Mở khoá chế độ Phát triển'
export const DEV_UNLOCK_INTRO = 'Chế độ Phát triển (canvasapp giả lập, credit dev) chỉ dành cho nhà phát triển.'
export const DEV_UNLOCK_LABEL = 'Mã 6 số từ app xác thực, hoặc mã mở khoá (SV1-…)'
export const DEV_UNLOCK_WEB_ONLY = 'Chỉ mở khoá được trong bản desktop SanoVids.'
export const DEV_DEVICE_COPIED = 'Đã chép mã máy.'
export const DEV_SIM_HINT = 'Giả lập trong trình duyệt: nhập mã 6 số của khoá thử RFC 6238 (12345678901234567890) — không có mã mở khoá SV1 nào ở đây.'
export const DEV_SESSION_ONLY = 'Máy này không lưu được trạng thái mở khoá — chế độ Phát triển chỉ mở đến khi tắt SanoVids.'

export const DEV_DEVICE_LABEL = 'Mã máy này:'
export const deviceLine = (code: string) => `${DEV_DEVICE_LABEL} ${code || '—'}`

type ErrorInput = Pick<Extract<DevAccessResult, { ok: false }>, 'error' | 'waitUntil' | 'minutes' | 'codeDevice' | 'thisDevice'>

/** The sentence under the unlock box (or the link box) for an error answer. `device` = this device's code. */
export function unlockErrorText(r: ErrorInput, opts: { now?: number; device?: string; clockSync?: string } = {}): string {
  const now = opts.now ?? Date.now()
  const y = r.thisDevice || opts.device || '—'
  const y4 = y.slice(0, 4)
  const clock = opts.clockSync ?? platformText.clockSync
  switch (r.error) {
    case 'malformed':
    case 'bad-signature':
      return 'Mã không hợp lệ. Mã từ app xác thực có 6 số; mã mở khoá bắt đầu bằng SV1- (dán đủ cả mã).'
    case 'newer-format':
    case 'unknown-key':
      return 'Mã này được tạo cho bản SanoVids mới hơn. Cập nhật SanoVids rồi thử lại.'
    case 'no-keys':
      return 'Bản SanoVids này chưa có khoá mở khoá — không mở được bằng mã.'
    case 'other-device':
      return `Mã này dành cho máy ${r.codeDevice || '—'}. Mã máy này là ${y}.`
    case 'expired':
      return `Mã mở khoá đã hết hạn. Tạo mã mới cho mã máy ${y}.`
    case 'used':
      return `Mã mở khoá này đã được dùng trên máy này. Mỗi mã chỉ dùng một lần — tạo mã mới cho mã máy ${y}.`
    case 'clock':
      return `Đồng hồ máy này đang sai ngày. Vào ${clock}, rồi thử lại.`
    case 'totp-none':
      return `Máy này chưa liên kết app xác thực. Lần đầu, hãy dùng mã mở khoá (SV1-…) tạo cho mã máy ${y}.`
    case 'totp-wrong':
      return `Mã không đúng. Mã trong app xác thực đổi mỗi 30 giây — nhập mã đang hiện ở mục “SanoVids · Máy ${y4}”.`
    case 'totp-replay':
      return 'Mã này vừa được dùng. Chờ mã tiếp theo trong app xác thực.'
    case 'totp-old':
      return `Mã này cũ hơn mã đã dùng lần trước — có thể đồng hồ điện thoại từng chạy nhanh rồi được chỉnh lại. Chờ khoảng ${r.minutes ?? 1} phút rồi thử lại, hoặc dùng mã mở khoá (SV1-…).`
    case 'totp-lost':
      return `Liên kết app xác thực trên máy này không đọc được nữa (dữ liệu Windows đã đổi). Mở khoá bằng mã mở khoá (SV1-…) tạo cho mã máy ${y}, rồi liên kết lại.`
    case 'totp-skew':
      return `Mã đúng nhưng đồng hồ máy này lệch khoảng ${r.minutes ?? 1} phút. Vào ${clock}, rồi thử lại.`
    case 'wait':
      return `Nhập sai nhiều lần. Thử lại sau ${mmss((r.waitUntil ?? now) - now)}.`
    case 'too-fast':
      return 'Chờ một giây rồi thử lại.'
    case 'link-used':
      return 'Lời mời liên kết này đã được dùng. Để liên kết, tạo mã mở khoá mới (SV1-…).'
    case 'link-window':
      return LINK_EXPIRED
    case 'write-failed':
      return 'Không lưu được liên kết trên máy này (thư mục dữ liệu của SanoVids không ghi được). Thử lại sau.'
    case 'locked':
      return 'Chế độ Phát triển đang khoá.'
    case 'build':
      return LINK_BUILD
    case 'cap':
      return 'Mã mở khoá của máy này có hạn tối đa — không chọn được “Tới khi khoá lại”.'
    case 'not-desktop':
      return DEV_UNLOCK_WEB_ONLY
    default:
      return 'Không mở khoá được (lỗi không rõ). Thử lại.'
  }
}

/** The extra line of a wrong 6-digit code: wrong codes are counted, a wait may follow. */
export function waitLeft(waitUntil: number | null, now: number): number {
  return waitUntil && waitUntil > now ? waitUntil - now : 0
}

/** Toast after a successful unlock: until when, and which provider new takes still use (never changed by unlocking). */
export function unlockedToast(state: Pick<DevAccessState, 'until'>, providerLabel: string): string {
  const until = state.until ? `đến ${dateTimeText(state.until)}.` : 'cho tới khi khoá lại.'
  return `Đã mở khoá chế độ Phát triển trên máy này ${until} Take mới vẫn dùng ${providerLabel} — đổi trong Cài đặt → Nhà cung cấp video.`
}

/** The link offer right after a code unlock (null when there is none / it ran out). */
export function linkInvite(state: Pick<DevAccessState, 'linkUntil' | 'totp'>, now: number): string | null {
  if (!state.linkUntil || state.linkUntil <= now) return null
  const left = mss(state.linkUntil - now)
  return state.totp.linked
    ? `Liên kết lại (thay mục cũ trong điện thoại)? Còn ${left}.`
    : `Liên kết app xác thực để lần sau chỉ cần mã 6 số? Còn ${left}.`
}

// ---- linking an authenticator ----

export const LINK_STEP_1 = '1. Trong Google Authenticator hoặc Microsoft Authenticator: bấm + → “Nhập khoá thiết lập”.'
export const linkManualText = (label: string) => `Tên: ${label} · Loại: Theo thời gian. Khoá thiết lập:`
export const LINK_STEP_2 = '2. Nhập mã 6 số app đang hiện:'
export const LINK_WARNING = 'Đừng chụp hay gửi khoá thiết lập này cho ai — ai có nó mở được chế độ Phát triển trên máy này.'
export const linkDoneToast = (label: string) => `Đã liên kết. Lần sau mở khoá máy này bằng mã 6 số ở mục “${label}”.`
export const LINK_EXPIRED = 'Để liên kết, hãy tạo mã mở khoá mới (SV1-…) rồi mở khoá lại bằng mã đó.'
export const LINK_CLOSE_CONFIRM = 'Đóng sẽ huỷ lời mời liên kết; muốn liên kết lại phải có mã mở khoá mới.'
export const LINK_BUILD = 'Liên kết trên bản cài đặt, sau khi mở khoá bằng mã.'
export const LINK_SECRET_COPIED = 'Đã chép khoá thiết lập. Dán vào app xác thực xong thì xoá khỏi bộ nhớ tạm.'

// ---- "Chế độ Phát triển" in Cài đặt ----

export const KEEP_LABEL: Record<DevKeepDays, string> = { 1: '1 ngày', 7: '7 ngày', 30: '30 ngày', 0: 'Tới khi khoá lại' }
export const KEEP_ORDER: readonly DevKeepDays[] = [1, 7, 30, 0]
const METHOD_LABEL = { code: 'mã mở khoá', totp: 'app xác thực', email: 'mã email' } as const

/** The status line of the access. */
export function accessStatusLine(state: Pick<DevAccessState, 'access' | 'until' | 'method'>): string {
  if (state.access === 'build') return 'Mở sẵn: bản chạy từ mã nguồn hoặc bản thử — không cần mã.'
  if (state.access === 'locked') return 'Đang khoá.'
  const how = state.method ? ` · mở bằng ${METHOD_LABEL[state.method]}` : ''
  return state.until ? `Đang mở khoá trên máy này đến ${dateTimeText(state.until)}${how}` : `Đang mở khoá trên máy này cho tới khi khoá lại${how}`
}

/** Keep choices a code's max days rules out (they would end after capUntil). */
export function keepDisabled(days: DevKeepDays, capUntil: number | null, now: number): boolean {
  if (capUntil === null) return false
  return days === 0 || now + days * 86_400_000 > capUntil
}

export const capNote = (capUntil: number) => `Mã mở khoá của máy này cho phép tối đa đến ${dateTimeText(capUntil)}.`

export function totpStatusLine(state: Pick<DevAccessState, 'totp'>): string {
  if (state.totp.lost) return 'Liên kết trên máy này không đọc được nữa'
  return state.totp.linked ? `Đã liên kết (${state.totp.label ?? 'SanoVids'})` : 'Chưa liên kết'
}

export const TOTP_LINK_HINT = 'Mở khoá bằng mã SV1-… mới để liên kết.'
export const unlinkConfirm = (label: string) =>
  `Bỏ liên kết app xác thực? Lần sau phải dùng mã mở khoá (SV1-…) để mở máy này. Xoá cả mục “${label}” trong điện thoại.`

/** "Khoá lại ngay" confirmation: running DEV takes finish (they cost nothing). */
export function lockConfirm(runningDev: number): string {
  const run = runningDev > 0 ? `${runningDev} take giả lập đang chạy vẫn chạy nốt. ` : ''
  return `Khoá chế độ Phát triển trên máy này? Nút Bảng phát triển và mọi chữ DEV sẽ ẩn; ${run}Mở lại bằng mã 6 số từ app xác thực.`
}

export const SIM_LOCK_LABEL = 'Xem như bản phát hành (đã khoá)'
export const SIM_LOCK_HINT = 'Chỉ trong trình duyệt trên máy này: ẩn chế độ Phát triển như bản cài đặt. Mở lại bằng mã 6 số của khoá thử RFC 6238, hoặc “Bỏ khoá giả lập”.'
export const SIM_UNLOCK_BUTTON = 'Bỏ khoá giả lập'

// ---- lock ----

/** Toast when development mode closes: by hand, the time ran out, the clock went back. */
export function lockToastText(reason: DevLockReason | null): string {
  if (reason === 'expired') return 'Chế độ Phát triển đã tự khoá (hết thời gian mở khoá).'
  if (reason === 'clock-back') return 'Chế độ Phát triển đã khoá vì đồng hồ máy bị lùi.'
  return 'Đã khoá chế độ Phát triển.'
}

/** One-time notice for people who used development mode before it was hidden (0.5.0 made it the default). */
export const DEV_HIDDEN_NOTICE =
  'Chế độ Phát triển đã được ẩn. Từ bản này, canvasapp giả lập và credit dev chỉ dành cho nhà phát triển. Muốn tạo video thật, bật cổng canvasapp.io.vn trong Cài đặt. Các video giả lập cũ vẫn xem và lưu được (nhãn DEV).'
export const DEV_HIDDEN_NOTICE_KEY = 'bdp:notice:devHidden'
/** Traces of the simulated server (providers/dev/server.ts DEV_STATE_KEY / DEV_CONFIG_KEY). */
export const DEV_TRACE_KEYS: readonly string[] = ['bdp:dev:state', 'bdp:dev:config']

/** Show the one-time notice: locked, development mode was used on this device, not shown before. */
export function shouldNoticeHidden(o: { access: DevAccessState['access']; hasDevTraces: boolean; noticed: boolean }): boolean {
  return o.access === 'locked' && o.hasDevTraces && !o.noticed
}

// ---- the canvasapp gateway while locked (GatewaySection) ----

export const CANVASAPP_SWITCH_LABEL = 'Dùng canvasapp.io.vn cho take mới'
export const CANVASAPP_SWITCH_HINT_OFF = 'Đang tắt: SanoVids không kết nối tới canvasapp.io.vn và chưa tạo được video.'
export const CANVASAPP_SWITCH_HINT_ON = 'Đang bật: take mới tạo trên canvasapp.io.vn bằng tài khoản canvasapp của bạn (credit thật).'
export const CANVASAPP_ENABLE_CONFIRM =
  'Bật cổng canvasapp.io.vn? Take mới sẽ tạo trên canvasapp.io.vn bằng tài khoản canvasapp của bạn và trừ credit canvasapp (tiền thật). Đây là cổng không chính thức (API nội bộ của canvasapp, có thể thay đổi bất cứ lúc nào) — chỉ bật khi bạn đã được bên vận hành canvasapp.io.vn đồng ý. Huỷ take trong SanoVids không dừng job đã gửi.'
export const CANVASAPP_ON_TOAST = 'Đã bật cổng canvasapp.io.vn — take mới trừ credit canvasapp (tiền thật).'
export const CANVASAPP_OFF_TOAST = 'Đã tắt cổng canvasapp.io.vn — take mới chưa chạy được cho tới khi bật lại.'
export const CANVASAPP_LOGOUT_LOCKED = 'Đã đăng xuất canvasapp.'
export const CANVASAPP_LOCKED_INTRO =
  'canvasapp.io.vn tạo video thật bằng tài khoản canvasapp của chính bạn (bản desktop): đăng nhập trên trang của canvasapp, trả bằng credit canvasapp.'
