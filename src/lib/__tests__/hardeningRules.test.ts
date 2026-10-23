// electron/hardening-rules.cjs: the pure hardening rules of the desktop shell (packaged detection, refused command-line
// switches, stripped env, DevTools gate, download allowlist, default-session permissions, CSP of app://bdp, the
// 'app:signature' payload and the self-check of the DLLs next to the exe) — plus source guarantees in main.cjs /
// preload.cjs that wire them in (docs/SIGNING.md "Bảo mật"), including 'app:placement' and the portable window's
// setAppDetails. The Recycle Bin IPC (files:trashSaved) is guarded by trashWiring.test.ts.
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import hardeningSource from '../../../electron/hardening-rules.cjs?raw'
import mainSource from '../../../electron/main.cjs?raw'
import preloadSource from '../../../electron/preload.cjs?raw'
import devAccessSource from '../../../electron/devaccess.cjs?raw'
import devAccessRulesSource from '../../../electron/devaccess-rules.cjs?raw'
import pkgRaw from '../../../package.json?raw'
import sanoBatSource from '../../../sano-desktop.bat?raw'

type ProfileSource = 'env' | 'baked' | 'default'
type SigStatus = 'signed' | 'unsigned' | 'other-signer' | 'tampered' | 'unknown'
interface Payload {
  status: SigStatus
  packaged: boolean
  signer?: string
  thumbprint?: string
}
interface Hardening {
  ALWAYS_REFUSED: readonly string[]
  REMOTE_DEBUG: readonly string[]
  REFUSED_DIALOG_TEXT: string
  isPackagedApp(o: { isPackaged: unknown; appPath: unknown }): boolean
  refusedSwitches(o: { isPackaged: boolean; profileSource: ProfileSource; testBuild?: boolean; hasSwitch: (name: string) => boolean }): string[]
  allowDevTools(o: { isPackaged: boolean; profileSource: ProfileSource; testBuild?: boolean }): boolean
  STRIPPED_ENV: readonly string[]
  envToStrip(o: { isPackaged: boolean; env: unknown }): string[]
  DOWNLOAD_ALLOWED_EXT: readonly string[]
  downloadExtension(filename: unknown): string
  downloadAllowed(url: unknown, filename: unknown): boolean
  downloadLogLabel(url: unknown, filename: unknown): string
  DEFAULT_SESSION_PERMISSIONS: readonly string[]
  permissionAllowed(p: unknown): boolean
  sha256Base64(bytes: Uint8Array): string
  inlineScriptHashes(html: unknown): string[]
  contentSecurityPolicy(html: unknown, frameAncestors?: string): string
  sanoShell(o: unknown): { url: string; origin: string } | null | false
  appFrames(wc: unknown): { url: string }[]
  GOOGLE_SIGN_IN: RegExp
  appSignaturePayload(verdict: unknown, opts: { packaged: boolean }): Payload
  SIGNED_DLLS: readonly string[]
  MICROSOFT_DLLS: readonly string[]
  MICROSOFT_SIGNER: string
  SELF_CHECK_FILES: readonly { name: string; kind: 'author' | 'microsoft' }[]
  selfCheckFileState(kind: unknown, result: unknown, pins: unknown): 'ok' | 'bad' | 'unknown'
  combineSelfCheck(exeVerdict: unknown, fileStates: unknown): Record<string, unknown>
  MAC_MENU_REFUSED_ROLES: readonly string[]
  macMenuTemplate(o: unknown): MenuItem[]
  TEXT_MENU_ROLES: readonly string[]
  textContextMenu(params: unknown): MenuItem[] | null
  mainWindowCloseHides(o: unknown): boolean
  HIDDEN_WORK_SETTLE_MS: number
  createHiddenWork(fx: HiddenWorkFx): HiddenWork
}
interface HiddenWorkFx {
  setThrottling(on: boolean): void
  setMuted(on: boolean): void
  startBlocker(): unknown
  stopBlocker(id: unknown): void
  schedule(fn: () => void, ms: number): unknown
  cancel(timer: unknown): void
}
interface HiddenWork {
  hide(): void
  show(): void
  setBusy(value: unknown): void
  stop(): void
  state(): { hidden: boolean; busy: boolean; held: boolean; muted: boolean }
}
interface MenuItem {
  label?: string
  role?: string
  type?: string
  enabled?: boolean
  submenu?: MenuItem[]
}

const h = createRequire(import.meta.url)('../../../electron/hardening-rules.cjs') as Hardening
const indexBytes = readFileSync(new URL('../../../index.html', import.meta.url))
const PIN = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
const AUTHOR = 'Nguyễn Giang Minh (Jame Steven)'
const sha256 = (data: string | Uint8Array) => 'sha256-' + crypto.createHash('sha256').update(data).digest('base64')
const BLOB = 'blob:app://bdp/6f1c2a7e-3b0d-4f53-9a35-1c2e3d4f5a6b'

describe('hardening rules: command-line switches', () => {
  const ALL = () => [...h.ALWAYS_REFUSED, ...h.REMOTE_DEBUG]
  const only = (name: string) => (n: string) => n === name

  it('lists exactly the spec names, lower-case', () => {
    expect([...h.ALWAYS_REFUSED]).toEqual([
      'inspect',
      'inspect-brk',
      'inspect-port',
      'inspect-brk-node',
      'inspect-publish-uid',
      'inspect-wait',
      'debug',
      'debug-brk',
      'debug-port',
      'js-flags',
      'ignore-certificate-errors',
      'ignore-certificate-errors-spki-list',
      'no-sandbox',
      'disable-web-security',
      'disable-site-isolation-trials',
      'allow-running-insecure-content',
      'unsafely-treat-insecure-origin-as-secure',
      'gpu-launcher',
      'renderer-cmd-prefix',
      'utility-cmd-prefix',
      'browser-subprocess-path',
      'disable-gpu-sandbox',
      'single-process',
      'in-process-gpu',
      'disable-features',
      'ssl-key-log-file',
      'log-net-log',
    ])
    expect([...h.REMOTE_DEBUG]).toEqual(['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins'])
    for (const n of ALL()) expect(n).toBe(n.toLowerCase())
  })

  it('from source (not packaged): never refuses anything, never even asks', () => {
    let asked = 0
    const hasSwitch = () => {
      asked++
      return true
    }
    for (const profileSource of ['default', 'env', 'baked'] as const) {
      for (const testBuild of [false, true]) expect(h.refusedSwitches({ isPackaged: false, profileSource, testBuild, hasSwitch })).toEqual([])
    }
    expect(asked).toBe(0)
  })

  it('packaged, real profile: every listed switch is refused on its own', () => {
    for (const name of ALL()) expect(h.refusedSwitches({ isPackaged: true, profileSource: 'default', hasSwitch: only(name) }), name).toEqual([name])
    expect(h.refusedSwitches({ isPackaged: true, profileSource: 'default', hasSwitch: () => false })).toEqual([])
    expect(h.refusedSwitches({ isPackaged: true, profileSource: 'default', hasSwitch: () => true })).toEqual(ALL())
  })

  it('packaged TEST build on its isolated test profile (env / baked): remote debugging allowed, the rest still refused', () => {
    for (const profileSource of ['env', 'baked'] as const) {
      for (const name of h.REMOTE_DEBUG) expect(h.refusedSwitches({ isPackaged: true, profileSource, testBuild: true, hasSwitch: only(name) }), name).toEqual([])
      for (const name of h.ALWAYS_REFUSED) expect(h.refusedSwitches({ isPackaged: true, profileSource, testBuild: true, hasSwitch: only(name) }), name).toEqual([name])
      expect(h.refusedSwitches({ isPackaged: true, profileSource, testBuild: true, hasSwitch: () => true })).toEqual([...h.ALWAYS_REFUSED])
    }
  })

  it('official build: SANOVIDS_PROFILE_DIR alone never allows remote debugging (it only isolates the data)', () => {
    for (const profileSource of ['default', 'env', 'baked'] as const) {
      for (const testBuild of [false, undefined, 'true' as never, 1 as never]) {
        for (const name of h.REMOTE_DEBUG) {
          expect(h.refusedSwitches({ isPackaged: true, profileSource, testBuild, hasSwitch: only(name) }), `${profileSource} ${String(testBuild)} ${name}`).toEqual([name])
        }
      }
    }
    // A test build that somehow ran on the default profile (cannot happen: its baked profile is always used) stays locked.
    expect(h.refusedSwitches({ isPackaged: true, profileSource: 'default', testBuild: true, hasSwitch: only('remote-debugging-port') })).toEqual(['remote-debugging-port'])
  })

  it('fails closed: a hasSwitch that throws counts the switch as present; odd input refuses everything', () => {
    const boom = () => {
      throw new Error('boom')
    }
    expect(h.refusedSwitches({ isPackaged: true, profileSource: 'default', hasSwitch: boom })).toEqual(ALL())
    expect(h.refusedSwitches({ isPackaged: true, profileSource: 'env', hasSwitch: boom })).toEqual(ALL())
    expect(h.refusedSwitches({ isPackaged: true, profileSource: 'env', testBuild: true, hasSwitch: boom })).toEqual([...h.ALWAYS_REFUSED])
    // isPackaged anything but false → packaged (fail closed)
    expect(h.refusedSwitches({ isPackaged: undefined as never, profileSource: 'default', hasSwitch: only('no-sandbox') })).toEqual(['no-sandbox'])
    const throwsFor = (bad: string) => (n: string) => {
      if (n === bad) throw new Error('x')
      return false
    }
    expect(h.refusedSwitches({ isPackaged: true, profileSource: 'default', hasSwitch: throwsFor('no-sandbox') })).toEqual(['no-sandbox'])
    // Unexpected profile source → treated as the real profile; missing hasSwitch → every name refused.
    expect(h.refusedSwitches({ isPackaged: true, profileSource: 'other' as ProfileSource, hasSwitch: only('remote-debugging-port') })).toEqual(['remote-debugging-port'])
    expect(h.refusedSwitches({ isPackaged: true, profileSource: 'default' } as never)).toEqual(ALL())
  })

  it('asks only by name through hasSwitch (never argv), with the listed lower-case names', () => {
    const asked: string[] = []
    h.refusedSwitches({ isPackaged: true, profileSource: 'default', hasSwitch: (n) => (asked.push(n), false) })
    expect(asked).toEqual(ALL())
    expect(hardeningSource).not.toMatch(/process\.argv/)
  })

  it('refusal dialog text', () => {
    expect(h.REFUSED_DIALOG_TEXT).toBe(
      'SanoVids không mở khi có tham số gỡ lỗi hoặc tham số tắt bảo mật (ví dụ --remote-debugging-port, --inspect, --no-sandbox). Hãy mở SanoVids bằng biểu tượng bình thường, không thêm tham số.',
    )
    expect(h.REFUSED_DIALOG_TEXT).toBe(h.REFUSED_DIALOG_TEXT.normalize('NFC'))
  })

  it('DevTools: from source, or in a test build on its isolated test profile only', () => {
    expect(h.allowDevTools({ isPackaged: false, profileSource: 'default' })).toBe(true)
    expect(h.allowDevTools({ isPackaged: false, profileSource: 'env' })).toBe(true)
    expect(h.allowDevTools({ isPackaged: true, profileSource: 'env', testBuild: true })).toBe(true)
    expect(h.allowDevTools({ isPackaged: true, profileSource: 'baked', testBuild: true })).toBe(true)
    // the official build: never, whatever the profile
    expect(h.allowDevTools({ isPackaged: true, profileSource: 'env' })).toBe(false)
    expect(h.allowDevTools({ isPackaged: true, profileSource: 'baked', testBuild: false })).toBe(false)
    expect(h.allowDevTools({ isPackaged: true, profileSource: 'default' })).toBe(false)
    expect(h.allowDevTools({ isPackaged: true, profileSource: 'default', testBuild: true })).toBe(false)
    expect(h.allowDevTools({ isPackaged: true, profileSource: 'other' as ProfileSource, testBuild: true })).toBe(false)
    expect(h.allowDevTools({ isPackaged: undefined as never, profileSource: 'env' })).toBe(false)
  })
})

