// Reference videos (@video_N) were retired in 0.6.0 ("bỏ video tham chiếu, giữ lại ảnh tham chiếu"). The user's rule:
// the app never removes or rewrites prompt text when a reference goes away — old @video text stays byte for byte, is
// marked, never sent, and blocks the run until the user edits it (or clicks an explicit quick fix). Old links are
// archived inert (Scene.legacyVideoRefs / Take.legacyVideoRefsSnapshot).
import { describe, expect, it } from 'vitest'
import {
  compileScene,
  continueStarterOf,
  hasRetiredVideoToken,
  mediaKeys,
  promptParts,
  remapTokens,
  removeRetiredVideoTokens,
  removeTokenAt,
  retiredTokenList,
  retiredVideoTokens,
  stripContinueStarter,
} from '../compile'
import { dropLegacyVideoRefs, migrateProject, migrateTake } from '../migrate'
import { scenesWithStaleTokens, tokensShifted } from '../staleTokens'
import type { Project, Scene } from '../types'

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1',
  order: 1,
  title: '',
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
    { id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1', 'i2'], color: '#fff', position: null },
    { id: 'b', kind: 'character', name: 'Lumi', tag: 'Lumi', description: '', imageIds: ['i3'], color: '#fff', position: null },
  ],
  scenes,
})

/** Prompts every path must keep byte for byte. */
const OLD_PROMPTS = ['Continue from @video_1: Elara bước ra cửa', '@image_1 cùng @Video 2 và @video_?3(S01·T1)', '@VIDEO3 @video 4 @video_?5', 'không có token']

describe('retiredVideoTokens: one helper for every layer', () => {
  it('finds every spelling the token parser reads, with positions, in order', () => {
    const text = 'a @video_1 b @Video 2 c @VIDEO3 d @video_?4 e @video_?5(S01·T1) f'
    expect(retiredVideoTokens(text)).toEqual([
      { text: '@video_1', start: 2, end: 10 },
      { text: '@Video 2', start: 13, end: 21 },
      { text: '@VIDEO3', start: 24, end: 31 },
      { text: '@video_?4', start: 34, end: 43 },
      { text: '@video_?5(S01·T1)', start: 46, end: 63 },
    ])
    for (const t of retiredVideoTokens(text)) expect(text.slice(t.start, t.end)).toBe(t.text)
  })
  it('the token boundary is the parser’s (ASCII \\b): plain words stay plain', () => {
    expect(retiredVideoTokens('@video2go @video1abc @videos @video_ @video')).toEqual([])
    expect(retiredVideoTokens('@video_1ạ').map((t) => t.text)).toEqual(['@video_1']) // \b before a non-ASCII letter
    expect(retiredVideoTokens('email@video_1.com').map((t) => t.text)).toEqual(['@video_1'])
    // a waiting placeholder has no boundary (UNBOUND_RE): "@video_?2go" waits too
    expect(retiredVideoTokens('@video_?2go').map((t) => t.text)).toEqual(['@video_?2'])
    // a label is at most 60 characters, one line, no nested parentheses
    expect(retiredVideoTokens(`@video_?2(${'x'.repeat(61)})`).map((t) => t.text)).toEqual(['@video_?2'])
    expect(retiredVideoTokens('@video_?2(a\nb)').map((t) => t.text)).toEqual(['@video_?2'])
  })
  it('hasRetiredVideoToken agrees with it', () => {
    for (const s of [...OLD_PROMPTS, '@video2go', '@video_?7', 'x @VIDEO 1', '', '@image_1']) expect(hasRetiredVideoToken(s)).toBe(retiredVideoTokens(s).length > 0)
  })
  it('lists 3 tokens then "…"', () => {
    expect(retiredTokenList(['@video_1'])).toBe('@video_1')
    expect(retiredTokenList(['@video_1', '@video_2', '@video_3', '@video_4'])).toBe('@video_1, @video_2, @video_3…')
  })
  it('promptParts marks images and exactly the retired spans, and gives the text back', () => {
    const text = '@image_1 @video_?2(S01·T1) @Image 3 @video2go @Video 4.'
    const parts = promptParts(text)
    expect(parts.map((p) => p.text).join('')).toBe(text)
    expect(parts.filter((p) => p.kind === 'retired').map((p) => p.text)).toEqual(retiredVideoTokens(text).map((t) => t.text))
    expect(parts.filter((p) => p.kind === 'image').map((p) => p.text)).toEqual(['@image_1', '@Image 3'])
  })
})

