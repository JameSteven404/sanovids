import { describe, expect, it } from 'vitest'
import { imageFallbackName, imageFallbackNames } from '../compile'
import { MODE_LABEL, modeLabel } from '../models'

describe('modeLabel', () => {
  it('says "+ảnh" only where the mode sends reference images', () => {
    expect(modeLabel('t2v', 'seedance_2_5')).toBe(MODE_LABEL.t2v)
    expect(modeLabel('t2v', 'minimax_h3')).toBe('Text → Video')
    expect(modeLabel('i2v', 'minimax_h3')).toBe('Ảnh → Video')
    expect(modeLabel('transform', 'minimax_h3')).toBe('Khung đầu → cuối')
    expect(modeLabel('t2v')).toBe('Text → Video')
  })
})

describe('imageFallbackName', () => {
  it('name, else tag, else "ảnh"', () => {
    expect(imageFallbackName({ name: ' Elara ', tag: 'E' })).toBe('Elara')
    expect(imageFallbackName({ name: '   ', tag: 'Lumi' })).toBe('Lumi')
    expect(imageFallbackName({ name: '', tag: '' })).toBe('ảnh')
    expect(imageFallbackName(undefined)).toBe('ảnh')
    expect(imageFallbackNames([{ id: 'a', name: '', tag: 'T' }])('a')).toBe('T')
    expect(imageFallbackNames([])('x')).toBe('ảnh')
  })
})
