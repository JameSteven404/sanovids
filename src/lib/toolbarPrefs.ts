import { create } from 'zustand'

export type ToolbarDock = 'bottom' | 'top' | 'left' | 'right' | 'free'
export interface ToolbarPlace { dock: ToolbarDock; x: number; y: number }
export const TOOLBAR_PREFS_KEY = 'bdp:pref:toolbar-place'
export const DEFAULT_TOOLBAR_PLACE: ToolbarPlace = { dock: 'bottom', x: 0.5, y: 1 }
const docks: ToolbarDock[] = ['bottom', 'top', 'left', 'right', 'free']
const fraction = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback

export function validateToolbarPlace(value: unknown): ToolbarPlace {
  const p = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<ToolbarPlace> : {}
  const dock = docks.includes(p.dock!) ? p.dock! : DEFAULT_TOOLBAR_PLACE.dock
  return {
    dock,
    x: dock === 'left' ? 0 : dock === 'right' ? 1 : fraction(p.x, 0.5),
    y: dock === 'top' ? 0 : dock === 'bottom' ? 1 : fraction(p.y, 1),
  }
}

export function parseToolbarPrefs(raw: string | null): ToolbarPlace {
  try { return validateToolbarPlace(raw ? JSON.parse(raw) : null) }
  catch { return { ...DEFAULT_TOOLBAR_PLACE } }
}

function readPlace() {
  try { return parseToolbarPrefs(localStorage.getItem(TOOLBAR_PREFS_KEY)) }
  catch { return { ...DEFAULT_TOOLBAR_PLACE } }
}

// Device placement only: deliberately outside project data and settings-file exports.
export const useToolbarPrefs = create<{ place: ToolbarPlace; setPlace: (place: ToolbarPlace) => void }>()((set) => ({
  place: readPlace(),
  setPlace: (value) => {
    const place = validateToolbarPlace(value)
    set({ place })
    try { localStorage.setItem(TOOLBAR_PREFS_KEY, JSON.stringify(place)) }
    catch { /* Storage unavailable: retain the position for this session. */ }
  },
}))
