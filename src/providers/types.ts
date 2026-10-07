// Video provider abstraction. The queue engine (store/runs.ts) only talks to providers through this interface:
//   submit(request) → remote id (stored on the take) → poll(remote ids) → fetchResult(remote id) → blobs.
// Providers: 'dev' (development mode, the default: the canvasapp gateway code talking to an in-app simulation of
// canvasapp.io.vn — providers/dev/, no network), 'canvasapp' (the real gateway, desktop only — providers/canvasapp/,
// docs/GATEWAY-CANVASAPP.md) and 'mock' (the old demo, providers/mock.ts: only for takes saved before dev mode).
import type { Mode, ModelId, Take, TakeProvider, VideoSettings } from '../core/types'

export type ProviderId = TakeProvider

export interface ProviderAvailability {
  ok: boolean
  /** Vietnamese, shown to the user when ok = false. */
  reason?: string
}

/** What a provider accepts for one model (used for validation and the settings UI). */
export interface ProviderCapabilities {
  model: ModelId
  modes: Mode[]
  durations: number[]
  resolutions: string[]
  ratios: string[]
  maxRefImages: number
  /** 0 = reference videos (@video_N) are not supported by this provider. */
  maxRefVideos: number
  promptLimit: (mode: Mode) => number
  /** Max jobs this provider should run at the same time. */
  maxConcurrency: number
  /** Minimum delay between two poll() calls (ms). 0 = poll every engine tick (local mock). */
  pollIntervalMs: number
}

// ---- What the gateway runs right now (canvasapp /api/video-profiles) — the inspector, the run check, Bảng phát triển ----

/** A video setting the gateway can refuse. */
export type LimitField = 'model' | 'mode' | 'duration' | 'resolution' | 'ratio'

export interface SettingsIssue {
  field: LimitField
  /** Vietnamese, the very text of the submit refusal (canvasapp mapping.profileIssues). */
  reason: string
}

/**
 * What SanoVids knows: 'none' = not read yet (logged out, never asked, the old demo) → no limits; 'server' = read from
 * the gateway; 'fallback' = could not be read → canvasapp's built-in profiles (a guess: MiniMax-H3 locked).
 */
export type LimitsSource = 'none' | 'server' | 'fallback'

/**
 * The gateway's refusals of video settings, from what it last said. Referentially stable while what it decides does
 * not change (a re-read with the same answer keeps the object), so it can key memos.
 */
export interface SettingsLimits {
  source: LimitsSource
  /**
   * A 'server' read young enough that a submit now decides with exactly it (no re-read first): its refusals are
   * certain. False for 'none', 'fallback' and an older read (a submit reads again before deciding).
   */
  firm: boolean
  /** Refusals of `s`, each tagged with its field, in the submit's order. [] for 'none'. Never throws. */
  issues(s: VideoSettings): SettingsIssue[]
}

export const NO_LIMITS: SettingsLimits = Object.freeze({ source: 'none' as const, firm: false, issues: () => [] })

/** How the last read of the gateway's settings went (Bảng phát triển, the inspector note, toasts). */
export interface LimitsInfo {
  source: LimitsSource
  /** Local time of the read the current knowledge comes from (null for 'none'). */
  at: number | null
  /** Until when a 'server' read stays firm (null otherwise). */
  firmUntil: number | null
  /** Last read attempt, whatever came of it ('kept' = failed, the earlier read stays). */
  lastAttempt: { at: number; result: 'read' | 'failed' | 'kept' | 'login' } | null
  /** A read is in flight. */
  reading: boolean
}

export const NO_LIMITS_INFO: LimitsInfo = Object.freeze({ source: 'none' as const, at: null, firmUntil: null, lastAttempt: null, reading: false })

/**
 * refreshLimits(): 'fresh' = nothing sent (read recently enough); 'read' = read now; 'failed' = could not be read
 * (canvasapp's fallbacks now apply); 'kept' = could not be read, the earlier read is still used; 'login' = the gateway
 * wants a login; 'unavailable' = the gateway cannot be reached from here (web build).
 */
export type RefreshLimitsResult = 'fresh' | 'read' | 'failed' | 'kept' | 'login' | 'unavailable'

