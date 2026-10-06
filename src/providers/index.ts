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
//   What a gateway runs right now (/api/video-profiles, docs/GATEWAY-CANVASAPP.md §4):
//   useProviderLimits(s => s.rev[id])       revision signal: bumped whenever providerLimits(id) / providerLimitsInfo(id)
//                                          may have changed (a read started / ended, logout, provider replaced, a firm
//                                          read expiring). Select the number, then read the accessors below.
//   providerLimits(id): SettingsLimits      synchronous, never a request ('mock' / no method → NO_LIMITS); stable object
//                                          while what it refuses is unchanged.
//   providerLimitsInfo(id): LimitsInfo      when / how it was read (Bảng phát triển, the inspector note, toasts).
//   refreshProviderLimits(id, { force? })   read again (TTL-gated; force = "Đọc lại", at most every 5 s); never throws.
//   watchProviderLimits(id): () => void     while watched (inspector settings, run dialog), a firm read is renewed
//                                          shortly before it expires, so what they show never lapses into a guess.
//   providers/limits settingsRunBlock / settingsRunWarning   what the run check makes of it (store/runs, core/runGate).
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
import { devBridge, devResult, resetDevServer, withDevWording } from './dev'
import { NO_LIMITS, NO_LIMITS_INFO, type LimitsInfo, type ProviderId, type RefreshLimitsResult, type SettingsLimits, type VideoProvider } from './types'

export type { LimitsInfo, ProviderId, RefreshLimitsResult, SettingsLimits, VideoProvider } from './types'
export { NO_LIMITS, NO_LIMITS_INFO, providerOf } from './types'

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
  // another instance (tests, rebuilt providers): what it knows may differ
  bumpProviderLimits(p.id)
}

/** The canvasapp API client over the desktop transport (created on first use, shared with the provider). */
export function canvasappApi(): CanvasappApi {
  if (!canvasappClient) canvasappClient = createCanvasappApi(createDesktopTransport())
  return canvasappClient
}

/** The canvasapp gateway provider (created on first use). */
export function canvasappProvider(): CanvasappProvider {
  if (!canvasapp) {
    canvasapp = createCanvasappProvider({ api: canvasappApi(), getBlob, storage: browserStorage(), onLimitsChange: () => bumpProviderLimits('canvasapp') })
  }
  return canvasapp
}

// ---- development mode ----

/** Engine poll interval (and floor) of the dev provider: the simulated site may be polled every 3 s. */
export const DEV_POLL_MS = 3_000
/**
 * The dev provider reuses a job-list answer this long. Below DEV_POLL_MS minus the simulated latency (150 ms by
 * default, + "Chậm" faults): the cache is stamped when the answer arrives, so a 3 s cache would skip every other poll.
 */
export const DEV_LIST_CACHE_MS = 2_000
/** localStorage prefix of the dev provider's own records (bridge project, upload cache, job ledger). */
export const DEV_CLIENT_STORAGE_PREFIX = 'bdp:dev:client/'
export const DEV_PROVIDER_LABEL = 'Phát triển (giả lập)'

/** The API client of the simulated canvasapp (the real api.ts + desktop transport, over the in-app dev bridge). */
export function devApi(): CanvasappApi {
  // Its errors name the simulation ("canvasapp giả lập"), never send the user to the real site (dev/wording.ts).
  if (!devClient) devClient = withDevWording(createCanvasappApi(createDesktopTransport(devBridge)))
  return devClient
}

/**
 * The dev provider: the real canvasapp adapter, as 'dev', polling the simulated site every 3 s. Its messages (take
 * errors, provider issues) are in development-mode words: "kiểm tra trong Bảng phát triển", not on canvasapp.io.vn.
 */
export function devProvider(): CanvasappProvider {
  if (!dev) {
    const adapter = createCanvasappProvider({
      id: 'dev',
      label: DEV_PROVIDER_LABEL,
      api: devApi(),
      getBlob,
      storage: browserStorage(DEV_CLIENT_STORAGE_PREFIX),
      minPollMs: DEV_POLL_MS,
      pollIntervalMs: DEV_POLL_MS,
      listCacheMs: DEV_LIST_CACHE_MS,
      onLimitsChange: () => bumpProviderLimits('dev'),
    })
    dev = withDevWording(adapter, { poll: devResult, available: devResult })
  }
  return dev
}

