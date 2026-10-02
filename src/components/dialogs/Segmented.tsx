// Apple-style segmented control for the dialogs (dg-seg): a pill track with one raised segment that slides to the
// chosen option (150 ms, none with prefers-reduced-motion). Equal-width segments; ←/→ move the choice like a
// native radio group. Styles: dialogs.css.
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import './dialogs.css'

export interface SegmentOption<T extends string | number> {
  id: T
  label: ReactNode
  /** Second, smaller line under the label. */
  hint?: ReactNode
  icon?: ReactNode
  title?: string
  disabled?: boolean
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  size = 'md',
}: {
  options: SegmentOption<T>[]
  value: T
  onChange: (v: T) => void
  /** Accessible name of the group. */
  label: string
  size?: 'md' | 'lg'
}) {
  const index = options.findIndex((o) => o.id === value)
  const style = { '--seg-n': options.length, '--seg-i': Math.max(0, index) } as CSSProperties
  // The one segment in the Tab order: the chosen one, or the first enabled one when nothing is chosen or the chosen
  // option is disabled (e.g. canvasapp kept from the desktop app but unavailable on the web) — a disabled button
  // cannot take focus, which would leave the whole group unreachable by keyboard.
  const tabStop = index >= 0 && !options[index].disabled ? index : options.findIndex((o) => !o.disabled)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const step = e.key === 'ArrowRight' ? 1 : -1
    const n = options.length
    // Nothing chosen: → starts at the first option, ← at the last.
    const from = index >= 0 ? index : step > 0 ? -1 : n
    for (let k = 1; k <= n; k++) {
      const next = options[(((from + step * k) % n) + n) % n]
      if (next && !next.disabled) {
        e.preventDefault()
        onChange(next.id)
        // Keep the focus on the chosen segment (roving focus, like a native radio group).
        const btn = e.currentTarget.querySelector<HTMLButtonElement>(`[data-seg="${String(next.id)}"]`)
        btn?.focus()
        return
      }
    }
  }

  return (
    <div className={`dg-seg ${size}${index >= 0 ? ' has-value' : ''}`} role="radiogroup" aria-label={label} style={style} onKeyDown={onKeyDown}>
      {options.map((o, i) => {
        const on = i === index
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === tabStop ? 0 : -1}
            data-seg={String(o.id)}
            className={on ? 'active' : ''}
            disabled={o.disabled}
            title={o.title}
            onClick={() => !on && onChange(o.id)}
          >
            <span className="dg-seg-label">
              {o.icon}
              {o.label}
            </span>
            {o.hint && <small>{o.hint}</small>}
          </button>
        )
      })}
    </div>
  )
}
