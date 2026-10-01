import { describe, expect, it } from 'vitest'
import {
  analyzePrompts,
  applyImport,
  imageTokens,
  normalizeKey,
  parsePromptText,
  SAMPLE_IMPORT_TEXT,
  splitParagraphs,
  splitPrompts,
  suggestTitle,
  type SelectedCandidate,
} from '../importPrompts'

const STYLE = 'Moody live-action drama, natural light, handheld camera, soft cuts between shots.'
const AUDIO = 'Audio: ambient sound only. No music, no narration, no subtitles.'
const RULES = 'Constraints, repeated: no logos, no on-screen text, no extra people in frame.'
const prompt = (...paras: string[]) => paras.join('\n\n')

describe('splitPrompts', () => {
  it('splits on ---, === and *** lines (3+ chars) and drops empty chunks', () => {
    const text = 'one\n---\ntwo\n\n=====\n\nthree\r\n***\r\nfour\n------\n\n---\n'
    expect(splitPrompts(text)).toEqual(['one', 'two', 'three', 'four'])
  })
  it('keeps short dashes and inline separators as content', () => {
    expect(splitPrompts('a -- b\nline --- inside\n**bold**')).toEqual(['a -- b\nline --- inside\n**bold**'])
  })
  it('reads titles from "=== S01: Title ===" headers', () => {
    const items = parsePromptText('=== S01: Dawn ===\nfirst\n\n=== S02 · Night ===\nsecond\n=== S03 ===\nthird')
    expect(items).toEqual([
      { title: 'Dawn', text: 'first' },
      { title: 'Night', text: 'second' },
      { title: '', text: 'third' },
    ])
  })
})

describe('splitParagraphs / normalizeKey', () => {
  it('splits on blank lines (including whitespace-only lines) and trims', () => {
    expect(splitParagraphs('  a\nb  \n \t\n\n c \n\nd')).toEqual(['a\nb', 'c', 'd'])
  })
  it('normalizes case and whitespace', () => {
    expect(normalizeKey('  Audio:\n  Ambient   ONLY ')).toBe('audio: ambient only')
  })
})

describe('suggestTitle', () => {
  it('uses the leading label', () => {
    expect(suggestTitle(AUDIO)).toBe('Audio')
    expect(suggestTitle(RULES)).toBe('Constraints')
    expect(suggestTitle('**Âm thanh:** chỉ tiếng gió')).toBe('Âm thanh')
  })
  it('falls back to the first words of the first clause', () => {
    expect(suggestTitle(STYLE)).toBe('Moody live-action drama')
    expect(suggestTitle('a very long opening sentence without any label or comma at all')).toBe('A very long opening sentence…')
  })
})

describe('analyzePrompts', () => {
  const prompts = [
    prompt(STYLE, 'Scene one action.', AUDIO, RULES),
    prompt(STYLE, 'Scene two action.', AUDIO, RULES),
    prompt(STYLE, 'Scene three action.', AUDIO),
    prompt('Scene four action, no boilerplate at all.'),
  ]

  it('suggests paragraphs repeated in >= max(2, 30%) prompts, ordered by position', () => {
    const a = analyzePrompts(prompts)
    expect(a.threshold).toBe(2)
    expect(a.paragraphs[0]).toHaveLength(4)
    expect(a.candidates.map((c) => [c.title, c.count, c.placement])).toEqual([
      ['Moody live-action drama', 3, 'before'],
      ['Audio', 3, 'after'],
      ['Constraints', 2, 'after'],
    ])
    expect(a.candidates[0].prompts).toEqual([0, 1, 2])
    expect(a.candidates[0].avgPosition).toBe(0)
  })

  it('ignores paragraphs below the threshold', () => {
    const many = Array.from({ length: 10 }, (_, i) => prompt(`Unique scene ${i} with plenty of words.`, i < 3 ? RULES : 'Other closing line here.'))
    const a = analyzePrompts(many)
    expect(a.threshold).toBe(3)
    // Same position → the more frequent one first.
    expect(a.candidates.map((c) => [c.title, c.count])).toEqual([
      ['Other closing line here', 7],
      ['Constraints', 3],
    ])
    const few = Array.from({ length: 10 }, (_, i) => prompt(`Unique scene ${i} with plenty of words.`, i < 2 ? RULES : `Closing ${i}.`))
    expect(analyzePrompts(few).candidates).toEqual([])
  })

  it('groups near-duplicates sharing the first 48 normalized chars and picks the most frequent variant', () => {
    const variant = RULES + ' Keep the lantern lit.'
    const a = analyzePrompts([prompt('A1 scene text.', RULES), prompt('A2 scene text.', variant), prompt('A3 scene text.', RULES)])
    expect(a.candidates).toHaveLength(1)
    const c = a.candidates[0]
    expect(c.count).toBe(3)
    expect(c.text).toBe(RULES)
    expect(c.variants.map((v) => v.count)).toEqual([2, 1])
    expect(c.variants[1].text).toBe(variant)
  })

  it('does not suggest a group whose text is never repeated verbatim', () => {
    const opener = 'Live-action fantasy drama scene, naturalistic footage with editing: '
    const a = analyzePrompts([opener + 'she runs.', opener + 'he waits.', opener + 'they talk.'])
    expect(a.candidates).toHaveLength(0)
  })
})

