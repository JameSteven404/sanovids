// "Bảng phát triển" — the console of development mode (docs/SPEC-v2.md §11). It drives the in-app simulated
// canvasapp.io.vn (providers/dev devServer()) that new takes run against while "Phát triển (giả lập)" is chosen:
//   Trạng thái     login state, balance (set / ±100 / back to 1.000), speed, top-up switch, server behaviour
//                  (dedupe, client_request_id in the job list, 402/400, latency, random failures), model profiles
//                  (can_create, modes, lists left out) with what SanoVids knows of them + "Đọc lại ngay",
//                  "Giữ đăng nhập (giả lập)" (login cookie kind, encryption, "Giả lập tắt app rồi mở lại"), wipe the
//                  simulated server.
//   Gây lỗi        one-click faults (one-shot, "giữ" = sticky), job-level faults, session end, a custom rule builder,
//                  and the faults armed right now.
//   Nhật ký        every request the app sent and what it got (fault badges, expandable JSON, filter, copy as JSON for
//                  a bug report); "Kiểm tra nhân vật" for each POST /api/video-jobs.
//   Job & đơn nạp  "Tạo job như trên trang canvasapp" (a job the site's own page makes on a bridge node — to test
//                  "Nhập job"), the server's jobs (finish / fail / expire now, which SanoVids take and bridge node — a
//                  scene of the open project, an old node, another one — they belong to; "Nhập" for one without a
//                  take), top-up orders (decide what canvasapp says), uploaded pictures.
//   Cập nhật       the simulated app updater and the simulated signature self-check of "Giới thiệu" (DevUpdatesTab.tsx;
//                  only outside Electron — the desktop app uses the real ones), and "Vị trí chạy" (where the app runs
//                  from: the Portable / temp-copy reminder of Settings, providers/dev/appPlacement; PlacementCard below).
//   Test giới hạn  the stress tester (src/devtools/stress, its own lazy chunk: runs on a temporary project).
// Opened from the top bar bug button, Settings and the queue drawer (actions.openDevPanel). Lazy chunk (App.tsx).
// Every texts/rule decision lives in devModel.ts (pure, tested).
import {
  Ban,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  ClipboardCopy,
  Clock,
  Cloud,
  CloudDownload,
  Eraser,
  Flame,
  FlaskConical,
  Gauge,
  Hourglass,
  ImageOff,
  KeyRound,
  ListChecks,
  LogIn,
  LogOut,
  MapPin,
  Minus,
  MousePointerClick,
  Plus,
  RefreshCw,
  Power,
  RotateCcw,
  ScrollText,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Wallet,
  X,
  Zap,
} from 'lucide-react'
import { lazy, Suspense, memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { takeCode } from '../../core/compile'
import { MODELS, modeLabel } from '../../core/models'
import { formatVnd } from '../../core/topup'
import type { Mode, ModelId } from '../../core/types'
import { formatCreditNumber, formatCredits } from '../../lib/credits'
import { updatesSource } from '../../lib/updates'
import { activeProviderId, PROVIDER_LABEL, providerLimitsInfo, providerOf, refreshProviderLimits, resetDevMode, useProviderPrefs } from '../../providers'
import { limitsSite } from '../../providers/limits'
import { canvasNodeId, decodeRemoteId, sceneNodeId } from '../../providers/canvasapp/mapping'
import { DEV_PLACEMENT_OPTIONS, devPlacement, useDevPlacement } from '../../providers/dev/appPlacement'
import {
  clearDevLog,
  DEV_ENDPOINT_LABEL,
  DEV_ENDPOINTS,
  DEV_INITIAL_BALANCE,
  DEV_SPEED_LABEL,
  DEV_TOPUP_OUTCOME_LABEL,
  devBridge,
  devServer,
  startDevSnapshotTicker,
  useDevLog,
  useDevServer,
  type DevConfig,
  type DevModelToggle,
  type DevEncryption,
  type DevJobView,
  type DevLoginCookie,
  type DevLogEntry,
  type DevServerSnapshot,
  type DevSpeed,
  type DevTopupOutcome,
  type DevTopupView,
} from '../../providers/dev'
import { openImportJobs } from '../../siteJobActions'
import { refreshRealCredits, resetRealCredits } from '../../store/credits'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { toast, useUI, type DevPanelTab } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { Modal } from '../common/Modal'
import { Segmented } from '../dialogs/Segmented'
import { refreshToast } from '../inspector/settingsLimits'
import { HighlightedPrompt, useLimitsOf } from '../runs/shared'
import {
  activeFaultCount,
  characterCheck,
  CUSTOM_FAULT_DEFAULT,
  customFaultInput,
  DEV_ENCRYPTION_OPTIONS,
  DEV_FAULT_KIND_LABEL,
  DEV_LOGIN_COOKIE_OPTIONS,
  DEV_UI_FAULTS,
  devPanelTabs,
  devRestartText,
  devRestartTone,
  endpointText,
  faultArmedText,
  faultKindsFor,
  faultRuleText,
  filterLog,
  isDevEndpoint,
  jobNodeOwners,
  jobNodeText,
  SITE_JOB_HINT,
  siteJobToast,
  siteNodeLabel,
  limitsDifferFromConfig,
  limitsStatusText,
  logExport,
  logTime,
  statusText,
  statusTone,
  uiFaultRule,
  type CustomFaultForm,
  type DevFaultKind,
  type DevUiFault,
} from './devModel'
import './dev.css'
import { DevUpdatesTab } from './DevUpdatesTab'

let DevPerfTab: React.ComponentType | null = null
if (__SANOVIDS_PERF__) DevPerfTab = lazy(() => import('./DevPerfTab').then((m) => ({ default: m.DevPerfTab })))
// "Test giới hạn": the whole stress tester is its own chunk, loaded when the tab opens.
const StressTab = lazy(() => import('../../devtools/stress').then((m) => ({ default: m.StressTab })))

/** After a change of the simulated account: the pill / dialogs read the balance again (only while dev is active). */
function syncBalance() {
  if (activeProviderId() === 'dev') void refreshRealCredits({ force: true })
}

export function DevPanel({ tab: requested }: { tab?: DevPanelTab }) {
  const close = () => useUI.getState().closeDialog()
  const tabs = useMemo(() => devPanelTabs({ simulatedUpdates: updatesSource() === 'sim', perf: __SANOVIDS_PERF__ }), [])
  // A requested tab that is not offered here (Cập nhật inside Electron) falls back to the first one.
  const pick = (t: DevPanelTab | undefined): DevPanelTab => (t && tabs.some((x) => x.id === t) ? t : 'status')
  const [tab, setTab] = useState<DevPanelTab>(() => pick(requested))
  useEffect(() => {
    if (requested) setTab(pick(requested))
  }, [requested])
  // Creates the dev server if needed and keeps the snapshot moving with the clock while jobs run.
  useEffect(() => startDevSnapshotTicker(), [])
  const snap = useDevServer((s) => s.snapshot)
  const logCount = useDevLog((s) => s.entries.length)
  const chosen = useProviderPrefs((s) => s.provider)
  const active = chosen === 'dev' || activeProviderId() === 'dev'

  const counts: Partial<Record<DevPanelTab, number>> = {
    faults: activeFaultCount(snap),
    log: logCount,
    jobs: snap?.jobs.filter((j) => j.status === 'queued' || j.status === 'processing').length ?? 0,
  }

  return (
    <Modal
      title={
        <span className="dv-title">
          <Bug size={17} /> Bảng phát triển
        </span>
      }
      headerExtra={
        <span className="dv-tag" title="Chế độ Phát triển: canvasapp giả lập ngay trong app — không gọi mạng, credit dev không phải tiền thật">
          DEV · không gọi mạng
        </span>
      }
      size="xwide"
      onClose={close}
      footer={
        <>
          <span className="dv-foot-note">
            Máy chủ giả lập chạy ngay trong SanoVids, dữ liệu lưu trên máy này. Mọi đường đi của chế độ thật (đăng nhập, tải ảnh, canvas, job, tải video, nạp credit) đều đi qua nó.
          </span>
          <button type="button" className="btn btn-primary" onClick={close}>
            Xong
          </button>
        </>
      }
    >
      <div className="dv-panel">
        {!active && <InactiveNote />}
        <div
          className="dv-tabs"
          role="tablist"
          aria-label="Bảng phát triển"
          onKeyDown={(e) => {
            // ←/→ move between the tabs (tablist keyboard pattern)
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            const i = tabs.findIndex((t) => t.id === tab)
            const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
            setTab(next.id)
            e.currentTarget.querySelector<HTMLButtonElement>(`#dv-tab-${next.id}`)?.focus()
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`dv-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`dv-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {TAB_ICON[t.id]}
              {t.label}
              {counts[t.id] ? <span className={`dv-count${t.id === 'faults' ? ' warn' : ''}`}>{counts[t.id]}</span> : null}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`dv-panel-${tab}`} aria-labelledby={`dv-tab-${tab}`} className="dv-tabpanel">
          {tab === 'perf' && DevPerfTab ? <Suspense fallback={<p>Đang tải bộ đo…</p>}><DevPerfTab /></Suspense> : tab === 'stress' ? (
            <Suspense fallback={<p>Đang tải bộ Test giới hạn…</p>}>
              <StressTab />
            </Suspense>
          ) : tab === 'updates' ? (
            <div className="dv-upd">
              <DevUpdatesTab />
              <div className="dv-grid">
                <PlacementCard />
              </div>
            </div>
          ) : !snap ? (
            <NoSnapshot />
          ) : tab === 'status' ? (
            <StatusTab snap={snap} />
          ) : tab === 'faults' ? (
            <FaultsTab snap={snap} onShowLog={() => setTab('log')} />
          ) : tab === 'log' ? (
            <LogTab snap={snap} />
          ) : (
            <JobsTab snap={snap} />
          )}
        </div>
      </div>
    </Modal>
  )
}

const TAB_ICON: Record<DevPanelTab, ReactNode> = {
  status: <FlaskConical size={14} />,
  faults: <Zap size={14} />,
  log: <ScrollText size={14} />,
  jobs: <ListChecks size={14} />,
  updates: <CloudDownload size={14} />,
  stress: <Flame size={14} />,
  // Not listed by devPanelTabs yet (the perf build's tab, src/perf): pick() falls back to 'status' for it.
  perf: <Gauge size={14} />,
}

/** "Cập nhật → Vị trí chạy": the simulated answer of window.bdpDesktop.app.placement() (only outside Electron). */
function PlacementCard() {
  const kind = useDevPlacement((s) => s.kind)
  return (
    <Card title="Vị trí chạy" icon={<MapPin size={15} />} className="dv-grid-wide">
      <div className="dv-field">
        <span className="label">SanoVids đang chạy từ</span>
        <Segmented label="Vị trí chạy" value={kind} onChange={(k) => devPlacement.simulate(k)} options={DEV_PLACEMENT_OPTIONS} />
      </div>
      <p className="dv-hint">
        Bản Portable và bản sao trong thư mục tạm hiện lời nhắc cài bản Setup ở Cài đặt → Ứng dụng và Giới thiệu. Bản desktop hỏi tiến trình chính (chỉ nhận loại bản, không có đường dẫn); ở đây chỉ giả lập.
      </p>
    </Card>
  )
}

/** The real gateway runs new takes: this panel only drives the simulation. */
function InactiveNote() {
  const setProvider = useProviderPrefs((s) => s.setProvider)
  return (
    <div className="dv-callout warn">
      <Cloud size={15} />
      <div>
        Take mới đang chạy trên <b>{PROVIDER_LABEL.canvasapp}</b> (credit thật). Bảng này chỉ điều khiển máy chủ giả lập của chế độ Phát triển.
      </div>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          setProvider('dev')
          toast('Take mới dùng chế độ Phát triển — canvasapp giả lập, credit dev (không phải tiền thật).', { tone: 'success' })
        }}
      >
        Chuyển sang Phát triển
      </button>
    </div>
  )
}

