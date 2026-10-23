// Provider 'sano-gateway' (D216 TH-15): the SanoVids web build running inside the SANO app (served by SANO under
// /sanovids/) sends its jobs to the SANO server instead of canvasapp. The SANO server owns the real video providers,
// the login and the costs; this file is only its client. Contract (same origin as the page, base /api/video):
//   GET  /capabilities                    → { mode?, models: [{ id, label, ratios, resolutions, durations, maxRefs }] }
//   POST /jobs { idempotencyKey, model, prompt, settings: { ratio, resolution, duration }, refs: [{ name, mime, data }] }
//                                         → 202 { id, status }; the same idempotencyKey again → 200, the same job
//   GET  /jobs?idempotencyKey=<k>         → { id, status } | 404 (recover after a crash / reload)
//   GET  /jobs/<id>                       → { id, status: queued|running|done|failed|unknown, progress?, error? }
//   GET  /jobs/<id>/result                → the MP4
//   POST /jobs/<id>/cancel                → { id, status } (only while queued)
// `mode` ('simulator' | 'live', on /capabilities and on every job): what SANO runs. Missing (no backend) = unknown,
// never taken as 'live'; a job answered 'simulator' marks its take `simulated` (a sample clip, nothing billed). Only
// /capabilities and a newly created job (202) say what SANO runs now: an old job's poll / recover marks its take only.
// A take queued while SANO said 'simulator' (JobRequest.expectSimulated: no fee was promised) reads /capabilities again
// before its POST and is never sent once SANO says otherwise (SANO_NOW_LIVE).
// Auth: `Authorization: Bearer <the host page's token>` only (SANO's /api/video has no cookie auth): SANO's Google ID
// token, null until sign-in, never renewed (refused after ~1 h). Its state (tokenState: 'none' | 'refused' — this very
// token got a 401 | 'ok') is read from the gateway's creation inside SANO, on every request and every 3 s. A dead token
// is found by its 401 (one harmless request), never by its exp: this PC's clock may run ahead. While the state is not
// 'ok' — 'none' only once a first read has ended: before it, nothing is refused and a request waits for the token —
// blockedReason() says SANO_LOGIN_TEXT, so the engine parks SANO takes (store/runs cannotRunHere: nothing sent, no
// lock, no refs read) and they go on once a usable token appears (onLimitsChange wakes the engine). Jobs are per SANO
// account: a take is bound to the account (the token's sub, as a key) it was queued / sent / looked up under and waits
// under another one (SANO_OTHER_ACCOUNT); a job request whose token turns out to be another account's than the one the
// engine chose for is 'deferred' before it is sent. A request without a usable token, or answered 401, is 'deferred'
// with SANO_LOGIN_TEXT (nothing created).
// The idempotency key is the take id: sending a take again (lost answer, "Chạy lại") never creates — or pays for — a
// second job, so an uncertain submit is simply sent again with the same key (no ledger like canvasapp's).
// `model` is SanoVids' ModelId ('seedance_2_5', 'minimax_h3'): SANO's /capabilities must list models under those ids.
// No video-mode field (t2v / i2v…): frames go as refs named first_frame / last_frame, pictures as image_<N> (@image_N).
// Pure: fetch, the host's token and the media store are injected (tests use a fake server, no DOM here).
import { MODELS } from '../../core/models'
import type { ModelId, VideoSettings } from '../../core/types'
import { accountKey } from '../canvasapp/adapter'
import { capabilitiesFromModels } from '../capabilities'
import {
  NO_LIMITS,
  ProviderError,
  type JobRequest,
  type LimitsInfo,
  type ProviderCapabilities,
  type RefreshLimitsResult,
  type RemoteState,
  type RemoteStatus,
  type SettingsIssue,
  type SettingsLimits,
  type VideoProvider,
} from '../types'

