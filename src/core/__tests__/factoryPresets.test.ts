import { describe, expect, it } from 'vitest'
import { FACTORY_PRESETS, factoryPresets, presetNamesMark, renameFactoryPresets } from '../factoryPresets'
import { migrateProject } from '../migrate'
import { defaultPresets, emptyProject, useProject } from '../../store/project'
import type { Preset } from '../types'

const old = (): Preset[] => FACTORY_PRESETS.map(({ oldName, ...p }) => ({ ...p, name: oldName }))

describe('factory preset names', () => {
  it('keeps ids, order and settings; new scenes still use the first preset', () => {
    expect(factoryPresets().map((p) => [p.id, p.name])).toEqual([
      ['preset_draft', 'Bản nháp'], ['preset_final', 'Bản chốt'], ['preset_h3', 'H3 từ ảnh'],
    ])
    expect(defaultPresets()).toEqual(factoryPresets())
    expect(factoryPresets()).not.toBe(factoryPresets())
    const project = emptyProject()
    expect(project.presetNames).toBe(2)
    const before = useProject.getState().project
    try {
      useProject.setState({ project })
      const id = useProject.getState().addScene({})
      expect(useProject.getState().project.scenes.find((s) => s.id === id)).toMatchObject({ presetId: 'preset_draft', settings: { duration: 30, resolution: '480p' } })
    } finally { useProject.setState({ project: before }); useProject.temporal.getState().clear() }
  })
  it('renames only unchanged factories, tolerates surrounding whitespace', () => {
    expect(renameFactoryPresets(old())).toEqual(factoryPresets())
    const presets = old(); presets[1].name = ' Final '
    expect(renameFactoryPresets(presets)[1].name).toBe('Bản chốt')
    for (const patch of [{ id: 'custom' }, { name: 'Final riêng' }, { duration: 10 }, { mode: 'i2v' }, { ratio: '9:16' }, { resolution: '480p' }, { model: 'minimax_h3' }, { foreignModel: 'future' }, { foreignSettings: { mode: 'future' } }]) {
      const unchanged = [{ ...old()[1], ...patch }] as Preset[]
      expect(renameFactoryPresets(unchanged)).toBe(unchanged)
    }
  })
  it('migrates once across load/save/import and keeps scene links and future marks', () => {
    const raw = { ...emptyProject(), presetNames: undefined, presets: old(), scenes: [{ id: 's', presetId: 'preset_final' }] }
    const once = migrateProject(raw)
    expect(once.presets).toEqual(factoryPresets())
    expect(once.presetNames).toBe(2)
    expect(once.scenes[0].presetId).toBe('preset_final')
    expect(migrateProject(JSON.parse(JSON.stringify(once)))).toEqual(once)
    for (const mark of [2, 3]) {
      const next = migrateProject({ ...raw, presetNames: mark })
      expect(next.presetNames).toBe(mark)
      expect(next.presets[1].name).toBe('Final')
    }
  })
  it('does not add markers without factory ids, removes malformed ones, preserves future ones', () => {
    for (const raw of [undefined, 'abc', -1, NaN, Infinity, 1.5]) {
      expect(presetNamesMark(raw, [])).toBeUndefined()
      expect(migrateProject({ ...emptyProject(), presets: [], presetNames: raw })).not.toHaveProperty('presetNames')
      expect(presetNamesMark(raw, old())).toBe(2)
    }
    expect(presetNamesMark(3, [])).toBe(3)
    expect(presetNamesMark(0, [])).toBe(2)
  })
})
