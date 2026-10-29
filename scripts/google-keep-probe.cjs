// Opt-in Electron probe (not run by vitest / CI) of Giữ đăng nhập Google (electron/google-keep-rules.cjs) in the real
// electron/main.cjs: Google account cookies in persist:canvasapp live as session cookies only (never in Chromium's
// cookie file) and come back from the encrypted userData/google-canvasapp.bin. Never signs in to Google: the cookies are
// fake ones the probe sets with random markers, and every https request is refused. Throwaway profiles only.
//
//   node scripts/google-keep-probe.cjs [path/to/electron.exe]   → one line per check; exit 0 = runs 1-3 passed
//
// Run 1 sets the cookies and quits normally; run 2 (same profile) reads them back; run 3 turns keep-login off. Then a
// quit loop: set a cookie, `taskkill /F` 1.5 s later, count how many the next run gets back (reported, not a pass/fail).
// Marker checks report found / not found only: no cookie value is ever printed.
// Env: GOOGLE_KEEP_PROBE_DIR (where the throwaway profiles go, default os.tmpdir()), GOOGLE_KEEP_PROBE_LOOPS (default 10).
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PREFIX = 'PROBE '
const SID = 'PROBE_SID'
const GAPS = '__Host-GAPS'
const BIN = 'google-canvasapp.bin'

if (process.versions.electron) child()
else driver()

// ---------------------------------------------------------------------------------------------- the Electron side
function child() {
  const { app, BrowserWindow, session } = require('electron')
  const phase = process.env.GOOGLE_KEEP_PROBE_PHASE
  const setSid = process.env.GOOGLE_KEEP_PROBE_SET || ''
  const setGaps = process.env.GOOGLE_KEEP_PROBE_SET_HOST || ''
  const expectSid = process.env.GOOGLE_KEEP_PROBE_EXPECT || ''
  const expectGaps = process.env.GOOGLE_KEEP_PROBE_EXPECT_HOST || ''
  for (const k of Object.keys(process.env)) if (k.startsWith('GOOGLE_KEEP_PROBE_')) delete process.env[k]
  delete process.env.SANO_URL // plain SanoVids: the canvasapp gateway, no SANO page
  delete process.env.SANO_API_URL

  const say = (line) => console.log(PREFIX + line)
  const check = (name, ok) => say(`${ok === true ? 'ok  ' : 'FAIL'} ${name}`)
  const refusedHosts = new Set()
  const refuse = (req) => {
    refusedHosts.add(new URL(req.url).host)
    return new Response('refused by the probe', { status: 502 })
  }
  app.whenReady().then(() => {
    session.defaultSession.protocol.handle('https', refuse)
    session.fromPartition('persist:canvasapp').protocol.handle('https', refuse)
    BrowserWindow.prototype.show = function () {}
    BrowserWindow.prototype.maximize = function () {}
  })

  let mainWin = null
  app.on('browser-window-created', (_e, win) => {
    if (mainWin) return
    mainWin = win
    win.webContents.once('did-finish-load', () =>
      run().catch((e) => {
        check(`probe crashed: ${e && e.name}`, false)
        app.exit(1)
      }),
    )
  })
  setTimeout(() => {
    check('probe timed out', false)
    app.exit(1)
  }, 40_000)

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const binPath = () => path.join(app.getPath('userData'), BIN)
  const year = () => Math.floor(Date.now() / 1000) + 365 * 86400

  async function run() {
    const wc = mainWin.webContents
    const cookies = session.fromPartition('persist:canvasapp').cookies
    // The first canvasapp use of the run: main restores the kept cookies (ensureCanvasappRestored). Not canvasapp:status:
    // its fetch bypasses protocol handlers (it would reach canvasapp.io.vn); an empty checkout URL is refused offline.
    const st = await wc.executeJavaScript('window.bdpDesktop.canvasapp.checkout({ checkoutUrl: "" }).then((r) => (r.ok ? "ok" : String(r.code)))', true)
    say(`fact canvasapp:checkout("") → ${st}`)
    const google = async () => (await cookies.get({})).filter((c) => /(^|\.)google\.com$/.test(c.domain.replace(/^\./, '')))
    const find = (list, name) => list.find((c) => c.name === name)
    if (expectSid) {
      const list = await google()
      const sid = find(list, SID)
      if (phase === 'loop') say(`survived ${!!sid && sid.value === expectSid ? 'yes' : 'no'}`)
      else {
        check('run 2: PROBE_SID back with the same value', !!sid && sid.value === expectSid)
        check('run 2: PROBE_SID is a session cookie', !!sid && sid.session === true)
        check('run 2: PROBE_SID keeps domain .google.com', !!sid && sid.domain === '.google.com' && sid.hostOnly === false)
        const gaps = find(list, GAPS)
        check('run 2: __Host-GAPS back with the same value', !!gaps && gaps.value === expectGaps)
        check('run 2: __Host-GAPS is a session cookie', !!gaps && gaps.session === true)
        check('run 2: __Host-GAPS stays host-only on accounts.google.com', !!gaps && gaps.hostOnly === true && gaps.domain === 'accounts.google.com')
      }
    }
    if (phase === 'off') {
      const r = await wc.executeJavaScript('window.bdpDesktop.canvasapp.setKeepLogin(false).then((r) => (r.ok ? "ok" : String(r.code)))', true)
      say(`fact canvasapp:setKeepLogin(false) → ${r}`)
      check('run 3: no Google cookie left in persist:canvasapp', (await google()).length === 0)
      check(`run 3: ${BIN} deleted`, !fs.existsSync(binPath()))
    }
    if (setSid) {
      await cookies.set({ url: 'https://google.com/', domain: '.google.com', name: SID, value: setSid, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: year() })
      if (setGaps) await cookies.set({ url: 'https://accounts.google.com/', name: GAPS, value: setGaps, path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: year() })
      if (phase === 'loop') {
        say('set') // the driver kills this process 1.5 s from now
        return
      }
      const since = Date.now()
      while (!fs.existsSync(binPath()) && Date.now() - since < 10_000) await sleep(100)
      say(`fact ${BIN} written ${fs.existsSync(binPath()) ? `after ~${Date.now() - since} ms` : 'NOT within 10 s'}`)
      await sleep(300) // the re-set as session cookies has landed
      const list = await google()
      check('run 1: PROBE_SID now a session cookie in the store', !!find(list, SID) && find(list, SID).session === true)
      check('run 1: __Host-GAPS now a session cookie in the store', !!find(list, GAPS) && find(list, GAPS).session === true)
    }
    say(`fact https refused for: ${[...refusedHosts].sort().join(', ') || 'none'}`)
    say('quit')
    mainWin.close() // a normal quit: window-all-closed → saveGoogle → app.quit
  }

  require('../electron/main.cjs')
}

