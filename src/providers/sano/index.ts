// Browser wiring of the SANO gateway provider (core: ./gateway.ts). On only inside the SANO app: the host page sets
// window.__SANO_GATEWAY__ (optionally with token()), or the web build is made with VITE_SANO_GATEWAY=1. Everywhere
// else (Electron, the public web build) it is unavailable and providers/index never offers it.
import { getBlob } from '../../lib/imageStore'
import { createSanoGatewayProvider, type SanoGatewayProvider } from './gateway'

export { SANO_LABEL, SANO_LOGIN_TEXT, SANO_UNAVAILABLE, type SanoGatewayProvider } from './gateway'

/** Running inside SANO (see the top of the file). */
export function sanoGatewayAvailable(): boolean {
  return (typeof window !== 'undefined' && !!window.__SANO_GATEWAY__) || import.meta.env.VITE_SANO_GATEWAY === '1'
}

/** The app's instance: the page's own fetch (same origin, SANO's cookie) and the media store. */
export function createBrowserSanoGateway(onLimitsChange?: () => void): SanoGatewayProvider {
  return createSanoGatewayProvider({
    fetch: (url, init) => fetch(url, init),
    token: async () => (await window.__SANO_GATEWAY__?.token?.()) ?? null,
    available: sanoGatewayAvailable,
    getBlob,
    onLimitsChange,
  })
}
