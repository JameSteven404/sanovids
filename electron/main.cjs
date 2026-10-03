// SanoVids — desktop shell (Electron).
// Serves the built web app (dist/) through a privileged custom protocol app://bdp/ so the page has a stable,
// secure origin: IndexedDB / localStorage persist between launches exactly like on the web.
'use strict'

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { setupUpdater } = require('./updater.cjs')

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
const updaterRules = require('./updater-rules.cjs')
const hardening = require('./hardening-rules.cjs')
/**
 * Packaged app? Not app.isPackaged alone: Electron decides that from the exe NAME, so a copy of SanoVids.exe renamed
 * electron.exe would run the real app.asar with every packaged-only protection off. With the OnlyLoadAppFromAsar fuse
 * a packaged binary always runs resources\app.asar (hardening-rules.isPackagedApp). Every hardening decision uses this.
 */
const PACKAGED = hardening.isPackagedApp({ isPackaged: app.isPackaged, appPath: app.getAppPath() })
// Test-only isolation (never set by real users): SANOVIDS_PROFILE_DIR (env), else `sanovidsTestProfileDir` baked into the
// packaged package.json by test builds (extraMetadata; the NSIS relaunch drops the environment). Invalid → refuse to start.
// fsMod lets the check see through junctions / symlinks / short names to the real %APPDATA%\SanoVids.
const bakedProfileDir = readBakedProfileDir()
const profile = updaterRules.resolveProfileDir({ env: process.env.SANOVIDS_PROFILE_DIR, baked: bakedProfileDir, appData: app.getPath('appData'), appName: app.getName(), pathMod: path, fsMod: { existsSync: fs.existsSync, realpathSync: fs.realpathSync.native } })
if (!profile.ok) { console.error(`[SanoVids] ${profile.error}`); process.exit(2) }
/** A test-identity build (its package.json, inside the integrity-checked app.asar, has a baked test profile). Never the official build. */
const TEST_BUILD = typeof bakedProfileDir === 'string' && bakedProfileDir !== ''
// Hardening (docs/SIGNING.md): a packaged SanoVids never starts with debugger / security-off / helper-launcher switches.
// hasSwitch is Chromium's own parser (it also reads "-switch" and "/switch" on Windows). Remote debugging is allowed only
// in a test build on its isolated test profile, so the E2E harness can drive test builds. Nothing has been written yet.
const refused = hardening.refusedSwitches({ isPackaged: PACKAGED, profileSource: profile.source, testBuild: TEST_BUILD, hasSwitch: (n) => app.commandLine.hasSwitch(n) })
if (refused.length > 0) {
  console.error(`[SanoVids] refused command-line switches: ${refused.join(', ')}`)
  dialog.showErrorBox('SanoVids', hardening.REFUSED_DIALOG_TEXT)
  process.exit(3)
}
// SSLKEYLOGFILE would make Chromium write every TLS key to disk (like the refused --ssl-key-log-file): removed from this
// process before the network service reads it (checked on Electron 44: deleting it here stops the key log file).
for (const name of hardening.envToStrip({ isPackaged: PACKAGED, env: process.env })) delete process.env[name]
// Every renderer runs sandboxed (the windows below ask for it too; this also covers anything created later).
app.enableSandbox()
/** DevTools only from source or in a test build on its isolated test profile — never in the official packaged app. */
const DEVTOOLS = hardening.allowDevTools({ isPackaged: PACKAGED, profileSource: profile.source, testBuild: TEST_BUILD })
if (profile.source !== 'default') fs.mkdirSync(profile.dir, { recursive: true })
app.setPath('userData', profile.dir)
app.setAppUserModelId(updaterRules.appUserModelId(app.getName()))

/** `sanovidsTestProfileDir` of the app's own package.json (only test builds have it), else undefined. */
function readBakedProfileDir() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
    return pkg && typeof pkg.sanovidsTestProfileDir === 'string' ? pkg.sanovidsTestProfileDir : undefined
  } catch {
    return undefined
  }
}

