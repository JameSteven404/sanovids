import { MODELS } from '../../core/models'
import { SEEDVIS_ROUTE_TABLE } from '../../core/seedvisRoutes'
import { CANVASAPP_MODEL_IDS, SEEDVIS_MODEL_IDS, SERVICES, type CanvasappModelId, type ModelId, type ServiceId } from '../../core/services'
import { creditUnitLabel, formatCreditNumber } from '../../lib/credits'
import { SEEDVIS_PRICE_REFERENCE, type SeedvisPriceReference } from '../../providers/seedvis/contract'

/**
 * The picker's groups, in service order. Not core's planned flat `PICKER_ORDER` (B1): callers pass that list (minus
 * hidden models, minus seedvis while it is off) as `models`, which filters and orders the rows inside each group.
 */
export const MODEL_PICKER_GROUPS = [
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
  /** Per model and still selectable, e.g. settingsLimits' 'risky' state ("có thể bị từ chối"). */
  warningReasons?: Partial<Record<ModelId, string>>
  // A missing key blocks running, not choosing settings for a future run.
  serviceWarnings?: Partial<Record<ServiceId, string>>
}

export interface ModelPickerOptions extends ModelPickerAvailability {
  /** Models to list, in this order inside each service group (default: the whole catalogue). */
  models?: readonly ModelId[]
  /** Services run by a simulated executor: their prices are in "credit dev". */
  simulated?: Partial<Record<ServiceId, boolean>>
  /** seedvis reference prices (§7.9); an empty table, or no row for a model, shows "—". */
  seedvisPrices?: SeedvisPriceReference
}

const span = (values: readonly number[], format: (n: number) => string = String) => {
  const low = Math.min(...values), high = Math.max(...values)
  return low === high ? format(low) : `${format(low)}–${format(high)}`
}
/** "≈ 4–25 credit" / "≈ 4–25 credit dev": the units of lib/credits, never a bare number. */
const priceSpan = (credits: readonly number[], unit: string) => `≈ ${span(credits, formatCreditNumber)} ${unit}`

const isCanvasapp = (id: ModelId): id is CanvasappModelId => (CANVASAPP_MODEL_IDS as readonly ModelId[]).includes(id)

function catalogueEntry(id: ModelId, options: ModelPickerOptions): ModelPickerEntry {
  if (isCanvasapp(id)) {
    const spec = MODELS[id]
    const unit = creditUnitLabel(options.simulated?.canvasapp ? 'dev' : 'canvasapp')
    return {
      id, service: 'canvasapp', name: spec.name, label: `${spec.name} · ${SERVICES.canvasapp.label}`,
      capability: `≤ ${spec.maxRefImages} ảnh · ${span(spec.durations)} s · ${spec.resolutions[0]}–${spec.resolutions.at(-1)} · ${priceSpan(Object.values(spec.pricing).flatMap(Object.values), unit)}`,
    }
  }
  const spec = SEEDVIS_ROUTE_TABLE[id]
  const credits = (options.seedvisPrices ?? SEEDVIS_PRICE_REFERENCE).rows
    .filter(row => row.model === id && Number.isFinite(row.credits) && row.credits >= 0).map(row => row.credits)
  const price = credits.length ? priceSpan(credits, options.simulated?.seedvis ? 'credit dev seedvis' : 'credit seedvis') : 'Giá: — (chưa đo)'
  return {
    id, service: 'seedvis', name: spec.name, label: `${spec.name} · ${SERVICES.seedvis.label}`,
    capability: `≤ ${spec.maxRefImages} ảnh · ${span(spec.durations)} s · ${price}${spec.family === 'seedance' ? ' · @image_1 có thể thành khung mở đầu' : ' · Gốc / 1080p (phóng to)'}`,
  }
}

export function modelPickerEntries(options: ModelPickerOptions = {}): readonly ModelPickerEntry[] {
  const allowed = options.models ? [...new Set(options.models)] : null
  return MODEL_PICKER_GROUPS.flatMap(group => {
    const ids: readonly ModelId[] = group.models
    return allowed ? allowed.filter(id => ids.includes(id)) : ids
  }).map(id => {
    const entry = catalogueEntry(id, options)
    const warnings = [options.warningReasons?.[id], options.serviceWarnings?.[entry.service]].filter(Boolean)
    return { ...entry, disabledReason: options.disabledReasons?.[id] || undefined, warningReason: warnings.join(' · ') || undefined }
  })
}

/** The catalogue row of `id` whether or not the caller lists it (the trigger still names a hidden model). */
export const modelPickerEntry = (id: ModelId, options: ModelPickerOptions = {}): ModelPickerEntry =>
  modelPickerEntries({ ...options, models: [id] })[0]

export interface ModelPickerState { open: boolean; active: number; search: string; searchedAt: number }
export const CLOSED_MODEL_PICKER: ModelPickerState = { open: false, active: -1, search: '', searchedAt: 0 }
/** Type-ahead keeps adding letters typed within this many ms of the previous one. */
export const TYPE_AHEAD_MS = 700

export function openModelPicker(entries: readonly ModelPickerEntry[], value: ModelId | null): ModelPickerState {
  const selected = entries.findIndex(entry => entry.id === value && !entry.disabledReason)
  return { ...CLOSED_MODEL_PICKER, open: true, active: selected >= 0 ? selected : entries.findIndex(entry => !entry.disabledReason) }
}

