// Ephemeral editor state: no project data, persistence or undo entries.
// The scene node IS the editor (approved design E0 v3): every node draws its prompt as static text and only the scene
// in `sceneId` mounts the live text field (SceneNodeEditor). The right panel's wide composer ("Khung soạn rộng",
// SceneInspector) is the other place to type a prompt: `panelSceneId`. A scene never has both at once — opening one
// commits (flushes) and closes the other, so each scene has at most one place where text is being typed.
// `settingsSceneId`: the node whose settings line is opened in place (choice 2B) — one node at a time, always the only
// selected one: opening it selects that node alone, and it closes as soon as that node is no longer the selection.
import { create } from 'zustand'
import { editorShouldStayOpen, type EditorFocus } from '../components/canvas/sceneEditorModel'
import { useCanvasPrefs } from '../lib/canvasPrefs'
import { flushScenes } from '../lib/promptDrafts'
import { useProject } from './project'
import { useUI } from './ui'

interface SceneEditorState {
  sceneId: string | null
  focus: EditorFocus | null
  /** UTF-16 offset, matching textarea.selectionStart. */
  caret: number | null
  /** A fresh request even when the same field is opened twice. */
  seq: number
  /** Scene whose prompt is open in the right panel's wide composer (null = none). */
  panelSceneId: string | null
  /** Scene node whose settings line is opened in place (null = none). */
  settingsSceneId: string | null
  open: (sceneId: string, focus?: EditorFocus | null, caret?: number | null) => void
  close: () => void
  openPanel: (sceneId: string) => void
  closePanel: () => void
  /** Open a node's settings line: selects that node alone (another node's line closes). */
  openSettings: (sceneId: string) => void
  closeSettings: () => void
}

let projectId: string | null = null
let closing = false
/** open() is selecting its scene: the 'select'-mode observer must not open it a second time. */
let opening = false

/**
 * How long a prompt field asked for with open(…, 'prompt') still counts as coming before it took the focus: a far node
 * (zoomed out) has no field until typeOnNode zoomed in (300 ms, plus React Flow placing a node made a moment ago).
 */
export const PROMPT_FOCUS_WAIT_MS = 1200
/** When the last prompt focus request was made (performance.now()). */
let promptAskedAt = Number.NEGATIVE_INFINITY
/**
 * The last focus request (`seq`) a node field acted on. The field of the edited node remounts when the node is culled
 * off-screen or zoomed out and back: that must not pull the focus back to it (only a new click / Enter does).
 */
let promptFocusedSeq = -1

/** The node field took the focus for request `seq` (SceneNodeEditor). */
export function markPromptFocused(seq: number): void {
  promptFocusedSeq = seq
}

/** The request the node fields last acted on. */
export const promptFocusedSeqNow = (): number => promptFocusedSeq

/**
 * A node's prompt field was asked for (typeOnNode, a new scene made to type in) and has not taken the focus yet, for at
 * most PROMPT_FOCUS_WAIT_MS: the letters typed meanwhile were meant for it — never canvas keys (hooks/useShortcuts).
 */
export function promptFocusPending(now: number = performance.now()): boolean {
  const s = useSceneEditor.getState()
  return s.sceneId !== null && s.focus === 'prompt' && s.seq !== promptFocusedSeq && now - promptAskedAt < PROMPT_FOCUS_WAIT_MS
}

export const useSceneEditor = create<SceneEditorState>()((set, get) => ({
  sceneId: null,
  focus: null,
  caret: null,
  seq: 0,
  panelSceneId: null,
  settingsSceneId: null,
  open: (sceneId, focus = 'prompt', caret = null) => {
    if (closing || useUI.getState().view !== 'canvas' || useCanvasPrefs.getState().nodeEditor === 'off') return
    const project = useProject.getState().project
    const scene = project.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    if (get().sceneId !== sceneId) get().close()
    // The wide composer of this scene hands over: its text is committed before the node's field reads the prompt.
    if (get().panelSceneId === sceneId) get().closePanel()
    opening = true
    try {
      const ui = useUI.getState()
      if (ui.selectedIds.length !== 1 || ui.selectedIds[0] !== sceneId) ui.select([sceneId])
    } finally {
      opening = false
    }
    projectId = project.id
    const prompt = useProject.getState().project.scenes.find((s) => s.id === sceneId)?.prompt ?? scene.prompt
    if (focus === 'prompt') promptAskedAt = performance.now()
    set((s) => ({ sceneId, focus, caret: caret === null || !Number.isFinite(caret) ? null : Math.max(0, Math.min(prompt.length, Math.trunc(caret))), seq: s.seq + 1 }))
  },
  close: () => {
    const { sceneId } = get()
    if (sceneId === null || closing) return
    closing = true
    try {
      // Project replacement has already happened in a subscription. Never flush an old draft into the new project.
      const project = useProject.getState().project
      if (project.id === projectId && project.scenes.some((s) => s.id === sceneId)) flushScenes([sceneId])
      projectId = null
      set({ sceneId: null, focus: null, caret: null })
    } finally {
      closing = false
    }
  },
  openPanel: (sceneId) => {
    if (get().sceneId === sceneId) get().close()
    if (get().panelSceneId !== sceneId) set({ panelSceneId: sceneId })
  },
  closePanel: () => {
    const id = get().panelSceneId
    if (id === null) return
    if (useProject.getState().project.scenes.some((s) => s.id === id)) flushScenes([id])
    set({ panelSceneId: null })
  },
  openSettings: (sceneId) => {
    if (useUI.getState().view !== 'canvas' || useCanvasPrefs.getState().nodeEditor === 'off') return
    if (!useProject.getState().project.scenes.some((s) => s.id === sceneId)) return
    const ui = useUI.getState()
    if (ui.selectedIds.length !== 1 || ui.selectedIds[0] !== sceneId) ui.select([sceneId])
    if (get().settingsSceneId !== sceneId) set({ settingsSceneId: sceneId })
  },
  closeSettings: () => {
    if (get().settingsSceneId !== null) set({ settingsSceneId: null })
  },
}))

