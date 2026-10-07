// PURE (no I/O) — "Nhập job" (reverse sync): which jobs of the "SanoVids bridge" session were made on canvasapp's own
// page (the user pressed "Tạo video" on a bridge node) and may become takes of the open project, and what such a take
// records. Unit-tested in providers/__tests__/canvasapp-siteJobs.test.ts; the adapter (scanSiteJobs / siteJobPrompts /
// claimSiteJobs) feeds it, siteJobActions.ts drives it.
//
// Money rules (docs/GATEWAY-CANVASAPP.md §4 "Nhập job"):
//   - Importing is read-only toward canvasapp (GET only) and an imported take is never submitted: it is born
//     `processing` with its remoteId. Nothing here can bill anything.
//   - A job SanoVids made (ledger.jobs), one a take of the open project already tracks, and one an unanswered POST
//     (ledger.sent) may have made is never offered: that take must find it (the lost-answer lookup), never a new take.
//     `sentMayOwn` is the ONE rule, used by the scan and again, synchronously, by the claim.
//   - What canvasapp's job list does not say is never guessed as fact: a field is `unknown` (a placeholder, shown "?",
//     cost "—") or `inferred` from a bridge node whose prompt, model, duration and ratio match the job's (shown "≈").
// ---- API ----
//   classifySiteJobs(jobs, ctx)        → { listHasKeys, candidates, skipped } (candidates sorted by scene, then time)
//   sentMayOwn(job, key, rec, …)       could an unanswered POST of take `key` (ledger.sent) have made this job?
//   inPostWindow(createdAt, at)        the creation-time window of that rule (shared with the adapter's lookup;
//                                      createdSkewOf: ±14 h with a time zone, ±27 h without one; null = unknown time)
//   createdTime(v) / zonedTime(v)      a listed time in ms (ISO 8601 or a number in s / ms only, else unknown)
//   listedDuration(v)                  a listed duration, or null when it is not a number
//   hintsFor(nodeId, canvas, entries, imageOfUpload)   the node's settings as the bridge canvas / SanoVids' entry hold them
//   canvasHintFor / entryHint / hintMatches            the parts of hintsFor + the match rule
//   reconstructSiteJob(candidate, prompt, assetOf)     → SiteTakeDraft (settings + what is unknown / inferred)
//   normalizeImportPrompt(v)           GET …/prompt answer → the prompt, or null (empty, too long, not text = unknown)
import { costOf, MODELS, normalizeSettings } from '../../core/models'
import type { ImportedField, Mode, ModelId, VideoSettings } from '../../core/types'
import type { CanvasJob } from './api'
import { canvasNodeId, clientRequestIdFor, decodeRemoteId, encodeRemoteId, inputShapeOf, modelProfileOf, resolutionOf, type BridgeEntry } from './mapping'

/**
 * How far a created_at WITH a time zone ('Z', ±hh:mm, or a number) may be from this computer's clock when the job was
 * made: only that clock (or its time zone setting) can be wrong. Generous on purpose.
 */
export const CREATED_SKEW_MS = 14 * 3600_000
/**
 * ...and one WITHOUT a time zone (canvasapp's format is still VERIFY: a FastAPI / Python naive datetime prints like
 * "2026-10-07T12:00:00.123456"): Date.parse reads it in THIS computer's time zone, while canvasapp wrote it in its own
 * (UTC, or the server's local time). Off by the gap between two time zones — up to 26 h (UTC−12 … UTC+14), e.g. +17 h
 * for Vietnam time read in Hawaii — plus an hour for this computer's clock.
 */
