// SanoVids — the development-mode lock in the main process ("ẩn chế độ Phát triển"). Pure decisions live in
// ./devaccess-rules.cjs (tested); this file wires them to IPC, userData/dev-access.json, node:crypto, safeStorage (the
// authenticator secret, Windows only) and the clock.
//
// Main decides, the page follows: in a release build the page only learns the access from here (the
// --bdp-dev-access=… argument of the window, devAccess:getState, the devAccess:state push to the main window). The
// page can ASK to unlock / lock / link, and every handler checks the state itself first (rules.opAllowed): no channel
// creates an unlocked state except a verified unlock, and none extends it past what the code allowed.
//
// Never: a network request, a secret or a code in the log or in the state, a write outside userData, anything about
// the debugging tools / switches / CSP / fuses (unlocking changes nothing of the hardening — main.cjs decides those
// first and passes only `buildOpen`).
'use strict'

const { ipcMain, powerMonitor, safeStorage } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const rules = require('./devaccess-rules.cjs')

const FILE = 'dev-access.json'
const BAD_FILE = 'dev-access.bad.json'
const FILE_MAX_BYTES = 16 * 1024
const LOG_MAX_BYTES = 128 * 1024
/** Expiry is also checked this often (sleep, clock changes) and when the computer wakes up. */
const RECHECK_MS = 10 * 60_000
/** setTimeout fires at once past 2^31-1 ms: long waits are re-armed. */
const TIMER_MAX_MS = 24 * 24 * 3600_000
const CHANNELS = Object.freeze(['getState', 'unlock', 'lock', 'setKeep', 'totpBegin', 'totpConfirm', 'linkCancel', 'totpRemove'].map((c) => `devAccess:${c}`))

/** The app's own package.json (inside app.asar when packaged), or {} when unreadable. */
function readPackage(pkgJsonPath) {
  try {
    const file = typeof pkgJsonPath === 'string' && pkgJsonPath ? pkgJsonPath : path.join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
    return pkg && typeof pkg === 'object' ? pkg : {}
  } catch {
    return {}
  }
}

/** A test build that bakes `sanovidsTestDevLock: true` (extraMetadata) is locked like the release build. */
function readTestDevLock(pkgJsonPath) {
  return readPackage(pkgJsonPath).sanovidsTestDevLock === true
}

/** Pinned owner keys of package.json `sanovids.devUnlockKeys` (top level: `build` is stripped when packaging). */
function readDevUnlockPins(pkgJsonPath) {
  const pkg = readPackage(pkgJsonPath)
  return rules.parseDevUnlockPins(pkg.sanovids && typeof pkg.sanovids === 'object' ? pkg.sanovids.devUnlockKeys : undefined)
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest()
const hmacSha1 = (key, msg) => crypto.createHmac('sha1', key).update(msg).digest()

const keyObjects = new Map()
/** Ed25519 check of a code against a pinned public key (JWK import of the 32-byte key). */
function ed25519Verify(pin, message, signature) {
  let key = keyObjects.get(pin.key)
  if (!key) {
    key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pin.key }, format: 'jwk' })
    keyObjects.set(pin.key, key)
  }
  return crypto.verify(null, message, key, signature)
}

/** userData/logs/devaccess.log — operation + result code only (never a code, a secret, a nonce or a full device code). */
function createLogger(dir) {
  const file = path.join(dir, 'devaccess.log')
  const previous = path.join(dir, 'devaccess.1.log')
  return (line) => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      try {
        if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, previous)
      } catch {
        /* no log yet */
      }
      fs.appendFileSync(file, `${new Date().toISOString()} ${String(line).replace(/[\r\n]+/g, ' ').slice(0, 300)}\n`, 'utf8')
    } catch {
      /* logging never breaks the app */
    }
  }
}

