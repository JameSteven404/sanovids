// Right-click menus: the pure part (no React, no DOM, no stores) — entry types, roving focus, type-ahead, placement,
// what a key does while a menu is open, the selection rule of a right-click and the Mac secondary click.
// Unit-tested in __tests__/menuModel.test.ts. Rendering: ContextMenuHost.tsx; builders: canvasMenu.ts / libraryMenu.ts.

/** Icon keys (ContextMenuHost maps them to lucide icons; keeps this file free of React). */
export type MenuIcon =
  | 'play'
  | 'edit'
  | 'plus'
  | 'copy'
  | 'film'
  | 'unlink'
  | 'link'
  | 'trash'
  | 'eye'
  | 'eyeOff'
  | 'star'
  | 'download'
  | 'folder'
  | 'folderPlus'
  | 'folderOpen'
  | 'folderSearch'
  | 'key'
  | 'rerun'
  | 'x'
  | 'image'
  | 'fit'
  | 'goto'
  | 'scene'

export interface MenuItem {
  type: 'item'
  /** Stable id: 'scene.run', 'asset.unlinkSelected'… (tests and the activation switch read it). */
  id: string
  label: string
  icon?: MenuIcon
  /** Keymap action whose user binding is drawn on the right (read-only from the keymap; nothing drawn when unbound). */
  action?: string
  /** A fixed key drawn with <Keys> (canonical chord, e.g. 'Enter'): for keys that are not keymap actions. */
  fixedKey?: string
  /** Small second line. */
  hint?: string
  /** Non-empty = disabled; the text is the reason shown under the label (the item stays focusable to read it). */
  disabled?: string
  /** Deletes something: last, after a separator, trash icon, danger color, never focused first. */
  danger?: boolean
  /** Check item (menuitemcheckbox): its label never changes, `checked` is the state. */
  checked?: boolean
  submenu?: MenuEntry[]
  /** Wire highlighted on the canvas while this row is hovered / focused. */
  edgeId?: string
  /** What the item does (called after the menu closed and focus went back). */
  run?: () => void
}
export interface MenuSeparator {
  type: 'separator'
}
export interface MenuLabel {
  type: 'label'
  text: string
}
export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

/** One menu as opened: its accessible name, an optional one-line title and the entries. */
export interface MenuSpec {
  /** aria-label of the menu: "Menu cảnh S03". */
  label: string
  /** One line above the items, only when the first item does not already name the object. */
  title?: string
  entries: MenuEntry[]
}

/** Root menus never hold more than this many items (labels / separators not counted). */
export const MAX_ROOT_ITEMS = 7
/** Long submenus show this many rows, then a "+k … khác" label. */
export const MAX_SUBMENU_ROWS = 10
/** Type-ahead: letters typed within this time build one prefix. */
export const TYPEAHEAD_MS = 700
/** Submenus open / switch after the pointer rests this long on a row. */
export const HOVER_INTENT_MS = 150

export const SEP: MenuSeparator = { type: 'separator' }

export const isItem = (e: MenuEntry | undefined): e is MenuItem => !!e && e.type === 'item'

/** Separators only between items: none first, last or doubled; labels kept. */
export function tidyEntries(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const e of entries) {
    if (e.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue
    out.push(e)
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop()
  return out
}

/** Number of items (not separators / labels). */
export function itemCount(entries: readonly MenuEntry[]): number {
  return entries.filter(isItem).length
}

/** Index of the item focused when the menu opens: the first item that is not dangerous (a danger one only when alone). */
export function firstIndex(entries: readonly MenuEntry[]): number {
  const safe = entries.findIndex((e) => isItem(e) && !e.danger)
  if (safe >= 0) return safe
  return entries.findIndex(isItem)
}

/** First / last item (Home / End). */
export function edgeIndex(entries: readonly MenuEntry[], which: 'first' | 'last'): number {
  if (which === 'first') return entries.findIndex(isItem)
  for (let i = entries.length - 1; i >= 0; i--) if (isItem(entries[i])) return i
  return -1
}

/** Next / previous item from `from`, wrapping around; separators and labels are skipped, disabled items are not. */
export function nextIndex(entries: readonly MenuEntry[], from: number, dir: 1 | -1): number {
  const n = entries.length
  if (!n) return -1
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n
    if (isItem(entries[i])) return i
  }
  return -1
}

/** Lower-case, accents removed (đ → d): type-ahead works without Vietnamese marks. */
export function foldLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
}

/**
 * Type-ahead: the next item (after `from`, wrapping) whose label starts with `typed` (accents ignored). A prefix of one
 * repeated letter cycles through the items starting with that letter. -1 = no match.
 */
