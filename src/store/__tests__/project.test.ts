import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelPick } from '../../components/inspector/SettingsFields'
import { migrateProject } from '../../core/migrate'
import { sceneRunBlockReason } from '../../core/runRules'
import type { Preset, Project, Scene, Take, VideoSettings } from '../../core/types'
import {
  LAYOUT,
  onHistoryJump,
  presetSettings,
  redo,
  ROW_H,
  rowHeightOf,
  scenePosition,
  setTakeHeightSource,
  undo,
  undoToastAction,
  useProject,
  type HistoryJumpKind,
} from '../project'

const scene = (i: number, over: Partial<Scene> = {}): Scene => ({
  id: 's' + (i + 1),
  order: i + 1,
  title: '',
  prompt: '',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: scenePosition(i),
  note: '',
  ...over,
})

const project = (n = 6): Project => ({
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
    { id: 'c', kind: 'location', name: 'Cave', tag: 'Cave', description: '', imageIds: ['i4'], color: '#fff', position: null },
  ],
  scenes: Array.from({ length: n }, (_, i) => scene(i)),
})

const st = () => useProject.getState()
const history = () => useProject.temporal.getState()
const sc = (id: string) => st().project.scenes.find((s) => s.id === id)!

function overlapping(scenes: Scene[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < scenes.length; i++)
    for (let j = i + 1; j < scenes.length; j++) {
      const a = scenes[i].position
      const b = scenes[j].position
      if (Math.abs(a.x - b.x) < LAYOUT.sceneW && Math.abs(a.y - b.y) < LAYOUT.sceneH) out.push([scenes[i].id, scenes[j].id])
    }
  return out
}

/** Overlap of whole rows (resized card or tall take included), like the store's layout. */
function rowsOverlap(scenes: Scene[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < scenes.length; i++)
    for (let j = i + 1; j < scenes.length; j++) {
      const [a, b] = [scenes[i], scenes[j]]
      const x = Math.abs(a.position.x - b.position.x) < LAYOUT.sceneW
      const y = a.position.y < b.position.y + rowHeightOf(b) && b.position.y < a.position.y + rowHeightOf(a)
      if (x && y) out.push([a.id, b.id])
    }
  return out
}

beforeEach(() => {
  setTakeHeightSource(() => 0)
  st().loadProject(project())
  history().clear()
})

