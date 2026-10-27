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
 * When to ask before deleting takes: true = when something is lost (a finished video, or credit — see below); false =
 * never. 'usedOnly' = the caller already confirmed that the FILE is lost (a two-click button): it still asks about
 * credit (paidPending / maybeBilled / sentAway), which that click never mentioned.
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
  /**
   * How many are "maybe billed" (`uncertain`: runs.isUncertainSubmit — a request whose answer was lost, or cancelled
   * while it was on its way): deleting one drops the only trace of a job that may have been made and billed (its
   * "Chạy lại" looks that job up first; once it is deleted, a run of its scene may pay again).
   */
  maybeBilled: number
  /**
   * How many still run on canvasapp (or its simulation) with their job sent or maybe sent (`sent`: a job id, or a
   * request that may have reached it — runs.mayHaveBeenSent): deleting one only stops following that job here; it keeps
   * running (billed) there, and "Nhập job" never offers it (SanoVids made it). Imported takes are left out: "Nhập job"
   * offers their jobs again.
   */
  sentAway: number
  /**
   * How many are parked takes of a newer SanoVids build (`parked`: runs.isParkedTake — 'failed' + foreignStatus): their
   * job may still run, and bill, in that build; deleting one here drops the only local record of it.
   */
  parked: number
  /** Confirm text, or null when nothing needs asking. */
  question: string | null
}

/**
 * What deleting `takeIds` loses, and the confirm question to ask (null = no need to ask). `label` names a single take
 * ("S03·T2"). confirm: true = ask when a finished video is lost, a paid video is still downloading (`videoReady` on
 * a running take), a take is "maybe billed" (`uncertain`), its job runs there (`sent` on a running take) or it is a
 * parked take of a newer build (`parked`);
 * 'usedOnly' = only those credit cases; false = never.
 */
