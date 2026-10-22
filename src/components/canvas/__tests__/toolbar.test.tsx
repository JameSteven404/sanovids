import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveKeymap } from '../../../core/keymap'
import { useKeymap } from '../../../lib/keymapPrefs'
import { DEFAULT_SETTINGS } from '../../../lib/settings'
import { DEFAULT_TOOLBAR_PLACE, TOOLBAR_PREFS_KEY, parseToolbarPrefs, useToolbarPrefs, validateToolbarPlace, type ToolbarDock } from '../../../lib/toolbarPrefs'
import { ensureRovingStop, ToolbarButton, toolbarArrowKey } from '../ToolbarControls'
import { ArrangeToolbarSlot } from '../ArrangeToolbarSlot'
import {
  canScrollBy, canvasOnlyLabel, clampToolbar, DEFAULT_VIEW, fitToolbar, gripHelpText, minimapPosition, nudgeToolbar, placeToolbarPanel, snapToolbar,
  toggleCanvasOnly, TOOLBAR_ITEMS, toolbarGroups, toolbarLength, toolbarOrientation, toolbarRect, toolbarSide, toolbarTrayContents, traySummary, viewDiffers,
} from '../toolbarModel'
import type { KeyboardEvent } from 'react'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useKeymap.getState().resetAll() })

describe('device toolbar position', () => {
  it.each([null, '', '{', 'null', '[]', 'true', '"top"'])('falls back safely for %s', (raw) => {
    expect(parseToolbarPrefs(raw)).toEqual(DEFAULT_TOOLBAR_PLACE)
  })
  it('bounds fractions, ignores foreign fields and locks the dock axis', () => {
    expect(parseToolbarPrefs('{"dock":"left","x":0.8,"y":9,"project":"x"}')).toEqual({ dock: 'left', x: 0, y: 1 })
    expect(validateToolbarPlace({ dock: 'free', x: NaN, y: -3 })).toEqual({ dock: 'free', x: 0.5, y: 0 })
    expect(validateToolbarPlace({ dock: 'top', x: 0.8, y: 0.8 })).toEqual({ dock: 'top', x: 0.8, y: 0 })
    expect(validateToolbarPlace({ dock: 'unknown', x: Infinity })).toEqual(DEFAULT_TOOLBAR_PLACE)
  })
  it('stores only validated placement, and continues when storage is unavailable', () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { setItem })
    useToolbarPrefs.getState().setPlace({ dock: 'right', x: -3, y: 0.3 })
    expect(setItem).toHaveBeenCalledWith(TOOLBAR_PREFS_KEY, '{"dock":"right","x":1,"y":0.3}')
    setItem.mockImplementation(() => { throw Error('blocked') })
    expect(() => useToolbarPrefs.getState().setPlace(DEFAULT_TOOLBAR_PLACE)).not.toThrow()
    expect(useToolbarPrefs.getState().place).toEqual(DEFAULT_TOOLBAR_PLACE)
  })
})

