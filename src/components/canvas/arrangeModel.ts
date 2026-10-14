// "Sắp xếp canvas": every user-facing sentence of the arrange command and its popover (plan §3.9), plus the small DOM
// rules of the popover (backdrop, keys, anchor) as plain functions over event-like objects, so tests read the real
// sentences and exercise the real handlers without a DOM.
import { bounds, type ArrangeInput, type ArrangeOptions, type ArrangeResult, type ArrangeStyle, type PreviewBox } from '../../core/arrange'
import type { AssetKind } from '../../core/types'
import { KIND_LABEL } from './canvasModel'

export const STYLE_LABEL: Record<ArrangeStyle, string> = { rows: 'Theo hàng', grid: 'Lưới', strip: 'Dải ngang' }
export const STYLE_HINT: Record<ArrangeStyle, string> = {
  rows: 'Mỗi cảnh một hàng, video bên phải (như trước giờ).',
  grid: 'Nhiều cảnh mỗi hàng, đọc trái sang phải như bảng phân cảnh. Hợp dự án dài.',
  strip: 'Mọi cảnh trên một hàng. Hợp khi chỉ có vài cảnh, hoặc khi chỉ xếp các cảnh đang chọn.',
}
export const CHOSEN_NOTICE = 'Video khác, video đang tạo và dây vào Thư mục của chúng tạm ẩn, ở mọi dự án. Mở “Hiển thị” (biểu tượng mắt) trên thanh công cụ › Video › Tất cả để hiện lại — khi đó nên Sắp xếp lại.'
export const FOLDER_KEEP_HINT = 'Thư mục bị cảnh đè lên sẽ được đưa lên hàng phía trên.'
export const FOLLOW_HINT = 'Video giữ khoảng cách với cảnh của nó, có thể đè lên thẻ khác.'
export const TOO_WIDE = 'Quá rộng để thấy hết — sau khi xếp sẽ phóng tới vùng cảnh bạn làm gần nhất.'
export const ALREADY_TIDY = 'Canvas đã gọn sẵn.'
export const REVEALED_OVERLAP = 'Video ẩn đã hiện lại và có thể đè lên cảnh bên cạnh.'
export const REARRANGE_LABEL = 'Sắp xếp lại'
const CHOSEN_ON = ' Đã bật “Chỉ take chọn” (mọi dự án): video khác và video đang tạo tạm ẩn.'

/** Extra hint of the "Dải ngang" card when the strip would hold more than 12 scenes ('' otherwise). */
export function stripWarning(scenes: number): string {
  return scenes > 12 ? `Với ${scenes} cảnh, dải sẽ rất dài — nên dùng Lưới.` : ''
}
/** Reminder after a grid / strip arrange when a new video of `order` grows into the next cluster. */
export function newVideoOverlap(order: number): string {
  return `Video mới của S${String(order).padStart(2, '0')} đè lên cảnh bên cạnh.`
}

export function arrangeTitle(opts: ArrangeOptions) {
  const text = opts.style === 'rows' ? 'mỗi cảnh một hàng, video bên phải' : opts.style === 'strip' ? 'mọi cảnh trên một dải ngang'
    : opts.gridCols === 'auto' ? 'lưới tự động' : `lưới ${opts.gridCols} cảnh mỗi hàng`
  return `Sắp xếp lại: ${text}${opts.video === 'chosen' ? ', chỉ take chọn' : ''}`
}

// ---------------- "Áp dụng cho": what a selection arrange moves ----------------
export interface ScopeCounts { scenes: number; assets: Record<AssetKind, number>; folders: number }
const KINDS: AssetKind[] = ['character', 'location', 'prop', 'style']

/** Selected cards the arrange would move, by kind. Takes follow their scene (not counted); images left in place
 *  ("Để nguyên chỗ") are not moved, so they are not counted either. */
export function scopeCounts(input: Pick<ArrangeInput, 'clusters' | 'assets' | 'folders'>, refs: ArrangeOptions['refs']): ScopeCounts {
  const assets: Record<AssetKind, number> = { character: 0, location: 0, prop: 0, style: 0 }
  if (refs !== 'keep') for (const a of input.assets) if (a.inScope) assets[a.kind]++
  return { scenes: input.clusters.filter((s) => s.inScope).length, assets, folders: input.folders.filter((f) => f.inScope).length }
}
export function scopeTotal(c: ScopeCounts): number {
  return c.scenes + c.folders + KINDS.reduce((n, k) => n + c.assets[k], 0)
}
/** "3 cảnh · 1 nhân vật · 1 thư mục" (only the kinds present). */
export function scopeLabel(c: ScopeCounts): string {
  const parts: string[] = []
  if (c.scenes) parts.push(`${c.scenes} cảnh`)
  for (const k of KINDS) if (c.assets[k]) parts.push(`${c.assets[k]} ${KIND_LABEL[k]}`)
  if (c.folders) parts.push(`${c.folders} thư mục`)
  return parts.join(' · ')
}

