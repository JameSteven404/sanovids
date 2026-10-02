// Credit balances shown in the UI — docs/SPEC-v2.md §9 "Demo credits vs real credits". Not undoable, not persisted.
//
// Two wallets, never mixed up:
//   demo       useRuns.credits (store/runs): local play money, spent only by the mock provider. Not real money.
//   canvasapp  the user's real canvasapp.io.vn balance: GET /api/me → credits_balance, through the desktop bridge
//              (providers canvasappApi()). Kept here in `useRealCredits`. Never invented: null ("—") until known.
//
// ---- API for the UI ----
//   useCreditInfo(): CreditInfo          THE way to show a balance. Re-renders when the provider choice or a balance
//                                        changes. Mounting it also starts the background sync (ref-counted).
//     kind: 'demo' | 'canvasapp'         follows the provider NEW takes use (activeProviderId(), Settings choice).
//     balance: number | null             demo: useRuns.credits. canvasapp: last confirmed real balance, null = unknown.
//     status: 'ok' | 'loading' | 'login-required' | 'unavailable' | 'error'
//                                        demo: always 'ok'. canvasapp: 'loading' until the first answer;
//                                        'login-required' after a 401 (balance null → show "Đăng nhập");
//                                        'unavailable' outside the desktop app (balance null);
//                                        'error' otherwise (balance = last known value or null, see `error`).
//     refresh(): Promise<void>           canvasapp: re-read now (forced, bypasses the 15 s throttle). demo: no-op.
//     updatedAt, error, refreshing       when the real balance was confirmed / Vietnamese problem text / read in flight.
//   useCreditKind(): CreditKind          just the kind (cheaper when no balance is shown).
//   getCreditInfo(): CreditInfo          non-reactive snapshot (actions, dialogs computing "after" balances).
//   Formatting (lib/credits, re-exported here): formatCredits(n, kind, { short }) → "20 credit demo" | "20 credit" |
//     short "20 cr"; creditUnitLabel(kind); formatVnd(n) → "20.000đ"; DEMO_CREDIT_HINT (demo tooltip);
//     CREDIT_SOURCE_LABEL[kind] → "credit demo" | "credit canvasapp".
//   Demo wallet actions live in store/runs: addCredits(n), resetDemoCredits() (→ DEMO_CREDITS_DEFAULT = 1000, spent 0).
//
// ---- Real balance store ----
//   useRealCredits                       zustand store RealCreditsState { balance, status ('idle' before the first
//                                        read), updatedAt, error, refreshing }.
//   refreshRealCredits({ force? })       read /api/me. Never throws; resolves with the new state.
//                                        - concurrent calls share the request in flight (dedupe);
//                                        - without force nothing is sent when the last read started < 15 s ago;
//                                        - force while a read is in flight queues ONE more read after it (the running
//                                          one may predate a charge), shared by every forced caller meanwhile.
//                                        401 → 'login-required' (balance cleared); no desktop bridge → 'unavailable'
//                                        (no request sent); other errors → 'error' (last known balance kept).
//   resetRealCredits()                   forget everything (call after logging out of canvasapp); a read in flight
//                                        is ignored when it lands.
//   startRealCreditsSync(): () => void   ref-counted background sync; returns its stop function. useCreditInfo()
//                                        calls it, so the app needs no extra wiring. While the active provider is
//                                        canvasapp: refresh when sync starts / canvasapp gets chosen, on window focus,
//                                        when the tab becomes visible, and every 60 s while visible (all throttled).
//                                        Whatever the active provider: a forced refresh after every canvasapp job is
//                                        submitted / completed / failed / cancelled (store/runs onRunEvent).
//   For tests / embedding: createRealCredits(deps) and createCreditsSync(deps) (fake transport, fake window).
import { useEffect, useMemo } from 'react'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { creditKindOf, type CreditKind } from '../lib/credits'
import { activeProviderId, canvasappApi, useProviderPrefs } from '../providers'
import { CanvasappError, canvasappErrorText, isLoginRequired, type CanvasappApi } from '../providers/canvasapp/api'
import { WEB_UNAVAILABLE } from '../providers/canvasapp/transport'
import { onRunEvent, resumeProviderPolling, useRuns, type RunEvent } from './runs'

