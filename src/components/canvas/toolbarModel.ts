import type { XY } from '../../core/types'
import { DEFAULT_TOOLBAR_PLACE, validateToolbarPlace, type ToolbarDock, type ToolbarPlace } from '../../lib/toolbarPrefs'

export interface ToolbarSize { w: number; h: number }
export interface ToolbarRect extends ToolbarSize, XY {}
export const TOOLBAR_MARGIN = 12
/** Bar slots of mockup A. `add` = the "▾" next to "+", `mouse` = Tay | Chọn (one slot), `view` = Hiển thị. */
export const TOOLBAR_ITEMS = ['new', 'add', 'run', 'arrange', 'fit', 'mouse', 'view', 'zoom'] as const
export type ToolbarItemId = typeof TOOLBAR_ITEMS[number]
/** Segments, each drawn after a divider: ⋮⋮ │ + ▾ ▶ │ ▦ ⤢ │ Tay|Chọn ◉ │ 87% ⋯ ("⋯" always closes the last one). */
export const TOOLBAR_GROUPS: readonly (readonly ToolbarItemId[])[] = [['new', 'add', 'run'], ['arrange', 'fit'], ['mouse', 'view'], ['zoom']]
// Run never leaves the bar. Hand and Select share one slot, so they move to "⋯" (and back) together.
const overflowOrder: ToolbarItemId[] = ['add', 'view', 'mouse', 'fit', 'arrange', 'zoom', 'new']
// Pixel lengths along the bar (toolbar.css): grip 16, "⋯" 32, divider 1 + 2 × 2, gap 3, padding 2 × 6 + border 2.
const GRIP = 16, MORE = 32, DIVIDER = 5, GAP = 3, FRAME = 14
const slotLength = (id: ToolbarItemId, vertical: boolean) => id === 'mouse' ? 32 + GAP + 32 : id === 'add' ? 16 : id === 'zoom' && !vertical ? 44 : 32
export const toolbarOrientation = (dock: ToolbarDock) => dock === 'left' || dock === 'right' ? 'vertical' : 'horizontal'

/** The shown slots per segment; empty segments drop out, the last one stays (it holds "⋯"). */
export function toolbarGroups(shown: readonly ToolbarItemId[]): ToolbarItemId[][] {
  return TOOLBAR_GROUPS.map((group) => group.filter((id) => shown.includes(id)))
    .filter((group, index) => group.length > 0 || index === TOOLBAR_GROUPS.length - 1)
}

export function toolbarLength(shown: readonly ToolbarItemId[], vertical: boolean) {
  const groups = toolbarGroups(shown)
  const children = 2 + groups.length + shown.length // grip, "⋯", one divider per segment, the slots
  return FRAME + GRIP + MORE + groups.length * DIVIDER + shown.reduce((sum, id) => sum + slotLength(id, vertical), 0) + GAP * (children - 1)
}

