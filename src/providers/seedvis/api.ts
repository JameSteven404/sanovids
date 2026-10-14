// seedvis API calls over the desktop bridge (window.bdpDesktop.seedvis, contract.ts SeedvisBridge) and the defensive
// parsers of what seedvis answers. The renderer never builds a URL, never sees the API key and never reads a download
// link: main builds every path from a symbolic route (contract SEEDVIS_IPC_ROUTES) and records the result URLs itself.
//
// Every call here NEVER throws: an IPC rejection or a malformed bridge answer becomes a SeedvisBridgeFailure (for a
// create without `sent`, which the adapter reads as "may have reached seedvis"). All answers are untrusted data.
//
// Error bodies come in three formats (plan §7.1), all read by parseApiError:
//   native  { error: { code, message }, errors: { "reference_images[1]": ["…"] } }
//   OpenAI  { error: { code | type, message, param: "image" } }
//   Google  { error: { code: 400, message, status: "INVALID_ARGUMENT" } }
import type {
  SeedvisAccountInfo,
  SeedvisActionResult,
  SeedvisBridge,
  SeedvisBridgeFailure,
  SeedvisDownloadArgs,
  SeedvisDownloadOpen,
  SeedvisDownloadRead,
  SeedvisGenerationBody,
  SeedvisKeyStatus,
  SeedvisRemoteStatus,
  SeedvisRequestImage,
  SeedvisResponse,
  SeedvisResponseHeaders,
} from './contract'
import { SEEDVIS_ACCOUNT_INFO_FIELDS } from './contract'
import { bridgeFailure } from './transport'

/** seedvis job ids main accepts (§10.2): what a remote id must look like before it is polled / downloaded. */
export const SEEDVIS_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** An error / status code as SanoVids keeps it: short, plain characters only (never free text, never a URL). */
export function sanitizeCode(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(s) ? s : null
}

/** A request id header value (X-Request-Id): plain characters only. */
export function sanitizeRequestId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(s) ? s : null
}

/**
 * Free text from seedvis (an error message) made safe to show and keep: links, bearer tokens and key-shaped strings
 * removed (main already redacts — this is the renderer's own guard), whitespace collapsed, at most 300 characters.
 */
export function sanitizeMessage(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer ***')
    .replace(/\bsv_(?:live|test)_[A-Za-z0-9_-]*/gi, '***')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return null
  return s.length > 300 ? `${s.slice(0, 299)}…` : s
}

/** Retry-After in seconds (the only form main passes on) → ms, 1 s – 30 min; anything else → null. */
export function parseRetryAfter(v: unknown): number | null {
  if (typeof v !== 'string' && !finite(v)) return null
  const n = typeof v === 'string' ? (/^\s*\d{1,6}\s*$/.test(v) ? Number(v) : NaN) : v
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(n, 1800) * 1000
}

export type SeedvisErrorFormat = 'native' | 'openai' | 'google' | 'none'

/** A seedvis error answer, read defensively. */
export interface SeedvisApiErrorInfo {
  /** HTTP status (0 = no HTTP answer). */
  status: number
  /** error.code (string), else Google's error.status, else a top-level `code` string. */
  code: string | null
  message: string | null
  /** The request field the error names: native `errors` key, OpenAI `param`, or `error.field`. */
  field: string | null
  /** The body was a JSON object (an HTML maintenance page or an empty body is not). */
  json: boolean
  format: SeedvisErrorFormat
  requestId: string | null
  retryAfterMs: number | null
}

export function parseApiError(status: number, json: unknown, headers?: SeedvisResponseHeaders | null): SeedvisApiErrorInfo {
  const root = obj(json)
  const err = obj(root?.error)
  const errorsMap = obj(root?.errors)
  let code: string | null = null
  let format: SeedvisErrorFormat = 'none'
  if (err) {
    code = sanitizeCode(err.code) ?? sanitizeCode(err.status) ?? sanitizeCode(err.type)
    format = errorsMap ? 'native' : typeof err.param === 'string' || err.type !== undefined ? 'openai' : typeof err.status === 'string' && finite(err.code) ? 'google' : 'native'
  } else if (root) {
    code = sanitizeCode(root.code) ?? sanitizeCode(root.error)
    if (errorsMap || code) format = 'native'
  }
  const message = sanitizeMessage(err?.message) ?? sanitizeMessage(root?.message) ?? (typeof root?.error === 'string' ? sanitizeMessage(root.error) : null)
  const firstErrorsKey = errorsMap ? Object.keys(errorsMap).find((k) => /^[A-Za-z_][A-Za-z0-9_]*(\[\d{1,3}\])?$/.test(k)) ?? null : null
  const param = typeof err?.param === 'string' ? err.param : typeof err?.field === 'string' ? err.field : null
  const field = firstErrorsKey ?? (param && /^[A-Za-z_][A-Za-z0-9_]*(\[\d{1,3}\])?$/.test(param) ? param : null)
  return {
    status: finite(status) ? status : 0,
    code,
    message,
    field,
    json: !!root,
    format,
    requestId: sanitizeRequestId(headers?.['X-Request-Id']),
    retryAfterMs: parseRetryAfter(headers?.['Retry-After']),
  }
}

