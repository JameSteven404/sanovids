// SanoVids — desktop shell (Electron).
// Serves the built web app (dist/) through a privileged custom protocol app://bdp/ so the page has a stable,
// secure origin: IndexedDB / localStorage persist between launches exactly like on the web.
'use strict'

const { app, BrowserWindow, Menu, ipcMain, protocol, session, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SCHEME = 'app'
const HOST = 'bdp'
const ORIGIN = `${SCHEME}://${HOST}`
const DIST = path.join(__dirname, '..', 'dist')
const TITLE = 'SanoVids'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

// Same data folder for `npm run desktop`, the installer and the portable .exe (ASCII, independent of the
// product name), so projects survive updates and switching between the two builds.
app.setPath('userData', path.join(app.getPath('appData'), 'SanoVids'))
app.setAppUserModelId('com.sanovids.app')

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    protocol.handle(SCHEME, serveDist)
    registerCanvasappGateway()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

/** app://bdp/<path> → dist/<path>. Unknown paths without an extension fall back to index.html (SPA). */
async function serveDist(request) {
  let url
  try {
    url = new URL(request.url)
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (url.host !== HOST) return new Response('Not found', { status: 404 })
  let rel
  try {
    rel = decodeURIComponent(url.pathname)
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (rel === '/' || rel === '') rel = '/index.html'
  const file = path.normalize(path.join(DIST, rel))
  // never serve anything outside dist/
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 })

  const ext = path.extname(file).toLowerCase()
  try {
    const body = await fs.promises.readFile(file)
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': MIME[ext] || 'application/octet-stream',
        // hashed assets never change; index.html must always be fresh after an app update
        'cache-control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    })
  } catch {
    if (!ext) {
      const index = await fs.promises.readFile(path.join(DIST, 'index.html')).catch(() => null)
      if (index) return new Response(index, { status: 200, headers: { 'content-type': MIME['.html'] } })
    }
    return new Response('Not found', { status: 404 })
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: TITLE,
    backgroundColor: '#0f1012',
    autoHideMenuBar: true,
    icon: path.join(DIST, 'icons', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      additionalArguments: [`--bdp-version=${app.getVersion()}`],
    },
  })

  win.once('ready-to-show', () => {
    win.maximize()
    win.show()
  })

  const { webContents } = win

  // No application menu → re-add the developer shortcuts we still want.
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if ((input.control || input.meta) && input.shift && key === 'i') {
      webContents.toggleDevTools()
      event.preventDefault()
    } else if (key === 'f12') {
      webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  // External links open in the default browser; the window itself never leaves the app origin.
  webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(ORIGIN + '/')) return
    event.preventDefault()
    if (isExternal(url)) void shell.openExternal(url)
  })

  // Downloads (Tải video, .zip, export) go straight to the Downloads folder without a save dialog,
  // with " (2)", " (3)"… appended instead of overwriting an existing file. The renderer is told (bdp:downloaded) when a file is saved.
  webContents.session.on('will-download', (_event, item) => {
    const dir = app.getPath('downloads')
    const parsed = path.parse(item.getFilename())
    let target = path.join(dir, parsed.base)
    for (let i = 2; fs.existsSync(target) && i < 1000; i++) target = path.join(dir, `${parsed.name} (${i})${parsed.ext}`)
    item.setSavePath(target)
    item.once('done', (_e, state) => {
      if (state === 'completed' && !webContents.isDestroyed()) webContents.send('bdp:downloaded', target)
    })
  })

  void win.loadURL(`${ORIGIN}/index.html`)
  return win
}

function isExternal(url) {
  return /^(https?:|mailto:)/i.test(url)
}

// ---------------------------------------------------------------------------------------------------------------
// canvasapp.io.vn gateway (experimental, OFF by default — see docs/GATEWAY-CANVASAPP.md)
//
// The user logs in on canvasapp's OWN page, in a separate window that uses its own persistent session partition.
// SanoVids never sees the password or the cookies: the renderer can only ask the main process to call a short
// allowlist of canvasapp endpoints through that session. The main process adds the X-CSRF-Token header from the
// partition's canvas_csrf cookie (exactly what canvasapp's own page does), keeps concurrency low and caches the job
// list so it is never fetched more than once every 15 s. No Origin/Referer spoofing, no Cloudflare workarounds.
// ---------------------------------------------------------------------------------------------------------------

