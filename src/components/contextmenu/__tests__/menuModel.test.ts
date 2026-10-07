import { describe, expect, it } from 'vitest'
import {
  capRows,
  contextSelection,
  countsText,
  edgeIndex,
  firstIndex,
  foldLabel,
  isMacSecondaryPress,
  isMenuKey,
  itemCount,
  menuKeyAction,
  nextIndex,
  placeAtAnchor,
  placeMenu,
  placeSubmenu,
  SEP,
  tidyEntries,
  typeAhead,
  type MenuEntry,
  type MenuItem,
} from '../menuModel'

const item = (id: string, label = id, extra: Partial<MenuItem> = {}): MenuItem => ({ type: 'item', id, label, ...extra })

describe('menu entries', () => {
  it('tidyEntries drops leading, trailing and doubled separators', () => {
    const e = tidyEntries([SEP, item('a'), SEP, SEP, item('b'), SEP])
    expect(e.map((x) => x.type)).toEqual(['item', 'separator', 'item'])
    expect(itemCount(e)).toBe(2)
  })

  it('roving focus skips separators and labels, keeps disabled items, wraps around', () => {
    const e: MenuEntry[] = [item('a'), SEP, { type: 'label', text: 'x' }, item('b', 'b', { disabled: 'lý do' }), item('c')]
    expect(nextIndex(e, 0, 1)).toBe(3)
    expect(nextIndex(e, 3, 1)).toBe(4)
    expect(nextIndex(e, 4, 1)).toBe(0)
    expect(nextIndex(e, 0, -1)).toBe(4)
    expect(edgeIndex(e, 'first')).toBe(0)
    expect(edgeIndex(e, 'last')).toBe(4)
  })

  it('never focuses a danger item first while another item exists', () => {
    expect(firstIndex([item('del', 'Xoá', { danger: true }), SEP, item('a')])).toBe(2)
    expect(firstIndex([SEP, item('del', 'Xoá', { danger: true })])).toBe(1)
    expect(firstIndex([SEP])).toBe(-1)
  })

  it('type-ahead ignores accents (đ → d), cycles on a repeated letter, matches longer prefixes', () => {
    const e: MenuEntry[] = [item('a', 'Chạy S01'), item('b', 'Đi tới S02'), item('c', 'Nhân bản'), item('d', 'Nối Elara'), item('e', 'Xoá cảnh', { danger: true })]
    expect(foldLabel('Đi tới Ảnh')).toBe('di toi anh')
    expect(typeAhead(e, 0, 'd')).toBe(1)
    expect(typeAhead(e, 0, 'n')).toBe(2)
    expect(typeAhead(e, 2, 'n')).toBe(3)
    expect(typeAhead(e, 2, 'nn')).toBe(3)
    expect(typeAhead(e, 3, 'nn')).toBe(2)
    expect(typeAhead(e, 0, 'noi')).toBe(3)
    expect(typeAhead(e, 0, 'xo')).toBe(4)
    expect(typeAhead(e, 0, 'z')).toBe(-1)
  })

  it('capRows keeps 10 rows and adds a "+k … khác" label', () => {
    const rows = Array.from({ length: 13 }, (_, i) => item(`r${i}`))
    const capped = capRows(rows, 'cảnh')
    expect(capped).toHaveLength(11)
    expect(capped[10]).toEqual({ type: 'label', text: '+3 cảnh khác' })
    expect(capRows(rows.slice(0, 4), 'cảnh')).toHaveLength(4)
  })

  it('countsText lists only the non-zero parts', () => {
    expect(countsText([[3, 'cảnh'], [0, 'ảnh'], [1, 'video']])).toBe('3 cảnh, 1 video')
  })
})

describe('placement', () => {
  const vp = { w: 1000, h: 800 }
  it('opens 2px right / below the pointer and moves up by the title height', () => {
    expect(placeMenu({ x: 100, y: 100 }, { w: 240, h: 200 }, vp)).toEqual({ left: 102, top: 102 })
    expect(placeMenu({ x: 100, y: 100 }, { w: 240, h: 200 }, vp, 24)).toEqual({ left: 102, top: 78 })
  })
  it('flips left / up at the window edges and stays 8px inside', () => {
    expect(placeMenu({ x: 900, y: 700 }, { w: 240, h: 200 }, vp)).toEqual({ left: 658, top: 498 })
    expect(placeMenu({ x: 2, y: 2 }, { w: 240, h: 200 }, vp, 24).top).toBe(8)
  })
  it('scrolls (maxHeight) when taller than the window', () => {
    expect(placeMenu({ x: 100, y: 400 }, { w: 240, h: 900 }, vp)).toEqual({ left: 102, top: 8, maxHeight: 784 })
  })
  it('keyboard opening goes below-left of the element (above when no room)', () => {
    expect(placeAtAnchor({ left: 300, top: 100, right: 600, bottom: 300 }, { w: 240, h: 200 }, vp)).toEqual({ left: 300, top: 302 })
    expect(placeAtAnchor({ left: 300, top: 500, right: 600, bottom: 700 }, { w: 240, h: 200 }, vp).top).toBe(298)
  })
  it('submenus open right of their row and flip left at the edge', () => {
    expect(placeSubmenu({ left: 100, top: 200, right: 340, bottom: 228 }, { w: 220, h: 150 }, vp)).toEqual({ left: 338, top: 194 })
    expect(placeSubmenu({ left: 700, top: 200, right: 940, bottom: 228 }, { w: 220, h: 150 }, vp).left).toBe(482)
  })
})

