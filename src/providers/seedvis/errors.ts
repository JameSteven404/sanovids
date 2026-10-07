// The error the seedvis adapter throws, and the pure classification of one create attempt that every money decision of
// the adapter rests on (plan §7.3, §7.7, §14 M6 / M9 / M14). No user texts here: the adapter words errors through its
// injected words (wording.ts, track A-MAP).
//
// The engine reads errors by shape only (providers/types): code 'cancelled' / 'deferred' (nothing sent), `uncertain`
// (+ `unverifiable`), code 'login-required' (provider issue), result codes 'deferred' / 'too-large' / 'too-slow', and
// (contractExt) 'expired-link' + `definitive`.
import type { SeedvisBridgeFailure, SeedvisResponse } from './contract'
import { parseApiError, parseGeneration, type SeedvisApiErrorInfo, type SeedvisGeneration } from './api'
import { failureNotSent } from './transport'

export type SeedvisErrorCode =
  /** Given up before anything was sent (the take was cancelled / deleted). */
  | 'cancelled'
  /** Nothing sent; try again later (slots full, 429, 503 busy, offline…). */
  | 'deferred'
  /** The ledger record could not be stored: nothing posted. */
  | 'storage'
  /** No / bad / unreadable API key (also 401 / 403 on a poll). */
  | 'login-required'
  /** Not in the desktop app. */
  | 'unavailable'
  /** Not a seedvis route / mode (nothing sent). */
  | 'unsupported'
  /** seedvis refused the request; nothing was created. */
  | 'refused'
  /** The request never fully left this computer (upload broke, images could not be prepared…). */
  | 'not-sent'
  /** The outcome of a create is unknown (always with `uncertain`). */
  | 'uncertain'
  | 'network'
  | 'server'
  | 'bad-response'
  | 'bad-request'
  | 'not-ready'
  | 'no-output'
  | 'expired-link'
  | 'too-large'
  | 'too-slow'
  | 'aborted'

export interface SeedvisErrorOptions {
  status?: number
  /** Why, for Take.remoteDetail (the variant explanation of a fixed money text, §6.2). */
  detail?: string
  /** seedvis error.code (→ Take.remoteCode). */
  remoteCode?: string | null
  uncertain?: boolean
  unverifiable?: boolean
  retryAfterMs?: number | null
  /** Size of the request body (a deferred submit: the engine does not re-upload big bodies blind, §6.5). */
  bodyBytes?: number
  /** fetchResult: the link is provably gone (§6.8 rule 5). */
  definitive?: boolean
  field?: string | null
  requestId?: string | null
}

export class SeedvisError extends Error {
  readonly code: SeedvisErrorCode
  readonly status?: number
  readonly detail?: string
  readonly remoteCode?: string
  readonly uncertain?: boolean
  readonly unverifiable?: boolean
  readonly retryAfterMs?: number
  readonly bodyBytes?: number
  readonly definitive?: boolean
  readonly field?: string
  readonly requestId?: string
  constructor(code: SeedvisErrorCode, message: string, opts: SeedvisErrorOptions = {}) {
    super(message)
    this.name = 'SeedvisError'
    this.code = code
    if (opts.status !== undefined) this.status = opts.status
    if (opts.detail) this.detail = opts.detail
    if (opts.remoteCode) this.remoteCode = opts.remoteCode
    if (opts.uncertain) this.uncertain = true
    if (opts.uncertain && opts.unverifiable) this.unverifiable = true
    if (typeof opts.retryAfterMs === 'number' && opts.retryAfterMs > 0) this.retryAfterMs = opts.retryAfterMs
    if (typeof opts.bodyBytes === 'number') this.bodyBytes = opts.bodyBytes
    if (opts.definitive) this.definitive = true
    if (opts.field) this.field = opts.field
    if (opts.requestId) this.requestId = opts.requestId
  }
}

export const isSeedvisError = (e: unknown): e is SeedvisError => e instanceof SeedvisError

// ---- one create attempt → what it proves ----

/** 422 codes that mean "your slots / queue are full" (not a schema error). Plan R9: told apart by code / message. */
const SLOT_CODES: ReadonlySet<string> = new Set([
  'slots_full',
  'concurrency_limit',
  'concurrency_limit_reached',
  'queue_full',
  'queue_limit',
  'queue_limit_reached',
  'too_many_active_jobs',
  'too_many_jobs',
])
const SLOT_MESSAGE = /\b(slots?|concurren\w*|queue (?:is )?full|queue[_ ]limit|active jobs)\b/i
/** 503 codes that mean "busy, nothing done". */
const BUSY_CODES: ReadonlySet<string> = new Set(['server_busy', 'overloaded', 'busy', 'rate_limited', 'too_many_requests'])
/** Codes that refuse the model itself (maintenance / not on the plan): nothing created. */
const MODEL_CODES: ReadonlySet<string> = new Set(['model_not_found', 'model_maintenance', 'model_unavailable', 'model_disabled'])

