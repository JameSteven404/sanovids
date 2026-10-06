// VideoProvider for canvasapp.io.vn (experimental, desktop only, OFF by default).
// Uses the user's own canvasapp account and credits through the Electron session (no password ever reaches SanoVids).
//
// submit:  read /api/video-profiles (cached; unreadable → canvasapp's fallbacks) and refuse what canvasapp's page
//          would not run (H3 transform: also frames of different / unsupported ratios) → ensure the "SanoVids bridge"
//          project (created once — POST without body, then PATCH its name, like canvasapp's own page — id
//          remembered) → room on the bridge canvas next to the nodes whose jobs still run (never taken off; no room →
//          'deferred': back to the queue, nothing sent) → check every reference image is on this computer → upload the
//          missing ones (cache: SanoVids imageId → upload_id) → PUT a minimal bridge canvas (so canvas_node_id exists;
//          its entries are remembered only once accepted, without the ones left off it; refused → once more without
//          the nodes whose jobs have ended) → POST /api/video-jobs with client_request_id = clientRequestIdFor(take
//          id), a UUID stable per take.
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
//   - `sent[key]`: written right BEFORE the POST, removed once its answer is known. If the answer never arrives
//     (connection broke, page closed / reloaded), the job may exist and be billed: it is looked for in the bridge
//     project's job list (findJob: same client_request_id when the list carries it, else the one new job on the
//     canvas node the POST named — never one another take's unanswered POST on that node may have made: next to
//     such a take the list is read right before posting, so their jobs can be told apart; unreadable → not sent)
//     — by recover() after a reload, and before any new POST of that key.
//   - POST answered with a network error / 5xx / no job id → wait, look for the job (2 reads, 15 s apart); not there
//     → post again ONCE with the same body and key; still nothing → error flagged `uncertain` (the engine then shows
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
  CREATED_SKEW_MS,
  createdTime,
  hintsFor,
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
/** After a POST /api/video-jobs without a clear answer: wait this long before each look at the job list. */
export const RECONCILE_DELAYS_MS = [15_000, 15_000]
/**
 * A job a POST made is in the job list this long after the POST, or never — what postJob already bets on before it
 * posts again. So a list read this long after another take's POST shows that take's job, if it has one.
 */
const SETTLE_MS = RECONCILE_DELAYS_MS.reduce((a, b) => a + b, 0)
// CREATED_SKEW_MS (how far created_at may be off): siteJobs.ts, shared with the import's reservation rule.
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
/**
 * Another take's POST on the same node has no answer yet: the job list must be read right before this POST (so each
 * take can later tell its job from the other's) and could not be. Nothing was sent.
 */
export const LIST_NEEDED_TEXT =
  'Không đọc được danh sách job trên canvasapp — cần đọc ngay trước khi gửi vì một take khác của cảnh này chưa rõ đã được canvasapp nhận chưa. Chưa gửi yêu cầu tạo video, không bị trừ credit.'
/** ...for a take whose earlier POST lost its answer (that one may still have been billed). */
const LIST_NEEDED_AFTER_LOST_TEXT =
  'Không đọc được danh sách job trên canvasapp — cần đọc ngay trước khi gửi vì một take khác của cảnh này chưa rõ đã được canvasapp nhận chưa. Lần này chưa gửi lại yêu cầu tạo video (lần gửi trước vẫn chưa rõ đã bị trừ credit chưa).'
/** Prefixed to a failed canvas PUT: the job POST is only ever sent after the canvas was accepted. */
export const CANVAS_NOT_SAVED_TEXT = 'Lưu canvas cầu nối trên canvasapp không thành công — chưa gửi yêu cầu tạo video, không bị trừ credit.'
/** ...for a take whose earlier POST lost its answer (that one may still have been billed). */
const CANVAS_NOT_SAVED_AFTER_LOST_TEXT =
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
  /** Job ids already on that canvas node before the POST (last job list read), when known. */
  before?: string[]
  /** When that read was made (local time; records of earlier builds do not say). */
  beforeAt?: number
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
 * Could `j` be the job that the POST recorded as `r` made? On its node, not listed before it, not created long before
 * it (created_at may be off by hours: CREATED_SKEW_MS) — unknown creation time: it could.
 */
