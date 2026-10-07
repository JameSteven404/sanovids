import { describe, expect, it } from 'vitest'
import {
  activeIn, actionById, chordAria, chordFromEvent, chordLabel, chordParts, contextsOverlap, decideShortcut,
  defaultBindings, FIXED_KEYS, formatChord, KEY_ACTIONS, parseChord, refusalFor, resolveKeymap, validateBindings, warningsFor,
  type Ctx, type KeyEventLike,
} from '../keymap'
import { eventLike, isImeKey, isTypingTarget } from '../../lib/keyEvents'

const ctx: Ctx = { typing: false, dialog: 'none', view: 'canvas' }
const event = (key: string, code: string, rest: Partial<KeyEventLike> = {}): KeyEventLike => ({ key, code, ...rest })

it('keeps today’s single default table and supplies Vietnamese registry metadata', () => {
  expect(defaultBindings()).toEqual({
    'project.save': ['Ctrl+KeyS'], 'scene.run': ['Ctrl+Enter'], 'history.undo': ['Ctrl+KeyZ'],
    'history.redo': ['Ctrl+Shift+KeyZ', 'Ctrl+KeyY'], 'library.search': ['Ctrl+KeyK'], 'help.shortcuts': ['Shift+Slash'],
    'scene.next': ['KeyN'],
    'selection.duplicate': ['Ctrl+KeyD'], 'selection.delete': ['Delete'], 'selection.selectAll': ['Ctrl+KeyA'],
    'selection.connect': ['KeyC'], 'canvas.fit': ['KeyF'], 'canvas.cycleEdges': ['KeyE'], 'canvas.hand': ['KeyH'],
    'canvas.select': ['KeyV'], 'canvas.minimap': ['KeyM'], 'settings.search': ['Ctrl+KeyF'],
  })
  for (const a of KEY_ACTIONS) {
    expect([a.label, a.help, a.hint, a.keywords].every(Boolean)).toBe(true)
    for (const mac of [false, true]) for (const c of a.defaults) expect(refusalFor(c, a, mac), `${a.id} ${c}`).toBeNull()
  }
})

it('retires the hidden views’ commands (1 / 2 / 3) and keeps Alt + ↑ / ↓ as fixed scene-order keys', () => {
  // 0.6.0 shows the canvas only (core/shownViews): 17 commands, none of them view.*.
  expect(KEY_ACTIONS).toHaveLength(17)
  expect(KEY_ACTIONS.filter((a) => a.id.startsWith('view.'))).toEqual([])
  for (const digit of ['Digit1', 'Digit2', 'Digit3']) {
    expect(resolveKeymap().lookup[digit]).toBeUndefined()
    expect(decideShortcut(event(digit.slice(-1), digit), ctx, false)).toEqual({ action: null, handled: false })
  }
  // A stored binding of a retired command is kept as a foreign value and does nothing.
  const old = validateBindings({ 'view.table': ['Digit2'], 'scene.next': ['KeyJ'] })
  expect(old.foreign).toEqual({ 'view.table': ['Digit2'] })
  expect(old.bindings).toEqual({ 'scene.next': ['KeyJ'] })
  expect(resolveKeymap({ 'view.table': ['Digit2'] }).lookup.Digit2).toBeUndefined()
  // Scene order: a fixed row, never a command (refusalFor keeps Alt + arrows away from every command).
  const order = FIXED_KEYS.find((k) => k.label.startsWith('Thứ tự cảnh'))
  expect(order?.keys).toEqual(['Alt+ArrowUp', 'Alt+ArrowDown'])
  expect(FIXED_KEYS.some((k) => /storyboard|bảng cảnh/i.test(k.label))).toBe(false)
  expect(KEY_ACTIONS.some((a) => /storyboard|bảng cảnh/i.test(`${a.label} ${a.help}`))).toBe(false)
  for (const a of KEY_ACTIONS) for (const c of ['Alt+ArrowUp', 'Alt+ArrowDown']) for (const mac of [false, true]) expect(refusalFor(c, a, mac), `${a.id} ${c}`).toBeTruthy()
  for (const mac of [false, true]) expect(decideShortcut(event('ArrowUp', 'ArrowUp', { altKey: true }), ctx, mac).action).toBeNull()
})

