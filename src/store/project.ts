// Undoable project store (zustand + zundo).
// Everything the user authors lives here: assets, presets, scenes (prompt, image refs, video refs), positions.
// Runs/takes live in ./runs.ts and UI-only state in ./ui.ts (not undoable).
//
// Whenever a scene's image refs / video refs change (or the images of an asset change), the @image_N / @video_N
// tokens in the affected prompts are renumbered in the same undo step (project.settings.autoRenumber).
import { temporal } from 'zundo'
import { create } from 'zustand'
import { assetByTag, extractMentions, HAS_TOKEN_RE, imageFallbackNames, mediaKeys, remapTokens, uniqueTag } from '../core/compile'
import { newId, pickColor } from '../core/ids'
import { MODELS, normalizeSettings, usesVideoRefs } from '../core/models'
import type { Asset, Preset, Project, ProjectSettings, Scene, Size, VideoSettings, XY } from '../core/types'
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

/**
 * Height of the tallest take (video node) of a scene. Takes live in the runs store, which imports this module,
 * so the runs side registers the lookup (see actions.ts) instead of this store importing it.
 */
let takeHeightOf: (sceneId: string) => number = () => 0
export function setTakeHeightSource(fn: (sceneId: string) => number) {
  takeHeightOf = fn
}

/** Height of a scene's row without the gap: its card or its tallest take, whichever is taller (resized ones included). */
export function rowHeightOf(scene: Pick<Scene, 'id' | 'size'>): number {
  return Math.max(scene.size?.h ?? LAYOUT.sceneH, LAYOUT.takeH, takeHeightOf(scene.id))
}

/** Area a scene's row takes in the card column (x, y, card width, row height). */
interface Box extends XY {
  w: number
  h: number
}
const sceneBox = (s: Scene): Box => ({ x: s.position.x, y: s.position.y, w: s.size?.w ?? LAYOUT.sceneW, h: rowHeightOf(s) })
/** A new scene card (default size, no takes yet). */
const newBox = (pos: XY): Box => ({ x: pos.x, y: pos.y, w: LAYOUT.sceneW, h: Math.max(LAYOUT.sceneH, LAYOUT.takeH) })

/** Would these rows overlap (closer than half a gap counts as overlapping)? */
function cardsOverlap(a: Box, b: Box): boolean {
  const gx = 24
  const gy = LAYOUT.gapY / 2
  return a.x < b.x + b.w + gx && b.x < a.x + a.w + gx && a.y < b.y + b.h + gy && b.y < a.y + a.h + gy
}

/** First row slot from `start` on whose card would not overlap any of the `taken` rows. */
function freeScenePosition(taken: Box[], start: number): XY {
  for (let i = start; i < start + 10000; i++) {
    const pos = scenePosition(i)
    const box = newBox(pos)
    if (!taken.some((t) => cardsOverlap(t, box))) return pos
  }
  return scenePosition(start)
}

/**
 * Positions that push scenes DOWN so none overlaps the new card `box`. Only cards hit by the new card
 * (or by a card pushed before them) move; unrelated cards stay where the user put them.
 */
