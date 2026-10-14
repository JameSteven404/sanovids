// Commands of the right-click menus that had no ready-made function: cutting an image off several scenes at once
// ("ngắt nối nhanh"), cutting everything off one scene, hiding image cards by id. They only combine existing paths and
// keep their rules: the prompt being typed is committed first (flushScenes), the canvas animates the cut wires BEFORE
// the store changes (announceWireCuts), ONE undo step (one deleteItems call), the removed pictures' tokens become red
// placeholders "@image_?N(label)" (store withMedia — no prompt text is ever deleted) and the toast tells so
// (mediaChangeNote) with "Hoàn tác". Never asks anything (no confirm dialog): the menus ask before calling.
import { edgeId, parseEdgeId, selectedAssetIds, selectedSceneIds, announceWireCuts } from './actions'
import { sceneCode } from './core/compile'
import { mediaChangeNote } from './core/staleTokens'
import type { Project } from './core/types'
import { flushScenes } from './lib/promptDrafts'
import { oneUndoStep, undoToastAction, useProject } from './store/project'
import { toast, useUI } from './store/ui'
import { useCanvasLocal } from './components/canvas/canvasModel'

export interface LinkedPairs {
  /** Reference images to cut (asset in scene.refs). */
  refs: { sceneId: string; assetId: string }[]
  /** First / last frames to clear (the asset is that frame). */
  frames: { sceneId: string; which: 'first' | 'last'; assetId: string }[]
  /** Ids of the wires those links draw (ref / first / last). */
  edgeIds: string[]
  /** Scenes touched, in project order. */
  sceneIds: string[]
}

/**
 * Every link between `assetIds` and `sceneIds` that exists in `project`: reference images and first / last frames.
 * Unknown ids are ignored. Pure (reads only `project`).
 */
export function linkedPairs(assetIds: readonly string[], sceneIds: readonly string[], project: Project = useProject.getState().project): LinkedPairs {
  const assets = new Set(assetIds)
  const scenes = new Set(sceneIds)
  const out: LinkedPairs = { refs: [], frames: [], edgeIds: [], sceneIds: [] }
  for (const s of project.scenes) {
    if (!scenes.has(s.id)) continue
    let touched = false
    for (const a of s.refs) {
      if (!assets.has(a)) continue
      out.refs.push({ sceneId: s.id, assetId: a })
      out.edgeIds.push(edgeId('ref', a, s.id))
      touched = true
    }
    if (s.firstFrame && assets.has(s.firstFrame)) {
      out.frames.push({ sceneId: s.id, which: 'first', assetId: s.firstFrame })
      out.edgeIds.push(edgeId('first', s.firstFrame, s.id))
      touched = true
    }
    if (s.lastFrame && assets.has(s.lastFrame)) {
      out.frames.push({ sceneId: s.id, which: 'last', assetId: s.lastFrame })
      out.edgeIds.push(edgeId('last', s.lastFrame, s.id))
      touched = true
    }
    if (touched) out.sceneIds.push(s.id)
  }
  return out
}

/** The image links (ref / first / last) that these wire ids still draw; other wires and stale ids are left out. */
export function wireLinks(edgeIds: readonly string[], project: Project = useProject.getState().project): LinkedPairs {
  const ids = new Set(edgeIds)
  const ends = edgeIds.flatMap((id) => {
    const e = parseEdgeId(id)
    return e && (e.kind === 'ref' || e.kind === 'first' || e.kind === 'last') ? [e] : []
  })
  const all = linkedPairs(ends.map((e) => e.from), ends.map((e) => e.to), project)
  const refs = all.refs.filter((r) => ids.has(edgeId('ref', r.assetId, r.sceneId)))
  const frames = all.frames.filter((f) => ids.has(edgeId(f.which, f.assetId, f.sceneId)))
  const touched = new Set([...refs, ...frames].map((x) => x.sceneId))
  return { refs, frames, edgeIds: all.edgeIds.filter((id) => ids.has(id)), sceneIds: all.sceneIds.filter((id) => touched.has(id)) }
}

/** Scenes that use this image (reference or first / last frame), in project order. */
export function scenesUsingAsset(assetId: string, project: Project = useProject.getState().project): string[] {
  return project.scenes.filter((s) => s.refs.includes(assetId) || s.firstFrame === assetId || s.lastFrame === assetId).map((s) => s.id)
}

/** Drop cut wires from the wire selection and the hovered wire (as cutEdge does). */
function forgetWires(ids: readonly string[]) {
  const ui = useUI.getState()
  if (ids.length && ui.selectedEdgeIds.some((id) => ids.includes(id))) ui.setSelectedEdges(ui.selectedEdgeIds.filter((id) => !ids.includes(id)))
  useCanvasLocal.getState().setHoveredEdge(null)
}