// =============================================================================================
// Trạng thái
// =============================================================================================

function Card({ title, icon, children, extra, className }: { title: string; icon: ReactNode; children: ReactNode; extra?: ReactNode; className?: string }) {
  return (
    <section className={`dv-card${className ? ` ${className}` : ''}`}>
      <header>
        <span className="dv-card-icon" aria-hidden="true">
          {icon}
        </span>
        <h3>{title}</h3>
        {extra}
      </header>
      {children}
    </section>
  )
}

function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="dg-toggle-row dv-switch-row">
      <span className="dg-toggle-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <span className={`dg-switch ${checked ? 'on' : ''}`}>
        <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <i />
      </span>
    </label>
  )
}

const setConfig = (patch: Partial<DevConfig>) => devServer().setConfig(patch)

function StatusTab({ snap }: { snap: DevServerSnapshot }) {
  const c = snap.config
  return (
    <div className="dv-grid">
      {snap.persistProblem && (
        <div className="dv-callout warn dv-grid-wide" role="alert">
          <ShieldAlert size={15} />
          <div>{snap.persistProblem}</div>
        </div>
      )}
      <AccountCard snap={snap} />
      <KeepLoginCard config={c} />
      <BalanceCard snap={snap} />
      <Card title="Tốc độ tạo video" icon={<Clock size={15} />}>
        <Segmented<DevSpeed>
          label="Tốc độ tạo video"
          value={c.speed}
          onChange={(speed) => setConfig({ speed })}
          options={(['fast', 'realistic'] as DevSpeed[]).map((id) => ({ id, label: DEV_SPEED_LABEL[id] }))}
        />
        <p className="dv-hint">Áp dụng cho job tạo sau khi đổi. “Thực tế” giống thời gian chờ của canvasapp thật (job chờ hàng đợi rồi chạy 60–90 giây).</p>
      </Card>
      <Card title="Hành vi máy chủ" icon={<ShieldAlert size={15} />}>
        <Switch
          checked={c.topupEnabled}
          onChange={(topupEnabled) => setConfig({ topupEnabled })}
          label="Cho phép nạp credit (topup_enabled)"
          hint="Tắt để thử trường hợp canvasapp tạm đóng nạp credit."
        />
        <Switch
          checked={c.dedupe}
          onChange={(dedupe) => setConfig({ dedupe })}
          label="Chống trùng job theo client_request_id"
          hint="Tắt: mỗi lần gửi lại là một job mới và bị trừ tiền lần nữa (máy chủ “ẩu”)."
        />
        <Switch
          checked={c.exposeKey}
          onChange={(exposeKey) => setConfig({ exposeKey })}
          label="Danh sách job có client_request_id"
          hint="Trang thật chưa rõ có trả trường này không — tắt là mặc định an toàn."
        />
        <Switch
          checked={c.rangeSupport}
          onChange={(rangeSupport) => setConfig({ rangeSupport })}
          label="Cho tải tiếp video (HTTP Range)"
          hint="Trang thật chưa rõ /stream có hỗ trợ — tắt là mặc định: tải hỏng giữa chừng thì tải lại từ đầu (lần thử sau). Bật: tải tiếp từ chỗ dừng (206, ETag)."
        />
        <div className="dv-field">
          <span className="label">Mã lỗi khi không đủ credit</span>
          <Segmented<400 | 402>
            label="Mã lỗi khi không đủ credit"
            value={c.insufficientStatus}
            onChange={(insufficientStatus) => setConfig({ insufficientStatus })}
            options={[
              { id: 402, label: '402' },
              { id: 400, label: '400' },
            ]}
          />
        </div>
        <RangeField
          label="Độ trễ mỗi yêu cầu"
          value={c.latencyMs}
          min={0}
          max={3000}
          step={50}
          format={(v) => `${v} ms`}
          onChange={(latencyMs) => setConfig({ latencyMs })}
        />
        <RangeField
          label="Tỉ lệ job tự lỗi"
          value={Math.round(c.failRate * 100)}
          min={0}
          max={50}
          step={5}
          format={(v) => `${v}%`}
          onChange={(v) => setConfig({ failRate: v / 100 })}
        />
      </Card>
      <ModelsCard config={c} />
      <DataCard snap={snap} />
    </div>
  )
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <label className="dv-field">
      <span className="dv-label-row">
        <span className="label">{label}</span>
        <span className="mono dv-value">{format(value)}</span>
      </span>
      <input className="dg-range" type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function AccountCard({ snap }: { snap: DevServerSnapshot }) {
  const act = (fn: () => void, text: string) => {
    fn()
    syncBalance()
    toast(text, { tone: 'success' })
  }
  return (
    <Card
      title="Tài khoản giả lập"
      icon={snap.authenticated ? <LogIn size={15} /> : <LogOut size={15} />}
      extra={<span className={`dv-pill ${snap.authenticated ? 'ok' : 'warn'}`}>{snap.authenticated ? 'Đã đăng nhập' : 'Chưa đăng nhập'}</span>}
    >
      <p className="dv-hint">
        Đăng nhập / đăng xuất ở đây là phía máy chủ (như khi phiên canvasapp hết hạn). Người dùng thường đăng nhập bằng ô credit hoặc Cài đặt — trang đăng nhập giả lập
        sẽ hiện ra.
      </p>
      <div className="dv-actions">
        {snap.authenticated ? (
          <>
            <button type="button" className="btn btn-sm" onClick={() => act(() => devServer().logout(), 'Máy chủ giả lập đã đăng xuất tài khoản.')}>
              <LogOut size={13} /> Đăng xuất
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => act(() => devServer().expireSession(), 'Phiên giả lập đã hết — yêu cầu tiếp theo sẽ nhận 401.')}
              title="Mọi yêu cầu trả 401 cho tới khi đăng nhập lại"
            >
              <Hourglass size={13} /> Hết phiên (401)
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              act(() => devServer().login(), 'Máy chủ giả lập đã đăng nhập tài khoản.')
              // what the account may run, read at once — even seconds after the inspector's own 401
              void refreshProviderLimits('dev', { changed: true })
            }}
          >
            <LogIn size={13} /> Đăng nhập ngay
          </button>
        )}
      </div>
    </Card>
  )
}

