// Development mode: a simulated auto-updater (the DesktopUpdatesBridge of lib/updateTypes.ts) so the update UI — top-bar
// pill, "Cập nhật SanoVids" dialog, Settings → Cập nhật, toasts, "Cập nhật khi xong" — can be tried in the browser
// (`npm run dev`). No network, nothing is downloaded or installed. lib/updates uses it ONLY outside Electron; the
// desktop app always talks to the real updater in the main process (electron/updater.cjs).
//
// It follows the main process rules (electron/updater-rules.cjs reduceUpdateState and the IPC checks): download only
// for an installer build with status 'available' (or 'error' after a failed download), install only when 'ready', no
// check at all for the 'dev' kind. Driven from "Bảng phát triển → Cập nhật" (components/dev/DevUpdatesTab.tsx).
//
// ---- API ----
//   useDevUpdates                     zustand store { state, nextCheck, draft } (select fields).
//   devUpdatesBridge()                the app's simulated bridge (created on first use) — DesktopUpdatesBridge + controls.
//   devUpdates.simulate(patch)        set state fields directly. Another kind is another launch: status 'idle' ('dev' ⇒
//                                     'unsupported'), release / progress / error / last check / notice dropped.
//   devUpdates.setNextCheck(o)        what the next check finds: 'none' | 'available' | 'offline' | 'no-release'.
//   devUpdates.setDraft(d)            running version / new version / release notes used by the next "available".
//   devUpdates.announce() / runDownload() / markReady() / failNetwork() / markNone()   one-click states.
//   devUpdates.reset()                back to the initial state (timers stopped; the auto-download pref is kept).
//   createDevUpdatesBridge(opts)      a separate instance (tests).
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { version as APP_VERSION } from '../../../package.json'
import { isUpdateVersion, UPDATE_ERROR_TEXT, UPDATE_UNSUPPORTED_TEXT } from '../../lib/updateModel'
import { UPDATE_NOTES_MAX, type DesktopUpdatesBridge, type UpdateError, type UpdateResult, type UpdateState } from '../../lib/updateTypes'
import { toast } from '../../store/ui'

export type DevNextCheck = 'none' | 'available' | 'offline' | 'no-release'

export interface DevUpdatesDraft {
  /** "Phiên bản đang chạy". */
  current: string
  /** "Phiên bản mới". */
  version: string
  /** "Ghi chú phát hành" (markdown-ish; HTML must show as text). */
  notes: string
}

export interface DevUpdatesStore {
  state: UpdateState
  nextCheck: DevNextCheck
  draft: DevUpdatesDraft
}

export const DEV_NEXT_CHECK_LABEL: Record<DevNextCheck, string> = {
  none: 'Không có bản mới',
  available: 'Có bản mới',
  offline: 'Lỗi mạng',
  'no-release': 'Chưa có bản phát hành',
}

/** "0.5.1" → "0.5.2" (last number + 1; a suffix is dropped). */
export function nextPatchVersion(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '0.0.1'
}

/** The simulation starts from the real app version (package.json) and offers the next patch. */
export const DEV_UPDATES_DRAFT_DEFAULT: DevUpdatesDraft = {
  current: APP_VERSION,
  version: nextPatchVersion(APP_VERSION),
  notes: '## Bản thử\n- ✨ **Tự cập nhật** trong nền\n- 🐞 Sửa lỗi nhỏ\n- <b>thẻ HTML bị bỏ, chỉ còn chữ</b>',
}

const MB = 1024 * 1024
/** Size of the simulated installer. */
export const DEV_UPDATE_SIZE = 98 * MB
/** Simulated download speed (bytes / s). */
export const DEV_UPDATE_SPEED = 2.1 * MB
/** Time a simulated check takes. */
export const DEV_CHECK_MS = 600
/** Progress step: +5 % every 250 ms. */
export const DEV_DOWNLOAD_TICK_MS = 250
/** Time between "install" and the simulated restart. */
export const DEV_INSTALL_MS = 1500

