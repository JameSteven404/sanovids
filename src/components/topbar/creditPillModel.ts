// What the credit pill shows — pure, no stores (tested in __tests__/creditPill.test.ts). docs/SPEC-v2.md §9.
// The pill itself is CreditPill.tsx (top bar + queue drawer bar).
//
//   demo        neutral dashed pill  [flask] 1.000 credit DEMO        click → Cài đặt (đặt lại / +100)
//   real        solid tinted pill    [wallet] canvasapp · 1.234 credit click → re-read the real balance
//   login       tinted action        [log-in] canvasapp · Đăng nhập   click → canvasapp's login window
//   loading     tinted, spinner      canvasapp · —                    (never a made-up number)
//   problem     warning tint         canvasapp · 1.234 | —            click → try again (or Cài đặt when unavailable)
import { creditUnitLabel, DEMO_CREDIT_HINT, formatCreditNumber, formatCredits, formatVnd } from '../../lib/credits'
import type { CreditInfo } from '../../store/credits'

/** Below this the balance number turns red (a 1080p 15 s video costs 20). */
export const LOW_CREDITS = 20

/** The word after the number: plain "credit" for both wallets — on the demo pill the "DEMO" tag names the wallet. */
const UNIT = creditUnitLabel('canvasapp')

export type CreditPillTone = 'demo' | 'real' | 'login' | 'loading' | 'problem'
export type CreditPillAction = 'settings' | 'refresh' | 'login'

export interface CreditPillView {
  tone: CreditPillTone
  /** The big text: the number, "—" (unknown) or "Đăng nhập". */
  value: string
  /** Word after the value ("credit"); hidden in narrow spots. null = none. */
  unit: string | null
  /** canvasapp states: the source named before the value ("canvasapp"). null for demo. */
  source: string | null
  /** Balance known and below LOW_CREDITS. */
  low: boolean
  /** A read of the real balance is in flight (spinner). */
  busy: boolean
  action: CreditPillAction
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

/** The pill for a CreditInfo (useCreditInfo()). `spent` = demo credits spent (shown in the demo tooltip). */
export function creditPillView(info: CreditPillInput, opts: { spent?: number; now?: number } = {}): CreditPillView {
  const { balance } = info
  const has = known(balance)
  const low = has && balance < LOW_CREDITS

  if (info.kind === 'demo') {
    const amount = formatCredits(balance, 'demo')
    const spent = known(opts.spent) ? ` · đã dùng ${formatCredits(opts.spent, 'demo')}` : ''
    return {
      tone: 'demo',
      value: formatCreditNumber(balance),
      unit: UNIT,
      source: null,
      low,
      busy: false,
      action: 'settings',
      title: `${DEMO_CREDIT_HINT}.\nSố dư: ${amount}${spent}.\nChỉ Demo giả lập dùng credit này. Bấm để đặt lại hoặc thêm credit demo trong Cài đặt.`,
      ariaLabel: `Credit demo: ${amount} — ${DEMO_CREDIT_HINT}. Mở Cài đặt`,
    }
  }

  const source = 'canvasapp'
  const when = has && info.updatedAt ? ` (cập nhật lúc ${clockText(info.updatedAt, opts.now)})` : ''
  const real = has ? `${formatCredits(balance, 'canvasapp')} ≈ ${formatVnd(balance)}` : ''

  switch (info.status) {
    case 'login-required':
      return {
        tone: 'login',
        value: 'Đăng nhập',
        unit: null,
        source,
        low: false,
        busy: false,
        action: 'login',
        title: 'Chưa đăng nhập canvasapp.io.vn (hoặc phiên đăng nhập đã hết) nên chưa đọc được số credit thật.\nBấm để mở trang đăng nhập của canvasapp.',
        ariaLabel: 'canvasapp: chưa đăng nhập — bấm để đăng nhập canvasapp.io.vn',
      }
    case 'unavailable':
      return {
        tone: 'problem',
        value: '—',
        unit: null,
        source,
        low: false,
        busy: false,
        action: 'settings',
        title: `Không đọc được số credit canvasapp: ${clean(info.error) || 'cổng canvasapp không dùng được ở đây'}.\nBấm để mở Cài đặt.`,
        ariaLabel: 'canvasapp: không đọc được số credit — mở Cài đặt',
      }
    case 'error':
      return {
        tone: 'problem',
        value: formatCreditNumber(balance),
        unit: has ? UNIT : null,
        source,
        low,
        busy: info.refreshing,
        action: 'refresh',
        title:
          `Không cập nhật được số credit canvasapp: ${clean(info.error) || 'lỗi không rõ'}.` +
          (has ? `\nSố cuối cùng: ${real}${when}.` : '') +
          '\nBấm để thử lại.',
        ariaLabel: has
          ? `canvasapp: ${formatCredits(balance, 'canvasapp')} (chưa cập nhật được) — bấm để thử lại`
          : 'canvasapp: không đọc được số credit — bấm để thử lại',
      }
    case 'loading':
      if (!has) {
        return {
          tone: 'loading',
          value: '—',
          unit: null,
          source,
          low: false,
          busy: true,
          action: 'refresh',
          title: 'Đang đọc số credit của tài khoản canvasapp.io.vn…',
          ariaLabel: 'canvasapp: đang đọc số credit',
        }
      }
      break
    default:
      break
  }

  if (!has) {
    // 'ok' without a number cannot come from the store; never invent one.
    return {
      tone: 'loading',
      value: '—',
      unit: null,
      source,
      low: false,
      busy: info.refreshing,
      action: 'refresh',
      title: 'Chưa biết số credit canvasapp. Bấm để đọc lại.',
      ariaLabel: 'canvasapp: chưa biết số credit — bấm để đọc lại',
    }
  }
  return {
    tone: 'real',
    value: formatCreditNumber(balance),
    unit: UNIT,
    source,
    low,
    busy: info.refreshing,
    action: 'refresh',
    title:
      `Credit thật của tài khoản canvasapp.io.vn: ${real}${when}${info.refreshing ? ' · đang cập nhật…' : ''}.\n` +
      'Take mới trừ vào số này khi canvasapp nhận job. Bấm để cập nhật.',
    ariaLabel: `canvasapp: ${formatCredits(balance, 'canvasapp')}, khoảng ${formatVnd(balance)} — bấm để cập nhật`,
  }
}