export type CreateClass =
  /** seedvis created (or replayed) the job: 2xx with an id, not failed. */
  | { kind: 'created'; gen: SeedvisGeneration; replayed: boolean; info: SeedvisApiErrorInfo }
  /** 2xx with an id whose job already failed (e.g. insufficient credits after a 202): the job exists, it is final. */
  | { kind: 'failed-final'; gen: SeedvisGeneration; replayed: boolean; info: SeedvisApiErrorInfo }
  /** The body may have reached seedvis and no usable answer came back: the job may exist (and be billed). */
  | { kind: 'lost'; why: 'network' | 'no-id' | 'server-json' | 'server-other' | 'unexpected'; info: SeedvisApiErrorInfo | null; failure: SeedvisBridgeFailure | null }
  /** 409: seedvis has seen this key (another body, or still working on it). Never a new key. */
  | { kind: 'conflict'; info: SeedvisApiErrorInfo }
  /** A definitive refusal: nothing was created. `login`: the key is missing / wrong (401). */
  | { kind: 'refused'; info: SeedvisApiErrorInfo; login: boolean; model: boolean }
  /** Not processed, try later (429, 503 busy, 422 slots full, maintenance page, main's lanes / offline). */
  | { kind: 'busy'; info: SeedvisApiErrorInfo | null; failure: SeedvisBridgeFailure | null; retryAfterMs: number | null; slots: boolean }
  /** The body never fully left this computer: 'stall' (upload broke / too slow), 'deadline' (main aborted at mustFinishBy), 'local' (main refused it before sending). */
  | { kind: 'not-sent'; why: 'stall' | 'deadline' | 'local' | 'login'; failure: SeedvisBridgeFailure }

const NO_INFO = (status: number): SeedvisApiErrorInfo => ({ status, code: null, message: null, field: null, json: false, format: 'none', requestId: null, retryAfterMs: null })

/**
 * What one answer to POST /developer/generations proves. The adapter's priority rule (once any attempt may have
 * reached seedvis, only success or "uncertain") is applied on top of this, not here.
 */
export function classifyCreate(res: SeedvisResponse): CreateClass {
  if (!res.ok) {
    const failure = res
    if (failure.code === 'idempotency-conflict') return { kind: 'conflict', info: NO_INFO(0) }
    if (!failureNotSent(failure)) return { kind: 'lost', why: 'network', info: null, failure }
    if (failure.code === 'deadline') return { kind: 'not-sent', why: 'deadline', failure }
    if (failure.code === 'rate-limited' || failure.code === 'busy' || failure.code === 'offline') {
      return { kind: 'busy', info: null, failure, retryAfterMs: failure.retryAfterMs ?? null, slots: false }
    }
    if (failure.code === 'no-key' || failure.code === 'key-unreadable' || failure.code === 'bad-key') return { kind: 'not-sent', why: 'login', failure }
    if (failure.code === 'network' || failure.code === 'timeout' || failure.code === 'too-slow') return { kind: 'not-sent', why: 'stall', failure }
    return { kind: 'not-sent', why: 'local', failure }
  }
  const status = res.status
  const info = parseApiError(status, res.json, res.headers)
  const replayed = /^\s*true\s*$/i.test(res.headers['Idempotency-Replayed'] ?? '')
  if (status >= 200 && status < 300) {
    const gen = parseGeneration(res.json)
    // 2xx without a usable id: seedvis most likely created it (202 = created in the background) — it may exist.
    if (!gen?.id) return { kind: 'lost', why: 'no-id', info, failure: null }
    return gen.status === 'failed' ? { kind: 'failed-final', gen, replayed, info } : { kind: 'created', gen, replayed, info }
  }
  if (status === 409) return { kind: 'conflict', info }
  if (status === 401) return { kind: 'refused', info, login: true, model: false }
  if (status === 429) return { kind: 'busy', info, failure: null, retryAfterMs: info.retryAfterMs, slots: false }
  if (status >= 500) {
    if (info.json && info.code && MODEL_CODES.has(info.code)) return { kind: 'refused', info, login: false, model: true }
    if (status === 503 && info.json && info.code && BUSY_CODES.has(info.code)) return { kind: 'busy', info, failure: null, retryAfterMs: info.retryAfterMs, slots: false }
    // A JSON 5xx (generation_failed / server_error / timeout: "already retried once internally, retrying is safe") or
    // a non-JSON 5xx (a gateway page): the request reached seedvis' side — the job may exist.
    return { kind: 'lost', why: info.json ? 'server-json' : 'server-other', info, failure: null }
  }
  if (status === 422) {
    const slots = (!!info.code && SLOT_CODES.has(info.code)) || (!info.field && !!info.message && SLOT_MESSAGE.test(info.message) && info.code !== 'validation_error')
    if (slots) return { kind: 'busy', info, failure: null, retryAfterMs: info.retryAfterMs, slots: true }
    return { kind: 'refused', info, login: false, model: false }
  }
  if (status === 404) {
    if (info.json && info.code && MODEL_CODES.has(info.code)) return { kind: 'refused', info, login: false, model: true }
    // An HTML / empty 404 is a maintenance page in front of the API: nothing processed, try later.
    if (!info.json) return { kind: 'busy', info, failure: null, retryAfterMs: info.retryAfterMs, slots: false }
    return { kind: 'refused', info, login: false, model: false }
  }
  if (status >= 400) return { kind: 'refused', info, login: false, model: !!info.code && MODEL_CODES.has(info.code) }
  // 1xx / 3xx (main never follows redirects): nothing proves the job was not created.
  return { kind: 'lost', why: 'unexpected', info, failure: null }
}
