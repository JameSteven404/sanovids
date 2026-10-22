// v0.2.5 — new nodes appear next to where the user works; nothing is pushed far away (user report: "node bị di
// chuyển ra xa một cách bất thường"). Each case reproduces a probe of the investigation with its numbers
// (old → new). 0.6.0: the scene node is 352 × 304 (rows 352 apart, column at x 464) and image tiles 220 × 275 —
// the cases keep their geometry relative to those sizes (LAYOUT), the old literal numbers are in the comments.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSceneFromVideo, newScene, nextScene, noteRecentScene, setCanvasViewSource } from '../../actions'
import type { Asset, Project, Scene, Take, XY } from '../../core/types'
import { LAYOUT, newScenePosition, ROW_H, rowHeightOf, undo, useProject, type Box } from '../project'
import { useRuns } from '../runs'
import { computeTakeRows } from '../takeRows'
import { useUI } from '../ui'

const scene = (id: string, order: number, position: XY, over: Partial<Scene> = {}): Scene => ({
  id,
  order,
  title: '',
  prompt: '',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position,
  note: '',
  ...over,
})

const asset = (id: string, position: XY | null, over: Partial<Asset> = {}): Asset => ({
  id,
  kind: 'character',
  name: id,
  tag: id,
  description: '',
  imageIds: [],
  color: '#fff',
  position,
  ...over,
})

const take = (id: string, sceneId: string, number: number, over: Partial<Take> = {}): Take => ({
  id,
  sceneId,
  number,
  status: 'completed',
  progress: 100,
  createdAt: number,
  startedAt: null,
  finishedAt: null,
  promptSnapshot: '',
  rawPromptSnapshot: '',
  refsSnapshot: [],
  videoRefsSnapshot: [],
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  cost: 1,
  starred: false,
  posterId: null,
  videoId: null,
  error: null,
  position: null,
  ...over,
})

const project = (scenes: Scene[], assets: Asset[] = []): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets,
  scenes,
})

const st = () => useProject.getState()
const pos = (id: string) => st().project.scenes.find((s) => s.id === id)!.position
const load = (scenes: Scene[], assets: Asset[] = [], takes: Take[] = []) => {
  st().loadProject(project(scenes, assets))
  useProject.temporal.getState().clear()
  useRuns.setState({ takes })
}
/** Default column: x 464, one row every 352px (ROW_H) from y 60. */
const row = (i: number): XY => ({ x: LAYOUT.scenesX, y: LAYOUT.scenesY + i * ROW_H })
/** Below a default node at y: its height + one gap. */
const below = (y: number) => y + LAYOUT.sceneH + LAYOUT.gapY
/** Below a source row that holds default-size takes: the row is as tall as its card or its takes (take node bar, XT). */
const belowTakes = (y: number) => y + Math.max(LAYOUT.sceneH, LAYOUT.takeH) + LAYOUT.gapY
/** Side by side: one node width + the 16px snap gap. */
const SIDE = LAYOUT.sceneW + 16
let offView: () => void = () => undefined

beforeEach(() => {
  useUI.setState({ selectedIds: [], selectedEdgeIds: [], takeDisplay: 'all', view: 'canvas' })
  noteRecentScene(null)
  offView = setCanvasViewSource(() => null)
})
afterEach(() => offView())

