import { beforeEach, describe, expect, it } from 'vitest'
import { assetDefaultLayout } from '../../canvas/canvasModel'
import type { Asset, Project, Scene, Take } from '../../../core/types'
import { useProject } from '../../../store/project'
import {
  changedPrompts,
  checkTag,
  countMentions,
  finishedTakesOf,
  imageTokenLabels,
  matchesQuery,
  nextAssetPosition,
  norm,
  queryTerms,
  renameAssetTag,
  takeHiddenOnCanvas,
  takeSearchFields,
  undoToastAction,
} from '../shared'

const scene = (id: string, prompt: string, refs: string[] = []): Scene => ({
  id, order: 1, title: '', prompt, refs, videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: 0 }, note: '',
})

const asset = (id: string, name: string, tag: string, imageIds: string[] = [], position: Asset['position'] = null): Asset => ({
  id, kind: 'character', name, tag, description: '', imageIds, color: '#fff', position,
})

const project = (): Project => ({
  id: 'p', name: 'P', schemaVersion: 2, createdAt: 0, updatedAt: 0, presets: [],
  settings: { autoRenumber: true },
  assets: [asset('a', 'Elara', 'Elara', [], { x: 40, y: 60 }), asset('b', 'Bé An', 'BeAn')],
  scenes: [scene('s1', '@Elara meets @BeAn. @Elara smiles.'), scene('s2', 'no mention'), scene('s3', "@Elara's cloak")],
})

const take = (id: string, sceneId: string, number: number, status: Take['status'], finishedAt: number | null): Take => ({
  id, sceneId, number, status, progress: status === 'completed' ? 100 : 0, createdAt: number, startedAt: null, finishedAt,
  promptSnapshot: '', rawPromptSnapshot: '', refsSnapshot: [], videoRefsSnapshot: [],
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  cost: 0, starred: false, posterId: null, videoId: null, error: null, position: null,
})

describe('sidebar search', () => {
  it('ignores Vietnamese diacritics and case', () => {
    expect(norm('Làng Núi Đá')).toBe('lang nui da')
    expect(matchesQuery('lang nui', 'Làng núi', 'LangNui')).toBe(true)
    expect(matchesQuery('@elara', 'Elara')).toBe(true)
    expect(matchesQuery('cave blue', 'Hang động', 'narrow cave with blue crystal light')).toBe(true)
    expect(matchesQuery('dragon', 'Elara')).toBe(false)
    expect(matchesQuery('  ', 'x')).toBe(true)
  })

  it('finds a take by the usual spellings of its code and by scene title', () => {
    const fields = takeSearchFields(3, 2, 'Chợ đêm')
    const hay = norm(fields.join(' \u0001 '))
    for (const q of ['S03·T2', 's03-t2', 'S03T2', 's03 t2', 's3 t2', 't2', 'cho dem', '@s03 @t2', 'CHỢ ĐÊM', '   ']) {
      expect(matchesQuery(q, ...fields)).toBe(true)
      expect(queryTerms(q).every((term) => hay.includes(term))).toBe(true)
    }
    expect(queryTerms('no match').every((term) => hay.includes(term))).toBe(false)
    expect(matchesQuery('S03-T1', ...fields)).toBe(false)
    expect(matchesQuery('S04', ...fields)).toBe(false)
  })
})

describe('@image labels', () => {
  const assets = [asset('a', 'A', 'A', ['a1']), asset('b', 'B', 'B', ['b1', 'b2', 'b3']), asset('c', 'C', 'C'), asset('d', 'D', 'D', ['d1'])]

  it('numbers every image in refs order, with a range for multi-image assets', () => {
    expect(imageTokenLabels(assets, ['b', 'a', 'd'])).toEqual({ b: '@image_1–3', a: '@image_4', d: '@image_5' })
  })

  it('marks linked assets without images with an empty label', () => {
    const labels = imageTokenLabels(assets, ['c', 'a'])
    expect(labels).toEqual({ c: '', a: '@image_1' })
    expect('d' in labels).toBe(false)
  })
})

