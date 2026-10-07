// Inspector for several selected scenes: batch settings, common reference images, run / duplicate / delete (and the
// explicit removal of retired @video text, src/videoRetired.ts).
import { CircleAlert, ClipboardCopy, CopyPlus, Play, Plus, Trash, X } from 'lucide-react'
import { memo, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { focusNodes, linkAssets, requestRun } from '../../actions'
import { compileScene, hasRetiredVideoToken, sceneCode } from '../../core/compile'
import type { Asset, Scene } from '../../core/types'
import { formatCredits } from '../../lib/credits'
import { activeProviderId, providerLimits } from '../../providers'
import { limitsSite } from '../../providers/limits'
import { useCreditKind } from '../../store/credits'
import { undoToastAction, useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { appliedPresetId, changedPrompts, costTitle, creditTone, scenesWithStaleTokens, staleTokenNote, totalCost } from '../sidebar/shared'
import { RefThumb, useImagePreview } from './ImagePreview'
import { flushPromptEditor } from './PromptEditor'
import { patchFits, patchLabel, SettingsFields } from './SettingsFields'
import { batchSkipText, patchFitsLimits } from './settingsLimits'
import { AssetPicker, fmt, KIND_LABEL, Section } from './shared'
import { removeRetiredTextFromScenes } from '../../videoRetired'

/** Commit any prompt being typed before a batch change renumbers tokens. */
const flushAll = (ids: string[]) => ids.forEach(flushPromptEditor)

/**
 * Run a batch image removal and report it: prompts renumbered by the store, or — automatic renumbering off —
 * prompts left with @image numbers that now point elsewhere (warning naming the scenes).
 */
function removeAndReport(run: () => void, done: string, what: '@image') {
  const before = useProject.getState().project
  run()
  const after = useProject.getState().project
  const stale = scenesWithStaleTokens(before, after)
  if (stale.length) {
    toast(`${done}${staleTokenNote(after, stale, what)}.`, { tone: 'warning', ms: 8000, action: undoToastAction() })
    return
  }
  const rewritten = changedPrompts(before.scenes, after.scenes).length
  toast(`${done}${rewritten ? ` · đánh lại số ${what} trong ${rewritten} prompt` : ''}.`, { action: undoToastAction() })
}

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
      <MultiRetired scenes={sorted} />
      <MultiActions scenes={sorted} ids={ids} />
    </div>
  )
}

const MultiHeader = memo(function MultiHeader({ scenes }: { scenes: Scene[] }) {
  const creditKind = useCreditKind()
  const total = totalCost(scenes)
  const seconds = scenes.reduce((t, s) => t + s.settings.duration, 0)
  const shown = scenes.slice(0, 18)
  return (
    <header className="in-head">
      <div className="in-head-row">
        <span className="in-code mono">{scenes.length}</span>
        <div className="in-head-title">
          <b>{scenes.length} cảnh đang chọn</b>
          <span className="faint">
            Chạy tất cả ≈{' '}
            <span className={`in-cost-text ${creditTone(creditKind)}`} title={costTitle(total, creditKind, `Chạy ${scenes.length} cảnh · `)}>
              {formatCredits(total, creditKind)}
            </span>{' '}
            · {fmt(seconds)} giây video
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
  // Scenes on a newer build's model show it in the model picker (not the stand-in model of their `settings`).
  const foreignModels = useMemo(() => scenes.map((s) => s.foreignModel), [scenes])
  const codes = useMemo(() => scenes.map((s) => sceneCode(s.order)), [scenes])
  // A preset edited after it was applied no longer describes the scene ("Tuỳ chỉnh"; picking it re-applies it).
  const presetIds = useMemo(() => scenes.map((s) => appliedPresetId(s.presetId, s.settings, presets)), [scenes, presets])
  return (
    <Section id="m-settings" title="Cấu hình video (áp dụng cho tất cả)">
      <SettingsFields
        settings={settings}
        foreignModels={foreignModels}
        presetIds={presetIds}
        presets={presets}
        codes={codes}
        onPatch={(patch) => {
          // A value only some of the models offer (480P is Seedance-only, 768P H3-only…) goes to the scenes that
          // support it; the others keep their setting instead of being clamped to another (often pricier) value.
          // Same for a value the gateway surely refuses for some of them now (/api/video-profiles, a firm read).
          const provider = activeProviderId()
          const limits = providerLimits(provider)
          const byModel = scenes.filter((s) => patchFits(s.settings.model, patch))
          const fit = byModel.filter((s) => patchFitsLimits(s.settings, patch, limits))
          if (fit.length) useProject.getState().updateSettings(fit.map((s) => s.id), patch)
          const skipped = scenes.filter((s) => !fit.includes(s))
          if (skipped.length) {
            const codes = skipped.map((s) => sceneCode(s.order))
            toast(batchSkipText(patchLabel(patch), fit.length, codes, scenes.length - byModel.length, limitsSite(provider)), { tone: 'warning' })
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
    removeAndReport(() => useProject.getState().removeRefs(pairs), `Đã bỏ ${a.name} khỏi ${pairs.length} cảnh`, '@image')
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

/**
 * Retired @video text in the selected scenes (reference videos were retired in 0.6.0): kept as written, it blocks
 * those scenes. One explicit button removes it from all of them in ONE undo step (src/videoRetired.ts) — the
 * "Continue from @video_N: " starter older builds wrote first, then every remaining token; nothing else changes.
 */
const MultiRetired = memo(function MultiRetired({ scenes }: { scenes: Scene[] }) {
  const blocked = useMemo(() => scenes.filter((s) => hasRetiredVideoToken(s.prompt)), [scenes])
  if (!blocked.length) return null
  const ids = blocked.map((s) => s.id)
  const codes = blocked.map((s) => sceneCode(s.order))
  return (
    <section className="in-section">
      <div className="in-retired" role="note">
        <span className="in-retired-text">
          <CircleAlert size={12} />
          <span>
            {blocked.length} cảnh còn chữ @video ({codes.slice(0, 6).join(', ')}
            {codes.length > 6 ? '…' : ''}): SanoVids đã bỏ video tham chiếu — các cảnh đó chưa chạy được cho tới khi sửa.
          </span>
        </span>
        <span className="in-retired-actions">
          <button
            type="button"
            className="in-hint-btn"
            onClick={() => removeRetiredTextFromScenes(ids)}
            title="Chỉ xoá chữ @video (và câu “Continue from @video_N:” bản cũ tự chèn) — chữ khác giữ nguyên, Ctrl+Z để hoàn tác"
          >
            Xoá chữ @video ở {blocked.length} cảnh đang chọn
          </button>
        </span>
      </div>
    </section>
  )
})

const MultiActions = memo(function MultiActions({ scenes, ids }: { scenes: Scene[]; ids: string[] }) {
  const creditKind = useCreditKind()
  const total = totalCost(scenes)
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
      <button
        type="button"
        className="btn btn-primary btn-lg in-run"
        onClick={() => requestRun(ids)}
        title={costTitle(total, creditKind, `Xem chi phí và chạy ${ids.length} cảnh · `)}
      >
        <Play size={14} fill="currentColor" /> Chạy {ids.length} cảnh ·<span className={`in-run-cost ${creditTone(creditKind)}`}>{formatCredits(total, creditKind)}</span>
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