/** How refreshLimits() reads. */
export interface RefreshLimitsOptions {
  /** "Đọc lại": read now whatever the TTL — at most one request every few seconds (a quick second click gets its answer). */
  force?: boolean
  /**
   * What decides the answer has just changed (a login; the simulated site's settings in development mode): read now
   * with a request sent after this call — no few-seconds limit, never a read already in flight. Implies `force`.
   */
  changed?: boolean
}

/** A reference image, in @image_N order. The provider loads the blob from the media store when it needs it. */
export interface JobImage {
  /** 1-based N in @image_N */
  n: number
  assetId: string
  /** Media-store key (IndexedDB) — also the cache key for uploads to a remote provider. */
  imageId: string
  blob?: Blob
}

/** A reference video (a completed take), in @video_N order. */
export interface JobVideo {
  /** 1-based N in @video_N */
  n: number
  takeId: string
  videoId: string | null
  posterId: string | null
}

/** H3 transform frame (primary image of the chosen asset). */
export interface JobFrame {
  assetId: string
  imageId: string
  blob?: Blob
}

/** Everything a provider needs to create one video. Built by the queue engine from the take snapshot. */
export interface JobRequest {
  /** Idempotency key: the take id. The same key must never create two paid jobs. */
  key: string
  takeId: string
  sceneId: string
  /**
   * SanoVids project of the take — never canvasapp's bridge project_id. With sceneId it names the take's video node on
   * the canvasapp bridge canvas (mapping.sceneNodeKey): projects sharing scene ids (Nhân bản dự án, a file imported
   * twice) never share a node.
   */
  sanovidsProjectId: string
  /** "S07" */
  sceneCode: string
  takeNumber: number
  title: string
  color: string
  model: ModelId
  mode: Mode
  duration: number
  resolution: string
  ratio: string
  /** Compiled prompt, sent as written (with @image_N / @video_N tokens). */
  prompt: string
  /** The scene prompt as typed (display only). */
  rawPrompt: string
  images: JobImage[]
  videos: JobVideo[]
  firstFrame: JobFrame | null
  lastFrame: JobFrame | null
  /** Local time the take started processing (the mock uses it for wall-clock progress). */
  startedAt: number
}

export type RemoteState = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

export interface RemoteStatus {
  remoteId: string
  state: RemoteState
  /** 0–100 when the provider reports it. */
  progress?: number
  /** Vietnamese error text when state = failed. */
  error?: string
}

export interface JobResult {
  /** The finished video. Null only for the mock when "record webm" is off (poster only). */
  video: Blob | null
  /** Poster frame. When missing, the engine extracts one from the video. */
  poster?: Blob | null
}

/** How much of a finished video has been downloaded (total null = the provider did not say). */
export interface ResultProgress {
  received: number
  total: number | null
}

export interface FetchResultOptions {
  /** Aborted when the take is cancelled / deleted or the project is switched: stop downloading (then it rejects). */
  signal?: AbortSignal
  /** Download progress (throttled by the provider). */
  onProgress?: (p: ResultProgress) => void
}

export interface SubmitOptions {
  /**
   * True once the take was cancelled / deleted in SanoVids. A paying provider checks it before every step and right
   * before the request that creates (and bills) the job; it then gives up with a ProviderError code 'cancelled'.
   */
  isCancelled?: () => boolean
  /**
   * An explicit retry of a take whose earlier submit ended "unknown" (Take.submitUnknown): its first request may have
   * been billed. A paying provider that has no record left to check it against (another computer, cleared storage)
   * never sends it again — it fails `uncertain` + `unverifiable` (isSubmitUnverifiable).
   */
  retryOfUnknown?: boolean
}

