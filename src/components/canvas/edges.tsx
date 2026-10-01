// Custom edges: references (asset -> scene), continuity (scene -> scene), H3 first/last frames.
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import { X } from 'lucide-react'
import { memo } from 'react'
import { parseEdgeId, type EdgeKind } from '../../actions'
import { useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { keepHover, scheduleHoverEnd, useCanvasLocal, withAlpha } from './canvasModel'

export type LinkEdgeData = {
  kind: EdgeKind
  /** Position of this ref among the scene's on-canvas refs (spreads the wires at the target). */
  index: number
  count: number
  /** Asset color (ref / frame edges). */
  color: string
  /** Touches the hovered / selected node. */
  highlight: boolean
}
export type LinkEdge = Edge<LinkEdgeData>

const KIND_STROKE: Record<EdgeKind, string> = {
  ref: '#4fb6a8',
  seq: '#8d93a0',
  first: '#4cc38a',
  last: '#b48cff',
}

/** Cut one link (one undo step) and say so. */
export function cutEdge(id: string, silent = false) {
  const e = parseEdgeId(id)
  if (!e) return
  const p = useProject.getState()
  if (e.kind === 'ref') p.removeRef(e.to, e.from)
  else if (e.kind === 'seq') p.setContinueFrom(e.to, null)
  else p.setFrame(e.to, e.kind, null)
  const ui = useUI.getState()
  if (ui.selectedEdgeIds.includes(id)) ui.setSelectedEdges(ui.selectedEdgeIds.filter((x) => x !== id))
  useCanvasLocal.getState().setHoveredEdge(null)
  if (!silent) {
    const label = e.kind === 'ref' ? 'tham chiếu' : e.kind === 'seq' ? 'nối tiếp' : e.kind === 'first' ? 'khung đầu' : 'khung cuối'
    toast(`Đã bỏ nối ${label}.`, { action: { label: 'Hoàn tác', run: () => useProject.temporal.getState().undo() } })
  }
}

function LinkEdgeComponent({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<LinkEdge>) {
  const hovered = useCanvasLocal((s) => s.hoveredEdgeId === id)
  const kind = data?.kind ?? 'ref'
  let ty = targetY
  if (kind === 'ref' && data && data.count > 1) {
    const off = (data.index - (data.count - 1) / 2) * 6
    ty = targetY + Math.max(-48, Math.min(48, off))
  }
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY: ty, targetPosition, curvature: 0.3 })
  const hl = !!data?.highlight || hovered || !!selected
  const base = KIND_STROKE[kind]
  const stroke = kind === 'seq' ? (hl ? '#b5bac4' : base) : hl && data?.color ? withAlpha(data.color, 0.7) : base
  const style = {
    stroke,
    strokeWidth: selected ? 3 : hl ? 2.2 : 1.5,
    strokeDasharray: kind === 'seq' ? '6 5' : undefined,
    opacity: hl ? 1 : kind === 'seq' ? 0.7 : 0.45,
    filter: selected ? `drop-shadow(0 0 4px ${withAlpha(kind === 'seq' ? '#b5bac4' : (data?.color ?? base), 0.7)})` : undefined,
  }
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={18} />
      {(hovered || selected) && (
        <EdgeLabelRenderer>
          <button
            className="cv-edge-cut nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title="Bỏ nối (Delete)"
            aria-label="Bỏ nối"
            onMouseEnter={() => {
              keepHover()
              useCanvasLocal.getState().setHoveredEdge(id)
            }}
            onMouseLeave={() => scheduleHoverEnd(() => useUI.getState().setHovered(null), 180)}
            onClick={(e) => {
              e.stopPropagation()
              cutEdge(id)
            }}
          >
            <X size={12} strokeWidth={2.6} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const LinkEdgeView = memo(LinkEdgeComponent)

export const edgeTypes = {
  ref: LinkEdgeView,
  seq: LinkEdgeView,
  first: LinkEdgeView,
  last: LinkEdgeView,
}
