// SANO desktop "Đăng nhập bằng Google" (electron/google-signin-rules.cjs, TH-36): the pure rules, and the sign-in /
// token state machine run with node:http's real loopback server, a fake browser (openExternal answers the redirect
// itself) and a fake token endpoint. Never Google: every token request goes to the fake `fetch` below.
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Fail = { ok: false; code: string; message: string }
type SignInResult = { ok: true; idToken: string } | Fail
interface Fx {
  clientId(): Promise<string | null>
  secret?: string
  createServer: typeof createServer
  openExternal(url: string): unknown
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
  focus(): void
  now(): number
  timeoutMs?: number
}
interface Rules {
  AUTH_ENDPOINT: string
  TOKEN_ENDPOINT: string
  RENEW_BEFORE_MS: number
  PAGE_OK: string
  PAGE_FAILED: string
  codeChallenge(verifier: string): Promise<string>
  authUrl(o: { clientId: string; redirectUri: string; challenge: string; state: string }): string
  readCallback(reqUrl: unknown, state: string): { status?: number; code?: string; error?: string }
  readTokenResponse(json: unknown, refreshToken: string | null): { idToken: string; expiresAt: number; refreshToken: string | null } | null
  desktopClientId(status: unknown): string | null
  createGoogleSignIn(fx: Fx): { signIn(): Promise<SignInResult>; token(): Promise<string | null>; signOut(): boolean }
}
const R = createRequire(import.meta.url)('../../../electron/google-signin-rules.cjs') as Rules

