// RS: the toasts of dragging the image end of a wire onto another character (core/replaceWire), judged against the
// swap's own mapping — picture k of the old character counts as picture k of the new one.
import { describe, expect, it } from 'vitest'
import { planReplace } from '../placeholders'
import { replaceRefusalToast, replaceToast, swapTranslatedKeys } from '../replaceWire'
import type { Asset, Project, Scene } from '../types'

const asset = (id: string, name: string, images = 1): Asset => ({
  id,
  kind: 'character',
  name,
  tag: name,
  description: '',
  imageIds: Array.from({ length: images }, (_, i) => `${id}${i + 1}`),
  color: '#fff',
  position: null,
})

const ALL = [asset('e', 'Elara', 2), asset('l', 'Lumi'), asset('m', 'Mira'), asset('v', 'Village'), asset('n', 'Nova', 0)]

const scene = (prompt: string, refs: string[]): Scene => ({
  id: 's1',
  order: 3,
  title: '',
  prompt,
  refs,
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: 0 },
  note: '',
})

const project = (s: Scene, autoRenumber = true): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber },
  assets: ALL,
  scenes: [s],
})

/** The project after the store's replaceRef (same plan). */
function swap(before: Project, oldId: string, newId: string): Project {
  const s = before.scenes[0]
  const plan = planReplace(s, before.assets, oldId, newId, { renumber: before.settings.autoRenumber, maxImages: 9 })
  if (!plan.ok) throw new Error(plan.why)
  return { ...before, scenes: [{ ...s, prompt: plan.prompt, refs: plan.refs }] }
}

const toastOf = (prompt: string, refs: string[], oldId: string, newId: string, renumber = true) => {
  const before = project(scene(prompt, refs), renumber)
  return replaceToast(before, swap(before, oldId, newId), 's1', oldId, newId)
}

describe('swapTranslatedKeys: the mapping planReplace renumbers by', () => {
  it('picture k of the old character reads as picture k of the new one; its pictures past the new count keep their key', () => {
    expect(swapTranslatedKeys(ALL, ['l', 'v'], 'l', 'e')).toEqual(['e:e1', 'v:v1'])
    expect(swapTranslatedKeys(ALL, ['e', 'v'], 'e', 'm')).toEqual(['m:m1', 'e:e2', 'v:v1'])
    expect(swapTranslatedKeys(ALL, ['v'], 'l', 'm')).toEqual(['v:v1'])
  })
})

describe('replaceToast', () => {
  it('same count: "prompt giữ nguyên" (success), whatever the renumbering setting', () => {
    for (const renumber of [true, false]) {
      expect(toastOf('@image_1 hugs @image_2', ['l', 'v'], 'l', 'm', renumber)).toEqual({ text: 'Đã thay Lumi bằng Mira ở S03 — prompt giữ nguyên.', tone: 'success' })
    }
  })

  it('more pictures: the swapped slot is never stale; renumbered later numbers are info, kept stale ones a warning', () => {
    expect(toastOf('@image_1 walks', ['l'], 'l', 'e', false)).toEqual({ text: 'Đã thay Lumi bằng Elara ở S03 — prompt giữ nguyên.', tone: 'success' })
    expect(toastOf('@image_1 and @image_2', ['l', 'v'], 'l', 'e')).toEqual({ text: 'Đã thay Lumi bằng Elara ở S03 · đánh lại số @image trong prompt.', tone: 'info' })
    expect(toastOf('@image_1 and @image_2', ['l', 'v'], 'l', 'e', false)).toEqual({
      text: 'Đã thay Lumi bằng Elara ở S03 · tự đánh lại số đang tắt — hãy sửa số @image trong S03.',
      tone: 'warning',
      ms: 8000,
    })
  })

  it('fewer pictures: the red placeholder tail (10 s), no stale tail for the swapped slot', () => {
    for (const renumber of [true, false]) {
      expect(toastOf('@image_1 then @image_2', ['e'], 'e', 'm', renumber)).toEqual({
        text: 'Đã thay Elara bằng Mira ở S03 — prompt giữ chữ đỏ @image_?2(Elara · ảnh 2) (chặn Chạy) để bạn gắn ảnh thay thế.',
        tone: 'warning',
        ms: 10000,
      })
    }
  })

  it('labelled tokens of the old character that no longer fit block the run: counted, and after a placeholder', () => {
    expect(toastOf('@image_1(Lumi) and @image_1(Lumi) by @image_2(Village)', ['l', 'v'], 'l', 'm')).toEqual({
      text: 'Đã thay Lumi bằng Mira ở S03 — @image_1(Lumi) (+1) không còn khớp ảnh (chặn Chạy).',
      tone: 'warning',
      ms: 8000,
    })
    expect(toastOf('@image_1(Elara) in @image_2', ['e'], 'e', 'm').text).toBe(
      'Đã thay Elara bằng Mira ở S03 — prompt giữ chữ đỏ @image_?2(Elara · ảnh 2) (chặn Chạy) để bạn gắn ảnh thay thế · @image_1(Elara) không còn khớp ảnh.',
    )
    // a label that did not fit before the swap is not news
    expect(toastOf('@image_2(Lumi) with @image_1', ['l', 'v'], 'l', 'm')).toEqual({ text: 'Đã thay Lumi bằng Mira ở S03 — prompt giữ nguyên.', tone: 'success' })
  })

  it('a scene gone meanwhile: the plain sentence', () => {
    const before = project(scene('@image_1', ['l']))
    expect(replaceToast(before, { ...before, scenes: [] }, 's1', 'l', 'm')).toEqual({ text: 'Đã thay Lumi bằng Mira.', tone: 'success' })
  })
})

describe('replaceRefusalToast: a refused drop says why (the wire stays)', () => {
  const p = project(scene('@image_1 @image_2', ['l', 'v']))
  it('already linked / no picture / over the model limit', () => {
    expect(replaceRefusalToast('already-linked', p, 's1', 'l', 'v')).toEqual({ text: 'Không thay được Lumi bằng Village: S03 đã có Village — giữ nguyên nối cũ.', tone: 'info' })
    expect(replaceRefusalToast('no-image', p, 's1', 'l', 'n')).toEqual({ text: 'Không thay được Lumi bằng Nova: Nova chưa có ảnh — giữ nguyên nối cũ.', tone: 'info' })
    expect(replaceRefusalToast('over-limit', p, 's1', 'l', 'e')).toEqual({
      text: 'Không thay được Lumi bằng Elara ở S03 (vượt giới hạn ảnh của model) — giữ nguyên nối cũ.',
      tone: 'warning',
    })
  })
  it('nothing to say when the wire is stale or the target is not a character', () => {
    expect(replaceRefusalToast('not-linked', p, 's1', 'm', 'e')).toBeNull()
    expect(replaceRefusalToast('no-asset', p, 's1', 'l', 'x')).toBeNull()
    expect(replaceRefusalToast('over-limit', p, 'gone', 'l', 'e')).toBeNull()
  })
})
