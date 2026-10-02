// Provider registry + the "which provider runs new takes" setting.
//
// ---- For the UI (verified to exist) ----
//   activeProviderId(): ProviderId          provider that NEW takes will use ('canvasapp' only when chosen in Settings
//                                          AND the desktop bridge exists; otherwise 'mock').
//   providerOf(take): ProviderId            provider a take ran on (take.provider, 'mock' for old takes). Re-exported here.
//   PROVIDER_LABEL[id]                      "Demo giả lập" | "canvasapp.io.vn".
//   useProviderPrefs                        { provider, setProvider } — the Settings choice (persisted).
//   providerBlockedReason(id)               Vietnamese reason new takes cannot use `id` right now, or null.
//   useRuns(s => s.providerIssue)           (store/runs) last polling problem { provider, code, message, at } | null;
//                                          cleared by the next successful poll. Running takes are kept meanwhile.
//   useRuns(s => s.engineElsewhere)         (store/runs) true = this tab has queued/running takes but another
//                                          tab/window of the project runs the queue (this one only shows progress).
//   canvasappApi()                          shared canvasapp API client over the desktop transport (store/credits reads
//                                          the real balance with canvasappApi().me()).
//   Take fields (core/types): provider, remoteId, charged (false = not paid with demo credits), framesSnapshot,
//   imageKeysSnapshot. The take whose provider is 'canvasapp' and status 'failed' with UNKNOWN_SUBMIT_ERROR
//   (store/runs) was never resubmitted: the user must check canvasapp.io.vn.
// Default and fallback: the mock (demo) provider. The canvasapp gateway is only active when the user chose it in
// Settings AND the desktop bridge exists (window.bdpDesktop.canvasapp).
// NOTE: do not import lib/pwa or store/* here (runs.ts imports this module; avoid import cycles).
import { create } from 'zustand'
import { getBlob } from '../lib/imageStore'
import { createCanvasappApi, type CanvasappApi } from './canvasapp/api'
import { browserStorage, createCanvasappProvider, type CanvasappProvider } from './canvasapp/adapter'
import { createDesktopTransport, hasCanvasappBridge, WEB_UNAVAILABLE } from './canvasapp/transport'
import type { ProviderId, VideoProvider } from './types'

export type { ProviderId, VideoProvider } from './types'
export { providerOf } from './types'

const PREF_KEY = 'bdp:pref:provider'

function savedProvider(): ProviderId {
  try {
    return localStorage.getItem(PREF_KEY) === 'canvasapp' ? 'canvasapp' : 'mock'
  } catch {
    return 'mock'
  }
}

interface ProviderPrefs {
  /** Provider chosen in Settings. Effective provider: see activeProviderId(). */
  provider: ProviderId
  setProvider: (p: ProviderId) => void
}

export const useProviderPrefs = create<ProviderPrefs>()((set) => ({
  provider: savedProvider(),
  setProvider: (provider) => {
    try {
      localStorage.setItem(PREF_KEY, provider)
    } catch {
      /* ignore */
    }
    set({ provider })
  },
}))

const registry = new Map<ProviderId, VideoProvider>()
let canvasapp: CanvasappProvider | null = null
let canvasappClient: CanvasappApi | null = null

export function registerProvider(p: VideoProvider): void {
  registry.set(p.id, p)
}

/** The canvasapp API client over the desktop transport (created on first use, shared with the provider). */
export function canvasappApi(): CanvasappApi {
  if (!canvasappClient) canvasappClient = createCanvasappApi(createDesktopTransport())
  return canvasappClient
}

/** The canvasapp gateway provider (created on first use). */
export function canvasappProvider(): CanvasappProvider {
  if (!canvasapp) {
    canvasapp = createCanvasappProvider({ api: canvasappApi(), getBlob, storage: browserStorage() })
  }
  return canvasapp
}

export function getProvider(id: ProviderId): VideoProvider {
  const hit = registry.get(id)
  if (hit) return hit
  if (id === 'canvasapp') {
    const p = canvasappProvider()
    registry.set('canvasapp', p)
    return p
  }
  throw new Error(`Chưa đăng ký nhà cung cấp video “${id}”.`)
}

/** Provider used for NEW takes. */
export function activeProviderId(): ProviderId {
  return useProviderPrefs.getState().provider === 'canvasapp' && hasCanvasappBridge() ? 'canvasapp' : 'mock'
}

/** Synchronous pre-check used by enqueue (login is checked when the job is submitted). Null = OK. */
export function providerBlockedReason(id: ProviderId): string | null {
  if (id === 'canvasapp' && !hasCanvasappBridge()) return WEB_UNAVAILABLE
  return null
}

export const PROVIDER_LABEL: Record<ProviderId, string> = { mock: 'Demo giả lập', canvasapp: 'canvasapp.io.vn' }
