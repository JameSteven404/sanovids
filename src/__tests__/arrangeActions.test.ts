import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { arrangeCanvas, arrangeTakesKey, autoLayoutCanvas, buildArrangeInput, useArrangeMenu } from '../arrangeActions'
import { REVEALED_OVERLAP } from '../components/canvas/arrangeModel'
import { assetNodeHeight, autoTakePosition, layoutRowHeights, layoutTakes, measuredOf, takeSlots, useCanvasLocal } from '../components/canvas/canvasModel'
import { LEGACY_ROWS, overlaps, type Box } from '../core/arrange'
import type { Project, Scene, Take, XY } from '../core/types'
import { useArrangePrefs } from '../lib/arrangePrefs'
import { drawnSceneSize, emptyProject, LAYOUT, NODE_SIZE, redo, undo, useProject } from '../store/project'
import { useRuns } from '../store/runs'
import { useUI } from '../store/ui'

let sceneIds: string[] = []
const take = (id: string, sceneId = sceneIds[0], number = 1, extra: Partial<Take> = {}): Take => ({
  id, sceneId, number, status: 'completed', progress: 100, createdAt: number, startedAt: null, finishedAt: null,
  promptSnapshot: '', rawPromptSnapshot: '', refsSnapshot: [], videoRefsSnapshot: [], settings: useProject.getState().project.presets[0],
  cost: 1, starred: false, posterId: null, videoId: null, error: null, position: { x: 9000, y: 9000 }, ...extra,
})
const project = () => useProject.getState().project
const takePos = (id = 't') => useRuns.getState().takes.find((t) => t.id === id)?.position
const depth = () => useProject.temporal.getState().pastStates.length
/** mulberry32: seeded, so a failing random case replays. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const nodePositions = (p: Project): Record<string, XY | null> =>
  Object.fromEntries([...p.scenes, ...p.assets, ...(p.folders ?? [])].map((n) => [n.id, n.position]))
const cardBox = (s: Scene): Box => ({ ...s.position, w: drawnSceneSize(s.size)?.w ?? LAYOUT.sceneW, h: drawnSceneSize(s.size)?.h ?? LAYOUT.sceneH })

beforeEach(() => {
  vi.useFakeTimers()
  useProject.setState({ project: emptyProject() })
  useRuns.setState({ takes: [] })
  useUI.setState({ selectedIds: [], takeDisplay: 'all', toasts: [] })
  useCanvasLocal.setState({ measured: {} })
  useArrangePrefs.getState().reset()
  sceneIds = Array.from({ length: 4 }, (_, i) => useProject.getState().addScene({ position: { x: i * 31, y: i * 29 } }))
  useRuns.setState({ takes: [take('t')] })
  useProject.temporal.getState().clear()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); useProject.temporal.getState().clear() })

describe('arrange command history', () => {
  it('commits one project and at most one runs update; no-op keeps object identity and adds no step', () => {
    const p = vi.fn(), r = vi.fn(), stopP = useProject.subscribe(p), stopR = useRuns.subscribe(r)
    try {
      autoLayoutCanvas()
      expect(p).toHaveBeenCalledTimes(1); expect(r).toHaveBeenCalledTimes(1); expect(depth()).toBe(1)
      // The 0.5 sentence, kept word for word.
      expect(useUI.getState().toasts.at(-1)?.text).toBe('Đã sắp xếp lại canvas (1 video về cạnh cảnh của nó).')
      const arranged = project()
      autoLayoutCanvas()
      expect(project()).toBe(arranged); expect(depth()).toBe(1)
      expect(useUI.getState().toasts.at(-1)).toMatchObject({ text: 'Canvas đã gọn sẵn.' })
      expect(useUI.getState().toasts.at(-1)?.action).toBeUndefined()
      undo(); expect(takePos()).toEqual({ x: 9000, y: 9000 })
      redo(); expect(takePos()).toBeNull()
    } finally { stopP(); stopR() }
  })
  it('two arrangements undo and redo scenes, manual takes and display independently, even in one millisecond', () => {
    const initial = project()
    arrangeCanvas({ style: 'grid', video: 'chosen', gridCols: 2 })
    const grid = project()
    useRuns.getState().setTakePositions({ t: { x: 5000, y: 6000 } })
    arrangeCanvas({ style: 'strip', video: 'chosen' })
    const strip = project()
    expect(depth()).toBe(2)
    undo(); expect(project()).toBe(grid); expect(takePos()).toEqual({ x: 5000, y: 6000 })
    // A later manual move is deliberately retained when it differs from the older record's target.
    useRuns.getState().setTakePositions({ t: null })
    undo(); expect(project()).toBe(initial); expect(takePos()).toEqual({ x: 9000, y: 9000 }); expect(useUI.getState().takeDisplay).toBe('all')
    redo(); expect(project()).toBe(grid); expect(takePos()).toBeNull(); expect(useUI.getState().takeDisplay).toBe('chosen')
    useRuns.getState().setTakePositions({ t: { x: 5000, y: 6000 } })
    redo(); expect(project()).toBe(strip); expect(takePos()).toBeNull()
  })
  it('only take/display changes still make exactly one reversible step', () => {
    autoLayoutCanvas(); useProject.temporal.getState().clear()
    useRuns.getState().setTakePositions({ t: { x: 2000, y: 3000 } })
    const res = arrangeCanvas({ video: 'chosen' })
    expect(res.positions).toEqual({}); expect(depth()).toBe(1)
    undo(); expect(takePos()).toEqual({ x: 2000, y: 3000 }); expect(useUI.getState().takeDisplay).toBe('all')
    redo(); expect(takePos()).toBeNull(); expect(useUI.getState().takeDisplay).toBe('chosen')
  })
  it('does not overwrite a later manual take move or display choice', () => {
    arrangeCanvas({ style: 'grid', video: 'chosen' })
    useRuns.getState().setTakePositions({ t: { x: 1, y: 2 } })
    useUI.getState().setTakeDisplay('all')
    undo(); expect(takePos()).toEqual({ x: 1, y: 2 }); expect(useUI.getState().takeDisplay).toBe('all')
  })
  it('a discarded branch, cleared history or another project never replays stale take records', () => {
    autoLayoutCanvas(); undo()
    useRuns.getState().setTakePositions({ t: null })
    useProject.getState().setPositions({ [sceneIds[0]]: { x: LAYOUT.scenesX, y: LAYOUT.scenesY } })
    undo(); redo(); expect(takePos()).toBeNull()
    useProject.temporal.getState().clear()
    useProject.setState({ project: { ...project(), id: 'another' } })
    useProject.getState().setPositions({ [sceneIds[0]]: { x: 1, y: 2 } })
    undo(); expect(takePos()).toBeNull()
  })
  it('legacy entry point ignores preferences and preserves chosen display while measuring hidden takes', () => {
    useArrangePrefs.getState().set({ style: 'strip', spacing: 'roomy' })
    useUI.setState({ takeDisplay: 'chosen' })
    useRuns.setState({ takes: [take('tall', sceneIds[0], 1, { size: { w: 224, h: 560 } }), take('chosen', sceneIds[0], 2)] })
    autoLayoutCanvas()
    expect(project().scenes[1].position).toEqual({ x: LAYOUT.scenesX, y: LAYOUT.scenesY + 560 + LAYOUT.gapY })
    expect(useUI.getState().takeDisplay).toBe('chosen')
  })
  it('survives non-undoable folder changes and take deletion rewriting every history snapshot', () => {
    const folderId = useProject.getState().addFolder({ name: 'Test', path: null, position: { x: -1000, y: -1000 }, takes: ['deleted'] })
    useRuns.setState({ takes: [take('t'), take('deleted', sceneIds[1])] })
    useProject.temporal.getState().clear()
    arrangeCanvas({ style: 'grid', video: 'chosen' })
    arrangeCanvas({ style: 'strip', video: 'chosen' })
    useProject.getState().setFolderPlace(folderId, { name: 'Renamed', path: null })
    useRuns.getState().removeTakes(['deleted'])
    expect(depth()).toBe(2)
    undo(); undo()
    expect(takePos()).toEqual({ x: 9000, y: 9000 })
    expect(takePos('deleted')).toBeUndefined()
    expect(project().folders?.[0].name).toBe('Renamed')
    expect(project().folders?.[0].takes ?? []).not.toContain('deleted')
    redo(); redo(); expect(takePos()).toBeNull()
  })
  it('keeps take restoration aligned when the project history reaches its 200-step limit', () => {
    for (let i = 0; i < 200; i++) useProject.getState().setPositions({ [sceneIds[0]]: { x: i, y: i } })
    arrangeCanvas({ style: 'grid', video: 'chosen' })
    expect(depth()).toBe(200)
    useProject.getState().setPositions({ [sceneIds[0]]: { x: 777, y: 888 } })
    undo(); expect(takePos()).toBeNull()
    undo(); expect(takePos()).toEqual({ x: 9000, y: 9000 })
    redo(); expect(takePos()).toBeNull()
  })
  it('selection arranges only selected scenes and their takes, ignores selected takes alone', () => {
    const initial = project()
    useUI.setState({ selectedIds: [sceneIds[1], sceneIds[2], 't'] })
    const res = arrangeCanvas({ style: 'grid', video: 'chosen', scope: 'selection' })
    expect(useUI.getState().toasts.at(-1)?.text).toMatch(/^Đã sắp xếp 2 cảnh đang chọn\. Đã bật “Chỉ take chọn” \(mọi dự án\)/)
    expect(project().scenes[0]).toBe(initial.scenes[0]); expect(project().scenes[3]).toBe(initial.scenes[3])
    expect(takePos()).toEqual({ x: 9000, y: 9000 })
    expect(res.fitIds).not.toContain('t')
  })
  it('uses actual scene sizes and measured tall takes, excludes takes of deleted scenes', () => {
    useCanvasLocal.setState({ measured: { t: { width: 224, height: 450 } } })
    useRuns.setState({ takes: [take('t'), take('orphan', 'missing')] })
    const i = buildArrangeInput(LEGACY_ROWS)
    expect(i.clusters[0].rowH).toBe(450)
    expect(i.clusters[0].cardW).toBe(LAYOUT.sceneW)
    expect(i.takes.map((t) => t.id)).toEqual(['t'])
  })
  it('shows one overlap notice after revealing hidden takes; undo itself shows none', () => {
    arrangeCanvas({ style: 'grid', video: 'chosen' })
    useUI.setState({ toasts: [] })
    useUI.getState().setTakeDisplay('all')
    expect(useUI.getState().toasts.at(-1)?.text).toContain('Video ẩn đã hiện lại')
    useUI.getState().setTakeDisplay('chosen'); useUI.getState().setTakeDisplay('all')
    expect(useUI.getState().toasts).toHaveLength(1)
    arrangeCanvas({ style: 'strip', video: 'chosen' })
    useUI.setState({ toasts: [] }); undo()
    expect(useUI.getState().toasts).toHaveLength(0)
  })
  it('an unrelated undo keeps the reminders of the last arrange; undoing the arrange ends them, redoing it brings them back', () => {
    arrangeCanvas({ style: 'grid', video: 'chosen' })
    useProject.getState().setPositions({ [sceneIds[0]]: { x: -5000, y: -5000 } })
    undo()
    useUI.setState({ toasts: [] })
    useUI.getState().setTakeDisplay('all')
    expect(useUI.getState().toasts.map((t) => t.text)).toEqual([REVEALED_OVERLAP])
    // Undo the arrange itself: it shows the hidden videos again without announcing them; a redo arms the reminder again.
    useUI.getState().setTakeDisplay('chosen')
    undo(); expect(useUI.getState().takeDisplay).toBe('all')
    redo(); expect(useUI.getState().takeDisplay).toBe('chosen')
    useUI.setState({ toasts: [] })
    useUI.getState().setTakeDisplay('all')
    expect(useUI.getState().toasts.map((t) => t.text)).toEqual([REVEALED_OVERLAP])
  })
  it('Theo hàng with "Chỉ take chọn" still keeps room for the takes it hides', () => {
    useRuns.setState({ takes: [take('tall', sceneIds[0], 1, { size: { w: 224, h: 560 } }), take('star', sceneIds[0], 2, { starred: true })] })
    arrangeCanvas({ style: 'rows', video: 'chosen' })
    expect(useUI.getState().takeDisplay).toBe('chosen')
    expect(project().scenes.find((s) => s.id === sceneIds[1])!.position).toEqual({ x: LAYOUT.scenesX, y: LAYOUT.scenesY + 560 + LAYOUT.gapY })
  })
  it('the popover closes when a dialog opens, the view changes or another project is opened', () => {
    useArrangeMenu.getState().toggle(); expect(useArrangeMenu.getState().open).toBe(true)
    useUI.getState().openDialog({ kind: 'shortcuts' }); expect(useArrangeMenu.getState().open).toBe(false)
    useUI.getState().closeDialog()
    useArrangeMenu.getState().toggle()
    useUI.setState({ view: 'storyboard' }); expect(useArrangeMenu.getState().open).toBe(false)
    useUI.setState({ view: 'canvas' })
    useArrangeMenu.getState().toggle()
    useProject.setState({ project: emptyProject() }); expect(useArrangeMenu.getState().open).toBe(false)
  })
  it('the preview key ignores progress ticks but follows what moves the layout', () => {
    const takes = useRuns.getState().takes, key = arrangeTakesKey(takes)
    expect(arrangeTakesKey(takes.map((t) => ({ ...t, progress: 42, status: 'processing' as const })))).not.toBe(key)
    expect(arrangeTakesKey(takes.map((t) => ({ ...t, progress: 42 })))).toBe(key)
    expect(arrangeTakesKey(takes.map((t) => ({ ...t, position: null })))).not.toBe(key)
    expect(arrangeTakesKey(takes.map((t) => ({ ...t, size: { w: 300, h: 300 } })))).not.toBe(key)
    expect(arrangeTakesKey(takes.map((t) => ({ ...t, starred: true })))).not.toBe(key)
  })
  it('LEGACY_ROWS puts scenes and images exactly where the 0.5 store autoLayout does, on random projects (seeded)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = seeded(seed), int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1))
      useProject.setState({ project: emptyProject() })
      useRuns.setState({ takes: [] })
      const measured: Record<string, { width: number; height: number }> = {}
      const ids = Array.from({ length: int(1, 12) }, () => useProject.getState().addScene({ position: { x: int(-3000, 3000), y: int(-3000, 3000) } }))
      const order = ids.map((_, i) => i + 1).sort(() => r() - 0.5)
      useProject.setState((st) => ({ project: { ...st.project, scenes: st.project.scenes.map((sc, i) => ({ ...sc, order: order[i] })) } }))
      const takes: Take[] = []
      for (const id of ids) {
        // Stored size (resized card), or none: then sometimes a measured height (fractional, as the browser reports it).
        if (r() < 0.3) useProject.getState().setNodeSizes({ [id]: { w: int(NODE_SIZE.scene.minW, NODE_SIZE.scene.maxW), h: int(NODE_SIZE.scene.minH, NODE_SIZE.scene.maxH) } })
        else if (r() < 0.5) measured[id] = { width: LAYOUT.sceneW, height: int(200, 700) + 0.4 }
        for (let n = int(0, 3); n > 0; n--) {
          const tid = `${id}:${n}`
          const size = r() < 0.3 ? { w: int(NODE_SIZE.take.minW, NODE_SIZE.take.maxW), h: int(NODE_SIZE.take.minH, NODE_SIZE.take.maxH) } : null
          if (!size && r() < 0.4) measured[tid] = { width: LAYOUT.takeW, height: int(180, 560) + 0.6 }
          takes.push(take(tid, id, n, { size, position: r() < 0.4 ? { x: int(-3000, 3000), y: int(-3000, 3000) } : null, starred: r() < 0.2 }))
        }
      }
      // Images narrow enough not to reach the scene column (wider ones are what the engine fixes), a folder far away.
      for (let n = int(0, 5); n > 0; n--) {
        useProject.getState().addAsset({ name: `Ảnh ${n}`, position: { x: int(-2000, 2000), y: int(-2000, 2000) }, size: r() < 0.5 ? { w: int(NODE_SIZE.asset.minW, 376), h: int(NODE_SIZE.asset.minH, NODE_SIZE.asset.maxH) } : null })
      }
      if (r() < 0.5) useProject.getState().addFolder({ name: 'Xa', path: null, position: { x: -9000, y: -9000 } })
      useRuns.setState({ takes })
      useCanvasLocal.setState({ measured })
      const start = project()
      autoLayoutCanvas()
      const got = nodePositions(project()), gotTakes = useRuns.getState().takes.map((t) => t.position)
      // The 0.5 command: row heights from layoutRowHeights over every take, image heights from assetNodeHeight.
      useProject.setState({ project: start })
      useRuns.setState({ takes })
      const measuredH = (id: string) => measuredOf(id)?.height
      const heights = layoutRowHeights(start.scenes, layoutTakes(takes, start.scenes, 'all'), measuredH)
      for (const a of start.assets) if (a.position) heights[a.id] = assetNodeHeight(a, measuredH(a.id))
      useProject.getState().autoLayout(heights)
      expect(got, `seed ${seed}`).toEqual(nodePositions(project()))
      expect(gotTakes, `seed ${seed}`).toEqual(takes.map(() => null))
    }
  })
  it.each(['all', 'chosen'] as const)('after a Lưới arrange in "%s" display, one new video per scene never covers another scene', (video) => {
    const r = seeded(video === 'all' ? 7 : 11), int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1))
    useRuns.setState({ takes: [] })
    for (let i = 0; i < 8; i++) sceneIds.push(useProject.getState().addScene({ position: { x: int(-2000, 2000), y: int(-2000, 2000) } }))
    const takes: Take[] = []
    for (const id of sceneIds) {
      if (r() < 0.3) useProject.getState().setNodeSizes({ [id]: { w: int(NODE_SIZE.scene.minW, NODE_SIZE.scene.maxW), h: int(NODE_SIZE.scene.minH, NODE_SIZE.scene.maxH) } })
      // 0–2 finished takes (some starred, some resized): scenes without videos too, a new video lands on their first slot.
      for (let n = int(0, 2); n > 0; n--) takes.push(take(`${id}:${n}`, id, n, { starred: r() < 0.3, size: r() < 0.3 ? { w: int(180, 400), h: int(180, 400) } : null }))
    }
    useRuns.setState({ takes })
    arrangeCanvas({ style: 'grid', video, gridCols: 'auto' })
    const mode = useUI.getState().takeDisplay
    expect(mode).toBe(video)
    const p = project()
    useRuns.setState({ takes: [...useRuns.getState().takes, ...p.scenes.map((s, i) => take(`new${i}`, s.id, 9, { status: 'processing', position: null }))] })
    const all = useRuns.getState().takes, byId = new Map(all.map((t) => [t.id, t])), scenes = new Map(p.scenes.map((s) => [s.id, s]))
    // Drawn exactly as the canvas does: layoutTakes for the display, takeSlots, autoTakePosition.
    const layout = layoutTakes(all, p.scenes, mode)
    const slots = takeSlots(layout.items, (id) => byId.get(id)?.size?.w ?? LAYOUT.takeW)
    const drawn = layout.items.map((item) => {
      const s = scenes.get(item.anchorId)!, t = byId.get(item.id)!
      const at = item.explicit ?? autoTakePosition(s.position, drawnSceneSize(s.size)?.w ?? LAYOUT.sceneW, slots.get(item.id)!)
      return { id: item.id, sceneId: s.id, box: { ...at, w: t.size?.w ?? LAYOUT.takeW, h: t.size?.h ?? LAYOUT.takeH } }
    })
    expect(drawn.filter((d) => d.id.startsWith('new')).length).toBeGreaterThan(0)
    for (const d of drawn) {
      for (const s of p.scenes) if (s.id !== d.sceneId && overlaps(d.box, cardBox(s))) expect.fail(`${d.id} covers the card of ${s.id}`)
      for (const o of drawn) if (o.sceneId !== d.sceneId && overlaps(d.box, o.box)) expect.fail(`${d.id} covers ${o.id}`)
    }
  })
  it('warns once when videos outgrow the reserved slot in an all-takes grid', () => {
    useRuns.setState({ takes: [] })
    arrangeCanvas({ style: 'grid', video: 'all', gridCols: 2 })
    useUI.setState({ toasts: [] })
    useRuns.setState({ takes: [take('one', sceneIds[0], 1, { position: null })] })
    expect(useUI.getState().toasts).toHaveLength(0)
    useRuns.setState({ takes: [...useRuns.getState().takes, take('two', sceneIds[0], 2, { position: null })] })
    expect(useUI.getState().toasts.at(-1)?.text).toContain('Video mới của S01 đè lên cảnh bên cạnh.')
    useRuns.setState({ takes: [...useRuns.getState().takes, take('three', sceneIds[0], 3, { position: null })] })
    expect(useUI.getState().toasts).toHaveLength(1)
  })
})
