import { SEEDVIS_MODEL_IDS } from '../../../core/services'
import { SEEDVIS_ROUTE_TABLE } from '../../../core/seedvisRoutes'
import { devAllowed } from '../../devAccess'
import type { SeedvisKeyStatus, SeedvisKeyResult, SeedvisResponse, SeedvisResponseHeaders, SeedvisRequest, SeedvisBridgeFailure } from '../../seedvis/contract'
import { SEEDVIS_IPC_LIMITS } from '../../seedvis/contract'
import type { SeedvisDevFault, SeedvisFaultEndpoint, SeedvisFaultInput, SeedvisFaultRule } from './faults'
import {
  indexedSeedvisStore, memorySeedvisStore, seedvisConfig, SEEDVIS_DEV_KEYS,
  type SeedvisStateStore, type SeedvisDevState, type SeedvisDevJob, type SeedvisDevConfig, type SeedvisDevAccount, type SeedvisDevKeyState,
} from './state'
import { failure, isObj, seedvisBodyHash, seedvisRequestProblem, seedvisUploadBytes, type SeedvisCreate } from './validate'
import { renderSeedvisVideo } from './render'

export const SEEDVIS_DEV_LOCKED = 'Chỉ dùng seedvis giả lập khi chế độ Phát triển đang mở.'
export const SEEDVIS_DEV_CDN = 'https://cdn.seedvis.invalid'
const foreignCDN = 'https://media.example.invalid'
const ok = (json: unknown, status = 200, headers: SeedvisResponseHeaders = {}): SeedvisResponse => ({ ok: true, status, json, headers })

/** API errors are intentionally different from local gateway failures. */
export function seedvisError(status: number, code: string, format: 'native' | 'openai' | 'google' = 'native', field = 'prompt', retryAfterSeconds?: number): SeedvisResponse {
  const message = `Lỗi seedvis giả lập: ${code}`
  const json = format === 'google' ? { error: { code: status, status: code, message } }
    : format === 'openai' ? { error: { code, message, param: field, type: 'invalid_request_error' } }
      : { error: { code, message }, errors: { [field]: [message] } }
  return ok(json, status, retryAfterSeconds === undefined ? {} : { 'Retry-After': String(retryAfterSeconds) })
}

export interface SeedvisDevLog {
  at: number
  endpoint: SeedvisFaultEndpoint
  status: number | string
  authorization?: 'Bearer ***'
  images?: string[]
  host?: string
}
export interface SeedvisDevDeps { store?: SeedvisStateStore; now?: () => number; sleep?: (ms: number) => Promise<void> }
export type SeedvisDevDownload = { ok: true; bytes: Uint8Array; total: number; contentType: string; redirect?: string } | SeedvisBridgeFailure

function auth(state: SeedvisDevState): SeedvisResponse | null {
  if (state.keyState === 'none') return failure('no-key', 'Chưa có khoá giả lập seedvis.')
  if (state.keyState === 'unreadable') return failure('key-unreadable', 'Không đọc được khoá giả lập seedvis.')
  if (state.keyState === 'revoked') return seedvisError(401, 'invalid_api_key')
  if (state.keyState === 'forbidden') return seedvisError(403, 'api_disabled')
  return null
}

function statusOfKey(s: SeedvisDevState): SeedvisKeyStatus {
  return { hasKey: s.keyState !== 'none', hint: s.keyState === 'none' ? null : s.account,
    tag: s.keyState === 'none' ? null : `dev-seedvis:${s.account}`, savedAt: s.keyState === 'none' ? null : s.savedAt,
    verifiedAt: s.keyState === 'verified' ? s.savedAt : null, storage: 'safeStorage',
    ...(s.keyState === 'unreadable' ? { problem: 'unreadable' as const } : {}) }
}

function refund(s: SeedvisDevState, job: SeedvisDevJob) {
  if (job.refunded) return
  s.balances[job.account] += job.cost
  job.refunded = true
}

