// Test fakes for the seedvis adapter (not a test file). No network: a fake clock, a fake seedvis server state machine
// behind a fake SeedvisBridge (idempotency store with a key memory measured from the arrival of the last byte, an
// upload model with bandwidth and main's `mustFinishBy` abort, scripted faults), fake words and a fake `prepare`.
// The full simulation is track A-SIM (providers/dev/seedvis); TODO(integration): seedvis-dev-e2e runs the adapter on it.
import type {
  SeedvisBridge,
  SeedvisBridgeErrorCode,
  SeedvisBridgeFailure,
  SeedvisGenerationBody,
  SeedvisKeyStatus,
  SeedvisRequest,
  SeedvisRequestImage,
  SeedvisResponse,
  SeedvisResponseHeaders,
} from '../contract'
import type { SeedvisAdapterWords, SeedvisPrepared, SeedvisPrepareInput } from '../adapter'
import type { SeedvisJobRequest } from '../contractExt'
import { SEEDVIS_ROUTE_TABLE } from '../contract'

export function fakeClock(start = 1_800_000_000_000) {
  let t = start
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += Math.max(0, ms)
    },
    advance: (ms: number) => {
      t += ms
    },
    set: (v: number) => {
      t = v
    },
  }
}
export type FakeClock = ReturnType<typeof fakeClock>

/** What the fake server does with one create attempt. */
export type CreateFault =
  /** stored (or replayed), answered 202 queued (200 + Idempotency-Replayed when replayed) */
  | 'ok'
  /** stored (or replayed), the answer is lost after the last byte: timeout, sent:true */
  | 'lost-after-store'
  /** the whole body was sent, seedvis never processed it: timeout, sent:true */
  | 'lost-before-store'
  /** the upload stalls: sent:false after 60 s */
  | 'stall'
  /** the IPC call rejects after the job was stored (unknown outcome) */
  | 'ipc-reject'
  /** an explicit HTTP answer after the upload; `store`: the job is created (and the default body is its JSON) */
  | { status: number; json?: unknown; headers?: SeedvisResponseHeaders; store?: boolean; jobStatus?: FakeJob['status']; errorCode?: string }
  /** a bridge failure; `sent: true` = after the upload (`store` whether seedvis kept it), else before any byte */
  | { fail: SeedvisBridgeErrorCode; sent?: boolean; store?: boolean; retryAfterMs?: number; message?: string }

export type HttpAnswer = { status: number; json?: unknown; headers?: SeedvisResponseHeaders } | { fail: SeedvisBridgeErrorCode; sent?: boolean; message?: string }

export interface FakeJob {
  id: string
  key: string
  hash: string
  storedAt: number
  status: 'queued' | 'processing' | 'completed' | 'failed'
  errorCode?: string
  outputs: number
  polls: number
  references?: { field: string; index: number; role: string | null; source?: string; url?: string }[]
}

export interface CallLog {
  route: SeedvisRequest['route'] | 'downloadOpen' | 'downloadRead' | 'downloadClose' | 'keyStatus' | 'isOnline'
  at: number
  key?: string
  id?: string
  mustFinishBy?: number
  attempt?: number
  bytes?: number
}

/** Size of a create body on the wire (JSON + base64 images + names), like main builds it. */
export function wireBytes(body: unknown, images: readonly SeedvisRequestImage[] | undefined): number {
  return JSON.stringify(body).length + (images ?? []).reduce((n, i) => n + 4 * Math.ceil(i.bytes.length / 3) + 64, 0)
}

function serverHash(body: unknown, images: readonly SeedvisRequestImage[] | undefined): string {
  let h = 0x811c9dc5
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  }
  feed(JSON.stringify(body))
  for (const img of images ?? []) {
    feed(`${img.field}|${img.index}|${img.mime}|${img.bytes.length}|`)
    for (let i = 0; i < img.bytes.length; i += 97) h = Math.imul(h ^ img.bytes[i], 0x01000193)
  }
  return (h >>> 0).toString(16)
}