function mayBeJobOf(j: CanvasJob, r: SentRecord): boolean {
  if (j.canvas_node_id !== r.nodeId || r.before?.includes(j.job_id)) return false
  const t = createdTime(j.created_at)
  return !Number.isFinite(t) || t >= r.at - CREATED_SKEW_MS
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

  let state: GatewayState = load()
  let ledger: JobLedger = loadLedger()
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
  const lists = new Map<string, { at: number; jobs: CanvasJob[] }>()
  /** Last job list read per bridge project, kept when the cache above is dropped: which jobs still run. */
  const lastLists = new Map<string, { at: number; jobs: CanvasJob[] }>()
  /** A job of the ledger that a job-list read does not show (yet): still treated as running this long after it was made. */
  const unlistedGraceMs = (MAX_MISSES + 1) * pollMs
  const misses = new Map<string, number>()

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
  function loadLedger(): JobLedger {
    try {
      const raw = storage.get(JOBS_KEY)
      if (raw) {
        const p = JSON.parse(raw) as Partial<JobLedger>
        return {
          jobs: p.jobs && typeof p.jobs === 'object' ? p.jobs : {},
          sent: p.sent && typeof p.sent === 'object' ? p.sent : {},
          // a ledger of a build before "Nhập job" has none; malformed records are dropped
          imported: recordsFrom(p.imported, (r) => typeof r.nodeId === 'string'),
        }
      }
    } catch {
      /* ignore */
    }
    return { jobs: {}, sent: {}, imported: {} }
  }
  function newest<T extends { at: number }>(rec: Record<string, T>, max: number): Record<string, T> {
    const entries = Object.entries(rec)
    return entries.length <= max ? rec : Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, max))
  }
  function saveLedger(next: JobLedger) {
    ledger = { jobs: newest(next.jobs, MAX_JOB_RECORDS), sent: newest(next.sent, MAX_SENT_RECORDS), imported: newest(next.imported, MAX_IMPORTED_RECORDS) }
    storage.set(JOBS_KEY, JSON.stringify(ledger))
  }
  /**
   * The key got its job (on canvas node `nodeId`): remember it (never posted again) with its node — kept on the bridge
   * canvas while the job runs (runningNodeKeys) — and drop the "sent" record.
   */
  function settle(key: string, remoteId: string, nodeId: string): { remoteId: string } {
    const { [key]: _done, ...sent } = ledger.sent
    saveLedger({ ...ledger, jobs: { ...ledger.jobs, [key]: { remoteId, at: now(), nodeId } }, sent })
    return { remoteId }
  }
  /** A job list was read (poll, lookup or room check). */
  function remember(projectId: string, jobs: CanvasJob[]) {
    const read = { at: now(), jobs }
    lists.set(projectId, read)
    lastLists.set(projectId, read)
  }

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
        remember(projectId, await api.listVideoJobs(projectId))
        list = lastLists.get(projectId)
      } catch (e) {
        if (isLoginRequired(e)) throw e
        // unreadable now: an older read (plus the jobs made since) is better than nothing
      }
    }
    if (!list) return null
    /** This computer's jobs on that project (ledger): job id → node, when it was made. */
    const mine = new Map<string, { nodeId?: string; at: number }>()
    for (const rec of Object.values(ledger.jobs)) {
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
    const sentOn = ledger.sent[req.key]?.nodeId
    return sentOn !== undefined && sentOn === canvasNodeId(req.sceneId) ? req.sceneId : sceneNodeKey(req.sanovidsProjectId, req.sceneId)
  }
  function markSent(key: string, rec: SentRecord) {
    saveLedger({ ...ledger, sent: { ...ledger.sent, [key]: rec } })
  }
  /** Other takes' POSTs on that node of that bridge project whose answer is not known: their job may be there, unclaimed. */
  function rivalsOf(key: string, projectId: string, nodeId: string): SentRecord[] {
    return Object.entries(ledger.sent)
      .filter(([k, r]) => k !== key && !(k in ledger.jobs) && r.projectId === projectId && r.nodeId === nodeId)
      .map(([, r]) => r)
  }
  function clearSent(key: string) {
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
   * one could be it, or another take could own it (never guessed). Throws when the list cannot be read.
   */
  async function findJob(req: JobRequest, rec: SentRecord): Promise<{ remoteId: string } | 'none' | 'ambiguous'> {
    lists.delete(rec.projectId)
    const jobs = await api.listVideoJobs(rec.projectId)
    remember(rec.projectId, jobs)
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
    // after it passed sentMayOwn against this very record (its window ends CREATED_SKEW_MS + POST_WINDOW_MS after the
    // POST, the lookup below has no such end) — either way not this POST's job, and never a second take of one job.
    const taken = new Set([...Object.values(ledger.jobs), ...Object.values(ledger.imported)].map((j) => decodeRemoteId(j.remoteId)?.jobId))
    const before = new Set(rec.before ?? [])
    const model = modelProfileOf(req.model)
    const candidates = jobs.filter((j) => {
      if (j.canvas_node_id !== rec.nodeId || taken.has(j.job_id) || before.has(j.job_id)) return false
      // loadJobs(): the canvas page only shows jobs without creation_mode or with 'canvas'
      if (j.creation_mode !== undefined && j.creation_mode !== null && j.creation_mode !== 'canvas') return false
      if (j.model_profile !== undefined && j.model_profile !== model) return false
      if (j.duration !== undefined && Number(j.duration) !== req.duration) return false
      const t = createdTime(j.created_at)
      return Number.isFinite(t) ? t >= rec.at - CREATED_SKEW_MS : rec.before !== undefined
    })
    if (candidates.length !== 1) return candidates.length ? 'ambiguous' : 'none'
    // ...and that no other take still without an answer on that node may own: that take looks for it too — taking it
    // would make that take post again (a second charge, the wrong video here). A LATER POST may own any job its own
    // read before it did not show; an EARLIER one only a job this POST's read did not show although it was made
    // SETTLE_MS after that POST (postJob reads the list right before posting next to such a take). Not known → both
    // could own it: neither takes it ("không rõ" for both, nothing re-posted).
    const [job] = candidates
    const contested = rivalsOf(req.key, rec.projectId, rec.nodeId).some(
      (r) => mayBeJobOf(job, r) && (r.at >= rec.at || rec.beforeAt === undefined || rec.beforeAt - r.at < SETTLE_MS),
    )
    return contested ? 'ambiguous' : remote(job)
  }

  /** Look for the job after an unanswered POST (waits first: canvasapp may still be creating it). */
  async function lookForJob(req: JobRequest, rec: SentRecord): Promise<{ remoteId: string } | 'none' | 'unknown'> {
    let last: 'none' | 'unknown' = 'unknown'
    for (const ms of RECONCILE_DELAYS_MS) {
      await sleep(ms)
      try {
        const found = await findJob(req, rec)
        if (found === 'ambiguous') return 'unknown'
        if (found !== 'none') return found
        last = 'none'
      } catch {
        // list unreadable: this look tells nothing (an earlier "none" still stands)
      }
    }
    return last
  }

  const uncertainError = () => new CanvasappError('network', UNCERTAIN_SUBMIT_TEXT, { uncertain: true })

  /** POST the job once; when the answer is lost, find the job or post the SAME body (same key) one more time. */
  /** `afterLost`: this key was posted before and its answer was lost — a refusal now does not mean "not billed". */
  /** `nodeKey` / `nodeRunning`: the bridge entry of the job's node; does an earlier job on it still run (it then stays)? */
  async function postJob(
    req: JobRequest,
    nodeKey: string,
    body: VideoJobBody,
    opts: SubmitOptions,
    afterLost: boolean,
    nodeRunning: () => Promise<boolean>,
  ): Promise<{ remoteId: string }> {
    // Jobs on that node in the last job-list read, however old: listed before this POST, so none of them is its job.
    const known = lastLists.get(body.project_id)
    let rec: SentRecord = {
      projectId: body.project_id,
      nodeId: body.canvas_node_id,
      at: now(),
      ...(known ? { before: known.jobs.filter((j) => j.canvas_node_id === body.canvas_node_id).map((j) => j.job_id), beforeAt: known.at } : {}),
    }
    markSent(req.key, rec)
    let reposted = false
    for (;;) {
      try {
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
      const found = await lookForJob(req, rec)
      if (typeof found === 'object') {
        lists.delete(body.project_id)
        return settle(req.key, found.remoteId, rec.nodeId)
      }
      if (found === 'none' && !reposted && !opts.isCancelled?.()) {
        reposted = true
        // its time is now this POST's (a take posting next to it later reads the list SETTLE_MS after THIS one)
        rec = { ...rec, at: now() }
        markSent(req.key, rec)
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
    const done = ledger.jobs[req.key] ?? ledger.imported[req.key]
    if (done) return { remoteId: done.remoteId }
    checkCancelled()
    // This key was posted before without a known answer (an explicit retry of an "unknown" take): look first —
    // a job found there is this take's, whatever the checks below would say today.
    const earlier = ledger.sent[req.key]
    if (earlier) {
      let found: Awaited<ReturnType<typeof findJob>>
      try {
        found = await findJob(req, earlier)
      } catch (e) {
        throw new CanvasappError('network', `${UNCERTAIN_SUBMIT_TEXT} (${canvasappErrorText(e)})`, { uncertain: true })
      }
      if (typeof found === 'object') return settle(req.key, found.remoteId, earlier.nodeId)
      if (found === 'ambiguous') throw uncertainError()
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
      throw new CanvasappError(e.code, `${text} ${e.message}`, { status: e.status, detail: e.detail, noCredit: e.noCredit })
    }
    const body = toVideoJobBody(req, { projectId, nodeKey, uploadIdFor, generateAudio: deps.generateAudio?.() ?? true })
    // Another take's POST on this node has no answer yet: read the job list now, so its job (if it has one) is in this
    // POST's `before` — then neither take can take the other's job (findJob). Unreadable → not sent: posting now could
    // leave two takes that can never tell their jobs apart.
    if (rivalsOf(req.key, projectId, body.canvas_node_id).length) {
      checkCancelled()
      lists.delete(projectId)
      try {
        remember(projectId, await api.listVideoJobs(projectId))
      } catch (e) {
        if (isLoginRequired(e)) throw e
        const text = earlier ? LIST_NEEDED_AFTER_LOST_TEXT : LIST_NEEDED_TEXT
        throw new CanvasappError(e instanceof CanvasappError ? e.code : 'network', `${text} (${canvasappErrorText(e)})`, {
          status: e instanceof CanvasappError ? e.status : undefined,
        })
      }
    }
    // Last chance to stop: the POST below is what canvasapp bills.
    checkCancelled()
    return postJob(req, nodeKey, body, opts, !!earlier, async () => (await runningNow()).has(nodeKey))
  }

  async function jobsOf(projectId: string): Promise<CanvasJob[]> {
    const hit = lists.get(projectId)
    // ≤ minPollMs (not pollMs): the engine polls every pollMs, a cache as long as that would skip every other poll.
    if (hit && now() - hit.at < listCacheMs) return hit.jobs
    const jobs = await api.listVideoJobs(projectId)
    remember(projectId, jobs)
    return jobs
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
      const known = () => ledger.jobs[req.key]?.remoteId ?? ledger.imported[req.key]?.remoteId ?? null
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
      const rec = ledger.sent[req.key]
      if (!rec) return null
      try {
        const found = await findJob(req, rec)
        if (typeof found === 'object') return settle(req.key, found.remoteId, rec.nodeId)
      } catch {
        /* unknown */
      }
      return null
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
        jobs = await api.listVideoJobs(projectId)
      } catch (e) {
        if (e instanceof CanvasappError && e.code === 'not-found') return { projectId: null, listHasKeys: false, candidates: [], skipped: [] }
        throw e
      }
      remember(projectId, jobs)
      const found = classifySiteJobs(jobs, { ...input, projectId, ledger, now: now() })
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
