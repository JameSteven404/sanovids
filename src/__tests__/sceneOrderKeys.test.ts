// The fixed scene-order keys Alt + ↑ / ↓ as the global shortcut handler (hooks/useShortcuts) really dispatches them:
// only with Alt alone, after the typing / dialog guards, key repeat included, and the browser default prevented. The
// handler is driven directly (React's useEffect runs the effect at once, `window` is a small event target), so a
// rewrite of useShortcuts that drops or misplaces the branch fails here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ move: vi.fn(), cleanups: [] as Array<() => void> }))

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
vi.mock('../sceneOrderActions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sceneOrderActions')>()
  return { ...real, moveSelectedScene: h.move }
})
// (hoisted above the imports) keep IndexedDB persistence out of a pure-logic test
vi.mock('../store/persist', () => ({ flush: async () => true }))

import { useShortcuts } from '../hooks/useShortcuts'
import { sceneOrderKey } from '../sceneOrderActions'
import { useUI } from '../store/ui'

type Listener = (e: KeyboardEvent) => void
let listeners: Listener[] = []

interface FakeKey {
  key: string
  code?: string
  altKey?: boolean
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  repeat?: boolean
  isComposing?: boolean
  defaultPrevented?: boolean
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

beforeEach(() => {
  listeners = []
  h.move.mockReset()
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners.push(fn)
    },
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((x) => x !== fn)
    },
    dispatchEvent: () => true,
  })
  useUI.setState({ dialog: { kind: 'none' }, toasts: [] })
  useShortcuts()
  expect(listeners).toHaveLength(1)
})
afterEach(() => {
  for (const cleanup of h.cleanups.splice(0)) cleanup()
  vi.unstubAllGlobals()
})

describe('sceneOrderKey', () => {
  it('Alt + ↑ is one place earlier, Alt + ↓ one place later (key repeat too)', () => {
    expect(sceneOrderKey({ key: 'ArrowUp', code: 'ArrowUp', altKey: true })).toBe(-1)
    expect(sceneOrderKey({ key: 'ArrowDown', code: 'ArrowDown', altKey: true })).toBe(1)
    expect(sceneOrderKey({ key: 'ArrowDown', code: 'ArrowDown', altKey: true, repeat: true })).toBe(1)
  })

  it('nothing without Alt, with Shift / Ctrl / ⌘ / AltGr, while composing, or for other keys', () => {
    for (const ev of [
      { key: 'ArrowUp', code: 'ArrowUp' },
      { key: 'ArrowUp', code: 'ArrowUp', altKey: true, shiftKey: true },
      { key: 'ArrowUp', code: 'ArrowUp', altKey: true, ctrlKey: true },
      { key: 'ArrowDown', code: 'ArrowDown', altKey: true, metaKey: true },
      { key: 'ArrowDown', code: 'ArrowDown', altKey: true, altGraph: true },
      { key: 'ArrowDown', code: 'ArrowDown', altKey: true, isComposing: true },
      { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true },
      { key: 'ArrowRight', code: 'ArrowRight', altKey: true },
      { key: 'Home', code: 'Home', altKey: true },
    ])
      expect(sceneOrderKey(ev), JSON.stringify(ev)).toBeNull()
  })
})

describe('useShortcuts: Alt + ↑ / ↓', () => {
  it('moves the selected scene and prevents the browser default', () => {
    expect(press({ key: 'ArrowUp', altKey: true })).toBe(true)
    expect(press({ key: 'ArrowDown', altKey: true })).toBe(true)
    expect(h.move.mock.calls).toEqual([[-1], [1]])
  })

  it('a held key keeps moving (repeat is not filtered like the single keys)', () => {
    press({ key: 'ArrowUp', altKey: true })
    press({ key: 'ArrowUp', altKey: true, repeat: true })
    press({ key: 'ArrowUp', altKey: true, repeat: true })
    expect(h.move).toHaveBeenCalledTimes(3)
  })

  it('never while typing in a field (the prompt keeps Alt + arrows)', () => {
    const targets = [
      { tagName: 'TEXTAREA' },
      { tagName: 'INPUT', type: 'text' },
      { tagName: 'INPUT', type: 'number' },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
    ]
    for (const target of targets) expect(press({ key: 'ArrowUp', altKey: true, target }), target.tagName).toBe(false)
    expect(h.move).not.toHaveBeenCalled()
    // A checkbox / button with focus is not typing: the keys work.
    press({ key: 'ArrowDown', altKey: true, target: { tagName: 'INPUT', type: 'checkbox' } })
    press({ key: 'ArrowDown', altKey: true, target: { tagName: 'BUTTON' } })
    expect(h.move).toHaveBeenCalledTimes(2)
  })

  it('never while a dialog is open (the film player, settings…)', () => {
    for (const kind of ['player', 'settings', 'shortcuts'] as const) {
      useUI.setState({ dialog: { kind } as ReturnType<typeof useUI.getState>['dialog'] })
      expect(press({ key: 'ArrowUp', altKey: true })).toBe(false)
    }
    expect(h.move).not.toHaveBeenCalled()
  })

  it('never with Shift, Ctrl or ⌘ held, while composing, or when something already handled the key', () => {
    press({ key: 'ArrowUp', altKey: true, shiftKey: true })
    press({ key: 'ArrowUp', altKey: true, ctrlKey: true })
    press({ key: 'ArrowDown', altKey: true, metaKey: true })
    press({ key: 'ArrowDown', altKey: true, isComposing: true })
    press({ key: 'ArrowDown', altKey: true, defaultPrevented: true })
    expect(h.move).not.toHaveBeenCalled()
  })

  it('plain ↑ / ↓ and other Alt chords do not move scenes', () => {
    expect(press({ key: 'ArrowUp' })).toBe(false)
    expect(press({ key: 'ArrowDown' })).toBe(false)
    expect(press({ key: 'ArrowLeft', altKey: true })).toBe(false)
    expect(press({ key: 'n', code: 'KeyN', altKey: true })).toBe(false)
    expect(h.move).not.toHaveBeenCalled()
  })

  it('the cleanup removes the handler', () => {
    for (const cleanup of h.cleanups.splice(0)) cleanup()
    expect(listeners).toHaveLength(0)
  })
})
