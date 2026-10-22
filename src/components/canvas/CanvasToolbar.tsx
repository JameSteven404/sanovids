// Canvas toolbar entry (CanvasView): the compact movable bar (ToolbarBar). The arrange command lives in arrangeActions.
import { canvasEvents } from '../../actions'
import { arrangeCanvas } from '../../arrangeActions'
import { FIT_EVENT, type ToolbarDensity } from './canvasModel'
import './canvas.css'
import { ToolbarBar } from './ToolbarBar'

export { autoLayoutCanvas } from '../../arrangeActions'

/** Ask the canvas to fit these nodes (all when empty), regardless of whether they are already visible. */
export function fitCanvas(ids: string[] = []) {
  canvasEvents.dispatchEvent(new CustomEvent(FIT_EVENT, { detail: ids }))
}

/** "Sắp xếp" on the bar: the saved style (lib/arrangePrefs); never the click event as an override. */
const arrangeNow = () => { arrangeCanvas() }

export function CanvasToolbar({ big = false }: { density?: ToolbarDensity; big?: boolean }) {
  return <ToolbarBar onArrange={arrangeNow} onFit={fitCanvas} big={big} />
}