describe('quick fixes (only on the user’s click)', () => {
  it('removeTokenAt removes exactly the token (label included) and one doubled space, nothing else', () => {
    const text = 'Elara @video_?2(S01·T1) đi, rồi @video_1.'
    const [first, second] = retiredVideoTokens(text)
    expect(removeTokenAt(text, first.start, first.end)).toBe('Elara đi, rồi @video_1.')
    expect(removeTokenAt(text, second.start, second.end)).toBe('Elara @video_?2(S01·T1) đi, rồi .')
    expect(removeTokenAt('@video_1 mở đầu', 0, 8)).toBe('mở đầu')
    expect(removeTokenAt('cuối @video_1', 5, 13)).toBe('cuối ')
    expect(removeTokenAt('a\n@video_1 b', 2, 10)).toBe('a\n b') // only a space right after another space (or the start) goes
  })
  it('removeRetiredVideoTokens removes every token from the last one back', () => {
    expect(removeRetiredVideoTokens('@video_1 và @Video 2 cùng @image_1 @video_?3(S01·T1)')).toBe('và cùng @image_1 ')
    expect(removeRetiredVideoTokens('không có gì')).toBe('không có gì')
  })
  it('stripContinueStarter only removes the exact starter older builds wrote', () => {
    expect(continueStarterOf('Continue from @video_1: trời mưa')).toBe('Continue from @video_1:')
    expect(stripContinueStarter('Continue from @video_1: trời mưa')).toBe('trời mưa')
    expect(stripContinueStarter('Continue from @video_12: x')).toBe('x')
    for (const off of ['continue from @video_1: x', ' Continue from @video_1: x', 'Continue from @video_1:x', 'Continue from @Video_1: x', 'Continue  from @video_1: x', 'x Continue from @video_1: y']) {
      expect(stripContinueStarter(off)).toBe(off)
      expect(continueStarterOf(off)).toBeNull()
    }
  })
})

describe('compileScene and renumbering never touch @video text', () => {
  it('retired tokens are in retiredTokens and unsentTokens with one warning; an image-only scene is unaffected', () => {
    const s = scene({ prompt: '@image_1 gặp @video_1 rồi @video_?2(S01·T1) và @video_1', refs: ['a'], legacyVideoRefs: ['t1'] })
    const out = compileScene(project([s]), s)
    expect(out.text).toBe(s.prompt)
    expect(out.retiredTokens).toEqual(['@video_1', '@video_?2(S01·T1)'])
    expect(out.unsentTokens).toEqual(['@video_1', '@video_?2(S01·T1)'])
    expect(out.warnings.filter((w) => w.includes('đã bỏ video tham chiếu'))).toHaveLength(1)
    expect(out.images.map((i) => i.assetId)).toEqual(['a', 'a'])
    const plain = scene({ prompt: '@image_1 gặp @image_3', refs: ['a', 'b'], legacyVideoRefs: ['t1'] })
    expect(compileScene(project([plain]), plain)).toMatchObject({ retiredTokens: [], unsentTokens: [], warnings: [] })
  })
  it('remapTokens: reordering / removing images renumbers only @image', () => {
    const p = project([])
    const before = mediaKeys(p.assets, ['a', 'b'])
    for (const prompt of OLD_PROMPTS) {
      const out = remapTokens(prompt, before, mediaKeys(p.assets, ['b']), () => 'Elara').text
      expect(retiredVideoTokens(out).map((t) => t.text)).toEqual(retiredVideoTokens(prompt).map((t) => t.text))
    }
    expect(remapTokens('@video_1 @image_3 @video_2', before, mediaKeys(p.assets, ['b', 'a']), () => '?').text).toBe('@video_1 @image_1 @video_2')
  })
  it('stale-token warnings (renumbering off) never count @video text', () => {
    expect(tokensShifted('@video_1 @video_2', { images: [] }, { images: [] })).toBe(false)
    const s = scene({ prompt: '@video_1', refs: ['a'], legacyVideoRefs: ['t1'] })
    const before = { ...project([s]), settings: { autoRenumber: false } }
    expect(scenesWithStaleTokens(before, { ...before, scenes: [{ ...s, refs: [] }] })).toEqual([])
  })
})

