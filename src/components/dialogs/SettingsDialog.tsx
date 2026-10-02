import {
  AppWindow,
  Bug,
  Clock,
  Download,
  FileUp,
  FolderDown,
  FolderOpen,
  Globe,
  LoaderCircle,
  Monitor,
  MonitorCheck,
  MonitorDown,
  Moon,
  ScrollText,
  Sparkles,
  Sun,
  Zap,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { openDevPanel } from '../../actions'
import { formatCredits } from '../../lib/credits'
import { canPickFolder, clearDownloadFolder, pendingDownloadCount, pickDownloadFolder, savePendingDownloads, useDownloadPrefs } from '../../lib/downloads'
import { desktopInfo, usePwaInstall } from '../../lib/pwa'
import { THEME_LABEL, useTheme, type ThemePref } from '../../lib/theme'
import { PROVIDER_LABEL } from '../../providers'
import { DEV_SPEED_LABEL, devServer, startDevSnapshotTicker, useDevServer, type DevSpeed } from '../../providers/dev'
import { createDemo, exportProjectFile, importProjectFile } from '../../store/persist'
import { useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import { activeFaultCount } from '../dev/devModel'
import { useActiveProvider } from '../runs/shared'
import './dialogs.css'
import { GatewaySection } from './GatewaySection'
import { Segmented } from './Segmented'
import { errorText } from './shared'

const THEMES: { id: ThemePref; label: string; icon: ReactNode }[] = [
  { id: 'system', label: 'Hệ thống', icon: <Monitor size={14} /> },
  { id: 'light', label: 'Sáng', icon: <Sun size={14} /> },
  { id: 'dark', label: 'Tối', icon: <Moon size={14} /> },
]

export function SettingsDialog() {
  const closeDialog = useUI((s) => s.closeDialog)
  return (
    <Modal
      title="Cài đặt"
      onClose={closeDialog}
      size="wide"
      footer={
        <button className="btn btn-primary" onClick={closeDialog}>
          Xong
        </button>
      }
    >
      <div className="dg-settings">
        <div className="dg-settings-col">
          <AppearanceSettings />
          <PromptSettings />
          <AppSettings />
          <DataSettings onDone={closeDialog} />
        </div>
        <div className="dg-settings-col">
          <DownloadSettings />
          <GatewaySection />
          <DevSettings />
        </div>
      </div>
    </Modal>
  )
}

function Section({ title, desc, children, badge }: { title: string; desc?: ReactNode; children: ReactNode; badge?: ReactNode }) {
  return (
    <section className="dg-section">
      <header>
        <h3>
          {title}
          {badge}
        </h3>
        {desc && <p>{desc}</p>}
      </header>
      {children}
    </section>
  )
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="dg-toggle-row">
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

// ---------------------------------------------------------------------------------------------

/** "Giao diện": Hệ thống / Sáng / Tối (lib/theme — applied at once, remembered on this device). */
function AppearanceSettings() {
  const pref = useTheme((s) => s.pref)
  const theme = useTheme((s) => s.theme)
  const setPref = useTheme((s) => s.setPref)
  return (
    <Section title="Giao diện" desc="Chế độ sáng hoặc tối cho toàn bộ ứng dụng. “Hệ thống” tự đổi theo cài đặt của máy.">
      <Segmented label="Chế độ giao diện" size="lg" value={pref} onChange={setPref} options={THEMES.map((t) => ({ ...t, title: THEME_LABEL[t.id] }))} />
      <div className="dg-field-hint">
        {pref === 'system' ? `Đang theo hệ thống: ${theme === 'dark' ? 'Tối' : 'Sáng'}.` : `Luôn dùng chế độ ${THEME_LABEL[pref]}, kể cả khi máy đổi.`} Lựa chọn được nhớ trên máy
        này.
      </div>
    </Section>
  )
}

function PromptSettings() {
  const autoRenumber = useProject((s) => s.project.settings.autoRenumber)
  const update = useProject((s) => s.updateProjectSettings)
  return (
    <Section title="Prompt" desc="Prompt được gửi đúng như bạn viết. Ảnh và video tham chiếu được gọi bằng số: @image_1, @video_1…">
      <Toggle
        checked={autoRenumber}
        onChange={(v) => update({ autoRenumber: v })}
        label="Tự đánh lại số @image/@video khi đổi tham chiếu"
        hint="Khi bỏ nối, đổi thứ tự hoặc thêm/bớt ảnh của nhân vật, các token trong prompt được sửa để vẫn trỏ đúng ảnh/video (hoàn tác được). Tắt nếu muốn tự quản lý số."
      />
    </Section>
  )
}

function AppSettings() {
  const { canInstall, installed, desktop, promptInstall } = usePwaInstall()
  const [busy, setBusy] = useState(false)
  const info = desktop ? desktopInfo() : null

  const install = async () => {
    setBusy(true)
    try {
      await promptInstall()
    } finally {
      setBusy(false)
    }
  }

  let icon: ReactNode
  let title: string
  let sub: string
  if (desktop) {
    icon = <MonitorCheck size={17} />
    title = 'Đang chạy dạng app (bản desktop)'
    sub = info?.version ? `Phiên bản ${info.version}` : 'Bản cài trên máy tính'
  } else if (installed) {
    icon = <AppWindow size={17} />
    title = 'Đang chạy dạng app'
    sub = 'Mở từ biểu tượng app, chạy được cả khi không có mạng.'
  } else {
    icon = <Globe size={17} />
    title = 'Đang chạy trên trình duyệt'
    sub = canInstall ? 'Có thể cài thành app: cửa sổ riêng, mở nhanh, dùng offline.' : 'Cài thành app để có cửa sổ riêng và dùng offline.'
  }

  return (
    <Section title="Ứng dụng" desc="Dùng ngay trên web, hoặc cài thành app trên máy.">
      <div className="dg-app">
        <div className="dg-app-status">
          <span className={`dg-app-icon${installed || desktop ? ' on' : ''}`}>{icon}</span>
          <span>
            <b>{title}</b>
            <small>{sub}</small>
          </span>
        </div>
        {canInstall && !installed && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void install()}>
            {busy ? <LoaderCircle size={14} className="dg-spin" /> : <Download size={14} />} Cài app
          </button>
        )}
      </div>
      {!canInstall && !installed && !desktop && (
        <div className="dg-field-hint">
          Chrome / Edge / Brave: bấm biểu tượng cài đặt trên thanh địa chỉ, hoặc menu ⋮ → “Cài đặt SanoVids”. Trang phải được mở qua http(s).
        </div>
      )}
      {!desktop && (
        <div className="dg-app-exe">
          <MonitorDown size={16} />
          <div>
            <b>Bản cài Windows (.exe)</b>
            <p>
              Trong thư mục dự án chạy <code>npm run dist:win</code> → thư mục <code>release/</code> có bộ cài <code>SanoVids-Setup-…exe</code> và bản portable <code>SanoVids-Portable-…exe</code> (chạy
              không cần cài). Chép sang máy khác để cài; nếu Windows SmartScreen cảnh báo, chọn “More info → Run anyway”.
            </p>
          </div>
        </div>
      )}
      <div className="dg-field-hint">Mỗi trình duyệt / bản app giữ dữ liệu riêng. Chuyển máy: Xuất dự án ở mục Dữ liệu rồi Nhập file .sanovids.json ở máy kia (file .bdp.json cũ vẫn nhập được).</div>
    </Section>
  )
}

function DownloadSettings() {
  const autoDownload = useDownloadPrefs((s) => s.autoDownload)
  const withPrompt = useDownloadPrefs((s) => s.withPrompt)
  const folderName = useDownloadPrefs((s) => s.folderName)
  const setPrefs = useDownloadPrefs((s) => s.set)
  const { desktop } = usePwaInstall()
  const canPick = canPickFolder()
  const [busy, setBusy] = useState(false)
  const pending = usePendingDownloads()
  const [saving, setSaving] = useState(false)

  const pick = async () => {
    if (busy) return
    setBusy(true)
    try {
      const name = await pickDownloadFolder()
      if (name) toast(`Video sẽ được lưu vào thư mục “${name}”.`, { tone: 'success' })
    } finally {
      setBusy(false)
    }
  }
  const resetToDownloads = async () => {
    if (busy) return
    setBusy(true)
    try {
      await clearDownloadFolder()
      toast('Video sẽ được lưu vào thư mục Downloads.', { tone: 'success' })
    } finally {
      setBusy(false)
    }
  }
  // A click (this button) may ask the browser for the folder permission again; then every waiting file is written.
  const savePending = async () => {
    if (saving) return
    setSaving(true)
    try {
      const res = await savePendingDownloads()
      if (!res) toast('Không còn video nào đang chờ lưu.')
      else if (res.to === 'folder') toast(`Đã lưu ${res.names.length} file vào thư mục “${res.folder}”.`, { tone: 'success' })
      else toast(`Chưa được phép ghi vào thư mục nên đã tải ${res.names.length} file về Downloads.`, { tone: 'warning' })
    } catch (e) {
      toast(`Không lưu được: ${(e as Error).message}`, { tone: 'error' })
    } finally {
      setSaving(false)
      pending.refresh()
    }
  }

  let hint: ReactNode
  if (folderName) {
    hint = `Video được ghi thẳng vào thư mục “${folderName}”. Sau khi mở lại app, ${desktop ? 'app' : 'trình duyệt'} có thể hỏi lại quyền ghi vào thư mục khi bạn bấm tải.`
  } else if (desktop) {
    hint = 'Bản desktop: khi chưa chọn thư mục, video được lưu tự động vào thư mục Downloads của máy (không hỏi nơi lưu).'
  } else if (canPick) {
    hint = 'Chưa chọn thư mục: trình duyệt tải về thư mục Downloads (hoặc hỏi nơi lưu, tuỳ cài đặt của trình duyệt).'
  } else {
    hint = 'Trình duyệt này không cho chọn thư mục — video được tải về thư mục Downloads. Dùng Chrome / Edge / Brave hoặc bản desktop để lưu thẳng vào một thư mục.'
  }

  return (
    <Section title="Tải video" desc="Nút “Tải video” lưu file video đặt tên theo cảnh (S03_T2 - tên cảnh), giống canvasapp.">
      <Toggle
        checked={autoDownload}
        onChange={(v) => setPrefs({ autoDownload: v })}
        label="Tự tải video khi tạo xong"
        hint={`Mỗi take hoàn thành được lưu ngay, không cần bấm.${!desktop && !folderName ? ' Lần đầu trình duyệt có thể hỏi “Cho phép tải nhiều tệp”.' : ''}`}
      />
      <Toggle
        checked={withPrompt}
        onChange={(v) => setPrefs({ withPrompt: v })}
        label="Kèm file .txt chứa prompt"
        hint="Lưu thêm “S03_T2 - tên cảnh.txt” chứa đúng prompt đã gửi, cạnh file video."
      />
      <div className="dg-folder">
        <span className={`dg-folder-icon${folderName ? ' on' : ''}`}>{folderName ? <FolderOpen size={16} /> : <FolderDown size={16} />}</span>
        <span className="dg-folder-text">
          <small>Thư mục lưu:</small>
          <b title={folderName ?? 'Thư mục Downloads mặc định'}>{folderName ?? 'Downloads mặc định'}</b>
        </span>
        {canPick && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void pick()} title="Chọn một thư mục trên máy để lưu video vào đó">
            {busy ? <LoaderCircle size={13} className="dg-spin" /> : <FolderOpen size={13} />} Chọn thư mục…
          </button>
        )}
        {folderName && (
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void resetToDownloads()} title="Bỏ thư mục đã chọn, lưu vào Downloads">
            Dùng Downloads
          </button>
        )}
      </div>
      <div className="dg-field-hint">{hint}</div>
      {pending.count > 0 ? (
        <div className="dg-callout warn dg-pending">
          <Clock size={15} />
          <div>
            <b>{pending.count} file tự tải đang chờ lưu</b>
            {folderName ? ` vào “${folderName}”` : ''} — trình duyệt cần bạn cho phép ghi vào thư mục lần nữa (sau khi mở lại app). File không bị tải nhầm về Downloads.
          </div>
          <button className="btn btn-sm btn-primary" disabled={saving} onClick={() => void savePending()}>
            {saving ? <LoaderCircle size={13} className="dg-spin" /> : <FolderOpen size={13} />} Cho phép & lưu
          </button>
        </div>
      ) : (
        folderName &&
        autoDownload && (
          <div className="dg-field-hint">
            Khi chưa có quyền ghi vào thư mục, video tự tải được giữ lại chờ (không tải nhầm về Downloads): bấm “Cho phép & lưu” trên thông báo hoặc ở đây.
          </div>
        )
      )}
    </Section>
  )
}

