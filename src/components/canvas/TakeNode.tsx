// Take (video) node on the canvas: one generation attempt of a scene. Memoized; reads its take from the runs store.
// Wired from its scene ('out' edge) and, once completed, usable as @video_N by other scenes (drag its right handle).
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react'
import { Ban, CircleAlert, Clock, Eye, LoaderCircle, RotateCcw, Star, Trash2 } from 'lucide-react'
import { memo, useState, type SyntheticEvent } from 'react'
import { requestRun, takeLabel } from '../../actions'
import { sceneCode, takeCode } from '../../core/compile'
import { settingsLabel } from '../../core/models'
import type { JobStatus } from '../../core/types'
import { useMediaUrl } from '../../lib/imageStore'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { LOD_ZOOM, sceneMapOf, STATUS_LABEL, takeIndexOf, videoUsageOf } from './canvasModel'
import './canvas.css'

/** `status` is only carried so the node object changes with it (minimap color); the node reads its take itself. */
export type TakeNodeData = { hidden: number; status: JobStatus }
export type TakeFlowNode = Node<TakeNodeData, 'take'>

const stop = (e: SyntheticEvent) => e.stopPropagation()

function openTake(takeId: string) {
  useUI.getState().openDialog({ kind: 'take', takeId })
}

/** Delete one take (not undoable). Asks first when scenes use it as @video. */
export function deleteTake(takeId: string) {
  const project = useProject.getState().project
  const label = takeLabel(takeId)
  const usedBy = project.scenes.filter((s) => s.videoRefs.includes(takeId)).sort((a, b) => a.order - b.order)
  if (
    usedBy.length &&
    !window.confirm(`${label} đang được dùng làm @video ở ${usedBy.length} cảnh (${usedBy.map((s) => sceneCode(s.order)).join(', ')}).\nXoá video và bỏ các tham chiếu đó?`)
  ) {
    return
  }
  useRuns.getState().removeTakes([takeId])
  const ui = useUI.getState()
  if (ui.selectedIds.includes(takeId)) ui.select(ui.selectedIds.filter((id) => id !== takeId))
  toast(`Đã xoá ${label}. (Video đã xoá không hoàn tác được.)`)
}

function TakeNodeView({ id, selected, data }: NodeProps<TakeFlowNode>) {
  const take = useRuns((s) => takeIndexOf(s.takes).byId.get(id))
  const order = useProject((s) => (take ? sceneMapOf(s.project.scenes).get(take.sceneId)?.order : undefined))
  const usage = useProject((s) => videoUsageOf(s.project.scenes).get(id) ?? 0)
  const far = useStore((s) => s.transform[2] < LOD_ZOOM)
  const [hover, setHover] = useState(false)
  const done = take?.status === 'completed'
  const videoUrl = useMediaUrl(hover && done && !far ? take?.videoId : null)
  if (!take) return null

  const code = takeCode(order, take.number)
  const canStar = done || take.starred
  const hidden = data?.hidden ?? 0
  const cls = ['cv-take', `st-${take.status}`, selected && 'is-selected', take.starred && 'is-starred', far && 'is-far'].filter(Boolean).join(' ')

  return (
    <div
      className={cls}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        openTake(id)
      }}
    >
      <div className="cv-take-media">
        {take.posterId ? <MediaImg id={take.posterId} className="cv-take-poster" /> : <div className="cv-take-poster empty" />}
        {videoUrl && <video className="cv-take-video" src={videoUrl} muted loop autoPlay playsInline />}
        <TakeStatusOverlay status={take.status} progress={take.progress} error={take.error} />

        <span className="cv-take-code">{code}</span>
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

      {!far && (
        <div className="cv-take-foot">
          <span className="cv-take-settings" title={settingsLabel(take.settings)}>
            {settingsLabel(take.settings)}
          </span>
          {usage > 0 && (
            <span className="cv-take-used" title={`Đang dùng làm @video ở ${usage} cảnh`}>
              @v·{usage}
            </span>
          )}
          <span className="cv-spacer" />
          <span className="cv-take-actions nodrag nopan" onPointerDown={stop} onDoubleClick={stop}>
            <button className="cv-take-btn" title="Xem" aria-label="Xem take" onClick={(e) => (e.stopPropagation(), openTake(id))}>
              <Eye size={13} />
            </button>
            <button
              className="cv-take-btn"
              title={`Chạy lại ${order ? sceneCode(order) : 'cảnh'} (tạo take mới)`}
              aria-label="Chạy lại"
              disabled={order === undefined}
              onClick={(e) => {
                e.stopPropagation()
                requestRun([take.sceneId])
              }}
            >
              <RotateCcw size={13} />
            </button>
            <button className="cv-take-btn danger" title="Xoá take" aria-label="Xoá take" onClick={(e) => (e.stopPropagation(), deleteTake(id))}>
              <Trash2 size={13} />
            </button>
          </span>
        </div>
      )}

      <Handle type="target" position={Position.Left} id="in" className="cv-h cv-h-take-in" isConnectable={false} />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className={`cv-h cv-h-video ${done ? '' : 'is-off'}`}
        isConnectableStart={done}
        isConnectableEnd={false}
        title={done ? 'Kéo vào cảnh để dùng làm @video · thả ra nền để tạo cảnh tiếp nối' : 'Video chưa tạo xong'}
      />
    </div>
  )
}

export const TakeNode = memo(TakeNodeView)

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
