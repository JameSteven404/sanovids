// SanoVids — desktop auto-updater (main process). Wraps electron-updater (NsisUpdater on Windows).
//
// The feed is ONLY resources/app-update.yml, which electron-builder generates from package.json build.publish (GitHub,
// public repo JameSteven404/sanovids-releases, no token). Nothing here sets a feed URL, a channel, auth headers or the
// dev update config. The renderer can only ask, through the guarded IPC below, to check / download / install / open the
// fixed release page; it never sends a URL, a path, a version or a feed. Pure rules: electron/updater-rules.cjs.
//
//   kind 'installer'  NSIS install: checks at startup (+15 s) and every 4 h, downloads (auto or on request), installs
//                     on "Khởi động lại để cập nhật" (quitAndInstall) or silently when the app quits;
//   kind 'portable'   portable .exe / win-unpacked: check only (the renderer offers the download page);
//   kind 'dev'        `electron .`: electron-updater is never loaded.
//
// Never a dialog or a notification from here: every status reaches the page as an 'updates:state' push, and the page
// decides what to show (automatic checks stay silent). Files: userData/updater.json (prefs + install attempt),
// userData/logs/updater.log (+ updater.1.log).
//
// Signed updates only: every downloaded installer must carry an Authenticode signature by one of the certificates
// pinned in package.json `sanovids.signers` (electron/signature.cjs; decision table in updater-rules judgeSignature).
// Our verifier replaces BOTH electron-updater hooks — `verifyUpdateCodeSignature` and an instance override of
// `verifySignature` (which would otherwise skip the check whenever app-update.yml has no publisherName) — and the file is
// verified again on 'update-downloaded' (a cached installer skips the download hook), before every install, and (by
// size + mtime, synchronously) in the app 'quit' event before the silent install on quit. A rejected file is deleted and
// its version is not downloaded automatically again in this launch.
'use strict'

const { app, ipcMain, powerMonitor, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const rules = require('./updater-rules.cjs')
const signature = require('./signature.cjs')

/** Pushes go only to the SanoVids page itself (never to the canvasapp login / checkout windows). */
const APP_URL_PREFIX = 'app://bdp/'
const FIRST_CHECK_DELAY_MS = 15_000
const SCHEDULE_TICK_MS = 10 * 60_000
const PROGRESS_PUSH_MS = 500
const OPEN_PAGE_THROTTLE_MS = 3000
const LOG_MAX_BYTES = 256 * 1024
/**
 * Still alive this long after quitAndInstall (a quit vetoed by another window AND an installer that did not start or
 * could not close the app): the install is reported failed and the updater is usable again. A bit shorter than the
 * page's own watchdog (updateActions INSTALL_WATCHDOG_MS = 20 s), so the page hears it from main first.
 */
const INSTALL_WATCHDOG_MS = 18_000

const MSG = {
  notAllowed: 'Nguồn gọi không hợp lệ.',
  failed: 'Trình cập nhật gặp lỗi.',
  unsupported: 'Bản này không tự cập nhật.',
  busy: 'Đang kiểm tra hoặc đang tải bản cập nhật.',
  downloadUnsupported: 'Chỉ bản cài mới tự tải được bản cập nhật.',
  downloadNotReady: 'Chưa có bản cập nhật để tải.',
  installUnsupported: 'Bản này không tự cài được.',
  installNotReady: 'Bản cập nhật chưa tải xong.',
  badRequest: 'Giá trị không hợp lệ.',
  loadFailed: 'Trình cập nhật không chạy được trong bản này.',
  pageJustOpened: 'Trang tải về vừa được mở.',
}

const fail = (code, message) => ({ ok: false, code, message })
const OK = Object.freeze({ ok: true })

/** userData/logs/updater.log — one line per entry, rotated to updater.1.log past 256 KB. Never throws. */
function createLogger(dir) {
  const file = path.join(dir, 'updater.log')
  const previous = path.join(dir, 'updater.1.log')
  let dirReady = false
  const text = (m) => (m instanceof Error ? m.stack || m.message : typeof m === 'string' ? m : safeString(m))
  const write = (level, message) => {
    try {
      if (!dirReady) {
        fs.mkdirSync(dir, { recursive: true })
        dirReady = true
      }
      try {
        if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, previous)
      } catch {
        /* no log yet */
      }
      fs.appendFileSync(file, rules.logLine(level, text(message), new Date()) + '\n', 'utf8')
    } catch {
      /* logging never breaks the app */
    }
  }
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    debug: (m) => write('debug', m),
  }
}

