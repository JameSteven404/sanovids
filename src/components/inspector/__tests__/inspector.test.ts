import { describe, expect, it } from 'vitest'
import type { Asset } from '../../../core/types'
import { findMention, fold } from '../mentions'
import { patchFits, patchLabel } from '../SettingsFields'
import {
  imageOptsFor,
  insertAt,
  legacyAssets,
  mediaCountLabel,
  replaceLegacyTags,
  segmentPrompt,
  suggestMedia,
  suggestionToken,
  type ImageOpt,
  type LibraryOpt,
  type VideoOpt,
} from '../tokens'

const asset = (id: string, name: string, tag: string, over: Partial<Asset> = {}): Asset => ({
  id, kind: 'character', name, tag, description: '', imageIds: ['img_' + id], color: '#fff', position: null, ...over,
})
const ASSETS = [
  asset('a', 'Elara', 'Elara', { imageIds: ['a1', 'a2'] }),
  asset('b', 'Bé An', 'BeAn'),
  asset('c', 'Làng núi', 'LangNui', { kind: 'location' }),
  asset('d', 'Aurelian', 'Aurelian'),
  asset('e', 'Elaine', 'Elaine'),
]

describe('findMention', () => {
  it('finds the "@xxx" being typed at the caret', () => {
    const t = 'At dusk @Ela climbs'
    expect(findMention(t, 12)).toEqual({ start: 8, end: 12, query: 'Ela' })
    // caret in the middle of the word: token extends to the end of the word
    expect(findMention(t, 10)).toEqual({ start: 8, end: 12, query: 'E' })
    expect(findMention('@', 1)).toEqual({ start: 0, end: 1, query: '' })
  })
  it('handles numbers, raw tokens and vietnamese letters', () => {
    expect(findMention('see @2', 6)?.query).toBe('2')
    expect(findMention('use @image_3', 12)).toEqual({ start: 4, end: 12, query: 'image_3' })
    expect(findMention('gặp @Làng', 9)?.query).toBe('Làng')
  })
  it('ignores e-mails and text without "@"', () => {
    expect(findMention('mail me a@b', 11)).toBeNull()
    expect(findMention('@Elara walks', 12)).toBeNull()
    expect(findMention('no mention here', 5)).toBeNull()
  })
  it('folds diacritics', () => {
    expect(fold('Đường Làng')).toBe('duong lang')
  })
})

describe('segmentPrompt', () => {
  it('splits tokens and keeps the exact text', () => {
    const text = '@image_1 hugs @image_2 near @video_1, then @image_5 and @video_2.'
    const segs = segmentPrompt(text, 3, 1)
    expect(segs.map((s) => s.text).join('')).toBe(text)
    const marks = segs.filter((s) => s.kind !== 'text')
    expect(marks.map((s) => [s.kind, s.n, !!s.invalid])).toEqual([
      ['image', 1, false],
      ['image', 2, false],
      ['video', 1, false],
      ['image', 5, true],
      ['video', 2, true],
    ])
  })
  it('marks legacy asset tags only when known, merges plain text', () => {
    const segs = segmentPrompt('@Elara meets @Bob at @image_0', 2, 0, new Set(['elara']))
    expect(segs.map((s) => s.kind)).toEqual(['legacy', 'text', 'image'])
    expect(segs[1].text).toBe(' meets @Bob at ')
    expect(segs[2].invalid).toBe(true)
  })
  it('does not treat longer words as tokens and handles empty text', () => {
    expect(segmentPrompt('@image_12abc', 20, 0).map((s) => s.kind)).toEqual(['text'])
    expect(segmentPrompt('', 1, 1)).toEqual([])
  })
  it('stays linear on long prompts', () => {
    const text = 'A long line with @image_1 and @video_1. '.repeat(400) // ~16k chars
    const t0 = performance.now()
    const segs = segmentPrompt(text, 1, 1, new Set(['elara']))
    expect(performance.now() - t0).toBeLessThan(100)
    expect(segs.filter((s) => s.kind === 'image')).toHaveLength(400)
    expect(segs.map((s) => s.text).join('')).toBe(text)
  })
})