/** A JSON error code that names the job itself as unknown. Only codes recorded from seedvis / the simulation count. */
export const JOB_NOT_FOUND_CODES: readonly string[] = ['generation_not_found']

/**
 * The answer to a poll names the job as not found, as a JSON error body with a known code (§6.9 rule 1). An HTML page,
 * an empty body, a model_* code or any unknown code never counts — the job may well exist (a 202 job created in the
 * background, a maintenance page).
 */
export function isJsonJobNotFound(status: number, json: unknown): boolean {
  if (status !== 404) return false
  const info = parseApiError(status, json)
  return info.json && !!info.code && !info.code.startsWith('model_') && JOB_NOT_FOUND_CODES.includes(info.code)
}

/** One seedvis generation (a job), as far as SanoVids needs it. Never any URL. */
export interface SeedvisGeneration {
  /** null when the answer carried no usable id (a safe non-negative integer id is taken as its decimal string). */
  id: string | null
  status: SeedvisRemoteStatus | 'unknown'
  /** The status as seedvis wrote it (sanitized code, lower case), kept for a status SanoVids does not know. */
  rawStatus: string | null
  isFinal: boolean
  error: { code: string | null; message: string | null } | null
  queue: { position: number | null; estimatedStartSeconds: number | null } | null
  /** next.after_seconds: when asking again makes sense (seconds). */
  nextAfterSeconds: number | null
  /** How many outputs the job lists (their URLs stay in main). */
  outputCount: number
  /** references[]: (field, index, role) pairs seedvis says it received; null when absent. */
  references: { field: string; index: number; role: string | null }[] | null
  cancellation: { outcome: string | null; runningOutputs: number | null } | null
  /** 0–100 when seedvis reports a progress number. */
  progress: number | null
}

const STATUSES: readonly SeedvisRemoteStatus[] = ['queued', 'processing', 'completed', 'failed']

/** A generation answer ({ data: {…} } or the object itself), or null when it is not one. */
export function parseGeneration(json: unknown): SeedvisGeneration | null {
  const root = obj(json)
  if (!root) return null
  const d = obj(root.data) ?? root
  const id = generationId(d.id ?? d.generation_id)
  const rawStatus = typeof d.status === 'string' ? sanitizeCode(d.status.trim().toLowerCase()) : null
  const status: SeedvisGeneration['status'] = rawStatus && (STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as SeedvisRemoteStatus) : 'unknown'
  const isFinal = d.is_final === true || status === 'completed' || status === 'failed'
  const e = obj(d.error)
  const error = e ? { code: sanitizeCode(e.code) ?? sanitizeCode(e.status), message: sanitizeMessage(e.message) } : typeof d.error === 'string' ? { code: sanitizeCode(d.error), message: null } : null
  const q = obj(d.queue)
  const queue = q
    ? {
        position: finite(q.position) && q.position >= 0 ? Math.floor(q.position) : null,
        estimatedStartSeconds: finite(q.estimated_start_seconds) && q.estimated_start_seconds >= 0 ? q.estimated_start_seconds : null,
      }
    : null
  const next = obj(d.next)
  const nextAfterSeconds = next && finite(next.after_seconds) && next.after_seconds >= 0 ? Math.min(next.after_seconds, 3600) : null
  const outputs = Array.isArray(d.outputs) ? d.outputs : Array.isArray(d.output) ? d.output : []
  const refs = Array.isArray(d.references)
    ? d.references
        .map((r) => obj(r))
        .filter((r): r is Record<string, unknown> => !!r && typeof r.field === 'string' && finite(r.index))
        .map((r) => ({ field: String(r.field).slice(0, 40), index: Math.floor(r.index as number), role: typeof r.role === 'string' ? r.role.slice(0, 40) : null }))
    : null
  const c = obj(d.cancellation)
  const cancellation = c
    ? { outcome: sanitizeCode(c.outcome), runningOutputs: finite(c.running_outputs) && c.running_outputs >= 0 ? Math.floor(c.running_outputs) : null }
    : null
  const progress = finite(d.progress) && d.progress >= 0 && d.progress <= 100 ? d.progress : null
  return { id, status, rawStatus, isFinal, error, queue, nextAfterSeconds, outputCount: outputs.length, references: refs, cancellation, progress }
}

