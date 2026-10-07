import { expect, it } from 'vitest'
import {
  actionById, CHANGED_FROM_0_5, chordLabel, contextsOverlap, defaultBindings, defaultsFor, KEY_ACTIONS, LEGACY_DEFAULTS, legacy05, refusalFor,
  resolveKeymap, validateBindings, warningsFor, withLegacy05,
} from '../keymap'

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

it('"Bản 0.5" sets the 0.5 chords of the 0.5 commands only; every new command keeps its default', () => {
  const legacy = legacy05()
  expect(Object.keys(legacy).sort()).toEqual([...Object.keys(LEGACY_DEFAULTS), 'take.star'].sort())
  expect(legacy['take.star']).toEqual([])
  const resolved = resolveKeymap(withLegacy05({}))
  for (const [id, chords] of Object.entries({
    'take.download': ['Ctrl+KeyM'], 'scene.new': ['Ctrl+KeyN'], unlinkSelection: ['Ctrl+Shift+KeyL'], 'canvas.zoomIn': ['Equal', 'Shift+Equal'],
    'folder.new': ['Ctrl+KeyB'], 'library.addImages': ['Ctrl+KeyI'], 'project.open': ['Ctrl+KeyO'], 'panels.library': ['Shift+Digit1'],
    'panels.inspector': ['Shift+Digit5'], 'panels.canvasOnly': ['Backquote', 'Shift+Backquote'], 'selection.deselectAll': ['Ctrl+Shift+KeyA'],
    'canvas.zoomOut': ['Minus'], 'canvas.minimap': ['KeyM'], 'selection.connect': ['KeyC'], 'canvas.fit': ['KeyF'],
  })) expect(resolved.byAction[id as keyof typeof resolved.byAction], id).toEqual(chords)
  expect(resolved.dropped).toEqual([])
  // No default of a command the preset leaves alone is a 0.5 chord (★ = M is the one the preset unassigns).
  const chords05 = new Set(Object.values(LEGACY_DEFAULTS).flat())
  for (const mac of [false, true]) for (const a of KEY_ACTIONS.filter((x) => !Object.hasOwn(legacy, x.id))) {
    for (const c of defaultsFor(a, mac)) expect(chords05.has(c), `${a.id} ${c}`).toBe(false)
  }
  // A custom key of a new command is kept; one that took a 0.5 chord goes back to its default; [] stays unassigned.
  expect(withLegacy05({ 'take.download': ['F4'], 'scene.new': ['KeyC', 'F6'], 'folder.new': ['KeyF'], 'canvas.zoomOut': [] }))
    .toMatchObject({ 'take.download': ['F4'], 'scene.new': ['F6'], 'canvas.zoomOut': [] })
  expect(withLegacy05({ 'folder.new': ['KeyF'] })['folder.new']).toBeUndefined()
  // A custom key of a 0.5 command is replaced by its 0.5 chord.
  expect(withLegacy05({ 'scene.next': ['F2'] })['scene.next']).toEqual(['KeyN'])
})

it('CHANGED_FROM_0_5 lists every default that differs from 0.5', () => {
  const diff = KEY_ACTIONS.filter((a) => LEGACY_DEFAULTS[a.id] && JSON.stringify(LEGACY_DEFAULTS[a.id]) !== JSON.stringify(a.defaults))
    .map((a) => ({ id: a.id, before: LEGACY_DEFAULTS[a.id], after: a.defaults }))
  expect(CHANGED_FROM_0_5.filter((c) => LEGACY_DEFAULTS[c.id]).map(({ id, before, after }) => ({ id, before, after }))).toEqual(diff)
  // Rows about commands 0.5 did not have only exist for a behaviour note (Ctrl+Shift+A selected all in 0.5).
  for (const c of CHANGED_FROM_0_5.filter((x) => !LEGACY_DEFAULTS[x.id])) {
    expect(c.note, c.id).toBeTruthy()
    expect(c.after).toEqual(actionById(c.id)!.defaults)
  }
  expect(CHANGED_FROM_0_5.find((c) => c.id === 'selection.connect')?.note).toContain('bỏ nối')
  expect(CHANGED_FROM_0_5.find((c) => c.id === 'canvas.minimap')?.note).toContain('★')
})

