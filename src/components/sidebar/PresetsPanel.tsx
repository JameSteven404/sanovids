import { Check, ChevronDown, FlaskConical, Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MODELS, costOf, foreignModelBadge, foreignModelOption, modeLabel, settingsLabel } from '../../core/models'
import type { ModelId, Mode, Preset, VideoSettings } from '../../core/types'
import { CREDIT_MARK, formatCredits, isSimulatedCredit } from '../../lib/credits'
import { useCreditKind } from '../../store/credits'
import { useProject, type ProjectState } from '../../store/project'
import { toast } from '../../store/ui'
import { ConfirmButton, Section } from './bits'
import { appliedPresetId, costTitle, creditTone, modelSpec, presetMatches, undoToastAction, useSelectedSceneIds } from './shared'

/** Number of scenes running with each preset (applied, and not changed since — by the scene or by editing the preset). */
const presetUsageSelector = (s: ProjectState) => {
  const byId = new Map(s.project.presets.map((p) => [p.id, p]))
  const m: Record<string, number> = {}
  for (const sc of s.project.scenes) {
    const preset = sc.presetId ? byId.get(sc.presetId) : undefined
    if (preset && presetMatches(preset, sc.settings)) m[preset.id] = (m[preset.id] ?? 0) + 1
  }
  return m
}

/** `focusName`: the preset was just created — focus and select its name so it can be typed right away. */
/** Value of the model picker's stand-in entry for a preset of a newer build's model (Preset.foreignModel). */
const FOREIGN_MODEL = '__foreign__'

