// The scene node and red text (cross-track handoff GT1 → E2), against the real stores: the node judges a scene with
// exactly the engine's rules (its compile inputs include characters named like a linked one, so a label glued to a
// token is judged with the project's names), says "Chưa chạy · còn chữ đỏ" for every block caused by text drawn red,
// and a picture dropped on the "Chữ đỏ chờ ảnh" strip fills the red text through GT1's fill path in ONE undo step.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compileScene } from '../../../core/compile'
import { isRedTextBlock, runBlock, sceneRunBlockReason, type RunBlockKind } from '../../../core/runRules'
import type { Asset, Project, Scene, XY } from '../../../core/types'
import { LAYOUT, undo, useProject } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import { useUI } from '../../../store/ui'
import { sceneAssetsOf } from '../canvasModel'
import { fillFromDrop } from '../SceneNodeEditor'
import { runButtonView } from '../sceneNodeModel'

const scene = (id: string, over: Partial<Scene> = {}, position: XY = { x: LAYOUT.scenesX, y: 60 }): Scene => ({
  id, order: 1, title: '', prompt: '', refs: [], videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position, note: '', ...over,
})
const asset = (id: string, over: Partial<Asset> = {}): Asset => ({
  id, kind: 'character', name: id, tag: id, description: '', imageIds: ['img_' + id], color: '#fff', position: null, ...over,
})
const blank = useProject.getState().project
const projectOf = (scenes: Scene[], assets: Asset[]): Project => ({ ...blank, id: 'red', scenes, assets, folders: [] })

/** What the node computes: its compile inputs (sceneAssetsOf of the project's assets) through core/runRules runBlock. */
function nodeBlock(p: Project, s: Scene) {
  const assets = sceneAssetsOf(p.assets, s)
  const compiled = compileScene({ ...p, assets, scenes: [s] }, s)
  return runBlock({ scene: s, assets, compiled, settingsBlock: null })
}

describe('the node judges a scene like the engine (store/runs check())', () => {
  const elara = asset('elara', { name: 'Elara' })
  const lumi = asset('lumi', { name: 'Lumi', tag: 'Lumi1' })
  const lumi2 = asset('lumi2', { name: 'lumi', tag: 'Lumi2' }) // another character with the same name, not linked
  const village = asset('village', { name: 'Làng', kind: 'location' })
  const all = [elara, lumi, lumi2, village]
  const cases: [string, Partial<Scene>, RunBlockKind | null][] = [
    ['runs', { refs: ['elara'], prompt: '@image_1 walks' }, null],
    ['empty prompt', { refs: ['elara'], prompt: '  ' }, 'empty'],
    // "Lumi" is shared with an unlinked character: only its tag fits a label (core/tokenLabels nameShared) — the node
    // used to judge it with the scene's own assets only and let it through
    ['a label naming a shared name', { refs: ['elara', 'lumi'], prompt: '@image_1 hugs @image_2(Lumi)' }, 'mismatch'],
    ['a label with the tag', { refs: ['elara', 'lumi'], prompt: '@image_1 hugs @image_2(Lumi1)' }, null],
    ['a red placeholder', { refs: ['elara'], prompt: '@image_1 hugs @image_?2(Lumi)' }, 'waiting'],
    ['a bare placeholder', { refs: ['elara'], prompt: '@image_1 hugs @image_?2' }, 'unsent'],
    ['a number with no picture', { refs: ['elara'], prompt: '@image_1 and @image_3' }, 'unsent'],
    ['retired @video text', { refs: ['elara'], prompt: '@image_1 like @video_1' }, 'retired'],
    ['i2v without images', { prompt: 'a field', settings: { model: 'seedance_2_5', mode: 'i2v', duration: 15, resolution: '1080p', ratio: '16:9' } }, 'no-image'],
  ]
  it.each(cases)('%s', (_name, over, kind) => {
    const s = scene('s1', over)
    const p = projectOf([s], all)
    const block = nodeBlock(p, s)
    expect(block?.kind ?? null).toBe(kind)
    expect(block?.reason ?? null).toBe(sceneRunBlockReason(p.assets, s))
  })

  it('"Chưa chạy · còn chữ đỏ" for every block by text drawn red, the plain reason otherwise', () => {
    const view = (kind: RunBlockKind) => {
      const block = { kind, reason: 'x' }
      return runButtonView(block.reason, { cost: 20, kind: 'canvasapp', code: 'S01', duration: 15, placeholders: isRedTextBlock(block) }).label
    }
    for (const kind of ['retired', 'waiting', 'mismatch', 'unsent'] as const) expect(view(kind)).toBe('Chưa chạy · còn chữ đỏ')
    for (const kind of ['empty', 'no-image', 'frames', 'settings', 'foreign', 'long'] as const) expect(view(kind)).not.toBe('Chưa chạy · còn chữ đỏ')
    expect(isRedTextBlock(null)).toBe(false)
  })
})

