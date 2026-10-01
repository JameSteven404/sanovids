// Inspector for one scene. Every section subscribes to the narrow slice it needs, so typing in the
// prompt (or the title / note) does not re-render the whole panel.
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  Film,
  GripVertical,
  Info,
  Play,
  Plus,
  Trash,
  TriangleAlert,
  X,
} from 'lucide-react'
import { memo, useMemo, useRef, useState, type DragEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createAssetsFromFiles, focusNodes, linkAssets, nextScene, requestRun } from '../../actions'
import { compileScene, extractMentions, MENTION_RE, sceneCode } from '../../core/compile'
import { costOf, MODE_LABEL, MODELS, usesRefs } from '../../core/models'
import type { Asset, Project, Scene, VideoSettings } from '../../core/types'
import { useProject } from '../../store/project'
import { useSceneTakes } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { AssetAvatar } from '../common/Media'
import { TakeStrip } from '../runs/TakeStrip'
import { hasFiles, undoToastAction } from '../sidebar/shared'
import { FinalPromptPreview } from './FinalPromptPreview'
import { PromptEditor } from './PromptEditor'
import { SettingsFields } from './SettingsFields'
import { AssetPicker, EMPTY_IDS, KIND_LABEL, Section, triOf, TriToggle, triValue, useSceneField, type Tri } from './shared'

const ASSET_MIME = 'application/x-bdp-assets'
const REF_MIME = 'application/x-bdp-refidx'

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
      <BlocksSection sceneId={sceneId} />
      <FinalPromptPreview sceneId={sceneId} />
      <TakesSection sceneId={sceneId} />
      <NoteSection sceneId={sceneId} />
    </div>
  )
}

// ---------------- 1. header ----------------
interface SceneOpt {
  id: string
  order: number
  title: string
}
const SEP = '\u0001'

