// Building blocks of the Settings dialog (dg-): grouped inset section, switch row, labelled field, and the context the
// rows use to close the dialog or re-sync after a reset / import. Styles: dialogs.css.
import { createContext, useContext, useId, type ReactNode } from 'react'

/** What every row component gets from the registry (one source for the label and hint, also used by the search). */
export interface RowProps {
  label: string
  hint?: string
}

export interface SettingsCtxValue {
  close: () => void
  /** Settings were replaced from outside a row (reset / import / undo): bumps `epoch`. */
  resync: () => void
  /** Changes on every resync: a row keeping a draft (the name template) drops a draft from an older epoch. */
  epoch: number
}
export const SettingsCtx = createContext<SettingsCtxValue>({ close: () => undefined, resync: () => undefined, epoch: 0 })
export const useSettingsCtx = () => useContext(SettingsCtx)

export function Section({ title, desc, children, badge }: { title: string; desc?: ReactNode; children: ReactNode; badge?: ReactNode }) {
  const id = useId()
  return (
    <section className="dg-section" aria-labelledby={id}>
      <header>
        <h3 id={id}>
          {title}
          {badge}
        </h3>
        {desc && <p>{desc}</p>}
      </header>
      {children}
    </section>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
}) {
  const hintId = useId()
  return (
    <label className={`dg-toggle-row${disabled ? ' disabled' : ''}`}>
      <span className="dg-toggle-text">
        <span>{label}</span>
        {hint && <small id={hintId}>{hint}</small>}
      </span>
      <span className={`dg-switch ${checked ? 'on' : ''}`}>
        <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-describedby={hint ? hintId : undefined} onChange={(e) => onChange(e.target.checked)} />
        <i />
      </span>
    </label>
  )
}

/** A labelled control (segmented, slider, text field…) with its value on the right and a hint below. */
export function Field({ label, hint, value, children, labelId }: { label: ReactNode; hint?: ReactNode; value?: ReactNode; children: ReactNode; labelId?: string }) {
  return (
    <div className="dg-field">
      <div className="dg-label-row">
        <span className="label" id={labelId}>
          {label}
        </span>
        {value}
      </div>
      {children}
      {hint && <div className="dg-field-hint">{hint}</div>}
    </div>
  )
}
