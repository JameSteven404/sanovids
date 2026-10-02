import {
  Bug,
  Clapperboard,
  Download,
  FileInput,
  FolderOpen,
  Keyboard,
  LayoutGrid,
  LoaderCircle,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Redo2,
  RotateCw,
  Settings,
  Sun,
  Table2,
  TriangleAlert,
  Undo2,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useStore } from 'zustand'
import { downloadChosenTakesZip, openDevPanel } from '../../actions'
import type { ViewMode } from '../../core/types'
import { THEME_LABEL, useTheme, type ThemePref } from '../../lib/theme'
import { activeProviderId, PROVIDER_LABEL, useProviderPrefs } from '../../providers'
import { useDevServer } from '../../providers/dev'
import { startRealCreditsSync } from '../../store/credits'
import { flush, useSave } from '../../store/persist'
import { redo, undo, useProject } from '../../store/project'
import { useActiveCount, useRuns } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { activeFaultCount } from '../dev/devModel'
import { CreditPill } from './CreditPill'
import './topbar.css'

const VIEWS: { id: ViewMode; label: string; key: string; icon: LucideIcon }[] = [
  { id: 'canvas', label: 'Canvas', key: '1', icon: Workflow },
  { id: 'table', label: 'Bảng cảnh', key: '2', icon: Table2 },
  { id: 'storyboard', label: 'Storyboard', key: '3', icon: LayoutGrid },
]

/**
 * Unified toolbar (Apple style): app mark + project left, the view switch centred, quiet icon buttons right.
 * Translucent material with a hairline bottom border.
 */
export function TopBar() {
  const openDialog = useUI((s) => s.openDialog)
  // Gateway balance (the simulated account in development mode, else the real canvasapp one): refreshed on focus /
  // visibility / every 60 s, and after every job of that gateway (store/credits). Ref-counted, so the pills' own
  // useCreditInfo() share this one sync.
  useEffect(() => startRealCreditsSync(), [])
  return (
    <header className="tb material">
      <div className="tb-left">
        <div className="tb-brand" title="SanoVids — dựng phim AI theo từng cảnh">
          <span className="tb-logo" aria-hidden="true">
            <Clapperboard size={14} />
          </span>
          <span className="tb-brand-text">SanoVids</span>
        </div>
        <span className="tb-divider" />
        <ProjectName />
        <SaveStatus />
        <button type="button" className="tb-btn tb-projects" onClick={() => openDialog({ kind: 'projects' })} title="Danh sách dự án">
          <FolderOpen size={16} />
          <span className="tb-hide-sm">Dự án</span>
        </button>
      </div>

      <div className="tb-center">
        <ViewSwitch />
      </div>

      <div className="tb-right">
        <HistoryButtons />
        <RunningIndicator />
        <ProviderBadge />
        <CreditPill />
        <DevButton />
        <button type="button" className="tb-btn tb-import" onClick={() => openDialog({ kind: 'import' })} title="Nhập prompt cũ (dán hoặc file .txt)">
          <FileInput size={16} />
          <span className="tb-hide-md">Nhập prompt</span>
        </button>
        <DownloadAllButton />
        <span className="tb-divider" />
        <AppearanceButton />
        <button type="button" className="icon-btn" onClick={() => openDialog({ kind: 'settings' })} title="Cài đặt (dự án, nhà cung cấp video, chế độ Phát triển)" aria-label="Cài đặt">
          <Settings size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => openDialog({ kind: 'shortcuts' })} title="Phím tắt (?)" aria-label="Phím tắt">
          <Keyboard size={16} />
        </button>
        <PanelToggles />
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------------------------

const ProjectName = memo(function ProjectName() {
  const name = useProject((s) => s.project.name)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const start = () => {
    setDraft(name)
    setEditing(true)
  }
  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== name) useProject.getState().renameProject(next)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="tb-name-input"
        value={draft}
        maxLength={80}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Stopped: the global Escape would blur the input, and blur commits the draft being cancelled.
            e.stopPropagation()
            setEditing(false)
            return
          }
          if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd combos must reach the global shortcuts (Ctrl+S saves — with the new name —, Ctrl+Enter
            // runs): stopping them here let the browser open its own "Save page" dialog instead.
            if (e.key === 'Enter' || e.key.toLowerCase() === 's') commit()
            return
          }
          e.stopPropagation()
          if (e.key === 'Enter') commit()
        }}
        aria-label="Tên dự án"
      />
    )
  }
  return (
    <button type="button" className="tb-name" onClick={start} title="Bấm để đổi tên dự án">
      <span className="tb-name-text">{name}</span>
    </button>
  )
})

