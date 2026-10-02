// Inspector for several selected scenes: batch settings, common reference images and videos, run / duplicate / delete.
import { ClipboardCopy, CopyPlus, Film, Info, Play, Plus, Trash, X } from 'lucide-react'
import { memo, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { focusNodes, linkAssets, linkTakes, requestRun, takeLabel } from '../../actions'
import { compileScene, sceneCode } from '../../core/compile'
import { costOf, usesVideoRefs } from '../../core/models'
import type { Asset, Scene } from '../../core/types'
import { undoToastAction, useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { STATUS_TEXT, useTakeInfos, type TakeInfo } from './hooks'
import { RefThumb, useImagePreview } from './ImagePreview'
import { flushPromptEditor } from './PromptEditor'
import { TakePicker } from './TakePicker'
import { patchFits, patchLabel, SettingsFields } from './SettingsFields'
import { AssetPicker, EMPTY_IDS, fmt, KIND_LABEL, Section } from './shared'

/** Commit any prompt being typed before a batch change renumbers tokens. */
const flushAll = (ids: string[]) => ids.forEach(flushPromptEditor)

export function MultiSceneInspector({ sceneIds }: { sceneIds: string[] }) {
  const scenes = useProject(
    useShallow((s) => {
      const set = new Set(sceneIds)
      return s.project.scenes.filter((x) => set.has(x.id))
    }),
  )
  const sorted = useMemo(() => [...scenes].sort((a, b) => a.order - b.order), [scenes])
  const ids = useMemo(() => sorted.map((s) => s.id), [sorted])
  if (!sorted.length) return null
  return (
    <div className="in-multi">
      <MultiHeader scenes={sorted} />
      <MultiSettings scenes={sorted} ids={ids} />
      <MultiRefs scenes={sorted} ids={ids} />
      <MultiVideoRefs scenes={sorted} ids={ids} />
      <MultiActions scenes={sorted} ids={ids} />
    </div>
  )
}

const MultiHeader = memo(function MultiHeader({ scenes }: { scenes: Scene[] }) {
  const total = scenes.reduce((t, s) => t + costOf(s.settings), 0)
  const seconds = scenes.reduce((t, s) => t + s.settings.duration, 0)
  const shown = scenes.slice(0, 18)
  return (
    <header className="in-head">
      <div className="in-head-row">
        <span className="in-code mono">{scenes.length}</span>
        <div className="in-head-title">
          <b>{scenes.length} cảnh đang chọn</b>
          <span className="faint">
            Chạy tất cả ≈ {fmt(total)} credit · {fmt(seconds)} giây video
          </span>
        </div>
      </div>
      <div className="in-codes">
        {shown.map((s) => (
          <button
            type="button"
            key={s.id}
            className="in-code-chip mono"
            title={`${sceneCode(s.order)}${s.title ? ' · ' + s.title : ''} — bấm để chỉ chọn cảnh này`}
            onClick={() => {
              useUI.getState().select([s.id])
              focusNodes([s.id])
            }}
          >
            {sceneCode(s.order)}
          </button>
        ))}
        {scenes.length > shown.length && <span className="in-code-chip more">+{scenes.length - shown.length}</span>}
      </div>
    </header>
  )
})

const MultiSettings = memo(function MultiSettings({ scenes, ids }: { scenes: Scene[]; ids: string[] }) {
  const presets = useProject((s) => s.project.presets)
  const settings = useMemo(() => scenes.map((s) => s.settings), [scenes])
  const presetIds = useMemo(() => scenes.map((s) => s.presetId), [scenes])
  return (
    <Section id="m-settings" title="Cấu hình video (áp dụng cho tất cả)">
      <SettingsFields
        settings={settings}
        presetIds={presetIds}
        presets={presets}
        onPatch={(patch) => {
          // A value only some of the models offer (480P is Seedance-only, 768P H3-only…) goes to the scenes that
          // support it; the others keep their setting instead of being clamped to another (often pricier) value.
          const fit = scenes.filter((s) => patchFits(s.settings.model, patch))
          if (fit.length) useProject.getState().updateSettings(fit.map((s) => s.id), patch)
          const skipped = scenes.filter((s) => !fit.includes(s))
          if (skipped.length) {
            const codes = skipped.slice(0, 4).map((s) => sceneCode(s.order)).join(', ') + (skipped.length > 4 ? '…' : '')
            toast(`${patchLabel(patch)} chỉ áp dụng cho ${fit.length} cảnh — giữ nguyên ${skipped.length} cảnh có model không hỗ trợ (${codes}).`, {
              tone: 'warning',
            })
          }
        }}
        onPreset={(id) => {
          useProject.getState().applyPreset(id, ids)
          const p = useProject.getState().project.presets.find((x) => x.id === id)
          toast(`Đã áp dụng preset “${p?.name ?? ''}” cho ${ids.length} cảnh.`, { tone: 'success', action: undoToastAction() })
        }}
      />
    </Section>
  )
})

const MultiRefs = memo(function MultiRefs({ scenes, ids }: { scenes: Scene[]; ids: string[] }) {
  const assets = useProject((s) => s.project.assets)
  const [picker, setPicker] = useState(false)
  const addBtn = useRef<HTMLButtonElement>(null)
  const union = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of scenes) for (const r of s.refs) counts.set(r, (counts.get(r) ?? 0) + 1)
    return [...counts.entries()]
      .map(([id, count]) => ({ asset: assets.find((a) => a.id === id), count }))
      .filter((x): x is { asset: Asset; count: number } => !!x.asset)
  }, [scenes, assets])
  const n = scenes.length
  const allIds = useMemo(() => union.filter((u) => u.count === n).map((u) => u.asset.id), [union, n])
  const preview = useImagePreview()

  const removeFromAll = (a: Asset) => {
    flushAll(ids)
    const pairs = scenes.filter((s) => s.refs.includes(a.id)).map((s) => ({ sceneId: s.id, assetId: a.id }))
    useProject.getState().removeRefs(pairs)
    toast(`Đã bỏ ${a.name} khỏi ${pairs.length} cảnh (số @image trong prompt được đánh lại).`, { action: undoToastAction() })
  }

  return (
    <Section id="m-refs" title="Ảnh tham chiếu chung" meta={<span className="badge">{union.length}</span>}>
      {union.length === 0 && <div className="in-refs-empty">Các cảnh đang chọn chưa có tham chiếu nào.</div>}
      <div className="in-refs">
        {union.map(({ asset: a, count }) => (
          <div key={a.id} className="in-ref is-multi">
            <RefThumb asset={a} preview={preview} />
            <button type="button" className="in-ref-name" onClick={() => useUI.getState().openDialog({ kind: 'asset', assetId: a.id })} title="Sửa chi tiết">
              <span className="in-ref-title">{a.name}</span>
              <span className="in-ref-tag">{KIND_LABEL[a.kind]}</span>
            </button>
            <span className={`in-token ${count === n ? '' : 'is-partial'}`} title={`Có trong ${count}/${n} cảnh`}>
              {count}/{n} cảnh
            </span>
            {count < n && (
              <button type="button" className="btn btn-sm btn-ghost in-mini" onClick={() => linkAssets(ids, [a.id])} title="Nối vào tất cả cảnh đang chọn">
                <Plus size={12} /> Tất cả
              </button>
            )}
            <button type="button" className="in-x" onClick={() => removeFromAll(a)} title="Bỏ khỏi tất cả cảnh đang chọn" aria-label={`Bỏ ${a.name} khỏi tất cả`}>
              <X size={13} />
            </button>
          </div>
        ))}
        {preview.preview}
      </div>
      <div className="in-pop-host">
        <button ref={addBtn} type="button" className="btn btn-sm btn-ghost in-add" onClick={() => setPicker((p) => !p)}>
          <Plus size={13} /> Thêm vào {n} cảnh
        </button>
        {picker && (
          <AssetPicker
            ignoreRef={addBtn}
            exclude={allIds}
            title={`Nối vào ${n} cảnh`}
            onClose={() => setPicker(false)}
            onPick={(id) => linkAssets(ids, [id])}
          />
        )}
      </div>
    </Section>
  )
})

