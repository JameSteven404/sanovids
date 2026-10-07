import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Take } from '../core/types'
import { KEY_ACTIONS } from '../core/keymap'
import { KEY_COMMANDS, ZOOM_EVENT, downloadSelection, openSelectedTake, starSelection, toggleCanvasOnly, unlinkSelection } from '../keyCommands'
import { PREMIERE_NOTICE_KEY, premiereKeysNotice, useShortcuts } from '../hooks/useShortcuts'
import { isLibraryKeyTarget, LIBRARY_ROOT, registerLibraryView, resetLibraryActionsForTests } from '../libraryActions'
import { useKeymap } from '../lib/keymapPrefs'
import { usePlayback } from '../lib/playback'

const effects = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useEffect: (fn: () => () => void) => { effects.cleanup = fn() } }))
import { useProject } from '../store/project'
import { useRuns } from '../store/runs'
import { useUI } from '../store/ui'
import * as actions from '../actions'

vi.mock('../store/persist', () => ({ flush: async () => true }))
vi.mock('../actions', async (original) => ({
  ...await original<typeof import('../actions')>(),
  downloadTake: vi.fn(), downloadTakesZip: vi.fn(), downloadChosenTakesZip: vi.fn(),
}))

let scene: string, other: string, asset: string
const take = (id: string, sceneId: string, number: number, starred = false) => ({ id, sceneId, number, starred, status: 'completed' } as Take)
beforeEach(() => {
  vi.useFakeTimers()
  useProject.getState().loadProject({ ...useProject.getState().project, id: 'keys-test', scenes: [], assets: [], folders: [] })
  scene = useProject.getState().addScene()
  other = useProject.getState().addScene()
  asset = useProject.getState().addAsset({ name: 'Lumi', imageIds: ['image'] })
  useUI.setState({ selectedIds: [], selectedEdgeIds: [], librarySelection: [], dialog: { kind: 'none' }, toasts: [] })
  useRuns.setState({ takes: [take('a', scene, 1, true), take('b', scene, 2), take('c', other, 1)] })
  vi.clearAllMocks()
})
afterEach(() => { effects.cleanup?.(); effects.cleanup = undefined; useKeymap.getState().replace({}); vi.unstubAllGlobals(); vi.useRealTimers() })

it('the live dispatcher uses custom chords, respects input/dialog/IME guards and blocks fullscreen fallthrough', () => {
  let keydown: (e: KeyboardEvent) => void = () => undefined
  vi.stubGlobal('window', { addEventListener: (type: string, fn: typeof keydown) => { if (type === 'keydown') keydown = fn }, removeEventListener: vi.fn() })
  useKeymap.getState().assign('scene.new', ['F2'])
  useShortcuts()
  const count = () => useProject.getState().project.scenes.length
  const press = (extra = {}) => {
    const e = { key: 'F2', code: 'F2', target: null, preventDefault: vi.fn(), ...extra }
    keydown(e as unknown as KeyboardEvent)
    return e
  }
  expect(press({ isComposing: true }).preventDefault).not.toHaveBeenCalled()
  press({ keyCode: 229 }); press({ target: { tagName: 'TEXTAREA' } })
  expect(count()).toBe(2)
  useUI.setState({ dialog: { kind: 'settings' } }); press()
  expect(count()).toBe(2)
  useUI.setState({ dialog: { kind: 'none' } })
  usePlayback.setState({ fullscreenId: 'a' }); press()
  expect(count()).toBe(2)
  usePlayback.setState({ fullscreenId: null })
  expect(press().preventDefault).toHaveBeenCalled()
  expect(count()).toBe(3)
  // The old default is now inactive, and an injected letter without a physical code cannot run.
  press({ key: 'n', code: 'KeyN', ctrlKey: true }); press({ key: 'n', code: '' })
  expect(count()).toBe(3)
})

