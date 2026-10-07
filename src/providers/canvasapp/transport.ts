// Transport for the canvasapp gateway.
// Desktop (Electron): window.bdpDesktop.canvasapp → IPC → main process → a dedicated session partition
//   ('persist:canvasapp') that holds the user's canvasapp login cookies. Main adds X-CSRF-Token and only allows a
//   fixed list of endpoints (electron/main.cjs).
// Web: unavailable — a browser page on another origin cannot (and must not try to) use canvasapp's cookies.
// Top-up checkout: openCheckout() → canvasapp:checkout → a modal window showing the REAL SePay page (main.cjs).
// Videos: download() pulls them in pieces (canvasapp:downloadOpen / downloadRead / downloadClose, main's
// <canvasapp-downloads>) into a Blob made of the pieces — never the whole file in one IPC message (main refuses the
// stream through request()). Abort closes the download at once (also while it waits for a slot); a cut — or a
// connection main stopped after 60 min ('too-slow') — continues where it stopped when main says it can (`resumable`:
// canvasapp sent a validator and takes Range); a reopen that cannot reach canvasapp is tried again a few times over
// about a minute, keeping what came. Else it fails and the engine tries again later (a 'too-slow' one: not at all).
import { newId } from '../../core/ids'
import { checkoutUrlAllowed } from '../../core/topup'
import type { ProviderAvailability } from '../types'
import {
  CanvasappError,
  requestLabel,
  type DownloadOptions,
  type Transport,
  type TransportDownload,
  type TransportRequest,
  type TransportResponse,
} from './api'

/**
 * Result of canvasapp:status / canvasapp:login. After a login, `keepLogin` = SanoVids keeps it across restarts on this
 * computer ("Giữ đăng nhập canvasapp trên máy này"; missing in older desktop builds).
 */
export type BridgeStatus = { ok: true; authenticated: boolean; keepLogin?: boolean } | { ok: false; code: string; message: string }

/** canvasapp:logout. `keep-login-not-cleared`: logged out, but the kept login copy could not be deleted (say so). */
export type BridgeLogoutResult = { ok: true } | { ok: false; code: string; message: string }

/**
 * canvasapp:keepLogin / canvasapp:setKeepLogin — "Giữ đăng nhập canvasapp trên máy này" (held by the main process,
 * never in the settings export): keepLogin = on; available = this computer can encrypt the copy; chosen = the user
 * picked it (else the placement default: installer / source on, Portable / temp copy off). Booleans only.
 */
export type KeepLoginState = { ok: true; keepLogin: boolean; available: boolean; chosen: boolean } | { ok: false; code: string; message: string }

export type BridgeResponse = ({ ok: true } & TransportResponse) | { ok: false; code: string; message: string }

/** canvasapp:checkout input: the checkout form returned by POST /api/payments/topups (api.createTopup). */
export interface CheckoutArgs {
  checkoutUrl: string
  fields: Record<string, string>
}

/**
 * How the checkout window ended.
 *   success | cancel | error  the window came back to canvasapp.io.vn with ?payment=…&topup_order=<orderId>
 *                             (still read the order status: only canvasapp's answer counts);
 *   closed                    the user closed the window (orderId null — they may still have paid: poll the order
 *                             id from createTopup if there is one, else look at the credit history);
 *   timeout                   15 minutes without coming back (window closed by SanoVids).
 */
export type CheckoutResult = 'success' | 'cancel' | 'error' | 'closed' | 'timeout'

export type BridgeCheckoutResponse =
  | { ok: true; result: CheckoutResult; orderId: string | null; /** Main-frame navigation SanoVids refused (diagnostics). */ blockedHost?: string | null }
  | { ok: false; code: string; message: string }

/** canvasapp:downloadOpen input. `id`: a UUID the page picks (so it can close the download before the answer). */
export interface BridgeDownloadArgs {
  id: string
  path: string
  /** Continue at this byte (> 0): main sends Range only when it holds the video's validator, else starts at 0. */
  from: number
}

