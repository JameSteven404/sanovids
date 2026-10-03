// electron/hardening-rules.cjs: the pure hardening rules of the desktop shell (packaged detection, refused command-line
// switches, stripped env, DevTools gate, download allowlist, default-session permissions, CSP of app://bdp, the
// 'app:signature' payload and the self-check of the DLLs next to the exe) — plus source guarantees in main.cjs /
// preload.cjs that wire them in (docs/SIGNING.md "Bảo mật").
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import hardeningSource from '../../../electron/hardening-rules.cjs?raw'
import mainSource from '../../../electron/main.cjs?raw'
import preloadSource from '../../../electron/preload.cjs?raw'
import pkgRaw from '../../../package.json?raw'

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
  contentSecurityPolicy(html: unknown): string
  appSignaturePayload(verdict: unknown, opts: { packaged: boolean }): Payload
  SIGNED_DLLS: readonly string[]
  MICROSOFT_DLLS: readonly string[]
  MICROSOFT_SIGNER: string
  SELF_CHECK_FILES: readonly { name: string; kind: 'author' | 'microsoft' }[]
  selfCheckFileState(kind: unknown, result: unknown, pins: unknown): 'ok' | 'bad' | 'unknown'
  combineSelfCheck(exeVerdict: unknown, fileStates: unknown): Record<string, unknown>
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
    const policy = h.contentSecurityPolicy(indexBytes)
    expect(policy).not.toMatch(/unsafe-eval|\*/)
    expect(policy.split('; ').find((d) => d.startsWith('script-src '))).not.toMatch(/unsafe/)
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
    expect(mainSource).toContain('hardening.contentSecurityPolicy(bytes)')
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

  it('hardening-rules.cjs requires nothing', () => {
    expect(hardeningSource).not.toMatch(/\brequire\s*\(/)
  })

  it('preload: app block (signature only) before canvasapp, updates still the last block', () => {
    const appAt = preloadSource.indexOf('  app: {')
    expect(appAt).toBeGreaterThan(preloadSource.indexOf('  platform: process.platform,'))
    expect(appAt).toBeLessThan(preloadSource.indexOf('  canvasapp: {'))
    const block = /\n {2}app: \{([\s\S]*?)\n {2}\},\n/.exec(preloadSource)
    expect(block).not.toBeNull()
    expect([...block![1].matchAll(/^ {4}(\w+): /gm)].map((m) => m[1])).toEqual(['signature'])
    expect(block![1]).toContain("signature: () => ipcRenderer.invoke('app:signature')")
    expect(/updates: \{([\s\S]*?)\n {2}\},\n\}\)/.exec(preloadSource)).not.toBeNull()
    const topKeys = [...preloadSource.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1])
    expect(topKeys.at(-1)).toBe('updates')
    expect(topKeys.indexOf('app')).toBe(topKeys.indexOf('platform') + 1)
  })
})