const MultiVideoRefs = memo(function MultiVideoRefs({ scenes, ids }: { scenes: Scene[]; ids: string[] }) {
  const [picker, setPicker] = useState(false)
  const addBtn = useRef<HTMLButtonElement>(null)
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of scenes) for (const t of s.videoRefs) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  }, [scenes])
  const takeIds = useMemo(() => [...counts.keys()], [counts])
  const infos = useTakeInfos(takeIds)
  const n = scenes.length
  const allIds = useMemo(() => takeIds.filter((id) => counts.get(id) === n), [takeIds, counts, n])
  const accepting = scenes.filter((s) => usesVideoRefs(s.settings)).length

  const removeFromAll = (take: TakeInfo) => {
    flushAll(ids)
    const pairs = scenes.filter((s) => s.videoRefs.includes(take.id)).map((s) => ({ sceneId: s.id, takeId: take.id }))
    // A deleted take has no "S03·T2" label (takeLabel falls back to "video"): its tokens become plain "video".
    const label = take.status ? takeLabel(take.id) : 'đã xoá'
    // One undo step; @video_N tokens of the removed video become "video S03·T2" and the others are renumbered.
    useProject.getState().deleteItems({ videoRefs: pairs }, () => (take.status ? 'video ' + label : 'video'))
    toast(`Đã bỏ video ${label} khỏi ${pairs.length} cảnh (số @video trong prompt được đánh lại).`, { action: undoToastAction() })
  }

  return (
    <Section id="m-vrefs" title="Video tham chiếu chung" meta={<span className="badge">{takeIds.length}</span>}>
      {takeIds.length === 0 && <div className="in-refs-empty">Các cảnh đang chọn chưa dùng video tham chiếu nào.</div>}
      <div className="in-refs">
        {infos.map((t) => {
          const count = counts.get(t.id) ?? 0
          return (
            <div key={t.id} className="in-ref in-vref is-multi">
              <span className="in-vref-thumb">{t.posterId ? <MediaImg id={t.posterId} className="media-img" /> : <Film size={13} />}</span>
              <span className="in-ref-name is-static">
                <span className="in-ref-title">{t.label}</span>
                <span className="in-ref-tag">{t.status ? STATUS_TEXT[t.status] : 'Take đã bị xoá'}</span>
              </span>
              <span className={`in-token is-video ${count === n ? '' : 'is-partial'}`} title={`Có trong ${count}/${n} cảnh`}>
                {count}/{n} cảnh
              </span>
              {count < n && t.status === 'completed' && (
                <button type="button" className="btn btn-sm btn-ghost in-mini" onClick={() => linkTakes(ids, [t.id])} title="Dùng cho tất cả cảnh đang chọn">
                  <Plus size={12} /> Tất cả
                </button>
              )}
              <button type="button" className="in-x" onClick={() => removeFromAll(t)} title="Bỏ khỏi tất cả cảnh đang chọn" aria-label={`Bỏ ${t.label} khỏi tất cả`}>
                <X size={13} />
              </button>
            </div>
          )
        })}
      </div>
      {accepting < n && (
        <div className="in-note">
          <Info size={13} />
          <span>{n - accepting} cảnh có model/chế độ không nhận video tham chiếu — sẽ được bỏ qua khi thêm.</span>
        </div>
      )}
      {accepting > 0 && (
        <div className="in-pop-host">
          <button ref={addBtn} type="button" className="btn btn-sm btn-ghost in-add" onClick={() => setPicker((p) => !p)}>
            <Plus size={13} /> Thêm video vào {n} cảnh
          </button>
          {picker && (
            <TakePicker
              excludeSceneIds={EMPTY_IDS}
              exclude={allIds}
              ignoreRef={addBtn}
              title={`Dùng video cho ${n} cảnh`}
              onClose={() => setPicker(false)}
              onPick={(takeId) => linkTakes(ids, [takeId])}
            />
          )}
        </div>
      )}
    </Section>
  )
})

