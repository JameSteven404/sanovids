import { describe, expect, it } from 'vitest'
import { compileScene, extractMentions, slugTag, uniqueTag } from '../compile'
import type { Project, Scene } from '../types'

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1', order: 1, title: 'Test', prompt: '', refs: [], blockOverrides: {}, presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  continueFrom: null, firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: 0 }, note: '', ...over,
})
const project = (scenes: Scene[]): Project => ({
  id: 'p', name: 'P', schemaVersion: 1, createdAt: 0, updatedAt: 0, presets: [],
  settings: { referencesTemplate: 'Refs: {list}.', autoReferences: true, autoContinuity: true },
  assets: [
    { id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: 'red hair', imageIds: ['i1', 'i2'], color: '#fff', position: null },
    { id: 'b', kind: 'character', name: 'Bé An', tag: 'BeAn', description: '', imageIds: ['i3'], color: '#fff', position: null },
    { id: 'c', kind: 'location', name: 'Cave', tag: 'Cave', description: '', imageIds: ['i4'], color: '#fff', position: null },
  ],
  blocks: [
    { id: 'b1', title: 'Style', text: 'STYLE @Elara', placement: 'before', defaultOn: true, color: '#fff' },
    { id: 'b2', title: 'Audio', text: 'AUDIO', placement: 'after', defaultOn: true, color: '#fff' },
    { id: 'b3', title: 'Off', text: 'OFF', placement: 'after', defaultOn: false, color: '#fff' },
  ],
  scenes,
})

describe('compileScene', () => {
  it('numbers images in ref order and replaces mentions', () => {
    const s = scene({ prompt: '@BeAn hugs @Elara in @Cave', refs: ['b', 'a'] })
    const out = compileScene(project([s]), s)
    expect(out.images.map((i) => [i.n, i.assetId])).toEqual([[1, 'b'], [2, 'a'], [3, 'a']])
    expect(out.text).toBe('STYLE @image_2\n\n@image_1 hugs @image_2 in Cave\n\nRefs: @image_1 = Bé An; @image_2, @image_3 = Elara (red hair).\n\nAUDIO')
    expect(out.warnings.some((w) => w.includes('@Cave'))).toBe(true)
  })
  it('respects block overrides and continuity line', () => {
    const prev = scene({ id: 's0', order: 1, title: 'Before', prompt: 'x' })
    const s = scene({ id: 's1', order: 2, prompt: 'go', continueFrom: 's0', blockOverrides: { b1: false, b3: true } })
    const out = compileScene(project([prev, s]), s)
    expect(out.text).toBe('Continue directly from the previous scene (S01: Before).\n\ngo\n\nAUDIO\n\nOFF')
  })
  it('h3 t2v sends no images and uses names', () => {
    const s = scene({ prompt: '@Elara walks', refs: ['a'], settings: { model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '768p', ratio: '16:9' } })
    const out = compileScene(project([s]), s)
    expect(out.images).toHaveLength(0)
    expect(out.text).toContain('Elara walks')
    expect(out.limit).toBe(7000)
  })
  it('leaves raw @image_N tokens alone', () => {
    const s = scene({ prompt: 'use @image_3 here' })
    expect(compileScene(project([s]), s).text).toContain('@image_3')
  })
  it('skips the auto continuity line when an active block already covers it', () => {
    const prev = scene({ id: 's0', order: 1, prompt: 'x' })
    const s = scene({ id: 's1', order: 2, prompt: 'go', continueFrom: 's0', blockOverrides: { b1: false } })
    const p = project([prev, s])
    p.blocks.push({ id: 'b4', title: 'Cont', text: 'This continues from the previous scene.', placement: 'before', defaultOn: true, color: '#fff' })
    expect(compileScene(p, s).text).toBe('This continues from the previous scene.\n\ngo\n\nAUDIO')
    // A switched-off block does not count.
    const off = { ...s, blockOverrides: { b1: false, b4: false } }
    expect(compileScene(p, off).text).toBe('Continue directly from the previous scene (S01: Test).\n\ngo\n\nAUDIO')
  })
  it('does not call a linked asset without images "not linked"', () => {
    const s = scene({ prompt: '@Foo waves', refs: ['f'] })
    const p = project([s])
    p.assets.push({ id: 'f', kind: 'character', name: 'Foo', tag: 'Foo', description: '', imageIds: [], color: '#fff', position: null })
    const out = compileScene(p, s)
    expect(out.warnings.some((w) => w.includes('chưa có ảnh'))).toBe(true)
    expect(out.warnings.some((w) => w.includes('@Foo có trong prompt nhưng chưa được nối'))).toBe(false)
    const unlinked = { ...s, refs: [] }
    expect(compileScene(p, unlinked).warnings.some((w) => w.includes('@Foo có trong prompt nhưng chưa được nối'))).toBe(true)
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
