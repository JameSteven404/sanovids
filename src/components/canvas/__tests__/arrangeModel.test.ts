import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { LEGACY_ROWS, type ArrangeOptions, type ArrangeResult } from '../../../core/arrange'
import { useUI } from '../../../store/ui'
import {
  anchorRect, arrangeTitle, arrangeToast, backdropHandlers, CHOSEN_NOTICE, handlePopoverKey, hiddenFolderTakes, newVideoOverlap, placeBySide, popoverKeyAction,
  previewBoxes, previewCaption, scopeCounts, scopeLabel, scopeTotal, stripWarning,
} from '../arrangeModel'

const stats = (patch: Partial<ArrangeResult['stats']> = {}): ArrangeResult['stats'] => ({ moved: 1, takesBack: 0, takesFollow: 0, foldersMoved: 0, assetsMoved: 0, movedAway: false, ...patch })
const opts = (patch: Partial<ArrangeOptions> = {}): ArrangeOptions => ({ ...LEGACY_ROWS, ...patch })
const CHOSEN_ON = ' Đã bật “Chỉ take chọn” (mọi dự án): video khác và video đang tạo tạm ẩn.'

/** A DOM-less event: records what the handler did with it. */
function fakeEvent(patch: Record<string, unknown> = {}) {
  const e = {
    target: 'backdrop' as unknown, currentTarget: 'backdrop' as unknown, key: '', ctrlKey: false, metaKey: false,
    dataTransfer: { dropEffect: 'copy' }, defaultPrevented: false, stopped: false, stoppedNow: false,
    preventDefault() { e.defaultPrevented = true },
    stopPropagation() { e.stopped = true },
    stopImmediatePropagation() { e.stoppedNow = true; e.stopped = true },
    ...patch,
  }
  return e
}

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
  it('reads an element anchor again on every placement (the toolbar moves on resize), a fixed rectangle as is', () => {
    let left = 100
    const el = { getBoundingClientRect: () => ({ left, right: left + 18, top: 700, bottom: 730 }) }
    expect(anchorRect(el).left).toBe(100)
    left = 340
    expect(anchorRect(el).left).toBe(340)
    const rect = { left: 1, right: 2, top: 3, bottom: 4 }
    expect(anchorRect(rect)).toBe(rect)
  })
  it('names the selected style and the global hidden-video effect', () => {
    expect(arrangeTitle(LEGACY_ROWS)).toBe('Sắp xếp lại: mỗi cảnh một hàng, video bên phải')
    expect(arrangeTitle({ ...LEGACY_ROWS, style: 'grid', gridCols: 4, video: 'chosen' })).toBe('Sắp xếp lại: lưới 4 cảnh mỗi hàng, chỉ take chọn')
    expect(arrangeTitle({ ...LEGACY_ROWS, style: 'grid', video: 'chosen' })).toBe('Sắp xếp lại: lưới tự động, chỉ take chọn')
    expect(arrangeTitle({ ...LEGACY_ROWS, style: 'strip' })).toBe('Sắp xếp lại: mọi cảnh trên một dải ngang')
    expect(CHOSEN_NOTICE).toBe('Video khác, video đang tạo và dây vào Thư mục của chúng tạm ẩn, ở mọi dự án. Mở “Hiển thị” (biểu tượng mắt) trên thanh công cụ › Video › Tất cả để hiện lại — khi đó nên Sắp xếp lại.')
  })
  it('toasts the exact sentences of the plan (§3.9)', () => {
    expect(arrangeToast({ cols: 1, stats: stats({ takesBack: 3 }) }, opts(), false)).toBe('Đã sắp xếp lại canvas (3 video về cạnh cảnh của nó).')
    expect(arrangeToast({ cols: 1, stats: stats() }, opts(), false)).toBe('Đã sắp xếp lại canvas.')
    expect(arrangeToast({ cols: 4, stats: stats({ takesBack: 2 }) }, opts({ style: 'grid' }), true))
      .toBe(`Đã xếp canvas thành lưới 4 cột (2 video về cạnh cảnh của nó).${CHOSEN_ON}`)
    expect(arrangeToast({ cols: 9, stats: stats() }, opts({ style: 'strip' }), true)).toBe(`Đã xếp các cảnh thành một dải ngang.${CHOSEN_ON}`)
    expect(arrangeToast({ cols: 1, stats: stats({ takesBack: 1, takesFollow: 2 }) }, opts(), false))
      .toBe('Đã sắp xếp lại canvas (1 video về cạnh cảnh của nó, 2 video đi theo cảnh của nó).')
    expect(arrangeToast({ cols: 1, stats: stats({ foldersMoved: 2, assetsMoved: 1 }) }, opts(), false))
      .toBe('Đã sắp xếp lại canvas. 2 thư mục bị đè đã lên hàng phía trên. 1 thẻ nhân vật bị đè đã vào cột bên trái.')
    // "Hàng phía trên cảnh" lifts every folder: none of them was necessarily covered.
    expect(arrangeToast({ cols: 1, stats: stats({ foldersMoved: 2 }) }, opts({ folders: 'top' }), false)).toBe('Đã sắp xếp lại canvas. 2 thư mục đã lên hàng phía trên.')
    expect(arrangeToast({ cols: 3, stats: stats({ movedAway: true }) }, opts({ style: 'grid', scope: 'selection' }), false, '3 cảnh · 1 nhân vật'))
      .toBe('Đã sắp xếp 3 cảnh · 1 nhân vật đang chọn. Chỗ cũ không đủ, đã đặt sang chỗ trống bên phải.')
    expect(newVideoOverlap(5)).toBe('Video mới của S05 đè lên cảnh bên cạnh.')
    expect(stripWarning(12)).toBe('')
    expect(stripWarning(13)).toBe('Với 13 cảnh, dải sẽ rất dài — nên dùng Lưới.')
    expect(previewCaption({ fitZoom: 0.348, stats: stats({ takesBack: 12 }) })).toBe('Vừa màn hình ở khoảng 35% · 12 video về cạnh cảnh')
    expect(previewCaption({ fitZoom: 1, stats: stats() })).toBe('Vừa màn hình ở khoảng 100%')
  })
  it('counts the selected cards a selection arrange moves, by kind ("3 cảnh · 1 nhân vật · 1 thư mục")', () => {
    const input = {
      clusters: [{ inScope: true }, { inScope: true }, { inScope: true }, { inScope: false }],
      assets: [{ kind: 'character', inScope: true }, { kind: 'location', inScope: true }, { kind: 'location', inScope: true }, { kind: 'prop', inScope: false }],
      folders: [{ inScope: true }],
    } as unknown as Parameters<typeof scopeCounts>[0]
    const c = scopeCounts(input, 'column')
    expect(scopeLabel(c)).toBe('3 cảnh · 1 nhân vật · 2 bối cảnh · 1 thư mục')
    expect(scopeTotal(c)).toBe(7)
    // Images left in place do not move: not counted.
    const kept = scopeCounts(input, 'keep')
    expect(scopeLabel(kept)).toBe('3 cảnh · 1 thư mục')
    expect(scopeTotal(kept)).toBe(4)
  })
  it('counts the folder-linked videos the compact display hides, once each', () => {
    const takes = [{ id: 'a', shown: true }, { id: 'b', shown: false }, { id: 'c', shown: false }]
    expect(hiddenFolderTakes([{ takes: ['a', 'b'] }, { takes: ['b', 'c', 'x'] }, {}], takes)).toBe(2)
    expect(hiddenFolderTakes([{ takes: ['a'] }], takes)).toBe(0)
  })
  it('caps large previews at 1500 SVG elements', () => {
    const boxes = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), kind: 'scene' as const, x: i * 50, y: 0, w: 40, h: 30 }))
    const result = previewBoxes({ boxes } as ArrangeResult)
    expect(result.length).toBeLessThanOrEqual(1500)
    expect(result[0].x).toBe(0)
    expect(result.at(-1)!.x + result.at(-1)!.w).toBe(boxes.at(-1)!.x + 40)
  })
})