/**
 * canvasapp:downloadOpen answer:
 *   streaming   { ok, id, status (200 / 206), contentType, from (where this answer starts: 0 = from the start), total
 *               (whole size, null = unknown), resumable (a cut may continue with `from`) };
 *   not 2xx     { ok, status, contentType, json?, text? } (no id: nothing to read);
 *   refused     { ok: false, code: bad-request | busy | not-allowed | gone | network | too-large | bad-range, message }.
 */
export type BridgeDownloadOpen =
  | { ok: true; id: string; status: number; contentType: string; from: number; total: number | null; resumable: boolean }
  | { ok: true; id?: undefined; status: number; contentType: string; json?: unknown; text?: string }
  | { ok: false; code: string; message: string }

/** canvasapp:downloadRead answer: a piece (≤ 4 MiB), the end, or why it stopped (the download is over then). */
export type BridgeDownloadRead = { ok: true; done: false; bytes: Uint8Array } | { ok: true; done: true } | { ok: false; code: string; message: string }

/** Exposed by electron/preload.cjs as window.bdpDesktop.canvasapp. */
export interface CanvasappBridge {
  status(): Promise<BridgeStatus>
  login(): Promise<BridgeStatus>
  logout(): Promise<BridgeLogoutResult>
  request(req: TransportRequest): Promise<BridgeResponse>
  /** Opens the real checkout page in a modal window (main re-validates the URL). Missing in older desktop builds. */
  checkout?(args: CheckoutArgs): Promise<BridgeCheckoutResponse>
  /** Streamed video downloads (the only way a video comes: main refuses the stream through request()). */
  downloadOpen?(args: BridgeDownloadArgs): Promise<BridgeDownloadOpen>
  downloadRead?(args: { id: string }): Promise<BridgeDownloadRead>
  downloadClose?(args: { id: string }): Promise<{ ok: boolean }>
  /** "Giữ đăng nhập canvasapp trên máy này" (missing in older desktop builds: the Settings row is hidden). */
  keepLogin?(): Promise<KeepLoginState>
  /** Switch it; off deletes the kept copy now (this run stays logged in). */
  setKeepLogin?(on: boolean): Promise<KeepLoginState>
}

/** A kept login lives this long after the login / canvasapp's last renewal (= electron/keeplogin-rules.cjs KEEP_LOGIN_DAYS). */
export const KEEP_LOGIN_DAYS = 30

export const CHECKOUT_UNSUPPORTED = 'Bản SanoVids desktop này chưa hỗ trợ nạp credit trong app — cập nhật bản mới, hoặc nạp trực tiếp trên canvasapp.io.vn.'
export const CHECKOUT_REFUSED = 'Trang thanh toán canvasapp trả về không phải SePay (https://…sepay.vn) — SanoVids không mở để giữ an toàn. Hãy nạp trực tiếp trên canvasapp.io.vn.'

export const WEB_UNAVAILABLE = 'Cổng canvasapp chỉ chạy trong bản desktop SanoVids (.exe): trình duyệt không được phép dùng phiên đăng nhập của trang khác.'

/** The desktop bridge, or null in a browser / older desktop build. */
export function canvasappBridge(): CanvasappBridge | null {
  if (typeof window === 'undefined') return null
  const b = window.bdpDesktop?.canvasapp
  return b && typeof b.request === 'function' ? b : null
}

export function hasCanvasappBridge(): boolean {
  return canvasappBridge() !== null
}

/** A cut download continues at most this many times in a row without a new byte (then it fails; the engine retries). */
export const MAX_STALLED_RESUMES = 2
/**
 * A resume whose open fails on the network (Wi-Fi back in a moment, ERR_NETWORK_CHANGED…) waits this long before each
 * new try, keeping what came; after the last one it fails (the engine then starts again from 0 later).
 */
