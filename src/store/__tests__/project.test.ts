import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    expect(created.position).toEqual({ x: LAYOUT.scenesX, y: scenePosition(1).y + ROW_H })
    expect(created.order).toBe(3)
    expect(overlapping(st().project.scenes)).toEqual([])
    expect(sc('s3').position.y).toBeGreaterThan(created.position.y)
  })
  it('next scene inherits refs, video refs and settings with an empty prompt (overrides win)', () => {
    st().addRefs(['s1'], ['a'])
    st().addVideoRefs(['s1'], ['t1'])
    st().updateScene('s1', { prompt: 'x' })
    const id = st().createNextScene('s1', undefined, { prompt: 'Continue from @video_1: ' })
    expect(sc(id).refs).toEqual(['a'])
    expect(sc(id).videoRefs).toEqual(['t1'])
    expect(sc(id).prompt).toBe('Continue from @video_1: ')
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
  it('removing a ref renumbers the rest and names the removed one', () => {
    st().removeRef('s1', 'a')
    expect(sc('s1').prompt).toBe('Elara Elara with @image_1 in @image_2')
    undo()
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_3 in @image_4')
  })
  it('adding an image to an asset shifts the following numbers in every scene using it', () => {
    st().updateAsset('a', { imageIds: ['i1', 'i2', 'i9'] })
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_4 in @image_5')
  })
  it('deleting an asset from the library renumbers', () => {
    st().removeAssets(['b'])
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with Lumi in @image_3')
  })
  it('can be turned off', () => {
    st().updateProjectSettings({ autoRenumber: false })
    st().moveRef('s1', 2, 0)
    expect(sc('s1').prompt).toBe('@image_1 @image_2 with @image_3 in @image_4')
  })
})

describe('video references', () => {
  it('respects the model limit and renumbers on removal', () => {
    const res = st().addVideoRefs(['s1'], ['t1', 't2', 't3'])
    expect(res.added).toBe(3)
    st().updateScene('s1', { prompt: '@video_1 then @video_3' })
    st().removeVideoRef('s1', 't1', 'video S01·T1')
    expect(sc('s1').videoRefs).toEqual(['t2', 't3'])
    expect(sc('s1').prompt).toBe('video S01·T1 then @video_2')
  })
  it('H3 accepts at most 3 videos and no videos in t2v', () => {
    st().updateSettings(['s2'], { model: 'minimax_h3', mode: 'i2v' })
    expect(st().addVideoRefs(['s2'], ['t1', 't2', 't3', 't4']).skipped).toBe(1)
    st().updateSettings(['s3'], { model: 'minimax_h3', mode: 't2v' })
    expect(st().addVideoRefs(['s3'], ['t1']).added).toBe(0)
  })
  it('removing a deleted take everywhere is not an undo step (undo must not bring back a dangling @video)', () => {
    st().addVideoRefs(['s1', 's2'], ['t1'])
    st().updateScene('s2', { prompt: 'from @video_1' })
    const steps = history().pastStates.length
    st().removeTakesEverywhere(['t1'], { t1: 'video S01·T1' })
    expect(sc('s1').videoRefs).toEqual([])
    expect(sc('s2').prompt).toBe('from video S01·T1')
    expect(history().pastStates.length).toBe(steps)
  })
  it('no undo or redo brings back a reference to a deleted take', () => {
    st().addVideoRefs(['s1', 's2'], ['t1'])
    st().updateScene('s2', { prompt: 'from @video_1' })
    st().updateScene('s3', { title: 'x' })
    st().removeTakesEverywhere(['t1'], { t1: 'video S01·T1' })
    undo() // the title edit
    expect(sc('s3').title).toBe('')
    expect(sc('s2').videoRefs).toEqual([])
    expect(sc('s2').prompt).toBe('from video S01·T1')
    undo() // the prompt edit
    expect(sc('s2').prompt).toBe('')
    undo() // the link itself: nothing left to link
    expect(sc('s1').videoRefs).toEqual([])
    expect(sc('s2').videoRefs).toEqual([])
    redo()
    redo()
    expect(sc('s2').videoRefs).toEqual([])
    expect(sc('s2').prompt).toBe('from video S01·T1')
  })
  it('undoing an unlink after the take was deleted does not bring it back', () => {
    st().addVideoRefs(['s2'], ['t1', 't2'])
    st().updateScene('s2', { prompt: '@video_1 and @video_2' })
    st().removeVideoRef('s2', 't1', 'video S01·T1')
    st().removeTakesEverywhere(['t1'], { t1: 'video S01·T1' })
    undo()
    expect(sc('s2').videoRefs).toEqual(['t2'])
    expect(sc('s2').prompt).toBe('video S01·T1 and @video_1')
  })
  it('redo after deleting a take does not bring it back either', () => {
    st().addVideoRefs(['s2'], ['t1'])
    undo()
    st().removeTakesEverywhere(['t1'], {})
    redo()
    expect(sc('s2').videoRefs).toEqual([])
  })
})