/** Reconstruct elapsed queue time, even after a long offline gap; no background timer needed. */
function advance(s: SeedvisDevState, now: number) {
  for (const account of ['A001', 'B002'] as const) {
    const slots = Array<number>(s.config.concurrency).fill(0)
    for (const job of s.jobs.filter(j => j.account === account).sort((a, b) => a.createdAt - b.createdAt)) {
      if (job.startAt !== null) {
        const slot = slots.indexOf(Math.min(...slots))
        slots[slot] = Math.max(slots[slot], job.endAt!)
      } else if (job.status === 'queued') {
        const slot = slots.indexOf(Math.min(...slots))
        const start = job.held ? Infinity : Math.max(job.readyAt, slots[slot])
        if (job.notStartedAt !== null && job.notStartedAt <= now && job.notStartedAt <= start) {
          job.status = 'failed'; job.code = 'not_started'; refund(s, job)
        } else if (start <= now) {
          job.startAt = start; job.endAt = start + job.processingMs; job.status = 'processing'
          slots[slot] = job.endAt
        }
      }
      if (job.status === 'processing' && job.endAt! <= now) {
        job.status = job.failCode ? 'failed' : 'completed'
        job.code = job.failCode
        if (job.code === 'not_started' || job.code === 'insufficient_credits') refund(s, job)
      }
    }
  }
  s.memory = s.memory.filter(m => m.expiresAt > now)
}

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
  return {
    id: j.id, status: j.status, is_final: final, model: j.body.model, mode: j.body.mode,
    ...(j.status === 'queued' ? { queue: { position: s.jobs.filter(k => k.account === j.account && k.status === 'queued' && k.createdAt <= j.createdAt).length, estimated_start_seconds: Math.max(1, Math.ceil((j.readyAt - now) / 1000)) } } : {}),
    ...(!final ? { next: { after_seconds: 15, url: `/api/v1/developer/generations/${j.id}?wait=0` } } : {}),
    references: refs.map(r => ({ ...r, role: r.field === 'lastFrame' ? 'end' : r.field === 'image' || (r.field === 'reference_images' && r.index === 0) ? 'start' : null, source: 'inline', url: `${SEEDVIS_DEV_CDN}/reference/${j.id}/${r.field}/${r.index}` })),
    outputs: j.status === 'completed' && !j.emptyOutputs ? [{ index: 0, type: 'video', url, expires_at: new Date(expires).toISOString() }] : [],
    ...(j.code ? { error: { code: j.code, message: `Kết quả seedvis giả lập: ${j.code}` } } : {}),
  }
}

