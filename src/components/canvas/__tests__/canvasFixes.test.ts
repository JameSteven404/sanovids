// Canvas bug fixes (round 4): selection mirror, auto layout rows + take-position undo, toolbar density, theming
// helpers, drop blockers, inline title save on Ctrl+S.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project, Scene, Take } from '../../../core/types'
import { LAYOUT, redo, undo, useProject } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import { useUI } from '../../../store/ui'
import {
  useCanvasLocal,
  DROP_BLOCKERS,
  inlineEditSavesDraft,
  inlineKeySavesDraft,
  layoutRowHeights,
  livePosition,
  autoTakePosition,
  measuredOf,
  layoutTakes,
  MINIMAP_LIFT_W,
  selectionSeed,
  toolbarDensity,
  toolbarInsets,
  visibleFlowRect,
  revealViewport,
  withAlpha,
} from '../canvasModel'
import { readFileSync } from 'node:fs'
import { autoLayoutCanvas } from '../CanvasToolbar'

const scene = (id: string, order: number, over: Partial<Scene> = {}): Scene => ({
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
  position: { x: 0, y: 0 },
  note: '',
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

describe('selectionSeed', () => {
  const onCanvas = (id: string) => id !== 'hidden'
  it('a replacing selection (plain click, box) keeps only ids that have a canvas node', () => {
    expect(selectionSeed(['hidden', 's1', 't1'], true, onCanvas)).toEqual(['s1', 't1'])
  })
  it('an additive one (Ctrl / Shift+click) keeps everything', () => {
    expect(selectionSeed(['hidden', 's1'], false, onCanvas)).toEqual(['hidden', 's1'])
  })
})

describe('live canvas placement', () => {
  it('keeps stored identity at rest, follows dragging, and accounts for the left/top resize position', () => {
    const base = { x: 200, y: 100 }
    expect(livePosition('s', base, {}, {})).toBe(base)
    const drag = { s: { x: 300, y: 200 } }
    expect(livePosition('s', base, drag, {})).toBe(drag.s)
    const resizing = { s: { x: 100, y: 80, w: 380, h: 260 } }
    const position = livePosition('s', base, drag, resizing)
    expect(position).toEqual({ x: 100, y: 80 })
    expect(autoTakePosition(position, resizing.s.w, 240)).toEqual({ x: 100 + 380 + 240 + LAYOUT.takeOffsetX, y: 80 })
    expect(livePosition('s', base, {}, { s: { w: 380, h: 260 } })).toBe(base)
    // A take dragged independently overrides its automatic slot.
    expect(livePosition('t', autoTakePosition(base, 280, 0), { t: { x: 900, y: 400 } }, {})).toEqual({ x: 900, y: 400 })
  })
})

describe('layoutRowHeights', () => {
  it('per scene: the tallest of its card and the takes shown in its row (stored size, else measured)', () => {
    const scenes = [scene('s1', 1), scene('s2', 2, { size: { w: 360, h: 330 } }), scene('s3', 3)]
    const takes = [
      take('t1', 's1', 1, { size: { w: 224, h: 420 } }),
      take('t2', 's1', 2),
      take('t3', 's2', 1),
      take('t4', 's3', 1, { starred: true }),
      take('t5', 's3', 2, { size: { w: 224, h: 500 } }), // hidden by "Chỉ take chọn" below
    ]
    const measured: Record<string, number> = { s1: 180, t2: 210, t3: 260, s3: 150, t4: 190 }
    const all = layoutRowHeights(scenes, layoutTakes(takes, scenes, 'all'), (id) => measured[id])
    expect(all).toEqual({ s1: 420, s2: 330, s3: 500 })
    const chosen = layoutRowHeights(scenes, layoutTakes(takes, scenes, 'chosen'), (id) => measured[id])
    expect(chosen.s3).toBe(190) // t5 is hidden: it does not make the row taller
    // a size of the 0.5.x cards (below today's minimum) is drawn as the default node: the measured height counts
    const old = [scene('old', 1, { size: { w: 280, h: 200 } })]
    expect(layoutRowHeights(old, layoutTakes([], old, 'all'), () => 304)).toEqual({ old: 304 })
  })
  it('leaves out rows with nothing known; a take of a deleted scene adds no row, whatever old @video links name it', () => {
    // Old link kept inert (core/migrate moves a pre-0.6.0 `videoRefs` here); also the raw unmigrated field.
    const scenes = [scene('s2', 1, { legacyVideoRefs: ['t1'], videoRefs: ['t1'] })]
    const takes = [take('t1', 'gone', 1, { size: { w: 224, h: 520 } })]
    expect(layoutRowHeights(scenes, layoutTakes(takes, scenes, 'all'), () => undefined)).toEqual({})
  })
})

describe('autoLayoutCanvas', () => {
  const project = (): Project => ({
    id: 'p-layout',
    name: 'P',
    schemaVersion: 2,
    createdAt: 0,
    updatedAt: 0,
    presets: [],
    settings: { autoRenumber: true },
    assets: [],
    scenes: [scene('s1', 1, { position: { x: 900, y: 700 } }), scene('s2', 2, { position: { x: 100, y: 40 } })],
  })
  const initialProject = useProject.getState().project
  const initialTakes = useRuns.getState().takes
  const initialMeasured = useCanvasLocal.getState().measured
  beforeEach(() => {
    useProject.setState({ project: project() })
    useProject.temporal.getState().clear()
    // t1 has CSS auto height (no stored size): only React Flow's measurement knows it is 380px tall.
    useRuns.setState({ takes: [take('t1', 's1', 1, { position: { x: 1600, y: 1200 } }), take('t2', 's2', 1)] })
    useCanvasLocal.setState({ measured: { t1: { width: 224, height: 380 } } })
  })
  afterEach(() => {
    useProject.setState({ project: initialProject })
    useProject.temporal.getState().clear()
    useRuns.setState({ takes: initialTakes })
    useCanvasLocal.setState({ measured: initialMeasured })
  })
  const sc = (id: string) => useProject.getState().project.scenes.find((s) => s.id === id)!
  const tk = (id: string) => useRuns.getState().takes.find((t) => t.id === id)!

  it('makes a row as tall as its tallest take, so the next scene is not covered', () => {
    autoLayoutCanvas()
    expect(sc('s1').position).toEqual({ x: LAYOUT.scenesX, y: LAYOUT.scenesY })
    expect(sc('s2').position.y).toBeGreaterThanOrEqual(LAYOUT.scenesY + 380 + LAYOUT.gapY)
    expect(tk('t1').position).toBeNull() // back to its auto slot next to S01
  })

  it('"Chỉ take chọn": a tall hidden take still gets room (it returns to its row with "Tất cả")', () => {
    // t3 (560px, not chosen: t4 is the latest completed) is hidden; s2 must still go below t3's height
    useRuns.setState({ takes: [take('t3', 's1', 1, { size: { w: 224, h: 560 } }), take('t4', 's1', 2)] })
    useUI.setState({ takeDisplay: 'chosen' })
    useCanvasLocal.setState({ measured: {} })
    try {
      autoLayoutCanvas()
      expect(sc('s2').position).toEqual({ x: LAYOUT.scenesX, y: LAYOUT.scenesY + 560 + LAYOUT.gapY }) // was y 308, under t3
    } finally {
      useUI.setState({ takeDisplay: 'all' })
    }
  })

  it('undo puts hand-placed takes back (redo snaps them again); takes moved since are left alone', () => {
    autoLayoutCanvas()
    undo()
    expect(sc('s1').position).toEqual({ x: 900, y: 700 })
    expect(tk('t1').position).toEqual({ x: 1600, y: 1200 })
    redo()
    expect(tk('t1').position).toBeNull()
    // Moved by hand after the layout: an undo of the layout must not override it.
    useRuns.getState().setTakePositions({ t1: { x: 5, y: 5 } })
    undo()
    expect(tk('t1').position).toEqual({ x: 5, y: 5 })
  })
})

describe('toolbarDensity', () => {
  it('full labels on a wide canvas, compact then tight as it narrows; unmeasured = full', () => {
    expect(toolbarDensity(0)).toBe('full')
    expect(toolbarDensity(1400)).toBe('full')
    expect(toolbarDensity(1000)).toBe('full')
    expect(toolbarDensity(999)).toBe('compact')
    expect(toolbarDensity(720)).toBe('compact')
    expect(toolbarDensity(700)).toBe('tight')
    expect(MINIMAP_LIFT_W).toBeGreaterThan(1000)
  })
})

describe('inlineEditSavesDraft', () => {
  const k = (key: string, mod: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, ...mod })
  it('only Ctrl/Cmd+S (the global save) writes the title being typed', () => {
    expect(inlineEditSavesDraft(k('s', { ctrlKey: true }))).toBe(true)
    expect(inlineEditSavesDraft(k('S', { metaKey: true }))).toBe(true)
    expect(inlineEditSavesDraft(k('s'))).toBe(false)
    expect(inlineEditSavesDraft(k('c', { ctrlKey: true }))).toBe(false)
    expect(inlineEditSavesDraft(k('z', { ctrlKey: true }))).toBe(false)
    expect(inlineEditSavesDraft(k('s', { ctrlKey: true, altKey: true }))).toBe(false)
  })
  it('inlineKeySavesDraft follows the injected save chord (the keymap), never a lone modifier', () => {
    const f2 = (e: { key: string }) => e.key === 'F2'
    expect(inlineKeySavesDraft(k('F2'), f2)).toBe(true)
    expect(inlineKeySavesDraft(k('s', { ctrlKey: true }), f2)).toBe(false)
    expect(inlineKeySavesDraft(k('Control', { ctrlKey: true }), () => true)).toBe(false)
  })
})

describe('measuredOf', () => {
  afterEach(() => useCanvasLocal.setState({ measured: {} }))
  it('reads the size React Flow measured for a node (undefined before)', () => {
    expect(measuredOf('n1')).toBeUndefined()
    useCanvasLocal.setState({ measured: { n1: { width: 280, height: 210 } } })
    expect(measuredOf('n1')).toEqual({ width: 280, height: 210 })
  })
})

describe('withAlpha', () => {
  it('hex colors get an alpha byte, theme tokens go through color-mix', () => {
    expect(withAlpha('#4fb6a8', 0.7)).toBe('#4fb6a8b3')
    expect(withAlpha('var(--ref)', 0.7)).toBe('color-mix(in srgb, var(--ref) 70%, transparent)')
    expect(withAlpha('#4fb6a8', 2)).toBe('#4fb6a8ff')
  })
})

describe('DROP_BLOCKERS', () => {
  it('names the toolbar bar and its selection tray by their own classes (a wire dropped on them must not cut / move the reference)', () => {
    const list = DROP_BLOCKERS.split(',').map((s) => s.trim())
    expect(list).toEqual(expect.arrayContaining(['.cv-toolbar-bar', '.cv-toolbar-tray', '.cv-menu', '.react-flow__minimap']))
    const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    expect(read('ToolbarBar.tsx')).toMatch(/className="cv-toolbar-bar[ "]/)
    expect(read('ToolbarTray.tsx')).toMatch(/className="cv-toolbar-tray[ "]/)
  })
})

