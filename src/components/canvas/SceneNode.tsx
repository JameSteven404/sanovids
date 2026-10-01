// Scene card on the canvas. Memoized; reads its own scene from the store by id.
import { Handle, Position, useStore, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/react'
import { ImagePlus, Link2, Play, TriangleAlert, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { createAssetsFromFiles, linkAssets, requestRun } from '../../actions'
import { assetByTag, compileScene, sceneCode } from '../../core/compile'
import { costOf, MODELS, settingsLabel } from '../../core/models'
import type { Asset, CompiledPrompt, Project, Scene } from '../../core/types'
import { useMediaUrl } from '../../lib/imageStore'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { TakeStrip } from '../runs/TakeStrip'
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
  takeSummary,
  targetScenesFor,
  type TakeSummary,
} from './canvasModel'
import './canvas.css'

export type SceneFlowNode = Node<Record<string, unknown>, 'scene'>

const MAX_AVATARS = 6
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
      <div className="cv-conn-hint scene">
        <Link2 size={14} />
        Nối tiếp sau cảnh này
      </div>

      <Handle type="target" position={Position.Left} id="ref" className="cv-h cv-h-ref" isConnectableStart={false} title="Tham chiếu: kéo nhân vật vào đây" />
      <Handle type="source" position={Position.Right} id="seq" className="cv-h cv-h-seq" title="Kéo sang cảnh khác: nối tiếp (cảnh sau)" />
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
  const blocks = useProject((s) => s.project.blocks)
  const settings = useProject((s) => s.project.settings)
  const prev = useProject((s) => (scene.continueFrom ? sceneMapOf(s.project.scenes).get(scene.continueFrom) : undefined))
  const presetName = useProject((s) => (scene.presetId ? s.project.presets.find((p) => p.id === scene.presetId)?.name : undefined))
  const takeCount = useRuns((s) => takeSummary(s.takes, scene.id).count)

  const compiled = useMemo<CompiledPrompt>(() => {
    const project: Project = {
      id: '',
      name: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
      presets: [],
      assets,
      blocks,
      settings,
      scenes: prev ? [prev] : [],
    }
    return compileScene(project, scene)
  }, [assets, blocks, settings, prev, scene])

  const refAssets = useMemo(() => {
    const map = assetMapOf(assets)
    const out = scene.refs.map((r) => map.get(r)).filter((a): a is Asset => !!a)
    return out.length ? out : EMPTY_ASSETS
  }, [assets, scene.refs])
  const imageN = useMemo(() => {
    const m = new Map<string, number>()
    for (const img of compiled.images) if (!m.has(img.assetId)) m.set(img.assetId, img.n)
    return m
  }, [compiled.images])

  const spec = MODELS[scene.settings.model]
  const cost = costOf(scene.settings)
  let reason: string | null = null
  if (!scene.prompt.trim()) reason = 'Prompt trống'
  else if (compiled.charCount > compiled.limit) reason = 'Prompt quá dài'
  else if (scene.settings.mode === 'i2v' && compiled.images.length === 0) reason = 'Thiếu ảnh tham chiếu'
  else if (scene.settings.mode === 'transform' && (!scene.firstFrame || !scene.lastFrame)) reason = 'Thiếu khung đầu/cuối'

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
        {refAssets.length ? (
          <>
            {refAssets.slice(0, MAX_AVATARS).map((a) => (
              <RefAvatar key={a.id} asset={a} n={imageN.get(a.id)} sceneId={scene.id} />
            ))}
            {refAssets.length > MAX_AVATARS && (
              <span className="cv-av-more" title={refAssets.slice(MAX_AVATARS).map((a) => '@' + a.tag).join(', ')}>
                +{refAssets.length - MAX_AVATARS}
              </span>
            )}
          </>
        ) : (
          <span className="cv-refs-empty">
            <ImagePlus size={13} /> Kéo nhân vật vào đây
          </span>
        )}
      </div>

      <div className="cv-prompt">{scene.prompt.trim() ? <Excerpt text={scene.prompt} assets={assets} /> : <span className="faint">Chưa có prompt</span>}</div>

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

      {takeCount > 0 && (
        <div className="cv-takes nodrag">
          <TakeStrip sceneId={scene.id} size="sm" />
        </div>
      )}
    </>
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

function RefAvatar({ asset, n, sceneId }: { asset: Asset; n: number | undefined; sceneId: string }) {
  const url = useMediaUrl(asset.imageIds[0])
  return (
    <span
      className={`cv-av ${asset.kind === 'character' ? '' : 'sq'}`}
      style={{ ['--av-c' as string]: asset.color }}
      title={`@${asset.tag} · ${n ? '@image_' + n : 'không gửi ảnh'}`}
    >
      {url ? <img src={url} alt={asset.name} draggable={false} /> : <i style={{ background: asset.color }}>{asset.name.slice(0, 1).toUpperCase()}</i>}
      <button
        className="cv-av-x nodrag"
        title={`Bỏ nối @${asset.tag}`}
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
function Excerpt({ text, assets }: { text: string; assets: Asset[] }) {
  const parts = useMemo(() => {
    const src = text.length > 280 ? text.slice(0, 280) : text
    const out: ReactNode[] = []
    src.split(SPLIT_RE).forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) out.push(part)
        return
      }
      const tag = part.slice(1)
      if (/^image_\d+$/i.test(tag)) out.push(<span key={i} className="cv-m img">{part}</span>)
      else if (assetByTag(assets, tag)) out.push(<span key={i} className="cv-m">{part}</span>)
      else out.push(<span key={i} className="cv-m unknown" title="Chưa có trong thư viện">{part}</span>)
    })
    return out
  }, [text, assets])
  return <>{parts}</>
}
