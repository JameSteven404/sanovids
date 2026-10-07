// The library scope of the global shortcut handler (hooks/useShortcuts → libraryActions.handleLibraryKey), driven like
// sceneOrderKeys.test.ts: React's useEffect runs at once, `window` is a small event target. A library-directed Delete
// deletes library items and never the canvas selection (scenes, videos) — the reverse holds too. Windows only deletes
// with Delete (Backspace hints, Unikey / EVKey send it); Mac ⌫ waits 90 ms. Plus source guards on the wiring.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const h = vi.hoisted(() => {
  // A Windows keyboard for this file, whatever machine runs it (useShortcuts reads it when it loads).
  vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'test' })
  return { deleteSelection: vi.fn(), cleanups: [] as Array<() => void> }
})

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect()
      if (typeof cleanup === 'function') h.cleanups.push(cleanup)
    },
  }
})
vi.mock('../actions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../actions')>()
  return { ...real, deleteSelection: h.deleteSelection }
})
// (hoisted above the imports) keep IndexedDB persistence out of a pure-logic test
vi.mock('../store/persist', () => ({ flush: async () => true }))

import type { Project, Scene } from '../core/types'
import { useShortcuts } from '../hooks/useShortcuts'
import { handleLibraryKey, libraryArea, noteLibraryPointer, registerLibraryView, resetLibraryActionsForTests } from '../libraryActions'
import { answerConfirm, useConfirm } from '../store/confirm'
import { useProject } from '../store/project'
import { useUI } from '../store/ui'

type Listener = (e: KeyboardEvent) => void
let listeners: Listener[] = []
/** The pointerdown listeners installed on the window stub, with their capture flag. */
let pointerListeners: Array<{ fn: (e: { target: unknown }) => void; capture: unknown }> = []

const scene = (id: string, order: number, refs: string[] = [], prompt = ''): Scene => ({
  id, order, title: '', prompt, refs, videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: order * 400 }, note: '',
})
const project = (): Project => ({
  id: 'p', name: 'P', schemaVersion: 2, createdAt: 0, updatedAt: 0, presets: [], settings: { autoRenumber: true },
  assets: [
    { id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1'], color: '#fff', position: null },
    { id: 'b', kind: 'character', name: 'Lumi', tag: 'Lumi', description: '', imageIds: ['i2'], color: '#fff', position: null },
    { id: 'c', kind: 'prop', name: 'Spare', tag: 'Spare', description: '', imageIds: ['i3'], color: '#fff', position: null },
  ],
  scenes: [scene('s1', 1, ['a'], '@image_1 walks'), scene('s2', 2)],
})

/** Fake elements, duck-typed like libraryActions reads them. */
const inLibrary = (tagName = 'DIV') => ({ tagName, blur: vi.fn(), closest: (s: string) => (s === '.sb-library' ? {} : null) })
const outside = (tagName = 'DIV') => ({ tagName, blur: vi.fn(), closest: () => null })
const BODY = { tagName: 'BODY', closest: () => null }

interface FakeKey {
  key: string
  code?: string
  altKey?: boolean
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  repeat?: boolean
  isComposing?: boolean
  target?: unknown
}

/** Dispatch a keydown to the installed handler; returns whether the handler prevented the default. */
function press(init: FakeKey): boolean {
  const e = {
    code: init.key,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    target: null,
    ...init,
    preventDefault() {
      this.defaultPrevented = true
    },
  }
  for (const fn of listeners) fn(e as unknown as KeyboardEvent)
  return e.defaultPrevented
}

/** A pointerdown through the listeners the library installed (as the browser would dispatch it). */
function click(target: unknown): void {
  for (const l of pointerListeners) l.fn({ target })
}

const assetIds = () => useProject.getState().project.assets.map((a) => a.id)
const toastTexts = () => useUI.getState().toasts.map((t) => t.text)
let confirm: Mock<(question: string) => boolean>
let unregister: () => void
let offConfirm: () => void
let collapsed: boolean

beforeEach(() => {
  vi.useFakeTimers()
  listeners = []
  pointerListeners = []
  collapsed = false
  h.deleteSelection.mockReset()
  resetLibraryActionsForTests()
  useProject.getState().loadProject(project())
  useProject.temporal.getState().clear()
  useUI.setState({ dialog: { kind: 'none' }, toasts: [], view: 'canvas', librarySelection: [], selectedIds: ['s2'], draggingAssetIds: null })
  confirm = vi.fn((_question: string) => true)
  // The question shows in the app's own dialog (store/confirm): answered here as the user would; no window.confirm.
  offConfirm = useConfirm.subscribe((s) => {
    if (s.request) answerConfirm(confirm(s.request.text))
  })
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener, capture?: unknown) => {
      if (type === 'keydown') listeners.push(fn)
      if (type === 'pointerdown') pointerListeners.push({ fn: fn as unknown as (e: { target: unknown }) => void, capture })
    },
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((x) => x !== fn)
      if (type === 'pointerdown') pointerListeners = pointerListeners.filter((x) => x.fn !== (fn as unknown))
    },
    dispatchEvent: () => true,
  })
  unregister = registerLibraryView({ visibleIds: () => ['a', 'b', 'c'], collapsed: () => collapsed })
  useShortcuts()
  expect(listeners).toHaveLength(1)
})
afterEach(() => {
  offConfirm()
  answerConfirm(false)
  for (const cleanup of h.cleanups.splice(0)) cleanup()
  unregister()
  vi.unstubAllGlobals()
  vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'test' })
  vi.useRealTimers()
})

