// SANO desktop, TH-38: electron/sano-team-rules.cjs — the payload of canvasapp cookies handed to SANO's server and the
// connect flow (token check, one at a time, partition wiped before and after, nothing posted before canvasapp confirms
// the login), run with fake Electron / network dependencies and fake timers. The wiring is in hardeningRules.test.ts.
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
type Result = { ok: true; status: unknown } | { ok: false; code: string; message: string }
interface Handlers {
  onNavigate(): void
  onClosed(): void
}
interface Deps {
  now(): number
  host: string
  clear(): Promise<void>
  open(h: Handlers): { close(): void }
  authenticated(): Promise<boolean>
  cookies(): Promise<unknown[]>
  post(payload: unknown, token: string): Promise<{ status: number; json: unknown }>
}
interface Rules {
  SANO_TEAM_PARTITION: string
  SANO_TEAM_SESSION_PATH: string
  SANO_TEAM_LOGIN_MS: number
  SANO_TEAM_CHECK_MS: number
  TEAM_TEXT: Record<string, string>
  teamSessionPayload(cookies: unknown, host: string, now: number): { v: 1; cookies: Record<string, unknown>[] } | null
  createSanoTeamConnect(deps: Deps): (token: unknown) => Promise<Result>
}

const R = createRequire(import.meta.url)('../../../electron/sano-team-rules.cjs') as Rules
const HOST = 'canvasapp.io.vn'
const NOW = Date.parse('2026-10-23T10:00:00Z')

const ck = (over: Partial<Ck> = {}): Ck => ({
  name: 'sid',
  value: 'SECRET-sid',
  domain: HOST,
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  session: true,
  ...over,
})
const csrf = ck({ name: 'canvas_csrf', value: 'SECRET-csrf', httpOnly: false })
/** A JWT-shaped SANO token whose `exp` is `minutes` from NOW. */
const token = (minutes: number) => ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify({ exp: NOW / 1000 + minutes * 60 })).toString('base64url'), 'c2ln'].join('.')

describe('teamSessionPayload', () => {
  const pay = (cookies: unknown) => R.teamSessionPayload(cookies, HOST, NOW)

  it("keeps canvasapp.io.vn's own session cookies and its persistent ones not expired yet, with exactly the shared keys", () => {
    const later = NOW / 1000 + 3600.5
    const p = pay([csrf, ck({ domain: '.canvasapp.io.vn', hostOnly: false, session: false, expirationDate: later })])
    expect(p).toEqual({
      v: 1,
      cookies: [
        { name: 'canvas_csrf', value: 'SECRET-csrf', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'lax' },
        { name: 'sid', value: 'SECRET-sid', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: later },
      ],
    })
  })

  it('drops Cloudflare, Google, other hosts, expired, bad names, long values and values SANO refuses', () => {
    const dropped = [
      ck({ name: '__cf_bm' }),
      ck({ name: 'cf_clearance', session: false, expirationDate: NOW / 1000 + 60 }),
      ck({ name: 'SID', domain: '.google.com', hostOnly: false }),
      ck({ domain: 'www.canvasapp.io.vn' }),
      ck({ domain: 'canvasapp.io.vn.evil.vn' }),
      ck({ session: false, expirationDate: NOW / 1000 - 1 }),
      ck({ session: false }),
      ck({ name: 'bad name' }),
      ck({ name: 'a;b' }),
      ck({ value: 'x'.repeat(4097) }),
      ck({ value: 'a;b' }),
      ck({ value: 'a\r\nSet-Cookie: x=1' }),
      ck({ value: 'a\u0000b' }),
      ck({ name: '__Host-sid', path: '/api' }),
      ck({ sameSite: 'no_restriction', secure: false }),
    ]
    expect(pay([csrf, ...dropped])!.cookies.map((c) => c.name)).toEqual(['canvas_csrf'])
    expect(pay([csrf, ck({ value: 'x'.repeat(4096) })])!.cookies).toHaveLength(2)
  })

  it('null for none or more than 30', () => {
    expect(pay([])).toBeNull()
    expect(pay(null)).toBeNull()
    expect(pay([ck({ name: '__cf_bm' })])).toBeNull()
    const many = (n: number) => Array.from({ length: n }, (_, i) => ck({ name: `c${i}` }))
    expect(pay(many(30))!.cookies).toHaveLength(30)
    expect(pay(many(31))).toBeNull()
  })
})

