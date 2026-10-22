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
  // Test giới hạn monkey (seed ee1219bb, P3): an asset named like a token turned the text into a token of another picture
  it('never an "@": a name like a token or a mention stays plain text', () => {
    expect(imageFallbackName({ name: '@@image_1', tag: 'X' })).toBe('image_1')
    expect(imageFallbackName({ name: '@Lumi ở @video 2', tag: 'X' })).toBe('Lumi ở video 2')
    expect(imageFallbackName({ name: ' @ ', tag: '@Elara' })).toBe('Elara')
    expect(imageFallbackName({ name: '@@', tag: '@' })).toBe('ảnh')
  })
})
