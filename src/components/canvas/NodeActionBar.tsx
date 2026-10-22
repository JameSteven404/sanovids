// UI-03 (docs/UI-MUOT.md): a floating action bar above the ONE selected canvas node, like Magnific Spaces — the node's
// main commands within reach, "⋯" = that node's right-click menu (every other command). React Flow's NodeToolbar keeps
// it at the node's top edge at a fixed size whatever the zoom. Only existing commands: no logic of its own. Several
// items or wires selected: the toolbar's tray instead (ToolbarTray).
import { NodeToolbar, Position, useReactFlow } from '@xyflow/react'
import { Copy, Download, EyeOff, MoreHorizontal, Play, RotateCcw, Square, Star, Trash2 } from 'lucide-react'
import { memo, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { cancelTake, deleteSelection, downloadTakeOnce, duplicateSelection, requestRun, rerunTake } from '../../actions'
import { useProject } from '../../store/project'
import { isParkedTake, useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { openNodeMenu } from '../contextmenu/canvasContextMenu'
import { assetMapOf, sceneMapOf, takeIndexOf } from './canvasModel'
import { ensureRovingStop, ToolbarButton, toolbarArrowKey } from './ToolbarControls'

type Kind = 'scene' | 'take' | 'asset' | 'folder'

/** The only selected node's kind (null: none / several / not a node). */
function useSingleNode(): { id: string; kind: Kind } | null {
  const id = useUI((s) => (s.selectedIds.length === 1 ? s.selectedIds[0] : null))
  const projectKind = useProject((s) =>
    !id ? null : sceneMapOf(s.project.scenes).has(id) ? 'scene' : assetMapOf(s.project.assets).has(id) ? 'asset' : (s.project.folders ?? []).some((f) => f.id === id) ? 'folder' : null,
  )
  const isTake = useRuns((s) => !!id && takeIndexOf(s.takes).byId.has(id))
  const kind: Kind | null = projectKind ?? (isTake ? 'take' : null)
  return id && kind ? { id, kind } : null
}

/** What the take's buttons need, as primitives (stable selectors). */
function useTakeState(id: string | null) {
  const status = useRuns((s) => (id ? takeIndexOf(s.takes).byId.get(id)?.status : undefined))
  const starred = useRuns((s) => (id ? !!takeIndexOf(s.takes).byId.get(id)?.starred : false))
  const parked = useRuns((s) => {
    const t = id ? takeIndexOf(s.takes).byId.get(id) : undefined
    return !!t && isParkedTake(t)
  })
  return { status, starred, parked }
}

const Btn = ({ label, onClick, children, danger }: { label: string; onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void; children: ReactNode; danger?: boolean }) => (
  <ToolbarButton className={`cv-toolbar-button cv-node-bar-btn${danger ? ' cv-toolbar-danger' : ''}`} label={label} onClick={onClick}>
    {children}
  </ToolbarButton>
)

export const NodeActionBar = memo(function NodeActionBar() {
  const node = useSingleNode()
  const take = useTakeState(node?.kind === 'take' ? node.id : null)
  const rf = useReactFlow()
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    ensureRovingStop(ref.current, document.activeElement)
  })
  if (!node) return null
  const { id, kind } = node
  const more = (e: ReactMouseEvent<HTMLButtonElement>) => openNodeMenu(id, e.currentTarget.getBoundingClientRect(), (p) => rf.screenToFlowPosition(p))
  let buttons: ReactNode
  if (kind === 'scene') {
    buttons = (
      <>
        <Btn label="Chạy cảnh này (xem chi phí trước khi gửi)" onClick={() => requestRun([id])}>
          <Play size={15} />
          <span>Chạy</span>
        </Btn>
        <Btn label="Nhân bản cảnh" onClick={duplicateSelection}>
          <Copy size={15} />
        </Btn>
        <Btn label="Xoá cảnh…" onClick={deleteSelection} danger>
          <Trash2 size={15} />
        </Btn>
      </>
    )
  } else if (kind === 'take') {
    const running = take.status === 'queued' || take.status === 'processing'
    const ended = take.status === 'failed' || take.status === 'cancelled'
    buttons = (
      <>
        {take.status === 'completed' && (
          <>
            <Btn label={take.starred ? 'Bỏ chọn ★' : 'Chọn cho cảnh ★'} onClick={() => useRuns.getState().toggleStar(id)}>
              <Star size={15} fill={take.starred ? 'currentColor' : 'none'} />
            </Btn>
            <Btn label="Tải video" onClick={() => void downloadTakeOnce(id)}>
              <Download size={15} />
            </Btn>
          </>
        )}
        {ended && !take.parked && (
          <Btn label="Chạy lại…" onClick={() => rerunTake(id)}>
            <RotateCcw size={15} />
            <span>Chạy lại</span>
          </Btn>
        )}
        {running && !take.parked && (
          <Btn label="Huỷ" onClick={() => void cancelTake(id)}>
            <Square size={13} />
            <span>Huỷ</span>
          </Btn>
        )}
        <Btn label="Xoá video…" onClick={deleteSelection} danger>
          <Trash2 size={15} />
        </Btn>
      </>
    )
  } else {
    // An image tile only leaves the canvas (the picture stays in Thư viện); a folder node goes with its wires.
    buttons = (
      <Btn label={kind === 'asset' ? 'Ẩn khỏi canvas (ảnh vẫn ở Thư viện)' : 'Xoá thư mục khỏi canvas'} onClick={deleteSelection} danger={kind === 'folder'}>
        {kind === 'asset' ? <EyeOff size={15} /> : <Trash2 size={15} />}
      </Btn>
    )
  }
  return (
    // A take's name sits above its frame: the bar goes above that name.
    <NodeToolbar nodeId={id} isVisible position={Position.Top} offset={kind === 'take' ? 30 : 10}>
      <div ref={ref} className="cv-node-bar nodrag nopan" role="toolbar" aria-label="Thao tác với mục đang chọn" onKeyDown={toolbarArrowKey}>
        {buttons}
        <span className="cv-toolbar-sep" />
        <Btn label="Thao tác khác" onClick={more}>
          <MoreHorizontal size={15} />
        </Btn>
      </div>
    </NodeToolbar>
  )
})
