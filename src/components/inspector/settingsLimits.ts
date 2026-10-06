// What the settings fields of the inspector (one scene or many) make of what the gateway runs right now
// (providers SettingsLimits = /api/video-profiles, through the rule of the submit check: canvasapp mapping.profileIssues).
// Pure, no React, no stores — tested in __tests__/inspector.test.ts.
//
//   'none'      not read (logged out, never asked, old demo): no limits, the static " · chỉ SD 2.5" notes only.
//   'server'    a firm read: what it refuses is disabled ('off', with the reason) — never hidden, never changed in the
//               scene; an older read counts as a guess until read again.
//   'fallback'  could not be read (canvasapp's built-in profiles): only marked 'risky' ("có thể bị từ chối").
// A value counts as refused only when EVERY selected settings that offers it would be refused on that field (a locked
// model does not lock its durations); otherwise it stays pickable and the note names the models it fits.
import { MODELS, normalizeSettings } from '../../core/models'
import type { ModelId, VideoSettings } from '../../core/types'
import type { LimitField, LimitsInfo, RefreshLimitsResult, SettingsLimits } from '../../providers/types'

export type OptionState = 'ok' | 'off' | 'risky'

export interface OptionLimit {
  state: OptionState
  /** The first refusal text ('' when none). */
  reason: string
  /** Models of the selection for which the value is fine (offered by SanoVids and not refused). */
  okModels: ModelId[]
}

export interface LimitsSiteName {
  short: string
  full: string
}

const KEY_SEP = '|'
const keyOf = (s: VideoSettings) => [s.model, s.mode, s.duration, s.resolution, s.ratio].join(KEY_SEP)

/** A string naming the distinct settings of `list` (memo key: 100 selected scenes usually collapse to a few). */
export function settingsListKey(list: readonly VideoSettings[]): string {
  return [...new Set(list.map(keyOf))].join('\n')
}

/** The distinct settings of `list`, in first-seen order. */
export function uniqueSettings(list: readonly VideoSettings[]): VideoSettings[] {
  const seen = new Map<string, VideoSettings>()
  for (const s of list) {
    const k = keyOf(s)
    if (!seen.has(k)) seen.set(k, s)
  }
  return [...seen.values()]
}

/** Does SanoVids' own model table offer `value` of `field` for `model` (the option exists for it at all)? */
export function offeredBy(model: ModelId, field: LimitField, value: string | number): boolean {
  const spec = MODELS[model]
  if (!spec) return false
  switch (field) {
    case 'model':
      return !!MODELS[value as ModelId]
    case 'mode':
      return (spec.modes as string[]).includes(String(value))
    case 'duration':
      return spec.durations.includes(Number(value))
    case 'resolution':
      return spec.resolutions.includes(String(value))
    case 'ratio':
      return spec.ratios.includes(String(value))
  }
}

/** Why picking `value` for `field` on settings `s` would be refused — only that field counts — or null. */
export function fieldBlock(limits: SettingsLimits, s: VideoSettings, field: LimitField, value: string | number): string | null {
  if (limits.source === 'none') return null
  const next = normalizeSettings({ ...s, [field]: value })
  return limits.issues(next).find((i) => i.field === field)?.reason ?? null
}

const uniq = <T,>(list: T[]): T[] => [...new Set(list)]

/** The state of one option for the selection (`list` = uniqueSettings of the selected scenes). */
export function optionLimit(limits: SettingsLimits, list: readonly VideoSettings[], field: LimitField, value: string | number): OptionLimit {
  const offering = list.filter((s) => offeredBy(s.model, field, value))
  if (limits.source === 'none' || !offering.length) return { state: 'ok', reason: '', okModels: uniq(offering.map((s) => s.model)) }
  const reasons = offering.map((s) => fieldBlock(limits, s, field, value))
  const okModels = uniq(offering.filter((_, i) => !reasons[i]).map((s) => s.model))
  const blocked = reasons.every((r) => !!r)
  return {
    state: !blocked ? 'ok' : limits.source === 'server' && limits.firm ? 'off' : 'risky',
    reason: reasons.find((r) => !!r) ?? '',
    okModels,
  }
}

/** A preset (its whole settings): refused somewhere → 'off' / 'risky' with the first reason. Presets stay pickable. */
export function presetLimit(limits: SettingsLimits, p: Partial<VideoSettings> & { model: ModelId }): OptionLimit {
  const s = normalizeSettings(p)
  const issue = limits.source === 'none' ? undefined : limits.issues(s)[0]
  if (!issue) return { state: 'ok', reason: '', okModels: [s.model] }
  return { state: limits.source === 'server' && limits.firm ? 'off' : 'risky', reason: issue.reason, okModels: [] }
}

/** Only an option that is not selected and not refused can be picked (a refused one is aria-disabled, not removed). */
export const segmentPickable = (on: boolean, lim: Pick<OptionLimit, 'state'>): boolean => !on && lim.state !== 'off'

/** Suffix of an option label: " · canvasapp đang tắt" / " · có thể bị từ chối" (a native select hides tooltips). */
export function optionTag(lim: Pick<OptionLimit, 'state'>, site: LimitsSiteName): string {
  return lim.state === 'off' ? ` · ${site.short} đang tắt` : lim.state === 'risky' ? ' · có thể bị từ chối' : ''
}

