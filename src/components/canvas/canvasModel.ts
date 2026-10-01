// Canvas-local helpers: cached lookups, selection expansion, hit-testing and a tiny hover store.
// Everything here is cheap and safe to call from zustand selectors.
import { create } from 'zustand'
import { selectedSceneIds } from '../../actions'
import type { Asset, AssetKind, JobStatus, Scene, Take } from '../../core/types'
import { useProject } from '../../store/project'
import { useUI } from '../../store/ui'

/** HTML5 drag type used by the library (JSON array of asset ids). */
export const ASSETS_MIME = 'application/x-bdp-assets'
/** Canvas-only event: always fit the view to these ids (all when empty). `focus` (actions.focusNodes) is gentler. */
export { FIT_EVENT } from '../../actions'
export const GRID = 16
export const LOD_ZOOM = 0.55

export const snap = (v: number) => Math.round(v / GRID) * GRID

// ---------------- cached lookups (keyed by array identity) ----------------
const sceneMaps = new WeakMap<Scene[], Map<string, Scene>>()
export function sceneMapOf(scenes: Scene[]): Map<string, Scene> {
  let m = sceneMaps.get(scenes)
  if (!m) {
    m = new Map(scenes.map((s) => [s.id, s]))
    sceneMaps.set(scenes, m)
  }
  return m
}

const assetMaps = new WeakMap<Asset[], Map<string, Asset>>()
export function assetMapOf(assets: Asset[]): Map<string, Asset> {
  let m = assetMaps.get(assets)
  if (!m) {
    m = new Map(assets.map((a) => [a.id, a]))
    assetMaps.set(assets, m)
  }
  return m
}

const usageMaps = new WeakMap<Scene[], Map<string, number>>()
/** asset id -> number of scenes whose refs include it. */
export function usageOf(scenes: Scene[]): Map<string, number> {
  let m = usageMaps.get(scenes)
  if (!m) {
    m = new Map()
    for (const s of scenes) for (const r of s.refs) m.set(r, (m.get(r) ?? 0) + 1)
    usageMaps.set(scenes, m)
  }
  return m
}

export interface TakeSummary {
  count: number
  status: JobStatus | null
  progress: number
  /** Poster of the starred take (newest starred), else of the newest completed take. */
  posterId: string | null
}
const EMPTY_SUMMARY: TakeSummary = { count: 0, status: null, progress: 0, posterId: null }
const takeMaps = new WeakMap<Take[], Map<string, TakeSummary>>()
function takeMapOf(takes: Take[]): Map<string, TakeSummary> {
  let m = takeMaps.get(takes)
  if (m) return m
  m = new Map()
  const latest = new Map<string, Take>()
  const starred = new Map<string, Take>()
  const completed = new Map<string, Take>()
  const counts = new Map<string, number>()
  for (const t of takes) {
    counts.set(t.sceneId, (counts.get(t.sceneId) ?? 0) + 1)
    const l = latest.get(t.sceneId)
    if (!l || t.number > l.number) latest.set(t.sceneId, t)
    if (t.starred && t.posterId) {
      const s = starred.get(t.sceneId)
      if (!s || t.number > s.number) starred.set(t.sceneId, t)
    }
    if (t.status === 'completed' && t.posterId) {
      const c = completed.get(t.sceneId)
      if (!c || t.number > c.number) completed.set(t.sceneId, t)
    }
  }
  for (const [sceneId, l] of latest) {
    m.set(sceneId, {
      count: counts.get(sceneId) ?? 0,
      status: l.status,
      progress: l.progress,
      posterId: (starred.get(sceneId) ?? completed.get(sceneId))?.posterId ?? null,
    })
  }
  takeMaps.set(takes, m)
  return m
}
export function takeSummary(takes: Take[], sceneId: string): TakeSummary {
  return takeMapOf(takes).get(sceneId) ?? EMPTY_SUMMARY
}

export const STATUS_COLOR: Record<JobStatus, string> = {
  queued: 'var(--info)',
  processing: 'var(--accent)',
  completed: 'var(--ok)',
  failed: 'var(--danger)',
  cancelled: 'var(--text-faint)',
}
export const STATUS_HEX: Record<JobStatus, string> = {
  queued: '#7c9cff',
  processing: '#e8894a',
  completed: '#4cc38a',
  failed: '#ef5b5b',
  cancelled: '#6d7179',
}
export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Đang chờ',
  processing: 'Đang chạy',
  completed: 'Xong',
  failed: 'Lỗi',
  cancelled: 'Đã huỷ',
}

export const KIND_LABEL: Record<AssetKind, string> = {
  character: 'nhân vật',
  location: 'bối cảnh',
  prop: 'đạo cụ',
  style: 'phong cách',
}

