// Takes imported with "Nhập job" (their job was made on canvasapp's own page, see providers/canvasapp/siteJobs.ts):
// how every place shows what such a take does not know for sure. Pure (no React, no stores) — tested in
// __tests__/importedTake.test.ts. An `unknown` field holds a placeholder: shown "?", never restored, cost "—"; an
// `inferred` one comes from the bridge node whose prompt matched the job: shown "≈", never restored as a setting.
// Takes SanoVids made itself (no `imported`) read exactly as before.
import { modeLabel, normalizeSettings } from '../../core/models'
import type { ImportedField, Take, VideoSettings } from '../../core/types'

type ImportInfo = Pick<Take, 'imported'> & Partial<Pick<Take, 'provider'>>

/** Where an imported take's job was made: "canvasapp giả lập" (development mode) or "canvasapp.io.vn". */
export const importSite = (t: Partial<Pick<Take, 'provider'>>) => (t.provider === 'dev' ? 'canvasapp giả lập' : 'canvasapp.io.vn')

export const FIELD_LABEL: Record<ImportedField, string> = {
  mode: 'chế độ',
  resolution: 'độ phân giải',
  duration: 'thời lượng',
  ratio: 'tỉ lệ khung',
  prompt: 'prompt',
  refs: 'ảnh tham chiếu',
}

/** Tooltips of a "?" / "≈" value. */
export const UNKNOWN_FIELD_TITLE = 'canvasapp không cho biết — không rõ'
export const INFERRED_FIELD_TITLE = 'Đoán theo node trên canvas cầu nối (prompt khớp với job) — không chắc chắn'

export type FieldState = 'known' | 'inferred' | 'unknown'

export function fieldState(t: ImportInfo, f: ImportedField): FieldState {
  if (!t.imported) return 'known'
  if (t.imported.unknown.includes(f)) return 'unknown'
  return t.imported.inferred.includes(f) ? 'inferred' : 'known'
}

const shown = (t: ImportInfo, f: ImportedField, value: string): string => {
  const s = fieldState(t, f)
  return s === 'unknown' ? '?' : s === 'inferred' ? `≈${value}` : value
}

/** settingsLabel ("15s · 1080P · 16:9") with "?" for what an imported take does not know and "≈" for a guess. */
export function takeSettingsText(t: Pick<Take, 'settings' | 'imported'>): string {
  const s = t.settings
  return `${shown(t, 'duration', `${s.duration}s`)} · ${shown(t, 'resolution', s.resolution.toUpperCase())} · ${shown(t, 'ratio', s.ratio)}`
}

/** "15s" / "?s" / "≈15s" (the sidebar's take badge). */
export function takeDurationText(t: Pick<Take, 'settings' | 'imported'>): string {
  const s = fieldState(t, 'duration')
  return s === 'unknown' ? '?s' : s === 'inferred' ? `≈${t.settings.duration}s` : `${t.settings.duration}s`
}

/** The mode's name for a take ("Khung đầu → cuối"); "chế độ ?" when an imported take does not know it. */
export function takeModeText(t: Pick<Take, 'settings' | 'imported'>): string {
  const label = modeLabel(t.settings.mode, t.settings.model)
  return shown(t, 'mode', label).replace(/^\?$/, 'chế độ ?')
}

/** The take's cost, or null when it is not known (an imported take whose resolution / duration canvasapp did not say). */
export function takeCostKnown(t: Pick<Take, 'cost' | 'imported'>): number | null {
  if (t.imported && (t.imported.unknown.includes('resolution') || t.imported.unknown.includes('duration'))) return null
  return t.cost
}

/** The cost of an imported take rests on a guess (inferred resolution / duration): shown "≈" in every mode. */
export function takeCostInferred(t: Pick<Take, 'imported'>): boolean {
  return !!t.imported && (t.imported.inferred.includes('resolution') || t.imported.inferred.includes('duration'))
}

/**
 * Settings of an imported take as the scene may take them back ("Khôi phục prompt này"): its known fields; the scene's
 * own value for anything unknown or only inferred (`kept`). Takes SanoVids made: their settings as they are.
 */
export function restorableSettings(t: Pick<Take, 'settings' | 'imported'>, scene: VideoSettings): { settings: VideoSettings; kept: ImportedField[] } {
  if (!t.imported) return { settings: t.settings, kept: [] }
  const kept = (['mode', 'resolution', 'duration', 'ratio'] as const).filter((f) => fieldState(t, f) !== 'known')
  const next: VideoSettings = { ...t.settings }
  for (const f of kept) (next as unknown as Record<string, unknown>)[f] = scene[f]
  return { settings: normalizeSettings(next), kept }
}

/**
 * Why "Khôi phục prompt này" cannot put this take back (null = it can): an imported take whose prompt or references
 * canvasapp did not tell (restoring would write "" / drop the scene's references).
 */
export function restoreBlock(t: ImportInfo): string | null {
  if (!t.imported) return null
  const missing = (['prompt', 'refs'] as const).filter((f) => fieldState(t, f) === 'unknown').map((f) => FIELD_LABEL[f])
  return missing.length ? `Take nhập từ canvasapp: không rõ ${missing.join(' / ')} lúc tạo — không khôi phục được.` : null
}

/** What the restore toast adds for an imported take: settings kept from the scene, references taken from the node. */
export function restoreNotes(t: ImportInfo, kept: readonly ImportedField[]): string[] {
  if (!t.imported) return []
  const out: string[] = []
  if (kept.length) out.push(`giữ ${kept.map((f) => FIELD_LABEL[f]).join(', ')} của cảnh (không rõ lúc tạo)`)
  if (fieldState(t, 'refs') === 'inferred') out.push('ảnh tham chiếu theo node trên canvas cầu nối — hãy kiểm tra')
  return out
}

/** "Không rõ: độ phân giải, ảnh tham chiếu · đoán: chế độ" — or null when the take knows everything. */
export function importedFieldsNote(t: ImportInfo): string | null {
  if (!t.imported) return null
  const parts: string[] = []
  if (t.imported.unknown.length) parts.push(`không rõ: ${t.imported.unknown.map((f) => FIELD_LABEL[f]).join(', ')}`)
  if (t.imported.inferred.length) parts.push(`đoán theo node: ${t.imported.inferred.map((f) => FIELD_LABEL[f]).join(', ')}`)
  return parts.length ? parts.join(' · ') : null
}

const clock = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}/${p(d.getMonth() + 1)}`
}

/** "Tạo trên canvasapp.io.vn (phiên “SanoVids bridge”), nhập vào SanoVids lúc 14:32 06/10 · tên job: …" */
export function importedSourceText(t: ImportInfo): string | null {
  if (!t.imported) return null
  const name = t.imported.jobName ? ` · tên job: ${t.imported.jobName}` : ''
  return `Tạo trên ${importSite(t)} (phiên “SanoVids bridge”), nhập vào SanoVids lúc ${clock(t.imported.at)}${name}`
}

/** Tooltip of the "nhập" chip (queue row, take node). */
export function importedChipTitle(t: ImportInfo): string {
  return t.imported ? `Job tạo trên ${importSite(t)} (ngoài SanoVids), nhập lúc ${clock(t.imported.at)} — “Chạy lại” tạo take mới (trừ credit như thường)` : ''
}
