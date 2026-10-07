// canvasapp keep-login ("Giữ đăng nhập canvasapp trên máy này", docs/GATEWAY-CANVASAPP.md): the pure rules and the
// keep-login state machine of electron/main.cjs.
//
// Why: canvasapp.io.vn keeps its login in browser-SESSION cookies (no expiry), and Electron never restores session
// cookies of a persist: partition — every restart logged the user out. Once canvasapp has CONFIRMED a login, main keeps
// an encrypted copy (Electron safeStorage: "v10" AES-256-GCM, its key in userData/Local State wrapped by DPAPI / the
// Keychain) of canvasapp.io.vn's OWN session cookies in userData/canvasapp-login.bin, and puts them back — still session
// cookies, never written to Chromium's cookie file — before the first canvasapp request of the next run. canvasapp still
// decides: a refusal (401 / authenticated:false) drops the copy. At most KEEP_LOGIN_DAYS since the login or since
// canvasapp last renewed the cookies (plain use does not extend it). Đăng xuất deletes the copy first.
//
// Never: Cloudflare's cookies, another host's (Google, SePay…), plaintext, a cookie value in a log / IPC payload / error,
// a cookie turned persistent, a quit hook.
// Separately: once canvasapp has confirmed a login, the Google account cookies "Đăng nhập bằng Google" left in the
// canvasapp partition (plaintext, ~2 years) are removed (removeGoogleAccountCookies).
//
// No require (main.cjs and the tests share it; app.asar cannot resolve npm helpers from electron/), no electron, no fs:
// every dependency of createCanvasappKeepLogin is injected, so src/providers/__tests__/canvasappKeepLogin.test.ts runs it
// with fakes and the scratch lab runs it with the real session / safeStorage.
'use strict'

/** A kept login lives this long on the computer after canvasapp last set / renewed its cookies (days). */
const KEEP_LOGIN_DAYS = 30
const KEEP_LOGIN_DAY_MS = 86_400_000
const KEEP_LOGIN_MAX_COOKIES = 30
const KEEP_LOGIN_MAX_VALUE = 4096
/** A copy larger than this (or an empty one) is deleted without being decrypted. */
const KEEP_LOGIN_MAX_FILE_BYTES = 256 * 1024
/** The first canvasapp request waits at most this long for the copy to be put back. */
const KEEP_LOGIN_RESTORE_CAP_MS = 3000
/** Đăng xuất waits at most this long for the requests in flight it aborted to settle. */
const KEEP_LOGIN_DRAIN_CAP_MS = 5000
/** Forget / switch off wait at most this long for a save / restore in progress (e.g. a Keychain prompt on macOS). */
const KEEP_LOGIN_CHAIN_CAP_MS = 5000
const KEEP_LOGIN_DEBOUNCE_MS = 500
const COOKIE_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/
const COOKIE_SAME_SITE = ['unspecified', 'no_restriction', 'lax', 'strict']
const KEEP_LOGIN_PLACEMENTS_ON = ['installer', 'dev']

/** Đăng xuất worked, but the copy could not be deleted nor emptied (an antivirus holds the file): said, never hidden. */
const KEEP_LOGIN_NOT_CLEARED_TEXT =
  'Đã đăng xuất, nhưng chưa xoá được bản sao đăng nhập trên máy (tệp đang bị khoá). Bấm “Thử lại”; nếu vẫn lỗi, khởi động lại máy rồi đăng xuất lần nữa.'
/** Switched off, the copy could not be deleted now: the pref is off, so the next start deletes it unread. */
const KEEP_LOGIN_OFF_NOT_CLEARED_TEXT =
  'Đã tắt giữ đăng nhập. Bản sao đăng nhập trên máy chưa xoá được ngay (tệp đang bị khoá) — SanoVids sẽ xoá nó ở lần mở sau và không dùng lại.'
/** The switch was applied for this run, but the choice could not be written to userData/canvasapp-prefs.json. */
const KEEP_LOGIN_PREFS_NOT_SAVED_TEXT = 'Đã đổi cho lần chạy này, nhưng chưa lưu được lựa chọn (lỗi ghi tệp) — lần mở sau có thể về như cũ. Thử lại.'
/** A canvasapp request refused before it was sent, because Đăng xuất is running. */
const CANVASAPP_LOGGING_OUT_TEXT = 'Đang đăng xuất canvasapp — yêu cầu không được gửi.'
/** A canvasapp request aborted in flight by Đăng xuất (it may have reached canvasapp). */
const CANVASAPP_ABORTED_BY_LOGOUT_TEXT = 'Đã dừng vì đang đăng xuất canvasapp.'