function makeRoomAt(scenes: Scene[], box: Box): Map<string, XY> {
  const pushers: Box[] = [box]
  const placed: Box[] = [box]
  const moved = new Map<string, XY>()
  const byY = [...scenes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
  for (const s of byY) {
    let next = sceneBox(s)
    if (pushers.some((q) => cardsOverlap(q, next))) {
      for (let g = 0; g < 10000; g++) {
        const hit = placed.find((q) => cardsOverlap(q, next))
        if (!hit) break
        next = { ...next, y: hit.y + hit.h + LAYOUT.gapY }
      }
      moved.set(s.id, { x: next.x, y: next.y })
      pushers.push(next)
    }
    placed.push(next)
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
}

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
  applyPreset: (presetId: string, sceneIds: string[]) => void

  // scenes
  addScene: (partial?: Partial<Scene>, opts?: { afterId?: string; position?: XY }) => string
  updateScene: (id: string, patch: Partial<Omit<Scene, 'id' | 'settings' | 'refs' | 'videoRefs'>>) => void
  /** Prompt edits are coalesced in the undo history; legacy @Tag mentions auto-link their asset. Returns newly linked asset ids. */
  setScenePrompt: (id: string, prompt: string) => string[]
  updateSettings: (sceneIds: string[], patch: Partial<VideoSettings>) => void
  /** Restore prompt, refs, video refs and settings (e.g. from a take) in one undo step. Dangling ids are dropped. */
  restoreScene: (id: string, data: { prompt: string; refs: string[]; videoRefs?: string[]; settings: VideoSettings }, liveTakeIds?: Set<string>) => void
  removeScenes: (ids: string[]) => void
  duplicateScenes: (ids: string[]) => string[]
  /** New scene right after `fromId` (placed below it), inheriting refs, video refs and settings, with an empty prompt. */
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

  /** One undo step: delete scenes, hide assets from canvas, cut image / video / frame links. */
  deleteItems: (items: DeleteItems, videoLabel?: VideoLabel) => void

  // layout
  setPositions: (positions: Record<string, XY>) => void
  /** Resize scene cards / asset nodes (one undo step). null = back to the default size. Optional positions move them too (resizing from the left/top edge). */
  setNodeSizes: (sizes: Record<string, Size | null>, positions?: Record<string, XY>) => void
  /** Scenes one per row in order, assets in a column. `rowHeights[sceneId]` = tallest node of that row (scene card or its takes); `rowHeights[assetId]` = measured height of an asset card (portrait images make tall cards). */
  autoLayout: (rowHeights?: Record<string, number>) => void

  // bulk
  applyImport: (data: { scenes: Partial<Scene>[] }) => string[]
}

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })

