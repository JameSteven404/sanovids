// Folder node ("Thư mục"): a folder on the computer that finished videos are copied into (Project.folders).
// Wires into it: take → folder ('save': that video now, or when it finishes) and scene → folder ('autosave': every
// new video of the scene). Drag from its dot to a video or a scene, from a video's purple dot / a scene's right dot to
// it, or drop videos from the library on it. Memoized; reads its folder and runtime state (lib/saveFolders) itself.
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react'
import { CircleAlert, Folder, FolderCheck, FolderOpen, FolderSearch, KeyRound, LoaderCircle, Trash2 } from 'lucide-react'
import { memo, useEffect, useRef, useState, type DragEvent, type SyntheticEvent } from 'react'
import { folderMapOf, shortPath } from '../../core/folders'
import { chooseFolderPlace, grantFolderAccess, linkTakesToFolder, openFolderNode, refreshFolderNode, removeFolderNode } from '../../folderActions'
import { desktopFiles } from '../../lib/desktopFiles'
import { useFolderStatus, folderRuntime, type FolderRuntime } from '../../lib/saveFolders'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { hasTakeDrag, LOD_ZOOM, readTakeIds, sceneMapOf, takeIndexOf } from './canvasModel'
import './saving.css'

export type FolderFlowNode = Node<Record<string, unknown>, 'folder'>

/** Keep presses on the node's buttons away from node drag / selection / double-click. */
const stop = (e: SyntheticEvent) => e.stopPropagation()

function timeText(at: number): string {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  const hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
  return today ? hm : `${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })} ${hm}`
}

/** How many ids of a link list are in `live`. */
function liveCount(ids: readonly string[] | undefined, live: ReadonlyMap<string, unknown>): number {
  let n = 0
  for (const x of ids ?? []) if (live.has(x)) n++
  return n
}

/** One status line under the name: what the folder needs, or what was saved. */
function statusOf(rt: FolderRuntime, hasPath: boolean): { tone: 'ok' | 'warn' | 'error' | 'muted' | 'busy'; text: string } {
  if (rt.busy) return { tone: 'busy', text: 'Đang lưu…' }
  const waiting = rt.pending ? ` · ${rt.pending} video chờ lưu` : ''
  switch (rt.access) {
    case 'checking':
      return { tone: 'muted', text: 'Đang kiểm tra thư mục…' }
    case 'unsupported':
      return { tone: 'warn', text: 'Trình duyệt này không ghi được vào thư mục (dùng Chrome / Edge hoặc app desktop)' }
    case 'pick':
      return { tone: 'warn', text: (hasPath ? 'Thư mục chưa được chọn trên máy này' : 'Chưa chọn thư mục') + waiting }
    case 'missing':
      return { tone: 'warn', text: 'Không tìm thấy thư mục (đã đổi tên hoặc xoá?)' + waiting }
    case 'ask':
      return { tone: 'warn', text: 'Cần cấp lại quyền ghi vào thư mục' + waiting }
  }
  if (rt.error) return { tone: 'error', text: rt.error }
  if (!rt.saved) return { tone: 'muted', text: 'Chưa lưu video nào' }
  return { tone: 'ok', text: `Đã lưu ${rt.saved} video${rt.lastAt ? ` · lần cuối ${timeText(rt.lastAt)}` : ''}` }
}

