// Sano Agent's SANO API forward (SANO TH-44 step 4, docs/SANO-DESKTOP.md §3): SANO's page calls /api/assistant/* with
// relative URLs, so in the app it asks app://sano/api/assistant/*; main.cjs's serveDist hands those requests here, and
// they go to SANO_API_URL with `Authorization: Bearer sano_…` of the account session. The token never reaches the page.
//
// protocol.handle gives no sender frame (main's fromSano cannot run), and main adds the bearer itself, so the caller is
// checked on the request: SANO's own httpClient sets `X-Sano-Client: desktop`, which navigations, forms, <img> and
// no-cors fetches cannot send. None of the page's headers go to the server.
//
// No require (like the other *-rules.cjs): fetch, the account ({ bearer, ended } of sano-account-rules) and log are
// injected by main.cjs, fakes by src/lib/__tests__/sanoApiRules.test.ts. Nothing here logs a token, a query or a body.
'use strict'

/** The SANO server's own body cap (server/http.ts). */
const MAX_BODY = 80_000
/** The page gives up at 70 s (web/assistant-client.ts); a chat turn can take that long. */
const TIMEOUT_MS = 75_000
const PATH = /^\/api\/assistant(?:\/[A-Za-z0-9._~-]+)+$/
/** A top-level GET from Google with side effects (server/http.ts): never reached through the page. */
const GOOGLE_CALLBACK = '/api/assistant/google/callback'

/** code → [status, Vietnamese error] of every answer the forward gives itself. */
const REFUSALS = Object.freeze({
  'not-found': [404, 'Không có API này.'],
  'bad-method': [405, 'Phương thức không được hỗ trợ.'],
  'not-allowed': [403, 'Nguồn gọi không hợp lệ.'],
  'bad-type': [415, 'Yêu cầu phải là JSON.'],
  'signed-out': [401, 'Chưa đăng nhập tài khoản SANO.'],
  'too-large': [413, 'Yêu cầu quá lớn.'],
  timeout: [503, 'Máy chủ SANO chưa trả lời. Thử lại sau.'],
  offline: [503, 'Không kết nối được máy chủ SANO. Kiểm tra mạng rồi thử lại.'],
  'bad-answer': [502, 'Máy chủ SANO trả lời không hợp lệ.'],
})

const JSON_TYPE = 'application/json; charset=utf-8'

/** request.body → bytes, or null once more than MAX_BODY arrived (reading stops there). */
async function readBody(stream) {
  if (!stream) return undefined
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks)
    total += value.byteLength
    if (total > MAX_BODY) {
      reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
}

/**
 * fx: { apiUrl (accountApiUrl's origin), fetch(url, init), account: { bearer() → token | null, ended(token) }, log(line) }
 * → { forward(request, url) → Response }, url being the request's parsed URL (app://sano/api/…).
 */
function createApiForward(fx) {
  let toldNoFetchMetadata = false
  return {
    async forward(request, url) {
      const method = request.method
      const path = url.pathname
      const refuse = (code) => {
        fx.log(`[SanoVids] sano api: ${method} ${path.slice(0, 200)} → ${code}`)
        const [status, error] = REFUSALS[code]
        return new Response(JSON.stringify({ error, code }), { status, headers: { 'content-type': JSON_TYPE, 'cache-control': 'no-store' } })
      }
      // raw pathname: URL parsing already resolved dot segments; '%' (an encoded '/' or '.') is refused by PATH itself
      if (!PATH.test(path) || path.split('/').some((s) => s === '.' || s === '..') || path === GOOGLE_CALLBACK || url.search.length > 4096) return refuse('not-found')
      // OPTIONS too: a cross-origin preflight fails here
      if (method !== 'GET' && method !== 'POST') return refuse('bad-method')
      const h = request.headers
      const origin = h.get('origin')
      const dest = h.get('sec-fetch-dest')
      const site = h.get('sec-fetch-site')
      if (h.get('x-sano-client') !== 'desktop' || (origin !== null && origin !== 'app://sano') || (dest !== null && dest !== 'empty') || (site !== null && site !== 'same-origin')) return refuse('not-allowed')
      if (dest === null && site === null && !toldNoFetchMetadata) {
        toldNoFetchMetadata = true
        fx.log('[SanoVids] sano api: no sec-fetch metadata')
      }
      if (method === 'POST' && !(h.get('content-type') || '').toLowerCase().startsWith('application/json')) return refuse('bad-type')
      const token = await fx.account.bearer()
      // the server answers status before any auth check: signed out, the page still learns the server is up, so its next
      // httpClient call gets this 401 and shows the sign-in screen instead of "server offline"
      if (!token && !(method === 'GET' && path === '/api/assistant/status')) return refuse('signed-out')
      let body
      if (method === 'POST') {
        if (Number(h.get('content-length')) > MAX_BODY) return refuse('too-large')
        body = await readBody(request.body)
        if (body === null) return refuse('too-large')
      }
      const headers = token ? { Accept: 'application/json', Authorization: `Bearer ${token}` } : { Accept: 'application/json' }
      if (method === 'POST') headers['Content-Type'] = 'application/json'
      let res
      try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean))
        res = await fx.fetch(fx.apiUrl + path + url.search, { method, headers, body, redirect: 'manual', signal })
      } catch (e) {
        return refuse(e && e.name === 'TimeoutError' ? 'timeout' : 'offline')
      }
      const type = res.headers.get('content-type') || ''
      // 'manual' gives an opaque redirect (status 0) or the 3xx itself: never followed
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || !type.toLowerCase().startsWith('application/json')) return refuse('bad-answer')
      // the session is over on the server (revoked, expired, account turned off): end it here too; other 403s are scope checks
      // 'forbidden' (turned off) also wipes the docs' kept Google sign-in, as a /me 403 does
      if (token && (res.status === 401 || (res.status === 403 && (await res.clone().json().catch(() => null))?.code === 'not-provisioned'))) await fx.account.ended(token, res.status === 403 ? 'forbidden' : undefined)
      const back = { 'content-type': type, 'cache-control': 'no-store' }
      const retry = res.headers.get('retry-after')
      if (retry) back['retry-after'] = retry
      return new Response(res.body, { status: res.status, headers: back })
    },
  }
}

module.exports = { MAX_BODY, TIMEOUT_MS, REFUSALS, createApiForward }
