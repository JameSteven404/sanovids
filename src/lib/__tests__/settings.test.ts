// Settings (Cài đặt): every stored pref is validated on read, a settings file is checked value by value, reset puts
// every store back to its default (and Hoàn tác restores it), export → import round-trips, toast time applies.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPanelLayout, restorePanelLayout } from '../../components/common/PanelResizer'
import { DEFAULT_NAME_TEMPLATE } from '../../core/nameTemplate'
import { useProviderPrefs } from '../../providers'
import { DEFAULT_MOCK_SETTINGS, parseMockSettings } from '../../providers/mock'
import { useRuns } from '../../store/runs'
import { isBool, oneOf, parsePref, TOAST_TIMES, useUI } from '../../store/ui'
import { useCanvasPrefs } from '../canvasPrefs'
import { DEFAULT_DOWNLOAD_PREFS, parseDownloadPrefs, useDownloadPrefs } from '../downloads'
import { usePlayback } from '../playback'
import {
  applySettings,
  changedSettingsCount,
  currentSettings,
  DEFAULT_SETTINGS,
  readSettingsFile,
  resetAllSettings,
  restoreSettings,
  sanitizeSettings,
  SETTINGS_FILE_KIND,
  settingsFileText,
} from '../settings'
import { parseThemePref, useTheme } from '../theme'
import { useUpdatePrefs } from '../updatePrefs'

/** In-memory localStorage (the tests run in Node, where there is none). */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size
    },
  }
}

/** A device where the user changed nearly everything. */
const CUSTOM = {
  theme: 'light',
  downloads: { askWhere: false, withPrompt: false, autoDownload: true, zipPrompts: false, nameTemplate: '{take} - {scene}' },
  playback: { sound: false, volume: 0.4, rate: 1.5 },
  canvas: { clickToCut: false, animations: 'off' },
  ui: { edgeMode: 'all', takeDisplay: 'chosen', showMinimap: false, interaction: 'select', toastTime: 'long' },
  mock: { speed: 'slow', failRate: 0.25, concurrency: 1, recordVideo: false },
  updates: { autoDownload: false },
} as const

