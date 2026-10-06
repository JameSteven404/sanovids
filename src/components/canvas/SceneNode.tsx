// Scene card on the canvas. Memoized; reads its own scene from the store by id.
// Its takes are separate Take nodes to the right (wired from the 'take' handle); the card only shows a status line.
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react'
import { Ban, Clapperboard, Film, ImagePlus, Link2, Play, TriangleAlert, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createAssetsFromFiles, edgeId, linkAssets, linkTakes, requestRun, takeLabel, viewImages } from '../../actions'
import { assetByTag, compileScene, imageSlotsFor, sceneCode } from '../../core/compile'
import { refStatusLookup, runBlockReason } from '../../core/runGate'
import { costOf, MODELS, settingsLabel } from '../../core/models'
import type { Asset, CompiledPrompt, Project, Scene, Size } from '../../core/types'
import { CREDIT_MARK, formatCredits } from '../../lib/credits'
import { measureImage } from '../../lib/imageMeta'
import { useMediaUrl } from '../../lib/imageStore'
import { useCreditKind } from '../../store/credits'
import { LAYOUT, useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { useGatewayRefVideoCap } from '../runs/shared'
import { costTitle, creditTone } from '../sidebar/shared'
import {
  assetMapOf,
  avatarSlots,
  countScenes,
  DOT_TOP,
  excerptChars,
  hasAssetDrag,
  hasFileDrag,
  hasTakeDrag,
  imageFiles,
  inlineEditKeyBubbles,
  inlineEditSavesDraft,
  LOD_ZOOM,
  promptLines,
  readAssetIds,
  readTakeIds,
  sceneMapOf,
  STATUS_COLOR,
  STATUS_LABEL,
  takeIndexOf,
  takesUsableFor,
  takeSummary,
  targetScenesFor,
  type TakeSummary,
} from './canvasModel'
import { cutEdge } from './edges'
import { NodeSizer, useNodeBox, useRemeasureOn } from './NodeSizer'
import { RefPreview, type PreviewAnchor } from './RefPreview'
import type { RefDotTone } from './wireFx'
import './canvas.css'

/** `refDot`: what the wires drawn into the reference dot carry (CanvasView, wireFx.refDotTones); absent = images only / none. */
export type SceneNodeData = { refDot?: RefDotTone }
export type SceneFlowNode = Node<SceneNodeData, 'scene'>

const MAX_VIDEO_THUMBS = 4
const EMPTY_ASSETS: Asset[] = []

/** The scene's two dots sit at the height of an unresized take's dots: the scene → take wire runs straight. */
const DOT_STYLE = { top: DOT_TOP }

function SceneNodeView({ id, selected, data }: NodeProps<SceneFlowNode>) {
  const scene = useProject((s) => sceneMapOf(s.project.scenes).get(id))
  const far = useStore((s) => s.transform[2] < LOD_ZOOM)
  const status = useRuns((s) => takeSummary(s.takes, id).status)
  const progress = useRuns((s) => (takeSummary(s.takes, id).status === 'processing' ? takeSummary(s.takes, id).progress : 0))
  const libraryDrag = useUI((s) => !!s.draggingAssetIds)
  // A video (take) is being dragged from the library / a take strip: light up the scenes that can use it as @video.
  const takeTarget = useUI((s) => !!s.draggingTakeIds && takesUsableFor(s.draggingTakeIds, id))
  const multi = useUI((s) => (selected ? countScenes(s.selectedIds) : 0))
  const box = useNodeBox(id, scene?.size)
  const transform = scene?.settings.mode === 'transform'
  // Handles are added/removed with the H3 transform mode: re-measure them.
  useRemeasureOn(id, transform)

  // ---- HTML5 drop: library cards (asset ids), generated videos (take ids → @video) or OS image files ----
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const depth = useRef(0)
  const accepts = (e: DragEvent) => hasTakeDrag(e.dataTransfer) || hasAssetDrag(e.dataTransfer) || hasFileDrag(e.dataTransfer)
  const onDragEnter = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    depth.current++
    setDropHint(dropHintFor(id, e.dataTransfer))
  }
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return
    // Always swallow it here so a refused video never falls through to the canvas (which would create a scene).
    e.preventDefault()
    e.stopPropagation()
    if (dropHint?.kind === 'bad') e.dataTransfer.dropEffect = 'none'
  }
  const onDragLeave = (e: DragEvent) => {
    if (!accepts(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (!depth.current) setDropHint(null)
  }
  // A cancelled or refused drop (Esc, "bad" video) may skip the matching dragleave: reset when any drag ends.
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
    if (hasTakeDrag(e.dataTransfer)) {
      const takeIds = readTakeIds(e.dataTransfer)
      useUI.getState().setDraggingTakes(null)
      // linkTakes checks readiness, own-scene loops and model limits, and reports (multi-target like assets).
      if (takeIds.length) linkTakes(targets, takeIds)
      return
    }
    const ids = readAssetIds(e.dataTransfer)
    useUI.getState().setDraggingAssets(null)
    if (ids && ids.length) {
      linkAssets(targets, ids)
      return
    }
    const files = imageFiles(e.dataTransfer)
    if (files.length) void createAssetsFromFiles(files, { position: null }).then((created) => linkAssets(targets, created))
  }

  if (!scene) return null
  const running = status === 'processing'
  // The reference dot takes the color of the wires drawn into it: teal images, purple videos, two-tone for both.
  const refDot = data?.refDot ? ` is-${data.refDot}` : ''
  const cls = [
    'cv-scene',
    selected && 'is-selected',
    dropHint && 'is-drop',
    dropHint && dropHint.kind !== 'asset' && `is-drop-${dropHint.kind}`,
    libraryDrag && 'is-drop-target',
    takeTarget && 'is-take-target',
    running && 'is-running',
    far && 'is-far',
    box && 'is-sized',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <>
      <div className={cls} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {scene.color && <span className="cv-scene-stripe" style={{ background: scene.color }} />}
        {running && (
          <div className="cv-run-bar">
            <i style={{ width: `${Math.max(3, progress)}%` }} />
          </div>
        )}
        {far ? <SceneFar scene={scene} status={status} /> : <SceneFull scene={scene} status={status} box={box} />}

        <div className="cv-drop-hint">
          {dropHint?.kind === 'take' ? <Film size={14} /> : dropHint?.kind === 'bad' ? <Ban size={14} /> : <Link2 size={14} />}
          {dropHint?.text}
        </div>
        <div className="cv-conn-hint asset">
          <Link2 size={14} />
          {multi > 1 ? `Nối vào ${multi} cảnh đã chọn` : 'Thả để nối'}
        </div>
        <div className="cv-conn-hint take">
          <Film size={14} />
          {multi > 1 ? `Dùng làm @video cho ${multi} cảnh` : 'Dùng làm @video'}
        </div>

        <Handle
          type="target"
          position={Position.Left}
          id="ref"
          className={`cv-h cv-h-ref${refDot}`}
          style={DOT_STYLE}
          isConnectableStart={false}
          title="Tham chiếu: kéo nhân vật hoặc video vào bất kỳ đâu trên thẻ"
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
  /** asset: images / library cards (teal) · take: video → @video (purple) · bad: this video cannot be used here. */
  kind: 'asset' | 'take' | 'bad'
  text: string
}

/** What dropping this drag on the scene would do. Payload ids are unreadable before `drop`, so take drags are judged
 *  by `ui.draggingTakeIds` (announced by the drag source); without it the drop is accepted and linkTakes reports. */
function dropHintFor(sceneId: string, dt: DataTransfer): DropHint {
  const targets = targetScenesFor(sceneId)
  const n = targets.length
  if (hasTakeDrag(dt)) {
    const dragging = useUI.getState().draggingTakeIds
    if (dragging?.length && !targets.some((sid) => takesUsableFor(dragging, sid))) {
      const byId = takeIndexOf(useRuns.getState().takes).byId
      const ready = dragging.some((t) => byId.get(t)?.status === 'completed')
      return { kind: 'bad', text: ready ? 'Video của chính cảnh này — không dùng được' : 'Video chưa tạo xong' }
    }
    return { kind: 'take', text: n > 1 ? `Dùng làm @video cho ${n} cảnh đã chọn` : 'Thả để dùng làm @video' }
  }
  if (!hasAssetDrag(dt)) return { kind: 'asset', text: n > 1 ? `Tạo & nối ảnh vào ${n} cảnh` : 'Thả ảnh để tạo & nối' }
  return { kind: 'asset', text: n > 1 ? `Nối vào ${n} cảnh đã chọn` : 'Thả để nối' }
}

// ---------------------------------------------------------------------------------------------
function SceneFar({ scene, status }: { scene: Scene; status: TakeSummary['status'] }) {
  const posterId = useRuns((s) => takeSummary(s.takes, scene.id).posterId)
  const st = status
  return (
    <div className="cv-far">
      <div className="cv-far-bar" style={{ background: st ? STATUS_COLOR[st] : 'var(--border-strong)' }} />
      <div className="cv-far-poster">{posterId ? <MediaImg id={posterId} /> : <span className="cv-far-code-bg">{sceneCode(scene.order)}</span>}</div>
      <div className="cv-far-meta">
        <span className="cv-far-code">{sceneCode(scene.order)}</span>
        <span className="cv-far-title">{scene.title || 'Chưa đặt tên'}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
/** `box`: size of a resized card (null = default): more prompt lines when taller, more avatars when wider. */
function SceneFull({ scene, status, box }: { scene: Scene; status: TakeSummary['status']; box: Size | null }) {
  const assets = useProject((s) => s.project.assets)
  const settings = useProject((s) => s.project.settings)
  const presetName = useProject((s) => (scene.presetId ? s.project.presets.find((p) => p.id === scene.presetId)?.name : undefined))
  // Status of each @video ref as one string: stable while takes only make progress.
  const videoStatus = useRuns((s) => {
    if (!scene.videoRefs.length) return ''
    const byId = takeIndexOf(s.takes).byId
    return scene.videoRefs.map((t) => byId.get(t)?.status ?? '').join(',')
  })

  const takeStatus = useMemo(() => refStatusLookup(scene.videoRefs, videoStatus), [scene.videoRefs, videoStatus])
  const compiled = useMemo<CompiledPrompt>(() => {
    const project: Project = { id: '', name: '', schemaVersion: 2, createdAt: 0, updatedAt: 0, presets: [], assets, settings, scenes: [scene] }
    return compileScene(project, scene, { takeStatus })
  }, [assets, settings, scene, takeStatus])

  const refAssets = useMemo(() => {
    const map = assetMapOf(assets)
    const out = scene.refs.map((r) => map.get(r)).filter((a): a is Asset => !!a)
    return out.length ? out : EMPTY_ASSETS
  }, [assets, scene.refs])
  /** First @image number of each linked asset (every image of an asset gets its own number) + total images. */
  const slots = useMemo(() => {
    const first = new Map<string, number>()
    const all = imageSlotsFor(assets, scene.refs)
    for (const s of all) if (!first.has(s.assetId)) first.set(s.assetId, s.n)
    return { first, total: all.length }
  }, [assets, scene.refs])

  const spec = MODELS[scene.settings.model]
  const cost = costOf(scene.settings)
  // Wallet of the next run: simulated credit dev (development mode) or real canvasapp credits (docs/SPEC-v2.md §9, §11).
  const creditKind = useCreditKind()
  // The queue's own rules (core/runGate, = store/runs check()): @video against the gateway's cap, and only the videos
  // this model/mode really sends — a leftover reference of an H3 t2v / transform scene does not block it.
  const videoCap = useGatewayRefVideoCap(scene.settings.model)
  const reason = runBlockReason(scene, compiled, assets, { maxRefVideos: videoCap, takeStatus })

  const hasTakes = useRuns((s) => takeSummary(s.takes, scene.id).count > 0)
  const hasMedia = refAssets.length > 0 || scene.videoRefs.length > 0
  const maxAvatars = avatarSlots(box?.w ?? LAYOUT.sceneW, Math.min(scene.videoRefs.length, MAX_VIDEO_THUMBS))
  const lines = box ? promptLines(box.h, hasTakes) : 2
  const maxChars = box ? excerptChars(lines, box.w) : 280
  return (
    <div className="cv-scene-body">
      <div className="cv-scene-head">
        <span className="cv-code">{sceneCode(scene.order)}</span>
        <EditableTitle sceneId={scene.id} title={scene.title} />
        <span className="cv-model" style={{ ['--model-c' as string]: spec.color }} title={spec.name}>
          {spec.short}
        </span>
        <span className={`status-dot ${status ?? ''}`} title={status ? `Take mới nhất: ${STATUS_LABEL[status]}` : 'Chưa chạy'} />
      </div>

      <div className="cv-refs">
        {hasMedia ? (
          <>
            {refAssets.slice(0, maxAvatars).map((a) => (
              <RefAvatar key={a.id} asset={a} n={slots.first.get(a.id)} sceneId={scene.id} />
            ))}
            {refAssets.length > maxAvatars && (
              <span className="cv-av-more" title={refAssets.slice(maxAvatars).map((a) => a.name).join(', ')}>
                +{refAssets.length - maxAvatars}
              </span>
            )}
            {scene.videoRefs.length > 0 && <VideoRefs sceneId={scene.id} videoRefs={scene.videoRefs} />}
          </>
        ) : (
          <span className="cv-refs-empty">
            <ImagePlus size={13} /> Kéo nhân vật hoặc video vào đây
          </span>
        )}
      </div>

      <div className="cv-prompt-box">
        <div className="cv-prompt" style={box ? { WebkitLineClamp: lines } : undefined}>
          {scene.prompt.trim() ? (
            <Excerpt text={scene.prompt} assets={assets} images={slots.total} videos={scene.videoRefs.length} maxChars={maxChars} />
          ) : (
            <span className="faint">Chưa có prompt</span>
          )}
        </div>
      </div>

      <div className="cv-scene-foot">
        <span className="cv-settings" title={presetName ? `${settingsLabel(scene.settings)} · Preset: ${presetName}` : settingsLabel(scene.settings)}>
          {settingsLabel(scene.settings)}
        </span>
        {presetName && <span className="cv-preset">{presetName}</span>}
        <span className="cv-spacer" />
        {compiled.warnings.length > 0 && (
          <span className="cv-warn" title={compiled.warnings.map((w) => '• ' + w).join('\n')}>
            <TriangleAlert size={13} />
            {compiled.warnings.length > 1 ? compiled.warnings.length : null}
          </span>
        )}
        <span className={`cv-cost ${creditTone(creditKind)}`} title={costTitle(cost, creditKind)}>
          {formatCredits(cost, creditKind, { short: true })}
          {CREDIT_MARK[creditKind] && <span className="cv-cost-mark">{CREDIT_MARK[creditKind]}</span>}
        </span>
        <span className="cv-run-wrap" title={reason ? `Chưa chạy được: ${reason}` : costTitle(cost, creditKind, `Chạy ${sceneCode(scene.order)} · `)}>
          <button
            className="cv-run nodrag"
            disabled={!!reason}
            aria-label="Chạy cảnh"
            onClick={(e) => {
              e.stopPropagation()
              requestRun([scene.id])
            }}
          >
            <Play size={12} fill="currentColor" />
          </button>
        </span>
      </div>

      <TakeLine sceneId={scene.id} />
    </div>
  )
}

/** "3 take · ★ T2 · đang chạy 45%" — the takes themselves are nodes to the right of the card. */
function TakeLine({ sceneId }: { sceneId: string }) {
  const count = useRuns((s) => takeSummary(s.takes, sceneId).count)
  const starred = useRuns((s) => takeSummary(s.takes, sceneId).starredNumber)
  const active = useRuns((s) => takeSummary(s.takes, sceneId).active)
  const progress = useRuns((s) => {
    const sum = takeSummary(s.takes, sceneId)
    return sum.status === 'processing' ? sum.progress : -1
  })
  if (!count) return null
  return (
    <div className="cv-take-line">
      <Clapperboard size={12} />
      <span>{count} take</span>
      {starred !== null && <span className="cv-take-line-star">★ T{starred}</span>}
      {active > 0 && <span className="cv-take-line-run">{progress >= 0 ? `đang chạy ${progress}%` : `${active} đang chờ`}</span>}
    </div>
  )
}

/**
 * Small purple thumbs of the scene's @video refs: v1, v2… × removes the reference like cutting its wire (tokens are
 * renumbered, toast with Undo).
 */
function VideoRefs({ sceneId, videoRefs }: { sceneId: string; videoRefs: string[] }) {
  const posters = useRuns(
    useShallow((s) => {
      const byId = takeIndexOf(s.takes).byId
      return videoRefs.map((id) => byId.get(id)?.posterId ?? null)
    }),
  )
  return (
    <span className="cv-vrefs">
      {videoRefs.slice(0, MAX_VIDEO_THUMBS).map((takeId, i) => (
        <span key={takeId} className="cv-vref" title={`@video_${i + 1} · ${takeLabel(takeId)}`}>
          <MediaImg id={posters[i]} className="cv-vref-img" />
          <span className="cv-vref-n">v{i + 1}</span>
          <button
            className="cv-av-x nodrag"
            title={`Bỏ @video_${i + 1}`}
            aria-label={`Bỏ video tham chiếu ${i + 1}`}
            onClick={(e) => {
              e.stopPropagation()
              cutEdge(edgeId('vref', takeId, sceneId))
            }}
          >
            <X size={9} strokeWidth={3} />
          </button>
        </span>
      ))}
      {videoRefs.length > MAX_VIDEO_THUMBS && <span className="cv-av-more">+{videoRefs.length - MAX_VIDEO_THUMBS}</span>}
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
  // Unsaved draft while editing. The card can unmount mid-edit (zoomed out to the LOD card, or culled off-screen) and
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
        className="cv-title-input nodrag nopan"
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
      className={`cv-title${title ? '' : ' is-empty'}`}
      title={title ? 'Bấm đúp để đổi tên' : 'Bấm đúp để đặt tên cảnh (không bắt buộc)'}
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

/** Hover this long before the preview opens (moving across a row of avatars does not flash previews). */
const PREVIEW_DELAY = 140
/** A press that moved further than this is a drag of the card, not a click on the avatar. */
const CLICK_SLOP = 4

/**
 * Square avatar of a linked asset with its first @image number as a badge. Hovering it shows the whole picture
 * (RefPreview, only for the hovered avatar); a click opens the full-screen viewer.
 */
function RefAvatar({ asset, n, sceneId }: { asset: Asset; n: number | undefined; sceneId: string }) {
  const url = useMediaUrl(asset.imageIds[0])
  const range = n !== undefined && asset.imageIds.length > 1 ? `@image_${n}…${n + asset.imageIds.length - 1}` : n !== undefined ? `@image_${n}` : 'chưa có ảnh'
  const hasImage = asset.imageIds.length > 0
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
      className={`cv-av${hasImage ? ' is-viewable' : ''}`}
      style={{ ['--av-c' as string]: asset.color }}
      title={hasImage ? undefined : `${asset.name} · ${range}`}
      onPointerEnter={(e) => {
        // Not while a wire, a card or a selection box is being dragged across it.
        if (!hasImage || e.buttons) return
        const el = e.currentTarget
        // Measure the picture during the delay, so the preview opens at its real aspect ratio (no square → resize jump).
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
        if (!hasImage || e.shiftKey || e.ctrlKey || e.metaKey) return
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) return
        hide()
        viewImages(asset.imageIds, 0, asset.name)
      }}
    >
      {url ? <img src={url} alt={asset.name} draggable={false} /> : <i style={{ background: asset.color }}>{asset.name.slice(0, 1).toUpperCase()}</i>}
      {anchor && <RefPreview asset={asset} label={range} anchor={anchor} />}
      {n !== undefined && <b className="cv-av-n">{n}</b>}
      <button
        className="cv-av-x nodrag"
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

const SPLIT_RE = /(@(?:image|video)[ _]?\d+(?![\p{L}\p{N}_])|@[\p{L}\p{N}_]+)/iu
const TOKEN_ONLY = /^@(image|video)[ _]?(\d+)$/i
/** Prompt excerpt: @image_N teal, @video_N purple, numbers without media red, legacy @Tag of a library asset teal. */
function Excerpt({ text, assets, images, videos, maxChars }: { text: string; assets: Asset[]; images: number; videos: number; maxChars: number }) {
  const parts = useMemo(() => {
    const src = text.length > maxChars ? text.slice(0, maxChars) : text
    const out: ReactNode[] = []
    src.split(SPLIT_RE).forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) out.push(part)
        return
      }
      const tok = TOKEN_ONLY.exec(part)
      if (tok) {
        const video = tok[1].toLowerCase() === 'video'
        const n = Number(tok[2])
        const ok = n >= 1 && n <= (video ? videos : images)
        out.push(
          <span key={i} className={`cv-m ${video ? 'vid' : 'img'}${ok ? '' : ' bad'}`} title={ok ? undefined : `Cảnh không có ${video ? 'video' : 'ảnh'} số ${n}`}>
            {part}
          </span>,
        )
      } else if (assetByTag(assets, part.slice(1))) {
        out.push(
          <span key={i} className="cv-m">
            {part}
          </span>,
        )
      } else out.push(part)
    })
    return out
  }, [text, assets, images, videos, maxChars])
  return <>{parts}</>
}
