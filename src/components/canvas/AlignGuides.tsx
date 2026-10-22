// UI-05 (docs/UI-MUOT.md): the alignment guides of the node being dragged (CanvasView.onNodesChange computes them with
// canvasModel.alignToGuides). Drawn in canvas coordinates inside React Flow's viewport, 1 screen pixel thick.
import { useStore, ViewportPortal } from '@xyflow/react'
import { memo } from 'react'
import { useCanvasLocal, type Guides } from './canvasModel'

/** Mounted only while guides exist: the zoom subscription costs nothing the rest of the time. */
function GuideLines({ guides }: { guides: Guides }) {
  const t = 1 / useStore((s) => s.transform[2])
  return (
    <>
      {guides.v && <div className="cv-guide" style={{ left: guides.v.x - t / 2, top: guides.v.y1, width: t, height: guides.v.y2 - guides.v.y1 }} />}
      {guides.h && <div className="cv-guide" style={{ left: guides.h.x1, top: guides.h.y - t / 2, width: guides.h.x2 - guides.h.x1, height: t }} />}
    </>
  )
}

export const AlignGuides = memo(function AlignGuides() {
  const guides = useCanvasLocal((s) => s.guides)
  return guides && (guides.v || guides.h) ? (
    <ViewportPortal>
      <GuideLines guides={guides} />
    </ViewportPortal>
  ) : null
})
