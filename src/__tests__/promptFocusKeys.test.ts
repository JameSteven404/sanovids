// Typing into a node's prompt field that has been asked for but is not on screen yet (review finding after the p2
// merge): zoomed out, a new scene made by double-click / "Cảnh mới" and Enter / "Gõ trên node" first zoom in
// (typeOnNode) — the field only exists in the near view. The letters typed meanwhile must never run canvas keys
// (N made scenes, H / V switched the tool, E / M / F / C…, Delete removed the new scene). The global shortcut handler
// (hooks/useShortcuts) is driven directly, as in sceneOrderKeys.test.ts; the request comes from the real editor store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }))

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect()
      if (typeof cleanup === 'function') h.cleanups.push(cleanup)
    },
  }
})
vi.mock('../store/persist', () => ({ flush: async () => true }))

import { useShortcuts } from '../hooks/useShortcuts'
import type { Project, Scene } from '../core/types'
import { useCanvasPrefs } from '../lib/canvasPrefs'
import { LAYOUT, useProject } from '../store/project'
import { markPromptFocused, PROMPT_FOCUS_WAIT_MS, promptFocusPending, useSceneEditor } from '../store/sceneEditor'
import { useUI } from '../store/ui'

type Listener = (e: KeyboardEvent) => void
let listeners: Listener[] = []

function press(key: string, init: Partial<KeyboardEvent> = {}): void {
  const e = {
    key,
    // the keymap reads the physical key (core/keyChord chordFromEvent)
    code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === ' ' ? 'Space' : key,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    target: null,
    ...init,
    preventDefault() {
      this.defaultPrevented = true
    },
  }
  for (const fn of listeners) fn(e as unknown as KeyboardEvent)
}

const blank = useProject.getState().project
const scene = (id: string, order: number): Scene => ({
  id, order, title: '', prompt: '', refs: [], videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position: { x: LAYOUT.scenesX, y: 60 + order * 400 }, note: '',
})
const sceneCount = () => useProject.getState().project.scenes.length

beforeEach(() => {
  listeners = []
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners.push(fn)
    },
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((x) => x !== fn)
    },
    dispatchEvent: () => true,
  })
  useProject.getState().loadProject({ ...blank, id: 'keys', scenes: [scene('s1', 1)], assets: [], folders: [] } as Project)
  useCanvasPrefs.setState({ nodeEditor: 'click' })
  useUI.setState({ dialog: { kind: 'none' }, toasts: [], view: 'canvas', selectedIds: [], interaction: 'select' })
  useShortcuts()
})
afterEach(() => {
  for (const cleanup of h.cleanups.splice(0)) cleanup()
  useSceneEditor.getState().close()
  useProject.getState().loadProject(blank)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a prompt field asked for but not focused yet takes the plain keys away from the canvas', () => {
  it('N / H / E / M / C / F / Delete / ⌫ do nothing until the field took the focus; then they work again', () => {
    useSceneEditor.getState().open('s1', 'prompt', 0)
    expect(promptFocusPending()).toBe(true)
    const ui = () => useUI.getState()
    const minimap = ui().showMinimap
    const edges = ui().edgeMode
    for (const key of ['n', 'h', 'e', 'm', 'c', 'f', 'N', ' ', 'Backspace', 'Delete']) press(key)
    expect(sceneCount()).toBe(1)
    expect(ui().interaction).toBe('select')
    expect(ui().showMinimap).toBe(minimap)
    expect(ui().edgeMode).toBe(edges)
    expect(ui().selectedIds).toEqual(['s1'])
    // Ctrl / Alt chords are not typing: they still reach their handlers (Ctrl+S…)
    expect(promptFocusPending()).toBe(true)
    // the field took the focus (SceneNodeEditor marks the request): canvas keys are back once the field is left
    markPromptFocused(useSceneEditor.getState().seq)
    expect(promptFocusPending()).toBe(false)
    press('h')
    expect(ui().interaction).toBe('hand')
  })

  it('only for a while: a field that never comes (a far node that could not zoom in) gives the keys back', () => {
    const t0 = performance.now()
    useSceneEditor.getState().open('s1', 'prompt', 0)
    expect(promptFocusPending(t0 + PROMPT_FOCUS_WAIT_MS - 50)).toBe(true)
    expect(promptFocusPending(t0 + PROMPT_FOCUS_WAIT_MS + 50)).toBe(false)
    vi.spyOn(performance, 'now').mockReturnValue(t0 + PROMPT_FOCUS_WAIT_MS + 50)
    press('h')
    expect(useUI.getState().interaction).toBe('hand')
  })

  it('never for an editor opened without a focus request (pref "Tự mở khi chọn 1 cảnh") or a closed one', () => {
    useSceneEditor.getState().open('s1', null)
    expect(promptFocusPending()).toBe(false)
    press('n')
    expect(sceneCount()).toBe(2)
    useSceneEditor.getState().close()
    expect(promptFocusPending()).toBe(false)
  })
})