it('Enter opens only one selected take and leaves modified Enter alone', () => {
  const e = { key: 'Enter', preventDefault: vi.fn() } as unknown as KeyboardEvent
  useUI.setState({ selectedIds: ['a', scene] })
  expect(openSelectedTake(e)).toBe(false)
  useUI.setState({ selectedIds: ['a'] })
  expect(openSelectedTake({ ...e, ctrlKey: true })).toBe(false)
  expect(openSelectedTake(e)).toBe(true)
  expect(useUI.getState().dialog).toEqual({ kind: 'take', takeId: 'a' })
})

it('implements every global registry command', () => {
  expect(Object.keys(KEY_COMMANDS).sort()).toEqual(KEY_ACTIONS.filter((a) => !a.onlyInDialog).map((a) => a.id).sort())
})

it('toggles all selected image links, cuts refs plus frames in one undo and preserves nodes', () => {
  const project = useProject.getState()
  project.addRefs([scene], [asset])
  project.setFrame(scene, 'first', asset)
  project.setFrame(scene, 'last', asset)
  project.setScenePrompt(scene, '@image_1 walks')
  useProject.temporal.getState().clear()
  useUI.setState({ selectedIds: [scene, asset] })
  KEY_COMMANDS['selection.connect']()
  const current = useProject.getState().project.scenes.find((s) => s.id === scene)!
  expect(current.refs).toEqual([])
  expect(current.firstFrame).toBeNull()
  expect(current.lastFrame).toBeNull()
  expect(current.prompt).toContain('@image_?')
  expect(useProject.getState().project.assets).toHaveLength(1)
  expect(useProject.temporal.getState().pastStates).toHaveLength(1)
  useProject.temporal.getState().undo()
  expect(useProject.getState().project.scenes.find((s) => s.id === scene)?.refs).toEqual([asset])
  // Selected nodes never become deletion targets when unlinking selected wires.
  useUI.setState({ selectedIds: [other], selectedEdgeIds: [actions.edgeId('ref', asset, scene)] })
  unlinkSelection()
  expect(useProject.getState().project.scenes).toHaveLength(2)
})

it('routes a download to viewed take, selected files, selected scenes, or the whole-project ZIP', () => {
  useUI.setState({ selectedIds: ['b'], dialog: { kind: 'take', takeId: 'a' } })
  downloadSelection()
  expect(actions.downloadTake).toHaveBeenLastCalledWith('a')
  useUI.setState({ dialog: { kind: 'none' } })
  downloadSelection()
  expect(actions.downloadTake).toHaveBeenLastCalledWith('b')
  useUI.setState({ selectedIds: ['a', 'b'] }); downloadSelection()
  expect(actions.downloadTakesZip).toHaveBeenLastCalledWith(['a', 'b'])
  useUI.setState({ selectedIds: [scene, other] }); downloadSelection()
  expect(actions.downloadTakesZip).toHaveBeenLastCalledWith(['a', 'c'])
  useUI.setState({ selectedIds: [] }); downloadSelection()
  expect(actions.downloadChosenTakesZip).toHaveBeenCalledOnce()
})

it('stars at most one take per scene and Undo restores the previous sibling star', () => {
  useUI.setState({ selectedIds: ['a', 'b'] }); starSelection()
  expect(useRuns.getState().takes.filter((t) => t.starred).map((t) => t.id)).toEqual(['a'])
  useUI.setState({ selectedIds: ['b', 'c'] }); starSelection()
  expect(useRuns.getState().takes.filter((t) => t.starred).map((t) => t.id)).toEqual(['b', 'c'])
  useUI.getState().toasts.at(-1)?.action?.run()
  expect(useRuns.getState().takes.filter((t) => t.starred).map((t) => t.id)).toEqual(['a'])
})

it('restores the previous panel combination after canvas-only mode', () => {
  useUI.setState({ leftOpen: true, rightOpen: false })
  toggleCanvasOnly()
  expect([useUI.getState().leftOpen, useUI.getState().rightOpen]).toEqual([false, false])
  toggleCanvasOnly()
  expect([useUI.getState().leftOpen, useUI.getState().rightOpen]).toEqual([true, false])
})

