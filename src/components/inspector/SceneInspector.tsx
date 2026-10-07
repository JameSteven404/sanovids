// Inspector for one scene. Every section subscribes to the narrow slice it needs, so typing in the
// prompt (or the title / note) does not re-render the whole panel.
import { platformText, shortcutText } from '../../lib/platformText'
import { ArrowRight, ChevronLeft, ChevronRight, CopyPlus, Download, Film, FlaskConical, GripVertical, Info, Maximize2, Play, Plus, Star, Trash, TriangleAlert, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createAssetsFromFiles, downloadTake, focusNodes, linkAssets, nextScene, requestRun, revealNodes } from '../../actions'
import { sceneCode } from '../../core/compile'
import { sceneMapOf } from '../../core/sceneIndex'
import { costOf, foreignModelBadge, modeLabel, MODELS, usesRefs } from '../../core/models'
import { foreignModelReason } from '../../core/runRules'
import type { Asset, Scene } from '../../core/types'
import { formatCredits, isSimulatedCredit } from '../../lib/credits'
import { ASSETS_MIME, readIds } from '../../lib/dnd'
import { useCanvasPrefs } from '../../lib/canvasPrefs'
import { useDownloadPrefs } from '../../lib/downloads'
import { useCreditKind } from '../../store/credits'
import { reportMediaChange } from '../../placeholderActions'
import { undoToastAction, useProject } from '../../store/project'
import { useSceneTakes } from '../../store/runs'
import { useInPanel, useSceneEditor } from '../../store/sceneEditor'
import { toast, useUI } from '../../store/ui'
import { typeOnNode } from '../canvas/SceneNodeEditor'
import { AssetAvatar } from '../common/Media'
import { appliedPresetId, costTitle, creditTone } from '../sidebar/shared'
import { useSceneRunBlock } from '../runs/shared'
import { TakeStrip } from '../runs/TakeStrip'
import { FinalPromptPreview } from './FinalPromptPreview'
import { RefThumb, useImagePreview } from './ImagePreview'
import { PlaceholderBar } from './PlaceholderBar'
import { flushPromptEditor, PromptEditor } from './PromptEditor'
import { SceneOrderControl } from './SceneOrderControl'
import { SettingsFields } from './SettingsFields'
import { AssetPicker, EMPTY_IDS, KIND_LABEL, Section, useSceneField } from './shared'
import { imageOptsFor, legacyAssets, replaceLegacyTags } from './tokens'
import { useReorder } from './useReorder'

/** Row reordering inside the list below (drag payload = row index). Library cards use src/lib/dnd.ts. */
const REF_MIME = 'application/x-bdp-refidx'
const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files')
/** "veo_3_1 · bản mới hơn" in the settings header: may shrink (ellipsis, full text in the title) beside the cost. */
const FOREIGN_BADGE_STYLE: CSSProperties = { minWidth: 0, maxWidth: '60%' }
const ELLIPSIS_STYLE: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

export function SceneInspector({ sceneId }: { sceneId: string }) {
  const exists = useProject((s) => sceneMapOf(s.project.scenes).has(sceneId))
  if (!exists) return null
  return (
    <div className="in-scene">
      <SceneHeader sceneId={sceneId} />
      <SettingsSection sceneId={sceneId} />
      <PromptSection sceneId={sceneId} />
      <RefsSection sceneId={sceneId} />
      <FinalPromptPreview sceneId={sceneId} />
      <TakesSection sceneId={sceneId} />
      <NoteSection sceneId={sceneId} />
    </div>
  )
}

// ---------------- helpers ----------------
const promptOf = (sceneId: string) => useProject.getState().project.scenes.find((s) => s.id === sceneId)?.prompt

/**
 * Run a refs change (the store renumbers @image_N tokens in the same undo step, the token of a removed picture becomes
 * a red placeholder) and tell the user what it did to the prompt (core/staleTokens mediaChangeNote: red placeholders
 * left, numbers left stale with renumbering off, or renumbered). Pending typing is committed first so it is renumbered
 * too. `done`: what was changed ("Đã bỏ nối Elara"); announced on its own only when `plain`.
 */