/** A job id as SanoVids keeps it: a string matching SEEDVIS_ID_RE, or a safe non-negative integer as its decimal string. */
function generationId(v: unknown): string | null {
  const s = typeof v === 'string' ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null
  return s !== null && SEEDVIS_ID_RE.test(s) ? s : null
}

/**
 * The shape of an answer that carried no usable job id, for the log (never a value: only the type of the id field
 * and the field names, sanitized) — so the live test notices how seedvis really answers.
 */
export function idShape(json: unknown): string {
  const root = obj(json)
  if (!root) return json === undefined ? 'no body' : `body ${Array.isArray(json) ? 'array' : typeof json}`
  const d = obj(root.data)
  const where = d ?? root
  const raw = where.id ?? where.generation_id
  const type = raw === undefined ? 'missing' : raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw
  const keys = Object.keys(where)
    .map((k) => sanitizeCode(k) ?? '?')
    .slice(0, 12)
  return `${d ? 'data.' : ''}id=${type} keys=[${keys.join(',')}]`
}

/** /account/info → the allowlisted fields (main already strips everything else; decimals tolerated). */
export function parseAccountInfo(json: unknown): SeedvisAccountInfo | null {
  const root = obj(json)
  if (!root) return null
  const d = obj(root.data) ?? root
  const out: Record<string, unknown> = {}
  for (const k of SEEDVIS_ACCOUNT_INFO_FIELDS) {
    const v = d[k]
    if (k === 'plan') {
      if (typeof v === 'string' && v.length <= 64) out.plan = v
    } else if (k === 'api_enabled') {
      if (typeof v === 'boolean') out.api_enabled = v
    } else if (finite(v) && v >= 0) out[k] = v
    else if (typeof v === 'string' && /^\d{1,12}(\.\d{1,6})?$/.test(v.trim())) out[k] = Number(v)
  }
  return out as SeedvisAccountInfo
}

/** The create call of the adapter. */
export interface CreateArgs {
  idempotencyKey: string
  body: SeedvisGenerationBody
  images?: readonly SeedvisRequestImage[]
  mustFinishBy?: number
}

export interface SeedvisApi {
  create(args: CreateArgs): Promise<SeedvisResponse>
  get(id: string): Promise<SeedvisResponse>
  cancel(id: string): Promise<SeedvisResponse>
  models(): Promise<SeedvisResponse>
  accountInfo(): Promise<SeedvisResponse>
  accountUsage(): Promise<SeedvisResponse>
  keyStatus(): Promise<SeedvisKeyStatus | null>
  /** True when main says the network is up — or cannot say (an unknown answer never blocks). */
  isOnline(): Promise<boolean>
  downloadOpen(args: SeedvisDownloadArgs): Promise<SeedvisDownloadOpen>
  downloadRead(args: { id: string }): Promise<SeedvisDownloadRead>
  downloadClose(args: { id: string }): Promise<SeedvisActionResult>
}

const isFailure = (v: Record<string, unknown>): boolean => v.ok === false && typeof v.code === 'string'

/** A bridge answer to request(): a well-formed SeedvisResponse, else a failure (sent unknown). */
function checkResponse(v: unknown, create: boolean): SeedvisResponse {
  const r = obj(v)
  if (!r) return bridgeFailure('bad-response', create ? undefined : false)
  if (isFailure(r)) {
    const f = r as unknown as SeedvisBridgeFailure
    return {
      ok: false,
      code: f.code,
      message: typeof f.message === 'string' ? f.message : '',
      ...(finite(f.retryAfterMs) && f.retryAfterMs > 0 ? { retryAfterMs: f.retryAfterMs } : {}),
      ...(typeof f.sent === 'boolean' ? { sent: f.sent } : {}),
      ...(finite(f.lastByteAt) ? { lastByteAt: f.lastByteAt } : {}),
    }
  }
  if (r.ok !== true || !finite(r.status)) return bridgeFailure('bad-response', create ? undefined : false)
  const h = obj(r.headers) ?? {}
  const headers: SeedvisResponseHeaders = {}
  for (const name of ['Retry-After', 'Idempotency-Replayed', 'X-Request-Id'] as const) if (typeof h[name] === 'string') headers[name] = h[name] as string
  return {
    ok: true,
    status: r.status,
    ...(r.json !== undefined ? { json: r.json } : {}),
    headers,
    ...(finite(r.lastByteAt) ? { lastByteAt: r.lastByteAt } : {}),
    ...(finite(r.uploadMs) && r.uploadMs >= 0 ? { uploadMs: r.uploadMs } : {}),
  }
}

