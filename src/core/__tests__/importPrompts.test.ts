import { describe, expect, it } from 'vitest'
import {
  applyImageMapping,
  buildImportScenes,
  fileTitle,
  hasMapping,
  itemsFromFiles,
  MAX_SUMMARY_TOKEN,
  parsePromptText,
  previewItem,
  SAMPLE_IMPORT_TEXT,
  scanTokens,
  splitPrompts,
  summarizeImport,
} from '../importPrompts'
import type { Asset } from '../types'

const asset = (id: string, images = 1): Asset => ({
  id,
  kind: 'character',
  name: id.toUpperCase(),
  tag: id,
  description: '',
  imageIds: Array.from({ length: images }, (_, i) => `${id}-img${i}`),
  color: '#fff',
  position: null,
})

describe('splitPrompts / parsePromptText', () => {
  it('splits on ---, === and *** lines (3+ chars) and drops empty chunks', () => {
    const text = 'one\n---\ntwo\n\n=====\n\nthree\r\n***\r\nfour\n------\n\n---\n'
    expect(splitPrompts(text)).toEqual(['one', 'two', 'three', 'four'])
  })
  it('keeps short dashes and inline separators as content', () => {
    expect(splitPrompts('a -- b\nline --- inside\n**bold**')).toEqual(['a -- b\nline --- inside\n**bold**'])
  })
  it('reads titles from "=== S01: Title ===" headers', () => {
    const items = parsePromptText('=== S01: Dawn ===\nfirst\n\n=== S02 · Night ===\nsecond\n=== S03 ===\nthird')
    expect(items).toEqual([
      { title: 'Dawn', text: 'first' },
      { title: 'Night', text: 'second' },
      { title: '', text: 'third' },
    ])
  })
  it('reads titles from the take headers of the exported prompts.txt ("=== S01_T2 - Title ===")', () => {
    const items = parsePromptText('=== S01_T2 - Ngọn đèn ===\nfirst\n\n=== S02_T1 ===\nsecond\n=== S03·T4: Đêm ===\nthird\n=== S04 T1 ===\nfourth')
    expect(items).toEqual([
      { title: 'Ngọn đèn', text: 'first' },
      { title: '', text: 'second' },
      { title: 'Đêm', text: 'third' },
      { title: '', text: 'fourth' },
    ])
  })
  it('does not eat titles that only start like a take code', () => {
    const items = parsePromptText('=== S01 · Tối ===\na\n=== S02: Twilight ===\nb\n=== S03 · T-Rex ===\nc')
    expect(items.map((i) => i.title)).toEqual(['Tối', 'Twilight', 'T-Rex'])
  })
  it('keeps @image_N / @video_N tokens and paragraphs exactly as written', () => {
    const body = 'Style line.\n\nMara (@image_1) walks.\nContinue from @video_2.'
    expect(parsePromptText(`---\n${body}\n---`)).toEqual([{ title: '', text: body }])
  })
})

describe('itemsFromFiles', () => {
  it('uses the file name without extension as title, natural order, drops empty files', () => {
    const items = itemsFromFiles([
      { name: 'video 10.txt', text: 'ten' },
      { name: 'video 2.txt', text: ' two\r\nlines ' },
      { name: 'empty.txt', text: '  \n ' },
      { name: 'Cảnh đầu.md', text: 'first' },
    ])
    expect(items).toEqual([
      { title: 'Cảnh đầu', text: 'first' },
      { title: 'video 2', text: 'two\nlines' },
      { title: 'video 10', text: 'ten' },
    ])
  })
  it('fileTitle strips only the last extension', () => {
    expect(fileTitle('S01.prompt.txt')).toBe('S01.prompt')
    expect(fileTitle('no-ext')).toBe('no-ext')
  })
})