/** Autosave status; clicking saves right away (same as Ctrl+S). */
function SaveStatus() {
  const status = useSave((s) => s.status)
  const savedAt = useSave((s) => s.savedAt)
  const stale = useSave((s) => s.stale)
  const [busy, setBusy] = useState(false)
  if (stale) return <StaleStatus />
  const shown = busy ? 'saving' : status
  const label = shown === 'saving' ? 'Đang lưu…' : shown === 'error' ? 'Lỗi lưu' : shown === 'saved' ? 'Đã lưu' : 'Chưa lưu'
  const title =
    status === 'error'
      ? 'Không ghi được vào bộ nhớ của trình duyệt. Bấm để thử lưu lại, hoặc xuất dự án ra file trong Cài đặt.'
      : `Tự động lưu trên máy này${savedAt ? ` · lần cuối ${new Date(savedAt).toLocaleTimeString('vi-VN')}` : ''} — bấm để lưu ngay (Ctrl+S)`

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      const ok = await flush()
      toast(ok ? 'Đã lưu' : 'Không lưu được. Thử xuất dự án ra file trong Cài đặt.', { tone: ok ? 'success' : 'error' })
    } catch {
      toast('Không lưu được. Thử xuất dự án ra file trong Cài đặt.', { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button type="button" className={`tb-save ${shown}`} title={title} onClick={() => void save()} disabled={busy} aria-label={`${label} — lưu ngay`}>
      <i className="tb-save-dot" />
      <span className="tb-hide-sm">{label}</span>
    </button>
  )
}

/**
 * Another tab/window saved (or deleted) this project after this tab opened it: this tab stopped autosaving so it
 * never overwrites the newer copy (persist.markStale). Not a save error — the way on is to reload.
 */
function StaleStatus() {
  const reload = () => {
    if (window.confirm('Tải lại trang để làm tiếp với bản mới nhất của dự án?\nCác thay đổi trong tab này sau lần lưu cuối sẽ không được giữ.')) {
      window.location.reload()
    }
  }
  return (
    <button
      type="button"
      className="tb-save stale"
      onClick={reload}
      title="Dự án này vừa được lưu (hoặc xoá) ở một tab/cửa sổ khác, nên tab này ngừng tự lưu để không ghi đè bản mới hơn. Bấm để tải lại trang và làm tiếp với bản mới nhất."
      aria-label="Đang mở ở tab khác — bấm để tải lại trang"
    >
      <RotateCw size={12} className="tb-save-icon" />
      <span className="tb-save-label">Đang mở ở tab khác</span>
    </button>
  )
}

/** Apple-style segmented control: equal segments, a raised thumb that slides to the selected one. */
function ViewSwitch() {
  const view = useUI((s) => s.view)
  const setView = useUI((s) => s.setView)
  const index = VIEWS.findIndex((v) => v.id === view)
  // ←/→ move between the views (tablist keyboard pattern); kept away from the canvas shortcuts.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    const next = (Math.max(0, index) + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length
    setView(VIEWS[next].id)
    e.currentTarget.querySelectorAll<HTMLButtonElement>('.tb-seg-btn')[next]?.focus()
  }
  return (
    <div
      className="tb-seg"
      role="tablist"
      aria-label="Chế độ xem"
      onKeyDown={onKeyDown}
      style={{ ['--seg-i' as string]: Math.max(0, index), ['--seg-n' as string]: VIEWS.length }}
    >
      {index >= 0 && <span className="tb-seg-thumb" aria-hidden="true" />}
      {VIEWS.map(({ id, label, key, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={view === id}
          tabIndex={view === id ? 0 : -1}
          className={`tb-seg-btn ${view === id ? 'active' : ''}`}
          onClick={() => setView(id)}
          title={`${label} (${key})`}
        >
          <Icon size={15} />
          <span className="tb-seg-label">{label}</span>
        </button>
      ))}
    </div>
  )
}

function HistoryButtons() {
  const past = useStore(useProject.temporal, (s) => s.pastStates.length)
  const future = useStore(useProject.temporal, (s) => s.futureStates.length)
  return (
    <div className="tb-history">
      <button type="button" className="icon-btn" onClick={() => undo()} disabled={!past} title={past ? `Hoàn tác (Ctrl+Z) · còn ${past} bước` : 'Không có gì để hoàn tác'} aria-label="Hoàn tác">
        <Undo2 size={16} />
      </button>
      <button type="button" className="icon-btn" onClick={() => redo()} disabled={!future} title={future ? 'Làm lại (Ctrl+Shift+Z)' : 'Không có gì để làm lại'} aria-label="Làm lại">
        <Redo2 size={16} />
      </button>
    </div>
  )
}

function RunningIndicator() {
  const active = useActiveCount()
  const processing = useRuns((s) => s.takes.reduce((n, t) => (t.status === 'processing' ? n + 1 : n), 0))
  // Another tab/window of this project runs the queue: this one only shows the progress (store/runs engine lock).
  const elsewhere = useRuns((s) => s.engineElsewhere)
  const setQueueOpen = useUI((s) => s.setQueueOpen)
  if (!active) return null
  const waiting = active - processing
  const where = elsewhere ? ' — hàng đợi đang chạy ở một tab/cửa sổ khác của dự án này, tab này chỉ hiển thị tiến độ' : ''
  return (
    <button
      type="button"
      className={`tb-running${elsewhere ? ' elsewhere' : ''}`}
      onClick={() => setQueueOpen(true)}
      title={`${processing} đang chạy · ${waiting} đang chờ${where}. Bấm để mở hàng đợi.`}
    >
      <Zap size={13} className="tb-running-icon" />
      <span>
        {/* `active` also counts queued jobs: only `processing` is really running. */}
        {processing ? `${processing} đang chạy` : `${waiting} đang chờ`}
        {processing > 0 && waiting > 0 && <span className="tb-hide-md"> · {waiting} chờ</span>}
        {elsewhere && <span className="tb-hide-md"> · tab khác</span>}
      </span>
    </button>
  )
}

/**
 * Warning shown only while the provider new takes use (development mode or canvasapp) reports a problem
 * (useRuns.providerIssue), e.g. the session expired. Opens Settings. Without a problem the credit pill
 * ("DEV 1.000 credit" / "canvasapp · 1.234 credit") already names the provider, so nothing extra is shown.
 */
function ProviderBadge() {
  // Subscribed so the badge follows the Settings choice; the bridge check inside activeProviderId() is static.
  useProviderPrefs((s) => s.provider)
  const issue = useRuns((s) => s.providerIssue)
  const openDialog = useUI((s) => s.openDialog)
  const id = activeProviderId()
  const problem = issue && issue.provider === id ? issue.message.trim().replace(/[.\s]+$/, '') || issue.code : null
  if (!problem) return null
  const title = `Video mới chạy qua ${PROVIDER_LABEL[id]} — đang gặp sự cố: ${problem}. Bấm để mở Cài đặt.`
  return (
    <button type="button" className="tb-provider issue" onClick={() => openDialog({ kind: 'settings' })} title={title} aria-label={title}>
      <TriangleAlert size={13} />
      {/* Icon only in narrower windows: the tooltip and aria-label carry the full text. */}
      <span className="tb-hide-md">Sự cố</span>
    </button>
  )
}

/**
 * Development mode only: the bug button that opens "Bảng phát triển" (faults, request log, simulated jobs). A small
 * count shows how many faults are armed on the simulated server, so a forgotten one never looks like a real bug.
 */
function DevButton() {
  useProviderPrefs((s) => s.provider)
  const armed = useDevServer((s) => activeFaultCount(s.snapshot))
  if (activeProviderId() !== 'dev') return null
  const title = armed
    ? `Bảng phát triển — đang bật ${armed} lỗi giả trên canvasapp giả lập. Bấm để xem / tắt.`
    : 'Bảng phát triển (chế độ Phát triển): trạng thái máy chủ giả lập, gây lỗi, nhật ký yêu cầu, job'
  return (
    <button type="button" className={`icon-btn tb-dev${armed ? ' armed' : ''}`} onClick={() => openDevPanel(armed ? 'faults' : undefined)} title={title} aria-label={title}>
      <Bug size={16} />
      {armed > 0 && <span className="tb-dev-n">{armed > 9 ? '9+' : armed}</span>}
    </button>
  )
}

/**
 * Number of scenes that have a finished take — i.e. `actions.chosenTakeIds().length` (★ take, else the newest
 * finished one). Selects primitives only, so the top bar does not re-render on every progress tick.
 */
function useChosenTakeCount(): number {
  const sceneKey = useProject((s) => s.project.scenes.map((x) => x.id).join('|'))
  return useRuns((s) => {
    if (!sceneKey) return 0
    const scenes = new Set(sceneKey.split('|'))
    const done = new Set<string>()
    for (const t of s.takes) if (t.status === 'completed' && scenes.has(t.sceneId)) done.add(t.sceneId)
    return done.size
  })
}

/** "Tải tất cả video chọn (.zip)": the chosen take of every scene in one zip (actions.downloadChosenTakesZip). */
function DownloadAllButton() {
  const count = useChosenTakeCount()
  const [busy, setBusy] = useState(false)
  const run = async () => {
    if (busy) return
    setBusy(true)
    try {
      await downloadChosenTakesZip()
    } catch (e) {
      toast(`Không tạo được file .zip: ${(e as Error).message}`, { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const title = busy
    ? 'Đang nén video…'
    : count
      ? `Tải tất cả video chọn (.zip) — take ★ (hoặc take mới nhất đã xong) của ${count} cảnh, kèm prompts.txt`
      : 'Tải tất cả video chọn (.zip) — chưa có video nào tạo xong'
  return (
    <button type="button" className="icon-btn tb-download" onClick={() => void run()} disabled={!count || busy} title={title} aria-label="Tải tất cả video chọn (.zip)">
      {busy ? <LoaderCircle size={16} className="tb-spin" /> : <Download size={16} />}
      {count > 0 && !busy && <span className="tb-download-n">{count > 99 ? '99+' : count}</span>}
    </button>
  )
}

const THEME_ICON: Record<ThemePref, LucideIcon> = { system: Monitor, light: Sun, dark: Moon }
/** Same order as useTheme.cycle(): Theo hệ thống → Sáng → Tối. */
const NEXT_THEME: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' }

/** Appearance: one button cycling Theo hệ thống → Sáng → Tối (the icon shows the current choice). */
function AppearanceButton() {
  const pref = useTheme((s) => s.pref)
  const cycle = useTheme((s) => s.cycle)
  const Icon = THEME_ICON[pref] ?? Monitor
  const title = `Giao diện: ${THEME_LABEL[pref]} — bấm để chuyển sang ${THEME_LABEL[NEXT_THEME[pref]]}`
  return (
    <button type="button" className="icon-btn tb-theme" onClick={cycle} title={title} aria-label={title}>
      <Icon size={16} />
    </button>
  )
}

function PanelToggles() {
  const leftOpen = useUI((s) => s.leftOpen)
  const rightOpen = useUI((s) => s.rightOpen)
  const setLeftOpen = useUI((s) => s.setLeftOpen)
  const setRightOpen = useUI((s) => s.setRightOpen)
  return (
    <div className="tb-panels">
      <button
        type="button"
        className={`icon-btn ${leftOpen ? 'active' : ''}`}
        onClick={() => setLeftOpen(!leftOpen)}
        title={leftOpen ? 'Ẩn thư viện' : 'Hiện thư viện'}
        aria-label="Bật/tắt thư viện"
      >
        {leftOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </button>
      <button
        type="button"
        className={`icon-btn ${rightOpen ? 'active' : ''}`}
        onClick={() => setRightOpen(!rightOpen)}
        title={rightOpen ? 'Ẩn bảng thuộc tính' : 'Hiện bảng thuộc tính'}
        aria-label="Bật/tắt bảng thuộc tính"
      >
        {rightOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
      </button>
    </div>
  )
}