// ---------------------------------------------------------------------------------------------------------------
// Cookie rules
// ---------------------------------------------------------------------------------------------------------------

/** Cloudflare's own cookies (__cf_bm, _cfuvid, cf_clearance, __cflb, cf_chl_*…): never kept — no Cloudflare workarounds. */
function isCloudflareCookie(name) {
  return /^(__cf|_cf|cf_)/i.test(String(name))
}

/** A cookie of exactly `host`: host-only on it, or a domain cookie `.host` (Electron adds the dot). Nothing else. */
function isHostCookie(c, host) {
  if (!c || typeof c.domain !== 'string') return false
  const d = c.domain.toLowerCase()
  return c.hostOnly === true ? d === host : d === '.' + host
}

/** A change (set, overwrite or removal) of a cookie the snapshot could keep: bumps the generation. */
function isKeptCookieChange(c, host) {
  return isHostCookie(c, host) && c.session === true && typeof c.name === 'string' && !isCloudflareCookie(c.name)
}

/**
 * Keep the login when the user never chose? Only in an installed or source SanoVids: a Portable / temp copy often runs
 * on someone else's PC, and before this fix closing the app always logged out. Anything else (unknown) → false.
 */
function defaultKeepLogin(placementKind) {
  return KEEP_LOGIN_PLACEMENTS_ON.includes(placementKind)
}

/** A session cookie of `host` that a restart would lose → the plain entry SanoVids keeps, else null. */
function keptCookieEntry(c, host) {
  if (!isHostCookie(c, host) || c.session !== true || c.expirationDate !== undefined) return null
  if (typeof c.name !== 'string' || !COOKIE_NAME_RE.test(c.name) || isCloudflareCookie(c.name)) return null
  if (typeof c.value !== 'string' || c.value.length > KEEP_LOGIN_MAX_VALUE) return null
  const hostOnly = c.hostOnly === true
  const path = typeof c.path === 'string' && c.path.startsWith('/') && c.path.length <= 1024 ? c.path : '/'
  const secure = c.secure === true
  const sameSite = COOKIE_SAME_SITE.includes(c.sameSite) ? c.sameSite : 'unspecified'
  // Prefix rules (Chromium checks them case-insensitively): a cookie that breaks them could not be set back anyway.
  if (/^__host-/i.test(c.name) && !(hostOnly && secure && path === '/')) return null
  if (/^__secure-/i.test(c.name) && !secure) return null
  if (sameSite === 'no_restriction' && !secure) return null
  return { name: c.name, value: c.value, hostOnly, path, secure, httpOnly: c.httpOnly === true, sameSite }
}

const entryId = (e) => `${e.name}\n${e.path}\n${e.hostOnly ? 1 : 0}`

/** The partition's cookies → { v: 1, savedAt, cookies } to keep, or null (nothing to keep / an abnormal amount). */
function loginSnapshot(cookies, host, savedAt) {
  const seen = new Set()
  const entries = []
  for (const c of Array.isArray(cookies) ? cookies : []) {
    const e = keptCookieEntry(c, host)
    if (!e || seen.has(entryId(e))) continue
    seen.add(entryId(e))
    entries.push(e)
  }
  if (entries.length === 0 || entries.length > KEEP_LOGIN_MAX_COOKIES) return null
  entries.sort((a, b) => (entryId(a) < entryId(b) ? -1 : entryId(a) > entryId(b) ? 1 : 0))
  return { v: 1, savedAt, cookies: entries }
}

/** What the kept login is, savedAt aside: the same key → nothing to write. '' = nothing kept. */
function loginSnapshotKey(snap) {
  return snap ? JSON.stringify(snap.cookies) : ''
}

/** Decrypted text → snapshot, or null: not JSON, another version, only bad entries, older than KEEP_LOGIN_DAYS, from the future. */
function parseLoginSnapshot(text, host, now) {
  let p
  try {
    p = JSON.parse(text)
  } catch {
    return null
  }
  if (!p || typeof p !== 'object' || p.v !== 1 || !Number.isFinite(p.savedAt) || !Array.isArray(p.cookies)) return null
  if (p.savedAt > now + KEEP_LOGIN_DAY_MS || now - p.savedAt > KEEP_LOGIN_DAYS * KEEP_LOGIN_DAY_MS) return null
  // Every entry goes through the same check as a live cookie.
  const asCookies = p.cookies.map((e) =>
    e && typeof e === 'object' && !Array.isArray(e) ? { ...e, session: true, expirationDate: undefined, domain: e.hostOnly === true ? host : '.' + host } : null,
  )
  return loginSnapshot(asCookies, host, p.savedAt)
}

