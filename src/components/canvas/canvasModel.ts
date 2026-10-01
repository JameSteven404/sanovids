// Canvas-local helpers: cached lookups (scenes, assets, takes), take-node layout, selection expansion, hit-testing
// and a tiny hover store.
// Everything here is cheap and safe to call from zustand selectors.
import { create } from 'zustand'
import { selectedSceneIds } from '../../actions'
import type { Asset, AssetKind, JobStatus, Scene, Take, XY } from '../../core/types'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI, type TakeDisplay } from '../../store/ui'

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

// ---------------- takes (video nodes) ----------------
export interface TakeIndex {
  byId: Map<string, Take>
  /** Takes of each scene, oldest (lowest number) first. */
  byScene: Map<string, Take[]>
  /** Chosen take per scene: starred, else latest completed, else latest. */
  chosen: Map<string, Take>
}
const takeIndexes = new WeakMap<Take[], TakeIndex>()
/** Cached per takes array: every node selector shares one index per store update. */
export function takeIndexOf(takes: Take[]): TakeIndex {
  let idx = takeIndexes.get(takes)
  if (idx) return idx
  const byId = new Map<string, Take>()
  const byScene = new Map<string, Take[]>()
  for (const t of takes) {
    byId.set(t.id, t)
    const list = byScene.get(t.sceneId)
    if (list) list.push(t)
    else byScene.set(t.sceneId, [t])
  }
  const chosen = new Map<string, Take>()
  for (const [sceneId, list] of byScene) {
    list.sort((a, b) => a.number - b.number)
    chosen.set(sceneId, chooseTake(list)!)
  }
  idx = { byId, byScene, chosen }
  takeIndexes.set(takes, idx)
  return idx
}

/** Starred take, else the latest completed one, else the latest. `list` is sorted oldest first. */
export function chooseTake(list: Take[]): Take | undefined {
  let completed: Take | undefined
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]
    if (t.starred) return t
    if (!completed && t.status === 'completed') completed = t
  }
  return completed ?? list[list.length - 1]
}

export interface TakeSummary {
  count: number
  /** Status / progress of the latest take. */
  status: JobStatus | null
  progress: number
  /** Number of the starred take, if any. */
  starredNumber: number | null
  /** Queued or processing takes. */
  active: number
  /** Poster of the chosen take, else of the newest completed take. */
  posterId: string | null
}
const EMPTY_SUMMARY: TakeSummary = { count: 0, status: null, progress: 0, starredNumber: null, active: 0, posterId: null }
const summaries = new WeakMap<Take[], Map<string, TakeSummary>>()
export function takeSummary(takes: Take[], sceneId: string): TakeSummary {
  let m = summaries.get(takes)
  if (!m) {
    m = new Map()
    const idx = takeIndexOf(takes)
    for (const [id, list] of idx.byScene) {
      const latest = list[list.length - 1]
      const chosen = idx.chosen.get(id)
      let posterId = chosen?.posterId ?? null
      if (!posterId) for (let i = list.length - 1; i >= 0 && !posterId; i--) if (list[i].status === 'completed') posterId = list[i].posterId
      m.set(id, {
        count: list.length,
        status: latest.status,
        progress: latest.progress,
        starredNumber: list.find((t) => t.starred)?.number ?? null,
        active: list.filter((t) => t.status === 'queued' || t.status === 'processing').length,
        posterId,
      })
    }
    summaries.set(takes, m)
  }
  return m.get(sceneId) ?? EMPTY_SUMMARY
}

/**
 * Everything the canvas LAYOUT of take nodes depends on (+ status, for the minimap), as one string: a stable zustand
 * selection. Progress ticks do not change it, so the node list is not rebuilt 5×/s while videos render.
 */
const layoutSigs = new WeakMap<Take[], string>()
export function takeLayoutSig(takes: Take[]): string {
  let sig = layoutSigs.get(takes)
  if (sig === undefined) {
    sig = takes
      .map((t) => `${t.id}:${t.sceneId}:${t.number}:${t.position ? `${t.position.x},${t.position.y}` : ''}:${t.starred ? 1 : 0}:${t.status}`)
      .join('|')
    layoutSigs.set(takes, sig)
  }
  return sig
}

const videoUsage = new WeakMap<Scene[], Map<string, number>>()
/** take id -> number of scenes that use it as @video. */
export function videoUsageOf(scenes: Scene[]): Map<string, number> {
  let m = videoUsage.get(scenes)
  if (!m) {
    m = new Map()
    for (const s of scenes) for (const t of s.videoRefs) m.set(t, (m.get(t) ?? 0) + 1)
    videoUsage.set(scenes, m)
  }
  return m
}

export interface TakeLayoutItem {
  id: string
  sceneId: string
  /** Slot among the scene's SHOWN takes (auto placement to the right of the scene). */
  index: number
  /** Position the user dragged the node to; null = auto. */
  explicit: XY | null
  /** Takes of the same scene hidden by the "chosen only" display (badge "+N"; only on the chosen take). */
  hidden: number
  status: JobStatus
}
export interface TakeLayout {
  items: TakeLayoutItem[]
  byId: Map<string, TakeLayoutItem>
}

/**
 * Which take nodes are shown and where. `all`: every take of every existing scene. `chosen`: the chosen take of
 * each scene, plus takes that some scene uses as @video (so their wires stay visible).
 */
export function layoutTakes(takes: Take[], scenes: Scene[], mode: TakeDisplay): TakeLayout {
  const idx = takeIndexOf(takes)
  const used = mode === 'chosen' ? videoUsageOf(scenes) : null
  const items: TakeLayoutItem[] = []
  const byId = new Map<string, TakeLayoutItem>()
  for (const s of scenes) {
    const list = idx.byScene.get(s.id)
    if (!list) continue
    const chosen = idx.chosen.get(s.id)
    const shown = used ? list.filter((t) => t === chosen || used.has(t.id)) : list
    const hidden = list.length - shown.length
    shown.forEach((t, index) => {
      const item: TakeLayoutItem = { id: t.id, sceneId: s.id, index, explicit: t.position, hidden: t === chosen ? hidden : 0, status: t.status }
      items.push(item)
      byId.set(t.id, item)
    })
  }
  return { items, byId }
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

/** Count of selected ids that are take nodes. */
export function countTakes(ids: string[]): number {
  if (!ids.length) return 0
  const map = takeIndexOf(useRuns.getState().takes).byId
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

/** Dragging from a take that is part of a multi-take canvas selection carries that selection. */
export function sourceTakesFor(takeId: string): string[] {
  const takes = takeIndexOf(useRuns.getState().takes).byId
  const sel = useUI.getState().selectedIds.filter((id) => takes.has(id))
  return sel.length > 1 && sel.includes(takeId) ? sel : [takeId]
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
