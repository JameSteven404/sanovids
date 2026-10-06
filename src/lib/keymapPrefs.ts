import { create } from 'zustand'
import {
  actionById, chordFromEvent, contextsOverlap, KEY_ACTIONS, MAX_KEYMAP_BYTES, parseChord,
  resolveKeymap, validateBindings, type ActionId, type BindingOverrides, type ResolvedKeymap, type ValidatedBindings,
} from '../core/keymap'
import { eventLike, IS_MAC } from './keyEvents'

export { RENAMED_ACTIONS } from '../core/keymap'
export const KEYMAP_PREFS_KEY = 'bdp:pref:keys'
export interface KeymapPrefs { bindings: BindingOverrides; foreign: Record<string, unknown> }

export function parseKeymapPrefs(raw: string | null | undefined, mac = IS_MAC): ValidatedBindings {
  if (!raw) return validateBindings({}, mac)
  try {
    if (new TextEncoder().encode(raw).length > MAX_KEYMAP_BYTES) return validateBindings(null, mac)
    const saved: unknown = JSON.parse(raw)
    if (!saved || typeof saved !== 'object' || !('v' in saved) || saved.v !== 1 || !('bindings' in saved)) return validateBindings(null, mac)
    return validateBindings(saved.bindings, mac)
  } catch { return validateBindings(null, mac) }
}

function readPrefs(): ValidatedBindings {
  try { return parseKeymapPrefs(localStorage.getItem(KEYMAP_PREFS_KEY)) }
  catch { return validateBindings({}) }
}

export interface KeymapState extends KeymapPrefs {
  resolved: ResolvedKeymap
  /** Whole command, at most two chords. Conflicts require an explicit replacement by the capture UI. */
  assign: (id: ActionId, chords: readonly string[], replaceConflicts?: boolean) => ValidatedBindings
  removeChord: (id: ActionId, chord: string) => void
  resetAction: (id: ActionId) => void
  resetAll: () => void
  /** Whole group, as used by settings import and undo. */
  replace: (bindings: unknown) => ValidatedBindings
}

const initial = readPrefs()
export const useKeymap = create<KeymapState>()((set, get) => {
  const replace = (input: unknown): ValidatedBindings => {
    const result = validateBindings(input, IS_MAC)
    // Store only overrides, not copies of unchanged defaults.
    const bindings = { ...result.bindings }
    for (const a of KEY_ACTIONS) if (JSON.stringify(bindings[a.id]) === JSON.stringify(a.defaults)) delete bindings[a.id]
    set({ bindings, foreign: result.foreign, resolved: resolveKeymap(bindings, IS_MAC) })
    try { localStorage.setItem(KEYMAP_PREFS_KEY, JSON.stringify({ v: 1, bindings: { ...result.foreign, ...bindings } })) }
    catch { /* storage unavailable: the choice lasts for this session */ }
    return result
  }
  const snapshot = () => ({ ...get().foreign, ...get().bindings })
  return {
    bindings: initial.bindings, foreign: initial.foreign, resolved: resolveKeymap(initial.bindings, IS_MAC), replace,
    assign: (id, chords, replaceConflicts = false) => {
      const checked = validateBindings({ [id]: chords }, IS_MAC)
      if (checked.rejected.length || !actionById(id)) return checked
      const next = snapshot()
      const normalized = checked.bindings[id] ?? []
      for (const other of KEY_ACTIONS) {
        if (other.id === id || !contextsOverlap(actionById(id)!, other)) continue
        const clashes = get().resolved.byAction[other.id].filter((c) => normalized.includes(c))
        if (!clashes.length) continue
        if (!replaceConflicts) {
          checked.issues.push(...clashes.map((chord) => ({ path: `keys.${id}`, reason: 'conflict' as const, chord, with: other.id, message: `${get().resolved.labels[other.id]} đang dùng cho “${other.label}”.` })))
        } else next[other.id] = get().resolved.byAction[other.id].filter((c) => !clashes.includes(c))
      }
      if (checked.issues.length) return { ...checked, rejected: [`keys.${id}`] }
      next[id] = normalized
      return replace(next)
    },
    removeChord: (id, chord) => { replace({ ...snapshot(), [id]: get().resolved.byAction[id].filter((c) => c !== parseChord(chord)) }) },
    resetAction: (id) => { const next = snapshot(); delete next[id]; replace(next) },
    resetAll: () => { replace({}) },
  }
})

export const useShortcutLabel = (id: ActionId): string => useKeymap((s) => s.resolved.labels[id])
export const useShortcutAria = (id: ActionId): string => useKeymap((s) => s.resolved.aria[id])
export function useShortcutTitle(text: string, id: ActionId): string {
  const label = useShortcutLabel(id)
  return label ? `${text} (${label})` : text
}
export const shortcutLabel = (id: ActionId): string => useKeymap.getState().resolved.labels[id]
export function withShortcut(text: string, id: ActionId): string {
  const label = shortcutLabel(id)
  return label ? `${text} (${label})` : text
}

/** Chord identity only: the caller owns context, repeat and preventDefault decisions. */
export function matchesAction(e: Parameters<typeof eventLike>[0], id: ActionId, mac = IS_MAC): boolean {
  const chord = chordFromEvent(eventLike(e), mac)
  const bindings = useKeymap.getState().resolved.byAction[id]
  if (mac && id === 'selection.delete' && bindings.length && (chord === 'Backspace' || chord === 'Ctrl+Backspace')) return true
  return chord !== null && bindings.includes(chord)
}
export function isTypingChord(e: Parameters<typeof eventLike>[0]): boolean {
  return KEY_ACTIONS.some((a) => a.whileTyping && matchesAction(e, a.id))
}