/** Kept entries not in the partition yet (same name + path + host-only): a cookie canvasapp set this run always wins. */
function entriesToRestore(snap, current, host) {
  const have = new Set(
    (Array.isArray(current) ? current : [])
      .filter((c) => isHostCookie(c, host))
      .map((c) => entryId({ name: c.name, path: typeof c.path === 'string' && c.path ? c.path : '/', hostOnly: c.hostOnly === true })),
  )
  return snap ? snap.cookies.filter((e) => !have.has(entryId(e))) : []
}

/** cookies.set details putting an entry back exactly as canvasapp set it: a SESSION cookie (never an expirationDate). */
function restoreCookieDetails(entry, origin, host) {
  const d = { url: origin + entry.path, name: entry.name, value: entry.value, path: entry.path, secure: entry.secure, httpOnly: entry.httpOnly, sameSite: entry.sameSite }
  if (!entry.hostOnly) d.domain = '.' + host
  return d
}

/**
 * Answer of a status request (GET /api/me, GET /api/auth/state) → 'accepted' (canvasapp confirmed the session),
 * 'denied' (canvasapp said "not logged in") or null (says nothing: an error, an odd body). Only an explicit answer
 * counts: a 401, /api/auth/state { authenticated: false }; a body that is not canvasapp's JSON never drops the copy.
 */
function statusVerdict(pathname, status, json) {
  if (pathname !== '/api/me' && pathname !== '/api/auth/state') return null
  if (status === 401) return 'denied'
  if (status !== 200 || !json || typeof json !== 'object' || Array.isArray(json)) return null
  if (pathname === '/api/me') return 'accepted'
  if (json.authenticated === true) return 'accepted'
  if (json.authenticated === false) return 'denied'
  return null
}

/**
 * Diagnostics line for a DevTools (source / test) run: the SHAPE of a canvasapp cookie, so the owner can see whether
 * the login cookie is a session cookie. Never its value.
 */
function cookieShapeLine(c, now) {
  const exp = c && Number.isFinite(c.expirationDate) ? `${Math.round(((c.expirationDate * 1000 - now) / 3_600_000) * 10) / 10} h` : 'session'
  const flag = (k) => (c && c[k] === true ? 'y' : 'n')
  return `${String(c && c.name).slice(0, 80)} domain=${String(c && c.domain).slice(0, 80)} session=${flag('session')} httpOnly=${flag('httpOnly')} secure=${flag('secure')} hostOnly=${flag('hostOnly')} sameSite=${String(c && c.sameSite).slice(0, 20)} expires=${exp}`
}

// ---------------------------------------------------------------------------------------------------------------
// Google account cookies (a separate cleanup, once canvasapp has confirmed the login)
// ---------------------------------------------------------------------------------------------------------------

/**
 * A Google account cookie. "Đăng nhập bằng Google" runs in the canvasapp partition, so Google's long-lived account
 * cookies (~2 years) would sit there in plaintext (CookieEncryption is off) until Đăng xuất. Google's own domains
 * (google.com and its subdomains, country domains like google.com.vn / google.vn / google.co.uk) and YouTube's (Google's
 * sign-in sets them too). Never canvasapp.io.vn, SePay or anything else: `evilgoogle.com`, `google.com.evil.com`,
 * `my-youtube.com` are not Google.
 */
function isGoogleAccountCookie(c) {
  if (!c || typeof c.domain !== 'string') return false
  const d = c.domain.toLowerCase().replace(/^\./, '')
  if (!/^[a-z0-9.-]{1,253}$/.test(d)) return false
  return /^(?:[a-z0-9-]+\.)*(?:google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})|youtube\.com)$/.test(d)
}

/** The URL cookies.remove needs for this cookie: https, its domain without the dot, its path. */
function cookieRemovalUrl(c) {
  const d = String(c.domain).toLowerCase().replace(/^\./, '')
  const path = typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/'
  return `https://${d}${path}`
}