const CANVASAPP_ORIGIN = 'https://canvasapp.io.vn'
const CANVASAPP_PARTITION = 'persist:canvasapp'
const CANVASAPP_MAX_PARALLEL = 2
const CANVASAPP_JOBS_MIN_MS = 15_000

// <canvasapp-routes> (pure; src/providers/__tests__/canvasapp-e2e.test.ts runs this block as-is: every request the gateway sends must pass it)
const CANVASAPP_MAX_JSON_BYTES = 2 * 1024 * 1024
const CANVASAPP_MAX_UPLOAD_BYTES = 20 * 1024 * 1024
/** Ids in paths (project / job / order ids; canvasapp's are UUIDs). */
const CANVASAPP_ID = '[A-Za-z0-9_-]{1,80}'
const CANVASAPP_ID_RE = new RegExp(`^${CANVASAPP_ID}$`)

/** Allowed endpoints: method + exact path pattern (+ allowed query keys). Anything else is refused. */
const CANVASAPP_ROUTES = [
  { methods: ['GET'], path: /^\/api\/me$/ },
  { methods: ['GET'], path: /^\/api\/auth\/state$/ },
  { methods: ['GET'], path: /^\/api\/video-profiles$/ },
  // POST without a body creates a project ("Phiên mới"); PATCH {name} names it — exactly what canvasapp's page does.
  { methods: ['GET', 'POST'], path: /^\/api\/projects$/ },
  { methods: ['GET', 'PATCH'], path: new RegExp(`^/api/projects/${CANVASAPP_ID}$`) },
  { methods: ['PUT'], path: new RegExp(`^/api/projects/${CANVASAPP_ID}/canvas$`) },
  { methods: ['POST'], path: /^\/api\/uploads\/images$/, multipart: true },
  { methods: ['GET'], path: /^\/api\/video-jobs$/, query: ['project_id'] },
  { methods: ['POST'], path: /^\/api\/video-jobs$/ },
  { methods: ['GET'], path: new RegExp(`^/api/video-jobs/${CANVASAPP_ID}/prompt$`) },
  { methods: ['GET'], path: new RegExp(`^/api/video-jobs/${CANVASAPP_ID}/stream$`), binary: true },
  { methods: ['DELETE'], path: new RegExp(`^/api/video-jobs/${CANVASAPP_ID}$`) },
  // Top-up (Nạp credit, docs/SPEC-v2.md §10). Creating an order moves no money: paying happens on SePay, by the user.
  { methods: ['POST'], path: /^\/api\/payments\/topups$/ },
  { methods: ['GET'], path: new RegExp(`^/api/payments/topups/${CANVASAPP_ID}$`) },
  {
    methods: ['GET'],
    path: /^\/api\/credits\/history$/,
    query: ['kind', 'offset', 'limit'],
    queryValues: { kind: /^(all|topup|video|refund|adjustment)$/, offset: /^\d{1,6}$/, limit: /^\d{1,3}$/ },
  },
]

function matchCanvasappRoute(method, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/api/') || rawPath.length > 300) return null
  let url
  try {
    url = new URL(rawPath, CANVASAPP_ORIGIN)
  } catch {
    return null
  }
  if (url.origin !== CANVASAPP_ORIGIN || url.hash) return null
  const route = CANVASAPP_ROUTES.find((r) => r.methods.includes(method) && r.path.test(url.pathname))
  if (!route) return null
  const seen = new Set()
  for (const [key, value] of url.searchParams) {
    if (!(route.query || []).includes(key) || seen.has(key)) return null
    seen.add(key)
    const re = (route.queryValues && route.queryValues[key]) || CANVASAPP_ID_RE
    if (!re.test(value)) return null
  }
  return { route, url }
}
// </canvasapp-routes>

let canvasappLoginWin = null
let canvasappLoginPromise = null
let canvasappActive = 0
const canvasappWaiters = []
const canvasappJobListCache = new Map() // query string -> { at, result }
/** Bumped by every POST /api/video-jobs: a job list read that started before it is never cached. */
let canvasappJobsEpoch = 0

