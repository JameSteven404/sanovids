// Canvas-local helpers: cached lookups (scenes, assets, takes), take-node layout, selection expansion, hit-testing
// and a tiny hover store.
// Everything here is cheap and safe to call from zustand selectors.
import { create } from 'zustand'
import { selectedSceneIds } from '../../actions'
import type { Asset, AssetKind, JobStatus, Scene, Size, Take, XY } from '../../core/types'
import { ASSETS_MIME, readIds, TAKES_MIME } from '../../lib/dnd'
import { defaultTakePosition, LAYOUT, NODE_SIZE, useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI, type TakeDisplay } from '../../store/ui'

/** Canvas-only event: always fit the view to these ids (all when empty). `focus` (actions.focusNodes) is gentler. */
export { FIT_EVENT } from '../../actions'
export const GRID = 16
export const LOD_ZOOM = 0.55

export const snap = (v: number) => Math.round(v / GRID) * GRID

/**
 * Was a take node dropped on its auto slot `auto` (so it stays auto-placed and keeps following its scene)?
 * Auto slots are off the snap grid, and React Flow snaps every single-node drag to the grid point nearest the node's
 * start (even a click with 2–3px of mouse jitter becomes such a "drag"), so that grid point counts as the slot too.
 * Arrow-key moves land a whole grid step further and are real moves.
 */
export function isAutoSlot(auto: XY, pos: XY): boolean {
  const on = (slot: number, v: number) => Math.abs(v - slot) < 0.5 || Math.abs(v - snap(slot)) < 0.5
  return on(auto.x, pos.x) && on(auto.y, pos.y)
}

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
      .map(
        (t) =>
          `${t.id}:${t.sceneId}:${t.number}:${t.position ? `${t.position.x},${t.position.y}` : ''}:${t.size ? `${t.size.w}x${t.size.h}` : ''}:${t.starred ? 1 : 0}:${t.status}`,
      )
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
  /** The take's own scene (for an orphan: the deleted scene's id). */
  sceneId: string
  /** Slot among the scene's SHOWN takes (auto placement to the right of the scene); orphans: slot among the orphans of `anchorId`. */
  index: number
  /** Position the user dragged the node to; null = auto. */
  explicit: XY | null
  /** Takes of the same scene hidden by the "chosen only" display (badge "+N"; only on the chosen take). */
  hidden: number
  status: JobStatus
  /** Its scene was deleted but a scene still uses it as @video: no 'out' wire and no auto slot. */
  orphan: boolean
  /** Scene the node is placed next to: its own scene, or (orphan) the first scene that uses it. */
  anchorId: string
  /** Size set by the user (resize handle); null = default (LAYOUT.takeW × auto). */
  size: Size | null
}
export interface TakeLayout {
  items: TakeLayoutItem[]
  byId: Map<string, TakeLayoutItem>
}

/**
 * Which take nodes are shown and where. `all`: every take of every existing scene. `chosen`: the chosen take of
 * each scene, plus takes that some scene uses as @video (so their wires stay visible). In both modes a take whose
 * scene was deleted stays (as an orphan) while some scene uses it as @video: its wire, and the node to select or
 * delete it, must not vanish while the video is still sent.
 */
export function layoutTakes(takes: Take[], scenes: Scene[], mode: TakeDisplay): TakeLayout {
  const idx = takeIndexOf(takes)
  const usage = videoUsageOf(scenes)
  const used = mode === 'chosen' ? usage : null
  const items: TakeLayoutItem[] = []
  const byId = new Map<string, TakeLayoutItem>()
  const add = (item: TakeLayoutItem) => {
    items.push(item)
    byId.set(item.id, item)
  }
  for (const s of scenes) {
    const list = idx.byScene.get(s.id)
    if (!list) continue
    const chosen = idx.chosen.get(s.id)
    const shown = used ? list.filter((t) => t === chosen || used.has(t.id)) : list
    const hidden = list.length - shown.length
    shown.forEach((t, index) =>
      add({
        id: t.id,
        sceneId: s.id,
        index,
        explicit: t.position,
        hidden: t === chosen ? hidden : 0,
        status: t.status,
        orphan: false,
        anchorId: s.id,
        size: t.size ?? null,
      }),
    )
  }
  let byOrder: Scene[] | null = null
  const perAnchor = new Map<string, number>()
  for (const takeId of usage.keys()) {
    const t = idx.byId.get(takeId)
    if (!t || sceneMapOf(scenes).has(t.sceneId)) continue
    byOrder ??= [...scenes].sort((a, b) => a.order - b.order)
    const anchor = byOrder.find((s) => s.videoRefs.includes(takeId))!
    const index = perAnchor.get(anchor.id) ?? 0
    perAnchor.set(anchor.id, index + 1)
    add({ id: t.id, sceneId: t.sceneId, index, explicit: t.position, hidden: 0, status: t.status, orphan: true, anchorId: anchor.id, size: t.size ?? null })
  }
  return { items, byId }
}

