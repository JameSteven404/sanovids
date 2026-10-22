// Provider 'sano-gateway' (D216 TH-15): the SanoVids web build running inside the SANO app (served by SANO under
// /sanovids/) sends its jobs to the SANO server instead of canvasapp. The SANO server owns the real video providers,
// the login and the costs; this file is only its client. Contract (same origin as the page, base /api/video):
//   GET  /capabilities                    → { models: [{ id, label, ratios, resolutions, durations, maxRefs }] }
//   POST /jobs { idempotencyKey, model, prompt, settings: { ratio, resolution, duration }, refs: [{ name, mime, data }] }
//                                         → 202 { id, status }; the same idempotencyKey again → 200, the same job
//   GET  /jobs?idempotencyKey=<k>         → { id, status } | 404 (recover after a crash / reload)
//   GET  /jobs/<id>                       → { id, status: queued|running|done|failed|unknown, progress?, error? }
//   GET  /jobs/<id>/result                → the MP4
//   POST /jobs/<id>/cancel                → { id, status } (only while queued)
// Auth: the SANO session cookie (credentials 'include') and, when the host page gives one, `Authorization: Bearer`.
// 401 → SANO_LOGIN_TEXT (code 'login-required'), never retried here.
// The idempotency key is the take id: sending a take again (lost answer, "Chạy lại") never creates — or pays for — a
// second job, so an uncertain submit is simply sent again with the same key (no ledger like canvasapp's).
// `model` is SanoVids' ModelId ('seedance_2_5', 'minimax_h3'): SANO's /capabilities must list models under those ids.
// The contract has no mode field: frames go as refs named first_frame / last_frame, pictures as image_<N> (@image_N).
// Pure: fetch, the host's token and the media store are injected (tests use a fake server, no DOM here).
import { MODELS } from '../../core/models'
import type { ModelId, VideoSettings } from '../../core/types'
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
export const SANO_UNAVAILABLE = 'Nhà cung cấp SANO chỉ dùng được khi mở SanoVids bên trong app SANO.'
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
  /** The host page's bearer token (window.__SANO_GATEWAY__.token), null = the cookie alone. */
  token?: () => Promise<string | null | undefined>
  /** Running inside SANO. */
  available: () => boolean
  /** Media store (IndexedDB) blob of a picture. */
  getBlob: (imageId: string) => Promise<Blob | null | undefined>
  /** What settingsLimits() / limitsInfo() return may have changed (providers/index bumps the UI signal). */
  onLimitsChange?: () => void
  now?: () => number
}

export type SanoGatewayProvider = VideoProvider & Required<Pick<VideoProvider, 'recover' | 'mayHaveSent' | 'cancel' | 'reset' | 'settingsLimits' | 'limitsInfo' | 'refreshLimits'>>

const STATES: Record<string, RemoteState> = { queued: 'queued', running: 'processing', done: 'completed', failed: 'failed' }

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

