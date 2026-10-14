// Take (video) node on the canvas: one generation attempt of a scene. Memoized; reads its take from the runs store.
// Wired from its scene ('out' edge); once completed its right dot drags into a Thư mục (save) or onto empty canvas
// (the next scene from this video). Videos are never references of a scene any more (retired in 0.6.0).
//
// Layout (near): a title line ABOVE the card's top-left (code, "+N", custom file name, DEV, ★, and the rename input),
// then the card: the clean picture (nothing drawn over a finished take; the whole frame, letterboxed), the 30px player
// bar under it (TakePlayer / TakeBarRest), the footer (settings, always shown) and the big button. Nothing sits inside
// the card above the picture: that would move DOT_TOP for the take AND scene dots. Far (zoomed out): the poster with
// a big code chip and "+N", as before. The <video> lives in the picture box and the controls in the bar: one shared
// ref, mounted in the same commit, never re-parented (the video would restart). Styles: takeNode.css.
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react'
import { Ban, Bug, CircleAlert, Clock, Cloud, Download, Eye, LoaderCircle, PencilLine, RotateCcw, Star, Trash2 } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { canvasEvents, defaultTakeFileBase, deleteTakes, downloadTake, renameTake, rerunTake, takeFileBase } from '../../actions'
import { sceneCode, takeCode } from '../../core/compile'
import type { JobStatus, Take, TakeProvider } from '../../core/types'
import { useDownloadPrefs } from '../../lib/downloads'
import { useMediaUrl } from '../../lib/imageStore'
import { isTypingChord } from '../../lib/keymapPrefs'
import { usePlayback } from '../../lib/playback'
import { PROVIDER_LABEL, providerOf } from '../../providers'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { transferLabel, transferPercent, useTakeTransfers } from '../../store/takeTransfers'
import { useUI } from '../../store/ui'
import { perfCount } from '../../perf/probe'
import { MediaImg } from '../common/Media'
import { importedChipTitle, takeSettingsText } from '../runs/importedTake'
import {
  fitMedia,
  inlineKeyBubbles,
  LOD_ZOOM,
  PREVIEW_DELAY_MS,
  sceneMapOf,
  STATUS_LABEL,
  TAKE_BAR_H,
  TAKE_CHROME,
  TAKE_POSTER_H,
  takeDotTop,
  takeIndexOf,
} from './canvasModel'
import { NodeSizer, useNodeBox, useRemeasureOn } from './NodeSizer'
import { RENAME_TAKE_EVENT, takePendingRename, type RenameTakeDetail } from './takeEvents'
import { footerTitle, starTitle, titleLine, TITLE_LINE_SELECTOR } from './takeNodeModel'
import { TakeBarRest, TakePlayer } from './TakePlayer'
import './canvas.css'
import './takeNode.css'
import './saving.css'

/** `status` is only carried so the node object changes with it (minimap color); the node reads its take itself. */
export type TakeNodeData = { hidden: number; status: JobStatus }
export type TakeFlowNode = Node<TakeNodeData, 'take'>

const stop = (e: SyntheticEvent) => e.stopPropagation()

function openTake(takeId: string) {
  useUI.getState().openDialog({ kind: 'take', takeId })
}

/**
 * Delete one take (not undoable) through actions.deleteTakes: the node's trash button already needed a second click
 * (TakeDeleteButton), like the viewer's, so it asks only about credit ('usedOnly': a paid video still downloading, a
 * "maybe billed" take, a job still running there).
 * deleteTakes also removes its media blobs, drops it from the selection and says so in a toast.
 */
export function deleteTake(takeId: string) {
  deleteTakes([takeId], { confirm: 'usedOnly' })
}

/** How long the trash button stays armed after the first click. */
const ARM_MS = 3500

/**
 * Trash button of a take node. Deleting a video cannot be undone and the button sits next to "Chạy lại", so the
 * first click only arms it ("Xoá?", red) and the second one deletes; it disarms after a few seconds or when the
 * pointer leaves.
 */
