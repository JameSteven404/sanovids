// Ephemeral editor state: no project data, persistence or undo entries.
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
  open: (sceneId: string, focus?: EditorFocus | null, caret?: number | null) => void
  close: () => void
}

let projectId: string | null = null
let closing = false

export const useSceneEditor = create<SceneEditorState>()((set, get) => ({
  sceneId: null,
  focus: null,
  caret: null,
  seq: 0,
  open: (sceneId, focus = 'prompt', caret = null) => {
    if (closing || useUI.getState().view !== 'canvas' || useCanvasPrefs.getState().nodeEditor === 'off') return
    const project = useProject.getState().project
    const scene = project.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    if (get().sceneId !== sceneId) get().close()
    useUI.getState().select([sceneId])
    projectId = project.id
    set((s) => ({ sceneId, focus, caret: caret === null || !Number.isFinite(caret) ? null : Math.max(0, Math.min(scene.prompt.length, Math.trunc(caret))), seq: s.seq + 1 }))
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
}))

/** The only editor subscription a card needs; other cards keep the same boolean snapshot. */
export function useIsEditing(id: string): boolean {
  return useSceneEditor((s) => s.sceneId === id)
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

// One lifecycle observer per source, never per card; unrelated progress / hover / UI changes do no work.
const unsubscribe = [
  useUI.subscribe((s, prev) => { if (s.view !== prev.view || s.selectedIds !== prev.selectedIds) checkEditor() }),
  useProject.subscribe((s, prev) => { if (s.project.id !== prev.project.id || s.project.scenes !== prev.project.scenes) checkEditor() }),
  useCanvasPrefs.subscribe((s, prev) => { if (s.nodeEditor !== prev.nodeEditor) checkEditor() }),
]
if (import.meta.hot) import.meta.hot.dispose(() => unsubscribe.forEach((off) => off()))
