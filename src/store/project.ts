// Undoable project store (zustand + zundo).
// Everything the user authors lives here: assets, prompt blocks, presets, scenes, positions.
// Runs/takes live in ./runs.ts and UI-only state in ./ui.ts (not undoable).
import { temporal } from 'zundo'
import { create } from 'zustand'
import { DEFAULT_REFERENCES_TEMPLATE, extractMentions, assetByTag, uniqueTag } from '../core/compile'
import { newId, pickColor } from '../core/ids'
import { MODELS, normalizeSettings } from '../core/models'
import type { Asset, PromptBlock, Preset, Project, ProjectSettings, Scene, VideoSettings, XY } from '../core/types'

// ---------- undo coalescing (typing in a textarea should not create one history step per key) ----------
let coalesceKey: string | null = null
let lastKey: string | null = null
let lastTime = 0
/** Call right before a set() that should merge with the previous one of the same key (e.g. 'prompt:<sceneId>'). */
function coalesce(key: string) {
  coalesceKey = key
}

export const LAYOUT = {
  sceneW: 280,
  sceneH: 210,
  gapX: 48,
  gapY: 56,
  perRow: 5,
  scenesX: 420,
  scenesY: 60,
  assetX: 40,
  assetW: 180,
  assetH: 210,
  assetGapY: 28,
}

export function emptyProject(name = 'Dự án mới'): Project {
  const now = Date.now()
  return {
    id: newId('prj'),
    name,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    assets: [],
    blocks: [],
    presets: defaultPresets(),
    scenes: [],
    settings: defaultProjectSettings(),
  }
}

export function defaultProjectSettings(): ProjectSettings {
  return { referencesTemplate: DEFAULT_REFERENCES_TEMPLATE, autoReferences: true, autoContinuity: true }
}