/** The main SanoVids window (set in createWindow, cleared when it closes) and the auto-updater (electron/updater.cjs). */
let mainWindow = null
let updater = null

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
  // Every web page SanoVids ever creates (main window, canvasapp login and its popups, checkout): no <webview>, and
  // Web Bluetooth never picks a device (Electron would otherwise select the first one). Exactly one handler each.
  app.on('web-contents-created', (_event, wc) => {
    wc.on('will-attach-webview', (event) => event.preventDefault())
    wc.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault()
      callback('')
    })
  })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    restrictDefaultSessionPermissions()
    protocol.handle(SCHEME, serveDist)
    registerCanvasappGateway()
    registerFileBridge()
    registerAppBridge()
    try {
      updater = setupUpdater({ isAppSender: fromApp, getMainWindow: () => mainWindow, profileSource: profile.source })
    } catch (e) {
      console.error('[SanoVids] auto-updater disabled:', e)
    }
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  // A downloaded update installs silently when the app quits (electron-updater, in this same 'quit' event, exit code 0):
  // the updater records the attempt there (notice on the next launch). 'quit' never fires for a quit a window vetoed.
  app.on('quit', (_event, exitCode) => updater && updater.onQuit(exitCode))
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
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      // hashed assets never change; index.html must always be fresh after an app update
      'cache-control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    }
    if (ext === '.html') headers['content-security-policy'] = await htmlCsp()
    return new Response(body, { status: 200, headers })
  } catch {
    if (!ext) {
      const index = await fs.promises.readFile(path.join(DIST, 'index.html')).catch(() => null)
      if (index) return new Response(index, { status: 200, headers: { 'content-type': MIME['.html'], 'content-security-policy': await htmlCsp() } })
    }
    return new Response('Not found', { status: 404 })
  }
}

/**
 * Content-Security-Policy of every HTML page served from dist/ (hardening-rules.contentSecurityPolicy): only the app's
 * own files, plus the inline theme script of index.html by its sha256. Computed once from the dist/index.html bytes;
 * never throws (an unreadable index.html gets the policy without any inline script, and is retried next time).
 */
let htmlCspPromise = null
function htmlCsp() {
  if (!htmlCspPromise) {
    htmlCspPromise = fs.promises.readFile(path.join(DIST, 'index.html')).then(
      (bytes) => hardening.contentSecurityPolicy(bytes),
      () => {
        htmlCspPromise = null
        return hardening.contentSecurityPolicy('')
      },
    )
  }
  return htmlCspPromise
}

/**
 * Web permissions of the default session (the SanoVids window): Electron grants every permission by default; the page
 * only needs clipboard writes (copy buttons), the web folder picker API and full-screen video. No device is ever handed out.
 * The canvasapp partition has its own rules (restrictCanvasappPermissions).
 */
