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
// pinned in package.json `sanovids.signers` (electron/signature.cjs; decision table in updater-rules judgeSignature),
// AND be the offered update itself: its signed VersionInfo names this app and the offered version, newer than the
// running one (no rollback to an older genuine release, no other signed file of the author run as "the installer").
// Our verifier replaces BOTH electron-updater hooks — `verifyUpdateCodeSignature` and an instance override of
// `verifySignature` (which would otherwise skip the check whenever app-update.yml has no publisherName) — and the file is
// verified again on 'update-downloaded' (a cached installer skips the download hook) and before every install. A
// verified installer is bound to its content (sha512, which must also be one the feed announced): right before
// quitAndInstall and in the app 'quit' event before the silent install on quit it is hashed again, synchronously.
// A refused file is deleted and remembered by checksum in updater.json (`rejected`): that file is never downloaded
// automatically again (one the check could not decide on: once a day); "Thử lại" retries by hand. After an update the
// installer of the running version is removed from pending\ (retried while the installer that just ran still holds it).
'use strict'

const { app, ipcMain, powerMonitor, shell } = require('electron')
const crypto = require('node:crypto')
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
/**
 * Right after an update the installer that just ran (from pending\) may still be closing: its file is locked and
 * electron-updater's DownloadedUpdateHelper.clear() swallows the error (seen in the signed E2E: the relaunched app
 * cleared 0.1 s after the installer started it, nothing was removed). The clear is checked and tried again after these
 * delays.
 */
const PENDING_CLEAR_RETRY_MS = [5_000, 20_000, 60_000]

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

