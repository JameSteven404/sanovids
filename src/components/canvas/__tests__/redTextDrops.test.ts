// Pictures dropped on / inserted into a prompt that holds red text ("@image_?2(Lumi)"), against the real stores
// (review findings after the p2 merge): an insertion never lands inside a placeholder, a labelled token or a token
// written with a space (that split the red text, unblocked the scene and sent "@image_ …?2(Lumi)"); ONE card dropped
// right on red text fills it through the explicit fill path; the fill's toast "Hoàn tác" works when the dropped card
// also got its tile; a link + insert keeps a newer build's config marker; image files dropped on the panel's reference
// list are one undo step with one working "Hoàn tác".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filesToSceneRefs } from '../../../actions'
import { compileScene } from '../../../core/compile'
import { MODELS } from '../../../core/models'
import { groupAtOffset, parsePlaceholders } from '../../../core/placeholders'
import { sceneRunBlockReason } from '../../../core/runRules'
import type { Asset, Project, Scene, XY } from '../../../core/types'
import { LAYOUT, undo, useProject } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import { useUI } from '../../../store/ui'
import { insertAt, snapToWordEnd } from '../../inspector/tokens'
import { fillAtOffset, fillFromDrop, insertLinksAtExcerpt } from '../SceneNodeEditor'

let blobSeq = 0
vi.mock('../../../lib/imageStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/imageStore')>()),
  putBlob: vi.fn(async () => `img_drop_${++blobSeq}`),
}))

const scene = (id: string, over: Partial<Scene> = {}, position: XY = { x: LAYOUT.scenesX, y: 60 }): Scene => ({
  id, order: 1, title: '', prompt: '', refs: [], videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position, note: '', ...over,
})
const asset = (id: string, over: Partial<Asset> = {}): Asset => ({
  id, kind: 'character', name: id, tag: id, description: '', imageIds: ['img_' + id], color: '#fff', position: null, ...over,
})
const blank = useProject.getState().project
const project = () => useProject.getState().project
const sceneOf = () => project().scenes.find((s) => s.id === 's1')!
const assetOf = (id: string) => project().assets.find((a) => a.id === id)
const history = () => useProject.temporal.getState().pastStates.length
const lastToast = () => useUI.getState().toasts.at(-1)
const blockOf = () => sceneRunBlockReason(project().assets, sceneOf())
const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })

const RED = '@image_?2(Lumi)'

/** The finding's scene: S1 linked Elara + Lumi, "@image_1 hugs @image_2 at dusk", then Lumi unlinked → red text. */
function loadRed(over: Partial<Scene> = {}) {
  const s = scene('s1', { refs: ['elara', 'lumi'], prompt: '@image_1 hugs @image_2 at dusk', ...over })
  const assets = [asset('elara', { name: 'Elara', position: { x: 40, y: 60 } }), asset('lumi', { name: 'Lumi' }), asset('mira', { name: 'Mira' }), asset('nova', { name: 'Nova' })]
  useProject.getState().loadProject({ ...blank, id: 'red-drops', scenes: [s], assets, folders: [] } as Project)
  useProject.getState().removeRef('s1', 'lumi')
  useProject.temporal.getState().clear()
  useUI.setState({ toasts: [] })
  if (over.prompt === undefined) expect(sceneOf().prompt).toBe(`@image_1 hugs ${RED} at dusk`)
}

beforeEach(() => {
  useRuns.setState({ takes: [] })
  useUI.setState({ toasts: [], selectedIds: [] })
})
afterEach(() => {
  useProject.getState().loadProject(blank)
  useProject.temporal.getState().clear()
})

