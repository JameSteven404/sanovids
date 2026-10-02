// Pure rules for deleting takes (video nodes) — used by actions.deleteSelection / actions.deleteTakes and the Delete
// key. No stores: unit-tested in ./__tests__/deletePlan.test.ts.
import { sceneCode } from './compile'
import type { JobStatus } from './types'

/**
 * Selection for a delete: takes selected together with their own scene are left out — deleting the scene hides
 * them and Undo brings them back, while deleting a take is permanent (box-selecting a row picks up its takes).
 * `ids` = the selection without the spared takes; `spared` = the takes left out; `takes` = the takes that will be
 * deleted for good.
 */
export function keyboardDeletePlan(
  selectedIds: readonly string[],
  sceneIds: ReadonlySet<string>,
  takeSceneOf: ReadonlyMap<string, string>,
): { ids: string[]; spared: string[]; takes: string[] } {
  const deadScenes = new Set(selectedIds.filter((id) => sceneIds.has(id)))
  const ids: string[] = []
  const spared: string[] = []
  const takes: string[] = []
  for (const id of selectedIds) {
    const sceneId = takeSceneOf.get(id)
    if (sceneId !== undefined && deadScenes.has(sceneId)) spared.push(id)
    else {
      ids.push(id)
      if (sceneId !== undefined) takes.push(id)
    }
  }
  return { ids, spared, takes }
}

/** When to ask before deleting takes: always when something is lost, only for @video users, or never. */
export type TakeDeleteConfirm = boolean | 'usedOnly'

export interface TakeDeleteCheck {
  /** Takes that exist among the requested ids. */
  ids: string[]
  /** How many of them are finished videos (lost for good). */
  finished: number
  /** Scenes (not being deleted) that use one of them as @video, in scene order. */
  usedBy: { id: string; order: number }[]
  /** Confirm text, or null when nothing needs asking. */
  question: string | null
}

/**
 * What deleting `takeIds` loses, and the confirm question to ask (null = no need to ask).
 * `ignoreScenes` = scenes deleted in the same operation (their @video uses do not count). `label` names a single
 * take ("S03·T2"). confirm: true = ask when a finished video is lost or a scene uses one as @video;
 * 'usedOnly' = ask only for @video users (the caller already confirmed the loss, e.g. a two-click button); false = never.
 */
export function checkTakeDelete(
  takeIds: readonly string[],
  takes: readonly { id: string; status: JobStatus }[],
  scenes: readonly { id: string; order: number; videoRefs: readonly string[] }[],
  opts: { confirm?: TakeDeleteConfirm; ignoreScenes?: ReadonlySet<string>; label?: string } = {},
): TakeDeleteCheck {
  const wanted = new Set(takeIds)
  const found = takes.filter((t) => wanted.has(t.id))
  const ids = found.map((t) => t.id)
  const dead = new Set(ids)
  const finished = found.filter((t) => t.status === 'completed').length
  const usedBy = scenes
    .filter((s) => !opts.ignoreScenes?.has(s.id) && s.videoRefs.some((t) => dead.has(t)))
    .map((s) => ({ id: s.id, order: s.order }))
    .sort((a, b) => a.order - b.order)
  const confirm = opts.confirm ?? true
  const ask = confirm === true ? finished > 0 || usedBy.length > 0 : confirm === 'usedOnly' ? usedBy.length > 0 : false
  if (!ask || !ids.length) return { ids, finished, usedBy, question: null }
  const one = ids.length === 1
  const what = one && opts.label ? opts.label : `${ids.length} video${finished && finished < ids.length ? ` (${finished} video đã tạo xong)` : ''}`
  const lines = [`Xoá vĩnh viễn ${what}? Video đã xoá không hoàn tác được.`]
  if (usedBy.length) {
    lines.push(
      `${one && opts.label ? opts.label : 'Video'} đang được dùng làm @video ở ${usedBy.length} cảnh (${usedBy.map((s) => sceneCode(s.order)).join(', ')}): các tham chiếu đó sẽ bị bỏ.`,
    )
  }
  return { ids, finished, usedBy, question: lines.join('\n') }
}