export const NAIVE_CREATED_SKEW_MS = 27 * 3600_000
/** At most this many jobs per import (one GET …/prompt each, one after the other: gentle on canvasapp). */
export const MAX_IMPORT_BATCH = 20
/** How long after its POST a job may still appear (the reservation of an unanswered POST, past the skew). */
export const POST_WINDOW_MS = 10 * 60_000
/** A date-time string that says its time zone: ends with Z / GMT / UTC / ±hh[:mm] after a time of day. */
const ZONED_RE = /\d:\d{2}(?::\d{2}(?:[.,]\d+)?)?\s*(?:[zZ]|(?:GMT|UTC)?\s*[+-]\d{2}(?::?\d{2})?|GMT|UTC)$/
/** How far `created_at` (as canvasapp lists it) may be off: CREATED_SKEW_MS with a time zone, else NAIVE_CREATED_SKEW_MS. */
export function createdSkewOf(v: unknown): number {
  return typeof v === 'number' || (typeof v === 'string' && ZONED_RE.test(v.trim())) ? CREATED_SKEW_MS : NAIVE_CREATED_SKEW_MS
}
/**
 * Could a job whose created_at is `createdAt` be the job of a POST sent at `at` (local time)? Created within its skew
 * (createdSkewOf) before it, or within that skew + POST_WINDOW_MS after it; null = no usable creation time (each caller
 * decides). The ONE window of the lost-answer lookup (adapter findJob), its rival test and the import's reservation
 * (sentMayOwn): a job is either a POST's to find or importable, never both.
 */
export function inPostWindow(createdAt: unknown, at: number): boolean | null {
  const t = createdTime(createdAt)
  if (!Number.isFinite(t)) return null
  const skew = createdSkewOf(createdAt)
  return t >= at - skew && t <= at + skew + POST_WINDOW_MS
}
/** A finished job canvasapp does not let download (download_available false) this long: not offered any more. */
export const NO_DOWNLOAD_AFTER_MS = 60 * 60_000
/** A time canvasapp lists (created_at / finished_at) as a real instant: a number, or a string with its time zone. */
export function zonedTime(v: unknown): number | null {
  if (typeof v === 'string' && !ZONED_RE.test(v.trim())) return null
  const t = createdTime(v)
  return Number.isFinite(t) ? t : null
}
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/
/**
 * "HH:MM DD/MM" exactly as a time WITHOUT a time zone is written (canvasapp's own clock, whatever zone that is), null
 * for anything else. Such a time is never converted: Date.parse would read it in this computer's zone.
 */
export function wallText(v: unknown): string | null {
  if (typeof v !== 'string' || zonedTime(v) !== null) return null
  const m = WALL_RE.exec(v.trim())
  return m ? `${m[4]}:${m[5]} ${m[3]}/${m[2]}` : null
}
/**
 * A finished job canvasapp does not let download (download_available false): still offered? Its finished_at as a real
 * instant (zonedTime): while younger than NO_DOWNLOAD_AFTER_MS. Without a time zone it is read in this computer's zone
 * and may be off by up to NAIVE_CREATED_SKEW_MS: surely older than that hour → no; otherwise for NO_DOWNLOAD_AFTER_MS
 * from when this computer first saw it so (`firstSeen`, the adapter's memory). No finished_at → no.
 */
export function mayStillDownload(finishedAt: unknown, now: number, firstSeen: number | undefined): boolean {
  const zoned = zonedTime(finishedAt)
  if (zoned !== null) return now - zoned < NO_DOWNLOAD_AFTER_MS
  const t = createdTime(finishedAt)
  if (!Number.isFinite(t) || now - t >= NO_DOWNLOAD_AFTER_MS + NAIVE_CREATED_SKEW_MS) return false
  return firstSeen !== undefined && now - firstSeen < NO_DOWNLOAD_AFTER_MS
}
/** canvasapp's own prompt limit (20.000): a longer /prompt answer is not trusted (unknown). */
export const MAX_IMPORT_PROMPT = 20_000
/** Ids that go into request paths (electron/main.cjs CANVASAPP_ID, api.ts safeId). */
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/

/** Why a job of the bridge session is not offered. */
export type SiteJobSkip =
  | 'bad-id'
  | 'not-canvas'
  | 'in-project'
  | 'maybe-pending'
  | 'sanovids'
  | 'no-scene'
  | 'ended'
  | 'no-download'
  | 'unsupported-model'

