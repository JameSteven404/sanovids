// Player of a finished take inside its canvas node: the video plus a compact control bar pinned to the bottom of the
// poster — timeline (click / drag to seek), play / pause, time, speed and volume. Mounted by TakeNode only while the
// node is hovered or its player is pinned (= one or two players on the whole board), so it may update per frame:
// the progress bar is painted from requestAnimationFrame through a CSS variable, never through React state.
//
// Shared with the take viewer and "Phát liền": sound on/off, volume and speed (lib/playback.ts). Using any control
// pins the player: it keeps playing after the mouse leaves, until empty canvas is clicked, another node's player
// is pinned, or the node unmounts / zooms out. A pinned player pauses while another node previews or a dialog is
// open (never two videos with sound at once) and resumes when its node is hovered again.
import { Pause, Play, Volume1, Volume2, VolumeX } from 'lucide-react'
import { memo, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type SyntheticEvent, type WheelEvent } from 'react'
import { playWithSound, resumePoint, savedPosition, savePosition, toggleSound, usePlayback } from '../../lib/playback'
import { useUI } from '../../store/ui'
import { formatClock, formatLength, fractionAt, nextRate, rateLabel, rememberedVolume, seekStep, stepVolume, volumeLevel, wheelStep } from './playerModel'

const stop = (e: SyntheticEvent) => e.stopPropagation()
/**
 * A mouse press must not move focus into the player: a focused control would keep Space from panning the canvas
 * (the player is 'nokey' for React Flow) and Space would then press the focused button. Clicks, pointer capture and
 * Tab focus are unaffected.
 */
const keepFocus = (e: SyntheticEvent) => e.preventDefault()

/** Known length of `v` in seconds, or 0 (no metadata yet / a WebM without duration). */
const lengthOf = (v: HTMLVideoElement) => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0)

/** Volume keyboard / wheel step. */
const VOL_STEP = 0.05

