// Undoable project store (zustand + zundo).
// Everything the user authors lives here: assets, presets, scenes (prompt, image refs, video refs), positions.
// Runs/takes live in ./runs.ts and UI-only state in ./ui.ts (not undoable).
//
// Whenever a scene's image refs / video refs change (or the images of an asset change), the @image_N / @video_N
// tokens in the affected prompts are renumbered in the same undo step (project.settings.autoRenumber).
import { temporal } from 'zundo'
import { create } from 'zustand'
import { assetByTag, extractMentions, HAS_TOKEN_RE, imageFallbackNames, mediaKeys, remapTokens, uniqueTag } from '../core/compile'
import { dropFolderLinks, FOLDER_H, FOLDER_W, withLink, type FolderLinkKind } from '../core/folders'
import { newId, pickColor } from '../core/ids'
import { foreignMarkOf } from '../core/foreignMark'
import { MODELS, normalizeSettings, usesVideoRefs } from '../core/models'
import type { Asset, Preset, Project, ProjectSettings, SaveFolder, Scene, Size, VideoSettings, XY } from '../core/types'
import { toast } from './ui'

// ---------- undo coalescing (typing in a textarea should not create one history step per key) ----------
let coalesceKey: string | null = null
let lastKey: string | null = null
let lastTime = 0
/** Call right before a set() that should merge with the previous one of the same key (e.g. 'prompt:<sceneId>'). */
function coalesce(key: string) {
  coalesceKey = key
}

/**
 * Canvas layout. Scenes are laid out one per row (S01 above S02…); each scene's takes (video nodes) extend to the
 * right of it in the same row. Assets sit in a column on the left.
 */
export const LAYOUT = {
  sceneW: 280,
  sceneH: 200,
  gapY: 48,
  scenesX: 420,
  scenesY: 60,
  /** Take (video) nodes */
  takeW: 224,
  takeH: 200,
  takeGapX: 16,
  /** Distance between the scene card's right edge and its first take. */
  takeOffsetX: 64,
  assetX: 40,
  assetW: 180,
  assetH: 210,
  assetGapY: 28,
}
/** Resize limits of canvas nodes (React Flow NodeResizer min/max). Defaults are LAYOUT sizes. */
export const NODE_SIZE = {
  scene: { minW: 240, maxW: 720, minH: 150, maxH: 760 },
  take: { minW: 180, maxW: 640, minH: 150, maxH: 560 },
  asset: { minW: 140, maxW: 520, minH: 150, maxH: 820 },
}

export function clampSize(kind: keyof typeof NODE_SIZE, size: Size): Size {
  const l = NODE_SIZE[kind]
  return { w: Math.round(Math.max(l.minW, Math.min(l.maxW, size.w))), h: Math.round(Math.max(l.minH, Math.min(l.maxH, size.h))) }
}

/** Height of one scene row (scene card or its takes, whichever is taller, plus the gap). */
export const ROW_H = Math.max(LAYOUT.sceneH, LAYOUT.takeH) + LAYOUT.gapY

/** Default canvas position of the i-th take (0 = oldest) of a scene at `scenePos`. */
/** `sceneW` = actual width of the scene card (resized cards push their takes right). `takeW` likewise. */
export function defaultTakePosition(scenePos: XY, index: number, sceneW: number = LAYOUT.sceneW, takeW: number = LAYOUT.takeW): XY {
  return { x: scenePos.x + sceneW + LAYOUT.takeOffsetX + index * (takeW + LAYOUT.takeGapX), y: scenePos.y }
}

export function defaultProjectSettings(): ProjectSettings {
  return { autoRenumber: true }
}

export function emptyProject(name = 'Dự án mới'): Project {
  const now = Date.now()
  return {
    id: newId('prj'),
    name,
    schemaVersion: 2,
    createdAt: now,
    updatedAt: now,
    assets: [],
    presets: defaultPresets(),
    scenes: [],
    settings: defaultProjectSettings(),
  }
}

