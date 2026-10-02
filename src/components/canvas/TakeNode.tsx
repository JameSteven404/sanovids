// Take (video) node on the canvas: one generation attempt of a scene. Memoized; reads its take from the runs store.
// Wired from its scene ('out' edge) and, once completed, usable as @video_N by other scenes (drag its right handle).
import { Handle, Position, useStore, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/react'
import { Ban, CircleAlert, Clock, Cloud, Download, Eye, LoaderCircle, RotateCcw, Star, Trash2 } from 'lucide-react'
import { memo, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { deleteTakes, downloadTake, rerunTake } from '../../actions'
import { sceneCode, takeCode } from '../../core/compile'
import { settingsLabel } from '../../core/models'
import type { JobStatus, Take } from '../../core/types'
import { useDownloadPrefs } from '../../lib/downloads'
import { useMediaUrl } from '../../lib/imageStore'
import { usePlayback } from '../../lib/playback'
import { PROVIDER_LABEL, providerOf } from '../../providers'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { fitMedia, LOD_ZOOM, sceneMapOf, STATUS_LABEL, TAKE_CHROME, takeIndexOf, videoUsageOf } from './canvasModel'
import { NodeSizer, useNodeBox } from './NodeSizer'
import { TakePlayer } from './TakePlayer'
import './canvas.css'

/** `status` is only carried so the node object changes with it (minimap color); the node reads its take itself. */
export type TakeNodeData = { hidden: number; status: JobStatus }
export type TakeFlowNode = Node<TakeNodeData, 'take'>

const stop = (e: SyntheticEvent) => e.stopPropagation()

function openTake(takeId: string) {
  useUI.getState().openDialog({ kind: 'take', takeId })
}

/**
 * Delete one take (not undoable) through actions.deleteTakes: asks first only when scenes use it as @video — the
 * node's trash button already needed a second click (TakeDeleteButton), like the viewer's. deleteTakes also removes
 * its media blobs, drops it from the selection and says so in a toast.
 */
export function deleteTake(takeId: string) {
  deleteTakes([takeId], { confirm: 'usedOnly' })
}

/** How long the trash button stays armed after the first click. */
const ARM_MS = 3500

/**
 * Trash button of a take node. Deleting a video cannot be undone and the button sits next to "Chạy lại", so the
 * first click only arms it ("Xoá?", red) and the second one deletes; it disarms after a few seconds or when the
 * pointer leaves. A take used as @video goes straight to deleteTake's confirm dialog instead.
 */
function TakeDeleteButton({ takeId, used }: { takeId: string; used: boolean }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), ARM_MS)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      className={`cv-take-btn danger${armed ? ' is-armed' : ''}`}
      title={armed ? 'Bấm lần nữa để xoá (không hoàn tác được)' : 'Xoá take'}
      aria-label={armed ? 'Bấm lần nữa để xoá take' : 'Xoá take'}
      onMouseLeave={() => setArmed(false)}
      onClick={(e) => {
        e.stopPropagation()
        if (!armed && !used) {
          setArmed(true)
          return
        }
        setArmed(false)
        deleteTake(takeId)
      }}
    >
      <Trash2 size={14} strokeWidth={1.75} />
      {armed && <span>Xoá?</span>}
    </button>
  )
}

