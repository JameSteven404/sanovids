// "Nạp credit canvasapp" sheet — docs/SPEC-v2.md §10. Tops up the user's OWN canvasapp.io.vn account (SanoVids has no
// credit system of its own). In development mode (§11) the same sheet tops up the SIMULATED account through the
// simulated SePay sheet (components/dev/DevSheets) — "Nạp credit dev (giả lập)", no money, no network. Two tabs: "Nạp credit" (presets / custom amount → "Mở thanh toán QR" → the real SePay
// page in the desktop checkout window → canvasapp's order status) and "Lịch sử credit" (CreditHistory.tsx).
//
// Safety: SanoVids never asks for, sees or types bank/card data, never scripts the payment page and never says
// "paid" before canvasapp does. The order lifecycle (one order at a time, polling, TTL) is appFlow.ts / topupFlow.ts;
// what each state shows is topupModel.ts (pure, tested).
// Gate: desktop build with the canvasapp bridge (+ checkout() for top-up), logged in, topup_enabled (GET /api/auth/state).
import {
  ArrowDownToLine,
  Ban,
  CircleAlert,
  CircleCheck,
  CircleQuestionMark,
  CircleX,
  Clock,
  ExternalLink,
  Hourglass,
  LoaderCircle,
  LogIn,
  QrCode,
  ReceiptText,
  RefreshCw,
  ScanSearch,
  Settings,
  ShieldCheck,
  TriangleAlert,
  Wallet,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { TOPUP_PRESETS } from '../../core/topup'
import { formatCreditNumber, formatVnd as creditsInVnd } from '../../lib/credits'
import { usePwaInstall } from '../../lib/pwa'
import { activeGateway } from '../../providers'
import { canvasappErrorText, isLoginRequired, type CreditHistoryQuery } from '../../providers/canvasapp/api'
import { hasCheckoutBridge } from '../../providers/canvasapp/transport'
import { refreshRealCredits, useRealCredits, type RealCreditsState } from '../../store/credits'
import { useUI, type TopUpTab } from '../../store/ui'
import { Modal } from '../common/Modal'
import { loginToCanvasapp } from '../topbar/CreditPill'
import { flowGateway, topupFlow, useTopupFlowState } from './appFlow'
import { CreditHistory } from './CreditHistory'
import { canReopen, isOrderInFlight, type TopupFlowState } from './topupFlow'
import {
  amountFieldText,
  amountHint,
  formatCountdown,
  presetView,
  remainingMs,
  statusView,
  topupGate,
  type AuthProbe,
  type GateView,
  type StatusIcon,
} from './topupModel'
import './topup.css'

const TABS: { id: TopUpTab; label: string; icon: ReactNode }[] = [
  { id: 'topup', label: 'Nạp credit', icon: <QrCode size={14} /> },
  { id: 'history', label: 'Lịch sử credit', icon: <ReceiptText size={14} /> },
]

const FINAL_PHASES: readonly TopupFlowState['phase'][] = ['paid', 'review', 'expired', 'rejected']

/** GET /api/auth/state (logged in? topup_enabled?). `run` re-checks; answers to older checks are ignored. */
function useAuthProbe(enabled: boolean) {
  const [probe, setProbe] = useState<AuthProbe>({ state: 'idle' })
  const [checking, setChecking] = useState(false)
  const seq = useRef(0)
  const run = useCallback(() => {
    if (!enabled) return
    const id = ++seq.current
    setChecking(true)
    setProbe((p) => (p.state === 'idle' ? { state: 'loading' } : p))
    // the gateway of the order in flight, else the active one (development mode: the simulated canvasapp)
    flowGateway()
      .api.authState()
      .then(
        (st) => {
          if (id !== seq.current) return
          setProbe({ state: 'ok', authenticated: st?.authenticated === true, topupEnabled: st?.topup_enabled === true })
        },
        (e: unknown) => {
          if (id !== seq.current) return
          setProbe({ state: 'error', message: canvasappErrorText(e), loginRequired: isLoginRequired(e) })
        },
      )
      .finally(() => {
        if (id === seq.current) setChecking(false)
      })
  }, [enabled])
  return { probe, checking, run }
}

/** Ticks every second while `active` (TTL countdown, "Mở lại" availability). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

export function TopUpDialog({ tab: requestedTab }: { tab?: TopUpTab }) {
  const close = useCallback(() => useUI.getState().closeDialog(), [])
  const [tab, setTab] = useState<TopUpTab>(requestedTab ?? 'topup')
  // openTopUp('history') while the sheet is already open switches the tab.
  useEffect(() => {
    if (requestedTab) setTab(requestedTab)
  }, [requestedTab])
  const showTab = useCallback((t: TopUpTab) => {
    setTab(t)
    // Keep the dialog state in sync (appFlow toasts only when the status is not on screen).
    const d = useUI.getState().dialog
    if (d.kind === 'topup' && (d.tab ?? 'topup') !== t) useUI.getState().openDialog({ kind: 'topup', tab: t })
  }, [])

  const { desktop } = usePwaInstall()
  // The order's gateway while one is in flight, else the active one (appFlow): title, gate, login and history follow
  // it; the balance card shows the ACTIVE gateway's balance (the credits store), labelled as such.
  const gateway = flowGateway()
  const dev = gateway.simulated
  const historyLoad = useCallback((q: CreditHistoryQuery) => flowGateway().api.creditHistory(q), [])
  const bridge = !!gateway.bridge()
  const checkout = hasCheckoutBridge(gateway.bridge)
  const realLoginRequired = useRealCredits((s) => s.status === 'login-required')
  const { probe, checking, run: recheck } = useAuthProbe(bridge)
  const [loggingIn, setLoggingIn] = useState(false)
  /** Bumped after each successful login: the history reloads. */
  const [loginEpoch, setLoginEpoch] = useState(0)

  // Opening the sheet: read the login state (+ topup_enabled) and the balance (throttled). Again whenever the
  // real-credit store sees the session end / come back.
  useEffect(() => {
    if (!bridge) return
    recheck()
    void refreshRealCredits()
  }, [bridge, recheck, realLoginRequired])

  const gateInput = { desktop, bridge, checkout, auth: probe, loginRequired: realLoginRequired, simulated: dev }
  const topupGateView = topupGate(gateInput, 'topup')
  const historyGateView = topupGate(gateInput, 'history')

  const flow = useTopupFlowState()
  const inFlight = isOrderInFlight(flow.phase)
  const now = useNow(flow.expiresAt !== null && flow.phase !== 'idle' && !FINAL_PHASES.includes(flow.phase))

  const [amountText, setAmountText] = useState(() => amountFieldText(flow.amount ?? TOPUP_PRESETS[1]))
  const hint = amountHint(amountText)

  /** canvasapp's own login window (shared with the credit pill; SanoVids never sees the password). */
  const login = async () => {
    if (loggingIn) return
    setLoggingIn(true)
    let ok = false
    try {
      ok = await loginToCanvasapp(flowGateway())
    } finally {
      setLoggingIn(false)
      recheck()
    }
    if (!ok) return
    setLoginEpoch((n) => n + 1)
    // The order was being confirmed when the session ended: carry on reading its status.
    const f = topupFlow.store.getState()
    if (f.phase === 'error' && f.error?.code === 'login-required' && f.error.retry === 'poll') void topupFlow.retry()
  }

  const onGateAction = (g: GateView) => {
    if (g.action === 'settings') useUI.getState().openDialog({ kind: 'settings' })
    else if (g.action === 'retry') recheck()
    else if (g.action === 'login') void login()
  }

  const startOrder = () => {
    if (!topupGateView.ok || inFlight || hint.amount === null) return
    void topupFlow.start(hint.amount)
  }

  const newOrder = () => {
    topupFlow.reset()
  }

  // ---- footer: one primary action ----
  let footer: ReactNode
  if (tab === 'history') {
    footer = (
      <button type="button" className="btn" onClick={close}>
        Đóng
      </button>
    )
  } else if (flow.phase === 'idle') {
    footer = (
      <>
        <button type="button" className="btn" onClick={close}>
          Đóng
        </button>
        <button type="button" className="btn btn-primary" onClick={startOrder} disabled={!topupGateView.ok || hint.amount === null}>
          <QrCode size={15} /> Mở thanh toán QR
        </button>
      </>
    )
  } else if (inFlight) {
    footer = (
      <>
        <span className="tu-foot-note">Có thể đóng hộp thoại — SanoVids vẫn theo dõi đơn này và báo khi canvasapp xác nhận.</span>
        <button type="button" className="btn" onClick={close} title="Đóng (đơn nạp vẫn được theo dõi)">
          Đóng
        </button>
      </>
    )
  } else if (flow.phase === 'paid') {
    footer = (
      <>
        <button type="button" className="btn" onClick={newOrder}>
          Nạp thêm
        </button>
        <button type="button" className="btn btn-primary" onClick={close}>
          Xong
        </button>
      </>
    )
  } else if (flow.phase === 'error' && flow.error?.retry) {
    footer = (
      <>
        <button type="button" className="btn" onClick={newOrder}>
          Tạo đơn mới
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void topupFlow.retry()}>
          <RefreshCw size={14} /> Thử lại
        </button>
      </>
    )
  } else {
    footer = (
      <>
        <button type="button" className="btn" onClick={close}>
          Đóng
        </button>
        <button type="button" className="btn btn-primary" onClick={newOrder}>
          {flow.phase === 'review' ? 'Nạp thêm' : 'Tạo đơn mới'}
        </button>
      </>
    )
  }

  return (
    <Modal
      title={dev ? 'Nạp credit dev (giả lập)' : 'Nạp credit canvasapp'}
      headerExtra={
        dev ? (
          <span className="tu-dev-tag" title="Chế độ Phát triển: canvasapp và SePay đều giả lập — không có tiền thật, không gọi mạng">
            DEV
          </span>
        ) : undefined
      }
      onClose={close}
      footer={footer}
    >
      <div className="tu-sheet">
        <BalanceCard dev={activeGateway().simulated} />
        <TabSwitch value={tab} onChange={showTab} busy={inFlight} />

        <div role="tabpanel" id={`tu-panel-${tab}`} aria-labelledby={`tu-tab-${tab}`} className="tu-panel">
          {tab === 'history' ? (
            historyGateView.ok ? (
              <CreditHistory
                reloadKey={`${flow.phase === 'paid' ? (flow.checkedAt ?? 0) : 0}:${loginEpoch}`}
                load={historyLoad}
                simulated={dev}
                onLogin={() => void login()}
              />
            ) : (
              <GateNotice gate={historyGateView} busy={loggingIn || checking} onAction={onGateAction} />
            )
          ) : flow.phase !== 'idle' ? (
            <StatusCard flow={flow} now={now} onLogin={() => void login()} onHistory={() => showTab('history')} loggingIn={loggingIn} />
          ) : !topupGateView.ok ? (
            <GateNotice gate={topupGateView} busy={loggingIn || checking} onAction={onGateAction} />
          ) : (
            <AmountForm text={amountText} onText={setAmountText} onSubmit={startOrder} dev={dev} />
          )}
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------

type RealView = Pick<RealCreditsState, 'balance' | 'status' | 'refreshing'>

function balanceNote(real: RealView, dev: boolean): string {
  if (real.balance !== null) return dev ? 'Credit giả lập của chế độ Phát triển — không phải tiền thật' : `≈ ${creditsInVnd(real.balance)} · 1 credit ≈ 1.000đ`
  switch (real.status) {
    case 'login-required':
      return dev ? 'Chưa đăng nhập tài khoản giả lập' : 'Chưa đăng nhập canvasapp'
    case 'unavailable':
      return 'Chỉ đọc được trong bản desktop'
    case 'error':
      return 'Chưa đọc được số dư'
    default:
      return 'Đang đọc số dư…'
  }
}

function BalanceCard({ dev }: { dev: boolean }) {
  const real = useRealCredits(useShallow((s): RealView => ({ balance: s.balance, status: s.status, refreshing: s.refreshing })))
  const canRead = real.status !== 'unavailable'
  return (
    <div className={`tu-balance${dev ? ' dev' : ''}`}>
      <span className="tu-balance-icon" aria-hidden="true">
        <Wallet size={18} />
      </span>
      <div className="tu-balance-text">
        <span className="tu-label">{dev ? 'Số dư DEV · credit giả lập' : 'Số dư canvasapp · credit thật'}</span>
        <span className="tu-balance-num">
          <b>{formatCreditNumber(real.balance)}</b>
          {real.balance !== null && <span>{dev ? ' credit dev' : ' credit'}</span>}
        </span>
        <small>{balanceNote(real, dev)}</small>
      </div>
      {canRead && (
        <button
          type="button"
          className="icon-btn"
          onClick={() => void refreshRealCredits({ force: true })}
          disabled={real.refreshing}
          title={dev ? 'Đọc lại số dư từ canvasapp giả lập' : 'Đọc lại số dư từ canvasapp'}
          aria-label={dev ? 'Đọc lại số dư giả lập' : 'Đọc lại số dư canvasapp'}
        >
          {real.refreshing ? <LoaderCircle size={15} className="tu-spin" /> : <RefreshCw size={15} />}
        </button>
      )}
    </div>
  )
}

function TabSwitch({ value, onChange, busy }: { value: TopUpTab; onChange: (t: TopUpTab) => void; busy: boolean }) {
  const index = TABS.findIndex((t) => t.id === value)
  const style = { '--seg-n': TABS.length, '--seg-i': Math.max(0, index) } as CSSProperties
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = TABS[(index + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
    onChange(next.id)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus()
  }
  return (
    <div className="tu-seg" role="tablist" aria-label="Nạp credit hoặc lịch sử credit" style={style} onKeyDown={onKeyDown}>
      {TABS.map((t) => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tu-tab-${t.id}`}
            aria-selected={on}
            aria-controls={`tu-panel-${t.id}`}
            tabIndex={on ? 0 : -1}
            data-tab={t.id}
            className={on ? 'active' : ''}
            onClick={() => !on && onChange(t.id)}
            title={t.id === 'topup' && busy ? 'Đang có một đơn nạp chờ xác nhận' : undefined}
          >
            {t.icon}
            {t.label}
            {t.id === 'topup' && busy && (
              <>
                <span className="tu-seg-dot" aria-hidden="true" />
                <span className="tu-sr">(đang có đơn nạp)</span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}

function GateNotice({ gate, busy, onAction }: { gate: GateView; busy: boolean; onAction: (g: GateView) => void }) {
  const icon =
    gate.state === 'checking' ? (
      <LoaderCircle size={20} className="tu-spin" />
    ) : gate.state === 'login' ? (
      <LogIn size={20} />
    ) : gate.state === 'disabled' ? (
      <Ban size={20} />
    ) : gate.state === 'error' ? (
      <TriangleAlert size={20} />
    ) : (
      <Settings size={20} />
    )
  return (
    <div className={`tu-gate ${gate.state}`} role="status">
      <span className="tu-gate-icon" aria-hidden="true">
        {icon}
      </span>
      <b className="tu-gate-title">{gate.title}</b>
      <p className="tu-gate-text">{gate.message}</p>
      {gate.action && gate.actionLabel && (
        <button type="button" className={`btn ${gate.action === 'login' ? 'btn-primary' : ''}`} onClick={() => onAction(gate)} disabled={busy}>
          {busy ? <LoaderCircle size={14} className="tu-spin" /> : gate.action === 'login' ? <LogIn size={14} /> : gate.action === 'retry' ? <RefreshCw size={14} /> : <Settings size={14} />}
          {gate.actionLabel}
        </button>
      )}
    </div>
  )
}

function AmountForm({ text, onText, onSubmit, dev }: { text: string; onText: (t: string) => void; onSubmit: () => void; dev: boolean }) {
  const hint = amountHint(text)
  const presets = TOPUP_PRESETS.map(presetView)
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSubmit()
    }
  }
  return (
    <div className="tu-form">
      <div className="tu-field">
        <span className="tu-label" id="tu-presets-label">
          Chọn số tiền
        </span>
        <div className="tu-presets" role="radiogroup" aria-labelledby="tu-presets-label">
          {presets.map((p) => {
            const on = hint.amount === p.vnd
            return (
              <button key={p.vnd} type="button" role="radio" aria-checked={on} className={`tu-preset${on ? ' active' : ''}`} onClick={() => onText(amountFieldText(p.vnd))}>
                <b>{p.label}</b>
                <small>{p.credits}</small>
              </button>
            )
          })}
        </div>
      </div>

      <label className="tu-field">
        <span className="tu-label">Hoặc nhập số tiền khác</span>
        <span className={`tu-amount${hint.tone === 'error' ? ' invalid' : ''}`}>
          <input
            className="tu-amount-input"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="VD: 150.000 hoặc 150k"
            value={text}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={onKeyDown}
            aria-invalid={hint.tone === 'error' || undefined}
            aria-describedby="tu-amount-hint"
            maxLength={24}
          />
          <span className="tu-amount-suffix" aria-hidden="true">
            đ
          </span>
        </span>
        <span id="tu-amount-hint" className={`tu-hint ${hint.tone}`} aria-live="polite">
          {hint.tone === 'ok' && <CircleCheck size={13} />}
          {hint.tone === 'error' && <CircleAlert size={13} />}
          {hint.text}
        </span>
      </label>

      {dev ? (
        <div className="tu-note dev">
          <ShieldCheck size={15} />
          <div>
            <b>SePay giả lập · 1.000đ = 1 credit dev · Không có tiền thật, không gọi mạng.</b>
            <span>
              “Mở thanh toán QR” mở trang SePay giả ngay trong app: chọn Thanh toán thành công / Huỷ / Lỗi thanh toán / Đóng cửa sổ để thử từng trường hợp. Credit dev được
              cộng khi canvasapp giả lập xác nhận (≈ 2 giây sau). Đơn nạp có hiệu lực 10 phút như thật.
            </span>
          </div>
        </div>
      ) : (
        <div className="tu-note">
          <ShieldCheck size={15} />
          <div>
            <b>1.000đ = 1 credit · Thanh toán bằng QR trên trang SePay của canvasapp · SanoVids không nhận thông tin ngân hàng.</b>
            <span>
              Credit được cộng vào tài khoản canvasapp.io.vn của bạn (tiền thật) ngay khi canvasapp xác nhận đã nhận tiền. Đơn nạp có hiệu lực 10 phút.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function statusIcon(icon: StatusIcon): ReactNode {
  switch (icon) {
    case 'spinner':
      return <LoaderCircle size={22} className="tu-spin" />
    case 'qr':
      return <QrCode size={22} />
    case 'check':
      return <CircleCheck size={22} />
    case 'review':
      return <ScanSearch size={22} />
    case 'expired':
      return <Hourglass size={22} />
    case 'rejected':
      return <CircleX size={22} />
    case 'cancelled':
      return <Ban size={22} />
    case 'unknown':
      return <CircleQuestionMark size={22} />
    default:
      return <TriangleAlert size={22} />
  }
}

function StatusCard({
  flow,
  now,
  onLogin,
  onHistory,
  loggingIn,
}: {
  flow: TopupFlowState
  now: number
  onLogin: () => void
  onHistory: () => void
  loggingIn: boolean
}) {
  const v = statusView(flow)
  const left = remainingMs(flow.expiresAt, now)
  const reopenable = canReopen(flow, now)
  const loginNeeded = flow.phase === 'error' && flow.error?.code === 'login-required'
  const canCheck =
    !!flow.orderId && (flow.phase === 'waiting' || flow.phase === 'cancelled' || (flow.phase === 'error' && !loginNeeded) || (flow.phase === 'expired' && flow.expiredLocally))
  const showHistory = ['paid', 'review', 'expired', 'untracked', 'cancelled'].includes(flow.phase)
  const canStop = (flow.phase === 'waiting' && flow.windowClosedEarly) || flow.phase === 'untracked' || (flow.phase === 'error' && flow.error?.retry === 'poll')

  return (
    <div className={`tu-status tone-${v.tone}`}>
      <span className="tu-status-icon" aria-hidden="true">
        {statusIcon(v.icon)}
      </span>
      <div className="tu-status-main" role="status" aria-live="polite">
        <b className="tu-status-title">{v.title}</b>
        {v.detail && <p className="tu-status-detail">{v.detail}</p>}

        <div className="tu-status-meta">
          {flow.amount !== null && flow.credits !== null && (
            <span className="tu-chip">
              <ArrowDownToLine size={12} /> {presetView(flow.amount).label} = {formatCreditNumber(flow.credits)} credit
            </span>
          )}
          {v.countdown && left !== null && (
            <span className={`tu-chip tu-countdown${left <= 60_000 ? ' soon' : ''}`} title="Thời gian còn lại của đơn nạp trên canvasapp">
              <Clock size={12} /> {left > 0
                ? `Đơn còn hiệu lực ${formatCountdown(left)}`
                : flow.phase === 'waiting'
                  ? 'Đơn đã hết thời hạn — đang kiểm tra lần cuối…'
                  : 'Đơn đã hết thời hạn'}
            </span>
          )}
          {flow.orderId && <span className="tu-order mono">Mã đơn {flow.orderId}</span>}
        </div>

        {flow.pollWarning && (
          <div className="tu-status-warn">
            <TriangleAlert size={13} /> {flow.pollWarning}
          </div>
        )}
        {flow.blockedHost && (
          <div className="tu-status-diag">Cửa sổ thanh toán đã chặn chuyển sang “{flow.blockedHost.slice(0, 80)}” (ngoài SePay / canvasapp) để giữ an toàn.</div>
        )}
        {flow.phase === 'checkout' && <div className="tu-status-diag">Hoàn tất thanh toán hoặc đóng cửa sổ “Thanh toán nạp credit” để tiếp tục.</div>}

        {(reopenable || canCheck || showHistory || canStop || loginNeeded) && (
          <div className="tu-status-actions">
            {loginNeeded && (
              <button type="button" className="btn btn-sm" onClick={onLogin} disabled={loggingIn}>
                {loggingIn ? <LoaderCircle size={13} className="tu-spin" /> : <LogIn size={13} />} Đăng nhập canvasapp
              </button>
            )}
            {reopenable && (
              <button type="button" className="btn btn-sm" onClick={() => void topupFlow.reopen()}>
                <ExternalLink size={13} /> Mở lại trang thanh toán
              </button>
            )}
            {canCheck && (
              <button type="button" className="btn btn-sm" onClick={() => void topupFlow.checkNow()}>
                <RefreshCw size={13} /> {flow.phase === 'waiting' ? 'Kiểm tra ngay' : 'Kiểm tra lại'}
              </button>
            )}
            {showHistory && (
              <button type="button" className="btn btn-sm" onClick={onHistory}>
                <ReceiptText size={13} /> Xem lịch sử credit
              </button>
            )}
            {canStop && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => topupFlow.stopTracking()}
                title="Ngừng theo dõi đơn này để tạo đơn khác (đơn chưa trả sẽ tự hết hạn)"
              >
                Ngừng theo dõi
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
