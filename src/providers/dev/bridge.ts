// The desktop gateway (electron/main.cjs) simulated in-app for development mode: a CanvasappBridge — the same
// interface window.bdpDesktop.canvasapp exposes — in front of the dev server (server.ts). The real gateway code
// (transport.ts createDesktopTransport / openCheckout, api.ts, adapter.ts) runs on top of it unchanged.
//
// Like main.cjs it:
//   - refuses anything outside the endpoint allowlist ({ ok:false, code:'not-allowed' }) — and the video stream in
//     request(): it only comes through downloadOpen, like main's matchCanvasappRequest —, JSON bodies over 2 MB and
//     uploads over 20 MB ('too-large'); sends no JSON body with GET / DELETE; sanitizes the multipart filename;
//   - reuses a job-list answer for a short while per project, and forgets it around every POST /api/video-jobs (so a
//     lookup after a lost answer always reads the server);
//   - turns "no answer" into { ok:false, code:'network' } (dev faults 'network' / 'lost-response');
//   - login(): already logged in → done; else opens the login "window" (prompts.ts: a sheet in the app) and resolves
//     with the state once it is closed — concurrent calls share it;
//   - checkout(): one window at a time ('busy'), the URL must be SePay's ('refused'), fields like main's; the simulated
//     SePay sheet answers success / cancel / error (with the order id, as SePay's return to canvasapp does), closed or
//     timeout (15 min) — and tells the dev server what canvasapp says about the order afterwards (paid ~2 s later…);
//   - downloadOpen / downloadRead / downloadClose: main's video downloads (downloads.ts, the port of its
//     <canvasapp-downloads> block) over the dev server's openStream(): pieces (64 KiB here), one of 2 download slots
//     held per download, idle (10 s here) / pull-idle / per-connection (2 min here, main: 60 min) limits, 1 GB cap,
//     Range + If-Range only with the ETag the simulated site sent (DevConfig.rangeSupport), a redirect to http refused
//     (dev fault 'insecure-redirect', main's <canvasapp-net-get>). A download that stops by itself is written to the
//     request log.
// JSON bodies cross it as JSON (a deep copy), like IPC + HTTP would: nothing is shared by reference with the server.
import { checkoutUrlAllowed, parsePaymentReturn } from '../../core/topup'
import type { TransportRequest } from '../canvasapp/api'
import type {
  BridgeCheckoutResponse,
  BridgeDownloadArgs,
  BridgeDownloadOpen,
  BridgeDownloadRead,
  BridgeResponse,
  BridgeStatus,
  CanvasappBridge,
  CheckoutArgs,
} from '../canvasapp/transport'
import {
  createDevLane,
  createDownloadSessions,
  DEV_DOWNLOAD_CHUNK_BYTES,
  DEV_DOWNLOAD_IDLE_MS,
  DEV_DOWNLOAD_MAX_MS,
  type DownloadLimits,
  type ResponseLike,
} from './downloads'
import { pushDevLog, summarizeForLog } from './log'
import { answerDevCheckout, checkoutPromptOpen, closeDevPrompts, openCheckoutPrompt, openLoginPrompt } from './prompts'
import { matchDevRoute, MAX_JSON_BYTES, MAX_UPLOAD_BYTES } from './routes'
import type { DevCanvasapp, DevStreamAnswer } from './server'
import { devWording } from './wording'

/**
 * Job-list answers reused this long (main.cjs: 15 s for the real site, polled every 20 s). The dev engine polls every
 * 3 s and the answer is stamped when it arrives (after the simulated latency): 2 s, so no poll is served stale.
 */
export const DEV_JOB_LIST_CACHE_MS = 2_000
/** main.cjs CANVASAPP_JOBS_FRESH_MS: a `fresh` job-list read reuses a cached answer only this young. */
export const DEV_JOB_LIST_FRESH_MS = 5_000
/** The checkout window closes by itself after this long (main.cjs CHECKOUT_TIMEOUT_MS). */
export const DEV_CHECKOUT_TIMEOUT_MS = 15 * 60_000

const CHECKOUT_MAX_FIELDS = 60
const CHECKOUT_MAX_VALUE = 4000
const CHECKOUT_FIELD_NAME_RE = /^[A-Za-z0-9_.[\]-]{1,100}$/

export interface DevBridgeOptions {
  jobListCacheMs?: number
  checkoutTimeoutMs?: number
  now?: () => number
  /** Write gateway refusals / cache hits to the request log (default true). */
  log?: boolean
  /** Video downloads: main's limits, except pieces of 64 KiB, 10 s without data, 2 min per connection (DEV_DOWNLOAD_*). Tests shorten them. */
  downloadLimits?: Partial<DownloadLimits>
}