function safeString(v) {
  try {
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  } catch {
    return String(v)
  }
}

/** Raw error for the log only (message + stack); it never goes into the state or an IPC reply. */
function rawError(e) {
  if (e instanceof Error) return `${e.code ? `[${e.code}] ` : ''}${e.stack || e.message}`
  return safeString(e)
}

/**
 * Called once, in the primary instance, inside app.whenReady(), BEFORE the main window exists.
 * → { onWindowReady(), onQuit(exitCode), isQuittingForUpdate() }
 */
function setupUpdater({ isAppSender, getMainWindow, profileSource }) {
  const userData = app.getPath('userData')
  const log = createLogger(path.join(userData, 'logs'))
  const current = app.getVersion()

  // 1. Which build is this?
  const kind = rules.detectKind({
    platform: process.platform,
    isPackaged: app.isPackaged,
    portableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    execPath: process.execPath,
    appName: app.getName(),
    exists: fs.existsSync,
    pathMod: path,
  })

  // 2. Prefs + the install attempt recorded before the last quit → this launch's notice. The attempt is then cleared,
  // unless this launch came while the install on quit may still be running (the next launch decides).
  const filePath = path.join(userData, 'updater.json')
  let file = readUpdaterFile()
  const startup = rules.startupAttempt(file, current, Date.now())
  const notice = startup.notice
  if (file.attempt && !startup.keep) {
    file = { autoDownload: file.autoDownload }
    writeUpdaterFile()
  }

  // 3. E2E tests look for this exact prefix: "start <version> kind=".
  log.info(`start ${current} kind=${kind} profile=${profileSource} packaged=${app.isPackaged}`)
  if (notice) log.info(`notice ${notice.kind} ${notice.kind === 'updated' ? `${notice.from} -> ${notice.version}` : notice.version}`)
  if (startup.keep) log.info(`attempt kept ${file.attempt.version}: started while the install on quit may still be running`)

  let state = rules.initialState({ kind, current, autoDownload: file.autoDownload, notice })
  /** electron-updater's autoUpdater, or null ('dev' kind, or it could not be loaded). */
  let au = null
  let checkInFlight = false
  let downloadInFlight = false
  let quittingForUpdate = false
  let installingNow = false
  let lastAttemptAt = undefined
  let lastErrorCode = null
  let lastOpenPageAt = 0
  let lastSentKey = ''
  let lastPushAt = 0
  let trailingPush = null
  let firstCheckTimer = null
  let scheduleTimer = null
  let installWatchdog = null
  /** Both electron-updater signature hooks are ours and a signer is pinned; false → downloads are refused. */
  let verifierOk = false
  /** The installer that passed the signature check: { file, size, mtimeMs, version } (null = none). */
  let verified = null
  /** Versions whose download failed the signature check in this launch: never downloaded automatically again. */
  const rejected = new Set()
  /** The running pre-install verification (a second "install" waits for the same one). */
  let installCheck = null

  // 4. The pinned signer thumbprints (app.asar/package.json `sanovids.signers`).
  const pins = signature.readSignerPins()
  if (!pins.length) log.error('no signer pins in package.json: downloads refused')

  /** electron-updater verifier contract: null = accepted, a string = the reason it was refused. Never throws. */
  const verifyPinned = async (file) => {
    try {
      const v = await signature.checkFileSignature(file, { pins, log: (l) => log.info(l) })
      return v && v.ok === true ? null : `sanovids-signature:${(v && v.reason) || 'verify-failed'}`
    } catch (e) {
      log.error(`signature check threw: ${rawError(e)}`)
      return 'sanovids-signature:verify-failed'
    }
  }

  function readUpdaterFile() {
    try {
      return rules.parseUpdaterFile(fs.readFileSync(filePath, 'utf8'))
    } catch {
      return rules.parseUpdaterFile(null)
    }
  }

  /** Atomic write (tmp + rename), synchronous: also used from the app 'quit' event. */
  function writeUpdaterFile() {
    const data = { v: 1, autoDownload: file.autoDownload, ...(file.attempt ? { attempt: file.attempt } : {}) }
    const tmp = `${filePath}.tmp`
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      fs.renameSync(tmp, filePath)
    } catch (e) {
      log.warn(`could not write updater.json: ${rawError(e)}`)
    }
  }

  function recordAttempt() {
    file = { ...file, attempt: { version: state.version, from: current, at: Date.now() } }
    writeUpdaterFile()
  }

  function clearAttempt() {
    if (!file.attempt) return
    file = { autoDownload: file.autoDownload }
    writeUpdaterFile()
  }

  // ---- state + pushes ----

  function sendNow() {
    if (trailingPush) clearTimeout(trailingPush)
    trailingPush = null
    let win = null
    try {
      win = getMainWindow()
    } catch {
      win = null
    }
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc || wc.isDestroyed() || !String(wc.getURL()).startsWith(APP_URL_PREFIX)) return
    const key = JSON.stringify(state)
    if (key === lastSentKey) return
    lastSentKey = key
    lastPushAt = Date.now()
    wc.send('updates:state', { ...state })
  }

  /** Every change is pushed; download progress at most every 500 ms (the first and the last always go out). */
  function push(prev, isProgress) {
    if (!isProgress || prev.status !== 'downloading') return sendNow()
    const wait = lastPushAt + PROGRESS_PUSH_MS - Date.now()
    if (wait <= 0) return sendNow()
    if (!trailingPush) trailingPush = setTimeout(sendNow, wait)
  }

  function dispatch(event) {
    const prev = state
    const next = rules.reduceUpdateState(prev, event, Date.now())
    if (next === prev) return
    state = next
    if (next.status !== prev.status || next.version !== prev.version) log.info(`state ${next.status}${next.version ? ` ${next.version}` : ''}`)
    // A newer version was found: the installer downloads it at once when the device pref says so — unless that version
    // already failed the signature check in this launch: then it stays refused (no download; "Thử lại" retries by hand).
    if (event.type === 'available' && prev.status !== 'available' && next.status === 'available' && kind === 'installer') {
      if (rejected.has(next.version)) {
        log.info(`auto-download skipped ${next.version}: its signature was rejected in this launch`)
        dispatch(signatureError())
      } else if (next.autoDownload) {
        startDownload()
      }
    }
    push(prev, event.type === 'progress')
  }

  function signatureError() {
    return { type: 'download-error', error: { code: 'signature', message: rules.ERROR_TEXT.signature } }
  }

  // ---- electron-updater ----

  function loadUpdater() {
    try {
      const updater = require('electron-updater').autoUpdater
      updater.logger = log
      updater.autoDownload = false // downloads are always started explicitly (startDownload)
      updater.autoInstallOnAppQuit = kind === 'installer'
      updater.allowDowngrade = false
      updater.allowPrerelease = false
      updater.fullChangelog = false
      updater.disableWebInstaller = true
      updater.disableDifferentialDownload = false
      // Never: updater.channel (it turns allowDowngrade on), setFeedURL, addAuthHeader, requestHeaders, forceDevUpdateConfig.
      // Our pinned verifier on both hooks: the setter (used by electron-updater's default verifySignature) and an
      // instance override of NsisUpdater.verifySignature, the method doDownloadUpdate actually awaits — electron-updater's
      // own one returns "OK" without checking anything when app-update.yml lacks publisherName.
      const verifyHook = (_publisherNames, file) => verifyPinned(file)
      const verifyMethod = (file) => verifyPinned(file)
      updater.verifyUpdateCodeSignature = verifyHook
      updater.verifySignature = verifyMethod
      if (updater.verifyUpdateCodeSignature !== verifyHook) log.error('signature hook verifyUpdateCodeSignature not installed: downloads refused')
      else if (updater.verifySignature !== verifyMethod) log.error('signature override verifySignature not installed: downloads refused')
      else if (!pins.length) log.error('signature verifier has no pinned signer: downloads refused')
      else verifierOk = true
      updater.on('checking-for-update', () => dispatch({ type: 'checking' }))
      updater.on('update-not-available', () => dispatch({ type: 'not-available' }))
      updater.on('update-available', (info) => {
        const n = rules.normalizeInfo(info)
        if (!n) return log.warn(`ignored update-available: invalid version ${safeString(info && info.version).slice(0, 80)}`)
        dispatch({ type: 'available', info: n })
      })
      updater.on('download-progress', (p) => dispatch({ type: 'progress', p }))
      // Never 'downloaded' straight away: a cached installer (validateDownloadedPath) never went through verifySignature.
      updater.on('update-downloaded', (info) => void onDownloaded(info))
      updater.on('update-cancelled', () => dispatch({ type: 'cancelled' }))
      // Errors are mapped where the phase is known (the promise catches). This listener logs, and catches the
      // synchronous error of a quitAndInstall that could not start the installer.
      updater.on('error', (e) => {
        log.error(`updater error: ${rawError(e)}`)
        if (installingNow && quittingForUpdate) installFailed(e)
      })
      return updater
    } catch (e) {
      log.error(`electron-updater could not be loaded: ${rawError(e)}`)
      state = { ...state, status: 'unsupported', error: { code: 'failed', message: MSG.loadFailed } }
      return null
    }
  }

  function startDownload() {
    if (!au || downloadInFlight || kind !== 'installer') return
    const version = state.version
    if (!verifierOk) {
      log.error(`download ${version || '?'} refused: the signature verifier is not active`)
      dispatch(signatureError())
      return
    }
    downloadInFlight = true
    log.info(`download ${version || '?'}`)
    au.downloadUpdate()
      .catch((e) => {
        log.error(`download failed: ${rawError(e)}`)
        if (e && e.constructor && e.constructor.name === 'CancellationError') return
        const error = rules.mapUpdaterError(e, 'download')
        // electron-updater already deleted the file our verifier refused (ERR_UPDATER_INVALID_SIGNATURE).
        if (error.code === 'signature' && version) rejected.add(version)
        dispatch({ type: 'download-error', error })
      })
      .finally(() => {
        downloadInFlight = false
      })
  }

  /**
   * Verifies the downloaded installer against the pinned signers. OK → remembered in `verified` (path, size, mtime).
   * Refused → the file is deleted, its version rejected for this launch, install on quit turned off and the state
   * becomes error 'signature'. Never throws.
   */
  async function verifyDownloaded(file, version) {
    let reason = 'sanovids-signature:no-file'
    try {
      if (typeof file === 'string' && file !== '') {
        const before = fs.statSync(file)
        reason = await verifyPinned(file)
        if (reason === null) {
          const after = fs.statSync(file)
          // The file must not have changed while PowerShell was reading it.
          if (after.size === before.size && after.mtimeMs === before.mtimeMs) {
            verified = { file, size: after.size, mtimeMs: after.mtimeMs, version: version || '' }
            log.info(`signature verified ${version || '?'} ${path.basename(file)}`)
            return true
          }
          reason = 'sanovids-signature:changed-while-verified'
        }
      }
    } catch (e) {
      log.error(`signature verification failed: ${rawError(e)}`)
      reason = 'sanovids-signature:verify-failed'
    }
    verified = null
    if (au) au.autoInstallOnAppQuit = false
    if (typeof file === 'string' && file !== '') {
      try {
        fs.rmSync(file, { force: true })
      } catch (e) {
        log.warn(`could not delete the refused installer: ${rawError(e)}`)
      }
    }
    if (version) rejected.add(version)
    log.error(`signature rejected ${version || '?'} (${reason}): installer deleted, not installed`)
    dispatch(signatureError())
    return false
  }

  /** 'update-downloaded' → verify first; only a verified installer becomes 'ready' (and may install on quit). */
  async function onDownloaded(info) {
    const n = rules.normalizeInfo(info)
    const version = (n && n.version) || state.version || ''
    const file = info && typeof info.downloadedFile === 'string' && info.downloadedFile ? info.downloadedFile : au && au.installerPath
    if (!(await verifyDownloaded(file, version))) return
    // BaseUpdater registered its quit handler synchronously after this event and reads the flag again at quit time.
    if (au) au.autoInstallOnAppQuit = kind === 'installer'
    dispatch({ type: 'downloaded', info: n })
  }

  /** One check (manual or automatic). Resolves with the IPC result; never rejects. */
  async function runCheck(source) {
    checkInFlight = true
    lastAttemptAt = Date.now()
    log.info(`check ${source}`)
    try {
      const res = await au.checkForUpdates()
      if (res == null) return fail('unsupported', MSG.unsupported) // updater inactive (not packaged)
      lastErrorCode = null
      return OK
    } catch (e) {
      log.error(`check failed: ${rawError(e)}`)
      const error = rules.mapUpdaterError(e, 'check')
      lastErrorCode = error.code
      dispatch({ type: 'check-error', error })
      return fail(error.code, error.message)
    } finally {
      checkInFlight = false
    }
  }

  function installFailed(e) {
    log.error(`install failed: ${rawError(e)}`)
    clearInstallWatchdog()
    quittingForUpdate = false
    clearAttempt()
    dispatch({ type: 'install-error', error: rules.mapUpdaterError(e, 'install') })
  }

  function clearInstallWatchdog() {
    if (installWatchdog) clearTimeout(installWatchdog)
    installWatchdog = null
  }

  /** After quitAndInstall: the app should be gone within a second or two (see INSTALL_WATCHDOG_MS). */
  function armInstallWatchdog() {
    clearInstallWatchdog()
    installWatchdog = setTimeout(() => {
      installWatchdog = null
      if (!quittingForUpdate) return
      // electron-updater (6.8.x, pinned) keeps `quitAndInstallCalled` set after a quitAndInstall whose app never quit:
      // every later install — "Khởi động lại để cập nhật" again, or the silent install on quit — would then be skipped.
      // A second installer started by mistake would only stop at the NSIS single-instance check.
      if (au && au.quitAndInstallCalled === true) au.quitAndInstallCalled = false
      installFailed(new Error(`the app was still running ${INSTALL_WATCHDOG_MS / 1000} s after quitAndInstall`))
    }, INSTALL_WATCHDOG_MS)
    if (typeof installWatchdog.unref === 'function') installWatchdog.unref()
  }

  // ---- schedule ----

  const canAutoCheck = () => kind !== 'dev' && !!au && state.status !== 'unsupported'

  function maybeAutoCheck() {
    if (!canAutoCheck() || checkInFlight || quittingForUpdate) return
    if (!rules.checkDue({ status: state.status, lastAttemptAt, lastErrorCode, now: Date.now() })) return
    void runCheck('auto')
  }

  function stopSchedule() {
    if (firstCheckTimer) clearTimeout(firstCheckTimer)
    if (scheduleTimer) clearInterval(scheduleTimer)
    if (trailingPush) clearTimeout(trailingPush)
    firstCheckTimer = scheduleTimer = trailingPush = null
    clearInstallWatchdog()
    powerMonitor.removeListener('resume', maybeAutoCheck)
  }

  // ---- IPC ----

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, arg) => {
      if (!isAppSender(event)) return fail('not-allowed', MSG.notAllowed)
      try {
        return await fn(arg)
      } catch (e) {
        log.error(`${channel} failed: ${rawError(e)}`)
        return fail('failed', MSG.failed)
      }
    })

  handle('updates:getState', () => ({ ...state }))

  handle('updates:check', () => {
    if (kind === 'dev' || !au) return fail('unsupported', MSG.unsupported)
    if (state.status === 'downloading' || checkInFlight) return fail('busy', MSG.busy)
    return runCheck('manual')
  })

  handle('updates:download', () => {
    if (kind !== 'installer' || !au) return fail('unsupported', MSG.downloadUnsupported)
    if (!(state.status === 'available' || (state.status === 'error' && state.version))) return fail('not-ready', MSG.downloadNotReady)
    if (!verifierOk) {
      startDownload() // refuses, and shows the signature error
      return fail('signature', rules.ERROR_TEXT.signature)
    }
    // A version rejected earlier may be retried by hand (it is verified again like any download).
    const started = !downloadInFlight
    startDownload()
    // electron-updater's first progress event comes only after the blockmaps (1-3 s): show "downloading 0%" at once so
    // the dialog does not keep offering "Tải bản cập nhật" in between.
    if (started && downloadInFlight) dispatch({ type: 'progress', p: { percent: 0, transferred: 0, ...(state.size ? { total: state.size } : {}) } })
    return OK
  })

  handle('updates:install', async () => {
    if (kind !== 'installer' || !au) return fail('unsupported', MSG.installUnsupported)
    if (state.status !== 'ready') return fail('not-ready', MSG.installNotReady)
    if (quittingForUpdate) return OK
    // Always verified again right before it runs (a refusal deletes it and the state is already error 'signature').
    if (!installCheck) {
      installCheck = verifyDownloaded(au.installerPath, state.version).finally(() => {
        installCheck = null
      })
    }
    if (!(await installCheck)) return fail('signature', rules.ERROR_TEXT.signature)
    if (quittingForUpdate) return OK
    if (state.status !== 'ready') return fail('not-ready', MSG.installNotReady)
    recordAttempt()
    quittingForUpdate = true
    log.info(`install quitAndInstall ${state.version}`)
    setImmediate(() => {
      installingNow = true
      try {
        au.quitAndInstall(true, true) // silent install, then relaunch
      } catch (e) {
        if (quittingForUpdate) installFailed(e)
      } finally {
        installingNow = false
      }
      if (quittingForUpdate) armInstallWatchdog()
    })
    return OK
  })

  handle('updates:setPrefs', (arg) => {
    const prefs = rules.parsePrefsArg(arg)
    if (!prefs) return fail('bad-request', MSG.badRequest)
    if (file.autoDownload !== prefs.autoDownload) {
      file = { ...file, autoDownload: prefs.autoDownload }
      writeUpdaterFile()
    }
    dispatch({ type: 'prefs', autoDownload: prefs.autoDownload })
    // Turning it on downloads an update that was only announced; turning it off never cancels a running download.
    if (prefs.autoDownload && kind === 'installer' && state.status === 'available') startDownload()
    return OK
  })

  handle('updates:openReleasePage', async () => {
    const now = Date.now()
    if (now - lastOpenPageAt < OPEN_PAGE_THROTTLE_MS) return fail('busy', MSG.pageJustOpened)
    lastOpenPageAt = now
    await shell.openExternal(rules.RELEASES_URL)
    return OK
  })

  // ---- start ----

  if (kind !== 'dev') au = loadUpdater()
  app.once('will-quit', stopSchedule)

  return {
    /** From the main window's ready-to-show: first check 15 s later, then a due-check every 10 minutes and on resume. */
    onWindowReady() {
      if (!canAutoCheck() || firstCheckTimer || scheduleTimer) return
      firstCheckTimer = setTimeout(() => {
        firstCheckTimer = null
        maybeAutoCheck()
      }, FIRST_CHECK_DELAY_MS)
      scheduleTimer = setInterval(maybeAutoCheck, SCHEDULE_TICK_MS)
      powerMonitor.on('resume', maybeAutoCheck)
    },
    /**
     * app 'quit' (after every window agreed to close, so never for a quit that was vetoed): electron-updater installs a
     * downloaded update in this same event, and only with exit code 0 → remember the attempt under the same condition.
     */
    onQuit(exitCode) {
      if (kind !== 'installer' || !au || quittingForUpdate) return
      // Synchronous only (electron-updater's own quit handler runs right after this one, in the same event): the
      // installer must still be the very file that passed the signature check, else nothing installs on quit. This also
      // covers a quit while a cached installer is still being verified.
      let stat = null
      try {
        stat = au.installerPath ? fs.statSync(au.installerPath) : null
      } catch {
        stat = null
      }
      const installsNow = state.status === 'ready' && exitCode === 0
      if (!rules.sameVerifiedFile(verified, stat, au.installerPath)) {
        au.autoInstallOnAppQuit = false
        if (installsNow || stat) log.warn('install on quit skipped: installer not verified')
        return
      }
      if (installsNow) {
        recordAttempt()
        log.info(`install on quit ${state.version}`)
      }
    },
    /** True between updates:install and the quit: main.cjs then ignores beforeunload vetoes (will-prevent-unload). */
    isQuittingForUpdate() {
      return quittingForUpdate
    },
  }
}

module.exports = { setupUpdater }
