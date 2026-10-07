// Take (video) node on the canvas: one generation attempt of a scene. Memoized; reads its take from the runs store.
// Wired from its scene ('out' edge) and, once completed, usable as @video_N by other scenes (drag its right handle).
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react'
import { Ban, Bug, CircleAlert, Clock, Cloud, Download, Eye, LoaderCircle, PencilLine, RotateCcw, Star, Trash2 } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react'
import { defaultTakeFileBase, deleteTakes, downloadTake, renameTake, rerunTake, takeFileBase } from '../../actions'
import { sceneCode, takeCode } from '../../core/compile'
import type { JobStatus, Take } from '../../core/types'
import { useDownloadPrefs } from '../../lib/downloads'
import { useMediaUrl } from '../../lib/imageStore'
import { usePlayback } from '../../lib/playback'
import { PROVIDER_LABEL, providerOf } from '../../providers'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { transferLabel, transferPercent, useTakeTransfers } from '../../store/takeTransfers'
import { useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { importedChipTitle, takeSettingsText } from '../runs/importedTake'
import { fitMedia, inlineEditKeyBubbles, LOD_ZOOM, sceneMapOf, STATUS_LABEL, TAKE_CHROME, takeDotTop, takeIndexOf, videoUsageOf } from './canvasModel'
import { NodeSizer, useNodeBox, useRemeasureOn } from './NodeSizer'
import { TakePlayer } from './TakePlayer'
import './canvas.css'
import './saving.css'

/** `status` is only carried so the node object changes with it (minimap color); the node reads its take itself. */
export type TakeNodeData = { hidden: number; status: JobStatus }
export type TakeFlowNode = Node<TakeNodeData, 'take'>

const stop = (e: SyntheticEvent) => e.stopPropagation()

function openTake(takeId: string) {
  useUI.getState().openDialog({ kind: 'take', takeId })
}

/**
 * Delete one take (not undoable) through actions.deleteTakes: asks first only when scenes use it as @video, or when its
 * paid video is still downloading (like "Huỷ") — the node's trash button already needed a second click
 * (TakeDeleteButton), like the viewer's. deleteTakes also removes its media blobs, drops it from the selection and says
 * so in a toast.
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

/**
 * "Tên file" editor in the take node's footer (double-click the label, or the pencil): Enter or a click elsewhere
 * saves, Escape cancels, an empty field goes back to the default name. Saved too when the node unmounts mid-edit
 * (zoomed out to the small card, scrolled off-screen).
 */
function TakeNameInput({ takeId, onDone }: { takeId: string; onDone: () => void }) {
  const [draft, setDraft] = useState(() => takeFileBase(takeId))
  const latest = useRef(draft)
  latest.current = draft
  const done = useRef(false)
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    if (save) renameTake(takeId, latest.current)
    onDone()
  }
  useEffect(() => {
    done.current = false
    return () => {
      if (done.current) return
      done.current = true
      renameTake(takeId, latest.current)
    }
  }, [takeId])
  return (
    <input
      className="cv-take-name-input nodrag nopan"
      autoFocus
      value={draft}
      maxLength={140}
      spellCheck={false}
      placeholder={defaultTakeFileBase(takeId)}
      aria-label="Tên file video"
      title="Tên file khi tải hoặc lưu video (không cần đuôi .mp4). Để trống = tên mặc định. Enter để lưu, Esc để huỷ."
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(true)}
      onPointerDown={stop}
      onDoubleClick={stop}
      onKeyDown={(e) => {
        // Typing keys (Delete, Backspace, Enter, Escape…) never reach the canvas / global shortcuts.
        if (!inlineEditKeyBubbles(e)) e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
    />
  )
}

function TakeNodeView({ id, selected, data }: NodeProps<TakeFlowNode>) {
  const take = useRuns((s) => takeIndexOf(s.takes).byId.get(id))
  const order = useProject((s) => (take ? sceneMapOf(s.project.scenes).get(take.sceneId)?.order : undefined))
  const usage = useProject((s) => videoUsageOf(s.project.scenes).get(id) ?? 0)
  const far = useStore((s) => s.transform[2] < LOD_ZOOM)
  const [hover, setHover] = useState(false)
  const [renaming, setRenaming] = useState(false)
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
  // Both dots sit at the middle of the poster, default or resized (`top` counts from inside the card's border, like the
  // poster), so a resize never makes them jump.
  const dotTop = takeDotTop(box, far)
  const handleStyle = useMemo(() => ({ top: dotTop }), [dotTop])
  // The dots can move while the node box stays the same (zooming across the LOD level changes a resized poster's height).
  useRemeasureOn(id, dotTop)
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
          {take.posterId ? <MediaImg id={take.posterId} className="cv-take-poster" /> : <div className="cv-take-poster is-empty" />}
          {videoUrl && <TakePlayer takeId={id} url={videoUrl} />}
          <TakeStatusOverlay takeId={id} status={take.status} progress={take.progress} error={take.error} />

          <span className="cv-take-code">{code}</span>
          {provider !== 'mock' && !far && (
            <span
              className={`cv-take-provider${provider === 'dev' ? ' dev' : ''}`}
              title={provider === 'dev' ? 'Video giả của chế độ Phát triển (canvasapp giả lập, credit dev)' : `Video tạo trên ${PROVIDER_LABEL[provider] ?? provider}`}
            >
              {provider === 'dev' ? <Bug size={10} strokeWidth={2.2} aria-hidden /> : <Cloud size={10} strokeWidth={2.2} aria-hidden />}
              {provider === 'dev' ? 'DEV' : (PROVIDER_LABEL[provider] ?? provider)}
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
        {!far && renaming && (
          <div className="cv-take-foot is-renaming">
            <TakeNameInput takeId={id} onDone={() => setRenaming(false)} />
          </div>
        )}
        {!far && !renaming && (
          <div className="cv-take-foot">
            <span
              className={`cv-take-settings${take.fileName ? ' is-name' : ''}`}
              title={`${take.fileName ? `Tên file: ${take.fileName}.\n${takeSettingsText(take)}` : takeSettingsText(take)}\nBấm đúp để đổi tên file video`}
              onDoubleClick={(e) => {
                e.stopPropagation()
                setRenaming(true)
              }}
            >
              {take.fileName ?? takeSettingsText(take)}
            </span>
            {take.imported && (
              <span className="cv-take-imported" title={importedChipTitle(take)}>
                nhập
              </span>
            )}
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
                title={`Đổi tên file video (hiện là “${takeFileBase(id)}”)`}
                aria-label="Đổi tên file video"
                onClick={(e) => {
                  e.stopPropagation()
                  setRenaming(true)
                }}
              >
                <PencilLine size={14} strokeWidth={1.75} />
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
          title={done ? 'Kéo vào cảnh để dùng làm @video · vào Thư mục để lưu · thả ra nền để tạo cảnh tiếp nối' : 'Video chưa tạo xong'}
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
  const askWhere = useDownloadPrefs((s) => s.askWhere)
  let button
  if (take.status === 'completed') {
    const what = withPrompt ? 'video + prompt (.txt)' : 'video'
    button = (
      <button
        className="cv-take-main"
        disabled={saving}
        title={
          askWhere
            ? `Tải ${what} của ${code} — chọn nơi lưu và tên file`
            : folder
              ? `Lưu ${what} của ${code} vào thư mục “${folder}”`
              : `Tải ${what} của ${code} về máy`
        }
        aria-label={`Tải video ${code}`}
        onClick={(e) => {
          e.stopPropagation()
          if (saving) return
          setSaving(true)
          void downloadTake(take.id).finally(() => setSaving(false))
        }}
      >
        {saving ? <LoaderCircle size={15} className="cv-spin" /> : <Download size={15} strokeWidth={2.4} />}
        <span>{saving ? 'Đang lưu…' : askWhere ? 'Tải video…' : 'Tải video'}</span>
      </button>
    )
  } else if (take.status === 'processing') {
    button = <TakeBusyButton takeId={take.id} progress={take.progress} />
  } else if (take.status === 'queued') {
    button = (
      <button className="cv-take-main is-busy" disabled aria-label="Đang chờ">
        <Clock size={14} />
        <span>Đang chờ</span>
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

/** "Đang tạo 40%", then "Đang tải về 45%" (or "… 12,3 MB") while the finished video downloads. */
function TakeBusyButton({ takeId, progress }: { takeId: string; progress: number }) {
  const transfer = useTakeTransfers((s) => transferLabel(s.byTake[takeId]))
  const pct = useTakeTransfers((s) => transferPercent(s.byTake[takeId]))
  const label = transfer ?? `Đang tạo ${progress}%`
  return (
    <button className="cv-take-main is-busy" disabled aria-label={label}>
      <i className="cv-take-main-fill" style={{ width: `${Math.max(3, transfer ? (pct ?? progress) : progress)}%` }} />
      <LoaderCircle size={14} className="cv-spin" />
      <span>{label}</span>
    </button>
  )
}

function TakeTransferText({ takeId, progress }: { takeId: string; progress: number }) {
  const transfer = useTakeTransfers((s) => transferLabel(s.byTake[takeId]))
  return <span>{transfer ?? `${progress}%`}</span>
}

function TakeStatusOverlay({ takeId, status, progress, error }: { takeId: string; status: string; progress: number; error: string | null }) {
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
        <TakeTransferText takeId={takeId} progress={progress} />
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
