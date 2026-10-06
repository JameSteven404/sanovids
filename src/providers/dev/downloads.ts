// The video downloads of electron/main.cjs (its <canvasapp-downloads> block), ported to TypeScript so development mode
// runs exactly what the desktop app runs: pieces pulled by the page, one download slot held from open to end, idle /
// pull-idle / overall timeouts, the 1 GB cap, Range + If-Range only with a strong validator, refusals and their texts.
// Pure (no stores, no timers of its own: they are injected). providers/__tests__/gatewayDownloads.test.ts runs main's
// own block next to this one on the same cases: keep both in sync (names, constants, decisions, texts).
//
// Development-mode extras (not in main): DEV_DOWNLOAD_CHUNK_BYTES / DEV_DOWNLOAD_IDLE_MS / DEV_DOWNLOAD_MAX_MS (dev
// videos are small and a developer does not wait 60 s, nor 60 min) and createDevLane() — the 'download' lane of
// <canvasapp-lanes> for the dev bridge. main's <canvasapp-net-get> (https-only redirects) has no port: the dev bridge's
// fetch rejects with code 'insecure-redirect' when the simulated site redirects to http.

export const CANVASAPP_VIDEO_MAX_BYTES = 1024 * 1024 * 1024
export const CANVASAPP_DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024
export const CANVASAPP_DOWNLOAD_FLUSH_MS = 1000
export const CANVASAPP_DOWNLOAD_HEADERS_MS = 5 * 60_000
export const CANVASAPP_DOWNLOAD_IDLE_MS = 60_000
export const CANVASAPP_DOWNLOAD_PULL_IDLE_MS = 30_000
export const CANVASAPP_DOWNLOAD_MAX_MS = 60 * 60_000
export const CANVASAPP_DOWNLOAD_MAX_SESSIONS = 16
export const CANVASAPP_DOWNLOAD_ERROR_BODY_BYTES = 64 * 1024
export const CANVASAPP_DOWNLOAD_TAG_MS = 10 * 60_000
export const CANVASAPP_DOWNLOAD_MAX_TAGS = 64
export const CANVASAPP_DOWNLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Pieces in development mode: 64 KiB, so the progress of a small dev video is visible. */
export const DEV_DOWNLOAD_CHUNK_BYTES = 64 * 1024
/** No byte for this long → the download stops (main: 60 s). */
export const DEV_DOWNLOAD_IDLE_MS = 10_000
/** One connection open this long → 'too-slow' (main: 60 min), so a slow download reaches it in development mode. */
export const DEV_DOWNLOAD_MAX_MS = 2 * 60_000

export type Timer = unknown
export type SetTimer = (fn: () => void, ms: number) => Timer
export type ClearTimer = (t: Timer) => void

export type PumpReason = 'idle' | 'cut' | 'length' | 'size' | 'closed' | 'max'
export type PumpAnswer = { bytes: Uint8Array } | { done: true } | { error: 'network' | 'too-large'; reason: PumpReason }

/** The body reader a pump reads (a web ReadableStreamDefaultReader, or a fake). */
export interface ByteReader {
  read(): Promise<{ done: boolean; value?: unknown }> | { done: boolean; value?: unknown }
  cancel(): Promise<unknown> | unknown
}

export interface DownloadPlanInput {
  status: number
  from: number
  contentLength: string | null
  contentRange: string | null
  contentEncoding: string | null
  acceptRanges: string | null
  /** The answer's strongValidator. */
  validator: string | null
  /** The validator sent with If-Range (a resume), else null. */
  sent: string | null
  maxBytes: number
}

export type DownloadPlan =
  | { kind: 'answer' }
  | { kind: 'bad-range' }
  | { kind: 'too-large' }
  | { kind: 'stream'; from: number; end: number | null; total: number | null; resumable: boolean }

export function parseContentLength(v: unknown): number | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^\d{1,15}$/.test(s) ? Number(s) : null
}

export function parseContentRange(v: unknown): { start: number; end: number; total: number | null } | null {
  const m = typeof v === 'string' ? /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/i.exec(v.trim()) : null
  if (!m) return null
  const start = Number(m[1])
  const end = Number(m[2])
  const total = m[3] === '*' ? null : Number(m[3])
  if (start > end || (total !== null && end >= total)) return null
  return { start, end, total }
}

export function downloadStartByte(v: unknown, maxBytes: number): number {
  return Number.isSafeInteger(v) && (v as number) > 0 && (v as number) < maxBytes ? (v as number) : 0
}

