// The renderer side of auto-update: which bridge talks to an updater, and a mirror of its state for the UI.
//   - 'desktop': window.bdpDesktop.updates (electron/preload.cjs → electron/updater.cjs). The feed, the download and
//     the install live in the main process; the page only asks it to check / download / install / open the fixed
//     release page, and never sends a URL, a path or a version.
//   - 'sim':     outside Electron (`npm run dev`): the simulated updater of development mode (providers/dev/updates),
//     driven from "Bảng phát triển → Cập nhật". Starts as 'dev' / 'unsupported', so nothing shows until simulated.
//   - 'none':    a desktop build without the updates bridge (older preload): 'unsupported'.
// Every state received is validated (updateModel.parseUpdateState). The device pref (lib/updatePrefs) is pushed to the
// bridge before the first getState and on every change. Toasts and the install flow: src/updateActions.ts.
//
// ---- API ----
//   updatesSource() / updatesBridge()     'desktop' | 'sim' | 'none' and its bridge (null for 'none').
//   useUpdates                            zustand store { state: UpdateState; source } (select `state` or fields of it).
//   connectUpdates(): () => void          ref-counted: subscribe to the bridge (updateActions.startUpdates calls it).
//   checkUpdates / downloadUpdate / installUpdate / openReleasePage   → UpdateResult, never throw.
//   refreshUpdates()                      read the state again (after a manual check).
//   createUpdatesClient(deps)             the same with injected bridge / prefs (tests).
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { devUpdatesBridge } from '../providers/dev/updates'
import { parseUpdateState } from './updateModel'
import { useUpdatePrefs, type UpdatePrefsState } from './updatePrefs'
import { desktopInfo, isDesktop } from './pwa'
import type { DesktopUpdatesBridge, UpdateResult, UpdateResultCode, UpdateState } from './updateTypes'

export type UpdatesSource = 'desktop' | 'sim' | 'none'

const BRIDGE_METHODS = ['getState', 'check', 'download', 'install', 'setPrefs', 'openReleasePage', 'onState'] as const

function desktopUpdates(): DesktopUpdatesBridge | null {
  if (typeof window === 'undefined') return null
  const b = window.bdpDesktop?.updates as Partial<Record<string, unknown>> | undefined
  if (!b || typeof b !== 'object') return null
  return BRIDGE_METHODS.every((m) => typeof b[m] === 'function') ? (b as unknown as DesktopUpdatesBridge) : null
}

/** Where update states come from in this window. */
export function updatesSource(): UpdatesSource {
  if (desktopUpdates()) return 'desktop'
  return isDesktop() ? 'none' : 'sim'
}

/** The bridge of updatesSource() (null for 'none'). */
export function updatesBridge(): DesktopUpdatesBridge | null {
  const desktop = desktopUpdates()
  if (desktop) return desktop
  return isDesktop() ? null : devUpdatesBridge()
}

/** State shown when no updater answers (and before the first one does). */
export function noneUpdateState(autoDownload: boolean): UpdateState {
  return { kind: 'dev', status: 'unsupported', current: desktopInfo()?.version ?? '', autoDownload }
}

export interface UpdatesStore {
  state: UpdateState
  source: UpdatesSource
}

type PrefsApi = Pick<StoreApi<UpdatePrefsState>, 'getState' | 'subscribe'>

export interface UpdatesClientDeps {
  bridge: () => DesktopUpdatesBridge | null
  source: () => UpdatesSource
  prefs: PrefsApi
}

export interface UpdatesClient {
  store: UseBoundStore<StoreApi<UpdatesStore>>
  connect(): () => void
  check(): Promise<UpdateResult>
  download(): Promise<UpdateResult>
  install(): Promise<UpdateResult>
  openReleasePage(): Promise<UpdateResult>
  /** Read the state again (resolves once applied). */
  refresh(): Promise<void>
}

