// What protects the user's data when images land on a scene node (approved design E0 v3, choice 4A), run against the
// real stores: every drop is ONE undo step (tiles + link + inserted tags — "Hoàn tác" never leaves half of it behind),
// library cards without a tile get one in the image column, image files over the model's limit stay on the canvas,
// and a node field's draft is committed on structural changes, hiding / closing the window and unmount.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, Project, Scene, XY } from '../../../core/types'
import { draftCount, flushScenes } from '../../../lib/promptDrafts'
import { LAYOUT, oneUndoStep, undo, useProject } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import { useUI } from '../../../store/ui'
import { imageColumnX } from '../canvasModel'
import { VIDEO_NOT_REFERENCE_TEXT } from '../../../actions'
import { ASSETS_MIME, TAKES_MIME } from '../../../lib/dnd'
import { bindNodeDraft, filesToSceneTiles, insertLinksAtExcerpt, linkCardsToNode, linkNewTiles, placeLinkedTiles, takeDropOnNode } from '../SceneNodeEditor'

// Image files are stored in IndexedDB in the app: here each one gets a fresh media id.
let blobSeq = 0
vi.mock('../../../lib/imageStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/imageStore')>()),
  putBlob: vi.fn(async () => `img_drop_${++blobSeq}`),
}))

const scene = (id: string, order: number, position: XY, over: Partial<Scene> = {}): Scene => ({
  id, order, title: '', prompt: '', refs: [], videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position, note: '', ...over,
})
const asset = (id: string, position: XY | null, over: Partial<Asset> = {}): Asset => ({
  id, kind: 'character', name: id, tag: id, description: '', imageIds: ['img_' + id], color: '#fff', position, ...over,
})
const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
/** A window / document stand-in (Node's EventTarget does not remove capture listeners like a browser does). */
function fakeTarget<T extends object>(extra: T = {} as T): EventTarget & T {
  const map = new Map<string, Set<EventListenerOrEventListenerObject>>()
  const target = {
    addEventListener: (type: string, fn: EventListenerOrEventListenerObject | null) => {
      if (!fn) return
      if (!map.has(type)) map.set(type, new Set())
      map.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: EventListenerOrEventListenerObject | null) => {
      if (fn) map.get(type)?.delete(fn)
    },
    dispatchEvent: (e: Event) => {
      for (const fn of [...(map.get(e.type) ?? [])]) {
        if (typeof fn === 'function') fn(e)
        else fn.handleEvent(e)
      }
      return true
    },
  }
  return Object.assign(target, extra) as unknown as EventTarget & T
}

const initial = useProject.getState().project
const history = () => useProject.temporal.getState().pastStates.length
const project = () => useProject.getState().project
const sceneOf = (id: string) => project().scenes.find((s) => s.id === id)!
const assetOf = (id: string) => project().assets.find((a) => a.id === id)
const lastToast = () => useUI.getState().toasts.at(-1)

function load(scenes: Scene[], assets: Asset[]) {
  const p: Project = { ...initial, id: 'drops', scenes, assets, folders: [] }
  useProject.getState().loadProject(p)
  useProject.temporal.getState().clear()
}

beforeEach(() => {
  useRuns.setState({ takes: [] })
  useUI.setState({ toasts: [], selectedIds: [] })
})
afterEach(() => {
  useProject.getState().loadProject(initial)
  useProject.temporal.getState().clear()
})

const S1 = { x: LAYOUT.scenesX, y: 60 }

describe('oneUndoStep', () => {
  it('records several store actions as one step (nested calls join it), and a typing burst never merges into it', () => {
    load([scene('s1', 1, S1)], [])
    const before = project()
    oneUndoStep(() => {
      useProject.getState().addAsset({ name: 'A' })
      oneUndoStep(() => useProject.getState().updateScene('s1', { title: 'T' }))
      useProject.getState().setScenePrompt('s1', 'typed')
    })
    expect(history()).toBe(1)
    // the prompt key set inside does not swallow the next typing into the group's step
    useProject.getState().setScenePrompt('s1', 'typed more')
    expect(history()).toBe(2)
    undo()
    undo()
    expect(project()).toBe(before)
  })
  it('changes nothing → no step', () => {
    load([scene('s1', 1, S1)], [])
    oneUndoStep(() => undefined)
    expect(history()).toBe(0)
  })
})