/**
 * Removes the Google account cookies of a partition (`cookies` = Session.cookies: get, remove, flushStore) and flushes.
 * The next Google sign-in in SanoVids asks for the Google password again. Never throws; one failure never stops the
 * others. → how many were removed.
 */
async function removeGoogleAccountCookies(cookies) {
  let list
  try {
    list = await cookies.get({})
  } catch {
    return 0
  }
  let removed = 0
  for (const c of Array.isArray(list) ? list : []) {
    if (!isGoogleAccountCookie(c) || typeof c.name !== 'string') continue
    try {
      await cookies.remove(cookieRemovalUrl(c), c.name)
      removed++
    } catch {
      /* the others still go */
    }
  }
  if (removed) {
    try {
      await cookies.flushStore()
    } catch {
      /* shutting down */
    }
  }
  return removed
}

// ---------------------------------------------------------------------------------------------------------------
// The switch "Giữ đăng nhập canvasapp trên máy này" (userData/canvasapp-prefs.json, held by main — never in the
// settings export / reset of the page)
// ---------------------------------------------------------------------------------------------------------------

/** canvasapp-prefs.json text → { keepLogin } the user chose, or null (missing / anything odd = never chose). */
function parseKeepLoginPrefs(text) {
  let p
  try {
    p = JSON.parse(String(text))
  } catch {
    return null
  }
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.v !== 1 || typeof p.keepLogin !== 'boolean') return null
  return { keepLogin: p.keepLogin }
}

function keepLoginPrefsText(keepLogin) {
  return JSON.stringify({ v: 1, keepLogin: keepLogin === true }) + '\n'
}

/** The user's choice, else the placement default. */
function resolveKeepLogin(prefs, placementKind) {
  return prefs && typeof prefs.keepLogin === 'boolean' ? prefs.keepLogin : defaultKeepLogin(placementKind)
}

/** IPC payload of canvasapp:keepLogin / canvasapp:setKeepLogin: booleans only (never a path, never a cookie). */
function keepLoginPayload({ enabled, available, chosen }) {
  return { ok: true, keepLogin: enabled === true, available: available !== false, chosen: chosen === true }
}

// ---------------------------------------------------------------------------------------------------------------
// The keep-login state machine
// ---------------------------------------------------------------------------------------------------------------

/**
 * deps: {
 *   cookies   Session.cookies of the canvasapp partition (get, set, flushStore),
 *   crypto    safeStorage-like: isEncryptionAvailable() → boolean | Promise<boolean>, encryptStringAsync(text) → bytes,
 *             decryptStringAsync(bytes) → { result, shouldReEncrypt },
 *   fsp       fs.promises-like: readFile, writeFile, rm,   rename (from, to) (default fsp.rename),
 *   file      absolute path of the copy (userData/canvasapp-login.bin),
 *   host, origin, now, sleep(ms), setTimer(fn, ms), clearTimer(t),
 *   enabled = true, debounceMs = 500, capMs = KEEP_LOGIN_CHAIN_CAP_MS
 * }
 * Writes happen only while armed: canvasapp confirmed THIS login (loggedIn / confirmed) or a kept copy was put back.
 * File writes / deletes are serialized on one chain. Never throws out of a listener; never logs.
 */
