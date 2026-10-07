import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveKeymap } from '../../../core/keymap'
import { useKeymap } from '../../../lib/keymapPrefs'
import { DEFAULT_TOOLBAR_PLACE, TOOLBAR_PREFS_KEY, parseToolbarPrefs, useToolbarPrefs, validateToolbarPlace, type ToolbarDock } from '../../../lib/toolbarPrefs'
import { ToolbarButton, toolbarArrowKey } from '../ToolbarControls'
import { clampToolbar, fitToolbar, minimapPosition, nudgeToolbar, placeToolbarPanel, snapToolbar, toolbarOrientation, toolbarRect, toolbarSide, toolbarTrayContents } from '../toolbarModel'
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
      expect(new Set([...fit.shown, ...fit.overflow]).size).toBe(12)
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
  it('shows only status-appropriate video operations, and only for exactly one take', () => {
    expect(toolbarTrayContents({ ...selection, nodes: 1, takeStatus: 'completed' })).toEqual(['star', 'download', 'save', 'delete'])
    expect(toolbarTrayContents({ ...selection, nodes: 1, takeStatus: 'failed' })).toEqual(['rerun', 'delete'])
    expect(toolbarTrayContents({ ...selection, nodes: 1, takeStatus: 'processing' })).toEqual(['delete'])
    expect(toolbarTrayContents({ ...selection, nodes: 2, takeStatus: 'completed' })).toEqual([])
  })
  it('cuts wires only when no nodes are selected', () => {
    expect(toolbarTrayContents({ ...selection, cuttableWires: 3 })).toEqual(['cut'])
    expect(toolbarTrayContents({ ...selection, nodes: 1, scenes: 1, cuttableWires: 3 })).toEqual([])
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
})