export function defaultPresets(): Preset[] {
  return [
    { id: 'preset_draft', name: 'Nháp', model: 'seedance_2_5', mode: 't2v', duration: 30, resolution: '480p', ratio: '16:9' },
    { id: 'preset_final', name: 'Final', model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
    { id: 'preset_h3', name: 'H3 nháp', model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' },
  ]
}

export function scenePosition(index: number): XY {
  return { x: LAYOUT.scenesX, y: LAYOUT.scenesY + index * ROW_H }
}

/** Axis-aligned area on the canvas (flow coordinates). */
export interface Box extends XY {
  w: number
  h: number
}

/**
 * Where the take (video) nodes are. Takes live in the runs store, which imports this module, so the runs side
 * registers the lookup (store/takeRows.ts, wired in actions.ts) instead of this store importing it.
 * Only takes drawn IN a scene's row count for that row (auto-placed and shown under the "Video" display): one the
 * user dragged elsewhere or hid with "Chỉ take chọn" must not push the next scene down.
 */
export interface TakeLayoutSource {
  /** Height of the tallest take in the scene's row (0 = none). */
  rowHeight: (sceneId: string) => number
  /** Width of the scene's take row measured from the card's right edge (offset + takes + gaps; 0 = no takes). */
  rowWidth?: (sceneId: string) => number
  /** Takes placed by hand outside the rows (they are in the way of new nodes too). */
  placed?: () => Box[]
}
let takeSource: TakeLayoutSource = { rowHeight: () => 0 }
export function setTakeLayoutSource(src: TakeLayoutSource) {
  takeSource = src
}
/** Only the row heights (tests). */
export function setTakeHeightSource(fn: (sceneId: string) => number) {
  takeSource = { rowHeight: fn }
}

/** Height of a scene's row without the gap: its card or its tallest take in the row, whichever is taller (resized ones included). */
export function rowHeightOf(scene: Pick<Scene, 'id' | 'size'>): number {
  return Math.max(scene.size?.h ?? LAYOUT.sceneH, LAYOUT.takeH, takeSource.rowHeight(scene.id))
}

/** Area a scene's row takes in the card column (x, y, card width, row height). */
const sceneBox = (s: Scene): Box => ({ x: s.position.x, y: s.position.y, w: s.size?.w ?? LAYOUT.sceneW, h: rowHeightOf(s) })
/** Height of a new scene card's row (default size, no takes yet). */
const NEW_H = Math.max(LAYOUT.sceneH, LAYOUT.takeH)
/** A new scene card (default size, no takes yet). */
const newBox = (pos: XY): Box => ({ x: pos.x, y: pos.y, w: LAYOUT.sceneW, h: NEW_H })
/** Vertical distance under half a gap counts as touching (rows keep LAYOUT.gapY between them). */
const GAP_Y_HALF = LAYOUT.gapY / 2

/**
 * Do these areas overlap? Horizontally only a real overlap counts: a neighbouring column placed on the 16px snap grid
 * (16px away) is beside the card, not in its way. Vertically closer than half a gap counts.
 */
export function boxesTouch(a: Box, b: Box, gy: number = GAP_Y_HALF): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h + gy && b.y < a.y + a.h + gy
}

/** Every take row (right of its scene card) that has takes in it. */
function takeRowBoxes(p: Project): Box[] {
  const out: Box[] = []
  for (const s of p.scenes) {
    const w = takeSource.rowWidth?.(s.id) ?? 0
    if (w > 0) out.push({ x: s.position.x + (s.size?.w ?? LAYOUT.sceneW), y: s.position.y, w, h: rowHeightOf(s) })
  }
  return out
}

/** Nodes on the canvas that are not scene cards: asset nodes, folder nodes, take rows, takes placed by hand. */
function otherBoxes(p: Project): Box[] {
  const out = takeRowBoxes(p)
  for (const a of p.assets) {
    if (a.position) out.push({ x: a.position.x, y: a.position.y, w: a.size?.w ?? LAYOUT.assetW, h: a.size?.h ?? LAYOUT.assetH })
  }
  for (const f of p.folders ?? []) out.push({ x: f.position.x, y: f.position.y, w: f.size?.w ?? FOLDER_W, h: f.size?.h ?? FOLDER_H })
  return out.concat(takeSource.placed?.() ?? [])
}

/** Everything a new card must not land on. */
export function canvasObstacles(p: Project): Box[] {
  return p.scenes.map(sceneBox).concat(otherBoxes(p))
}

/**
 * First spot from `start` straight down where a new scene card overlaps none of `taken`: each time it would hit
 * something it moves just below it (one gap), so it lands right after what is there, never rows further.
 * Unbounded on purpose (below a scene: the end of its column) — a spot the user pointed at uses nearFreeSpot instead.
 */
export function slideDown(start: XY, taken: Box[]): XY {
  let y = start.y
  for (let i = 0; i < 10000; i++) {
    const box = newBox({ x: start.x, y })
    let next = -Infinity
    for (const t of taken) if (boxesTouch(t, box)) next = Math.max(next, t.y + t.h + LAYOUT.gapY)
    if (next === -Infinity) break
    y = next
  }
  return { x: start.x, y }
}

/** How far a spot the user pointed at may move to be free: about one row and a gap (ROW_H + gapY). */
export const NEAR_SPOT_MAX = ROW_H + LAYOUT.gapY

/**
 * Free spot for a new scene card near `start`, at most `maxDist` px away; null = none. `start` itself when it is free,
 * else the spots just below / above / left / right of what is in the way (and, a few steps deep, of what those hit).
 * Moving up or down only (same x, staying in a column) wins over moving sideways; then the nearest. It never slides
 * along a whole column: a double-click next to a long column of scenes or asset cards stays next to the click.
 * `within`: candidates must lie inside this area (the visible canvas).
 */
export function nearFreeSpot(start: XY, taken: readonly Box[], maxDist: number = NEAR_SPOT_MAX, within?: Box): XY | null {
  const reach: Box = { x: start.x - maxDist, y: start.y - maxDist, w: LAYOUT.sceneW + 2 * maxDist, h: NEW_H + 2 * maxDist }
  const near = taken.filter((t) => boxesTouch(t, reach))
  const inside = (q: XY) => !within || (q.x >= within.x && q.y >= within.y && q.x + LAYOUT.sceneW <= within.x + within.w && q.y + NEW_H <= within.y + within.h)
  const dist = (q: XY) => Math.hypot(q.x - start.x, q.y - start.y)
  let best: { at: XY; tier: number; d: number } | null = null
  const seen = new Set<string>([`${start.x},${start.y}`])
  const queue: XY[] = [start]
  for (let i = 0; i < queue.length && i < 256; i++) {
    const at = queue[i]
    const hits = near.filter((t) => boxesTouch(t, newBox(at)))
    if (!hits.length) {
      const tier = at.x === start.x ? 0 : 1
      const d = dist(at)
      if (!best || tier < best.tier || (tier === best.tier && d < best.d)) best = { at, tier, d }
      continue
    }
    for (const t of hits) {
      const next: XY[] = [
        { x: at.x, y: t.y + t.h + LAYOUT.gapY },
        { x: at.x, y: t.y - NEW_H - LAYOUT.gapY },
        { x: t.x - LAYOUT.sceneW - LAYOUT.takeGapX, y: at.y },
        { x: t.x + t.w + LAYOUT.takeGapX, y: at.y },
      ]
      for (const q of next) {
        const key = `${q.x},${q.y}`
        if (seen.has(key) || dist(q) > maxDist || !inside(q)) continue
        seen.add(key)
        queue.push(q)
      }
    }
  }
  return best?.at ?? null
}

/**
 * Free spot for a new scene card inside the visible canvas `view`, nearest to `centre` (the middle of the view): grid
 * spots (16px, coarser when zoomed far out) scanned nearest first. null = the view has no free spot.
 */
export function freeSpotInView(centre: XY, taken: readonly Box[], view: Box): XY | null {
  const shown = taken.filter((t) => boxesTouch(t, view))
  const free = (q: XY) => !shown.some((t) => boxesTouch(t, newBox(q)))
  if (free(centre)) return centre
  const spanX = view.w - LAYOUT.sceneW
  const spanY = view.h - NEW_H
  if (spanX < 0 || spanY < 0) return null
  let step = 16
  while ((spanX / step + 1) * (spanY / step + 1) > 2500) step += 16
  const spots: { at: XY; d: number }[] = []
  for (let i = Math.ceil((view.x - centre.x) / step); centre.x + i * step <= view.x + spanX; i++) {
    for (let j = Math.ceil((view.y - centre.y) / step); centre.y + j * step <= view.y + spanY; j++) {
      spots.push({ at: { x: centre.x + i * step, y: centre.y + j * step }, d: Math.hypot(i, j) })
    }
  }
  spots.sort((a, b) => a.d - b.d)
  return spots.find((s) => free(s.at))?.at ?? null
}

/** Where the user is working, for placing a new scene (actions.placementHint). */
export interface PlaceHint {
  /** Scene selected / created most recently: the new card goes below it. */
  anchorId?: string | null
  /** Visible canvas area (flow coordinates, without what the toolbar / queue drawer cover); null = not on the canvas. */
  view?: Box | null
}

/**
 * The spot right below a scene's row, or the nearest free spot around it (nothing is pushed). Sliding straight down
 * is only the last resort: when the scene was moved so that its column overlaps another column, sliding down would
 * walk past that whole column (thousands of px away from the scene the user is working on).
 */
function belowScene(s: Scene, taken: Box[]): XY {
  const spot = { x: s.position.x, y: s.position.y + rowHeightOf(s) + LAYOUT.gapY }
  return nearFreeSpot(spot, taken) ?? slideDown(spot, taken)
}

/**
 * Default spot of a new scene, next to where the user works — never a row derived from the scene count (that sent a
 * card to x 420, hundreds or thousands of px away from a scene the user had moved, and the view jumped there):
 * 1. below the most recently selected / created scene (else the last scene of the story), when it is in sight
 *    (or when the canvas is not shown);
 * 2. else below the lowest scene in sight;
 * 3. else in the middle of the visible area (nothing of the story in sight) — the free spot nearest to it in the view
 *    (never slid down past a whole column of cards out of sight) — or the first default slot.
 * Always on a free spot: scene rows, take rows, videos and asset nodes are stepped over, nothing is pushed.
 */
export function newScenePosition(p: Project, hint: PlaceHint = {}): XY {
  const taken = canvasObstacles(p)
  const last = p.scenes.reduce<Scene | undefined>((m, s) => (!m || s.order > m.order ? s : m), undefined)
  const anchor = (hint.anchorId ? p.scenes.find((s) => s.id === hint.anchorId) : undefined) ?? last
  const view = hint.view
  if (!view) return anchor ? belowScene(anchor, taken) : slideDown(scenePosition(0), taken)
  const inView = (s: Scene) => boxesTouch({ x: s.position.x, y: s.position.y, w: s.size?.w ?? LAYOUT.sceneW, h: s.size?.h ?? LAYOUT.sceneH }, view, 0)
  if (anchor && inView(anchor)) return belowScene(anchor, taken)
  const lowest = p.scenes.filter(inView).reduce<Scene | undefined>((m, s) => (!m || s.position.y > m.position.y || (s.position.y === m.position.y && s.order > m.order) ? s : m), undefined)
  if (lowest) return belowScene(lowest, taken)
  const grid = (v: number) => Math.round(v / 16) * 16
  const centre = { x: grid(view.x + view.w / 2 - LAYOUT.sceneW / 2), y: grid(view.y + view.h / 2 - LAYOUT.sceneH / 2) }
  return freeSpotInView(centre, taken, view) ?? nearFreeSpot(centre, taken) ?? centre
}

/**
 * `pos` (where the user pointed, e.g. a double-click), moved just enough to land on a free spot nearby (nearFreeSpot);
 * when nothing near is free it stays where the user pointed.
 */
export function freeSpotFrom(p: Project, pos: XY): XY {
  return nearFreeSpot(pos, canvasObstacles(p)) ?? pos
}

/**
 * Positions that push scene cards DOWN so none overlaps the new card `box` (next scene inserted below its source).
 * Only cards really in the way move — the ones the new card overlaps, then the ones a pushed card overlaps — and each
 * only as far as needed (one gap below the card pushing it). Cards beside the column (16px away on the snap grid)
 * and cards that do not overlap a moved one stay where the user put them.
 */
export function makeRoomAt(scenes: Scene[], box: Box): Map<string, XY> {
  const pushers: Box[] = [box]
  const moved = new Map<string, XY>()
  const byY = [...scenes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
  for (const s of byY) {
    let next = sceneBox(s)
    for (let g = 0; g < 10000; g++) {
      const hit = pushers.find((q) => boxesTouch(q, next))
      if (!hit) break
      next = { ...next, y: hit.y + hit.h + LAYOUT.gapY }
    }
    if (next.y !== s.position.y) {
      moved.set(s.id, { x: next.x, y: next.y })
      pushers.push(next)
    }
  }
  return moved
}

function renumber(scenes: Scene[]): Scene[] {
  return [...scenes].sort((a, b) => a.order - b.order).map((s, i) => (s.order === i + 1 ? s : { ...s, order: i + 1 }))
}

/** Total reference images a scene would send if `assetIds` were its refs. */
export function refImageCount(project: Project, assetIds: string[]): number {
  return assetIds.reduce((t, id) => t + Math.max(1, project.assets.find((a) => a.id === id)?.imageIds.length ?? 0), 0)
}

/** Text used in a prompt when the video a @video_N token pointed to is removed. */
export type VideoLabel = (takeId: string) => string

/**
 * Return `scene` with new media lists; renumbers its prompt tokens when enabled.
 * `assetsBefore` resolves names of removed images, `assetsAfter` numbers the new list.
 */
function withMedia(
  project: Project,
  scene: Scene,
  next: { refs?: string[]; videoRefs?: string[] },
  assetsAfter: Asset[] = project.assets,
  videoLabel: VideoLabel = () => 'video',
): Scene {
  const refs = next.refs ?? scene.refs
  const videoRefs = next.videoRefs ?? scene.videoRefs
  if (refs === scene.refs && videoRefs === scene.videoRefs && assetsAfter === project.assets) return scene
  let prompt = scene.prompt
  if (project.settings.autoRenumber && HAS_TOKEN_RE.test(prompt)) {
    const before = mediaKeys(project.assets, scene.refs, scene.videoRefs)
    const after = mediaKeys(assetsAfter, refs, videoRefs)
    const nameOf = imageFallbackNames(project.assets)
    prompt = remapTokens(prompt, before, after, (kind, key) => (kind === 'image' ? nameOf(key.slice(0, key.indexOf(':'))) : videoLabel(key))).text
  }
  return { ...scene, refs, videoRefs, prompt }
}

/** The video settings of a preset (without id / name). */
export function presetSettings(p: Preset): VideoSettings {
  return { model: p.model, mode: p.mode, duration: p.duration, resolution: p.resolution, ratio: p.ratio }
}

/** Marker of a model saved by a newer build that this build does not know (see Scene.foreignModel). */
type ForeignMark = Pick<Scene, 'foreignModel' | 'foreignSettings'>

const hasForeign = (m: ForeignMark | undefined): m is ForeignMark => !!m && (m.foreignModel !== undefined || m.foreignSettings !== undefined)

/** A config marker: a newer build's values for a model this build knows (foreignSettings without foreignModel). */
const isConfigMark = (m: ForeignMark): boolean => m.foreignModel === undefined && m.foreignSettings !== undefined

/** `x` without the newer-build model marker; `x` itself when it has none. */
function withoutForeign<T extends ForeignMark>(x: T): T {
  if (!hasForeign(x)) return x
  const { foreignModel: _m, foreignSettings: _s, ...rest } = x
  return rest as T
}

/** `x` carrying exactly the marker of `src` (the preset applied to it, the scene it is made from): none when `src` has none. */
function withForeignOf<T extends ForeignMark>(x: T, src: ForeignMark | undefined): T {
  const out = withoutForeign(x)
  if (!hasForeign(src)) return out
  return {
    ...out,
    ...(src.foreignModel !== undefined ? { foreignModel: src.foreignModel } : {}),
    ...(src.foreignSettings !== undefined ? { foreignSettings: src.foreignSettings } : {}),
  }
}

/** Same model, mode, duration, resolution and ratio. */
export function sameSettings(a: VideoSettings, b: VideoSettings): boolean {
  return a.model === b.model && a.mode === b.mode && a.duration === b.duration && a.resolution === b.resolution && a.ratio === b.ratio
}

export interface AddRefsResult {
  added: number
  skipped: number
  scenes: number
}

export interface DeleteItems {
  sceneIds?: string[]
  hideAssetIds?: string[]
  refs?: { sceneId: string; assetId: string }[]
  videoRefs?: { sceneId: string; takeId: string }[]
  frames?: { sceneId: string; which: 'first' | 'last' }[]
  /** Folder nodes to remove (the files already saved in the folder stay on disk). */
  folderIds?: string[]
  /** Wires into folder nodes to cut ('save': take -> folder, 'autosave': scene -> folder). */
  folderLinks?: { folderId: string; kind: FolderLinkKind; from: string }[]
}

/** A new folder node (addFolder): the id may be given (its browser folder handle is stored under it first). */
export type NewFolder = Pick<SaveFolder, 'name' | 'path' | 'position'> & Partial<Pick<SaveFolder, 'id' | 'autoScenes' | 'takes'>>

export interface ProjectState {
  project: Project

  // project
  loadProject: (p: Project) => void
  renameProject: (name: string) => void
  updateProjectSettings: (patch: Partial<ProjectSettings>) => void

  // assets
  addAsset: (partial: Partial<Asset> & { name: string }) => string
  /** Changing `imageIds` renumbers the prompts of every scene that uses the asset. */
  updateAsset: (id: string, patch: Partial<Omit<Asset, 'id'>>) => void
  removeAssets: (ids: string[]) => void
  setAssetOnCanvas: (id: string, position: XY | null) => void
  /** Batched version: one undo step for many assets. */
  setAssetsOnCanvas: (positions: Record<string, XY | null>) => void

  // presets
  addPreset: (partial: Partial<Preset> & { name: string }) => string
  updatePreset: (id: string, patch: Partial<Omit<Preset, 'id'>>) => void
  removePreset: (id: string) => void
  /** Copies the preset's settings and its newer-build model marker (none when the preset has none) to the scenes. */
  applyPreset: (presetId: string, sceneIds: string[]) => void

  // scenes
  /** Without a position the card goes next to where the user works (`opts.hint`, see newScenePosition). */
  addScene: (partial?: Partial<Scene>, opts?: { afterId?: string; position?: XY; hint?: PlaceHint }) => string
  updateScene: (id: string, patch: Partial<Omit<Scene, 'id' | 'settings' | 'refs' | 'videoRefs'>>) => void
  /** Prompt edits are coalesced in the undo history; legacy @Tag mentions auto-link their asset. Returns newly linked asset ids. */
  setScenePrompt: (id: string, prompt: string) => string[]
  /**
   * A patch with `model` also drops a newer build's model marker (Scene.foreignModel / foreignSettings); any patch drops
   * a config marker (a newer build's values for a known model: foreignSettings alone).
   */
  updateSettings: (sceneIds: string[], patch: Partial<VideoSettings>) => void
  /** Restore prompt, refs, video refs and settings (e.g. from a take) in one undo step. Dangling ids are dropped. */
  restoreScene: (id: string, data: { prompt: string; refs: string[]; videoRefs?: string[]; settings: VideoSettings }, liveTakeIds?: Set<string>) => void
  removeScenes: (ids: string[]) => void
  duplicateScenes: (ids: string[]) => string[]
  /**
   * New scene right after `fromId` (placed below it), inheriting refs, video refs and settings (with a newer build's
   * model marker), with an empty prompt.
   */
  createNextScene: (fromId: string, position?: XY, overrides?: Partial<Pick<Scene, 'prompt' | 'videoRefs' | 'title'>>) => string
  moveScene: (id: string, toOrder: number) => void
  setFrame: (sceneId: string, which: 'first' | 'last', assetId: string | null) => void

  // image references
  addRefs: (sceneIds: string[], assetIds: string[]) => AddRefsResult
  removeRef: (sceneId: string, assetId: string) => void
  removeRefs: (pairs: { sceneId: string; assetId: string }[]) => void
  moveRef: (sceneId: string, fromIndex: number, toIndex: number) => void
  moveRefToScene: (assetId: string, fromSceneId: string, toSceneId: string) => void

  // video references (takes used as @video_N)
  /** `exclude(sceneId, takeId)` skips pairs (e.g. a take of the scene itself). */
  addVideoRefs: (sceneIds: string[], takeIds: string[], exclude?: (sceneId: string, takeId: string) => boolean) => AddRefsResult
  removeVideoRef: (sceneId: string, takeId: string, label?: string) => void
  moveVideoRef: (sceneId: string, fromIndex: number, toIndex: number) => void
  /** Move a video reference from one scene to another in one undo step (refused when the target is full). Returns false when refused. */
  moveVideoRefToScene: (takeId: string, fromSceneId: string, toSceneId: string, label?: string) => boolean
  /** A take was deleted: drop it from every scene (tokens become `labels[takeId]`). */
  removeTakesEverywhere: (takeIds: string[], labels: Record<string, string>) => void

  // folder nodes
  /** Add a folder node (with its first wires, in the same undo step). Returns its id. */
  addFolder: (folder: NewFolder) => string
  /**
   * "Chọn lại thư mục": point a folder node at another folder (its name and path). Not an undo step: applied to the
   * whole undo history too (the folder access it goes with is not undoable).
   */
  setFolderPlace: (id: string, place: Pick<SaveFolder, 'name' | 'path'>) => void
  /** Wire takes ('save') or scenes ('autosave') into a folder (one undo step). Returns the ids that were not wired yet. */
  linkFolder: (folderId: string, kind: FolderLinkKind, fromIds: string[]) => string[]
  /** Cut one wire into a folder. */
  unlinkFolder: (folderId: string, kind: FolderLinkKind, fromId: string) => void
  removeFolders: (ids: string[]) => void

  /** One undo step: delete scenes, hide assets from canvas, cut image / video / frame links. */
  deleteItems: (items: DeleteItems, videoLabel?: VideoLabel) => void

  // layout
  setPositions: (positions: Record<string, XY>) => void
  /** Resize scene cards / asset nodes (one undo step). null = back to the default size. Optional positions move them too (resizing from the left/top edge). */
  setNodeSizes: (sizes: Record<string, Size | null>, positions?: Record<string, XY>) => void
  /** Scenes one per row in order, assets in a column. `rowHeights[sceneId]` = tallest node of that row (scene card or its takes); `rowHeights[assetId]` = measured height of an asset card (portrait images make tall cards). */
  autoLayout: (rowHeights?: Record<string, number>) => void

  // bulk
  /** New scenes one below the other, starting where a new scene would go (`hint`, see newScenePosition). */
  applyImport: (data: { scenes: Partial<Scene>[] }, hint?: PlaceHint) => string[]
}

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })

