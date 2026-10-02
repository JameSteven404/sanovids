import { describe, expect, it } from 'vitest'
import { applyImageMapping, buildImportScenes, summarizeImport } from '../../../core/importPrompts'
import type { Asset } from '../../../core/types'
import { guardImportItems, MAX_IMPORT_IMAGE, unmaskTokens } from '../importGuard'

const item = (text: string, title = '') => ({ title, text })
const elara: Asset = {
  id: 'a',
  kind: 'character',
  name: 'Elara',
  tag: 'Elara',
  description: '',
  imageIds: ['a-img0'],
  color: '#fff',
  position: null,
}

describe('guardImportItems', () => {
  it('leaves normal prompts untouched (same objects)', () => {
    const items = [item('Mara (@image_1) and @image_3, from @video_2')]
    const g = guardImportItems(items)
    expect(g.items[0]).toBe(items[0])
    expect(g.outOfRange).toEqual([])
  })

  it('hides huge @image numbers from the summary so no giant array is built', () => {
    const items = [item('Shot on @image_20241002 with @image_2'), item('@image_99999999999999999999 and @IMAGE_150')]
    const g = guardImportItems(items)
    expect(g.outOfRange).toEqual([150, 20241002, 1e20])
    const summary = summarizeImport(g.items)
    expect(summary.maxImage).toBe(2)
    expect(summary.imageUsage).toEqual([0, 1])
    // Same length: character counts stay right.
    expect(summary.chars).toBe(items.reduce((t, i) => t + [...i.text].length, 0))
  })

  it('keeps the limit itself and @video tokens', () => {
    const g = guardImportItems([item(`@image_${MAX_IMPORT_IMAGE} @video_5000`)])
    expect(g.outOfRange).toEqual([])
    expect(summarizeImport(g.items).maxImage).toBe(MAX_IMPORT_IMAGE)
  })

  it('restores the masked tokens exactly as written after mapping / building', () => {
    const items = [item('@image_1 walks past @Image_5000.')]
    const g = guardImportItems(items)
    const mapped = applyImageMapping(g.items[0].text, ['a'], [elara])
    expect(unmaskTokens(mapped.prompt)).toBe('@image_1 walks past @Image_5000.')
    expect(mapped.pending).toEqual([])
    const [scene] = buildImportScenes(g.items)
    expect(unmaskTokens(scene.prompt)).toBe(items[0].text)
  })

  it('unmaskTokens is a no-op on plain text', () => {
    expect(unmaskTokens('no tokens @image_2')).toBe('no tokens @image_2')
  })
})
