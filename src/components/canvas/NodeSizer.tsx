// Resize handles of a canvas node (scene card, take, asset): React Flow's NodeResizer limited by NODE_SIZE.
// Shown when the node is selected (subtle while hovered). The live box goes to useCanvasLocal.resizing and is
// committed once on resize end by CanvasView.onNodesChange. Double-click a handle or press ↺ for the default size.
// Also the node-geometry hooks shared by the node types: useNodeBox (drawn size) and useRemeasureOn (dots that move).
import { NodeResizer, useUpdateNodeInternals } from '@xyflow/react'
import { RotateCcw } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, type SyntheticEvent } from 'react'
import type { Size } from '../../core/types'
import { NODE_SIZE } from '../../store/project'
import { useUI } from '../../store/ui'
import { resetNodeSize, useCanvasLocal, type SizedKind } from './canvasModel'

const stop = (e: SyntheticEvent) => e.stopPropagation()

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

function NodeSizerView({ id, kind, selected, sized }: { id: string; kind: SizedKind; selected: boolean; sized: boolean }) {
  const hovered = useUI((s) => s.hoveredId === id)
  const resizing = useCanvasLocal((s) => id in s.resizing)
  const l = NODE_SIZE[kind]
  const visible = selected || hovered || resizing
  const subtle = !selected && !resizing ? ' is-subtle' : ''
  // Stable: NodeResizeControl re-binds its d3 drag handlers whenever this callback changes, and this component
  // re-renders mid-gesture (selected / resizing flip on the first move), which would drop an in-progress touch drag.
  const onResizeStart = useCallback(() => {
    // A resize started from a hovered (unselected) node selects it, so the handles stay while dragging.
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
        handleClassName={`cv-rs-handle${subtle}`}
        lineClassName={`cv-rs-line${subtle}`}
        onResizeStart={onResizeStart}
      />
      {selected && sized && (
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
