// Resize handles of a canvas node (scene card, take, asset): React Flow's NodeResizer limited by NODE_SIZE.
// Shown for the only selected node, or during an active resize. The live box goes to useCanvasLocal.resizing and is
// committed once on resize end by CanvasView.onNodesChange. Double-click a handle or press ↺ for the default size.
// The invisible left / right resize edges leave a gap around the node's dots (resizeEdgeClip), so a press on a dot
// starts a wire / grabs a wire end instead of a resize.
// Also the node-geometry hooks shared by the node types: useNodeBox (drawn size) and useRemeasureOn (dots that move).
import { NodeResizer, useStore, useUpdateNodeInternals, type Handle as HandleBounds, type ReactFlowState } from '@xyflow/react'
import { ImageIcon, RotateCcw, Video } from 'lucide-react'
import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react'
import type { Size } from '../../core/types'
import { NODE_SIZE } from '../../store/project'
import { useUI } from '../../store/ui'
import { LOD_ZOOM, resetNodeSize, resizeEdgeClip, useCanvasLocal, type SizedKind } from './canvasModel'

const stop = (e: SyntheticEvent) => e.stopPropagation()

const farOf = (s: ReactFlowState) => s.transform[2] < LOD_ZOOM

/**
 * The far view (zoom below LOD_ZOOM), deferred: crossing 55% re-renders every node on screen at once (50–150 ms with
 * 300 scenes), so React does it in an interruptible background render and a wheel zoom keeps its frames. Every node
 * and the canvas' geometry estimates read this same value, so they switch together.
 */
export function useFarView(): boolean {
  return useDeferredValue(useStore(farOf))
}

/**
 * UI-03 (docs/UI-MUOT.md): the typed port a SELECTED node's dot grows into — a picture or a video icon, like Magnific.
 * Drawn on the dot's 0 × 0 anchor (canvas.css .cv-h-ico), so the wire ends never move. Only while selected: icons on
 * every node would add two SVGs per card.
 */
export function PortIcon({ kind }: { kind: 'image' | 'video' }) {
  return <span className="cv-h-ico" aria-hidden="true">{kind === 'image' ? <ImageIcon size={12} /> : <Video size={12} />}</span>
}

/** The canvas is being panned / zoomed right now (CanvasView onMoveStart / onMoveEnd). */
let canvasMoving = false
export function setCanvasMoving(moving: boolean): void {
  canvasMoving = moving
}

/**
 * False for a node that mounts while the canvas moves (it came into view during a pan / zoom): it draws its fixed-size
 * frame at once and its body a moment later, in an interruptible background render — a wheel pan no longer pays for
 * every card that scrolls in within one frame. True at once otherwise (opening a project, a new node, tests).
 */
export function useBodyReady(): boolean {
  const [ready, setReady] = useState(() => !canvasMoving)
  useEffect(() => {
    if (!ready) startTransition(() => setReady(true))
  }, [ready])
  return ready
}

/** Size the node is drawn at: live box while resizing, else the stored size; null = default (auto). */
export function useNodeBox(id: string, size: Size | null | undefined): Size | null {
  const live = useCanvasLocal((s) => s.resizing[id])
  if (live) return { w: live.w, h: live.h }
  return size ?? null
}

/**
 * React Flow re-measures a node's handles (where its wires start and end) only when the node's box changes size. Pass
 * every value that moves a dot WITHOUT resizing the node (H3 frame dots added / removed, a poster that changes height
 * across the LOD level, the folder dot's far position…): when it changes, the node is re-measured at once, so its wires
 * follow the dot. Not on mount (React Flow measures new nodes itself).
 */
export function useRemeasureOn(id: string, key: unknown) {
  const updateInternals = useUpdateNodeInternals()
  const last = useRef(key)
  useEffect(() => {
    if (Object.is(last.current, key)) return
    last.current = key
    updateInternals(id)
  }, [id, key, updateInternals])
}

/** clip-path of the node's left or right resize edge: a gap around each of its dots on that side, as React Flow measured them. */
function edgeClipOf(s: ReactFlowState, id: string, side: 'left' | 'right'): string | null {
  const b = s.nodeLookup.get(id)?.internals.handleBounds
  if (!b) return null
  const ys: number[] = []
  const add = (list: HandleBounds[] | null | undefined) => {
    for (const h of list ?? []) if (h.position === side) ys.push(h.y + h.height / 2)
  }
  add(b.source)
  add(b.target)
  return resizeEdgeClip(ys)
}

function NodeSizerView({ id, kind, selected, sized }: { id: string; kind: SizedKind; selected: boolean; sized: boolean }) {
  const single = useUI((s) => s.selectedIds.length === 1 && s.selectedIds[0] === id)
  const resizing = useCanvasLocal((s) => id in s.resizing)
  const l = NODE_SIZE[kind]
  const visible = (selected && single) || resizing
  // Strings (stable selector results), only computed while the edges are shown.
  const clipL = useStore((s) => (visible ? edgeClipOf(s, id, 'left') : null))
  const clipR = useStore((s) => (visible ? edgeClipOf(s, id, 'right') : null))
  const lineStyle = useMemo(() => ({ '--rs-clip-l': clipL ?? 'none', '--rs-clip-r': clipR ?? 'none' }) as CSSProperties, [clipL, clipR])
  // Stable: NodeResizeControl re-binds its d3 drag handlers whenever this callback changes, and this component
  // re-renders mid-gesture (selected / resizing flip on the first move), which would drop an in-progress touch drag.
  const onResizeStart = useCallback(() => {
    // Keep selection on the resized node if an external selection changed just before the gesture.
    const ui = useUI.getState()
    if (!ui.selectedIds.includes(id)) ui.select([id])
  }, [id])
  return (
    <>
      <NodeResizer
        isVisible={visible}
        minWidth={l.minW}
        minHeight={l.minH}
        maxWidth={l.maxW}
        maxHeight={l.maxH}
        handleClassName="cv-rs-handle"
        lineClassName="cv-rs-line"
        lineStyle={lineStyle}
        onResizeStart={onResizeStart}
      />
      {visible && sized && (
        <button
          className="cv-rs-reset nodrag nopan"
          title="Về kích thước mặc định (hoặc bấm đúp vào góc kéo)"
          aria-label="Về kích thước mặc định"
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={(e) => {
            e.stopPropagation()
            resetNodeSize(id)
          }}
        >
          <RotateCcw size={11} strokeWidth={2.4} />
        </button>
      )}
    </>
  )
}

export const NodeSizer = memo(NodeSizerView)