export const devUpdatesInitialState = (current = DEV_UPDATES_DRAFT_DEFAULT.current): UpdateState => ({ kind: 'dev', status: 'unsupported', current, autoDownload: true })

const initialStore = (): DevUpdatesStore => ({ state: devUpdatesInitialState(), nextCheck: 'available', draft: { ...DEV_UPDATES_DRAFT_DEFAULT } })

export const useDevUpdates: UseBoundStore<StoreApi<DevUpdatesStore>> = create<DevUpdatesStore>()(initialStore)

// ---------------------------------------------------------------------------------------------
// The main process state machine (same rules as electron/updater-rules.cjs reduceUpdateState)
// ---------------------------------------------------------------------------------------------

interface ReleaseInfo {
  version: string
  releaseDate?: string
  notes: string
  size?: number
}

type SimEvent =
  | { type: 'checking' }
  | { type: 'not-available' }
  | { type: 'available'; info: ReleaseInfo }
  | { type: 'progress'; p: { percent: number; transferred: number; total: number; bytesPerSecond: number } }
  | { type: 'downloaded'; info: { version: string } }
  | { type: 'cancelled' }
  | { type: 'check-error'; error: UpdateError }
  | { type: 'download-error'; error: UpdateError }
  | { type: 'install-error'; error: UpdateError }
  | { type: 'prefs'; autoDownload: boolean }

const PROGRESS_KEYS = ['percent', 'transferred', 'total', 'bytesPerSecond'] as const
const RELEASE_KEYS = ['version', 'releaseDate', 'notes', 'size'] as const

function without(s: UpdateState, keys: readonly (keyof UpdateState)[]): UpdateState {
  const out = { ...s }
  for (const k of keys) delete out[k]
  return out
}

const clampNum = (n: number, max = Number.MAX_SAFE_INTEGER) => (Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0)

function withRelease(s: UpdateState, info: ReleaseInfo): UpdateState {
  const out: UpdateState = { ...s, version: info.version, notes: info.notes.slice(0, UPDATE_NOTES_MAX) }
  if (info.releaseDate) out.releaseDate = info.releaseDate.slice(0, 40)
  if (info.size !== undefined) out.size = info.size
  return out
}

/** The updater state after an event (pure). */
export function reduceDevUpdateState(s: UpdateState, e: SimEvent, now: number): UpdateState {
  const busy = s.status === 'downloading' || s.status === 'ready'
  switch (e.type) {
    case 'checking':
      // A known update stays announced while it is checked again (a failed re-check keeps it).
      return busy || s.status === 'available' ? s : { ...without(s, ['error']), status: 'checking' }
    case 'not-available':
      if (busy) return { ...s, lastCheck: now }
      return { ...without(s, [...RELEASE_KEYS, ...PROGRESS_KEYS, 'error']), status: 'none', lastCheck: now }
    case 'available':
      if (busy && e.info.version === s.version) return { ...s, lastCheck: now }
      return withRelease({ ...without(s, [...RELEASE_KEYS, ...PROGRESS_KEYS, 'error']), status: 'available', lastCheck: now }, e.info)
    case 'progress':
      return {
        ...s,
        status: 'downloading',
        percent: clampNum(e.p.percent, 100),
        transferred: clampNum(e.p.transferred),
        total: clampNum(e.p.total),
        bytesPerSecond: clampNum(e.p.bytesPerSecond),
      }
    case 'downloaded':
      return { ...without(s, ['error']), status: 'ready', version: e.info.version, percent: 100 }
    case 'cancelled':
      return { ...without(s, PROGRESS_KEYS), status: 'available' }
    case 'check-error':
      if (busy || s.status === 'available') return { ...s, lastCheck: now }
      return { ...s, status: 'error', error: e.error, lastCheck: now }
    case 'download-error':
      return { ...without(s, PROGRESS_KEYS), status: 'error', error: e.error }
    case 'install-error':
      return { ...s, status: 'ready', error: e.error }
    case 'prefs':
      return { ...s, autoDownload: e.autoDownload }
  }
}