export function checkTakeDelete(
  takeIds: readonly string[],
  takes: readonly { id: string; status: JobStatus; videoReady?: boolean; uncertain?: boolean; sent?: boolean; imported?: boolean; parked?: boolean; provider?: string }[],
  opts: { confirm?: TakeDeleteConfirm; label?: string } = {},
): TakeDeleteCheck {
  const wanted = new Set(takeIds)
  const found = takes.filter((t) => wanted.has(t.id))
  const ids = found.map((t) => t.id)
  const finished = found.filter((t) => t.status === 'completed').length
  const pending = found.filter((t) => t.status === 'processing' && t.videoReady === true && t.provider !== 'mock')
  const paidPending = pending.length
  const doubtful = found.filter((t) => t.uncertain === true && t.provider !== 'mock')
  const maybeBilled = doubtful.length
  const away = found.filter((t) => t.status === 'processing' && t.sent === true && t.videoReady !== true && t.imported !== true && t.provider !== 'mock')
  const sentAway = away.length
  const parked = found.filter((t) => t.parked === true).length
  const confirm = opts.confirm ?? true
  const credit = paidPending > 0 || maybeBilled > 0 || sentAway > 0 || parked > 0
  const ask = confirm === true ? finished > 0 || credit : confirm === 'usedOnly' && credit
  if (!ask || !ids.length) return { ids, finished, paidPending, maybeBilled, sentAway, parked, question: null }
  const one = ids.length === 1
  const what = one && opts.label ? opts.label : `${ids.length} video${finished && finished < ids.length ? ` (${finished} video đã tạo xong)` : ''}`
  const lines = [`Xoá vĩnh viễn ${what}? Video đã xoá không hoàn tác được.`]
  // development mode: "credit dev", the job stays in the Bảng phát triển; SANO: the job is in the SANO app (never canvasapp.io.vn)
  const all = (list: typeof found, provider: string) => list.every((t) => t.provider === provider)
  const mixedSano = (list: typeof found) => list.some((t) => t.provider === 'sano-gateway') && !all(list, 'sano-gateway')
  const places = (list: typeof found) => [...new Set(list.map((t) =>
    t.provider === 'sano-gateway' ? 'app SANO' : t.provider === 'dev' ? 'Bảng phát triển (canvasapp giả lập)' : 'canvasapp.io.vn (phiên “SanoVids bridge”)',
  ))].join(' và ')
  if (paidPending) {
    const dev = all(pending, 'dev')
    const who = one && opts.label ? opts.label : `${paidPending} video`
    lines.push(
      mixedSano(pending)
        ? `${who} đã tạo xong nhưng SanoVids chưa tải về xong: xoá sẽ bỏ video đó trong SanoVids; vẫn lấy lại ở hệ thống tương ứng: ${places(pending)}. Chi phí lượt chạy mới theo chế độ của từng hệ thống khi chạy.`
        : dev
          ? `${who} đã tạo xong trên canvasapp giả lập và đã trừ credit dev — SanoVids chưa tải về xong: xoá sẽ bỏ video đó trong SanoVids (job vẫn còn trong Bảng phát triển); chạy lại cảnh sẽ trừ credit dev lần nữa.`
          : all(pending, 'sano-gateway')
            ? `${who} đã tạo xong trên máy chủ SANO — SanoVids chưa tải về xong: xoá sẽ bỏ video đó trong SanoVids (vẫn lấy được trong app SANO); chi phí lượt chạy mới theo chế độ SANO xác nhận khi chạy.`
            : `${who} đã tạo xong trên canvasapp và đã trừ credit — SanoVids chưa tải về xong: xoá sẽ bỏ video đó trong SanoVids (vẫn tải được trên canvasapp.io.vn, phiên “SanoVids bridge”); chạy lại cảnh sẽ trừ credit lần nữa.`,
    )
  }
  if (maybeBilled) {
    const dev = all(doubtful, 'dev')
    const who = one && opts.label ? opts.label : `${maybeBilled} video`
    lines.push(
      mixedSano(doubtful)
        ? `${who}: không rõ job đã được nhận và tính phí chưa — kiểm tra từng job ở hệ thống tương ứng: ${places(doubtful)}. “Chạy lại” trên take tìm job cũ trước khi gửi; xoá thì SanoVids không còn tìm lại job đó, chạy lại cảnh có thể tính phí lần nữa.`
        : dev
          ? `${who}: không rõ canvasapp giả lập đã nhận (và trừ credit dev) chưa — “Chạy lại” trên take tìm job cũ trước khi gửi; xoá thì SanoVids không còn tìm lại job đó, chạy lại cảnh có thể trừ credit dev lần nữa.`
          : all(doubtful, 'sano-gateway')
            ? `${who}: chưa rõ máy chủ SANO đã nhận job chưa — xem trong app SANO; “Chạy lại” trên take tìm job cũ trước khi gửi. Xoá thì SanoVids không còn tìm lại job đó; chi phí lượt chạy mới theo chế độ SANO xác nhận khi chạy.`
            : `${who}: không rõ canvasapp đã nhận (và trừ credit) chưa — “Chạy lại” trên take tìm job cũ trước khi gửi; xoá thì SanoVids không còn tìm lại job đó, chạy lại cảnh có thể trừ credit lần nữa.`,
    )
  }
  if (sentAway) {
    const dev = all(away, 'dev')
    const who = one && opts.label ? opts.label : `${sentAway} video`
    lines.push(
      mixedSano(away)
        ? `${who} có job đã gửi hoặc đang gửi: xoá chỉ bỏ theo dõi trong SanoVids; job vẫn chạy ở hệ thống tương ứng: ${places(away)}. Chi phí tùy hệ thống và chế độ; chạy lại cảnh có thể tính phí lần nữa.`
        : dev
          ? `${who} đang chạy trên canvasapp giả lập (job đã gửi hoặc đang gửi — có thể đã trừ credit dev): xoá chỉ bỏ theo dõi trong SanoVids, job vẫn chạy trong Bảng phát triển; chạy lại cảnh có thể trừ credit dev lần nữa.`
          : all(away, 'sano-gateway')
            ? `${who} có job đã gửi hoặc đang gửi sang máy chủ SANO: xoá chỉ bỏ theo dõi trong SanoVids, job vẫn chạy trên SANO (xem trong app SANO); chi phí lượt chạy mới theo chế độ SANO xác nhận khi chạy.`
            : `${who} đang chạy trên canvasapp (job đã gửi hoặc đang gửi — có thể đã trừ credit): xoá chỉ bỏ theo dõi trong SanoVids, job vẫn chạy trên canvasapp.io.vn (phiên “SanoVids bridge”); chạy lại cảnh có thể trừ credit lần nữa.`,
    )
  }
  if (parked) {
    const who = one && opts.label ? opts.label : `${parked} video`
    lines.push(`${who} có thể vẫn đang chạy (và tính credit) ở bản SanoVids mới hơn: xoá ở đây không huỷ job đó.`)
  }
  return { ids, finished, paidPending, maybeBilled, sentAway, parked, question: lines.join('\n') }
}
