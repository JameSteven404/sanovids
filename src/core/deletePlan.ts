// Pure rules for deleting takes (video nodes) — used by actions.deleteSelection / actions.deleteTakes and the Delete
// key. No stores: unit-tested in ./__tests__/deletePlan.test.ts.
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

/**
 * When to ask before deleting takes: always when something is lost (or paid and not downloaded yet), or never.
 * 'usedOnly' (the caller already confirmed the loss, e.g. a two-click button) asked only when scenes used the take as
 * @video — reference videos were retired (0.6.0), so it never asks now; kept for its callers.
 */
export type TakeDeleteConfirm = boolean | 'usedOnly'

export interface TakeDeleteCheck {
  /** Takes that exist among the requested ids. */
  ids: string[]
  /** How many of them are finished videos (lost for good). */
  finished: number
  /**
   * How many are still running although their video is already made and paid (runs.remoteVideoReady: downloading, or
   * waiting for the next try) — deleting one drops that paid video in SanoVids, like "Huỷ" (creditText.cancelQuestion).
   */
  paidPending: number
  /** Confirm text, or null when nothing needs asking. */
  question: string | null
}

/**
 * What deleting `takeIds` loses, and the confirm question to ask (null = no need to ask). `label` names a single take
 * ("S03·T2"). confirm: true = ask when a finished video is lost or a paid video is still downloading (`videoReady` on
 * a running take); 'usedOnly' / false = never.
 */
export function checkTakeDelete(
  takeIds: readonly string[],
  takes: readonly { id: string; status: JobStatus; videoReady?: boolean; provider?: string }[],
  opts: { confirm?: TakeDeleteConfirm; label?: string } = {},
): TakeDeleteCheck {
  const wanted = new Set(takeIds)
  const found = takes.filter((t) => wanted.has(t.id))
  const ids = found.map((t) => t.id)
  const finished = found.filter((t) => t.status === 'completed').length
  const pending = found.filter((t) => t.status === 'processing' && t.videoReady === true && t.provider !== 'mock')
  const paidPending = pending.length
  const ask = (opts.confirm ?? true) === true && (finished > 0 || paidPending > 0)
  if (!ask || !ids.length) return { ids, finished, paidPending, question: null }
  const one = ids.length === 1
  const what = one && opts.label ? opts.label : `${ids.length} video${finished && finished < ids.length ? ` (${finished} video đã tạo xong)` : ''}`
  const lines = [`Xoá vĩnh viễn ${what}? Video đã xoá không hoàn tác được.`]
  if (paidPending) {
    // development mode: "credit dev", the job stays in the Bảng phát triển (never canvasapp.io.vn)
    const dev = pending.every((t) => t.provider === 'dev')
    const who = one && opts.label ? opts.label : `${paidPending} video`
    lines.push(
      dev
        ? `${who} đã tạo xong trên canvasapp giả lập và đã trừ credit dev — SanoVids chưa tải về xong: xoá sẽ bỏ video đó trong SanoVids (job vẫn còn trong Bảng phát triển); chạy lại cảnh sẽ trừ credit dev lần nữa.`
        : `${who} đã tạo xong trên canvasapp và đã trừ credit — SanoVids chưa tải về xong: xoá sẽ bỏ video đó trong SanoVids (vẫn tải được trên canvasapp.io.vn, phiên “SanoVids bridge”); chạy lại cảnh sẽ trừ credit lần nữa.`,
    )
  }
  return { ids, finished, paidPending, question: lines.join('\n') }
}
