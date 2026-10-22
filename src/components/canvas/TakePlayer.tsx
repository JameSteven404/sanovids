// Controls of a finished take's player on its canvas node, in the 30px bar UNDER the picture (never drawn over it):
// timeline (click / drag to seek), play / pause, time, speed, volume and "Phóng to" (fullscreen). The <video> itself
// lives in TakeNode's picture box (shared ref, mounted in the same commit). Mounted by TakeNode only while the node is
// hovered or its player is pinned (= one or two players on the whole board), so it may update per frame: the progress
// bar is painted from requestAnimationFrame through a CSS variable, never through React state. TakeBarRest is the
// same bar at rest (no player): play button, generation progress, measured length — same places, nothing jumps.
//
// Shared with the take viewer and "Phát liền": sound on/off, volume and speed (lib/playback.ts). Using any control
// pins the player: it keeps playing after the mouse leaves, until empty canvas is clicked, another node's player
// is pinned, or the node unmounts / zooms out. A pinned player pauses while another node previews or a dialog is
// open (never two videos with sound at once) and resumes when its node is hovered again.
//
// "Phóng to": the node's stage (picture + bar) goes fullscreen (requestFullscreen; the same <video>, so it keeps
// playing). Meanwhile every key is decided here (core/transportKeys nodeFullKey, window capture listeners for keydown,
// keyup and keypress: nothing reaches React Flow or the app shortcuts behind it) and usePlayback.fullscreenId is set.
// It leaves fullscreen on Esc / F / `, when a dialog or a development-mode sheet opens, when the window loses focus
// or is hidden, and when the node unmounts. Unsupported or refused → the take viewer opens instead.
import { Maximize2, Minimize2, Pause, Play, Volume1, Volume2, VolumeX } from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type RefObject,
  type SyntheticEvent,
  type WheelEvent,
} from 'react'
import { takeFileBase } from '../../actions'
import { frameDelta, lastFrameTime, nodeFullKey, VOLUME_KEY_STEP, type TransportOp } from '../../core/transportKeys'
import { useKeymap } from '../../lib/keymapPrefs'
import { starSelection } from '../../keyCommands'
import { describeFocus, useTransport } from '../../hooks/useTransport'
import { eventLike, IS_MAC } from '../../lib/keyEvents'
import { knownLength, playWithSound, resumePoint, savedPosition, saveLength, savePosition, toggleSound, usePlayback } from '../../lib/playback'
import { useDevPrompts } from '../../providers/dev/prompts'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { trapTabWithin } from '../common/focus'
import {
  formatClock,
  formatLength,
  fractionAt,
  fullscreenButton,
  nextRate,
  playClickAction,
  rateLabel,
  rememberedVolume,
  restBarState,
  seekStep,
  shuttleLabel,
  stepVolume,
  volumeLevel,
  wheelStep,
} from './playerModel'

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
/** A window blur shorter than this (a fullscreen transition, a flicker) does not leave fullscreen. */
const BLUR_EXIT_MS = 250
/** Held keys repeat only for these (frame steps, volume): the shuttle and toggles act once per press. */
const REPEATS = new Set<TransportOp>(['frame-back', 'frame-fwd', 'frame-back5', 'frame-fwd5', 'volume-up', 'volume-down'])

function openViewer(takeId: string) {
  useUI.getState().openDialog({ kind: 'take', takeId })
}

export interface TakePlayerProps {
  takeId: string
  url: string
  /** The node's <video> (TakeNode renders it in the picture box). */
  videoRef: RefObject<HTMLVideoElement | null>
  /** The node's stage (picture + bar): what goes fullscreen. */
  stageRef: RefObject<HTMLDivElement | null>
  /** "S03·T2" (fullscreen title). */
  code: string
  /** Fullscreen entered / left (TakeNode keeps the node's place and drops canvas gestures on the stage). */
  onFullChange: (full: boolean) => void
}

