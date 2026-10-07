// GT2 — red text ("@image_?1(Lumi)") inside the prompt editors, against the real stores: the picker's hit test, state
// machine and keys (pure helpers in mentions.ts, driven by PlaceholderBar usePlaceholderPicker in both editors), its
// menu (sections, library cap, footer), the shared drop-on-red-text path (placeholderActions fillAtOffsetAction), the
// "Gắn vào chỗ …" offer after "Nối & chèn" / a drop / the library's "+ Nối", and its toast wording. Every fill is an
// explicit command and ONE undo step; a refused one changes nothing; nothing is ever filled by name.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkAssets } from '../../../actions'
import { MODELS } from '../../../core/models'
import { groupAtOffset, placeholderGroups, planFill } from '../../../core/placeholders'
import type { Asset, Scene } from '../../../core/types'
import { platformText } from '../../../lib/platformText'
import { register } from '../../../lib/promptDrafts'
import {
  fillAtOffsetAction,
  fillPlaceholderAction,
  keepTokenAction,
  linkInsertToastWithFill,
  linkSentence,
  placeholderToTextAction,
  removePlaceholderAction,
  splitTokenAction,
} from '../../../placeholderActions'
import { oneUndoStep, redo, undo, useProject } from '../../../store/project'
import { useUI } from '../../../store/ui'
import { fillAtOffset, fillFromDrop, filesToSceneTiles, insertLinksAtExcerpt, linkCardsToNode, placeLinkedTiles, planNodeLinks } from '../../canvas/SceneNodeEditor'
import { linkToScene } from '../../sidebar/AssetLibrary'
import {
  findMention,
  PICKER_CLOSED,
  pickerClosed,
  pickerFieldKey,
  pickerMenuKey,
  pickerNext,
  placeholderMenuIndex,
  placeholderPickerAt,
  type PickerCause,
  type PickerState,
} from '../mentions'
import { choiceHeadings, FROM_LIBRARY, libraryChoices, LINKED_OTHER, LINKED_UNUSED, PICKER_LIBRARY_MAX, PlaceholderMenu, placeholderChoices } from '../PlaceholderBar'
import { insertAt } from '../tokens'

let blobSeq = 0
vi.mock('../../../lib/imageStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/imageStore')>()),
  putBlob: vi.fn(async () => `img_picker_${++blobSeq}`),
}))