function restrictDefaultSessionPermissions() {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(hardening.permissionAllowed(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => hardening.permissionAllowed(permission))
  ses.setDevicePermissionHandler(() => false)
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
    // Windows: the multi-size .ico (sharp taskbar / Alt+Tab icon at every scale); elsewhere the 512 px PNG.
    icon: path.join(DIST, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: DEVTOOLS,
      spellcheck: false,
      // Hover previews / the take viewer may start with sound before any click (the speaker switch decides).
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: [`--bdp-version=${app.getVersion()}`],
    },
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.once('ready-to-show', () => {
    win.maximize()
    win.show()
    if (updater) updater.onWindowReady()
    // Self-check of the app's own code signature, once, a moment after the window shows (cached for 'app:signature').
    setTimeout(() => void appSignature(), 3000)
  })

  const { webContents } = win

  // "Khởi động lại để cập nhật": the page saved everything first; a beforeunload veto must not cancel quitAndInstall.
  webContents.on('will-prevent-unload', (event) => {
    if (updater && updater.isQuittingForUpdate()) event.preventDefault()
  })

  // No application menu → re-add the developer shortcuts, only where DevTools are allowed (from source / test profile).
  if (DEVTOOLS) {
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
  }

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

  // Plain downloads (Tải video with "Hỏi nơi lưu" off, auto-downloads, export) go straight to the Downloads folder
  // without a dialog, with " (2)", " (3)"… appended instead of overwriting an existing file. "Hỏi nơi lưu & tên file"
  // uses files:saveAs (native save dialog) instead. The renderer is told (bdp:downloaded) when a file is saved.
  // Only blobs made by the page itself (blob:app://bdp/…) with the types SanoVids produces: never a program or a script.
  webContents.session.on('will-download', (_event, item) => {
    if (!hardening.downloadAllowed(item.getURL(), item.getFilename())) {
      item.cancel()
      console.warn(`[SanoVids] download refused: ${hardening.downloadLogLabel(item.getURL(), item.getFilename())}`)
      return
    }
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
// Self-check of the app's own code signature (Cài đặt → Giới thiệu; docs/SIGNING.md). The running .exe AND the DLLs
// next to it that SanoVids processes load (hardening-rules.SELF_CHECK_FILES: Electron's four author-signed DLLs and
// Microsoft's two) are checked once, with one PowerShell (electron/signature.cjs: Authenticode + the pinned author
// certificate of package.json sanovids.signers), and the result is cached. The install folder is writable by the user:
// a swapped or modified DLL shows 'tampered'. The page only reads it ('app:signature', no argument).
// ---------------------------------------------------------------------------------------------------------------

let selfCheck = null

/** → { status, packaged, signer?, thumbprint? } (hardening-rules.appSignaturePayload). Never rejects. */
function appSignature() {
  if (!selfCheck) selfCheck = computeAppSignature().catch(() => ({ status: 'unknown', packaged: PACKAGED }))
  return selfCheck
}

async function computeAppSignature() {
  if (!PACKAGED) return { status: 'unsigned', packaged: false } // from source: nothing to check (no PowerShell)
  if (process.platform !== 'win32') return { status: 'unknown', packaged: true }
  const signature = require('./signature.cjs')
  const log = (l) => console.log(`[SanoVids] ${l}`)
  const pins = signature.readSignerPins()
  const dir = path.dirname(process.execPath)
  const companions = hardening.SELF_CHECK_FILES
  const results = await signature.checkFilesSignature([process.execPath, ...companions.map((f) => path.join(dir, f.name))], { pins, log })
  const states = companions.map((f, i) => ({ name: f.name, state: hardening.selfCheckFileState(f.kind, results[i + 1], pins) }))
  const verdict = hardening.combineSelfCheck(results[0] && results[0].verdict, states)
  if (verdict.files && verdict.files.length) log(`self-check ${verdict.status}: ${verdict.files.join(', ')}`)
  return hardening.appSignaturePayload(verdict, { packaged: true })
}

function registerAppBridge() {
  ipcMain.handle('app:signature', (event) => (fromApp(event) ? appSignature() : { status: 'unknown', packaged: false }))
}

// ---------------------------------------------------------------------------------------------------------------
// canvasapp.io.vn gateway (experimental, OFF by default — see docs/GATEWAY-CANVASAPP.md)
//
// The user logs in on canvasapp's OWN page, in a separate window that uses its own persistent session partition.
// SanoVids never sees the password or the cookies: the renderer can only ask the main process to call a short
// allowlist of canvasapp endpoints through that session. The main process adds the X-CSRF-Token header from the
// partition's canvas_csrf cookie (exactly what canvasapp's own page does), keeps concurrency low (2 API calls + 2 video
// downloads at a time, whatever the number of running jobs) and caches the job list so it is never fetched more than
// once every 15 s. No Origin/Referer spoofing, no Cloudflare workarounds.
// ---------------------------------------------------------------------------------------------------------------

const CANVASAPP_ORIGIN = 'https://canvasapp.io.vn'
const CANVASAPP_PARTITION = 'persist:canvasapp'
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

// <canvasapp-lanes> (pure; src/providers/__tests__/gatewayLanes.test.ts runs this block as-is)
/**
 * Requests in flight at once, per lane. Up to 10 jobs may run (src/providers/canvasapp/adapter.ts MAX_CONCURRENCY):
 * their finished videos download in their own lane, so a few long downloads never make the job-list poll, a submit
 * or /api/me wait behind them (one shared lane of 2 did), and the total stays small for canvasapp / Cloudflare.
 */
const CANVASAPP_LANE_SIZE = { api: 2, download: 2 }
const canvasappLanes = { api: { active: 0, waiters: [] }, download: { active: 0, waiters: [] } }

/** Runs `fn` when its lane ('api' or 'download') has a free slot (first come, first served). */
async function withCanvasappSlot(laneName, fn) {
  const lane = canvasappLanes[laneName]
  while (lane.active >= CANVASAPP_LANE_SIZE[laneName]) await new Promise((resolve) => lane.waiters.push(resolve))
  lane.active++
  try {
    return await fn()
  } finally {
    lane.active--
    const next = lane.waiters.shift()
    if (next) next()
  }
}
// </canvasapp-lanes>

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
    const result = await withCanvasappSlot(route.binary ? 'download' : 'api', async () => {
      // The clock starts when the request is really sent, not while it waits for a slot (e.g. behind other video
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

    const webPreferences = { partition: CANVASAPP_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: DEVTOOLS, spellcheck: false }
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
    // Sign-in popups (e.g. Google) stay in the same partition so the session ends up there. Every popup, and every
    // popup of a popup, gets the same rule: https only, same webPreferences (sandbox, no DevTools in a real app).
    const guardPopups = (w) => {
      w.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//i.test(url)) return { action: 'allow', overrideBrowserWindowOptions: { parent: win, autoHideMenuBar: true, webPreferences } }
        return { action: 'deny' }
      })
      w.webContents.on('did-create-window', (child) => guardPopups(child))
    }
    guardPopups(win)

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
      devTools: DEVTOOLS,
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
    // Web Bluetooth: the app-wide 'web-contents-created' handler already refuses every device (one handler only).
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

// ---------------------------------------------------------------------------------------------------------------
// Files: "Lưu video" save dialog and the canvas "Thư mục" nodes (src/lib/desktopFiles.ts, src/lib/saveFolders.ts).
//
// The renderer never chooses a path on its own:
//   files:saveAs        the user picks the place and name in the native dialog; the prompt .txt goes next to it;
//   files:pickFolder    the user picks a folder; it joins the ALLOWLIST (userData/save-locations.json);
//   files:writeToFolder only into an allowlisted folder (exact path, not a sub-folder), plain file names only;
//   files:openFolder    shows an allowlisted folder in Explorer / Finder;  files:folderStatus  allowed / exists.
// Nothing is ever overwritten except the file the user confirmed in the save dialog: other names get " (2)".
// ---------------------------------------------------------------------------------------------------------------

// <save-rules> (rules, and writing with an injected fs; src/lib/__tests__/saveRules.test.ts runs this block as-is with
// node:path's win32 and posix, and a temp folder)
const SAVE_MAX_FILES = 4
const SAVE_MAX_FILE_BYTES = 1024 * 1024 * 1024 // 1 GB per file
const SAVE_MAX_TEXT_CHARS = 2_000_000
const SAVE_MAX_NAME = 180
const SAVE_MAX_PATH = 1024
const SAVE_MAX_FOLDERS = 200
// Windows device names, also as "nul .txt" / "Con ...x" (spaces before the first dot are ignored there too).
const SAVE_RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)\s*(\..*)?$/i
const SAVE_BAD_CHARS_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/g
// Invisible format characters (bidi overrides / isolates, zero-width, BOM, soft hyphen): a name never shows another
// extension than the one it has (an RLO character shows "a<RLO>gpj.exe" as "aexe.jpg"). Lone surrogates would
// become U+FFFD on disk.
const SAVE_FORMAT_CHARS_RE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g
const SAVE_LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
// The only types SanoVids writes: videos, posters, the prompt .txt, the .zip of videos, the settings .json.
const SAVE_ALLOWED_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'txt', 'zip', 'json'])
// What the save dialog may write next to the chosen file (the prompt .txt).
const SAVE_COMPANION_EXT = new Set(['txt'])
const SAVE_FILTER_LABELS = {
  mp4: 'Video MP4',
  webm: 'Video WebM',
  mov: 'Video MOV',
  zip: 'Tệp nén ZIP',
  jpg: 'Ảnh JPEG',
  jpeg: 'Ảnh JPEG',
  png: 'Ảnh PNG',
  txt: 'Văn bản',
}

/** "clip.MP4" → "mp4" ('' without one; a leading dot is not an extension). */
function saveNameExt(name) {
  const dot = String(name).lastIndexOf('.')
  return dot > 0 ? String(name).slice(dot + 1).toLowerCase() : ''
}

/**
 * A plain file name to write, or null. Separators and forbidden characters become "-" (so no path can be named),
 * no leading / trailing dots or spaces (never "." or ".."), reserved device names get "_", long names are cut
 * keeping their extension.
 */
function sanitizeSaveName(raw) {
  if (typeof raw !== 'string') return null
  let s = raw.replace(SAVE_LONE_SURROGATE_RE, '').normalize('NFC').replace(SAVE_FORMAT_CHARS_RE, '')
  s = s.replace(SAVE_BAD_CHARS_RE, '-').replace(/\s+/g, ' ').trim()
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!s) return null
  if (s.length > SAVE_MAX_NAME) {
    const ext = saveNameExt(s)
    const tail = ext && ext.length <= 8 ? '.' + ext : ''
    s = cutSaveText(s, SAVE_MAX_NAME - tail.length).replace(/[.\s]+$/, '') + tail
  }
  if (SAVE_RESERVED_RE.test(s)) s = '_' + s
  return s
}

