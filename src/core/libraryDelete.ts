// Deleting items from the library ("Thư viện"): what a delete takes, what it asks, what it says. Pure (no stores, no
// React); libraryActions applies it, the library footer shows its counts. Tested in __tests__/libraryDelete.test.ts.
//
// Rules (0.6.0):
// - Delete takes the selected cards the user can SEE (search box and kind tab applied) that still exist, in library
//   order. Selected cards hidden by the search / tab are kept, still selected, and the toast says so.
// - Items no scene uses go at once (one Delete / one click, "Hoàn tác" in the toast). Items scenes use (reference image,
//   H3 first / last frame) ask ONE question first with the counts: their @image tokens are left waiting for a picture.
// - One removeAssets = one undo step; media blobs are never deleted here (duplicated projects share them, queued takes
//   read them by imageKeysSnapshot, the undo history still points at them).
import { textsFor } from '../lib/platformText'
import type { Project } from './types'

export interface LibraryDeletePlan {
  /** Asset ids to delete: selected ∩ visible ∩ existing, in library order. */
  ids: string[]
  /** Selected existing assets hidden by the search box / kind tab: kept, still selected. */
  hidden: string[]
  /** Scenes using a deleted asset (reference image or first / last frame), in scene order, each once. */
  usedBy: string[]
  /** The part of usedBy that has a deleted asset among its reference images (@image tokens). */
  refScenes: string[]
  /** The part of usedBy that has a deleted asset as its first / last frame. */
  frameScenes: string[]
  /** Deleted assets at least one scene uses, in library order. */
  usingAssets: string[]
  /** Deleted assets placed on the canvas. */
  onCanvas: string[]
}

export interface AssetUsage {
  /** Scenes using one of the assets, in scene order. */
  usedBy: string[]
  /** Scenes with one of the assets among their reference images. */
  refScenes: string[]
  /** Scenes with one of the assets as first / last frame. */
  frameScenes: string[]
  /** The assets used by at least one scene. */
  usingAssets: Set<string>
}

/**
 * Which scenes use these assets (reference images, first / last frames).
 * TODO(RVGT): switch to the placeholder track's pure impact helper (assetDeleteImpact or similar) once it is merged, so
 * the question counts exactly the scenes that will be blocked by a placeholder.
 */
export function assetUsage(project: Pick<Project, 'scenes'>, ids: Iterable<string>): AssetUsage {
  const dead = new Set(ids)
  const usingAssets = new Set<string>()
  const used: { id: string; order: number; refs: boolean; frames: boolean }[] = []
  for (const s of project.scenes) {
    let refs = false
    for (const r of s.refs) if (dead.has(r)) {
      refs = true
      usingAssets.add(r)
    }
    let frames = false
    for (const f of [s.firstFrame, s.lastFrame]) if (f && dead.has(f)) {
      frames = true
      usingAssets.add(f)
    }
    if (refs || frames) used.push({ id: s.id, order: s.order, refs, frames })
  }
  used.sort((a, b) => a.order - b.order)
  return {
    usedBy: used.map((u) => u.id),
    refScenes: used.filter((u) => u.refs).map((u) => u.id),
    frameScenes: used.filter((u) => u.frames).map((u) => u.id),
    usingAssets,
  }
}

/**
 * The delete of `selected` with the cards `visible` on screen (null = no filter: every selected item that exists, e.g.
 * the asset dialog's own item). Duplicates and ids of deleted items are dropped.
 */
export function planLibraryDelete(project: Pick<Project, 'assets' | 'scenes'>, selected: readonly string[], visible: readonly string[] | null): LibraryDeletePlan {
  const chosen = new Set(selected)
  const shown = visible ? new Set(visible) : null
  const ids: string[] = []
  const hidden: string[] = []
  const onCanvas: string[] = []
  for (const a of project.assets) {
    if (!chosen.has(a.id)) continue
    if (shown && !shown.has(a.id)) {
      hidden.push(a.id)
      continue
    }
    ids.push(a.id)
    if (a.position) onCanvas.push(a.id)
  }
  const usage = assetUsage(project, ids)
  return {
    ids,
    hidden,
    usedBy: usage.usedBy,
    refScenes: usage.refScenes,
    frameScenes: usage.frameScenes,
    usingAssets: ids.filter((id) => usage.usingAssets.has(id)),
    onCanvas,
  }
}

/**
 * The card to give the keyboard focus after a delete (focus only — nothing gets selected): the one right after the
 * last deleted card in list order, else the nearest one before it, else null.
 */
export function nextFocusAfterDelete(visibleIds: readonly string[], deleted: Iterable<string>): string | null {
  const dead = new Set(deleted)
  let last = -1
  visibleIds.forEach((id, i) => {
    if (dead.has(id)) last = i
  })
  if (last < 0) return null
  for (let i = last + 1; i < visibleIds.length; i++) if (!dead.has(visibleIds[i])) return visibleIds[i]
  for (let i = last - 1; i >= 0; i--) if (!dead.has(visibleIds[i])) return visibleIds[i]
  return null
}

// ---------------- words ----------------
const quoted = (name: string) => `“${name}”`
/** The delete key as written in UI text. */
export const deleteKeyLabel = (mac: boolean) => (mac ? '⌫' : 'Delete')
const undoKeyLabel = (mac: boolean) => (mac ? '⌘Z' : 'Ctrl+Z')

