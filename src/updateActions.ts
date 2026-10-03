// Auto-update commands and effects (toasts, the install flow, "Cập nhật khi xong"). The state itself comes from
// lib/updates (main process updater, or development mode's simulation in a browser); texts from lib/updateModel.
//
//   startUpdates(): () => void      ref-counted, called once from App's Shell: connects lib/updates and starts the
//                                   effects — a toast when a download is ready ("Đã tải xong SanoVids X.", once per
//                                   version per page load) and the one-shot notice of this launch ("Đã cập nhật
//                                   SanoVids lên X.", once per page load). Automatic checks never toast. A download
//                                   refused for its signature toasts once per version (with "Trang tải về").
//   openUpdateDialog()              "Cập nhật SanoVids" (never replaces an open “Nhập prompt”: a toast asks to close it).
//   checkNow()                      "Kiểm tra ngay": check, then a toast with the result.
//   requestInstall('pill'|'toast')  the pill opens the dialog; the toast's "Khởi động lại" installs at once when nothing
//                                   is in progress, else opens the dialog (it lists what is not finished).
//   installNow()                    hold new submits → wait for sends in flight (≤ 15 s) → commit typed prompts → save
//                                   the project → ask main to quit and install. Every failure gives the hold back. Never
//                                   while “Nhập prompt” is open (its pasted text lives only in the dialog).
//   setInstallWhenIdle(on)          "Cập nhật khi xong": once the queue (takes of deleted scenes aside), pending downloads
//                                   and a top-up are all idle and “Nhập prompt” is closed, a cancellable 5 s countdown,
//                                   then installNow(). Not saved (quitting installs anyway).
//   useInstallUi                    { installWhenIdle, busy, manualCheck } for the dialog / pill / Settings.
//   createUpdateController(deps)    the same with injected dependencies (tests: src/__tests__/updateActions.test.ts).
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { flushAllPromptEditors } from './components/inspector/PromptEditor'
import { pendingDownloadCount } from './lib/downloads'
import { installBlockers, manualCheckToast, noticeToast, UPDATE_ERROR_TEXT, type InstallBusy } from './lib/updateModel'
import { updatesClient, type UpdatesClient } from './lib/updates'
import type { UpdateState } from './lib/updateTypes'
import { flush, useSave } from './store/persist'
import { activeCount, currentRestartWork, holdNewSubmits, sendingCount, useRuns } from './store/runs'
import { toast, useUI, type ToastAction, type Toast } from './store/ui'

export const SEND_POLL_MS = 250
export const SEND_WAIT_MS = 15_000
export const INSTALL_WATCHDOG_MS = 20_000
export const COUNTDOWN_MS = 5_000
export const IDLE_RECHECK_MS = 5_000

export interface InstallUiState {
  /** "Cập nhật khi xong" is armed. */
  installWhenIdle: boolean
  /** Step of installNow() in progress. */
  busy: InstallBusy
  /** A manual "Kiểm tra ngay" is running. */
  manualCheck: boolean
}

export type InstallSource = 'pill' | 'toast'

interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
}

export interface UpdateControllerDeps {
  client: Pick<UpdatesClient, 'store' | 'connect' | 'check' | 'install' | 'openReleasePage' | 'refresh'>
  /** Save the open project now (store/persist flush); called only when saveReady(). */
  flush: () => Promise<boolean>
  /** The project is loaded (before that there is nothing of the user's to save). */
  saveReady: () => boolean
  /** Commit what is being typed: blur the focused field, flush every prompt editor. */
  flushDrafts: () => void
  runs: {
    counts: () => { queued: number; processing: number }
    sendingCount: () => number
    /** Calls back when the number of active (queued + running) takes may have changed. */
    subscribeActive: (listener: () => void) => () => void
    holdNewSubmits: (on: boolean) => void
  }
  /** A canvasapp top-up order is being confirmed. */
  topupInFlight: () => Promise<boolean>
  /** Auto-downloads waiting for a folder permission. */
  pendingDownloads: () => number
  toast: (text: string, opts?: { tone?: Toast['tone']; ms?: number; action?: ToastAction }) => number
  dismissToast: (id: number) => void
  ui: { dialogKind: () => string; openDialog: () => void }
  timers?: Timers
  /** sessionStorage (dedupes the launch notice across reloads of the page). */
  session?: { get: (key: string) => string | null; set: (key: string, value: string) => void }
}