describe('new scene without a selected scene ("+ Cảnh", N, "Cảnh mới")', () => {
  it('[P1a] goes right below a scene the user moved (was the x 420 column, 480px away)', () => {
    load([scene('s1', 1, { x: 900, y: 300 })])
    const id = newScene()
    expect(pos(id)).toEqual({ x: 900, y: below(300) }) // was (420, 308)
    expect(useUI.getState().selectedIds).toEqual([id])
  })

  it('[P1b] far away scene: below it, or in the middle of the view when the canvas shows nothing of the story', () => {
    load([scene('s1', 1, { x: 2400, y: 1600 })])
    expect(newScenePosition(st().project)).toEqual({ x: 2400, y: below(1600) }) // was (420, 308): 2364px away
    // The canvas shows (0,0)–(1000,700): nothing in sight → the middle of the view (snapped), not a fixed column.
    const mid = (v: number) => Math.round(v / 16) * 16
    expect(newScenePosition(st().project, { view: { x: 0, y: 0, w: 1000, h: 700 } })).toEqual({ x: mid(500 - LAYOUT.sceneW / 2), y: mid(350 - LAYOUT.sceneH / 2) })
    // The view shows the scene: below it.
    expect(newScenePosition(st().project, { view: { x: 2000, y: 1200, w: 1000, h: 800 } })).toEqual({ x: 2400, y: below(1600) })
  })

  it('[P1c] scenes side by side: below the last one, not 1040px under the row', () => {
    load(Array.from({ length: 5 }, (_, i) => scene('s' + (i + 1), i + 1, { x: 420 + i * SIDE, y: 60 })))
    expect(pos(newScene())).toEqual({ x: 420 + 4 * SIDE, y: below(60) }) // was (420, 1300)
  })

  it('[P1d] 2-column grid of 8: below the last scene, no empty rows', () => {
    const scenes = Array.from({ length: 8 }, (_, i) => scene('s' + (i + 1), i + 1, { x: i % 2 ? 420 + SIDE : 420, y: 60 + Math.floor(i / 2) * ROW_H }))
    load(scenes)
    expect(pos(newScene())).toEqual({ x: 420 + SIDE, y: 60 + 4 * ROW_H }) // was (420, 2044): a 1040px gap
  })

  it('a scene moved so its column half-overlaps the default column: the new card lands next to it, not past that whole column', () => {
    // S01 dragged right by 252px (its column now half-overlaps the default one), the other scenes stay in the default column.
    const s1 = { x: LAYOUT.scenesX + 252, y: 208 }
    const scenes = [scene('s1', 1, s1), ...Array.from({ length: 7 }, (_, i) => scene('s' + (i + 2), i + 2, row(i + 1)))]
    load(scenes)
    noteRecentScene('s1')
    const p = pos(newScene())
    // Was (672, 2040+): slid down past the whole default column. Now within about a row of S01.
    expect(Math.hypot(p.x - s1.x, p.y - below(s1.y))).toBeLessThanOrEqual(LAYOUT.sceneW + 48)
    const box = (q: XY) => ({ x: q.x, y: q.y, w: LAYOUT.sceneW, h: LAYOUT.sceneH })
    const hit = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    for (const s of st().project.scenes) if (!(s.position.x === p.x && s.position.y === p.y)) expect(hit(box(p), box(s.position))).toBe(false)
  })

  it('[P1e] after deleting S01–S04 the new scene goes below S05, not far above it', () => {
    load([scene('s5', 1, row(4))])
    expect(pos(newScene())).toEqual(row(5)) // was (420, 308)
  })

  it('[P1f] the scene worked on last stays the anchor while an asset is selected', () => {
    load([scene('s1', 1, { x: 900, y: 300 }), scene('s2', 2, row(0))], [asset('a1', { x: 40, y: 60 })])
    useUI.getState().select(['s1'])
    useUI.getState().select(['a1'])
    expect(pos(newScene())).toEqual({ x: 900, y: below(300) }) // was (420, 308)
  })

  it('[P1g] an asset node in the way is stepped over, not covered', () => {
    load([scene('s1', 1, row(0))], [asset('a1', { x: 400, y: 300 })])
    // tile box 400..620 × 300..575: the node goes one gap below it
    expect(pos(newScene())).toEqual({ x: LAYOUT.scenesX, y: 300 + LAYOUT.assetH + 48 }) // was (420, 308), on top of the asset
  })

  it('a video placed by hand and other scenes\' take rows are in the way too', () => {
    // s2 sits left of the column with 3 takes reaching into it (x -500 + 352 + 64 + 3 × 240 − 16 = 620)
    load([scene('s1', 1, row(0)), scene('s2', 2, { x: -500, y: 300 })], [], [take('t1', 's2', 1), take('t2', 's2', 2), take('t3', 's2', 3), take('t4', 's1', 1, { position: { x: 500, y: 800 } })])
    noteRecentScene('s1')
    // below s1 (412) hits s2's take row (300..500); straight down would also hit the dragged video t4 (800..1000) and
    // end far below — the nearest free spot is just right of the take row, still next to s1
    expect(pos(newScene())).toEqual({ x: 620 + 16, y: below(60) })
  })

  it('with the canvas showing another area: below the lowest scene in sight', () => {
    load([scene('s1', 1, row(0)), scene('s2', 2, row(1)), scene('s3', 3, { x: 2000, y: 2000 })])
    noteRecentScene('s3')
    offView()
    offView = setCanvasViewSource(() => ({ x: 0, y: 0, w: 1200, h: 800 }))
    expect(pos(newScene())).toEqual(row(2))
  })

  it('a double-click on a card puts the new one just below it, not over it', () => {
    load([scene('s1', 1, { x: 944, y: 839 })])
    // double-click inside s1 → requested (1152, 912), which overlaps s1 (944..1296 × 839..1143)
    expect(pos(newScene({ x: 1152, y: 912 }))).toEqual({ x: 1152, y: below(839) })
    // on empty canvas it stays exactly where the user clicked
    expect(pos(newScene({ x: 3000, y: 64 }))).toEqual({ x: 3000, y: 64 })
  })

  it('a double-click beside a long column stays next to the click (was slid 7116px down past every scene)', () => {
    load(Array.from({ length: 30 }, (_, i) => scene('s' + (i + 1), i + 1, row(i))))
    // click left of the column: the requested node (176..528) overlaps the column (464..816) → moved left just
    // enough (one node + 16px left of the column), not below the 30th scene thousands of px down
    expect(pos(newScene({ x: 176, y: 384 }))).toEqual({ x: LAYOUT.scenesX - LAYOUT.sceneW - 16, y: 384 })
    // between two rows (10 scenes): was y 2540, 1884px down
    load(Array.from({ length: 10 }, (_, i) => scene('s' + (i + 1), i + 1, row(i))))
    expect(pos(newScene({ x: 192, y: 656 }))).toEqual({ x: LAYOUT.scenesX - LAYOUT.sceneW - 16, y: 656 })
  })

  it('a double-click where nothing near is free keeps the clicked spot (never slides along a column)', () => {
    // a dense block of cards (16px apart sideways, 48px apart vertically): no free spot within one row + a gap
    const block: Scene[] = []
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) block.push(scene(`b${i}_${j}`, block.length + 1, { x: i * SIDE, y: j * ROW_H }))
    load(block)
    expect(pos(newScene({ x: 150, y: 120 }))).toEqual({ x: 150, y: 120 })
  })

  it('nothing of the story in sight: a free spot inside the view, not 4228px below it past the asset column', () => {
    const assets = Array.from({ length: 23 }, (_, i) => asset('a' + (i + 1), { x: 40, y: 60 + i * 255 }))
    load([scene('s1', 1, { x: 980, y: 380 })], assets)
    const view: Box = { x: -400, y: 1000, w: 1000, h: 700 }
    const at = newScenePosition(st().project, { view })
    // the free grid spot (16px) nearest the view's middle: just left of the tiles (x 40), at the middle's height
    expect(at).toEqual({ x: Math.floor((40 - LAYOUT.sceneW) / 16) * 16, y: Math.round((1350 - LAYOUT.sceneH / 2) / 16) * 16 }) // was (-32, 5928)
    // inside the view, on no asset card
    expect(at.x >= view.x && at.y >= view.y && at.x + LAYOUT.sceneW <= view.x + view.w && at.y + LAYOUT.sceneH <= view.y + view.h).toBe(true)
    for (const a of assets) expect(at.x + LAYOUT.sceneW <= a.position!.x || at.x >= a.position!.x + LAYOUT.assetW || at.y + LAYOUT.sceneH <= a.position!.y || at.y >= a.position!.y + LAYOUT.assetH).toBe(true)
  })

  it('[P1h] import: one below the other under the scene worked on, not at x 420', () => {
    load([scene('s1', 1, { x: 900, y: 300 })])
    const ids = st().applyImport({ scenes: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] }, { anchorId: 's1' })
    expect(ids.map(pos)).toEqual([
      { x: 900, y: 300 + ROW_H },
      { x: 900, y: 300 + 2 * ROW_H },
      { x: 900, y: 300 + 3 * ROW_H },
    ]) // were (420, 308), (420, 556), (420, 804)
  })

  it('first scene of an empty project: the default slot', () => {
    load([])
    expect(pos(newScene())).toEqual(row(0))
  })
})

