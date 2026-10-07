// Mouse selection of library cards (librarySelection.libraryClick): plain click, Ctrl / ⌘ toggle, Shift range,
// select all.
import { describe, expect, it } from 'vitest'
import { libraryClick, selectAllVisible } from '../librarySelection'

const visible = ['a', 'b', 'c', 'd', 'e']
const plain = { ctrlKey: false, metaKey: false, shiftKey: false }
const ctrl = { ...plain, ctrlKey: true }
const meta = { ...plain, metaKey: true }
const shift = { ...plain, shiftKey: true }

describe('libraryClick', () => {
  it('a plain click selects only that card and becomes the anchor', () => {
    expect(libraryClick(['a', 'c'], visible, 'a', 'b', plain)).toEqual({ selection: ['b'], anchor: 'b' })
  })

  it('a plain click on the only selected card clears the selection', () => {
    expect(libraryClick(['b'], visible, 'b', 'b', plain)).toEqual({ selection: [], anchor: 'b' })
  })

  it('Ctrl / ⌘ + click adds or removes one card, keeping the others', () => {
    expect(libraryClick(['a'], visible, 'a', 'c', ctrl)).toEqual({ selection: ['a', 'c'], anchor: 'c' })
    expect(libraryClick(['a', 'c'], visible, 'c', 'a', meta)).toEqual({ selection: ['c'], anchor: 'a' })
  })

  it('Shift + click adds the visible range from the anchor, in list order, keeping the anchor', () => {
    expect(libraryClick(['b'], visible, 'b', 'd', shift)).toEqual({ selection: ['b', 'c', 'd'], anchor: 'b' })
    // backwards, and added to an earlier selection
    expect(libraryClick(['e'], visible, 'd', 'b', shift)).toEqual({ selection: ['e', 'b', 'c', 'd'], anchor: 'd' })
  })

  it('Shift + click ranges over what is visible only (search / tab applied)', () => {
    expect(libraryClick([], ['a', 'c', 'e'], 'a', 'e', shift).selection).toEqual(['a', 'c', 'e'])
  })

  it('Shift + click without a usable anchor toggles the card (anchor hidden, gone or the same card)', () => {
    expect(libraryClick(['a'], visible, null, 'c', shift)).toEqual({ selection: ['a', 'c'], anchor: 'c' })
    expect(libraryClick(['a'], ['b', 'c'], 'a', 'c', shift)).toEqual({ selection: ['a', 'c'], anchor: 'c' })
    expect(libraryClick(['c'], visible, 'c', 'c', shift)).toEqual({ selection: [], anchor: 'c' })
  })
})

describe('selectAllVisible (Ctrl+A / ⌘A in the library)', () => {
  it('every visible card, in list order, once', () => {
    expect(selectAllVisible(visible)).toEqual(visible)
    expect(selectAllVisible(['a', 'a', 'b'])).toEqual(['a', 'b'])
    expect(selectAllVisible([])).toEqual([])
  })
})