export interface UpdateController {
  start(): () => void
  openUpdateDialog(): void
  checkNow(): Promise<void>
  requestInstall(source: InstallSource): Promise<void>
  installNow(): Promise<void>
  setInstallWhenIdle(on: boolean): void
  /** Lines of "Đang có việc chưa xong:" right now. */
  blockers(): Promise<string[]>
  installUi: UseBoundStore<StoreApi<InstallUiState>>
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
}

const isInstallReady = (s: UpdateState) => s.kind === 'installer' && s.status === 'ready' && !!s.version
/** "Cập nhật khi xong" stays armed only while an update is on its way or ready. */
const KEEPS_WAIT = new Set<UpdateState['status']>(['ready', 'downloading', 'available'])

export const UPDATE_TOAST = {
  importOpen: 'Đóng “Nhập prompt” trước rồi bấm lại.',
  sendTimeout: 'Video vẫn đang được gửi đi — thử cập nhật lại sau ít phút.',
  saveFailed: 'Chưa lưu được dự án nên chưa cập nhật. Thử lại sau giây lát.',
  installFailed: 'Không khởi động được bản cập nhật. Bản mới sẽ tự cài khi bạn tắt SanoVids.',
  countdown: 'Video đã xong — SanoVids sẽ khởi động lại để cập nhật sau 5 giây.',
  ready: (v: string) => `Đã tải xong SanoVids ${v}.`,
  /** n = videos still running / queued; 0 when the wait is for something else (a top-up, downloads waiting for a folder). */
  waitSet: (n: number) => (n > 0 ? `Sẽ cập nhật khi xong ${n} video.` : 'Sẽ cập nhật khi xong các việc đang dở.'),
} as const

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const timers = deps.timers ?? defaultTimers
  const { client, runs } = deps
  const installUi = create<InstallUiState>()(() => ({ installWhenIdle: false, busy: null, manualCheck: false }))
  const ui = () => installUi.getState()
  const setBusy = (busy: InstallBusy) => installUi.setState({ busy })
  const current = () => client.store.getState().state

  // install
  let watchdog: unknown = null
  /** The state already carried an install error when this attempt started (a new one is then not "news"). */
  let hadInstallError = false
  // "Cập nhật khi xong"
  let offRuns: (() => void) | null = null
  let idleTimer: unknown = null
  let countdown: unknown = null
  let countdownToast: number | null = null
  let evalSeq = 0

  // ---------------- effects ----------------
  const readyToasted = new Set<string>()
  const signatureToasted = new Set<string>()
  const noticesShown = new Set<string>()
  let refs = 0
  let stopEffects: (() => void) | null = null

  function onState(state: UpdateState) {
    // Download finished: say so once per version (not while the dialog already shows it).
    if (isInstallReady(state) && state.version && !readyToasted.has(state.version)) {
      readyToasted.add(state.version)
      if (deps.ui.dialogKind() !== 'update' && !ui().busy) {
        deps.toast(UPDATE_TOAST.ready(state.version), { tone: 'success', ms: 10_000, action: { label: 'Khởi động lại', run: () => void requestInstall('toast') } })
      }
    }
    // A download (or the installer about to run) failed the signature check: main deleted it and installs nothing. Say
    // so once per version, also when it ends a restart (not while the dialog already shows it).
    if (state.status === 'error' && state.error?.code === 'signature') {
      const key = state.version ?? ''
      if (!signatureToasted.has(key)) {
        signatureToasted.add(key)
        if (deps.ui.dialogKind() !== 'update') {
          deps.toast(state.error.message || UPDATE_ERROR_TEXT.signature, {
            tone: 'error',
            ms: 15_000,
            action: { label: 'Trang tải về', run: () => void client.openReleasePage() },
          })
        }
      }
    }
    // News of this launch (updated / install failed): once per page load and per tab session.
    if (state.notice) {
      const key = `bdp:upd-notice:${state.kind}:${state.notice.version}`
      if (!noticesShown.has(key)) {
        noticesShown.add(key)
        let seen = false
        try {
          seen = deps.session?.get(key) === '1'
          deps.session?.set(key, '1')
        } catch {
          /* storage unavailable: shown once per page load */
        }
        if (!seen) {
          const t = noticeToast(state.notice)
          deps.toast(t.text, {
            tone: t.tone,
            ms: t.ms,
            action: t.action === 'openPage' ? { label: 'Trang tải về', run: () => void client.openReleasePage() } : undefined,
          })
        }
      }
    }
    // The update went away (checked again: up to date, error, unsupported): nothing to wait for.
    if (ui().installWhenIdle && !KEEPS_WAIT.has(state.status)) setInstallWhenIdle(false)
    // Restarting: main reported the install failed, or (development mode) the simulated restart already happened.
    if (ui().busy === 'restarting') {
      if (state.error?.code === 'install-failed' && !hadInstallError) failInstall()
      else if (state.status !== 'ready') endInstall()
    }
  }

  function start(): () => void {
    refs++
    if (refs === 1) {
      const disconnect = client.connect()
      const off = client.store.subscribe((s, prev) => {
        if (s.state !== prev.state) onState(s.state)
      })
      onState(current())
      stopEffects = () => {
        off()
        disconnect()
        stopIdleWatch()
        cancelCountdown()
      }
    }
    let done = false
    return () => {
      if (done) return
      done = true
      refs--
      if (refs === 0) {
        stopEffects?.()
        stopEffects = null
      }
    }
  }

  // ---------------- dialog / check ----------------
  /** “Nhập prompt” keeps its pasted prompts / files only in the dialog (no beforeunload on desktop): never restart over it. */
  const importOpen = () => deps.ui.dialogKind() === 'import'

  function openUpdateDialog() {
    if (importOpen()) {
      deps.toast(UPDATE_TOAST.importOpen, { tone: 'info' })
      return
    }
    deps.ui.openDialog()
  }

  async function checkNow(): Promise<void> {
    if (ui().manualCheck) return
    installUi.setState({ manualCheck: true })
    try {
      const res = await client.check()
      await client.refresh()
      const t = manualCheckToast(current(), res)
      if (!t) return
      const action: ToastAction | undefined =
        t.action === 'restart'
          ? { label: 'Khởi động lại', run: () => void requestInstall('toast') }
          : t.action === 'open'
            ? { label: 'Xem', run: openUpdateDialog }
            : undefined
      deps.toast(t.text, { tone: t.tone, action })
    } finally {
      installUi.setState({ manualCheck: false })
    }
  }

  async function topupBusy(): Promise<boolean> {
    try {
      return await deps.topupInFlight()
    } catch {
      return false
    }
  }

  async function blockers(): Promise<string[]> {
    const { queued, processing } = runs.counts()
    const topupInFlight = await topupBusy()
    return installBlockers({ queued, processing, sending: runs.sendingCount(), pendingDownloads: deps.pendingDownloads(), topupInFlight })
  }

  async function requestInstall(source: InstallSource): Promise<void> {
    if (source === 'pill' || !isInstallReady(current())) return openUpdateDialog()
    if ((await blockers()).length || importOpen()) return openUpdateDialog()
    await installNow()
  }

  // ---------------- install ----------------
  function clearWatchdog() {
    if (watchdog !== null) timers.clearTimeout(watchdog)
    watchdog = null
  }

  /** The install did not happen: give everything back and say so. */
  function failInstall() {
    clearWatchdog()
    runs.holdNewSubmits(false)
    setBusy(null)
    deps.toast(UPDATE_TOAST.installFailed, { tone: 'error' })
  }

  /** The (simulated) restart happened: give everything back, nothing to say. */
  function endInstall() {
    clearWatchdog()
    runs.holdNewSubmits(false)
    setBusy(null)
  }

  /** Wait until no take is being sent (polled every 250 ms, at most 15 s). */
  function waitForSends(): Promise<boolean> {
    return new Promise((resolve) => {
      if (runs.sendingCount() === 0) return resolve(true)
      let waited = 0
      const id = timers.setInterval(() => {
        waited += SEND_POLL_MS
        if (runs.sendingCount() === 0) {
          timers.clearInterval(id)
          resolve(true)
        } else if (waited >= SEND_WAIT_MS) {
          timers.clearInterval(id)
          resolve(false)
        }
      }, SEND_POLL_MS)
    })
  }

  const macrotask = () => new Promise<void>((resolve) => void timers.setTimeout(resolve, 0))

  async function installNow(): Promise<void> {
    if (!isInstallReady(current()) || ui().busy) return
    if (importOpen()) {
      deps.toast(UPDATE_TOAST.importOpen, { tone: 'info' })
      return
    }
    setBusy('waiting-send')
    runs.holdNewSubmits(true)
    if (!(await waitForSends())) {
      runs.holdNewSubmits(false)
      setBusy(null)
      deps.toast(UPDATE_TOAST.sendTimeout, { tone: 'warning' })
      return
    }
    setBusy('saving')
    try {
      deps.flushDrafts()
    } catch {
      /* nothing being typed */
    }
    // Let the committed text reach the stores (and their autosave scheduling) before saving.
    await macrotask()
    let saved: boolean
    try {
      saved = deps.saveReady() ? await deps.flush() : true
    } catch {
      saved = false
    }
    if (!saved) {
      runs.holdNewSubmits(false)
      setBusy(null)
      deps.toast(UPDATE_TOAST.saveFailed, { tone: 'error', action: { label: 'Vẫn cập nhật', run: () => void restart() } })
      return
    }
    await restart()
  }

  /** The last step: main quits, installs silently and relaunches. */
  async function restart(): Promise<void> {
    if (!isInstallReady(current()) || ui().busy === 'restarting') return
    if (importOpen()) {
      // Opened while installNow() was saving: give everything back.
      if (ui().busy) {
        runs.holdNewSubmits(false)
        setBusy(null)
      }
      deps.toast(UPDATE_TOAST.importOpen, { tone: 'info' })
      return
    }
    setBusy('restarting')
    runs.holdNewSubmits(true)
    hadInstallError = current().error?.code === 'install-failed'
    let res: { ok: boolean; code?: string }
    try {
      res = await client.install()
    } catch {
      res = { ok: false }
    }
    if (ui().busy !== 'restarting') return // ended meanwhile by a pushed state
    if (!res.ok) {
      // Refused for its signature: the pushed error state says why (toast above), "install on quit" is off too.
      if (res.code === 'signature') endInstall()
      else failInstall()
      return
    }
    // Still alive long after main said it would quit: the installer did not start.
    clearWatchdog()
    watchdog = timers.setTimeout(() => {
      watchdog = null
      if (ui().busy === 'restarting') failInstall()
    }, INSTALL_WATCHDOG_MS)
  }

  // ---------------- "Cập nhật khi xong" ----------------
  function startIdleWatch() {
    if (!offRuns) offRuns = runs.subscribeActive(() => void evaluateIdle())
    if (idleTimer === null) idleTimer = timers.setInterval(() => void evaluateIdle(), IDLE_RECHECK_MS)
  }

  function stopIdleWatch() {
    offRuns?.()
    offRuns = null
    if (idleTimer !== null) timers.clearInterval(idleTimer)
    idleTimer = null
  }

  function cancelCountdown() {
    if (countdown !== null) timers.clearTimeout(countdown)
    countdown = null
    if (countdownToast !== null) deps.dismissToast(countdownToast)
    countdownToast = null
  }

  /** Nothing a restart would interrupt. An open “Nhập prompt” counts as busy: the wait goes on until it is closed. */
  async function isIdle(): Promise<boolean> {
    const { queued, processing } = runs.counts()
    if (queued + processing > 0 || deps.pendingDownloads() > 0 || importOpen()) return false
    return !(await topupBusy()) && !importOpen()
  }

  async function evaluateIdle(): Promise<void> {
    if (!ui().installWhenIdle) return
    const seq = ++evalSeq
    const idle = await isIdle()
    if (seq !== evalSeq || !ui().installWhenIdle) return
    if (!idle) {
      cancelCountdown()
      return
    }
    if (countdown !== null) return
    countdownToast = deps.toast(UPDATE_TOAST.countdown, { tone: 'info', ms: 6000, action: { label: 'Huỷ', run: () => setInstallWhenIdle(false) } })
    countdown = timers.setTimeout(() => {
      countdown = null
      void (async () => {
        if (!ui().installWhenIdle) return
        if (!(await isIdle())) {
          cancelCountdown()
          return // the wait goes on; the next change starts a new countdown
        }
        if (!ui().installWhenIdle) return
        installUi.setState({ installWhenIdle: false })
        stopIdleWatch()
        if (countdownToast !== null) deps.dismissToast(countdownToast)
        countdownToast = null
        await installNow()
      })()
    }, COUNTDOWN_MS)
  }

  function setInstallWhenIdle(on: boolean) {
    if (on) {
      if (ui().installWhenIdle || !isInstallReady(current())) return
      installUi.setState({ installWhenIdle: true })
      const { queued, processing } = runs.counts()
      deps.toast(UPDATE_TOAST.waitSet(queued + processing), { tone: 'info' })
      startIdleWatch()
      void evaluateIdle()
      return
    }
    if (!ui().installWhenIdle) return
    installUi.setState({ installWhenIdle: false })
    stopIdleWatch()
    cancelCountdown()
  }

  return { start, openUpdateDialog, checkNow, requestInstall, installNow, setInstallWhenIdle, blockers, installUi }
}