describe('finished takes', () => {
  it('keeps completed takes of existing scenes, newest first', () => {
    const takes = [
      take('t1', 's1', 1, 'completed', 100),
      take('t2', 's1', 2, 'failed', 300),
      take('t3', 's2', 1, 'completed', 500),
      take('t4', 'gone', 1, 'completed', 900),
      take('t5', 's1', 3, 'processing', null),
      take('t6', 's2', 2, 'completed', 200),
    ]
    expect(finishedTakesOf(takes, new Set(['s1', 's2'])).map((t) => t.id)).toEqual(['t3', 't6', 't1'])
  })

  it('caches by both immutable inputs, without mutating their order', () => {
    const takes = [take('old', 's1', 1, 'completed', 10), take('new', 's2', 1, 'completed', 20)]
    const ids = new Set(['s1', 's2'])
    const first = finishedTakesOf(takes, ids)
    expect(finishedTakesOf(takes, ids)).toBe(first)
    expect(takes.map((t) => t.id)).toEqual(['old', 'new'])
    expect(finishedTakesOf(takes, new Set(['s1']))).toEqual([takes[0]])
    expect(finishedTakesOf(takes, ids)).toBe(first)
    expect(finishedTakesOf([takes[0], { ...takes[1], starred: true }], ids)[0].starred).toBe(true)
  })

  it('keeps completed objects stable across a progress tick; includes newly completed takes', () => {
    const done = take('done', 's1', 1, 'completed', 10)
    const running = take('running', 's1', 2, 'processing', null)
    const ids = new Set(['s1'])
    const tick = finishedTakesOf([done, { ...running, progress: 50 }], ids)
    expect(tick).toEqual(finishedTakesOf([done, running], ids))
    expect(tick[0]).toBe(done)
    expect(finishedTakesOf([done, { ...running, status: 'completed', finishedAt: 30 }], ids).map((t) => t.id)).toEqual(['running', 'done'])
  })
})

describe('takes hidden by "Chỉ take chọn"', () => {
  const scenes = [scene('s1', ''), { ...scene('s2', ''), videoRefs: ['t1'] }]
  const takes = [
    take('t1', 's1', 1, 'completed', 100),
    take('t2', 's1', 2, 'completed', 200),
    take('t3', 's1', 3, 'failed', 300),
    { ...take('t4', 's2', 1, 'completed', 400), starred: true },
    take('t5', 's2', 2, 'completed', 500),
  ]
  it('shows every take in the "all" display', () => {
    for (const t of takes) expect(takeHiddenOnCanvas(t.id, takes, scenes, 'all')).toBe(false)
  })
  it('keeps the chosen take of each scene and the takes used as @video', () => {
    // s1: newest completed (T2) is chosen; T1 stays because S2 uses it as @video; failed T3 is hidden.
    expect(takeHiddenOnCanvas('t2', takes, scenes, 'chosen')).toBe(false)
    expect(takeHiddenOnCanvas('t1', takes, scenes, 'chosen')).toBe(false)
    expect(takeHiddenOnCanvas('t3', takes, scenes, 'chosen')).toBe(true)
    // s2: the starred take wins over the newer one.
    expect(takeHiddenOnCanvas('t4', takes, scenes, 'chosen')).toBe(false)
    expect(takeHiddenOnCanvas('t5', takes, scenes, 'chosen')).toBe(true)
  })
})

