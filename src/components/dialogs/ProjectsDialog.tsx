import { Copy, FileUp, FolderOpen, LoaderCircle, Plus, Search, Sparkles, Trash } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { createDemo, createProject, deleteProject, duplicateProject, importProjectFile, switchProject, useSave, type ProjectMeta } from '../../store/persist'
import { useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import './dialogs.css'
import { errorText } from './shared'

const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat('vi', { numeric: 'auto' }) : null

function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.round((ts - now) / 1000)
  const abs = Math.abs(diff)
  if (abs < 45) return 'vừa xong'
  if (!rtf) return new Date(ts).toLocaleString('vi-VN')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
  return new Date(ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

type JobKind = 'open' | 'create' | 'demo' | 'import' | 'duplicate' | 'delete'
interface Job {
  kind: JobKind
  id?: string
}

const Spin = () => <LoaderCircle size={14} className="dg-spin" />

export function ProjectsDialog() {
  const closeDialog = useUI((s) => s.closeDialog)
  const projects = useSave((s) => s.projects)
  const currentId = useProject((s) => s.project.id)
  const currentName = useProject((s) => s.project.name)
  const currentScenes = useProject((s) => s.project.scenes.length)
  const [q, setQ] = useState('')
  const [newName, setNewName] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Job | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // The current project may not be in the index yet (first autosave pending): show it anyway.
  const list: ProjectMeta[] = projects.some((p) => p.id === currentId)
    ? projects.map((p) => (p.id === currentId ? { ...p, name: currentName, scenes: currentScenes } : p))
    : [{ id: currentId, name: currentName, scenes: currentScenes, updatedAt: Date.now() }, ...projects]
  const query = q.trim().toLowerCase()
  const shown = query ? list.filter((p) => p.name.toLowerCase().includes(query)) : list

  /** Run one persistence job at a time; `done` returns the success toast (or null when nothing happened). */
  const run = async (job: Job, fn: () => Promise<void>, done: () => string | null, close: boolean) => {
    if (busy) return
    setBusy(job)
    try {
      await fn()
      const ok = done()
      if (ok) {
        toast(ok, { tone: 'success' })
        if (close) closeDialog()
      }
    } catch (e) {
      toast(errorText(e), { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }
  const is = (kind: JobKind, id?: string) => busy?.kind === kind && (id === undefined || busy.id === id)

  const open = (p: ProjectMeta) => {
    if (p.id === currentId) {
      closeDialog()
      return
    }
    // switchProject reports its own error (and keeps the current project) when the project cannot be read.
    void run({ kind: 'open', id: p.id }, () => switchProject(p.id), () => (useProject.getState().project.id === p.id ? `Đã mở “${p.name}”.` : null), true)
  }

  const create = () => {
    const name = newName.trim() || 'Dự án mới'
    void run({ kind: 'create' }, () => createProject(name), () => `Đã tạo dự án “${name}”.`, true)
  }

  return (
    <Modal
      title="Dự án"
      onClose={closeDialog}
      size="wide"
      footer={
        <>
          <span className="dg-foot-info">{busy ? 'Đang lưu và chuyển dự án…' : 'Dự án lưu trên máy này. Xuất file trong Cài đặt để sao lưu.'}</span>
          <button className="btn" onClick={closeDialog}>
            Đóng
          </button>
        </>
      }
    >
      <div className="dg-projects" aria-busy={!!busy}>
        <div className="dg-projects-create">
          <div className="dg-new">
            <input
              className="input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && create()}
              placeholder="Tên dự án mới…"
              maxLength={80}
            />
            <button className="btn btn-primary" onClick={create} disabled={!!busy}>
              {is('create') ? <Spin /> : <Plus size={14} />} Dự án trống
            </button>
          </div>
          <button className="btn" disabled={!!busy} onClick={() => void run({ kind: 'demo' }, createDemo, () => 'Đã tạo dự án demo.', true)}>
            {is('demo') ? <Spin /> : <Sparkles size={14} />} Dự án demo
          </button>
          <button className="btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>
            {is('import') ? <Spin /> : <FileUp size={14} />} Nhập file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void run({ kind: 'import' }, () => importProjectFile(f), () => `Đã mở dự án từ “${f.name}”.`, true)
            }}
          />
        </div>

        <div className="dg-label-row">
          <span className="section-title">{list.length} dự án</span>
          {list.length > 6 && (
            <label className="dg-search">
              <Search size={13} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm dự án…" />
            </label>
          )}
        </div>

        <div className="dg-project-list">
          {shown.map((p) => {
            const current = p.id === currentId
            const confirming = confirmId === p.id
            let actions: ReactNode
            if (confirming) {
              actions = (
                <div className="dg-project-actions confirm">
                  <span>Xoá vĩnh viễn?</span>
                  <button className="btn btn-sm" disabled={!!busy} onClick={() => setConfirmId(null)}>
                    Không
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={!!busy}
                    onClick={() =>
                      void run(
                        { kind: 'delete', id: p.id },
                        () => deleteProject(p.id),
                        () => {
                          setConfirmId(null)
                          return `Đã xoá “${p.name}”.`
                        },
                        false,
                      )
                    }
                  >
                    {is('delete', p.id) ? <LoaderCircle size={12} className="dg-spin" /> : <Trash size={12} />} Xoá
                  </button>
                </div>
              )
            } else {
              actions = (
                <div className="dg-project-actions">
                  <button className="btn btn-sm" onClick={() => open(p)} disabled={current || !!busy}>
                    {is('open', p.id) ? <LoaderCircle size={12} className="dg-spin" /> : null}
                    {current ? 'Đang mở' : is('open', p.id) ? 'Đang mở…' : 'Mở'}
                  </button>
                  <button
                    className="icon-btn"
                    title="Nhân bản"
                    aria-label={`Nhân bản ${p.name}`}
                    disabled={!!busy}
                    onClick={() => void run({ kind: 'duplicate', id: p.id }, () => duplicateProject(p.id), () => `Đã nhân bản “${p.name}”.`, false)}
                  >
                    {is('duplicate', p.id) ? <Spin /> : <Copy size={14} />}
                  </button>
                  <button
                    className="icon-btn dg-danger-icon"
                    title="Xoá dự án"
                    aria-label={`Xoá ${p.name}`}
                    disabled={!!busy}
                    onClick={() => setConfirmId(p.id)}
                  >
                    <Trash size={14} />
                  </button>
                </div>
              )
            }
            return (
              <div key={p.id} className={`dg-project ${current ? 'current' : ''}`} onDoubleClick={() => !busy && open(p)}>
                <div className="dg-project-icon">
                  <FolderOpen size={16} />
                </div>
                <div className="dg-project-info">
                  <div className="dg-project-name">
                    <span className="dg-ellipsis">{p.name}</span>
                    {current && <span className="badge accent">Đang mở</span>}
                  </div>
                  <div className="dg-project-meta">
                    {p.scenes} cảnh · cập nhật {relativeTime(p.updatedAt)}
                  </div>
                </div>
                {actions}
              </div>
            )
          })}
          {!shown.length && <div className="empty">Không có dự án nào khớp “{q}”.</div>}
        </div>
      </div>
    </Modal>
  )
}
