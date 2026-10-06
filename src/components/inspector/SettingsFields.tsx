// Video settings grid (preset, model, mode, duration, resolution, ratio) for one or many scenes.
// Fields with long or many options are selects; duration, resolution and ratio (2–5 short options) are Apple-style
// segmented controls. With several scenes, a field whose values differ shows "—" (select) or no selected segment
// plus "· khác nhau" until a value is picked for all.
// Scenes on different models: options only some of the models offer are marked "· chỉ SD 2.5", and the caller
// applies such a value only to the scenes whose model supports it (see `patchFits`).
// What the gateway of new takes runs right now (/api/video-profiles, ./settingsLimits.ts): an option it surely refuses
// is disabled with the reason (never hidden; the scene's saved value is never changed), a guess only marks it, and a
// note under the grid says which scenes cannot run and offers "Đọc lại".
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { modeLabel, MODELS, settingsLabel } from '../../core/models'
import type { ModelId, Mode, Preset, VideoSettings } from '../../core/types'
import { gatewayFor, providerLimitsInfo, refreshProviderLimits, type LimitsInfo, type ProviderId, type SettingsLimits } from '../../providers'
import { limitsSite } from '../../providers/limits'
import type { LimitField } from '../../providers/types'
import { toast } from '../../store/ui'
import { useActiveLimits } from '../runs/shared'
import { loginToCanvasapp } from '../topbar/CreditPill'
import {
  clockTime,
  optionLimit,
  optionTag,
  optionTitle,
  partialNote,
  presetLimit,
  refreshToast,
  segmentPickable,
  selectionIssues,
  settingsListKey,
  uniqueSettings,
  type LimitsSiteName,
  type OptionLimit,
} from './settingsLimits'

const MIXED = '__mixed'

const fmtDuration = (d: number) => `${d}s`
const fmtResolution = (r: string) => r.toUpperCase()

/** Rough width (px) a segmented control needs: ~7px a character at 12px, 8px padding per segment, the 4px track. */
function segWidth(labels: string[]): number {
  return labels.reduce((w, l) => w + l.length * 7 + 8, 4)
}
/** Room in a half-row field at the default inspector width. */
const HALF_ROW_W = 150

/**
 * Do the duration / resolution segmented controls need a full row each? Scenes on several models offer the union of
 * their options (480P…2K = 5 resolutions): squeezed into half a row the labels would be cut ("10…").
 */
export function segmentsNeedFullRow(durations: number[], resolutions: string[]): boolean {
  return Math.max(segWidth(durations.map(fmtDuration)), segWidth(resolutions.map(fmtResolution))) > HALF_ROW_W
}

function common<T>(list: T[]): T | null {
  if (!list.length) return null
  const first = list[0]
  return list.every((x) => x === first) ? first : null
}
function union<T>(lists: T[][]): T[] {
  const out: T[] = []
  for (const l of lists) for (const x of l) if (!out.includes(x)) out.push(x)
  return out
}

/** Can a scene on `model` take this settings patch as is (without normalizeSettings replacing the value)? */
export function patchFits(model: ModelId, patch: Partial<VideoSettings>): boolean {
  const spec = MODELS[model]
  if (!spec || patch.model !== undefined) return true
  return (
    (patch.mode === undefined || spec.modes.includes(patch.mode)) &&
    (patch.duration === undefined || spec.durations.includes(patch.duration)) &&
    (patch.resolution === undefined || spec.resolutions.includes(patch.resolution)) &&
    (patch.ratio === undefined || spec.ratios.includes(patch.ratio))
  )
}

/** Short label of the value a settings patch sets (for messages). */
export function patchLabel(patch: Partial<VideoSettings>): string {
  if (patch.resolution !== undefined) return patch.resolution.toUpperCase()
  if (patch.duration !== undefined) return `${patch.duration}s`
  if (patch.mode !== undefined) return modeLabel(patch.mode)
  return patch.ratio ?? ''
}

const OK: OptionLimit = { state: 'ok', reason: '', okModels: [] }

type FieldValue = string | number
type FieldLimits = Record<LimitField, Map<FieldValue, OptionLimit>>