/**
 * Fallback spot of the `index`-th orphan take of a scene (when it has no dragged or previously shown position): left
 * of the scene that uses it, so its @video wire into the scene's left handle stays short.
 */
export function orphanTakePosition(
  anchorPos: XY,
  index: number,
  slotX: number = index * (LAYOUT.takeW + LAYOUT.takeGapX),
  width: number = LAYOUT.takeW,
): XY {
  return { x: anchorPos.x - LAYOUT.takeOffsetX - slotX - width, y: anchorPos.y }
}

/**
 * Horizontal offset of each take node inside its row: the summed widths (+ gaps) of the takes placed before it next
 * to the same scene (orphans: left of their anchor, counted separately). Takes may have different widths (resized),
 * so slots are accumulated instead of `index × (takeW + gap)`. Explicitly placed takes keep their slot reserved.
 */
export function takeSlots(items: readonly Pick<TakeLayoutItem, 'id' | 'anchorId' | 'orphan'>[], widthOf: (id: string) => number): Map<string, number> {
  const acc = new Map<string, number>()
  const out = new Map<string, number>()
  for (const item of items) {
    const key = (item.orphan ? 'o:' : 's:') + item.anchorId
    const x = acc.get(key) ?? 0
    out.set(item.id, x)
    acc.set(key, x + widthOf(item.id) + LAYOUT.takeGapX)
  }
  return out
}

/** Auto position of a take `slotX` px into the row right of a scene card `sceneW` wide (see takeSlots). */
export function autoTakePosition(scenePos: XY, sceneW: number, slotX: number): XY {
  return defaultTakePosition(scenePos, 0, sceneW + slotX)
}

// ---------------- node sizes (resize handles) ----------------
export type SizedKind = keyof typeof NODE_SIZE
/** Live box of a node while its resize handle is dragged (committed once on resize end). */
export interface ResizeBox {
  w: number
  h: number
  /** Set when the resize moved the node (dragging the left / top edge). */
  x?: number
  y?: number
}

/** Prompt line height of the scene card (12px × 1.42). */
export const PROMPT_LINE_H = 17
/** Scene card chrome around the prompt: head, refs row, footer (+ the take status line when the scene has takes). */
export const SCENE_CHROME = 118
export const SCENE_TAKE_LINE_H = 22
/** Prompt lines that fit a scene card `h` px tall (at least 2, like the default card). */
export function promptLines(h: number, hasTakeLine = false): number {
  const avail = h - SCENE_CHROME - (hasTakeLine ? SCENE_TAKE_LINE_H : 0)
  return Math.max(2, Math.floor(avail / PROMPT_LINE_H))
}
/** Characters of the prompt worth rendering for `lines` lines in a card `w` px wide (never below the default 280). */
export function excerptChars(lines: number, w: number): number {
  return Math.max(280, Math.ceil(lines * Math.max(1, (w - 22) / 5.5)))
}

export const DEFAULT_AVATARS = 6
const AVATAR_STEP = 19
/** Avatars shown before "+N" in a scene card `w` px wide, leaving room for `videoThumbs` @video thumbs. */
export function avatarSlots(w: number, videoThumbs = 0): number {
  const videoW = videoThumbs ? 12 + videoThumbs * 38 : 0
  const fit = Math.floor((w - 22 - videoW - 40) / AVATAR_STEP)
  const wanted = DEFAULT_AVATARS + Math.floor((w - LAYOUT.sceneW) / AVATAR_STEP)
  return Math.max(2, Math.min(wanted, fit))
}

/** Take node: chrome below the poster (footer + big download button). */
export const TAKE_CHROME = 74
/** Largest 16:9 box that fits a node `w` × `h` (1px borders) above `chrome` px of controls. */
export function fitMedia(w: number, h: number, chrome: number): { w: number; h: number } {
  const innerW = Math.max(0, w - 2)
  const maxH = Math.max(0, h - 2 - chrome)
  const ph = Math.min((innerW * 9) / 16, maxH)
  return { w: Math.round((ph * 16) / 9), h: Math.round(ph) }
}

