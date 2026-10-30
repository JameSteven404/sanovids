// Sano Agent in-app sign-in (electron/sano-account-rules.cjs, D253): the account against a fake SANO account server
// (an injected fetch answering /api/auth/* like SANO's server/accounts.ts), a fake reversible safeStorage, an
// in-memory fs and a fake Google sign-in. Never a real server, never Google. Passwords are built at run time.
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'
import preloadSource from '../../../electron/preload.cjs?raw'
import probeSource from '../../../scripts/sano-desktop-probe.cjs?raw'

type User = { id: string; name: string; email: string; username: string | null; admin: boolean }
type Status = { configured: boolean; signedIn: boolean; user: User | null; persistent: boolean; offline?: boolean }
type Answer<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }
type GoogleResult = { ok: true; idToken: string } | { ok: false; code: string; message: string }
interface Account {
  status(): Promise<Answer<Status>>
  login(i: unknown): Promise<Answer<Status>>
  register(i: unknown): Promise<Answer<{ ok: true }>>
  forgot(i: unknown): Promise<Answer<{ ok: true }>>
  google(): Promise<Answer<Status>>
  cancelGoogle(): Promise<Answer<undefined>>
  signOut(): Promise<Answer<Status>>
  bearer(): Promise<string | null>
  ended(token: string, reason?: string): Promise<void>
  userId(): string | null
}
interface Rules {
  TIMEOUT_MS: number
  LIMITS: Record<string, number>
  REDIRECT_URI: string
  CALLS: readonly string[]
  TEXT: Record<string, string>
  NOT_ALLOWED: { ok: false; error: string; code: string }
  accountApiUrl(v: unknown): string | null
  createAccount(fx: Record<string, unknown>): Account
  registerAccountIpc(ipcMain: { handle(ch: string, fn: (event: unknown, input: unknown) => unknown): void }, account: Account, allowed: (event: unknown) => boolean): void
}
const nodeRequire = createRequire(import.meta.url)
const R = nodeRequire('../../../electron/sano-account-rules.cjs') as Rules

const API = 'http://127.0.0.1:8796'
const FILE = 'C:/profile/sano-account.bin'
const MARK = `${FILE}.forget`
const NOW = Date.parse('2026-10-28T10:00:00Z')
const pw = () => `Pw-${randomUUID()}`
const S256 = (v: string) => createHash('sha256').update(v).digest('base64url')
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/** SANO's /api/auth/* as far as the app uses it: one verified account, codes bound to redirect_uri + S256 challenge. */
function fakeServer(password = pw()) {
  const user: User = { id: 'u-1', name: 'Minh', email: 'minh@sanogroup.tv', username: 'minh', admin: false }
  const calls: { method: string; path: string; auth?: string; body: Record<string, unknown> | null; init: RequestInit }[] = []
  const codes = new Map<string, { challenge: string; redirect: string }>()
  const sessions = new Set<string>()
  const secrets: string[] = [password]
  const opts: { offline?: boolean; meStatus?: number; meExpiresAt?: string; state?: string; redirect?: string; hang?: string; gate?: Promise<unknown>; raw?: Response } = {}
  const issue = (body: Record<string, unknown>) => {
    const code = `code-${randomUUID()}`
    secrets.push(code)
    codes.set(code, { challenge: String(body.code_challenge), redirect: String(body.redirect_uri) })
    const u = new URL(opts.redirect ?? String(body.redirect_uri))
    u.searchParams.set('code', code)
    u.searchParams.set('state', opts.state ?? String(body.state))
    return json(200, { redirect: u.href })
  }
  const fetch = async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const headers = init.headers as Record<string, string>
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    calls.push({ method: String(init.method), path: u.pathname, auth: headers.Authorization, body, init })
    if (opts.hang === u.pathname) await (opts.gate ?? new Promise(() => undefined)) // a gate answers it later, as the server would
    if (opts.offline) throw new TypeError('fetch failed')
    if (opts.raw) return opts.raw
    expect(u.origin).toBe(API)
    if (body) expect(headers['Content-Type']).toBe('application/json')
    switch (`${init.method} ${u.pathname}`) {
      case 'POST /api/auth/login':
        if (body?.identifier !== 'minh' || body.password !== password) return json(401, { error: 'Sai tài khoản hoặc mật khẩu.' })
        if (body.client !== 'desktop' || body.redirect_uri !== R.REDIRECT_URI) return json(400, { error: 'Yêu cầu đăng nhập không hợp lệ.' })
        return issue(body)
      case 'POST /api/auth/google':
        if (body?.credential !== 'google-id-token') return json(401, { error: 'Đăng nhập Google không hợp lệ.' })
        return issue(body)
      case 'POST /api/auth/token': {
        const c = codes.get(String(body?.code))
        codes.delete(String(body?.code))
        if (!c || c.redirect !== body?.redirect_uri || S256(String(body?.code_verifier)) !== c.challenge) return json(400, { error: 'Mã đăng nhập không hợp lệ hoặc đã hết hạn. Đăng nhập lại.' })
        const token = `sano_${randomUUID()}`
        secrets.push(token, String(body?.code_verifier))
        sessions.add(token)
        return json(200, { token, expiresAt: new Date(NOW + 30 * 86_400_000).toISOString(), user })
      }
      case 'GET /api/auth/me': {
        if (opts.meStatus) return json(opts.meStatus, { error: 'x' })
        const ok = sessions.has(String(headers.Authorization).replace('Bearer ', ''))
        return ok ? json(200, opts.meExpiresAt ? { ...user, expiresAt: opts.meExpiresAt } : user) : json(401, { error: 'Phiên đăng nhập đã hết hạn. Đăng nhập lại.' })
      }
      case 'POST /api/auth/logout':
        sessions.delete(String(headers.Authorization).replace('Bearer ', ''))
        return json(200, { ok: true })
      case 'POST /api/auth/register':
        if (!String(body?.email).endsWith('@sanogroup.tv')) return json(403, { error: 'Chỉ email @sanogroup.tv được tự tạo tài khoản.' })
        return json(200, { ok: true })
      case 'POST /api/auth/forgot':
        return json(200, { ok: true })
    }
    return json(404, { error: 'Không tìm thấy API.' })
  }
  return { user, calls, sessions, secrets, opts, fetch, password }
}

