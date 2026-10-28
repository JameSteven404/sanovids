// Opt-in Electron probe (not run by vitest / CI): the real electron/main.cjs + preload.cjs in SANO mode against a fake
// SANO page that holds a SANO-origin iframe. Checks in a running Electron what the source-text tests of
// hardeningRules.test.ts only read: just SANO's top frame gets sanoDesktop (preload: process.isMainFrame), and main
// answers just the main window's top frame (fromSano). Never signs in; every https request is refused and reported.
//
//   npx electron scripts/sano-desktop-probe.cjs        → one line per check; exit 0 = all passed
'use strict'
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, session } = require('electron')

// main.cjs must load synchronously (it registers schemes before 'ready'), so the port is picked, not asked for
// (SANO_PROBE_PORT / SANO_PROBE_PROFILE: a fixed port and a throwaway profile of the caller's choice)
const PORT = Number(process.env.SANO_PROBE_PORT) || 40000 + Math.floor(Math.random() * 20000)
const ORIGIN = `http://127.0.0.1:${PORT}`
const PROFILE = process.env.SANO_PROBE_PROFILE || path.join(os.tmpdir(), 'sanovids-sano-probe')
fs.rmSync(PROFILE, { recursive: true, force: true })
process.env.SANO_URL = `${ORIGIN}/`
process.env.SANOVIDS_PROFILE_DIR = PROFILE
// D253: no account server, so the in-app sign-in reports itself unconfigured (no network call)
delete process.env.SANO_API_URL

const checks = []
const refused = []
const check = (name, ok) => checks.push({ name, ok: ok === true })

http
  .createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(req.url === '/frame' ? '<p>frame</p>' : '<!doctype html><title>SANO probe</title><iframe src="/frame"></iframe>')
  })
  .listen(PORT, '127.0.0.1')

app.whenReady().then(() => {
  session.defaultSession.protocol.handle('https', (req) => {
    refused.push(req.url)
    return new Response('refused by the probe', { status: 502 })
  })
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.maximize = function () {}
})

let mainWin = null
app.on('browser-window-created', (_e, win) => {
  if (mainWin) return
  mainWin = win
  win.webContents.once('did-finish-load', () => run().catch((e) => check(`probe crashed: ${e && e.stack}`, false)).finally(finish))
})

const js = (wc, code) => wc.executeJavaScript(code, true)

async function run() {
  const wc = mainWin.webContents
  check("SANO's top frame: sanoDesktop.google = signIn, token, signOut", (await js(wc, 'Object.keys(window.sanoDesktop.google).join()')) === 'signIn,token,signOut')
  const sub = wc.mainFrame.frames[0]
  check("the iframe is at SANO's origin", !!sub && sub.origin === ORIGIN)
  check('SANO-origin iframe: no sanoDesktop', !!sub && (await sub.executeJavaScript('typeof window.sanoDesktop')) === 'undefined')
  check("main answers the main window's top frame (signOut → true)", (await js(wc, 'window.sanoDesktop.google.signOut()')) === true)
  check("account: SANO's top frame gets status (unconfigured without SANO_API_URL)", (await js(wc, 'window.sanoDesktop.account.status().then((s) => `${s.configured}/${s.signedIn}`)')) === 'false/false')
  check('account: unconfigured sign-in rejects (not-configured)', (await js(wc, "window.sanoDesktop.account.login({ identifier: 'a', password: 'b' }).catch((e) => e.code)")) === 'not-configured')
  // the same preload in another window at SANO's origin: the page gets sanoDesktop, main refuses every call
  const other = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), sandbox: true, contextIsolation: true, additionalArguments: [`--bdp-sano-origin=${ORIGIN}`] } })
  await other.loadURL(`${ORIGIN}/`)
  check('another window: signOut refused (false)', (await js(other.webContents, 'window.sanoDesktop.google.signOut()')) === false)
  check('another window: signIn refused (not-allowed)', (await js(other.webContents, 'window.sanoDesktop.google.signIn().then((r) => r.code)')) === 'not-allowed')
  check('another window: account.status refused (not-allowed)', (await js(other.webContents, 'window.sanoDesktop.account.status().catch((e) => e.code)')) === 'not-allowed')
  other.destroy()
  check('nothing went to https', refused.length === 0)
}

function finish() {
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`)
  if (refused.length) console.log('https refused:', refused)
  app.exit(checks.length && checks.every((c) => c.ok) ? 0 : 1)
}

setTimeout(() => {
  check('probe timed out', false)
  finish()
}, 30_000)

require('../electron/main.cjs')