/**
 * "Giữ đăng nhập (giả lập)": how the simulated site sets its login cookie, whether this (simulated) computer can encrypt
 * the kept copy, and a restart of the desktop app (the switch itself is in Cài đặt → Cổng canvasapp.io.vn).
 */
function KeepLoginCard({ config }: { config: DevConfig }) {
  const [busy, setBusy] = useState(false)
  const restart = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await devBridge().simulateRestart()
      // a new run reads the balance / login state again from scratch
      resetRealCredits()
      if (activeProviderId() === 'dev') void refreshRealCredits({ force: true })
      toast(devRestartText(r.outcome), { tone: devRestartTone(r.outcome) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Giữ đăng nhập (giả lập)" icon={<KeyRound size={15} />}>
      <div className="dv-field">
        <span className="label">Cookie đăng nhập (giả lập)</span>
        <Segmented<DevLoginCookie>
          label="Cookie đăng nhập (giả lập)"
          value={config.loginCookie}
          onChange={(loginCookie) => setConfig({ loginCookie })}
          options={DEV_LOGIN_COOKIE_OPTIONS}
        />
      </div>
      <div className="dv-field">
        <span className="label">Mã hoá trên máy</span>
        <Segmented<DevEncryption> label="Mã hoá trên máy" value={config.encryption} onChange={(encryption) => setConfig({ encryption })} options={DEV_ENCRYPTION_OPTIONS} />
      </div>
      <div className="dv-actions">
        <button type="button" className="btn btn-sm" onClick={() => void restart()} disabled={busy} title="Như tắt SanoVids rồi mở lại: phiên theo cookie phiên chỉ còn nếu đang giữ đăng nhập">
          <Power size={13} /> Giả lập tắt app rồi mở lại
        </button>
      </div>
      <p className="dv-hint">Công tắc “Giữ đăng nhập canvasapp trên máy này” ở Cài đặt → Cổng canvasapp.io.vn (mặc định theo “Vị trí chạy”: bản cài / mã nguồn bật, Portable / thư mục tạm tắt).</p>
    </Card>
  )
}

function BalanceCard({ snap }: { snap: DevServerSnapshot }) {
  const [text, setText] = useState('')
  const set = (n: number) => {
    const v = Math.max(0, Math.round(n * 100) / 100)
    devServer().setBalance(v)
    syncBalance()
  }
  const typed = text.trim() === '' ? null : Number(text.replace(',', '.'))
  const valid = typed !== null && Number.isFinite(typed) && typed >= 0 && typed <= 10_000_000
  return (
    <Card title="Số dư credit dev" icon={<Wallet size={15} />}>
      <div className="dv-balance">
        <b className="mono">{formatCreditNumber(snap.balance)}</b>
        <span>credit dev · giả lập</span>
      </div>
      <div className="dv-actions">
        <button type="button" className="btn btn-sm" onClick={() => set(snap.balance + 100)}>
          <Plus size={13} /> 100
        </button>
        <button type="button" className="btn btn-sm" onClick={() => set(snap.balance - 100)} disabled={snap.balance <= 0}>
          <Minus size={13} /> 100
        </button>
        <button type="button" className="btn btn-sm" onClick={() => set(0)} disabled={snap.balance === 0} title="Thử trường hợp hết credit">
          Về 0
        </button>
        <button type="button" className="btn btn-sm" onClick={() => set(DEV_INITIAL_BALANCE)} disabled={snap.balance === DEV_INITIAL_BALANCE}>
          <RotateCcw size={13} /> Về {formatCreditNumber(DEV_INITIAL_BALANCE)}
        </button>
      </div>
      <form
        className="dv-inline-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid || typed === null) return
          set(typed)
          setText('')
          toast(`Đã đặt số dư giả lập: ${formatCredits(typed, 'dev')}.`, { tone: 'success' })
        }}
      >
        <input className="input" inputMode="decimal" placeholder="Số dư mới, ví dụ 25" value={text} onChange={(e) => setText(e.target.value)} aria-label="Số dư credit dev mới" />
        <button type="submit" className="btn btn-sm" disabled={!valid}>
          Đặt
        </button>
      </form>
      <p className="dv-hint">Mỗi thay đổi ghi một dòng “Điều chỉnh” vào Lịch sử credit (giống canvasapp). {snap.historyCount} dòng lịch sử.</p>
    </Card>
  )
}

type ModelList = 'off_durations' | 'off_resolutions' | 'off_ratios'

