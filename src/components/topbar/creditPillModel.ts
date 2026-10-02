// What the credit pill shows — pure, no stores (tested in __tests__/creditPill.test.ts). docs/SPEC-v2.md §9, §11.
// The pill itself is CreditPill.tsx (top bar + queue drawer bar).
//
//   dev         dashed neutral pill  [flask] DEV 1.000 credit         click → re-read the simulated balance
//               (development mode: the simulated canvasapp account — "credit dev", never real money; "+" = top-up
//               through the simulated SePay sheet). Login / loading / problem states as below, dashed and tagged DEV.
//   real        solid tinted pill    [wallet] canvasapp · 1.234 credit click → re-read the real balance
//   login       tinted action        [log-in] canvasapp · Đăng nhập   click → canvasapp's login window
//               (dev: [log-in] DEV Đăng nhập → the simulated login sheet)
//   loading     tinted, spinner      canvasapp · —                    (never a made-up number)
//   problem     warning tint         canvasapp · 1.234 | —            click → try again (or Cài đặt when unavailable)
//   demo        neutral dashed pill  [flask] 1.000 credit DEMO        legacy: the old demo's local wallet (only when a
//               caller passes kind 'demo' — new takes never use it).
import { CREDIT_HINT, creditUnitLabel, formatCreditNumber, formatCredits, formatVnd, type CreditKind } from '../../lib/credits'
import type { CreditInfo } from '../../store/credits'

/** Below this the balance number turns red (a 1080p 15 s video costs 20). */
export const LOW_CREDITS = 20

/** The word after the number: plain "credit" — the source ("canvasapp" / "DEV") or the "DEMO" tag names the wallet. */
const UNIT = creditUnitLabel('canvasapp')

export type CreditPillTone = 'demo' | 'dev' | 'real' | 'login' | 'loading' | 'problem'
export type CreditPillAction = 'settings' | 'refresh' | 'login'

export interface CreditPillView {
  tone: CreditPillTone
  /** Simulated credits (development mode, old demo): the dashed neutral look, never the "real money" tint. */
  sim: boolean
  /** The big text: the number, "—" (unknown) or "Đăng nhập". */
  value: string
  /** Word after the value ("credit"); hidden in narrow spots. null = none. */
  unit: string | null
  /** The source named before the value: "canvasapp", "DEV" (drawn as a tag). null for the old demo. */
  source: string | null
  /** Tag after the value ("DEMO" for the old demo), else null. */
  tag: string | null
  /** Balance known and below LOW_CREDITS. */
  low: boolean
  /** A read of the gateway balance is in flight (spinner). */
  busy: boolean
  action: CreditPillAction
  /** Show the "+" (Nạp credit) next to the pill: a gateway account whose balance is (or was) known. */
  topUp: boolean
  /** Tooltip (several lines). */
  title: string
  ariaLabel: string
}

export type CreditPillInput = Pick<CreditInfo, 'kind' | 'balance' | 'status' | 'updatedAt' | 'error' | 'refreshing'>

const pad = (n: number) => String(n).padStart(2, '0')

