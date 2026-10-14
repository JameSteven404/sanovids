import type { Preset } from './types'

export const PRESET_NAMES_VERSION = 2
export const FACTORY_PRESETS = [
  { id: 'preset_draft', name: 'Bản nháp', oldName: 'Nháp', model: 'seedance_2_5', mode: 't2v', duration: 30, resolution: '480p', ratio: '16:9' },
  { id: 'preset_final', name: 'Bản chốt', oldName: 'Final', model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  { id: 'preset_h3', name: 'H3 từ ảnh', oldName: 'H3 nháp', model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' },
] as const

export function factoryPresets(): Preset[] {
  return FACTORY_PRESETS.map(({ oldName: _old, ...p }) => ({ ...p }))
}

export function renameFactoryPresets(presets: Preset[]): Preset[] {
  let changed = false
  const next = presets.map((p) => {
    const f = FACTORY_PRESETS.find((f) => f.id === p.id)
    if (!f || p.name.trim() !== f.oldName || p.foreignModel || p.foreignSettings ||
      !(['model', 'mode', 'duration', 'resolution', 'ratio'] as const).every((key) => p[key] === f[key])) return p
    changed = true
    return { ...p, name: f.name }
  })
  return changed ? next : presets
}

export function presetNamesMark(raw: unknown, presets: Preset[]): number | undefined {
  const mark = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined
  return mark !== undefined || presets.some((p) => FACTORY_PRESETS.some((f) => f.id === p.id))
    ? Math.max(PRESET_NAMES_VERSION, mark ?? 0) : undefined
}
