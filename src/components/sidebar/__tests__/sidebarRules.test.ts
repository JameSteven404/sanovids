import { describe, expect, it } from 'vitest'
import type { Asset, Scene, VideoSettings } from '../../../core/types'
import { imageRenumberNote, libraryCardKey, newAssetKind, sceneMediaFlags, scenesWithShiftedImageTokens } from '../shared'

const settings = (patch: Partial<VideoSettings> = {}): VideoSettings => ({
  model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9', ...patch,
})

const scene = (id: string, prompt: string, refs: string[]): Scene => ({
  id, order: 1, title: '', prompt, refs, videoRefs: [], presetId: null, settings: settings(),
  firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: 0 }, note: '',
})

const asset = (id: string, imageIds: string[]): Asset => ({
  id, kind: 'character', name: id, tag: id, description: '', imageIds, color: '#fff', position: null,
})

describe('library card keys', () => {
  it('never lets Delete / Backspace reach the global shortcut (it deletes the canvas selection)', () => {
    expect(libraryCardKey('Delete')).toBe('block')
    expect(libraryCardKey('Backspace')).toBe('block')
  })
  it('keeps Enter = open, Space = toggle, other keys untouched', () => {
    expect(libraryCardKey('Enter')).toBe('open')
    expect(libraryCardKey(' ')).toBe('toggle')
    expect(libraryCardKey('c')).toBeNull()
    expect(libraryCardKey('Escape')).toBeNull()
  })
})

describe('kind of new library items', () => {
  it('uses the active kind tab when the library has items', () => {
    expect(newAssetKind('prop', 3)).toBe('prop')
    expect(newAssetKind('all', 3)).toBe('character')
  })
  it('ignores a remembered tab while the library is empty (its tabs are hidden)', () => {
    expect(newAssetKind('prop', 0)).toBe('character')
    expect(newAssetKind('style', 0)).toBe('character')
  })
})

describe('@image tokens moved by an image change (renumbering off)', () => {
  // S1: [Elara (2 images) → @image_1–2, Kai → @image_3]; S2: [Kai → @image_1, Elara → @image_2–3]
  const assets = [asset('elara', ['e1', 'e2']), asset('kai', ['k1'])]
  const s1 = scene('s1', '@image_1 hugs @image_3', ['elara', 'kai'])
  const s2 = scene('s2', '@image_1 waves', ['kai', 'elara'])
  const s3 = scene('s3', 'no tokens', ['elara'])
  const s4 = scene('s4', '@image_2 alone', ['kai'])

  it('removing an image moves its number and every number after it', () => {
    // Remove Elara's 2nd image: S1 @image_3 (Kai) now out of range; S2 @image_1 is Kai, before Elara → unchanged.
    expect(scenesWithShiftedImageTokens(assets, [s1, s2, s3, s4], 'elara', 1)).toEqual(['s1'])
    // Remove Elara's primary image: S1 @image_1 now points at the other photo.
    expect(scenesWithShiftedImageTokens(assets, [s1, s2, s3, s4], 'elara', 0)).toEqual(['s1'])
  })

  it('a reorder only moves the numbers inside the range', () => {
    const only3 = scene('o3', 'see @image_3', ['elara', 'kai'])
    expect(scenesWithShiftedImageTokens(assets, [only3], 'elara', 0, 1)).toEqual([])
    const only2 = scene('o2', 'see @image_2', ['elara', 'kai'])
    expect(scenesWithShiftedImageTokens(assets, [only2], 'elara', 0, 1)).toEqual(['o2'])
  })

  it('adding images moves the numbers after the asset', () => {
    // New images go after Elara's 2: @image_3 (Kai) in S1 moves; S2 has Elara last → @image_1 stays.
    expect(scenesWithShiftedImageTokens(assets, [s1, s2], 'elara', 2)).toEqual(['s1'])
    expect(scenesWithShiftedImageTokens(assets, [s2], 'kai', 1)).toEqual([])
  })

  it('ignores scenes not using the asset and @video tokens', () => {
    expect(scenesWithShiftedImageTokens(assets, [s4], 'elara', 0)).toEqual([])
    const vid = scene('v', '@video_1 then @video_2', ['elara'])
    expect(scenesWithShiftedImageTokens(assets, [vid], 'elara', 0)).toEqual([])
  })
})

describe('renumbering note under the asset images', () => {
  it('promises automatic renumbering only when it is on', () => {
    expect(imageRenumberNote(true, 2)).toEqual({ text: expect.stringContaining('tự đánh lại số @image'), warn: false })
    expect(imageRenumberNote(true, 2).text).toContain('(2 cảnh)')
  })
  it('warns when it is off (Settings)', () => {
    const note = imageRenumberNote(false, 3)
    expect(note.warn).toBe(true)
    expect(note.text).toContain('đang tắt')
    expect(note.text).toContain('3 cảnh')
    expect(imageRenumberNote(false, 0).warn).toBe(true)
  })
})

describe('media sent by the selected scene', () => {
  it('Seedance and H3 image→video send images and videos', () => {
    expect(sceneMediaFlags(settings())).toEqual({ images: true, videos: true, model: 'Seedance 2.5' })
    expect(sceneMediaFlags(settings({ model: 'minimax_h3', mode: 'i2v', resolution: '768p' }))).toMatchObject({ images: true, videos: true })
  })
  it('H3 text→video / transform send no reference media', () => {
    expect(sceneMediaFlags(settings({ model: 'minimax_h3', mode: 't2v', resolution: '768p' }))).toEqual({ images: false, videos: false, model: 'MiniMax-H3' })
    expect(sceneMediaFlags(settings({ model: 'minimax_h3', mode: 'transform', resolution: '768p' }))).toMatchObject({ images: false, videos: false })
  })
  it('no scene → nothing to warn about', () => {
    expect(sceneMediaFlags(undefined)).toMatchObject({ images: true, videos: true })
  })
})
