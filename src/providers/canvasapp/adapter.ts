// VideoProvider for canvasapp.io.vn (experimental, desktop only, OFF by default).
// Uses the user's own canvasapp account and credits through the Electron session (no password ever reaches SanoVids).
//
// submit:  read /api/video-profiles (cached; unreadable → canvasapp's fallbacks) and refuse what canvasapp's page
//          would not run (H3 transform: also frames of different / unsupported ratios) → ensure the "SanoVids bridge"
//          project (created once — POST without body, then PATCH its name, like canvasapp's own page — id
//          remembered; found by name, e.g. after a logout: its canvas is read back first, GET /api/projects/{id}, so
//          no PUT takes off a node already there — also when a job known to run is on a node not remembered here,
//          e.g. made from another computer) → room on the bridge canvas next to the scenes whose jobs still run
//          (their nodes are never taken off; no room → 'deferred': back to the queue, nothing sent) → check every
//          reference image is on this computer → upload the missing ones (cache: SanoVids imageId → upload_id) → PUT
//          a minimal bridge canvas (so canvas_node_id exists; its entries are remembered only once accepted; refused
//          → once more without the scenes whose jobs have ended) → POST /api/video-jobs with
//          client_request_id = clientRequestIdFor(take id), a UUID stable per take.
//          Every body has exactly the client's shape (see mapping.ts and docs/canvasapp-api-notes.md).
// poll:    ONE GET /api/video-jobs?project_id=… for all running takes, never more often than every 15 s.
// result:  GET /api/video-jobs/{id}/stream → MP4 blob (the engine extracts the poster frame).
//
// Paying at most once per take (key = req.key = the take id; sent as clientRequestIdFor(key)). Persisted under
// JOBS_KEY (keyed by the take id), written synchronously:
//   - `jobs[key]`: the job canvasapp created for the key. A key with a known job is never posted again.
//   - `sent[key]`: written right BEFORE the POST, removed once its answer is known. If the answer never arrives
//     (connection broke, page closed / reloaded), the job may exist and be billed: it is looked for in the bridge
//     project's job list (findJob: same client_request_id when the list carries it, else the one new job on the
//     scene's canvas node) — by recover() after a reload, and before any new POST of that key.
//   - POST answered with a network error / 5xx / no job id → wait, look for the job (2 reads, 15 s apart); not there
//     → post again ONCE with the same body and key; still nothing → error flagged `uncertain` (the engine then shows
//     "không rõ đã trả chưa" and never resubmits that take under a new key by itself).
//   - opts.isCancelled() → stop before uploading / posting: a take cancelled while it waits here is never billed.
import type { ModelId } from '../../core/types'
import { capabilitiesFromModels } from '../capabilities'
import type { JobRequest, ProviderAvailability, ProviderCapabilities, ProviderId, RemoteStatus, SubmitOptions, VideoProvider } from '../types'
import { CanvasappError, canvasappErrorText, isLoginRequired, type CanvasappApi, type CanvasJob, type VideoJobBody, type VideoProfile } from './api'
import {
  adoptBridgeCanvas,
  ALLOWED_IMAGE_TYPES,
  BRIDGE_PROJECT_NAME,
  bridgeEntriesFrom,
  clientRequestIdFor,
  decodeRemoteId,
  encodeRemoteId,
  entryFromRequest,
  entryNodeId,
  imagesToUpload,
  inputShapeOf,
  jobIdFromCreateResponse,
  mapJobStatus,
  modelProfileOf,
  planBridgeCanvas,
  profileSpecOf,
  ratioFromDimensions,
  toVideoJobBody,
  transformFrameRatio,
  uploadFilename,
  validateRequest,
  withEntry,
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
 * A job found for a lost answer must be created after the request was sent. Generous on purpose: canvasapp's
 * created_at may come without a time zone (VERIFY), which can shift it by up to ±14 h.
 */
const CREATED_SKEW_MS = 14 * 3600_000
const MAX_JOB_RECORDS = 500
const MAX_SENT_RECORDS = 100
/** /api/video-profiles is read again after this long (canvasapp's page reads it once per page load). */
export const PROFILES_TTL_MS = 10 * 60_000
/** ...and after a failed read, on the next submit once this long has passed (meanwhile the client's fallbacks apply). */
const PROFILES_RETRY_MS = 60_000

export const UNCERTAIN_SUBMIT_TEXT =
  'Mất kết nối đúng lúc gửi yêu cầu tạo video: không rõ canvasapp đã nhận (và trừ credit) hay chưa — kiểm tra trên canvasapp.io.vn trước khi chạy lại.'
const CANCELLED_TEXT = 'Đã huỷ trước khi gửi sang canvasapp — không bị trừ credit.'
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
/**
 * The bridge project was found by name (after a logout, …) and its canvas could not be read: without it a PUT could take
 * a running job's node off, so none is sent. Followed by the cause; prefixed with CANVAS_NOT_SAVED_TEXT in the error.
 */
export const CANVAS_NOT_READ_TEXT = 'Không đọc được canvas cầu nối hiện có trên canvasapp (cần nó để giữ node của các video đang tạo):'
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
}

