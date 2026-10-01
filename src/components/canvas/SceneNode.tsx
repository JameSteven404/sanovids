// Scene card on the canvas. Memoized; reads its own scene from the store by id.
// Its takes are separate Take nodes to the right (wired from the 'take' handle); the card only shows a status line.
import { Handle, Position, useStore, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/react'
import { Clapperboard, Film, ImagePlus, Link2, Play, TriangleAlert, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createAssetsFromFiles, linkAssets, requestRun, takeLabel } from '../../actions'
import { assetByTag, compileScene, imageSlotsFor, sceneCode } from '../../core/compile'
import { costOf, MODELS, settingsLabel } from '../../core/models'
import type { Asset, CompiledPrompt, Project, Scene } from '../../core/types'
import { useMediaUrl } from '../../lib/imageStore'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import {
  assetMapOf,
  countScenes,
  hasAssetDrag,
  hasFileDrag,
  imageFiles,
  LOD_ZOOM,
  readAssetIds,
  sceneMapOf,
  STATUS_COLOR,
  STATUS_LABEL,
  takeIndexOf,
  takeSummary,
  targetScenesFor,
  type TakeSummary,
} from './canvasModel'
import './canvas.css'

export type SceneFlowNode = Node<Record<string, unknown>, 'scene'>

const MAX_AVATARS = 6
const MAX_VIDEO_THUMBS = 4
const EMPTY_ASSETS: Asset[] = []

function SceneNodeView({ id, selected }: NodeProps<SceneFlowNode>) {
  const scene = useProject((s) => sceneMapOf(s.project.scenes).get(id))
  const far = useStore((s) => s.transform[2] < LOD_ZOOM)
  const status = useRuns((s) => takeSummary(s.takes, id).status)
  const progress = useRuns((s) => (takeSummary(s.takes, id).status === 'processing' ? takeSummary(s.takes, id).progress : 0))
  const libraryDrag = useUI((s) => !!s.draggingAssetIds)
  const multi = useUI((s) => (selected ? countScenes(s.selectedIds) : 0))
  const transform = scene?.settings.mode === 'transform'
  // Handles are added/removed with the H3 transform mode: re-measure them (not needed on mount).
  const updateInternals = useUpdateNodeInternals()
  const lastTransform = useRef(transform)
  useEffect(() => {
    if (lastTransform.current === transform) return
    lastTransform.current = transform
    updateInternals(id)
  }, [id, transform, updateInternals])

  // ---- HTML5 drop from the library (asset ids) or the OS (image files) ----
  const [dropHint, setDropHint] = useState<string | null>(null)
  const depth = useRef(0)
  const accepts = (e: DragEvent) => hasAssetDrag(e.dataTransfer) || hasFileDrag(e.dataTransfer)
  const onDragEnter = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    depth.current++
    const n = targetScenesFor(id).length
    const files = !hasAssetDrag(e.dataTransfer)
    setDropHint(files ? (n > 1 ? `Tạo & nối ảnh vào ${n} cảnh` : 'Thả ảnh để tạo & nối') : n > 1 ? `Nối vào ${n} cảnh đã chọn` : 'Thả để nối')
  }
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.stopPropagation()
  }
  const onDragLeave = (e: DragEvent) => {
    if (!accepts(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (!depth.current) setDropHint(null)
  }
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
      linkAssets(targets, ids)
      return
    }
    const files = imageFiles(e.dataTransfer)
    if (files.length) void createAssetsFromFiles(files, { position: null }).then((created) => linkAssets(targets, created))
  }

  if (!scene) return null
  const running = status === 'processing'
  const cls = ['cv-scene', selected && 'is-selected', dropHint && 'is-drop', libraryDrag && 'is-drop-target', running && 'is-running', far && 'is-far']
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cls} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {scene.color && <span className="cv-scene-stripe" style={{ background: scene.color }} />}
      {running && (
        <div className="cv-run-bar">
          <i style={{ width: `${Math.max(3, progress)}%` }} />
        </div>
      )}
      {far ? <SceneFar scene={scene} status={status} /> : <SceneFull scene={scene} status={status} />}

      <div className="cv-drop-hint">
        <Link2 size={14} />
        {dropHint}
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
        className="cv-h cv-h-ref"
        isConnectableStart={false}
        title="Tham chiếu: kéo nhân vật hoặc video vào bất kỳ đâu trên thẻ"
      />
      {/* Takes are created by running the scene, never by wiring: this handle only anchors the 'out' wires. */}
      <Handle type="source" position={Position.Right} id="take" className="cv-h cv-h-takes" isConnectable={false} title="Các video (take) tạo từ cảnh này" />
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
  )
}