describe('fit, clamp and docking', () => {
  const stage = { w: 1000, h: 700 }
  it.each(['bottom', 'top', 'left', 'right', 'free'] as ToolbarDock[])('fits %s after a resize without changing the saved preference', (dock) => {
    for (const size of [stage, { w: 320, h: 240 }, { w: 120, h: 80 }]) {
      const place = { dock, x: 0.9, y: 0.9 }
      const fit = fitToolbar(size, dock)
      const rect = toolbarRect({ ...place, dock: fit.dock }, size, fit.size)
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.w).toBeLessThanOrEqual(size.w)
      expect(rect.y + rect.h).toBeLessThanOrEqual(size.h)
      expect(fit.shown).toContain('run')
      expect(new Set([...fit.shown, ...fit.overflow]).size).toBe(TOOLBAR_ITEMS.length)
      expect(place).toEqual({ dock, x: 0.9, y: 0.9 })
    }
  })
  it('uses vertical side docks and a temporary bottom bar when the drawer leaves too little height', () => {
    expect(toolbarOrientation('left')).toBe('vertical')
    expect(toolbarOrientation('right')).toBe('vertical')
    expect(toolbarOrientation('free')).toBe('horizontal')
    expect(fitToolbar({ w: 500, h: 100 }, 'right')).toMatchObject({ dock: 'bottom', vertical: false })
  })
  it('clamps against every edge and centers an oversized bar as far as the stage allows', () => {
    expect(clampToolbar({ x: -10, y: 999 }, stage, { w: 300, h: 46 })).toEqual({ x: 12, y: 642 })
    expect(clampToolbar({ x: 999, y: -10 }, { w: 50, h: 20 }, { w: 80, h: 40 })).toEqual({ x: 0, y: 0 })
  })
  it.each([
    [{ x: 500, y: 10 }, 'top'], [{ x: 500, y: 690 }, 'bottom'],
    [{ x: 10, y: 350 }, 'left'], [{ x: 990, y: 350 }, 'right'], [{ x: 500, y: 350 }, 'free'],
    [{ x: 10, y: 10 }, 'top'],
  ] as const)('snaps %o to %s', (pointer, dock) => {
    expect(snapToolbar(pointer, { x: 10, y: 10 }, stage).dock).toBe(dock)
    expect(snapToolbar(pointer, { x: 10, y: 10 }, stage, true).dock).toBe('free')
  })
  it('supports keyboard movement, fast movement, explicit docks and reset', () => {
    const free = { dock: 'free' as const, x: 0.3, y: 0.4 }
    const fit = fitToolbar(stage, free.dock)
    const before = toolbarRect(free, stage, fit.size)
    const next = toolbarRect(nudgeToolbar(free, 'ArrowRight', stage), stage, fit.size)
    const fast = toolbarRect(nudgeToolbar(free, 'ArrowRight', stage, true), stage, fit.size)
    expect(next.x - before.x).toBeCloseTo(16)
    expect(fast.x - before.x).toBeCloseTo(64)
    expect(nudgeToolbar(free, 'ArrowLeft', stage, false, true)).toEqual({ dock: 'left', x: 0, y: 0.4 })
    expect(nudgeToolbar(free, 'Home', stage)).toEqual(DEFAULT_TOOLBAR_PLACE)
    expect(nudgeToolbar(DEFAULT_TOOLBAR_PLACE, 'ArrowLeft', stage).dock).toBe('bottom')
    expect(nudgeToolbar(DEFAULT_TOOLBAR_PLACE, 'ArrowUp', stage).dock).toBe('free')
    // Pushing into the docked edge keeps the dock (no silent "Đặt tự do" with the bar in the same spot).
    expect(nudgeToolbar(DEFAULT_TOOLBAR_PLACE, 'ArrowDown', stage)).toEqual(DEFAULT_TOOLBAR_PLACE)
    expect(nudgeToolbar(DEFAULT_TOOLBAR_PLACE, 'ArrowDown', stage, true)).toEqual(DEFAULT_TOOLBAR_PLACE)
    expect(nudgeToolbar({ dock: 'left', x: 0, y: 0.4 }, 'ArrowLeft', stage)).toEqual({ dock: 'left', x: 0, y: 0.4 })
    expect(nudgeToolbar({ dock: 'right', x: 1, y: 0.4 }, 'ArrowRight', stage)).toEqual({ dock: 'right', x: 1, y: 0.4 })
    expect(nudgeToolbar({ dock: 'top', x: 0.2, y: 0 }, 'ArrowUp', stage)).toEqual({ dock: 'top', x: 0.2, y: 0 })
    expect(nudgeToolbar({ dock: 'left', x: 0, y: 0.4 }, 'ArrowDown', stage).dock).toBe('left')
    const left = { dock: 'left' as const, x: 0, y: 0.5 }
    const fromLeft = toolbarRect(left, stage, fitToolbar(stage, 'left').size)
    const undocked = nudgeToolbar(left, 'ArrowRight', stage)
    const moved = toolbarRect(undocked, stage, fitToolbar(stage, undocked.dock).size)
    expect(moved.x - fromLeft.x).toBeCloseTo(16)
    expect(moved.y).toBeCloseTo(fromLeft.y)
  })
  it('opens trays into the canvas and clamps long panels', () => {
    const anchor = { x: 450, y: 600, w: 100, h: 46 }
    expect(toolbarSide('bottom', anchor, stage)).toBe('top')
    expect(toolbarSide('top', anchor, stage)).toBe('bottom')
    expect(toolbarSide('left', anchor, stage)).toBe('right')
    expect(toolbarSide('right', anchor, stage)).toBe('left')
    expect(placeToolbarPanel(anchor, { w: 300, h: 46 }, stage, 'top')).toEqual({ x: 350, y: 548 })
    const pos = placeToolbarPanel(anchor, { w: 950, h: 680 }, stage, 'right')
    expect(pos.x + 950).toBeLessThanOrEqual(stage.w)
    expect(pos.y + 680).toBeLessThanOrEqual(stage.h)
  })
  it('moves the minimap to another corner when either the bar or tray overlaps it', () => {
    expect(minimapPosition(stage, { w: 120, h: 80 }, [])).toEqual({ x: 868, y: 608 })
    expect(minimapPosition(stage, { w: 120, h: 80 }, [{ x: 800, y: 550, w: 180, h: 140 }])).toEqual({ x: 12, y: 608 })
  })
})