it('a held Ctrl+L flips the link once: key repeat never toggles it back', () => {
  let keydown: (e: KeyboardEvent) => void = () => undefined
  vi.stubGlobal('window', { addEventListener: (type: string, fn: typeof keydown) => { if (type === 'keydown') keydown = fn }, removeEventListener: vi.fn() })
  useShortcuts()
  const project = useProject.getState()
  project.addRefs([scene], [asset])
  project.setScenePrompt(scene, '@image_1 walks')
  useProject.temporal.getState().clear()
  useUI.setState({ selectedIds: [scene, asset] })
  const press = (repeat: boolean) => {
    const e = { key: 'l', code: 'KeyL', ctrlKey: true, repeat, target: null, preventDefault: vi.fn() }
    keydown(e as unknown as KeyboardEvent)
    return e
  }
  press(false)
  // The held chord is swallowed (no browser action) but does nothing.
  for (let i = 0; i < 5; i++) expect(press(true).preventDefault).toHaveBeenCalled()
  const s = useProject.getState().project.scenes.find((x) => x.id === scene)!
  expect(s.refs).toEqual([])
  expect(s.prompt).toContain('@image_?1')
  expect(useProject.temporal.getState().pastStates).toHaveLength(1)
  // A new press toggles again.
  press(false)
  expect(useProject.getState().project.scenes.find((x) => x.id === scene)?.refs).toEqual([asset])
})

it('unlinking leaves the selection alone, says which key to use, and cuts a selected wire alone like Delete', () => {
  const project = useProject.getState()
  project.addRefs([scene], [asset])
  useUI.setState({ selectedIds: [scene, asset] })
  const seen: string[][] = []
  const off = useUI.subscribe((s, prev) => { if (s.selectedIds !== prev.selectedIds) seen.push(s.selectedIds) })
  KEY_COMMANDS.unlinkSelection()
  off()
  // No selection change at all: the wide composer / node settings of a selected scene stay open.
  expect(seen).toEqual([])
  expect(useProject.getState().project.scenes.find((s) => s.id === scene)?.refs).toEqual([])
  expect(useUI.getState().toasts.at(-1)?.text).toMatch(/^Đã bỏ nối 1 dây/)
  expect(useUI.getState().toasts.at(-1)?.action?.label).toBe('Hoàn tác')
  // Nothing linked selected.
  KEY_COMMANDS.unlinkSelection()
  expect(useUI.getState().toasts.at(-1)?.text).toBe('Chọn ảnh và cảnh đã nối rồi bấm Ctrl+Shift+L.')
  // A selected wire alone goes through Delete itself.
  project.addRefs([other], [asset])
  useUI.setState({ selectedIds: [], selectedEdgeIds: [actions.edgeId('ref', asset, other)] })
  KEY_COMMANDS.unlinkSelection()
  expect(useProject.getState().project.scenes.find((s) => s.id === other)?.refs).toEqual([])
  expect(useUI.getState().toasts.at(-1)?.text).toMatch(/^Đã xoá 1 dây nối/)
  // The connect hint names the live key.
  useUI.setState({ selectedIds: [], selectedEdgeIds: [] })
  KEY_COMMANDS['selection.connect']()
  expect(useUI.getState().toasts.at(-1)?.text).toBe('Chọn ít nhất 1 nhân vật/bối cảnh và 1 cảnh, rồi bấm Ctrl+L.')
})

it('Ctrl+N makes an empty scene that copies nothing from the selected one', () => {
  useProject.getState().addRefs([scene], [asset])
  useProject.getState().setScenePrompt(scene, '@image_1 walks')
  useUI.setState({ selectedIds: [scene] })
  KEY_COMMANDS['scene.new']()
  const scenes = useProject.getState().project.scenes
  expect(scenes).toHaveLength(3)
  const made = scenes.find((s) => s.id === useUI.getState().selectedIds[0])!
  expect(made.id).not.toBe(scene)
  expect([made.refs, made.prompt]).toEqual([[], ''])
})