describe('hardening rules: packaged detection and environment', () => {
  it('packaged = app.isPackaged OR the app runs from an .asar (a renamed electron.exe stays packaged)', () => {
    const asar = 'C:\\Users\\u\\AppData\\Local\\Programs\\SanoVids\\resources\\app.asar'
    expect(h.isPackagedApp({ isPackaged: true, appPath: asar })).toBe(true)
    // a copy of SanoVids.exe renamed electron.exe: Electron says isPackaged false, the app path is still app.asar
    expect(h.isPackagedApp({ isPackaged: false, appPath: asar })).toBe(true)
    expect(h.isPackagedApp({ isPackaged: false, appPath: asar.toUpperCase() })).toBe(true)
    expect(h.isPackagedApp({ isPackaged: false, appPath: asar + '\\' })).toBe(true)
    expect(h.isPackagedApp({ isPackaged: true, appPath: 'E:\\CANVAS TOOL' })).toBe(true)
    // `electron .` from source
    expect(h.isPackagedApp({ isPackaged: false, appPath: 'E:\\CANVAS TOOL' })).toBe(false)
    expect(h.isPackagedApp({ isPackaged: false, appPath: 'E:\\x\\app.asar.bak' })).toBe(false)
    expect(h.isPackagedApp({ isPackaged: false, appPath: undefined })).toBe(false)
    expect(h.isPackagedApp({ isPackaged: 'yes', appPath: 'E:\\CANVAS TOOL' })).toBe(false)
    expect(h.isPackagedApp(null as never)).toBe(false)
  })

  it('a packaged app drops SSLKEYLOGFILE (any spelling) from its environment; from source nothing', () => {
    expect([...h.STRIPPED_ENV]).toEqual(['SSLKEYLOGFILE'])
    expect(h.envToStrip({ isPackaged: true, env: { SSLKEYLOGFILE: 'C:\\k.txt', TEMP: 'x' } })).toEqual(['SSLKEYLOGFILE'])
    expect(h.envToStrip({ isPackaged: true, env: { SslKeyLogFile: 'C:\\k.txt' } })).toEqual(['SslKeyLogFile'])
    expect(h.envToStrip({ isPackaged: true, env: { TEMP: 'x' } })).toEqual([])
    expect(h.envToStrip({ isPackaged: false, env: { SSLKEYLOGFILE: 'C:\\k.txt' } })).toEqual([])
    expect(h.envToStrip({ isPackaged: true, env: null })).toEqual([])
  })
})

describe('hardening rules: downloads', () => {
  it('allows the page’s own blobs with the types SanoVids produces', () => {
    for (const name of ['S03_T2 - cảnh mở đầu.mp4', 'x.webm', 'poster.SVG', 'Dự án.sanovids.json', 'S01.zip', 'S01_T1.txt', 'a.MP4', 'p.jpeg', 'p.webp']) {
      expect(h.downloadAllowed(BLOB, name), name).toBe(true)
    }
  })

  it('refuses programs, scripts, shortcuts, names without a real extension, and anything not an app blob', () => {
    for (const name of ['setup.exe', 'run.ps1', 'x.lnk', 'x.bat', 'x.cmd', 'x.msi', 'x.scr', 'x.hta', 'x.js', 'x.html', 'video', 'x.mp4 ', 'x.mp4.', '.mp4', 'a/b.mp4', 'a\\b.mp4', 'x.exe:y.mp4', 'x\u0000.mp4', '', 'mp4']) {
      expect(h.downloadAllowed(BLOB, name), JSON.stringify(name)).toBe(false)
    }
    for (const url of ['https://example.com/x.mp4', 'blob:https://evil.example/123', 'blob:app://bdpx/123', 'app://bdp/x.mp4', 'data:video/mp4;base64,AAAA', 'file:///C:/x.mp4', 'BLOB:app://bdp/1']) {
      expect(h.downloadAllowed(url, 'x.mp4'), url).toBe(false)
    }
    expect(h.downloadAllowed(undefined, 'x.mp4')).toBe(false)
    expect(h.downloadAllowed(BLOB, null)).toBe(false)
  })

  it('covers every type main.cjs lets the save dialog / folders write (SAVE_ALLOWED_EXT)', () => {
    const m = /const SAVE_ALLOWED_EXT = new Set\(\[([^\]]*)\]\)/.exec(mainSource)
    expect(m).not.toBeNull()
    const saveExt = [...m![1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1])
    expect(saveExt.length).toBeGreaterThan(5)
    for (const ext of saveExt) expect(h.DOWNLOAD_ALLOWED_EXT, ext).toContain(ext)
    expect([...h.DOWNLOAD_ALLOWED_EXT].sort()).toEqual(['jpeg', 'jpg', 'json', 'm4v', 'mov', 'mp4', 'png', 'svg', 'txt', 'webm', 'webp', 'zip'])
  })

  it('the refusal log names the reason, never the file name or the URL', () => {
    expect(h.downloadLogLabel(BLOB, 'bí mật.exe')).toBe('.exe')
    expect(h.downloadLogLabel(BLOB, 'video')).toBe('no-extension')
    expect(h.downloadLogLabel('https://example.com/secret?token=1', 'x.mp4')).toBe('not-an-app-blob')
    expect(h.downloadExtension('a.Tar.GZ')).toBe('gz')
  })
})

describe('hardening rules: default-session permissions', () => {
  it('only clipboard writes, the folder picker API, full screen and persistent storage', () => {
    expect([...h.DEFAULT_SESSION_PERMISSIONS]).toEqual(['clipboard-sanitized-write', 'fileSystem', 'fullscreen', 'persistent-storage'])
    for (const p of h.DEFAULT_SESSION_PERMISSIONS) expect(h.permissionAllowed(p), p).toBe(true)
    for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'display-capture', 'hid', 'usb', 'serial', 'midi', 'pointerLock', 'storage-access', 'top-level-storage-access', 'FULLSCREEN', 'Persistent-Storage', '', undefined, null, 7]) {
      expect(h.permissionAllowed(p), String(p)).toBe(false)
    }
  })
})

describe('hardening rules: Content-Security-Policy', () => {
  it('sha256 matches node:crypto for every block-boundary length', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 70_000]) {
      const bytes = new Uint8Array(crypto.randomBytes(n))
      expect('sha256-' + h.sha256Base64(bytes), String(n)).toBe(sha256(bytes))
    }
  })

  it("index.html has exactly one inline script, hashed exactly as the browser does", () => {
    const text = indexBytes.toString('utf8')
    const bodies = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(bodies).toHaveLength(1)
    const expected = sha256(bodies[0].replace(/\r\n?/g, '\n'))
    expect(h.inlineScriptHashes(indexBytes)).toEqual([expected])
    expect(h.inlineScriptHashes(text)).toEqual([expected])
  })

  it('skips scripts with src, keeps data-src ones, hashes UTF-8 text, normalizes CRLF like the HTML parser', () => {
    const html = '<script src="./a.js"></script><SCRIPT type="module" crossorigin src=./b.js></SCRIPT><script data-src="x">var a = "Nguyễn"</script><script>\r\nx()\r\n</script >'
    expect(h.inlineScriptHashes(html)).toEqual([sha256('var a = "Nguyễn"'), sha256('\nx()\n')])
    expect(h.inlineScriptHashes(Buffer.from(html, 'utf8'))).toEqual(h.inlineScriptHashes(html))
    expect(h.inlineScriptHashes('<p>no script</p>')).toEqual([])
    expect(h.inlineScriptHashes(undefined)).toEqual([])
  })

  it('policy string (snapshot)', () => {
    const [hash] = h.inlineScriptHashes(indexBytes)
    expect(h.contentSecurityPolicy(indexBytes)).toBe(
      `default-src 'self'; script-src 'self' '${hash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'`,
    )
    expect(h.contentSecurityPolicy('')).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'",
    )
    // SANO desktop: only the frame-ancestors directive changes
    expect(h.contentSecurityPolicy('', 'http://127.0.0.1:5173')).toBe(h.contentSecurityPolicy('').replace("frame-ancestors 'none'", 'frame-ancestors http://127.0.0.1:5173'))
    const policy = h.contentSecurityPolicy(indexBytes)
    expect(policy).not.toMatch(/unsafe-eval|\*/)
    expect(policy.split('; ').find((d) => d.startsWith('script-src '))).not.toMatch(/unsafe/)
  })
})

