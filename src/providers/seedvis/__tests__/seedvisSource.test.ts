// Source guarantees of the seedvis gateway (like hardeningRules.test.ts): what the code of electron/seedvis*.cjs,
// main.cjs and preload.cjs may and may not contain — pure rule modules, limited requires, every IPC handler behind
// isAppSender, credentials 'omit' / cache 'no-store' / no redirects on API calls, the key header only behind the exact
// origin rule, downloads named by job id + index only, no persistent partition, no certificate override, no
// beforeunload, the close guard wired into main without touching an update's quit, the preload order, the asar list.
import { describe, expect, it } from 'vitest'
import mainSource from '../../../../electron/main.cjs?raw'
import preloadSource from '../../../../electron/preload.cjs?raw'
import keyRulesSource from '../../../../electron/seedvis-key-rules.cjs?raw'
import rulesSource from '../../../../electron/seedvis-rules.cjs?raw'
import gatewaySource from '../../../../electron/seedvis.cjs?raw'
import pkg from '../../../../package.json'
import releaseLibSource from '../../../../scripts/releaseLib.mjs?raw'
import { seedvisModule } from './fakeElectron'

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
const count = (s: string, sub: string) => s.split(sub).length - 1
const gateway = stripComments(gatewaySource)
const main = stripComments(mainSource)

/** [start, end) of the block opened by the first '{' at or after `from`. */
function blockAt(src: string, from: number): [number, number] {
  const open = src.indexOf('{', from)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return [open, i + 1]
  }
  throw new Error('unbalanced block')
}
const fnBody = (src: string, name: string) => {
  const at = src.search(new RegExp(`(async )?function ${name}\\(`))
  expect(at, name).toBeGreaterThan(-1)
  const [s, e] = blockAt(src, src.indexOf(')', at))
  return src.slice(s, e)
}

