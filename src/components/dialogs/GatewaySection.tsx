// Settings section "Nhà cung cấp video", mounted by the Settings dialog (second column). Lets the user pick the
// provider for new takes — "Phát triển (giả lập)" (development mode: the real canvasapp gateway code against the
// in-app simulated canvasapp, docs/SPEC-v2.md §11) or "canvasapp.io.vn" (desktop app only) — and shows the account of
// the ACTIVE gateway (providers/index activeGateway()): login state, balance, Nạp credit / Lịch sử credit, log in /
// out. In development mode the row is tagged DEV, everything is simulated (no network) and "Bảng phát triển" opens the
// dev console (faults, request log, simulated jobs).
// Login state and balance come from the shared gateway-credit store (store/credits useRealCredits: GET /api/me of the
// active gateway) — the same numbers as the top bar pill, no separate request here.
import { Bug, Cable, Cloud, FlaskConical, History, LoaderCircle, LogIn, LogOut, Plus, RefreshCw, TriangleAlert, Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { openDevPanel, openTopUp } from '../../actions'
import { activeGateway, activeProviderId, PROVIDER_LABEL, SELECTABLE_PROVIDERS, useProviderPrefs, type ProviderId } from '../../providers'
import { canvasappBridge, WEB_UNAVAILABLE, type CanvasappBridge } from '../../providers/canvasapp/transport'
import { DEV_CREDIT_HINT, formatCredits, formatVnd, refreshRealCredits, resetRealCredits, useRealCredits } from '../../store/credits'
import { activeCount, useRuns } from '../../store/runs'
import { toast } from '../../store/ui'
import { clockText } from '../topbar/creditPillModel'
import { loginToCanvasapp } from '../topbar/CreditPill'
import './dialogs.css'
import {
  KEEP_LOGIN_LABEL,
  KEEP_LOGIN_TOAST_OFF,
  KEEP_LOGIN_TOAST_ON,
  keepLoginChecked,
  keepLoginHint,
  logoutOutcome,
  parseKeepLoginState,
  type KeepLoginView,
} from './keepLoginModel'
import { Segmented } from './Segmented'
import { Toggle } from './settingsUi'
import { gatewayLoginFromCredits, type GatewayCreditsView } from './shared'

/** logout() of a bridge; a rejected IPC call becomes an ok:false answer (shown, never "Đã đăng xuất"). */
function bridgeLogout(bridge: CanvasappBridge): Promise<unknown> {
  return bridge.logout().catch((e: unknown) => ({ ok: false, code: 'error', message: e instanceof Error && e.message ? e.message : String(e) }))
}

/**
 * Logout did not finish cleanly: the message as an error toast. When only the kept login copy could not be deleted,
 * it stays (persistent) with "Thử lại" = Đăng xuất again (works logged out too: it deletes the copy, clears the partition).
 */
function showLogoutProblem(outcome: { message: string; notCleared: boolean }, bridge: CanvasappBridge) {
  const retry = async () => {
    const again = logoutOutcome(await bridgeLogout(bridge))
    if (again.ok) toast('Đã xoá bản sao đăng nhập canvasapp trên máy.', { tone: 'success' })
    else showLogoutProblem(again, bridge)
  }
  toast(outcome.message, { tone: 'error', ...(outcome.notCleared ? { action: { label: 'Thử lại', run: () => void retry() }, persistent: true } : {}) })
}

/**
 * "Giữ đăng nhập canvasapp trên máy này" — held by the main process (or the simulated bridge in development mode), read
 * when the section mounts. Hidden with a desktop build that does not have it.
 */
function KeepLoginRow({ bridge, dev }: { bridge: CanvasappBridge; dev: boolean }) {
  const [view, setView] = useState<KeepLoginView | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    const read = bridge.keepLogin
    if (!read) return
    void read
      .call(bridge)
      .then((raw) => {
        const st = parseKeepLoginState(raw)
        if (alive) setView(st.ok ? st : null)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [bridge])
  if (!view || !bridge.setKeepLogin) return null
  const change = async (on: boolean) => {
    if (saving || !bridge.setKeepLogin) return
    setSaving(true)
    try {
      const st = parseKeepLoginState(await bridge.setKeepLogin(on).catch((e: unknown) => ({ ok: false, code: 'error', message: e instanceof Error ? e.message : String(e) })))
      if (st.ok) {
        setView(st)
        toast(on ? KEEP_LOGIN_TOAST_ON : KEEP_LOGIN_TOAST_OFF, { tone: on ? 'success' : 'info' })
      } else {
        toast(st.message, { tone: st.code === 'keep-login-not-cleared' ? 'warning' : 'error' })
        // what main holds now (the choice may be stored although the copy could not be deleted)
        const now = bridge.keepLogin ? parseKeepLoginState(await bridge.keepLogin().catch(() => null)) : null
        if (now?.ok) setView(now)
      }
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="dg-gw-keep">
      <Toggle
        checked={keepLoginChecked(view)}
        disabled={!view.available || saving}
        onChange={(on) => void change(on)}
        label={
          <>
            {dev && <span className="dg-dev-tag">DEV</span>}
            {KEEP_LOGIN_LABEL}
          </>
        }
        hint={keepLoginHint(view)}
      />
    </div>
  )
}

export function GatewaySection() {
  const desktop = !!canvasappBridge()
  const provider = useProviderPrefs((s) => s.provider)
  const setProvider = useProviderPrefs((s) => s.setProvider)
  // The gateway new takes use (re-read on every render: it follows the Settings choice above).
  const gw = activeGateway()
  const dev = gw.simulated
  const gwBridge = gw.bridge()
  const hasBridge = !!gwBridge
  const running = useRuns(activeCount)
  const issue = useRuns((s) => (s.providerIssue && s.providerIssue.provider === activeProviderId() ? s.providerIssue.message : null))
  const real = useRealCredits(
    useShallow((s): GatewayCreditsView => ({ balance: s.balance, status: s.status, error: s.error, refreshing: s.refreshing, updatedAt: s.updatedAt })),
  )
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null)
  const login = gatewayLoginFromCredits(real)

  // Opening Settings (or switching provider) reads the login state / balance (throttled: nothing is sent when read
  // < 15 s ago).
  useEffect(() => {
    if (hasBridge) void refreshRealCredits()
  }, [hasBridge, gw.id])

  const refresh = () => {
    void refreshRealCredits({ force: true })
  }

  const doLogin = async () => {
    if (!hasBridge || busy) return
    setBusy('login')
    try {
      await loginToCanvasapp(gw)
    } finally {
      setBusy(null)
    }
  }

  const doLogout = async () => {
    // the account the balance shown belongs to: the simulated one in development mode, else the real canvasapp
    const bridge = gw.bridge()
    if (!bridge || busy) return
    setBusy('logout')
    try {
      // Main stops requests in flight, deletes the kept login copy, asks canvasapp to end the session, clears the
      // partition — and SAYS when the copy could not be deleted (never "Đã đăng xuất" then).
      const outcome = logoutOutcome(await bridgeLogout(bridge))
      gw.provider().reset()
      // Forget the balance of the account that just logged out, then confirm the logged-out state (→ 401).
      resetRealCredits()
      if (!gw.simulated) setProvider('dev')
      if (!outcome.ok) showLogoutProblem(outcome, bridge)
      else toast(gw.simulated ? 'Đã đăng xuất tài khoản giả lập (chế độ Phát triển).' : 'Đã đăng xuất canvasapp và chuyển về chế độ Phát triển (giả lập).', { tone: 'success' })
      await refreshRealCredits({ force: true })
    } finally {
      setBusy(null)
    }
  }

  const choose = (p: ProviderId) => {
    if (p === provider) return
    if (p === 'canvasapp' && !desktop) return
    setProvider(p)
    toast(
      p === 'canvasapp'
        ? 'Take mới sẽ được tạo trên canvasapp.io.vn — trừ credit canvasapp (tiền thật).'
        : 'Take mới dùng chế độ Phát triển — canvasapp giả lập trong máy, trả bằng credit dev (không phải tiền thật).',
      { tone: p === 'canvasapp' ? 'warning' : 'success' },
    )
  }

  const loggedIn = login.state === 'in'
  const checking = login.state === 'checking' || real.refreshing
  const site = dev ? 'canvasapp giả lập' : 'canvasapp.io.vn'

  return (
    <section className="dg-section dg-gateway">
      <header>
        <h3>
          Nhà cung cấp video
          {dev ? (
            <span className="badge dg-dev-badge" title={DEV_CREDIT_HINT}>
              DEV
            </span>
          ) : (
            <span className="badge warn">thử nghiệm</span>
          )}
        </h3>
        <p>
          <b>Phát triển (giả lập)</b> chạy đúng mã của cổng canvasapp thật (đăng nhập, tải ảnh, canvas, tạo job, theo dõi, tải video, nạp credit) nhưng tới một canvasapp giả lập
          ngay trong SanoVids — không gọi mạng, không tốn tiền — để tìm và sửa lỗi. <b>canvasapp.io.vn</b> tạo video thật bằng tài khoản canvasapp của chính bạn (bản desktop).
        </p>
      </header>

      <div className="dg-field">
        <span className="label">Nhà cung cấp video cho take mới</span>
        <Segmented
          label="Nhà cung cấp video cho take mới"
          size="lg"
          value={provider}
          onChange={choose}
          options={(SELECTABLE_PROVIDERS as readonly ProviderId[]).map((p) => ({
            id: p,
            label: PROVIDER_LABEL[p],
            icon: p === 'dev' ? <Bug size={13} /> : <Cloud size={13} />,
            hint: p === 'dev' ? 'canvasapp giả lập, credit dev — không tốn tiền' : desktop ? 'Video thật, trừ credit canvasapp' : 'Chỉ có trong bản desktop',
            disabled: p === 'canvasapp' && !desktop,
            title: p === 'canvasapp' && !desktop ? WEB_UNAVAILABLE : undefined,
          }))}
        />
        {!desktop && <div className="dg-field-hint">{WEB_UNAVAILABLE}</div>}
        {running > 0 && <div className="dg-field-hint">Đổi nhà cung cấp chỉ áp dụng cho take mới; {running} take đang chạy giữ nguyên nơi đã gửi.</div>}
      </div>

      {dev ? (
        <div className="dg-callout dg-dev-callout">
          <FlaskConical size={15} />
          <div>
            <b>Chế độ Phát triển — mọi thứ đều giả lập.</b> Credit dev không phải tiền thật, video là clip giả có nhãn @image_N để kiểm tra đúng nhân vật. Mở{' '}
            <b>Bảng phát triển</b> để gây lỗi có chủ đích (mất mạng, mất câu trả lời, hết credit, job lỗi…), xem nhật ký từng yêu cầu và điều khiển job.
          </div>
        </div>
      ) : (
        <div className="dg-callout warn">
          <TriangleAlert size={15} />
          <div>
            <b>Dùng credit thật của tài khoản canvasapp.</b> Đây là cổng không chính thức (API nội bộ của canvasapp, có thể thay đổi bất cứ lúc nào). Chỉ bật khi bạn đã được
            bên vận hành canvasapp.io.vn đồng ý. Huỷ take trong SanoVids không dừng job đã gửi sang canvasapp.
          </div>
        </div>
      )}

      {hasBridge && (
        <div className={`dg-app dg-gw-login${dev ? ' dev' : ''}`}>
          <div className="dg-app-status">
            <span className={`dg-app-icon${loggedIn ? ' on' : ''}`}>{login.state === 'checking' ? <LoaderCircle size={17} className="dg-spin" /> : dev ? <Bug size={17} /> : <Cable size={17} />}</span>
            <span>
              <b>
                {dev && <span className="dg-dev-tag">DEV</span>}
                {login.state === 'in'
                  ? `Đã đăng nhập ${site}`
                  : login.state === 'out'
                    ? `Chưa đăng nhập ${site}`
                    : login.state === 'error'
                      ? 'Không kiểm tra được trạng thái'
                      : 'Đang kiểm tra…'}
              </b>
              <small>
                {login.state === 'in' ? (
                  <span
                    className={`dg-gw-credits${login.stale ? ' stale' : ''}${dev ? ' dev' : ''}`}
                    title={login.stale ? `Chưa cập nhật được: ${login.stale}` : dev ? DEV_CREDIT_HINT : 'Credit thật của tài khoản canvasapp (1 credit ≈ 1.000đ)'}
                  >
                    {login.stale ? <TriangleAlert size={11} /> : dev ? <FlaskConical size={11} /> : <Wallet size={11} />}
                    <span>{dev ? 'Credit dev:' : 'Credit canvasapp:'}</span>
                    <b className="dg-gw-num">{formatCredits(login.credits, dev ? 'dev' : 'canvasapp')}</b>
                    <span>{dev ? '(giả lập)' : `(≈ ${formatVnd(login.credits)})`}</span>
                    {real.updatedAt ? <span className="faint">· lúc {clockText(real.updatedAt)}</span> : null}
                  </span>
                ) : login.state === 'error' ? (
                  login.message
                ) : login.state === 'out' ? (
                  dev ? (
                    'Bấm “Đăng nhập” để mở trang đăng nhập giả lập (không cần mật khẩu).'
                  ) : (
                    'Bấm “Đăng nhập canvasapp” để mở trang đăng nhập của canvasapp trong một cửa sổ riêng.'
                  )
                ) : (
                  `Đang đọc tài khoản ${site}…`
                )}
              </small>
            </span>
          </div>
          {/* Actions wrap under the status when the column is narrow (they never squeeze the text). */}
          <div className="dg-gw-actions">
            <button className="icon-btn" onClick={refresh} disabled={!!busy || checking} title="Kiểm tra lại (đọc lại số credit)" aria-label="Kiểm tra lại trạng thái đăng nhập và số credit">
              {real.refreshing ? <LoaderCircle size={14} className="dg-spin" /> : <RefreshCw size={14} />}
            </button>
            {loggedIn && (
              <>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => openTopUp('topup')}
                  disabled={!!busy}
                  title={dev ? 'Nạp credit dev qua trang SePay giả lập (không phải tiền thật)' : 'Nạp credit vào tài khoản canvasapp (quét QR SePay)'}
                >
                  <Plus size={13} /> Nạp credit
                </button>
                <button
                  className="icon-btn"
                  onClick={() => openTopUp('history')}
                  disabled={!!busy}
                  title={dev ? 'Lịch sử credit dev' : 'Lịch sử credit canvasapp'}
                  aria-label={dev ? 'Lịch sử credit dev' : 'Lịch sử credit canvasapp'}
                >
                  <History size={14} />
                </button>
              </>
            )}
            {loggedIn ? (
              <button className="btn btn-sm" onClick={() => void doLogout()} disabled={!!busy}>
                {busy === 'logout' ? <LoaderCircle size={13} className="dg-spin" /> : <LogOut size={13} />} Đăng xuất
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={() => void doLogin()} disabled={!!busy}>
                {busy === 'login' ? <LoaderCircle size={13} className="dg-spin" /> : <LogIn size={13} />} {dev ? 'Đăng nhập' : 'Đăng nhập canvasapp'}
              </button>
            )}
            {dev && (
              <button className="btn btn-sm" onClick={() => openDevPanel()} title="Gây lỗi, nhật ký yêu cầu, job và đơn nạp của máy chủ giả lập">
                <Bug size={13} /> Bảng phát triển
              </button>
            )}
          </div>
        </div>
      )}

      {gwBridge && typeof gwBridge.keepLogin === 'function' && <KeepLoginRow key={gw.id} bridge={gwBridge} dev={dev} />}

      {issue && (
        <div className="dg-callout warn">
          <TriangleAlert size={15} />
          <div>{issue}</div>
        </div>
      )}

      <div className="dg-field-hint">
        {dev
          ? 'Giống cổng thật: tối đa 10 job cùng lúc (job thứ 11 trở đi chờ trong hàng đợi), chưa hỗ trợ video tham chiếu (@video_N), ảnh tham chiếu chỉ tải lên một lần (phiên “SanoVids bridge”). Khác: kiểm tra tiến độ mỗi 3 giây và video xong sau ≈ 8 giây (đổi được trong Bảng phát triển).'
          : 'Giới hạn: tối đa 10 job cùng lúc (job thứ 11 trở đi chờ trong hàng đợi), kiểm tra tiến độ mỗi 20 giây. Chưa hỗ trợ video tham chiếu (@video_N). Ảnh tham chiếu chỉ tải lên canvasapp một lần (phiên “SanoVids bridge”).'}
      </div>
    </section>
  )
}
