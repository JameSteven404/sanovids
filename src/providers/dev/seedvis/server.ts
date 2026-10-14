import { SEEDVIS_MODEL_IDS } from '../../../core/services'
import { SEEDVIS_ROUTE_TABLE } from '../../../core/seedvisRoutes'
import { devAllowed } from '../../devAccess'
import type { SeedvisKeyStatus, SeedvisKeyResult, SeedvisResponse, SeedvisResponseHeaders, SeedvisRequest, SeedvisBridgeFailure, SeedvisIpcRoute } from '../../seedvis/contract'
import { SEEDVIS_API_BASE, SEEDVIS_IPC_LIMITS, SEEDVIS_IPC_ROUTES } from '../../seedvis/contract'
import {
  cleanSeedvisFault, isSeedvisModifier, seedvisOutcomeApplies, SEEDVIS_JOB_MODIFIERS,
  type SeedvisDevFault, type SeedvisFaultInput, type SeedvisFaultKind, type SeedvisFaultRule,
} from './faults'
import {
  indexedSeedvisStore, memorySeedvisStore, seedvisConfig, seedvisDevAccountOf, SEEDVIS_DEV_ACCOUNTS, SEEDVIS_DEV_KEY_TAGS, SEEDVIS_DEV_MAX_JOBS, SEEDVIS_DEV_SAMPLE_KEYS_ONLY,
  type SeedvisStateStore, type SeedvisDevState, type SeedvisDevJob, type SeedvisDevConfig, type SeedvisDevAccount, type SeedvisDevKeyState,
} from './state'
import { failure, isObj, seedvisBodyHash, seedvisRequestProblem, seedvisUploadBytes, type SeedvisCreate } from './validate'
import { renderSeedvisVideo } from './render'

export const SEEDVIS_DEV_LOCKED = 'Chỉ dùng seedvis giả lập khi chế độ Phát triển đang mở.'
export const SEEDVIS_DEV_CDN = 'https://cdn.seedvis.invalid'
/**
 * The one 422 the simulator gives when the plan's streams and queue are full (the real API uses 422 validation_error for
 * both this and a schema error, so only the message tells them apart). Fixed English, like the real API; the mapping
 * track's errorOf must classify it as deferred, while a schema 422 stays a parameter error.
 */
export const SEEDVIS_SLOTS_FULL_MESSAGE = 'Concurrency + queue limit reached: all streams of your plan are busy and the queue is full. Retry when a running job finishes.'
const foreignCDN = 'https://media.example.invalid'
const ok = (json: unknown, status = 200, headers: SeedvisResponseHeaders = {}): SeedvisResponse => ({ ok: true, status, json, headers })
/** Documented success envelope: {success, status, message, data} (+ cancellation on a cancel). */
const answer = (data: unknown, status = 200, headers: SeedvisResponseHeaders = {}, extra: Record<string, unknown> = {}) =>
  ok({ success: true, status, message: null, data, ...extra }, status, headers)
const GRPC_STATUS: Record<number, string> = {
  400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 402: 'FAILED_PRECONDITION', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 409: 'ABORTED',
  422: 'INVALID_ARGUMENT', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 501: 'UNIMPLEMENTED', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED',
}

export interface SeedvisErrorOptions { format?: 'native' | 'openai' | 'google'; field?: string; message?: string; retryAfterSeconds?: number }
/** The documented error bodies. Native: top-level {success:false, status, code, message} and errors only for a field-keyed code. */
export function seedvisError(status: number, code: string, opts: SeedvisErrorOptions = {}): SeedvisResponse {
  const message = opts.message ?? `Lỗi seedvis giả lập: ${code}`
  const json = opts.format === 'google' ? { error: { code: status, message, status: GRPC_STATUS[status] ?? 'UNKNOWN' } }
    : opts.format === 'openai' ? { error: { message, type: 'invalid_request_error', code, param: opts.field ?? null } }
      : { success: false, status, code, message, ...(opts.field ? { errors: { [opts.field]: [message] } } : {}) }
  return ok(json, status, opts.retryAfterSeconds === undefined ? {} : { 'Retry-After': String(opts.retryAfterSeconds) })
}
const slotsFull = () => seedvisError(422, 'validation_error', { message: SEEDVIS_SLOTS_FULL_MESSAGE })

