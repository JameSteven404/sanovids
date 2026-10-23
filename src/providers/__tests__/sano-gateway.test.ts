// Provider 'sano-gateway' (providers/sano, D216 TH-15) against a fake SANO server: submit → poll → done → download, the
// idempotency key surviving a crash / a lost answer, 401 → the SANO sign-in error, the 20 MB refs cap before any
// request, cancel only while queued, and the provider off (and never chosen) outside SANO.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeGateway, activeProviderId, effectiveProvider, getProvider, normalizeProviderChoice, providerBlockedReason, selectableProviders } from '..'
import { applyDevAccessState, bareState } from '../devAccess'
import { sanoGatewayAvailable } from '../sano'
import { createSanoGatewayProvider, SANO_LOGIN_TEXT, SANO_UNAVAILABLE, type SanoGatewayDeps } from '../sano/gateway'
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
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A SANO server in memory, keeping what each request was. */
function fakeSano() {
  const jobs = new Map<string, Job>()
  const video = new Uint8Array(300_000).map((_, i) => i % 251)
  const opts = { refuse401: (_path: string, _method: string) => false, dropNextAnswer: false, mode: undefined as string | undefined }
  const fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url, 'https://sano.test')
    const method = init.method ?? 'GET'
    if (opts.refuse401(u.pathname, method)) return json(401, { error: 'unauthenticated' })
    if (u.pathname === '/api/video/capabilities') {
      return json(200, { ...(opts.mode ? { mode: opts.mode } : {}), models: [{ id: 'seedance_2_5', label: 'Seedance 2.5', ratios: ['16:9', '9:16'], resolutions: ['720p'], durations: [5, 10], maxRefs: 4 }, { bad: true }] })
    }
    if (u.pathname === '/api/video/jobs' && method === 'POST') {
      const body = JSON.parse(String(init.body))
      const had = [...jobs.values()].find((j) => j.key === body.idempotencyKey)
      if (had) return json(200, { id: had.id, status: had.status })
      const job: Job = { id: `job_${jobs.size + 1}`, key: body.idempotencyKey, status: 'queued' }
      jobs.set(job.id, job)
      if (opts.dropNextAnswer) {
        opts.dropNextAnswer = false
        throw new TypeError('Failed to fetch') // created, but the answer never came back
      }
      return json(202, { id: job.id, status: job.status, ...(opts.mode ? { mode: opts.mode } : {}) })
    }
    if (u.pathname === '/api/video/jobs') {
      const had = [...jobs.values()].find((j) => j.key === u.searchParams.get('idempotencyKey'))
      return had ? json(200, { id: had.id, status: had.status }) : json(404, { error: 'not found' })
    }
    const m = u.pathname.match(/^\/api\/video\/jobs\/([^/]+)(\/result|\/cancel)?$/)
    const job = m ? jobs.get(decodeURIComponent(m[1])) : undefined
    if (!job) return json(404, { error: 'not found' })
    if (m![2] === '/cancel') {
      if (job.status === 'queued') job.status = 'failed'
      return json(200, { id: job.id, status: job.status })
    }
    if (m![2] === '/result') return new Response(video, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.length) } })
    return json(200, { id: job.id, status: job.status, ...(job.progress !== undefined ? { progress: job.progress } : {}) })
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
    expect(init.credentials).toBe('include')
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
    expect(s.calls('GET', '/api/video/jobs/job_1/result')[0][1].signal).toBe(ctrl.signal)
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

  it("the host's token() failing before the POST is not an uncertain submit (nothing sent)", async () => {
    const s = fakeSano()
    let asked = 0
    const p = make(s, { token: async () => (asked++ ? Promise.reject(new Error('host gone')) : 'tok') }) // /capabilities gets one
    const err = await p.submit(req()).catch((e: unknown) => e)
    expect(err).toMatchObject({ message: 'host gone' })
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
    expect(await p.submit(req({ key: 'take_2', takeId: 'take_2' }))).toEqual({ remoteId: 'job_2' })
    s.opts.mode = 'bogus'
    await p.refreshLimits({ force: true })
    expect(p.mode()).toBeNull()
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

  it('401 → the SANO sign-in error, once (no retry loop), never "maybe billed"', async () => {
    const s = fakeSano()
    const p = make(s, { token: async () => null })
    s.opts.refuse401 = (path) => path.startsWith('/api/video/jobs')
    const err = await p.submit(req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'login-required', message: SANO_LOGIN_TEXT })
    expect(isSubmitUncertain(err)).toBe(false)
    expect(s.calls('POST', '/api/video/jobs')).toHaveLength(1)
    expect((s.calls('POST', '/api/video/jobs')[0][1].headers as Record<string, string>).Authorization).toBeUndefined()
    await expect(p.poll(['job_1'])).rejects.toMatchObject({ code: 'login-required' })
    await expect(p.fetchResult('job_1')).rejects.toMatchObject({ code: 'login-required' })
    s.opts.refuse401 = () => true
    expect(await p.refreshLimits({ force: true })).toBe('login')
    expect(p.limitsInfo().lastAttempt?.result).toBe('login')
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

  it("unavailable outside SANO: refuses, sends nothing; reads are no news (another origin's 404 never fails a take)", async () => {
    const s = fakeSano()
    const p = make(s, { available: () => false })
    expect(await p.available()).toEqual({ ok: false, reason: SANO_UNAVAILABLE })
    await expect(p.submit(req())).rejects.toMatchObject({ code: 'unavailable' })
    expect(await p.refreshLimits()).toBe('unavailable')
    expect(await p.poll(['job_1'])).toEqual([])
    await expect(p.recover(req())).rejects.toMatchObject({ code: 'deferred' })
    await expect(p.fetchResult('job_1')).rejects.toMatchObject({ code: 'deferred' })
    expect(s.fetch).not.toHaveBeenCalled()
  })
})

describe('sano-gateway in the registry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    applyDevAccessState(bareState('build'))
  })

  it('the build flag turns it on on the web, never inside Electron', () => {
    vi.stubEnv('VITE_SANO_GATEWAY', '1')
    vi.stubGlobal('window', {})
    expect(sanoGatewayAvailable()).toBe(true)
    vi.stubGlobal('window', { bdpDesktop: {} })
    expect(sanoGatewayAvailable()).toBe(false)
    vi.stubGlobal('window', { __SANO_GATEWAY__: {}, bdpDesktop: {} })
    expect(sanoGatewayAvailable()).toBe(false)
  })

  it('reads the host object of the same-origin SANO page around the iframe; a cross-origin parent is ignored', () => {
    vi.stubGlobal('window', { parent: { __SANO_GATEWAY__: {} } })
    expect(sanoGatewayAvailable()).toBe(true)
    const crossOrigin = {
      get __SANO_GATEWAY__(): never {
        throw new DOMException('Blocked a frame', 'SecurityError')
      },
    }
    vi.stubGlobal('window', { parent: crossOrigin })
    expect(sanoGatewayAvailable()).toBe(false)
  })

  it('outside SANO: never offered, never chosen, refused', () => {
    expect(sanoGatewayAvailable()).toBe(false)
    expect(selectableProviders()).not.toContain('sano-gateway')
    expect(providerBlockedReason('sano-gateway')).toBe(SANO_UNAVAILABLE)
    expect(effectiveProvider({ access: 'build', saved: 'sano-gateway', bridge: true })).toBe('dev')
    expect(effectiveProvider({ access: 'locked', saved: 'sano-gateway', bridge: false })).toBe('canvasapp')
    expect(normalizeProviderChoice('sano-gateway')).toBe('sano-gateway')
  })

  it('inside SANO: chosen while locked on the web or when picked; Electron keeps canvasapp', () => {
    expect(effectiveProvider({ access: 'locked', saved: 'dev', bridge: false, sano: true })).toBe('sano-gateway')
    expect(effectiveProvider({ access: 'locked', saved: 'canvasapp', bridge: true, sano: true })).toBe('canvasapp')
    expect(effectiveProvider({ access: 'build', saved: 'dev', bridge: false, sano: true })).toBe('dev')
    expect(effectiveProvider({ access: 'build', saved: 'sano-gateway', bridge: true, sano: true })).toBe('sano-gateway')

    vi.stubGlobal('window', { __SANO_GATEWAY__: { token: async () => null } })
    applyDevAccessState(bareState('locked'))
    expect(sanoGatewayAvailable()).toBe(true)
    expect(activeProviderId()).toBe('sano-gateway')
    expect(selectableProviders()).toEqual(['canvasapp', 'sano-gateway'])
    expect(providerBlockedReason('sano-gateway')).toBeNull()
    expect(getProvider('sano-gateway').id).toBe('sano-gateway')
    // no canvasapp account in SANO: the canvasapp gateway stands in (no bridge on the web)
    expect(activeGateway().id).toBe('canvasapp')
    expect(activeGateway().bridge()).toBeNull()
  })
})
