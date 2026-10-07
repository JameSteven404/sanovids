// Ephemeral editor state: no project data, persistence or undo entries.
// The scene node IS the editor (approved design E0 v3): every node draws its prompt as static text and only the scene
// in `sceneId` mounts the live text field (SceneNodeEditor). The right panel's wide composer ("Khung soạn rộng",
// SceneInspector) is the other place to type a prompt: `panelSceneId`. A scene never has both at once — opening one
// commits (flushes) and closes the other, so each scene has at most one place where text is being typed.
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
  open: (sceneId: string, focus?: EditorFocus | null, caret?: number | null) => void
  close: () => void
  openPanel: (sceneId: string) => void
  closePanel: () => void
}

let projectId: string | null = null
let closing = false
/** open() is selecting its scene: the 'select'-mode observer must not open it a second time. */
let opening = false

export const useSceneEditor = create<SceneEditorState>()((set, get) => ({
  sceneId: null,
  focus: null,
  caret: null,
  seq: 0,
  panelSceneId: null,
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
}))

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
      autoOpen()
    }
  }),
  useProject.subscribe((s, prev) => {
    if (s.project.id !== prev.project.id || s.project.scenes !== prev.project.scenes) {
      checkEditor()
      checkPanel()
    }
  }),
  useCanvasPrefs.subscribe((s, prev) => {
    if (s.nodeEditor !== prev.nodeEditor) {
      checkEditor()
      autoOpen()
    }
  }),
]
if (import.meta.hot) import.meta.hot.dispose(() => unsubscribe.forEach((off) => off()))