/** `[png 1.2 MB]` style sizes for the request log. */
export function seedvisSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export interface SeedvisDevLog {
  at: number
  ms: number
  endpoint: SeedvisIpcRoute | 'download' | 'invalid'
  /** HTTP status of the simulated answer, or the local gateway failure code. */
  status: number | string
  authorization?: 'Bearer ***'
  /** Create only: whether the whole body reached the simulated server, and the bytes put on the wire by this attempt. */
  sent?: boolean
  uploadedBytes?: number
  images?: string[]
  host?: string
}
export interface SeedvisDevDeps { store?: SeedvisStateStore; now?: () => number; sleep?: (ms: number) => Promise<void> }
export type SeedvisDevDownload = { ok: true; bytes: Uint8Array; total: number; contentType: string; redirect?: string } | SeedvisBridgeFailure
export type SeedvisFaultResult = { ok: true; rule: SeedvisFaultRule } | SeedvisBridgeFailure

function auth(keyState: SeedvisDevKeyState): SeedvisResponse | null {
  if (keyState === 'none') return failure('no-key')
  if (keyState === 'unreadable') return failure('key-unreadable')
  if (keyState === 'revoked') return seedvisError(401, 'unauthorized')
  if (keyState === 'forbidden') return seedvisError(403, 'forbidden')
  return null
}

function statusOfKey(s: Readonly<SeedvisDevState>): SeedvisKeyStatus {
  return { hasKey: s.keyState !== 'none', hint: s.keyState === 'none' ? null : s.account,
    tag: s.keyState === 'none' ? null : SEEDVIS_DEV_KEY_TAGS[s.account], savedAt: s.keyState === 'none' ? null : s.savedAt,
    verifiedAt: s.keyState === 'verified' && !s.keyUnchecked ? s.savedAt : null, storage: 'safeStorage',
    ...(s.keyState === 'unreadable' ? { problem: 'unreadable' as const } : {}) }
}

function refund(s: SeedvisDevState, job: SeedvisDevJob) {
  if (job.refunded) return
  s.balances[job.account] += job.cost
  job.refunded = true
}

/**
 * Bring the queue up to `now` lazily (no background timer), even after a long offline gap. Queued jobs start first in,
 * first out by the time they became ready (a released held job queues behind the ones already due), starts never go
 * back in time (not before the last update, `clock`, nor before an earlier start), a started job is never re-placed,
 * and at no moment do more than `concurrency` jobs of an account run — also after a release or a concurrency change.
 * Call it before any change that moves the queue (release, cancel, configure).
 */
function advance(s: SeedvisDevState, now: number) {
  const limit = s.config.concurrency
  for (const account of SEEDVIS_DEV_ACCOUNTS) {
    const jobs = s.jobs.filter(j => j.account === account)
    // End times of the jobs running at the last update. Every start from here on is at or after all of their starts,
    // so "running at t" is just "ends after t".
    const ends = jobs.filter(j => j.startAt !== null && j.endAt! > s.clock).map(j => j.endAt!).sort((a, b) => a - b)
    const queue = jobs.filter(j => j.status === 'queued').sort((a, b) => a.readyAt - b.readyAt) // stable: creation order on ties
    let floor = s.clock
    let blocked = false
    for (const job of queue) {
      let start = Infinity
      if (!job.held && !blocked) {
        start = Math.max(job.readyAt, floor)
        const first = ends.findIndex(e => e > start)
        const running = first < 0 ? 0 : ends.length - first
        if (running >= limit) start = ends[first + running - limit] // the end that leaves limit - 1 running
      }
      if (job.notStartedAt !== null && job.notStartedAt <= now && job.notStartedAt <= start) {
        job.status = 'failed'; job.code = 'not_started'; refund(s, job)
      } else if (start <= now) {
        job.startAt = start; job.endAt = start + job.processingMs; job.status = 'processing'
        floor = start
        const at = ends.findIndex(e => e > job.endAt!)
        ends.splice(at < 0 ? ends.length : at, 0, job.endAt)
      } else if (!job.held) blocked = true // first in line cannot start yet: the ones behind it wait too
    }
    for (const job of jobs) {
      if (job.status !== 'processing' || job.endAt! > now) continue
      job.status = job.failCode ? 'failed' : 'completed'
      job.code = job.failCode
      if (job.code === 'not_started' || job.code === 'insufficient_credits') refund(s, job)
    }
  }
  s.clock = Math.max(s.clock, now)
  s.memory = s.memory.filter(m => m.expiresAt > now)
}

