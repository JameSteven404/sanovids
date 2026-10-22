// Focus handling for dialogs and full-screen overlays (Modal, ImageLightbox, FilmPlayer).
// While an overlay is open the keyboard must act on it, never on the page behind it: otherwise arrow keys still
// move a focused (selected) canvas node, and typing still edits a focused prompt behind the dialog.
import { useLayoutEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Marks an overlay drawn ABOVE the dialogs (development mode's simulated login / SePay sheets, components/dev): the
 * dialogs and full-screen overlays below leave keys pressed inside it alone (Escape there closes the sheet, not the
 * dialog under it).
 */
export const TOP_OVERLAY_ATTR = 'data-top-overlay'

/** The event target is inside a top overlay (see TOP_OVERLAY_ATTR). */
export function inTopOverlay(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && !!target.closest(`[${TOP_OVERLAY_ATTR}]`)
}

/** A top overlay is on screen: the keys belong to it wherever focus is (even on <body>). */
export function topOverlayOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector(`[${TOP_OVERLAY_ATTR}]`)
}

/** Keys the dialogs / overlays below must leave alone: pressed inside a top overlay, or while one is open. */
export function keyForTopOverlay(e: Pick<Event, 'target'>): boolean {
  return inTopOverlay(e.target) || topOverlayOpen()
}

/** Input types that do not take typed text (Escape in them may close a dialog right away). */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'])

/**
 * True when `el` is a field the user types into (text-like input, textarea, contenteditable). Escape there must
 * leave the field first instead of closing the dialog and losing what was typed. Reads only tagName / type /
 * isContentEditable, so it is testable without a DOM.
 */
export function isTextEntry(el: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el || !el.tagName) return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((el.type || 'text').toLowerCase())
  return !!el.isContentEditable
}

/** Visible, enabled elements of `root` that Tab can reach, in DOM order. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0)
}

/**
 * Move focus into the overlay when it opens and give it back when it closes.
 * - On mount: unless a child already took focus (React `autoFocus` runs first), focus `ref` itself
 *   (give it `tabIndex={-1}`), so keys no longer reach the element that had focus behind the overlay.
 * - On unmount: focus the element that had it before, if it is still in the page.
 */
export function useOverlayFocus(ref: RefObject<HTMLElement | null>) {
  // Read during the first render, i.e. before a child's autoFocus moves focus into the overlay.
  const [before] = useState(() => (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null))
  // Layout effect: runs before the browser paints, so a key pressed right after opening already lands in the overlay.
  useLayoutEffect(() => {
    const el = ref.current
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
    return () => {
      if (!before || before === document.body || !before.isConnected) return
      // Another overlay may have taken focus meanwhile (one dialog replaced by the next): leave it there.
      const active = document.activeElement
      if (active && active !== document.body && active !== el && !el?.contains(active) && active.isConnected) return
      before.focus({ preventScroll: true })
    }
    // Mount / unmount only (the overlay element never changes). React applies `autoFocus` during commit, before
    // this runs; a disabled autoFocus button (e.g. nothing to run) is skipped — then the overlay takes focus here.
  }, [ref, before])
}

/** Keep Tab / Shift+Tab cycling inside `root` instead of walking out into the page behind it. */
export function trapTabWithin(root: HTMLElement, e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'defaultPrevented' | 'preventDefault'>) {
  if (e.key !== 'Tab' || e.defaultPrevented) return
  const items = focusableIn(root)
  if (!items.length) {
    e.preventDefault()
    root.focus({ preventScroll: true })
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}

/** onKeyDown for an overlay root (see `trapTabWithin`). */
export function trapTab(e: ReactKeyboardEvent<HTMLElement>) {
  trapTabWithin(e.currentTarget, e)
}
