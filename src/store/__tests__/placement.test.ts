// v0.2.5 — new nodes appear next to where the user works; nothing is pushed far away (user report: "node bị di
// chuyển ra xa một cách bất thường"). Each case reproduces a probe of the investigation with its numbers
// (old → new).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSceneFromTake, newScene, nextScene, noteRecentScene, setCanvasViewSource } from '../../actions'
import type { Asset, Project, Scene, Take, XY } from '../../core/types'
import { LAYOUT, newScenePosition, rowHeightOf, undo, useProject, type Box } from '../project'
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
/** Default column: x 420, one row every 248px from y 60. */
const row = (i: number): XY => ({ x: LAYOUT.scenesX, y: LAYOUT.scenesY + i * 248 })
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
    expect(pos(id)).toEqual({ x: 900, y: 300 + 200 + 48 }) // was (420, 308)
    expect(useUI.getState().selectedIds).toEqual([id])
  })

  it('[P1b] far away scene: below it, or in the middle of the view when the canvas shows nothing of the story', () => {
    load([scene('s1', 1, { x: 2400, y: 1600 })])
    expect(newScenePosition(st().project)).toEqual({ x: 2400, y: 1848 }) // was (420, 308): 2364px away
    // The canvas shows (0,0)–(1000,700): nothing in sight → the middle of the view, not a fixed column.
    expect(newScenePosition(st().project, { view: { x: 0, y: 0, w: 1000, h: 700 } })).toEqual({ x: 368, y: 256 })
    // The view shows the scene: below it.
    expect(newScenePosition(st().project, { view: { x: 2000, y: 1200, w: 1000, h: 800 } })).toEqual({ x: 2400, y: 1848 })
  })

  it('[P1c] scenes side by side: below the last one, not 1040px under the row', () => {
    load(Array.from({ length: 5 }, (_, i) => scene('s' + (i + 1), i + 1, { x: 420 + i * 296, y: 60 })))
    expect(pos(newScene())).toEqual({ x: 420 + 4 * 296, y: 308 }) // was (420, 1300)
  })

  it('[P1d] 2-column grid of 8: below the last scene, no empty rows', () => {
    const scenes = Array.from({ length: 8 }, (_, i) => scene('s' + (i + 1), i + 1, { x: i % 2 ? 716 : 420, y: 60 + Math.floor(i / 2) * 248 }))
    load(scenes)
    expect(pos(newScene())).toEqual({ x: 716, y: 804 + 248 }) // was (420, 2044): a 1040px gap
  })

  it('a scene moved so its column half-overlaps the default column: the new card lands next to it, not past that whole column', () => {
    // S01 dragged right by 252px (its column now overlaps x 420–700), the other scenes stay in the default column.
    const scenes = [scene('s1', 1, { x: 672, y: 208 }), ...Array.from({ length: 7 }, (_, i) => scene('s' + (i + 2), i + 2, row(i + 1)))]
    load(scenes)
    noteRecentScene('s1')
    const p = pos(newScene())
    // Was (672, 2040+): slid down past the whole default column. Now within about a row of S01.
    expect(Math.hypot(p.x - 672, p.y - (208 + 200 + 48))).toBeLessThanOrEqual(LAYOUT.sceneW + 48)
    const box = (q: XY) => ({ x: q.x, y: q.y, w: LAYOUT.sceneW, h: 200 })
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
    expect(pos(newScene())).toEqual({ x: 900, y: 548 }) // was (420, 308)
  })

  it('[P1g] an asset node in the way is stepped over, not covered', () => {
    load([scene('s1', 1, row(0))], [asset('a1', { x: 400, y: 300 })])
    // asset box 400..580 × 300..510: the card goes one gap below it
    expect(pos(newScene())).toEqual({ x: 420, y: 510 + 48 }) // was (420, 308), on top of the asset
  })

  it('a video placed by hand and other scenes\' take rows are in the way too', () => {
    // s2 sits left of the column with 3 takes reaching into it (x -500 + 280 + 64 + 3 × 240 − 16 = 548)
    load([scene('s1', 1, row(0)), scene('s2', 2, { x: -500, y: 300 })], [], [take('t1', 's2', 1), take('t2', 's2', 2), take('t3', 's2', 3), take('t4', 's1', 1, { position: { x: 500, y: 600 } })])
    noteRecentScene('s1')
    // below s1 (308) hits s2's take row (300..500); straight down would also hit the dragged video t4 (600..800) and
    // end 540px below — the nearest free spot is just right of the take row, still next to s1
    expect(pos(newScene())).toEqual({ x: 564, y: 308 })
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
    // double-click inside s1 → requested (1152, 912), which overlaps s1 (944..1224 × 839..1039)
    expect(pos(newScene({ x: 1152, y: 912 }))).toEqual({ x: 1152, y: 839 + 200 + 48 })
    // on empty canvas it stays exactly where the user clicked
    expect(pos(newScene({ x: 3000, y: 64 }))).toEqual({ x: 3000, y: 64 })
  })

  it('a double-click beside a long column stays next to the click (was slid 7116px down past every scene)', () => {
    load(Array.from({ length: 30 }, (_, i) => scene('s' + (i + 1), i + 1, row(i))))
    // click 100px left of the column: the requested card (176..456) overlaps the column (420..700) by 36px →
    // moved left just enough (52px), not below the 30th scene at y 7500
    expect(pos(newScene({ x: 176, y: 384 }))).toEqual({ x: 420 - 280 - 16, y: 384 })
    // in the gap between two rows (10 scenes): was y 2540, 1884px down
    load(Array.from({ length: 10 }, (_, i) => scene('s' + (i + 1), i + 1, row(i))))
    expect(pos(newScene({ x: 192, y: 656 }))).toEqual({ x: 124, y: 656 })
  })

  it('a double-click where nothing near is free keeps the clicked spot (never slides along a column)', () => {
    // a dense block of cards (16px apart sideways, 48px apart vertically): no free spot within one row + a gap
    const block: Scene[] = []
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) block.push(scene(`b${i}_${j}`, block.length + 1, { x: i * 296, y: j * 248 }))
    load(block)
    expect(pos(newScene({ x: 150, y: 120 }))).toEqual({ x: 150, y: 120 })
  })

  it('nothing of the story in sight: a free spot inside the view, not 4228px below it past the asset column', () => {
    const assets = Array.from({ length: 23 }, (_, i) => asset('a' + (i + 1), { x: 40, y: 60 + i * 255 }))
    load([scene('s1', 1, { x: 980, y: 380 })], assets)
    const view: Box = { x: -400, y: 1000, w: 1000, h: 700 }
    const at = newScenePosition(st().project, { view })
    expect(at).toEqual({ x: 40 - 280, y: 1248 }) // was (-32, 5928)
    // inside the view, on no asset card
    expect(at.x >= view.x && at.y >= view.y && at.x + 280 <= view.x + view.w && at.y + 200 <= view.y + view.h).toBe(true)
    for (const a of assets) expect(at.x + 280 <= a.position!.x || at.x >= a.position!.x + 180 || at.y + 200 <= a.position!.y || at.y >= a.position!.y + 210).toBe(true)
  })

  it('[P1h] import: one below the other under the scene worked on, not at x 420', () => {
    load([scene('s1', 1, { x: 900, y: 300 })])
    const ids = st().applyImport({ scenes: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] }, { anchorId: 's1' })
    expect(ids.map(pos)).toEqual([
      { x: 900, y: 548 },
      { x: 900, y: 796 },
      { x: 900, y: 1044 },
    ]) // were (420, 308), (420, 556), (420, 804)
  })

  it('first scene of an empty project: the default slot', () => {
    load([])
    expect(pos(newScene())).toEqual(row(0))
  })
})

