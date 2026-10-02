import { X } from 'lucide-react'
import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { isTextEntry, keyForTopOverlay, trapTab, useOverlayFocus } from './focus'
import './common.css'

interface ModalProps {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'normal' | 'wide' | 'xwide'
  /** Extra element in the header, left of the close button. */
  headerExtra?: ReactNode
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
export function Modal({ title, onClose, children, footer, size = 'normal', headerExtra }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useOverlayFocus(ref)
  // A passive effect on purpose: a dialog's own window listeners registered in a layout effect (ImportDialog's
  // field Escape) are added first, so they run before this one and can stop it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // A sheet above the dialogs (development mode's login / SePay) handles its own Escape — wherever focus is.
      if (keyForTopOverlay(e)) return
      const root = ref.current
      const target = e.target
      // Typing in one of our fields: let the key reach the field; onKeyDown below handles what it leaves over.
      if (root && target instanceof Element && root.contains(target) && isTextEntry(target as HTMLElement)) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
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
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