export function typeAhead(entries: readonly MenuEntry[], from: number, typed: string): number {
  const q = foldLabel(typed)
  if (!q) return -1
  const same = q.length > 1 && [...q].every((c) => c === q[0])
  const prefix = same ? q[0] : q
  const n = entries.length
  // A longer prefix may still match the current item (typing "xo" while on "Xoá"): start there; one letter moves on.
  const start = prefix.length > 1 ? 0 : 1
  for (let step = start; step <= n; step++) {
    const i = (((from + step) % n) + n) % n
    const e = entries[i]
    if (isItem(e) && foldLabel(e.label).startsWith(prefix)) return i
  }
  return -1
}

export interface Size {
  w: number
  h: number
}
export interface Placement {
  left: number
  top: number
  /** Set when the menu is taller than the room: it scrolls inside. */
  maxHeight?: number
}
/** Gap kept to the window edges. */
export const EDGE_GAP = 8
/** The menu's corner sits this far from the pointer. */
export const POINTER_GAP = 2

/**
 * Where a menu opened at a point goes: its top-left corner just right / below the pointer; flipped left / up when it
 * would cross the window edge, clamped EDGE_GAP inside; `headerH` (a title row) moves it up so the first item lands
 * under the pointer. Too tall for the window: top at the gap, maxHeight set (it scrolls).
 */
export function placeMenu(at: { x: number; y: number }, size: Size, viewport: Size, headerH = 0): Placement {
  let left = at.x + POINTER_GAP
  if (left + size.w > viewport.w - EDGE_GAP) left = at.x - POINTER_GAP - size.w
  left = Math.max(EDGE_GAP, Math.min(left, viewport.w - EDGE_GAP - size.w))
  const room = viewport.h - 2 * EDGE_GAP
  if (size.h > room) return { left, top: EDGE_GAP, maxHeight: room }
  let top = at.y + POINTER_GAP - headerH
  if (top + size.h > viewport.h - EDGE_GAP) top = at.y - POINTER_GAP - size.h
  top = Math.max(EDGE_GAP, Math.min(top, viewport.h - EDGE_GAP - size.h))
  return { left, top }
}

/** Where a menu opened from the keyboard goes: below-left of the element's box (above when there is no room). */
export function placeAtAnchor(anchor: { left: number; top: number; right: number; bottom: number }, size: Size, viewport: Size): Placement {
  const below = anchor.bottom + POINTER_GAP
  const y = below + size.h > viewport.h - EDGE_GAP ? Math.max(EDGE_GAP, anchor.top - POINTER_GAP - size.h) : below
  return placeMenu({ x: anchor.left - POINTER_GAP, y: y - POINTER_GAP }, size, viewport)
}

/** A submenu: right of its row (flipped left at the window edge), top aligned with the row, clamped like a menu. */
export function placeSubmenu(row: { left: number; top: number; right: number; bottom: number }, size: Size, viewport: Size): Placement {
  let left = row.right - 2
  if (left + size.w > viewport.w - EDGE_GAP) left = row.left - size.w + 2
  left = Math.max(EDGE_GAP, Math.min(left, viewport.w - EDGE_GAP - size.w))
  const room = viewport.h - 2 * EDGE_GAP
  if (size.h > room) return { left, top: EDGE_GAP, maxHeight: room }
  const top = Math.max(EDGE_GAP, Math.min(row.top - 6, viewport.h - EDGE_GAP - size.h))
  return { left, top }
}

/** The key parts of a keydown the menu looks at (a KeyboardEvent or a plain object in tests). */
export interface MenuKey {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
  keyCode?: number
}

export type MenuKeyAction =
  | 'next'
  | 'prev'
  | 'first'
  | 'last'
  | 'activate'
  | 'openSub'
  | 'closeSub'
  | 'close'
  | 'tab'
  | 'type'
  /** A chord that runs even while typing (Ctrl+S): close the menu and let the key go on. */
  | 'passClose'
  /** Anything else: swallowed, so Delete / N / C / F / Ctrl+D… never act behind the menu. */
  | 'swallow'
  /** IME composition / Unikey's Backspace: ignore (neither swallow-with-effect nor close). */
  | 'ignore'

/**
 * What a key does while a menu is open. `typingChord`: the key is a "runs even while typing" chord of the keymap
 * (injected so this stays pure). `inSubmenu` / `onParent`: focus is in a submenu / on a row that opens one.
 */
