// Sano Agent in-app sign-in (D253, SANO TH-44 step 3, docs/SANO-DESKTOP.md "Tài khoản SANO"): the sign-in form sits in
// SANO's page, but that page's CSP (connect-src 'self') cannot reach a server, so every account call goes page →
// preload (window.sanoDesktop.account) → main → the SANO account server. Password and Google sign-in end the same way:
// a one-time code bound to a PKCE verifier only main holds, exchanged for a `sano_…` session (30 days), kept encrypted
// (safeStorage) in <profile>/sano-account.bin, or in memory only when this computer cannot encrypt.
//
// No require (like the other *-rules.cjs): fetch, fs, safeStorage, the clock, random bytes and the Google sign-in of
// google-signin-rules.cjs are injected by main.cjs, fakes by src/lib/__tests__/sanoAccountRules.test.ts. Nothing here
// logs a password, a token or a code.
'use strict'

const TIMEOUT_MS = 20_000
/** Longest value main accepts per field (the preload cuts one past it, so an overlong value is refused, not cut). */
const LIMITS = Object.freeze({ identifier: 254, password: 128, name: 100, email: 254, username: 32 })
/**
 * The redirect_uri of the code flow. Never navigated (password sign-in returns the code in the JSON answer; Google's own
 * loopback is google-signin-rules'), nothing listens on it: SANO's authorizeField only wants a loopback with an explicit
 * port, and the token exchange must repeat it. What binds the code to this app is the PKCE verifier, held in main.
 */
const REDIRECT_URI = 'http://127.0.0.1:9/callback'
const CALLS = Object.freeze(['status', 'login', 'register', 'forgot', 'google', 'cancelGoogle', 'signOut'])

const TEXT = Object.freeze({
  offline: 'Không kết nối được máy chủ tài khoản. Kiểm tra mạng rồi thử lại.',
  unconfigured: 'Bản Sano Agent này chưa nối máy chủ tài khoản.',
  invalid: 'Máy chủ tài khoản trả lời không hợp lệ. Thử lại sau.',
  badInput: 'Thông tin nhập không hợp lệ.',
  stateMismatch: 'Đăng nhập chưa hoàn tất. Hãy thử lại.',
  googleCancelled: 'Đã huỷ đăng nhập Google.',
  notAllowed: 'Nguồn gọi không hợp lệ.',
  signOutFailed: 'Phiên vẫn còn trên máy này. Kiểm tra mạng rồi thử lại, hoặc đóng hẳn Sano Agent rồi mở lại.',
  notSaved: 'Không lưu được phiên đăng nhập trên máy này. Đóng hẳn Sano Agent, mở lại rồi đăng nhập lại.',
})
const NOT_ALLOWED = Object.freeze({ ok: false, error: TEXT.notAllowed, code: 'not-allowed' })

class AccountError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/**
 * SANO_API_URL / Sano Agent's baked sanoAgent.apiUrl → its origin, or null (unset or refused): `https://host[:port]`,
 * or `http://` on this machine only (127.0.0.1, localhost, [::1]) with an explicit port. No path, query, fragment or
 * userinfo: the value names a server, nothing else.
 */
