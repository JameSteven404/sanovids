// High-level commands shared by toolbar buttons, keyboard shortcuts, context menus and panels.
// Keep UI components thin: they call these, these call the stores.
import JSZip from 'jszip'
import { compileScene, sceneCode } from './core/compile'
import type { AssetKind, XY } from './core/types'
import { getBlob, putBlob } from './lib/imageStore'
import { redo, undo, useProject } from './store/project'
import { useRuns } from './store/runs'
import { toast, useUI } from './store/ui'

// ---------------- edge ids ----------------
export type EdgeKind = 'ref' | 'seq' | 'first' | 'last'
export const edgeId = (kind: EdgeKind, from: string, to: string) => `${kind}:${from}->${to}`
export function parseEdgeId(id: string): { kind: EdgeKind; from: string; to: string } | null {
  const m = /^(ref|seq|first|last):(.+)->(.+)$/.exec(id)
  return m ? { kind: m[1] as EdgeKind, from: m[2], to: m[3] } : null
}

// ---------------- canvas event bus (canvas listens; others request) ----------------
export const canvasEvents = new EventTarget()
/** Canvas event that always fits (zooms) to the given ids, or to everything when empty. */
export const FIT_EVENT = 'fit'
export function fitNodes(ids: string[] = []) {
  canvasEvents.dispatchEvent(new CustomEvent(FIT_EVENT, { detail: ids }))
}
/** Ask the canvas to pan to these node ids if they are off-screen (all nodes when empty). */
export function focusNodes(ids: string[] = []) {
  canvasEvents.dispatchEvent(new CustomEvent('focus', { detail: ids }))
}

// ---------------- selection helpers ----------------
export function selectedSceneIds(): string[] {
  const { selectedIds } = useUI.getState()
  const scenes = new Set(useProject.getState().project.scenes.map((s) => s.id))
  return selectedIds.filter((id) => scenes.has(id))
}

/** Assets selected on the canvas plus those selected in the library. */
export function selectedAssetIds(): string[] {
  const { selectedIds, librarySelection } = useUI.getState()
  const assets = new Set(useProject.getState().project.assets.map((a) => a.id))
  return [...new Set([...selectedIds.filter((id) => assets.has(id)), ...librarySelection.filter((id) => assets.has(id))])]
}

export function undoWithToast() {
  undo()
}

// ---------------- connecting ----------------
/** Link assets to scenes in one undo step and report what happened. */
export function linkAssets(sceneIds: string[], assetIds: string[]) {
  if (!sceneIds.length || !assetIds.length) return
  const res = useProject.getState().addRefs(sceneIds, assetIds)
  const names = assetIds
    .map((id) => useProject.getState().project.assets.find((a) => a.id === id)?.tag)
    .filter(Boolean)
    .map((t) => '@' + t)
  if (res.added) {
    toast(
      `Đã nối ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''} → ${res.scenes} cảnh${res.skipped ? ` (bỏ qua ${res.skipped} vì vượt giới hạn ảnh)` : ''}`,
      { tone: 'success', action: { label: 'Hoàn tác', run: undo } },
    )
  } else if (res.skipped) {
    toast(`Không nối được: vượt giới hạn ảnh của model (${res.skipped}).`, { tone: 'warning' })
  } else {
    toast('Các cảnh đã có sẵn những tham chiếu này.', { tone: 'info' })
  }
}

/** "C" — connect every selected asset to every selected scene (matrix connect). */
export function connectSelection() {
  const scenes = selectedSceneIds()
  const assets = selectedAssetIds()
  if (!scenes.length || !assets.length) {
    toast('Chọn ít nhất 1 nhân vật/bối cảnh (thư viện hoặc canvas) và 1 cảnh, rồi bấm C.', { tone: 'warning' })
    return
  }
  linkAssets(scenes, assets)
}