describe('SANO desktop (sanoShell, docs/SANO-DESKTOP.md)', () => {
  const shell = (value: unknown, isPackaged = false) => h.sanoShell({ isPackaged, value })

  it('from source: https anywhere, http on this machine only, origin only', () => {
    expect(shell('https://sano.example.vn/app?x=1#y')).toEqual({ url: 'https://sano.example.vn/', origin: 'https://sano.example.vn' })
    expect(shell('http://127.0.0.1:5173')).toEqual({ url: 'http://127.0.0.1:5173/', origin: 'http://127.0.0.1:5173' })
    expect(shell('http://localhost:8080/')).toEqual({ url: 'http://localhost:8080/', origin: 'http://localhost:8080' })
  })

  it('packaged: only the address baked into app.asar (Sano Agent), never the environment; from source: never the baked one', () => {
    const SANO_AGENT = { url: 'http://127.0.0.1:8080/', origin: 'http://127.0.0.1:8080' }
    expect(h.sanoShell({ isPackaged: true, value: 'https://evil.example.vn', baked: 'http://127.0.0.1:8080/' })).toEqual(SANO_AGENT)
    expect(h.sanoShell({ isPackaged: true, value: 'https://evil.example.vn' })).toBeNull()
    expect(h.sanoShell({ isPackaged: true, baked: 'http://sano.example.vn/' })).toBe(false)
    expect(h.sanoShell({ isPackaged: false, baked: 'http://127.0.0.1:8080/' })).toBeNull()
    expect(mainSource).toMatch(/return pkg && pkg\.sanoAgent && typeof pkg\.sanoAgent\.url === 'string' \? pkg\.sanoAgent\.url : undefined/)
  })

  it('unset or packaged → null (plain SanoVids); anything else → false (main refuses to start)', () => {
    expect(shell(undefined)).toBeNull()
    expect(shell('')).toBeNull()
    expect(shell('https://sano.example.vn', true)).toBeNull()
    expect(h.sanoShell(null)).toBeNull()
    for (const bad of ['http://sano.example.vn', 'http://127.0.0.1.evil.vn', 'file:///C:/x.html', 'app://bdp/', 'javascript:alert(1)', 'https://u:p@sano.example.vn', 'not a url', 'sano.example.vn', 'http://[::1]:5173/', 'https://*.example.vn', 'https://a;b.vn']) {
      expect(shell(bad), bad).toBe(false)
    }
  })

  it('wiring: refused before anything is written; subframe preload, SANO origin home, Google popup only in SANO', () => {
    const at = (s: string) => {
      const i = mainSource.indexOf(s)
      expect(i, s).toBeGreaterThan(-1)
      return i
    }
    expect(at('const SANO = hardening.sanoShell({ isPackaged: PACKAGED, value: process.env.SANO_URL, baked: readBakedSanoUrl() })')).toBeLessThan(at('fs.mkdirSync(profile.dir'))
    expect(mainSource).toMatch(/if \(SANO === false\) \{\s+console\.error\([^)]*\)\s+process\.exit\(2\)/)
    expect(mainSource).toContain('nodeIntegrationInSubFrames: !!SANO,')
    // D223: shared projects with SanoVids — set before ready, SANO mode only, the only Chromium switch main adds
    const shared = at("if (SANO) app.commandLine.appendSwitch('disable-features', 'ThirdPartyStoragePartitioning')")
    expect(shared).toBeLessThan(at('app.whenReady()'))
    expect(mainSource.split('commandLine.appendSwitch(').length - 1).toBe(1)
    expect(mainSource.split('nodeIntegrationInSubFrames').length - 1).toBe(1)
    expect(mainSource).toContain("const home = SANO ? SANO.url : ORIGIN + '/'")
    expect(mainSource).toContain('if (url.startsWith(home)) return')
    expect(mainSource).toContain("if (SANO && url.startsWith('https://accounts.google.com/')) return { action: 'allow', overrideBrowserWindowOptions: { parent: win, autoHideMenuBar: true } }")
    expect(mainSource).toContain('void win.loadURL(SANO ? SANO.url : `${ORIGIN}/index.html`)')
    // server redirects of SANO's page are held to the same home; the Google popup is guarded, its cookies dropped on close
    expect(mainSource).toMatch(/webContents\.on\('will-redirect', \(event, url\) => \{\s+if \(!event\.isMainFrame \|\| url\.startsWith\(home\)\) return\s+event\.preventDefault\(\)\s+if \(mainWindowShown\) return\s+console\.error\([^\n]*\)\s+app\.exit\(2\)\s+\}\)/)
    // a redirect is the server's, never opened in the browser (only will-navigate, the user's click, is)
    const redirect = mainSource.slice(at("webContents.on('will-redirect'"), at("webContents.on('will-redirect'") + 400)
    expect(redirect.slice(0, redirect.indexOf('\n  })'))).not.toContain('openExternal')
    // every start, either mode (same data folder): leftover Google account cookies of the default session go
    expect(mainSource).toMatch(/\n {4}void keepLoginRules\.removeGoogleAccountCookies\(session\.defaultSession\.cookies\)\n/)
    expect(mainSource).toContain("if (SANO) webContents.on('did-create-window', (child) => guardGooglePopup(child))")
    const [gs, ge] = [mainSource.indexOf('function guardGooglePopup(child)'), mainSource.indexOf('function showMainWindow()')]
    const google = mainSource.slice(gs, ge)
    expect(gs).toBeGreaterThan(-1)
    expect(google).toContain("return { action: 'deny' }")
    expect(google).toContain("wc.on('will-navigate', (event, url) => stay(event, url, true))")
    expect(google).toMatch(/wc\.on\('will-redirect', \(event, url\) => \{\s+if \(event\.isMainFrame\) stay\(event, url, false\)/)
    expect(google).toContain('if (open && isExternal(url)) void shell.openExternal(url)')
    expect(google).toContain('if (hardening.GOOGLE_SIGN_IN.test(url)) return')
    expect(google).toContain('keepLoginRules.removeGoogleAccountCookies(session.defaultSession.cookies)')
  })

  it('SANO mode window: Sano Agent title, the exe icon on Windows, and a retry / quit dialog when SANO does not load', () => {
    expect(mainSource).toContain("title: SANO ? 'Sano Agent' : TITLE,")
    expect(mainSource).toContain("...(SANO && process.platform === 'win32' ? {} : { icon: path.join(DIST, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon-512.png') }),")
    const fail = mainSource.slice(mainSource.indexOf("webContents.on('did-fail-load'"), mainSource.indexOf('void win.loadURL(SANO ? SANO.url'))
    expect(mainSource).toMatch(/if \(SANO\) \{\s+webContents\.on\('did-fail-load'/)
    expect(fail).toContain('if (!isMainFrame || errorCode === -3) return')
    expect(fail).toContain("buttons: ['Thử lại', 'Thoát']")
    expect(fail).toContain('(response === 0 ? void win.loadURL(SANO.url) : app.quit())')
    // the page learns which app it is (download page label), from main only
    expect(preloadSource).toContain("product: productArg ? productArg.slice('--bdp-product='.length) : '',")
  })

  it('appFrames: the live app://bdp frames of a window (main frame or SANO’s Dựng phim frame), never SANO’s page', () => {
    const frame = (url: string, destroyed = false) => ({ url, isDestroyed: () => destroyed })
    const sano = frame('http://127.0.0.1:8080/')
    const bdp = frame('app://bdp/index.html')
    expect(h.appFrames({ mainFrame: { framesInSubtree: [sano, bdp, frame('app://bdp/x', true), frame('app://bdpx/')] } })).toEqual([bdp])
    expect(h.appFrames({ mainFrame: { framesInSubtree: [bdp] } })).toEqual([bdp])
    expect(h.appFrames({ get mainFrame() { throw new Error('Object has been destroyed') } })).toEqual([])
    expect(h.appFrames(null)).toEqual([])
  })

  it('GOOGLE_SIGN_IN: Google sign-in hosts over https only', () => {
    for (const ok of ['https://accounts.google.com/o/oauth2/v2/auth?x=1', 'https://accounts.google.com/gsi/select', 'https://accounts.youtube.com/accounts/SetSID']) expect(h.GOOGLE_SIGN_IN.test(ok), ok).toBe(true)
    for (const bad of ['http://accounts.google.com/', 'https://accounts.google.com.evil.vn/', 'https://accounts.google.com@evil.vn/', 'https://evil.vn/https://accounts.google.com/', 'https://myaccount.google.com/', 'https://sites.google.com/x', 'https://accounts.google.com', 'about:blank']) {
      expect(h.GOOGLE_SIGN_IN.test(bad), bad).toBe(false)
    }
    // the gateway still answers app://bdp frames only
    expect(mainSource).toContain("return url.startsWith(ORIGIN + '/')")
  })

  it('preload: the bridge goes to app://bdp only; SANO learns nothing but where SanoVids is', () => {
    expect(preloadSource).toContain("const expose = location.origin === 'app://bdp' ? (key, api) => contextBridge.exposeInMainWorld(key, api) : () => undefined")
    expect(preloadSource).toContain("expose('bdpDesktop', {")
    const direct = [...preloadSource.matchAll(/contextBridge\.exposeInMainWorld\('(\w+)'/g)].map((m) => m[1])
    expect(direct).toEqual(['sanoDesktop'])
    expect(preloadSource).toContain("if (sanoArg && location.origin === sanoArg.slice('--bdp-sano-origin='.length)) contextBridge.exposeInMainWorld('sanoDesktop', { sanovidsUrl: 'app://bdp/' })")
  })

  it('sano-desktop.bat: SANO_URL expands inside quotes only (cmd runs & | > of a query string as operators)', () => {
    const lines = sanoBatSource.split('\n').filter((l) => l.includes('%SANO_URL%'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) for (const m of l.matchAll(/%SANO_URL%/g)) expect(l.slice(0, m.index).split('"').length % 2, l).toBe(0)
  })
})

describe("hardening rules: 'app:signature' payload", () => {
  const verdict = (o: Record<string, unknown>) => ({ ok: false, reason: 'ok', timestamped: true, ...o })

  it('signed / other-signer carry signer and thumbprint', () => {
    expect(h.appSignaturePayload(verdict({ ok: true, status: 'signed', signer: AUTHOR, thumbprint: PIN }), { packaged: true })).toEqual({
      status: 'signed',
      packaged: true,
      signer: AUTHOR,
      thumbprint: PIN,
    })
    const other = '5B768D22' + 'A'.repeat(32)
    expect(h.appSignaturePayload(verdict({ status: 'other-signer', reason: 'other-signer', signer: AUTHOR, thumbprint: other.toLowerCase() }), { packaged: true })).toEqual({
      status: 'other-signer',
      packaged: true,
      signer: AUTHOR,
      thumbprint: other,
    })
  })

  it('unsigned / tampered / unknown never carry signer or thumbprint', () => {
    for (const status of ['unsigned', 'tampered', 'unknown'] as const) {
      expect(h.appSignaturePayload(verdict({ status, signer: AUTHOR, thumbprint: PIN }), { packaged: true }), status).toEqual({ status, packaged: true })
    }
  })

  it('cleans the signer (controls, bidi tricks), truncates it to 200, drops a bad thumbprint', () => {
    const p = h.appSignaturePayload(verdict({ ok: true, status: 'signed', signer: 'A\u0000B\u202eC\u200b\n' + 'x'.repeat(300), thumbprint: 'not-hex' }), { packaged: true })
    expect(p.signer).toBe(('ABC' + 'x'.repeat(300)).slice(0, 200))
    expect(p.signer).toHaveLength(200)
    expect(p.thumbprint).toBeUndefined()
    const emoji = h.appSignaturePayload(verdict({ ok: true, status: 'signed', signer: 'x'.repeat(199) + '😀', thumbprint: PIN }), { packaged: true })
    expect(emoji.signer).toBe('x'.repeat(199)) // never half a surrogate pair
    expect(h.appSignaturePayload(verdict({ ok: true, status: 'signed', signer: '\u0001 \u0002', thumbprint: PIN }), { packaged: true })).toEqual({ status: 'signed', packaged: true, thumbprint: PIN })
  })

  it('fails closed on odd verdicts', () => {
    expect(h.appSignaturePayload(verdict({ ok: false, status: 'signed', signer: AUTHOR, thumbprint: PIN }), { packaged: true })).toEqual({ status: 'unknown', packaged: true })
    expect(h.appSignaturePayload(verdict({ status: 'trusted' }), { packaged: true })).toEqual({ status: 'unknown', packaged: true })
    expect(h.appSignaturePayload(null, { packaged: true })).toEqual({ status: 'unknown', packaged: true })
    expect(h.appSignaturePayload('signed', { packaged: 'yes' as never })).toEqual({ status: 'unknown', packaged: false })
  })
})

describe('hardening rules: self-check of the DLLs next to the exe', () => {
  const MS_D3D = '6ACE61BAE3F09F4DD2697806D73E022CBFE70EB4' // d3dcompiler_47.dll of Electron 44 (Microsoft Corporation)
  const OTHER = '0123456789ABCDEF0123456789ABCDEF01234567'
  const raw = (o: Record<string, unknown>) => ({
    v: 1,
    status: 0,
    sigType: 'Authenticode',
    thumbprint: MS_D3D,
    signer: 'Microsoft Corporation',
    tsThumbprint: 'AAAA' + '0'.repeat(36),
    chainOk: true,
    chainStatus: [],
    chainLen: 3,
    hresult: '0x00000000',
    error: null,
    ...o,
  })
  const ms = (o: Record<string, unknown>, pins: unknown = [PIN]) => h.selfCheckFileState('microsoft', { parsed: raw(o), verdict: { ok: false, status: 'other-signer' } }, pins)
  const author = (verdict: Record<string, unknown> | null) => h.selfCheckFileState('author', { parsed: null, verdict }, [PIN])
  const SIGNED = { ok: true, status: 'signed', reason: 'ok', thumbprint: PIN, signer: AUTHOR, timestamped: true }

  it('lists the 4 author-signed DLLs (= package.json build.win.signExts) and Microsoft’s 2', () => {
    const pkg = JSON.parse(pkgRaw) as { build: { win: { signExts: string[] } } }
    expect([...h.SIGNED_DLLS]).toEqual(pkg.build.win.signExts)
    expect([...h.MICROSOFT_DLLS]).toEqual(['d3dcompiler_47.dll', 'dxil.dll'])
    expect(h.MICROSOFT_SIGNER).toBe('Microsoft Corporation')
    expect(h.SELF_CHECK_FILES.map((f) => `${f.kind}:${f.name}`)).toEqual([
      'author:ffmpeg.dll',
      'author:vk_swiftshader.dll',
      'author:vulkan-1.dll',
      'author:dxcompiler.dll',
      'microsoft:d3dcompiler_47.dll',
      'microsoft:dxil.dll',
    ])
    expect(Object.isFrozen(h.SELF_CHECK_FILES)).toBe(true)
  })

  it('author DLL: the pinned verdict decides', () => {
    expect(author(SIGNED)).toBe('ok')
    for (const status of ['tampered', 'unsigned', 'other-signer']) expect(author({ ok: false, status }), status).toBe('bad')
    for (const v of [{ ok: false, status: 'unknown', reason: 'verify-failed' }, { ok: false, status: 'unknown', reason: 'bad-chain' }, { ok: false, status: 'signed' }, null]) {
      expect(author(v), JSON.stringify(v)).toBe('unknown')
    }
    expect(h.selfCheckFileState('author', undefined, [PIN])).toBe('unknown')
  })

  it('Microsoft DLL: valid and signed by Microsoft Corporation, never by us', () => {
    expect(ms({})).toBe('ok')
    expect(ms({ thumbprint: MS_D3D.toLowerCase() })).toBe('ok')
    // signed again with OUR certificate (a pin), whatever the status
    expect(ms({ thumbprint: PIN, signer: AUTHOR, status: 1, hresult: '0x800B0109' })).toBe('bad')
    expect(ms({ thumbprint: PIN, status: 0 }, [PIN.toLowerCase()])).toBe('bad')
    // NotSigned / HashMismatch / NotTrusted
    expect(ms({ status: 2, sigType: 'None', thumbprint: null, signer: null, hresult: '0x800B0100' })).toBe('bad')
    expect(ms({ status: 3, hresult: '0x80096010' })).toBe('bad')
    expect(ms({ status: 4 })).toBe('bad')
    // valid, but someone else's DLL; or a self-signed impostor named "Microsoft Corporation"
    expect(ms({ thumbprint: OTHER, signer: 'Contoso Ltd' })).toBe('bad')
    expect(ms({ thumbprint: OTHER, status: 1, hresult: '0x800B0109' })).toBe('bad')
    // cannot decide: missing / unreadable file, catalog signature, revocation offline, odd output
    expect(ms({ status: -1, error: 'System.IO.FileNotFoundException', thumbprint: null })).toBe('unknown')
    expect(ms({ sigType: 'Catalog' })).toBe('unknown')
    expect(ms({ status: 1, hresult: '0x80092013' })).toBe('unknown')
    expect(ms({ status: 1, hresult: null })).toBe('unknown')
    expect(ms({ status: 5 })).toBe('unknown')
    expect(ms({ v: 2 })).toBe('unknown')
    expect(ms({ thumbprint: 'nope' })).toBe('unknown')
    expect(h.selfCheckFileState('microsoft', { parsed: null }, [PIN])).toBe('unknown')
    expect(h.selfCheckFileState('other', { parsed: raw({}), verdict: SIGNED }, [PIN])).toBe('unknown')
  })

  it('combine: the exe decides unless signed; then a bad DLL → tampered, any other doubt → unknown', () => {
    const ok = h.SELF_CHECK_FILES.map((f) => ({ name: f.name, state: 'ok' }))
    expect(h.combineSelfCheck(SIGNED, ok)).toBe(SIGNED)
    expect(h.combineSelfCheck(SIGNED, [])).toBe(SIGNED)
    for (const exe of [
      { ok: false, status: 'tampered', reason: 'hash-mismatch' },
      { ok: false, status: 'other-signer', reason: 'other-signer', signer: AUTHOR, thumbprint: OTHER },
      { ok: false, status: 'unsigned', reason: 'not-signed' },
      { ok: false, status: 'unknown', reason: 'verify-failed' },
      { ok: false, status: 'signed' },
    ]) {
      expect(h.combineSelfCheck(exe, [{ name: 'ffmpeg.dll', state: 'bad' }]), exe.status).toBe(exe)
    }
    const swapped = ok.map((f) => (f.name === 'ffmpeg.dll' ? { ...f, state: 'bad' } : f))
    expect(h.combineSelfCheck(SIGNED, swapped)).toEqual({ ok: false, status: 'tampered', reason: 'hash-mismatch', timestamped: false, files: ['ffmpeg.dll'] })
    const missing = ok.map((f) => (f.name === 'dxil.dll' ? { ...f, state: 'unknown' } : f))
    expect(h.combineSelfCheck(SIGNED, missing)).toEqual({ ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false, files: ['dxil.dll'] })
    // bad wins over unknown
    expect(h.combineSelfCheck(SIGNED, [...missing, { name: 'vulkan-1.dll', state: 'bad' }])).toMatchObject({ status: 'tampered', files: ['vulkan-1.dll'] })
    // odd input fails closed
    expect(h.combineSelfCheck(SIGNED, [null, { name: 'x.dll', state: 'OK' }])).toMatchObject({ status: 'unknown', files: ['?', 'x.dll'] })
    expect(h.combineSelfCheck(SIGNED, 'ok')).toMatchObject({ status: 'unknown' })
    expect(h.combineSelfCheck(null, ok)).toEqual({ ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false })
  })

  it('the payload of a tampered DLL carries no signer / thumbprint (shown as "File của SanoVids đã bị thay đổi")', () => {
    const v = h.combineSelfCheck(SIGNED, [{ name: 'ffmpeg.dll', state: 'bad' }])
    expect(h.appSignaturePayload(v, { packaged: true })).toEqual({ status: 'tampered', packaged: true })
    expect(h.appSignaturePayload(h.combineSelfCheck(SIGNED, [{ name: 'dxil.dll', state: 'unknown' }]), { packaged: true })).toEqual({ status: 'unknown', packaged: true })
    expect(h.appSignaturePayload(h.combineSelfCheck(SIGNED, h.SELF_CHECK_FILES.map((f) => ({ name: f.name, state: 'ok' }))), { packaged: true })).toEqual({
      status: 'signed',
      packaged: true,
      signer: AUTHOR,
      thumbprint: PIN,
    })
  })
})

describe('hardening rules: macOS application menu, text menu, close button', () => {
  /** Every item of a template, submenus included. */
  const flat = (items: MenuItem[]): MenuItem[] => items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])])
  const roles = (items: MenuItem[]) => flat(items).map((i) => i.role).filter(Boolean)

  it('macMenuTemplate: SanoVids / Sửa / Cửa sổ, roles only, Vietnamese labels', () => {
    const t = h.macMenuTemplate({ appName: 'SanoVids' })
    expect(t.map((m) => m.label)).toEqual(['SanoVids', 'Sửa', 'Cửa sổ'])
    const labelled = (m: MenuItem) => (m.submenu ?? []).map((i) => (i.type === 'separator' ? '─' : `${i.role}=${i.label}`))
    expect(labelled(t[0])).toEqual(['about=Giới thiệu SanoVids', '─', 'hide=Ẩn SanoVids', 'hideOthers=Ẩn các ứng dụng khác', 'unhide=Hiện tất cả', '─', 'quit=Thoát SanoVids'])
    expect(labelled(t[1])).toEqual(['undo=Hoàn tác', 'redo=Làm lại', '─', 'cut=Cắt', 'copy=Sao chép', 'paste=Dán', 'selectAll=Chọn tất cả'])
    expect(t[2].role).toBe('window')
    expect(labelled(t[2])).toEqual(['minimize=Thu nhỏ', 'zoom=Phóng to', 'close=Đóng cửa sổ', '─', 'front=Đưa tất cả ra trước'])
    // roles only: no click handlers, no accelerators of our own, every item is a role, a separator or a submenu
    for (const item of flat(t)) {
      expect(Object.keys(item).every((k) => ['label', 'role', 'type', 'submenu'].includes(k)), JSON.stringify(item)).toBe(true)
      expect(item.role || item.type === 'separator' || item.submenu, JSON.stringify(item)).toBeTruthy()
    }
  })

  it('macMenuTemplate: never reload / DevTools / zoom / View / Help (⌘R would drop the undo history)', () => {
    const all = roles(h.macMenuTemplate({ appName: 'SanoVids' }))
    for (const r of ['reload', 'forceReload', 'toggleDevTools', 'zoomIn', 'zoomOut', 'resetZoom', 'viewMenu', 'help']) {
      expect(h.MAC_MENU_REFUSED_ROLES).toContain(r)
      expect(all, r).not.toContain(r)
    }
    expect(all.some((r) => /devtools|inspect/i.test(String(r)))).toBe(false)
  })

  it('macMenuTemplate: the app name is cleaned (controls dropped, capped), SanoVids when missing', () => {
    expect(h.macMenuTemplate({ appName: 'SanoVidsMacTest' })[0].submenu![6].label).toBe('Thoát SanoVidsMacTest')
    expect(h.macMenuTemplate({ appName: 'Sano\u0000Vids\n' })[0].label).toBe('SanoVids')
    expect(h.macMenuTemplate({ appName: '' })[0].label).toBe('SanoVids')
    expect(h.macMenuTemplate(null)[0].label).toBe('SanoVids')
    expect(h.macMenuTemplate({ appName: 42 })[0].label).toBe('SanoVids')
    expect(h.macMenuTemplate({ appName: 'x'.repeat(100) })[0].label).toHaveLength(40)
  })

  it('textContextMenu: in a text field, Cắt / Sao chép / Dán / Chọn tất cả enabled by editFlags', () => {
    const all = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canUndo: true, canRedo: true, canDelete: true }
    const t = h.textContextMenu({ isEditable: true, selectionText: '', editFlags: all })!
    expect(t.map((i) => (i.type === 'separator' ? '─' : `${i.role}=${i.label}`))).toEqual(['cut=Cắt', 'copy=Sao chép', 'paste=Dán', '─', 'selectAll=Chọn tất cả'])
    expect(t.filter((i) => i.role).every((i) => i.enabled === true)).toBe(true)
    const none = h.textContextMenu({ isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: false } })!
    expect(none.filter((i) => i.role).map((i) => `${i.role}:${i.enabled}`)).toEqual(['cut:false', 'copy:false', 'paste:true', 'selectAll:false'])
    // flags missing or odd: everything disabled (never enabled by default)
    const odd = h.textContextMenu({ isEditable: true, editFlags: { canCut: 'yes' } })!
    expect(odd.filter((i) => i.role).every((i) => i.enabled === false)).toBe(true)
    expect(h.textContextMenu({ isEditable: true })!.filter((i) => i.role).every((i) => i.enabled === false)).toBe(true)
  })

  it('textContextMenu: selected text elsewhere → Sao chép only; nothing → no menu', () => {
    expect(h.textContextMenu({ isEditable: false, selectionText: 'canvasapp', editFlags: { canCopy: true } })).toEqual([{ role: 'copy', label: 'Sao chép', enabled: true }])
    expect(h.textContextMenu({ isEditable: false, selectionText: 'x', editFlags: {} })).toEqual([{ role: 'copy', label: 'Sao chép', enabled: true }])
    expect(h.textContextMenu({ isEditable: false, selectionText: 'x', editFlags: { canCopy: false } })![0].enabled).toBe(false)
    for (const p of [{ isEditable: false, selectionText: '' }, { isEditable: false, selectionText: '   \n' }, { isEditable: 'true' }, {}, null, undefined, 'x', 42]) {
      expect(h.textContextMenu(p), JSON.stringify(p)).toBeNull()
    }
  })

  it('textContextMenu: roles only, from the fixed list — never inspect / DevTools / spelling / navigation', () => {
    expect([...h.TEXT_MENU_ROLES]).toEqual(['cut', 'copy', 'paste', 'selectAll'])
    const cases = [
      h.textContextMenu({ isEditable: true, selectionText: 'a', editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }),
      h.textContextMenu({ isEditable: false, selectionText: 'a', misspelledWord: 'teh', dictionarySuggestions: ['the'], linkURL: 'https://x', editFlags: { canCopy: true } }),
    ]
    for (const t of cases) {
      for (const item of t!) {
        expect(Object.keys(item).every((k) => ['label', 'role', 'type', 'enabled'].includes(k)), JSON.stringify(item)).toBe(true)
        if (item.type !== 'separator') expect(h.TEXT_MENU_ROLES).toContain(item.role)
      }
    }
    expect(hardeningSource).not.toMatch(/inspectElement|\bclick\s*:/)
  })

  it('mainWindowCloseHides: macOS hides unless quitting (⌘Q) or an update quits; Windows always closes', () => {
    expect(h.mainWindowCloseHides({ platform: 'darwin', quitting: false, quittingForUpdate: false })).toBe(true)
    expect(h.mainWindowCloseHides({ platform: 'darwin' })).toBe(true)
    expect(h.mainWindowCloseHides({ platform: 'darwin', quitting: true, quittingForUpdate: false })).toBe(false)
    expect(h.mainWindowCloseHides({ platform: 'darwin', quitting: false, quittingForUpdate: true })).toBe(false)
    for (const platform of ['win32', 'linux', '', undefined]) expect(h.mainWindowCloseHides({ platform, quitting: false }), String(platform)).toBe(false)
    expect(h.mainWindowCloseHides(null)).toBe(false)
  })
})

