// VideoProvider for canvasapp.io.vn (experimental, desktop only, OFF by default).
// Uses the user's own canvasapp account and credits through the Electron session (no password ever reaches SanoVids).
//
// submit:  ensure the "SanoVids bridge" project (created once, id remembered) → check every reference image is on
//          this computer → upload the missing ones (cache: SanoVids imageId → upload_id) → PUT a minimal bridge canvas
//          (so canvas_node_id exists) → POST /api/video-jobs with client_request_id = take id (idempotency).
// poll:    ONE GET /api/video-jobs?project_id=… for all running takes, never more often than every 15 s.
// result:  GET /api/video-jobs/{id}/stream → MP4 blob (the engine extracts the poster frame).
//
// Paying at most once per take (key = req.key = client_request_id). Persisted under JOBS_KEY, written synchronously:
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
import type { JobRequest, ProviderAvailability, ProviderCapabilities, RemoteStatus, SubmitOptions, VideoProvider } from '../types'
import { CanvasappError, canvasappErrorText, type CanvasappApi, type CanvasJob, type VideoJobBody, type VideoProfile } from './api'
import {
  ALLOWED_IMAGE_TYPES,
  BRIDGE_PROJECT_NAME,
  bridgeCanvas,
  decodeRemoteId,
  encodeRemoteId,
  entryFromRequest,
  imagesToUpload,
  jobIdFromCreateResponse,
  mapJobStatus,
  modelProfileOf,
  toVideoJobBody,
  uploadFilename,
  validateRequest,
  type BridgeEntry,
} from './mapping'

/** Never poll canvasapp more often than this (the site itself polls every 60 s). */
export const MIN_POLL_MS = 15_000
export const DEFAULT_POLL_MS = 20_000
/** Jobs running at the same time through the gateway. */
export const MAX_CONCURRENCY = 2
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

export const UNCERTAIN_SUBMIT_TEXT =
  'Mất kết nối đúng lúc gửi yêu cầu tạo video: không rõ canvasapp đã nhận (và trừ credit) hay chưa — kiểm tra trên canvasapp.io.vn trước khi chạy lại.'
const CANCELLED_TEXT = 'Đã huỷ trước khi gửi sang canvasapp — không bị trừ credit.'

export interface KeyValueStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export const memoryStorage = (): KeyValueStorage => {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) }
}

export const browserStorage = (): KeyValueStorage => ({
  get: (k) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* ignore */
    }
  },
  remove: (k) => {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  },
})

export interface CanvasappProviderDeps {
  api: CanvasappApi
  /** Media-store lookup (lib/imageStore getBlob). */
  getBlob: (imageId: string) => Promise<Blob | null>
  storage?: KeyValueStorage
  now?: () => number
  /** Waits between looks at the job list after an unanswered POST (tests: fake timers). Default setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** ≥ MIN_POLL_MS. */
  pollIntervalMs?: number
  generateAudio?: () => boolean
}

interface GatewayState {
  projectId: string | null
  /** SanoVids media-store imageId → canvasapp upload_id */
  uploads: Record<string, string>
  /** sceneId → bridge entry */
  entries: Record<string, BridgeEntry>
}

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
  jobs: Record<string, { remoteId: string; at: number }>
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

function createdTime(v: unknown): number {
  if (typeof v === 'number') return v
  return typeof v === 'string' ? Date.parse(v) : NaN
}

