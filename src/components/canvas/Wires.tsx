// Wire effects on the canvas:
// - WireConnectionLine: the line drawn while a wire is dragged (React Flow connectionLineComponent). Bezier in the
//   source's color with a soft glow and dashes marching toward the pointer; over a card that accepts it the end snaps to
//   the handle it will land on and the line turns solid ("valid"); over a card that refuses it, it turns grey ("invalid").
// - WireCutLayer: the cut animation. On WIRES_CUT_EVENT (actions.announceWireCuts, sent BEFORE the store change) it
//   copies the cut wires' drawn paths into a light overlay that removes itself: the wire splits where it was clicked
//   and both halves retract to their cards ('full'), or simply fades ('reduced'). Nothing blocks the store update.
// Both read the canvas animation pref (lib/canvasPrefs.ts) and the OS "reduce motion" setting.
import {
  EdgeLabelRenderer,
  Position,
  useReactFlow,
  useStoreApi,
  type ConnectionLineComponentProps,
  type Node,
} from '@xyflow/react'
import { useEffect, useState, type CSSProperties } from 'react'
import { canvasEvents, WIRES_CUT_EVENT, type WireCutDetail } from '../../actions'
import { motionLevel, useCanvasPrefs, useMotionLevel, type MotionLevel } from '../../lib/canvasPrefs'
import { useRuns } from '../../store/runs'
import { takeIndexOf } from './canvasModel'
import { isWireReconnecting, pickNodeAt, snapHandleFor, splitWirePath, wireDragColor, wirePath, wireVerdict, type Pt, type WireSource, type WireSourceType } from './wireFx'

const SOURCE_TYPES: readonly string[] = ['asset', 'take', 'scene', 'folder']

/** Line drawn while dragging a wire (also while dragging a wire's end to reconnect it). */
export function WireConnectionLine({
  fromNode,
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  toHandle,
  connectionStatus,
}: ConnectionLineComponentProps<Node>) {
  const store = useStoreApi()
  const motion = useMotionLevel()
  const type = SOURCE_TYPES.includes(fromNode.type ?? '') ? (fromNode.type as WireSourceType) : 'asset'
  let end: Pt = { x: toX, y: toY }
  let endPos: Position = toPosition
  let state: 'valid' | 'invalid' | 'idle'
  if (toHandle) {
    // React Flow snapped to a handle within its connection radius: its verdict (isValidConnection) decides.
    state = connectionStatus === 'valid' ? 'valid' : 'invalid'
  } else {
    // Released anywhere on a card also links (onConnectEnd hit-tests the card): judge the card under the pointer.
    const over = pickNodeAt(store.getState().nodeLookup.values(), end, fromNode.id)
    const src: WireSource = { type, id: fromNode.id, reconnect: isWireReconnecting() }
    if (type === 'take') {
      const take = takeIndexOf(useRuns.getState().takes).byId.get(fromNode.id)
      src.takeReady = take?.status === 'completed'
      src.takeSceneId = take?.sceneId ?? null
    }
    state = wireVerdict(src, over)
    // Valid: the end jumps to the dot the wire will be drawn to — a magnet that shows where it lands (handles are 0×0
    // anchors at the dot centers, so this is where the dropped wire ends too).
    const snap = over && state === 'valid' ? snapHandleFor(type, over.type) : null
    const bounds = snap ? over?.internals.handleBounds?.[snap.type]?.find((h) => h.id === snap.id) : undefined
    if (over && bounds) {
      const p = over.internals.positionAbsolute
      end = { x: p.x + bounds.x + bounds.width / 2, y: p.y + bounds.y + bounds.height / 2 }
      endPos = bounds.position
    }
  }
  const [path] = wirePath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: end.x, targetY: end.y, targetPosition: endPos })
  const style = { '--cl': wireDragColor(fromNode.type, toHandle?.id) } as CSSProperties
  return (
    <g className={`cv-cl is-${state}${motion === 'full' ? ' is-moving' : ''}`} style={style}>
      <path className="cv-cl-glow" d={path} />
      <path className="cv-cl-line" d={path} />
      <circle className="cv-cl-ring" cx={end.x} cy={end.y} r={9} />
      <circle className="cv-cl-dot" cx={end.x} cy={end.y} r={3.5} />
    </g>
  )
}

// ---------------------------------------------------------------- cut animation
interface Ghost {
  key: number
  level: Exclude<MotionLevel, 'off'>
  /** Whole wire (fade) — or the two halves of the split (retract). */
  d: string
  split: ReturnType<typeof splitWirePath>
  stroke: string
  width: number
}

/** Life of a ghost per level (the CSS animations in wires.css last this long). */
const GHOST_MS = { full: 300, reduced: 160 } as const
/** A Delete of a big selection: animate this many wires at most. */
const MAX_GHOSTS = 24
let ghostSeq = 0

const cssEscape = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'))

/** Overlay of the wires being cut (in the edge-label layer: above the wires, below the cards). */
export function WireCutLayer() {
  const rf = useReactFlow()
  const store = useStoreApi()
  const [ghosts, setGhosts] = useState<Ghost[]>([])

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const onCut = (e: Event) => {
      const { ids, at } = (e as CustomEvent<WireCutDetail>).detail ?? { ids: [] }
      const level = motionLevel(useCanvasPrefs.getState().animations)
      const root = store.getState().domNode
      if (level === 'off' || !root || !ids?.length) return
      // The exact point (the canvas snaps positions to its grid by default).
      const flowAt = at ? rf.screenToFlowPosition(at, { snapToGrid: false }) : null
      const made: Ghost[] = []
      for (const id of ids.slice(0, MAX_GHOSTS)) {
        const el = root.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${cssEscape(id)}"] .cv-wire`)
        const d = el?.getAttribute('d')
        if (!el || !d) continue // not drawn (off-screen, hidden by the wire mode…): nothing to animate
        made.push({
          key: ++ghostSeq,
          level,
          d,
          split: level === 'full' ? splitWirePath(d, ids.length === 1 ? flowAt : null) : null,
          stroke: el.style.stroke || 'var(--text-faint)',
          width: parseFloat(el.style.strokeWidth) || 1.5,
        })
      }
      if (!made.length) return
      setGhosts((g) => g.concat(made))
      const keys = new Set(made.map((m) => m.key))
      const timer = setTimeout(() => {
        timers.delete(timer)
        setGhosts((g) => g.filter((x) => !keys.has(x.key)))
      }, GHOST_MS[level] + 80)
      timers.add(timer)
    }
    canvasEvents.addEventListener(WIRES_CUT_EVENT, onCut)
    return () => {
      canvasEvents.removeEventListener(WIRES_CUT_EVENT, onCut)
      timers.forEach(clearTimeout)
    }
  }, [rf, store])

  if (!ghosts.length) return null
  return (
    <EdgeLabelRenderer>
      <svg className="cv-cut-layer" aria-hidden focusable="false">
        {ghosts.map((g) => (
          <g key={g.key} className={`cv-cut-ghost is-${g.level}`} style={{ '--g': g.stroke, strokeWidth: g.width } as CSSProperties}>
            {g.split ? (
              <>
                <path className="cv-cut-half to-source" d={g.split.toSource} pathLength={1} />
                <path className="cv-cut-half to-target" d={g.split.toTarget} pathLength={1} />
                <circle className="cv-cut-spark" cx={g.split.point.x} cy={g.split.point.y} r={7} />
              </>
            ) : (
              <path className="cv-cut-fade" d={g.d} />
            )}
          </g>
        ))}
      </svg>
    </EdgeLabelRenderer>
  )
}
