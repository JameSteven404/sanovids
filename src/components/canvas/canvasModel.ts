// Canvas-local helpers: cached lookups (scenes, assets, takes), take-node layout, selection expansion, hit-testing
// and a tiny hover store.
// Everything here is cheap and safe to call from zustand selectors.
import { create } from 'zustand'
import { assetByTag, extractMentions } from '../../core/compile'
import { selectedSceneIds } from '../../actions'
import { FOLDER_H, FOLDER_W } from '../../core/folders'
import { chooseTake, videoUsageOf } from '../../core/takes'
import type { Asset, AssetKind, JobStatus, Scene, Size, Take, XY } from '../../core/types'
import { ASSETS_MIME, readIds, TAKES_MIME } from '../../lib/dnd'
import { aspectOf, useImageMeta } from '../../lib/imageMeta'
import { defaultTakePosition, LAYOUT, NODE_SIZE, useProject, type Box } from '../../store/project'
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
 * A real move lands at least a whole grid step further.
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

/** Every Scene field is classified, including individual settings fields (guarded by graphSig.test). */
export const GRAPH_FIELDS = ['id', 'order', 'position', 'size', 'refs', 'videoRefs', 'settings.mode', 'firstFrame', 'lastFrame', 'color'] as const
export const NON_GRAPH_FIELDS = ['title', 'prompt', 'note', 'presetId', 'settings.model', 'settings.duration', 'settings.resolution', 'settings.ratio', 'foreignModel', 'foreignSettings'] as const

/** Array identities are weakly cached; only the most recent graph is retained for comparison. */
function graphCache<T extends object>(fieldsOf: (item: T) => unknown[]) {
  const items = new WeakMap<T, string>()
  const arrays = new WeakMap<T[], readonly string[]>()
  let last: readonly string[] = []
  return (list: T[]): readonly string[] => {
    const cached = arrays.get(list)
    if (cached) return last = cached
    const next = list.map((item) => {
      let key = items.get(item)
      if (key === undefined) {
        key = JSON.stringify(fieldsOf(item))
        items.set(item, key)
      }
      return key
    })
    if (next.length !== last.length || next.some((key, i) => key !== last[i])) last = next
    arrays.set(list, last)
    return last
  }
}

export const sceneGraphOf = graphCache<Scene>((s) => GRAPH_FIELDS.map((key) => key === 'settings.mode' ? s.settings.mode : s[key]))
export const assetGraphOf = graphCache<Asset>((a) => [a.id, a.position, a.size, a.color, a.kind])

const sceneAssetInputs = new WeakMap<Scene, WeakMap<Asset[], Asset[]>>()
/** Compile/excerpt inputs include frames and legacy tags, even when those assets are not linked as refs. */
export function sceneAssetsOf(assets: Asset[], scene: Scene): Asset[] {
  let byAssets = sceneAssetInputs.get(scene)
  if (!byAssets) sceneAssetInputs.set(scene, byAssets = new WeakMap())
  const cached = byAssets.get(assets)
  if (cached) return cached
  const map = assetMapOf(assets)
  const ids = new Set([...scene.refs, scene.firstFrame, scene.lastFrame])
  for (const tag of extractMentions(scene.prompt)) ids.add(assetByTag(assets, tag)?.id ?? null)
  const inputs = [...ids].flatMap((id) => id && map.has(id) ? [map.get(id)!] : [])
  byAssets.set(assets, inputs)
  return inputs
}

/** Hysteresis prevents minimap/wires flickering around the large-project threshold. */
export function bigCanvasState(count: number, wasBig: boolean, pref: 'auto' | 'off' = 'auto'): boolean {
  return pref === 'auto' && count >= (wasBig ? 700 : 800)
}

/** Quantize pan to a quarter viewport; the extra quarter covers movement before the next update. */
export function wireViewport(transform: readonly number[], width: number, height: number): Box | null {
  const [x, y, zoom] = transform
  if (!(width > 0 && height > 0 && zoom > 0)) return null
  const w = width / zoom, h = height / zoom
  return { x: Math.floor(-x / zoom / (w / 4)) * (w / 4) - w / 2, y: Math.floor(-y / zoom / (h / 4)) * (h / 4) - h / 2, w: w * 2.25, h: h * 2.25 }
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y
}