const searchText = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase()
const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown'])
/**
 * Keys the picker keeps without acting on them. The native <select> it replaces is a typing target for the global
 * shortcuts (useShortcuts / keyEvents), so Delete / ⌫ there never deleted the selected scenes: the picker marks them
 * handled (preventDefault: the global handlers skip a prevented key) so they still do not.
 */
const KEPT_KEYS = new Set(['Delete', 'Backspace', 'ArrowLeft', 'ArrowRight', 'Insert', 'Clear'])

export interface ModelPickerKeyResult { state: ModelPickerState; handled: boolean; selected?: ModelId }

// Selection is committed only by Enter/Space or a click; navigating never changes settings.
export function modelPickerKey(entries: readonly ModelPickerEntry[], state: ModelPickerState, key: string, now: number): ModelPickerKeyResult {
  if (key === 'Escape' || key === 'Tab') return { state: CLOSED_MODEL_PICKER, handled: key === 'Escape' }
  if (!state.open) return { state, handled: false }
  // Space inside a type-ahead ("seedance 2.0") is part of the search, as in a native listbox.
  const searching = state.search !== '' && now - state.searchedAt <= TYPE_AHEAD_MS
  if (key === 'Enter' || (key === ' ' && !searching)) {
    const entry = entries[state.active]
    return entry && !entry.disabledReason
      ? { state: CLOSED_MODEL_PICKER, handled: true, selected: entry.id }
      : { state, handled: true }
  }
  const enabled = entries.flatMap((entry, index) => entry.disabledReason ? [] : [index])
  if (NAVIGATION_KEYS.has(key)) {
    const position = enabled.indexOf(state.active)
    const next = key === 'Home' || key === 'PageUp' ? 0 : key === 'End' || key === 'PageDown' ? enabled.length - 1
      : position < 0 ? (key === 'ArrowUp' ? enabled.length - 1 : 0)
      : (position + (key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
    return { state: { ...state, active: enabled[next] ?? -1, search: '' }, handled: true }
  }
  if (key.length !== 1) return { state, handled: KEPT_KEYS.has(key) }
  const char = searchText(key)
  const search = searching ? state.search + char : char
  const prefix = [...search].every(c => c === char) ? char : search
  const start = prefix.length === 1 ? state.active + 1 : Math.max(0, state.active)
  const match = entries.map((_, offset) => (start + offset) % entries.length)
    .find(index => !entries[index].disabledReason && searchText(entries[index].label).startsWith(prefix))
  return { state: { ...state, active: match ?? state.active, search, searchedAt: now }, handled: true }
}

export interface ModelPickerTriggerResult {
  /** The opened list, or null when the key does not open it. */
  state: ModelPickerState | null
  handled: boolean
  /** Enter / Space press the button themselves (its click opens the list): only keep them from the global shortcuts. */
  press?: true
}

/**
 * Keys on the closed trigger. Like the native select, every plain key except Tab / Escape / function keys stays in the
 * picker: arrows open the list on the saved choice, a letter opens it on the first match (type-ahead, never a commit),
 * Delete / ⌫ do nothing — none of them reaches the global shortcuts (n = new scene, Delete = delete…).
 */
export function modelPickerTriggerKey(entries: readonly ModelPickerEntry[], value: ModelId | null, key: string, now: number): ModelPickerTriggerResult {
  if (key === 'Enter' || key === ' ') return { state: null, handled: true, press: true }
  const opened = openModelPicker(entries, value)
  if (key === 'ArrowDown' || key === 'ArrowUp') return { state: opened, handled: true }
  if (NAVIGATION_KEYS.has(key) || key.length === 1) return { state: modelPickerKey(entries, opened, key, now).state, handled: true }
  return { state: null, handled: KEPT_KEYS.has(key) }
}

/** Minimal event surface of the picker's key handlers (a React KeyboardEvent fits; tests pass plain objects). */
export interface PickerKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  nativeEvent?: { isComposing?: boolean }
  preventDefault(): void
  stopPropagation(): void
}
const chorded = (event: PickerKeyEvent) => event.ctrlKey || event.metaKey || event.altKey || !!event.nativeEvent?.isComposing

/** The open listbox's keydown: applies modelPickerKey and keeps every handled key from the page (null = not ours). */
export function listKeyDown(event: PickerKeyEvent, entries: readonly ModelPickerEntry[], state: ModelPickerState, now: number): ModelPickerKeyResult | null {
  if (chorded(event)) return null
  const result = modelPickerKey(entries, state, event.key, now)
  if (result.handled) { event.preventDefault(); event.stopPropagation() }
  return result
}

/** The trigger's keydown (see modelPickerTriggerKey); Enter / Space keep their default so the button still clicks. */
export function triggerKeyDown(event: PickerKeyEvent, entries: readonly ModelPickerEntry[], value: ModelId | null, now: number): ModelPickerTriggerResult | null {
  if (chorded(event)) return null
  const result = modelPickerTriggerKey(entries, value, event.key, now)
  if (result.handled) {
    if (!result.press) event.preventDefault()
    event.stopPropagation()
  }
  return result
}

/** scrollTop that brings an option into the list's view by the smallest move (the list scrolls, never the page). */
export function nearestScrollTop(scrollTop: number, viewHeight: number, top: number, height: number): number {
  // A row taller than the list shows its top.
  if (top < scrollTop || height >= viewHeight) return top
  if (top + height > scrollTop + viewHeight) return top + height - viewHeight
  return scrollTop
}