const RESULT_CODES: readonly UpdateResultCode[] = [
  'offline',
  'no-release',
  'rate-limited',
  'checksum',
  'signature',
  'disk',
  'install-failed',
  'failed',
  'not-allowed',
  'bad-request',
  'unsupported',
  'busy',
  'not-ready',
]
const FAILED: UpdateResult = { ok: false, code: 'failed', message: 'Trình cập nhật gặp lỗi.' }
export const NO_UPDATER: UpdateResult = { ok: false, code: 'unsupported', message: 'Bản này không tự cập nhật.' }

/** An answer of the bridge → a valid UpdateResult. */
export function parseUpdateResult(raw: unknown): UpdateResult {
  if (!raw || typeof raw !== 'object') return FAILED
  const r = raw as Record<string, unknown>
  if (r.ok === true) return { ok: true }
  if (r.ok === false && typeof r.code === 'string' && (RESULT_CODES as readonly string[]).includes(r.code) && typeof r.message === 'string') {
    return { ok: false, code: r.code as UpdateResultCode, message: r.message.slice(0, 300) }
  }
  return FAILED
}

const sameState = (a: UpdateState, b: UpdateState) => a === b || JSON.stringify(a) === JSON.stringify(b)

export function createUpdatesClient(deps: UpdatesClientDeps): UpdatesClient {
  const store = create<UpdatesStore>()(() => ({ state: noneUpdateState(deps.prefs.getState().autoDownload), source: deps.source() }))
  let refs = 0
  let teardown: (() => void) | null = null

  const apply = (raw: unknown) => {
    const cur = store.getState().state
    const next = parseUpdateState(raw, cur)
    if (!sameState(next, cur)) store.setState({ state: next })
  }

  async function call(fn: (b: DesktopUpdatesBridge) => Promise<unknown>): Promise<UpdateResult> {
    const b = deps.bridge()
    if (!b) return NO_UPDATER
    try {
      return parseUpdateResult(await fn(b))
    } catch {
      return FAILED
    }
  }

  async function refresh(): Promise<void> {
    const b = deps.bridge()
    if (!b) return
    try {
      apply(await b.getState())
    } catch {
      /* keep what is shown */
    }
  }

  function connect(): () => void {
    refs++
    if (refs === 1) {
      store.setState({ source: deps.source() })
      const b = deps.bridge()
      if (b) {
        let alive = true
        let offState: () => void = () => undefined
        try {
          const off = b.onState((s) => {
            if (alive) apply(s)
          })
          if (typeof off === 'function') offState = off
        } catch {
          /* no push: the state is read below and after actions */
        }
        const push = async (autoDownload: boolean) => {
          try {
            await b.setPrefs({ autoDownload })
          } catch {
            /* main keeps its saved copy */
          }
        }
        // The device pref first (main may hold an older copy), then the state.
        void (async () => {
          await push(deps.prefs.getState().autoDownload)
          if (!alive) return
          try {
            const s = await b.getState()
            if (alive) apply(s)
          } catch {
            /* keep the fallback state */
          }
        })()
        const offPrefs = deps.prefs.subscribe((s, prev) => {
          if (s.autoDownload !== prev.autoDownload) void push(s.autoDownload)
        })
        teardown = () => {
          alive = false
          offState()
          offPrefs()
        }
      }
    }
    let done = false
    return () => {
      if (done) return
      done = true
      refs--
      if (refs === 0) {
        teardown?.()
        teardown = null
      }
    }
  }

  return {
    store,
    connect,
    check: () => call((b) => b.check()),
    download: () => call((b) => b.download()),
    install: () => call((b) => b.install()),
    openReleasePage: () => call((b) => b.openReleasePage()),
    refresh,
  }
}

const client = createUpdatesClient({ bridge: updatesBridge, source: updatesSource, prefs: useUpdatePrefs })

/** The app's update state mirror. */
export const useUpdates = client.store
export const connectUpdates = client.connect
export const checkUpdates = client.check
export const downloadUpdate = client.download
export const installUpdate = client.install
export const openReleasePage = client.openReleasePage
export const refreshUpdates = client.refresh
/** The app's client (updateActions builds its controller on it). */
export const updatesClient = client
