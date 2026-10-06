import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_KEYMAP_BYTES, validateBindings } from '../../core/keymap'
import { isTypingChord, KEYMAP_PREFS_KEY, matchesAction, parseKeymapPrefs, shortcutLabel, useKeymap, withShortcut } from '../keymapPrefs'

afterEach(() => { useKeymap.getState().resetAll(); vi.unstubAllGlobals() })

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
  expect(shortcutLabel('canvas.fit')).toBe('')
  expect(shortcutLabel('scene.next')).toBe('F')
  expect(withShortcut('Vừa màn hình', 'canvas.fit')).toBe('Vừa màn hình')
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
  expect(shortcutLabel('canvas.fit')).toBe('F')
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