describe('tag validation + rename', () => {
  beforeEach(() => {
    useProject.getState().loadProject(project())
    useProject.temporal.getState().clear()
  })

  it('rejects tags used by another asset (case-insensitive), token-like tags, and slugifies', () => {
    const p = useProject.getState().project
    expect(checkTag(p, 'a', 'bean').error).toBeTruthy()
    expect(checkTag(p, 'a', '').error).toBeTruthy()
    expect(checkTag(p, 'a', 'image_3').error).toBeTruthy()
    expect(checkTag(p, 'a', 'video_1').error).toBeTruthy()
    expect(checkTag(p, 'a', '@Elara')).toMatchObject({ error: null, changed: false })
    expect(checkTag(p, 'a', 'Ê la ra')).toMatchObject({ tag: 'ELaRa', error: null, changed: true })
  })

  it('renames the tag and rewrites legacy mentions in prompts as one undo step', () => {
    expect(countMentions(useProject.getState().project, 'Elara')).toBe(2)
    const res = renameAssetTag('a', 'Lyra')
    expect(res).toMatchObject({ ok: true, tag: 'Lyra', rewritten: 2 })
    const p = useProject.getState().project
    expect(p.assets[0].tag).toBe('Lyra')
    expect(p.scenes[0].prompt).toBe('@Lyra meets @BeAn. @Lyra smiles.')
    expect(p.scenes[2].prompt).toBe("@Lyra's cloak")
    expect(useProject.temporal.getState().pastStates.length).toBe(1)
    useProject.temporal.getState().undo()
    expect(useProject.getState().project.assets[0].tag).toBe('Elara')
    expect(useProject.getState().project.scenes[0].prompt).toBe('@Elara meets @BeAn. @Elara smiles.')
  })

  it('refuses a conflicting rename without touching the project', () => {
    const before = useProject.getState().project
    const res = renameAssetTag('a', 'BeAn')
    expect(res.ok).toBe(false)
    expect(useProject.getState().project).toBe(before)
  })

  it('places new canvas assets under the existing asset column', () => {
    // Default card height follows the image (square images here): name/meta rows + the image box.
    expect(nextAssetPosition(useProject.getState().project)).toEqual({ x: 40, y: 60 + assetDefaultLayout(1).h + 28 })
  })

  it('places new canvas assets below a resized (taller) asset node, not over it', () => {
    const p = project()
    p.assets = [
      { ...asset('a', 'A', 'A', [], { x: 40, y: 60 }), size: { w: 300, h: 480 } },
      asset('b', 'B', 'B', [], { x: 40, y: 300 }),
    ]
    // a's bottom edge (60 + 480) is lower than b's (300 + default card height).
    expect(nextAssetPosition(p)).toEqual({ x: 40, y: 60 + 480 + 28 })
  })
})

describe('renumbering feedback', () => {
  beforeEach(() => {
    const p = project()
    p.assets = [asset('a', 'Elara', 'Elara', ['a1', 'a2']), asset('b', 'Bé An', 'BeAn', ['b1'])]
    p.scenes = [scene('s1', '@image_1 and @image_3', ['a', 'b']), scene('s2', '@image_1 waves', ['b']), scene('s3', 'no tokens', ['a'])]
    useProject.getState().loadProject(p)
    useProject.temporal.getState().clear()
  })

  it('lists the scenes whose prompt was rewritten when an asset image is removed', () => {
    const before = useProject.getState().project.scenes
    useProject.getState().updateAsset('a', { imageIds: ['a2'] })
    const after = useProject.getState().project.scenes
    expect(changedPrompts(before, after)).toEqual(['s1'])
    expect(after[0].prompt).toBe('Elara and @image_2')
  })

  it('reports nothing when no prompt changed', () => {
    const before = useProject.getState().project.scenes
    useProject.getState().updateAsset('a', { name: 'Lyra' })
    expect(changedPrompts(before, useProject.getState().project.scenes)).toEqual([])
  })
})

describe('undo toast action', () => {
  beforeEach(() => {
    useProject.getState().loadProject(project())
    useProject.temporal.getState().clear()
  })
  const refsOf = (id: string) => useProject.getState().project.scenes.find((s) => s.id === id)!.refs

  it('undoes its own edit while it is the latest change', () => {
    useProject.getState().addRefs(['s2'], ['a', 'b'])
    useProject.getState().removeRef('s2', 'a')
    const action = undoToastAction()
    action.run()
    expect(refsOf('s2')).toEqual(['a', 'b'])
  })

  it('does not revert a newer edit made after the toast', () => {
    useProject.getState().addRefs(['s2'], ['a', 'b'])
    useProject.getState().removeRef('s2', 'a')
    const action = undoToastAction()
    useProject.getState().addRefs(['s1'], ['b'])
    action.run()
    expect(refsOf('s1')).toEqual(['b'])
    expect(refsOf('s2')).toEqual(['b'])
  })

  it('still works after undo + redo of that edit', () => {
    useProject.getState().addRefs(['s1'], ['a'])
    useProject.temporal.getState().clear()
    useProject.getState().removeRef('s1', 'a')
    const action = undoToastAction()
    useProject.temporal.getState().undo()
    useProject.temporal.getState().redo()
    action.run()
    expect(useProject.temporal.getState().pastStates.length).toBe(0)
  })
})