const MultiActions = memo(function MultiActions({ scenes, ids }: { scenes: Scene[]; ids: string[] }) {
  const total = scenes.reduce((t, s) => t + costOf(s.settings), 0)
  const onDuplicate = () => {
    const created = useProject.getState().duplicateScenes(ids)
    useUI.getState().select(created)
    toast(`Đã nhân bản ${created.length} cảnh.`, { tone: 'success', action: undoToastAction() })
  }
  const onDelete = () => {
    useProject.getState().removeScenes(ids)
    const keep = useUI.getState().selectedIds.filter((id) => !ids.includes(id))
    useUI.getState().select(keep)
    toast(`Đã xoá ${ids.length} cảnh.`, { action: undoToastAction() })
  }
  const onCopyAll = async () => {
    const project = useProject.getState().project
    const list = project.scenes.filter((s) => ids.includes(s.id)).sort((a, b) => a.order - b.order)
    const text = list
      .map((s) => `=== ${sceneCode(s.order)}${s.title ? ' · ' + s.title : ''} ===\n${compileScene(project, s).text}`)
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      toast(`Đã copy prompt của ${list.length} cảnh (${fmt([...text].length)} ký tự).`, { tone: 'success' })
    } catch {
      toast('Trình duyệt chặn clipboard.', { tone: 'error' })
    }
  }
  return (
    <section className="in-section in-multi-actions">
      <button type="button" className="btn btn-primary btn-lg in-run" onClick={() => requestRun(ids)}>
        <Play size={14} fill="currentColor" /> Chạy {ids.length} cảnh · {fmt(total)} credit
      </button>
      <div className="in-action-row">
        <button type="button" className="btn btn-sm" onClick={onDuplicate} title="Ctrl+D">
          <CopyPlus size={13} /> Nhân bản
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void onCopyAll()}>
          <ClipboardCopy size={13} /> Copy tất cả prompt
        </button>
        <button type="button" className="btn btn-sm btn-danger" onClick={onDelete} title="Delete">
          <Trash size={13} /> Xoá
        </button>
      </div>
    </section>
  )
})
