import { describe, expect, it } from 'vitest'
import { MODELS } from '../../../core/models'
import type { Asset } from '../../../core/types'
import { findMention, fold, popupPlacement, POPUP_MAX_H } from '../mentions'
import { changedSource, existingIds, pickView, type SelectionParts } from '../selection'
import { patchFits, patchLabel, segmentsNeedFullRow } from '../SettingsFields'
import {
  imageOptsFor,
  insertAt,
  legacyAssets,
  legacyFixMessage,
  mediaCountLabel,
  planImageLinks,
  planVideoLinks,
  remapOffset,
  renumberImageTokens,
  replaceLegacyTags,
  segmentPrompt,
  snapToWordEnd,
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
    // caret in the middle of a plain word: the token ends at the caret (picking must not swallow the rest)
    expect(findMention(t, 10)).toEqual({ start: 8, end: 10, query: 'E' })
    expect(findMention('@', 1)).toEqual({ start: 0, end: 1, query: '' })
  })
  it('extends over the rest of the word only when the whole word is a token', () => {
    // "@" typed right before a plain word: the word is not part of the token
    expect(findMention('climbs the @slope', 12)).toEqual({ start: 11, end: 12, query: '' })
    expect(findMention('the @imslope.', 7)).toEqual({ start: 4, end: 7, query: 'im' })
    // a raw token or a known legacy @Tag is replaced as a whole
    expect(findMention('see @image_12 now', 8)).toEqual({ start: 4, end: 13, query: 'ima' })
    expect(findMention('@video_2', 1)).toEqual({ start: 0, end: 8, query: '' })
    const isTag = (w: string) => w.toLowerCase() === 'elara'
    expect(findMention('At dusk @Ela climbs', 10, isTag)).toEqual({ start: 8, end: 10, query: 'E' })
    expect(findMention('hi @Elara!', 6, isTag)).toEqual({ start: 3, end: 9, query: 'El' })
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
  it('never offers library assets for a number ("@5" + Enter must not link "Lính 5")', () => {
    const lib: LibraryOpt[] = [...library, { assetId: 'l5', name: 'Lính 5', tag: 'Linh5', kind: 'character' }]
    expect(suggestMedia('5', images, videos, lib)).toEqual([])
    expect(suggestMedia('2', images, videos, lib).map(key)).toEqual(['@image_2', '@video_2'])
    expect(suggestMedia('linh', images, videos, lib).map(key)).toEqual(['link:Linh5'])
  })
})

