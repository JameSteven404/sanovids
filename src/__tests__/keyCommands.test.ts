import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Take } from '../core/types'
import { KEY_ACTIONS } from '../core/keymap'
import { KEY_COMMANDS, downloadSelection, openSelectedTake, starSelection, toggleCanvasOnly, unlinkSelection } from '../keyCommands'
import { useShortcuts } from '../hooks/useShortcuts'
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