/** The first `max` UTF-16 units of `s`, never ending on half of an emoji (a surrogate pair). */
function cutSaveText(s, max) {
  if (s.length <= max) return s
  const out = s.slice(0, max)
  return /[\ud800-\udbff]$/.test(out) ? out.slice(0, -1) : out
}

/** "clip.mp4", 2 → "clip (2).mp4" (same rule as the web app). */
function numberedSaveName(name, n) {
  if (n < 2) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
}

/**
 * Comparable key of an absolute folder path (resolved, no trailing separator; case-insensitive on Windows), or null
 * when it is not an acceptable absolute path.
 */
function folderKey(p, pathMod) {
  if (typeof p !== 'string' || !p || p.length > SAVE_MAX_PATH || p.includes('\u0000') || !pathMod.isAbsolute(p)) return null
  let r = pathMod.resolve(p)
  const root = pathMod.parse(r).root
  if (r.length > root.length) r = r.replace(/[\\/]+$/, '')
  return pathMod.sep === '\\' ? r.toLowerCase() : r
}

/** Was exactly this folder picked by the user (not a parent, not a sub-folder)? */
function isAllowedFolder(allowed, p, pathMod) {
  const key = folderKey(p, pathMod)
  return !!key && Array.isArray(allowed) && allowed.includes(key)
}

