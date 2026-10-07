// Takes imported with "Nhập job" (their job was made on canvasapp's own page, see providers/canvasapp/siteJobs.ts):
// how every place shows what such a take does not know for sure. Pure (no React, no stores) — tested in
// __tests__/importedTake.test.ts. An `unknown` field holds a placeholder: shown "?", never restored, cost "—"; an
// `inferred` one comes from the bridge node whose prompt matched the job: shown "≈", never restored as a setting
// (except the mode that goes with references restored from that node: restorePlan).
// Takes SanoVids made itself (no `imported`) read exactly as before.
import { MODELS, modeLabel, normalizeSettings, usesRefs } from '../../core/models'
import type { ImportedField, Scene, Take, VideoSettings } from '../../core/types'

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
export const unknownFieldTitle = (t: Partial<Pick<Take, 'provider'>>) => `${importSite(t)} không cho biết — không rõ`
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

/**
 * The total length of these takes (the Storyboard's ★ runtime): `guessed` when one of them is an imported take that
 * does not know its duration for sure (a placeholder, or only inferred) — the total is then shown "≈".
 */
export function takesRuntime(takes: readonly Pick<Take, 'settings' | 'imported'>[]): { seconds: number; guessed: boolean } {
  let seconds = 0
  let guessed = false
  for (const t of takes) {
    seconds += t.settings.duration
    if (fieldState(t, 'duration') !== 'known') guessed = true
  }
  return { seconds, guessed }
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

/** What "Khôi phục prompt này" puts back from a take (restorePlan). */
export interface RestorePlan {
  /** What restoredFromTake (components/runs/restore.ts) rebuilds the prompt and the references from. */
  source: Pick<Take, 'rawPromptSnapshot' | 'refsSnapshot' | 'videoRefsSnapshot'> & { imageKeysSnapshot?: readonly string[] }
  settings: VideoSettings
  /** Settings the scene keeps (an imported take does not know them for sure: unknown, or only inferred). */
  kept: ImportedField[]
  /**
   * ...the same, but the scene's value does not exist for the take's model: that model's default is set (it may be the
   * very placeholder the take shows "?" for) — never said to be the scene's.
   */
  defaulted: ImportedField[]
  /** Inferred settings restored anyway: the mode the references taken from the node were sent with. */
  guessed: ImportedField[]
  /** The take tells nothing about the scene's reference images (its job sent none): the scene keeps its own. */
  keepRefs: boolean
}

/**
 * "Khôi phục prompt này": takes SanoVids made come back as they ran (prompt, references, @video references, settings).
 * An imported take (restoreBlock first) restores its prompt and its known settings; the scene keeps its own value for
 * anything unknown or merely inferred (`kept`; when the take's model has no such value, its default: `defaulted`) and
 * its @video references (canvasapp sends none, the take knows nothing
 * of them). References and mode go together: when the job sent reference images (usesRefs of the take's settings),
 * the ones read from the bridge node are restored WITH the mode they need, even an inferred one (`guessed`) — a kept
 * Text → Video would leave them unsent; when it sent none (MiniMax-H3 Text → Video / Khung đầu → cuối, maybe only
 * guessed) the scene keeps its references (`keepRefs`) — never emptied for a mode it may not even use. Frames are
 * never restored (like any take).
 */
export function restorePlan(
  t: Pick<Take, 'settings' | 'imported' | 'rawPromptSnapshot' | 'refsSnapshot' | 'videoRefsSnapshot' | 'imageKeysSnapshot'>,
  scene: Pick<Scene, 'settings' | 'refs' | 'videoRefs'>,
): RestorePlan {
  if (!t.imported) return { source: t, settings: t.settings, kept: [], defaulted: [], guessed: [], keepRefs: false }
  const keepRefs = !usesRefs(t.settings)
  const guessed: ImportedField[] = !keepRefs && fieldState(t, 'mode') === 'inferred' ? ['mode'] : []
  const notKnown = (['mode', 'resolution', 'duration', 'ratio'] as const).filter((f) => fieldState(t, f) !== 'known' && !guessed.includes(f))
  const next: VideoSettings = { ...t.settings }
  for (const f of notKnown) (next as unknown as Record<string, unknown>)[f] = scene.settings[f]
  const settings = normalizeSettings(next)
  // what normalizeSettings changed (the take's model has no such value) is that model's default, not the scene's
  const kept = notKnown.filter((f) => settings[f] === scene.settings[f])
  const defaulted = notKnown.filter((f) => settings[f] !== scene.settings[f])
  // the scene's own lists as the "snapshot" of what the take does not know: restored as they are, nothing renumbered
  const source: RestorePlan['source'] = keepRefs
    ? { rawPromptSnapshot: t.rawPromptSnapshot, refsSnapshot: [...scene.refs], videoRefsSnapshot: [...scene.videoRefs] }
    : { rawPromptSnapshot: t.rawPromptSnapshot, refsSnapshot: t.refsSnapshot, videoRefsSnapshot: [...scene.videoRefs], ...(t.imageKeysSnapshot ? { imageKeysSnapshot: t.imageKeysSnapshot } : {}) }
  return { source, settings, kept, defaulted, guessed, keepRefs }
}

/**
 * Why "Khôi phục prompt này" cannot put this take back (null = it can): an imported take whose prompt or references
 * canvasapp did not tell (restoring would write "" / leave tokens pointing at unknown pictures).
 */
export function restoreBlock(t: ImportInfo): string | null {
  if (!t.imported) return null
  const missing = (['prompt', 'refs'] as const).filter((f) => fieldState(t, f) === 'unknown').map((f) => FIELD_LABEL[f])
  return missing.length ? `Take nhập từ ${importSite(t)}: không rõ ${missing.join(' / ')} lúc tạo — không khôi phục được.` : null
}

/** What the restore toast adds for an imported take: what the scene kept and why, what was only a guess. */
export function restoreNotes(t: Pick<Take, 'settings' | 'imported'>, plan: Pick<RestorePlan, 'kept' | 'defaulted' | 'guessed' | 'keepRefs'>): string[] {
  if (!t.imported) return []
  const out: string[] = []
  const labels = (fs: readonly ImportedField[]) => fs.map((f) => FIELD_LABEL[f]).join(', ')
  const unknownKept = plan.kept.filter((f) => fieldState(t, f) === 'unknown')
  const inferredKept = plan.kept.filter((f) => fieldState(t, f) === 'inferred')
  if (unknownKept.length) out.push(`giữ ${labels(unknownKept)} của cảnh (không rõ lúc tạo)`)
  if (inferredKept.length) out.push(`giữ ${labels(inferredKept)} của cảnh (chỉ đoán được lúc tạo)`)
  // the scene's value does not exist for the take's model: its default was set — said so, never "giữ … của cảnh"
  const model = MODELS[t.settings.model]?.name ?? t.settings.model
  for (const [state, why] of [
    ['unknown', 'không rõ lúc tạo'],
    ['inferred', 'chỉ đoán được lúc tạo'],
  ] as const) {
    const fs = plan.defaulted.filter((f) => fieldState(t, f) === state)
    if (fs.length) out.push(`đặt ${labels(fs)} mặc định của ${model} (${why}; giá trị của cảnh không có ở model này) — hãy kiểm tra`)
  }
  if (plan.keepRefs) out.push(`giữ ảnh tham chiếu của cảnh (job ${takeModeText(t)} không gửi ảnh tham chiếu)`)
  else if (fieldState(t, 'refs') === 'inferred') out.push(`${labels([...plan.guessed, 'refs'])} theo node trên canvas cầu nối (đoán) — hãy kiểm tra`)
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
  const credit = t.provider === 'dev' ? 'credit dev' : 'credit'
  return t.imported ? `Job tạo trên ${importSite(t)} (ngoài SanoVids), nhập lúc ${clock(t.imported.at)} — “Chạy lại” tạo take mới (trừ ${credit} như thường)` : ''
}
