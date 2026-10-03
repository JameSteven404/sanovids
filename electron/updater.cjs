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
'use strict'

const { app, ipcMain, powerMonitor, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const rules = require('./updater-rules.cjs')

/** Pushes go only to the SanoVids page itself (never to the canvasapp login / checkout windows). */
const APP_URL_PREFIX = 'app://bdp/'
const FIRST_CHECK_DELAY_MS = 15_000
const SCHEDULE_TICK_MS = 10 * 60_000
const PROGRESS_PUSH_MS = 500
const OPEN_PAGE_THROTTLE_MS = 3000
const LOG_MAX_BYTES = 256 * 1024

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
 * → { onWindowReady(), onBeforeQuit(), isQuittingForUpdate() }
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

  // 2. Prefs + the install attempt recorded before the last quit → this launch's notice (the attempt is then cleared).
  const filePath = path.join(userData, 'updater.json')
  let file = readUpdaterFile()
  const notice = rules.startupNotice(file, current, Date.now())
  if (file.attempt) {
    file = { autoDownload: file.autoDownload }
    writeUpdaterFile()
  }

  // 3. E2E tests look for this exact prefix: "start <version> kind=".
  log.info(`start ${current} kind=${kind} profile=${profileSource} packaged=${app.isPackaged}`)
  if (notice) log.info(`notice ${notice.kind} ${notice.kind === 'updated' ? `${notice.from} -> ${notice.version}` : notice.version}`)

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

  function readUpdaterFile() {
    try {
      return rules.parseUpdaterFile(fs.readFileSync(filePath, 'utf8'))
    } catch {
      return rules.parseUpdaterFile(null)
    }
  }

  /** Atomic write (tmp + rename), synchronous: also used from before-quit. */
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
    // A newer version was found: the installer downloads it at once when the device pref says so.
    if (event.type === 'available' && prev.status !== 'available' && next.status === 'available' && kind === 'installer' && next.autoDownload) {
      startDownload()
    }
    push(prev, event.type === 'progress')
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
      updater.on('checking-for-update', () => dispatch({ type: 'checking' }))
      updater.on('update-not-available', () => dispatch({ type: 'not-available' }))
      updater.on('update-available', (info) => {
        const n = rules.normalizeInfo(info)
        if (!n) return log.warn(`ignored update-available: invalid version ${safeString(info && info.version).slice(0, 80)}`)
        dispatch({ type: 'available', info: n })
      })
      updater.on('download-progress', (p) => dispatch({ type: 'progress', p }))
      updater.on('update-downloaded', (info) => dispatch({ type: 'downloaded', info: rules.normalizeInfo(info) }))
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
    downloadInFlight = true
    log.info(`download ${state.version || '?'}`)
    au.downloadUpdate()
      .catch((e) => {
        log.error(`download failed: ${rawError(e)}`)
        if (e && e.constructor && e.constructor.name === 'CancellationError') return
        dispatch({ type: 'download-error', error: rules.mapUpdaterError(e, 'download') })
      })
      .finally(() => {
        downloadInFlight = false
      })
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
    quittingForUpdate = false
    clearAttempt()
    dispatch({ type: 'install-error', error: rules.mapUpdaterError(e, 'install') })
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
    const started = !downloadInFlight
    startDownload()
    // electron-updater's first progress event comes only after the blockmaps (1-3 s): show "downloading 0%" at once so
    // the dialog does not keep offering "Tải bản cập nhật" in between.
    if (started && downloadInFlight) dispatch({ type: 'progress', p: { percent: 0, transferred: 0, ...(state.size ? { total: state.size } : {}) } })
    return OK
  })

  handle('updates:install', () => {
    if (kind !== 'installer' || !au) return fail('unsupported', MSG.installUnsupported)
    if (state.status !== 'ready') return fail('not-ready', MSG.installNotReady)
    if (quittingForUpdate) return OK
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
    /** app 'before-quit': a downloaded update installs on quit (electron-updater, exit code 0 only) → remember it. */
    onBeforeQuit() {
      if (kind === 'installer' && au && state.status === 'ready' && !quittingForUpdate) {
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