function checkKeyStatus(v: unknown): SeedvisKeyStatus | null {
  const r = obj(v)
  if (!r || typeof r.hasKey !== 'boolean') return null
  const str = (x: unknown, max: number) => (typeof x === 'string' && x.length <= max ? x : null)
  const problem = r.problem === 'unknown' || r.problem === 'unreadable' ? r.problem : undefined
  return {
    hasKey: r.hasKey,
    hint: str(r.hint, 8),
    tag: str(r.tag, 64),
    savedAt: finite(r.savedAt) ? r.savedAt : null,
    verifiedAt: finite(r.verifiedAt) ? r.verifiedAt : null,
    storage: r.storage === 'safeStorage' ? 'safeStorage' : 'unavailable',
    ...(problem ? { problem } : {}),
  }
}

/** The API over a bridge. `bridge` null (web build) → every call fails 'not-allowed', nothing sent. */
export function createSeedvisApi(bridge: SeedvisBridge | null): SeedvisApi {
  const call = async <T>(fn: (() => Promise<T>) | null, fallback: () => T): Promise<T> => {
    if (!fn) return fallback()
    try {
      return await fn()
    } catch {
      return fallback()
    }
  }
  const notAllowed = () => bridgeFailure('not-allowed', false)
  return {
    create: async (args) => {
      if (!bridge) return notAllowed()
      try {
        return checkResponse(
          await bridge.request({
            route: 'generations.create',
            idempotencyKey: args.idempotencyKey,
            body: args.body,
            ...(args.images?.length ? { images: args.images } : {}),
            ...(finite(args.mustFinishBy) ? { mustFinishBy: args.mustFinishBy } : {}),
          }),
          true,
        )
      } catch {
        // The IPC call itself failed: whether main sent the body is unknown — the adapter treats it as maybe sent.
        return bridgeFailure('network', undefined)
      }
    },
    get: (id) => call(bridge ? async () => checkResponse(await bridge.request({ route: 'generations.get', id }), false) : null, () => (bridge ? bridgeFailure('network', false) : notAllowed())),
    cancel: (id) =>
      call(bridge ? async () => checkResponse(await bridge.request({ route: 'generations.cancel', id }), false) : null, () => (bridge ? bridgeFailure('network', undefined) : notAllowed())),
    models: () => call(bridge ? async () => checkResponse(await bridge.request({ route: 'models' }), false) : null, () => (bridge ? bridgeFailure('network', false) : notAllowed())),
    accountInfo: () => call(bridge ? async () => checkResponse(await bridge.request({ route: 'account.info' }), false) : null, () => (bridge ? bridgeFailure('network', false) : notAllowed())),
    accountUsage: () => call(bridge ? async () => checkResponse(await bridge.request({ route: 'account.usage' }), false) : null, () => (bridge ? bridgeFailure('network', false) : notAllowed())),
    keyStatus: () => call(bridge ? async () => checkKeyStatus(await bridge.keyStatus()) : null, () => null),
    isOnline: () => call(bridge ? async () => (await bridge.isOnline()) !== false : null, () => true),
    downloadOpen: (args) =>
      call(
        bridge
          ? async () => {
              const r = obj(await bridge.downloadOpen(args))
              if (r && r.ok === true && typeof r.id === 'string' && (r.mime === 'video/mp4' || r.mime === 'video/quicktime' || r.mime === 'video/webm')) {
                return { ok: true as const, id: r.id, total: finite(r.total) && r.total >= 0 ? r.total : null, mime: r.mime }
              }
              if (r && isFailure(r)) return checkResponse(r, false) as SeedvisBridgeFailure
              return bridgeFailure('bad-response', false)
            }
          : null,
        () => (bridge ? bridgeFailure('network', false) : notAllowed()),
      ),
    downloadRead: (args) =>
      call(
        bridge
          ? async () => {
              const r = obj(await bridge.downloadRead(args))
              if (r && r.ok === true && r.done === true) return { ok: true as const, done: true as const }
              if (r && r.ok === true && r.done === false && r.bytes instanceof Uint8Array) return { ok: true as const, done: false as const, bytes: r.bytes }
              if (r && isFailure(r)) return checkResponse(r, false) as SeedvisBridgeFailure
              return bridgeFailure('bad-response', false)
            }
          : null,
        () => (bridge ? bridgeFailure('network', false) : notAllowed()),
      ),
    downloadClose: (args) =>
      call(bridge ? async () => ((obj(await bridge.downloadClose(args))?.ok === true ? { ok: true } : bridgeFailure('gone', false)) as SeedvisActionResult) : null, () => ({ ok: true })),
  }
}
