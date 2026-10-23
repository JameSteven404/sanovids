// Provider 'sano-gateway' (providers/sano, D216 TH-15) against a fake SANO server: submit → poll → done → download, the
// idempotency key surviving a crash / a lost answer, 401 → the SANO sign-in error, the 20 MB refs cap before any
// request, cancel only while queued, and the provider off (and never chosen) outside SANO.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeGateway, activeProviderId, effectiveProvider, getProvider, normalizeProviderChoice, providerBlockedReason, selectableProviders } from '..'
import { applyDevAccessState, bareState } from '../devAccess'
import { sanoGatewayAvailable } from '../sano'
import { stubInsideSano } from './insideSano'
import { accountKey } from '../canvasapp/adapter'
import { createSanoGatewayProvider, DOWNLOAD_MS, REQUEST_MS, SANO_LOGIN_TEXT, SANO_NOW_LIVE, SANO_OTHER_ACCOUNT, SANO_UNAVAILABLE, TOKEN_RECHECK_MS, tokenAccount, type SanoGatewayDeps } from '../sano/gateway'
import { jwt } from './insideSano'
import { isResultTooLarge, isSubmitUncertain, ProviderError, type JobRequest } from '../types'

const req = (over: Partial<JobRequest> = {}): JobRequest => ({
  key: 'take_1',
  takeId: 'take_1',
  sceneId: 's',
  sanovidsProjectId: 'prj_a',
  sceneCode: 'S01',
  takeNumber: 1,
  title: '',
  color: '#fff',
  model: 'seedance_2_5',
  mode: 't2v',
  duration: 5,
  resolution: '720p',
  ratio: '16:9',
  prompt: '@image_1 chạy',
  rawPrompt: '@image_1 chạy',
  images: [],
  firstFrame: null,
  lastFrame: null,
  startedAt: 1000,
  ...over,
})

interface Job {
  id: string
  key: string
  status: string
  progress?: number
  mode?: string
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A SANO server in memory, keeping what each request was. */
function fakeSano() {
  const jobs = new Map<string, Job>()
  const video = new Uint8Array(300_000).map((_, i) => i % 251)
  const opts = { refuse401: (_path: string, _method: string, _auth?: string) => false, dropNextAnswer: false, mode: undefined as string | undefined }
  const fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url, 'https://sano.test')
    const method = init.method ?? 'GET'
    if (opts.refuse401(u.pathname, method, (init.headers as Record<string, string> | undefined)?.Authorization)) return json(401, { error: 'unauthenticated' })
    if (u.pathname === '/api/video/capabilities') {
      return json(200, { ...(opts.mode ? { mode: opts.mode } : {}), models: [{ id: 'seedance_2_5', label: 'Seedance 2.5', ratios: ['16:9', '9:16'], resolutions: ['720p'], durations: [5, 10], maxRefs: 4 }, { bad: true }] })
    }
    if (u.pathname === '/api/video/jobs' && method === 'POST') {
      const body = JSON.parse(String(init.body))
      const had = [...jobs.values()].find((j) => j.key === body.idempotencyKey)
      if (had) return json(200, { id: had.id, status: had.status, mode: had.mode })
      if (body.expectMode && body.expectMode !== opts.mode) return json(409, { error: 'Máy chủ SANO vừa đổi chế độ chạy — chưa tạo job, không tính phí.', mode: opts.mode })
      const job: Job = { id: `job_${jobs.size + 1}`, key: body.idempotencyKey, status: 'queued', mode: opts.mode }
      jobs.set(job.id, job)
      if (opts.dropNextAnswer) {
        opts.dropNextAnswer = false
        throw new TypeError('Failed to fetch') // created, but the answer never came back
      }
      return json(202, { id: job.id, status: job.status, ...(opts.mode ? { mode: opts.mode } : {}) })
    }
    if (u.pathname === '/api/video/jobs') {
      const had = [...jobs.values()].find((j) => j.key === u.searchParams.get('idempotencyKey'))
      return had ? json(200, { id: had.id, status: had.status, mode: had.mode }) : json(404, { error: 'not found' })
    }
    const m = u.pathname.match(/^\/api\/video\/jobs\/([^/]+)(\/result|\/cancel)?$/)
    const job = m ? jobs.get(decodeURIComponent(m[1])) : undefined
    if (!job) return json(404, { error: 'not found' })
    if (m![2] === '/cancel') {
      if (job.status === 'queued') job.status = 'failed'
      return json(200, { id: job.id, status: job.status })
    }
    if (m![2] === '/result') return new Response(video, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.length) } })
    return json(200, { id: job.id, status: job.status, mode: job.mode, ...(job.progress !== undefined ? { progress: job.progress } : {}) })
  })
  const calls = (method: string, path: string | RegExp) =>
    fetch.mock.calls.filter(([url, init]) => (init.method ?? 'GET') === method && (typeof path === 'string' ? url === path : path.test(url)))
  return { fetch, jobs, video, opts, calls }
}