function changeMedia(sceneId: string, run: () => void, msg: { done: string; plain?: boolean }) {
  flushPromptEditor(sceneId)
  const before = useProject.getState().project
  run()
  reportMediaChange(before, msg.done, { always: msg.plain })
}

/** Tooltip of a reorder grip: the token numbers follow only while automatic renumbering is on. */
function gripTitle(autoRenumber: boolean): string {
  return autoRenumber
    ? 'Kéo để đổi thứ tự (↑/↓) — số @image trong prompt tự cập nhật'
    : 'Kéo để đổi thứ tự (↑/↓) — tự đánh lại số đang tắt (Cài đặt): số @image trong prompt sẽ trỏ sang ảnh khác'
}

// ---------------- 1. header ----------------
interface SceneOpt {
  id: string
  order: number
  title: string
}
const SEP = '\u0001'

let optionMemo: { scenes: readonly Scene[]; keys: string[] } = { scenes: [], keys: [] }
/**
 * One key per scene (order, id, title): what the header's scene picker lists (shallow-compared). The last answer comes
 * back as is while no scene's order / id / title changed — typing in a prompt builds no new string per scene.
 */
export function sceneOptionKeys(scenes: Scene[]): string[] {
  const prev = optionMemo.scenes
  if (prev === scenes) return optionMemo.keys
  if (prev.length === scenes.length && scenes.every((s, i) => s === prev[i] || (s.id === prev[i].id && s.order === prev[i].order && s.title === prev[i].title))) {
    optionMemo = { scenes, keys: optionMemo.keys }
    return optionMemo.keys
  }
  optionMemo = { scenes, keys: scenes.map((x) => `${x.order}${SEP}${x.id}${SEP}${x.title}`) }
  return optionMemo.keys
}

/** Stable list of all scenes (id/order/title), sorted by order. */
function useSceneOptions(): SceneOpt[] {
  const keys = useProject(useShallow((s) => sceneOptionKeys(s.project.scenes)))
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
  // Same gate as the Run button of the Take section below (core/runRules = store/runs check()); selected by id as a
  // string, so typing in the prompt does not re-render the header.
  const reason = useSceneRunBlock(sceneId)
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
        <SceneOrderControl sceneId={sceneId} order={order} idx={idx} count={options.length} />
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
          <button type="button" className="icon-btn in-icon-sm" onClick={() => nextScene()} title="Tạo cảnh tiếp theo bên dưới (N) — giữ ảnh tham chiếu và cấu hình">
            <ArrowRight size={14} />
          </button>
          <button type="button" className="icon-btn in-icon-sm" onClick={onDuplicate} title={shortcutText('Nhân bản cảnh (Ctrl+D)')}>
            <CopyPlus size={14} />
          </button>
          <button type="button" className="icon-btn in-icon-sm in-danger-hover" onClick={onDelete} title="Xoá cảnh (Delete)">
            <Trash size={14} />
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm in-head-run"
            onClick={() => requestRun([sceneId])}
            disabled={!!reason}
            title={reason ? `Chưa chạy được: ${reason}` : `Chạy cảnh này (${platformText.mod}+Enter)`}
          >
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
  // A newer build's model (migrate keeps it, Run is blocked): shown instead of the stand-in model.
  const foreignModel = useSceneField(sceneId, (s) => s.foreignModel)
  const foreignModels = useMemo(() => [foreignModel], [foreignModel])
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
      // Picked on the scene node day to day (its settings line): collapsed here until opened.
      defaultOpen={false}
      meta={
        <span className="in-meta">
          {foreignModel && (
            <span className="badge warn" style={FOREIGN_BADGE_STYLE} title={foreignModelReason(foreignModel)}>
              <span style={ELLIPSIS_STYLE}>{foreignModelBadge(foreignModel)}</span>
            </span>
          )}
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
        foreignModels={foreignModels}
        presetIds={presetIds}
        presets={presets}
        onPatch={(patch) => useProject.getState().updateSettings([sceneId], patch)}
        onPreset={(id) => useProject.getState().applyPreset(id, [sceneId])}
      />
    </Section>
  )
})

