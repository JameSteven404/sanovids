// Every user preference of this device in one place, for Settings → "Sao lưu & khôi phục": a snapshot of all of them,
// "Khôi phục cài đặt mặc định", and export / import as a small JSON file (validated value by value, so a file from
// another version or edited by hand can never put a store into a broken state).
//
// Each preference still lives in its own store and is saved by it (localStorage, validated on read):
//   theme (lib/theme) · downloads (lib/downloads) · playback (lib/playback) · canvas (lib/canvasPrefs) ·
//   ui (store/ui: wires, take display, minimap, mouse mode, toast time) · mock (store/runs: demo provider) ·
//   updates (lib/updatePrefs: auto-download of app updates).
// Not here on purpose: projects and their settings (autoRenumber travels with the project), the chosen download
// folder (a folder permission cannot be moved to another machine), the canvasapp login, demo credits, panel widths
// (screen-specific; see components/common/PanelResizer resetPanelLayout). The video provider is reset to development mode
// but never imported: a file must not switch the app to a provider that spends real money.
import { checkNameTemplate, DEFAULT_NAME_TEMPLATE } from '../core/nameTemplate'
import type { EdgeMode } from '../core/types'
import { DEFAULT_MOCK_SETTINGS, parseMockSettings, type MockSettings } from '../providers/mock'
import { useProviderPrefs, type ProviderId } from '../providers'
import { useRuns } from '../store/runs'
import { EDGE_MODES, INTERACTION_MODES, TAKE_DISPLAYS, TOAST_TIMES, useUI, type InteractionMode, type TakeDisplay, type ToastTime } from '../store/ui'
import { DEFAULT_CANVAS_PREFS, MOTION_LEVELS, useCanvasPrefs, type MotionLevel } from './canvasPrefs'
import { DEFAULT_DOWNLOAD_PREFS, useDownloadPrefs } from './downloads'
import { PLAYBACK_RATES, usePlayback } from './playback'
import { isThemePref, useTheme, type ThemePref } from './theme'
import { DEFAULT_UPDATE_PREFS, useUpdatePrefs } from './updatePrefs'

export interface PortableSettings {
  theme: ThemePref
  downloads: { askWhere: boolean; withPrompt: boolean; autoDownload: boolean; zipPrompts: boolean; nameTemplate: string }
  playback: { sound: boolean; volume: number; rate: number }
  canvas: { clickToCut: boolean; animations: MotionLevel }
  ui: { edgeMode: EdgeMode; takeDisplay: TakeDisplay; showMinimap: boolean; interaction: InteractionMode; toastTime: ToastTime }
  mock: MockSettings
  updates: { autoDownload: boolean }
}

/** Some settings (what a file or a reset changes). */
export type SettingsPatch = { theme?: ThemePref } & { [K in Exclude<keyof PortableSettings, 'theme'>]?: Partial<PortableSettings[K]> }

export const DEFAULT_SETTINGS: PortableSettings = {
  theme: 'system',
  downloads: {
    askWhere: DEFAULT_DOWNLOAD_PREFS.askWhere,
    withPrompt: DEFAULT_DOWNLOAD_PREFS.withPrompt,
    autoDownload: DEFAULT_DOWNLOAD_PREFS.autoDownload,
    zipPrompts: DEFAULT_DOWNLOAD_PREFS.zipPrompts,
    nameTemplate: DEFAULT_NAME_TEMPLATE,
  },
  playback: { sound: true, volume: 1, rate: 1 },
  canvas: { ...DEFAULT_CANVAS_PREFS },
  ui: { edgeMode: 'selected', takeDisplay: 'all', showMinimap: true, interaction: 'hand', toastTime: 'normal' },
  mock: { ...DEFAULT_MOCK_SETTINGS },
  updates: { autoDownload: DEFAULT_UPDATE_PREFS.autoDownload },
}

