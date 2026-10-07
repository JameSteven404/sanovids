// The scene node's settings line opened in place (choice 2B): model / mode / preset pickers on the line itself and
// three rows of buttons below it (duration, resolution, ratio) — the prompt box gives up 3 lines meanwhile, the node
// never grows. Mounted only while a node's line is open (one at a time in practice). Every pick is one undo step
// (store updateSettings / applyPreset), the price on the Run button follows at once. What the gateway refuses now
// (/api/video-profiles) is shown like the right panel: struck through, not pickable (settingsLimits).
import { ChevronUp } from 'lucide-react'
import { memo, useMemo } from 'react'
import { foreignModelOption, modeLabel, MODELS } from '../../core/models'
import type { ModelId, Mode, VideoSettings } from '../../core/types'
import { limitsSite } from '../../providers/limits'
import { useProject } from '../../store/project'
import { useActiveLimits } from '../runs/shared'
import { appliedPresetId } from '../sidebar/shared'
import { Segmented } from '../inspector/SettingsFields'
import { optionLimit, optionTag, optionTitle } from '../inspector/settingsLimits'
import { MODE_SHORT } from './sceneNodeModel'
import '../inspector/inspector.css'

const fmtDuration = (d: number) => `${d}s`
const fmtResolution = (r: string) => r.toUpperCase()
const FOREIGN = '__foreign'
const CUSTOM = ''

export const SceneNodeSettings = memo(function SceneNodeSettings({
  sceneId,
  settings,
  storedPresetId,
  foreignModel,
  onClose,
}: {
  sceneId: string
  settings: VideoSettings
  /** Scene.presetId (the picker shows "Tuỳ chỉnh" when the preset was edited since: appliedPresetId). */
  storedPresetId: string | null
  foreignModel?: string
  onClose: () => void
}) {
  const presets = useProject((s) => s.project.presets)
  const presetId = appliedPresetId(storedPresetId, settings, presets)
  const { provider, limits } = useActiveLimits()
  const site = limitsSite(provider)
  const list = useMemo(() => [settings], [settings])
  const models = useMemo(() => [settings.model], [settings.model])
  const spec = MODELS[settings.model]
  const lim = (field: 'model' | 'mode' | 'duration' | 'resolution' | 'ratio', v: string | number) => optionLimit(limits, list, field, v)
  const patch = (p: Partial<VideoSettings>) => useProject.getState().updateSettings([sceneId], p)
  return (
    <div className="cv-sn-setx nodrag nopan" role="group" aria-label="Cấu hình video của cảnh">
      <div className="cv-sn-setx-line">
        <select
          className="cv-sn-sel is-model"
          style={{ ['--model-c' as string]: foreignModel ? 'var(--warn)' : spec.color }}
          value={foreignModel ? FOREIGN : settings.model}
          aria-label="Model"
          title={spec.name}
          onChange={(e) => e.target.value !== FOREIGN && patch({ model: e.target.value as ModelId })}
        >
          {foreignModel && (
            <option value={FOREIGN} disabled>
              {foreignModelOption(foreignModel)}
            </option>
          )}
          {Object.values(MODELS).map((m) => {
            const l = lim('model', m.id)
            return (
              <option key={m.id} value={m.id} disabled={l.state === 'off'} title={optionTitle('Model', m.name, l, site)}>
                {m.short}
                {optionTag(l, site)}
              </option>
            )
          })}
        </select>
        {spec.modes.length > 1 && (
          <select
            className="cv-sn-sel"
            value={settings.mode}
            aria-label="Chế độ"
            title={modeLabel(settings.mode, settings.model)}
            onChange={(e) => patch({ mode: e.target.value as Mode })}
          >
            {spec.modes.map((m) => {
              const l = lim('mode', m)
              return (
                <option key={m} value={m} disabled={l.state === 'off'} title={optionTitle('Chế độ', modeLabel(m, settings.model), l, site)}>
                  {MODE_SHORT[m]}
                  {optionTag(l, site)}
                </option>
              )
            })}
          </select>
        )}
        <select
          className="cv-sn-sel is-preset"
          value={presetId ?? CUSTOM}
          aria-label="Preset"
          onChange={(e) => e.target.value && useProject.getState().applyPreset(e.target.value, [sceneId])}
        >
          {presetId === null && <option value={CUSTOM}>Tuỳ chỉnh</option>}
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="cv-sn-setx-sp" />
        <button type="button" className="cv-sn-setx-close" onClick={onClose} title="Thu gọn cấu hình" aria-label="Thu gọn cấu hình">
          <ChevronUp size={13} strokeWidth={2.4} />
        </button>
      </div>
      <div className="cv-sn-setx-row" data-settings-field="duration">
        <Segmented
          label="Thời lượng"
          value={settings.duration}
          options={spec.durations}
          format={fmtDuration}
          limit={(d) => lim('duration', d)}
          models={models}
          site={site}
          onPick={(d) => patch({ duration: d })}
        />
      </div>
      <div className="cv-sn-setx-row" data-settings-field="resolution">
        <Segmented
          label="Độ phân giải"
          value={settings.resolution}
          options={spec.resolutions}
          format={fmtResolution}
          limit={(r) => lim('resolution', r)}
          models={models}
          site={site}
          onPick={(r) => patch({ resolution: r })}
        />
      </div>
      <div className="cv-sn-setx-row" data-settings-field="ratio">
        <Segmented label="Tỉ lệ" value={settings.ratio} options={spec.ratios} format={(r) => r} limit={(r) => lim('ratio', r)} models={models} site={site} onPick={(r) => patch({ ratio: r })} />
      </div>
    </div>
  )
})
