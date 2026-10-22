// Storyboard reorder (vw-): the pure index and geometry math behind dragging a card to a new place, the keyboard
// moves (Alt + arrows) and the slide animations. Tested in __tests__/storyboardOrder.test.ts.
// Cards are laid out by a CSS grid (auto-fill columns, rows wrap). A "slot" is the box of the n-th card in grid
// content coordinates (offsetLeft / offsetTop / offsetWidth / offsetHeight, which ignore transforms), so slots stay
// put while cards are shifted with transforms, and a card dropped at index `to` lands in `slots[to]`.
import { sceneCode } from '../../core/compile'
import { DRAG_SLOP } from '../../lib/gesture'

export interface Slot {
  x: number
  y: number
  w: number
  h: number
}
export interface Offset {
  x: number
  y: number
}

/** The lifted card grows a little while it is dragged ('full' motion only). */
export const LIFT_SCALE = 1.03
/** How far a press must travel before it becomes a drag (px): lives in lib/gesture, re-exported for this frozen view. */
export { DRAG_SLOP }
/** Touch: hold this long (without moving past the slop) to lift a card; moving earlier scrolls the storyboard. */
export const LONG_PRESS_MS = 380
/** Auto-scroll zone at the top / bottom of the storyboard (px) and the top speed at the very edge (px per frame). */
export const AUTOSCROLL_EDGE = 64
export const AUTOSCROLL_MAX = 18
/** Order changes that move more cards than this skip the slide (keeps undo of a big reorder instant). */
export const MAX_FLIP_CARDS = 400

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** `list` with the item at `from` moved so that it ends at index `to` (a copy; `to` is clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice()
  if (from < 0 || from >= out.length) return out
  const [item] = out.splice(from, 1)
  out.splice(clamp(to, 0, out.length), 0, item)
  return out
}

/** While the card at `from` is dragged to index `to`: the index the card at `i` shows at (the dragged one → `to`). */
export function shiftedIndex(i: number, from: number, to: number): number {
  if (i === from) return to
  if (from < to && i > from && i <= to) return i - 1
  if (to < from && i >= to && i < from) return i + 1
  return i
}

/** `moveScene(id, toOrder)` takes the 1-based place in the scene list: the order of a card dropped at index `to`. */
export const sceneOrderAt = (to: number) => to + 1

/** Slot indices grouped into rows (top to bottom, each left to right). Slots whose tops are within `tol` px share a row. */
export function rowsOf(slots: readonly Slot[], tol = 2): number[][] {
  const rows: number[][] = []
  let top = Number.NaN
  slots.forEach((s, i) => {
    if (rows.length && Math.abs(s.y - top) <= tol) rows[rows.length - 1].push(i)
    else {
      rows.push([i])
      top = s.y
    }
  })
  return rows
}

/** Cards per row in the current layout (the first row; 1 when there are no cards). */
export function columnsOf(slots: readonly Slot[]): number {
  return Math.max(1, rowsOf(slots)[0]?.length ?? 1)
}

/**
 * The slot the dragged card would take with the pointer at (x, y) (grid content coordinates). Rows split at the middle
 * of the gap between them; above the first / below the last row counts as that row. Inside a row, cards split at the
 * middle of the gap; left of the first card → the first, anywhere right of the last card → the last (so the empty end of
 * the last row means "at the end"). -1 when there are no slots.
 */
export function slotAt(slots: readonly Slot[], x: number, y: number): number {
  if (!slots.length) return -1
  const rows = rowsOf(slots)
  let r = rows.length - 1
  for (let k = 0; k < rows.length - 1; k++) {
    const cur = slots[rows[k][0]]
    const next = slots[rows[k + 1][0]]
    if (y < (cur.y + cur.h + next.y) / 2) {
      r = k
      break
    }
  }
  const row = rows[r]
  for (let k = 0; k < row.length - 1; k++) {
    const a = slots[row[k]]
    const b = slots[row[k + 1]]
    if (x < (a.x + a.w + b.x) / 2) return row[k]
  }
  return row[row.length - 1]
}

/** Horizontal / vertical gap between cards (first two cards of a row / first two rows), `fallback` when unknown. */
export function gapOf(slots: readonly Slot[], fallback = 16): Offset {
  const rows = rowsOf(slots)
  const first = rows[0]
  const x = first && first.length > 1 ? slots[first[1]].x - (slots[first[0]].x + slots[first[0]].w) : fallback
  const y = rows.length > 1 ? slots[rows[1][0]].y - (slots[rows[0][0]].y + slots[rows[0][0]].h) : fallback
  return { x: x >= 0 ? x : fallback, y: y >= 0 ? y : fallback }
}