/** The allowlist with `p` added (most recent last, at most SAVE_MAX_FOLDERS). Unchanged when `p` is not acceptable. */
function addAllowedFolder(allowed, p, pathMod) {
  const key = folderKey(p, pathMod)
  const list = Array.isArray(allowed) ? allowed.filter((x) => typeof x === 'string') : []
  if (!key) return list
  return [...list.filter((x) => x !== key), key].slice(-SAVE_MAX_FOLDERS)
}

/** userData/save-locations.json, validated: { lastSaveDir, folders }. */
function parseSaveLocations(raw, pathMod) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const lastSaveDir = folderKey(o.lastSaveDir, pathMod) ? o.lastSaveDir : null
  let folders = []
  for (const f of Array.isArray(o.folders) ? o.folders : []) folders = addAllowedFolder(folders, f, pathMod)
  return { lastSaveDir, folders }
}

/**
 * Files from the renderer → [{ name, bytes | text }] with safe names, or { error }. 1–SAVE_MAX_FILES files, binary
 * (Uint8Array, ≤ 1 GB) or text (≤ 2 M characters), no two with the same name.
 */
function checkSaveFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > SAVE_MAX_FILES) return { error: 'Danh sách file không hợp lệ.' }
  const out = []
  const seen = new Set()
  for (const f of files) {
    if (!f || typeof f !== 'object') return { error: 'File không hợp lệ.' }
    const name = sanitizeSaveName(f.name)
    if (!name) return { error: 'Tên file không hợp lệ.' }
    // Never a program, a shortcut or a settings file of Windows (.exe, .lnk, .url, desktop.ini…), whatever the page says.
    if (!SAVE_ALLOWED_EXT.has(saveNameExt(name))) return { error: 'Loại file này không được phép lưu.' }
    if (seen.has(name.toLowerCase())) return { error: 'Hai file trùng tên.' }
    seen.add(name.toLowerCase())
    if (f.bytes instanceof Uint8Array) {
      if (f.bytes.byteLength > SAVE_MAX_FILE_BYTES) return { error: 'File lớn hơn 1 GB.' }
      out.push({ name, bytes: f.bytes })
    } else if (typeof f.text === 'string') {
      if (f.text.length > SAVE_MAX_TEXT_CHARS) return { error: 'File văn bản quá lớn.' }
      out.push({ name, text: f.text })
    } else return { error: 'File không có nội dung.' }
  }
  return { files: out }
}

