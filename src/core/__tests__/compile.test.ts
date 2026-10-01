import { describe, expect, it } from 'vitest'
import { compileScene, extractMentions, mediaKeys, parseTokens, remapTokens, slugTag, tokenForAsset, uniqueTag } from '../compile'
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
    expect(out.text).toBe('[image:a:i1] @image_2 @image_1 @image_9 @video_1 [video:t1]')
    expect(out.dropped).toBe(2)
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
