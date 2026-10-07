import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LEGACY_ROWS, type ArrangeResult } from '../../../core/arrange'
import { arrangeTitle, CHOSEN_NOTICE, placeBySide, previewBoxes } from '../arrangeModel'

describe('arrange presentation contract', () => {
  it('positions on every requested side, flips and clamps within the viewport', () => {
    const a = { left: 400, right: 430, top: 300, bottom: 330 }, s = { w: 200, h: 150 }, vp = { w: 1000, h: 800 }
    expect(placeBySide(a, s, 'up', vp)).toEqual({ x: 400, y: 140 })
    expect(placeBySide(a, s, 'down', vp)).toEqual({ x: 400, y: 340 })
    expect(placeBySide(a, s, 'left', vp)).toEqual({ x: 190, y: 300 })
    expect(placeBySide(a, s, 'right', vp)).toEqual({ x: 440, y: 300 })
    expect(placeBySide({ ...a, top: 0, bottom: 30 }, s, 'up', vp).y).toBe(40)
    expect(placeBySide({ ...a, left: 0, right: 30 }, s, 'left', vp).x).toBe(40)
    expect(placeBySide(a, s, 'up', { w: 210, h: 160 })).toEqual({ x: 8, y: 8 })
  })
  it('names the selected style and the global hidden-video effect', () => {
    expect(arrangeTitle(LEGACY_ROWS)).toBe('Sắp xếp lại: mỗi cảnh một hàng, video bên phải')
    expect(arrangeTitle({ ...LEGACY_ROWS, style: 'grid', gridCols: 4, video: 'chosen' })).toBe('Sắp xếp lại: lưới 4 cảnh mỗi hàng, chỉ take chọn')
    expect(CHOSEN_NOTICE).toContain('ở mọi dự án')
    expect(CHOSEN_NOTICE).toContain('dây vào Thư mục')
  })
  it('caps large previews at 1500 SVG elements', () => {
    const boxes = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), kind: 'scene' as const, x: i * 50, y: 0, w: 40, h: 30 }))
    const result = previewBoxes({ boxes } as ArrangeResult)
    expect(result.length).toBeLessThanOrEqual(1500)
    expect(result[0].x).toBe(0)
    expect(result.at(-1)!.x + result.at(-1)!.w).toBe(boxes.at(-1)!.x + 40)
  })
  it('keeps the dialog in a portal, swallows the entire outside click and traps keys', () => {
    const code = readFileSync(new URL('../ArrangePopover.tsx', import.meta.url), 'utf8')
    expect(code).toContain('document.body)')
    expect(code).toContain('role="dialog"')
    expect(code).toContain('trapTabWithin')
    expect(code).toContain('e.stopImmediatePropagation()')
    expect(code).toContain('e.preventDefault(); e.stopPropagation(); if (e.target === e.currentTarget) onClose()')
    // Close on click (not pointerdown), keeping the backdrop alive until the release/click cannot hit a wire.
    expect(code).not.toMatch(/onPointerDown=\{[^\n]*onClose/)
  })
})
