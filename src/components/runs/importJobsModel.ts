// "Nhập job" dialog (ImportJobsDialog): every text and rule as pure functions — tested in
// __tests__/importJobsModel.test.ts. Words follow the gateway: canvasapp.io.vn (real credits) or the development-mode
// simulation ("canvasapp giả lập", credit dev). The rules themselves live in providers/canvasapp/siteJobs.ts.
import { sceneCode } from '../../core/compile'
import { MODELS } from '../../core/models'
import type { Scene } from '../../core/types'
import { MAX_IMPORT_BATCH, type SiteJobCandidate, type SiteJobScan, type SiteJobSkip } from '../../providers/canvasapp/siteJobs'
import type { ImportTakesResult } from '../../store/runs'

export interface ImportWords {
  simulated: boolean
  /** "canvasapp.io.vn" | "canvasapp giả lập" */
  site: string
  /** "credit" | "credit dev" */
  credit: string
  /**
   * How long a job just made on the site may take to show: the gateway answers the job list from its cache — main for
   * 15 s (CANVASAPP_JOBS_MIN_MS), the simulated bridge for 2 s (DEV_JOB_LIST_CACHE_MS).
   */
  listDelay: string
}

export const importWords = (simulated: boolean): ImportWords =>
  simulated
    ? { simulated, site: 'canvasapp giả lập', credit: 'credit dev', listDelay: 'vài giây' }
    : { simulated, site: 'canvasapp.io.vn', credit: 'credit', listDelay: '~15 giây' }

export const importTitle = (w: ImportWords) => (w.simulated ? 'Nhập job từ canvasapp giả lập' : 'Nhập job từ canvasapp')

export const importLead = (w: ImportWords) =>
  `Video bạn đã tạo trực tiếp trên ${w.site} trong phiên “SanoVids bridge” (bấm “Tạo video” trên node của một cảnh) được đưa vào dự án này thành take của đúng cảnh đó. Chỉ đọc — không gửi yêu cầu tạo video, không trừ ${w.credit}.`

export const LOADING_TEXT = 'Đang đọc danh sách job của phiên “SanoVids bridge”…'

export const noBridgeText = (w: ImportWords) =>
  `Chưa có phiên “SanoVids bridge” trên ${w.site} — chưa có job nào để nhập. Phiên được tạo khi bạn chạy cảnh đầu tiên.`

export const emptyText = (w: ImportWords) =>
  `Không có job mới nào để nhập. Job vừa tạo trên ${w.site} có thể mất tới ${w.listDelay} mới hiện ở đây — bấm “Quét lại”.`

/** The button that answers a 401: log in, then scan again. */
export const loginButtonText = (w: ImportWords) => (w.simulated ? 'Đăng nhập' : 'Đăng nhập canvasapp')

export const reimportTitle = (w: ImportWords) =>
  `Job này đã được nhập vào một take trước đây (take đã xoá, hoặc ở dự án khác có cùng cảnh). Nhập lại không trừ ${w.credit}.`

/** Tooltip of a job's name in the list. */
export const jobNameTitle = (name: string) => `Tên job: ${name}`

export const footNote = (w: ImportWords) =>
  `Không trừ ${w.credit}: video đã được trả khi tạo trên ${w.site}. Video đang tạo được theo dõi và tự tải về khi xong (bật “Tự tải video” thì mỗi video cũng được lưu về máy). Take nhập không chiếm chỗ trong hàng đợi gửi. “Chạy lại” một take đã nhập tạo take MỚI và trừ ${w.credit} như bình thường.`

export const capNote = (picked: number): string | null =>
  picked > MAX_IMPORT_BATCH ? `Mỗi lần nhập tối đa ${MAX_IMPORT_BATCH} job (SanoVids đọc prompt từng job, nhẹ nhàng với canvasapp) — bỏ bớt rồi nhập phần còn lại sau.` : null

export const importButtonText = (n: number, busy: boolean) => (busy ? 'Đang nhập…' : n ? `Nhập ${n} job` : 'Nhập job')