function canvasappSession() {
  return session.fromPartition(CANVASAPP_PARTITION)
}

/** Only the SanoVids page itself (app://bdp/…) may use the gateway. */
function fromApp(event) {
  const url = (event.senderFrame && event.senderFrame.url) || ''
  return url.startsWith(ORIGIN + '/')
}

function gatewayError(code, message) {
  return { ok: false, code, message }
}

async function withCanvasappSlot(fn) {
  while (canvasappActive >= CANVASAPP_MAX_PARALLEL) await new Promise((resolve) => canvasappWaiters.push(resolve))
  canvasappActive++
  try {
    return await fn()
  } finally {
    canvasappActive--
    const next = canvasappWaiters.shift()
    if (next) next()
  }
}

async function canvasappCsrf() {
  const cookies = await canvasappSession().cookies.get({ url: CANVASAPP_ORIGIN, name: 'canvas_csrf' })
  return cookies[0] ? cookies[0].value : null
}

function multipartBody(form) {
  const boundary = '----SanoVids' + Math.random().toString(16).slice(2) + Date.now().toString(16)
  const filename = String(form.filename || 'image.png').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100)
  const field = String(form.field || 'file').replace(/[^A-Za-z0-9_-]/g, '_')
  const type = /^image\/(png|jpeg|webp)$/.test(form.contentType) ? form.contentType : 'application/octet-stream'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return { body: Buffer.concat([head, Buffer.from(form.bytes), tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** One allowlisted request through the canvasapp partition. Never throws: returns { ok:false, code, message }. */
async function canvasappRequest(req) {
  if (!req || typeof req !== 'object') return gatewayError('bad-request', 'Yêu cầu không hợp lệ.')
  const method = String(req.method || 'GET').toUpperCase()
  const match = matchCanvasappRoute(method, req.path)
  if (!match) return gatewayError('not-allowed', `SanoVids không được phép gọi ${method} ${String(req.path).slice(0, 80)}.`)
  const { route, url } = match

  // Job list: at most once every 15 s per project, whatever the renderer asks.
  const cacheKey = method === 'GET' && url.pathname === '/api/video-jobs' ? url.search : null
  if (cacheKey !== null) {
    const hit = canvasappJobListCache.get(cacheKey)
    if (hit && Date.now() - hit.at < CANVASAPP_JOBS_MIN_MS) return hit.result
  }

  const headers = { Accept: route.binary ? 'video/mp4,*/*' : 'application/json' }
  let body
  if (method !== 'GET') {
    const csrf = await canvasappCsrf()
    if (csrf) headers['X-CSRF-Token'] = csrf
  }
  if (route.multipart) {
    const f = req.form
    if (!f || !(f.bytes instanceof Uint8Array)) return gatewayError('bad-request', 'Thiếu file ảnh.')
    if (f.bytes.byteLength > CANVASAPP_MAX_UPLOAD_BYTES) return gatewayError('too-large', 'Ảnh lớn hơn 20 MB.')
    const mp = multipartBody(f)
    body = mp.body
    headers['Content-Type'] = mp.contentType
  } else if (req.json !== undefined && method !== 'GET' && method !== 'DELETE') {
    body = JSON.stringify(req.json)
    if (Buffer.byteLength(body) > CANVASAPP_MAX_JSON_BYTES) return gatewayError('too-large', 'Dữ liệu gửi đi quá lớn.')
    headers['Content-Type'] = 'application/json'
  }

  // A new job changes the list: whatever the outcome (even a lost answer, when the job may exist), the next read of
  // the job list must come from canvasapp — SanoVids looks for the job there before posting it again.
  const createsJob = method === 'POST' && url.pathname === '/api/video-jobs'
  if (createsJob) {
    canvasappJobsEpoch++
    canvasappJobListCache.clear()
  }
  const epoch = canvasappJobsEpoch
  const controller = new AbortController()
  let timer = null
  try {
    const result = await withCanvasappSlot(async () => {
      // The clock starts when the request is really sent, not while it waits for a slot (e.g. behind two video
      // downloads): a timeout then means canvasapp did not answer, never "not sent yet".
      timer = setTimeout(() => controller.abort(), route.binary ? 10 * 60_000 : 60_000)
      const res = await canvasappSession().fetch(url.toString(), {
        method,
        headers,
        body,
        credentials: 'include',
        redirect: 'follow',
        signal: controller.signal,
        bypassCustomProtocolHandlers: true,
      })
      const contentType = res.headers.get('content-type') || ''
      const out = { ok: true, status: res.status, contentType }
      if (route.binary && res.ok) {
        out.bytes = new Uint8Array(await res.arrayBuffer())
      } else {
        const text = await res.text()
        if (/json/i.test(contentType)) {
          try {
            out.json = JSON.parse(text)
          } catch {
            out.text = text.slice(0, 2000)
          }
        } else {
          out.text = text.slice(0, 2000)
        }
      }
      return out
    })
    if (cacheKey !== null && result.status === 200 && epoch === canvasappJobsEpoch) canvasappJobListCache.set(cacheKey, { at: Date.now(), result })
    return result
  } catch (e) {
    const aborted = e && e.name === 'AbortError'
    return gatewayError('network', aborted ? 'canvasapp.io.vn không phản hồi (quá thời gian chờ).' : `Không kết nối được tới canvasapp.io.vn (${(e && e.message) || e}).`)
  } finally {
    if (timer) clearTimeout(timer)
    if (createsJob) {
      canvasappJobsEpoch++
      canvasappJobListCache.clear()
    }
  }
}

async function canvasappStatus() {
  const res = await canvasappRequest({ method: 'GET', path: '/api/auth/state' })
  if (!res.ok) return res
  if (res.status === 401) return { ok: true, authenticated: false }
  if (res.status !== 200 || !res.json || typeof res.json !== 'object') {
    return gatewayError('bad-response', `canvasapp.io.vn trả về mã ${res.status}.`)
  }
  return { ok: true, authenticated: res.json.authenticated === true }
}

function canvasappLogin(parent) {
  if (canvasappLoginWin && !canvasappLoginWin.isDestroyed()) {
    canvasappLoginWin.show()
    canvasappLoginWin.focus()
    return canvasappLoginPromise
  }
  canvasappLoginPromise = (async () => {
    const before = await canvasappStatus()
    if (before.ok && before.authenticated) return before

    const webPreferences = { partition: CANVASAPP_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
    const win = new BrowserWindow({
      width: 1120,
      height: 840,
      parent: parent || undefined,
      title: 'Đăng nhập canvasapp.io.vn — SanoVids',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences,
    })
    canvasappLoginWin = win
    // Sign-in popups (e.g. Google) stay in the same partition so the session ends up there.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) return { action: 'allow', overrideBrowserWindowOptions: { parent: win, autoHideMenuBar: true, webPreferences } }
      return { action: 'deny' }
    })

    return await new Promise((resolve) => {
      let done = false
      let checking = false
      const finish = async (closeWindow) => {
        if (done) return
        done = true
        clearInterval(timer)
        const st = await canvasappStatus()
        if (closeWindow && !win.isDestroyed()) win.close()
        resolve(st)
      }
      const check = async () => {
        if (done || checking) return
        checking = true
        try {
          const st = await canvasappStatus()
          if (st.ok && st.authenticated) void finish(true)
        } finally {
          checking = false
        }
      }
      const timer = setInterval(() => void check(), 5000)
      win.webContents.on('did-navigate', () => void check())
      win.webContents.on('did-navigate-in-page', () => void check())
      win.on('closed', () => {
        if (canvasappLoginWin === win) canvasappLoginWin = null
        void finish(false)
      })
      void win.loadURL(CANVASAPP_ORIGIN + '/')
    })
  })()
  return canvasappLoginPromise
}

async function canvasappLogout() {
  if (canvasappLoginWin && !canvasappLoginWin.isDestroyed()) canvasappLoginWin.close()
  if (checkoutWin && !checkoutWin.isDestroyed()) checkoutWin.close()
  const ses = canvasappSession()
  await ses.clearStorageData()
  await ses.clearCache()
  canvasappJobListCache.clear()
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------------------------
// Top-up checkout (Nạp credit) — docs/SPEC-v2.md §10, docs/GATEWAY-CANVASAPP.md "Nạp credit".
//
// The renderer got { checkout_url, fields } from canvasapp (POST /api/payments/topups). Main re-validates the URL
// (never trusts the renderer), then opens ONE modal window in the canvasapp partition that shows a tiny local page
// which POSTs those fields to the checkout URL — exactly what canvasapp's own page does with its hidden form. The
// user pays on the REAL SePay page (QR / bank app) by themselves. SanoVids injects no script into SePay, fills
// nothing, never sees bank data and never confirms anything: when the window comes back to canvasapp.io.vn with
// ?payment=…&topup_order=… the result is handed to the renderer, which then asks canvasapp for the order status.
// ---------------------------------------------------------------------------------------------------------------

// <checkout-rules> (pure; src/providers/__tests__/canvasapp-topup.test.ts runs this block as-is)
const CHECKOUT_HOST_SUFFIX = 'sepay.vn'
const CHECKOUT_TIMEOUT_MS = 15 * 60_000
const CHECKOUT_MAX_FIELDS = 60
const CHECKOUT_MAX_VALUE = 4000
const CHECKOUT_FIELD_NAME_RE = /^[A-Za-z0-9_.[\]-]{1,100}$/
const CHECKOUT_ODD_CHARS_RE = /[\s\u0000-\u001f\u007f\\]/ // the URL parser would silently drop / reinterpret these

let checkoutWin = null

/** Same rules as src/core/topup.ts parseHttps — keep in sync. */
function parseStrictHttps(raw) {
  if (typeof raw !== 'string' || raw.length > 4000 || CHECKOUT_ODD_CHARS_RE.test(raw) || !/^https:\/\//i.test(raw)) return null
  let u
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '') return null
  return u
}

function isCheckoutHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === CHECKOUT_HOST_SUFFIX || host.endsWith('.' + CHECKOUT_HOST_SUFFIX)
}

/** Same rules as src/core/topup.ts checkoutUrlAllowed — keep in sync. */
function checkoutUrlAllowed(raw) {
  const u = parseStrictHttps(raw)
  return !!u && isCheckoutHost(u.hostname)
}

/** Same rules as src/core/topup.ts parsePaymentReturn — keep in sync. → { result, orderId } | null */
function parsePaymentReturn(raw) {
  const u = parseStrictHttps(raw)
  if (!u || u.hostname.toLowerCase() !== new URL(CANVASAPP_ORIGIN).hostname) return null
  const payment = u.searchParams.get('payment')
  const orderId = u.searchParams.get('topup_order')
  if (payment === null || orderId === null || !CANVASAPP_ID_RE.test(orderId)) return null
  const p = payment.trim().toLowerCase()
  return { result: p === 'success' || p === 'cancel' ? p : 'error', orderId }
}

/** { name: value } from the renderer → [[name, value]] or null when anything looks wrong. */
function checkoutFieldList(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null
  const entries = Object.entries(fields)
  if (entries.length > CHECKOUT_MAX_FIELDS) return null
  const out = []
  for (const [name, value] of entries) {
    if (!CHECKOUT_FIELD_NAME_RE.test(name)) return null
    if (typeof value !== 'string' || value.length > CHECKOUT_MAX_VALUE) return null
    out.push([name, value])
  }
  return out
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c])
}

