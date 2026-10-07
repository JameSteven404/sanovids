// VideoProvider for canvasapp.io.vn (experimental, desktop only, OFF by default).
// Uses the user's own canvasapp account and credits through the Electron session (no password ever reaches SanoVids).
//
// submit:  read /api/video-profiles (cached; unreadable → canvasapp's fallbacks) and refuse what canvasapp's page
//          would not run (H3 transform: also frames of different / unsupported ratios) → ensure the "SanoVids bridge"
//          project (created once — POST without body, then PATCH its name, like canvasapp's own page — id
//          remembered) → another take's unanswered POST on the take's node whose job a read sent now could not surely
//          show yet (rivalWait) → 'deferred' for this take alone (retryAfterMs; nothing sent) → room on the bridge
//          canvas next to the nodes whose jobs still run (never taken off; no room → 'deferred': back to the queue,
//          nothing sent) → check every reference image is on this computer → upload the
//          missing ones (cache: SanoVids imageId → upload_id) → PUT a minimal bridge canvas (so canvas_node_id exists;
//          its entries are remembered only once accepted, without the ones left off it; refused → once more without
//          the nodes whose jobs have ended) → read the job list right before EVERY POST (its jobs on the node = the
//          POST's `before`, `beforeAt`; reused only when the gateway would answer from its own cache anyway and it
//          surely shows the job of every other unanswered POST on the node; unreadable → sent with the last read,
//          unless there is none or it does not → not sent) → POST
//          /api/video-jobs with client_request_id = clientRequestIdFor(take id), a UUID stable per take.
//          Every body has exactly the client's shape (see mapping.ts and docs/canvasapp-api-notes.md).
// nodes:   one video node per scene OF A PROJECT (sceneNodeKey(sanovidsProjectId, sceneId)): projects sharing scene
//          ids (Nhân bản dự án, a file imported twice) never share one. Nodes named by the bare scene id (builds
//          before per-project nodes: "legacy") stay valid — their entries and running jobs keep them, and a take
//          re-sent after such a build lost its answer goes to THAT node again (nodeKeyFor).
// limits:  settingsLimits() = what that cached /api/video-profiles answer refuses (mapping.profileIssues, the rule of
//          the submit check) for the inspector and the run check — synchronous, never a request; refreshLimits() reads
//          it again for the UI (TTL-gated, shares the submit's read, a failed UI read never replaces a fresh OK list;
//          `changed` after a login / a change of the site: no "Đọc lại" limit, a request sent after the call);
//          onLimitsChange tells the app (see "/api/video-profiles: one cache" below for the invariants).
// poll:    ONE GET /api/video-jobs?project_id=… for all running takes, never more often than every 15 s.
// result:  GET /api/video-jobs/{id}/stream → MP4 blob (the engine extracts the poster frame); the desktop transport
//          pulls it in pieces (progress, abort when the take is cancelled, resume when canvasapp allows it).
//
// Paying at most once per take (key = req.key = the take id; sent as clientRequestIdFor(key)). Persisted under
// JOBS_KEY (keyed by the take id), written synchronously:
//   - `jobs[key]`: the job canvasapp created for the key. A key with a known job is never posted again.
//   - `sent[key]`: written right BEFORE the POST (with that read's `before` / `beforeAt`; `endedAt` once its outcome
//     came back), removed once its answer is known. Storage did not keep it (full, blocked) → not sent at all
//     (LEDGER_NOT_SAVED_TEXT; a POST sent again after a lost answer: "không rõ" instead). If the answer never arrives (connection broke, page closed /
//     reloaded), the job may exist and be billed: it is looked for in the bridge project's job list (findJob: same
//     client_request_id when the list carries it, else the one new job on the canvas node the POST named, created
//     within inPostWindow (a time it cannot surely read: it could be) — never one another take's unanswered POST on
//     that node may have made: the read before each POST (no POST is sent without one) tells their jobs apart, a POST
//     without a known end may still be on its way (listedBy)) — by recover()
//     after a reload (at once, and once more when a read can surely show it, ≤ SETTLE_MS + the cache later), and before
//     any new POST of that key (not re-posted while that earlier POST may still make its job: STILL_SENDING_TEXT).
//     Records stamped later than now (the clock was set back) are rewritten to now once (unskewed).
//   - The ledger is read from storage at every use and merged per record (ledgerNow): another tab of the web dev mode
//     writes it too.
//   - POST answered with a network error / 5xx / no job id → wait, look for the job (2 reads: 15 s after its outcome,
//     then once a read surely shows its job — SETTLE_MS + the gateway's cache, 45 s after it); not in that read
//     → post again ONCE with the same body and key; that read failed, or still nothing → error flagged `uncertain` (the engine then shows
//     "không rõ đã trả chưa" and never resubmits that take under a new key by itself).
//   - opts.isCancelled() → stop before uploading / posting: a take cancelled while it waits here is never billed.
//   - `imported[key]`: a job made on canvasapp's own page that became the take `key` ("Nhập job": scanSiteJobs →
//     siteJobPrompts → claimSiteJobs, rules in siteJobs.ts). Such a key is never posted either; the import itself
//     only reads (GET), and never offers a job an unanswered POST may own (sentMayOwn, checked again at claim time).
import { normalizeSettings } from '../../core/models'
import type { ModelId, VideoSettings } from '../../core/types'
import { CANVASAPP_MAX_REF_VIDEOS, capabilitiesFromModels } from '../capabilities'
import {
  NO_LIMITS,
  type JobRequest,
  type LimitField,
  type LimitsInfo,
  type ProviderAvailability,
  type ProviderCapabilities,
  type ProviderId,
  type RefreshLimitsOptions,
  type RefreshLimitsResult,
  type RemoteStatus,
  type SettingsIssue,
  type SettingsLimits,
  type SubmitOptions,
  type VideoProvider,
} from '../types'
import { CanvasappError, canvasappErrorText, isLoginRequired, type CanvasappApi, type CanvasJob, type VideoJobBody, type VideoProfile } from './api'
import {
  classifySiteJobs,
  hintsFor,
  inPostWindow,
  listedDuration,
  MAX_IMPORT_BATCH,
  normalizeImportPrompt,
  sentMayOwn,
  type SiteJobClaim,
  type SiteJobScan,
} from './siteJobs'
import {
  ALLOWED_IMAGE_TYPES,
  BRIDGE_PROJECT_NAME,
  bridgeEntriesFrom,
  canvasNodeId,
  clientRequestIdFor,
  decodeRemoteId,
  encodeRemoteId,
  entryFromRequest,
  imagesToUpload,
  inputShapeOf,
  jobIdFromCreateResponse,
  mapJobStatus,
  modelProfileOf,
  planBridgeCanvas,
  profileIssues,
  profilesSignature,
  ratioFromDimensions,
  sceneNodeKey,
  toVideoJobBody,
  transformFrameRatio,
  uploadFilename,
  validateRequest,
  type BridgeEntry,
} from './mapping'

/** Never poll canvasapp more often than this (the site itself polls every 60 s). */
export const MIN_POLL_MS = 15_000
export const DEFAULT_POLL_MS = 20_000
/**
 * Jobs running at the same time through the gateway. Only the job list is polled (one read per cycle for all of them,
 * ≥ MIN_POLL_MS apart), submits are serialised (`chain`), and electron/main.cjs keeps API calls and video downloads
 * in separate small lanes — so 10 running jobs do not mean 10 parallel requests.
 */
export const MAX_CONCURRENCY = 10
/** A job missing from the list this many polls in a row is reported as failed. */
const MAX_MISSES = 3
/**
 * A job a POST made is in the job list this long after the POST's answer (or error) came back, or never (the bet every
 * rule below makes). So a read showing what existed this long after a POST ended shows its job, if it has one
 * (listedBy): postJob only posts again after such a read found nothing, and a take is only posted next to another
 * take's unanswered POST on its node once the read before its POST shows that much (rivalWait).
 */
export const SETTLE_MS = 30_000
/**
 * After a POST /api/video-jobs without a clear answer: wait this long before each look at the job list — the last one
 * longer when needed: until a read sent then surely shows the POST's job (listedBy + the gateway's own cache time,
 * coverableAt: 45 s after the outcome through main's 15 s cache), never longer than that from now. Only a "none" of
 * such a read lets postJob post again. recover() looks at once, then like the last look here.
 */
export const RECONCILE_DELAYS_MS = [15_000, 15_000]
/**
 * How long electron/main.cjs may still be sending a POST after the page that sent it went away (reload, crash — main
 * keeps the request): its 60 s per request once sent, after the wait for one of its 2 'api' slots behind the few
 * requests a page has in flight (each ≤ 60 s too). A POST without a known outcome (SentRecord.endedAt) ends by then.
 */
const POST_IN_FLIGHT_MS = 5 * 60_000
// CREATED_SKEW_MS / POST_WINDOW_MS (which jobs a POST may have made: inPostWindow): siteJobs.ts, shared with the import's
// reservation rule.
const MAX_JOB_RECORDS = 500
const MAX_SENT_RECORDS = 100
const MAX_IMPORTED_RECORDS = 500
/** /api/video-profiles is read again after this long (canvasapp's page reads it once per page load). */
export const PROFILES_TTL_MS = 10 * 60_000
/**
 * ...and after a failed read, on the next submit once this long has passed (meanwhile the client's fallbacks apply).
 * Also the pause of the UI's automatic reads (refreshLimits) after any failed attempt — a 401 included.
 */
export const PROFILES_RETRY_MS = 60_000
/**
 * A forced refreshLimits() ("Đọc lại") sends at most one read this often, whatever came of the last one — only the
 * clicks: a read after a login / a change (`changed`) is never held back by it.
 */
export const PROFILES_FORCE_MIN_MS = 5_000

export const UNCERTAIN_SUBMIT_TEXT =
  'Mất kết nối đúng lúc gửi yêu cầu tạo video: không rõ canvasapp đã nhận (và trừ credit) hay chưa — kiểm tra trên canvasapp.io.vn trước khi chạy lại.'
const CANCELLED_TEXT = 'Đã huỷ trước khi gửi sang canvasapp — không bị trừ credit.'
/** "Chạy lại" of a take whose earlier POST may still be on its way (or its job not listed yet): not posted again yet. */
export const STILL_SENDING_TEXT =
  'Chưa thấy job của lần gửi trước trên canvasapp, nhưng lần gửi đó có thể vẫn đang được xử lý (trang tải lại hoặc mất kết nối đúng lúc gửi) — chưa gửi lại để không bị trừ credit hai lần. Thử lại sau vài phút.'
