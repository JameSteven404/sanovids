// Pure canvas arrangement. Geometry is supplied by the current canvas, never copied from an older layout.
import type { AssetKind, XY } from './types'

export type ArrangeStyle = 'rows' | 'grid' | 'strip'
export interface ArrangeOptions {
  style: ArrangeStyle
  gridCols: 'auto' | 2 | 3 | 4 | 5 | 6 | 8
  video: 'all' | 'chosen'
  spacing: 'tight' | 'normal' | 'roomy'
  refs: 'column' | 'byKind' | 'keep'
  folders: 'keep' | 'top'
  placedTakes: 'reset' | 'follow'
  scope: 'all' | 'selection'
}
export const LEGACY_ROWS: ArrangeOptions = {
  style: 'rows', gridCols: 'auto', video: 'all', spacing: 'normal', refs: 'column', folders: 'keep', placedTakes: 'reset', scope: 'all',
}
export interface Box extends XY { w: number; h: number }
export interface LayoutConsts {
  scenesX: number; scenesY: number; assetX: number; assetW: number; assetH: number; assetGapY: number
  gapY: number; takeW: number; takeH: number; takeGapX: number; takeOffsetX: number
}
export interface ClusterIn {
  id: string; order: number; pos: XY; cardW: number; cardH: number; rowW: number; rowH: number; inScope: boolean
}
export interface AssetIn {
  id: string; kind: AssetKind; pos: XY; w: number; h: number; libIndex: number; firstUse: number; inScope: boolean
}
export interface FolderIn {
  id: string; pos: XY; w: number; h: number; firstSceneOrder: number | null; inScope: boolean
}
export interface TakeIn {
  id: string; sceneId: string; pos: XY | null; offRow: boolean; shown: boolean; w: number; h: number; slot: number
}
export interface ArrangeInput {
  clusters: ClusterIn[]; assets: AssetIn[]; folders: FolderIn[]; takes: TakeIn[]; obstacles: Box[]
  stage: { w: number; h: number }; focusId: string | null; layout: LayoutConsts
}
export interface PreviewBox extends Box { id: string; kind: 'scene' | 'asset' | 'folder' | 'take' | 'slot' }
export interface ArrangeResult {
  positions: Record<string, XY>; takes: Record<string, XY | null>; bbox: Box; fitIds: string[]; fitZoom: number
  cols: number; boxes: PreviewBox[]
  stats: { moved: number; takesBack: number; takesFollow: number; foldersMoved: number; assetsMoved: number; movedAway: boolean }
}
export const samePosition = (a: XY | null, b: XY | null): boolean => a === b || !!a && !!b && Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5
export const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
export function bounds(boxes: readonly Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 }
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
  for (const b of boxes) { x = Math.min(x, b.x); y = Math.min(y, b.y); right = Math.max(right, b.x + b.w); bottom = Math.max(bottom, b.y + b.h) }
  return { x, y, w: right - x, h: bottom - y }
}
export function spacingOf(s: ArrangeOptions['spacing'], layout?: LayoutConsts) {
  return s === 'tight' ? { x: 48, y: 24, asset: 16, kind: 40, top: 48, ref: 48 }
    : s === 'roomy' ? { x: 160, y: 96, asset: 40, kind: 96, top: 96, ref: 96 }
      : { x: 96, y: layout?.gapY ?? 48, asset: layout?.assetGapY ?? 24, kind: 64, top: 64, ref: 48 }
}
export function resolveCols(n: number, avgW: number, avgH: number, aspect: number, opt: ArrangeOptions['gridCols'], gapX: number, gapY: number): number {
  if (!n) return 0
  if (opt !== 'auto') return Math.min(n, opt)
  return n <= 3 ? n : Math.min(n, 10, Math.max(2, Math.round(Math.sqrt(n * (avgH + gapY) * aspect / (avgW + gapX)))))
}

