// Video provider abstraction. The queue engine (store/runs.ts) only talks to providers through this interface:
//   submit(request) → remote id (stored on the take) → poll(remote ids) → fetchResult(remote id) → blobs.
// The mock provider (providers/mock.ts) is the default. The canvasapp.io.vn gateway (providers/canvasapp/) is an
// opt-in, desktop-only experiment. See docs/GATEWAY-CANVASAPP.md.
import type { Mode, ModelId, Take, TakeProvider } from '../core/types'

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

export interface SubmitOptions {
  /**
   * True once the take was cancelled / deleted in SanoVids. A paying provider checks it before every step and right
   * before the request that creates (and bills) the job; it then gives up with a ProviderError code 'cancelled'.
   */
  isCancelled?: () => boolean
}

export interface VideoProvider {
  id: ProviderId
  label: string
  available(): Promise<ProviderAvailability>
  capabilities(model: ModelId): ProviderCapabilities
  /**
   * Create the job (req.key = idempotency key). Errors: code 'cancelled' (see SubmitOptions, nothing was created);
   * `uncertain: true` (see isSubmitUncertain) when the job may exist at the provider although no id came back.
   */
  submit(req: JobRequest, opts?: SubmitOptions): Promise<{ remoteId: string }>
  /**
   * Find the job an earlier submit of `req.key` created (the page closed / reloaded before its id was saved)
   * WITHOUT ever creating one. Null = none known. Optional: without it such takes fail as "unknown".
   */
  recover?(req: JobRequest): Promise<{ remoteId: string } | null>
  /** Statuses for the given remote ids (ids the provider does not know may be omitted). */
  poll(remoteIds: string[]): Promise<RemoteStatus[]>
  fetchResult(remoteId: string): Promise<JobResult>
  /** Stop a job at the provider when possible. Optional: without it, cancel only stops tracking locally. */
  cancel?(remoteId: string): Promise<void> | void
  /** Forget in-memory state (new project loaded, logout…). */
  reset?(): void
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

/**
 * submit() failed in a way that leaves it UNKNOWN whether the provider created (and billed) the job — e.g. the
 * connection broke after the request was sent. Such a take must never be submitted again under a new key.
 */
export const isSubmitUncertain = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { uncertain?: unknown }).uncertain === true

/**
 * Provider fields of a take (provider, remoteId, charged, framesSnapshot, imageKeysSnapshot) now live on `Take`
 * itself (core/types.ts) and are defaulted by migrateTake.
 * @deprecated use `Take`.
 */
export type RunTake = Take

/** Provider that runs a take ('mock' for takes saved before providers existed). */
export const providerOf = (t: Pick<Take, 'provider'>): ProviderId => t.provider ?? 'mock'