describe('selection tray projection', () => {
  const selection = { nodes: 0, scenes: 0, assets: 0, cuttableWires: 0 }
  it('stays hidden for no selection, one scene, one image, and noncuttable output wires', () => {
    expect(toolbarTrayContents(selection)).toEqual([])
    expect(toolbarTrayContents({ ...selection, nodes: 1, scenes: 1 })).toEqual([])
    expect(toolbarTrayContents({ ...selection, nodes: 1, assets: 1 })).toEqual([])
  })
  it('puts the link first and deletion last for two or more scenes', () => {
    expect(toolbarTrayContents({ ...selection, nodes: 2, scenes: 2 })).toEqual(['duplicate', 'delete'])
    expect(toolbarTrayContents({ ...selection, nodes: 3, scenes: 2, assets: 1 })).toEqual(['connect', 'duplicate', 'delete'])
  })
  it('appears for any two canvas items (the old "… bấm C để nối" cases included)', () => {
    // 1 scene + 1 image on the canvas: the most common connect case.
    const sceneImage = { ...selection, nodes: 2, scenes: 1, assets: 1 }
    expect(toolbarTrayContents(sceneImage)).toEqual(['connect', 'duplicate', 'delete'])
    expect(traySummary(sceneImage)).toBe('2 mục · 1 ảnh + 1 cảnh')
    // 2 images, 1 scene + 1 video, 2 videos: nothing to link; duplicate only with a scene; deletion stays.
    expect(toolbarTrayContents({ ...selection, nodes: 2, assets: 2 })).toEqual(['delete'])
    expect(toolbarTrayContents({ ...selection, nodes: 2, scenes: 1 })).toEqual(['duplicate', 'delete'])
    expect(toolbarTrayContents({ ...selection, nodes: 2 })).toEqual(['delete'])
    expect(traySummary({ ...selection, nodes: 2 })).toBe('2 mục')
  })
  it('announces images picked in Thư viện for one selected scene (the only sign they will be linked)', () => {
    const library = { ...selection, nodes: 1, scenes: 1, assets: 3, fromLibrary: true }
    expect(toolbarTrayContents(library)).toEqual(['connect'])
    expect(traySummary(library)).toBe('3 ảnh trong Thư viện + 1 cảnh')
    expect(traySummary({ ...library, nodes: 2, scenes: 2 })).toBe('2 mục · 3 ảnh trong Thư viện + 2 cảnh')
    // A selected video drops the library selection (pickAssetSelection gives 0 images): no connect.
    expect(toolbarTrayContents({ ...selection, nodes: 2, scenes: 1, assets: 0 })).not.toContain('connect')
  })
  it('one video: no tray — its own action bar above the node (NodeActionBar); several items still get the tray', () => {
    expect(toolbarTrayContents({ ...selection, nodes: 1 })).toEqual([])
    expect(toolbarTrayContents({ ...selection, nodes: 2 })).toEqual(['delete'])
  })
  it('cuts wires only when no nodes are selected', () => {
    expect(toolbarTrayContents({ ...selection, cuttableWires: 3 })).toEqual(['cut'])
    expect(traySummary({ ...selection, cuttableWires: 3 })).toBe('3 dây')
    expect(toolbarTrayContents({ ...selection, nodes: 1, scenes: 1, cuttableWires: 3 })).toEqual([])
  })
})

