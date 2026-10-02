// Transport for the canvasapp gateway.
// Desktop (Electron): window.bdpDesktop.canvasapp → IPC → main process → a dedicated session partition
//   ('persist:canvasapp') that holds the user's canvasapp login cookies. Main adds X-CSRF-Token and only allows a
//   fixed list of endpoints (electron/main.cjs).
// Web: unavailable — a browser page on another origin cannot (and must not try to) use canvasapp's cookies.
// Top-up checkout: openCheckout() → canvasapp:checkout → a modal window showing the REAL SePay page (main.cjs).
import { checkoutUrlAllowed } from '../../core/topup'
import type { ProviderAvailability } from '../types'
import { CanvasappError, requestLabel, type Transport, type TransportRequest, type TransportResponse } from './api'

/** Result of canvasapp:status / canvasapp:login. */
export type BridgeStatus = { ok: true; authenticated: boolean } | { ok: false; code: string; message: string }

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

/** Exposed by electron/preload.cjs as window.bdpDesktop.canvasapp. */
export interface CanvasappBridge {
  status(): Promise<BridgeStatus>
  login(): Promise<BridgeStatus>
  logout(): Promise<{ ok: boolean }>
  request(req: TransportRequest): Promise<BridgeResponse>
  /** Opens the real checkout page in a modal window (main re-validates the URL). Missing in older desktop builds. */
  checkout?(args: CheckoutArgs): Promise<BridgeCheckoutResponse>
}

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

/** Transport over the Electron IPC bridge. `bridge` is injectable for tests. */
export function createDesktopTransport(bridge: () => CanvasappBridge | null = canvasappBridge): Transport {
  return {
    available: async (): Promise<ProviderAvailability> => (bridge() ? { ok: true } : { ok: false, reason: WEB_UNAVAILABLE }),
    request: async (req) => {
      const b = bridge()
      if (!b) throw new CanvasappError('unavailable', WEB_UNAVAILABLE)
      const res = await b.request(req)
      if (!res.ok) {
        const code = res.code === 'not-allowed' ? 'forbidden' : res.code === 'too-large' ? 'bad-request' : 'network'
        const message = res.message || 'Không kết nối được tới canvasapp.io.vn.'
        // refused by SanoVids desktop itself (allowlist / size cap): say which request, like errorFromResponse does
        throw new CanvasappError(code, code === 'network' ? message : `${message} [${requestLabel(req)} · SanoVids desktop]`)
      }
      const { ok: _ok, ...rest } = res
      return rest
    },
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