describe('restoreScene', () => {
  it('is one undo step and drops dangling refs', () => {
    st().addRefs(['s1'], ['a'])
    st().restoreScene('s1', { prompt: 'old', refs: ['a', 'gone'], videoRefs: ['t1', 'dead'], settings: sc('s1').settings }, new Set(['t1']))
    expect(sc('s1').refs).toEqual(['a'])
    expect(sc('s1').videoRefs).toEqual(['t1'])
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

describe('removed images fall back to a readable name', () => {
  it('blank asset name → tag', () => {
    st().loadProject({
      ...project(1),
      assets: [{ id: 'a', kind: 'character', name: '  ', tag: 'Elara', description: '', imageIds: ['i1'], color: '#fff', position: null }],
      scenes: [scene(0, { refs: ['a'], prompt: '@image_1 walks' })],
    })
    st().removeRef('s1', 'a')
    expect(sc('s1').prompt).toBe('Elara walks')
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
      st().addVideoRefs(['s1'], ['t1'])
      st().removeTakesEverywhere(['t1'], {}) // applyEverywhere: not a jump
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
    const fromTake = st().createNextScene('s1', { x: 2000, y: 0 }, { videoRefs: ['t1'], prompt: 'Continue from @video_1: ' })
    expect(marked(fromTake)).toEqual(FOREIGN)
    const [copy] = st().duplicateScenes(['s1'])
    expect(marked(copy)).toEqual(FOREIGN)
    expect(unmarked(st().createNextScene('s2'))).toBe(true)
    expect(unmarked(st().duplicateScenes(['s3'])[0])).toBe(true)
  })

  it('the actions nextScene and createSceneFromTake keep it', async () => {
    const { createSceneFromTake, nextScene, noteRecentScene, setCanvasViewSource } = await import('../../actions')
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
      const id = createSceneFromTake('t1')
      expect(id).toBeTruthy()
      expect(marked(id!)).toEqual(FOREIGN)
      expect(sc(id!).videoRefs).toEqual(['t1'])
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
    st().restoreScene('s1', { prompt: '@image_1 dưới mưa', refs: ['a'], videoRefs: [], settings: sc('s1').settings })
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
    const takeSettings = { model: 'seedvis/veo_3.1', mode: 'i2v', duration: 8, resolution: '1080p', ratio: '16:9', audio: true } as unknown as VideoSettings
    const s2 = sc('s2')
    st().restoreScene('s2', { prompt: 'Mưa', refs: [], settings: takeSettings })
    expect(marked('s2')).toEqual({ foreignModel: 'seedvis/veo_3.1', foreignSettings: { ...takeSettings } })
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
  const VEO = { model: 'seedvis/veo_3.1', mode: 'r2v', duration: 8, resolution: '1080p', ratio: '9:16', audio: true }
  const saveAndLoad = () => st().loadProject(migrateProject(JSON.parse(JSON.stringify(st().project))))
  const blockReason = (id: string) => sceneRunBlockReason(st().project.assets, sc(id), () => undefined, 0)

  beforeEach(() => {
    const p = project(2)
    const raw = { ...p, schemaVersion: 3, presets: [{ id: 'pv', name: 'Veo', ...VEO }], scenes: p.scenes.map((s) => (s.id === 's1' ? { ...s, prompt: 'x', presetId: 'pv', settings: VEO } : s)) }
    st().loadProject(migrateProject(JSON.parse(JSON.stringify(raw))))
    history().clear()
  })

  it('keeps foreignSettings exactly through edits, a save and a reload; the newer build gets its settings back', () => {
    expect(sc('s1')).toMatchObject({ foreignModel: 'seedvis/veo_3.1', foreignSettings: VEO, presetId: 'pv' })
    expect(sc('s1').settings.model).toBe('seedance_2_5') // stand-in: every reader keeps working
    st().updateScene('s1', { title: 'Mở đầu' })
    st().setScenePrompt('s1', 'Mưa rơi @image_1')
    st().addRefs(['s1'], ['a'])
    st().updateSettings(['s1'], { duration: 5 }) // an edit of the stand-in settings: the marker stays
    saveAndLoad()
    saveAndLoad()
    const s = sc('s1')
    expect(s).toMatchObject({ title: 'Mở đầu', prompt: 'Mưa rơi @image_1', refs: ['a'], foreignModel: 'seedvis/veo_3.1', foreignSettings: VEO })
    expect(s.settings).toMatchObject({ model: 'seedance_2_5', duration: 5 })
    // What the build that knows the model does on load (its migrate): settings = foreignSettings + foreignModel.
    expect({ ...s.foreignSettings, model: s.foreignModel }).toEqual(VEO)
    // The preset keeps its marker too.
    expect(st().project.presets[0]).toMatchObject({ foreignModel: 'seedvis/veo_3.1', foreignSettings: VEO })
  })

  it('the model picker shows the marker as its selected entry (several scenes: only when they share it)', () => {
    const pick = (...ids: string[]) => modelPick(ids.map((id) => sc(id).settings), ids.map((id) => sc(id).foreignModel))
    expect(pick('s1')).toEqual({ foreign: 'seedvis/veo_3.1', model: null })
    expect(pick('s2')).toEqual({ foreign: null, model: 'seedance_2_5' })
    expect(pick('s1', 's2')).toEqual({ foreign: null, model: null }) // "—": only one of them is on the newer model
    const [copy] = st().duplicateScenes(['s1'])
    expect(pick('s1', copy)).toEqual({ foreign: 'seedvis/veo_3.1', model: null })
    expect(modelPick([sc('s1').settings])).toEqual({ foreign: null, model: 'seedance_2_5' }) // caller passes no markers
  })

  it('stays blocked until a model is picked here; picking one drops the marker for good', () => {
    expect(blockReason('s1')).toContain('bản SanoVids mới hơn (seedvis/veo_3.1)')
    expect(blockReason('s2')).not.toContain('mới hơn')
    st().updateSettings(['s1'], { model: 'minimax_h3' })
    saveAndLoad()
    expect('foreignModel' in sc('s1') || 'foreignSettings' in sc('s1')).toBe(false)
    expect(sc('s1').settings.model).toBe('minimax_h3')
    expect(blockReason('s1')).toBeNull()
  })

  it('scenes made from it keep the marker through a save and a reload (next scene, scene from a take, duplicate, preset)', () => {
    const next = st().createNextScene('s1')
    const fromTake = st().createNextScene('s1', { x: 3000, y: 0 }, { videoRefs: [], prompt: 'Tiếp' })
    const [copy] = st().duplicateScenes(['s1'])
    st().applyPreset('pv', ['s2'])
    saveAndLoad()
    for (const id of [next, fromTake, copy, 's2']) {
      expect(sc(id)).toMatchObject({ foreignModel: 'seedvis/veo_3.1', foreignSettings: VEO })
      expect(blockReason(id)).toContain('mới hơn')
    }
  })
})