function FolderNodeView({ id, selected }: NodeProps<FolderFlowNode>) {
  const folder = useProject((s) => folderMapOf(s.project.folders).get(id))
  // Links that are drawn: only videos / scenes that still exist (a number, so a stable selector result).
  const autoN = useProject((s) => liveCount(folder?.autoScenes, sceneMapOf(s.project.scenes)))
  const takeN = useRuns((s) => liveCount(folder?.takes, takeIndexOf(s.takes).byId))
  const stored = useFolderStatus((s) => s.byId[id])
  const far = useStore((s) => s.transform[2] < LOD_ZOOM)
  const takeDrag = useUI((s) => !!s.draggingTakeIds)
  const [drop, setDrop] = useState(false)
  const [busyAction, setBusyAction] = useState(false)
  const depth = useRef(0)
  const path = folder?.path ?? null

  // Can we write there (now, and whenever the node is pointed at another folder)? Saves still waiting (also from
  // before a reload / restart) are written as soon as it can.
  useEffect(() => {
    void refreshFolderNode(id)
  }, [id, path])

  // A cancelled drop may skip dragleave: reset when any drag ends.
  useEffect(() => {
    if (!drop) return
    const reset = () => {
      depth.current = 0
      setDrop(false)
    }
    window.addEventListener('dragend', reset, true)
    window.addEventListener('drop', reset, true)
    return () => {
      window.removeEventListener('dragend', reset, true)
      window.removeEventListener('drop', reset, true)
    }
  }, [drop])

  if (!folder) return null
  const rt = stored ?? folderRuntime(id)
  const desktop = !!desktopFiles()
  const status = statusOf(rt, !!path)
  const links = [autoN && `tự lưu ${autoN} cảnh`, takeN && `${takeN} video đã nối`].filter(Boolean).join(' · ')
  const needsPick = rt.access === 'pick' || rt.access === 'missing'
  const needsGrant = rt.access === 'ask'

  /** Run a button's command once at a time (the pickers are async). */
  const run = (fn: () => Promise<unknown>) => {
    if (busyAction) return
    setBusyAction(true)
    void fn().finally(() => setBusyAction(false))
  }

  const onDragEnter = (e: DragEvent) => {
    if (!hasTakeDrag(e.dataTransfer)) return
    e.preventDefault()
    depth.current++
    setDrop(true)
  }
  const onDragOver = (e: DragEvent) => {
    if (!hasTakeDrag(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: DragEvent) => {
    if (!hasTakeDrag(e.dataTransfer)) return
    depth.current = Math.max(0, depth.current - 1)
    if (!depth.current) setDrop(false)
  }
  const onDrop = (e: DragEvent) => {
    if (!hasTakeDrag(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    depth.current = 0
    setDrop(false)
    const ids = readTakeIds(e.dataTransfer)
    useUI.getState().setDraggingTakes(null)
    if (ids.length) linkTakesToFolder(ids, id)
  }

  const Icon = rt.busy ? LoaderCircle : status.tone === 'ok' ? FolderCheck : Folder
  const cls = [
    'cv-folder',
    selected && 'is-selected',
    far && 'is-far',
    drop && 'is-drop',
    takeDrag && 'is-drop-target',
    (needsPick || needsGrant || rt.access === 'unsupported') && 'needs-attention',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="cv-folder-head">
        <span className={`cv-folder-icon tone-${status.tone}`} aria-hidden>
          <Icon size={far ? 30 : 17} strokeWidth={1.75} className={rt.busy ? 'cv-spin' : undefined} />
        </span>
        <span className="cv-folder-titles">
          <span className="cv-folder-name" title={folder.name}>
            {folder.name}
          </span>
          {!far && (
            <span className={`cv-folder-path${path ? '' : ' is-plain'}`} title={path ?? undefined}>
              {path ? shortPath(path) : desktop ? 'Chưa chọn thư mục trên máy này' : 'Thư mục trên máy (đã cấp cho trình duyệt)'}
            </span>
          )}
        </span>
        {!far && (
          <button
            className="cv-folder-x nodrag nopan"
            title="Bỏ thư mục này khỏi canvas (file đã lưu vẫn còn) — Delete"
            aria-label="Bỏ thư mục khỏi canvas"
            onPointerDown={stop}
            onDoubleClick={stop}
            onClick={(e) => {
              e.stopPropagation()
              removeFolderNode(id)
            }}
          >
            <Trash2 size={13} strokeWidth={1.75} />
          </button>
        )}
      </div>

      {!far && (
        <>
          <div className={`cv-folder-status tone-${status.tone}`} title={status.text}>
            {(status.tone === 'warn' || status.tone === 'error') && <CircleAlert size={12} strokeWidth={2} aria-hidden />}
            <span>{status.text}</span>
          </div>
          <div className="cv-folder-links">{links || 'Kéo dây từ video (chấm tím) hoặc từ cảnh vào đây để lưu'}</div>
          <div className="cv-folder-actions nodrag nopan" onPointerDown={stop} onDoubleClick={stop}>
            {needsGrant ? (
              <button
                className="cv-folder-btn primary"
                disabled={busyAction}
                title="Trình duyệt hỏi lại quyền sau mỗi lần mở lại: cho phép SanoVids ghi vào thư mục này"
                onClick={(e) => {
                  e.stopPropagation()
                  run(() => grantFolderAccess(id))
                }}
              >
                <KeyRound size={13} strokeWidth={2} />
                <span>Cấp lại quyền</span>
              </button>
            ) : needsPick || !desktop ? (
              <button
                className={`cv-folder-btn${needsPick ? ' primary' : ''}`}
                disabled={busyAction || rt.access === 'unsupported'}
                title={needsPick ? 'Chọn lại thư mục để lưu video vào đó' : 'Chọn thư mục khác cho nút này'}
                onClick={(e) => {
                  e.stopPropagation()
                  run(() => chooseFolderPlace(id))
                }}
              >
                <FolderSearch size={13} strokeWidth={2} />
                <span>{needsPick ? 'Chọn lại thư mục' : 'Đổi thư mục'}</span>
              </button>
            ) : (
              <button
                className="cv-folder-btn"
                disabled={rt.access !== 'ok'}
                title={path ? `Mở ${path} trong File Explorer` : 'Chưa chọn thư mục'}
                onClick={(e) => {
                  e.stopPropagation()
                  void openFolderNode(id)
                }}
              >
                <FolderOpen size={13} strokeWidth={2} />
                <span>Mở thư mục</span>
              </button>
            )}
            {desktop && !needsPick && (
              <button
                className="cv-folder-btn is-icon"
                disabled={busyAction || rt.access === 'unsupported'}
                title="Đổi sang thư mục khác (video đã lưu vẫn ở thư mục cũ)"
                aria-label="Đổi thư mục"
                onClick={(e) => {
                  e.stopPropagation()
                  run(() => chooseFolderPlace(id))
                }}
              >
                <FolderSearch size={14} strokeWidth={2} />
              </button>
            )}
          </div>
        </>
      )}

      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className="cv-h cv-h-folder"
        title="Nối video hoặc cảnh vào đây để lưu · kéo từ đây tới một video / một cảnh"
      />
    </div>
  )
}

export const FolderNode = memo(FolderNodeView)
