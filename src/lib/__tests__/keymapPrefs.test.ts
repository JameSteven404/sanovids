import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_KEYMAP_BYTES, validateBindings } from '../../core/keymap'
import { isTypingChord, KEYMAP_PREFS_KEY, matchesAction, parseKeymapPrefs, shortcutLabel, useKeymap, withShortcut } from '../keymapPrefs'
import { altKeysText, assignKeys, changeKeys, heldModifiers, useKeyCapture, useKeyCaptureHost } from '../../components/dialogs/SettingsShortcuts'
import { useUI } from '../../store/ui'
import { premiereNote } from '../../components/dialogs/ShortcutsDialog'

const effects = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useLayoutEffect: (fn: () => () => void) => { effects.cleanup = fn() } }))

afterEach(() => { useKeymap.getState().resetAll(); vi.unstubAllGlobals() })

it('captures keys before modal/global handlers, rejects IME, and resolves conflicts only explicitly', () => {
  const listeners: Record<string, (e: Event) => void> = {}
  vi.stubGlobal('window', { addEventListener: (type: string, fn: (e: Event) => void) => { listeners[type] = fn }, removeEventListener: vi.fn() })
  useKeyCaptureHost()
  const keydown = listeners.keydown as unknown as (e: KeyboardEvent) => void
  const start = () => useKeyCapture.setState({ capture: { id: 'scene.next', index: 0, message: '' } })
  const press = (key: string, code = key, extra = {}) => {
    const e = { key, code, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra }
    keydown(e as unknown as KeyboardEvent)
    return e
  }
  start()
  expect(press('Process', 'KeyF', { isComposing: true }).stopImmediatePropagation).toHaveBeenCalled()
  expect(shortcutLabel('scene.next')).toBe('N')
  expect(useKeyCapture.getState().capture?.message).toContain('Bộ gõ')
  // Modifiers alone: a preview in key-cap names, never the raw e.key ("Control…").
  press('Control', 'ControlLeft', { ctrlKey: true })
  expect(useKeyCapture.getState().capture?.message).toBe('Ctrl+… Bấm thêm một phím.')
  press('Shift', 'ShiftLeft', { ctrlKey: true, shiftKey: true })
  expect(useKeyCapture.getState().capture?.message).toBe('Ctrl+Shift+… Bấm thêm một phím.')
  expect(heldModifiers({ metaKey: true, shiftKey: true }, true)).toBe('⇧⌘')
  press('f', 'KeyF')
  expect(useKeyCapture.getState().capture).toMatchObject({ chords: ['KeyF'], paused: true })
  expect(shortcutLabel('scene.next')).toBe('N')
  // The conflict waits for Thay thế / Chọn phím khác / Huỷ: Tab, Enter and Space reach those buttons, nothing is recorded.
  for (const [key, code] of [['Tab', 'Tab'], ['Enter', 'Enter'], [' ', 'Space']]) {
    const e = press(key, code)
    expect(e.preventDefault, key).not.toHaveBeenCalled()
    expect(e.stopImmediatePropagation, key).not.toHaveBeenCalled()
  }
  expect(useKeyCapture.getState().capture).toMatchObject({ chords: ['KeyF'], paused: true })
  // …and Esc cancels the choice, not the Settings dialog.
  expect(press('Escape').stopImmediatePropagation).toHaveBeenCalled()
  expect(useKeyCapture.getState().capture).toBeNull()
  start()
  const tab = press('Tab')
  expect(tab.preventDefault).not.toHaveBeenCalled()
  expect(useKeyCapture.getState().capture).toBeNull()
  start(); press('F2')
  expect(shortcutLabel('scene.next')).toBe('F2')
  expect(useKeyCapture.getState().capture).toBeNull()
  expect(useUI.getState().toasts.at(-1)?.text).toBe('Đã gán F2 cho “Cảnh tiếp theo”.')
  useUI.getState().toasts.at(-1)?.action?.run()
  expect(shortcutLabel('scene.next')).toBe('N')
  start(); const esc = press('Escape')
  expect(esc.stopImmediatePropagation).toHaveBeenCalled()
  expect(useKeyCapture.getState().capture).toBeNull()
  // A click or focus outside the recording row ends it (a key typed into the search box is never assigned).
  start()
  listeners.pointerdown({ target: { closest: (sel: string) => (sel === '[data-key-row="scene.next"]' ? {} : null) } } as unknown as Event)
  expect(useKeyCapture.getState().capture).not.toBeNull()
  listeners.pointerdown({ target: { closest: () => null } } as unknown as Event)
  expect(useKeyCapture.getState().capture).toBeNull()
  start()
  listeners.focusin({ target: { tagName: 'INPUT', closest: () => null } } as unknown as Event)
  expect(useKeyCapture.getState().capture).toBeNull()
  effects.cleanup?.()
})