export interface FakeSeedvisOptions {
  clock: FakeClock
  /** How long the fake seedvis remembers a key, from the arrival of the body's last byte (default 120 s). */
  keyMemoryMs?: number
  /** Upload rate in bytes / s, per attempt of the key (1-based). Default 10 MB/s. */
  bandwidthBps?: number | ((attempt: number) => number)
  /** Main's wait for the answer after the last byte (default 45 s). */
  answerWaitMs?: number
  /** Main's upload stall timeout (default 60 s). */
  stallMs?: number
  keyStatus?: SeedvisKeyStatus | null
  /** Each poll moves queued → processing → completed (default true). */
  autoAdvance?: boolean
  videoBytes?: number
  chunkBytes?: number
}

export const OK_KEY: SeedvisKeyStatus = { hasKey: true, hint: 'AB12', tag: 'aaaaaaaaaaaa', savedAt: 1, verifiedAt: 1, storage: 'safeStorage' }
export const OTHER_KEY: SeedvisKeyStatus = { hasKey: true, hint: 'ZZ99', tag: 'bbbbbbbbbbbb', savedAt: 2, verifiedAt: 2, storage: 'safeStorage' }

export function createFakeSeedvis(opts: FakeSeedvisOptions) {
  const clock = opts.clock
  const memory = opts.keyMemoryMs ?? 120_000
  const answerWait = opts.answerWaitMs ?? 45_000
  const stallMs = opts.stallMs ?? 60_000
  const bw = (attempt: number) => (typeof opts.bandwidthBps === 'function' ? opts.bandwidthBps(attempt) : (opts.bandwidthBps ?? 10_000_000))
  let seq = 0
  let dl = 0
  const state = {
    jobs: new Map<string, FakeJob>(),
    keys: new Map<string, { storedAt: number; hash: string; jobId: string }>(),
    jobsPerKey: new Map<string, number>(),
    attemptsPerKey: new Map<string, number>(),
    createFaults: [] as CreateFault[],
    getScript: new Map<string, HttpAnswer[]>(),
    getFallback: null as ((id: string) => HttpAnswer | null) | null,
    cancelScript: [] as HttpAnswer[],
    modelsAnswer: { status: 200, json: { data: [] } } as HttpAnswer,
    accountAnswer: { status: 200, json: { data: { plan: 'pro', api_enabled: true, credit_balance: 120.5, concurrency_limit: 4 } } } as HttpAnswer,
    calls: [] as CallLog[],
    keyStatus: (opts.keyStatus === undefined ? OK_KEY : opts.keyStatus) as SeedvisKeyStatus | null,
    online: (() => true) as () => boolean,
    autoAdvance: opts.autoAdvance ?? true,
    expiredOpens: 0,
    unknownOutputOpens: 0,
    openFailure: null as SeedvisBridgeFailure | null,
    readFailure: null as { failure: SeedvisBridgeFailure; afterBytes: number } | null,
    videoBytes: opts.videoBytes ?? 10_000,
    downloads: new Map<string, { data: Uint8Array; pos: number }>(),
    closed: [] as string[],
  }

  const failure = (code: SeedvisBridgeErrorCode, extra: Partial<SeedvisBridgeFailure> = {}): SeedvisBridgeFailure => ({ ok: false, code, message: 'Lỗi giả lập.', ...extra })
  const answer = (a: HttpAnswer): SeedvisResponse => ('fail' in a ? failure(a.fail, { ...(a.sent !== undefined ? { sent: a.sent } : {}), ...(a.message ? { message: a.message } : {}) }) : { ok: true, status: a.status, json: a.json, headers: a.headers ?? {} })

  function genJson(job: FakeJob) {
    return {
      data: {
        id: job.id,
        status: job.status,
        is_final: job.status === 'completed' || job.status === 'failed',
        ...(job.status === 'queued' ? { queue: { position: 2, estimated_start_seconds: 60 } } : {}),
        next: { after_seconds: 20, url: `https://seedvis.com/api/v1/developer/generations/${job.id}` },
        outputs: job.status === 'completed' ? Array.from({ length: job.outputs }, (_, i) => ({ url: `https://cdn.seedvis.com/${job.id}/${i}.mp4?sig=SECRETSIG` })) : [],
        ...(job.references ? { references: job.references } : {}),
        ...(job.errorCode ? { error: { code: job.errorCode, message: `Lỗi ${job.errorCode}` } } : {}),
      },
    }
  }

  /** The server side of a complete body arriving at `at`: replay within the key memory, else a new (paid) job. */
  function store(key: string, hash: string, at: number, status: FakeJob['status'] = 'queued', errorCode?: string): { job: FakeJob; replayed: boolean } | { conflict: true } {
    const prev = state.keys.get(key)
    if (prev && at - prev.storedAt <= memory) {
      if (prev.hash !== hash) return { conflict: true }
      return { job: state.jobs.get(prev.jobId)!, replayed: true }
    }
    state.jobsPerKey.set(key, (state.jobsPerKey.get(key) ?? 0) + 1)
    const job: FakeJob = { id: `gen_${++seq}`, key, hash, storedAt: at, status, outputs: 1, polls: 0, ...(errorCode ? { errorCode } : {}) }
    state.jobs.set(job.id, job)
    state.keys.set(key, { storedAt: at, hash, jobId: job.id })
    return { job, replayed: false }
  }

  async function create(args: Extract<SeedvisRequest, { route: 'generations.create' }>): Promise<SeedvisResponse> {
    const key = args.idempotencyKey
    const attempt = (state.attemptsPerKey.get(key) ?? 0) + 1
    state.attemptsPerKey.set(key, attempt)
    const fault = state.createFaults.shift() ?? 'ok'
    const bytes = wireBytes(args.body, args.images)
    state.calls.push({ route: 'generations.create', at: clock.now(), key, mustFinishBy: args.mustFinishBy, attempt, bytes })
    const hash = serverHash(args.body, args.images)
    if (typeof fault === 'object' && 'fail' in fault && fault.sent !== true) {
      return failure(fault.fail, { ...(fault.sent === false ? { sent: false } : {}), ...(fault.retryAfterMs ? { retryAfterMs: fault.retryAfterMs } : {}), ...(fault.message ? { message: fault.message } : {}) })
    }
    const start = clock.now()
    if (fault === 'stall') {
      clock.advance(stallMs)
      return failure('timeout', { sent: false, lastByteAt: null })
    }
    const uploadMs = Math.ceil((bytes / bw(attempt)) * 1000)
    if (args.mustFinishBy !== undefined && start + uploadMs > args.mustFinishBy) {
      // main aborts the upload before its last byte: seedvis never processes a partial body
      clock.set(Math.max(start, args.mustFinishBy))
      return failure('deadline', { sent: false, lastByteAt: null })
    }
    clock.advance(uploadMs)
    const lastByteAt = clock.now()
    const ok = (status: number, json: unknown, headers: SeedvisResponseHeaders = {}): SeedvisResponse => ({ ok: true, status, json, headers, lastByteAt, uploadMs })
    const storeAnswer = (s: ReturnType<typeof store>): SeedvisResponse =>
      'conflict' in s
        ? ok(409, { error: { code: 'idempotency_conflict', message: 'Idempotency key reused with a different body' } })
        : s.replayed
          ? ok(200, genJson(s.job), { 'Idempotency-Replayed': 'true', 'X-Request-Id': `req_${attempt}` })
          : ok(202, genJson(s.job), { 'X-Request-Id': `req_${attempt}` })
    if (fault === 'ok') return storeAnswer(store(key, hash, lastByteAt))
    if (fault === 'lost-after-store' || fault === 'ipc-reject') {
      store(key, hash, lastByteAt)
      clock.advance(answerWait)
      if (fault === 'ipc-reject') throw new Error('IPC closed')
      return failure('timeout', { sent: true, lastByteAt })
    }
    if (fault === 'lost-before-store') {
      clock.advance(answerWait)
      return failure('timeout', { sent: true, lastByteAt })
    }
    if ('fail' in fault) {
      if (fault.store) store(key, hash, lastByteAt)
      clock.advance(answerWait)
      return failure(fault.fail, { sent: true, lastByteAt })
    }
    if (fault.store) {
      const s = store(key, hash, lastByteAt, fault.jobStatus, fault.errorCode)
      if (fault.json === undefined && !('conflict' in s)) return ok(fault.status, genJson(s.job), fault.headers)
    }
    return ok(fault.status, fault.json, fault.headers)
  }

  function get(id: string): SeedvisResponse {
    const script = state.getScript.get(id)
    if (script?.length) return answer(script.shift()!)
    const fb = state.getFallback?.(id)
    if (fb) return answer(fb)
    const job = state.jobs.get(id)
    if (!job) return { ok: true, status: 404, json: { error: { code: 'generation_not_found', message: 'Generation not found' } }, headers: {} }
    job.polls++
    const res: SeedvisResponse = { ok: true, status: 200, json: genJson(job), headers: {} }
    if (state.autoAdvance) {
      if (job.status === 'queued') job.status = 'processing'
      else if (job.status === 'processing') job.status = 'completed'
    }
    return res
  }

  function cancel(id: string): SeedvisResponse {
    if (state.cancelScript.length) return answer(state.cancelScript.shift()!)
    const job = state.jobs.get(id)
    if (!job) return { ok: true, status: 404, json: { error: { code: 'generation_not_found' } }, headers: {} }
    if (job.status === 'queued') {
      job.status = 'failed'
      job.errorCode = 'cancelled'
      return { ok: true, status: 200, json: { data: { id, status: 'failed', error: { code: 'cancelled' }, cancellation: { outcome: 'refunded', running_outputs: 0 } } }, headers: {} }
    }
    return { ok: true, status: 409, json: { error: { code: 'not_cancellable', message: 'Job is already running' } }, headers: {} }
  }

  const bridge: SeedvisBridge = {
    keyStatus: async () => {
      state.calls.push({ route: 'keyStatus', at: clock.now() })
      if (!state.keyStatus) throw new Error('no key status')
      return { ...state.keyStatus }
    },
    pasteKey: async () => failure('not-allowed'),
    setKey: async () => failure('not-allowed'),
    clearKey: async () => failure('not-allowed'),
    request: async (args) => {
      if (args.route === 'generations.create') return create(args)
      state.calls.push({ route: args.route, at: clock.now(), ...('id' in args ? { id: args.id } : {}) })
      if (args.route === 'generations.get') return get(args.id)
      if (args.route === 'generations.cancel') return cancel(args.id)
      if (args.route === 'models') return answer(state.modelsAnswer)
      if (args.route === 'account.info') return answer(state.accountAnswer)
      return { ok: true, status: 200, json: { data: {} }, headers: {} }
    },
    downloadOpen: async ({ generationId, index }) => {
      state.calls.push({ route: 'downloadOpen', at: clock.now(), id: generationId })
      if (state.openFailure) return state.openFailure
      const job = state.jobs.get(generationId)
      if (!job || job.status !== 'completed' || index >= job.outputs) return failure('unknown-output')
      if (state.expiredOpens > 0) {
        state.expiredOpens--
        return failure('expired-link')
      }
      if (state.unknownOutputOpens > 0) {
        state.unknownOutputOpens--
        return failure('unknown-output')
      }
      const id = `dl_${++dl}`
      const data = new Uint8Array(state.videoBytes)
      for (let i = 0; i < data.length; i++) data[i] = i % 251
      state.downloads.set(id, { data, pos: 0 })
      return { ok: true, id, total: data.length, mime: 'video/mp4' }
    },
    downloadRead: async ({ id }) => {
      state.calls.push({ route: 'downloadRead', at: clock.now(), id })
      const d = state.downloads.get(id)
      if (!d) return failure('gone')
      if (state.readFailure && d.pos >= state.readFailure.afterBytes) return state.readFailure.failure
      if (d.pos >= d.data.length) return { ok: true, done: true }
      const end = Math.min(d.data.length, d.pos + (opts.chunkBytes ?? 4096))
      const bytes = d.data.slice(d.pos, end)
      d.pos = end
      return { ok: true, done: false, bytes }
    },
    downloadClose: async ({ id }) => {
      state.calls.push({ route: 'downloadClose', at: clock.now(), id })
      state.closed.push(id)
      state.downloads.delete(id)
      return { ok: true }
    },
    isOnline: async () => {
      state.calls.push({ route: 'isOnline', at: clock.now() })
      return state.online()
    },
    openBilling: async () => ({ ok: true }),
  }

  return {
    bridge,
    state,
    creates: () => state.calls.filter((c) => c.route === 'generations.create'),
    gets: () => state.calls.filter((c) => c.route === 'generations.get'),
    /** Jobs beyond the first created for one key: each one is a second charge. Must always be 0. */
    duplicates: () => [...state.jobsPerKey.values()].reduce((n, c) => n + Math.max(0, c - 1), 0),
    jobOf: (key: string) => {
      const k = state.keys.get(key)
      return k ? state.jobs.get(k.jobId) ?? null : null
    },
  }
}
export type FakeSeedvis = ReturnType<typeof createFakeSeedvis>