/** Cut `pairs` in one undo step and say `what` was cut (+ the placeholder note, + Hoàn tác). Returns links cut. */
function cutPairs(pairs: LinkedPairs, what: (project: Project) => string, at?: { x: number; y: number }): number {
  const links = pairs.refs.length + pairs.frames.length
  if (!links) return 0
  // The prompt being typed is renumbered with the change instead of overwriting it a moment later.
  flushScenes(pairs.sceneIds)
  // The canvas reads the wires' drawn paths now, before they leave the store.
  announceWireCuts(pairs.edgeIds, at)
  const before = useProject.getState().project
  const said = what(before)
  oneUndoStep(() => useProject.getState().deleteItems({ refs: pairs.refs, frames: pairs.frames }))
  forgetWires(pairs.edgeIds)
  const note = mediaChangeNote(before, useProject.getState().project)
  toast(`${said}${note?.text ?? ''}.`, {
    action: undoToastAction(),
    ...(note && note.tone === 'warning' ? { tone: 'warning' as const, ms: note.ms ?? 8000 } : {}),
  })
  return links
}

/**
 * Cut every image of `assetIds` off every scene of `sceneIds` (references and first / last frames) — ONE undo step,
 * cut animation, placeholders, toast with Hoàn tác. The menus' quick unlink ("Bỏ nối Elara khỏi S03",
 * "… khỏi 3 cảnh đang chọn", "… khỏi mọi cảnh"). Returns how many links were cut (0: nothing was linked, no toast).
 */
export function unlinkAssetsFromScenes(assetIds: readonly string[], sceneIds: readonly string[], opts: { at?: { x: number; y: number } } = {}): number {
  const pairs = linkedPairs(assetIds, sceneIds)
  return cutPairs(
    pairs,
    (p) => {
      const cutIds = [...new Set([...pairs.refs.map((r) => r.assetId), ...pairs.frames.map((f) => f.assetId)])]
      const names = cutIds.map((id) => p.assets.find((a) => a.id === id)?.name || 'ảnh')
      const where =
        pairs.sceneIds.length === 1
          ? sceneCode(p.scenes.find((s) => s.id === pairs.sceneIds[0])?.order ?? 0)
          : `${pairs.sceneIds.length} cảnh`
      if (names.length === 1) return `Đã bỏ nối ${names[0]} khỏi ${where}`
      return `Đã bỏ nối ${names.length} ảnh (${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}) khỏi ${where}`
    },
    opts.at,
  )
}

/**
 * The selected images (canvas cards, else the library selection — same rule as C) cut off the selected scenes.
 * Says what to select when there is nothing to cut.
 */
export function unlinkSelection(): number {
  const scenes = selectedSceneIds()
  const assets = selectedAssetIds()
  if (!scenes.length || !assets.length) {
    toast('Chọn ảnh và cảnh đã nối với nhau rồi thử lại.', { tone: 'warning' })
    return 0
  }
  const cut = unlinkAssetsFromScenes(assets, scenes)
  if (!cut) toast('Các ảnh đang chọn chưa nối vào cảnh nào đang chọn.', { tone: 'info' })
  return cut
}

/** Cut these image wires (ref / first / last; others ignored), one undo step. Returns links cut. */
export function unlinkWires(edgeIds: readonly string[]): number {
  const pairs = wireLinks(edgeIds)
  return cutPairs(pairs, () => `Đã bỏ nối ${pairs.edgeIds.length} dây`)
}

/** Every image and frame cut off one scene, one undo step. */
export function unlinkAllFromScene(sceneId: string): number {
  const scene = useProject.getState().project.scenes.find((s) => s.id === sceneId)
  if (!scene) return 0
  const ids = [...scene.refs, scene.firstFrame, scene.lastFrame].filter((x): x is string => !!x)
  const pairs = linkedPairs(ids, [sceneId])
  const links = pairs.refs.length + pairs.frames.length
  return cutPairs(pairs, (p) => `Đã bỏ nối ${links} ảnh khỏi ${sceneCode(p.scenes.find((s) => s.id === sceneId)?.order ?? 0)}`)
}

/** Hide image cards from the canvas by id (they stay in the library, links kept), one undo step, with Hoàn tác. */
export function hideAssets(assetIds: readonly string[]): number {
  const p = useProject.getState().project
  const ids = assetIds.filter((id) => p.assets.some((a) => a.id === id && a.position))
  if (!ids.length) return 0
  oneUndoStep(() => useProject.getState().deleteItems({ hideAssetIds: ids }))
  const ui = useUI.getState()
  if (ui.selectedIds.some((id) => ids.includes(id))) ui.select(ui.selectedIds.filter((id) => !ids.includes(id)))
  toast(`Đã ẩn ${ids.length} thẻ khỏi canvas — vẫn còn trong thư viện, các nối giữ nguyên.`, { action: undoToastAction() })
  return ids.length
}