interface GatewayState {
  projectId: string | null
  /** SanoVids media-store imageId → canvasapp upload_id */
  uploads: Record<string, string>
  /**
   * The canvas of `projectId` as last accepted: sceneId → bridge entry (adoptedKey(node id) for a node read back from
   * canvasapp's canvas). Always of the same account and project as `projectId`: forgotten with it, read back with it.
   */
  entries: Record<string, BridgeEntry>
}

/** The bridge canvas could not be read back (canvasEntries). */
class CanvasUnreadError extends CanvasappError {}

/** A POST /api/video-jobs that was sent and whose answer is not known (yet). */
interface SentRecord {
  projectId: string
  nodeId: string
  /** Local time just before the request was sent. */
  at: number
  /** Job ids already on that canvas node before the POST (last job list read), when known. */
  before?: string[]
}

/** Per idempotency key (take id): what canvasapp was asked to create and what it created. Survives logout. */
interface JobLedger {
  /** `nodeId`: the bridge canvas node of the job (v0.2.5+), so its scene keeps that node while it runs. */
  jobs: Record<string, { remoteId: string; at: number; nodeId?: string }>
  sent: Record<string, SentRecord>
}

export const STATE_KEY = 'bdp:canvasapp:gateway'
export const JOBS_KEY = 'bdp:canvasapp:jobs'