/** The simulated gateway, plus what "Xoá dữ liệu máy chủ giả lập" needs of it (dev/index.ts resetDevServer). */
export interface DevBridge extends CanvasappBridge {
  /**
   * The simulated account is about to be wiped: like main's logout, every video download is stopped first (none keeps
   * streaming the old account's video into a take, or holds a download slot) and no cached job list of it is served.
   */
  reset(): void
}

/** The one page that uses the simulated gateway (main keys downloads by the calling page). */
const DEV_PAGE = 'page'

/** A Response-like of the dev server's streamed answer (headers lower-case; a JSON / text answer as its bytes). */
function devResponse(a: Extract<DevStreamAnswer, { ok: true }>): ResponseLike {
  const headers = { get: (name: string) => a.headers[name.toLowerCase()] ?? null }
  if (a.body) {
    const reader = a.body
    return { status: a.status, headers, body: { getReader: () => reader, cancel: () => reader.cancel() } }
  }
  const text = a.json !== undefined ? JSON.stringify(a.json) : (a.text ?? '')
  let sent = false
  const bytes = new TextEncoder().encode(text)
  const reader = {
    read: async () => (sent || !bytes.byteLength ? { done: true } : ((sent = true), { done: false, value: bytes })),
    cancel: async () => undefined,
  }
  return { status: a.status, headers, body: { getReader: () => reader, cancel: async () => undefined } }
}

type Fail = { ok: false; code: string; message: string }
const gatewayError = (code: string, message: string): Fail => ({ ok: false, code, message })

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

function checkoutFields(fields: unknown): Record<string, string> | null {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null
  const entries = Object.entries(fields as Record<string, unknown>)
  if (entries.length > CHECKOUT_MAX_FIELDS) return null
  const out: Record<string, string> = {}
  for (const [name, value] of entries) {
    if (!CHECKOUT_FIELD_NAME_RE.test(name) || typeof value !== 'string' || value.length > CHECKOUT_MAX_VALUE) return null
    out[name] = value
  }
  return out
}

/** The order a checkout pays: from the return URLs SePay would send the user back to, else the checkout URL's path. */
function orderIdOf(checkoutUrl: string, fields: Record<string, string>): string | null {
  for (const k of ['success_url', 'cancel_url', 'error_url']) {
    const ret = fields[k] ? parsePaymentReturn(fields[k]) : null
    if (ret) return ret.orderId
  }
  const m = /\/([A-Za-z0-9_-]{1,80})\/?$/.exec(new URL(checkoutUrl).pathname)
  return m ? m[1] : null
}