function make(s: ReturnType<typeof fakeSano>, over: Partial<SanoGatewayDeps> = {}) {
  return createSanoGatewayProvider({ fetch: s.fetch, token: async () => 'tok', available: () => true, getBlob: async () => null, ...over })
}

const png = (bytes: number[]) => new Blob([new Uint8Array(bytes)], { type: 'image/png' })

describe('sano-gateway provider', () => {
  it('submit → poll → done → fetchResult, with the take id as idempotency key and the SANO auth', async () => {
    const s = fakeSano()
    const p = make(s)
    const { remoteId } = await p.submit(req({ images: [{ n: 1, assetId: 'a', imageId: 'img_1', blob: png([1, 2, 3]) }] }))
    expect(remoteId).toBe('job_1')
    const [[url, init]] = s.calls('POST', '/api/video/jobs')
    expect(url).toBe('/api/video/jobs')
    expect(init.credentials).toBe('omit') // bearer only: no ambient SANO cookie of another account
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(String(init.body))).toEqual({
      idempotencyKey: 'take_1',
      model: 'seedance_2_5',
      prompt: '@image_1 chạy',
      settings: { ratio: '16:9', resolution: '720p', duration: 5 },
      refs: [{ name: 'image_1', mime: 'image/png', data: 'AQID' }],
    })
    // what /capabilities said now shapes capabilities() (malformed entries dropped)
    expect(p.capabilities('seedance_2_5')).toMatchObject({ durations: [5, 10], resolutions: ['720p'], ratios: ['16:9', '9:16'], maxRefImages: 4 })
    expect(p.settingsLimits()).toMatchObject({ source: 'server', firm: true })

    Object.assign(s.jobs.get('job_1')!, { status: 'running', progress: 40 })
    expect(await p.poll(['job_1'])).toEqual([{ remoteId: 'job_1', state: 'processing', progress: 40 }])
    Object.assign(s.jobs.get('job_1')!, { status: 'unknown', progress: undefined })
    expect(await p.poll(['job_1'])).toEqual([]) // no news: asked again next time
    s.jobs.get('job_1')!.status = 'done'
    expect(await p.poll(['job_1', 'job_gone'])).toEqual([
      { remoteId: 'job_1', state: 'completed' },
      { remoteId: 'job_gone', state: 'failed', error: 'Máy chủ SANO không còn job này.' },
    ])

    const seen: { received: number; total: number | null }[] = []
    const ctrl = new AbortController()
    const result = await p.fetchResult('job_1', { signal: ctrl.signal, onProgress: (x) => seen.push(x) })
    expect(new Uint8Array(await result.video!.arrayBuffer())).toEqual(s.video)
    expect(result.video!.type).toBe('video/mp4')
    expect(seen.at(-1)).toEqual({ received: s.video.length, total: s.video.length })
    const sent = s.calls('GET', '/api/video/jobs/job_1/result')[0][1].signal!
    ctrl.abort()
    expect(sent.aborted).toBe(true) // the engine's cancel still stops the download
  })

  it('poll: a status request that never answers (half-open connection) is cut — no news for that job, the others come', async () => {
    vi.useFakeTimers()
    try {
      const s = fakeSano()
      const p = make(s)
      await p.submit(req())
      const inner = s.fetch.getMockImplementation()!
      s.fetch.mockImplementation((url, init) =>
        url.endsWith('/jobs/job_stall') ? new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason))) : inner(url, init),
      )
      const polled = p.poll(['job_1', 'job_stall'])
      await vi.advanceTimersByTimeAsync(REQUEST_MS)
      expect(await polled).toEqual([{ remoteId: 'job_1', state: 'queued' }])
      p.reset()
    } finally {
      vi.useRealTimers()
    }
  })

  it('poll: one job answering 500 does not hide the others; all failing still throws', async () => {
    const s = fakeSano()
    const p = make(s)
    await p.submit(req())
    s.jobs.get('job_1')!.status = 'done'
    const inner = s.fetch.getMockImplementation()!
    s.fetch.mockImplementation(async (url, init) => (url.endsWith('/jobs/job_bad') ? json(500, { error: 'boom' }) : inner(url, init)))
    expect(await p.poll(['job_1', 'job_bad'])).toEqual([{ remoteId: 'job_1', state: 'completed' }])
    await expect(p.poll(['job_bad'])).rejects.toMatchObject({ code: 'server' })
  })

  it('refuses what SANO does not run before any POST', async () => {
    const s = fakeSano()
    const p = make(s)
    await expect(p.submit(req({ resolution: '1080p' }))).rejects.toMatchObject({ code: 'refused' })
    await expect(p.submit(req({ model: 'minimax_h3' }))).rejects.toMatchObject({ code: 'refused' })
    expect(p.settingsLimits().issues({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '720p', ratio: '1:1' }).map((i) => i.field)).toEqual(['duration', 'ratio'])
    // the advertised maxRefs (4) is a refusal the run check sees too, not only the submit
    const ok = { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '720p', ratio: '16:9' } as const
    expect(p.settingsLimits().issues(ok, 4)).toEqual([])
    expect(p.settingsLimits().issues(ok, 5).map((i) => i.reason)).toEqual(['Seedance 2.5 trên SANO nhận tối đa 4 ảnh tham chiếu (đang có 5).'])
    const five = [1, 2, 3, 4, 5].map((n) => ({ n, assetId: 'a', imageId: `img_${n}`, blob: png([n]) }))
    await expect(p.submit(req({ images: five }))).rejects.toMatchObject({ code: 'refused' })
    expect(s.calls('POST', '/api/video/jobs')).toHaveLength(0)
  })

  it("the host's token() failing is a read with no token: the sign-in deferral before the POST (nothing sent), never the host's error", async () => {
    const s = fakeSano()
    let asked = 0
    // the read at creation and /capabilities get one, the POST's read fails
    const p = make(s, { token: async () => (asked++ > 1 ? Promise.reject(new Error('host gone')) : 'tok') })
    const err = await p.submit(req()).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'deferred', message: SANO_LOGIN_TEXT })
    expect(p.blockedReason()).toBe(SANO_LOGIN_TEXT) // takes wait for the sign-in
    expect(isSubmitUncertain(err)).toBe(false)
    expect(p.mayHaveSent('take_1')).toBe(false)
    expect(s.calls('POST', '/api/video/jobs')).toHaveLength(0)
  })

  it("mode: what /capabilities and the jobs say, missing is never 'live'; a simulator job is marked simulated", async () => {
    const s = fakeSano()
    const p = make(s)
    await p.refreshLimits({ force: true })
    expect(p.mode()).toBeNull()
    s.opts.mode = 'simulator'
    expect(await p.submit(req())).toEqual({ remoteId: 'job_1', simulated: true })
    expect(p.mode()).toBe('simulator')
    s.opts.mode = 'live'
    await p.refreshLimits({ force: true })
    expect(p.mode()).toBe('live')
    // the old simulator job polled / recovered / resent (200) marks only its take: SANO runs live now
    await p.poll(['job_1'])
    expect(await p.recover(req())).toEqual({ remoteId: 'job_1', simulated: true })
    expect(await p.submit(req())).toEqual({ remoteId: 'job_1', simulated: true })
    expect(p.mode()).toBe('live')
    expect(await p.submit(req({ key: 'take_2', takeId: 'take_2' }))).toEqual({ remoteId: 'job_2' })
    s.opts.mode = 'bogus'
    await p.refreshLimits({ force: true })
    expect(p.mode()).toBeNull()
  })

  it("a take queued under the simulator (no fee said) is POSTed expecting it: SANO live now → 409, refused (never uncertain), nothing made; a job of its earlier send is that one", async () => {
    const s = fakeSano()
    const told = vi.fn()
    const p = make(s, { onLimitsChange: told })
    s.opts.mode = 'simulator'
    await p.refreshLimits({ force: true })
    s.opts.mode = 'live' // the read above stays firm for 10 min: only SANO's POST sees it
    told.mockClear()
    const err = await p.submit(req({ expectSimulated: true })).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'refused', message: SANO_NOW_LIVE })
    expect(isSubmitUncertain(err)).toBe(false)
    expect(JSON.parse(String(s.calls('POST', '/api/video/jobs')[0][1].body))).toMatchObject({ expectMode: 'simulator' })
    expect(s.jobs.size).toBe(0)
    expect(p.mode()).toBe('live') // the Run dialog no longer promises no fee
    expect(told).toHaveBeenCalled() // and an open dialog re-reads it now
    s.jobs.set('job_9', { id: 'job_9', key: 'take_1', status: 'done', mode: 'simulator' }) // its earlier answer was lost
    expect(await p.submit(req({ expectSimulated: true }), { retryOfUnknown: true })).toEqual({ remoteId: 'job_9', simulated: true })
    // a 409 naming no mode (this key already used for another request) stays SANO's own refusal
    const inner = s.fetch.getMockImplementation()!
    s.fetch.mockImplementation(async (url, init) => (init.method === 'POST' ? json(409, { error: 'idempotencyKey này đã dùng cho một yêu cầu khác.' }) : inner(url, init)))
    await expect(p.submit(req({ key: 'take_2', expectSimulated: true }))).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('đã dùng cho một yêu cầu khác') })
  })

  it('recover: a 5xx or a lost connection is no answer (deferred, asked again later); only a 404 says there is no job', async () => {
    const s = fakeSano()
    const p = make(s)
    const inner = s.fetch.getMockImplementation()!
    s.fetch.mockImplementation(async (url, init) => (url.includes('idempotencyKey') ? json(503, { error: 'busy' }) : inner(url, init)))
    await expect(p.recover(req())).rejects.toMatchObject({ code: 'deferred' })
    s.fetch.mockImplementation(async (url, init) => {
      if (url.includes('idempotencyKey')) throw new TypeError('Failed to fetch')
      return inner(url, init)
    })
    await expect(p.recover(req())).rejects.toMatchObject({ code: 'deferred' })
    s.fetch.mockImplementation(inner)
    expect(await p.recover(req())).toBeNull()
  })

  it('a 200 /result with no bytes is a failed download (retried), never an empty video', async () => {
    const s = fakeSano()
    const p = make(s)
    await p.submit(req())
    const inner = s.fetch.getMockImplementation()!
    s.fetch.mockImplementation(async (url, init) => (url.endsWith('/result') ? new Response(new Uint8Array(0), { headers: { 'Content-Length': '0' } }) : inner(url, init)))
    await expect(p.fetchResult('job_1')).rejects.toMatchObject({ code: 'download' })
  })

  it('the same idempotency key after a crash recovers the existing job instead of submitting again', async () => {
    const s = fakeSano()
    await make(s).submit(req())
    // the page reloaded before the job id was saved: a new instance, nothing in memory
    const after = make(s)
    expect(after.mayHaveSent('take_1')).toBe(false)
    expect(await after.recover(req())).toEqual({ remoteId: 'job_1' })
    expect(after.mayHaveSent('take_1')).toBe(true)
    expect(await after.recover(req({ key: 'take_2' }))).toBeNull()
    expect(s.calls('POST', '/api/video/jobs')).toHaveLength(1)
    expect(s.jobs.size).toBe(1)
  })

  it('a lost answer is uncertain; resending the same key finds the same job (never a second one)', async () => {
    const s = fakeSano()
    const p = make(s)
    s.opts.dropNextAnswer = true
    const err = await p.submit(req()).catch((e: unknown) => e)
    expect(isSubmitUncertain(err)).toBe(true)
    expect(p.mayHaveSent('take_1')).toBe(true)
    expect(await p.submit(req(), { retryOfUnknown: true })).toEqual({ remoteId: 'job_1' })
    expect(s.jobs.size).toBe(1)
  })

  it('stops before the POST when the take was cancelled (nothing sent, mayHaveSent stays false)', async () => {
    const s = fakeSano()
    const p = make(s)
    await expect(p.submit(req(), { isCancelled: () => true })).rejects.toMatchObject({ code: 'cancelled' })
    expect(p.mayHaveSent('take_1')).toBe(false)
    expect(s.calls('POST', '/api/video/jobs')).toHaveLength(0)
  })

  it('401 (a token SANO refuses): deferred with the sign-in text (nothing made, never "maybe billed"), that token is never sent again, a new one is', async () => {
    const s = fakeSano()
    let token = 'tok'
    const told = vi.fn()
    const p = make(s, { token: async () => token, onLimitsChange: told })
    s.opts.refuse401 = (path, _m, auth) => {
      const refuse = auth === 'Bearer tok' && path.startsWith('/api/video/jobs')
      if (refuse) told.mockClear()
      return refuse
    }
    const err = await p.submit(req()).catch((e: unknown) => e)
    expect(told).toHaveBeenCalledTimes(1) // the app hears of the 401 at once (the queue's wait banner), not 3 s later
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'deferred', message: SANO_LOGIN_TEXT })
    expect(isSubmitUncertain(err)).toBe(false)
    expect(p.tokenState()).toBe('refused')
    expect(p.blockedReason()).toBe(SANO_LOGIN_TEXT)
    const sent = s.fetch.mock.calls.length // /capabilities + the refused POST
    expect(s.calls('POST', '/api/video/jobs')).toHaveLength(1)
    expect(await p.poll(['job_1'])).toEqual([]) // no news, no back-off
    await expect(p.fetchResult('job_1')).rejects.toMatchObject({ code: 'deferred' })
    expect(await p.refreshLimits({ force: true })).toBe('login')
    expect(p.limitsInfo().lastAttempt?.result).toBe('login')
    expect(s.fetch).toHaveBeenCalledTimes(sent)
    token = 'tok2' // signed in again in SANO
    expect((await p.submit(req())).remoteId).toBe('job_1')
    expect(p.blockedReason()).toBeNull()
  })

  it("a JWT whose exp is past by this PC's clock (running ahead) is still sent: only SANO's 401 says a token is dead", async () => {
    const s = fakeSano()
    const p = make(s, { token: async () => jwt({ sub: 'A', exp: 1_000 }), now: () => 2_000_000 })
    expect(await p.refreshLimits({ force: true })).toBe('read')
    expect((await p.submit(req())).remoteId).toBe('job_1')
    expect(p.tokenState()).toBe('ok')
    expect(p.blockedReason()).toBeNull()
  })

  it('reads the token from its creation inside SANO: before that first read ends nothing says "sign in" (the first ▶ after load goes); its end is told', async () => {
    const s = fakeSano()
    const token = vi.fn(async (): Promise<string | null> => jwt({ sub: 'A' }))
    const p = make(s, { token })
    expect(token).toHaveBeenCalledTimes(1) // started with the gateway, before any look
    expect(p.blockedReason()).toBeNull() // a ▶ right now is not refused: its request waits for the token
    const told = vi.fn()
    const out = make(s, { token: async () => null, onLimitsChange: told })
    expect(out.blockedReason()).toBeNull()
    await vi.waitFor(() => expect(out.blockedReason()).toBe(SANO_LOGIN_TEXT)) // read: not signed in
    expect(told).toHaveBeenCalledTimes(1) // the run gates / Settings / the queue re-read it
    expect(p.account()).toBe(accountKey('A'))
    // outside SANO the host's token is never read (no recheck either)
    const outside = vi.fn(async () => 'tok')
    expect(make(s, { token: outside, available: () => false }).tokenState()).toBe('none')
    expect(outside).not.toHaveBeenCalled()
    p.reset()
    out.reset()
  })

  it("the host's token read out of order: the newest read's answer stands; a stalled read is waited for, not piled up", async () => {
    vi.useFakeTimers()
    try {
      const answers: ((t: string) => void)[] = []
      const token = vi.fn(() => new Promise<string>((r) => answers.push(r)))
      const p = make(fakeSano(), { token }) // read 1: the watcher's, at creation
      await vi.advanceTimersByTimeAsync(3 * TOKEN_RECHECK_MS)
      expect(token).toHaveBeenCalledTimes(1)
      const fresh = p.freshAccount!() // read 2: a ▶ after a switch to B
      answers[1](jwt({ sub: 'B' }))
      expect(await fresh).toBe(accountKey('B'))
      answers[0](jwt({ sub: 'A' })) // the older read answers last
      await vi.advanceTimersByTimeAsync(0)
      expect(p.account()).toBe(accountKey('B'))
      p.reset()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a download still open after DOWNLOAD_MS is cut as 'too-slow' (no Range: a new try from 0 would hit it again)", async () => {
    vi.useFakeTimers()
    try {
      const s = fakeSano()
      const p = make(s)
      const { remoteId } = await p.submit(req())
      const inner = s.fetch.getMockImplementation()!
      s.fetch.mockImplementation(async (url, init) =>
        url.endsWith('/result')
          ? new Response(new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array([1])), init.signal?.addEventListener('abort', () => c.error(init.signal!.reason))) }))
          : inner(url, init),
      )
      const got = p.fetchResult(remoteId, { signal: new AbortController().signal }).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(DOWNLOAD_MS)
      expect(await got).toMatchObject({ code: 'too-slow' })
      p.reset()
    } finally {
      vi.useRealTimers()
    }
  })

  it('downloads at most two SANO videos at once (each held whole in memory): another is deferred, nothing fetched', async () => {
    const s = fakeSano()
    const p = make(s)
    const ids: string[] = []
    for (const k of ['take_1', 'take_2', 'take_3']) ids.push((await p.submit(req({ key: k, takeId: k }))).remoteId)
    const [a, b, c] = await Promise.allSettled(ids.map((id) => p.fetchResult(id)))
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled'])
    expect(c).toMatchObject({ status: 'rejected', reason: { code: 'deferred' } }) // the engine asks again later
    expect(s.calls('GET', /\/result$/)).toHaveLength(2)
    expect((await p.fetchResult(ids[2])).video?.size).toBe(s.video.length) // a slot is free again
  })

  it("a token's account comes from its base64url payload (Google's: '-' / '_', a Vietnamese name in UTF-8)", () => {
    const token = jwt({ sub: '1091', name: 'Trần Thị Bích Ngọc' })
    expect(token).toMatch(/-|_/) // what the decoding must map back
    expect(tokenAccount(token)).toBe(accountKey('1091'))
    expect(tokenAccount('not-a-jwt')).toBeUndefined()
  })

  it("jobs are per SANO account: another account's take is blocked, and a job request whose token turned out to be another account's is never sent", async () => {
    const s = fakeSano()
    const [tokA, tokB] = [jwt({ sub: 'A' }), jwt({ sub: 'B' })]
    let token = tokA
    const p = make(s, { token: async () => token })
    await p.refreshLimits({ force: true }) // read: the engine sends only once the state is 'ok' (its account known)
    const { remoteId } = await p.submit(req())
    const a = p.account()!
    expect(a).toBe(accountKey('A')) // the sub as a key, never itself
    expect(p.blockedReason(a)).toBeNull()
    token = tokB // switched in SANO, not read here yet: the engine still chose this job for A
    expect(await p.poll([remoteId])).toEqual([])
    expect(s.calls('GET', `/api/video/jobs/${remoteId}`)).toHaveLength(0)
    expect(p.blockedReason(a)).toBe(SANO_OTHER_ACCOUNT)
    expect(p.blockedReason()).toBeNull() // a new take goes under B
    token = tokA
    await expect(p.recover(req())).rejects.toMatchObject({ code: 'deferred', message: SANO_OTHER_ACCOUNT })
    expect(s.calls('GET', /idempotencyKey/)).toHaveLength(0)
    expect(p.blockedReason(a)).toBeNull() // A again: its take goes on
    token = tokB // switched again, not read yet: a cancel of A's queued job is never sent under B
    await p.cancel(remoteId)
    expect(s.calls('POST', /\/cancel$/)).toHaveLength(0)
    p.reset() // forgets the token too
    expect(p.tokenState()).toBe('none')
  })

  it('no token yet (not signed in to SANO): deferred with the sign-in text before any request; poll is no news', async () => {
    const s = fakeSano()
    let token: string | null = null
    const p = make(s, { token: async () => token })
    await expect(p.submit(req())).rejects.toMatchObject({ code: 'deferred', message: SANO_LOGIN_TEXT })
    await expect(p.recover(req())).rejects.toMatchObject({ code: 'deferred', message: SANO_LOGIN_TEXT })
    expect(await p.poll(['job_1'])).toEqual([])
    await expect(p.fetchResult('job_1')).rejects.toMatchObject({ code: 'deferred' })
    expect(await p.refreshLimits({ force: true })).toBe('login')
    expect(p.limitsInfo().lastAttempt?.result).toBe('login')
    expect(p.tokenState()).toBe('none')
    expect(p.blockedReason()).toBe(SANO_LOGIN_TEXT)
    expect(p.mayHaveSent('take_1')).toBe(false)
    expect(s.fetch).not.toHaveBeenCalled()
    token = 'tok' // signed in: the same take goes
    expect((await p.submit(req())).remoteId).toBe('job_1')
  })

  it('refs over the 20 MB cap → too-large without a request', async () => {
    const s = fakeSano()
    const p = make(s)
    // 15 MiB + 1 byte → its base64 is just over 20 MiB
    const big = new Blob([new Uint8Array(15 * 1024 * 1024 + 1)], { type: 'image/jpeg' })
    const err = await p.submit(req({ images: [{ n: 1, assetId: 'a', imageId: 'img_1', blob: big }] })).catch((e: unknown) => e)
    expect(isResultTooLarge(err)).toBe(true)
    expect(s.fetch).not.toHaveBeenCalled()
  })

  it('cancel asks SANO only while the job is queued, and never throws', async () => {
    const s = fakeSano()
    const p = make(s)
    const queued = await p.submit(req())
    await p.cancel(queued.remoteId)
    expect(s.calls('POST', /\/cancel$/)).toHaveLength(1)
    const running = await p.submit(req({ key: 'take_2', takeId: 'take_2' }))
    s.jobs.get(running.remoteId)!.status = 'running'
    await p.poll([running.remoteId])
    await p.cancel(running.remoteId)
    expect(s.calls('POST', /\/cancel$/)).toHaveLength(1)
    // state not known (reset / a reload before the first poll): not asked either
    const later = await p.submit(req({ key: 'take_3', takeId: 'take_3' }))
    p.reset()
    await p.cancel(later.remoteId)
    expect(s.calls('POST', /\/cancel$/)).toHaveLength(1)
    const broken = make({ ...s, fetch: vi.fn(async () => Promise.reject(new TypeError('offline'))) })
    await expect(broken.cancel('job_x')).resolves.toBeUndefined()
  })

  it("unavailable outside SANO: sends nothing, a submit is deferred (not failed); reads are no news (another origin's 404 never fails a take)", async () => {
    const s = fakeSano()
    const p = make(s, { available: () => false })
    expect(await p.available()).toEqual({ ok: false, reason: SANO_UNAVAILABLE })
    expect(p.blockedReason()).toBe(SANO_UNAVAILABLE)
    await expect(p.submit(req())).rejects.toMatchObject({ code: 'deferred' })
    expect(await p.refreshLimits()).toBe('unavailable')
    expect(await p.poll(['job_1'])).toEqual([])
    await expect(p.recover(req())).rejects.toMatchObject({ code: 'deferred' })
    await expect(p.fetchResult('job_1')).rejects.toMatchObject({ code: 'deferred' })
    expect(s.fetch).not.toHaveBeenCalled()
  })
})