describe('migrate: old links archived inert, prompts byte for byte, schema 2', () => {
  const raw = (scenes: object[]) => ({ schemaVersion: 2, name: 'Cũ', assets: [], scenes })
  it('moves videoRefs to legacyVideoRefs (never kept under the old name, not even through unknown keys)', () => {
    const p = migrateProject(raw(OLD_PROMPTS.map((prompt, i) => ({ id: 's' + i, order: i + 1, prompt, refs: [], videoRefs: i % 2 ? [] : ['t1', 't2', 't1'], extra: 'kept' }))))
    expect(p.schemaVersion).toBe(2)
    expect(p.scenes.map((s) => s.prompt)).toEqual(OLD_PROMPTS)
    expect(p.scenes.map((s) => s.videoRefs)).toEqual([[], [], [], []])
    expect(p.scenes.map((s) => s.legacyVideoRefs)).toEqual([['t1', 't2'], undefined, ['t1', 't2'], undefined])
    expect('legacyVideoRefs' in p.scenes[1]).toBe(false) // nothing archived: no key (older files stay the same)
    expect((p.scenes[0] as Scene & { extra?: string }).extra).toBe('kept')
  })
  it('is idempotent; a 0.5.0 build that added links again (videoRefs + legacyVideoRefs) gets both archived', () => {
    const once = migrateProject(raw([{ id: 's', prompt: OLD_PROMPTS[0], videoRefs: ['t1'] }]))
    expect(migrateProject(JSON.parse(JSON.stringify(once)))).toEqual(once)
    const touched = JSON.parse(JSON.stringify(once))
    touched.scenes[0].videoRefs = ['t9', 't1']
    const again = migrateProject(touched)
    expect(again.scenes[0]).toMatchObject({ videoRefs: [], legacyVideoRefs: ['t1', 't9'], prompt: OLD_PROMPTS[0] })
  })
  it('a file without any video data comes out exactly as before (no legacy key anywhere)', () => {
    const p = migrateProject(raw([{ id: 's', prompt: '@image_1' }]))
    expect(JSON.stringify(p)).not.toContain('legacyVideo')
    expect(p.scenes[0].videoRefs).toEqual([])
  })
  it('migrateTake archives videoRefsSnapshot, idempotently', () => {
    const t = migrateTake({ id: 't', sceneId: 's', number: 1, status: 'completed', promptSnapshot: 'Continue from @video_1: x', videoRefsSnapshot: ['a', 'b'] })
    expect(t).toMatchObject({ videoRefsSnapshot: [], legacyVideoRefsSnapshot: ['a', 'b'], promptSnapshot: 'Continue from @video_1: x' })
    expect(migrateTake(JSON.parse(JSON.stringify(t)))).toEqual(t)
    expect('legacyVideoRefsSnapshot' in migrateTake({ id: 'u', sceneId: 's', number: 2, status: 'completed' })).toBe(false)
  })
  it('a copy / an import drops the archive (the takes do not travel) but never the text', () => {
    const p = migrateProject(raw([{ id: 's', prompt: OLD_PROMPTS[1], videoRefs: ['t1'] }]))
    const copy = dropLegacyVideoRefs(p)
    expect(copy.scenes[0]).not.toHaveProperty('legacyVideoRefs')
    expect(copy.scenes[0].prompt).toBe(OLD_PROMPTS[1])
  })
})