/**
 * The one question asked before deleting items that scenes use, or null when none is used (those go at once).
 * `nameOf` gives an item's display name.
 */
export function libraryDeleteQuestion(plan: LibraryDeletePlan, nameOf: (id: string) => string, mac: boolean): string | null {
  const used = plan.usingAssets.length
  if (!used || !plan.ids.length) return null
  const n = plan.ids.length
  const scenes = plan.usedBy.length
  const head =
    n === 1
      ? `Xoá ${quoted(nameOf(plan.ids[0]))} khỏi thư viện? Mục này đang dùng ở ${scenes} cảnh.`
      : used === n
        ? `Xoá ${n} mục đang dùng ở ${scenes} cảnh?`
        : `Xoá ${n} mục khỏi thư viện? ${used} mục trong đó đang dùng ở ${scenes} cảnh.`
  const lines = [head]
  if (plan.refScenes.length) lines.push('Chữ trong prompt sẽ thành chữ đỏ chờ ảnh.')
  if (plan.frameScenes.length) lines.push('Cảnh dùng làm khung đầu / cuối sẽ mất khung đó.')
  lines.push(`Hoàn tác được (${undoKeyLabel(mac)}).`)
  return lines.join('\n')
}

export interface LibraryDeleteToast {
  text: string
  tone: 'info' | 'warning'
  /** Longer than the default when there is more to read (items in use, several items, prompts to fix). */
  ms?: number
}

/**
 * The toast after a delete (its "Hoàn tác" button comes from undoToastAction). `rewritten` = prompts renumbered by the
 * store; `staleNote` = staleTokenNote(...) when automatic renumbering is off ('' otherwise).
 */
export function libraryDeleteText(plan: LibraryDeletePlan, nameOf: (id: string) => string, opts: { rewritten: number; staleNote: string }): LibraryDeleteToast {
  const n = plan.ids.length
  const used = plan.usingAssets.length
  const scenes = plan.usedBy.length
  let text: string
  if (n === 1) text = `Đã xoá ${quoted(nameOf(plan.ids[0]))} khỏi thư viện${used ? ` và ${scenes} cảnh` : ''}`
  else text = `Đã xoá ${n} mục khỏi thư viện${used ? (used === n ? ` (đang dùng ở ${scenes} cảnh)` : ` (${used} mục đang dùng ở ${scenes} cảnh)`) : ''}`
  if (opts.staleNote) text += opts.staleNote
  else if (opts.rewritten) text += ` · đánh lại số @image trong ${opts.rewritten} prompt`
  text += '.'
  if (plan.hidden.length) text += ` Giữ ${plan.hidden.length} mục đang chọn nhưng bị ẩn bởi ô tìm / thẻ lọc.`
  const toast: LibraryDeleteToast = { text, tone: opts.staleNote ? 'warning' : 'info' }
  if (used || n > 1 || opts.staleNote) toast.ms = 8000
  return toast
}

/** Hint for a Delete in the library with nothing to delete. `hiddenOnly`: every selected card is filtered out. */
export function libraryNothingToDeleteHint(mac: boolean, hiddenOnly: boolean): string {
  if (hiddenOnly) return 'Các thẻ đã chọn đang bị ẩn bởi ô tìm / thẻ lọc — xoá ô tìm hoặc chọn “Tất cả” để thấy chúng.'
  return `Chưa chọn thẻ nào trong Thư viện — bấm vào thẻ (${textsFor(mac ? 'mac' : 'win').modShiftClick} để chọn nhiều) rồi bấm ${deleteKeyLabel(mac)}.`
}

/** Plain Backspace in the library on Windows (it never deletes: Vietnamese input tools send it). */
export const BACKSPACE_HINT = 'Bấm phím Delete (Del) để xoá — Backspace dành cho bộ gõ tiếng Việt.'

// ---------------- the library footer ----------------
export interface LibrarySelectionCounts {
  /** Selected items that exist. */
  selected: number
  /** ...of which visible (what Delete / the trash button take). */
  visible: number
  /** ...of which hidden by the search box / kind tab. */
  hidden: number
}

/** `selection` must hold existing ids only (the library filters it). */
export function librarySelectionCounts(selection: readonly string[], visible: ReadonlySet<string>): LibrarySelectionCounts {
  let shown = 0
  for (const id of selection) if (visible.has(id)) shown++
  return { selected: selection.length, visible: shown, hidden: selection.length - shown }
}

/** " (1 đang ẩn)" after "3 đã chọn", '' without hidden cards. */
export const hiddenSuffix = (c: LibrarySelectionCounts) => (c.hidden ? ` (${c.hidden} đang ẩn)` : '')

/** Title / aria-label of the footer's trash button and whether it can delete anything. */
export function deleteButtonState(c: LibrarySelectionCounts, mac: boolean): { label: string; enabled: boolean } {
  if (!c.visible) return { label: 'Các thẻ đã chọn đều đang bị ẩn bởi ô tìm / thẻ lọc', enabled: false }
  return { label: `Xoá ${c.visible} mục khỏi thư viện (${deleteKeyLabel(mac)}) — hoàn tác được`, enabled: true }
}

/** Footer line while nothing is selected. */
export function libraryFooterHint(mac: boolean): string {
  return `Kéo thả vào cảnh để nối · ${textsFor(mac ? 'mac' : 'win').modShiftClick}: chọn nhiều · C: nối · ${deleteKeyLabel(mac)}: xoá`
}
