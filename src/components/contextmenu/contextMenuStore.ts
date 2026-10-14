// The one open right-click menu (module-level store, separate from useUI so only ContextMenuHost re-renders when a
// menu opens or closes). Canvas and library both open their menus through openContextMenu.
import { create } from 'zustand'
import type { MenuItem, MenuSpec } from './menuModel'

export type MenuOrigin = 'mouse' | 'touch' | 'pen' | 'keyboard'

export interface OpenMenu {
  spec: MenuSpec
  /** Pointer position (px, viewport) for a right-click. */
  at?: { x: number; y: number }
  /** Box of the element the menu belongs to (keyboard opening): the menu goes below-left of it. */
  anchor?: { left: number; top: number; right: number; bottom: number }
  origin: MenuOrigin
  /** Element marked data-menu-target while the menu is open (outlined node / card). */
  target?: Element | null
  /** Focus goes back here when the menu closes (falls back to `fallbackFocus` when it left the page). */
  returnFocus: HTMLElement | null
  fallbackFocus?: () => HTMLElement | null
  /** A row was hovered / focused (null: none / closed): the canvas highlights that row's wire. */
  onHighlight?: (item: MenuItem | null) => void
  /** Opened at (performance.now()): a touch's own click right after a long press must not pick an item. */
  openedAt: number
  /** Increases with every opening: the host remounts the surface (focus, placement) for a new menu. */
  seq: number
}

interface ContextMenuState {
  open: OpenMenu | null
}

export const useContextMenu = create<ContextMenuState>()(() => ({ open: null }))

let seq = 0

/** Open a menu (replacing one already open). */
export function openContextMenu(menu: Omit<OpenMenu, 'seq' | 'openedAt' | 'returnFocus'> & { returnFocus?: HTMLElement | null }): void {
  const prev = useContextMenu.getState().open
  if (prev) finish(prev)
  const active = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null
  const returnFocus = menu.returnFocus !== undefined ? menu.returnFocus : active && active !== document.body ? active : null
  menu.target?.setAttribute?.('data-menu-target', '')
  useContextMenu.setState({
    open: { ...menu, returnFocus, openedAt: typeof performance !== 'undefined' ? performance.now() : Date.now(), seq: ++seq },
  })
}

/** Drop the target outline and the wire highlight of a menu that goes away. */
function finish(menu: OpenMenu) {
  menu.target?.removeAttribute?.('data-menu-target')
  menu.onHighlight?.(null)
}

/** Close the open menu (if any). `restoreFocus`: put focus back where it was (Esc, Tab, a chosen item). */
export function closeContextMenu(restoreFocus = false): void {
  const menu = useContextMenu.getState().open
  if (!menu) return
  finish(menu)
  useContextMenu.setState({ open: null })
  if (!restoreFocus || typeof document === 'undefined') return
  const back = menu.returnFocus && menu.returnFocus.isConnected ? menu.returnFocus : (menu.fallbackFocus?.() ?? null)
  back?.focus({ preventScroll: true })
}

/** A context menu is open right now. */
export function contextMenuOpen(): boolean {
  return !!useContextMenu.getState().open
}