/** " · chỉ H3" when only some of the selection's models can use the value ('' otherwise). */
export function partialNote(lim: OptionLimit, models: readonly ModelId[]): string {
  if (models.length < 2 || lim.state !== 'ok' || !lim.okModels.length || lim.okModels.length >= models.length) return ''
  return ` · chỉ ${lim.okModels.map((m) => MODELS[m]?.short ?? m).join(', ')}`
}

/** Tooltip of an option / segment. */
export function optionTitle(label: string, value: string, lim: OptionLimit, site: LimitsSiteName, partial = ''): string {
  if (lim.state === 'off') return `${label}: ${value} — ${site.short} đang tắt: ${lim.reason}`
  if (lim.state === 'risky') return `${label}: ${value} — có thể bị từ chối khi gửi (không tốn credit): ${lim.reason}`
  return `${label}: ${value}${partial}`
}

/**
 * May a batch settings change go to a scene with settings `s`? Not when a firm read refuses the result on a field the
 * patch sets (the scene keeps its value — never clamped to another). A guess never holds a scene back; a model change
 * is never held back here (its option is disabled when refused).
 */
export function patchFitsLimits(s: VideoSettings, patch: Partial<VideoSettings>, limits: SettingsLimits): boolean {
  if (patch.model !== undefined || limits.source !== 'server' || !limits.firm) return true
  const fields = Object.keys(patch) as LimitField[]
  return !limits.issues(normalizeSettings({ ...s, ...patch })).some((i) => fields.includes(i.field))
}

export interface SelectionIssues {
  /** A firm read: these scenes cannot run (skipped by the queue, Run buttons off). */
  sure: boolean
  /** How many of the given scenes have refused settings. */
  count: number
  /** Their codes (S03…), when given. */
  codes: string[]
  /** The refusal texts, de-duplicated, in order. */
  reasons: string[]
}

/** The scenes whose CURRENT settings the gateway refuses (null when none, or nothing is known). */
export function selectionIssues(limits: SettingsLimits, scenes: readonly { settings: VideoSettings; code?: string }[]): SelectionIssues | null {
  if (limits.source === 'none') return null
  const byKey = new Map<string, string[]>()
  const reasons: string[] = []
  const codes: string[] = []
  let count = 0
  for (const sc of scenes) {
    const k = keyOf(sc.settings)
    let found = byKey.get(k)
    if (!found) {
      found = limits.issues(sc.settings).map((i) => i.reason)
      byKey.set(k, found)
    }
    if (!found.length) continue
    count++
    if (sc.code) codes.push(sc.code)
    for (const r of found) if (!reasons.includes(r)) reasons.push(r)
  }
  if (!count) return null
  return { sure: limits.source === 'server' && limits.firm, count, codes, reasons }
}

/** "14:05" (local time). */
export function clockTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The toast after "Đọc lại" (refreshProviderLimits force). `login`: offer the gateway's login. */
export function refreshToast(result: RefreshLimitsResult, site: LimitsSiteName, info: Pick<LimitsInfo, 'at'>): { text: string; tone: 'success' | 'info' | 'warning' | 'error'; login?: true } {
  const when = info.at !== null ? ` lúc ${clockTime(info.at)}` : ''
  switch (result) {
    case 'read':
      return { text: `Đã đọc lại cấu hình model từ ${site.short}.`, tone: 'success' }
    case 'fresh':
      return { text: `Cấu hình model vừa được đọc${when} — chưa cần đọc lại.`, tone: 'info' }
    case 'kept':
      return { text: `Không đọc lại được cấu hình model từ ${site.short} — vẫn dùng lần đọc${when}.`, tone: 'warning' }
    case 'failed':
      return { text: `Không đọc được cấu hình model từ ${site.short} — tạm theo cấu hình mặc định như trang canvasapp (MiniMax-H3 tạm khoá).`, tone: 'error' }
    case 'login':
      return { text: `Chưa đăng nhập ${site.full} — đăng nhập để đọc cấu hình model.`, tone: 'warning', login: true }
    case 'unavailable':
      return { text: 'Không đọc được cấu hình model: cổng canvasapp chỉ dùng được trong bản desktop SanoVids.', tone: 'warning' }
  }
}

/**
 * The toast of a batch settings change some scenes did not take: `byModel` = how many of the `skipped` ones lack the
 * value in their model (patchFits), the rest were held back because the gateway refuses it for them (patchFitsLimits).
 */
export function batchSkipText(label: string, applied: number, skippedCodes: readonly string[], byModel: number, site: LimitsSiteName): string {
  const n = skippedCodes.length
  const list = skippedCodes.slice(0, 4).join(', ') + (n > 4 ? '…' : '')
  const refused = n - byModel
  const why =
    refused <= 0 ? 'có model không hỗ trợ' : byModel > 0 ? `có model không hỗ trợ hoặc bị ${site.short} tắt giá trị này` : `bị ${site.short} tắt giá trị này`
  return `${label} chỉ áp dụng cho ${applied} cảnh — giữ nguyên ${n} cảnh ${why} (${list}).`
}
