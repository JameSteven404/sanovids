// Custom edges: image references (asset -> scene), H3 first/last frames (asset -> scene),
// video references (take -> scene, @video_N), take outputs (scene -> take, not deletable) and wires into folder
// nodes: save (take -> folder) and autosave (scene -> folder, dashed).
// Each cuttable wire = its visible path (.cv-wire) + a wide transparent hit band on top (click-to-cut / select / hover,
// CanvasView.onWireClick). New wires draw themselves in once (wireFx.markFreshWires); cuts animate in Wires.tsx.
import { EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import { X } from 'lucide-react'
import { memo, useCallback, useEffect, useState, type AnimationEvent, type CSSProperties } from 'react'
import { announceWireCuts, isFolderEdge, parseEdgeId, takeLabel, videoLabel, type EdgeKind } from '../../actions'
import { sceneCode } from '../../core/compile'
import { folderMapOf } from '../../core/folders'
import { staleNoteSince } from '../../core/staleTokens'
import { motionLevel, useCanvasPrefs } from '../../lib/canvasPrefs'
import { undoToastAction, useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { assetMapOf, keepHover, sceneMapOf, scheduleHoverEnd, useCanvasLocal, withAlpha } from './canvasModel'
import { isFreshWire } from './wireFx'

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
 * goes through here (a click on the wire, the wire's ×, the × on a scene card avatar / @video thumb, a wire end dropped
 * on empty canvas). The prompt's @image_N / @video_N tokens are renumbered in the same step (SPEC §2): the toast says so
 * when it happened. 'out' wires (scene → its take) cannot be cut. `at` (screen point) is where the cut animation
 * splits the wire (default: its middle).
 */
export function cutEdge(id: string, silent = false, at?: { x: number; y: number }) {
  const e = parseEdgeId(id)
  if (!e || e.kind === 'out') return
  if (!silent) announceWireCuts([id], at)
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

/** Invisible hit band around every cuttable wire (px, flow units): thin wires stay easy to hit. */
export const WIRE_HIT_WIDTH = 16

/** The draw-in / fade-in lasts 0.34 s (wires.css); its class is dropped by then even if animationend never comes. */
const INTRO_FALLBACK_MS = 900

/** How a wire that just appeared comes in: drawn from its source (solid wires) or faded in; null = no effect. */
function wireIntro(id: string, kind: EdgeKind): 'draw' | 'fade' | null {
  if (!isFreshWire(id)) return null
  const level = motionLevel(useCanvasPrefs.getState().animations)
  if (level === 'off') return null
  return level === 'full' && kind !== 'out' && kind !== 'autosave' ? 'draw' : 'fade'
}

function LinkEdgeComponent({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<LinkEdge>) {
  const hovered = useCanvasLocal((s) => s.hoveredEdgeId === id)
  const clickToCut = useCanvasPrefs((s) => s.clickToCut)
  const kind = data?.kind ?? 'ref'
  // A wire that just appeared (new link, undo of a cut) animates in once — not one scrolled into view.
  const [intro, setIntro] = useState(() => wireIntro(id, kind))
  const endIntro = useCallback((e: AnimationEvent<SVGPathElement>) => {
    if (e.target === e.currentTarget) setIntro(null)
  }, [])
  // Safety net: a background tab does not run CSS animations, and a wire must never stay half drawn.
  useEffect(() => {
    if (!intro) return
    const t = setTimeout(() => setIntro(null), INTRO_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [intro])
  let ty = targetY
  // Wires arriving at the same scene handle are spread apart. A selected wire goes to the handle's center: that is
  // where its reconnect grip is (React Flow puts it at the unshifted end), and it is the only one that can be dragged.
  // Wires into a folder node (save / autosave) always converge on its dot: a folder collects many videos and a fan of
  // ends beside the dot reads as clutter.
  if ((kind === 'ref' || kind === 'vref') && data && data.count > 1 && !selected) {
    const off = (data.index - (data.count - 1) / 2) * 6
    ty = targetY + Math.max(-48, Math.min(48, off))
  }
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY: ty, targetPosition, curvature: 0.3 })
  const hl = !!data?.highlight || hovered || !!selected
  const base = KIND_STROKE[kind]

  if (kind === 'out') {
    // Subtle: the take was generated by this scene. Not selectable, not deletable, not cuttable.
    return (
      <path
        id={id}
        d={path}
        fill="none"
        className={`react-flow__edge-path cv-wire cv-wire-out${intro ? ' is-fading-in' : ''}`}
        style={{ stroke: hl ? 'var(--text-dim)' : base, strokeWidth: hl ? 1.5 : 1.25, strokeDasharray: '3 4', opacity: hl ? 0.9 : 0.5 }}
        onAnimationEnd={intro ? endIntro : undefined}
      />
    )
  }

  // Calm by default (DESIGN.md: thin 1.5px wires, theme-token colors); a wire touching the hovered / selected node
  // lights up, the hovered wire itself gets a soft glow, a selected wire is a little thicker with a stronger glow.
  const tint = kind === 'ref' ? (data?.color ?? base) : base
  const stroke = kind === 'ref' && hl && data?.color ? withAlpha(data.color, 0.75) : base
  const drawing = intro === 'draw'
  const style: CSSProperties = {
    stroke,
    strokeWidth: selected ? 2.5 : hovered ? 2.25 : hl ? 2 : 1.5,
    opacity: hl ? 1 : kind === 'vref' || kind === 'save' || kind === 'autosave' ? 0.65 : 0.45,
    // A scene's "tự lưu" wire stands for every future video: dashed, unlike a one-video "lưu" wire.
    strokeDasharray: kind === 'autosave' && !drawing ? '6 5' : undefined,
    filter: selected
      ? `drop-shadow(0 0 3px ${withAlpha(tint, 0.6)})`
      : hovered
        ? `drop-shadow(0 0 2.5px ${withAlpha(tint, 0.45)})`
        : undefined,
  }
  const cls = `react-flow__edge-path cv-wire${drawing ? ' is-drawing' : intro === 'fade' ? ' is-fading-in' : ''}`
  return (
    <>
      <path
        id={id}
        d={path}
        fill="none"
        className={cls}
        style={style}
        // Normalized length while drawing in: the dash animation then needs no measuring.
        pathLength={drawing ? 1 : undefined}
        onAnimationEnd={intro ? endIntro : undefined}
      />
      {/* Hit band on top (transparent): the whole band is the wire for hover, click-to-cut and selection. */}
      <path d={path} fill="none" className="react-flow__edge-interaction cv-wire-hit" strokeOpacity={0} strokeWidth={WIRE_HIT_WIDTH}>
        <title>{clickToCut ? 'Bấm để bỏ nối · Ctrl/Shift + bấm: chọn dây' : 'Bấm để chọn dây · Delete: bỏ nối'}</title>
      </path>
      {/* With click-to-cut the wire itself is the button; otherwise the × on hover / selection cuts it. */}
      {!clickToCut && (hovered || selected) && (
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