// ---------------------------------------------------------------------------------------------
// Simulated bridge
// ---------------------------------------------------------------------------------------------

export interface DevUpdatesSim extends DesktopUpdatesBridge {
  simulate(patch: Partial<UpdateState>): void
  setNextCheck(o: DevNextCheck): void
  setDraft(d: Partial<DevUpdatesDraft>): void
  /** "Có bản mới": the check found the draft version (auto-download as in main). */
  announce(): void
  /** "Đang tải": start the simulated download (→ ready). */
  runDownload(): void
  /** "Đã tải xong". */
  markReady(): void
  /** "Lỗi mạng": status 'error' (offline). */
  failNetwork(): void
  /** "Không có bản mới". */
  markNone(): void
  reset(): void
}

export interface DevUpdatesOptions {
  store?: StoreApi<DevUpdatesStore>
  /** Toasts of the simulated install / release page (default: store/ui toast). */
  notify?: (text: string) => void
  now?: () => number
}

const OK: UpdateResult = { ok: true }
const fail = (code: Exclude<UpdateResult, { ok: true }>['code'], message: string): UpdateResult => ({ ok: false, code, message })
const clone = (s: UpdateState): UpdateState => JSON.parse(JSON.stringify(s)) as UpdateState
const today = (now: number) => new Date(now).toISOString()