// ---------------------------------------------------------------------------------------------- the Node side
function driver() {
  const { spawn, execFileSync } = require('node:child_process')
  const { randomBytes } = require('node:crypto')
  const electron = process.argv[2] || process.env.ELECTRON || require('electron')
  const base = process.env.GOOGLE_KEEP_PROBE_DIR || os.tmpdir()
  const loops = Number(process.env.GOOGLE_KEEP_PROBE_LOOPS) || 10
  const marker = () => 'pk' + randomBytes(12).toString('hex')
  const cookieFiles = (profile) =>
    ['Partitions/canvasapp/Network/Cookies', 'Network/Cookies']
      .flatMap((f) => [f, f + '-journal', f + '-wal'])
      .map((f) => path.join(profile, f))
      .filter((f) => fs.existsSync(f))
  const contains = (file, m) => fs.readFileSync(file).includes(Buffer.from(m, 'utf8'))
  const rel = (profile, f) => path.relative(profile, f).replace(/\\/g, '/')
  let failed = 0
  const line = (s) => console.log(s)
  const check = (name, ok) => {
    if (!ok) failed++
    line(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  }

  /** One Electron run → { lines, log, code }. killAfterSetMs: taskkill /F the tree that long after the child says 'set'. */
  function launch(profile, env, killAfterSetMs) {
    return new Promise((resolve) => {
      const childEnv = { ...process.env, ...env, SANOVIDS_PROFILE_DIR: profile }
      delete childEnv.ELECTRON_RUN_AS_NODE
      const p = spawn(electron, [__filename], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const lines = []
      const log = []
      let buf = ''
      p.stdout.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!l.startsWith(PREFIX)) continue
          lines.push(l.slice(PREFIX.length))
          if (l === PREFIX + 'set' && killAfterSetMs)
            setTimeout(() => {
              try {
                execFileSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' })
              } catch {
                /* already gone */
              }
            }, killAfterSetMs)
        }
      })
      // main's own Google-keep log lines (counts and reasons, never a value)
      p.stderr.on('data', (d) => log.push(...String(d).split('\n').filter((l) => /google-canvasapp/.test(l)).map((l) => l.trim())))
      p.on('exit', (code) => setTimeout(() => resolve({ lines, log, code }), 500)) // file handles of the killed tree
    })
  }
  const report = (title, r) => {
    line(`\n== ${title} (exit ${r.code})`)
    for (const l of r.lines) {
      if (l.startsWith('ok  ') || l.startsWith('FAIL')) check(l.slice(5), l.startsWith('ok  '))
      else line(`  ${l}`)
    }
    for (const l of r.log) line(`  main: ${l}`)
  }
  const rawCheck = (title, profile, markers) => {
    const files = cookieFiles(profile)
    line(`  cookie files present: ${files.map((f) => rel(profile, f)).join(', ') || 'none'}`)
    for (const f of files) for (const [n, m] of markers) check(`${title}: ${n} marker not in ${rel(profile, f)} (${contains(f, m) ? 'found' : 'not found'})`, !contains(f, m))
  }

  ;(async () => {
    line(`electron: ${electron}`)
    const profile = fs.mkdtempSync(path.join(base, 'google-keep-'))
    line(`profile (runs 1-3): ${profile}`)
    const sid = marker()
    const gaps = marker()
    const bin = path.join(profile, BIN)

    const r1 = await launch(profile, { GOOGLE_KEEP_PROBE_PHASE: 'write', GOOGLE_KEEP_PROBE_SET: sid, GOOGLE_KEEP_PROBE_SET_HOST: gaps })
    report('run 1: set two persistent Google cookies, quit normally', r1)
    check(`run 1: ${BIN} exists after the quit`, fs.existsSync(bin))
    if (fs.existsSync(bin)) {
      const bytes = fs.readFileSync(bin)
      check(`run 1: ${BIN} is not plaintext JSON`, bytes[0] !== 0x7b)
      for (const [n, m] of [['PROBE_SID', sid], ['__Host-GAPS', gaps], ['cookie name', SID]]) check(`run 1: ${n} not in clear in ${BIN} (${bytes.includes(Buffer.from(m)) ? 'found' : 'not found'})`, !bytes.includes(Buffer.from(m)))
    }
    rawCheck('run 1', profile, [['PROBE_SID', sid], ['__Host-GAPS', gaps]])

    const r2 = await launch(profile, { GOOGLE_KEEP_PROBE_PHASE: 'read', GOOGLE_KEEP_PROBE_EXPECT: sid, GOOGLE_KEEP_PROBE_EXPECT_HOST: gaps })
    report('run 2: same profile, cookies back?', r2)
    check(`run 2: ${BIN} still exists after the quit`, fs.existsSync(bin))
    rawCheck('run 2', profile, [['PROBE_SID', sid], ['__Host-GAPS', gaps]])

    const r3 = await launch(profile, { GOOGLE_KEEP_PROBE_PHASE: 'off' })
    report('run 3: keep-login switched off', r3)
    check(`run 3: ${BIN} absent after the quit`, !fs.existsSync(bin))
    rawCheck('run 3', profile, [['PROBE_SID', sid], ['__Host-GAPS', gaps]])

    // warm: one normal run first, so Chromium's Local State (it holds the safeStorage key) is on disk, as for a real user
    async function quitLoop(title, n, warm) {
      const loopProfile = fs.mkdtempSync(path.join(base, 'google-keep-loop-'))
      line(`\n== ${title}: ${n} × (set PROBE_SID, taskkill /F 1.5 s later), profile ${loopProfile}`)
      if (warm) line(`  warm-up normal run: exit ${(await launch(loopProfile, { GOOGLE_KEEP_PROBE_PHASE: 'loop' })).code}`)
      let prev = ''
      let survived = 0
      let onDisk = 0
      for (let i = 0; i <= n; i++) {
        const m = i < n ? marker() : ''
        const r = await launch(loopProfile, { GOOGLE_KEEP_PROBE_PHASE: 'loop', GOOGLE_KEEP_PROBE_EXPECT: prev, GOOGLE_KEEP_PROBE_SET: m }, m ? 1500 : 0)
        const s = r.lines.find((l) => l.startsWith('survived '))
        if (prev) {
          if (s === 'survived yes') survived++
          line(`  kill ${i}: ${s ? s.slice(9) : 'no answer'}${r.log.length ? ` (main: ${r.log.join(' | ')})` : ''}`)
        }
        if (m) {
          if (!r.lines.includes('set')) line(`  run ${i + 1}: never reached 'set' (${r.lines.filter((l) => l.startsWith('FAIL')).join('; ') || 'exit ' + r.code})`)
          if (cookieFiles(loopProfile).some((f) => contains(f, m))) onDisk++
          line(`  after kill ${i + 1}: ${BIN} ${fs.existsSync(path.join(loopProfile, BIN)) ? 'present' : 'absent'}, Local State ${fs.existsSync(path.join(loopProfile, 'Local State')) ? 'present' : 'absent'}`)
        }
        prev = m
      }
      line(`  survived ${survived} / ${n} kills; marker found in a cookie file after ${onDisk} / ${n} kills`)
    }
    await quitLoop('cold quit loop (fresh profile, never quit normally)', 2, false)
    await quitLoop('quit loop', loops, true)
    line(`\n${failed ? `FAIL: ${failed} check(s)` : 'all checks of runs 1-3 passed'}`)
    process.exit(failed ? 1 : 0)
  })()
}