describe('applyImport', () => {
  const variant = RULES + ' Keep the lantern lit.'
  const prompts = [
    prompt(STYLE, 'Scene one with @image_1.', AUDIO, RULES),
    prompt(STYLE, 'Scene two.', AUDIO, variant),
    prompt(STYLE, 'Scene three.', RULES),
  ]
  const all = (): SelectedCandidate[] => analyzePrompts(prompts).candidates

  it('creates blocks and strips exact matches from the scene prompts', () => {
    const res = applyImport(prompts, all(), { titles: ['One', 'Two'] })
    expect(res.blocks.map((b) => [b.title, b.placement, b.defaultOn])).toEqual([
      ['Moody live-action drama', 'before', true],
      ['Audio', 'after', true],
      ['Constraints', 'after', true],
    ])
    expect(res.blocks[0].text).toBe(STYLE)
    expect(res.scenes.map((s) => s.title)).toEqual(['One', 'Two', ''])
    expect(res.scenes[0].prompt).toBe('Scene one with @image_1.')
    expect(res.scenes[0].blockOverrides).toEqual({})
  })

  it('keeps a different variant inline and turns the block off for that scene', () => {
    const res = applyImport(prompts, all())
    const rules = res.blocks.find((b) => b.title === 'Constraints')!
    const audio = res.blocks.find((b) => b.title === 'Audio')!
    expect(res.scenes[1].prompt).toBe(prompt('Scene two.', variant))
    expect(res.scenes[1].blockOverrides).toEqual({ [rules.id]: false })
    // Scene three never had the audio paragraph.
    expect(res.scenes[2].blockOverrides).toEqual({ [audio.id]: false })
  })

  it('merges variants into the block when asked', () => {
    const cands = all().map((c) => ({ ...c, mergeVariants: true }))
    const res = applyImport(prompts, cands)
    expect(res.scenes[1].prompt).toBe('Scene two.')
    expect(res.scenes[1].blockOverrides).toEqual({})
  })

  it('uses the majority for defaultOn and edited titles / placement', () => {
    const cands = all()
    const rules = { ...cands[2], title: 'Ràng buộc', placement: 'before' as const }
    const ps = [prompt('x scene.', RULES), prompt('y scene.', RULES), prompt('z scene.'), prompt('w scene.'), prompt('v scene.')]
    const res = applyImport(ps, [rules])
    expect(res.blocks[0]).toMatchObject({ title: 'Ràng buộc', placement: 'before', defaultOn: false })
    expect(res.scenes.map((s) => s.blockOverrides[res.blocks[0].id])).toEqual([true, true, undefined, undefined, undefined])
  })

  it('reports stats and keeps @image_N tokens', () => {
    const res = applyImport(prompts, all())
    expect(res.stats.prompts).toBe(3)
    expect(res.stats.imageTokenPrompts).toBe(1)
    expect(res.stats.charsAfter).toBeLessThan(res.stats.charsBefore)
    expect(res.stats.savedPerScene).toBe(Math.round((res.stats.charsBefore - res.stats.charsAfter) / 3))
    expect(imageTokens(res.scenes[0].prompt)).toEqual(['@image_1'])
  })

  it('with nothing selected keeps prompts intact', () => {
    const res = applyImport(prompts, [])
    expect(res.blocks).toEqual([])
    expect(res.scenes.map((s) => s.prompt)).toEqual(prompts)
    expect(res.stats.savedPerScene).toBe(0)
  })
})

describe('sample prompts', () => {
  it('detects the style header, audio rules and constraints (with one variant)', () => {
    const items = parsePromptText(SAMPLE_IMPORT_TEXT)
    expect(items).toHaveLength(3)
    expect(items.every((i) => i.title.length > 0)).toBe(true)
    const a = analyzePrompts(items.map((i) => i.text))
    expect(a.candidates.map((c) => [c.title, c.count, c.placement, c.variants.length])).toEqual([
      ['Cinematic live-action short film', 3, 'before', 1],
      ['Audio', 3, 'after', 1],
      ['Constraints', 3, 'after', 2],
    ])
  })
})