/** Every setting as it is now. */
export function currentSettings(): PortableSettings {
  const d = useDownloadPrefs.getState()
  const p = usePlayback.getState()
  const c = useCanvasPrefs.getState()
  const u = useUI.getState()
  return {
    theme: useTheme.getState().pref,
    downloads: { askWhere: d.askWhere, withPrompt: d.withPrompt, autoDownload: d.autoDownload, zipPrompts: d.zipPrompts, nameTemplate: d.nameTemplate },
    playback: { sound: p.sound, volume: p.volume, rate: p.rate },
    canvas: { clickToCut: c.clickToCut, animations: c.animations },
    ui: { edgeMode: u.edgeMode, takeDisplay: u.takeDisplay, showMinimap: u.showMinimap, interaction: u.interaction, toastTime: u.toastTime },
    mock: { ...useRuns.getState().mock },
    updates: { autoDownload: useUpdatePrefs.getState().autoDownload },
  }
}

// ---------------- validation (pure) ----------------
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const inList =
  <T extends string | number>(list: readonly T[]) =>
  (v: unknown): v is T =>
    (list as readonly unknown[]).includes(v)
const isVolume = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const isTemplate = (v: unknown): v is string => checkNameTemplate(v).ok

type Check = (v: unknown) => boolean
const RULES: { [K in Exclude<keyof PortableSettings, 'theme' | 'mock'>]: Record<keyof PortableSettings[K], Check> } = {
  downloads: { askWhere: isBool, withPrompt: isBool, autoDownload: isBool, zipPrompts: isBool, nameTemplate: isTemplate },
  playback: { sound: isBool, volume: isVolume, rate: inList(PLAYBACK_RATES) },
  canvas: { clickToCut: isBool, animations: inList(MOTION_LEVELS) },
  ui: { edgeMode: inList(EDGE_MODES), takeDisplay: inList(TAKE_DISPLAYS), showMinimap: isBool, interaction: inList(INTERACTION_MODES), toastTime: inList(TOAST_TIMES) },
  updates: { autoDownload: isBool },
}
const MOCK_RULES: Record<keyof MockSettings, Check> = {
  speed: (v) => parseMockSettings({ speed: v }).speed === v,
  failRate: (v) => typeof v === 'number' && parseMockSettings({ failRate: v }).failRate === v,
  concurrency: (v) => typeof v === 'number' && parseMockSettings({ concurrency: v }).concurrency === v,
  recordVideo: isBool,
}

export interface SanitizedSettings {
  /** The valid values only. */
  patch: SettingsPatch
  /** How many values were taken. */
  accepted: number
  /** "group.key" of the values that were refused (wrong type / out of range / unknown option). */
  rejected: string[]
}

/**
 * Untrusted settings (an imported file) → the values that are valid. Unknown groups and keys are ignored (a file
 * from a newer version still imports what this one knows); a wrong value is refused, never "fixed" by guessing.
 */
export function sanitizeSettings(input: unknown): SanitizedSettings {
  const patch: SettingsPatch = {}
  const rejected: string[] = []
  let accepted = 0
  if (!isObj(input)) return { patch, accepted, rejected }
  if ('theme' in input) {
    if (isThemePref(input.theme)) {
      patch.theme = input.theme
      accepted++
    } else rejected.push('theme')
  }
  const groups: [keyof SettingsPatch, Record<string, Check>][] = [...Object.entries(RULES), ['mock', MOCK_RULES]] as [keyof SettingsPatch, Record<string, Check>][]
  for (const [group, rules] of groups) {
    const src = input[group]
    if (src === undefined) continue
    if (!isObj(src)) {
      rejected.push(group)
      continue
    }
    const out: Record<string, unknown> = {}
    for (const [key, ok] of Object.entries(rules)) {
      if (!(key in src)) continue
      let value = src[key]
      if (group === 'downloads' && key === 'nameTemplate' && typeof value === 'string') value = value.trim()
      if (ok(value)) {
        out[key] = value
        accepted++
      } else rejected.push(`${group}.${key}`)
    }
    if (Object.keys(out).length) (patch as Record<string, unknown>)[group] = out
  }
  return { patch, accepted, rejected }
}