export {
  CREDIT_SOURCE_LABEL,
  creditKindOf,
  creditUnitLabel,
  DEMO_CREDIT_HINT,
  DEMO_CREDITS_DEFAULT,
  formatCreditNumber,
  formatCredits,
  formatVnd,
  type CreditFormatOptions,
  type CreditKind,
} from '../lib/credits'

/** Without force, the real balance is not read again sooner than this after the last read started. */
export const CREDITS_MIN_REFRESH_MS = 15_000
/** Background refresh period while the window is visible and canvasapp is the active provider. */
export const CREDITS_SYNC_INTERVAL_MS = 60_000

export type RealCreditsStatus = 'idle' | 'loading' | 'ok' | 'login-required' | 'unavailable' | 'error'

export interface RealCreditsState {
  /** Last balance confirmed by canvasapp; null = unknown (show "—"). Cleared on login-required / unavailable / reset. */
  balance: number | null
  status: RealCreditsStatus
  /** When `balance` was confirmed (ms since epoch); null = never. */
  updatedAt: number | null
  /** Vietnamese text of the last problem; null when status is idle / loading / ok. */
  error: string | null
  /** A read is in flight. The status keeps its value meanwhile (only 'idle' becomes 'loading'). */
  refreshing: boolean
}

export interface RefreshOptions {
  /** Bypass the 15 s throttle (after a job, login, or the user clicking the balance). */
  force?: boolean
}

export interface RealCreditsDeps {
  /** canvasapp API client; only `transport.available()` and `me()` are used. Called on every read (lazy). */
  api: () => Pick<CanvasappApi, 'me' | 'transport'>
  now?: () => number
  /** Throttle for non-forced reads (default CREDITS_MIN_REFRESH_MS). */
  minIntervalMs?: number
}

export interface RealCredits {
  store: UseBoundStore<StoreApi<RealCreditsState>>
  refresh: (opts?: RefreshOptions) => Promise<RealCreditsState>
  reset: () => void
}

const INITIAL: RealCreditsState = { balance: null, status: 'idle', updatedAt: null, error: null, refreshing: false }

const NO_BALANCE = 'canvasapp không trả về số credit (credits_balance) — thử lại sau.'

function balanceOf(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  return Number.isFinite(n) ? n : null
}

/** A real-balance store with its own throttle / dedupe state. The app uses one default instance (below). */
export function createRealCredits(deps: RealCreditsDeps): RealCredits {
  const now = deps.now ?? Date.now
  const minInterval = deps.minIntervalMs ?? CREDITS_MIN_REFRESH_MS
  const store = create<RealCreditsState>()(() => ({ ...INITIAL }))

  let inflight: Promise<RealCreditsState> | null = null
  let followUp: Promise<RealCreditsState> | null = null
  let lastAttempt = Number.NEGATIVE_INFINITY
  /** Bumped by reset(): a read started before is ignored when it lands. */
  let epoch = 0

  async function read(): Promise<Partial<RealCreditsState>> {
    try {
      const api = deps.api()
      const avail = await api.transport.available()
      if (!avail.ok) return { status: 'unavailable', balance: null, error: avail.reason || WEB_UNAVAILABLE }
      const me = await api.me()
      const balance = balanceOf((me as { credits_balance?: unknown } | undefined)?.credits_balance)
      if (balance === null) return { status: 'error', balance: null, error: NO_BALANCE }
      return { status: 'ok', balance, updatedAt: now(), error: null }
    } catch (e) {
      if (isLoginRequired(e)) return { status: 'login-required', balance: null, error: canvasappErrorText(e) }
      if (e instanceof CanvasappError && e.code === 'unavailable') return { status: 'unavailable', balance: null, error: e.message || WEB_UNAVAILABLE }
      // Network / server trouble: keep the last confirmed balance (updatedAt says how old it is).
      return { status: 'error', error: canvasappErrorText(e) }
    }
  }

  function run(): Promise<RealCreditsState> {
    const mine = epoch
    lastAttempt = now()
    store.setState((s) => ({ refreshing: true, status: s.status === 'idle' ? 'loading' : s.status }))
    const p = read().then((patch) => {
      if (mine !== epoch) return store.getState() // reset meanwhile: forget this answer
      inflight = null
      store.setState({ ...patch, refreshing: false })
      return store.getState()
    })
    inflight = p
    return p
  }

  function refresh(opts: RefreshOptions = {}): Promise<RealCreditsState> {
    if (inflight) {
      if (!opts.force) return inflight
      if (!followUp) {
        const fu: Promise<RealCreditsState> = inflight.then(() => {
          if (followUp === fu) followUp = null
          return inflight ?? run()
        })
        followUp = fu
      }
      return followUp
    }
    if (!opts.force && now() - lastAttempt < minInterval) return Promise.resolve(store.getState())
    return run()
  }

  function reset() {
    epoch++
    inflight = null
    followUp = null
    lastAttempt = Number.NEGATIVE_INFINITY
    store.setState({ ...INITIAL })
  }

  return { store, refresh, reset }
}

