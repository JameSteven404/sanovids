// Right-click menu of a library card ("Thư viện"): quick unlink / link against the scenes selected on the canvas, put
// on / hide from the canvas, edit, delete (the same flow as the Delete key: libraryActions.deleteLibraryAssets asks in
// the app when the items are used). Built from the stores once, when the menu opens.
import type { MouseEvent as ReactMouseEvent } from 'react'
import { linkAssets } from '../../actions'
import type { Asset } from '../../core/types'
import { deleteLibraryAssets } from '../../libraryActions'
import { linkedPairs, scenesUsingAsset, unlinkAssetsFromScenes } from '../../menuActions'
import { oneUndoStep, undoToastAction, useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { nextAssetPosition } from '../sidebar/shared'
import { selectionLinkRows } from './canvasMenu'
import { openContextMenu, type MenuOrigin } from './contextMenuStore'
import { SEP, tidyEntries, type MenuEntry, type MenuSpec } from './menuModel'

/** What the card offers that lives in the library component (passed in, so its toasts stay the same). */
export interface LibraryCardCommands {
  /** "Đặt lên canvas" / "Ẩn khỏi canvas" of one card. */
  toggleOnCanvas: (id: string) => void
}

const KIND: Record<Asset['kind'], string> = { character: 'nhân vật', location: 'bối cảnh', prop: 'đạo cụ', style: 'phong cách' }

/** Put several library items on the canvas (those not there yet), one undo step. */
function placeOnCanvas(ids: readonly string[]) {
  const before = useProject.getState().project
  const fresh = ids.filter((id) => before.assets.some((a) => a.id === id && !a.position))
  if (!fresh.length) return
  oneUndoStep(() => {
    for (const id of fresh) {
      const p = useProject.getState().project
      const asset = p.assets.find((a) => a.id === id)
      if (asset) useProject.getState().setAssetOnCanvas(id, nextAssetPosition(p, asset))
    }
  })
  toast(`Đã đặt ${fresh.length} mục lên canvas.`, { tone: 'success', action: undoToastAction() })
}

/** Entries for the library cards `ids` (one card or the library multi-selection). Exported for tests. */
export function libraryMenu(ids: readonly string[], commands: LibraryCardCommands): MenuSpec | null {
  const project = useProject.getState().project
  const ui = useUI.getState()
  const assets = ids.map((id) => project.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a)
  if (!assets.length) return null
  const S = ui.selectedIds.filter((id) => project.scenes.some((s) => s.id === id))
  // C links the library selection only while the canvas selection holds no image / video (actions.pickAssetSelection).
  const cLinksThis = !ui.selectedIds.some((id) => project.assets.some((a) => a.id === id)) && !ui.selectedIds.some((id) => !project.scenes.some((s) => s.id === id))
  if (assets.length === 1) {
    const asset = assets[0]
    const name = asset.name || 'ảnh'
    const rows = selectionLinkRows({ project, selected: ui.selectedIds }, asset, 'lib')
    const link = rows.find((r) => r.id === 'lib.linkSelected')
    if (link && cLinksThis) link.action = 'selection.connect'
    // Quick unlink from every scene using it (as on the scene card's thumbnail), when that is more than the selected ones.
    const users = scenesUsingAsset(asset.id, project)
    if (users.length >= 2 && users.length !== S.filter((id) => users.includes(id)).length) {
      rows.push({ type: 'item', id: 'lib.unlinkAll', label: `Bỏ nối ${name} khỏi mọi cảnh (${users.length})`, icon: 'unlink', run: () => void unlinkAssetsFromScenes([asset.id], users) })
    }
    const entries: MenuEntry[] = [
      ...rows,
      {
        type: 'item',
        id: 'lib.canvas',
        label: asset.position ? 'Ẩn khỏi canvas' : 'Đặt lên canvas',
        icon: asset.position ? 'eyeOff' : 'eye',
        run: () => commands.toggleOnCanvas(asset.id),
      },
      { type: 'item', id: 'lib.edit', label: `Sửa ${name}…`, icon: 'edit', run: () => useUI.getState().openDialog({ kind: 'asset', assetId: asset.id }) },
      SEP,
      { type: 'item', id: 'lib.delete', label: 'Xoá khỏi thư viện', danger: true, run: () => void deleteLibraryAssets([asset.id]) },
    ]
    return {
      label: `Menu thẻ thư viện ${name}`,
      title: S.length ? undefined : `${name} · ${KIND[asset.kind] ?? 'ảnh'}`,
      entries: tidyEntries(entries),
    }
  }
  const n = assets.length
  const all = assets.map((a) => a.id)
  const entries: MenuEntry[] = []
  if (S.length) {
    entries.push({ type: 'item', id: 'lib.linkSelected', label: `Nối ${n} mục vào ${S.length} cảnh đang chọn`, icon: 'link', action: cLinksThis ? 'selection.connect' : undefined, run: () => linkAssets(S, all) })
    const pairs = linkedPairs(all, S, project)
    if (pairs.refs.length + pairs.frames.length) {
      entries.push({ type: 'item', id: 'lib.unlinkSelected', label: `Bỏ nối ${n} mục khỏi ${pairs.sceneIds.length} cảnh đang chọn`, icon: 'unlink', run: () => void unlinkAssetsFromScenes(all, S) })
    }
  }
  const off = assets.filter((a) => !a.position).length
  if (off) entries.push({ type: 'item', id: 'lib.place', label: `Đặt ${off} mục lên canvas`, icon: 'eye', run: () => placeOnCanvas(all) })
  entries.push(SEP, { type: 'item', id: 'lib.delete', label: `Xoá ${n} mục khỏi thư viện`, danger: true, run: () => void deleteLibraryAssets(all) })
  return { label: `Menu ${n} mục thư viện đang chọn`, title: `${n} mục đang chọn`, entries: tidyEntries(entries) }
}

/** Keyboard focus after the menu closed and the card is gone (deleted): the library grid. */
const libraryGrid = () => (typeof document !== 'undefined' ? document.querySelector<HTMLElement>('.sb-library [data-asset-id], .sb-library') : null)

/**
 * Right-click (or Menu key / Shift+F10) on a library card. A card outside the library selection becomes the only
 * selected card (the canvas selection is kept: the quick unlink acts on its scenes); one inside acts on the whole
 * library selection. Text being selected keeps the native menu.
 */
export function openLibraryCardMenu(e: ReactMouseEvent | KeyboardEvent, id: string, commands: LibraryCardCommands, origin: MenuOrigin = 'mouse'): void {
  if (e.defaultPrevented) return
  e.preventDefault()
  const ui = useUI.getState()
  if (ui.dialog.kind !== 'none') return
  const inSel = ui.librarySelection.includes(id)
  if (!inSel) ui.setLibrarySelection([id])
  const ids = inSel ? ui.librarySelection : [id]
  const spec = libraryMenu(ids, commands)
  if (!spec) return
  const card = (e.target as Element | null)?.closest?.('.sb-card') ?? null
  const box = card?.getBoundingClientRect()
  const mouse = 'clientX' in e && origin !== 'keyboard'
  openContextMenu({
    spec,
    at: mouse ? { x: e.clientX, y: e.clientY } : undefined,
    anchor: !mouse && box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : undefined,
    origin,
    target: card,
    fallbackFocus: libraryGrid,
  })
}
