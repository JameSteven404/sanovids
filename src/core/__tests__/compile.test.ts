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
  it('retired @video tokens: kept in the text, never sent, named in retiredTokens AND unsentTokens with one warning', () => {
    const s = scene({ prompt: 'Continue from @video_1 then @video_2 and @video_1', legacyVideoRefs: ['t1', 't2'] })
    const out = compileScene(project([s]), s, { takeStatus: () => 'completed' })
    expect(out.text).toBe('Continue from @video_1 then @video_2 and @video_1')
    expect(out).not.toHaveProperty('videos')
    expect(out.retiredTokens).toEqual(['@video_1', '@video_2'])
    expect(out.unsentTokens).toEqual(['@video_1', '@video_2'])
    expect(out.warnings).toEqual(['Prompt còn @video_1, @video_2: SanoVids đã bỏ video tham chiếu, chữ này sẽ không kèm video nào — xoá hoặc viết lại bằng lời.'])
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
    const before = mediaKeys(p.assets, ['a', 'b', 'c'])
    // a has 2 images: a=1,2  b=3  c=4. Remove a, move c first: c=1 b=2
    const after = mediaKeys(p.assets, ['c', 'b'])
    const out = remapTokens('@image_1 @image_3 @image_4 @image_9 @video_2 @video_1', before, after, (key) => `[${key}]`)
    // @image_9 pointed at nothing before: it becomes a placeholder instead of silently binding to a new image;
    // retired @video tokens are kept byte for byte
    expect(out.text).toBe('[a:i1] @image_2 @image_1 @image_?9 @video_2 @video_1')
    expect(out.dropped).toBe(1)
  })
  it('a removed token right after an "@" ("@@image_2") never glues its fallback to it (no new token / mention)', () => {
    const p = project([])
    const before = mediaKeys(p.assets, ['a', 'b', 'c'])
    const after = mediaKeys(p.assets, ['b', 'c'])
    const out = remapTokens('x @@image_1 y @@video_1 z @@image_3', before, after, () => 'image 3')
    expect(out.text).toBe('x @ image 3 y @@video_1 z @@image_1')
    // what is left points exactly where it did: b's image (now @image_1); the retired @video text is untouched
    const at = out.text.lastIndexOf('@image_1')
    expect(parseTokens(out.text).filter((t) => t.kind === 'image')).toEqual([{ kind: 'image', n: 1, start: at, end: at + 8 }])
    expect(extractMentions(out.text)).toEqual([])
  })
  it('a fallback never glues onto an open "@…" before it: no new token / mention / placeholder (and never an "@" of its own)', () => {
    const p = project([])
    // a = @image_1, @image_2 · b = @image_3 (cut) · c = @image_4 → @image_3
    const before = mediaKeys(p.assets, ['a', 'b', 'c'])
    const after = mediaKeys(p.assets, ['a', 'c'])
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
    const before = mediaKeys(p.assets, ['a', 'b', 'c'])
    const after = mediaKeys(p.assets, ['a', 'c'])
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

describe('red placeholders in compile (GT1)', () => {
  it('remapTokens: the fallback gets the old number; keepNumbers keeps every number whose picture is still there', () => {
    const before = mediaKeys(project([]).assets, ['a', 'b', 'c']) // a = 1, 2  b = 3  c = 4
    const after = mediaKeys(project([]).assets, ['a', 'c'])
    const seen: [string, number][] = []
    const out = remapTokens('@image_3 and @image_4', before, after, (key, n) => {
      seen.push([key, n])
      return 'x'
    })
    expect(out.text).toBe('x and @image_3')
    expect(seen).toEqual([['b:i3', 3]])
    expect(remapTokens('@image_1 @image_3 @image_4 @image_9', before, after, () => 'x', { keepNumbers: true, placeholder: () => 'Bé An' }).text).toBe(
      '@image_1 @image_?3(Bé An) @image_4 @image_9',
    )
  })
  it('placeholder mode: never a name, the label is optional, a glued label stays the label', () => {
    const before = mediaKeys(project([]).assets, ['b', 'c'])
    const after = mediaKeys(project([]).assets, ['c'])
    expect(remapTokens('@image_1 x', before, after, () => 'NAME', { placeholder: () => null }).text).toBe('@image_?1 x')
    expect(remapTokens('@Image 1(Lumi) x', before, after, () => 'NAME', { placeholder: () => 'Bé An' }).text).toBe('@image_?1(Lumi) x')
  })
  it('unsentTokens holds placeholders verbatim, label included, with the bar sentence', () => {
    const s = scene({ prompt: '@image_1 hugs @image_?2(Bé An) and @image_?3', refs: ['c'] })
    const out = compileScene(project([s]), s)
    expect(out.unsentTokens).toEqual(['@image_?2(Bé An)', '@image_?3'])
    expect(out.warnings).toContain(
      '@image_?2(Bé An): ảnh “Bé An” đã bị bỏ nối khỏi cảnh — nối ảnh thay thế rồi chọn ở dải “Chữ đỏ chờ ảnh” dưới ô prompt, hoặc bấm “Đổi thành chữ” nếu không cần nhân vật đó.',
    )
    expect(out.warnings).toContain('@image_?3 chưa gắn ảnh nào — nối vào cảnh rồi sửa thành số đúng (vd. @image_1).')
  })
  it('MENTION_RE never reads the "@image_" of a placeholder as a tag (a tag named "image_" would otherwise steal it)', () => {
    expect([...'@image_?2(Lumi) @Elara @image_x'.matchAll(MENTION_RE)].map((m) => m[1])).toEqual(['Elara', 'image_x'])
  })
})