/** Stable list of all scenes (id/order/title), sorted by order. */
export function useSceneOptions(): SceneOpt[] {
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

function goToScene(id: string) {
  useUI.getState().select([id])
  focusNodes([id])
}

const SceneHeader = memo(function SceneHeader({ sceneId }: { sceneId: string }) {
  const order = useSceneField(sceneId, (s) => s.order) ?? 0
  const title = useSceneField(sceneId, (s) => s.title) ?? ''
  const continueFrom = useSceneField(sceneId, (s) => s.continueFrom) ?? null
  const options = useSceneOptions()
  const idx = options.findIndex((o) => o.id === sceneId)
  const prev = idx > 0 ? options[idx - 1] : undefined
  const next = idx >= 0 && idx < options.length - 1 ? options[idx + 1] : undefined

  const onContinue = (value: string) => {
    const ok = useProject.getState().setContinueFrom(sceneId, value || null)
    if (!ok) toast('Không thể tiếp nối: sẽ tạo vòng lặp giữa các cảnh.', { tone: 'warning' })
  }
  const onDuplicate = () => {
    const created = useProject.getState().duplicateScenes([sceneId])
    if (created[0]) {
      useUI.getState().select(created)
      focusNodes(created)
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
          <button type="button" className="icon-btn in-icon-sm" disabled={!prev} onClick={() => prev && goToScene(prev.id)} title={prev ? `Cảnh trước: ${sceneCode(prev.order)}` : 'Đây là cảnh đầu'}>
            <ChevronLeft size={15} />
          </button>
          <button type="button" className="icon-btn in-icon-sm" disabled={!next} onClick={() => next && goToScene(next.id)} title={next ? `Cảnh sau: ${sceneCode(next.order)}` : 'Đây là cảnh cuối'}>
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      <div className="in-head-row in-head-sub">
        <label className="in-continue">
          <span>Tiếp nối từ</span>
          <select className="select in-sm" value={continueFrom ?? ''} onChange={(e) => onContinue(e.target.value)}>
            <option value="">— Không (mở đầu chuỗi)</option>
            {options
              .filter((o) => o.id !== sceneId)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {sceneCode(o.order)}
                  {o.title ? ` · ${o.title}` : ''}
                </option>
              ))}
          </select>
        </label>
        <div className="in-head-actions">
          <button type="button" className="icon-btn in-icon-sm" onClick={() => nextScene()} title="Tạo cảnh tiếp theo (N) — giữ nhân vật, khối, cấu hình">
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
  const presetId = useSceneField(sceneId, (s) => s.presetId) ?? null
  const presets = useProject((s) => s.project.presets)
  const list = useMemo(() => (settings ? [settings] : []), [settings])
  const presetIds = useMemo(() => [presetId], [presetId])
  if (!settings) return null
  const preset = presets.find((p) => p.id === presetId)
  return (
    <Section
      id="settings"
      title="Cấu hình video"
      meta={
        <span className="in-meta">
          {preset && <span className="badge">{preset.name}</span>}
          <span className="badge accent">{costOf(settings)} credit</span>
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

// ---------------- 4. references ----------------
export function refNumbering(assets: Asset[], refs: string[], settings: VideoSettings) {
  const scene: Scene = {
    id: '_',
    order: 1,
    title: '',
    prompt: '',
    refs,
    blockOverrides: {},
    presetId: null,
    settings,
    continueFrom: null,
    firstFrame: null,
    lastFrame: null,
    color: null,
    position: { x: 0, y: 0 },
    note: '',
  }
  const stub: Project = {
    id: '_',
    name: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    assets,
    blocks: [],
    presets: [],
    scenes: [scene],
    settings: { referencesTemplate: '', autoReferences: false, autoContinuity: false },
  }
  const c = compileScene(stub, scene)
  const byAsset = new Map<string, number[]>()
  for (const img of c.images) {
    const l = byAsset.get(img.assetId)
    if (l) l.push(img.n)
    else byAsset.set(img.assetId, [img.n])
  }
  const total = refs.reduce((t, id) => t + (assets.find((a) => a.id === id)?.imageIds.length ?? 0), 0)
  return { byAsset, total, sent: c.images.length }
}

function tokensLabel(ns: number[]): string {
  if (!ns.length) return ''
  if (ns.length <= 2) return ns.map((n) => `@image_${n}`).join(', ')
  return `@image_${ns[0]}…${ns[ns.length - 1]}`
}

/** Remove a ref; warn when the prompt still mentions it (it would be re-linked on the next edit). */
function removeRefWithHint(sceneId: string, asset: Asset) {
  const st = useProject.getState()
  st.removeRef(sceneId, asset.id)
  const scene = st.project.scenes.find((s) => s.id === sceneId)
  const mentioned = !!scene && extractMentions(scene.prompt).some((t) => t.toLowerCase() === asset.tag.toLowerCase())
  if (!mentioned) {
    toast(`Đã bỏ nối @${asset.tag}.`, { action: undoToastAction() })
    return
  }
  toast(`Đã bỏ nối @${asset.tag} — prompt vẫn nhắc @${asset.tag} nên sẽ tự nối lại khi sửa prompt.`, {
    tone: 'warning',
    ms: 8000,
    action: {
      label: 'Đổi @ thành tên',
      run: () => {
        const cur = useProject.getState().project.scenes.find((s) => s.id === sceneId)
        if (!cur) return
        const key = asset.tag.toLowerCase()
        const prompt = cur.prompt.replace(MENTION_RE, (whole, tag: string) => (tag.toLowerCase() === key ? asset.name : whole))
        useProject.getState().updateScene(sceneId, { prompt })
      },
    },
  })
}

const RefsSection = memo(function RefsSection({ sceneId }: { sceneId: string }) {
  const refs = useSceneField(sceneId, (s) => s.refs) ?? EMPTY_IDS
  const settings = useSceneField(sceneId, (s) => s.settings)
  const assets = useProject((s) => s.project.assets)
  const [picker, setPicker] = useState(false)
  const addBtn = useRef<HTMLButtonElement>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  /** What is being dragged over the list from outside: library cards or image files. */
  const [libOver, setLibOver] = useState<'assets' | 'files' | null>(null)

  const numbering = useMemo(() => (settings ? refNumbering(assets, refs, settings) : null), [assets, refs, settings])
  if (!settings || !numbering) return null
  const spec = MODELS[settings.model]
  const sends = usesRefs(settings)
  // Modes that send no images drop nothing: refs are only named in the prompt.
  const over = sends && numbering.total > spec.maxRefImages
  // Rows keep their index in scene.refs: refs may hold ids of deleted assets (e.g. restored from an old take),
  // and moveRef works on the raw list.
  const rows = refs.flatMap((id, index) => {
    const a = assets.find((x) => x.id === id)
    return a ? [{ a, index }] : []
  })
  const moveRow = (from: number, to: number) => {
    if (from === to || !rows[from] || !rows[to]) return
    useProject.getState().moveRef(sceneId, rows[from].index, rows[to].index)
  }

  const onRowDragOver = (e: DragEvent, i: number) => {
    if (dragFrom === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const at = e.clientY < r.top + r.height / 2 ? i : i + 1
    if (at !== dropAt) setDropAt(at)
  }
  const finishDrag = () => {
    setDragFrom(null)
    setDropAt(null)
  }
  const onRowDrop = (e: DragEvent) => {
    if (dragFrom === null || dropAt === null) return
    e.preventDefault()
    e.stopPropagation()
    const to = dropAt > dragFrom ? dropAt - 1 : dropAt
    moveRow(dragFrom, to)
    finishDrag()
  }
  const isLibDrag = (e: DragEvent) => e.dataTransfer.types.includes(ASSET_MIME)
  const isFileDrag = (e: DragEvent) => hasFiles(e.dataTransfer)

  return (
    <Section
      id="refs"
      title="Tham chiếu"
      meta={
        <span className="in-meta">
          <span className={`badge ${over ? 'danger' : sends && numbering.sent ? 'ref' : ''}`} title="Số ảnh gửi kèm / giới hạn của model">
            {sends ? `${numbering.sent}/${spec.maxRefImages} ảnh` : 'không gửi ảnh'}
          </span>
        </span>
      }
    >
      <div
        className={`in-refs ${libOver ? 'is-lib-over' : ''}`}
        onDragOver={(e) => {
          const kind = isLibDrag(e) ? 'assets' : isFileDrag(e) ? 'files' : null
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
            if (!isFileDrag(e)) return
            // Image files: add them to the library, then link them here (same as dropping on the scene card).
            e.preventDefault()
            setLibOver(null)
            const files = Array.from(e.dataTransfer.files)
            void createAssetsFromFiles(files).then((created) => linkAssets([sceneId], created))
            return
          }
          e.preventDefault()
          setLibOver(null)
          try {
            const ids = JSON.parse(e.dataTransfer.getData(ASSET_MIME)) as unknown
            if (Array.isArray(ids)) linkAssets([sceneId], ids.filter((x): x is string => typeof x === 'string'))
          } catch {
            /* ignore malformed payload */
          }
        }}
      >
        {rows.length === 0 && (
          <div className="in-refs-empty">
            Chưa có tham chiếu. Gõ <span className="kbd">@</span> trong prompt, kéo nhân vật từ thư viện vào đây, hoặc bấm “Thêm”.
          </div>
        )}
        {rows.map(({ a }, i) => {
          const ns = numbering.byAsset.get(a.id) ?? []
          return (
            <div
              key={a.id}
              className={`in-ref ${dragFrom === i ? 'is-dragging' : ''} ${dropAt === i && dragFrom !== null ? 'drop-before' : ''} ${
                dropAt === i + 1 && i === rows.length - 1 && dragFrom !== null ? 'drop-after' : ''
              }`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(REF_MIME, String(i))
                e.dataTransfer.effectAllowed = 'move'
                setDragFrom(i)
              }}
              onDragOver={(e) => onRowDragOver(e, i)}
              onDrop={onRowDrop}
              onDragEnd={finishDrag}
            >
              <button
                type="button"
                className="in-grip"
                title="Kéo để đổi thứ tự (↑/↓)"
                aria-label={`Đổi thứ tự @${a.tag}`}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp' && i > 0) {
                    e.preventDefault()
                    moveRow(i, i - 1)
                  } else if (e.key === 'ArrowDown' && i < rows.length - 1) {
                    e.preventDefault()
                    moveRow(i, i + 1)
                  }
                }}
              >
                <GripVertical size={13} />
              </button>
              <AssetAvatar asset={a} size={28} />
              <button type="button" className="in-ref-name" onClick={() => useUI.getState().openDialog({ kind: 'asset', assetId: a.id })} title="Sửa chi tiết">
                <span className="in-ref-title">{a.name}</span>
                <span className="in-ref-tag">
                  @{a.tag} · {KIND_LABEL[a.kind]}
                </span>
              </button>
              {sends ? (
                ns.length ? (
                  <span className="in-token" title={ns.map((n) => `@image_${n}`).join(', ')}>
                    {tokensLabel(ns)}
                  </span>
                ) : (
                  <span className="in-token is-off" title={a.imageIds.length ? 'Vượt giới hạn ảnh — không được gửi' : 'Chưa có ảnh — không được gửi'}>
                    {a.imageIds.length ? 'vượt giới hạn' : 'chưa có ảnh'}
                  </span>
                )
              ) : (
                <span className="in-token is-off">theo tên</span>
              )}
              <button type="button" className="in-x" onClick={() => removeRefWithHint(sceneId, a)} title="Bỏ nối" aria-label={`Bỏ nối @${a.tag}`}>
                <X size={13} />
              </button>
            </div>
          )
        })}
        {libOver && <div className="in-refs-drop">{libOver === 'files' ? 'Thả ảnh để thêm vào thư viện và nối vào cảnh này' : 'Thả để nối vào cảnh này'}</div>}
      </div>

      {over && (
        <div className="in-note danger">
          <TriangleAlert size={13} />
          <span>
            {spec.name} nhận tối đa {spec.maxRefImages} ảnh; đang có {numbering.total} ảnh — {numbering.total - spec.maxRefImages} ảnh cuối sẽ bị bỏ.
          </span>
        </div>
      )}
      {!sends && (
        <div className="in-note">
          <Info size={13} />
          <span>
            Chế độ “{MODE_LABEL[settings.mode]}” của {spec.name} không gửi ảnh tham chiếu — @Tag sẽ được thay bằng tên.
          </span>
        </div>
      )}

      <div className="in-pop-host">
        <button ref={addBtn} type="button" className="btn btn-sm btn-ghost in-add" onClick={() => setPicker((p) => !p)}>
          <Plus size={13} /> Thêm tham chiếu
        </button>
        {picker && (
          <AssetPicker
            exclude={refs}
            ignoreRef={addBtn}
            title="Nối vào cảnh"
            onClose={() => setPicker(false)}
            onPick={(id) => linkAssets([sceneId], [id])}
          />
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
  return (
    <div className={`in-frame is-${which}`}>
      <span className="in-frame-label">{label}</span>
      <button ref={btn} type="button" className={`in-frame-btn ${asset ? 'has' : ''}`} onClick={() => setOpen((o) => !o)}>
        {asset ? (
          <>
            <AssetAvatar asset={asset} size={30} />
            <span className="in-frame-name">
              <b>{asset.name}</b>
              <span className="faint">@{asset.tag}</span>
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

// ---------------- 5. prompt blocks ----------------
const BlocksSection = memo(function BlocksSection({ sceneId }: { sceneId: string }) {
  const blocks = useProject((s) => s.project.blocks)
  const overrides = useSceneField(sceneId, (s) => s.blockOverrides)
  if (!overrides) return null
  const onCount = blocks.filter((b) => overrides[b.id] ?? b.defaultOn).length
  const setTri = (blockId: string, t: Tri) => useProject.getState().setBlockOverride([sceneId], blockId, triValue(t))
  return (
    <Section id="blocks" title="Khối prompt" meta={blocks.length > 0 && <span className="badge">{`${onCount}/${blocks.length} bật`}</span>}>
      {blocks.length === 0 ? (
        <div className="in-refs-empty">Chưa có khối prompt. Tạo ở mục “Khối prompt” bên trái — sửa một lần, áp dụng cho mọi cảnh.</div>
      ) : (
        <div className="in-blocks">
          {blocks.map((b) => {
            const ov = overrides[b.id]
            const on = ov ?? b.defaultOn
            return (
              <div key={b.id} className={`in-block ${on ? 'is-on' : 'is-off'}`} style={{ ['--block' as string]: b.color }}>
                <button
                  type="button"
                  className={`in-check ${on ? 'on' : ''}`}
                  onClick={() => {
                    const next = !on
                    useProject.getState().setBlockOverride([sceneId], b.id, next === b.defaultOn ? undefined : next)
                  }}
                  title={on ? 'Đang bật — bấm để tắt cho cảnh này' : 'Đang tắt — bấm để bật cho cảnh này'}
                  aria-pressed={on}
                >
                  {on && <Check size={11} strokeWidth={3} />}
                </button>
                <button type="button" className="in-block-title" onClick={() => useUI.getState().openDialog({ kind: 'block', blockId: b.id })} title={b.text.slice(0, 300)}>
                  <span className="in-block-name">{b.title || 'Khối'}</span>
                  <span className="in-block-place">{b.placement === 'before' ? 'Trước' : 'Sau'}</span>
                </button>
                <TriToggle value={triOf(ov)} defaultOn={b.defaultOn} onChange={(t) => setTri(b.id, t)} />
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
})

// ---------------- 7. takes + run ----------------
const TakesSection = memo(function TakesSection({ sceneId }: { sceneId: string }) {
  const takes = useSceneTakes(sceneId)
  const settings = useSceneField(sceneId, (s) => s.settings)
  const promptEmpty = useSceneField(sceneId, (s) => !s.prompt.trim()) ?? true
  const framesMissing = useSceneField(sceneId, (s) => s.settings.mode === 'transform' && (!s.firstFrame || !s.lastFrame)) ?? false
  if (!settings) return null
  const running = takes.filter((t) => t.status === 'queued' || t.status === 'processing').length
  const reason = promptEmpty ? 'Prompt trống' : framesMissing ? 'Thiếu khung đầu/cuối' : null
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
          <Film size={14} /> Chưa có take nào. Mỗi lần chạy tạo một take (T1, T2…) để so sánh.
        </div>
      )}
      <button
        type="button"
        className="btn btn-primary btn-lg in-run"
        onClick={() => requestRun([sceneId])}
        disabled={!!reason}
        title={reason ?? 'Xem chi phí và chạy (Ctrl+Enter)'}
      >
        <Play size={14} fill="currentColor" />
        Chạy · {settings.duration}s · {costOf(settings)} credit
      </button>
      {reason && <div className="in-run-reason">{reason} — chưa thể chạy.</div>}
    </Section>
  )
})

// ---------------- 8. note ----------------
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
