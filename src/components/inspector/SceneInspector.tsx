// Inspector for one scene. Every section subscribes to the narrow slice it needs, so typing in the
// prompt (or the title / note) does not re-render the whole panel.
import { ArrowRight, ChevronLeft, ChevronRight, CopyPlus, CornerDownRight, Download, Film, FlaskConical, GripVertical, Info, Play, Plus, Star, Trash, TriangleAlert, X } from 'lucide-react'
import { memo, useMemo, useRef, useState, type DragEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createAssetsFromFiles, createSceneFromTake, downloadTake, focusNodes, linkAssets, linkTakes, nextScene, requestRun, revealNodes, takeLabel } from '../../actions'
import { compileScene, sceneCode } from '../../core/compile'
import { costOf, modeLabel, MODELS, usesRefs, usesVideoRefs } from '../../core/models'
import type { Asset } from '../../core/types'
import { formatCredits, isSimulatedCredit } from '../../lib/credits'
import { ASSETS_MIME, readIds, TAKES_MIME } from '../../lib/dnd'
import { useDownloadPrefs } from '../../lib/downloads'
import { useCreditKind } from '../../store/credits'
import { undoToastAction, useProject } from '../../store/project'
import { useSceneTakes } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { AssetAvatar, MediaImg } from '../common/Media'
import { appliedPresetId, costTitle, creditTone, NO_VIDEO_REFS_REASON, scenesWithStaleTokens, staleTokenNote } from '../sidebar/shared'
import { TakeStrip } from '../runs/TakeStrip'
import { FinalPromptPreview } from './FinalPromptPreview'
import { RefThumb, useImagePreview } from './ImagePreview'
import { STATUS_TEXT, useTakeInfos, type TakeInfo } from './hooks'
import { flushPromptEditor, PromptEditor } from './PromptEditor'
import { SettingsFields } from './SettingsFields'
import { AssetPicker, EMPTY_IDS, KIND_LABEL, Section, useSceneField } from './shared'
import { TakePicker } from './TakePicker'
import { imageOptsFor, legacyAssets, replaceLegacyTags } from './tokens'
import { useReorder } from './useReorder'

/** Row reordering inside the lists below (drag payload = row index). Library cards / takes use src/lib/dnd.ts. */
const REF_MIME = 'application/x-bdp-refidx'
const VREF_MIME = 'application/x-bdp-vrefidx'
const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files')
const isTakeDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(TAKES_MIME)

export function SceneInspector({ sceneId }: { sceneId: string }) {
  const exists = useProject((s) => s.project.scenes.some((x) => x.id === sceneId))
  if (!exists) return null
  return (
    <div className="in-scene">
      <SceneHeader sceneId={sceneId} />
      <SettingsSection sceneId={sceneId} />
      <Section id="prompt" title="Prompt">
        <PromptEditor sceneId={sceneId} />
      </Section>
      <RefsSection sceneId={sceneId} />
      <VideoRefsSection sceneId={sceneId} />
      <FinalPromptPreview sceneId={sceneId} />
      <TakesSection sceneId={sceneId} />
      <NoteSection sceneId={sceneId} />
    </div>
  )
}

// ---------------- helpers ----------------
const promptOf = (sceneId: string) => useProject.getState().project.scenes.find((s) => s.id === sceneId)?.prompt

/**
 * Run a refs / videoRefs change (the store renumbers @image_N / @video_N tokens in the same undo step) and tell
 * the user what it did to the prompt: renumbered it, or — automatic renumbering off (Settings) — left tokens that
 * now point at another image / video (warning). Pending typing is committed first so it is renumbered too.
 * `done`: what was changed ("Đã bỏ nối Elara"); announced on its own only when `plain`.
 */
function changeMedia(sceneId: string, run: () => void, msg: { done: string; renumbered: string; plain?: boolean; what?: string }) {
  flushPromptEditor(sceneId)
  const before = useProject.getState().project
  run()
  const after = useProject.getState().project
  const stale = scenesWithStaleTokens(before, after)
  const promptBefore = before.scenes.find((s) => s.id === sceneId)?.prompt
  if (stale.length) toast(`${msg.done}${staleTokenNote(after, stale, msg.what)}.`, { tone: 'warning', ms: 8000, action: undoToastAction() })
  else if (promptOf(sceneId) !== promptBefore) toast(msg.renumbered, { tone: 'info', action: undoToastAction() })
  else if (msg.plain) toast(`${msg.done}.`, { action: undoToastAction() })
}