function TakePlayerView({ takeId, url, videoRef, stageRef, code, onFullChange }: TakePlayerProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const playRef = useRef<HTMLButtonElement>(null)
  const fullRef = useRef<HTMLButtonElement>(null)
  const volRef = useRef<HTMLSpanElement>(null)
  const sound = usePlayback((s) => s.sound)
  const volume = usePlayback((s) => s.volume)
  const rate = usePlayback((s) => s.rate)
  const pinned = usePlayback((s) => s.pinned === takeId)
  const hovered = usePlayback((s) => s.hoverId === takeId)
  const otherHover = usePlayback((s) => s.hoverId !== null && s.hoverId !== takeId)
  // A play request for this mounted player (canvas Space / J / K / L, the resting bar): its time, 0 = none.
  const requestAt = usePlayback((s) => (s.playRequest?.takeId === takeId ? s.playRequest.at : 0))
  const blocked = useUI((s) => s.dialog.kind !== 'none')

  const [playing, setPlaying] = useState(false)
  /** The video is unmuted (the browser may have refused sound before the first click on the page). */
  const [audible, setAudible] = useState(false)
  /** Whole seconds: the text re-renders once per second at most. */
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [scrubbing, setScrubbing] = useState(false)
  /** The stage is fullscreen ("Phóng to"). */
  const [full, setFull] = useState(false)
  /** "S03·T2 · file name", read once when fullscreen starts. */
  const [fullTitle, setFullTitle] = useState('')

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
  /** performance.now() when the hover preview started playing by itself (playClickAction), null otherwise. */
  const autoStartedAt = useRef<number | null>(null)
  /** Fullscreen was entered from the keyboard: the focus stays on its button afterwards. */
  const fullByKey = useRef(false)
  const wasFull = useRef(false)

  const transport = useTransport(videoRef, { userRate: () => usePlayback.getState().rate })
  const { shuttling, stop: stopShuttle } = transport

  /** Any use of a control keeps this player open (and closes another pinned one). */
  const touch = useCallback(() => usePlayback.getState().pin(takeId), [takeId])

  // Start: shared volume + speed, resume where this take was left, play (with sound when allowed) — unless a play
  // request says otherwise (K = stay paused; J / L = shuttle).
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    let live = true
    ready.current = false
    probing.current = false
    const p = usePlayback.getState()
    const req = p.consumePlayRequest(takeId)
    const pinnedAtStart = p.pinned === takeId
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
      saveLength(takeId, d)
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
    if (req?.op === 'stop') {
      // Asked by a key or a click (a user gesture): the sound setting applies at once.
      v.muted = !p.sound
      setAudible(!v.muted)
    } else {
      void playWithSound(v, p.sound).then((on) => {
        if (!live) return
        setAudible(on)
        // The hover preview started by itself: a click on ▶ in the next moment keeps it running (playClickAction).
        if (!req && !pinnedAtStart) autoStartedAt.current = performance.now()
        if (req?.op === 'forward' || req?.op === 'reverse') transport.shuttleOp(req.op)
      })
    }
    if (req?.focus) playRef.current?.focus()
    return () => {
      live = false
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('seeked', begin)
      if (ready.current) savePosition(takeId, v.currentTime)
      ready.current = false
    }
    // Only a new video (or take) starts over; shuttleOp is a stable callback, videoRef a ref object.
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
      autoStartedAt.current = null
      cancelAnimationFrame(raf)
      raf = 0
      paint()
    }
    const onTime = () => {
      if (probing.current) return
      setTime(Math.floor(v.currentTime))
      // Also here: rAF stops in a hidden / occluded window while the video may keep playing (and J moves a paused one).
      paint()
    }
    const onBuffered = () => {
      const d = lengthOf(v)
      const b = v.buffered
      track.style.setProperty('--tp-buf', String(d && b.length ? Math.min(1, b.end(b.length - 1) / d) : 0))
    }
    const onLength = () => {
      if (!probing.current) {
        setDuration(lengthOf(v))
        saveLength(takeId, lengthOf(v))
      }
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
  }, [takeId, videoRef])

  // Shared prefs changed (here or in another player): follow them.
  useEffect(() => {
    const v = videoRef.current
    if (v) v.volume = volume
  }, [volume, videoRef])
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.defaultPlaybackRate = rate
    // A running J / L shuttle keeps its own speed (it gives the user's speed back when it ends).
    if (!shuttling()) v.playbackRate = rate
  }, [rate, videoRef, shuttling])
  // Sound switched off or back on (here, in the take viewer, in "Phát liền"): mirror it, both ways. Only real changes:
  // the start effect sets the first state, and may have had to fall back to muted. Switching the sound on is always a
  // user action on this page, so unmuting is allowed. The speaker icon follows through 'volumechange'.
  useEffect(() => {
    const v = videoRef.current
    if (!v || lastSound.current === sound) return
    lastSound.current = sound
    v.muted = !sound
  }, [sound, videoRef])

  // Another node previews, or a dialog opened: pause. Back on this node (nothing in the way): resume.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (otherHover || blocked) {
      if (!v.paused || shuttling()) {
        autoPaused.current = !v.paused
        stopShuttle()
        v.pause()
      }
    } else if (hovered && autoPaused.current) {
      autoPaused.current = false
      void v.play().catch(() => undefined)
    }
  }, [otherHover, blocked, hovered, videoRef, shuttling, stopShuttle])

  // ---------------- play / pause ----------------
  /** The play button: within the hover preview's first moment it only pins (keeps it playing); J backwards → play. */
  const onPlayButton = () => {
    const v = videoRef.current
    if (!v) return
    const action = playClickAction({ playing: !v.paused, autoStartedAt: autoStartedAt.current, now: performance.now(), pinned: usePlayback.getState().pinned === takeId })
    touch()
    autoStartedAt.current = null
    autoPaused.current = false
    if (action === 'pin-keep') return
    if (transport.shuttle.dir === 1) return transport.stop()
    if (transport.shuttle.dir === -1) transport.release()
    if (v.paused) void v.play().catch(() => undefined)
    else v.pause()
  }
  /** Space / a play request: play / pause; while J / L shuttles, stop. */
  const toggleKey = () => {
    const v = videoRef.current
    if (!v) return
    touch()
    autoStartedAt.current = null
    autoPaused.current = false
    if (transport.shuttling()) return transport.stop()
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
    // never the very end (the rail's right end, End, → there): the card's video loops, it would restart at 0
    v.currentTime = Math.min(f * d, lastFrameTime(d))
  }
  const onTrackDown = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    // Only a primary press uses the control (a right / middle press neither seeks nor pins).
    if (e.button !== 0) return
    touch()
    const v = videoRef.current
    if (!v || !lengthOf(v)) return
    e.currentTarget.setPointerCapture(e.pointerId)
    transport.release()
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
  /** The focused timeline keeps slider keys: ← → (↓ ↑) one second (Shift: 5), Home / End. True when used. */
  const trackKey = (key: string, shift: boolean): boolean => {
    const v = videoRef.current
    const d = v ? lengthOf(v) : 0
    if (!v || !d) return false
    let t: number | null = null
    if (key === 'ArrowLeft' || key === 'ArrowDown') t = v.currentTime - seekStep(shift)
    else if (key === 'ArrowRight' || key === 'ArrowUp') t = v.currentTime + seekStep(shift)
    else if (key === 'Home') t = 0
    else if (key === 'End') t = d
    if (t === null) return false
    touch()
    transport.release()
    seekTo(Math.min(1, Math.max(0, t / d)))
    return true
  }
  const onTrackKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!trackKey(e.key, e.shiftKey)) return
    e.preventDefault()
    e.stopPropagation()
  }

  // ---------------- speed ----------------
  const changeRate = (dir: 1 | -1) => {
    touch()
    transport.release()
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
  const stepVolumeBy = (delta: number) => {
    noteVolumeStep()
    applyVolume(stepVolume(usePlayback.getState().volume, delta))
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
  /** The focused volume slider keeps slider keys: ← → ↓ ↑ 5 %, Home / End. True when used. */
  const volKey = (key: string): boolean => {
    const cur = usePlayback.getState().volume
    let next: number | null = null
    if (key === 'ArrowLeft' || key === 'ArrowDown') next = stepVolume(cur, -VOL_STEP)
    else if (key === 'ArrowRight' || key === 'ArrowUp') next = stepVolume(cur, VOL_STEP)
    else if (key === 'Home') next = 0
    else if (key === 'End') next = 1
    if (next === null) return false
    noteVolumeStep()
    applyVolume(next)
    return true
  }
  const onVolKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (!volKey(e.key)) return
    e.preventDefault()
    e.stopPropagation()
  }
  const onVolWheel = (e: WheelEvent) => {
    const r = wheelStep(wheelAcc.current.volume, e.deltaY, e.deltaMode)
    wheelAcc.current.volume = r.acc
    if (!r.step) return
    stepVolumeBy(r.step * VOL_STEP)
  }

  // ---------------- fullscreen ("Phóng to") ----------------
  const exitFull = useCallback(() => {
    const el = document.fullscreenElement
    const stage = stageRef.current
    if (el && stage && (el === stage || stage.contains(el))) void document.exitFullscreen().catch(() => undefined)
  }, [stageRef])
  const enterFull = (byKey: boolean) => {
    touch()
    const stage = stageRef.current
    fullByKey.current = byKey
    if (!stage || !document.fullscreenEnabled || typeof stage.requestFullscreen !== 'function') return openViewer(takeId)
    stage.requestFullscreen({ navigationUI: 'hide' }).catch(() => openViewer(takeId))
  }
  const onFullButton = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (full) exitFull()
    else enterFull(e.detail === 0)
  }

  // Follow the document's fullscreen state (entered here, left with the browser's own Esc or by anything else).
  useEffect(() => {
    const onChange = () => {
      const stage = stageRef.current
      setFull(!!stage && document.fullscreenElement === stage)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [stageRef])

  // Entered / left: tell the node and the store, move the focus (entering: onto "Thu nhỏ"; leaving after a mouse
  // entry: out of the player, so Space pans the canvas again).
  useEffect(() => {
    if (full === wasFull.current) return
    wasFull.current = full
    onFullChange(full)
    usePlayback.getState().setFullscreen(full ? takeId : null, takeId)
    if (full) {
      setFullTitle(`${code} · ${takeFileBase(takeId)}`)
      fullRef.current?.focus({ preventScroll: true })
    } else if (fullByKey.current) {
      fullRef.current?.focus({ preventScroll: true })
    } else {
      const a = document.activeElement
      if (a instanceof HTMLElement && stageRef.current?.contains(a)) a.blur()
    }
  }, [full, takeId, code, onFullChange, stageRef])

  // Unmount while fullscreen (the take was removed, the node left the board): leave it, clear the store, and give the
  // node its normal layout back (its fullscreenchange listener is gone with this player).
  useEffect(
    () => () => {
      if (!wasFull.current) return
      wasFull.current = false
      const el = document.fullscreenElement
      if (el && stageRef.current && (el === stageRef.current || stageRef.current.contains(el))) void document.exitFullscreen().catch(() => undefined)
      usePlayback.getState().setFullscreen(null, takeId)
      onFullChange(false)
    },
    [takeId, stageRef, onFullChange],
  )

  // A dialog opened over everything: leave fullscreen (the dialog would show behind it).
  useEffect(() => {
    if (full && blocked) exitFull()
  }, [full, blocked, exitFull])

  // The latest handlers (the listeners below are added once per fullscreen session).
  const toggleRef = useRef(toggleKey)
  toggleRef.current = toggleKey
  const fullKeyRef = useRef<(e: globalThis.KeyboardEvent) => void>(() => undefined)
  fullKeyRef.current = (native) => {
    const stage = stageRef.current
    const active = document.activeElement
    const inside = !!stage && active instanceof HTMLElement && stage.contains(active)
    const d = nodeFullKey(eventLike(native), inside ? describeFocus(active) : 'none', { mac: IS_MAC, starChords: useKeymap.getState().resolved.byAction['take.star'] })
    if (d.kind === 'tab') {
      if (stage) trapTabWithin(stage, native)
      return
    }
    if (d.kind === 'default') return
    if (d.kind === 'slider') {
      const used = active === trackRef.current ? trackKey(native.key, native.shiftKey) : active === volRef.current ? volKey(native.key) : false
      if (used) native.preventDefault()
      return
    }
    // Alt combinations stay with the system (Alt+F4, Alt+Tab); every other key is the player's or nothing.
    if (d.kind === 'block') {
      if (!native.altKey) native.preventDefault()
      return
    }
    native.preventDefault()
    if (native.repeat && !REPEATS.has(d.op)) return
    runOp(d.op)
  }
  const runOp = (op: TransportOp) => {
    switch (op) {
      case 'toggle':
        return toggleKey()
      case 'stop':
        touch()
        return transport.stop()
      case 'forward':
      case 'reverse':
        touch()
        return transport.shuttleOp(op)
      case 'start':
      case 'end':
        touch()
        return transport.edge(op)
      case 'volume-up':
        return stepVolumeBy(VOLUME_KEY_STEP)
      case 'volume-down':
        return stepVolumeBy(-VOLUME_KEY_STEP)
      case 'fullscreen':
      case 'exit':
        return exitFull()
      case 'star':
        return starSelection(takeId)
      default: {
        const n = frameDelta(op)
        if (n) {
          touch()
          transport.frame(n)
        }
      }
    }
  }

  // While fullscreen: own every key (window capture, before React, React Flow and the app shortcuts), the clicks on
  // the picture (click = play / pause, double-click = leave; never the node's "open viewer"), and leave on a window
  // blur / hidden page or when a development-mode sheet appears.
  useEffect(() => {
    if (!full) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      e.stopImmediatePropagation()
      if (e.type === 'keydown') fullKeyRef.current(e)
      // A button activates on Space's keyup: Space is play / pause here.
      else if (e.type === 'keyup' && (e.key === ' ' || e.code === 'Space')) e.preventDefault()
    }
    const types = ['keydown', 'keyup', 'keypress'] as const
    for (const t of types) window.addEventListener(t, onKey, true)
    const v = videoRef.current
    const onClick = (e: MouseEvent) => {
      e.stopPropagation()
      toggleRef.current()
    }
    const onDbl = (e: MouseEvent) => {
      e.stopPropagation()
      exitFull()
    }
    v?.addEventListener('click', onClick)
    v?.addEventListener('dblclick', onDbl)
    let blurTimer: ReturnType<typeof setTimeout> | null = null
    const onBlur = () => {
      if (blurTimer) clearTimeout(blurTimer)
      blurTimer = setTimeout(() => {
        blurTimer = null
        if (!document.hasFocus()) exitFull()
      }, BLUR_EXIT_MS)
    }
    const onVisible = () => {
      if (document.hidden) exitFull()
    }
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisible)
    const offDev = useDevPrompts.subscribe((s) => {
      if (s.login || s.checkout) exitFull()
    })
    const dev = useDevPrompts.getState()
    if (dev.login || dev.checkout) exitFull()
    return () => {
      for (const t of types) window.removeEventListener(t, onKey, true)
      v?.removeEventListener('click', onClick)
      v?.removeEventListener('dblclick', onDbl)
      if (blurTimer) clearTimeout(blurTimer)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisible)
      offDev()
    }
  }, [full, videoRef, exitFull])

  // A play request while mounted (the start effect took the one that mounted it).
  useEffect(() => {
    if (!requestAt) return
    const req = usePlayback.getState().consumePlayRequest(takeId)
    if (!req) return
    if (req.op === 'toggle') toggleKey()
    else if (req.op === 'stop') {
      touch()
      transport.stop()
    } else {
      touch()
      transport.shuttleOp(req.op)
    }
    if (req.focus) playRef.current?.focus()
    // Only a new request runs (the handlers read refs / stable callbacks).
  }, [requestAt])

  const level = volumeLevel(volume, audible)
  const VolumeIcon = level === 'off' ? VolumeX : level === 'low' ? Volume1 : Volume2
  const muteLabel = level === 'off' ? 'Bật tiếng' : 'Tắt tiếng'
  const pct = Math.round(volume * 100)
  // The length is rounded (formatLength), and so is the slider's maximum: text and ARIA values agree.
  const lengthText = formatLength(duration)
  const lengthMax = Math.round(duration)
  const clock = `${formatClock(time)} / ${lengthText}`
  const rateText = shuttleLabel(transport.shuttle) ?? rateLabel(rate)
  const fullBtn = fullscreenButton(full)
  const FullIcon = full ? Minimize2 : Maximize2
  const cls = ['cv-tp', 'nodrag', 'nopan', 'nokey', scrubbing && 'is-scrub', pinned && 'is-pinned', duration > 0 && 'has-length', transport.shuttle.dir !== 0 && 'is-shuttle']
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cls}
      style={{ ['--tp-vol' as string]: String(audible ? volume : 0) }}
      // Only the controls take presses (the time text and the gaps let them through to the node, see takeNode.css);
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
        <button ref={playRef} className="cv-tp-btn cv-tp-play" title={playing ? 'Tạm dừng' : 'Phát'} aria-label={playing ? 'Tạm dừng' : 'Phát'} onClick={onPlayButton}>
          {playing ? <Pause size={13} fill="currentColor" strokeWidth={0} /> : <Play size={13} fill="currentColor" strokeWidth={0} />}
        </button>
        <span className="cv-tp-time" aria-hidden>
          {formatClock(time)}
          <span className="cv-tp-dur"> / {lengthText}</span>
        </span>
        {full && (
          <span className="cv-tp-title" title={fullTitle}>
            {fullTitle}
          </span>
        )}
        <span className="cv-tp-sp" />
        {full && <span className="cv-tp-hint">Esc để thoát</span>}
        <span className="cv-tp-end">
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
              ref={volRef}
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
          <button ref={fullRef} className="cv-tp-btn cv-tp-full" title={fullBtn.title} aria-label={fullBtn.aria} onClick={onFullButton}>
            <FullIcon size={13} strokeWidth={2.2} />
          </button>
        </span>
      </div>
    </div>
  )
}