const initial = useProject.getState().project
const asset = (id: string, name = id, count = 1): Asset => ({
  id, name, tag: id, kind: 'character', description: '', imageIds: Array.from({ length: count }, (_, i) => `${id}-${i}`), color: '', position: null,
})
const prompt = 'A @image_?1(Lumi) hugs @image_1 here'
const RED = '@image_?1(Lumi)'
const redStart = prompt.indexOf(RED)
const inside = [...Array(RED.length - 1).keys()].map((i) => redStart + i + 1)
const scene = (): Scene => ({
  id: 's1', order: 1, title: '', prompt, refs: ['village'], videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position: { x: 500, y: 60 }, note: '',
})
const project = () => useProject.getState().project
const current = () => project().scenes[0]
const steps = () => useProject.temporal.getState().pastStates.length
const lastToast = () => useUI.getState().toasts.at(-1)!
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
const key = (k: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => ({
  key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods,
})
const undoHint = `${platformText.mod}+Z để bỏ nối.`

beforeEach(() => {
  useProject.getState().loadProject({ ...initial, id: 'picker-test', scenes: [scene()], assets: [asset('village', 'Làng'), asset('mira', 'Lumi'), asset('empty', 'Chưa có ảnh', 0)], folders: [], settings: { ...initial.settings, autoRenumber: true } })
  useProject.temporal.getState().clear()
  useUI.setState({ toasts: [], selectedIds: [] })
})
afterEach(() => {
  useProject.getState().loadProject(initial)
  useProject.temporal.getState().clear()
  useUI.setState({ toasts: [] })
})

// ---------------------------------------------------------------------------------------------
describe('picker hit test: strictly inside red text, the same rule as a drop', () => {
  it('opens strictly inside a whole placeholder; never at its edges, on a selection or on retired video text', () => {
    const text = '👋 @IMAGE_?2(Lumi · ảnh 2) end'
    const start = text.indexOf('@'), end = text.indexOf(')') + 1
    for (let caret = start + 1; caret < end; caret++) {
      expect(placeholderPickerAt(text, caret, caret, project().assets, [])?.group.key).toBe('L:Lumi')
      expect(findMention(text, caret)).toBeNull()
    }
    for (const caret of [start, end]) expect(placeholderPickerAt(text, caret, caret, [], [])).toBeNull()
    expect(placeholderPickerAt(text, start + 2, start + 4, [], [])).toBeNull()
    expect(placeholderPickerAt('@video_?2(Lumi)', 5, 5, [], [])).toBeNull()
    expect(placeholderPickerAt('@image_?2', 5, 5, [], [])?.group.kind).toBe('bare')
  })
  it('offers fixes for a label that does not fit its picture, never for one that fits', () => {
    expect(placeholderPickerAt('@image_1(Lumi)', 5, 5, project().assets, ['village'])?.group.kind).toBe('mismatch')
    expect(placeholderPickerAt('@image_1(Làng)', 5, 5, project().assets, ['village'])).toBeNull()
  })
  it('agrees with groupAtOffset (a drop) at every offset, and returns the span of the occurrence under the caret', () => {
    const text = `${RED} and @image_1(Lumi) then ${RED} end`
    for (let at = 0; at <= text.length; at++) {
      const hit = placeholderPickerAt(text, at, at, project().assets, ['village'])
      expect(hit?.group.key ?? null).toBe(groupAtOffset(text, project().assets, ['village'], at)?.key ?? null)
      if (hit) expect(hit.start < at && at < hit.end).toBe(true)
    }
    const second = text.lastIndexOf(RED)
    expect(placeholderPickerAt(text, second + 3, second + 3, project().assets, ['village'])).toMatchObject({ start: second, end: second + RED.length })
  })
})

// ---------------------------------------------------------------------------------------------
describe('picker state machine: typing never opens it, a click always may, Esc holds until the caret moves', () => {
  /** Replays caret events like the editors do and says whether the picker shows (hook: at measured on this text + hit). */
  function replay(events: [PickerCause | 'close', string, number, number?][]): { state: PickerState; open: boolean } {
    let state: PickerState = PICKER_CLOSED
    let text = ''
    for (const [cause, value, start, end = start] of events) {
      text = value
      state = cause === 'close' ? pickerClosed(value, start) : pickerNext(state, cause, value, start, end)
    }
    const at = state.at && state.at.text === text ? state.at.caret : null
    return { state, open: at !== null && !!placeholderPickerAt(text, at, at, project().assets, ['village']) }
  }
  const mid = redStart + 12 // "@image_?1(Lu|mi)": typing there keeps it red text ("(Luxmi)")
  const typed = prompt.slice(0, mid) + 'x' + prompt.slice(mid)

  it('typing inside red text (onChange, then the onSelect at the same caret) keeps it closed', () => {
    expect(replay([['type', typed, mid + 1], ['move', typed, mid + 1]]).open).toBe(false)
    // …also the label typed letter by letter
    expect(replay([['move', prompt, mid], ['type', typed, mid + 1], ['move', typed, mid + 1]]).open).toBe(false)
  })
  it('a caret move (arrow, click) into red text opens it; moving out closes it', () => {
    expect(replay([['move', prompt, mid]]).open).toBe(true)
    expect(replay([['type', typed, mid + 1], ['move', typed, mid]]).open).toBe(true)
    expect(replay([['move', prompt, mid], ['move', prompt, 1]]).open).toBe(false)
  })
  it('a click at the very caret where typing stopped reopens it', () => {
    expect(replay([['type', typed, mid + 1], ['move', typed, mid + 1], ['click', typed, mid + 1]]).open).toBe(true)
  })
  it('Esc / a command / a blur close it until the caret moves elsewhere — or a click', () => {
    const closed: [PickerCause | 'close', string, number][] = [['move', prompt, mid], ['close', prompt, mid]]
    expect(replay(closed).open).toBe(false)
    expect(replay([...closed, ['move', prompt, mid]]).open).toBe(false) // refocus / the onSelect after it
    expect(replay([...closed, ['click', prompt, mid]]).open).toBe(true)
    expect(replay([...closed, ['move', prompt, mid + 1]]).open).toBe(true)
  })
  it('a selection closes it and forgets where it was closed', () => {
    const r = replay([['move', prompt, mid], ['close', prompt, mid], ['move', prompt, mid - 2, mid]])
    expect(r.open).toBe(false)
    expect(r.state).toBe(PICKER_CLOSED)
    expect(replay([['move', prompt, mid - 2, mid], ['move', prompt, mid]]).open).toBe(true)
  })
  it('a picker measured on another text (undo, a fill, a renumbering) stays closed until the caret moves again', () => {
    const { state } = replay([['move', prompt, mid]])
    expect(state.at).toEqual({ text: prompt, caret: mid })
    const after = 'A @image_1 hugs @image_2 here'
    expect(state.at!.text === after).toBe(false)
  })
  it('typing never parses the prompt: only a caret move or a click asks the hit test (answered once per caret)', () => {
    const hook = read('../PlaceholderBar.tsx')
    expect(hook).toContain('const next = pickerNext(stateRef.current, cause, value, start, end)')
    expect(hook).toContain('return !!next.at && !!placeholderPickerAt(value, start, end, live.current.assets, live.current.refs)')
    const assets = project().assets
    const refs = ['village']
    expect(placeholderPickerAt(prompt, mid, mid, assets, refs)).toBe(placeholderPickerAt(prompt, mid, mid, assets, refs))
  })
  it('unchanged events return the same state object (no re-render)', () => {
    const open = pickerNext(PICKER_CLOSED, 'move', prompt, mid, mid)
    expect(pickerNext(open, 'move', prompt, mid, mid)).toBe(open)
    expect(pickerNext(open, 'click', prompt, mid, mid)).toBe(open)
    const quiet = pickerNext(open, 'type', prompt, mid, mid)
    expect(pickerNext(quiet, 'move', prompt, mid, mid)).toBe(quiet)
    expect(pickerNext(PICKER_CLOSED, 'move', prompt, 1, 3)).toBe(PICKER_CLOSED)
  })
})

// ---------------------------------------------------------------------------------------------
describe('keys: Enter / Alt+↓ enter the picker, bare arrows keep moving the caret, menu keys stay in the menu', () => {
  it('in the field: Enter (never a line break inside red text) and Alt+↓ move into the menu; nothing else does', () => {
    expect(pickerFieldKey(key('Enter'))).toBe('menu')
    expect(pickerFieldKey(key('ArrowDown', { altKey: true }))).toBe('menu')
    // bare ↑ / ↓ walk the lines of the prompt: they never put the focus on a fill or "Xoá chữ đỏ"
    for (const k of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'Home', ' ', 'a', 'Tab', 'Escape']) expect(pickerFieldKey(key(k))).toBeNull()
    for (const mods of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) expect(pickerFieldKey(key('Enter', mods))).toBeNull()
    expect(pickerFieldKey(key('ArrowUp', { altKey: true }))).toBeNull()
  })
  it('the "Enter splits the label" scenario: Enter inside "@image_?1(Lumi)" is taken by the picker, so the red text stays whole', () => {
    const caret = redStart + 12 // "@image_?1(Lu|mi)"
    const state = pickerNext(PICKER_CLOSED, 'click', prompt, caret, caret)
    expect(state.at && placeholderPickerAt(prompt, caret, caret, project().assets, ['village'])).toBeTruthy()
    expect(pickerFieldKey(key('Enter'))).toBe('menu')
    // what the newline would have done: the label breaks and the group is gone
    const broken = insertAt(prompt, caret, caret, '\n').next
    expect(placeholderGroups(broken, project().assets, ['village']).some((g) => g.key === 'L:Lumi')).toBe(false)
    // both editors give the picker their keys first; the hook stops Enter (preventDefault) before the textarea sees it
    for (const path of ['../PromptEditor.tsx', '../../canvas/SceneNodeEditor.tsx']) {
      const src = read(path)
      const onKeyDown = src.slice(src.indexOf('const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>)'))
      expect(onKeyDown.indexOf('if (picker.onKeyDown(e)) return')).toBeGreaterThan(0)
      expect(onKeyDown.indexOf('if (picker.onKeyDown(e)) return')).toBeLessThan(onKeyDown.indexOf('if (mention && suggestions.length)'))
    }
    const hook = read('../PlaceholderBar.tsx')
    const fieldKeys = hook.slice(hook.indexOf('const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>)'), hook.indexOf('const onBlur ='))
    expect(fieldKeys).toContain("pickerFieldKey(e) !== 'menu'")
    expect(fieldKeys).toContain('e.preventDefault()')
    expect(fieldKeys).not.toMatch(/ArrowUp|'ArrowDown' \|\|/)
  })
  it('in the menu: Esc / Tab close it (focus back), Ctrl / ⌘ chords reach the app, arrows move, the rest stays inside', () => {
    for (const k of [key('Escape'), key('Tab'), key('Tab', { shiftKey: true })]) expect(pickerMenuKey(k)).toBe('close')
    for (const k of [key('z', { ctrlKey: true }), key('s', { metaKey: true }), key('Enter', { ctrlKey: true }), key('y', { ctrlKey: true })]) expect(pickerMenuKey(k)).toBe('pass')
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End']) expect(pickerMenuKey(key(k))).toBe('move')
    // Delete never deletes the selected scene, letters never run canvas keys, Enter / Space click the command
    for (const k of ['Delete', 'Backspace', 'n', 'c', 'Enter', ' ']) expect(pickerMenuKey(key(k))).toBe('keep')
    const menu = read('../PlaceholderBar.tsx')
    const handler = menu.slice(menu.indexOf('const onKeyDown = (e: KeyboardEvent<HTMLDivElement>)'), menu.indexOf('const base = group.base'))
    expect(handler.indexOf("if (what === 'pass') return")).toBeLessThan(handler.indexOf('e.stopPropagation()'))
    expect(handler).toMatch(/what === 'close'\) \{\s*\/\/[^\n]*\n\s*e\.preventDefault\(\)\s*onClose\(true\)/)
  })
  it('arrow navigation skips disabled items and wraps; Enter / Space are the buttons\' own', () => {
    const off = [true, false, true, false]
    expect(placeholderMenuIndex('ArrowDown', -1, off)).toBe(1)
    expect(placeholderMenuIndex('ArrowUp', -1, off)).toBe(3)
    expect(placeholderMenuIndex('ArrowDown', 3, off)).toBe(1)
    expect(placeholderMenuIndex('ArrowUp', 1, off)).toBe(3)
    expect(placeholderMenuIndex('Home', 3, off)).toBe(1)
    expect(placeholderMenuIndex('End', 1, off)).toBe(3)
    for (const k of ['Enter', ' ', 'Escape', 'Tab']) expect(placeholderMenuIndex(k, 1, off)).toBeNull()
    expect(placeholderMenuIndex('ArrowDown', 0, [true])).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
describe('menu content: sections, a capped library, no stray header', () => {
  it('linked pictures no token names come first (newest first), then the other linked ones', () => {
    const assets = [asset('a'), asset('b'), asset('c'), asset('library')]
    const choices = placeholderChoices('@image_1 @image_?2(Lumi)', assets, ['a', 'b', 'c'])
    expect(choices.map((c) => c.asset.id)).toEqual(['c', 'b', 'a'])
    expect(choices.map((c) => c.section)).toEqual([LINKED_UNUSED, LINKED_UNUSED, LINKED_OTHER])
  })
  it('the library section: pictures with images not linked yet, newest first, capped (the rest counted)', () => {
    const many = Array.from({ length: 300 }, (_, i) => asset(`lib${i}`))
    const assets = [asset('a'), asset('empty', 'Empty', 0), ...many]
    const { choices, more } = libraryChoices(assets, ['a'])
    expect(choices).toHaveLength(PICKER_LIBRARY_MAX)
    expect(choices[0].asset.id).toBe('lib299')
    expect(choices.every((c) => c.section === FROM_LIBRARY && c.asset.imageIds.length && c.asset.id !== 'a')).toBe(true)
    expect(more).toBe(300 - PICKER_LIBRARY_MAX)
    expect(libraryChoices([asset('x'), asset('y')], [])).toEqual({ choices: [expect.objectContaining({ asset: expect.objectContaining({ id: 'y' }) }), expect.objectContaining({ asset: expect.objectContaining({ id: 'x' }) })], more: 0 })
  })
  it('headings: the three sections for red text; a label that does not fit keeps "Gắn ảnh khác…"; never "Gắn ảnh đã nối…" on top', () => {
    const sections = [LINKED_UNUSED, LINKED_UNUSED, LINKED_OTHER, FROM_LIBRARY, FROM_LIBRARY]
    expect(choiceHeadings({ kind: 'label' }, sections)).toEqual([LINKED_UNUSED, null, LINKED_OTHER, FROM_LIBRARY, null])
    expect(choiceHeadings({ kind: 'mismatch' }, sections)).toEqual(['Gắn ảnh khác…', null, null, FROM_LIBRARY, null])
    expect(read('../PlaceholderBar.tsx')).not.toContain('Gắn ảnh đã nối…')
  })
  it('the picker as rendered: section headings, at most the capped library rows, the key footer; a chip menu has no footer', () => {
    const lib = Array.from({ length: 40 }, (_, i) => asset(`lib${i}`))
    const assets = [...project().assets, ...lib]
    const s = current()
    const group = placeholderGroups(s.prompt, assets, s.refs)[0]
    const { choices, more } = libraryChoices(assets, s.refs)
    const base = { sceneId: 's1', group, prompt: s.prompt, refs: s.refs, assets, onClose: () => {}, ignoreRef: { current: null } }
    const html = renderToStaticMarkup(createElement(PlaceholderMenu, { ...base, choices: [...placeholderChoices(s.prompt, assets, s.refs), ...choices], more, picker: true }))
    expect(html).toContain(LINKED_OTHER) // Làng: linked, named by @image_1
    expect(html).toContain(FROM_LIBRARY.replace('&', '&amp;'))
    expect(html).not.toContain('Gắn ảnh đã nối…')
    expect(html.match(/role="menuitem"/g)).toHaveLength(1 + PICKER_LIBRARY_MAX + 2) // Làng, the capped library rows, 2 commands
    expect(html).toContain(`+${more} ảnh khác trong Thư viện`)
    expect(html).toContain('để chọn')
    const chip = renderToStaticMarkup(createElement(PlaceholderMenu, { ...base, choices: placeholderChoices(s.prompt, assets, s.refs) }))
    expect(chip).not.toContain(FROM_LIBRARY.replace('&', '&amp;'))
    expect(chip).not.toContain('in-mention-foot')
  })
})

// ---------------------------------------------------------------------------------------------
describe('library link entry points: explicit offer, one undo per command, never bind by name', () => {
  it.each(['card button', 'selection button', 'card drop'] as const)('%s leaves the red text until the offer is clicked', (entry) => {
    const before = project()
    if (entry === 'card button') linkToScene('s1', 'mira')
    else if (entry === 'selection button') linkAssets(['s1'], ['mira'])
    else linkCardsToNode('s1', ['s1'], ['mira'])
    expect(current().prompt).toBe(prompt) // same name, still red
    expect(current().refs).toEqual(['village', 'mira'])
    expect(steps()).toBe(1)
    const linked = project()
    expect(lastToast().action?.label).toBe('Gắn vào chỗ Lumi')
    lastToast().action!.run()
    expect(current().prompt).toBe('A @image_1 hugs @image_2 here')
    expect(steps()).toBe(2)
    undo()
    expect(project()).toBe(linked)
    undo()
    expect(project()).toBe(before)
  })
  it('the library button commits the prompt being typed first, so the offer sees its red text', () => {
    useProject.getState().setPrompts({ s1: 'old' })
    const off = register('s1', () => useProject.getState().setPrompts({ s1: prompt }))
    try { linkToScene('s1', 'mira') } finally { off() }
    expect(current().prompt).toBe(prompt)
    expect(lastToast().action?.label).toBe('Gắn vào chỗ Lumi')
  })
  it('a mode that sends no reference picture keeps the warning toast (no offer)', () => {
    useProject.getState().updateSettings(['s1'], { model: 'minimax_h3', mode: 't2v' })
    linkToScene('s1', 'mira')
    expect(current().prompt).toBe(prompt)
    expect(lastToast()).toMatchObject({ tone: 'warning', action: { label: 'Hoàn tác' } })
    expect(lastToast().text).toMatch(/không gửi ảnh tham chiếu/)
  })
})

// ---------------------------------------------------------------------------------------------
describe('drop / "Nối & chèn": the offer replaces the insertion step', () => {
  function insert(done = 'Đã nối Lumi vào S01 → @image_2.') {
    const before = project()
    const s = current()
    useProject.getState().setPromptAndRefs('s1', `${s.prompt} @image_2`, [...s.refs, 'mira'])
    linkInsertToastWithFill(before, 's1', ['mira'], done)
    return before
  }
  it('fills at the original slot without leaving an extra token; one undo restores both links and text', () => {
    const before = insert()
    expect(current().prompt).toContain(RED)
    expect(lastToast().action?.label).toBe('Gắn vào chỗ Lumi')
    lastToast().action!.run()
    expect(current().refs).toEqual(['mira', 'village'])
    expect(current().prompt).toBe('A @image_1 hugs @image_2 here')
    expect(steps()).toBe(1)
    undo()
    expect(project()).toBe(before)
    redo()
    expect(current().prompt).toBe('A @image_1 hugs @image_2 here')
  })
  it('the node\'s static-text drop offers it and keeps its tile in the replacement step', () => {
    const before = project()
    insertLinksAtExcerpt('s1', prompt, ['mira'])
    const position = project().assets.find((a) => a.id === 'mira')!.position
    expect(position).not.toBeNull()
    lastToast().action!.run()
    expect(current().prompt).toBe('A @image_1 hugs @image_2 here')
    expect(project().assets.find((a) => a.id === 'mira')!.position).toEqual(position)
    expect(steps()).toBe(1)
    lastToast().action!.run()
    expect(project()).toBe(before)
  })
  it('keeps the text typed meanwhile and removes only the "@…" used for "Nối & chèn"', () => {
    const before = project()
    const draft = `${prompt} with newly typed detail`
    useProject.getState().setPromptAndRefs('s1', `${draft} @image_2`, ['village', 'mira'])
    linkInsertToastWithFill(before, 's1', ['mira'], 'Đã nối Lumi.', draft)
    lastToast().action!.run()
    expect(current().prompt).toBe('A @image_1 hugs @image_2 here with newly typed detail')
    expect(steps()).toBe(1)
    lastToast().action!.run()
    expect(project()).toBe(before)
  })
  it.each(['edit', 'undo', 'draft'] as const)('a stale offer after %s changes nothing', (change) => {
    insert()
    const offer = lastToast().action!
    let off = () => {}
    if (change === 'edit') useProject.getState().updateScene('s1', { title: 'new title' })
    if (change === 'undo') undo()
    if (change === 'draft') off = register('s1', () => useProject.getState().setPrompts({ s1: 'draft text' }))
    const before = project(), count = steps()
    try { offer.run() } finally { off() }
    if (change === 'draft') expect(current().prompt).toBe('draft text')
    else { expect(project()).toBe(before); expect(steps()).toBe(count) }
    expect(lastToast().text).toBe('Đã có thay đổi khác — gắn ở dải dưới ô prompt.')
  })
  it('an insertion made inside a larger undo step (image files on a node) never offers the dead button', async () => {
    const before = project()
    let inner: typeof before | null = null
    await filesToSceneTiles('s1', [png('Nova.png')], (created) => {
      inner = project()
      const plan = planNodeLinks('s1', created)!
      oneUndoStep(() => {
        useProject.getState().setPromptAndRefs('s1', `${current().prompt} ${plan.tokens.join(' ')}`, plan.refs!)
        placeLinkedTiles('s1', created)
      })
      linkInsertToastWithFill(inner, 's1', created, plan.done!)
    })
    expect(inner).not.toBeNull()
    expect(steps()).toBe(1)
    const t = lastToast()
    expect(t.action?.label).toBe('Hoàn tác')
    expect(t.text).toBe('Đã nối Nova → S01 (@image_2) · S01 còn chữ đỏ — chọn ở dải dưới ô prompt.')
    t.action!.run()
    expect(project()).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------
describe('toast wording (§3.4: "Đã nối Mira → S03. S03 còn chữ đỏ @image_?2(Lumi). Ctrl+Z để bỏ nối.")', () => {
  it('linkSentence drops the closing period and either undo hint', () => {
    expect(linkSentence('Đã nối Lumi → S01 (@image_2). Ctrl+Z để bỏ nối.')).toBe('Đã nối Lumi → S01 (@image_2)')
    expect(linkSentence('Đã nối Lumi → S01 (@image_2). ⌘+Z để bỏ nối.')).toBe('Đã nối Lumi → S01 (@image_2)')
    expect(linkSentence('Đã nối Lumi vào S01 → @image_2.')).toBe('Đã nối Lumi vào S01 → @image_2')
    expect(linkSentence('Đã chèn @image_2 vào S01')).toBe('Đã chèn @image_2 vào S01')
  })
  it('node editor (planNodeLinks text): one sentence, one undo hint, the scene code', () => {
    insertLinksAtExcerpt('s1', prompt, ['mira'])
    expect(lastToast().text).toBe(`Đã nối Lumi → S01 (@image_2). S01 còn chữ đỏ ${RED}. ${undoHint}`)
    expect(lastToast().text.match(/để bỏ nối/g)).toHaveLength(1)
  })
  it('inspector editor (planAssets / "Nối & chèn" text)', () => {
    insert()
    expect(lastToast().text).toBe(`Đã nối Lumi vào S01 → @image_2. S01 còn chữ đỏ ${RED}. ${undoHint}`)
    function insert() {
      const before = project()
      useProject.getState().setPromptAndRefs('s1', `${prompt} @image_2`, ['village', 'mira'])
      linkInsertToastWithFill(before, 's1', ['mira'], 'Đã nối Lumi vào S01 → @image_2.')
    }
  })
  it('red text the offer does not cover (two pictures): the bar\'s pointer, no ". ·"', () => {
    useProject.getState().loadProject({ ...project(), assets: [...project().assets, asset('nova', 'Nova')] })
    useProject.temporal.getState().clear()
    insertLinksAtExcerpt('s1', prompt, ['mira', 'nova'])
    expect(lastToast().text).toBe('Đã nối Lumi, Nova → S01 (@image_2 @image_3) · S01 còn chữ đỏ — chọn ở dải dưới ô prompt.')
    expect(lastToast().action?.label).toBe('Hoàn tác')
  })
  it('no red text: the usual toast, unchanged', () => {
    useProject.getState().setPrompts({ s1: 'A hugs @image_1 here' })
    useProject.temporal.getState().clear()
    insertLinksAtExcerpt('s1', 'A', ['mira'])
    expect(lastToast().text).toMatch(/^Đã nối Lumi → S01 \(@image_2\)\. (Ctrl|⌘)\+Z để bỏ nối\.$/)
  })
})

// ---------------------------------------------------------------------------------------------
describe('ONE picture dropped on red text: the shared fill path of both editors', () => {
  it.each(inside)('offset %i: the inspector path (fillAtOffsetAction) fills — no tile; one undo step', (at) => {
    const before = project()
    expect(fillAtOffsetAction('s1', at, ['mira'])).toBe(true)
    expect(current().prompt).toBe('A @image_1 hugs @image_2 here')
    expect(project().assets.find((a) => a.id === 'mira')!.position).toBeNull()
    expect(steps()).toBe(1)
    undo()
    expect(project()).toBe(before)
  })
  it('the node path (fillAtOffset) also places the card\'s tile in that step; the edges and two pictures are no fill', () => {
    expect(fillAtOffset('s1', redStart, ['mira'])).toBe(false)
    expect(fillAtOffset('s1', redStart + RED.length, ['mira'])).toBe(false)
    expect(fillAtOffsetAction('s1', redStart + 3, ['mira', 'village'])).toBe(false)
    expect(steps()).toBe(0)
    expect(fillAtOffset('s1', redStart + 3, ['mira'])).toBe(true)
    expect(project().assets.find((a) => a.id === 'mira')!.position).not.toBeNull()
    expect(steps()).toBe(1)
  })
  it('an image FILE dropped on red text fills it: the new tile + the fill in ONE step; its toast "Hoàn tác" takes back both', async () => {
    const before = project()
    const ids = await filesToSceneTiles('s1', [png('Mira.png')], (created) => {
      expect(fillAtOffset('s1', redStart + 4, created)).toBe(true)
    })
    expect(ids).toHaveLength(1)
    expect(current().prompt).toBe('A @image_1 hugs @image_2 here')
    expect(current().refs).toEqual([ids[0], 'village'])
    expect(steps()).toBe(1)
    const t = lastToast()
    expect(t.text).toMatch(/^Đã gắn Mira vào chỗ của Lumi → @image_1\./)
    t.action!.run()
    expect(project()).toBe(before)
  })
  it('both editors drop through these helpers and route the picker the same way', () => {
    const panel = read('../PromptEditor.tsx')
    const node = read('../../canvas/SceneNodeEditor.tsx')
    expect(panel).toContain('if (fillAtOffsetAction(sceneId, point, ids)) return')
    expect(node).toContain('if (!fillAtOffset(sceneId, point, ids)) insertLinks(ids)')
    expect(node).toContain('!fillAtOffset(sceneId, point, created)) insertLinks(created)')
    for (const src of [panel, node]) {
      expect(src).toContain("picker.update(value, selStart, selEnd, typing ? 'type' : 'move')")
      expect(src).toContain("picker.update(ta.value, ta.selectionStart, ta.selectionEnd, 'click')")
      expect(src).toContain('picker.onBlur(e.relatedTarget)')
      expect(src).toContain('{picker.popup}')
      expect(src).toContain('!picker.open && mention')
      expect(src).toContain('aria-controls={picker.open ? picker.menuId : undefined}')
      // aria-expanded is not allowed on a textbox: the picker never sets it
      expect(src).not.toMatch(/aria-expanded=\{picker/)
      expect(src).not.toMatch(/groupAtOffset\(/)
    }
    expect(panel.match(/linkInsertToastWithFill\(before, sceneId,/g)).toHaveLength(2)
    expect(node.match(/linkInsertToastWithFill\(/g)).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------------------------
describe('explicit fill and text commands shared by the bar and both pickers', () => {
  it.each(['picker', 'node drop', 'static red text drop'] as const)('%s fills only the chosen group, in one undo step', (entry) => {
    const before = project()
    if (entry === 'picker') expect(fillPlaceholderAction('s1', 'L:Lumi', 'mira')).toBe(true)
    else if (entry === 'node drop') expect(fillFromDrop('s1', 'L:Lumi', 'mira')).toBe(true)
    else expect(insertLinksAtExcerpt('s1', 'A @image_?', ['mira'])).toBe(true)
    expect(current().prompt).toBe('A @image_1 hugs @image_2 here')
    expect(steps()).toBe(1)
    lastToast().action!.run()
    expect(project()).toBe(before)
  })
  it.each(['empty', 'missing', 'full', 'stale'] as const)('a refused %s choice changes no data or undo history', (why) => {
    if (why === 'full') {
      useProject.getState().updateAsset('village', { imageIds: Array.from({ length: MODELS[current().settings.model].maxRefImages }, (_, i) => `v${i}`) })
    }
    const before = project(), count = steps()
    expect(fillPlaceholderAction('s1', why === 'stale' ? 'L:gone' : 'L:Lumi', why === 'empty' ? 'empty' : why === 'missing' ? 'deleted' : 'mira')).toBe(false)
    expect(project()).toBe(before)
    expect(steps()).toBe(count)
  })
  it('a picture without images is refused with its reason (the picker shows it disabled)', () => {
    expect(planFill({ prompt, refs: ['village'] }, project().assets, 'L:Lumi', 'empty', { renumber: true, maxImages: 9 })).toEqual({ ok: false, why: 'no-image' })
    expect(planFill({ prompt, refs: ['village'] }, project().assets, 'L:Lumi', 'mira', { renumber: true, maxImages: 1 })).toEqual({ ok: false, why: 'over-limit' })
  })
  it('several pictures dropped inside red text are inserted after the entire label', () => {
    insertLinksAtExcerpt('s1', 'A @image_?1(Lu', ['mira', 'village'])
    expect(current().prompt).toBe('A @image_?1(Lumi) @image_2 @image_1 hugs @image_1 here')
    expect(steps()).toBe(1)
    undo()
    expect(current().prompt).toBe(prompt)
  })
  it('a drop on a stale chip never fills the remaining, unrelated group', () => {
    const before = project()
    expect(fillFromDrop('s1', 'L:gone', 'mira')).toBe(true)
    expect(project()).toBe(before)
    expect(steps()).toBe(0)
    expect(lastToast().tone).toBe('warning')
  })
  it.each([
    ['text', 'A Lumi hugs @image_1 here'],
    ['delete', 'A hugs @image_1 here'],
  ])('%s replacement keeps the surrounding text and undoes in one step', (command, expected) => {
    const before = project()
    if (command === 'text') placeholderToTextAction('s1', 'L:Lumi', 'Lumi')
    else removePlaceholderAction('s1', 'L:Lumi')
    expect(current().prompt).toBe(expected)
    expect(steps()).toBe(1)
    undo()
    expect(project()).toBe(before)
  })
  it.each([true, false])('mismatch keep-token command (keep label = %s) keeps the exact text', (keepLabel) => {
    useProject.getState().setPrompts({ s1: 'A @image_1(Lumi) end' })
    const before = project(), count = steps()
    if (keepLabel) splitTokenAction('s1', 'M:@image_1(Lumi)', '@image_1')
    else keepTokenAction('s1', 'M:@image_1(Lumi)', '@image_1')
    expect(current().prompt).toBe(keepLabel ? 'A @image_1 (Lumi) end' : 'A @image_1 end')
    expect(steps()).toBe(count + 1)
    undo()
    expect(project()).toBe(before)
  })
})
