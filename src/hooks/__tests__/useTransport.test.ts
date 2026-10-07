// The players' seek mechanics (hooks/useTransport stepFrames / seekEdge) on a fake <video> that behaves like the
// canvas card's and the viewer's: `loop` — a seek to the very end restarts the clip at 0 (Chromium's "reached the end
// while looping" rule). End and → near the end must land on the LAST frame, not on the first one.
import { describe, expect, it } from 'vitest'
import { FRAME_S } from '../../core/transportKeys'
import { seekEdge, stepFrames, type SeekableVideo } from '../useTransport'

class LoopingVideo implements SeekableVideo {
  paused: boolean
  private t = 0
  constructor(
    readonly duration: number,
    playing: boolean,
    at = 0,
  ) {
    this.paused = !playing
    this.t = at
  }
  get currentTime() {
    return this.t
  }
  set currentTime(v: number) {
    // `loop`: reaching the end goes back to the start (worst case: also while paused)
    this.t = Number.isFinite(this.duration) && this.duration > 0 && v >= this.duration ? 0 : Math.max(0, v)
  }
  pause() {
    this.paused = true
  }
}

describe('End / Home on a looping player video', () => {
  it('End while playing pauses on the last frame (it used to restart the clip, acting like Home)', () => {
    const v = new LoopingVideo(6, true, 2.5)
    seekEdge(v, 'end')
    expect(v.paused).toBe(true)
    expect(v.currentTime).toBeCloseTo(6 - FRAME_S, 9)
    expect(v.currentTime).toBeGreaterThan(5.9)
  })
  it('End while paused also shows the last frame', () => {
    const v = new LoopingVideo(4, false, 1)
    seekEdge(v, 'end')
    expect(v.currentTime).toBeCloseTo(4 - FRAME_S, 9)
  })
  it('End with no length yet changes nothing', () => {
    const v = new LoopingVideo(Number.NaN, true, 1.5)
    seekEdge(v, 'end')
    expect(v.paused).toBe(false)
    expect(v.currentTime).toBe(1.5)
  })
  it('Home goes to 0 and keeps playing', () => {
    const v = new LoopingVideo(6, true, 4)
    seekEdge(v, 'start')
    expect(v.currentTime).toBe(0)
    expect(v.paused).toBe(false)
  })
})

describe('frame steps on a looping player video', () => {
  it('→ / Shift+→ at the end stay on the last frame', () => {
    const v = new LoopingVideo(5, true, 5 - FRAME_S / 2)
    stepFrames(v, 1)
    expect(v.paused).toBe(true)
    expect(v.currentTime).toBeCloseTo(5 - FRAME_S, 9)
    stepFrames(v, 5)
    expect(v.currentTime).toBeCloseTo(5 - FRAME_S, 9)
  })
  it('← steps back one frame, paused', () => {
    const v = new LoopingVideo(5, true, 2)
    stepFrames(v, -1)
    expect(v.paused).toBe(true)
    expect(v.currentTime).toBeCloseTo(2 - FRAME_S, 9)
  })
})