describe('next scene below its source (N with a scene selected, "Tạo cảnh tiếp theo từ video này")', () => {
  it('[P2a] goes right below the source', () => {
    load([scene('s1', 1, { x: 900, y: 300 })])
    useUI.getState().select(['s1'])
    expect(pos(nextScene())).toEqual({ x: 900, y: below(300) })
  })

  it('[P2e] a neighbouring column 16px away is not pushed', () => {
    const R = 420 + SIDE
    load([scene('s1', 1, { x: 420, y: 60 }), scene('s2', 2, { x: R, y: 60 }), scene('s3', 3, { x: 420, y: 60 + ROW_H }), scene('s4', 4, { x: R, y: 60 + ROW_H })])
    const id = st().createNextScene('s1')
    expect(pos(id)).toEqual({ x: 420, y: 60 + ROW_H })
    expect(pos('s3')).toEqual({ x: 420, y: 60 + 2 * ROW_H })
    expect(pos('s2')).toEqual({ x: R, y: 60 })
    expect(pos('s4')).toEqual({ x: R, y: 60 + ROW_H }) // was pushed down
  })

  it('a card 20px left of the source column is not pushed on every N', () => {
    const left = 720 - LAYOUT.sceneW - 20
    load([scene('s1', 1, { x: 720, y: 256 }), scene('s2', 2, { x: left, y: 556 })])
    st().createNextScene('s1')
    st().createNextScene('s1')
    expect(pos('s2')).toEqual({ x: left, y: 556 }) // was 752, then 1000
  })

  it('pushes the cards in the way just enough, keeps the gaps, leaves cards further down alone (one undo step)', () => {
    const scenes = Array.from({ length: 6 }, (_, i) => scene('s' + (i + 1), i + 1, row(i)))
    const far = { x: 420, y: 3000 }
    load([...scenes, scene('s7', 7, far)])
    const steps = useProject.temporal.getState().pastStates.length
    const id = st().createNextScene('s1')
    expect(pos(id)).toEqual(row(1))
    expect(['s2', 's3', 's4', 's5', 's6'].map((s) => pos(s).y)).toEqual([2, 3, 4, 5, 6].map((i) => row(i).y)) // one row each, no more
    expect(pos('s7')).toEqual(far) // s6 now ends at row(6) + 304 + 24 < 3000: not in the way
    expect(useProject.temporal.getState().pastStates.length).toBe(steps + 1)
    undo()
    expect(st().project.scenes.map((s) => s.position)).toEqual([...scenes.map((s) => s.position), far])
  })

  it('[P2b] a tall video dragged away no longer pushes the new card down (was +360)', () => {
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1, { size: { w: 224, h: 560 }, position: { x: 3000, y: 2000 } })])
    expect(rowHeightOf(st().project.scenes[0])).toBe(LAYOUT.sceneH)
    expect(pos(st().createNextScene('s1'))).toEqual({ x: 900, y: below(300) }) // was 908
  })

  it('[P2c] a tall video hidden by "Chỉ take chọn" no longer counts; shown in the row it still does', () => {
    const takes = [take('t1', 's1', 1, { size: { w: 224, h: 560 } }), take('t2', 's1', 2)]
    load([scene('s1', 1, { x: 900, y: 300 })], [], takes)
    useUI.setState({ takeDisplay: 'chosen' }) // shows t2 only
    expect(pos(st().createNextScene('s1'))).toEqual({ x: 900, y: belowTakes(300) }) // was 908
    load([scene('s1', 1, { x: 900, y: 300 })], [], takes)
    useUI.setState({ takeDisplay: 'all' })
    expect(pos(st().createNextScene('s1'))).toEqual({ x: 900, y: 300 + 560 + 48 })
  })

  it('a video placed by hand right below the source is stepped over, not covered', () => {
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1, { position: { x: 900, y: 560 } })])
    expect(pos(st().createNextScene('s1'))).toEqual({ x: 900, y: 560 + LAYOUT.takeH + LAYOUT.gapY })
  })

  it('[P2h] continuation of a video the user moved goes right of that video, not 2000px away below the source', () => {
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1, { position: { x: 2600, y: 1800 } })])
    const id = createSceneFromVideo('t1')!
    expect(pos(id)).toEqual({ x: 2600 + 224 + 64, y: 1800 }) // was (900, 548)
    // reference videos were retired: never a @video link, an empty prompt
    expect(st().project.scenes.find((s) => s.id === id)!.videoRefs).toEqual([])
    expect(st().project.scenes.find((s) => s.id === id)!.prompt).toBe('')
    // a video still in its row: below the source as before
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1)])
    expect(pos(createSceneFromVideo('t1')!)).toEqual({ x: 900, y: belowTakes(300) })
  })

  it('continuation of a video only nudged or resized in its row: below the source, not in the lane of the next take', () => {
    // t1's slot is (900 + 352 + 64, 300) = (1316, 300); nudged 32px down it keeps the slot. Right of it is where the
    // scene's next take t2 goes: the new card would sit under it.
    const slot = 900 + LAYOUT.sceneW + LAYOUT.takeOffsetX
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1, { position: { x: slot, y: 332 } })])
    expect(pos(createSceneFromVideo('t1')!)).toEqual({ x: 900, y: belowTakes(300) }) // was (1532, 332)
    // resized from its top-left handle (explicit position on its slot), 400px tall: below its row
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1, { position: { x: slot, y: 300 }, size: { w: 300, h: 400 } })])
    expect(pos(createSceneFromVideo('t1')!)).toEqual({ x: 900, y: 300 + 400 + 48 })
  })

  it('continuation right of a moved video, with nothing free near it: stays right of it (no slide down)', () => {
    // a column of 12 scenes right where the new card would go
    const column = Array.from({ length: 12 }, (_, i) => scene('c' + i, i + 2, { x: 2888, y: 1000 + i * ROW_H }))
    load([scene('s1', 1, { x: 900, y: 300 }), ...column], [], [take('t1', 's1', 1, { position: { x: 2600, y: 1800 } })])
    const at = pos(createSceneFromVideo('t1')!)
    expect(Math.hypot(at.x - 2888, at.y - 1800)).toBeLessThanOrEqual(SIDE)
  })
})

