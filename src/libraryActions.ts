// Library ("Thư viện") commands: fast delete, select all, and which area the delete keys act on. The pure rules live in
// core/libraryDelete (what a delete takes / asks / says) and core/libraryKeys (which key does what); the library
// (components/sidebar/AssetLibrary) registers what it shows with registerLibraryView. Tested in
// src/__tests__/libraryDelete.test.ts and src/__tests__/libraryShortcuts.test.ts.
//
// Where Delete acts — the area the user worked in last, never both:
// - `lastArea` follows every pointerdown (capture, on window): inside `.sb-library` = 'library', anywhere else = 'app'
//   (toasts and dialogs are neutral: a click on "Hoàn tác" does not move the area). A pointerdown outside also takes
//   the keyboard focus away from a library card that kept it, so a stale focus never carries Delete to the library.
// - a library card dropped outside the library (canvas, scene, inspector, text field) is 'app' too: HTML5 drag & drop
//   sends no pointerdown where it drops and leaves the focus on the dragged card (assetDragEnded → noteAssetDropOutside).
// - so is a keyboard command that acts on the canvas (N, Ctrl+D, Ctrl+A on the canvas, Alt+↑/↓ — hooks/useShortcuts →
//   noteCanvasCommand): the user just worked on the canvas, even though the focus may still sit on a library card.
// - isLibraryKeyTarget(target): focus inside `.sb-library`, or on the page itself (body) / a neutral area while
//   lastArea is 'library'. Such a Delete never falls through to the canvas, even with nothing selected in the library
//   or with the section collapsed (both show a hint instead).
//
// What a delete does: the selected cards on screen (search / kind tab applied; hidden ones stay selected), one
// removeAssets = one undo step with a "Hoàn tác" toast. Items no scene uses go at once; items scenes use ask one
// question first (core/libraryDelete libraryDeleteQuestion). Prompt drafts of those scenes are committed first
// (flushScenes). Media blobs are never deleted (duplicated projects share them, queued takes read imageKeysSnapshot,
// the undo history still needs them). Nothing gets selected afterwards; the keyboard focus moves to the next card.
import { announceWireCuts, edgeId } from './actions'
import { changedPrompts } from './components/sidebar/shared'
import { selectAllVisible } from './components/sidebar/librarySelection'
import {
  BACKSPACE_HINT,
  libraryCollapsedHint,
  libraryDeleteQuestion,
  libraryDeleteText,
  libraryNothingToDeleteHint,
  nextFocusAfterDelete,
  planLibraryDelete,
  type LibraryDeletePlan,
} from './core/libraryDelete'
import { LIBRARY_KEY_GRACE_MS, libraryKeyAction } from './core/libraryKeys'
import { scenesWithStaleTokens, staleTokenNote } from './core/staleTokens'
import type { Project } from './core/types'
import { IS_MAC } from './lib/platform'
import { flushScenes } from './lib/promptDrafts'
import { undoToastAction, useProject } from './store/project'
import { toast, useUI } from './store/ui'

/** What the library shows, registered by AssetLibrary while it is mounted. */
export interface LibraryView {
  /** Ids of the cards on screen (search box and kind tab applied), in list order. */
  visibleIds(): string[]
  /** The Thư viện section is collapsed: nothing to act on. */
  collapsed(): boolean
  /** Give the keyboard focus to a card (after a delete). */
  focusCard?(id: string): void
}

export type LibraryArea = 'library' | 'app' | null

/** Root element of the library section (components/sidebar/AssetLibrary → Section className). */
export const LIBRARY_ROOT = '.sb-library'
/** Areas whose clicks do not move the delete keys elsewhere: toasts, dialogs, the sheets above them. */
const NEUTRAL = '.toasts, .modal-backdrop, [data-top-overlay]'

let view: LibraryView | null = null
let lastArea: LibraryArea = null
/** The pointerdown listener installed on window by the first registerLibraryView (removed only by the test reset). */
let tracked: { win: Window; fn: (e: Event) => void } | null = null
let pending: ReturnType<typeof setTimeout> | null = null
let hintId: number | null = null

function closestIn(target: unknown, selector: string): boolean {
  const el = target as { closest?: (s: string) => unknown } | null | undefined
  if (!el || typeof el.closest !== 'function') return false
  try {
    return !!el.closest(selector)
  } catch {
    return false
  }
}

/** The page itself has the focus (nothing focusable was clicked): body, html, the document, no target. */
function isPageRoot(target: unknown): boolean {
  if (target == null) return true
  const t = target as { tagName?: unknown; nodeType?: unknown }
  return t.tagName === 'BODY' || t.tagName === 'HTML' || t.nodeType === 9
}

function blurLibraryFocus(): void {
  if (typeof document === 'undefined') return
  const el = document.activeElement as { blur?: () => void } | null
  if (el && closestIn(el, LIBRARY_ROOT) && typeof el.blur === 'function') el.blur()
}