/** An unanswered POST (the adapter's ledger.sent record). */
export interface SentLike {
  projectId: string
  nodeId: string
  at: number
  before?: string[]
  /** The jobs a read that surely showed its job, if any, listed (adapter SentRecord.covered): no later job is its own. */
  covered?: string[]
}

export interface SiteJobLedger {
  jobs: Readonly<Record<string, { remoteId: string }>>
  sent: Readonly<Record<string, SentLike>>
  imported: Readonly<Record<string, { remoteId: string }>>
}

export interface SiteJobContext {
  /** canvasapp's bridge project the jobs were listed for. */
  projectId: string
  /** canvas_node_id → scene of the open project (its node, and the old node older builds named by the scene id). */
  sceneByNode: ReadonlyMap<string, string>
  /** scene id → order (S01…), to sort the candidates. */
  sceneOrder: ReadonlyMap<string, number>
  /** Job ids that takes of the open project (this provider) already track. */
  takeJobIds: ReadonlySet<string>
  /** Every take id of the open project (their idempotency keys). */
  takeIds: ReadonlySet<string>
  ledger: SiteJobLedger
  now: number
  /** job id → when this computer first listed it finished but not downloadable (mayStillDownload). */
  firstSeen?: ReadonlyMap<string, number>
}

/** The bridge node as it was (likely) when the job was made: from the saved canvas or SanoVids' own entry. */
export interface SiteJobHint {
  source: 'canvas' | 'entry'
  model: ModelId
  mode: Mode
  duration: number
  /** lower-cased like canvasapp keeps it */
  resolution: string
  ratio: string | null
  prompt: string
  /** 'refs' shape: the media-store image id of each reference upload, in @image order (null = an upload SanoVids does not know). */
  refImages: (string | null)[]
  /** 'frames' shape: the frames' image ids (null = missing / unknown upload). */
  frames: { first: string | null; last: string | null } | null
}

export interface SiteJobCandidate {
  jobId: string
  /** encodeRemoteId(bridge project, job id) — what the take will poll. */
  remoteId: string
  nodeId: string
  sceneId: string
  /** The job as listed (claimSiteJobs checks it again against the ledger). */
  job: CanvasJob
  jobName: string | null
  state: 'queued' | 'processing' | 'completed'
  progress: number | null
  /** created_at as a real instant (zonedTime); null when canvasapp did not say, or wrote no time zone. */
  createdAt: number | null
  /** ...a created_at without a time zone as canvasapp wrote it ("14:32 06/10", its own clock — wallText). */
  createdWall: string | null
  model: ModelId
  duration: number | null
  ratio: string | null
  /** Imported before (a take since deleted, or in another project): offered unticked. */
  reimport: boolean
  /** Filled by the adapter (hintsFor) — canvas first, then SanoVids' entry. */
  hints: SiteJobHint[]
}

export interface SiteJobSkipped {
  jobId: string
  sceneId: string | null
  code: SiteJobSkip
  /** 'maybe-pending': the take whose unanswered POST may have made it. */
  pendingTakeId?: string
  /**
   * 'maybe-pending', matched by node and time (no client_request_id in the list) with a readable created_at: how many
   * hours around that POST a job is held for it (createdSkewOf: 14 with a time zone, 27 without). Absent = held
   * whenever it was made (its key in the list, or no creation time).
   */
  windowHours?: number
}

export interface SiteJobScan {
  /** canvasapp's bridge project; null = no "SanoVids bridge" session yet (nothing to import). */
  projectId: string | null
  /** The job list carries client_request_id (exact matching). */
  listHasKeys: boolean
  candidates: SiteJobCandidate[]
  skipped: SiteJobSkipped[]
}