describe('next scene below its source (N with a scene selected, "Tạo cảnh tiếp nối")', () => {
  it('[P2a] goes right below the source', () => {
    load([scene('s1', 1, { x: 900, y: 300 })])
    useUI.getState().select(['s1'])
    expect(pos(nextScene())).toEqual({ x: 900, y: 548 })
  })

  it('[P2e] a neighbouring column 16px away is not pushed', () => {
    load([scene('s1', 1, { x: 420, y: 60 }), scene('s2', 2, { x: 716, y: 60 }), scene('s3', 3, { x: 420, y: 308 }), scene('s4', 4, { x: 716, y: 308 })])
    const id = st().createNextScene('s1')
    expect(pos(id)).toEqual({ x: 420, y: 308 })
    expect(pos('s3')).toEqual({ x: 420, y: 556 })
    expect(pos('s2')).toEqual({ x: 716, y: 60 })
    expect(pos('s4')).toEqual({ x: 716, y: 308 }) // was pushed to 556
  })

  it('a card 20px left of the source column is not pushed on every N', () => {
    load([scene('s1', 1, { x: 720, y: 256 }), scene('s2', 2, { x: 420, y: 556 })])
    st().createNextScene('s1')
    st().createNextScene('s1')
    expect(pos('s2')).toEqual({ x: 420, y: 556 }) // was 752, then 1000
  })

  it('pushes the cards in the way just enough, keeps the gaps, leaves cards further down alone (one undo step)', () => {
    const scenes = Array.from({ length: 6 }, (_, i) => scene('s' + (i + 1), i + 1, row(i)))
    load([...scenes, scene('s7', 7, { x: 420, y: 2000 })])
    const steps = useProject.temporal.getState().pastStates.length
    const id = st().createNextScene('s1')
    expect(pos(id)).toEqual(row(1))
    expect(['s2', 's3', 's4', 's5', 's6'].map((s) => pos(s).y)).toEqual([556, 804, 1052, 1300, 1548]) // +248 each, no more
    expect(pos('s7')).toEqual({ x: 420, y: 2000 }) // 1548 + 200 + 24 < 2000: not in the way
    expect(useProject.temporal.getState().pastStates.length).toBe(steps + 1)
    undo()
    expect(st().project.scenes.map((s) => s.position)).toEqual([...scenes.map((s) => s.position), { x: 420, y: 2000 }])
  })

  it('[P2b] a tall video dragged away no longer pushes the new card down (was +360)', () => {
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1, { size: { w: 224, h: 560 }, position: { x: 3000, y: 2000 } })])
    expect(rowHeightOf(st().project.scenes[0])).toBe(200)
    expect(pos(st().createNextScene('s1'))).toEqual({ x: 900, y: 548 }) // was 908
  })

  it('[P2c] a tall video hidden by "Chỉ take chọn" no longer counts; shown in the row it still does', () => {
    const takes = [take('t1', 's1', 1, { size: { w: 224, h: 560 } }), take('t2', 's1', 2)]
    load([scene('s1', 1, { x: 900, y: 300 })], [], takes)
    useUI.setState({ takeDisplay: 'chosen' }) // shows t2 only
    expect(pos(st().createNextScene('s1'))).toEqual({ x: 900, y: 548 }) // was 908
    load([scene('s1', 1, { x: 900, y: 300 })], [], takes)
    useUI.setState({ takeDisplay: 'all' })
    expect(pos(st().createNextScene('s1'))).toEqual({ x: 900, y: 300 + 560 + 48 })
  })

  it('a video placed by hand right below the source is stepped over, not covered', () => {
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1, { position: { x: 900, y: 560 } })])
    expect(pos(st().createNextScene('s1'))).toEqual({ x: 900, y: 560 + 200 + 48 })
  })

  it('[P2h] continuation of a video the user moved goes right of that video, not 2000px away below the source', () => {
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1, { position: { x: 2600, y: 1800 } })])
    const id = createSceneFromTake('t1')!
    expect(pos(id)).toEqual({ x: 2600 + 224 + 64, y: 1800 }) // was (900, 548)
    expect(st().project.scenes.find((s) => s.id === id)!.videoRefs).toEqual(['t1'])
    // a video still in its row: below the source as before
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1)])
    expect(pos(createSceneFromTake('t1')!)).toEqual({ x: 900, y: 548 })
  })

  it('continuation of a video only nudged or resized in its row: below the source, not in the lane of the next take', () => {
    // t1's slot is (1244, 300); nudged 32px down it keeps the slot. Right of it (1532, 332) is where the scene's next
    // take t2 goes (1484..1708 × 300..500): the new card would sit under it.
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1, { position: { x: 1244, y: 332 } })])
    expect(pos(createSceneFromTake('t1')!)).toEqual({ x: 900, y: 548 }) // was (1532, 332)
    // resized from its top-left handle (explicit position on its slot), 400px tall: below its row
    load([scene('s1', 1, { x: 900, y: 300 })], [], [take('t1', 's1', 1, { position: { x: 1244, y: 300 }, size: { w: 300, h: 400 } })])
    expect(pos(createSceneFromTake('t1')!)).toEqual({ x: 900, y: 300 + 400 + 48 })
  })

  it('continuation right of a moved video, with nothing free near it: stays right of it (no slide down)', () => {
    // a column of 12 scenes right where the new card would go
    const column = Array.from({ length: 12 }, (_, i) => scene('c' + i, i + 2, { x: 2888, y: 1000 + i * 248 }))
    load([scene('s1', 1, { x: 900, y: 300 }), ...column], [], [take('t1', 's1', 1, { position: { x: 2600, y: 1800 } })])
    const at = pos(createSceneFromTake('t1')!)
    expect(Math.hypot(at.x - 2888, at.y - 1800)).toBeLessThanOrEqual(296)
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
    expect(rows.placed).toEqual([{ x: 3000, y: 2000, w: 224, h: 200 } satisfies Box])
  })
  it('a take only nudged on its slot keeps it', () => {
    // t1's slot is (764, 60): nudged 30px down it still sits there
    const rows = computeTakeRows([take('t1', 's1', 1, { position: { x: 764, y: 90 } }), take('t2', 's1', 2)], [s1], 'all')
    expect(rows.rows.get('s1')).toEqual({ h: 200, w: 64 + 224 + 16 + 224 })
  })
  it('"Chỉ take chọn": hidden takes are nothing', () => {
    const rows = computeTakeRows([take('t1', 's1', 1, { size: { w: 600, h: 560 } }), take('t2', 's1', 2)], [s1], 'chosen')
    expect(rows.rows.get('s1')).toEqual({ h: 200, w: 64 + 224 })
  })
})
