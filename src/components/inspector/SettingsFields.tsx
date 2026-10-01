// Video settings grid (preset, model, mode, duration, resolution, ratio) for one or many scenes.
// With several scenes, a field whose values differ shows "—" until a value is picked for all.
// Scenes on different models: options only some of the models offer are marked "· chỉ SD 2.5", and the caller
// applies such a value only to the scenes whose model supports it (see `patchFits`).
import { MODE_LABEL, MODELS, settingsLabel, type ModelSpec } from '../../core/models'
import type { ModelId, Mode, Preset, VideoSettings } from '../../core/types'

const MIXED = '__mixed'

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
  if (patch.mode !== undefined) return MODE_LABEL[patch.mode]
  return patch.ratio ?? ''
}

export function SettingsFields({
  settings,
  presetIds,
  presets,
  onPatch,
  onPreset,
}: {
  settings: VideoSettings[]
  presetIds: (string | null)[]
  presets: Preset[]
  onPatch: (patch: Partial<VideoSettings>) => void
  onPreset: (presetId: string) => void
}) {
  const model = common(settings.map((s) => s.model))
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
              {p.name} · {MODELS[p.model]?.short ?? p.model} · {settingsLabel(p)}
            </option>
          ))}
        </select>
      </label>
      <label className="in-field c3">
        <span>Model</span>
        <select className="select in-sm" value={model ?? MIXED} onChange={(e) => e.target.value !== MIXED && onPatch({ model: e.target.value as ModelId })}>
          {model === null && (
            <option value={MIXED} disabled>
              —
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
              {MODE_LABEL[m]}
              {onlyFor((sp) => sp.modes.includes(m))}
            </option>
          ))}
        </select>
      </label>
      <label className="in-field c2">
        <span>Thời lượng</span>
        <select
          className="select in-sm"
          value={duration === null ? MIXED : String(duration)}
          onChange={(e) => e.target.value !== MIXED && onPatch({ duration: Number(e.target.value) })}
        >
          {duration === null && (
            <option value={MIXED} disabled>
              —
            </option>
          )}
          {durations.map((d) => (
            <option key={d} value={String(d)}>
              {d}s{onlyFor((sp) => sp.durations.includes(d))}
            </option>
          ))}
        </select>
      </label>
      <label className="in-field c2">
        <span>Độ phân giải</span>
        <select className="select in-sm" value={resolution ?? MIXED} onChange={(e) => e.target.value !== MIXED && onPatch({ resolution: e.target.value })}>
          {resolution === null && (
            <option value={MIXED} disabled>
              —
            </option>
          )}
          {resolutions.map((r) => (
            <option key={r} value={r}>
              {r.toUpperCase()}
              {onlyFor((sp) => sp.resolutions.includes(r))}
            </option>
          ))}
        </select>
      </label>
      <label className="in-field c2">
        <span>Tỉ lệ</span>
        <select className="select in-sm" value={ratio ?? MIXED} onChange={(e) => e.target.value !== MIXED && onPatch({ ratio: e.target.value })}>
          {ratio === null && (
            <option value={MIXED} disabled>
              —
            </option>
          )}
          {ratios.map((r) => (
            <option key={r} value={r}>
              {r}
              {onlyFor((sp) => sp.ratios.includes(r))}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