describe('arrange popover: nothing reaches the canvas', () => {
  it('a press on the backdrop stops there and closes nothing yet; the click that follows closes the popover', () => {
    const onClose = vi.fn(), h = backdropHandlers(onClose)
    const down = fakeEvent()
    h.onPointerDown(down)
    expect(down.stopped).toBe(true)
    expect(down.defaultPrevented).toBe(true)
    // Still open at the release: the backdrop, not a wire under it, receives the click.
    expect(onClose).not.toHaveBeenCalled()
    const click = fakeEvent()
    h.onClick(click)
    expect(click.stopped && click.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('presses and clicks inside the popover keep their default and never close it', () => {
    const onClose = vi.fn(), h = backdropHandlers(onClose)
    const down = fakeEvent({ target: 'select' })
    h.onPointerDown(down)
    expect(down.stopped).toBe(true)
    expect(down.defaultPrevented).toBe(false)
    h.onClick(fakeEvent({ target: 'button' }))
    expect(onClose).not.toHaveBeenCalled()
  })
  it('refuses files, images and videos dropped over it and keeps the wheel from scrolling the toolbar', () => {
    const h = backdropHandlers(vi.fn())
    for (const handler of [h.onDragEnter, h.onDragOver]) {
      const e = fakeEvent()
      handler(e)
      expect(e.stopped).toBe(true)
      expect(e.defaultPrevented).toBe(true)
      expect(e.dataTransfer.dropEffect).toBe('none')
    }
    const drop = fakeEvent()
    h.onDrop(drop)
    expect(drop.stopped && drop.defaultPrevented).toBe(true)
    const wheel = fakeEvent()
    h.onWheel(wheel)
    expect(wheel.stopped).toBe(true)
    expect(wheel.defaultPrevented).toBe(false)
    const menu = fakeEvent()
    h.onContextMenu(menu)
    expect(menu.stopped && menu.defaultPrevented).toBe(true)
  })
  it('decides every key: save passes, Escape closes, keys inside stay inside, the rest are swallowed', () => {
    const out = { inside: false, otherOverlay: false }
    expect(popoverKeyAction({ key: 's', ctrlKey: true }, out)).toBe('pass')
    expect(popoverKeyAction({ key: 'S', metaKey: true }, out)).toBe('pass')
    expect(popoverKeyAction({ key: 'Escape' }, out)).toBe('close')
    expect(popoverKeyAction({ key: 'Escape' }, { ...out, inside: true })).toBe('close')
    for (const key of ['Delete', 'Backspace', 'n', '1', 'z', 'Enter']) expect(popoverKeyAction({ key }, out)).toBe('swallow')
    expect(popoverKeyAction({ key: 'z', ctrlKey: true }, out)).toBe('swallow')
    expect(popoverKeyAction({ key: 'ArrowDown' }, { ...out, inside: true })).toBe('own')
    // A dialog, confirm / dev sheet or image viewer opened over it owns the keyboard, Escape included.
    expect(popoverKeyAction({ key: 'Escape' }, { inside: false, otherOverlay: true })).toBe('pass')
    expect(popoverKeyAction({ key: 'Delete' }, { inside: false, otherOverlay: true })).toBe('pass')
  })
  it('Escape closes the popover and keeps the selection; Delete / N / 1 outside it never reach the shortcuts', () => {
    useUI.setState({ selectedIds: ['scene-1'] })
    // The global shortcuts (hooks/useShortcuts) listen later on the same window and skip handled events.
    const shortcuts = vi.fn((e: ReturnType<typeof fakeEvent>) => {
      if (e.stoppedNow || e.defaultPrevented) return
      if (e.key === 'Escape') useUI.getState().clearSelection()
    })
    const close = vi.fn(), focus = vi.fn()
    const ctx = { inside: () => false, otherOverlay: () => false, close, focus }
    const esc = fakeEvent({ key: 'Escape', target: 'body' })
    expect(handlePopoverKey(esc, ctx)).toBe('close')
    shortcuts(esc)
    expect(close).toHaveBeenCalledTimes(1)
    expect(esc.defaultPrevented && esc.stoppedNow).toBe(true)
    expect(useUI.getState().selectedIds).toEqual(['scene-1'])
    for (const key of ['Delete', 'n', '1']) {
      const e = fakeEvent({ key, target: 'body' })
      expect(handlePopoverKey(e, ctx)).toBe('swallow')
      expect(e.defaultPrevented && e.stoppedNow).toBe(true)
    }
    expect(focus).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledTimes(1)
    // Inside the popover its own onKeyDown handles (and stops) the key; with another overlay up nothing is touched.
    const inside = fakeEvent({ key: 'ArrowRight' })
    expect(handlePopoverKey(inside, { ...ctx, inside: () => true })).toBe('own')
    expect(inside.defaultPrevented || inside.stopped).toBe(false)
    const sheet = fakeEvent({ key: 'Escape' })
    expect(handlePopoverKey(sheet, { ...ctx, otherOverlay: () => true })).toBe('pass')
    expect(sheet.defaultPrevented || sheet.stopped).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('the popover is portaled, wires every backdrop handler and sits below sheets and toasts', () => {
    const code = readFileSync(new URL('../ArrangePopover.tsx', import.meta.url), 'utf8')
    expect(code).toContain('document.body)')
    expect(code).toContain('{...handlers}')
    expect(code).toContain('handlePopoverKey(e, ctx)')
    const css = readFileSync(new URL('../arrange.css', import.meta.url), 'utf8')
    const z = Number(/\.cv-ar-backdrop \{[^}]*z-index: (\d+)/.exec(css)?.[1])
    // Dialogs 100 < popover < confirm sheet 140, dev sheet / image viewer 150, toasts 200 (common.css, dev.css).
    expect(z).toBeGreaterThan(100)
    expect(z).toBeLessThan(140)
  })
})
