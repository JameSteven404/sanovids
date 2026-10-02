// Settings section: "Cổng canvasapp.io.vn (thử nghiệm)", mounted by the Settings dialog (second column, above the
// demo provider settings). Lets the user pick the provider for new takes (Demo giả lập | canvasapp.io.vn), log in on
// canvasapp's own page (desktop app only), see the login state and the REAL canvasapp credit balance.
// Login state and balance come from the shared real-credit store (store/credits useRealCredits: GET /api/me through
// the desktop bridge) — the same numbers as the top bar pill, no separate request here.
import { Cable, Cloud, History, LoaderCircle, LogIn, LogOut, Plus, RefreshCw, Sparkles, TriangleAlert, Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { canvasappProvider, PROVIDER_LABEL, useProviderPrefs, type ProviderId } from '../../providers'
import { canvasappBridge, WEB_UNAVAILABLE } from '../../providers/canvasapp/transport'
import { openTopUp } from '../../actions'
import { formatCredits, formatVnd, refreshRealCredits, resetRealCredits, useRealCredits } from '../../store/credits'
import { activeCount, useRuns } from '../../store/runs'
import { toast } from '../../store/ui'
import { clockText } from '../topbar/creditPillModel'
import { loginToCanvasapp } from '../topbar/CreditPill'
import './dialogs.css'
import { Segmented } from './Segmented'
import { gatewayLoginFromCredits, type GatewayCreditsView } from './shared'

export function GatewaySection() {
  const bridge = canvasappBridge()
  const desktop = !!bridge
  const provider = useProviderPrefs((s) => s.provider)
  const setProvider = useProviderPrefs((s) => s.setProvider)
  const running = useRuns(activeCount)
  const issue = useRuns((s) => (s.providerIssue?.provider === 'canvasapp' ? s.providerIssue.message : null))
  const real = useRealCredits(
    useShallow((s): GatewayCreditsView => ({ balance: s.balance, status: s.status, error: s.error, refreshing: s.refreshing, updatedAt: s.updatedAt })),
  )
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null)
  const login = gatewayLoginFromCredits(real)

  // Opening Settings reads the login state / balance (throttled: nothing is sent when read < 15 s ago).
  useEffect(() => {
    if (desktop) void refreshRealCredits()
  }, [desktop])

  const refresh = () => {
    void refreshRealCredits({ force: true })
  }

  const doLogin = async () => {
    if (!bridge || busy) return
    setBusy('login')
    try {
      await loginToCanvasapp()
    } finally {
      setBusy(null)
    }
  }

  const doLogout = async () => {
    if (!bridge || busy) return
    setBusy('logout')
    try {
      await bridge.logout()
      canvasappProvider().reset()
      // Forget the balance of the account that just logged out, then confirm the logged-out state (→ 401).
      resetRealCredits()
      setProvider('mock')
      toast('Đã đăng xuất canvasapp và chuyển về Demo giả lập.', { tone: 'success' })
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
        : 'Take mới dùng Demo giả lập — trả bằng credit demo (giả lập, không phải tiền thật).',
      { tone: p === 'canvasapp' ? 'warning' : 'success' },
    )
  }

  const loggedIn = login.state === 'in'
  const checking = login.state === 'checking' || real.refreshing

  return (
    <section className="dg-section dg-gateway">
      <header>
        <h3>
          Cổng canvasapp.io.vn <span className="badge warn">thử nghiệm</span>
        </h3>
        <p>
          Tạo video thật bằng tài khoản canvasapp.io.vn của chính bạn: SanoVids gửi prompt và ảnh tham chiếu (@image_N) sang canvasapp, chờ video xong rồi tải về thành take
          trên canvas. Bạn đăng nhập trên trang của canvasapp — SanoVids không thấy và không lưu mật khẩu.
        </p>
      </header>

      <div className="dg-callout warn">
        <TriangleAlert size={15} />
        <div>
          <b>Dùng credit thật của tài khoản canvasapp.</b> Đây là cổng không chính thức (API nội bộ của canvasapp, có thể thay đổi bất cứ lúc nào). Chỉ bật khi bạn đã được
          bên vận hành canvasapp.io.vn đồng ý. Huỷ take trong SanoVids không dừng job đã gửi sang canvasapp.
        </div>
      </div>

      <div className="dg-field">
        <span className="label">Nhà cung cấp video cho take mới</span>
        <Segmented
          label="Nhà cung cấp video cho take mới"
          size="lg"
          value={provider}
          onChange={choose}
          options={(['mock', 'canvasapp'] as ProviderId[]).map((p) => ({
            id: p,
            label: PROVIDER_LABEL[p],
            icon: p === 'mock' ? <Sparkles size={13} /> : <Cloud size={13} />,
            hint: p === 'mock' ? 'Credit demo (giả lập), không tốn tiền' : desktop ? 'Video thật, trừ credit canvasapp' : 'Chỉ có trong bản desktop',
            disabled: p === 'canvasapp' && !desktop,
            title: p === 'canvasapp' && !desktop ? WEB_UNAVAILABLE : undefined,
          }))}
        />
        {!desktop && <div className="dg-field-hint">{WEB_UNAVAILABLE}</div>}
        {running > 0 && <div className="dg-field-hint">Đổi nhà cung cấp chỉ áp dụng cho take mới; {running} take đang chạy giữ nguyên nơi đã gửi.</div>}
      </div>

      {desktop && (
        <div className="dg-app dg-gw-login">
          <div className="dg-app-status">
            <span className={`dg-app-icon${loggedIn ? ' on' : ''}`}>{login.state === 'checking' ? <LoaderCircle size={17} className="dg-spin" /> : <Cable size={17} />}</span>
            <span>
              <b>
                {login.state === 'in'
                  ? 'Đã đăng nhập canvasapp.io.vn'
                  : login.state === 'out'
                    ? 'Chưa đăng nhập canvasapp.io.vn'
                    : login.state === 'error'
                      ? 'Không kiểm tra được trạng thái'
                      : 'Đang kiểm tra…'}
              </b>
              <small>
                {login.state === 'in' ? (
                  <span
                    className={`dg-gw-credits${login.stale ? ' stale' : ''}`}
                    title={login.stale ? `Chưa cập nhật được: ${login.stale}` : 'Credit thật của tài khoản canvasapp (1 credit ≈ 1.000đ)'}
                  >
                    {login.stale ? <TriangleAlert size={11} /> : <Wallet size={11} />}
                    <span>Credit canvasapp:</span>
                    <b className="dg-gw-num">{formatCredits(login.credits, 'canvasapp')}</b>
                    <span>(≈ {formatVnd(login.credits)})</span>
                    {real.updatedAt ? <span className="faint">· lúc {clockText(real.updatedAt)}</span> : null}
                  </span>
                ) : login.state === 'error' ? (
                  login.message
                ) : login.state === 'out' ? (
                  'Bấm “Đăng nhập canvasapp” để mở trang đăng nhập của canvasapp trong một cửa sổ riêng.'
                ) : (
                  'Đang đọc tài khoản canvasapp…'
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
                <button className="btn btn-sm btn-primary" onClick={() => openTopUp('topup')} disabled={!!busy} title="Nạp credit vào tài khoản canvasapp (quét QR SePay)">
                  <Plus size={13} /> Nạp credit
                </button>
                <button className="icon-btn" onClick={() => openTopUp('history')} disabled={!!busy} title="Lịch sử credit canvasapp" aria-label="Lịch sử credit canvasapp">
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
                {busy === 'login' ? <LoaderCircle size={13} className="dg-spin" /> : <LogIn size={13} />} Đăng nhập canvasapp
              </button>
            )}
          </div>
        </div>
      )}

      {issue && (
        <div className="dg-callout warn">
          <TriangleAlert size={15} />
          <div>{issue}</div>
        </div>
      )}

      <div className="dg-field-hint">
        Giới hạn: tối đa 10 job cùng lúc (job thứ 11 trở đi chờ trong hàng đợi), kiểm tra tiến độ mỗi 20 giây. Chưa hỗ trợ video tham chiếu (@video_N). Ảnh tham chiếu chỉ tải lên canvasapp một lần (phiên “SanoVids
        bridge”).
      </div>
    </section>
  )
}