function PresetEditor({ preset, focusName }: { preset: Preset; focusName: boolean }) {
  const [name, setName] = useState(preset.name)
  useEffect(() => setName(preset.name), [preset.name])
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusName) return
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [focusName])
  const spec = modelSpec(preset.model)
  const creditKind = useCreditKind()
  const cost = costOf(preset)
  const update = (patch: Partial<Omit<Preset, 'id'>>) => useProject.getState().updatePreset(preset.id, patch)
  const commitName = () => {
    const next = name.trim()
    if (!next) setName(preset.name)
    else if (next !== preset.name) update({ name: next })
  }
  return (
    <div className="sb-preset-edit" onClick={(e) => e.stopPropagation()}>
      <label className="field sb-span2">
        <span>Tên preset</span>
        <input
          ref={nameRef}
          className="input sb-input-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </label>
      <label className="field">
        <span>Model</span>
        <select
          className="select sb-input-sm"
          value={preset.foreignModel ? FOREIGN_MODEL : preset.model}
          onChange={(e) => e.target.value !== FOREIGN_MODEL && update({ model: e.target.value as ModelId })}
        >
          {/* a preset of a newer build's model: that model, selected, until a model of this build is picked */}
          {preset.foreignModel && (
            <option value={FOREIGN_MODEL} disabled>
              {foreignModelOption(preset.foreignModel)}
            </option>
          )}
          {Object.values(MODELS).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Chế độ</span>
        <select className="select sb-input-sm" value={preset.mode} onChange={(e) => update({ mode: e.target.value as Mode })} disabled={spec.modes.length < 2}>
          {spec.modes.map((m) => (
            <option key={m} value={m}>
              {modeLabel(m, spec.id)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Thời lượng</span>
        <select className="select sb-input-sm" value={preset.duration} onChange={(e) => update({ duration: Number(e.target.value) })}>
          {spec.durations.map((d) => (
            <option key={d} value={d}>
              {d} giây
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Độ phân giải</span>
        <select className="select sb-input-sm" value={preset.resolution} onChange={(e) => update({ resolution: e.target.value })}>
          {spec.resolutions.map((r) => (
            <option key={r} value={r}>
              {r.toUpperCase()}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Tỉ lệ</span>
        <select className="select sb-input-sm" value={preset.ratio} onChange={(e) => update({ ratio: e.target.value })}>
          {spec.ratios.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>Chi phí</span>
        <div className="sb-cost-box">
          <span className={`sb-cost-pill ${creditTone(creditKind)}`} title={costTitle(cost, creditKind, 'Mỗi lần chạy · ')}>
            {isSimulatedCredit(creditKind) && <FlaskConical size={11} />}
            {formatCredits(cost, creditKind)}
          </span>
          <span className="faint">/ lần chạy</span>
        </div>
      </div>
      <div className="sb-preset-edit-foot sb-span2">
        <span className="faint">Sửa preset không đổi các cảnh đã áp dụng trước đó (chúng thành “Tuỳ chỉnh”) — bấm Áp dụng để cập nhật.</span>
        <ConfirmButton
          icon={<Trash2 size={12} />}
          label="Xoá"
          confirmLabel="Xoá thật?"
          onConfirm={() => {
            useProject.getState().removePreset(preset.id)
            toast(`Đã xoá preset “${preset.name}”.`, { action: undoToastAction() })
          }}
        />
      </div>
    </div>
  )
}

interface RowProps {
  preset: Preset
  usage: number
  selected: string[]
  /** All selected scenes currently use this preset. */
  active: boolean
  editing: boolean
  /** Just created: its editor focuses the name field. */
  fresh: boolean
  onEdit: (id: string | null) => void
}

const PresetRow = memo(function PresetRow({ preset, usage, selected, active, editing, fresh, onEdit }: RowProps) {
  const spec = modelSpec(preset.model)
  const creditKind = useCreditKind()
  const cost = costOf(preset)
  const n = selected.length
  const apply = () => {
    if (!n) return
    useProject.getState().applyPreset(preset.id, selected)
    toast(`Đã áp dụng preset “${preset.name}” cho ${n} cảnh.`, { tone: 'success', action: undoToastAction() })
  }
  return (
    <div className={`sb-preset${editing ? ' editing' : ''}${active ? ' active' : ''}`}>
      <div
        className="sb-preset-head"
        onClick={(e) => {
          if (e.detail > 1) return
          onEdit(editing ? null : preset.id)
        }}
        title={editing ? 'Bấm để thu gọn' : 'Bấm để sửa'}
      >
        <div className="sb-preset-main">
          <div className="sb-preset-top">
            <span className="sb-preset-name">{preset.name}</span>
            {preset.foreignModel ? (
              <span className="sb-model is-foreign" title={`Model của SanoVids bản mới hơn (${preset.foreignModel}) — cảnh dùng preset này bị chặn chạy cho tới khi cập nhật hoặc chọn lại model.`}>
                {foreignModelBadge(preset.foreignModel)}
              </span>
            ) : (
              <span className="sb-model" style={{ '--sb-m': spec.color } as CSSProperties} title={spec.name}>
                {spec.short}
              </span>
            )}
            {active && (
              <span className="sb-preset-using" title="Các cảnh đang chọn dùng preset này">
                <Check size={11} />
              </span>
            )}
          </div>
          <div className="sb-preset-sub">
            <span>{settingsLabel(preset)}</span>
            {spec.modes.length > 1 && <span className="faint"> · {modeLabel(preset.mode, spec.id)}</span>}
          </div>
          <div className="sb-preset-sub faint">
            <b className={`sb-cost ${creditTone(creditKind)}`} title={costTitle(cost, creditKind, 'Mỗi lần chạy · ')}>
              {formatCredits(cost, creditKind, { short: true })}
            </b>
            {CREDIT_MARK[creditKind] && <span className="sb-demo-mark">{CREDIT_MARK[creditKind]}</span>}
            {usage > 0 ? ` · dùng ở ${usage} cảnh` : ' · chưa dùng'}
          </div>
        </div>
        <div className="sb-preset-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn btn-sm sb-apply"
            disabled={!n}
            title={n ? `Áp dụng cho ${n} cảnh đang chọn` : 'Chọn cảnh trên canvas / bảng cảnh trước'}
            onClick={apply}
          >
            Áp dụng{n > 1 ? ` · ${n}` : ''}
          </button>
          <button className={`icon-btn sb-xs${editing ? ' active' : ''}`} title={editing ? 'Thu gọn' : 'Sửa preset'} onClick={() => onEdit(editing ? null : preset.id)}>
            {editing ? <ChevronDown size={13} /> : <Pencil size={12} />}
          </button>
        </div>
      </div>
      {editing && <PresetEditor preset={preset} focusName={fresh} />}
    </div>
  )
})

export function PresetsPanel({
  collapsed,
  onToggle,
  onExpand,
}: {
  collapsed: boolean
  onToggle: () => void
  /** Open the section (no-op when open). */
  onExpand: () => void
}) {
  const presets = useProject((s) => s.project.presets)
  const usage = useProject(useShallow(presetUsageSelector))
  const selected = useSelectedSceneIds()
  /** Preset every selected scene runs with (null when mixed / none / changed since it was applied). */
  const activeId = useProject((s) => {
    if (!selected.length) return null
    let id: string | null | undefined
    for (const sc of s.project.scenes) {
      if (!selected.includes(sc.id)) continue
      const live = appliedPresetId(sc.presetId, sc.settings, s.project.presets)
      if (id === undefined) id = live
      else if (id !== live) return null
    }
    return id ?? null
  })
  const [editing, setEditing] = useState<string | null>(null)
  /** Preset created by "+ Preset" (its editor focuses the name); cleared by any other edit toggle. */
  const [fresh, setFresh] = useState<string | null>(null)
  const onEdit = useCallback((id: string | null) => {
    setFresh(null)
    setEditing(id)
  }, [])

  const add = () => {
    const st = useProject.getState()
    const from = selected.length ? st.project.scenes.find((s) => s.id === selected[0]) : undefined
    const src: Partial<VideoSettings> = from?.settings ?? st.project.presets[0] ?? {}
    // Copy only the video settings (never the id/name of another preset).
    const base: Partial<VideoSettings> = { model: src.model, mode: src.mode, duration: src.duration, resolution: src.resolution, ratio: src.ratio }
    // A scene on a newer build's model hands its marker over: scenes given this preset stay blocked like it.
    const marker = from?.foreignModel ? { foreignModel: from.foreignModel, foreignSettings: from.foreignSettings } : {}
    const id = st.addPreset({ ...base, ...marker, name: from ? 'Preset từ cảnh' : 'Preset mới' })
    // The header button also shows while the section is collapsed: open it so the new preset's editor is visible.
    onExpand()
    setFresh(id)
    setEditing(id)
    toast(from ? 'Đã tạo preset từ cấu hình của cảnh đang chọn — đặt tên cho nó.' : 'Đã tạo preset mới — đặt tên cho nó.', {
      tone: 'success',
      action: undoToastAction(),
    })
  }

  return (
    <Section
      className="sb-presets"
      title="Preset"
      icon={<SlidersHorizontal size={14} />}
      count={presets.length}
      collapsed={collapsed}
      onToggle={onToggle}
      grow={2}
      actions={
        <button
          className="btn btn-ghost btn-sm"
          onClick={add}
          title={selected.length ? 'Tạo preset từ cấu hình của cảnh đang chọn' : 'Thêm preset mới'}
        >
          <Plus size={13} />
          Preset
        </button>
      }
      toolbar={
        <div className="sb-explain">
          {selected.length ? (
            <>
              Bấm <b>Áp dụng</b> để đổi cấu hình cho <b className="sb-accent">{selected.length} cảnh đang chọn</b>.
            </>
          ) : (
            'Chọn cảnh rồi bấm Áp dụng để đổi model / thời lượng / độ phân giải.'
          )}
        </div>
      }
    >
      {!presets.length ? (
        <div className="empty sb-empty">
          <div>Chưa có preset.</div>
          <button className="btn btn-sm" onClick={add}>
            <Plus size={13} />
            Thêm preset
          </button>
        </div>
      ) : (
        <div className="sb-preset-list">
          {presets.map((p) => (
            <PresetRow
              key={p.id}
              preset={p}
              usage={usage[p.id] ?? 0}
              selected={selected}
              active={activeId === p.id}
              editing={editing === p.id}
              fresh={fresh === p.id}
              onEdit={onEdit}
            />
          ))}
        </div>
      )}
    </Section>
  )
}