// ---------------- toast of one arrange ----------------
/**
 * Toast after an arrange that changed something (`ALREADY_TIDY` otherwise). `scope` = scopeLabel of a selection
 * arrange. Rows keep the sentence of 0.5 exactly: "Đã sắp xếp lại canvas (n video về cạnh cảnh của nó)."
 */
export function arrangeToast(res: Pick<ArrangeResult, 'cols' | 'stats'>, opts: Pick<ArrangeOptions, 'style' | 'scope' | 'folders'>, displayChanged: boolean, scope = ''): string {
  const s = res.stats
  const videos = [
    ...(s.takesBack ? [`${s.takesBack} video về cạnh cảnh của nó`] : []),
    ...(s.takesFollow ? [`${s.takesFollow} video đi theo cảnh của nó`] : []),
  ]
  const head = opts.scope === 'selection' ? `Đã sắp xếp ${scope || 'các mục'} đang chọn`
    : opts.style === 'grid' ? `Đã xếp canvas thành lưới ${res.cols} cột`
      : opts.style === 'strip' ? 'Đã xếp các cảnh thành một dải ngang' : 'Đã sắp xếp lại canvas'
  let text = `${head}${videos.length ? ` (${videos.join(', ')})` : ''}.`
  if (displayChanged) text += CHOSEN_ON
  // Only "Để nguyên chỗ" on the whole canvas lifts a folder because a scene covered it; otherwise lifting was asked for.
  if (s.foldersMoved) text += opts.folders === 'keep' && opts.scope === 'all' ? ` ${s.foldersMoved} thư mục bị đè đã lên hàng phía trên.` : ` ${s.foldersMoved} thư mục đã lên hàng phía trên.`
  if (s.assetsMoved) text += ` ${s.assetsMoved} thẻ nhân vật bị đè đã vào cột bên trái.`
  if (s.movedAway) text += ' Chỗ cũ không đủ, đã đặt sang chỗ trống bên phải.'
  return text
}

// ---------------- preview ----------------
/** Caption under the preview: "Vừa màn hình ở khoảng 35% · 12 video về cạnh cảnh". */
export function previewCaption(res: Pick<ArrangeResult, 'fitZoom' | 'stats'>): string {
  const back = res.stats.takesBack ? ` · ${res.stats.takesBack} video về cạnh cảnh` : ''
  return `Vừa màn hình ở khoảng ${Math.round(res.fitZoom * 100)}%${back}`
}
export function hiddenLinkText(k: number): string {
  return `${k} video có dây vào Thư mục sẽ tạm ẩn cả dây.`
}
/** Takes linked to a folder that the compact display would hide (their folder wires hide too). O(links + takes). */
export function hiddenFolderTakes(folders: readonly { takes?: readonly string[] }[], takes: readonly { id: string; shown: boolean }[]): number {
  const hidden = new Set<string>()
  for (const t of takes) if (!t.shown) hidden.add(t.id)
  if (!hidden.size) return 0
  const linked = new Set<string>()
  for (const f of folders) for (const id of f.takes ?? []) if (hidden.has(id)) linked.add(id)
  return linked.size
}

// ---------------- popover placement ----------------
export type Side = 'up' | 'down' | 'left' | 'right'
export type AnchorRect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>
/** An element (read again on every placement: the toolbar moves, resizes and scrolls) or a fixed rectangle. */
export type PopoverAnchor = AnchorRect | { getBoundingClientRect(): AnchorRect }
export function anchorRect(anchor: PopoverAnchor): AnchorRect {
  return 'getBoundingClientRect' in anchor ? anchor.getBoundingClientRect() : anchor
}
export function placeBySide(anchor: AnchorRect, size: { w: number; h: number }, side: Side, vp: { w: number; h: number }) {
  const gap = 10, margin = 8
  const places = {
    up: { x: anchor.left, y: anchor.top - gap - size.h }, down: { x: anchor.left, y: anchor.bottom + gap },
    left: { x: anchor.left - gap - size.w, y: anchor.top }, right: { x: anchor.right + gap, y: anchor.top },
  }
  const opposite: Record<Side, Side> = { up: 'down', down: 'up', left: 'right', right: 'left' }
  const fits = (s: Side) => s === 'up' || s === 'down'
    ? places[s].y >= margin && places[s].y + size.h <= vp.h - margin
    : places[s].x >= margin && places[s].x + size.w <= vp.w - margin
  const p = places[!fits(side) && fits(opposite[side]) ? opposite[side] : side]
  return { x: Math.max(margin, Math.min(p.x, vp.w - size.w - margin)), y: Math.max(margin, Math.min(p.y, vp.h - size.h - margin)) }
}

