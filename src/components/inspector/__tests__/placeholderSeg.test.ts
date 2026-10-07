// Red placeholders in every highlighter (prompt backdrop, final prompt, the canvas scene card through
// segmentForScene) and the pure parts of the "Chữ đỏ chờ ảnh" bar. No DOM.
import { describe, expect, it } from 'vitest'
import type { Asset } from '../../../core/types'
import { findMention } from '../mentions'
import { chipLabel, gluedLabel, menuTitle } from '../PlaceholderBar'
import { invalidTokenTitle, labelChecker, segmentForScene, segmentPrompt } from '../tokens'

const asset = (id: string, name: string, images = 1, tag = name): Asset => ({
  id,
  kind: 'character',
  name,
  tag,
  description: '',
  imageIds: Array.from({ length: images }, (_, i) => `${id}${i}`),
  color: '#fff',
  position: null,
})
const ASSETS = [asset('e', 'Elara', 2), asset('v', 'Làng')]

describe('segmentPrompt / segmentForScene', () => {
  it('a placeholder is ONE red segment, label included; joining the segments gives the text back', () => {
    const text = 'A @image_?2(Lumi · ảnh 2) b @image_?3 c @image_1'
    const segs = segmentPrompt(text, 1)
    expect(segs.map((s) => s.text).join('')).toBe(text)
    const red = segs.filter((s) => s.reason === 'unbound')
    expect(red.map((s) => [s.text, s.n, s.label])).toEqual([
      ['@image_?2(Lumi · ảnh 2)', 2, 'Lumi · ảnh 2'],
      ['@image_?3', 3, undefined],
    ])
    expect(segs.find((s) => s.text === '@image_1')?.invalid).toBe(false)
  })
  it('"@image_?2 (cười)": only the placeholder is red, the spaced words stay text', () => {
    const segs = segmentPrompt('@image_?2 (cười)', 0)
    expect(segs.map((s) => [s.kind, s.text])).toEqual([
      ['image', '@image_?2'],
      ['text', ' (cười)'],
    ])
  })
  it('a labelled token whose label does not fit its slot is red ("mismatch"); a fitting one is a normal token', () => {
    const text = '@image_3(Lumi) and @image_3(Làng) and @image_1(Elara)'
    const segs = segmentForScene(text, ASSETS, ['e', 'v'])
    expect(segs.map((s) => s.text).join('')).toBe(text)
    const tokens = segs.filter((s) => s.kind === 'image')
    expect(tokens.map((s) => [s.text, s.reason ?? 'ok'])).toEqual([
      ['@image_3(Lumi)', 'mismatch'],
      ['@image_3(Làng)', 'ok'],
      ['@image_1(Elara)', 'ok'],
    ])
    expect(tokens[0].now).toBe('Làng')
    // without a label check (older callers) labels are kept with the token, numbers checked as before
    expect(segmentPrompt(text, 3).filter((s) => s.invalid)).toEqual([])
  })
  it('the same red parts as core/compile blocks: placeholders, mismatching labels, numbers out of range, retired @video', () => {
    const segs = segmentForScene('@image_9 @image_?1(X) @video_1 @image_2(Elara)', ASSETS, ['e'], { sentImages: 2 })
    expect(segs.filter((s) => s.invalid).map((s) => [s.text, s.reason])).toEqual([
      ['@image_9', 'missing'],
      ['@image_?1(X)', 'unbound'],
      ['@video_1', 'retired'],
      ['@image_2(Elara)', 'mismatch'],
    ])
  })
  it('tooltips', () => {
    const [ph] = segmentPrompt('@image_?2(Lumi)', 0)
    expect(invalidTokenTitle(ph)).toBe('Ảnh @image_2 (Lumi) đã bị bỏ nối — nối ảnh thay thế rồi chọn ở dải dưới ô prompt')
    const mismatch = segmentForScene('@image_3(Lumi)', ASSETS, ['e', 'v'])[0]
    expect(invalidTokenTitle(mismatch)).toBe('@image_3 bây giờ là “Làng”, không phải “Lumi” — gắn ảnh đúng ở dải “Chữ đỏ chờ ảnh” dưới ô prompt, hoặc xoá chữ “(Lumi)”.')
  })
  it('labelChecker uses the tag when two characters share a name', () => {
    const twins = [asset('a', 'Lumi'), asset('b', 'Lumi', 1, 'LumiNho')]
    const check = labelChecker(twins, ['b'])
    expect(check(1, 'Lumi').fits).toBe(false)
    expect(check(1, 'LumiNho').fits).toBe(true)
  })
})

describe('the "@" popup never opens inside a placeholder', () => {
  it('findMention returns null with the caret inside "@image_?2(Lumi)"', () => {
    const t = 'x @image_?2(Lumi) y'
    for (let caret = 3; caret < 17; caret++) expect(findMention(t, caret), String(caret)).toBeNull()
    // a real "@" being typed right after still works
    expect(findMention('x @image_?2(Lumi) @El', 21)?.query).toBe('El')
  })
})

describe('bar texts', () => {
  it('chip label and menu title per group kind', () => {
    expect(chipLabel({ kind: 'label', n: 2, base: 'Lumi', text: '@image_?2(Lumi)' })).toBe('@image_?2 · Lumi')
    expect(chipLabel({ kind: 'bare', n: 3, text: '@image_?3' })).toBe('@image_?3')
    expect(chipLabel({ kind: 'mismatch', n: 2, base: 'Lumi', text: '@image_2(Lumi)' })).toBe('@image_2 · Lumi?')
    expect(menuTitle({ kind: 'label', n: 2, base: 'Lumi', text: '@image_?2(Lumi)' })).toBe('Chữ đỏ chờ ảnh · Lumi (trước là @image_2)')
    expect(menuTitle({ kind: 'mismatch', n: 2, base: 'Lumi', text: '@image_2(Lumi)', slotName: 'Làng' })).toBe('@image_2 đang là “Làng”, không phải “Lumi”')
    expect(gluedLabel('@image_2(Lumi · ảnh 2)')).toBe('Lumi · ảnh 2')
    expect(gluedLabel('@image_?3')).toBe('')
  })
})