/** "14:05", plus " · 01/10" when not today (local time, same output in every runtime). Null → "—". */
export function clockText(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const today = new Date(now)
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? time : `${time} · ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}

const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

const clean = (s: string | null | undefined) => (s ?? '').trim().replace(/[.\s]+$/, '')

/** How each gateway is named on the pill. */
interface PillWords {
  kind: 'dev' | 'canvasapp'
  /** Shown before the value. */
  source: string
  /** "canvasapp" in sentences / aria labels. */
  name: string
  /** The account, in sentences. */
  account: string
  sim: boolean
}

const WORDS: Record<'dev' | 'canvasapp', PillWords> = {
  canvasapp: { kind: 'canvasapp', source: 'canvasapp', name: 'canvasapp', account: 'tài khoản canvasapp.io.vn', sim: false },
  dev: { kind: 'dev', source: 'DEV', name: 'DEV', account: 'tài khoản canvasapp giả lập (chế độ Phát triển)', sim: true },
}

/** "1.234 credit ≈ 1.234.000đ" (real) | "1.234 credit dev" (dev — no đồng: it is not money). */
function amountText(n: number, w: PillWords): string {
  return w.sim ? formatCredits(n, 'dev') : `${formatCredits(n, 'canvasapp')} ≈ ${formatVnd(n)}`
}

/** The pill for a CreditInfo (useCreditInfo()). `spent` = demo credits spent (shown in the demo tooltip). */
export function creditPillView(info: CreditPillInput, opts: { spent?: number; now?: number } = {}): CreditPillView {
  const { balance } = info
  const has = known(balance)
  const low = has && balance < LOW_CREDITS

  if (info.kind === 'demo') {
    const hint = CREDIT_HINT.demo
    const amount = formatCredits(balance, 'demo')
    const spent = known(opts.spent) ? ` · đã dùng ${formatCredits(opts.spent, 'demo')}` : ''
    return {
      tone: 'demo',
      sim: true,
      value: formatCreditNumber(balance),
      unit: UNIT,
      source: null,
      tag: 'DEMO',
      low,
      busy: false,
      action: 'settings',
      topUp: false,
      title: `${hint}.\nSố dư: ${amount}${spent}.\nChỉ take Demo cũ dùng credit này. Bấm để mở Cài đặt.`,
      ariaLabel: `Credit demo: ${amount} — ${hint}. Mở Cài đặt`,
    }
  }

  const w = WORDS[info.kind as Exclude<CreditKind, 'demo'>] ?? WORDS.canvasapp
  const source = w.source
  const sim = w.sim
  const when = has && info.updatedAt ? ` (cập nhật lúc ${clockText(info.updatedAt, opts.now)})` : ''
  const amount = has ? amountText(balance, w) : ''
  const base = { sim, source, tag: null, unit: null, low: false, busy: false, topUp: false }

  switch (info.status) {
    case 'login-required':
      return {
        ...base,
        tone: 'login',
        value: 'Đăng nhập',
        action: 'login',
        title: sim
          ? `Chưa đăng nhập ${w.account} nên chưa đọc được số credit dev.\nBấm để mở trang đăng nhập giả lập (không cần mật khẩu, không gọi mạng).`
          : 'Chưa đăng nhập canvasapp.io.vn (hoặc phiên đăng nhập đã hết) nên chưa đọc được số credit thật.\nBấm để mở trang đăng nhập của canvasapp.',
        ariaLabel: sim ? 'DEV: chưa đăng nhập — bấm để đăng nhập tài khoản canvasapp giả lập' : 'canvasapp: chưa đăng nhập — bấm để đăng nhập canvasapp.io.vn',
      }
    case 'unavailable':
      return {
        ...base,
        tone: 'problem',
        value: '—',
        action: 'settings',
        title: `Không đọc được số credit ${w.name}: ${clean(info.error) || 'cổng canvasapp không dùng được ở đây'}.\nBấm để mở Cài đặt.`,
        ariaLabel: `${w.name}: không đọc được số credit — mở Cài đặt`,
      }
    case 'error':
      return {
        ...base,
        tone: 'problem',
        value: formatCreditNumber(balance),
        unit: has ? UNIT : null,
        low,
        busy: info.refreshing,
        action: 'refresh',
        topUp: true,
        title:
          `Không cập nhật được số credit ${w.name}: ${clean(info.error) || 'lỗi không rõ'}.` +
          (has ? `\nSố cuối cùng: ${amount}${when}.` : '') +
          (sim ? '\nChế độ Phát triển: lỗi này có thể do một lỗi giả đang bật trong Bảng phát triển.' : '') +
          '\nBấm để thử lại.',
        ariaLabel: has
          ? `${w.name}: ${formatCredits(balance, w.kind)} (chưa cập nhật được) — bấm để thử lại`
          : `${w.name}: không đọc được số credit — bấm để thử lại`,
      }
    case 'loading':
      if (!has) {
        return {
          ...base,
          tone: 'loading',
          value: '—',
          busy: true,
          action: 'refresh',
          title: `Đang đọc số credit của ${w.account}…`,
          ariaLabel: `${w.name}: đang đọc số credit`,
        }
      }
      break
    default:
      break
  }

  if (!has) {
    // 'ok' without a number cannot come from the store; never invent one.
    return {
      ...base,
      tone: 'loading',
      value: '—',
      busy: info.refreshing,
      action: 'refresh',
      title: `Chưa biết số credit ${w.name}. Bấm để đọc lại.`,
      ariaLabel: `${w.name}: chưa biết số credit — bấm để đọc lại`,
    }
  }
  const refreshing = info.refreshing ? ' · đang cập nhật…' : ''
  if (sim) {
    return {
      ...base,
      tone: 'dev',
      value: formatCreditNumber(balance),
      unit: UNIT,
      low,
      busy: info.refreshing,
      action: 'refresh',
      topUp: true,
      title:
        `${CREDIT_HINT.dev}.\nSố dư ${w.account}: ${amount}${when}${refreshing}.\n` +
        'Take mới trừ vào số này khi máy chủ giả lập nhận job. Bấm để cập nhật · đổi số dư hoặc gây lỗi trong Bảng phát triển.',
      ariaLabel: `DEV: ${formatCredits(balance, 'dev')} (giả lập, không phải tiền thật) — bấm để cập nhật`,
    }
  }
  return {
    ...base,
    tone: 'real',
    value: formatCreditNumber(balance),
    unit: UNIT,
    low,
    busy: info.refreshing,
    action: 'refresh',
    topUp: true,
    title: `Credit thật của tài khoản canvasapp.io.vn: ${amount}${when}${refreshing}.\n` + 'Take mới trừ vào số này khi canvasapp nhận job. Bấm để cập nhật.',
    ariaLabel: `canvasapp: ${formatCredits(balance, 'canvasapp')}, khoảng ${formatVnd(balance)} — bấm để cập nhật`,
  }
}