describe('snapToWordEnd never lands inside a token or red text', () => {
  const units = ['@image_?2(Lumi)', '@Image 2', '@image_2(Lumi · ảnh 2)', '@video_?1(S01·T1)', '@image_1', '@image_?7']
  const text = `Mở đầu ${units[0]} rồi ${units[1]} và ${units[2]}, ${units[3]} — ${units[4]} hay ${units[5]}.`
  const count = (s: string, part: string) => s.split(part).length - 1

  it.each([...Array(text.length + 1).keys()])('offset %i: the token inserted there leaves every unit whole', (at) => {
    const snapped = snapToWordEnd(text, at)
    for (const u of units) {
      const start = text.indexOf(u)
      expect(snapped > start && snapped < start + u.length, `${u} split at ${snapped}`).toBe(false)
    }
    const { next } = insertAt(text, snapped, snapped, '@image_3')
    for (const u of units) expect(count(next, u), u).toBe(count(text, u))
    expect(parsePlaceholders(next).map((p) => p.text)).toEqual(parsePlaceholders(text).map((p) => p.text))
  })

  it('plain words still snap to their end; boundaries stay where they are', () => {
    expect(snapToWordEnd('hello world', 2)).toBe(5)
    expect(snapToWordEnd('hello world', 5)).toBe(5)
    expect(snapToWordEnd(`a ${RED} b`, 2)).toBe(2)
    expect(snapToWordEnd(`a ${RED} b`, 2 + RED.length)).toBe(2 + RED.length)
    expect(snapToWordEnd(`a ${RED} b`, 3)).toBe(2 + RED.length)
  })
})

describe('one card dropped right on red text fills it; anything else never splits it', () => {
  const start = `@image_1 hugs `.length
  const inside = [...Array(RED.length - 1).keys()].map((i) => start + i + 1)

  it('groupAtOffset: strictly inside a member only', () => {
    loadRed()
    const s = sceneOf()
    for (const at of inside) expect(groupAtOffset(s.prompt, project().assets, s.refs, at)?.key).toBe('L:Lumi')
    expect(groupAtOffset(s.prompt, project().assets, s.refs, start)).toBeNull()
    expect(groupAtOffset(s.prompt, project().assets, s.refs, start + RED.length)).toBeNull()
  })

  it.each(inside)('node static text, offset %i: Mira takes Lumi\'s place and number — one undo step, her tile placed', (at) => {
    loadRed()
    const before = project()
    expect(blockOf()).not.toBeNull()
    expect(insertLinksAtExcerpt('s1', sceneOf().prompt.slice(0, at), ['mira'])).toBe(true)
    expect(sceneOf().prompt).toBe('@image_1 hugs @image_2 at dusk')
    expect(sceneOf().refs).toEqual(['elara', 'mira'])
    expect(blockOf()).toBeNull()
    expect(assetOf('mira')!.position).not.toBeNull()
    expect(history()).toBe(1)
    undo()
    expect(project()).toBe(before)
  })

  it('two cards dropped inside the red text: inserted after it — the red text stays whole and the scene stays blocked', () => {
    loadRed()
    expect(insertLinksAtExcerpt('s1', sceneOf().prompt.slice(0, start + 3), ['mira', 'nova'])).toBe(true)
    expect(sceneOf().prompt).toBe(`@image_1 hugs ${RED} @image_2 @image_3 at dusk`)
    expect(parsePlaceholders(sceneOf().prompt).map((p) => p.text)).toEqual([RED])
    expect(blockOf()).toMatch(/Còn chữ đỏ chờ ảnh/)
    const compiled = compileScene(project(), sceneOf())
    expect(compiled.unsentTokens).toContain(RED)
  })

  it('a drop right before / after the red text inserts there (no fill, nothing split)', () => {
    loadRed()
    expect(fillAtOffset('s1', start, ['mira'])).toBe(false)
    expect(fillAtOffset('s1', start + RED.length, ['mira'])).toBe(false)
    expect(insertLinksAtExcerpt('s1', sceneOf().prompt.slice(0, start + RED.length), ['mira'])).toBe(true)
    expect(sceneOf().prompt).toBe(`@image_1 hugs ${RED} @image_2 at dusk`)
    expect(blockOf()).toMatch(/Còn chữ đỏ chờ ảnh/)
  })

  it('a refused fill (no picture) changes nothing and says why; it is still handled (the user aimed at the red text)', () => {
    loadRed()
    useProject.getState().updateAsset('mira', { imageIds: [] })
    useProject.temporal.getState().clear()
    const before = project()
    expect(insertLinksAtExcerpt('s1', sceneOf().prompt.slice(0, start + 4), ['mira'])).toBe(true)
    expect(project()).toBe(before)
    expect(lastToast()?.tone).toBe('warning')
  })
})