export function createCanvasappProvider(deps: CanvasappProviderDeps): CanvasappProvider {
  const { api } = deps
  const storage = deps.storage ?? memoryStorage()
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = Math.max(MIN_POLL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_MS)

  let state: GatewayState = load()
  let ledger: JobLedger = loadLedger()
  let profiles: VideoProfile[] | null = null
  let ensuring: Promise<string> | null = null
  /** Serialises submits: uploads + canvas PUT + job POST of one take never interleave with another's. */
  let chain: Promise<unknown> = Promise.resolve()
  /** Submits in progress by key (a second submit / recover of the same key joins it). */
  const inflight = new Map<string, Promise<{ remoteId: string }>>()
  const lists = new Map<string, { at: number; jobs: CanvasJob[] }>()
  const misses = new Map<string, number>()

  function load(): GatewayState {
    try {
      const raw = storage.get(STATE_KEY)
      if (raw) {
        const p = JSON.parse(raw) as Partial<GatewayState>
        return { projectId: p.projectId ?? null, uploads: p.uploads ?? {}, entries: p.entries ?? {} }
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
  /** The key got its job: remember it (never posted again) and drop the "sent" record. */
  function settle(key: string, remoteId: string): { remoteId: string } {
    const { [key]: _done, ...sent } = ledger.sent
    saveLedger({ jobs: { ...ledger.jobs, [key]: { remoteId, at: now() } }, sent })
    return { remoteId }
  }
  function markSent(key: string, rec: SentRecord) {
    saveLedger({ ...ledger, sent: { ...ledger.sent, [key]: rec } })
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
        const id = existing?.project_id ?? (await api.createProject(BRIDGE_PROJECT_NAME))
        state = { ...state, projectId: id, entries: existing ? state.entries : {} }
        save()
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

  /** canvasapp refused the job: its uploads may be the reason (expired on the server) → upload them again next time. */
  function forgetUploads(req: JobRequest) {
    const uploads = { ...state.uploads }
    for (const id of imagesToUpload(req)) delete uploads[id]
    state = { ...state, uploads }
    save()
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
    lists.set(rec.projectId, { at: now(), jobs })
    const remote = (j: CanvasJob) => ({ remoteId: encodeRemoteId(rec.projectId, j.job_id) })
    if (jobs.some((j) => typeof j.client_request_id === 'string')) {
      const same = jobs.filter((j) => j.client_request_id === req.key)
      return same.length === 1 ? remote(same[0]) : same.length ? 'ambiguous' : 'none'
    }
    // The list does not carry client_request_id: the job is the ONE job on the scene's canvas node that is not
    // another take's (known ids), was not there before the POST and was created after it.
    const taken = new Set(Object.values(ledger.jobs).map((j) => decodeRemoteId(j.remoteId)?.jobId))
    const before = new Set(rec.before ?? [])
    const model = modelProfileOf(req.model)
    const candidates = jobs.filter((j) => {
      if (j.canvas_node_id !== rec.nodeId || taken.has(j.job_id) || before.has(j.job_id)) return false
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
  async function postJob(req: JobRequest, body: VideoJobBody, opts: SubmitOptions, afterLost = false): Promise<{ remoteId: string }> {
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
          return settle(req.key, encodeRemoteId(body.project_id, jobId))
        }
        // 2xx without a job id: canvasapp most likely created it → find it below
      } catch (e) {
        if (!reposted && !afterLost && !ambiguous(e)) {
          // canvasapp refused it (401, 402/400, 403, 404, 429…): nothing was created, nothing billed.
          clearSent(req.key)
          // Not enough credits (402) says nothing about the uploads: keep them for the next try.
          if (e instanceof CanvasappError && (e.code === 'bad-request' || e.code === 'not-found') && e.status !== 402) forgetUploads(req)
          throw e
        }
        // after a lost answer even a refusal of the second POST proves nothing (e.g. "duplicate request")
      }
      const found = await lookForJob(req, rec)
      if (typeof found === 'object') {
        lists.delete(body.project_id)
        return settle(req.key, found.remoteId)
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
    const problems = validateRequest(req, profiles)
    if (problems.length) throw new CanvasappError('unsupported', problems.join(' '))
    // This key was posted before without a known answer (an explicit retry of an "unknown" take): look first.
    const earlier = ledger.sent[req.key]
    if (earlier) {
      let found: Awaited<ReturnType<typeof findJob>>
      try {
        found = await findJob(req, earlier)
      } catch (e) {
        throw new CanvasappError('network', `${UNCERTAIN_SUBMIT_TEXT} (${canvasappErrorText(e)})`, { uncertain: true })
      }
      if (typeof found === 'object') return settle(req.key, found.remoteId)
      if (found === 'ambiguous') throw uncertainError()
    }
    let projectId = await ensureProject()
    checkCancelled()
    await uploadMissing(req, checkCancelled)
    const entry = entryFromRequest(req, uploadIdFor, now())
    const putCanvas = async () => {
      state = { ...state, entries: { ...state.entries, [req.sceneId]: entry } }
      save()
      await api.putCanvas(projectId, bridgeCanvas(Object.values(state.entries)))
    }
    try {
      await putCanvas()
    } catch (e) {
      // The remembered bridge project was deleted on canvasapp → create/find it again once.
      if (!(e instanceof CanvasappError && e.code === 'not-found')) throw e
      state = { ...state, projectId: null, entries: {} }
      save()
      projectId = await ensureProject()
      await putCanvas()
    }
    // Last chance to stop: the POST below is what canvasapp bills.
    checkCancelled()
    return postJob(req, toVideoJobBody(req, { projectId, uploadIdFor, generateAudio: deps.generateAudio?.() ?? true }), opts, !!earlier)
  }

  async function jobsOf(projectId: string): Promise<CanvasJob[]> {
    const hit = lists.get(projectId)
    // MIN_POLL_MS (not pollMs): the engine polls every pollMs, a cache as long as that would skip every other poll.
    if (hit && now() - hit.at < MIN_POLL_MS) return hit.jobs
    const jobs = await api.listVideoJobs(projectId)
    lists.set(projectId, { at: now(), jobs })
    return jobs
  }

  return {
    id: 'canvasapp',
    label: 'canvasapp.io.vn',

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
      const o = profiles?.find((p) => p.model_profile === model)?.options
      if (!o) return base
      return {
        ...base,
        modes: o.modes ? base.modes.filter((m) => o.modes!.includes(m) && !o.disabled_modes?.includes(m)) : base.modes,
        durations: o.durations?.map(Number).filter(Number.isFinite) ?? base.durations,
        resolutions: o.resolutions ?? base.resolutions,
        ratios: o.aspect_ratios ?? base.ratios,
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
        if (typeof found === 'object') return settle(req.key, found.remoteId)
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
            out.push(mapJobStatus(remoteId, job))
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
    reset: () => {
      state = { projectId: null, uploads: {}, entries: {} }
      storage.remove(STATE_KEY)
      lists.clear()
      misses.clear()
      profiles = null
    },

    refreshProfiles: async () => {
      profiles = await api.videoProfiles()
      return profiles
    },
    bridgeProjectId: () => state.projectId,
    uploadCacheSize: () => Object.keys(state.uploads).length,
  }
}
