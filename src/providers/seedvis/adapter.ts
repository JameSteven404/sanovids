// VideoProvider for seedvis.com (plan §7). Desktop only ('seedvis'), or over the simulated bridge in development mode
// ('seedvis-dev', same code). Money rules: plan §14 (M1–M30); this file implements M1 M3–M10 M13–M15 M19 M22 M23
// M27–M29 on the adapter side.
//
// submit:  one Idempotency-Key per take for life (M1: uuidFromKey('sanovids:seedvis:' + take id)).
//   0. ledger.jobs[key] → that job, no request (M4).
//   1. a seedvis route and mode, else refused (nothing sent).
//   2. a key with a `sent` record (an earlier POST may have reached seedvis) goes again ONLY through the arrival gate
//      (window.ts, M5) — decided before anything else (before the bridge check too: once something may have reached
//      seedvis, a missing bridge is `uncertain`, never a plain 'unavailable'); no record but `retryOfUnknown`, or a
//      `dropped` key → `uncertain` + `unverifiable` (M8: no evidence ≠ never sent).
//      Every same-key POST also needs the API key saved NOW to be the one that sent the first POST (same key tag, both
//      known): seedvis replays a key only for the account that holds it, so under another key it would create (and
//      bill) a second job. Read again right before each POST; the sending key's tag unknown → never re-sent
//      (`unverifiable`); another / no / unreadable key now → `uncertain` while the gate is open.
//   3. prepare the exact bytes (injected; failures → "chưa gửi gì"); a re-send must hash to the same body (M7).
//   4. the key status read again → markSent (with that key's tag; read back; not stored → nothing posted, M3) →
//      isCancelled() → POST.
//   5. 2xx (200 or 202 queued, M14) with data.id → jobs[key]. A 2xx whose job already failed is recorded final (the
//      poll reports it). Echo check warn-only (M19). The take gone meanwhile (`isGone`, not just cancelled) → the job
//      is recorded as an orphan for the engine to cancel (§6.4 b).
//   6. Lost answer (sent:true and no usable answer, non-JSON 5xx, network after sending, 2xx without id) or a JSON
//      5xx (retry-safe with the same key) → automatic same-key re-sends at +15 / +45 / +90 s, each only while the gate
//      allows, each after main says the network is up; main aborts any re-send not uploaded by `mustFinishBy`.
//      Gate closed → `uncertain` + `unverifiable` (detail says why; a 2xx without a usable id keeps its own detail:
//      seedvis created it); schedule over with the gate still open → `uncertain` (the engine may dispatch the same key
//      at once, §6.7, sameKeyRetry()).
//   7. Priority rule (M6): once any attempt may have reached seedvis, the submit ends only in success or `uncertain`
//      — never 'deferred' / 'cancelled' / a plain refusal. Cancel during the re-sends → `uncertain` at once.
//   8. Only when nothing may have reached seedvis: 429 / 503 busy / 422 slots full / a maintenance page / main's lanes
//      → 'deferred' (+ retryAfterMs, bodyBytes); a body not fully uploaded → plain "chưa gửi gì"; any refusal →
//      plain error with remoteCode (401 → 'login-required').
//   9. 409 → `uncertain`, never a new key (M9).
// recover: ledger only, never a request (M4).
// poll:    per job pacing (next.after_seconds, ≥ minPollMs), ≤ 2 GETs at once; HTTP 202 = 200 (M14); a final status is
//          remembered and never asked again (a final answer with a status SanoVids does not know is not: the take keeps
//          running, logged); a 404 keeps the take running with back-off and ends it only on JSON not-found ≥ 3 times
//          over ≥ 30 min with the job's own key (M22); a job of another key is held, never polled and never failed
//          (M23); 401 or a bad / missing key → 'login-required' thrown (the engine pauses, keeps the takes); a 403 on
//          some jobs only keeps those running with a note (all due jobs 401 / 403 → thrown).
// fetch:   a job of another key → 'deferred' + `held` (no request, not a try, M23). GET the job (main records its
//          outputs), then the chunked download by (generationId, index) — the renderer never names a URL. Offline, or a
//          network failure with nothing received → 'deferred' (not a try, M27); expired link → GET again for a fresh
//          one, then 'expired-link' — definitive only for a job that completed ≥ 24 h ago (a CDN miss right after
//          completion is a plain, retried failure); empty outputs → one more round, then an error.
// cancel:  → CancelOutcome (§7.5): 'refunded' only on evidence (failed + cancelled, or a refunded outcome); a 2xx that
//          proves nothing → the job is read and decides. concurrency(): min(10, concurrency_limit) from /account/info,
//          unknown → 2 (M15).
//
// Texts come from the injected `words` (wording.ts, track A-MAP); the request body and prepared images from the
// injected `prepare` (mapping.ts + prepareImages.ts). TODO(integration): index.ts wires both (and the A-SIM bridge for
// 'seedvis-dev'); the engine wiring (§6) is track B2.
import { SEEDVIS_ROUTE_TABLE, SEEDVIS_IPC_LIMITS, SEEDVIS_KEY_MEMORY_MS, SEEDVIS_RESEND_SCHEDULE_MS, SEEDVIS_SAME_KEY_MARGIN_MS } from './contract'
import type { SeedvisAccountInfo, SeedvisBridge, SeedvisBridgeFailure, SeedvisGenerationBody, SeedvisKeyStatus, SeedvisRequestImage } from './contract'
import type { SeedvisModelId } from '../../core/services'
import { uuidFromKey } from '../../lib/uuidKey'
import {
  NO_LIMITS,
  type FetchResultOptions,
  type JobResult,
  type LimitsInfo,
  type ProviderAvailability,
  type RefreshLimitsOptions,
  type RefreshLimitsResult,
  type SettingsIssue,
  type SettingsLimits,
} from '../types'
import type { VideoSettings } from '../../core/types'
import {
  createSeedvisApi,
  idShape,
  isJsonJobNotFound,
  parseAccountInfo,
  parseApiError,
  parseGeneration,
  SEEDVIS_ID_RE,
  type SeedvisApi,
  type SeedvisApiErrorInfo,
  type SeedvisGeneration,
} from './api'
import type {
  CancelOutcome,
  ProviderContractExt,
  RemoteStatusExt,
  SameKeyRetry,
  SeedvisCapabilities,
  SeedvisJobRequest,
  SeedvisProviderId,
  SeedvisSubmitOptions,
} from './contractExt'
import { classifyCreate, SeedvisError, type CreateClass } from './errors'
import {
  createSeedvisLedger,
  SEEDVIS_DEV_LEDGER_KEY,
  SEEDVIS_LEDGER_KEY,
  type KeyValueStorage,
  type LedgerJob,
  type LedgerPrep,
  type LedgerSent,
  type SeedvisLedger,
} from './ledger'
import {
  deferDelayMs as backoffMs,
  KEY_MEMORY_FROM,
  nextStreak,
  notFoundDelayMs,
  notFoundEnds,
  sameKeyGate,
  type GateVerdict,
  type KeyMemoryFrom,
} from './window'

/** Floor between two polls of one job (seedvis' own pacing may ask for more). */
export const MIN_POLL_MS = 15_000
/** GETs of jobs in flight at once during one poll. */
export const POLL_PARALLEL = 2
/** /account/info (concurrency_limit) is read again after this long. */
export const ACCOUNT_TTL_MS = 10 * 60_000
/** …and not before this long after a failed read. */
export const ACCOUNT_RETRY_MS = 60_000
/** Jobs at once when the plan's concurrency_limit is unknown. */
export const DEFAULT_CONCURRENCY = 2
export const MAX_CONCURRENCY = 10
/** After a 422 "slots full": the cap stays lowered this long. */
export const SLOTS_FULL_HOLD_MS = 10 * 60_000
/** /models: TTL, retry after a failed read, minimum between two forced reads. */
export const MODELS_TTL_MS = 10 * 60_000
export const MODELS_RETRY_MS = 60_000
export const MODELS_FORCE_MIN_MS = 5_000
/** While waiting for the network before a re-send: ask main this often. */
export const ONLINE_CHECK_MS = 2_000
/** Cancel: retries of a 503 cancel_unavailable, and the longest 409 Retry-After waited for once. */
export const CANCEL_UNAVAILABLE_RETRIES = 3
export const CANCEL_CONFLICT_WAIT_MAX_MS = 10_000
/** Prepared bytes / pins older than this are swept on start (§9). */
export const PREP_SWEEP_MS = 60 * 60_000
/**
 * An expired link (after a fresh GET) ends a take for good only when its job completed at least this long ago: a CDN
 * 403 / 404 right after `completed` (object not replicated yet, a signing / clock glitch) is a retried failure, never
 * "the video is gone" — seedvis keeps results for days.
 */
export const EXPIRED_LINK_MIN_AGE_MS = 24 * 3_600_000
/** A job answering 403 while the others answer: asked again after this long (it keeps running, with a note). */
export const FORBIDDEN_RETRY_MS = 5 * 60_000
/** cancellation.outcome values that prove the job was stopped and refunded ('partial' never does). */
const REFUNDED_OUTCOMES: ReadonlySet<string> = new Set(['refunded', 'cancelled', 'canceled'])
/** A Retry-After from a deferred submit still counts for deferDelayMs() this long. */
const RETRY_AFTER_MEMORY_MS = 5 * 60_000
/** Time-based progress: a seedvis job is assumed to take about this long once processing. */
const EXPECTED_PROCESSING_MS = 120_000

/** The Idempotency-Key of a take, for life (M1). Two takes never share one. */
export const seedvisIdempotencyKey = (takeId: string): string => uuidFromKey(`sanovids:seedvis:${takeId}`)

