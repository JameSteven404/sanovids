// Sano Agent's SANO API forward (electron/sano-api-rules.cjs, SANO TH-44 step 4): app://sano/api/assistant/* → a fake
// SANO server (an injected fetch), with a fake account { bearer, ended }. Never a real server. Tokens are built at run time.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

interface Rules {
  MAX_BODY: number
  TIMEOUT_MS: number
  REFUSALS: Record<string, [number, string]>
  createApiForward(fx: Record<string, unknown>): { forward(request: Request, url: URL | { pathname: string; search: string }): Promise<Response> }
}
const nodeRequire = createRequire(import.meta.url)
const R = nodeRequire('../../../electron/sano-api-rules.cjs') as Rules

const API = 'http://127.0.0.1:8796'
const PAGE = { 'x-sano-client': 'desktop', origin: 'app://sano', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' }
const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })

const logs: string[] = []
afterEach(() => {
  logs.length = 0
})

function setup(o: { token?: string | null; answer?: (url: string, init: RequestInit) => Response | Promise<Response> } = {}) {
  const token = o.token === undefined ? `sano_${randomUUID()}` : o.token
  const calls: { url: string; init: RequestInit }[] = []
  const ended: string[] = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return o.answer ? o.answer(url, init) : json(200, { ok: true })
  }
  const account = { bearer: async () => token, ended: async (t: string) => void ended.push(t) }
  const api = R.createApiForward({ apiUrl: API, fetch, account, log: (line: string) => void logs.push(line) })
  const send = (path: string, init: RequestInit = {}) => {
    const request = new Request(`app://sano${path}`, { ...init, headers: { ...PAGE, ...(init.headers as Record<string, string>) } })
    return api.forward(request, new URL(request.url))
  }
  return { api, send, calls, ended, token }
}
const refusal = async (res: Response, code: string) => {
  expect(res.status, code).toBe(R.REFUSALS[code][0])
  expect(await res.json()).toEqual({ error: R.REFUSALS[code][1], code })
  expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
  expect(res.headers.get('cache-control')).toBe('no-store')
}

