// "Phát liền": plays every scene's chosen take in scene order (the video, else its poster, else a slate). Opened from
// the top bar (filmActions.openFilmPlayer → dialog kind 'player', FilmPlayerDialog); items from core/filmItems.
// Styles: player.css (its own media tokens, so it looks the same wherever it is mounted).
import { Download, LoaderCircle, Maximize2, Minimize2, Pause, Play, RotateCcw, SkipBack, SkipForward, SquareMousePointer, Star, Volume2, VolumeX, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { downloadTake } from '../../actions'
import { filmRuntimeOf, runtimeText, type PlayerItem } from '../../core/filmItems'
import { escapeDecision, frameDelta, transportKey, type TransportOp } from '../../core/transportKeys'
import { useTransport } from '../../hooks/useTransport'
import { cachedUrl, getUrl, releaseUrl } from '../../lib/imageStore'
import { eventLike, IS_MAC } from '../../lib/keyEvents'
import { playWithSound, toggleSound, usePlayback } from '../../lib/playback'
import { providerOf } from '../../providers'
import { keyForTopOverlay, trapTabWithin, useOverlayFocus } from '../common/focus'
import { MediaImg } from '../common/Media'
import './player.css'

export type { PlayerItem }

/** Length of a fake clip (development mode / old demo, lib/mockProvider) when the webm has no duration metadata. */
const MOCK_CLIP_S = 3
const TICK = 100
/**
 * Safety net for a video whose 'ended' never fires (decode error, stalled blob): skip it once playback has made
 * no progress for this long. A watchdog, not a total timer, so clips of any length (Seedance: up to 30 s) play
 * to their end, and pausing does not count.
 */
const STALL_MS = 6000

const stillMs = (item: PlayerItem) => Math.max(1500, (item.duration / 5) * 1000)
/** Held keys repeat only for frame steps; the shuttle, toggles and switching scenes act once per press. */
const FILM_REPEATS = new Set<TransportOp>(['frame-back', 'frame-fwd', 'frame-back5', 'frame-fwd5'])

type VideoState = { id: string; url: string | null; failed: boolean } | null

/**
 * Speaker switch of the player (shared with the canvas player and the take viewer). A click may always unmute. The
 * shared volume counts: at 0 (set on the canvas or in the viewer) the player is silent, so the switch shows off and
 * turning it on also brings the volume back (toggleSound). The play effect reads the volume only when a clip starts:
 * the element is updated here directly.
 */
function SoundButton({ videoRef }: { videoRef: RefObject<HTMLVideoElement | null> }) {
  const sound = usePlayback((s) => s.sound)
  const volume = usePlayback((s) => s.volume)
  const on = sound && volume > 0
  const toggle = () => {
    const p = usePlayback.getState()
    const next = toggleSound(p.sound, p.volume)
    p.setSound(next.sound)
    p.setVolume(next.volume)
    const v = videoRef.current
    if (v) {
      v.volume = next.volume
      v.muted = !next.sound
    }
  }
  // The name says the action and changes with the state: no aria-pressed ("Bật tiếng, đã nhấn" would mislead).
  const label = on ? 'Tắt tiếng' : 'Bật tiếng'
  return (
    <button className="icon-btn" onClick={toggle} title={label} aria-label={label}>
      {on ? <Volume2 size={18} /> : <VolumeX size={18} />}
    </button>
  )
}

export interface FilmPlayerProps {
  items: PlayerItem[]
  start: number
  onClose: () => void
  /** Scenes without a ★ take: with `onSelectMissing`, a "Chọn N cảnh chưa có ★" button (top bar and end screen). */
  missingCount?: number
  onSelectMissing?: () => void
}

export function FilmPlayer({ items, start, onClose, missingCount = 0, onSelectMissing }: FilmPlayerProps) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), Math.max(0, items.length - 1)))
  const [paused, setPaused] = useState(false)
  const [ended, setEnded] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [video, setVideo] = useState<VideoState>(null)
  const [saving, setSaving] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  // Focus the player while it is open (keys stay here) and give focus back to where it was (the top-bar button) on close.
  const rootRef = useRef<HTMLDivElement>(null)
  useOverlayFocus(rootRef)

  const item = items[index] as PlayerItem | undefined
  const videoId = item?.take?.videoId ?? null

  // Resolve the video object URL for the current item.
  useEffect(() => {
    if (!videoId) {
      setVideo(null)
      return
    }
    const hit = cachedUrl(videoId)
    setVideo({ id: videoId, url: hit, failed: false })
    let alive = true
    getUrl(videoId).then((url) => alive && setVideo({ id: videoId, url, failed: !url }),
      () => alive && setVideo({ id: videoId, url: null, failed: true }))
    return () => {
      alive = false
      releaseUrl(videoId)
    }
  }, [videoId])

  const mode: 'video' | 'loading' | 'still' =
    videoId && video?.id === videoId && !video.failed ? (video.url ? 'video' : 'loading') : videoId && video?.id !== videoId ? 'loading' : 'still'

  const indexRef = useRef(index)
  indexRef.current = index
  const next = useCallback(() => {
    setElapsed(0)
    const i = indexRef.current
    if (i >= items.length - 1) setEnded(true)
    else setIndex(i + 1)
  }, [items.length])
  const prev = useCallback(() => {
    setElapsed(0)
    setEnded(false)
    setIndex((i) => Math.max(0, i - 1))
  }, [])
  const jump = useCallback((i: number) => {
    setElapsed(0)
    setEnded(false)
    setPaused(false)
    setIndex(i)
  }, [])

  // Stills (poster / slate): advance on a timer.
  const hasItem = !!item
  useEffect(() => {
    if (mode !== 'still' || paused || ended || !hasItem) return
    const id = window.setInterval(() => setElapsed((e) => e + TICK), TICK)
    return () => window.clearInterval(id)
  }, [mode, paused, ended, hasItem, index])
  useEffect(() => {
    if (mode === 'still' && item && elapsed >= stillMs(item)) next()
  }, [mode, elapsed, item, next])

  // Video: follow pause state; safety net in case 'ended' never fires.
  useEffect(() => {
    const v = videoRef.current
    if (!v || mode !== 'video') return
    if (paused || ended) v.pause()
    else {
      // The shared volume (not the speed: "Phát liền" always plays at normal speed).
      const { sound, volume } = usePlayback.getState()
      v.volume = volume
      void playWithSound(v, sound)
    }
  }, [paused, ended, mode, index, video?.id])
  // Watchdog (see STALL_MS): last time the video's currentTime moved.
  const progressAt = useRef(0)
  const lastTime = useRef(-1)
  useEffect(() => {
    if (mode !== 'video' || paused || ended) return
    // (Re)start the watchdog: a new clip, or playback resumed after a pause.
    progressAt.current = Date.now()
    lastTime.current = -1
    const id = window.setInterval(() => {
      const v = videoRef.current
      // A hidden tab may pause the video: that is not a stall.
      if (document.hidden) progressAt.current = Date.now()
      else if (v && v.currentTime !== lastTime.current) {
        lastTime.current = v.currentTime
        progressAt.current = Date.now()
      } else if (Date.now() - progressAt.current >= STALL_MS) next()
    }, 1000)
    return () => window.clearInterval(id)
  }, [mode, paused, ended, index, next])

  // ---- transport keys (core/transportKeys, player 'film'): Space / K play–pause, L faster forward, J backwards in the
  // current clip, ← / → frames (a clip with video), ↑ / ↓ previous / next scene, Home / End first / last scene,
  // Ctrl+` / ` fullscreen, Esc leaves fullscreen, else closes. Captured so global shortcuts don't fire: every other key
  // is stopped too (F / N / Delete / Ctrl+Z / Alt+↑ / M would act on the canvas or the project behind the overlay; ★
  // would change the film's list mid-play) — only Ctrl/Cmd+S still reaches useShortcuts. Default actions (Tab, Enter)
  // still work. "Phát liền" always plays at normal speed: the J / L shuttle gives 1× back.
  const transport = useTransport(videoRef, { userRate: () => 1 })
  const [full, setFull] = useState(false)
  /** When fullscreen last ended (performance.now()): the Escape that ended it must not close the player too. */
  const exitedAt = useRef(-Infinity)
  useEffect(() => {
    const onFull = () => {
      const on = !!rootRef.current && document.fullscreenElement === rootRef.current
      if (!on) exitedAt.current = performance.now()
      setFull(on)
    }
    document.addEventListener('fullscreenchange', onFull)
    return () => {
      document.removeEventListener('fullscreenchange', onFull)
      if (rootRef.current && document.fullscreenElement === rootRef.current) void document.exitFullscreen().catch(() => undefined)
    }
  }, [])
  const toggleFull = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else if (document.fullscreenEnabled) void root.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined)
  }, [])
  // A new clip is a new <video> (normal speed): no shuttle carries over.
  const { release } = transport
  useEffect(() => {
    release()
  }, [index, release])
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e) => {
    // A sheet above every overlay (development mode's login / SePay) gets its own keys.
    if (keyForTopOverlay(e)) return
    const op = transportKey(eventLike(e), { player: 'film', mac: IS_MAC })
    if (!op) {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's')) e.stopPropagation()
      // The event never reaches the player's own handlers (stopped here): keep Tab inside the player.
      if (rootRef.current) trapTabWithin(rootRef.current, e)
      return
    }
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat && !FILM_REPEATS.has(op)) return
    runOp(op)
  }
  const runOp = (op: TransportOp) => {
    const isVideo = mode === 'video'
    switch (op) {
      case 'exit': {
        const d = escapeDecision({ fullscreen: !!document.fullscreenElement, exitedAt: exitedAt.current, now: performance.now() })
        if (d === 'exit-fullscreen') void document.exitFullscreen().catch(() => undefined)
        else if (d === 'normal') onClose()
        return
      }
      case 'toggle':
        if (ended) return jump(0)
        if (transport.shuttling()) {
          transport.stop()
          setPaused(true)
          return
        }
        return setPaused((p) => !p)
      case 'stop':
        transport.stop()
        return setPaused(true)
      case 'forward':
        if (ended) return
        setPaused(false)
        if (isVideo) transport.shuttleOp('forward')
        return
      case 'reverse':
        if (!isVideo || ended) return
        setPaused(true)
        return transport.shuttleOp('reverse')
      case 'clip-prev':
        return prev()
      case 'clip-next':
        return next()
      case 'start':
        return jump(0)
      case 'end':
        return jump(items.length - 1)
      case 'fullscreen':
        return toggleFull()
      default: {
        const n = frameDelta(op)
        if (!n || !isVideo || ended) return
        setPaused(true)
        transport.frame(n)
      }
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!item) return null

  // The takes' seconds, as the top-bar tooltip says (a slate of a scene without a take is not film length; an imported
  // take whose length canvasapp did not say is left out, and said so).
  const runtime = runtimeText(filmRuntimeOf(items))
  // Development-mode (and old demo) takes are ~3 s fake clips; takes from canvasapp play at their own length. So do
  // takes of a newer build's provider (provider 'mock' + foreignProvider): real videos, not fakes.
  const hasFake = items.some((i) => i.take && !i.take.foreignProvider && (providerOf(i.take) === 'dev' || providerOf(i.take) === 'mock'))
  const take = item.take
  const posterId = take?.posterId ?? null
  const canSave = take?.status === 'completed'
  const save = async () => {
    if (!take || saving) return
    setSaving(true)
    try {
      await downloadTake(take.id)
    } finally {
      setSaving(false)
    }
  }
  // "Chọn N cảnh chưa có ★" (top bar, small; end screen, full size).
  const missing = (size: 'sm' | 'md') =>
    missingCount > 0 && onSelectMissing ? (
      <button
        type="button"
        className={`btn${size === 'sm' ? ' btn-sm' : ''} vw-player-missing`}
        onClick={onSelectMissing}
        title="Đóng trình phát và chọn các cảnh này trên canvas"
      >
        <SquareMousePointer size={size === 'sm' ? 13 : 14} /> Chọn {missingCount} cảnh chưa có ★
      </button>
    ) : null
  const segProgress = (i: number) => {
    if (i < index || (ended && i === index)) return 1
    if (i > index) return 0
    if (mode === 'still') return Math.min(1, elapsed / stillMs(item))
    if (mode === 'video') {
      const v = videoRef.current
      const d = v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : MOCK_CLIP_S
      return Math.min(1, elapsed / 1000 / d)
    }
    return 0
  }

  return (
    <div
      ref={rootRef}
      className="vw-player"
      role="dialog"
      aria-modal="true"
      aria-label="Phát liền"
      tabIndex={-1}
      style={{ outline: 'none' }}
    >
      {/* What is on screen lives up here, never over the picture. */}
      <div className="vw-player-top">
        <div className="vw-player-caption">
          <span className="vw-player-label">Phát liền</span>
          <span className="vw-player-code">
            {item.code}
            {take && (
              <span className="vw-player-take">
                {take.starred && <Star size={11} fill="currentColor" />}T{take.number}
              </span>
            )}
          </span>
          {item.title && <span className="vw-player-scene-title">{item.title}</span>}
          <span className="vw-player-count faint">
            ({index + 1}/{items.length}) · tổng {runtime}
          </span>
          {take && mode === 'still' && <span className="vw-player-sub">Không có video — hiển thị poster</span>}
        </div>
        <span className="vw-player-note">{hasFake ? 'Phát triển: video giả ~3 giây · ' : ''}Cảnh chỉ có poster được hiện trong 1/5 thời lượng</span>
        {missing('sm')}
        <SoundButton videoRef={videoRef} />
        <button
          className="icon-btn"
          onClick={toggleFull}
          title={full ? 'Thoát toàn màn hình (Esc)' : 'Toàn màn hình (`)'}
          aria-label={full ? 'Thoát toàn màn hình' : 'Toàn màn hình'}
        >
          {full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </button>
        <button className="icon-btn" onClick={onClose} title="Đóng (Esc)" aria-label="Đóng">
          <X size={18} />
        </button>
      </div>

      <div className="vw-player-stage">
        <div className="vw-player-frame">
          {mode === 'video' && video?.url ? (
            <video
              key={video.id}
              ref={videoRef}
              className="vw-player-media"
              src={video.url}
              autoPlay
              muted
              playsInline
              onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime * 1000)}
              onEnded={next}
              onError={() => setVideo((v) => (v ? { ...v, failed: true } : v))}
            />
          ) : posterId ? (
            <MediaImg id={posterId} className="vw-player-media" />
          ) : (
            <div className="vw-player-slate">
              <span>{item.code}</span>
              <small>{item.title || 'Chưa đặt tên'}</small>
              <em>Chưa có take hoàn thành</em>
            </div>
          )}
          {mode === 'loading' && <div className="vw-player-loading">Đang tải video…</div>}

          {ended && (
            <div className="vw-player-end">
              <h3>Hết phim</h3>
              <p>
                {items.length} cảnh · {runtime}
              </p>
              <div>
                <button className="btn btn-primary" onClick={() => jump(0)}>
                  <RotateCcw size={14} /> Phát lại
                </button>
                <button className="btn" onClick={onClose}>
                  Đóng
                </button>
                {missing('md')}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="vw-player-controls">
        <div className="vw-player-buttons">
          <button className="icon-btn" onClick={prev} disabled={index === 0} title="Cảnh trước (↑)" aria-label="Cảnh trước">
            <SkipBack size={16} />
          </button>
          <button
            className="vw-player-pp"
            onClick={() => {
              // a click leaves the J / L shuttle (back to normal speed) before playing / pausing
              transport.release()
              if (ended) jump(0)
              else setPaused((p) => !p)
            }}
            title="Phát / tạm dừng (Space, K) · L nhanh dần, J lùi · ← → từng khung" aria-label="Phát / tạm dừng">
            {paused || ended ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
          </button>
          <button className="icon-btn" onClick={next} disabled={ended} title="Cảnh sau (↓)" aria-label="Cảnh sau">
            <SkipForward size={16} />
          </button>
        </div>
        <div className="vw-player-timeline">
          {items.map((it, i) => (
            <button
              key={it.sceneId}
              className={`vw-seg ${i === index ? 'current' : ''} ${it.take ? '' : 'is-empty'}`}
              style={{ flexGrow: Math.max(1, it.duration) }}
              onClick={() => jump(i)}
              title={`${it.code}${it.title ? ' · ' + it.title : ''} · ${it.duration}s${it.take ? ` · T${it.take.number}` : ' · chưa có take'}`}
            >
              <i style={{ width: `${segProgress(i) * 100}%` }} />
            </button>
          ))}
        </div>
        <button
          className="btn btn-primary vw-player-dl"
          disabled={!canSave || saving}
          onClick={() => void save()}
          title={canSave && take ? `Tải video ${item.code}_T${take.number} (kèm prompt nếu bật trong Cài đặt)` : 'Cảnh này chưa có video tạo xong'}
        >
          {saving ? <LoaderCircle size={15} className="vw-player-spin" /> : <Download size={15} />}
          Tải video này
        </button>
      </div>
    </div>
  )
}