// ---------------- create / delete / duplicate ----------------
export function newScene(position?: XY) {
  const id = useProject.getState().addScene({}, position ? { position } : {})
  useUI.getState().select([id])
  focusNodes([id])
  return id
}

/** "N" — create the next scene after the (single) selected scene, inheriting its refs/blocks/settings. */
export function nextScene(position?: XY) {
  const sel = selectedSceneIds()
  const project = useProject.getState().project
  const from = sel.length ? project.scenes.filter((s) => sel.includes(s.id)).sort((a, b) => b.order - a.order)[0] : undefined
  if (!from) return newScene(position)
  const id = useProject.getState().createNextScene(from.id, position)
  useUI.getState().select([id])
  focusNodes([id])
  toast(`Đã tạo cảnh tiếp theo sau ${sceneCode(from.order)} (giữ nhân vật, khối prompt, cấu hình).`, { tone: 'success' })
  return id
}

export function duplicateSelection() {
  const ids = selectedSceneIds()
  if (!ids.length) return
  const created = useProject.getState().duplicateScenes(ids)
  useUI.getState().select(created)
  toast(`Đã nhân bản ${created.length} cảnh.`, { tone: 'success', action: { label: 'Hoàn tác', run: undo } })
}

/** Delete selected edges (cut links), scenes, and hide selected asset nodes from the canvas. One undo step. */
export function deleteSelection() {
  const { selectedIds, selectedEdgeIds } = useUI.getState()
  const project = useProject.getState().project
  const sceneSet = new Set(project.scenes.map((s) => s.id))
  const assetSet = new Set(project.assets.map((a) => a.id))
  const refs: { sceneId: string; assetId: string }[] = []
  const seqSceneIds: string[] = []
  const frames: { sceneId: string; which: 'first' | 'last' }[] = []
  for (const id of selectedEdgeIds) {
    const e = parseEdgeId(id)
    if (!e) continue
    if (e.kind === 'ref') refs.push({ sceneId: e.to, assetId: e.from })
    else if (e.kind === 'seq') seqSceneIds.push(e.to)
    else frames.push({ sceneId: e.to, which: e.kind })
  }
  const sceneIds = selectedIds.filter((id) => sceneSet.has(id))
  const hideAssetIds = selectedIds.filter((id) => assetSet.has(id))
  if (!sceneIds.length && !hideAssetIds.length && !refs.length && !seqSceneIds.length && !frames.length) return
  useProject.getState().deleteItems({ sceneIds, hideAssetIds, refs, seqSceneIds, frames })
  useUI.getState().clearSelection()
  const parts = [
    sceneIds.length && `${sceneIds.length} cảnh`,
    hideAssetIds.length && `ẩn ${hideAssetIds.length} thẻ khỏi canvas`,
    refs.length + seqSceneIds.length + frames.length && `${refs.length + seqSceneIds.length + frames.length} dây nối`,
  ].filter(Boolean)
  toast(`Đã xoá ${parts.join(', ')}.`, { action: { label: 'Hoàn tác', run: undo } })
}

// ---------------- assets from files ----------------
export async function createAssetsFromFiles(files: File[], opts: { kind?: AssetKind; position?: XY | null } = {}): Promise<string[]> {
  const images = files.filter((f) => /^image\//.test(f.type))
  if (!images.length) {
    toast('Chỉ nhận file ảnh (JPG, PNG, WEBP).', { tone: 'warning' })
    return []
  }
  const ids: string[] = []
  let i = 0
  for (const file of images) {
    const imageId = await putBlob(file, 'img')
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 40) || 'Ảnh'
    const position = opts.position ? { x: opts.position.x + i * 24, y: opts.position.y + i * 24 } : (opts.position ?? null)
    ids.push(useProject.getState().addAsset({ name, kind: opts.kind ?? 'character', imageIds: [imageId], position }))
    i++
  }
  toast(`Đã thêm ${ids.length} mục vào thư viện.`, { tone: 'success' })
  return ids
}

