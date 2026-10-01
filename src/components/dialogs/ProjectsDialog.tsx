import { Copy, FileUp, FolderOpen, Plus, Search, Sparkles, Trash } from 'lucide-react'
import { useRef, useState } from 'react'
import { createDemo, createProject, deleteProject, duplicateProject, importProjectFile, switchProject, useSave, type ProjectMeta } from '../../store/persist'
import { useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import './dialogs.css'

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

export function ProjectsDialog() {
  const closeDialog = useUI((s) => s.closeDialog)
  const projects = useSave((s) => s.projects)
  const currentId = useProject((s) => s.project.id)
  const currentName = useProject((s) => s.project.name)
  const currentScenes = useProject((s) => s.project.scenes.length)
  const [q, setQ] = useState('')
  const [newName, setNewName] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // The current project may not be in the index yet (first autosave pending): show it anyway.
  const list: ProjectMeta[] = projects.some((p) => p.id === currentId)
    ? projects.map((p) => (p.id === currentId ? { ...p, name: currentName, scenes: currentScenes } : p))
    : [{ id: currentId, name: currentName, scenes: currentScenes, updatedAt: Date.now() }, ...projects]
  const query = q.trim().toLowerCase()
  const shown = query ? list.filter((p) => p.name.toLowerCase().includes(query)) : list

  const open = (p: ProjectMeta) => {
    if (p.id !== currentId) {
      switchProject(p.id)
      toast(`Đã mở “${p.name}”.`, { tone: 'success' })
    }
    closeDialog()
  }

  const create = () => {
    const name = newName.trim() || 'Dự án mới'
    createProject(name)
    toast(`Đã tạo dự án “${name}”.`, { tone: 'success' })
    closeDialog()
  }

  const withBusy = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      toast(ok, { tone: 'success' })
      closeDialog()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Có lỗi xảy ra.', { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Dự án"
      onClose={closeDialog}
      size="wide"
      footer={
        <>
          <span className="dg-foot-info">Dự án lưu trong trình duyệt này. Xuất file trong Cài đặt để sao lưu.</span>
          <button className="btn" onClick={closeDialog}>
            Đóng
          </button>
        </>
      }
    >
      <div className="dg-projects">
        <div className="dg-projects-create">
          <div className="dg-new">
            <input
              className="input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              placeholder="Tên dự án mới…"
              maxLength={80}
            />
            <button className="btn btn-primary" onClick={create} disabled={busy}>
              <Plus size={14} /> Dự án trống
            </button>
          </div>
          <button className="btn" disabled={busy} onClick={() => withBusy(createDemo, 'Đã tạo dự án demo.')}>
            <Sparkles size={14} /> Dự án demo
          </button>
          <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            <FileUp size={14} /> Nhập file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void withBusy(() => importProjectFile(f), `Đã mở dự án từ “${f.name}”.`)
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
            return (
              <div key={p.id} className={`dg-project ${current ? 'current' : ''}`} onDoubleClick={() => open(p)}>
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
                {confirming ? (
                  <div className="dg-project-actions confirm">
                    <span>Xoá vĩnh viễn?</span>
                    <button className="btn btn-sm" onClick={() => setConfirmId(null)}>
                      Không
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        deleteProject(p.id)
                        setConfirmId(null)
                        toast(`Đã xoá “${p.name}”.`)
                      }}
                    >
                      <Trash size={12} /> Xoá
                    </button>
                  </div>
                ) : (
                  <div className="dg-project-actions">
                    <button className="btn btn-sm" onClick={() => open(p)} disabled={current}>
                      {current ? 'Đang mở' : 'Mở'}
                    </button>
                    <button
                      className="icon-btn"
                      title="Nhân bản"
                      aria-label={`Nhân bản ${p.name}`}
                      onClick={() => {
                        duplicateProject(p.id)
                        toast(`Đã nhân bản “${p.name}”.`, { tone: 'success' })
                      }}
                    >
                      <Copy size={14} />
                    </button>
                    <button className="icon-btn dg-danger-icon" title="Xoá dự án" aria-label={`Xoá ${p.name}`} onClick={() => setConfirmId(p.id)}>
                      <Trash size={14} />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          {!shown.length && <div className="empty">Không có dự án nào khớp “{q}”.</div>}
        </div>
      </div>
    </Modal>
  )
}