it('zoom keys send ZOOM_EVENT with the direction, instant while held', () => {
  const got: unknown[] = []
  const on = (e: Event) => got.push((e as CustomEvent).detail)
  actions.canvasEvents.addEventListener(ZOOM_EVENT, on)
  KEY_COMMANDS['canvas.zoomIn']({ repeat: false } as KeyboardEvent)
  KEY_COMMANDS['canvas.zoomOut']({ repeat: true } as KeyboardEvent)
  KEY_COMMANDS['canvas.zoomIn']()
  actions.canvasEvents.removeEventListener(ZOOM_EVENT, on)
  expect(got).toEqual([{ dir: 1, repeat: false }, { dir: -1, repeat: true }, { dir: 1, repeat: false }])
})

it('Shift+1 / Shift+5 open a closed panel (never close one); after Shift+1 Delete acts on the library', () => {
  const focused: string[] = []
  const element = (sel: string) => ({ tabIndex: 0, focus: () => focused.push(sel), closest: (s: string) => (s === sel ? {} : null) })
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0 })
  vi.stubGlobal('document', { querySelector: (sel: string) => element(sel), activeElement: null })
  useUI.setState({ leftOpen: false, rightOpen: true })
  KEY_COMMANDS['panels.library']()
  KEY_COMMANDS['panels.library']()
  expect(useUI.getState().leftOpen).toBe(true)
  expect(focused).toEqual([LIBRARY_ROOT, LIBRARY_ROOT])
  // The focused element is the library section itself, so the library owns the next Delete / Ctrl+A.
  const off = registerLibraryView({ visibleIds: () => [], collapsed: () => false })
  expect(isLibraryKeyTarget(element(LIBRARY_ROOT) as unknown as EventTarget)).toBe(true)
  expect(isLibraryKeyTarget(element('.sb') as unknown as EventTarget)).toBe(false)
  off()
  resetLibraryActionsForTests()
  KEY_COMMANDS['panels.inspector']()
  expect([useUI.getState().leftOpen, useUI.getState().rightOpen]).toEqual([true, true])
  expect(focused.at(-1)).toBe('.in-root')
})

it('★ in the take viewer marks the viewed take and names the one it replaces', () => {
  useUI.setState({ selectedIds: ['c'], dialog: { kind: 'take', takeId: 'b' } })
  KEY_COMMANDS['take.star']()
  expect(useRuns.getState().takes.filter((t) => t.starred).map((t) => t.id)).toEqual(['b'])
  expect(useUI.getState().toasts.at(-1)?.text).toBe(`★ ${actions.takeLabel('b')} (thay ${actions.takeLabel('a')})`)
  useUI.getState().toasts.at(-1)?.action?.run()
  expect(useRuns.getState().takes.filter((t) => t.starred).map((t) => t.id)).toEqual(['a'])
  useUI.setState({ dialog: { kind: 'none' }, selectedIds: [] })
  KEY_COMMANDS['take.star']()
  expect(useUI.getState().toasts.at(-1)?.text).toBe('Chọn một video (thẻ video) rồi bấm M để đánh dấu ★.')
})

it('the one-time Premiere notice: live labels, "Xem" opens the shortcuts, never on a new install', () => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) })
  premiereKeysNotice(true)
  expect(data.get(PREMIERE_NOTICE_KEY)).toBe('1')
  expect(useUI.getState().toasts).toEqual([])
  data.clear()
  useKeymap.getState().assign('take.star', ['KeyQ'])
  premiereKeysNotice(false)
  const notice = useUI.getState().toasts.at(-1)!
  expect(notice.text).toBe('Phím tắt nay giống Premiere Pro (Ctrl+L nối, Q ★, Ctrl+M tải, \\ vừa màn hình…). Phím cũ vẫn dùng được.')
  expect(notice.action?.label).toBe('Xem')
  notice.action?.run()
  expect(useUI.getState().dialog).toEqual({ kind: 'shortcuts' })
  const count = useUI.getState().toasts.length
  premiereKeysNotice(false)
  expect(useUI.getState().toasts).toHaveLength(count)
})