export const UNKNOWN_TEXT = 'Không rõ yêu cầu đã tới seedvis chưa (có thể đã bị trừ credit).'
export const UNVERIFIABLE_TEXT = 'Không kiểm tra được lần gửi trước của take này nữa — seedvis có thể đã nhận và trừ credit.'

/** Fake words: short, recognisable texts (the real ones come from wording.ts, track A-MAP). */
export const fakeWords: SeedvisAdapterWords = {
  webUnavailable: 'W:web',
  noKey: 'W:no-key',
  keyUnreadable: 'W:key-unreadable',
  badKey: 'W:bad-key',
  wrongRoute: (m, mode) => `W:wrong-route ${m} ${mode}`,
  ledgerNotSaved: 'W:ledger-not-saved',
  cancelledBeforeSend: 'W:cancelled',
  prepareFailed: (why) => `W:prepare-failed ${why}`,
  notSentUpload: 'W:not-sent-upload',
  notSentLocal: (m) => `W:not-sent-local ${m}`,
  deferredBusy: 'W:deferred',
  unknownSubmit: UNKNOWN_TEXT,
  unverifiableSubmit: UNVERIFIABLE_TEXT,
  refused: (e) => ({ text: `W:refused ${e.status} ${e.code ?? '-'}${e.field ? ` ${e.field}` : ''}`, ...(e.message ? { detail: e.message } : {}) }),
  detail: {
    lostAnswer: 'D:lost',
    resending: 'D:resending',
    gateDisabled: 'D:gate-disabled',
    gateExpired: 'D:gate-expired',
    clockChanged: 'D:clock',
    deadline: 'D:deadline',
    bodyChanged: 'D:body-changed',
    noRecord: 'D:no-record',
    conflict: 'D:conflict',
    serverAfterSend: (s) => `D:server ${s}`,
    refusedAfterSend: (s, c) => `D:refused-after ${s} ${c ?? '-'}`,
    cancelledWhileResending: 'D:cancelled-resending',
    ledgerNotSavedResend: 'D:ledger-resend',
    prepareFailedResend: (why) => `D:prepare-resend ${why}`,
  },
  poll: {
    queued: (p, s) => `P:queued ${p ?? '-'} ${s ?? '-'}`,
    notFoundWaiting: 'P:not-found-waiting',
    notFoundFinal: (id8) => `P:not-found ${id8}`,
    held: (hint) => `P:held …${hint}`,
    failed: (c, m) => `P:failed ${c ?? '-'} ${m ?? '-'}`,
    notStarted: 'P:not-started',
    cancelledRefunded: 'P:cancelled-refunded',
    badRemoteId: 'P:bad-id',
    echoShort: (r, s) => `P:echo ${r}/${s}`,
  },
  fetch: {
    noOutput: 'F:no-output',
    expired: 'F:expired',
    offline: 'F:offline',
    tooLarge: 'F:too-large',
    failed: (why) => `F:failed ${why}`,
    aborted: 'F:aborted',
    notReady: 'F:not-ready',
  },
}

