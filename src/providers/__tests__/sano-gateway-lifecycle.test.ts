// Gateway lifecycle regressions: inert responses, tiny blobs, fake clocks; no provider/network/profile.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSanoGatewayProvider, REQUEST_MS, SANO_OTHER_ACCOUNT, type SanoGatewayDeps } from '../sano/gateway'
import type { JobRequest, JobResult } from '../types'
import { jwt } from './insideSano'

const tokens = { A: jwt({ sub: 'fixture-A' }), B: jwt({ sub: 'fixture-B' }) }
const caps = { mode: 'simulator', models: [{ id: 'seedance_2_5', label: 'Seedance', ratios: ['16:9'], resolutions: ['720p'], durations: [5], maxRefs: 4 }] }
const request = (over: Partial<JobRequest> = {}): JobRequest => ({
  key: 'take_1', takeId: 'take_1', sceneId: 's', sanovidsProjectId: 'p', sceneCode: 'S01', takeNumber: 1,
  title: '', color: '#fff', model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '720p', ratio: '16:9',
  prompt: 'A bird flies', rawPrompt: 'A bird flies', images: [], firstFrame: null, lastFrame: null, startedAt: 1, ...over,
})
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const providers: ReturnType<typeof createSanoGatewayProvider>[] = []
function make(fetch: SanoGatewayDeps['fetch'], over: Partial<SanoGatewayDeps> = {}) {
  const p = createSanoGatewayProvider({ fetch, token: async () => tokens.A, available: () => true, getBlob: async () => null, ...over })
  providers.push(p)
  return p
}
const release = (r: JobResult) => (r as JobResult & { release?: () => void }).release?.()
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', () => { throw new Error('Real network forbidden') })
})
afterEach(() => {
  for (const p of providers.splice(0)) p.reset()
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('unknown submit recovery', () => {
  it.each(['missing reference', 'removed model'])('looks up the original job before %s preflight', async (kind) => {
    const fetch = vi.fn(async (url: string) => url.includes('?idempotencyKey=')
      ? Response.json({ id: 'original-job', status: 'running', mode: 'simulator' })
      : Response.json({ models: [] }))
    const p = make(fetch)
    await flush()
    const req = request(kind === 'missing reference' ? { images: [{ n: 1, imageId: 'gone', assetId: 'a' }] } : {})
    await expect(p.submit(req, { retryOfUnknown: true })).resolves.toEqual({ remoteId: 'original-job', simulated: true })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/video/jobs?idempotencyKey=take_1'])
  })

  it('a confirmed 404 still validates and sends the same key; a normal submit skips recovery', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => url.includes('?idempotencyKey=') ? new Response(null, { status: 404 })
      : url.endsWith('/capabilities') ? Response.json(caps) : Response.json({ id: 'new-job', status: 'queued' }, { status: 202 }))
    const p = make(fetch); await flush()
    await p.submit(request(), { retryOfUnknown: true })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/video/jobs?idempotencyKey=take_1', '/api/video/capabilities', '/api/video/jobs'])
    expect(JSON.parse(String(fetch.mock.calls[2][1].body)).idempotencyKey).toBe('take_1')
    fetch.mockClear()
    await p.submit(request({ key: 'take_2' }))
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/video/jobs'])
  })

  it('a timed-out 200 recovery body defers, without a POST or a permanent failure', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true })
    } })))
    const p = make(fetch); await flush()
    const result = p.recover(request()).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(REQUEST_MS + 1)
    expect(await result).toMatchObject({ code: 'deferred' })
    expect(fetch.mock.calls).toHaveLength(1)
    expect(fetch.mock.calls[0][1].method).not.toBe('POST')
  })

  it('a cancelled retry stops before recovery and never posts', async () => {
    const fetch = vi.fn(async () => Response.json({}))
    const p = make(fetch); await flush()
    await expect(p.submit(request(), { retryOfUnknown: true, isCancelled: () => true })).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hands a recovered id back after cancellation during lookup so the engine can cancel that known job', async () => {
    let cancelled = false
    let answer!: (res: Response) => void
    const fetch = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(resolve => { answer = resolve }))
    const p = make(fetch); await flush()
    const result = p.submit(request(), { retryOfUnknown: true, isCancelled: () => cancelled })
    await flush(); cancelled = true
    answer(Response.json({ id: 'existing', status: 'queued' }))
    expect(await result).toEqual({ remoteId: 'existing' })
    expect(p.mayHaveSent('take_1')).toBe(true)
    expect(fetch.mock.calls).toHaveLength(1)
    expect(fetch.mock.calls[0][1].method).not.toBe('POST')
  })

  it('an unreadable recovery answer never falls through to a new POST', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{'))
    const p = make(fetch); await flush()
    await expect(p.submit(request(), { retryOfUnknown: true })).rejects.toMatchObject({ code: 'deferred' })
    expect(fetch.mock.calls).toHaveLength(1)
    expect(fetch.mock.calls[0][1].method).not.toBe('POST')
  })
})