export function fitToolbar(stage: ToolbarSize, dock: ToolbarDock) {
  const vertical = toolbarOrientation(dock) === 'vertical' && stage.h >= 160
  const available = Math.max(0, (vertical ? stage.h : stage.w) - 2 * TOOLBAR_MARGIN)
  const shown: ToolbarItemId[] = [...TOOLBAR_ITEMS]
  for (const id of overflowOrder) {
    if (toolbarLength(shown, vertical) <= available) break
    shown.splice(shown.indexOf(id), 1)
  }
  const length = toolbarLength(shown, vertical)
  return {
    vertical,
    dock: toolbarOrientation(dock) === 'vertical' && !vertical ? 'bottom' as const : dock,
    shown,
    groups: toolbarGroups(shown),
    overflow: TOOLBAR_ITEMS.filter((id) => !shown.includes(id)),
    size: vertical ? { w: 46, h: Math.min(length, available) } : { w: Math.min(length, available), h: Math.min(46, stage.h) },
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
  // Pushing into the edge the bar is docked to: it is already there; it stays docked (no silent switch to 'free').
  if (fit.dock === move[2]) return place
  const rect = toolbarRect({ ...place, dock: fit.dock }, stage, fit.size)
  const step = shift ? 64 : 16
  const alongEdge = (fit.dock === 'top' || fit.dock === 'bottom') ? move[1] === 0 : (fit.dock === 'left' || fit.dock === 'right') && move[0] === 0
  const dock = alongEdge ? fit.dock : 'free'
  return placeFromPoint({ x: rect.x + move[0] * step, y: rect.y + move[1] * step }, stage, fitToolbar(stage, dock).size, dock)
}

/** The grip's keyboard help (screen readers). A Mac names ⇧ / ⌥, and reaches Home with Fn + ←. */
export function gripHelpText(mac: boolean) {
  return mac
    ? 'Kéo để dời. Enter: menu của thanh. Mũi tên: dời 16 px; ⇧: 64 px. ⌥ + mũi tên: bám cạnh. Fn + ← (Home): về chỗ cũ.'
    : 'Kéo để dời. Enter: menu của thanh. Mũi tên: dời 16 px; Shift: 64 px. Alt + mũi tên: bám cạnh. Home: về chỗ cũ.'
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

/** A wheel over a box it can still scroll that way scrolls the box (tray, menu); anything else zooms / pans the canvas. */
export function canScrollBy(box: { scrollLeft: number; scrollTop: number; scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number }, dx: number, dy: number) {
  const vertical = (dy < 0 && box.scrollTop > 0) || (dy > 0 && box.scrollTop + box.clientHeight < box.scrollHeight - 1)
  const horizontal = (dx < 0 && box.scrollLeft > 0) || (dx > 0 && box.scrollLeft + box.clientWidth < box.scrollWidth - 1)
  return vertical || horizontal
}

/** "Hiển thị" shows a dot while wires / videos / the minimap differ from the defaults (Cài đặt). */
export interface ViewState { edgeMode: string; takeDisplay: string; showMinimap: boolean }
/** = lib/settings DEFAULT_SETTINGS.ui (tested); kept here so the canvas does not pull the lazy settings module in. */
export const DEFAULT_VIEW: Readonly<ViewState> = { edgeMode: 'selected', takeDisplay: 'all', showMinimap: true }
export const viewDiffers = (now: ViewState, defaults: ViewState = DEFAULT_VIEW) =>
  now.edgeMode !== defaults.edgeMode || now.takeDisplay !== defaults.takeDisplay || now.showMinimap !== defaults.showMinimap

/** "Chỉ canvas": hides both side panels and remembers which were open; pressed again it shows exactly those again. */
export interface PanelState { left: boolean; right: boolean }
export function toggleCanvasOnly(now: PanelState, remembered: PanelState | null): { next: PanelState; remember: PanelState | null } {
  if (now.left || now.right) return { next: { left: false, right: false }, remember: { left: now.left, right: now.right } }
  return { next: remembered && (remembered.left || remembered.right) ? { ...remembered } : { left: true, right: true }, remember: null }
}
export const canvasOnlyLabel = (now: PanelState) => now.left || now.right ? 'Chỉ canvas (ẩn hai khung bên)' : 'Hiện lại hai khung bên'

export type TrayAction = 'connect' | 'duplicate' | 'star' | 'download' | 'save' | 'rerun' | 'delete' | 'cut'
/**
 * What is selected, counted with the shared rules: `nodes` = canvas items; `assets` = what C would link
 * (actions.pickAssetSelection: the canvas wins over the library, a selected video drops the library);
 * `fromLibrary` = those assets were picked in Thư viện, not on the canvas.
 */
export interface TraySelection { nodes: number; scenes: number; assets: number; fromLibrary?: boolean; takeStatus?: string; cuttableWires: number }

/**
 * The tray: 2+ canvas items, exactly one take, or wires only; also one scene + images picked in Thư viện (the case
 * the old "… bấm C để nối" pill announced: the only sign those images will be linked). One scene or one image: none.
 */
export function toolbarTrayContents(selection: TraySelection): TrayAction[] {
  if (selection.nodes === 1 && selection.takeStatus) return selection.takeStatus === 'completed' ? ['star', 'download', 'save', 'delete']
    : selection.takeStatus === 'failed' || selection.takeStatus === 'cancelled' ? ['rerun', 'delete'] : ['delete']
  // Same condition as connectSelection: at least one scene and one image to link.
  const connect = selection.scenes >= 1 && selection.assets >= 1
  if (selection.nodes >= 2) return [...(connect ? ['connect' as const] : []), ...(selection.scenes ? ['duplicate' as const] : []), 'delete']
  if (connect) return ['connect']
  if (!selection.nodes && selection.cuttableWires) return ['cut']
  return []
}

/** The tray's first words: "4 mục · 1 ảnh + 3 cảnh", "S03·T2", "2 dây". */
export function traySummary(selection: TraySelection, takeCode?: string): string {
  if (selection.nodes === 1 && selection.takeStatus && takeCode) return takeCode
  const connect = selection.scenes >= 1 && selection.assets >= 1
  if (selection.nodes >= 2 || connect) {
    const parts = selection.nodes >= 2 ? [`${selection.nodes} mục`] : []
    if (connect) parts.push(`${selection.assets} ảnh${selection.fromLibrary ? ' trong Thư viện' : ''} + ${selection.scenes} cảnh`)
    return parts.join(' · ')
  }
  return `${selection.cuttableWires} dây`
}