export function SettingsFields({
  settings,
  presetIds,
  presets,
  onPatch,
  onPreset,
  codes,
}: {
  settings: VideoSettings[]
  presetIds: (string | null)[]
  presets: Preset[]
  onPatch: (patch: Partial<VideoSettings>) => void
  onPreset: (presetId: string) => void
  /** Scene codes (S03…) aligned with `settings` — named by the note when several scenes are selected. */
  codes?: string[]
}) {
  const model = common(settings.map((s) => s.model))
  const mode = common(settings.map((s) => s.mode))
  const duration = common(settings.map((s) => s.duration))
  const resolution = common(settings.map((s) => s.resolution))
  const ratio = common(settings.map((s) => s.ratio))
  const presetId = common(presetIds)
  const allSamePreset = presetIds.length > 0 && presetIds.every((p) => p === presetIds[0])

  // What the gateway runs now: read when shown (TTL-gated), renewed while shown (runs/shared useActiveLimits).
  const { provider, limits, info } = useActiveLimits()
  const site = limitsSite(provider)
  // The distinct settings of the selection (100 scenes → a handful): everything below is computed per distinct one.
  const key = settingsListKey(settings)
  // key names exactly the distinct settings: a new array with the same ones reuses the list
  const distinct = useMemo(() => uniqueSettings(settings), [key])
  const models = useMemo(() => union(distinct.map((s) => [s.model])), [distinct])
  const specs = models.map((m) => MODELS[m])
  const modes = union(specs.map((s) => s.modes))
  const durations = union(specs.map((s) => s.durations)).sort((a, b) => a - b)
  const resolutions = union(specs.map((s) => s.resolutions))
  const ratios = union(specs.map((s) => s.ratios))
  // Too many options for half a row: duration and resolution take a full row each (like the narrow-panel rule).
  const segField = `in-field c3 in-seg-field${segmentsNeedFullRow(durations, resolutions) ? ' is-wide' : ''}`

  /** Each option's state for the selection, once per (limits, distinct settings). */
  const lims = useMemo<FieldLimits>(() => {
    const of = <T extends FieldValue>(field: LimitField, values: readonly T[]) => new Map<FieldValue, OptionLimit>(values.map((v) => [v, optionLimit(limits, distinct, field, v)]))
    const all = union(distinct.map((s) => [s.model])).map((m) => MODELS[m])
    return {
      model: of('model', Object.keys(MODELS)),
      mode: of('mode', union(all.map((s) => s.modes))),
      duration: of('duration', union(all.map((s) => s.durations))),
      resolution: of('resolution', union(all.map((s) => s.resolutions))),
      ratio: of('ratio', union(all.map((s) => s.ratios))),
    }
  }, [limits, distinct])
  const limitOf = (field: LimitField, v: FieldValue) => lims[field].get(v) ?? OK
  /** Fields the CURRENT settings of the selection are refused on (the control is outlined). */
  const refusedFields = useMemo(() => {
    const out = new Set<LimitField>()
    if (limits.source !== 'none') for (const s of distinct) for (const i of limits.issues(s)) out.add(i.field)
    return out
  }, [limits, distinct])
  const fieldClass = (field: LimitField) => (!refusedFields.has(field) ? '' : limits.source === 'server' && limits.firm ? ' is-refused' : ' is-risky')
  const presetLims = useMemo(() => new Map(presets.map((p) => [p.id, presetLimit(limits, p)])), [limits, presets])
  const issues = useMemo(
    () => selectionIssues(limits, settings.map((s, i) => ({ settings: s, code: codes?.[i] }))),
    [limits, settings, codes],
  )

  return (
    <>
      <div className="in-grid">
        <label className="in-field c6">
          <span>Preset</span>
          <select
            className="select in-sm"
            value={allSamePreset ? (presetId ?? '') : MIXED}
            onChange={(e) => e.target.value && e.target.value !== MIXED && onPreset(e.target.value)}
          >
            {!allSamePreset && (
              <option value={MIXED} disabled>
                — (khác nhau)
              </option>
            )}
            {allSamePreset && presetId === null && <option value="">Tuỳ chỉnh</option>}
            {presets.map((p) => {
              // a preset stays pickable (picking is not running; the note then says what to change): only marked
              const lim = presetLims.get(p.id) ?? OK
              return (
                <option key={p.id} value={p.id} title={lim.reason || undefined}>
                  {p.name} · {MODELS[p.model]?.short ?? p.model} · {settingsLabel(p)}
                  {optionTag(lim, site)}
                </option>
              )
            })}
          </select>
        </label>
        <label className={`in-field c3${fieldClass('model')}`}>
          <span>Model</span>
          <select
            className="select in-sm"
            value={model ?? MIXED}
            onChange={(e) => e.target.value !== MIXED && onPatch({ model: e.target.value as ModelId })}
            aria-invalid={refusedFields.has('model') || undefined}
            title={refusedFields.has('model') && model ? limitOf('model', model).reason || undefined : undefined}
          >
            {model === null && (
              <option value={MIXED} disabled>
                —
              </option>
            )}
            {Object.values(MODELS).map((m) => {
              const lim = limitOf('model', m.id)
              return (
                <option key={m.id} value={m.id} disabled={lim.state === 'off'} title={optionTitle('Model', m.name, lim, site)}>
                  {m.name}
                  {optionTag(lim, site)}
                </option>
              )
            })}
          </select>
        </label>
        <label className={`in-field c3${fieldClass('mode')}`}>
          <span>Chế độ</span>
          <select
            className="select in-sm"
            value={mode ?? MIXED}
            onChange={(e) => e.target.value !== MIXED && onPatch({ mode: e.target.value as Mode })}
            disabled={modes.length <= 1 && mode !== null && !refusedFields.has('mode')}
            aria-invalid={refusedFields.has('mode') || undefined}
            title={refusedFields.has('mode') && mode ? limitOf('mode', mode).reason || undefined : undefined}
          >
            {mode === null && (
              <option value={MIXED} disabled>
                —
              </option>
            )}
            {modes.map((m) => {
              const lim = limitOf('mode', m)
              const label = modeLabel(m, model ?? undefined)
              const partial = partialNote(lim, models)
              return (
                <option key={m} value={m} disabled={lim.state === 'off'} title={optionTitle('Chế độ', label, lim, site, partial)}>
                  {label}
                  {lim.state === 'ok' ? partial : optionTag(lim, site)}
                </option>
              )
            })}
          </select>
        </label>
        <div className={`${segField}${fieldClass('duration')}`}>
          <span>
            Thời lượng{duration === null && <em className="in-mixed"> · khác nhau</em>}
          </span>
          <Segmented
            label="Thời lượng"
            value={duration}
            options={durations}
            format={fmtDuration}
            limit={(d) => limitOf('duration', d)}
            models={models}
            site={site}
            onPick={(d) => onPatch({ duration: d })}
          />
        </div>
        <div className={`${segField}${fieldClass('resolution')}`}>
          <span>
            Độ phân giải{resolution === null && <em className="in-mixed"> · khác nhau</em>}
          </span>
          <Segmented
            label="Độ phân giải"
            value={resolution}
            options={resolutions}
            format={fmtResolution}
            limit={(r) => limitOf('resolution', r)}
            models={models}
            site={site}
            onPick={(r) => onPatch({ resolution: r })}
          />
        </div>
        <div className={`in-field c6${fieldClass('ratio')}`}>
          <span>
            Tỉ lệ{ratio === null && <em className="in-mixed"> · khác nhau</em>}
          </span>
          <Segmented
            label="Tỉ lệ"
            value={ratio}
            options={ratios}
            format={(r) => r}
            limit={(r) => limitOf('ratio', r)}
            models={models}
            site={site}
            onPick={(r) => onPatch({ ratio: r })}
          />
        </div>
      </div>
      {issues && <LimitsNote provider={provider} limits={limits} info={info} issues={issues} multi={settings.length > 1} site={site} />}
    </>
  )
}