it('Thay thế takes the chord from the other command and says what is left of it', () => {
  const capture = { id: 'scene.next' as const, index: 0, message: '' }
  assignKeys(capture, ['KeyF'], true)
  expect(shortcutLabel('scene.next')).toBe('F')
  expect(shortcutLabel('canvas.fit')).toBe('\\')
  expect(useUI.getState().toasts.at(-1)?.text).toBe('Đã gán F cho “Cảnh tiếp theo”. “Vừa màn hình” còn \\.')
  assignKeys(capture, ['KeyE'], true)
  expect(shortcutLabel('canvas.cycleEdges')).toBe('')
  expect(useUI.getState().toasts.at(-1)?.text).toBe('Đã gán E cho “Cảnh tiếp theo”. “Đổi cách hiện dây” không còn phím tắt.')
  useUI.getState().toasts.at(-1)?.action?.run()
  expect(shortcutLabel('canvas.cycleEdges')).toBe('E')
})

it('"Thêm phím phụ Alt + chữ" says what was really added (a refused one — taken, or a Mac dead key — is counted, not claimed)', () => {
  expect(altKeysText(5, 0)).toBe('Đã thêm phím phụ Alt + chữ cho 5 lệnh.')
  expect(altKeysText(3, 4, '⌥')).toBe('Đã thêm phím phụ ⌥ + chữ cho 3 lệnh. 4 lệnh bỏ qua (trùng phím hoặc phím không dùng được).')
  expect(altKeysText(0, 2)).toBe('Không thêm được phím phụ Alt + chữ nào. 2 lệnh bỏ qua (trùng phím hoặc phím không dùng được).')
  // the toast text is read after the change ran (the counts it reports are known only then)
  let n = 0
  changeKeys(() => { n = 7 }, () => `${n}`)
  expect(useUI.getState().toasts.at(-1)?.text).toBe('7')
})

it('switches presets without retired views and Undo restores custom and foreign bindings', () => {
  useKeymap.getState().replace({ 'scene.next': ['F2'], 'future.command': ['FutureKey'] })
  changeKeys(() => useKeymap.getState().preset('legacy05'), 'Bản 0.5')
  expect(shortcutLabel('canvas.minimap')).toBe('M')
  expect(shortcutLabel('take.star')).toBe('')
  expect(useKeymap.getState().resolved.lookup.Digit1).toBeUndefined()
  expect(useKeymap.getState().foreign).toEqual({ 'future.command': ['FutureKey'] })
  useUI.getState().toasts.at(-1)?.action?.run()
  expect(shortcutLabel('scene.next')).toBe('F2')
  changeKeys(() => useKeymap.getState().preset('premiere'), 'Premiere')
  expect(shortcutLabel('canvas.minimap')).toBe('Shift+M')
  expect(shortcutLabel('take.star')).toBe('M')
})

