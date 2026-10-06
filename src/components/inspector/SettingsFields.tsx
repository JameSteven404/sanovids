// Video settings grid (preset, model, mode, duration, resolution, ratio) for one or many scenes.
// Fields with long or many options are selects; duration, resolution and ratio (2–5 short options) are Apple-style
// segmented controls. With several scenes, a field whose values differ shows "—" (select) or no selected segment
// plus "· khác nhau" until a value is picked for all.
// Scenes on different models: options only some of the models offer are marked "· chỉ SD 2.5", and the caller
// applies such a value only to the scenes whose model supports it (see `patchFits`).
// A scene on a model of a newer SanoVids build (Scene.foreignModel) shows that model as a temporary, selected entry
// "veo_3_1 (bản mới hơn)" of the model picker; picking a real model drops the marker (store updateSettings).
import { useRef, type CSSProperties } from 'react'
import { foreignModelOption, modeLabel, MODELS, settingsLabel, type ModelSpec } from '../../core/models'
import type { ModelId, Mode, Preset, VideoSettings } from '../../core/types'

const MIXED = '__mixed'
/** Value of the model picker's temporary entry for a newer build's model (never a ModelId). */
const FOREIGN = '__foreign'

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

/**
 * What the model picker shows: a newer build's model when every scene is on the same one (`foreign`), "—" when the
 * scenes differ (some on a newer build's model, or on different ones), else the common model. `foreignModels` runs
 * parallel to `settings` (missing = no scene has one).
 */
export function modelPick(settings: readonly VideoSettings[], foreignModels?: readonly (string | null | undefined)[]): { foreign: string | null; model: ModelId | null } {
  const model = common(settings.map((s) => s.model))
  const marks = settings.map((_, i) => foreignModels?.[i] || null)
  if (!marks.some(Boolean)) return { foreign: null, model }
  return { foreign: common(marks), model: null }
}

export function SettingsFields({
  settings,
  foreignModels,
  presetIds,
  presets,
  onPatch,
  onPreset,
}: {
  settings: VideoSettings[]
  /** Scene.foreignModel of each scene, parallel to `settings` (omit when none can have one). */
  foreignModels?: readonly (string | null | undefined)[]
  presetIds: (string | null)[]
  presets: Preset[]
  onPatch: (patch: Partial<VideoSettings>) => void
  onPreset: (presetId: string) => void
}) {
  const model = common(settings.map((s) => s.model))
  const pick = modelPick(settings, foreignModels)
  const modelValue = pick.foreign ? FOREIGN : (pick.model ?? MIXED)
  const mode = common(settings.map((s) => s.mode))
  const duration = common(settings.map((s) => s.duration))
  const resolution = common(settings.map((s) => s.resolution))
  const ratio = common(settings.map((s) => s.ratio))
  const presetId = common(presetIds)
  const allSamePreset = presetIds.length > 0 && presetIds.every((p) => p === presetIds[0])

  const specs = union(settings.map((s) => [s.model])).map((m) => MODELS[m])
  const modes = union(specs.map((s) => s.modes))
  const durations = union(specs.map((s) => s.durations)).sort((a, b) => a - b)
  const resolutions = union(specs.map((s) => s.resolutions))
  const ratios = union(specs.map((s) => s.ratios))
  // Too many options for half a row: duration and resolution take a full row each (like the narrow-panel rule).
  const segField = `in-field c3 in-seg-field${segmentsNeedFullRow(durations, resolutions) ? ' is-wide' : ''}`
  /** " · chỉ H3" when the selection mixes models and only some of them offer the option. */
  const onlyFor = (ok: (spec: ModelSpec) => boolean): string => {
    if (specs.length < 2) return ''
    const names = specs.filter(ok).map((sp) => sp.short)
    return names.length < specs.length ? ` · chỉ ${names.join(', ')}` : ''
  }

  return (
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
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {/* a preset of a newer build's model: its model, not the stand-in settings */}
              {p.foreignModel ? `${p.name} · ${foreignModelOption(p.foreignModel)}` : `${p.name} · ${MODELS[p.model]?.short ?? p.model} · ${settingsLabel(p)}`}
            </option>
          ))}
        </select>
      </label>
      <label className="in-field c3">
        <span>Model</span>
        <select
          className="select in-sm"
          value={modelValue}
          onChange={(e) => e.target.value !== MIXED && e.target.value !== FOREIGN && onPatch({ model: e.target.value as ModelId })}
        >
          {modelValue === MIXED && (
            <option value={MIXED} disabled>
              —
            </option>
          )}
          {pick.foreign && (
            <option value={FOREIGN} disabled>
              {foreignModelOption(pick.foreign)}
            </option>
          )}
          {Object.values(MODELS).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="in-field c3">
        <span>Chế độ</span>
        <select
          className="select in-sm"
          value={mode ?? MIXED}
          onChange={(e) => e.target.value !== MIXED && onPatch({ mode: e.target.value as Mode })}
          disabled={modes.length <= 1 && mode !== null}
        >
          {mode === null && (
            <option value={MIXED} disabled>
              —
            </option>
          )}
          {modes.map((m) => (
            <option key={m} value={m}>
              {modeLabel(m, model ?? undefined)}
              {onlyFor((sp) => sp.modes.includes(m))}
            </option>
          ))}
        </select>
      </label>
      <div className={segField}>
        <span>
          Thời lượng{duration === null && <em className="in-mixed"> · khác nhau</em>}
        </span>
        <Segmented
          label="Thời lượng"
          value={duration}
          options={durations}
          format={fmtDuration}
          note={(d) => onlyFor((sp) => sp.durations.includes(d))}
          onPick={(d) => onPatch({ duration: d })}
        />
      </div>
      <div className={segField}>
        <span>
          Độ phân giải{resolution === null && <em className="in-mixed"> · khác nhau</em>}
        </span>
        <Segmented
          label="Độ phân giải"
          value={resolution}
          options={resolutions}
          format={fmtResolution}
          note={(r) => onlyFor((sp) => sp.resolutions.includes(r))}
          onPick={(r) => onPatch({ resolution: r })}
        />
      </div>
      <div className="in-field c6">
        <span>
          Tỉ lệ{ratio === null && <em className="in-mixed"> · khác nhau</em>}
        </span>
        <Segmented
          label="Tỉ lệ"
          value={ratio}
          options={ratios}
          format={(r) => r}
          note={(r) => onlyFor((sp) => sp.ratios.includes(r))}
          onPick={(r) => onPatch({ ratio: r })}
        />
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
  note,
  onPick,
}: {
  label: string
  value: T | null
  options: T[]
  format: (v: T) => string
  /** " · chỉ SD 2.5" when only some of the selected scenes' models offer the option ('' otherwise). */
  note: (v: T) => string
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
        const extra = note(o)
        return (
          <button
            key={String(o)}
            ref={(el) => {
              buttons.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (idx < 0 && i === 0) ? 0 : -1}
            className={`in-seg-btn${on ? ' on' : ''}${extra ? ' is-partial' : ''}`}
            title={`${label}: ${format(o)}${extra}`}
            onClick={() => {
              if (!on) onPick(o)
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