export const SANO_API = '/api/video'
export const SANO_LABEL = 'SANO'
export const SANO_LOGIN_TEXT = 'Cần đăng nhập SANO — đăng nhập lại trong app SANO rồi thử lại.'
/** SANO_LOGIN_TEXT for a take that already waits in the queue: it goes on by itself (store/runs parkedReason). */
export const SANO_LOGIN_WAIT = 'Chờ đăng nhập SANO — đăng nhập lại trong app SANO, take tự chạy tiếp.'
export const SANO_UNAVAILABLE = 'Nhà cung cấp SANO chỉ dùng được khi mở SanoVids bên trong app SANO.'
export const SANO_OTHER_ACCOUNT = 'Take này thuộc tài khoản SANO khác — đăng nhập lại tài khoản đó trong app SANO để SanoVids theo dõi tiếp.'
/** SANO_OTHER_ACCOUNT for takes that wait in the queue (store/runs parkedReason). */
export const SANO_OTHER_ACCOUNT_WAIT = 'Chờ tài khoản SANO khác — đăng nhập lại trong app SANO bằng tài khoản đã gửi take, take tự chạy tiếp.'
/** A take queued while SANO ran its simulator (JobRequest.expectSimulated) when SANO no longer says so: not sent. */
export const SANO_NOW_LIVE = 'Take này vào hàng đợi khi máy chủ SANO còn chạy giả lập (không phát sinh phí), nay SANO không còn báo giả lập — SanoVids không gửi. Chạy lại cảnh để xem chi phí rồi gửi.'
/** How often the host's token is read besides each request (SANO signs in / switches account without telling). */
export const TOKEN_RECHECK_MS = 3_000
/** Cap on a job's reference images, measured on what is sent (the base64 text of every ref). */
export const MAX_REFS_BYTES = 20 * 1024 * 1024
/** Same cap as the canvasapp gateway: a bigger video is never taken. */
export const MAX_RESULT_BYTES = 1024 ** 3
/** A /capabilities read stays firm this long (the inspector re-reads it shortly before, while it shows it). */
export const CAPS_TTL_MS = 10 * 60_000
const PROGRESS_MS = 250
/** SANO queues the jobs itself: the engine's remote cap (store/runs MAX_REMOTE_CONCURRENCY) is the only limit here. */
const MAX_CONCURRENCY = 10
/** The engine floor for remote providers (store/runs MIN_REMOTE_POLL_MS). */
const POLL_MS = 15_000

export type SanoMode = 'simulator' | 'live'
export type SanoTokenState = 'none' | 'refused' | 'ok'

export interface SanoModel {
  id: string
  label: string
  ratios: string[]
  resolutions: string[]
  durations: number[]
  maxRefs: number
}

export interface SanoGatewayDeps {
  /** Same-origin fetch (the browser's; tests pass a fake server). */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** The host page's bearer token (window.__SANO_GATEWAY__.token); null / undefined = not signed in to SANO yet. */
  token: () => Promise<string | null | undefined>
  /** Running inside SANO. */
  available: () => boolean
  /** Media store (IndexedDB) blob of a picture. */
  getBlob: (imageId: string) => Promise<Blob | null | undefined>
  /** What settingsLimits() / limitsInfo() return may have changed (providers/index bumps the UI signal). */
  onLimitsChange?: () => void
  now?: () => number
}

export type SanoGatewayProvider = VideoProvider &
  Required<Pick<VideoProvider, 'recover' | 'mayHaveSent' | 'cancel' | 'reset' | 'settingsLimits' | 'limitsInfo' | 'refreshLimits' | 'account'>> & {
    /** What SANO last said it runs (/capabilities or a newly created job); null = it has not said. */
    mode(): SanoMode | null
    tokenState(): SanoTokenState
    /** Synchronous: why a new take — or a take bound to `account` — cannot be sent / followed from here now, or null. */
    blockedReason(account?: string): string | null
  }

const STATES: Record<string, RemoteState> = { queued: 'queued', running: 'processing', done: 'completed', failed: 'failed' }

