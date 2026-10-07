// One-time "giãn hàng" of projects laid out for the 0.5.x cards (280 × 200, rows 248 apart; tiles 180 wide in 238px
// steps): rows spread to 352 (one undo step, toast), gaps the user left stay, old too-small sizes read as the default.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, Project, SaveFolder, Scene, Take, XY } from '../../../core/types'
import { LAYOUT, ROW_H, undo, redo, useProject } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import { useUI } from '../../../store/ui'
import { maybeSpaceRows, OLD_LAYOUT, planRowSpacing, ROW_SPACING_KEY, showsOldLayout, spacingToast, type RowSpacingInput, type RowSpacingPlan } from '../rowSpacing'

const scene = (id: string, position: XY, over: Partial<Scene> = {}): Scene => ({
  id, order: 1, title: '', prompt: '', refs: [], videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position, note: '', ...over,
})
const asset = (id: string, position: XY | null, over: Partial<Asset> = {}): Asset => ({
  id, kind: 'character', name: id, tag: id, description: '', imageIds: ['img'], color: '#fff', position, ...over,
})
const take = (id: string, sceneId: string, position: XY | null): Take => ({
  id, sceneId, number: 1, status: 'completed', progress: 100, createdAt: 1, startedAt: null, finishedAt: null,
  promptSnapshot: '', rawPromptSnapshot: '', refsSnapshot: [], videoRefsSnapshot: [],
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  cost: 1, starred: false, posterId: null, videoId: null, error: null, position,
})
const folder = (id: string, position: XY): SaveFolder => ({ id, name: id, path: null, position, mode: 'copy' })
/** A 0.5.x layout: scenes at x 420 every 248px, tiles at x 40 every 238px. */
const oldRow = (i: number): XY => ({ x: 420, y: 60 + i * 248 })
const oldTile = (i: number): XY => ({ x: 40, y: 60 + i * 238 })

function apply(input: RowSpacingInput, plan: RowSpacingPlan): RowSpacingInput {
  return {
    scenes: input.scenes.map((s) => ({ ...s, position: plan.scenes[s.id] ?? s.position, size: s.id in plan.sizes ? null : s.size })),
    assets: input.assets.map((a) => ({ ...a, position: plan.assets[a.id] ?? a.position })),
    takes: input.takes.map((t) => ({ ...t, position: plan.takes[t.id] ?? t.position })),
    takeRowH: input.takeRowH,
  }
}