export function defaultPresets(): Preset[] {
  return [
    { id: 'preset_draft', name: 'Nháp', model: 'seedance_2_5', mode: 't2v', duration: 30, resolution: '480p', ratio: '16:9' },
    { id: 'preset_final', name: 'Final', model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
    { id: 'preset_h3', name: 'H3 nháp', model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' },
  ]
}

function scenePosition(index: number): XY {
  const col = index % LAYOUT.perRow
  const row = Math.floor(index / LAYOUT.perRow)
  return { x: LAYOUT.scenesX + col * (LAYOUT.sceneW + LAYOUT.gapX), y: LAYOUT.scenesY + row * (LAYOUT.sceneH + LAYOUT.gapY) }
}

/** Would scene cards at `a` and `b` overlap (cards closer than half a gap count as overlapping)? */
function cardsOverlap(a: XY, b: XY): boolean {
  return Math.abs(a.x - b.x) < LAYOUT.sceneW + LAYOUT.gapX / 2 && Math.abs(a.y - b.y) < LAYOUT.sceneH + LAYOUT.gapY / 2
}

/** First grid slot from `start` on whose card would not overlap any card at `taken`. */
function freeScenePosition(taken: XY[], start: number): XY {
  for (let i = start; i < start + 10000; i++) {
    const pos = scenePosition(i)
    if (!taken.some((t) => cardsOverlap(t, pos))) return pos
  }
  return scenePosition(start)
}

/**
 * New positions that push scenes to the right so none overlaps a new card at `pos`. Only cards hit by the
 * new card (or by a card pushed before them) move; unrelated cards stay where the user put them.
 */
function makeRoomAt(scenes: Scene[], pos: XY): Map<string, XY> {
  const pushers: XY[] = [pos]
  const placed: XY[] = [pos]
  const moved = new Map<string, XY>()
  const byX = [...scenes].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
  for (const s of byX) {
    let next = s.position
    if (pushers.some((q) => cardsOverlap(q, next))) {
      for (let g = 0; g < 10000; g++) {
        const hit = placed.find((q) => cardsOverlap(q, next))
        if (!hit) break
        next = { x: hit.x + LAYOUT.sceneW + LAYOUT.gapX, y: next.y }
      }
      moved.set(s.id, next)
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

/** Would linking prev -> scene create a loop in the continuity chain? */
function createsCycle(scenes: Scene[], sceneId: string, prevId: string): boolean {
  const byId = new Map(scenes.map((s) => [s.id, s]))
  let cur: string | null = prevId
  for (let guard = 0; cur && guard < 10000; guard++) {
    if (cur === sceneId) return true
    cur = byId.get(cur)?.continueFrom ?? null
  }
  return false
}

export interface AddRefsResult {
  added: number
  skipped: number
  scenes: number
}

export interface ProjectState {
  project: Project

  // project
  loadProject: (p: Project) => void
  renameProject: (name: string) => void
  updateProjectSettings: (patch: Partial<ProjectSettings>) => void

  // assets
  addAsset: (partial: Partial<Asset> & { name: string }) => string
  updateAsset: (id: string, patch: Partial<Omit<Asset, 'id'>>) => void
  removeAssets: (ids: string[]) => void
  setAssetOnCanvas: (id: string, position: XY | null) => void
  /** Batched version: one undo step for many assets. */
  setAssetsOnCanvas: (positions: Record<string, XY | null>) => void

  // blocks
  addBlock: (partial?: Partial<PromptBlock>) => string
  updateBlock: (id: string, patch: Partial<Omit<PromptBlock, 'id'>>) => void
  removeBlock: (id: string) => void
  moveBlock: (id: string, toIndex: number) => void
  /** on=undefined clears the override (scene follows block default). */
  setBlockOverride: (sceneIds: string[], blockId: string, on: boolean | undefined) => void

  // presets
  addPreset: (partial: Partial<Preset> & { name: string }) => string
  updatePreset: (id: string, patch: Partial<Omit<Preset, 'id'>>) => void
  removePreset: (id: string) => void
  applyPreset: (presetId: string, sceneIds: string[]) => void

  // scenes
  addScene: (partial?: Partial<Scene>, opts?: { afterId?: string; position?: XY }) => string
  updateScene: (id: string, patch: Partial<Omit<Scene, 'id' | 'settings'>>) => void
  /** Prompt edits are coalesced in the undo history and auto-link @mentioned assets. Returns newly linked asset ids. */
  setScenePrompt: (id: string, prompt: string) => string[]
  updateSettings: (sceneIds: string[], patch: Partial<VideoSettings>) => void
  /** Restore prompt, refs and settings (e.g. from a take) in one undo step. Refs to deleted assets are dropped. */
  restoreScene: (id: string, data: { prompt: string; refs: string[]; settings: VideoSettings }) => void
  removeScenes: (ids: string[]) => void
  duplicateScenes: (ids: string[]) => string[]
  /** New scene right after `fromId`, inheriting refs, block overrides and settings; continues from it. */
  createNextScene: (fromId: string, position?: XY) => string
  moveScene: (id: string, toOrder: number) => void
  setContinueFrom: (sceneId: string, prevId: string | null) => boolean
  setFrame: (sceneId: string, which: 'first' | 'last', assetId: string | null) => void

  // references (the "connections")
  addRefs: (sceneIds: string[], assetIds: string[]) => AddRefsResult
  removeRef: (sceneId: string, assetId: string) => void
  removeRefs: (pairs: { sceneId: string; assetId: string }[]) => void
  moveRef: (sceneId: string, fromIndex: number, toIndex: number) => void
  moveRefToScene: (assetId: string, fromSceneId: string, toSceneId: string) => void

  /** One undo step: delete scenes, hide assets from canvas, cut ref / sequence / frame links. */
  deleteItems: (items: {
    sceneIds?: string[]
    hideAssetIds?: string[]
    refs?: { sceneId: string; assetId: string }[]
    seqSceneIds?: string[]
    frames?: { sceneId: string; which: 'first' | 'last' }[]
  }) => void

  // layout
  setPositions: (positions: Record<string, XY>) => void
  autoLayout: () => void

  // bulk
  applyImport: (data: { blocks: PromptBlock[]; scenes: Partial<Scene>[] }) => void
}

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })

export const useProject = create<ProjectState>()(
  temporal(
    (set, get) => {
      const mutate = (fn: (p: Project) => Project) => set((s) => ({ project: touch(fn(s.project)) }))
      const mapScenes = (ids: string[], fn: (s: Scene) => Scene) => {
        const idSet = new Set(ids)
        mutate((p) => ({ ...p, scenes: p.scenes.map((s) => (idSet.has(s.id) ? fn(s) : s)) }))
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
            return {
              ...p,
              assets: p.assets.map((a) => {
                if (a.id !== id) return a
                const next = { ...a, ...patch }
                if (patch.tag !== undefined) next.tag = uniqueTag(patch.tag || next.name, others)
                return next
              }),
            }
          })
        },
        removeAssets: (ids) => {
          const set_ = new Set(ids)
          mutate((p) => ({
            ...p,
            assets: p.assets.filter((a) => !set_.has(a.id)),
            scenes: p.scenes.map((s) =>
              s.refs.some((r) => set_.has(r)) || (s.firstFrame && set_.has(s.firstFrame)) || (s.lastFrame && set_.has(s.lastFrame))
                ? {
                    ...s,
                    refs: s.refs.filter((r) => !set_.has(r)),
                    firstFrame: s.firstFrame && set_.has(s.firstFrame) ? null : s.firstFrame,
                    lastFrame: s.lastFrame && set_.has(s.lastFrame) ? null : s.lastFrame,
                  }
                : s,
            ),
          }))
        },
        setAssetOnCanvas: (id, position) => mutate((p) => ({ ...p, assets: p.assets.map((a) => (a.id === id ? { ...a, position } : a)) })),
        setAssetsOnCanvas: (positions) =>
          mutate((p) => ({ ...p, assets: p.assets.map((a) => (a.id in positions ? { ...a, position: positions[a.id] } : a)) })),

        // ---------------- blocks ----------------
        addBlock: (partial = {}) => {
          const id = partial.id ?? newId('blk')
          mutate((p) => ({
            ...p,
            blocks: [
              ...p.blocks,
              {
                id,
                title: partial.title ?? 'Khối mới',
                text: partial.text ?? '',
                placement: partial.placement ?? 'after',
                defaultOn: partial.defaultOn ?? true,
                color: partial.color ?? pickColor(p.blocks.length + 3),
              },
            ],
          }))
          return id
        },
        updateBlock: (id, patch) => {
          if (patch.text !== undefined || patch.title !== undefined) coalesce('block:' + id)
          mutate((p) => ({ ...p, blocks: p.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }))
        },
        removeBlock: (id) =>
          mutate((p) => ({
            ...p,
            blocks: p.blocks.filter((b) => b.id !== id),
            scenes: p.scenes.map((s) => {
              if (!(id in s.blockOverrides)) return s
              const { [id]: _drop, ...rest } = s.blockOverrides
              return { ...s, blockOverrides: rest }
            }),
          })),
        moveBlock: (id, toIndex) =>
          mutate((p) => {
            const list = [...p.blocks]
            const from = list.findIndex((b) => b.id === id)
            if (from < 0) return p
            const [b] = list.splice(from, 1)
            list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, b)
            return { ...p, blocks: list }
          }),
        setBlockOverride: (sceneIds, blockId, on) =>
          mapScenes(sceneIds, (s) => {
            const next = { ...s.blockOverrides }
            if (on === undefined) delete next[blockId]
            else next[blockId] = on
            return { ...s, blockOverrides: next }
          }),

        // ---------------- presets ----------------
        addPreset: (partial) => {
          const id = partial.id ?? newId('pst')
          const settings = normalizeSettings(partial)
          mutate((p) => ({ ...p, presets: [...p.presets, { id, name: partial.name, ...settings }] }))
          return id
        },
        updatePreset: (id, patch) =>
          mutate((p) => ({
            ...p,
            presets: p.presets.map((x) => (x.id === id ? { ...x, ...patch, ...normalizeSettings({ ...x, ...patch }) } : x)),
          })),
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
          mapScenes(sceneIds, (s) => ({ ...s, presetId, settings: normalizeSettings({ ...settings, mode: settings.mode }) }))
        },

        // ---------------- scenes ----------------
        addScene: (partial = {}, opts = {}) => {
          const p = get().project
          const id = partial.id ?? newId('scn')
          const sorted = [...p.scenes].sort((a, b) => a.order - b.order)
          const after = opts.afterId ? sorted.find((s) => s.id === opts.afterId) : undefined
          const order = after ? after.order + 0.5 : sorted.length + 1
          const draftPreset = p.presets[0]
          const settings = normalizeSettings(partial.settings ?? (draftPreset ? { ...draftPreset } : {}))
          const scene: Scene = {
            id,
            order,
            title: partial.title ?? '',
            prompt: partial.prompt ?? '',
            refs: partial.refs ?? [],
            blockOverrides: partial.blockOverrides ?? {},
            presetId: partial.presetId ?? (partial.settings ? null : draftPreset?.id ?? null),
            settings,
            continueFrom: partial.continueFrom ?? null,
            firstFrame: partial.firstFrame ?? null,
            lastFrame: partial.lastFrame ?? null,
            color: partial.color ?? null,
            position: opts.position ?? partial.position ?? freeScenePosition(p.scenes.map((s) => s.position), p.scenes.length),
            note: partial.note ?? '',
          }
          mutate((pp) => ({ ...pp, scenes: renumber([...pp.scenes, scene]) }))
          return id
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
          mapScenes(sceneIds, (s) => ({ ...s, presetId: null, settings: normalizeSettings({ ...s.settings, ...patch }) })),
        restoreScene: (id, { prompt, refs, settings }) =>
          mutate((p) => {
            const alive = new Set(p.assets.map((a) => a.id))
            return {
              ...p,
              scenes: p.scenes.map((s) =>
                s.id === id
                  ? { ...s, prompt, refs: refs.filter((r) => alive.has(r)), presetId: null, settings: normalizeSettings({ ...s.settings, ...settings }) }
                  : s,
              ),
            }
          }),
        removeScenes: (ids) => {
          const set_ = new Set(ids)
          mutate((p) => {
            const byId = new Map(p.scenes.map((s) => [s.id, s]))
            // Re-link successors of removed scenes to the nearest surviving predecessor.
            const survivorPrev = (prev: string | null): string | null => {
              let cur = prev
              for (let g = 0; cur && set_.has(cur) && g < 10000; g++) cur = byId.get(cur)?.continueFrom ?? null
              return cur
            }
            const scenes = p.scenes
              .filter((s) => !set_.has(s.id))
              .map((s) => (s.continueFrom && set_.has(s.continueFrom) ? { ...s, continueFrom: survivorPrev(s.continueFrom) } : s))
            return { ...p, scenes: renumber(scenes) }
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
        createNextScene: (fromId, position) => {
          const p = get().project
          const from = p.scenes.find((s) => s.id === fromId)
          if (!from) return get().addScene()
          const id = newId('scn')
          const next: Scene = {
            ...from,
            id,
            order: from.order + 0.5,
            title: '',
            prompt: '',
            note: '',
            continueFrom: from.id,
            position: position ?? { x: from.position.x + LAYOUT.sceneW + LAYOUT.gapX, y: from.position.y },
          }
          // Default spot (right of `from`) is usually the next card of the row: shift those cards right to make room.
          const moved = position ? new Map<string, XY>() : makeRoomAt(p.scenes, next.position)
          mutate((pp) => ({
            ...pp,
            // Whatever continued from `from` now continues from the new scene (insert into the chain).
            scenes: renumber([
              ...pp.scenes.map((s) => {
                const pos = moved.get(s.id)
                const linked = s.continueFrom === from.id ? { ...s, continueFrom: id } : s
                return pos ? { ...linked, position: pos } : linked
              }),
              next,
            ]),
          }))
          return id
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
        setContinueFrom: (sceneId, prevId) => {
          if (prevId && (prevId === sceneId || createsCycle(get().project.scenes, sceneId, prevId))) return false
          mapScenes([sceneId], (s) => ({ ...s, continueFrom: prevId }))
          return true
        },
        setFrame: (sceneId, which, assetId) =>
          mapScenes([sceneId], (s) => (which === 'first' ? { ...s, firstFrame: assetId } : { ...s, lastFrame: assetId })),

        // ---------------- references ----------------
        addRefs: (sceneIds, assetIds) => {
          const p = get().project
          const result: AddRefsResult = { added: 0, skipped: 0, scenes: 0 }
          const assets = assetIds.filter((id) => p.assets.some((a) => a.id === id))
          const ids = new Set(sceneIds)
          const scenes = p.scenes.map((s) => {
            if (!ids.has(s.id)) return s
            const limit = MODELS[s.settings.model].maxRefImages
            let refs = s.refs
            let changed = false
            for (const a of assets) {
              if (refs.includes(a)) continue
              if (refImageCount(p, [...refs, a]) > limit) {
                result.skipped++
                continue
              }
              refs = [...refs, a]
              result.added++
              changed = true
            }
            if (changed) result.scenes++
            return changed ? { ...s, refs } : s
          })
          if (result.added) mutate((pp) => ({ ...pp, scenes }))
          return result
        },
        removeRef: (sceneId, assetId) => mapScenes([sceneId], (s) => ({ ...s, refs: s.refs.filter((r) => r !== assetId) })),
        removeRefs: (pairs) => {
          const bySceneId = new Map<string, Set<string>>()
          for (const { sceneId, assetId } of pairs) {
            if (!bySceneId.has(sceneId)) bySceneId.set(sceneId, new Set())
            bySceneId.get(sceneId)!.add(assetId)
          }
          mapScenes([...bySceneId.keys()], (s) => ({ ...s, refs: s.refs.filter((r) => !bySceneId.get(s.id)!.has(r)) }))
        },
        moveRef: (sceneId, fromIndex, toIndex) =>
          mapScenes([sceneId], (s) => {
            const refs = [...s.refs]
            const [r] = refs.splice(fromIndex, 1)
            if (r === undefined) return s
            refs.splice(Math.max(0, Math.min(refs.length, toIndex)), 0, r)
            return { ...s, refs }
          }),
        moveRefToScene: (assetId, fromSceneId, toSceneId) => {
          if (fromSceneId === toSceneId) return
          const p = get().project
          const target = p.scenes.find((s) => s.id === toSceneId)
          if (!target) return
          const canAdd = !target.refs.includes(assetId) && refImageCount(p, [...target.refs, assetId]) <= MODELS[target.settings.model].maxRefImages
          // Target is over its image limit: reject the move and keep the original link.
          if (!canAdd && !target.refs.includes(assetId)) return
          mutate((pp) => ({
            ...pp,
            scenes: pp.scenes.map((s) => {
              if (s.id === fromSceneId) return { ...s, refs: s.refs.filter((r) => r !== assetId) }
              if (s.id === toSceneId && canAdd) return { ...s, refs: [...s.refs, assetId] }
              return s
            }),
          }))
        },

        deleteItems: ({ sceneIds = [], hideAssetIds = [], refs = [], seqSceneIds = [], frames = [] }) =>
          mutate((p) => {
            const dead = new Set(sceneIds)
            const hide = new Set(hideAssetIds)
            const cutRefs = new Map<string, Set<string>>()
            for (const r of refs) {
              if (!cutRefs.has(r.sceneId)) cutRefs.set(r.sceneId, new Set())
              cutRefs.get(r.sceneId)!.add(r.assetId)
            }
            const cutSeq = new Set(seqSceneIds)
            const byId = new Map(p.scenes.map((s) => [s.id, s]))
            const survivorPrev = (prev: string | null): string | null => {
              let cur = prev
              for (let g = 0; cur && dead.has(cur) && g < 10000; g++) cur = byId.get(cur)?.continueFrom ?? null
              return cur
            }
            const scenes = p.scenes
              .filter((s) => !dead.has(s.id))
              .map((s) => {
                let next = s
                if (cutRefs.has(s.id)) next = { ...next, refs: next.refs.filter((r) => !cutRefs.get(s.id)!.has(r)) }
                if (cutSeq.has(s.id)) next = { ...next, continueFrom: null }
                else if (next.continueFrom && dead.has(next.continueFrom)) next = { ...next, continueFrom: survivorPrev(next.continueFrom) }
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
        autoLayout: () =>
          mutate((p) => {
            const sorted = [...p.scenes].sort((a, b) => a.order - b.order)
            const pos = new Map(sorted.map((s, i) => [s.id, scenePosition(i)]))
            let y = LAYOUT.scenesY
            const assets = p.assets.map((a) => {
              if (!a.position) return a
              const next = { ...a, position: { x: LAYOUT.assetX, y } }
              y += LAYOUT.assetH + LAYOUT.assetGapY
              return next
            })
            return { ...p, assets, scenes: p.scenes.map((s) => ({ ...s, position: pos.get(s.id)! })) }
          }),

        applyImport: ({ blocks, scenes }) =>
          mutate((p) => {
            const start = p.scenes.length
            const sorted = [...p.scenes].sort((a, b) => a.order - b.order)
            let prev = sorted[sorted.length - 1]?.id ?? null
            const draft = p.presets[0]
            const taken = p.scenes.map((s) => s.position)
            const created: Scene[] = scenes.map((partial, i) => {
              const position = freeScenePosition(taken, start + i)
              taken.push(position)
              const id = partial.id ?? newId('scn')
              const s: Scene = {
                id,
                order: start + i + 1,
                title: partial.title ?? '',
                prompt: partial.prompt ?? '',
                refs: partial.refs ?? [],
                blockOverrides: partial.blockOverrides ?? {},
                presetId: partial.presetId ?? draft?.id ?? null,
                settings: normalizeSettings(partial.settings ?? (draft ? { ...draft } : {})),
                continueFrom: partial.continueFrom !== undefined ? partial.continueFrom : prev,
                firstFrame: null,
                lastFrame: null,
                color: null,
                position,
                note: partial.note ?? '',
              }
              prev = id
              return s
            })
            return { ...p, blocks: [...p.blocks, ...blocks], scenes: renumber([...p.scenes, ...created]) }
          }),
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

/** Convenience selectors */
export const selectScene = (id: string | null | undefined) => (s: ProjectState) => (id ? s.project.scenes.find((x) => x.id === id) : undefined)
export const selectAsset = (id: string | null | undefined) => (s: ProjectState) => (id ? s.project.assets.find((x) => x.id === id) : undefined)
export const sortedScenes = (p: Project) => [...p.scenes].sort((a, b) => a.order - b.order)
