import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, TriangleAlert } from 'lucide-react'
import { foreignModelOption } from '../../core/models'
import { foreignModelReason } from '../../core/runRules'
import type { ModelId, ServiceId } from '../../core/services'
import type { SeedvisPriceReference } from '../../providers/seedvis/contract'
import { ProviderTag } from '../common/ProviderTag'
import {
  CLOSED_MODEL_PICKER, listKeyDown, MODEL_PICKER_GROUPS, modelPickerEntries, modelPickerEntry, nearestScrollTop,
  openModelPicker, triggerKeyDown, type ModelPickerAvailability,
} from './modelPickerModel'
import './modelPicker.css'

export interface ModelPickerProps extends ModelPickerAvailability {
  value: ModelId | null
  onChange: (value: ModelId) => void
  label?: string
  disabled?: boolean
  simulated?: Partial<Record<ServiceId, boolean>>
  /** Models offered, in this order inside each service group (core PICKER_ORDER minus hidden / switched-off ones). */
  models?: readonly ModelId[]
  /** A newer build's model (Scene.foreignModel): shown as the choice with a warning; no row is selected. */
  foreign?: string | null
  /** The field was refused (settingsLimits): aria-invalid on the trigger. */
  invalid?: boolean
  /** `data-settings-field` of the trigger, for focusSettingsField. */
  fieldId?: string
  title?: string
  seedvisPrices?: SeedvisPriceReference
}

export const ModelPicker = memo(function ModelPicker({
  value, onChange, label = 'Model', disabled = false, disabledReasons, warningReasons, serviceWarnings, simulated,
  models, foreign, invalid, fieldId, title, seedvisPrices,
}: ModelPickerProps) {
  const id = useId()
  // Primitive deps: a caller's inline `simulated` object must not rebuild the rows every render.
  const simCanvasapp = !!simulated?.canvasapp, simSeedvis = !!simulated?.seedvis
  const entries = useMemo(() => modelPickerEntries({
    disabledReasons, warningReasons, serviceWarnings, models, seedvisPrices,
    simulated: { canvasapp: simCanvasapp, seedvis: simSeedvis },
  }), [disabledReasons, warningReasons, serviceWarnings, models, seedvisPrices, simCanvasapp, simSeedvis])
  const [state, setState] = useState(CLOSED_MODEL_PICKER)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const opened = state.open && !disabled
  const current = foreign ? null : value
  const selected = current ? entries.find(entry => entry.id === current) ?? modelPickerEntry(current, { disabledReasons, warningReasons, serviceWarnings, simulated }) : undefined
  const active = entries[state.active]
  const triggerText = foreign ? foreignModelOption(foreign) : selected?.name ?? 'Nhiều model'
  // The name is shared by both services ("Seedance 2.5"): the accessible name says which one (the tag shows it).
  const triggerLabel = foreign ? triggerText : selected?.label ?? triggerText
  const triggerWarning = foreign ? foreignModelReason(foreign) : selected?.disabledReason || selected?.warningReason

  // preventScroll / scrolling only the list: inside the canvas a focus or scrollIntoView would scroll React Flow's
  // overflow-hidden pane behind its back (wires and hit areas offset until reload).
  const focusTrigger = () => trigger.current?.focus({ preventScroll: true })
  useEffect(() => { if (opened) list.current?.focus({ preventScroll: true }) }, [opened])
  useEffect(() => {
    const box = list.current
    const option = opened ? box?.querySelector<HTMLElement>('[data-active="true"]') : null
    if (box && option) box.scrollTop = nearestScrollTop(box.scrollTop, box.clientHeight, option.offsetTop, option.offsetHeight)
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
    focusTrigger()
    if (entry.id !== current) onChange(entry.id)
  }

  return (
    // nodrag nopan nokey: inside a canvas node, pointer and keys stay with the picker, never React Flow.
    <div ref={root} className="in-model-picker nodrag nopan nokey" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setState(CLOSED_MODEL_PICKER)
    }}>
      <button ref={trigger} type="button" className="in-model-trigger" disabled={disabled} title={title}
        aria-label={`${label}: ${triggerLabel}`} aria-haspopup="listbox" aria-expanded={opened}
        aria-controls={opened ? id : undefined} aria-invalid={invalid || undefined} data-settings-field={fieldId}
        onClick={() => setState(opened ? CLOSED_MODEL_PICKER : openModelPicker(entries, current))}
        onKeyDown={event => {
          const result = triggerKeyDown(event, entries, current, Date.now())
          if (result?.state) setState(result.state)
        }}>
        <span className="in-model-name">{triggerText}</span>
        {selected && <ProviderTag service={selected.service} simulated={simulated?.[selected.service]} />}
        {triggerWarning && <TriangleAlert size={14} aria-label={triggerWarning} />}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {opened && <div ref={list} id={id} className="in-model-list nowheel" role="listbox" tabIndex={-1} aria-label={label}
        aria-activedescendant={active ? `${id}-${state.active}` : undefined} onKeyDown={event => {
          const result = listKeyDown(event, entries, state, Date.now())
          if (!result) return
          setState(result.state)
          if (!result.state.open) focusTrigger()
          if (!disabled && result.selected && result.selected !== current) onChange(result.selected)
        }}>
        {MODEL_PICKER_GROUPS.map(group => entries.some(entry => entry.service === group.service) && <div role="group" aria-labelledby={`${id}-${group.service}`} key={group.service}>
          <div className="in-model-group" id={`${id}-${group.service}`}><ProviderTag service={group.service} simulated={simulated?.[group.service]} /></div>
          {entries.map((entry, index) => entry.service === group.service && <div
            key={entry.id} id={`${id}-${index}`} role="option" className="in-model-option"
            aria-label={entry.label} aria-describedby={`${id}-${index}-detail`} aria-selected={entry.id === current}
            aria-disabled={!!entry.disabledReason} data-active={index === state.active}
            onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
            <div className="in-model-row"><span>{entry.name}</span><ProviderTag service={entry.service} size="mini" simulated={simulated?.[entry.service]} />
              {entry.id === current && <Check size={14} aria-hidden="true" />}</div>
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
