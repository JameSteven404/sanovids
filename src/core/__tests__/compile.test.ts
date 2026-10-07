import { describe, expect, it } from 'vitest'
import { compileScene, extractMentions, mediaKeys, MENTION_RE, parseTokens, remapTokens, slugTag, TOKEN_RE, tokenForAsset, UNBOUND_RE, uniqueTag } from '../compile'
import type { Project, Scene } from '../types'

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1',
  order: 1,
  title: 'Test',
  prompt: '',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: 0 },
  note: '',
  ...over,
})
const project = (scenes: Scene[]): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [
    { id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: 'red hair', imageIds: ['i1', 'i2'], color: '#fff', position: null },
    { id: 'b', kind: 'character', name: 'Bé An', tag: 'BeAn', description: '', imageIds: ['i3'], color: '#fff', position: null },
    { id: 'c', kind: 'location', name: 'Cave', tag: 'Cave', description: '', imageIds: ['i4'], color: '#fff', position: null },
  ],
  scenes,
})

describe('compileScene', () => {
  it('sends the prompt as written and numbers images in ref order', () => {
    const s = scene({ prompt: '@image_1 hugs @image_2 near @image_4', refs: ['b', 'a', 'c'] })
    const out = compileScene(project([s]), s)
    expect(out.text).toBe('@image_1 hugs @image_2 near @image_4')
    expect(out.images.map((i) => [i.n, i.assetId])).toEqual([
      [1, 'b'],
      [2, 'a'],
      [3, 'a'],
      [4, 'c'],
    ])
    expect(out.warnings).toEqual([])
    expect(out.notes.some((n) => n.includes('@image_3'))).toBe(true)
  })
  it('converts legacy @Tag mentions and warns about unlinked ones', () => {
    const s = scene({ prompt: '@BeAn and @Elara in @Cave', refs: ['b', 'a'] })
    const out = compileScene(project([s]), s)
    expect(out.text).toBe('@image_1 and @image_2 in Cave')
    expect(out.warnings.some((w) => w.includes('Cave'))).toBe(true)
  })
  it('warns about tokens that point nowhere', () => {
    const s = scene({ prompt: '@image_5 and @video_1', refs: ['b'] })
    const out = compileScene(project([s]), s)
    expect(out.warnings.some((w) => w.includes('@image_5'))).toBe(true)
    expect(out.warnings.some((w) => w.includes('@video_1'))).toBe(true)
  })
  it('numbers reference videos and checks their status', () => {
    const s = scene({ prompt: 'Continue from @video_1 then @video_2', videoRefs: ['t1', 't2'] })
    const out = compileScene(project([s]), s, { takeStatus: (id) => (id === 't1' ? 'completed' : 'processing') })
    expect(out.videos).toEqual([
      { n: 1, takeId: 't1' },
      { n: 2, takeId: 't2' },
    ])
    expect(out.warnings).toEqual(['@video_2 chưa tạo xong.'])
  })
  it('h3 t2v sends no images and uses the H3 prompt limit', () => {
    const s = scene({ prompt: 'walks', refs: ['a'], settings: { model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '768p', ratio: '16:9' } })
    const out = compileScene(project([s]), s)
    expect(out.images).toHaveLength(0)
    expect(out.limit).toBe(7000)
  })
})