function createCanvasappKeepLogin(deps) {
  const { cookies, crypto, fsp, file, host, origin, now, sleep, setTimer, clearTimer } = deps
  const rename = deps.rename || ((from, to) => fsp.rename(from, to))
  const debounceMs = deps.debounceMs || KEEP_LOGIN_DEBOUNCE_MS
  const capMs = deps.capMs || KEEP_LOGIN_CHAIN_CAP_MS
  /** Next to the copy when Đăng xuất could not delete / empty it: the next start deletes the copy and never restores it. */
  const forgetMarker = file + '.forget'
  let enabled = deps.enabled !== false
  let armed = false // canvasapp confirmed THIS login, or a kept copy was put back: only then is anything written
  let paused = false // Đăng xuất is clearing the partition
  let epoch = 0 // bumped by forget / setEnabled: saves, restores and answers that started before never write or arm
  let gen = 0 // bumped by every change of a cookie the snapshot keeps (isKeptCookieChange) — never judged by time
  let timer = null
  let fileKey = null // key of the login in the file ('' = no file, null = unknown)
  let unavailable = false // encryption reported unavailable / failed in this run
  let restoring = null
  let chain = Promise.resolve()
  const run = (fn) => (chain = chain.then(() => fn()).catch(() => undefined))
  /** A chain step, waited for at most capMs (false when it did not finish in time). */
  const capped = (p) => Promise.race([p, sleep(capMs).then(() => false)])
  /** Can this computer encrypt? (crypto.isEncryptionAvailable may answer a boolean or a promise of one.) */
  const encryption = async () => {
    let ok = false
    try {
      ok = (await crypto.isEncryptionAvailable()) === true
    } catch {
      ok = false
    }
    unavailable = !ok
    return ok
  }
  const flush = async () => {
    try {
      await cookies.flushStore()
    } catch {
      /* shutting down */
    }
  }
  const stopTimer = () => {
    if (timer) clearTimer(timer)
    timer = null
  }
  const writable = (at) => enabled && armed && !paused && at === epoch
  const exists = async (p) => {
    try {
      await fsp.readFile(p)
      return true
    } catch {
      return false
    }
  }
  /** Deletes the copy (+ a leftover .tmp). Windows may hold it a moment (antivirus): retried, then emptied. → gone? */
  async function dropFile() {
    for (const wait of [0, 150, 600]) {
      if (wait) await sleep(wait)
      try {
        await fsp.rm(file, { force: true })
        fileKey = ''
        break
      } catch {
        fileKey = null
      }
    }
    if (fileKey !== '') {
      try {
        await fsp.writeFile(file, new Uint8Array(0)) // an empty copy is deleted unread at the next start
        fileKey = ''
      } catch {
        /* still there */
      }
    }
    await Promise.resolve(fsp.rm(file + '.tmp', { force: true })).catch(() => undefined)
    if (fileKey === '') {
      await Promise.resolve(fsp.rm(forgetMarker, { force: true })).catch(() => undefined)
      return true
    }
    // Neither deleted nor emptied: leave a marker so the next start deletes it and never puts it back.
    await Promise.resolve(fsp.writeFile(forgetMarker, new Uint8Array(0))).catch(() => undefined)
    return false
  }
  function save(at) {
    return run(async () => {
      if (!writable(at)) return
      const list = await cookies.get({ domain: host })
      if (!writable(at)) return
      const snap = loginSnapshot(list, host, now())
      const key = loginSnapshotKey(snap)
      if (!snap || !(await encryption())) {
        if (fileKey !== '') await dropFile()
      } else if (key !== fileKey) {
        let bytes
        try {
          bytes = await crypto.encryptStringAsync(JSON.stringify(snap))
        } catch (e) {
          unavailable = true
          throw e // nothing written (caught by run); the next change retries
        }
        if (!writable(at)) return // forgotten / switched off while encrypting
        await fsp.writeFile(file + '.tmp', bytes)
        await rename(file + '.tmp', file)
        fileKey = key
        await Promise.resolve(fsp.rm(forgetMarker, { force: true })).catch(() => undefined)
      }
      await flush() // persistent canvasapp cookies reach the disk now, not ~30 s later
    })
  }
  async function restoreNow() {
    const at = epoch
    if (await exists(forgetMarker)) {
      await dropFile() // Đăng xuất asked to forget it: never put back
      return 0
    }
    let bytes
    try {
      bytes = await fsp.readFile(file)
    } catch {
      fileKey = '' // no copy: safeStorage is never touched (no DPAPI / Keychain for users who never log in)
      return 0
    }
    if (!enabled || !bytes || bytes.length === 0 || bytes.length > KEEP_LOGIN_MAX_FILE_BYTES || !(await encryption())) {
      await dropFile()
      return 0
    }
    let snap = null
    let reEncrypt = false
    try {
      const out = await crypto.decryptStringAsync(bytes)
      snap = parseLoginSnapshot(out && out.result, host, now())
      reEncrypt = !!out && out.shouldReEncrypt === true
    } catch {
      snap = null // another Windows account / Local State reset / damaged file
    }
    if (at !== epoch) return 0 // logged out / switched off meanwhile: forget() / setEnabled() delete the file themselves
    if (!snap) {
      await dropFile()
      return 0
    }
    fileKey = reEncrypt ? null : loginSnapshotKey(snap) // null → the next save re-encrypts with the new key
    let restored = 0
    for (const e of entriesToRestore(snap, await cookies.get({ domain: host }), host)) {
      if (at !== epoch) break
      try {
        await cookies.set(restoreCookieDetails(e, origin, host))
        restored++
      } catch {
        /* one bad cookie never blocks the others */
      }
    }
    gen++ // answers to requests sent before the restore say nothing about these cookies
    if (at === epoch) {
      armed = true // the copy came from a login canvasapp confirmed; a refusal disarms it
      if (reEncrypt) void save(epoch)
    }
    return restored
  }
  return {
    /** First canvasapp use (lazy, once, on the chain). Never throws, never touches the network. → { restored } */
    restore() {
      if (!restoring) restoring = run(restoreNow).then((n) => ({ restored: n || 0 }))
      return restoring
    },
    /** Session.cookies 'changed' listener (attached once, after the restore). Never throws. */
    onChanged(_event, cookie) {
      try {
        if (!isHostCookie(cookie, host)) return
        if (isKeptCookieChange(cookie, host)) gen++
        if (!enabled || !armed || paused) return
        stopTimer()
        const at = epoch
        timer = setTimer(() => {
          timer = null
          void save(at)
        }, debounceMs)
      } catch {
        /* a listener never throws into Electron */
      }
    },
    /** Taken just before a status request (GET /api/me, GET /api/auth/state) is sent. */
    mark: () => ({ gen, epoch }),
    /** canvasapp accepted the session for a request marked `m`: arms (once) and saves. */
    confirmed(m) {
      if (!m || m.epoch !== epoch || armed) return Promise.resolve()
      armed = true
      return save(epoch)
    },
    /** canvasapp said "not logged in" for a request marked `m`: drops the copy unless the kept cookies changed since. */
    rejected(m) {
      if (!m || m.epoch !== epoch || m.gen !== gen) return Promise.resolve()
      return run(async () => {
        if (m.epoch !== epoch || m.gen !== gen) return
        armed = false
        stopTimer()
        if (fileKey !== '') await dropFile()
      })
    },
    /** After a successful login (login `finish`): arm, write now and flush (a kill right after login keeps it). → { kept } */
    async loggedIn() {
      armed = true
      stopTimer()
      await save(epoch)
      await flush()
      return { kept: enabled && !unavailable }
    },
    /** Đăng xuất: disarm, delete the copy FIRST, write nothing while fn clears. → { copyRemoved, result } */
    async forget(fn) {
      armed = false
      paused = true
      epoch++
      stopTimer()
      const copyRemoved = (await capped(run(dropFile))) === true
      try {
        return { copyRemoved, result: await fn() }
      } finally {
        paused = false
      }
    },
    /** The switch. Off: the copy is deleted now (this run stays logged in). On: saved now if armed. → { copyRemoved } */
    async setEnabled(on) {
      enabled = on === true
      epoch++
      stopTimer()
      if (!enabled) return { copyRemoved: (await capped(run(dropFile))) === true }
      if (armed) await capped(save(epoch))
      return { copyRemoved: true }
    },
    /** { enabled, available } — available = encryption has not failed in this run (never probes: no Keychain on mount). */
    state: () => ({ enabled, available: !unavailable }),
  }
}