/** A seedvis job request (Seedance 2.5 · seedvis, text only by default). */
export function seedvisReq(over: Partial<SeedvisJobRequest> = {}): SeedvisJobRequest {
  return {
    key: 'take-1',
    takeId: 'take-1',
    sceneId: 'scene-1',
    sanovidsProjectId: 'project-1',
    sceneCode: 'S01',
    takeNumber: 1,
    title: 'Cảnh 1',
    color: '#e8894a',
    model: 'seedvis/seedance_2.5',
    mode: 't2v',
    duration: 5,
    resolution: 'auto',
    ratio: '16:9',
    prompt: 'Một chú mèo đi dạo @image_1',
    rawPrompt: 'Một chú mèo đi dạo @image_1',
    images: [],
    firstFrame: null,
    lastFrame: null,
    startedAt: 0,
    ...over,
  }
}

/**
 * A fake `prepare` (the real one is mapping.toGenerationBody + prepareImages, track A-MAP): Seedance / Veo bodies with
 * the image bytes of `blobs` (imageId → size in bytes, filled deterministically). Records its calls.
 */
export function fakePrepare(blobs: Record<string, number> = {}) {
  const calls: { req: SeedvisJobRequest; input: SeedvisPrepareInput }[] = []
  const bytesOf = (id: string) => {
    const n = blobs[id] ?? 1000
    const b = new Uint8Array(n)
    for (let i = 0; i < n; i++) b[i] = (i * 7 + id.length) % 256
    return b
  }
  let failWith: Error | null = null
  const prepare = async (req: SeedvisJobRequest, input: SeedvisPrepareInput): Promise<SeedvisPrepared> => {
    calls.push({ req, input })
    if (failWith) throw failWith
    const route = SEEDVIS_ROUTE_TABLE[req.model as keyof typeof SEEDVIS_ROUTE_TABLE]
    const images: SeedvisRequestImage[] = req.images.map((img, i) => ({ field: 'reference_images', index: i, mime: 'image/png', bytes: bytesOf(img.imageId) }))
    const body = (
      route.family === 'veo'
        ? { model: 'Veo-3.1', mode: 'text-to-video', prompt: req.prompt.trim(), aspect_ratio: req.ratio, duration: `${req.duration}s`, upscale_video: 'none', count: 1 }
        : { model: route.remoteModel, mode: images.length ? 'image-to-video' : 'text-to-video', prompt: req.prompt.trim(), aspect_ratio: req.ratio, duration: req.duration, count: 1 }
    ) as SeedvisGenerationBody
    return { body, images, pinIds: req.images.map((i) => i.imageId), prepIds: [] }
  }
  return {
    prepare,
    calls,
    fail: (e: Error | null) => {
      failWith = e
    },
  }
}

/** Images of a request: n images of the given byte size each. */
export function images(n: number, prefix = 'img'): SeedvisJobRequest['images'] {
  return Array.from({ length: n }, (_, i) => ({ n: i + 1, assetId: `asset-${i + 1}`, imageId: `${prefix}-${i + 1}` }))
}
