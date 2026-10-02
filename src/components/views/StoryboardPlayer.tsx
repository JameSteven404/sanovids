// "Phát liền": plays every scene's chosen take in order (webm when the mock recorded one, else poster).
import { Download, LoaderCircle, Pause, Play, RotateCcw, SkipBack, SkipForward, Star, Volume2, VolumeX, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { downloadTake } from '../../actions'
import type { Take } from '../../core/types'
import { cachedUrl, getUrl } from '../../lib/imageStore'
import { playWithSound, toggleSound, usePlayback } from '../../lib/playback'
import { providerOf } from '../../providers'
import { trapTabWithin, useOverlayFocus } from '../common/focus'
import { MediaImg } from '../common/Media'
import { formatRuntime } from './shared'

export interface PlayerItem {
  sceneId: string
  code: string
  title: string
  take: Take | null
  /** Seconds (take or scene setting). Stills are shown for duration / 5 in the demo. */
  duration: number
}

/** Length of a demo clip recorded by the mock provider when the webm has no duration metadata. */
const MOCK_CLIP_S = 3
const TICK = 100
/**
 * Safety net for a video whose 'ended' never fires (decode error, stalled blob): skip it once playback has made
 * no progress for this long. A watchdog, not a total timer, so clips of any length (Seedance: up to 30 s) play
 * to their end, and pausing does not count.
 */
const STALL_MS = 6000

const stillMs = (item: PlayerItem) => Math.max(1500, (item.duration / 5) * 1000)

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

export function StoryboardPlayer({ items, start, onClose }: { items: PlayerItem[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), Math.max(0, items.length - 1)))
  const [paused, setPaused] = useState(false)
  const [ended, setEnded] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [video, setVideo] = useState<VideoState>(null)
  const [saving, setSaving] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  // Focus the player while it is open (keys stay here) and give focus back to the storyboard on close.
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
    if (hit) return
    let alive = true
    getUrl(videoId).then((url) => alive && setVideo({ id: videoId, url, failed: !url }))
    return () => {
      alive = false
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

  // Keyboard: Space pause, ←/→ prev/next, Esc close. Captured so global shortcuts don't fire: every
  // other key is stopped too (F / 1-3 would switch view, N / Delete / Ctrl+Z edit the project behind
  // the overlay) — only Ctrl/Cmd+S still reaches useShortcuts. Default actions (Tab, Enter) still work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const handled = e.key === 'Escape' || e.key === ' ' || e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      if (!handled) {
        if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's')) e.stopPropagation()
        // The event never reaches the player's own handlers (stopped here): keep Tab inside the player.
        if (rootRef.current) trapTabWithin(rootRef.current, e)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') onClose()
      else if (e.key === ' ') {
        if (ended) {
          jump(0)
          return
        }
        setPaused((p) => !p)
      } else if (e.key === 'ArrowLeft') prev()
      else next()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, prev, next, jump, ended])

  if (!item) return null

  const totalS = items.reduce((t, i) => t + i.duration, 0)
  // Demo takes are ~3 s fake clips; takes from a real provider (canvasapp) play at their own length.
  const hasDemo = items.some((i) => i.take && providerOf(i.take) === 'mock')
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
      aria-label="Phát liền storyboard"
      tabIndex={-1}
      style={{ outline: 'none' }}
    >
      <div className="vw-player-top">
        <span className="vw-player-title">
          Phát liền · <b>{item.code}</b>
          <span className="faint">
            {' '}
            ({index + 1}/{items.length}) · tổng {formatRuntime(totalS)}
          </span>
        </span>
        <span className="vw-player-note">{hasDemo ? 'Demo: video giả ~3 giây · ' : ''}Cảnh chỉ có poster được hiện trong 1/5 thời lượng</span>
        <SoundButton videoRef={videoRef} />
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

          <div className="vw-player-caption">
            <span className="vw-player-code">
              {item.code}
              {take && (
                <span className="vw-player-take">
                  {take.starred && <Star size={11} fill="currentColor" />}T{take.number}
                </span>
              )}
            </span>
            {item.title && <span className="vw-player-scene-title">{item.title}</span>}
            {take && mode === 'still' && <span className="vw-player-sub">Không có video — hiển thị poster</span>}
          </div>

          {ended && (
            <div className="vw-player-end">
              <h3>Hết phim</h3>
              <p>
                {items.length} cảnh · {formatRuntime(totalS)}
              </p>
              <div>
                <button className="btn btn-primary" onClick={() => jump(0)}>
                  <RotateCcw size={14} /> Phát lại
                </button>
                <button className="btn" onClick={onClose}>
                  Đóng
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="vw-player-controls">
        <div className="vw-player-buttons">
          <button className="icon-btn" onClick={prev} disabled={index === 0} title="Cảnh trước (←)" aria-label="Cảnh trước">
            <SkipBack size={16} />
          </button>
          <button className="vw-player-pp" onClick={() => (ended ? jump(0) : setPaused((p) => !p))} title="Phát / tạm dừng (Space)" aria-label="Phát / tạm dừng">
            {paused || ended ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
          </button>
          <button className="icon-btn" onClick={next} disabled={ended} title="Cảnh sau (→)" aria-label="Cảnh sau">
            <SkipForward size={16} />
          </button>
        </div>
        <div className="vw-player-timeline">
          {items.map((it, i) => (
            <button
              key={it.sceneId}
              className={`vw-seg ${i === index ? 'current' : ''} ${it.take ? '' : 'empty'}`}
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
          {saving ? <LoaderCircle size={15} className="vw-spin" /> : <Download size={15} />}
          Tải video này
        </button>
      </div>
    </div>
  )
}
