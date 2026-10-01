import { describe, expect, it } from 'vitest'
import { compileScene } from '../../../core/compile'
import type { Asset, Project, Scene } from '../../../core/types'
import { findMention, fold, insertion, rankAssets } from '../mentions'
import { splitCompiled } from '../promptParts'
import { patchFits, patchLabel } from '../SettingsFields'

const asset = (id: string, name: string, tag: string, over: Partial<Asset> = {}): Asset => ({
  id, kind: 'character', name, tag, description: '', imageIds: ['img_' + id], color: '#fff', position: null, ...over,
})
const ASSETS = [asset('a', 'Elara', 'Elara'), asset('b', 'Bé An', 'BeAn'), asset('c', 'Làng núi', 'LangNui', { kind: 'location' }), asset('d', 'Aurelian', 'Aurelian')]

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1', order: 1, title: 'Test', prompt: '', refs: [], blockOverrides: {}, presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  continueFrom: null, firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: 0 }, note: '', ...over,
})
const project = (scenes: Scene[], over: Partial<Project> = {}): Project => ({
  id: 'p', name: 'P', schemaVersion: 1, createdAt: 0, updatedAt: 0, presets: [],
  settings: { referencesTemplate: 'Refs: {list}.', autoReferences: true, autoContinuity: true },
  assets: ASSETS,
  blocks: [
    { id: 'b1', title: 'Style', text: 'STYLE @Elara\n\nsecond para', placement: 'before', defaultOn: true, color: '#111' },
    { id: 'b2', title: 'Audio', text: 'AUDIO', placement: 'after', defaultOn: true, color: '#222' },
    { id: 'b3', title: 'Off', text: 'OFF', placement: 'after', defaultOn: false, color: '#333' },
  ],
  scenes,
  ...over,
})

describe('findMention', () => {
  it('finds the token being typed at the caret', () => {
    const t = 'At dusk @Ela climbs'
    expect(findMention(t, 12)).toEqual({ start: 8, end: 12, query: 'Ela' })
    // caret in the middle of the word: token extends to the end of the word
    expect(findMention(t, 10)).toEqual({ start: 8, end: 12, query: 'E' })
    expect(findMention('@', 1)).toEqual({ start: 0, end: 1, query: '' })
  })
  it('handles vietnamese letters', () => {
    expect(findMention('gặp @Làng', 9)?.query).toBe('Làng')
  })
  it('ignores e-mails, finished tokens and raw image tokens', () => {
    expect(findMention('mail me a@b', 11)).toBeNull()
    expect(findMention('@Elara walks', 12)).toBeNull()
    expect(findMention('use @image_3', 12)).toBeNull()
    expect(findMention('no mention here', 5)).toBeNull()
  })
})

describe('insertion', () => {
  it('replaces the partial token and adds a trailing space', () => {
    const text = 'At dusk @Ela climbs'
    const tok = findMention(text, 12)!
    const r = insertion(text, tok, 'Elara')
    expect(r.next).toBe('At dusk @Elara climbs')
    expect(r.insert).toBe('@Elara')
    expect(r.caret).toBe('At dusk @Elara '.length)
  })
  it('adds a space at the end of text, none before punctuation', () => {
    const a = insertion('Hi @El', findMention('Hi @El', 6)!, 'Elara')
    expect(a.next).toBe('Hi @Elara ')
    expect(a.caret).toBe(a.next.length)
    const b = insertion('Hi @El.', findMention('Hi @El.', 6)!, 'Elara')
    expect(b.next).toBe('Hi @Elara.')
    expect(b.caret).toBe('Hi @Elara'.length)
  })
})

describe('rankAssets', () => {
  it('prefers tag prefix, then name prefix, diacritics-insensitive', () => {
    expect(rankAssets(ASSETS, 'el', []).map((a) => a.id)).toEqual(['a', 'd'])
    expect(rankAssets(ASSETS, 'lang', []).map((a) => a.id)).toEqual(['c'])
    expect(rankAssets(ASSETS, 'nui', []).map((a) => a.id)).toEqual(['c'])
    expect(rankAssets(ASSETS, 'be', []).map((a) => a.id)).toEqual(['b'])
  })
  it('lists linked refs first for an empty query', () => {
    expect(rankAssets(ASSETS, '', ['d', 'c']).map((a) => a.id)).toEqual(['d', 'c', 'a', 'b'])
  })
  it('folds', () => {
    expect(fold('Đường Làng')).toBe('duong lang')
  })
})

describe('splitCompiled', () => {
  it('labels blocks, continuity, body, references and keeps the exact text', () => {
    const prev = scene({ id: 's0', order: 1, title: 'Before', prompt: 'x' })
    const s = scene({ id: 's1', order: 2, prompt: '@BeAn hugs @Elara\n\nin @LangNui', refs: ['b', 'a', 'c'], continueFrom: 's0' })
    const p = project([prev, s])
    const c = compileScene(p, s)
    const parts = splitCompiled(p, s, c)
    expect(parts.map((x) => x.kind)).toEqual(['block', 'continuity', 'body', 'refs', 'block'])
    expect(parts.map((x) => x.text).join('\n\n')).toBe(c.text)
    expect(parts[2].text).toBe('@image_1 hugs @image_2\n\nin @image_3')
    expect(parts[3].text.startsWith('Refs: ')).toBe(true)
  })
  it('works without references and with only after-blocks', () => {
    const s = scene({ prompt: 'plain', blockOverrides: { b1: false, b3: true } })
    const p = project([s])
    const c = compileScene(p, s)
    const parts = splitCompiled(p, s, c)
    expect(parts.map((x) => x.kind)).toEqual(['body', 'block', 'block'])
    expect(parts.map((x) => x.text).join('\n\n')).toBe(c.text)
  })
  it('handles an empty prompt', () => {
    const s = scene({ prompt: '   ' })
    const p = project([s], { blocks: [] })
    const c = compileScene(p, s)
    expect(splitCompiled(p, s, c)).toEqual([])
  })
})

describe('patchFits (batch settings on scenes with different models)', () => {
  it('accepts only values the scene model offers', () => {
    expect(patchFits('seedance_2_5', { resolution: '480p' })).toBe(true)
    expect(patchFits('seedance_2_5', { resolution: '768p' })).toBe(false)
    expect(patchFits('minimax_h3', { resolution: '480p' })).toBe(false)
    expect(patchFits('minimax_h3', { duration: 30 })).toBe(false)
    expect(patchFits('minimax_h3', { duration: 15, ratio: '9:16' })).toBe(true)
    expect(patchFits('seedance_2_5', { mode: 'i2v' })).toBe(false)
  })
  it('lets a model switch through (normalized for the new model)', () => {
    expect(patchFits('seedance_2_5', { model: 'minimax_h3' })).toBe(true)
  })
  it('labels the value', () => {
    expect(patchLabel({ resolution: '2k' })).toBe('2K')
    expect(patchLabel({ duration: 30 })).toBe('30s')
  })
})