// ---------------- applying ----------------
/** Apply some settings to their stores (each store saves its own; every value is checked again there). */
export function applySettings(patch: SettingsPatch): void {
  if (patch.theme) useTheme.getState().setPref(patch.theme)
  if (patch.downloads) useDownloadPrefs.getState().set(patch.downloads)
  if (patch.playback) {
    const p = usePlayback.getState()
    if (patch.playback.sound !== undefined) p.setSound(patch.playback.sound)
    if (patch.playback.volume !== undefined) p.setVolume(patch.playback.volume)
    if (patch.playback.rate !== undefined) p.setRate(patch.playback.rate)
  }
  if (patch.canvas) useCanvasPrefs.getState().set(patch.canvas)
  if (patch.ui) {
    const u = useUI.getState()
    if (patch.ui.edgeMode !== undefined) u.setEdgeMode(patch.ui.edgeMode)
    if (patch.ui.takeDisplay !== undefined) u.setTakeDisplay(patch.ui.takeDisplay)
    if (patch.ui.showMinimap !== undefined) u.setMinimap(patch.ui.showMinimap)
    if (patch.ui.interaction !== undefined) u.setInteraction(patch.ui.interaction)
    if (patch.ui.toastTime !== undefined) u.setToastTime(patch.ui.toastTime)
  }
  if (patch.mock) useRuns.getState().setMock(patch.mock)
  if (patch.updates) useUpdatePrefs.getState().set(patch.updates)
}

/** What a reset / import changed, to put it back with "Hoàn tác". */
export interface SettingsBackup {
  settings: PortableSettings
  provider: ProviderId
}

export function backupSettings(): SettingsBackup {
  return { settings: currentSettings(), provider: useProviderPrefs.getState().provider }
}

export function restoreSettings(backup: SettingsBackup): void {
  applySettings(backup.settings)
  if (useProviderPrefs.getState().provider !== backup.provider) useProviderPrefs.getState().setProvider(backup.provider)
}

/** Keys of one-time tips ("Đã hiểu"): a reset shows them again. */
const HINT_PREFIX = 'bdp:hint:'

/**
 * "Khôi phục cài đặt mặc định": every setting above back to its default, the video provider back to development mode, the
 * one-time tips shown again. Projects, videos, folders and the canvasapp login are not touched. Returns the backup.
 */
export function resetAllSettings(): SettingsBackup {
  const before = backupSettings()
  applySettings(DEFAULT_SETTINGS)
  if (useProviderPrefs.getState().provider !== 'dev') useProviderPrefs.getState().setProvider('dev')
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(HINT_PREFIX)) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    /* storage unavailable */
  }
  return before
}

/** Number of settings that differ from the defaults (shown next to "Khôi phục cài đặt mặc định"). */
export function changedSettingsCount(s: PortableSettings = currentSettings()): number {
  let n = s.theme === DEFAULT_SETTINGS.theme ? 0 : 1
  for (const group of ['downloads', 'playback', 'canvas', 'ui', 'mock', 'updates'] as const) {
    const cur = s[group] as Record<string, unknown>
    const def = DEFAULT_SETTINGS[group] as Record<string, unknown>
    for (const k of Object.keys(def)) if (cur[k] !== def[k]) n++
  }
  return n
}

// ---------------- file ----------------
export const SETTINGS_FILE_KIND = 'sanovids-settings'
export const SETTINGS_FILE_VERSION = 1
export const SETTINGS_FILE_NAME = 'SanoVids - cài đặt.json'

/** Text of a settings file. */
export function settingsFileText(settings: PortableSettings = currentSettings(), now = Date.now()): string {
  return JSON.stringify({ kind: SETTINGS_FILE_KIND, version: SETTINGS_FILE_VERSION, exportedAt: new Date(now).toISOString(), settings }, null, 2)
}

export type SettingsFileRead = ({ ok: true } & SanitizedSettings) | { ok: false; error: string }

/** Read a settings file (text). Nothing is applied here. */
export function readSettingsFile(text: string): SettingsFileRead {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'File không đọc được (không phải JSON).' }
  }
  if (!isObj(data)) return { ok: false, error: 'File không phải file cài đặt SanoVids.' }
  if (data.kind !== SETTINGS_FILE_KIND) {
    if ('scenes' in data || 'project' in data) return { ok: false, error: 'Đây là file dự án — mở nó ở mục “Dữ liệu dự án” (Nhập file .sanovids.json).' }
    return { ok: false, error: 'File không phải file cài đặt SanoVids.' }
  }
  const read = sanitizeSettings(data.settings)
  if (!read.accepted) return { ok: false, error: 'Trong file không có cài đặt nào dùng được.' }
  return { ok: true, ...read }
}