describe('Delete in the library', () => {
  it('on a focused card: deletes the library selection at once, never the selected scene', () => {
    useUI.setState({ librarySelection: ['c'] })
    expect(press({ key: 'Delete', target: inLibrary() })).toBe(true)
    expect(assetIds()).toEqual(['a', 'b'])
    expect(h.deleteSelection).not.toHaveBeenCalled()
    expect(useProject.getState().project.scenes.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('from a button inside the library too (card buttons, the footer)', () => {
    useUI.setState({ librarySelection: ['c'] })
    press({ key: 'Delete', target: inLibrary('BUTTON') })
    expect(assetIds()).toEqual(['a', 'b'])
    expect(h.deleteSelection).not.toHaveBeenCalled()
  })

  it('nothing selected in the library: a hint, and still never the canvas', () => {
    expect(press({ key: 'Delete', target: inLibrary() })).toBe(true)
    expect(h.deleteSelection).not.toHaveBeenCalled()
    expect(toastTexts().join()).toContain('Chưa chọn thẻ nào trong Thư viện')
  })

  it('an item whose delete blocks a scene asks first (in the app\'s dialog); Cancel deletes nothing anywhere', () => {
    confirm.mockReturnValue(false)
    useUI.setState({ librarySelection: ['a'] })
    press({ key: 'Delete', target: inLibrary() })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(assetIds()).toEqual(['a', 'b', 'c'])
    expect(h.deleteSelection).not.toHaveBeenCalled()
  })

  it('held down (repeat): nothing more is deleted, and nothing reaches the canvas', () => {
    useUI.setState({ librarySelection: ['c'] })
    press({ key: 'Delete', target: inLibrary() })
    useUI.setState({ librarySelection: ['b'] })
    expect(press({ key: 'Delete', target: inLibrary(), repeat: true })).toBe(true)
    expect(assetIds()).toEqual(['a', 'b'])
    expect(h.deleteSelection).not.toHaveBeenCalled()
  })

  it('focus on the page after a click in the library: the library; after a click on the canvas: the canvas', () => {
    useUI.setState({ librarySelection: ['c'] })
    noteLibraryPointer(inLibrary() as unknown as EventTarget)
    press({ key: 'Delete', target: BODY })
    expect(assetIds()).toEqual(['a', 'b'])
    expect(h.deleteSelection).not.toHaveBeenCalled()
    useUI.setState({ librarySelection: ['b'] })
    noteLibraryPointer(outside() as unknown as EventTarget)
    press({ key: 'Delete', target: BODY })
    expect(h.deleteSelection).toHaveBeenCalledTimes(1)
    expect(assetIds()).toEqual(['a', 'b'])
  })

  it('focus outside the library (a canvas node): the canvas, as before', () => {
    useUI.setState({ librarySelection: ['c'] })
    press({ key: 'Delete', target: outside() })
    expect(h.deleteSelection).toHaveBeenCalledTimes(1)
    expect(assetIds()).toEqual(['a', 'b', 'c'])
  })

  it('typing in a field (even inside the library) or a dialog open: nothing at all', () => {
    useUI.setState({ librarySelection: ['c'] })
    for (const tagName of ['INPUT', 'TEXTAREA']) expect(press({ key: 'Delete', target: inLibrary(tagName) }), tagName).toBe(false)
    useUI.setState({ dialog: { kind: 'asset', assetId: 'c' } })
    press({ key: 'Delete', target: inLibrary() })
    expect(assetIds()).toEqual(['a', 'b', 'c'])
    expect(h.deleteSelection).not.toHaveBeenCalled()
  })

  it('library collapsed (focus on its header): a hint, nothing deleted, and still never the canvas', () => {
    collapsed = true
    useUI.setState({ librarySelection: ['c'] })
    expect(press({ key: 'Delete', target: inLibrary('BUTTON') })).toBe(true)
    expect(toastTexts()).toEqual(['Thư viện đang thu gọn — mở Thư viện để xoá các thẻ đã chọn, hoặc bấm vào canvas để xoá trên canvas.'])
    expect(assetIds()).toEqual(['a', 'b', 'c'])
    expect(h.deleteSelection).not.toHaveBeenCalled()
    // Ctrl+A too: a hint, neither the library nor every scene gets selected
    expect(press({ key: 'a', code: 'KeyA', ctrlKey: true, target: inLibrary('BUTTON') })).toBe(true)
    expect(toastTexts()).toEqual(['Thư viện đang thu gọn — mở Thư viện để chọn thẻ, hoặc bấm vào canvas để chọn mọi cảnh.'])
    expect(useUI.getState().librarySelection).toEqual(['c'])
    expect(useUI.getState().selectedIds).toEqual(['s2'])
  })

  it('while a card is dragged: swallowed, nothing deleted', () => {
    useUI.setState({ librarySelection: ['c'], draggingAssetIds: ['c'] })
    expect(press({ key: 'Delete', target: inLibrary() })).toBe(true)
    expect(assetIds()).toEqual(['a', 'b', 'c'])
    expect(h.deleteSelection).not.toHaveBeenCalled()
  })
})

describe('the area follows real pointerdowns (the listener registerLibraryView installs)', () => {
  it('one capture listener on window', () => {
    expect(pointerListeners).toHaveLength(1)
    expect(pointerListeners[0].capture).toBe(true)
  })

  it('click in the library, Delete on the page: library items go; click on the canvas: the canvas', () => {
    useUI.setState({ librarySelection: ['c'] })
    click(inLibrary())
    expect(libraryArea()).toBe('library')
    press({ key: 'Delete', target: BODY })
    expect(assetIds()).toEqual(['a', 'b'])
    expect(h.deleteSelection).not.toHaveBeenCalled()
    useUI.setState({ librarySelection: ['b'] })
    click(outside())
    expect(libraryArea()).toBe('app')
    press({ key: 'Delete', target: BODY })
    expect(h.deleteSelection).toHaveBeenCalledTimes(1)
    expect(assetIds()).toEqual(['a', 'b'])
  })
})

describe('a canvas command from the keyboard moves the delete keys to the canvas', () => {
  const commands: Array<[string, FakeKey]> = [
    ['N (next scene)', { key: 'n', code: 'KeyN' }],
    ['Ctrl+D (duplicate)', { key: 'd', code: 'KeyD', ctrlKey: true }],
    ['Alt+Up (move scene)', { key: 'ArrowUp', code: 'ArrowUp', altKey: true }],
  ]
  for (const [name, init] of commands) {
    it(name + ' with the focus left on a library card: the card loses it, the next Delete acts on the canvas', () => {
      const card = inLibrary()
      vi.stubGlobal('document', { activeElement: card })
      useUI.setState({ librarySelection: ['c'] })
      click(card)
      press({ ...init, target: card })
      expect(libraryArea()).toBe('app')
      expect(card.blur).toHaveBeenCalledTimes(1)
      // the browser moved the focus to the page when the card was blurred
      press({ key: 'Delete', target: BODY })
      expect(h.deleteSelection).toHaveBeenCalledTimes(1)
      expect(assetIds()).toEqual(['a', 'b', 'c'])
    })
  }

  it('Ctrl+A on the canvas (focus on a canvas node after a click in the library) too', () => {
    useUI.setState({ librarySelection: ['c'] })
    click(inLibrary())
    press({ key: 'a', code: 'KeyA', ctrlKey: true, target: outside() })
    expect(useUI.getState().selectedIds).toEqual(['s1', 's2'])
    press({ key: 'Delete', target: BODY })
    expect(h.deleteSelection).toHaveBeenCalledTimes(1)
    expect(assetIds()).toEqual(['a', 'b', 'c'])
  })

  it('N without any library focus still makes the next scene (the command itself is unchanged)', () => {
    const before = useProject.getState().project.scenes.length
    press({ key: 'n', code: 'KeyN', target: BODY })
    expect(useProject.getState().project.scenes.length).toBe(before + 1)
  })
})

describe('Backspace in the library (Windows)', () => {
  it('never deletes; after 90 ms without another key, a hint names the Delete key', () => {
    useUI.setState({ librarySelection: ['c'] })
    expect(press({ key: 'Backspace', target: inLibrary() })).toBe(true)
    expect(toastTexts()).toEqual([])
    vi.advanceTimersByTime(90)
    expect(toastTexts()).toEqual(['Bấm phím Delete (Del) để xoá — Backspace dành cho bộ gõ tiếng Việt.'])
    expect(assetIds()).toEqual(['a', 'b', 'c'])
    expect(h.deleteSelection).not.toHaveBeenCalled()
  })

  it('a letter right after it (Unikey / EVKey rewriting a letter) cancels the hint', () => {
    press({ key: 'Backspace', target: inLibrary() })
    press({ key: 'ê', code: 'KeyE', target: inLibrary() })
    vi.advanceTimersByTime(200)
    expect(toastTexts()).toEqual([])
  })

  it('held down: no hint per repeat', () => {
    press({ key: 'Backspace', target: inLibrary() })
    press({ key: 'Backspace', target: inLibrary(), repeat: true })
    vi.advanceTimersByTime(200)
    expect(toastTexts()).toEqual([])
  })
})

describe('Ctrl+A', () => {
  it('in the library: every visible card, not every scene', () => {
    useUI.setState({ selectedIds: [] })
    expect(press({ key: 'a', code: 'KeyA', ctrlKey: true, target: inLibrary() })).toBe(true)
    expect(useUI.getState().librarySelection).toEqual(['a', 'b', 'c'])
    expect(useUI.getState().selectedIds).toEqual([])
  })

  it('elsewhere: every scene on the canvas, as before', () => {
    press({ key: 'a', code: 'KeyA', ctrlKey: true, target: outside() })
    expect(useUI.getState().selectedIds).toEqual(['s1', 's2'])
    expect(useUI.getState().librarySelection).toEqual([])
  })
})

describe('Mac ⌫ in the library (handleLibraryKey with Mac rules)', () => {
  const key = (init: FakeKey) => ({ code: init.key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null as unknown as EventTarget, preventDefault: vi.fn(), ...init }) as Parameters<typeof handleLibraryKey>[0]

  it('⌫ deletes after the grace period; ⌘⌫ at once', () => {
    useUI.setState({ librarySelection: ['c'] })
    expect(handleLibraryKey(key({ key: 'Backspace', target: inLibrary() }), true)).toBe(true)
    expect(assetIds()).toEqual(['a', 'b', 'c'])
    vi.advanceTimersByTime(90)
    expect(assetIds()).toEqual(['a', 'b'])
    useUI.setState({ librarySelection: ['b'] })
    confirm.mockReturnValue(true)
    expect(handleLibraryKey(key({ key: 'Backspace', metaKey: true, target: inLibrary() }), true)).toBe(true)
    expect(assetIds()).toEqual(['a'])
  })

  it('any key within the grace period cancels the ⌫ (an input tool rewriting a letter)', () => {
    useUI.setState({ librarySelection: ['c'] })
    handleLibraryKey(key({ key: 'Backspace', target: inLibrary() }), true)
    press({ key: 'ê', code: 'KeyE', target: inLibrary() })
    vi.advanceTimersByTime(200)
    expect(assetIds()).toEqual(['a', 'b', 'c'])
  })
})

describe('wiring (source guards)', () => {
  const src = (rel: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8')
  it('the dispatcher asks the library before any canvas delete / select-all rule, after the typing / dialog guard', () => {
    // (K2 may rewire the dispatcher on core/keymap: keep handleLibraryKey ahead of decideShortcut / the canvas rules.)
    const code = src('hooks/useShortcuts.ts')
    const onKey = code.slice(code.indexOf('const onKey'))
    const lib = onKey.indexOf('if (handleLibraryKey(e')
    expect(lib).toBeGreaterThan(0)
    expect(lib).toBeGreaterThan(onKey.indexOf('if (typing || dialogOpen) return'))
    const canvasRules = ["key === 'a'", 'deleteKeyAction(key', 'decideShortcut(e'].map((s) => onKey.indexOf(s)).filter((i) => i >= 0)
    expect(canvasRules.length).toBeGreaterThan(0)
    for (const at of canvasRules) expect(lib).toBeLessThan(at)
    // any key cancels a waiting library ⌫ / Backspace, before the first early return
    expect(onKey.indexOf('cancelLibraryKey()')).toBeGreaterThan(0)
    expect(onKey.indexOf('cancelLibraryKey()')).toBeLessThan(onKey.indexOf('return'))
  })
  it('library cards no longer swallow Delete, and a drop outside the library moves the delete keys to the canvas', () => {
    const lib = src('components/sidebar/AssetLibrary.tsx')
    expect(lib).not.toContain('không xoá mục thư viện')
    expect(lib).not.toContain("'block'")
    const drag = lib.slice(lib.indexOf('function endAssetDrag'), lib.indexOf('function focusLibraryCard'))
    expect(drag).toContain('assetDragEnded(e.dataTransfer.dropEffect)')
    expect(lib).toContain('registerLibraryView(')
    expect(lib).toContain('data-asset-id={asset.id}')
  })
  it('the asset dialog deletes in one click through the shared command (no two-click button), closing once it is gone', () => {
    const dlg = src('components/sidebar/AssetDialog.tsx')
    expect(dlg).toContain('deleteLibraryAssets([asset.id], { onDeleted: onClose })')
    expect(dlg).not.toContain('ConfirmButton')
    expect(dlg).not.toContain('removeAssets(')
  })
  it('one delete flow asks in the app\'s own dialog: no window.confirm in the library delete, a ConfirmSheet at the root', () => {
    for (const file of ['libraryActions.ts', 'components/sidebar/AssetDialog.tsx', 'components/sidebar/AssetLibrary.tsx']) {
      expect(src(file), file).not.toMatch(/window\.confirm\(|\bconfirm\(/)
    }
    expect(src('libraryActions.ts')).toContain('askConfirm({')
    expect(src('App.tsx')).toContain('<ConfirmSheet />')
    expect(src('components/common/ConfirmSheet.tsx')).toContain('layer="top"')
  })
  it('"+ Nối" on a card offers "Gắn vào chỗ…" when the scene still waits for a picture (GT1 linkToastWithFill)', () => {
    expect(src('components/sidebar/AssetLibrary.tsx')).toContain('linkToastWithFill(before, p, [assetId], text)')
  })
  it('the dispatcher marks canvas commands (N, Ctrl+D, canvas Ctrl+A, Alt+Up/Down) right before running them', () => {
    const code = src('hooks/useShortcuts.ts')
    const onKey = code.slice(code.indexOf('const onKey'))
    for (const call of ['duplicateSelection()', 'ui.select(useProject', 'moveSelectedScene(step)', 'nextScene()']) {
      const at = onKey.indexOf(call)
      expect(at, call).toBeGreaterThan(0)
      expect(onKey.slice(Math.max(0, at - 40), at), call).toContain('noteCanvasCommand()')
    }
  })
  it('the shortcuts help has a library group with its Delete and Ctrl+A', () => {
    const dlg = src('components/dialogs/ShortcutsDialog.tsx')
    const at = dlg.indexOf("title: 'Thư viện'")
    expect(at).toBeGreaterThan(0)
    const group = dlg.slice(at, dlg.indexOf("title: 'Canvas'"))
    expect(group).toContain("IS_MAC ? 'Delete / ⌫' : 'Delete'")
    expect(group).toContain("['Ctrl+A', 'Sau khi bấm vào Thư viện: chọn mọi thẻ đang thấy']")
  })
  it('a library delete never deletes media blobs', () => {
    expect(src('libraryActions.ts')).not.toMatch(/deleteMedia|imageStore/)
  })
})
