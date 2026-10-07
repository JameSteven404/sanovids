// Scene order without the (hidden) Storyboard: the ▲▼ / "Dời tới vị trí…" controls on the scene code in the inspector
// (components/inspector/SceneOrderControl) and the fixed keys Alt + ↑ / ↓ (hooks/useShortcuts). Scene codes S01, S02…
// renumber; "Phát liền" and the .zip follow the new order. Cards on the canvas stay where they are ("Sắp xếp" lays
// them out again).
//
// A burst — moves of the same scene less than 1.5 s apart, e.g. Alt + ↑ held down — is ONE undo step (store
// coalescing, key 'move:<id>') and ONE toast "Đã dời cảnh: S05 → S02." whose Hoàn tác undoes the whole burst.
import { sceneCode } from './core/compile'
import { sortedScenes, undoToastAction, useProject } from './store/project'
import { toast, useUI } from './store/ui'

/** Same window as the project store's undo coalescing. */
export const MOVE_BURST_MS = 1500

interface Burst {
  id: string
  /** Scene order (its code) when the burst started: the toast says "from there to here". */
  fromOrder: number
  toastId: number
}
let burst: Burst | null = null
/** The last hint toast (edge / selection): not repeated while it is still on screen (a held key). */
let hint: { id: number; text: string } | null = null

function showHint(text: string) {
  const ui = useUI.getState()
  if (hint && hint.text === text && ui.toasts.some((t) => t.id === hint!.id)) return
  hint = { id: toast(text), text }
}

/** Place `to` (1-based, clamped to the project) for scene `id`. Returns false when nothing moved (no undo step). */
function moveTo(id: string, to: number): boolean {
  const scenes = sortedScenes(useProject.getState().project)
  const from = scenes.findIndex((s) => s.id === id)
  if (from < 0 || !Number.isFinite(to)) return false
  const target = Math.min(scenes.length, Math.max(1, Math.round(to)))
  // Every moveScene call is an undo step: never call it for a move that changes nothing.
  if (target === from + 1) return false
  const history = useProject.temporal.getState
  const before = history().pastStates
  useProject.getState().moveScene(id, target, { coalesce: 'move:' + id })
  // The store merged this move into the previous step (same scene, within the window) exactly when it did not add a
  // step: the history array is replaced on every new step. That decides the burst, not a clock of our own.
  const merged = history().pastStates === before && burst?.id === id
  const fromOrder = merged && burst ? burst.fromOrder : scenes[from].order
  const ui = useUI.getState()
  // One toast for the latest burst (its Hoàn tác undoes exactly that burst; an older one would be stale anyway).
  if (burst) ui.dismissToast(burst.toastId)
  const toastId = toast(`Đã dời cảnh: ${sceneCode(fromOrder)} → ${sceneCode(target)}.`, { action: undoToastAction() })
  burst = { id, fromOrder, toastId }
  return true
}

/** Move one scene `delta` places in the scene order (−1 = earlier). False at the first / last place (nothing moved). */
export function moveSceneBy(id: string, delta: number): boolean {
  const scenes = sortedScenes(useProject.getState().project)
  const from = scenes.findIndex((s) => s.id === id)
  if (from < 0 || !delta) return false
  return moveTo(id, from + 1 + delta)
}

/** Move one scene to the 1-based place `n` (clamped to [1, N]). False when it is already there. */
export function moveSceneTo(id: string, n: number): boolean {
  return moveTo(id, n)
}

/** Alt + ↑ / ↓: moves the single selected scene, else explains (a hint toast, not repeated while a key is held). */
export function moveSelectedScene(delta: -1 | 1): void {
  const scenes = sortedScenes(useProject.getState().project)
  const selected = new Set(useUI.getState().selectedIds)
  const picked = scenes.filter((s) => selected.has(s.id))
  if (picked.length !== 1) {
    showHint('Chọn đúng một cảnh để dời.')
    return
  }
  const index = scenes.indexOf(picked[0])
  if (delta < 0 && index === 0) {
    showHint(`${sceneCode(picked[0].order)} đã là cảnh đầu.`)
    return
  }
  if (delta > 0 && index === scenes.length - 1) {
    showHint(`${sceneCode(picked[0].order)} đã là cảnh cuối.`)
    return
  }
  moveSceneBy(picked[0].id, delta)
}