// A spatial index bounds collision work for large projects; oversized imported boxes use the overflow list.
class BoxIndex {
  private cells = new Map<string, Box[]>()
  private all: Box[] = []
  private large: Box[] = []
  private keys(b: Box): string[] {
    const x = Math.floor(b.x / 512), y = Math.floor(b.y / 512), r = Math.floor((b.x + b.w) / 512), d = Math.floor((b.y + b.h) / 512)
    if ((r - x + 1) * (d - y + 1) > 4096) return []
    const keys: string[] = []
    for (let i = x; i <= r; i++) for (let j = y; j <= d; j++) keys.push(`${i}:${j}`)
    return keys
  }
  constructor(boxes: readonly Box[] = []) { for (const b of boxes) this.add(b) }
  add(b: Box) {
    this.all.push(b)
    const keys = this.keys(b)
    if (!keys.length) this.large.push(b)
    for (const k of keys) { const list = this.cells.get(k); if (list) list.push(b); else this.cells.set(k, [b]) }
  }
  hits(b: Box): Box[] {
    const keys = this.keys(b)
    const candidates = keys.length ? new Set([...this.large, ...keys.flatMap((k) => this.cells.get(k) ?? [])]) : this.all
    return [...candidates].filter((o) => overlaps(b, o))
  }
}

/** At most 64 nearby candidates, then a guaranteed free spot to the right of all obstacles. */
export function placeBlock(items: Box[], obstacles: Box[], anchor: XY, maxDist = 4000): { dx: number; dy: number; movedAway: boolean } {
  if (!items.length || !obstacles.length) return { dx: 0, dy: 0, movedAway: false }
  const index = new BoxIndex(obstacles), tried = new Set<string>(), candidates = [{ x: 0, y: 0 }]
  for (let n = 0; n < 64 && candidates.length; n++) {
    candidates.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || a.y - b.y || a.x - b.x)
    const d = candidates.shift()!
    const key = `${d.x}:${d.y}`
    if (tried.has(key)) continue
    tried.add(key)
    const hits = items.flatMap((b) => index.hits({ ...b, x: b.x + d.x, y: b.y + d.y }).map((o) => ({ b, o })))
    if (!hits.length) return { dx: d.x, dy: d.y, movedAway: false }
    for (const { b, o } of hits) {
      for (const next of [{ x: o.x + o.w + 96 - b.x, y: d.y }, { x: d.x, y: o.y + o.h + 48 - b.y }]) {
        if (Math.hypot(next.x, next.y) <= maxDist && !tried.has(`${next.x}:${next.y}`) && candidates.length < 256) candidates.push(next)
      }
    }
  }
  const old = bounds(items), occupied = bounds(obstacles)
  return { dx: occupied.x + occupied.w + 160 - old.x, dy: anchor.y - old.y, movedAway: true }
}