/**
 * Sets the lock up (call after app ready — safeStorage, powerMonitor — and before the main window is created).
 *   userDataDir    app.getPath('userData')
 *   buildOpen      rules.devOpenBuild (from source / a test build, unless it bakes the lock): no code needed
 *   isAppSender    main's fromApp (only app://bdp pages may call)
 *   getMainWindow  the window that receives 'devAccess:state'
 * → { initialArg(), state(), attachWindow(win), dispose() }
 */
function setupDevAccess({ userDataDir, pkgJsonPath, buildOpen, isAppSender, getMainWindow, platform = process.platform, now = Date.now }) {
  const file = path.join(userDataDir, FILE)
  const log = createLogger(path.join(userDataDir, 'logs'))
  const pins = readDevUnlockPins(pkgJsonPath)
  const open = buildOpen === true
  /** The record, or null (build mode without a file). */
  let record = null
  /** false = the file cannot be written: unlocks last for this run only, no authenticator link. */
  let persist = true
  let deviceId = null
  let deviceCode = ''
  /** The authenticator link window: { until, started, pending (secret bytes | null), timer } | null. Memory only. */
  let link = null
  /** The Windows-encrypted authenticator secret cannot be decrypted any more (another user / copied folder). */
  let totpLost = false
  let lastAttemptAt = Number.NEGATIVE_INFINITY
  let lastAccess = null
  let expiryTimer = null
  let chain = Promise.resolve()

  const verify = (pin, message, signature) => ed25519Verify(pin, message, signature)
  const short = () => (deviceCode ? deviceCode.slice(0, 4) : '----')

  function writeRecord() {
    if (!persist || !record) return false
    const part = `${file}.part`
    try {
      fs.mkdirSync(userDataDir, { recursive: true })
      fs.writeFileSync(part, rules.serializeRecord(record), platform === 'win32' ? { encoding: 'utf8' } : { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(part, file)
      return true
    } catch (e) {
      persist = false
      log(`write-failed session-only (${(e && e.code) || 'error'})`)
      try {
        fs.rmSync(part, { force: true })
      } catch {
        /* nothing to clean */
      }
      return false
    }
  }

  function setDevice() {
    const secret = record ? rules.b64urlDecode(record.device) : null
    deviceId = secret ? rules.deviceIdOf(secret, sha256) : null
    deviceCode = deviceId ? rules.deviceCodeText(deviceId) : ''
  }

  function freshRecord() {
    record = rules.newRecord(rules.b64urlEncode(crypto.randomBytes(32)))
    setDevice()
    writeRecord()
  }

  function unwrapSecret(totp) {
    if (!totp) return null
    if (totp.wrap === 'none') return rules.base32Decode(totp.secret)
    if (platform !== 'win32') return null
    try {
      return rules.base32Decode(safeStorage.decryptString(Buffer.from(totp.secretEnc, 'base64')))
    } catch {
      return null
    }
  }

  /** Windows: the secret encrypted with DPAPI (per Windows account, no prompt); elsewhere / unavailable: plain (0600). */
  function wrapSecret(secret) {
    const b32 = rules.base32Encode(secret)
    if (platform === 'win32') {
      try {
        if (safeStorage.isEncryptionAvailable()) return { wrap: 'dpapi', secretEnc: safeStorage.encryptString(b32).toString('base64') }
      } catch {
        /* falls back below */
      }
      log('totp-wrap-off')
    }
    return { wrap: 'none', secret: b32 }
  }

  function load() {
    let text = null
    try {
      const st = fs.statSync(file)
      text = st.size <= FILE_MAX_BYTES ? fs.readFileSync(file, 'utf8') : ''
    } catch {
      text = null
    }
    const parsed = text === null ? null : rules.parseRecord(text)
    if (open) {
      // Opened by the build: read-only (the device code, if one exists), nothing created or renamed.
      record = parsed
      setDevice()
      return
    }
    if (text !== null && !parsed) {
      log('record-bad')
      try {
        fs.renameSync(file, path.join(userDataDir, BAD_FILE))
      } catch {
        /* overwritten below */
      }
    }
    if (parsed) {
      record = parsed
      setDevice()
    } else freshRecord()
    if (record.totp && !unwrapSecret(record.totp)) {
      totpLost = true
      log('totp-unwrap-failed')
    }
  }

  function linkInfo(t) {
    return { open: !!link && link.until > t, started: !!(link && link.started), pending: !!(link && link.pending) }
  }

  function closeLink() {
    if (!link) return false
    clearTimeout(link.timer)
    if (link.pending) link.pending.fill(0)
    link = null
    return true
  }

  function openLink(t) {
    closeLink()
    const timer = setTimeout(() => {
      if (closeLink()) push()
    }, rules.LINK_WINDOW_MS + 50)
    if (timer && typeof timer.unref === 'function') timer.unref()
    link = { until: t + rules.LINK_WINDOW_MS, started: false, pending: null, timer }
  }

  /** Access now; a stored unlock that ran out / no longer verifies is dropped from the file here. */
  function accessNow() {
    const acc = rules.accessOf({ buildOpen: open, record, nowMs: now(), pins, verify, deviceId })
    if (acc.reason && record && record.unlock) {
      record.unlock = null
      writeRecord()
      log(`locked ${acc.reason}`)
    }
    if (acc.access !== 'unlocked') closeLink()
    return acc
  }

  function view(acc = accessNow()) {
    return rules.stateView({ acc, record, link, persist, totpLost, nowMs: now(), deviceCode })
  }

  function push(reason) {
    const win = getMainWindow && getMainWindow()
    if (!win || win.isDestroyed()) return
    const state = view()
    try {
      win.webContents.send('devAccess:state', reason ? { ...state, reason } : state)
    } catch {
      /* window going away */
    }
  }

  function schedule() {
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = null
    const u = record && record.unlock
    if (!u) return
    const ends = [u.until, u.capUntil].filter((v) => Number.isSafeInteger(v))
    if (!ends.length) return
    const ms = Math.min(Math.max(0, Math.min(...ends) - now()) + 100, TIMER_MAX_MS)
    expiryTimer = setTimeout(() => enqueue(reconcile), ms)
    if (typeof expiryTimer.unref === 'function') expiryTimer.unref()
  }

  /** Re-reads the access (timers, wake-up, every getState); tells the page when it changed. */
  function reconcile() {
    const before = lastAccess
    const acc = accessNow()
    lastAccess = acc.access
    schedule()
    if (before !== null && before !== acc.access) push(acc.reason || undefined)
    return acc
  }

  function changed() {
    lastAccess = accessNow().access
    schedule()
    push()
  }

  const enqueue = (fn) => {
    const run = chain.then(fn)
    chain = run.catch(() => undefined)
    return run
  }

  const fail = (error, extra) => ({ ok: false, error, ...(extra || {}) })

  // ---- operations (each runs after the previous one) ----

  function unlock(arg) {
    const t = now()
    const acc = reconcile()
    if (rules.opAllowed('unlock', { access: acc.access }) !== true) return { ok: true, state: view(acc) }
    const code = arg && typeof arg.code === 'string' ? arg.code : ''
    if (!code || code.length > rules.MAX_INPUT) return fail('malformed')
    if (t - lastAttemptAt < rules.MIN_ATTEMPT_GAP_MS) return fail('too-fast')
    lastAttemptAt = t
    const input = rules.classifyInput(code)
    if (input.kind === 'totp') return unlockTotp(input.digits, t)
    if (input.kind !== 'signed') {
      log('unlock malformed')
      return fail('malformed')
    }
    const r = rules.judgeSignedCode({ bytes: input.bytes, pins, deviceId, nowMs: t, used: record.used, verify })
    if (!r.ok) {
      log(`unlock code ${r.error}`)
      return fail(r.error, { ...(r.codeDevice ? { codeDevice: r.codeDevice } : {}), thisDevice: deviceCode })
    }
    const times = rules.unlockTimes({ nowMs: t, keepDays: record.keepDays, maxDays: r.maxDays })
    record.used = rules.withUsed(record.used, r.nonce, r.useByMs, t)
    record.unlock = { method: 'code', at: t, until: times.until, capUntil: times.capUntil, code: input.text }
    // A verified owner-signed code proves ownership: earlier wrong 6-digit tries (someone at the PC, a script, a PC
    // clock a few minutes off) no longer hold a wait — otherwise totpConfirm would refuse with 'wait' for longer than
    // the 5-minute link window and the one-time code that the wait texts recommend would be burned for nothing.
    record.fails = rules.afterSuccess()
    const saved = writeRecord()
    // Linking an authenticator: only right after a code that allows it, for this device's owner (no max days), and
    // only when the link can be stored.
    if (r.link && r.maxDays === 0 && saved) openLink(t)
    log(`unlock code ok kid=${r.kid}${saved ? '' : ' session-only'}${link ? ' link-window' : ''} device=${short()}`)
    changed()
    return { ok: true, state: view() }
  }

  function unlockTotp(digits, t) {
    const waiting = rules.failState(record.fails, t)
    if (waiting.waiting) return fail('wait', { waitUntil: waiting.waitUntil })
    if (!record.totp) return fail('totp-none', { thisDevice: deviceCode })
    const secret = unwrapSecret(record.totp)
    if (!secret) {
      totpLost = true
      log('unlock totp-lost')
      return fail('totp-lost', { thisDevice: deviceCode })
    }
    const r = rules.judgeTotp({ secret, digits, nowMs: t, lastStep: record.totp.lastStep, hmacSha1 })
    secret.fill(0)
    if (r.ok) {
      const times = rules.unlockTimes({ nowMs: t, keepDays: record.keepDays, maxDays: 0 })
      record.totp = { ...record.totp, lastStep: r.step }
      record.unlock = { method: 'totp', at: t, until: times.until, capUntil: null }
      record.fails = rules.afterSuccess()
      const saved = writeRecord()
      log(`unlock totp ok${saved ? '' : ' session-only'}`)
      changed()
      return { ok: true, state: view() }
    }
    if (r.counts) {
      record.fails = rules.afterFail(record.fails, t)
      writeRecord()
    }
    log(`unlock ${r.error}`)
    const after = rules.failState(record.fails, t)
    return fail(r.error, { ...(r.minutes ? { minutes: r.minutes } : {}), ...(after.waiting ? { waitUntil: after.waitUntil } : {}), thisDevice: deviceCode })
  }

  function lock() {
    if (!open && record && record.unlock) {
      record.unlock = null
      writeRecord()
      log('lock')
    }
    closeLink()
    changed()
    return view()
  }

  function setKeep(arg) {
    const t = now()
    const acc = reconcile()
    const allowed = rules.opAllowed('setKeep', { access: acc.access })
    if (allowed !== true) return fail(allowed)
    const days = Number(arg && arg.days)
    const k = rules.keepUntil({ nowMs: t, days, capUntil: record.unlock.capUntil })
    if (!k.ok) return fail(k.error)
    record.keepDays = days
    record.unlock = { ...record.unlock, until: k.until }
    writeRecord()
    log(`keep ${days}`)
    changed()
    return { ok: true, state: view() }
  }

  function totpBegin() {
    const t = now()
    const acc = reconcile()
    const allowed = rules.opAllowed('totpBegin', { access: acc.access, link: linkInfo(t) })
    if (allowed !== true) {
      log(`link-begin ${allowed}`)
      return fail(allowed)
    }
    const secret = crypto.randomBytes(20)
    link.started = true
    link.pending = Uint8Array.from(secret)
    const b32 = rules.base32Encode(secret)
    secret.fill(0)
    log('link-begin ok')
    push()
    return { ok: true, uri: rules.otpauthUri({ secretB32: b32, deviceCode }), secretGroups: rules.secretGroups(b32), label: rules.totpLabel(deviceCode) }
  }

  function totpConfirm(arg) {
    const t = now()
    const acc = reconcile()
    const allowed = rules.opAllowed('totpConfirm', { access: acc.access, link: linkInfo(t) })
    if (allowed !== true) return fail(allowed)
    const waiting = rules.failState(record.fails, t)
    if (waiting.waiting) return fail('wait', { waitUntil: waiting.waitUntil })
    if (t - lastAttemptAt < rules.MIN_ATTEMPT_GAP_MS) return fail('too-fast')
    lastAttemptAt = t
    const input = rules.classifyInput(arg && typeof arg.code === 'string' ? arg.code : '')
    if (input.kind !== 'totp') return fail('malformed')
    const r = rules.judgeTotp({ secret: link.pending, digits: input.digits, nowMs: t, lastStep: -1, hmacSha1 })
    if (!r.ok) {
      if (r.counts) {
        record.fails = rules.afterFail(record.fails, t)
        writeRecord()
      }
      log(`link-confirm ${r.error}`)
      const after = rules.failState(record.fails, t)
      return fail(r.error, { ...(r.minutes ? { minutes: r.minutes } : {}), ...(after.waiting ? { waitUntil: after.waitUntil } : {}), thisDevice: deviceCode })
    }
    const previous = record.totp
    record.totp = { ...wrapSecret(link.pending), lastStep: r.step, linkedAt: t }
    record.fails = rules.afterSuccess()
    if (!writeRecord()) {
      record.totp = previous
      return fail('write-failed')
    }
    totpLost = false
    closeLink()
    log(`link-confirm ok wrap=${record.totp.wrap}`)
    changed()
    return { ok: true, state: view() }
  }

  function linkCancel() {
    if (closeLink()) log('link-cancel')
    push()
    return view()
  }

  function totpRemove() {
    const acc = reconcile()
    const allowed = rules.opAllowed('totpRemove', { access: acc.access })
    if (allowed !== true) return fail(allowed)
    record.totp = null
    totpLost = false
    writeRecord()
    log('link-remove')
    changed()
    return { ok: true, state: view() }
  }

  // ---- wiring ----

  load()
  lastAccess = accessNow().access
  schedule()
  log(`start ${lastAccess}${open ? ' (build)' : ''} pins=${pins.length} device=${short()}`)

  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, arg) => {
      if (!isAppSender(event)) return fail('not-allowed')
      return enqueue(() => fn(arg)).catch((e) => {
        log(`${channel} failed (${(e && e.name) || 'error'})`)
        return fail('failed')
      })
    })
  handle('devAccess:getState', () => view(reconcile()))
  handle('devAccess:unlock', unlock)
  handle('devAccess:lock', lock)
  handle('devAccess:setKeep', setKeep)
  handle('devAccess:totpBegin', totpBegin)
  handle('devAccess:totpConfirm', totpConfirm)
  handle('devAccess:linkCancel', linkCancel)
  handle('devAccess:totpRemove', totpRemove)

  const onResume = () => void enqueue(reconcile)
  powerMonitor.on('resume', onResume)
  const recheck = setInterval(() => void enqueue(reconcile), RECHECK_MS)
  if (typeof recheck.unref === 'function') recheck.unref()

  return {
    /** `--bdp-dev-access=build|unlocked|locked` for the window's additionalArguments (preload reads it). */
    initialArg: () => `--bdp-dev-access=${view().access}`,
    state: () => view(),
    /** Minimizing / hiding the window ends a link window (the secret is never shown to nobody watching). */
    attachWindow(win) {
      const onHide = () => {
        if (closeLink()) {
          log('link-cancel hidden')
          push()
        }
      }
      win.on('minimize', onHide)
      win.on('hide', onHide)
    },
    dispose() {
      if (expiryTimer) clearTimeout(expiryTimer)
      clearInterval(recheck)
      closeLink()
      powerMonitor.removeListener('resume', onResume)
      for (const c of CHANNELS) ipcMain.removeHandler(c)
    },
  }
}

module.exports = { setupDevAccess, readTestDevLock, readDevUnlockPins, CHANNELS }