function TakePlayerView({ takeId, url }: { takeId: string; url: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const sound = usePlayback((s) => s.sound)
  const volume = usePlayback((s) => s.volume)
  const rate = usePlayback((s) => s.rate)
  const pinned = usePlayback((s) => s.pinned === takeId)
  const hovered = usePlayback((s) => s.hoverId === takeId)
  const otherHover = usePlayback((s) => s.hoverId !== null && s.hoverId !== takeId)
  const blocked = useUI((s) => s.dialog.kind !== 'none')

  const [playing, setPlaying] = useState(false)
  /** The video is unmuted (the browser may have refused sound before the first click on the page). */
  const [audible, setAudible] = useState(false)
  /** Whole seconds: the text re-renders once per second at most. */
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [scrubbing, setScrubbing] = useState(false)

  /** Set while the timeline is dragged: whether to resume playing afterwards. */
  const scrub = useRef<{ wasPlaying: boolean } | null>(null)
  /** Paused by another preview / a dialog (not by the user): resumes when this node is hovered again. */
  const autoPaused = useRef(false)
  /** The start position is applied: from then on the position is worth remembering. */
  const ready = useRef(false)
  /** Finding the length of a WebM without duration (see the start effect): ignore the times it reports. */
  const probing = useRef(false)
  const volDrag = useRef(false)
  /** The level the speaker button restores when the volume is 0 (where the last volume gesture started from). */
  const lastVolume = useRef(volume > 0 ? volume : 1)
  /** When the last wheel / key volume step happened (performance.now()): steps close together are one gesture. */
  const lastVolStepAt = useRef(-Infinity)
  const wheelAcc = useRef({ rate: 0, volume: 0 })
  /** The sound pref this player last followed (the start effect applies the first one). */
  const lastSound = useRef(sound)

  /** Any use of a control keeps this player open (and closes another pinned one). */
  const touch = () => usePlayback.getState().pin(takeId)

  // Start: shared volume + speed, resume where this take was left, play (with sound when allowed).
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    let live = true
    ready.current = false
    probing.current = false
    const p = usePlayback.getState()
    v.volume = p.volume
    // The media load resets playbackRate to defaultPlaybackRate: set both.
    v.defaultPlaybackRate = p.rate
    v.playbackRate = p.rate
    const begin = () => {
      probing.current = false
      const d = lengthOf(v)
      const t = resumePoint(savedPosition(takeId), d)
      if (t > 0 || v.currentTime > 0) v.currentTime = t
      ready.current = true
      setDuration(d)
      setTime(Math.floor(t))
    }
    const onMeta = () => {
      if (v.duration !== Infinity) return begin()
      // The demo's WebM (MediaRecorder) carries no duration: a seek far past the end makes the browser find it.
      probing.current = true
      v.addEventListener('seeked', begin, { once: true })
      v.currentTime = 1e101
    }
    if (v.readyState >= HTMLMediaElement.HAVE_METADATA) onMeta()
    else v.addEventListener('loadedmetadata', onMeta, { once: true })
    void playWithSound(v, p.sound).then((on) => live && setAudible(on))
    return () => {
      live = false
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('seeked', begin)
      if (ready.current) savePosition(takeId, v.currentTime)
      ready.current = false
    }
  }, [url, takeId])

  // Media events: play state, time text, length, buffered part; the played part follows every frame while playing.
  useEffect(() => {
    const v = videoRef.current
    const track = trackRef.current
    if (!v || !track) return
    let raf = 0
    const paint = () => {
      if (scrub.current || probing.current) return
      const d = lengthOf(v)
      track.style.setProperty('--tp-played', String(d ? Math.min(1, v.currentTime / d) : 0))
    }
    const loop = () => {
      paint()
      raf = requestAnimationFrame(loop)
    }
    const onPlay = () => {
      setPlaying(true)
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(loop)
    }
    const onPause = () => {
      setPlaying(false)
      cancelAnimationFrame(raf)
      raf = 0
      paint()
    }
    const onTime = () => {
      if (probing.current) return
      setTime(Math.floor(v.currentTime))
      // Also here: rAF stops in a hidden / occluded window while the video may keep playing.
      paint()
    }
    const onBuffered = () => {
      const d = lengthOf(v)
      const b = v.buffered
      track.style.setProperty('--tp-buf', String(d && b.length ? Math.min(1, b.end(b.length - 1) / d) : 0))
    }
    const onLength = () => {
      if (!probing.current) setDuration(lengthOf(v))
      onBuffered()
      paint()
    }
    const onSeeked = () => {
      paint()
      onTime()
    }
    const onVolume = () => setAudible(!v.muted)
    const on: [string, () => void][] = [
      ['play', onPlay],
      ['pause', onPause],
      ['timeupdate', onTime],
      ['seeked', onSeeked],
      ['durationchange', onLength],
      ['loadedmetadata', onLength],
      ['progress', onBuffered],
      ['volumechange', onVolume],
    ]
    for (const [type, fn] of on) v.addEventListener(type, fn)
    if (!v.paused) onPlay()
    return () => {
      cancelAnimationFrame(raf)
      for (const [type, fn] of on) v.removeEventListener(type, fn)
    }
  }, [])

  // Shared prefs changed (here or in another player): follow them.
  useEffect(() => {
    const v = videoRef.current
    if (v) v.volume = volume
  }, [volume])
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.defaultPlaybackRate = rate
    v.playbackRate = rate
  }, [rate])
  // Sound switched off or back on (here, in the take viewer, in "Phát liền"): mirror it, both ways. Only real changes:
  // the start effect sets the first state, and may have had to fall back to muted. Switching the sound on is always a
  // user action on this page, so unmuting is allowed. The speaker icon follows through 'volumechange'.
  useEffect(() => {
    const v = videoRef.current
    if (!v || lastSound.current === sound) return
    lastSound.current = sound
    v.muted = !sound
  }, [sound])

  // Another node previews, or a dialog opened: pause. Back on this node (nothing in the way): resume.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (otherHover || blocked) {
      if (!v.paused) {
        autoPaused.current = true
        v.pause()
      }
    } else if (hovered && autoPaused.current) {
      autoPaused.current = false
      void v.play().catch(() => undefined)
    }
  }, [otherHover, blocked, hovered])

  // ---------------- play / pause ----------------
  const togglePlay = () => {
    touch()
    const v = videoRef.current
    if (!v) return
    autoPaused.current = false
    if (v.paused) void v.play().catch(() => undefined)
    else v.pause()
  }

  // ---------------- timeline ----------------
  const showTip = (f: number) => {
    const track = trackRef.current
    const v = videoRef.current
    if (!track || !v) return
    track.style.setProperty('--tp-at', String(f))
    // The right end reads like the length label (rounded), not a second short of it.
    const d = lengthOf(v)
    if (tipRef.current) tipRef.current.textContent = f >= 1 ? formatLength(d) : formatClock(f * d)
  }
  const seekTo = (f: number) => {
    const v = videoRef.current
    const d = v ? lengthOf(v) : 0
    if (!v || !d) return
    trackRef.current?.style.setProperty('--tp-played', String(f))
    v.currentTime = f * d
  }
  const onTrackDown = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    // Only a primary press uses the control (a right / middle press neither seeks nor pins).
    if (e.button !== 0) return
    touch()
    const v = videoRef.current
    if (!v || !lengthOf(v)) return
    e.currentTarget.setPointerCapture(e.pointerId)
    scrub.current = { wasPlaying: !v.paused }
    autoPaused.current = false
    v.pause()
    setScrubbing(true)
    const f = fractionAt(e.clientX, e.currentTarget.getBoundingClientRect())
    showTip(f)
    seekTo(f)
  }
  const onTrackMove = (e: PointerEvent<HTMLDivElement>) => {
    const f = fractionAt(e.clientX, e.currentTarget.getBoundingClientRect())
    showTip(f)
    if (scrub.current) seekTo(f)
  }
  const endScrub = (e: PointerEvent<HTMLDivElement>) => {
    const s = scrub.current
    if (!s) return
    scrub.current = null
    setScrubbing(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const v = videoRef.current
    if (v && s.wasPlaying) void v.play().catch(() => undefined)
  }
  const onTrackKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const v = videoRef.current
    const d = v ? lengthOf(v) : 0
    if (!v || !d) return
    let t: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = v.currentTime - seekStep(e.shiftKey)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = v.currentTime + seekStep(e.shiftKey)
    else if (e.key === 'Home') t = 0
    else if (e.key === 'End') t = d
    if (t === null) return
    e.preventDefault()
    e.stopPropagation()
    touch()
    seekTo(Math.min(1, Math.max(0, t / d)))
  }

  // ---------------- speed ----------------
  const changeRate = (dir: 1 | -1) => {
    touch()
    const p = usePlayback.getState()
    p.setRate(nextRate(p.rate, dir))
  }
  const onRateWheel = (e: WheelEvent) => {
    const r = wheelStep(wheelAcc.current.rate, e.deltaY, e.deltaMode)
    wheelAcc.current.rate = r.acc
    if (r.step) changeRate(r.step)
  }

  // ---------------- volume ----------------
  /** New volume; above 0 on a muted video turns the sound on (always from a user action here). */
  const applyVolume = (next: number) => {
    touch()
    const p = usePlayback.getState()
    p.setVolume(next)
    const v = videoRef.current
    if (next > 0 && (v?.muted || !p.sound)) {
      p.setSound(true)
      if (v) v.muted = false
    }
  }
  const toggleMute = () => {
    touch()
    const p = usePlayback.getState()
    const v = videoRef.current
    if (audible && p.volume > 0) lastVolume.current = p.volume
    // From volume 0, the sound comes back at the level the last volume gesture started from (see toggleSound).
    const next = toggleSound(audible, p.volume, lastVolume.current)
    p.setSound(next.sound)
    p.setVolume(next.volume)
    // A click is a user gesture: unmuting is allowed even when autoplay with sound was refused.
    if (v) v.muted = !next.sound
  }
  /** Before a wheel / key volume step: remember the level a burst of them started from (see rememberedVolume). */
  const noteVolumeStep = () => {
    const now = performance.now()
    lastVolume.current = rememberedVolume(lastVolume.current, usePlayback.getState().volume, now, lastVolStepAt.current)
    lastVolStepAt.current = now
  }
  const volumeAt = (e: PointerEvent<HTMLElement>) => Math.round(fractionAt(e.clientX, e.currentTarget.getBoundingClientRect()) * 100) / 100
  const onVolDown = (e: PointerEvent<HTMLSpanElement>) => {
    e.stopPropagation()
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    volDrag.current = true
    // A drag is one gesture: the level it starts from is the one to restore, not what it sweeps through.
    const cur = usePlayback.getState().volume
    if (cur > 0) lastVolume.current = cur
    applyVolume(volumeAt(e))
  }
  const onVolMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (volDrag.current) applyVolume(volumeAt(e))
  }
  const endVolDrag = (e: PointerEvent<HTMLSpanElement>) => {
    volDrag.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const onVolKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    const cur = usePlayback.getState().volume
    let next: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = stepVolume(cur, -VOL_STEP)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = stepVolume(cur, VOL_STEP)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = 1
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    noteVolumeStep()
    applyVolume(next)
  }
  const onVolWheel = (e: WheelEvent) => {
    const r = wheelStep(wheelAcc.current.volume, e.deltaY, e.deltaMode)
    wheelAcc.current.volume = r.acc
    if (!r.step) return
    noteVolumeStep()
    applyVolume(stepVolume(usePlayback.getState().volume, r.step * VOL_STEP))
  }

  const level = volumeLevel(volume, audible)
  const VolumeIcon = level === 'off' ? VolumeX : level === 'low' ? Volume1 : Volume2
  const muteLabel = level === 'off' ? 'Bật tiếng' : 'Tắt tiếng'
  const pct = Math.round(volume * 100)
  // The length is rounded (formatLength), and so is the slider's maximum: text and ARIA values agree.
  const lengthText = formatLength(duration)
  const lengthMax = Math.round(duration)
  const clock = `${formatClock(time)} / ${lengthText}`
  const rateText = rateLabel(rate)
  const cls = ['cv-tp', 'nodrag', 'nopan', 'nokey', scrubbing && 'is-scrub', pinned && 'is-pinned', duration > 0 && 'has-length']
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <video ref={videoRef} className="cv-take-video" src={url} loop playsInline muted preload="auto" />
      <div
        className={cls}
        style={{ ['--tp-vol' as string]: String(audible ? volume : 0) }}
        // Only the controls take presses (the fade, time text and gaps let them through to the node, see canvas.css);
        // each control pins the player itself, on a primary press only.
        onPointerDown={stop}
        onMouseDown={keepFocus}
        onClick={stop}
        onDoubleClick={stop}
      >
        <div
          ref={trackRef}
          className="cv-tp-track"
          role="slider"
          tabIndex={0}
          aria-label="Thời gian video"
          aria-valuemin={0}
          aria-valuemax={lengthMax}
          aria-valuenow={Math.min(time, lengthMax)}
          aria-valuetext={clock}
          title="Bấm hoặc kéo để tua (← → từng giây, Shift: 5 giây)"
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onLostPointerCapture={endScrub}
          onKeyDown={onTrackKey}
        >
          <span className="cv-tp-rail" aria-hidden>
            <i className="cv-tp-buf" />
            <i className="cv-tp-fill" />
          </span>
          <span className="cv-tp-knob" aria-hidden>
            <i />
          </span>
          <span ref={tipRef} className="cv-tp-tip" aria-hidden>
            0:00
          </span>
        </div>
        <div className="cv-tp-row">
          <button className="cv-tp-btn" title={playing ? 'Tạm dừng' : 'Phát'} aria-label={playing ? 'Tạm dừng' : 'Phát'} onClick={togglePlay}>
            {playing ? <Pause size={13} fill="currentColor" strokeWidth={0} /> : <Play size={13} fill="currentColor" strokeWidth={0} />}
          </button>
          <span className="cv-tp-time" aria-hidden>
            {formatClock(time)}
            <span className="cv-tp-dur"> / {lengthText}</span>
          </span>
          <span className="cv-tp-sp" />
          <button
            className="cv-tp-btn cv-tp-rate nowheel"
            title={`Tốc độ phát ${rateText} — bấm để tăng, Shift+bấm để giảm, hoặc cuộn chuột`}
            aria-label={`Tốc độ phát ${rateText}`}
            onClick={(e) => changeRate(e.shiftKey ? -1 : 1)}
            onWheel={onRateWheel}
          >
            {rateText}
          </button>
          <span className="cv-tp-vol nowheel" onWheel={onVolWheel}>
            <button
              className="cv-tp-btn"
              title={`${muteLabel} (âm lượng ${pct}% — cuộn chuột để chỉnh)`}
              // The name says the action (it changes with the state), so no aria-pressed: "Bật tiếng, đã nhấn" would
              // read as if the sound were on.
              aria-label={muteLabel}
              onClick={toggleMute}
            >
              <VolumeIcon size={14} strokeWidth={2} />
            </button>
            <span
              className="cv-tp-vslider"
              role="slider"
              tabIndex={0}
              aria-label="Âm lượng"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-valuetext={audible ? `${pct}%` : `Tắt tiếng (${pct}%)`}
              title={`Âm lượng ${pct}%`}
              onPointerDown={onVolDown}
              onPointerMove={onVolMove}
              onPointerUp={endVolDrag}
              onPointerCancel={endVolDrag}
              onLostPointerCapture={endVolDrag}
              onKeyDown={onVolKey}
            >
              <i className="cv-tp-vfill" />
              <i className="cv-tp-vknob" />
            </span>
          </span>
        </div>
      </div>
    </>
  )
}

/** Unmounting (hover ended and not pinned, zoomed out, node gone) also unpins this take. */
function TakePlayerRoot(props: { takeId: string; url: string }) {
  const { takeId } = props
  useEffect(() => () => usePlayback.getState().unpin(takeId), [takeId])
  return <TakePlayerView {...props} />
}

export const TakePlayer = memo(TakePlayerRoot)