/** What the job list says of the job right now. */
export function candidateStatusText(c: Pick<SiteJobCandidate, 'state' | 'progress' | 'job'>): string {
  if (c.state === 'queued') return 'Đang chờ'
  if (c.state === 'completed') return c.job.download_available === false ? 'Đã xong — chưa cho tải' : 'Đã xong'
  return c.progress !== null ? `Đang tạo ${Math.max(0, Math.min(99, Math.round(c.progress)))}%` : 'Đang tạo'
}

/** "Seedance 2.5 · 15s · 16:9" — only what the job list says. */
export function candidateSettingsText(c: Pick<SiteJobCandidate, 'model' | 'duration' | 'ratio'>): string {
  return [MODELS[c.model]?.name ?? c.model, c.duration !== null ? `${c.duration}s` : null, c.ratio].filter(Boolean).join(' · ')
}

const two = (n: number) => String(n).padStart(2, '0')
/**
 * "tạo lúc 14:32 06/10" (local time) or "" when canvasapp did not say; a created_at without a time zone is shown as
 * canvasapp wrote it, said so ("(giờ canvasapp)") — never converted as if it were this computer's time.
 */
export function candidateTimeText(c: Pick<SiteJobCandidate, 'createdAt'> & Partial<Pick<SiteJobCandidate, 'createdWall'>>): string {
  if (c.createdAt === null) return c.createdWall ? `tạo lúc ${c.createdWall} (giờ canvasapp)` : ''
  const d = new Date(c.createdAt)
  return `tạo lúc ${two(d.getHours())}:${two(d.getMinutes())} ${two(d.getDate())}/${two(d.getMonth() + 1)}`
}

/** Ticked when the dialog opens: new jobs (up to the batch cap); jobs imported before stay unticked. */
export function defaultPicks(candidates: readonly Pick<SiteJobCandidate, 'jobId' | 'reimport'>[]): string[] {
  return candidates
    .filter((c) => !c.reimport)
    .slice(0, MAX_IMPORT_BATCH)
    .map((c) => c.jobId)
}

export interface CandidateGroup {
  sceneId: string
  /** "S03 · Tiêu đề" */
  heading: string
  items: SiteJobCandidate[]
}

/** Candidates by scene (scene order, as the scan sorted them); a scene deleted meanwhile is "S?? · cảnh đã xoá". */
export function groupByScene(candidates: readonly SiteJobCandidate[], scenes: readonly Pick<Scene, 'id' | 'order' | 'title'>[]): CandidateGroup[] {
  const byId = new Map(scenes.map((s) => [s.id, s]))
  const out: CandidateGroup[] = []
  for (const c of candidates) {
    let g = out.find((x) => x.sceneId === c.sceneId)
    if (!g) {
      const s = byId.get(c.sceneId)
      g = { sceneId: c.sceneId, heading: s ? `${sceneCode(s.order)} · ${s.title || 'Chưa đặt tên'}` : 'S?? · cảnh đã xoá', items: [] }
      out.push(g)
    }
    g.items.push(c)
  }
  return out
}

const SKIP_ORDER: SiteJobSkip[] = ['maybe-pending', 'in-project', 'sanovids', 'no-scene', 'ended', 'no-download', 'not-canvas', 'unsupported-model', 'bad-id']

/**
 * The "Không nhập được (N)" lines, one per reason. `pendingLabel(takeId)` names a take of the open project ("S03·T2")
 * whose unanswered POST may own a job, null when it is not in this project (deleted, or another project).
 * 'maybe-pending' never promises a time: such a job is held for as long as that take has not found its job, whenever
 * that is — only jobs made within `windowHours` around its POST (14 h, 27 h for a created_at without a time zone) are
 * held when the list does not carry client_request_id. A deleted take never looks again: its job is never importable.
 */
