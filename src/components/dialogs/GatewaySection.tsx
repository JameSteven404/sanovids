// Settings section: "Cổng canvasapp.io.vn (thử nghiệm)", mounted by the Settings dialog (second column, above the
// demo provider settings). Lets the user pick the provider for new takes (Demo giả lập | canvasapp.io.vn), log in on
// canvasapp's own page (desktop app only), see the login state and the canvasapp credit balance.
import { Cable, Cloud, Coins, LoaderCircle, LogIn, LogOut, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { canvasappProvider, PROVIDER_LABEL, useProviderPrefs, type ProviderId } from '../../providers'
import { canvasappErrorText, createCanvasappApi } from '../../providers/canvasapp/api'
import { canvasappBridge, createDesktopTransport, WEB_UNAVAILABLE } from '../../providers/canvasapp/transport'
import { activeCount, useRuns } from '../../store/runs'
import { toast } from '../../store/ui'
import './dialogs.css'
import { Segmented } from './Segmented'

type Login = { state: 'unknown' | 'checking' } | { state: 'in'; credits: number | null } | { state: 'out' } | { state: 'error'; message: string }

const api = createCanvasappApi(createDesktopTransport())

export function GatewaySection() {
  const bridge = canvasappBridge()
  const desktop = !!bridge
  const provider = useProviderPrefs((s) => s.provider)
  const setProvider = useProviderPrefs((s) => s.setProvider)
  const running = useRuns(activeCount)
  const issue = useRuns((s) => (s.providerIssue?.provider === 'canvasapp' ? s.providerIssue.message : null))
  const [login, setLogin] = useState<Login>({ state: 'unknown' })
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null)

  const refresh = useCallback(async () => {
    const b = canvasappBridge()
    if (!b) return
    setLogin({ state: 'checking' })
    const st = await b.status()
    if (!st.ok) return setLogin({ state: 'error', message: st.message })
    if (!st.authenticated) return setLogin({ state: 'out' })
    try {
      const me = await api.me()
      setLogin({ state: 'in', credits: typeof me.credits_balance === 'number' ? me.credits_balance : null })
    } catch (e) {
      setLogin({ state: 'error', message: canvasappErrorText(e) })
    }
  }, [])

  useEffect(() => {
    if (desktop) void refresh()
  }, [desktop, refresh])

  const doLogin = async () => {
    if (!bridge || busy) return
    setBusy('login')
    try {
      const st = await bridge.login()
      if (st.ok && st.authenticated) toast('Đã đăng nhập canvasapp.io.vn.', { tone: 'success' })
      await refresh()
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
      setProvider('mock')
      toast('Đã đăng xuất canvasapp và chuyển về Demo giả lập.', { tone: 'success' })
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const choose = (p: ProviderId) => {
    if (p === provider) return
    if (p === 'canvasapp' && !desktop) return
    setProvider(p)
    toast(p === 'canvasapp' ? 'Take mới sẽ được tạo trên canvasapp.io.vn (tốn credit thật).' : 'Take mới dùng Demo giả lập (không tốn tiền).', {
      tone: p === 'canvasapp' ? 'warning' : 'success',
    })
  }

  const loggedIn = login.state === 'in'

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
            hint: p === 'mock' ? 'Không gọi mạng, không tốn tiền' : desktop ? 'Video thật, tốn credit canvasapp' : 'Chỉ có trong bản desktop',
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
            <span className={`dg-app-icon${loggedIn ? ' on' : ''}`}>
              {login.state === 'checking' || login.state === 'unknown' ? <LoaderCircle size={17} className="dg-spin" /> : <Cable size={17} />}
            </span>
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
                  <span className="dg-gw-credits">
                    <Coins size={11} /> {login.credits === null ? 'Không đọc được số credit' : `${login.credits.toLocaleString('vi-VN')} credit (≈ ${(login.credits * 1000).toLocaleString('vi-VN')}đ)`}
                  </span>
                ) : login.state === 'error' ? (
                  login.message
                ) : (
                  'Bấm “Đăng nhập canvasapp” để mở trang đăng nhập của canvasapp trong một cửa sổ riêng.'
                )}
              </small>
            </span>
          </div>
          <button className="icon-btn" onClick={() => void refresh()} disabled={!!busy || login.state === 'checking'} title="Kiểm tra lại" aria-label="Kiểm tra lại trạng thái đăng nhập">
            <RefreshCw size={14} />
          </button>
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
      )}

      {issue && (
        <div className="dg-callout warn">
          <TriangleAlert size={15} />
          <div>{issue}</div>
        </div>
      )}

      <div className="dg-field-hint">
        Giới hạn: tối đa 2 job cùng lúc, kiểm tra tiến độ mỗi 20 giây. Chưa hỗ trợ video tham chiếu (@video_N). Ảnh tham chiếu chỉ tải lên canvasapp một lần (phiên “SanoVids
        bridge”).
      </div>
    </section>
  )
}