/** Local page that auto-submits the checkout form (POST). Everything injected is HTML-escaped; CSP pins the script. */
function checkoutPageUrl(checkoutUrl, fieldList) {
  const script = "document.getElementById('f').submit()"
  const hash = crypto.createHash('sha256').update(script, 'utf8').digest('base64')
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'sha256-${hash}'`,
    // Chromium also checks form-action on the POST's redirects: SePay may bounce straight back to canvasapp.
    `form-action https://${CHECKOUT_HOST_SUFFIX} https://*.${CHECKOUT_HOST_SUFFIX} ${CANVASAPP_ORIGIN}`,
    "base-uri 'none'",
  ].join('; ')
  const inputs = fieldList.map(([n, v]) => `<input type="hidden" name="${escapeHtml(n)}" value="${escapeHtml(v)}">`).join('')
  const html =
    '<!doctype html><html lang="vi"><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">` +
    '<meta name="referrer" content="no-referrer"><title>Thanh toán nạp credit</title>' +
    '<style>html{color-scheme:light dark}body{font:14px "Segoe UI",system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}' +
    'form{text-align:center}button{font:inherit;padding:8px 16px;border-radius:8px;margin-top:12px;cursor:pointer}</style></head><body>' +
    `<form id="f" method="POST" action="${escapeHtml(checkoutUrl)}" accept-charset="UTF-8">${inputs}` +
    '<p>Đang mở trang thanh toán SePay…</p><button type="submit">Tiếp tục tới trang thanh toán</button></form>' +
    `<script>${script}</script></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

/** Hostname for diagnostics ("evil.com", "intent", …) — never the full URL (it may carry order data). */
function navigationHost(raw) {
  try {
    const u = new URL(String(raw))
    return (u.hostname || u.protocol.replace(/:$/, '') || 'url').slice(0, 80)
  } catch {
    return 'url'
  }
}

/**
 * Main-frame navigation policy of the checkout window.
 *   { kind: 'return', ret }  back on canvasapp with ?payment=…&topup_order=… → finish (the page is not loaded);
 *   { kind: 'allow' }        SePay family or canvasapp itself (strict https, no userinfo / port);
 *   { kind: 'deny', host }   anything else: other sites, http:, bank deep links (xxx://), data:, about:, file:.
 */
function classifyCheckoutNavigation(raw) {
  const ret = parsePaymentReturn(raw)
  if (ret) return { kind: 'return', ret }
  const u = parseStrictHttps(raw)
  if (u && (isCheckoutHost(u.hostname) || u.origin === CANVASAPP_ORIGIN)) return { kind: 'allow' }
  return { kind: 'deny', host: navigationHost(raw) }
}

/** window.open from the payment page: only SePay / canvasapp links go to the default browser (nothing else leaves). */
function checkoutExternalAllowed(raw) {
  const u = parseStrictHttps(raw)
  return !!u && (isCheckoutHost(u.hostname) || u.origin === CANVASAPP_ORIGIN)
}

/** Web permissions for the checkout window: only "copy" (account number / amount buttons on SePay). */
function checkoutPermissionAllowed(permission) {
  return permission === 'clipboard-sanitized-write'
}

/** Web permissions the canvasapp login window (and its sign-in popups) never needs: denied. Others keep Electron's default. */
const CANVASAPP_DENIED_PERMISSIONS = new Set([
  'media',
  'geolocation',
  'notifications',
  'midi',
  'midiSysex',
  'pointerLock',
  'keyboardLock',
  'openExternal',
  'display-capture',
  'hid',
  'serial',
  'usb',
  'idle-detection',
  'window-management',
  'speaker-selection',
  'mediaKeySystem',
])

// </checkout-rules>

/**
 * canvasapp:checkout → { ok: true, result: 'success'|'cancel'|'error'|'closed'|'timeout', orderId, blockedHost }
 *                    | { ok: false, code, message }
 */
function canvasappCheckout(parent, args) {
  if (checkoutWin && !checkoutWin.isDestroyed()) {
    checkoutWin.show()
    checkoutWin.focus()
    return Promise.resolve(gatewayError('busy', 'Đang có một cửa sổ thanh toán mở — hoàn tất hoặc đóng nó trước.'))
  }
  const checkoutUrl = args && typeof args === 'object' ? args.checkoutUrl : null
  if (!checkoutUrlAllowed(checkoutUrl)) {
    return Promise.resolve(gatewayError('refused', 'Trang thanh toán không phải SePay (https://…sepay.vn) — SanoVids không mở.'))
  }
  const fieldList = checkoutFieldList(args.fields)
  if (!fieldList) return Promise.resolve(gatewayError('bad-request', 'Dữ liệu đơn nạp không hợp lệ.'))

  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    minWidth: 420,
    minHeight: 520,
    parent: parent || undefined,
    modal: !!parent,
    title: 'Thanh toán nạp credit',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: CANVASAPP_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  })
  checkoutWin = win
  win.setMenu(null)
  const wc = win.webContents

  return new Promise((resolve) => {
    let done = false
    let blockedHost = null
    const finish = (result, orderId) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (checkoutWin === win) checkoutWin = null
      // close after the current navigation event has returned
      setImmediate(() => {
        if (!win.isDestroyed()) win.close()
      })
      resolve({ ok: true, result, orderId: orderId || null, blockedHost })
    }
    const timer = setTimeout(() => finish('timeout', null), CHECKOUT_TIMEOUT_MS)

    // Electron ≥ 25 puts the details on the event object; older builds pass isMainFrame as the 4th argument.
    const mainFrame = (event, positional) => (event && typeof event.isMainFrame === 'boolean' ? event.isMainFrame : positional !== false)
    const guard = (event, url) => {
      const c = classifyCheckoutNavigation(url)
      if (c.kind === 'allow') return
      event.preventDefault()
      if (c.kind === 'return') finish(c.ret.result, c.ret.orderId)
      else blockedHost = c.host
    }
    // will-navigate: main frame only (subframes of the SePay page, e.g. a bank widget, are left alone).
    wc.on('will-navigate', (event, url) => {
      if (mainFrame(event, true)) guard(event, url)
    })
    wc.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
      if (mainFrame(event, isMainFrame)) guard(event, url)
    })
    // Belt and braces: if a return URL got through anyway, finish as soon as it commits.
    const committed = (url) => {
      const ret = parsePaymentReturn(url)
      if (ret) finish(ret.result, ret.orderId)
    }
    wc.on('did-navigate', (_event, url) => committed(url)) // main frame only
    wc.on('did-redirect-navigation', (event, url, _isInPlace, isMainFrame) => {
      if (mainFrame(event, isMainFrame)) committed(url)
    })
    // Popups never open inside: SePay / canvasapp links go to the default browser, everything else is dropped.
    wc.setWindowOpenHandler(({ url }) => {
      if (checkoutExternalAllowed(url)) void shell.openExternal(url)
      else blockedHost = navigationHost(url)
      return { action: 'deny' }
    })
    wc.on('will-attach-webview', (event) => event.preventDefault())
    // Web Bluetooth: never pick a device (Electron would otherwise select the first one).
    wc.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault()
      callback('')
    })
    // Keep our title (the payment page would replace it).
    win.on('page-title-updated', (event) => event.preventDefault())
    win.on('closed', () => {
      if (checkoutWin === win) checkoutWin = null
      finish('closed', null)
    })
    void win.loadURL(checkoutPageUrl(checkoutUrl, fieldList))
  })
}

/**
 * Web permissions in the canvasapp partition. Electron grants every permission by default: the checkout window
 * (SePay) gets only clipboard writes; the login window loses camera / mic / location / notifications / devices /
 * screen capture… No device (HID / USB / serial) is ever handed out.
 */
function restrictCanvasappPermissions() {
  const ses = canvasappSession()
  const isCheckout = (wc) => !!wc && !!checkoutWin && !checkoutWin.isDestroyed() && wc === checkoutWin.webContents
  const allowed = (wc, permission) => (isCheckout(wc) ? checkoutPermissionAllowed(permission) : !CANVASAPP_DENIED_PERMISSIONS.has(permission))
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(allowed(wc, permission)))
  ses.setPermissionCheckHandler((wc, permission) => allowed(wc, permission))
  ses.setDevicePermissionHandler(() => false)
}

function registerCanvasappGateway() {
  restrictCanvasappPermissions()
  const guard = (fn) => async (event, ...args) => {
    if (!fromApp(event)) return gatewayError('not-allowed', 'Nguồn gọi không hợp lệ.')
    try {
      return await fn(event, ...args)
    } catch (e) {
      return gatewayError('error', String((e && e.message) || e))
    }
  }
  ipcMain.handle('canvasapp:status', guard(() => canvasappStatus()))
  ipcMain.handle('canvasapp:login', guard((event) => canvasappLogin(BrowserWindow.fromWebContents(event.sender))))
  ipcMain.handle('canvasapp:logout', guard(() => canvasappLogout()))
  ipcMain.handle('canvasapp:request', guard((_event, req) => canvasappRequest(req)))
  ipcMain.handle('canvasapp:checkout', guard((event, args) => canvasappCheckout(BrowserWindow.fromWebContents(event.sender), args)))
}
