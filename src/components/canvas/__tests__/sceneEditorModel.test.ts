import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCanvasPrefs } from '../../../lib/canvasPrefs'
import { register } from '../../../lib/promptDrafts'
import { useProject } from '../../../store/project'
import { useSceneEditor } from '../../../store/sceneEditor'
import { useUI } from '../../../store/ui'
import {
  caretFromExcerptHit, counterLabel, editorClickIntent, editorPanViewport, editorScale,
  editorShouldStayOpen, editorWidth, enterOpensEditor, nodeEditorKeyBubbles, runButtonLabel,
  type EditorContext,
} from '../sceneEditorModel'

describe('editor geometry', () => {
  it.each([0.15, 0.45, 1, 1.1, 1.25, 2])('counter-scales at zoom %s', (zoom) => {
    const { E, k } = editorScale(zoom)
    expect(E).toBe(Math.min(1.25, Math.max(1, zoom)))
    expect(k * zoom).toBeCloseTo(E)
  })
  it('covers the card without shrinking below the preferred local width', () => {
    expect(editorWidth(380, 280, 0.45)).toBe(380)
    expect(editorWidth(340, 640, 1)).toBe(640)
    expect(editorWidth(380, 640, 2)).toBe(1024)
  })
  const stage = { w: 1000, h: 900, bottom: 100 }
  const vp = { x: 0, y: 0, zoom: 0.45 }
  const box = { x: 100, y: 200, w: 380, h: 600 }
  it('does nothing when the editor fits', () => {
    expect(editorPanViewport(box, vp, stage)).toBeNull()
  })
  it.each([
    [{ ...box, x: 1600 }, { ...vp, x: -132 }],
    [{ ...box, x: -100 }, { ...vp, x: 77 }],
    [{ ...box, y: 700 }, { ...vp, y: -139 }],
    [{ ...box, y: -100 }, { ...vp, y: 109 }],
  ])('pans an obscured editor without changing zoom', (b, expected) => {
    expect(editorPanViewport(b, vp, stage)).toEqual(expected)
  })
  it('reserves the drawer and pins oversized panels at their reachable top-left', () => {
    expect(editorPanViewport(box, vp, { ...stage, bottom: 300 })).toEqual({ ...vp, y: -26 })
    expect(editorPanViewport({ ...box, w: 2000, h: 2000 }, vp, stage)).toEqual({ ...vp, x: -13, y: -26 })
    expect(editorPanViewport({ x: 100, y: 100, w: 380, h: 300 }, { ...vp, zoom: 2 }, stage)).toBeNull()
  })
})

describe('editor keys', () => {
  const key = (key: string, patch = {}) => ({ key, ctrlKey: false, metaKey: false, ...patch })
  const typing = (e: ReturnType<typeof key>) => e.ctrlKey && ['s', 'Enter'].includes(e.key) || e.key === 'F8'
  it.each(['Delete', 'Backspace', 'n', 'c', 'f', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'])('contains %s', (k) => {
    expect(nodeEditorKeyBubbles(key(k), typing)).toBe(false)
  })
  it.each(['Escape', 'Control', 'Shift', 'Meta', 'Alt', 'AltGraph', 'CapsLock', 'Process', 'Dead', 'Unidentified'])('contains %s even with a permissive predicate', (k) => {
    expect(nodeEditorKeyBubbles(key(k, { ctrlKey: true }), () => true)).toBe(false)
  })
  it('honours injected bindings and contains IME / already handled runs', () => {
    expect(nodeEditorKeyBubbles(key('s', { ctrlKey: true }), typing)).toBe(true)
    expect(nodeEditorKeyBubbles(key('Enter', { ctrlKey: true }), typing)).toBe(true)
    expect(nodeEditorKeyBubbles(key('F8'), typing)).toBe(true)
    expect(nodeEditorKeyBubbles(key('s', { ctrlKey: true }), () => false)).toBe(false)
    for (const patch of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
      expect(nodeEditorKeyBubbles(key('Enter', { ctrlKey: true, ...patch }), typing)).toBe(false)
    }
  })
})