describe('stored prefs are validated on read', () => {
  it('downloads', () => {
    expect(parseDownloadPrefs(null)).toEqual(DEFAULT_DOWNLOAD_PREFS)
    expect(parseDownloadPrefs('not json')).toEqual(DEFAULT_DOWNLOAD_PREFS)
    expect(parseDownloadPrefs('[true]')).toEqual(DEFAULT_DOWNLOAD_PREFS)
    expect(DEFAULT_DOWNLOAD_PREFS).toMatchObject({ askWhere: true, withPrompt: true, autoDownload: false, zipPrompts: true, nameTemplate: DEFAULT_NAME_TEMPLATE })
    // older versions stored only the first four keys
    expect(parseDownloadPrefs('{"autoDownload":true,"folderName":"Phim","withPrompt":false}')).toEqual({
      ...DEFAULT_DOWNLOAD_PREFS,
      autoDownload: true,
      folderName: 'Phim',
      withPrompt: false,
    })
    expect(parseDownloadPrefs('{"askWhere":"yes","zipPrompts":0,"folderName":"","nameTemplate":"{nope}"}')).toEqual(DEFAULT_DOWNLOAD_PREFS)
    expect(parseDownloadPrefs('{"nameTemplate":"  {take} {scene}  "}').nameTemplate).toBe('{take} {scene}')
  })

  it('ui prefs (wires, take display, minimap, mouse mode, toast time)', () => {
    expect(parsePref('"all"', 'selected', oneOf(['hidden', 'selected', 'all']))).toBe('all')
    expect(parsePref('"banana"', 'selected', oneOf(['hidden', 'selected', 'all']))).toBe('selected')
    expect(parsePref('all', 'selected', oneOf(['hidden', 'selected', 'all']))).toBe('selected') // not JSON
    expect(parsePref(null, true, isBool)).toBe(true)
    expect(parsePref('"false"', true, isBool)).toBe(true)
    expect(parsePref('false', true, isBool)).toBe(false)
    expect(parsePref('"xlong"', 'normal', oneOf(TOAST_TIMES))).toBe('xlong')
  })

  it('demo provider settings are clamped to what Settings offers', () => {
    expect(parseMockSettings(null)).toEqual(DEFAULT_MOCK_SETTINGS)
    expect(parseMockSettings({ speed: 'warp', failRate: 3, concurrency: 99, recordVideo: 'yes' })).toEqual({ ...DEFAULT_MOCK_SETTINGS, failRate: 0.5, concurrency: 5 })
    expect(parseMockSettings({ failRate: -1, concurrency: 0.2 })).toMatchObject({ failRate: 0, concurrency: 1 })
    expect(parseMockSettings({ failRate: Number.NaN }, { ...DEFAULT_MOCK_SETTINGS, failRate: 0.3 }).failRate).toBe(0.3)
  })

  it('theme', () => {
    expect(parseThemePref('"light"')).toBe('light')
    expect(parseThemePref('"pink"')).toBe('system')
    expect(parseThemePref('{')).toBe('system')
    expect(parseThemePref(null)).toBe('system')
  })

  describe('stores starting from broken storage use their defaults', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.resetModules()
    })
    it('ui, downloads, demo provider, canvas', async () => {
      vi.stubGlobal(
        'localStorage',
        memoryStorage({
          'bdp:pref:edgeMode': '"sideways"',
          'bdp:pref:minimap': '"no"',
          'bdp:pref:toastTime': '"forever"',
          'bdp:pref:interaction': '"select"',
          'bdp:pref:leftOpen': '{',
          'bdp:pref:downloads': '{"withPrompt":"nope","askWhere":false,"nameTemplate":"{x}"}',
          'bdp:pref:mock': '{"concurrency":50,"speed":"normal"}',
          'bdp:pref:canvas': '{"animations":"wild"}',
          'bdp:pref:updates': '{"autoDownload":"no"}',
        }),
      )
      vi.resetModules()
      const ui = (await import('../../store/ui')).useUI.getState()
      expect(ui).toMatchObject({ edgeMode: 'selected', showMinimap: true, toastTime: 'normal', interaction: 'select', leftOpen: true })
      const dl = (await import('../downloads')).useDownloadPrefs.getState()
      expect(dl).toMatchObject({ withPrompt: true, askWhere: false, nameTemplate: DEFAULT_NAME_TEMPLATE })
      const runs = (await import('../../store/runs')).useRuns.getState()
      expect(runs.mock).toEqual({ ...DEFAULT_MOCK_SETTINGS, concurrency: 5, speed: 'normal' })
      expect((await import('../canvasPrefs')).useCanvasPrefs.getState().animations).toBe('full')
      expect((await import('../updatePrefs')).useUpdatePrefs.getState().autoDownload).toBe(true)
    })
  })
})