function TakeNodeView({ id, selected, data }: NodeProps<TakeFlowNode>) {
  const take = useRuns((s) => takeIndexOf(s.takes).byId.get(id))
  const order = useProject((s) => (take ? sceneMapOf(s.project.scenes).get(take.sceneId)?.order : undefined))
  const usage = useProject((s) => videoUsageOf(s.project.scenes).get(id) ?? 0)
  const far = useStore((s) => s.transform[2] < LOD_ZOOM)
  const [hover, setHover] = useState(false)
  const done = take?.status === 'completed'
  // The player stays open after the mouse leaves once one of its controls was used (pinned, see TakePlayer).
  const pinned = usePlayback((s) => s.pinned === id)
  const previewing = hover && done && !far
  const videoUrl = useMediaUrl((previewing || pinned) && done && !far ? take?.videoId : null)
  // This node is the hover preview: a pinned player elsewhere pauses (never two videos with sound at once). Only when
  // it really plays something: a poster-only take (no video recorded) or a missing video blob mounts no player, so it
  // must not pause the pinned one. The pause then lands in the same commit as this node's player.
  const claimsHover = previewing && !!videoUrl
  useEffect(() => {
    if (!claimsHover) return
    usePlayback.getState().setHoverId(id)
    return () => usePlayback.getState().clearHoverId(id)
  }, [claimsHover, id])
  const box = useNodeBox(id, take?.size)
  // Resized node: the poster keeps 16:9 and grows with the node; footer + big button stay pinned at the bottom.
  const media = box ? fitMedia(box.w, box.h, far ? 0 : TAKE_CHROME) : null
  // Wire anchors stay at the middle of the (grown) poster.
  const handleTop = media ? Math.round(media.h / 2) + 1 : null
  const handleStyle = handleTop !== null ? { top: handleTop } : undefined
  // The anchors can move while the node box stays the same (zooming across the LOD level changes the poster height):
  // React Flow only re-measures handles when the node's size changes, so ask for it (not needed on mount).
  const updateInternals = useUpdateNodeInternals()
  const lastTop = useRef(handleTop)
  useEffect(() => {
    if (lastTop.current === handleTop) return
    lastTop.current = handleTop
    updateInternals(id)
  }, [id, handleTop, updateInternals])
  if (!take) return null

  const code = takeCode(order, take.number)
  const provider = providerOf(take)
  const canStar = done || take.starred
  const hidden = data?.hidden ?? 0
  const cls = [
    'cv-take',
    `st-${take.status}`,
    selected && 'is-selected',
    take.starred && 'is-starred',
    far && 'is-far',
    box && 'is-sized',
    videoUrl && 'is-playing',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <div
        className={cls}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onDoubleClick={(e) => {
          e.stopPropagation()
          openTake(id)
        }}
      >
        <div className="cv-take-media" style={media ? { width: media.w, height: media.h } : undefined}>
          {take.posterId ? <MediaImg id={take.posterId} className="cv-take-poster" /> : <div className="cv-take-poster empty" />}
          {videoUrl && <TakePlayer takeId={id} url={videoUrl} />}
          <TakeStatusOverlay status={take.status} progress={take.progress} error={take.error} />

          <span className="cv-take-code">{code}</span>
          {provider !== 'mock' && !far && (
            <span className="cv-take-provider" title={`Video tạo trên ${PROVIDER_LABEL[provider] ?? provider}`}>
              <Cloud size={10} strokeWidth={2.2} aria-hidden />
              {PROVIDER_LABEL[provider] ?? provider}
            </span>
          )}
          {!far && (
            <button
              className={`cv-take-star nodrag nopan ${take.starred ? 'on' : ''}`}
              disabled={!canStar}
              title={canStar ? (take.starred ? 'Bỏ chọn take này' : 'Chọn take này cho cảnh (★)') : 'Chỉ chọn được take đã tạo xong'}
              aria-label={take.starred ? 'Bỏ chọn take' : 'Chọn take'}
              aria-pressed={take.starred}
              onPointerDown={stop}
              onDoubleClick={stop}
              onClick={(e) => {
                e.stopPropagation()
                useRuns.getState().toggleStar(id)
              }}
            >
              <Star size={13} fill={take.starred ? 'currentColor' : 'none'} />
            </button>
          )}
          {hidden > 0 && (
            <button
              className="cv-take-more nodrag nopan"
              title={`${hidden} take khác của cảnh này đang ẩn — bấm để xem tất cả`}
              onPointerDown={stop}
              onDoubleClick={stop}
              onClick={(e) => {
                e.stopPropagation()
                openTake(id)
              }}
            >
              +{hidden}
            </button>
          )}
          {(take.status === 'processing' || take.status === 'queued') && (
            <div className="cv-take-bar">
              <i style={{ width: `${take.status === 'processing' ? Math.max(3, take.progress) : 0}%` }} />
            </div>
          )}
        </div>

        {box && <div className="cv-take-fill" />}
        {!far && (
          <div className="cv-take-foot">
            <span className="cv-take-settings" title={settingsLabel(take.settings)}>
              {settingsLabel(take.settings)}
            </span>
            {order === undefined && (
              <span className="cv-take-orphan" title="Cảnh gốc của video này đã bị xoá. Video vẫn ở đây vì còn cảnh dùng nó làm @video.">
                cảnh đã xoá
              </span>
            )}
            {usage > 0 && (
              <span className="cv-take-used" title={`Đang dùng làm @video ở ${usage} cảnh`}>
                @v·{usage}
              </span>
            )}
            <span className="cv-spacer" />
            <span className="cv-take-actions nodrag nopan" onPointerDown={stop} onDoubleClick={stop}>
              <button className="cv-take-btn" title="Xem" aria-label="Xem take" onClick={(e) => (e.stopPropagation(), openTake(id))}>
                <Eye size={14} strokeWidth={1.75} />
              </button>
              <button
                className="cv-take-btn"
                title={`Chạy lại ${order ? sceneCode(order) : 'cảnh'} (tạo take mới)`}
                aria-label="Chạy lại"
                disabled={order === undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  rerunTake(take.id)
                }}
              >
                <RotateCcw size={14} strokeWidth={1.75} />
              </button>
              <TakeDeleteButton takeId={id} used={usage > 0} />
            </span>
          </div>
        )}
        {!far && <TakeMainButton take={take} code={code} order={order} />}

        <Handle type="target" position={Position.Left} id="in" className="cv-h cv-h-take-in" style={handleStyle} isConnectable={false} />
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          className={`cv-h cv-h-video ${done ? '' : 'is-off'}`}
          style={handleStyle}
          isConnectableStart={done}
          isConnectableEnd={false}
          title={done ? 'Kéo vào cảnh để dùng làm @video · thả ra nền để tạo cảnh tiếp nối' : 'Video chưa tạo xong'}
        />
      </div>
      <NodeSizer id={id} kind="take" selected={!!selected} sized={!!box} />
    </>
  )
}

