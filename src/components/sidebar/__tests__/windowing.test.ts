import { describe, expect, it } from 'vitest'
import { listKeyIndex, rowScrollTop, windowedRows } from '../windowing'

describe('take list windowing', () => {
  it('renders the viewport plus six rows on each side, even with 1,200 takes', () => {
    expect(windowedRows(1200, 48, 4800, 480)).toEqual(Array.from({ length: 22 }, (_, i) => 94 + i))
    expect(windowedRows(1200, 48, 0, 480)).toEqual(Array.from({ length: 16 }, (_, i) => i))
    expect(windowedRows(1200, 48, 1190 * 48, 480)).toEqual(Array.from({ length: 16 }, (_, i) => 1184 + i))
  })

  it('keeps just the focused row and native drag source mounted outside the viewport, in DOM order', () => {
    const rows = windowedRows(1200, 48, 4800, 480, [1, 1199, 100, 1, -1, 1200])
    expect(rows).toEqual([1, ...Array.from({ length: 22 }, (_, i) => 94 + i), 1199])
    expect(windowedRows(1200, 48, 4800, 480)).not.toContain(1)
  })

  it('handles partial rows, empty/collapsed lists and a filter applied at the old bottom', () => {
    expect(windowedRows(1200, 48, 4801, 480)).toHaveLength(23)
    expect(windowedRows(0, 48, 50000, 480, [0, 100])).toEqual([])
    expect(windowedRows(3, 48, 50000, 480)).toEqual([0, 1, 2])
    expect(windowedRows(1200, 48, 0, 0)).toHaveLength(6)
    expect(windowedRows(3, 48, -20, 480)).toEqual([0, 1, 2])
  })

  it('navigates beyond mounted rows, clamps at either end, and leaves other keys alone', () => {
    expect(listKeyIndex('ArrowDown', 105, 1200, 10)).toBe(106)
    expect(listKeyIndex('ArrowUp', 105, 1200, 10)).toBe(104)
    expect(listKeyIndex('Home', 105, 1200, 10)).toBe(0)
    expect(listKeyIndex('End', 105, 1200, 10)).toBe(1199)
    expect(listKeyIndex('PageDown', 105, 1200, 10)).toBe(115)
    expect(listKeyIndex('PageUp', 105, 1200, 10)).toBe(95)
    expect(listKeyIndex('ArrowUp', 0, 1200, 10)).toBe(0)
    expect(listKeyIndex('PageDown', 1198, 1200, 10)).toBe(1199)
    expect(listKeyIndex('PageDown', 0, 2, 0)).toBe(1)
    expect(listKeyIndex('End', 0, 0, 10)).toBe(-1)
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 'Process', 'Delete', 'a']) expect(listKeyIndex(key, 10, 1200, 10)).toBeNull()
  })

  it('scrolls only enough to reveal a keyboard target, including Home/End after filtering', () => {
    expect(rowScrollTop(102, 1200, 48, 4800, 480)).toBe(4800)
    expect(rowScrollTop(90, 1200, 48, 4800, 480)).toBe(4320)
    expect(rowScrollTop(110, 1200, 48, 4800, 480)).toBe(4848)
    expect(rowScrollTop(1199, 1200, 48, 0, 480)).toBe(57120)
    expect(rowScrollTop(0, 1200, 48, 4800, 480)).toBe(0)
    expect(rowScrollTop(2, 3, 48, 50000, 480)).toBe(0)
  })
})