describe('linking from the prompt editor (one store step)', () => {
  it('appends new assets within the image limit and returns their first-image tokens', () => {
    // Elara (2 images) linked → 1,2; dropping Bé An, Làng núi and Elara again
    const plan = planImageLinks(ASSETS, ['a'], ['b', 'c', 'a', 'b'], 30)
    expect(plan.refs).toEqual(['a', 'b', 'c'])
    expect(plan.linked).toEqual(['b', 'c'])
    expect([...plan.tokens.values()]).toEqual(['@image_3', '@image_4', '@image_1'])
  })
  it('skips assets without image and those over the limit (like addRefs)', () => {
    const assets = [...ASSETS, asset('z', 'Trống', 'Trong', { imageIds: [] })]
    const plan = planImageLinks(assets, ['a'], ['z', 'b', 'c', 'd'], 4) // 2 used → b, c fit, d does not
    expect(plan.noImage).toBe(1)
    expect(plan.overLimit).toBe(1)
    expect(plan.refs).toEqual(['a', 'b', 'c'])
    expect([...plan.tokens.keys()]).toEqual(['b', 'c'])
  })
  it('links only finished takes of other scenes, within the video limit', () => {
    const takes = [
      { id: 't1', sceneId: 's2', status: 'completed' },
      { id: 't2', sceneId: 's1', status: 'completed' },
      { id: 't3', sceneId: 's2', status: 'processing' },
      { id: 't4', sceneId: 's3', status: 'completed' },
      { id: 't5', sceneId: 's3', status: 'completed' },
    ]
    const plan = planVideoLinks('s1', ['t9'], ['t1', 't2', 't3', 't9', 't4', 't5'], takes, 3)
    expect(plan).toEqual({
      videoRefs: ['t9', 't1', 't4'],
      tokens: ['@video_2', '@video_1', '@video_3'],
      linked: ['t1', 't4'],
      notReady: 1,
      own: 1,
      overLimit: 1,
    })
    expect(planVideoLinks('s1', [], ['t1'], takes, 0).overLimit).toBe(1) // mode without reference videos
  })
  it('renumbers image tokens when refs are dropped (auto-link undo)', () => {
    // refs [Bé An, Elara(2), Aurelian]: @image_4 = Aurelian; unlinking Elara → Aurelian becomes @image_2
    const before = ['b', 'a', 'd']
    expect(renumberImageTokens('@image_1 and @image_4 meet @image_2', ASSETS, before, ['b', 'd'], [])).toBe('@image_1 and @image_2 meet Elara')
    // an empty name never deletes the token: the tag is used
    const unnamed = ASSETS.map((x) => (x.id === 'a' ? { ...x, name: '  ' } : x))
    expect(renumberImageTokens('@image_2 waves', unnamed, before, ['b', 'd'], [])).toBe('Elara waves')
    expect(renumberImageTokens('no tokens', ASSETS, before, [], [])).toBe('no tokens')
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

describe('segmented settings controls', () => {
  it('keep duration and resolution side by side for one model', () => {
    const sd = MODELS.seedance_2_5
    const h3 = MODELS.minimax_h3
    expect(segmentsNeedFullRow(sd.durations, sd.resolutions)).toBe(false)
    expect(segmentsNeedFullRow(h3.durations, h3.resolutions)).toBe(false)
  })
  it('give them a full row each when several models offer 5 resolutions', () => {
    const resolutions = [...MODELS.seedance_2_5.resolutions, ...MODELS.minimax_h3.resolutions]
    expect(segmentsNeedFullRow(MODELS.seedance_2_5.durations, resolutions)).toBe(true)
  })
})

describe('snapToWordEnd (drop position)', () => {
  it('keeps positions at word boundaries', () => {
    const t = 'At dusk, @image_1 climbs'
    expect(snapToWordEnd(t, 0)).toBe(0)
    expect(snapToWordEnd(t, 2)).toBe(2) // after "At"
    expect(snapToWordEnd(t, 3)).toBe(3) // before "dusk"
    expect(snapToWordEnd(t, 7)).toBe(7) // before ","
    expect(snapToWordEnd(t, t.length)).toBe(t.length)
    expect(snapToWordEnd(t, 999)).toBe(t.length)
    expect(snapToWordEnd(t, -3)).toBe(0)
  })
  it('moves a drop inside a word or a token to its end', () => {
    const t = 'At dusk, @image_1 climbs'
    expect(snapToWordEnd(t, 5)).toBe(7) // "du|sk"
    expect(snapToWordEnd(t, 12)).toBe(17) // "@im|age_1"
    expect(snapToWordEnd(t, 10)).toBe(17) // "@|image_1"
    expect(snapToWordEnd('Bé Ánh sáng', 4)).toBe(6) // vietnamese letters
  })
  it('combines with insertAt without splitting words', () => {
    const t = 'hello world'
    const at = snapToWordEnd(t, 2)
    expect(insertAt(t, at, at, '@image_1 @image_2').next).toBe('hello @image_1 @image_2 world')
  })
})

describe('legend insert (caret after an external rewrite, "@" popup)', () => {
  it('remaps a remembered caret through token renumbering', () => {
    const prev = '@image_1 and @image_2 walk into the forest.'
    const next = 'Elara and @image_1 walk into the forest.' // image 1 removed: renamed, the others renumbered
    const pos = prev.indexOf(' into') // caret after "walk"
    expect(remapOffset(prev, next, pos)).toBe(next.indexOf(' into'))
    // before the first change: unchanged; past the end: clamped
    expect(remapOffset('abc @image_2', 'abc @image_1', 2)).toBe(2)
    expect(remapOffset('abc @image_12 x', 'abc @image_1 x', 15)).toBe(14)
    expect(remapOffset('same', 'same', 3)).toBe(3)
  })
  it('legend inserts never split a word', () => {
    const t = 'walk into the forest.'
    const at = snapToWordEnd(t, t.indexOf('est'))
    expect(insertAt(t, at, at, '@image_2').next).toBe('walk into the forest @image_2.')
  })
  it('reports where the last inserted token starts (popup stays closed there)', () => {
    const t = 'walks.'
    const r = insertAt(t, 5, 5, '@image_1')
    expect(r.next).toBe('walks @image_1.')
    expect(r.last).toBe(6)
    expect(findMention(r.next, r.caret)?.start).toBe(r.last) // caret right after the token, before "."
    const multi = insertAt('go.', 2, 2, '@image_1 @video_2')
    expect(multi.next.slice(multi.last)).toBe('@video_2.')
    expect(insertAt('(x', 1, 1, '@image_3').last).toBe(1)
  })
})

describe('legacyFixMessage', () => {
  it('does not report image-limit refusals as missing images', () => {
    expect(legacyFixMessage(0, 0, 1)).toBeNull() // ensureAssetToken already reported the limit
    expect(legacyFixMessage(2, 0, 1)).toEqual({ text: 'Đã đổi 2 @Tên thành @image_N (bỏ qua 1 mục vượt giới hạn ảnh của model).', tone: 'success' })
    expect(legacyFixMessage(1, 1, 0)?.text).toBe('Đã đổi 1 @Tên thành @image_N (bỏ qua 1 mục chưa có ảnh).')
    expect(legacyFixMessage(1, 1, 2)?.text).toContain('1 mục chưa có ảnh, 2 mục vượt giới hạn')
    expect(legacyFixMessage(0, 2, 1)).toEqual({ text: 'Bỏ qua 2 mục chưa có ảnh nên chưa có số @image. Thêm ảnh cho chúng trước.', tone: 'warning' })
    expect(legacyFixMessage(1, 0, 0)?.text).toBe('Đã đổi 1 @Tên thành @image_N.')
  })
})

describe('popupPlacement ("@" popup stays inside the viewport)', () => {
  it('goes below when it fits', () => {
    expect(popupPlacement(100, 20, 300, 900)).toEqual({ top: 126, maxHeight: POPUP_MAX_H })
  })
  it('flips above when it fits there only', () => {
    const p = popupPlacement(700, 20, 300, 900)
    expect(p.bottom).toBe(900 - 700 + 4)
    expect(p.top).toBeUndefined()
  })
  it('neither side fits: the side with more room, height capped to it', () => {
    const viewH = 700
    const p = popupPlacement(350, 20, 400, viewH) // below: 316px, above: 338px
    expect(p.top).toBeUndefined()
    expect(p.maxHeight).toBe(338)
    expect(viewH - p.bottom! - p.maxHeight).toBeGreaterThanOrEqual(8) // top edge on screen
    const q = popupPlacement(300, 20, 400, viewH) // below: 366px, above: 288px
    expect(q.bottom).toBeUndefined()
    expect(q.top! + q.maxHeight).toBeLessThanOrEqual(viewH - 8) // footer on screen
  })
  it('keeps the popup on screen when the caret is scrolled out of view', () => {
    expect(popupPlacement(-50, 20, 400, 700).top).toBe(8)
    expect(popupPlacement(900, 20, 400, 700).bottom).toBe(8)
  })
})

describe('inspector panel for the selection', () => {
  const sel = (over: Partial<SelectionParts>): SelectionParts => ({ scenes: [], canvasAssets: [], takes: [], libraryAssets: [], ...over })
  it('a take clicked after a library card shows the take', () => {
    expect(pickView(sel({ takes: ['t1'], libraryAssets: ['a'] }), 'canvas')).toEqual({ kind: 'takes', ids: ['t1'] })
    expect(pickView(sel({ canvasAssets: ['b'], libraryAssets: ['a'] }), 'canvas')).toEqual({ kind: 'asset', id: 'b' })
  })
  it('a library card clicked after a canvas node shows the card', () => {
    expect(pickView(sel({ takes: ['t1'], libraryAssets: ['a'] }), 'library')).toEqual({ kind: 'asset', id: 'a' })
    expect(pickView(sel({ canvasAssets: ['b'], libraryAssets: ['a', 'c'] }), 'library')).toEqual({ kind: 'assets', ids: ['a', 'c'] })
  })
  it('scenes win, the library shows when the canvas has nothing else', () => {
    expect(pickView(sel({ scenes: ['s1'], libraryAssets: ['a'] }), 'library')).toEqual({ kind: 'scene', id: 's1' })
    expect(pickView(sel({ scenes: ['s1', 's2'] }), 'canvas')).toEqual({ kind: 'scenes', ids: ['s1', 's2'] })
    expect(pickView(sel({ libraryAssets: ['a'] }), 'canvas')).toEqual({ kind: 'asset', id: 'a' })
    expect(pickView(sel({}), 'library')).toEqual({ kind: 'empty' })
  })
  it('tracks which selection changed last', () => {
    const none = { selectedIds: [] as string[], librarySelection: [] as string[] }
    const lib = { ...none, librarySelection: ['x'] }
    expect(changedSource(lib, none, 'canvas')).toBe('library')
    const take = { ...lib, selectedIds: ['t1'] }
    expect(changedSource(take, lib, 'library')).toBe('canvas')
    expect(changedSource({ ...take, librarySelection: [] }, take, 'library')).toBe('canvas') // library cleared
    expect(changedSource(take, take, 'library')).toBe('library') // unrelated ui change
  })
  it('keeps only existing ids, in selection order', () => {
    expect(existingIds([{ id: 'a' }, { id: 'b' }], ['b', 'zz', 'a'])).toEqual(['b', 'a'])
    expect(existingIds([{ id: 'a' }], [])).toBe(existingIds([{ id: 'b' }], [])) // stable empty list
  })
})