/** files:saveAs arguments → { suggestedName, title, files } or { error }. */
function checkSaveAsArgs(args) {
  if (!args || typeof args !== 'object') return { error: 'Yêu cầu không hợp lệ.' }
  const checked = checkSaveFiles(args.files)
  if (checked.error) return checked
  // Files written next to the chosen one are never shown in the dialog: only the prompt .txt.
  if (checked.files.slice(1).some((f) => !SAVE_COMPANION_EXT.has(saveNameExt(f.name)))) return { error: 'Chỉ lưu kèm được file .txt.' }
  const suggestedName = sanitizeSaveName(typeof args.suggestedName === 'string' && args.suggestedName ? args.suggestedName : checked.files[0].name)
  if (!suggestedName) return { error: 'Tên file không hợp lệ.' }
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 80) : saveDialogTitle(checked.files[0].name)
  return { suggestedName, title, files: checked.files }
}

/** Filter of the save dialog for this file's type (keeps the extension the data really has). */
function saveDialogFilters(name) {
  const ext = saveNameExt(name)
  if (!ext || !/^[a-z0-9]{1,8}$/.test(ext)) return []
  return [{ name: SAVE_FILTER_LABELS[ext] || ext.toUpperCase(), extensions: [ext] }]
}

function saveDialogTitle(name) {
  const ext = saveNameExt(name)
  if (ext === 'zip') return 'Lưu file .zip'
  if (ext === 'mp4' || ext === 'webm' || ext === 'mov') return 'Lưu video'
  return 'Lưu file'
}

/** The path chosen in the dialog, with the data's own extension when the user typed none / another one. */
function withSaveExtension(filePath, ext, pathMod) {
  if (!ext) return filePath
  return pathMod.extname(filePath).toLowerCase() === '.' + ext ? filePath : `${filePath}.${ext}`
}

/** Name of a companion (the prompt .txt) of a video saved as `chosenPath`: same base name, its own extension. */
function companionSaveName(chosenPath, companionName, pathMod) {
  const ext = saveNameExt(companionName)
  return sanitizeSaveName(pathMod.parse(chosenPath).name + (ext ? '.' + ext : ''))
}

/** Is `target` a file directly inside `dir` (no traversal, no sub-folder)? */
function isDirectChild(dir, target, pathMod) {
  const d = folderKey(dir, pathMod)
  const parent = folderKey(pathMod.dirname(target), pathMod)
  return !!d && d === parent && pathMod.basename(target) !== '' && pathMod.basename(target) !== '..'
}

// ---- writing (fs injected: node's fs.promises here, a fake or a temp folder in the tests) ----
const saveFileData = (f) => (f.bytes ? Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength) : f.text)
const saveError = (code, message = code) => Object.assign(new Error(message), { code })
const saveSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Is nothing at `p`? (Unreadable = taken: never risk a name that may exist.) */
async function savePathFree(fsp, p) {
  try {
    await fsp.lstat(p)
    return false
  } catch (e) {
    return !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')
  }
}

/** Write `data` to a new temp file "<target>.<random>.part" next to `target` (never an existing file). Returns its path. */
async function writeSavePart(fsp, target, data) {
  for (let k = 0; k < 5; k++) {
    const part = `${target}.${Math.random().toString(36).slice(2, 8)}.part`
    try {
      await fsp.writeFile(part, data, { flag: 'wx' })
      return part
    } catch (e) {
      // 'wx' created it: a write cut short (disk full…) leaves nothing behind.
      if (!e || e.code !== 'EEXIST') {
        await fsp.unlink(part).catch(() => undefined)
        throw e
      }
    }
  }
  throw saveError('EEXIST')
}

