// Keys of the library (core/libraryKeys): Delete deletes at once, Windows Backspace only hints (Vietnamese input tools
// send it), Mac ⌫ waits, a held key never deletes, Ctrl+A / ⌘A selects every visible card.
import { describe, expect, it, vi } from 'vitest'

// (hoisted above the imports) keep IndexedDB persistence out of a pure-logic test
vi.mock('../../store/persist', () => ({ flush: async () => true }))

import { BACKSPACE_GRACE_MS } from '../../hooks/useShortcuts'
import { LIBRARY_KEY_GRACE_MS, libraryKeyAction, type LibraryKeyInput } from '../libraryKeys'

const win = (e: Omit<LibraryKeyInput, 'mac'>) => libraryKeyAction({ ...e, mac: false })
const mac = (e: Omit<LibraryKeyInput, 'mac'>) => libraryKeyAction({ ...e, mac: true })

describe('libraryKeyAction', () => {
  it('Delete deletes at once on both systems (Shift+Delete too, like the canvas)', () => {
    expect(win({ key: 'Delete' })).toBe('delete-now')
    expect(win({ key: 'Delete', shiftKey: true })).toBe('delete-now')
    // fn + ⌫ on a Mac keyboard sends Delete
    expect(mac({ key: 'Delete' })).toBe('delete-now')
  })

  it('Ctrl / Alt / ⌘ + Delete are not the delete command', () => {
    expect(win({ key: 'Delete', ctrlKey: true })).toBeNull()
    expect(win({ key: 'Delete', altKey: true })).toBeNull()
    expect(mac({ key: 'Delete', metaKey: true })).toBeNull()
  })

  it('Windows: plain Backspace never deletes, it only hints; with a modifier it is left alone', () => {
    expect(win({ key: 'Backspace' })).toBe('backspace-hint')
    expect(win({ key: 'Backspace', ctrlKey: true })).toBeNull()
    expect(win({ key: 'Backspace', shiftKey: true })).toBeNull()
    expect(win({ key: 'Backspace', altKey: true })).toBeNull()
    expect(win({ key: 'Backspace', metaKey: true })).toBeNull()
  })

  it('Mac: ⌫ waits for the grace period, ⌘⌫ deletes at once, ⌃ / ⌥ / ⇧ + ⌫ are text chords', () => {
    expect(mac({ key: 'Backspace' })).toBe('delete-deferred')
    expect(mac({ key: 'Backspace', metaKey: true })).toBe('delete-now')
    expect(mac({ key: 'Backspace', ctrlKey: true })).toBeNull()
    expect(mac({ key: 'Backspace', altKey: true })).toBeNull()
    expect(mac({ key: 'Backspace', shiftKey: true })).toBeNull()
  })

  it('a held key (repeat) never deletes, but stays the library’s (it must not reach the canvas)', () => {
    expect(win({ key: 'Delete', repeat: true })).toBe('ignore')
    expect(win({ key: 'Backspace', repeat: true })).toBe('ignore')
    expect(mac({ key: 'Backspace', repeat: true })).toBe('ignore')
    expect(mac({ key: 'Backspace', metaKey: true, repeat: true })).toBe('ignore')
  })

  it('Ctrl+A on Windows, ⌘A on Mac select all; ⌃A on a Mac and chords with Shift / Alt do not', () => {
    expect(win({ key: 'a', code: 'KeyA', ctrlKey: true })).toBe('select-all')
    expect(win({ key: 'A', code: 'KeyA', ctrlKey: true })).toBe('select-all')
    // a non-Latin layout still sends KeyA
    expect(win({ key: 'ф', code: 'KeyA', ctrlKey: true })).toBe('select-all')
    expect(mac({ key: 'a', code: 'KeyA', metaKey: true })).toBe('select-all')
    expect(mac({ key: 'a', code: 'KeyA', ctrlKey: true })).toBeNull()
    expect(win({ key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true })).toBeNull()
    expect(win({ key: 'a', code: 'KeyA', ctrlKey: true, altKey: true })).toBeNull()
    expect(win({ key: 'a', code: 'KeyA' })).toBeNull()
  })

  it('input-method composition is never a command', () => {
    expect(win({ key: 'Delete', isComposing: true })).toBeNull()
    expect(win({ key: 'Backspace', keyCode: 229 })).toBeNull()
    expect(mac({ key: 'Process' })).toBeNull()
  })

  it('other keys are not the library’s', () => {
    for (const key of ['c', 'n', 'Enter', ' ', 'Escape', 'ArrowDown', 'e']) expect(win({ key }), key).toBeNull()
  })

  it('a rebound delete / select-all chord (custom keymap) works in the library too', () => {
    expect(win({ key: 'x', code: 'KeyX', isDeleteChord: true })).toBe('delete-now')
    expect(win({ key: 'x', code: 'KeyX', isDeleteChord: true, repeat: true })).toBe('ignore')
    // Delete unbound from the command: no longer deletes here either…
    expect(win({ key: 'Delete', isDeleteChord: false })).toBeNull()
    // …but Backspace keeps its fixed rules (it is never bindable)
    expect(win({ key: 'Backspace', isDeleteChord: true })).toBe('backspace-hint')
    expect(mac({ key: 'Backspace', isDeleteChord: false })).toBe('delete-deferred')
    expect(win({ key: 'l', code: 'KeyL', ctrlKey: true, isSelectAllChord: true })).toBe('select-all')
    expect(win({ key: 'a', code: 'KeyA', ctrlKey: true, isSelectAllChord: false })).toBeNull()
  })

  it('waits as long as the canvas ⌫', () => {
    expect(LIBRARY_KEY_GRACE_MS).toBe(BACKSPACE_GRACE_MS)
  })
})