export const useProject = create<ProjectState>()(
  temporal(
    (set, get) => {
      const mutate = (fn: (p: Project) => Project) => set((s) => ({ project: touch(fn(s.project)) }))
      const mapScenes = (ids: string[], fn: (s: Scene, p: Project) => Scene) => {
        const idSet = new Set(ids)
        mutate((p) => ({ ...p, scenes: p.scenes.map((s) => (idSet.has(s.id) ? fn(s, p) : s)) }))
      }
      const buildScene = (p: Project, partial: Partial<Scene>, position: XY, order: number): Scene => {
        const draftPreset = p.presets[0]
        return {
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
          mutate((p) => ({ ...p, presets: [...p.presets, { id, name: partial.name, ...settings }] }))
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
            const next: Preset = { ...old, ...patch, id, ...normalizeSettings({ ...old, ...patch }) }
            if (typeof next.name !== 'string' || !next.name.trim()) next.name = old.name
            const settings = presetSettings(next)
            const scenes = sameSettings(presetSettings(old), settings)
              ? p.scenes
              : p.scenes.map((s) => (s.presetId === id && !sameSettings(s.settings, settings) ? { ...s, presetId: null } : s))
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
          const { id: _id, name: _name, ...settings } = preset
          mapScenes(sceneIds, (s) => ({ ...s, presetId, settings: normalizeSettings(settings) }))
        },

        // ---------------- scenes ----------------
        addScene: (partial = {}, opts = {}) => {
          const p = get().project
          const sorted = [...p.scenes].sort((a, b) => a.order - b.order)
          const after = opts.afterId ? sorted.find((s) => s.id === opts.afterId) : undefined
          const order = after ? after.order + 0.5 : sorted.length + 1
          const position = opts.position ?? partial.position ?? freeScenePosition(p.scenes.map(sceneBox), p.scenes.length)
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
            return same ? s : { ...s, presetId: null, settings }
          }),
        restoreScene: (id, { prompt, refs, videoRefs, settings }, liveTakeIds) =>
          mutate((p) => {
            const alive = new Set(p.assets.map((a) => a.id))
            return {
              ...p,
              scenes: p.scenes.map((s) => {
                if (s.id !== id) return s
                const nextSettings = normalizeSettings({ ...s.settings, ...settings })
                const same = (Object.keys(nextSettings) as (keyof VideoSettings)[]).every((k) => nextSettings[k] === s.settings[k])
                return {
                  ...s,
                  prompt,
                  refs: refs.filter((r) => alive.has(r)),
                  videoRefs: (videoRefs ?? s.videoRefs).filter((t) => !liveTakeIds || liveTakeIds.has(t)),
                  presetId: same ? s.presetId : null,
                  settings: nextSettings,
                }
              }),
            }
          }),
        removeScenes: (ids) => {
          const dead = new Set(ids)
          mutate((p) => ({ ...p, scenes: renumber(p.scenes.filter((s) => !dead.has(s.id))) }))
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
          // Below the source row: a resized (taller) card or a tall take of it pushes the new card further down.
          const pos = position ?? { x: from.position.x, y: from.position.y + rowHeightOf(from) + LAYOUT.gapY }
          const next = buildScene(
            p,
            { refs: from.refs, videoRefs: from.videoRefs, settings: from.settings, presetId: from.presetId, firstFrame: from.firstFrame, lastFrame: from.lastFrame, ...overrides },
            pos,
            from.order + 0.5,
          )
          // Default spot (below `from`) is usually the next row: push those cards down to make room.
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
          const clean = (pp: Project): Project =>
            pp.scenes.some(uses)
              ? {
                  ...pp,
                  scenes: pp.scenes.map((s) =>
                    uses(s) ? withMedia(pp, s, { videoRefs: s.videoRefs.filter((t) => !dead.has(t)) }, pp.assets, (id) => labels[id] ?? 'video') : s,
                  ),
                }
              : pp
          // Deleting a take is not undoable, so dropping its references must not become an undo step either, and no
          // undo/redo may bring them back (a @video pointing at nothing blocks the scene): every snapshot in the
          // history is cleaned the same way, not only the current project.
          const history = useProject.temporal.getState()
          const cleanSnap = (snap: Partial<ProjectState>): Partial<ProjectState> => {
            if (!snap.project) return snap
            const next = clean(snap.project)
            return next === snap.project ? snap : { ...snap, project: next }
          }
          const pastStates = history.pastStates.map(cleanSnap)
          const futureStates = history.futureStates.map(cleanSnap)
          const changed = (a: Partial<ProjectState>[], b: Partial<ProjectState>[]) => a.some((x, i) => x !== b[i])
          if (changed(pastStates, history.pastStates) || changed(futureStates, history.futureStates)) {
            useProject.temporal.setState({ pastStates, futureStates })
          }
          const p = get().project
          const next = clean(p)
          if (next !== p) {
            history.pause()
            try {
              set({ project: touch(next) })
            } finally {
              history.resume()
            }
          }
          // A typing burst must not continue across the deletion.
          lastKey = null
        },

        deleteItems: ({ sceneIds = [], hideAssetIds = [], refs = [], videoRefs = [], frames = [] }, videoLabel) =>
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
            return {
              ...p,
              assets: hide.size ? p.assets.map((a) => (hide.has(a.id) ? { ...a, position: null } : a)) : p.assets,
              scenes: renumber(scenes),
            }
          }),

        // ---------------- layout ----------------
        setPositions: (positions) =>
          mutate((p) => ({
            ...p,
            scenes: p.scenes.map((s) => (positions[s.id] ? { ...s, position: positions[s.id] } : s)),
            assets: p.assets.map((a) => (positions[a.id] && a.position ? { ...a, position: positions[a.id] } : a)),
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

        applyImport: ({ scenes }) => {
          const created: string[] = []
          mutate((p) => {
            const start = p.scenes.length
            const taken = p.scenes.map(sceneBox)
            const list: Scene[] = scenes.map((partial, i) => {
              const position = freeScenePosition(taken, start + i)
              taken.push(newBox(position))
              const s = buildScene(p, partial, position, start + i + 1)
              created.push(s.id)
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

export const undo = () => useProject.temporal.getState().undo()
export const redo = () => useProject.temporal.getState().redo()
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