export function strongValidator(etag: unknown, lastModified: unknown): string | null {
  const e = typeof etag === 'string' ? etag.trim() : ''
  if (/^"[\x21\x23-\x7e]{1,200}"$/.test(e)) return e
  const d = typeof lastModified === 'string' ? lastModified.trim() : ''
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(d)) return d
  return null
}

export function downloadHeaders(from: number, validator: string | null): Record<string, string> {
  const h: Record<string, string> = { Accept: 'video/mp4,*/*' }
  if (from > 0 && validator) {
    h.Range = `bytes=${from}-`
    h['If-Range'] = validator
  }
  return h
}

export function downloadPlan(o: DownloadPlanInput): DownloadPlan {
  const from = o.from > 0 ? o.from : 0
  const enc = typeof o.contentEncoding === 'string' ? o.contentEncoding.trim() : ''
  const encoded = enc !== '' && !/^identity$/i.test(enc)
  if (o.status === 416 && from > 0) return { kind: 'bad-range' }
  if (o.status !== 200 && o.status !== 206) return { kind: 'answer' }
  if (o.status === 206) {
    const r = encoded ? null : parseContentRange(o.contentRange)
    if (!r || r.start !== from || r.total === null) return { kind: 'bad-range' }
    // RFC 9110 §15.3.7: a 206 carries the validator a 200 would — it must be the one If-Range named
    if (from > 0 && (!o.sent || o.validator !== o.sent)) return { kind: 'bad-range' }
    if (r.total > o.maxBytes) return { kind: 'too-large' }
    return { kind: 'stream', from: r.start, end: r.end + 1, total: r.total, resumable: !!o.validator }
  }
  const len = encoded ? null : parseContentLength(o.contentLength)
  if (len !== null && len > o.maxBytes) return { kind: 'too-large' }
  const ranges = typeof o.acceptRanges === 'string' && /^bytes$/i.test(o.acceptRanges.trim())
  return { kind: 'stream', from: 0, end: len, total: len, resumable: !encoded && ranges && !!o.validator }
}

export interface PumpOptions {
  reader: ByteReader
  start: number
  end: number | null
  maxBytes: number
  chunkBytes: number
  flushMs: number
  idleMs: number
  setTimer: SetTimer
  clearTimer: ClearTimer
}

export interface DownloadPump {
  read(): Promise<PumpAnswer>
  abort(reason: PumpReason): void
  cancel(): void
  received(): number
}