/** What a take made from a candidate records. */
export interface SiteTakeDraft {
  jobId: string
  remoteId: string
  nodeId: string
  sceneId: string
  job: CanvasJob
  jobName: string | null
  /** A real instant only (SiteJobCandidate.createdAt): null → the take is stamped with the import time. */
  createdAt: number | null
  /** 1–99 (a finished job shows 99 until its video is downloaded). */
  progress: number
  reimport: boolean
  settings: VideoSettings
  unknown: ImportedField[]
  inferred: ImportedField[]
  /** '' when unknown. */
  prompt: string
  refs: string[]
  imageKeys: string[]
  frames: { first: string | null; last: string | null }
  /** 0 when resolution or duration is unknown (shown "—"). */
  cost: number
  /** Which node the inferred fields came from (null = none used). */
  hint: 'canvas' | 'entry' | null
}

/** One job to claim (adapter claimSiteJobs). */
export interface SiteJobClaim {
  /** The new take's id (its idempotency key). */
  key: string
  remoteId: string
  nodeId: string
  job: CanvasJob
  reimport: boolean
}

/** An ISO 8601 date and time of day ("2026-10-07T12:00:00Z", "2026-10-07 12:00:00.123456"): what FastAPI writes. */
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}/
/** A number below this is a Unix time in SECONDS (in milliseconds it would be before March 1973): read × 1000. */
const SECONDS_BELOW = 1e11
/**
 * created_at / finished_at as canvasapp lists them, in milliseconds (local reading of a time without a time zone) —
 * NaN when not surely readable: only an ISO 8601 date-time or a number (seconds or milliseconds) is read. Anything else
 * (a date alone, "07/10/2026 12:00", which Date.parse reads as July 10) is unknown: a misread time could put a POST's
 * own job outside its window (inPostWindow), and every caller treats an unknown time as "could be" instead.
 */
export function createdTime(v: unknown): number {
  if (typeof v === 'number') return !Number.isFinite(v) ? NaN : Math.abs(v) < SECONDS_BELOW ? v * 1000 : v
  if (typeof v !== 'string' || !ISO_TIME_RE.test(v.trim())) return NaN
  return Date.parse(v.trim())
}

