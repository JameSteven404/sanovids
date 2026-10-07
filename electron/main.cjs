// SanoVids — desktop shell (Electron).
// Serves the built web app (dist/) through a privileged custom protocol app://bdp/ so the page has a stable,
// secure origin: IndexedDB / localStorage persist between launches exactly like on the web.
'use strict'

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
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
// The electron-builder Portable stub tells the app it extracted where the portable .exe is (PORTABLE_EXECUTABLE_*): read
// once, then removed, so nothing SanoVids starts (a browser opened by "Mở trang tải về", an installer) inherits it.
// Trusted only for a run that really comes from that stub (portableFile(), updater-rules trustedPortableFile).
const portableEnv = updaterRules.portableEnvOf(process.env)
for (const name of updaterRules.PORTABLE_ENV) delete process.env[name]
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

let portableFileMemo = null

/**
 * The portable .exe this run was started from (the Portable stub's PORTABLE_EXECUTABLE_FILE, kept in `portableEnv`),
 * only when updater-rules trustedPortableFile vouches for it; else undefined. Computed once.
 */
function portableFile() {
  if (!portableFileMemo) {
    let file
    try {
      file = updaterRules.trustedPortableFile({
        platform: process.platform,
        isPackaged: PACKAGED,
        portable: portableEnv,
        execPath: process.execPath,
        tmpDir: app.getPath('temp'),
        appName: app.getName(),
        exists: fs.existsSync,
        realpath: fs.realpathSync.native,
        pathMod: path,
      })
    } catch {
      file = undefined
    }
    portableFileMemo = { file }
  }
  return portableFileMemo.file
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
      updater = setupUpdater({ isAppSender: fromApp, getMainWindow: () => mainWindow, profileSource: profile.source, portableFile: portableFile() })
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

  // Portable build: a pinned window relaunches the portable .exe itself, not the temp copy it runs from (updater-rules
  // portableRelaunch: packaged win32 with a valid PORTABLE_EXECUTABLE_FILE only; nothing is set otherwise).
  const relaunch = updaterRules.portableRelaunch({
    platform: process.platform,
    isPackaged: PACKAGED,
    portableFile: portableFile(),
    appName: app.getName(),
    exists: fs.existsSync,
    pathMod: path,
  })
  if (relaunch) {
    try {
      win.setAppDetails(relaunch)
    } catch (e) {
      console.warn('[SanoVids] setAppDetails failed:', (e && e.message) || e)
    }
  }

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

// Where this SanoVids runs from (Cài đặt → Ứng dụng / Giới thiệu hints: Portable, or a leftover copy in the temp folder
// that Windows may delete). Only the kind crosses ('app:placement', no argument): never a path.
let placementPayload = null

/** → { kind: 'installer' | 'portable' | 'temp-copy' | 'dev' } (updater-rules.placement), computed once. Never throws. */
function appPlacement() {
  if (!placementPayload) {
    let kind
    try {
      // PACKAGED, not app.isPackaged (see its definition): only differs for a renamed exe running the real app.asar,
      // which the updater calls 'dev' and this calls 'portable' / 'temp-copy' (a hint, never a protection).
      kind = updaterRules.placement({
        platform: process.platform,
        isPackaged: PACKAGED,
        portableFile: portableFile(),
        execPath: process.execPath,
        tmpDir: app.getPath('temp'),
        appName: app.getName(),
        exists: fs.existsSync,
        realpath: fs.realpathSync.native,
        pathMod: path,
      })
    } catch {
      kind = PACKAGED ? 'portable' : 'dev'
    }
    placementPayload = { kind }
  }
  return placementPayload
}

function registerAppBridge() {
  ipcMain.handle('app:signature', (event) => (fromApp(event) ? appSignature() : { status: 'unknown', packaged: false }))
  ipcMain.handle('app:placement', (event) => (fromApp(event) ? appPlacement() : { kind: 'unknown' }))
}

// ---------------------------------------------------------------------------------------------------------------
// canvasapp.io.vn gateway (experimental, OFF by default — see docs/GATEWAY-CANVASAPP.md)
//
// The user logs in on canvasapp's OWN page, in a separate window that uses its own persistent session partition.
// SanoVids never sees the password or the cookies: the renderer can only ask the main process to call a short
// allowlist of canvasapp endpoints through that session. The main process adds the X-CSRF-Token header from the
// partition's canvas_csrf cookie (exactly what canvasapp's own page does), keeps concurrency low (2 API calls + 2 video
// downloads at a time, whatever the number of running jobs) and caches the job list so it is never fetched more than
// once every 15 s. Finished videos are pulled by the page in pieces of ≤ 4 MiB (canvasapp:downloadOpen / downloadRead /
// downloadClose, <canvasapp-downloads>): ≤ 1 GB, stopped after 60 s without data, continued with Range when canvasapp
// allows it. No Origin/Referer spoofing, no Cloudflare workarounds.
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

/**
 * canvasapp:request takes every allowlisted route EXCEPT the video stream (`binary`): a video only comes in pieces
 * (canvasapp:downloadOpen, <canvasapp-downloads>: the 1 GB cap while reading, the idle stop, no whole file in one IPC
 * message). The page, the preload and main ship together in app.asar, so no page needs the old one-message way.
 */
function matchCanvasappRequest(method, rawPath) {
  const m = matchCanvasappRoute(method, rawPath)
  return m && !m.route.binary ? m : null
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

// <canvasapp-downloads> (pure; src/providers/__tests__/gatewayDownloads.test.ts runs this block as-is next to its
// TypeScript port src/providers/dev/downloads.ts (development mode): keep both in sync)
/**
 * Finished videos never cross IPC in one message. The page pulls them in pieces (canvasapp:downloadOpen / downloadRead /
 * downloadClose): main reads the HTTP body of GET /api/video-jobs/{id}/stream itself and answers each read with what
 * arrived (≤ 4 MiB, or less after 1 s on a slow link). One read at a time per download; the body stream is read only
 * while the page waits for a piece (deps.fetch = <canvasapp-net-get>: Electron's net response asks the network for
 * more only as the stream is read).
 * A download (one connection) holds one slot of the 'download' lane from open to end. It ends after 60 s without a
 * network byte, after 30 s without a read from the page (reload / crash), after 60 min open ('too-slow': the page
 * continues on a new connection when it can resume, else it stops — the slot goes to the next in line meanwhile),
 * past 1 GB, when the page closes it, reloads, navigates, crashes or logs out. A download cut half-way continues with
 * Range + If-Range only when canvasapp gave a strong ETag (or a Last-Modified date) for that video, and a 206 is taken
 * only when it carries that same validator: never spliced onto a file that may have changed.
 * The page never sends a URL (only an allowlisted path), a header or a validator: main keeps those.
 */
const CANVASAPP_VIDEO_MAX_BYTES = 1024 * 1024 * 1024
const CANVASAPP_DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024
const CANVASAPP_DOWNLOAD_FLUSH_MS = 1000
/** Until the answer's headers (from when the slot is held): generous, /stream may fetch the file before answering (VERIFY). */
const CANVASAPP_DOWNLOAD_HEADERS_MS = 5 * 60_000
const CANVASAPP_DOWNLOAD_IDLE_MS = 60_000
const CANVASAPP_DOWNLOAD_PULL_IDLE_MS = 30_000
const CANVASAPP_DOWNLOAD_MAX_MS = 60 * 60_000
/**
 * Open + waiting for a slot. ≥ the jobs SanoVids itself runs at once (src/providers/canvasapp/adapter.ts
 * MAX_CONCURRENCY); imported takes ("Nhập job") take no submit slot, so more finishing videos than this can ask at once:
 * the extra ones are refused 'busy' and the engine asks again 15 s later (deferred, not a failed try).
 */
const CANVASAPP_DOWNLOAD_MAX_SESSIONS = 16
const CANVASAPP_DOWNLOAD_ERROR_BODY_BYTES = 64 * 1024
/**
 * A video's validator (ETag / Last-Modified) is kept this long after the last connection for that path ended (or
 * opened), for a resume: a download that ran longer than this still continues where it was cut.
 */
const CANVASAPP_DOWNLOAD_TAG_MS = 10 * 60_000
const CANVASAPP_DOWNLOAD_MAX_TAGS = 64
/** Download ids are chosen by the page (crypto.randomUUID()), so it can close one that still waits for a slot. */
const CANVASAPP_DOWNLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Content-Length → bytes, or null (missing / not a plain number). */
function parseContentLength(v) {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^\d{1,15}$/.test(s) ? Number(s) : null
}

/** "bytes 100-199/1000" → { start, end, total } (end inclusive; total null for "*"), or null. */
function parseContentRange(v) {
  const m = typeof v === 'string' ? /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/i.exec(v.trim()) : null
  if (!m) return null
  const start = Number(m[1])
  const end = Number(m[2])
  const total = m[3] === '*' ? null : Number(m[3])
  if (start > end || (total !== null && end >= total)) return null
  return { start, end, total }
}

/** Where the page asks to continue from: a safe integer in (0, maxBytes), else 0. */
function downloadStartByte(v, maxBytes) {
  return Number.isSafeInteger(v) && v > 0 && v < maxBytes ? v : 0
}

/** A strong ETag (never W/), else an HTTP date (Last-Modified), else null. Strict: nothing else reaches a header. */
function strongValidator(etag, lastModified) {
  const e = typeof etag === 'string' ? etag.trim() : ''
  if (/^"[\x21\x23-\x7e]{1,200}"$/.test(e)) return e
  const d = typeof lastModified === 'string' ? lastModified.trim() : ''
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(d)) return d
  return null
}

/** Request headers: Range + If-Range only to continue (from > 0) a video whose validator main holds. */
function downloadHeaders(from, validator) {
  const h = { Accept: 'video/mp4,*/*' }
  if (from > 0 && validator) {
    h.Range = `bytes=${from}-`
    h['If-Range'] = validator
  }
  return h
}

/**
 * What to do with an answer (o.validator = the answer's strongValidator, o.sent = the one sent with If-Range):
 *   { kind: 'answer' }      not 200 / 206: read a little of the body, hand it to the page (401, 404, 409, 5xx…);
 *   { kind: 'bad-range' }   a 206 that does not start where asked (or of unknown size), a 206 to a resume without the
 *                           validator sent (a server that ignores If-Range: maybe the rest of another file of the
 *                           same size), or 416 to a resume;
 *   { kind: 'too-large' }   the announced size is over maxBytes (nothing is read);
 *   { kind: 'stream', from, end, total, resumable }   end = absolute end of this answer (null = unknown), total = the
 *                           whole video's size (null = unknown); resumable = a cut can continue with Range.
 * A 200 to a resume means "from the start". An encoded body (Content-Encoding) has no usable length nor offsets.
 */
function downloadPlan(o) {
  const from = o.from > 0 ? o.from : 0
  const enc = typeof o.contentEncoding === 'string' ? o.contentEncoding.trim() : ''
  const encoded = enc !== '' && !/^identity$/i.test(enc)
  if (o.status === 416 && from > 0) return { kind: 'bad-range' }
  if (o.status !== 200 && o.status !== 206) return { kind: 'answer' }
  if (o.status === 206) {
    const r = encoded ? null : parseContentRange(o.contentRange)
    if (!r || r.start !== from || r.total === null) return { kind: 'bad-range' }
    // RFC 9110 §15.3.7: a 206 carries the validator a 200 would — it must be the one If-Range named
    if (from > 0 && (!o.sent || o.validator !== o.sent)) return { kind: 'bad-range' }
    if (r.total > o.maxBytes) return { kind: 'too-large' }
    return { kind: 'stream', from: r.start, end: r.end + 1, total: r.total, resumable: !!o.validator }
  }
  const len = encoded ? null : parseContentLength(o.contentLength)
  if (len !== null && len > o.maxBytes) return { kind: 'too-large' }
  const ranges = typeof o.acceptRanges === 'string' && /^bytes$/i.test(o.acceptRanges.trim())
  return { kind: 'stream', from: 0, end: len, total: len, resumable: !encoded && ranges && !!o.validator }
}

/**
 * Pieces of one HTTP body for the page. o: { reader, start, end, maxBytes, chunkBytes, flushMs, idleMs, setTimer,
 * clearTimer }. read() → { bytes } | { done: true } | { error: 'network' | 'too-large', reason }, never throws.
 * The network is read only while a read() waits (one reader.read() at a time); a piece is chunkBytes, or what
 * arrived once flushMs passed. 'done' only for a body that ended by itself with the announced length. Reasons: idle
 * (no byte for idleMs), cut (the connection broke), length (not the announced size), size (over maxBytes), closed
 * (cancel(), or a second read() at once), max (abort('max')). After a cut / idle, what arrived before is still handed
 * out first; then (and after any other failure at once) every read() returns the failure.
 */
function createDownloadPump(o) {
  const reader = o.reader
  const start = o.start > 0 ? o.start : 0
  const end = typeof o.end === 'number' ? o.end : null
  let queue = []
  let queued = 0
  let received = 0
  let pulling = false
  let eof = false
  let finished = false
  let failure = null
  let waiter = null
  let idleTimer = null

  const stopIdle = () => {
    if (idleTimer !== null) o.clearTimer(idleTimer)
    idleTimer = null
  }

  function fail(reason) {
    if (failure || finished) return
    failure = { error: reason === 'size' ? 'too-large' : 'network', reason }
    stopIdle()
    // a broken / stalled connection: what arrived before is still the video's start (handed out first, for a resume)
    if (reason !== 'cut' && reason !== 'idle') {
      queue = []
      queued = 0
    }
    try {
      const p = reader.cancel()
      if (p && typeof p.then === 'function') p.then(undefined, () => undefined)
    } catch {
      /* already closed */
    }
    answer()
  }

  /** The next piece: a fresh copy (a view would send its whole buffer over IPC). */
  function take() {
    const n = Math.min(o.chunkBytes, queued)
    const out = new Uint8Array(n)
    let off = 0
    while (off < n) {
      const head = queue[0]
      const k = Math.min(head.byteLength, n - off)
      out.set(k === head.byteLength ? head : head.subarray(0, k), off)
      off += k
      if (k === head.byteLength) queue.shift()
      else queue[0] = head.subarray(k)
    }
    queued -= n
    return out
  }

  function answer() {
    if (!waiter) return
    let out
    if (failure) out = queued > 0 ? { bytes: take() } : failure
    else if (queued >= o.chunkBytes || (queued > 0 && (eof || waiter.flushDue))) out = { bytes: take() }
    else if (eof) {
      finished = true
      out = { done: true }
    } else {
      pull()
      return
    }
    const w = waiter
    waiter = null
    o.clearTimer(w.timer)
    w.resolve(out)
  }

  function pull() {
    if (pulling || eof || failure) return
    pulling = true
    idleTimer = o.setTimer(() => {
      idleTimer = null
      fail('idle')
    }, o.idleMs)
    let p
    try {
      p = Promise.resolve(reader.read())
    } catch (e) {
      p = Promise.reject(e)
    }
    p.then(
      (r) => {
        pulling = false
        stopIdle()
        if (failure) return
        if (!r || r.done) {
          if (end !== null && start + received !== end) return fail('length')
          eof = true
          return answer()
        }
        const v = r.value
        if (!v || !ArrayBuffer.isView(v)) return fail('cut')
        const chunk = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
        received += chunk.byteLength
        if (start + received > o.maxBytes) return fail('size')
        if (end !== null && start + received > end) return fail('length')
        if (chunk.byteLength) {
          queue.push(chunk)
          queued += chunk.byteLength
        }
        answer()
      },
      () => {
        pulling = false
        stopIdle()
        fail('cut')
      },
    )
  }

  function read() {
    if (failure && queued === 0) return Promise.resolve(failure)
    if (waiter) {
      fail('closed') // a second read at once: never hand out pieces out of order
      return Promise.resolve(failure)
    }
    if (finished) return Promise.resolve({ done: true })
    return new Promise((resolve) => {
      const w = { resolve, flushDue: false, timer: null }
      w.timer = o.setTimer(() => {
        if (waiter !== w) return
        w.flushDue = true
        answer()
      }, o.flushMs)
      waiter = w
      answer()
    })
  }

  return { read, abort: (reason) => fail(reason), cancel: () => fail('closed'), received: () => received }
}

/** "1 GB", "512 MB" (decimal comma). */
function downloadSizeText(bytes) {
  const gb = bytes / (1024 * 1024 * 1024)
  const n = gb >= 1 ? `${Math.round(gb * 10) / 10} GB` : `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
  return n.replace('.', ',')
}

/**
 * { code, message } of a failed download (reason of createDownloadPump). o: { idleMs, maxMs, maxBytes }. Codes:
 * network (idle / cut / length), too-large (size), too-slow (max: open longer than maxMs), gone (closed, unknown).
 */
function downloadFailure(reason, o) {
  const opt = o || {}
  const secs = Math.max(1, Math.round((opt.idleMs || CANVASAPP_DOWNLOAD_IDLE_MS) / 1000))
  const mins = Math.max(1, Math.round((opt.maxMs || CANVASAPP_DOWNLOAD_MAX_MS) / 60_000))
  switch (reason) {
    case 'idle':
      return { code: 'network', message: `canvasapp.io.vn ngừng gửi video giữa chừng (${secs} giây không nhận thêm dữ liệu).` }
    case 'cut':
      return { code: 'network', message: 'Mất kết nối khi đang tải video từ canvasapp.io.vn.' }
    case 'length':
      return { code: 'network', message: 'Video tải về không khớp dung lượng canvasapp.io.vn báo (kết nối bị đóng giữa chừng).' }
    case 'size':
      return { code: 'too-large', message: `Video lớn hơn ${downloadSizeText(opt.maxBytes || CANVASAPP_VIDEO_MAX_BYTES)} — SanoVids không tải về máy được.` }
    case 'max':
      // its own code: the page continues on a new connection only when it can resume, never starts again from 0
      return { code: 'too-slow', message: `Tải video quá ${mins} phút nên SanoVids dừng lại.` }
    default:
      return { code: 'gone', message: 'Lượt tải video này đã kết thúc.' }
  }
}

/** The start of an error answer's body (≤ maxBytes, then cancelled; `signal` aborts the read), as text. Never throws. */
async function readErrorBody(body, maxBytes, signal) {
  if (!body || typeof body.getReader !== 'function') return ''
  let reader
  try {
    reader = body.getReader()
  } catch {
    return ''
  }
  const parts = []
  let size = 0
  const stop = () => {
    try {
      const p = reader.cancel()
      if (p && typeof p.then === 'function') p.then(undefined, () => undefined)
    } catch {
      /* already closed */
    }
  }
  if (signal) {
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  }
  try {
    while (size < maxBytes) {
      const r = await reader.read()
      if (!r || r.done || !r.value || !ArrayBuffer.isView(r.value)) break
      const v = r.value
      const piece = new Uint8Array(v.buffer, v.byteOffset, Math.min(v.byteLength, maxBytes - size)).slice()
      parts.push(piece)
      size += piece.byteLength
    }
  } catch {
    /* cut: what came is enough */
  }
  if (signal) signal.removeEventListener('abort', stop)
  stop()
  const all = new Uint8Array(size)
  let off = 0
  for (const p of parts) {
    all.set(p, off)
    off += p.byteLength
  }
  return new TextDecoder().decode(all)
}

/** A non-2xx answer for the page, like canvasapp:request's (JSON when it says so, else ≤ 2000 characters of text). */
function downloadAnswer(status, contentType, text) {
  const out = { ok: true, status, contentType }
  if (/json/i.test(contentType)) {
    try {
      out.json = JSON.parse(text)
    } catch {
      out.text = text.slice(0, 2000)
    }
  } else {
    out.text = text.slice(0, 2000)
  }
  return out
}

/**
 * The downloads of the gateway. deps: { fetch(url, { headers, signal }) → Response-like, withSlot(fn) (a slot of the
 * 'download' lane, held until fn's promise settles), matchRoute(path) → { binary, url, key } | null, setTimer,
 * clearTimer, now, limits? } (limits overrides the constants above — development mode, tests).
 *   open(owner, { id, path, from })   → { ok: true, id, status, contentType, from, total, resumable }   (streaming)
 *                                     | { ok: true, status, contentType, json?, text? }                (not 200 / 206)
 *                                     | { ok: false, code, message }   bad-request | busy | not-allowed | gone |
 *                                       network | too-large | bad-range (not-allowed also = a redirect to http,
 *                                       refused by deps.fetch with error.code 'insecure-redirect' before it is sent)
 *   read(owner, { id })               → { ok: true, done: false, bytes } | { ok: true, done: true } | { ok: false, … }
 *                                       (code network | too-large | too-slow | gone)
 *   close(owner, { id })              → { ok: true } (idempotent; ends a download still waiting for its slot too)
 *   closeAll(owner?)                  every download of that page (all without owner): reload, crash, logout.
 * Only the page (owner = webContents id) that opened a download may read or close it. Every end frees the slot once.
 */
function createDownloadSessions(deps) {
  const lim = Object.assign(
    {
      maxBytes: CANVASAPP_VIDEO_MAX_BYTES,
      chunkBytes: CANVASAPP_DOWNLOAD_CHUNK_BYTES,
      flushMs: CANVASAPP_DOWNLOAD_FLUSH_MS,
      headersMs: CANVASAPP_DOWNLOAD_HEADERS_MS,
      idleMs: CANVASAPP_DOWNLOAD_IDLE_MS,
      pullIdleMs: CANVASAPP_DOWNLOAD_PULL_IDLE_MS,
      maxMs: CANVASAPP_DOWNLOAD_MAX_MS,
      maxSessions: CANVASAPP_DOWNLOAD_MAX_SESSIONS,
      errorBodyBytes: CANVASAPP_DOWNLOAD_ERROR_BODY_BYTES,
    },
    deps.limits || {},
  )
  const sessions = new Map()
  const tags = new Map() // path → { validator, at }
  const refusal = (code, message) => ({ ok: false, code, message })
  const failure = (reason) => {
    const f = downloadFailure(reason, lim)
    return refusal(f.code, f.message)
  }

  function tagOf(key) {
    const t = tags.get(key)
    if (!t) return null
    if (deps.now() - t.at >= CANVASAPP_DOWNLOAD_TAG_MS) {
      tags.delete(key)
      return null
    }
    return t.validator
  }
  function rememberTag(key, validator) {
    tags.delete(key)
    tags.set(key, { validator, at: deps.now() })
    while (tags.size > CANVASAPP_DOWNLOAD_MAX_TAGS) tags.delete(tags.keys().next().value)
  }

  /** The one way a download ends: timers off, body cancelled, request aborted, slot freed — once. */
  function end(s) {
    if (s.ended) return
    s.ended = true
    for (const k of ['headerTimer', 'pullTimer', 'maxTimer']) {
      if (s[k] !== null) deps.clearTimer(s[k])
      s[k] = null
    }
    sessions.delete(s.id)
    // the clock of the video's validator starts again: a cut after a long download can still resume
    if (s.validator) rememberTag(s.key, s.validator)
    if (s.pump) s.pump.cancel()
    try {
      s.controller.abort()
    } catch {
      /* nothing in flight */
    }
    const release = s.release
    s.release = null
    if (release) release()
  }

  function armPull(s) {
    if (s.pullTimer !== null) deps.clearTimer(s.pullTimer)
    s.pullTimer = deps.setTimer(() => {
      s.pullTimer = null
      end(s)
    }, lim.pullIdleMs)
  }

  function owned(owner, args) {
    const id = args && typeof args === 'object' && typeof args.id === 'string' ? args.id : ''
    if (!CANVASAPP_DOWNLOAD_ID_RE.test(id)) return null
    const s = sessions.get(id)
    return s && s.owner === owner ? s : null
  }

  function cancelBody(res) {
    try {
      const p = res && res.body && typeof res.body.cancel === 'function' ? res.body.cancel() : null
      if (p && typeof p.then === 'function') p.then(undefined, () => undefined)
    } catch {
      /* already closed */
    }
  }

  async function open(owner, args) {
    const a = args && typeof args === 'object' ? args : {}
    const id = typeof a.id === 'string' && CANVASAPP_DOWNLOAD_ID_RE.test(a.id) ? a.id : null
    if (!id) return refusal('bad-request', 'Mã lượt tải video không hợp lệ.')
    if (sessions.has(id)) return refusal('busy', 'Mã lượt tải video này đang được dùng.')
    const m = deps.matchRoute(a.path)
    if (!m || !m.binary) return refusal('not-allowed', `SanoVids không được phép tải ${String(a.path).slice(0, 80)}.`)
    if (sessions.size >= lim.maxSessions) return refusal('busy', 'Đang tải quá nhiều video cùng lúc — SanoVids tải video này sau.')
    const s = { id, owner, key: m.key, controller: new AbortController(), pump: null, release: null, ended: false, reading: false, headerTimer: null, pullTimer: null, maxTimer: null, timedOut: false, validator: null }
    sessions.set(id, s)

    // One slot of the 'download' lane for the whole download. Closed while waiting: the slot is let go at once.
    const got = await new Promise((resolve) => {
      const held = () => {
        if (s.ended) {
          resolve(false)
          return Promise.resolve()
        }
        return new Promise((done) => {
          s.release = done
          resolve(true)
        })
      }
      let slot
      try {
        slot = Promise.resolve(deps.withSlot(held))
      } catch (e) {
        slot = Promise.reject(e)
      }
      slot.then(undefined, () => resolve(false))
    })
    if (!got || s.ended) {
      end(s)
      return failure('closed')
    }

    const validator = tagOf(s.key)
    const from = validator ? downloadStartByte(a.from, lim.maxBytes) : 0
    s.headerTimer = deps.setTimer(() => {
      s.headerTimer = null
      s.timedOut = true
      s.controller.abort()
    }, lim.headersMs)
    let res
    try {
      res = await deps.fetch(m.url, { headers: downloadHeaders(from, validator), signal: s.controller.signal })
    } catch (e) {
      const closed = s.ended && !s.timedOut
      end(s)
      if (closed) return failure('closed')
      if (e && e.code === 'insecure-redirect') {
        return refusal('not-allowed', 'canvasapp.io.vn chuyển việc tải video sang một địa chỉ không mã hoá (http) — SanoVids không tải.')
      }
      return refusal('network', s.timedOut ? 'canvasapp.io.vn không phản hồi (quá thời gian chờ).' : `Không kết nối được tới canvasapp.io.vn (${(e && e.message) || e}).`)
    }
    if (s.ended) {
      cancelBody(res)
      return failure('closed')
    }
    if (!res || typeof res.status !== 'number') {
      end(s)
      return refusal('network', 'canvasapp.io.vn trả về câu trả lời lạ.')
    }
    const header = (name) => {
      const v = res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null
      return typeof v === 'string' ? v : null
    }
    const contentType = header('content-type') || ''
    const validatorNow = strongValidator(header('etag'), header('last-modified'))
    const plan = downloadPlan({
      status: res.status,
      from,
      contentLength: header('content-length'),
      contentRange: header('content-range'),
      contentEncoding: header('content-encoding'),
      acceptRanges: header('accept-ranges'),
      validator: validatorNow,
      sent: from > 0 ? validator : null,
      maxBytes: lim.maxBytes,
    })
    if (plan.kind === 'answer') {
      const text = await readErrorBody(res.body, lim.errorBodyBytes, s.controller.signal) // still under the headers timer
      end(s)
      return downloadAnswer(res.status, contentType, text)
    }
    if (plan.kind !== 'stream') {
      cancelBody(res)
      end(s)
      if (plan.kind === 'too-large') return failure('size')
      return refusal('bad-range', 'canvasapp.io.vn trả về phần video không khớp chỗ đang tải.')
    }
    deps.clearTimer(s.headerTimer)
    s.headerTimer = null
    s.validator = validatorNow
    if (validatorNow) rememberTag(s.key, validatorNow)
    else tags.delete(s.key)
    let reader = null
    try {
      reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null
    } catch {
      reader = null
    }
    if (!reader) reader = { read: () => Promise.resolve({ done: true }), cancel: () => Promise.resolve() }
    s.pump = createDownloadPump({
      reader,
      start: plan.from,
      end: plan.end,
      maxBytes: lim.maxBytes,
      chunkBytes: lim.chunkBytes,
      flushMs: lim.flushMs,
      idleMs: lim.idleMs,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
    })
    s.maxTimer = deps.setTimer(() => {
      s.maxTimer = null
      if (s.pump) s.pump.abort('max')
    }, lim.maxMs)
    armPull(s)
    return { ok: true, id, status: res.status, contentType, from: plan.from, total: plan.total, resumable: plan.resumable }
  }

  async function read(owner, args) {
    const s = owned(owner, args)
    if (!s) return failure('closed')
    if (!s.pump || s.reading) return refusal('busy', 'Lượt tải video này đang mở hoặc đang được đọc.')
    s.reading = true
    if (s.pullTimer !== null) deps.clearTimer(s.pullTimer)
    s.pullTimer = null
    try {
      const r = await s.pump.read()
      if (r && r.bytes) return { ok: true, done: false, bytes: r.bytes }
      end(s)
      if (r && r.done) return { ok: true, done: true }
      return failure(r && r.reason)
    } catch (e) {
      end(s)
      return refusal('network', `Không đọc được video (${(e && e.message) || e}).`)
    } finally {
      s.reading = false
      if (!s.ended) armPull(s)
    }
  }

  function close(owner, args) {
    const s = owned(owner, args)
    if (s) end(s)
    return { ok: true }
  }

  function closeAll(owner) {
    for (const s of [...sessions.values()]) if (owner === undefined || s.owner === owner) end(s)
  }

  return { open, read, close, closeAll, size: () => sessions.size }
}
// </canvasapp-downloads>

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
  // never the video stream: it only comes in pieces (canvasapp:downloadOpen)
  const match = matchCanvasappRequest(method, req.path)
  if (!match) return gatewayError('not-allowed', `SanoVids không được phép gọi ${method} ${String(req.path).slice(0, 80)}.`)
  const { route, url } = match

  // Job list: at most once every 15 s per project, whatever the renderer asks.
  const cacheKey = method === 'GET' && url.pathname === '/api/video-jobs' ? url.search : null
  if (cacheKey !== null) {
    const hit = canvasappJobListCache.get(cacheKey)
    if (hit && Date.now() - hit.at < CANVASAPP_JOBS_MIN_MS) return hit.result
  }

  const headers = { Accept: 'application/json' }
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
    const result = await withCanvasappSlot('api', async () => {
      // The clock starts when the request is really sent, not while it waits for a slot: a timeout then means
      // canvasapp did not answer, never "not sent yet".
      timer = setTimeout(() => controller.abort(), 60_000)
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

// <canvasapp-net-get> (pure; src/providers/__tests__/gatewayDownloads.test.ts runs this block as-is with a fake net.request)
/**
 * The GET of a video for <canvasapp-downloads> (its deps.fetch), through net.request rather than session.fetch:
 * session.fetch follows every redirect, https → http included, and its Response never says where it ended (url is
 * always '' — Electron's net-fetch builds it without one), so a downgrade could not even be seen. Here redirect is
 * 'manual' and a redirect is followed only to an https URL: the request to an http URL is never sent (Electron
 * cancels a redirect that is not followed during the 'redirect' event; this aborts it at once).
 * o: { request(options) → ClientRequest (net.request), toWeb(IncomingMessage) → web ReadableStream, session }.
 * Resolves { status, headers: { get(name) }, body: web ReadableStream | null }; rejects on a network error, when
 * init.signal aborts (which also aborts a body being read) and on a refused redirect (error.code 'insecure-redirect').
 */
function canvasappNetGet(o, url, init) {
  return new Promise((resolve, reject) => {
    const signal = init && init.signal
    let settled = false
    let req = null
    const fail = (e) => {
      if (settled) return
      settled = true
      reject(e)
    }
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' })
    const stop = () => {
      try {
        if (req) req.abort()
      } catch {
        /* already over */
      }
    }
    if (signal && signal.aborted) return fail(aborted())
    try {
      req = o.request({ method: 'GET', url, session: o.session, credentials: 'include', redirect: 'manual', bypassCustomProtocolHandlers: true })
      for (const [name, value] of Object.entries((init && init.headers) || {})) req.setHeader(name, value)
    } catch (e) {
      return fail(e)
    }
    req.on('redirect', (_status, _method, redirectUrl) => {
      if (downloadRedirectOk(redirectUrl)) return req.followRedirect()
      fail(Object.assign(new Error('Chuyển hướng sang http bị từ chối.'), { code: 'insecure-redirect' }))
      stop()
    })
    req.on('response', (res) => {
      if (settled) return
      settled = true
      const headers = (res && res.headers) || {}
      const get = (name) => {
        const v = headers[String(name).toLowerCase()]
        return v === undefined || v === null ? null : Array.isArray(v) ? v.join(', ') : String(v)
      }
      const status = res.statusCode
      resolve({ status, headers: { get }, body: [101, 204, 205, 304].includes(status) ? null : o.toWeb(res) })
    })
    req.on('error', (e) => fail(e))
    req.on('abort', () => fail(aborted()))
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          fail(aborted())
          stop()
        },
        { once: true },
      )
    }
    req.end()
  })
}

/** Where a video download may be redirected: https only (never http, never another scheme). */
function downloadRedirectOk(url) {
  try {
    return new URL(String(url)).protocol === 'https:'
  } catch {
    return false
  }
}
// </canvasapp-net-get>

/** Video downloads of the gateway (<canvasapp-downloads>): the 'download' lane, the canvasapp partition, the allowlist. */
const canvasappDownloads = createDownloadSessions({
  fetch: (url, init) => canvasappNetGet({ request: (opts) => net.request(opts), toWeb: (res) => Readable.toWeb(res), session: canvasappSession() }, url, init),
  withSlot: (fn) => withCanvasappSlot('download', fn),
  matchRoute: (rawPath) => {
    const m = matchCanvasappRoute('GET', rawPath)
    return m ? { binary: !!m.route.binary, url: m.url.toString(), key: m.url.pathname } : null
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
  now: () => Date.now(),
})

const canvasappDownloadOwners = new WeakSet()

/** A page that reloads, navigates away, crashes or closes stops its video downloads at once (their slots are freed). */
function watchDownloadOwner(wc) {
  if (!wc || canvasappDownloadOwners.has(wc)) return
  canvasappDownloadOwners.add(wc)
  const owner = wc.id
  const closeAll = () => canvasappDownloads.closeAll(owner)
  wc.once('destroyed', closeAll)
  wc.on('render-process-gone', closeAll)
  // Electron ≥ 25 puts the details on the event object; older builds pass them as arguments.
  wc.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
    const main = details && typeof details.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame !== false
    const sameDocument = details && typeof details.isSameDocument === 'boolean' ? details.isSameDocument : isInPlace === true
    if (main && !sameDocument) closeAll()
  })
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
  canvasappDownloads.closeAll()
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
  ipcMain.handle(
    'canvasapp:downloadOpen',
    guard((event, args) => {
      watchDownloadOwner(event.sender)
      return canvasappDownloads.open(event.sender.id, args)
    }),
  )
  ipcMain.handle('canvasapp:downloadRead', guard((event, args) => canvasappDownloads.read(event.sender.id, args)))
  ipcMain.handle('canvasapp:downloadClose', guard((event, args) => canvasappDownloads.close(event.sender.id, args)))
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
//   files:trashSaved    moves to the Windows Recycle Bin (shell.trashItem, never a permanent delete) ONLY files main
//                       itself wrote into that allowlisted folder for that folder node / take — recorded in its own
//                       ledger (userData/saved-files.json: names, sizes, SHA-256, file identity; never 'autosave'
//                       writes) — still exactly as written, and only on a fixed disk. The page names ledger group ids,
//                       never a file or a path.
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
 * no leading / trailing dots or spaces (never "." or ".."), reserved device names get "_", names longer than `max`
 * are cut keeping their extension.
 */
function sanitizeSaveName(raw, max = SAVE_MAX_NAME) {
  if (typeof raw !== 'string') return null
  let s = raw.replace(SAVE_LONE_SURROGATE_RE, '').normalize('NFC').replace(SAVE_FORMAT_CHARS_RE, '')
  s = s.replace(SAVE_BAD_CHARS_RE, '-').replace(/\s+/g, ' ').trim()
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!s) return null
  if (s.length > max) {
    const ext = saveNameExt(s)
    const tail = ext && ext.length <= 8 ? '.' + ext : ''
    s = cutSaveText(s, max - tail.length).replace(/[.\s]+$/, '') + tail
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
 * (EEXIST). Drives without hard links (FAT / exFAT sticks, some shares): `data` is written again under the real name,
 * created exclusively ('wx': EEXIST when a file appeared there meanwhile — a rename would silently replace it), then
 * the temp file goes. Only a file this call created is ever removed again (a write cut short).
 */
async function claimSaveName(fsp, part, target, data) {
  try {
    await fsp.link(part, target)
    await fsp.unlink(part).catch(() => undefined)
    return
  } catch (e) {
    if (e && e.code === 'EEXIST') throw e
  }
  const fh = await fsp.open(target, 'wx')
  let written = false
  try {
    await fh.writeFile(data)
    written = true
  } finally {
    await fh.close().catch(() => undefined)
    if (!written) await fsp.unlink(target).catch(() => undefined)
  }
  await fsp.unlink(part).catch(() => undefined)
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
        const data = saveFileData(files[i])
        part = await writeSavePart(fsp, target, data)
        await claimSaveName(fsp, part, target, data)
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

// ---- the ledger of folder-node writes (userData/saved-files.json) and moving them to the Recycle Bin ----
// { v: 1, groups: [{ id, folder, folderId, takeId, via, at, files: [{ name, size, sha256, ino, birthNs }], primaryTrashed? }] }
//   id      16 hex chars (the `recorded` answer of files:writeToFolder; the page sends it back to files:trashSaved);
//   folder  folderKey of the folder written into; folderId / takeId / via: the owner the page gave with the write;
//   files   files[0] = the primary (video, or the poster .jpg written without one), then its companions (the prompt .txt);
//           ino / birthNs: the file's identity right after the write (file id + creation time, decimal strings): a file
//           put back under the same name later — even with the same bytes — is another file and is never moved;
//   primaryTrashed  kept only for companions that could not follow their primary to the Recycle Bin (a retry).
// Every write into a folder drops the entries its new names prove gone (ledgerWithout: writes never overwrite).
// Lost or broken ledger = nothing can be moved (the safe side). The page never names a file or a path to move.
const SAVE_LEDGER_VERSION = 1
const SAVE_LEDGER_MAX_GROUPS = 3000
/** Ledger names may be a little longer than SAVE_MAX_NAME: writeGroupExclusive adds " (n)". */
const SAVE_LEDGER_MAX_NAME = SAVE_MAX_NAME + 16
// Only what a folder node writes can ever go to the Recycle Bin: videos, posters, the prompt .txt (never a .zip / .json).
const SAVE_TRASH_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'txt'])
/** Folder node / take ids (the page's ids). */
const SAVE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const SAVE_GROUP_ID_RE = /^[0-9a-f]{16}$/
const SAVE_SHA_RE = /^[0-9a-f]{64}$/
/** Where a write comes from (src/lib/desktopFiles.ts SaveVia). 'autosave' groups are never moved. */
const SAVE_VIAS = ['link', 'again', 'restore', 'autosave', 'manual']
const SAVE_TRASH_MAX_ITEMS = 200
const SAVE_TRASH_MAX_GROUPS = 20
/**
 * A file of at least this size with no data allocated on the disk is not here: a OneDrive / cloud "online-only"
 * placeholder (or an all-holes sparse file). Never hashed (reading it would download it) and never moved: kept.
 * (Smaller files may legitimately have no allocation: NTFS keeps them inside the MFT record.)
 */
const SAVE_CLOUD_MIN_BYTES = 4096
const SAVE_HASH_MIN_MS = 60_000
const SAVE_HASH_BYTES_PER_S = 10 * 1024 * 1024
/** A file id / creation time in ns, as recorded (decimal string of a bigint). */
const SAVE_FILE_ID_RE = /^\d{1,40}$/
/**
 * GetDriveType: the only drive type files:trashSaved ever moves files on — a disk fixed in the computer (an external
 * USB hard disk reports itself fixed and has a Recycle Bin too; a SUBST drive reports the drive it points into).
 * Removable sticks, mapped network drives, CD / DVD, RAM disks and unknown roots (0 unknown, 1 no root, 2 removable,
 * 4 network, 5 CD-ROM, 6 RAM disk) may have no Recycle Bin, where Windows could delete instead: the file stays ('failed').
 */
const SAVE_DRIVE_FIXED = 3

/** A name as recorded in the ledger: exactly what sanitizeSaveName keeps, of a type a folder node writes. */
function isLedgerName(name) {
  return typeof name === 'string' && sanitizeSaveName(name, SAVE_LEDGER_MAX_NAME) === name && SAVE_TRASH_EXT.has(saveNameExt(name))
}

/** `owner` of files:writeToFolder → { folderId, takeId, via }, or null (the write happens, nothing is recorded). */
function checkSaveOwner(o) {
  if (!o || typeof o !== 'object') return null
  const { folderId, takeId, via } = o
  if (typeof folderId !== 'string' || !SAVE_ID_RE.test(folderId)) return null
  if (typeof takeId !== 'string' || !SAVE_ID_RE.test(takeId)) return null
  if (typeof via !== 'string' || !SAVE_VIAS.includes(via)) return null
  return { folderId, takeId, via }
}

/**
 * files:trashSaved arguments → { folderPath, folderId, items: [{ takeId, groupIds }] } or { error }: an absolute folder
 * path, a folder node id, 1–200 items with distinct take ids, each with 1–20 ledger group ids (16 hex, deduplicated).
 */
function checkTrashArgs(args, pathMod) {
  const bad = { error: 'Yêu cầu không hợp lệ.' }
  if (!args || typeof args !== 'object') return bad
  if (!folderKey(args.folderPath, pathMod)) return bad
  if (typeof args.folderId !== 'string' || !SAVE_ID_RE.test(args.folderId)) return bad
  if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > SAVE_TRASH_MAX_ITEMS) return bad
  const items = []
  const seen = new Set()
  for (const it of args.items) {
    if (!it || typeof it !== 'object' || typeof it.takeId !== 'string' || !SAVE_ID_RE.test(it.takeId) || seen.has(it.takeId)) return bad
    seen.add(it.takeId)
    const ids = it.groupIds
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > SAVE_TRASH_MAX_GROUPS) return bad
    if (!ids.every((g) => typeof g === 'string' && SAVE_GROUP_ID_RE.test(g))) return bad
    items.push({ takeId: it.takeId, groupIds: [...new Set(ids)] })
  }
  return { folderPath: args.folderPath, folderId: args.folderId, items }
}

/** One ledger group checked value by value (a copy with known fields only), or null. */
function checkLedgerGroup(g, pathMod) {
  if (!g || typeof g !== 'object') return null
  if (typeof g.id !== 'string' || !SAVE_GROUP_ID_RE.test(g.id)) return null
  if (typeof g.folder !== 'string' || folderKey(g.folder, pathMod) !== g.folder) return null
  const owner = checkSaveOwner(g)
  if (!owner) return null
  if (typeof g.at !== 'number' || !Number.isFinite(g.at) || g.at < 0) return null
  if (!Array.isArray(g.files) || g.files.length < 1 || g.files.length > SAVE_MAX_FILES) return null
  const files = []
  const names = new Set()
  for (const f of g.files) {
    if (!f || typeof f !== 'object' || !isLedgerName(f.name) || names.has(f.name.toLowerCase())) return null
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > SAVE_MAX_FILE_BYTES) return null
    if (typeof f.sha256 !== 'string' || !SAVE_SHA_RE.test(f.sha256)) return null
    // The identity of the file as written: without it a file can never be told from one put back under its name.
    if (typeof f.ino !== 'string' || !SAVE_FILE_ID_RE.test(f.ino) || typeof f.birthNs !== 'string' || !SAVE_FILE_ID_RE.test(f.birthNs)) return null
    names.add(f.name.toLowerCase())
    files.push({ name: f.name, size: f.size, sha256: f.sha256, ino: f.ino, birthNs: f.birthNs })
  }
  const out = { id: g.id, folder: g.folder, folderId: owner.folderId, takeId: owner.takeId, via: owner.via, at: g.at, files }
  if (g.primaryTrashed === true) out.primaryTrashed = true
  return out
}

/**
 * userData/saved-files.json, checked value by value: unknown version / garbage → empty; invalid groups, groups of a
 * folder no longer in the allowlist (`allowed`: folder keys of save-locations.json) and duplicated ids are dropped;
 * at most SAVE_LEDGER_MAX_GROUPS (the newest).
 */
function parseSaveLedger(raw, allowed, pathMod) {
  const ok = Array.isArray(allowed) ? allowed : []
  const checked = []
  if (raw && typeof raw === 'object' && raw.v === SAVE_LEDGER_VERSION && Array.isArray(raw.groups)) {
    for (const g of raw.groups) {
      const c = checkLedgerGroup(g, pathMod)
      if (c && ok.includes(c.folder)) checked.push(c)
    }
  }
  const count = new Map()
  for (const g of checked) count.set(g.id, (count.get(g.id) || 0) + 1)
  // The same id twice: something is wrong with both, neither can be moved.
  const groups = checked.filter((g) => count.get(g.id) === 1)
  return { v: SAVE_LEDGER_VERSION, groups: groups.slice(-SAVE_LEDGER_MAX_GROUPS) }
}

/**
 * The ledger group of a write: `names` (as written, " (n)" included) with `digests` ([{ size, sha256, ino, birthNs }],
 * same order: the bytes written and the identity of each file right after the write), into the folder `dirKey`
 * (folderKey), for `owner`. → the group, or null when anything is not recordable.
 */
function ledgerGroup(dirKey, owner, names, digests, at, id, pathMod) {
  const o = checkSaveOwner(owner)
  if (!o || !Array.isArray(names) || !Array.isArray(digests) || names.length !== digests.length) return null
  const files = names.map((name, i) => {
    const d = digests[i] || {}
    return { name, size: d.size, sha256: d.sha256, ino: d.ino, birthNs: d.birthNs }
  })
  return checkLedgerGroup({ id, folder: dirKey, ...o, at, files }, pathMod)
}

/**
 * The ledger without the entries `names` prove gone: those names were just written into the folder `dirKey`, and a
 * write never replaces a file, so whatever the ledger recorded under them was removed meanwhile (Explorer, another
 * program) — a later file under the same name must never be taken for it. A group whose primary name is reused goes
 * whole; a reused companion name drops that entry only (a group left without files goes). Names compare like the file
 * system does (case-insensitive on Windows). → the same ledger object when nothing changes.
 */
function ledgerWithout(ledger, dirKey, names, pathMod) {
  const groups = ledger && Array.isArray(ledger.groups) ? ledger.groups : null
  if (!groups || !dirKey || !Array.isArray(names) || !names.length) return ledger
  const norm = pathMod.sep === '\\' ? (n) => String(n).toLowerCase() : (n) => String(n)
  const taken = new Set(names.filter((n) => typeof n === 'string' && n !== '').map(norm))
  let changed = false
  const next = []
  for (const g of groups) {
    if (!g || g.folder !== dirKey || !Array.isArray(g.files) || !g.files.length) {
      next.push(g)
      continue
    }
    if (!g.primaryTrashed && taken.has(norm(g.files[0].name))) {
      changed = true
      continue
    }
    const files = g.files.filter((f) => !taken.has(norm(f.name)))
    if (files.length === g.files.length) {
      next.push(g)
      continue
    }
    changed = true
    if (files.length) next.push({ ...g, files })
  }
  return changed ? { v: SAVE_LEDGER_VERSION, groups: next } : ledger
}

/** { ino, birthNs } (decimal strings) of an lstat result read with { bigint: true }; null for anything else. */
function savedFileIdentity(st) {
  if (!st || typeof st.ino !== 'bigint' || typeof st.birthtimeNs !== 'bigint') return null
  return { ino: st.ino.toString(), birthNs: st.birthtimeNs.toString() }
}

/** Is the file at `st` (savedStatOf) the very file recorded in `entry` (same file id and creation time)? */
function sameSavedIdentity(entry, st) {
  const id = st && st.identity
  return !!id && typeof entry.ino === 'string' && typeof entry.birthNs === 'string' && id.ino === entry.ino && id.birthNs === entry.birthNs
}

/**
 * An lstat result (BigIntStats read with { bigint: true }; a plain one from a test) → what the checks read: numbers for
 * size / mtimeMs / blocks, the exact mtime (ns) and identity when known. null stays null.
 */
function savedStatOf(st) {
  if (!st) return null
  const num = (v) => (typeof v === 'bigint' ? Number(v) : v)
  return {
    size: num(st.size),
    mtimeMs: num(st.mtimeMs),
    mtimeNs: typeof st.mtimeNs === 'bigint' ? st.mtimeNs.toString() : undefined,
    ino: typeof st.ino === 'bigint' ? st.ino.toString() : st.ino,
    blocks: num(st.blocks),
    identity: savedFileIdentity(st),
    isFile: () => typeof st.isFile === 'function' && st.isFile(),
    isSymbolicLink: () => typeof st.isSymbolicLink === 'function' && st.isSymbolicLink(),
  }
}

/** The ledger without `removeIds`, with `add` (a group with an existing id replaces it in place), capped. */
function ledgerWith(ledger, add, removeIds) {
  const drop = new Set(Array.isArray(removeIds) ? removeIds : [])
  const groups = (ledger && Array.isArray(ledger.groups) ? ledger.groups : []).filter((g) => !drop.has(g.id))
  for (const g of Array.isArray(add) ? add : []) {
    if (!g || typeof g.id !== 'string') continue
    const i = groups.findIndex((x) => x.id === g.id)
    if (i >= 0) groups[i] = g
    else groups.push(g)
  }
  return { v: SAVE_LEDGER_VERSION, groups: groups.slice(-SAVE_LEDGER_MAX_GROUPS) }
}

/**
 * The groups one trashSaved item may move: its `groupIds` AND this folder node / take AND written into this folder
 * (`dirKey`) AND never 'autosave'. None → unknown (saved by an older build, ledger lost, not this wire's files);
 * elsewhere = those groups were written into another folder (the node now points elsewhere): nothing is moved.
 */
function selectTrashGroups(ledger, dirKey, folderId, item) {
  const wanted = new Set(item && Array.isArray(item.groupIds) ? item.groupIds : [])
  const takeId = item && item.takeId
  const owned = (ledger && Array.isArray(ledger.groups) ? ledger.groups : []).filter(
    (g) => wanted.has(g.id) && g.folderId === folderId && g.takeId === takeId && g.via !== 'autosave',
  )
  const groups = owned.filter((g) => g.folder === dirKey)
  return { groups, unknown: groups.length === 0, elsewhere: groups.length === 0 && owned.length > 0 }
}

/** '' when `st` (lstat; null = nothing there) may still be the recorded file, else 'missing' | 'changed'. */
function savedFileStatProblem(entry, st) {
  if (!st) return 'missing'
  if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) return 'changed'
  if (typeof st.isFile !== 'function' || !st.isFile()) return 'changed'
  if (st.size !== entry.size) return 'changed'
  return ''
}

/**
 * Is the file at `st` still exactly the recorded one? 'ok' only for a regular file (not a link) of the recorded size
 * whose SHA-256 (`sha`, hex) is the recorded one; 'missing' when nothing is there; 'changed' otherwise (it is the user's).
 */
function judgeSavedFile(entry, st, sha) {
  const problem = savedFileStatProblem(entry, st)
  if (problem) return problem
  return typeof sha === 'string' && SAVE_SHA_RE.test(sha) && sha === entry.sha256 ? 'ok' : 'changed'
}

/** No data of this file on the disk (see SAVE_CLOUD_MIN_BYTES): kept, never read. */
function savedFileOnlineOnly(st) {
  return !!st && typeof st.blocks === 'number' && st.blocks === 0 && typeof st.size === 'number' && st.size >= SAVE_CLOUD_MIN_BYTES
}

/** The same file before and after hashing (size, last write, file id): nothing replaced or rewrote it meanwhile. */
function sameSavedStat(a, b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.mtimeNs === b.mtimeNs && a.ino === b.ino
}

/** Time allowed to hash a file: 60 s, or 10 MB/s for big files on slow drives. */
function saveHashTimeoutMs(size) {
  return Math.max(SAVE_HASH_MIN_MS, Math.ceil((Number(size) / SAVE_HASH_BYTES_PER_S) * 1000) || 0)
}

/** Windows network shares (\\server\share) and device paths (\\?\, \\.\) have no Recycle Bin: never tried there. */
function saveTrashSupported(dir, pathMod) {
  return !(pathMod.sep === '\\' && /^[\\/]{2}/.test(String(dir)))
}

/**
 * The drive root whose type decides whether files may go to the Recycle Bin: 'X:\' of the folder's REAL path (links and
 * junctions resolved by the caller) on Windows; null for anything else there (a share, a device or volume path → never
 * moved). POSIX: '/' (no drive types; saveTrashDriveAllowed does not ask).
 */
function saveDriveRoot(realDir, pathMod) {
  if (pathMod.sep !== '\\') return '/'
  const m = /^([A-Za-z]):[\\/]/.exec(String(realDir))
  return m ? `${m[1].toUpperCase()}:\\` : null
}

/** May files on a drive of this type (GetDriveType number; null = could not be read) go to the Recycle Bin? */
function saveTrashDriveAllowed(driveType, pathMod) {
  if (pathMod.sep !== '\\') return true
  return driveType === SAVE_DRIVE_FIXED
}

/** `promise`, or a rejection as soon as `signal` (the watchdog) aborts. */
function withSaveAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(saveError('ETIMEDOUT', 'watchdog'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(saveError('ETIMEDOUT', 'watchdog'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/**
 * Move the files of ledger `groups` (selected by selectTrashGroups) out of `dir` to the Recycle Bin.
 * deps: fsp (lstat only, read with { bigint: true }), hashFile(path, timeoutMs, signal) → SHA-256 hex,
 * trash(absolutePath) (shell.trashItem: the ONLY way anything leaves the folder — never a delete), pathMod,
 * driveType (GetDriveType of the folder's real drive, Windows: only a fixed disk is ever tried), signal (watchdog: once
 * aborted, no new file is started; a move already handed to trash() is always awaited — shell.trashItem cannot be
 * stopped, and abandoning it would report a file as kept that still lands in the Recycle Bin).
 * Per file, decided only from lstat, the identity, the size and the hash (never from an error text or the mtime alone):
 *   gone → 'missing' (entry dropped); a link / not a regular file / another file (other file id or creation time: put
 *   back under the name) / other size / other hash / rewritten while hashed → 'changed' (kept: it is the user's now;
 *   dropped); online-only → 'failed' + cloud (kept; entry kept); hashing failed or timed out → 'failed' (entry kept);
 *   trash() resolved → 'trashed' (dropped); trash() failed → 'missing' when the file is gone, else 'failed' (kept for
 *   "Thử lại"). Network shares and drives that are not fixed disks → 'failed' without trying.
 * The primary goes first; companions (the prompt .txt) only follow a 'trashed' primary, each only when unchanged, and
 * are reported only then. Groups of another folder or written by 'autosave' are skipped (never touched, not reported).
 * → { results: [{ id, takeId, files: [{ name, role, result, cloud? }] }], keep: [groups to keep, possibly reduced], removeIds }
 */
async function trashSavedGroups(dir, groups, { fsp, hashFile, trash, pathMod, signal, driveType }) {
  const results = []
  const keep = []
  const removeIds = []
  const dirKey = folderKey(dir, pathMod)
  const supported = saveTrashSupported(dir, pathMod) && saveTrashDriveAllowed(driveType, pathMod)
  const aborted = () => !!(signal && signal.aborted)
  const lstatOrNull = async (p) => {
    try {
      return savedStatOf(await fsp.lstat(p, { bigint: true }))
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null
      throw e
    }
  }
  /** Gone after a failure → 'missing', still there (or unreadable) → 'failed'. */
  const goneOrFailed = async (p) => {
    try {
      return (await lstatOrNull(p)) ? 'failed' : 'missing'
    } catch {
      return 'failed'
    }
  }
  const moveOne = async (entry) => {
    const p = pathMod.join(dir, entry.name)
    if (!isLedgerName(entry.name) || !isDirectChild(dir, p, pathMod)) return { result: 'changed' }
    if (!supported || aborted()) return { result: 'failed' }
    let before
    try {
      before = await lstatOrNull(p)
    } catch {
      return { result: 'failed' }
    }
    const problem = savedFileStatProblem(entry, before)
    if (problem) return { result: problem }
    // Another file under the recorded name (deleted, then written again — even with the same bytes): the user's.
    if (!sameSavedIdentity(entry, before)) return { result: 'changed' }
    if (savedFileOnlineOnly(before)) return { result: 'failed', cloud: true }
    let sha
    try {
      sha = await withSaveAbort(Promise.resolve().then(() => hashFile(p, saveHashTimeoutMs(entry.size), signal)), signal)
    } catch {
      return { result: await goneOrFailed(p) }
    }
    let after
    try {
      after = await lstatOrNull(p)
    } catch {
      return { result: 'failed' }
    }
    if (!after) return { result: 'missing' }
    if (!sameSavedStat(before, after)) return { result: 'changed' }
    const verdict = judgeSavedFile(entry, after, sha)
    if (verdict !== 'ok') return { result: verdict }
    if (aborted()) return { result: 'failed' }
    // Never raced against the watchdog: the outcome of a move that has started is always the real one.
    try {
      await Promise.resolve().then(() => trash(pathMod.resolve(p)))
      return { result: 'trashed' }
    } catch {
      return { result: await goneOrFailed(p) }
    }
  }
  const report = (entry, role, r) => (r.cloud ? { name: entry.name, role, result: r.result, cloud: true } : { name: entry.name, role, result: r.result })
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || g.via === 'autosave' || !dirKey || g.folder !== dirKey || !Array.isArray(g.files) || g.files.length === 0) continue
    const files = []
    const failed = []
    const companions = async (list) => {
      for (const entry of list) {
        const r = await moveOne(entry)
        files.push(report(entry, 'companion', r))
        if (r.result === 'failed') failed.push(entry)
      }
    }
    if (g.primaryTrashed) {
      await companions(g.files)
      if (failed.length) keep.push({ ...g, files: failed })
      else removeIds.push(g.id)
    } else {
      const [primary, ...rest] = g.files
      const r = await moveOne(primary)
      files.push(report(primary, 'primary', r))
      if (r.result === 'trashed') {
        await companions(rest)
        if (failed.length) keep.push({ ...g, primaryTrashed: true, files: failed })
        else removeIds.push(g.id)
      } else if (r.result === 'failed') keep.push(g)
      else removeIds.push(g.id)
    }
    results.push({ id: g.id, takeId: g.takeId, files })
  }
  return { results, keep, removeIds }
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

// ---- the ledger of folder-node writes (rules above, in <save-rules>) ----
const SAVE_LEDGER_FILE = 'saved-files.json'
/**
 * files:trashSaved starts no new file after this: files not started by then stay where they are ('failed'). A move
 * already handed to shell.trashItem is awaited (it cannot be cancelled; its real outcome is reported).
 */
const SAVE_TRASH_WATCHDOG_MS = 5 * 60_000
let saveLedger = null
let saveLedgerChain = Promise.resolve()
/** Ledger groups a files:trashSaved call is moving right now: another call never touches them at the same time. */
const trashingIds = new Set()

function saveLedgerPath() {
  return path.join(app.getPath('userData'), SAVE_LEDGER_FILE)
}

/** The ledger from disk, checked value by value; missing / unreadable / broken → empty (nothing can be moved). */
async function loadSaveLedger() {
  try {
    return parseSaveLedger(JSON.parse(await fs.promises.readFile(saveLedgerPath(), 'utf8')), loadSaveState().folders, path)
  } catch {
    return parseSaveLedger(null, [], path)
  }
}

/** Written whole (tmp + rename); throws when it could not be stored. */
async function storeSaveLedger(next) {
  const file = saveLedgerPath()
  const tmp = `${file}.tmp`
  await fs.promises.writeFile(tmp, JSON.stringify(next), 'utf8')
  await renameSaveFile(fs.promises, tmp, file)
}

/**
 * fn(ledger) → the next ledger (or the same one), one call at a time. A next ledger becomes current only once stored,
 * so what the page was told (`recorded`) always survives a restart. → the current ledger.
 */
function withLedger(fn) {
  const run = saveLedgerChain.then(async () => {
    if (!saveLedger) saveLedger = await loadSaveLedger()
    const next = await fn(saveLedger)
    if (next && next !== saveLedger) {
      await storeSaveLedger(next)
      saveLedger = next
    }
    return saveLedger
  })
  saveLedgerChain = run.catch(() => undefined)
  return run
}

/** { size, sha256 } of a file as written (text = UTF-8, like fs.writeFile); hashed off the main thread. */
async function digestOf(f) {
  const data = f.bytes ? f.bytes : Buffer.from(f.text, 'utf8')
  const sha256 = Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256', data)).toString('hex')
  return { size: data.byteLength, sha256 }
}

/** SHA-256 (hex) of a file on disk, streamed; rejects after `timeoutMs` or when `signal` aborts. */
function hashSavedFile(p, timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const abort = signal ? AbortSignal.any([timeout, signal]) : timeout
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(p, { highWaterMark: 1024 * 1024, signal: abort })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

/** { ino, birthNs } of each file just written into `dir` (same order); null for one that could not be read. */
async function savedIdentities(dir, names) {
  const out = []
  for (const name of names) {
    try {
      out.push(savedFileIdentity(await fs.promises.lstat(path.join(dir, name), { bigint: true })))
    } catch {
      out.push(null)
    }
  }
  return out
}

/**
 * Names just written into `dir` (by any write: a folder node without an owner, the save dialog): ledger entries under
 * those names are forgotten (ledgerWithout). Never throws.
 */
async function forgetSavedNames(dir, names) {
  try {
    const dirKey = folderKey(dir, path)
    if (dirKey) await withLedger((ledger) => ledgerWithout(ledger, dirKey, names, path))
  } catch (e) {
    console.warn('[SanoVids] saved-files ledger not updated:', (e && e.message) || e)
  }
}

/**
 * Record a group just written into `dir` for `owner` → its id, or false (not recorded: it can never be moved). The
 * entries its names prove gone are forgotten in the same step, recorded or not.
 */
async function recordSavedGroup(dir, owner, names, files) {
  let digests = null
  try {
    const identities = await savedIdentities(dir, names)
    digests = []
    for (let i = 0; i < files.length; i++) digests.push({ ...(await digestOf(files[i])), ...(identities[i] || {}) })
  } catch (e) {
    digests = null
    console.warn('[SanoVids] saved files not hashed:', (e && e.message) || e)
  }
  try {
    const dirKey = folderKey(dir, path)
    let id = ''
    await withLedger((ledger) => {
      const pruned = ledgerWithout(ledger, dirKey, names, path)
      if (!digests) return pruned
      let gid
      do gid = crypto.randomBytes(8).toString('hex')
      while (pruned.groups.some((g) => g.id === gid))
      const group = ledgerGroup(dirKey, owner, names, digests, Date.now(), gid, path)
      if (!group) return pruned
      id = gid
      return ledgerWith(pruned, [group], [])
    })
    return id || false
  } catch (e) {
    console.warn('[SanoVids] saved files not recorded:', (e && e.message) || e)
    return false
  }
}

/** files:trashSaved reads a drive's type at most this often (a stick swapped for another under the same letter). */
const SAVE_DRIVE_TYPE_TTL_MS = 30_000
const saveDriveTypes = new Map() // root → { at, type }

/**
 * GetDriveType of the drive `dir` really lives on (links / junctions resolved; Windows only, else null): one hardened
 * PowerShell call (electron/signature.cjs checkDriveType) per root every SAVE_DRIVE_TYPE_TTL_MS. null = could not be
 * read (nothing is moved then). Never throws.
 */
async function saveDriveTypeOf(dir) {
  if (process.platform !== 'win32') return null
  let root = null
  try {
    root = saveDriveRoot(await fs.promises.realpath(dir), path)
  } catch {
    return null
  }
  if (!root) return null
  const hit = saveDriveTypes.get(root)
  if (hit && Date.now() - hit.at < SAVE_DRIVE_TYPE_TTL_MS) return hit.type
  const signature = require('./signature.cjs')
  const type = await signature.checkDriveType(root, { log: (line) => console.warn(`[SanoVids] ${line}`) })
  if (type !== null) saveDriveTypes.set(root, { at: Date.now(), type })
  return type
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
  let names
  try {
    names = await writeGroupExclusive(dir, checked.files, fs.promises, path)
  } catch (e) {
    return fileError(e && e.code === 'ENOENT' ? 'missing' : 'write-failed', fsErrorText(e))
  }
  // With a valid owner the group is recorded BEFORE answering (so the page can hand its id back to files:trashSaved).
  // Either way, ledger entries under the names just written are forgotten (the files they recorded are gone).
  const owner = checkSaveOwner(args.owner)
  if (!owner) {
    await forgetSavedNames(dir, names)
    return { ok: true, names }
  }
  return { ok: true, names, recorded: await recordSavedGroup(dir, owner, names, checked.files) }
}

/**
 * Move the files a cut "video → Thư mục" wire had copied to the Recycle Bin (src/lib/saveFolders.ts trashSavedFiles).
 * Only groups of the ledger: named by the page (groupIds), of this folder node and take, written into THIS allowlisted
 * folder, never by 'autosave', and each file still exactly as written (trashSavedGroups). → { ok: true, results }
 * (one per item: { takeId, unknown?, elsewhere?, files }) | { ok: false, code: 'bad-request' | 'not-allowed' | 'missing' }.
 */
async function filesTrashSaved(args) {
  const checked = checkTrashArgs(args, path)
  if (checked.error) return fileError('bad-request', checked.error)
  if (!isAllowedFolder(loadSaveState().folders, checked.folderPath, path)) {
    return fileError('not-allowed', 'Thư mục này chưa được chọn trên máy này.')
  }
  const dir = path.resolve(checked.folderPath)
  if (!(await isDirectory(dir))) return fileError('missing', 'Không tìm thấy thư mục (đã đổi tên, chuyển hoặc xoá?).')
  const dirKey = folderKey(dir, path)
  const ledger = await withLedger((current) => current)
  const picked = checked.items.map((item) => ({ item, ...selectTrashGroups(ledger, dirKey, checked.folderId, item) }))
  const claimed = []
  for (const p of picked) {
    p.busy = p.groups.filter((g) => trashingIds.has(g.id))
    p.groups = p.groups.filter((g) => !trashingIds.has(g.id))
    for (const g of p.groups) {
      trashingIds.add(g.id)
      claimed.push(g.id)
    }
  }
  try {
    const groups = picked.flatMap((p) => p.groups)
    const out = await trashSavedGroups(dir, groups, {
      fsp: fs.promises,
      hashFile: hashSavedFile,
      trash: (p) => shell.trashItem(p),
      pathMod: path,
      signal: AbortSignal.timeout(SAVE_TRASH_WATCHDOG_MS),
      // Only a fixed disk is ever tried (USB sticks, network drives… may have no Recycle Bin): read once per call.
      driveType: groups.length ? await saveDriveTypeOf(dir) : null,
    })
    try {
      // A kept group a write dropped meanwhile (ledgerWithout) is not brought back.
      await withLedger((current) => ledgerWith(current, out.keep.filter((g) => current.groups.some((x) => x.id === g.id)), out.removeIds))
    } catch (e) {
      // Not stored: the moved files read 'missing' next time and are dropped then.
      console.warn('[SanoVids] saved-files ledger not updated:', (e && e.message) || e)
    }
    const filesOf = new Map(out.results.map((r) => [r.id, r.files]))
    const results = picked.map(({ item, groups, busy, unknown, elsewhere }) => {
      const files = groups.flatMap((g) => filesOf.get(g.id) || [])
      // Being moved by another call right now: untouched here.
      for (const g of busy) files.push({ name: g.files[0].name, role: g.primaryTrashed ? 'companion' : 'primary', result: 'failed' })
      const r = { takeId: item.takeId, files }
      if (unknown) r.unknown = true
      if (elsewhere) r.elsewhere = true
      return r
    })
    return { ok: true, results }
  } finally {
    for (const id of claimed) trashingIds.delete(id)
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
  /** Names written so far: a folder node's file the save may have replaced (confirmed in the dialog) is never moved. */
  const names = []
  try {
    if (target === chosen) {
      // The user confirmed this exact file in the dialog (it asks before replacing one): replaced all at once.
      await writeSaveReplacing(fs.promises, target, saveFileData(primary))
    } else {
      // The extension was added here, after the dialog: that file was never confirmed, so it is not overwritten.
      const [written] = await writeGroupExclusive(targetDir, [{ ...primary, name: path.basename(target) }], fs.promises, path)
      target = path.join(targetDir, written)
    }
    names.push(path.basename(target))
    for (const f of checked.files.slice(1)) {
      const name = companionSaveName(target, f.name, path)
      if (!name) continue
      // Companions never overwrite: "<chosen name>.txt", else "<chosen name> (2).txt"…
      const [written] = await writeGroupExclusive(targetDir, [{ ...f, name }], fs.promises, path)
      names.push(written)
    }
    await storeSaveState({ ...loadSaveState(), lastSaveDir: targetDir })
    return { ok: true, path: target, names: [...names] }
  } catch (e) {
    return fileError('write-failed', fsErrorText(e))
  } finally {
    if (names.length) await forgetSavedNames(targetDir, names)
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
  ipcMain.handle('files:trashSaved', guard((_event, args) => filesTrashSaved(args)))
  ipcMain.handle('files:openFolder', guard((_event, args) => filesOpenFolder(args)))
  ipcMain.handle('files:saveAs', guard((event, args) => filesSaveAs(winOf(event), args)))
}