/**
 * Another take of the scene was just sent without a known answer, and a job-list read cannot surely show its job yet:
 * this take waits (back to the queue, code 'deferred', nothing sent) so the two can always tell their jobs apart.
 */
export const RIVAL_PENDING_TEXT =
  'Một take khác của cảnh này vừa gửi sang canvasapp mà chưa rõ kết quả — take này chờ tới khi danh sách job chắc chắn hiện job của take kia rồi mới gửi (chưa gửi, không bị trừ credit).'
/** "Chạy lại" of a take whose earlier POST lost its answer: the job list could not be read to look for its job. */
export const LOOKUP_FAILED_TEXT =
  'Không đọc được danh sách job trên canvasapp để tìm job của lần gửi trước — chưa gửi lại (lần gửi trước vẫn chưa rõ đã bị trừ credit chưa). Thử lại sau ít phút.'
/**
 * Another take's POST on the same node has no answer yet: the job list must be read right before this POST (so each
 * take can later tell its job from the other's) and could not be. Nothing was sent.
 */
export const LIST_NEEDED_TEXT =
  'Không đọc được danh sách job trên canvasapp — cần đọc ngay trước khi gửi vì một take khác của cảnh này chưa rõ đã được canvasapp nhận chưa. Chưa gửi yêu cầu tạo video, không bị trừ credit.'
/**
 * The job list could not be read right before this POST and has not been read since the app started (or the login):
 * a POST is only ever sent with a read before it (its `before`: the jobs that are surely not its own). Nothing was sent.
 */
export const LIST_FIRST_TEXT =
  'Không đọc được danh sách job trên canvasapp — cần đọc nó trước khi gửi, để nếu mất câu trả lời vẫn nhận ra đúng job của take này. Chưa gửi yêu cầu tạo video, không bị trừ credit.'
/** ...for a take whose earlier POST lost its answer (that one may still have been billed). */
export const LIST_NEEDED_AFTER_LOST_TEXT =
  'Không đọc được danh sách job trên canvasapp — cần đọc ngay trước khi gửi vì một take khác của cảnh này chưa rõ đã được canvasapp nhận chưa. Lần này chưa gửi lại yêu cầu tạo video (lần gửi trước vẫn chưa rõ đã bị trừ credit chưa).'
/**
 * The record of a POST about to be sent could not be saved on this computer (storage full or blocked): not sent — a
 * POST is only ever sent once its record is saved, so a reload can never lead to paying for it twice.
 */
export const LEDGER_NOT_SAVED_TEXT =
  'Không ghi được sổ gửi job vào bộ nhớ của SanoVids trên máy này (đầy hoặc bị chặn) — chưa gửi yêu cầu tạo video, không bị trừ credit. SanoVids chỉ gửi khi đã ghi lại được, để không bao giờ trả tiền hai lần cho một take.'
/** ...for a take whose earlier POST lost its answer (that one may still have been billed). */
export const LEDGER_NOT_SAVED_AFTER_LOST_TEXT =
  'Không ghi được sổ gửi job vào bộ nhớ của SanoVids trên máy này (đầy hoặc bị chặn) — lần này chưa gửi lại yêu cầu tạo video (lần gửi trước vẫn chưa rõ đã bị trừ credit chưa).'
/** Prefixed to a failed canvas PUT: the job POST is only ever sent after the canvas was accepted. */
export const CANVAS_NOT_SAVED_TEXT = 'Lưu canvas cầu nối trên canvasapp không thành công — chưa gửi yêu cầu tạo video, không bị trừ credit.'
/** ...for a take whose earlier POST lost its answer (that one may still have been billed). */
export const CANVAS_NOT_SAVED_AFTER_LOST_TEXT =
  'Lưu canvas cầu nối trên canvasapp không thành công — lần này chưa gửi lại yêu cầu tạo video (lần gửi trước vẫn chưa rõ đã bị trừ credit chưa).'
/**
 * The bridge canvas has no room for this scene next to the scenes whose jobs still run (their nodes are never taken
 * off it): the take goes back to the queue (code 'deferred'), nothing was sent.
 */
export const CANVAS_FULL_TEXT = 'Canvas cầu nối trên canvasapp đang kín chỗ bởi các cảnh còn đang chạy — chờ một video xong rồi tự gửi (chưa gửi, không bị trừ credit).'
/** Job statuses after which a job no longer needs its node on the bridge canvas. */
const ENDED_JOB_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'expired'])
/** Appended to a refusal decided with canvasapp's fallback profiles (/api/video-profiles could not be read). */
export const PROFILES_FALLBACK_TEXT = '(Không đọc được cấu hình model từ canvasapp nên dùng cấu hình mặc định như trang canvasapp: MiniMax-H3 tạm khoá — thử lại sau.)'

export interface KeyValueStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export const memoryStorage = (): KeyValueStorage => {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) }
}

/**
 * localStorage as a KeyValueStorage. `prefix` namespaces every key (the dev-mode provider uses one, so its bridge
 * project, upload cache and job ledger never mix with the real canvasapp ones).
 */
export const browserStorage = (prefix = ''): KeyValueStorage => ({
  get: (k) => {
    try {
      return localStorage.getItem(prefix + k)
    } catch {
      return null
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(prefix + k, v)
    } catch {
      /* ignore */
    }
  },
  remove: (k) => {
    try {
      localStorage.removeItem(prefix + k)
    } catch {
      /* ignore */
    }
  },
})

export interface CanvasappProviderDeps {
  api: CanvasappApi
  /** Provider id / label (default 'canvasapp' / 'canvasapp.io.vn'). The dev mode runs this same adapter as 'dev'. */
  id?: ProviderId
  label?: string
  /**
   * Polling floor (default MIN_POLL_MS = 15 s, for the real site). Also declared to the engine
   * (VideoProvider.minPollIntervalMs) when given. Only the in-app dev simulator passes less.
   */
  minPollMs?: number
  /**
   * How long a job-list answer is reused (default minPollMs). It is stamped when the answer ARRIVES: keep it below the
   * poll interval minus the latency, or every other poll is served from the cache (the dev simulator: 2 s under 3 s).
   */
  listCacheMs?: number
  /**
   * How old a job-list answer of the GATEWAY itself may be: electron/main.cjs serves GET /api/video-jobs from its own
   * cache for CANVASAPP_JOBS_MIN_MS (15 s, the default here), the dev bridge for DEV_JOB_LIST_CACHE_MS — both timed
   * from when the cached answer's request was SENT. A read is only trusted to show what existed this long before it
   * was sent (SentRecord.beforeAt).
   */
  gatewayListCacheMs?: number
  /** Media-store lookup (lib/imageStore getBlob). */
  getBlob: (imageId: string) => Promise<Blob | null>
  storage?: KeyValueStorage
  now?: () => number
  /** Waits between looks at the job list after an unanswered POST (tests: fake timers). Default setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** ≥ minPollMs (MIN_POLL_MS by default). */
  pollIntervalMs?: number
  generateAudio?: () => boolean
  /** Pixel size of a picture (H3 transform frames' ratio); null = unreadable. Default createImageBitmap. */
  imageSize?: (blob: Blob) => Promise<{ width: number; height: number } | null>
  /**
   * Called when what settingsLimits() / limitsInfo() return may have changed (a read started or ended, reset). The app
   * bumps its revision signal there (providers/index useProviderLimits). Must not throw.
   */
  onLimitsChange?: () => void
}

interface GatewayState {
  projectId: string | null
  /** SanoVids media-store imageId → canvasapp upload_id */
  uploads: Record<string, string>
  /** node key (mapping.sceneNodeKey; a bare scene id for entries of older builds) → bridge entry */
  entries: Record<string, BridgeEntry>
}

/** A POST /api/video-jobs that was sent and whose answer is not known (yet). */
interface SentRecord {
  projectId: string
  nodeId: string
  /** Local time just before the request was sent (the second one, once it was sent again). */
  at: number
  /** Job ids already on that canvas node before the POST (the read it went out with; records of earlier builds may lack it). */
  before?: string[]
  /**
   * The latest time that read is sure to show every job made before it (local time): when it was SENT, minus how
   * long the gateway may serve a cached answer (gatewayListCacheMs). Records of earlier builds do not say.
   */
  beforeAt?: number
  /**
   * When the answer (or error) of the POST sent at `at` came back (local time). Missing: the page went away while it
   * was being sent — main may still be sending it — or a record of an earlier build.
   */
  endedAt?: number
}

/**
 * A job-list read showing what existed at this time (or later) shows the job POST `r` made, if it made one: SETTLE_MS
 * after its outcome came back — or, not known (endedAt), after the longest main may still have been sending it.
 */
const listedBy = (r: SentRecord) => (r.endedAt ?? r.at + POST_IN_FLIGHT_MS) + SETTLE_MS

/** One job-list read. */
interface ListRead {
  /** When the answer arrived (the poll's cache, which nodes still run). */
  at: number
  /** When its request was sent: the gateway's own cache of it is timed from here (the read before a POST). */
  sent: number
  /** It shows every job made before this time (local): when it was sent, less the gateway's own cache time. */
  shows: number
  /** Job POSTs sent before it was sent (`postsSent`): a later one makes the gateway drop its cached list. */
  posts: number
  jobs: CanvasJob[]
}

/** Per idempotency key (take id): what canvasapp was asked to create and what it created. Survives logout. */
interface JobLedger {
  /** `nodeId`: the bridge canvas node of the job (v0.2.5+), kept on the canvas while the job runs. */
  jobs: Record<string, { remoteId: string; at: number; nodeId?: string }>
  sent: Record<string, SentRecord>
  /**
   * Jobs made on canvasapp's own page that became takes ("Nhập job", claimSiteJobs): take id → the job, when it was
   * claimed (local time). A key here is never posted (submitNow / recover return its job). Kept apart from `jobs`
   * (jobs SanoVids made, whose nodes it keeps); findJob never takes a claimed job for any POST: one
   * claimed before the POST was listed before it, one claimed after passed sentMayOwn against that POST's record.
   */
  imported: Record<string, { remoteId: string; at: number; nodeId: string }>
}