// ---------------- 2b. prompt: typed on the scene node; here the wide composer ----------------
/**
 * The prompt is typed on the scene node itself. The panel keeps the wide composer for very long prompts, opened on
 * demand: while it is open the node shows static text (store/sceneEditor: one place to type per scene). With the
 * node editor turned off (Settings), the prompt is always typed here.
 */
const PromptSection = memo(function PromptSection({ sceneId }: { sceneId: string }) {
  const always = useCanvasPrefs((s) => s.nodeEditor === 'off')
  const inPanel = useInPanel(sceneId)
  // Leaving this scene (another selection, deleted) closes its composer.
  useEffect(
    () => () => {
      if (useSceneEditor.getState().panelSceneId === sceneId) useSceneEditor.getState().closePanel()
    },
    [sceneId],
  )
  if (always || inPanel) {
    return (
      <Section
        id="prompt"
        title="Prompt"
        extra={
          !always && (
            // typeOnNode: the canvas first brings the node on screen and near (its field exists only there).
            <button type="button" className="btn btn-sm btn-ghost in-mini" onClick={() => typeOnNode(sceneId)} title="Đóng khung soạn rộng và gõ tiếp trên node cảnh">
              Gõ trên node
            </button>
          )
        }
      >
        <PromptEditor sceneId={sceneId} />
        <PlaceholderBar sceneId={sceneId} />
      </Section>
    )
  }
  return (
    <Section id="prompt" title="Prompt">
      <div className="in-note">
        <Info size={13} />
        <span>Gõ prompt ngay trên node cảnh: bấm vào chữ, hoặc chọn cảnh rồi nhấn Enter. Prompt rất dài thì mở khung soạn rộng ở đây.</span>
      </div>
      <button type="button" className="btn btn-sm btn-ghost in-add" onClick={() => useSceneEditor.getState().openPanel(sceneId)}>
        <Maximize2 size={13} /> Mở khung soạn rộng
      </button>
      {/* red placeholders: also handled on the node (variant 'node'); here for the keyboard and the wide panel */}
      <PlaceholderBar sceneId={sceneId} />
    </Section>
  )
})

// ---------------- 3. reference images (@image_N) ----------------
function tokensLabel(ns: number[]): string {
  if (!ns.length) return ''
  if (ns.length <= 2) return ns.map((n) => `@image_${n}`).join(', ')
  return `@image_${ns[0]}…${ns[ns.length - 1]}`
}

/**
 * Remove a ref (tokens renumber, its own tokens turn into red placeholders — no text is lost); offer to turn a
 * remaining legacy @Tag into the name (it would re-link).
 */
function removeRef(sceneId: string, asset: Asset) {
  changeMedia(sceneId, () => useProject.getState().removeRef(sceneId, asset.id), { done: `Đã bỏ nối ${asset.name}`, plain: true })
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
    changeMedia(sceneId, () => useProject.getState().moveRef(sceneId, rows[from].index, rows[to].index), { done: 'Đã đổi thứ tự ảnh tham chiếu' })
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
              <button type="button" className="in-grip" title={gripTitle(autoRenumber)} aria-label={`Đổi thứ tự ${a.name}`} onKeyDown={reorder.gripKeyDown(i)}>
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

// ---------------- 5. takes + run ----------------
const TakesSection = memo(function TakesSection({ sceneId }: { sceneId: string }) {
  const takes = useSceneTakes(sceneId)
  const settings = useSceneField(sceneId, (s) => s.settings)
  const completed = useMemo(() => takes.filter((t) => t.status === 'completed').sort((a, b) => a.number - b.number), [takes])
  if (!settings) return null
  const running = takes.filter((t) => t.status === 'queued' || t.status === 'processing').length
  const chosen = [...completed].reverse().find((t) => t.starred) ?? completed[completed.length - 1]
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
      {/* The costed Run button and its reason live on the scene node (and the head's "Chạy" above). */}
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