describe('planRowSpacing', () => {
  const old: RowSpacingInput = {
    scenes: [0, 1, 2, 3].map((i) => scene('s' + (i + 1), oldRow(i))),
    assets: [0, 1, 2].map((i) => asset('a' + (i + 1), oldTile(i))),
    takes: [
      // s2's take dragged a little right of its row; s3's take dragged LEFT of its card
      { id: 't2', sceneId: 's2', position: { x: 420 + OLD_LAYOUT.sceneW + 64 + 300, y: 308 + 20 } },
      { id: 't3', sceneId: 's3', position: { x: 100, y: 556 } },
    ],
  }

  it('rows 248 apart become one node + one gap apart (352), in one column', () => {
    const plan = planRowSpacing(old)
    expect(plan.changed).toBe(true)
    expect(plan.scenes.s1).toBeUndefined()
    expect([plan.scenes.s2, plan.scenes.s3, plan.scenes.s4]).toEqual([1, 2, 3].map((i) => ({ x: 420, y: 60 + i * ROW_H })))
  })

  it('nothing moves sideways but hand-placed takes right of a card (+72 = the width it gained) and default tiles', () => {
    const plan = planRowSpacing(old)
    for (const p of Object.values(plan.scenes)) expect(p.x).toBe(420)
    expect(plan.takes.t2).toEqual({ x: old.takes[0].position.x + (LAYOUT.sceneW - OLD_LAYOUT.sceneW), y: 328 + (412 - 308) })
    expect(plan.takes.t3).toEqual({ x: 100, y: 556 + (764 - 556) })
  })

  it('the image column: taller tiles re-spaced (275 + 24), default tiles keep their right edge = the wire room', () => {
    const plan = planRowSpacing(old)
    expect([plan.assets.a1, plan.assets.a2, plan.assets.a3]).toEqual([0, 1, 2].map((i) => ({ x: 0, y: 60 + i * (LAYOUT.assetH + LAYOUT.assetGapY) })))
    // a tile the user resized keeps its x (its width is its own), a tile far from the column is not touched
    const plan2 = planRowSpacing({ ...old, assets: [asset('big', { x: 40, y: 60 }, { size: { w: 300, h: 400 } }), asset('far', { x: 3000, y: 60 })] })
    expect(plan2.assets.big).toBeUndefined()
    expect(plan2.assets.far).toBeUndefined()
  })

  it('gaps the user left stay: a scene far below moves by the same amount as the one above it', () => {
    const plan = planRowSpacing({ ...old, scenes: [...old.scenes, scene('s5', { x: 420, y: 3000 })] })
    expect(plan.scenes.s5).toEqual({ x: 420, y: 3000 + 3 * (ROW_H - 248) })
  })

  it('columns side by side spread independently; a resized card keeps its size and its height counts', () => {
    const left = [0, 1].map((i) => scene('l' + i, oldRow(i)))
    const right = [0, 1].map((i) => scene('r' + i, { x: 1600, y: 60 + i * 248 }, i === 0 ? { size: { w: 500, h: 400 } } : {}))
    const plan = planRowSpacing({ scenes: [...left, ...right], assets: [], takes: [] })
    expect(plan.scenes.l1).toEqual({ x: 420, y: 60 + ROW_H })
    expect(plan.scenes.r1).toEqual({ x: 1600, y: 60 + 400 + LAYOUT.gapY })
    expect(plan.sizes).toEqual({})
  })

  it('sizes of the old cards (below 320 × 256) go back to the default size; a take row taller than the node counts', () => {
    const plan = planRowSpacing({
      scenes: [scene('s1', oldRow(0), { size: { w: 280, h: 200 } }), scene('s2', oldRow(1))],
      assets: [],
      takes: [],
      takeRowH: (id) => (id === 's1' ? 500 : 0),
    })
    expect(plan.sizes).toEqual({ s1: null })
    expect(plan.scenes.s2).toEqual({ x: 420, y: 60 + 500 + LAYOUT.gapY })
  })

  it('a project laid out for 0.6.0 (or already spaced) needs nothing — the step is idempotent', () => {
    const fresh: RowSpacingInput = {
      scenes: [0, 1, 2].map((i) => scene('s' + i, { x: LAYOUT.scenesX, y: 60 + i * ROW_H })),
      assets: [0, 1].map((i) => asset('a' + i, { x: LAYOUT.assetX, y: 60 + i * (LAYOUT.assetH + LAYOUT.assetGapY) })),
      takes: [],
    }
    expect(planRowSpacing(fresh).changed).toBe(false)
    const once = apply(old, planRowSpacing(old))
    const again = planRowSpacing(once)
    expect(again.scenes).toEqual({})
    expect(again.takes).toEqual({})
    expect(again.assets).toEqual({})
    expect(again.changed).toBe(false)
    expect(planRowSpacing({ scenes: [], assets: [asset('a', oldTile(0))], takes: [] }).changed).toBe(false)
  })

  it('a 0.6.0 layout (imported / duplicated under a new id) never moves — not even nodes that touch or tiles pulled closer', () => {
    const fresh: RowSpacingInput = {
      scenes: [
        // resized taller in 0.6.0: now 22px above the next row (touching)
        scene('s1', { x: LAYOUT.scenesX, y: 60 }, { size: { w: 352, h: 330 } }),
        scene('s2', { x: LAYOUT.scenesX, y: 60 + ROW_H }),
        // dropped half over another node on purpose (150px apart: never a 0.5.x row)
        scene('s3', { x: LAYOUT.scenesX, y: 60 + 2 * ROW_H }),
        scene('s4', { x: LAYOUT.scenesX, y: 60 + 2 * ROW_H + 150 }),
      ],
      // the image column dragged to 144px from the scenes
      assets: [0, 1].map((i) => asset('a' + i, { x: 100, y: 60 + i * (LAYOUT.assetH + LAYOUT.assetGapY) })),
      takes: [{ id: 't', sceneId: 's1', position: { x: 2000, y: 60 } }],
      folders: [folder('f', { x: 1500, y: 400 })],
    }
    expect(showsOldLayout(fresh)).toBe(false)
    expect(planRowSpacing(fresh)).toMatchObject({ changed: false, scenes: {}, assets: {}, takes: {}, folders: {} })
  })

  it('folder nodes and tiles elsewhere follow the scene row they sit beside; one above every row stays', () => {
    const plan = planRowSpacing({
      ...old,
      assets: [...old.assets, asset('right', { x: 1800, y: 308 + 30 })],
      folders: [folder('f3', { x: 1500, y: 556 - 10 }), folder('top', { x: 1500, y: -400 })],
    })
    expect(plan.folders.f3).toEqual({ x: 1500, y: 546 + (60 + 2 * ROW_H - 556) })
    expect(plan.folders.top).toBeUndefined()
    expect(plan.assets.right).toEqual({ x: 1800, y: 338 + (60 + ROW_H - 308) })
  })

  it('only the image column shows the old layout: the tiles are re-spaced and the toast says so', () => {
    const plan = planRowSpacing({ scenes: [scene('s1', oldRow(0))], assets: [0, 1, 2].map((i) => asset('a' + i, oldTile(i))), takes: [] })
    expect(plan).toMatchObject({ changed: true, rows: false, scenes: {} })
    expect(spacingToast(plan)).toBe('Ô ảnh giờ lớn hơn: cột ảnh đã được giãn ra một lần cho khỏi chồng lên nhau.')
    expect(spacingToast(planRowSpacing(old))).toBe('Node cảnh giờ lớn hơn: các hàng cảnh đã được giãn ra một lần cho khỏi chồng lên nhau.')
  })
})

