// Scene node on the canvas — the node IS the editor (approved design E0 v3, like canvasapp's video node): head (code,
// name, take status) · one settings line that opens in place · the prompt · image references + the costed Run button.
// Memoized; reads its own scene from the store by id. At rest every node draws its prompt as STATIC text with the same
// box, insets, wrapping and token marks as the live field, so nothing moves when it turns into one: a click on the
// text opens the field with the caret where it was clicked (store/sceneEditor, only ONE node mounts the field).
// Below LOD_ZOOM the far view: big code and name, two prompt lines, pictures, ▶.
// Its takes are separate Take nodes to the right (wired from the 'take' handle at 62px = the middle of their poster).
import { Handle, Position, useReactFlow, useStore, type Node, type NodeProps } from '@xyflow/react'
import { ChevronDown, ImagePlus, Link2, Lock, Play, Plus, TriangleAlert, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { edgeId, linkAssets, requestRun, viewImages } from '../../actions'
import { compileScene, imageSlotsFor, sceneCode } from '../../core/compile'
import { costOf, foreignModelBadge, modeLabel, MODELS, usesRefs, usesVideoRefs } from '../../core/models'
import { foreignModelReason, refStatusLookup, runBlockReason, unsentTokensReason } from '../../core/runRules'
import type { Asset, CompiledPrompt, Project, Scene, Size } from '../../core/types'
import { motionLevel, useCanvasPrefs } from '../../lib/canvasPrefs'
import { CREDIT_MARK, formatCredits } from '../../lib/credits'
import { ASSETS_MIME } from '../../lib/dnd'
import { measureImage } from '../../lib/imageMeta'
import { useMediaUrl } from '../../lib/imageStore'
import { useCreditKind } from '../../store/credits'
import { LAYOUT, useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useInPanel, useIsEditing, useSceneEditor, useSettingsOpen } from '../../store/sceneEditor'
import { useUI } from '../../store/ui'
import { perfCount } from '../../perf/probe'
import { MediaImg } from '../common/Media'
import { segmentPrompt } from '../inspector/tokens'
import { AssetPicker } from '../inspector/shared'
import { useGatewayRefVideoCap, useSettingsRunBlock } from '../runs/shared'
import { appliedPresetId } from '../sidebar/shared'
import {
  countScenes,
  DOT_TOP,
  hasAssetDrag,
  hasFileDrag,
  imageFiles,
  inlineEditKeyBubbles,
  inlineEditSavesDraft,
  LOD_ZOOM,
  readAssetIds,
  sceneMapOf,
  sceneAssetsOf,
  sceneNodeSize,
  takeIndexOf,
  takeSummary,
  targetScenesFor,
  type TakeSummary,
} from './canvasModel'
import { cutEdge } from './edges'
import { NodeSizer, useNodeBox, useRemeasureOn } from './NodeSizer'
import { RefPreview, type PreviewAnchor } from './RefPreview'
import {
  filesToSceneTiles,
  insertLinksAtExcerpt,
  legacyTagsOf,
  linkCardsToNode,
  linkNewTiles,
  NodePromptField,
  PromptSegments,
  staticTextBefore,
  typeOnNode,
} from './SceneNodeEditor'
import { SceneNodeSettings } from './SceneNodeSettings'
import { caretFromExcerptHit, enterOpensEditor } from './sceneEditorModel'
import {
  compactStatus,
  farExcerpt,
  farSummary,
  farTone,
  footLayout,
  imageBadge,
  nodeCounter,
  promptBoxHeight,
  promptLinesFor,
  promptTextWidth,
  runButtonView,
  settingsSummary,
  staticExcerpt,
} from './sceneNodeModel'
import type { RefDotTone } from './wireFx'
import './canvas.css'
import './sceneNode.css'

/** `refDot`: what the wires drawn into the reference dot carry (CanvasView, wireFx.refDotTones); absent = images only / none. */
export type SceneNodeData = { refDot?: RefDotTone }
export type SceneFlowNode = Node<SceneNodeData, 'scene'>

const EMPTY_ASSETS: Asset[] = []
const PLACEHOLDER = 'Bấm để viết prompt… Gõ @ để chèn ảnh tham chiếu (@image_1).'

/** The scene's two dots sit at 62px: the top of the prompt box = the middle of an unresized take's poster. */
const DOT_STYLE = { top: DOT_TOP }

function SceneNodeView({ id, selected, data }: NodeProps<SceneFlowNode>) {
  perfCount('SceneNodeView')
  const scene = useProject((s) => sceneMapOf(s.project.scenes).get(id))
  const far = useStore((s) => s.transform[2] < LOD_ZOOM)
  const status = useRuns((s) => takeSummary(s.takes, id).status)
  const progress = useRuns((s) => (takeSummary(s.takes, id).status === 'processing' ? takeSummary(s.takes, id).progress : 0))
  const libraryDrag = useUI((s) => !!s.draggingAssetIds)
  const multi = useUI((s) => (selected ? countScenes(s.selectedIds) : 0))
  const single = useUI((s) => s.selectedIds.length === 1 && s.selectedIds[0] === id)
  const editing = useIsEditing(id)
  const box = useNodeBox(id, sceneNodeSize(scene?.size))
  const transform = scene?.settings.mode === 'transform'
  // Handles are added/removed with the H3 transform mode: re-measure them.
  useRemeasureOn(id, transform)

  // Enter on the only selected node (canvas focused, nothing being typed, no dialog): type in its prompt, caret at the end.
  // Also when its field is already mounted but not focused (pref "Tự mở khi chọn 1 cảnh"); Enter inside the field is a newline.
  // A far node (zoomed out) is brought near first: its field only exists in the near view.
  useEffect(() => {
    if (!single) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.defaultPrevented || e.isComposing) return
      if (useUI.getState().dialog.kind !== 'none' || useCanvasPrefs.getState().nodeEditor === 'off') return
      if (!enterOpensEditor(e.target instanceof Element ? e.target : null)) return
      e.preventDefault()
      const cur = sceneMapOf(useProject.getState().project.scenes).get(id)
      if (far) typeOnNode(id, cur?.prompt.length ?? null)
      else useSceneEditor.getState().open(id, 'prompt', cur?.prompt.length ?? null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [single, far, id])

  // ---- HTML5 drop: library cards / image tiles (asset ids) or OS image files ----
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const depth = useRef(0)
  const accepts = (e: DragEvent) => hasAssetDrag(e.dataTransfer) || hasFileDrag(e.dataTransfer)
  const hintFor = (e: DragEvent): DropHint => {
    const n = targetScenesFor(id).length
    if (!hasAssetDrag(e.dataTransfer)) return { kind: 'file', text: n > 1 ? `Thêm ô ảnh & nối vào ${n} cảnh` : 'Thả ảnh: thêm ô ảnh & nối vào cảnh' }
    if (n === 1 && (e.target as Element | null)?.closest?.('.cv-sn-text')) return { kind: 'text', text: '' }
    return { kind: 'asset', text: n > 1 ? `Nối vào ${n} cảnh đã chọn` : 'Thả để nối' }
  }
  const onDragEnter = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    depth.current++
    setDropHint(hintFor(e))
  }
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.stopPropagation()
    const next = hintFor(e)
    if (next.kind !== dropHint?.kind) setDropHint(next)
  }
  const onDragLeave = (e: DragEvent) => {
    if (!accepts(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (!depth.current) setDropHint(null)
  }
  // A cancelled drop (Esc) may skip the matching dragleave: reset when any drag ends.
  const hinting = !!dropHint
  useEffect(() => {
    if (!hinting) return
    const reset = () => {
      depth.current = 0
      setDropHint(null)
    }
    window.addEventListener('dragend', reset, true)
    window.addEventListener('drop', reset, true)
    return () => {
      window.removeEventListener('dragend', reset, true)
      window.removeEventListener('drop', reset, true)
    }
  }, [hinting])
  const onDrop = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.stopPropagation()
    depth.current = 0
    setDropHint(null)
    const targets = targetScenesFor(id)
    const ids = readAssetIds(e.dataTransfer)
    useUI.getState().setDraggingAssets(null)
    if (ids && ids.length) {
      // On the static text of this one node: link + insert the @image_N where it was dropped (one undo step).
      const text = targets.length === 1 ? (e.target as Element | null)?.closest?.<HTMLElement>('.cv-sn-text') : null
      if (text && insertLinksAtExcerpt(id, staticTextBefore(text, e.clientX, e.clientY), ids)) return
      // Elsewhere on the node: linked; a card not on the canvas yet also gets its tile (choice 4A) — one undo step.
      linkCardsToNode(id, targets, ids)
      return
    }
    const files = imageFiles(e.dataTransfer)
    // New image files: tiles in the image column next to this row, wired (= linked as @image_N) to the scene(s), in
    // one undo step.
    if (files.length) void filesToSceneTiles(id, files, (created) => linkNewTiles(targets, created), targets)
  }

  if (!scene) return null
  const running = status === 'processing'
  // The reference dot takes the color of the wires drawn into it.
  const refDot = data?.refDot ? ` is-${data.refDot}` : ''
  const cls = [
    'cv-scene',
    'cv-sn',
    selected && 'is-selected',
    dropHint && dropHint.kind !== 'text' && 'is-drop',
    dropHint?.kind === 'text' && 'is-drop-text',
    libraryDrag && 'is-drop-target',
    running && 'is-running',
    far && 'is-far',
    editing && 'is-editing',
    box && 'is-sized',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <>
      <div className={cls} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {scene.color && <span className="cv-scene-stripe" style={{ background: scene.color }} />}
        {running && !far && (
          <div className="cv-run-bar">
            <i style={{ width: `${Math.max(3, progress)}%` }} />
          </div>
        )}
        {far ? <SceneFar scene={scene} status={status} progress={progress} w={box?.w ?? LAYOUT.sceneW} /> : <SceneFull scene={scene} status={status} box={box} editing={editing} />}

        <div className="cv-drop-hint">
          {dropHint?.kind === 'file' ? <ImagePlus size={14} /> : <Link2 size={14} />}
          {dropHint?.text}
        </div>
        <div className="cv-conn-hint asset">
          <Link2 size={14} />
          {multi > 1 ? `Nối vào ${multi} cảnh đã chọn` : 'Thả để nối'}
        </div>

        <Handle
          type="target"
          position={Position.Left}
          id="ref"
          className={`cv-h cv-h-ref${refDot}`}
          style={DOT_STYLE}
          isConnectableStart={false}
          title="Ảnh tham chiếu: kéo chấm phải của ô ảnh vào bất kỳ đâu trên node"
        />
        {/*
          Takes are created by running the scene, never by wiring: this handle anchors the 'out' wires. Dragged to a
          folder node it wires the scene for auto-save ('autosave': every new video of the scene is saved there).
        */}
        <Handle
          type="source"
          position={Position.Right}
          id="take"
          className="cv-h cv-h-takes"
          style={DOT_STYLE}
          isConnectableStart
          isConnectableEnd={false}
          title="Các video (take) tạo từ cảnh này · kéo chấm này vào một Thư mục để tự lưu mọi video mới của cảnh"
        />
        {transform && (
          <>
            <Handle type="target" position={Position.Left} id="first" className="cv-h cv-h-first" isConnectableStart={false} title="Khung đầu">
              <span className="cv-h-label">ĐẦU</span>
            </Handle>
            <Handle type="target" position={Position.Left} id="last" className="cv-h cv-h-last" isConnectableStart={false} title="Khung cuối">
              <span className="cv-h-label">CUỐI</span>
            </Handle>
          </>
        )}
      </div>
      <NodeSizer id={id} kind="scene" selected={!!selected} sized={!!box} />
    </>
  )
}

export const SceneNode = memo(SceneNodeView)

interface DropHint {
  /** asset: library cards / tiles (link) · file: new image files (tiles + link) · text: onto the static text (insert). */
  kind: 'asset' | 'file' | 'text'
  text: string
}

// ---------------------------------------------------------------------------------------------
/**
 * What the scene would send and why it cannot run yet: the engine's rule list (core/runRules = store/runs check()):
 * @video against the gateway's cap, only for the videos this model / mode really sends ('' in the status string = the
 * take no longer exists); settings the gateway surely refuses now (/api/video-profiles, a string selection).
 */
function useSceneRun(scene: Scene) {
  const assets = useProject(useShallow((s) => sceneAssetsOf(s.project.assets, scene)))
  // Status of each @video ref as one string: stable while takes only make progress.
  const videoStatus = useRuns((s) => {
    if (!scene.videoRefs.length) return ''
    const byId = takeIndexOf(s.takes).byId
    return scene.videoRefs.map((t) => byId.get(t)?.status ?? '').join(',')
  })
  const takeStatus = useMemo(() => refStatusLookup(scene.videoRefs, videoStatus), [scene.videoRefs, videoStatus])
  const compiled = useMemo<CompiledPrompt>(() => {
    const project: Project = { id: '', name: '', schemaVersion: 2, createdAt: 0, updatedAt: 0, presets: [], assets, settings: { autoRenumber: true }, scenes: [scene] }
    return compileScene(project, scene, { takeStatus })
  }, [assets, scene, takeStatus])
  const spec = MODELS[scene.settings.model]
  const videoCap = useGatewayRefVideoCap(scene.settings.model)
  const settingsBlock = useSettingsRunBlock(scene.settings)
  const reason = runBlockReason({ scene, assets, compiled, takeStatus, settingsBlock, spec, providerVideoCap: videoCap })
  return { assets, compiled, reason, spec }
}

/** Linked assets in refs order, the first @image number of each and the image count. */
function useRefSlots(assets: Asset[], refs: string[]) {
  return useMemo(() => {
    const map = new Map(assets.map((a) => [a.id, a]))
    const list = refs.map((r) => map.get(r)).filter((a): a is Asset => !!a)
    const first = new Map<string, number>()
    const all = imageSlotsFor(assets, refs)
    for (const s of all) if (!first.has(s.assetId)) first.set(s.assetId, s.n)
    return { list: list.length ? list : EMPTY_ASSETS, first, total: all.length }
  }, [assets, refs])
}

// ---------------------------------------------------------------------------------------------
/** Zoomed out (< 55%): code ≈ 18px on screen, the name in 2 lines, 2 prompt lines, pictures and ▶ (grey when blocked). */
function SceneFar({ scene, status, progress, w }: { scene: Scene; status: TakeSummary['status']; progress: number; w: number }) {
  const { assets, compiled, reason, spec } = useSceneRun(scene)
  const slots = useRefSlots(assets, scene.refs)
  // the red label "Chữ đỏ" when red placeholders block it (like the node's strip), else "Chưa chạy"
  const red = !!reason && reason === unsentTokensReason(compiled.unsentTokens) && compiled.unsentTokens.some((t) => t.includes('?'))
  const pill = status === 'processing' || !!reason
  const hasVideo = useRuns((s) => takeSummary(s.takes, scene.id).posterId !== null)
  const creditKind = useCreditKind()
  const rf = useReactFlow()
  const tone = farTone(status, hasVideo, !!reason)
  const cost = costOf(scene.settings)
  // Bounded: 100+ far nodes are on screen at once, each must not lay out a whole 20,000-character paragraph.
  const lines = farExcerpt(scene.prompt, w)
  return (
    <div
      className="cv-snf"
      title="Bấm đúp để phóng tới cảnh này và gõ prompt"
      onDoubleClick={(e) => {
        e.stopPropagation()
        const n = rf.getInternalNode(scene.id)
        if (!n) return
        const w = n.measured.width ?? LAYOUT.sceneW
        const h = n.measured.height ?? LAYOUT.sceneH
        const duration = motionLevel(useCanvasPrefs.getState().animations) === 'full' ? 300 : 0
        void rf.setCenter(n.internals.positionAbsolute.x + w / 2, n.internals.positionAbsolute.y + h / 2, { zoom: 1, duration })
        setTimeout(() => useSceneEditor.getState().open(scene.id, 'prompt', scene.prompt.length), duration + 40)
      }}
    >
      <div className={`cv-snf-bar is-${tone}`}>{tone === 'going' && <i style={{ width: `${Math.max(4, progress)}%` }} />}</div>
      <div className="cv-snf-top">
        <span className="cv-snf-code">{sceneCode(scene.order)}</span>
        <span className={`cv-snf-dot is-${tone}`} />
        <span className="cv-snf-sum">{scene.foreignModel ? foreignModelBadge(scene.foreignModel) : farSummary(spec.short, scene.settings.duration)}</span>
      </div>
      <div className={`cv-snf-ttl${scene.title ? '' : ' is-empty'}`}>{scene.title || 'Chưa đặt tên'}</div>
      <div className="cv-snf-ex">{lines || 'Chưa có prompt'}</div>
      <div className="cv-snf-bot">
        <span className="cv-snf-av">
          {slots.list.slice(0, pill ? 2 : 3).map((a) => (
            <MediaImg key={a.id} id={a.imageIds[0] ?? null} className="cv-snf-img" />
          ))}
        </span>
        <span className="cv-snf-sp" />
        {status === 'processing' ? (
          <span className="cv-snf-pill is-going">{progress}%</span>
        ) : reason ? (
          <span className="cv-snf-pill is-bad" title={`Chưa chạy được: ${reason}`}>
            {red ? 'Chữ đỏ' : 'Chưa chạy'}
          </span>
        ) : (
          <span className="cv-snf-cost">
            {formatCredits(cost, creditKind, { short: true })}
            {CREDIT_MARK[creditKind] && <span className="cv-snf-mark">{CREDIT_MARK[creditKind]}</span>}
          </span>
        )}
        {/* the wrapper carries the title: a disabled button gets no pointer events */}
        <span className="cv-snf-run-wrap" title={reason ? `Chưa chạy được: ${reason}` : `Tạo video cho ${sceneCode(scene.order)}`}>
          <button
            type="button"
            className="cv-snf-run nodrag"
            disabled={!!reason}
            aria-label={reason ? `Chưa chạy được: ${reason}` : `Tạo video cho ${sceneCode(scene.order)}`}
            onClick={(e) => {
              e.stopPropagation()
              requestRun([scene.id])
            }}
          >
            <Play size={24} fill="currentColor" />
          </button>
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
/** `box`: size of a resized node (null = default 352 × 304). */
function SceneFull({ scene, status, box, editing }: { scene: Scene; status: TakeSummary['status']; box: Size | null; editing: boolean }) {
  const { assets, compiled, reason, spec } = useSceneRun(scene)
  const slots = useRefSlots(assets, scene.refs)
  const inPanel = useInPanel(scene.id)
  const nodeEditor = useCanvasPrefs((s) => s.nodeEditor)
  const presetName = useProject((s) => {
    const id = appliedPresetId(scene.presetId, scene.settings, s.project.presets)
    return id ? (s.project.presets.find((p) => p.id === id)?.name ?? null) : null
  })
  const summary = useRuns(useShallow((s) => {
    const t = takeSummary(s.takes, scene.id)
    return { count: t.count, status: t.status, progress: t.status === 'processing' ? t.progress : 0, starredNumber: t.starredNumber, active: t.active }
  }))
  const creditKind = useCreditKind()
  // The opened settings line belongs to the only selected node (store/sceneEditor: opening it selects the node alone,
  // it closes with that selection) — never several open lines on nodes at rest.
  const settingsOpen = useSettingsOpen(scene.id)
  const frames = useMemo(() => {
    const first = (id: string | null) => (id ? (assets.find((a) => a.id === id)?.imageIds[0] ?? null) : null)
    return { first: first(scene.firstFrame), last: first(scene.lastFrame) }
  }, [assets, scene.firstFrame, scene.lastFrame])

  const code = sceneCode(scene.order)
  const cost = costOf(scene.settings)
  const off = nodeEditor === 'off'
  const placeholders = compiled.unsentTokens.filter((t) => t.includes('?'))
  const red = placeholders.length > 0 && reason === unsentTokensReason(compiled.unsentTokens)
  const w = box?.w ?? LAYOUT.sceneW
  const h = box?.h ?? LAYOUT.sceneH
  const full = runButtonView(reason, { cost, kind: creditKind, code, duration: scene.settings.duration, placeholders: red })
  const foot = footLayout(w, slots.list.map((a) => a.name), full.label)
  const run = foot.compact && !full.blocked ? runButtonView(reason, { cost, kind: creditKind, code, duration: scene.settings.duration, compact: true }) : full
  const lines = promptLinesFor(promptBoxHeight(h, { strip: placeholders.length > 0, why: !!run.why, settingsOpen }))
  // What the request really carries: tokens past it are invalid like a missing one (the model would never see them).
  const sent = useMemo(
    () => ({
      images: usesRefs(scene.settings) ? Math.min(slots.total, spec.maxRefImages) : 0,
      videos: usesVideoRefs(scene.settings) ? Math.min(scene.videoRefs.length, spec.maxRefVideos) : 0,
    }),
    [scene.settings, slots.total, spec, scene.videoRefs.length],
  )
  const excerpt = staticExcerpt(scene.prompt, lines, promptTextWidth(w))
  const segs = useMemo(() => segmentPrompt(excerpt, slots.total, scene.videoRefs.length, legacyTagsOf(assets), sent), [excerpt, slots.total, scene.videoRefs.length, assets, sent])
  const counter = nodeCounter(scene.prompt, compiled.limit)
  const live = editing && !inPanel
  const modelShort = scene.foreignModel ? foreignModelBadge(scene.foreignModel) : spec.short
  const [, ...rest] = settingsSummary(scene.settings, modelShort, scene.foreignModel ? 1 : spec.modes.length, presetName).split(' · ')
  const st = compactStatus({ ...summary, status: summary.status ?? status })

  return (
    <div className="cv-sn-body">
      <div className="cv-sn-head">
        <span className="cv-sn-code">{code}</span>
        <EditableTitle sceneId={scene.id} title={scene.title} />
        <span className={`cv-sn-st is-${st.tone}`} title={st.title}>
          <i />
          {st.text}
        </span>
      </div>

      {settingsOpen && !off ? (
        <SceneNodeSettings
          sceneId={scene.id}
          settings={scene.settings}
          storedPresetId={scene.presetId}
          foreignModel={scene.foreignModel}
          frames={frames}
          onClose={() => useSceneEditor.getState().closeSettings()}
        />
      ) : (
        <button
          type="button"
          className="cv-sn-sum nodrag"
          disabled={off}
          aria-expanded={false}
          title={
            scene.foreignModel
              ? foreignModelReason(scene.foreignModel)
              : `${spec.name}${spec.modes.length > 1 ? ` · ${modeLabel(scene.settings.mode, scene.settings.model)}` : ''} — bấm để đổi model, thời lượng, độ phân giải, tỉ lệ`
          }
          onClick={(e) => {
            e.stopPropagation()
            useSceneEditor.getState().openSettings(scene.id)
          }}
        >
          <span className={`cv-sn-sum-m${scene.foreignModel ? ' is-foreign' : ''}`} style={{ ['--model-c' as string]: scene.foreignModel ? 'var(--warn)' : spec.color } as CSSProperties}>
            {modelShort}
          </span>
          <span className="cv-sn-sum-t">{rest.join(' · ')}</span>
          {!off && <ChevronDown size={12} strokeWidth={2.4} className="cv-sn-sum-chev" />}
        </button>
      )}

      <div
        className={`cv-sn-pr${live ? ' is-live' : ''}${counter.over ? ' is-over' : ''}${off ? ' is-off' : ''}`}
        title={inPanel ? 'Đang soạn prompt này ở bảng bên phải — bấm để gõ tiếp trên node' : undefined}
        // A plain click on the static text types there (caret where clicked); on the box below the text: at the end.
        // Not a drag (React Flow suppresses the click after one), never with Shift / Ctrl (they select nodes).
        onClick={
          live
            ? undefined
            : (e) => {
                if (off || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
                const text = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.cv-sn-text')
                const onText = !!text && e.target instanceof Element && text.contains(e.target)
                const caret = onText ? caretFromExcerptHit(scene.prompt, staticTextBefore(text, e.clientX, e.clientY)) : null
                useSceneEditor.getState().open(scene.id, 'prompt', caret ?? scene.prompt.length)
              }
        }
      >
        {live ? (
          <NodePromptField scene={scene} assets={assets} sent={sent} imageCount={slots.total} placeholder={PLACEHOLDER} />
        ) : (
          <div className="cv-sn-text" style={{ WebkitLineClamp: lines }}>
            {scene.prompt ? <PromptSegments segs={segs} /> : <span className="cv-sn-ph">{off ? 'Chưa có prompt' : PLACEHOLDER}</span>}
          </div>
        )}
        <span className="cv-sn-count" title="Số ký tự / giới hạn của model">
          {counter.text}
        </span>
      </div>

      {placeholders.length > 0 && (
        <div className="cv-sn-hole" title="Ảnh của các chữ đỏ này đã bị cắt dây: nối lại ảnh vào cảnh rồi sửa thành số đúng (vd. @image_1)">
          <TriangleAlert size={12} />
          <span className="cv-sn-hole-l">Chữ đỏ chờ ảnh:</span>
          {placeholders.slice(0, 3).map((t) => (
            <span key={t} className="cv-sn-hole-c">
              {t}
            </span>
          ))}
          {placeholders.length > 3 && <span className="cv-sn-hole-more">+{placeholders.length - 3}</span>}
        </div>
      )}

      <div className="cv-sn-foot">
        <div className="cv-sn-refs">
          {slots.list.slice(0, foot.shown).map((a) => (
            <RefThumb key={a.id} asset={a} badge={imageBadge(slots.first.get(a.id), a.imageIds.length)} named={foot.names} sceneId={scene.id} />
          ))}
          {foot.more > 0 && (
            <span className="cv-sn-more" title={slots.list.slice(foot.shown).map((a) => a.name).join(', ')}>
              +{foot.more}
            </span>
          )}
          <AddRef sceneId={scene.id} refs={scene.refs} images={slots.total} max={spec.maxRefImages} />
        </div>
        {/* the wrapper carries the full sentence as its title: a disabled button gets no pointer events */}
        <span className={`cv-sn-run-wrap${foot.compact ? ' is-compact' : ''}`} title={run.title}>
          <button
            type="button"
            className={`cv-sn-run nodrag${run.blocked ? ' is-blocked' : ''}`}
            disabled={!!reason}
            aria-label={run.blocked ? run.title : `Tạo video cho ${code} · ${scene.settings.duration} giây · ${run.label}`}
            onClick={(e) => {
              e.stopPropagation()
              requestRun([scene.id])
            }}
          >
            {run.blocked ? <Lock size={13} strokeWidth={2.2} /> : <Play size={11} fill="currentColor" />}
            <span>{run.label}</span>
          </button>
        </span>
      </div>
      {run.why && (
        <div className="cv-sn-why" title={run.title}>
          {run.why}
        </div>
      )}
    </div>
  )
}

/** "+": link one more library image to the scene (x/30 counts images: a character with 2 pictures counts 2). */
function AddRef({ sceneId, refs, images, max }: { sceneId: string; refs: string[]; images: number; max: number }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <span className="cv-sn-add in-pop-host nodrag nowheel nopan">
      <button
        ref={btn}
        type="button"
        className="cv-sn-add-btn"
        title={`Nối thêm ảnh tham chiếu (${images}/${max} ảnh) — hoặc kéo ô ảnh / nhân vật vào node`}
        aria-label="Nối thêm ảnh tham chiếu"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <Plus size={13} strokeWidth={2.2} />
      </button>
      {open && <AssetPicker exclude={refs} ignoreRef={btn} title={`Nối vào cảnh · ${images}/${max} ảnh`} onClose={() => setOpen(false)} onPick={(id) => linkAssets([sceneId], [id])} />}
    </span>
  )
}

/** Write a title being typed to the store (no-op when unchanged). */
function saveTitleDraft(sceneId: string, text: string) {
  const cur = sceneMapOf(useProject.getState().project.scenes).get(sceneId)
  if (cur && text.trim() !== cur.title) useProject.getState().updateScene(sceneId, { title: text.trim() })
}

function EditableTitle({ sceneId, title }: { sceneId: string; title: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  // Unsaved draft while editing. The node can unmount mid-edit (zoomed out to the far view, or culled off-screen) and
  // React drops the blur fired during that commit, so the draft is saved on unmount instead of being lost.
  const pending = useRef<string | null>(null)
  useEffect(
    () => () => {
      const text = pending.current
      pending.current = null
      if (text !== null) saveTitleDraft(sceneId, text)
    },
    [sceneId],
  )
  // Closing the window / hiding the tab does not blur the field (and React does not unmount on pagehide): save the
  // draft first. Capture phase, so it lands in the store before persist.ts writes the project on the same events.
  useEffect(() => {
    if (!editing) return
    const save = () => {
      if (pending.current !== null) saveTitleDraft(sceneId, pending.current)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') save()
    }
    window.addEventListener('pagehide', save, true)
    document.addEventListener('visibilitychange', onVisibility, true)
    return () => {
      window.removeEventListener('pagehide', save, true)
      document.removeEventListener('visibilitychange', onVisibility, true)
    }
  }, [editing, sceneId])
  const commit = () => {
    pending.current = null
    setEditing(false)
    if (draft.trim() !== title) useProject.getState().updateScene(sceneId, { title: draft.trim() })
  }
  if (editing) {
    return (
      <input
        className="cv-sn-title-input nodrag nopan nokey"
        autoFocus
        value={draft}
        placeholder="Tên cảnh"
        onChange={(e) => {
          pending.current = e.target.value
          setDraft(e.target.value)
        }}
        onBlur={commit}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          // Keep typing keys (Delete, Backspace, Enter, Escape…) away from the canvas and global shortcuts, but let
          // Ctrl/Cmd combos through: useShortcuts handles Ctrl+S (save) and Ctrl+Enter (run) even while typing and
          // ignores the other ones in a text field.
          if (!inlineEditKeyBubbles(e)) e.stopPropagation()
          // Ctrl+S saves the project and says "Đã lưu": the title being typed must be in it (editing goes on).
          else if (inlineEditSavesDraft(e) && pending.current !== null) saveTitleDraft(sceneId, pending.current)
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') {
            pending.current = null
            setDraft(title)
            setEditing(false)
          }
        }}
      />
    )
  }
  return (
    <span
      className={`cv-sn-title${title ? '' : ' is-empty'}`}
      title={title ? `${title} — bấm đúp để đổi tên` : 'Bấm đúp để đặt tên cảnh (không bắt buộc)'}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setDraft(title)
        setEditing(true)
      }}
    >
      {title || 'Bấm đúp để đặt tên'}
    </span>
  )
}

