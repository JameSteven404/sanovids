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
import { handleLibraryKey, noteLibraryPointer, registerLibraryView, resetLibraryActionsForTests } from '../libraryActions'
import { useProject } from '../store/project'
import { useUI } from '../store/ui'

type Listener = (e: KeyboardEvent) => void
let listeners: Listener[] = []

const scene = (id: string, order: number, refs: string[] = []): Scene => ({
  id, order, title: '', prompt: '', refs, videoRefs: [], presetId: null,
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
  scenes: [scene('s1', 1, ['a']), scene('s2', 2)],
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

const assetIds = () => useProject.getState().project.assets.map((a) => a.id)
const toastTexts = () => useUI.getState().toasts.map((t) => t.text)
let confirm: Mock<(question: string) => boolean>
let unregister: () => void

beforeEach(() => {
  vi.useFakeTimers()
  listeners = []
  h.deleteSelection.mockReset()
  resetLibraryActionsForTests()
  useProject.getState().loadProject(project())
  useProject.temporal.getState().clear()
  useUI.setState({ dialog: { kind: 'none' }, toasts: [], view: 'canvas', librarySelection: [], selectedIds: ['s2'], draggingAssetIds: null })
  confirm = vi.fn((_question: string) => true)
  vi.stubGlobal('window', {
    confirm,
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners.push(fn)
    },
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((x) => x !== fn)
    },
    dispatchEvent: () => true,
  })
  unregister = registerLibraryView({ visibleIds: () => ['a', 'b', 'c'], collapsed: () => false })
  useShortcuts()
  expect(listeners).toHaveLength(1)
})
afterEach(() => {
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

  it('an item in use asks first; Cancel deletes nothing anywhere', () => {
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

  it('while a card is dragged: swallowed, nothing deleted', () => {
    useUI.setState({ librarySelection: ['c'], draggingAssetIds: ['c'] })
    expect(press({ key: 'Delete', target: inLibrary() })).toBe(true)
    expect(assetIds()).toEqual(['a', 'b', 'c'])
    expect(h.deleteSelection).not.toHaveBeenCalled()
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
    expect(drag).toContain('noteAssetDropOutside()')
    expect(lib).toContain('registerLibraryView(')
    expect(lib).toContain('data-asset-id={asset.id}')
  })
  it('the asset dialog deletes in one click through the shared command (no two-click button)', () => {
    const dlg = src('components/sidebar/AssetDialog.tsx')
    expect(dlg).toContain('deleteLibraryAssets([asset.id])')
    expect(dlg).not.toContain('ConfirmButton')
    expect(dlg).not.toContain('removeAssets(')
  })
  it('a library delete never deletes media blobs', () => {
    expect(src('libraryActions.ts')).not.toMatch(/deleteMedia|imageStore/)
  })
})