export function createDevBridge(server: () => DevCanvasapp, opts: DevBridgeOptions = {}): DevBridge {
  const now = opts.now ?? (() => Date.now())
  const cacheMs = opts.jobListCacheMs ?? DEV_JOB_LIST_CACHE_MS
  const timeoutMs = opts.checkoutTimeoutMs ?? DEV_CHECKOUT_TIMEOUT_MS
  const logging = opts.log !== false
  const listCache = new Map<string, { at: number; result: BridgeResponse }>()
  let jobsEpoch = 0
  let loginInFlight: Promise<BridgeStatus> | null = null
  const downloadLane = createDevLane(2)
  const downloadPaths = new Map<string, string>()
  const downloads = createDownloadSessions({
    // `url` is the allowlisted path itself here (main: the absolute canvasapp URL)
    fetch: (url, init) =>
      new Promise<ResponseLike>((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (init.signal.aborted) return abort()
        init.signal.addEventListener('abort', abort, { once: true })
        const range = /^bytes=(\d+)-$/.exec(init.headers.Range ?? '')
        server()
          .openStream({ path: url, range: range ? { from: Number(range[1]), ifRange: init.headers['If-Range'] ?? null } : null })
          .then(
            (a) => {
              init.signal.removeEventListener('abort', abort)
              // 'insecure-redirect': what main's <canvasapp-net-get> rejects with (the http request is never sent)
              if (!a.ok) reject(Object.assign(new Error(a.message), a.code === 'insecure-redirect' ? { code: a.code } : {}))
              else resolve(devResponse(a))
            },
            (e: unknown) => {
              init.signal.removeEventListener('abort', abort)
              reject(e)
            },
          )
      }),
    withSlot: (fn) => downloadLane.withSlot(fn),
    matchRoute: (rawPath) => {
      const m = matchDevRoute('GET', rawPath)
      return m ? { binary: m.binary, url: String(rawPath), key: m.pathname } : null
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    now,
    limits: { chunkBytes: DEV_DOWNLOAD_CHUNK_BYTES, idleMs: DEV_DOWNLOAD_IDLE_MS, maxMs: DEV_DOWNLOAD_MAX_MS, ...opts.downloadLimits },
  })

  function logGateway(req: TransportRequest, res: BridgeResponse, fault: string) {
    if (!logging) return
    pushDevLog({
      at: now(),
      method: String(req.method),
      path: String(req.path),
      endpoint: matchDevRoute(String(req.method), req.path)?.endpoint ?? null,
      status: res.ok ? res.status : null,
      ms: 0,
      req: summarizeForLog(req.form ? { filename: req.form.filename, bytes: req.form.bytes?.byteLength ?? 0 } : (req.json ?? null)),
      res: summarizeForLog(res.ok ? (res.json ?? null) : { code: res.code, message: res.message }),
      fault,
      processed: false,
    })
  }

  async function request(req: TransportRequest): Promise<BridgeResponse> {
    if (!req || typeof req !== 'object') return gatewayError('bad-request', 'Yêu cầu không hợp lệ.')
    const method = String(req.method || 'GET').toUpperCase() as TransportRequest['method']
    const match = matchDevRoute(method, req.path)
    // main's matchCanvasappRequest: never the video stream here — it only comes in pieces (downloadOpen)
    if (!match || match.binary) {
      const res = gatewayError('not-allowed', `SanoVids không được phép gọi ${method} ${String(req.path).slice(0, 80)}.`)
      logGateway(req, res, 'not-allowed')
      return res
    }
    // What main.cjs would put on the wire.
    const out: TransportRequest = { method, path: req.path }
    if (match.multipart) {
      const f = req.form
      if (!f || !(f.bytes instanceof Uint8Array)) return gatewayError('bad-request', 'Thiếu file ảnh.')
      if (f.bytes.byteLength > MAX_UPLOAD_BYTES) {
        const res = gatewayError('too-large', 'Ảnh lớn hơn 20 MB.')
        logGateway(req, res, 'too-large')
        return res
      }
      out.form = {
        field: String(f.field || 'file').replace(/[^A-Za-z0-9_-]/g, '_'),
        filename: String(f.filename || 'image.png').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100),
        contentType: /^image\/(png|jpeg|webp)$/.test(f.contentType) ? f.contentType : 'application/octet-stream',
        bytes: new Uint8Array(f.bytes),
      }
    } else if (req.json !== undefined && method !== 'GET' && method !== 'DELETE') {
      const body = JSON.stringify(req.json)
      if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES) {
        const res = gatewayError('too-large', 'Dữ liệu gửi đi quá lớn.')
        logGateway(req, res, 'too-large')
        return res
      }
      out.json = JSON.parse(body)
    }

    const cacheKey = method === 'GET' && match.pathname === '/api/video-jobs' ? match.query.toString() : null
    if (cacheKey !== null && cacheMs > 0) {
      const hit = listCache.get(cacheKey)
      if (hit && now() - hit.at < (req.fresh === true ? Math.min(cacheMs, DEV_JOB_LIST_FRESH_MS) : cacheMs)) {
        logGateway(req, hit.result, 'gateway-cache')
        return clone(hit.result)
      }
    }
    const createsJob = method === 'POST' && match.pathname === '/api/video-jobs'
    if (createsJob) {
      jobsEpoch++
      listCache.clear()
    }
    const epoch = jobsEpoch
    // like electron/main.cjs: a cached job list is stamped with when its request was sent (the simulated latency comes
    // after), never when the answer arrived — a cache hit is never newer than the list it holds
    const sentAt = now()
    try {
      const res = await server().request(out)
      const copy: BridgeResponse = res.ok && res.json !== undefined ? { ...res, json: clone(res.json) } : res
      if (cacheKey !== null && cacheMs > 0 && copy.ok && copy.status === 200 && epoch === jobsEpoch) listCache.set(cacheKey, { at: sentAt, result: clone(copy) })
      return copy
    } catch (e) {
      return gatewayError('network', `Không kết nối được tới canvasapp giả lập (${e instanceof Error ? e.message : String(e)}).`)
    } finally {
      if (createsJob) {
        jobsEpoch++
        listCache.clear()
      }
    }
  }

  async function status(): Promise<BridgeStatus> {
    const res = await request({ method: 'GET', path: '/api/auth/state' })
    if (!res.ok) return res
    if (res.status === 401) return { ok: true, authenticated: false }
    const j = res.json as { authenticated?: unknown } | undefined
    if (res.status !== 200 || !j || typeof j !== 'object') return { ok: false, code: 'bad-response', message: `canvasapp giả lập trả về mã ${res.status}.` }
    return { ok: true, authenticated: j.authenticated === true }
  }

  function login(): Promise<BridgeStatus> {
    if (loginInFlight) return loginInFlight
    loginInFlight = (async () => {
      const before = await status()
      if (before.ok && before.authenticated) return before
      const accepted = await openLoginPrompt(now())
      if (accepted) server().login()
      return status()
    })().finally(() => {
      loginInFlight = null
    })
    return loginInFlight
  }

  /** A download refused / stopped by the gateway itself (never "closed by the page"): one request-log line. */
  function logDownload(path: string, res: { code: string; message: string }) {
    if (!logging) return
    pushDevLog({
      at: now(),
      method: 'GET',
      path,
      endpoint: matchDevRoute('GET', path)?.endpoint ?? null,
      status: null,
      ms: 0,
      req: null,
      res: summarizeForLog({ code: res.code, message: res.message }),
      fault: res.code === 'not-allowed' ? 'not-allowed' : `download-${res.code}`,
      processed: false,
    })
  }

  const worded = <T extends { ok: boolean }>(r: T): T => {
    const f = r as unknown as { ok: boolean; message?: unknown }
    return !f.ok && typeof f.message === 'string' ? ({ ...r, message: devWording(f.message) } as T) : r
  }

  async function downloadOpen(args: BridgeDownloadArgs): Promise<BridgeDownloadOpen> {
    const a = args && typeof args === 'object' ? args : ({} as BridgeDownloadArgs)
    // what the preload lets through: a string id / path and a safe positive integer
    const plain = { id: typeof a.id === 'string' ? a.id : '', path: typeof a.path === 'string' ? a.path : '', from: Number.isSafeInteger(a.from) && a.from > 0 ? a.from : 0 }
    const res = worded(await downloads.open(DEV_PAGE, plain))
    if (res.ok && 'id' in res) {
      downloadPaths.set(res.id, plain.path)
      // downloads the page stopped reading end by themselves (pull-idle): keep only recent paths
      while (downloadPaths.size > 64) downloadPaths.delete(downloadPaths.keys().next().value as string)
    }
    else if (!res.ok && res.code !== 'gone') logDownload(plain.path, res)
    return res as BridgeDownloadOpen
  }

  async function downloadRead(args: { id: string }): Promise<BridgeDownloadRead> {
    const id = args && typeof args.id === 'string' ? args.id : ''
    const res = worded(await downloads.read(DEV_PAGE, { id }))
    if (!res.ok || res.done) {
      const path = downloadPaths.get(id)
      downloadPaths.delete(id)
      if (!res.ok && res.code !== 'gone' && path) logDownload(path, res)
    }
    return res as BridgeDownloadRead
  }

  async function downloadClose(args: { id: string }): Promise<{ ok: boolean }> {
    const id = args && typeof args.id === 'string' ? args.id : ''
    downloadPaths.delete(id)
    return downloads.close(DEV_PAGE, { id })
  }

  async function logout(): Promise<{ ok: boolean }> {
    downloads.closeAll()
    downloadPaths.clear()
    closeDevPrompts()
    server().logout()
    listCache.clear()
    return { ok: true }
  }

  function reset(): void {
    downloads.closeAll()
    downloadPaths.clear()
    listCache.clear()
    jobsEpoch++ // a job-list read in flight across the reset is not cached
  }

  async function checkout(args: CheckoutArgs): Promise<BridgeCheckoutResponse> {
    if (checkoutPromptOpen()) return gatewayError('busy', 'Đang có một cửa sổ thanh toán mở — hoàn tất hoặc đóng nó trước.')
    const url = args && typeof args === 'object' ? args.checkoutUrl : null
    if (!checkoutUrlAllowed(url)) return gatewayError('refused', 'Trang thanh toán không phải SePay (https://…sepay.vn) — SanoVids không mở.')
    const fields = checkoutFields(args.fields)
    if (!fields) return gatewayError('bad-request', 'Dữ liệu đơn nạp không hợp lệ.')
    const orderId = orderIdOf(url as string, fields)
    const amount = Number(fields.order_amount)
    const amountVnd = Number.isSafeInteger(amount) && amount > 0 ? amount : null
    const opened = now()
    const answer = openCheckoutPrompt({
      openedAt: opened,
      orderId,
      amountVnd,
      credits: amountVnd !== null ? Math.floor(amountVnd / 1000) : null,
      checkoutUrl: url as string,
      fields,
      timeoutAt: opened + timeoutMs,
    })
    const timer = setTimeout(() => answerDevCheckout('timeout', { outcome: 'none' }), timeoutMs)
    let a: Awaited<typeof answer>
    try {
      a = await answer
    } finally {
      clearTimeout(timer)
    }
    if (orderId && a.outcome !== 'none') server().simulatePayment(orderId, a.outcome, a.delayMs)
    if (a.choice === 'closed' || a.choice === 'timeout') return { ok: true, result: a.choice, orderId: null, blockedHost: null }
    return { ok: true, result: a.choice, orderId, blockedHost: null }
  }

  return { status, login, logout, request, checkout, downloadOpen, downloadRead, downloadClose, reset }
}
