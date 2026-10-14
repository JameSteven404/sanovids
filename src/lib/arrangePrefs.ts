import { create } from 'zustand'
import { LEGACY_ROWS, type ArrangeOptions, type ArrangeStyle } from '../core/arrange'

export type ArrangePrefs = Omit<ArrangeOptions, 'scope' | 'video'> & { videoBy: Record<ArrangeStyle, ArrangeOptions['video']> }
export const ARRANGE_PREFS_KEY = 'bdp:pref:arrange'
export const DEFAULT_ARRANGE_PREFS: ArrangePrefs = {
  style: 'rows', gridCols: 'auto', spacing: 'normal', refs: 'column', folders: 'keep', placedTakes: 'reset',
  videoBy: { rows: 'all', grid: 'chosen', strip: 'chosen' },
}
const oneOf = (values: readonly unknown[]) => (value: unknown) => values.includes(value)
export const ARRANGE_RULES = {
  style: oneOf(['rows', 'grid', 'strip']), gridCols: oneOf(['auto', 2, 3, 4, 5, 6, 8]),
  spacing: oneOf(['tight', 'normal', 'roomy']), refs: oneOf(['column', 'byKind', 'keep']),
  folders: oneOf(['keep', 'top']), placedTakes: oneOf(['reset', 'follow']),
}
export const isArrangeVideo = oneOf(['all', 'chosen'])
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

/** Validate each field independently, including the per-style video choices. */
export function cleanArrangePrefs(value: unknown): ArrangePrefs {
  const raw = object(value), next = { ...DEFAULT_ARRANGE_PREFS, videoBy: { ...DEFAULT_ARRANGE_PREFS.videoBy } }
  for (const key of Object.keys(ARRANGE_RULES) as (keyof typeof ARRANGE_RULES)[]) {
    if (ARRANGE_RULES[key](raw[key])) Object.assign(next, { [key]: raw[key] })
  }
  const video = object(raw.videoBy)
  for (const style of ['rows', 'grid', 'strip'] as const) if (isArrangeVideo(video[style])) next.videoBy[style] = video[style] as ArrangeOptions['video']
  return next
}
export function parseArrangePrefs(raw: string | null): ArrangePrefs {
  try { return cleanArrangePrefs(raw ? JSON.parse(raw) : null) } catch { return cleanArrangePrefs(null) }
}
function read(): ArrangePrefs {
  try { return parseArrangePrefs(localStorage.getItem(ARRANGE_PREFS_KEY)) } catch { return cleanArrangePrefs(null) }
}
export function resolveArrange(prefs: ArrangePrefs): ArrangeOptions {
  const { videoBy, ...rest } = cleanArrangePrefs(prefs)
  return { ...LEGACY_ROWS, ...rest, video: videoBy[rest.style], scope: 'all' }
}
export const useArrangePrefs = create<ArrangePrefs & { set: (patch: Partial<ArrangePrefs>) => void; reset: () => void }>()((set, get) => ({
  ...read(),
  set: (patch) => {
    const next = cleanArrangePrefs({ ...get(), ...patch, videoBy: { ...get().videoBy, ...patch.videoBy } })
    set(next)
    try { localStorage.setItem(ARRANGE_PREFS_KEY, JSON.stringify({ v: 1, ...next })) } catch { /* Storage unavailable. */ }
  },
  reset: () => get().set(DEFAULT_ARRANGE_PREFS),
}))