it('round trips every whitelisted key and modifier combination', () => {
  for (const id of ['KeyA', 'Digit0', 'Slash', 'Equal', 'Enter', 'F11', 'ArrowLeft', 'IntlBackslash']) {
    for (let mask = 0; mask < 8; mask++) {
      const chord = formatChord({ ctrl: !!(mask & 1), alt: !!(mask & 2), shift: !!(mask & 4), id })
      expect(parseChord(chord)).toBe(chord)
    }
  }
  expect(parseChord('Shift+Alt+Ctrl+KeyZ')).toBe('Ctrl+Alt+Shift+KeyZ')
  for (const bad of [null, 42, '', 'Ctrl+Ctrl+KeyS', 'Meta+KeyS', 'Control+KeyS', 'Win+KeyS', 'Ctrl+A', 'KeyAA', 'F13', 'Ctrl+Plus']) expect(parseChord(bad)).toBeNull()
})

it('formats US key caps, Mac glyph order and ARIA separately', () => {
  expect(chordLabel('Ctrl+Shift+KeyZ')).toBe('Ctrl+Shift+Z')
  expect(chordLabel('Ctrl+Alt+Shift+KeyZ', true)).toBe('⌥⇧⌘Z')
  expect(chordParts('Control+Alt+Shift+Ctrl+KeyZ', true)).toEqual(['⌃', '⌥', '⇧', '⌘', 'Z'])
  expect(chordLabel('Shift+Slash')).toBe('?')
  expect(chordAria('Ctrl+Shift+KeyZ')).toBe('Control+Shift+Z')
  expect(chordAria('Ctrl+Shift+KeyZ', true)).toBe('Meta+Shift+Z')
  expect(chordAria('Shift+Slash')).toBe('Shift+/')
  expect(chordLabel('ArrowLeft')).toBe('←')
  expect(chordAria('Alt+ArrowLeft')).toBe('Alt+ArrowLeft')
  expect(['Enter', 'Escape', 'Backspace', 'Delete', 'Tab'].map((c) => chordLabel(c, true))).toEqual(['↩', 'esc', '⌫', '⌦', '⇥'])
})

it('rejects IME, injected, modifier, unknown, AltGr and platform modifier events', () => {
  for (const e of [
    event('e', 'KeyE', { isComposing: true }), event('e', 'KeyE', { keyCode: 229 }), event('Process', 'KeyE'),
    event('Unidentified', 'KeyE'), event('Dead', 'Quote'), event('Control', 'ControlLeft'), event('Fn', ''),
    event('e', ''), event('ê', 'KeyE'), event('AudioVolumeUp', 'AudioVolumeUp'),
    event('đ', 'KeyD', { ctrlKey: true, altKey: true, altGraph: true }), event('2', 'Numpad2', { altKey: true }),
  ]) for (const mac of [false, true]) expect(chordFromEvent(e, mac), JSON.stringify(e)).toBeNull()
  expect(chordFromEvent(event('s', 'KeyS', { metaKey: true }), false)).toBeNull()
  expect(chordFromEvent(event('s', 'KeyS', { ctrlKey: true }), true)).toBeNull()
  expect(chordFromEvent(event('s', 'KeyS', { ctrlKey: true, metaKey: true }), true)).toBeNull()
  expect(chordFromEvent(event('s', 'KeyS', { metaKey: true }), true)).toBe('Ctrl+KeyS')
})

