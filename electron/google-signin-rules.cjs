// SANO desktop "Đăng nhập bằng Google" (TH-36, docs/SANO-DESKTOP.md §3): Google refuses sign-in inside an app's own
// window (embedded user-agent), so main opens Google's page in the default browser and receives the answer on this
// machine (RFC 8252 loopback: http://127.0.0.1:<random port>/, PKCE S256, state). The ID token goes to SANO's page;
// the refresh token never leaves main's memory (GĐ1: nothing is written to disk).
//
// No require (like the other *-rules.cjs): node:http's createServer, shell.openExternal and net.fetch are injected by
// main.cjs, fakes by src/lib/__tests__/googleSignInRules.test.ts. Google's endpoints are constants: neither the
// environment nor the page can point them elsewhere.
'use strict'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** token() renews the ID token (1 h) once it has less than this left. */
const RENEW_BEFORE_MS = 5 * 60_000
/** A token answer carrying any other scope is refused: the desktop client only ever signs in. */
const SIGN_IN_SCOPES = new Set(['openid', 'email', 'profile', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'])
const CLIENT_ID_RE = /^[\w-]{1,100}\.apps\.googleusercontent\.com$/

const FAIL_TEXT = {
  'not-configured': 'Máy chủ SANO chưa bật đăng nhập Google cho desktop.',
  cancelled: 'Bạn đã hủy đăng nhập.',
  timeout: 'Hết 5 phút chờ đăng nhập. Hãy thử lại.',
  superseded: 'Một lượt đăng nhập mới đã bắt đầu.',
  failed: 'Đăng nhập Google chưa xong. Hãy thử lại.',
}
const fail = (code) => ({ ok: false, code, message: FAIL_TEXT[code] })

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  Connection: 'close',
  'Content-Security-Policy': "default-src 'none'",
  'Referrer-Policy': 'no-referrer',
}
const page = (text) => `<!doctype html><html lang="vi"><meta charset="utf-8"><title>Sano Agent</title><p>${text}</p></html>`
const PAGE_OK = page('Đã đăng nhập. Bạn có thể đóng thẻ này và quay lại Sano Agent.')
const PAGE_FAILED = page('Đăng nhập chưa xong. Bạn có thể đóng thẻ này và thử lại trong Sano Agent.')

function base64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 32 random bytes, base64url (43 characters): the PKCE code_verifier and the state. */
const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

/** PKCE S256: base64url(SHA-256(verifier)). */
async function codeChallenge(verifier) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

function authUrl({ clientId, redirectUri, challenge, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'select_account',
  })
  return `${AUTH_ENDPOINT}?${q}`
}

/**
 * A request to the loopback port → { status: 404 } (another path), { status: 400 } (no / wrong state: keep waiting, so
 * another program probing the port cannot end the sign-in), else the answer that ends it: { code } | { error }.
 */
function readCallback(reqUrl, state) {
  let u
  try {
    u = new URL(String(reqUrl), 'http://127.0.0.1')
  } catch {
    return { status: 400 }
  }
  if (u.pathname !== '/') return { status: 404 }
  if (u.searchParams.get('state') !== state) return { status: 400 }
  const code = u.searchParams.get('code')
  return !code || u.searchParams.has('error') ? { error: u.searchParams.get('error') || 'no-code' } : { code }
}

/** `exp` of a JWT in ms (0 when unreadable). Only read, never verified: SANO's server checks the signature. */
function tokenExpiry(jwt) {
  try {
    const part = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const exp = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), (c) => c.charCodeAt(0)))).exp
    return Number.isFinite(exp) ? exp * 1000 : 0
  } catch {
    return 0
  }
}

/** Google's token answer → { idToken, expiresAt, refreshToken } | null (no usable ID token, or a scope beyond sign-in). */
function readTokenResponse(json, refreshToken) {
  const idToken = json && typeof json.id_token === 'string' ? json.id_token : ''
  const expiresAt = tokenExpiry(idToken)
  const scopes = json && typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : []
  if (!expiresAt || scopes.some((s) => !SIGN_IN_SCOPES.has(s))) return null
  return { idToken, expiresAt, refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : refreshToken }
}

/** googleDesktopClientId of SANO's /api/assistant/status (the page never names the client), or null. */
function desktopClientId(status) {
  const id = status && status.googleDesktopClientId
  return typeof id === 'string' && CLIENT_ID_RE.test(id) ? id : null
}