it('"Bản 0.5" replaces only the 0.5 commands: new commands keep their keys, 0.5 chords always win', () => {
  // scene.next: a custom key of a 0.5 command (replaced); folder.new: a custom key of a new command (kept);
  // scene.new took C, a 0.5 chord (back to its default).
  useKeymap.getState().replace({ 'scene.next': ['F2'], 'folder.new': ['F4'], 'scene.new': ['KeyC'] })
  const before = { ...useKeymap.getState().bindings }
  changeKeys(() => useKeymap.getState().preset('legacy05'), 'Đã dùng bộ phím kiểu SanoVids 0.5.')
  const labels = useKeymap.getState().resolved.labels
  expect([labels['scene.next'], labels['selection.connect'], labels['canvas.fit'], labels['library.search'], labels['canvas.minimap'], labels['take.star']])
    .toEqual(['N', 'C', 'F', 'Ctrl+K', 'M', ''])
  expect([labels['take.download'], labels['scene.new'], labels['unlinkSelection'], labels['canvas.zoomIn'], labels['folder.new'], labels['panels.library'], labels['canvas.zoomOut']])
    .toEqual(['Ctrl+M', 'Ctrl+N', 'Ctrl+Shift+L', '=', 'F4', 'Shift+1', '-'])
  expect(useKeymap.getState().resolved.dropped).toEqual([])
  useUI.getState().toasts.at(-1)?.action?.run()
  expect(useKeymap.getState().bindings).toEqual(before)
})

describe('bounded, validated keymap preferences', () => {
  it('never throws for corrupt, oversized, future-version or malicious storage', () => {
    for (const raw of [null, undefined, '', '{', '[]', 'null', 'true', '{"v":2,"bindings":{}}', 'x'.repeat(MAX_KEYMAP_BYTES + 1)]) {
      expect(() => parseKeymapPrefs(raw)).not.toThrow()
      expect(parseKeymapPrefs(raw).bindings).toEqual({})
    }
    expect(validateBindings(JSON.parse('{"__proto__":["KeyN"]}')).rejected).toEqual(['keys.__proto__'])
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(validateBindings(cyclic).rejected).toEqual(['keys'])
  })
  it('uses the shared validator for edited storage, including conflicts and the two-chord cap', () => {
    for (const chord of ['Backspace', 'Ctrl+Backspace', 'Enter', 'ArrowLeft']) {
      const bindings = { 'selection.delete': [chord] }
      const result = parseKeymapPrefs(JSON.stringify({ v: 1, bindings }), false)
      expect(result).toEqual(validateBindings(bindings, false))
      expect(result.rejected).toEqual(['keys.selection.delete'])
      expect(result.bindings).toEqual({})
    }
    expect(parseKeymapPrefs('{"v":1,"bindings":{"project.save":["KeyS"]}}').rejected).toEqual(['keys.project.save'])
    expect(parseKeymapPrefs('{"v":1,"bindings":{"scene.next":["KeyN","Alt+KeyN","F2"]}}').rejected).toEqual(['keys.scene.next'])
    expect(parseKeymapPrefs('{"v":1,"bindings":{"scene.next":["F2"],"canvas.fit":["F2"]}}').bindings).toEqual({ 'scene.next': ['F2'], 'canvas.fit': [] })
    expect(parseKeymapPrefs('{"v":1,"bindings":{"scene.next":["Ctrl+KeyQ"]}}', true).issues[0].reason).toBe('mac-system')
  })
  it('preserves unknown command values across subsequent edits and serialization', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', { setItem: (k: string, v: string) => data.set(k, v) })
    const future = { 'future.action': { chords: ['FutureKey'], schema: 2 } }
    const parsed = parseKeymapPrefs(JSON.stringify({ v: 1, bindings: future }))
    expect(parsed.foreign).toEqual(future)
    useKeymap.getState().replace({ ...parsed.foreign, 'scene.next': ['Alt+KeyN'] })
    useKeymap.getState().assign('canvas.fit', ['Alt+KeyF'])
    expect(JSON.parse(data.get(KEYMAP_PREFS_KEY)!)).toEqual({ v: 1, bindings: { ...future, 'scene.next': ['Alt+KeyN'], 'canvas.fit': ['Alt+KeyF'] } })
    expect(useKeymap.getState().resolved.lookup.FutureKey).toBeUndefined()
  })
})

