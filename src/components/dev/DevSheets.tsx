// The two "windows" of the desktop gateway, simulated for development mode (providers/dev/prompts.ts): canvasapp's
// login page and the SePay checkout page, drawn as sheets ABOVE every dialog (the top-up sheet or Settings may be
// open under them). The dev bridge waits for the answer: login → answerDevLogin(accept); checkout →
// answerDevCheckout(choice, { outcome, delayMs }). No network, no password, no bank data — everything is fake.
//
// Keyboard: focus moves into the sheet (and back), Tab stays inside, Escape closes it ("Đóng" / "Đóng cửa sổ"), and
// no key reaches the dialogs or the canvas behind it (data-top-overlay + stopPropagation) — even when focus is not
// in the sheet (a click on its backdrop keeps focus where it was; a window listener catches the rest).
import { Bug, CircleCheck, CircleX, LogIn, OctagonAlert, ShieldCheck, Smartphone, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { formatVnd } from '../../core/topup'
import { formatCredits } from '../../lib/credits'
import {
  answerDevCheckout,
  answerDevLogin,
  DEV_EMAIL,
  DEV_PAYMENT_DELAY_MS,
  DEV_TOPUP_OUTCOME_LABEL,
  useDevPrompts,
  type DevCheckoutChoice,
  type DevCheckoutPrompt,
  type DevTopupOutcome,
} from '../../providers/dev'
import { trapTab, trapTabWithin, useOverlayFocus } from '../common/focus'
import { minutesLeft, placeholderQr } from './devModel'
import './dev.css'

/** Every open prompt of the dev bridge (normally at most one). Mounted once at the app root (App.tsx). */
export function DevSheets() {
  const login = useDevPrompts((s) => s.login)
  const checkout = useDevPrompts((s) => s.checkout)
  return (
    <>
      {login && <DevLoginSheet key={login.id} />}
      {checkout && <DevCheckoutSheet key={checkout.id} prompt={checkout} />}
    </>
  )
}

// ---------------------------------------------------------------------------------------------

function Sheet({ title, icon, onEscape, onBackdrop, children, footer, wide }: {
  title: string
  icon: ReactNode
  onEscape: () => void
  onBackdrop?: () => void
  children: ReactNode
  footer: ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useOverlayFocus(ref)
  const escape = useRef(onEscape)
  escape.current = onEscape
  // Keys pressed while focus is OUTSIDE the sheet (on <body>…): Escape closes it, Tab comes back in, nothing reaches
  // the dialogs (they ignore keys while a top overlay is open) or the global shortcuts behind it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const root = ref.current
      if (!root || (e.target instanceof Node && root.contains(e.target))) return
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        escape.current()
      } else if (e.key === 'Tab') trapTabWithin(root, e)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const onBackdropDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    // Focus stays in the sheet (a click on the backdrop would move it to <body>).
    e.preventDefault()
    if (onBackdrop) onBackdrop()
    else ref.current?.focus({ preventScroll: true })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Nothing typed here reaches the dialog under the sheet or the global shortcuts.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onEscape()
      return
    }
    trapTab(e)
  }
  return (
    <div className="dv-sheet-backdrop" data-top-overlay="" onMouseDown={onBackdropDown}>
      <div ref={ref} className={`dv-sheet${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="dv-sheet-head">
          <span className="dv-sheet-icon" aria-hidden="true">
            {icon}
          </span>
          <h2 id={titleId}>{title}</h2>
          <span className="dv-tag" title="Chế độ Phát triển — giả lập, không gọi mạng">
            DEV
          </span>
        </div>
        <div className="dv-sheet-body">{children}</div>
        <div className="dv-sheet-foot">{footer}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

/** "Đăng nhập canvasapp (giả lập)": the simulated login window (no password; the real one is canvasapp's own page). */
function DevLoginSheet() {
  return (
    <Sheet
      title="Đăng nhập canvasapp (giả lập)"
      icon={<LogIn size={18} />}
      onEscape={() => answerDevLogin(false)}
      onBackdrop={() => answerDevLogin(false)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => answerDevLogin(false)}>
            Đóng
          </button>
          <button type="button" className="btn btn-primary" autoFocus onClick={() => answerDevLogin(true)}>
            <LogIn size={14} /> Đăng nhập
          </button>
        </>
      }
    >
      <p className="dv-sheet-text">
        Đây là trang đăng nhập <b>giả lập</b> của chế độ Phát triển: không có mạng, không cần mật khẩu. Ở chế độ thật, SanoVids mở trang đăng nhập của canvasapp.io.vn
        trong một cửa sổ riêng và không bao giờ thấy mật khẩu của bạn.
      </p>
      <div className="dv-account">
        <span className="dv-account-avatar" aria-hidden="true">
          <Bug size={16} />
        </span>
        <span className="dv-account-text">
          <b>{DEV_EMAIL}</b>
          <small>Tài khoản canvasapp giả lập · credit dev (không phải tiền thật)</small>
        </span>
      </div>
      <p className="dv-sheet-note">Bấm “Đóng” để thử trường hợp người dùng đóng cửa sổ đăng nhập mà chưa đăng nhập.</p>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------------------------

const DELAYS: { ms: number; label: string }[] = [
  { ms: 0, label: 'ngay' },
  { ms: DEV_PAYMENT_DELAY_MS, label: `${DEV_PAYMENT_DELAY_MS / 1000} giây` },
  { ms: 10_000, label: '10 giây' },
  { ms: 60_000, label: '1 phút' },
]

const AFTER_SUCCESS: DevTopupOutcome[] = ['paid', 'reconcile_required', 'rejected', 'expired', 'none']

function useClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

/** The simulated SePay page: amount, order, a placeholder QR and the four ways the real window can end. */
function DevCheckoutSheet({ prompt }: { prompt: DevCheckoutPrompt }) {
  const now = useClock()
  const [afterSuccess, setAfterSuccess] = useState<DevTopupOutcome>('paid')
  const [paidBeforeClose, setPaidBeforeClose] = useState(false)
  const [delayMs, setDelayMs] = useState(DEV_PAYMENT_DELAY_MS)
  const outcomeId = useId()
  const delayId = useId()
  const qr = placeholderQr(prompt.orderId ?? prompt.checkoutUrl)
  const host = (() => {
    try {
      return new URL(prompt.checkoutUrl).host
    } catch {
      return prompt.checkoutUrl
    }
  })()

  const answer = (choice: DevCheckoutChoice) => {
    const outcome: DevTopupOutcome = choice === 'success' ? afterSuccess : choice === 'closed' && paidBeforeClose ? 'paid' : 'none'
    answerDevCheckout(choice, { outcome, delayMs })
  }

  return (
    <Sheet
      title="Thanh toán SePay (giả lập)"
      icon={<ShieldCheck size={18} />}
      wide
      onEscape={() => answer('closed')}
      footer={
        <>
          <button type="button" className="btn" onClick={() => answer('closed')} title="Đóng cửa sổ thanh toán (SanoVids nhận “closed”)">
            <X size={14} /> Đóng cửa sổ
          </button>
          <span className="dv-spacer" />
          <button type="button" className="btn" onClick={() => answer('error')} title="SePay báo lỗi thanh toán (payment=error)">
            <OctagonAlert size={14} /> Lỗi thanh toán
          </button>
          <button type="button" className="btn" onClick={() => answer('cancel')} title="Người dùng huỷ trên trang SePay (payment=cancel)">
            <CircleX size={14} /> Huỷ
          </button>
          <button type="button" className="btn btn-primary" autoFocus onClick={() => answer('success')} title="SePay xác nhận thanh toán (payment=success)">
            <CircleCheck size={14} /> Thanh toán thành công
          </button>
        </>
      }
    >
      <div className="dv-addr" title={prompt.checkoutUrl}>
        <ShieldCheck size={12} aria-hidden="true" />
        <span className="mono">{host}</span>
        <span className="dv-addr-note">trang giả — không mở mạng</span>
      </div>
      <div className="dv-pay">
        <div className="dv-qr" role="img" aria-label="Mã QR giả lập (không quét được)">
          <svg viewBox={`-1 -1 ${qr.length + 2} ${qr.length + 2}`} shapeRendering="crispEdges" aria-hidden="true">
            {qr.map((row, r) => row.map((on, c) => (on ? <rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} /> : null)))}
          </svg>
          <small>Mã QR giả — không quét được</small>
        </div>
        <dl className="dv-pay-info">
          <dt>Số tiền</dt>
          <dd className="dv-pay-amount">{formatVnd(prompt.amountVnd)}</dd>
          <dt>Nhận</dt>
          <dd>{prompt.credits !== null ? `${formatCredits(prompt.credits, 'dev')} (giả lập)` : '—'}</dd>
          <dt>Mã đơn</dt>
          <dd className="mono">{prompt.orderId ?? '—'}</dd>
          <dt>Tự đóng sau</dt>
          <dd className="mono">{minutesLeft(prompt.timeoutAt, now)}</dd>
        </dl>
      </div>

      <div className="dv-pay-opts">
        <label className="dv-pay-opt" htmlFor={outcomeId}>
          <span>Sau “Thanh toán thành công”, canvasapp giả lập sẽ:</span>
          <select id={outcomeId} className="select" value={afterSuccess} onChange={(e) => setAfterSuccess(e.target.value as DevTopupOutcome)}>
            {AFTER_SUCCESS.map((o) => (
              <option key={o} value={o}>
                {DEV_TOPUP_OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
        </label>
        <label className="dv-pay-opt" htmlFor={delayId}>
          <span>Ghi nhận sau</span>
          <select id={delayId} className="select" value={delayMs} onChange={(e) => setDelayMs(Number(e.target.value))}>
            {DELAYS.map((d) => (
              <option key={d.ms} value={d.ms}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox dv-pay-check">
          <input type="checkbox" checked={paidBeforeClose} onChange={(e) => setPaidBeforeClose(e.target.checked)} />
          <Smartphone size={13} aria-hidden="true" /> Đã chuyển khoản trên điện thoại rồi mới bấm “Đóng cửa sổ”
        </label>
      </div>

      {Object.keys(prompt.fields).length > 0 && (
        <details className="dv-fields">
          <summary>Dữ liệu đơn canvasapp gửi sang SePay ({Object.keys(prompt.fields).length} trường)</summary>
          <dl>
            {Object.entries(prompt.fields).map(([k, v]) => (
              <div key={k}>
                <dt className="mono">{k}</dt>
                <dd className="mono">{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <p className="dv-sheet-note">
        Không có tiền thật, không có thông tin ngân hàng. Ở chế độ thật, đây là trang SePay trong một cửa sổ riêng và bạn tự quét QR bằng app ngân hàng.
      </p>
    </Sheet>
  )
}