function ModelsCard({ config }: { config: DevConfig }) {
  const ids = Object.keys(MODELS) as ModelId[]
  // What SanoVids knows of these toggles (the dev provider's /api/video-profiles cache) — shown, never re-read here:
  // like the real site, SanoVids re-reads only after 10 minutes (or "Đọc lại ngay").
  const { limits, info } = useLimitsOf('dev')
  const [reading, setReading] = useState(false)
  const setModel = (id: ModelId, patch: Partial<DevModelToggle>) => setConfig({ models: { ...config.models, [id]: { ...config.models[id], ...patch } } })
  const toggleMode = (id: ModelId, mode: Mode) => {
    const cur = config.models[id]
    const off = cur.disabled_modes.includes(mode)
    setModel(id, { disabled_modes: off ? cur.disabled_modes.filter((m) => m !== mode) : [...cur.disabled_modes, mode] })
  }
  const toggleValue = <T extends string | number>(id: ModelId, list: ModelList, value: T) => {
    const cur = (config.models[id][list] ?? []) as T[]
    setModel(id, { [list]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value] })
  }
  const reread = async () => {
    if (reading) return
    setReading(true)
    try {
      // every click here follows a change made in this panel: never the few-seconds limit of the inspector's "Đọc lại"
      const result = await refreshProviderLimits('dev', { changed: true })
      const t = refreshToast(result, limitsSite('dev'), providerLimitsInfo('dev'))
      toast(t.text, { tone: t.tone })
    } finally {
      setReading(false)
    }
  }
  const differs = limitsDifferFromConfig(limits, config.models)
  return (
    <Card title="Model (video-profiles)" icon={<Cloud size={15} />}>
      {ids.map((id) => {
        const spec = MODELS[id]
        const t = config.models[id]
        // canvasapp (and SanoVids) replaces MiniMax-H3's lists that are narrower than its built-in ones
        const ignored = id === 'minimax_h3'
        const chips = <T extends string | number>(label: string, list: ModelList, values: readonly T[], format: (v: T) => string) => (
          <div className="dv-chips" role="group" aria-label={`${label} của ${spec.name}`}>
            <span className="dv-chips-label">{label}</span>
            {values.map((v) => {
              const off = ((t[list] ?? []) as T[]).includes(v)
              return (
                <button
                  key={String(v)}
                  type="button"
                  className={`dv-chip${off ? ' off' : ''}`}
                  aria-pressed={!off}
                  onClick={() => toggleValue(id, list, v)}
                  title={
                    off
                      ? `Đang bỏ khỏi danh sách của /api/video-profiles${ignored ? ' (trang canvasapp bỏ qua danh sách hẹp hơn mặc định của MiniMax-H3: không có tác dụng)' : ''} — bấm để thêm lại`
                      : 'Có trong danh sách — bấm để bỏ ra'
                  }
                >
                  {off ? <Ban size={11} /> : <Check size={11} />}
                  {format(v)}
                </button>
              )
            })}
          </div>
        )
        return (
          <div key={id} className="dv-model">
            <Switch
              checked={t.can_create}
              onChange={(can_create) => setModel(id, { can_create })}
              label={
                <span className="dv-model-name">
                  <i style={{ background: spec.color }} />
                  {spec.name} được tạo video (can_create)
                </span>
              }
            />
            {spec.modes.length > 1 && (
              <div className="dv-chips" role="group" aria-label={`Chế độ của ${spec.name}`}>
                {spec.modes.map((m) => {
                  const off = t.disabled_modes.includes(m)
                  return (
                    <button
                      key={m}
                      type="button"
                      className={`dv-chip${off ? ' off' : ''}`}
                      aria-pressed={!off}
                      onClick={() => toggleMode(id, m)}
                      title={off ? 'Đang tắt (disabled_modes) — bấm để bật' : 'Đang bật — bấm để tắt chế độ này'}
                    >
                      {off ? <Ban size={11} /> : <Check size={11} />}
                      {modeLabel(m, id)}
                    </button>
                  )
                })}
              </div>
            )}
            {chips('Thời lượng', 'off_durations', spec.durations, (d) => `${d}s`)}
            {chips('Độ phân giải', 'off_resolutions', spec.resolutions, (r) => r.toUpperCase())}
            {chips('Tỉ lệ', 'off_ratios', spec.ratios, (r) => r)}
            {ignored && <p className="dv-hint">Bỏ bớt thời lượng / độ phân giải / tỉ lệ của MiniMax-H3 không có tác dụng: trang canvasapp (và SanoVids) dùng danh sách mặc định của nó.</p>}
          </div>
        )
      })}
      <div className={`dv-limits${differs ? ' differs' : ''}`} role="status">
        <span>{limitsStatusText(info, limits)}</span>
        {differs && <b>Khác với các lựa chọn ở trên — bấm “Đọc lại ngay” để inspector thấy thay đổi.</b>}
        <button type="button" className="btn btn-sm" onClick={() => void reread()} disabled={reading} title="Đọc lại /api/video-profiles của máy chủ giả lập ngay (như sau khi đăng nhập)">
          <RefreshCw size={13} /> Đọc lại ngay
        </button>
      </div>
      <p className="dv-hint">
        Như canvasapp thật, SanoVids chỉ tự đọc lại sau 10 phút (1 phút nếu lần trước lỗi), khi mở cấu hình video của một cảnh hoặc hộp Chạy — bảng này không tự đọc
        lại khi bạn bật/tắt. Lần đọc đó cũng là một yêu cầu: lỗi giả “Mọi yêu cầu” có thể rơi vào nó (lỗi khi đọc → cấu hình dự phòng, MiniMax-H3 khoá).
      </p>
    </Card>
  )
}

/** "Xoá dữ liệu máy chủ giả lập" (asks first; warns about running dev takes). Resolves when done or declined. */
async function wipeDevServer(): Promise<void> {
  const running = useRuns.getState().takes.filter((t) => providerOf(t) === 'dev' && (t.status === 'queued' || t.status === 'processing')).length
  const warn = running ? `\n\n${running} take đang chạy ở chế độ Phát triển sẽ báo lỗi “không tìm thấy job”.` : ''
  if (!window.confirm(`Xoá toàn bộ dữ liệu của máy chủ giả lập (phiên, job, ảnh đã tải lên, lịch sử credit, đơn nạp) và đặt lại số dư ${formatCreditNumber(DEV_INITIAL_BALANCE)}? Cài đặt của bảng này được giữ.${warn}`)) return
  try {
    await resetDevMode()
    await refreshRealCredits({ force: true })
    toast('Đã xoá dữ liệu máy chủ giả lập — tài khoản giả lập mới, chưa đăng nhập.', { tone: 'success' })
  } catch (e) {
    toast(`Không xoá được: ${(e as Error)?.message ?? String(e)}`, { tone: 'error' })
  }
}

function useWipe(): [busy: boolean, wipe: () => void] {
  const [busy, setBusy] = useState(false)
  const wipe = () => {
    if (busy) return
    setBusy(true)
    void wipeDevServer().finally(() => setBusy(false))
  }
  return [busy, wipe]
}

/** No snapshot yet — normally for a moment; if the saved account cannot be read, the way out is a reset. */
function NoSnapshot() {
  const [busy, wipe] = useWipe()
  return (
    <div className="empty dv-nosnap">
      <p>Đang mở máy chủ giả lập…</p>
      <p className="dv-hint">Nếu bảng đứng mãi ở đây, dữ liệu đã lưu của máy chủ giả lập có thể bị hỏng — xoá nó để bắt đầu lại (dự án và take của bạn không bị đụng tới).</p>
      <button type="button" className="btn btn-sm btn-danger" onClick={wipe} disabled={busy}>
        <Trash2 size={13} /> Xoá dữ liệu máy chủ giả lập
      </button>
    </div>
  )
}

