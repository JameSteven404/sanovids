import { Ban, CircleAlert, Clock, LoaderCircle, Star } from 'lucide-react'
import { memo, useMemo, type SyntheticEvent } from 'react'
import type { Take } from '../../core/types'
import { TAKES_MIME } from '../../lib/dnd'
import { useSceneTakes } from '../../store/runs'
import { useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { takeCostLabel } from './creditText'
import { takeSettingsText } from './importedTake'
import { STATUS_LABEL, toggleChosenTake } from './shared'
import './runs.css'

const SM_MAX = 5

const stop = (e: SyntheticEvent) => e.stopPropagation()

function openTake(takeId: string) {
  useUI.getState().openDialog({ kind: 'take', takeId })
}

interface TakeStripProps {
  sceneId: string
  size?: 'sm' | 'md'
  /** `sm` only: thumbs shown before older takes collapse into "+N" (default 5; narrow table cells pass less). */
  max?: number
  /** Highlights one take (used by the take viewer filmstrip). */
  activeTakeId?: string
}

/**
 * Horizontal list of a scene's takes (oldest → newest).
 * `sm` lives inside canvas scene cards / table rows: tiny, cheap, never starts a node drag.
 */
export const TakeStrip = memo(function TakeStrip({ sceneId, size = 'sm', max = SM_MAX, activeTakeId }: TakeStripProps) {
  const takes = useSceneTakes(sceneId)
  const { visible, hidden } = useMemo(() => {
    const sorted = [...takes].sort((a, b) => a.number - b.number)
    const limit = Math.max(1, max)
    if (size === 'md' || sorted.length <= limit) return { visible: sorted, hidden: [] as Take[] }
    // Newest takes, but keep the latest starred one visible even if it is older.
    let shown = sorted.slice(-limit)
    const older = sorted.slice(0, -limit)
    const starred = [...older].reverse().find((t) => t.starred)
    if (starred) shown = limit > 1 ? [starred, ...sorted.slice(-(limit - 1))] : [starred]
    const shownIds = new Set(shown.map((t) => t.id))
    return { visible: shown, hidden: sorted.filter((t) => !shownIds.has(t.id)) }
  }, [takes, size, max])

  if (!takes.length) {
    if (size === 'sm') return null
    return <div className="rq-strip-empty">Chưa có take nào — bấm Chạy để tạo T1.</div>
  }

  return (
    <div
      className={`rq-strip ${size} nodrag nopan`}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      {hidden.length > 0 && (
        <button
          type="button"
          className="rq-more nodrag nopan"
          title={`${hidden.length} take cũ hơn — bấm để xem`}
          onClick={() => openTake(hidden[hidden.length - 1].id)}
        >
          +{hidden.length}
        </button>
      )}
      {visible.map((t) => (
        <TakeThumb key={t.id} take={t} size={size} active={t.id === activeTakeId} />
      ))}
    </div>
  )
})

const TakeThumb = memo(function TakeThumb({ take, size, active }: { take: Take; size: 'sm' | 'md'; active: boolean }) {
  const icon = size === 'sm' ? 10 : 16
  const canStar = take.status === 'completed' || take.starred
  const title =
    `T${take.number} · ${STATUS_LABEL[take.status]}${take.status === 'processing' ? ` ${take.progress}%` : ''}` +
    ` · ${takeSettingsText(take)} · ${takeCostLabel(take)}${take.imported ? ' · nhập từ canvasapp' : ''}${take.starred ? ' · ★ đã chọn' : ''}` +
    (take.error && take.status === 'failed' ? `\n${take.error}` : '')

  // Finished takes can be dragged onto a scene (canvas card / table row) to become its @video reference.
  const draggable = take.status === 'completed'
  return (
    <div
      className={`rq-thumb ${size} ${take.status}${take.starred ? ' starred' : ''}${active ? ' active' : ''}`}
      title={draggable ? `${title}\nKéo thả vào cảnh khác để dùng làm @video` : title}
      draggable={draggable}
      onDragStart={
        draggable
          ? (e) => {
              e.stopPropagation()
              e.dataTransfer.setData(TAKES_MIME, JSON.stringify([take.id]))
              e.dataTransfer.effectAllowed = 'copy'
              // Lets drop targets (table rows, scene cards) light up while the take is in the air.
              useUI.getState().setDraggingTakes([take.id])
            }
          : undefined
      }
      onDragEnd={draggable ? () => useUI.getState().setDraggingTakes(null) : undefined}
    >
      <button type="button" className="rq-thumb-open nodrag nopan" onClick={() => openTake(take.id)} aria-label={`Xem take T${take.number}`}>
        {take.posterId ? <MediaImg id={take.posterId} className="rq-thumb-img" /> : <span className="rq-thumb-ph" />}
        {take.status === 'processing' && (
          <span className="rq-thumb-ov">
            <LoaderCircle size={icon} className="rq-spin" />
            <span className="rq-thumb-pct">{take.progress}</span>
          </span>
        )}
        {take.status === 'queued' && (
          <span className="rq-thumb-ov">
            <Clock size={icon} />
          </span>
        )}
        {take.status === 'failed' && (
          <span className="rq-thumb-ov danger">
            <CircleAlert size={icon} />
          </span>
        )}
        {take.status === 'cancelled' && (
          <span className="rq-thumb-ov muted">
            <Ban size={icon} />
          </span>
        )}
        <span className="rq-thumb-n">T{take.number}</span>
        {take.status === 'processing' && (
          <span className="rq-thumb-bar">
            <i style={{ width: `${take.progress}%` }} />
          </span>
        )}
      </button>
      {canStar && (
        <button
          type="button"
          className="rq-thumb-star nodrag nopan"
          onClick={(e) => {
            e.stopPropagation()
            toggleChosenTake(take.id)
          }}
          title={take.starred ? 'Bỏ chọn take này' : 'Chọn take này (★)'}
          aria-label={take.starred ? `Bỏ sao T${take.number}` : `Gắn sao T${take.number}`}
          aria-pressed={take.starred}
        >
          <Star size={size === 'sm' ? 9 : 13} fill={take.starred ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  )
})
