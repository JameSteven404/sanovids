// The credit pill — ONE component for every place that shows the balance new takes spend: the top bar and the
// queue drawer bar (docs/SPEC-v2.md §9). Which wallet it shows follows the provider for new takes (useCreditInfo()):
//   demo       dashed neutral "DEMO" pill with a flask (play money, tooltip "Credit giả lập — không phải tiền thật");
//              click → Cài đặt (Đặt lại / +100).
//   canvasapp  solid tinted "canvasapp · 1.234 credit" (≈ đồng + last update in the tooltip); click → re-read.
//              A small "+" next to it opens "Nạp credit canvasapp" (SePay QR, components/topup).
//              Not logged in → "canvasapp · Đăng nhập" (opens canvasapp's own login window). Unknown → "—".
// What it shows for each state: creditPillModel.ts (pure, tested).
import { FlaskConical, LoaderCircle, LogIn, Plus, TriangleAlert, Wallet } from 'lucide-react'
import { memo, useState } from 'react'
import { openTopUp } from '../../actions'
import { canvasappBridge } from '../../providers/canvasapp/transport'
import { refreshRealCredits, useCreditInfo } from '../../store/credits'
import { useRuns } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { creditPillView } from './creditPillModel'
import './creditPill.css'

let loginInFlight: Promise<boolean> | null = null

/**
 * Open canvasapp's own login page (desktop bridge, a separate window — SanoVids never sees the password), then
 * re-read the real balance. Outside the desktop app it opens Cài đặt instead. Resolves true when logged in.
 * Concurrent calls share one login window.
 */
export function loginToCanvasapp(): Promise<boolean> {
  if (loginInFlight) return loginInFlight
  const bridge = canvasappBridge()
  if (!bridge) {
    useUI.getState().openDialog({ kind: 'settings' })
    return Promise.resolve(false)
  }
  const run = async (): Promise<boolean> => {
    try {
      const st = await bridge.login()
      const ok = st.ok && st.authenticated
      if (ok) toast('Đã đăng nhập canvasapp.io.vn.', { tone: 'success' })
      else if (!st.ok) toast(`Không đăng nhập được canvasapp: ${st.message}`, { tone: 'error' })
      await refreshRealCredits({ force: true })
      return ok
    } catch (e) {
      toast(`Không mở được trang đăng nhập canvasapp: ${(e as Error)?.message ?? String(e)}`, { tone: 'error' })
      return false
    } finally {
      loginInFlight = null
    }
  }
  loginInFlight = run()
  return loginInFlight
}

/** Re-read the real balance now (the user clicked it); says so when it did not work. */
async function refreshWithFeedback() {
  const st = await refreshRealCredits({ force: true })
  if (st.status === 'error') toast(`Không cập nhật được số credit canvasapp: ${st.error ?? 'lỗi không rõ'}`, { tone: 'error' })
  else if (st.status === 'login-required') toast('Phiên canvasapp đã hết — bấm “canvasapp · Đăng nhập” để đăng nhập lại.', { tone: 'warning' })
}

export interface CreditPillProps {
  /** 'md' = top bar (26px), 'sm' = queue drawer bar (24px). */
  size?: 'md' | 'sm'
}

export const CreditPill = memo(function CreditPill({ size = 'md' }: CreditPillProps) {
  const info = useCreditInfo()
  const spent = useRuns((s) => s.spent)
  const [loggingIn, setLoggingIn] = useState(false)
  const v = creditPillView(info, { spent })
  const busy = v.busy || loggingIn

  const onClick = () => {
    if (v.action === 'settings') useUI.getState().openDialog({ kind: 'settings' })
    else if (v.action === 'login') {
      if (loggingIn) return
      setLoggingIn(true)
      void loginToCanvasapp().finally(() => setLoggingIn(false))
    } else void refreshWithFeedback()
  }

  const icon = busy ? (
    <LoaderCircle size={13} className="tb-cp-spin" />
  ) : v.tone === 'demo' ? (
    <FlaskConical size={13} />
  ) : v.tone === 'login' ? (
    <LogIn size={13} />
  ) : v.tone === 'problem' ? (
    <TriangleAlert size={13} />
  ) : (
    <Wallet size={13} />
  )

  const pill = (
    <button
      type="button"
      className={`tb-cp ${size} ${v.tone}${v.low ? ' low' : ''}`}
      onClick={onClick}
      title={v.title}
      aria-label={v.ariaLabel}
      aria-busy={busy || undefined}
    >
      <span className="tb-cp-icon" aria-hidden="true">
        {icon}
      </span>
      {v.source && (
        <span className="tb-cp-src" aria-hidden="true">
          {v.source}
          <span className="tb-cp-sep"> ·</span>
        </span>
      )}
      <b className="tb-cp-num" aria-hidden="true">
        {v.value}
      </b>
      {v.unit && (
        <span className="tb-cp-unit" aria-hidden="true">
          {v.unit}
        </span>
      )}
      {v.tone === 'demo' && (
        <span className="tb-cp-tag" aria-hidden="true">
          DEMO
        </span>
      )}
    </button>
  )
  if (v.tone !== 'real' && v.tone !== 'problem') return pill
  // Real account: top-up sits right next to the balance (a sibling button — never nested in the pill).
  return (
    <span className={`tb-cp-group ${size}`}>
      {pill}
      <button
        type="button"
        className={`tb-cp-add ${size}${v.low ? ' low' : ''}`}
        onClick={() => openTopUp('topup')}
        title="Nạp credit canvasapp (quét QR SePay) · xem lịch sử credit"
        aria-label="Nạp credit canvasapp"
      >
        <Plus size={13} />
      </button>
    </span>
  )
})