/** Ledger records read back from storage, keeping only `{ remoteId: string, at: number, … }` ones. */
function recordsFrom<T extends { remoteId: string; at: number }>(raw: unknown, keep: (r: Record<string, unknown>) => boolean = () => true): Record<string, T> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const r = v as Record<string, unknown>
    if (typeof r.remoteId === 'string' && r.remoteId && typeof r.at === 'number' && Number.isFinite(r.at) && keep(r)) out[k] = r as unknown as T
  }
  return out
}

const EMPTY_LEDGER: JobLedger = { jobs: {}, sent: {}, imported: {} }

/** The ledger stored as `raw` (null = none yet → empty); null when it is not a ledger. */
function parseLedger(raw: string | null): JobLedger | null {
  if (raw === null) return EMPTY_LEDGER
  try {
    const p = JSON.parse(raw) as Partial<JobLedger> | null
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null
    return {
      jobs: p.jobs && typeof p.jobs === 'object' ? p.jobs : {},
      sent: p.sent && typeof p.sent === 'object' ? p.sent : {},
      // a ledger of a build before "Nhập job" has none; malformed records are dropped
      imported: recordsFrom(p.imported, (r) => typeof r.nodeId === 'string'),
    }
  } catch {
    return null
  }
}

const sameRecord = (a: unknown, b: unknown) => a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b))

/**
 * Three-way merge per record: storage's (`theirs`) where it changed since `base` (what this tab last saw there —
 * another tab wrote or removed it), else this tab's (`mine`: what it wrote since, kept even if storage did not take it).
 */
function mergeRecords<T>(base: Record<string, T>, mine: Record<string, T>, theirs: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const v = sameRecord(theirs[k], base[k]) ? mine[k] : theirs[k]
    if (v !== undefined) out[k] = v
  }
  return out
}
const mergeLedgers = (base: JobLedger, mine: JobLedger, theirs: JobLedger): JobLedger => ({
  jobs: mergeRecords(base.jobs, mine.jobs, theirs.jobs),
  sent: mergeRecords(base.sent, mine.sent, theirs.sent),
  imported: mergeRecords(base.imported, mine.imported, theirs.imported),
})

export const STATE_KEY = 'bdp:canvasapp:gateway'
export const JOBS_KEY = 'bdp:canvasapp:jobs'

/** What "Nhập job" tells the adapter about the open project (siteJobActions.scanForImport). */
export interface SiteScanInput {
  sceneByNode: ReadonlyMap<string, string>
  sceneOrder: ReadonlyMap<string, number>
  takeJobIds: ReadonlySet<string>
  takeIds: ReadonlySet<string>
}

export type CanvasappProvider = VideoProvider & {
  reset(): void
  settingsLimits(): SettingsLimits
  limitsInfo(): LimitsInfo
  refreshLimits(opts?: RefreshLimitsOptions): Promise<RefreshLimitsResult>
  /** Re-read /api/video-profiles now (a forced read); throws when it cannot be read. */
  refreshProfiles(): Promise<VideoProfile[]>
  bridgeProjectId(): string | null
  uploadCacheSize(): number
  // ---- "Nhập job" (reverse sync; siteJobs.ts). Read-only toward canvasapp: GET requests only, never a project made. ----
  /**
   * The jobs of the "SanoVids bridge" session that may become takes of the open project (and why the others may not).
   * Reads: GET /api/projects (only when no bridge id is remembered — never creates or remembers one), the job list
   * (always read; the poll's cache reuses it), GET /api/projects/{id} (the saved canvas, for hints; only with candidates).
   * Throws on 401 ('login-required') and other list errors; projectId null = no bridge session.
   */
  scanSiteJobs(input: SiteScanInput): Promise<SiteJobScan>
  /** GET /api/video-jobs/{id}/prompt of at most MAX_IMPORT_BATCH jobs, one after the other; null = unknown. Rethrows 401. */
  siteJobPrompts(jobIds: readonly string[]): Promise<Record<string, string | null>>
  /**
   * Record jobs as imported takes (ledger.imported), checked again NOW against the ledger: never a key that has a
   * job / a POST, a job SanoVids made, one claimed before (unless `reimport`), the same job twice, or one an
   * unanswered POST may own (sentMayOwn). Synchronous; returns the accepted keys.
   */
  claimSiteJobs(claims: readonly SiteJobClaim[]): string[]
}

/** Errors after which canvasapp may have created the job although no job id came back. */
function ambiguous(e: unknown): boolean {
  if (!(e instanceof CanvasappError)) return true
  // 409: a duplicate client_request_id — the first request DID reach canvasapp.
  return e.code === 'network' || e.code === 'server' || e.code === 'bad-response' || e.status === 409
}

/** Pixel size of a picture through createImageBitmap (Electron renderer); null when it cannot be decoded here. */
async function bitmapSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    const bitmap = await createImageBitmap(blob)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return null
  }
}

/**
 * Could `j` be the job that the POST recorded as `r` made? On its node, not listed before it, created within its window
 * (inPostWindow: created_at may be off by hours) — unknown creation time: it could.
 */
function mayBeJobOf(j: CanvasJob, r: SentRecord): boolean {
  if (j.canvas_node_id !== r.nodeId || r.before?.includes(j.job_id)) return false
  return inPostWindow(j.created_at, r.at) ?? true
}

/** Persisted upload cache (imageId → upload_id), keeping only string → non-empty string pairs. */
function uploadsFrom(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0))
}

/** One read of /api/video-profiles: the list, or why not; `outcome` = what it did to the cache (record()). */
type ProfilesAnswer =
  | { ok: true; list: VideoProfile[]; outcome: 'read' }
  | { ok: false; login: boolean; error: unknown; outcome: 'failed' | 'kept' | 'login' }

interface ProfilesReading {
  promise: Promise<ProfilesAnswer>
  /** A submit waits for it: its failure keeps the fallbacks for submits for PROFILES_RETRY_MS. */
  bySubmit: boolean
  /** Sent by a forced refresh ("Đọc lại"). */
  forced: boolean
}