describe('suggestMedia', () => {
  const images: ImageOpt[] = imageOptsFor(ASSETS, ['a', 'c']) // Elara ×2 → 1,2 · Làng núi → 3
  const videos: VideoOpt[] = [
    { n: 1, takeId: 't1', label: 'S03·T2', posterId: null, status: 'completed' },
    { n: 2, takeId: 't2', label: 'S04·T1', posterId: null, status: 'completed' },
  ]
  const library: LibraryOpt[] = ASSETS.filter((a) => !['a', 'c'].includes(a.id)).map((a) => ({ assetId: a.id, name: a.name, tag: a.tag, kind: a.kind }))
  const key = (s: ReturnType<typeof suggestMedia>[number]) => (s.type === 'link' ? 'link:' + s.tag : suggestionToken(s))

  it('numbers images per asset image', () => {
    expect(images.map((i) => [i.n, i.assetId, i.imageIndex])).toEqual([
      [1, 'a', 0],
      [2, 'a', 1],
      [3, 'c', 0],
    ])
  })
  it('lists images, videos, then library for an empty query', () => {
    expect(suggestMedia('', images, videos, library).map(key)).toEqual([
      '@image_1',
      '@image_2',
      '@image_3',
      '@video_1',
      '@video_2',
      'link:BeAn',
      'link:Aurelian',
      'link:Elaine',
    ])
  })
  it('filters by name: linked images before library assets', () => {
    expect(suggestMedia('ela', images, videos, library).map(key)).toEqual(['@image_1', '@image_2', 'link:Elaine'])
    expect(suggestMedia('lang', images, videos, library).map(key)).toEqual(['@image_3'])
    expect(suggestMedia('nui', images, videos, library).map(key)).toEqual(['@image_3'])
  })
  it('filters by number and token prefix', () => {
    expect(suggestMedia('2', images, videos, library).map(key)).toEqual(['@image_2', '@video_2'])
    expect(suggestMedia('vid', images, videos, library).map(key)).toEqual(['@video_1', '@video_2'])
    expect(suggestMedia('image_3', images, videos, library).map(key)).toEqual(['@image_3'])
  })
  it('matches video labels loosely', () => {
    expect(suggestMedia('s03', images, videos, library).map(key)).toEqual(['@video_1'])
    expect(suggestMedia('s04t1', images, videos, library).map(key)).toEqual(['@video_2'])
  })
})

describe('insertAt', () => {
  it('replaces a partial "@xxx" and adds a trailing space', () => {
    const text = 'At dusk @Ela climbs'
    const tok = findMention(text, 12)!
    const r = insertAt(text, tok.start, tok.end, '@image_1')
    expect(r.next).toBe('At dusk @image_1 climbs')
    expect(r.insert).toBe('@image_1')
    expect(r.caret).toBe('At dusk @image_1 '.length)
  })
  it('pads words, none before punctuation, at the end adds a space', () => {
    expect(insertAt('Hello', 5, 5, '@video_1').next).toBe('Hello @video_1 ')
    const b = insertAt('Hi @El.', 3, 6, '@image_2')
    expect(b.next).toBe('Hi @image_2.')
    expect(b.caret).toBe('Hi @image_2'.length)
    expect(insertAt('(x)', 1, 2, '@image_1').next).toBe('(@image_1)')
    expect(insertAt('', 0, 0, '@image_1').next).toBe('@image_1 ')
  })
})

describe('legacy @Tag helpers', () => {
  it('lists asset tags mentioned once, ignoring tokens and unknown words', () => {
    expect(legacyAssets('@elara and @BeAn meet @Elara at @image_1 with @Bob', ASSETS).map((a) => a.id)).toEqual(['a', 'b'])
    expect(legacyAssets('no mentions', ASSETS)).toEqual([])
  })
  it('replaces mapped tags only', () => {
    const r = replaceLegacyTags('@Elara hugs @BeAn and @elara', new Map([['elara', '@image_1']]))
    expect(r.text).toBe('@image_1 hugs @BeAn and @image_1')
    expect(r.replaced).toBe(2)
  })
  it('labels counts', () => {
    expect(mediaCountLabel(3, 1)).toBe('3 ảnh · 1 video')
  })
})

describe('patchFits (batch settings on scenes with different models)', () => {
  it('accepts only values the scene model offers', () => {
    expect(patchFits('seedance_2_5', { resolution: '480p' })).toBe(true)
    expect(patchFits('seedance_2_5', { resolution: '768p' })).toBe(false)
    expect(patchFits('minimax_h3', { resolution: '480p' })).toBe(false)
    expect(patchFits('minimax_h3', { duration: 30 })).toBe(false)
    expect(patchFits('minimax_h3', { duration: 15, ratio: '9:16' })).toBe(true)
    expect(patchFits('seedance_2_5', { mode: 'i2v' })).toBe(false)
  })
  it('lets a model switch through (normalized for the new model)', () => {
    expect(patchFits('seedance_2_5', { model: 'minimax_h3' })).toBe(true)
  })
  it('labels the value', () => {
    expect(patchLabel({ resolution: '2k' })).toBe('2K')
    expect(patchLabel({ duration: 30 })).toBe('30s')
  })
})