describe('refusals and warnings', () => {
  it('protects fixed controls and clipboard on Windows', () => {
    for (const key of ['Escape', 'Tab', 'Backspace']) for (const mod of ['', 'Ctrl+', 'Alt+', 'Shift+', 'Ctrl+Alt+Shift+']) expect(refusalFor(mod + key, 'scene.next')).toBeTruthy()
    for (const c of ['Enter', 'Shift+Enter', 'Space', 'Shift+Space', 'ArrowLeft', 'Shift+Home', 'End', 'PageUp', 'PageDown', 'Alt+ArrowUp', 'Alt+Shift+ArrowRight', 'Alt+F4', 'Alt+Space', 'F12', 'Ctrl+Shift+KeyI', 'Ctrl+KeyC', 'Ctrl+KeyV', 'Ctrl+KeyX']) expect(refusalFor(c, 'selection.delete'), c).toBeTruthy()
    expect(refusalFor('Backspace', 'selection.delete')).toContain('Unikey')
    expect(refusalFor('Ctrl+ArrowLeft', 'scene.next')).toBeNull()
  })
  it('protects text editing for commands that run while typing', () => {
    for (const c of ['KeyS', 'Shift+KeyS', 'Digit1', 'Ctrl+KeyA', 'Ctrl+Shift+KeyZ', 'Ctrl+KeyY', 'Ctrl+Delete', 'Ctrl+Insert', 'Ctrl+ArrowLeft', 'Ctrl+Shift+Home', 'Ctrl+End', 'Alt+Digit1']) expect(refusalFor(c, 'project.save'), c).toBeTruthy()
    for (const c of ['Ctrl+Shift+KeyS', 'Alt+KeyS', 'F1', 'F11']) expect(refusalFor(c, 'project.save'), c).toBeNull()
  })
  it('reserves Mac system, dead-key and Option text chords', () => {
    for (const c of ['Ctrl+KeyQ', 'Ctrl+KeyH', 'Ctrl+KeyM', 'Ctrl+KeyW', 'Ctrl+Tab', 'Ctrl+Space', 'Ctrl+Backquote', 'Ctrl+Alt+KeyH', 'Ctrl+Alt+KeyM', 'Ctrl+Alt+KeyD', 'Ctrl+Alt+KeyI', 'Ctrl+Alt+Escape', 'Ctrl+Shift+Digit3', 'Ctrl+Shift+Digit4', 'Ctrl+Shift+Digit5']) expect(refusalFor(c, 'scene.next', true), c).toContain('macOS')
    for (const c of ['Alt+KeyE', 'Alt+KeyI', 'Alt+KeyN', 'Alt+KeyU', 'Alt+Backquote']) expect(refusalFor(c, 'scene.next', true)).toContain('phím dấu')
    expect(refusalFor('Alt+KeyS', 'project.save', true)).toContain('ký tự đặc biệt')
    for (const c of ['Ctrl+KeyH', 'Ctrl+KeyM', 'Ctrl+KeyQ']) {
      expect(validateBindings({ 'scene.next': [c] }, false).rejected).toEqual([])
      expect(validateBindings({ 'scene.next': [c] }, true)).toMatchObject({ bindings: {}, rejected: ['keys.scene.next'], issues: [{ reason: 'mac-system', message: expect.stringContaining('về phím mặc định') }] })
    }
  })
  it('warns without refusing single letters, AltGr, IME toggles, browser and Mac fn keys', () => {
    expect(warningsFor('KeyN')[0]).toContain('Bộ gõ tiếng Việt')
    expect(warningsFor('KeyN', true)[0]).toContain('EVKey / OpenKey')
    expect(warningsFor('Ctrl+Alt+KeyJ')[0]).toContain('AltGr')
    for (const c of ['Alt+KeyZ', 'Ctrl+Space']) expect(warningsFor(c).join()).toContain('bộ gõ')
    expect(warningsFor('Ctrl+KeyS', false, true).join()).toContain('Trình duyệt')
    expect(warningsFor('Ctrl+KeyS', false, false)).toEqual([])
    expect(warningsFor('F2', true).join()).toContain('fn')
  })
})