/** Unmounting (hover ended and not pinned, zoomed out, node gone) also unpins this take. */
function TakePlayerRoot(props: TakePlayerProps) {
  const { takeId } = props
  useEffect(() => () => usePlayback.getState().unpin(takeId), [takeId])
  return <TakePlayerView {...props} />
}

export const TakePlayer = memo(TakePlayerRoot)

/**
 * The bar of a take card without a player (not hovered, or not finished): the same rail, play button and time places
 * as the player (nothing jumps when it mounts). The rail shows the generation progress; ▶ pins the player and asks it
 * to play (from the keyboard, the player's play button then takes the focus); the time is the length a player
 * measured this session (never the requested duration: development-mode clips are ~3 s, and the footer says "30s").
 */
export const TakeBarRest = memo(function TakeBarRest({
  takeId,
  code,
  status,
  progress,
  videoId,
}: {
  takeId: string
  code: string
  status: string
  progress: number
  videoId: string | null
}) {
  const bar = restBarState({ status, progress, videoId }, code, knownLength(takeId))
  const busy = bar.progress !== null
  return (
    <div
      className={`cv-tp is-rest${busy ? ' is-busy' : ''}`}
      style={busy ? ({ ['--tp-played' as string]: String(bar.progress) } as CSSProperties) : undefined}
    >
      <div className="cv-tp-track" aria-hidden>
        <span className="cv-tp-rail">
          <i className="cv-tp-fill" />
        </span>
      </div>
      <div className="cv-tp-row">
        <button
          className="cv-tp-btn cv-tp-play nodrag nopan"
          disabled={!bar.canPlay}
          title={bar.title}
          aria-label={bar.aria}
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={(e) => {
            e.stopPropagation()
            usePlayback.getState().requestPlay(takeId, 'toggle', { focus: e.detail === 0 })
          }}
        >
          <Play size={13} fill="currentColor" strokeWidth={0} />
        </button>
        {bar.length && (
          <span className="cv-tp-time" title="Độ dài video">
            {bar.length}
          </span>
        )}
      </div>
    </div>
  )
})