function TakeDeleteButton({ takeId }: { takeId: string }) {
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
        if (!armed) {
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
 * "Tên file" editor in the take's title line, above the card (pencil in the footer, double-click on the code / name /
 * settings, or RENAME_TAKE_EVENT): Enter or a click elsewhere saves, Escape cancels, an empty field goes back to the
 * default name. Saved too when the node unmounts mid-edit (zoomed out to the small card, scrolled off-screen).
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
      className="cv-take-name-input nodrag nopan nokey"
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
        // Only the chords of commands that run while typing (keymap: Ctrl+S, Ctrl+Enter…) reach the global shortcuts;
        // typing keys (Delete, Backspace, Enter, Escape…) never reach the canvas.
        if (!inlineKeyBubbles(e, (ev) => isTypingChord(ev.nativeEvent))) e.stopPropagation()
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

/**
 * The title line above the card's top-left: code chip, "+N", the custom file name, DEV / canvasapp, ★ — or the rename
 * input. Primitive props only (memo). Dragging the line drags the node; its buttons do not. The pointer over it never
 * starts the hover preview (TakeNode's onMouseOver ignores it).
 */
const TakeTitle = memo(function TakeTitle({
  takeId,
  code,
  hidden,
  fileName,
  provider,
  starred,
  canStar,
  renaming,
  onRename,
  onRenameDone,
}: {
  takeId: string
  code: string
  hidden: number
  fileName: string | null
  provider: TakeProvider
  starred: boolean
  canStar: boolean
  renaming: boolean
  onRename: () => void
  onRenameDone: () => void
}) {
  const line = titleLine({ code, fileName, hidden, provider, renaming })
  const rename = (e: SyntheticEvent) => {
    e.stopPropagation()
    onRename()
  }
  return (
    <div className={`cv-take-label${renaming ? ' is-renaming' : ''}`}>
      <span className="cv-take-chip" title={line.chipTitle} onDoubleClick={rename}>
        {code}
      </span>
      {line.moreTitle && (
        <button
          className="cv-take-more nodrag nopan"
          title={line.moreTitle}
          aria-label={line.moreTitle}
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={(e) => {
            e.stopPropagation()
            openTake(takeId)
          }}
        >
          +{hidden}
        </button>
      )}
      {renaming ? (
        <TakeNameInput takeId={takeId} onDone={onRenameDone} />
      ) : (
        line.name && (
          <span className="cv-take-name" title={line.nameTitle ?? undefined} onDoubleClick={rename}>
            {line.name}
          </span>
        )
      )}
      <span className="cv-take-label-sp" />
      {line.showProvider && (
        <span
          className={`cv-take-provider${provider === 'dev' ? ' dev' : ''}`}
          title={provider === 'dev' ? 'Video giả của chế độ Phát triển (canvasapp giả lập, credit dev)' : `Video tạo trên ${PROVIDER_LABEL[provider] ?? provider}`}
        >
          {provider === 'dev' ? <Bug size={9} strokeWidth={2.2} aria-hidden /> : <Cloud size={11} strokeWidth={2.2} aria-hidden />}
          {provider === 'dev' ? 'DEV' : null}
        </span>
      )}
      {line.showStar && (
        <button
          className={`cv-take-star nodrag nopan ${starred ? 'on' : ''}`}
          disabled={!canStar}
          title={starTitle(canStar, starred)}
          aria-label={starred ? 'Bỏ chọn take' : 'Chọn take'}
          aria-pressed={starred}
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={(e) => {
            e.stopPropagation()
            useRuns.getState().toggleStar(takeId)
          }}
        >
          <Star size={12} fill={starred ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  )
})

function TakeNodeView({ id, selected, data }: NodeProps<TakeFlowNode>) {
  perfCount('TakeNodeView')
  const take = useRuns((s) => takeIndexOf(s.takes).byId.get(id))
  const order = useProject((s) => (take ? sceneMapOf(s.project.scenes).get(take.sceneId)?.order : undefined))
  const far = useStore((s) => s.transform[2] < LOD_ZOOM)
  const [hover, setHover] = useState(false)
  const [previewReady, setPreviewReady] = useState(false)
  const [renaming, setRenaming] = useState(false)
  /** The stage (picture + bar) is fullscreen ("Phóng to", TakePlayer). */
  const [full, setFull] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const done = take?.status === 'completed'
  // The player stays open after the mouse leaves once one of its controls was used (pinned, see TakePlayer).
  const pinned = usePlayback((s) => s.pinned === id)
  useEffect(() => {
    if (!hover || !done || far) { setPreviewReady(false); return }
    const timer = setTimeout(() => setPreviewReady(true), PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [hover, done, far])
  const previewing = hover && previewReady && done && !far
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

  // "Đổi tên file" from elsewhere (takeEvents.requestTakeRename): only a near node has the title line to edit in.
  const farRef = useRef(far)
  farRef.current = far
  useEffect(() => {
    const onRename = (ev: Event) => {
      const d = (ev as CustomEvent<RenameTakeDetail>).detail
      if (!d || d.takeId !== id || d.handled || farRef.current) return
      d.handled = true
      setRenaming(true)
    }
    canvasEvents.addEventListener(RENAME_TAKE_EVENT, onRename)
    return () => canvasEvents.removeEventListener(RENAME_TAKE_EVENT, onRename)
  }, [id])
  // A rename that waited for this node (it was off-screen): it mounted, or came near.
  useEffect(() => {
    if (!far && takePendingRename(id)) setRenaming(true)
  }, [far, id])
  const startRename = useCallback(() => setRenaming(true), [])
  const endRename = useCallback(() => setRenaming(false), [])

  const box = useNodeBox(id, take?.size)
  // Resized node: the poster keeps 16:9 and grows with the node; bar + footer + big button stay pinned at the bottom.
  const media = box ? fitMedia(box.w, box.h, far ? 0 : TAKE_CHROME) : null
  // Both dots sit at the middle of the poster, default or resized (`top` counts from inside the card's border, like the
  // poster), so a resize never makes them jump.
  const dotTop = takeDotTop(box, far)
  const handleStyle = useMemo(() => ({ top: dotTop }), [dotTop])
  // The dots can move while the node box stays the same (zooming across the LOD level changes a resized poster's height).
  useRemeasureOn(id, dotTop)
  // While the stage is fullscreen it leaves the card: this keeps its place (picture + bar) so nothing below moves.
  const fullStyle = useMemo(() => (full ? ({ ['--stage-h' as string]: `${(media ? media.h : TAKE_POSTER_H) + TAKE_BAR_H}px` } as CSSProperties) : undefined), [full, media])
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
    renaming && 'is-renaming',
    full && 'is-full',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <div
        className={cls}
        style={fullStyle}
        // The title line (★, "+N", the rename input) never starts the hover preview.
        onMouseOver={(e) => setHover(!(e.target as Element).closest?.(TITLE_LINE_SELECTOR))}
        onMouseLeave={() => setHover(false)}
        onDoubleClick={(e) => {
          e.stopPropagation()
          // fullscreen: a double-click on the bar must not open the viewer behind it (the picture's leaves fullscreen)
          if (!full) openTake(id)
        }}
      >
        {!far && (
          <TakeTitle
            takeId={id}
            code={code}
            hidden={hidden}
            fileName={take.fileName ?? null}
            provider={provider}
            starred={!!take.starred}
            canStar={canStar}
            renaming={renaming}
            onRename={startRename}
            onRenameDone={endRename}
          />
        )}
        <div ref={stageRef} className={`cv-take-stage${full ? ' is-full nowheel nodrag nopan nokey' : ''}`}>
          <div className="cv-take-media" style={media && !full ? { width: media.w, height: media.h } : undefined}>
            {take.posterId ? <MediaImg id={take.posterId} className="cv-take-poster" /> : <div className="cv-take-poster is-empty" />}
            {videoUrl && <video ref={videoRef} className="cv-take-video" src={videoUrl} loop playsInline muted preload="auto" />}
            <TakeStatusOverlay takeId={id} status={take.status} progress={take.progress} error={take.error} />
            {far && <span className="cv-take-code">{code}</span>}
            {far && hidden > 0 && (
              <button
                className="cv-take-more nodrag nopan"
                title={`${hidden} take khác của cảnh này đang ẩn — bấm để xem tất cả`}
                aria-label={`Xem ${hidden} take khác của cảnh này`}
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
          </div>
          {!far && (
            <div className="cv-take-pbar">
              {videoUrl ? (
                <TakePlayer takeId={id} url={videoUrl} videoRef={videoRef} stageRef={stageRef} code={code} onFullChange={setFull} />
              ) : (
                <TakeBarRest takeId={id} code={code} status={take.status} progress={take.progress} videoId={take.videoId} />
              )}
            </div>
          )}
        </div>

        {box && <div className="cv-take-fill" />}
        {!far && (
          <div className="cv-take-foot">
            <span
              className="cv-take-settings"
              title={footerTitle(takeSettingsText(take), take.fileName)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                setRenaming(true)
              }}
            >
              {takeSettingsText(take)}
            </span>
            {take.imported && (
              <span className="cv-take-imported" title={importedChipTitle(take)}>
                nhập
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
              <TakeDeleteButton takeId={id} />
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
          title={done ? 'Kéo vào Thư mục để lưu · thả ra nền để tạo cảnh tiếp theo' : 'Video chưa tạo xong'}
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
