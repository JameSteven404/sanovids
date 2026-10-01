// Small presentational pieces reused across the sidebar panels and dialogs.
import { Check, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { PALETTE } from '../../core/ids'

// ---------------- collapsible section ----------------
interface SectionProps {
  title: string
  icon: ReactNode
  count?: ReactNode
  actions?: ReactNode
  collapsed: boolean
  onToggle: () => void
  /** Relative share of the free height when open. */
  grow: number
  /** Fixed content between the header and the scroll area (filters, explanations). */
  toolbar?: ReactNode
  /** Fixed content under the scroll area (hints, selection bar). */
  footer?: ReactNode
  /** Extra props for the section root (drop zones). */
  rootProps?: HTMLAttributes<HTMLElement>
  bodyProps?: HTMLAttributes<HTMLDivElement>
  className?: string
  children: ReactNode
}

export function Section({ title, icon, count, actions, collapsed, onToggle, grow, toolbar, footer, rootProps, bodyProps, className = '', children }: SectionProps) {
  return (
    <section
      {...rootProps}
      className={`sb-sec ${collapsed ? 'collapsed' : 'open'} ${className}`}
      style={collapsed ? undefined : { flexGrow: grow }}
    >
      <header className="sb-sec-head" onClick={onToggle}>
        <button
          className="sb-sec-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? 'Mở rộng' : 'Thu gọn'}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
        >
          <ChevronRight size={14} className="sb-chev" />
        </button>
        <span className="sb-sec-icon">{icon}</span>
        <span className="sb-sec-title">{title}</span>
        {count !== undefined && <span className="sb-sec-count">{count}</span>}
        <span className="sb-sec-spacer" />
        {actions && (
          <span className="sb-sec-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </header>
      {!collapsed && (
        <>
          {toolbar}
          <div {...bodyProps} className={`sb-sec-body ${bodyProps?.className ?? ''}`}>
            {children}
          </div>
          {footer}
        </>
      )}
    </section>
  )
}

// ---------------- two-step confirm button ----------------
/** First click arms the button ("Xác nhận…"), second click runs. Disarms after a few seconds. */
export function ConfirmButton({
  label,
  confirmLabel = 'Bấm lần nữa để xoá',
  onConfirm,
  icon,
  className = 'btn btn-danger btn-sm',
  title,
}: {
  label: ReactNode
  confirmLabel?: ReactNode
  onConfirm: () => void
  icon?: ReactNode
  className?: string
  title?: string
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  return (
    <button
      type="button"
      className={`${className} ${armed ? 'sb-armed' : ''}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        if (armed) {
          if (timer.current) clearTimeout(timer.current)
          setArmed(false)
          onConfirm()
          return
        }
        setArmed(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setArmed(false), 3500)
      }}
    >
      {icon}
      {armed ? confirmLabel : label}
    </button>
  )
}

// ---------------- color swatches ----------------
export function ColorSwatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="sb-swatches" role="radiogroup" aria-label="Màu">
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c.toLowerCase()}
          className={`sb-swatch ${value.toLowerCase() === c.toLowerCase() ? 'active' : ''}`}
          style={{ background: c }}
          title={c}
          onClick={() => onChange(c)}
        >
          {value.toLowerCase() === c.toLowerCase() && <Check size={12} strokeWidth={3} />}
        </button>
      ))}
    </div>
  )
}