// ---------------------------------------------------------------------------------------------
// Background sync
// ---------------------------------------------------------------------------------------------

interface Listenable {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export interface SyncEnv {
  window?: Listenable | null
  document?: (Listenable & { visibilityState?: string }) | null
}

export interface CreditsSyncDeps {
  refresh: (opts?: RefreshOptions) => Promise<unknown>
  /** True while the provider for new takes is canvasapp. */
  isActive: () => boolean
  /** Called whenever the provider choice may have changed. Returns unsubscribe. */
  subscribeActive: (listener: () => void) => () => void
  /** Take lifecycle events (store/runs onRunEvent). Returns unsubscribe. */
  subscribeJobs: (listener: (e: RunEvent) => void) => () => void
  /** Window / document to listen on (default: the page's, when present). */
  env?: () => SyncEnv
  /** Default CREDITS_SYNC_INTERVAL_MS. */
  intervalMs?: number
}

function browserEnv(): SyncEnv {
  const ok = (x: unknown): x is Listenable => !!x && typeof (x as Listenable).addEventListener === 'function'
  const win = typeof window !== 'undefined' ? window : null
  const doc = typeof document !== 'undefined' ? document : null
  return { window: ok(win) ? win : null, document: ok(doc) ? doc : null }
}

/** Ref-counted sync: `start()` returns a stop function; listeners/timers exist while at least one start is live. */
export function createCreditsSync(deps: CreditsSyncDeps): { start: () => () => void; running: () => boolean } {
  let refs = 0
  let teardown: (() => void) | null = null

  function setup(): () => void {
    const { window: win = null, document: doc = null } = (deps.env ?? browserEnv)()
    const visible = () => doc?.visibilityState !== 'hidden'
    const maybeRefresh = () => {
      if (deps.isActive() && visible()) void deps.refresh()
    }
    const onVisibility = () => {
      if (visible()) maybeRefresh()
    }
    win?.addEventListener('focus', maybeRefresh)
    doc?.addEventListener('visibilitychange', onVisibility)
    const timer = setInterval(maybeRefresh, deps.intervalMs ?? CREDITS_SYNC_INTERVAL_MS)
    let wasActive = deps.isActive()
    const offActive = deps.subscribeActive(() => {
      const active = deps.isActive()
      if (active && !wasActive) maybeRefresh()
      wasActive = active
    })
    // A canvasapp job changes the real balance whichever provider is chosen for new takes now.
    const offJobs = deps.subscribeJobs((e) => {
      if (e.provider === 'canvasapp') void deps.refresh({ force: true })
    })
    maybeRefresh()
    return () => {
      win?.removeEventListener('focus', maybeRefresh)
      doc?.removeEventListener('visibilitychange', onVisibility)
      clearInterval(timer)
      offActive()
      offJobs()
    }
  }

  return {
    start: () => {
      refs++
      if (refs === 1) teardown = setup()
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        refs--
        if (refs === 0) {
          teardown?.()
          teardown = null
        }
      }
    },
    running: () => refs > 0,
  }
}