export function createDevSeedvis(deps: SeedvisDevDeps = {}) {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const store = deps.store ?? (typeof indexedDB === 'undefined' ? memorySeedvisStore() : indexedSeedvisStore())
  let rules: SeedvisFaultRule[] = []
  let seq = 0
  let persistProblem: string | null = null
  const logs: SeedvisDevLog[] = []
  const locked = () => failure('not-allowed', SEEDVIS_DEV_LOCKED)
  const storageError = () => {
    persistProblem = 'Không lưu hoặc đọc được dữ liệu seedvis giả lập.'
    return failure('storage-failed', persistProblem)
  }
  async function change<T>(fn: (s: SeedvisDevState) => T): Promise<T> {
    const result = await store.change(fn)
    persistProblem = null
    return result
  }
  function log(entry: SeedvisDevLog) { logs.push(entry); if (logs.length > 300) logs.shift() }
  function takeFaults(endpoint: SeedvisFaultEndpoint): SeedvisDevFault[] {
    const fired: SeedvisDevFault[] = []
    const modifier = (r: SeedvisFaultRule) => ['slow-upload', 'hold', 'not-started', 'poll-404', 'fail-job', 'empty-outputs', 'short-echo'].includes(r.fault.kind)
    // Match canvasapp: all modifiers, but only one outcome. Queued one-shot outcomes run in order.
    const outcome = rules.find(r => r.endpoint === endpoint && !modifier(r)) ?? rules.find(r => r.endpoint === '*' && !modifier(r))
    rules = rules.filter(r => {
      if ((r.endpoint === '*' || r.endpoint === endpoint) && (modifier(r) || r === outcome)) {
        fired.push(structuredClone(r.fault))
        if (!r.sticky) r.remaining--
      }
      return r.sticky || r.remaining > 0
    })
    return fired
  }

  async function request(raw: unknown, withoutKey = false): Promise<SeedvisResponse> {
    if (!devAllowed()) return locked()
    const problem = seedvisRequestProblem(raw)
    if (problem) return problem
    // Capture bytes before the first await; renderer changes cannot alter an in-flight request.
    const req = structuredClone(raw) as SeedvisRequest
    const started = now()
    try {
      const before = await change(s => s)
      const authProblem = auth(before)
      if (authProblem) return authProblem
      const faults = takeFaults(req.route)
      if (!before.config.online || faults.some(f => f.kind === 'offline')) return { ...failure('offline', 'Seedvis giả lập đang mất mạng.'), sent: false }
      let lastByteAt: number | undefined
      let uploadMs: number | undefined
      let hash = ''
      if (req.route === 'generations.create') {
        hash = await seedvisBodyHash(req)
        const speedFault = faults.find(f => f.kind === 'slow-upload')
        const bps = speedFault?.kind === 'slow-upload' ? Math.max(1, speedFault.bytesPerSecond) : before.config.uploadBytesPerSecond
        uploadMs = Math.ceil(seedvisUploadBytes(req) * 1000 / bps)
        const uploadStart = now()
        if (req.mustFinishBy !== undefined && uploadStart + uploadMs > req.mustFinishBy) {
          await sleep(Math.max(0, req.mustFinishBy - uploadStart))
          return { ...failure('deadline', 'Đã dừng tải ảnh trước hạn; chưa gửi trọn yêu cầu.'), sent: false, lastByteAt: null }
        }
        await sleep(uploadMs)
        if (req.mustFinishBy !== undefined && now() > req.mustFinishBy) return { ...failure('deadline'), sent: false, lastByteAt: null }
        lastByteAt = now()
        uploadMs = lastByteAt - uploadStart
      }
      if (!devAllowed()) return { ...locked(), sent: false }
      const result = await change(s => {
        if (s.epoch !== before.epoch || s.account !== before.account) return { ...failure('no-key', 'Tài khoản giả lập đã thay đổi; chưa gửi yêu cầu.'), sent: false }
        if (!s.config.online) return { ...failure('offline'), sent: false }
        if (faults.some(f => f.kind === 'revoke-key')) s.keyState = 'revoked'
        const a = auth(s)
        if (a) return a
        advance(s, now())
        const responseFault = faults.find(f => f.kind === 'response')
        const error = responseFault?.kind === 'response' ? seedvisError(responseFault.status, responseFault.code, responseFault.format, responseFault.field, responseFault.retryAfterSeconds) : null
        if (error && responseFault?.kind === 'response' && !responseFault.afterProcessing) return error
        if (faults.some(f => f.kind === 'html-404')) return ok(undefined, 404)
        if (faults.some(f => f.kind === 'not-found')) return seedvisError(404, 'generation_not_found')
        let answer: SeedvisResponse
        if (req.route === 'models') {
          answer = ok({ data: SEEDVIS_MODEL_IDS.map(id => {
            const spec = SEEDVIS_ROUTE_TABLE[id]
            return { id: spec.remoteModel, type: 'video', modes: spec.requests.map(m => s.config.modesShape === 'strings' ? m.remoteMode : { id: m.remoteMode, available: true }),
              durations: [...spec.durations], aspect_ratios: [...spec.ratios], available: true, simulated: true }
          }) })
        } else if (req.route === 'account.info') {
          answer = ok({ data: { plan: 'Giả lập', api_enabled: true, credit_balance: s.balances[s.account], concurrency_limit: s.config.concurrency, queue_limit: s.config.queueLimit,
            rate_limit_per_minute: 30, poll_rate_limit_per_minute: 384, poll_rate_limit_per_job_per_minute: 20,
            simulated: true, credit_label: 'credit dev seedvis', retention_days: s.config.retentionMs / 86_400_000, price_per_video: s.config.price } })
        } else if (req.route === 'account.usage') {
          const jobs = s.jobs.filter(j => j.account === s.account)
          answer = ok({ data: { simulated: true, generations: jobs.length, credits_used: jobs.reduce((n, j) => n + (j.refunded ? 0 : j.cost), 0), credit_balance: s.balances[s.account] } })
        } else if (req.route === 'generations.create') {
          const key = withoutKey ? `body:${hash}` : req.idempotencyKey.toLowerCase()
          const remembered = s.memory.find(m => m.account === s.account && m.key === key)
          if (remembered) {
            answer = remembered.hash === hash ? ok({ data: jobJson(s, s.jobs.find(j => j.id === remembered.jobId)!, now()) }, 200, { 'Idempotency-Replayed': 'true' }) : seedvisError(409, 'idempotency_conflict')
          } else {
            const slotsFault = faults.find(f => f.kind === 'slots-full')
            if (slotsFault?.kind === 'slots-full') s.slotsFullUntil = now() + slotsFault.forMs
            const active = s.jobs.filter(j => j.account === s.account && (j.status === 'queued' || j.status === 'processing')).length
            if (s.slotsFullUntil > now() || active >= s.config.concurrency + s.config.queueLimit) return seedvisError(422, 'validation_error', 'native', 'slots')
            if (s.balances[s.account] < s.config.price) return seedvisError(402, 'insufficient_credits')
            const id = `sv-dev-${crypto.randomUUID()}`
            const notStarted = faults.find(f => f.kind === 'not-started')
            const missing = faults.find(f => f.kind === 'poll-404')
            const fail = faults.find(f => f.kind === 'fail-job')
            const job: SeedvisDevJob = {
              id, account: s.account, body: req.body, references: (req.images ?? []).map(i => ({ field: i.field, index: i.index })),
              createdAt: now(), readyAt: now() + s.config.queuedMs, startAt: null, endAt: null, processingMs: s.config.processingMs,
              status: 'queued', cost: s.config.price, refunded: false, code: null, failCode: fail?.kind === 'fail-job' ? fail.code : null,
              held: faults.some(f => f.kind === 'hold' || f.kind === 'not-started'),
              notStartedAt: notStarted?.kind === 'not-started' ? now() + notStarted.afterMs : null,
              missingPolls: missing?.kind === 'poll-404' ? missing.polls : 0,
              emptyOutputs: faults.some(f => f.kind === 'empty-outputs'), shortEcho: faults.some(f => f.kind === 'short-echo'),
              links: [], video: renderSeedvisVideo(id),
            }
            s.balances[s.account] -= job.cost
            s.jobs.push(job)
            s.memory.push({ account: s.account, key, hash, jobId: id, expiresAt: now() + (withoutKey ? 120_000 : s.config.keyMemoryMs) })
            answer = ok({ data: jobJson(s, job, now()) }, 202)
          }
        } else {
          if (!('id' in req)) return failure('bad-request')
          const job = s.jobs.find(j => j.id === req.id && j.account === s.account)
          if (!job) return seedvisError(404, 'generation_not_found')
          if (req.route === 'generations.get') {
            if (job.missingPolls > 0) { job.missingPolls--; return seedvisError(404, 'generation_not_found') }
            answer = ok({ data: jobJson(s, job, now()) }, s.config.poll202 && (job.status === 'queued' || job.status === 'processing') ? 202 : 200)
          } else if (faults.some(f => f.kind === 'cancel-partial') && (job.status === 'queued' || job.status === 'processing')) {
            job.held = false; job.startAt ??= now(); job.endAt ??= now() + job.processingMs; job.status = 'processing'
            answer = ok({ data: jobJson(s, job, now()), cancellation: { outcome: 'partial', running_outputs: 1, refunded_credits: 0 } })
          } else if (job.status === 'queued' || job.code === 'cancelled') {
            job.status = 'failed'; job.code = 'cancelled'; refund(s, job)
            answer = ok({ data: jobJson(s, job, now()), cancellation: { outcome: 'cancelled', running_outputs: 0, refunded_credits: job.cost } })
          } else answer = seedvisError(409, 'not_cancellable')
        }
        if (faults.some(f => f.kind === 'lost-response')) return { ...failure('network', 'Mất câu trả lời seedvis giả lập sau khi xử lý.'), sent: true, lastByteAt: lastByteAt ?? null }
        return error ?? answer
      })
      log({ at: started, endpoint: req.route, status: result.ok ? result.status : result.code, authorization: 'Bearer ***',
        ...(req.route === 'generations.create' ? { images: req.images?.map(i => `[${i.mime.split('/')[1]} ${i.bytes.length} B]`) } : {}) })
      return result.ok ? { ...result, headers: { ...result.headers, 'X-Request-Id': `dev-${crypto.randomUUID()}` }, ...(lastByteAt === undefined ? {} : { lastByteAt, uploadMs }) } : result
    } catch { return storageError() }
  }

  return {
    now,
    async sessionStamp() {
      if (!devAllowed()) return null
      try { const s = await change(s => s); return s.keyState === 'verified' ? `${s.epoch}:${s.account}` : null } catch { storageError(); return null }
    },
    request: (raw: unknown) => request(raw),
    /** Server-only fixture: the desktop gateway still requires an Idempotency-Key. */
    createWithoutKey: (req: Omit<SeedvisCreate, 'idempotencyKey'>) => request({ ...req, idempotencyKey: '00000000-0000-4000-8000-000000000000' }, true),
    async keyStatus(): Promise<SeedvisKeyStatus> {
      if (!devAllowed()) return { hasKey: false, hint: null, tag: null, savedAt: null, verifiedAt: null, storage: 'unavailable' }
      try { return statusOfKey(await store.read()) } catch { storageError(); return { hasKey: false, hint: null, tag: null, savedAt: null, verifiedAt: null, storage: 'unavailable', problem: 'unreadable' } }
    },
    async setKey(raw: unknown): Promise<SeedvisKeyResult> {
      if (!devAllowed()) return locked()
      if (!isObj(raw) || Object.keys(raw).length !== 1 || typeof raw.key !== 'string') return failure('bad-key')
      const account = (Object.keys(SEEDVIS_DEV_KEYS) as SeedvisDevAccount[]).find(a => SEEDVIS_DEV_KEYS[a] === raw.key)
      if (!account) return failure('bad-key', 'Chỉ nhận khoá mẫu của seedvis giả lập; không dán khoá thật.')
      try { return await change(s => { s.epoch = crypto.randomUUID(); s.account = account; s.keyState = 'verified'; s.savedAt = now(); return { ok: true as const, status: statusOfKey(s) } }) } catch { return storageError() }
    },
    async clearKey(): Promise<SeedvisKeyResult> {
      if (!devAllowed()) return locked()
      try { return await change(s => { s.epoch = crypto.randomUUID(); s.keyState = 'none'; return { ok: true as const, status: statusOfKey(s) } }) } catch { return storageError() }
    },
    async configure(patch: Partial<SeedvisDevConfig>) {
      if (!devAllowed()) return locked()
      try { return await change(s => { s.config = seedvisConfig({ ...s.config, ...patch }); return { ok: true as const } }) } catch { return storageError() }
    },
    async setKeyState(keyState: SeedvisDevKeyState) {
      if (!devAllowed()) return locked()
      if (!['verified', 'none', 'revoked', 'forbidden', 'unreadable'].includes(keyState)) return failure('bad-request')
      try { return await change(s => { s.epoch = crypto.randomUUID(); s.keyState = keyState; return { ok: true as const } }) } catch { return storageError() }
    },
    async setBalance(balance: number) {
      if (!devAllowed()) return locked()
      if (!Number.isFinite(balance) || balance < 0) return failure('bad-request')
      try { return await change(s => { s.balances[s.account] = balance; return { ok: true as const } }) } catch { return storageError() }
    },
    async releaseHeld(id: string) {
      if (!devAllowed()) return locked()
      try { return await change(s => { const job = s.jobs.find(j => j.id === id); if (job) { job.held = false; job.readyAt = now() }; return { ok: true as const } }) } catch { return storageError() }
    },
    addFault(input: SeedvisFaultInput) {
      if (!devAllowed()) return null
      const rule: SeedvisFaultRule = { ...structuredClone(input), id: `sv-f${++seq}`, remaining: Math.max(1, Math.floor(input.times ?? 1)) }
      rules.push(rule)
      return rule.id
    },
    clearFaults() { if (devAllowed()) rules = [] },
    async snapshot() {
      if (!devAllowed()) return null
      try { const state = await change(s => { advance(s, now()); return s }); return { ...state, faults: structuredClone(rules), logs: structuredClone(logs), persistProblem } } catch { storageError(); return { persistProblem } }
    },
    async isOnline() { if (!devAllowed()) return false; try { return (await store.read()).config.online && !rules.some(r => r.sticky && r.fault.kind === 'offline' && r.endpoint === '*') } catch { return false } },
    async reset() {
      if (!devAllowed()) return locked()
      try { await store.reset(); rules = []; logs.length = 0; persistProblem = null; return { ok: true as const } } catch { return storageError() }
    },
    async download(rawUrl: string, headers: Record<string, string> = {}): Promise<SeedvisDevDownload> {
      if (!devAllowed()) return locked()
      if (Object.keys(headers).some(k => ['authorization', 'x-api-key', 'x-goog-api-key', 'cookie'].includes(k.toLowerCase()))) return failure('not-allowed', 'Không gửi thông tin xác thực tới CDN giả lập.')
      try {
        const s = await store.read()
        const a = auth(s)
        if (a) return failure('bad-key')
        const faults = takeFaults('download')
        if (!s.config.online || faults.some(f => f.kind === 'offline')) return failure('offline')
        const url = new URL(rawUrl)
        if (![SEEDVIS_DEV_CDN, foreignCDN].includes(url.origin) || url.username || url.password || url.hash) return failure('not-allowed')
        const job = s.jobs.find(j => url.pathname === `/${j.id}/0.mp4` && j.account === s.account && j.status === 'completed')
        const expiry = Number(url.searchParams.get('expires'))
        if (!job) return failure('unknown-output')
        if (!Number.isFinite(expiry) || expiry <= now() || (job.endAt! + s.config.retentionMs) <= now() || faults.some(f => f.kind === 'expired-link')) return failure('expired-link')
        if (!job.links.some(l => l.token === url.searchParams.get('signature') && l.expiresAt === expiry)) return failure('unknown-output')
        if (faults.some(f => f.kind === 'lost-response' || f.kind === 'response')) return failure('network')
        log({ at: now(), endpoint: 'download', status: 200, host: url.hostname })
        return { ok: true, bytes: job.video.slice(), total: faults.some(f => f.kind === 'oversize') ? SEEDVIS_IPC_LIMITS.videoBytes + 1 : job.video.length,
          contentType: s.config.outputContentType, ...(faults.some(f => f.kind === 'insecure-redirect') ? { redirect: `http://cdn.seedvis.invalid/${job.id}` } : {}) }
      } catch { return storageError() }
    },
  }
}

export type DevSeedvis = ReturnType<typeof createDevSeedvis>