it('warns about Vietnamese input tools only on the listed defaults (Windows desktop), and about Ctrl+N in a browser', () => {
  const DEFAULT_WARNINGS_OK = [
    'scene.next:KeyN', 'selection.connect:KeyC', 'canvas.fit:KeyF', 'canvas.fit:Backslash', 'canvas.cycleEdges:KeyE', 'canvas.hand:KeyH',
    'canvas.select:KeyV', 'take.star:KeyM',
    'canvas.zoomIn:Equal', 'canvas.zoomIn:Shift+Equal', 'canvas.zoomOut:Minus', 'panels.canvasOnly:Backquote', 'panels.canvasOnly:Shift+Backquote',
    'help.shortcuts:Shift+Slash',
    'help.shortcuts:Ctrl+Alt+KeyK',
  ]
  const warned = KEY_ACTIONS.flatMap((a) => a.defaults.filter((c) => warningsFor(c, false, false).length).map((c) => `${a.id}:${c}`))
  expect(warned.sort()).toEqual([...DEFAULT_WARNINGS_OK].sort())
  expect(warningsFor('Ctrl+Alt+KeyK')[0]).toContain('AltGr')
  for (const c of ['Shift+Digit1', 'Shift+Digit5', 'Shift+KeyM']) expect(warningsFor(c), c).toEqual([])
  for (const c of ['Shift+Digit6', 'Shift+Digit8', 'Shift+Digit9']) expect(warningsFor(c)[0], c).toContain('Bộ gõ tiếng Việt')
  expect(warningsFor('Ctrl+KeyN', false, true).join()).toContain('Trình duyệt')
  // Plain letters: the Telex-safe ones plus E / F kept from 0.5; never a plain digit (VNI).
  const plain = KEY_ACTIONS.flatMap((a) => [...a.defaults, ...(a.macDefaults ?? [])]).filter((c) => /^(Key[A-Z]|Digit\d)$/.test(c))
  for (const c of plain) expect('BCGHIKLMNPQTUVYEF'.includes(c.slice(3)) && c.startsWith('Key'), c).toBe(true)
})

it('labels the new punctuation chords like Premiere', () => {
  expect(chordLabel('Ctrl+Shift+Slash')).toBe('Ctrl+Shift+/')
  expect(chordLabel('Ctrl+Shift+Slash', true)).toBe('⇧⌘/')
  expect(chordLabel('Shift+Equal')).toBe('+')
  expect(chordLabel('Ctrl+Shift+Equal')).toBe('Ctrl+Shift+=')
  expect(['Backquote', 'Shift+Backquote', 'Backslash', 'Equal', 'Minus'].map((c) => chordLabel(c))).toEqual(['`', 'Shift+`', '\\', '=', '-'])
  expect(resolveKeymap().allLabels['selection.duplicate']).toBe('Ctrl+D / Ctrl+Shift+/')
})

it('keeps the video players’ keys away from every command', () => {
  for (const c of ['KeyJ', 'KeyK', 'KeyL', 'Home', 'End']) expect(refusalFor(c, 'scene.next'), c).toBe(`${chordLabel(c)} là phím của trình phát video — chọn phím khác.`)
  // Commands that also run in the take viewer cannot take its fullscreen keys; others can.
  for (const c of ['Backquote', 'Ctrl+Backquote']) {
    expect(refusalFor(c, 'take.star'), c).toContain('trình phát video')
    expect(refusalFor(c, 'take.download'), c).toContain('trình phát video')
  }
  expect(refusalFor('Backquote', 'scene.next')).toBeNull()
  expect(refusalFor('KeyF', 'take.star')).toContain('thoát video phóng to')
  expect(refusalFor('KeyF', 'scene.next')).toBeNull()
  expect(validateBindings({ 'take.star': ['KeyJ'] }).rejected).toEqual(['keys.take.star'])
})