/** The area the delete keys act on when the focus is on the page itself (tests, diagnostics). */
export function libraryArea(): LibraryArea {
  return lastArea
}

/** A pointerdown landed on `target` (installed on window by registerLibraryView; exported for tests). */
export function noteLibraryPointer(target: EventTarget | null): void {
  if (closestIn(target, LIBRARY_ROOT)) {
    lastArea = 'library'
    return
  }
  if (closestIn(target, NEUTRAL)) return
  lastArea = 'app'
  blurLibraryFocus()
}

function keysToCanvas(): void {
  lastArea = 'app'
  blurLibraryFocus()
}

/** Library cards were dropped outside the library: the next Delete acts where they went (the canvas), not here. */
export function noteAssetDropOutside(): void {
  keysToCanvas()
}

/**
 * A keyboard command acted on the canvas (new / duplicated / moved scene, every scene selected): the next Delete acts
 * on the canvas — the scene just made, not a library card that only kept the focus.
 */
export function noteCanvasCommand(): void {
  keysToCanvas()
}

/**
 * A library card drag ended (AssetLibrary onDragEnd). `dropEffect` 'none' = dropped nowhere, or back on the library
 * (its own drop zone takes files only); anything else = dropped outside the library.
 */
export function assetDragEnded(dropEffect: string): void {
  const ui = useUI.getState()
  ui.setDraggingAssets(null)
  if (dropEffect === 'none') return
  // The next Delete acts where the cards went, never on the library: an HTML5 drop sends no pointerdown there and
  // leaves the focus on the dragged card.
  noteAssetDropOutside()
  // A multi-card selection that was dropped somewhere has been used: forget it, so a later drag or "C" does not
  // silently carry the same cards again.
  if (ui.librarySelection.length > 1) ui.setLibrarySelection([])
}

/** Called by AssetLibrary while mounted. Returns the unregister function. */
export function registerLibraryView(v: LibraryView): () => void {
  view = v
  if (!tracked && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const fn = (e: Event) => noteLibraryPointer(e.target)
    window.addEventListener('pointerdown', fn, true)
    tracked = { win: window, fn }
  }
  return () => {
    if (view !== v) return
    view = null
    lastArea = null
    cancelLibraryKey()
  }
}

/** Does a key with this target act on the library (see the header)? */
export function isLibraryKeyTarget(target: EventTarget | null | undefined): boolean {
  if (!view) return false
  if (closestIn(target, LIBRARY_ROOT)) return true
  return lastArea === 'library' && (isPageRoot(target) || closestIn(target, NEUTRAL))
}

// ---------------- hints ----------------
function showHint(text: string): void {
  dismissHint()
  hintId = toast(text, { tone: 'info' })
}

function dismissHint(): void {
  if (hintId !== null) useUI.getState().dismissToast(hintId)
  hintId = null
}

/** Plain Backspace in the library on Windows: say which key deletes (one toast, replaced, never stacked). */
export function showBackspaceHint(): void {
  showHint(BACKSPACE_HINT)
}

// ---------------- commands ----------------
/** Ctrl+A / ⌘A in the library: select every card on screen (section collapsed: a hint, nothing selected). */
export function selectAllInLibrary(): boolean {
  if (!view) return false
  if (view.collapsed()) {
    showHint(libraryCollapsedHint('select-all'))
    return false
  }
  const ids = selectAllVisible(view.visibleIds())
  if (!ids.length) return false
  useUI.getState().setLibrarySelection(ids)
  return true
}

/**
 * Delete key / the footer's trash button: delete the selected cards on screen. With nothing on screen to delete (none
 * selected, all hidden, the section collapsed), a hint; the library not mounted: nothing at all. Returns whether
 * something was deleted.
 */
export function deleteLibrarySelection(): boolean {
  if (!view) return false
  if (view.collapsed()) {
    showHint(libraryCollapsedHint('delete'))
    return false
  }
  const visible = view.visibleIds()
  const plan = planLibraryDelete(useProject.getState().project, useUI.getState().librarySelection, visible)
  if (!plan.ids.length) {
    showHint(libraryNothingToDeleteHint(IS_MAC, plan.hidden.length > 0))
    return false
  }
  return applyDelete(plan, visible)
}

/**
 * Delete these library items (the asset dialog's "Xoá khỏi thư viện", menus). Items scenes use ask once; others go at
 * once. Returns whether they were deleted (false: cancelled, or none exists).
 */
export function deleteLibraryAssets(ids: readonly string[]): boolean {
  const plan = planLibraryDelete(useProject.getState().project, ids, null)
  if (!plan.ids.length) return false
  return applyDelete(plan, null)
}

const nameOf = (project: Project) => {
  const byId = new Map(project.assets.map((a) => [a.id, a]))
  return (id: string) => byId.get(id)?.name || byId.get(id)?.tag || 'mục'
}

function askDelete(question: string): boolean {
  // Cancel must leave everything untouched; without a way to ask, nothing is deleted.
  return typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm(question)
}