/** Rename, retrying a moment while Windows (an antivirus, the indexer) still holds the new file. */
async function renameSaveFile(fsp, from, to) {
  for (let k = 0; ; k++) {
    try {
      return await fsp.rename(from, to)
    } catch (e) {
      if (k >= 8 || !e || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      await saveSleep(40 * (k + 1))
    }
  }
}

/**
 * Give a finished temp file its real name without ever replacing a file: a hard link fails when the name exists
 * (EEXIST); drives without hard links (FAT / exFAT sticks, some shares) rename after checking the name is free.
 */
async function claimSaveName(fsp, part, target) {
  try {
    await fsp.link(part, target)
    await fsp.unlink(part).catch(() => undefined)
    return
  } catch (e) {
    if (e && e.code === 'EEXIST') throw e
  }
  if (!(await savePathFree(fsp, target))) throw saveError('EEXIST')
  await renameSaveFile(fsp, part, target)
}

/**
 * Write files into `dir` without overwriting anything: the same " (n)" for the whole group (video + .txt stay
 * matched). Each file is written to a ".part" file first and only then given its name, so an app closed in the middle
 * never leaves a cut video under the real name. On any failure the files of this attempt are removed again.
 */
async function writeGroupExclusive(dir, files, fsp, pathMod) {
  for (let n = 1; n < 1000; n++) {
    const names = files.map((f) => numberedSaveName(f.name, n))
    let free = true
    for (const x of names) if (!(await savePathFree(fsp, pathMod.join(dir, x)))) free = false
    if (!free) continue
    const written = []
    let part = null
    try {
      for (let i = 0; i < files.length; i++) {
        const target = pathMod.join(dir, names[i])
        if (!isDirectChild(dir, target, pathMod)) throw saveError('EINVAL', 'bad name')
        part = await writeSavePart(fsp, target, saveFileData(files[i]))
        await claimSaveName(fsp, part, target)
        part = null
        written.push(target)
      }
      return names
    } catch (e) {
      // Only what this attempt created goes (its names did not exist before it).
      if (part) await fsp.unlink(part).catch(() => undefined)
      for (const w of written) await fsp.unlink(w).catch(() => undefined)
      if (e && e.code === 'EEXIST') continue
      throw e
    }
  }
  throw saveError('ENAMETOOLONG', 'no free name')
}

/** Replace `target` (the user confirmed it in the save dialog) all at once: never left half old, half new. */
async function writeSaveReplacing(fsp, target, data) {
  const part = await writeSavePart(fsp, target, data)
  try {
    await renameSaveFile(fsp, part, target)
  } catch (e) {
    await fsp.unlink(part).catch(() => undefined)
    throw e
  }
}
// </save-rules>

const SAVE_STATE_FILE = 'save-locations.json'
let saveState = null

function saveStatePath() {
  return path.join(app.getPath('userData'), SAVE_STATE_FILE)
}

function loadSaveState() {
  if (saveState) return saveState
  try {
    saveState = parseSaveLocations(JSON.parse(fs.readFileSync(saveStatePath(), 'utf8')), path)
  } catch {
    saveState = { lastSaveDir: null, folders: [] }
  }
  return saveState
}

async function storeSaveState(next) {
  saveState = next
  const file = saveStatePath()
  const tmp = file + '.tmp'
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
    await fs.promises.rename(tmp, file)
  } catch {
    /* the allowlist still works for this session */
  }
}

function fileError(code, message) {
  return { ok: false, code, message }
}

/** Vietnamese text for a file-system error. */
function fsErrorText(e) {
  switch (e && e.code) {
    case 'ENOSPC':
      return 'Ổ đĩa đã đầy.'
    case 'EACCES':
    case 'EPERM':
      return 'Không có quyền ghi vào thư mục này.'
    case 'EBUSY':
      return 'File đang bị chương trình khác mở hoặc khoá.'
    case 'ENOENT':
    case 'ENOTDIR':
      return 'Không tìm thấy thư mục.'
    case 'EROFS':
      return 'Ổ đĩa chỉ cho đọc.'
    default:
      return `Không ghi được file (${(e && (e.code || e.message)) || e}).`
  }
}