export const useProject = create<ProjectState>()(
  temporal(
    (set, get) => {
      const mutate = (fn: (p: Project) => Project) => set((s) => ({ project: touch(fn(s.project)) }))
      /**
       * A change that is not an edit (no undo step) and that no undo / redo may take back: applied to the current project
       * and to every snapshot of the history. `fn` returns its input when it changes nothing.
       */
      const applyEverywhere = (fn: (p: Project) => Project) => {
        const history = useProject.temporal.getState()
        const onSnap = (snap: Partial<ProjectState>): Partial<ProjectState> => {
          if (!snap.project) return snap
          const next = fn(snap.project)
          return next === snap.project ? snap : { ...snap, project: next }
        }
        const pastStates = history.pastStates.map(onSnap)
        const futureStates = history.futureStates.map(onSnap)
        const changed = (a: Partial<ProjectState>[], b: Partial<ProjectState>[]) => a.some((x, i) => x !== b[i])
        if (changed(pastStates, history.pastStates) || changed(futureStates, history.futureStates)) {
          useProject.temporal.setState({ pastStates, futureStates })
        }
        const p = get().project
        const next = fn(p)
        if (next !== p) {
          history.pause()
          try {
            set({ project: touch(next) })
          } finally {
            history.resume()
          }
        }
        // A typing burst must not continue across it.
        lastKey = null
      }
      const mapScenes = (ids: string[], fn: (s: Scene, p: Project) => Scene) => {
        const idSet = new Set(ids)
        mutate((p) => ({ ...p, scenes: p.scenes.map((s) => (idSet.has(s.id) ? fn(s, p) : s)) }))
      }
      const buildScene = (p: Project, partial: Partial<Scene>, position: XY, order: number): Scene => {
        const draftPreset = p.presets[0]
        // The newer-build model marker follows the settings: the given ones (`partial`), else the draft preset's (as
        // applying that preset would).
        const marker = partial.settings ? partial : draftPreset
        const scene: Scene = {
          id: partial.id ?? newId('scn'),
          order,
          title: partial.title ?? '',
          prompt: partial.prompt ?? '',
          refs: partial.refs ?? [],
          videoRefs: partial.videoRefs ?? [],
          presetId: partial.presetId !== undefined ? partial.presetId : partial.settings ? null : draftPreset?.id ?? null,
          settings: normalizeSettings(partial.settings ?? (draftPreset ? { ...draftPreset } : {})),
          firstFrame: partial.firstFrame ?? null,
          lastFrame: partial.lastFrame ?? null,
          color: partial.color ?? null,
          position,
          note: partial.note ?? '',
        }
        return withForeignOf(scene, marker)
      }

      return {
        project: emptyProject(),

        loadProject: (p) => set({ project: p }),
        renameProject: (name) => mutate((p) => ({ ...p, name: name.trim() || p.name })),
        updateProjectSettings: (patch) => mutate((p) => ({ ...p, settings: { ...p.settings, ...patch } })),

        // ---------------- assets ----------------
        addAsset: (partial) => {
          const p = get().project
          const id = partial.id ?? newId('ast')
          const asset: Asset = {
            id,
            kind: partial.kind ?? 'character',
            name: partial.name,
            tag: partial.tag && !assetByTag(p.assets, partial.tag) ? partial.tag : uniqueTag(partial.name, p.assets.map((a) => a.tag)),
            description: partial.description ?? '',
            imageIds: partial.imageIds ?? [],
            color: partial.color ?? pickColor(p.assets.length),
            position: partial.position ?? null,
          }
          mutate((pp) => ({ ...pp, assets: [...pp.assets, asset] }))
          return id
        },
        updateAsset: (id, patch) => {
          if (patch.name !== undefined || patch.description !== undefined) coalesce('asset:' + id)
          mutate((p) => {
            const others = p.assets.filter((a) => a.id !== id).map((a) => a.tag)
            const assets = p.assets.map((a) => {
              if (a.id !== id) return a
              const next = { ...a, ...patch }
              if (patch.tag !== undefined) next.tag = uniqueTag(patch.tag || next.name, others)
              return next
            })
            const imagesChanged = patch.imageIds !== undefined
            return {
              ...p,
              assets,
              scenes: imagesChanged ? p.scenes.map((s) => (s.refs.includes(id) ? withMedia(p, s, { refs: s.refs }, assets) : s)) : p.scenes,
            }
          })
        },
        removeAssets: (ids) => {
          const dead = new Set(ids)
          mutate((p) => {
            const assets = p.assets.filter((a) => !dead.has(a.id))
            return {
              ...p,
              assets,
              scenes: p.scenes.map((s) => {
                const touched = s.refs.some((r) => dead.has(r)) || (s.firstFrame && dead.has(s.firstFrame)) || (s.lastFrame && dead.has(s.lastFrame))
                if (!touched) return s
                const next = withMedia(p, s, { refs: s.refs.filter((r) => !dead.has(r)) }, assets)
                return {
                  ...next,
                  firstFrame: s.firstFrame && dead.has(s.firstFrame) ? null : s.firstFrame,
                  lastFrame: s.lastFrame && dead.has(s.lastFrame) ? null : s.lastFrame,
                }
              }),
            }
          })
        },
        setAssetOnCanvas: (id, position) => mutate((p) => ({ ...p, assets: p.assets.map((a) => (a.id === id ? { ...a, position } : a)) })),
        setAssetsOnCanvas: (positions) =>
          mutate((p) => ({ ...p, assets: p.assets.map((a) => (a.id in positions ? { ...a, position: positions[a.id] } : a)) })),

        // ---------------- presets ----------------
        addPreset: (partial) => {
          const id = partial.id ?? newId('pst')
          const settings = normalizeSettings(partial)
          mutate((p) => ({ ...p, presets: [...p.presets, withForeignOf<Preset>({ id, name: partial.name, ...settings }, partial)] }))
          return id
        },
        /**
         * Edit a preset. Scenes linked to it whose settings no longer equal the edited preset lose the link (same
         * mutation = same undo step); a rename alone keeps every link.
         */
        updatePreset: (id, patch) => {
          if (!get().project.presets.some((x) => x.id === id)) return
          mutate((p) => {
            const old = p.presets.find((x) => x.id === id)!
            let next: Preset = { ...old, ...patch, id, ...normalizeSettings({ ...old, ...patch }) }
            if (typeof next.name !== 'string' || !next.name.trim()) next.name = old.name
            // Picking a model for a preset of a newer build's model drops its marker (like updateSettings for scenes); a
            // preset that only keeps a newer build's values for a known model (config marker) loses it on any setting.
            const setting = (['model', 'mode', 'duration', 'resolution', 'ratio'] as const).some((k) => patch[k] !== undefined)
            if (patch.model !== undefined || (setting && isConfigMark(old))) next = withoutForeign(next)
            const settings = presetSettings(next)
            // A scene keeps the link only while it still matches the preset: its settings and its newer-build model.
            const matches = (s: Scene) => sameSettings(s.settings, settings) && s.foreignModel === next.foreignModel
            const scenes =
              sameSettings(presetSettings(old), settings) && old.foreignModel === next.foreignModel
                ? p.scenes
                : p.scenes.map((s) => (s.presetId === id && !matches(s) ? { ...s, presetId: null } : s))
            return { ...p, presets: p.presets.map((x) => (x.id === id ? next : x)), scenes }
          })
        },
        removePreset: (id) =>
          mutate((p) => ({
            ...p,
            presets: p.presets.filter((x) => x.id !== id),
            scenes: p.scenes.map((s) => (s.presetId === id ? { ...s, presetId: null } : s)),
          })),
        applyPreset: (presetId, sceneIds) => {
          const preset = get().project.presets.find((x) => x.id === presetId)
          if (!preset) return
          const settings = normalizeSettings(presetSettings(preset))
          // A preset of a newer build's model brings its marker along (the scenes stay blocked); any other drops it.
          mapScenes(sceneIds, (s) => withForeignOf({ ...s, presetId, settings }, preset))
        },

        // ---------------- scenes ----------------
        addScene: (partial = {}, opts = {}) => {
          const p = get().project
          const sorted = [...p.scenes].sort((a, b) => a.order - b.order)
          const after = opts.afterId ? sorted.find((s) => s.id === opts.afterId) : undefined
          const order = after ? after.order + 0.5 : sorted.length + 1
          const position = opts.position ?? partial.position ?? newScenePosition(p, opts.hint)
          const scene = buildScene(p, partial, position, order)
          mutate((pp) => ({ ...pp, scenes: renumber([...pp.scenes, scene]) }))
          return scene.id
        },
        updateScene: (id, patch) => {
          if (patch.title !== undefined || patch.note !== undefined) coalesce('scene:' + id)
          mapScenes([id], (s) => ({ ...s, ...patch }))
        },
        setScenePrompt: (id, prompt) => {
          const p = get().project
          const scene = p.scenes.find((s) => s.id === id)
          if (!scene) return []
          const linked: string[] = []
          const spec = MODELS[scene.settings.model]
          let refs = scene.refs
          for (const tag of extractMentions(prompt)) {
            const asset = assetByTag(p.assets, tag)
            if (asset && !refs.includes(asset.id) && refImageCount(p, [...refs, asset.id]) <= spec.maxRefImages) {
              refs = [...refs, asset.id]
              linked.push(asset.id)
            }
          }
          if (!linked.length) coalesce('prompt:' + id)
          mapScenes([id], (s) => ({ ...s, prompt, refs }))
          return linked
        },
        updateSettings: (sceneIds, patch) =>
          mapScenes(sceneIds, (s) => {
            const settings = normalizeSettings({ ...s.settings, ...patch })
            const same = (Object.keys(settings) as (keyof VideoSettings)[]).every((k) => settings[k] === s.settings[k])
            // Picking a model is the user's choice — even the stand-in one already in `settings`: a newer build's model
            // marker goes (the scene can run again). Other fields keep it — except a config marker (a newer build's
            // values for a known model): any setting chosen here replaces those values.
            const next = patch.model !== undefined || isConfigMark(s) ? withoutForeign(s) : s
            return same && next === s ? s : { ...next, presetId: null, settings: same ? s.settings : settings }
          }),
        restoreScene: (id, { prompt, refs, videoRefs, settings }, liveTakeIds) =>
          mutate((p) => {
            const alive = new Set(p.assets.map((a) => a.id))
            // Settings of a newer build's model (a take made there, restored here): the scene takes its marker and
            // stays blocked — never the stand-in Seedance 2.5 settings as a runnable scene. Known models keep the
            // scene's own marker as it is.
            const foreign = foreignMarkOf(settings)
            return {
              ...p,
              scenes: p.scenes.map((s) => {
                if (s.id !== id) return s
                const nextSettings = normalizeSettings({ ...s.settings, ...settings })
                const same = (Object.keys(nextSettings) as (keyof VideoSettings)[]).every((k) => nextSettings[k] === s.settings[k])
                // A config marker of the scene goes with the settings restored over it.
                const marked = foreign ? withForeignOf(s, foreign) : isConfigMark(s) ? withoutForeign(s) : s
                return {
                  ...marked,
                  prompt,
                  refs: refs.filter((r) => alive.has(r)),
                  videoRefs: (videoRefs ?? s.videoRefs).filter((t) => !liveTakeIds || liveTakeIds.has(t)),
                  presetId: same && marked.foreignModel === s.foreignModel ? s.presetId : null,
                  settings: nextSettings,
                }
              }),
            }
          }),
        removeScenes: (ids) => {
          const dead = new Set(ids)
          mutate((p) => {
            const folders = dropFolderLinks(p.folders, { scenes: dead })
            return { ...p, scenes: renumber(p.scenes.filter((s) => !dead.has(s.id))), ...(folders !== p.folders ? { folders } : {}) }
          })
        },
        duplicateScenes: (ids) => {
          const p = get().project
          const sources = p.scenes.filter((s) => ids.includes(s.id)).sort((a, b) => a.order - b.order)
          const created: string[] = []
          const copies: Scene[] = sources.map((s, i) => {
            const id = newId('scn')
            created.push(id)
            return {
              ...s,
              id,
              order: s.order + 0.5 + i * 0.001,
              title: s.title ? `${s.title} (bản sao)` : '',
              position: { x: s.position.x + 36, y: s.position.y + 36 },
            }
          })
          mutate((pp) => ({ ...pp, scenes: renumber([...pp.scenes, ...copies]) }))
          return created
        },
        createNextScene: (fromId, position, overrides = {}) => {
          const p = get().project
          const from = p.scenes.find((s) => s.id === fromId)
          if (!from) return get().addScene()
          // Below the source row: a resized (taller) card or a tall take in its row puts the new card further down.
          // Asset nodes, other scenes' take rows and videos placed by hand right there are stepped over (not pushed).
          const pos = position ?? slideDown({ x: from.position.x, y: from.position.y + rowHeightOf(from) + LAYOUT.gapY }, otherBoxes(p))
          // A newer build's model marker goes along with the settings (nextScene / createSceneFromTake must not turn
          // a blocked scene into a runnable Seedance 2.5 one).
          const next = buildScene(
            p,
            {
              refs: from.refs,
              videoRefs: from.videoRefs,
              settings: from.settings,
              presetId: from.presetId,
              firstFrame: from.firstFrame,
              lastFrame: from.lastFrame,
              foreignModel: from.foreignModel,
              foreignSettings: from.foreignSettings,
              ...overrides,
            },
            pos,
            from.order + 0.5,
          )
          // Default spot (below `from`) is usually the next row: push the cards in the way down, just enough.
          const moved = position ? new Map<string, XY>() : makeRoomAt(p.scenes, newBox(pos))
          mutate((pp) => ({
            ...pp,
            scenes: renumber([...pp.scenes.map((s) => (moved.has(s.id) ? { ...s, position: moved.get(s.id)! } : s)), next]),
          }))
          return next.id
        },
        moveScene: (id, toOrder) =>
          mutate((p) => {
            const sorted = [...p.scenes].sort((a, b) => a.order - b.order)
            const from = sorted.findIndex((s) => s.id === id)
            if (from < 0) return p
            const [s] = sorted.splice(from, 1)
            sorted.splice(Math.max(0, Math.min(sorted.length, toOrder - 1)), 0, s)
            return { ...p, scenes: sorted.map((x, i) => (x.order === i + 1 ? x : { ...x, order: i + 1 })) }
          }),
        setFrame: (sceneId, which, assetId) =>
          mapScenes([sceneId], (s) => (which === 'first' ? { ...s, firstFrame: assetId } : { ...s, lastFrame: assetId })),

        // ---------------- image references ----------------
        addRefs: (sceneIds, assetIds) => {
          const p = get().project
          const result: AddRefsResult = { added: 0, skipped: 0, scenes: 0 }
          const assets = assetIds.filter((id) => p.assets.some((a) => a.id === id))
          const ids = new Set(sceneIds)
          const scenes = p.scenes.map((s) => {
            if (!ids.has(s.id)) return s
            const limit = MODELS[s.settings.model].maxRefImages
            let refs = s.refs
            for (const a of assets) {
              if (refs.includes(a)) continue
              if (refImageCount(p, [...refs, a]) > limit) {
                result.skipped++
                continue
              }
              refs = [...refs, a]
              result.added++
            }
            if (refs === s.refs) return s
            result.scenes++
            // Appending never changes existing numbers, so no renumbering is needed.
            return { ...s, refs }
          })
          if (result.added) mutate((pp) => ({ ...pp, scenes }))
          return result
        },
        removeRef: (sceneId, assetId) => mapScenes([sceneId], (s, p) => withMedia(p, s, { refs: s.refs.filter((r) => r !== assetId) })),
        removeRefs: (pairs) => {
          const bySceneId = new Map<string, Set<string>>()
          for (const { sceneId, assetId } of pairs) {
            if (!bySceneId.has(sceneId)) bySceneId.set(sceneId, new Set())
            bySceneId.get(sceneId)!.add(assetId)
          }
          mapScenes([...bySceneId.keys()], (s, p) => withMedia(p, s, { refs: s.refs.filter((r) => !bySceneId.get(s.id)!.has(r)) }))
        },
        moveRef: (sceneId, fromIndex, toIndex) =>
          mapScenes([sceneId], (s, p) => {
            const refs = [...s.refs]
            const [r] = refs.splice(fromIndex, 1)
            if (r === undefined) return s
            refs.splice(Math.max(0, Math.min(refs.length, toIndex)), 0, r)
            return withMedia(p, s, { refs })
          }),
        moveRefToScene: (assetId, fromSceneId, toSceneId) => {
          if (fromSceneId === toSceneId) return
          const p = get().project
          const target = p.scenes.find((s) => s.id === toSceneId)
          if (!target) return
          const already = target.refs.includes(assetId)
          const canAdd = !already && refImageCount(p, [...target.refs, assetId]) <= MODELS[target.settings.model].maxRefImages
          // Target is over its image limit: reject the move and keep the original link.
          if (!canAdd && !already) return
          mutate((pp) => ({
            ...pp,
            scenes: pp.scenes.map((s) => {
              if (s.id === fromSceneId) return withMedia(pp, s, { refs: s.refs.filter((r) => r !== assetId) })
              if (s.id === toSceneId && canAdd) return { ...s, refs: [...s.refs, assetId] }
              return s
            }),
          }))
        },

        // ---------------- video references ----------------
        addVideoRefs: (sceneIds, takeIds, exclude) => {
          const p = get().project
          const result: AddRefsResult = { added: 0, skipped: 0, scenes: 0 }
          const ids = new Set(sceneIds)
          const scenes = p.scenes.map((s) => {
            if (!ids.has(s.id)) return s
            const limit = usesVideoRefs(s.settings) ? MODELS[s.settings.model].maxRefVideos : 0
            let videoRefs = s.videoRefs
            for (const t of takeIds) {
              if (exclude?.(s.id, t)) continue
              if (videoRefs.includes(t)) continue
              if (videoRefs.length >= limit) {
                result.skipped++
                continue
              }
              videoRefs = [...videoRefs, t]
              result.added++
            }
            if (videoRefs === s.videoRefs) return s
            result.scenes++
            return { ...s, videoRefs }
          })
          if (result.added) mutate((pp) => ({ ...pp, scenes }))
          return result
        },
        removeVideoRef: (sceneId, takeId, label = 'video') =>
          mapScenes([sceneId], (s, p) => withMedia(p, s, { videoRefs: s.videoRefs.filter((t) => t !== takeId) }, p.assets, () => label)),
        moveVideoRef: (sceneId, fromIndex, toIndex) =>
          mapScenes([sceneId], (s, p) => {
            const videoRefs = [...s.videoRefs]
            const [t] = videoRefs.splice(fromIndex, 1)
            if (t === undefined) return s
            videoRefs.splice(Math.max(0, Math.min(videoRefs.length, toIndex)), 0, t)
            return withMedia(p, s, { videoRefs })
          }),
        moveVideoRefToScene: (takeId, fromSceneId, toSceneId, label = 'video') => {
          if (fromSceneId === toSceneId) return true
          const p = get().project
          const target = p.scenes.find((s) => s.id === toSceneId)
          if (!target) return false
          const already = target.videoRefs.includes(takeId)
          const limit = usesVideoRefs(target.settings) ? MODELS[target.settings.model].maxRefVideos : 0
          if (!already && target.videoRefs.length >= limit) return false
          mutate((pp) => ({
            ...pp,
            scenes: pp.scenes.map((s) => {
              if (s.id === fromSceneId) return withMedia(pp, s, { videoRefs: s.videoRefs.filter((t) => t !== takeId) }, pp.assets, () => label)
              if (s.id === toSceneId && !already) return { ...s, videoRefs: [...s.videoRefs, takeId] }
              return s
            }),
          }))
          return true
        },
        removeTakesEverywhere: (takeIds, labels) => {
          const dead = new Set(takeIds)
          if (!dead.size) return
          const uses = (s: Scene) => s.videoRefs.some((t) => dead.has(t))
          const clean = (pp: Project): Project => {
            let out = pp
            if (pp.scenes.some(uses)) {
              out = {
                ...out,
                scenes: pp.scenes.map((s) =>
                  uses(s) ? withMedia(pp, s, { videoRefs: s.videoRefs.filter((t) => !dead.has(t)) }, pp.assets, (id) => labels[id] ?? 'video') : s,
                ),
              }
            }
            // Folder nodes forget the deleted videos too ("N video đã nối" counts only what is there).
            const folders = dropFolderLinks(pp.folders, { takes: dead })
            if (folders !== pp.folders) out = { ...out, folders }
            return out
          }
          // Deleting a take is not undoable, so dropping its references must not become an undo step either, and no
          // undo/redo may bring them back (a @video pointing at nothing blocks the scene): every snapshot in the
          // history is cleaned the same way, not only the current project.
          applyEverywhere(clean)
        },

        // ---------------- folder nodes ----------------
        addFolder: (folder) => {
          const p = get().project
          const taken = new Set([...p.assets.map((a) => a.id), ...p.scenes.map((s) => s.id), ...(p.folders ?? []).map((f) => f.id)])
          let id = folder.id ?? newId('fld')
          while (taken.has(id)) id = newId('fld')
          const next: SaveFolder = { id, name: folder.name, path: folder.path, position: folder.position, mode: 'copy' }
          if (folder.autoScenes?.length) next.autoScenes = [...new Set(folder.autoScenes)]
          if (folder.takes?.length) next.takes = [...new Set(folder.takes)]
          mutate((pp) => ({ ...pp, folders: [...(pp.folders ?? []), next] }))
          return id
        },
        setFolderPlace: (id, place) => {
          const at = (f: SaveFolder) => (f.id === id && (f.name !== place.name || f.path !== place.path) ? { ...f, name: place.name, path: place.path } : f)
          // Where a node writes is not an edit: the browser keeps the folder itself (its handle) outside the project and
          // the undo history, so no undo / redo may show the old folder's name while saves go to the new one.
          applyEverywhere((p) => (p.folders?.some((f) => at(f) !== f) ? { ...p, folders: p.folders.map(at) } : p))
        },
        linkFolder: (folderId, kind, fromIds) => {
          const cur = get().project.folders?.find((f) => f.id === folderId)
          if (!cur) return []
          let next = cur
          const added: string[] = []
          for (const from of fromIds) {
            const after = withLink(next, kind, from, true)
            if (after !== next) added.push(from)
            next = after
          }
          if (next !== cur) mutate((p) => ({ ...p, folders: (p.folders ?? []).map((f) => (f.id === folderId ? next : f)) }))
          return added
        },
        unlinkFolder: (folderId, kind, fromId) => {
          const cur = get().project.folders?.find((f) => f.id === folderId)
          if (!cur) return
          const next = withLink(cur, kind, fromId, false)
          if (next !== cur) mutate((p) => ({ ...p, folders: (p.folders ?? []).map((f) => (f.id === folderId ? next : f)) }))
        },
        removeFolders: (ids) => {
          const dead = new Set(ids)
          if (!get().project.folders?.some((f) => dead.has(f.id))) return
          mutate((p) => ({ ...p, folders: (p.folders ?? []).filter((f) => !dead.has(f.id)) }))
        },

        deleteItems: ({ sceneIds = [], hideAssetIds = [], refs = [], videoRefs = [], frames = [], folderIds = [], folderLinks = [] }, videoLabel) =>
          mutate((p) => {
            const dead = new Set(sceneIds)
            const hide = new Set(hideAssetIds)
            const cutRefs = new Map<string, Set<string>>()
            for (const r of refs) {
              if (!cutRefs.has(r.sceneId)) cutRefs.set(r.sceneId, new Set())
              cutRefs.get(r.sceneId)!.add(r.assetId)
            }
            const cutVideos = new Map<string, Set<string>>()
            for (const r of videoRefs) {
              if (!cutVideos.has(r.sceneId)) cutVideos.set(r.sceneId, new Set())
              cutVideos.get(r.sceneId)!.add(r.takeId)
            }
            const scenes = p.scenes
              .filter((s) => !dead.has(s.id))
              .map((s) => {
                let next = s
                if (cutRefs.has(s.id) || cutVideos.has(s.id)) {
                  next = withMedia(
                    p,
                    s,
                    {
                      refs: cutRefs.has(s.id) ? s.refs.filter((r) => !cutRefs.get(s.id)!.has(r)) : s.refs,
                      videoRefs: cutVideos.has(s.id) ? s.videoRefs.filter((t) => !cutVideos.get(s.id)!.has(t)) : s.videoRefs,
                    },
                    p.assets,
                    videoLabel,
                  )
                }
                for (const f of frames) {
                  if (f.sceneId !== s.id) continue
                  next = f.which === 'first' ? { ...next, firstFrame: null } : { ...next, lastFrame: null }
                }
                return next
              })
            const deadFolders = new Set(folderIds)
            let folders = p.folders
            if (folders && (deadFolders.size || folderLinks.length)) {
              folders = folders
                .filter((f) => !deadFolders.has(f.id))
                .map((f) => folderLinks.reduce((acc, l) => (l.folderId === f.id ? withLink(acc, l.kind, l.from, false) : acc), f))
            }
            // A deleted scene's auto-save wires go with it (Undo brings both back).
            folders = dropFolderLinks(folders, { scenes: dead })
            return {
              ...p,
              assets: hide.size ? p.assets.map((a) => (hide.has(a.id) ? { ...a, position: null } : a)) : p.assets,
              scenes: renumber(scenes),
              ...(folders !== p.folders ? { folders } : {}),
            }
          }),

        // ---------------- layout ----------------
        setPositions: (positions) =>
          mutate((p) => ({
            ...p,
            scenes: p.scenes.map((s) => (positions[s.id] ? { ...s, position: positions[s.id] } : s)),
            assets: p.assets.map((a) => (positions[a.id] && a.position ? { ...a, position: positions[a.id] } : a)),
            ...(p.folders?.some((f) => positions[f.id]) ? { folders: p.folders.map((f) => (positions[f.id] ? { ...f, position: positions[f.id] } : f)) } : {}),
          })),
        setNodeSizes: (sizes, positions = {}) =>
          mutate((p) => ({
            ...p,
            scenes: p.scenes.map((s) =>
              s.id in sizes || positions[s.id]
                ? { ...s, size: s.id in sizes ? (sizes[s.id] ? clampSize('scene', sizes[s.id]!) : null) : s.size, position: positions[s.id] ?? s.position }
                : s,
            ),
            assets: p.assets.map((a) =>
              a.id in sizes || (positions[a.id] && a.position)
                ? {
                    ...a,
                    size: a.id in sizes ? (sizes[a.id] ? clampSize('asset', sizes[a.id]!) : null) : a.size,
                    position: positions[a.id] && a.position ? positions[a.id] : a.position,
                  }
                : a,
            ),
          })),
        autoLayout: (rowHeights = {}) =>
          mutate((p) => {
            const sorted = [...p.scenes].sort((a, b) => a.order - b.order)
            // Rows grow with resized scene cards / takes so nothing overlaps the next row.
            const pos = new Map<string, XY>()
            let rowY = LAYOUT.scenesY
            for (const s of sorted) {
              pos.set(s.id, { x: LAYOUT.scenesX, y: rowY })
              const h = Math.max(rowHeightOf(s), rowHeights[s.id] ?? 0)
              rowY += h + LAYOUT.gapY
            }
            let y = LAYOUT.scenesY
            const assets = p.assets.map((a) => {
              if (!a.position) return a
              const next = { ...a, position: { x: LAYOUT.assetX, y } }
              y += Math.max(LAYOUT.assetH, a.size?.h ?? 0, rowHeights[a.id] ?? 0) + LAYOUT.assetGapY
              return next
            })
            return { ...p, assets, scenes: p.scenes.map((s) => ({ ...s, position: pos.get(s.id)! })) }
          }),

        applyImport: ({ scenes }, hint) => {
          const created: string[] = []
          mutate((p) => {
            const start = p.scenes.length
            const taken = canvasObstacles(p)
            let position = newScenePosition(p, hint)
            const list: Scene[] = scenes.map((partial, i) => {
              const s = buildScene(p, partial, position, start + i + 1)
              created.push(s.id)
              const box = newBox(position)
              taken.push(box)
              position = slideDown({ x: position.x, y: box.y + box.h + LAYOUT.gapY }, taken)
              return s
            })
            return { ...p, scenes: renumber([...p.scenes, ...list]) }
          })
          return created
        },
      }
    },
    {
      partialize: (s) => ({ project: s.project }),
      equality: (a, b) => a.project === b.project,
      limit: 200,
      handleSet: (handleSet) => (pastState, replace, currentState, deltaState) => {
        const key = coalesceKey
        coalesceKey = null
        const now = Date.now()
        if (key && key === lastKey && now - lastTime < 1500) {
          lastTime = now
          return
        }
        lastKey = key
        lastTime = now
        ;(handleSet as unknown as (...a: unknown[]) => void)(pastState, replace, currentState, deltaState)
      },
      // Undo/redo/clear end the current typing burst: the next edit must get its own step (and drop the redo stack).
      // (Undo/redo put back the snapshot as it was, its old `updatedAt` included: persistence compares revisions,
      // not this time, and stamps the project list with the save time.)
      wrapTemporal: (init) => (set, get, store) => {
        const t = init(set, get, store)
        const endBurst =
          <A extends unknown[]>(fn: (...a: A) => void) =>
          (...a: A) => {
            lastKey = null
            fn(...a)
          }
        return { ...t, undo: endBurst(t.undo), redo: endBurst(t.redo), clear: endBurst(t.clear) }
      },
    },
  ),
)