module.exports = {
  KEEP_LOGIN_DAYS,
  KEEP_LOGIN_DAY_MS,
  KEEP_LOGIN_MAX_COOKIES,
  KEEP_LOGIN_MAX_VALUE,
  KEEP_LOGIN_MAX_FILE_BYTES,
  KEEP_LOGIN_RESTORE_CAP_MS,
  KEEP_LOGIN_DRAIN_CAP_MS,
  KEEP_LOGIN_CHAIN_CAP_MS,
  KEEP_LOGIN_DEBOUNCE_MS,
  KEEP_LOGIN_NOT_CLEARED_TEXT,
  KEEP_LOGIN_OFF_NOT_CLEARED_TEXT,
  KEEP_LOGIN_PREFS_NOT_SAVED_TEXT,
  CANVASAPP_LOGGING_OUT_TEXT,
  CANVASAPP_ABORTED_BY_LOGOUT_TEXT,
  isCloudflareCookie,
  isHostCookie,
  isKeptCookieChange,
  defaultKeepLogin,
  keptCookieEntry,
  loginSnapshot,
  loginSnapshotKey,
  parseLoginSnapshot,
  entriesToRestore,
  restoreCookieDetails,
  statusVerdict,
  cookieShapeLine,
  isGoogleAccountCookie,
  cookieRemovalUrl,
  removeGoogleAccountCookies,
  parseKeepLoginPrefs,
  keepLoginPrefsText,
  resolveKeepLogin,
  keepLoginPayload,
  createCanvasappKeepLogin,
}