describe('the fill\'s toast "Hoàn tác" after a drop that also placed the card\'s tile', () => {
  it('takes back the fill AND the tile (no "đã có thay đổi mới hơn")', () => {
    loadRed()
    const before = project()
    expect(assetOf('mira')!.position).toBeNull()
    expect(fillFromDrop('s1', null, 'mira')).toBe(true)
    expect(assetOf('mira')!.position).not.toBeNull()
    expect(history()).toBe(1)
    const t = lastToast()!
    expect(t.tone).toBe('success')
    t.action!.run()
    expect(project()).toBe(before)
    expect(useUI.getState().toasts.some((x) => x.tone === 'warning')).toBe(false)
  })
})

describe('a link + insert never drops a newer build\'s config marker', () => {
  const marker = { model: 'seedance_2_5', mode: 't2v', duration: 25, resolution: '1080p', ratio: '16:9' }

  it('node static text drop: the scene keeps foreignSettings and stays blocked', () => {
    loadRed({ prompt: '@image_1 walks at dusk', refs: ['elara'], foreignSettings: marker })
    const reason = blockOf()
    expect(reason).toMatch(/cấu hình của bản SanoVids mới hơn/)
    expect(insertLinksAtExcerpt('s1', '@image_1 walks', ['mira'])).toBe(true)
    expect(sceneOf().prompt).toBe('@image_1 walks @image_2 at dusk')
    expect(sceneOf().refs).toEqual(['elara', 'mira'])
    expect(sceneOf().foreignSettings).toEqual(marker)
    expect(blockOf()).toBe(reason)
  })

  it('store setPromptAndRefs: prompt + refs in one step; settings, preset and marker untouched; no change = no step', () => {
    loadRed({ prompt: 'x', refs: ['elara'], foreignSettings: marker, presetId: 'p1' })
    const s0 = sceneOf()
    useProject.getState().setPromptAndRefs('s1', 'x @image_2', ['elara', 'mira', 'ghost'])
    const s = sceneOf()
    expect(s).toMatchObject({ prompt: 'x @image_2', refs: ['elara', 'mira'], presetId: 'p1', foreignSettings: marker })
    expect(s.settings).toBe(s0.settings)
    expect(history()).toBe(1)
    useProject.getState().setPromptAndRefs('s1', 'x @image_2', ['elara', 'mira'])
    expect(history()).toBe(1)
  })
})

describe('image files dropped on the panel\'s "Ảnh tham chiếu" list', () => {
  it('new library items linked to the scene in ONE undo step; the one toast\'s "Hoàn tác" takes back both', async () => {
    loadRed({ prompt: '@image_1 walks', refs: ['elara'] })
    const before = project()
    const ids = await filesToSceneRefs('s1', [png('Nova cười.png'), png('Bãi biển.png')])
    expect(ids).toHaveLength(2)
    expect(sceneOf().refs).toEqual(['elara', ...ids])
    for (const id of ids) expect(assetOf(id)!.position).toBeNull() // library items, no tile
    expect(history()).toBe(1)
    expect(useUI.getState().toasts).toHaveLength(1)
    const t = lastToast()!
    expect(t.text).toMatch(/Đã thêm 2 mục vào thư viện và nối vào S01/)
    t.action!.run()
    expect(project()).toBe(before)
  })

  it('over the model\'s limit: the items stay in the library, the toast says they are not linked (still one step)', async () => {
    loadRed({ prompt: 'x', refs: [] })
    const many = Array.from({ length: MODELS.seedance_2_5.maxRefImages }, (_, i) => asset(`f${i}`))
    useProject.getState().loadProject({ ...project(), assets: [...project().assets, ...many], scenes: [{ ...sceneOf(), refs: many.map((a) => a.id) }] })
    useProject.temporal.getState().clear()
    const before = project()
    const ids = await filesToSceneRefs('s1', [png('Extra.png')])
    expect(ids).toHaveLength(1)
    expect(sceneOf().refs).toEqual(many.map((a) => a.id))
    expect(assetOf(ids[0])).toBeDefined()
    expect(history()).toBe(1)
    expect(lastToast()).toMatchObject({ tone: 'warning', text: expect.stringMatching(/Đã thêm 1 mục vào thư viện nhưng chưa nối được vào S01/) })
    lastToast()!.action!.run()
    expect(project()).toBe(before)
  })
})
