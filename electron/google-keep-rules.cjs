// Giữ đăng nhập Google (docs/GATEWAY-CANVASAPP.md, docs/SANO-DESKTOP.md §3b): Google's account cookies — its
// "Không hỏi lại trên máy tính này" device trust among them — live only as SESSION cookies inside Chromium, so they are
// never written to Chromium's cookie file (plaintext: the EnableCookieEncryption fuse stays off, it is one-way and
// SanoVids 1.0.0 shares the profile), and are kept across runs in an encrypted (safeStorage) snapshot SanoVids owns —
// the canvasapp keep-login method (keeplogin-rules.cjs) applied to Google. Used for persist:canvasapp (canvasapp's
// "Đăng nhập bằng Google" popup) and the Tài liệu partition.
//
// Requires only its pure sibling keeplogin-rules.cjs; the cookie store, async safeStorage, fs, the clock and the log are
// injected by main.cjs, fakes by src/lib/__tests__/googleKeepRules.test.ts. Never logs a cookie name or value.
'use strict'

const { isGoogleAccountCookie, cookieEntryFields, restoreCookieDetails, cookieRemovalUrl, removeGoogleAccountCookies } = require('./keeplogin-rules.cjs')

/** A snapshot not rewritten for this long (the app not used) is deleted unread. */
const GOOGLE_KEEP_IDLE_DAYS = 90
const DAY_MS = 86_400_000
const GOOGLE_KEEP_DEBOUNCE_MS = 1000
const GOOGLE_KEEP_MAX_WAIT_MS = 10_000
const GOOGLE_KEEP_MAX_COOKIES = 300
const GOOGLE_KEEP_MAX_FILE_BYTES = 1024 * 1024

const idOf = (e) => `${e.name}\n${e.domain}\n${e.path}\n${e.hostOnly ? 1 : 0}`

/** A Google account cookie → { name, value, hostOnly, path, secure, httpOnly, sameSite, domain (no dot), expirationDate? }, or null. */
function googleEntry(c, expirationDate) {
  if (!isGoogleAccountCookie(c)) return null
  const f = cookieEntryFields(c)
  if (!f) return null
  const e = { ...f, domain: c.domain.toLowerCase().replace(/^\./, '') }
  if (Number.isFinite(expirationDate)) e.expirationDate = expirationDate
  return e
}

/** An entry of the snapshot file, checked like a live cookie → entry, or null. */
function fileEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.domain !== 'string') return null
  if (raw.expirationDate !== undefined && !Number.isFinite(raw.expirationDate)) return null
  return googleEntry({ ...raw, domain: raw.hostOnly === true ? raw.domain : '.' + raw.domain }, raw.expirationDate)
}

/** cookies.set details: always a SESSION cookie (never an expirationDate), on https://<host><path>. */
const sessionDetails = (e) => restoreCookieDetails(e, 'https://' + e.domain, e.domain)

/** Decrypted text → { v: 1, savedAt, owner, cookies }, or null. */
function parseSnapshot(text) {
  let p
  try {
    p = JSON.parse(text)
  } catch {
    return null
  }
  if (!p || typeof p !== 'object' || p.v !== 1 || !Number.isFinite(p.savedAt) || !Array.isArray(p.cookies)) return null
  return p.owner === null || typeof p.owner === 'string' ? p : null
}

/**
 * deps: { label (log prefix), file (the snapshot), cookies (Session.cookies: get, set, remove, flushStore, on),
 * crypto (keep-login's async safeStorage: isEncryptionAvailable() → boolean | Promise<boolean> — false for Linux
 * basic_text —, encryptStringAsync(text) → bytes, decryptStringAsync(bytes) → { result }), fs (fs.promises-like: readFile, writeFile, rename, rm), now(), log(line), allowed() → may Google be kept now?,
 * owner() → the key the snapshot is bound to, or null (optional: no owner), setTimer / clearTimer (optional) }.
 *
 * Nothing is saved before restore() (the store holds the snapshot's cookies only from then on) or after detach() (the
 * partition is about to be cleared): an empty store then never deletes the snapshot. Not allowed (or no encryption):
 * nothing is written, save() deletes the snapshot, wipe() also removes the cookies.
 */