export const TakeNode = memo(TakeNodeView)

/**
 * The node's main action, full width at the bottom (like canvasapp's "Tải MP4"): download the finished video
 * (+ prompt .txt), show the progress while it is generated, or run the scene again after a failure / cancel.
 * Wrapped so presses (even on the disabled button) never select, drag or pan the node.
 */
function TakeMainButton({ take, code, order }: { take: Take; code: string; order: number | undefined }) {
  const [saving, setSaving] = useState(false)
  const folder = useDownloadPrefs((s) => s.folderName)
  const withPrompt = useDownloadPrefs((s) => s.withPrompt)
  let button
  if (take.status === 'completed') {
    const what = withPrompt ? 'video + prompt (.txt)' : 'video'
    button = (
      <button
        className="cv-take-main"
        disabled={saving}
        title={folder ? `Lưu ${what} của ${code} vào thư mục “${folder}”` : `Tải ${what} của ${code} về máy`}
        aria-label={`Tải video ${code}`}
        onClick={(e) => {
          e.stopPropagation()
          if (saving) return
          setSaving(true)
          void downloadTake(take.id).finally(() => setSaving(false))
        }}
      >
        {saving ? <LoaderCircle size={15} className="cv-spin" /> : <Download size={15} strokeWidth={2.4} />}
        <span>{saving ? 'Đang lưu…' : 'Tải video'}</span>
      </button>
    )
  } else if (take.status === 'processing' || take.status === 'queued') {
    const processing = take.status === 'processing'
    button = (
      <button className="cv-take-main is-busy" disabled aria-label={processing ? `Đang tạo ${take.progress}%` : 'Đang chờ'}>
        {processing && <i className="cv-take-main-fill" style={{ width: `${Math.max(3, take.progress)}%` }} />}
        {processing ? <LoaderCircle size={14} className="cv-spin" /> : <Clock size={14} />}
        <span>{processing ? `Đang tạo ${take.progress}%` : 'Đang chờ'}</span>
      </button>
    )
  } else {
    button = (
      <button
        className="cv-take-main is-retry"
        disabled={order === undefined}
        title={order === undefined ? 'Cảnh của take này đã bị xoá' : `Chạy lại ${sceneCode(order)} (tạo take mới)`}
        aria-label="Chạy lại"
        onClick={(e) => {
          e.stopPropagation()
          rerunTake(take.id)
        }}
      >
        <RotateCcw size={14} strokeWidth={2.4} />
        <span>Chạy lại</span>
      </button>
    )
  }
  return (
    <div className="cv-take-main-wrap nodrag nopan" onPointerDown={stop} onDoubleClick={stop} onClick={stop}>
      {button}
    </div>
  )
}

function TakeStatusOverlay({ status, progress, error }: { status: string; progress: number; error: string | null }) {
  if (status === 'completed') return null
  if (status === 'queued')
    return (
      <div className="cv-take-state">
        <Clock size={16} />
        <span>{STATUS_LABEL.queued}</span>
      </div>
    )
  if (status === 'processing')
    return (
      <div className="cv-take-state">
        <LoaderCircle size={16} className="cv-spin" />
        <span>{progress}%</span>
      </div>
    )
  if (status === 'failed')
    return (
      <div className="cv-take-state failed" title={error ?? undefined}>
        <CircleAlert size={16} />
        <span className="cv-take-err">{error || STATUS_LABEL.failed}</span>
      </div>
    )
  return (
    <div className="cv-take-state cancelled">
      <Ban size={16} />
      <span>{STATUS_LABEL.cancelled}</span>
    </div>
  )
}
