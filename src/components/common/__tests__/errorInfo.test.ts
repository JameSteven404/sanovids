import { describe, expect, it } from 'vitest'
import { errorSummary, isChunkLoadError } from '../errorInfo'
import { isTextEntry } from '../focus'

describe('isChunkLoadError', () => {
  it('recognises failed lazy chunks (Chrome, Firefox, Safari, Vite CSS preload)', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://x/assets/SceneTable.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true)
    expect(isChunkLoadError({ name: 'ChunkLoadError', message: 'Loading chunk 3 failed' })).toBe(true)
  })

  it('leaves ordinary errors alone', () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'refs')"))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError('boom')).toBe(false)
  })
})

describe('errorSummary', () => {
  it('keeps one short line', () => {
    expect(errorSummary(new RangeError('bad\nstack line'))).toBe('RangeError: bad')
    expect(errorSummary('plain text')).toBe('plain text')
    expect(errorSummary(undefined)).toBe('Lỗi không xác định')
    const long = errorSummary(new Error('x'.repeat(400)))
    expect(long.length).toBe(180)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('isTextEntry (Escape leaves the field before it closes a dialog)', () => {
  it('treats text inputs, textareas and contenteditable as fields', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isTextEntry({ tagName: 'input', type: '' })).toBe(true)
    expect(isTextEntry({ tagName: 'INPUT', type: 'search' })).toBe(true)
    expect(isTextEntry({ tagName: 'INPUT', type: 'number' })).toBe(true)
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('does not treat buttons, checkboxes, selects or plain elements as fields', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTextEntry({ tagName: 'INPUT', type: 'range' })).toBe(false)
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false)
    expect(isTextEntry({ tagName: 'SELECT' })).toBe(false)
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: false })).toBe(false)
    expect(isTextEntry(null)).toBe(false)
  })
})