/** Every user string the adapter produces. Filled from wording.ts (real / simulated variants) at integration. */
export interface SeedvisAdapterWords {
  webUnavailable: string
  noKey: string
  keyUnreadable: string
  /** 401 on a submit, or main's bad-key: the saved key is wrong / revoked. */
  badKey: string
  wrongRoute(model: string, mode: string): string
  ledgerNotSaved: string
  cancelledBeforeSend: string
  /** The images / body could not be prepared: nothing sent. */
  prepareFailed(why: string): string
  /** The body never fully left this computer (sent:false). */
  notSentUpload: string
  /** Main refused the request before sending it (its fixed text). */
  notSentLocal(mainMessage: string): string
  /** Deferred: slots full / busy (nothing sent, not billed). */
  deferredBusy: string
  /** The fixed "maybe billed" texts (the engine shows its own per-provider copy; these are the error messages). */
  unknownSubmit: string
  unverifiableSubmit: string
  /** A definitive seedvis refusal of a create (§7.7 rows "No"): text + optional detail. */
  refused(e: SeedvisApiErrorInfo, ctx: { model: string; mode: string }): { text: string; detail?: string }
  /** Take.remoteDetail variants of the fixed money texts (§6.2). */
  detail: {
    lostAnswer: string
    resending: string
    gateDisabled: string
    gateExpired: string
    clockChanged: string
    deadline: string
    bodyChanged: string
    noRecord: string
    conflict: string
    serverAfterSend(status: number): string
    refusedAfterSend(status: number, code: string | null): string
    cancelledWhileResending: string
    ledgerNotSavedResend: string
    prepareFailedResend(why: string): string
    /** The API key saved now is not the one that sent the first POST (another key, or none): no same-key re-send. */
    keyChanged: string
    /** The key that sent the first POST (or the one saved now) cannot be identified: no same-key re-send. */
    keyUnknown: string
    /** seedvis answered 2xx without a usable job id: it created the job — check its history, do not create again. */
    createdNoId: string
  }
  poll: {
    queued(position: number | null, seconds: number | null): string
    notFoundWaiting: string
    notFoundFinal(id8: string): string
    held(keyHint: string): string
    failed(code: string | null, message: string | null): string
    notStarted: string
    cancelledRefunded: string
    badRemoteId: string
    echoShort(received: number, sent: number): string
    /** A final answer with a status SanoVids does not know (sanitized code): the take keeps running. */
    unknownFinal(status: string): string
    /** 403 on this job while other jobs answer (another account's job?): kept running. */
    forbidden: string
  }
  fetch: {
    noOutput: string
    /** The definitive expiry (§6.8 rule 5): the take ends, "Tải lại video" goes. */
    expired: string
    /** The CDN refused the link but it cannot have expired yet (job completed recently): retried, still recoverable. */
    linkRefused: string
    offline: string
    tooLarge: string
    failed(why: string): string
    aborted: string
    notReady: string
  }
}

/** The exact request of one take: built once, re-sent byte for byte. */
export interface SeedvisPrepared {
  body: SeedvisGenerationBody
  images: SeedvisRequestImage[]
  /** Media-store ids of converted / downscaled copies made for this take (released when no re-send is possible). */
  prepIds?: string[]
  /** Original media-store ids sent unchanged (pinned while a re-send is possible). */
  pinIds?: string[]
  /** Note for the take ("Đã thu nhỏ 2 ảnh…"). */
  note?: string | null
}

export interface SeedvisPrepareInput {
  /** The Idempotency-Key. */
  key: string
  /** Prepared copies kept from an earlier submit of this key (a re-send must reuse them byte for byte). */
  prep: LedgerPrep | null
}

export interface SeedvisAdapterDeps {
  id?: SeedvisProviderId
  label?: string
  /** The bridge (or a getter: the desktop bridge may appear later). null = web build. */
  bridge: SeedvisBridge | null | (() => SeedvisBridge | null)
  words: SeedvisAdapterWords
  /** Body + exact image bytes of a request (mapping.toGenerationBody + prepareImages). Throws when it cannot. */
  prepare: (req: SeedvisJobRequest, input: SeedvisPrepareInput) => Promise<SeedvisPrepared>
  /** Prepared copies no longer needed (media-store delete). */
  releasePrep?: (ids: readonly string[]) => void
  /** Echo check (§7.6): images seedvis says it received vs sent; null = no opinion. Warn-only. */
  echo?: (prepared: SeedvisPrepared, references: SeedvisGeneration['references']) => { received: number; sent: number } | null
  /** /models → the refusals of a setting (mapping.limitsFromModels); null = unusable answer. */
  limitsFromModels?: (json: unknown) => ((s: VideoSettings) => SettingsIssue[]) | null
  /** The saved key's status (store/seedvisKey); default: the bridge's keyStatus(). */
  keyStatus?: () => SeedvisKeyStatus | null | Promise<SeedvisKeyStatus | null>
  /**
   * Where the money ledger lives (M3 / M4 / M8: it must survive a restart). Required: the integration passes
   * browserStorage (localStorage); a memory storage only when explicitly wanted (tests, stress sandbox).
   */
  storage: KeyValueStorage
  /** Default by id: bdp:seedvis:ledger / bdp:dev:seedvis:ledger. */
  ledgerKey?: string
  now?: () => number
  /**
   * A monotonic clock (ms, any origin; default performance.now()): elapsed time since a key's first POST in this
   * session is measured on it too, so a backward step of the wall clock cannot stretch the gate. null = wall clock only.
   */
  monotonic?: (() => number) | null
  sleep?: (ms: number) => Promise<void>
  /** Key memory the gate uses (default SEEDVIS_KEY_MEMORY_MS = null: no same-key POST at all). */
  keyMemoryMs?: number | null
  /** From when that memory counts (default KEY_MEMORY_FROM = 'request'; 'last-byte' only once seedvis confirms it). */
  keyMemoryFrom?: KeyMemoryFrom
  marginMs?: number
  resendScheduleMs?: readonly number[]
  /** Poll floor per job (default MIN_POLL_MS); declared to the engine only when given. */
  minPollMs?: number
  /** A live note for a take while its submit runs (re-sending…); null clears it. */
  onSubmitNote?: (takeId: string, note: string | null) => void
  /** One-line diagnostics log (never a secret, never a URL). */
  log?: (line: string) => void
  /** concurrency() reads /account/info by itself when stale (default true). */
  autoAccount?: boolean
}

export interface SeedvisProvider extends Required<Pick<ProviderContractExt, 'concurrency' | 'deferDelayMs' | 'diagnostics' | 'sameKeyRetry'>> {
  id: SeedvisProviderId
  label: string
  minPollIntervalMs?: number
  available(): Promise<ProviderAvailability>
  capabilities(model: string): SeedvisCapabilities
  submit(req: SeedvisJobRequest, opts?: SeedvisSubmitOptions): Promise<{ remoteId: string }>
  recover(req: SeedvisJobRequest): Promise<{ remoteId: string } | null>
  poll(remoteIds: string[]): Promise<RemoteStatusExt[]>
  fetchResult(remoteId: string, opts?: FetchResultOptions): Promise<JobResult>
  cancel(remoteId: string): Promise<CancelOutcome>
  reset(): void
  settingsLimits(): SettingsLimits
  limitsInfo(): LimitsInfo
  refreshLimits(opts?: RefreshLimitsOptions): Promise<RefreshLimitsResult>
  // ---- seedvis only ----
  /** Jobs without a final status, all projects (the Xoá / replace key warning, §6.4 e). */
  openJobs(): { remoteId: string; keyHint: string | null; at: number }[]
  orphans(): { key: string; remoteId: string; at: number; outcome: CancelOutcome | null }[]
  /** Media-store ids pinned while a same-key re-send is possible (a library delete keeps their blobs, §9). */
  pinnedImageIds(): string[]
  /** The take ended (or was deleted): its prepared copies and pins go. */
  releaseTake(takeId: string): void
  /** Drop prepared copies / pins that can no longer be re-sent or are older than an hour (run on start). */
  sweepPrep(): void
  /** Read /account/info now (concurrency_limit); null when it cannot be read. */
  refreshAccount(): Promise<SeedvisAccountInfo | null>
  /** An /account/info answer read elsewhere (the wallet): feeds concurrency(). */
  noteAccountInfo(info: SeedvisAccountInfo): void
  /** When one of SanoVids' own seedvis jobs last reached a final status (a slot freed, §6.5); null = not this run. */
  jobEndedAt(): number | null
  /** When a submit was last accepted (the engine resets its deferral count, §6.5). */
  lastAcceptedAt(): number | null
}

// ---- body signature (M2 / M7: a re-send must be byte-identical) ----

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** 64-bit FNV-1a style hash in two 32-bit lanes (fallback when SubtleCrypto is missing). */
function fnv64(bytes: Uint8Array): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x9e3779b9
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193)
    b = Math.imul(b ^ bytes[i], 0x5bd1e995)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

async function digest(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    try {
      const d = new Uint8Array(await subtle.digest('SHA-256', bytes as unknown as BufferSource))
      return `s${Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('')}`
    } catch {
      /* fall back */
    }
  }
  return `f${fnv64(bytes)}`
}

const encoder = new TextEncoder()

/** Hash of the exact body + image bytes, and the size of the request on the wire (JSON + base64 + names). */
export async function bodySignature(p: Pick<SeedvisPrepared, 'body' | 'images'>): Promise<{ hash: string; bytes: number }> {
  const head = encoder.encode(stableJson(p.body))
  const parts = [await digest(head)]
  let bytes = head.length
  for (const img of p.images) {
    parts.push(`${img.field}|${img.index}|${img.mime}|${img.bytes.length}|${await digest(img.bytes)}`)
    bytes += 4 * Math.ceil(img.bytes.length / 3) + 64
  }
  return { hash: await digest(encoder.encode(parts.join('\n'))), bytes }
}