describe('bar layout (mockup A)', () => {
  it('groups the slots with dividers and stays about 430 px wide', () => {
    expect(toolbarGroups(TOOLBAR_ITEMS)).toEqual([['new', 'add', 'run'], ['arrange', 'fit'], ['mouse', 'view'], ['zoom']])
    expect(toolbarLength(TOOLBAR_ITEMS, false)).toBeLessThanOrEqual(430)
    expect(fitToolbar({ w: 1000, h: 700 }, 'bottom')).toMatchObject({ overflow: [], size: { w: toolbarLength(TOOLBAR_ITEMS, false), h: 46 } })
  })
  it('moves Tay and Chọn to "⋯" together, never Run, and keeps the last segment for "⋯"', () => {
    for (let w = 120; w <= 460; w += 4) {
      const fit = fitToolbar({ w, h: 700 }, 'bottom')
      expect(fit.shown).toContain('run')
      expect(fit.groups.at(-1)).toEqual(fit.shown.includes('zoom') ? ['zoom'] : [])
      expect(fit.size.w).toBeLessThanOrEqual(w)
    }
    expect(fitToolbar({ w: 400, h: 700 }, 'bottom').overflow).toEqual(['add', 'view'])
    expect(fitToolbar({ w: 300, h: 700 }, 'bottom').overflow).toContain('mouse')
  })
  it('remembers which side panels "Chỉ canvas" hid and shows exactly those again', () => {
    const libraryOnly = toggleCanvasOnly({ left: true, right: false }, null)
    expect(libraryOnly).toEqual({ next: { left: false, right: false }, remember: { left: true, right: false } })
    expect(toggleCanvasOnly(libraryOnly.next, libraryOnly.remember)).toEqual({ next: { left: true, right: false }, remember: null })
    expect(toggleCanvasOnly({ left: false, right: false }, null).next).toEqual({ left: true, right: true })
    expect(canvasOnlyLabel({ left: false, right: true })).toBe('Chỉ canvas (ẩn hai khung bên)')
    expect(canvasOnlyLabel({ left: false, right: false })).toBe('Hiện lại hai khung bên')
  })
  it('marks "Hiển thị" only when wires, videos or the minimap differ from the defaults', () => {
    const { edgeMode, takeDisplay, showMinimap } = DEFAULT_SETTINGS.ui
    expect(DEFAULT_VIEW).toEqual({ edgeMode, takeDisplay, showMinimap })
    const defaults = { edgeMode: 'selected', takeDisplay: 'all', showMinimap: true }
    expect(viewDiffers(defaults)).toBe(false)
    expect(viewDiffers(defaults, defaults)).toBe(false)
    expect(viewDiffers({ ...defaults, edgeMode: 'all' }, defaults)).toBe(true)
    expect(viewDiffers({ ...defaults, takeDisplay: 'chosen' }, defaults)).toBe(true)
    expect(viewDiffers({ ...defaults, showMinimap: false }, defaults)).toBe(true)
  })
  it('names Mac keys on a Mac in the grip help', () => {
    expect(gripHelpText(true)).toContain('⌥ + mũi tên')
    expect(gripHelpText(true)).toContain('Fn + ←')
    expect(gripHelpText(true)).not.toMatch(/\bAlt\b|\bShift\b/)
    expect(gripHelpText(false)).toContain('Alt + mũi tên')
    expect(gripHelpText(false)).toContain('Home: về chỗ cũ')
  })
  it('lets a tray that can still scroll take the wheel, and hands the rest to the canvas', () => {
    const box = { scrollLeft: 0, scrollTop: 0, scrollWidth: 300, scrollHeight: 200, clientWidth: 300, clientHeight: 100 }
    expect(canScrollBy(box, 0, 40)).toBe(true)
    expect(canScrollBy(box, 0, -40)).toBe(false)
    expect(canScrollBy({ ...box, scrollTop: 100 }, 0, 40)).toBe(false)
    expect(canScrollBy({ ...box, scrollTop: 100 }, 0, -40)).toBe(true)
    expect(canScrollBy({ ...box, scrollHeight: 100 }, 0, 40)).toBe(false)
  })
})