export function createDownloadPump(o: PumpOptions): DownloadPump {
  const reader = o.reader
  const start = o.start > 0 ? o.start : 0
  const end = typeof o.end === 'number' ? o.end : null
  let queue: Uint8Array[] = []
  let queued = 0
  let received = 0
  let pulling = false
  let eof = false
  let finished = false
  let failure: Extract<PumpAnswer, { error: string }> | null = null
  let waiter: { resolve: (a: PumpAnswer) => void; flushDue: boolean; timer: Timer } | null = null
  let idleTimer: Timer | null = null

  const stopIdle = () => {
    if (idleTimer !== null) o.clearTimer(idleTimer)
    idleTimer = null
  }

  function fail(reason: PumpReason) {
    if (failure || finished) return
    failure = { error: reason === 'size' ? 'too-large' : 'network', reason }
    stopIdle()
    // a broken / stalled connection: what arrived before is still the video's start (handed out first, for a resume)
    if (reason !== 'cut' && reason !== 'idle') {
      queue = []
      queued = 0
    }
    try {
      const p = reader.cancel() as { then?: unknown } | undefined
      if (p && typeof p.then === 'function') (p as Promise<unknown>).then(undefined, () => undefined)
    } catch {
      /* already closed */
    }
    answer()
  }

  function take(): Uint8Array {
    const n = Math.min(o.chunkBytes, queued)
    const out = new Uint8Array(n)
    let off = 0
    while (off < n) {
      const head = queue[0]
      const k = Math.min(head.byteLength, n - off)
      out.set(k === head.byteLength ? head : head.subarray(0, k), off)
      off += k
      if (k === head.byteLength) queue.shift()
      else queue[0] = head.subarray(k)
    }
    queued -= n
    return out
  }

  function answer() {
    if (!waiter) return
    let out: PumpAnswer
    if (failure) out = queued > 0 ? { bytes: take() } : failure
    else if (queued >= o.chunkBytes || (queued > 0 && (eof || waiter.flushDue))) out = { bytes: take() }
    else if (eof) {
      finished = true
      out = { done: true }
    } else {
      pull()
      return
    }
    const w = waiter
    waiter = null
    o.clearTimer(w.timer)
    w.resolve(out)
  }

  function pull() {
    if (pulling || eof || failure) return
    pulling = true
    idleTimer = o.setTimer(() => {
      idleTimer = null
      fail('idle')
    }, o.idleMs)
    let p: Promise<{ done: boolean; value?: unknown }>
    try {
      p = Promise.resolve(reader.read())
    } catch (e) {
      p = Promise.reject(e)
    }
    p.then(
      (r) => {
        pulling = false
        stopIdle()
        if (failure) return
        if (!r || r.done) {
          if (end !== null && start + received !== end) return fail('length')
          eof = true
          return answer()
        }
        const v = r.value
        if (!v || !ArrayBuffer.isView(v)) return fail('cut')
        const chunk = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
        received += chunk.byteLength
        if (start + received > o.maxBytes) return fail('size')
        if (end !== null && start + received > end) return fail('length')
        if (chunk.byteLength) {
          queue.push(chunk)
          queued += chunk.byteLength
        }
        answer()
      },
      () => {
        pulling = false
        stopIdle()
        fail('cut')
      },
    )
  }

  function read(): Promise<PumpAnswer> {
    if (failure && queued === 0) return Promise.resolve(failure)
    if (waiter) {
      fail('closed') // a second read at once: never hand out pieces out of order
      return Promise.resolve(failure as unknown as PumpAnswer)
    }
    if (finished) return Promise.resolve({ done: true })
    return new Promise((resolve) => {
      const w: { resolve: (a: PumpAnswer) => void; flushDue: boolean; timer: Timer } = { resolve, flushDue: false, timer: null }
      w.timer = o.setTimer(() => {
        if (waiter !== w) return
        w.flushDue = true
        answer()
      }, o.flushMs)
      waiter = w
      answer()
    })
  }

  return { read, abort: (reason) => fail(reason), cancel: () => fail('closed'), received: () => received }
}