describe('hardening rules: a main window hidden by its close button (macOS createHiddenWork)', () => {
  /** Electron's effects, recorded; timers run only when the test says so. */
  function harness() {
    const log: string[] = []
    const timers = new Map<number, () => void>()
    let nextTimer = 1
    let nextBlocker = 0 // Electron's first blocker id may be 0: never tested for truthiness
    const live = new Set<number>()
    const work = h.createHiddenWork({
      setThrottling: (on) => log.push(`throttling:${on}`),
      setMuted: (on) => log.push(`muted:${on}`),
      startBlocker: () => {
        const id = nextBlocker++
        live.add(id)
        log.push(`start:${id}`)
        return id
      },
      stopBlocker: (id) => {
        live.delete(id as number)
        log.push(`stop:${String(id)}`)
      },
      schedule: (fn, ms) => {
        expect(ms).toBe(h.HIDDEN_WORK_SETTLE_MS)
        const id = nextTimer++
        timers.set(id, fn)
        return id
      },
      cancel: (t) => {
        timers.delete(t as number)
        log.push('cancel')
      },
    })
    const settle = () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const fn of pending) fn()
    }
    return { work, log, live, settle, pendingTimers: () => timers.size }
  }

  it('hidden with nothing being made: sound off, but NO power-save blocker and throttling left on (the Mac may sleep)', () => {
    const { work, log, live, settle } = harness()
    work.hide()
    settle()
    expect(log).toEqual(['muted:true'])
    expect(live.size).toBe(0)
    expect(work.state()).toEqual({ hidden: true, busy: false, held: false, muted: true })
  })

  it('hidden while takes are being made: ONE blocker + throttling off, only after the settle delay (the page sees itself hidden first)', () => {
    const { work, log, live, settle } = harness()
    work.setBusy(true)
    expect(log).toEqual([]) // shown: nothing to hold
    work.hide()
    expect(log).toEqual(['muted:true']) // nothing held before the page could save its drafts
    settle()
    expect(log).toEqual(['muted:true', 'throttling:false', 'start:0'])
    expect(live.size).toBe(1)
    work.setBusy(true) // repeated: still one blocker
    work.hide() // already hidden: no second timer, no second blocker
    settle()
    expect(live.size).toBe(1)
    expect(log.filter((l) => l.startsWith('start:'))).toHaveLength(1)
  })

  it('the work ends while hidden: blocker stopped and throttling back on, as a pair; it starts again: held again', () => {
    const { work, log, live, settle } = harness()
    work.setBusy(true)
    work.hide()
    settle()
    log.length = 0
    work.setBusy(false)
    expect(log).toEqual(['throttling:true', 'stop:0'])
    expect(live.size).toBe(0)
    expect(work.state().held).toBe(false)
    work.setBusy(true) // a queued take starts while hidden
    expect(log.slice(2)).toEqual(['throttling:false', 'start:1'])
    expect(live.size).toBe(1)
  })

  it('shown again: sound on, everything let go; shown before the delay: nothing is ever held', () => {
    const { work, log, live, settle, pendingTimers } = harness()
    work.setBusy(true)
    work.hide()
    settle()
    log.length = 0
    work.show()
    expect(log).toEqual(['muted:false', 'throttling:true', 'stop:0'])
    expect(live.size).toBe(0)
    log.length = 0
    work.hide()
    work.show() // the Dock icon within the settle delay
    expect(pendingTimers()).toBe(0)
    settle()
    expect(log).toEqual(['muted:true', 'cancel', 'muted:false'])
    expect(live.size).toBe(0)
    work.show() // a 'show' without a hide (the window was only uncovered): nothing to undo
    expect(log).toEqual(['muted:true', 'cancel', 'muted:false'])
  })

  it('stop (window closed / ⌘Q): everything held is let go; the busy answer is kept; anything but true is not busy', () => {
    const { work, log, live, settle } = harness()
    work.setBusy(true)
    work.hide()
    settle()
    work.stop()
    expect(live.size).toBe(0)
    expect(log.slice(-2)).toEqual(['throttling:true', 'stop:0'])
    expect(work.state()).toMatchObject({ hidden: false, busy: true, held: false })
    for (const v of ['true', 1, {}, null, undefined]) {
      work.setBusy(v)
      expect(work.state().busy, String(v)).toBe(false)
    }
  })
})

