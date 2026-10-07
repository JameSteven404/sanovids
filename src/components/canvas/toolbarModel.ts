import type { XY } from '../../core/types'
import { DEFAULT_TOOLBAR_PLACE, validateToolbarPlace, type ToolbarDock, type ToolbarPlace } from '../../lib/toolbarPrefs'

export interface ToolbarSize { w: number; h: number }
export interface ToolbarRect extends ToolbarSize, XY {}
export const TOOLBAR_MARGIN = 12
export const TOOLBAR_ITEMS = ['new', 'folder', 'link', 'run', 'arrange', 'fit', 'hand', 'select', 'edges', 'takes', 'minimap', 'zoom'] as const
export type ToolbarItemId = typeof TOOLBAR_ITEMS[number]
const overflowOrder: ToolbarItemId[] = ['folder', 'link', 'minimap', 'takes', 'edges', 'hand', 'select', 'fit', 'arrange', 'zoom', 'new']
export const toolbarOrientation = (dock: ToolbarDock) => dock === 'left' || dock === 'right' ? 'vertical' : 'horizontal'

export function fitToolbar(stage: ToolbarSize, dock: ToolbarDock) {
  const vertical = toolbarOrientation(dock) === 'vertical' && stage.h >= 160
  const available = Math.max(0, (vertical ? stage.h : stage.w) - 2 * TOOLBAR_MARGIN)
  const shown: ToolbarItemId[] = [...TOOLBAR_ITEMS]
  // Grip 20, more 32, padding and border 14, gaps 3. Zoom never shifts neighbours.
  const length = () => 66 + 3 * (shown.length + 1) + shown.reduce((sum, id) => sum + (!vertical && id === 'zoom' ? 44 : 32), 0)
  for (const id of overflowOrder) {
    if (length() <= available) break
    shown.splice(shown.indexOf(id), 1)
  }
  return {
    vertical,
    dock: toolbarOrientation(dock) === 'vertical' && !vertical ? 'bottom' as const : dock,
    shown,
    overflow: TOOLBAR_ITEMS.filter((id) => !shown.includes(id)),
    size: vertical ? { w: 46, h: Math.min(length(), available) } : { w: Math.min(length(), available), h: Math.min(46, stage.h) },
  }
}

export function clampToolbar(point: XY, stage: ToolbarSize, size: ToolbarSize): XY {
  const axis = (v: number, space: number, length: number) => {
    const max = Math.max(0, space - length)
    const margin = Math.min(TOOLBAR_MARGIN, max / 2)
    return Math.max(margin, Math.min(max - margin, v))
  }
  return { x: axis(point.x, stage.w, size.w), y: axis(point.y, stage.h, size.h) }
}

export function toolbarRect(place: ToolbarPlace, stage: ToolbarSize, size: ToolbarSize): ToolbarRect {
  const p = validateToolbarPlace(place)
  return { ...clampToolbar({ x: p.x * (stage.w - size.w), y: p.y * (stage.h - size.h) }, stage, size), ...size }
}

export function placeFromPoint(point: XY, stage: ToolbarSize, size: ToolbarSize, dock: ToolbarDock = 'free'): ToolbarPlace {
  const p = clampToolbar(point, stage, size)
  return validateToolbarPlace({ dock, x: p.x / Math.max(1, stage.w - size.w), y: p.y / Math.max(1, stage.h - size.h) })
}

export function snapToolbar(pointer: XY, grab: XY, stage: ToolbarSize, alt = false) {
  // Horizontal edges win at corners. Alt disables docking and alignment snapping.
  const dock: ToolbarDock = alt ? 'free' : pointer.y <= 40 ? 'top' : pointer.y >= stage.h - 40 ? 'bottom'
    : pointer.x <= 40 ? 'left' : pointer.x >= stage.w - 40 ? 'right' : 'free'
  const fit = fitToolbar(stage, dock)
  const point = { x: pointer.x - grab.x, y: pointer.y - grab.y }
  if (!alt) {
    for (const axis of ['x', 'y'] as const) {
      const room = (axis === 'x' ? stage.w - fit.size.w : stage.h - fit.size.h)
      for (const fraction of [0, 0.5, 1]) if (Math.abs(point[axis] - room * fraction) <= 12) point[axis] = room * fraction
    }
  }
  return placeFromPoint(point, stage, fit.size, fit.dock)
}