describe('request token lifetime', () => {
  it('does not send an A job with B bearer when concurrent token reads resolve in one turn', async () => {
    let racing = false
    const pending: ((token: string) => void)[] = []
    const fetch = vi.fn(async (url: string) => url.endsWith('/capabilities') ? Response.json(caps) : new Response(null, { status: 404 }))
    const p = make(fetch, { token: () => racing ? new Promise<string>(resolve => pending.push(resolve)) : Promise.resolve(tokens.A) })
    await p.refreshLimits({ force: true }); racing = true; fetch.mockClear()
    const poll = p.poll(['job-A'])
    const refresh = p.refreshLimits({ force: true })
    pending[0](tokens.B); pending[1](tokens.A)
    expect(await poll).toEqual([])
    await refresh
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/video/capabilities'])
    expect(p.blockedReason()).toBeNull()
  })

  it('a token read that never settles cannot hold healthy poll results past the deadline', async () => {
    let stallNext = false
    let resolveOld!: (token: string) => void
    const fetch = vi.fn(async (url: string) => Response.json({ id: url.split('/').at(-1), status: 'done' }))
    const p = make(fetch, { token: () => {
      if (stallNext) { stallNext = false; return new Promise<string>(resolve => { resolveOld = resolve }) }
      return Promise.resolve(tokens.A)
    } })
    await flush(); stallNext = true
    let statuses: unknown = 'pending'
    const poll = p.poll(['stalled', 'healthy']).then(result => { statuses = result })
    await vi.advanceTimersByTimeAsync(REQUEST_MS + 1)
    expect(statuses).toEqual([{ remoteId: 'healthy', state: 'completed' }])
    resolveOld(tokens.B); await poll; await flush()
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/video/jobs/healthy'])
    expect(p.blockedReason(p.account() ?? undefined)).toBeNull()
  })

  it('a sequential account switch defers A; new B work still uses the B bearer', async () => {
    let token = tokens.A
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'job', status: 'running' }))
    const p = make(fetch, { token: async () => token }); await flush()
    const a = p.account()!; token = tokens.B
    expect(await p.poll(['A-job'])).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(p.blockedReason(a)).toBe(SANO_OTHER_ACCOUNT)
    expect(await p.poll(['B-job'])).toEqual([{ remoteId: 'B-job', state: 'processing' }])
    expect((fetch.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe(`Bearer ${tokens.B}`)
  })

  it('a stalled token before POST defers the take without marking it as sent', async () => {
    let stall = false
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json(caps))
    const p = make(fetch, { token: () => stall ? new Promise<string>(() => {}) : Promise.resolve(tokens.A) })
    await p.refreshLimits({ force: true }); stall = true; fetch.mockClear()
    const result = p.submit(request()).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(REQUEST_MS + 1)
    expect(await result).toMatchObject({ code: 'deferred' })
    expect(fetch).not.toHaveBeenCalled()
    expect(p.mayHaveSent('take_1')).toBe(false)
  })

  it('freshAccount and the watcher recover after a stalled host callback; late reset answers cannot restore A', async () => {
    const pending: ((token: string) => void)[] = []
    let stalled = true
    const p = make(async () => Response.json(caps), { token: () => stalled ? new Promise<string>(resolve => pending.push(resolve)) : Promise.resolve(tokens.B) })
    const fresh = p.freshAccount!()
    await vi.advanceTimersByTimeAsync(REQUEST_MS + 1)
    expect(await fresh).toBeNull()
    p.reset(); stalled = false
    const b = await p.freshAccount!()
    pending.forEach(resolve => resolve(tokens.A)); await flush()
    expect(p.account()).toBe(b)
    expect(p.tokenState()).toBe('ok')
  })
})