/** A job's duration as the list writes it (a number, or a numeric string); null = unknown (missing, null, "8s"…). */
export function listedDuration(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const MODEL_IDS = Object.keys(MODELS) as ModelId[]
/** canvasapp model_profile → SanoVids model (null = a model SanoVids does not run). */
export const modelOfProfile = (profile: unknown): ModelId | null => MODEL_IDS.find((m) => modelProfileOf(m) === profile) ?? null
const jobIdsOf = (records: Readonly<Record<string, { remoteId: string }>>): Set<string> => {
  const out = new Set<string>()
  for (const r of Object.values(records)) {
    const id = typeof r?.remoteId === 'string' ? decodeRemoteId(r.remoteId)?.jobId : undefined
    if (id) out.add(id)
  }
  return out
}

/**
 * Could the unanswered POST of take `key` (ledger.sent record `rec`) have made `job`? With client_request_id in the
 * list: exactly when it carries that take's key. Without: a job on the node the POST named, not listed before it, not
 * made after a read that surely showed that POST's job (rec.covered: such a job is listed there, if it exists), created
 * within the window of it (inPostWindow) — an unknown creation time: it could.
 * Broader than the lookup itself (adapter findJob) on purpose inside the window: a job it could own is never imported.
 * The lookup uses the same window and also skips every imported job: a job claimed here is never that POST's.
 */
export function sentMayOwn(job: CanvasJob, key: string, rec: SentLike, projectId: string, listHasKeys: boolean): boolean {
  // (a job the list shows without its key, next to others with theirs — VERIFY — is judged by node and time like in a
  // list without keys: it could be that POST's)
  if (listHasKeys && typeof job.client_request_id === 'string') return job.client_request_id === clientRequestIdFor(key) || job.client_request_id === key
  if (rec.projectId !== projectId || job.canvas_node_id !== rec.nodeId || rec.before?.includes(job.job_id)) return false
  if (Array.isArray(rec.covered) && !rec.covered.includes(job.job_id)) return false
  return inPostWindow(job.created_at, rec.at) ?? true
}

/** The first unanswered POST that may own `job` (its take id), or null. */
export function pendingOwnerOf(job: CanvasJob, ledger: SiteJobLedger, projectId: string, listHasKeys: boolean): string | null {
  for (const [key, rec] of Object.entries(ledger.sent)) {
    if (key in ledger.jobs || !rec || typeof rec !== 'object') continue
    if (sentMayOwn(job, key, rec, projectId, listHasKeys)) return key
  }
  return null
}

const ENDED = new Set(['failed', 'cancelled', 'expired'])

/**
 * Sort the bridge session's jobs into the ones that may be imported into the open project and the ones that may not
 * (and why). Checks, in order: a job id unfit for a request path; not a canvas job (creation_mode); already a take of
 * the open project; SanoVids made it (ledger.jobs); an unanswered POST's (its key in the list; else node + time
 * window, sentMayOwn); its key is a take's / SanoVids' (lists with keys); its node is no scene of the open project; ended without a video; finished
 * but not downloadable for an hour; a model SanoVids does not run. The rest are candidates (`reimport` when claimed
 * before), sorted by scene order, then creation time.
 */
export function classifySiteJobs(jobs: readonly unknown[], ctx: SiteJobContext): Omit<SiteJobScan, 'projectId'> {
  const listHasKeys = jobs.some((j) => isObj(j) && typeof j.client_request_id === 'string')
  const made = jobIdsOf(ctx.ledger.jobs)
  const imported = jobIdsOf(ctx.ledger.imported)
  const ownKeys = new Set<string>()
  for (const k of [...Object.keys(ctx.ledger.jobs), ...ctx.takeIds]) {
    ownKeys.add(k)
    ownKeys.add(clientRequestIdFor(k))
  }
  const candidates: SiteJobCandidate[] = []
  const skipped: SiteJobSkipped[] = []
  const seen = new Set<string>()
  for (const raw of jobs) {
    const job = (isObj(raw) ? raw : {}) as CanvasJob
    const jobId = typeof job.job_id === 'string' ? job.job_id : ''
    const nodeId = typeof job.canvas_node_id === 'string' ? job.canvas_node_id : null
    const sceneId = nodeId ? (ctx.sceneByNode.get(nodeId) ?? null) : null
    const skip = (code: SiteJobSkip, pendingTakeId?: string, windowHours?: number) =>
      skipped.push({ jobId, sceneId, code, ...(pendingTakeId ? { pendingTakeId } : {}), ...(windowHours !== undefined ? { windowHours } : {}) })
    if (!JOB_ID_RE.test(jobId) || seen.has(jobId)) {
      skip('bad-id')
      continue
    }
    seen.add(jobId)
    // loadJobs(): the canvas page only shows jobs without creation_mode or with 'canvas'
    if (job.creation_mode !== undefined && job.creation_mode !== null && job.creation_mode !== 'canvas') skip('not-canvas')
    else if (ctx.takeJobIds.has(jobId)) skip('in-project')
    else if (made.has(jobId)) skip('sanovids')
    else {
      const pending = pendingOwnerOf(job, ctx.ledger, ctx.projectId, listHasKeys)
      const keyed = listHasKeys && typeof job.client_request_id === 'string'
      if (pending) skip('maybe-pending', pending, keyed || !Number.isFinite(createdTime(job.created_at)) ? undefined : Math.round(createdSkewOf(job.created_at) / 3600_000))
      else if (listHasKeys && typeof job.client_request_id === 'string' && ownKeys.has(job.client_request_id)) skip('sanovids')
      else if (!nodeId || !sceneId) skip('no-scene')
      else if (ENDED.has(String(job.status))) skip('ended')
      else if (job.status === 'completed' && job.download_available === false && !mayStillDownload(job.finished_at, ctx.now, ctx.firstSeen?.get(jobId))) skip('no-download')
      else {
        const model = modelOfProfile(job.model_profile)
        if (!model) skip('unsupported-model')
        else {
          const at = zonedTime(job.created_at)
          const p = typeof job.progress === 'number' && Number.isFinite(job.progress) ? job.progress : null
          candidates.push({
            jobId,
            remoteId: encodeRemoteId(ctx.projectId, jobId),
            nodeId,
            sceneId,
            job,
            jobName: typeof job.job_name === 'string' ? job.job_name.slice(0, 200) : null,
            state: job.status === 'completed' ? 'completed' : job.status === 'queued' ? 'queued' : 'processing',
            progress: p,
            createdAt: at,
            createdWall: at === null ? wallText(job.created_at) : null,
            model,
            duration: listedDuration(job.duration),
            ratio: typeof job.aspect_ratio === 'string' ? job.aspect_ratio : null,
            reimport: imported.has(jobId),
            hints: [],
          })
        }
      }
    }
  }
  const order = (c: SiteJobCandidate) => ctx.sceneOrder.get(c.sceneId) ?? Number.MAX_SAFE_INTEGER
  // by creation as the list writes it (one format for all its jobs: the order holds without a time zone too)
  const madeAt = (c: SiteJobCandidate) => {
    const t = createdTime(c.job.created_at)
    return Number.isFinite(t) ? t : Infinity
  }
  candidates.sort((a, b) => order(a) - order(b) || madeAt(a) - madeAt(b) || (a.jobId < b.jobId ? -1 : 1))
  return { listHasKeys, candidates, skipped }
}

// ---------------------------------------------------------------------------------------------
// Hints: the node the job was (likely) made from
// ---------------------------------------------------------------------------------------------

/**
 * The video node `nodeId` of a saved bridge canvas (GET /api/projects/{id}: `{ nodes, connections }` as canvasPayload()
 * writes it) as a hint, its pictures mapped to media-store image ids. Anything malformed → null (never throws).
 */
export function canvasHintFor(canvas: unknown, nodeId: string, imageOfUpload: (uploadId: string) => string | null): SiteJobHint | null {
  try {
    if (!isObj(canvas) || !Array.isArray(canvas.nodes)) return null
    const nodes = canvas.nodes.filter(isObj)
    const node = nodes.find((n) => n.id === nodeId && n.type === 'video')
    const d = node && isObj(node.data) ? node.data : null
    if (!d) return null
    const model = modelOfProfile(d.model_profile)
    if (!model) return null
    const spec = MODELS[model]
    if (typeof d.mode !== 'string' || !spec.modes.includes(d.mode as Mode)) return null
    if (typeof d.duration !== 'number' || typeof d.resolution !== 'string' || typeof d.prompt !== 'string') return null
    if (!(typeof d.aspect_ratio === 'string' || d.aspect_ratio === null)) return null
    const mode = d.mode as Mode
    const connections = Array.isArray(canvas.connections) ? canvas.connections.filter(isObj) : []
    const uploadOf = (from: unknown): string | null => {
      const n = nodes.find((x) => x.id === from && x.type === 'images')
      const ids = n && isObj(n.data) && Array.isArray(n.data.upload_ids) ? n.data.upload_ids : []
      return typeof ids[0] === 'string' ? ids[0] : null
    }
    const imageOf = (from: unknown) => {
      const up = uploadOf(from)
      return up ? imageOfUpload(up) : null
    }
    const into = connections.filter((c) => c.to === nodeId)
    const shape = inputShapeOf(model, mode)
    const refImages =
      shape === 'refs'
        ? into
            .filter((c) => c.target_handle === 'reference')
            .sort((a, b) => Number(a.order) - Number(b.order))
            .map((c) => imageOf(c.from))
        : []
    const frameOf = (handle: string) => {
      const c = into.find((x) => x.target_handle === handle)
      return c ? imageOf(c.from) : null
    }
    const frames = shape === 'frames' ? { first: frameOf('first_frame'), last: frameOf('last_frame') } : null
    return { source: 'canvas', model, mode, duration: d.duration, resolution: resolutionOf(d.resolution), ratio: d.aspect_ratio, prompt: d.prompt, refImages, frames }
  } catch {
    return null
  }
}

/** SanoVids' own record of what it last put on that node (adapter state.entries) as a hint. */
export function entryHint(e: BridgeEntry, imageOfUpload: (uploadId: string) => string | null): SiteJobHint {
  const shape = inputShapeOf(e.model, e.mode)
  const img = (u: string | null) => (u ? imageOfUpload(u) : null)
  return {
    source: 'entry',
    model: e.model,
    mode: e.mode,
    duration: e.duration,
    resolution: resolutionOf(e.resolution),
    ratio: shape === 'frames' ? e.ratio || null : e.ratio || '16:9',
    prompt: e.prompt,
    refImages: shape === 'refs' ? e.uploadIds.map((u) => imageOfUpload(u)) : [],
    frames: shape === 'frames' ? { first: img(e.firstFrameUploadId), last: img(e.lastFrameUploadId) } : null,
  }
}

/** The hints of node `nodeId`: the saved canvas first, then SanoVids' entry of that node (if any). */
export function hintsFor(
  nodeId: string,
  canvas: unknown,
  entries: Readonly<Record<string, BridgeEntry>>,
  imageOfUpload: (uploadId: string) => string | null,
): SiteJobHint[] {
  const out: SiteJobHint[] = []
  const c = canvasHintFor(canvas, nodeId, imageOfUpload)
  if (c) out.push(c)
  const key = Object.keys(entries).find((k) => canvasNodeId(k) === nodeId)
  if (key) {
    try {
      out.push(entryHint(entries[key], imageOfUpload))
    } catch {
      /* a malformed entry is no hint */
    }
  }
  return out
}

/**
 * A hint stands for the job only when everything the job DOES tell agrees: the prompt (/prompt, trimmed), the model,
 * the duration, the ratio (a job without one: only a transform node) — and mode / resolution when the list carries
 * them. Even then the node may have changed since in a way none of these show (e.g. only its resolution): what comes
 * from a hint is only ever "inferred".
 */
export function hintMatches(h: SiteJobHint, job: CanvasJob, prompt: string | null): boolean {
  if (prompt === null || h.prompt.trim() !== prompt.trim()) return false
  if (job.model_profile !== modelProfileOf(h.model)) return false
  if (job.duration !== undefined && job.duration !== null && Number(job.duration) !== h.duration) return false
  if (typeof job.mode === 'string' && job.mode !== h.mode) return false
  if (typeof job.resolution === 'string' && resolutionOf(job.resolution) !== h.resolution) return false
  const r = job.aspect_ratio
  if (typeof r === 'string') return h.ratio === r
  return r === undefined || h.mode === 'transform'
}

/** GET /api/video-jobs/{id}/prompt → the prompt, or null when it says nothing usable (empty, not text, too long). */
export function normalizeImportPrompt(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim() || v.length > MAX_IMPORT_PROMPT) return null
  return v
}