function DataCard({ snap }: { snap: DevServerSnapshot }) {
  const [busy, wipe] = useWipe()
  return (
    <Card title="Dữ liệu máy chủ giả lập" icon={<Trash2 size={15} />}>
      <dl className="dv-stats">
        <div>
          <dt>Phiên</dt>
          <dd>{snap.projects.length}</dd>
        </div>
        <div>
          <dt>Job</dt>
          <dd>{snap.jobs.length}</dd>
        </div>
        <div>
          <dt>Ảnh</dt>
          <dd>{snap.uploads.length}</dd>
        </div>
        <div>
          <dt>Đơn nạp</dt>
          <dd>{snap.topups.length}</dd>
        </div>
      </dl>
      <div className="dv-actions">
        <button type="button" className="btn btn-sm btn-danger" onClick={wipe} disabled={busy}>
          <Trash2 size={13} /> Xoá dữ liệu máy chủ giả lập
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            clearDevLog()
            toast('Đã xoá nhật ký yêu cầu.')
          }}
        >
          <Eraser size={13} /> Xoá nhật ký
        </button>
      </div>
      <p className="dv-hint">Xoá dữ liệu không đụng tới dự án, cảnh và take của bạn trong SanoVids.</p>
    </Card>
  )
}

// =============================================================================================
// Gây lỗi
// =============================================================================================

function FaultsTab({ snap, onShowLog }: { snap: DevServerSnapshot; onShowLog: () => void }) {
  return (
    <div className="dv-faults">
      <div className="dv-callout">
        <Zap size={15} />
        <div>
          Bật một lỗi rồi chạy cảnh (hoặc nạp credit) như bình thường để xem SanoVids xử lý thế nào. Mặc định mỗi lỗi chỉ xảy ra <b>1 lần</b> (trừ vài lỗi ghi rõ số lần trong “Đang bật”); bật “giữ” để lỗi lặp lại tới khi tắt. Nhiều lỗi cùng bật thì “Chậm” cộng thêm vào lỗi khác, và lỗi riêng cho một loại yêu cầu được ưu tiên hơn lỗi “Mọi yêu cầu”.
          Kết quả từng yêu cầu ở tab{' '}
          <button type="button" className="dv-link" onClick={onShowLog}>
            Nhật ký
          </button>
          .
        </div>
      </div>
      <ArmedFaults snap={snap} />
      <div className="dv-fault-list">
        {DEV_UI_FAULTS.map((f) => (
          <FaultRow key={f.id} item={f} />
        ))}
      </div>
      <CustomRule />
    </div>
  )
}

function ArmedFaults({ snap }: { snap: DevServerSnapshot }) {
  const j = snap.jobFaults
  const server = devServer()
  const rows: { key: string; text: ReactNode; remove: () => void }[] = [
    ...snap.faults.map((r) => ({
      key: r.id,
      text: (
        <>
          {r.label && <b>{r.label} · </b>}
          {faultRuleText(r)}
        </>
      ),
      remove: () => server.removeFault(r.id),
    })),
    ...(j.failNext !== null ? [{ key: 'failNext', text: <>Job tiếp theo sẽ lỗi: “{j.failNext}”</>, remove: () => server.setJobFaults({ failNext: null }) }] : []),
    ...(j.expireNext ? [{ key: 'expireNext', text: <>Job tiếp theo sẽ hết hạn</>, remove: () => server.setJobFaults({ expireNext: false }) }] : []),
    ...(j.streamFailures > 0
      ? [{ key: 'stream', text: <>{j.streamFailures} lần tải video kế tiếp sẽ lỗi (503)</>, remove: () => server.setJobFaults({ streamFailures: 0 }) }]
      : []),
    ...(j.logoutCopyStuck
      ? [{ key: 'logoutCopyStuck', text: <>Lần Đăng xuất kế tiếp không xoá được bản sao đăng nhập</>, remove: () => server.setJobFaults({ logoutCopyStuck: false }) }]
      : []),
    ...(snap.sessionExpired
      ? [
          {
            key: 'session',
            text: <>Hết phiên (401) — mọi yêu cầu trả 401 tới khi đăng nhập lại (tắt = đăng nhập lại phía máy chủ)</>,
            remove: () => {
              server.login()
              syncBalance()
            },
          },
        ]
      : []),
  ]
  const clearAll = () => {
    server.clearFaults()
    if (snap.sessionExpired) {
      server.login()
      syncBalance()
    }
  }
  return (
    <section className="dv-armed" aria-live="polite">
      <header>
        <h3>Đang bật {rows.length ? `(${rows.length})` : ''}</h3>
        {!snap.authenticated && !snap.sessionExpired && <span className="dv-pill warn">Tài khoản giả lập chưa đăng nhập</span>}
        <span className="dv-spacer" />
        <button type="button" className="btn btn-sm" disabled={!rows.length} onClick={clearAll}>
          <X size={13} /> Tắt tất cả
        </button>
      </header>
      {rows.length ? (
        <ul>
          {rows.map((r) => (
            <li key={r.key}>
              <Zap size={13} className="dv-armed-icon" />
              <span className="dv-armed-text">{r.text}</span>
              <button type="button" className="icon-btn dv-icon-sm" onClick={r.remove} title="Tắt lỗi này" aria-label="Tắt lỗi này">
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dv-hint">Chưa bật lỗi nào — mọi yêu cầu được trả lời như canvasapp bình thường.</p>
      )}
    </section>
  )
}

const FaultRow = memo(function FaultRow({ item }: { item: DevUiFault }) {
  const [sticky, setSticky] = useState(item.stickyByDefault)
  const [count, setCount] = useState(3)
  const arm = () => {
    const server = devServer()
    switch (item.action.type) {
      case 'rule':
        server.addFault(uiFaultRule(item, sticky)!)
        break
      case 'fail-next':
        server.setJobFaults({ failNext: 'Tạo video thất bại (giả lập: lỗi do Bảng phát triển bật).' })
        break
      case 'expire-next':
        server.setJobFaults({ expireNext: true })
        break
      case 'stream-failures':
        server.setJobFaults({ streamFailures: Math.max(1, Math.min(20, Math.trunc(count) || 1)) })
        break
      case 'expire-session':
        server.expireSession()
        syncBalance()
        break
      case 'logout-copy-stuck':
        server.setJobFaults({ logoutCopyStuck: true })
        break
    }
    toast(faultArmedText(item, sticky, Math.max(1, Math.min(20, Math.trunc(count) || 1))), { tone: 'warning' })
  }
  return (
    <div className="dv-fault">
      <div className="dv-fault-text">
        <b>{item.label}</b>
        <small>{item.hint}</small>
      </div>
      <div className="dv-fault-ctl">
        {item.action.type === 'stream-failures' && (
          <label className="dv-n">
            <span>N =</span>
            <input className="input" type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Số lần tải video lỗi" />
          </label>
        )}
        {item.canStick && (
          <label className="checkbox dv-stick" title="Giữ: lỗi lặp lại cho mọi yêu cầu khớp tới khi bạn tắt">
            <input type="checkbox" checked={sticky} onChange={(e) => setSticky(e.target.checked)} />
            giữ
          </label>
        )}
        <button type="button" className="btn btn-sm" onClick={arm}>
          <Zap size={13} /> Bật
        </button>
      </div>
    </div>
  )
})

function CustomRule() {
  const [form, setForm] = useState<CustomFaultForm>(CUSTOM_FAULT_DEFAULT)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<CustomFaultForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setError(null)
  }
  const needsStatus = form.kind === 'response' || form.kind === 'processed-then'
  const kinds = faultKindsFor(form.endpoint)
  const add = () => {
    const r = customFaultInput(form)
    if (!r.ok) {
      setError(r.error)
      return
    }
    devServer().addFault({ ...r.input, label: 'Tự tạo' })
    toast('Đã thêm lỗi tự tạo.', { tone: 'warning' })
  }
  return (
    <details className="dv-custom">
      <summary>
        <ChevronRight size={14} className="dv-summary-chev" /> Tự tạo lỗi cho một yêu cầu
      </summary>
      <div className="dv-custom-form">
        <label className="dv-field">
          <span className="label">Yêu cầu</span>
          <select
            className="select"
            value={form.endpoint}
            onChange={(e) => {
              const endpoint = e.target.value
              if (!isDevEndpoint(endpoint)) return
              // the video-download kinds exist only for "Tải video"
              set(faultKindsFor(endpoint).includes(form.kind) ? { endpoint } : { endpoint, kind: 'response' })
            }}
          >
            <option value="*">{endpointText('*')}</option>
            {DEV_ENDPOINTS.map((ep) => (
              <option key={ep} value={ep}>
                {DEV_ENDPOINT_LABEL[ep]}
              </option>
            ))}
          </select>
        </label>
        <label className="dv-field">
          <span className="label">Kiểu lỗi</span>
          <select className="select" value={form.kind} onChange={(e) => set({ kind: e.target.value as DevFaultKind })}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {DEV_FAULT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        {needsStatus && (
          <label className="dv-field dv-field-sm">
            <span className="label">Mã HTTP</span>
            <input className="input mono" inputMode="numeric" value={form.status} onChange={(e) => set({ status: e.target.value })} />
          </label>
        )}
        {form.kind === 'slow' && (
          <label className="dv-field dv-field-sm">
            <span className="label">Chậm (ms)</span>
            <input className="input mono" inputMode="numeric" value={form.ms} onChange={(e) => set({ ms: e.target.value })} />
          </label>
        )}
        {form.kind === 'trickle' && (
          <label className="dv-field dv-field-sm">
            <span className="label">KB/giây</span>
            <input className="input mono" inputMode="numeric" value={form.kbps} onChange={(e) => set({ kbps: e.target.value })} />
          </label>
        )}
        {!form.sticky && (
          <label className="dv-field dv-field-sm">
            <span className="label">Số lần</span>
            <input className="input mono" inputMode="numeric" value={form.times} onChange={(e) => set({ times: e.target.value })} />
          </label>
        )}
        <label className="checkbox dv-stick">
          <input type="checkbox" checked={form.sticky} onChange={(e) => set({ sticky: e.target.checked })} />
          giữ
        </label>
        {needsStatus && (
          <label className="dv-field dv-field-wide">
            <span className="label">Nội dung trả về (JSON, để trống = {'{}'})</span>
            <textarea className="textarea mono" rows={2} value={form.json} placeholder='{"detail": "Lỗi giả lập"}' onChange={(e) => set({ json: e.target.value })} />
          </label>
        )}
        <div className="dv-custom-foot">
          {error && (
            <span className="dv-error" role="alert">
              <TriangleAlert size={13} /> {error}
            </span>
          )}
          <span className="dv-spacer" />
          <button type="button" className="btn btn-sm btn-primary" onClick={add}>
            <Plus size={13} /> Thêm lỗi
          </button>
        </div>
      </div>
    </details>
  )
}

// =============================================================================================
// Nhật ký
// =============================================================================================

function LogTab({ snap }: { snap: DevServerSnapshot }) {
  const entries = useDevLog((s) => s.entries)
  const [query, setQuery] = useState('')
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const shown = useMemo(() => filterLog(entries, query, onlyProblems), [entries, query, onlyProblems])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logExport(entries, snap))
      toast(`Đã copy nhật ký (${entries.length} yêu cầu) dạng JSON — dán vào tin nhắn báo lỗi.`, { tone: 'success' })
    } catch {
      toast('Trình duyệt chặn clipboard — không copy được nhật ký.', { tone: 'error' })
    }
  }

  return (
    <div className="dv-log">
      <div className="dv-log-bar">
        <input
          className="input dv-log-search"
          type="search"
          placeholder="Lọc: video-jobs, 402, network, Tạo job…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Lọc nhật ký"
        />
        <label className="checkbox">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          Chỉ lỗi
        </label>
        <span className="dv-spacer" />
        <span className="dv-hint mono">
          {shown.length}/{entries.length}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => void copy()} disabled={!entries.length}>
          <ClipboardCopy size={13} /> Copy nhật ký
        </button>
        <button type="button" className="btn btn-sm" onClick={clearDevLog} disabled={!entries.length}>
          <Eraser size={13} /> Xoá
        </button>
      </div>
      {!entries.length ? (
        <div className="empty">Chưa có yêu cầu nào. Chạy một cảnh, mở Nạp credit hoặc đăng nhập để thấy SanoVids nói chuyện với canvasapp giả lập.</div>
      ) : !shown.length ? (
        <div className="empty">Không có yêu cầu nào khớp bộ lọc.</div>
      ) : (
        <ol className="dv-log-list">
          {shown.map((e) => (
            <LogRow key={e.id} entry={e} open={open === e.id} onToggle={() => setOpen((o) => (o === e.id ? null : e.id))} snap={snap} />
          ))}
        </ol>
      )}
    </div>
  )
}