// ---- the provider ----

type PlanEntry = { prepared: SeedvisPrepared; sig: { hash: string; bytes: number } }

export function createSeedvisProvider(deps: SeedvisAdapterDeps): SeedvisProvider {
  const id: SeedvisProviderId = deps.id ?? 'seedvis'
  const words = deps.words
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const memoryMs = deps.keyMemoryMs === undefined ? SEEDVIS_KEY_MEMORY_MS : deps.keyMemoryMs
  const memoryFrom: KeyMemoryFrom = deps.keyMemoryFrom ?? KEY_MEMORY_FROM
  const marginMs = deps.marginMs ?? SEEDVIS_SAME_KEY_MARGIN_MS
  const schedule = deps.resendScheduleMs ?? SEEDVIS_RESEND_SCHEDULE_MS
  const minPollMs = Math.max(0, deps.minPollMs ?? MIN_POLL_MS)
  const monotonic: (() => number) | null =
    deps.monotonic === undefined ? (typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : null) : deps.monotonic
  const getBridge = () => (typeof deps.bridge === 'function' ? deps.bridge() : deps.bridge)
  const apiOf = (): SeedvisApi => createSeedvisApi(getBridge())
  if (!deps.storage) throw new Error('seedvis adapter: a ledger storage is required')
  const ledger: SeedvisLedger = createSeedvisLedger({
    storage: deps.storage,
    storageKey: deps.ledgerKey ?? (id === 'seedvis-dev' ? SEEDVIS_DEV_LEDGER_KEY : SEEDVIS_LEDGER_KEY),
    now,
  })
  const log = (line: string) => {
    try {
      deps.log?.(`[seedvis${id === 'seedvis-dev' ? '-dev' : ''}] ${line}`)
    } catch {
      /* logging never breaks the adapter */
    }
  }
  const note = (takeId: string, text: string | null) => {
    try {
      deps.onSubmitNote?.(takeId, text)
    } catch {
      /* the UI signal never breaks a submit */
    }
  }

  /** Submits in progress by take id (a second submit / recover of the same take joins it). */
  const inflight = new Map<string, Promise<{ remoteId: string }>>()
  /** Exact prepared requests kept in memory while their key may still be re-sent (same session). */
  const plans = new Map<string, PlanEntry>()
  /** Poll pacing per remote id: when it may be asked again, and the last status given. */
  const pace = new Map<string, { nextAt: number; last: RemoteStatusExt }>()
  /** 404 streaks of jobs the ledger does not know (another computer…): memory only. */
  const strayMiss = new Map<string, ReturnType<typeof nextStreak>>()
  /** First time a job was seen processing (time-based progress). */
  const processingSince = new Map<string, number>()
  let account: { info: SeedvisAccountInfo; at: number } | null = null
  let accountReading: Promise<SeedvisAccountInfo | null> | null = null
  let accountFailedAt: number | null = null
  let slotsCap: { value: number; until: number } | null = null
  let lastRetryAfter: { ms: number; at: number } | null = null
  let endedAt: number | null = null
  let acceptedAt: number | null = null
  let epoch = 0
  /** The first POST of a key in this session: its wall time (= sent.at) and the monotonic clock then. */
  const sentClock = new Map<string, { at: number; mono: number }>()
  /** The last key status read (sameKeyRetry is synchronous: it uses this; every submit reads the status again). */
  let lastKs: SeedvisKeyStatus | null = null

  const monoNow = (): number | null => {
    if (!monotonic) return null
    try {
      const v = monotonic()
      return Number.isFinite(v) ? v : null
    } catch {
      return null
    }
  }

  /**
   * The arrival gate of a key (window.ts) at now + `aheadMs`. Within the session of its first POST, the time elapsed
   * since then is also measured on the monotonic clock and the later of the two is used, so a backward step of the
   * wall clock smaller than the elapsed time cannot stretch the window; `mustFinishBy` / `safeUntil` come back on the
   * wall clock (main enforces mustFinishBy on it), moved earlier by that step.
   */
  function gate(key: string, rec: LedgerSent | null = ledger.sent(key), aheadMs = 0): GateVerdict {
    const wall = now()
    let eff = wall
    const m = rec ? sentClock.get(key) : undefined
    const mono = m && rec && m.at === rec.at ? monoNow() : null
    if (m && mono !== null) eff = Math.max(wall, rec!.at + Math.max(0, mono - m.mono))
    const g = sameKeyGate(rec, eff + Math.max(0, aheadMs), memoryMs, marginMs, memoryFrom)
    const shift = eff - wall
    if (shift <= 0) return g
    return { ...g, mustFinishBy: g.mustFinishBy === null ? null : g.mustFinishBy - shift, safeUntil: g.safeUntil === null ? null : g.safeUntil - shift }
  }
  const gateDetail = (g: GateVerdict): string =>
    g.reason === 'disabled' ? words.detail.gateDisabled : g.reason === 'clock' ? words.detail.clockChanged : g.reason === 'no-record' ? words.detail.noRecord : words.detail.gateExpired

  async function keyInfo(): Promise<SeedvisKeyStatus | null> {
    let ks: SeedvisKeyStatus | null
    try {
      const r = deps.keyStatus ? await deps.keyStatus() : await apiOf().keyStatus()
      ks = r && typeof r.hasKey === 'boolean' ? r : null
    } catch {
      ks = null
    }
    lastKs = ks
    return ks
  }

  /**
   * May a POST of this key go out under the API key saved now (`cur`)? Only when the key that sent the first POST is
   * known (`rec.keyTag`) and is the one saved now: seedvis replays an Idempotency-Key only for the account that holds
   * it — under another account's key the same key creates (and bills) a second job.
   *   'sender-unknown' — the first POST's key tag was never known: it can never be proven (unverifiable for good);
   *   'unknown'        — the key saved now cannot be identified (unreadable, still loading, no tag);
   *   'changed'        — another key, or none, is saved now.
   */
  function sameSender(rec: LedgerSent | null, cur: SeedvisKeyStatus | null): 'ok' | 'sender-unknown' | 'unknown' | 'changed' {
    if (!rec?.keyTag) return 'sender-unknown'
    if (!cur || cur.problem === 'unreadable' || (!cur.hasKey && cur.problem === 'unknown')) return 'unknown'
    if (!cur.hasKey) return 'changed'
    if (!cur.tag) return 'unknown'
    return cur.tag === rec.keyTag ? 'ok' : 'changed'
  }
  const senderDetail = (v: 'sender-unknown' | 'unknown' | 'changed'): string => (v === 'changed' ? words.detail.keyChanged : words.detail.keyUnknown)

  // ---- prepared bytes and pins (§9 lifecycle) ----

  /** No same-key re-send is possible any more: the prepared copies are released and the pins dropped. */
  function dropPrep(key: string, prepared?: SeedvisPrepared | null) {
    const ids = new Set<string>([...(plans.get(key)?.prepared.prepIds ?? []), ...(prepared?.prepIds ?? []), ...(ledger.prep(key)?.ids ?? [])])
    plans.delete(key)
    if (ledger.prep(key)) ledger.clearPrep(key)
    if (!ids.size) return
    try {
      deps.releasePrep?.([...ids])
    } catch {
      /* a leftover is swept later */
    }
  }
  function keepPrep(key: string, entry: PlanEntry) {
    plans.set(key, entry)
    ledger.setPrep(key, { ids: entry.prepared.prepIds ?? [], pins: entry.prepared.pinIds ?? [], at: now() })
  }
  /** Prepared requests whose key can no longer be re-sent go (memory and ledger). */
  function sweepPlans() {
    for (const key of [...plans.keys()]) if (ledger.job(key) || !gate(key).allowed) dropPrep(key)
  }

  // ---- errors ----

  const uncertain = (detail: string) => new SeedvisError('uncertain', words.unknownSubmit, { uncertain: true, detail })
  const unverifiable = (detail: string) => new SeedvisError('uncertain', words.unverifiableSubmit, { uncertain: true, unverifiable: true, detail })
  const cancelledError = () => new SeedvisError('cancelled', words.cancelledBeforeSend)

  function loginError(ks: SeedvisKeyStatus | null, failure?: SeedvisBridgeFailure): SeedvisError {
    const unreadable = ks?.problem === 'unreadable' || failure?.code === 'key-unreadable'
    const missing = failure?.code === 'no-key' || (ks && !ks.hasKey && ks.problem !== 'unreadable')
    return new SeedvisError('login-required', unreadable ? words.keyUnreadable : missing ? words.noKey : words.badKey)
  }

  // ---- submit ----

  async function submitNow(req: SeedvisJobRequest, opts: SeedvisSubmitOptions): Promise<{ remoteId: string }> {
    const key = seedvisIdempotencyKey(req.key)
    ledger.reload()
    // 0. A job already exists for this key: never posted again (M4).
    const known = ledger.job(key)
    if (known) return { remoteId: known.remoteId }
    // 1. Only seedvis routes (a canvasapp scene must never reach seedvis, and the reverse is refused there).
    const route = (SEEDVIS_ROUTE_TABLE as Record<string, (typeof SEEDVIS_ROUTE_TABLE)[SeedvisModelId] | undefined>)[req.model]
    if (!route || !(route.modes as readonly string[]).includes(req.mode)) throw new SeedvisError('unsupported', words.wrongRoute(String(req.model), String(req.mode)))
    // 2. An earlier POST of this key may have reached seedvis: only through the arrival gate, decided first (M5, M7).
    const earlier = ledger.sent(key)
    // Cancelled before this POST: "nothing sent" — unless an earlier POST of the key may have reached seedvis (M6).
    const checkCancelled = () => {
      if (opts.isCancelled?.()) throw earlier ? uncertain(words.detail.cancelledWhileResending) : cancelledError()
    }
    checkCancelled()
    if (earlier) {
      if (earlier.bodyChangedAt) throw unverifiable(words.detail.bodyChanged)
      const g = gate(key, earlier)
      if (!g.allowed) {
        dropPrep(key)
        throw unverifiable(gateDetail(g))
      }
      // The key that sent it was never identified: a same-key POST can never be proven to reach the same account.
      if (!earlier.keyTag) {
        dropPrep(key)
        throw unverifiable(words.detail.keyUnknown)
      }
    } else if (ledger.isDropped(key) || opts.retryOfUnknown) {
      // Sent before (the engine says so, or its record was trimmed / damaged) and no record is left: never again (M8).
      throw unverifiable(words.detail.noRecord)
    }
    // Priority rule (M6): once something may have reached seedvis, no bridge (development mode locked meanwhile…) is
    // "maybe billed", never a plain 'unavailable'.
    if (!getBridge()) throw earlier ? uncertain(words.detail.lostAnswer) : new SeedvisError('unavailable', words.webUnavailable)
    // The saved key: none / unreadable → nothing sent ('unknown' = still being read at start-up: main decides). A
    // same-key POST needs the very key that sent the first one (read again right before every POST, postLoop).
    const ks = await keyInfo()
    if (earlier) {
      const who = sameSender(earlier, ks)
      if (who !== 'ok') throw uncertain(senderDetail(who))
    } else if (ks && !ks.hasKey && ks.problem !== 'unknown') throw loginError(ks)
    // 3. The exact bytes: the same ones for every POST of this key.
    let entry = plans.get(key) ?? null
    if (!entry) {
      let prepared: SeedvisPrepared
      try {
        prepared = await deps.prepare(req, { key, prep: ledger.prep(key) })
      } catch (e) {
        if (earlier) {
          if (e instanceof SeedvisError && e.code === 'cancelled') throw uncertain(words.detail.cancelledWhileResending)
          // The same bytes cannot be rebuilt: a different body would be refused (409) or, worse, not recognised.
          dropPrep(key)
          throw unverifiable(words.detail.prepareFailedResend(errorText(e)))
        }
        if (e instanceof SeedvisError && (e.code === 'cancelled' || e.code === 'not-sent' || e.code === 'unsupported')) throw e
        throw new SeedvisError('not-sent', words.prepareFailed(errorText(e)))
      }
      entry = { prepared, sig: await bodySignature(prepared) }
    }
    if (earlier && entry.sig.hash !== earlier.bodyHash) {
      ledger.updateSent(key, { bodyChangedAt: now() })
      dropPrep(key, entry.prepared)
      throw unverifiable(words.detail.bodyChanged)
    }
    checkCancelled()
    return postLoop(req, key, entry, earlier, opts)
  }

  async function postLoop(req: SeedvisJobRequest, key: string, entry: PlanEntry, earlier: LedgerSent | null, opts: SeedvisSubmitOptions): Promise<{ remoteId: string }> {
    const api = apiOf()
    const { prepared, sig } = entry
    /** Some attempt of this key may have reached seedvis (an earlier record, or a lost answer now). */
    let reached = !!earlier
    let detail = words.detail.lostAnswer
    /** A 2xx without a usable job id: seedvis created it — that fact stays the detail whatever ends the submit. */
    let createdNoId = false
    /** The lost answer the automatic re-sends are counted from (this call). */
    let lostAt: number | null = null
    let next = 0
    /**
     * The submit ends without a job id (the priority rule: never 'deferred' / 'cancelled' once something may have
     * reached seedvis). `closedWhy`: the window is over for that reason → unverifiable; otherwise unverifiable only when
     * the gate is closed now, else uncertain (a same-key re-send is still possible: the exact bytes are kept).
     */
    const stop = (why: string, closedWhy?: string): SeedvisError => {
      note(req.takeId, null)
      if (closedWhy !== undefined) {
        dropPrep(key, prepared)
        return unverifiable(createdNoId ? words.detail.createdNoId : closedWhy)
      }
      const g = gate(key)
      if (!g.allowed) {
        dropPrep(key, prepared)
        return unverifiable(createdNoId ? words.detail.createdNoId : gateDetail(g))
      }
      keepPrep(key, entry)
      return uncertain(createdNoId ? words.detail.createdNoId : why)
    }
    for (let attempt = 1; ; attempt++) {
      let mustFinishBy: number | undefined
      // The key main will send this POST with, read right before it leaves.
      const cur = await keyInfo()
      if (reached) {
        // Every same-key POST passes the arrival gate (M5) — checked right before it leaves.
        const g = gate(key)
        if (!g.allowed || g.mustFinishBy === null) throw stop(detail, gateDetail(g))
        // …and goes out only under the key that sent the first POST: under another account's key seedvis does not
        // know this Idempotency-Key and would create (and bill) a second job.
        const who = sameSender(ledger.sent(key), cur)
        if (who === 'sender-unknown') throw stop(detail, words.detail.keyUnknown)
        if (who !== 'ok') throw stop(senderDetail(who))
        mustFinishBy = g.mustFinishBy
        // its record first, read back (M3): not stored → not sent
        if (!ledger.updateSent(key, { lastAt: now(), attempts: (ledger.sent(key)?.attempts ?? 0) + 1 })) throw stop(words.detail.ledgerNotSavedResend)
      } else {
        // The key was removed while the request was being prepared: nothing sent.
        if (cur && !cur.hasKey && cur.problem !== 'unknown') {
          dropPrep(key, prepared)
          throw loginError(cur)
        }
        // 4. The record of this POST, stored and read back before it leaves (M3), with the key that sends it.
        const t = now()
        const rec: LedgerSent = {
          at: t,
          firstLastByteAt: null,
          uploadBps: null,
          lastAt: t,
          attempts: 1,
          model: String(req.model),
          mode: String(req.mode),
          imageCount: prepared.images.length,
          bodyHash: sig.hash,
          bodyBytes: sig.bytes,
          lastStatus: null,
          lastCode: null,
          lastRequestId: null,
          keyTag: cur?.hasKey ? cur.tag : null,
          keyHint: cur?.hasKey ? cur.hint : null,
        }
        if (!ledger.markSent(key, rec)) {
          dropPrep(key, prepared)
          throw new SeedvisError('storage', words.ledgerNotSaved)
        }
        const mono = monoNow()
        if (mono !== null) sentClock.set(key, { at: t, mono })
        // Last chance to stop: the POST below is what seedvis bills.
        if (opts.isCancelled?.()) {
          ledger.clearSent(key)
          sentClock.delete(key)
          dropPrep(key, prepared)
          throw cancelledError()
        }
      }
      const startedAt = now()
      const res = await api.create({ idempotencyKey: key, body: prepared.body, images: prepared.images, ...(mustFinishBy !== undefined ? { mustFinishBy } : {}) })
      const c = classifyCreate(res)
      recordAttempt(key, attempt === 1 && !earlier, res, c, sig.bytes, startedAt)
      log(`create ${key.slice(0, 8)} #${ledger.sent(key)?.attempts ?? attempt} → ${c.kind}${res.ok ? ` ${res.status}` : ` ${res.code}`}`)

      if (c.kind === 'created' || c.kind === 'failed-final') return accepted(req, key, c, entry, cur, opts)
      if (c.kind === 'lost') {
        reached = true
        detail = c.why === 'server-json' || c.why === 'server-other' ? words.detail.serverAfterSend(c.info?.status ?? 0) : words.detail.lostAnswer
        if (c.why === 'no-id' && res.ok) {
          // A 2xx proves seedvis created it; how it answered is logged (shape only) for the live test.
          createdNoId = true
          log(`create ${key.slice(0, 8)} ${res.status} without a usable job id (${idShape(res.json)})`)
        }
      } else if (c.kind === 'conflict') {
        // seedvis has seen this key (another body, or still on it): never a new key (M9).
        reached = true
        detail = words.detail.conflict
      } else if (c.kind === 'refused') {
        if (!reached) return refusedNow(req, key, c, prepared, opts)
        detail = words.detail.refusedAfterSend(c.info.status, c.info.code)
      } else if (c.kind === 'busy') {
        if (!reached) return deferredNow(key, c, prepared, sig.bytes, opts)
        detail = words.detail.refusedAfterSend(c.info?.status ?? 0, c.info?.code ?? c.failure?.code ?? null)
      } else {
        // not-sent: this attempt never fully left this computer
        if (!reached) return notSentNow(key, c, prepared, cur, opts)
        // a re-send main stopped at mustFinishBy: the window is over
        if (c.why === 'deadline') throw stop(detail, words.detail.deadline)
      }
      // 6. Gated automatic re-sends of the same key (+15 / +45 / +90 s after the lost answer).
      if (lostAt === null) lostAt = now()
      const due = schedule[next++]
      if (due === undefined) throw stop(detail)
      // Decided for the moment it would leave: no wait (and no "đang gửi lại" note) for a re-send that cannot fit.
      const open = gate(key, ledger.sent(key), lostAt + due - now())
      if (!open.allowed) throw stop(detail, gateDetail(open))
      // The key that sent it was never identified: no same-key re-send can ever go (no wait for one).
      if (!ledger.sent(key)?.keyTag) throw stop(detail, words.detail.keyUnknown)
      // Keep the exact bytes while a re-send is possible (a pinned original survives a library delete meanwhile).
      keepPrep(key, entry)
      note(req.takeId, words.detail.resending)
      const wait = lostAt + due - now()
      if (wait > 0) await sleep(wait)
      // Huỷ while re-sending: stop now, "maybe billed" (open decision 9).
      if (opts.isCancelled?.()) throw stop(words.detail.cancelledWhileResending)
      // Main must say the network is up; the gate is checked again meanwhile.
      while (!(await api.isOnline())) {
        if (opts.isCancelled?.()) throw stop(words.detail.cancelledWhileResending)
        const g = gate(key)
        if (!g.allowed) throw stop(detail, gateDetail(g))
        await sleep(ONLINE_CHECK_MS)
      }
    }
  }

  /** What one attempt taught the ledger (first-attempt timing only once; codes / request ids sanitized there). */
  function recordAttempt(key: string, first: boolean, res: Parameters<typeof classifyCreate>[0], c: CreateClass, bodyBytes: number, startedAt: number) {
    const info = 'info' in c ? c.info : null
    const lastByteAt = typeof res.lastByteAt === 'number' && Number.isFinite(res.lastByteAt) ? res.lastByteAt : null
    const uploadMs = res.ok && typeof res.uploadMs === 'number' && res.uploadMs > 0 ? res.uploadMs : lastByteAt !== null && lastByteAt > startedAt ? lastByteAt - startedAt : null
    ledger.updateSent(key, {
      lastStatus: res.ok ? res.status : null,
      lastCode: info?.code ?? (res.ok ? null : res.code),
      lastRequestId: info?.requestId ?? null,
      ...(first && lastByteAt !== null ? { firstLastByteAt: lastByteAt } : {}),
      ...(first && uploadMs ? { uploadBps: (bodyBytes / uploadMs) * 1000 } : {}),
    })
  }

  function accepted(req: SeedvisJobRequest, key: string, c: Extract<CreateClass, { kind: 'created' | 'failed-final' }>, entry: PlanEntry, ks: SeedvisKeyStatus | null, opts: SeedvisSubmitOptions) {
    const remoteId = c.gen.id!
    const t = now()
    // The key that sent the key's first POST (every same-key re-send was checked to go out under that very key).
    const sent = ledger.sent(key)
    const job: LedgerJob = {
      remoteId,
      at: t,
      keyTag: sent?.keyTag ?? (ks?.hasKey ? ks.tag : null),
      keyHint: sent?.keyHint ?? (ks?.hasKey ? ks.hint : null),
      ...(c.replayed ? { replayed: true as const } : {}),
      ...(c.kind === 'failed-final' ? { final: { status: c.gen.error?.code === 'cancelled' ? ('cancelled' as const) : ('failed' as const), code: c.gen.error?.code ?? null, at: t } } : {}),
    }
    ledger.recordJob(key, job)
    if (c.kind === 'failed-final') endedAt = t
    acceptedAt = t
    // No same-key re-send is possible any more: the prepared copies and pins go (§9).
    dropPrep(key, entry.prepared)
    note(req.takeId, null)
    try {
      const echo = deps.echo?.(entry.prepared, c.gen.references)
      if (echo && echo.received !== echo.sent) ledger.setEcho(key, echo)
    } catch {
      /* warn-only (M19): never fails a created job */
    }
    // The take itself disappeared while this POST was in flight (another tab deleted it…): the job exists and no take
    // will poll or cancel it — recorded for the engine to cancel (§6.4 b). Not for a take merely cancelled, or whose
    // scene was deleted while the take is kept: the engine still has that take and cancels / polls its job itself.
    let gone = false
    try {
      gone = opts.isGone?.() === true
    } catch {
      gone = false
    }
    if (gone) ledger.recordOrphan(key, { remoteId, at: t, outcome: null })
    return { remoteId }
  }

  function refusedNow(req: SeedvisJobRequest, key: string, c: Extract<CreateClass, { kind: 'refused' }>, prepared: SeedvisPrepared, opts: SeedvisSubmitOptions): never {
    // A definitive refusal: nothing was created, nothing billed.
    ledger.clearSent(key)
    dropPrep(key, prepared)
    if (opts.isCancelled?.()) throw cancelledError()
    if (c.login) throw new SeedvisError('login-required', words.badKey, { status: c.info.status, remoteCode: c.info.code, requestId: c.info.requestId })
    if (c.model) {
      // what seedvis runs changed: read /models again
      void refreshLimits({ force: true })
    }
    const w = words.refused(c.info, { model: String(req.model), mode: String(req.mode) })
    throw new SeedvisError('refused', w.text, { status: c.info.status, remoteCode: c.info.code, detail: w.detail, field: c.info.field, requestId: c.info.requestId })
  }

  function deferredNow(key: string, c: Extract<CreateClass, { kind: 'busy' }>, prepared: SeedvisPrepared, bodyBytes: number, opts: SeedvisSubmitOptions): never {
    ledger.clearSent(key)
    dropPrep(key, prepared)
    if (opts.isCancelled?.()) throw cancelledError()
    if (c.slots) {
      // the plan's slots are full (also used on seedvis.com): run fewer at once for a while
      slotsCap = { value: Math.max(1, Math.min(MAX_CONCURRENCY, ledger.openJobs().length || 1)), until: now() + SLOTS_FULL_HOLD_MS }
    }
    if (c.retryAfterMs) lastRetryAfter = { ms: c.retryAfterMs, at: now() }
    throw new SeedvisError('deferred', words.deferredBusy, {
      status: c.info?.status,
      remoteCode: c.info?.code ?? null,
      retryAfterMs: c.retryAfterMs,
      bodyBytes,
    })
  }

  function notSentNow(key: string, c: Extract<CreateClass, { kind: 'not-sent' }>, prepared: SeedvisPrepared, ks: SeedvisKeyStatus | null, opts: SeedvisSubmitOptions): never {
    ledger.clearSent(key)
    dropPrep(key, prepared)
    if (opts.isCancelled?.()) throw cancelledError()
    if (c.why === 'login') throw loginError(ks, c.failure)
    if (c.why === 'local') throw new SeedvisError('not-sent', words.notSentLocal(c.failure.message))
    throw new SeedvisError('not-sent', words.notSentUpload)
  }

  // ---- poll ----

  function progressOf(remoteId: string, gen: SeedvisGeneration): number {
    if (gen.progress !== null) return Math.max(1, Math.min(95, Math.round(gen.progress)))
    if (gen.status === 'queued') return 2
    const since = processingSince.get(remoteId) ?? now()
    if (!processingSince.has(remoteId)) processingSince.set(remoteId, since)
    const f = 1 - Math.exp(-(now() - since) / EXPECTED_PROCESSING_MS)
    return Math.max(5, Math.min(95, Math.round(5 + 90 * f)))
  }

  function finalStatus(remoteId: string, job: LedgerJob): RemoteStatusExt {
    const f = job.final!
    if (f.status === 'completed') return { remoteId, state: 'completed', progress: 99 }
    if (f.status === 'cancelled' || f.code === 'cancelled') return { remoteId, state: 'cancelled', code: 'cancelled', error: words.poll.cancelledRefunded }
    if (f.code === 'not_started') return { remoteId, state: 'failed', code: 'not_started', error: words.poll.notStarted }
    if (f.code === 'not_found') return { remoteId, state: 'failed', code: 'not_found', error: words.poll.notFoundFinal(remoteId.slice(0, 8)) }
    return { remoteId, state: 'failed', ...(f.code ? { code: f.code } : {}), error: words.poll.failed(f.code, null) }
  }

  /**
   * 'auth': the key itself is missing / wrong (401, main's no-key / bad-key / key-unreadable) — polling pauses.
   * 'forbidden': 403 on this job — another account's job, or the key lost its rights: decided over the whole batch.
   */
  type PollOne =
    | { kind: 'status'; status: RemoteStatusExt }
    | { kind: 'auth'; error: SeedvisError }
    | { kind: 'forbidden'; error: SeedvisError }
    | { kind: 'error'; error: SeedvisError }
  /** Final answers with a status SanoVids does not know, already logged (remote id + status). */
  const unknownLogged = new Set<string>()

  async function pollOne(api: SeedvisApi, remoteId: string, key: string | null, tag: string | null): Promise<PollOne> {
    const res = await api.get(remoteId)
    const t = now()
    if (!res.ok) {
      if (res.code === 'no-key' || res.code === 'key-unreadable' || res.code === 'bad-key') return { kind: 'auth', error: loginError(null, res) }
      return { kind: 'error', error: new SeedvisError('network', words.poll.failed(res.code, null), { retryAfterMs: res.retryAfterMs ?? null }) }
    }
    const job = key ? ledger.job(key) : null
    if (res.status === 200 || res.status === 202) {
      const gen = parseGeneration(res.json)
      if (!gen || (gen.id !== null && gen.id !== remoteId)) return { kind: 'error', error: new SeedvisError('bad-response', words.fetch.failed('bad-response')) }
      if (key && job?.miss) ledger.setMiss(key, null)
      strayMiss.delete(remoteId)
      const nextAt = t + Math.max(minPollMs, (gen.nextAfterSeconds ?? 0) * 1000)
      let status: RemoteStatusExt
      if (gen.status === 'completed') {
        status = { remoteId, state: 'completed', progress: 99 }
        if (key) ledger.setFinal(key, { status: 'completed', code: null, at: t })
      } else if (gen.status === 'failed') {
        const code = gen.error?.code ?? null
        if (code === 'cancelled') status = { remoteId, state: 'cancelled', code, error: words.poll.cancelledRefunded }
        else if (code === 'not_started') status = { remoteId, state: 'failed', code, error: words.poll.notStarted }
        else status = { remoteId, state: 'failed', ...(code ? { code } : {}), error: words.poll.failed(code, gen.error?.message ?? null) }
        if (key) ledger.setFinal(key, { status: code === 'cancelled' ? 'cancelled' : 'failed', code, at: t })
      } else if (gen.status === 'unknown' && (gen.rawStatus === 'cancelled' || gen.rawStatus === 'canceled')) {
        // a plain "cancelled" status: the cancelled (refunded) outcome, like failed + error.code cancelled
        status = { remoteId, state: 'cancelled', code: 'cancelled', error: words.poll.cancelledRefunded }
        if (key) ledger.setFinal(key, { status: 'cancelled', code: 'cancelled', at: t })
      } else if (gen.status === 'unknown' && gen.isFinal) {
        // A final status SanoVids does not know ("succeeded"?): never taken as a failure (a paid, finished video would
        // be reported failed and never downloaded) and never remembered — the take keeps running and is asked again.
        const raw = gen.rawStatus ?? '?'
        if (!unknownLogged.has(`${remoteId}|${raw}`)) {
          unknownLogged.add(`${remoteId}|${raw}`)
          log(`job ${remoteId.slice(0, 8)} is final with an unknown status "${raw}": kept running`)
        }
        status = { remoteId, state: 'processing', phase: 'processing', progress: progressOf(remoteId, gen), note: words.poll.unknownFinal(raw) }
      } else if (gen.status === 'queued') {
        status = { remoteId, state: 'queued', phase: 'queued', progress: progressOf(remoteId, gen), note: words.poll.queued(gen.queue?.position ?? null, gen.queue?.estimatedStartSeconds ?? null) }
      } else {
        status = { remoteId, state: 'processing', phase: 'processing', progress: progressOf(remoteId, gen) }
      }
      if (status.state === 'completed' || status.state === 'failed' || status.state === 'cancelled') {
        endedAt = t
        processingSince.delete(remoteId)
      } else if (job?.echo && !status.note) status.note = words.poll.echoShort(job.echo.received, job.echo.sent)
      pace.set(remoteId, { nextAt, last: status })
      return { kind: 'status', status }
    }
    if (res.status === 404) {
      // §6.9: a fresh 202 job may briefly be unknown, a maintenance page answers 404 — never end a paid take quickly.
      const evidence = isJsonJobNotFound(res.status, res.json) && !!job?.keyTag && !!tag && job.keyTag === tag
      const streak = nextStreak(key && job ? job.miss : strayMiss.get(remoteId), t, evidence)
      if (key && job) ledger.setMiss(key, streak)
      else strayMiss.set(remoteId, streak)
      if (key && job && notFoundEnds(streak)) {
        ledger.setFinal(key, { status: 'failed', code: 'not_found', at: t })
        endedAt = t
        const status: RemoteStatusExt = { remoteId, state: 'failed', code: 'not_found', error: words.poll.notFoundFinal(remoteId.slice(0, 8)) }
        pace.set(remoteId, { nextAt: t + minPollMs, last: status })
        return { kind: 'status', status }
      }
      const status: RemoteStatusExt = { remoteId, state: 'processing', note: words.poll.notFoundWaiting }
      pace.set(remoteId, { nextAt: t + Math.max(minPollMs, notFoundDelayMs(streak.misses)), last: status })
      return { kind: 'status', status }
    }
    const info = parseApiError(res.status, res.json, res.headers)
    if (res.status === 401) return { kind: 'auth', error: new SeedvisError('login-required', words.badKey, { status: res.status, remoteCode: info.code }) }
    if (res.status === 403) return { kind: 'forbidden', error: new SeedvisError('login-required', words.badKey, { status: res.status, remoteCode: info.code }) }
    // 429 / 5xx / anything else: keep the take running; the engine backs off when nothing answered.
    if (info.retryAfterMs) pace.set(remoteId, { nextAt: t + Math.max(minPollMs, info.retryAfterMs), last: pace.get(remoteId)?.last ?? { remoteId, state: 'processing' } })
    return { kind: 'error', error: new SeedvisError(res.status >= 500 ? 'server' : 'network', words.poll.failed(info.code, info.message), { status: res.status, retryAfterMs: info.retryAfterMs }) }
  }

  async function poll(remoteIds: string[]): Promise<RemoteStatusExt[]> {
    ledger.reload()
    sweepPlans()
    const out: RemoteStatusExt[] = []
    const due: { remoteId: string; key: string | null }[] = []
    const ks = await keyInfo()
    const tag = ks?.hasKey ? ks.tag : null
    for (const remoteId of remoteIds) {
      if (typeof remoteId !== 'string' || !SEEDVIS_ID_RE.test(remoteId)) {
        out.push({ remoteId, state: 'failed', code: 'bad_id', error: words.poll.badRemoteId })
        continue
      }
      const key = ledger.keyOfRemote(remoteId)
      const job = key ? ledger.job(key) : null
      if (job?.final) {
        out.push(finalStatus(remoteId, job))
        continue
      }
      // A job sent with another key than the one saved now: never polled with this key, never failed (M23).
      if (job?.keyTag && tag && job.keyTag !== tag) {
        const hint = job.keyHint ?? '????'
        out.push({ remoteId, state: 'processing', held: { keyHint: hint }, note: words.poll.held(hint) })
        continue
      }
      const p = pace.get(remoteId)
      if (p && now() < p.nextAt) {
        out.push(p.last)
        continue
      }
      due.push({ remoteId, key })
    }
    if (!due.length) return out
    // No key at all: polling pauses (the takes are kept; a key save resumes it).
    if (ks && !ks.hasKey && ks.problem !== 'unknown') throw loginError(ks)
    const api = apiOf()
    const results: PollOne[] = new Array(due.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < due.length) {
        const i = cursor++
        try {
          results[i] = await pollOne(api, due[i].remoteId, due[i].key, tag)
        } catch (e) {
          results[i] = { kind: 'error', error: e instanceof SeedvisError ? e : new SeedvisError('network', errorText(e)) }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(POLL_PARALLEL, due.length) }, worker))
    // The key itself is missing / wrong (401 or main says so): polling pauses for every take (they are kept).
    const auth = results.find((r): r is Extract<PollOne, { kind: 'auth' }> => r.kind === 'auth')
    if (auth) throw auth.error
    // 403 on every job asked: the key lost its rights — pause. 403 on some only: those jobs are another account's (a
    // job whose sending key was never identified cannot be held) — they keep running, the others are not paused.
    const forbidden = results.filter((r): r is Extract<PollOne, { kind: 'forbidden' }> => r.kind === 'forbidden')
    if (forbidden.length && forbidden.length === due.length) throw forbidden[0].error
    let failed: SeedvisError | null = null
    let failures = 0
    for (let i = 0; i < due.length; i++) {
      const r = results[i]
      if (r.kind === 'status') out.push(r.status)
      else if (r.kind === 'forbidden') {
        const status: RemoteStatusExt = { remoteId: due[i].remoteId, state: 'processing', note: words.poll.forbidden }
        pace.set(due[i].remoteId, { nextAt: now() + Math.max(minPollMs, FORBIDDEN_RETRY_MS), last: status })
        out.push(status)
      } else {
        failures++
        failed = r.error
        out.push(pace.get(due[i].remoteId)?.last ?? { remoteId: due[i].remoteId, state: 'processing' })
      }
    }
    if (failed && failures === due.length) throw failed
    return out
  }

  // ---- fetch ----

  /** GET the job right before a download (main records its outputs). Throws: deferred when offline. */
  async function readForFetch(api: SeedvisApi, remoteId: string): Promise<SeedvisGeneration> {
    const res = await api.get(remoteId)
    if (!res.ok) {
      if (res.code === 'offline' || !(await api.isOnline())) throw new SeedvisError('deferred', words.fetch.offline)
      if (res.code === 'no-key' || res.code === 'key-unreadable' || res.code === 'bad-key') throw loginError(null, res)
      if (res.code === 'rate-limited' || res.code === 'busy') throw new SeedvisError('deferred', words.fetch.failed(res.code), { retryAfterMs: res.retryAfterMs ?? null })
      throw new SeedvisError('network', words.fetch.failed(res.message || res.code))
    }
    if (res.status === 401 || res.status === 403) throw new SeedvisError('login-required', words.badKey, { status: res.status })
    if (res.status !== 200 && res.status !== 202) {
      const info = parseApiError(res.status, res.json, res.headers)
      throw new SeedvisError(res.status >= 500 ? 'server' : 'network', words.fetch.failed(info.message ?? info.code ?? String(res.status)), { status: res.status })
    }
    const gen = parseGeneration(res.json)
    if (!gen) throw new SeedvisError('bad-response', words.fetch.failed('bad-response'))
    if (gen.status !== 'completed') throw new SeedvisError('not-ready', words.fetch.notReady)
    return gen
  }

  async function fetchResult(remoteId: string, opts: FetchResultOptions = {}): Promise<JobResult> {
    if (!SEEDVIS_ID_RE.test(remoteId)) throw new SeedvisError('bad-request', words.poll.badRemoteId)
    if (!getBridge()) throw new SeedvisError('unavailable', words.webUnavailable)
    const api = apiOf()
    const aborted = () => new SeedvisError('aborted', words.fetch.aborted)
    if (opts.signal?.aborted) throw aborted()
    ledger.reload()
    const key = ledger.keyOfRemote(remoteId)
    // A job sent with another API key than the one saved now (a finished job's cached 'completed' skips the poll's
    // hold): never asked with this key — it would answer 404 / 403 and use up a try of a paid video (M23). Not a try.
    const sender = key ? ledger.job(key) : null
    if (sender?.keyTag) {
      const ks = await keyInfo()
      const tag = ks?.hasKey ? ks.tag : null
      if (tag && tag !== sender.keyTag) {
        const hint = sender.keyHint ?? '????'
        throw new SeedvisError('deferred', words.poll.held(hint), { held: { keyHint: hint } })
      }
    }
    // Offline does not count as a try (§6.8 rule 1).
    if (!(await api.isOnline())) throw new SeedvisError('deferred', words.fetch.offline)
    let gen = await readForFetch(api, remoteId)
    if (gen.outputCount === 0) {
      // completed without a file yet: one more round, then an error
      await sleep(minPollMs)
      if (opts.signal?.aborted) throw aborted()
      gen = await readForFetch(api, remoteId)
      if (gen.outputCount === 0) throw new SeedvisError('no-output', words.fetch.noOutput)
    }
    if (gen.outputCount > 1) log(`job ${remoteId.slice(0, 8)} has ${gen.outputCount} outputs: the first is used`)
    let open = await api.downloadOpen({ generationId: remoteId, index: 0 })
    if (!open.ok && (open.code === 'expired-link' || open.code === 'unknown-output')) {
      // a fresh link: GET the job again (main records the new outputs), then once more
      gen = await readForFetch(api, remoteId)
      open = await api.downloadOpen({ generationId: remoteId, index: 0 })
      if (!open.ok && open.code === 'expired-link') {
        // The fresh link refused too. Only a job that completed long ago can really have expired (§6.8 rule 5, M27): a
        // CDN miss right after completion (not replicated yet, a signing / clock glitch) is a plain, retried failure.
        const done = key ? ledger.job(key)?.final : undefined
        const old = done?.status === 'completed' && now() - done.at >= EXPIRED_LINK_MIN_AGE_MS
        if (old) throw new SeedvisError('expired-link', words.fetch.expired, { definitive: true })
        throw new SeedvisError('expired-link', words.fetch.linkRefused)
      }
    }
    if (!open.ok) throw await downloadFailure(api, open, 0)
    const limit = SEEDVIS_IPC_LIMITS.videoBytes
    const close = () => api.downloadClose({ id: open.ok ? open.id : '' }).catch(() => undefined)
    if (open.total !== null && open.total > limit) {
      await close()
      throw new SeedvisError('too-large', words.fetch.tooLarge)
    }
    const pieces: Uint8Array[] = []
    let received = 0
    const report = () => {
      try {
        opts.onProgress?.({ received, total: open.ok ? open.total : null })
      } catch {
        /* progress is cosmetic */
      }
    }
    for (;;) {
      if (opts.signal?.aborted) {
        await close()
        throw aborted()
      }
      const piece = await api.downloadRead({ id: open.id })
      if (!piece.ok) {
        await close()
        throw await downloadFailure(api, piece, received)
      }
      if (piece.done) break
      received += piece.bytes.length
      if (received > limit) {
        await close()
        throw new SeedvisError('too-large', words.fetch.tooLarge)
      }
      pieces.push(piece.bytes)
      report()
    }
    report()
    if (opts.signal?.aborted) throw aborted()
    return { video: new Blob(pieces as BlobPart[], { type: open.mime }), poster: null }
  }

  async function downloadFailure(api: SeedvisApi, f: SeedvisBridgeFailure, received: number): Promise<SeedvisError> {
    if (f.code === 'too-large') return new SeedvisError('too-large', words.fetch.tooLarge)
    if (f.code === 'too-slow') return new SeedvisError('too-slow', words.fetch.failed(f.message || f.code))
    if (f.code === 'offline') return new SeedvisError('deferred', words.fetch.offline)
    if (f.code === 'busy' || f.code === 'rate-limited') return new SeedvisError('deferred', words.fetch.failed(f.code), { retryAfterMs: f.retryAfterMs ?? null })
    if (f.code === 'network' || f.code === 'timeout') {
      // §6.8 rule 1: offline (whatever was received), or a network failure before any byte arrived (a captive portal,
      // the ISP down while net.isOnline() still says yes) → not one of the tries.
      if (!(await api.isOnline())) return new SeedvisError('deferred', words.fetch.offline)
      if (f.code === 'network' && received === 0) return new SeedvisError('deferred', words.fetch.failed(f.message || f.code))
    }
    if (f.code === 'expired-link') return new SeedvisError('expired-link', words.fetch.linkRefused)
    return new SeedvisError('network', words.fetch.failed(f.message || f.code))
  }

  // ---- cancel ----

  async function cancel(remoteId: string): Promise<CancelOutcome> {
    if (!SEEDVIS_ID_RE.test(remoteId) || !getBridge()) return 'unknown'
    const api = apiOf()
    const key = ledger.keyOfRemote(remoteId)
    const done = (outcome: CancelOutcome): CancelOutcome => {
      if (outcome === 'refunded' && key) ledger.setFinal(key, { status: 'cancelled', code: 'cancelled', at: now() })
      if (outcome === 'refunded') endedAt = now()
      ledger.setOrphanOutcome(remoteId, outcome)
      log(`cancel ${remoteId.slice(0, 8)} → ${outcome}`)
      return outcome
    }
    /**
     * What a job answer proves about the cancel: 'refunded' only on evidence (failed + error.code cancelled, a
     * cancelled status, or a refunded cancellation outcome); completed / failed otherwise → 'finished' (poll it); a job
     * still queued / processing → `running` (the caller says what that means: not cancellable, or not proven yet).
     */
    const evidence = (gen: SeedvisGeneration | null, running: CancelOutcome): CancelOutcome | null => {
      if (!gen) return null
      const c = gen.cancellation
      if (c?.outcome === 'partial' && (c.runningOutputs ?? 0) > 0) return 'running'
      if (gen.status === 'completed') return 'finished'
      if ((gen.status === 'failed' && gen.error?.code === 'cancelled') || gen.rawStatus === 'cancelled' || gen.rawStatus === 'canceled') return 'refunded'
      if (gen.status === 'failed') return 'finished'
      if (c?.outcome && REFUNDED_OUTCOMES.has(c.outcome)) return 'refunded'
      if (gen.status === 'queued' || gen.status === 'processing') return running
      return null
    }
    /** GET the job and decide from it. */
    const fromJob = async (running: CancelOutcome): Promise<CancelOutcome> => {
      const g = await api.get(remoteId)
      const gen = g.ok && (g.status === 200 || g.status === 202) ? parseGeneration(g.json) : null
      return evidence(gen, running) ?? 'unknown'
    }
    let unavailable = 0
    let conflictWaited = false
    for (;;) {
      const res = await api.cancel(remoteId)
      if (!res.ok) return done('unknown')
      if (res.status >= 200 && res.status < 300) {
        // A 2xx alone is no proof (an empty / unknown body, no cancellation, a job that went on): never 'refunded'
        // without evidence — that would end the take, and a job that completes (billed) would never be downloaded.
        const fromBody = evidence(parseGeneration(res.json), 'unknown')
        if (fromBody && fromBody !== 'unknown') return done(fromBody)
        log(`cancel ${remoteId.slice(0, 8)} ${res.status} without evidence (${idShape(res.json)}): reading the job`)
        // still queued / processing after the cancel was accepted: not proven either way — the poll will tell
        return done(await fromJob('unknown'))
      }
      const info = parseApiError(res.status, res.json, res.headers)
      if (res.status === 409) {
        if (info.retryAfterMs !== null && !conflictWaited && info.retryAfterMs <= CANCEL_CONFLICT_WAIT_MAX_MS) {
          conflictWaited = true
          await sleep(info.retryAfterMs)
          continue
        }
        // not cancellable: what is the job doing?
        return done(await fromJob('running'))
      }
      if (res.status === 503 && unavailable < CANCEL_UNAVAILABLE_RETRIES) {
        unavailable++
        await sleep(Math.min(info.retryAfterMs ?? 2_000, 30_000))
        continue
      }
      return done('unknown')
    }
  }

  // ---- account / concurrency ----

  function refreshAccount(): Promise<SeedvisAccountInfo | null> {
    if (accountReading) return accountReading
    const e = epoch
    accountReading = (async () => {
      const res = await apiOf().accountInfo()
      const info = res.ok && res.status >= 200 && res.status < 300 ? parseAccountInfo(res.json) : null
      if (e === epoch) {
        if (info) account = { info, at: now() }
        else accountFailedAt = now()
      }
      return info
    })().finally(() => {
      accountReading = null
    })
    return accountReading
  }

  function concurrency(): number {
    const t = now()
    if (deps.autoAccount !== false && getBridge() && !accountReading && (!account || t - account.at >= ACCOUNT_TTL_MS) && (accountFailedAt === null || t - accountFailedAt >= ACCOUNT_RETRY_MS)) {
      void refreshAccount().catch(() => null)
    }
    const lim = account?.info.concurrency_limit
    let n = typeof lim === 'number' && Number.isFinite(lim) && lim >= 1 ? Math.min(MAX_CONCURRENCY, Math.floor(lim)) : DEFAULT_CONCURRENCY
    if (slotsCap && t < slotsCap.until) n = Math.min(n, slotsCap.value)
    return Math.max(1, n)
  }

  // ---- /models limits ----

  let models: { at: number; ok: boolean; issues: ((s: VideoSettings) => SettingsIssue[]) | null } | null = null
  let modelsReading: Promise<RefreshLimitsResult> | null = null
  let modelsAttempt: LimitsInfo['lastAttempt'] = null
  let limitsMemo: { at: number; firm: boolean; value: SettingsLimits } | null = null

  function settingsLimits(): SettingsLimits {
    if (!models?.ok || !models.issues) return NO_LIMITS
    const firm = now() - models.at < MODELS_TTL_MS
    if (limitsMemo && limitsMemo.at === models.at && limitsMemo.firm === firm) return limitsMemo.value
    const issues = models.issues
    const value: SettingsLimits = Object.freeze({
      source: 'server' as const,
      firm,
      issues: (s: VideoSettings): SettingsIssue[] => {
        try {
          return issues(s)
        } catch {
          return []
        }
      },
    })
    limitsMemo = { at: models.at, firm, value }
    return value
  }

  function limitsInfo(): LimitsInfo {
    const known = !!models?.ok && !!models.issues
    return {
      source: known ? 'server' : 'none',
      at: known ? models!.at : null,
      firmUntil: known ? models!.at + MODELS_TTL_MS : null,
      lastAttempt: modelsAttempt,
      reading: !!modelsReading,
    }
  }

  function refreshLimits({ force = false, changed = false }: RefreshLimitsOptions = {}): Promise<RefreshLimitsResult> {
    const t = now()
    if (!deps.limitsFromModels) return Promise.resolve('fresh')
    if (!getBridge()) return Promise.resolve('unavailable')
    if (modelsReading && !changed) return modelsReading
    if (!force && !changed) {
      if (models?.ok && t - models.at < MODELS_TTL_MS) return Promise.resolve('fresh')
      if (modelsAttempt && modelsAttempt.result !== 'read' && t - modelsAttempt.at < MODELS_RETRY_MS) return Promise.resolve(modelsAttempt.result)
    } else if (!changed && modelsAttempt && t - modelsAttempt.at < MODELS_FORCE_MIN_MS) {
      return Promise.resolve(modelsAttempt.result === 'read' ? 'fresh' : modelsAttempt.result)
    }
    const e = epoch
    const reading: Promise<RefreshLimitsResult> = (async () => {
      const res = await apiOf().models()
      let result: 'read' | 'failed' | 'kept' | 'login'
      if (res.ok && res.status >= 200 && res.status < 300) {
        let issues: ((s: VideoSettings) => SettingsIssue[]) | null = null
        try {
          issues = deps.limitsFromModels!(res.json)
        } catch {
          issues = null
        }
        result = issues ? 'read' : models?.ok ? 'kept' : 'failed'
        if (issues && e === epoch) models = { at: now(), ok: true, issues }
      } else if (res.ok && (res.status === 401 || res.status === 403)) result = 'login'
      else result = models?.ok ? 'kept' : 'failed'
      if (e === epoch) modelsAttempt = { at: now(), result }
      return result
    })()
      .catch(() => 'failed' as const)
      .finally(() => {
        if (modelsReading === reading) modelsReading = null
      })
    modelsReading = reading
    return reading
  }

  // ---- ledger-only views ----

  function sameKeyRetry(takeId: string): SameKeyRetry {
    const key = seedvisIdempotencyKey(takeId)
    if (ledger.job(key)) return { safeUntil: Number.POSITIVE_INFINITY, reason: 'ok' }
    const rec = ledger.sent(key)
    if (!rec) return { safeUntil: null, reason: 'no-record' }
    if (rec.bodyChangedAt) return { safeUntil: null, reason: 'body-changed' }
    const g = gate(key, rec)
    if (g.reason === 'disabled') return { safeUntil: null, reason: 'disabled' }
    if (g.reason === 'no-record') return { safeUntil: null, reason: 'no-record' }
    // The clock went backwards: no moment can be called safe (the submit refuses it too).
    if (g.reason === 'clock') return { safeUntil: null, reason: 'expired' }
    // Only under the key that sent it (the sending key never identified, or another / no key saved as last read). A
    // key status not read yet / unreadable is left to the submit, which reads it again and refuses then.
    const who = sameSender(rec, lastKs)
    if (who === 'sender-unknown' || who === 'changed') return { safeUntil: null, reason: 'key-changed' }
    return { safeUntil: g.safeUntil, reason: g.allowed ? 'ok' : 'expired' }
  }

  function diagnostics(takeId: string): Record<string, string> {
    const key = seedvisIdempotencyKey(takeId)
    const job = ledger.job(key)
    const sent = ledger.sent(key)
    const iso = (t: number | null | undefined) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString() : '—')
    const out: Record<string, string> = { provider: id, idempotencyKey: key }
    if (job) {
      out.remoteId = job.remoteId
      out.jobRecordedAt = iso(job.at)
      if (job.final) out.final = `${job.final.status}${job.final.code ? ` (${job.final.code})` : ''} ${iso(job.final.at)}`
      if (job.replayed) out.replayed = 'true'
      if (job.echo) out.echo = `${job.echo.received}/${job.echo.sent}`
      if (job.miss) out.notFound = `${job.miss.count}/${job.miss.misses}`
      if (job.keyHint) out.keyHint = `…${job.keyHint}`
    }
    if (sent) {
      out.attempts = String(sent.attempts)
      out.firstSentAt = iso(sent.at)
      out.firstLastByteAt = iso(sent.firstLastByteAt)
      out.lastSentAt = iso(sent.lastAt)
      out.bodyBytes = String(sent.bodyBytes)
      out.images = String(sent.imageCount)
      out.model = sent.model
      out.mode = sent.mode
      if (sent.lastStatus !== null) out.lastStatus = String(sent.lastStatus)
      if (sent.lastCode) out.lastCode = sent.lastCode
      if (sent.lastRequestId) out.requestId = sent.lastRequestId
      if (!out.keyHint && sent.keyHint) out.keyHint = `…${sent.keyHint}`
      const r = sameKeyRetry(takeId)
      out.sameKeyRetry = r.reason + (r.safeUntil !== null && Number.isFinite(r.safeUntil) ? ` until ${iso(r.safeUntil)}` : '')
    }
    if (ledger.isDropped(key)) out.dropped = 'true'
    const orphan = ledger.data().orphans[key]
    if (orphan) out.orphan = `${orphan.remoteId} ${orphan.outcome ?? 'pending'}`
    return out
  }

  function sweepPrep() {
    sweepPlans()
    for (const [key, p] of Object.entries(ledger.data().prep)) {
      if (ledger.job(key) || now() - p.at >= PREP_SWEEP_MS || !gate(key).allowed) dropPrep(key)
    }
  }

  function reset() {
    epoch++
    pace.clear()
    strayMiss.clear()
    processingSince.clear()
    account = null
    accountReading = null
    accountFailedAt = null
    slotsCap = null
    models = null
    modelsReading = null
    modelsAttempt = null
    limitsMemo = null
    lastRetryAfter = null
  }

  return {
    id,
    label: deps.label ?? (id === 'seedvis-dev' ? 'seedvis giả lập' : 'seedvis.com'),
    ...(deps.minPollMs !== undefined ? { minPollIntervalMs: minPollMs } : {}),

    available: async () => {
      if (!getBridge()) return { ok: false, reason: words.webUnavailable }
      const ks = await keyInfo()
      if (ks?.problem === 'unreadable') return { ok: false, reason: words.keyUnreadable }
      if (ks && !ks.hasKey && ks.problem !== 'unknown') return { ok: false, reason: words.noKey }
      return { ok: true }
    },

    capabilities: (model) => {
      const table = SEEDVIS_ROUTE_TABLE as Record<string, (typeof SEEDVIS_ROUTE_TABLE)[SeedvisModelId] | undefined>
      const route = table[model] ?? SEEDVIS_ROUTE_TABLE['seedvis/seedance_2.5']
      return {
        model: route.id,
        modes: [...route.modes],
        durations: [...route.durations],
        resolutions: [...route.resolutions],
        ratios: [...route.ratios],
        maxRefImages: route.maxRefImages,
        promptLimit: () => route.promptLimit,
        maxConcurrency: concurrency(),
        pollIntervalMs: minPollMs,
      }
    },

    submit: (req, opts = {}) => {
      const same = inflight.get(req.key)
      if (same) return same
      const run = submitNow(req, opts)
      inflight.set(req.key, run)
      void run
        .catch(() => undefined)
        .finally(() => {
          if (inflight.get(req.key) === run) inflight.delete(req.key)
        })
      return run
    },

    recover: async (req) => {
      ledger.reload()
      const key = seedvisIdempotencyKey(req.key)
      const known = () => ledger.job(key)?.remoteId ?? null
      if (known()) return { remoteId: known()! }
      const running = inflight.get(req.key)
      if (running) {
        try {
          return await running
        } catch {
          /* fall through: the ledger says what is known */
        }
      }
      // Ledger only: recover never sends anything (M4).
      return known() ? { remoteId: known()! } : null
    },

    poll,
    fetchResult,
    cancel,
    reset,
    settingsLimits,
    limitsInfo,
    refreshLimits,
    concurrency,
    deferDelayMs: (n, retryAfterMs) => {
      const recent = lastRetryAfter && now() - lastRetryAfter.at < RETRY_AFTER_MEMORY_MS ? lastRetryAfter.ms : 0
      return backoffMs(n, Math.max(retryAfterMs ?? 0, recent))
    },
    diagnostics,
    sameKeyRetry,

    openJobs: () => ledger.openJobs().map(({ job }) => ({ remoteId: job.remoteId, keyHint: job.keyHint, at: job.at })),
    orphans: () => Object.entries(ledger.data().orphans).map(([key, o]) => ({ key, ...o })),
    pinnedImageIds: () => {
      const ids = new Set<string>()
      for (const [key, p] of Object.entries(ledger.data().prep)) {
        if (!ledger.job(key) && gate(key).allowed) for (const x of p.pins) ids.add(x)
      }
      return [...ids]
    },
    releaseTake: (takeId) => dropPrep(seedvisIdempotencyKey(takeId)),
    sweepPrep,
    refreshAccount,
    noteAccountInfo: (info) => {
      const parsed = parseAccountInfo(info)
      if (parsed) account = { info: parsed, at: now() }
    },
    jobEndedAt: () => endedAt,
    lastAcceptedAt: () => acceptedAt,
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  return String(e ?? '')
}