/** Canvas wires of the deleted items that are drawn (items placed on the canvas): ref / first / last. */
function cutWireIds(project: Project, plan: LibraryDeletePlan): string[] {
  if (!plan.onCanvas.length) return []
  const shown = new Set(plan.onCanvas)
  const used = new Set(plan.usedBy)
  const ids: string[] = []
  for (const s of project.scenes) {
    if (!used.has(s.id)) continue
    for (const r of s.refs) if (shown.has(r)) ids.push(edgeId('ref', r, s.id))
    if (s.firstFrame && shown.has(s.firstFrame)) ids.push(edgeId('first', s.firstFrame, s.id))
    if (s.lastFrame && shown.has(s.lastFrame)) ids.push(edgeId('last', s.lastFrame, s.id))
  }
  return ids
}

function later(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn())
  else setTimeout(fn, 0)
}

function applyDelete(plan: LibraryDeletePlan, visible: string[] | null): boolean {
  const names = nameOf(useProject.getState().project)
  const question = libraryDeleteQuestion(plan, names, IS_MAC)
  if (question && !askDelete(question)) return false
  // The prompts being typed in those scenes are committed first, and renumbered with the change.
  flushScenes(plan.usedBy)
  const before = useProject.getState().project
  // The canvas animates the wires that go (before they leave the store).
  if (useUI.getState().view === 'canvas') announceWireCuts(cutWireIds(before, plan))
  useProject.getState().removeAssets(plan.ids)
  const after = useProject.getState().project
  const action = undoToastAction()
  const used = new Set(plan.usedBy)
  const rewritten = changedPrompts(before.scenes, after.scenes).filter((id) => used.has(id)).length
  const stale = scenesWithStaleTokens(before, after)
  // Both selections forget the deleted ids (the canvas keeps unknown ids on its own); hidden selected cards stay.
  const dead = new Set(plan.ids)
  const ui = useUI.getState()
  if (ui.librarySelection.some((id) => dead.has(id))) ui.setLibrarySelection(ui.librarySelection.filter((id) => !dead.has(id)))
  if (ui.selectedIds.some((id) => dead.has(id))) ui.select(ui.selectedIds.filter((id) => !dead.has(id)))
  // Focus only (nothing selected): another Delete right away deletes nothing more, it shows the hint.
  const next = visible ? nextFocusAfterDelete(visible, plan.ids) : null
  const focus = view?.focusCard
  if (next && focus) later(() => focus(next))
  const said = libraryDeleteText(plan, names, { rewritten, staleNote: stale.length ? staleTokenNote(after, stale) : '' })
  dismissHint()
  toast(said.text, { tone: said.tone, action, ...(said.ms ? { ms: said.ms } : {}) })
  return true
}

// ---------------- keys (hooks/useShortcuts) ----------------
/** The part of a keydown read here. */
export interface LibraryKeyEvent {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
  target: EventTarget | null
  preventDefault(): void
}

/** Any key cancels a waiting ⌫ / Backspace (an input tool rewriting a letter sends ⌫ + the letter). */
export function cancelLibraryKey(): void {
  if (pending) clearTimeout(pending)
  pending = null
}

function defer(fn: () => void): void {
  cancelLibraryKey()
  // Decided now: where the key acts is fixed at keydown, not when the grace period ends.
  pending = setTimeout(() => {
    pending = null
    fn()
  }, LIBRARY_KEY_GRACE_MS)
}

/**
 * The library's turn in the global shortcut handler (after its typing / dialog guards). Returns true when the key was
 * the library's — the caller must then stop: it never reaches the canvas rules. `chords`: the custom keymap's verdicts
 * for "Xoá lựa chọn" / "Chọn tất cả" (K2), when it drives the handler.
 */
export function handleLibraryKey(e: LibraryKeyEvent, mac: boolean = IS_MAC, chords: { isDeleteChord?: boolean; isSelectAllChord?: boolean } = {}): boolean {
  if (!isLibraryKeyTarget(e.target)) return false
  const action = libraryKeyAction({
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    repeat: e.repeat,
    isComposing: e.isComposing,
    keyCode: e.keyCode,
    mac,
    ...chords,
  })
  if (!action) return false
  e.preventDefault()
  // A card being dragged (keys rarely arrive then): never delete what is in the air.
  if (useUI.getState().draggingAssetIds) return true
  if (action === 'delete-now') deleteLibrarySelection()
  else if (action === 'delete-deferred') defer(deleteLibrarySelection)
  else if (action === 'backspace-hint') defer(showBackspaceHint)
  else if (action === 'select-all') selectAllInLibrary()
  return true
}

/** Forget the registered view, the area, any waiting key and the pointerdown listener (tests). */
export function resetLibraryActionsForTests(): void {
  view = null
  lastArea = null
  cancelLibraryKey()
  hintId = null
  if (tracked) {
    try {
      tracked.win.removeEventListener('pointerdown', tracked.fn, true)
    } catch {
      // a test window stub without removeEventListener: forgetting it is enough
    }
    tracked = null
  }
}