describe('tokens', () => {
  it('parses tokens with positions', () => {
    expect(parseTokens('a @image_2 b @Video_10')).toEqual([
      { kind: 'image', n: 2, start: 2, end: 10 },
      { kind: 'video', n: 10, start: 13, end: 22 },
    ])
  })
  it('remaps tokens after a reorder and a removal', () => {
    const p = project([])
    const before = mediaKeys(p.assets, ['a', 'b', 'c'], ['t1', 't2'])
    // a has 2 images: a=1,2  b=3  c=4. Remove a, move c first: c=1 b=2
    const after = mediaKeys(p.assets, ['c', 'b'], ['t2'])
    const out = remapTokens('@image_1 @image_3 @image_4 @image_9 @video_2 @video_1', before, after, (k, key) => `[${k}:${key}]`)
    // @image_9 pointed at nothing before: it becomes a placeholder instead of silently binding to a new image
    expect(out.text).toBe('[image:a:i1] @image_2 @image_1 @image_?9 @video_1 [video:t1]')
    expect(out.dropped).toBe(2)
  })
  it('a removed token right after an "@" ("@@image_2") never glues its fallback to it (no new token / mention)', () => {
    const p = project([])
    const before = mediaKeys(p.assets, ['a', 'b', 'c'], ['t1'])
    const after = mediaKeys(p.assets, ['b', 'c'], [])
    const out = remapTokens('x @@image_1 y @@video_1 z @@image_3', before, after, (k) => (k === 'image' ? 'image 3' : 'Lumi'))
    expect(out.text).toBe('x @ image 3 y @ Lumi z @@image_1')
    // what is left points exactly where it did: one token, b's image (now @image_1)
    expect(parseTokens(out.text)).toEqual([{ kind: 'image', n: 1, start: 24, end: 32 }])
    expect(extractMentions(out.text)).toEqual([])
  })
  it('a fallback never glues onto an open "@…" before it: no new token / mention / placeholder (and never an "@" of its own)', () => {
    const p = project([])
    // a = @image_1, @image_2 · b = @image_3 (cut) · c = @image_4 → @image_3
    const before = mediaKeys(p.assets, ['a', 'b', 'c'], [])
    const after = mediaKeys(p.assets, ['a', 'c'], [])
    const cut = (text: string, name: string) => remapTokens(text, before, after, () => name).text
    // "@image " / "@image" + "3 chị em" would read "@image 3": a token of another picture
    expect(cut('ảnh @image @image_3 đi', '3 chị em')).toBe('ảnh @image  3 chị em đi')
    expect(cut('ảnh @image@image_3 đi', '3 chị em')).toBe('ảnh @image  3 chị em đi')
    expect(cut('ảnh @image_@image_3 đi', '3 chị em')).toBe('ảnh @image_ 3 chị em đi')
    expect(parseTokens(cut('ảnh @image @image_3 đi', '3 chị em'))).toEqual([])
    // "@Lu" + "mi" would be the mention "@Lumi" (compileScene sends Lumi's picture)
    expect(cut('cô @Lu@image_3 cười', 'mi')).toBe('cô @Lu mi cười')
    expect(extractMentions(cut('cô @Lu@image_3 cười', 'mi'))).toEqual(['Lu'])
    // a token kept right before it: "@image_1" + "3" would be "@image_13"; a placeholder: "@image_?9" + "4" → "@image_?94"
    expect(cut('@image_1@image_3 x', '3 chị em')).toBe('@image_1 3 chị em x')
    expect(cut('@image_?9@image_3', '4 mèo')).toBe('@image_?9 4 mèo')
    // a renumbered token right before it is what it is checked against (built from the text really written)
    expect(cut('@image_4@image_3', '1 cô')).toBe('@image_3 1 cô')
    // whatever name a caller passes, no "@" is pasted
    expect(cut('x @image_3 y', '@Lumi @image_1')).toBe('x Lumi image_1 y')
    // nothing open before it: glued as before
    expect(cut('abc@image_3 x', 'Mi')).toBe('abcMi x')
  })
  it('the join of a fallback with the text before it never forms a match of its own (every token / mention / placeholder)', () => {
    const p = project([])
    const before = mediaKeys(p.assets, ['a', 'b', 'c'], [])
    const after = mediaKeys(p.assets, ['a', 'c'], [])
    const cut = (text: string, name: string) => remapTokens(text, before, after, () => name).text
    const found = (text: string) => [TOKEN_RE, MENTION_RE, UNBOUND_RE].map((re) => [...text.matchAll(re)].map((m) => m[0]))
    const lefts = ['', 'x ', '@', '@@', 'ảnh @image ', 'ảnh @image', 'a @image_', '@Image_', '@VIDEO ', '@video', '@imag', '@Lu', 'cô @Lu', 'e@mail']
    const keptLefts = ['@image_1', '@Image 2', '@IMAGE1', '@image_?9', '@image_?', '@image_1@']
    const names = ['3 chị em', 'mi', 'image 3', '_3', ' 4', '9', '@Lumi', '@image_1', '', 'Elara', '?', '?2', 'e 3']
    for (const left of [...lefts, ...keptLefts])
      for (const name of names)
        for (const right of ['', ' đi', '.', '?x']) {
          const out = cut(`${left}@image_3${right}`, name)
          const parts = found(cut(left, name)).map((list, i) => [...list, ...found(right)[i]])
          expect(found(out), JSON.stringify({ left, name, right, out })).toEqual(parts)
        }
  })
  it('token for an asset is its primary image number', () => {
    const s = scene({ refs: ['b', 'a'] })
    expect(tokenForAsset(project([s]), s, 'a')).toBe('@image_2')
    expect(tokenForAsset(project([s]), s, 'c')).toBeNull()
  })
})

describe('tags', () => {
  it('slugifies vietnamese', () => {
    expect(slugTag('Bé An')).toBe('BeAn')
    expect(slugTag('làng núi đá')).toBe('LangNuiDa')
    expect(uniqueTag('Elara', ['elara'])).toBe('Elara2')
    expect(extractMentions('@Elara and @elara and @image_2 @BeAn')).toEqual(['Elara', 'BeAn'])
  })
})