const modeOf = (b: Record<string, unknown> | null): SanoMode | null => (b?.mode === 'simulator' || b?.mode === 'live' ? b.mode : null)

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** /capabilities as SanoVids reads it (a trust boundary: malformed entries are dropped). */
export function parseCapabilities(body: unknown): Map<string, SanoModel> {
  const models = new Map<string, SanoModel>()
  const list = (body as { models?: unknown } | null)?.models
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue
    models.set(m.id, {
      id: m.id,
      label: typeof m.label === 'string' && m.label ? m.label : m.id,
      ratios: strings(m.ratios),
      resolutions: strings(m.resolutions),
      durations: Array.isArray(m.durations) ? m.durations.filter((d: unknown): d is number => typeof d === 'number') : [],
      maxRefs: typeof m.maxRefs === 'number' && m.maxRefs >= 0 ? m.maxRefs : 0,
    })
  }
  return models
}

/** What SANO refuses in `s` (and in `refs`, the pictures the job sends, when known), in the submit's order. */
export function sanoIssues(models: Map<string, SanoModel>, s: Pick<VideoSettings, 'model' | 'duration' | 'resolution' | 'ratio'>, refs?: number): SettingsIssue[] {
  const m = models.get(s.model)
  if (!m) return [{ field: 'model', reason: `Máy chủ SANO chưa mở model ${MODELS[s.model as ModelId]?.name ?? s.model}.` }]
  const out: SettingsIssue[] = []
  if (!m.durations.includes(s.duration)) out.push({ field: 'duration', reason: `${m.label} trên SANO không chạy ${s.duration} giây (có: ${m.durations.join(', ')}).` })
  if (!m.resolutions.includes(s.resolution)) out.push({ field: 'resolution', reason: `${m.label} trên SANO không chạy ${s.resolution} (có: ${m.resolutions.join(', ')}).` })
  if (!m.ratios.includes(s.ratio)) out.push({ field: 'ratio', reason: `${m.label} trên SANO không chạy tỉ lệ ${s.ratio} (có: ${m.ratios.join(', ')}).` })
  if (refs !== undefined && refs > m.maxRefs) out.push({ field: 'model', reason: `${m.label} trên SANO nhận tối đa ${m.maxRefs} ảnh tham chiếu (đang có ${refs}).` })
  return out
}

/** Base64 of a blob, in pieces (String.fromCharCode cannot take a whole picture at once). */
async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

const base64Size = (bytes: number) => 4 * Math.ceil(bytes / 3)

async function bodyOf(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const b: unknown = await res.json()
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The server's own words when it gave some, else "HTTP <status>". */
async function serverText(res: Response): Promise<string> {
  const b = await bodyOf(res)
  return typeof b?.error === 'string' && b.error.trim() ? b.error.trim() : `HTTP ${res.status}`
}

/** No usable token, or a 401: nothing was created, the take waits until SANO gives a usable token. */
const loginDeferred = () => new ProviderError('deferred', SANO_LOGIN_TEXT)
const needsLogin = (e: unknown) => (e as Error | null)?.message === SANO_LOGIN_TEXT

/** A JWT's sub as a key (its payload read unverified: SANO's server checks the token, here a hint only). */
export function tokenAccount(token: string): string | undefined {
  try {
    // base64url ('-', '_'): what Google's ID tokens use
    const { sub } = (JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) ?? {}) as { sub?: unknown }
    return typeof sub === 'string' && sub ? accountKey(sub) : undefined
  } catch {
    return undefined // not a JWT: no account known
  }
}

/** No answer to a POST /jobs that may have arrived: the job may exist (the same key resent finds it). */
function uncertainError(why: string): ProviderError {
  return Object.assign(new ProviderError('network', `Không rõ máy chủ SANO đã nhận job chưa (${why}). Bấm “Chạy lại”: SANO nhận ra take này, không tạo thêm job.`), {
    uncertain: true,
  })
}

