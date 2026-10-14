// Right-click (or Menu key / Shift+F10) on a library card: the selection rule at once, then the menu built by
// libraryMenu.ts — its own chunk with the canvas menu builders, loaded on the first menu (App prefetches it when idle).
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useUI } from '../../store/ui'
import { openContextMenu, type MenuOrigin } from './contextMenuStore'
import type { LibraryCardCommands } from './libraryMenu'

let builder: Promise<typeof import('./libraryMenu')> | null = null
/** A failed load is tried again on the next menu. */
function loadLibraryMenu(): Promise<typeof import('./libraryMenu')> {
  return (builder ??= import('./libraryMenu').catch((e: unknown) => {
    builder = null
    throw e
  }))
}

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
  // Read from the event now: the menu opens once the builder is loaded.
  const card = (e.target as Element | null)?.closest?.('.sb-card') ?? null
  const box = card?.getBoundingClientRect()
  const at = 'clientX' in e && origin !== 'keyboard' ? { x: e.clientX, y: e.clientY } : undefined
  void loadLibraryMenu().then(({ libraryMenu }) => {
    const spec = libraryMenu(ids, commands)
    if (!spec) return
    openContextMenu({
      spec,
      at,
      anchor: !at && box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : undefined,
      origin,
      target: card,
      fallbackFocus: libraryGrid,
    })
  }, () => undefined)
}