describe('maybeSpaceRows (opening an old project on the canvas)', () => {
  const store = new Map<string, string>()
  const initial = useProject.getState().project
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
    const project: Project = {
      ...initial,
      id: 'old-project',
      scenes: [0, 1, 2].map((i) => ({ ...scene('s' + i, oldRow(i)), order: i + 1 })),
      assets: [asset('a1', oldTile(0)), asset('a2', oldTile(1))],
    }
    useProject.getState().loadProject(project)
    useProject.temporal.getState().clear()
    useRuns.setState({ takes: [take('t1', 's1', { x: 420 + 280 + 64 + 400, y: 308 })] })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    useProject.getState().loadProject(initial)
    useProject.temporal.getState().clear()
    useRuns.setState({ takes: [] })
  })

  it('spreads the rows once, in one undo step; hand-placed takes follow undo / redo; never again for this project', () => {
    const before = useProject.getState().project
    expect(maybeSpaceRows()).toBe(true)
    const after = useProject.getState().project
    expect(after.scenes.map((s) => s.position.y)).toEqual([60, 60 + ROW_H, 60 + 2 * ROW_H])
    expect(after.assets.map((a) => a.position)).toEqual([{ x: 0, y: 60 }, { x: 0, y: 60 + LAYOUT.assetH + LAYOUT.assetGapY }])
    expect(useProject.temporal.getState().pastStates).toHaveLength(1)
    const moved = { x: 420 + 280 + 64 + 400 + 72, y: 308 + (ROW_H - 248) }
    expect(useRuns.getState().takes[0].position).toEqual(moved)
    expect(JSON.parse(store.get(ROW_SPACING_KEY)!)).toEqual(['old-project'])

    undo()
    expect(useProject.getState().project).toBe(before)
    expect(useRuns.getState().takes[0].position).toEqual({ x: 420 + 280 + 64 + 400, y: 308 })
    redo()
    expect(useProject.getState().project).toBe(after)
    expect(useRuns.getState().takes[0].position).toEqual(moved)

    // remembered: not even after its undo
    undo()
    expect(maybeSpaceRows()).toBe(false)
    expect(useProject.getState().project).toBe(before)
  })

  it('folder nodes move with their row in the same undo step', () => {
    const p = useProject.getState().project
    useProject.getState().loadProject({ ...p, folders: [folder('f', { x: 1500, y: 60 + 2 * 248 })] })
    useProject.temporal.getState().clear()
    expect(maybeSpaceRows()).toBe(true)
    expect(useProject.getState().project.folders![0].position).toEqual({ x: 1500, y: 60 + 2 * ROW_H })
    expect(useProject.temporal.getState().pastStates).toHaveLength(1)
    undo()
    expect(useProject.getState().project.folders![0].position).toEqual({ x: 1500, y: 60 + 2 * 248 })
  })

  it('a 0.6.0 project under a new id (import / duplicate) whose nodes touch is left alone: no move, no toast', () => {
    useUI.setState({ toasts: [] })
    const touching = [scene('s0', { x: 464, y: 60 }, { size: { w: 352, h: 330 } }), scene('s1', { x: 464, y: 60 + ROW_H })]
    useProject.getState().loadProject({ ...useProject.getState().project, id: 'imported-copy', scenes: touching, assets: [] })
    useProject.temporal.getState().clear()
    expect(maybeSpaceRows()).toBe(false)
    expect(useProject.getState().project.scenes.map((s) => s.position.y)).toEqual([60, 60 + ROW_H])
    expect(useProject.temporal.getState().pastStates).toHaveLength(0)
    expect(useUI.getState().toasts).toHaveLength(0)
  })

  it('a project that needs nothing is only remembered (no undo step, no toast)', () => {
    useProject.getState().loadProject({ ...useProject.getState().project, id: 'new-project', scenes: [scene('s', { x: 464, y: 60 })], assets: [] })
    useProject.temporal.getState().clear()
    expect(maybeSpaceRows()).toBe(false)
    expect(useProject.temporal.getState().pastStates).toHaveLength(0)
    expect(JSON.parse(store.get(ROW_SPACING_KEY)!)).toEqual(['new-project'])
  })

  it('storage blocked (private window): still spreads, never throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(() => maybeSpaceRows()).not.toThrow()
    expect(useProject.getState().project.scenes[1].position.y).toBe(60 + ROW_H)
  })
})