describe('editor open/close decisions', () => {
  const context: EditorContext = { sceneId: 's1', projectId: 'p1', currentProjectId: 'p1', sceneExists: true, selectedIds: ['s1'], view: 'canvas', nodeEditor: 'click' }
  it('stays open through dialogs, blur, edits and off-screen movement', () => {
    expect(editorShouldStayOpen(context)).toBe(true)
    expect(editorShouldStayOpen({ ...context, nodeEditor: 'select' })).toBe(true)
  })
  it.each<Partial<EditorContext>>([
    { sceneId: null }, { currentProjectId: 'p2' }, { sceneExists: false }, { selectedIds: [] },
    { selectedIds: ['s2'] }, { selectedIds: ['s1', 's2'] }, { view: 'table' }, { view: 'storyboard' }, { nodeEditor: 'off' },
  ])('closes when its context is lost: %j', (patch) => {
    expect(editorShouldStayOpen({ ...context, ...patch })).toBe(false)
  })
  // Structural target stub: no DOM runtime required; selector matching belongs to the browser.
  const target = (matches: string[], field: string | null = null) => ({
    closest: (selector: string) => selector.split(', ').some((s) => matches.includes(s)) ? { getAttribute: () => field } : null,
  })
  it('opens prompt / settings clicks, and select mode does not steal focus', () => {
    expect(editorClickIntent(target(['.cv-prompt-box']), 'click', {})).toEqual({ focus: 'prompt' })
    for (const field of ['prompt', 'title', 'preset', 'model', 'mode', 'duration', 'resolution', 'ratio']) {
      expect(editorClickIntent(target(['[data-edit]'], field), 'click', {})).toEqual({ focus: field })
    }
    expect(editorClickIntent(target([]), 'click', {})).toBeNull()
    expect(editorClickIntent(target([]), 'select', {})).toEqual({ focus: null })
    expect(editorClickIntent(target(['[data-edit]'], 'unknown'), 'click', {})).toBeNull()
  })
  it('ignores off mode, modified clicks, text edits and resize handles', () => {
    const prompt = target(['.cv-prompt-box'])
    expect(editorClickIntent(prompt, 'off', {})).toBeNull()
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
      expect(editorClickIntent(prompt, 'select', { [modifier]: true })).toBeNull()
    }
    for (const selector of ['input', 'textarea', 'select', '[contenteditable="true"]', '.react-flow__resize-control']) {
      expect(editorClickIntent(target([selector]), 'select', {})).toBeNull()
    }
  })
  it('lets Enter activate native / ARIA controls', () => {
    for (const selector of ['button', 'a[href]', 'summary', 'input', 'textarea', 'select', '[contenteditable="true"]', ...['button', 'option', 'tab', 'radio', 'checkbox', 'menuitem'].map((role) => `[role="${role}"]`)]) {
      expect(enterOpensEditor(target([selector]))).toBe(false)
    }
    expect(enterOpensEditor(target([]))).toBe(true)
    expect(enterOpensEditor(null)).toBe(true)
  })
})

describe('editor text', () => {
  it('maps excerpt hits including tokens, newlines and surrogate pairs in UTF-16', () => {
    const prompt = 'Bé 👋\n@image_1 bước tới'
    expect(caretFromExcerptHit(prompt, 'Bé 👋\n@image_')).toBe('Bé 👋\n@image_'.length)
    expect(caretFromExcerptHit(prompt, '')).toBe(0)
    expect(caretFromExcerptHit('', '')).toBe(0)
    expect(caretFromExcerptHit(prompt, null)).toBeNull()
    expect(caretFromExcerptHit(prompt, 'Chưa có prompt')).toBeNull()
    expect(caretFromExcerptHit('abc', 'abcd')).toBeNull()
  })
  it.each(['canvasapp', 'dev', 'demo'] as const)('labels %s credits, including zero', (kind) => {
    const unit = kind === 'canvasapp' ? 'credit' : `credit ${kind}`
    expect(runButtonLabel(15, 20, kind)).toBe(`Tạo video · 15 giây · 20 ${unit}`)
    expect(runButtonLabel(5, 0, kind)).toBe(`Tạo video · 5 giây · 0 ${unit}`)
  })
  it('counts code points and formats Vietnamese grouping / over-limit text', () => {
    expect(counterLabel('👋'.repeat(1234), 20000)).toBe('1.234 / 20.000 ký tự')
    expect(counterLabel('a'.repeat(7250), 7000)).toBe('7.250 / 7.000 ký tự · vượt giới hạn')
    expect(counterLabel('é', 1)).toBe('1 / 1 ký tự')
    expect(counterLabel('', 7000)).toBe('0 / 7.000 ký tự')
  })
})