describe('hardening wiring (main.cjs / preload.cjs sources)', () => {
  const idx = (s: string) => {
    const i = mainSource.indexOf(s)
    expect(i, s).toBeGreaterThan(-1)
    return i
  }
  const count = (s: string) => mainSource.split(s).length - 1
  /** [start, end) of the block opened by the first '{' at or after `from`. */
  const blockAt = (from: number): [number, number] => {
    const open = mainSource.indexOf('{', from)
    let depth = 0
    for (let i = open; i < mainSource.length; i++) {
      if (mainSource[i] === '{') depth++
      else if (mainSource[i] === '}' && --depth === 0) return [open, i + 1]
    }
    throw new Error('unbalanced block')
  }

  it('refuses switches before anything is written or locked, then enables the sandbox before ready', () => {
    const guard = idx('hardening.refusedSwitches(')
    const exit3 = idx('process.exit(3)')
    expect(idx("require('./hardening-rules.cjs')")).toBeLessThan(guard)
    expect(guard).toBeGreaterThan(idx('process.exit(2)'))
    for (const later of ["app.setPath('userData'", 'fs.mkdirSync(profile.dir', 'requestSingleInstanceLock']) {
      expect(guard, later).toBeLessThan(idx(later))
      expect(exit3, later).toBeLessThan(idx(later))
    }
    expect(mainSource).toContain("dialog.showErrorBox('SanoVids', hardening.REFUSED_DIALOG_TEXT)")
    expect(mainSource).toContain('hasSwitch: (n) => app.commandLine.hasSwitch(n)')
    expect(mainSource).toContain(
      'hardening.refusedSwitches({ isPackaged: PACKAGED, profileSource: profile.source, testBuild: TEST_BUILD, hasSwitch: (n) => app.commandLine.hasSwitch(n) })',
    )
    expect(idx('app.enableSandbox()')).toBeLessThan(idx('app.whenReady()'))
  })

  it('packaged = isPackagedApp (never app.isPackaged alone); test build = a baked test profile', () => {
    expect(mainSource).toContain('const PACKAGED = hardening.isPackagedApp({ isPackaged: app.isPackaged, appPath: app.getAppPath() })')
    // app.isPackaged appears only in comments and in that one definition
    const code = mainSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code.split('app.isPackaged').length - 1).toBe(1)
    expect(idx('const PACKAGED =')).toBeLessThan(idx('hardening.refusedSwitches('))
    expect(mainSource).toContain("const TEST_BUILD = typeof bakedProfileDir === 'string' && bakedProfileDir !== ''")
    expect(mainSource).toContain('baked: bakedProfileDir,')
    expect([...mainSource.matchAll(/(?<!function )readBakedProfileDir\(\)/g)]).toHaveLength(1) // read once, reused
  })

  it('SSLKEYLOGFILE is dropped after the switch refusal and before anything else starts', () => {
    const strip = idx('hardening.envToStrip({ isPackaged: PACKAGED, env: process.env })')
    expect(mainSource).toContain('for (const name of hardening.envToStrip({ isPackaged: PACKAGED, env: process.env })) delete process.env[name]')
    expect(strip).toBeGreaterThan(idx('process.exit(3)'))
    for (const later of ['app.enableSandbox()', "app.setPath('userData'", 'requestSingleInstanceLock', 'app.whenReady()']) expect(strip, later).toBeLessThan(idx(later))
  })

  it('DevTools: devTools: DEVTOOLS on the 3 webPreferences, shortcuts only inside if (DEVTOOLS)', () => {
    expect(count('devTools: DEVTOOLS')).toBe(3)
    expect(mainSource).toContain('const DEVTOOLS = hardening.allowDevTools({ isPackaged: PACKAGED, profileSource: profile.source, testBuild: TEST_BUILD })')
    const [start, end] = blockAt(idx('if (DEVTOOLS) {'))
    const toggles = [...mainSource.matchAll(/toggleDevTools|openDevTools/g)].map((m) => m.index!)
    expect(toggles.length).toBeGreaterThan(0)
    for (const at of toggles) expect(at > start && at < end, `toggle at ${at}`).toBe(true)
    expect(mainSource.slice(start, end)).toContain("'before-input-event'")
  })

  it("self-check: 'app:signature' behind fromApp, cached, started after ready-to-show", () => {
    expect(count("ipcMain.handle('app:signature'")).toBe(1)
    expect(count("ipcMain.on('app:signature'")).toBe(0)
    expect(mainSource).toContain("ipcMain.handle('app:signature', (event) => (fromApp(event) ? appSignature() : { status: 'unknown', packaged: false }))")
    expect(mainSource).toContain('setTimeout(() => void appSignature(), 3000)')
    expect(mainSource).toContain('hardening.appSignaturePayload(verdict, { packaged: true })')
    expect(mainSource).toContain("computeAppSignature().catch(() => ({ status: 'unknown', packaged: PACKAGED }))")
    expect(mainSource).toContain("if (!PACKAGED) return { status: 'unsigned', packaged: false }")
    expect(idx('registerAppBridge()')).toBeLessThan(idx('function registerAppBridge()'))
  })

  it('self-check covers the exe AND the DLLs next to it, in one PowerShell, combined by hardening-rules', () => {
    const [start, end] = blockAt(idx('async function computeAppSignature()'))
    const body = mainSource.slice(start, end)
    expect(body).toContain('const companions = hardening.SELF_CHECK_FILES')
    expect(body).toContain('signature.checkFilesSignature([process.execPath, ...companions.map((f) => path.join(dir, f.name))], { pins, log })')
    expect(body).toContain('const dir = path.dirname(process.execPath)')
    expect(body).toContain('hardening.selfCheckFileState(f.kind, results[i + 1], pins)')
    expect(body).toContain('hardening.combineSelfCheck(results[0] && results[0].verdict, states)')
    expect(body).not.toContain('checkFileSignature(')
    expect(body.indexOf('combineSelfCheck')).toBeLessThan(body.indexOf('appSignaturePayload'))
  })

  it('window icon, downloads, permissions, webview / bluetooth, CSP', () => {
    expect(mainSource).toContain("process.platform === 'win32' ? 'icon.ico' : 'icon-512.png'")
    // will-download: refused before any save path is set
    const dl = idx("'will-download'")
    expect(idx('hardening.downloadAllowed(item.getURL(), item.getFilename())')).toBeGreaterThan(dl)
    expect(idx('hardening.downloadAllowed(')).toBeLessThan(idx('item.setSavePath('))
    expect(mainSource).toContain('item.cancel()')
    // default session permissions
    expect(mainSource).toContain('ses.setPermissionRequestHandler((_wc, permission, callback) => callback(hardening.permissionAllowed(permission)))')
    expect(mainSource).toContain('ses.setPermissionCheckHandler((_wc, permission) => hardening.permissionAllowed(permission))')
    expect(count('setDevicePermissionHandler(() => false)')).toBe(2) // default session + canvasapp partition
    // exactly one bluetooth handler per webContents (app-wide)
    expect(count("'select-bluetooth-device'")).toBe(1)
    expect(idx("'select-bluetooth-device'")).toBeGreaterThan(idx("app.on('web-contents-created'"))
    // CSP on every HTML response of serveDist (file + SPA fallback), from hardening-rules
    expect(count("'content-security-policy'")).toBe(2)
    expect(mainSource).toContain("if (ext === '.html') headers['content-security-policy'] = await htmlCsp()")
    expect(mainSource).toContain('hardening.contentSecurityPolicy(bytes, SANO ? SANO.origin : undefined)')
    // canvasapp login popups: every level gets the https-only handler
    expect(mainSource).toContain("w.webContents.on('did-create-window', (child) => guardPopups(child))")
  })

  it('keeps the strings the updater / profile tests rely on', () => {
    for (const s of [
      'process.exit(2)',
      "app.setPath('userData', profile.dir)",
      'fsMod: { existsSync: fs.existsSync, realpathSync: fs.realpathSync.native }',
      "app.on('quit', (_event, exitCode) => updater && updater.onQuit(exitCode))",
    ]) {
      expect(mainSource, s).toContain(s)
    }
    expect(mainSource).not.toMatch(/forceDevUpdateConfig|setFeedURL\(/)
    expect(mainSource).toMatch(/contextIsolation: true,\s+nodeIntegration: false,\s+sandbox: true,/)
  })

  it('video downloads: three IPC calls behind guard (fromApp), owner-keyed, closed on navigation / crash / close / logout', () => {
    for (const ch of ['canvasapp:downloadOpen', 'canvasapp:downloadRead', 'canvasapp:downloadClose']) {
      expect(count(`'${ch}'`), ch).toBe(1)
      const at = idx(`'${ch}'`)
      expect(mainSource.slice(at - 30, at)).toMatch(/ipcMain\.handle\(\s*$/)
      expect(mainSource.slice(at, at + 60)).toMatch(/^'[\w:]+',\s+guard\(\(event, args\) =>/)
    }
    expect(mainSource).toContain('return canvasappDownloads.open(event.sender.id, args)')
    expect(mainSource).toContain("ipcMain.handle('canvasapp:downloadRead', guard((event, args) => canvasappDownloads.read(event.sender.id, args)))")
    expect(mainSource).toContain("ipcMain.handle('canvasapp:downloadClose', guard((event, args) => canvasappDownloads.close(event.sender.id, args)))")
    // the page that opened a download is watched before it opens: reload / navigation, crash, close end its downloads
    const open = idx("'canvasapp:downloadOpen'")
    expect(mainSource.slice(open, open + 400).indexOf('watchDownloadOwner(event.sender)')).toBeGreaterThan(-1)
    const [ws, we] = blockAt(idx('function watchDownloadOwner(wc)'))
    const watch = mainSource.slice(ws, we)
    expect(watch).toContain("wc.once('destroyed', closeAll)")
    expect(watch).toContain("wc.on('render-process-gone', closeAll)")
    // a navigation that happened (committed), never one main may still cancel (did-start-navigation fires before
    // will-navigate: a dropped link that opens in the browser would end every download of a page that stays)
    expect(watch).toContain("wc.on('did-navigate', closeAll)")
    // SANO desktop: SanoVids' own reload inside SANO's page is a subframe navigation
    expect(watch).toContain("wc.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame) => {")
    expect(watch).toContain("if (!isMainFrame && url.startsWith(ORIGIN + '/')) closeAll()")
    expect(watch).not.toContain('did-start-navigation')
    // SANO desktop: SANO removing SanoVids' frame (or sending it elsewhere) has no WebContents event: its pagehide ends them
    expect(mainSource).toContain("ipcMain.handle('canvasapp:downloadCloseAll', guard((event) => (canvasappDownloads.closeAll(event.sender.id), { ok: true })))")
    expect(preloadSource).toContain("if (location.origin === 'app://bdp') window.addEventListener('pagehide', () => void ipcRenderer.invoke('canvasapp:downloadCloseAll').catch(() => undefined))")
    // logout: no download may start from its first line (before anything awaits) until it is done; every download is
    // ended before the session is wiped and again after (properties, not line positions: the keep-login branch rewrites
    // this function)
    const [ls, le] = blockAt(idx('async function canvasappLogout()'))
    const logout = mainSource.slice(ls, le)
    expect(logout.trim().split('\n')[1].trim()).toBe('canvasappDownloadsBlocked = true')
    const wipe = logout.indexOf('await ses.clearStorageData()')
    expect(logout.indexOf('canvasappDownloads.closeAll()')).toBeGreaterThan(-1)
    expect(logout.indexOf('canvasappDownloads.closeAll()')).toBeLessThan(wipe)
    expect(logout.lastIndexOf('canvasappDownloads.closeAll()')).toBeGreaterThan(wipe)
    expect(logout).toMatch(/finally \{\s+canvasappDownloadsBlocked = false/)
    expect(mainSource.slice(open, open + 300)).toMatch(/if \(canvasappDownloadsBlocked\) return \{ ok: false, code: 'busy'/)
    // the sessions use the allowlist, the 'download' lane and the canvasapp partition (no other session, no URL from the page)
    const [cs, ce] = blockAt(idx('const canvasappDownloads = createDownloadSessions('))
    const wiring = mainSource.slice(cs, ce)
    expect(wiring).toContain("withSlot: (fn) => withCanvasappSlot('download', fn)")
    expect(wiring).toContain("const m = matchCanvasappRoute('GET', rawPath)")
    // the GET goes through <canvasapp-net-get> (net.request, redirect 'manual', https only), never session.fetch
    // (which follows https → http and cannot even tell where it ended)
    // (each net.request is watched until Electron reports it over: Đăng xuất waits for it — drainCanvasappRequests)
    expect(wiring).toContain('fetch: (url, init) => canvasappNetGet({ request: (opts) => watchDownloadRequest(net.request(opts)), toWeb: (res) => Readable.toWeb(res), session: canvasappSession() }, url, init),')
    expect(wiring).not.toContain('.fetch(')
    const netGet = /\/\/ <canvasapp-net-get>[^\n]*\n([\s\S]*?)\/\/ <\/canvasapp-net-get>/.exec(mainSource)![1]
    expect(netGet).toContain("credentials: 'include', redirect: 'manual', bypassCustomProtocolHandlers: true")
    expect(netGet).toContain("new URL(String(url)).protocol === 'https:'")
    // the pure blocks: no require, no Buffer, no Electron
    for (const name of ['canvasapp-downloads', 'canvasapp-net-get']) {
      const block = new RegExp(`// <${name}>[^\\n]*\\n([\\s\\S]*?)// </${name}>`).exec(mainSource)![1]
      const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(code, name).not.toMatch(/\brequire\s*\(|\bBuffer\b|\bsession\.|\bnet\.|\bipcMain\b|\bwebContents\b|\bprocess\./)
    }
    // canvasapp:request never carries a video (only the pieces above do): no binary branch, no 'download' lane there
    const [rs, re] = blockAt(idx('async function canvasappRequest(req)'))
    const request = mainSource.slice(rs, re)
    expect(request).toContain('const match = matchCanvasappRequest(method, req.path)')
    expect(request).not.toMatch(/route\.binary|arrayBuffer|'download'/)
    // a cached job list is stamped with when its request LEFT (not when the answer came): a cache hit is never taken
    // for a newer list than it is (the adapter trusts a read to show what existed 15 s before it was sent)
    expect(request).toContain('canvasappJobListCache.set(cacheKey, { at: sentAt, result })')
    expect(request).toMatch(/sentAt = Date\.now\(\)\s+const res = await canvasappSession\(\)\.fetch\(/)
    expect(request).not.toContain('canvasappJobListCache.set(cacheKey, { at: Date.now()')
    // a lookup after a lost answer (`fresh`) never gets a cached list older than CANVASAPP_JOBS_FRESH_MS (5 s)
    expect(request).toContain('Date.now() - hit.at < (req.fresh === true ? CANVASAPP_JOBS_FRESH_MS : CANVASAPP_JOBS_MIN_MS)')
    expect(mainSource).toContain('const CANVASAPP_JOBS_FRESH_MS = 5_000')
  })

  it('preload: the canvasapp block forwards only plain data (download calls: id, path, from)', () => {
    const block = /\n {2}canvasapp: \{([\s\S]*?)\n {2}\},\n/.exec(preloadSource)
    expect(block).not.toBeNull()
    expect([...block![1].matchAll(/^ {4}(\w+): /gm)].map((m) => m[1])).toEqual(['status', 'login', 'logout', 'keepLogin', 'setKeepLogin', 'request', 'downloadOpen', 'downloadRead', 'downloadClose', 'checkout'])
    expect(block![1]).toContain("ipcRenderer.invoke('canvasapp:downloadOpen', {\n        id: str(a && a.id),\n        path: str(a && a.path),\n        from: a && Number.isSafeInteger(a.from) && a.from > 0 ? a.from : 0,\n      })")
    expect(block![1]).toContain("downloadRead: (a) => ipcRenderer.invoke('canvasapp:downloadRead', { id: str(a && a.id) })")
    expect(block![1]).toContain("downloadClose: (a) => ipcRenderer.invoke('canvasapp:downloadClose', { id: str(a && a.id) })")
  })

  it('hardening-rules.cjs requires nothing', () => {
    expect(hardeningSource).not.toMatch(/\brequire\s*\(/)
  })

  it("app:placement: behind fromApp, no argument, a kind only (never a path), computed once by updater-rules", () => {
    expect(count("ipcMain.handle('app:placement'")).toBe(1)
    expect(count("ipcMain.on('app:placement'")).toBe(0)
    expect(mainSource).toContain("ipcMain.handle('app:placement', (event) => (fromApp(event) ? appPlacement() : { kind: 'unknown' }))")
    // registered with app:signature in registerAppBridge (called on ready)
    const [rs, re] = blockAt(idx('function registerAppBridge()'))
    expect(mainSource.slice(rs, re)).toContain("ipcMain.handle('app:placement'")
    expect(idx('registerAppBridge()')).toBeLessThan(idx('function registerAppBridge()'))
    // the payload is { kind } and nothing else: kind comes from updater-rules.placement (a fixed set of strings)
    const [start, end] = blockAt(idx('function appPlacement()'))
    const body = mainSource.slice(start, end)
    expect(body).toContain('placementPayload = { kind }')
    expect(body).toContain('kind = updaterRules.placement({')
    expect(body).toContain("kind = PACKAGED ? 'portable' : 'dev'")
    expect(body.split('placementPayload =').length - 1).toBe(1)
    expect(body).toMatch(/return placementPayload\s*\}$/)
    // the placement rule gets the packaged flag used by every hardening decision, never app.isPackaged
    expect(body).toContain('isPackaged: PACKAGED,')
  })

  it('portable taskbar identity: setAppDetails only with what updater-rules.portableRelaunch returns', () => {
    const [start, end] = blockAt(idx('function createWindow()'))
    const body = mainSource.slice(start, end)
    expect(body).toContain('const relaunch = updaterRules.portableRelaunch({')
    expect(body).toContain('isPackaged: PACKAGED,')
    expect(body).toMatch(/if \(relaunch\) \{\s+try \{\s+win\.setAppDetails\(relaunch\)/)
    expect(count('setAppDetails(')).toBe(1)
  })

  it('preload: app block (signature, placement) before canvasapp, updates still the last block', () => {
    const appAt = preloadSource.indexOf('  app: {')
    expect(appAt).toBeGreaterThan(preloadSource.indexOf('  platform: process.platform,'))
    expect(appAt).toBeLessThan(preloadSource.indexOf('  canvasapp: {'))
    const block = /\n {2}app: \{([\s\S]*?)\n {2}\},\n/.exec(preloadSource)
    expect(block).not.toBeNull()
    expect([...block![1].matchAll(/^ {4}(\w+): /gm)].map((m) => m[1])).toEqual(['signature', 'placement', 'setBusy'])
    expect(block![1]).toContain("signature: () => ipcRenderer.invoke('app:signature')")
    expect(block![1]).toContain("placement: () => ipcRenderer.invoke('app:placement')")
    expect(block![1]).toContain("setBusy: (busy) => ipcRenderer.invoke('app:busy', busy === true)")
    expect(/updates: \{([\s\S]*?)\n {2}\},\n\}\)/.exec(preloadSource)).not.toBeNull()
    const topKeys = [...preloadSource.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1])
    expect(topKeys.at(-1)).toBe('updates')
    expect(topKeys.indexOf('app')).toBe(topKeys.indexOf('platform') + 1)
  })

  it('preload: "Giữ đăng nhập" lives INSIDE the canvasapp block (no new top-level key); only a boolean crosses', () => {
    const block = /\n {2}canvasapp: \{([\s\S]*?)\n {2}\},\n/.exec(preloadSource)
    expect(block).not.toBeNull()
    expect([...block![1].matchAll(/^ {4}(\w+): /gm)].map((m) => m[1])).toEqual(expect.arrayContaining(['status', 'login', 'logout', 'keepLogin', 'setKeepLogin', 'request']))
    expect(block![1]).toContain("keepLogin: () => ipcRenderer.invoke('canvasapp:keepLogin')")
    expect(block![1]).toContain("setKeepLogin: (on) => ipcRenderer.invoke('canvasapp:setKeepLogin', on === true)")
    const topKeys = [...preloadSource.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1])
    expect(topKeys).not.toContain('keepLogin')
    expect(topKeys).not.toContain('setKeepLogin')
    expect(count("'canvasapp:keepLogin'") + count("'canvasapp:setKeepLogin'")).toBe(2) // main: one handler each
    // the keep-login rules module is pure like hardening-rules (no require), and main never adds a quit hook for it
    expect(mainSource).toContain("const keepLoginRules = require('./keeplogin-rules.cjs')")
    // no quit hook for the keep-login copy: the only 'before-quit' is macOS's window flag (tested below)
    expect(mainSource).not.toMatch(/'will-quit'/)
    expect(count("app.on('before-quit'")).toBe(1)
  })

  /** [start, end) of every `if (process.platform === 'darwin') {` block. */
  const darwinBlocks = () => [...mainSource.matchAll(/if \(process\.platform === 'darwin'\) \{/g)].map((m) => blockAt(m.index!))
  const inDarwinBlock = (at: number) => darwinBlocks().some(([s, e]) => at > s && at < e)
  /** Body of `function name(` (the block after its parameter list). */
  const fnBody = (name: string) => {
    const at = mainSource.search(new RegExp(`(async )?function ${name}\\(`))
    expect(at, name).toBeGreaterThan(-1)
    const [s, e] = blockAt(mainSource.indexOf(')', at))
    return mainSource.slice(s, e)
  }

  it('macOS: the taskbar identity is Windows-only; the application menu is the role-only Mac menu, null elsewhere', () => {
    expect(count('setAppUserModelId(')).toBe(1)
    expect(mainSource).toContain("if (process.platform === 'win32') app.setAppUserModelId(updaterRules.appUserModelId(app.getName()))")
    expect(count('Menu.setApplicationMenu(')).toBe(1)
    expect(mainSource).toContain(
      "Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate(hardening.macMenuTemplate({ appName: app.getName() })) : null)",
    )
    // inside app.whenReady (a menu needs a ready app)
    const [rs, re] = blockAt(idx('app.whenReady().then(() => {'))
    expect(idx('Menu.setApplicationMenu(')).toBeGreaterThan(rs)
    expect(idx('Menu.setApplicationMenu(')).toBeLessThan(re)
  })

  it('text menu: exactly one context-menu listener, in web-contents-created (every page, login popups too), roles from hardening-rules', () => {
    expect(count("'context-menu'")).toBe(1)
    const [ws, we] = blockAt(idx("app.on('web-contents-created'"))
    const at = idx("wc.on('context-menu'")
    expect(at > ws && at < we).toBe(true)
    const [cs, ce] = blockAt(at)
    const body = mainSource.slice(cs, ce)
    expect(body).toContain('const template = hardening.textContextMenu(params)')
    expect(body).toContain('if (!template) return')
    expect(body).toContain('Menu.buildFromTemplate(template).popup(win ? { window: win } : {})')
    expect(mainSource).not.toMatch(/inspectElement|openDevTools/)
    // not added per window (createWindow, the canvasapp login / checkout windows keep no listener of their own)
    for (const fn of ['createWindow', 'canvasappLogin', 'canvasappCheckout']) expect(fnBody(fn), fn).not.toContain('context-menu')
  })

  it('macOS-only Electron APIs sit behind a darwin guard; isInApplicationsFolder is asked OUTSIDE appPlacement’s try', () => {
    const code = mainSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toContain('moveToApplicationsFolder')
    // isInApplicationsFolder: one call, in macInApplications, after its guard
    expect(code.split('isInApplicationsFolder()').length - 1).toBe(1)
    const inApps = fnBody('macInApplications')
    const guard = inApps.indexOf("if (process.platform === 'darwin' && PACKAGED && typeof app.isInApplicationsFolder === 'function') {")
    expect(guard).toBeGreaterThan(-1)
    expect(inApps.indexOf('app.isInApplicationsFolder()')).toBeGreaterThan(guard)
    const placement = fnBody('appPlacement')
    const asked = placement.indexOf('const inApplications = macInApplications()')
    expect(asked).toBeGreaterThan(-1)
    expect(asked).toBeLessThan(placement.indexOf('try {'))
    expect(placement).toContain('        inApplications,\n      })')
    expect(placement).not.toContain('isInApplicationsFolder')
    // app.dock: only in setDevDockIcon, after its own darwin test, called from a darwin block (sources only)
    const dockUses = [...code.matchAll(/app\.dock\b/g)]
    expect(dockUses.length).toBeGreaterThan(0)
    const dock = fnBody('setDevDockIcon')
    expect(dock.trim().split('\n')[1].trim()).toBe("if (process.platform !== 'darwin' || !app.dock || typeof app.dock.setIcon !== 'function') return")
    expect(mainSource.split('app.dock').length - 1).toBe(dock.split('app.dock').length - 1)
    expect(inDarwinBlock(idx('if (!PACKAGED) setDevDockIcon()'))).toBe(true)
    // Electron's own autoUpdater (Squirrel) is touched on macOS only
    expect(count("require('electron').autoUpdater")).toBe(1)
    expect(inDarwinBlock(idx("require('electron').autoUpdater"))).toBe(true)
  })

  it('downloads: one will-download listener on the default session, registered at ready (never per window); the page is not told', () => {
    expect(count("'will-download'")).toBe(1)
    expect(fnBody('registerDownloads')).toContain("session.defaultSession.on('will-download', (_event, item) => {")
    expect(fnBody('createWindow')).not.toContain('will-download')
    const [rs, re] = blockAt(idx('app.whenReady().then(() => {'))
    const call = idx('    registerDownloads()')
    expect(call > rs && call < re).toBe(true)
    expect(mainSource).not.toContain('bdp:downloaded')
    // macOS only: a refused download is said (Windows stays silent as before)
    const body = fnBody('registerDownloads')
    expect(inDarwinBlock(idx("if (state === 'interrupted') void showDownloadFailed()"))).toBe(true)
    expect(body.indexOf('hardening.downloadAllowed(')).toBeLessThan(body.indexOf('item.setSavePath('))
  })

  it('macOS close button / ⌘W: hides (out of full screen first), keeps working hidden in pairs, ⌘Q and an update quit for real', () => {
    const create = fnBody('createWindow')
    const closeAt = create.indexOf("win.on('close', (event) => {")
    expect(closeAt).toBeGreaterThan(-1)
    expect(inDarwinBlock(mainSource.indexOf("win.on('close', (event) => {"))).toBe(true)
    expect(create).toContain('hardening.mainWindowCloseHides({ platform: process.platform, quitting, quittingForUpdate: updating })')
    expect(create).toContain('const updating = macQuitForUpdate || !!(updater && updater.isQuittingForUpdate())')
    expect(create).toMatch(/return\s+event\.preventDefault\(\)\s+hideMainWindow\(win, work\)/)
    // one hidden-work controller per main window, macOS only (Windows: null, nothing listens)
    expect(create).toContain("const work = process.platform === 'darwin' ? hiddenWorkOf(win) : null")
    expect(create).toContain("win.on('show', () => work.show())")
    expect(create).toContain("win.webContents.on('render-process-gone', () => work.setBusy(false))")
    expect(inDarwinBlock(mainSource.indexOf("win.on('show', () => work.show())"))).toBe(true)
    expect(create).toMatch(/win\.on\('closed', \(\) => \{\s+if \(mainWindow === win\) mainWindow = null\s+if \(work\) work\.stop\(\)\s+if \(mainWindowWork === work\) mainWindowWork = null/)
    const hide = fnBody('hideMainWindow')
    for (const s of ['win.isFullScreen()', "win.once('leave-full-screen', hide)", 'win.setFullScreen(false)', 'work.hide()', 'win.hide()']) expect(hide, s).toContain(s)
    expect(hide.indexOf('work.hide()')).toBeLessThan(hide.indexOf('win.hide()')) // sound off before the window goes
    expect(hide).not.toContain('setBackgroundThrottling') // never at hide time: only createHiddenWork decides, later
    // Electron's effects only in hiddenWorkOf; throttling / blocker in pairs is createHiddenWork's job (tested above)
    const fx = fnBody('hiddenWorkOf')
    expect(fx).toContain('return hardening.createHiddenWork({')
    expect(fx).toContain('if (wc) wc.setBackgroundThrottling(on)')
    expect(fx).toContain('if (wc) wc.setAudioMuted(on)')
    expect(fx).toContain("startBlocker: () => require('electron').powerSaveBlocker.start('prevent-app-suspension'),")
    expect(fx).toContain("if (typeof id === 'number' && powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id)")
    expect(count('setBackgroundThrottling(')).toBe(1)
    expect(count('setAudioMuted(')).toBe(1)
    expect(count('powerSaveBlocker.start(')).toBe(1)
    expect(count('powerSaveBlocker.stop(')).toBe(1)
    expect(count('hiddenWorkOf(')).toBe(2) // definition + createWindow
    // the page says whether takes are being made: behind fromApp, from the main window only, a boolean only
    expect(count("ipcMain.handle('app:busy'")).toBe(1)
    const [bs, be] = blockAt(idx("ipcMain.handle('app:busy', (event, busy) => {"))
    const busyBody = mainSource.slice(bs, be)
    expect(busyBody).toContain('if (!fromApp(event) || !win || win.isDestroyed() || event.sender !== win.webContents || !mainWindowWork) return false')
    expect(busyBody).toContain('mainWindowWork.setBusy(busy === true)')
    const [ab, ae] = blockAt(idx('function registerAppBridge()'))
    expect(idx("ipcMain.handle('app:busy'") > ab && idx("ipcMain.handle('app:busy'") < ae).toBe(true)
    // the Dock icon / a second launch: sound back on even when no 'show' event follows
    expect(fnBody('showMainWindow')).toContain('if (mainWindowWork) mainWindowWork.show()')
    // quit flags: ⌘Q (before-quit, macOS only) and an update (before-quit-for-update)
    const quitAt = idx("app.on('before-quit', () => {")
    expect(inDarwinBlock(quitAt)).toBe(true)
    const [qs, qe] = blockAt(quitAt)
    expect(mainSource.slice(qs, qe)).toMatch(/^\{\s+quitting = true\s+if \(mainWindowWork\) mainWindowWork\.stop\(\)\s+\}$/)
    const updAt = idx("autoUpdater.on('before-quit-for-update', () => {")
    const [us, ue] = blockAt(updAt)
    expect(mainSource.slice(us, ue)).toMatch(/^\{\s+macQuitForUpdate = true\s+\}$/)
    // the Dock icon and a second launch bring THE main window back (never the first window found)
    expect(mainSource).toContain("app.on('activate', () => showMainWindow())")
    expect(mainSource).toContain("app.on('second-instance', () => showMainWindow())")
    expect(mainSource).not.toContain('getAllWindows()')
    const show = fnBody('showMainWindow')
    expect(show).toContain('if (!mainWindowShown) return')
    expect(show).toContain("if (process.platform === 'darwin' && app.isReady() && !macQuitForUpdate) {")
    // Windows: the app still quits with its last window
    expect(mainSource).toMatch(/app\.on\('window-all-closed', \(\) => \{\s+if \(process\.platform !== 'darwin'\) app\.quit\(\)/)
  })

  it('checkout window: never modal on macOS (a sheet has no close button), setMenu on Windows only', () => {
    expect(mainSource).toContain("modal: process.platform !== 'darwin' && !!parent,")
    expect(count('setMenu(')).toBe(1)
    expect(mainSource).toContain("if (process.platform !== 'darwin') win.setMenu(null)")
  })

  it('DevTools ⌘⌥I (macOS) stays inside if (DEVTOOLS)', () => {
    const [start, end] = blockAt(idx('if (DEVTOOLS) {'))
    const at = idx("input.meta && input.alt && input.code === 'KeyI'")
    expect(at > start && at < end).toBe(true)
  })

  it('folder / save panels carry a message (macOS shows it instead of the title); EPERM text comes from save-rules', () => {
    expect(fnBody('filesPickFolder')).toContain("message: 'Chọn thư mục lưu video',")
    const saveAs = fnBody('filesSaveAs')
    expect(saveAs).toContain('message: checked.title,')
    expect(saveAs).toContain('showsTagField: false,')
    // the overwrite rule is unchanged (the panel itself confirms a replace on both systems)
    expect(saveAs).toContain("properties: ['createDirectory', 'showOverwriteConfirmation'],")
    expect(fnBody('fsErrorText')).toContain('return saveErrorText(e, process.platform)')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Development-mode lock (electron/devaccess.cjs + devaccess-rules.cjs): wired without touching any protection.
// ---------------------------------------------------------------------------------------------------------------
describe('development-mode lock wiring (main.cjs / preload.cjs / devaccess*.cjs sources)', () => {
  const idx = (src: string, s: string) => {
    const i = src.indexOf(s)
    expect(i, s).toBeGreaterThan(-1)
    return i
  }
  const devOpenBuild = (createRequire(import.meta.url)('../../../electron/devaccess-rules.cjs') as { devOpenBuild: (o: { devToolsAllowed: boolean; testDevLock?: boolean }) => boolean }).devOpenBuild

  it('preload: a devAccess block right after app and before canvasapp; updates still last; app block unchanged; plain data only', () => {
    const topKeys = [...preloadSource.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1])
    expect(topKeys.indexOf('devAccess')).toBe(topKeys.indexOf('app') + 1)
    expect(topKeys.indexOf('devAccess')).toBe(topKeys.indexOf('canvasapp') - 1)
    expect(topKeys.at(-1)).toBe('updates')
    const block = /\n {2}devAccess: \{([\s\S]*?)\n {2}\},\n/.exec(preloadSource)
    expect(block).not.toBeNull()
    expect([...block![1].matchAll(/^ {4}(\w+): /gm)].map((m) => m[1])).toEqual(['initial', 'getState', 'unlock', 'lock', 'setKeep', 'totpBegin', 'totpConfirm', 'linkCancel', 'totpRemove', 'onState'])
    expect(block![1]).toContain("unlock: (code) => ipcRenderer.invoke('devAccess:unlock', { code: str(code).slice(0, 300) })")
    expect(block![1]).toContain("totpConfirm: (code) => ipcRenderer.invoke('devAccess:totpConfirm', { code: str(code).slice(0, 300) })")
    expect(block![1]).toContain("setKeep: (days) => ipcRenderer.invoke('devAccess:setKeep', { days: Number(days) })")
    expect(block![1]).toContain("ipcRenderer.on('devAccess:state', listener)")
    expect(block![1]).not.toMatch(/ipcRenderer\.send/)
    expect(preloadSource).toContain("const devAccessArg = process.argv.find((a) => a.startsWith('--bdp-dev-access='))")
  })

  it('main: lock computed after DEVTOOLS from it (never the other way), set up after ready and before the first window', () => {
    const devtools = idx(mainSource, 'const DEVTOOLS = hardening.allowDevTools(')
    const open = idx(mainSource, "const DEV_OPEN_BUILD = require('./devaccess-rules.cjs').devOpenBuild({ devToolsAllowed: DEVTOOLS, testDevLock: readTestDevLock() })")
    expect(open).toBeGreaterThan(devtools)
    const ready = idx(mainSource, 'app.whenReady().then(() => {')
    const setup = idx(mainSource, "devAccess = setupDevAccess({ userDataDir: app.getPath('userData'), buildOpen: DEV_OPEN_BUILD, isAppSender: fromApp, getMainWindow: () => mainWindow })")
    expect(setup).toBeGreaterThan(ready)
    expect(setup).toBeLessThan(mainSource.indexOf('createWindow()', ready))
    expect(mainSource).toContain("additionalArguments: [`--bdp-version=${app.getVersion()}`, devAccess ? devAccess.initialArg() : `--bdp-dev-access=${DEV_OPEN_BUILD ? 'build' : 'locked'}`, `--bdp-product=${app.getName()}`, ...(SANO ? [`--bdp-sano-origin=${SANO.origin}`] : [])]")
    expect(mainSource).toContain('if (devAccess) devAccess.attachWindow(win)')
    // only one place builds the unlock module, and nothing else in main touches its channels
    expect(mainSource.split('setupDevAccess(').length - 1).toBe(1)
    expect(mainSource).not.toContain("'devAccess:")
    // DEVTOOLS is never derived from the lock
    expect(mainSource.slice(devtools, mainSource.indexOf('\n', devtools))).not.toContain('DEV_OPEN_BUILD')
  })

  it('the build-opened rule equals the DevTools rule on every case (SANOVIDS_PROFILE_DIR alone stays locked; asar = packaged)', () => {
    const cases: { isPackaged: boolean; profileSource: ProfileSource; testBuild?: boolean }[] = []
    for (const isPackaged of [true, false]) for (const profileSource of ['env', 'baked', 'default'] as ProfileSource[]) for (const testBuild of [true, false, undefined]) cases.push({ isPackaged, profileSource, testBuild })
    for (const c of cases) {
      const tools = h.allowDevTools(c)
      expect(devOpenBuild({ devToolsAllowed: tools, testDevLock: false }), JSON.stringify(c)).toBe(tools)
      expect(devOpenBuild({ devToolsAllowed: tools, testDevLock: true }), JSON.stringify(c)).toBe(false)
    }
    expect(devOpenBuild({ devToolsAllowed: h.allowDevTools({ isPackaged: true, profileSource: 'env', testBuild: false }) })).toBe(false)
    const asar = h.isPackagedApp({ isPackaged: false, appPath: 'C:\\x\\resources\\app.asar' })
    expect(devOpenBuild({ devToolsAllowed: h.allowDevTools({ isPackaged: asar, profileSource: 'default' }) })).toBe(false)
  })

  it('devaccess.cjs: every channel is ipcMain.handle behind fromApp, state-changing handlers check opAllowed first, only unlock opens the link window', () => {
    expect(devAccessSource).not.toMatch(/ipcMain\.on\(/)
    expect(devAccessSource).toContain("if (!isAppSender(event)) return fail('not-allowed')")
    for (const ch of ['getState', 'unlock', 'lock', 'setKeep', 'totpBegin', 'totpConfirm', 'linkCancel', 'totpRemove']) expect(devAccessSource).toContain(`handle('devAccess:${ch}'`)
    const bodyOf = (name: string) => {
      const start = idx(devAccessSource, `function ${name}(`)
      return devAccessSource.slice(start, devAccessSource.indexOf('\n  }\n', start))
    }
    for (const op of ['setKeep', 'totpBegin', 'totpConfirm', 'totpRemove']) {
      const body = bodyOf(op)
      const check = body.indexOf(`rules.opAllowed('${op}'`)
      expect(check, op).toBeGreaterThan(-1)
      for (const write of ['writeRecord()', 'record.keepDays', 'record.totp', 'record.unlock', 'crypto.randomBytes', 'link.started']) {
        const at = body.indexOf(write)
        if (at > -1) expect(at, `${op}: ${write}`).toBeGreaterThan(check)
      }
    }
    expect(devAccessSource.split('openLink(').length - 1).toBe(2) // its definition + the one call, in unlock
    expect(bodyOf('unlock')).toContain('openLink(t)')
  })

  it('devaccess.cjs: no network, nothing about the debugging tools, the TOTP secret wrapped with safeStorage on Windows only and never logged', () => {
    for (const src of [devAccessSource, devAccessRulesSource]) {
      expect(src).not.toMatch(/\bfetch\(|\bnet\.|require\('node:https?'\)|require\('https?'\)|\bsession\./)
    }
    expect(devAccessSource).not.toMatch(/DEVTOOLS|devTools|webContents\.(open|toggle)/)
    expect(devAccessRulesSource).not.toMatch(/require\(/)
    expect(devAccessSource).toMatch(/if \(platform === 'win32'\) \{\s+try \{\s+if \(safeStorage\.isEncryptionAvailable\(\)\)/)
    expect(devAccessSource.split('safeStorage.encryptString(').length - 1).toBe(1)
    // log lines never take a code, a secret or a full device code
    for (const m of devAccessSource.matchAll(/log\(`([^`]*)`\)/g)) expect(m[1], m[1]).not.toMatch(/\$\{(code|secret|digits|b32|input|deviceCode|link\.pending)[^}]*\}/)
    expect(devAccessSource).not.toMatch(/console\./)
  })

  it('the unlock never touches the hardening: no switch / CSP / permission / fuse code in the lock modules', () => {
    for (const src of [devAccessSource, devAccessRulesSource]) {
      expect(src).not.toMatch(/refusedSwitches|contentSecurityPolicy|setPermission|electronFuses|commandLine|allowDevTools/)
    }
  })
})
