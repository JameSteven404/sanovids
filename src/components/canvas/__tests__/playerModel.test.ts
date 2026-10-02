import { describe, expect, it } from 'vitest'
import { PLAYBACK_RATES } from '../../../lib/playback'
import {
  formatClock,
  formatLength,
  fractionAt,
  nextRate,
  rateLabel,
  rememberedVolume,
  seekStep,
  stepVolume,
  volumeLevel,
  VOLUME_BURST_MS,
  wheelStep,
  WHEEL_STEP_PX,
} from '../playerModel'

describe('formatClock', () => {
  it('shows m:ss under an hour and h:mm:ss above', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(5)).toBe('0:05')
    expect(formatClock(5.99)).toBe('0:05')
    expect(formatClock(62)).toBe('1:02')
    expect(formatClock(600)).toBe('10:00')
    expect(formatClock(3723)).toBe('1:02:03')
    expect(formatClock(36000)).toBe('10:00:00')
  })
  it('unknown or negative lengths read 0:00', () => {
    expect(formatClock(Number.NaN)).toBe('0:00')
    expect(formatClock(Infinity)).toBe('0:00')
    expect(formatClock(-Infinity)).toBe('0:00')
    expect(formatClock(-3)).toBe('0:00')
  })
})

describe('formatLength', () => {
  it('rounds the clip length: a clip encoded a hair short keeps its second', () => {
    expect(formatLength(2.993)).toBe('0:03')
    expect(formatLength(4.96)).toBe('0:05')
    expect(formatLength(5.04)).toBe('0:05')
    expect(formatLength(5)).toBe('0:05')
    expect(formatLength(59.6)).toBe('1:00')
    expect(formatLength(3599.7)).toBe('1:00:00')
  })
  it('unknown lengths read 0:00', () => {
    expect(formatLength(0)).toBe('0:00')
    expect(formatLength(Number.NaN)).toBe('0:00')
    expect(formatLength(Infinity)).toBe('0:00')
  })
})

describe('nextRate', () => {
  it('cycles forward through the speeds and wraps around', () => {
    expect(nextRate(1)).toBe(1.25)
    expect(nextRate(1.25, 1)).toBe(1.5)
    expect(nextRate(2)).toBe(0.5)
    const seen = [1]
    for (let i = 0; i < PLAYBACK_RATES.length; i++) seen.push(nextRate(seen[seen.length - 1]))
    expect(seen[seen.length - 1]).toBe(1)
    expect(new Set(seen.slice(0, -1)).size).toBe(PLAYBACK_RATES.length)
  })
  it('cycles backward', () => {
    expect(nextRate(1, -1)).toBe(0.75)
    expect(nextRate(0.5, -1)).toBe(2)
  })
  it('a speed outside the list moves to the nearest listed one in that direction', () => {
    expect(nextRate(1.75)).toBe(2)
    expect(nextRate(1.75, -1)).toBe(1.5)
    expect(nextRate(3)).toBe(0.5)
    expect(nextRate(0.25, -1)).toBe(2)
    expect(nextRate(0.25)).toBe(0.5)
  })
})

describe('rateLabel', () => {
  it('uses the Vietnamese decimal comma', () => {
    expect(rateLabel(1)).toBe('1×')
    expect(rateLabel(1.25)).toBe('1,25×')
    expect(rateLabel(0.5)).toBe('0,5×')
    expect(rateLabel(0.75)).toBe('0,75×')
    expect(rateLabel(2)).toBe('2×')
  })
  it('never shows NaN', () => {
    expect(rateLabel(Number.NaN)).toBe('1×')
  })
})

describe('fractionAt', () => {
  const rect = { left: 100, width: 200 }
  it('maps the pointer across the bar (screen pixels, so any canvas zoom works)', () => {
    expect(fractionAt(100, rect)).toBe(0)
    expect(fractionAt(200, rect)).toBe(0.5)
    expect(fractionAt(300, rect)).toBe(1)
  })
  it('clamps outside the bar (dragging past the ends)', () => {
    expect(fractionAt(20, rect)).toBe(0)
    expect(fractionAt(999, rect)).toBe(1)
  })
  it('a collapsed bar or a bad pointer gives 0', () => {
    expect(fractionAt(150, { left: 100, width: 0 })).toBe(0)
    expect(fractionAt(Number.NaN, rect)).toBe(0)
  })
})