/** Without shifting cards (reduced motion), the dragged card lands before (moving back) or after (moving on) the card at `to`. */
export function insertSide(from: number, to: number): 'before' | 'after' | null {
  return to < from ? 'before' : to > from ? 'after' : null
}

/** Insertion bar for the reduced-motion marker: centered in the gap beside `slots[to]`. Null when the card stays put. */
export function insertBar(slots: readonly Slot[], from: number, to: number): { x: number; y: number; h: number } | null {
  const side = insertSide(from, to)
  const s = slots[to]
  if (!side || !s) return null
  const gap = gapOf(slots).x
  return { x: side === 'before' ? s.x - gap / 2 : s.x + s.w + gap / 2, y: s.y, h: s.h }
}

/**
 * Keyboard: the index the selection goes to (arrow) or a card moves to (Alt + arrow) from `index`. ←/→ one card,
 * ↑/↓ one row (`columns` cards), Home / End the first / last place; clamped to the list. Null = not a grid key.
 */
export function gridStep(index: number, key: string, count: number, columns: number): number | null {
  if (count <= 0) return null
  const cols = Math.max(1, Math.floor(columns) || 1)
  let next: number
  switch (key) {
    case 'ArrowLeft':
      next = index - 1
      break
    case 'ArrowRight':
      next = index + 1
      break
    case 'ArrowUp':
      next = index - cols
      break
    case 'ArrowDown':
      next = index + cols
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = count - 1
      break
    default:
      return null
  }
  return clamp(next, 0, count - 1)
}

/**
 * Auto-scroll while dragging near the top / bottom edge of the scroller spanning [top, bottom] (client px): px to scroll
 * this frame, negative = up. Speed grows with the square of how deep the pointer is in the zone (full speed past the
 * edge). The zone shrinks to a third of the height on short scrollers so the middle never scrolls.
 */
export function autoScrollStep(y: number, top: number, bottom: number, edge = AUTOSCROLL_EDGE, max = AUTOSCROLL_MAX): number {
  const zone = Math.min(edge, Math.max(0, (bottom - top) / 3))
  if (zone <= 0) return 0
  const speed = (depth: number) => {
    const k = Math.min(1, depth / zone)
    return Math.max(1, Math.round(max * k * k))
  }
  if (y < top + zone) return -speed(top + zone - y)
  if (y > bottom - zone) return speed(y - (bottom - zone))
  return 0
}

/** A press moved far enough to become a drag (mouse / pen; touch uses the long press). */
export function movedPast(dx: number, dy: number, pointerType: string): boolean {
  const slop = DRAG_SLOP[pointerType as keyof typeof DRAG_SLOP] ?? DRAG_SLOP.mouse
  return Math.hypot(dx, dy) > slop
}

/**
 * Scene order changed from `prev` to `next` (same cards, e.g. a keyboard move, undo / redo): for each card that moved,
 * the offset from its new slot back to its old one (the FLIP start). Cards that stayed are left out. Null when the
 * lists hold different cards (scenes added / removed: no slide).
 */
export function flipOffsets(prev: readonly string[], next: readonly string[], slots: readonly Slot[]): Map<string, Offset> | null {
  if (prev.length !== next.length || slots.length !== next.length) return null
  const old = new Map(prev.map((id, i) => [id, i]))
  if (old.size !== prev.length) return null
  const out = new Map<string, Offset>()
  for (let n = 0; n < next.length; n++) {
    const o = old.get(next[n])
    if (o === undefined) return null
    if (o === n) continue
    const dx = slots[o].x - slots[n].x
    const dy = slots[o].y - slots[n].y
    if (dx || dy) out.set(next[n], { x: dx, y: dy })
  }
  return out
}

// ---------------- words (screen reader / toast) ----------------

const quoted = (title: string) => (title.trim() ? ` “${title.trim()}”` : '')

/** aria-live text after a move: the scene's old code, its new place and its new code. */
export function moveAnnouncement(o: { title: string; from: number; to: number; count: number }): string {
  return `Đã chuyển ${sceneCode(o.from + 1)}${quoted(o.title)} tới vị trí ${o.to + 1}/${o.count}, giờ là ${sceneCode(o.to + 1)}. Các mã cảnh đã đánh số lại.`
}

/** aria-live text when Alt + arrow cannot move further. */
export function edgeAnnouncement(index: number, count: number, key: string): string {
  const code = sceneCode(index + 1)
  const back = key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home'
  return back ? `${code} đã ở vị trí đầu.` : `${code} đã ở vị trí cuối (${count}/${count}).`
}

/** Toast after a drop. */
export function reorderToast(from: number, to: number): string {
  return `Đã chuyển ${sceneCode(from + 1)} → ${sceneCode(to + 1)} · mã cảnh đánh số lại theo thứ tự mới`
}