const isOpen = (j: SeedvisDevJob) => j.status === 'queued' || j.status === 'processing'
/**
 * Keep the job list bounded: over the cap, the oldest finished jobs go (with their links). Retention alone does not
 * drop a job: a poll past retention must still find it, so a download can end on a definitive "link expired".
 */
function compact(s: SeedvisDevState) {
  let over = s.jobs.length - SEEDVIS_DEV_MAX_JOBS
  if (over <= 0) return
  const pinned = new Set(s.memory.map(m => m.jobId))
  const drop = new Set<string>()
  for (const j of s.jobs) {
    if (over <= 0) break
    if (isOpen(j) || pinned.has(j.id)) continue
    drop.add(j.id)
    over--
  }
  if (!drop.size) return
  for (const j of s.jobs) {
    if (!drop.has(j.id)) continue
    const t = s.trimmed[j.account]
    t.generations++
    if (!j.refunded) t.creditsUsed += j.cost
    if (j.status === 'completed') t.completed++
    else t.failed++
  }
  s.jobs = s.jobs.filter(j => !drop.has(j.id))
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const JOB_MESSAGE = {
  queued: 'Queued. Waiting for a free stream of your plan; poll next.url, do not resend this request.',
  processing: 'Accepted. Generation is running. Poll next.url until is_final is true; do not resend this request.',
  completed: 'Completed.',
  failed: 'Failed.',
} as const

function jobJson(s: SeedvisDevState, j: SeedvisDevJob, now: number) {
  const final = j.status === 'completed' || j.status === 'failed'
  const expires = Math.min(now + s.config.signedUrlMs, (j.endAt ?? now) + s.config.retentionMs)
  j.links = j.links.filter(l => l.expiresAt > now)
  const link = j.links.find(l => l.expiresAt === expires) ?? { token: crypto.randomUUID(), expiresAt: expires }
  if (j.status === 'completed' && !j.emptyOutputs && !j.links.includes(link)) {
    // ponytail: keep at most 64 issued links per fake job; use a separate URL store for larger stress runs.
    j.links = [...j.links.slice(-63), link]
  }
  const url = `${s.config.foreignHost ? foreignCDN : SEEDVIS_DEV_CDN}/${j.id}/0.mp4?expires=${expires}&signature=${link.token}`
  const refs = j.shortEcho ? j.references.slice(0, -1) : j.references
  const path = `${SEEDVIS_API_BASE}/developer/generations/${j.id}`
  let next: Record<string, unknown> = { action: 'done' }
  let queue: Record<string, unknown> | null = null
  if (j.status === 'queued') {
    const position = s.jobs.slice(0, s.jobs.indexOf(j)).filter(k => k.account === j.account && k.status === 'queued').length + 1
    // Docs: position × the job duration ÷ the plan's streams; after_seconds is that estimate clamped to 15–120 s.
    const wait = Math.max(1, Math.ceil(Math.max(j.readyAt - now, position * j.processingMs / s.config.concurrency) / 1000))
    queue = { position, estimated_start_seconds: wait }
    next = { action: 'poll', url: path, after_seconds: clamp(wait, 15, 120) } // a queued job's next.url drops wait=
  } else if (j.status === 'processing') {
    next = { action: 'poll', url: `${path}?wait=0`, after_seconds: clamp(Math.ceil((j.endAt! - now) / 1000), 10, 120) }
  }
  return {
    id: j.id, object: 'generation', status: j.status, is_final: final, model: j.body.model, mode: j.body.mode, message: JOB_MESSAGE[j.status],
    ...(queue ? { queue } : {}),
    next,
    references: refs.map(r => ({ ...r, role: r.field === 'lastFrame' ? 'end' : r.field === 'image' || (r.field === 'reference_images' && r.index === 0) ? 'start' : null, source: 'inline', url: `${SEEDVIS_DEV_CDN}/reference/${j.id}/${r.field}/${r.index}` })),
    outputs: j.status === 'completed' && !j.emptyOutputs ? [{ index: 0, type: 'video', url, expires_at: new Date(expires).toISOString() }] : [],
    ...(j.code ? { error: { code: j.code, message: `Kết quả seedvis giả lập: ${j.code}` } } : {}),
  }
}

/** The faults that may act on one request: every matching modifier and the first outcome that can act on this endpoint. Nothing is used up yet. */
interface FaultPick { modifiers: SeedvisFaultRule[]; outcome: SeedvisFaultRule | null }
interface Trace { endpoint: SeedvisDevLog['endpoint']; authorization?: boolean; sent?: boolean; uploadedBytes?: number; images?: string[] }

export function createDevSeedvis(deps: SeedvisDevDeps = {}) {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const store = deps.store ?? (typeof indexedDB === 'undefined' ? memorySeedvisStore() : indexedSeedvisStore())
  let rules: SeedvisFaultRule[] = []
  let seq = 0
  let persistProblem: string | null = null
  let uploadedBytes = 0
  const logs: SeedvisDevLog[] = []
  const listeners = new Set<() => void>()
  let notifyQueued = false
  /** Deferred: a listener that reads the server must never run inside a store change. */
  function notify() {
    if (notifyQueued) return
    notifyQueued = true
    queueMicrotask(() => {
      notifyQueued = false
      for (const l of [...listeners]) {
        try { l() } catch { /* a listener's problem is not the server's */ }
      }
    })
  }
  const locked = () => failure('not-allowed', SEEDVIS_DEV_LOCKED)
  const storageError = () => {
    persistProblem = 'Không lưu hoặc đọc được dữ liệu seedvis giả lập.'
    notify()
    return failure('storage-failed', persistProblem)
  }
  async function commit<T>(fn: (s: SeedvisDevState) => T): Promise<T> {
    const result = await store.change(fn)
    persistProblem = null
    notify()
    return result
  }
  function log(entry: SeedvisDevLog) { logs.push(entry); if (logs.length > 300) logs.shift(); notify() }

  function pickFaults(endpoint: SeedvisIpcRoute | 'download'): FaultPick {
    const matches = rules.filter(r => r.endpoint === endpoint || r.endpoint === '*')
    const outcomes = matches.filter(r => !isSeedvisModifier(r.fault.kind) && seedvisOutcomeApplies(r.fault.kind, endpoint))
    // Match canvasapp: endpoint rules before '*' rules; queued one-shot outcomes act in the order they were added.
    return { modifiers: endpoint === 'download' ? [] : matches.filter(r => isSeedvisModifier(r.fault.kind)), outcome: outcomes.find(r => r.endpoint === endpoint) ?? outcomes[0] ?? null }
  }
  /** Use up a fault only at the step it acts on, so an early exit (offline, deadline, replay, refusal) leaves it for the next request. */
  function fire(rule: SeedvisFaultRule | null | undefined, ...kinds: SeedvisFaultKind[]): SeedvisDevFault | null {
    if (!rule || !kinds.includes(rule.fault.kind) || !rules.includes(rule) || (!rule.sticky && rule.remaining <= 0)) return null
    rule.hits++
    if (!rule.sticky && --rule.remaining <= 0) rules = rules.filter(r => r !== rule)
    notify()
    return rule.fault
  }
  const modifier = (pick: FaultPick, kind: SeedvisFaultKind) => fire(pick.modifiers.find(r => r.fault.kind === kind && rules.includes(r)), kind)
  const responseOf = (f: SeedvisDevFault) => f.kind === 'response' ? seedvisError(f.status, f.code, { format: f.format, field: f.field, retryAfterSeconds: f.retryAfterSeconds }) : null

  function createAnswer(s: SeedvisDevState, req: SeedvisCreate, pick: FaultPick, hash: string, withoutKey: boolean, t: number): SeedvisResponse {
    const key = withoutKey ? `body:${hash}` : req.idempotencyKey.toLowerCase()
    const remembered = s.memory.find(m => m.account === s.account && m.key === key)
    if (remembered) {
      return remembered.hash === hash ? answer(jobJson(s, s.jobs.find(j => j.id === remembered.jobId)!, t), 200, { 'Idempotency-Replayed': 'true' }) : seedvisError(409, 'idempotency_conflict')
    }
    const active = s.jobs.filter(j => j.account === s.account && isOpen(j)).length
    if (s.slotsFullUntil > t || active >= s.config.concurrency + s.config.queueLimit) return slotsFull()
    const slots = fire(pick.outcome, 'slots-full')
    if (slots?.kind === 'slots-full') { s.slotsFullUntil = Math.max(s.slotsFullUntil, t + slots.forMs); return slotsFull() }
    if (s.balances[s.account] < s.config.price) return seedvisError(402, 'insufficient_credits')
    // Only a NEW job uses up the job modifiers.
    const mods = Object.fromEntries(SEEDVIS_JOB_MODIFIERS.map(kind => [kind, modifier(pick, kind)])) as Record<typeof SEEDVIS_JOB_MODIFIERS[number], SeedvisDevFault | null>
    const notStarted = mods['not-started'], missing = mods['poll-404'], fail = mods['fail-job']
    const id = `sv-dev-${crypto.randomUUID()}`
    const job: SeedvisDevJob = {
      id, account: s.account, idempotencyKey: key, body: req.body, references: (req.images ?? []).map(i => ({ field: i.field, index: i.index })),
      createdAt: t, readyAt: t + s.config.queuedMs, startAt: null, endAt: null, processingMs: s.config.processingMs,
      status: 'queued', cost: s.config.price, refunded: false, code: null, failCode: fail?.kind === 'fail-job' ? fail.code : null,
      held: !!mods.hold || !!notStarted,
      notStartedAt: notStarted?.kind === 'not-started' ? t + notStarted.afterMs : null,
      missingPolls: missing?.kind === 'poll-404' ? missing.polls : 0,
      emptyOutputs: !!mods['empty-outputs'], shortEcho: !!mods['short-echo'],
      links: [], video: renderSeedvisVideo(id),
    }
    s.balances[s.account] -= job.cost
    s.jobs.push(job)
    s.memory.push({ account: s.account, key, hash, jobId: id, expiresAt: t + (withoutKey ? 120_000 : s.config.keyMemoryMs) })
    return answer(jobJson(s, job, t), 202)
  }

  function jobAnswer(s: SeedvisDevState, req: Extract<SeedvisRequest, { id: string }>, pick: FaultPick, t: number): SeedvisResponse {
    const job = s.jobs.find(j => j.id === req.id && j.account === s.account)
    if (!job) return seedvisError(404, 'generation_not_found')
    if (req.route === 'generations.get') {
      if (job.missingPolls > 0) { job.missingPolls--; return seedvisError(404, 'generation_not_found') }
      return answer(jobJson(s, job, t), s.config.poll202 && isOpen(job) ? 202 : 200)
    }
    if (isOpen(job) && fire(pick.outcome, 'cancel-partial')) {
      // The request keeps running: a queued job still waits for a free stream (it is never forced past the limit).
      job.held = false
      return answer(jobJson(s, job, t), 200, {}, { cancellation: { outcome: 'partial', cancelled_outputs: 0, running_outputs: 1 } })
    }
    if (job.status === 'queued') {
      job.status = 'failed'; job.code = 'cancelled'; refund(s, job)
      return answer(jobJson(s, job, t), 200, {}, { cancellation: { outcome: 'cancelled', cancelled_outputs: 1, running_outputs: 0 } })
    }
    // Safe to call twice; the refund happened exactly once, so nothing more is cancelled.
    if (job.code === 'cancelled') return answer(jobJson(s, job, t), 200, {}, { cancellation: { outcome: 'cancelled', cancelled_outputs: 0, running_outputs: 0 } })
    return seedvisError(409, 'not_cancellable')
  }

  async function handle(raw: unknown, withoutKey: boolean, trace: Trace): Promise<SeedvisResponse> {
    const problem = seedvisRequestProblem(raw)
    if (problem) return problem
    // Capture bytes before the first await; renderer changes cannot alter an in-flight request.
    let req: SeedvisRequest
    try { req = structuredClone(raw) as SeedvisRequest } catch { return failure('bad-request') }
    if (req.route === 'generations.create') {
      trace.images = (req.images ?? []).map(i => `[${i.mime.split('/')[1]} ${seedvisSizeLabel(i.bytes.length)}]`)
      trace.sent = false
    }
    const head = await store.peek(s => ({ epoch: s.epoch, account: s.account, keyState: s.keyState, online: s.config.online, bps: s.config.uploadBytesPerSecond }))
    const keyProblem = auth(head.keyState)
    if (keyProblem) return keyProblem
    trace.authorization = true
    const pick = pickFaults(req.route)
    if (!head.online || fire(pick.outcome, 'offline')) return { ...failure('offline'), sent: false }
    let lastByteAt: number | undefined
    let uploadMs: number | undefined
    let hash = ''
    if (req.route === 'generations.create') {
      hash = await seedvisBodyHash(req)
      const total = seedvisUploadBytes(req)
      const slow = modifier(pick, 'slow-upload')
      const bps = slow?.kind === 'slow-upload' ? slow.bytesPerSecond : head.bps
      const needMs = Math.ceil(total * 1000 / bps)
      const uploadStart = now()
      if (req.mustFinishBy !== undefined && uploadStart + needMs > req.mustFinishBy) {
        const spent = Math.max(0, req.mustFinishBy - uploadStart)
        await sleep(spent)
        trace.uploadedBytes = Math.min(total, Math.floor(spent * bps / 1000))
        return { ...failure('deadline'), sent: false, lastByteAt: null }
      }
      await sleep(needMs)
      trace.uploadedBytes = total
      if (req.mustFinishBy !== undefined && now() > req.mustFinishBy) return { ...failure('deadline'), sent: false, lastByteAt: null }
      lastByteAt = now()
      uploadMs = lastByteAt - uploadStart
    }
    if (!devAllowed()) return { ...locked(), sent: false }
    const result = await commit((s): SeedvisResponse => {
      if (s.epoch !== head.epoch || s.account !== head.account) return { ...failure('no-key', 'Tài khoản giả lập đã thay đổi; chưa gửi yêu cầu.'), sent: false }
      // The connection dropped once the whole body was on the wire: like main (seedvis-rules errorSent), the client can
      // no longer tell whether it arrived — never "not sent" after a complete upload.
      if (!s.config.online) return req.route === 'generations.create' ? { ...failure('network'), sent: true, lastByteAt: lastByteAt ?? null } : failure('offline')
      const t = now()
      advance(s, t)
      if (fire(pick.outcome, 'revoke-key')) s.keyState = 'revoked'
      let out = auth(s.keyState)
      if (!out) {
        const early = pick.outcome?.fault.kind === 'response' && !pick.outcome.fault.afterProcessing ? fire(pick.outcome, 'response') : null
        if (early) out = responseOf(early)
        else if (fire(pick.outcome, 'html-404')) out = ok(undefined, 404)
        else if (fire(pick.outcome, 'not-found')) out = seedvisError(404, 'generation_not_found')
        else if (req.route === 'models') {
          out = answer(SEEDVIS_MODEL_IDS.map(id => {
            const spec = SEEDVIS_ROUTE_TABLE[id]
            return { id: spec.remoteModel, type: 'video', modes: spec.requests.map(m => s.config.modesShape === 'strings' ? m.remoteMode : { id: m.remoteMode, available: true }),
              durations: [...spec.durations], aspect_ratios: [...spec.ratios], available: true, simulated: true }
          }))
        } else if (req.route === 'account.info') {
          out = answer({ plan: 'Giả lập', api_enabled: true, credit_balance: s.balances[s.account], concurrency_limit: s.config.concurrency, queue_limit: s.config.queueLimit,
            rate_limit_per_minute: 30, poll_rate_limit_per_minute: 384, poll_rate_limit_per_job_per_minute: 20,
            simulated: true, credit_label: 'credit dev seedvis', retention_days: s.config.retentionMs / 86_400_000, price_per_video: s.config.price })
        } else if (req.route === 'account.usage') {
          const mine = s.jobs.filter(j => j.account === s.account)
          const trimmed = s.trimmed[s.account]
          const byStatus = { queued: 0, processing: 0, completed: trimmed.completed, failed: trimmed.failed }
          for (const j of mine) byStatus[j.status]++
          out = answer({ simulated: true, generations: mine.length + trimmed.generations,
            credits_used: trimmed.creditsUsed + mine.reduce((n, j) => n + (j.refunded ? 0 : j.cost), 0), credit_balance: s.balances[s.account], by_status: byStatus })
        } else if (req.route === 'generations.create') out = createAnswer(s, req, pick, hash, withoutKey, t)
        else out = 'id' in req ? jobAnswer(s, req, pick, t) : failure('bad-request')
        // A 5xx after the server already processed the request (the job, if any, exists).
        const late = pick.outcome?.fault.kind === 'response' && pick.outcome.fault.afterProcessing ? fire(pick.outcome, 'response') : null
        if (late) out = responseOf(late)!
      }
      compact(s)
      // The server answered (whatever it said), then the answer was lost on the way back.
      if (fire(pick.outcome, 'lost-response')) {
        const lost = failure('network', 'Mất câu trả lời seedvis giả lập sau khi xử lý.')
        return req.route === 'generations.create' ? { ...lost, sent: true, lastByteAt: lastByteAt ?? null } : lost
      }
      return out!
    })
    if (req.route === 'generations.create') trace.sent = result.ok || result.sent === true
    return result.ok ? { ...result, headers: { ...result.headers, 'X-Request-Id': `dev-${crypto.randomUUID()}` }, ...(lastByteAt === undefined ? {} : { lastByteAt, uploadMs }) } : result
  }

  /** Every request is logged, also offline, deadline-aborted, refused and failed ones. */
  async function request(raw: unknown, withoutKey = false): Promise<SeedvisResponse> {
    if (!devAllowed()) return locked()
    const started = now()
    const trace: Trace = { endpoint: isObj(raw) && typeof raw.route === 'string' && Object.hasOwn(SEEDVIS_IPC_ROUTES, raw.route) ? raw.route as SeedvisIpcRoute : 'invalid' }
    const result = await handle(raw, withoutKey, trace).catch(() => storageError())
    uploadedBytes += trace.uploadedBytes ?? 0
    log({ at: started, ms: now() - started, endpoint: trace.endpoint, status: result.ok ? result.status : result.code,
      ...(trace.authorization ? { authorization: 'Bearer ***' as const } : {}),
      ...(trace.sent === undefined ? {} : { sent: trace.sent, uploadedBytes: trace.uploadedBytes ?? 0 }),
      ...(trace.images ? { images: trace.images } : {}) })
    return result
  }

  async function download(rawUrl: string, pick: FaultPick): Promise<SeedvisDevDownload> {
    return store.peek((s): SeedvisDevDownload => {
      if (auth(s.keyState)) return failure('bad-key')
      if (!s.config.online || fire(pick.outcome, 'offline')) return failure('offline')
      let url: URL
      try { url = new URL(rawUrl) } catch { return failure('not-allowed') }
      if (![SEEDVIS_DEV_CDN, foreignCDN].includes(url.origin) || url.username || url.password || url.hash) return failure('not-allowed')
      const job = s.jobs.find(j => url.pathname === `/${j.id}/0.mp4` && j.account === s.account && j.status === 'completed')
      const expiry = Number(url.searchParams.get('expires'))
      if (!job) return failure('unknown-output')
      if (!Number.isFinite(expiry) || expiry <= now() || (job.endAt! + s.config.retentionMs) <= now() || fire(pick.outcome, 'expired-link')) return failure('expired-link')
      if (!job.links.some(l => l.token === url.searchParams.get('signature') && l.expiresAt === expiry)) return failure('unknown-output')
      if (fire(pick.outcome, 'lost-response', 'response')) return failure('network')
      const oversize = !!fire(pick.outcome, 'oversize')
      const redirect = !!fire(pick.outcome, 'insecure-redirect')
      return { ok: true, bytes: job.video.slice(), total: oversize ? SEEDVIS_IPC_LIMITS.videoBytes + 1 : job.video.length,
        contentType: s.config.outputContentType, ...(redirect ? { redirect: `http://cdn.seedvis.invalid/${job.id}` } : {}) }
    })
  }

  return {
    now,
    async sessionStamp() {
      if (!devAllowed()) return null
      try { return await store.peek(s => s.keyState === 'verified' ? `${s.epoch}:${s.account}` : null) } catch { storageError(); return null }
    },
    request: (raw: unknown) => request(raw),
    /** Server-only fixture: the desktop gateway still requires an Idempotency-Key. */
    createWithoutKey: (req: Omit<SeedvisCreate, 'idempotencyKey'>) => request({ ...req, idempotencyKey: '00000000-0000-4000-8000-000000000000' }, true),
    async keyStatus(): Promise<SeedvisKeyStatus> {
      if (!devAllowed()) return { hasKey: false, hint: null, tag: null, savedAt: null, verifiedAt: null, storage: 'unavailable' }
      try { return await store.peek(statusOfKey) } catch { storageError(); return { hasKey: false, hint: null, tag: null, savedAt: null, verifiedAt: null, storage: 'unavailable', problem: 'unreadable' } }
    },
    /** Saves a sample key. `unchecked`: kept by "Lưu mà chưa kiểm tra" (the bridge decides when that is allowed) → verifiedAt null. */
    async setKey(raw: unknown, opts: { unchecked?: boolean } = {}): Promise<SeedvisKeyResult> {
      if (!devAllowed()) return locked()
      if (!isObj(raw) || Object.keys(raw).length !== 1 || typeof raw.key !== 'string') return failure('bad-key')
      const account = seedvisDevAccountOf(raw.key)
      if (!account) return failure('bad-key', SEEDVIS_DEV_SAMPLE_KEYS_ONLY)
      try {
        return await commit(s => {
          s.epoch = crypto.randomUUID(); s.account = account; s.keyState = 'verified'; s.savedAt = now()
          if (opts.unchecked === true) s.keyUnchecked = true
          else delete s.keyUnchecked
          return { ok: true as const, status: statusOfKey(s) }
        })
      } catch { return storageError() }
    },
    async clearKey(): Promise<SeedvisKeyResult> {
      if (!devAllowed()) return locked()
      try { return await commit(s => { s.epoch = crypto.randomUUID(); s.keyState = 'none'; return { ok: true as const, status: statusOfKey(s) } }) } catch { return storageError() }
    },
    async configure(patch: Partial<SeedvisDevConfig>) {
      if (!devAllowed()) return locked()
      // The queue up to now ran under the old settings: new streams / tempo never act in the past.
      try { return await commit(s => { advance(s, now()); s.config = seedvisConfig({ ...s.config, ...patch }); return { ok: true as const } }) } catch { return storageError() }
    },
    async setKeyState(keyState: SeedvisDevKeyState) {
      if (!devAllowed()) return locked()
      if (!['verified', 'none', 'revoked', 'forbidden', 'unreadable'].includes(keyState)) return failure('bad-request')
      try { return await commit(s => { s.epoch = crypto.randomUUID(); s.keyState = keyState; return { ok: true as const } }) } catch { return storageError() }
    },
    async setBalance(balance: number) {
      if (!devAllowed()) return locked()
      if (!Number.isFinite(balance) || balance < 0) return failure('bad-request')
      try { return await commit(s => { s.balances[s.account] = balance; return { ok: true as const } }) } catch { return storageError() }
    },
    /** A released job waits for a free stream from now on, behind the jobs that were already due. */
    async releaseHeld(id: string) {
      if (!devAllowed()) return locked()
      try {
        return await commit(s => {
          const t = now()
          advance(s, t)
          const job = s.jobs.find(j => j.id === id)
          if (job?.status === 'queued') { job.held = false; job.readyAt = Math.max(job.readyAt, t) }
          return { ok: true as const }
        })
      } catch { return storageError() }
    },
    faults(): SeedvisFaultRule[] { return devAllowed() ? structuredClone(rules) : [] },
    /** Refuses a fault the saved state could not hold (NaN / Infinity times, over-long codes) or one that can never act on its endpoint. */
    addFault(input: SeedvisFaultInput): SeedvisFaultResult {
      if (!devAllowed()) return locked()
      const clean = cleanSeedvisFault(input)
      if (!clean) return failure('bad-request', 'Lỗi giả lập seedvis không hợp lệ.')
      const rule: SeedvisFaultRule = { ...clean.rule, id: `sv-f${++seq}`, hits: 0 }
      rules = [...rules, rule]
      notify()
      return { ok: true, rule: structuredClone(rule) }
    },
    removeFault(id: string) { if (!devAllowed()) return; rules = rules.filter(r => r.id !== id); notify() },
    clearFaults() { if (!devAllowed()) return; rules = []; notify() },
    /** Called (asynchronously) after every change: state, faults, request log. Returns unsubscribe. */
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async snapshot() {
      if (!devAllowed()) return null
      try {
        const state = await commit(s => { const t = now(); advance(s, t); compact(s); return s })
        return { ...state, faults: structuredClone(rules), logs: structuredClone(logs), uploadedBytes, persistProblem }
      } catch { storageError(); return { persistProblem } }
    },
    async isOnline() {
      if (!devAllowed()) return false
      try { return (await store.peek(s => s.config.online)) && !rules.some(r => r.sticky && r.fault.kind === 'offline' && r.endpoint === '*') } catch { return false }
    },
    async reset() {
      if (!devAllowed()) return locked()
      try { await store.reset(); rules = []; logs.length = 0; uploadedBytes = 0; persistProblem = null; notify(); return { ok: true as const } } catch { return storageError() }
    },
    async download(rawUrl: string, headers: Record<string, string> = {}): Promise<SeedvisDevDownload> {
      if (!devAllowed()) return locked()
      if (Object.keys(headers).some(k => ['authorization', 'x-api-key', 'x-goog-api-key', 'cookie'].includes(k.toLowerCase()))) return failure('not-allowed', 'Không gửi thông tin xác thực tới CDN giả lập.')
      const started = now()
      let host: string | undefined
      try { host = new URL(rawUrl).hostname } catch { host = undefined }
      const result = await download(rawUrl, pickFaults('download')).catch(() => storageError())
      log({ at: started, ms: now() - started, endpoint: 'download', status: result.ok ? 200 : result.code, ...(host ? { host } : {}) })
      return result
    },
  }
}

export type DevSeedvis = ReturnType<typeof createDevSeedvis>
