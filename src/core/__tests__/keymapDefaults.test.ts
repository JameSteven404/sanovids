import { expect, it } from 'vitest'
import { contextsOverlap, defaultBindings, defaultsFor, KEY_ACTIONS, legacy05, refusalFor, resolveKeymap } from '../keymap'

it('installs the exact Premiere table and the Mac download exception', () => {
  const expected = {
    'project.save': ['Ctrl+KeyS', 'Ctrl+Shift+KeyS'], 'history.undo': ['Ctrl+KeyZ'],
    'history.redo': ['Ctrl+Shift+KeyZ', 'Ctrl+KeyY'], 'library.search': ['Ctrl+KeyF', 'Ctrl+KeyK'],
    'library.addImages': ['Ctrl+KeyI'], 'project.open': ['Ctrl+KeyO'], 'help.shortcuts': ['Shift+Slash', 'Ctrl+Alt+KeyK'],
    'panels.library': ['Shift+Digit1'], 'panels.inspector': ['Shift+Digit5'], 'panels.canvasOnly': ['Backquote', 'Shift+Backquote'],
    'settings.search': ['Ctrl+KeyF'], 'scene.run': ['Ctrl+Enter'], 'scene.next': ['KeyN'], 'scene.new': ['Ctrl+KeyN'],
    'folder.new': ['Ctrl+KeyB'], 'selection.duplicate': ['Ctrl+KeyD', 'Ctrl+Shift+Slash'],
    'selection.delete': ['Delete', 'Shift+Delete'], 'selection.selectAll': ['Ctrl+KeyA'], 'selection.deselectAll': ['Ctrl+Shift+KeyA'],
    'selection.connect': ['Ctrl+KeyL', 'KeyC'], unlinkSelection: ['Ctrl+Shift+KeyL'],
    'take.star': ['KeyM'], 'take.download': ['Ctrl+KeyM'], 'canvas.fit': ['Backslash', 'KeyF'],
    'canvas.zoomIn': ['Equal', 'Shift+Equal'], 'canvas.zoomOut': ['Minus'], 'canvas.select': ['KeyV'],
    'canvas.hand': ['KeyH'], 'canvas.cycleEdges': ['KeyE'], 'canvas.minimap': ['Shift+KeyM'],
  }
  expect(defaultBindings()).toEqual(expected)
  expect(defaultBindings(true)).toEqual({ ...expected, 'take.download': ['Ctrl+KeyE'] })
  expect(resolveKeymap({}, true).labels['take.download']).toBe('⌘E')
})

it('has no reserved or overlapping defaults, and keeps user overrides through the default change', () => {
  for (const mac of [false, true]) for (const a of KEY_ACTIONS) {
    for (const chord of defaultsFor(a, mac)) {
      expect(refusalFor(chord, a, mac), `${a.id}: ${chord}`).toBeNull()
      expect(KEY_ACTIONS.filter((b) => b.id !== a.id && contextsOverlap(a, b) && defaultsFor(b, mac).includes(chord))).toEqual([])
    }
  }
  const custom = resolveKeymap({ 'canvas.minimap': ['KeyM'], 'scene.next': ['F2'] })
  expect(custom.byAction['take.star']).toEqual([])
  expect(custom.byAction['scene.next']).toEqual(['F2'])
  expect(custom.byAction['canvas.fit']).toEqual(['Backslash', 'KeyF'])
  const legacy = resolveKeymap(legacy05())
  expect(legacy.labels['canvas.minimap']).toBe('M')
  expect(legacy.byAction['take.star']).toEqual([])
  expect(legacy.labels['library.search']).toBe('Ctrl+K')
  expect(legacy.lookup.Digit1).toBeUndefined()
})