export function createCanvasappProvider(deps: CanvasappProviderDeps): CanvasappProvider {
  const { api } = deps
  const storage = deps.storage ?? memoryStorage()
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const minPollMs = Math.max(0, deps.minPollMs ?? MIN_POLL_MS)
  const pollMs = Math.max(minPollMs, deps.pollIntervalMs ?? DEFAULT_POLL_MS)
  const listCacheMs = Math.max(0, Math.min(minPollMs, deps.listCacheMs ?? minPollMs))
  const gatewayListCacheMs = Math.max(0, deps.gatewayListCacheMs ?? MIN_POLL_MS)

  let state: GatewayState = load()
  /**
   * The job ledger (JOBS_KEY). Storage is the truth: in the web development mode another tab writes the same key (a tab
   * of another project — the engine lock is per project — or "Nhập job" in any tab), so every read takes what storage
   * holds now (ledgerNow) and every change is made to that and written back in the same synchronous step. Per record,
   * storage's version wins when it changed since this tab last saw it (another tab wrote or removed it); otherwise
   * this tab's own does — which also keeps this tab's records while storage does not take them (blocked, full).
   */
  let ledgerMine: JobLedger = EMPTY_LEDGER
  /** What storage held when this tab last read it (or after a write it took), as text and as read. */
  let ledgerSeen: { raw: string | null; value: JobLedger } = { raw: null, value: EMPTY_LEDGER }
  ledgerNow()
  /** /api/video-profiles as last read ([] = unreadable → canvasapp's fallbacks); null = not read yet. */
  let profiles: VideoProfile[] | null = null
  /**
   * When `profiles` was read. `bySubmit`: a failed read a submit waited for — its fallbacks stand for submits until
   * PROFILES_RETRY_MS (as before the UI read too); a failed read only the UI asked for never keeps a submit from reading.
   */
  let profilesRead: { at: number; ok: boolean; bySubmit: boolean } | null = null
  /** profilesSignature of `profiles` (what they refuse). */
  let profilesSig = ''
  /** The one read in flight (the UI's and a submit's share it). */
  let profilesReading: ProfilesReading | null = null
  /** A forced read asked for while another was in flight: sent once that one ends (shared by further clicks). */
  let profilesFollowUp: Promise<ProfilesAnswer> | null = null
  let profilesAttempt: { at: number; result: 'read' | 'failed' | 'kept' | 'login' } | null = null
  /** Bumped by reset(): a read started before it lands without changing anything. */
  let profilesEpoch = 0
  let limitsMemo: { sig: string; firm: boolean; value: SettingsLimits } | null = null
  let ensuring: Promise<string> | null = null
  /** Serialises submits: uploads + canvas PUT + job POST of one take never interleave with another's. */
  let chain: Promise<unknown> = Promise.resolve()
  /** Submits in progress by key (a second submit / recover of the same key joins it). */
  const inflight = new Map<string, Promise<{ remoteId: string }>>()
  /** Job list cache of the poll (dropped after a POST so the next poll sees the new job). */
  const lists = new Map<string, ListRead>()
  /** Last job list read per bridge project, kept when the cache above is dropped: which jobs still run. */
  const lastLists = new Map<string, ListRead>()
  /** Job POSTs sent so far (each attempt): the gateway (main.cjs, the dev bridge) drops its cached job list at each. */
  let postsSent = 0
  /** A job of the ledger that a job-list read does not show (yet): still treated as running this long after it was made. */
  const unlistedGraceMs = (MAX_MISSES + 1) * pollMs
  const misses = new Map<string, number>()
  /** "Nhập job": job id → when a scan first listed it finished but not downloadable (siteJobs.mayStillDownload). */
  const undownloadableSince = new Map<string, number>()

  function load(): GatewayState {
    try {
      const raw = storage.get(STATE_KEY)
      if (raw) {
        const p = JSON.parse(raw) as Record<string, unknown>
        // Entries of older builds (v0.2.0) or malformed ones: kept when well-formed, else dropped and rebuilt on the
        // next submit of that scene. Canvas node ids are never stored — they are derived when the canvas is built.
        return { projectId: typeof p.projectId === 'string' && p.projectId ? p.projectId : null, uploads: uploadsFrom(p.uploads), entries: bridgeEntriesFrom(p.entries) }
      }
    } catch {
      /* ignore */
    }
    return { projectId: null, uploads: {}, entries: {} }
  }
  function save() {
    storage.set(STATE_KEY, JSON.stringify(state))
  }
  /** The ledger as storage holds it now, merged with this tab's own records (see ledgerMine). */
  function ledgerNow(): JobLedger {
    let raw: string | null = null
    try {
      raw = storage.get(JOBS_KEY)
    } catch {
      return unskewed()
    }
    if (raw === ledgerSeen.raw) return unskewed()
    const theirs = parseLedger(raw)
    // not a ledger (should not happen): what this tab knows stands, and its next write replaces it
    if (!theirs) return unskewed()
    ledgerMine = mergeLedgers(ledgerSeen.value, ledgerMine, theirs)
    ledgerSeen = { raw, value: theirs }
    return unskewed()
  }
  /**
   * ledgerMine, its "sent" records stamped later than now (the clock was set back since) rewritten once: their times
   * become now — never earlier than what they stand for, so no wait (rivalWait, STILL_SENDING_TEXT) and no "surely
   * listed" (listedBy) from them is ever shorter than the truth, and every such wait is bounded from now on — and their
   * read's `beforeAt`, stamped on that clock too, is dropped as unknown (it would claim to show more than it did).
   */
  function unskewed(): JobLedger {
    const t = now()
    let fixed: Record<string, SentRecord> | null = null
    for (const [k, r] of Object.entries(ledgerMine.sent)) {
      if (!r || typeof r !== 'object' || !(r.at > t || (r.endedAt ?? -Infinity) > t || (r.beforeAt ?? -Infinity) > t)) continue
      const { beforeAt: _skewed, ...rest } = r
      fixed ??= { ...ledgerMine.sent }
      fixed[k] = { ...rest, at: Math.min(r.at, t), ...(r.endedAt !== undefined ? { endedAt: Math.min(r.endedAt, t) } : {}) }
    }
    if (fixed) saveLedger({ ...ledgerMine, sent: fixed })
    return ledgerMine
  }
  function newest<T extends { at: number }>(rec: Record<string, T>, max: number): Record<string, T> {
    const entries = Object.entries(rec)
    return entries.length <= max ? rec : Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, max))
  }
  /** Write `next` — made from ledgerNow() in the same synchronous step — whole. True when storage kept it. */
  function saveLedger(next: JobLedger): boolean {
    ledgerMine = { jobs: newest(next.jobs, MAX_JOB_RECORDS), sent: newest(next.sent, MAX_SENT_RECORDS), imported: newest(next.imported, MAX_IMPORTED_RECORDS) }
    const raw = JSON.stringify(ledgerMine)
    let back: string | null = null
    try {
      storage.set(JOBS_KEY, raw)
      back = storage.get(JOBS_KEY)
    } catch {
      /* not kept: this tab's records stand on their own */
    }
    if (back !== raw) return false
    ledgerSeen = { raw, value: ledgerMine }
    return true
  }
  /**
   * The key got its job (on canvas node `nodeId`): remember it (never posted again) with its node — kept on the bridge
   * canvas while the job runs (runningNodeKeys) — and drop the "sent" record.
   */
  function settle(key: string, remoteId: string, nodeId: string): { remoteId: string } {
    const ledger = ledgerNow()
    const { [key]: _done, ...sent } = ledger.sent
    saveLedger({ ...ledger, jobs: { ...ledger.jobs, [key]: { remoteId, at: now(), nodeId } }, sent })
    return { remoteId }
  }
  /**
   * Read the job list of a bridge project (poll, lookup, room check, the read before a POST, the scan) and remember it.
   * `shows` is stamped from when the request was SENT, less how long the gateway may answer from its own cache.
   */
  async function readList(projectId: string): Promise<ListRead> {
    const sent = now()
    const posts = postsSent
    const jobs = await api.listVideoJobs(projectId)
    const read: ListRead = { at: now(), sent, shows: sent - gatewayListCacheMs, posts, jobs }
    lists.set(projectId, read)
    lastLists.set(projectId, read)
    return read
  }
  const readJobs = async (projectId: string): Promise<CanvasJob[]> => (await readList(projectId)).jobs
  /** A job-list read SENT from this time on surely shows the job POST `r` made, if any (its `shows` ≥ listedBy(r)). */
  const coverableAt = (r: SentRecord) => listedBy(r) + gatewayListCacheMs
  /** The longest a look at the job list ever waits for coverableAt: from a POST's outcome, SETTLE_MS + the cache. */
  const LAST_LOOK_MAX_MS = SETTLE_MS + gatewayListCacheMs

  /**
   * Bridge entry keys (node keys) whose canvas node a job may still need: the jobs not ended in the last job-list read
   * (read again when older than MIN_POLL_MS; node = the job's canvas_node_id, else the one the ledger recorded), plus
   * the ledger's jobs that read does not show — made after it, or not listed yet for a short while. A legacy entry
   * (bare scene id) maps to the node an older build sent its job on. `projectId` = canvasapp's bridge project.
   * null = unknown (no list could be read). Throws when the login is needed.
   */
  async function runningNodeKeys(projectId: string): Promise<Set<string> | null> {
    let list = lastLists.get(projectId)
    if (!list || now() - list.at >= MIN_POLL_MS) {
      try {
        await readJobs(projectId)
        list = lastLists.get(projectId)
      } catch (e) {
        if (isLoginRequired(e)) throw e
        // unreadable now: an older read (plus the jobs made since) is better than nothing
      }
    }
    if (!list) return null
    /** This computer's jobs on that project (ledger): job id → node, when it was made. */
    const mine = new Map<string, { nodeId?: string; at: number }>()
    for (const rec of Object.values(ledgerNow().jobs)) {
      const d = decodeRemoteId(rec.remoteId)
      if (d?.projectId === projectId) mine.set(d.jobId, { nodeId: rec.nodeId, at: rec.at })
    }
    const nodes = new Set<string>()
    const listed = new Set<string>()
    for (const j of list.jobs) {
      listed.add(j.job_id)
      if (ENDED_JOB_STATUSES.has(String(j.status))) continue
      const node = typeof j.canvas_node_id === 'string' ? j.canvas_node_id : mine.get(j.job_id)?.nodeId
      if (node) nodes.add(node)
    }
    for (const [jobId, m] of mine) {
      if (!m.nodeId || listed.has(jobId)) continue
      if (m.at >= list.at || now() - m.at < unlistedGraceMs) nodes.add(m.nodeId)
    }
    return new Set(Object.keys(state.entries).filter((nodeKey) => nodes.has(canvasNodeId(nodeKey))))
  }
  /**
   * Key of the bridge node a request is sent on: its project's scene (sceneNodeKey) — except a take whose earlier POST
   * may have reached canvasapp (ledger.sent) on the node an older build named by the scene id alone: it is re-sent on
   * THAT node, so the lookups for that earlier job and any server-side dedupe see the same canvas_node_id again.
   * (`req.sanovidsProjectId` is read here only: everywhere else in this file `projectId` is canvasapp's bridge project.)
   */
  function nodeKeyFor(req: JobRequest): string {
    const sentOn = ledgerNow().sent[req.key]?.nodeId
    return sentOn !== undefined && sentOn === canvasNodeId(req.sceneId) ? req.sceneId : sceneNodeKey(req.sanovidsProjectId, req.sceneId)
  }
  function markSent(key: string, rec: SentRecord) {
    const ledger = ledgerNow()
    saveLedger({ ...ledger, sent: { ...ledger.sent, [key]: rec } })
  }
  /**
   * The record of a POST about to be sent, written first; false — this tab's copy left as it was, nothing to send —
   * when storage did not keep it (full, blocked): a POST without a saved record could be paid twice after a reload
   * (recover finds nothing to look for, "Chạy lại" posts at once).
   */
  function markSending(key: string, rec: SentRecord): boolean {
    const ledger = ledgerNow()
    if (saveLedger({ ...ledger, sent: { ...ledger.sent, [key]: rec } })) return true
    ledgerMine = ledger
    return false
  }
  /** Other takes' POSTs on that node of that bridge project whose answer is not known: their job may be there, unclaimed. */
  function rivalsOf(key: string, projectId: string, nodeId: string): SentRecord[] {
    const ledger = ledgerNow()
    return Object.entries(ledger.sent)
      .filter(([k, r]) => k !== key && !(k in ledger.jobs) && r.projectId === projectId && r.nodeId === nodeId)
      .map(([, r]) => r)
  }
  /**
   * How long a POST of `key` on that node must wait before a job-list read sent then surely shows the job of every
   * other take's unanswered POST there (coverableAt); 0 = now. A POST sent before could not tell its job from theirs if
   * its answer were lost too — nor could they — so it is not sent until then (submitNow: 'deferred'). Old records (a
   * "không rõ" take never retried, or deleted) are long covered: they never hold a scene back.
   */
  function rivalWait(key: string, projectId: string, nodeId: string): number {
    const t = now()
    return rivalsOf(key, projectId, nodeId).reduce((wait, r) => Math.max(wait, coverableAt(r) - t), 0)
  }
  function clearSent(key: string) {
    const ledger = ledgerNow()
    if (!(key in ledger.sent)) return
    const { [key]: _gone, ...sent } = ledger.sent
    saveLedger({ ...ledger, sent })
  }

  async function ensureProject(): Promise<string> {
    if (state.projectId) return state.projectId
    if (!ensuring) {
      ensuring = (async () => {
        const existing = (await api.listProjects()).find((p) => p.name === BRIDGE_PROJECT_NAME)
        // canvasapp's page creates a project with an empty POST and names it with PATCH {name} ("Đổi tên phiên").
        const id = existing?.project_id ?? (await api.createProject())
        state = { ...state, projectId: id, entries: existing ? state.entries : {} }
        save()
        if (!existing) {
          try {
            await api.renameProject(id, BRIDGE_PROJECT_NAME)
          } catch {
            // Only the name is missing (the id is remembered): the project still works as the bridge.
          }
        }
        return id
      })().finally(() => {
        ensuring = null
      })
    }
    return ensuring
  }

  /** Which picture of the request an image id is, for messages ("@image_3", "khung đầu"). */
  function imageLabel(req: JobRequest, imageId: string): string {
    const n = req.images.find((i) => i.imageId === imageId)?.n
    if (n) return `@image_${n}`
    if (req.firstFrame?.imageId === imageId) return 'khung đầu'
    if (req.lastFrame?.imageId === imageId) return 'khung cuối'
    return 'ảnh tham chiếu'
  }

  async function uploadMissing(req: JobRequest, checkCancelled: () => void) {
    // Every picture must be on this computer BEFORE anything is uploaded or paid: a missing one fails loudly.
    const files: { imageId: string; blob: Blob; type: string }[] = []
    for (const imageId of imagesToUpload(req)) {
      if (state.uploads[imageId]) continue
      const blob = await deps.getBlob(imageId)
      if (!blob) throw new CanvasappError('bad-request', `Không tìm thấy ảnh tham chiếu ${imageLabel(req, imageId)} trong máy (đã bị xoá?) — chưa gửi gì, không bị trừ credit.`)
      const type = blob.type || 'image/png'
      if (!ALLOWED_IMAGE_TYPES.includes(type)) throw new CanvasappError('unsupported', `canvasapp chỉ nhận ảnh JPG/PNG/WEBP (${imageLabel(req, imageId)} là ${type}).`)
      files.push({ imageId, blob, type })
    }
    for (const f of files) {
      checkCancelled()
      // Sequential on purpose: gentle on the server.
      const uploadId = await api.uploadImage(f.blob, uploadFilename(f.imageId, f.type))
      state = { ...state, uploads: { ...state.uploads, [f.imageId]: uploadId } }
      save()
    }
  }

  /**
   * canvasapp refused the job: its uploads may be the reason (expired on the server) → upload them again next time,
   * and drop the node's bridge entry that names them (rebuilt by the next submit of that scene) — unless an earlier
   * take on that node still runs (`keepEntry`): its node stays on the canvas, only the upload cache is forgotten.
   */
  function forgetUploads(req: JobRequest, nodeKey: string, keepEntry: boolean) {
    const uploads = { ...state.uploads }
    for (const id of imagesToUpload(req)) delete uploads[id]
    const { [nodeKey]: _gone, ...others } = state.entries
    state = { ...state, uploads, entries: keepEntry ? state.entries : others }
    save()
  }

  // ---- /api/video-profiles: one cache for the submit (validateRequest) and the UI (settingsLimits) ----
  // Invariants: (1) a submit reads it only after the ledger lookups (`done` / `earlier` in submitNow), so a take whose
  // earlier POST lost its answer is still found when the model is locked now; (2) a failed read never replaces a fresh
  // OK list ('kept': pressing "Đọc lại" never makes a submit refuse what it accepted a second earlier), and only a
  // failure a submit waited for keeps submits on the fallbacks for PROFILES_RETRY_MS — one only the UI saw never stops a
  // submit from reading; (3) reset() drops whatever a read in flight brings back.

  function limitsChanged() {
    try {
      deps.onLimitsChange?.()
    } catch {
      /* the UI signal never breaks the gateway */
    }
  }

  /** The OK list is younger than PROFILES_TTL_MS (a submit decides with it without reading). */
  const okFresh = () => !!profiles && !!profilesRead?.ok && now() - profilesRead.at < PROFILES_TTL_MS

  /** profilesSignature, never throwing (server data): unreadable → a signature of its own (a new limits object). */
  function signatureOf(list: VideoProfile[], ok: boolean, t: number): string {
    try {
      return profilesSignature(list, ok)
    } catch {
      return `unreadable:${t}:${Math.random()}`
    }
  }

  function record(answer: ProfilesAnswer, bySubmit: boolean): ProfilesAnswer['outcome'] {
    const t = now()
    if (answer.ok) {
      profiles = answer.list
      profilesRead = { at: t, ok: true, bySubmit }
      profilesSig = signatureOf(answer.list, true, t)
      return 'read'
    }
    if (answer.login) return 'login' // what was read before stays (the session ended; reset() on logout drops it)
    if (okFresh()) return 'kept'
    profiles = []
    profilesRead = { at: t, ok: false, bySubmit }
    profilesSig = signatureOf([], false, t)
    return 'failed'
  }

  /**
   * GET /api/video-profiles — one read at a time: a call while one is in flight joins it (a submit joining marks it as
   * its own). The state is only written when no reset() happened meanwhile; the caller always gets the answer.
   * `forced`: started by a forced refresh ("Đọc lại"), see readAfterCurrent.
   */
  function readProfiles(bySubmit: boolean, forced = false): Promise<ProfilesAnswer> {
    if (profilesReading) {
      if (bySubmit) profilesReading.bySubmit = true
      return profilesReading.promise
    }
    const epoch = profilesEpoch
    const reading: ProfilesReading = { promise: Promise.resolve(null as unknown as ProfilesAnswer), bySubmit, forced }
    reading.promise = (async (): Promise<ProfilesAnswer> => {
      let answer: ProfilesAnswer
      try {
        answer = { ok: true, list: await api.videoProfiles(), outcome: 'read' }
      } catch (e) {
        answer = { ok: false, login: isLoginRequired(e), error: e, outcome: isLoginRequired(e) ? 'login' : 'failed' }
      }
      if (epoch !== profilesEpoch) return answer
      if (profilesReading === reading) profilesReading = null
      const outcome = record(answer, reading.bySubmit)
      profilesAttempt = { at: now(), result: outcome }
      limitsChanged()
      return { ...answer, outcome } as ProfilesAnswer
    })()
    profilesReading = reading
    limitsChanged()
    return reading.promise
  }

  /**
   * A forced read whose request leaves after the call: never the answer of a read sent before it (that one may predate
   * a change on canvasapp). Joins a read in flight only when it was itself forced (it left after an earlier click) and
   * nothing changed since (`afterChange`: a login / the site's settings — that read may predate it); otherwise one
   * follow-up read is sent once it ends, shared by further calls.
   */
  function readAfterCurrent(afterChange = false): Promise<ProfilesAnswer> {
    const current = profilesReading
    if (!current) return readProfiles(false, true)
    if (current.forced && !afterChange) return current.promise
    if (!profilesFollowUp) {
      const epoch = profilesEpoch
      const followUp: Promise<ProfilesAnswer> = current.promise.then(() => {
        if (profilesFollowUp === followUp) profilesFollowUp = null
        if (epoch !== profilesEpoch) return { ok: false, login: false, error: null, outcome: 'failed' } as ProfilesAnswer
        return readProfiles(false, true)
      })
      profilesFollowUp = followUp
    }
    return profilesFollowUp
  }

  /**
   * /api/video-profiles, read like canvasapp's page does at boot (loadVideoProfiles()): 401 → login error; any other
   * failure → [] (= its fallbacks: Seedance on, MiniMax-H3 locked), tried again later. `ok` false = fallbacks.
   */
  async function currentProfiles(): Promise<{ list: VideoProfile[]; ok: boolean }> {
    const read = profilesRead
    const fresh = !!profiles && !!read && (read.ok ? now() - read.at < PROFILES_TTL_MS : read.bySubmit && now() - read.at < PROFILES_RETRY_MS)
    if (fresh) return { list: profiles ?? [], ok: read?.ok ?? false }
    const answer = await readProfiles(true)
    if (answer.ok) return { list: answer.list, ok: true }
    if (answer.login) throw answer.error
    // a UI read that ended meanwhile may have brought a fresh list
    if (okFresh()) return { list: profiles ?? [], ok: true }
    return { list: [], ok: false }
  }

  /** settingsLimits(): the same object while what it refuses and whether it is firm stay the same. */
  function settingsLimits(): SettingsLimits {
    const read = profilesRead
    const list = profiles
    if (!list || !read) return NO_LIMITS
    const firm = read.ok && now() - read.at < PROFILES_TTL_MS
    if (limitsMemo && limitsMemo.sig === profilesSig && limitsMemo.firm === firm) return limitsMemo.value
    const value: SettingsLimits = Object.freeze({
      source: read.ok ? ('server' as const) : ('fallback' as const),
      firm,
      issues: (s: VideoSettings): SettingsIssue[] => {
        try {
          return profileIssues(s, list)
        } catch {
          return [] // server data is rendered: it must never break a render
        }
      },
    })
    limitsMemo = { sig: profilesSig, firm, value }
    return value
  }

  function limitsInfo(): LimitsInfo {
    const read = profilesRead
    const known = !!profiles && !!read
    return {
      source: !known ? 'none' : read.ok ? 'server' : 'fallback',
      at: known ? read.at : null,
      firmUntil: known && read.ok ? read.at + PROFILES_TTL_MS : null,
      lastAttempt: profilesAttempt,
      reading: !!profilesReading,
    }
  }

  async function refreshLimits({ force = false, changed = false }: RefreshLimitsOptions = {}): Promise<RefreshLimitsResult> {
    try {
      const t = now()
      const last = profilesAttempt
      if (!force && !changed) {
        if (okFresh()) return 'fresh'
        // after a failed attempt (a 401 included) the UI waits, like a submit after a failed read
        if (!profilesReading && last && (last.result === 'failed' || last.result === 'login') && t - last.at < PROFILES_RETRY_MS) return last.result
      } else if (!changed && !profilesReading && last && t - last.at < PROFILES_FORCE_MIN_MS) {
        // "Đọc lại" pressed again within seconds (whatever the last read gave): its answer, nothing sent. Never after a
        // login / a change (`changed`): what was read or tried before it no longer answers.
        return last.result === 'read' ? 'fresh' : last.result
      }
      const avail = await api.transport.available().catch(() => ({ ok: false }))
      if (!avail.ok) return 'unavailable'
      const answer = changed ? await readAfterCurrent(true) : force ? await readAfterCurrent() : await readProfiles(false)
      return answer.outcome
    } catch {
      return 'failed'
    }
  }

  /**
   * H3 transform: the ratio both frames share, read from the pictures like canvasapp's page (transformInputState():
   * it never runs a transform whose frames differ in ratio or have an unsupported one). Null for any other request.
   * Throws (nothing uploaded or sent yet) when a frame is missing, unreadable, or the ratios do not fit.
   */
  async function transformRatio(req: JobRequest): Promise<string | null> {
    if (inputShapeOf(req.model, req.mode) !== 'frames' || !req.firstFrame || !req.lastFrame) return null
    const ratios: (string | null)[] = []
    for (const [label, frame] of [['khung đầu', req.firstFrame], ['khung cuối', req.lastFrame]] as const) {
      const blob = await deps.getBlob(frame.imageId)
      if (!blob) throw new CanvasappError('bad-request', `Không tìm thấy ảnh ${label} trong máy (đã bị xoá?) — chưa gửi gì, không bị trừ credit.`)
      const size = await (deps.imageSize ?? bitmapSize)(blob)
      if (!size) throw new CanvasappError('unsupported', `Không đọc được kích thước ảnh ${label} — chưa gửi gì, không bị trừ credit.`)
      ratios.push(ratioFromDimensions(size.width, size.height))
    }
    const r = transformFrameRatio(ratios[0], ratios[1])
    if ('problem' in r) throw new CanvasappError('unsupported', `${r.problem} Chưa gửi gì, không bị trừ credit.`)
    return r.ratio
  }

  const uploadIdFor = (imageId: string) => {
    const id = state.uploads[imageId]
    if (!id) throw new CanvasappError('bad-request', 'Ảnh tham chiếu chưa được tải lên canvasapp.')
    return id
  }

  /**
   * One read of the job list: the job a lost answer of `key` created. 'none' = not there; 'ambiguous' = more than
   * one could be it, or another take could own it (never guessed). `shows`: what that read surely shows (ListRead) —
   * a "none" only means "never made" from a read with shows ≥ listedBy(rec). Throws when the list cannot be read.
   */
  async function findJob(req: JobRequest, rec: SentRecord): Promise<{ found: { remoteId: string } | 'none' | 'ambiguous'; shows: number }> {
    lists.delete(rec.projectId)
    const read = await readList(rec.projectId)
    return { found: jobOf(req, rec, read.jobs), shows: read.shows }
  }
  function jobOf(req: JobRequest, rec: SentRecord, jobs: CanvasJob[]): { remoteId: string } | 'none' | 'ambiguous' {
    const remote = (j: CanvasJob) => ({ remoteId: encodeRemoteId(rec.projectId, j.job_id) })
    if (jobs.some((j) => typeof j.client_request_id === 'string')) {
      // The key on the wire is clientRequestIdFor(take id); v0.2.0 sent the take id itself.
      const keys = new Set([clientRequestIdFor(req.key), req.key])
      const same = jobs.filter((j) => typeof j.client_request_id === 'string' && keys.has(j.client_request_id))
      return same.length === 1 ? remote(same[0]) : same.length ? 'ambiguous' : 'none'
    }
    // The list does not carry client_request_id: the job is the ONE canvas job on the canvas node the POST named
    // (rec.nodeId, recorded with the request) that is not another take's (known ids), was not there before the POST
    // and was created after it.
    // ...nor a job imported ("Nhập job"), whenever: one claimed before this POST was listed before it; one claimed
    // after it passed sentMayOwn against this very record — either way not this POST's job, and never a second take of
    // one job. The creation-time window is that rule's too (inPostWindow): a job made on the site long after the POST
    // (still importable) is never taken for it. Only what the list says clearly rules a job out: an unknown creation
    // time (createdTime: missing, not ISO 8601 / a number), duration or model keeps it a candidate — at worst
    // "ambiguous" ("không rõ", nothing posted), never a "none" that would post this take a second time.
    const ledger = ledgerNow()
    const taken = new Set([...Object.values(ledger.jobs), ...Object.values(ledger.imported)].map((j) => decodeRemoteId(j.remoteId)?.jobId))
    const before = new Set(rec.before ?? [])
    const model = modelProfileOf(req.model)
    const rivals = rivalsOf(req.key, rec.projectId, rec.nodeId)
    // Another take's read right before ITS POST that surely showed this POST's job, if any (beforeAt ≥ listedBy(rec):
    // the rule submitNow keeps — rivalWait): this POST's job is in that `before`, so a job missing from it was made later.
    const coveringBefores = rivals.flatMap((r) => (r.beforeAt !== undefined && r.beforeAt >= listedBy(rec) ? [new Set(r.before ?? [])] : []))
    const candidates = jobs.filter((j) => {
      if (j.canvas_node_id !== rec.nodeId || taken.has(j.job_id) || before.has(j.job_id)) return false
      if (coveringBefores.some((b) => !b.has(j.job_id))) return false
      // loadJobs(): the canvas page only shows jobs without creation_mode or with 'canvas'
      if (j.creation_mode !== undefined && j.creation_mode !== null && j.creation_mode !== 'canvas') return false
      // what the list does not say clearly (missing, null, not a number, an unreadable time) never rules a job out:
      // ruling this POST's own job out would post it again (a second charge)
      if (typeof j.model_profile === 'string' && j.model_profile !== model) return false
      const duration = listedDuration(j.duration)
      if (duration !== null && duration !== req.duration) return false
      return inPostWindow(j.created_at, rec.at) ?? true
    })
    if (candidates.length !== 1) return candidates.length ? 'ambiguous' : 'none'
    // ...and that no other take still without an answer on that node may own: that take looks for it too — taking it
    // would make that take post again (a second charge, the wrong video here). A LATER POST may own any job its own
    // read before it did not show (one whose read covered this POST was dealt with above: such a job is never this
    // POST's); an EARLIER one only a job this POST's read did not show although that read shows what existed once that
    // POST's job, if any, was listed (beforeAt ≥ listedBy: SETTLE_MS after its outcome came back — or after main may have
    // stopped sending it, when the page went away mid-POST; beforeAt: when the read was sent, less the gateway's cache
    // time; submitNow reads the list right before every POST and waits until that read covers every such POST). Not
    // known (records of earlier builds) → both could own it: neither takes it ("không rõ" for both, nothing re-posted).
    const [job] = candidates
    const contested = rivals.some((r) => mayBeJobOf(job, r) && (r.at >= rec.at || rec.beforeAt === undefined || rec.beforeAt < listedBy(r)))
    return contested ? 'ambiguous' : remote(job)
  }

  /**
   * Look for the job after an unanswered POST (waits first: canvasapp may still be creating it). 'none' only from a
   * read that surely shows its job if it had one (shows ≥ listedBy(rec)): the last look waits until such a read can be
   * sent (coverableAt). A "none" of an earlier read, or a last look that failed, is 'unknown' — posting again on it
   * could pay twice (the rule "Chạy lại" follows too: STILL_SENDING_TEXT).
   */
  async function lookForJob(req: JobRequest, rec: SentRecord, delays: readonly number[] = RECONCILE_DELAYS_MS): Promise<{ remoteId: string } | 'none' | 'unknown'> {
    for (const [i, ms] of delays.entries()) {
      const last = i === delays.length - 1
      // (never longer than such a read can need from now: a clock set back meanwhile only makes that look too early
      // to say "none" — 'unknown', never a second POST)
      const wait = last ? Math.min(LAST_LOOK_MAX_MS, Math.max(ms, coverableAt(rec) - now())) : ms
      if (wait > 0) await sleep(wait)
      try {
        const { found, shows } = await findJob(req, rec)
        if (found === 'ambiguous') return 'unknown'
        if (found !== 'none') return found
        if (shows >= listedBy(rec)) return 'none'
      } catch {
        // list unreadable: this look tells nothing
      }
    }
    return 'unknown'
  }

  const uncertainError = () => new CanvasappError('network', UNCERTAIN_SUBMIT_TEXT, { uncertain: true })

  /** POST the job once; when the answer is lost, find the job or post the SAME body (same key) one more time. */
  /** `afterLost`: this key was posted before and its answer was lost — a refusal now does not mean "not billed". */
  /** `nodeKey` / `nodeRunning`: the bridge entry of the job's node; does an earlier job on it still run (it then stays)? */
  async function postJob(
    req: JobRequest,
    nodeKey: string,
    body: VideoJobBody,
    read: ListRead,
    opts: SubmitOptions,
    afterLost: boolean,
    nodeRunning: () => Promise<boolean>,
  ): Promise<{ remoteId: string }> {
    // Jobs on that node in the job-list read this POST goes out with (the one right before it, unless it failed):
    // listed before this POST, so none of them is its job.
    let rec: SentRecord = {
      projectId: body.project_id,
      nodeId: body.canvas_node_id,
      at: now(),
      before: read.jobs.filter((j) => j.canvas_node_id === body.canvas_node_id).map((j) => j.job_id),
      beforeAt: read.shows,
    }
    if (!markSending(req.key, rec)) {
      throw new CanvasappError('unavailable', afterLost ? LEDGER_NOT_SAVED_AFTER_LOST_TEXT : LEDGER_NOT_SAVED_TEXT, afterLost ? { uncertain: true, heldBack: true } : {})
    }
    let reposted = false
    for (;;) {
      try {
        postsSent++
        const jobId = jobIdFromCreateResponse(await api.createVideoJob(body))
        if (jobId) {
          lists.delete(body.project_id) // next poll sees the new job
          return settle(req.key, encodeRemoteId(body.project_id, jobId), body.canvas_node_id)
        }
        // 2xx without a job id: canvasapp most likely created it → find it below
      } catch (e) {
        if (!reposted && !afterLost && !ambiguous(e)) {
          // canvasapp refused it (401, 402/400, 403, 404, 429…): nothing was created, nothing billed.
          clearSent(req.key)
          // Not enough credits (402, or a 4xx whose detail says so) says nothing about the uploads: keep them.
          if (e instanceof CanvasappError && (e.code === 'bad-request' || e.code === 'not-found') && !e.noCredit && e.status !== 402) {
            // (unknown whether an earlier take on that node still runs → keep its entry: its node may be needed)
            forgetUploads(req, nodeKey, await nodeRunning().catch(() => true))
          }
          throw e
        }
        // after a lost answer even a refusal of the second POST proves nothing (e.g. "duplicate request")
      }
      // its outcome is known now: its job, if any, is listed SETTLE_MS from here (listedBy — what the lookups bet on,
      // and what a take posting next to it waits for: rivalWait)
      rec = { ...rec, endedAt: now() }
      markSent(req.key, rec)
      const found = await lookForJob(req, rec)
      if (typeof found === 'object') {
        lists.delete(body.project_id)
        return settle(req.key, found.remoteId, rec.nodeId)
      }
      if (found === 'none' && !reposted && !opts.isCancelled?.()) {
        reposted = true
        // its time is now this POST's, its outcome not known yet (a take posting next to it later waits for THIS one)
        const { endedAt: _ended, ...again } = rec
        const next = { ...again, at: now() }
        // (its record not saved → not sent again: the first one stays "không rõ")
        if (!markSending(req.key, next)) throw uncertainError()
        rec = next
        continue
      }
      throw uncertainError()
    }
  }

  async function submitNow(req: JobRequest, opts: SubmitOptions): Promise<{ remoteId: string }> {
    const checkCancelled = () => {
      if (opts.isCancelled?.()) throw new CanvasappError('cancelled', CANCELLED_TEXT)
    }
    // A job already exists for this key (made by SanoVids, or imported from canvasapp's page): never post it again.
    const ledger = ledgerNow()
    const done = ledger.jobs[req.key] ?? ledger.imported[req.key]
    if (done) return { remoteId: done.remoteId }
    checkCancelled()
    // This key was posted before without a known answer (an explicit retry of an "unknown" take): look first —
    // a job found there is this take's, whatever the checks below would say today.
    const earlier = ledger.sent[req.key]
    if (earlier) {
      let lookup: Awaited<ReturnType<typeof findJob>>
      try {
        lookup = await findJob(req, earlier)
      } catch (e) {
        throw new CanvasappError('network', `${LOOKUP_FAILED_TEXT} (${canvasappErrorText(e)})`, { uncertain: true, heldBack: true })
      }
      const { found } = lookup
      if (typeof found === 'object') return settle(req.key, found.remoteId, earlier.nodeId)
      if (found === 'ambiguous') throw uncertainError()
      // Not there — but that read may be too early to show it: the page went away while main was still sending that
      // POST (it goes on), or its lookups were cut short. Posting again now could bill twice: not yet.
      if (lookup.shows < listedBy(earlier)) throw new CanvasappError('network', STILL_SENDING_TEXT, { uncertain: true, heldBack: true })
    }
    // canvasapp's page never posts for a model that cannot create or a disabled mode: neither do we
    const known = await currentProfiles()
    const problems = validateRequest(req, known.list)
    if (problems.length) throw new CanvasappError('unsupported', [...problems, ...(known.ok ? [] : [PROFILES_FALLBACK_TEXT])].join(' '))
    const frameRatio = await transformRatio(req)
    let projectId = await ensureProject()
    checkCancelled()
    // The video node this take is sent on (its project's scene; a legacy node for a re-send, see nodeKeyFor) — the ONE
    // key every step below uses: the entry, the canvas, the job body.
    const nodeKey = nodeKeyFor(req)
    // Another take's POST on this node has no known answer and a read sent now could not surely show its job yet
    // (rivalWait): were this POST's answer lost too, neither take could ever tell its job from the other's (both "không
    // rõ" for good, a paid video never fetched). This take waits for it — back to the queue, nothing sent; the engine
    // starts other takes meanwhile — and its read right before the POST then has that job, if any, in `before`.
    const wait = rivalWait(req.key, projectId, canvasNodeId(nodeKey))
    if (wait > 0) throw new CanvasappError('deferred', RIVAL_PENDING_TEXT, { retryAfterMs: wait })
    // The bridge canvas holds one video node per entry. A node whose job may still run stays — whether canvasapp
    // cancels or loses a job whose node leaves the canvas is not known — so only the other entries may be left out to
    // make room. Which nodes run is only looked up when something has to be left out.
    let running: Set<string> | null = null
    const runningNow = async () => {
      // unknown (job list unreadable): every remembered entry counts as running — nothing is taken off
      running ??= (await runningNodeKeys(projectId)) ?? new Set(Object.keys(state.entries))
      return running
    }
    /** Plan of the canvas of `entries`: this node first, every running node kept; null = they do not all fit. */
    const canvasOf = async (entries: Record<string, BridgeEntry>) => {
      const list = Object.values(entries)
      const all = planBridgeCanvas(list, { current: nodeKey })
      if (!all.dropped.length) return all
      const plan = planBridgeCanvas(list, { current: nodeKey, keep: await runningNow() })
      return plan.missing.length ? null : plan
    }
    const noRoom = () => new CanvasappError('deferred', CANVAS_FULL_TEXT)
    // Room first, before anything is uploaded (pictures not uploaded yet count as new image nodes): none → the take
    // goes back to the queue and is tried again once a running job has ended. Nothing sent.
    const draft = entryFromRequest(req, (imageId) => state.uploads[imageId] ?? `pending:${imageId}`, now(), frameRatio, nodeKey)
    if (!(await canvasOf({ ...state.entries, [nodeKey]: draft }))) throw noRoom()
    checkCancelled()
    await uploadMissing(req, checkCancelled)
    const entry = entryFromRequest(req, uploadIdFor, now(), frameRatio, nodeKey)
    /**
     * PUT the canvas made of `entries`; once canvasapp accepted it they are the remembered entries — without the ones
     * left off the canvas (none has a running job: when that is unknown nothing is left off). They are rebuilt by the
     * next submit of their scene, so what is remembered never outgrows one canvas, however many projects run.
     */
    const putCanvas = async (entries: Record<string, BridgeEntry>) => {
      const plan = await canvasOf(entries)
      if (!plan) throw noRoom()
      await api.putCanvas(projectId, plan.canvas)
      const left = new Set(plan.dropped)
      state = { ...state, entries: left.size ? Object.fromEntries(Object.entries(entries).filter(([k]) => !left.has(k))) : entries }
      save()
    }
    try {
      try {
        await putCanvas({ ...state.entries, [nodeKey]: entry })
      } catch (e) {
        if (e instanceof CanvasappError && e.code === 'not-found') {
          // The remembered bridge project was deleted on canvasapp → create/find it again once.
          state = { ...state, projectId: null, entries: {} }
          save()
          running = new Set()
          projectId = await ensureProject()
          await putCanvas({ ...state.entries, [nodeKey]: entry })
        } else if (e instanceof CanvasappError && e.code === 'bad-request') {
          // Refused: an older node may be what canvasapp does not accept now (expired upload, changed rules…). A PUT
          // is free → once more without the nodes that may go: this one and the running ones only (a running job
          // keeps its node). Accepted → the others are dropped. Nothing may go → the refusal stands.
          const keep = await runningNow()
          const others = Object.keys(state.entries).filter((k) => k !== nodeKey)
          if (others.every((k) => keep.has(k))) throw e
          const kept = Object.fromEntries(Object.entries(state.entries).filter(([k]) => k !== nodeKey && keep.has(k)))
          await putCanvas({ ...kept, [nodeKey]: entry })
        } else throw e
      }
    } catch (e) {
      // Nothing billable was sent this time: say so, and which step failed (the login message stays as it is).
      if (!(e instanceof CanvasappError) || isLoginRequired(e) || e.code === 'cancelled' || e.code === 'deferred') throw e
      const text = earlier ? CANVAS_NOT_SAVED_AFTER_LOST_TEXT : CANVAS_NOT_SAVED_TEXT
      // (a take whose earlier POST lost its answer stays "maybe billed": held back, like LIST_NEEDED_AFTER_LOST_TEXT)
      throw new CanvasappError(e.code, `${text} ${e.message}`, { status: e.status, detail: e.detail, noCredit: e.noCredit, ...(earlier ? { uncertain: true, heldBack: true } : {}) })
    }
    const body = toVideoJobBody(req, { projectId, nodeKey, uploadIdFor, generateAudio: deps.generateAudio?.() ?? true })
    // Read the job list right before the POST, so every job already on its node is in the POST's `before` and is never
    // taken for its job by a lost-answer lookup (findJob): another take's (still in doubt, or done), or one made on
    // canvasapp's own page since the last read ("Tạo video" on a bridge node, not imported yet). Next to another take
    // whose POST on this node has no answer yet the read MUST surely show that take's job, if any (`covers`; sent after
    // rivalWait) — unreadable → not sent: posting now could leave two takes that can never tell their jobs apart (a take
    // whose job the last good read surely shows is no such take: an old "không rõ" one never blocks the scene).
    // Otherwise unreadable → sent with the last good read as `before` — never without one (none since the app started
    // or the login → not sent, LIST_FIRST_TEXT): a lookup then knows which jobs are surely not this POST's. A read
    // that the gateway would answer from its own cache anyway (SENT less than gatewayListCacheMs ago — the gateway
    // times its cache from the send, a slow answer included — and no POST since) is used as it is, when it covers every
    // such take. Either way a site
    // job made after what the read `before` comes from shows (its `shows`: ≤ gatewayListCacheMs before it was sent,
    // i.e. ≤ 2 × gatewayListCacheMs before this POST; or since the last good read) is not in it: if this POST's answer
    // is lost, the take settles on that job when the POST never reached canvasapp (that job's video, no second charge —
    // and it is no longer importable), or stays "không rõ" for good when it did (both jobs could be its own). Never
    // paid twice.
    const rivals = rivalsOf(req.key, projectId, body.canvas_node_id)
    /** A read this POST may go out with: there is one (every POST has a `before`), and it covers every such take. */
    const covers = (read: ListRead | undefined): read is ListRead => !!read && rivals.every((r) => read.shows >= listedBy(r))
    const last = lastLists.get(projectId)
    if (!last || last.posts !== postsSent || now() - last.sent >= gatewayListCacheMs || !covers(last)) {
      checkCancelled()
      lists.delete(projectId)
      try {
        await readJobs(projectId)
      } catch (e) {
        if (isLoginRequired(e)) throw e
        if (!covers(lastLists.get(projectId))) {
          const text = earlier ? LIST_NEEDED_AFTER_LOST_TEXT : rivals.length ? LIST_NEEDED_TEXT : LIST_FIRST_TEXT
          throw new CanvasappError(e instanceof CanvasappError ? e.code : 'network', `${text} (${canvasappErrorText(e)})`, {
            status: e instanceof CanvasappError ? e.status : undefined,
            // nothing sent this time; a take whose earlier POST lost its answer stays "maybe billed"
            ...(earlier ? { uncertain: true, heldBack: true } : {}),
          })
        }
      }
    }
    // (a read sent after rivalWait covers them all — unless a record came meanwhile, or the clock went back: wait again)
    const read = lastLists.get(projectId)
    if (!covers(read)) {
      throw new CanvasappError('deferred', RIVAL_PENDING_TEXT, { retryAfterMs: Math.max(1_000, rivalWait(req.key, projectId, body.canvas_node_id)) })
    }
    // Last chance to stop: the POST below is what canvasapp bills.
    checkCancelled()
    return postJob(req, nodeKey, body, read, opts, !!earlier, async () => (await runningNow()).has(nodeKey))
  }

  async function jobsOf(projectId: string): Promise<CanvasJob[]> {
    const hit = lists.get(projectId)
    // ≤ minPollMs (not pollMs): the engine polls every pollMs, a cache as long as that would skip every other poll.
    if (hit && now() - hit.at < listCacheMs) return hit.jobs
    return readJobs(projectId)
  }

  return {
    id: deps.id ?? 'canvasapp',
    label: deps.label ?? 'canvasapp.io.vn',
    ...(deps.minPollMs !== undefined ? { minPollIntervalMs: minPollMs } : {}),

    available: async (): Promise<ProviderAvailability> => {
      const t = await api.transport.available()
      if (!t.ok) return t
      try {
        const auth = await api.authState()
        return auth.authenticated ? { ok: true } : { ok: false, reason: 'Chưa đăng nhập canvasapp.io.vn.' }
      } catch (e) {
        return { ok: false, reason: canvasappErrorText(e) }
      }
    },

    capabilities: (model: ModelId): ProviderCapabilities => {
      // never from the profile: a key canvasapp may add there does not say how a video is sent
      const base = capabilitiesFromModels(model, { maxConcurrency: MAX_CONCURRENCY, pollIntervalMs: pollMs, maxRefVideos: CANVASAPP_MAX_REF_VIDEOS })
      const list = profiles
      if (!list) return base
      // The values of SanoVids' model table that the submit would not refuse on that field (profileIssues — the very
      // rule of validateRequest and settingsLimits(); a model that cannot create keeps its lists).
      const start = normalizeSettings({ model: base.model })
      const keep = <T extends string | number>(field: LimitField, values: T[]): T[] =>
        values.filter((v) => {
          try {
            return !profileIssues({ ...start, [field]: v }, list).some((i) => i.field === field)
          } catch {
            return true
          }
        })
      return {
        ...base,
        modes: keep('mode', base.modes),
        durations: keep('duration', base.durations),
        resolutions: keep('resolution', base.resolutions),
        ratios: keep('ratio', base.ratios),
      }
    },

    submit: (req, opts = {}) => {
      const same = inflight.get(req.key)
      if (same) return same
      const run = chain.then(() => submitNow(req, opts))
      chain = run.catch(() => undefined)
      inflight.set(req.key, run)
      void run
        .catch(() => undefined)
        .finally(() => {
          if (inflight.get(req.key) === run) inflight.delete(req.key)
        })
      return run
    },

    recover: async (req) => {
      const known = () => {
        const ledger = ledgerNow()
        return ledger.jobs[req.key]?.remoteId ?? ledger.imported[req.key]?.remoteId ?? null
      }
      if (known()) return { remoteId: known()! }
      const running = inflight.get(req.key)
      if (running) {
        try {
          return await running
        } catch {
          /* fall through: maybe its POST was sent */
        }
        if (known()) return { remoteId: known()! }
      }
      const rec = ledgerNow().sent[req.key]
      if (!rec) return null
      // Looked for at once; a look that tells nothing (unreadable, or too early for a "none": shows < listedBy) is
      // made once more when a read can surely show the job — at most LAST_LOOK_MAX_MS from now (a POST main may still
      // be sending after the page went away is not waited for minutes). Never posted: not found → "không rõ", and
      // "Chạy lại" looks first again.
      const found = await lookForJob(req, rec, [0, RECONCILE_DELAYS_MS[RECONCILE_DELAYS_MS.length - 1]])
      return typeof found === 'object' ? settle(req.key, found.remoteId, rec.nodeId) : null
    },

    poll: async (remoteIds) => {
      const out: RemoteStatus[] = []
      const byProject = new Map<string, { remoteId: string; jobId: string }[]>()
      for (const remoteId of remoteIds) {
        const d = decodeRemoteId(remoteId)
        if (!d) {
          out.push({ remoteId, state: 'failed', error: 'Mã job canvasapp không hợp lệ.' })
          continue
        }
        byProject.set(d.projectId, [...(byProject.get(d.projectId) ?? []), { remoteId, jobId: d.jobId }])
      }
      for (const [projectId, items] of byProject) {
        const jobs = await jobsOf(projectId)
        const byId = new Map(jobs.map((j) => [j.job_id, j]))
        for (const { remoteId, jobId } of items) {
          const job = byId.get(jobId)
          if (job) {
            misses.delete(remoteId)
            out.push(mapJobStatus(remoteId, job, deps.id === 'dev' ? 'canvasapp giả lập' : 'canvasapp'))
            continue
          }
          const n = (misses.get(remoteId) ?? 0) + 1
          misses.set(remoteId, n)
          out.push(
            n >= MAX_MISSES
              ? { remoteId, state: 'failed', error: 'Không thấy job trên canvasapp nữa (đã bị xoá?). Kiểm tra trên canvasapp.io.vn.' }
              : { remoteId, state: 'processing' },
          )
        }
      }
      return out
    },

    fetchResult: async (remoteId, opts) => {
      const d = decodeRemoteId(remoteId)
      if (!d) throw new CanvasappError('bad-request', 'Mã job canvasapp không hợp lệ.')
      const video = await api.fetchVideo(d.jobId, opts)
      return { video, poster: null }
    },

    // No cancel(): canvasapp has no documented cancel endpoint and DELETE may not refund. Cancelling in SanoVids
    // only stops tracking; the job keeps running (and costing) on canvasapp.

    // The job ledger (JOBS_KEY) is kept: it is what proves a take was already paid for after logging in again.
    reset: () => {
      state = { projectId: null, uploads: {}, entries: {} }
      storage.remove(STATE_KEY)
      lists.clear()
      lastLists.clear()
      misses.clear()
      // what the account could run is not known any more (logout): back to 'none'; a read in flight is ignored
      profilesEpoch++
      profiles = null
      profilesRead = null
      profilesSig = ''
      profilesReading = null
      profilesFollowUp = null
      profilesAttempt = null
      limitsMemo = null
      limitsChanged()
    },

    settingsLimits,
    limitsInfo,
    refreshLimits,

    refreshProfiles: async () => {
      const answer = await readAfterCurrent()
      if (!answer.ok) throw answer.error ?? new CanvasappError('network', 'Không đọc được cấu hình model từ canvasapp.')
      return answer.list
    },
    bridgeProjectId: () => state.projectId,
    uploadCacheSize: () => Object.keys(state.uploads).length,

    scanSiteJobs: async (input) => {
      // the remembered bridge session, else the one canvasapp has by name — looked up only, never created / remembered
      const projectId = state.projectId ?? (await api.listProjects()).find((p) => p.name === BRIDGE_PROJECT_NAME)?.project_id ?? null
      if (!projectId) return { projectId: null, listHasKeys: false, candidates: [], skipped: [] }
      // always read (the user asked: a job just made on the site must show); the poll reuses this read
      let jobs: CanvasJob[]
      try {
        jobs = await readJobs(projectId)
      } catch (e) {
        if (e instanceof CanvasappError && e.code === 'not-found') return { projectId: null, listHasKeys: false, candidates: [], skipped: [] }
        throw e
      }
      // finished jobs canvasapp does not let download (yet): when this computer first saw each so (mayStillDownload)
      const t = now()
      for (const j of jobs) {
        if (j && j.status === 'completed' && j.download_available === false && typeof j.job_id === 'string' && !undownloadableSince.has(j.job_id)) {
          undownloadableSince.set(j.job_id, t)
        }
      }
      while (undownloadableSince.size > MAX_IMPORTED_RECORDS) undownloadableSince.delete(undownloadableSince.keys().next().value as string)
      const found = classifySiteJobs(jobs, { ...input, projectId, ledger: ledgerNow(), now: t, firstSeen: undownloadableSince })
      if (found.candidates.length) {
        // the saved canvas (what the site ran the job from, unless edited since): hints only — unreadable is fine
        let canvas: unknown = null
        try {
          canvas = (await api.getProject(projectId))?.canvas ?? null
        } catch (e) {
          if (isLoginRequired(e)) throw e
        }
        const byUpload = new Map(Object.entries(state.uploads).map(([imageId, uploadId]) => [uploadId, imageId]))
        const imageOfUpload = (uploadId: string) => byUpload.get(uploadId) ?? null
        for (const c of found.candidates) c.hints = hintsFor(c.nodeId, canvas, state.entries, imageOfUpload)
      }
      return { projectId, ...found }
    },

    siteJobPrompts: async (jobIds) => {
      const out: Record<string, string | null> = {}
      // one after the other (gentle on canvasapp); an unreadable prompt is just unknown — a 401 stops everything
      for (const id of jobIds.slice(0, MAX_IMPORT_BATCH)) {
        try {
          out[id] = normalizeImportPrompt(await api.jobPrompt(id))
        } catch (e) {
          if (isLoginRequired(e)) throw e
          out[id] = null
        }
      }
      return out
    },

    claimSiteJobs: (claims) => {
      const jobIdsOf = (records: Record<string, { remoteId: string }>) => new Set(Object.values(records).map((r) => decodeRemoteId(r.remoteId)?.jobId))
      // what storage holds NOW (another tab may have posted or claimed since the scan), read and written in one step
      const ledger = ledgerNow()
      const made = jobIdsOf(ledger.jobs)
      const before = jobIdsOf(ledger.imported)
      const taken = new Set<string>()
      const next: JobLedger['imported'] = {}
      for (const c of claims) {
        const d = decodeRemoteId(c.remoteId)
        if (!d || d.jobId !== c.job.job_id || c.key in ledger.jobs || c.key in ledger.imported || c.key in ledger.sent || c.key in next) continue
        if (taken.has(d.jobId) || made.has(d.jobId) || (before.has(d.jobId) && !c.reimport)) continue
        // an unanswered POST may have made it (its take finds it, never a new take): the scan's rule, checked again now
        const keys = typeof c.job.client_request_id === 'string'
        if (Object.entries(ledger.sent).some(([k, r]) => !(k in ledger.jobs) && sentMayOwn(c.job, k, r, d.projectId, keys))) continue
        taken.add(d.jobId)
        next[c.key] = { remoteId: c.remoteId, at: now(), nodeId: c.nodeId }
      }
      const accepted = Object.keys(next)
      if (accepted.length) saveLedger({ ...ledger, imported: { ...ledger.imported, ...next } })
      return accepted
    },
  }
}
