// Provider registry + the "which provider runs new takes" setting + the gateway accessor.
//
// ---- For the UI (verified to exist) ----
//   activeProviderId(): ProviderId          provider that NEW takes will use: 'canvasapp' when chosen in Settings AND
//                                          the desktop bridge exists; otherwise 'dev' (development mode). Never 'mock'.
//   providerOf(take): ProviderId            provider a take ran on (take.provider, 'mock' for old takes). Re-exported here.
//   PROVIDER_LABEL[id]                      'dev' "Phát triển (giả lập)" | 'canvasapp' "canvasapp.io.vn" | 'mock' "Demo cũ".
//   SELECTABLE_PROVIDERS                    ['dev', 'canvasapp'] — the Settings choices ('canvasapp' needs the desktop app).
//   useProviderPrefs                        { provider, setProvider } — the Settings choice (persisted). setProvider
//                                          and the saved value only ever hold 'dev' | 'canvasapp' ('mock' or anything
//                                          unknown becomes 'dev').
//   providerBlockedReason(id)               Vietnamese reason new takes cannot use `id` right now, or null.
//   gatewayFor(id) / activeGateway()        { id, label, simulated, api, bridge(), provider() } of the dev or the real
//                                          canvasapp gateway (null for 'mock'). EVERYTHING that talks to "canvasapp"
//                                          (balance, login, top-up, credit history) goes through activeGateway(): in
//                                          development mode it is the in-app simulation, never the network.
//   canvasappApi() / devApi()               the API clients of the real / simulated gateway (prefer activeGateway().api).
//   resetDevMode()                          wipe the simulated canvasapp account AND SanoVids' dev-mode caches
//                                          (bridge project, upload cache, job ledger). Running dev takes then fail as
//                                          "job not found" — warn first. Refresh the balance afterwards
//                                          (store/credits refreshRealCredits({ force: true })).
//   useRuns(s => s.providerIssue)           (store/runs) last polling problem { provider, code, message, at } | null.
//   useRuns(s => s.engineElsewhere)         (store/runs) another tab/window of the project runs the queue.
//   Take fields (core/types): provider, remoteId, charged (false = not paid with demo credits), framesSnapshot,
//   imageKeysSnapshot, submitUnknown. A 'dev' / 'canvasapp' take failed with UNKNOWN_SUBMIT_ERROR (store/runs) was
//   never resubmitted: retry(takeId) re-sends THE SAME take (same key; the job is looked up first).
// The legacy 'mock' provider stays registered (store/runs) so old demo takes still show, refund and delete — it is never
// chosen for new takes.
// NOTE: do not import lib/pwa or store/* here (runs.ts imports this module; avoid import cycles).
import { create } from 'zustand'
import { getBlob } from '../lib/imageStore'
import { createCanvasappApi, type CanvasappApi } from './canvasapp/api'
import { browserStorage, createCanvasappProvider, JOBS_KEY, STATE_KEY, type CanvasappProvider } from './canvasapp/adapter'
import { canvasappBridge, createDesktopTransport, hasCanvasappBridge, WEB_UNAVAILABLE, type CanvasappBridge } from './canvasapp/transport'
import { devBridge, resetDevServer } from './dev'
import type { ProviderId, VideoProvider } from './types'

export type { ProviderId, VideoProvider } from './types'
export { providerOf } from './types'

const PREF_KEY = 'bdp:pref:provider'

/** Providers the user can choose for new takes. */
export type SelectableProviderId = 'dev' | 'canvasapp'
export const SELECTABLE_PROVIDERS: readonly SelectableProviderId[] = ['dev', 'canvasapp']

/** A saved / requested choice → a selectable provider: 'canvasapp' stays, anything else (old 'mock' included) is 'dev'. */
export const normalizeProviderChoice = (v: unknown): SelectableProviderId => (v === 'canvasapp' ? 'canvasapp' : 'dev')

function savedProvider(): SelectableProviderId {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    const p = normalizeProviderChoice(raw)
    // The old demo ('mock') became development mode: rewrite the saved choice once.
    if (raw !== null && raw !== p) localStorage.setItem(PREF_KEY, p)
    return p
  } catch {
    return 'dev'
  }
}

interface ProviderPrefs {
  /** Provider chosen in Settings ('dev' | 'canvasapp'). Effective provider: see activeProviderId(). */
  provider: ProviderId
  setProvider: (p: ProviderId) => void
}