describe('createSanoTeamConnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Fake Electron / SANO; `log` records every effect in order. */
  function harness(over: Partial<Deps> = {}) {
    const log: string[] = []
    const posted: { payload: unknown; token: string }[] = []
    const state = { authed: false, cookies: [csrf, ck()] as unknown[], handlers: null as Handlers | null }
    const deps: Deps = {
      now: () => NOW,
      host: HOST,
      clear: async () => void log.push('clear'),
      open: (h) => {
        log.push('open')
        state.handlers = h
        return { close: () => void log.push('close') }
      },
      authenticated: async () => state.authed,
      cookies: async () => state.cookies,
      post: async (payload, tok) => {
        log.push('post')
        posted.push({ payload, token: tok })
        return { status: 200, json: { backend: 'canvasapp', state: 'ok' } }
      },
      ...over,
    }
    const connect = R.createSanoTeamConnect(deps)
    const flush = () => vi.advanceTimersByTimeAsync(0)
    /** The QTV finishes logging in: canvasapp now says authenticated, the page navigates. */
    const login = async () => {
      state.authed = true
      state.handlers!.onNavigate()
      await flush()
    }
    return { log, posted, state, connect, flush, login }
  }

  it('posts teamSessionPayload of the cookies with the token once canvasapp confirms, then wipes', async () => {
    const h = harness()
    const tok = token(60)
    const run = h.connect(tok)
    await h.flush()
    expect(h.log).toEqual(['clear', 'open'])
    // a navigation before the login is done posts nothing
    h.state.handlers!.onNavigate()
    await h.flush()
    expect(h.posted).toHaveLength(0)
    await h.login()
    expect(await run).toEqual({ ok: true, status: { backend: 'canvasapp', state: 'ok' } })
    expect(h.posted).toEqual([{ payload: R.teamSessionPayload(h.state.cookies, HOST, NOW), token: tok }])
    expect(h.log).toEqual(['clear', 'open', 'post', 'close', 'clear'])
  })

  it('also notices the login on the 5 s check (no navigation event)', async () => {
    const h = harness()
    const run = h.connect(token(60))
    await h.flush()
    h.state.authed = true
    await vi.advanceTimersByTimeAsync(R.SANO_TEAM_CHECK_MS)
    expect((await run).ok).toBe(true)
  })

  it('a bad or expiring token never opens a window nor touches the partition', async () => {
    const h = harness()
    for (const bad of [undefined, '', 'a.b', 'a.b.c.d', 'a.b+.c', 'x'.repeat(8193), 'eyJ.bm90IGpzb24.c2ln', ['a', Buffer.from('{}').toString('base64url'), 'c'].join('.')]) {
      expect(await h.connect(bad), String(bad).slice(0, 20)).toMatchObject({ ok: false, code: 'bad-request' })
    }
    expect(await h.connect(token(19))).toEqual({ ok: false, code: 'token-expiring', message: 'Phiên đăng nhập SANO sắp hết hạn — đăng nhập lại SANO rồi bấm Kết nối.' })
    expect(h.log).toEqual([])
    const run = h.connect(token(21))
    await h.flush()
    expect(h.log).toEqual(['clear', 'open'])
    h.state.handlers!.onClosed()
    await run
  })

  it('one at a time: a second call gets busy and leaves the first one alone', async () => {
    const h = harness()
    const first = h.connect(token(60))
    await h.flush()
    expect(await h.connect(token(60))).toMatchObject({ ok: false, code: 'busy' })
    expect(h.log).toEqual(['clear', 'open'])
    await h.login()
    expect((await first).ok).toBe(true)
    // free again afterwards
    const again = h.connect(token(60))
    await h.flush()
    expect(h.log.filter((e) => e === 'open')).toHaveLength(2)
    h.state.handlers!.onClosed()
    expect(await again).toMatchObject({ code: 'closed' })
  })

  it('every outcome after the window opened closes it and wipes the partition again', async () => {
    const outcomes: [string, Partial<Deps>, (h: ReturnType<typeof harness>) => Promise<void>][] = [
      ['closed', {}, async (h) => h.state.handlers!.onClosed()],
      ['timeout', {}, async () => void (await vi.advanceTimersByTimeAsync(R.SANO_TEAM_LOGIN_MS))],
      ['no-session', { cookies: async () => [ck()] }, (h) => h.login()],
      ['network', { post: async () => Promise.reject(new TypeError('fetch failed')) }, (h) => h.login()],
      ['sano-refused', { post: async () => ({ status: 409, json: { error: 'canvasapp không nhận phiên này khi máy chủ SANO gọi (401) — chưa lưu gì.' } }) }, (h) => h.login()],
    ]
    for (const [code, over, act] of outcomes) {
      const h = harness(over)
      const run = h.connect(token(60))
      await h.flush()
      await act(h)
      const res = await run
      expect(res, code).toMatchObject({ ok: false, code })
      expect(h.log.slice(-2), code).toEqual(['close', 'clear'])
      expect(h.log[0], code).toBe('clear')
      if (code === 'closed' || code === 'timeout') expect(h.log, code).not.toContain('post')
    }
  })

  it("passes SANO's own refusal text through (plain, short); else says the status", async () => {
    const run = async (status: number, json: unknown) => {
      const h = harness({ post: async () => ({ status, json }) })
      const p = h.connect(token(60))
      await h.flush()
      await h.login()
      return p
    }
    expect(await run(403, { error: 'Chỉ QTV được xem và quản lý tài khoản canvasapp của team.' })).toEqual({
      ok: false,
      code: 'sano-refused',
      message: 'Chỉ QTV được xem và quản lý tài khoản canvasapp của team.',
    })
    expect(await run(502, { error: 'a\nb' })).toMatchObject({ message: 'a b' })
    expect(await run(500, null)).toMatchObject({ message: 'Máy chủ SANO từ chối (mã 500) — chưa kết nối.' })
  })

  it('a failed wipe at the end still frees the next connect', async () => {
    let n = 0
    const h = harness({
      clear: async () => {
        if (++n === 2) throw new Error('busy disk')
      },
    })
    const run = h.connect(token(60))
    await h.flush()
    h.state.handlers!.onClosed()
    expect(await run).toMatchObject({ code: 'closed' })
    const next = h.connect(token(60))
    await h.flush()
    h.state.handlers!.onClosed()
    expect(await next).toMatchObject({ code: 'closed' })
  })

  it('partition and SANO path are the shared contract', () => {
    expect(R.SANO_TEAM_PARTITION).toBe('canvasapp-team')
    expect(R.SANO_TEAM_SESSION_PATH).toBe('/api/video/admin/canvasapp-session')
    for (const code of ['not-allowed', 'bad-request', 'token-expiring', 'busy', 'closed', 'timeout', 'no-session', 'network', 'error']) expect(R.TEAM_TEXT[code], code).toBeTruthy()
  })
})
