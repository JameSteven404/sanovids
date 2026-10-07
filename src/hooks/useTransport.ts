// J / K / L shuttle, frame steps and Home / End on one <video> (the players' shared mechanics; WHICH key does what is
// core/transportKeys). Used by the canvas take player, the take viewer and "Phát liền".
//
// - L: forward at 1× → 2× → 4× (core/transportKeys nextShuttle). J: backwards — Chromium cannot play backwards, so the
//   video is paused and its time moved every animation frame (a little choppier than Premiere); it stops at 0.
// - K / stop(): pause, leave the shuttle, back to the user's speed. release(): leave the shuttle without pausing.
// - Frames: pause, then ± FRAME_S per frame, kept inside the clip. End: paused on the last frame (the card's and the
//   viewer's videos loop: a seek to the very end would restart them at 0).
// - The shuttle speeds are never the user's speed: the players' 'ratechange' handlers skip the running shuttle's rate
//   (ownsRate), so usePlayback.setRate (clamped to 2× and stored) never sees a 4× of L.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { edgeSeek, FRAME_S, focusKind, frameTarget, nextShuttle, reverseStep, SHUTTLE_IDLE, shuttleOwnsRate, type FocusKind, type Shuttle } from '../core/transportKeys'

/**
 * The players' key rules need to know what the focused element is (core/transportKeys focusKind). `keyboard`: the
 * player saw Tab since the last pointer press (the take viewer tracks it) — what decides for a `<video controls>`:
 * its built-in controls are out of reach (the key event's target is the video), and :focus-visible cannot tell a
 * Tab into them from a click on the picture.
 */
export function describeFocus(el: Element | null, opts?: { keyboard?: boolean }): FocusKind {
  if (!el || !(el instanceof HTMLElement)) return 'none'
  let visible = false
  try {
    visible = el.matches(':focus-visible')
  } catch {
    /* an engine without :focus-visible: treat as a mouse focus */
  }
  const mediaControls = (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') && (el as HTMLMediaElement).controls
  return focusKind({
    tag: el.tagName,
    type: (el as HTMLInputElement).type,
    role: el.getAttribute('role'),
    editable: el.isContentEditable,
    focusVisible: visible,
    mediaControls,
    keyboard: !!opts?.keyboard,
  })
}

/** The part of a <video> the seek helpers use (a fake in the tests). */
export interface SeekableVideo {
  currentTime: number
  readonly duration: number
  pause(): void
}
const lengthOf = (v: SeekableVideo) => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0)

/** ← / → (Shift: 5): pause, then `frames` frames on (never past the last frame: a `loop` video would restart). */
export function stepFrames(v: SeekableVideo, frames: number): void {
  v.pause()
  v.currentTime = frameTarget(v.currentTime, frames, lengthOf(v), FRAME_S)
}

/** Home / End (core/transportKeys edgeSeek): End pauses on the last frame — a seek to the length would loop to 0. */
export function seekEdge(v: SeekableVideo, where: 'start' | 'end'): void {
  const s = edgeSeek(where, lengthOf(v), FRAME_S)
  if (!s) return
  if (s.pause) v.pause()
  v.currentTime = s.time
}

export interface TransportControls {
  shuttle: Shuttle
  /** J / L: shuttle backwards / forward (each press in the same direction doubles the speed, up to 4×). */
  shuttleOp: (op: 'forward' | 'reverse') => void
  /** K: pause and leave the shuttle (the user's speed comes back). */
  stop: () => void
  /** Leave the shuttle without pausing (Space while shuttling pauses through stop; a play button calls this first). */
  release: () => void
  /** The shuttle is running (L / J): Space stops it instead of toggling. */
  shuttling: () => boolean
  /** ← / → (Shift: 5): pause, then step `frames` frames (negative = back). */
  frame: (frames: number) => void
  /** Home / End: to the start / the end of the clip. */
  edge: (where: 'start' | 'end') => void
  /** This rate was set by the shuttle (a 'ratechange' handler must not store it as the user's speed). */
  ownsRate: (rate: number) => boolean
}