/** Endpoint culling deliberately excludes long wires crossing the viewport with both cards far away. */
export function wireNearViewport(source: string, target: string, near: ReadonlySet<string> | null, selected: boolean): boolean {
  return !near || selected || near.has(source) || near.has(target)
}

/** Session-only viewport: leaving Canvas unmounts React Flow today. */
export const canvasViewports = new Map<string, { x: number; y: number; zoom: number }>()
export const PREVIEW_DELAY_MS = 200

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

export { chooseTake, videoUsageOf }

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
 * Horizontal offset of each take node inside its row: the summed widths (+ gaps) of the auto-placed takes before it
 * next to the same scene (orphans: left of their anchor, counted separately). Takes may have different widths
 * (resized), so slots are accumulated instead of `index × (takeW + gap)`.
 * A take the user dragged away (`explicit`) leaves the row and reserves no room, so the next new take lands right
 * next to the scene instead of after every video ever made (10 takes, 9 dragged away: the 10th used to land ~2,200px
 * right of the card). One only nudged on its slot (`keeps(id, slotX)` true, see core/takes keepsSlot) keeps it, so
 * the takes after it do not slide under it. An explicit take's slot is where it would go back into the row (dropping
 * it there makes it auto-placed again, see isAutoSlot).
 */
export function takeSlots(
  items: readonly (Pick<TakeLayoutItem, 'id' | 'anchorId' | 'orphan'> & { explicit?: XY | null })[],
  widthOf: (id: string) => number,
  keeps?: (id: string, slotX: number) => boolean,
): Map<string, number> {
  const acc = new Map<string, number>()
  const out = new Map<string, number>()
  for (const item of items) {
    const key = (item.orphan ? 'o:' : 's:') + item.anchorId
    const x = acc.get(key) ?? 0
    out.set(item.id, x)
    if (!item.explicit || keeps?.(item.id, x)) acc.set(key, x + widthOf(item.id) + LAYOUT.takeGapX)
  }
  return out
}

/** Auto position of a take `slotX` px into the row right of a scene card `sceneW` wide (see takeSlots). */
export function autoTakePosition(scenePos: XY, sceneW: number, slotX: number): XY {
  return defaultTakePosition(scenePos, 0, sceneW + slotX)
}

/**
 * Row heights for project.autoLayout ("Sắp xếp"): per scene, its tallest node — the card (stored size, else the
 * height React Flow measured) and the take nodes shown in its row (same). Every take goes back to its auto slot next
 * to its scene, so a take resized to 420px makes its row 420px tall instead of covering the next scene. Takes hidden
 * by "Chỉ take chọn" and orphans (placed next to a scene that uses them, outside any row) do not count; unknown
 * heights are left out (autoLayout keeps its default row height).
 */
export function layoutRowHeights(
  scenes: readonly Pick<Scene, 'id' | 'size'>[],
  layout: { items: readonly Pick<TakeLayoutItem, 'id' | 'sceneId' | 'orphan' | 'size'>[] },
  measuredH: (id: string) => number | undefined,
): Record<string, number> {
  const out: Record<string, number> = {}
  const bump = (sceneId: string, h: number | undefined) => {
    if (h && h > (out[sceneId] ?? 0)) out[sceneId] = Math.ceil(h)
  }
  for (const s of scenes) bump(s.id, s.size?.h ?? measuredH(s.id))
  for (const item of layout.items) if (!item.orphan) bump(item.sceneId, item.size?.h ?? measuredH(item.id))
  return out
}

/**
 * Selection that React Flow's select / deselect changes are applied to. React Flow only deselects nodes it knows, so
 * ids without a canvas node (a take hidden by "Chỉ take chọn" picked in the library, an asset taken off the canvas by
 * an undo…) would survive every click and still be hit by Delete or C. A replacing selection (plain click, box)
 * therefore starts from the ids that are on the canvas; an additive one (Ctrl / Shift+click) keeps the rest.
 */
export function selectionSeed(selectedIds: readonly string[], replacing: boolean, onCanvas: (id: string) => boolean): string[] {
  return replacing ? selectedIds.filter(onCanvas) : [...selectedIds]
}