describe('the rule modules are pure', () => {
  it.each([
    ['seedvis-rules.cjs', rulesSource],
    ['seedvis-key-rules.cjs', keyRulesSource],
  ])('%s: no require, no Electron, no fs / Buffer / process, never logs', (_name, src) => {
    const code = stripComments(src)
    expect(code).not.toMatch(/\brequire\s*\(/)
    // ('safeStorage' as a status value is fine; the module itself is never touched)
    expect(code).not.toMatch(/\bBuffer\b|\bprocess\.|\bconsole\.|\bipcMain\b|\bsafeStorage\.|\bnet\.request|\bsession\./)
    expect(code).toMatch(/^'use strict'/m)
  })
})

describe('electron/seedvis.cjs', () => {
  it('requires only Electron, node builtins and the two rule modules', () => {
    const reqs = [...gateway.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort()
    expect(reqs).toEqual(['./seedvis-key-rules.cjs', './seedvis-rules.cjs', 'electron', 'node:crypto', 'node:fs', 'node:path', 'node:stream'].sort())
    // electron only as the default of the injected deps
    expect(gateway).toContain("const E = deps.electron || require('electron')")
  })

  it('every channel is ipcMain.handle behind isAppSender (checked first), registered once; never ipcMain.on', () => {
    expect(gateway).not.toMatch(/ipcMain\.on\(|ipcRenderer|webContents\.send/)
    expect(count(gateway, 'ipcMain.handle(')).toBe(1)
    const wrapper = gateway.slice(gateway.indexOf('const handle = (channel, fn, refused) =>'))
    expect(wrapper).toMatch(/ipcMain\.handle\(channel, async \(event, arg\) => \{\s+if \(!isAppSender\(event\)\) return /)
    const channels = [...gateway.matchAll(/handle\('(seedvis:\w+)'/g)].map((m) => m[1])
    expect(channels.sort()).toEqual([...seedvisModule.CHANNELS].sort())
    expect(new Set(channels).size).toBe(channels.length)
  })

  it("network: credentials 'omit', cache 'no-store', no cookies; API calls never follow a redirect, downloads check each hop", () => {
    expect(gateway).toContain("const netOptions = (method, url, redirect) => ({ method, url, session: ses, credentials: 'omit', cache: 'no-store', redirect, bypassCustomProtocolHandlers: true, useSessionCookies: false })")
    expect(count(gateway, 'net.request(')).toBe(3)
    expect(gateway).toContain("req = net.request(netOptions(o.method, o.url, 'error'))")
    expect(gateway).toContain("req = net.request(netOptions('POST', o.url, 'error'))")
    expect(gateway).toContain("req = net.request(netOptions('GET', url, 'manual'))")
    expect(fnBody(gateway, 'netGet')).toMatch(/hops > rules\.SEEDVIS_REDIRECT_MAX \|\| !rules\.outputUrlAllowed\(redirectUrl\)/)
    expect(gateway).not.toMatch(/credentials: 'include'|\.fetch\(|setCertificateVerifyProc|certificate-error|persist:|setProxy|ignore-certificate/i)
    expect(gateway).toContain('session.fromPartition(rules.SEEDVIS_PARTITION)')
  })

  it('the key header is set only behind the exact-origin rule; no other secret header is ever set', () => {
    const lines = gateway.split('\n').filter((l) => l.includes("'Authorization'"))
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(l).toMatch(/if \(rules\.authHeadersAllowed\(o\.url\)\) req\.setHeader\('Authorization', `Bearer \$\{o\.key\}`\)/)
    expect(gateway).not.toMatch(/X-API-Key|x-goog-api-key|'Cookie'/i)
    expect(fnBody(gateway, 'netGet')).not.toMatch(/Authorization|\.key\b/)
  })

  it('the partition: every permission denied, both webRequest layers installed', () => {
    expect(gateway).toContain('ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))')
    expect(gateway).toContain('ses.setPermissionCheckHandler(() => false)')
    expect(gateway).toContain('ses.setDevicePermissionHandler(() => false)')
    expect(gateway).toContain("callback({ cancel: rules.webRequestVerdict(details, (u) => downloadUrls.has(u)) !== 'allow' })")
    expect(gateway).toContain('for (const name of rules.headersToStrip(details.url, Object.keys(requestHeaders))) delete requestHeaders[name]')
  })

  it('async safeStorage only; Linux plain text counts as unavailable', () => {
    expect(gateway).not.toMatch(/encryptString\(|decryptString\(|setUsePlainTextEncryption/)
    expect(gateway).toContain("isEncryptionAvailable: async () => (await safeStorage.isAsyncEncryptionAvailable()) && !(platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')")
  })

  it('no exception text, key or URL reaches an answer or a log', () => {
    // the only use of an exception's text is recognising a net error name (other .message are our own fixed texts)
    expect([...gateway.matchAll(/\b(?:e|err|error|ex)\.message\b/g)]).toHaveLength(1)
    expect(gateway).toContain("const errorText = (e) => String((e && e.message) || e || '')")
    for (const m of gateway.matchAll(/rules\.failure\(\w+\.code, (\w+)\.message/g)) expect(['k', 'again', 'checked', 'saved', 'r']).toContain(m[1])
    for (const m of gateway.matchAll(/errorText\(e\)/g)) expect(gateway.slice(m.index! - 40, m.index!)).toMatch(/(const text = |offlineNetError\()$/)
    // log lines: the fixed rule line, or a host only
    for (const m of gateway.matchAll(/\blog\((.*)\)\s*$/gm)) expect(m[1]).toMatch(/^rules\.logLine\(|^`\[SanoVids\] seedvis (result host|download) \$\{rules\.hostOf\(/)
    expect(gateway).not.toMatch(/console\.(log|info|error)/)
    // clipboard: read and cleared only by "Dán key"
    expect(count(gateway, 'clipboard.readText()')).toBe(2)
    expect(fnBody(gateway, 'pasteKey')).toContain('if (clipboard.readText() === raw) clipboard.clear()')
  })

  it('downloads are named by job id + output index only; main looks the URL up in what seedvis answered', () => {
    expect(gateway).toContain('return downloads.open(event.sender.id, arg)')
    const dl = rulesSource.slice(rulesSource.indexOf('function createSeedvisDownloads(deps)'))
    expect(dl).toContain('const url = deps.lookup(a.generationId, a.index)')
    expect(dl).not.toMatch(/a\.url|a\.path|args\.url/)
    expect(fnBody(gateway, 'recordOutputs')).toContain('const o = rules.outputsOf(json)')
  })

  it('never a beforeunload; the close guard never vetoes an update’s quit', () => {
    for (const src of [gateway, stripComments(rulesSource), main]) expect(src).not.toMatch(/beforeunload/)
    expect(fnBody(gateway, 'closeGuard')).toContain('quittingForUpdate: opt.quittingForUpdate === true')
    expect(rulesSource).toContain("if (v.quittingForUpdate === true || v.confirmed === true) return 'allow'")
  })
})

describe('main.cjs wiring (a few lines)', () => {
  it('one require, set up on ready after the canvasapp gateway and before the first window, in a try', () => {
    expect(count(main, "require('./seedvis.cjs')")).toBe(1)
    expect(count(main, 'setupSeedvis(')).toBe(1)
    const [rs, re] = blockAt(main, main.indexOf('app.whenReady().then(() => {'))
    const ready = main.slice(rs, re)
    const setup = ready.indexOf('seedvis = setupSeedvis({')
    expect(setup).toBeGreaterThan(ready.indexOf('registerCanvasappGateway()'))
    expect(setup).toBeLessThan(ready.indexOf('createWindow()'))
    expect(ready.slice(setup - 30, setup)).toMatch(/try \{\s+$/)
    expect(ready).toContain(
      'seedvis = setupSeedvis({ isAppSender: fromApp, getMainWindow: () => mainWindow, userDataDir: app.getPath(\'userData\'), placement: () => appPlacement().kind, packaged: PACKAGED, createPump: createDownloadPump })',
    )
    // main never handles a seedvis channel itself, never reads the clipboard
    expect(main).not.toMatch(/'seedvis:|clipboard\.|\bclipboard\b,/)
  })

  it('close guard: Windows / Linux on the main window’s close, macOS in before-quit (first statement); update quits pass', () => {
    expect(fnBody(main, 'createWindow')).toContain("win.on('close', (event) => seedvisCloseGuard(event, 'window-close', win))")
    const quitAt = main.indexOf("app.on('before-quit', (event) => {")
    expect(quitAt).toBeGreaterThan(-1)
    const [qs, qe] = blockAt(main, quitAt)
    expect(main.slice(qs, qe)).toMatch(/^\{\s+if \(seedvisCloseGuard\(event, 'quit', null\)\) return\s+quitting = true/)
    expect(fnBody(main, 'seedvisCloseGuard')).toContain('quittingForUpdate: macQuitForUpdate || !!(updater && updater.isQuittingForUpdate())')
    expect(count(main, 'seedvisCloseGuard(')).toBe(3) // definition + the two hooks
  })
})

describe('preload.cjs: window.bdpDesktop.seedvis', () => {
  const block = /\n {2}seedvis: \{([\s\S]*?)\n {2}\},\n/.exec(preloadSource)

  it('sits after devAccess and before canvasapp; updates stays the last block', () => {
    const topKeys = [...preloadSource.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1])
    expect(topKeys.indexOf('seedvis')).toBe(topKeys.indexOf('devAccess') + 1)
    expect(topKeys.indexOf('seedvis')).toBe(topKeys.indexOf('canvasapp') - 1)
    expect(topKeys.at(-1)).toBe('updates')
  })

  it('exposes exactly the ten calls, each invoking its channel with plain data; nothing is ever sent one-way', () => {
    expect(block).not.toBeNull()
    expect([...block![1].matchAll(/^ {4}(\w+): /gm)].map((m) => m[1])).toEqual(['keyStatus', 'pasteKey', 'setKey', 'clearKey', 'request', 'downloadOpen', 'downloadRead', 'downloadClose', 'isOnline', 'openBilling'])
    const invoked = [...block![1].matchAll(/ipcRenderer\.invoke\('(seedvis:\w+)'/g)].map((m) => m[1])
    expect(invoked.sort()).toEqual([...seedvisModule.CHANNELS].sort())
    expect(preloadSource).not.toMatch(/ipcRenderer\.send(Sync)?\('seedvis:/)
    expect(block![1]).toContain("downloadOpen: (a) =>\n      ipcRenderer.invoke('seedvis:downloadOpen', { generationId: str(a && a.generationId), index: a && Number.isSafeInteger(a.index) ? a.index : -1 }),")
    expect(block![1]).toContain("request: (r) => ipcRenderer.invoke('seedvis:request', seedvisRequest(r)),")
    expect(stripComments(block![1])).not.toMatch(/url|path|header/i)
    const helper = stripComments(preloadSource.slice(preloadSource.indexOf('const seedvisRequest = (r) => {'), preloadSource.indexOf('contextBridge.exposeInMainWorld(')))
    expect(helper).not.toMatch(/url|path|header|\bkey\b/i)
  })
})

describe('packaging', () => {
  it('the three files are required inside app.asar (release check); the cookie-encryption fuse is untouched', () => {
    const list = releaseLibSource.slice(releaseLibSource.indexOf('export const REQUIRED_ASAR_FILES'), releaseLibSource.indexOf('])', releaseLibSource.indexOf('export const REQUIRED_ASAR_FILES')))
    for (const f of ['electron/seedvis.cjs', 'electron/seedvis-rules.cjs', 'electron/seedvis-key-rules.cjs']) expect(list).toContain(`'${f}'`)
    expect((pkg as { build: { electronFuses: Record<string, boolean>; files: string[] } }).build.electronFuses.enableCookieEncryption).toBe(false)
    expect((pkg as { build: { files: string[] } }).build.files).toContain('electron/**/*')
  })
})