/** Direction of an undo-history jump. */
export type HistoryJumpKind = 'undo' | 'redo'
/** Called right after an undo / redo that changed the project, with the project before and after the jump. */
export type HistoryJumpListener = (before: Project, after: Project, kind: HistoryJumpKind) => void

const historyListeners = new Set<HistoryJumpListener>()

/**
 * Listen to undo / redo jumps (e.g. folder wires a jump cut or brought back). Fired by the exported `undo` / `redo`,
 * which every UI path uses (shortcuts, top bar, sidebar, undoToastAction) — on purpose NOT a store subscription:
 * loading / importing a project, applyEverywhere (deleted takes, setFolderPlace) and plain edits are not jumps.
 * Nothing is fired when the jump changed nothing (empty history). A throwing listener never breaks the jump or the
 * other listeners. Returns the unsubscribe function (HMR dispose).
 */
export function onHistoryJump(fn: HistoryJumpListener): () => void {
  historyListeners.add(fn)
  return () => {
    historyListeners.delete(fn)
  }
}

function historyJump(kind: HistoryJumpKind) {
  const before = useProject.getState().project
  const history = useProject.temporal.getState()
  if (kind === 'undo') history.undo()
  else history.redo()
  const after = useProject.getState().project
  if (after === before) return
  for (const fn of [...historyListeners]) {
    try {
      fn(before, after, kind)
    } catch (err) {
      console.error('[project] history listener failed', err)
    }
  }
}

export const undo = () => historyJump('undo')
export const redo = () => historyJump('redo')
export const clearHistory = () => useProject.temporal.getState().clear()

/**
 * Toast action that undoes the edit that was just made — but only if nothing changed since.
 * (A plain undo() from a stale toast would revert an unrelated, newer step.)
 */
export function undoToastAction(label = 'Hoàn tác'): { label: string; run: () => void } {
  const after = useProject.getState().project
  return {
    label,
    run: () => {
      if (useProject.getState().project !== after) {
        toast('Không hoàn tác được từ đây: đã có thay đổi mới hơn. Dùng Ctrl+Z để lùi từng bước.', { tone: 'warning' })
        return
      }
      undo()
    },
  }
}

/** Convenience selectors */
export const selectScene = (id: string | null | undefined) => (s: ProjectState) => (id ? s.project.scenes.find((x) => x.id === id) : undefined)
export const selectAsset = (id: string | null | undefined) => (s: ProjectState) => (id ? s.project.assets.find((x) => x.id === id) : undefined)
export const sortedScenes = (p: Project) => [...p.scenes].sort((a, b) => a.order - b.order)