/**
 * The provider of `id` (built on first use). Never bumps the limits signal (registry.set, not registerProvider): the
 * accessors below call it while rendering.
 */
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
  bumpProviderLimits('dev') // a new provider: nothing read yet
}

// ---- what the gateways run right now (/api/video-profiles) ----

/** Revision of what each provider's limits are (see the API notes at the top). Select `s.rev[id]` — a number. */
export const useProviderLimits = create<{ rev: Record<ProviderId, number> }>()(() => ({ rev: { dev: 0, canvasapp: 0, mock: 0 } }))

/** While watched, a firm read is renewed this long before it expires (no moment where it reads as a guess). */
export const LIMITS_RENEW_EARLY_MS = 30_000

const limitsTimers = new Map<ProviderId, ReturnType<typeof setTimeout>>()
const limitsWatchers = new Map<ProviderId, number>()

/** What providerLimits(id) / providerLimitsInfo(id) return may have changed: tell the UI, re-arm the expiry timer. */
export function bumpProviderLimits(id: ProviderId): void {
  useProviderLimits.setState((s) => ({ rev: { ...s.rev, [id]: (s.rev[id] ?? 0) + 1 } }))
  armLimitsTimer(id)
}

/**
 * One timer per provider, for the moment a firm read stops being firm: watched → read again a little before
 * (refreshProviderLimits force); not watched → just bump at expiry, so the run gate stops treating it as sure.
 */
function armLimitsTimer(id: ProviderId) {
  const old = limitsTimers.get(id)
  if (old !== undefined) clearTimeout(old)
  limitsTimers.delete(id)
  // the provider in use (it may be built through gatewayFor(…).provider() without being registered yet)
  const p = registry.get(id) ?? (id === 'dev' ? dev : id === 'canvasapp' ? canvasapp : null)
  let until: number | null = null
  try {
    until = p?.limitsInfo?.().firmUntil ?? null
  } catch {
    until = null
  }
  if (until === null) return
  const now = Date.now()
  if (now > until) return
  const watched = (limitsWatchers.get(id) ?? 0) > 0
  const renewAt = until - LIMITS_RENEW_EARLY_MS
  const early = watched && now < renewAt
  const timer = setTimeout(
    () => {
      limitsTimers.delete(id)
      if (!early) bumpProviderLimits(id)
      else if ((limitsWatchers.get(id) ?? 0) > 0) void refreshProviderLimits(id, { force: true }).finally(() => armLimitsTimer(id))
      else armLimitsTimer(id)
    },
    Math.max(0, (early ? renewAt : until) - now) + 50,
  )
  ;(timer as { unref?: () => void }).unref?.()
  limitsTimers.set(id, timer)
}

/** Keep `id`'s limits renewed while something shows them (returns unwatch). */
export function watchProviderLimits(id: ProviderId): () => void {
  limitsWatchers.set(id, (limitsWatchers.get(id) ?? 0) + 1)
  armLimitsTimer(id)
  let done = false
  return () => {
    if (done) return
    done = true
    limitsWatchers.set(id, Math.max(0, (limitsWatchers.get(id) ?? 1) - 1))
  }
}

/** What `id` refuses now (NO_LIMITS for the old demo or a provider without the method). Never a request, never throws. */
export function providerLimits(id: ProviderId): SettingsLimits {
  if (id === 'mock') return NO_LIMITS
  try {
    return getProvider(id).settingsLimits?.() ?? NO_LIMITS
  } catch {
    return NO_LIMITS
  }
}

/** How `id`'s limits were read. */
export function providerLimitsInfo(id: ProviderId): LimitsInfo {
  if (id === 'mock') return NO_LIMITS_INFO
  try {
    return getProvider(id).limitsInfo?.() ?? NO_LIMITS_INFO
  } catch {
    return NO_LIMITS_INFO
  }
}

/** Read `id`'s limits again (see VideoProvider.refreshLimits). Never throws. */
export async function refreshProviderLimits(id: ProviderId, opts: { force?: boolean } = {}): Promise<RefreshLimitsResult> {
  if (id === 'mock') return 'fresh'
  try {
    const p = getProvider(id)
    return p.refreshLimits ? await p.refreshLimits(opts) : 'fresh'
  } catch {
    return 'failed'
  }
}