// ---------------------------------------------------------------------------------------------
// Default instance (the app's)
// ---------------------------------------------------------------------------------------------

const realCredits = createRealCredits({ api: () => canvasappApi() })

export const useRealCredits = realCredits.store
export const refreshRealCredits = realCredits.refresh
export const resetRealCredits = realCredits.reset

// Every confirmed balance proves the canvasapp session works: running canvasapp takes whose polling backed off after
// a 401 poll again at the next interval (the user logged in again) instead of waiting up to 10 minutes.
useRealCredits.subscribe((s, prev) => {
  if (prev.refreshing && !s.refreshing && s.status === 'ok') resumeProviderPolling('canvasapp')
})

const sync = createCreditsSync({
  refresh: refreshRealCredits,
  isActive: () => activeProviderId() === 'canvasapp',
  subscribeActive: (listener) => useProviderPrefs.subscribe(() => listener()),
  subscribeJobs: onRunEvent,
})

export const startRealCreditsSync = sync.start

// ---------------------------------------------------------------------------------------------
// What the UI shows
// ---------------------------------------------------------------------------------------------

export type CreditStatus = 'ok' | 'loading' | 'login-required' | 'unavailable' | 'error'

export interface CreditInfo {
  kind: CreditKind
  /** null = unknown: show "—", never a made-up number. */
  balance: number | null
  status: CreditStatus
  /** canvasapp: forced re-read of the real balance. demo: no-op. */
  refresh: () => Promise<void>
  /** canvasapp: when the balance was confirmed. demo: null. */
  updatedAt: number | null
  /** Vietnamese problem text (canvasapp), else null. */
  error: string | null
  /** canvasapp read in flight. */
  refreshing: boolean
}

type RealView = Pick<RealCreditsState, 'balance' | 'status' | 'updatedAt' | 'error' | 'refreshing'>

const refreshDemo = (): Promise<void> => Promise.resolve()
const refreshReal = (): Promise<void> => refreshRealCredits({ force: true }).then(() => undefined)

/** Pure: the CreditInfo for a kind, the demo balance and the real-balance state. */
export function creditInfoFrom(kind: CreditKind, demoCredits: number, real: RealView): CreditInfo {
  if (kind === 'demo') {
    return { kind, balance: demoCredits, status: 'ok', refresh: refreshDemo, updatedAt: null, error: null, refreshing: false }
  }
  return {
    kind,
    balance: real.balance,
    // Before the first answer the sync is about to read it: "loading", shown as "—".
    status: real.status === 'idle' ? 'loading' : real.status,
    refresh: refreshReal,
    updatedAt: real.updatedAt,
    error: real.error,
    refreshing: real.refreshing,
  }
}

/** Non-reactive snapshot of what useCreditInfo() returns. */
export function getCreditInfo(): CreditInfo {
  return creditInfoFrom(creditKindOf(activeProviderId()), useRuns.getState().credits, useRealCredits.getState())
}

/** Which wallet the next run uses; re-renders when the Settings choice changes. */
export function useCreditKind(): CreditKind {
  useProviderPrefs((s) => s.provider)
  return creditKindOf(activeProviderId())
}

/** Balance to show for the active provider (see the API notes at the top). Starts the background sync. */
export function useCreditInfo(): CreditInfo {
  useEffect(() => startRealCreditsSync(), [])
  const kind = useCreditKind()
  const demo = useRuns((s) => s.credits)
  const real = useRealCredits(
    useShallow((s): RealView => ({ balance: s.balance, status: s.status, updatedAt: s.updatedAt, error: s.error, refreshing: s.refreshing })),
  )
  return useMemo(() => creditInfoFrom(kind, demo, real), [kind, demo, real])
}