describe('sano-gateway in the registry', () => {
  afterEach(() => {
    getProvider('sano-gateway').reset?.()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    applyDevAccessState(bareState('build'))
  })

  it('on only for the flagged build in an iframe of a same-origin page, whatever sets __SANO_GATEWAY__', async () => {
    stubInsideSano()
    await vi.waitFor(() => expect(providerBlockedReason('sano-gateway')).toBe(SANO_LOGIN_TEXT)) // inside SANO: only the sign-in is missing
    vi.stubEnv('VITE_SANO_GATEWAY', '') // the public web build, even framed
    expect(sanoGatewayAvailable()).toBe(false)
    stubInsideSano({ bdpDesktop: {} }) // Electron
    expect(providerBlockedReason('sano-gateway')).toBe(SANO_UNAVAILABLE)
    // SANO's /sanovids/ opened in a plain tab, even with the host object on the page
    const tab: Record<string, unknown> = { location: { origin: 'https://sano.example' }, __SANO_GATEWAY__: {} }
    tab.parent = tab
    vi.stubGlobal('window', tab)
    expect(providerBlockedReason('sano-gateway')).toBe(SANO_UNAVAILABLE)
    const crossOrigin = {
      get location(): never {
        throw new DOMException('Blocked a frame', 'SecurityError')
      },
    }
    vi.stubGlobal('window', { location: { origin: 'https://sano.example' }, parent: crossOrigin })
    expect(sanoGatewayAvailable()).toBe(false)
  })

  it("the flagged build in a plain tab: new takes are SANO's, refused with SANO_UNAVAILABLE (not canvasapp's desktop app)", () => {
    vi.stubEnv('VITE_SANO_GATEWAY', '1')
    vi.stubGlobal('window', { location: { origin: 'https://sano.example' } })
    applyDevAccessState(bareState('locked'))
    expect(activeProviderId()).toBe('sano-gateway')
    expect(providerBlockedReason(activeProviderId())).toBe(SANO_UNAVAILABLE)
    expect(selectableProviders()).toEqual(['canvasapp', 'sano-gateway'])
  })

  it('outside SANO: never offered, never chosen, refused', () => {
    expect(sanoGatewayAvailable()).toBe(false)
    expect(selectableProviders()).not.toContain('sano-gateway')
    expect(providerBlockedReason('sano-gateway')).toBe(SANO_UNAVAILABLE)
    expect(effectiveProvider({ access: 'build', saved: 'sano-gateway', bridge: true })).toBe('dev')
    expect(effectiveProvider({ access: 'locked', saved: 'sano-gateway', bridge: false })).toBe('canvasapp')
    expect(normalizeProviderChoice('sano-gateway')).toBe('sano-gateway')
  })

  it('inside SANO: chosen while locked on the web or when picked; Electron keeps canvasapp', async () => {
    expect(effectiveProvider({ access: 'locked', saved: 'dev', bridge: false, sano: true })).toBe('sano-gateway')
    expect(effectiveProvider({ access: 'locked', saved: 'canvasapp', bridge: true, sano: true })).toBe('canvasapp')
    expect(effectiveProvider({ access: 'build', saved: 'dev', bridge: false, sano: true })).toBe('dev')
    expect(effectiveProvider({ access: 'build', saved: 'sano-gateway', bridge: true, sano: true })).toBe('sano-gateway')

    stubInsideSano({ __SANO_GATEWAY__: { token: async () => null } })
    applyDevAccessState(bareState('locked'))
    expect(sanoGatewayAvailable()).toBe(true)
    expect(activeProviderId()).toBe('sano-gateway')
    expect(selectableProviders()).toEqual(['canvasapp', 'sano-gateway'])
    await vi.waitFor(() => expect(providerBlockedReason('sano-gateway')).toBe(SANO_LOGIN_TEXT)) // not signed in to SANO yet
    expect(getProvider('sano-gateway').id).toBe('sano-gateway')
    // no canvasapp account in SANO: the canvasapp gateway stands in (no bridge on the web)
    expect(activeGateway().id).toBe('canvasapp')
    expect(activeGateway().bridge()).toBeNull()
  })
})
