import {
  Clapperboard,
  Coins,
  FileInput,
  FolderOpen,
  Keyboard,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Redo2,
  Settings,
  Table2,
  Undo2,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { ViewMode } from '../../core/types'
import { flush, useSave } from '../../store/persist'
import { redo, undo, useProject } from '../../store/project'
import { useActiveCount, useRuns } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import './topbar.css'

const VIEWS: { id: ViewMode; label: string; key: string; icon: LucideIcon }[] = [
  { id: 'canvas', label: 'Canvas', key: '1', icon: Workflow },
  { id: 'table', label: 'Bảng cảnh', key: '2', icon: Table2 },
  { id: 'storyboard', label: 'Storyboard', key: '3', icon: LayoutGrid },
]

export function TopBar() {
  const openDialog = useUI((s) => s.openDialog)
  return (
    <header className="tb">
      <div className="tb-left">
        <div className="tb-brand" title="Bàn Dựng Phim — bản demo">
          <span className="tb-logo">
            <Clapperboard size={15} strokeWidth={2.2} />
          </span>
          <span className="tb-brand-text">Bàn Dựng</span>
        </div>
        <span className="tb-divider" />
        <ProjectName />
        <SaveStatus />
        <button className="btn btn-ghost btn-sm tb-projects" onClick={() => openDialog({ kind: 'projects' })} title="Danh sách dự án">
          <FolderOpen size={14} />
          <span className="tb-hide-sm">Dự án</span>
        </button>
      </div>

      <div className="tb-center">
        <ViewSwitch />
      </div>

      <div className="tb-right">
        <HistoryButtons />
        <RunningIndicator />
        <CreditPill />
        <button className="btn btn-sm tb-import" onClick={() => openDialog({ kind: 'import' })} title="Nhập prompt cũ (dán hoặc file .txt)">
          <FileInput size={14} />
          <span className="tb-hide-md">Nhập prompt</span>
        </button>
        <span className="tb-divider" />
        <button className="icon-btn" onClick={() => openDialog({ kind: 'settings' })} title="Cài đặt dự án & demo" aria-label="Cài đặt">
          <Settings size={16} />
        </button>
        <button className="icon-btn" onClick={() => openDialog({ kind: 'shortcuts' })} title="Phím tắt (?)" aria-label="Phím tắt">
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
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') setEditing(false)
        }}
        aria-label="Tên dự án"
      />
    )
  }
  return (
    <button className="tb-name" onClick={start} title="Bấm để đổi tên dự án">
      <span className="tb-name-text">{name}</span>
    </button>
  )
})

/** Autosave status; clicking saves right away (same as Ctrl+S). */
function SaveStatus() {
  const status = useSave((s) => s.status)
  const savedAt = useSave((s) => s.savedAt)
  const [busy, setBusy] = useState(false)
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

function ViewSwitch() {
  const view = useUI((s) => s.view)
  const setView = useUI((s) => s.setView)
  return (
    <div className="tb-seg" role="tablist" aria-label="Chế độ xem">
      {VIEWS.map(({ id, label, key, icon: Icon }) => (
        <button
          key={id}
          role="tab"
          aria-selected={view === id}
          className={`tb-seg-btn ${view === id ? 'active' : ''}`}
          onClick={() => setView(id)}
          title={`${label} (${key})`}
        >
          <Icon size={14} />
          <span className="tb-seg-label">{label}</span>
          <span className="tb-seg-key">{key}</span>
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
      <button className="icon-btn" onClick={() => undo()} disabled={!past} title={past ? `Hoàn tác (Ctrl+Z) · còn ${past} bước` : 'Không có gì để hoàn tác'} aria-label="Hoàn tác">
        <Undo2 size={16} />
      </button>
      <button className="icon-btn" onClick={() => redo()} disabled={!future} title={future ? 'Làm lại (Ctrl+Shift+Z)' : 'Không có gì để làm lại'} aria-label="Làm lại">
        <Redo2 size={16} />
      </button>
    </div>
  )
}

function RunningIndicator() {
  const active = useActiveCount()
  const processing = useRuns((s) => s.takes.reduce((n, t) => (t.status === 'processing' ? n + 1 : n), 0))
  const setQueueOpen = useUI((s) => s.setQueueOpen)
  if (!active) return null
  const waiting = active - processing
  return (
    <button
      className="tb-running"
      onClick={() => setQueueOpen(true)}
      title={`${processing} đang chạy · ${waiting} đang chờ — bấm để mở hàng đợi`}
    >
      <Zap size={13} className="tb-running-icon" />
      <span>
        {/* `active` also counts queued jobs: only `processing` is really running. */}
        {processing ? `${processing} đang chạy` : `${waiting} đang chờ`}
        {processing > 0 && waiting > 0 && ` · ${waiting} chờ`}
      </span>
    </button>
  )
}

function CreditPill() {
  const credits = useRuns((s) => s.credits)
  const spent = useRuns((s) => s.spent)
  const openDialog = useUI((s) => s.openDialog)
  return (
    <button
      className={`tb-credit ${credits < 20 ? 'low' : ''}`}
      onClick={() => openDialog({ kind: 'settings' })}
      title={`Credit demo — không tốn tiền thật. Đã dùng ${spent} credit. Bấm để nạp thêm.`}
    >
      <Coins size={13} />
      <b>{credits.toLocaleString('vi-VN')}</b>
      <span className="tb-hide-md">credit</span>
      <span className="tb-credit-demo">demo</span>
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
        className={`icon-btn ${leftOpen ? 'active' : ''}`}
        onClick={() => setLeftOpen(!leftOpen)}
        title={leftOpen ? 'Ẩn thư viện' : 'Hiện thư viện'}
        aria-label="Bật/tắt thư viện"
      >
        {leftOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </button>
      <button
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
