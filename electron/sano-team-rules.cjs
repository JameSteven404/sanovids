// SANO desktop, TH-38 (docs/SANO-DESKTOP.md "Kết nối canvasapp cho team (QTV)"): the QTV logs the team canvasapp
// account in on canvasapp's own page, in a window of an in-memory partition; main hands that session's canvasapp.io.vn
// cookies to SANO's server (POST SANO_TEAM_SESSION_PATH, the QTV's SANO token) and wipes the partition. The password
// never leaves canvasapp's page; the cookies reach no page, no IPC reply and no log.
//
// Pure: every Electron / network dependency of createSanoTeamConnect is injected (src/providers/__tests__/sanoTeamConnect.test.ts).
'use strict'

const { keptCookieEntry } = require('./keeplogin-rules.cjs')

const SANO_TEAM_PARTITION = 'canvasapp-team'
const SANO_TEAM_SESSION_PATH = '/api/video/admin/canvasapp-session'
const SANO_TEAM_MAX_COOKIES = 30
const SANO_TOKEN_MAX = 8192
const SANO_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
/** The login may take up to SANO_TEAM_LOGIN_MS: the token must still be valid when the session is posted. */
const SANO_TOKEN_MIN_LEFT_MS = 20 * 60_000
const SANO_TEAM_LOGIN_MS = 15 * 60_000
const SANO_TEAM_CHECK_MS = 5000
// What SANO's server refuses in a cookie value (it builds a Cookie header from them).
const BAD_VALUE_RE = /[;\u0000-\u001f\u007f]/

const TEAM_TEXT = Object.freeze({
  'not-allowed': 'Nguồn gọi không hợp lệ.',
  'bad-request': 'Phiên đăng nhập SANO không hợp lệ — đăng nhập lại SANO rồi bấm Kết nối.',
  'token-expiring': 'Phiên đăng nhập SANO sắp hết hạn — đăng nhập lại SANO rồi bấm Kết nối.',
  busy: 'Cửa sổ đăng nhập canvasapp của team đang mở — đăng nhập xong hoặc đóng nó trước.',
  closed: 'Đã đóng cửa sổ canvasapp trước khi đăng nhập xong — chưa kết nối.',
  timeout: 'Quá 15 phút chưa đăng nhập xong canvasapp — chưa kết nối. Bấm Kết nối để thử lại.',
  'no-session': 'canvasapp đã đăng nhập nhưng không có phiên để gửi (thiếu cookie canvas_csrf) — chưa kết nối.',
  network: 'Không nhận được trả lời của máy chủ SANO — bấm “Kiểm tra lại” để xem đã kết nối chưa.',
  error: 'Lỗi khi kết nối tài khoản canvasapp của team — thử lại.',
})

const fail = (code, message = TEAM_TEXT[code]) => ({ ok: false, code, message })

/**
 * The partition's cookies → { v: 1, cookies } for SANO's server, or null (none, or more than 30). canvasapp.io.vn's own
 * cookies only, by keep-login's rules (no Cloudflare, no other host, prefix rules), session cookies AND persistent ones
 * not expired yet (with their expirationDate, seconds); values SANO refuses (`;`, controls) are dropped.
 */
function teamSessionPayload(cookies, host, now) {
  const out = []
  for (const c of Array.isArray(cookies) ? cookies : []) {
    if (!c || typeof c !== 'object') continue
    const persistent = c.session !== true
    if (persistent && !(Number.isFinite(c.expirationDate) && c.expirationDate * 1000 > now)) continue
    const e = keptCookieEntry({ ...c, session: true, expirationDate: undefined }, host)
    if (!e || BAD_VALUE_RE.test(e.value)) continue
    out.push(persistent ? { ...e, expirationDate: c.expirationDate } : e)
  }
  return out.length > 0 && out.length <= SANO_TEAM_MAX_COOKIES ? { v: 1, cookies: out } : null
}

/** A Google ID token's shape and `exp` → null (usable for the whole login), else the failure. */
function tokenProblem(token, now) {
  if (typeof token !== 'string' || token.length > SANO_TOKEN_MAX || !SANO_TOKEN_RE.test(token)) return fail('bad-request')
  let exp
  try {
    exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp
  } catch {
    return fail('bad-request')
  }
  if (!Number.isFinite(exp)) return fail('bad-request')
  return exp * 1000 - now < SANO_TOKEN_MIN_LEFT_MS ? fail('token-expiring') : null
}

/** SANO's own error text ({ error }), plain and short; else its status code. */
function sanoRefusal(status, json) {
  const text = json && typeof json.error === 'string' ? json.error.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) : ''
  return fail('sano-refused', text || `Máy chủ SANO từ chối (mã ${status}) — chưa kết nối.`)
}

/**
 * deps: { now(), host, clear(), open({ onNavigate, onClosed }) → { close() }, authenticated() → boolean,
 * cookies() → Electron cookies, post(payload, token) → { status, json } (throws when SANO cannot be reached) }.
 * → connect(token) → { ok: true, status } | { ok: false, code, message }. One at a time; the partition is cleared before
 * the window opens and after every outcome (never a logout: that would end the session just handed to SANO).
 */
function createSanoTeamConnect(deps) {
  let busy = false
  return async function connect(token) {
    const bad = tokenProblem(token, deps.now())
    if (bad) return bad
    if (busy) return fail('busy')
    busy = true
    let win = null
    try {
      await deps.clear()
      const outcome = await new Promise((resolve) => {
        let checking = false
        let timer, timeout
        // the first outcome wins (resolve ignores the later ones)
        const end = (v) => {
          clearInterval(timer)
          clearTimeout(timeout)
          resolve(v)
        }
        const check = async () => {
          if (checking) return
          checking = true
          try {
            if (await deps.authenticated()) end('ok')
          } catch {
            /* not logged in yet */
          } finally {
            checking = false
          }
        }
        timer = setInterval(() => void check(), SANO_TEAM_CHECK_MS)
        timeout = setTimeout(() => end('timeout'), SANO_TEAM_LOGIN_MS)
        win = deps.open({ onNavigate: () => void check(), onClosed: () => end('closed') })
      })
      if (outcome !== 'ok') return fail(outcome)
      const payload = teamSessionPayload(await deps.cookies(), deps.host, deps.now())
      if (!payload || !payload.cookies.some((c) => c.name === 'canvas_csrf')) return fail('no-session')
      let res
      try {
        res = await deps.post(payload, token)
      } catch {
        return fail('network')
      }
      return res.status === 200 ? { ok: true, status: res.json && typeof res.json === 'object' ? res.json : null } : sanoRefusal(res.status, res.json)
    } finally {
      if (win) win.close()
      try {
        await deps.clear()
      } catch {
        /* in-memory partition: what a failed wipe leaves ends when the app quits */
      }
      busy = false
    }
  }
}

module.exports = {
  SANO_TEAM_PARTITION,
  SANO_TEAM_SESSION_PATH,
  SANO_TEAM_LOGIN_MS,
  SANO_TEAM_CHECK_MS,
  TEAM_TEXT,
  teamSessionPayload,
  createSanoTeamConnect,
}
