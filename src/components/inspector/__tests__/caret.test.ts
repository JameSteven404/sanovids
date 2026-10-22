import { describe, expect, it } from 'vitest'
import { scaleCaret } from '../caret'

describe('scaleCaret', () => {
  it.each([1, 1 / 0.45, 0.625])('scales the scrolled caret offsets and line height by %s', (k) => {
    const local = { top: -12, left: 40, height: 20 }
    expect(scaleCaret(local, k)).toEqual({ top: -12 * k, left: 40 * k, height: 20 * k })
    expect(local).toEqual({ top: -12, left: 40, height: 20 })
  })
})
