// Settings → "Cơ bản": appearance, saving videos, video sound, wires & canvas, prompt, app updates, the app, project data.
// Each row subscribes to its own pref only (the dialog never re-renders as a whole) and applies at once; the stores
// save and validate the values (lib/theme, lib/downloads, lib/playback, lib/canvasPrefs, store/ui, store/project,
// lib/updatePrefs).
import {
  AppWindow,
  CircleArrowUp,
  CircleCheck,
  Clock,
  CloudDownload,
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
  RefreshCw,
  Sparkles,
  Sun,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { EdgeMode } from '../../core/types'
import { useCanvasPrefs } from '../../lib/canvasPrefs'
import { desktopFiles } from '../../lib/desktopFiles'
import { canPickFolder, canSaveAs, clearDownloadFolder, pendingDownloadCount, pickDownloadFolder, savePendingDownloads, useDownloadPrefs } from '../../lib/downloads'
import { PLAYBACK_RATES, usePlayback } from '../../lib/playback'
import { desktopInfo, usePwaInstall } from '../../lib/pwa'
import { THEME_LABEL, useTheme, type ThemePref } from '../../lib/theme'
import { autoDownloadNote, hasUpdateDetails, lastCheckText, settingsIntroTitle, settingsStatusLine } from '../../lib/updateModel'
import { useUpdatePrefs } from '../../lib/updatePrefs'
import { useUpdates } from '../../lib/updates'
import { createDemo, exportProjectFile, importProjectFile } from '../../store/persist'
import { useProject } from '../../store/project'
import { toast, useUI, type InteractionMode, type TakeDisplay } from '../../store/ui'
import { checkNow, openUpdateDialog, useInstallUi } from '../../updateActions'
import { rateLabel } from '../canvas/playerModel'
import './dialogs.css'
import { Segmented } from './Segmented'
import { Field, Section, Toggle, useSettingsCtx, type RowProps } from './settingsUi'
import { errorText } from './shared'

const THEMES: { id: ThemePref; label: string; icon: ReactNode }[] = [
  { id: 'system', label: 'Hệ thống', icon: <Monitor size={14} /> },
  { id: 'light', label: 'Sáng', icon: <Sun size={14} /> },
  { id: 'dark', label: 'Tối', icon: <Moon size={14} /> },
]

export function ThemeSetting({ label, hint }: RowProps) {
  const pref = useTheme((s) => s.pref)
  const theme = useTheme((s) => s.theme)
  const setPref = useTheme((s) => s.setPref)
  return (
    <Field
      label={label}
      hint={
        <>
          {pref === 'system' ? `Đang theo hệ thống: ${theme === 'dark' ? 'Tối' : 'Sáng'}.` : `Luôn dùng chế độ ${THEME_LABEL[pref]}, kể cả khi máy đổi.`} {hint}
        </>
      }
    >
      <Segmented label={label} size="lg" value={pref} onChange={setPref} options={THEMES.map((t) => ({ ...t, title: THEME_LABEL[t.id] }))} />
    </Field>
  )
}

// ---------------- Tải video ----------------
export function AskWhereSetting({ label, hint }: RowProps) {
  const askWhere = useDownloadPrefs((s) => s.askWhere)
  const set = useDownloadPrefs((s) => s.set)
  const where = desktopFiles()
    ? 'Bản desktop: hộp thoại Lưu của Windows, file .txt lưu cạnh video với cùng tên.'
    : canSaveAs()
      ? 'Chrome / Edge: hộp thoại Lưu cho video; file .txt tải về thư mục Tải xuống.'
      : 'Trình duyệt này không có hộp thoại Lưu: video vẫn tải về thư mục Tải xuống (Downloads).'
  return (
    <Toggle
      checked={askWhere}
      onChange={(v) => set({ askWhere: v })}
      label={label}
      hint={
        <>
          {hint} {where}
        </>
      }
    />
  )
}

export function WithPromptSetting({ label, hint }: RowProps) {
  const withPrompt = useDownloadPrefs((s) => s.withPrompt)
  const set = useDownloadPrefs((s) => s.set)
  return <Toggle checked={withPrompt} onChange={(v) => set({ withPrompt: v })} label={label} hint={hint} />
}

export function AutoDownloadSetting({ label, hint }: RowProps) {
  const autoDownload = useDownloadPrefs((s) => s.autoDownload)
  const folderName = useDownloadPrefs((s) => s.folderName)
  const set = useDownloadPrefs((s) => s.set)
  const { desktop } = usePwaInstall()
  return (
    <Toggle
      checked={autoDownload}
      onChange={(v) => set({ autoDownload: v })}
      label={label}
      hint={`${hint ?? ''}${!desktop && !folderName ? ' Lần đầu trình duyệt có thể hỏi “Cho phép tải nhiều tệp”.' : ''}`}
    />
  )
}

/** "Thư mục tải mặc định": the folder used by auto-downloads (and clicks when "Hỏi nơi lưu" is off). */
export function DownloadFolderSetting({ label }: RowProps) {
  const autoDownload = useDownloadPrefs((s) => s.autoDownload)
  const askWhere = useDownloadPrefs((s) => s.askWhere)
  const folderName = useDownloadPrefs((s) => s.folderName)
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

  const used = askWhere ? 'Dùng cho video tự tải' : 'Dùng cho nút Tải video và video tự tải'
  let hint: ReactNode
  if (folderName) {
    hint = `${used}: ghi thẳng vào “${folderName}”. Sau khi mở lại app, ${desktop ? 'app' : 'trình duyệt'} có thể hỏi lại quyền ghi vào thư mục.`
  } else if (desktop) {
    hint = `${used}: chưa chọn thư mục nên lưu vào thư mục Downloads của máy (không hỏi).`
  } else if (canPick) {
    hint = `${used}: chưa chọn thư mục nên trình duyệt tải về Downloads.`
  } else {
    hint = 'Trình duyệt này không cho chọn thư mục — video được tải về thư mục Downloads. Dùng Chrome / Edge / Brave hoặc bản desktop để lưu thẳng vào một thư mục.'
  }

  return (
    <div className="dg-field">
      <span className="label">{label}</span>
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
    </div>
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

// ---------------- Âm thanh video ----------------
export function SoundSetting({ label, hint }: RowProps) {
  const sound = usePlayback((s) => s.sound)
  const setSound = usePlayback((s) => s.setSound)
  return <Toggle checked={sound} onChange={setSound} label={label} hint={hint} />
}

export function VolumeSetting({ label, hint }: RowProps) {
  const volume = usePlayback((s) => s.volume)
  const sound = usePlayback((s) => s.sound)
  const setVolume = usePlayback((s) => s.setVolume)
  const id = useId()
  const pct = Math.round(volume * 100)
  return (
    <Field label={label} labelId={id} hint={sound ? hint : `${hint ?? ''} Tiếng đang tắt (mục trên).`} value={<span className="dg-value mono">{pct}%</span>}>
      <input
        className="dg-range"
        type="range"
        min={0}
        max={100}
        step={5}
        value={pct}
        aria-labelledby={id}
        aria-valuetext={`${pct}%`}
        onChange={(e) => setVolume(Number(e.target.value) / 100)}
      />
    </Field>
  )
}

export function RateSetting({ label, hint }: RowProps) {
  const rate = usePlayback((s) => s.rate)
  const setRate = usePlayback((s) => s.setRate)
  return (
    <Field label={label} hint={hint}>
      <Segmented label={label} value={rate} onChange={setRate} options={PLAYBACK_RATES.map((r) => ({ id: r, label: rateLabel(r), title: `Phát ở tốc độ ${rateLabel(r)}` }))} />
    </Field>
  )
}

// ---------------- Dây nối & canvas ----------------
export function ClickToCutSetting({ label, hint }: RowProps) {
  const clickToCut = useCanvasPrefs((s) => s.clickToCut)
  const set = useCanvasPrefs((s) => s.set)
  return <Toggle checked={clickToCut} onChange={(v) => set({ clickToCut: v })} label={label} hint={hint} />
}

const EDGE_OPTIONS: { id: EdgeMode; label: string; title: string }[] = [
  { id: 'hidden', label: 'Ẩn', title: 'Chỉ hiện dây của thẻ đang trỏ chuột' },
  { id: 'selected', label: 'Đang chọn', title: 'Hiện dây của thẻ đang chọn / đang trỏ' },
  { id: 'all', label: 'Tất cả', title: 'Hiện mọi dây nối' },
]

export function EdgeModeSetting({ label, hint }: RowProps) {
  const edgeMode = useUI((s) => s.edgeMode)
  const setEdgeMode = useUI((s) => s.setEdgeMode)
  return (
    <Field label={label} hint={hint}>
      <Segmented label={label} value={edgeMode} onChange={setEdgeMode} options={EDGE_OPTIONS} />
    </Field>
  )
}

const TAKE_OPTIONS: { id: TakeDisplay; label: string; title: string }[] = [
  { id: 'all', label: 'Tất cả take', title: 'Hiện mọi take (video) của mỗi cảnh' },
  { id: 'chosen', label: 'Chỉ take chọn', title: 'Mỗi cảnh chỉ hiện take được chọn (★, nếu không thì take xong mới nhất)' },
]

export function TakeDisplaySetting({ label, hint }: RowProps) {
  const takeDisplay = useUI((s) => s.takeDisplay)
  const setTakeDisplay = useUI((s) => s.setTakeDisplay)
  return (
    <Field label={label} hint={hint}>
      <Segmented label={label} value={takeDisplay} onChange={setTakeDisplay} options={TAKE_OPTIONS} />
    </Field>
  )
}

const MOUSE_OPTIONS: { id: InteractionMode; label: string; hint: string; title: string }[] = [
  { id: 'hand', label: 'Di chuyển', hint: 'phím H', title: 'Kéo nền để di chuyển, Shift+kéo để chọn vùng' },
  { id: 'select', label: 'Chọn vùng', hint: 'phím V', title: 'Kéo để chọn vùng, giữ Space hoặc chuột giữa để di chuyển' },
]

export function InteractionSetting({ label, hint }: RowProps) {
  const interaction = useUI((s) => s.interaction)
  const setInteraction = useUI((s) => s.setInteraction)
  return (
    <Field label={label} hint={hint}>
      <Segmented label={label} value={interaction} onChange={setInteraction} options={MOUSE_OPTIONS} />
    </Field>
  )
}

export function MinimapSetting({ label, hint }: RowProps) {
  const showMinimap = useUI((s) => s.showMinimap)
  const setMinimap = useUI((s) => s.setMinimap)
  return <Toggle checked={showMinimap} onChange={setMinimap} label={label} hint={hint} />
}

// ---------------- Prompt (project setting) ----------------
export function AutoRenumberSetting({ label, hint }: RowProps) {
  const autoRenumber = useProject((s) => s.project.settings.autoRenumber)
  const update = useProject((s) => s.updateProjectSettings)
  return <Toggle checked={autoRenumber} onChange={(v) => update({ autoRenumber: v })} label={label} hint={hint} />
}

// ---------------- Cập nhật ----------------
/** Re-render every `ms` (relative times such as "5 phút trước"). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}

/** Version, kind and what the updater is doing (top of the "Cập nhật" group). */
export function UpdateStatusIntro() {
  const state = useUpdates((s) => s.state)
  const autoDownload = useUpdatePrefs((s) => s.autoDownload)
  const { desktop } = usePwaInstall()
  const now = useNow(30_000)
  const web = !desktop
  const s = state.status
  const icon =
    s === 'checking' ? (
      <LoaderCircle size={17} className="dg-spin" />
    ) : s === 'downloading' ? (
      <CloudDownload size={17} />
    ) : s === 'available' || s === 'ready' ? (
      <CircleArrowUp size={17} />
    ) : s === 'none' ? (
      <CircleCheck size={17} />
    ) : s === 'error' ? (
      <TriangleAlert size={17} />
    ) : web && state.kind === 'dev' ? (
      <Globe size={17} />
    ) : (
      <RefreshCw size={17} />
    )
  return (
    <div className="dg-app">
      <div className="dg-app-status">
        <span className={`dg-app-icon${s === 'none' || s === 'ready' ? ' on' : ''}`} aria-hidden="true">
          {icon}
        </span>
        <span role="status">
          <b>{settingsIntroTitle(state, web)}</b>
          <small>{settingsStatusLine(state, { web, autoDownload })}</small>
          {state.lastCheck ? <small>Kiểm tra lần cuối: {lastCheckText(state.lastCheck, Math.max(now, state.lastCheck))}</small> : null}
        </span>
      </div>
      {hasUpdateDetails(state) && (
        <button type="button" className="btn btn-sm" onClick={openUpdateDialog}>
          Xem chi tiết
        </button>
      )}
    </div>
  )
}

/** "Tự động tải bản cập nhật" (installer builds only). */
export function UpdateAutoDownloadSetting({ label, hint }: RowProps) {
  const autoDownload = useUpdatePrefs((s) => s.autoDownload)
  const set = useUpdatePrefs((s) => s.set)
  const kind = useUpdates((s) => s.state.kind)
  const note = autoDownloadNote(kind)
  return (
    <Toggle
      // Shown off where it does not apply (portable / dev / web); the saved pref is untouched.
      checked={note ? false : autoDownload}
      onChange={(v) => set({ autoDownload: v })}
      label={label}
      disabled={!!note}
      hint={
        note ? (
          <>
            {hint} {note}
          </>
        ) : (
          hint
        )
      }
    />
  )
}

/** "Kiểm tra cập nhật" → "Kiểm tra ngay" (a toast gives the result). */
export function UpdateCheckSetting({ label, hint }: RowProps) {
  const status = useUpdates((s) => s.state.status)
  const kind = useUpdates((s) => s.state.kind)
  const manual = useInstallUi((s) => s.manualCheck)
  const checking = manual || status === 'checking'
  // Builds that never update: really disabled. While checking / downloading: aria-disabled, so the button keeps the
  // keyboard focus it had when clicked.
  const unavailable = kind === 'dev' || status === 'unsupported'
  const busy = checking || status === 'downloading'
  return (
    <Field label={label} hint={hint}>
      <button
        type="button"
        className="btn btn-sm dg-upd-check"
        disabled={unavailable}
        aria-disabled={!unavailable && busy ? true : undefined}
        onClick={() => {
          if (!busy) void checkNow()
        }}
      >
        {checking ? <LoaderCircle size={13} className="dg-spin" /> : <RefreshCw size={13} />} Kiểm tra ngay
      </button>
    </Field>
  )
}

// ---------------- Ứng dụng (block) ----------------
export function AppBlock() {
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
      <div className="dg-field-hint">Mỗi trình duyệt / bản app giữ dữ liệu riêng. Chuyển máy: Xuất dự án ở mục Dữ liệu dự án rồi Nhập file .sanovids.json ở máy kia (file .bdp.json cũ vẫn nhập được).</div>
    </Section>
  )
}

// ---------------- Dữ liệu dự án (block) ----------------
type DataJob = 'export' | 'import' | 'demo'

export function DataBlock() {
  const { close } = useSettingsCtx()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<DataJob | null>(null)

  const run = async (kind: DataJob, fn: () => Promise<void>, ok: string, closeAfter = false) => {
    if (busy) return
    setBusy(kind)
    try {
      await fn()
      toast(ok, { tone: 'success' })
      // The dialog may have been closed during a long import and another one opened: never close that one.
      if (closeAfter && useUI.getState().dialog.kind === 'settings') close()
    } catch (e) {
      toast(errorText(e), { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const icon = (kind: DataJob, idle: ReactNode) => (busy === kind ? <LoaderCircle size={14} className="dg-spin" /> : idle)

  return (
    <Section title="Dữ liệu dự án" desc="Dự án được lưu tự động trên máy này (ảnh và video trong IndexedDB). Xuất file để sao lưu hoặc chuyển sang máy khác.">
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