export function createSanoGatewayProvider(deps: SanoGatewayDeps): SanoGatewayProvider {
  const now = deps.now ?? Date.now
  let caps: { models: Map<string, SanoModel>; at: number; firm: SettingsLimits; stale: SettingsLimits } | null = null
  let reading: Promise<Map<string, SanoModel>> | null = null
  let lastAttempt: LimitsInfo['lastAttempt'] = null
  let mode: SanoMode | null = null
  /** Keys whose POST /jobs was started here (mayHaveSent). Kept by reset(): such a POST may still be answered. */
  const sent = new Set<string>()
  /** Last known state of each job (cancel only asks while it is queued). */
  const states = new Map<string, RemoteState>()
  /** The host's token as last read, its account, the token SANO answered 401. */
  let host: string | null = null
  let hostAccount: string | undefined
  let refusedToken: string | null = null
  /** A read of the host's token has ended: before it 'none' only means "not known yet". */
  let read = false
  /** The state + account the app was last told of (onLimitsChange: the run gates, Settings, the engine re-read them). */
  let told = ''
  let recheck: ReturnType<typeof setInterval> | null = null

  function watch() {
    // inside SANO only, from the gateway's creation on: sign-in, another account, a new token all come without a word
    if (recheck || !deps.available()) return
    recheck = setInterval(() => void readToken().catch(() => undefined), TOKEN_RECHECK_MS)
    ;(recheck as { unref?: () => void }).unref?.()
    void readToken().catch(() => undefined)
  }

  function tokenState(): SanoTokenState {
    watch() // again after reset()
    if (!host) return 'none'
    return host === refusedToken ? 'refused' : 'ok'
  }

  function tell() {
    const said = `${tokenState()} ${hostAccount ?? ''}`
    if (said === told) return
    told = said
    deps.onLimitsChange?.()
  }

  async function readToken(): Promise<string | null> {
    let token: string | null = null
    try {
      token = (await deps.token()) ?? null
    } catch {
      // the host failing = an ended read with no token: takes wait for the sign-in, never fail on the host's error
    }
    read = true
    if (token !== host) {
      host = token
      hostAccount = token ? tokenAccount(token) : undefined
    }
    tell()
    return token
  }

  /**
   * One request with the host's token, none (deferred) without a usable one. `want` (job requests): the account the
   * engine chose its take for — the token now names another one → deferred, nothing sent (404 or a second job there).
   */
  async function call(path: string, init: RequestInit = {}, beforeSend?: () => void, want?: string | null): Promise<Response> {
    const token = await readToken()
    if (tokenState() !== 'ok' || !token) throw loginDeferred()
    if (want !== undefined && (hostAccount ?? null) !== want) throw new ProviderError('deferred', SANO_OTHER_ACCOUNT)
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` }
    beforeSend?.() // same synchronous step as the request itself (mayHaveSent)
    const res = await deps.fetch(SANO_API + path, { ...init, headers, credentials: 'include' })
    if (res.status === 401) {
      refusedToken = token
      tell()
      throw loginDeferred()
    }
    return res
  }

  /** The account a job operation starting now is for (taken before any await: what the engine just chose by). */
  // shortcut: null before the first token read ends, so a request then is deferred once (no news / 15 s) even under the
  // right account; the read starts at load, long before a ▶ — make the engine wait for it if the host's token() is slow.
  const wanted = () => hostAccount ?? null

  const jobPath = (id: string) => `/jobs/${encodeURIComponent(id)}`

  function readCaps(): Promise<Map<string, SanoModel>> {
    reading ??= (async () => {
      try {
        const res = await call('/capabilities')
        if (!res.ok) throw new ProviderError('server', `Không đọc được danh sách model của máy chủ SANO (${await serverText(res)}).`)
        const body = await bodyOf(res)
        const models = parseCapabilities(body)
        mode = modeOf(body)
        const at = now()
        const issues = (s: VideoSettings, refs?: number) => sanoIssues(models, s, refs)
        caps = { models, at, firm: { source: 'server', firm: true, issues }, stale: { source: 'server', firm: false, issues } }
        lastAttempt = { at, result: 'read' }
        return models
      } catch (e) {
        lastAttempt = { at: now(), result: needsLogin(e) ? 'login' : caps ? 'kept' : 'failed' }
        throw e
      } finally {
        reading = null
        deps.onLimitsChange?.()
      }
    })()
    deps.onLimitsChange?.()
    return reading
  }

  const job = (id: string, b: Record<string, unknown> | null) => (modeOf(b) === 'simulator' ? { remoteId: id, simulated: true } : { remoteId: id })

  const freshCaps = () => (caps && now() - caps.at < CAPS_TTL_MS ? caps.models : null)

  /** The job's refs, in @image_N order then the frames; too-large before anything is read or sent. */
  async function refsOf(req: JobRequest): Promise<{ name: string; mime: string; data: string }[]> {
    const items = [
      ...req.images.map((im) => ({ name: `image_${im.n}`, what: `@image_${im.n}`, imageId: im.imageId, blob: im.blob })),
      ...(req.firstFrame ? [{ name: 'first_frame', what: 'khung đầu', ...req.firstFrame }] : []),
      ...(req.lastFrame ? [{ name: 'last_frame', what: 'khung cuối', ...req.lastFrame }] : []),
    ]
    const blobs: Blob[] = []
    for (const it of items) {
      const b = it.blob ?? (await deps.getBlob(it.imageId))
      if (!b) throw new ProviderError('missing-image', `Không tìm thấy ảnh ${it.what} trong máy — thêm lại ảnh rồi chạy lại.`)
      blobs.push(b)
    }
    const size = blobs.reduce((t, b) => t + base64Size(b.size), 0)
    if (size > MAX_REFS_BYTES) {
      throw new ProviderError('too-large', `Ảnh tham chiếu quá lớn để gửi lên SANO (${(size / 1024 ** 2).toFixed(1)} MB, tối đa 20 MB) — dùng ảnh nhỏ hơn hoặc bớt ảnh.`)
    }
    return Promise.all(items.map(async (it, i) => ({ name: it.name, mime: blobs[i].type || 'application/octet-stream', data: await base64(blobs[i]) })))
  }

  const provider: SanoGatewayProvider = {
    id: 'sano-gateway',
    label: SANO_LABEL,

    async available() {
      return deps.available() ? { ok: true } : { ok: false, reason: SANO_UNAVAILABLE }
    },

    capabilities(model): ProviderCapabilities {
      const base = capabilitiesFromModels(model, { maxConcurrency: MAX_CONCURRENCY, pollIntervalMs: POLL_MS })
      const m = caps?.models.get(model)
      return m ? { ...base, durations: [...m.durations], resolutions: [...m.resolutions], ratios: [...m.ratios], maxRefImages: m.maxRefs } : base
    },

    async submit(req, opts = {}) {
      const stopIfCancelled = () => {
        if (opts.isCancelled?.()) throw new ProviderError('cancelled', 'Đã huỷ trước khi gửi lên SANO — không tạo job.')
      }
      // outside SANO nothing is sent: the take stays queued and runs once its project is opened inside SANO (see recover)
      if (!deps.available()) throw new ProviderError('deferred', SANO_UNAVAILABLE)
      const want = wanted()
      stopIfCancelled()
      const refs = await refsOf(req)
      // queued under SANO's simulator (the Run dialog said: no fee): its mode is read again now, never trusted from cache
      const models = req.expectSimulated ? await readCaps() : (freshCaps() ?? (await readCaps()))
      // shortcut: a switch to live between this read and the POST is not seen; send the expected mode once SANO's POST /jobs checks it.
      if (req.expectSimulated && mode !== 'simulator') {
        // an earlier send of this take (a lost answer) may have made its job: that one, never a new one under the new mode
        const found = await provider.recover(req)
        if (found) return found
        throw new ProviderError('refused', SANO_NOW_LIVE)
      }
      const refused = sanoIssues(models, req, refs.length)[0]
      if (refused) throw new ProviderError('refused', refused.reason)
      // opts.retryOfUnknown needs nothing more: the same idempotency key never makes a second job.
      const body = JSON.stringify({
        idempotencyKey: req.key,
        model: req.model,
        prompt: req.prompt,
        settings: { ratio: req.ratio, resolution: req.resolution, duration: req.duration },
        refs,
      })
      let res: Response
      let posted = false
      try {
        res = await call('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, () => {
          stopIfCancelled()
          sent.add(req.key)
          posted = true
        }, want)
      } catch (e) {
        // no usable token (the host's token() failing too) / another account, cancelled, 401: nothing created
        if (!posted || e instanceof ProviderError) throw e
        throw uncertainError((e as Error)?.message || 'mất kết nối')
      }
      if (res.status === 200 || res.status === 202) {
        const b = await bodyOf(res)
        if (typeof b?.id !== 'string' || !b.id) throw uncertainError('câu trả lời không có mã job')
        const state = STATES[String(b.status)]
        if (state) states.set(b.id, state)
        // 202 = made just now, so its mode is what SANO runs now (the Run dialog says it); 200 is an older job of this key
        const m = modeOf(b)
        if (res.status === 202 && m && m !== mode) {
          mode = m
          deps.onLimitsChange?.()
        }
        return job(b.id, b)
      }
      if (res.status === 413) throw new ProviderError('too-large', 'Máy chủ SANO từ chối vì yêu cầu quá lớn — dùng ảnh nhỏ hơn hoặc bớt ảnh.')
      // 5xx: the server may have created the job before failing
      if (res.status >= 500) throw uncertainError(await serverText(res))
      throw new ProviderError('refused', `Máy chủ SANO từ chối tạo video: ${await serverText(res)}.`)
    },

    async recover(req) {
      // outside SANO a 404 of this origin is no answer: no news, the take waits to be opened inside SANO
      if (!deps.available()) throw new ProviderError('deferred', SANO_UNAVAILABLE)
      // a lost connection / a 5xx is no answer: asked again later (store/runs), only a 404 says "no such job"
      const later = (why: string) => new ProviderError('deferred', `Chưa hỏi được máy chủ SANO về take này (${why}) — SanoVids hỏi lại sau.`)
      const res = await call(`/jobs?idempotencyKey=${encodeURIComponent(req.key)}`, {}, undefined, wanted()).catch((e: unknown) => {
        throw e instanceof ProviderError ? e : later((e as Error)?.message || 'mất kết nối')
      })
      if (res.status === 404) return null
      if (res.status >= 500) throw later(await serverText(res))
      if (!res.ok) throw new ProviderError('server', `Không hỏi được máy chủ SANO về take này (${await serverText(res)}).`)
      const b = await bodyOf(res)
      if (typeof b?.id !== 'string' || !b.id) throw new ProviderError('server', 'Máy chủ SANO trả về job không có mã.')
      sent.add(req.key)
      const state = STATES[String(b.status)]
      if (state) states.set(b.id, state)
      return job(b.id, b)
    },

    mayHaveSent: (key) => sent.has(key),

    mode: () => mode,

    tokenState,

    account: () => hostAccount ?? null,

    async freshAccount() {
      const token = deps.available() ? await readToken() : null
      return token ? (tokenAccount(token) ?? null) : null
    },

    blockedReason(account) {
      if (!deps.available()) return SANO_UNAVAILABLE
      const state = tokenState()
      // before a first read ends 'none' is not known: a new take is not refused, its request waits for the token (call)
      if (state === 'refused' || (state === 'none' && read)) return SANO_LOGIN_TEXT
      return account && hostAccount && account !== hostAccount ? SANO_OTHER_ACCOUNT : null
    },

    async poll(remoteIds) {
      if (!deps.available()) return [] // outside SANO: no news (see recover)
      const want = wanted()
      // One broken job (5xx / network) is no news for that job only: the others' statuses still reach the engine.
      let failure: unknown = null
      let failed = 0
      const out = await Promise.all(
        remoteIds.map(async (id): Promise<RemoteStatus | null> => {
          try {
            const res = await call(jobPath(id), {}, undefined, want)
            if (res.status === 404) return { remoteId: id, state: 'failed', error: 'Máy chủ SANO không còn job này.' }
            if (!res.ok) throw new ProviderError('server', `Máy chủ SANO trả lỗi khi hỏi trạng thái job (${await serverText(res)}).`)
            const b = await bodyOf(res)
            const state = STATES[String(b?.status)]
            if (!state) return null // 'unknown' (or a status this build does not know): no news, asked again next time
            states.set(id, state)
            const progress = typeof b?.progress === 'number' ? { progress: b.progress } : {}
            const error = state === 'failed' ? { error: typeof b?.error === 'string' && b.error.trim() ? b.error.trim() : 'Máy chủ SANO báo job lỗi.' } : {}
            return { remoteId: id, state, ...progress, ...error }
          } catch (e) {
            if ((e as ProviderError).code === 'deferred') return null // no usable token / another account: no news, no back-off
            failure = e
            failed++
            return null
          }
        }),
      )
      if (failed && failed === remoteIds.length) throw failure // nothing answered: the engine backs off
      return out.filter((s): s is RemoteStatus => !!s)
    },

    // shortcut: a cut download starts again from 0 on the engine's next try; resume with Range when videos get big.
    async fetchResult(remoteId, opts = {}) {
      if (!deps.available()) throw new ProviderError('deferred', SANO_UNAVAILABLE) // not a failed download (see recover)
      const res = await call(`${jobPath(remoteId)}/result`, opts.signal ? { signal: opts.signal } : {}, undefined, wanted())
      if (!res.ok) throw new ProviderError('download', `Không tải được video từ máy chủ SANO (${await serverText(res)}).`)
      const tooLarge = () => new ProviderError('too-large', 'Video lớn hơn 1 GB — SanoVids không tải được, lấy trực tiếp trong app SANO.')
      const total = Number(res.headers.get('Content-Length')) || null
      if (total !== null && total > MAX_RESULT_BYTES) throw tooLarge()
      if (!res.body) throw new ProviderError('download', 'Máy chủ SANO trả về video rỗng.')
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      let shown = -Infinity
      for (;;) {
        opts.signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > MAX_RESULT_BYTES) {
          void reader.cancel()
          throw tooLarge()
        }
        chunks.push(value)
        if (opts.onProgress && now() - shown >= PROGRESS_MS) {
          shown = now()
          opts.onProgress({ received, total })
        }
      }
      // a 200 with no bytes (Content-Length: 0, an empty stream) is a failed download, retried — never an empty video
      if (!received) throw new ProviderError('download', 'Máy chủ SANO trả về video rỗng.')
      opts.onProgress?.({ received, total })
      return { video: new Blob(chunks as BlobPart[], { type: res.headers.get('Content-Type') || 'video/mp4' }) }
    },

    async cancel(remoteId) {
      // SANO stops a job only while it is queued; not known (a reload, reset()) = not asked
      if (states.get(remoteId) !== 'queued') return
      try {
        const res = await call(`${jobPath(remoteId)}/cancel`, { method: 'POST' }, undefined, wanted())
        const b = res.ok ? await bodyOf(res) : null
        const state = STATES[String(b?.status)]
        if (state) states.set(remoteId, state)
      } catch {
        // never thrown at the engine (it does not await it): the job runs on and polling says how it ends
      }
    },

    reset() {
      caps = null
      mode = null
      states.clear()
      if (recheck) clearInterval(recheck)
      recheck = null
      host = refusedToken = null
      hostAccount = undefined
      read = false
      told = ''
      deps.onLimitsChange?.()
    },

    settingsLimits() {
      if (!caps) return NO_LIMITS
      return now() - caps.at < CAPS_TTL_MS ? caps.firm : caps.stale
    },

    limitsInfo() {
      return {
        source: caps ? 'server' : 'none',
        at: caps?.at ?? null,
        firmUntil: caps ? caps.at + CAPS_TTL_MS : null,
        lastAttempt,
        reading: !!reading,
      }
    },

    // shortcut: no throttle on `force` (a GET to SANO's own server); add one if the inspector ever re-reads in a loop.
    async refreshLimits(opts = {}): Promise<RefreshLimitsResult> {
      if (!deps.available()) return 'unavailable'
      if (!opts.force && !opts.changed && freshCaps()) return 'fresh'
      try {
        await readCaps()
        return 'read'
      } catch (e) {
        return needsLogin(e) ? 'login' : caps ? 'kept' : 'failed'
      }
    },
  }
  watch() // the first read starts with the gateway (providers/index makes it at load in the SANO build)
  return provider
}
