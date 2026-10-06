// Data of a newer SanoVids build kept as a marker (Scene.foreignModel / foreignSettings, Preset, Take.foreignProvider):
// the pure cleaning of ids and settings objects. Used by core/migrate (loading a project / file) and store/project
// (restoring a take's settings onto a scene). No store import (store/project imports this module).
import { isModelId } from './models'
import type { ForeignSettings } from './types'

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

/**
 * The marker a settings object of a newer build's model gives (a take's `settings` keep the id as it was saved): its
 * model id (cut to FOREIGN_ID_MAX) + the settings (cleanForeignSettings), or null for a model this build knows (or
 * none). Used when such settings are copied onto a scene (restore from a take): the scene stays blocked instead of
 * becoming a runnable Seedance 2.5 scene.
 */
export function foreignMarkOf(settings: unknown): { foreignModel: string; foreignSettings?: ForeignSettings } | null {
  const model: unknown = settings && typeof settings === 'object' ? (settings as { model?: unknown }).model : undefined
  if (typeof model !== 'string' || !model.trim() || isModelId(model)) return null
  const foreign = cleanForeignSettings(settings)
  return { foreignModel: model.slice(0, FOREIGN_ID_MAX), ...(foreign ? { foreignSettings: foreign } : {}) }
}