describe('room kept for the toolbar on its actual dock', () => {
  const stage = { top: 100, left: 300, right: 1300, bottom: 800 }
  it('reserves the edge the bar is docked on (bottom: drawer + bar), nothing for a free bar or none', () => {
    expect(toolbarInsets('bottom', { top: 708, left: 600, right: 900, bottom: 754 }, stage, 36)).toEqual({ top: 0, left: 0, right: 0, bottom: 92 })
    expect(toolbarInsets('top', { top: 112, left: 600, right: 900, bottom: 158 }, stage, 36)).toEqual({ top: 58, left: 0, right: 0, bottom: 36 })
    expect(toolbarInsets('left', { top: 112, left: 312, right: 358, bottom: 600 }, stage, 36)).toEqual({ top: 0, left: 58, right: 0, bottom: 36 })
    expect(toolbarInsets('right', { top: 112, left: 1242, right: 1288, bottom: 600 }, stage, 36)).toEqual({ top: 0, left: 0, right: 58, bottom: 36 })
    expect(toolbarInsets('free', { top: 400, left: 600, right: 900, bottom: 446 }, stage, 36)).toEqual({ top: 0, left: 0, right: 0, bottom: 36 })
    expect(toolbarInsets(undefined, null, stage, 272)).toEqual({ top: 0, left: 0, right: 0, bottom: 272 })
  })
  it('the covered bands are not "on screen": a node under a top / left bar is revealed below / right of it', () => {
    const covered = { w: 1000, h: 700, bottom: 36, top: 58, left: 58, right: 0 }
    expect(visibleFlowRect({ x: 0, y: 0, zoom: 1 }, covered)).toEqual({ x: 58, y: 58, w: 942, h: 606 })
    const next = revealViewport({ x: 0, y: 0, w: 200, h: 100 }, { x: 0, y: 0, zoom: 1 }, covered)!
    expect(next.x).toBeGreaterThanOrEqual(58)
    expect(next.y).toBeGreaterThanOrEqual(58)
  })
  it('toasts drop below a bar docked at the top', () => {
    const css = readFileSync(new URL('../toolbar.css', import.meta.url), 'utf8')
    expect(css).toMatch(/body:has\(\.cv-toolbar-host\[data-dock='top'\]\) \.toasts \{\s*top: calc\(var\(--topbar-h\) \+ 68px\);/)
  })
})

describe('review fixes wired in the components (source guards)', () => {
  const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  it('an old project whose rows were spaced on open is fitted again once React Flow has the moved nodes', () => {
    const view = read('CanvasView.tsx')
    expect(view).toMatch(/if \(!maybeSpaceRows\(\) \|\| savedViewport\) return/)
    expect(view).toMatch(/s\.nodes === before[\s\S]{0,200}initialViewport\(rf\.getNodes\(\), s\.width, s\.height\)/)
  })
  it('the "+" slot names what it does: the next scene (references and settings kept) when a scene is selected', () => {
    expect(read('ToolbarBar.tsx')).toContain("label: sceneCount ? 'Cảnh tiếp theo (giữ ảnh tham chiếu và cấu hình)' : 'Cảnh mới'")
  })
  it('the help names both wire ends, and the queue hint reads the live run key', () => {
    const help = read('../dialogs/ShortcutsDialog.tsx')
    expect(help).toContain("'Đầu dây phía ảnh → ảnh khác'")
    expect(help).not.toContain("'Đầu dây → cảnh khác'")
    const queue = read('../runs/QueueDrawer.tsx')
    expect(queue).toContain("useShortcutLabel('scene.run')")
    expect(queue).not.toMatch(/platformText\.mod\}<\/span> \+ <span className="kbd">Enter/)
    expect(read('../dialogs/SettingsDialog.tsx')).not.toContain('(phím E)')
  })
})