describe('capability reads', () => {
  it.each(['malformed JSON', 'body timeout', 'missing models'])('keeps good cache and simulator mode after %s', async (kind) => {
    let reads = 0
    const p = make(async (_url, init) => {
      if (++reads === 1) return Response.json(caps)
      if (kind === 'malformed JSON') return new Response('{"models":')
      if (kind === 'missing models') return Response.json({ mode: 'live' })
      return new Response(new ReadableStream({ start(controller) {
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true })
      } }))
    })
    await p.refreshLimits({ force: true })
    const before = p.limitsInfo().at
    const result = p.refreshLimits({ force: true })
    if (kind === 'body timeout') await vi.advanceTimersByTimeAsync(REQUEST_MS + 1)
    expect(await result).toBe('kept')
    expect(p.mode()).toBe('simulator')
    expect(p.limitsInfo().at).toBe(before)
    expect(p.settingsLimits().issues(request())).toEqual([])
  })

  it('accepts explicit models:[] as a valid firm empty list', async () => {
    const p = make(async () => Response.json({ models: [] }))
    expect(await p.refreshLimits({ force: true })).toBe('read')
    expect(p.settingsLimits().firm).toBe(true)
    expect(p.settingsLimits().issues(request())[0].field).toBe('model')
  })

  it('a first unreadable capabilities response is failed, not a firm empty model list', async () => {
    const p = make(async () => new Response('{'))
    expect(await p.refreshLimits({ force: true })).toBe('failed')
    expect(p.settingsLimits()).toMatchObject({ source: 'none', firm: false })
    expect(p.mode()).toBeNull()
  })
})

describe('result persistence lease and cancellation', () => {
  it('keeps two result slots until persistence releases them, including across reset', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    const p = make(fetch); await flush()
    const first = await p.fetchResult('1'), second = await p.fetchResult('2')
    await expect(p.fetchResult('3')).rejects.toMatchObject({ code: 'deferred' })
    p.reset(); await p.freshAccount!()
    await expect(p.fetchResult('3')).rejects.toMatchObject({ code: 'deferred' })
    release(first); release(first) // idempotent, cannot lend a third slot
    const third = await p.fetchResult('3')
    await expect(p.fetchResult('4')).rejects.toMatchObject({ code: 'deferred' })
    expect(fetch).toHaveBeenCalledTimes(3)
    release(second); release(third)
    const fourth = await p.fetchResult('4'); expect(fourth.video!.size).toBe(3); release(fourth)
  })

  it('failed downloads release their slot without a result lease', async () => {
    let good = false
    const p = make(async () => good ? new Response(new Uint8Array([1, 2, 3])) : new Response(null))
    await flush()
    for (let i = 0; i < 3; i++) await expect(p.fetchResult(String(i))).rejects.toMatchObject({ code: 'download' })
    good = true
    const result = await p.fetchResult('good'); expect(result.video!.size).toBe(3); release(result)
  })

  it('asks the server to cancel an uncached job, but skips a known running job', async () => {
    const fetch = vi.fn(async (url: string, _init: RequestInit) => Response.json({ id: url.split('/').at(-1), status: 'running' }))
    const p = make(fetch); await flush()
    await p.cancel('uncached')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/video/jobs/uncached/cancel'])
    expect(fetch.mock.calls[0][1].method).toBe('POST')
    await p.poll(['running'])
    fetch.mockClear()
    await p.cancel('running')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never asks to cancel an uncached job outside SANO', async () => {
    const fetch = vi.fn(async () => Response.json({}))
    const p = make(fetch, { available: () => false })
    await p.cancel('uncached')
    expect(fetch).not.toHaveBeenCalled()
  })
})