export const useProviderPrefs = create<ProviderPrefs>()((set) => ({
  provider: savedProvider(),
  setProvider: (choice) => {
    const provider = normalizeProviderChoice(choice)
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
let dev: CanvasappProvider | null = null
let devClient: CanvasappApi | null = null

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

// ---- development mode ----

/** Engine poll interval (and floor) of the dev provider: the simulated site may be polled every 3 s. */
export const DEV_POLL_MS = 3_000
/** localStorage prefix of the dev provider's own records (bridge project, upload cache, job ledger). */
export const DEV_CLIENT_STORAGE_PREFIX = 'bdp:dev:client/'
export const DEV_PROVIDER_LABEL = 'Phát triển (giả lập)'

/** The API client of the simulated canvasapp (the real api.ts + desktop transport, over the in-app dev bridge). */
export function devApi(): CanvasappApi {
  if (!devClient) devClient = createCanvasappApi(createDesktopTransport(devBridge))
  return devClient
}

/** The dev provider: the real canvasapp adapter, as 'dev', polling the simulated site every 3 s. */
export function devProvider(): CanvasappProvider {
  if (!dev) {
    dev = createCanvasappProvider({
      id: 'dev',
      label: DEV_PROVIDER_LABEL,
      api: devApi(),
      getBlob,
      storage: browserStorage(DEV_CLIENT_STORAGE_PREFIX),
      minPollMs: DEV_POLL_MS,
      pollIntervalMs: DEV_POLL_MS,
    })
  }
  return dev
}

export function getProvider(id: ProviderId): VideoProvider {
  const hit = registry.get(id)
  if (hit) return hit
  if (id === 'canvasapp') {
    const p = canvasappProvider()
    registry.set('canvasapp', p)
    return p
  }
  if (id === 'dev') {
    const p = devProvider()
    registry.set('dev', p)
    return p
  }
  throw new Error(`Chưa đăng ký nhà cung cấp video “${id}”.`)
}

/** Provider used for NEW takes: the real gateway when chosen and possible, else development mode. */
export function activeProviderId(): ProviderId {
  return useProviderPrefs.getState().provider === 'canvasapp' && hasCanvasappBridge() ? 'canvasapp' : 'dev'
}

/** Synchronous pre-check used by enqueue / retry (login is checked when the job is submitted). Null = OK. */
export function providerBlockedReason(id: ProviderId): string | null {
  if (id === 'canvasapp' && !hasCanvasappBridge()) return WEB_UNAVAILABLE
  return null
}

export const PROVIDER_LABEL: Record<ProviderId, string> = { dev: DEV_PROVIDER_LABEL, canvasapp: 'canvasapp.io.vn', mock: 'Demo cũ' }

// ---- gateways ----

export interface Gateway {
  id: 'dev' | 'canvasapp'
  /** PROVIDER_LABEL[id] */
  label: string
  /** true = development mode: the in-app simulation (fake credits, no network). */
  simulated: boolean
  /** API client (balance /api/me, auth state, top-up, credit history, …). */
  api: CanvasappApi
  /** Login / logout / checkout bridge; null = not available here (the real gateway outside the desktop app). */
  bridge: () => CanvasappBridge | null
  /** The provider that runs takes through this gateway (reset() after logout). */
  provider: () => CanvasappProvider
}

/** The gateway of a provider ('dev' | 'canvasapp'); null for the legacy 'mock'. */
export function gatewayFor(id: ProviderId): Gateway | null {
  if (id === 'dev') return { id, label: PROVIDER_LABEL.dev, simulated: true, api: devApi(), bridge: devBridge, provider: devProvider }
  if (id === 'canvasapp') return { id, label: PROVIDER_LABEL.canvasapp, simulated: false, api: canvasappApi(), bridge: canvasappBridge, provider: canvasappProvider }
  return null
}

/** The gateway of the provider new takes use (activeProviderId() is never 'mock', so never null). */
export function activeGateway(): Gateway {
  return gatewayFor(activeProviderId()) ?? gatewayFor('dev')!
}

/**
 * Development mode from scratch: wipe the simulated account (projects, jobs, uploads, history, orders, blobs, faults —
 * the dev settings stay) and SanoVids' own dev-mode records (bridge project, upload cache, job ledger), so nothing
 * points at what no longer exists. The dev provider is rebuilt (a running dev take then fails as "job not found").
 */
export async function resetDevMode(): Promise<void> {
  await resetDevServer()
  const storage = browserStorage(DEV_CLIENT_STORAGE_PREFIX)
  storage.remove(STATE_KEY)
  storage.remove(JOBS_KEY)
  dev = null
  if (registry.has('dev')) registry.set('dev', devProvider())
}
