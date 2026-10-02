// Transport for the canvasapp gateway.
// Desktop (Electron): window.bdpDesktop.canvasapp → IPC → main process → a dedicated session partition
//   ('persist:canvasapp') that holds the user's canvasapp login cookies. Main adds X-CSRF-Token and only allows a
//   fixed list of endpoints (electron/main.cjs).
// Web: unavailable — a browser page on another origin cannot (and must not try to) use canvasapp's cookies.
import type { ProviderAvailability } from '../types'
import { CanvasappError, type Transport, type TransportRequest, type TransportResponse } from './api'

/** Result of canvasapp:status / canvasapp:login. */
export type BridgeStatus = { ok: true; authenticated: boolean } | { ok: false; code: string; message: string }

export type BridgeResponse = ({ ok: true } & TransportResponse) | { ok: false; code: string; message: string }

/** Exposed by electron/preload.cjs as window.bdpDesktop.canvasapp. */
export interface CanvasappBridge {
  status(): Promise<BridgeStatus>
  login(): Promise<BridgeStatus>
  logout(): Promise<{ ok: boolean }>
  request(req: TransportRequest): Promise<BridgeResponse>
}

export const WEB_UNAVAILABLE = 'Cổng canvasapp chỉ chạy trong bản desktop SanoVids (.exe): trình duyệt không được phép dùng phiên đăng nhập của trang khác.'

/** The desktop bridge, or null in a browser / older desktop build. */
export function canvasappBridge(): CanvasappBridge | null {
  if (typeof window === 'undefined') return null
  const desk = (window as unknown as { bdpDesktop?: { canvasapp?: CanvasappBridge } }).bdpDesktop
  const b = desk?.canvasapp
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
        throw new CanvasappError(code, res.message || 'Không kết nối được tới canvasapp.io.vn.')
      }
      const { ok: _ok, ...rest } = res
      return rest
    },
  }
}
