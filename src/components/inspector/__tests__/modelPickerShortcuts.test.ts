// The model picker replaces native <select>s, which the global shortcut handler treats as typing. Its trigger and
// listbox are a BUTTON and a DIV, so the keys they keep must be marked (preventDefault: useShortcuts skips a prevented
// key) or Delete / ⌫ / letters reach deleteSelection, nextScene… Driven like sceneOrderKeys.test.ts: React's useEffect
// runs at once, `window` is a small event target, and the SAME event object goes through the picker's handler first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  // A Mac keyboard: ⌫ deletes there (after the 90 ms grace), Delete too.
  vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'test' })
  return { deleteSelection: vi.fn(), nextScene: vi.fn(), connectSelection: vi.fn(), cleanups: [] as Array<() => void> }
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
vi.mock('../../../actions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../actions')>()
  return { ...real, deleteSelection: h.deleteSelection, nextScene: h.nextScene, connectSelection: h.connectSelection }
})
// (hoisted above the imports) keep IndexedDB persistence out of a pure-logic test
vi.mock('../../../store/persist', () => ({ flush: async () => true }))

import { BACKSPACE_GRACE_MS, useShortcuts } from '../../../hooks/useShortcuts'
import { useUI } from '../../../store/ui'
import { listKeyDown, modelPickerEntries, openModelPicker, triggerKeyDown } from '../modelPickerModel'

type Listener = (e: KeyboardEvent) => void
let listeners: Listener[] = []
const entries = modelPickerEntries()

function keyEvent(key: string, tagName: 'DIV' | 'BUTTON') {
  return {
    key, code: key, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, repeat: false, isComposing: false,
    defaultPrevented: false, target: { tagName, isContentEditable: false },
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
  }
}
/** The picker handles the key first (bubbling from its element), then the window listener sees the same event. */
function pressInList(key: string) {
  const event = keyEvent(key, 'DIV')
  listKeyDown(event, entries, openModelPicker(entries, 'seedance_2_5'), 0)
  for (const fn of listeners) fn(event as unknown as KeyboardEvent)
  return event
}
function pressOnTrigger(key: string) {
  const event = keyEvent(key, 'BUTTON')
  triggerKeyDown(event, entries, 'seedance_2_5', 0)
  for (const fn of listeners) fn(event as unknown as KeyboardEvent)
  return event
}

beforeEach(() => {
  vi.useFakeTimers()
  listeners = []
  h.deleteSelection.mockReset()
  h.nextScene.mockReset()
  h.connectSelection.mockReset()
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => { if (type === 'keydown') listeners.push(fn) },
    removeEventListener: (type: string, fn: Listener) => { if (type === 'keydown') listeners = listeners.filter(x => x !== fn) },
    dispatchEvent: () => true,
  })
  useUI.setState({ dialog: { kind: 'none' }, toasts: [] })
  useShortcuts()
  expect(listeners).toHaveLength(1)
})
afterEach(() => {
  for (const cleanup of h.cleanups.splice(0)) cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'test' })
})

describe('model picker vs the global shortcuts', () => {
  it('the harness deletes on a plain DIV (so the checks below are meaningful)', () => {
    const event = keyEvent('Delete', 'DIV')
    for (const fn of listeners) fn(event as unknown as KeyboardEvent)
    expect(h.deleteSelection).toHaveBeenCalledOnce()
  })

  it('Delete and ⌫ in the open list never delete the selected scenes', () => {
    expect(pressInList('Delete').defaultPrevented).toBe(true)
    expect(pressInList('Backspace').defaultPrevented).toBe(true)
    vi.advanceTimersByTime(BACKSPACE_GRACE_MS * 3)
    expect(h.deleteSelection).not.toHaveBeenCalled()
  })

  it('Delete, ⌫ and letters on the focused trigger stay in the picker (n, c, m…)', () => {
    const minimap = useUI.getState().showMinimap
    for (const key of ['Delete', 'Backspace', 'n', 'c', 'm', 'e', 'f']) pressOnTrigger(key)
    vi.advanceTimersByTime(BACKSPACE_GRACE_MS * 3)
    expect(h.deleteSelection).not.toHaveBeenCalled()
    expect(h.nextScene).not.toHaveBeenCalled()
    expect(h.connectSelection).not.toHaveBeenCalled()
    expect(useUI.getState().showMinimap).toBe(minimap)
  })

  it('Tab still leaves the picker (not prevented)', () => {
    expect(pressInList('Tab').defaultPrevented).toBe(false)
    expect(pressOnTrigger('Tab').defaultPrevented).toBe(false)
  })
})