/** sha512 (base64, the latest.yml format) of a file, streamed. Rejects on a read error. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')
    const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('base64')))
  })
}

const HASH_CHUNK = 4 * 1024 * 1024

/** The same, synchronously (the app 'quit' event cannot wait): ~0.15 s for a 100 MB installer. Throws on a read error. */
function hashFileSync(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const hash = crypto.createHash('sha512')
    const buf = Buffer.allocUnsafe(HASH_CHUNK)
    let n = 0
    while ((n = fs.readSync(fd, buf, 0, HASH_CHUNK, null)) > 0) hash.update(buf.subarray(0, n))
    return hash.digest('base64')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Called once, in the primary instance, inside app.whenReady(), BEFORE the main window exists.
 * → { onWindowReady(), onQuit(exitCode), isQuittingForUpdate() }
 * pendingClearRetryMs: tests only (main.cjs never passes it).
 */
function setupUpdater({ isAppSender, getMainWindow, profileSource, pendingClearRetryMs = PENDING_CLEAR_RETRY_MS }) {
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
  const appName = app.getName()
  let file = readUpdaterFile()
  const startup = rules.startupAttempt(file, current, Date.now())
  const notice = startup.notice
  if (file.attempt && !startup.keep) {
    file = withoutAttempt(file)
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
  let pendingClearTimer = null
  /** Both electron-updater signature hooks are ours and a signer is pinned; false → downloads are refused. */
  let verifierOk = false
  /**
   * The installer that passed every check: { file, size, mtimeMs, sha512, version } (null = none). sha512 is the content
   * that was checked: the install (now or on quit) runs only if the file still hashes to it.
   */
  let verified = null
  /** sha512 checksums the feed announced for the last version found (latest.yml): a refused one is not downloaded again. */
  let offerHashes = []
  /** …and for the installer that became 'ready' (the install re-verifies against them). */
  let readyHashes = []
  /** The version being downloaded (what the electron-updater hooks must find in the file's VersionInfo). */
  let downloadingVersion = ''
  /** Startup housekeeping of electron-updater's cache; a download waits for it. Never rejects. */
  let cacheTidy = Promise.resolve()
  /** The running pre-install verification (a second "install" waits for the same one). */
  let installCheck = null

  // 4. The pinned signer thumbprints (app.asar/package.json `sanovids.signers`).
  const pins = signature.readSignerPins()
  if (!pins.length) log.error('no signer pins in package.json: downloads refused')

  /**
   * The pinned signature, then the file's own (signed) VersionInfo: this app, the offered `version`, newer than the
   * running one, installer-sized. → '' (accepted) or the refusal reason. Never throws.
   */
  async function installerProblem(target, version) {
    try {
      const v = await signature.checkFileSignature(target, { pins, log: (l) => log.info(l) })
      if (!v || v.ok !== true) return (v && typeof v.reason === 'string' && v.reason) || 'verify-failed'
      let size = -1
      try {
        size = fs.statSync(target).size
      } catch {
        size = -1
      }
      const problem = rules.installerIdentityProblem(v, { version, current, appName, size })
      if (problem) {
        log.warn(
          `signature ${problem}: file says ${safeString(v.productName).slice(0, 80)} ${safeString(v.productVersion).slice(0, 64)}, offered ${version || '?'}, running ${current}, size ${size} file=${path.basename(String(target))}`,
        )
      }
      return problem
    } catch (e) {
      log.error(`signature check threw: ${rawError(e)}`)
      return 'verify-failed'
    }
  }

  /**
   * electron-updater verifier contract (both hooks): null = accepted, a string = why it was refused. A refused file is
   * remembered by checksum before electron-updater deletes it. Never throws.
   */
  async function verifyForUpdater(target) {
    try {
      const version = downloadingVersion || state.version || ''
      const problem = await installerProblem(target, version)
      if (!problem) return null
      let sha512 = null
      try {
        sha512 = await hashFile(target)
      } catch (e) {
        log.warn(`could not hash the refused file: ${rawError(e)}`)
      }
      recordRefusal(version, sha512, problem)
      return `sanovids-signature:${problem}`
    } catch (e) {
      log.error(`signature verifier threw: ${rawError(e)}`)
      return 'sanovids-signature:verify-failed'
    }
  }

  /** updater.json `rejected` += this file (by checksum; without one nothing is remembered). Synchronous. */
  function recordRefusal(version, sha512, reason) {
    if (!rules.isSha512(sha512)) return
    file = { ...file, rejected: rules.rememberRejected(file.rejected, { version, sha512, reason }, Date.now()) }
    writeUpdaterFile()
  }

  function readUpdaterFile() {
    try {
      return rules.parseUpdaterFile(fs.readFileSync(filePath, 'utf8'))
    } catch {
      return rules.parseUpdaterFile(null)
    }
  }

  function withoutAttempt(f) {
    const { attempt: _attempt, ...rest } = f
    return rest
  }

  /** Atomic write (tmp + rename), synchronous: also used from the app 'quit' event. */
  function writeUpdaterFile() {
    const data = rules.updaterFileData(file)
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
    file = withoutAttempt(file)
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
    // A newer version was found: the installer downloads it at once when the device pref says so — unless this very
    // file (by checksum) was refused before, in this launch or an earlier one: then it stays refused, shown as the
    // signature error, never offered as a normal update ("Thử lại" retries by hand). A file the check could not decide
    // on is tried again automatically a day later.
    if (event.type === 'available' && prev.status !== 'available' && next.status === 'available' && kind === 'installer') {
      const refused = rules.findRejected(file.rejected, offerHashes, Date.now())
      if (refused) {
        log.info(`auto-download skipped ${next.version}: this file was refused before (${refused.reason}, ${refused.version})`)
        dispatch(signatureError(refused.reason))
      } else if (next.autoDownload) {
        startDownload()
      }
    }
    push(prev, event.type === 'progress')
  }

  /** The error state of a refusal: 'signature' (not the author's update) or 'signature-unverified' (not decided). */
  function signatureFailure(reason) {
    const code = rules.signatureErrorCode(reason)
    return { code, message: rules.ERROR_TEXT[code] }
  }

  function signatureError(reason) {
    return { type: 'download-error', error: signatureFailure(reason) }
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
      const verifyHook = (_publisherNames, target) => verifyForUpdater(target)
      const verifyMethod = (target) => verifyForUpdater(target)
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
        offerHashes = rules.offerHashes(info)
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
      dispatch(signatureError('inactive'))
      return
    }
    downloadInFlight = true
    downloadingVersion = version || ''
    log.info(`download ${version || '?'}`)
    cacheTidy
      .then(() => au.downloadUpdate())
      .catch((e) => {
        log.error(`download failed: ${rawError(e)}`)
        if (e && e.constructor && e.constructor.name === 'CancellationError') return
        // A file our verifier refused (ERR_UPDATER_INVALID_SIGNATURE) was already remembered and deleted by
        // electron-updater; the reason in the message picks 'signature' or 'signature-unverified'.
        dispatch({ type: 'download-error', error: rules.mapUpdaterError(e, 'download') })
      })
      .finally(() => {
        downloadInFlight = false
        downloadingVersion = ''
      })
  }

  /** electron-updater's cached blockmap no longer matches its cached installer.exe (see rules.cachedBlockmapFile). */
  function dropCachedBlockmap(installer) {
    const blockmap = rules.cachedBlockmapFile(installer, path)
    if (!blockmap) return
    try {
      fs.rmSync(blockmap, { force: true })
    } catch (e) {
      log.warn(`could not delete the cached blockmap: ${rawError(e)}`)
    }
  }

  /**
   * Refuses an installer: forgotten as verified, no install on quit, deleted (+ the cached blockmap of its version),
   * remembered by checksum when known, and the state becomes the signature error. Synchronous.
   */
  function refuseInstaller(target, version, reason, sha512) {
    verified = null
    if (au) au.autoInstallOnAppQuit = false
    if (typeof target === 'string' && target !== '') {
      try {
        fs.rmSync(target, { force: true })
      } catch (e) {
        log.warn(`could not delete the refused installer: ${rawError(e)}`)
      }
      dropCachedBlockmap(target)
    }
    recordRefusal(version, sha512, reason)
    log.error(`signature rejected ${version || '?'} (sanovids-signature:${reason}): installer deleted, not installed`)
    dispatch(signatureError(reason))
  }

  /**
   * Verifies the downloaded installer: pinned signature + the offered version of this app (installerProblem), and its
   * content — hashed before and after the check, unchanged, and (when the feed announced checksums) one of `hashes`.
   * OK → remembered in `verified` (path, size, mtime, sha512). Refused → refuseInstaller. → { ok, reason }. Never throws.
   */
  async function verifyDownloaded(target, version, hashes) {
    let reason = 'no-file'
    let sha512 = null
    try {
      if (typeof target === 'string' && target !== '') {
        const st0 = fs.statSync(target)
        reason = 'verify-failed' // until every step below has passed (a read error on the way stays undecided)
        const before = await hashFile(target)
        sha512 = before
        const problem = await installerProblem(target, version)
        if (problem) reason = problem
        else {
          const st1 = fs.statSync(target)
          const after = await hashFile(target)
          sha512 = after
          const announced = Array.isArray(hashes) ? hashes.filter(rules.isSha512) : []
          // The very bytes that were checked, and the file the feed announced (not swapped while PowerShell read it).
          if (st1.size === st0.size && st1.mtimeMs === st0.mtimeMs && after === before && (!announced.length || announced.includes(after))) {
            verified = { file: target, size: st1.size, mtimeMs: st1.mtimeMs, sha512: after, version: version || '' }
            log.info(`signature verified ${version || '?'} ${path.basename(target)}`)
            return { ok: true, reason: '' }
          }
          reason = 'changed'
        }
      }
    } catch (e) {
      log.error(`signature verification failed: ${rawError(e)}`)
    }
    refuseInstaller(target, version, reason, sha512)
    return { ok: false, reason }
  }

  /**
   * Synchronous last look before electron-updater runs the installer (quitAndInstall, install on quit): still the
   * verified file — same path, size, mtime AND content (hashed again now).
   */
  function installerStillVerified() {
    const target = au && au.installerPath
    let st = null
    try {
      st = target ? fs.statSync(target) : null
    } catch {
      st = null
    }
    if (!rules.sameVerifiedMeta(verified, st, target)) return { ok: false, st, sha512: null }
    let sha512 = null
    try {
      sha512 = hashFileSync(target)
    } catch (e) {
      log.warn(`could not hash the installer: ${rawError(e)}`)
    }
    return { ok: rules.sameVerifiedFile(verified, st, target, sha512), st, sha512 }
  }

  /** 'update-downloaded' → verify first; only a verified installer becomes 'ready' (and may install on quit). */
  async function onDownloaded(info) {
    const n = rules.normalizeInfo(info)
    const version = (n && n.version) || state.version || ''
    const target = info && typeof info.downloadedFile === 'string' && info.downloadedFile ? info.downloadedFile : au && au.installerPath
    const announced = rules.offerHashes(info)
    const hashes = announced.length ? announced : offerHashes
    if (!(await verifyDownloaded(target, version, hashes)).ok) return
    readyHashes = hashes
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
    if (pendingClearTimer) clearTimeout(pendingClearTimer)
    firstCheckTimer = scheduleTimer = trailingPush = pendingClearTimer = null
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
      const failure = signatureFailure('inactive')
      return fail(failure.code, failure.message)
    }
    // A file refused earlier may be retried by hand ("Thử lại"): forgotten, then verified again like any download.
    const remembered = rules.forgetRejected(file.rejected, offerHashes)
    if (remembered.length !== (file.rejected || []).length) {
      file = { ...file, rejected: remembered }
      writeUpdaterFile()
      log.info(`retry ${state.version || '?'}: the refused file is downloaded and checked again`)
    }
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
    // Always verified again right before it runs (a refusal deletes it and the state is already the signature error).
    if (!installCheck) {
      installCheck = verifyDownloaded(au.installerPath, state.version, readyHashes).finally(() => {
        installCheck = null
      })
    }
    const checked = await installCheck
    if (!checked.ok) {
      const failure = signatureFailure(checked.reason)
      return fail(failure.code, failure.message)
    }
    if (quittingForUpdate) return OK
    if (state.status !== 'ready') return fail('not-ready', MSG.installNotReady)
    recordAttempt()
    quittingForUpdate = true
    log.info(`install quitAndInstall ${state.version}`)
    setImmediate(() => {
      // Synchronous last look: still the very bytes that passed (a file swapped after the async check never runs).
      const still = installerStillVerified()
      if (!still.ok) {
        log.error('install refused: the installer changed after its check')
        quittingForUpdate = false
        clearAttempt()
        refuseInstaller(au.installerPath, state.version, 'changed', still.sha512)
        return
      }
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

  /**
   * Just updated: electron-updater only empties pending\ when the next download starts, so the installer of the version
   * now running (~100 MB) would sit there until then. installer.exe + current.blockmap (differential downloads) are kept.
   * The folder is listed after each clear (clear() swallows errors, e.g. the just-run installer still holding its file)
   * and the clear tried again after PENDING_CLEAR_RETRY_MS — never while a download runs or an update is ready
   * (electron-updater writes / keeps that one in pending\). A download waits for a running attempt (startDownload chains
   * on cacheTidy). Never rejects.
   */
  function clearPendingAfterUpdate(attempt) {
    return Promise.resolve()
      .then(() => au.getOrCreateDownloadHelper())
      .then(async (helper) => {
        await helper.clear()
        let left = []
        try {
          left = typeof helper.cacheDirForPendingUpdate === 'string' ? fs.readdirSync(helper.cacheDirForPendingUpdate) : []
        } catch {
          left = [] // no folder: nothing left
        }
        if (!left.length) return log.info('pending update files cleared after the update')
        const names = left.slice(0, 5).join(', ').slice(0, 300)
        if (attempt >= pendingClearRetryMs.length) return log.warn(`pending update files not cleared (gave up): ${names}`)
        log.info(`pending update files not cleared yet (${names}): retry in ${Math.round(pendingClearRetryMs[attempt] / 1000)} s`)
        pendingClearTimer = setTimeout(() => {
          pendingClearTimer = null
          if (downloadInFlight || quittingForUpdate || state.status === 'downloading' || state.status === 'ready') {
            return log.info('pending update files left to electron-updater: an update is being downloaded or is ready')
          }
          cacheTidy = clearPendingAfterUpdate(attempt + 1)
        }, pendingClearRetryMs[attempt])
        if (typeof pendingClearTimer.unref === 'function') pendingClearTimer.unref()
      })
      .catch((e) => log.warn(`could not clear the pending update files: ${rawError(e)}`))
  }

  if (kind !== 'dev') au = loadUpdater()
  if (au && kind === 'installer' && notice && notice.kind === 'updated' && typeof au.getOrCreateDownloadHelper === 'function') {
    cacheTidy = clearPendingAfterUpdate(0)
  }
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
      // installer must still be the very file that passed the checks — same path, size, mtime and, when it would install
      // now, the same content (hashed again) — else nothing installs on quit. This also covers a quit while a cached
      // installer is still being verified.
      let stat = null
      try {
        stat = au.installerPath ? fs.statSync(au.installerPath) : null
      } catch {
        stat = null
      }
      const installsNow = state.status === 'ready' && exitCode === 0
      const wouldInstall = au.autoInstallOnAppQuit === true && exitCode === 0 && !!stat
      let intact = rules.sameVerifiedMeta(verified, stat, au.installerPath)
      if (intact && wouldInstall) intact = installerStillVerified().ok
      if (!intact) {
        au.autoInstallOnAppQuit = false
        if (installsNow || stat) log.warn('install on quit skipped: installer not verified')
        // Its blockmap (the next version's) no longer matches the cached installer.exe of the running version.
        if (stat) dropCachedBlockmap(au.installerPath)
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
