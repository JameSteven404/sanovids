// Browser wiring of the SANO gateway provider (core: ./gateway.ts). On only inside the SANO app: a web build made with
// VITE_SANO_GATEWAY=1 shown in an iframe of a same-origin page (SANO serves it at /sanovids/). The same build opened in
// a plain tab, Electron (even a build made with the flag) and the public web build are outside SANO: it is unavailable
// there; providers/index offers it only in the flagged build (sanoBuild). window.__SANO_GATEWAY__ (on this page or on
// the same-origin SANO page around the iframe, read there too so a reload inside the frame keeps it) is only the token
// source (token(): null until the user signs in to SANO — the gateway then defers, see gateway.ts).
import { getBlob } from '../../lib/imageStore'
import { createSanoGatewayProvider, type SanoGatewayProvider } from './gateway'

export { SANO_LABEL, SANO_LOGIN_TEXT, SANO_LOGIN_WAIT, SANO_OTHER_ACCOUNT, SANO_OTHER_ACCOUNT_WAIT, SANO_UNAVAILABLE, type SanoGatewayProvider } from './gateway'

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

/** Shown in an iframe of a same-origin page: known from the first script run, never when the host sets its object. */
function framedBySameOrigin(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return !!window.parent && window.parent !== window && window.parent.location.origin === window.location.origin
  } catch {
    return false // a cross-origin parent
  }
}

/**
 * The SANO build (VITE_SANO_GATEWAY=1, not Electron): its new takes are SANO's even in a plain tab, where they are
 * refused with SANO_UNAVAILABLE (sanoGatewayAvailable) instead of pointing to canvasapp's desktop app.
 */
export function sanoBuild(): boolean {
  return import.meta.env.VITE_SANO_GATEWAY === '1' && !isElectron()
}

/** D226: tạm ẩn canvasapp phía SANO; đặt true khi Minh mở lại */
export const CANVASAPP_IN_SANO = false

/** The SANO build hides canvasapp (D226): not offered, not named. Standalone SanoVids is unaffected. */
export function canvasappHidden(): boolean {
  return !CANVASAPP_IN_SANO && sanoBuild()
}

/** Running inside SANO (see the top of the file). */
export function sanoGatewayAvailable(): boolean {
  return sanoBuild() && framedBySameOrigin()
}

/** The app's instance: the page's own fetch (same origin) and the media store. */
export function createBrowserSanoGateway(onLimitsChange?: () => void): SanoGatewayProvider {
  return createSanoGatewayProvider({
    fetch: (url, init) => fetch(url, init),
    token: async () => (await hostGateway()?.token?.()) ?? null,
    available: sanoGatewayAvailable,
    getBlob,
    onLimitsChange,
  })
}
