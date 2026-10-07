import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, TriangleAlert } from 'lucide-react'
import type { ModelId, ServiceId } from '../../core/services'
import { ProviderTag } from '../common/ProviderTag'
import { CLOSED_MODEL_PICKER, modelPickerEntries, modelPickerKey, openModelPicker, PICKER_ORDER, type ModelPickerAvailability } from './modelPickerModel'
import './modelPicker.css'

export interface ModelPickerProps extends ModelPickerAvailability {
  value: ModelId | null
  onChange: (value: ModelId) => void
  label?: string
  disabled?: boolean
  simulated?: Partial<Record<ServiceId, boolean>>
}

export const ModelPicker = memo(function ModelPicker({ value, onChange, label = 'Model', disabled = false, disabledReasons, serviceWarnings, simulated }: ModelPickerProps) {
  const id = useId()
  const entries = useMemo(() => modelPickerEntries({ disabledReasons, serviceWarnings }), [disabledReasons, serviceWarnings])
  const [state, setState] = useState(CLOSED_MODEL_PICKER)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const opened = state.open && !disabled
  const selected = entries.find(entry => entry.id === value)
  const active = entries[state.active]

  useEffect(() => { if (opened) list.current?.focus() }, [opened])
  useEffect(() => {
    if (opened) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [opened, state.active])
  useEffect(() => { if (disabled) setState(CLOSED_MODEL_PICKER) }, [disabled])
  useEffect(() => {
    if (!opened) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setState(CLOSED_MODEL_PICKER)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [opened])

  const choose = (index: number) => {
    const entry = entries[index]
    if (disabled || !entry || entry.disabledReason) return
    setState(CLOSED_MODEL_PICKER)
    trigger.current?.focus()
    if (entry.id !== value) onChange(entry.id)
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return
    const result = modelPickerKey(entries, state, event.key, Date.now())
    if (result.handled) { event.preventDefault(); event.stopPropagation() }
    setState(result.state)
    if (!result.state.open) trigger.current?.focus()
    if (!disabled && result.selected && result.selected !== value) onChange(result.selected)
  }

  return (
    <div ref={root} className="in-model-picker" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setState(CLOSED_MODEL_PICKER)
    }}>
      <button ref={trigger} type="button" className="in-model-trigger" disabled={disabled}
        aria-label={`${label}: ${selected?.label ?? 'Nhiều model'}`} aria-haspopup="listbox" aria-expanded={opened}
        aria-controls={opened ? id : undefined}
        onClick={() => setState(opened ? CLOSED_MODEL_PICKER : openModelPicker(entries, value))}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); event.stopPropagation()
            setState(openModelPicker(entries, value))
          }
        }}>
        <span className="in-model-name">{selected?.name ?? 'Nhiều model'}</span>
        {selected && <ProviderTag service={selected.service} simulated={simulated?.[selected.service]} />}
        {(selected?.disabledReason || selected?.warningReason) && <TriangleAlert size={14} aria-label={selected.disabledReason || selected.warningReason} />}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {opened && <div ref={list} id={id} className="in-model-list" role="listbox" tabIndex={-1} aria-label={label}
        aria-activedescendant={active ? `${id}-${state.active}` : undefined} onKeyDown={keyDown}>
        {PICKER_ORDER.map(group => <div role="group" aria-labelledby={`${id}-${group.service}`} key={group.service}>
          <div className="in-model-group" id={`${id}-${group.service}`}><ProviderTag service={group.service} simulated={simulated?.[group.service]} /></div>
          {entries.map((entry, index) => entry.service === group.service && <div
            key={entry.id} id={`${id}-${index}`} role="option" className="in-model-option"
            aria-label={entry.label} aria-describedby={`${id}-${index}-detail`} aria-selected={entry.id === value}
            aria-disabled={!!entry.disabledReason} data-active={index === state.active}
            onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
            <div className="in-model-row"><span>{entry.name}</span><ProviderTag service={entry.service} size="mini" simulated={simulated?.[entry.service]} />
              {entry.id === value && <Check size={14} aria-hidden="true" />}</div>
            <div id={`${id}-${index}-detail`} className="in-model-detail">
              <span>{entry.capability}</span>
              {(entry.disabledReason || entry.warningReason) && <span className="in-model-reason"><TriangleAlert size={13} aria-hidden="true" />{entry.disabledReason || entry.warningReason}</span>}
            </div>
          </div>)}
        </div>)}
      </div>}
    </div>
  )
})