describe('take rows (what counts in a scene row)', () => {
  const s1 = scene('s1', 1, { x: 420, y: 60 })
  it('only takes in the row count: dragged-away ones are separate boxes', () => {
    const rows = computeTakeRows(
      [take('t1', 's1', 1), take('t2', 's1', 2, { position: { x: 3000, y: 2000 } }), take('t3', 's1', 3, { size: { w: 300, h: 400 } })],
      [s1],
      'all',
    )
    expect(rows.rows.get('s1')).toEqual({ h: 400, w: 64 + 224 + 16 + 300 })
    expect(rows.placed).toEqual([{ x: 3000, y: 2000, w: 224, h: LAYOUT.takeH } satisfies Box])
  })
  it('a take only nudged on its slot keeps it', () => {
    // t1's slot is (420 + 352 + 64, 60): nudged 30px down it still sits there
    const rows = computeTakeRows([take('t1', 's1', 1, { position: { x: 420 + LAYOUT.sceneW + LAYOUT.takeOffsetX, y: 90 } }), take('t2', 's1', 2)], [s1], 'all')
    expect(rows.rows.get('s1')).toEqual({ h: LAYOUT.takeH, w: 64 + 224 + 16 + 224 })
  })
  it('an old stored card size (below the 0.6.0 minimum) counts as the width the node is drawn at (352)', () => {
    // After "Hoàn tác" of the one-time row spacing the 280 × 200 sizes come back; the canvas draws them as the default
    // node, so the row's slots start at x + 352 + 64 — a take nudged 160px right of that slot still keeps it.
    const old = scene('s1', 1, { x: 420, y: 60 }, { size: { w: 280, h: 200 } })
    const slot = 420 + LAYOUT.sceneW + LAYOUT.takeOffsetX
    const rows = computeTakeRows([take('t1', 's1', 1, { position: { x: slot + 160, y: 60 } })], [old], 'all')
    expect(rows.offRow.has('t1')).toBe(false)
    expect(rows.rows.get('s1')).toEqual({ h: LAYOUT.takeH, w: 64 + 224 })
  })
  it('"Chỉ take chọn": hidden takes are nothing', () => {
    const rows = computeTakeRows([take('t1', 's1', 1, { size: { w: 600, h: 560 } }), take('t2', 's1', 2)], [s1], 'chosen')
    expect(rows.rows.get('s1')).toEqual({ h: LAYOUT.takeH, w: 64 + 224 })
  })
})