function accountApiUrl(value) {
  if (typeof value !== 'string' || !value || /[?#\s]/.test(value)) return null
  let u
  try {
    u = new URL(value)
  } catch {
    return null
  }
  if (u.username || u.password || u.pathname !== '/' || !u.hostname) return null
  if (u.protocol === 'https:') return u.origin
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && u.port !== '' ? u.origin : null
}

const base64url = (bytes) => Buffer.from(bytes).toString('base64url')

/** PKCE S256: base64url(SHA-256(verifier)). */
async function codeChallenge(verifier) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

/** The page's input → { field: string } for `names`, or AccountError: strings only, within LIMITS. */
function fields(input, names) {
  const out = {}
  for (const n of names) {
    const v = input && typeof input === 'object' ? input[n] : undefined
    if (typeof v !== 'string' || v.length > LIMITS[n]) throw new AccountError(TEXT.badInput, 'bad-input')
    out[n] = v
  }
  return out
}

/** The server's user → AccountUser (only these fields cross to the page), or null. */
function readUser(u) {
  if (!u || typeof u !== 'object') return null
  const { id, name, email, username, admin } = u
  if (typeof id !== 'string' || typeof name !== 'string' || typeof email !== 'string') return null
  if (!(username === null || typeof username === 'string') || typeof admin !== 'boolean') return null
  return { id, name, email, username, admin }
}

/** { token, expiresAt, user } of POST /api/auth/token or of the session file, or null. */
function readSession(s) {
  if (!s || typeof s !== 'object') return null
  const user = readUser(s.user)
  const ok = typeof s.token === 'string' && /^sano_[\w-]{1,200}$/.test(s.token) && typeof s.expiresAt === 'string' && Number.isFinite(Date.parse(s.expiresAt))
  return ok && user ? { token: s.token, expiresAt: s.expiresAt, user } : null
}

/** The code of a login / google answer `{ redirect }`, when it comes back to REDIRECT_URI with our state; else throws. */
function codeOf(answer, state) {
  let u
  try {
    u = new URL(answer && answer.redirect)
  } catch {
    throw new AccountError(TEXT.invalid, 'bad-answer')
  }
  const code = u.searchParams.get('code')
  if (u.origin + u.pathname !== REDIRECT_URI || u.searchParams.get('state') !== state || !code) throw new AccountError(TEXT.stateMismatch, 'state-mismatch')
  return code
}

/** Main's answer over IPC (Error fields do not cross): { ok: true, value } | { ok: false, error, code? }. */
async function envelope(run, log) {
  try {
    return { ok: true, value: await run() }
  } catch (e) {
    if (e instanceof AccountError) return e.code ? { ok: false, error: e.message, code: e.code } : { ok: false, error: e.message }
    log(`[SanoVids] account: unexpected ${e && e.name}`) // the name only: a message could quote a value
    return { ok: false, error: TEXT.invalid, code: 'failed' }
  }
}

/**
 * fx: { apiUrl (accountApiUrl's origin, or null), fetch(url, init), file, fs: fs.promises-like { readFile, writeFile,
 * rename, rm }, safeStorage: { isEncryptionAvailable, encryptString, decryptString }, now(), random(n) → bytes,
 * google: a createGoogleSignIn of its own { signIn, signOut }, log(line), onSessionEnd(reason) (optional: main's chat
 * Google sign-out and docs windows; reason 'forbidden' when /me answered 403 — the account was turned off — else
 * undefined) }. Every CALLS method answers an envelope; bearer() / ended(token) / userId() are main's own (never over IPC).
 *
 * Invariant (SANO TH-44, docs/SANO-DESKTOP.md §3a): whenever the SANO session ends or changes hands — a sign-out, a
 * session dropped (401/403, expired, a damaged or foreign file), a sign-in for another user than the last one —
 * onSessionEnd runs first, so the chat's Google token of the previous user never serves the next one.
 */
function createAccount(fx) {
  let held = null // { token, expiresAt, user }
  let loaded = null // the session file, read once
  let epoch = 0 // signOut bumps it: a sign-in that finishes after it is dropped
  let cancels = 0 // cancelGoogle bumps it: a Google sign-in still exchanging its token is dropped
  let lastUser = null // id of the last user held: a sign-in for anyone else ends the chat's Google session
  const marker = fx.file + '.forget' // beside a session file a sign-out could neither delete nor empty
  let disk = Promise.resolve() // the session file's writes and deletes, one at a time in call order
  /** fn after every earlier write or delete of the session file: a late one (a renewal signed out) never undoes a newer one. */
  const queued = (fn) => {
    const run = disk.then(fn)
    disk = run.catch(() => undefined)
    return run
  }
  /** fx.onSessionEnd(reason), best effort: its failure never blocks or fails an account call. */
  const endChat = (reason) => {
    try {
      Promise.resolve(fx.onSessionEnd && fx.onSessionEnd(reason)).catch(() => fx.log('[SanoVids] account: chat sign-out failed'))
    } catch {
      fx.log('[SanoVids] account: chat sign-out failed')
    }
  }
  const persistent = () => {
    try {
      return fx.safeStorage.isEncryptionAvailable() === true
    } catch {
      return false
    }
  }
  const status = (s, extra) => ({ configured: !!fx.apiUrl, signedIn: !!s, user: s ? s.user : null, persistent: persistent(), ...extra })

  /** One request, JSON both ways, 20 s, no redirect followed → { ok, status, json } or AccountError (offline / invalid). */
  async function call(method, path, body, token) {
    const headers = { Accept: 'application/json' }
    if (body) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    let res
    try {
      res = await fx.fetch(fx.apiUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      fx.log(`[SanoVids] account server unreachable: ${method} ${path}`)
      throw new AccountError(TEXT.offline, 'offline')
    }
    // 'manual' gives an opaque redirect (status 0) or the 3xx itself: never followed
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new AccountError(TEXT.invalid, 'bad-answer')
    const type = (res.headers && res.headers.get('content-type')) || ''
    let json = null
    if (type.startsWith('application/json')) {
      try {
        json = await res.json()
      } catch {
        // a body cut by the timeout or not JSON: no answer
        throw new AccountError(TEXT.offline, 'offline')
      }
    }
    return { ok: res.ok, status: res.status, json }
  }

  /** POST that must succeed: the server's own Vietnamese error passes through. */
  async function post(path, body) {
    const r = await call('POST', path, body)
    if (r.ok && r.json && typeof r.json === 'object') return r.json
    const e = r.json && typeof r.json.error === 'string' && r.json.error ? r.json.error : TEXT.invalid
    throw new AccountError(e.slice(0, 500), r.json && typeof r.json.code === 'string' ? r.json.code : undefined)
  }

  function configured() {
    if (!fx.apiUrl) throw new AccountError(TEXT.unconfigured, 'not-configured')
  }

  async function load() {
    if (!persistent()) return null
    let bytes
    try {
      bytes = await fx.fs.readFile(fx.file)
    } catch {
      return null // none yet
    }
    let s = null
    try {
      // only a marker surely absent lets the file reopen: one that cannot be read (EACCES…) counts as there
      const forgotten = await fx.fs.readFile(marker).then(() => true, (e) => !(e && e.code === 'ENOENT'))
      if (!forgotten) s = readSession(JSON.parse(fx.safeStorage.decryptString(bytes)))
    } catch {
      // another computer's key, a damaged file: signed out
    }
    if (!s) {
      endChat()
      await queued(remove)
    } else lastUser = s.user.id
    return s
  }

  async function current() {
    if (!loaded) loaded = load().then((s) => (held = held || s))
    await loaded
    return held
  }

  /**
   * Deletes the session file, else empties it (load() refuses empty bytes), else leaves the marker beside it (load()
   * never reopens a file it marks) → true when no session on disk can be reopened.
   */
  async function remove() {
    try {
      await fx.fs.rm(fx.file, { force: true })
      return true
    } catch (e) {
      fx.log(`[SanoVids] account: could not delete the session file (${e && e.code})`)
    }
    try {
      await fx.fs.writeFile(fx.file, Buffer.alloc(0))
      return true
    } catch (e) {
      fx.log(`[SanoVids] account: could not empty the session file (${e && e.code})`)
    }
    try {
      await fx.fs.writeFile(marker, Buffer.alloc(0))
      return true
    } catch (e) {
      fx.log(`[SanoVids] account: could not mark the session file (${e && e.code})`)
      return false
    }
  }

  /** Holds s and writes it; another session it replaces never stays reopenable on disk, else AccountError not-saved. */
  async function save(s) {
    if (s.user.id !== lastUser) endChat()
    lastUser = s.user.id
    const before = held
    held = s
    if (persistent()) await queued(() => write(s, before))
  }

  /** save()'s disk part, queued: the checks of held run once this write has landed. */
  async function write(s, before) {
    try {
      await fx.fs.writeFile(fx.file + '.tmp', fx.safeStorage.encryptString(JSON.stringify(s)))
      await fx.fs.rename(fx.file + '.tmp', fx.file)
      await fx.fs.rm(marker, { force: true }) // the file is this session now, not the one signed out
      // signed out (or replaced) while writing: never leave this token on disk. A renewed copy of s (same token) keeps it
      if (!held || held.token !== s.token) await remove()
    } catch (e) {
      fx.log(`[SanoVids] account: session kept in memory only (${e && e.code})`)
      await Promise.resolve(fx.fs.rm(fx.file + '.tmp', { force: true })).catch(() => undefined) // never leave a token beside the file
      // the file may still hold the session s replaces: a restart would reopen that one (the same session's older copy may stay)
      if ((!before || before.token !== s.token) && !(await remove())) {
        if (held === s) {
          held = before
          lastUser = before ? before.user.id : null
        }
        throw new AccountError(TEXT.notSaved, 'not-saved')
      }
    }
  }

  /** Forgets s, memory first → false only when its token is still in the file. `reason` goes to onSessionEnd. */
  async function clear(s, reason) {
    if (held !== s) return true // signed in again meanwhile
    held = null
    endChat(reason)
    return persistent() ? queued(remove) : true
  }

  /**
   * s is past its saved expiresAt, but SANO slides a desktop session on use (authenticate): /me decides → the session
   * (its later expiresAt saved), or null (ended: 401 / 403 / offline / no later expiresAt, as before the slide).
   */
  async function slid(s) {
    let r = null
    try {
      r = await call('GET', '/api/auth/me', null, s.token)
    } catch {
      /* offline: ended, as before */
    }
    const user = r && r.ok ? readUser(r.json) : null
    const later = user && typeof r.json.expiresAt === 'string' && Date.parse(r.json.expiresAt) > fx.now() ? r.json.expiresAt : null
    if (!later) {
      await clear(s, r && r.status === 403 ? 'forbidden' : undefined)
      return null
    }
    // signed out or replaced meanwhile: the request this renewal serves never gets another session's token. By token, not
    // identity: a renewal of s at the same time (another forward, status()) already holds (and saves) a renewed copy of s
    if (held !== s) return held && held.token === s.token ? held : null
    const n = { ...s, user, expiresAt: later }
    await save(n)
    return held && held.token === s.token ? held : null
  }

  /** login / google: authorize params → code (our state) → token, with a fresh verifier per attempt. */
  async function exchange(path, body, cancelled = () => false) {
    const started = epoch
    const verifier = base64url(fx.random(32))
    const state = base64url(fx.random(32))
    const answer = await post(path, { ...body, client: 'desktop', redirect_uri: REDIRECT_URI, code_challenge: await codeChallenge(verifier), state })
    const code = codeOf(answer, state)
    const s = readSession(await post('/api/auth/token', { code, code_verifier: verifier, redirect_uri: REDIRECT_URI }))
    if (!s) throw new AccountError(TEXT.invalid, 'bad-answer')
    const end = () => call('POST', '/api/auth/logout', {}, s.token).catch(() => undefined) // best effort
    const dropped = () => epoch !== started || cancelled()
    await current() // the file read first: its clean-up never deletes the session written below
    if (!dropped()) {
      try {
        await save(s)
      } catch (e) {
        end()
        throw e
      }
    }
    if (dropped()) {
      // signed out (or Huỷ) while this ran, its file write included: the new session is dropped, and ended on the server too
      const gone = await clear(s)
      end()
      // still in the file (nothing could be deleted, emptied or marked): a restart reopens it, so never 'cancelled'. Held
      // again, as signOut() does, so the page shows it and a sign-out retries
      if (!gone) {
        if (held === null) held = s
        throw new AccountError(TEXT.signOutFailed, 'sign-out-failed')
      }
      if (epoch === started) throw new AccountError(TEXT.googleCancelled, 'cancelled')
      return status(null)
    }
    return status(s)
  }

  const api = {
    async status() {
      if (!fx.apiUrl) return status(null)
      const s = await current()
      if (!s) return status(null)
      if (Date.parse(s.expiresAt) <= fx.now()) {
        await slid(s)
        return status(held)
      }
      let r = null
      try {
        r = await call('GET', '/api/auth/me', null, s.token)
      } catch {
        /* offline */
      }
      // signed out or signed in again while /me ran: its answer is about a session no longer held
      if (held !== s) return status(held)
      if (!r) return status(s, { offline: true })
      // 401: revoked or expired; 403: the account was turned off (the request carries no Origin, the only other 403)
      if (r.status === 401 || r.status === 403) {
        await clear(s, r.status === 403 ? 'forbidden' : undefined)
        return status(held)
      }
      const user = r.ok ? readUser(r.json) : null
      if (!user) return status(s, { offline: true })
      // a desktop session slides on use (SANO authenticate): a later expiresAt is kept with the session
      const later = typeof r.json.expiresAt === 'string' && Date.parse(r.json.expiresAt) > Date.parse(s.expiresAt) ? r.json.expiresAt : s.expiresAt
      if (JSON.stringify(user) !== JSON.stringify(s.user) || later !== s.expiresAt) await save({ ...s, user, expiresAt: later })
      return status(held)
    },
    async login(input) {
      configured()
      return exchange('/api/auth/login', fields(input, ['identifier', 'password']))
    },
    async register(input) {
      configured()
      await post('/api/auth/register', fields(input, ['email', 'username', 'name', 'password']))
      return { ok: true }
    },
    async forgot(input) {
      configured()
      await post('/api/auth/forgot', fields(input, ['identifier']))
      return { ok: true }
    },
    async google() {
      configured()
      const asked = cancels
      const r = await fx.google.signIn()
      // the account keeps its own sano_ session: Google's tokens (refresh token included) are not kept. Only a sign-in
      // that got them drops them: a superseded one would cancel the newer sign-in that replaced it
      if (r && r.ok) fx.google.signOut()
      if (!r || !r.ok) throw new AccountError(r && r.code === 'cancelled' ? TEXT.googleCancelled : (r && r.message) || TEXT.invalid, (r && r.code) || 'failed')
      return exchange('/api/auth/google', { credential: r.idToken }, () => cancels !== asked)
    },
    async cancelGoogle() {
      cancels++
      fx.google.signOut() // a sign-in waiting on the browser ends 'cancelled'
    },
    /** Main only (the SANO API forward, the docs windows): the live session's token, or null. Expiry asks /me, as status(). */
    async bearer() {
      if (!fx.apiUrl) return null
      const s = await current()
      if (!s) return null
      if (Date.parse(s.expiresAt) <= fx.now()) {
        const n = await slid(s)
        return n ? n.token : null
      }
      return s.token
    },
    /** Main only (the docs' Google owner): id of the user whose session is held, or null. */
    userId: () => (held ? held.user.id : null),
    /** Main only: the server refused `token` (401; 403 not-provisioned → reason 'forbidden') → that session ends; a newer one survives. */
    async ended(token, reason) {
      if (held && held.token === token) await clear(held, reason)
    },
    async signOut() {
      endChat() // first, and even with no session held or a sign-out that fails: ending the chat is always safe
      epoch++
      const s = await current()
      fx.google.signOut()
      if (s) {
        const gone = await clear(s)
        const logout = fx.apiUrl ? call('POST', '/api/auth/logout', {}, s.token) : Promise.reject(new Error('no server'))
        // file gone: best effort, never awaited, so an offline sign-out still signs out here
        if (gone) logout.catch(() => undefined)
        // file stuck (Windows lock, nothing writable beside it): an offline restart reopens it even once the server revoked
        // the token, so this is never a sign-out. The logout is still waited on (the token dies when the server is up)
        else {
          if (held === null) held = s // the session stays: signed in meanwhile (a reload, a second click) and after
          await logout.catch(() => undefined)
          throw new AccountError(TEXT.signOutFailed, 'sign-out-failed')
        }
      }
      return status(null)
    },
  }
  /** bearer / ended throw nothing: an unexpected error is logged by name only and answers null. */
  const quiet = (name) => async (...args) => {
    try {
      return await api[name](...args)
    } catch (e) {
      fx.log(`[SanoVids] account: unexpected ${e && e.name}`)
      return null
    }
  }
  // bearer / ended / userId are not in CALLS, so registerAccountIpc never exposes them to a page
  return Object.assign(Object.fromEntries(CALLS.map((name) => [name, (input) => envelope(() => api[name](input), fx.log)])), { bearer: quiet('bearer'), ended: quiet('ended'), userId: api.userId })
}

/** ipcMain.handle('account:<call>') for every call; `allowed(event)` (main's fromSano) is checked on each one. */
function registerAccountIpc(ipcMain, account, allowed) {
  for (const name of CALLS) ipcMain.handle(`account:${name}`, (event, input) => (allowed(event) ? account[name](input) : NOT_ALLOWED))
}

module.exports = {
  TIMEOUT_MS,
  LIMITS,
  REDIRECT_URI,
  CALLS,
  TEXT,
  NOT_ALLOWED,
  accountApiUrl,
  codeChallenge,
  readUser,
  readSession,
  createAccount,
  registerAccountIpc,
}