/** What SANO refuses in `s`, in the submit's order (model, duration, resolution, ratio). */
export function sanoIssues(models: Map<string, SanoModel>, s: Pick<VideoSettings, 'model' | 'duration' | 'resolution' | 'ratio'>): SettingsIssue[] {
  const m = models.get(s.model)
  if (!m) return [{ field: 'model', reason: `Máy chủ SANO chưa mở model ${MODELS[s.model as ModelId]?.name ?? s.model}.` }]
  const out: SettingsIssue[] = []
  if (!m.durations.includes(s.duration)) out.push({ field: 'duration', reason: `${m.label} trên SANO không chạy ${s.duration} giây (có: ${m.durations.join(', ')}).` })
  if (!m.resolutions.includes(s.resolution)) out.push({ field: 'resolution', reason: `${m.label} trên SANO không chạy ${s.resolution} (có: ${m.resolutions.join(', ')}).` })
  if (!m.ratios.includes(s.ratio)) out.push({ field: 'ratio', reason: `${m.label} trên SANO không chạy tỉ lệ ${s.ratio} (có: ${m.ratios.join(', ')}).` })
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

const loginError = () => new ProviderError('login-required', SANO_LOGIN_TEXT)

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
  /** Keys whose POST /jobs was started here (mayHaveSent). Kept by reset(): such a POST may still be answered. */
  const sent = new Set<string>()
  /** Last known state of each job (cancel only asks while it is queued). */
  const states = new Map<string, RemoteState>()

  async function call(path: string, init: RequestInit = {}, beforeSend?: () => void): Promise<Response> {
    const token = await deps.token?.()
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
    if (token) headers.Authorization = `Bearer ${token}`
    beforeSend?.() // same synchronous step as the request itself (mayHaveSent)
    const res = await deps.fetch(SANO_API + path, { ...init, headers, credentials: 'include' })
    if (res.status === 401) throw loginError()
    return res
  }

  const jobPath = (id: string) => `/jobs/${encodeURIComponent(id)}`

  function readCaps(): Promise<Map<string, SanoModel>> {
    reading ??= (async () => {
      try {
        const res = await call('/capabilities')
        if (!res.ok) throw new ProviderError('server', `Không đọc được danh sách model của máy chủ SANO (${await serverText(res)}).`)
        const models = parseCapabilities(await bodyOf(res))
        const at = now()
        const issues = (s: VideoSettings) => sanoIssues(models, s)
        caps = { models, at, firm: { source: 'server', firm: true, issues }, stale: { source: 'server', firm: false, issues } }
        lastAttempt = { at, result: 'read' }
        return models
      } catch (e) {
        lastAttempt = { at: now(), result: (e as ProviderError).code === 'login-required' ? 'login' : caps ? 'kept' : 'failed' }
        throw e
      } finally {
        reading = null
        deps.onLimitsChange?.()
      }
    })()
    deps.onLimitsChange?.()
    return reading
  }

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

  return {
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
      if (!deps.available()) throw new ProviderError('unavailable', SANO_UNAVAILABLE)
      stopIfCancelled()
      const refs = await refsOf(req)
      const models = freshCaps() ?? (await readCaps())
      const refused = sanoIssues(models, req)[0]
      if (refused) throw new ProviderError('refused', refused.reason)
      const max = models.get(req.model)!.maxRefs
      if (refs.length > max) throw new ProviderError('refused', `${models.get(req.model)!.label} trên SANO nhận tối đa ${max} ảnh tham chiếu (take này có ${refs.length}).`)
      // opts.retryOfUnknown needs nothing more: the same idempotency key never makes a second job.
      const body = JSON.stringify({
        idempotencyKey: req.key,
        model: req.model,
        prompt: req.prompt,
        settings: { ratio: req.ratio, resolution: req.resolution, duration: req.duration },
        refs,
      })
      let res: Response
      try {
        res = await call('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, () => {
          stopIfCancelled()
          sent.add(req.key)
        })
      } catch (e) {
        if (e instanceof ProviderError) throw e // cancelled / 401: nothing was created
        throw uncertainError((e as Error)?.message || 'mất kết nối')
      }
      if (res.status === 200 || res.status === 202) {
        const b = await bodyOf(res)
        if (typeof b?.id !== 'string' || !b.id) throw uncertainError('câu trả lời không có mã job')
        const state = STATES[String(b.status)]
        if (state) states.set(b.id, state)
        return { remoteId: b.id }
      }
      if (res.status === 413) throw new ProviderError('too-large', 'Máy chủ SANO từ chối vì yêu cầu quá lớn — dùng ảnh nhỏ hơn hoặc bớt ảnh.')
      // 5xx: the server may have created the job before failing
      if (res.status >= 500) throw uncertainError(await serverText(res))
      throw new ProviderError('refused', `Máy chủ SANO từ chối tạo video: ${await serverText(res)}.`)
    },

    async recover(req) {
      const res = await call(`/jobs?idempotencyKey=${encodeURIComponent(req.key)}`)
      if (res.status === 404) return null
      if (!res.ok) throw new ProviderError('server', `Không hỏi được máy chủ SANO về take này (${await serverText(res)}).`)
      const b = await bodyOf(res)
      if (typeof b?.id !== 'string' || !b.id) throw new ProviderError('server', 'Máy chủ SANO trả về job không có mã.')
      sent.add(req.key)
      const state = STATES[String(b.status)]
      if (state) states.set(b.id, state)
      return { remoteId: b.id }
    },

    mayHaveSent: (key) => sent.has(key),

    async poll(remoteIds) {
      const out = await Promise.all(
        remoteIds.map(async (id): Promise<RemoteStatus | null> => {
          const res = await call(jobPath(id))
          if (res.status === 404) return { remoteId: id, state: 'failed', error: 'Máy chủ SANO không còn job này.' }
          if (!res.ok) throw new ProviderError('server', `Máy chủ SANO trả lỗi khi hỏi trạng thái job (${await serverText(res)}).`)
          const b = await bodyOf(res)
          const state = STATES[String(b?.status)]
          if (!state) return null // 'unknown' (or a status this build does not know): no news, asked again next time
          states.set(id, state)
          const progress = typeof b?.progress === 'number' ? { progress: b.progress } : {}
          const error = state === 'failed' ? { error: typeof b?.error === 'string' && b.error.trim() ? b.error.trim() : 'Máy chủ SANO báo job lỗi.' } : {}
          return { remoteId: id, state, ...progress, ...error }
        }),
      )
      return out.filter((s): s is RemoteStatus => !!s)
    },

    // shortcut: a cut download starts again from 0 on the engine's next try; resume with Range when videos get big.
    async fetchResult(remoteId, opts = {}) {
      const res = await call(`${jobPath(remoteId)}/result`, opts.signal ? { signal: opts.signal } : {})
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
      opts.onProgress?.({ received, total })
      return { video: new Blob(chunks as BlobPart[], { type: res.headers.get('Content-Type') || 'video/mp4' }) }
    },

    async cancel(remoteId) {
      const known = states.get(remoteId)
      if (known && known !== 'queued') return // SANO stops a job only while it is queued
      try {
        const res = await call(`${jobPath(remoteId)}/cancel`, { method: 'POST' })
        const state = res.ok ? STATES[String((await bodyOf(res))?.status)] : undefined
        if (state) states.set(remoteId, state)
      } catch {
        // never thrown at the engine (it does not await it): the job runs on and polling says how it ends
      }
    },

    reset() {
      caps = null
      states.clear()
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
        return (e as ProviderError).code === 'login-required' ? 'login' : caps ? 'kept' : 'failed'
      }
    },
  }
}
