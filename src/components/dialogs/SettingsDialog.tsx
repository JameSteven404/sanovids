import { AppWindow, Coins, Download, FileUp, FolderDown, FolderOpen, Globe, LoaderCircle, MonitorCheck, MonitorDown, Sparkles } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { canPickFolder, clearDownloadFolder, pickDownloadFolder, useDownloadPrefs } from '../../lib/downloads'
import { desktopInfo, usePwaInstall } from '../../lib/pwa'
import { createDemo, exportProjectFile, importProjectFile } from '../../store/persist'
import { useProject } from '../../store/project'
import { useRuns, type MockSpeed } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import './dialogs.css'
import { errorText } from './shared'

const SPEEDS: { id: MockSpeed; label: string; hint: string }[] = [
  { id: 'fast', label: 'Nhanh', hint: '3–6 giây / video' },
  { id: 'normal', label: 'Vừa', hint: '9–16 giây / video' },
  { id: 'slow', label: 'Chậm', hint: '22–38 giây / video' },
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
          <PromptSettings />
          <AppSettings />
          <DataSettings onDone={closeDialog} />
        </div>
        <div className="dg-settings-col">
          <DownloadSettings />
          <MockSettings />
          <CreditSettings />
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
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <i />
      </span>
    </label>
  )
}

// ---------------------------------------------------------------------------------------------

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
    </Section>
  )
}

function MockSettings() {
  const mock = useRuns((s) => s.mock)
  const setMock = useRuns((s) => s.setMock)
  return (
    <Section title="Nhà cung cấp giả lập" badge={<span className="badge accent">demo</span>} desc="Không gọi mạng, không tốn tiền. Dùng để thử hàng đợi, lỗi và take.">
      <div className="dg-field">
        <span className="label">Tốc độ tạo video</span>
        <div className="dg-seg dg-seg-full">
          {SPEEDS.map((s) => (
            <button key={s.id} className={mock.speed === s.id ? 'active' : ''} onClick={() => setMock({ speed: s.id })} title={s.hint}>
              {s.label}
              <small>{s.hint}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="dg-field">
        <div className="dg-label-row">
          <span className="label">Tỉ lệ lỗi giả</span>
          <span className="dg-value mono">{Math.round(mock.failRate * 100)}%</span>
        </div>
        <input
          className="dg-range"
          type="range"
          min={0}
          max={50}
          step={5}
          value={Math.round(mock.failRate * 100)}
          onChange={(e) => setMock({ failRate: Number(e.target.value) / 100 })}
        />
        <div className="dg-field-hint">Job lỗi được hoàn credit, giống nhà cung cấp thật.</div>
      </div>
      <div className="dg-field">
        <div className="dg-label-row">
          <span className="label">Số job chạy cùng lúc</span>
          <span className="dg-value mono">{mock.concurrency}</span>
        </div>
        <div className="dg-seg dg-seg-full">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={mock.concurrency === n ? 'active' : ''} onClick={() => setMock({ concurrency: n })}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <Toggle
        checked={mock.recordVideo}
        onChange={(v) => setMock({ recordVideo: v })}
        label="Ghi video webm giả"
        hint="Tạo đoạn video 3 giây cho mỗi take. Tắt nếu máy chậm — khi đó chỉ có poster."
      />
    </Section>
  )
}

function CreditSettings() {
  const credits = useRuns((s) => s.credits)
  const spent = useRuns((s) => s.spent)
  const addCredits = useRuns((s) => s.addCredits)
  return (
    <Section title="Credit demo">
      <div className="dg-credit">
        <div className="dg-credit-num">
          <Coins size={18} />
          <b>{credits.toLocaleString('vi-VN')}</b>
          <span>credit còn lại</span>
        </div>
        <div className="dg-credit-spent faint">Đã dùng {spent.toLocaleString('vi-VN')} credit</div>
        <button
          className="btn"
          onClick={() => {
            addCredits(100)
            toast('Đã nạp +100 credit demo.', { tone: 'success' })
          }}
        >
          +100 credit demo
        </button>
      </div>
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
        <button className="btn" disabled={!!busy} onClick={() => void run('demo', createDemo, 'Đã tạo dự án demo mới.', true)}>
          {icon('demo', <Sparkles size={14} />)} {busy === 'demo' ? 'Đang tạo…' : 'Tạo lại dự án demo'}
        </button>
      </div>
      <div className="dg-field-hint">“Tạo lại dự án demo” mở một dự án demo mới; dự án hiện tại vẫn nằm trong danh sách Dự án. File nhập vào mở thành dự án mới (không kèm video đã tạo).</div>
    </Section>
  )
}
