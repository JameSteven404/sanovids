import { X } from 'lucide-react'
import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { isTextEntry, keyForTopOverlay, trapTab, trapTabWithin, useOverlayFocus } from './focus'
import './common.css'

interface ModalProps {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'normal' | 'wide' | 'xwide'
  /** Extra element in the header, left of the close button. */
  headerExtra?: ReactNode
  /**
   * 'top': drawn above every dialog (a question asked while one is open: store/confirm → ConfirmSheet). It is a top
   * overlay (TOP_OVERLAY_ATTR): the dialog under it leaves every key alone, and no key — wherever focus is — reaches
   * that dialog or the global shortcuts; Escape closes only this one.
   */
  layer?: 'dialog' | 'top'
}

/**
 * Shared dialog shell (Apple-style sheet). Closes on Escape and on backdrop click.
 * Takes the keyboard focus while open (Tab stays inside) and gives it back on close, so keys never reach the page
 * behind it (arrow keys moving a selected canvas node, typing into a focused prompt).
 *
 * Escape while typing in a field of the dialog never closes it: the field gets the key first (a rename input
 * cancels, a menu closes); if the field does not use it, Escape only leaves the field (focus moves to the dialog
 * itself). The next Escape closes the dialog.
 */
export function Modal({ title, onClose, children, footer, size = 'normal', headerExtra, layer = 'dialog' }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const top = layer === 'top'
  useOverlayFocus(ref)
  // A passive effect on purpose: a dialog's own window listeners registered in a layout effect (ImportDialog's
  // field Escape) are added first, so they run before this one and can stop it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current
      const target = e.target
      const inside = !!root && target instanceof Node && root.contains(target)
      if (top) {
        // Above every dialog: keys pressed outside it (focus on <body>…) stop here — nothing reaches the dialog under
        // it or the global shortcuts; keys inside reach its own handlers (onKeyDown stops them there).
        if (!inside) e.stopPropagation()
        if (e.key === 'Escape' && !(inside && isTextEntry(target as HTMLElement))) {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        } else if (!inside && e.key === 'Tab' && root) trapTabWithin(root, e)
        return
      }
      if (e.key !== 'Escape') return
      // A sheet above the dialogs (development mode's login / SePay, a 'top' Modal) handles its own Escape — wherever
      // focus is.
      if (keyForTopOverlay(e)) return
      // Typing in one of our fields: let the key reach the field; onKeyDown below handles what it leaves over.
      if (inside && isTextEntry(target as HTMLElement)) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, top])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Above every dialog: nothing typed here reaches the dialog under it or the global shortcuts.
    if (top) e.stopPropagation()
    if (e.key === 'Escape' && isTextEntry(e.target as HTMLElement)) {
      // Never reaches the global shortcuts (they would close the dialog).
      e.stopPropagation()
      // The field used the key (closed its own menu) or an input method is composing: nothing more to do.
      if (e.defaultPrevented || e.nativeEvent.isComposing) return
      // A search box with text: the browser clears it (its default action); the next Escape leaves it.
      const t = e.target
      if (t instanceof HTMLInputElement && t.type === 'search' && t.value) return
      e.preventDefault()
      ref.current?.focus({ preventScroll: true })
      return
    }
    trapTab(e)
  }

  return (
    // data-top-overlay = focus.TOP_OVERLAY_ATTR (absent on ordinary dialogs)
    <div className={`modal-backdrop${top ? ' is-top' : ''}`} data-top-overlay={top ? '' : undefined} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`modal ${size === 'normal' ? '' : size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          {headerExtra}
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Đóng" title="Đóng (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