export async function addImagesToAsset(assetId: string, files: File[]) {
  const asset = useProject.getState().project.assets.find((a) => a.id === assetId)
  if (!asset) return
  const ids: string[] = []
  for (const f of files.filter((f) => /^image\//.test(f.type))) ids.push(await putBlob(f, 'img'))
  useProject.getState().updateAsset(assetId, { imageIds: [...asset.imageIds, ...ids] })
}

// ---------------- running ----------------
/** Open the run confirmation dialog (cost summary) for scenes. Defaults to the selection. */
export function requestRun(sceneIds: string[] = selectedSceneIds()) {
  if (!sceneIds.length) {
    toast('Chọn cảnh cần chạy trước.', { tone: 'warning' })
    return
  }
  useUI.getState().openDialog({ kind: 'runConfirm', sceneIds })
}

/** Enqueue immediately (used by the confirm dialog). */
export function runNow(sceneIds: string[]) {
  const res = useRuns.getState().enqueue(sceneIds)
  if (res.error) {
    toast(res.error, { tone: 'error' })
    return res
  }
  toast(`Đã gửi ${res.queued} cảnh vào hàng đợi · −${res.cost} credit${res.skipped.length ? ` · bỏ qua ${res.skipped.length}` : ''}`, { tone: 'success' })
  useUI.getState().setQueueOpen(true)
  return res
}

export function restoreFromTake(takeId: string) {
  const take = useRuns.getState().takes.find((t) => t.id === takeId)
  if (!take) return
  const project = useProject.getState().project
  if (!project.scenes.some((s) => s.id === take.sceneId)) {
    toast('Cảnh của take này đã bị xoá.', { tone: 'warning' })
    return
  }
  const gone = take.refsSnapshot.filter((id) => !project.assets.some((a) => a.id === id)).length
  // One store mutation = one undo step, so the toast's "Hoàn tác" reverts prompt, refs and settings together.
  useProject.getState().restoreScene(take.sceneId, { prompt: take.rawPromptSnapshot, refs: take.refsSnapshot, settings: take.settings })
  toast(`Đã khôi phục prompt & tham chiếu của T${take.number}${gone ? ` (bỏ ${gone} tham chiếu đã bị xoá khỏi thư viện)` : ''}.`, {
    tone: 'success',
    action: { label: 'Hoàn tác', run: undo },
  })
}

// ---------------- copy / export for canvasapp ----------------
export async function copyCompiledPrompt(sceneId: string) {
  const project = useProject.getState().project
  const scene = project.scenes.find((s) => s.id === sceneId)
  if (!scene) return
  const { text } = compileScene(project, scene)
  try {
    await navigator.clipboard.writeText(text)
    toast(`Đã copy prompt ${sceneCode(scene.order)} (${[...text].length.toLocaleString('vi-VN')} ký tự).`, { tone: 'success' })
  } catch {
    toast('Trình duyệt chặn clipboard. Hãy copy thủ công trong ô xem trước.', { tone: 'error' })
  }
}

/** Zip with the reference images renamed in @image order (01_Elara.png ...) + prompt.txt. */
export async function downloadSceneZip(sceneId: string) {
  const project = useProject.getState().project
  const scene = project.scenes.find((s) => s.id === sceneId)
  if (!scene) return
  const compiled = compileScene(project, scene)
  const zip = new JSZip()
  zip.file('prompt.txt', compiled.text)
  for (const img of compiled.images) {
    const blob = await getBlob(img.imageId)
    if (!blob) continue
    const asset = project.assets.find((a) => a.id === img.assetId)
    const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : blob.type.includes('svg') ? 'svg' : 'jpg'
    zip.file(`${String(img.n).padStart(2, '0')}_${asset?.tag ?? 'image'}.${ext}`, blob)
  }
  const out = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(out)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sceneCode(scene.order)}${scene.title ? '_' + scene.title.replace(/[<>:"/\\|?*]/g, '-') : ''}.zip`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export { undo, redo }
