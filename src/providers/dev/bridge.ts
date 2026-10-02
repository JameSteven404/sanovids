// The desktop gateway (electron/main.cjs) simulated in-app for development mode: a CanvasappBridge — the same
// interface window.bdpDesktop.canvasapp exposes — in front of the dev server (server.ts). The real gateway code
// (transport.ts createDesktopTransport / openCheckout, api.ts, adapter.ts) runs on top of it unchanged.
//
// Like main.cjs it:
//   - refuses anything outside the endpoint allowlist ({ ok:false, code:'not-allowed' }), JSON bodies over 2 MB and
//     uploads over 20 MB ('too-large'); sends no JSON body with GET / DELETE; sanitizes the multipart filename;
//   - reuses a job-list answer for a short while per project, and forgets it around every POST /api/video-jobs (so a
//     lookup after a lost answer always reads the server);
//   - turns "no answer" into { ok:false, code:'network' } (dev faults 'network' / 'lost-response');
//   - login(): already logged in → done; else opens the login "window" (prompts.ts: a sheet in the app) and resolves
//     with the state once it is closed — concurrent calls share it;
//   - checkout(): one window at a time ('busy'), the URL must be SePay's ('refused'), fields like main's; the simulated
//     SePay sheet answers success / cancel / error (with the order id, as SePay's return to canvasapp does), closed or
//     timeout (15 min) — and tells the dev server what canvasapp says about the order afterwards (paid ~2 s later…).
// JSON bodies cross it as JSON (a deep copy), like IPC + HTTP would: nothing is shared by reference with the server.
import { checkoutUrlAllowed, parsePaymentReturn } from '../../core/topup'
import type { TransportRequest } from '../canvasapp/api'
import type { BridgeCheckoutResponse, BridgeResponse, BridgeStatus, CanvasappBridge, CheckoutArgs } from '../canvasapp/transport'
import { pushDevLog, summarizeForLog } from './log'
import { answerDevCheckout, checkoutPromptOpen, closeDevPrompts, openCheckoutPrompt, openLoginPrompt } from './prompts'
import { matchDevRoute, MAX_JSON_BYTES, MAX_UPLOAD_BYTES } from './routes'
import type { DevCanvasapp } from './server'

/** Job-list answers reused this long (main.cjs: 15 s for the real site; the dev engine polls every 3 s). */
export const DEV_JOB_LIST_CACHE_MS = 3_000
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

export function createDevBridge(server: () => DevCanvasapp, opts: DevBridgeOptions = {}): CanvasappBridge {
  const now = opts.now ?? (() => Date.now())
  const cacheMs = opts.jobListCacheMs ?? DEV_JOB_LIST_CACHE_MS
  const timeoutMs = opts.checkoutTimeoutMs ?? DEV_CHECKOUT_TIMEOUT_MS
  const logging = opts.log !== false
  const listCache = new Map<string, { at: number; result: BridgeResponse }>()
  let jobsEpoch = 0
  let loginInFlight: Promise<BridgeStatus> | null = null

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
    if (!match) {
      const res = gatewayError('not-allowed', `SanoVids không được phép gọi ${method} ${String(req.path).slice(0, 80)}.`)
      logGateway(req, res, 'not-allowed')
      return res
    }
    // What main.cjs would put on the wire.
    const out: TransportRequest = { method, path: req.path, ...(req.binary ? { binary: true } : {}) }
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
      if (hit && now() - hit.at < cacheMs) {
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
    try {
      const res = await server().request(out)
      const copy: BridgeResponse = res.ok && res.json !== undefined ? { ...res, json: clone(res.json) } : res
      if (cacheKey !== null && cacheMs > 0 && copy.ok && copy.status === 200 && epoch === jobsEpoch) listCache.set(cacheKey, { at: now(), result: clone(copy) })
      return copy
    } catch (e) {
      return gatewayError('network', `Không kết nối được tới canvasapp.io.vn (${e instanceof Error ? e.message : String(e)}).`)
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
    if (res.status !== 200 || !j || typeof j !== 'object') return { ok: false, code: 'bad-response', message: `canvasapp.io.vn trả về mã ${res.status}.` }
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

  async function logout(): Promise<{ ok: boolean }> {
    closeDevPrompts()
    server().logout()
    listCache.clear()
    return { ok: true }
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

  return { status, login, logout, request, checkout }
}