export const SceneNode = memo(SceneNodeView)

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
function SceneFull({ scene, status }: { scene: Scene; status: TakeSummary['status'] }) {
  const assets = useProject((s) => s.project.assets)
  const settings = useProject((s) => s.project.settings)
  const presetName = useProject((s) => (scene.presetId ? s.project.presets.find((p) => p.id === scene.presetId)?.name : undefined))
  // Status of each @video ref as one string: stable while takes only make progress.
  const videoStatus = useRuns((s) => {
    if (!scene.videoRefs.length) return ''
    const byId = takeIndexOf(s.takes).byId
    return scene.videoRefs.map((t) => byId.get(t)?.status ?? '').join(',')
  })

  const compiled = useMemo<CompiledPrompt>(() => {
    const project: Project = { id: '', name: '', schemaVersion: 2, createdAt: 0, updatedAt: 0, presets: [], assets, settings, scenes: [scene] }
    const statuses = videoStatus.split(',')
    return compileScene(project, scene, { takeStatus: (id) => statuses[scene.videoRefs.indexOf(id)] || undefined })
  }, [assets, settings, scene, videoStatus])

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
  let reason: string | null = null
  if (!scene.prompt.trim()) reason = 'Prompt trống'
  else if (compiled.charCount > compiled.limit) reason = 'Prompt quá dài'
  else if (scene.settings.mode === 'i2v' && compiled.images.length === 0) reason = 'Thiếu ảnh tham chiếu'
  else if (scene.settings.mode === 'transform' && (!scene.firstFrame || !scene.lastFrame)) reason = 'Thiếu khung đầu/cuối'
  else if (videoStatus && videoStatus.split(',').some((st) => st !== 'completed')) reason = 'Video tham chiếu chưa sẵn sàng'

  const hasMedia = refAssets.length > 0 || scene.videoRefs.length > 0
  return (
    <>
      <div className="cv-scene-head">
        <span className="cv-code">{sceneCode(scene.order)}</span>
        <EditableTitle sceneId={scene.id} title={scene.title} />
        <span className="cv-model" style={{ color: spec.color }} title={spec.name}>
          {spec.short}
        </span>
        <span className={`status-dot ${status ?? ''}`} title={status ? `Take mới nhất: ${STATUS_LABEL[status]}` : 'Chưa chạy'} />
      </div>

      <div className="cv-refs">
        {hasMedia ? (
          <>
            {refAssets.slice(0, MAX_AVATARS).map((a) => (
              <RefAvatar key={a.id} asset={a} n={slots.first.get(a.id)} sceneId={scene.id} />
            ))}
            {refAssets.length > MAX_AVATARS && (
              <span className="cv-av-more" title={refAssets.slice(MAX_AVATARS).map((a) => a.name).join(', ')}>
                +{refAssets.length - MAX_AVATARS}
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

      <div className="cv-prompt">
        {scene.prompt.trim() ? (
          <Excerpt text={scene.prompt} assets={assets} images={slots.total} videos={scene.videoRefs.length} />
        ) : (
          <span className="faint">Chưa có prompt</span>
        )}
      </div>

      <div className="cv-scene-foot">
        <span className="cv-settings" title={presetName ? `Preset: ${presetName}` : undefined}>
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
        <span className="cv-cost">{cost} cr</span>
        <span className="cv-run-wrap" title={reason ? `Chưa chạy được: ${reason}` : `Chạy ${sceneCode(scene.order)} · ${cost} credit`}>
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
    </>
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

/** Small purple thumbs of the scene's @video refs: v1, v2… (× removes the reference; tokens are renumbered). */
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
              useProject.getState().removeVideoRef(sceneId, takeId, 'video ' + takeLabel(takeId))
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
      if (text === null) return
      const cur = sceneMapOf(useProject.getState().project.scenes).get(sceneId)
      if (cur && text.trim() !== cur.title) useProject.getState().updateScene(sceneId, { title: text.trim() })
    },
    [sceneId],
  )
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
          e.stopPropagation()
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
      className={`cv-title ${title ? '' : 'empty'}`}
      title="Bấm đúp để đổi tên"
      onDoubleClick={(e) => {
        e.stopPropagation()
        setDraft(title)
        setEditing(true)
      }}
    >
      {title || 'Chưa đặt tên'}
    </span>
  )
}

/** Avatar of a linked asset with its first @image number as a badge. */
function RefAvatar({ asset, n, sceneId }: { asset: Asset; n: number | undefined; sceneId: string }) {
  const url = useMediaUrl(asset.imageIds[0])
  const range = n !== undefined && asset.imageIds.length > 1 ? `@image_${n}…${n + asset.imageIds.length - 1}` : n !== undefined ? `@image_${n}` : 'chưa có ảnh'
  return (
    <span className={`cv-av ${asset.kind === 'character' ? '' : 'sq'}`} style={{ ['--av-c' as string]: asset.color }} title={`${asset.name} · ${range}`}>
      {url ? <img src={url} alt={asset.name} draggable={false} /> : <i style={{ background: asset.color }}>{asset.name.slice(0, 1).toUpperCase()}</i>}
      {n !== undefined && <b className="cv-av-n">{n}</b>}
      <button
        className="cv-av-x nodrag"
        title={`Bỏ nối ${asset.name}`}
        aria-label={`Bỏ nối ${asset.name}`}
        onClick={(e) => {
          e.stopPropagation()
          useProject.getState().removeRef(sceneId, asset.id)
        }}
      >
        <X size={9} strokeWidth={3} />
      </button>
    </span>
  )
}

const SPLIT_RE = /(@[\p{L}\p{N}_]+)/u
const TOKEN_ONLY = /^@(image|video)_(\d+)$/i
/** Prompt excerpt: @image_N teal, @video_N purple, numbers without media red, legacy @Tag of a library asset teal. */
function Excerpt({ text, assets, images, videos }: { text: string; assets: Asset[]; images: number; videos: number }) {
  const parts = useMemo(() => {
    const src = text.length > 280 ? text.slice(0, 280) : text
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
  }, [text, assets, images, videos])
  return <>{parts}</>
}