export function downloadSizeText(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  const n = gb >= 1 ? `${Math.round(gb * 10) / 10} GB` : `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
  return n.replace('.', ',')
}

export interface FailureOptions {
  idleMs?: number
  maxMs?: number
  maxBytes?: number
}

export function downloadFailure(reason: unknown, o?: FailureOptions): { code: string; message: string } {
  const opt = o || {}
  const secs = Math.max(1, Math.round((opt.idleMs || CANVASAPP_DOWNLOAD_IDLE_MS) / 1000))
  const mins = Math.max(1, Math.round((opt.maxMs || CANVASAPP_DOWNLOAD_MAX_MS) / 60_000))
  switch (reason) {
    case 'idle':
      return { code: 'network', message: `canvasapp.io.vn ngừng gửi video giữa chừng (${secs} giây không nhận thêm dữ liệu).` }
    case 'cut':
      return { code: 'network', message: 'Mất kết nối khi đang tải video từ canvasapp.io.vn.' }
    case 'length':
      return { code: 'network', message: 'Video tải về không khớp dung lượng canvasapp.io.vn báo (kết nối bị đóng giữa chừng).' }
    case 'size':
      return { code: 'too-large', message: `Video lớn hơn ${downloadSizeText(opt.maxBytes || CANVASAPP_VIDEO_MAX_BYTES)} — SanoVids không tải về máy được.` }
    case 'max':
      // its own code: the page continues on a new connection only when it can resume, never starts again from 0
      return { code: 'too-slow', message: `Tải video quá ${mins} phút nên SanoVids dừng lại.` }
    default:
      return { code: 'gone', message: 'Lượt tải video này đã kết thúc.' }
  }
}

/** A body that can hand out a reader (a web ReadableStream, or a fake). */
export interface ByteBody {
  getReader(): ByteReader
  cancel?(): Promise<unknown> | unknown
}

export async function readErrorBody(body: unknown, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const b = body as ByteBody | null | undefined
  if (!b || typeof b.getReader !== 'function') return ''
  let reader: ByteReader
  try {
    reader = b.getReader()
  } catch {
    return ''
  }
  const parts: Uint8Array[] = []
  let size = 0
  const stop = () => {
    try {
      const p = reader.cancel() as { then?: unknown } | undefined
      if (p && typeof p.then === 'function') (p as Promise<unknown>).then(undefined, () => undefined)
    } catch {
      /* already closed */
    }
  }
  if (signal) {
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  }
  try {
    while (size < maxBytes) {
      const r = await reader.read()
      if (!r || r.done || !r.value || !ArrayBuffer.isView(r.value)) break
      const v = r.value
      const piece = new Uint8Array(v.buffer, v.byteOffset, Math.min(v.byteLength, maxBytes - size)).slice()
      parts.push(piece)
      size += piece.byteLength
    }
  } catch {
    /* cut: what came is enough */
  }
  if (signal) signal.removeEventListener('abort', stop)
  stop()
  const all = new Uint8Array(size)
  let off = 0
  for (const p of parts) {
    all.set(p, off)
    off += p.byteLength
  }
  return new TextDecoder().decode(all)
}

export interface DownloadAnswer {
  ok: true
  status: number
  contentType: string
  json?: unknown
  text?: string
}

export function downloadAnswer(status: number, contentType: string, text: string): DownloadAnswer {
  const out: DownloadAnswer = { ok: true, status, contentType }
  if (/json/i.test(contentType)) {
    try {
      out.json = JSON.parse(text)
    } catch {
      out.text = text.slice(0, 2000)
    }
  } else {
    out.text = text.slice(0, 2000)
  }
  return out
}

/** What deps.fetch resolves to: the parts of a web Response the downloads use. */
export interface ResponseLike {
  status: number
  headers?: { get(name: string): string | null }
  body?: ByteBody | null
}

export interface DownloadLimits {
  maxBytes: number
  chunkBytes: number
  flushMs: number
  headersMs: number
  idleMs: number
  pullIdleMs: number
  maxMs: number
  maxSessions: number
  errorBodyBytes: number
}

export interface DownloadDeps {
  fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<ResponseLike>
  withSlot(fn: () => Promise<unknown>): Promise<unknown> | unknown
  matchRoute(path: unknown): { binary: boolean; url: string; key: string } | null
  setTimer: SetTimer
  clearTimer: ClearTimer
  now(): number
  limits?: Partial<DownloadLimits>
}

export type Refusal = { ok: false; code: string; message: string }
export type OpenAnswer =
  | { ok: true; id: string; status: number; contentType: string; from: number; total: number | null; resumable: boolean }
  | DownloadAnswer
  | Refusal
export type ReadAnswer = { ok: true; done: false; bytes: Uint8Array } | { ok: true; done: true } | Refusal

export interface DownloadSessions {
  open(owner: unknown, args: unknown): Promise<OpenAnswer>
  read(owner: unknown, args: unknown): Promise<ReadAnswer>
  close(owner: unknown, args: unknown): { ok: true }
  closeAll(owner?: unknown): void
  size(): number
}

interface Session {
  id: string
  owner: unknown
  key: string
  controller: AbortController
  pump: DownloadPump | null
  release: (() => void) | null
  ended: boolean
  reading: boolean
  headerTimer: Timer | null
  pullTimer: Timer | null
  maxTimer: Timer | null
  timedOut: boolean
  /** The validator of this connection's answer (refreshed in `tags` when it ends). */
  validator: string | null
}

export function createDownloadSessions(deps: DownloadDeps): DownloadSessions {
  const lim: DownloadLimits = Object.assign(
    {
      maxBytes: CANVASAPP_VIDEO_MAX_BYTES,
      chunkBytes: CANVASAPP_DOWNLOAD_CHUNK_BYTES,
      flushMs: CANVASAPP_DOWNLOAD_FLUSH_MS,
      headersMs: CANVASAPP_DOWNLOAD_HEADERS_MS,
      idleMs: CANVASAPP_DOWNLOAD_IDLE_MS,
      pullIdleMs: CANVASAPP_DOWNLOAD_PULL_IDLE_MS,
      maxMs: CANVASAPP_DOWNLOAD_MAX_MS,
      maxSessions: CANVASAPP_DOWNLOAD_MAX_SESSIONS,
      errorBodyBytes: CANVASAPP_DOWNLOAD_ERROR_BODY_BYTES,
    },
    deps.limits || {},
  )
  const sessions = new Map<string, Session>()
  const tags = new Map<string, { validator: string; at: number }>()
  const refusal = (code: string, message: string): Refusal => ({ ok: false, code, message })
  const failure = (reason: unknown): Refusal => {
    const f = downloadFailure(reason, lim)
    return refusal(f.code, f.message)
  }

  function tagOf(key: string): string | null {
    const t = tags.get(key)
    if (!t) return null
    if (deps.now() - t.at >= CANVASAPP_DOWNLOAD_TAG_MS) {
      tags.delete(key)
      return null
    }
    return t.validator
  }
  function rememberTag(key: string, validator: string) {
    tags.delete(key)
    tags.set(key, { validator, at: deps.now() })
    while (tags.size > CANVASAPP_DOWNLOAD_MAX_TAGS) tags.delete(tags.keys().next().value as string)
  }

  function end(s: Session) {
    if (s.ended) return
    s.ended = true
    for (const k of ['headerTimer', 'pullTimer', 'maxTimer'] as const) {
      if (s[k] !== null) deps.clearTimer(s[k])
      s[k] = null
    }
    sessions.delete(s.id)
    // the clock of the video's validator starts again: a cut after a long download can still resume
    if (s.validator) rememberTag(s.key, s.validator)
    if (s.pump) s.pump.cancel()
    try {
      s.controller.abort()
    } catch {
      /* nothing in flight */
    }
    const release = s.release
    s.release = null
    if (release) release()
  }

  function armPull(s: Session) {
    if (s.pullTimer !== null) deps.clearTimer(s.pullTimer)
    s.pullTimer = deps.setTimer(() => {
      s.pullTimer = null
      end(s)
    }, lim.pullIdleMs)
  }

  function owned(owner: unknown, args: unknown): Session | null {
    const a = args as { id?: unknown } | null
    const id = a && typeof a === 'object' && typeof a.id === 'string' ? a.id : ''
    if (!CANVASAPP_DOWNLOAD_ID_RE.test(id)) return null
    const s = sessions.get(id)
    return s && s.owner === owner ? s : null
  }

  function cancelBody(res: ResponseLike | null | undefined) {
    try {
      const p = res && res.body && typeof res.body.cancel === 'function' ? (res.body.cancel() as { then?: unknown } | undefined) : null
      if (p && typeof p.then === 'function') (p as Promise<unknown>).then(undefined, () => undefined)
    } catch {
      /* already closed */
    }
  }

  async function open(owner: unknown, args: unknown): Promise<OpenAnswer> {
    const a = (args && typeof args === 'object' ? args : {}) as { id?: unknown; path?: unknown; from?: unknown }
    const id = typeof a.id === 'string' && CANVASAPP_DOWNLOAD_ID_RE.test(a.id) ? a.id : null
    if (!id) return refusal('bad-request', 'Mã lượt tải video không hợp lệ.')
    if (sessions.has(id)) return refusal('busy', 'Mã lượt tải video này đang được dùng.')
    const m = deps.matchRoute(a.path)
    if (!m || !m.binary) return refusal('not-allowed', `SanoVids không được phép tải ${String(a.path).slice(0, 80)}.`)
    if (sessions.size >= lim.maxSessions) return refusal('busy', 'Đang tải quá nhiều video cùng lúc — SanoVids tải video này sau.')
    const s: Session = {
      id,
      owner,
      key: m.key,
      controller: new AbortController(),
      pump: null,
      release: null,
      ended: false,
      reading: false,
      headerTimer: null,
      pullTimer: null,
      maxTimer: null,
      timedOut: false,
      validator: null,
    }
    sessions.set(id, s)

    const got = await new Promise<boolean>((resolve) => {
      const held = () => {
        if (s.ended) {
          resolve(false)
          return Promise.resolve()
        }
        return new Promise<void>((done) => {
          s.release = done
          resolve(true)
        })
      }
      let slot: Promise<unknown>
      try {
        slot = Promise.resolve(deps.withSlot(held))
      } catch (e) {
        slot = Promise.reject(e)
      }
      slot.then(undefined, () => resolve(false))
    })
    if (!got || s.ended) {
      end(s)
      return failure('closed')
    }

    const validator = tagOf(s.key)
    const from = validator ? downloadStartByte(a.from, lim.maxBytes) : 0
    s.headerTimer = deps.setTimer(() => {
      s.headerTimer = null
      s.timedOut = true
      s.controller.abort()
    }, lim.headersMs)
    let res: ResponseLike
    try {
      res = await deps.fetch(m.url, { headers: downloadHeaders(from, validator), signal: s.controller.signal })
    } catch (e) {
      const closed = s.ended && !s.timedOut
      end(s)
      if (closed) return failure('closed')
      if ((e as { code?: unknown } | null)?.code === 'insecure-redirect') {
        return refusal('not-allowed', 'canvasapp.io.vn chuyển việc tải video sang một địa chỉ không mã hoá (http) — SanoVids không tải.')
      }
      return refusal(
        'network',
        s.timedOut ? 'canvasapp.io.vn không phản hồi (quá thời gian chờ).' : `Không kết nối được tới canvasapp.io.vn (${(e as Error | null)?.message || e}).`,
      )
    }
    if (s.ended) {
      cancelBody(res)
      return failure('closed')
    }
    if (!res || typeof res.status !== 'number') {
      end(s)
      return refusal('network', 'canvasapp.io.vn trả về câu trả lời lạ.')
    }
    const header = (name: string): string | null => {
      const v = res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null
      return typeof v === 'string' ? v : null
    }
    const contentType = header('content-type') || ''
    const validatorNow = strongValidator(header('etag'), header('last-modified'))
    const plan = downloadPlan({
      status: res.status,
      from,
      contentLength: header('content-length'),
      contentRange: header('content-range'),
      contentEncoding: header('content-encoding'),
      acceptRanges: header('accept-ranges'),
      validator: validatorNow,
      sent: from > 0 ? validator : null,
      maxBytes: lim.maxBytes,
    })
    if (plan.kind === 'answer') {
      const text = await readErrorBody(res.body, lim.errorBodyBytes, s.controller.signal)
      end(s)
      return downloadAnswer(res.status, contentType, text)
    }
    if (plan.kind !== 'stream') {
      cancelBody(res)
      end(s)
      if (plan.kind === 'too-large') return failure('size')
      return refusal('bad-range', 'canvasapp.io.vn trả về phần video không khớp chỗ đang tải.')
    }
    deps.clearTimer(s.headerTimer)
    s.headerTimer = null
    s.validator = validatorNow
    if (validatorNow) rememberTag(s.key, validatorNow)
    else tags.delete(s.key)
    let reader: ByteReader | null = null
    try {
      reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null
    } catch {
      reader = null
    }
    if (!reader) reader = { read: () => Promise.resolve({ done: true }), cancel: () => Promise.resolve() }
    s.pump = createDownloadPump({
      reader,
      start: plan.from,
      end: plan.end,
      maxBytes: lim.maxBytes,
      chunkBytes: lim.chunkBytes,
      flushMs: lim.flushMs,
      idleMs: lim.idleMs,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
    })
    s.maxTimer = deps.setTimer(() => {
      s.maxTimer = null
      if (s.pump) s.pump.abort('max')
    }, lim.maxMs)
    armPull(s)
    return { ok: true, id, status: res.status, contentType, from: plan.from, total: plan.total, resumable: plan.resumable }
  }

  async function read(owner: unknown, args: unknown): Promise<ReadAnswer> {
    const s = owned(owner, args)
    if (!s) return failure('closed')
    if (!s.pump || s.reading) return refusal('busy', 'Lượt tải video này đang mở hoặc đang được đọc.')
    s.reading = true
    if (s.pullTimer !== null) deps.clearTimer(s.pullTimer)
    s.pullTimer = null
    try {
      const r = await s.pump.read()
      if ('bytes' in r && r.bytes) return { ok: true, done: false, bytes: r.bytes }
      end(s)
      if ('done' in r && r.done) return { ok: true, done: true }
      return failure('reason' in r ? r.reason : undefined)
    } catch (e) {
      end(s)
      return refusal('network', `Không đọc được video (${(e as Error | null)?.message || e}).`)
    } finally {
      s.reading = false
      if (!s.ended) armPull(s)
    }
  }

  function close(owner: unknown, args: unknown): { ok: true } {
    const s = owned(owner, args)
    if (s) end(s)
    return { ok: true }
  }

  function closeAll(owner?: unknown) {
    for (const s of [...sessions.values()]) if (owner === undefined || s.owner === owner) end(s)
  }

  return { open, read, close, closeAll, size: () => sessions.size }
}

// ---- development-mode only ----

/** The 'download' lane of main's <canvasapp-lanes> (size slots, first come first served) for the dev bridge. */
export function createDevLane(size: number): { withSlot: (fn: () => Promise<unknown>) => Promise<unknown>; active: () => number } {
  let active = 0
  const waiters: (() => void)[] = []
  async function withSlot(fn: () => Promise<unknown>): Promise<unknown> {
    while (active >= size) await new Promise<void>((resolve) => waiters.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      const next = waiters.shift()
      if (next) next()
    }
  }
  return { withSlot, active: () => active }
}