/** Tooltip of a reorder grip: the token numbers follow only while automatic renumbering is on. */
function gripTitle(autoRenumber: boolean, what: '@image' | '@video'): string {
  return autoRenumber
    ? `Kéo để đổi thứ tự (↑/↓) — số ${what} trong prompt tự cập nhật`
    : `Kéo để đổi thứ tự (↑/↓) — tự đánh lại số đang tắt (Cài đặt): số ${what} trong prompt sẽ trỏ sang ${what === '@image' ? 'ảnh' : 'video'} khác`
}

// ---------------- 1. header ----------------
interface SceneOpt {
  id: string
  order: number
  title: string
}
const SEP = '\u0001'

/** Stable list of all scenes (id/order/title), sorted by order. */
function useSceneOptions(): SceneOpt[] {
  const keys = useProject(useShallow((s) => s.project.scenes.map((x) => `${x.order}${SEP}${x.id}${SEP}${x.title}`)))
  return useMemo(
    () =>
      keys
        .map((k) => {
          const [order, id, title] = k.split(SEP)
          return { id, order: Number(order), title }
        })
        .sort((a, b) => a.order - b.order),
    [keys],
  )
}

function goTo(id: string) {
  useUI.getState().select([id])
  focusNodes([id])
}

const SceneHeader = memo(function SceneHeader({ sceneId }: { sceneId: string }) {
  const order = useSceneField(sceneId, (s) => s.order) ?? 0
  const title = useSceneField(sceneId, (s) => s.title) ?? ''
  const options = useSceneOptions()
  const idx = options.findIndex((o) => o.id === sceneId)
  const prev = idx > 0 ? options[idx - 1] : undefined
  const next = idx >= 0 && idx < options.length - 1 ? options[idx + 1] : undefined

  const onDuplicate = () => {
    const created = useProject.getState().duplicateScenes([sceneId])
    if (created[0]) {
      useUI.getState().select(created)
      revealNodes(created)
    }
    toast('Đã nhân bản cảnh.', { tone: 'success', action: undoToastAction() })
  }
  const onDelete = () => {
    useProject.getState().removeScenes([sceneId])
    useUI.getState().clearSelection()
    toast(`Đã xoá ${sceneCode(order)}.`, { action: undoToastAction() })
  }

  return (
    <header className="in-head">
      <div className="in-head-row">
        <span className="in-code mono">{sceneCode(order)}</span>
        <input
          className="in-title-input"
          value={title}
          placeholder="Chưa đặt tên"
          onChange={(e) => useProject.getState().updateScene(sceneId, { title: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          aria-label="Tên cảnh"
        />
        <div className="in-head-nav">
          <button type="button" className="icon-btn in-icon-sm" disabled={!prev} onClick={() => prev && goTo(prev.id)} title={prev ? `Cảnh trước: ${sceneCode(prev.order)}` : 'Đây là cảnh đầu'}>
            <ChevronLeft size={15} />
          </button>
          <button type="button" className="icon-btn in-icon-sm" disabled={!next} onClick={() => next && goTo(next.id)} title={next ? `Cảnh sau: ${sceneCode(next.order)}` : 'Đây là cảnh cuối'}>
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      <div className="in-head-row in-head-sub">
        <div className="in-head-actions">
          <button type="button" className="icon-btn in-icon-sm" onClick={() => nextScene()} title="Tạo cảnh tiếp theo bên dưới (N) — giữ ảnh/video tham chiếu và cấu hình">
            <ArrowRight size={14} />
          </button>
          <button type="button" className="icon-btn in-icon-sm" onClick={onDuplicate} title="Nhân bản cảnh (Ctrl+D)">
            <CopyPlus size={14} />
          </button>
          <button type="button" className="icon-btn in-icon-sm in-danger-hover" onClick={onDelete} title="Xoá cảnh (Delete)">
            <Trash size={14} />
          </button>
          <button type="button" className="btn btn-primary btn-sm in-head-run" onClick={() => requestRun([sceneId])} title="Chạy cảnh này (Ctrl+Enter)">
            <Play size={12} fill="currentColor" /> Chạy
          </button>
        </div>
      </div>
    </header>
  )
})

// ---------------- 2. video settings ----------------
const SettingsSection = memo(function SettingsSection({ sceneId }: { sceneId: string }) {
  const settings = useSceneField(sceneId, (s) => s.settings)
  const storedPresetId = useSceneField(sceneId, (s) => s.presetId) ?? null
  const presets = useProject((s) => s.project.presets)
  const list = useMemo(() => (settings ? [settings] : []), [settings])
  // A preset edited after it was applied no longer describes the scene: show "Tuỳ chỉnh" (picking it re-applies it).
  const presetId = settings ? appliedPresetId(storedPresetId, settings, presets) : null
  const presetIds = useMemo(() => [presetId], [presetId])
  const creditKind = useCreditKind()
  if (!settings) return null
  const preset = presets.find((p) => p.id === presetId)
  const cost = costOf(settings)
  return (
    <Section
      id="settings"
      title="Cấu hình video"
      meta={
        <span className="in-meta">
          {preset && <span className="badge">{preset.name}</span>}
          <span className={`badge in-cost ${creditTone(creditKind)}`} title={costTitle(cost, creditKind, 'Mỗi lần chạy · ')}>
            {isSimulatedCredit(creditKind) && <FlaskConical size={11} />}
            {formatCredits(cost, creditKind)}
          </span>
        </span>
      }
    >
      <SettingsFields
        settings={list}
        presetIds={presetIds}
        presets={presets}
        onPatch={(patch) => useProject.getState().updateSettings([sceneId], patch)}
        onPreset={(id) => useProject.getState().applyPreset(id, [sceneId])}
      />
    </Section>
  )
})

// ---------------- 3. reference images (@image_N) ----------------
function tokensLabel(ns: number[]): string {
  if (!ns.length) return ''
  if (ns.length <= 2) return ns.map((n) => `@image_${n}`).join(', ')
  return `@image_${ns[0]}…${ns[ns.length - 1]}`
}

/** Remove a ref (tokens renumber); offer to turn a remaining legacy @Tag into the name (it would re-link). */
function removeRef(sceneId: string, asset: Asset) {
  changeMedia(sceneId, () => useProject.getState().removeRef(sceneId, asset.id), {
    done: `Đã bỏ nối ${asset.name}`,
    renumbered: `Đã bỏ nối ${asset.name} — đã đánh lại số trong prompt (ảnh của ${asset.name} đổi thành tên).`,
    plain: true,
  })
  const prompt = promptOf(sceneId) ?? ''
  if (!legacyAssets(prompt, [asset]).length) return
  toast(`Prompt vẫn nhắc @${asset.tag} nên sẽ tự nối lại khi sửa prompt.`, {
    tone: 'warning',
    ms: 8000,
    action: {
      label: 'Đổi @ thành tên',
      run: () => {
        const cur = promptOf(sceneId)
        if (cur === undefined) return
        const { text } = replaceLegacyTags(cur, new Map([[asset.tag.toLowerCase(), asset.name]]))
        useProject.getState().updateScene(sceneId, { prompt: text })
      },
    },
  })
}

const RefsSection = memo(function RefsSection({ sceneId }: { sceneId: string }) {
  const refs = useSceneField(sceneId, (s) => s.refs) ?? EMPTY_IDS
  const settings = useSceneField(sceneId, (s) => s.settings)
  const assets = useProject((s) => s.project.assets)
  const autoRenumber = useProject((s) => s.project.settings.autoRenumber)
  const [picker, setPicker] = useState(false)
  const addBtn = useRef<HTMLButtonElement>(null)
  /** What is being dragged over the list from outside: library cards or image files. */
  const [libOver, setLibOver] = useState<'assets' | 'files' | null>(null)

  const slots = useMemo(() => imageOptsFor(assets, refs), [assets, refs])
  // Rows keep their index in scene.refs: refs may hold ids of deleted assets (e.g. restored from an old take),
  // and moveRef works on the raw list.
  const rows = useMemo(
    () =>
      refs.flatMap((id, index) => {
        const a = assets.find((x) => x.id === id)
        return a ? [{ a, index }] : []
      }),
    [refs, assets],
  )
  const moveRow = (from: number, to: number) => {
    if (from === to || !rows[from] || !rows[to]) return
    changeMedia(sceneId, () => useProject.getState().moveRef(sceneId, rows[from].index, rows[to].index), {
      done: 'Đã đổi thứ tự ảnh tham chiếu',
      renumbered: 'Đã đánh lại số trong prompt.',
    })
  }
  const reorder = useReorder(rows.length, REF_MIME, moveRow)
  const preview = useImagePreview()
  if (!settings) return null

  const spec = MODELS[settings.model]
  const sends = usesRefs(settings)
  const over = sends && slots.length > spec.maxRefImages
  const sent = sends ? Math.min(slots.length, spec.maxRefImages) : 0
  const isLibDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(ASSETS_MIME)

  return (
    <Section
      id="refs"
      title="Ảnh tham chiếu"
      meta={
        <span className="in-meta">
          <span className={`badge ${over ? 'danger' : sent ? 'ref' : ''}`} title="Số ảnh gửi kèm / giới hạn của model">
            {sends ? `${sent}/${spec.maxRefImages} ảnh` : 'không gửi ảnh'}
          </span>
        </span>
      }
    >
      <div
        className={`in-refs ${libOver ? 'is-lib-over' : ''}`}
        onDragOver={(e) => {
          const kind = isLibDrag(e) ? 'assets' : hasFiles(e.dataTransfer) ? 'files' : null
          if (!kind) return
          e.preventDefault()
          e.dataTransfer.dropEffect = kind === 'assets' ? 'link' : 'copy'
          if (libOver !== kind) setLibOver(kind)
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setLibOver(null)
        }}
        onDrop={(e) => {
          if (!isLibDrag(e)) {
            if (!hasFiles(e.dataTransfer)) return
            // Image files: add them to the library, then link them here (same as dropping on the scene card).
            e.preventDefault()
            setLibOver(null)
            const files = Array.from(e.dataTransfer.files)
            void createAssetsFromFiles(files).then((created) => linkAssets([sceneId], created))
            return
          }
          e.preventDefault()
          setLibOver(null)
          const ids = readIds(e.dataTransfer, ASSETS_MIME)
          if (ids.length) linkAssets([sceneId], ids)
        }}
      >
        {rows.length === 0 && (
          <div className="in-refs-empty">
            Chưa có ảnh tham chiếu. Gõ <span className="kbd">@</span> trong prompt, kéo nhân vật từ thư viện vào đây, hoặc bấm “Thêm ảnh”.
          </div>
        )}
        {rows.map(({ a }, i) => {
          const ns = slots.filter((s) => s.assetId === a.id).map((s) => s.n)
          const sentNs = ns.filter((n) => n <= spec.maxRefImages)
          return (
            <div key={a.id} className={`in-ref ${reorder.rowClass(i)}`} {...reorder.rowProps(i)}>
              <button type="button" className="in-grip" title={gripTitle(autoRenumber, '@image')} aria-label={`Đổi thứ tự ${a.name}`} onKeyDown={reorder.gripKeyDown(i)}>
                <GripVertical size={13} />
              </button>
              <RefThumb asset={a} preview={preview} />
              <button type="button" className="in-ref-name" onClick={() => useUI.getState().openDialog({ kind: 'asset', assetId: a.id })} title="Sửa chi tiết">
                <span className="in-ref-title">{a.name}</span>
                <span className="in-ref-tag">
                  {KIND_LABEL[a.kind]}
                  {a.imageIds.length > 1 ? ` · ${a.imageIds.length} ảnh` : ''}
                </span>
              </button>
              {!ns.length ? (
                <span className="in-token is-off" title="Chưa có ảnh — không được gửi">
                  chưa có ảnh
                </span>
              ) : !sends ? (
                <span className="in-token is-off" title="Chế độ này không gửi ảnh tham chiếu">
                  {tokensLabel(ns)}
                </span>
              ) : sentNs.length ? (
                <span className="in-token" title={ns.map((n) => `@image_${n}`).join(', ')}>
                  {tokensLabel(ns)}
                </span>
              ) : (
                <span className="in-token is-off" title="Vượt giới hạn ảnh — không được gửi">
                  vượt giới hạn
                </span>
              )}
              <button type="button" className="in-x" onClick={() => removeRef(sceneId, a)} title="Bỏ nối" aria-label={`Bỏ nối ${a.name}`}>
                <X size={13} />
              </button>
            </div>
          )
        })}
        {libOver && <div className="in-refs-drop">{libOver === 'files' ? 'Thả ảnh để thêm vào thư viện và nối vào cảnh này' : 'Thả để nối vào cảnh này'}</div>}
        {preview.preview}
      </div>

      {over && (
        <div className="in-note danger">
          <TriangleAlert size={13} />
          <span>
            {spec.name} nhận tối đa {spec.maxRefImages} ảnh; đang có {slots.length} ảnh — {slots.length - spec.maxRefImages} ảnh cuối sẽ bị bỏ.
          </span>
        </div>
      )}
      {!sends && (
        <div className="in-note">
          <Info size={13} />
          <span>
            Chế độ “{modeLabel(settings.mode, settings.model)}” của {spec.name} không gửi ảnh tham chiếu.
          </span>
        </div>
      )}

      <div className="in-pop-host">
        <button ref={addBtn} type="button" className="btn btn-sm btn-ghost in-add" onClick={() => setPicker((p) => !p)}>
          <Plus size={13} /> Thêm ảnh
        </button>
        {picker && (
          <AssetPicker exclude={refs} ignoreRef={addBtn} title="Nối vào cảnh" onClose={() => setPicker(false)} onPick={(id) => linkAssets([sceneId], [id])} />
        )}
      </div>

      {settings.mode === 'transform' && <FramesSlots sceneId={sceneId} assets={assets} />}
    </Section>
  )
})

function FramesSlots({ sceneId, assets }: { sceneId: string; assets: Asset[] }) {
  const first = useSceneField(sceneId, (s) => s.firstFrame) ?? null
  const last = useSceneField(sceneId, (s) => s.lastFrame) ?? null
  return (
    <div className="in-frames">
      <FrameSlot sceneId={sceneId} which="first" label="Khung đầu" assetId={first} assets={assets} />
      <FrameSlot sceneId={sceneId} which="last" label="Khung cuối" assetId={last} assets={assets} />
    </div>
  )
}

function FrameSlot({ sceneId, which, label, assetId, assets }: { sceneId: string; which: 'first' | 'last'; label: string; assetId: string | null; assets: Asset[] }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const asset = assetId ? assets.find((a) => a.id === assetId) : undefined
  // The frame is sent as the whole picture: hovering shows it in full (the avatar is a square crop).
  const preview = useImagePreview()
  return (
    <div className={`in-frame is-${which}`}>
      <span className="in-frame-label">{label}</span>
      <button
        ref={btn}
        type="button"
        className={`in-frame-btn ${asset ? 'has' : ''}`}
        onClick={() => {
          preview.hide()
          setOpen((o) => !o)
        }}
        onMouseEnter={(e) => asset && !open && preview.show(e.currentTarget, asset.imageIds[0], `${label} · ${asset.name}`)}
        onMouseLeave={preview.hide}
      >
        {asset ? (
          <>
            <AssetAvatar asset={asset} size={30} />
            <span className="in-frame-name">
              <b>{asset.name}</b>
              <span className="faint">{KIND_LABEL[asset.kind]}</span>
            </span>
          </>
        ) : (
          <span className="faint">
            <Plus size={12} /> Chọn ảnh…
          </span>
        )}
      </button>
      {asset && (
        <button type="button" className="in-x in-frame-x" onClick={() => useProject.getState().setFrame(sceneId, which, null)} title="Bỏ khung" aria-label={`Bỏ ${label}`}>
          <X size={12} />
        </button>
      )}
      {preview.preview}
      {open && (
        <AssetPicker
          ignoreRef={btn}
          title={label}
          checked={assetId ? [assetId] : []}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            useProject.getState().setFrame(sceneId, which, id)
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

// ---------------- 4. reference videos (@video_N) ----------------
function removeVideoRef(sceneId: string, take: TakeInfo) {
  const label = take.status ? takeLabel(take.id) : 'đã xoá'
  // A @video_N token of the removed video becomes plain text ("video S03·T2").
  changeMedia(sceneId, () => useProject.getState().removeVideoRef(sceneId, take.id, take.status ? 'video ' + label : 'video'), {
    done: `Đã bỏ video ${label}`,
    renumbered: `Đã bỏ video ${label} — đã đánh lại số @video trong prompt.`,
    plain: true,
    what: '@video',
  })
}

const VideoRefsSection = memo(function VideoRefsSection({ sceneId }: { sceneId: string }) {
  const videoRefs = useSceneField(sceneId, (s) => s.videoRefs) ?? EMPTY_IDS
  const settings = useSceneField(sceneId, (s) => s.settings)
  const infos = useTakeInfos(videoRefs)
  const autoRenumber = useProject((s) => s.project.settings.autoRenumber)
  const [picker, setPicker] = useState(false)
  const addBtn = useRef<HTMLButtonElement>(null)
  /** Generated videos (takes) dragged over the list from the canvas strip / sidebar. */
  const [takeOver, setTakeOver] = useState(false)
  const moveRow = (from: number, to: number) =>
    changeMedia(sceneId, () => useProject.getState().moveVideoRef(sceneId, from, to), {
      done: 'Đã đổi thứ tự video tham chiếu',
      renumbered: 'Đã đánh lại số trong prompt.',
      what: '@video',
    })
  const reorder = useReorder(infos.length, VREF_MIME, moveRow)
  if (!settings) return null

  const spec = MODELS[settings.model]
  const sends = usesVideoRefs(settings)
  const over = sends && videoRefs.length > spec.maxRefVideos
  if (!sends && !videoRefs.length) {
    return (
      <Section id="vrefs" title="Video tham chiếu" meta={<span className="in-meta"><span className="badge">không nhận video</span></span>} defaultOpen={false}>
        <div className="in-note">
          <Info size={13} />
          <span>
            {spec.name} ở chế độ “{modeLabel(settings.mode, settings.model)}” không nhận video tham chiếu (@video). Dùng Seedance 2.5, hoặc chế độ “{modeLabel('i2v', 'minimax_h3')}” của MiniMax-H3.
          </span>
        </div>
      </Section>
    )
  }

  return (
    <Section
      id="vrefs"
      title="Video tham chiếu"
      meta={
        <span className="in-meta">
          <span className={`badge ${over || !sends ? 'danger' : videoRefs.length ? 'video' : ''}`} title="Số video gửi kèm / giới hạn của model">
            {sends ? `${Math.min(videoRefs.length, spec.maxRefVideos)}/${spec.maxRefVideos} video` : 'không nhận video'}
          </span>
        </span>
      }
    >
      <div
        className={`in-refs ${takeOver ? 'is-take-over' : ''}`}
        onDragOver={(e) => {
          if (!isTakeDrag(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = e.dataTransfer.effectAllowed === 'link' ? 'link' : 'copy'
          if (!takeOver) setTakeOver(true)
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setTakeOver(false)
        }}
        onDrop={(e) => {
          if (!isTakeDrag(e)) return
          e.preventDefault()
          setTakeOver(false)
          const ids = readIds(e.dataTransfer, TAKES_MIME)
          if (ids.length) linkTakes([sceneId], ids)
        }}
      >
        {infos.length === 0 && (
          <div className="in-refs-empty">
            Chưa có video tham chiếu. Kéo một video (take) vào đây hoặc nối dây từ video trên canvas vào cảnh này, hoặc bấm “Thêm video”. Video được gọi trong prompt bằng{' '}
            <span className="mono">@video_1</span>…
          </div>
        )}
        {infos.map((t, i) => {
          const n = i + 1
          const off = !sends || n > spec.maxRefVideos
          return (
            <div key={t.id} className={`in-ref in-vref ${reorder.rowClass(i)}`} {...reorder.rowProps(i)}>
              <button type="button" className="in-grip" title={gripTitle(autoRenumber, '@video')} aria-label={`Đổi thứ tự ${t.label}`} onKeyDown={reorder.gripKeyDown(i)}>
                <GripVertical size={13} />
              </button>
              <button
                type="button"
                className="in-vref-thumb"
                onClick={() => t.status && useUI.getState().openDialog({ kind: 'take', takeId: t.id })}
                disabled={!t.status}
                title="Xem video"
              >
                {t.posterId ? <MediaImg id={t.posterId} className="media-img" /> : <Film size={13} />}
              </button>
              <button type="button" className="in-ref-name" onClick={() => t.status && goTo(t.id)} disabled={!t.status} title="Chọn video trên canvas">
                <span className="in-ref-title">{t.label}</span>
                <span className="in-ref-tag">
                  {t.status ? (
                    <>
                      <span className={`status-dot ${t.status}`} /> {STATUS_TEXT[t.status]}
                      {t.status === 'processing' ? ` ${t.progress}%` : ''}
                    </>
                  ) : (
                    'Take đã bị xoá'
                  )}
                </span>
              </button>
              <span className={`in-token is-video ${off || t.status !== 'completed' ? 'is-off' : ''}`} title={off ? 'Không được gửi' : `@video_${n}`}>
                @video_{n}
              </span>
              <button type="button" className="in-x" onClick={() => removeVideoRef(sceneId, t)} title="Bỏ video tham chiếu" aria-label={`Bỏ ${t.label}`}>
                <X size={13} />
              </button>
            </div>
          )
        })}
        {takeOver && <div className="in-refs-drop is-video">Thả để dùng làm video tham chiếu (@video) của cảnh này</div>}
      </div>

      {over && (
        <div className="in-note danger">
          <TriangleAlert size={13} />
          <span>
            {spec.name} nhận tối đa {spec.maxRefVideos} video; {videoRefs.length - spec.maxRefVideos} video cuối sẽ không được gửi.
          </span>
        </div>
      )}
      {!sends && (
        <div className="in-note danger">
          <TriangleAlert size={13} />
          <span>
            {spec.name} ở chế độ “{modeLabel(settings.mode, settings.model)}” không nhận video tham chiếu — các video trên sẽ không được gửi.
          </span>
        </div>
      )}

      {sends && (
        <div className="in-pop-host">
          <button ref={addBtn} type="button" className="btn btn-sm btn-ghost in-add" onClick={() => setPicker((p) => !p)}>
            <Plus size={13} /> Thêm video
          </button>
          {picker && (
            <TakePicker
              excludeSceneIds={[sceneId]}
              exclude={videoRefs}
              ignoreRef={addBtn}
              title="Dùng video làm tham chiếu"
              onClose={() => setPicker(false)}
              onPick={(takeId) => linkTakes([sceneId], [takeId])}
            />
          )}
        </div>
      )}
    </Section>
  )
})

// ---------------- 5. takes + run ----------------
const TakesSection = memo(function TakesSection({ sceneId }: { sceneId: string }) {
  const takes = useSceneTakes(sceneId)
  const settings = useSceneField(sceneId, (s) => s.settings)
  const promptEmpty = useSceneField(sceneId, (s) => !s.prompt.trim()) ?? true
  const framesMissing = useSceneField(sceneId, (s) => s.settings.mode === 'transform' && (!s.firstFrame || !s.lastFrame)) ?? false
  const hasVideoRefs = useSceneField(sceneId, (s) => s.videoRefs.length > 0) ?? false
  // Tokens with no picture/video in the request (character sync): a string, so the selector result is stable.
  const unsent = useProject((s) => {
    const sc = s.project.scenes.find((x) => x.id === sceneId)
    return sc ? compileScene(s.project, sc).unsentTokens.slice(0, 2).join(', ') : ''
  })
  const completed = useMemo(() => takes.filter((t) => t.status === 'completed').sort((a, b) => a.number - b.number), [takes])
  const creditKind = useCreditKind()
  if (!settings) return null
  const cost = costOf(settings)
  // The continuing scene copies this scene's settings: a mode without reference videos could never use @video_1.
  const acceptsVideo = usesVideoRefs(settings)
  const noVideoTitle = `${MODELS[settings.model].name} ở chế độ “${modeLabel(settings.mode, settings.model)}” không nhận video tham chiếu — đổi sang Seedance 2.5 hoặc chế độ “${modeLabel('i2v', 'minimax_h3')}” để tạo cảnh tiếp nối`
  const running = takes.filter((t) => t.status === 'queued' || t.status === 'processing').length
  const reason = promptEmpty
    ? 'Prompt trống'
    : framesMissing
      ? 'Thiếu khung đầu/cuối'
      : unsent
        ? `Prompt nhắc ${unsent} nhưng ảnh/video đó không được gửi — sửa số hoặc nối thêm`
        : hasVideoRefs && creditKind !== 'demo'
          ? NO_VIDEO_REFS_REASON
          : null
  const chosen = [...completed].reverse().find((t) => t.starred) ?? completed[completed.length - 1]
  const shown = completed.slice(-6)
  if (chosen && !shown.includes(chosen)) shown.splice(0, 1, chosen)
  shown.sort((a, b) => a.number - b.number)
  return (
    <Section
      id="takes"
      title="Take"
      meta={
        <span className="in-meta">
          {takes.length > 0 && <span className="badge">{takes.length} take</span>}
          {running > 0 && (
            <span className="badge accent">
              <span className="status-dot processing" /> {running} đang chạy
            </span>
          )}
        </span>
      }
    >
      {takes.length > 0 ? (
        <div className="in-takes">
          <TakeStrip sceneId={sceneId} size="md" />
        </div>
      ) : (
        <div className="in-takes-empty">
          <Film size={14} /> Chưa có take nào. Mỗi lần chạy tạo một video (T1, T2…) nối ra từ cảnh trên canvas.
        </div>
      )}
      {completed.length > 0 && <DownloadRow takes={completed} chosenId={chosen?.id} />}
      {shown.length > 0 && (
        <div className="in-continue-row">
          <span className="in-continue-label">
            <CornerDownRight size={13} /> Tạo cảnh tiếp nối từ
          </span>
          {shown.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`btn btn-sm ${t.id === chosen?.id ? 'in-continue-main' : 'btn-ghost'}`}
              onClick={() => createSceneFromTake(t.id)}
              disabled={!acceptsVideo}
              title={
                !acceptsVideo
                  ? noVideoTitle
                  : `Cảnh mới bên dưới, dùng T${t.number} làm @video_1, giữ ảnh tham chiếu và cấu hình${creditKind !== 'demo' ? ' · Lưu ý: cổng canvasapp (cả chế độ Phát triển) chưa nhận video tham chiếu — bỏ @video_1 để chạy cảnh này' : ''}`
              }
            >
              T{t.number}
              {t.starred && <Star size={11} fill="currentColor" className="in-star" />}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="btn btn-primary btn-lg in-run"
        onClick={() => requestRun([sceneId])}
        disabled={!!reason}
        title={reason ?? costTitle(cost, creditKind, 'Xem chi phí và chạy (Ctrl+Enter) · ')}
      >
        <Play size={14} fill="currentColor" />
        Chạy · {settings.duration}s ·<span className={`in-run-cost ${creditTone(creditKind)}`}>{formatCredits(cost, creditKind)}</span>
      </button>
      {reason && <div className="in-run-reason">{reason} — chưa thể chạy.</div>}
    </Section>
  )
})

/** "⬇ Tải" — one button per finished take: the video (+ the prompt .txt) to Downloads or the chosen folder. */
function DownloadRow({ takes, chosenId }: { takes: { id: string; number: number; starred: boolean }[]; chosenId: string | undefined }) {
  const folderName = useDownloadPrefs((s) => s.folderName)
  const withPrompt = useDownloadPrefs((s) => s.withPrompt)
  const askWhere = useDownloadPrefs((s) => s.askWhere)
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const save = async (takeId: string) => {
    setBusy((b) => new Set(b).add(takeId))
    try {
      await downloadTake(takeId)
    } finally {
      setBusy((b) => {
        const next = new Set(b)
        next.delete(takeId)
        return next
      })
    }
  }
  const where = askWhere ? ' — chọn nơi lưu và tên file' : folderName ? ` vào thư mục “${folderName}”` : ' (thư mục Downloads)'
  return (
    <div className="in-download-row">
      {takes.map((t) => {
        const saving = busy.has(t.id)
        return (
          <button
            type="button"
            key={t.id}
            className={`btn btn-sm btn-ghost in-download ${t.id === chosenId ? 'is-chosen' : ''}`}
            onClick={() => void save(t.id)}
            disabled={saving}
            aria-busy={saving}
            title={`Tải video T${t.number}${withPrompt ? ' + prompt (.txt)' : ''}${where}`}
          >
            <Download size={12} />
            {saving ? `Đang tải T${t.number}…` : `Tải T${t.number}`}
            {t.starred && <Star size={11} fill="currentColor" className="in-star" />}
          </button>
        )
      })}
    </div>
  )
}

// ---------------- 6. note ----------------
const NoteSection = memo(function NoteSection({ sceneId }: { sceneId: string }) {
  const note = useSceneField(sceneId, (s) => s.note) ?? ''
  return (
    <Section id="note" title="Ghi chú" defaultOpen={true}>
      <textarea
        className="textarea in-note-ta"
        rows={3}
        value={note}
        placeholder="Ghi chú riêng cho cảnh này (không gửi đi)…"
        onChange={(e) => useProject.getState().updateScene(sceneId, { note: e.target.value })}
      />
    </Section>
  )
})
