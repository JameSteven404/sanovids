// Browser wiring of the SANO gateway provider (core: ./gateway.ts). On only inside the SANO app: the host page sets
// window.__SANO_GATEWAY__ (optionally with token()) on this page or on the same-origin SANO page around the iframe
// (read there too, so a reload inside the frame keeps it), or the web build is made with VITE_SANO_GATEWAY=1.
// Everywhere else (Electron — even a build made with the flag —, the public web build) it is unavailable and
// providers/index never offers it.
import { getBlob } from '../../lib/imageStore'
import { createSanoGatewayProvider, type SanoGatewayProvider } from './gateway'

export { SANO_LABEL, SANO_LOGIN_TEXT, SANO_UNAVAILABLE, type SanoGatewayProvider } from './gateway'

/** The host's object: on this page, else on the same-origin parent page (SANO showing SanoVids in an iframe). */
function hostGateway(): Window['__SANO_GATEWAY__'] {
  if (typeof window === 'undefined') return undefined
  if (window.__SANO_GATEWAY__) return window.__SANO_GATEWAY__
  try {
    return window.parent && window.parent !== window ? window.parent.__SANO_GATEWAY__ : undefined
  } catch {
    return undefined // a cross-origin parent
  }
}

/** Same check as providers/devAccess isElectronPage (not imported: devAccess imports this module). */
const isElectron = () =>
  typeof window !== 'undefined' && (!!(window as { bdpDesktop?: unknown }).bdpDesktop || (typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent)))

/** Running inside SANO (see the top of the file). */
export function sanoGatewayAvailable(): boolean {
  return !isElectron() && (!!hostGateway() || import.meta.env.VITE_SANO_GATEWAY === '1')
}

/** The app's instance: the page's own fetch (same origin, SANO's cookie) and the media store. */
export function createBrowserSanoGateway(onLimitsChange?: () => void): SanoGatewayProvider {
  return createSanoGatewayProvider({
    fetch: (url, init) => fetch(url, init),
    token: async () => (await hostGateway()?.token?.()) ?? null,
    available: sanoGatewayAvailable,
    getBlob,
    onLimitsChange,
  })
}
