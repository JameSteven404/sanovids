import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARRANGE_PREFS_KEY, DEFAULT_ARRANGE_PREFS, parseArrangePrefs, resolveArrange, useArrangePrefs } from '../arrangePrefs'
import { applySettings, currentSettings, readSettingsFile, resetAllSettings, restoreSettings, sanitizeSettings, settingsFileText } from '../settings'

afterEach(() => { useArrangePrefs.getState().reset(); vi.unstubAllGlobals() })
describe('device arrange preferences', () => {
  it('sanitizes garbage by field and keeps separate video choices per style', () => {
    for (const raw of [null, 'null', '[]', 'garbage', '42']) expect(parseArrangePrefs(raw)).toEqual(DEFAULT_ARRANGE_PREFS)
    const p = parseArrangePrefs('{"style":"grid","gridCols":7,"spacing":"bad","videoBy":{"rows":"chosen","grid":"bad"},"scope":"selection"}')
    expect(p).toEqual({ ...DEFAULT_ARRANGE_PREFS, style: 'grid', videoBy: { rows: 'chosen', grid: 'chosen', strip: 'chosen' } })
    useArrangePrefs.getState().set({ style: 'grid', videoBy: { rows: 'chosen', grid: 'all', strip: 'chosen' } })
    expect(resolveArrange(useArrangePrefs.getState())).toMatchObject({ style: 'grid', video: 'all', scope: 'all' })
    useArrangePrefs.getState().set({ style: 'rows' })
    expect(resolveArrange(useArrangePrefs.getState()).video).toBe('chosen')
  })
  it('persists a validated versioned payload and tolerates storage failures', () => {
    const setItem = vi.fn(); vi.stubGlobal('localStorage', { setItem })
    useArrangePrefs.getState().set({ style: 'strip' })
    expect(setItem).toHaveBeenCalledWith(ARRANGE_PREFS_KEY, expect.any(String))
    expect(JSON.parse(setItem.mock.calls[0][1])).toMatchObject({ v: 1, style: 'strip' })
    vi.stubGlobal('localStorage', { setItem() { throw new Error('full') } })
    expect(() => useArrangePrefs.getState().reset()).not.toThrow()
  })
  it('exports, imports, resets and restores with the shared settings flow', () => {
    useArrangePrefs.getState().set({ style: 'grid', gridCols: 4, refs: 'byKind' })
    const saved = currentSettings().arrange
    const read = readSettingsFile(settingsFileText())
    expect(read.ok).toBe(true)
    const backup = resetAllSettings()
    expect(currentSettings().arrange).toEqual(DEFAULT_ARRANGE_PREFS)
    restoreSettings(backup)
    expect(currentSettings().arrange).toEqual(saved)
    useArrangePrefs.getState().reset()
    if (read.ok) applySettings(read.patch)
    expect(currentSettings().arrange).toEqual(saved)
  })
  it('rejects invalid imported values separately without resetting other styles', () => {
    const read = sanitizeSettings({ arrange: { style: 'grid', gridCols: 7, videoBy: { rows: 'chosen', grid: 'oops' }, unknown: true } })
    expect(read).toMatchObject({ patch: { arrange: { style: 'grid', videoBy: { rows: 'chosen' } } }, accepted: 2, rejected: ['arrange.gridCols', 'arrange.videoBy.grid'] })
    applySettings(read.patch)
    expect(useArrangePrefs.getState().videoBy).toEqual({ rows: 'chosen', grid: 'chosen', strip: 'chosen' })
  })
})