export interface VideoProvider {
  id: ProviderId
  label: string
  /**
   * Floor the queue engine applies to this provider's poll interval (ms). Omitted = the engine's floor for remote
   * providers (15 s, canvasapp's own site polls every 60 s). Only the in-app dev simulator declares less.
   */
  minPollIntervalMs?: number
  available(): Promise<ProviderAvailability>
  capabilities(model: ModelId): ProviderCapabilities
  /**
   * Create the job (req.key = idempotency key). Errors: code 'cancelled' (see SubmitOptions, nothing was created);
   * `uncertain: true` (see isSubmitUncertain) when the job may exist at the provider although no id came back;
   * also `unverifiable: true` (isSubmitUnverifiable) when an earlier request of that key can no longer be checked.
   */
  submit(req: JobRequest, opts?: SubmitOptions): Promise<{ remoteId: string }>
  /**
   * Find the job an earlier submit of `req.key` created (the page closed / reloaded before its id was saved)
   * WITHOUT ever creating one. Null = none known. Optional: without it such takes fail as "unknown".
   */
  recover?(req: JobRequest): Promise<{ remoteId: string } | null>
  /** Statuses for the given remote ids (ids the provider does not know may be omitted). */
  poll(remoteIds: string[]): Promise<RemoteStatus[]>
  /**
   * The finished video. Errors: code 'too-large' (see isResultTooLarge: never downloadable, do not try again);
   * 'too-slow' (see isResultTooSlow: a connection open past the gateway's time limit that could not continue — a new
   * try would start again from 0 and hit the same limit); 'deferred' (see isResultDeferred: nothing was fetched, too
   * many downloads at once — try later, not a failure).
   */
  fetchResult(remoteId: string, opts?: FetchResultOptions): Promise<JobResult>
  /** Stop a job at the provider when possible. Optional: without it, cancel only stops tracking locally. */
  cancel?(remoteId: string): Promise<void> | void
  /** Forget in-memory state (new project loaded, logout…). */
  reset?(): void
  /**
   * What the gateway refuses right now, from its last answer — synchronous, never a request, never throws. Optional:
   * without it (the old demo) nothing is limited.
   */
  settingsLimits?(): SettingsLimits
  /** How that knowledge was obtained (synchronous). */
  limitsInfo?(): LimitsInfo
  /**
   * Read it again when it is old (TTL-gated: nothing is sent while fresh, or within a minute of a failed attempt);
   * `force` reads now (at most every few seconds); `changed` after a login / a change of the site's settings (no
   * limit). Shares one request with a submit's own read. Never throws.
   */
  refreshLimits?(opts?: RefreshLimitsOptions): Promise<RefreshLimitsResult>
}

/** Error with a machine-readable code, thrown by providers. */
export class ProviderError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}

/** submit() gave up because the take was cancelled before the job was created (nothing was billed). */
export const isSubmitCancelled = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'cancelled'

/**
 * submit() sent nothing and asks to be tried again later (code 'deferred'; e.g. canvasapp's bridge canvas has no room
 * until a running job ends): the engine puts the take back in the queue and waits a poll interval before starting
 * another take of that provider. Nothing was billed.
 */
export const isSubmitDeferred = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'deferred'

/** fetchResult() refused a video bigger than SanoVids can take (1 GB): trying again gives the same answer. */
export const isResultTooLarge = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'too-large'

/**
 * fetchResult() stopped a download that stayed open past the gateway's time limit (60 min per connection) and could
 * not continue where it stopped (no Range): another try from 0 would hit the same limit — do not try again.
 */
export const isResultTooSlow = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'too-slow'

/** fetchResult() fetched nothing and asks to be tried later (too many downloads at once): not a failed download. */
export const isResultDeferred = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'deferred'

/**
 * submit() failed in a way that leaves it UNKNOWN whether the provider created (and billed) the job — e.g. the
 * connection broke after the request was sent. Such a take must never be submitted again under a new key.
 */
export const isSubmitUncertain = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { uncertain?: unknown }).uncertain === true

/**
 * An uncertain submit (isSubmitUncertain) of a key that was sent before, whose earlier request can no longer be
 * checked — e.g. the provider's job list no longer reaches back to it, or several jobs could be it. It may have been
 * billed, so the provider never sends that key again; only a NEW take (new key, the user's explicit choice) can run.
 */
export const isSubmitUnverifiable = (e: unknown): boolean => isSubmitUncertain(e) && (e as { unverifiable?: unknown }).unverifiable === true

/**
 * Provider fields of a take (provider, remoteId, charged, framesSnapshot, imageKeysSnapshot) now live on `Take`
 * itself (core/types.ts) and are defaulted by migrateTake.
 * @deprecated use `Take`.
 */
export type RunTake = Take

/** Provider that runs a take ('mock' = the old demo, for takes saved before providers existed). */
export const providerOf = (t: Pick<Take, 'provider'>): ProviderId => t.provider ?? 'mock'