const CLIENT = 'fake-desktop.apps.googleusercontent.com'
const b64url = (s: string) => Buffer.from(s).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(payload))}.sig`
const NOW = 1_800_000_000_000
const idToken = (expMs: number, sub = 'u1') => jwt({ sub, email: 'a@sanogroup.tv', exp: Math.floor(expMs / 1000) })

/** A fake token endpoint: answers queued per call (a function gets the form), records every form it got. */
function tokenEndpoint() {
  const forms: Record<string, string>[] = []
  const answers: (((form: Record<string, string>, signal?: AbortSignal) => unknown) | { status?: number; body?: unknown; throws?: boolean; bodyFails?: boolean })[] = []
  const fetch: Fx['fetch'] = async (url, init) => {
    expect(url).toBe(R.TOKEN_ENDPOINT)
    expect(init.method).toBe('POST')
    const form = Object.fromEntries(new URLSearchParams(init.body))
    forms.push(form)
    const next = answers.shift()
    const a = (typeof next === 'function' ? await next(form, init.signal) : next) as { status?: number; body?: unknown; throws?: boolean; bodyFails?: boolean } | undefined
    if (!a || a.throws) throw new Error('offline')
    const status = a.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => (a.bodyFails ? Promise.reject(new Error('body cut')) : a.body) }
  }
  return { forms, answers, fetch }
}

/** The sign-in with a fake browser: `opened` resolves with the authorization URL main opened. */
function setup(over: Partial<Fx> = {}) {
  const t = tokenEndpoint()
  let now = NOW
  let focused = 0
  const opened: string[] = []
  let onOpen: (u: string) => void = () => undefined
  const fx: Fx = {
    clientId: async () => CLIENT,
    createServer,
    openExternal: (u) => {
      opened.push(u)
      onOpen(u)
    },
    fetch: t.fetch,
    focus: () => void focused++,
    now: () => now,
    ...over,
  }
  const g = R.createGoogleSignIn(fx)
  const nextOpen = () => new Promise<URL>((resolve) => (onOpen = (u) => resolve(new URL(u))))
  return { g, t, opened, nextOpen, focused: () => focused, setNow: (n: number) => (now = n) }
}

/** The browser following Google's redirect to the loopback port. */
const visit = (auth: URL, query: string, init?: RequestInit) => fetch(`${auth.searchParams.get('redirect_uri')}${query}`, init)

describe('google-signin-rules: pure rules', () => {
  it('PKCE S256: the RFC 7636 appendix B vector', async () => {
    expect(await R.codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it("authorization URL: Google's fixed endpoint, loopback IP redirect, S256, state, openid email, offline — no secret", () => {
    const u = new URL(R.authUrl({ clientId: CLIENT, redirectUri: 'http://127.0.0.1:50123/', challenge: 'ch', state: 'st' }))
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: CLIENT,
      redirect_uri: 'http://127.0.0.1:50123/',
      response_type: 'code',
      scope: 'openid email',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      state: 'st',
      access_type: 'offline',
      prompt: 'select_account',
    })
  })

  it('callback: another path 404; missing / wrong state 400 (keep waiting); right state ends with code or error', () => {
    expect(R.readCallback('/favicon.ico', 'st')).toEqual({ status: 404 })
    expect(R.readCallback('/?code=c', 'st')).toEqual({ status: 400 })
    expect(R.readCallback('/?code=c&state=other', 'st')).toEqual({ status: 400 })
    expect(R.readCallback('http://[', 'st')).toEqual({ status: 400 })
    expect(R.readCallback('/?error=access_denied&state=st', 'st')).toEqual({ error: 'access_denied' })
    expect(R.readCallback('/?state=st', 'st')).toEqual({ error: 'no-code' })
    expect(R.readCallback('/?code=c&error=x&state=st', 'st')).toEqual({ error: 'x' })
    expect(R.readCallback('/?code=4%2Fabc&state=st', 'st')).toEqual({ code: '4/abc' })
  })

  it('token answer: an ID token with exp and sign-in scopes only; keeps the previous refresh token', () => {
    const id = idToken(NOW + 3600_000)
    expect(R.readTokenResponse({ id_token: id, refresh_token: 'r1', scope: 'openid https://www.googleapis.com/auth/userinfo.email' }, null)).toEqual({ idToken: id, expiresAt: Math.floor((NOW + 3600_000) / 1000) * 1000, refreshToken: 'r1' })
    expect(R.readTokenResponse({ id_token: id }, 'r0')!.refreshToken).toBe('r0')
    expect(R.readTokenResponse({ access_token: 'a' }, 'r0')).toBeNull()
    expect(R.readTokenResponse({ id_token: jwt({ sub: 'u1' }) }, 'r0')).toBeNull()
    expect(R.readTokenResponse({ id_token: jwt({ sub: 'u1', exp: '1900000000' }) }, 'r0')).toBeNull()
    expect(R.readTokenResponse({ id_token: 'not-a-jwt' }, 'r0')).toBeNull()
    expect(R.readTokenResponse({ id_token: id, scope: 'openid email https://www.googleapis.com/auth/drive.readonly' }, 'r0')).toBeNull()
    expect(R.readTokenResponse(null, 'r0')).toBeNull()
  })

  it("client id: only a Google client id from SANO's status", () => {
    expect(R.desktopClientId({ googleDesktopClientId: '123-abc.apps.googleusercontent.com' })).toBe('123-abc.apps.googleusercontent.com')
    for (const bad of [{}, { googleDesktopClientId: null }, { googleDesktopClientId: 42 }, { googleDesktopClientId: 'x.apps.googleusercontent.com.evil.vn' }, { googleDesktopClientId: 'a b.apps.googleusercontent.com' }, null]) {
      expect(R.desktopClientId(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('google-signin-rules: sign-in through the loopback port', () => {
  it('stray requests do not end it; the right one exchanges the code with the PKCE verifier, shows the static page, closes the port', async () => {
    const s = setup()
    const id = idToken(NOW + 3600_000)
    s.t.answers.push({ body: { id_token: id, refresh_token: 'r1', scope: 'openid https://www.googleapis.com/auth/userinfo.email' } })
    const auth = s.nextOpen()
    const signIn = s.g.signIn()
    const u = await auth
    expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect((await visit(u, 'favicon.ico')).status).toBe(404)
    expect((await visit(u, '?code=c&state=wrong')).status).toBe(400)
    expect((await visit(u, `?error=access_denied`)).status).toBe(400)
    const res = await visit(u, `?code=good&state=${u.searchParams.get('state')}&scope=openid`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    const html = await res.text()
    expect(html).toBe(R.PAGE_OK)
    expect(html).not.toContain(id)
    expect(await signIn).toEqual({ ok: true, idToken: id })
    expect(s.t.forms).toHaveLength(1)
    const form = s.t.forms[0]
    expect(form).toEqual({ code: 'good', client_id: CLIENT, code_verifier: form.code_verifier, redirect_uri: u.searchParams.get('redirect_uri'), grant_type: 'authorization_code' })
    expect(form.code_verifier).toMatch(/^[\w-]{43}$/)
    expect(await R.codeChallenge(form.code_verifier)).toBe(u.searchParams.get('code_challenge'))
    expect(u.searchParams.get('state')).toMatch(/^[\w-]{43}$/)
    expect(s.focused()).toBe(1)
    expect(await s.g.token()).toBe(id)
    await expect(visit(u, '')).rejects.toThrow() // port closed
  })

  it('Google says the user cancelled → "cancelled", no code exchange; another error → "failed"', async () => {
    for (const [error, code] of [['access_denied', 'cancelled'], ['admin_policy_enforced', 'failed']]) {
      const s = setup()
      const auth = s.nextOpen()
      const signIn = s.g.signIn()
      const u = await auth
      expect(await (await visit(u, `?error=${error}&state=${u.searchParams.get('state')}`)).text()).toBe(R.PAGE_FAILED)
      expect(await signIn).toMatchObject({ ok: false, code })
      expect(s.t.forms).toHaveLength(0)
      expect(await s.g.token()).toBeNull()
    }
  })

  it('a token answer without an ID token or with a Workspace scope, or no answer, signs nobody in', async () => {
    for (const answer of [{ body: { access_token: 'a' } }, { body: { id_token: idToken(NOW + 3600_000), scope: 'openid https://www.googleapis.com/auth/gmail.readonly' } }, { throws: true }]) {
      const s = setup()
      s.t.answers.push(answer)
      const auth = s.nextOpen()
      const signIn = s.g.signIn()
      const u = await auth
      expect(await (await visit(u, `?code=c&state=${u.searchParams.get('state')}`)).text()).toBe(R.PAGE_FAILED)
      expect(await signIn).toMatchObject({ ok: false, code: 'failed' })
      expect(await s.g.token()).toBeNull()
    }
  })

  it('the state is used once: a second right request while the code is being exchanged gets 400', async () => {
    const s = setup()
    let release: () => void = () => undefined
    s.t.answers.push(() => new Promise((r) => (release = () => r({ body: { id_token: idToken(NOW + 3600_000) } }))))
    const auth = s.nextOpen()
    const signIn = s.g.signIn()
    const u = await auth
    const first = visit(u, `?code=c&state=${u.searchParams.get('state')}`)
    await expect.poll(() => s.t.forms.length).toBe(1)
    expect((await visit(u, `?code=c2&state=${u.searchParams.get('state')}`)).status).toBe(400)
    release()
    expect((await first).status).toBe(200)
    expect(await signIn).toMatchObject({ ok: true })
    expect(s.t.forms).toHaveLength(1)
  })

  it('no client id from SANO → "not-configured", nothing opened', async () => {
    const s = setup({ clientId: async () => null })
    expect(await s.g.signIn()).toMatchObject({ ok: false, code: 'not-configured' })
    expect(s.opened).toHaveLength(0)
  })

  it('no callback in time → "timeout", port closed', async () => {
    const s = setup({ timeoutMs: 50 })
    const auth = s.nextOpen()
    const signIn = s.g.signIn()
    const u = await auth
    expect(await signIn).toMatchObject({ ok: false, code: 'timeout' })
    await expect(visit(u, '')).rejects.toThrow()
  })

  it('the browser cannot be opened, or the port cannot be listened on → "failed"', async () => {
    const s = setup({ openExternal: () => Promise.reject(new Error('no browser')) })
    expect(await s.g.signIn()).toMatchObject({ ok: false, code: 'failed' })
    const refused = ((handler: Parameters<typeof createServer>[0]) => {
      const server = createServer(handler)
      server.listen = function (this: typeof server) {
        process.nextTick(() => this.emit('error', new Error('EACCES')))
        return this
      } as never
      return server
    }) as typeof createServer
    const s2 = setup({ createServer: refused })
    expect(await s2.g.signIn()).toMatchObject({ ok: false, code: 'failed' })
    expect(s2.opened).toHaveLength(0)
  })

  it('a new sign-in ends the previous one; an answer that arrives after that is dropped', async () => {
    const s = setup()
    let release: () => void = () => undefined
    s.t.answers.push(() => new Promise((r) => (release = () => r({ body: { id_token: idToken(NOW + 3600_000, 'old') } }))))
    let auth = s.nextOpen()
    const first = s.g.signIn()
    const u1 = await auth
    const late = visit(u1, `?code=c&state=${u1.searchParams.get('state')}`).catch(() => undefined)
    await expect.poll(() => s.t.forms.length).toBe(1)
    auth = s.nextOpen()
    const second = s.g.signIn()
    expect(await first).toMatchObject({ ok: false, code: 'superseded' })
    release()
    await late
    expect(await s.g.token()).toBeNull()
    const u2 = await auth
    const id = idToken(NOW + 3600_000, 'new')
    s.t.answers.push({ body: { id_token: id } })
    await visit(u2, `?code=c&state=${u2.searchParams.get('state')}`)
    expect(await second).toEqual({ ok: true, idToken: id })
    expect(s.focused()).toBe(1) // the dropped answer did not bring the window forward
  })

  it('signOut ends a sign-in still waiting on the browser: its late answer (maybe another account) is not stored', async () => {
    const s = setup()
    s.t.answers.push({ body: { id_token: idToken(NOW + 3600_000, 'other') } })
    const auth = s.nextOpen()
    const signIn = s.g.signIn()
    const u = await auth
    expect(s.g.signOut()).toBe(true)
    expect(await signIn).toMatchObject({ ok: false, code: 'cancelled' })
    await expect(visit(u, `?code=c&state=${u.searchParams.get('state')}`)).rejects.toThrow() // port closed
    expect(await s.g.token()).toBeNull()
    expect(s.t.forms).toHaveLength(0)
  })

  it('signOut or a newer sign-in while the client id is still being fetched ends that sign-in before the browser opens', async () => {
    const ids: ((id: string) => void)[] = []
    const s = setup({ clientId: () => new Promise((r) => ids.push(r)) })
    const signedOut = s.g.signIn()
    expect(s.g.signOut()).toBe(true)
    ids[0](CLIENT)
    expect(await signedOut).toMatchObject({ ok: false, code: 'cancelled' })
    const older = s.g.signIn()
    const newer = s.g.signIn()
    const auth = s.nextOpen()
    ids[2](CLIENT)
    await auth
    ids[1](CLIENT) // the older one's client id arrives last: it does not take over
    expect(await older).toMatchObject({ ok: false, code: 'superseded' })
    expect(s.opened).toHaveLength(1)
    s.g.signOut()
    expect(await newer).toMatchObject({ ok: false, code: 'cancelled' })
  })

  it('the browser tab closed during the code exchange: the port still closes', async () => {
    let gone = 0
    const s = setup({ createServer: ((h: Parameters<typeof createServer>[0]) => createServer(h).on('connection', (c) => c.on('close', () => gone++))) as typeof createServer })
    let release: () => void = () => undefined
    s.t.answers.push(() => new Promise((r) => (release = () => r({ body: { id_token: idToken(NOW + 3600_000) } }))))
    const auth = s.nextOpen()
    const signIn = s.g.signIn()
    const u = await auth
    const tab = new AbortController()
    const closedTab = visit(u, `?code=c&state=${u.searchParams.get('state')}`, { signal: tab.signal }).catch(() => undefined)
    await expect.poll(() => s.t.forms.length).toBe(1)
    tab.abort()
    await closedTab
    await expect.poll(() => gone).toBeGreaterThan(0)
    release()
    expect(await signIn).toMatchObject({ ok: true })
    await expect(visit(u, '')).rejects.toThrow() // port closed
  })

  it('client secret (only when set: T1) goes with the code exchange and the refresh', async () => {
    const s = setup({ secret: 'shh' })
    s.t.answers.push({ body: { id_token: idToken(NOW + 60_000), refresh_token: 'r1' } }, { body: { id_token: idToken(NOW + 3600_000) } })
    const auth = s.nextOpen()
    const signIn = s.g.signIn()
    const u = await auth
    expect(u.searchParams.has('client_secret')).toBe(false)
    await visit(u, `?code=c&state=${u.searchParams.get('state')}`)
    await signIn
    await s.g.token()
    expect(s.t.forms.map((f) => f.client_secret)).toEqual(['shh', 'shh'])
  })
})

describe('google-signin-rules: token() renews in memory', () => {
  afterEach(() => void vi.restoreAllMocks())

  /** Signed in with an ID token expiring at `exp`, refresh token 'r1' (unless `refresh` is null). */
  async function signedIn(exp: number, refresh: string | null = 'r1') {
    const s = setup()
    s.t.answers.push({ body: { id_token: idToken(exp), ...(refresh ? { refresh_token: refresh } : {}) } })
    const auth = s.nextOpen()
    const signIn = s.g.signIn()
    const u = await auth
    await visit(u, `?code=c&state=${u.searchParams.get('state')}`)
    expect(await signIn).toMatchObject({ ok: true })
    s.t.forms.length = 0
    return s
  }

  it('more than 5 minutes left → the same token, no request; less → one refresh shared by concurrent calls', async () => {
    const s = await signedIn(NOW + R.RENEW_BEFORE_MS + 1000)
    const first = await s.g.token()
    expect(s.t.forms).toHaveLength(0)
    s.setNow(NOW + 2000)
    const renewed = idToken(NOW + 3600_000, 'u1')
    s.t.answers.push({ body: { id_token: renewed, scope: 'openid https://www.googleapis.com/auth/userinfo.email' } })
    expect(await Promise.all([s.g.token(), s.g.token()])).toEqual([renewed, renewed])
    expect(s.t.forms).toEqual([{ grant_type: 'refresh_token', refresh_token: 'r1', client_id: CLIENT }])
    expect(first).not.toBe(renewed)
    // the refresh token Google did not resend is kept
    s.setNow(NOW + 3600_000)
    s.t.answers.push({ body: { id_token: idToken(NOW + 7200_000) } })
    await s.g.token()
    expect(s.t.forms[1].refresh_token).toBe('r1')
  })

  it('invalid_grant (incl. invalid_rapt) or an answer without an ID token → signed out (null, no more requests)', async () => {
    for (const a of [{ status: 400, body: { error: 'invalid_grant', error_subtype: 'invalid_rapt' } }, { body: { access_token: 'a' } }]) {
      const s = await signedIn(NOW + 1000)
      s.t.answers.push(a)
      expect(await s.g.token()).toBeNull()
      expect(await s.g.token()).toBeNull()
      expect(s.t.forms).toHaveLength(1)
    }
  })

  it('a client refusal (401 invalid_client, 400 unauthorized_client) after expiry → signed out, not a rejection forever', async () => {
    for (const a of [{ status: 401, body: { error: 'invalid_client' } }, { status: 400, body: { error: 'unauthorized_client' } }]) {
      const s = await signedIn(NOW + 60_000)
      s.setNow(NOW + 7200_000)
      s.t.answers.push(a)
      expect(await s.g.token()).toBeNull()
      expect(await s.g.token()).toBeNull()
      expect(s.t.forms).toHaveLength(1)
    }
  })

  it('no answer (offline, a 200 body cut off), a server error, 408 or 429 → kept: the still-valid token, the next call tries again; expired → rejects, still signed in', async () => {
    for (const a of [{ throws: true }, { bodyFails: true }, { status: 503, body: { error: 'temporarily_unavailable' } }, { status: 408, body: {} }, { status: 429, body: { error: 'rate_limit_exceeded' } }]) {
      const s = await signedIn(NOW + 60_000)
      s.t.answers.push(a, { body: { id_token: idToken(NOW + 3600_000) } })
      const old = await s.g.token()
      expect(old).not.toBeNull()
      expect(await s.g.token()).not.toBe(old)
      expect(s.t.forms).toHaveLength(2)
      s.setNow(NOW + 7200_000)
      const later = idToken(NOW + 10_800_000)
      s.t.answers.push({ throws: true }, { body: { id_token: later } })
      // expired while offline: not null (signed out), the refresh token still holds: only this call fails
      await expect(s.g.token()).rejects.toThrow()
      expect(await s.g.token()).toBe(later)
    }
  })

  it('a token request that hangs gives up after 15 s, which counts as no answer', async () => {
    const s = await signedIn(NOW + 60_000)
    const timeout = new AbortController()
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    s.t.answers.push((_form, signal) => new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(signal.reason))))
    const pending = s.g.token()
    await expect.poll(() => s.t.forms.length).toBe(1)
    expect(spy).toHaveBeenCalledWith(15_000)
    timeout.abort(new DOMException('timed out', 'TimeoutError'))
    expect(await pending).toBe(idToken(NOW + 60_000)) // the still-valid token
  })

  it('no refresh token → signed out when the ID token runs low', async () => {
    const s = await signedIn(NOW + 1000, null)
    expect(await s.g.token()).toBeNull()
    expect(s.t.forms).toHaveLength(0)
  })

  it('signOut forgets the tokens; a refresh finishing after it does not sign back in', async () => {
    const s = await signedIn(NOW + 1000)
    let release: () => void = () => undefined
    s.t.answers.push(() => new Promise((r) => (release = () => r({ body: { id_token: idToken(NOW + 3600_000) } }))))
    const pending = s.g.token()
    await expect.poll(() => s.t.forms.length).toBe(1)
    expect(s.g.signOut()).toBe(true)
    release()
    expect(await pending).toBeNull()
    expect(await s.g.token()).toBeNull()
  })
})