/** "S03, S07, S12, S15…" */
function codeList(codes: string[]): string {
  return codes.slice(0, 4).join(', ') + (codes.length > 4 ? '…' : '')
}

/**
 * Under the settings: which scenes the gateway refuses now and why, with "Đọc lại" (a forced read, at most every few
 * seconds). A sure refusal (firm read) = those scenes cannot run; a guess / an older read = they may be refused.
 */
function LimitsNote({
  provider,
  limits,
  info,
  issues,
  multi,
  site,
}: {
  provider: ProviderId
  limits: SettingsLimits
  info: LimitsInfo
  issues: NonNullable<ReturnType<typeof selectionIssues>>
  multi: boolean
  site: LimitsSiteName
}) {
  const [busy, setBusy] = useState(false)
  const reread = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await refreshProviderLimits(provider, { force: true })
      const t = refreshToast(result, site, providerLimitsInfo(provider))
      const gw = gatewayFor(provider)
      toast(t.text, { tone: t.tone, action: t.login && gw ? { label: 'Đăng nhập', run: () => void loginToCanvasapp(gw) } : undefined })
    } finally {
      setBusy(false)
    }
  }
  const who = multi ? `${issues.count} cảnh${issues.codes.length ? ` (${codeList(issues.codes)})` : ''}` : 'Cảnh này'
  const head = issues.sure
    ? multi
      ? `${site.short} đang tắt lựa chọn của ${who} — các cảnh này chưa chạy được: khi chạy nhiều cảnh, chúng được bỏ qua (không tốn credit).`
      : `${site.short} đang tắt lựa chọn này — cảnh chưa chạy được cho tới khi đổi (không gửi gì, không tốn credit).`
    : limits.source === 'fallback'
      ? `Chưa đọc được cấu hình model từ ${site.short} — đang theo cấu hình mặc định như trang canvasapp (MiniMax-H3 tạm khoá). ${who} có thể bị từ chối khi gửi (không tốn credit).`
      : `Theo lần đọc cấu hình model${info.at !== null ? ` lúc ${clockTime(info.at)}` : ''}, ${who.charAt(0).toLowerCase() + who.slice(1)} có thể bị ${site.short} từ chối khi gửi (không tốn credit) — SanoVids đọc lại trước khi gửi.`
  return (
    <div className={`in-note in-limits-note ${issues.sure ? 'danger' : 'is-warn'}`} role="status">
      <TriangleAlert size={13} />
      <div className="in-limits-body">
        <span>{head}</span>
        <ul className="in-note-list">
          {issues.reasons.slice(0, 4).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <span className="in-limits-foot">
          {issues.sure ? `Đổi lựa chọn ở trên, hoặc đọc lại nếu ${site.short} vừa mở lại.` : 'Đổi lựa chọn ở trên, hoặc đọc lại ngay.'}
          <button
            type="button"
            className="btn btn-sm btn-ghost in-mini"
            onClick={() => void reread()}
            disabled={busy}
            title={`Đọc lại cấu hình model từ ${site.full}${info.at !== null ? ` (lần trước: ${clockTime(info.at)})` : ''}`}
          >
            <RefreshCw size={11} className={busy ? 'in-spin' : undefined} /> Đọc lại
          </button>
        </span>
      </div>
    </div>
  )
}