export function skipLines(scan: Pick<SiteJobScan, 'skipped'>, w: ImportWords, pendingLabel: (takeId: string) => string | null): { code: SiteJobSkip; text: string }[] {
  const out: { code: SiteJobSkip; text: string }[] = []
  for (const code of SKIP_ORDER) {
    const items = scan.skipped.filter((s) => s.code === code)
    if (!items.length) continue
    const n = items.length
    switch (code) {
      case 'maybe-pending': {
        const labelOf = (s: (typeof items)[number]) => (s.pendingTakeId ? pendingLabel(s.pendingTakeId) : null)
        const mine = items.filter((s) => labelOf(s) !== null)
        const gone = n - mine.length
        const parts: string[] = []
        if (mine.length) {
          const labels = [...new Set(mine.map((s) => labelOf(s)!))]
          const hours = [...new Set(mine.map((s) => s.windowHours).filter((h): h is number => typeof h === 'number'))].sort((a, b) => a - b)
          const window = hours.length ? ` (chỉ giữ job tạo trong khoảng ${hours.length > 1 ? `${hours[0]}–${hours[hours.length - 1]}` : hours[0]} giờ quanh lần gửi đó)` : ''
          parts.push(
            `Có thể là job của take “không rõ đã gửi” (${labels.join(', ')}): ${mine.length} job — chưa nhập được tới khi take đó tìm ra job của nó${window}. Bấm “Chạy lại” trên take đó: SanoVids tìm job trước, không trả hai lần.`,
          )
        }
        if (gone) {
          const fetch = w.simulated ? 'xem job đó trong Bảng phát triển' : `tải video trên ${w.site} (phiên “SanoVids bridge”)`
          parts.push(
            `Có thể là job của một take “không rõ đã gửi” đã xoá hoặc ở dự án khác: ${gone} job — không nhập được ở đây. Take ở dự án khác: mở dự án đó rồi bấm “Chạy lại” trên take đó; take đã xoá: job đó không nhập được nữa — ${fetch}.`,
          )
        }
        out.push({ code, text: parts.join(' ') })
        break
      }
      case 'in-project':
        out.push({ code, text: `Đã có trong dự án: ${n} job` })
        break
      case 'sanovids':
        out.push({ code, text: `Do SanoVids tạo (take đã xoá hoặc ở dự án khác): ${n} job` })
        break
      case 'no-scene':
        out.push({ code, text: `Không thuộc cảnh nào của dự án đang mở: ${n} job` })
        break
      case 'ended':
        out.push({ code, text: `Lỗi / đã huỷ / hết hạn (không có video): ${n} job` })
        break
      case 'no-download':
        out.push({ code, text: `Đã xong nhưng ${w.site} không cho tải nữa: ${n} job` })
        break
      case 'not-canvas':
        out.push({ code, text: `Không phải job của canvas: ${n} job` })
        break
      case 'unsupported-model':
        out.push({ code, text: `Model SanoVids chưa hỗ trợ: ${n} job` })
        break
      case 'bad-id':
        out.push({ code, text: `Mã job không hợp lệ: ${n} job` })
        break
    }
  }
  return out
}

/** The toast after "Nhập": what came in (scene codes), what did not and why. `codes` = scene codes of the new takes. */
export function importToastText(res: ImportTakesResult, codes: readonly string[], w: ImportWords): { text: string; ok: boolean } {
  if (res.skipped.some((s) => s.code === 'project-changed')) return { text: 'Đã mở dự án khác — chưa nhập gì.', ok: false }
  const n = res.takeIds.length
  const missed = res.skipped.length
  const why = missed ? `${missed} job không nhập được (đã có trong dự án, cảnh đã bị xoá, hoặc đang chờ xác minh)` : ''
  if (!n) return { text: `Chưa nhập được job nào${why ? ` — ${why}` : ''}.`, ok: false }
  const where = [...new Set(codes)].join(', ')
  return { text: `Đã nhập ${n} video từ ${w.site} vào ${where} — không trừ ${w.credit}.${why ? ` ${why[0].toUpperCase()}${why.slice(1)}.` : ''}`, ok: true }
}

export const dropToastText = (n: number, w: ImportWords) =>
  `Đã bỏ ${n} take vừa nhập — job vẫn còn trên ${w.site}; “Nhập job” để nhập lại (không trừ ${w.credit}).`