/**
 * The take a candidate becomes. Known: the model, and what the job list says (duration, ratio — mode / resolution
 * only if it carries them; Seedance has one mode). `prompt` from GET …/prompt (null = unknown). The first hint that
 * matches (hintMatches) gives the rest as `inferred`; anything else is `unknown` with a placeholder (normalizeSettings'
 * default). Pictures: `assetOf(imageId)` = the asset of the open project that holds the picture (null = none);
 * references are inferred only when every picture maps. Cost: costOf when resolution and duration are not unknown.
 */
export function reconstructSiteJob(c: SiteJobCandidate, prompt: string | null, assetOf: (imageId: string) => string | null): SiteTakeDraft {
  const job = c.job
  const spec = MODELS[c.model]
  const unknown = new Set<ImportedField>()
  const inferred = new Set<ImportedField>()
  const h = c.hints.find((x) => x.model === c.model && hintMatches(x, job, prompt)) ?? null
  const base = normalizeSettings({ model: c.model })
  if (prompt === null) unknown.add('prompt')

  let mode: Mode
  if (spec.modes.length === 1) mode = spec.modes[0]
  else if (typeof job.mode === 'string' && spec.modes.includes(job.mode as Mode)) mode = job.mode as Mode
  else if (h) {
    mode = h.mode
    inferred.add('mode')
  } else if (job.aspect_ratio === null && spec.modes.includes('transform')) {
    // only a transform job carries no aspect ratio (runVideoNode sends none for it)
    mode = 'transform'
    inferred.add('mode')
  } else {
    mode = base.mode
    unknown.add('mode')
  }

  let duration: number
  if (c.duration !== null && spec.durations.includes(c.duration)) duration = c.duration
  else if (h && spec.durations.includes(h.duration)) {
    duration = h.duration
    inferred.add('duration')
  } else {
    duration = base.duration
    unknown.add('duration')
  }

  let ratio: string
  if (c.ratio !== null && spec.ratios.includes(c.ratio)) ratio = c.ratio
  else if (h?.ratio && spec.ratios.includes(h.ratio)) {
    ratio = h.ratio
    inferred.add('ratio')
  } else {
    ratio = base.ratio
    unknown.add('ratio')
  }

  const listedResolution = typeof job.resolution === 'string' ? spec.resolutions.find((r) => resolutionOf(r) === resolutionOf(job.resolution as string)) : undefined
  const hintResolution = h ? spec.resolutions.find((r) => resolutionOf(r) === h.resolution) : undefined
  let resolution: string
  if (listedResolution) resolution = listedResolution
  else if (hintResolution) {
    resolution = hintResolution
    inferred.add('resolution')
  } else {
    resolution = base.resolution
    unknown.add('resolution')
  }

  let refs: string[] = []
  let imageKeys: string[] = []
  let frames = { first: null as string | null, last: null as string | null }
  const shape = inputShapeOf(c.model, mode)
  const keyOf = (imageId: string | null): string | null => {
    const asset = imageId ? assetOf(imageId) : null
    return asset && imageId ? `${asset}:${imageId}` : null
  }
  if (unknown.has('mode')) unknown.add('refs')
  else if (shape === 'none') {
    if (inferred.has('mode')) inferred.add('refs')
  } else if (!h) unknown.add('refs')
  else if (shape === 'refs') {
    const keys = h.refImages.map(keyOf)
    if (keys.every((k): k is string => k !== null)) {
      imageKeys = keys
      refs = [...new Set(keys.map((k) => k.slice(0, k.indexOf(':'))))]
      inferred.add('refs')
    } else unknown.add('refs')
  } else {
    const first = keyOf(h.frames?.first ?? null)
    const last = keyOf(h.frames?.last ?? null)
    if (first && last) {
      frames = { first, last }
      inferred.add('refs')
    } else unknown.add('refs')
  }

  const settings: VideoSettings = { model: c.model, mode, duration, resolution, ratio }
  const order = (s: Set<ImportedField>): ImportedField[] => (['mode', 'resolution', 'duration', 'ratio', 'prompt', 'refs'] as ImportedField[]).filter((f) => s.has(f))
  return {
    jobId: c.jobId,
    remoteId: c.remoteId,
    nodeId: c.nodeId,
    sceneId: c.sceneId,
    job,
    jobName: c.jobName,
    createdAt: c.createdAt,
    progress: c.state === 'completed' ? 99 : Math.max(1, Math.min(99, Math.round(c.progress ?? 1))),
    reimport: c.reimport,
    settings,
    unknown: order(unknown),
    inferred: order(inferred),
    prompt: prompt ?? '',
    refs,
    imageKeys,
    frames,
    cost: unknown.has('resolution') || unknown.has('duration') ? 0 : costOf(settings),
    hint: inferred.size ? (h?.source ?? null) : null,
  }
}