describe('settings file (export / import)', () => {
  it('sanitizeSettings keeps valid values, refuses wrong ones, ignores unknown keys', () => {
    const res = sanitizeSettings({
      theme: 'dark',
      downloads: { withPrompt: false, nameTemplate: ' {take} ', askWhere: 'sometimes', folderName: 'C:\\Phim', extra: 1 },
      playback: { volume: 2, rate: 1.25, sound: false },
      canvas: { animations: 'reduced', clickToCut: 'yes' },
      ui: { edgeMode: 'hidden', toastTime: 'forever' },
      mock: { concurrency: 9, speed: 'slow', failRate: 0.2 },
      future: { anything: true },
    })
    expect(res.patch).toEqual({
      theme: 'dark',
      downloads: { withPrompt: false, nameTemplate: '{take}' },
      playback: { rate: 1.25, sound: false },
      canvas: { animations: 'reduced' },
      ui: { edgeMode: 'hidden' },
      mock: { speed: 'slow', failRate: 0.2 },
    })
    expect(res.accepted).toBe(9)
    expect(res.rejected.sort()).toEqual(['canvas.clickToCut', 'downloads.askWhere', 'mock.concurrency', 'playback.volume', 'ui.toastTime'])
    expect(sanitizeSettings(null)).toEqual({ patch: {}, accepted: 0, rejected: [] })
    // app updates: "Tự động tải bản cập nhật" (not the video auto-download)
    expect(sanitizeSettings({ updates: { autoDownload: 'no' } })).toEqual({ patch: {}, accepted: 0, rejected: ['updates.autoDownload'] })
    expect(sanitizeSettings({ updates: { autoDownload: false, channel: 'beta' } })).toEqual({ patch: { updates: { autoDownload: false } }, accepted: 1, rejected: [] })
    expect(sanitizeSettings({ theme: 'pink', ui: 'all' }).rejected).toEqual(['theme', 'ui'])
  })

  it('readSettingsFile explains what is wrong with a file', () => {
    expect(readSettingsFile('{')).toEqual({ ok: false, error: expect.stringMatching(/JSON/) })
    expect(readSettingsFile('[1,2]')).toEqual({ ok: false, error: expect.stringMatching(/không phải file cài đặt/) })
    expect(readSettingsFile('{"kind":"other"}')).toEqual({ ok: false, error: expect.stringMatching(/không phải file cài đặt/) })
    expect(readSettingsFile('{"id":"p","scenes":[]}')).toEqual({ ok: false, error: expect.stringMatching(/file dự án/) })
    expect(readSettingsFile(JSON.stringify({ kind: SETTINGS_FILE_KIND, version: 1, settings: { theme: 'neon' } }))).toEqual({
      ok: false,
      error: expect.stringMatching(/không có cài đặt nào/),
    })
    // a newer version: what this one knows is still read
    const newer = readSettingsFile(JSON.stringify({ kind: SETTINGS_FILE_KIND, version: 7, settings: { theme: 'light', robots: { on: true } } }))
    expect(newer).toEqual({ ok: true, patch: { theme: 'light' }, accepted: 1, rejected: [] })
  })

  it('export → import gives back exactly the same settings', () => {
    const text = settingsFileText(CUSTOM as never, Date.UTC(2026, 9, 2))
    const parsed = JSON.parse(text)
    expect(parsed).toMatchObject({ kind: SETTINGS_FILE_KIND, version: 1, exportedAt: '2026-10-02T00:00:00.000Z' })
    const read = readSettingsFile(text)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.rejected).toEqual([])
    expect(read.patch).toEqual(CUSTOM)
    // the file never carries the provider, the download folder or projects
    expect(text).not.toMatch(/provider|folderName|scenes/)
  })
})