describe('stepVolume', () => {
  it('steps and rounds to 0.05', () => {
    expect(stepVolume(0.5, 0.05)).toBe(0.55)
    expect(stepVolume(0.5, -0.05)).toBe(0.45)
    expect(stepVolume(0.62, 0.05)).toBe(0.65)
    expect(stepVolume(0.95, 0.05)).toBe(1)
  })
  it('clamps to 0..1', () => {
    expect(stepVolume(1, 0.05)).toBe(1)
    expect(stepVolume(0.02, -0.05)).toBe(0)
    expect(stepVolume(0, -0.05)).toBe(0)
  })
  it('bad input falls back to full volume / no change', () => {
    expect(stepVolume(Number.NaN, -0.05)).toBe(0.95)
    expect(stepVolume(0.4, Number.NaN)).toBe(0.4)
  })
})

describe('rememberedVolume', () => {
  /** A burst of wheel / key steps every `gap` ms from `start` down to 0: what is remembered at the end. */
  function burstDown(start: number, gap: number, remembered = 1) {
    let v = start
    let at = -Infinity
    let now = 10_000
    while (v > 0) {
      remembered = rememberedVolume(remembered, v, now, at)
      at = now
      now += gap
      v = stepVolume(v, -0.05)
    }
    return remembered
  }
  it('a burst that ends at 0 remembers where it started, not the 5 % it passed through', () => {
    expect(burstDown(0.6, 40)).toBe(0.6)
    expect(burstDown(1, 120)).toBe(1)
  })
  it('a pause longer than a burst starts a new gesture from the current level', () => {
    expect(rememberedVolume(0.8, 0.3, 10_000, 10_000 - VOLUME_BURST_MS - 1)).toBe(0.3)
    expect(rememberedVolume(0.8, 0.3, 10_000, 10_000 - VOLUME_BURST_MS + 1)).toBe(0.8)
    // The very first step (no step before).
    expect(rememberedVolume(1, 0.45, 5, -Infinity)).toBe(0.45)
  })
  it('a gesture that starts at 0 keeps what was remembered', () => {
    expect(rememberedVolume(0.7, 0, 10_000, -Infinity)).toBe(0.7)
  })
})

describe('volumeLevel', () => {
  it('picks the speaker glyph', () => {
    expect(volumeLevel(1, true)).toBe('high')
    expect(volumeLevel(0.5, true)).toBe('high')
    expect(volumeLevel(0.3, true)).toBe('low')
    expect(volumeLevel(0, true)).toBe('off')
    expect(volumeLevel(1, false)).toBe('off')
  })
})

describe('wheelStep', () => {
  it('a mouse notch is one step: up = more, down = less', () => {
    expect(wheelStep(0, -100)).toEqual({ step: 1, acc: 0 })
    expect(wheelStep(0, 120)).toEqual({ step: -1, acc: 0 })
    expect(wheelStep(0, 3, 1)).toEqual({ step: -1, acc: 0 })
  })
  it('small trackpad deltas add up to a step', () => {
    let r = wheelStep(0, -20)
    expect(r.step).toBe(0)
    r = wheelStep(r.acc, -20)
    expect(r.step).toBe(0)
    r = wheelStep(r.acc, -20)
    expect(r).toEqual({ step: 1, acc: 0 })
  })
  it('a change of direction drops what was collected', () => {
    const r = wheelStep(-40, 20)
    expect(r).toEqual({ step: 0, acc: 20 })
    expect(wheelStep(0, 0)).toEqual({ step: 0, acc: 0 })
    expect(WHEEL_STEP_PX).toBeGreaterThan(0)
  })
})

describe('seekStep', () => {
  it('arrows move 1 s, 5 s with Shift', () => {
    expect(seekStep(false)).toBe(1)
    expect(seekStep(true)).toBe(5)
  })
})
