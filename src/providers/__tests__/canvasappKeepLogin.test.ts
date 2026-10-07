// "Giữ đăng nhập canvasapp trên máy này": electron/keeplogin-rules.cjs (pure rules + the injected keep-login state
// machine, run here with a fake cookie store, a fake reversible safeStorage, an in-memory fs, fake timers and a fake
// clock) and its wiring in electron/main.cjs / preload.cjs (source checks). No Electron, no network, no real profile.
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import rulesSource from '../../../electron/keeplogin-rules.cjs?raw'
import mainSource from '../../../electron/main.cjs?raw'

// ---------------------------------------------------------------------------------------------------------------
// Types of the CommonJS module
// ---------------------------------------------------------------------------------------------------------------

interface Ck {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: string
  session: boolean
  expirationDate?: number
}
interface Entry {
  name: string
  value: string
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: string
}
interface Snap {
  v: 1
  savedAt: number
  cookies: Entry[]
}
interface Mark {
  gen: number
  epoch: number
  writes: number
}
interface KeepLogin {
  sweep(): Promise<void>
  restore(): Promise<{ restored: number }>
  onChanged(event: unknown, cookie: unknown, cause?: string, removed?: boolean): void
  mark(): Mark
  confirmed(m: Mark | null): Promise<void>
  rejected(m: Mark | null): Promise<void>
  loggedIn(): Promise<{ kept: boolean }>
  forget<T>(fn: () => Promise<T>): Promise<{ copyRemoved: boolean; result: T }>
  setEnabled(on: boolean): Promise<{ copyRemoved: boolean }>
  state(): { enabled: boolean; available: boolean }
}
interface Rules {
  KEEP_LOGIN_DAYS: number
  KEEP_LOGIN_DAY_MS: number
  KEEP_LOGIN_MAX_FILE_BYTES: number
  KEEP_LOGIN_RESTORE_CAP_MS: number
  KEEP_LOGIN_DRAIN_CAP_MS: number
  KEEP_LOGIN_NOT_CLEARED_TEXT: string
  KEEP_LOGIN_OFF_NOT_CLEARED_TEXT: string
  CANVASAPP_LOGGING_OUT_TEXT: string
  CANVASAPP_ABORTED_BY_LOGOUT_TEXT: string
  isCloudflareCookie(name: string): boolean
  isHostCookie(c: unknown, host: string): boolean
  isKeptCookieChange(c: unknown, host: string): boolean
  defaultKeepLogin(kind: unknown): boolean
  keepLoginPlacement(o: { platform: string; kind: unknown; inApplications: boolean }): string
  keptCookieEntry(c: unknown, host: string): Entry | null
  loginSnapshot(cookies: unknown, host: string, savedAt: number): Snap | null
  loginSnapshotKey(snap: Snap | null): string
  parseLoginSnapshot(text: unknown, host: string, now: number): Snap | null
  entriesToRestore(snap: Snap | null, current: unknown, host: string): Entry[]
  restoreCookieDetails(e: Entry, origin: string, host: string): Record<string, unknown>
  statusVerdict(pathname: string, status: number, json: unknown): 'accepted' | 'denied' | null
  cookieShapeLine(c: unknown, now: number): string
  isGoogleAccountCookie(c: unknown): boolean
  cookieRemovalUrl(c: Ck): string
  removeGoogleAccountCookies(cookies: unknown): Promise<number>
  parseKeepLoginPrefs(text: unknown): { keepLogin: boolean } | null
  keepLoginPrefsText(keepLogin: boolean): string
  resolveKeepLogin(prefs: { keepLogin: boolean } | null, kind: unknown): boolean
  keepLoginPayload(o: { enabled: boolean; available: boolean; chosen: boolean }): Record<string, unknown>
  createCanvasappKeepLogin(deps: Record<string, unknown>): KeepLogin
}

const R = createRequire(import.meta.url)('../../../electron/keeplogin-rules.cjs') as Rules

const HOST = 'canvasapp.io.vn'
const ORIGIN = 'https://canvasapp.io.vn'
const DAY = 86_400_000
const T0 = Date.parse('2026-10-07T10:00:00Z')

/** A first-party session cookie as Electron reports it (host-only by default). */
const ck = (over: Partial<Ck> = {}): Ck => ({
  name: 'sid',
  value: 'SECRET-sid-1',
  domain: HOST,
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  session: true,
  ...over,
})
const csrf = (value = 'SECRET-csrf-1') => ck({ name: 'canvas_csrf', value, httpOnly: false })

// ---------------------------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------------------------