describe('toolbar.css paint order', () => {
  const css = readFileSync(new URL('../toolbar.css', import.meta.url), 'utf8')
  const zOf = (selector: string) => {
    const block = css.slice(css.indexOf(`${selector} {`))
    return Number(/z-index:\s*(\d+)/.exec(block.slice(0, block.indexOf('}')))?.[1])
  }
  it('draws the bar (and its tooltips) above the tray, and an open menu above both', () => {
    const tray = zOf('.cv-toolbar-host .cv-toolbar-tray'), bar = zOf('.cv-toolbar-host .cv-toolbar-bar')
    const backdrop = zOf('.cv-toolbar-backdrop'), menu = zOf('.cv-toolbar-host .cv-toolbar-menu')
    expect([tray, bar, backdrop, menu].every(Number.isFinite)).toBe(true)
    expect(bar).toBeGreaterThan(tray)
    expect(backdrop).toBeGreaterThan(bar)
    expect(menu).toBeGreaterThan(backdrop)
  })
  it('no legacy toolbar / selection-hint rules left in canvas.css to leak into the bar and tray', () => {
    const canvas = readFileSync(new URL('../canvas.css', import.meta.url), 'utf8')
    for (const cls of ['cv-toolbar', 'cv-sel-hint', 'cv-sel-hint-btn', 'cv-tb-btn', 'cv-tb-icon', 'cv-tb-sep', 'cv-tb-count', 'cv-seg', 'cv-zoom', 'cv-zoom-val', 'cv-lift-minimap']) {
      expect(canvas, cls).not.toMatch(new RegExp(`\\.${cls}(?![\\w-])`))
    }
  })
})

describe('arrange slot (cx/arrange ArrangePopover on the cx/tb1 bar)', () => {
  it('is a split button: the saved style as its name, a ▾ that opens the popover, and room for both in the bar', () => {
    // Server rendering reads the stores' initial state: the default style, popover closed.
    const html = renderToStaticMarkup(<ArrangeToolbarSlot onArrange={() => {}} />)
    expect(html).toContain('aria-label="Sắp xếp lại: mỗi cảnh một hàng, video bên phải"')
    expect(html).toContain('data-arrange-menu')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    const slot = readFileSync(new URL('../ArrangeToolbarSlot.tsx', import.meta.url), 'utf8')
    expect(slot).toContain('useArrangeMenu.getState().toggle()')
    expect(slot).toContain('arrangeTitle(resolveArrange(s))')
    expect(toolbarLength(['arrange'], false) - toolbarLength(['fit'], false)).toBe(3 + 16)
    const bar = readFileSync(new URL('../ToolbarBar.tsx', import.meta.url), 'utf8')
    expect(bar).toContain('<ArrangePopover')
    expect(bar).toContain("id: 'arrange-menu'")
  })
})

