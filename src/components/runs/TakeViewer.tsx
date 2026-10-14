import {
  Ban,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Copy,
  Download,
  FileDiff,
  Film,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  LocateFixed,
  PencilLine,
  RotateCcw,
  Star,
  Trash,
  Undo2,
} from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  cancelTake,
  defaultTakeFileBase,
  deleteTakes,
  downloadTake,
  focusNodes,
  openDevPanel,
  renameTake,
  rerunTake,
  restoreFromTake,
  takeFileBase,
} from '../../actions'
import { compileScene, imageKey, imageSlotsFor, sceneCode } from '../../core/compile'
import { escapeDecision, frameDelta, playerKey, type TransportOp } from '../../core/transportKeys'
import { useKeymap } from '../../lib/keymapPrefs'
import { starSelection } from '../../keyCommands'
import { describeFocus, useTransport } from '../../hooks/useTransport'
import { eventLike, IS_MAC } from '../../lib/keyEvents'
import { MODELS, settingsLabel } from '../../core/models'
import type { Asset, ImportedField, Scene, Take } from '../../core/types'
import { chargedDemo, formatCredits } from '../../lib/credits'
import { useDownloadPrefs } from '../../lib/downloads'
import { transferLabel, transferPercent, useTakeTransfers } from '../../store/takeTransfers'
import { useMediaUrl } from '../../lib/imageStore'
import { playWithSound, snapRate, usePlayback } from '../../lib/playback'
import { PROVIDER_LABEL, providerOf } from '../../providers'
import { useDevAllowed } from '../../providers/devAccess'
import { decodeRemoteId } from '../../providers/canvasapp/mapping'
import { useProject } from '../../store/project'
import { hasUncertainSubmitText, isUncertainSubmit, isUnverifiableSubmit, useRuns, useSceneTakes } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { keyForTopOverlay } from '../common/focus'
import { AssetChip } from '../common/Media'
import { Modal } from '../common/Modal'
import { takeCostLine } from './creditText'
import { fieldState, importedFieldsNote, importedSourceText, importSite, INFERRED_FIELD_TITLE, restoreBlock, takeModeText, takeSettingsText, unknownFieldTitle } from './importedTake'
import { exactImageKeys, snapshotImageNumbers } from './restore'
import { TakeStrip } from './TakeStrip'
import {
  downloadMedia,
  formatClock,
  formatDuration,
  HighlightedPrompt,
  isActive,
  NEWER_BUILD_TITLE,
  paragraphDiff,
  ProviderBadge,
  sameSettings,
  StatusBadge,
  toggleChosenTake,
  useNow,
} from './shared'
import './runs.css'

/** Held keys repeat only for frame steps; the shuttle, toggles and switching takes act once per press. */
const VIEWER_REPEATS = new Set<TransportOp>(['frame-back', 'frame-fwd', 'frame-back5', 'frame-fwd5'])

/** Modal to watch a take and compare / restore the prompt it was generated with. */
export function TakeViewer({ takeId }: { takeId: string }) {
  const close = useUI((s) => s.closeDialog)
  const take = useRuns((s) => s.takes.find((t) => t.id === takeId))
  if (!take) {
    return (
      <Modal title="Take" onClose={close}>
        <div className="empty">Take này không còn tồn tại (có thể đã bị xoá).</div>
      </Modal>
    )
  }
  return <TakeViewerInner take={take} onClose={close} />
}

function openTake(id: string) {
  useUI.getState().openDialog({ kind: 'take', takeId: id })
}

/**
 * The viewer's player: starts with the shared sound, volume and speed (lib/playback.ts); what the user changes with
 * its own controls (mute, volume, speed menu) updates them for every player. The changes it makes itself while
 * starting (and the muted fallback when autoplay with sound is refused) are not the user's: ignored — and so are the
 * J / L shuttle speeds (`ownsRate`, hooks/useTransport): a 4× of L never becomes the stored speed.
 */
function ViewerVideo({ url, poster, videoRef: ref, ownsRate }: { url: string; poster: string | null; videoRef: RefObject<HTMLVideoElement | null>; ownsRate: (rate: number) => boolean }) {
  /** Until the start settles, volume / rate events come from the code above, not from the user. */
  const starting = useRef(true)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    let live = true
    starting.current = true
    const { sound, volume, rate } = usePlayback.getState()
    v.volume = volume
    // The media load resets playbackRate to defaultPlaybackRate: set both.
    v.defaultPlaybackRate = rate
    v.playbackRate = rate
    void playWithSound(v, sound).then(() => {
      // The volumechange / ratechange events queued by the start are dispatched before this timer.
      setTimeout(() => {
        if (live) starting.current = false
      }, 0)
    })
    return () => {
      live = false
    }
  }, [url, ref])
  return (
    <video
      ref={ref}
      className="rq-video"
      aria-label="Video của take"
      src={url}
      poster={poster ?? undefined}
      loop
      controls
      playsInline
      muted
      onVolumeChange={(e) => {
        if (starting.current) return
        const v = e.currentTarget
        const p = usePlayback.getState()
        if (p.sound !== !v.muted) p.setSound(!v.muted)
        if (p.volume !== v.volume) p.setVolume(v.volume)
      }}
      onRateChange={(e) => {
        if (starting.current || ownsRate(e.currentTarget.playbackRate)) return
        // The native menu also offers 0.25× / 1.75×: stored as the nearest speed of the canvas player.
        const p = usePlayback.getState()
        if (p.rate !== snapRate(e.currentTarget.playbackRate)) p.setRate(e.currentTarget.playbackRate)
      }}
    />
  )
}