/** userData's file, encrypted by a fake safeStorage (base64 behind a prefix: never the plaintext). */
function machine(encrypt = true) {
  const files = new Map<string, Buffer>()
  const fs = {
    readFile: async (p: string) => {
      const b = files.get(p)
      if (!b) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return b
    },
    writeFile: async (p: string, b: Buffer) => void files.set(p, Buffer.from(b)),
    rename: async (a: string, b: string) => {
      files.set(b, files.get(a)!)
      files.delete(a)
    },
    rm: async (p: string) => void files.delete(p),
  }
  const safeStorage = {
    isEncryptionAvailable: () => encrypt,
    encryptString: (s: string) => Buffer.from(`v10${Buffer.from(s).toString('base64')}`),
    decryptString: (b: Buffer) => {
      const s = b.toString()
      if (!s.startsWith('v10')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return Buffer.from(s.slice(3), 'base64').toString()
    },
  }
  return { files, fs, safeStorage }
}

function fakeGoogle(result: () => Promise<GoogleResult> = async () => ({ ok: true, idToken: 'google-id-token' })) {
  const g = { signIns: 0, signOuts: 0, cancel: null as null | (() => void) }
  return Object.assign(g, {
    signIn: () => {
      g.signIns++
      return new Promise<GoogleResult>((resolve) => {
        g.cancel = () => resolve({ ok: false, code: 'cancelled', message: 'Bạn đã hủy đăng nhập.' })
        void result().then(resolve)
      })
    },
    signOut: () => {
      g.signOuts++
      g.cancel?.()
      return true
    },
  })
}

const logs: string[] = []
function setup(o: { server?: ReturnType<typeof fakeServer>; m?: ReturnType<typeof machine>; google?: ReturnType<typeof fakeGoogle>; apiUrl?: string | null; now?: number; onSessionEnd?: (reason?: unknown) => unknown } = {}) {
  const server = o.server ?? fakeServer()
  const m = o.m ?? machine()
  const google = o.google ?? fakeGoogle()
  let seed = 0
  const account = R.createAccount({
    apiUrl: o.apiUrl === undefined ? API : o.apiUrl,
    fetch: server.fetch,
    file: FILE,
    fs: m.fs,
    safeStorage: m.safeStorage,
    now: () => o.now ?? NOW,
    random: (n: number) => Uint8Array.from({ length: n }, () => (seed = (seed * 31 + 7) % 251)),
    google,
    log: (line: string) => void logs.push(line),
    onSessionEnd: o.onSessionEnd,
  })
  return { account, server, m, google }
}
const value = <T,>(a: Answer<T>) => {
  if (!a.ok) throw new Error(`expected ok, got ${a.error}`)
  return a.value
}
/** A new instance on the same machine and server (the app reopened). */
const restart = (t: ReturnType<typeof setup>) => setup({ server: t.server, m: t.m }).account
/** `what` refuses `paths` with EPERM (a Windows lock) → unlock, restoring the fs as it was before this call. */
const lock = (m: ReturnType<typeof machine>, what: ('rm' | 'writeFile')[], paths = [FILE, MARK]) => {
  const { rm, writeFile } = m.fs
  const locked = (p: string) => {
    if (paths.includes(p)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
  }
  if (what.includes('rm')) m.fs.rm = async (p: string) => (locked(p), rm(p))
  if (what.includes('writeFile')) m.fs.writeFile = async (p: string, b: Buffer) => (locked(p), writeFile(p, b))
  return () => Object.assign(m.fs, { rm, writeFile })
}

afterEach(() => {
  logs.length = 0
})

describe('accountApiUrl: https://host[:port], or http on this machine with a port; nothing else', () => {
  it('accepts a server origin only', () => {
    for (const [v, want] of [
      ['https://sano.example.vn', 'https://sano.example.vn'],
      ['https://sano.example.vn/', 'https://sano.example.vn'],
      ['https://sano.example.vn:8443', 'https://sano.example.vn:8443'],
      ['http://127.0.0.1:8796', 'http://127.0.0.1:8796'],
      ['http://localhost:8796/', 'http://localhost:8796'],
      ['http://[::1]:8796', 'http://[::1]:8796'],
    ]) expect(R.accountApiUrl(v), v).toBe(want)
    for (const bad of [undefined, null, '', 7, 'sano.example.vn', 'http://sano.example.vn', 'http://127.0.0.1', 'http://127.0.0.1:80', 'http://192.168.1.2:8796', 'https://sano.example.vn/api', 'https://sano.example.vn/?x=1', 'https://sano.example.vn?', 'https://sano.example.vn#x', 'https://u:p@sano.example.vn', 'https://u@sano.example.vn', 'ftp://sano.example.vn', 'app://sano/', 'file:///C:/x', ' https://sano.example.vn', 'javascript:alert(1)']) {
      expect(R.accountApiUrl(bad), String(bad)).toBeNull()
    }
  })
})

describe('createAccount (fake SANO account server)', () => {
  it('unconfigured: status says so, every call refuses without the network; 1.0 behaves as today', async () => {
    const { account, server } = setup({ apiUrl: null })
    expect(value(await account.status())).toEqual({ configured: false, signedIn: false, user: null, persistent: true })
    for (const r of [await account.login({ identifier: 'minh', password: pw() }), await account.register({ email: 'a@sanogroup.tv', username: 'a', name: 'A', password: pw() }), await account.forgot({ identifier: 'a' }), await account.google()]) {
      expect(r).toEqual({ ok: false, error: 'Bản Sano Agent này chưa nối máy chủ tài khoản.', code: 'not-configured' })
    }
    expect(value(await account.signOut()).signedIn).toBe(false)
    expect(server.calls).toEqual([])
  })

  it('password sign-in: fresh verifier + state per attempt, code → sano_ session, kept encrypted; a restart is still signed in', async () => {
    const t = setup()
    const { account, server, m } = t
    expect(value(await account.status())).toEqual({ configured: true, signedIn: false, user: null, persistent: true })
    const s = value(await account.login({ identifier: 'minh', password: server.password }))
    expect(s).toEqual({ configured: true, signedIn: true, user: server.user, persistent: true })
    const [login, token] = server.calls
    expect(login).toMatchObject({ method: 'POST', path: '/api/auth/login', body: { identifier: 'minh', client: 'desktop', redirect_uri: R.REDIRECT_URI } })
    expect(token).toMatchObject({ method: 'POST', path: '/api/auth/token', body: { redirect_uri: R.REDIRECT_URI } })
    expect(token.body!.code_challenge).toBeUndefined()
    // every request: JSON, 20 s, no redirect followed, no cookie
    for (const c of server.calls) {
      expect(c.init.redirect).toBe('manual')
      expect(c.init.signal).toBeInstanceOf(AbortSignal)
      expect(c.init.credentials).toBeUndefined()
    }
    expect(R.TIMEOUT_MS).toBe(20_000)
    // the file: encrypted, never the token in plaintext
    const bytes = m.files.get(FILE)!
    const tok = server.secrets.find((x) => x.startsWith('sano_'))!
    expect(bytes.toString()).not.toContain(tok)
    expect(JSON.parse(m.safeStorage.decryptString(bytes))).toEqual({ token: tok, expiresAt: '2026-11-27T10:00:00.000Z', user: server.user })
    // a second attempt uses a new verifier and state
    value(await account.login({ identifier: 'minh', password: server.password }))
    const logins = server.calls.filter((c) => c.path === '/api/auth/login')
    expect(logins[0].body!.state).not.toBe(logins[1].body!.state)
    expect(logins[0].body!.code_challenge).not.toBe(logins[1].body!.code_challenge)
    // restart: same machine, a new account object reads the file and asks /me
    const again = setup({ server, m })
    expect(value(await again.account.status())).toEqual({ configured: true, signedIn: true, user: server.user, persistent: true })
    expect(server.calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/auth/me', auth: `Bearer ${server.secrets.filter((x) => x.startsWith('sano_')).at(-1)}`, body: null })
  })

  it('/me refreshes the cached user (and the file)', async () => {
    const { account, server, m } = setup()
    value(await account.login({ identifier: 'minh', password: server.password }))
    server.user.name = 'Minh Nguyễn'
    expect(value(await account.status()).user!.name).toBe('Minh Nguyễn')
    expect(JSON.parse(m.safeStorage.decryptString(m.files.get(FILE)!)).user.name).toBe('Minh Nguyễn')
  })

  it("state mismatch, or a code for another address: refused, nothing kept, no token exchange", async () => {
    for (const o of [{ state: 'someone-else' }, { redirect: 'http://127.0.0.1:9/other' }, { redirect: 'http://127.0.0.1:5555/callback' }]) {
      const { account, server, m } = setup()
      Object.assign(server.opts, o)
      expect(await account.login({ identifier: 'minh', password: server.password })).toEqual({ ok: false, error: R.TEXT.stateMismatch, code: 'state-mismatch' })
      expect(server.calls.map((c) => c.path)).toEqual(['/api/auth/login'])
      expect(m.files.size).toBe(0)
      expect(value(await account.status()).signedIn).toBe(false)
    }
  })

  it("the server's Vietnamese errors pass through (login, register, forgot)", async () => {
    const { account, server } = setup()
    expect(await account.login({ identifier: 'minh', password: `${server.password}x` })).toEqual({ ok: false, error: 'Sai tài khoản hoặc mật khẩu.' })
    expect(await account.register({ email: 'a@gmail.com', username: 'a', name: 'A', password: pw() })).toEqual({ ok: false, error: 'Chỉ email @sanogroup.tv được tự tạo tài khoản.' })
    expect(await account.register({ email: 'a@sanogroup.tv', username: 'a', name: 'A', password: pw() })).toEqual({ ok: true, value: { ok: true } })
    expect(server.calls.at(-1)!.body).toEqual({ email: 'a@sanogroup.tv', username: 'a', name: 'A', password: expect.any(String) })
    expect(await account.forgot({ identifier: 'a' })).toEqual({ ok: true, value: { ok: true } })
    expect(server.calls.at(-1)).toMatchObject({ path: '/api/auth/forgot', body: { identifier: 'a' } })
    // a code, when the server sends one
    server.opts.raw = json(429, { error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau một phút.', code: 'rate-limit' })
    expect(await account.forgot({ identifier: 'a' })).toEqual({ ok: false, error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau một phút.', code: 'rate-limit' })
  })

  it('a redirect is never followed; a non-JSON answer is no answer', async () => {
    const { account, server } = setup()
    server.opts.raw = new Response(null, { status: 302, headers: { location: 'https://evil.example.vn/' } })
    expect(await account.forgot({ identifier: 'a' })).toEqual({ ok: false, error: R.TEXT.invalid, code: 'bad-answer' })
    server.opts.raw = new Response('<html>proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    expect(await account.forgot({ identifier: 'a' })).toEqual({ ok: false, error: R.TEXT.invalid })
  })

  it('inputs: strings only, within the limits; refused before the network', async () => {
    const { account, server } = setup()
    for (const bad of [undefined, null, 'x', {}, { identifier: 'minh' }, { identifier: 'minh', password: 7 }, { identifier: 'a'.repeat(255), password: 'x' }, { identifier: 'minh', password: 'p'.repeat(129) }]) {
      expect(await account.login(bad), JSON.stringify(bad)).toEqual({ ok: false, error: R.TEXT.badInput, code: 'bad-input' })
    }
    expect((await account.register({ email: 'a@sanogroup.tv', username: 'u'.repeat(33), name: 'A', password: pw() })).ok).toBe(false)
    expect((await account.register({ email: 'a@sanogroup.tv', username: 'u', name: 'n'.repeat(101), password: pw() })).ok).toBe(false)
    expect((await account.forgot({ identifier: ['a'] })).ok).toBe(false)
    expect(server.calls).toEqual([])
    expect(R.LIMITS).toEqual({ identifier: 254, password: 128, name: 100, email: 254, username: 32 })
  })

  it('401 (or 403) on /me: signed out, the file deleted; offline (or 5xx): still signed in with the cached user', async () => {
    for (const st of [401, 403]) {
      const { account, server, m } = setup()
      value(await account.login({ identifier: 'minh', password: server.password }))
      server.opts.meStatus = st
      expect(value(await account.status())).toEqual({ configured: true, signedIn: false, user: null, persistent: true })
      expect(m.files.size).toBe(0)
    }
    const { account, server, m } = setup()
    value(await account.login({ identifier: 'minh', password: server.password }))
    server.opts.offline = true
    expect(value(await account.status())).toEqual({ configured: true, signedIn: true, user: server.user, persistent: true, offline: true })
    server.opts.offline = false
    server.opts.meStatus = 502
    expect(value(await account.status())).toMatchObject({ signedIn: true, offline: true })
    expect(m.files.size).toBe(1)
    // the server revoked it meanwhile (a sign-out elsewhere): the next answer signs out
    server.opts.meStatus = undefined
    server.sessions.clear()
    expect(value(await account.status()).signedIn).toBe(false)
  })

  it('a /me still pending when the session ends or changes hands answers the session held now, never the old one', async () => {
    for (const late of ['offline', 'bad user', 'another user'] as const) {
      const { account, server } = setup()
      value(await account.login({ identifier: 'minh', password: server.password }))
      let answer!: () => void
      server.opts.hang = '/api/auth/me'
      server.opts.gate = new Promise<void>((r) => (answer = r))
      const pending = account.status()
      await new Promise((r) => setTimeout(r, 0))
      if (late === 'another user') {
        Object.assign(server.user, { id: 'u-b', name: 'B' })
        value(await account.login({ identifier: 'minh', password: server.password }))
      } else expect(value(await account.signOut()).signedIn).toBe(false)
      if (late === 'offline') server.opts.offline = true
      if (late === 'bad user') server.opts.raw = json(200, { nope: true })
      answer()
      const s = value(await pending)
      expect(s.offline, late).toBeUndefined()
      expect(s.user?.id ?? null, late).toBe(late === 'another user' ? 'u-b' : null)
    }
  })

  it('expired by expiresAt: one /me (no later expiresAt: signed out); a damaged file: signed out and deleted', async () => {
    const server = fakeServer()
    const m = machine()
    value(await setup({ server, m }).account.login({ identifier: 'minh', password: server.password }))
    const later = setup({ server, m, now: NOW + 31 * 86_400_000 })
    const n = server.calls.length
    expect(value(await later.account.status()).signedIn).toBe(false)
    expect(server.calls.length).toBe(n + 1) // the session may have slid on the server: /me asked once
    expect(m.files.size).toBe(0)
    m.files.set(FILE, Buffer.from('garbage'))
    expect(value(await setup({ server, m }).account.status()).signedIn).toBe(false)
    expect(m.files.size).toBe(0)
  })

  it('no encryption on this computer: memory only (persistent false), nothing written; a restart is signed out', async () => {
    const server = fakeServer()
    const m = machine(false)
    const { account } = setup({ server, m })
    expect(value(await account.login({ identifier: 'minh', password: server.password }))).toEqual({ configured: true, signedIn: true, user: server.user, persistent: false })
    expect(m.files.size).toBe(0)
    expect(value(await account.status())).toMatchObject({ signedIn: true, persistent: false })
    expect(value(await setup({ server, m }).account.status()).signedIn).toBe(false)
  })

  it('a failed rename (antivirus lock): memory only, and the encrypted token is not left in the .tmp', async () => {
    const m = machine()
    m.fs.rename = async () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    }
    const { account, server } = setup({ m })
    expect(value(await account.login({ identifier: 'minh', password: server.password })).signedIn).toBe(true)
    expect([...m.files.keys()]).toEqual([])
  })

  it("another user's sign-in that cannot be written: the previous user's file goes, else the sign-in fails (a restart never switches back)", async () => {
    for (const step of ['writeFile', 'rename'] as const) {
      const server = fakeServer()
      const m = machine()
      value(await setup({ server, m }).account.login({ identifier: 'minh', password: server.password })) // A's file
      const { writeFile, rename, rm } = m.fs
      m.fs[step] = async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      Object.assign(server.user, { id: 'u-b', name: 'B' })
      const b = setup({ server, m })
      expect(value(await b.account.login({ identifier: 'minh', password: server.password })).user!.id, step).toBe('u-b')
      expect(m.files.has(FILE), step).toBe(false) // B in memory only, A no longer on disk
      expect(value(await setup({ server, m }).account.status()).signedIn, step).toBe(false)
      // A's file cannot be deleted, emptied or marked either: B's sign-in is refused, memory and a restart agree on A
      Object.assign(m.fs, { writeFile, rename, rm })
      Object.assign(server.user, { id: 'u-a', name: 'Minh' })
      value(await setup({ server, m }).account.login({ identifier: 'minh', password: server.password }))
      const denied = async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      }
      m.fs.rm = denied
      m.fs.writeFile = async (p: string, x: Buffer) => (step === 'writeFile' || p === FILE || p === MARK ? denied() : writeFile(p, x))
      if (step === 'rename') m.fs.rename = denied
      Object.assign(server.user, { id: 'u-b', name: 'B' })
      const c = setup({ server, m })
      const open = server.sessions.size
      expect(await c.account.login({ identifier: 'minh', password: server.password }), step).toEqual({ ok: false, error: R.TEXT.notSaved, code: 'not-saved' })
      Object.assign(server.user, { id: 'u-a', name: 'Minh' })
      expect(value(await c.account.status()).user?.id, step).toBe('u-a')
      expect(value(await setup({ server, m }).account.status()).user?.id, step).toBe('u-a')
      await new Promise((r) => setTimeout(r, 0))
      expect(server.sessions.size, step).toBe(open) // B's refused session ended on the server
    }
  })

  it('sign-out: file and memory gone at once, logout sent best effort (never waited on), a Google wait cancelled', async () => {
    const { account, server, m, google } = setup()
    value(await account.login({ identifier: 'minh', password: server.password }))
    const tok = server.secrets.find((x) => x.startsWith('sano_'))
    server.opts.hang = '/api/auth/logout' // the server never answers: sign-out still returns
    expect(value(await account.signOut())).toEqual({ configured: true, signedIn: false, user: null, persistent: true })
    expect(server.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/auth/logout', auth: `Bearer ${tok}` })
    expect(m.files.size).toBe(0)
    expect(google.signOuts).toBe(1)
    expect(value(await account.status()).signedIn).toBe(false)
    // offline sign-out signs out too
    const t = setup()
    value(await t.account.login({ identifier: 'minh', password: t.server.password }))
    t.server.opts.offline = true
    expect(value(await t.account.signOut()).signedIn).toBe(false)
    expect(t.m.files.size).toBe(0)
  })

  it('sign-out with the session file locked (Windows EPERM): emptied, else marked, else an honest error', async () => {
    // rm fails, overwrite works: the file is emptied, logout still not waited on
    const a = setup()
    value(await a.account.login({ identifier: 'minh', password: a.server.password }))
    lock(a.m, ['rm'])
    a.server.opts.hang = '/api/auth/logout'
    expect(value(await a.account.signOut()).signedIn).toBe(false)
    expect(a.m.files.get(FILE)?.length).toBe(0)
    a.server.opts.hang = undefined
    expect(value(await restart(a).status()).signedIn).toBe(false)
    // the file can be neither deleted nor emptied: a marker beside it, so even an offline restart never reopens it
    const a2 = setup()
    value(await a2.account.login({ identifier: 'minh', password: a2.server.password }))
    const unlock = lock(a2.m, ['rm', 'writeFile'], [FILE])
    a2.server.opts.hang = '/api/auth/logout'
    expect(value(await a2.account.signOut()).signedIn).toBe(false)
    expect(a2.m.files.get(FILE)?.length).toBeGreaterThan(0)
    expect(a2.m.files.has(MARK)).toBe(true)
    a2.server.opts.hang = undefined
    a2.server.opts.offline = true
    expect(value(await restart(a2).status()).signedIn).toBe(false)
    // the lock gone, the next sign-in is kept again: the marker goes with the new file
    a2.server.opts.offline = false
    unlock()
    const again = restart(a2)
    value(await again.login({ identifier: 'minh', password: a2.server.password }))
    expect(a2.m.files.has(MARK)).toBe(false)
    expect(value(await restart(a2).status()).signedIn).toBe(true)
    // nothing can be written beside it either (the server up: the #95 tests below), the server is down: an error, never a
    // fake sign-out (memory and a restart agree)
    const c = setup()
    value(await c.account.login({ identifier: 'minh', password: c.server.password }))
    const unlockC = lock(c.m, ['rm', 'writeFile'])
    c.server.opts.offline = true
    expect(await c.account.signOut()).toEqual({ ok: false, error: R.TEXT.signOutFailed, code: 'sign-out-failed' })
    expect(value(await c.account.status())).toMatchObject({ signedIn: true, offline: true })
    expect(value(await restart(c).status())).toMatchObject({ signedIn: true, offline: true })
    // the lock gone and back online, the retry signs out
    unlockC()
    c.server.opts.offline = false
    expect(value(await c.account.signOut()).signedIn).toBe(false)
    expect(value(await restart(c).status()).signedIn).toBe(false)
    // while the server is asked (up to 20 s), a reload or a second click still sees the signed-in user, never a fake sign-out
    const d = setup()
    value(await d.account.login({ identifier: 'minh', password: d.server.password }))
    lock(d.m, ['rm', 'writeFile'])
    let answer!: () => void
    d.server.opts.hang = '/api/auth/logout'
    d.server.opts.gate = new Promise<void>((r) => (answer = r))
    const first = d.account.signOut()
    await new Promise((r) => setTimeout(r, 0))
    expect(value(await d.account.status()).signedIn).toBe(true)
    const second = d.account.signOut()
    await new Promise((r) => setTimeout(r, 0))
    expect(value(await d.account.status()).signedIn).toBe(true)
    answer()
    // the server revoked it, but the file still holds it: both report the session still here (#95)
    expect(await first).toEqual({ ok: false, error: R.TEXT.signOutFailed, code: 'sign-out-failed' })
    expect(await second).toEqual({ ok: false, error: R.TEXT.signOutFailed, code: 'sign-out-failed' })
    // online, /me answers 401 for the revoked token
    expect(value(await d.account.status()).signedIn).toBe(false)
    expect(value(await restart(d).status()).signedIn).toBe(false)
  })

  // SANO-AGENT#95 (sanovids #44 review): a session a restart can still reopen, offline, is never reported signed out or cancelled
  const failed = { ok: false, error: R.TEXT.signOutFailed, code: 'sign-out-failed' }
  it('#95: nothing can be deleted, emptied or marked, the server revokes the token: still sign-out-failed (an offline restart reopens it)', async () => {
    const t = setup()
    value(await t.account.login({ identifier: 'minh', password: t.server.password }))
    lock(t.m, ['rm', 'writeFile'])
    expect(await t.account.signOut()).toEqual(failed)
    expect(t.server.sessions.size).toBe(0) // logout still sent and waited on
    t.server.opts.offline = true
    expect(value(await restart(t).status())).toMatchObject({ signedIn: true, offline: true })
  })

  it('#95: a marker that cannot be read (EACCES) counts as there: no restart reopens the session, offline included', async () => {
    const t = setup()
    value(await t.account.login({ identifier: 'minh', password: t.server.password }))
    lock(t.m, ['rm', 'writeFile'], [FILE])
    expect(value(await t.account.signOut()).signedIn).toBe(false)
    expect(t.m.files.has(MARK)).toBe(true)
    const { readFile } = t.m.fs
    t.m.fs.readFile = async (p: string) => {
      if (p === MARK) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return readFile(p)
    }
    t.server.opts.offline = true
    expect(value(await restart(t).status()).signedIn).toBe(false)
  })

  it.each(['writeFile', 'rename'] as const)('#95: Huỷ Google during %s, then nothing can be cleaned up and logout is offline: sign-out-failed, not cancelled; a later sign-out retries', async (step) => {
    const t = setup()
    const original = t.m.fs[step] as (a: string, b: never) => Promise<void>
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let reached!: () => void
    const at = new Promise<void>((r) => (reached = r))
    t.m.fs[step] = (async (a: string, b: never) => {
      reached()
      await gate
      return original(a, b)
    }) as never
    const g = t.account.google()
    await at
    value(await t.account.cancelGoogle())
    // the write lands; then the file cannot be deleted or emptied and no marker can be written beside it
    const unlock = lock(t.m, ['rm'], [FILE])
    lock(t.m, ['writeFile'], [FILE, MARK])
    t.server.opts.offline = true
    release()
    expect(await g).toEqual(failed)
    expect(value(await t.account.status())).toMatchObject({ signedIn: true, offline: true })
    expect(value(await restart(t).status())).toMatchObject({ signedIn: true, offline: true })
    // the lock gone and back online, signing out ends it here and on the server
    unlock()
    t.server.opts.offline = false
    expect(value(await t.account.signOut()).signedIn).toBe(false)
    expect(t.m.files.has(FILE)).toBe(false)
    t.server.opts.offline = true
    expect(value(await restart(t).status()).signedIn).toBe(false)
  })

  it('a sign-out while a sign-in is still writing the session file: the token never lands on disk afterwards', async () => {
    const t = setup()
    const { rename } = t.m.fs
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let reached!: () => void
    const atRename = new Promise<void>((r) => (reached = r))
    t.m.fs.rename = async (a: string, b: string) => {
      reached()
      await gate
      return rename(a, b)
    }
    const login = t.account.login({ identifier: 'minh', password: t.server.password })
    await atRename
    t.server.opts.offline = true
    const out = t.account.signOut() // signed out in memory now; its delete waits for that write
    await new Promise((r) => setTimeout(r, 0))
    expect(value(await t.account.status()).signedIn).toBe(false)
    release()
    expect(value(await out).signedIn).toBe(false)
    await login
    expect(t.m.files.size).toBe(0)
    expect(value(await setup({ server: t.server, m: t.m }).account.status()).signedIn).toBe(false)
  })

  it('a sign-in that finishes after a sign-out is dropped', async () => {
    const t = setup()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetch = t.server.fetch
    const slow = R.createAccount({
      apiUrl: API,
      fetch: async (url: string, init: RequestInit) => {
        if (url.endsWith('/api/auth/token')) await gate
        return fetch(url, init)
      },
      file: FILE,
      fs: t.m.fs,
      safeStorage: t.m.safeStorage,
      now: () => NOW,
      random: (n: number) => new Uint8Array(n).fill(3),
      google: fakeGoogle(),
      log: () => undefined,
    })
    const login = slow.login({ identifier: 'minh', password: t.server.password })
    await new Promise((r) => setTimeout(r, 0))
    value(await slow.signOut())
    release()
    expect(value(await login).signedIn).toBe(false)
    expect(t.m.files.size).toBe(0)
    await new Promise((r) => setTimeout(r, 0))
    expect(t.server.sessions.size).toBe(0) // the dropped session was ended on the server too
    expect(value(await slow.status()).signedIn).toBe(false)
  })

  it("Google: #18's browser sign-in gives the ID token, POST google → code → session; Google's tokens are dropped", async () => {
    const { account, server, google } = setup()
    expect(value(await account.google())).toEqual({ configured: true, signedIn: true, user: server.user, persistent: true })
    expect(server.calls.map((c) => c.path)).toEqual(['/api/auth/google', '/api/auth/token'])
    expect(server.calls[0].body).toMatchObject({ credential: 'google-id-token', client: 'desktop', redirect_uri: R.REDIRECT_URI, state: expect.any(String), code_challenge: expect.any(String) })
    expect([google.signIns, google.signOuts]).toEqual([1, 1])
  })

  it('Google: cancel → "Đã huỷ đăng nhập Google."; #18 failures keep their message; a refused token passes through', async () => {
    const waiting = setup({ google: fakeGoogle(() => new Promise(() => undefined)) })
    const g = waiting.account.google()
    await new Promise((r) => setTimeout(r, 0))
    value(await waiting.account.cancelGoogle())
    expect(await g).toEqual({ ok: false, error: 'Đã huỷ đăng nhập Google.', code: 'cancelled' })
    expect(waiting.server.calls).toEqual([])
    const timeout = setup({ google: fakeGoogle(async () => ({ ok: false, code: 'timeout', message: 'Hết 5 phút chờ đăng nhập. Hãy thử lại.' })) })
    expect(await timeout.account.google()).toEqual({ ok: false, error: 'Hết 5 phút chờ đăng nhập. Hãy thử lại.', code: 'timeout' })
    const refused = setup({ google: fakeGoogle(async () => ({ ok: true, idToken: 'other' })) })
    expect(await refused.account.google()).toEqual({ ok: false, error: 'Đăng nhập Google không hợp lệ.' })
    expect(refused.m.files.size).toBe(0)
  })

  it('Google: Huỷ after the browser answered, while the server exchange runs: cancelled, nothing kept, the session ended', async () => {
    const t = setup()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetch = t.server.fetch
    const slow = R.createAccount({
      apiUrl: API,
      fetch: async (url: string, init: RequestInit) => {
        if (url.endsWith('/api/auth/token')) await gate
        return fetch(url, init)
      },
      file: FILE,
      fs: t.m.fs,
      safeStorage: t.m.safeStorage,
      now: () => NOW,
      random: (n: number) => new Uint8Array(n).fill(5),
      google: fakeGoogle(),
      log: () => undefined,
    })
    const g = slow.google()
    await new Promise((r) => setTimeout(r, 0))
    value(await slow.cancelGoogle())
    release()
    expect(await g).toEqual({ ok: false, error: 'Đã huỷ đăng nhập Google.', code: 'cancelled' })
    expect(t.m.files.size).toBe(0)
    await new Promise((r) => setTimeout(r, 0))
    expect(t.server.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/auth/logout', auth: expect.stringMatching(/^Bearer sano_/) })
    expect(t.server.sessions.size).toBe(0)
    expect(value(await slow.status()).signedIn).toBe(false)
    // the next Google sign-in is not cancelled by the old Huỷ
    expect(value(await slow.google()).signedIn).toBe(true)
  })

  it('Google: Huỷ while the new session is being written (write or rename): cancelled, nothing kept, the session ended', async () => {
    for (const step of ['writeFile', 'rename'] as const) {
      const t = setup()
      const original = t.m.fs[step] as (a: string, b: never) => Promise<void>
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let reached!: () => void
      const at = new Promise<void>((r) => (reached = r))
      t.m.fs[step] = (async (a: string, b: never) => {
        reached()
        await gate
        return original(a, b)
      }) as never
      const g = t.account.google()
      await at
      value(await t.account.cancelGoogle())
      release()
      expect(await g, step).toEqual({ ok: false, error: R.TEXT.googleCancelled, code: 'cancelled' })
      t.m.fs[step] = original as never
      expect(t.m.files.size, step).toBe(0)
      expect(value(await t.account.status()).signedIn, step).toBe(false)
      expect(value(await setup({ server: t.server, m: t.m }).account.status()).signedIn, step).toBe(false)
      await new Promise((r) => setTimeout(r, 0))
      expect(t.server.sessions.size, step).toBe(0)
    }
  })

  it('Google: a second sign-in replaces one still waiting on the browser; the replaced one never cancels it', async () => {
    // createGoogleSignIn's contract: one sign-in at a time, a newer one ends the waiting one 'superseded', signOut the current one 'cancelled'
    let current: ((r: GoogleResult) => void) | null = null
    const google = {
      signIn: () =>
        new Promise<GoogleResult>((resolve) => {
          current?.({ ok: false, code: 'superseded', message: 'Một lượt đăng nhập mới đã bắt đầu.' })
          current = resolve
        }),
      signOut: () => {
        current?.({ ok: false, code: 'cancelled', message: 'Bạn đã hủy đăng nhập.' })
        current = null
        return true
      },
    }
    const { account, server } = setup({ google: google as never })
    const first = account.google()
    await new Promise((r) => setTimeout(r, 0))
    const second = account.google()
    expect(await first).toEqual({ ok: false, error: 'Một lượt đăng nhập mới đã bắt đầu.', code: 'superseded' })
    current!({ ok: true, idToken: 'google-id-token' }) // the browser answers the second
    expect(value(await second)).toMatchObject({ signedIn: true, user: server.user })
  })

  it("the chat's Google session ends with the SANO session: sign-out, /me 401, expiry, a damaged file, another user", async () => {
    // main's chat Google (#18's sanoDesktop.google): holds a token for whoever signed it in last
    const chat = () => {
      const c = { token: null as string | null, ends: 0 }
      return Object.assign(c, { onSessionEnd: () => void ((c.token = null), c.ends++) })
    }
    const signIn = async (a: ReturnType<typeof setup>, c: ReturnType<typeof chat>, id: string) => {
      Object.assign(a.server.user, { id, username: 'minh' })
      value(await a.account.login({ identifier: 'minh', password: a.server.password }))
      c.token = `google-of-${id}` // the user signs the chat in after the account
    }
    // A signs out: ended (also with nothing held, also when the sign-out itself fails)
    let c = chat()
    let a = setup({ onSessionEnd: c.onSessionEnd })
    await signIn(a, c, 'u-a')
    value(await a.account.signOut())
    expect(c.token).toBeNull()
    c.token = 'stale'
    value(await a.account.signOut())
    expect(c.token).toBeNull()
    // /me 401 (revoked elsewhere): A's session dropped → ended
    c = chat()
    a = setup({ onSessionEnd: c.onSessionEnd })
    await signIn(a, c, 'u-a')
    a.server.sessions.clear()
    expect(value(await a.account.status()).signedIn).toBe(false)
    expect(c.token).toBeNull()
    // expired by expiresAt at the next start: ended; B then signs in (no sign-out between) → ended again before B's chat
    const server = fakeServer()
    const m = machine()
    c = chat()
    await signIn(setup({ server, m, onSessionEnd: c.onSessionEnd }), c, 'u-a')
    c = chat()
    c.token = 'google-of-u-a' // shortcut: stands for a chat token surviving into this run, as main's memory would within one
    const later = setup({ server, m, now: NOW + 31 * 86_400_000, onSessionEnd: c.onSessionEnd })
    expect(value(await later.account.status()).signedIn).toBe(false)
    expect(c.token).toBeNull()
    // B signs in while A's expired session is still held (status never asked): switching users ends A's chat
    c = chat()
    const m2 = machine()
    await signIn(setup({ server, m: m2, onSessionEnd: c.onSessionEnd }), c, 'u-a')
    const restart = setup({ server, m: m2, now: NOW + 31 * 86_400_000, onSessionEnd: c.onSessionEnd })
    c.ends = 0
    await signIn(restart, c, 'u-b')
    expect(c.ends).toBeGreaterThan(0)
    // …but the same user signing in again (B after B) keeps the chat signed in
    c.ends = 0
    expect(value(await restart.account.login({ identifier: 'minh', password: server.password })).user?.id).toBe('u-b')
    expect(c).toMatchObject({ token: 'google-of-u-b', ends: 0 })
    // a damaged (or another computer's) file: ended
    c = chat()
    const m3 = machine()
    m3.files.set(FILE, Buffer.from('garbage'))
    c.token = 'stale'
    expect(value(await setup({ m: m3, onSessionEnd: c.onSessionEnd }).account.status()).signedIn).toBe(false)
    expect(c.token).toBeNull()
  })

  it('a chat sign-out that throws (or rejects) never blocks or fails an account call', async () => {
    for (const onSessionEnd of [
      () => {
        throw new Error('boom')
      },
      () => Promise.reject(new Error('boom')),
    ]) {
      const { account, server, m } = setup({ onSessionEnd })
      expect(value(await account.login({ identifier: 'minh', password: server.password })).signedIn).toBe(true)
      server.sessions.clear()
      expect(value(await account.status()).signedIn).toBe(false)
      value(await account.login({ identifier: 'minh', password: server.password }))
      expect(value(await account.signOut()).signedIn).toBe(false)
      expect(m.files.size).toBe(0)
    }
    await Promise.resolve()
    expect(logs).toContain('[SanoVids] account: chat sign-out failed')
  })

  it('bearer(): null unconfigured / signed out / expired (expired clears, onSessionEnd runs); token otherwise', async () => {
    expect(await setup({ apiUrl: null }).account.bearer()).toBeNull()
    const { account, server, m } = setup()
    expect(await account.bearer()).toBeNull()
    value(await account.login({ identifier: 'minh', password: server.password }))
    const tok = server.secrets.filter((x) => x.startsWith('sano_')).at(-1)
    const n = server.calls.length
    expect(await account.bearer()).toBe(tok)
    expect(await setup({ server, m }).account.bearer()).toBe(tok) // a restart reads the file
    expect(server.calls.length).toBe(n) // no /me: the forwarded call's own answer decides
    let ends = 0
    const later = setup({ server, m, now: NOW + 31 * 86_400_000, onSessionEnd: () => void ends++ })
    expect(await later.account.bearer()).toBeNull()
    expect([ends, m.files.size, server.calls.length]).toEqual([1, 0, n + 1]) // one /me: no later expiresAt
    expect(value(await later.account.status()).signedIn).toBe(false)
    // an unexpected error (a broken clock): null, logged by name only
    value(await account.login({ identifier: 'minh', password: server.password }))
    const broken = R.createAccount({ apiUrl: API, fetch: server.fetch, file: FILE, fs: m.fs, safeStorage: m.safeStorage, now: () => { throw new RangeError('clock') }, random: () => new Uint8Array(32), google: fakeGoogle(), log: (line: string) => void logs.push(line) })
    expect(await broken.bearer()).toBeNull()
    expect(logs).toContain('[SanoVids] account: unexpected RangeError')
  })

  it("onSessionEnd's reason: 'forbidden' for a /me 403 (the account turned off); none for a 401, expiry or sign-out", async () => {
    const reasons: unknown[] = []
    const { account, server } = setup({ onSessionEnd: (reason) => void reasons.push(reason) })
    value(await account.login({ identifier: 'minh', password: server.password }))
    reasons.length = 0 // the first sign-in of the run ends whoever was before
    server.opts.meStatus = 403
    expect(value(await account.status()).signedIn).toBe(false)
    expect(reasons).toEqual(['forbidden'])
    delete server.opts.meStatus
    value(await account.login({ identifier: 'minh', password: server.password }))
    server.sessions.clear()
    expect(value(await account.status()).signedIn).toBe(false)
    value(await account.login({ identifier: 'minh', password: server.password }))
    value(await account.signOut())
    expect(reasons.length).toBeGreaterThan(1)
    expect(reasons.slice(1).every((r) => r === undefined)).toBe(true)
  })

  it('status(): a later expiresAt from /me (a desktop session slid on use) is saved with the session; an earlier or bad one is not', async () => {
    const { account, server, m } = setup()
    value(await account.login({ identifier: 'minh', password: server.password }))
    const saved = () => JSON.parse(Buffer.from(m.files.get(FILE)!.toString().slice(3), 'base64').toString()) as { expiresAt: string; token: string }
    const first = saved()
    for (const bad of [new Date(NOW + 10 * 86_400_000).toISOString(), 'not a date', first.expiresAt]) {
      server.opts.meExpiresAt = bad
      expect(value(await account.status()).signedIn).toBe(true)
      expect(saved()).toEqual(first)
    }
    const later = new Date(NOW + 40 * 86_400_000).toISOString()
    server.opts.meExpiresAt = later
    expect(value(await account.status()).signedIn).toBe(true)
    expect(saved()).toEqual({ ...first, expiresAt: later })
    // 35 days after sign-in, past the first 30: still signed in at the next start
    delete server.opts.meExpiresAt
    expect(value(await setup({ server, m, now: NOW + 35 * 86_400_000 }).account.status()).signedIn).toBe(true)
  })

  it('past the saved expiresAt, the app left open: bearer() / status() ask /me; a slid session goes on (saved), 401 / offline end it', async () => {
    const server = fakeServer()
    const m = machine()
    value(await setup({ server, m }).account.login({ identifier: 'minh', password: server.password }))
    const tok = server.secrets.filter((x) => x.startsWith('sano_')).at(-1)
    const saved = () => JSON.parse(Buffer.from(m.files.get(FILE)!.toString().slice(3), 'base64').toString()) as { expiresAt: string }
    const slidTo = new Date(NOW + 60 * 86_400_000).toISOString()
    server.opts.meExpiresAt = slidTo
    let ends = 0
    const later = setup({ server, m, now: NOW + 31 * 86_400_000, onSessionEnd: () => void ends++ })
    const n = server.calls.length
    expect(await later.account.bearer()).toBe(tok)
    expect([ends, saved().expiresAt, server.calls.length]).toEqual([0, slidTo, n + 1])
    expect(await later.account.bearer()).toBe(tok) // the later expiresAt is held: no second /me
    expect(server.calls.length).toBe(n + 1)
    expect(value(await setup({ server, m, now: NOW + 31 * 86_400_000 }).account.status()).signedIn).toBe(true)
    // revoked on the server meanwhile: ended at the next expiry
    for (const end of [() => server.sessions.clear(), () => void (server.opts.offline = true)]) {
      const mm = machine()
      delete server.opts.offline
      value(await setup({ server, m: mm }).account.login({ identifier: 'minh', password: server.password }))
      end()
      expect(await setup({ server, m: mm, now: NOW + 31 * 86_400_000 }).account.bearer()).toBeNull()
      expect(mm.files.size).toBe(0)
    }
    delete server.opts.offline
  })

  it("a renewal (/me past the saved expiresAt) that outlives its session answers null, never the next account's token", async () => {
    for (const next of ['another user', 'signed out'] as const) {
      const server = fakeServer()
      const m = machine()
      value(await setup({ server, m }).account.login({ identifier: 'minh', password: server.password }))
      server.opts.meExpiresAt = new Date(NOW + 60 * 86_400_000).toISOString() // A's session slid on the server
      const later = setup({ server, m, now: NOW + 31 * 86_400_000 })
      let answer!: () => void
      server.opts.hang = '/api/auth/me'
      server.opts.gate = new Promise<void>((r) => (answer = r))
      const renewing = later.account.bearer() // the forward of a request A started
      await new Promise((r) => setTimeout(r, 0))
      if (next === 'another user') {
        Object.assign(server.user, { id: 'u-b', name: 'B' })
        value(await later.account.login({ identifier: 'minh', password: server.password }))
      } else value(await later.account.signOut())
      answer()
      expect(await renewing, next).toBeNull()
      expect(later.account.userId(), next).toBe(next === 'another user' ? 'u-b' : null)
    }
  })

  it('renewals of one session at the same time (two forwards, or status() and a forward) all get its token; the file keeps it', async () => {
    const pairs = { 'bearer + bearer': (a: Account) => [a.bearer(), a.bearer()], 'status + bearer': (a: Account) => [a.status().then((s) => value(s).signedIn), a.bearer()] }
    for (const [name, pair] of Object.entries(pairs)) {
      const server = fakeServer()
      const m = machine()
      value(await setup({ server, m }).account.login({ identifier: 'minh', password: server.password }))
      const tok = server.secrets.filter((x) => x.startsWith('sano_')).at(-1)
      const slidTo = new Date(NOW + 60 * 86_400_000).toISOString()
      server.opts.meExpiresAt = slidTo
      const later = setup({ server, m, now: NOW + 31 * 86_400_000 })
      let answer!: () => void
      server.opts.hang = '/api/auth/me'
      server.opts.gate = new Promise<void>((r) => (answer = r))
      const both = Promise.all(pair(later.account))
      await new Promise((r) => setTimeout(r, 0))
      answer() // both /me answer together, past the saved expiresAt
      const [a, b] = await both
      expect([a === (name === 'bearer + bearer' ? tok : true), b === tok], name).toEqual([true, true]) // compared, never printed
      const saved = JSON.parse(Buffer.from(m.files.get(FILE)!.toString().slice(3), 'base64').toString()) as { token: string; expiresAt: string }
      expect([saved.token === tok, saved.expiresAt], name).toEqual([true, slidTo]) // a restart stays signed in
    }
  })

  it('a renewed copy of the session saved while a renewal is still writing (status() sliding it again): the file is kept', async () => {
    const server = fakeServer()
    const m = machine()
    value(await setup({ server, m }).account.login({ identifier: 'minh', password: server.password }))
    const tok = server.secrets.filter((x) => x.startsWith('sano_')).at(-1)
    server.opts.meExpiresAt = new Date(NOW + 60 * 86_400_000).toISOString()
    const later = setup({ server, m, now: NOW + 31 * 86_400_000 })
    const write = m.fs.writeFile
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    m.fs.writeFile = async (p, b) => {
      m.fs.writeFile = write // only the renewal's write waits
      await gate
      return write(p, b)
    }
    const renewing = later.account.bearer()
    await new Promise((r) => setTimeout(r, 0)) // its write is waiting
    server.opts.meExpiresAt = new Date(NOW + 61 * 86_400_000).toISOString()
    const checked = later.account.status() // saves a renewed copy meanwhile: its write waits for the renewal's
    await new Promise((r) => setTimeout(r, 0))
    release()
    expect(value(await checked).signedIn).toBe(true)
    expect((await renewing) === tok).toBe(true)
    const saved = JSON.parse(Buffer.from(m.files.get(FILE)?.toString().slice(3) ?? '', 'base64').toString() || 'null') as { token: string } | null
    expect(saved?.token === tok).toBe(true) // a restart stays signed in
  })

  it("an account switch (sign-out, then B signs in) while a renewal of A is inside save(): null for A's request, never B's token; B's file kept", async () => {
    const server = fakeServer()
    const m = machine()
    value(await setup({ server, m }).account.login({ identifier: 'minh', password: server.password }))
    const tokA = server.secrets.filter((x) => x.startsWith('sano_')).at(-1)
    server.opts.meExpiresAt = new Date(NOW + 60 * 86_400_000).toISOString() // A's session slid on the server
    const later = setup({ server, m, now: NOW + 31 * 86_400_000 })
    const write = m.fs.writeFile
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let reached!: () => void
    const inSave = new Promise<void>((r) => (reached = r))
    m.fs.writeFile = async (p, b) => {
      m.fs.writeFile = write // only the renewal's write waits
      reached()
      await gate
      return write(p, b)
    }
    const renewing = later.account.bearer() // the forward of a request A started
    await inSave // /me answered: save(n) is writing A's renewed session
    const out = later.account.signOut() // its delete waits for that write
    Object.assign(server.user, { id: 'u-b', name: 'B' })
    const signIn = later.account.login({ identifier: 'minh', password: server.password })
    while (later.account.userId() !== 'u-b') await new Promise((r) => setTimeout(r, 0)) // B held, A's write still waiting
    release()
    value(await out)
    value(await signIn)
    const tokB = server.secrets.filter((x) => x.startsWith('sano_')).at(-1)
    const used = await renewing
    expect([used === null, used === tokB]).toEqual([true, false]) // compared, never printed
    expect(later.account.userId()).toBe('u-b') // the renewal never ends B's session
    const raw = m.files.get(FILE)?.toString().slice(3)
    const saved = raw ? (JSON.parse(Buffer.from(raw, 'base64').toString()) as { token: string }) : null
    expect([saved?.token === tokA, saved?.token === tokB]).toEqual([false, true]) // A's signed-out token never stays on disk; B's does
    const restart = setup({ server, m }).account
    expect([(await restart.bearer()) === tokB, restart.userId()]).toEqual([true, 'u-b']) // a restart stays signed in as B
  })

  it('userId(): the held user only (main-only, for the docs Google owner); null signed out', async () => {
    const { account, server, m } = setup()
    expect(account.userId()).toBeNull()
    value(await account.login({ identifier: 'minh', password: server.password }))
    expect(account.userId()).toBe(server.user.id)
    const restart = setup({ server, m })
    expect(restart.account.userId()).toBeNull() // the file is read on first use
    await restart.account.bearer()
    expect(restart.account.userId()).toBe(server.user.id)
    value(await account.signOut())
    expect(account.userId()).toBeNull()
  })

  it('ended(token): clears only that session + onSessionEnd; a newer session survives', async () => {
    let ends = 0
    const { account, server, m } = setup({ onSessionEnd: () => void ends++ })
    value(await account.login({ identifier: 'minh', password: server.password }))
    const old = (await account.bearer())!
    value(await account.login({ identifier: 'minh', password: server.password })) // the same user again: a newer session
    const tok = (await account.bearer())!
    expect(tok).not.toBe(old)
    ends = 0
    await account.ended(old) // a late 401 for the old token
    expect([await account.bearer(), ends, m.files.size]).toEqual([tok, 0, 1])
    await account.ended(tok)
    expect([await account.bearer(), ends, m.files.size]).toEqual([null, 1, 0])
    expect(value(await account.status()).signedIn).toBe(false)
    await account.ended(tok) // twice: nothing more
    expect(ends).toBe(1)
  })

  it("ended(token, 'forbidden') (the forward's 403 not-provisioned): onSessionEnd('forbidden'); a 401's ended(token) passes none", async () => {
    const reasons: unknown[] = []
    const { account, server } = setup({ onSessionEnd: (reason) => void reasons.push(reason) })
    value(await account.login({ identifier: 'minh', password: server.password }))
    reasons.length = 0
    await account.ended((await account.bearer())!, 'forbidden')
    value(await account.login({ identifier: 'minh', password: server.password }))
    await account.ended((await account.bearer())!)
    expect(reasons).toEqual(['forbidden', undefined])
  })

  it('logs: never a password, token, code or verifier', async () => {
    const { account, server } = setup()
    await account.login({ identifier: 'minh', password: server.password })
    await account.status()
    server.opts.offline = true
    await account.status()
    await account.login({ identifier: 'minh', password: server.password })
    await account.signOut()
    expect(logs.length).toBeGreaterThan(0)
    for (const line of logs) for (const s of server.secrets) expect(line).not.toContain(s)
  })
})

describe('IPC: every account:* call checks the sender (fromSano), and the preload turns { ok: false } into an Error', () => {
  it('registerAccountIpc: all seven calls; a refused sender never reaches the account', async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
    const reached: string[] = []
    const account = Object.fromEntries(R.CALLS.map((c) => [c, async (input: unknown) => (reached.push(c), { ok: true, value: input })])) as unknown as Account
    R.registerAccountIpc({ handle: (ch, fn) => void handlers.set(ch, fn) }, account, (event) => event === 'sano')
    expect([...handlers.keys()]).toEqual(['account:status', 'account:login', 'account:register', 'account:forgot', 'account:google', 'account:cancelGoogle', 'account:signOut'])
    for (const [ch, fn] of handlers) expect(await fn('frame', { x: 1 }), ch).toEqual({ ok: false, error: 'Nguồn gọi không hợp lệ.', code: 'not-allowed' })
    expect(reached).toEqual([])
    expect(await handlers.get('account:login')!('sano', { identifier: 'a' })).toEqual({ ok: true, value: { identifier: 'a' } })
  })

  it('CALLS unchanged: bearer/ended/userId not registered over IPC', () => {
    expect(R.CALLS).toEqual(['status', 'login', 'register', 'forgot', 'google', 'cancelGoogle', 'signOut'])
    const { account } = setup()
    expect(Object.keys(account)).toEqual([...R.CALLS, 'bearer', 'ended', 'userId'])
    const channels: string[] = []
    R.registerAccountIpc({ handle: (ch) => void channels.push(ch) }, account, () => true)
    expect(channels).toEqual(R.CALLS.map((c) => `account:${c}`))
  })

  it('main: SANO mode only, fromSano on every call, Node fetch (no Origin), the profile file, the env / baked server', () => {
    expect(mainSource).toContain('\n    if (SANO) registerAccount()\n')
    const body = mainSource.slice(mainSource.indexOf('function registerAccount() {'), mainSource.indexOf('async function sanoDesktopClientId()'))
    expect(body).toContain('accountRules.registerAccountIpc(ipcMain, account, fromSano)')
    expect(body).toContain('fetch: (url, init) => fetch(url, init),')
    expect(body).not.toContain('net.fetch')
    expect(body).toContain("file: path.join(profile.dir, 'sano-account.bin'),")
    expect(body).toContain('google: newGoogleSignIn(),')
    // the chat's Google (registerGoogleSignIn's instance, not the account's own) and the docs windows end with the SANO session
    // (the docs' kept Google sign-in is wiped only when the account was turned off)
    expect(body).toMatch(/onSessionEnd: \(reason\) => \{\s+chatGoogle && chatGoogle\.signOut\(\)\s+if \(sanoDocs\) void sanoDocs\.endSession\(\{ wipe: reason === 'forbidden' \}\)\s+\},/)
    // main-only bearer() / ended(): the module-scope account feeds the forward and the docs windows, never IPC
    expect(body).toContain('const account = (sanoAccount = accountRules.createAccount({')
    expect(body).toContain('signedIn: async () => !!(sanoAccount && (await sanoAccount.bearer())),')
    expect(body).toContain('clearPartition: () => ses.clearStorageData().then(() => ses.clearCache()),')
    // the docs partition's rules are set at registration, before any window (not on the first clear)
    const docs = body.slice(body.indexOf('function registerDocs() {'))
    const at = (s: string) => docs.indexOf(s)
    for (const s of ['ses.setPermissionRequestHandler(', 'ses.setPermissionCheckHandler(', 'ses.setDevicePermissionHandler(() => false)', "ses.on('will-download'"]) {
      expect(at(s), s).toBeGreaterThan(at('const ses = session.fromPartition(docsRules.PARTITION)'))
      expect(at(s), s).toBeLessThan(at('sanoDocs = docsRules.createDocs({'))
    }
    expect(docs).not.toContain('const partition = ')
    // Google's kept sign-in of the docs windows: bound to the server and the SANO user (a hash, never the id itself)
    expect(docs).toContain("file: path.join(profile.dir, 'google-docs.bin'),")
    expect(docs).toContain('cookies: ses.cookies,')
    expect(docs).toContain("return id ? crypto.createHash('sha256').update(`${SANO_API}\\n${id}`).digest('hex') : null")
    expect(docs).toContain('saveGoogle: () => capped(googleKeepDocs.save()).then(() => googleKeepDocs.detach()),')
    expect(docs).toContain('wipeGoogle: () => capped(googleKeepDocs.wipe()).then(() => googleKeepDocs.detach()),')
    expect(docs).toContain('const capped = (p) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, GOOGLE_SAVE_CAP_MS))])')
    expect(mainSource).toContain('  const google = (chatGoogle = newGoogleSignIn())\n')
    expect(mainSource).toContain('\n    if (SANO) registerGoogleSignIn()\n')
    expect(body).toContain("safeStorage.getSelectedStorageBackend() === 'basic_text'") // Linux plain text: memory only
    expect(mainSource.split("ipcMain.handle('account:").length - 1).toBe(0) // only through registerAccountIpc
    expect(mainSource).toContain("const SANO_API_RAW = PACKAGED ? readBakedSanoAgent('apiUrl') : process.env.SANO_API_URL")
    expect(mainSource).toContain('const SANO_API = SANO ? accountRules.accountApiUrl(SANO_API_RAW) : null')
    const from = mainSource.slice(mainSource.indexOf('function fromSano(event) {'), mainSource.indexOf('/** A Google sign-in of its own'))
    expect(from).toContain('event.senderFrame === win.webContents.mainFrame && event.senderFrame.origin === SANO.origin')
  })

  it('the opt-in desktop probe: a fresh profile folder of its own (SANO_PROBE_PROFILE only names its parent), nothing deleted', () => {
    expect(probeSource).toContain("const PROFILE = fs.mkdtempSync(path.join(process.env.SANO_PROBE_PROFILE || os.tmpdir(), 'sanovids-sano-probe-'))")
    expect(probeSource).not.toMatch(/\brmSync\(|\.rm\(/)
  })

  it('preload: SANO top frame only; inputs cut one past the limit; { ok: false } → Error(message) with code', async () => {
    const invoked: [string, unknown][] = []
    let answer: unknown = { ok: true, value: { signedIn: false } }
    type Bridge = Record<string, (i?: unknown) => Promise<unknown>>
    let exposed: Record<string, { account: Bridge; docs?: Bridge; apiForward?: true }> = {}
    const electron = {
      contextBridge: { exposeInMainWorld: (key: string, api: never) => void (exposed[key] = api), executeInMainWorld: ({ func, args }: { func: (...a: unknown[]) => unknown; args: unknown[] }) => new Function(`return (${func})`)()(...args) },
      ipcRenderer: { invoke: async (ch: string, input: unknown) => (invoked.push([ch, input]), answer), on: () => undefined, removeListener: () => undefined },
    }
    const run = (isMainFrame: boolean, forward = false) => {
      exposed = {}
      const proc = { argv: ['--bdp-version=1.0.0', '--bdp-sano-origin=app://sano', ...(forward ? ['--bdp-sano-api-forward'] : [])], versions: { electron: '44.0.0' }, platform: 'win32', isMainFrame }
      new Function('require', 'process', 'location', 'window', preloadSource)(() => electron, proc, { origin: 'app://sano' }, { addEventListener: () => undefined })
    }
    // step 4: apiForward and docs only for SANO's top frame with main's --bdp-sano-api-forward
    run(false, true)
    expect(exposed.sanoDesktop).toBeUndefined()
    run(true, true)
    expect(Object.keys(exposed.sanoDesktop)).toEqual(['sanovidsUrl', 'google', 'account', 'apiForward', 'docs'])
    expect(exposed.sanoDesktop.apiForward).toBe(true)
    const docs = exposed.sanoDesktop.docs!
    expect(Object.keys(docs)).toEqual(['open', 'closeAll'])
    answer = { ok: true, value: undefined }
    expect(await docs.open({ id: 'i'.repeat(300), kind: 'k'.repeat(20), extra: 'dropped' })).toBeUndefined()
    expect(invoked.at(-1)).toEqual(['docs:open', { id: 'i'.repeat(201), kind: 'k'.repeat(10) }])
    await docs.open(null)
    expect(invoked.at(-1)).toEqual(['docs:open', { id: '', kind: '' }])
    answer = { ok: true, value: false }
    expect(await docs.closeAll()).toBe(false)
    expect(invoked.at(-1)).toEqual(['docs:closeAll', undefined])
    answer = { ok: false, error: 'Đang mở quá nhiều tài liệu. Đóng bớt rồi thử lại.', code: 'too-many' }
    const d = (await docs.open({ id: 'x', kind: 'docs' }).catch((x) => x)) as Error & { code?: string }
    expect([d instanceof Error, d.message, d.code]).toEqual([true, 'Đang mở quá nhiều tài liệu. Đóng bớt rồi thử lại.', 'too-many'])
    answer = null
    await expect(docs.open({ id: 'x', kind: 'docs' })).rejects.toThrow('Chưa mở được tài liệu.')
    run(false)
    expect(exposed.sanoDesktop).toBeUndefined()
    run(true)
    expect(Object.keys(exposed.sanoDesktop)).toEqual(['sanovidsUrl', 'google', 'account'])
    answer = { ok: true, value: { signedIn: false } }
    const a = exposed.sanoDesktop.account
    expect(Object.keys(a)).toEqual(['status', 'login', 'register', 'forgot', 'google', 'cancelGoogle', 'signOut'])
    expect(await a.status()).toEqual({ signedIn: false })
    await a.login({ identifier: 'x'.repeat(400), password: 7, extra: 'dropped' })
    expect(invoked.at(-1)).toEqual(['account:login', { identifier: 'x'.repeat(255), password: '' }])
    await a.register({ email: 'e', username: 'u'.repeat(50), name: 'n', password: 'p' })
    expect(invoked.at(-1)).toEqual(['account:register', { email: 'e', username: 'u'.repeat(33), name: 'n', password: 'p' }])
    await a.forgot(null)
    expect(invoked.at(-1)).toEqual(['account:forgot', { identifier: '' }])
    answer = { ok: false, error: 'Sai tài khoản hoặc mật khẩu.', code: 'bad-password' }
    const e = (await a.login({ identifier: 'a', password: 'b' }).catch((x) => x)) as Error & { code?: string }
    expect(e).toBeInstanceOf(Error)
    expect([e.message, e.code]).toEqual(['Sai tài khoản hoặc mật khẩu.', 'bad-password'])
    answer = { ok: false, error: 'Đã huỷ đăng nhập Google.', code: 'cancelled' }
    await expect(a.google()).rejects.toThrow('Đã huỷ đăng nhập Google.')
  })
})

describe('Sano Agent build: SANO_API_URL baked at build time as sanoAgent.apiUrl', () => {
  /** The config as electron-builder loads it with this SANO_API_URL (a fresh require; env and cache restored). */
  const load = (env: string | undefined) => {
    const id = nodeRequire.resolve('../../../sano-agent/electron-builder.cjs')
    const before = process.env.SANO_API_URL
    if (env === undefined) delete process.env.SANO_API_URL
    else process.env.SANO_API_URL = env
    delete nodeRequire.cache[id]
    try {
      return (nodeRequire(id) as { extraMetadata: { sanoAgent: Record<string, string> } }).extraMetadata.sanoAgent
    } finally {
      if (before === undefined) delete process.env.SANO_API_URL
      else process.env.SANO_API_URL = before
      delete nodeRequire.cache[id]
    }
  }
  it('unset → 1.0 as shipped (no apiUrl); set → its origin; refused → no build', () => {
    expect(load(undefined)).toEqual({ url: 'app://sano/' })
    expect(load('https://sano.example.vn/')).toEqual({ url: 'app://sano/', apiUrl: 'https://sano.example.vn' })
    expect(load('http://127.0.0.1:8796')).toEqual({ url: 'app://sano/', apiUrl: 'http://127.0.0.1:8796' })
    expect(() => load('http://sano.example.vn')).toThrow(/SANO_API_URL must be/)
  })
})
