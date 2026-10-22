// Data of a newer SanoVids build kept as a marker (Scene.foreignModel / foreignSettings, Preset, Take.foreignProvider):
// the pure cleaning of ids and settings objects. Used by core/migrate (loading a project / file) and store/project
// (restoring a take's settings onto a scene). No store import (store/project imports this module).
import { isModelId, MODELS, normalizeSettings } from './models'
import type { ForeignSettings, VideoSettings } from './types'

/** Longest model / provider id kept from a newer build (real ids are short; a longer one is cut and still blocks). */
export const FOREIGN_ID_MAX = 64
/** Most keys kept in Scene.foreignSettings / Preset.foreignSettings. */
export const FOREIGN_SETTINGS_MAX_KEYS = 32
/** Most bytes (UTF-8 JSON) kept in Scene.foreignSettings / Preset.foreignSettings. */
export const FOREIGN_SETTINGS_MAX_BYTES = 2048

const utf8 = new TextEncoder()
const jsonBytes = (v: unknown) => utf8.encode(JSON.stringify(v)).length

/** A non-blank string id (cut to FOREIGN_ID_MAX), else null. */
export function foreignId(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.slice(0, FOREIGN_ID_MAX) : null
}

/**
 * Flat copy of a settings object saved by a newer build: string / finite number / boolean values only (nested
 * objects, arrays, null are dropped), at most FOREIGN_SETTINGS_MAX_KEYS keys and FOREIGN_SETTINGS_MAX_BYTES of JSON
 * (an entry that does not fit is skipped). `omit`: keys that are not settings (a preset's id / name). Null when
 * nothing is left.
 */
export function cleanForeignSettings(raw: unknown, omit: readonly string[] = []): ForeignSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: ForeignSettings = {}
  let bytes = 2 // "{}"
  let n = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= FOREIGN_SETTINGS_MAX_KEYS) break
    if (key === '__proto__' || omit.includes(key)) continue
    if (!(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) continue
    const size = jsonBytes(key) + 1 + jsonBytes(value) + (n ? 1 : 0) // "key":value plus the comma
    if (bytes + size > FOREIGN_SETTINGS_MAX_BYTES) continue
    out[key] = value
    bytes += size
    n++
  }
  return n ? out : null
}

/** Settings a newer build may give values this build does not offer for a model it knows. */
export const CONFIG_KEYS = ['mode', 'duration', 'resolution', 'ratio'] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** Every value some model of this build offers, per key (none of these lists ever shrank). */
const OFFERED: Record<ConfigKey, ReadonlySet<string | number>> = {
  mode: new Set(Object.values(MODELS).flatMap((m) => m.modes)),
  duration: new Set(Object.values(MODELS).flatMap((m) => m.durations)),
  resolution: new Set(Object.values(MODELS).flatMap((m) => m.resolutions)),
  ratio: new Set(Object.values(MODELS).flatMap((m) => m.ratios)),
}

/**
 * The saved values (non-empty string mode / resolution / ratio, finite number duration) of a KNOWN model's settings that
 * normalizeSettings replaces — the ones a newer build must have written: every one when `strict` (a file of a newer
 * schema, a take), else only values no model of this build has ever offered (an older build's own mix, e.g. a Seedance
 * scene left on an H3-only mode, is still quietly fixed as before). [] = nothing lost (or not a known model).
 */
export function lostConfigValues(raw: unknown, strict: boolean): { key: ConfigKey; value: string | number }[] {
  if (!raw || typeof raw !== 'object') return []
  const r = raw as Record<string, unknown>
  if (!isModelId(r.model)) return []
  const normalized = normalizeSettings(r as Partial<VideoSettings>)
  const out: { key: ConfigKey; value: string | number }[] = []
  for (const key of CONFIG_KEYS) {
    const v = r[key]
    const typed = key === 'duration' ? typeof v === 'number' && Number.isFinite(v) : typeof v === 'string' && v.trim() !== ''
    if (!typed || v === normalized[key]) continue
    if (strict || !OFFERED[key].has(v as string | number)) out.push({ key, value: v as string | number })
  }
  return out
}

/**
 * The marker a settings object of a newer build gives (a take's `settings` keep what was saved): for a model this build
 * does not know, its id (cut to FOREIGN_ID_MAX) + the settings (cleanForeignSettings); for a known model with values
 * this build does not offer for it (lostConfigValues, strict), a config marker (foreignSettings alone); else null.
 * Used when such settings are copied onto a scene (restore from a take): the scene stays blocked instead of becoming a
 * runnable stand-in scene.
 */
export function foreignMarkOf(settings: unknown): { foreignModel?: string; foreignSettings?: ForeignSettings } | null {
  const model: unknown = settings && typeof settings === 'object' ? (settings as { model?: unknown }).model : undefined
  if (isModelId(model)) {
    const config = lostConfigValues(settings, true).length ? cleanForeignSettings(settings) : null
    // a marker that lost the very values it is for (too big to keep) would be dropped by the next load: none
    return config && lostConfigValues(config, true).length ? { foreignSettings: config } : null
  }
  if (typeof model !== 'string' || !model.trim()) return null
  const foreign = cleanForeignSettings(settings)
  return { foreignModel: model.slice(0, FOREIGN_ID_MAX), ...(foreign ? { foreignSettings: foreign } : {}) }
}
