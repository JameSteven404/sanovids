import { MODELS } from '../../core/models'
import { SEEDVIS_ROUTE_TABLE } from '../../core/seedvisRoutes'
import { CANVASAPP_MODEL_IDS, SEEDVIS_MODEL_IDS, SERVICES, type ModelId, type ServiceId } from '../../core/services'

export const PICKER_ORDER = [
  { service: 'canvasapp', models: CANVASAPP_MODEL_IDS },
  { service: 'seedvis', models: SEEDVIS_MODEL_IDS },
] as const

export interface ModelPickerEntry {
  id: ModelId
  service: ServiceId
  name: string
  label: string
  capability: string
  disabledReason?: string
  warningReason?: string
}

export interface ModelPickerAvailability {
  disabledReasons?: Partial<Record<ModelId, string>>
  // A missing key blocks running, not choosing settings for a future run.
  serviceWarnings?: Partial<Record<ServiceId, string>>
}

const range = (values: readonly number[]) => `${Math.min(...values)}–${Math.max(...values)}`
const CATALOGUE: readonly ModelPickerEntry[] = [
  ...CANVASAPP_MODEL_IDS.map(id => {
    const spec = MODELS[id]
    return {
      id, service: 'canvasapp' as const, name: spec.name, label: `${spec.name} · ${SERVICES.canvasapp.label}`,
      capability: `≤ ${spec.maxRefImages} ảnh · ${range(spec.durations)} s · ${spec.resolutions[0]}–${spec.resolutions.at(-1)} · ≈ ${range(Object.values(spec.pricing).flatMap(Object.values))} credit`,
    }
  }),
  ...SEEDVIS_MODEL_IDS.map(id => {
    const spec = SEEDVIS_ROUTE_TABLE[id]
    return {
      id, service: 'seedvis' as const, name: spec.name, label: `${spec.name} · ${SERVICES.seedvis.label}`,
      capability: `≤ ${spec.maxRefImages} ảnh · ${range(spec.durations)} s · Giá: — (chưa đo)${spec.family === 'seedance' ? ' · @image_1 có thể thành khung mở đầu' : ' · Gốc / 1080p (phóng to)'}`,
    }
  }),
]

export function modelPickerEntries(availability: ModelPickerAvailability = {}): readonly ModelPickerEntry[] {
  return CATALOGUE.map(entry => ({
    ...entry,
    disabledReason: availability.disabledReasons?.[entry.id] || undefined,
    warningReason: availability.serviceWarnings?.[entry.service] || undefined,
  }))
}

export interface ModelPickerState { open: boolean; active: number; search: string; searchedAt: number }
export const CLOSED_MODEL_PICKER: ModelPickerState = { open: false, active: -1, search: '', searchedAt: 0 }

export function openModelPicker(entries: readonly ModelPickerEntry[], value: ModelId | null): ModelPickerState {
  const selected = entries.findIndex(entry => entry.id === value && !entry.disabledReason)
  return { ...CLOSED_MODEL_PICKER, open: true, active: selected >= 0 ? selected : entries.findIndex(entry => !entry.disabledReason) }
}

const searchText = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase()

// Selection is committed only by Enter/Space or a click; navigating never changes settings.
export function modelPickerKey(entries: readonly ModelPickerEntry[], state: ModelPickerState, key: string, now: number): {
  state: ModelPickerState; handled: boolean; selected?: ModelId
} {
  if (key === 'Escape' || key === 'Tab') return { state: CLOSED_MODEL_PICKER, handled: key === 'Escape' }
  if (!state.open) return { state, handled: false }
  if (key === 'Enter' || key === ' ') {
    const entry = entries[state.active]
    return entry && !entry.disabledReason
      ? { state: CLOSED_MODEL_PICKER, handled: true, selected: entry.id }
      : { state, handled: true }
  }
  const enabled = entries.flatMap((entry, index) => entry.disabledReason ? [] : [index])
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
    const position = enabled.indexOf(state.active)
    const next = key === 'Home' ? 0 : key === 'End' ? enabled.length - 1
      : position < 0 ? (key === 'ArrowUp' ? enabled.length - 1 : 0)
      : (position + (key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
    return { state: { ...state, active: enabled[next] ?? -1, search: '' }, handled: true }
  }
  if (key.length !== 1) return { state, handled: false }
  const char = searchText(key)
  const search = now - state.searchedAt <= 700 ? state.search + char : char
  const prefix = [...search].every(c => c === char) ? char : search
  const start = prefix.length === 1 ? state.active + 1 : Math.max(0, state.active)
  const match = entries.map((_, offset) => (start + offset) % entries.length)
    .find(index => !entries[index].disabledReason && searchText(entries[index].label).startsWith(prefix))
  return { state: { ...state, active: match ?? state.active, search, searchedAt: now }, handled: true }
}
