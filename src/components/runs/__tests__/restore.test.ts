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

const take = (prompt: string, refs: string[]) => ({ rawPromptSnapshot: prompt, refsSnapshot: refs })

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
  it('restores @video text of an older take exactly as it was written (reference videos were retired) and lists it', () => {
    const old = { ...take('Continue from @video_2, echoing @video_1 and @image_2', ['a', 'b']), videoRefsSnapshot: ['t1', 't2'], legacyVideoRefsSnapshot: ['t1'] }
    const r = restoredFromTake(old, [dog], { renumber: true })
    expect(r.prompt).toBe('Continue from @video_2, echoing @video_1 and @image_1')
    expect(r.retired).toEqual(['@video_2', '@video_1'])
    expect(r).not.toHaveProperty('videoRefs')
    expect(r.gone).toBe(1)
    const plain = restoredFromTake(take('From @video_1', []), [], { renumber: true })
    expect(plain.prompt).toBe('From @video_1')
    expect(plain.renumbered).toBe(false)
  })
  it('renumbers @image tokens when a referenced asset was deleted (deleted asset → "ảnh")', () => {
    const r = restoredFromTake(take('@image_1 pets @image_2 near @image_3', ['a', 'b', 'c']), [elara, light], { renumber: true })
    expect(r.refs).toEqual(['a', 'c'])
    expect(r.prompt).toBe('@image_1 pets ảnh near @image_2')
  })
  it('keeps the prompt as written when nothing is gone or renumbering is off', () => {
    const text = '@image_2 and @video_1'
    expect(restoredFromTake(take(text, ['a', 'b']), [elara, dog], { renumber: true })).toEqual({
      prompt: text,
      refs: ['a', 'b'],
      gone: 0,
      renumbered: false,
      uncertain: 0,
      stale: false,
      retired: ['@video_1'],
    })
    const off = restoredFromTake(take(text, ['a', 'b']), [elara], { renumber: false })
    expect(off.prompt).toBe(text)
    expect(off.refs).toEqual(['a'])
    expect(off.gone).toBe(1)
    // @image_2 (the dog) now points at nothing: the user is told to check the numbers
    expect(off.stale).toBe(true)
  })
  it('flags the tokens after a deleted multi-image asset of an older take as uncertain', () => {
    // A had 2 images when the take ran: @image_2 was A's second picture, @image_3 was B. Without an image
    // snapshot the deleted asset counts as one image, so the numbers after it are a guess the user must check.
    // ('m' is gone from the library, so it is not in the asset list.)
    const r = restoredFromTake(take('@image_1 then @image_2 then @image_3', ['m', 'b']), [dog], { renumber: true })
    expect(r.refs).toEqual(['b'])
    expect(r.uncertain).toBe(2)
    expect(r.prompt.startsWith('ảnh then')).toBe(true)
    // Before the deleted asset the numbers are certain.
    const sure = restoredFromTake(take('@image_1 near @image_2', ['b', 'm']), [dog], { renumber: true })
    expect(sure.prompt).toBe('@image_1 near ảnh')
    expect(sure.uncertain).toBe(0)
  })
  it('uses the exact image snapshot when the take has one', () => {
    const t = { ...take('@image_1 then @image_2 then @image_3', ['m', 'b']), imageKeysSnapshot: ['m:m-img0', 'm:m-img1', 'b:b-img0'] }
    const r = restoredFromTake(t, [dog], { renumber: true })
    expect(r.prompt).toBe('ảnh then ảnh then @image_1')
    expect(r.uncertain).toBe(0)
  })
  it('with the exact snapshot, renumbers when an asset gained images since the run', () => {
    const grown = asset('a', 'Elara', 2)
    const t = { ...take('@image_1 and @image_2', ['a', 'b']), imageKeysSnapshot: ['a:a-img0', 'b:b-img0'] }
    const r = restoredFromTake(t, [grown, dog], { renumber: true })
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
  it('turns tokens that were already out of range into placeholders', () => {
    const r = restoredFromTake(take('@image_9 and @image_2', ['a', 'b']), [dog], { renumber: true })
    expect(r.prompt).toBe('@image_?9 and @image_1')
  })
})