/** Is this node's settings line opened in place? */
export function useSettingsOpen(id: string): boolean {
  return useSceneEditor((s) => s.settingsSceneId === id)
}

/** The only editor subscription a card needs; other cards keep the same boolean snapshot. */
export function useIsEditing(id: string): boolean {
  return useSceneEditor((s) => s.sceneId === id)
}

/** Is this scene's prompt open in the right panel's wide composer (its node then shows static text only)? */
export function useInPanel(id: string): boolean {
  return useSceneEditor((s) => s.panelSceneId === id)
}

function checkEditor() {
  const editor = useSceneEditor.getState()
  if (editor.sceneId === null || closing) return
  const project = useProject.getState().project
  const ui = useUI.getState()
  if (!editorShouldStayOpen({
    sceneId: editor.sceneId, projectId, currentProjectId: project.id,
    sceneExists: project.scenes.some((s) => s.id === editor.sceneId),
    selectedIds: ui.selectedIds, view: ui.view, nodeEditor: useCanvasPrefs.getState().nodeEditor,
  })) editor.close()
}

/** The wide composer follows the inspected scene: it closes when its scene is gone or another project opens. */
function checkPanel() {
  const { panelSceneId, closePanel } = useSceneEditor.getState()
  if (panelSceneId === null) return
  if (!useProject.getState().project.scenes.some((s) => s.id === panelSceneId)) useSceneEditor.setState({ panelSceneId: null })
  else if (!useUI.getState().selectedIds.includes(panelSceneId)) closePanel()
}

/** The opened settings line belongs to the only selected node: it closes with that selection (or the node, the view, the pref). */
function checkSettings() {
  const id = useSceneEditor.getState().settingsSceneId
  if (id === null) return
  const ui = useUI.getState()
  const keep =
    ui.view === 'canvas' &&
    ui.selectedIds.length === 1 &&
    ui.selectedIds[0] === id &&
    useCanvasPrefs.getState().nodeEditor !== 'off' &&
    useProject.getState().project.scenes.some((s) => s.id === id)
  if (!keep) useSceneEditor.setState({ settingsSceneId: null })
}

/**
 * Pref 'select' ("Tự mở khi chọn 1 cảnh"): exactly one scene selected on the canvas mounts its node's text field,
 * without moving the focus there (typing still needs a click or Enter).
 */
function autoOpen() {
  if (opening || closing || useCanvasPrefs.getState().nodeEditor !== 'select') return
  const ui = useUI.getState()
  if (ui.view !== 'canvas' || ui.selectedIds.length !== 1) return
  const id = ui.selectedIds[0]
  const editor = useSceneEditor.getState()
  if (editor.sceneId === id || editor.panelSceneId === id) return
  if (!useProject.getState().project.scenes.some((s) => s.id === id)) return
  editor.open(id, null)
}

// One lifecycle observer per source, never per card; unrelated progress / hover / UI changes do no work.
const unsubscribe = [
  useUI.subscribe((s, prev) => {
    if (s.view !== prev.view || s.selectedIds !== prev.selectedIds) {
      checkEditor()
      checkPanel()
      checkSettings()
      autoOpen()
    }
  }),
  useProject.subscribe((s, prev) => {
    if (s.project.id !== prev.project.id || s.project.scenes !== prev.project.scenes) {
      checkEditor()
      checkPanel()
      checkSettings()
    }
  }),
  useCanvasPrefs.subscribe((s, prev) => {
    if (s.nodeEditor !== prev.nodeEditor) {
      checkEditor()
      checkSettings()
      autoOpen()
    }
  }),
]
if (import.meta.hot) import.meta.hot.dispose(() => unsubscribe.forEach((off) => off()))
