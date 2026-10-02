import { describe, expect, it } from 'vitest'
import type { Asset, Preset, Project, Scene, VideoSettings } from '../../../core/types'
import {
  appliedPresetId,
  imageRenumberNote,
  kindMeta,
  KIND_META,
  libraryCardKey,
  modelSpec,
  modeLabel,
  newAssetKind,
  packColumns,
  presetMatches,
  sceneMediaFlags,
  scenesWithShiftedImageTokens,
  scenesWithStaleTokens,
  staleTokenNote,
} from '../shared'

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

describe('packColumns (library masonry)', () => {
  it('puts each card in the shorter column, left on a tie, keeping list order', () => {
    // a tall card first: the wide cards go right until that column is taller
    expect(packColumns([2, 0.7, 0.7, 0.7, 1], 2)).toEqual([[0, 4], [1, 2, 3]])
    expect(packColumns([1, 1, 1, 1], 2)).toEqual([[0, 2], [1, 3]])
  })
  it('one column keeps everything in order; bad heights count as 1', () => {
    expect(packColumns([1, 2, 3], 1)).toEqual([[0, 1, 2]])
    expect(packColumns([Number.NaN, 0, 1], 2)).toEqual([[0, 2], [1]])
    expect(packColumns([], 2)).toEqual([[], []])
  })
})

describe('@image / @video tokens left pointing elsewhere (renumbering off)', () => {
  const assets = [asset('elara', ['e1', 'e2']), asset('kai', ['k1'])]
  const proj = (scenes: Scene[], list: Asset[] = assets): Project => ({
    id: 'p', name: 'P', schemaVersion: 2, createdAt: 0, updatedAt: 0, presets: [], settings: { autoRenumber: false }, assets: list, scenes,
  })
  const withRefs = (s: Scene, refs: string[], videoRefs = s.videoRefs): Scene => ({ ...s, refs, videoRefs })

  it('a reorder or removal of refs with the prompt left as written', () => {
    const s1 = scene('s1', '@image_1 hugs @image_3', ['elara', 'kai'])
    const before = proj([s1])
    expect(scenesWithStaleTokens(before, proj([withRefs(s1, ['kai', 'elara'])]))).toEqual(['s1'])
    expect(scenesWithStaleTokens(before, proj([withRefs(s1, ['elara'])]))).toEqual(['s1']) // @image_3 now points at nothing
    // only tokens before the change point stay valid
    const s2 = scene('s2', '@image_1 waves', ['elara', 'kai'])
    expect(scenesWithStaleTokens(proj([s2]), proj([withRefs(s2, ['elara'])]))).toEqual([])
  })
  it('asset image changes, video refs; renumbered prompts and untouched scenes are not listed', () => {
    const s1 = scene('s1', '@image_2 then @video_1', ['elara'])
    const swapped = [asset('elara', ['e2', 'e1']), assets[1]]
    expect(scenesWithStaleTokens(proj([s1]), proj([s1], swapped))).toEqual(['s1'])
    const v = { ...s1, prompt: '@video_1 then @video_2', videoRefs: ['t1', 't2'] }
    expect(scenesWithStaleTokens(proj([v]), proj([withRefs(v, v.refs, ['t2'])]))).toEqual(['s1'])
    expect(scenesWithStaleTokens(proj([v]), proj([{ ...withRefs(v, v.refs, ['t2']), prompt: 'video S01·T1 then @video_1' }]))).toEqual([])
    expect(scenesWithStaleTokens(proj([v]), proj([v]))).toEqual([])
  })
  it('names the scenes in order, at most four', () => {
    const scenes = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ ...scene(id, '', []), order: 5 - i }))
    expect(staleTokenNote(proj(scenes), ['a', 'e'])).toBe(' · tự đánh lại số đang tắt — hãy sửa số @image trong S01, S05')
    expect(staleTokenNote(proj(scenes), ['a', 'b', 'c', 'd', 'e'], '@video')).toContain('@video trong S01, S02, S03, S04… (5 cảnh)')
  })
})

describe('presets applied to scenes', () => {
  const preset = (patch: Partial<Preset> = {}): Preset => ({ id: 'final', name: 'Final', ...settings(), ...patch })
  it('a scene keeps its preset only while its settings still equal it', () => {
    const s = settings({ duration: 15, resolution: '1080p' })
    expect(presetMatches(preset(), s)).toBe(true)
    expect(appliedPresetId('final', s, [preset()])).toBe('final')
    // the preset was edited to 720p afterwards: the scene is "Tuỳ chỉnh"
    expect(appliedPresetId('final', s, [preset({ resolution: '720p' })])).toBeNull()
    // a rename keeps the link; a deleted preset or none → null
    expect(appliedPresetId('final', s, [preset({ name: 'Bản cuối' })])).toBe('final')
    expect(appliedPresetId('final', s, [])).toBeNull()
    expect(appliedPresetId(null, s, [preset()])).toBeNull()
  })
})

describe('labels for imported / older data', () => {
  it('mode label promises images only where they are sent', () => {
    expect(modeLabel('t2v', 'seedance_2_5')).toBe('Text → Video (+ảnh)')
    expect(modeLabel('t2v', 'minimax_h3')).toBe('Text → Video')
    expect(modeLabel('t2v')).toBe('Text → Video')
    expect(modeLabel('i2v', 'minimax_h3')).toBe('Ảnh → Video')
  })
  it('unknown models and asset kinds fall back instead of crashing the panels', () => {
    expect(modelSpec('veo_3').id).toBe('seedance_2_5')
    expect(modelSpec('minimax_h3').id).toBe('minimax_h3')
    expect(kindMeta('video')).toBe(KIND_META.character)
    expect(kindMeta('prop')).toBe(KIND_META.prop)
  })
})
