// Execute the registered handlers, with fake sessions/WebContents only. Never import Electron or start a window.
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'

type Contents = { getURL(): string; isDestroyed?(): boolean }
type Details = { requestingUrl?: string; embeddingOrigin?: string; isMainFrame?: boolean }
type Request = (wc: Contents | null, permission: string, callback: (allow: boolean) => void, details?: Details) => void
type Check = (wc: Contents | null, permission: string, origin?: string, details?: Details) => boolean
const hardening = createRequire(import.meta.url)('../../../electron/hardening-rules.cjs')
const permissions = ['clipboard-sanitized-write', 'fileSystem', 'fullscreen', 'persistent-storage']

function handlers(sanoOrigin: string | null = 'https://sano.example.test') {
  let request: Request = () => { throw new Error('request handler was not registered') }
  let check: Check = () => { throw new Error('check handler was not registered') }
  let device = () => true
  const start = mainSource.indexOf('function restrictDefaultSessionPermissions() {')
  const end = mainSource.indexOf('\nfunction createWindow()', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  vm.runInNewContext(mainSource.slice(start, end) + '\nrestrictDefaultSessionPermissions()', {
    hardening,
    SANO: sanoOrigin ? { origin: sanoOrigin } : null,
    session: { defaultSession: {
      setPermissionRequestHandler: (f: Request) => { request = f },
      setPermissionCheckHandler: (f: Check) => { check = f },
      setDevicePermissionHandler: (f: () => boolean) => { device = f },
    } },
  }, { timeout: 1000 })
  return { request, check, device }
}

function decisions(wc: Contents | null, details: Details | undefined, origin = 'app://bdp', sanoOrigin: string | null = 'https://sano.example.test') {
  const h = handlers(sanoOrigin)
  if (wc && !wc.isDestroyed) wc = { ...wc, isDestroyed: () => false }
  return permissions.map((p) => {
    const callbacks: boolean[] = []
    h.request(wc, p, (allowed) => callbacks.push(allowed), details)
    expect(callbacks).toHaveLength(1)
    return [callbacks[0], h.check(wc, p, origin, details)]
  })
}

describe('default session permissions: document and container boundaries', () => {
  it.each([
    ['standalone app', 'app://bdp/index.html', true, undefined, null],
    ['app frame in configured SANO', 'https://sano.example.test/project', false, 'https://sano.example.test', 'https://sano.example.test'],
    ['app frame in configured loopback SANO', 'http://127.0.0.1:8080/', false, 'http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    // Chromium reports false even for a top-level fileSystem check: do not use it as a blanket deny.
    ['app document with fileSystem frame flag', 'app://bdp/', false, undefined, null],
  ] as const)('allows the app permissions: %s', (_name, top, isMainFrame, embeddingOrigin, sanoOrigin) => {
    expect(decisions({ getURL: () => top }, { requestingUrl: 'app://bdp/index.html', isMainFrame, embeddingOrigin }, 'app://bdp', sanoOrigin)).toEqual(permissions.map(() => [true, true]))
  })

  it.each([
    ['configured SANO top page', 'https://sano.example.test/', 'https://sano.example.test/', 'https://sano.example.test'],
    ['Google sign-in popup', 'https://accounts.google.com/signin', 'https://accounts.google.com/signin', 'https://accounts.google.com'],
    ['untrusted frame in app', 'app://bdp/', 'https://untrusted.test/frame', 'https://untrusted.test'],
    ['untrusted frame in SANO', 'https://sano.example.test/', 'https://untrusted.test/frame', 'https://untrusted.test'],
    ['app frame in untrusted container', 'https://untrusted.test/', 'app://bdp/', 'app://bdp'],
    ['lookalike app host', 'app://bdp/', 'app://bdp.attacker.test/', 'app://bdp.attacker.test'],
    ['app URL credentials', 'app://bdp/', 'app://attacker@bdp/', 'app://bdp'],
    ['opaque requesting document', 'app://bdp/', 'about:blank', 'null'],
    ['wrong configured SANO port', 'https://sano.example.test:444/', 'app://bdp/', 'app://bdp'],
  ])('denies both handlers: %s', (_name, top, requestingUrl, origin) => {
    expect(decisions({ getURL: () => top }, { requestingUrl, isMainFrame: false }, origin)).toEqual(permissions.map(() => [false, false]))
  })

  it('denies an untrusted intermediate embedding origin even with a trusted top page', () => {
    expect(decisions({ getURL: () => 'https://sano.example.test/' }, { requestingUrl: 'app://bdp/', embeddingOrigin: 'https://untrusted.test', isMainFrame: false })).toEqual(permissions.map(() => [false, false]))
  })

  it('denies check origin mismatches instead of trusting the top-level app URL', () => {
    const h = handlers()
    const wc = { getURL: () => 'app://bdp/', isDestroyed: () => false }
    for (const origin of [undefined, '', 'null', 'https://untrusted.test', 'app://bdp.attacker.test']) {
      for (const p of permissions) expect(h.check(wc, p, origin, { requestingUrl: 'app://bdp/', isMainFrame: true })).toBe(false)
    }
  })

  it('fails closed for missing, destroyed or inaccessible document metadata', () => {
    for (const wc of [null, { getURL: () => 'app://bdp/', isDestroyed: () => true }, { getURL: () => { throw new Error('destroyed') } }]) {
      expect(decisions(wc, { requestingUrl: 'app://bdp/', isMainFrame: true })).toEqual(permissions.map(() => [false, false]))
    }
    for (const details of [undefined, {}, { isMainFrame: false }]) {
      expect(decisions({ getURL: () => 'app://bdp/' }, details)).toEqual(permissions.map(() => [false, false]))
    }
  })

  it('retains permission-name and device denial for the trusted app', () => {
    const h = handlers()
    const wc = { getURL: () => 'app://bdp/', isDestroyed: () => false }
    for (const permission of ['media', 'notifications', 'clipboard-read', 'unknown']) {
      const callbacks: boolean[] = []
      h.request(wc, permission, (v) => callbacks.push(v), { requestingUrl: 'app://bdp/', isMainFrame: true })
      expect(callbacks).toEqual([false])
      expect(h.check(wc, permission, 'app://bdp', { requestingUrl: 'app://bdp/', isMainFrame: true })).toBe(false)
    }
    expect(h.device()).toBe(false)
  })
})