/**
 * "Tên file" in the viewer's header: the name the video gets when it is downloaded or saved into a folder (custom, or
 * the default "S01_T1 - title"). A click edits it in place: Enter / click away saves, Escape cancels (the dialog stays
 * open), empty = default name.
 */
function TakeFileNameField({ take }: { take: Take }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const done = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  /** Enter / Escape: the keyboard focus goes back to the field's button (it stays inside the dialog). */
  const refocus = useRef(false)
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    button.current?.focus()
  }, [editing])
  // The default name follows the scene's code / title (subscribed by the viewer, which re-renders this field).
  const current = take.fileName ?? defaultTakeFileBase(take.id)
  const finish = (save: boolean, fromKey = false) => {
    if (done.current) return
    done.current = true
    refocus.current = fromKey
    if (save) renameTake(take.id, draft)
    setEditing(false)
  }
  if (editing) {
    return (
      <input
        className="input rq-fname-input"
        autoFocus
        value={draft}
        maxLength={140}
        spellCheck={false}
        placeholder={defaultTakeFileBase(take.id)}
        aria-label="Tên file video"
        title="Không cần đuôi .mp4. Để trống = tên mặc định. Enter để lưu, Esc để huỷ."
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(true, true)
          } else if (e.key === 'Escape') {
            // Used here: the dialog must not close (Modal skips keys a field already handled).
            e.preventDefault()
            finish(false, true)
          }
        }}
      />
    )
  }
  return (
    <button
      ref={button}
      type="button"
      className={`rq-fname${take.fileName ? ' is-custom' : ''}`}
      title={`Tên file khi tải hoặc lưu video: “${current}” — bấm để đổi`}
      onClick={() => {
        done.current = false
        setDraft(current)
        setEditing(true)
      }}
    >
      <span className="rq-fname-label">Tên file</span>
      <span className="rq-fname-value">{current}</span>
      <PencilLine size={13} aria-hidden />
    </button>
  )
}