describe('a picture dropped on the red placeholder strip fills it (GT1 fill path, one undo step)', () => {
  const history = () => useProject.temporal.getState().pastStates.length
  const sceneOf = () => useProject.getState().project.scenes.find((s) => s.id === 's1')!
  const assetOf = (id: string) => useProject.getState().project.assets.find((a) => a.id === id)!
  beforeEach(() => {
    useRuns.setState({ takes: [] })
    useUI.setState({ toasts: [], selectedIds: [] })
    const s = scene('s1', { refs: ['elara', 'lumi', 'village'], prompt: '@image_1 hugs @image_2 in @image_3' })
    useProject.getState().loadProject(projectOf([s], [asset('elara', { position: { x: 40, y: 60 } }), asset('lumi', { name: 'Lumi' }), asset('village'), asset('mira', { name: 'Mira' })]))
    useProject.getState().removeRef('s1', 'lumi')
    useProject.temporal.getState().clear()
  })
  afterEach(() => {
    useProject.getState().loadProject(blank)
    useProject.temporal.getState().clear()
  })

  it('the strip\'s only group: Mira takes Lumi\'s place and number, gets her tile, and one Hoàn tác takes it all back', () => {
    expect(sceneOf().prompt).toBe('@image_1 hugs @image_?2(Lumi) in @image_2')
    const before = useProject.getState().project
    expect(fillFromDrop('s1', null, 'mira')).toBe(true)
    expect(sceneOf().prompt).toBe('@image_1 hugs @image_2 in @image_3')
    expect(sceneOf().refs).toEqual(['elara', 'mira', 'village'])
    expect(assetOf('mira').position).not.toBeNull() // a library card without a tile gets one (4A)
    expect(history()).toBe(1)
    undo()
    expect(useProject.getState().project).toBe(before)
  })

  it('the chip it landed on wins; with several groups and no chip, nothing is filled (the caller links instead)', () => {
    useProject.getState().updateScene('s1', { prompt: '@image_?2(Lumi) and @image_?7(Ghost)' })
    useProject.temporal.getState().clear()
    const before = useProject.getState().project
    expect(fillFromDrop('s1', null, 'mira')).toBe(false)
    expect(useProject.getState().project).toBe(before)
    expect(fillFromDrop('s1', 'L:Ghost', 'mira')).toBe(true)
    expect(sceneOf().prompt).toContain('@image_?2(Lumi)')
    expect(sceneOf().prompt).not.toContain('Ghost')
    expect(history()).toBe(1)
  })

  it('a refused fill (no picture) changes nothing and says why', () => {
    useProject.getState().updateAsset('mira', { imageIds: [] })
    useProject.temporal.getState().clear()
    const before = useProject.getState().project
    expect(fillFromDrop('s1', null, 'mira')).toBe(true) // handled: the user aimed at the red text
    expect(useProject.getState().project).toBe(before)
    expect(history()).toBe(0)
    expect(useUI.getState().toasts.at(-1)?.tone).toBe('warning')
  })
})