it('assigns atomically, replaces conflicts only on request, removes and resets', () => {
  const s = useKeymap.getState()
  expect(s.assign('scene.next', ['KeyF']).issues[0].reason).toBe('conflict')
  expect(shortcutLabel('scene.next')).toBe('N')
  s.assign('scene.next', ['KeyF'], true)
  expect(shortcutLabel('canvas.fit')).toBe('\\')
  expect(shortcutLabel('scene.next')).toBe('F')
  expect(withShortcut('Vừa màn hình', 'canvas.fit')).toBe('Vừa màn hình (\\)')
  expect(withShortcut('Cảnh tiếp theo', 'scene.next')).toBe('Cảnh tiếp theo (F)')
  expect(s.assign('scene.next', ['Backspace']).rejected).toEqual(['keys.scene.next'])
  expect(shortcutLabel('scene.next')).toBe('F')
  s.assign('scene.next', ['Alt+KeyN', 'F2'])
  s.removeChord('scene.next', 'Alt+KeyN')
  expect(useKeymap.getState().bindings['scene.next']).toEqual(['F2'])
  s.resetAction('scene.next')
  expect(shortcutLabel('scene.next')).toBe('N')
  expect(useKeymap.getState().bindings['scene.next']).toBeUndefined()
  s.resetAll()
  expect(shortcutLabel('canvas.fit')).toBe('\\')
  expect(useKeymap.getState().bindings).toEqual({})
})

it('matches remapped commands, typing chords, composition and platform modifiers', () => {
  useKeymap.getState().assign('project.save', ['Alt+KeyS'])
  expect(matchesAction({ key: 's', code: 'KeyS', ctrlKey: true }, 'project.save', false)).toBe(false)
  expect(matchesAction({ key: 's', code: 'KeyS', altKey: true }, 'project.save', false)).toBe(true)
  expect(isTypingChord({ key: 's', code: 'KeyS', altKey: true })).toBe(true)
  expect(isTypingChord({ key: 'Alt', code: 'AltLeft', altKey: true })).toBe(false)
  expect(isTypingChord({ key: 's', code: 'KeyS', altKey: true, nativeEvent: { keyCode: 229 } })).toBe(false)
  expect(matchesAction({ key: 'z', code: 'KeyZ', ctrlKey: true }, 'history.undo', true)).toBe(false)
  expect(matchesAction({ key: 'z', code: 'KeyZ', metaKey: true }, 'history.undo', true)).toBe(true)
  expect(matchesAction({ key: 'Backspace', code: 'Backspace', metaKey: true }, 'selection.delete', true)).toBe(true)
  expect(matchesAction({ key: 'Backspace', code: 'Backspace' }, 'selection.delete', false)).toBe(false)
})

it('still updates session preferences if localStorage is unavailable', () => {
  vi.stubGlobal('localStorage', { setItem: () => { throw new Error('blocked') } })
  expect(() => useKeymap.getState().assign('scene.next', ['Alt+KeyN'])).not.toThrow()
  expect(shortcutLabel('scene.next')).toBe('Alt+N')
})

it('the shortcuts table says where SanoVids differs from Premiere, with the keys in use', () => {
  expect(premiereNote(useKeymap.getState().resolved.labels, false)).toBe(
    'Phím mặc định giống Adobe Premiere Pro. Khác Premiere: Enter mở khung sửa cảnh, chạy cảnh là Ctrl+Enter · Backspace không xoá trên Windows (dành cho bộ gõ tiếng Việt), dùng Delete · Ctrl+B mở hộp chọn thư mục.',
  )
  useKeymap.getState().assign('folder.new', [])
  expect(premiereNote(useKeymap.getState().resolved.labels, true)).toBe('Phím mặc định giống Adobe Premiere Pro. Khác Premiere: Enter mở khung sửa cảnh, chạy cảnh là Ctrl+Enter.')
})