/** Hover this long before the preview opens (moving across a row of pictures does not flash previews). */
const PREVIEW_DELAY = 140
/** A press that moved further than this is a drag, not a click on the picture. */
const CLICK_SLOP = 4

/**
 * A linked image in the foot: its picture with the @image number(s) as a badge ("2–3" = a character with 2 pictures),
 * and its name when there is room. Hover = the whole picture (RefPreview); click = full-screen viewer; drag it onto
 * the prompt text = insert its tag there; × = unlink (like cutting its wire: numbers renumber, toast with Undo).
 */
function RefThumb({ asset, badge, named, sceneId }: { asset: Asset; badge: string; named: boolean; sceneId: string }) {
  const url = useMediaUrl(asset.imageIds[0])
  const hasImage = asset.imageIds.length > 0
  const label = badge ? `@image_${badge.replace('–', '…@image_')}` : 'chưa có ảnh'
  const [anchor, setAnchor] = useState<PreviewAnchor | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const down = useRef<{ x: number; y: number } | null>(null)
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const hide = () => {
    cancel()
    setAnchor(null)
  }
  useEffect(() => cancel, [])
  // The canvas may move under a resting pointer (wheel zoom / pan): drop the preview instead of leaving it behind.
  const showing = !!anchor
  useEffect(() => {
    if (!showing) return
    const off = () => setAnchor(null)
    window.addEventListener('wheel', off, { capture: true, passive: true })
    window.addEventListener('pointerdown', off, true)
    return () => {
      window.removeEventListener('wheel', off, { capture: true })
      window.removeEventListener('pointerdown', off, true)
    }
  }, [showing])
  return (
    <span
      className={`cv-sn-th nodrag${named ? ' is-named' : ''}${hasImage ? ' is-viewable' : ''}`}
      style={{ ['--av-c' as string]: asset.color }}
      title={hasImage ? undefined : `${asset.name} · ${label}`}
      draggable={hasImage}
      onDragStart={(e) => {
        hide()
        e.dataTransfer.effectAllowed = 'link'
        e.dataTransfer.setData(ASSETS_MIME, JSON.stringify([asset.id]))
        e.dataTransfer.setData('text/plain', asset.name)
      }}
      onPointerEnter={(e) => {
        if (!hasImage || e.buttons) return
        const el = e.currentTarget
        void measureImage(asset.imageIds[0])
        cancel()
        timer.current = setTimeout(() => {
          timer.current = null
          const r = el.getBoundingClientRect()
          setAnchor({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
        }, PREVIEW_DELAY)
      }}
      onPointerLeave={hide}
      onPointerDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY }
        hide()
      }}
      onClick={(e) => {
        const d = down.current
        down.current = null
        e.stopPropagation()
        if (!hasImage || e.shiftKey || e.ctrlKey || e.metaKey) return
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) return
        hide()
        viewImages(asset.imageIds, 0, asset.name)
      }}
    >
      <span className="cv-sn-th-i">{url ? <img src={url} alt={asset.name} draggable={false} /> : <i style={{ background: asset.color }}>{asset.name.slice(0, 1).toUpperCase()}</i>}</span>
      {badge && <b className="cv-sn-th-n">{badge}</b>}
      {named && <span className="cv-sn-th-name">{asset.name}</span>}
      {anchor && <RefPreview asset={asset} label={label} anchor={anchor} />}
      <button
        type="button"
        className="cv-sn-th-x nodrag"
        title={`Bỏ nối ${asset.name}`}
        aria-label={`Bỏ nối ${asset.name}`}
        onClick={(e) => {
          e.stopPropagation()
          // Same as cutting the wire: renumbers the prompt's @image_N and says so, with Undo.
          cutEdge(edgeId('ref', asset.id, sceneId))
        }}
      >
        <X size={9} strokeWidth={3} />
      </button>
    </span>
  )
}