describe('apply / reset / restore', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage({ 'bdp:hint:storyboard-reorder': '1', 'bdp:pref:leftW': '300' })
    vi.stubGlobal('localStorage', storage)
    applySettings(DEFAULT_SETTINGS)
    useProviderPrefs.getState().setProvider('dev')
  })
  afterEach(() => {
    applySettings(DEFAULT_SETTINGS)
    vi.unstubAllGlobals()
  })

  it('applySettings changes every store and each store saves it', () => {
    applySettings(CUSTOM as never)
    expect(currentSettings()).toEqual(CUSTOM)
    expect(useTheme.getState().pref).toBe('light')
    expect(useUI.getState().toastTime).toBe('long')
    expect(usePlayback.getState().rate).toBe(1.5)
    expect(useCanvasPrefs.getState().animations).toBe('off')
    expect(useRuns.getState().mock.concurrency).toBe(1)
    expect(JSON.parse(storage.data.get('bdp:pref:downloads')!)).toMatchObject({ nameTemplate: '{take} - {scene}', zipPrompts: false })
    expect(storage.data.get('bdp:pref:toastTime')).toBe('"long"')
    expect(storage.data.get('bdp:pref:minimap')).toBe('false')
    expect(storage.data.get('bdp:pref:theme')).toBe('"light"')
    expect(useUpdatePrefs.getState().autoDownload).toBe(false)
    expect(storage.data.get('bdp:pref:updates')).toBe('{"autoDownload":false}')
    expect(changedSettingsCount()).toBeGreaterThan(15)
  })

  it('reset → defaults everywhere (provider back to development mode, tips shown again); Hoàn tác brings it all back', () => {
    applySettings(CUSTOM as never)
    useProviderPrefs.getState().setProvider('canvasapp')
    useDownloadPrefs.getState().set({ folderName: 'Phim' })
    const before = resetAllSettings()
    expect(currentSettings()).toEqual(DEFAULT_SETTINGS)
    expect(changedSettingsCount()).toBe(0)
    expect(useProviderPrefs.getState().provider).toBe('dev')
    expect(storage.data.has('bdp:hint:storyboard-reorder')).toBe(false)
    // the chosen download folder is a place, not a setting: kept
    expect(useDownloadPrefs.getState().folderName).toBe('Phim')
    expect(storage.data.get('bdp:pref:leftW')).toBe('300') // panel widths: resetPanelLayout, not this
    expect(JSON.parse(storage.data.get('bdp:pref:canvas')!)).toEqual({ clickToCut: true, animations: 'full' })
    expect(useUpdatePrefs.getState().autoDownload).toBe(true)
    expect(storage.data.get('bdp:pref:updates')).toBe('{"autoDownload":true}')

    restoreSettings(before)
    expect(currentSettings()).toEqual(CUSTOM)
    expect(useProviderPrefs.getState().provider).toBe('canvasapp')
    useProviderPrefs.getState().setProvider('dev')
    useDownloadPrefs.getState().set({ folderName: null })
  })

  it('changedSettingsCount counts the app-update pref', () => {
    expect(changedSettingsCount()).toBe(0)
    applySettings({ updates: { autoDownload: false } })
    expect(changedSettingsCount()).toBe(1)
    expect(currentSettings().updates).toEqual({ autoDownload: false })
    // distinct from "Tự tải khi video xong"
    expect(currentSettings().downloads.autoDownload).toBe(DEFAULT_SETTINGS.downloads.autoDownload)
  })

  it('an imported file is applied value by value', () => {
    const read = readSettingsFile(JSON.stringify({ kind: SETTINGS_FILE_KIND, version: 1, settings: { downloads: { withPrompt: false }, ui: { toastTime: 'short' } } }))
    expect(read.ok).toBe(true)
    if (read.ok) applySettings(read.patch)
    expect(useDownloadPrefs.getState().withPrompt).toBe(false)
    expect(useDownloadPrefs.getState().askWhere).toBe(true) // untouched
    expect(useUI.getState().toastTime).toBe('short')
  })
})

describe('Thời gian hiện thông báo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useUI.setState({ toasts: [] })
  })
  afterEach(() => {
    useUI.getState().setToastTime('normal')
    vi.useRealTimers()
  })

  it('scales how long a toast stays', () => {
    useUI.getState().setToastTime('long')
    useUI.getState().toast('x')
    vi.advanceTimersByTime(2800)
    expect(useUI.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(2800 * 0.8 + 1)
    expect(useUI.getState().toasts).toHaveLength(0)

    useUI.getState().setToastTime('short')
    useUI.getState().toast('y', { action: { label: 'Hoàn tác', run: () => undefined } })
    vi.advanceTimersByTime(6000 * 0.7 + 1)
    expect(useUI.getState().toasts).toHaveLength(0)
  })

  it('refuses unknown values', () => {
    useUI.getState().setToastTime('forever' as never)
    expect(useUI.getState().toastTime).toBe('normal')
  })
})

describe('Đặt lại bố cục khung bên', () => {
  afterEach(() => {
    useUI.getState().setLeftOpen(true)
    useUI.getState().setRightOpen(true)
    vi.unstubAllGlobals()
  })
  it('shows both side panels at their default widths; Hoàn tác puts the old layout back', () => {
    const storage = memoryStorage({ 'bdp:pref:leftW': '420', 'bdp:pref:rightW': '500' })
    vi.stubGlobal('localStorage', storage)
    useUI.getState().setLeftOpen(false)
    const before = resetPanelLayout()
    expect(before).toEqual({ leftOpen: false, rightOpen: true, leftW: '420', rightW: '500' })
    expect(storage.data.has('bdp:pref:leftW')).toBe(false)
    expect(storage.data.has('bdp:pref:rightW')).toBe(false)
    expect(useUI.getState().leftOpen).toBe(true)
    restorePanelLayout(before)
    expect(storage.data.get('bdp:pref:leftW')).toBe('420')
    expect(storage.data.get('bdp:pref:rightW')).toBe('500')
    expect(useUI.getState().leftOpen).toBe(false)
  })
})