describe('scanTokens / previewItem / summarizeImport', () => {
  it('finds distinct token numbers, case-insensitive, ignoring @image_0 and lookalikes', () => {
    expect(scanTokens('@image_3 and @IMAGE_1, @image_3 again, @video_2, @image_0, @imageX, @image_12b')).toEqual({ images: [1, 3], videos: [2] })
  })
  it('previews the first lines, counts characters (code points) and tokens', () => {
    const text = 'Dòng một @image_2\n\n  dòng hai\nba\nbốn 😀'
    const p = previewItem({ title: 'A', text }, 2)
    expect(p).toEqual({ title: 'A', excerpt: 'Dòng một @image_2\ndòng hai', chars: [...text].length, images: [2], videos: [] })
    expect(p.chars).toBe(text.length - 1) // the emoji is one character, two UTF-16 units
  })
  it('summarizes counts and how many prompts mention each image number', () => {
    const s = summarizeImport([
      { title: '', text: '@image_1 @image_3' },
      { title: '', text: '@image_1 @video_1' },
      { title: '', text: 'no tokens' },
    ])
    expect(s).toMatchObject({ prompts: 3, maxImage: 3, maxVideo: 1, withImages: 2, withVideos: 1, imageUsage: [2, 0, 1] })
    expect(summarizeImport([]).maxImage).toBe(0)
  })
  it('counts only distinct mentioned numbers and ignores numbers above the cap (99)', () => {
    const s = summarizeImport([
      { title: '', text: '@image_2, @image_2 and @IMAGE_2 · @image_150' },
      { title: '', text: '@image_2 @image_5 from @video_1 / @video_1 / @video_400' },
      { title: '', text: 'Only @image_100000 here' },
    ])
    expect(MAX_SUMMARY_TOKEN).toBe(99)
    expect(s.images).toEqual([2, 5])
    expect(s.maxImage).toBe(5)
    // A prompt counts once per number, however often it repeats it.
    expect(s.imageUsage).toEqual([0, 2, 0, 0, 1])
    expect(s.videos).toEqual([1])
    expect(s.maxVideo).toBe(1)
    // The third prompt only mentions an ignored number: it does not count as using images.
    expect(s.withImages).toBe(2)
    expect(s.withVideos).toBe(1)
    expect(s.ignored).toEqual({ images: [150, 100000], videos: [400] })
  })
  it('never builds a huge usage array, and the cap is inclusive and configurable', () => {
    const huge = summarizeImport([{ title: '', text: '@image_20241002 @image_99999999999999999999 @video_123456' }])
    expect(huge).toMatchObject({ maxImage: 0, maxVideo: 0, withImages: 0, withVideos: 0, imageUsage: [], images: [], videos: [] })
    expect(huge.ignored.images).toEqual([20241002, 1e20])
    expect(summarizeImport([{ title: '', text: '@image_99' }]).imageUsage).toHaveLength(99)
    const capped = summarizeImport([{ title: '', text: '@image_3 @image_4 @video_4' }], 3)
    expect(capped).toMatchObject({ images: [3], maxImage: 3, maxVideo: 0, ignored: { images: [4], videos: [4] } })
  })
})