export function menuKeyAction(e: MenuKey, ctx: { typingChord?: boolean; inSubmenu?: boolean; onParent?: boolean } = {}): MenuKeyAction {
  if (e.isComposing || e.keyCode === 229) return 'ignore'
  const mod = !!(e.ctrlKey || e.metaKey || e.altKey)
  switch (e.key) {
    case 'ArrowDown':
      return 'next'
    case 'ArrowUp':
      return 'prev'
    case 'Home':
    case 'PageUp':
      return 'first'
    case 'End':
    case 'PageDown':
      return 'last'
    case 'Enter':
      if (mod) break
      return ctx.onParent ? 'openSub' : 'activate'
    case ' ':
      if (mod) break
      return ctx.onParent ? 'openSub' : 'activate'
    case 'ArrowRight':
      return ctx.onParent ? 'openSub' : 'swallow'
    case 'ArrowLeft':
      return ctx.inSubmenu ? 'closeSub' : 'swallow'
    case 'Escape':
      return ctx.inSubmenu ? 'closeSub' : 'close'
    case 'Tab':
      return 'tab'
    case 'Backspace':
      // Unikey / EVKey rewrite a letter with Backspace + the accented letter: never an action here.
      return mod ? 'swallow' : 'ignore'
  }
  if (ctx.typingChord) return 'passClose'
  if (!mod && e.key.length === 1 && e.key !== ' ') return 'type'
  return 'swallow'
}

/** The keyboard way to open a context menu: the Menu key, or Shift+F10 without Ctrl / Alt / Meta. */
export function isMenuKey(e: MenuKey): boolean {
  if (e.key === 'ContextMenu') return true
  return e.key === 'F10' && !!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
}

/**
 * ⌃+click on macOS is a secondary click (the system then sends `contextmenu`): it arrives as button 0 with ctrlKey,
 * which React Flow would take as the start of a selection box / a node drag. Never on Windows / Linux, where Ctrl+click
 * adds to the selection.
 */
export function isMacSecondaryPress(e: { button: number; ctrlKey: boolean; metaKey?: boolean }, mac: boolean): boolean {
  return mac && e.button === 0 && e.ctrlKey && !e.metaKey
}

export type ContextKind = 'scene' | 'take' | 'asset' | 'folder' | 'ref' | 'edge' | 'pane'

/**
 * Selection rule of a right-click (plan 3.5): returns the canvas selection afterwards and whether the menu is the
 * "several items" one.
 * - a scene / video outside the selection becomes the only selected card; one inside a selection of ≥ 2 keeps it
 *   (multi menu); the only selected card keeps it;
 * - an image card outside the selection keeps the selection (quick unlink acts on the selected scenes); inside ≥ 2 → multi;
 * - a folder keeps the selection (its menu saves the selected videos / scenes into it); inside ≥ 2 → multi;
 * - a thumbnail on a scene card keeps it;
 * - every card target drops the selected wires (a later "Xoá" then only touches cards); a wire / the empty canvas keep
 *   both. Ctrl / Shift are ignored.
 */
export function contextSelection(input: {
  kind: ContextKind
  id?: string
  selectedIds: readonly string[]
  selectedEdgeIds: readonly string[]
}): { selectedIds: readonly string[]; selectedEdgeIds: readonly string[]; multi: boolean } {
  const { kind, id, selectedIds, selectedEdgeIds } = input
  if (kind === 'edge' || kind === 'pane') return { selectedIds, selectedEdgeIds, multi: false }
  const noEdges: readonly string[] = selectedEdgeIds.length ? [] : selectedEdgeIds
  if (kind === 'ref' || !id) return { selectedIds, selectedEdgeIds: noEdges, multi: false }
  const inside = selectedIds.includes(id)
  if (inside && selectedIds.length >= 2) return { selectedIds, selectedEdgeIds: noEdges, multi: true }
  if (inside) return { selectedIds, selectedEdgeIds: noEdges, multi: false }
  if (kind === 'scene' || kind === 'take') return { selectedIds: [id], selectedEdgeIds: noEdges, multi: false }
  return { selectedIds, selectedEdgeIds: noEdges, multi: false }
}

/** "3 cảnh, 2 ảnh, 1 video" — only the non-zero parts. */
export function countsText(parts: readonly [number, string][]): string {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`)
    .join(', ')
}

/** Long submenu lists: the first MAX_SUBMENU_ROWS rows, then a "+k {what} khác" label. */
export function capRows(rows: MenuEntry[], what: string, max = MAX_SUBMENU_ROWS): MenuEntry[] {
  if (rows.length <= max) return rows
  return [...rows.slice(0, max), { type: 'label', text: `+${rows.length - max} ${what} khác` }]
}
