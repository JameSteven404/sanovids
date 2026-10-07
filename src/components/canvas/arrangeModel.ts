import { bounds, type ArrangeOptions, type ArrangeResult, type ArrangeStyle, type PreviewBox } from '../../core/arrange'

export const STYLE_LABEL: Record<ArrangeStyle, string> = { rows: 'Theo hàng', grid: 'Lưới', strip: 'Dải ngang' }
export const STYLE_HINT: Record<ArrangeStyle, string> = {
  rows: 'Mỗi cảnh một hàng, video bên phải (như trước giờ).',
  grid: 'Nhiều cảnh mỗi hàng, đọc trái sang phải như bảng phân cảnh. Hợp dự án dài.',
  strip: 'Mọi cảnh trên một hàng. Hợp khi chỉ có vài cảnh, hoặc khi chỉ xếp các cảnh đang chọn.',
}
export const CHOSEN_NOTICE = 'Video khác, video đang tạo và dây vào Thư mục của chúng tạm ẩn, ở mọi dự án. Bấm “Tất cả” trên thanh công cụ để hiện lại — khi đó nên Sắp xếp lại.'
export function arrangeTitle(opts: ArrangeOptions) {
  const text = opts.style === 'rows' ? 'mỗi cảnh một hàng, video bên phải' : opts.style === 'strip' ? 'mọi cảnh trên một dải ngang'
    : opts.gridCols === 'auto' ? 'lưới tự động' : `lưới ${opts.gridCols} cảnh mỗi hàng`
  return `Sắp xếp lại: ${text}${opts.video === 'chosen' ? ', chỉ take chọn' : ''}`
}
export type Side = 'up' | 'down' | 'left' | 'right'
export function placeBySide(anchor: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, size: { w: number; h: number }, side: Side, vp: { w: number; h: number }) {
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
