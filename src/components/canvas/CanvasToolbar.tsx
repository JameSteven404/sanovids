// Compact movable toolbar; existing layout and fit commands remain compatible.
import { canvasEvents } from '../../actions'
import type { Project, XY } from '../../core/types'
import { undoToastAction, useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { toast } from '../../store/ui'
import {
  measuredOf,
  assetNodeHeight,
  FIT_EVENT,
  layoutRowHeights,
  layoutTakes,
  type ToolbarDensity,
} from './canvasModel'
import './canvas.css'
import { ToolbarBar } from './ToolbarBar'

/**
 * Auto layout: scenes one per row in order, assets in a column, every take back to its auto slot next to its scene.
 * One undo step for scenes / assets; the take positions (runs store, not undoable) follow that step (watchLayoutUndo).
 */
export function autoLayoutCanvas() {
  const measuredH = (id: string) => measuredOf(id)?.height
  const before = useProject.getState().project
  const runs = useRuns.getState()
  // Rows grow with their tallest node: the scene card or any of its takes (a resized take must not cover the next
  // scene's row once every take is back in its row). Every take counts, also the ones "Chỉ take chọn" hides now:
  // switched back to "Tất cả", they return to their row (only NEW nodes ignore hidden takes, see store/takeRows).
  const heights = layoutRowHeights(before.scenes, layoutTakes(runs.takes, before.scenes, 'all'), measuredH)
  // Asset cards follow their image's aspect ratio (a portrait card is much taller than LAYOUT.assetH): hand their
  // heights over (keyed by asset id) so the asset column does not overlap. Off-screen cards are not rendered
  // (onlyRenderVisibleElements) and may never have been measured: assetNodeHeight falls back to the image's aspect.
  for (const a of before.assets) {
    if (a.position) heights[a.id] = assetNodeHeight(a, measuredH(a.id))
  }
  useProject.getState().autoLayout(heights)
  const after = useProject.getState().project
  const placed: Record<string, XY> = {}
  for (const t of runs.takes) if (t.position) placed[t.id] = t.position
  const placedIds = Object.keys(placed)
  if (placedIds.length) {
    runs.setTakePositions(Object.fromEntries(placedIds.map((id) => [id, null])))
    watchLayoutUndo(before, after, placed)
  }
  toast(placedIds.length ? `Đã sắp xếp lại canvas (${placedIds.length} video về cạnh cảnh của nó).` : 'Đã sắp xếp lại canvas.', {
    action: undoToastAction(),
  })
  setTimeout(() => fitCanvas(), 60)
}

const samePos = (a: XY, b: XY) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5
let stopLayoutWatch: (() => void) | null = null

/**
 * Take positions live in the runs store, outside the undo history. After "Sắp xếp", follow the project history:
 * when it is back at the state before the layout (Ctrl+Z, the toast's Undo), the takes the user had placed by hand
 * return to their spots; a redo sends them to their auto slots again. Takes moved since are left alone. Ends with
 * the next layout or when another project is opened.
 */
function watchLayoutUndo(before: Project, after: Project, placed: Record<string, XY>) {
  stopLayoutWatch?.()
  const unsub = useProject.subscribe((s, prev) => {
    if (s.project === prev.project) return
    if (s.project.id !== before.id) {
      stop()
      return
    }
    const runs = useRuns.getState()
    const patch: Record<string, XY | null> = {}
    if (s.project === before) {
      for (const t of runs.takes) if (placed[t.id] && !t.position) patch[t.id] = placed[t.id]
    } else if (s.project === after) {
      for (const t of runs.takes) if (placed[t.id] && t.position && samePos(t.position, placed[t.id])) patch[t.id] = null
    }
    if (Object.keys(patch).length) runs.setTakePositions(patch)
  })
  const stop = () => {
    unsub()
    if (stopLayoutWatch === stop) stopLayoutWatch = null
  }
  stopLayoutWatch = stop
}

/** Ask the canvas to fit these nodes (all when empty), regardless of whether they are already visible. */
export function fitCanvas(ids: string[] = []) {
  canvasEvents.dispatchEvent(new CustomEvent(FIT_EVENT, { detail: ids }))
}

/** The legacy arrange entry point stays here for existing callers and its undo tests. */
export function CanvasToolbar({ big = false }: { density?: ToolbarDensity; big?: boolean }) {
  return <ToolbarBar onArrange={autoLayoutCanvas} onFit={fitCanvas} big={big} />
}
