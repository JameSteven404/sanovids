// Adding image files to a library item, shared by the asset dialog and the asset inspector.
// Storing big photos in IndexedDB takes a moment: batches for one asset run one after the other (each appends to
// the list the previous one left) and the panels disable the image controls meanwhile (`useAddingImages`), so a
// remove / reorder made during the wait is not overwritten when the new images are appended.
import { create } from 'zustand'
import { addImagesToAsset } from '../../actions'
import { undoToastAction, useProject } from '../../store/project'
import { toast } from '../../store/ui'
import { changedPrompts, scenesWithShiftedImageTokens, staleTokenNote } from './shared'

/** Number of image batches being stored, per asset id. */
const useImageJobs = create<Record<string, number>>(() => ({}))
const queues = new Map<string, Promise<void>>()

const bump = (assetId: string, by: number) =>
  useImageJobs.setState((s) => {
    const n = (s[assetId] ?? 0) + by
    const next = { ...s }
    if (n > 0) next[assetId] = n
    else delete next[assetId]
    return next
  }, true)

/** True while images are being added to this asset (show a busy state, keep the image list as is). */
export function useAddingImages(assetId: string): boolean {
  return useImageJobs((s) => (s[assetId] ?? 0) > 0)
}

/**
 * Scenes whose @image tokens will point at another photo after changing the asset's images from index `from`
 * (to `to`) — only when automatic renumbering is off (Settings); with it on the store rewrites them. Read BEFORE
 * the change.
 */
export function staleTokenScenes(assetId: string, from: number, to?: number): string[] {
  const p = useProject.getState().project
  if (p.settings.autoRenumber) return []
  return scenesWithShiftedImageTokens(p.assets, p.scenes, assetId, from, to)
}

/** " · tự đánh lại số đang tắt — hãy sửa số @image trong S02, S05" */
export function staleNote(sceneIds: string[]): string {
  return staleTokenNote(useProject.getState().project, sceneIds)
}

/** Add image files (others are ignored with a warning) after the asset's current images, then report it. */
export function addImageFiles(assetId: string, files: File[]): Promise<void> {
  const images = files.filter((f) => /^image\//.test(f.type))
  if (!images.length) {
    if (files.length) toast('Chỉ nhận file ảnh (JPG, PNG, WEBP).', { tone: 'warning' })
    return Promise.resolve()
  }
  bump(assetId, 1)
  const job = (queues.get(assetId) ?? Promise.resolve())
    .then(() => storeImages(assetId, images))
    .catch(() => {
      toast('Không lưu được ảnh (bộ nhớ trình duyệt đầy hoặc bị chặn).', { tone: 'error' })
    })
    .finally(() => {
      bump(assetId, -1)
      if (queues.get(assetId) === job) queues.delete(assetId)
    })
  queues.set(assetId, job)
  return job
}

async function storeImages(assetId: string, images: File[]) {
  const start = useProject.getState().project
  const asset = start.assets.find((a) => a.id === assetId)
  if (!asset) return
  // New images go after the asset's current ones: the numbers after them move.
  const stale = staleTokenScenes(assetId, asset.imageIds.length)
  await addImagesToAsset(assetId, images)
  const now = useProject.getState().project
  const after = now.assets.find((a) => a.id === assetId)
  if (!after) return
  const name = after.name || after.tag
  if (stale.length) {
    toast(`Đã thêm ${images.length} ảnh cho “${name}”${staleNote(stale)}.`, { tone: 'warning', action: undoToastAction() })
    return
  }
  // Only count scenes using this asset: other prompts may have been edited while the files were being stored.
  const using = new Set(now.scenes.filter((s) => s.refs.includes(assetId)).map((s) => s.id))
  const rewritten = changedPrompts(start.scenes, now.scenes).filter((id) => using.has(id)).length
  toast(`Đã thêm ${images.length} ảnh cho “${name}”${rewritten ? ` · đánh lại số @image trong ${rewritten} prompt` : ''}.`, {
    tone: 'success',
    action: undoToastAction(),
  })
}