// ---------------- toolbar density ----------------
export type ToolbarDensity = 'full' | 'compact' | 'tight'
/**
 * Toolbar layout for a canvas `width` px wide. full: every label (~940px); compact: icons for Nối / Chạy, the two text
 * switches become one-button toggles (~680px); tight: also no zoom −/+ (~580px; it scrolls sideways below that).
 * 0 = not measured yet.
 */
export function toolbarDensity(width: number): ToolbarDensity {
  if (!width || width >= 1000) return 'full'
  return width >= 720 ? 'compact' : 'tight'
}
/** Below this canvas width the centered toolbar reaches the bottom-right minimap: the minimap moves up above it. */
export const MINIMAP_LIFT_W = 1400

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

/** A left/top resize moves the node too; otherwise a drag overrides its stored/automatic position. */
export function livePosition(id: string, base: XY, drag: Record<string, XY>, resizing: Record<string, ResizeBox>): XY {
  const box = resizing[id]
  return box?.x !== undefined && box.y !== undefined ? { x: box.x, y: box.y } : drag[id] ?? base
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

// ---------------- connection dots: where they sit, what the resize edges leave free ----------------
/** Poster height of a take node at its default size (16:9 inside the 1px borders, CSS aspect-ratio). */
export const TAKE_POSTER_H = ((LAYOUT.takeW - 2) * 9) / 16
/**
 * Height of the connection dots of an unresized take (the middle of its poster) — and of a scene card's two dots
 * (left reference dot, right take dot), so the scene → take wire of an unresized row runs straight. A handle's `top`:
 * px from the inside of the card's top border.
 */
export const DOT_TOP = TAKE_POSTER_H / 2
/**
 * `top` of a take's two dots: always the middle of its poster — default, resized (the poster grows with the node) or
 * zoomed out (the far card is only the poster). One rule, so resizing a take never makes its dots jump.
 */
export function takeDotTop(box: Size | null, far: boolean): number {
  return box ? fitMedia(box.w, box.h, far ? 0 : TAKE_CHROME).h / 2 : DOT_TOP
}

/** Half-height (flow px) of the gap a node's left / right resize edge leaves around each dot on that side. */
export const RESIZE_DOT_GAP = 12
/**
 * clip-path of a node's invisible left or right resize edge (an 8px strip as tall as the node, NodeSizer) that cuts a
 * gap around each dot on that side (`dotYs`: px from the node's top). The edge sits above the card, so without the gap
 * a press on a hovered / selected card's dot would start a resize instead of a wire (the scene's right dot → folder) or
 * the reconnect grip of a selected reference wire (which starts right of the scene's left dot). null = no dot.
 */
export function resizeEdgeClip(dotYs: readonly number[], gap: number = RESIZE_DOT_GAP): string | null {
  const spans: [number, number][] = []
  for (const y of [...dotYs].filter(Number.isFinite).sort((a, b) => a - b)) {
    const a = Math.max(0, y - gap)
    const b = y + gap
    const last = spans[spans.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else spans.push([a, b])
  }
  if (!spans.length) return null
  const px = (v: number) => `${Math.round(v * 100) / 100}px`
  // Down the strip's right side with an inward notch at each gap (a zero-width step along x = 0), back up the left side.
  const pts = ['0 0', '100% 0']
  for (const [a, b] of spans) pts.push(`100% ${px(a)}`, `0 ${px(a)}`, `0 ${px(b)}`, `100% ${px(b)}`)
  pts.push('100% 100%', '0 100%')
  return `polygon(${pts.join(', ')})`
}

// ---------------- asset node: the WHOLE reference image at its own aspect ratio ----------------
/**
 * Default width of an asset node (no size set by the user). Kept at the asset column width: a square card is then
 * 162 + 65 = 227px tall and still fits the LAYOUT.assetH + assetGapY (238px) slots that the seed, saved projects and
 * the "add to canvas" placement use. 200px made every square card ~247px tall, overlapping the card below it.
 */
export const ASSET_DEFAULT_W = LAYOUT.assetW
/** Asset node: left + right borders and padding beside the image (1 + 8 + 8 + 1). */
export const ASSET_PAD_X = 18
/** Asset node: borders + padding + name + meta rows around the image (2 + 8+9 + 8+19 + 3+16). */
export const ASSET_CHROME = 65
/** Aspect ratio (w / h) clamp of the image in an asset node: extreme panoramas / strips stay usable. */
export const ASSET_MIN_ASPECT = 0.4
export const ASSET_MAX_ASPECT = 2.6

/**
 * Default asset node (the user has not resized it): the image takes the card's inner width at its own aspect ratio
 * `aspect` (w / h, already clamped by aspectOf) and the card is image + name/meta rows tall, within NODE_SIZE.asset.
 * A very wide image in a card that would be shorter than minH gets a slightly taller (letterboxed) image box.
 */
export function assetDefaultLayout(aspect: number, w: number = ASSET_DEFAULT_W): { w: number; h: number; imgW: number; imgH: number } {
  const l = NODE_SIZE.asset
  const cw = Math.max(l.minW, Math.min(l.maxW, Math.round(w)))
  const imgW = cw - ASSET_PAD_X
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const imgH = Math.round(Math.max(l.minH - ASSET_CHROME, Math.min(l.maxH - ASSET_CHROME, imgW / a)))
  return { w: cw, h: imgH + ASSET_CHROME, imgW, imgH }
}

/**
 * Height an asset node is drawn at (layout of the asset column): its stored size, else the default card for its
 * image's aspect ratio when that is known (measured once per session), else the size React Flow last measured
 * (`measuredH`, possibly from before the image was measured), else a square card. Works for culled nodes too.
 */
export function assetNodeHeight(asset: Pick<Asset, 'size' | 'imageIds'>, measuredH?: number): number {
  if (asset.size) return asset.size.h
  const id = asset.imageIds[0]
  const known = id ? useImageMeta.getState().sizes[id] : undefined
  if (!id || known) return assetDefaultLayout(aspectOf(known, 1, ASSET_MIN_ASPECT, ASSET_MAX_ASPECT)).h
  return measuredH && measuredH > 0 ? measuredH : assetDefaultLayout(1).h
}

// ---------------- hover preview of a reference image (scene card avatars) ----------------
export const PREVIEW_MAX_W = 260
export const PREVIEW_MAX_H = 300
/** Card around the preview image: 6px padding (top and sides) + the caption row below (name · @image_N). */
export const PREVIEW_PAD = 6
export const PREVIEW_CAPTION_H = 24
export const PREVIEW_MIN_W = 170

/** Preview image box: the image's own aspect ratio, as large as fits `maxW` × `maxH`. */
export function previewSize(aspect: number, maxW: number = PREVIEW_MAX_W, maxH: number = PREVIEW_MAX_H): { w: number; h: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const w = Math.min(maxW, maxH * a)
  return { w: Math.round(w), h: Math.round(Math.min(maxH, w / a)) }
}

/**
 * Screen position (position: fixed) of a popover `w` × `h` centered above `anchor`; below it when there is no room
 * above. Always kept `margin` px inside the `vw` × `vh` viewport.
 */
export function placePopover(
  anchor: { left: number; top: number; right: number; bottom: number },
  w: number,
  h: number,
  vw: number,
  vh: number,
  gap = 10,
  margin = 8,
): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi), v))
  const left = clamp((anchor.left + anchor.right) / 2 - w / 2, margin, vw - w - margin)
  let top = anchor.top - gap - h
  if (top < margin) top = anchor.bottom + gap
  top = clamp(top, margin, vh - h - margin)
  return { left: Math.round(left), top: Math.round(top) }
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
  return selectionCount(ids, sceneMapOf(useProject.getState().project.scenes))
}