describe('library cards / tiles dropped on a node', () => {
  it('on the static text: link + @image_N where dropped + a tile for a card not on the canvas — ONE undo step', () => {
    load([scene('s1', 1, S1, { prompt: 'Hello world', refs: ['a1'] })], [asset('a1', { x: 40, y: 60 }), asset('a2', null)])
    const before = project()
    expect(insertLinksAtExcerpt('s1', 'Hello', ['a2'])).toBe(true)
    expect(sceneOf('s1').refs).toEqual(['a1', 'a2'])
    expect(sceneOf('s1').prompt).toBe('Hello @image_2 world')
    // its tile: the image column, next to the row of s1, below the tile already there
    expect(assetOf('a2')!.position).toEqual({ x: imageColumnX(LAYOUT.scenesX), y: 60 + LAYOUT.assetH + LAYOUT.assetGapY })
    expect(history()).toBe(1)
    lastToast()!.action!.run() // "Hoàn tác" of the toast takes all of it back
    expect(project()).toBe(before)
  })
  it('a point that is not on the text: nothing done (the caller links only)', () => {
    load([scene('s1', 1, S1, { prompt: 'Hello' })], [asset('a2', null)])
    expect(insertLinksAtExcerpt('s1', null, ['a2'])).toBe(false)
    expect(insertLinksAtExcerpt('s1', 'Not the prompt', ['a2'])).toBe(false)
    expect(history()).toBe(0)
  })
  it('elsewhere on the node: linked, cards without a tile get one, one already on the canvas only its wire', () => {
    load([scene('s1', 1, S1)], [asset('onCanvas', { x: 40, y: 60 }), asset('lib', null)])
    const before = project()
    linkCardsToNode('s1', ['s1'], ['onCanvas', 'lib'])
    expect(sceneOf('s1').refs).toEqual(['onCanvas', 'lib'])
    expect(assetOf('onCanvas')!.position).toEqual({ x: 40, y: 60 })
    expect(assetOf('lib')!.position).toEqual({ x: imageColumnX(LAYOUT.scenesX), y: 60 + LAYOUT.assetH + LAYOUT.assetGapY })
    expect(history()).toBe(1)
    lastToast()!.action!.run()
    expect(project()).toBe(before)
  })
  it('a card that could not be linked (model limit) gets no tile', () => {
    const full = asset('full', null, { imageIds: Array.from({ length: 9 }, (_, i) => 'f' + i) })
    load([scene('s1', 1, S1, { refs: ['full'], settings: { model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' } })], [full, asset('lib', null)])
    linkCardsToNode('s1', ['s1'], ['lib'])
    expect(sceneOf('s1').refs).toEqual(['full'])
    expect(assetOf('lib')!.position).toBeNull()
    expect(history()).toBe(0)
    expect(placeLinkedTiles('s1', ['lib'])).toEqual([])
  })
})

describe('a video dragged onto a scene node (reference videos retired)', () => {
  const dragEvent = (type: string) => ({ dataTransfer: { types: [type] } as unknown as DataTransfer, preventDefault: vi.fn(), stopPropagation: vi.fn() })
  it('is accepted (no no-drop cursor), links nothing and says why on drop', () => {
    load([scene('s1', 1, S1)], [])
    const before = project()
    useUI.getState().setDraggingTakes(['t1'])
    const over = dragEvent(TAKES_MIME)
    expect(takeDropOnNode(over, false)).toBe(true)
    expect(over.preventDefault).toHaveBeenCalled()
    expect(over.stopPropagation).toHaveBeenCalled()
    expect(useUI.getState().toasts).toHaveLength(0)
    const drop = dragEvent(TAKES_MIME)
    expect(takeDropOnNode(drop, true)).toBe(true)
    expect(drop.preventDefault).toHaveBeenCalled()
    expect(lastToast()?.text).toBe(`${VIDEO_NOT_REFERENCE_TEXT}.`)
    expect(useUI.getState().draggingTakeIds).toBeNull()
    expect(project()).toBe(before)
    expect(history()).toBe(0)
  })
  it('SceneNode routes both its dragover and its drop through it', () => {
    const src = readFileSync(new URL('../SceneNode.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const onDragOver = \(e: DragEvent\) => \{[^}]*if \(takeDropOnNode\(e, false\)\) return/)
    expect(src).toMatch(/const onDrop = \(e: DragEvent\) => \{\s*if \(takeDropOnNode\(e, true\)\) return/)
  })
  it('any other drag is left to the node', () => {
    const e = dragEvent(ASSETS_MIME)
    expect(takeDropOnNode(e, true)).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(useUI.getState().toasts).toHaveLength(0)
  })
})

describe('image files dropped on a node (choice 4A)', () => {
  it('tiles in the image column next to the row, wired to the scene — tiles and link in ONE undo step', async () => {
    load([scene('s1', 1, S1), scene('s2', 2, { x: LAYOUT.scenesX, y: 60 + 352 })], [])
    const before = project()
    const ids = await filesToSceneTiles('s2', [png('linh.png'), png('mai.png')], (created) => linkNewTiles(['s2'], created))
    expect(ids).toHaveLength(2)
    const x = imageColumnX(LAYOUT.scenesX)
    expect(ids.map((id) => assetOf(id)!.position)).toEqual([
      { x, y: 60 + 352 },
      { x, y: 60 + 352 + LAYOUT.assetH + LAYOUT.assetGapY },
    ])
    expect(sceneOf('s2').refs).toEqual(ids)
    expect(history()).toBe(1)
    expect(lastToast()!.text).toBe('Đã thêm 2 ô ảnh và nối vào S02.')
    lastToast()!.action!.run()
    expect(project()).toBe(before)
  })
  it('over the model limit: the tiles stay on the canvas unwired (the files are not lost), the toast says so', async () => {
    const full = asset('full', { x: 40, y: 60 }, { imageIds: Array.from({ length: 9 }, (_, i) => 'f' + i) })
    load([scene('s1', 1, S1, { refs: ['full'], settings: { model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' } })], [full])
    const ids = await filesToSceneTiles('s1', [png('x.png')], (created) => linkNewTiles(['s1'], created))
    expect(assetOf(ids[0])!.position).not.toBeNull()
    expect(sceneOf('s1').refs).toEqual(['full'])
    expect(lastToast()).toMatchObject({ tone: 'warning', text: 'Đã thêm 1 ô ảnh lên canvas nhưng chưa nối được: vượt giới hạn ảnh của model.' })
    expect(history()).toBe(1)
  })
  it('the prompt being typed in the node is committed first, as its own step', async () => {
    load([scene('s1', 1, S1, { prompt: 'old' })], [])
    const off = bindNodeDraft('s1', () => useProject.getState().setScenePrompt('s1', 'typed'), fakeTarget(), fakeTarget({ visibilityState: 'visible' }))
    try {
      await filesToSceneTiles('s1', [png('x.png')], (created) => linkNewTiles(['s1'], created))
      expect(history()).toBe(2)
      undo()
      expect(sceneOf('s1')).toMatchObject({ prompt: 'typed', refs: [] })
    } finally {
      off()
    }
  })
})

describe('bindNodeDraft (the node field draft contract)', () => {
  it('commits on structural changes, when the window is hidden or closed, and once more when the field unmounts', () => {
    const win = fakeTarget()
    const doc = fakeTarget({ visibilityState: 'visible' })
    const commit = vi.fn()
    const off = bindNodeDraft('sX', commit, win, doc)
    expect(draftCount('sX')).toBe(1)
    flushScenes(['sX'])
    expect(commit).toHaveBeenCalledTimes(1)
    win.dispatchEvent(new Event('pagehide'))
    expect(commit).toHaveBeenCalledTimes(2)
    win.dispatchEvent(new Event('visibilitychange')) // still visible: nothing
    expect(commit).toHaveBeenCalledTimes(2)
    doc.visibilityState = 'hidden'
    win.dispatchEvent(new Event('visibilitychange'))
    expect(commit).toHaveBeenCalledTimes(3)
    off() // unmount (far view, culled, another node opened)
    expect(commit).toHaveBeenCalledTimes(4)
    expect(draftCount('sX')).toBe(0)
    flushScenes(['sX'])
    win.dispatchEvent(new Event('pagehide'))
    expect(commit).toHaveBeenCalledTimes(4)
  })
})
