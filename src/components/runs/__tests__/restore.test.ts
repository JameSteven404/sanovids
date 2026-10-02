import { describe, expect, it } from 'vitest'
import type { Asset } from '../../../core/types'
import { restoredFromTake, snapshotImageKeys, snapshotImageNumbers } from '../restore'

const asset = (id: string, name: string, images = 1): Asset => ({
  id,
  kind: 'character',
  name,
  tag: name,
  description: '',
  imageIds: Array.from({ length: images }, (_, i) => `${id}-img${i}`),
  color: '#fff',
  position: null,
})

const elara = asset('a', 'Elara')
const dog = asset('b', 'Dog')
const light = asset('c', 'Lighthouse')

const take = (prompt: string, refs: string[], videoRefs: string[] = []) => ({ rawPromptSnapshot: prompt, refsSnapshot: refs, videoRefsSnapshot: videoRefs })

describe('snapshotImageKeys / snapshotImageNumbers', () => {
  it('counts a deleted asset as one slot so later numbers keep their place', () => {
    expect(snapshotImageKeys([elara, light], ['a', 'b', 'c'])).toEqual(['a:a-img0', 'b:?', 'c:c-img0'])
    expect(snapshotImageNumbers([elara, light], ['a', 'b', 'c'])).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]),
    )
  })
  it('gives every image of an asset its own number and skips assets without images', () => {
    const multi = asset('m', 'Multi', 2)
    const empty = asset('e', 'Empty', 0)
    const nums = snapshotImageNumbers([multi, empty, dog], ['m', 'e', 'b'])
    expect(nums.get('m')).toBe(1)
    expect(nums.has('e')).toBe(false)
    expect(nums.get('b')).toBe(3)
  })
})

describe('restoredFromTake', () => {
  it('renumbers @video tokens when a referenced take was deleted', () => {
    const r = restoredFromTake(take('Continue from @video_2, echoing @video_1', [], ['t1', 't2']), [], new Set(['t2']), { renumber: true })
    expect(r.videoRefs).toEqual(['t2'])
    expect(r.prompt).toBe('Continue from @video_1, echoing video')
    expect(r.gone).toBe(1)
    expect(r.renumbered).toBe(true)
  })
  it('uses the given label for a dropped video', () => {
    const r = restoredFromTake(take('From @video_1', [], ['t1']), [], new Set(), { renumber: true, videoLabel: (id) => `video ${id}` })
    expect(r.prompt).toBe('From video t1')
  })
  it('renumbers @image tokens when a referenced asset was deleted (deleted asset → "ảnh")', () => {
    const r = restoredFromTake(take('@image_1 pets @image_2 near @image_3', ['a', 'b', 'c']), [elara, light], new Set(), { renumber: true })
    expect(r.refs).toEqual(['a', 'c'])
    expect(r.prompt).toBe('@image_1 pets ảnh near @image_2')
  })
  it('keeps the prompt as written when nothing is gone or renumbering is off', () => {
    const text = '@image_2 and @video_1'
    expect(restoredFromTake(take(text, ['a', 'b'], ['t1']), [elara, dog], new Set(['t1']), { renumber: true })).toEqual({
      prompt: text,
      refs: ['a', 'b'],
      videoRefs: ['t1'],
      gone: 0,
      renumbered: false,
      uncertain: 0,
    })
    const off = restoredFromTake(take(text, ['a', 'b'], ['t1']), [elara], new Set(), { renumber: false })
    expect(off.prompt).toBe(text)
    expect(off.refs).toEqual(['a'])
    expect(off.videoRefs).toEqual([])
    expect(off.gone).toBe(2)
  })
  it('flags the tokens after a deleted multi-image asset of an older take as uncertain', () => {
    // A had 2 images when the take ran: @image_2 was A's second picture, @image_3 was B. Without an image
    // snapshot the deleted asset counts as one image, so the numbers after it are a guess the user must check.
    // ('m' is gone from the library, so it is not in the asset list.)
    const r = restoredFromTake(take('@image_1 then @image_2 then @image_3', ['m', 'b']), [dog], new Set(), { renumber: true })
    expect(r.refs).toEqual(['b'])
    expect(r.uncertain).toBe(2)
    expect(r.prompt.startsWith('ảnh then')).toBe(true)
    // Before the deleted asset the numbers are certain.
    const sure = restoredFromTake(take('@image_1 near @image_2', ['b', 'm']), [dog], new Set(), { renumber: true })
    expect(sure.prompt).toBe('@image_1 near ảnh')
    expect(sure.uncertain).toBe(0)
  })
  it('uses the exact image snapshot when the take has one', () => {
    const t = { ...take('@image_1 then @image_2 then @image_3', ['m', 'b']), imageKeysSnapshot: ['m:m-img0', 'm:m-img1', 'b:b-img0'] }
    const r = restoredFromTake(t, [dog], new Set(), { renumber: true })
    expect(r.prompt).toBe('ảnh then ảnh then @image_1')
    expect(r.uncertain).toBe(0)
  })
  it('with the exact snapshot, renumbers when an asset gained images since the run', () => {
    const grown = asset('a', 'Elara', 2)
    const t = { ...take('@image_1 and @image_2', ['a', 'b']), imageKeysSnapshot: ['a:a-img0', 'b:b-img0'] }
    const r = restoredFromTake(t, [grown, dog], new Set(), { renumber: true })
    expect(r.gone).toBe(0)
    expect(r.prompt).toBe('@image_1 and @image_3')
    expect(r.renumbered).toBe(true)
    expect(snapshotImageNumbers([grown, dog], ['a', 'b'], t.imageKeysSnapshot)).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    )
  })
  it('leaves tokens that were already out of range untouched', () => {
    const r = restoredFromTake(take('@image_9 and @image_2', ['a', 'b']), [dog], new Set(), { renumber: true })
    expect(r.prompt).toBe('@image_9 and @image_1')
  })
})