describe('placing new scenes', () => {
  it('next scene goes below its source and pushes the following rows down', () => {
    const id = st().createNextScene('s2')
    const created = sc(id)
    // a row without takes is as tall as its card (ROW_H also counts a take: only seed / migrate positions use it)
    expect(created.position).toEqual({ x: LAYOUT.scenesX, y: scenePosition(1).y + LAYOUT.sceneH + LAYOUT.gapY })
    expect(ROW_H).toBeGreaterThanOrEqual(LAYOUT.sceneH + LAYOUT.gapY)
    expect(created.order).toBe(3)
    expect(overlapping(st().project.scenes)).toEqual([])
    expect(sc('s3').position.y).toBeGreaterThan(created.position.y)
  })
  it('next scene inherits refs and settings with an empty prompt; overrides (refs / settings / preset) win', () => {
    st().addRefs(['s1'], ['a'])
    st().updateScene('s1', { prompt: 'x' })
    const id = st().createNextScene('s1')
    expect(sc(id).refs).toEqual(['a'])
    expect(sc(id).videoRefs).toEqual([])
    expect(sc(id).prompt).toBe('')
    const H3 = { model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' } as const
    const other = st().createNextScene('s1', undefined, { refs: ['b', 'gone', 'c'], settings: H3, presetId: null })
    expect(sc(other).refs).toEqual(['b', 'c']) // unknown asset ids are dropped
    expect(sc(other).settings).toEqual(H3)
    expect(sc(other).presetId).toBeNull()
  })
  it('add scene after a deletion does not land on an existing card', () => {
    st().removeScenes(['s2'])
    st().addScene()
    expect(overlapping(st().project.scenes)).toEqual([])
  })
  it('next scene goes below a resized (taller) source card and pushes the rows below far enough', () => {
    st().setNodeSizes({ s2: { w: 300, h: 600 } })
    const id = st().createNextScene('s2')
    expect(sc(id).position.y).toBe(scenePosition(1).y + 600 + LAYOUT.gapY)
    expect(rowsOverlap(st().project.scenes).filter((pair) => pair.includes(id))).toEqual([])
  })
  it('a tall take makes its row taller (next scene, auto layout)', () => {
    setTakeHeightSource((sceneId) => (sceneId === 's2' ? 560 : 0))
    const id = st().createNextScene('s2')
    expect(sc(id).position.y).toBe(scenePosition(1).y + 560 + LAYOUT.gapY)
    expect(rowsOverlap(st().project.scenes).filter((pair) => pair.includes(id))).toEqual([])
    st().autoLayout()
    expect(sc(id).position.y - sc('s2').position.y).toBe(560 + LAYOUT.gapY)
    expect(rowsOverlap(st().project.scenes)).toEqual([])
  })
})

describe('token renumbering', () => {
  beforeEach(() => {
    st().addRefs(['s1'], ['a', 'b', 'c']) // a=@image_1,2  b=@image_3  c=@image_4
    st().updateScene('s1', { prompt: '@image_1 @image_2 with @image_3 in @image_4' })
  })
  it('reordering refs keeps every token on its image', () => {
    st().moveRef('s1', 2, 0) // c, a, b → c=1 a=2,3 b=4
    expect(sc('s1').prompt).toBe('@image_2 @image_3 with @image_4 in @image_1')
  })
  it('removing a ref renumbers the rest and leaves red placeholders (old number + label) — no text is lost', () => {
    st().removeRef('s1', 'a')
    expect(sc('s1').prompt).toBe('@image_?1(Elara) @image_?2(Elara · ảnh 2) with @image_1 in @image_2')
    undo()
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_3 in @image_4')
  })
  it('removing ONE picture of a character still linked: "Tên · ảnh k" for every k, the first one included', () => {
    st().updateAsset('a', { imageIds: ['i2'] })
    expect(sc('s1').prompt).toBe('@image_?1(Elara · ảnh 1) @image_1 with @image_2 in @image_3')
    undo()
    st().updateAsset('a', { imageIds: ['i1'] })
    expect(sc('s1').prompt).toBe('@image_1 @image_?2(Elara · ảnh 2) with @image_2 in @image_3')
  })
  it('adding an image to an asset shifts the following numbers in every scene using it', () => {
    st().updateAsset('a', { imageIds: ['i1', 'i2', 'i9'] })
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_4 in @image_5')
  })
  it('deleting an asset from the library renumbers and leaves its placeholder', () => {
    st().removeAssets(['b'])
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_?3(Lumi) in @image_3')
  })
  it('can be turned off', () => {
    st().updateProjectSettings({ autoRenumber: false })
    st().moveRef('s1', 2, 0)
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_3 in @image_4')
  })
  it('turned off: a removal still turns the removed picture red, the other numbers stay as written', () => {
    st().updateProjectSettings({ autoRenumber: false })
    st().removeRef('s1', 'b')
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_?3(Lumi) in @image_4')
    expect(sc('s1').refs).toEqual(['a', 'c'])
  })
  it('removeRefs in several scenes, deleteItems (Delete on wires) and moveRefToScene: one undo step each', () => {
    st().addRefs(['s2'], ['b', 'c'])
    st().updateScene('s2', { prompt: '@image_1 near @image_2' })
    const steps = history().pastStates.length
    st().removeRefs([
      { sceneId: 's1', assetId: 'b' },
      { sceneId: 's2', assetId: 'b' },
    ])
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_?3(Lumi) in @image_3')
    expect(sc('s2').prompt).toBe('@image_?1(Lumi) near @image_1')
    expect(history().pastStates.length).toBe(steps + 1)
    undo()
    st().deleteItems({ refs: [{ sceneId: 's2', assetId: 'c' }] })
    expect(sc('s2').prompt).toBe('@image_1 near @image_?2(Cave)')
    undo()
    st().moveRefToScene('c', 's1', 's3')
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_3 in @image_?4(Cave)')
    expect(sc('s3').refs).toEqual(['c'])
    undo()
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_3 in @image_4')
    expect(sc('s3').refs).toEqual([])
  })
  it('linking after a cut never fills a placeholder by itself (not even the same character)', () => {
    st().removeRef('s1', 'b')
    st().addRefs(['s1'], ['b'])
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_?3(Lumi) in @image_3')
  })
})

describe('reference videos retired (0.6.0)', () => {
  it('the store has no way left to link a take to a scene', () => {
    const s = st() as unknown as Record<string, unknown>
    for (const name of ['addVideoRefs', 'removeVideoRef', 'moveVideoRef', 'moveVideoRefToScene']) expect(s[name]).toBeUndefined()
    // a scene built from a partial never takes video ids
    const id = st().addScene({ videoRefs: ['t1'] } as Partial<Scene>)
    expect(sc(id).videoRefs).toEqual([])
  })
  it('@video text is never rewritten by a refs change (renumbering only touches @image)', () => {
    st().addRefs(['s1'], ['a', 'b']) // a=@image_1,2  b=@image_3
    st().updateScene('s1', { prompt: 'Continue from @video_1: @image_3 meets @Video 2 and @video_?3(S01·T1)' })
    st().removeRef('s1', 'a')
    expect(sc('s1').prompt).toBe('Continue from @video_1: @image_1 meets @Video 2 and @video_?3(S01·T1)')
    st().moveRef('s1', 0, 0)
    st().removeAssets(['b'])
    expect(sc('s1').prompt).toBe('Continue from @video_1: @image_?1(Lumi) meets @Video 2 and @video_?3(S01·T1)')
  })
  it('deleting takes everywhere only drops folder links, keeps prompts, and is not an undo step', () => {
    st().loadProject({ ...project(), folders: [{ id: 'f1', name: 'A', path: 'D:\\A', position: { x: 0, y: 0 }, mode: 'copy', takes: ['t1', 't2'] }] })
    history().clear()
    st().updateScene('s2', { prompt: 'from @video_1' })
    const steps = history().pastStates.length
    st().removeTakesEverywhere(['t1'])
    expect(st().project.folders?.[0].takes).toEqual(['t2'])
    expect(sc('s2').prompt).toBe('from @video_1')
    expect(history().pastStates.length).toBe(steps)
    undo()
    expect(st().project.folders?.[0].takes).toEqual(['t2'])
  })
  it('duplicateScenes and createNextScene never copy the archived links (legacyVideoRefs)', () => {
    st().loadProject({ ...project(), scenes: project().scenes.map((s) => (s.id === 's1' ? { ...s, legacyVideoRefs: ['t1'], prompt: '@video_1 x' } : s)) })
    const [copy] = st().duplicateScenes(['s1'])
    expect(sc(copy)).not.toHaveProperty('legacyVideoRefs')
    expect(sc(copy).prompt).toBe('@video_1 x')
    expect(sc(st().createNextScene('s1'))).not.toHaveProperty('legacyVideoRefs')
    expect(sc('s1').legacyVideoRefs).toEqual(['t1'])
  })
  it('setPrompts: several prompts in ONE undo step, unchanged / unknown ids skipped, never merged with typing', () => {
    st().setScenePrompt('s1', 'typed')
    const steps = history().pastStates.length
    st().setPrompts({ s1: 'a', s2: 'b', nope: 'c', s3: sc('s3').prompt })
    expect([sc('s1').prompt, sc('s2').prompt]).toEqual(['a', 'b'])
    expect(history().pastStates.length).toBe(steps + 1)
    undo()
    expect([sc('s1').prompt, sc('s2').prompt]).toEqual(['typed', ''])
    const before = st().project
    st().setPrompts({ s1: 'typed' })
    expect(st().project).toBe(before)
  })
})

describe('restoreScene', () => {
  it('is one undo step and drops dangling refs', () => {
    st().addRefs(['s1'], ['a'])
    st().restoreScene('s1', { prompt: 'old @video_1', refs: ['a', 'gone'], settings: sc('s1').settings })
    expect(sc('s1').refs).toEqual(['a'])
    expect(sc('s1').videoRefs).toEqual([])
    expect(sc('s1').prompt).toBe('old @video_1')
    undo()
    expect(sc('s1').prompt).toBe('')
  })
})

describe('undo history', () => {
  it('an edit right after undo gets its own step and clears redo', () => {
    st().setScenePrompt('s1', 'a')
    st().setScenePrompt('s1', 'ab')
    undo()
    st().setScenePrompt('s1', 'x')
    expect(history().futureStates.length).toBe(0)
    undo()
    expect(sc('s1').prompt).toBe('')
    redo()
    expect(sc('s1').prompt).toBe('x')
  })
})

describe('moveRefToScene', () => {
  it('keeps the original link when the target is over its image limit', () => {
    st().updateSettings(['s2'], { model: 'minimax_h3', mode: 'i2v' })
    st().addRefs(['s1'], ['a'])
    // H3 accepts 9 images: fill s2 with 9 one-image assets
    for (let i = 0; i < 9; i++) st().addAsset({ id: 'x' + i, name: 'X' + i, imageIds: ['m' + i] })
    st().addRefs(['s2'], Array.from({ length: 9 }, (_, i) => 'x' + i))
    st().moveRefToScene('a', 's1', 's2')
    expect(sc('s1').refs).toEqual(['a'])
  })
})

describe('updatePreset', () => {
  const settings = { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' } as const
  beforeEach(() => {
    const p = project(3)
    st().loadProject({
      ...p,
      presets: [{ id: 'k', name: 'Phim', ...settings }],
      scenes: p.scenes.map((s, i) => (i < 2 ? { ...s, presetId: 'k' } : s)),
    })
    history().clear()
  })

  it('a rename keeps every link', () => {
    st().updatePreset('k', { name: 'Phim dài' })
    expect(st().project.presets[0].name).toBe('Phim dài')
    expect(st().project.scenes.map((s) => s.presetId)).toEqual(['k', 'k', null])
  })

  it('changed settings unlink the scenes that no longer match, in one undo step', () => {
    // s2 already has the duration the preset is about to get
    st().loadProject({ ...st().project, scenes: st().project.scenes.map((s) => (s.id === 's2' ? { ...s, settings: { ...s.settings, duration: 5 } } : s)) })
    history().clear()
    st().updatePreset('k', { duration: 5 })
    expect(st().project.presets[0].duration).toBe(5)
    // s1 still has 15 s → unlinked; s2 already has 5 s → stays linked
    expect(st().project.scenes.map((s) => s.presetId)).toEqual([null, 'k', null])
    undo()
    expect(st().project.presets[0].duration).toBe(15)
    expect(st().project.scenes.map((s) => s.presetId)).toEqual(['k', 'k', null])
  })

  it('a blank name keeps the old one; unknown ids change nothing', () => {
    st().updatePreset('k', { name: '  ' })
    expect(st().project.presets[0].name).toBe('Phim')
    const before = st().project
    st().updatePreset('nope', { name: 'x' })
    expect(st().project).toBe(before)
  })
})

// Test giới hạn D1: "Dự án đọc lại khác bản đang mở" — the store kept blank / untrimmed names that migrate rewrites.
describe('names are kept the way migrate reads them back (core/names): save + reopen changes nothing', () => {
  /** What a reopen gives: the project as saved (JSON), migrated. */
  const reopened = () => migrateProject(JSON.parse(JSON.stringify(st().project)))
  const long = 'Tên '.repeat(80) + '🎬'.repeat(60)

  it('assets: a blank name is "Không tên" at once (create and rename); a typed one is kept as typed', () => {
    const blank = st().addAsset({ name: '' })
    const spaces = st().addAsset({ name: '   ' })
    const typed = st().addAsset({ name: '  Elara 2 ' })
    const named = (id: string) => st().project.assets.find((a) => a.id === id)!
    expect([named(blank).name, named(spaces).name, named(typed).name]).toEqual(['Không tên', 'Không tên', '  Elara 2 '])
    expect(named(blank).tag).toBeTruthy()
    st().updateAsset('a', { name: ' \t ' })
    expect(named('a').name).toBe('Không tên')
    st().updateAsset('b', { name: long })
    expect(named('b').name).toBe(long)
    const back = reopened()
    expect(back.assets.map((a) => [a.id, a.name, a.tag])).toEqual(st().project.assets.map((a) => [a.id, a.name, a.tag]))
  })

  it('folder nodes: trimmed, at most 120 characters (never half an emoji), blank → the folder name or "Thư mục" — on create and on "Chọn lại thư mục"', () => {
    const a = st().addFolder({ name: '   ', path: null, position: { x: 0, y: 0 } })
    const b = st().addFolder({ name: '  Phim A  ', path: null, position: { x: 0, y: 200 } })
    const c = st().addFolder({ name: '🎬'.repeat(130), path: null, position: { x: 0, y: 400 } })
    const d = st().addFolder({ name: '', path: 'C:\\Users\\me\\Videos\\Phim B\\', position: { x: 0, y: 600 } })
    const name = (id: string) => st().project.folders!.find((f) => f.id === id)!.name
    expect([name(a), name(b), name(d)]).toEqual(['Thư mục', 'Phim A', 'Phim B'])
    expect(name(c)).toBe('🎬'.repeat(120)) // 120 code points, never half an emoji
    const e = st().addFolder({ name: long, path: null, position: { x: 0, y: 800 } })
    expect([...name(e)].length).toBeLessThanOrEqual(120)
    expect(name(e)).toBe(name(e).trim())
    st().setFolderPlace(b, { name: ' ', path: null })
    expect(name(b)).toBe('Thư mục')
    st().setFolderPlace(a, { name: '  Kết quả ', path: '/home/me/out' })
    expect(name(a)).toBe('Kết quả')
    const back = reopened()
    expect(back.folders!.map((f) => [f.id, f.name])).toEqual(st().project.folders!.map((f) => [f.id, f.name]))
  })

  it('presets: trimmed on create and rename (a blank rename still keeps the old name)', () => {
    const id = st().addPreset({ name: '  Phim  ', model: 'seedance_2_5' })
    const preset = () => st().project.presets.find((p) => p.id === id)!
    expect(preset().name).toBe('Phim')
    st().updatePreset(id, { name: '  Phim mới ' })
    expect(preset().name).toBe('Phim mới')
    st().updatePreset(id, { name: '   ' })
    expect(preset().name).toBe('Phim mới')
    expect(reopened().presets.map((p) => p.name)).toEqual(st().project.presets.map((p) => p.name))
  })

  it('migrate itself: a folder name cut at 120 that would end on a space reads back the same (idempotent)', () => {
    const raw = { ...st().project, folders: [{ id: 'f1', name: 'a'.repeat(119) + ' b', path: null, position: { x: 0, y: 0 }, mode: 'copy' }] }
    const once = migrateProject(JSON.parse(JSON.stringify(raw)))
    expect(once.folders![0].name).toBe('a'.repeat(119))
    expect(migrateProject(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })
})

describe('removed images leave a labelled placeholder', () => {
  it('blank asset name → tag', () => {
    st().loadProject({
      ...project(1),
      assets: [{ id: 'a', kind: 'character', name: '  ', tag: 'Elara', description: '', imageIds: ['i1'], color: '#fff', position: null }],
      scenes: [scene(0, { refs: ['a'], prompt: '@image_1 walks' })],
    })
    st().removeRef('s1', 'a')
    expect(sc('s1').prompt).toBe('@image_?1(Elara) walks')
  })
  it('two characters with the same name: each placeholder gets the (unique) tag', () => {
    st().loadProject({
      ...project(1),
      assets: [
        { id: 'a', kind: 'character', name: 'Lumi', tag: 'Lumi', description: '', imageIds: ['i1'], color: '#fff', position: null },
        { id: 'b', kind: 'character', name: 'lumi ', tag: 'LumiNho', description: '', imageIds: ['i2'], color: '#fff', position: null },
      ],
      scenes: [scene(0, { refs: ['a', 'b'], prompt: '@image_1 and @image_2' })],
    })
    st().removeRefs([
      { sceneId: 's1', assetId: 'a' },
      { sceneId: 's1', assetId: 'b' },
    ])
    expect(sc('s1').prompt).toBe('@image_?1(Lumi) and @image_?2(LumiNho)')
  })
  it('a long or odd name is sanitized (no parentheses / @ / ?, ≤ 40 code points + …)', () => {
    st().loadProject({
      ...project(1),
      assets: [{ id: 'a', kind: 'character', name: 'Bé (An) @nhà? ' + 'rất dài '.repeat(8), tag: 'BeAn', description: '', imageIds: ['i1'], color: '#fff', position: null }],
      scenes: [scene(0, { refs: ['a'], prompt: '@image_1 cười' })],
    })
    st().removeRef('s1', 'a')
    const p = sc('s1').prompt
    expect(p).toMatch(/^@image_\?1\(Bé An nhà rất dài[^()@?]*…\) cười$/u)
    expect([...p.slice(p.indexOf('(') + 1, p.indexOf(')'))].length).toBeLessThanOrEqual(41)
  })
  it('text glued to a removed token is kept; it stays the label only when it describes that picture', () => {
    st().loadProject({ ...project(1), scenes: [scene(0, { refs: ['b', 'c'], prompt: '@image_1 @image_2(Cave) end' })] })
    st().removeRef('s1', 'c')
    expect(sc('s1').prompt).toBe('@image_1 @image_?2(Cave) end')
    // "(Lumi)" does not describe Cave's picture: the label says Cave, "(Lumi)" stays as plain text after it
    st().loadProject({ ...project(1), scenes: [scene(0, { refs: ['b', 'c'], prompt: '@image_1 @image_2(Lumi) end' })] })
    st().removeRef('s1', 'c')
    expect(sc('s1').prompt).toBe('@image_1 @image_?2(Cave)(Lumi) end')
  })
})

describe('filling placeholders (always explicit, one undo step each)', () => {
  beforeEach(() => {
    st().addRefs(['s1'], ['b', 'c'])
    st().updateScene('s1', { prompt: '@image_1 hugs @image_2 here' })
  })
  const mira = { id: 'm', kind: 'character' as const, name: 'Mira', tag: 'Mira', description: '', imageIds: ['m1'], color: '#fff', position: null }

  it('fillPlaceholder puts the character at the removed one\'s place and renumbers the rest', () => {
    st().removeRef('s1', 'b') // '@image_?1(Lumi) hugs @image_1 here', refs [c]
    st().addAsset({ ...mira })
    st().addRefs(['s1'], ['m']) // appended: [c, m]
    expect(sc('s1').prompt).toBe('@image_?1(Lumi) hugs @image_1 here')
    const steps = history().pastStates.length
    const res = st().fillPlaceholder('s1', '@image_?1(Lumi)', 'm')
    expect(res).toEqual({ ok: true, token: '@image_1', filled: 1, left: 0 })
    expect(sc('s1').refs).toEqual(['m', 'c'])
    expect(sc('s1').prompt).toBe('@image_1 hugs @image_2 here')
    expect(history().pastStates.length).toBe(steps + 1)
    undo()
    expect(sc('s1').prompt).toBe('@image_?1(Lumi) hugs @image_1 here')
    expect(sc('s1').refs).toEqual(['c', 'm'])
  })
  it('a refused fill changes nothing and adds no undo step', () => {
    st().removeRef('s1', 'b')
    st().addAsset({ ...mira, id: 'n', imageIds: [] })
    const before = st().project
    const steps = history().pastStates.length
    expect(st().fillPlaceholder('s1', 'L:Lumi', 'n')).toEqual({ ok: false, why: 'no-image' })
    expect(st().fillPlaceholder('s1', 'L:Nobody', 'c')).toEqual({ ok: false, why: 'gone' })
    expect(st().project).toBe(before)
    expect(history().pastStates.length).toBe(steps)
  })
  it('fillPlaceholders fills the same label in several scenes in ONE step and reports refusals', () => {
    st().addRefs(['s2'], ['b'])
    st().updateScene('s2', { prompt: 'only @image_1' })
    st().removeRefs([
      { sceneId: 's1', assetId: 'b' },
      { sceneId: 's2', assetId: 'b' },
    ])
    st().addAsset({ ...mira })
    st().addRefs(['s1', 's2'], ['m'])
    const steps = history().pastStates.length
    const res = st().fillPlaceholders(['s1', 's2', 's3'], 'Lumi', 'm')
    expect(res.filled).toEqual(['s1', 's2'])
    expect(res.refused).toEqual([{ sceneId: 's3', why: 'gone' }])
    expect(sc('s1').prompt).toBe('@image_1 hugs @image_2 here')
    expect(sc('s2').prompt).toBe('only @image_1')
    expect(history().pastStates.length).toBe(steps + 1)
  })
  it('fillPictureSlot: a new picture of the character fills its own "(Tên · ảnh k)" only', () => {
    st().loadProject({ ...project(2), scenes: [scene(0, { refs: ['a', 'b'], prompt: '@image_1 @image_2 + @image_3' }), scene(1, { refs: ['b'], prompt: '@image_1' })] })
    st().updateAsset('a', { imageIds: ['i1'] })
    expect(sc('s1').prompt).toBe('@image_1 @image_?2(Elara · ảnh 2) + @image_2')
    st().updateAsset('a', { imageIds: ['i1', 'i7'] })
    expect(sc('s1').prompt).toBe('@image_1 @image_?2(Elara · ảnh 2) + @image_3')
    const steps = history().pastStates.length
    expect(st().fillPictureSlot('a', 2, 'i7')).toEqual(['s1'])
    expect(sc('s1').prompt).toBe('@image_1 @image_2 + @image_3')
    expect(history().pastStates.length).toBe(steps + 1)
    expect(st().fillPictureSlot('a', 2, 'i7')).toEqual([])
  })
  it('replaceRef: same picture count keeps the prompt byte for byte; fewer pictures leave "(Tên · ảnh k)"', () => {
    st().addAsset({ ...mira })
    expect(st().replaceRef('s1', 'b', 'm')).toEqual({ ok: true })
    expect(sc('s1').refs).toEqual(['m', 'c'])
    expect(sc('s1').prompt).toBe('@image_1 hugs @image_2 here')
    undo()
    st().loadProject({ ...project(1), assets: [...project().assets, mira], scenes: [scene(0, { refs: ['a', 'c'], prompt: '@image_1 @image_2 @image_3' })] })
    expect(st().replaceRef('s1', 'a', 'm')).toEqual({ ok: true })
    expect(sc('s1').prompt).toBe('@image_1 @image_?2(Elara · ảnh 2) @image_2')
    expect(st().replaceRef('s1', 'a', 'm')).toEqual({ ok: false, why: 'not-linked' })
    expect(st().replaceRef('s1', 'm', 'c')).toEqual({ ok: false, why: 'already-linked' })
  })
})

describe('history jumps (onHistoryJump)', () => {
  type Call = { before: Project; after: Project; kind: HistoryJumpKind }
  const record = () => {
    const calls: Call[] = []
    const off = onHistoryJump((before, after, kind) => calls.push({ before, after, kind }))
    return { calls, off }
  }

  it('undo and redo report the project before and after the jump', () => {
    const { calls, off } = record()
    try {
      st().updateScene('s1', { title: 'x' })
      const edited = st().project
      expect(calls).toEqual([]) // a plain edit is not a jump
      undo()
      expect(sc('s1').title).toBe('')
      expect(calls).toHaveLength(1)
      expect(calls[0].kind).toBe('undo')
      expect(calls[0].before).toBe(edited)
      expect(calls[0].after).toBe(st().project)
      redo()
      expect(sc('s1').title).toBe('x')
      expect(calls).toHaveLength(2)
      expect(calls[1].kind).toBe('redo')
      expect(calls[1].before).toBe(calls[0].after)
      expect(calls[1].after).toBe(st().project)
    } finally {
      off()
    }
  })

  it('shows a cut folder wire coming back (before / after of the jump)', () => {
    st().loadProject({ ...st().project, folders: [{ id: 'f1', name: 'Phim', path: 'D:\\Phim', position: { x: 0, y: 0 }, mode: 'copy', takes: ['t1'] }] })
    history().clear()
    const { calls, off } = record()
    try {
      st().unlinkFolder('f1', 'save', 't1')
      undo()
      expect(calls[0].before.folders?.[0].takes ?? []).toEqual([])
      expect(calls[0].after.folders?.[0].takes).toEqual(['t1'])
      redo()
      expect(calls[1].before.folders?.[0].takes).toEqual(['t1'])
      expect(calls[1].after.folders?.[0].takes ?? []).toEqual([])
    } finally {
      off()
    }
  })

  it('reports nothing for an empty history, loads, changes outside the history or after unsubscribing', () => {
    const { calls, off } = record()
    try {
      undo()
      redo()
      st().loadProject({ ...project(2), folders: [{ id: 'f1', name: 'A', path: 'D:\\A', position: { x: 0, y: 0 }, mode: 'copy' }] })
      st().removeTakesEverywhere(['t1']) // applyEverywhere: not a jump
      st().setFolderPlace('f1', { name: 'B', path: 'D:\\B' }) // applyEverywhere: not a jump
      history().clear()
      undo()
      expect(calls).toEqual([])
      st().updateScene('s1', { title: 'x' })
      off()
      undo()
      expect(sc('s1').title).toBe('')
      expect(calls).toEqual([])
    } finally {
      off()
    }
  })

  it('the toast undo (undoToastAction) is a jump too', () => {
    const { calls, off } = record()
    try {
      st().updateScene('s1', { title: 'x' })
      undoToastAction().run()
      expect(sc('s1').title).toBe('')
      expect(calls.map((c) => c.kind)).toEqual(['undo'])
    } finally {
      off()
    }
  })

  it('a throwing listener breaks neither the jump nor the other listeners', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const offBad = onHistoryJump(() => {
      throw new Error('boom')
    })
    const { calls, off } = record()
    try {
      st().updateScene('s1', { title: 'x' })
      undo()
      expect(sc('s1').title).toBe('')
      expect(calls).toHaveLength(1)
      expect(quiet).toHaveBeenCalled()
    } finally {
      offBad()
      off()
      quiet.mockRestore()
    }
  })
})

describe('newer-build model marker (foreignModel / foreignSettings)', () => {
  const STAND_IN: VideoSettings = { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' }
  const FOREIGN = {
    foreignModel: 'veo_3_1',
    foreignSettings: { model: 'veo_3_1', mode: 'i2v', duration: 8, resolution: '1080p', ratio: '16:9', audio: true },
  }
  const veo: Preset = { id: 'pv', name: 'Veo', ...STAND_IN, ...FOREIGN }
  const draft: Preset = { id: 'pd', name: 'Nháp', model: 'seedance_2_5', mode: 't2v', duration: 30, resolution: '480p', ratio: '16:9' }
  const marked = (id: string) => ({ foreignModel: sc(id).foreignModel, foreignSettings: sc(id).foreignSettings })
  const unmarked = (id: string) => !('foreignModel' in sc(id)) && !('foreignSettings' in sc(id))

  beforeEach(() => {
    const p = project(3)
    st().loadProject({ ...p, presets: [draft, veo], scenes: p.scenes.map((s) => (s.id === 's1' ? { ...s, presetId: 'pv', ...FOREIGN } : s)) })
    history().clear()
  })

  it('picking a model drops it — even the stand-in model already set; other settings keep it', () => {
    st().updateSettings(['s1'], { duration: 5 })
    expect(marked('s1')).toEqual(FOREIGN)
    expect(sc('s1').settings.duration).toBe(5)
    st().updateSettings(['s1'], { duration: 15 })
    st().updateSettings(['s1'], { model: 'seedance_2_5' })
    expect(unmarked('s1')).toBe(true)
    expect(sc('s1').settings).toEqual(STAND_IN)
    expect(sc('s1').presetId).toBeNull() // no longer what the (newer-build) preset describes
    undo()
    expect(marked('s1')).toEqual(FOREIGN)
    // Several scenes at once: the marker goes where it is, scenes with nothing to change stay the same object.
    const s3 = sc('s3')
    st().updateSettings(['s1', 's3'], { model: 'seedance_2_5' })
    expect(unmarked('s1')).toBe(true)
    expect(sc('s3')).toBe(s3)
  })

  it('applyPreset copies the preset marker; a preset without one drops it', () => {
    st().applyPreset('pv', ['s2'])
    expect(marked('s2')).toEqual(FOREIGN)
    expect(sc('s2').presetId).toBe('pv')
    expect(sc('s2').settings).toEqual(presetSettings(veo))
    st().applyPreset('pd', ['s1', 's2'])
    expect(unmarked('s1')).toBe(true)
    expect(unmarked('s2')).toBe(true)
    expect(sc('s1').settings).toEqual(presetSettings(draft))
    undo()
    expect(marked('s1')).toEqual(FOREIGN)
    expect(marked('s2')).toEqual(FOREIGN)
  })

  it('next scene, scene from a take (createNextScene) and duplicate keep it; unmarked sources add none', () => {
    const next = st().createNextScene('s1')
    expect(marked(next)).toEqual(FOREIGN)
    expect(sc(next).settings).toEqual(sc('s1').settings)
    const fromTake = st().createNextScene('s1', { x: 2000, y: 0 }, { refs: ['a'], settings: STAND_IN, presetId: null })
    expect(marked(fromTake)).toEqual(FOREIGN)
    const [copy] = st().duplicateScenes(['s1'])
    expect(marked(copy)).toEqual(FOREIGN)
    expect(unmarked(st().createNextScene('s2'))).toBe(true)
    expect(unmarked(st().duplicateScenes(['s3'])[0])).toBe(true)
  })

  it('the actions nextScene and createSceneFromVideo keep it', async () => {
    const { createSceneFromVideo, nextScene, noteRecentScene, setCanvasViewSource } = await import('../../actions')
    const { useRuns } = await import('../runs')
    const { useUI } = await import('../ui')
    const offView = setCanvasViewSource(() => null)
    try {
      noteRecentScene(null)
      useUI.setState({ selectedIds: ['s1'], selectedEdgeIds: [] })
      expect(marked(nextScene())).toEqual(FOREIGN)
      const t1: Take = {
        id: 't1',
        sceneId: 's1',
        number: 1,
        status: 'completed',
        progress: 100,
        createdAt: 1,
        startedAt: null,
        finishedAt: null,
        promptSnapshot: '',
        rawPromptSnapshot: '',
        refsSnapshot: [],
        videoRefsSnapshot: [],
        settings: STAND_IN,
        cost: 1,
        starred: false,
        posterId: null,
        videoId: null,
        error: null,
        position: null,
      }
      useRuns.setState({ takes: [t1] })
      const id = createSceneFromVideo('t1')
      expect(id).toBeTruthy()
      expect(marked(id!)).toEqual(FOREIGN)
      expect(sc(id!).videoRefs).toEqual([])
      expect(sc(id!).prompt).toBe('')
    } finally {
      offView()
      useRuns.setState({ takes: [] })
      useUI.setState({ selectedIds: [], selectedEdgeIds: [] })
    }
  })

  it('a new scene that takes the draft preset takes its marker too; given settings do not', () => {
    st().loadProject({ ...project(1), presets: [veo, draft] })
    const fromDraft = st().addScene()
    expect(sc(fromDraft).presetId).toBe('pv')
    expect(marked(fromDraft)).toEqual(FOREIGN)
    expect(unmarked(st().addScene({ settings: STAND_IN }))).toBe(true)
    st().loadProject({ ...project(1), presets: [draft, veo] })
    expect(unmarked(st().addScene())).toBe(true)
  })

  it('edits that pick no model keep it, through undo and a save / load', () => {
    st().updateScene('s1', { title: 'Mở đầu' })
    st().setScenePrompt('s1', 'Một ngày mưa')
    st().addRefs(['s1'], ['a'])
    // PromptEditor writes prompt + refs with the scene's own settings through restoreScene.
    st().restoreScene('s1', { prompt: '@image_1 dưới mưa', refs: ['a'], settings: sc('s1').settings })
    st().moveScene('s1', 3)
    st().setNodeSizes({ s1: { w: 320, h: 260 } })
    expect(marked('s1')).toEqual(FOREIGN)
    undo()
    expect(marked('s1')).toEqual(FOREIGN)
    const saved = JSON.parse(JSON.stringify(st().project)) as Project
    st().loadProject(saved)
    expect(marked('s1')).toEqual(FOREIGN)
    expect(sc('s1').title).toBe('Mở đầu')
  })

  it('updatePreset: picking a model drops the preset marker and unlinks the scenes still carrying it', () => {
    const pv = () => st().project.presets.find((x) => x.id === 'pv')!
    st().updatePreset('pv', { name: 'Veo 3.1' })
    st().updatePreset('pv', { duration: 5 })
    expect(pv().foreignModel).toBe('veo_3_1')
    st().loadProject({
      ...st().project,
      presets: st().project.presets.map((x) => (x.id === 'pv' ? { ...x, duration: 15 } : x)),
      scenes: st().project.scenes.map((s) => (s.id === 's1' || s.id === 's2' ? { ...s, presetId: 'pv' } : s)),
    })
    history().clear()
    st().updatePreset('pv', { model: 'seedance_2_5' }) // the stand-in model: settings unchanged, the marker goes
    expect('foreignModel' in pv() || 'foreignSettings' in pv()).toBe(false)
    expect(sc('s1').presetId).toBeNull() // still a newer-build scene: no longer what the preset describes
    expect(marked('s1')).toEqual(FOREIGN)
    expect(sc('s2').presetId).toBe('pv') // same settings, no marker: still matches
    undo()
    expect(pv().foreignModel).toBe('veo_3_1')
    expect(sc('s1').presetId).toBe('pv')
  })

  it('restoring the settings of a take made on a newer build’s model marks the scene (blocked, never a runnable Seedance 2.5)', () => {
    // A take saved by a newer build keeps its own settings as they were (migrateTake does not touch them).
    const takeSettings = { model: 'future/model_x', mode: 'i2v', duration: 8, resolution: '1080p', ratio: '16:9', audio: true } as unknown as VideoSettings
    const s2 = sc('s2')
    st().restoreScene('s2', { prompt: 'Mưa', refs: [], settings: takeSettings })
    expect(marked('s2')).toEqual({ foreignModel: 'future/model_x', foreignSettings: { ...takeSettings } })
    expect(sc('s2').settings.model).toBe('seedance_2_5') // stand-in values, as everywhere
    expect(sc('s2').prompt).toBe('Mưa')
    undo()
    expect(sc('s2')).toEqual(s2)
    // Settings of a model this build knows keep the scene's own marker as it is (an edit of the prompt passes the
    // scene's stand-in settings back: never a way to unblock it).
    st().restoreScene('s1', { prompt: 'Sửa', refs: [], settings: sc('s1').settings })
    expect(marked('s1')).toEqual(FOREIGN)
    expect(sc('s1').presetId).toBe('pv')
    st().restoreScene('s3', { prompt: 'x', refs: [], settings: { ...sc('s3').settings, duration: 5 } })
    expect(unmarked('s3')).toBe(true)
    // A marked scene restored from another newer-build take takes that take's marker.
    st().restoreScene('s1', { prompt: 'y', refs: [], settings: { ...takeSettings, model: 'kling_9' } as unknown as VideoSettings })
    expect(sc('s1').foreignModel).toBe('kling_9')
    expect(sc('s1').presetId).toBeNull()
  })

  it('a config marker (a newer build’s values for a known model) goes with ANY setting chosen here, and is kept otherwise', () => {
    const CONFIG = { foreignSettings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '4k', ratio: '16:9' } }
    st().loadProject({ ...st().project, scenes: st().project.scenes.map((s) => (s.id === 's2' ? { ...s, ...CONFIG } : s)) })
    st().updateScene('s2', { title: 'Mưa' })
    expect(sc('s2').foreignSettings).toEqual(CONFIG.foreignSettings)
    // the same duration chosen again is still a choice: the scene runs with what it shows
    st().updateSettings(['s2'], { duration: sc('s2').settings.duration })
    expect(unmarked('s2')).toBe(true)
    undo()
    expect(sc('s2').foreignSettings).toEqual(CONFIG.foreignSettings)
    // restoring settings over it drops it too; restoring a take's settings with such values marks the scene
    st().restoreScene('s2', { prompt: 'x', refs: [], settings: sc('s2').settings })
    expect(unmarked('s2')).toBe(true)
    const takeSettings = { model: 'minimax_h3', mode: 't2v', duration: 20, resolution: '4k', ratio: '16:9' } as unknown as VideoSettings
    st().restoreScene('s3', { prompt: 'y', refs: [], settings: takeSettings })
    expect(sc('s3').foreignSettings).toEqual({ ...takeSettings })
    expect('foreignModel' in sc('s3')).toBe(false)
    expect(sc('s3').settings).toMatchObject({ model: 'minimax_h3', resolution: '768p' })
    // a preset with one: renaming keeps it, a setting drops it
    const id = st().addPreset({ name: '4K', ...STAND_IN, ...CONFIG })
    const find = () => st().project.presets.find((x) => x.id === id)!
    st().updatePreset(id, { name: '4K dọc' })
    expect(find().foreignSettings).toEqual(CONFIG.foreignSettings)
    st().updatePreset(id, { ratio: '9:16' })
    expect('foreignSettings' in find()).toBe(false)
  })

  it('addPreset keeps a marker it is given and adds none otherwise', () => {
    const withMark = st().addPreset({ name: 'Từ cảnh', ...STAND_IN, ...FOREIGN })
    const plain = st().addPreset({ name: 'Mới', ...STAND_IN })
    const find = (id: string) => st().project.presets.find((x) => x.id === id)!
    expect(find(withMark)).toMatchObject(FOREIGN)
    expect('foreignModel' in find(plain)).toBe(false)
  })
})

describe('a newer build’s project through save / load (migrate round trip)', () => {
  // A scene on a model this build does not know, exactly as the newer build saved it.
  const VEO = { model: 'future/model_x', mode: 'r2v', duration: 8, resolution: '1080p', ratio: '9:16', audio: true }
  const saveAndLoad = () => st().loadProject(migrateProject(JSON.parse(JSON.stringify(st().project))))
  const blockReason = (id: string) => sceneRunBlockReason(st().project.assets, sc(id))

  beforeEach(() => {
    const p = project(2)
    const raw = { ...p, schemaVersion: 3, presets: [{ id: 'pv', name: 'Veo', ...VEO }], scenes: p.scenes.map((s) => (s.id === 's1' ? { ...s, prompt: 'x', presetId: 'pv', settings: VEO } : s)) }
    st().loadProject(migrateProject(JSON.parse(JSON.stringify(raw))))
    history().clear()
  })

  it('keeps foreignSettings exactly through edits, a save and a reload; the newer build gets its settings back', () => {
    expect(sc('s1')).toMatchObject({ foreignModel: 'future/model_x', foreignSettings: VEO, presetId: 'pv' })
    expect(sc('s1').settings.model).toBe('seedance_2_5') // stand-in: every reader keeps working
    st().updateScene('s1', { title: 'Mở đầu' })
    st().setScenePrompt('s1', 'Mưa rơi @image_1')
    st().addRefs(['s1'], ['a'])
    st().updateSettings(['s1'], { duration: 5 }) // an edit of the stand-in settings: the marker stays
    saveAndLoad()
    saveAndLoad()
    const s = sc('s1')
    expect(s).toMatchObject({ title: 'Mở đầu', prompt: 'Mưa rơi @image_1', refs: ['a'], foreignModel: 'future/model_x', foreignSettings: VEO })
    expect(s.settings).toMatchObject({ model: 'seedance_2_5', duration: 5 })
    // What the build that knows the model does on load (its migrate): settings = foreignSettings + foreignModel.
    expect({ ...s.foreignSettings, model: s.foreignModel }).toEqual(VEO)
    // The preset keeps its marker too.
    expect(st().project.presets[0]).toMatchObject({ foreignModel: 'future/model_x', foreignSettings: VEO })
  })

  it('the model picker shows the marker as its selected entry (several scenes: only when they share it)', () => {
    const pick = (...ids: string[]) => modelPick(ids.map((id) => sc(id).settings), ids.map((id) => sc(id).foreignModel))
    expect(pick('s1')).toEqual({ foreign: 'future/model_x', model: null })
    expect(pick('s2')).toEqual({ foreign: null, model: 'seedance_2_5' })
    expect(pick('s1', 's2')).toEqual({ foreign: null, model: null }) // "—": only one of them is on the newer model
    const [copy] = st().duplicateScenes(['s1'])
    expect(pick('s1', copy)).toEqual({ foreign: 'future/model_x', model: null })
    expect(modelPick([sc('s1').settings])).toEqual({ foreign: null, model: 'seedance_2_5' }) // caller passes no markers
  })

  it('stays blocked until a model is picked here; picking one drops the marker for good', () => {
    expect(blockReason('s1')).toContain('bản SanoVids mới hơn (future/model_x)')
    expect(blockReason('s2')).not.toContain('mới hơn')
    st().updateSettings(['s1'], { model: 'minimax_h3' })
    saveAndLoad()
    expect('foreignModel' in sc('s1') || 'foreignSettings' in sc('s1')).toBe(false)
    expect(sc('s1').settings.model).toBe('minimax_h3')
    expect(blockReason('s1')).toBeNull()
  })

  it('scenes made from it keep the marker through a save and a reload (next scene, scene from a take, duplicate, preset)', () => {
    const next = st().createNextScene('s1')
    const fromTake = st().createNextScene('s1', { x: 3000, y: 0 }, { title: 'Tiếp' })
    const [copy] = st().duplicateScenes(['s1'])
    st().applyPreset('pv', ['s2'])
    saveAndLoad()
    for (const id of [next, fromTake, copy, 's2']) {
      expect(sc(id)).toMatchObject({ foreignModel: 'future/model_x', foreignSettings: VEO })
      expect(blockReason(id)).toContain('mới hơn')
    }
  })
})

describe('moveScene undo coalescing (sceneOrderActions: a held Alt + ↑ is one step)', () => {
  const ids = () => [...st().project.scenes].sort((a, b) => a.order - b.order).map((s) => s.id)
  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves with the same coalesce key within 1.5 s merge into one step; plain moves stay one step each', () => {
    vi.useFakeTimers()
    let t = 5_000_000
    vi.setSystemTime(t)
    st().moveScene('s4', 3, { coalesce: 'move:s4' })
    vi.setSystemTime((t += 500))
    st().moveScene('s4', 2, { coalesce: 'move:s4' })
    vi.setSystemTime((t += 500))
    st().moveScene('s4', 1, { coalesce: 'move:s4' })
    expect(ids()).toEqual(['s4', 's1', 's2', 's3', 's5', 's6'])
    expect(history().pastStates).toHaveLength(1)
    undo()
    expect(ids()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])

    // After 1.5 s (or with another key) a new step starts; without a key every call is its own step.
    st().moveScene('s4', 3, { coalesce: 'move:s4' })
    vi.setSystemTime((t += 1600))
    st().moveScene('s4', 2, { coalesce: 'move:s4' })
    vi.setSystemTime((t += 100))
    st().moveScene('s2', 6, { coalesce: 'move:s2' })
    vi.setSystemTime((t += 100))
    st().moveScene('s1', 2)
    st().moveScene('s1', 3)
    expect(history().pastStates).toHaveLength(5)
  })
})