it('resolves context-aware overrides ahead of defaults and reports every displaced chord', () => {
  expect(contextsOverlap(actionById('scene.next')!, actionById('settings.search')!)).toBe(false)
  expect(contextsOverlap(actionById('project.save')!, actionById('settings.search')!)).toBe(true)
  expect(activeIn(actionById('history.undo')!, { ...ctx, dialog: 'asset' })).toBe(true)
  expect(activeIn(actionById('history.undo')!, { ...ctx, typing: true })).toBe(false)
  const resolved = resolveKeymap({ 'scene.next': ['Ctrl+KeyF'], 'canvas.fit': ['Ctrl+KeyS'], 'history.redo': [] })
  expect(resolved.lookup['Ctrl+KeyF']).toEqual(['scene.next', 'settings.search'])
  expect(resolved.byAction['project.save']).toEqual([])
  expect(resolved.dropped).toEqual([{ action: 'project.save', chord: 'Ctrl+KeyS', by: 'canvas.fit' }])
  expect(resolved.labels['project.save']).toBe('')
  expect(resolved.byAction['history.redo']).toEqual([])
  const invalid = validateBindings({ 'scene.next': ['Alt+KeyJ'], 'canvas.fit': ['Alt+KeyJ'] })
  expect(invalid.bindings).toEqual({ 'scene.next': ['Alt+KeyJ'], 'canvas.fit': [] })
  expect(invalid.rejected).toEqual(['keys.canvas.fit'])
  expect(validateBindings({ 'canvas.fit': ['Alt+KeyJ'], 'scene.next': ['Alt+KeyJ'] })).toEqual(invalid)
})

it('dispatches context, exact modifiers, repeats, unassigned chords and Mac delete aliases', () => {
  expect(decideShortcut(event('s', 'KeyS', { ctrlKey: true }), { ...ctx, typing: true, dialog: 'settings' }, false).action).toBe('project.save')
  expect(decideShortcut(event('f', 'KeyF', { ctrlKey: true }), { ...ctx, dialog: 'settings' }, false).action).toBeNull()
  expect(decideShortcut(event('a', 'KeyA', { ctrlKey: true }), { ...ctx, view: 'table' }, false).handled).toBe(false)
  expect(decideShortcut(event('N', 'KeyN', { shiftKey: true }), ctx, false).action).toBeNull()
  expect(decideShortcut(event('n', 'KeyN', { repeat: true }), ctx, false).action).toBeNull()
  expect(decideShortcut(event('z', 'KeyZ', { ctrlKey: true, repeat: true }), ctx, false).action).toBe('history.undo')
  expect(decideShortcut(event('Delete', 'Delete', { repeat: true }), ctx, false)).toEqual({ action: null, handled: true })
  expect(decideShortcut(event('Escape', 'Escape', { keyCode: 229 }), ctx, false).handled).toBe(false)
  expect(decideShortcut(event('Escape', 'Escape', { defaultPrevented: true }), ctx, false).handled).toBe(false)
  expect(decideShortcut(event('Escape', 'Escape', { metaKey: true, altKey: true }), ctx, true)).toEqual({ action: null, handled: false })
  for (const typing of [false, true]) for (const mac of [false, true]) {
    expect(decideShortcut(event('Backspace', 'Backspace'), { ...ctx, typing }, mac).action).toBe(mac && !typing ? 'mac-backspace' : null)
    expect(decideShortcut(event('Backspace', 'Backspace', { metaKey: mac, ctrlKey: !mac }), { ...ctx, typing }, mac).action).toBe(mac && !typing ? 'selection.delete' : null)
  }
  expect(decideShortcut(event('Backspace', 'Backspace'), ctx, true, resolveKeymap({ 'selection.delete': [] }, true)).action).toBeNull()
  expect(resolveKeymap({}, true).allLabels['history.redo']).toBe('⇧⌘Z / ⌘Y')
})

it('adapts native and React events and shares typing guards without a DOM', () => {
  expect(isImeKey({ nativeEvent: { keyCode: 229 } })).toBe(true)
  expect(isImeKey({ nativeEvent: { isComposing: true } })).toBe(true)
  expect(eventLike({ key: 'đ', code: 'KeyD', getModifierState: (key) => key === 'AltGraph' }).altGraph).toBe(true)
  expect(chordFromEvent(eventLike({ key: 's', code: 'KeyS', ctrlKey: true, nativeEvent: { isComposing: true } }), false)).toBeNull()
  for (const tagName of ['TEXTAREA', 'SELECT', 'VIDEO', 'INPUT']) expect(isTypingTarget({ tagName } as unknown as EventTarget)).toBe(true)
  expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget)).toBe(false)
  expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
  expect(isTypingTarget(null)).toBe(false)
})