export type CanvasappProvider = VideoProvider & {
  reset(): void
  /** Re-read /api/video-profiles (capabilities + validation). */
  refreshProfiles(): Promise<VideoProfile[]>
  bridgeProjectId(): string | null
  uploadCacheSize(): number
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

function createdTime(v: unknown): number {
  if (typeof v === 'number') return v
  return typeof v === 'string' ? Date.parse(v) : NaN
}

/** Persisted upload cache (imageId → upload_id), keeping only string → non-empty string pairs. */
function uploadsFrom(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0))
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
  let profilesRead: { at: number; ok: boolean } | null = null
  let ensuring: Promise<string> | null = null
  /** Serialises submits: uploads + canvas PUT + job POST of one take never interleave with another's. */
  let chain: Promise<unknown> = Promise.resolve()
  /** Submits in progress by key (a second submit / recover of the same key joins it). */
  const inflight = new Map<string, Promise<{ remoteId: string }>>()
  /** Job list cache of the poll (dropped after a POST so the next poll sees the new job). */
  const lists = new Map<string, { at: number; jobs: CanvasJob[] }>()
  /** Last job list read per bridge project, kept when the cache above is dropped: which jobs still run. */
  const lastLists = new Map<string, { at: number; jobs: CanvasJob[] }>()
  /** When the bridge canvas of a project was last read back (GET /api/projects/{id}). */
  const readBack = new Map<string, number>()
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
        return { jobs: p.jobs && typeof p.jobs === 'object' ? p.jobs : {}, sent: p.sent && typeof p.sent === 'object' ? p.sent : {} }
      }
    } catch {
      /* ignore */
    }
    return { jobs: {}, sent: {} }
  }
  function newest<T extends { at: number }>(rec: Record<string, T>, max: number): Record<string, T> {
    const entries = Object.entries(rec)
    return entries.length <= max ? rec : Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, max))
  }
  function saveLedger(next: JobLedger) {
    ledger = { jobs: newest(next.jobs, MAX_JOB_RECORDS), sent: newest(next.sent, MAX_SENT_RECORDS) }
    storage.set(JOBS_KEY, JSON.stringify(ledger))
  }
  /**
   * The key got its job (on canvas node `nodeId`): remember it (never posted again) with its node — kept on the bridge
   * canvas while the job runs (runningScenes) — and drop the "sent" record.
   */
  function settle(key: string, remoteId: string, nodeId: string): { remoteId: string } {
    const { [key]: _done, ...sent } = ledger.sent
    saveLedger({ jobs: { ...ledger.jobs, [key]: { remoteId, at: now(), nodeId } }, sent })
    return { remoteId }
  }
  /** A job list was read (poll, lookup or room check). */
  function remember(projectId: string, jobs: CanvasJob[]) {
    const read = { at: now(), jobs }
    lists.set(projectId, read)
    lastLists.set(projectId, read)
  }

  /**
   * Video nodes of the bridge canvas a job may still need according to `list` (a job-list read of the project): its
   * jobs not ended (node = the job's canvas_node_id, else the one the ledger recorded), plus the ledger's jobs it does
   * not show — made after it, or not listed yet for a short while. No read: those recent ledger jobs only.
   */
  function runningIn(projectId: string, list: { at: number; jobs: CanvasJob[] } | undefined): Set<string> {
    /** This computer's jobs on that project (ledger): job id → node, when it was made. */
    const mine = new Map<string, { nodeId?: string; at: number }>()
    for (const rec of Object.values(ledger.jobs)) {
      const d = decodeRemoteId(rec.remoteId)
      if (d?.projectId === projectId) mine.set(d.jobId, { nodeId: rec.nodeId, at: rec.at })
    }
    const nodes = new Set<string>()
    const listed = new Set<string>()
    for (const j of list?.jobs ?? []) {
      listed.add(j.job_id)
      if (ENDED_JOB_STATUSES.has(String(j.status))) continue
      const node = typeof j.canvas_node_id === 'string' ? j.canvas_node_id : mine.get(j.job_id)?.nodeId
      if (node) nodes.add(node)
    }
    for (const [jobId, m] of mine) {
      if (!m.nodeId || listed.has(jobId)) continue
      if ((list && m.at >= list.at) || now() - m.at < unlistedGraceMs) nodes.add(m.nodeId)
    }
    return nodes
  }

  /**
   * runningIn the last job-list read, read again when older than MIN_POLL_MS.
   * null = unknown (no list could be read). Throws when the login is needed.
   */
  async function runningNodes(projectId: string): Promise<Set<string> | null> {
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
    return list ? runningIn(projectId, list) : null
  }
  function markSent(key: string, rec: SentRecord) {
    saveLedger({ ...ledger, sent: { ...ledger.sent, [key]: rec } })
  }
  function clearSent(key: string) {
    if (!(key in ledger.sent)) return
    const { [key]: _gone, ...sent } = ledger.sent
    saveLedger({ ...ledger, sent })
  }

  /**
   * The bridge canvas as canvasapp saved it, as entries (adoptBridgeCanvas): every node already there, those of the
   * jobs still running among them. Throws CanvasUnreadError when it cannot be read — then nothing may be PUT.
   */
  async function canvasEntries(projectId: string): Promise<Record<string, BridgeEntry>> {
    const at = now()
    let entries: Record<string, BridgeEntry> | null
    try {
      const project: unknown = await api.getProject(projectId)
      entries = project && typeof project === 'object' && !Array.isArray(project) ? adoptBridgeCanvas((project as { canvas?: unknown }).canvas) : null
    } catch (e) {
      if (!(e instanceof CanvasappError) || isLoginRequired(e)) throw e
      throw new CanvasUnreadError(e.code, `${CANVAS_NOT_READ_TEXT} ${e.message}`, { status: e.status, detail: e.detail })
    }
    if (!entries) throw new CanvasUnreadError('bad-response', `${CANVAS_NOT_READ_TEXT} canvas trả về không đúng định dạng mong đợi [GET /api/projects/{id}].`)
    readBack.set(projectId, at)
    return entries
  }

  /**
   * Nodes the ledger or the last job-list read (none is made for this) says a job still needs but the remembered canvas
   * does not hold — a job made on this account from another computer, …: the canvas is read back and those nodes kept,
   * so the next PUT does not take them off. Nothing missing (the usual case) → no request. Not read again when the
   * last read is newer than that job-list read: a node it did not show is not on the canvas.
   */
  async function keepRunningNodes(projectId: string) {
    const held = new Set(Object.values(state.entries).map(entryNodeId))
    const list = lastLists.get(projectId)
    const unheld = [...runningIn(projectId, list)].filter((n) => !held.has(n))
    if (!unheld.length) return
    const read = readBack.get(projectId)
    if (read !== undefined && read >= (list?.at ?? -Infinity)) return
    const back = Object.values(await canvasEntries(projectId)).filter((e) => unheld.includes(entryNodeId(e)))
    if (!back.length) return
    state = { ...state, entries: { ...Object.fromEntries(back.map((e) => [e.sceneId, e])), ...state.entries } }
    save()
  }

  async function ensureProject(): Promise<string> {
    if (state.projectId) return state.projectId
    if (!ensuring) {
      ensuring = (async () => {
        const existing = (await api.listProjects()).find((p) => p.name === BRIDGE_PROJECT_NAME)
        // Found by name (after a logout or a login to another account, a deleted remembered id, another computer…):
        // what is on its canvas is not known here — the entries remembered here (if any) belong to a forgotten
        // session. Read it back, so the next PUT keeps every node there, the nodes of jobs still running among them
        // (whether canvasapp cancels or loses a job whose node leaves the canvas is not known). The id is remembered
        // only together with it: unreadable → nothing remembered, nothing PUT.
        const entries = existing ? await canvasEntries(existing.project_id) : {}
        // canvasapp's page creates a project with an empty POST and names it with PATCH {name} ("Đổi tên phiên").
        const id = existing?.project_id ?? (await api.createProject())
        state = { ...state, projectId: id, entries }
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
   * and drop the scene's bridge entry that names them (rebuilt by the next submit of that scene) — unless an earlier
   * take of that scene still runs (`keepEntry`): its node stays on the canvas, only the upload cache is forgotten.
   */
  function forgetUploads(req: JobRequest, keepEntry: boolean) {
    const uploads = { ...state.uploads }
    for (const id of imagesToUpload(req)) delete uploads[id]
    const { [req.sceneId]: _gone, ...others } = state.entries
    state = { ...state, uploads, entries: keepEntry ? state.entries : others }
    save()
  }

  /**
   * /api/video-profiles, read like canvasapp's page does at boot (loadVideoProfiles()): 401 → login error; any other
   * failure → [] (= its fallbacks: Seedance on, MiniMax-H3 locked), tried again later. `ok` false = fallbacks.
   */
  async function currentProfiles(): Promise<{ list: VideoProfile[]; ok: boolean }> {
    const fresh = profiles && profilesRead && now() - profilesRead.at < (profilesRead.ok ? PROFILES_TTL_MS : PROFILES_RETRY_MS)
    if (!fresh) {
      try {
        profiles = await api.videoProfiles()
        profilesRead = { at: now(), ok: true }
      } catch (e) {
        if (isLoginRequired(e)) throw e
        profiles = []
        profilesRead = { at: now(), ok: false }
      }
    }
    return { list: profiles ?? [], ok: profilesRead?.ok ?? false }
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
   * one could be it (never guessed). Throws when the list cannot be read.
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
    const taken = new Set(Object.values(ledger.jobs).map((j) => decodeRemoteId(j.remoteId)?.jobId))
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
    return candidates.length === 1 ? remote(candidates[0]) : candidates.length ? 'ambiguous' : 'none'
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
  /** `sceneRunning`: does an earlier job of this scene still run (its bridge entry must then stay)? */
  async function postJob(
    req: JobRequest,
    body: VideoJobBody,
    opts: SubmitOptions,
    afterLost: boolean,
    sceneRunning: () => Promise<boolean>,
  ): Promise<{ remoteId: string }> {
    const known = lists.get(body.project_id)?.jobs
    const rec: SentRecord = {
      projectId: body.project_id,
      nodeId: body.canvas_node_id,
      at: now(),
      ...(known ? { before: known.filter((j) => j.canvas_node_id === body.canvas_node_id).map((j) => j.job_id) } : {}),
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
            // (unknown whether an earlier take of the scene still runs → keep its entry: its node may be needed)
            forgetUploads(req, await sceneRunning().catch(() => true))
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
        continue
      }
      throw uncertainError()
    }
  }

  async function submitNow(req: JobRequest, opts: SubmitOptions): Promise<{ remoteId: string }> {
    const checkCancelled = () => {
      if (opts.isCancelled?.()) throw new CanvasappError('cancelled', CANCELLED_TEXT)
    }
    // A job already exists for this key: never post it again.
    const done = ledger.jobs[req.key]
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
    /** Nothing billable was sent this time: say so, and which step failed (the login message stays as it is). */
    const notSaved = (e: unknown) => {
      if (!(e instanceof CanvasappError) || isLoginRequired(e) || e.code === 'cancelled' || e.code === 'deferred') return e
      const text = earlier ? CANVAS_NOT_SAVED_AFTER_LOST_TEXT : CANVAS_NOT_SAVED_TEXT
      return new CanvasappError(e.code, `${text} ${e.message}`, { status: e.status, detail: e.detail, noCredit: e.noCredit })
    }
    const unread = (e: unknown) => {
      throw e instanceof CanvasUnreadError ? notSaved(e) : e
    }
    let projectId = await ensureProject().catch(unread)
    await keepRunningNodes(projectId).catch(unread)
    checkCancelled()
    // The bridge canvas holds one video node per scene. A scene whose job may still run keeps its node — whether
    // canvasapp cancels or loses a job whose node leaves the canvas is not known — so only the other scenes may be
    // left out to make room. Which nodes run is only looked up when something has to be left out.
    let running: { nodes: Set<string> | null } | null = null
    const runningNow = async () => (running ??= { nodes: await runningNodes(projectId) }).nodes
    /** Keys of `entries` whose node a job may still need — all of them when that is unknown (job list unreadable). */
    const keepOf = async (entries: Record<string, BridgeEntry>) => {
      const nodes = await runningNow()
      return new Set(Object.keys(entries).filter((k) => !nodes || nodes.has(entryNodeId(entries[k]))))
    }
    /** Canvas of `entries`: this scene first, every running scene kept; null = they do not all fit. */
    const canvasOf = async (entries: Record<string, BridgeEntry>) => {
      const list = Object.values(entries)
      const all = planBridgeCanvas(list, { current: req.sceneId })
      if (!all.dropped.length) return all.canvas
      const plan = planBridgeCanvas(list, { current: req.sceneId, keep: await keepOf(entries) })
      return plan.missing.length ? null : plan.canvas
    }
    const noRoom = () => new CanvasappError('deferred', CANVAS_FULL_TEXT)
    // Room first, before anything is uploaded (pictures not uploaded yet count as new image nodes): none → the take
    // goes back to the queue and is tried again once a running job has ended. Nothing sent.
    const draft = entryFromRequest(req, (imageId) => state.uploads[imageId] ?? `pending:${imageId}`, now(), frameRatio)
    if (!(await canvasOf(withEntry(state.entries, draft)))) throw noRoom()
    checkCancelled()
    await uploadMissing(req, checkCancelled)
    const entry = entryFromRequest(req, uploadIdFor, now(), frameRatio)
    /** PUT the canvas made of `entries`; they become the remembered entries only once canvasapp accepted it. */
    const putCanvas = async (entries: Record<string, BridgeEntry>) => {
      const canvas = await canvasOf(entries)
      if (!canvas) throw noRoom()
      await api.putCanvas(projectId, canvas)
      state = { ...state, entries }
      save()
    }
    try {
      try {
        await putCanvas(withEntry(state.entries, entry))
      } catch (e) {
        if (e instanceof CanvasappError && e.code === 'not-found') {
          // The remembered bridge project was deleted on canvasapp → create/find it again once (a bridge found by
          // name has its canvas read back first) and look up again which of its nodes run.
          state = { ...state, projectId: null, entries: {} }
          save()
          running = null
          projectId = await ensureProject()
          await putCanvas(withEntry(state.entries, entry))
        } else if (e instanceof CanvasappError && e.code === 'bad-request') {
          // Refused: an older scene's node may be what canvasapp does not accept now (expired upload, changed
          // rules…). A PUT is free → once more without the scenes that may go: this one and the running ones only
          // (a running job keeps its node). Accepted → the others are dropped. Nothing may go → the refusal stands.
          const keep = await keepOf(state.entries)
          const node = entryNodeId(entry)
          const others = Object.entries(state.entries).filter(([k, e]) => k !== req.sceneId && entryNodeId(e) !== node)
          if (others.every(([k]) => keep.has(k))) throw e
          await putCanvas(withEntry(Object.fromEntries(others.filter(([k]) => keep.has(k))), entry))
        } else throw e
      }
    } catch (e) {
      throw notSaved(e)
    }
    // Last chance to stop: the POST below is what canvasapp bills.
    checkCancelled()
    const body = toVideoJobBody(req, { projectId, uploadIdFor, generateAudio: deps.generateAudio?.() ?? true })
    return postJob(req, body, opts, !!earlier, async () => {
      const nodes = await runningNow()
      return !nodes || nodes.has(entryNodeId(entry))
    })
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
      const base = capabilitiesFromModels(model, { maxConcurrency: MAX_CONCURRENCY, pollIntervalMs: pollMs, maxRefVideos: 0 })
      const o = profiles ? profileSpecOf(model, profiles).options : undefined
      if (!o || typeof o !== 'object') return base
      // Seedance's profile is used as canvasapp sends it: never trust a list to be one (the engine calls this)
      const list = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null)
      const strings = (v: unknown) => list(v)?.filter((x): x is string => typeof x === 'string') ?? null
      const modes = strings(o.modes)
      const disabled = strings(o.disabled_modes) ?? []
      const durations = list(o.durations)
      return {
        ...base,
        modes: base.modes.filter((m) => (!modes || modes.includes(m)) && !disabled.includes(m)),
        durations: durations ? durations.map(Number).filter(Number.isFinite) : base.durations,
        resolutions: strings(o.resolutions) ?? base.resolutions,
        ratios: strings(o.aspect_ratios) ?? base.ratios,
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
      const known = () => ledger.jobs[req.key]?.remoteId ?? null
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

    fetchResult: async (remoteId) => {
      const d = decodeRemoteId(remoteId)
      if (!d) throw new CanvasappError('bad-request', 'Mã job canvasapp không hợp lệ.')
      const video = await api.fetchVideo(d.jobId)
      return { video, poster: null }
    },

    // No cancel(): canvasapp has no documented cancel endpoint and DELETE may not refund. Cancelling in SanoVids
    // only stops tracking; the job keeps running (and costing) on canvasapp.

    // The job ledger (JOBS_KEY) is kept: it is what proves a take was already paid for after logging in again.
    // The bridge entries go with the session (they may be of another account than the next login's — never PUT into
    // its canvas): the next submit finds the bridge by name and reads its canvas back first (ensureProject), so the
    // nodes of jobs still running stay on it.
    reset: () => {
      state = { projectId: null, uploads: {}, entries: {} }
      storage.remove(STATE_KEY)
      lists.clear()
      lastLists.clear()
      readBack.clear()
      misses.clear()
      profiles = null
      profilesRead = null
    },

    refreshProfiles: async () => {
      profiles = await api.videoProfiles()
      profilesRead = { at: now(), ok: true }
      return profiles
    },
    bridgeProjectId: () => state.projectId,
    uploadCacheSize: () => Object.keys(state.uploads).length,
  }
}
