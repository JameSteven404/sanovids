import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { trapTab, useOverlayFocus } from './focus'

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
 * Shared dialog shell. Closes on Escape and on backdrop click.
 * Takes the keyboard focus while open (Tab stays inside) and gives it back on close, so keys never reach the page
 * behind it (arrow keys moving a selected canvas node, typing into a focused prompt).
 */
export function Modal({ title, onClose, children, footer, size = 'normal', headerExtra }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)
  useOverlayFocus(ref)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`modal ${size === 'normal' ? '' : size}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        style={{ outline: 'none' }}
        onKeyDown={trapTab}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          {headerExtra}
          <button className="icon-btn" onClick={onClose} aria-label="Đóng" title="Đóng (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