describe('applyImageMapping', () => {
  const assets = [asset('a'), asset('b'), asset('c'), asset('multi', 2), asset('noimg', 0)]

  it('links mentioned assets in number order and keeps the numbers when they line up', () => {
    const m = applyImageMapping('@image_1 meets @image_2.', ['a', 'b'], assets)
    expect(m).toEqual({ prompt: '@image_1 meets @image_2.', refs: ['a', 'b'], images: 2, pending: [] })
  })

  it('renumbers tokens when only some numbers are mentioned (onlyMentioned)', () => {
    const m = applyImageMapping('Only @image_3 here, @image_3 again.', ['a', 'b', 'c'], assets)
    expect(m.refs).toEqual(['c'])
    expect(m.prompt).toBe('Only @image_1 here, @image_1 again.')
  })

  it('links every assigned asset when onlyMentioned is off', () => {
    const m = applyImageMapping('Only @image_3.', ['a', 'b', 'c'], assets, { onlyMentioned: false })
    expect(m.refs).toEqual(['a', 'b', 'c'])
    expect(m.prompt).toBe('Only @image_3.')
  })

  it('accounts for assets with several images (each image has its own number)', () => {
    const m = applyImageMapping('@image_1 and @image_2', ['multi', 'b'], assets)
    // multi → @image_1 + @image_2 (its second picture), b → @image_3
    expect(m.refs).toEqual(['multi', 'b'])
    expect(m.images).toBe(3)
    expect(m.prompt).toBe('@image_1 and @image_3')
  })

  it('maps repeated assets to their next images', () => {
    const m = applyImageMapping('front @image_1, back @image_2, friend @image_3', ['multi', 'multi', 'a'], assets)
    expect(m.refs).toEqual(['multi', 'a'])
    expect(m.prompt).toBe('front @image_1, back @image_2, friend @image_3')
    // A one-image asset used twice: both numbers point at its only picture.
    expect(applyImageMapping('@image_1 / @image_2', ['a', 'a'], assets).prompt).toBe('@image_1 / @image_1')
  })

  it('turns unassigned numbers into @image_?N placeholders (never live tokens)', () => {
    const m = applyImageMapping('@image_1 @image_2 @image_4 @image_3', [null, 'b', null, null], assets)
    expect(m.refs).toEqual(['b'])
    expect(m.pending).toEqual([1, 3, 4])
    // b → 1; pending 1 → 2, 3 → 3, 4 → 4
    expect(m.prompt).toBe('@image_?1 @image_1 @image_?4 @image_?3')
  })

  it('renumbers a prompt that links none of the assigned assets (the dialog preview must not say "unchanged")', () => {
    const m = applyImageMapping('Dog @image_2 at @image_3', ['a'], assets)
    expect(m.refs).toEqual([])
    expect(m.images).toBe(0)
    expect(m.pending).toEqual([2, 3])
    expect(m.prompt).toBe('Dog @image_?2 at @image_?3')
  })

  it('ignores assets without images and unknown ids; no usable mapping keeps the prompt untouched', () => {
    const text = 'Keep @image_2 and @Image_5 as written.'
    expect(applyImageMapping(text, ['noimg', 'ghost'], assets)).toEqual({ prompt: text, refs: [], images: 0, pending: [2, 5] })
    expect(applyImageMapping(text, [], assets).prompt).toBe(text)
  })

  it('never touches @video_N tokens', () => {
    const m = applyImageMapping('Continue from @video_1 with @image_2.', [null, 'a'], assets)
    expect(m.prompt).toBe('Continue from @video_1 with @image_1.')
  })

  it('hasMapping is true only with an assigned asset that has images', () => {
    expect(hasMapping(undefined, assets)).toBe(false)
    expect(hasMapping([null, 'noimg'], assets)).toBe(false)
    expect(hasMapping([null, 'a'], assets)).toBe(true)
  })
})

describe('buildImportScenes', () => {
  const items = [
    { title: ' One ', text: 'A @image_1 and @image_2' },
    { title: '', text: 'B only @image_2' },
    { title: 'Three', text: 'C no tokens' },
  ]
  const assets = [asset('x'), asset('y')]

  it('keeps prompts as written without a mapping', () => {
    expect(buildImportScenes(items)).toEqual([
      { title: 'One', prompt: 'A @image_1 and @image_2', refs: [] },
      { title: '', prompt: 'B only @image_2', refs: [] },
      { title: 'Three', prompt: 'C no tokens', refs: [] },
    ])
    expect(buildImportScenes(items, { mapping: [null, null], assets }).map((s) => s.prompt)).toEqual(items.map((i) => i.text))
  })

  it('applies one mapping to every scene', () => {
    const scenes = buildImportScenes(items, { mapping: ['x', 'y'], assets })
    expect(scenes.map((s) => [s.prompt, s.refs])).toEqual([
      ['A @image_1 and @image_2', ['x', 'y']],
      ['B only @image_1', ['y']],
      ['C no tokens', []],
    ])
    const all = buildImportScenes(items, { mapping: ['x', 'y'], assets, onlyMentioned: false })
    expect(all.map((s) => s.refs)).toEqual([
      ['x', 'y'],
      ['x', 'y'],
      ['x', 'y'],
    ])
    expect(all[1].prompt).toBe('B only @image_2')
  })
})

describe('sample prompts', () => {
  it('has 3 titled prompts using @image_1..3', () => {
    const items = parsePromptText(SAMPLE_IMPORT_TEXT)
    expect(items).toHaveLength(3)
    expect(items.every((i) => i.title.length > 0)).toBe(true)
    const s = summarizeImport(items)
    expect(s.maxImage).toBe(3)
    expect(s.imageUsage).toEqual([3, 2, 2])
    expect(s.maxVideo).toBe(0)
  })
})