// ---------------------------------------------------------------------------------------------
// The app's controller
// ---------------------------------------------------------------------------------------------

/** Running / queued takes a restart would interrupt (queued takes of deleted scenes never start: not counted). */
function runCounts(): { queued: number; processing: number } {
  const { queued, processing } = currentRestartWork()
  return { queued, processing }
}

const sessionStore = {
  get: (key: string) => {
    try {
      return sessionStorage.getItem(key)
    } catch {
      return null
    }
  },
  set: (key: string, value: string) => {
    try {
      sessionStorage.setItem(key, value)
    } catch {
      /* storage unavailable */
    }
  },
}

const controller = createUpdateController({
  client: updatesClient,
  flush,
  saveReady: () => useSave.getState().ready,
  flushDrafts: () => {
    if (typeof document !== 'undefined') (document.activeElement as HTMLElement | null)?.blur?.()
    flushAllPromptEditors()
  },
  runs: {
    counts: runCounts,
    sendingCount,
    subscribeActive: (listener) =>
      useRuns.subscribe((s, prev) => {
        if (s.takes !== prev.takes && activeCount(s) !== activeCount(prev)) listener()
      }),
    holdNewSubmits,
  },
  // Lazy on purpose: the top-up flow (and its sheet) stays out of the main bundle.
  topupInFlight: async () => (await import('./components/topup/appFlow')).topupFlow.inFlight(),
  pendingDownloads: pendingDownloadCount,
  toast: (text, opts) => toast(text, opts),
  dismissToast: (id) => useUI.getState().dismissToast(id),
  ui: {
    dialogKind: () => useUI.getState().dialog.kind,
    openDialog: () => useUI.getState().openDialog({ kind: 'update' }),
  },
  session: sessionStore,
})

export const startUpdates = controller.start
export const openUpdateDialog = controller.openUpdateDialog
export const checkNow = controller.checkNow
export const requestInstall = controller.requestInstall
export const installNow = controller.installNow
export const setInstallWhenIdle = controller.setInstallWhenIdle
export const installBlockersNow = controller.blockers
/** { installWhenIdle, busy, manualCheck } (select one field). */
export const useInstallUi = controller.installUi
