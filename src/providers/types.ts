// Video provider abstraction. The queue engine (store/runs.ts) only talks to providers through this interface:
//   submit(request) → remote id (stored on the take) → poll(remote ids) → fetchResult(remote id) → blobs.
// The mock provider (providers/mock.ts) is the default. The canvasapp.io.vn gateway (providers/canvasapp/) is an
// opt-in, desktop-only experiment. See docs/GATEWAY-CANVASAPP.md.
import type { Mode, ModelId, Take } from '../core/types'

export type ProviderId = 'mock' | 'canvasapp'

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

export interface VideoProvider {
  id: ProviderId
  label: string
  available(): Promise<ProviderAvailability>
  capabilities(model: ModelId): ProviderCapabilities
  submit(req: JobRequest): Promise<{ remoteId: string }>
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

/**
 * Optional fields the queue engine stores on a take (backward compatible: old takes have none of them).
 * TODO(lead): move these into `Take` in core/types.ts and default them in migrateTake.
 */
export interface TakeProviderFields {
  /** Provider that runs this take. Missing = 'mock' (takes created before providers existed). */
  provider?: ProviderId
  /** Job id at the provider once submitted — lets the engine resume polling after a reload. */
  remoteId?: string | null
  /** Cost was taken from the local (demo) credit counter → refunded on failure/cancel. Missing = true. */
  charged?: boolean
  /** H3 transform frames (asset ids) at enqueue time. Missing = read from the scene when submitting. */
  framesSnapshot?: { first: string | null; last: string | null }
}

export type RunTake = Take & TakeProviderFields

export const providerOf = (t: Take): ProviderId => (t as RunTake).provider ?? 'mock'