/** Asset node: borders + padding + name + meta rows around the image (2 + 17 + 8+19 + 3+16). */
export const ASSET_CHROME = 65
/** Side of the square asset image in a node `w` × `h`. */
export function assetImageSide(w: number, h: number): number {
  return Math.max(40, Math.floor(Math.min(w - 18, h - ASSET_CHROME)))
}

/** Back to the default size (scene / asset: one undo step; take: runs store). */
export function resetNodeSize(id: string) {
  const p = useProject.getState().project
  const cur = sceneMapOf(p.scenes).get(id) ?? assetMapOf(p.assets).get(id)
  if (cur) {
    if (cur.size) useProject.getState().setNodeSizes({ [id]: null })
    return
  }
  const take = takeIndexOf(useRuns.getState().takes).byId.get(id)
  if (take?.size) useRuns.getState().setTakeSizes({ [id]: null })
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

// ---------------- HTML5 drag & drop (payload types: src/lib/dnd.ts) ----------------
const hasType = (dt: DataTransfer | null, type: string) => !!dt && Array.from(dt.types).includes(type)
/** Library cards (asset ids). */
export const hasAssetDrag = (dt: DataTransfer | null) => hasType(dt, ASSETS_MIME)
/** Generated videos (take ids) from the library "Video đã tạo" list or a take strip. */
export const hasTakeDrag = (dt: DataTransfer | null) => hasType(dt, TAKES_MIME)
export const hasFileDrag = (dt: DataTransfer | null) => hasType(dt, 'Files')
/** Asset ids of a drop (only readable in `drop`), or null when it is not an asset drag. */
export const readAssetIds = (dt: DataTransfer | null): string[] | null => (dt && hasAssetDrag(dt) ? readIds(dt, ASSETS_MIME) : null)
/** Take ids of a drop (only readable in `drop`); empty when it is not a take drag. */
export const readTakeIds = (dt: DataTransfer | null): string[] => (dt && hasTakeDrag(dt) ? readIds(dt, TAKES_MIME) : [])
export const imageFiles = (dt: DataTransfer | null) => (dt ? Array.from(dt.files).filter((f) => /^image\//.test(f.type)) : [])

/**
 * Can these dragged takes become @video of `sceneId`? At least one must be finished and come from another scene.
 * Safe inside a ui selector (returns a boolean).
 */
export function takesUsableFor(takeIds: string[], sceneId: string): boolean {
  const byId = takeIndexOf(useRuns.getState().takes).byId
  return takeIds.some((id) => {
    const t = byId.get(id)
    return !!t && t.status === 'completed' && t.sceneId !== sceneId
  })
}

/** A drag over this element would land on empty canvas (not on a node, the minimap or another overlay). */
export function isEmptyCanvasTarget(target: EventTarget | null): boolean {
  const el = typeof Element !== 'undefined' && target instanceof Element ? target : null
  if (!el || !el.closest('.react-flow')) return false
  return !el.closest('.react-flow__node, .react-flow__panel, .react-flow__minimap, .react-flow__edgelabel-renderer')
}

/**
 * Should a key pressed in an inline text field on a node (scene title) reach the global shortcuts? Ctrl/Cmd combos
 * do (useShortcuts: Ctrl+S saves, Ctrl+Enter runs, the others are ignored while typing); plain keys and Escape (the
 * field cancels the edit itself) do not.
 */
export function inlineEditKeyBubbles(e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return (e.ctrlKey || e.metaKey) && e.key !== 'Escape'
}

// ---------------- hover store (edges + cut button need a little grace period) ----------------
interface CanvasLocal {
  hoveredEdgeId: string | null
  setHoveredEdge: (id: string | null) => void
  /** Nodes whose resize handle is being dragged: their live box (committed to the stores on resize end). */
  resizing: Record<string, ResizeBox>
  setResizing: (boxes: Record<string, ResizeBox>) => void
  clearResizing: (id: string) => void
}
export const useCanvasLocal = create<CanvasLocal>()((set) => ({
  hoveredEdgeId: null,
  setHoveredEdge: (hoveredEdgeId) => set((s) => (s.hoveredEdgeId === hoveredEdgeId ? s : { hoveredEdgeId })),
  resizing: {},
  setResizing: (boxes) => set((s) => ({ resizing: { ...s.resizing, ...boxes } })),
  clearResizing: (id) =>
    set((s) => {
      if (!(id in s.resizing)) return s
      const next = { ...s.resizing }
      delete next[id]
      return { resizing: next }
    }),
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