export function useTransport(
  videoRef: RefObject<HTMLVideoElement | null>,
  opts: {
    /** The user's speed (usePlayback.rate; "Phát liền": always 1). */
    userRate: () => number
    /** The backwards shuttle reached the start (the player may update its play state). */
    onReverseEnd?: () => void
  },
): TransportControls {
  const [shuttle, setShuttle] = useState<Shuttle>(SHUTTLE_IDLE)
  const state = useRef<Shuttle>(SHUTTLE_IDLE)
  const raf = useRef(0)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const apply = useCallback((s: Shuttle) => {
    state.current = s
    setShuttle(s)
  }, [])
  const setRate = useCallback((v: HTMLVideoElement, r: number) => {
    if (v.playbackRate !== r) v.playbackRate = r
  }, [])
  const cancelReverse = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = 0
  }, [])
  /** Leave the shuttle: the reverse loop ends and the user's speed comes back. */
  const leave = useCallback(() => {
    cancelReverse()
    const v = videoRef.current
    if (v && state.current.dir !== 0) setRate(v, optsRef.current.userRate())
    if (state.current.dir !== 0) apply(SHUTTLE_IDLE)
  }, [apply, cancelReverse, setRate, videoRef])

  const runReverse = useCallback(
    (v: HTMLVideoElement) => {
      cancelReverse()
      let last = performance.now()
      let target = v.currentTime
      const step = (now: number) => {
        // The element changed (the viewer showed another take) or the shuttle ended meanwhile.
        if (videoRef.current !== v || state.current.dir !== -1) {
          raf.current = 0
          return
        }
        const r = reverseStep(target, state.current.rate, now - last)
        last = now
        target = r.time
        // One seek at a time: Chromium drops frames rather than queueing seeks behind each other.
        if (!v.seeking) v.currentTime = target
        if (r.done) {
          raf.current = 0
          v.currentTime = 0
          apply(SHUTTLE_IDLE)
          setRate(v, optsRef.current.userRate())
          optsRef.current.onReverseEnd?.()
          return
        }
        raf.current = requestAnimationFrame(step)
      }
      raf.current = requestAnimationFrame(step)
    },
    [apply, cancelReverse, setRate, videoRef],
  )

  const shuttleOp = useCallback(
    (op: 'forward' | 'reverse') => {
      const v = videoRef.current
      if (!v) return
      const next = nextShuttle(state.current, op)
      apply(next)
      if (next.dir === 1) {
        cancelReverse()
        setRate(v, next.rate)
        void v.play().catch(() => undefined)
      } else {
        v.pause()
        setRate(v, optsRef.current.userRate())
        if (!raf.current) runReverse(v)
      }
    },
    [apply, cancelReverse, runReverse, setRate, videoRef],
  )

  const stop = useCallback(() => {
    leave()
    videoRef.current?.pause()
  }, [leave, videoRef])

  const frame = useCallback(
    (frames: number) => {
      const v = videoRef.current
      if (!v) return
      leave()
      stepFrames(v, frames)
    },
    [leave, videoRef],
  )

  const edge = useCallback(
    (where: 'start' | 'end') => {
      const v = videoRef.current
      if (!v) return
      leave()
      seekEdge(v, where)
    },
    [leave, videoRef],
  )

  const shuttling = useCallback(() => state.current.dir !== 0, [])
  // Read the element's rate when the event is handled (not the one that queued it): after K the user's speed is back
  // before a late 'ratechange' of the 2× arrives, so nothing wrong is stored either way.
  const ownsRate = useCallback((rate: number) => shuttleOwnsRate(state.current, rate), [])

  // Unmount (the player closed): no loop left behind.
  useEffect(() => cancelReverse, [cancelReverse])

  return { shuttle, shuttleOp, stop, release: leave, shuttling, frame, edge, ownsRate }
}