/** Count of selected ids that are take nodes. */
export function countTakes(ids: string[]): number {
  return selectionCount(ids, takeIndexOf(useRuns.getState().takes).byId)
}

const selectionCounts = new WeakMap<string[], WeakMap<object, number>>()
function selectionCount(ids: string[], map: ReadonlyMap<string, unknown>): number {
  let counts = selectionCounts.get(ids)
  if (!counts) selectionCounts.set(ids, counts = new WeakMap())
  let count = counts.get(map)
  if (count === undefined) {
    count = 0
    for (const id of ids) if (map.has(id)) count++
    counts.set(map, count)
  }
  return count
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

// ---------------- viewport moves (focus / reveal / fit) ----------------
export interface Viewport {
  x: number
  y: number
  zoom: number
}
/** Stage of the canvas in px: `bottom` px at the bottom are covered (queue drawer + toolbar band). */
export interface StageSize {
  w: number
  h: number
  bottom: number
}
/** Room kept free around a revealed / focused node (px): the top keeps clear of the toasts below the top bar. */
export const VIEW_MARGIN = { top: 64, side: 32, bottom: 24 }

/** Visible part of the canvas in flow coordinates (without the covered bottom band). */
export function visibleFlowRect(vp: Viewport, stage: StageSize): Box {
  return { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: stage.w / vp.zoom, h: Math.max(0, stage.h - stage.bottom) / vp.zoom }
}

/** Smallest box around all `boxes` (null when empty). */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const b of boxes) {
    x1 = Math.min(x1, b.x)
    y1 = Math.min(y1, b.y)
    x2 = Math.max(x2, b.x + b.w)
    y2 = Math.max(y2, b.y + b.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** Is `box` entirely on screen (above the covered band)? */
export function boxOnScreen(box: Box, vp: Viewport, stage: StageSize): boolean {
  const v = visibleFlowRect(vp, stage)
  return box.x >= v.x && box.y >= v.y && box.x + box.w <= v.x + v.w && box.y + box.h <= v.y + v.h
}

/** Free area of the stage (px) for a revealed / focused node. */
function stageArea(stage: StageSize) {
  const left = VIEW_MARGIN.side
  const right = Math.max(left + 1, stage.w - VIEW_MARGIN.side)
  const top = Math.min(VIEW_MARGIN.top, Math.max(0, (stage.h - stage.bottom) / 3))
  const bottom = Math.max(top + 1, stage.h - stage.bottom - VIEW_MARGIN.bottom)
  return { left, right, top, bottom }
}

/** Viewport with `box` centred in the free area at `zoom`. */
function centred(box: Box, stage: StageSize, zoom: number): Viewport {
  const a = stageArea(stage)
  return { x: (a.left + a.right) / 2 - (box.x + box.w / 2) * zoom, y: (a.top + a.bottom) / 2 - (box.y + box.h / 2) * zoom, zoom }
}

/**
 * A node was just created: the viewport that shows it by panning the least, at the SAME zoom (the rest of the board
 * must not fly away). Zooms out only when the box cannot fit at all. null = already entirely visible (no move).
 */
export function revealViewport(box: Box, vp: Viewport, stage: StageSize, minZoom = 0.1): Viewport | null {
  if (boxOnScreen(box, vp, stage)) return null
  const a = stageArea(stage)
  const zoom = Math.max(minZoom, Math.min(vp.zoom, (a.right - a.left) / Math.max(1, box.w), (a.bottom - a.top) / Math.max(1, box.h)))
  if (zoom < vp.zoom) return centred(box, stage, zoom)
  let { x, y } = vp
  const sx1 = box.x * zoom + x
  const sx2 = (box.x + box.w) * zoom + x
  if (sx1 < a.left) x += a.left - sx1
  else if (sx2 > a.right) x -= sx2 - a.right
  const sy1 = box.y * zoom + y
  const sy2 = (box.y + box.h) * zoom + y
  if (sy1 < a.top) y += a.top - sy1
  else if (sy2 > a.bottom) y -= sy2 - a.bottom
  return { x, y, zoom }
}

/**
 * "Đi tới" a node that is off-screen: centred, zoomed in to at least `readable` (never out from the current zoom
 * unless it cannot fit). null = already entirely visible.
 */
export function focusViewport(box: Box, vp: Viewport, stage: StageSize, readable = 0.8, minZoom = 0.1): Viewport | null {
  if (boxOnScreen(box, vp, stage)) return null
  const a = stageArea(stage)
  const fit = Math.min((a.right - a.left) / Math.max(1, box.w), (a.bottom - a.top) / Math.max(1, box.h))
  return centred(box, stage, Math.max(minZoom, Math.min(Math.max(vp.zoom, readable), fit)))
}

/** Size a node is drawn at before React Flow measured it (new or never rendered): the default card sizes. */
export function fallbackNodeSize(type: string | undefined): { w: number; h: number } {
  if (type === 'take') return { w: LAYOUT.takeW, h: LAYOUT.takeH }
  if (type === 'folder') return { w: FOLDER_W, h: FOLDER_H }
  if (type === 'asset') return { w: ASSET_DEFAULT_W, h: assetDefaultLayout(1).h }
  return { w: LAYOUT.sceneW, h: NODE_SIZE.scene.minH }
}

/**
 * Positions of several cards dropped at once, from `base`: rows of `perRow` cards (each card's own width + `gap`),
 * each row below the tallest card of the previous one — not one long line thousands of px wide.
 */
export function gridPositions(base: XY, sizes: readonly { w: number; h: number }[], perRow = 4, gap: number = LAYOUT.assetGapY): XY[] {
  const out: XY[] = []
  let y = base.y
  for (let i = 0; i < sizes.length; i += perRow) {
    const row = sizes.slice(i, i + perRow)
    let x = base.x
    for (const s of row) {
      out.push({ x, y })
      x += s.w + gap
    }
    y += Math.max(...row.map((s) => s.h)) + gap
  }
  return out
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

/** Overlays on the stage that block a wire drop (it must not fall through to the canvas or a card underneath). */
export const DROP_BLOCKERS = '.cv-toolbar, .cv-sel-hint, .cv-menu, .react-flow__minimap, .react-flow__panel'

/**
 * The React Flow node under a screen point (ignores the connection line), or null. 'pane' when over empty canvas.
 * Anything on top of the canvas but outside `root` (queue drawer, toasts, panels) blocks the drop: null. So do the
 * stage's own overlays (DROP_BLOCKERS: toolbar, selection hint, menu, minimap).
 */
export function hitTest(x: number, y: number, root: HTMLElement | null): { kind: 'node'; id: string } | { kind: 'pane' } | null {
  const els = document.elementsFromPoint(x, y)
  for (const el of els) {
    if (root && !root.contains(el)) return null
    if (el.closest(DROP_BLOCKERS)) return null
    const node = el.closest<HTMLElement>('.react-flow__node')
    if (node?.dataset.id) return { kind: 'node', id: node.dataset.id }
    if (el.classList.contains('react-flow__pane')) return { kind: 'pane' }
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

/** What the inline-field key helpers read of a keyboard event. */
export interface InlineKey {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/** A modifier pressed on its own: never a shortcut (React Flow would take a lone Ctrl / Shift as its selection keys). */
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'AltGraph', 'Shift', 'OS', 'Super', 'Hyper', 'CapsLock', 'Fn', 'FnLock'])

/**
 * Should a key pressed in an inline text field on a node (scene title, take name, the editor on a scene card) reach the
 * global shortcuts? Only a chord of a command that runs while typing (`isTypingChord`, from the keymap: Ctrl+S saves,
 * Ctrl+Enter runs…). Never Escape (the field cancels the edit itself), never a modifier pressed alone.
 */
export function inlineKeyBubbles<E extends InlineKey>(e: E, isTypingChord: (e: E) => boolean): boolean {
  if (e.key === 'Escape' || MODIFIER_KEYS.has(e.key)) return false
  return isTypingChord(e)
}

/**
 * The save chord pressed in an inline text field (`isSaveChord`, from the keymap): the global shortcut saves the
 * project right after, so the field must put its draft in the store first (other combos — copy, paste, undo inside the
 * field — must not create history steps).
 */
export function inlineKeySavesDraft<E extends InlineKey>(e: E, isSaveChord: (e: E) => boolean): boolean {
  if (MODIFIER_KEYS.has(e.key)) return false
  return isSaveChord(e)
}

/** Today's commands that run while typing (useShortcuts): any Ctrl/Cmd combination. The keymap (0.6.0) replaces it. */
export const legacyTypingChord = (e: InlineKey): boolean => e.ctrlKey || e.metaKey
/** Today's save chord (useShortcuts): Ctrl/Cmd+S without Alt. */
export const legacySaveChord = (e: InlineKey): boolean => (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's'

/**
 * @deprecated use inlineKeyBubbles(e, isTypingChord). Wrapper with today's chords: Ctrl/Cmd combos bubble; plain keys,
 * Escape — and now a lone Ctrl / Cmd — do not.
 */
export function inlineEditKeyBubbles(e: InlineKey): boolean {
  return inlineKeyBubbles(e, legacyTypingChord)
}

/** @deprecated use inlineKeySavesDraft(e, isSaveChord). Wrapper with today's save chord (Ctrl/Cmd+S). */
export function inlineEditSavesDraft(e: InlineKey): boolean {
  return inlineKeySavesDraft(e, legacySaveChord)
}

/**
 * Size React Flow measured for a node (undefined = not measured yet), read outside React.
 */
export function measuredOf(id: string): { width: number; height: number } | undefined {
  return useCanvasLocal.getState().measured[id]
}

// ---------------- hover store (edges + cut button need a little grace period) ----------------
interface CanvasLocal {
  projectId: string | null
  big: boolean
  resetProject: (id: string) => void
  hoveredId: string | null
  setHovered: (id: string | null) => void
  dragPos: Record<string, XY>
  setDragPos: (pos: Record<string, XY>) => void
  clearDragPos: (ids?: string[]) => void
  measured: Record<string, { width: number; height: number }>
  measuredVersion: number
  setMeasured: (sizes: Record<string, { width: number; height: number }>) => void
  hoveredEdgeId: string | null
  setHoveredEdge: (id: string | null) => void
  /** Nodes whose resize handle is being dragged: their live box (committed to the stores on resize end). */
  resizing: Record<string, ResizeBox>
  setResizing: (boxes: Record<string, ResizeBox>) => void
  clearResizing: (id: string) => void
}
let measureFrame: number | null = null
export const useCanvasLocal = create<CanvasLocal>()((set) => ({
  projectId: null,
  big: false,
  resetProject: (projectId) => {
    if (useCanvasLocal.getState().projectId === projectId) return
    if (measureFrame !== null) cancelAnimationFrame(measureFrame)
    measureFrame = null
    keepHover()
    set({ projectId, big: false, measured: {}, measuredVersion: 0, dragPos: {}, resizing: {}, hoveredId: null, hoveredEdgeId: null })
  },
  hoveredId: null,
  setHovered: (hoveredId) => set((s) => s.hoveredId === hoveredId ? s : { hoveredId }),
  dragPos: {},
  setDragPos: (pos) => set((s) => ({ dragPos: { ...s.dragPos, ...pos } })),
  clearDragPos: (ids) => set((s) => {
    const dragPos = ids ? { ...s.dragPos } : {}
    for (const id of ids ?? []) delete dragPos[id]
    return { dragPos }
  }),
  measured: {},
  measuredVersion: 0,
  setMeasured: (sizes) => {
    // Measurements are readable immediately; subscribers are notified only once per animation frame.
    const measured = useCanvasLocal.getState().measured
    let changed = false
    for (const [id, size] of Object.entries(sizes)) {
      const old = measured[id]
      if (!old || old.width !== size.width || old.height !== size.height) {
        measured[id] = size
        changed = true
      }
    }
    if (changed && measureFrame === null) measureFrame = requestAnimationFrame(() => {
      measureFrame = null
      set((s) => ({ measuredVersion: s.measuredVersion + 1 }))
    })
  },
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

// Project switches can happen while Canvas is unmounted; the sidebar must never read the previous measurements.
useCanvasLocal.getState().resetProject(useProject.getState().project.id)
useProject.subscribe((s, prev) => {
  if (s.project.id !== prev.project.id) useCanvasLocal.getState().resetProject(s.project.id)
})

/**
 * Color with alpha: hex ('#4fb6a8', 0.7 -> '#4fb6a8b3'), anything else (a theme token such as 'var(--ref)') through
 * color-mix, so wire colors can follow the light / dark theme.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha))
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return (
      color +
      Math.round(a * 255)
        .toString(16)
        .padStart(2, '0')
    )
  }
  return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`
}