describe('keep-login rules: which cookies are kept', () => {
  it('host matching: exactly canvasapp.io.vn (host-only) or .canvasapp.io.vn — nothing else', () => {
    expect(R.isHostCookie(ck(), HOST)).toBe(true)
    expect(R.isHostCookie(ck({ domain: '.canvasapp.io.vn', hostOnly: false }), HOST)).toBe(true)
    expect(R.isHostCookie(ck({ domain: 'CANVASAPP.IO.VN' }), HOST)).toBe(true)
    for (const domain of ['www.canvasapp.io.vn', 'evilcanvasapp.io.vn', 'canvasapp.io.vn.evil.com', 'accounts.google.com', '.google.com', 'pay.sepay.vn', '.sepay.vn']) {
      expect(R.isHostCookie(ck({ domain, hostOnly: true }), HOST), domain).toBe(false)
      expect(R.isHostCookie(ck({ domain, hostOnly: false }), HOST), domain).toBe(false)
    }
    // a host-only cookie whose domain has a dot / a domain cookie without one: not what Electron reports for the host
    expect(R.isHostCookie(ck({ domain: '.canvasapp.io.vn', hostOnly: true }), HOST)).toBe(false)
    expect(R.isHostCookie(ck({ domain: 'canvasapp.io.vn', hostOnly: false }), HOST)).toBe(false)
    expect(R.isHostCookie({ name: 'x' }, HOST)).toBe(false)
    expect(R.isHostCookie(null, HOST)).toBe(false)
  })

  it('only session cookies (Chromium already keeps the others); never Cloudflare’s', () => {
    expect(R.keptCookieEntry(ck(), HOST)).not.toBeNull()
    expect(R.keptCookieEntry(ck({ session: false, expirationDate: T0 / 1000 + 3600 }), HOST)).toBeNull()
    expect(R.keptCookieEntry(ck({ session: true, expirationDate: T0 / 1000 + 3600 }), HOST)).toBeNull()
    expect(R.keptCookieEntry(ck({ session: false }), HOST)).toBeNull()
    for (const name of ['__cf_bm', '_cfuvid', 'cf_clearance', '__cflb', 'cf_chl_rc_m', '__CF_BM', 'CF_Clearance', '_CFUVID']) {
      expect(R.isCloudflareCookie(name), name).toBe(true)
      expect(R.keptCookieEntry(ck({ name }), HOST), name).toBeNull()
      expect(R.isKeptCookieChange(ck({ name }), HOST), name).toBe(false)
    }
    expect(R.isCloudflareCookie('canvas_csrf')).toBe(false)
  })

  it('canvas_csrf (not HttpOnly) and an HttpOnly auth cookie are both kept, attributes as they are', () => {
    const snap = R.loginSnapshot([ck(), csrf()], HOST, T0)!
    expect(snap.cookies).toEqual([
      { name: 'canvas_csrf', value: 'SECRET-csrf-1', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'lax' },
      { name: 'sid', value: 'SECRET-sid-1', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
    ])
  })

  it('attributes round-trip through restoreCookieDetails: a SESSION cookie (never an expirationDate)', () => {
    for (const sameSite of ['unspecified', 'no_restriction', 'lax', 'strict']) {
      const e = R.keptCookieEntry(ck({ sameSite }), HOST)!
      expect(e.sameSite).toBe(sameSite)
    }
    expect(R.keptCookieEntry(ck({ sameSite: 'weird' }), HOST)!.sameSite).toBe('unspecified')
    const hostOnly = R.restoreCookieDetails(R.keptCookieEntry(ck({ path: '/api', secure: true, httpOnly: true }), HOST)!, ORIGIN, HOST)
    expect(hostOnly).toEqual({ url: 'https://canvasapp.io.vn/api', name: 'sid', value: 'SECRET-sid-1', path: '/api', secure: true, httpOnly: true, sameSite: 'lax' })
    expect('domain' in hostOnly).toBe(false)
    expect('expirationDate' in hostOnly).toBe(false)
    const dom = R.restoreCookieDetails(R.keptCookieEntry(ck({ domain: '.canvasapp.io.vn', hostOnly: false, secure: false, httpOnly: false }), HOST)!, ORIGIN, HOST)
    expect(dom).toMatchObject({ domain: '.canvasapp.io.vn', secure: false, httpOnly: false })
    expect('expirationDate' in dom).toBe(false)
    // an odd path → '/'
    expect(R.keptCookieEntry(ck({ path: 'api' }), HOST)!.path).toBe('/')
  })

  it('prefix rules: __Host- needs host-only + secure + path /, __Secure- needs secure, SameSite=None needs secure', () => {
    expect(R.keptCookieEntry(ck({ name: '__Host-sid' }), HOST)).not.toBeNull()
    expect(R.keptCookieEntry(ck({ name: '__host-sid', path: '/api' }), HOST)).toBeNull()
    expect(R.keptCookieEntry(ck({ name: '__Host-sid', secure: false }), HOST)).toBeNull()
    expect(R.keptCookieEntry(ck({ name: '__Host-sid', domain: '.canvasapp.io.vn', hostOnly: false }), HOST)).toBeNull()
    expect(R.keptCookieEntry(ck({ name: '__Secure-sid', secure: false }), HOST)).toBeNull()
    expect(R.keptCookieEntry(ck({ name: '__SECURE-sid', secure: true }), HOST)).not.toBeNull()
    expect(R.keptCookieEntry(ck({ sameSite: 'no_restriction', secure: false }), HOST)).toBeNull()
    expect(R.keptCookieEntry(ck({ sameSite: 'no_restriction', secure: true }), HOST)).not.toBeNull()
  })

  it('limits and order: > 30 cookies → nothing; a long value / a bad name is dropped; duplicates once; stable key', () => {
    const many = Array.from({ length: 31 }, (_, i) => ck({ name: `c${i}` }))
    expect(R.loginSnapshot(many, HOST, T0)).toBeNull()
    expect(R.loginSnapshot(many.slice(0, 30), HOST, T0)!.cookies).toHaveLength(30)
    expect(R.loginSnapshot([ck({ value: 'x'.repeat(4097) })], HOST, T0)).toBeNull()
    expect(R.loginSnapshot([ck({ value: 'x'.repeat(4096) })], HOST, T0)).not.toBeNull()
    for (const name of ['', 'a b', 'a;b', 'a=b', 'ữ', 'x'.repeat(257)]) expect(R.keptCookieEntry(ck({ name }), HOST), name).toBeNull()
    expect(R.loginSnapshot([ck(), ck({ value: 'other' })], HOST, T0)!.cookies).toHaveLength(1)
    const a = R.loginSnapshot([ck(), csrf(), ck({ name: 'b', path: '/x' })], HOST, T0)
    const b = R.loginSnapshot([ck({ name: 'b', path: '/x' }), csrf(), ck()], HOST, T0 + 999)
    expect(R.loginSnapshotKey(a)).toBe(R.loginSnapshotKey(b))
    expect(R.loginSnapshotKey(null)).toBe('')
    expect(R.loginSnapshot([], HOST, T0)).toBeNull()
    expect(R.loginSnapshot('nope', HOST, T0)).toBeNull()
  })

  it('parseLoginSnapshot: garbage / another version / no savedAt / older than 30 days / from the future → null; bad entries dropped', () => {
    const good = JSON.stringify({ v: 1, savedAt: T0, cookies: [R.keptCookieEntry(ck(), HOST)] })
    expect(R.parseLoginSnapshot(good, HOST, T0)!.cookies).toHaveLength(1)
    for (const bad of ['', 'not json', 'null', '[]', '{}', JSON.stringify({ v: 2, savedAt: T0, cookies: [] }), JSON.stringify({ v: 1, cookies: [] }), JSON.stringify({ v: 1, savedAt: T0, cookies: {} })]) {
      expect(R.parseLoginSnapshot(bad, HOST, T0), bad).toBeNull()
    }
    expect(R.parseLoginSnapshot(undefined, HOST, T0)).toBeNull()
    expect(R.parseLoginSnapshot(good, HOST, T0 + 30 * DAY)).not.toBeNull()
    expect(R.parseLoginSnapshot(good, HOST, T0 + 30 * DAY + 1)).toBeNull()
    expect(R.parseLoginSnapshot(good, HOST, T0 - DAY)).not.toBeNull()
    expect(R.parseLoginSnapshot(good, HOST, T0 - DAY - 1)).toBeNull()
    // a forged entry (Cloudflare name, another domain claimed, __Host- broken, persistent) never comes back
    const forged = JSON.stringify({
      v: 1,
      savedAt: T0,
      cookies: [
        R.keptCookieEntry(ck(), HOST),
        { name: '__cf_bm', value: 'x', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
        { name: '__Host-x', value: 'x', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
        { name: 'evil', value: 'x', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax', domain: 'accounts.google.com', expirationDate: 9e9 },
        null,
        'str',
        [1],
        { name: 'big', value: 'x'.repeat(5000), hostOnly: true, path: '/' },
      ],
    })
    const p = R.parseLoginSnapshot(forged, HOST, T0)!
    expect(p.cookies.map((e) => e.name)).toEqual(['evil', 'sid'])
    // 'evil' is put back on canvasapp.io.vn only (the claimed domain is ignored) and as a session cookie
    const d = R.restoreCookieDetails(p.cookies[0], ORIGIN, HOST)
    expect(d.url).toBe('https://canvasapp.io.vn/')
    expect('domain' in d || 'expirationDate' in d).toBe(false)
  })

  it('entriesToRestore skips a cookie canvasapp already set this run (same name + path + host-only)', () => {
    const snap = R.loginSnapshot([ck(), csrf(), ck({ name: 'p', path: '/x' })], HOST, T0)!
    expect(R.entriesToRestore(snap, [ck({ value: 'NEW' })], HOST).map((e) => e.name)).toEqual(['canvas_csrf', 'p'])
    expect(R.entriesToRestore(snap, [ck({ domain: '.canvasapp.io.vn', hostOnly: false })], HOST)).toHaveLength(3)
    expect(R.entriesToRestore(snap, [ck({ domain: 'www.canvasapp.io.vn' })], HOST)).toHaveLength(3)
    expect(R.entriesToRestore(null, [], HOST)).toEqual([])
  })

  it('isKeptCookieChange: first-party session non-Cloudflare cookies only (removals included); defaultKeepLogin: installer / source', () => {
    expect(R.isKeptCookieChange(ck(), HOST)).toBe(true)
    expect(R.isKeptCookieChange(csrf(), HOST)).toBe(true)
    expect(R.isKeptCookieChange(ck({ session: false }), HOST)).toBe(false)
    expect(R.isKeptCookieChange(ck({ domain: '.google.com', hostOnly: false }), HOST)).toBe(false)
    for (const k of ['installer', 'dev', 'mac-applications']) expect(R.defaultKeepLogin(k)).toBe(true)
    for (const k of ['portable', 'temp-copy', 'mac-translocated', 'mac-volume', 'mac-other', 'unknown', undefined, null, '', 'INSTALLER']) expect(R.defaultKeepLogin(k)).toBe(false)
  })

  it('macOS default: a packaged app in Applications counts as installed (on); translocated / on a volume / elsewhere stays off', () => {
    const def = (platform: string, kind: unknown, inApplications: boolean) => R.resolveKeepLogin(null, R.keepLoginPlacement({ platform, kind, inApplications }))
    // updater-rules.placement has no Mac kinds yet: a packaged darwin build is 'portable' ('temp-copy' when translocated)
    expect(R.keepLoginPlacement({ platform: 'darwin', kind: 'portable', inApplications: true })).toBe('mac-applications')
    expect(def('darwin', 'portable', true)).toBe(true)
    for (const kind of ['portable', 'temp-copy', 'mac-translocated', 'mac-volume', 'mac-other', 'unknown']) expect(def('darwin', kind, false), kind).toBe(false)
    expect(R.keepLoginPlacement({ platform: 'darwin', kind: 'mac-applications', inApplications: false })).toBe('mac-applications')
    expect(R.keepLoginPlacement({ platform: 'darwin', kind: 'dev', inApplications: true })).toBe('dev')
    // other platforms: the kind as is (never 'mac-applications', whatever the flag says)
    expect(R.keepLoginPlacement({ platform: 'win32', kind: 'installer', inApplications: false })).toBe('installer')
    expect(R.keepLoginPlacement({ platform: 'win32', kind: 'portable', inApplications: true })).toBe('portable')
    expect(R.keepLoginPlacement({ platform: 'linux', kind: 'portable', inApplications: true })).toBe('portable')
    expect(R.keepLoginPlacement({ platform: 'win32', kind: undefined, inApplications: false })).toBe('unknown')
    expect(def('win32', 'installer', false)).toBe(true)
    expect(def('win32', 'portable', false)).toBe(false)
  })

  it('statusVerdict: canvasapp decides — only an explicit answer accepts or refuses', () => {
    expect(R.statusVerdict('/api/me', 200, { credits_balance: 1 })).toBe('accepted')
    expect(R.statusVerdict('/api/me', 401, null)).toBe('denied')
    expect(R.statusVerdict('/api/auth/state', 200, { authenticated: true })).toBe('accepted')
    expect(R.statusVerdict('/api/auth/state', 200, { authenticated: false })).toBe('denied')
    expect(R.statusVerdict('/api/auth/state', 401, undefined)).toBe('denied')
    // a body that is not canvasapp's JSON (a Cloudflare page, an error) never drops the copy
    for (const [p, s, j] of [
      ['/api/auth/state', 200, undefined],
      ['/api/auth/state', 200, { authenticated: 'no' }],
      ['/api/me', 200, undefined],
      ['/api/me', 200, []],
      ['/api/me', 403, null],
      ['/api/me', 503, null],
      ['/api/projects', 401, null],
    ] as const) {
      expect(R.statusVerdict(p, s, j), `${p} ${s}`).toBeNull()
    }
  })

  it('the DevTools shape line never contains a cookie value', () => {
    const line = R.cookieShapeLine(ck({ value: 'SECRET-VALUE' }), T0)
    expect(line).not.toContain('SECRET')
    expect(line).toContain('sid')
    expect(line).toContain('session=y')
    expect(line).toContain('expires=session')
    expect(R.cookieShapeLine(ck({ session: false, expirationDate: T0 / 1000 + 7200 }), T0)).toContain('expires=2 h')
    expect(R.cookieShapeLine(null, T0)).not.toContain('SECRET')
  })

  it('the switch: strict prefs file, the placement default when never chosen, a boolean payload', () => {
    expect(R.parseKeepLoginPrefs(R.keepLoginPrefsText(true))).toEqual({ keepLogin: true })
    expect(R.parseKeepLoginPrefs(R.keepLoginPrefsText(false))).toEqual({ keepLogin: false })
    for (const bad of ['', 'x', 'null', '[]', '{"v":1}', '{"v":2,"keepLogin":true}', '{"v":1,"keepLogin":"true"}', undefined]) expect(R.parseKeepLoginPrefs(bad), String(bad)).toBeNull()
    expect(R.resolveKeepLogin(null, 'installer')).toBe(true)
    expect(R.resolveKeepLogin(null, 'portable')).toBe(false)
    expect(R.resolveKeepLogin(null, 'temp-copy')).toBe(false)
    expect(R.resolveKeepLogin({ keepLogin: true }, 'portable')).toBe(true)
    expect(R.resolveKeepLogin({ keepLogin: false }, 'installer')).toBe(false)
    expect(R.keepLoginPayload({ enabled: true, available: true, chosen: false })).toEqual({ ok: true, keepLogin: true, available: true, chosen: false })
    expect(Object.values(R.keepLoginPayload({ enabled: false, available: false, chosen: true })).every((v) => typeof v === 'boolean')).toBe(true)
  })

  it('the module requires nothing and never logs / touches process or fs (main, tests and the lab share it)', () => {
    const code = rulesSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/\bconsole\.|\bprocess\.|\bfs\.|safeStorage|setUsePlainTextEncryption|encryptString\(|decryptString\(/)
    // a restored cookie never gets an expiry (never written to the cookie file): only `expirationDate: undefined` (a forged one dropped)
    expect(code).not.toMatch(/expirationDate\s*:(?!\s*undefined\b)/)
    expect(code).toContain('expirationDate: undefined')
  })
})

describe('Google account cookies (separate cleanup after a confirmed canvasapp login)', () => {
  const g = (domain: string, over: Partial<Ck> = {}) => ck({ name: 'SID', value: 'GOOGLE-SECRET', domain, hostOnly: !domain.startsWith('.'), session: false, expirationDate: 9e9, ...over })

  it('scope: Google’s and YouTube’s own domains only — never canvasapp, SePay or look-alikes', () => {
    for (const d of ['google.com', '.google.com', 'accounts.google.com', '.accounts.google.com', 'www.google.com.vn', '.google.com.vn', 'google.vn', '.google.co.uk', 'myaccount.google.com', '.youtube.com', 'accounts.youtube.com', 'ACCOUNTS.GOOGLE.COM']) {
      expect(R.isGoogleAccountCookie(g(d)), d).toBe(true)
    }
    for (const d of [
      'canvasapp.io.vn',
      '.canvasapp.io.vn',
      'sepay.vn',
      'pay.sepay.vn',
      '.sepay.vn',
      'notgoogle.com',
      'evilgoogle.com',
      'google.com.evil.com',
      'google.evil.com',
      'accounts.google.com.attacker.vn',
      'my-youtube.com',
      'youtube.com.evil.com',
      'googleusercontent.com',
      'google',
      '',
      'google.com/',
      'google..com',
    ]) {
      expect(R.isGoogleAccountCookie(g(d)), d).toBe(false)
    }
    expect(R.isGoogleAccountCookie(null)).toBe(false)
    expect(R.isGoogleAccountCookie({ name: 'x' })).toBe(false)
    expect(R.cookieRemovalUrl(g('.google.com'))).toBe('https://google.com/')
    expect(R.cookieRemovalUrl(g('accounts.google.com', { path: '/signin' }))).toBe('https://accounts.google.com/signin')
    expect(R.cookieRemovalUrl(g('accounts.google.com', { path: 'odd' }))).toBe('https://accounts.google.com/')
  })

  it('removes exactly the Google ones (canvasapp’s login and SePay stay), flushes, and one failure never stops the rest', async () => {
    const list: Ck[] = [ck(), csrf(), ck({ name: 'cf_clearance', session: false, expirationDate: 9e9 }), g('.google.com'), g('accounts.google.com', { name: '__Host-GAPS' }), g('.youtube.com', { name: 'LOGIN_INFO' }), g('pay.sepay.vn', { name: 'sepay' })]
    const removed: string[] = []
    let flushes = 0
    const fake = {
      get: async () => list.map((c) => ({ ...c })),
      remove: async (url: string, name: string) => {
        if (name === '__Host-GAPS') throw new Error('locked')
        removed.push(`${url} ${name}`)
      },
      flushStore: async () => void flushes++,
    }
    expect(await R.removeGoogleAccountCookies(fake)).toBe(2)
    expect(removed).toEqual(['https://google.com/ SID', 'https://youtube.com/ LOGIN_INFO'])
    expect(flushes).toBe(1)
    // nothing to remove → no flush; a store that cannot be read → 0, never throws
    const rm = R.removeGoogleAccountCookies
    let noFlush = 0
    expect(await rm({ get: async () => [ck()], remove: async () => undefined, flushStore: async () => void noFlush++ })).toBe(0)
    expect(noFlush).toBe(0)
    expect(await rm({ get: async () => Promise.reject(new Error('gone')), remove: async () => undefined, flushStore: async () => undefined })).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The state machine, with fakes
// ---------------------------------------------------------------------------------------------------------------

const FILE = '/ud/canvasapp-login.bin'
const MARKER = FILE + '.forget'
const CAP = 999_999
const enc = new TextEncoder()
const dec = new TextDecoder()

function fakeCookies() {
  const list: Ck[] = []
  const calls = { get: 0, set: [] as Record<string, unknown>[], flush: 0 }
  const idOf = (c: Pick<Ck, 'name' | 'path' | 'domain'>) => `${c.name}|${c.path}|${c.domain}`
  return {
    list,
    calls,
    /** Electron: `domain` matches the domain and its subdomains. */
    async get(filter: { domain?: string } = {}) {
      calls.get++
      const d = filter.domain
      return list.filter((c) => !d || c.domain.replace(/^\./, '') === d || c.domain.replace(/^\./, '').endsWith('.' + d)).map((c) => ({ ...c }))
    },
    async set(details: Record<string, unknown>) {
      calls.set.push(details)
      const u = new URL(String(details.url))
      const c: Ck = {
        name: String(details.name),
        value: String(details.value),
        domain: typeof details.domain === 'string' ? details.domain : u.hostname,
        hostOnly: typeof details.domain !== 'string',
        path: typeof details.path === 'string' ? details.path : '/',
        secure: details.secure === true,
        httpOnly: details.httpOnly === true,
        sameSite: typeof details.sameSite === 'string' ? details.sameSite : 'unspecified',
        session: details.expirationDate === undefined,
        ...(details.expirationDate !== undefined ? { expirationDate: Number(details.expirationDate) } : {}),
      }
      const i = list.findIndex((x) => idOf(x) === idOf(c))
      if (i >= 0) list.splice(i, 1)
      list.push(c)
    },
    async flushStore() {
      calls.flush++
    },
  }
}

function fakeCrypto() {
  const st = {
    available: true,
    encryptThrows: false,
    decryptThrows: false,
    reEncrypt: false,
    decryptGate: null as Promise<void> | null,
    encryptGate: null as Promise<void> | null,
    calls: { avail: 0, enc: 0, dec: 0 },
  }
  /** "v10" + bytes xor 0x5a: reversible, never the plain text. */
  const seal = (t: string) => Uint8Array.from([0x76, 0x31, 0x30, ...enc.encode(t).map((x) => x ^ 0x5a)])
  const open = (b: Uint8Array) => dec.decode(b.slice(3).map((x) => x ^ 0x5a))
  return {
    st,
    seal,
    open,
    isEncryptionAvailable: () => {
      st.calls.avail++
      return st.available
    },
    encryptStringAsync: async (t: string) => {
      st.calls.enc++
      if (st.encryptGate) await st.encryptGate
      if (st.encryptThrows) throw new Error('encrypt failed')
      return seal(t)
    },
    decryptStringAsync: async (b: Uint8Array) => {
      st.calls.dec++
      if (st.decryptGate) await st.decryptGate
      if (st.decryptThrows) throw new Error('decrypt failed')
      return { result: open(b), shouldReEncrypt: st.reEncrypt }
    },
  }
}

function fakeFs(now: () => number = () => T0) {
  const files = new Map<string, Uint8Array>()
  const mtimes = new Map<string, number>()
  const st = { rmFails: new Set<string>(), writeFails: new Set<string>(), ops: [] as string[] }
  const err = (code: string) => Object.assign(new Error(code), { code })
  return {
    files,
    mtimes,
    st,
    async stat(p: string) {
      st.ops.push(`stat ${p}`)
      const b = files.get(p)
      if (!b) throw err('ENOENT')
      return { size: b.length, mtimeMs: mtimes.get(p) ?? now() }
    },
    async readFile(p: string) {
      st.ops.push(`read ${p}`)
      const b = files.get(p)
      if (!b) throw err('ENOENT')
      return new Uint8Array(b)
    },
    async writeFile(p: string, data: Uint8Array | string) {
      st.ops.push(`write ${p}`)
      if (st.writeFails.has(p)) throw err('EPERM')
      files.set(p, typeof data === 'string' ? enc.encode(data) : new Uint8Array(data))
      mtimes.set(p, now())
    },
    async rm(p: string) {
      st.ops.push(`rm ${p}`)
      if (st.rmFails.has(p)) throw err('EPERM')
      files.delete(p)
      mtimes.delete(p)
    },
    async rename(from: string, to: string) {
      st.ops.push(`rename ${from} ${to}`)
      const b = files.get(from)
      if (!b) throw err('ENOENT')
      files.set(to, b)
      mtimes.set(to, mtimes.get(from) ?? now())
      files.delete(from)
      mtimes.delete(from)
    },
  }
}

function fakeTimers() {
  const pending = new Map<number, () => void>()
  let id = 0
  return {
    setTimer: (fn: () => void) => {
      pending.set(++id, fn)
      return id
    },
    clearTimer: (t: number) => void pending.delete(t),
    fire() {
      const fns = [...pending.values()]
      pending.clear()
      for (const f of fns) f()
    },
    count: () => pending.size,
  }
}

/** Let every pending promise of the fakes run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const gate = () => {
  let open: () => void = () => undefined
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

type World = ReturnType<typeof world>

/** One SanoVids run: a fresh cookie store (session cookies are gone after a restart), the same disk / crypto key. */
function world(opts: { fsp?: ReturnType<typeof fakeFs>; crypto?: ReturnType<typeof fakeCrypto>; clock?: { t: number }; enabled?: boolean } = {}) {
  const cookies = fakeCookies()
  const crypto = opts.crypto ?? fakeCrypto()
  const clock = opts.clock ?? { t: T0 }
  const fsp = opts.fsp ?? fakeFs(() => clock.t)
  const timers = fakeTimers()
  const caps: (() => void)[] = []
  const sleeps: number[] = []
  const keep = R.createCanvasappKeepLogin({
    cookies,
    crypto,
    fsp,
    file: FILE,
    host: HOST,
    origin: ORIGIN,
    now: () => clock.t,
    sleep: (ms: number) => {
      sleeps.push(ms)
      if (ms < CAP) return Promise.resolve()
      return new Promise<void>((resolve) => caps.push(resolve))
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    capMs: CAP,
    ...(opts.enabled === false ? { enabled: false } : {}),
  })
  /** canvasapp sets / changes a cookie: the store changes and Electron's 'changed' event fires. */
  const put = (c: Ck) => {
    const i = cookies.list.findIndex((x) => x.name === c.name && x.path === c.path && x.domain === c.domain)
    if (i >= 0) cookies.list.splice(i, 1)
    cookies.list.push(c)
    keep.onChanged({}, c, 'explicit', false)
  }
  const drop = (name: string) => {
    const i = cookies.list.findIndex((x) => x.name === name)
    if (i < 0) return
    const [c] = cookies.list.splice(i, 1)
    keep.onChanged({}, c, 'explicit', true)
  }
  /** The kept copy, decrypted (null = no file / empty). */
  const copy = (): Snap | null => {
    const b = fsp.files.get(FILE)
    return b && b.length ? (JSON.parse(crypto.open(b)) as Snap) : null
  }
  const restart = (over: { enabled?: boolean } = {}) => world({ fsp, crypto, clock, ...over })
  const releaseCaps = () => caps.splice(0).forEach((r) => r())
  return { keep, cookies, crypto, fsp, timers, clock, put, drop, copy, restart, releaseCaps, sleeps }
}

/** A confirmed login in `w`: canvasapp set its session cookies, the login window finished. */
async function loggedIn(w: World, sid = 'SECRET-sid-1') {
  w.put(ck({ value: sid }))
  w.put(csrf())
  await w.keep.restore()
  return w.keep.loggedIn()
}

const writesOf = (w: World) => w.fsp.st.ops.filter((o) => o === `rename ${FILE}.tmp ${FILE}`).length

describe('keep-login: restore at the first canvasapp use', () => {
  it('no copy → nothing, and safeStorage is never touched (no DPAPI / Keychain for users who never log in)', async () => {
    const w = world()
    expect(await w.keep.restore()).toEqual({ restored: 0 })
    expect(w.crypto.st.calls).toEqual({ avail: 0, enc: 0, dec: 0 })
    expect(w.keep.state()).toEqual({ enabled: true, available: true })
    expect(w.crypto.st.calls.avail).toBe(0) // state() never probes
  })

  it('a kept login comes back after a restart — session cookies, attributes as they were — and is armed', async () => {
    const w1 = world()
    expect(await loggedIn(w1)).toEqual({ kept: true })
    expect(w1.copy()!.cookies.map((e) => e.name)).toEqual(['canvas_csrf', 'sid'])
    expect(w1.cookies.calls.flush).toBeGreaterThan(0) // flushed right after login

    const w2 = w1.restart()
    expect(await w2.keep.restore()).toEqual({ restored: 2 })
    expect(w2.cookies.calls.set).toHaveLength(2)
    for (const d of w2.cookies.calls.set) expect('expirationDate' in d).toBe(false)
    expect(w2.cookies.list.map((c) => [c.name, c.value, c.session, c.hostOnly, c.secure, c.httpOnly, c.sameSite])).toEqual([
      ['canvas_csrf', 'SECRET-csrf-1', true, true, true, false, 'lax'],
      ['sid', 'SECRET-sid-1', true, true, true, true, 'lax'],
    ])
    // armed: canvasapp renewing its cookie is written without a new confirmation
    w2.put(ck({ value: 'SECRET-sid-2' }))
    w2.timers.fire()
    await tick()
    expect(w2.copy()!.cookies.find((e) => e.name === 'sid')!.value).toBe('SECRET-sid-2')
  })

  it('called twice → read once (memoized); a cookie canvasapp set this run is never overwritten', async () => {
    const w1 = world()
    await loggedIn(w1)
    const w2 = w1.restart()
    w2.cookies.list.push(ck({ value: 'SET-THIS-RUN' }))
    w2.fsp.st.ops.length = 0 // (the first run's reads)
    const [a, b] = await Promise.all([w2.keep.restore(), w2.keep.restore()])
    expect(a).toBe(b)
    expect(w2.fsp.st.ops.filter((o) => o === `read ${FILE}`)).toHaveLength(1)
    expect(a).toEqual({ restored: 1 })
    expect(w2.cookies.list.find((c) => c.name === 'sid')!.value).toBe('SET-THIS-RUN')
  })

  it('an empty copy or one over 256 KB is deleted unread', async () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array(R.KEEP_LOGIN_MAX_FILE_BYTES + 1)]) {
      const w = world()
      w.fsp.files.set(FILE, bytes)
      expect(await w.keep.restore()).toEqual({ restored: 0 })
      expect(w.fsp.files.has(FILE)).toBe(false)
      expect(w.crypto.st.calls.dec).toBe(0)
      expect(w.crypto.st.calls.avail).toBe(0)
    }
  })

  it('decrypt fails / too old / broken JSON / from the future / encryption unavailable / switched off → deleted, 0, never throws', async () => {
    const cases: [string, (w: World) => void][] = [
      ['decrypt throws (another Windows account, Local State reset)', (w) => void (w.crypto.st.decryptThrows = true)],
      ['older than 30 days', (w) => void (w.clock.t += 30 * DAY + 1)],
      ['broken JSON', (w) => void w.fsp.files.set(FILE, w.crypto.seal('{not json'))],
      ['from the future', (w) => void w.fsp.files.set(FILE, w.crypto.seal(JSON.stringify({ v: 1, savedAt: T0 + 2 * DAY, cookies: [R.keptCookieEntry(ck(), HOST)] })))],
      ['encryption unavailable', (w) => void (w.crypto.st.available = false)],
    ]
    for (const [label, arrange] of cases) {
      const w1 = world()
      await loggedIn(w1)
      const w2 = w1.restart()
      arrange(w2)
      expect(await w2.keep.restore(), label).toEqual({ restored: 0 })
      expect(w2.fsp.files.has(FILE), label).toBe(false)
      expect(w2.cookies.calls.set, label).toHaveLength(0)
    }
    // unavailable: nothing was decrypted
    const w1 = world()
    await loggedIn(w1)
    const w2 = w1.restart()
    w2.crypto.st.available = false
    const decBefore = w2.crypto.st.calls.dec
    await w2.keep.restore()
    expect(w2.crypto.st.calls.dec).toBe(decBefore)
    expect(w2.keep.state().available).toBe(false)
    // switched off: deleted, never decrypted
    const w3 = world()
    await loggedIn(w3)
    const w4 = w3.restart({ enabled: false })
    const dec4 = w4.crypto.st.calls.dec
    expect(await w4.keep.restore()).toEqual({ restored: 0 })
    expect(w4.fsp.files.has(FILE)).toBe(false)
    expect(w4.crypto.st.calls.dec).toBe(dec4)
  })

  it('30 days from the login / canvasapp’s last renewal — plain use does not extend it', async () => {
    const w1 = world()
    await loggedIn(w1)
    // plain use: canvasapp confirms the session again and again, the cookies do not change → nothing rewritten
    w1.clock.t += 20 * DAY
    await w1.keep.confirmed(w1.keep.mark())
    w1.put(ck({ value: 'SECRET-sid-1' })) // same value again
    w1.timers.fire()
    await tick()
    expect(w1.copy()!.savedAt).toBe(T0)
    w1.clock.t = T0 + 30 * DAY
    const w2 = w1.restart()
    expect(await w2.keep.restore()).toEqual({ restored: 2 })
    w2.clock.t = T0 + 30 * DAY + 1
    expect(await w2.restart().keep.restore()).toEqual({ restored: 0 }) // (w2 never rewrote it)

    // a renewal by canvasapp starts a new 30 days
    const v1 = world()
    await loggedIn(v1)
    v1.clock.t += 25 * DAY
    v1.put(ck({ value: 'SECRET-sid-renewed' }))
    v1.timers.fire()
    await tick()
    expect(v1.copy()!.savedAt).toBe(T0 + 25 * DAY)
    v1.clock.t = T0 + 50 * DAY
    expect(await v1.restart().keep.restore()).toEqual({ restored: 2 })
  })

  it('shouldReEncrypt → the same copy is written again with the new key — savedAt kept (re-encrypting is not a renewal)', async () => {
    const w1 = world()
    await loggedIn(w1)
    let w = w1
    // a key provider that asks at every start (key rotation, a Keychain identity change) never extends the 30 days
    for (const day of [10, 20, 29]) {
      w.clock.t = T0 + day * DAY
      w = w.restart()
      w.crypto.st.reEncrypt = true
      const encBefore = w.crypto.st.calls.enc
      expect(await w.keep.restore()).toEqual({ restored: 2 })
      await tick()
      expect(w.crypto.st.calls.enc, `day ${day}`).toBe(encBefore + 1)
      expect(w.copy()!.savedAt, `day ${day}`).toBe(T0)
      expect(w.copy()!.cookies).toHaveLength(2)
    }
    w.clock.t = T0 + 30 * DAY + 1
    const late = w.restart()
    expect(await late.keep.restore()).toEqual({ restored: 0 })
    expect(late.fsp.files.has(FILE)).toBe(false)
  })

  it('a re-encryption never overwrites a login written meanwhile', async () => {
    const w1 = world()
    await loggedIn(w1)
    w1.clock.t = T0 + 5 * DAY
    const w2 = w1.restart()
    w2.crypto.st.reEncrypt = true
    const g = gate()
    w2.crypto.st.decryptGate = g.promise
    const restoring = w2.keep.restore()
    await tick()
    // a new login finishes while the restore waits (its save queues before the re-encryption)
    w2.put(ck({ value: 'SECRET-sid-new-login' }))
    const login = w2.keep.loggedIn()
    g.open()
    await restoring
    await login
    await tick()
    expect(w2.copy()!.savedAt).toBe(T0 + 5 * DAY)
    expect(w2.copy()!.cookies.find((e) => e.name === 'sid')!.value).toBe('SECRET-sid-new-login')
  })

  it('a logout started while the restore waits for the decryption: never armed, nothing put back', async () => {
    const w1 = world()
    await loggedIn(w1)
    const w2 = w1.restart()
    const g = gate()
    w2.crypto.st.decryptGate = g.promise
    const restoring = w2.keep.restore()
    await tick()
    const forgetting = w2.keep.forget(async () => 'cleared')
    g.open()
    expect(await restoring).toEqual({ restored: 0 })
    expect(await forgetting).toEqual({ copyRemoved: true, result: 'cleared' })
    expect(w2.cookies.calls.set).toHaveLength(0)
    expect(w2.fsp.files.has(FILE)).toBe(false)
    // not armed: a late cookie is never written
    w2.put(ck({ value: 'LATE' }))
    w2.timers.fire()
    await tick()
    expect(w2.fsp.files.has(FILE)).toBe(false)
  })

  it('a restore that hangs (a Keychain prompt) never blocks Đăng xuất for good: capped, reported, never armed later', async () => {
    const w1 = world()
    await loggedIn(w1)
    const w2 = w1.restart()
    const g = gate()
    w2.crypto.st.decryptGate = g.promise
    void w2.keep.restore()
    await tick()
    let cleared = false
    const forgetting = w2.keep.forget(async () => {
      cleared = true
    })
    await tick()
    w2.releaseCaps() // the cap elapsed
    expect(await forgetting).toMatchObject({ copyRemoved: false })
    expect(cleared).toBe(true) // the partition was still cleared
    g.open()
    await tick()
    await tick()
    expect(w2.cookies.calls.set).toHaveLength(0)
    expect(w2.fsp.files.has(FILE)).toBe(false) // the queued delete ran once the chain was free
  })
})

describe('keep-login: armed only by a login canvasapp confirmed', () => {
  it('before loggedIn / confirmed / a restore, cookie changes write nothing (a half-finished login, OAuth state)', async () => {
    const w = world()
    await w.keep.restore()
    w.put(ck({ name: 'oauth_state', value: 'S' }))
    w.put(ck())
    expect(w.timers.count()).toBe(0)
    await tick()
    expect(w.fsp.files.has(FILE)).toBe(false)
    expect(w.crypto.st.calls.enc).toBe(0)
  })

  it('confirmed(mark) arms and saves; a mark from before a logout does not', async () => {
    const w = world()
    await w.keep.restore()
    w.put(ck())
    const stale = w.keep.mark()
    await w.keep.forget(async () => undefined)
    await w.keep.confirmed(stale)
    expect(w.fsp.files.has(FILE)).toBe(false)
    await w.keep.confirmed(w.keep.mark())
    expect(w.copy()!.cookies.map((e) => e.name)).toEqual(['sid'])
    await w.keep.confirmed(null)
  })
})

describe('keep-login: saving', () => {
  it('a change of a canvasapp session cookie → one encrypted write (tmp + rename) after the debounce, then a flush', async () => {
    const w = world()
    await loggedIn(w)
    const flushes = w.cookies.calls.flush
    const before = writesOf(w)
    w.put(ck({ value: 'SECRET-sid-2' }))
    w.put(ck({ value: 'SECRET-sid-3' })) // debounced: one write
    expect(w.timers.count()).toBe(1)
    w.timers.fire()
    await tick()
    expect(writesOf(w)).toBe(before + 1)
    expect(w.fsp.files.has(FILE + '.tmp')).toBe(false)
    expect(w.cookies.calls.flush).toBeGreaterThan(flushes)
    expect(w.copy()!.cookies.find((e) => e.name === 'sid')!.value).toBe('SECRET-sid-3')
  })

  it('other hosts, persistent and Cloudflare cookies are never kept; an unchanged list writes nothing; no session cookie left → deleted', async () => {
    const w = world()
    await loggedIn(w)
    const before = writesOf(w)
    w.put(ck({ name: 'SID', domain: '.google.com', hostOnly: false, value: 'GOOGLE' }))
    expect(w.timers.count()).toBe(0) // another host: not even a timer
    w.put(ck({ name: '__cf_bm', value: 'CF' }))
    w.put(ck({ name: 'remember', value: 'P', session: false, expirationDate: T0 / 1000 + 99999 }))
    w.timers.fire()
    await tick()
    expect(writesOf(w)).toBe(before) // the snapshot did not change
    expect(JSON.stringify(w.copy())).not.toMatch(/GOOGLE|"CF"|remember/)
    w.drop('sid')
    w.drop('canvas_csrf')
    w.timers.fire()
    await tick()
    expect(w.fsp.files.has(FILE)).toBe(false)
  })

  it('never plaintext: the file holds no cookie value; with encryption unavailable no file ever appears', async () => {
    const w = world()
    await loggedIn(w, 'SECRET-sid-PLAIN')
    const raw = Buffer.from(w.fsp.files.get(FILE)!)
    expect(raw.includes('SECRET-sid-PLAIN')).toBe(false)
    expect(raw.includes('SECRET-csrf-1')).toBe(false)
    expect(w.copy()!.cookies.find((e) => e.name === 'sid')!.value).toBe('SECRET-sid-PLAIN') // (really kept, encrypted)

    const u = world()
    u.crypto.st.available = false
    expect(await loggedIn(u)).toEqual({ kept: false })
    u.put(ck({ value: 'x2' }))
    u.timers.fire()
    await tick()
    expect([...u.fsp.files.keys()]).toEqual([])
    expect(u.keep.state().available).toBe(false)
  })

  it('the availability check may answer asynchronously (Electron’s async encryptor): false → nothing kept, true → kept', async () => {
    const w = world()
    const c = w.crypto as unknown as { isEncryptionAvailable: () => Promise<boolean> }
    c.isEncryptionAvailable = async () => false
    expect(await loggedIn(w)).toEqual({ kept: false })
    expect(w.fsp.files.has(FILE)).toBe(false)
    c.isEncryptionAvailable = async () => true
    w.put(ck({ value: 'v2' }))
    w.timers.fire()
    await tick()
    expect(w.copy()!.cookies.find((e) => e.name === 'sid')!.value).toBe('v2')
    expect(w.keep.state().available).toBe(true)
  })

  it('a failed encryption or write is swallowed (no throw out of the listener) and the next change retries', async () => {
    const w = world()
    w.crypto.st.encryptThrows = true
    await expect(loggedIn(w)).resolves.toEqual({ kept: false })
    expect(w.fsp.files.has(FILE)).toBe(false)
    w.crypto.st.encryptThrows = false
    w.fsp.st.writeFails.add(FILE + '.tmp')
    w.put(ck({ value: 'v2' }))
    w.timers.fire()
    await tick()
    expect(w.fsp.files.has(FILE)).toBe(false)
    w.fsp.st.writeFails.clear()
    w.put(ck({ value: 'v3' }))
    w.timers.fire()
    await tick()
    expect(w.copy()!.cookies.find((e) => e.name === 'sid')!.value).toBe('v3')
    expect(() => w.keep.onChanged(null, null)).not.toThrow()
    expect(() => w.keep.onChanged({}, { domain: 7 })).not.toThrow()
  })

  it('safeStorage failing while saving deletes the previous copy too: nothing stays kept that Cài đặt says is not kept', async () => {
    const w = world()
    await loggedIn(w)
    expect(w.fsp.files.has(FILE)).toBe(true)
    w.crypto.st.encryptThrows = true // e.g. a Keychain "Deny", a DPAPI error
    w.put(ck({ value: 'SECRET-sid-renewed' }))
    w.timers.fire()
    await tick()
    expect(w.fsp.files.has(FILE)).toBe(false)
    expect(w.keep.state().available).toBe(false)
    expect(await w.restart().keep.restore()).toEqual({ restored: 0 })
    // encryption works again: the next change keeps the login again
    w.crypto.st.encryptThrows = false
    w.put(ck({ value: 'SECRET-sid-3' }))
    w.timers.fire()
    await tick()
    expect(w.copy()!.cookies.find((e) => e.name === 'sid')!.value).toBe('SECRET-sid-3')
    expect(w.keep.state().available).toBe(true)
  })

  it('loggedIn reports kept only when a copy is really on disk (a failed write, no session cookie → kept: false)', async () => {
    const w = world()
    w.fsp.st.writeFails.add(FILE + '.tmp')
    expect(await loggedIn(w)).toEqual({ kept: false })
    const p = world()
    p.put(ck({ name: 'auth', session: false, expirationDate: T0 / 1000 + 86_400 })) // only a persistent login cookie
    await p.keep.restore()
    expect(await p.keep.loggedIn()).toEqual({ kept: false })
    expect(p.fsp.files.has(FILE)).toBe(false)
  })

  it('loggedIn writes and flushes at once (no debounce); switched off → kept: false', async () => {
    const w = world()
    w.put(ck())
    await w.keep.restore()
    const flushes = w.cookies.calls.flush
    expect(await w.keep.loggedIn()).toEqual({ kept: true })
    expect(w.timers.count()).toBe(0)
    expect(w.fsp.files.has(FILE)).toBe(true)
    expect(w.cookies.calls.flush).toBeGreaterThanOrEqual(flushes + 1)
    const off = world({ enabled: false })
    expect(await loggedIn(off)).toEqual({ kept: false })
    expect(off.fsp.files.has(FILE)).toBe(false)
  })
})

describe('keep-login: Đăng xuất (forget)', () => {
  it('deletes the copy BEFORE clearing; changes during the clear and late answers after it are never written', async () => {
    const w = world()
    await loggedIn(w)
    let seenDuringClear: boolean | null = null
    const out = await w.keep.forget(async () => {
      seenDuringClear = w.fsp.files.has(FILE)
      w.put(ck({ value: 'DURING-CLEAR' }))
      w.timers.fire()
      await tick()
      return 'done'
    })
    expect(out).toEqual({ copyRemoved: true, result: 'done' })
    expect(seenDuringClear).toBe(false)
    // a late answer (a request in flight when Đăng xuất began) sets its session cookie after the clear
    w.put(ck({ value: 'LATE-ANSWER' }))
    w.timers.fire()
    await tick()
    expect(w.fsp.files.has(FILE)).toBe(false)
    // … until the next confirmed login
    await w.keep.loggedIn()
    expect(w.copy()!.cookies.find((e) => e.name === 'sid')!.value).toBe('LATE-ANSWER')
  })

  it('a save already in flight never brings the copy back', async () => {
    const w = world()
    await loggedIn(w)
    const g = gate()
    w.crypto.st.encryptGate = g.promise
    w.put(ck({ value: 'IN-FLIGHT' }))
    w.timers.fire()
    await tick()
    const forgetting = w.keep.forget(async () => undefined)
    g.open()
    expect(await forgetting).toMatchObject({ copyRemoved: true })
    await tick()
    expect(w.fsp.files.has(FILE)).toBe(false)
  })

  it('a locked file: retried 3 times, then emptied (the next start deletes it unread)', async () => {
    const w = world()
    await loggedIn(w)
    w.fsp.st.rmFails.add(FILE)
    expect(await w.keep.forget(async () => undefined)).toMatchObject({ copyRemoved: true })
    expect(w.fsp.st.ops.filter((o) => o === `rm ${FILE}`)).toHaveLength(3)
    expect(w.sleeps.filter((ms) => ms < CAP)).toEqual(expect.arrayContaining([150, 600]))
    expect(w.fsp.files.get(FILE)!.length).toBe(0)
    w.fsp.st.rmFails.clear()
    const next = w.restart()
    const dec0 = next.crypto.st.calls.dec
    expect(await next.keep.restore()).toEqual({ restored: 0 })
    expect(next.crypto.st.calls.dec).toBe(dec0)
    expect(next.fsp.files.has(FILE)).toBe(false)
  })

  it('neither deleted nor emptied → copyRemoved: false (said, never "Đã đăng xuất"), and the next start never puts it back', async () => {
    const w = world()
    await loggedIn(w)
    w.fsp.st.rmFails.add(FILE)
    w.fsp.st.writeFails.add(FILE)
    expect(await w.keep.forget(async () => 'cleared')).toEqual({ copyRemoved: false, result: 'cleared' })
    expect(w.fsp.files.has(FILE)).toBe(true)
    expect(w.fsp.files.has(MARKER)).toBe(true) // "forget it" marker next to it
    // next start: the copy is still locked → not restored
    const locked = w.restart()
    expect(await locked.keep.restore()).toEqual({ restored: 0 })
    expect(locked.cookies.calls.set).toHaveLength(0)
    // the lock is gone at the start after: deleted, marker removed, still nothing restored
    w.fsp.st.rmFails.clear()
    w.fsp.st.writeFails.clear()
    const free = w.restart()
    const dec0 = free.crypto.st.calls.dec
    expect(await free.keep.restore()).toEqual({ restored: 0 })
    expect(free.fsp.files.has(FILE)).toBe(false)
    expect(free.fsp.files.has(MARKER)).toBe(false)
    expect(free.crypto.st.calls.dec).toBe(dec0)
  })

  it('a new confirmed login replaces a copy that was left behind (and its marker)', async () => {
    const w = world()
    await loggedIn(w)
    w.fsp.st.rmFails.add(FILE)
    w.fsp.st.writeFails.add(FILE)
    await w.keep.forget(async () => undefined)
    w.fsp.st.rmFails.clear()
    w.fsp.st.writeFails.clear()
    w.put(ck({ value: 'NEW-LOGIN' }))
    await w.keep.loggedIn()
    expect(w.fsp.files.has(MARKER)).toBe(false)
    expect(await w.restart().keep.restore()).toEqual({ restored: 2 })
  })
})

describe('keep-login: canvasapp refuses (rejected) — judged by the kept-cookie generation, never by time', () => {
  it('unchanged generation → the copy is deleted and nothing is written until the next confirmed login', async () => {
    const w = world()
    await loggedIn(w)
    await w.keep.rejected(w.keep.mark())
    expect(w.fsp.files.has(FILE)).toBe(false)
    w.put(ck({ value: 'AFTER-REFUSAL' }))
    w.timers.fire()
    await tick()
    expect(w.fsp.files.has(FILE)).toBe(false)
    await w.keep.confirmed(w.keep.mark())
    expect(w.fsp.files.has(FILE)).toBe(true)
  })

  it('a kept cookie changed between the request and the refusal → the copy stays, but nothing is written until canvasapp confirms the new cookie', async () => {
    const w = world()
    await loggedIn(w)
    const m = w.keep.mark()
    w.put(ck({ value: 'NEWER' })) // a renewal by another answer — or set by the refusal itself: cannot tell
    await w.keep.rejected(m)
    w.timers.fire()
    await tick()
    const sid = () => w.copy()!.cookies.find((e) => e.name === 'sid')!.value
    expect(sid()).toBe('SECRET-sid-1') // not deleted, not rewritten
    await w.keep.confirmed(m) // about the refused cookies: never re-arms
    w.put(ck({ value: 'NEWER' }))
    w.timers.fire()
    await tick()
    expect(sid()).toBe('SECRET-sid-1')
    await w.keep.confirmed(w.keep.mark()) // canvasapp accepts the newer cookie
    expect(sid()).toBe('NEWER')
  })

  it('a refusal that itself sets a kept cookie (a new canvas_csrf): the dead login is never saved again, savedAt unchanged, and it ages out', async () => {
    const w1 = world()
    await loggedIn(w1)
    let w = w1
    for (const day of [10, 20]) {
      w.clock.t = T0 + day * DAY
      w = w.restart()
      expect(await w.keep.restore()).toEqual({ restored: 2 })
      const writes0 = writesOf(w)
      const m = w.keep.mark()
      w.put(csrf(`SECRET-csrf-anon-${day}`)) // Set-Cookie of the refusal: 'changed' fires before the body is read
      await w.keep.rejected(m)
      w.timers.fire()
      await tick()
      expect(writesOf(w), `day ${day}`).toBe(writes0)
      expect(w.copy()!.savedAt, `day ${day}`).toBe(T0)
      // a confirmation sent earlier with the same cookies never re-arms it
      await w.keep.confirmed(m)
      w.put(csrf(`SECRET-csrf-anon-${day}-2`))
      w.timers.fire()
      await tick()
      expect(writesOf(w), `day ${day}`).toBe(writes0)
    }
    w.clock.t = T0 + 30 * DAY + 1
    expect(await w.restart().keep.restore()).toEqual({ restored: 0 })
  })

  it('a copy rewritten after the refused request left (a slow answer) is deleted by the refusal: it may hold what the refusal set', async () => {
    const w1 = world()
    await loggedIn(w1)
    w1.clock.t = T0 + 10 * DAY
    const w = w1.restart()
    await w.keep.restore()
    const m = w.keep.mark()
    w.put(csrf('SECRET-csrf-anon'))
    w.timers.fire() // the debounce ran out before the body was read
    await tick()
    expect(w.copy()!.savedAt).toBe(T0 + 10 * DAY)
    await w.keep.rejected(m)
    expect(w.fsp.files.has(FILE)).toBe(false)
    w.put(csrf('SECRET-csrf-anon-2'))
    w.timers.fire()
    await tick()
    expect(w.fsp.files.has(FILE)).toBe(false)
  })

  it('a confirmation sent before a refusal (same cookies) never brings the dropped copy back', async () => {
    const w = world()
    await loggedIn(w)
    const mA = w.keep.mark() // GET /api/me sent
    const mB = w.keep.mark() // GET /api/auth/state sent; the session dies in between on canvasapp's side
    await w.keep.rejected(mB) // B answers first: refused
    expect(w.fsp.files.has(FILE)).toBe(false)
    await w.keep.confirmed(mA) // A's late 200
    await tick()
    expect(w.fsp.files.has(FILE)).toBe(false)
    w.put(ck({ value: 'SECRET-sid-x' }))
    w.timers.fire()
    await tick()
    expect(w.fsp.files.has(FILE)).toBe(false)
  })

  it('a refusal sent before a login and answered after it never drops or disarms that login (even with a persistent login cookie)', async () => {
    const w = world()
    w.put(csrf())
    await w.keep.restore()
    const stale = w.keep.mark() // the login window's /api/auth/state poll, sent while still logged out
    w.put(ck({ name: 'auth', value: 'SECRET-auth', session: false, expirationDate: T0 / 1000 + 86_400 }))
    expect(await w.keep.loggedIn()).toEqual({ kept: true })
    await w.keep.rejected(stale)
    expect(w.fsp.files.has(FILE)).toBe(true)
    w.put(csrf('SECRET-csrf-2'))
    w.timers.fire()
    await tick()
    expect(w.copy()!.cookies.find((e) => e.name === 'canvas_csrf')!.value).toBe('SECRET-csrf-2') // still armed
  })

  it('a Cloudflare / persistent / other-host cookie set by the 401 itself does NOT hide the refusal', async () => {
    for (const c of [ck({ name: '__cf_bm', value: 'B' }), ck({ name: 'p', session: false, expirationDate: 9e9 }), ck({ name: 'x', domain: '.google.com', hostOnly: false })]) {
      const w = world()
      await loggedIn(w)
      const m = w.keep.mark()
      w.put(c)
      await w.keep.rejected(m)
      expect(w.fsp.files.has(FILE), c.name).toBe(false)
    }
  })

  it('a mark taken before the restore finished says nothing about the restored cookies', async () => {
    const w1 = world()
    await loggedIn(w1)
    const w2 = w1.restart()
    const early = w2.keep.mark()
    await w2.keep.restore()
    await w2.keep.rejected(early)
    expect(w2.fsp.files.has(FILE)).toBe(true)
    await w2.keep.rejected(null)
  })
})

describe('keep-login: start-up sweep (stat only — never reads or decrypts the copy)', () => {
  const readsOf = (w: World) => w.fsp.st.ops.filter((o) => o === `read ${FILE}`).length

  it('a copy last written more than 30 days ago is deleted at start, even if canvasapp is never used in that run', async () => {
    const w1 = world()
    await loggedIn(w1)
    w1.clock.t = T0 + 30 * DAY - 1000
    const w2 = w1.restart()
    const calls0 = { ...w2.crypto.st.calls }
    const reads0 = readsOf(w2)
    await w2.keep.sweep()
    expect(w2.fsp.files.has(FILE)).toBe(true) // within the limit: left alone
    w2.clock.t = T0 + 30 * DAY + 1
    const w3 = w2.restart()
    await w3.keep.sweep()
    expect(w3.fsp.files.has(FILE)).toBe(false)
    expect(w3.crypto.st.calls).toEqual(calls0) // no safeStorage at all
    expect(readsOf(w3)).toBe(reads0) // never read
  })

  it('switched off, a forget marker, an empty or oversized copy → deleted at start; a fresh copy is restored as usual', async () => {
    const off = world()
    await loggedIn(off)
    const offNext = off.restart({ enabled: false })
    await offNext.keep.sweep()
    expect(offNext.fsp.files.has(FILE)).toBe(false)

    const marked = world()
    await loggedIn(marked)
    marked.fsp.files.set(MARKER, new Uint8Array(0))
    const markedNext = marked.restart()
    await markedNext.keep.sweep()
    expect(markedNext.fsp.files.has(FILE)).toBe(false)
    expect(markedNext.fsp.files.has(MARKER)).toBe(false)

    for (const bytes of [new Uint8Array(0), new Uint8Array(R.KEEP_LOGIN_MAX_FILE_BYTES + 1)]) {
      const w = world()
      w.fsp.files.set(FILE, bytes)
      await w.keep.sweep()
      expect(w.fsp.files.has(FILE)).toBe(false)
    }

    const fresh = world()
    await loggedIn(fresh)
    const freshNext = fresh.restart()
    await freshNext.keep.sweep()
    expect(await freshNext.keep.restore()).toEqual({ restored: 2 })
  })

  it('no copy, or an fs without stat → nothing happens, never throws', async () => {
    const w = world()
    await expect(w.keep.sweep()).resolves.toBeUndefined()
    const bare = fakeFs()
    const noStat = Object.assign(bare, { stat: undefined }) as unknown as ReturnType<typeof fakeFs>
    const v = world({ fsp: noStat })
    v.fsp.files.set(FILE, new Uint8Array(0))
    await expect(v.keep.sweep()).resolves.toBeUndefined()
    expect(v.fsp.files.has(FILE)).toBe(true)
  })
})

describe('keep-login: the switch (setEnabled)', () => {
  it('off: the copy is deleted now, nothing written while off; on: saved at once when armed', async () => {
    const w = world()
    await loggedIn(w)
    expect(await w.keep.setEnabled(false)).toEqual({ copyRemoved: true })
    expect(w.fsp.files.has(FILE)).toBe(false)
    expect(w.keep.state().enabled).toBe(false)
    w.put(ck({ value: 'WHILE-OFF' }))
    w.timers.fire()
    await tick()
    expect(w.fsp.files.has(FILE)).toBe(false)
    expect(await w.keep.setEnabled(true)).toEqual({ copyRemoved: true })
    expect(w.copy()!.cookies.find((e) => e.name === 'sid')!.value).toBe('WHILE-OFF')
  })

  it('off with a locked file → copyRemoved: false (the pref is off: the next start deletes it unread)', async () => {
    const w = world()
    await loggedIn(w)
    w.fsp.st.rmFails.add(FILE)
    w.fsp.st.writeFails.add(FILE)
    expect(await w.keep.setEnabled(false)).toEqual({ copyRemoved: false })
    w.fsp.st.rmFails.clear()
    w.fsp.st.writeFails.clear()
    const next = w.restart({ enabled: false })
    expect(await next.keep.restore()).toEqual({ restored: 0 })
    expect(next.fsp.files.has(FILE)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Wiring in electron/main.cjs
// ---------------------------------------------------------------------------------------------------------------

/**
 * Source without comments: block comments starting a line (docblocks, `/* … *\/` in an empty catch) and line comments
 * after a space. (Not a naive /\*…*\/ match: main.cjs has the string 'video/mp4,*\/*'.)
 */
const stripComments = (s: string) => s.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/(^|\s)\/\/.*$/gm, '$1')
const mainCode = stripComments(mainSource)
const count = (src: string, s: string) => src.split(s).length - 1
function blockAt(src: string, from: number): [number, number] {
  const open = src.indexOf('{', from)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return [open, i + 1]
  }
  throw new Error('unbalanced block')
}
function fnBody(name: string): string {
  const at = mainCode.search(new RegExp(`(async )?function ${name}\\(`))
  expect(at, name).toBeGreaterThan(-1)
  const params = mainCode.indexOf(')', mainCode.indexOf('(', at))
  const [s, e] = blockAt(mainCode, params)
  return mainCode.slice(s, e)
}
const order = (body: string, parts: string[]) => {
  const at = parts.map((p) => body.indexOf(p))
  parts.forEach((p, i) => expect(at[i], p).toBeGreaterThan(-1))
  for (let i = 1; i < at.length; i++) expect(at[i], `${parts[i - 1]} → ${parts[i]}`).toBeGreaterThan(at[i - 1])
}

describe('keep-login wiring (electron/main.cjs)', () => {
  it('canvasappRequest: refuses during Đăng xuất, restores first, tracks requests in flight, marks status requests', () => {
    const body = fnBody('canvasappRequest')
    order(body, [
      "if (canvasappLoggingOut) return gatewayError('logged-out', keepLoginRules.CANVASAPP_LOGGING_OUT_TEXT)",
      'const logoutAt = canvasappLogoutEpoch',
      'await ensureCanvasappRestored()',
      'canvasappInFlight.add(inFlight)',
      "if (stopped()) return gatewayError('logged-out', keepLoginRules.CANVASAPP_LOGGING_OUT_TEXT)",
      'const mark = statusReq && canvasappKeep ? canvasappKeep.mark() : null',
      'canvasappSession().fetch(',
      'keepLoginRules.statusVerdict(url.pathname, res.status, out.json)',
      "if (mark && verdict === 'denied') void canvasappKeep.rejected(mark)",
      "else if (mark && verdict === 'accepted') void canvasappKeep.confirmed(mark)",
      "if (verdict === 'accepted') canvasappLoginConfirmed()",
      'canvasappInFlight.delete(inFlight)',
      'settle()',
    ])
    expect(body).toContain("const statusReq = method === 'GET' && (url.pathname === '/api/me' || url.pathname === '/api/auth/state')")
    expect(body).toContain('const stopped = () => controller.signal.aborted || canvasappLoggingOut || logoutAt !== canvasappLogoutEpoch')
    // aborted by Đăng xuất stays 'network' (a job may exist → looked up, never re-posted); a timeout keeps its text
    expect(body).toContain("if (aborted && !timedOut) return gatewayError('network', keepLoginRules.CANVASAPP_ABORTED_BY_LOGOUT_TEXT)")
    expect(body).toMatch(/finally \{\s+if \(timer\) clearTimeout\(timer\)\s+canvasappInFlight\.delete\(inFlight\)\s+settle\(\)/)
  })

  it("cookies 'changed' is listened to exactly once, after the restore, by the keep-login object", () => {
    expect(count(mainCode, "cookies.on('changed'")).toBe(1)
    const body = fnBody('ensureCanvasappRestored')
    expect(body).toContain(".then(() => canvasappSession().cookies.on('changed', canvasappKeep.onChanged))")
    expect(body).toContain('keepLoginRules.KEEP_LOGIN_RESTORE_CAP_MS')
    expect(R.KEEP_LOGIN_RESTORE_CAP_MS).toBe(3000)
    expect(body).toMatch(/if \(!canvasappRestore\)/)
  })

  it('lazy: on ready only the object is created (no copy read, no safeStorage call); async safeStorage only', () => {
    const reg = fnBody('registerCanvasappGateway')
    expect(reg).toContain('startCanvasappKeepLogin()')
    expect(reg).not.toMatch(/\.restore\(|safeStorage/)
    const start = fnBody('startCanvasappKeepLogin')
    expect(start).not.toMatch(/\.restore\(|readFile\(|ensureCanvasappRestored/)
    // safeStorage appears only in the require line and inside the injected crypto object of startCanvasappKeepLogin
    const cryptoObj = start.slice(start.indexOf('const asyncSafeStorage = {'), blockAt(start, start.indexOf('const asyncSafeStorage = {'))[1])
    expect(count(mainCode, 'safeStorage')).toBe(count(cryptoObj, 'safeStorage') + 1)
    expect(mainCode).toMatch(/const \{ app, BrowserWindow, Menu, dialog, ipcMain, protocol, safeStorage, session, shell \} = require\('electron'\)/)
    // only inside arrow functions (called later by the keep-login object, never at start)
    for (const line of cryptoObj.split('\n').filter((l) => l.includes('safeStorage'))) expect(line).toMatch(/^\s+\w+: (async )?\([^)]*\) => /)
    expect(cryptoObj).toContain('await safeStorage.isAsyncEncryptionAvailable()')
    expect(mainCode).not.toMatch(/encryptString\(|decryptString\(|setUsePlainTextEncryption/)
    expect(cryptoObj).toContain("safeStorage.getSelectedStorageBackend() === 'basic_text'")
    expect(start).toContain('enabled: keepLoginRules.resolveKeepLogin(canvasappKeepPrefs, keepLoginPlacementKind())')
    // the start-up sweep only stats the copy (after the object exists)
    order(start, ['canvasappKeep = keepLoginRules.createCanvasappKeepLogin({', 'void canvasappKeep.sweep()'])
    // macOS "installed" = in Applications: asked behind the darwin guard, in its own try, never inside appPlacement
    const kind = fnBody('keepLoginPlacementKind')
    order(kind, [
      "if (process.platform === 'darwin' && PACKAGED && typeof app.isInApplicationsFolder === 'function') {",
      'inApplications = app.isInApplicationsFolder() === true',
      'keepLoginRules.keepLoginPlacement({ platform: process.platform, kind: appPlacement().kind, inApplications })',
    ])
    expect(fnBody('appPlacement')).not.toContain('isInApplicationsFolder')
    expect(count(mainCode, 'isInApplicationsFolder()')).toBe(1)
    expect(start).toContain('canvasappKeepPrefs = readCanvasappKeepPrefs()')
    expect(start).toContain("file: path.join(app.getPath('userData'), CANVASAPP_LOGIN_FILE)")
    expect(mainCode).toContain("const CANVASAPP_LOGIN_FILE = 'canvasapp-login.bin'")
    expect(mainCode).toContain("const keepLoginRules = require('./keeplogin-rules.cjs')")
  })

  it('Đăng xuất: drain → forget(clear) with the server logout, clear, cache, flush inside — and says when the copy stays', () => {
    const body = fnBody('canvasappLogout')
    order(body, [
      'canvasappLoggingOut = true',
      'canvasappLogoutEpoch++',
      'await drainCanvasappRequests(keepLoginRules.KEEP_LOGIN_DRAIN_CAP_MS)',
      'await canvasappServerLogout()',
      'await ses.clearStorageData()',
      'await ses.clearCache()',
      'await ses.cookies.flushStore()',
      'await canvasappKeep.forget(clear)',
      "gatewayError('keep-login-not-cleared', keepLoginRules.KEEP_LOGIN_NOT_CLEARED_TEXT)",
    ])
    expect(body).toContain("return copyRemoved ? { ok: true } : gatewayError('keep-login-not-cleared'")
    expect(body).toMatch(/finally \{\s+canvasappLoggingOut = false/)
    expect(R.KEEP_LOGIN_DRAIN_CAP_MS).toBe(5000)
    const drain = fnBody('drainCanvasappRequests')
    order(drain, ['for (const r of pending) r.controller.abort()', 'Promise.allSettled(pending.map((r) => r.done))'])
    // the only clearStorageData is Đăng xuất's
    expect(count(mainCode, 'clearStorageData(')).toBe(1)
  })

  it('the server logout is main-only (not in the allowlist), best effort, and the only other canvasapp fetch', () => {
    const m = /\/\/ <canvasapp-routes>[^\n]*\n([\s\S]*?)\/\/ <\/canvasapp-routes>/.exec(mainSource)!
    const match = new Function('CANVASAPP_ORIGIN', `${m[1]}\nreturn matchCanvasappRoute`)('https://canvasapp.io.vn') as (method: string, path: string) => unknown
    expect(match('POST', '/api/auth/logout')).toBeNull()
    expect(match('GET', '/api/auth/logout')).toBeNull()
    expect(mainCode).toContain("const CANVASAPP_LOGOUT_PATH = '/api/auth/logout'")
    const body = fnBody('canvasappServerLogout')
    expect(body).toContain('ses.fetch(CANVASAPP_ORIGIN + CANVASAPP_LOGOUT_PATH, {')
    expect(body).toContain("method: 'POST'")
    expect(body).toContain("'X-CSRF-Token': csrf")
    expect(body).toContain('signal: AbortSignal.timeout(5000)')
    expect(body).toContain("redirect: 'manual'")
    expect(body).toContain('if (!cookies.some((c) => keepLoginRules.isHostCookie(c, CANVASAPP_HOST))) return')
    expect(body).toMatch(/\} catch \{/)
    // fetches through the canvasapp partition: canvasappRequest and canvasappServerLogout only
    expect(count(mainCode, 'canvasappSession().fetch(')).toBe(1)
    expect(count(fnBody('canvasappRequest'), 'canvasappSession().fetch(')).toBe(1)
    expect(count(mainCode, 'ses.fetch(')).toBe(1)
  })

  it('login finish keeps a confirmed login (and reports it); checkout restores first; IPC behind guard', () => {
    const login = fnBody('canvasappLogin')
    order(login, ['const st = await canvasappStatus()', '(await canvasappKeep.loggedIn()).kept', 'resolve(st.ok && st.authenticated ? { ...st, keepLogin: kept } : st)'])
    expect(login).toContain('if (DEVTOOLS) void logCanvasappCookieShape()')
    expect(fnBody('canvasappCheckout')).toMatch(/^\{\s+await ensureCanvasappRestored\(\)/)
    const reg = fnBody('registerCanvasappGateway')
    expect(reg).toContain("ipcMain.handle('canvasapp:keepLogin', guard(() => canvasappKeepLoginState()))")
    expect(reg).toContain("ipcMain.handle('canvasapp:setKeepLogin', guard((_event, on) => canvasappSetKeepLogin(on)))")
    expect(count(mainCode, "'canvasapp:keepLogin'")).toBe(1)
    expect(count(mainCode, "'canvasapp:setKeepLogin'")).toBe(1)
    const set = fnBody('canvasappSetKeepLogin')
    order(set, ["if (typeof on !== 'boolean') return gatewayError('bad-request'", 'await canvasappKeep.setEnabled(on)', 'await storeCanvasappKeepPrefs(on)'])
    expect(set).toContain("if (!copyRemoved) return gatewayError('keep-login-not-cleared', keepLoginRules.KEEP_LOGIN_OFF_NOT_CLEARED_TEXT)")
    expect(fnBody('storeCanvasappKeepPrefs')).toContain('await renameSaveFile(fs.promises, tmp, file)')
    expect(mainCode).toContain("const CANVASAPP_PREFS_FILE = 'canvasapp-prefs.json'")
  })

  it('no quit hooks, no cookie made persistent, no cookie value logged', () => {
    expect(mainCode).not.toMatch(/before-quit|will-quit|beforeunload/)
    expect(mainCode).not.toMatch(/expirationDate\s*:/)
    const shape = fnBody('logCanvasappCookieShape')
    expect(shape).toContain('keepLoginRules.cookieShapeLine(c, Date.now())')
    expect(shape).not.toMatch(/\.value/)
    // the only DEVTOOLS shortcut block stays the first `if (DEVTOOLS) {` (hardeningRules.test.ts relies on it)
    expect(mainCode.indexOf('if (DEVTOOLS) {')).toBeLessThan(mainCode.indexOf('if (DEVTOOLS) void logCanvasappCookieShape()'))
  })

  it('Google account cookies: removed after a confirmed login (finish), and once per run after a confirmed session — never while the login window is open', () => {
    const login = fnBody('canvasappLogin')
    order(login, ['(await canvasappKeep.loggedIn()).kept', 'if (st.ok && st.authenticated) await keepLoginRules.removeGoogleAccountCookies(canvasappSession().cookies)', 'resolve('])
    const confirmed = fnBody('canvasappLoginConfirmed')
    order(confirmed, [
      'if (canvasappGoogleCleaned || (canvasappLoginWin && !canvasappLoginWin.isDestroyed())) return',
      'canvasappGoogleCleaned = true',
      'void keepLoginRules.removeGoogleAccountCookies(canvasappSession().cookies)',
    ])
    expect(count(mainCode, 'removeGoogleAccountCookies(')).toBe(2)
    expect(mainCode).not.toMatch(/cookies\.remove\(/) // only through the rules (Google cookies only)
  })

  it('the user texts never claim canvasapp revoked the session', () => {
    for (const t of [R.KEEP_LOGIN_NOT_CLEARED_TEXT, R.KEEP_LOGIN_OFF_NOT_CLEARED_TEXT, R.CANVASAPP_LOGGING_OUT_TEXT, R.CANVASAPP_ABORTED_BY_LOGOUT_TEXT]) {
      expect(t).not.toMatch(/hết hiệu lực|thu hồi|vô hiệu/i)
    }
  })
})