describe('keyboard toolbar', () => {
  it('renders registry shortcut labels and accessible names', () => {
    const html = renderToStaticMarkup(<ToolbarButton label="Chạy" shortcut="scene.run"><span /></ToolbarButton>)
    expect(html).toContain(useKeymap.getInitialState().resolved.labels['scene.run'])
    expect(html).toContain('aria-label="Chạy"')
    expect(resolveKeymap({ 'scene.run': ['Ctrl+KeyR'] }, true).labels['scene.run']).toBe('⌘R')
    expect(resolveKeymap({ 'scene.run': [] }).labels['scene.run']).toBe('')
  })
  it('arrows wrap, Home/End jump, and focus stays in the bar', () => {
    const buttons = Array.from({ length: 3 }, () => ({ tabIndex: -1, focus: vi.fn() }))
    vi.stubGlobal('document', { activeElement: buttons[2] })
    const e = { key: 'ArrowRight', currentTarget: { querySelectorAll: () => buttons }, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    toolbarArrowKey(e as unknown as KeyboardEvent<HTMLElement>)
    expect(buttons[0].focus).toHaveBeenCalledOnce()
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1])
    e.key = 'End'
    toolbarArrowKey(e as unknown as KeyboardEvent<HTMLElement>)
    expect(buttons[2].focus).toHaveBeenCalledOnce()
    expect(e.stopPropagation).toHaveBeenCalledTimes(2)
  })
  it('lets other keys reach the global shortcuts after a toolbar button was clicked', () => {
    const buttons = [{ tabIndex: 0, focus: vi.fn() }]
    vi.stubGlobal('document', { activeElement: buttons[0] })
    for (const key of ['n', 'c', 'Delete', 'z', 'Enter', 'Escape']) {
      const e = { key, currentTarget: { querySelectorAll: () => buttons }, preventDefault: vi.fn(), stopPropagation: vi.fn() }
      toolbarArrowKey(e as unknown as KeyboardEvent<HTMLElement>)
      expect(e.stopPropagation).not.toHaveBeenCalled()
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(buttons[0].focus).not.toHaveBeenCalled()
  })
  it('lets Alt / Ctrl / ⌘ + arrows through (Alt+↑/↓ moves the selected scene)', () => {
    const buttons = [{ tabIndex: 0, focus: vi.fn() }, { tabIndex: -1, focus: vi.fn() }]
    vi.stubGlobal('document', { activeElement: buttons[0] })
    for (const mod of ['altKey', 'ctrlKey', 'metaKey']) {
      const e = { key: 'ArrowDown', [mod]: true, currentTarget: { querySelectorAll: () => buttons }, preventDefault: vi.fn(), stopPropagation: vi.fn() }
      toolbarArrowKey(e as unknown as KeyboardEvent<HTMLElement>)
      expect(e.stopPropagation).not.toHaveBeenCalled()
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(buttons[1].focus).not.toHaveBeenCalled()
  })
  it('keeps exactly one Tab stop after the roving item left the bar (or a refit added a second)', () => {
    const items = (...tabs: number[]) => tabs.map((tabIndex) => ({ tabIndex }))
    const none = items(-1, -1, -1)
    ensureRovingStop({ querySelectorAll: () => none })
    expect(none.map((b) => b.tabIndex)).toEqual([0, -1, -1])
    const two = items(0, -1, 0)
    ensureRovingStop({ querySelectorAll: () => two }, two[2])
    expect(two.map((b) => b.tabIndex)).toEqual([-1, -1, 0])
    const focusedElsewhere = items(-1, -1, -1)
    ensureRovingStop({ querySelectorAll: () => focusedElsewhere }, focusedElsewhere[1])
    expect(focusedElsewhere.map((b) => b.tabIndex)).toEqual([-1, 0, -1])
    const fine = items(-1, 0, -1)
    ensureRovingStop({ querySelectorAll: () => fine }, fine[0])
    expect(fine.map((b) => b.tabIndex)).toEqual([-1, 0, -1])
    expect(() => ensureRovingStop(null)).not.toThrow()
  })
})