describe('ephemeral scene editor store', () => {
  const originalProject = useProject.getState().project
  const originalUI = useUI.getState()
  const originalPrefs = useCanvasPrefs.getState()
  const unregister: (() => void)[] = []
  afterEach(() => {
    unregister.splice(0).forEach((off) => off())
    useSceneEditor.getState().close()
    useProject.setState({ project: originalProject })
    useUI.setState(originalUI)
    useCanvasPrefs.setState(originalPrefs)
  })
  function setup() {
    useCanvasPrefs.setState({ nodeEditor: 'click' })
    useUI.setState({ view: 'canvas', selectedIds: [] })
    useProject.setState({ project: { ...originalProject, id: 'editor-test', scenes: [
      { id: 's1', prompt: 'hello' }, { id: 's2', prompt: 'world' },
    ] as typeof originalProject.scenes } })
    return useSceneEditor.getState()
  }
  it('selects one scene, repeats focus requests, and flushes before switching / closing', () => {
    const editor = setup()
    const flush = vi.fn(() => expect(useSceneEditor.getState().sceneId).toBe('s1'))
    unregister.push(register('s1', flush))
    editor.open('s1', 'duration', 999)
    expect(useUI.getState().selectedIds).toEqual(['s1'])
    expect(useSceneEditor.getState()).toMatchObject({ sceneId: 's1', focus: 'duration', caret: 5 })
    const seq = useSceneEditor.getState().seq
    editor.open('s1', null)
    expect(useSceneEditor.getState()).toMatchObject({ seq: seq + 1, focus: null, caret: null })
    expect(flush).not.toHaveBeenCalled()
    editor.open('s2')
    expect(flush).toHaveBeenCalledOnce()
    expect(useUI.getState().selectedIds).toEqual(['s2'])
    editor.close()
    expect(useSceneEditor.getState()).toMatchObject({ sceneId: null, focus: null, caret: null })
  })
  it('contains nested close / project notifications while flushing', () => {
    const editor = setup()
    editor.open('s1')
    const flush = vi.fn(() => {
      editor.close()
      useProject.setState((s) => ({ project: { ...s.project, scenes: [...s.project.scenes] } }))
    })
    unregister.push(register('s1', flush))
    useUI.setState({ selectedIds: [] })
    expect(flush).toHaveBeenCalledOnce()
    expect(useSceneEditor.getState().sceneId).toBeNull()
  })
  it.each(['selection', 'view', 'pref', 'deleted', 'project'])('closes on %s', (reason) => {
    const editor = setup()
    editor.open('s1')
    const flush = vi.fn()
    unregister.push(register('s1', flush))
    if (reason === 'selection') useUI.setState({ selectedIds: ['s1', 's2'] })
    if (reason === 'view') useUI.setState({ view: 'table' })
    if (reason === 'pref') useCanvasPrefs.setState({ nodeEditor: 'off' })
    if (reason === 'deleted') useProject.setState((s) => ({ project: { ...s.project, scenes: [] } }))
    if (reason === 'project') useProject.setState((s) => ({ project: { ...s.project, id: 'other' } }))
    expect(useSceneEditor.getState().sceneId).toBeNull()
    expect(flush).toHaveBeenCalledTimes(reason === 'project' || reason === 'deleted' ? 0 : 1)
  })
  it('stays open through dialogs and scene edits without publishing editor updates', () => {
    const editor = setup()
    editor.open('s1')
    const changed = vi.fn()
    const off = useSceneEditor.subscribe(changed)
    try {
      useUI.setState({ dialog: { kind: 'runConfirm', sceneIds: ['s1'] }, queueOpen: true })
      useProject.setState((s) => ({ project: { ...s.project, scenes: s.project.scenes.map((scene) => ({ ...scene, prompt: 'edited', position: { x: -99999, y: -99999 } })) } }))
      expect(useSceneEditor.getState().sceneId).toBe('s1')
      expect(changed).not.toHaveBeenCalled()
    } finally { off() }
  })
  it('does not open missing scenes, off mode or a non-canvas view', () => {
    const editor = setup()
    editor.open('missing')
    useCanvasPrefs.setState({ nodeEditor: 'off' })
    editor.open('s1')
    useCanvasPrefs.setState({ nodeEditor: 'click' })
    useUI.setState({ view: 'table' })
    editor.open('s1')
    expect(useSceneEditor.getState().sceneId).toBeNull()
  })
})