export function nudgeToolbar(place: ToolbarPlace, key: string, stage: ToolbarSize, shift = false, alt = false): ToolbarPlace {
  if (key === 'Home') return { ...DEFAULT_TOOLBAR_PLACE }
  const directions: Record<string, [number, number, ToolbarDock]> = { ArrowLeft: [-1, 0, 'left'], ArrowRight: [1, 0, 'right'], ArrowUp: [0, -1, 'top'], ArrowDown: [0, 1, 'bottom'] }
  const move = directions[key]
  if (!move) return place
  if (alt) return validateToolbarPlace({ ...place, dock: move[2] })
  const fit = fitToolbar(stage, place.dock)
  const rect = toolbarRect({ ...place, dock: fit.dock }, stage, fit.size)
  const step = shift ? 64 : 16
  const alongEdge = (fit.dock === 'top' || fit.dock === 'bottom') ? move[1] === 0 : (fit.dock === 'left' || fit.dock === 'right') && move[0] === 0
  const dock = alongEdge ? fit.dock : 'free'
  return placeFromPoint({ x: rect.x + move[0] * step, y: rect.y + move[1] * step }, stage, fitToolbar(stage, dock).size, dock)
}

export function toolbarSide(dock: ToolbarDock, rect: ToolbarRect, stage: ToolbarSize) {
  return dock === 'left' ? 'right' : dock === 'right' ? 'left' : dock === 'top' ? 'bottom' : dock === 'bottom' ? 'top'
    : rect.y + rect.h / 2 < stage.h / 2 ? 'bottom' : 'top'
}

export function placeToolbarPanel(anchor: ToolbarRect, size: ToolbarSize, stage: ToolbarSize, side: ReturnType<typeof toolbarSide>): XY {
  const point = { x: anchor.x + (anchor.w - size.w) / 2, y: anchor.y + (anchor.h - size.h) / 2 }
  if (side === 'top') point.y = anchor.y - size.h - 6
  if (side === 'bottom') point.y = anchor.y + anchor.h + 6
  if (side === 'left') point.x = anchor.x - size.w - 6
  if (side === 'right') point.x = anchor.x + anchor.w + 6
  return clampToolbar(point, stage, size)
}

export function minimapPosition(stage: ToolbarSize, size: ToolbarSize, blockers: ToolbarRect[]): XY {
  const overlap = (a: ToolbarRect, b: ToolbarRect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const candidates = [{ x: stage.w, y: stage.h }, { x: 0, y: stage.h }, { x: stage.w, y: 0 }, { x: 0, y: 0 }]
    .map((point) => clampToolbar(point, stage, size))
  return candidates.sort((a, b) => blockers.reduce((sum, block) => sum + overlap({ ...a, ...size }, block) - overlap({ ...b, ...size }, block), 0))[0]
}

export type TrayAction = 'connect' | 'duplicate' | 'star' | 'download' | 'save' | 'rerun' | 'delete' | 'cut'
export function toolbarTrayContents(selection: { nodes: number; scenes: number; assets: number; takeStatus?: string; cuttableWires: number }): TrayAction[] {
  if (selection.scenes >= 2) return [...(selection.assets ? ['connect' as const] : []), 'duplicate', 'delete']
  if (selection.nodes === 1 && selection.takeStatus) return selection.takeStatus === 'completed' ? ['star', 'download', 'save', 'delete']
    : selection.takeStatus === 'failed' || selection.takeStatus === 'cancelled' ? ['rerun', 'delete'] : ['delete']
  if (!selection.nodes && selection.cuttableWires) return ['cut']
  return []
}
