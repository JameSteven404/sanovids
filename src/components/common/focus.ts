// Focus handling for dialogs and full-screen overlays (Modal, ImageLightbox, StoryboardPlayer).
// While an overlay is open the keyboard must act on it, never on the page behind it: otherwise arrow keys still
// move a focused (selected) canvas node, and typing still edits a focused prompt behind the dialog.
import { useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

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
  // Layout effect: runs before passive effects of the page (and before the browser paints), so a key pressed
  // right after opening already lands in the overlay.
  useLayoutEffect(() => {
    const el = ref.current
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
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
  }, [ref])
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