// ---------------- what the popover lets through ----------------
// The popover is portaled to <body> but stays a React child of the canvas stage (CanvasToolbar), so its synthetic
// events bubble to the stage's handlers: a file / image / video dropped on the backdrop would land on the canvas, a
// wheel would scroll the toolbar. The backdrop therefore stops them; a click outside the popover closes it on `click`
// (never on pointerdown: the backdrop must still cover the canvas when the release comes, or it would cut a wire).
interface EventLike { target: unknown; currentTarget: unknown; preventDefault(): void; stopPropagation(): void }
interface DragEventLike extends EventLike { dataTransfer?: { dropEffect: string } | null }
export function backdropHandlers(onClose: () => void) {
  const refuseDrop = (e: DragEventLike) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
  }
  return {
    onPointerDown: (e: EventLike) => { e.stopPropagation(); if (e.target === e.currentTarget) e.preventDefault() },
    onClick: (e: EventLike) => { e.preventDefault(); e.stopPropagation(); if (e.target === e.currentTarget) onClose() },
    onDoubleClick: (e: EventLike) => { e.preventDefault(); e.stopPropagation() },
    onContextMenu: (e: EventLike) => { e.preventDefault(); e.stopPropagation() },
    onDragEnter: refuseDrop,
    onDragOver: refuseDrop,
    onDrop: (e: DragEventLike) => { e.preventDefault(); e.stopPropagation() },
    onWheel: (e: Pick<EventLike, 'stopPropagation'>) => e.stopPropagation(),
  }
}

export type PopoverKeyAction = 'pass' | 'close' | 'own' | 'swallow'
/**
 * Window capture-phase keydown while the popover is open:
 * - pass: Ctrl/⌘+S (save) and every key while another overlay (dialog, confirm / dev sheet, image viewer) is up — it
 *   owns the keyboard;
 * - close: Escape (preventDefault: the global shortcuts never clear the selection);
 * - own: a key inside the popover (its own onKeyDown stops it there);
 * - swallow: any other key (focus outside the popover): Delete, N, 1, Ctrl+Z… never reach the canvas.
 */
export function popoverKeyAction(e: { key: string; ctrlKey?: boolean; metaKey?: boolean }, where: { inside: boolean; otherOverlay: boolean }): PopoverKeyAction {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') return 'pass'
  if (where.otherOverlay) return 'pass'
  if (e.key === 'Escape') return 'close'
  return where.inside ? 'own' : 'swallow'
}
interface KeyEventLike { key: string; ctrlKey?: boolean; metaKey?: boolean; target: unknown; preventDefault(): void; stopImmediatePropagation(): void }
/** Applies popoverKeyAction; `inside` / `otherOverlay` read the DOM in the component. */
export function handlePopoverKey(e: KeyEventLike, ctx: { inside: (t: unknown) => boolean; otherOverlay: (t: unknown) => boolean; close: () => void; focus: () => void }): PopoverKeyAction {
  const action = popoverKeyAction(e, { inside: ctx.inside(e.target), otherOverlay: ctx.otherOverlay(e.target) })
  if (action === 'close' || action === 'swallow') {
    e.preventDefault()
    e.stopImmediatePropagation()
    if (action === 'close') ctx.close()
    else ctx.focus()
  }
  return action
}

/** Bound SVG work: detailed nodes, then scene clusters, then grid rows. */
export function previewBoxes(result: ArrangeResult): PreviewBox[] {
  if (result.boxes.length <= 1500) return result.boxes
  const clusters = new Map(result.boxes.filter((b) => b.kind === 'scene').map((b) => [b.id, b]))
  for (const b of result.boxes) if (b.kind === 'slot') {
    const id = b.id.slice('slot:'.length), scene = clusters.get(id)
    if (scene) clusters.set(id, { ...scene, ...bounds([scene, b]) })
  }
  const other = result.boxes.filter((b) => b.kind === 'asset' || b.kind === 'folder')
  const compact = [...clusters.values(), ...other]
  if (compact.length <= 1500) return compact
  const rows = new Map<number, PreviewBox>()
  for (const b of clusters.values()) { const row = rows.get(b.y); rows.set(b.y, row ? { ...row, ...bounds([row, b]) } : b) }
  const grouped = [...rows.values(), ...other]
  if (grouped.length <= 1500) return grouped
  const boxes: PreviewBox[] = [], step = Math.ceil(result.boxes.length / 1500)
  for (let i = 0; i < grouped.length; i += step) boxes.push({ ...grouped[i], ...bounds(grouped.slice(i, i + step)) })
  return boxes
}
