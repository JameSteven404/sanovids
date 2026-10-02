// Pure helpers of the canvas take player (TakePlayer.tsx): clock text, speed cycling and label, pointer → fraction,
// volume steps (and the level to restore after them) and wheel stepping. No React, no DOM: unit-tested in __tests__/playerModel.test.ts.
import { PLAYBACK_RATES } from '../../lib/playback'

/** Seconds → "0:05", "1:02", "1:02:03" (floored; negative → 0; NaN / ∞ → "0:00"). */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/**
 * A clip's length → "0:03" for 2.993 s: rounded, not floored, so a clip encoded a hair short (4.96 s for a "5s"
 * scene) does not read a second too short. Use the same rounding for the timeline's aria-valuemax.
 */
export function formatLength(seconds: number): string {
  return formatClock(Math.round(seconds))
}

/**
 * The next (dir = +1) or previous (dir = -1) speed of PLAYBACK_RATES, wrapping around (2× → 0,5×). A speed that is
 * not in the list moves to the nearest listed one in that direction.
 */
export function nextRate(rate: number, dir: 1 | -1 = 1): number {
  const list = PLAYBACK_RATES as readonly number[]
  const i = list.indexOf(rate)
  if (i >= 0) return list[(i + dir + list.length) % list.length]
  if (dir > 0) return list.find((r) => r > rate) ?? list[0]
  return [...list].reverse().find((r) => r < rate) ?? list[list.length - 1]
}

/** 1.25 → "1,25×", 0.5 → "0,5×", 1 → "1×" (Vietnamese decimal comma). */
export function rateLabel(rate: number): string {
  const n = Number.isFinite(rate) ? Math.round(rate * 100) / 100 : 1
  return `${String(n).replace('.', ',')}×`
}

/** Where `clientX` falls across `rect` (0 = left edge, 1 = right edge), clamped. Works under any canvas zoom. */
export function fractionAt(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0) || !Number.isFinite(clientX)) return 0
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
}

/** `v` + `delta`, clamped to 0..1 and rounded to 0.05 (keyboard / wheel steps land on clean values). */
export function stepVolume(v: number, delta: number): number {
  const base = Number.isFinite(v) ? v : 1
  const next = Math.round((base + (Number.isFinite(delta) ? delta : 0)) * 20) / 20
  return Math.min(1, Math.max(0, next))
}

/** Quiet time (ms) that ends a burst of wheel / arrow-key volume steps. */
export const VOLUME_BURST_MS = 500

/**
 * The level the speaker button restores after the volume reached 0 is the one the volume gesture STARTED from: a
 * burst of wheel / key steps that ends at 0 passes through 5 %, 10 %… which are not the user's level. Call before
 * each step with the current level and when the previous step was: a step after VOLUME_BURST_MS of quiet starts a
 * new gesture and remembers `current` (when audible); a step inside a burst keeps what was remembered.
 */
export function rememberedVolume(remembered: number, current: number, now: number, lastStepAt: number): number {
  return now - lastStepAt > VOLUME_BURST_MS && current > 0 ? current : remembered
}

/** Which speaker glyph to show: muted / silent, low (< 50 %) or loud. */
export function volumeLevel(volume: number, audible: boolean): 'off' | 'low' | 'high' {
  if (!audible || !(volume > 0)) return 'off'
  return volume < 0.5 ? 'low' : 'high'
}

/** One wheel notch (or this much trackpad travel, px) = one step. */
export const WHEEL_STEP_PX = 50

/**
 * Turn wheel deltas into whole steps: a mouse notch (|deltaY| ≥ 50 px, or line / page mode) is one step; small
 * trackpad deltas add up in `acc` until they reach a notch. step = +1 for wheel up / away (more), -1 for down.
 */
export function wheelStep(acc: number, deltaY: number, deltaMode = 0): { step: -1 | 0 | 1; acc: number } {
  const d = deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 800 : deltaY
  if (!Number.isFinite(d) || d === 0) return { step: 0, acc }
  // A change of direction drops what was collected the other way.
  const total = Math.sign(acc) === Math.sign(d) ? acc + d : d
  if (Math.abs(total) < WHEEL_STEP_PX) return { step: 0, acc: total }
  return { step: total < 0 ? 1 : -1, acc: 0 }
}

/** Seconds a keyboard arrow moves the timeline (Shift: a bigger jump). */
export function seekStep(shift: boolean): number {
  return shift ? 5 : 1
}