/** Count of selected ids that are scenes (safe inside a ui selector: returns a number). */
export function countScenes(ids: string[]): number {
  if (!ids.length) return 0
  const map = sceneMapOf(useProject.getState().project.scenes)
  let n = 0
  for (const id of ids) if (map.has(id)) n++
  return n
}

// ---------------- multi-target expansion ----------------
/** Dropping on a scene that is part of a multi-scene selection targets the whole selection. */
export function targetScenesFor(sceneId: string): string[] {
  const sel = selectedSceneIds()
  return sel.length > 1 && sel.includes(sceneId) ? sel : [sceneId]
}
/**
 * Dragging from an asset card that is part of a multi-asset CANVAS selection carries that selection. The library
 * selection is deliberately ignored: it is invisible on the canvas, so a wire would silently link extra assets.
 */
export function sourceAssetsFor(assetId: string): string[] {
  const assets = assetMapOf(useProject.getState().project.assets)
  const sel = useUI.getState().selectedIds.filter((id) => assets.has(id))
  return sel.length > 1 && sel.includes(assetId) ? sel : [assetId]
}

/** Height the queue drawer covers at the bottom of the canvas (runs.css `--rq-drawer-h`: 36px bar, 272px open). */
export function drawerInset(el: HTMLElement | null): number {
  if (!el) return 36
  const v = parseFloat(getComputedStyle(el).getPropertyValue('--rq-drawer-h'))
  return Number.isFinite(v) ? v : 36
}

// ---------------- hit testing ----------------
export function clientPoint(e: MouseEvent | TouchEvent): { x: number; y: number } {
  if ('changedTouches' in e && e.changedTouches.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY }
  const m = e as MouseEvent
  return { x: m.clientX, y: m.clientY }
}

/**
 * The React Flow node under a screen point (ignores the connection line), or null. 'pane' when over empty canvas.
 * Anything on top of the canvas but outside `root` (queue drawer, toasts, panels) blocks the drop: null.
 */
export function hitTest(x: number, y: number, root: HTMLElement | null): { kind: 'node'; id: string } | { kind: 'pane' } | null {
  const els = document.elementsFromPoint(x, y)
  for (const el of els) {
    if (root && !root.contains(el)) return null
    const node = el.closest<HTMLElement>('.react-flow__node')
    if (node?.dataset.id) return { kind: 'node', id: node.dataset.id }
    if (el.classList.contains('react-flow__pane')) return { kind: 'pane' }
    if (el.closest('.cv-toolbar, .cv-menu, .react-flow__minimap, .react-flow__panel')) return null
  }
  return null
}

export function readAssetIds(dt: DataTransfer | null): string[] | null {
  if (!dt || !Array.from(dt.types).includes(ASSETS_MIME)) return null
  try {
    const ids = JSON.parse(dt.getData(ASSETS_MIME)) as unknown
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}
export const hasAssetDrag = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes(ASSETS_MIME)
export const hasFileDrag = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files')
export const imageFiles = (dt: DataTransfer | null) => (dt ? Array.from(dt.files).filter((f) => /^image\//.test(f.type)) : [])

// ---------------- hover store (edges + cut button need a little grace period) ----------------
interface CanvasLocal {
  hoveredEdgeId: string | null
  setHoveredEdge: (id: string | null) => void
}
export const useCanvasLocal = create<CanvasLocal>()((set) => ({
  hoveredEdgeId: null,
  setHoveredEdge: (hoveredEdgeId) => set((s) => (s.hoveredEdgeId === hoveredEdgeId ? s : { hoveredEdgeId })),
}))

let leaveTimer: ReturnType<typeof setTimeout> | null = null
/** Cancel a pending "hover ended" (pointer moved from a node onto its edge or the edge's × button). */
export function keepHover() {
  if (leaveTimer) clearTimeout(leaveTimer)
  leaveTimer = null
}
/** Clear node + edge hover after a short grace period. */
export function scheduleHoverEnd(clearNode: () => void, ms = 140) {
  keepHover()
  leaveTimer = setTimeout(() => {
    leaveTimer = null
    useCanvasLocal.getState().setHoveredEdge(null)
    clearNode()
  }, ms)
}

/** Hex color with alpha (e.g. '#4fb6a8', 0.7 -> '#4fb6a8b3'). Falls back to the input for non-hex colors. */
export function withAlpha(color: string, alpha: number): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return (
      color +
      Math.round(Math.max(0, Math.min(1, alpha)) * 255)
        .toString(16)
        .padStart(2, '0')
    )
  }
  return color
}