/**
 * fx: { clientId(): Promise<string|null>, secret?, createServer, openExternal(url), fetch(url, init), focus(), now(),
 * timeoutMs? }. One sign-in at a time: a new one ends the previous ('superseded').
 */
function createGoogleSignIn(fx) {
  let held = null // { idToken, expiresAt, refreshToken, clientId }
  let current = null // ends the sign-in in progress
  let refreshing = null

  async function post(form) {
    const body = new URLSearchParams(fx.secret ? { ...form, client_secret: fx.secret } : form).toString()
    const res = await fx.fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    return { ok: res.ok, json: await res.json().catch(() => ({})) }
  }

  async function signIn() {
    const clientId = await fx.clientId()
    if (!clientId) return fail('not-configured')
    const verifier = randomString()
    const state = randomString()
    const challenge = await codeChallenge(verifier)
    if (current) current(fail('superseded'))
    return new Promise((resolve) => {
      let settled = false
      let consumed = false
      let redirectUri = ''
      const server = fx.createServer((req, res) => void onRequest(req, res))
      const end = (result, closeNow = true) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (current === end) current = null
        if (closeNow) {
          server.close()
          server.closeAllConnections()
        }
        resolve(result)
      }
      const timer = setTimeout(() => end(fail('timeout')), fx.timeoutMs || SIGN_IN_TIMEOUT_MS)
      current = end
      server.on('error', () => end(fail('failed')))
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${server.address().port}/`
        Promise.resolve()
          .then(() => fx.openExternal(authUrl({ clientId, redirectUri, challenge, state })))
          .catch(() => end(fail('failed')))
      })

      async function onRequest(req, res) {
        const r = readCallback(req.url, state)
        if (r.status || consumed) {
          res.writeHead(r.status || 400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
          res.end(r.status === 404 ? 'Not found' : 'Bad request')
          return
        }
        consumed = true
        let result = fail(r.error === 'access_denied' ? 'cancelled' : 'failed')
        if (r.code) {
          try {
            const { json } = await post({ code: r.code, client_id: clientId, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' })
            const t = readTokenResponse(json, null)
            // ended meanwhile (timeout, a newer sign-in): its answer is dropped
            if (t && !settled) {
              held = { ...t, clientId }
              result = { ok: true, idToken: t.idToken }
            }
          } catch {
            // network error: result stays 'failed'
          }
        }
        res.writeHead(200, PAGE_HEADERS)
        res.end(result.ok ? PAGE_OK : PAGE_FAILED, () => server.close())
        if (settled) return
        end(result, false)
        fx.focus()
      }
    })
  }

  async function refresh(h) {
    let answer = null
    try {
      answer = await post({ grant_type: 'refresh_token', refresh_token: h.refreshToken, client_id: h.clientId })
    } catch {
      // no answer (offline): keep the tokens for the next try
    }
    if (held !== h) return held && held.idToken // signed out / in again meanwhile
    // Google answered: a usable ID token or none (invalid_grant incl. invalid_rapt, no id_token) → signed out.
    if (answer && (answer.ok || answer.json.error === 'invalid_grant')) {
      const t = answer.ok ? readTokenResponse(answer.json, h.refreshToken) : null
      held = t && { ...t, clientId: h.clientId }
    }
    return held && held.expiresAt > fx.now() ? held.idToken : null
  }

  /** The ID token, renewed under RENEW_BEFORE_MS (concurrent calls share one refresh), or null: sign in again. */
  async function token() {
    if (!held) return null
    if (held.expiresAt - fx.now() > RENEW_BEFORE_MS) return held.idToken
    if (!held.refreshToken) {
      held = null
      return null
    }
    refreshing = refreshing || refresh(held).finally(() => (refreshing = null))
    return refreshing
  }

  /** Forgets the tokens. No revoke: Google revokes per project, i.e. this person's desktop sign-in on every computer. */
  function signOut() {
    held = null
    return true
  }

  return { signIn, token, signOut }
}

module.exports = {
  AUTH_ENDPOINT,
  TOKEN_ENDPOINT,
  SIGN_IN_TIMEOUT_MS,
  RENEW_BEFORE_MS,
  PAGE_OK,
  PAGE_FAILED,
  codeChallenge,
  authUrl,
  readCallback,
  readTokenResponse,
  desktopClientId,
  createGoogleSignIn,
}