export const RESUME_RETRY_MS = [2_000, 5_000, 10_000, 20_000, 30_000]
/**
 * Opens of one download in a row that brought no new byte (resumes, pieces of a 206, one restart): then it is given up.
 * An open that brought bytes starts the count again — a connection cut every few MB still finishes, never dropping
 * what came.
 */
export const MAX_DOWNLOAD_OPENS = 32
/** ...and opens in all, whatever each brought: a server that answers in crumbs is given up, never an endless loop. */
export const MAX_DOWNLOAD_OPENS_TOTAL = 1024
/** onProgress at most this often. */
export const DOWNLOAD_PROGRESS_MS = 250

export const DOWNLOAD_ABORTED_TEXT = 'Đã dừng tải video.'
const DOWNLOAD_SHORT_TEXT = 'Video tải về bị thiếu dữ liệu (kết nối đóng sớm).'
export const DOWNLOAD_UNSUPPORTED_TEXT = 'Bản SanoVids desktop này không tải được video theo từng phần — cài lại bản mới nhất.'

export interface DesktopTransportOptions {
  /** Download ids (tests). Default: a random UUID. */
  newId?: () => string
}

/** Transport over the Electron IPC bridge. `bridge` is injectable for tests. */
export function createDesktopTransport(bridge: () => CanvasappBridge | null = canvasappBridge, topts: DesktopTransportOptions = {}): Transport {
  const makeId = topts.newId ?? (() => newId())

  async function request(req: TransportRequest): Promise<TransportResponse> {
    const b = bridge()
    if (!b) throw new CanvasappError('unavailable', WEB_UNAVAILABLE)
    const res = await b.request(req)
    if (!res.ok) {
      // 'logged-out': refused BEFORE it was sent because Đăng xuất is running (nothing reached canvasapp) → like a 401.
      if (res.code === 'logged-out') throw new CanvasappError('login-required', res.message || 'Đang đăng xuất canvasapp.')
      const code = res.code === 'not-allowed' ? 'forbidden' : res.code === 'too-large' ? 'bad-request' : 'network'
      const message = res.message || 'Không kết nối được tới canvasapp.io.vn.'
      // refused by SanoVids desktop itself (allowlist / size cap): say which request, like errorFromResponse does
      throw new CanvasappError(code, code === 'network' ? message : `${message} [${requestLabel(req)} · SanoVids desktop]`)
    }
    const { ok: _ok, ...rest } = res
    return rest
  }

  /**
   * A refusal of the desktop gateway (open or read) as an error. 'busy' (too many at once) = try later ('deferred');
   * 'too-slow' = a connection open longer than main allows that could not continue.
   */
  function refused(res: { code: string; message: string }, req: TransportRequest): CanvasappError {
    const message = res.message || 'Không tải được video từ canvasapp.io.vn.'
    const own = (code: 'forbidden' | 'too-large' | 'bad-request') => new CanvasappError(code, `${message} [${requestLabel(req)} · SanoVids desktop]`)
    if (res.code === 'not-allowed') return own('forbidden')
    if (res.code === 'too-large') return own('too-large')
    if (res.code === 'bad-request') return own('bad-request')
    if (res.code === 'busy') return new CanvasappError('deferred', message)
    if (res.code === 'too-slow') return new CanvasappError('too-slow', message)
    return new CanvasappError('network', message)
  }

  async function download(req: TransportRequest, opts: DownloadOptions = {}): Promise<TransportDownload> {
    const b = bridge()
    if (!b) throw new CanvasappError('unavailable', WEB_UNAVAILABLE)
    const { signal, onProgress } = opts
    const aborted = () => new CanvasappError('aborted', DOWNLOAD_ABORTED_TEXT)
    if (signal?.aborted) throw aborted()

    // Rejects as soon as the signal aborts (and closes the download main is working on, if any).
    let current: string | null = null
    let stop: (e: unknown) => void = () => undefined
    const stopped = new Promise<never>((_, reject) => (stop = reject))
    stopped.catch(() => undefined)
    const close = (id: string) => {
      try {
        void Promise.resolve(b.downloadClose?.({ id })).catch(() => undefined)
      } catch {
        /* the bridge is gone: main ends it by itself (page closed / pull timeout) */
      }
    }
    const onAbort = () => {
      if (current) close(current)
      current = null
      stop(aborted())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const guarded = <T,>(p: Promise<T>): Promise<T> => (signal ? Promise.race([p, stopped]) : p)
    const pause = (ms: number) => guarded(new Promise<void>((resolve) => setTimeout(resolve, ms)))

    try {
      // page, preload and main ship together (app.asar): a bridge without them is not a SanoVids build
      if (typeof b.downloadOpen !== 'function' || typeof b.downloadRead !== 'function' || typeof b.downloadClose !== 'function') {
        throw new CanvasappError('unavailable', DOWNLOAD_UNSUPPORTED_TEXT)
      }

      let parts: Blob[] = []
      let received = 0
      let total: number | null = null
      let contentType = ''
      let from = 0
      let restarts = 0
      let stalled = 0
      let reopenFailures = 0
      let opens = 0
      let fruitless = 0
      let lastReport = -Infinity
      const report = (force = false) => {
        if (!onProgress) return
        const now = Date.now()
        if (!force && now - lastReport < DOWNLOAD_PROGRESS_MS) return
        lastReport = now
        try {
          onProgress({ received, total })
        } catch {
          /* a progress listener never breaks the download */
        }
      }
      /** From the start again (once): the server answered from 0, or the part did not fit where it stopped. */
      const restart = () => {
        if (restarts >= 1) throw new CanvasappError('network', DOWNLOAD_SHORT_TEXT)
        restarts++
        parts = []
        received = 0
        from = 0
      }

      for (;;) {
        if (++opens > MAX_DOWNLOAD_OPENS_TOTAL || ++fruitless > MAX_DOWNLOAD_OPENS) throw new CanvasappError('network', DOWNLOAD_SHORT_TEXT)
        const id = makeId()
        current = id
        const opened = await guarded(b.downloadOpen({ id, path: req.path, from }))
        if (!opened.ok) {
          current = null
          if (opened.code === 'bad-range' && (from > 0 || received > 0)) {
            restart()
            continue
          }
          // continuing a cut download and canvasapp cannot be reached yet: what came is kept, the open tried again
          if (opened.code === 'network' && from > 0 && reopenFailures < RESUME_RETRY_MS.length) {
            await pause(RESUME_RETRY_MS[reopenFailures++])
            continue
          }
          throw refused(opened, req)
        }
        if (opened.id === undefined) {
          // not 200 / 206: what canvasapp said (the api maps it: 401 → login, 404, 409…)
          current = null
          const { ok: _ok, id: _id, ...answer } = opened
          return answer
        }
        if (opened.id !== id) {
          close(opened.id)
          current = null
          throw new CanvasappError('network', 'Cổng tải video trả về một lượt tải khác.')
        }
        if (opened.from !== from) {
          if (opened.from !== 0) {
            close(id)
            current = null
            throw new CanvasappError('network', DOWNLOAD_SHORT_TEXT)
          }
          // canvasapp starts again from byte 0 (no Range, or the video changed): what came before is dropped — the one
          // restart of this download (a site that always answers a resume from 0 never loops through the whole video)
          try {
            restart()
          } catch (e) {
            close(id)
            current = null
            throw e
          }
        }
        if (opened.from > 0 && total !== null && opened.total !== total) {
          // the rest of ANOTHER file: never spliced
          close(id)
          current = null
          restart()
          continue
        }
        total = opened.total
        contentType = opened.contentType || contentType
        const resumable = opened.resumable === true

        let more = false
        for (;;) {
          const r = await guarded(b.downloadRead({ id }))
          if (!r.ok) {
            current = null // main ended it
            // a cut / stalled connection, or one open longer than main allows ('too-slow'): continue when possible
            const resumes = r.code === 'network' || r.code === 'too-slow'
            if (resumes && resumable && stalled < MAX_STALLED_RESUMES && (total === null || received < total)) {
              stalled++
              from = received
              more = true
              break
            }
            throw r.code === 'too-large' || r.code === 'too-slow' ? refused(r, req) : new CanvasappError('network', r.message || DOWNLOAD_SHORT_TEXT)
          }
          if (r.done) {
            current = null
            break
          }
          const bytes = r.bytes
          if (!bytes || !ArrayBuffer.isView(bytes) || !bytes.byteLength) continue
          parts.push(new Blob([bytes as BlobPart]))
          received += bytes.byteLength
          stalled = 0
          reopenFailures = 0
          fruitless = 0
          report()
        }
        if (more) continue
        if (total !== null && received < total) {
          // a 206 that served a part: the rest is asked for (same validator), never assumed
          if (resumable && stalled < MAX_STALLED_RESUMES) {
            stalled++
            from = received
            continue
          }
          throw new CanvasappError('network', DOWNLOAD_SHORT_TEXT)
        }
        if (total !== null && received !== total) throw new CanvasappError('network', DOWNLOAD_SHORT_TEXT)
        break
      }
      report(true)
      const type = contentType.split(';')[0].trim()
      return { status: 200, contentType, blob: new Blob(parts, type ? { type } : {}) }
    } catch (e) {
      if (signal?.aborted) throw aborted()
      throw e
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (current) close(current)
      current = null
    }
  }

  return {
    available: async (): Promise<ProviderAvailability> => (bridge() ? { ok: true } : { ok: false, reason: WEB_UNAVAILABLE }),
    request,
    download,
  }
}

export function hasCheckoutBridge(bridge: () => CanvasappBridge | null = canvasappBridge): boolean {
  return typeof bridge()?.checkout === 'function'
}

/**
 * Open the checkout page returned by api.createTopup() in the desktop checkout window and wait until it ends.
 * Refuses (CanvasappError) before calling the bridge when the URL is not SePay, when there is no desktop bridge or
 * the desktop build is too old. SanoVids never fills or scripts the payment page: the user pays there by themselves.
 * `bridge` is injectable for tests.
 */
export async function openCheckout(
  args: CheckoutArgs,
  bridge: () => CanvasappBridge | null = canvasappBridge,
): Promise<{ result: CheckoutResult; orderId: string | null; blockedHost: string | null }> {
  const b = bridge()
  if (!b) throw new CanvasappError('unavailable', WEB_UNAVAILABLE)
  if (typeof b.checkout !== 'function') throw new CanvasappError('unsupported', CHECKOUT_UNSUPPORTED)
  if (!checkoutUrlAllowed(args.checkoutUrl)) throw new CanvasappError('forbidden', CHECKOUT_REFUSED)
  const res = await b.checkout({ checkoutUrl: args.checkoutUrl, fields: { ...args.fields } })
  if (!res || typeof res !== 'object') throw new CanvasappError('bad-response', 'Cửa sổ thanh toán trả về kết quả lạ.')
  if (!res.ok) {
    const code = res.code === 'busy' ? 'busy' : res.code === 'not-allowed' || res.code === 'refused' ? 'forbidden' : res.code === 'bad-request' ? 'bad-request' : 'network'
    throw new CanvasappError(code, res.message || 'Không mở được cửa sổ thanh toán.')
  }
  const results: CheckoutResult[] = ['success', 'cancel', 'error', 'closed', 'timeout']
  const result = results.includes(res.result) ? res.result : 'error'
  const orderId = typeof res.orderId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(res.orderId) ? res.orderId : null
  return { result, orderId, blockedHost: typeof res.blockedHost === 'string' ? res.blockedHost : null }
}