export function arrange(input: ArrangeInput, opts: ArrangeOptions): ArrangeResult {
  const { layout: l } = input, gap = spacingOf(opts.spacing, l)
  const inScope = (x: { inScope: boolean }) => opts.scope === 'all' || x.inScope
  const scenes = input.clusters.filter(inScope).sort((a, b) => a.order - b.order)
  const kinds: AssetKind[] = ['character', 'location', 'prop', 'style']
  const assets = input.assets.filter(inScope).sort((a, b) => opts.refs === 'byKind'
    ? kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.firstUse - b.firstUse || a.libIndex - b.libIndex : a.libIndex - b.libIndex)
  const folders = input.folders.filter(inScope)
  const stats = { moved: 0, takesBack: 0, takesFollow: 0, foldersMoved: 0, assetsMoved: 0, movedAway: false }
  const rowWidths = scenes.map((s) => opts.style === 'rows' ? s.rowW : opts.video === 'chosen'
    ? Math.max(s.rowW, l.takeOffsetX + l.takeW) : s.rowW ? s.rowW + l.takeGapX + l.takeW : l.takeOffsetX + l.takeW)
  const sizes = scenes.map((s, i) => ({ w: s.cardW + rowWidths[i], h: Math.max(s.cardH, s.rowH, l.takeH) }))
  const n = scenes.length
  const cols = opts.style === 'rows' ? Math.min(1, n) : opts.style === 'strip' ? n
    : resolveCols(n, sizes.reduce((a, s) => a + s.w, 0) / (n || 1), sizes.reduce((a, s) => a + s.h, 0) / (n || 1), input.stage.w / input.stage.h, opts.gridCols, gap.x, gap.y)
  const widths = Array<number>(cols).fill(0), heights = Array<number>(Math.ceil(n / (cols || 1))).fill(0)
  sizes.forEach((s, i) => { widths[i % cols] = Math.max(widths[i % cols], s.w); heights[Math.floor(i / cols)] = Math.max(heights[Math.floor(i / cols)], s.h) })
  const offsets = (values: number[], spacing: number) => { let at = 0; return values.map((v) => { const out = at; at += v + spacing; return out }) }
  const xs = offsets(widths, gap.x), ys = offsets(heights, gap.y)
  const gridW = widths.reduce((a, w) => a + w, 0) + Math.max(0, cols - 1) * gap.x
  const gridH = heights.reduce((a, h) => a + h, 0) + Math.max(0, heights.length - 1) * gap.y
  const oldBoxes = [...scenes.map((s) => ({ ...s.pos, w: s.cardW, h: s.cardH })), ...assets.map((a) => ({ ...a.pos, w: a.w, h: a.h })), ...folders.map((f) => ({ ...f.pos, w: f.w, h: f.h }))]
  const anchor = opts.scope === 'selection' ? bounds(oldBoxes) : { x: l.assetX, y: l.scenesY }
  let x0 = opts.scope === 'all' ? l.scenesX : anchor.x, y0 = anchor.y
  const next = new Map<string, XY>(), boxes: PreviewBox[] = [], occupied: Box[] = []
  const place = (item: { id: string; w: number; h: number }, pos: XY, kind: PreviewBox['kind']) => { next.set(item.id, pos); boxes.push({ ...pos, w: item.w, h: item.h, id: item.id, kind }) }
  if (opts.refs !== 'keep' && assets.length) {
    let x = opts.style === 'strip' ? x0 : anchor.x, y = anchor.y, span = 0
    const cap = opts.style === 'strip' ? Math.max(gridW, 4 * (l.assetW + gap.asset)) : opts.style === 'rows' ? Infinity : Math.max(gridH, l.assetH * 4 + gap.asset * 3, ...assets.map((a) => a.h))
    let previous: AssetKind | undefined
    for (const a of assets) {
      const extra = opts.refs === 'byKind' && previous && previous !== a.kind ? gap.kind : 0
      if (opts.style === 'strip') {
        x += extra
        if (x > x0 && x + a.w > x0 + cap) { x = x0; y += span + gap.asset; span = 0 }
        place(a, { x, y }, 'asset'); x += a.w + gap.asset; span = Math.max(span, a.h)
      } else {
        y += extra
        if (y > anchor.y && y + a.h > anchor.y + cap) { y = anchor.y; x += span + gap.asset; span = 0 }
        place(a, { x, y }, 'asset'); y += a.h + gap.asset; span = Math.max(span, a.w)
      }
      previous = a.kind
    }
    const refs = bounds(boxes)
    if (opts.style === 'strip') y0 = refs.y + refs.h + gap.top
    else x0 = Math.max(x0, refs.x + refs.w + gap.ref)
  }
  for (let i = 0; i < n; i++) {
    const s = scenes[i], pos = { x: x0 + xs[i % cols], y: y0 + ys[Math.floor(i / cols)] }
    place({ id: s.id, w: s.cardW, h: s.cardH }, pos, 'scene')
    occupied.push({ ...pos, ...sizes[i] })
    if (rowWidths[i]) boxes.push({ id: `slot:${s.id}`, kind: 'slot', x: pos.x + s.cardW + l.takeOffsetX, y: pos.y, w: rowWidths[i] - l.takeOffsetX, h: Math.max(l.takeH, s.rowH) })
  }
  occupied.push(...boxes.filter((b) => b.kind === 'asset'))
  const index = new BoxIndex(occupied)
  if (opts.refs === 'keep') {
    const still = new BoxIndex(assets.map((a) => ({ ...a.pos, w: a.w, h: a.h })))
    let left = x0 - gap.ref - Math.max(l.assetW, ...assets.map((a) => a.w)), y = y0
    for (const a of assets) {
      let pos = a.pos
      if (index.hits({ ...pos, w: a.w, h: a.h }).length) {
        let box = { x: left, y, w: a.w, h: a.h }, hits = still.hits(box)
        while (hits.length) { left = Math.min(...hits.map((b) => b.x)) - gap.ref - a.w; box = { ...box, x: left }; hits = still.hits(box) }
        pos = box; y += a.h + gap.asset; stats.assetsMoved++
      }
      place(a, pos, 'asset'); index.add({ ...pos, w: a.w, h: a.h }); still.add({ ...pos, w: a.w, h: a.h })
    }
  }
  const lifted: FolderIn[] = []
  for (const f of folders) {
    const box = { ...f.pos, w: f.w, h: f.h }
    if (opts.scope === 'selection' || opts.folders === 'top' || index.hits(box).length) lifted.push(f)
    else { place(f, f.pos, 'folder'); index.add(box) }
  }
  lifted.sort((a, b) => (a.firstSceneOrder ?? Infinity) - (b.firstSceneOrder ?? Infinity) || a.pos.x - b.pos.x)
  let folderX = x0
  const top = Math.min(y0, ...boxes.filter((b) => b.kind === 'asset').map((b) => b.y)) - gap.top
  for (const f of lifted) {
    let box = { x: folderX, y: top - f.h, w: f.w, h: f.h }, hits = index.hits(box)
    while (hits.length) { box.x = Math.max(...hits.map((b) => b.x + b.w)) + gap.asset; hits = index.hits(box) }
    place(f, box, 'folder'); index.add(box); folderX = box.x + f.w + gap.asset
    if (!samePosition(f.pos, box)) stats.foldersMoved++
  }
  // Include explicit follows in the block before collision placement and fitting; overlaps inside it are intentional.
  const sceneMap = new Map(scenes.map((s) => [s.id, s]))
  for (const t of input.takes) {
    const s = sceneMap.get(t.sceneId)
    if (!s || !t.shown) continue
    const dest = next.get(s.id)!
    const pos = opts.placedTakes === 'follow' && t.pos && t.offRow
      ? { x: t.pos.x + dest.x - s.pos.x, y: t.pos.y + dest.y - s.pos.y }
      : { x: dest.x + s.cardW + l.takeOffsetX + t.slot, y: dest.y }
    boxes.push({ id: t.id, kind: 'take', ...pos, w: t.w, h: t.h })
  }
  if (opts.scope === 'selection') {
    const d = placeBlock([...occupied, ...boxes], input.obstacles, anchor)
    stats.movedAway = d.movedAway
    for (const [id, pos] of next) next.set(id, { x: pos.x + d.dx, y: pos.y + d.dy })
    for (const box of boxes) { box.x += d.dx; box.y += d.dy }
  }
  const positions: Record<string, XY> = {}, takes: Record<string, XY | null> = {}
  for (const item of [...scenes, ...assets, ...folders]) {
    const pos = next.get(item.id)
    if (pos && !samePosition(item.pos, pos)) positions[item.id] = { x: pos.x, y: pos.y }
  }
  for (const t of input.takes) {
    const s = sceneMap.get(t.sceneId)
    if (!s || !t.pos) continue
    const dest = next.get(s.id)!
    const pos = opts.placedTakes === 'follow' && t.offRow ? { x: t.pos.x + dest.x - s.pos.x, y: t.pos.y + dest.y - s.pos.y } : null
    if (!samePosition(t.pos, pos)) { takes[t.id] = pos; if (pos) stats.takesFollow++; else stats.takesBack++ }
  }
  stats.moved = Object.keys(positions).length
  const bbox = bounds(boxes)
  const fitZoom = Math.min(1, input.stage.w / 1.12 / (bbox.w || 1), input.stage.h / 1.12 / (bbox.h || 1))
  let fitIds: string[] = []
  if (opts.scope === 'selection') fitIds = boxes.filter((b) => b.kind !== 'slot').map((b) => b.id)
  else if (fitZoom < 0.1 && n) {
    const focus = Math.max(0, scenes.findIndex((s) => s.id === input.focusId))
    const focusBox = (i: number): Box => ({ ...next.get(scenes[i].id)!, ...sizes[i] })
    const ids = new Set([scenes[focus].id])
    let region = focusBox(focus)
    for (let distance = 1; distance < n; distance++) {
      let grew = false
      for (const i of [focus - distance, focus + distance]) {
        if (i < 0 || i >= n) continue
        const candidate = bounds([region, focusBox(i)])
        if (candidate.w * 0.4 * 1.12 <= input.stage.w && candidate.h * 0.4 * 1.12 <= input.stage.h) {
          region = candidate; ids.add(scenes[i].id); grew = true
        }
      }
      if (!grew) break
    }
    fitIds = [...ids, ...input.takes.filter((t) => t.shown && ids.has(t.sceneId)).map((t) => t.id)]
  }
  return { positions, takes, boxes, bbox, fitIds, fitZoom, cols, stats }
}
