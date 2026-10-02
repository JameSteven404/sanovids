// Custom edges: image references (asset -> scene), H3 first/last frames (asset -> scene),
// video references (take -> scene, @video_N), take outputs (scene -> take, not deletable) and wires into folder
// nodes: save (take -> folder) and autosave (scene -> folder, dashed).
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import { X } from 'lucide-react'
import { memo } from 'react'
import { isFolderEdge, parseEdgeId, takeLabel, videoLabel, type EdgeKind } from '../../actions'
import { sceneCode } from '../../core/compile'
import { folderMapOf } from '../../core/folders'
import { staleNoteSince } from '../../core/staleTokens'
import { undoToastAction, useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { assetMapOf, keepHover, sceneMapOf, scheduleHoverEnd, useCanvasLocal, withAlpha } from './canvasModel'

export type LinkEdgeData = {
  kind: EdgeKind
  /** Position of this wire among the wires arriving at the scene's left handle (spreads them at the target). */
  index: number
  count: number
  /** Asset color (ref / frame edges). */
  color: string
  /** Touches the hovered / selected node. */
  highlight: boolean
}
export type LinkEdge = Edge<LinkEdgeData>

/** Purple of video wires / handles: the theme token (light and dark themes define their own value). */
export const VIDEO_COLOR = 'var(--video)'

/** Wire colors are theme tokens (styles/base.css), so they follow the light / dark theme. */
const KIND_STROKE: Record<EdgeKind, string> = {
  ref: 'var(--ref)',
  first: 'var(--first)',
  last: 'var(--last)',
  vref: VIDEO_COLOR,
  out: 'var(--seq)',
  save: 'var(--save)',
  autosave: 'var(--save)',
}

const CUT_LABEL: Record<EdgeKind, string> = {
  ref: 'tham chiếu ảnh',
  first: 'khung đầu',
  last: 'khung cuối',
  vref: 'video tham chiếu',
  out: '',
  save: 'lưu',
  autosave: 'tự lưu',
}

/**
 * Cut one link (one undo step) and say so — naming what was cut, with Undo. Every canvas way of removing a reference
 * goes through here (the wire's ×, the × on a scene card avatar / @video thumb, a wire end dropped on empty canvas).
 * The prompt's @image_N / @video_N tokens are renumbered in the same step (SPEC §2): the toast says so when it happened.
 * 'out' wires (scene → its take) cannot be cut.
 */
export function cutEdge(id: string, silent = false) {
  const e = parseEdgeId(id)
  if (!e || e.kind === 'out') return
  if (isFolderEdge(e.kind)) {
    cutFolderEdge(id, e.kind, e.from, e.to, silent)
    return
  }
  const p = useProject.getState()
  const projectBefore = p.project
  const before = sceneMapOf(p.project.scenes).get(e.to)
  if (!before) return
  const what = e.kind === 'vref' ? takeLabel(e.from) : assetMapOf(p.project.assets).get(e.from)?.name
  if (e.kind === 'ref') p.removeRef(e.to, e.from)
  else if (e.kind === 'vref') p.removeVideoRef(e.to, e.from, videoLabel(e.from))
  else p.setFrame(e.to, e.kind, null)
  const after = sceneMapOf(useProject.getState().project.scenes).get(e.to)
  const ui = useUI.getState()
  if (ui.selectedEdgeIds.includes(id)) ui.setSelectedEdges(ui.selectedEdgeIds.filter((x) => x !== id))
  useCanvasLocal.getState().setHoveredEdge(null)
  if (silent) return
  const renumbered = !!after && after.prompt !== before.prompt
  // Renumbering off: the prompt kept its numbers, which may now name another picture — say where to fix them.
  const stale = staleNoteSince(projectBefore, useProject.getState().project)
  toast(`Đã bỏ nối ${CUT_LABEL[e.kind]}${what ? ` ${what}` : ''} khỏi ${sceneCode(before.order)}${renumbered ? ' — đã đánh lại số trong prompt' : ''}${stale}.`, {
    action: undoToastAction(),
    ...(stale ? { tone: 'warning' as const, ms: 8000 } : {}),
  })
}

/** Cut a wire into a folder node (one undo step). The files already saved there stay. */
function cutFolderEdge(id: string, kind: 'save' | 'autosave', from: string, folderId: string, silent: boolean) {
  const p = useProject.getState()
  const folder = folderMapOf(p.project.folders).get(folderId)
  if (!folder) return
  p.unlinkFolder(folderId, kind, from)
  const ui = useUI.getState()
  if (ui.selectedEdgeIds.includes(id)) ui.setSelectedEdges(ui.selectedEdgeIds.filter((x) => x !== id))
  useCanvasLocal.getState().setHoveredEdge(null)
  if (silent) return
  const scene = kind === 'autosave' ? sceneMapOf(p.project.scenes).get(from) : undefined
  const what = kind === 'autosave' ? (scene ? sceneCode(scene.order) : 'cảnh') : takeLabel(from)
  toast(
    kind === 'autosave'
      ? `Đã bỏ tự lưu ${what} vào “${folder.name}” (video đã lưu vẫn còn trong thư mục).`
      : `Đã bỏ nối ${what} khỏi thư mục “${folder.name}” (file đã lưu vẫn còn).`,
    { action: undoToastAction() },
  )
}

function LinkEdgeComponent({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<LinkEdge>) {
  const hovered = useCanvasLocal((s) => s.hoveredEdgeId === id)
  const kind = data?.kind ?? 'ref'
  let ty = targetY
  // Wires arriving at the same handle are spread apart. A selected wire goes to the handle's center: that is where
  // its reconnect grip is (React Flow puts it at the unshifted end), and it is the only one that can be dragged.
  if ((kind === 'ref' || kind === 'vref' || kind === 'save' || kind === 'autosave') && data && data.count > 1 && !selected) {
    const off = (data.index - (data.count - 1) / 2) * 6
    ty = targetY + Math.max(-48, Math.min(48, off))
  }
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY: ty, targetPosition, curvature: 0.3 })
  const hl = !!data?.highlight || hovered || !!selected
  const base = KIND_STROKE[kind]

  if (kind === 'out') {
    // Subtle: the take was generated by this scene. Not selectable, not deletable.
    return (
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={0}
        style={{ stroke: hl ? 'var(--text-dim)' : base, strokeWidth: hl ? 1.5 : 1.25, strokeDasharray: '3 4', opacity: hl ? 0.9 : 0.5 }}
      />
    )
  }

  // Calm by default (DESIGN.md: thin 1.5px wires, theme-token colors); a wire touching the hovered / selected node
  // lights up, a selected wire is a little thicker with a soft glow.
  const stroke = kind === 'ref' && hl && data?.color ? withAlpha(data.color, 0.75) : base
  const style = {
    stroke,
    strokeWidth: selected ? 2.5 : hl ? 2 : 1.5,
    opacity: hl ? 1 : kind === 'vref' || kind === 'save' || kind === 'autosave' ? 0.65 : 0.45,
    // A scene's "tự lưu" wire stands for every future video: dashed, unlike a one-video "lưu" wire.
    strokeDasharray: kind === 'autosave' ? '6 5' : undefined,
    strokeLinecap: 'round' as const,
    transition: 'opacity 0.15s ease-out, stroke-width 0.15s ease-out',
    filter: selected ? `drop-shadow(0 0 3px ${withAlpha(kind === 'ref' ? (data?.color ?? base) : base, 0.6)})` : undefined,
  }
  return (
    <>
      <BaseEdge id={id} path={path} style={style} interactionWidth={18} />
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
            <X size={12} strokeWidth={2.4} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const LinkEdgeView = memo(LinkEdgeComponent)

export const edgeTypes = {
  ref: LinkEdgeView,
  first: LinkEdgeView,
  last: LinkEdgeView,
  vref: LinkEdgeView,
  out: LinkEdgeView,
  save: LinkEdgeView,
  autosave: LinkEdgeView,
}