/** Auto-downloads waiting for the folder permission (lib/downloads keeps them in memory, not in a store): re-read while open. */
function usePendingDownloads(): { count: number; refresh: () => void } {
  const [count, setCount] = useState(() => pendingDownloadCount())
  useEffect(() => {
    const id = window.setInterval(() => setCount(pendingDownloadCount()), 1500)
    return () => window.clearInterval(id)
  }, [])
  return { count, refresh: () => setCount(pendingDownloadCount()) }
}

/**
 * "Chế độ Phát triển": the simulated canvasapp of development mode at a glance (account, balance, armed faults) with
 * the settings used most; everything else is in "Bảng phát triển" (components/dev/DevPanel).
 */
function DevSettings() {
  const provider = useActiveProvider()
  const snap = useDevServer((s) => s.snapshot)
  // Creates the simulated server if needed and keeps the numbers fresh while this dialog is open.
  useEffect(() => startDevSnapshotTicker(), [])
  const armed = activeFaultCount(snap)
  return (
    <Section
      title="Chế độ Phát triển"
      badge={<span className="badge dg-dev-badge">DEV</span>}
      desc="canvasapp.io.vn giả lập ngay trong SanoVids để tìm và sửa lỗi: cùng mã với chế độ thật, không gọi mạng, credit dev không phải tiền thật."
    >
      {provider !== 'dev' && (
        <div className="dg-field-hint">Take mới đang dùng {PROVIDER_LABEL[provider]} — các cài đặt dưới đây chỉ áp dụng khi chọn {PROVIDER_LABEL.dev}.</div>
      )}
      {snap && (
        <div className="dg-dev-summary">
          <span className={`dg-dev-dot${snap.authenticated ? ' on' : ''}`} aria-hidden="true" />
          <span>{snap.authenticated ? 'Đã đăng nhập tài khoản giả lập' : 'Chưa đăng nhập tài khoản giả lập'}</span>
          <span className="faint">·</span>
          <b className="mono">{formatCredits(snap.balance, 'dev')}</b>
          {armed > 0 && (
            <>
              <span className="faint">·</span>
              <button type="button" className="dg-dev-armed" onClick={() => openDevPanel('faults')}>
                <Zap size={12} /> {armed} lỗi giả đang bật
              </button>
            </>
          )}
        </div>
      )}
      {snap && (
        <div className="dg-field">
          <span className="label">Tốc độ tạo video giả lập</span>
          <Segmented<DevSpeed>
            label="Tốc độ tạo video giả lập"
            value={snap.config.speed}
            onChange={(speed) => devServer().setConfig({ speed })}
            options={(['fast', 'realistic'] as DevSpeed[]).map((id) => ({ id, label: DEV_SPEED_LABEL[id] }))}
          />
        </div>
      )}
      <div className="dg-data-actions">
        <button className="btn btn-primary" onClick={() => openDevPanel()}>
          <Bug size={14} /> Mở Bảng phát triển
        </button>
        <button className="btn" onClick={() => openDevPanel('faults')} title="Mất mạng, mất câu trả lời, hết credit, job lỗi…">
          <Zap size={14} /> Gây lỗi
        </button>
        <button className="btn" onClick={() => openDevPanel('log')} title="Mọi yêu cầu SanoVids gửi tới canvasapp giả lập và câu trả lời">
          <ScrollText size={14} /> Nhật ký yêu cầu
        </button>
      </div>
      <div className="dg-field-hint">Video giả dài 3 giây, ghi nhãn @image_N trên từng ảnh tham chiếu theo đúng thứ tự canvasapp nhận — nhìn là biết có đúng nhân vật không.</div>
    </Section>
  )
}