function TakeViewerInner({ take, onClose }: { take: Take; onClose: () => void }) {
  const scene = useProject((s) => s.project.scenes.find((x) => x.id === take.sceneId))
  const siblings = useSceneTakes(take.sceneId)
  const sorted = useMemo(() => [...siblings].sort((a, b) => a.number - b.number), [siblings])
  const idx = sorted.findIndex((t) => t.id === take.id)
  const prev = idx > 0 ? sorted[idx - 1] : undefined
  const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : undefined
  const code = scene ? sceneCode(scene.order) : 'S??'
  const label = `${code} · T${take.number}`

  // ---- transport keys (core/transportKeys, player 'viewer'): Space / K play–pause, J / L shuttle, ← / → frames,
  // ↑ / ↓ previous / next take of the scene, Home / End, Ctrl+` / ` fullscreen, M ★, Ctrl+M download. Esc while
  // fullscreen only leaves fullscreen (the dialog stays open).
  const videoRef = useRef<HTMLVideoElement>(null)
  const transport = useTransport(videoRef, { userRate: () => usePlayback.getState().rate })
  // Another take shown (a new <video>): no shuttle carries over.
  const { release } = transport
  useEffect(() => {
    release()
  }, [take.id, release])
  /** When fullscreen last ended (performance.now()): the Escape that ended it must not close the dialog too. */
  const exitedAt = useRef(-Infinity)
  /** Space was a transport key: its keyup must not press the (mouse-focused) button either. */
  const spaceTaken = useRef(false)
  /**
   * Tab was pressed since the last pointer press: a key aimed at the <video controls> then comes from its own controls
   * (their sliders keep the arrows, Home and End — focusKind 'slider'); after a click on the picture they stay ours.
   */
  const tabbed = useRef(false)
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e) => {
    // A sheet above every dialog (development mode's login / SePay) gets its own keys.
    if (keyForTopOverlay(e)) return
    if (e.type === 'keyup') {
      if (spaceTaken.current && (e.key === ' ' || e.code === 'Space')) {
        spaceTaken.current = false
        e.preventDefault()
      }
      return
    }
    if (e.key === 'Tab') tabbed.current = true
    if (e.key === 'Escape') {
      const d = escapeDecision({ fullscreen: !!document.fullscreenElement, exitedAt: exitedAt.current, now: performance.now() })
      if (d === 'normal') return
      // Before Modal's own Escape listener (added after this one): the dialog stays open.
      e.preventDefault()
      e.stopImmediatePropagation()
      if (d === 'exit-fullscreen') void document.exitFullscreen().catch(() => undefined)
      return
    }
    const focus = describeFocus(e.target instanceof Element ? e.target : null, { keyboard: tabbed.current })
    const op = playerKey(eventLike(e), focus, { player: 'viewer', mac: IS_MAC, starChords: useKeymap.getState().resolved.byAction['take.star'], downloadChords: useKeymap.getState().resolved.byAction['take.download'] })
    if (!op || op === 'exit') return
    e.preventDefault()
    e.stopPropagation()
    if (op === 'toggle') spaceTaken.current = true
    if (e.repeat && !VIEWER_REPEATS.has(op)) return
    runOp(op)
  }
  const runOp = (op: TransportOp) => {
    const v = videoRef.current
    switch (op) {
      case 'toggle':
        if (!v) return
        if (transport.shuttling()) return transport.stop()
        if (v.paused) void v.play().catch(() => undefined)
        else v.pause()
        return
      case 'stop':
        return transport.stop()
      case 'forward':
      case 'reverse':
        return transport.shuttleOp(op)
      case 'start':
      case 'end':
        return transport.edge(op)
      case 'clip-prev':
        if (prev) openTake(prev.id)
        return
      case 'clip-next':
        if (next) openTake(next.id)
        return
      case 'fullscreen':
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
        else if (v && document.fullscreenEnabled) void v.requestFullscreen().catch(() => undefined)
        return
      case 'star':
        if (take.status === 'completed' || take.starred) starSelection(take.id)
        return
      case 'download':
        void downloadTake(take.id)
        return
      default: {
        const n = frameDelta(op)
        if (n) transport.frame(n)
      }
    }
  }
  // Added once, in a layout effect: before Modal's (passive) Escape listener, so Esc in fullscreen can stop it.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e)
    const onFull = () => {
      if (!document.fullscreenElement) exitedAt.current = performance.now()
    }
    const onPointer = () => {
      tabbed.current = false
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('fullscreenchange', onFull)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('fullscreenchange', onFull)
      // Closing the viewer while its video is fullscreen: leave fullscreen too.
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    }
  }, [])

  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    setConfirmDelete(false)
  }, [take.id])
  useEffect(() => {
    if (!confirmDelete) return
    const id = setTimeout(() => setConfirmDelete(false), 3500)
    return () => clearTimeout(id)
  }, [confirmDelete])

  /**
   * The shared delete (actions.deleteTakes — same as the canvas node menu, the queue and the Delete key). The
   * two-click button is the confirmation that the video is lost, so deleteTakes asks nothing more ('usedOnly').
   */
  const remove = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setConfirmDelete(false)
    const neighbour = next ?? prev
    const deleted = deleteTakes([take.id], { confirm: 'usedOnly' })
    if (deleted === null) return
    if (neighbour) openTake(neighbour.id)
    else onClose()
  }

  // Through the cost dialog like every paid run (wallet + price shown, no double submit); it then opens the new take
  // here so its progress, then the video, shows in the viewer.
  const rerun = () => rerunTake(take.id, { follow: true })

  /** Secondary: just the poster frame (the big button saves the video + prompt). */
  const downloadPoster = async () => {
    if (!take.posterId) return
    const ok = await downloadMedia(take.posterId, takeFileBase(take.id), 'jpg')
    if (!ok) toast('Không tìm thấy file trong bộ nhớ trình duyệt.', { tone: 'error' })
  }
  const failedOrCancelled = take.status === 'failed' || take.status === 'cancelled'

  const gotoScene = () => {
    if (!scene) return
    onClose()
    const ui = useUI.getState()
    ui.select([scene.id])
    if (ui.view !== 'canvas') {
      // Opened from the Table / Storyboard: show the canvas, let it mount and measure its nodes, then focus.
      ui.setView('canvas')
      window.setTimeout(() => focusNodes([scene.id]), 150)
    } else focusNodes([scene.id])
  }

  return (
    <Modal
      size="xwide"
      onClose={onClose}
      title={
        <span className="rq-tv-title">
          <span className="mono">{label}</span>
          <span className={`rq-tv-scene${scene?.title ? '' : ' faint'}`}>{scene ? scene.title || 'Chưa đặt tên' : 'Cảnh đã bị xoá'}</span>
          {/* up here, never over the picture */}
          {take.starred && <span className="rq-tv-star">★ Take đã chọn</span>}
        </span>
      }
      headerExtra={
        <>
          <TakeFileNameField key={take.id} take={take} />
          <span className="rq-tv-nav">
            <button type="button" className="icon-btn" disabled={!prev} onClick={() => prev && openTake(prev.id)} title="Take trước (↑)" aria-label="Take trước">
              <ChevronLeft size={16} />
            </button>
            <span className="mono faint">
              {idx + 1}/{sorted.length}
            </span>
            <button type="button" className="icon-btn" disabled={!next} onClick={() => next && openTake(next.id)} title="Take sau (↓)" aria-label="Take sau">
              <ChevronRight size={16} />
            </button>
          </span>
        </>
      }
      footer={
        <>
          <button
            type="button"
            className={`btn btn-danger${confirmDelete ? ' rq-confirming' : ''}`}
            onClick={remove}
            title="Xoá take này. Video đã xoá không hoàn tác được."
          >
            <Trash size={14} />
            {confirmDelete ? 'Bấm lần nữa để xoá' : 'Xoá take'}
          </button>
          <span className="rq-spacer" />
          {take.posterId && take.videoId && (
            <button type="button" className="btn btn-ghost" onClick={() => void downloadPoster()} title={`Chỉ tải ảnh poster ${code}_T${take.number} (.jpg)`}>
              <ImageIcon size={14} />
              Tải poster
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={!scene || !!restoreBlock(take)}
            onClick={() => restoreFromTake(take.id)}
            title={restoreBlock(take) ?? 'Đưa prompt, tham chiếu và cấu hình của cảnh về đúng như lúc chạy take này'}
          >
            <Undo2 size={14} />
            Khôi phục prompt này
          </button>
          {!failedOrCancelled && (
            <button type="button" className="btn" disabled={!scene} onClick={rerun} title="Chạy lại cảnh với prompt hiện tại">
              <RotateCcw size={14} />
              Chạy lại
            </button>
          )}
          <BigActionButton key={take.id} take={take} label={`${code}_T${take.number}`} onRerun={scene ? rerun : undefined} />
        </>
      }
    >
      <div className="rq-tv">
        <div className="rq-tv-left">
          <Stage take={take} onRerun={scene ? rerun : undefined} videoRef={videoRef} ownsRate={transport.ownsRate} />
          <div className="rq-tv-strip">
            <div className="section-title">
              <span>Các take của cảnh</span>
              <span className="faint">↑ ↓ để chuyển</span>
            </div>
            <TakeStrip sceneId={take.sceneId} size="md" activeTakeId={take.id} />
          </div>
        </div>
        <div className="rq-tv-right">
          <Details take={take} scene={scene} onGoto={gotoScene} onClose={onClose} />
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * The footer's big primary button (same rule as the take node): "Tải video" when finished (video + prompt .txt,
 * see actions.downloadTake), disabled with the progress while queued/processing, "Chạy lại" after a failure/cancel.
 */
function BigActionButton({ take, label, onRerun }: { take: Take; label: string; onRerun?: () => void }) {
  const [saving, setSaving] = useState(false)
  // "Hỏi nơi lưu & tên file" on: the button opens a save dialog (an ellipsis says so).
  const askWhere = useDownloadPrefs((s) => s.askWhere)
  if (take.status === 'completed') {
    const hasVideo = !!take.videoId
    const save = async () => {
      if (saving) return
      setSaving(true)
      try {
        await downloadTake(take.id)
      } finally {
        setSaving(false)
      }
    }
    return (
      <button
        type="button"
        className="btn btn-primary btn-lg rq-dl-big"
        disabled={saving || (!hasVideo && !take.posterId)}
        onClick={() => void save()}
        title={hasVideo ? `Tải video ${label} (kèm file .txt chứa prompt nếu bật trong Cài đặt)` : 'Take này không có video (trình duyệt không ghi được) — tải ảnh poster'}
      >
        {saving ? <LoaderCircle size={17} className="rq-spin" /> : <Download size={17} />}
        {saving ? 'Đang lưu…' : hasVideo ? (askWhere ? 'Tải video…' : 'Tải video') : 'Tải poster'}
      </button>
    )
  }
  if (isActive(take)) return <BusyButton take={take} />
  return (
    <button type="button" className="btn btn-primary btn-lg rq-dl-big" disabled={!onRerun} onClick={onRerun} title="Chạy lại cảnh với prompt hiện tại">
      <RotateCcw size={17} />
      Chạy lại
    </button>
  )
}

/** "Đang chờ…", "Đang tạo 40%", then "Đang tải về 45%" (or "… 12,3 MB") while the finished video downloads. */
function BusyButton({ take }: { take: Take }) {
  const transfer = useTakeTransfers((s) => transferLabel(s.byTake[take.id]))
  const transferPct = useTakeTransfers((s) => transferPercent(s.byTake[take.id]))
  const processing = take.status === 'processing'
  const pct = processing ? (transfer ? (transferPct ?? take.progress) : take.progress) : 0
  return (
    <button
      type="button"
      className="btn btn-primary btn-lg rq-dl-big busy"
      disabled
      style={{ ['--p' as string]: `${pct}%` }}
      title={transfer ? 'Video đã tạo xong, đang tải về máy' : 'Video đang được tạo'}
    >
      <LoaderCircle size={17} className="rq-spin" />
      {processing ? (transfer ?? `Đang tạo ${pct}%`) : 'Đang chờ…'}
    </button>
  )
}

function Stage({
  take,
  onRerun,
  videoRef,
  ownsRate,
}: {
  take: Take
  onRerun?: () => void
  videoRef: RefObject<HTMLVideoElement | null>
  ownsRate: (rate: number) => boolean
}) {
  const videoUrl = useMediaUrl(take.videoId)
  const posterUrl = useMediaUrl(take.posterId)
  // "Bảng phát triển" exists only while development mode is open (its links on a DEV take would do nothing when locked)
  const devOpen = useDevAllowed()
  const transfer = useTakeTransfers((s) => transferLabel(s.byTake[take.id]))
  const transferPct = useTakeTransfers((s) => transferPercent(s.byTake[take.id]))
  const active = isActive(take)
  const now = useNow(active)
  const provider = providerOf(take)
  // Old demo credits were refunded by SanoVids on failure / cancel; canvasapp — and its simulation in development mode —
  // bills (and refunds) the account itself.
  const demoPaid = chargedDemo(take)
  // Where to check an uncertain charge: the real site, or the dev panel for the simulation.
  const checkWhere = provider !== 'dev' ? 'kiểm tra trên canvasapp.io.vn' : devOpen ? 'kiểm tra trong Bảng phát triển' : 'mở khoá chế độ Phát triển để kiểm tra'
  // The site and its credits by name (development mode: "canvasapp giả lập", "credit dev").
  const siteName = provider === 'dev' ? 'canvasapp giả lập' : PROVIDER_LABEL[provider]
  const creditWord = provider === 'dev' ? 'credit dev' : 'credit'
  const refundNote = demoPaid ? (
    <div className="rq-stage-faint">Đã hoàn {formatCredits(take.cost, 'demo')} (giả lập).</div>
  ) : provider === 'canvasapp' && take.remoteId ? (
    <div className="rq-stage-faint">Credit canvasapp: hoàn hay không do canvasapp quyết định — xem lịch sử credit trên canvasapp.io.vn.</div>
  ) : provider === 'dev' && take.remoteId ? (
    <div className="rq-stage-faint">
      Credit dev (giả lập): máy chủ giả lập hoàn khi job lỗi ở đó — xem Lịch sử credit
      {devOpen && (
        <>
          {' '}hoặc{' '}
          <button type="button" className="rq-link" onClick={() => openDevPanel('jobs')}>
            Bảng phát triển
          </button>
        </>
      )}
      .
    </div>
  ) : null

  let content: ReactNode
  if (take.status === 'completed' && videoUrl) {
    content = <ViewerVideo key={videoUrl} url={videoUrl} poster={posterUrl} videoRef={videoRef} ownsRate={ownsRate} />
  } else if (take.status === 'completed') {
    content = (
      <>
        {posterUrl ? <img className="rq-video" src={posterUrl} alt="" draggable={false} /> : null}
        {!take.videoId && <span className="rq-stage-note">Không có video (trình duyệt không ghi được) — đang hiện ảnh poster.</span>}
      </>
    )
  } else if (active) {
    const downloading = take.status === 'processing' && transfer !== null
    const pct = take.status === 'processing' ? (downloading ? (transferPct ?? take.progress) : take.progress) : 0
    content = (
      <div className="rq-stage-state">
        <div className="rq-ring" style={{ ['--p' as string]: pct }}>
          <span className="mono">{take.status === 'processing' ? (downloading && transferPct === null ? '…' : `${pct}%`) : '…'}</span>
        </div>
        <div className="rq-stage-msg">
          {downloading
            ? `Video đã tạo xong — ${transfer!.charAt(0).toLowerCase()}${transfer!.slice(1)}…`
            : take.status === 'processing'
              ? provider === 'mock'
                ? 'Đang tạo video (demo cũ)…'
                : provider === 'dev'
                  ? 'Đang tạo video trên canvasapp giả lập (chế độ Phát triển)…'
                  : `Đang tạo video trên ${PROVIDER_LABEL[provider]}…`
              : 'Đang chờ trong hàng đợi…'}
        </div>
        <div className="rq-stage-faint mono">
          {take.status === 'processing' ? 'đã chạy ' : 'đã chờ '}
          {formatDuration(take.status === 'processing' && take.startedAt ? now - take.startedAt : now - take.createdAt)}
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => cancelTake(take.id)}
          title={
            demoPaid
              ? undefined
              : downloading
                ? `Video đã tạo xong trên ${siteName} và đã trừ ${creditWord} — huỷ sẽ bỏ video này trong SanoVids (hỏi trước)`
                : take.status === 'queued' && !take.remoteId && !take.submitUnknown
                  ? `Huỷ trước khi gửi sang ${siteName} — không bị trừ ${creditWord}`
                  : take.submitUnknown && !take.remoteId
                    ? `Huỷ trong SanoVids — lần gửi trước sang ${siteName} không rõ đã bị trừ ${creditWord} chưa, ${checkWhere}`
                    : take.imported
                      ? `Ngừng theo dõi trong SanoVids — job tạo trên ${siteName} vẫn chạy ở đó`
                      : `Huỷ trong SanoVids — job đã gửi sang ${siteName} vẫn chạy ở đó`
          }
        >
          <CircleStop size={13} />
          {demoPaid ? `Huỷ job · hoàn ${formatCredits(take.cost, 'demo')}` : downloading ? 'Huỷ' : 'Huỷ job'}
        </button>
      </div>
    )
  } else if (take.status === 'failed') {
    content = (
      <div className="rq-stage-state danger">
        <CircleAlert size={34} />
        <div className="rq-stage-msg">Tạo video thất bại</div>
        <div className="rq-stage-dim">{take.error ?? 'Lỗi không rõ.'}</div>
        {refundNote}
        {onRerun && (
          <button type="button" className="btn btn-sm" onClick={onRerun}>
            <RotateCcw size={13} />
            {/* the earlier request can no longer be checked: only a NEW take can run (actions.rerunTake) */}
            {isUnverifiableSubmit(take) ? 'Tạo lại' : 'Thử lại'}
          </button>
        )}
      </div>
    )
  } else {
    content = (
      <div className="rq-stage-state">
        <Ban size={30} />
        <div className="rq-stage-msg">Job đã huỷ</div>
        {/* cancelled while its request was on its way and no job id came back: it may be billed (store/runs) */}
        {isUncertainSubmit(take) && hasUncertainSubmitText(take.error) && <div className="rq-stage-dim">{take.error}</div>}
        {refundNote}
        {onRerun && (
          <button type="button" className="btn btn-sm" onClick={onRerun}>
            <RotateCcw size={13} />
            {/* the earlier request can no longer be checked: only a NEW take can run (actions.rerunTake) */}
            {isUnverifiableSubmit(take) ? 'Tạo lại' : 'Chạy lại'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={`rq-stage ${take.status}`}>{content}</div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------

function Details({ take, scene, onGoto, onClose }: { take: Take; scene: Scene | undefined; onGoto: () => void; onClose: () => void }) {
  const project = useProject((s) => s.project)
  const assets = project.assets
  const current = useMemo(() => (scene ? compileScene(project, scene) : null), [project, scene])
  const [showDiff, setShowDiff] = useState(false)
  const spec = MODELS[take.settings.model]
  const provider = providerOf(take)
  const cost = takeCostLine(take)
  const devOpen = useDevAllowed()

  const refAssets = useMemo(() => {
    const map = new Map(assets.map((a) => [a.id, a]))
    // Numbers as the take was sent: an asset deleted since keeps its slot so later numbers don't shift.
    const numbers = snapshotImageNumbers(assets, take.refsSnapshot, exactImageKeys(take))
    const found: { asset: Asset; n: number | undefined }[] = []
    let missing = 0
    for (const id of take.refsSnapshot) {
      const a = map.get(id)
      if (a) found.push({ asset: a, n: numbers.get(id) })
      else missing++
    }
    return { found, missing }
  }, [assets, take])

  // an imported take compares only what it knows for sure (never a placeholder or a guess)
  const comparable = !take.imported || (fieldState(take, 'prompt') !== 'unknown' && fieldState(take, 'refs') !== 'unknown')
  const changes = useMemo(() => {
    if (!scene || !current || !comparable) return null
    const promptChanged = current.text !== take.promptSnapshot
    const sure = (f: ImportedField) => fieldState(take, f) === 'known'
    const settingsChanged = take.imported
      ? scene.settings.model !== take.settings.model || (['mode', 'duration', 'resolution', 'ratio'] as const).some((f) => sure(f) && scene.settings[f] !== take.settings[f])
      : !sameSettings(scene.settings, take.settings)
    const tagOf = (id: string) => '@' + (assets.find((a) => a.id === id)?.tag ?? '?')
    // references inferred from the node are compared (they are what the node had); unknown ones never get here
    const refsSure = fieldState(take, 'refs') !== 'unknown'
    const refsAdded = refsSure ? scene.refs.filter((id) => !take.refsSnapshot.includes(id)).map(tagOf) : []
    const refsRemoved = refsSure ? take.refsSnapshot.filter((id) => !scene.refs.includes(id)).map(tagOf) : []
    const refsReordered = refsSure && !refsAdded.length && !refsRemoved.length && scene.refs.join('|') !== take.refsSnapshot.join('|')
    // Same assets in the same order, but a character got / lost / reordered pictures since the run: the same
    // @image_N may now be another picture. Only knowable for takes that carry the exact image list.
    const exact = exactImageKeys(take)
    const imagesChanged =
      refsSure && !!exact && !refsAdded.length && !refsRemoved.length && !refsReordered && imageSlotsFor(assets, scene.refs).map(imageKey).join('|') !== exact.join('|')
    const diff = promptChanged ? paragraphDiff(take.promptSnapshot, current.text) : { removed: [], added: [] }
    const any = promptChanged || settingsChanged || refsAdded.length > 0 || refsRemoved.length > 0 || refsReordered || imagesChanged
    return { promptChanged, settingsChanged, refsAdded, refsRemoved, refsReordered, imagesChanged, diff, any }
  }, [scene, current, take, assets, comparable])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(take.promptSnapshot)
      toast(`Đã copy prompt của T${take.number} (${[...take.promptSnapshot].length.toLocaleString('vi-VN')} ký tự).`, { tone: 'success' })
    } catch {
      toast('Trình duyệt chặn clipboard. Hãy bôi đen và copy thủ công.', { tone: 'error' })
    }
  }

  return (
    <div className="rq-details">
      <div className="rq-details-head">
        <StatusBadge take={take} />
        <button
          type="button"
          className={`btn btn-sm rq-star-btn${take.starred ? ' on' : ''}`}
          aria-pressed={!!take.starred}
          disabled={take.status !== 'completed' && !take.starred}
          onClick={() => toggleChosenTake(take.id)}
          title={take.starred ? 'Bỏ chọn take này' : 'Đánh dấu là take dùng cho cảnh (Phát liền và file .zip sẽ ưu tiên)'}
        >
          <Star size={13} fill={take.starred ? 'currentColor' : 'none'} />
          {take.starred ? 'Đã chọn' : 'Chọn take này'}
        </button>
        <span className="rq-spacer" />
        <button type="button" className="btn btn-ghost btn-sm" disabled={!scene} onClick={onGoto} title="Chọn cảnh và đưa canvas tới đó">
          <LocateFixed size={13} />
          Đi tới cảnh
        </button>
      </div>

      <dl className="rq-info">
        <dt>Model</dt>
        <dd>
          <span className="rq-model">
            <i style={{ background: spec?.color }} />
            {spec?.name ?? take.settings.model}
          </span>
          <span className="faint" title={fieldTitle(take, 'mode')}>
            {' '}
            · {takeModeText(take)}
          </span>
        </dd>
        <dt>Cấu hình</dt>
        <dd className="mono" title={take.imported ? (importedFieldsNote(take) ?? undefined) : undefined}>
          {takeSettingsText(take)}
        </dd>
        {take.imported && (
          <>
            <dt>Nguồn</dt>
            <dd className="rq-info-source">
              <span className="rq-imported">nhập</span> {importedSourceText(take)}
              {importedFieldsNote(take) && <span className="faint"> · {importedFieldsNote(take)}</span>}
            </dd>
          </>
        )}
        <dt>Tạo bằng</dt>
        <dd className="rq-info-provider">
          <ProviderBadge take={take} />
          <span className="faint">{take.foreignProvider ? NEWER_BUILD_TITLE : PROVIDER_LABEL[provider]}</span>
        </dd>
        <dt>Chi phí</dt>
        <dd className={`rq-info-cost ${cost.kind}`}>
          <span className={`mono${cost.struck ? ' rq-struck' : ''}`}>{cost.amount}</span>
          <span className="rq-cost-note"> · {cost.note}</span>
        </dd>
        <dt>Tạo lúc</dt>
        <dd className="mono">{formatClock(take.createdAt)}</dd>
        <dt>Bắt đầu</dt>
        <dd className="mono">
          {formatClock(take.startedAt)}
          {take.startedAt ? <span className="faint"> · chờ {formatDuration(take.startedAt - take.createdAt)}</span> : null}
        </dd>
        <dt>Kết thúc</dt>
        <dd className="mono">
          {formatClock(take.finishedAt)}
          {take.startedAt && take.finishedAt ? <span className="faint"> · tạo trong {formatDuration(take.finishedAt - take.startedAt)}</span> : null}
        </dd>
        {take.remoteId && provider !== 'mock' && (
          <>
            <dt>Mã job</dt>
            <dd className="rq-info-job">
              <span className="mono" title={`job_id trên ${PROVIDER_LABEL[provider]}: ${decodeRemoteId(take.remoteId)?.jobId ?? take.remoteId}`}>
                {(decodeRemoteId(take.remoteId)?.jobId ?? take.remoteId).slice(0, 8)}…
              </span>
              {provider === 'dev' && devOpen && (
                <button type="button" className="rq-link" onClick={() => openDevPanel('jobs')} title="Xem job này trên máy chủ giả lập (hoàn tất / cho lỗi / cho hết hạn)">
                  xem trong Bảng phát triển
                </button>
              )}
            </dd>
          </>
        )}
        {take.error && take.status === 'failed' && (
          <>
            <dt>Lỗi</dt>
            <dd className="rq-err-text">{take.error}</dd>
          </>
        )}
      </dl>

      <div className="rq-sec">
        <div className="section-title">
          <span>Ảnh tham chiếu lúc chạy</span>
          <span className="faint">{take.refsSnapshot.length}</span>
        </div>
        {fieldState(take, 'refs') === 'unknown' ? (
          <div className="faint rq-small" title={unknownFieldTitle(take)}>
            Không rõ (job tạo trên {importSite(take)} — SanoVids không biết ảnh tham chiếu của nó).
          </div>
        ) : refAssets.found.length ? (
          <div className="rq-chips">
            {refAssets.found.map(({ asset, n }) => (
              <AssetChip key={asset.id} asset={asset} index={n} />
            ))}
          </div>
        ) : (
          <div className="faint rq-small">Không có ảnh tham chiếu.</div>
        )}
        {refAssets.missing > 0 && <div className="faint rq-small">{refAssets.missing} mục đã bị xoá khỏi thư viện.</div>}
        {fieldState(take, 'refs') === 'inferred' && (
          <div className="faint rq-small" title={INFERRED_FIELD_TITLE}>
            Đoán theo node trên canvas cầu nối — có thể khác lúc tạo.
          </div>
        )}
      </div>

      <div className="rq-sec rq-sec-prompt">
        <div className="section-title">
          <span>Prompt đã gửi</span>
          <span className="rq-sec-actions">
            <span className="faint mono">{[...take.promptSnapshot].length.toLocaleString('vi-VN')} ký tự</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
              <Copy size={12} />
              Copy
            </button>
          </span>
        </div>

        {!scene ? (
          <div className="rq-diff-flag muted">Cảnh đã bị xoá — không so sánh được.</div>
        ) : !comparable ? (
          <div className="rq-diff-flag muted">Take nhập — không đủ dữ liệu để so với cảnh (không rõ prompt / ảnh tham chiếu lúc tạo).</div>
        ) : changes?.any ? (
          <div className="rq-diff-flag warn">
            <span className="badge warn">Prompt hiện tại đã khác</span>
            <span className="rq-diff-what">
              {[
                changes.promptChanged && 'nội dung prompt',
                changes.settingsChanged && 'cấu hình',
                (changes.refsAdded.length || changes.refsRemoved.length || changes.refsReordered) && 'ảnh tham chiếu',
                changes.imagesChanged && 'ảnh của nhân vật',
              ]
                .filter(Boolean)
                .join(', ')}
            </span>
            <span className="rq-spacer" />
            <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showDiff} onClick={() => setShowDiff((v) => !v)}>
              <FileDiff size={12} />
              {showDiff ? 'Ẩn khác biệt' : 'Xem khác biệt'}
            </button>
          </div>
        ) : (
          <div className="rq-diff-flag ok">
            <span className="badge ok">
              {take.imported && (take.imported.unknown.length || take.imported.inferred.length) ? 'Khớp với prompt hiện tại (phần đã biết)' : 'Khớp với prompt hiện tại'}
            </span>
          </div>
        )}

        {showDiff && changes?.any && scene && (
          <div className="rq-diff">
            {changes.settingsChanged && (
              <div className="rq-diff-line">
                <b>Cấu hình:</b> <span className="mono">{take.imported ? takeSettingsText(take) : settingsLabel(take.settings)}</span> ({MODELS[take.settings.model]?.short}) →{' '}
                <span className="mono">{settingsLabel(scene.settings)}</span> ({MODELS[scene.settings.model]?.short})
              </div>
            )}
            {(changes.refsAdded.length > 0 || changes.refsRemoved.length > 0) && (
              <div className="rq-diff-line">
                <b>Tham chiếu:</b>{' '}
                {changes.refsRemoved.map((t) => (
                  <span key={'r' + t} className="rq-del">
                    −{t}{' '}
                  </span>
                ))}
                {changes.refsAdded.map((t) => (
                  <span key={'a' + t} className="rq-add">
                    +{t}{' '}
                  </span>
                ))}
              </div>
            )}
            {changes.refsReordered && (
              <div className="rq-diff-line">
                <b>Tham chiếu:</b> thứ tự đã đổi (số @image thay đổi).
              </div>
            )}
            {changes.imagesChanged && (
              <div className="rq-diff-line">
                <b>Ảnh của nhân vật:</b> đã thêm, bớt hoặc đổi thứ tự ảnh từ lúc chạy — cùng một @image_N giờ có thể là tấm khác.
              </div>
            )}
            {changes.diff.removed.map((p, i) => (
              <div key={'-' + i} className="rq-diff-para del">
                <span className="rq-diff-sign">−</span>
                <span>
                  <HighlightedPrompt text={p} />
                </span>
              </div>
            ))}
            {changes.diff.added.map((p, i) => (
              <div key={'+' + i} className="rq-diff-para add">
                <span className="rq-diff-sign">+</span>
                <span>
                  <HighlightedPrompt text={p} />
                </span>
              </div>
            ))}
            {changes.promptChanged && !changes.diff.removed.length && !changes.diff.added.length && (
              <div className="rq-diff-line faint">Chỉ khác thứ tự đoạn hoặc khoảng trắng.</div>
            )}
            <div className="rq-diff-legend faint">
              <span className="rq-del">− chỉ có trong take này</span> · <span className="rq-add">+ chỉ có trong prompt hiện tại</span>
            </div>
          </div>
        )}

        <pre className="rq-prompt">
          <HighlightedPrompt text={take.promptSnapshot || (fieldState(take, 'prompt') === 'unknown' ? '(không rõ — canvasapp không trả prompt của job này)' : '(trống)')} />
        </pre>
      </div>

      {isActive(take) && (
        <div className="rq-small faint rq-live">
          <LoaderCircle size={12} className="rq-spin" /> Đang cập nhật trực tiếp…
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------

/** Tooltip of a value an imported take does not know for sure (undefined = known). */
function fieldTitle(take: Take, f: ImportedField): string | undefined {
  const st = fieldState(take, f)
  return st === 'unknown' ? unknownFieldTitle(take) : st === 'inferred' ? INFERRED_FIELD_TITLE : undefined
}