function createGoogleKeep(deps) {
  const { label, file, cookies, crypto, fs, now, log } = deps
  const allowed = deps.allowed || (() => true)
  const setTimer = deps.setTimer || setTimeout
  const clearTimer = deps.clearTimer || clearTimeout
  const ownerNow = () => (deps.owner ? deps.owner() || null : null)
  const expiries = new Map() // idOf → original expirationDate (s) of a cookie made a session cookie
  let bound // the owner of the cookies in the store, taken by restore()
  let live = false // between restore() and detach()
  let listening = false
  let timer = null
  let firstAt = 0
  let lastKey = null // what the file holds ('' = no file, null = unknown)
  let wipes = 0 // wipe() calls: a conversion awaiting its re-read never sets a cookie a wipe is removing
  let chain = Promise.resolve()
  const run = (fn) => (chain = chain.then(fn).catch((e) => log(`[SanoVids] ${label}: failed (${e && e.name})`)))

  const keepable = async () => {
    try {
      return allowed() === true && (await crypto.isEncryptionAvailable()) === true
    } catch {
      return false
    }
  }
  const flush = () => Promise.resolve().then(() => cookies.flushStore()).catch(() => undefined)
  const stopTimer = () => {
    if (timer) clearTimer(timer)
    timer = null
    firstAt = 0
  }
  const googleCookies = async () => {
    const list = await cookies.get({})
    return Array.isArray(list) ? list.filter(isGoogleAccountCookie) : []
  }
  const removeCookie = (c) => Promise.resolve().then(() => cookies.remove(cookieRemovalUrl(c), c.name)).catch(() => undefined)
  async function dropFile() {
    await Promise.resolve().then(() => fs.rm(file + '.tmp', { force: true })).catch(() => undefined)
    try {
      await fs.rm(file, { force: true })
      lastKey = ''
    } catch (e) {
      lastKey = null
      log(`[SanoVids] ${label}: could not delete the copy (${e && e.code})`)
    }
  }
  /** A persistent Google cookie → the same cookie as a session one (it replaces the row before Chromium commits it). */
  async function toSession(c) {
    const e = googleEntry(c)
    const gen = wipes
    try {
      if (!e) throw new TypeError('not settable')
      // re-read: a cookie replaced or removed since this event has its own event, and a late set would bring it back
      const cur = (await cookies.get({ url: cookieRemovalUrl(c), name: c.name })).find((x) => {
        const g = googleEntry(x)
        return g && idOf(g) === idOf(e)
      })
      if (!cur || cur.session !== false || cur.value !== c.value) return
      if (gen !== wipes) return await removeCookie(c) // a wipe began meanwhile: gone, never set again
      expiries.set(idOf(e), c.expirationDate)
      await cookies.set(sessionDetails(e))
    } catch (err) {
      log(`[SanoVids] ${label}: a Google cookie could not be made a session cookie, removed (${err && err.name})`)
      await removeCookie(c) // never left to reach the disk
    }
  }
  async function saveNow() {
    if (!live) return
    if (!(await keepable())) {
      if (lastKey !== '') await dropFile()
      return
    }
    const owner = bound === undefined ? ownerNow() : bound
    if (deps.owner && owner === null) return // whose cookies these are is not known: nothing written
    const list = await googleCookies()
    if (!live) return // detached while waiting: the store may already be cleared, so nothing is written or deleted
    const seen = new Set()
    const entries = []
    for (const c of list) {
      const e = googleEntry(c)
      if (!e || seen.has(idOf(e))) continue
      const exp = c.session === false ? c.expirationDate : expiries.get(idOf(e))
      if (Number.isFinite(exp)) {
        if (exp * 1000 <= now()) continue
        e.expirationDate = exp
      }
      seen.add(idOf(e))
      entries.push(e)
    }
    if (entries.length === 0) {
      if (lastKey !== '') await dropFile()
      return
    }
    const kept = entries.slice(0, GOOGLE_KEEP_MAX_COOKIES)
    const key = JSON.stringify([owner, kept])
    if (key === lastKey) return
    const bytes = await crypto.encryptStringAsync(JSON.stringify({ v: 1, savedAt: now(), owner, cookies: kept }))
    try {
      await fs.writeFile(file + '.tmp', bytes)
      await fs.rename(file + '.tmp', file)
      lastKey = key
    } catch (e) {
      lastKey = null
      await Promise.resolve().then(() => fs.rm(file + '.tmp', { force: true })).catch(() => undefined)
      throw e
    }
  }
  async function restoreNow() {
    stopTimer()
    bound = ownerNow()
    live = true
    if (deps.owner && bound === null) return 0 // no owner now: the snapshot is neither read nor deleted
    let bytes
    try {
      bytes = await fs.readFile(file)
    } catch {
      lastKey = '' // no copy: safeStorage is never touched
      return 0
    }
    if (!(await keepable())) {
      await dropFile()
      return 0
    }
    let snap = null
    try {
      if (bytes && bytes.length > 0 && bytes.length <= GOOGLE_KEEP_MAX_FILE_BYTES) snap = parseSnapshot((await crypto.decryptStringAsync(bytes)).result)
    } catch {
      snap = null // another Windows account / Local State reset / damaged file
    }
    const t = now()
    const why = !snap ? 'unreadable' : t - snap.savedAt > GOOGLE_KEEP_IDLE_DAYS * DAY_MS || snap.savedAt > t + DAY_MS ? 'too old' : snap.owner !== bound ? 'another owner' : ''
    if (why) {
      log(`[SanoVids] ${label}: copy deleted (${why})`)
      await dropFile()
      return 0
    }
    const have = new Set((await googleCookies()).map((c) => googleEntry(c)).filter(Boolean).map(idOf))
    let restored = 0
    for (const e of snap.cookies.slice(0, GOOGLE_KEEP_MAX_COOKIES).map(fileEntry)) {
      if (!e || have.has(idOf(e)) || (e.expirationDate !== undefined && e.expirationDate * 1000 <= t)) continue // a cookie set this run wins
      try {
        await cookies.set(sessionDetails(e))
        if (e.expirationDate !== undefined) expiries.set(idOf(e), e.expirationDate)
        restored++
      } catch {
        /* one bad cookie never blocks the others */
      }
    }
    lastKey = null // the next save rewrites it (savedAt: the app was used)
    log(`[SanoVids] ${label}: ${restored} Google cookies put back`)
    return restored
  }
  async function sweepNow() {
    const left = (await googleCookies()).filter((c) => c.session === false)
    if (!left.length) return
    const keep = await keepable()
    for (const c of left) {
      if (keep) await toSession(c)
      else await removeCookie(c)
    }
    await flush()
    if (keep) await saveNow()
  }
  const schedule = () => {
    if (!live) return
    const t = now()
    if (!firstAt) firstAt = t
    if (timer) clearTimer(timer)
    timer = setTimer(
      () => {
        timer = null
        firstAt = 0
        void run(saveNow)
      },
      Math.max(0, Math.min(GOOGLE_KEEP_DEBOUNCE_MS, firstAt + GOOGLE_KEEP_MAX_WAIT_MS - t)),
    )
  }

  return {
    /** Before the first use of the partition: puts the snapshot back as session cookies. → how many. Never throws. */
    restore: () => run(restoreNow).then((n) => n || 0),
    /** Google cookies already persistent in the store (an older build, a crash, SanoVids 1.0.0): made session ones (kept) or removed. */
    sweep: () => run(sweepNow),
    /** Watches the store (once): a persistent Google cookie becomes a session one at once; changes are saved (1 s debounce, 10 s max). */
    start() {
      if (listening) return
      listening = true
      cookies.on('changed', (_event, cookie, cause, removed) => {
        try {
          if (!isGoogleAccountCookie(cookie)) return
          if (!removed && cookie.session === false) {
            void toSession(cookie)
            return
          }
          // 'explicit': SanoVids' own clear / wipe; 'overwrite': the insert that follows is the change
          if (removed && (cause === 'explicit' || cause === 'overwrite')) return
          schedule()
        } catch {
          /* a listener never throws into Electron */
        }
      })
    },
    /** Writes the snapshot now (deleted when nothing is kept). Never throws. */
    save() {
      stopTimer()
      return run(saveNow)
    },
    /** The partition is about to be cleared: nothing is saved until the next restore(). */
    detach() {
      stopTimer()
      live = false
    },
    /** Removes the Google account cookies of the store and the snapshot, then flushes. Never throws. */
    wipe() {
      stopTimer()
      wipes++
      return run(async () => {
        expiries.clear()
        await removeGoogleAccountCookies(cookies)
        await dropFile()
        await flush()
      })
    },
  }
}

module.exports = {
  GOOGLE_KEEP_IDLE_DAYS,
  GOOGLE_KEEP_DEBOUNCE_MS,
  GOOGLE_KEEP_MAX_WAIT_MS,
  GOOGLE_KEEP_MAX_COOKIES,
  GOOGLE_KEEP_MAX_FILE_BYTES,
  googleEntry,
  fileEntry,
  parseSnapshot,
  createGoogleKeep,
}