describe('keys while a menu is open', () => {
  it('moves, activates, opens / closes submenus, closes on Esc / Tab', () => {
    expect(menuKeyAction({ key: 'ArrowDown' })).toBe('next')
    expect(menuKeyAction({ key: 'ArrowUp' })).toBe('prev')
    expect(menuKeyAction({ key: 'Home' })).toBe('first')
    expect(menuKeyAction({ key: 'End' })).toBe('last')
    expect(menuKeyAction({ key: 'Enter' })).toBe('activate')
    expect(menuKeyAction({ key: ' ' })).toBe('activate')
    expect(menuKeyAction({ key: 'Enter' }, { onParent: true })).toBe('openSub')
    expect(menuKeyAction({ key: 'ArrowRight' }, { onParent: true })).toBe('openSub')
    expect(menuKeyAction({ key: 'ArrowLeft' }, { inSubmenu: true })).toBe('closeSub')
    expect(menuKeyAction({ key: 'Escape' }, { inSubmenu: true })).toBe('closeSub')
    expect(menuKeyAction({ key: 'Escape' })).toBe('close')
    expect(menuKeyAction({ key: 'Tab' })).toBe('tab')
  })
  it('swallows Delete, Ctrl+D, Ctrl+Enter and canvas letters never reach the page (letters type-ahead instead)', () => {
    expect(menuKeyAction({ key: 'Delete' })).toBe('swallow')
    expect(menuKeyAction({ key: 'd', ctrlKey: true })).toBe('swallow')
    expect(menuKeyAction({ key: 'Enter', ctrlKey: true })).toBe('swallow')
    expect(menuKeyAction({ key: 'F2' })).toBe('swallow')
    expect(menuKeyAction({ key: 'n' })).toBe('type')
    expect(menuKeyAction({ key: 'ô' })).toBe('type')
  })
  it('lets a "runs while typing" chord through (closing the menu), ignores IME and Unikey Backspace', () => {
    expect(menuKeyAction({ key: 's', ctrlKey: true }, { typingChord: true })).toBe('passClose')
    expect(menuKeyAction({ key: 'a', keyCode: 229 })).toBe('ignore')
    expect(menuKeyAction({ key: 'a', isComposing: true })).toBe('ignore')
    expect(menuKeyAction({ key: 'Backspace' })).toBe('ignore')
  })
  it('the Menu key and Shift+F10 (no Ctrl / Alt / Meta) open a menu', () => {
    expect(isMenuKey({ key: 'ContextMenu' })).toBe(true)
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true)
    expect(isMenuKey({ key: 'F10' })).toBe(false)
    expect(isMenuKey({ key: 'F10', shiftKey: true, ctrlKey: true })).toBe(false)
  })
})

describe('Mac secondary click', () => {
  it('⌃+click is a secondary press on a Mac only', () => {
    expect(isMacSecondaryPress({ button: 0, ctrlKey: true }, true)).toBe(true)
    expect(isMacSecondaryPress({ button: 0, ctrlKey: true }, false)).toBe(false)
    expect(isMacSecondaryPress({ button: 0, ctrlKey: false }, true)).toBe(false)
    expect(isMacSecondaryPress({ button: 0, ctrlKey: true, metaKey: true }, true)).toBe(false)
    expect(isMacSecondaryPress({ button: 2, ctrlKey: true }, true)).toBe(false)
  })
})

describe('right-click selection rule (plan 3.5)', () => {
  const sel = (kind: Parameters<typeof contextSelection>[0]['kind'], id: string | undefined, selectedIds: string[], selectedEdgeIds: string[] = ['save:t1->f1']) =>
    contextSelection({ kind, id, selectedIds, selectedEdgeIds })
  it('a scene / video outside the selection becomes the only selected card; wires dropped', () => {
    expect(sel('scene', 's2', ['s1'])).toEqual({ selectedIds: ['s2'], selectedEdgeIds: [], multi: false })
    expect(sel('take', 't1', [])).toEqual({ selectedIds: ['t1'], selectedEdgeIds: [], multi: false })
  })
  it('a card inside a selection of ≥ 2 keeps it: the several-cards menu', () => {
    const r = sel('scene', 's1', ['s1', 'a1'])
    expect(r.selectedIds).toEqual(['s1', 'a1'])
    expect(r.multi).toBe(true)
    expect(r.selectedEdgeIds).toEqual([])
  })
  it('the only selected card keeps the selection but drops the selected wires', () => {
    const before = ['s1']
    const r = sel('scene', 's1', before)
    expect(r.selectedIds).toBe(before)
    expect(r.selectedEdgeIds).toEqual([])
    expect(r.multi).toBe(false)
  })
  it('an image card / folder / thumbnail outside the selection keeps the selected scenes (quick unlink)', () => {
    expect(sel('asset', 'a1', ['s1', 's2']).selectedIds).toEqual(['s1', 's2'])
    expect(sel('asset', 'a1', ['s1', 's2']).multi).toBe(false)
    expect(sel('folder', 'f1', ['t1']).selectedIds).toEqual(['t1'])
    expect(sel('ref', undefined, ['s1']).selectedIds).toEqual(['s1'])
  })
  it('a wire or the empty canvas keeps both selections', () => {
    expect(sel('edge', undefined, ['s1'])).toEqual({ selectedIds: ['s1'], selectedEdgeIds: ['save:t1->f1'], multi: false })
    expect(sel('pane', undefined, ['s1']).selectedEdgeIds).toEqual(['save:t1->f1'])
  })
})