async function isDirectory(p) {
  try {
    return (await fs.promises.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function filesPickFolder(win) {
  const st = loadSaveState()
  const opts = {
    title: 'Chọn thư mục lưu video',
    buttonLabel: 'Chọn thư mục này',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    ...(st.lastSaveDir ? { defaultPath: st.lastSaveDir } : {}),
  }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const chosen = !res.canceled && res.filePaths && res.filePaths[0]
  if (!chosen) return { ok: false, code: 'canceled', message: 'Đã huỷ.', canceled: true }
  const folder = path.resolve(chosen)
  if (!folderKey(folder, path) || !(await isDirectory(folder))) return fileError('bad-folder', 'Không dùng được thư mục này.')
  await storeSaveState({ lastSaveDir: folder, folders: addAllowedFolder(st.folders, folder, path) })
  return { ok: true, path: folder, name: path.basename(folder) || folder }
}

async function filesFolderStatus(args) {
  const folderPath = args && args.folderPath
  if (!folderKey(folderPath, path)) return { ok: true, allowed: false, exists: false }
  const allowed = isAllowedFolder(loadSaveState().folders, folderPath, path)
  return { ok: true, allowed, exists: allowed ? await isDirectory(path.resolve(folderPath)) : false }
}

async function filesWriteToFolder(args) {
  const folderPath = args && args.folderPath
  if (!isAllowedFolder(loadSaveState().folders, folderPath, path)) {
    return fileError('not-allowed', 'Thư mục này chưa được chọn trên máy này — bấm “Chọn thư mục”.')
  }
  const dir = path.resolve(folderPath)
  if (!(await isDirectory(dir))) return fileError('missing', 'Không tìm thấy thư mục (đã đổi tên, chuyển hoặc xoá?).')
  const checked = checkSaveFiles(args.files)
  if (checked.error) return fileError('bad-request', checked.error)
  try {
    return { ok: true, names: await writeGroupExclusive(dir, checked.files, fs.promises, path) }
  } catch (e) {
    return fileError(e && e.code === 'ENOENT' ? 'missing' : 'write-failed', fsErrorText(e))
  }
}

async function filesOpenFolder(args) {
  const folderPath = args && args.folderPath
  if (!isAllowedFolder(loadSaveState().folders, folderPath, path)) return fileError('not-allowed', 'Thư mục này chưa được chọn trên máy này.')
  const dir = path.resolve(folderPath)
  if (!(await isDirectory(dir))) return fileError('missing', 'Không tìm thấy thư mục.')
  const err = await shell.openPath(dir)
  return err ? fileError('open-failed', err) : { ok: true }
}

async function filesSaveAs(win, args) {
  const checked = checkSaveAsArgs(args)
  if (checked.error) return fileError('bad-request', checked.error)
  const st = loadSaveState()
  const primary = checked.files[0]
  const ext = saveNameExt(primary.name)
  const dir = st.lastSaveDir && (await isDirectory(st.lastSaveDir)) ? st.lastSaveDir : app.getPath('downloads')
  const opts = {
    title: checked.title,
    defaultPath: path.join(dir, checked.suggestedName),
    buttonLabel: 'Lưu',
    filters: saveDialogFilters(primary.name),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return { ok: false, code: 'canceled', message: 'Đã huỷ.', canceled: true }
  const chosen = path.resolve(res.filePath)
  let target = withSaveExtension(chosen, ext, path)
  const targetDir = path.dirname(target)
  try {
    if (target === chosen) {
      // The user confirmed this exact file in the dialog (it asks before replacing one): replaced all at once.
      await writeSaveReplacing(fs.promises, target, saveFileData(primary))
    } else {
      // The extension was added here, after the dialog: that file was never confirmed, so it is not overwritten.
      const [written] = await writeGroupExclusive(targetDir, [{ ...primary, name: path.basename(target) }], fs.promises, path)
      target = path.join(targetDir, written)
    }
    const names = [path.basename(target)]
    for (const f of checked.files.slice(1)) {
      const name = companionSaveName(target, f.name, path)
      if (!name) continue
      // Companions never overwrite: "<chosen name>.txt", else "<chosen name> (2).txt"…
      const [written] = await writeGroupExclusive(targetDir, [{ ...f, name }], fs.promises, path)
      names.push(written)
    }
    await storeSaveState({ ...loadSaveState(), lastSaveDir: targetDir })
    return { ok: true, path: target, names }
  } catch (e) {
    return fileError('write-failed', fsErrorText(e))
  }
}

function registerFileBridge() {
  const guard = (fn) => async (event, ...args) => {
    if (!fromApp(event)) return fileError('not-allowed', 'Nguồn gọi không hợp lệ.')
    try {
      return await fn(event, ...args)
    } catch (e) {
      return fileError('error', String((e && e.message) || e))
    }
  }
  const winOf = (event) => BrowserWindow.fromWebContents(event.sender)
  ipcMain.handle('files:pickFolder', guard((event) => filesPickFolder(winOf(event))))
  ipcMain.handle('files:folderStatus', guard((_event, args) => filesFolderStatus(args)))
  ipcMain.handle('files:writeToFolder', guard((_event, args) => filesWriteToFolder(args)))
  ipcMain.handle('files:openFolder', guard((_event, args) => filesOpenFolder(args)))
  ipcMain.handle('files:saveAs', guard((event, args) => filesSaveAs(winOf(event), args)))
}