type DataJob = 'export' | 'import' | 'demo'

function DataSettings({ onDone }: { onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<DataJob | null>(null)

  const run = async (kind: DataJob, fn: () => Promise<void>, ok: string, close = false) => {
    if (busy) return
    setBusy(kind)
    try {
      await fn()
      toast(ok, { tone: 'success' })
      // The dialog may have been closed during a long import and another one opened: never close that one.
      if (close && useUI.getState().dialog.kind === 'settings') onDone()
    } catch (e) {
      toast(errorText(e), { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const icon = (kind: DataJob, idle: ReactNode) => (busy === kind ? <LoaderCircle size={14} className="dg-spin" /> : idle)

  return (
    <Section title="Dữ liệu" desc="Dự án được lưu tự động trên máy này (ảnh và video trong IndexedDB). Xuất file để sao lưu hoặc chuyển sang máy khác.">
      <div className="dg-data-actions" aria-busy={!!busy}>
        <button className="btn" disabled={!!busy} onClick={() => void run('export', exportProjectFile, 'Đã xuất dự án (.sanovids.json).')}>
          {icon('export', <Download size={14} />)} {busy === 'export' ? 'Đang xuất…' : 'Xuất dự án'}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>
          {icon('import', <FileUp size={14} />)} {busy === 'import' ? 'Đang nhập…' : 'Nhập file .sanovids.json'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void run('import', () => importProjectFile(f), `Đã mở dự án từ “${f.name}”.`, true)
          }}
        />
        <button className="btn" disabled={!!busy} onClick={() => void run('demo', createDemo, 'Đã tạo dự án mẫu mới.', true)}>
          {icon('demo', <Sparkles size={14} />)} {busy === 'demo' ? 'Đang tạo…' : 'Tạo lại dự án mẫu'}
        </button>
      </div>
      <div className="dg-field-hint">“Tạo lại dự án mẫu” mở một dự án mẫu mới; dự án hiện tại vẫn nằm trong danh sách Dự án. File nhập vào mở thành dự án mới (không kèm video đã tạo).</div>
    </Section>
  )
}
