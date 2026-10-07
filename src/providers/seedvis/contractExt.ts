// Local extensions of the provider contract (src/providers/types.ts) that the seedvis adapter needs — plan §5.2.
// Track B1 folds these into providers/types.ts / core/types.ts (TakeProvider gains 'seedvis' | 'seedvis-dev', ModelId
// gains the seedvis route ids, VideoProvider gains the optional methods below). Until then the seedvis files take them
// from here, so no existing file has to change in wave A.
//
// TODO(B1): move CancelOutcome, RemoteStatusExt fields, SameKeyRetry, ProviderContractExt and isResultExpired into
// providers/types.ts; make SeedvisJobRequest = JobRequest and SeedvisCapabilities = ProviderCapabilities; delete this file.
import type { Mode, ModelId, TakeProvider } from '../../core/services'
import type { JobRequest, ProviderCapabilities, RemoteStatus } from '../types'

/** The two executors of the seedvis service (core/services SERVICES.seedvis.executors). */
export type SeedvisProviderId = Extract<TakeProvider, 'seedvis' | 'seedvis-dev'>

/**
 * What a cancel at the provider achieved (§6.3): 'refunded' = stopped and refunded; 'running' = the job runs on and is
 * charged (its video is still downloaded); 'finished' = it had already ended (poll it now); 'unknown' = no answer.
 */
export type CancelOutcome = 'refunded' | 'running' | 'finished' | 'unknown'

/** JobRequest with the catalogue's full model / mode unions (core/services) until B1 widens core/types. */
export type SeedvisJobRequest = Omit<JobRequest, 'model' | 'mode'> & { model: ModelId; mode: Mode }

/** ProviderCapabilities for a seedvis route (its `model` is a seedvis id). */
export type SeedvisCapabilities = Omit<ProviderCapabilities, 'model' | 'modes'> & { model: ModelId; modes: Mode[] }

/** RemoteStatus plus the fields of §5.2. */
export interface RemoteStatusExt extends RemoteStatus {
  /** Live note for the take (queue position, "seedvis chưa trả lời về job này…", held for another key…). */
  note?: string
  phase?: 'queued' | 'processing'
  /** The job was sent with another API key than the one saved now: not polled until that key is back (§6.9). */
  held?: { keyHint: string }
  /** Final seedvis error.code (→ Take.remoteCode): 'not_started', 'cancelled', 'not_found', 'insufficient_credits'… */
  code?: string
}

export type SameKeyRetryReason = 'ok' | 'disabled' | 'expired' | 'no-record' | 'body-changed'

/**
 * Whether a same-key re-send started now would reach seedvis while it still remembers the key (§7.3 gate, ledger only).
 * `safeUntil` already includes the upload estimate: "now < safeUntil" = a re-send started now arrives in time.
 * POSITIVE_INFINITY when the key already has a known job (a submit returns it without any request).
 */
export interface SameKeyRetry {
  safeUntil: number | null
  reason: SameKeyRetryReason
}

/** Optional VideoProvider members added by §5.2 (all ledger / memory only unless stated). */
export interface ProviderContractExt {
  /** Stop a job at the provider and say what came of it (canvasapp keeps returning void). */
  cancel?(remoteId: string): Promise<CancelOutcome | void> | void
  /** Jobs this provider should run at once (replaces capabilities(...).maxConcurrency in the engine). */
  concurrency?(): number
  /** Pause after the n-th consecutive 'deferred' submit (§6.5); `retryAfterMs` from the last refusal when known. */
  deferDelayMs?(consecutiveDeferrals: number, retryAfterMs?: number | null): number
  /** Ledger facts for "Sao chép thông tin lỗi": never the API key, never a URL. Stable English keys. */
  diagnostics?(takeId: string): Record<string, string>
  sameKeyRetry?(takeId: string): SameKeyRetry
}

/**
 * fetchResult() proved the video can no longer be downloaded (a fresh GET of the job, then the CDN refused the fresh
 * link 401/403/404/410): the take ends, `fetchable` is dropped (§6.8 rule 5). Any other download error may pass.
 */
export const isResultExpired = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'expired-link' && (e as { definitive?: unknown }).definitive === true