function LogRow({ entry: e, open, onToggle, snap }: { entry: DevLogEntry; open: boolean; onToggle: () => void; snap: DevServerSnapshot }) {
  const tone = statusTone(e)
  const isJob = e.endpoint === 'job-create'
  return (
    <li className={`dv-log-row ${tone}${open ? ' open' : ''}`}>
      <button type="button" className="dv-log-head" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="mono dv-log-time">{logTime(e.at)}</span>
        <span className={`dv-method ${e.method.toLowerCase()}`}>{e.method}</span>
        <span className="mono dv-log-path" title={e.path}>
          {e.path}
        </span>
        {e.endpoint && <span className="dv-log-ep">{DEV_ENDPOINT_LABEL[e.endpoint]}</span>}
        <span className="dv-spacer" />
        {e.fault && <span className="dv-fault-badge">{e.fault}</span>}
        {e.processed && (e.status === null || !!e.fault) && e.fault !== 'gateway-cache' && <span className="dv-processed" title="Máy chủ đã xử lý yêu cầu (có thể đã đổi dữ liệu) dù app không nhận được câu trả lời đúng">đã xử lý</span>}
        <span className={`dv-status ${tone}`}>{statusText(e)}</span>
        <span className="mono dv-log-ms">{e.ms} ms</span>
      </button>
      {open && (
        <div className="dv-log-body">
          {e.note && <p className="dv-hint">{e.note}</p>}
          {isJob && <CharacterCheckView body={e.req} snap={snap} />}
          <div className="dv-json-pair">
            <div>
              <span className="label">Gửi đi</span>
              <pre className="dv-json">{e.req === null || e.req === undefined ? '—' : JSON.stringify(e.req, null, 2)}</pre>
            </div>
            <div>
              <span className="label">Nhận về</span>
              <pre className="dv-json">{e.res === null || e.res === undefined ? '—' : JSON.stringify(e.res, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}
    </li>
  )
}

/** "Kiểm tra nhân vật": every picture of the job in upload order = @image_N, with the SanoVids picture and asset. */
function CharacterCheckView({ body, snap }: { body: unknown; snap: DevServerSnapshot }) {
  const assets = useProject((s) => s.project.assets)
  const check = useMemo(() => characterCheck(body, { uploads: snap.uploads, jobs: snap.jobs, assets }), [body, snap.uploads, snap.jobs, assets])
  if (!check) return null
  const unknown = check.slots.filter((s) => !s.uploaded).length
  const ok = !check.missing.length && !unknown
  return (
    <section className="dv-cc">
      <header>
        <h4>Kiểm tra nhân vật</h4>
        {ok ? (
          <span className="dv-pill ok">
            <CircleCheck size={12} /> Khớp
          </span>
        ) : (
          <span className="dv-pill danger">
            <CircleX size={12} /> {check.missing.length ? `${check.missing.length} token không có ảnh` : `${unknown} ảnh không có trên máy chủ`}
          </span>
        )}
        {check.promptTruncated && <span className="dv-pill warn">Prompt bị cắt trong nhật ký — chỉ kiểm tra phần đầu</span>}
      </header>
      {check.slots.length ? (
        <ul className="dv-cc-list">
          {check.slots.map((s, i) => (
            <li key={`${s.uploadId}-${i}`} className={s.uploaded ? '' : 'bad'}>
              <span className={`dv-cc-token${check.kind === 'frames' ? ' frame' : ''}`}>{s.label}</span>
              <span className="dv-cc-thumb">{s.imageId ? <MediaImg id={s.imageId} /> : <ImageOff size={14} />}</span>
              <span className="dv-cc-text">
                <b>{s.asset ? s.asset.name : s.imageId ? 'Ảnh không còn trong dự án' : 'Không rõ ảnh'}</b>
                <small>
                  {s.asset ? `@${s.asset.tag} · ` : ''}
                  <span className="mono" title={s.uploadId}>
                    upload {s.uploadId.slice(0, 8)}…
                  </span>
                  {!s.uploaded && ' · không có trên máy chủ'}
                  {check.kind === 'images' && !s.mentioned && ' · prompt không nhắc tới'}
                </small>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dv-hint">Job không gửi ảnh nào (text → video).</p>
      )}
      {check.missing.length > 0 && (
        <p className="dv-cc-missing">
          <TriangleAlert size={13} /> Prompt nhắc {check.missing.map((m) => m.token).join(', ')} nhưng job chỉ có {check.kind === 'frames' ? 'khung đầu/cuối' : `${check.slots.length} ảnh`} — model sẽ không
          có ảnh cho {check.missing.length > 1 ? 'các số này' : 'số này'}.
        </p>
      )}
      <div className="dv-cc-prompt">
        <span className="label">{check.promptFromJob ? 'Prompt canvasapp giả lập nhận được' : 'Prompt (trong nhật ký)'}</span>
        <p>
          <HighlightedPrompt text={check.prompt || '—'} />
        </p>
      </div>
    </section>
  )
}

// =============================================================================================
// Job & đơn nạp
// =============================================================================================

const JOB_STATUS: Record<DevJobView['status'], { label: string; dot: string }> = {
  queued: { label: 'Đang chờ', dot: 'queued' },
  processing: { label: 'Đang tạo', dot: 'processing' },
  completed: { label: 'Hoàn thành', dot: 'completed' },
  failed: { label: 'Lỗi', dot: 'failed' },
  cancelled: { label: 'Đã huỷ', dot: 'cancelled' },
  expired: { label: 'Hết hạn', dot: 'cancelled' },
}

const TOPUP_STATUS: Record<DevTopupView['status'], string> = {
  pending: 'Chờ thanh toán',
  paid: 'Đã thanh toán',
  reconciled: 'Đã đối soát',
  reconcile_required: 'Cần đối soát',
  expired: 'Hết hạn',
  rejected: 'Bị từ chối',
}

/** Open "Nhập job" from here — always the simulated site; closing it comes back to this tab. */
const importHere = () => openImportJobs({ back: { kind: 'dev', tab: 'jobs' }, provider: 'dev' })

function JobsTab({ snap }: { snap: DevServerSnapshot }) {
  return (
    <div className="dv-jobs">
      <SiteJobCard snap={snap} />
      <JobList jobs={snap.jobs} />
      <TopupList orders={snap.topups} />
      <UploadGrid snap={snap} />
    </div>
  )
}

function JobList({ jobs }: { jobs: DevJobView[] }) {
  const takes = useRuns((s) => s.takes)
  const scenes = useProject((s) => s.project.scenes)
  const projectId = useProject((s) => s.project.id)
  const nodeOwners = useMemo(() => jobNodeOwners(projectId, scenes), [projectId, scenes])
  const takeOf = useMemo(() => {
    const order = new Map(scenes.map((s) => [s.id, s.order]))
    const m = new Map<string, { id: string; code: string }>()
    // take.remoteId is "<project_id>:<job_id>" (canvasapp/mapping encodeRemoteId)
    for (const t of takes) {
      const jobId = t.remoteId && providerOf(t) === 'dev' ? decodeRemoteId(t.remoteId)?.jobId : null
      if (jobId) m.set(jobId, { id: t.id, code: takeCode(order.get(t.sceneId), t.number) })
    }
    return m
  }, [takes, scenes])
  const force = (job: DevJobView, action: 'complete' | 'fail' | 'expire') => {
    const ok = devServer().forceJob(job.job_id, action, action === 'fail' ? 'Job bị đánh lỗi trong Bảng phát triển.' : undefined)
    if (!ok) toast('Job này đã kết thúc.', { tone: 'warning' })
    else syncBalance()
  }
  return (
    <section className="dv-section">
      <h3>Job trên máy chủ giả lập ({jobs.length})</h3>
      {!jobs.length ? (
        <div className="empty">Chưa có job nào. Chạy một cảnh ở chế độ Phát triển để tạo job.</div>
      ) : (
        <ul className="dv-job-list">
          {jobs.slice(0, 60).map((j) => {
            const st = JOB_STATUS[j.status]
            const running = j.status === 'queued' || j.status === 'processing'
            const take = takeOf.get(j.job_id)
            const node = jobNodeText(j.canvas_node_id, nodeOwners.get(j.canvas_node_id))
            return (
              <li key={j.job_id} className={`dv-job ${j.status}`}>
                <div className="dv-job-main">
                  <span className="dv-job-num mono">#{j.number}</span>
                  <span className={`status-dot ${st.dot}`} />
                  <b>{st.label}</b>
                  {running && <span className="mono dv-hint">{j.progress}%</span>}
                  <span className="dv-hint">
                    {MODELS[j.model_profile]?.short ?? j.model_profile} · {j.mode} · {j.duration}s · {j.resolution}
                  </span>
                  {j.planned === 'fail' && running && <span className="dv-pill warn">sẽ lỗi</span>}
                  {j.planned === 'expire' && running && <span className="dv-pill warn">sẽ hết hạn</span>}
                  <span className="dv-spacer" />
                  <span className={`mono dv-job-cost${j.refunded ? ' refunded' : ''}`} title={j.refunded ? 'Đã hoàn credit dev' : 'Đã trừ khi nhận job'}>
                    {formatCredits(j.cost, 'dev', { short: true })}
                  </span>
                  {j.refunded && <span className="dv-hint">đã hoàn</span>}
                  {j.origin === 'site' && (
                    <span className="dv-pill" title="Tạo bằng “Tạo job như trên trang canvasapp” — client_request_id ngẫu nhiên, SanoVids chỉ biết khi nhập">
                      tạo trên trang
                    </span>
                  )}
                  {take ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => useUI.getState().openDialog({ kind: 'take', takeId: take.id })}
                      title="Mở take của job này trong SanoVids"
                    >
                      {take.code}
                    </button>
                  ) : (
                    <>
                      <span className="dv-hint" title="Không có take nào trong dự án đang mở trỏ tới job này">
                        không có take
                      </span>
                      <button type="button" className="btn btn-sm" onClick={importHere} title="Mở “Nhập job”: đưa job tạo trên trang vào dự án thành take (không trừ credit dev)">
                        <CloudDownload size={13} /> Nhập
                      </button>
                    </>
                  )}
                </div>
                {running && (
                  <span className="progress dv-job-progress">
                    <i style={{ width: `${Math.max(2, j.progress)}%` }} />
                  </span>
                )}
                <div className="dv-job-sub">
                  <span className="mono" title={`client_request_id: ${j.client_request_id}\njob_id: ${j.job_id}`}>
                    key {j.client_request_id.slice(0, 8)}… · job {j.job_id.slice(0, 8)}…
                  </span>
                  <span className="dv-hint" title={node.title}>
                    · {node.label}
                  </span>
                  <span className="dv-hint">· {j.upload_ids.length ? `${j.upload_ids.length} ảnh` : j.first_frame_upload_id ? 'khung đầu/cuối' : 'không ảnh'}</span>
                  <span className="dv-hint">· {logTime(j.created_at)}</span>
                  {j.error_message && <span className="dv-error">· {j.error_message}</span>}
                  {running && (
                    <span className="dv-job-actions">
                      <button type="button" className="btn btn-sm" onClick={() => force(j, 'complete')}>
                        <CircleCheck size={13} /> Hoàn tất ngay
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => force(j, 'fail')}>
                        <CircleX size={13} /> Cho lỗi
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => force(j, 'expire')}>
                        <Hourglass size={13} /> Cho hết hạn
                      </button>
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * "Tạo job như trên trang canvasapp": a node of the bridge session → the job the site's own page would make for it
 * (optionally after editing the node there), billed in credit dev. SanoVids learns of it only through "Nhập job".
 */
function SiteJobCard({ snap }: { snap: DevServerSnapshot }) {
  const scenes = useProject((s) => s.project.scenes)
  const projectId = useProject((s) => s.project.id)
  const owners = useMemo(() => jobNodeOwners(projectId, scenes), [projectId, scenes])
  // the snapshot changes with every change of the simulated account: the saved canvas is read again then
  const site = useMemo(() => devServer().siteNodes(), [snap])
  const [picked, setPicked] = useState('')
  const [editing, setEditing] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [resolution, setResolution] = useState('')
  const node = site?.nodes.find((n) => n.id === picked) ?? site?.nodes[0]
  /** canvas_node_id → the scene's title (its node in this project, or the old node named by the scene id). */
  const titles = useMemo(() => {
    const m = new Map<string, string>()
    for (const x of scenes) m.set(canvasNodeId(x.id), x.title)
    for (const x of scenes) m.set(sceneNodeId(projectId, x.id), x.title)
    return m
  }, [projectId, scenes])
  const titleOf = (nodeId: string) => titles.get(nodeId) || undefined
  useEffect(() => {
    setPrompt(node?.prompt ?? '')
    setResolution(node?.resolution ?? '')
  }, [node?.id])
  const create = () => {
    if (!node) return
    const res = devServer().createSiteJob({ nodeId: node.id, edit: editing ? { prompt, resolution } : undefined })
    const said = siteJobToast(res)
    if (said.ok) {
      toast(said.text, { tone: 'success', action: { label: 'Nhập job', run: importHere } })
      syncBalance()
    } else toast(said.text, { tone: 'warning', ms: 7000 })
  }
  return (
    <Card title="Tạo job như trên trang canvasapp" icon={<MousePointerClick size={15} />}>
      <p className="dv-hint">{SITE_JOB_HINT}</p>
      {!site || !site.nodes.length ? (
        <div className="empty">Chưa có phiên “SanoVids bridge” (hoặc canvas của nó chưa có node) — chạy một cảnh ở chế độ Phát triển trước.</div>
      ) : (
        <>
          <label className="dv-field">
            <span className="dv-label-row">Node (cảnh)</span>
            <select className="select" value={node?.id ?? ''} onChange={(e) => setPicked(e.target.value)}>
              {site.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {siteNodeLabel(n, owners.get(n.id), titleOf(n.id))}
                </option>
              ))}
            </select>
          </label>
          <Switch checked={editing} onChange={setEditing} label="Sửa node trước khi tạo (như chỉnh trên trang)" hint="Trang canvasapp lưu canvas rồi mới tạo job — lần chạy cảnh sau của SanoVids ghi đè lại node." />
          {editing && node && (
            <div className="dv-site-edit">
              <label className="dv-field">
                <span className="dv-label-row">Prompt</span>
                <textarea className="textarea" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              </label>
              <label className="dv-field">
                <span className="dv-label-row">Độ phân giải</span>
                <select className="select" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                  {(node.model ? MODELS[node.model].resolutions : [node.resolution]).map((r) => (
                    <option key={r} value={r.toLowerCase()}>
                      {r.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="dv-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={!node || (editing && !prompt.trim())} onClick={create}>
              <MousePointerClick size={13} /> Tạo job trên trang (giả lập)
            </button>
            <button type="button" className="btn btn-sm" onClick={importHere}>
              <CloudDownload size={13} /> Nhập job…
            </button>
          </div>
        </>
      )}
    </Card>
  )
}

const SETTLE: Exclude<DevTopupOutcome, 'none'>[] = ['paid', 'reconcile_required', 'rejected', 'expired']
const SETTLE_LABEL: Record<Exclude<DevTopupOutcome, 'none'>, string> = {
  paid: 'Đã thanh toán',
  reconcile_required: 'Cần đối soát',
  rejected: 'Từ chối',
  expired: 'Hết hạn',
}

function TopupList({ orders }: { orders: DevTopupView[] }) {
  const settle = (o: DevTopupView, outcome: Exclude<DevTopupOutcome, 'none'>) => {
    if (!devServer().simulatePayment(o.order_id, outcome, 0)) toast('Đơn này không còn chờ thanh toán.', { tone: 'warning' })
    else syncBalance()
  }
  return (
    <section className="dv-section">
      <h3>Đơn nạp credit ({orders.length})</h3>
      {!orders.length ? (
        <div className="empty">Chưa có đơn nạp nào. Bấm “+” cạnh ô credit để thử nạp qua SePay giả lập.</div>
      ) : (
        <ul className="dv-job-list">
          {orders.slice(0, 30).map((o) => (
            <li key={o.order_id} className={`dv-job ${o.status}`}>
              <div className="dv-job-main">
                <span className="mono dv-job-num">{o.order_id}</span>
                <b>{TOPUP_STATUS[o.status]}</b>
                <span className="dv-hint">
                  {formatVnd(o.amount_vnd)} → {formatCredits(o.credits, 'dev')}
                </span>
                {o.settle && (
                  <span className="dv-pill warn" title={`Lúc ${logTime(o.settle.at)}`}>
                    sắp: {DEV_TOPUP_OUTCOME_LABEL[o.settle.outcome]}
                  </span>
                )}
                <span className="dv-spacer" />
                <span className="dv-hint">
                  {logTime(o.created_at)} · hết hạn {logTime(o.expires_at)}
                </span>
              </div>
              {o.status === 'pending' && (
                <div className="dv-job-sub">
                  <span className="dv-hint">canvasapp giả lập trả lời:</span>
                  <span className="dv-job-actions">
                    {SETTLE.map((s) => (
                      <button key={s} type="button" className="btn btn-sm" onClick={() => settle(o, s)}>
                        {SETTLE_LABEL[s]}
                      </button>
                    ))}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function UploadGrid({ snap }: { snap: DevServerSnapshot }) {
  const assets = useProject((s) => s.project.assets)
  const nameOf = (imageId: string | null) => (imageId ? assets.find((a) => a.imageIds.includes(imageId))?.name ?? null : null)
  return (
    <section className="dv-section">
      <h3>Ảnh đã tải lên máy chủ giả lập ({snap.uploads.length})</h3>
      {!snap.uploads.length ? (
        <div className="empty">Chưa có ảnh nào. SanoVids tải mỗi ảnh tham chiếu lên một lần khi chạy cảnh có ảnh.</div>
      ) : (
        <ul className="dv-uploads">
          {snap.uploads.slice(0, 48).map((u) => (
            <li key={u.upload_id} title={`${u.filename} · ${Math.round(u.size / 1024)} KB · ${u.upload_id}`}>
              <span className="dv-upload-thumb">{u.imageId ? <MediaImg id={u.imageId} /> : <ImageOff size={16} />}</span>
              <small>{nameOf(u.imageId) ?? u.filename}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