describe('createApiForward (fake SANO server)', () => {
  it("GET/POST reach SANO_API with the sano_ bearer and none of the page's headers (page Authorization and X-Sano-Client not forwarded)", async () => {
    const t = setup()
    const page = { Authorization: 'Bearer bogus', Cookie: 'a=b', Referer: 'app://sano/', 'X-Extra': '1' }
    const get = await t.send('/api/assistant/google/drive/files?q=K%E1%BB%8Bch&kind=docs', { headers: page })
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ ok: true })
    const body = JSON.stringify({ message: 'xin chào' })
    expect((await t.send('/api/assistant/chat', { method: 'POST', body, headers: { ...page, 'content-type': 'application/json' } })).status).toBe(200)
    const [g, p] = t.calls
    expect(g.url).toBe(`${API}/api/assistant/google/drive/files?q=K%E1%BB%8Bch&kind=docs`)
    expect(g.init).toMatchObject({ method: 'GET', redirect: 'manual', body: undefined })
    expect(g.init.headers).toEqual({ Accept: 'application/json', Authorization: `Bearer ${t.token}` })
    expect(g.init.signal).toBeInstanceOf(AbortSignal)
    expect(p.url).toBe(`${API}/api/assistant/chat`)
    expect(p.init.headers).toEqual({ Accept: 'application/json', Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' })
    expect(Buffer.from(p.init.body as Uint8Array).toString()).toBe(body)
    expect(R.TIMEOUT_MS).toBe(75_000)
    expect(R.MAX_BODY).toBe(80_000)
  })

  it('405 (OPTIONS too) / 404 (outside /api/assistant, google/callback, %-encoded, `..`, long query)', async () => {
    const t = setup()
    for (const method of ['OPTIONS', 'PUT', 'DELETE', 'PATCH']) await refusal(await t.send('/api/assistant/session', { method }), 'bad-method')
    for (const path of ['/api/auth/me', '/api/video/x', '/api/assistant', '/api/assistant/', '/api/assistantx', '/api/assistant//x', '/api/assistant/google/callback?state=s&code=c', '/api/assistant/a%2Fb', '/api/assistant/%2e%2e%2fauth', `/api/assistant/session?${'q'.repeat(4096)}`]) {
      await refusal(await t.send(path), 'not-found')
    }
    // URL parsing resolves dot segments itself: the check holds for a pathname that still has one
    for (const pathname of ['/api/assistant/../auth/me', '/api/assistant/./session', '/api/assistant/x/..']) {
      await refusal(await t.api.forward(new Request('app://sano/api/assistant/session', { headers: PAGE }), { pathname, search: '' }), 'not-found')
    }
    expect((await t.send(`/api/assistant/session?${'q'.repeat(4095)}`)).status).toBe(200)
    expect(t.calls).toHaveLength(1)
  })

  it('403 without X-Sano-Client, with a foreign Origin, with sec-fetch-dest document or sec-fetch-site cross-site; absent sec-fetch → forwarded + one log line', async () => {
    const t = setup()
    for (const headers of <Record<string, string>[]>[{ 'x-sano-client': '' }, { 'x-sano-client': 'web' }, { origin: 'https://evil.example' }, { origin: 'app://bdp' }, { origin: 'null' }, { 'sec-fetch-dest': 'document' }, { 'sec-fetch-dest': 'image' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'none' }]) {
      await refusal(await t.send('/api/assistant/session', { headers }), 'not-allowed')
    }
    const bare = () => t.api.forward(new Request('app://sano/api/assistant/session', { headers: { 'x-sano-client': 'desktop' } }), new URL('app://sano/api/assistant/session'))
    await refusal(await t.api.forward(new Request('app://sano/api/assistant/session'), new URL('app://sano/api/assistant/session')), 'not-allowed')
    expect(t.calls).toEqual([])
    logs.length = 0
    expect((await bare()).status).toBe(200)
    expect((await bare()).status).toBe(200)
    expect(t.calls).toHaveLength(2)
    expect(logs).toEqual(['[SanoVids] sano api: no sec-fetch metadata'])
  })

  it('415 for a text/plain or form POST', async () => {
    const t = setup()
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      await refusal(await t.send('/api/assistant/chat', { method: 'POST', body: '{}', headers: { 'content-type': type } }), 'bad-type')
    }
    await refusal(await t.send('/api/assistant/chat', { method: 'POST', body: new Blob(['{}']) }), 'bad-type')
    expect(t.calls).toEqual([])
  })

  it('413: content-length over 80 000 refused before reading; a streamed body over 80 000 stops reading', async () => {
    const t = setup()
    let pulls = 0
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulls++
          c.enqueue(new Uint8Array(30_000))
        },
      })
    const post = (headers: Record<string, string>) =>
      t.send('/api/assistant/chat', { method: 'POST', body: endless(), duplex: 'half', headers: { 'content-type': 'application/json', ...headers } } as RequestInit)
    await refusal(await post({ 'content-length': '80001' }), 'too-large')
    pulls = 0
    await refusal(await post({}), 'too-large')
    expect(pulls).toBeLessThanOrEqual(5) // stopped after the chunk that passed 80 000 (plus the stream's queue)
    // exactly MAX_BODY passes
    const full = JSON.stringify({ m: 'x'.repeat(R.MAX_BODY - 8) })
    expect(full.length).toBe(R.MAX_BODY)
    expect((await t.send('/api/assistant/chat', { method: 'POST', body: full, headers: { 'content-type': 'application/json' } })).status).toBe(200)
    expect(t.calls).toHaveLength(1)
  })

  it('signed out → 401 signed-out, server not called', async () => {
    const t = setup({ token: null })
    await refusal(await t.send('/api/assistant/session'), 'signed-out')
    await refusal(await t.send('/api/assistant/chat', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), 'signed-out')
    await refusal(await t.send('/api/assistant/status', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), 'signed-out')
    await refusal(await t.send('/api/assistant/status/x'), 'signed-out')
    expect(t.calls).toEqual([])
  })

  it('signed out, GET /api/assistant/status (public on the server) is still forwarded, with no Authorization', async () => {
    const t = setup({ token: null, answer: () => json(401, { code: 'session-invalid' }) })
    expect((await t.send('/api/assistant/status')).status).toBe(401)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].init.headers).toEqual({ Accept: 'application/json' })
    expect(t.ended).toEqual([])
  })

  it('offline 503, timeout 503, redirect 502, non-JSON 502', async () => {
    const cases: (() => Response)[] = [
      () => {
        throw new TypeError('fetch failed')
      },
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      },
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/', 'content-type': 'application/json' } }),
      () => ({ type: 'opaqueredirect', status: 0, headers: new Headers(), body: null }) as unknown as Response,
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => new Response('{}', { status: 200 }),
    ]
    const codes = ['offline', 'timeout', 'bad-answer', 'bad-answer', 'bad-answer', 'bad-answer']
    for (const [i, answer] of cases.entries()) {
      const t = setup({ answer })
      await refusal(await t.send('/api/assistant/session'), codes[i])
      expect(t.ended).toEqual([])
    }
  })

  it('server 401 → ended(token) then the server body; 403 not-provisioned ends; other 403 does not', async () => {
    for (const [res, ends] of [
      [() => json(401, { error: 'Phiên đăng nhập đã hết hạn. Đăng nhập lại.' }), true],
      [() => json(403, { error: 'Tài khoản đã bị tắt.', code: 'not-provisioned' }), true],
      [() => json(403, { error: 'Không có quyền.', code: 'forbidden' }), false],
      [() => json(403, { error: 'Không có quyền.' }), false],
      [() => json(500, { error: 'Lỗi máy chủ.' }), false],
    ] as [() => Response, boolean][]) {
      const want = await res().json()
      const t = setup({ answer: res })
      const r = await t.send('/api/assistant/session')
      expect(r.status).toBe(res().status)
      expect(await r.json()).toEqual(want)
      expect(t.ended).toEqual(ends ? [t.token] : [])
    }
  })

  it('response headers: content-type, no-store, retry-after only', async () => {
    const headers = { 'set-cookie': 'sid=1', 'x-powered-by': 'x', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' }
    const t = setup({ answer: () => json(429, { error: 'Quá nhiều yêu cầu.' }, { ...headers, 'retry-after': '30' }) })
    const r = await t.send('/api/assistant/session')
    expect(r.status).toBe(429)
    expect([...r.headers]).toEqual([
      ['cache-control', 'no-store'],
      ['content-type', 'application/json; charset=utf-8'],
      ['retry-after', '30'],
    ])
    const ok = setup({ answer: () => json(200, { ok: true }, headers) })
    expect([...(await ok.send('/api/assistant/session')).headers]).toEqual([
      ['cache-control', 'no-store'],
      ['content-type', 'application/json; charset=utf-8'],
    ])
  })

  it('logs never contain token, query or body', async () => {
    const secret = `ten-tai-lieu-${randomUUID()}`
    for (const answer of [
      () => {
        throw new TypeError('fetch failed')
      },
      () => new Response(secret, { status: 200, headers: { 'content-type': 'text/plain' } }),
      () => json(401, { error: secret }),
    ]) {
      const t = setup({ answer })
      await t.send(`/api/assistant/google/drive/files?q=${secret}`)
      await t.send('/api/assistant/chat', { method: 'POST', body: JSON.stringify({ message: secret }), headers: { 'content-type': 'application/json' } })
      await t.send('/api/assistant/chat', { method: 'POST', body: secret, headers: { 'content-type': 'text/plain' } })
      await t.send(`/api/auth/me?q=${secret}`, { headers: { Authorization: `Bearer ${t.token}` } })
      for (const line of logs) {
        expect(line).not.toContain(secret)
        expect(line).not.toContain(t.token)
        expect(line).not.toContain('?')
      }
    }
    expect(logs).toContain('[SanoVids] sano api: GET /api/assistant/google/drive/files → offline')
    expect(logs).toContain('[SanoVids] sano api: POST /api/assistant/chat → bad-type')
    expect(logs).toContain('[SanoVids] sano api: GET /api/auth/me → not-found')
  })
})