/**
 * Segmented control (Apple style): equal segments on a pill track, the selected one raised on a thumb that slides
 * between them. `value` null = the selected scenes differ (no segment selected). Arrow keys move the focus; Space /
 * Enter picks (each pick is an undo step, so arrows do not apply every option they pass).
 */
function Segmented<T extends string | number>({
  label,
  value,
  options,
  format,
  limit,
  models,
  site,
  onPick,
}: {
  label: string
  value: T | null
  options: T[]
  format: (v: T) => string
  /** What the gateway makes of the option for the selection (SettingsFields lims). */
  limit: (v: T) => OptionLimit
  /** Models of the selection (" · chỉ SD 2.5" when only some of them can use an option). */
  models: readonly ModelId[]
  site: LimitsSiteName
  onPick: (v: T) => void
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const idx = value === null ? -1 : options.indexOf(value)
  const focusAt = (i: number) => buttons.current[(i + options.length) % options.length]?.focus()
  return (
    <div className="in-seg" role="radiogroup" aria-label={label} style={{ '--n': options.length, '--i': Math.max(0, idx) } as CSSProperties}>
      {idx >= 0 && <span className="in-seg-thumb" aria-hidden="true" />}
      {options.map((o, i) => {
        const on = i === idx
        const lim = limit(o)
        const extra = partialNote(lim, models)
        return (
          <button
            key={String(o)}
            ref={(el) => {
              buttons.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            // refused: still focusable (arrows pass over it) and shown, but not pickable
            aria-disabled={lim.state === 'off' || undefined}
            tabIndex={on || (idx < 0 && i === 0) ? 0 : -1}
            className={`in-seg-btn${on ? ' on' : ''}${extra ? ' is-partial' : ''}${lim.state === 'off' ? ' is-off' : lim.state === 'risky' ? ' is-risky' : ''}`}
            title={optionTitle(label, format(o), lim, site, extra)}
            onClick={() => {
              if (segmentPickable(on, lim)) onPick(o)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                focusAt(i + 1)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                focusAt(i - 1)
              }
            }}
          >
            {format(o)}
          </button>
        )
      })}
    </div>
  )
}