export function createDevUpdatesBridge(opts: DevUpdatesOptions = {}): DevUpdatesSim {
  const store = opts.store ?? useDevUpdates
  const notify = opts.notify ?? ((text: string) => void toast(text, { tone: 'info', ms: 5000 }))
  const now = opts.now ?? (() => Date.now())
  let checkTimer: ReturnType<typeof setTimeout> | null = null
  let checkResolve: ((r: UpdateResult) => void) | null = null
  let downloadTimer: ReturnType<typeof setInterval> | null = null
  let installTimer: ReturnType<typeof setTimeout> | null = null

  const get = () => store.getState()
  const setState = (state: UpdateState) => store.setState({ state })
  const dispatch = (e: SimEvent) => setState(reduceDevUpdateState(get().state, e, now()))

  function stopTimers() {
    if (checkTimer) clearTimeout(checkTimer)
    checkTimer = null
    if (checkResolve) checkResolve(fail('unsupported', UPDATE_UNSUPPORTED_TEXT))
    checkResolve = null
    if (downloadTimer) clearInterval(downloadTimer)
    downloadTimer = null
    if (installTimer) clearTimeout(installTimer)
    installTimer = null
  }

  /** The release the draft describes. */
  function draftInfo(): ReleaseInfo {
    const { draft, state } = get()
    const version = isUpdateVersion(draft.version) ? draft.version : nextPatchVersion(state.current)
    return { version, notes: draft.notes, releaseDate: today(now()), size: DEV_UPDATE_SIZE }
  }

  function startDownload() {
    if (downloadTimer) return
    const s = get().state
    const total = s.size ?? DEV_UPDATE_SIZE
    let pct = s.status === 'downloading' && s.percent ? s.percent : 0
    const step = () => dispatch({ type: 'progress', p: { percent: pct, transferred: Math.round((total * pct) / 100), total, bytesPerSecond: DEV_UPDATE_SPEED } })
    step()
    downloadTimer = setInterval(() => {
      pct = Math.min(100, pct + 5)
      if (get().state.status !== 'downloading') {
        // Something else changed the state meanwhile (a simulate button): stop quietly.
        if (downloadTimer) clearInterval(downloadTimer)
        downloadTimer = null
        return
      }
      step()
      if (pct >= 100) {
        if (downloadTimer) clearInterval(downloadTimer)
        downloadTimer = null
        const v = get().state.version
        if (v) dispatch({ type: 'downloaded', info: { version: v } })
      }
    }, DEV_DOWNLOAD_TICK_MS)
  }

  /** Main's side effect: a change to 'available' starts the download for an installer build with auto-download on. */
  function announceInfo(info: ReleaseInfo) {
    const before = get().state.status
    dispatch({ type: 'available', info })
    const after = get().state
    if (after.kind === 'installer' && after.autoDownload && after.status === 'available' && before !== 'available') startDownload()
  }

  function finishCheck(): UpdateResult {
    const { nextCheck } = get()
    if (nextCheck === 'none') {
      dispatch({ type: 'not-available' })
      return OK
    }
    if (nextCheck === 'available') {
      announceInfo(draftInfo())
      return OK
    }
    const error: UpdateError = { code: nextCheck, message: UPDATE_ERROR_TEXT[nextCheck] }
    dispatch({ type: 'check-error', error })
    return fail(error.code, error.message)
  }

  /** The state buttons need a build that updates: the 'dev' kind becomes the installer. */
  function ensureUpdatable() {
    if (get().state.kind === 'dev') sim.simulate({ kind: 'installer' })
  }

  const sim: DevUpdatesSim = {
    getState: async () => clone(get().state),

    check: () => {
      const s = get().state
      if (s.kind === 'dev' || s.status === 'unsupported') return Promise.resolve(fail('unsupported', UPDATE_UNSUPPORTED_TEXT))
      if (s.status === 'downloading' || checkTimer) return Promise.resolve(fail('busy', 'Đang kiểm tra hoặc đang tải bản cập nhật.'))
      dispatch({ type: 'checking' })
      return new Promise<UpdateResult>((resolve) => {
        checkResolve = resolve
        checkTimer = setTimeout(() => {
          checkTimer = null
          checkResolve = null
          resolve(finishCheck())
        }, DEV_CHECK_MS)
      })
    },

    download: async () => {
      const s = get().state
      if (s.kind !== 'installer') return fail('unsupported', 'Chỉ bản cài mới tự tải được bản cập nhật.')
      if (!(s.status === 'available' || (s.status === 'error' && s.version))) return fail('not-ready', 'Chưa có bản cập nhật để tải.')
      startDownload()
      return OK
    },

    install: async () => {
      const s = get().state
      if (s.kind !== 'installer') return fail('unsupported', 'Bản này không tự cài được.')
      if (s.status !== 'ready' || !s.version || installTimer) return fail('not-ready', 'Bản cập nhật chưa tải xong.')
      const version = s.version
      notify(`Giả lập: SanoVids sẽ khởi động lại và cài bản ${version}.`)
      installTimer = setTimeout(() => {
        installTimer = null
        const cur = get().state
        if (cur.status !== 'ready' || cur.version !== version) return
        store.setState((st) => ({
          state: { kind: cur.kind, current: version, status: 'none', autoDownload: cur.autoDownload, lastCheck: now(), notice: { kind: 'updated', from: cur.current, version } },
          draft: { ...st.draft, current: version, version: nextPatchVersion(version) },
        }))
      }, DEV_INSTALL_MS)
      return OK
    },

    setPrefs: async (p) => {
      if (!p || typeof p !== 'object' || typeof p.autoDownload !== 'boolean') return fail('bad-request', 'Giá trị không hợp lệ.')
      dispatch({ type: 'prefs', autoDownload: p.autoDownload })
      const s = get().state
      if (p.autoDownload && s.kind === 'installer' && s.status === 'available') startDownload()
      return OK
    },

    openReleasePage: async () => {
      notify('Giả lập: sẽ mở trang tải về trên GitHub.')
      return OK
    },

    onState: (listener) => {
      if (typeof listener !== 'function') return () => undefined
      return store.subscribe((s, prev) => {
        if (s.state !== prev.state) listener(clone(s.state))
      })
    },

    simulate: (patch) => {
      stopTimers()
      const cur = get().state
      const kind = patch.kind ?? cur.kind
      // Another kind of build is another launch: nothing of the previous one carries over (status, release, progress,
      // error, last check, notice), only the running version and the pref. Explicit fields of the patch still apply.
      const base: UpdateState =
        kind !== cur.kind ? { kind, current: cur.current, status: kind === 'dev' ? 'unsupported' : 'idle', autoDownload: cur.autoDownload } : cur
      let next: UpdateState = { ...base, ...patch, kind }
      if (kind === 'dev') next = { ...without(next, [...RELEASE_KEYS, ...PROGRESS_KEYS, 'error']), status: 'unsupported' }
      setState(next)
    },

    setNextCheck: (o) => {
      if (o === 'none' || o === 'available' || o === 'offline' || o === 'no-release') store.setState({ nextCheck: o })
    },

    setDraft: (d) => {
      const draft = { ...get().draft }
      if (typeof d.current === 'string') draft.current = d.current.slice(0, 64)
      if (typeof d.version === 'string') draft.version = d.version.slice(0, 64)
      if (typeof d.notes === 'string') draft.notes = d.notes.slice(0, UPDATE_NOTES_MAX)
      const s = get().state
      let state = s
      // The running version shows at once; edited notes too, so the dialog previews them.
      if (typeof d.current === 'string' && isUpdateVersion(draft.current)) state = { ...state, current: draft.current }
      if (typeof d.notes === 'string' && state.version) state = { ...state, notes: draft.notes }
      store.setState(state === s ? { draft } : { draft, state })
    },

    announce: () => {
      stopTimers()
      ensureUpdatable()
      announceInfo(draftInfo())
    },

    runDownload: () => {
      stopTimers()
      ensureUpdatable()
      const s = get().state
      const info = s.version ? null : draftInfo()
      setState({ ...without(info ? withRelease(s, info) : s, [...PROGRESS_KEYS, 'error']), status: 'downloading', percent: 0 })
      startDownload()
    },

    markReady: () => {
      stopTimers()
      ensureUpdatable()
      const s = get().state
      const base = s.version ? s : withRelease(s, draftInfo())
      setState({ ...without(base, ['error', 'transferred', 'bytesPerSecond']), status: 'ready', percent: 100, lastCheck: now() })
    },

    failNetwork: () => {
      stopTimers()
      ensureUpdatable()
      const s = get().state
      setState({ ...without(s, PROGRESS_KEYS), status: 'error', error: { code: 'offline', message: UPDATE_ERROR_TEXT.offline }, lastCheck: now() })
    },

    markNone: () => {
      stopTimers()
      ensureUpdatable()
      const s = get().state
      setState({ ...without(s, [...RELEASE_KEYS, ...PROGRESS_KEYS, 'error']), status: 'none', lastCheck: now() })
    },

    reset: () => {
      stopTimers()
      // The auto-download pref belongs to Settings (lib/updatePrefs pushes it only when it changes): keep it.
      const autoDownload = get().state.autoDownload
      const fresh = initialStore()
      store.setState({ ...fresh, state: { ...fresh.state, autoDownload } })
    },
  }
  return sim
}

let appSim: DevUpdatesSim | null = null

/** The app's simulated updater (development mode in a browser). */
export function devUpdatesBridge(): DevUpdatesSim {
  return (appSim ??= createDevUpdatesBridge())
}

/** Controls of "Bảng phát triển → Cập nhật" (they act on devUpdatesBridge()). */
export const devUpdates = {
  simulate: (patch: Partial<UpdateState>) => devUpdatesBridge().simulate(patch),
  setNextCheck: (o: DevNextCheck) => devUpdatesBridge().setNextCheck(o),
  setDraft: (d: Partial<DevUpdatesDraft>) => devUpdatesBridge().setDraft(d),
  announce: () => devUpdatesBridge().announce(),
  runDownload: () => devUpdatesBridge().runDownload(),
  markReady: () => devUpdatesBridge().markReady(),
  failNetwork: () => devUpdatesBridge().failNetwork(),
  markNone: () => devUpdatesBridge().markNone(),
  reset: () => devUpdatesBridge().reset(),
}
