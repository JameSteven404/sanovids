// The app's own code signature, as "Cài đặt → Giới thiệu" shows it (components/dialogs/SettingsBasic.tsx AboutBlock):
//   - 'desktop': window.bdpDesktop.app.signature() (electron/preload.cjs → IPC 'app:signature'). electron/main.cjs checks
//     process.execPath once, 3 s after the window shows (electron/signature.cjs: Authenticode + the pinned thumbprints of
//     package.json sanovids.signers), and caches the verdict.
//   - 'none':    a desktop build without that bridge (older preload): 'unknown'.
//   - 'sim':     outside Electron (`npm run dev`): the simulated verdict of development mode (providers/dev/appSignature),
//     driven from "Bảng phát triển → Cập nhật → Chữ ký số (Giới thiệu)"; its changes show live.
// Every payload is validated (parseAppSignature): nothing received is shown unchecked. Texts: lib/aboutModel.ts.
//
// ---- API ----
//   parseAppSignature(raw)               untrusted payload → a valid AppSignature ({ status:'unknown', packaged:false }).
//   appSignatureSource()                 'desktop' | 'none' | 'sim'.
//   useAppSignature                      zustand store { sig: AppSignature | null } (null = not checked yet).
//   loadAppSignature()                   ask once (one promise in flight / kept after success); never throws.
//   createAppSignatureLoader(deps)       the same with injected bridges (tests).
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { devSignatureBridge, useDevSignature } from '../providers/dev/appSignature'
import { isDesktop } from './pwa'

export type AppSignatureStatus = 'signed' | 'unsigned' | 'other-signer' | 'tampered' | 'unknown'

export interface AppSignature {
  status: AppSignatureStatus
  /** Running from an installed / portable build (false: from the sources, `npm run desktop` or the browser). */
  packaged: boolean
  /** Certificate simple name (display only; never trusted for a decision). Only with 'signed' / 'other-signer'. */
  signer?: string
  /** SHA-1 thumbprint of the signing certificate, 40 upper-case hex. Only with 'signed' / 'other-signer'. */
  thumbprint?: string
}

/** window.bdpDesktop.app (electron/preload.cjs). */
export interface DesktopAppBridge {
  signature(): Promise<AppSignature>
}

export type AppSignatureSource = 'desktop' | 'none' | 'sim'

export const APP_SIGNATURE_STATUSES: readonly AppSignatureStatus[] = ['signed', 'unsigned', 'other-signer', 'tampered', 'unknown']
export const SIGNER_MAX = 200
const THUMBPRINT_RE = /^[0-9A-F]{40}$/
// C0 + DEL + C1 control characters.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g

/** Anything that is not a valid payload. */
export const UNKNOWN_SIGNATURE: Readonly<AppSignature> = Object.freeze({ status: 'unknown', packaged: false })

const unknownSig = (): AppSignature => ({ ...UNKNOWN_SIGNATURE })

/**
 * Strict check of a payload (IPC or simulation): a known status and a boolean `packaged`; for 'signed' / 'other-signer'
 * an optional signer (string, control characters removed, at most 200 chars) and an optional thumbprint (40 upper-case
 * hex). A wrong type or value anywhere gives { status:'unknown', packaged:false }; signer / thumbprint sent with another
 * status are dropped.
 */
export function parseAppSignature(raw: unknown): AppSignature {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unknownSig()
  const r = raw as Record<string, unknown>
  if (typeof r.status !== 'string' || !(APP_SIGNATURE_STATUSES as readonly string[]).includes(r.status) || typeof r.packaged !== 'boolean') return unknownSig()
  const status = r.status as AppSignatureStatus
  const out: AppSignature = { status, packaged: r.packaged }
  if (status !== 'signed' && status !== 'other-signer') return out
  if (r.signer !== undefined && r.signer !== null) {
    if (typeof r.signer !== 'string') return unknownSig()
    const signer = r.signer.replace(CONTROL_RE, '')
    if (signer.length > SIGNER_MAX) return unknownSig()
    if (signer) out.signer = signer
  }
  if (r.thumbprint !== undefined && r.thumbprint !== null) {
    if (typeof r.thumbprint !== 'string' || !THUMBPRINT_RE.test(r.thumbprint)) return unknownSig()
    out.thumbprint = r.thumbprint
  }
  return out
}

const sameSig = (a: AppSignature | null, b: AppSignature | null) =>
  a === b || (!!a && !!b && a.status === b.status && a.packaged === b.packaged && a.signer === b.signer && a.thumbprint === b.thumbprint)

export interface AppSignatureStore {
  /** null until the first answer. */
  sig: AppSignature | null
}

export interface AppSignatureLoaderDeps {
  source: () => AppSignatureSource
  desktop: () => DesktopAppBridge | null
  sim: () => DesktopAppBridge
  /** Live changes of the simulation; returns an unsubscribe. */
  watchSim: (listener: (raw: unknown) => void) => () => void
}

export interface AppSignatureLoader {
  store: UseBoundStore<StoreApi<AppSignatureStore>>
  load(): Promise<AppSignature>
}

export function createAppSignatureLoader(deps: AppSignatureLoaderDeps): AppSignatureLoader {
  const store = create<AppSignatureStore>()(() => ({ sig: null }))
  let inflight: Promise<AppSignature> | null = null
  let watching = false

  const set = (sig: AppSignature) => {
    if (!sameSig(store.getState().sig, sig)) store.setState({ sig })
  }

  async function ask(): Promise<AppSignature> {
    const source = deps.source()
    if (source === 'none') return { status: 'unknown', packaged: true }
    if (source === 'desktop') {
      const bridge = deps.desktop()
      return bridge ? parseAppSignature(await bridge.signature()) : unknownSig()
    }
    if (!watching) {
      watching = true
      deps.watchSim((raw) => set(parseAppSignature(raw)))
    }
    return parseAppSignature(await deps.sim().signature())
  }

  function load(): Promise<AppSignature> {
    if (inflight) return inflight
    // ask() is async: a synchronous throw inside it becomes a rejection too.
    const p: Promise<AppSignature> = ask().then(
      (sig) => {
        set(sig)
        return sig
      },
      () => {
        const sig = unknownSig()
        set(sig)
        // A failed ask may be retried by the next call (the next time the About block opens).
        if (inflight === p) inflight = null
        return sig
      },
    )
    inflight = p
    return p
  }

  return { store, load }
}

function desktopAppBridge(): DesktopAppBridge | null {
  if (typeof window === 'undefined') return null
  const app = window.bdpDesktop?.app as { signature?: unknown } | undefined
  return app && typeof app === 'object' && typeof app.signature === 'function' ? (app as DesktopAppBridge) : null
}

/** Where the signature verdict comes from in this window. */
export function appSignatureSource(): AppSignatureSource {
  if (desktopAppBridge()) return 'desktop'
  return isDesktop() ? 'none' : 'sim'
}

const appLoader = createAppSignatureLoader({
  source: appSignatureSource,
  desktop: desktopAppBridge,
  sim: devSignatureBridge,
  watchSim: (listener) => useDevSignature.subscribe((s) => listener(s)),
})

/** { sig } — select `sig` only. */
export const useAppSignature = appLoader.store
/** Ask for the verdict (idempotent: one promise in flight, kept after success). Never throws. */
export const loadAppSignature = appLoader.load
