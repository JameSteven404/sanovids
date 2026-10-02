import { describe, expect, it } from 'vitest'
import { fitPanelWidths } from '../panelFit'

const limits = { left: { min: 200 }, right: { min: 300 } }
const fit = (total: number, left: number | null, right: number | null) => fitPanelWidths(total, left, right, limits, 360)

describe('fitPanelWidths', () => {
  it('keeps widths that fit', () => {
    expect(fit(1920, 520, 680)).toEqual({ left: 520, right: 680 })
    expect(fit(1100, 272, 392)).toEqual({ left: 272, right: 392 })
  })

  it('shrinks the wider panel first, then both, keeping the center at its minimum', () => {
    // 520 + 680 + 360 = 1560 > 1100: 460 px too wide.
    const r = fit(1100, 520, 680)
    expect(r.left! + r.right! + 360).toBe(1100)
    // The right panel gave 160 (680 → 520), then both 150.
    expect(r).toEqual({ left: 370, right: 370 })
  })

  it('never goes below a panel minimum; the other panel takes the rest', () => {
    const r = fit(900, 520, 680)
    // 900 - 360 = 540 for both: right is held at 300, left at 240.
    expect(r.right).toBeGreaterThanOrEqual(300)
    expect(r.left).toBeGreaterThanOrEqual(200)
    expect(r.left! + r.right!).toBe(540)
  })

  it('stops at the minimums when even they do not fit', () => {
    expect(fit(700, 520, 680)).toEqual({ left: 200, right: 300 })
  })

  it('ignores a hidden panel', () => {
    expect(fit(900, null, 680)).toEqual({ left: null, right: 540 })
    expect(fit(900, 520, null)).toEqual({ left: 520, right: null })
    expect(fit(500, 520, null)).toEqual({ left: 200, right: null })
  })
})
