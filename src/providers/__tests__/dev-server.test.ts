// Development mode: the in-app simulated canvasapp.io.vn (providers/dev/server.ts) behind the simulated desktop gateway
// (providers/dev/bridge.ts), driven through the REAL api client + desktop transport (providers/canvasapp). No network.
// Endpoints and strict validation, idempotency, charging / refunds / history, the top-up lifecycle (simulated SePay
// sheet), faults, the request log, persistence / reset — and the gateway allowlist checked against electron/main.cjs.
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/imageStore', () => ({
  putBlob: vi.fn(async () => 'x'),
  getBlob: vi.fn(async () => null),
  getUrl: vi.fn(async () => null),
  cachedUrl: () => null,
  deleteMedia: vi.fn(async () => undefined),
  dataUrlToBlob: () => new Blob(),
  useMediaUrl: () => null,
}))

import mainSource from '../../../electron/main.cjs?raw'
import { costOf } from '../../core/models'
import { checkoutUrlAllowed, TOPUP_ORDER_TTL_MS } from '../../core/topup'
import { memoryStorage } from '../canvasapp/adapter'
import { CanvasappError, createCanvasappApi, type CanvasPayload, type TransportRequest } from '../canvasapp/api'
import { bridgeCanvas, canvasNodeId, clientRequestIdFor, uploadFilename, type BridgeEntry } from '../canvasapp/mapping'
import { createDesktopTransport, openCheckout } from '../canvasapp/transport'
import {
  answerDevCheckout,
  answerDevLogin,
  clearDevLog,
  closeDevPrompts,
  createDevBridge,
  createDevCanvasapp,
  defaultKeepLogin,
  DEV_CHECKOUT_ORIGIN,
  DEV_ENCRYPTIONS,
  DEV_ENDPOINTS,
  DEV_FAULT_PRESETS,
  DEV_KEEP_LOGIN_KEY,
  DEV_LOGIN_COOKIES,
  KEEP_LOGIN_DAYS,
  KEEP_LOGIN_NOT_CLEARED_TEXT,
  loginSurvivesRestart,
  DEV_LOG_MAX,
  DEV_PAYMENT_DELAY_MS,
  DEV_SPEED_MS,
  imageIdFromUploadFilename,
  matchDevRoute,
  memoryBlobStore,
  summarizeForLog,
  useDevLog,
  useDevPrompts,
  type DevConfig,
  type DevRenderInput,
} from '../dev'

type Json = Record<string, unknown>

/** electron/main.cjs's own endpoint allowlist (the <canvasapp-routes> block, run as-is). */
function loadMainRoutes(): (method: string, path: string) => unknown {
  const m = /\/\/ <canvasapp-routes>[^\n]*\n([\s\S]*?)\/\/ <\/canvasapp-routes>/.exec(mainSource)
  if (!m) throw new Error('canvasapp-routes block not found in electron/main.cjs')
  return (new Function('CANVASAPP_ORIGIN', `${m[1]}\nreturn matchCanvasappRoute`) as (o: string) => (method: string, path: string) => unknown)('https://canvasapp.io.vn')
}

const START = Date.parse('2026-10-02T10:00:00Z')

function setup(
  config: Partial<DevConfig> = {},
  opts: { storage?: ReturnType<typeof memoryStorage>; blobs?: ReturnType<typeof memoryBlobStore>; cacheMs?: number; t?: number; placement?: string; keepStore?: ReturnType<typeof memoryStorage> } = {},
) {
  const clock = { t: opts.t ?? START }
  const storage = opts.storage ?? memoryStorage()
  const blobs = opts.blobs ?? memoryBlobStore()
  const renders: { input: DevRenderInput; contents: (string | null)[] }[] = []
  const sleeps: number[] = []
  const server = createDevCanvasapp({
    storage,
    blobs,
    now: () => clock.t,
    random: () => 0.5,
    sleep: async (ms) => void sleeps.push(ms),
    render: async (input) => {
      renders.push({ input, contents: await Promise.all(input.images.map((i) => (i.blob ? i.blob.text() : Promise.resolve(null)))) })
      return new Blob([`WEBM:#${input.jobNumber}`], { type: 'video/webm' })
    },
  })
  server.setConfig({ latencyMs: 0, ...config })
  const keepStore = opts.keepStore ?? memoryStorage()
  const bridge = createDevBridge(() => server, { now: () => clock.t, jobListCacheMs: opts.cacheMs ?? 0, keepLoginStorage: keepStore, placement: () => opts.placement ?? 'installer' })
  const api = createCanvasappApi(createDesktopTransport(() => bridge))
  return { clock, storage, blobs, server, bridge, api, renders, sleeps, keepStore, advance: (ms: number) => void (clock.t += ms) }
}

type Setup = ReturnType<typeof setup>

/** Let pending promise chains run (no timers involved). */
async function until(cond: () => boolean, rounds = 200) {
  for (let i = 0; i < rounds && !cond(); i++) await Promise.resolve()
  if (!cond()) throw new Error('condition never met')
}

const png = (content: string) => new Blob([content], { type: 'image/png' })

/** Logged in, the bridge project, two uploads and a canvas with one Seedance node for scene s1. */
async function prepared(s: Setup) {
  s.server.login()
  const projectId = await s.api.createProject()
  await s.api.renameProject(projectId, 'SanoVids bridge')
  const u1 = await s.api.uploadImage(png('IMG:elara'), uploadFilename('img_elara', 'image/png'))
  const u2 = await s.api.uploadImage(png('IMG:lumi'), uploadFilename('img_lumi', 'image/png'))
  const entry: BridgeEntry = {
    sceneId: 's1',
    model: 'seedance_2_5',
    mode: 't2v',
    duration: 15,
    resolution: '1080p',
    ratio: '16:9',
    prompt: '@image_1 ôm @image_2',
    uploadIds: [u1, u2],
    firstFrameUploadId: null,
    lastFrameUploadId: null,
    usedAt: 1,
  }
  await s.api.putCanvas(projectId, bridgeCanvas([entry]))
  const body = (over: Json = {}): Json => ({
    project_id: projectId,
    model_profile: 'seedance_2_5',
    canvas_node_id: canvasNodeId('s1'),
    prompt: '@image_1 ôm @image_2',
    mode: 't2v',
    duration: 15,
    resolution: '1080p',
    generate_audio: true,
    upload_ids: [u1, u2],
    aspect_ratio: '16:9',
    client_request_id: clientRequestIdFor('take_1'),
    ...over,
  })
  return { projectId, u1, u2, entry, body }
}

const COST = costOf({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' })
const jobIdOf = (r: unknown) => (r as { job_id: string }).job_id

beforeEach(() => {
  clearDevLog()
  closeDevPrompts()
})
afterEach(() => {
  closeDevPrompts()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------------------------------------------

describe('dev server: account and login', () => {
  it('first run: logged out (401 everywhere but auth state), balance 1000, top-up on', async () => {
    const s = setup()
    expect(await s.api.authState()).toMatchObject({ authenticated: false, topup_enabled: true })
    await expect(s.api.me()).rejects.toMatchObject({ code: 'login-required' })
    await expect(s.api.listProjects()).rejects.toMatchObject({ code: 'login-required' })
    s.server.login()
    expect(await s.api.me()).toMatchObject({ credits_balance: 1000 })
    expect(await s.api.creditHistory()).toMatchObject({ balance: 1000, items: [{ type: 'adjustment', delta: 1000 }] })
  })

  it('bridge.login opens the simulated login sheet once (concurrent calls share it); "Đăng nhập (giả lập)" logs in', async () => {
    const s = setup()
    const a = s.bridge.login()
    const b = s.bridge.login()
    await until(() => useDevPrompts.getState().login !== null)
    expect(b).toBe(a)
    answerDevLogin(true)
    // like main: the login is kept on this (simulated) computer — installer default, encryption ok
    expect(await a).toEqual({ ok: true, authenticated: true, keepLogin: true })
    expect(useDevPrompts.getState().login).toBeNull()
    expect(await s.bridge.status()).toEqual({ ok: true, authenticated: true })
    // already logged in: no sheet
    expect(await s.bridge.login()).toEqual({ ok: true, authenticated: true })
    expect(useDevPrompts.getState().login).toBeNull()
  })

  it('closing the login sheet leaves it logged out; logout and an expired session answer 401 until the next login', async () => {
    const s = setup()
    const p = s.bridge.login()
    await until(() => useDevPrompts.getState().login !== null)
    answerDevLogin(false)
    expect(await p).toEqual({ ok: true, authenticated: false })
    s.server.login()
    expect(await s.api.me()).toMatchObject({ credits_balance: 1000 })
    await s.bridge.logout()
    await expect(s.api.me()).rejects.toMatchObject({ code: 'login-required' })
    s.server.login()
    s.server.expireSession()
    await expect(s.api.videoProfiles()).rejects.toMatchObject({ code: 'login-required' })
    s.server.login()
    expect(await s.api.videoProfiles()).toHaveLength(2)
  })

  it('video profiles have the real shape; can_create / disabled modes follow the dev settings', async () => {
    const s = setup()
    s.server.login()
    const all = await s.api.videoProfiles()
    expect(all.map((p) => p.model_profile)).toEqual(['seedance_2_5', 'minimax_h3'])
    expect(all[1]).toMatchObject({ display_name: 'MiniMax-H3', can_create: true, options: { modes: ['t2v', 'i2v', 'transform'], disabled_modes: [], durations: [5, 10, 15] } })
    s.server.setConfig({ models: { ...s.server.config().models, minimax_h3: { can_create: false, disabled_modes: ['transform'] } } })
    expect((await s.api.videoProfiles())[1]).toMatchObject({ can_create: false, enabled: false, options: { disabled_modes: ['transform'] } })
  })
})

describe('dev server: "Giữ đăng nhập" and a simulated restart of the desktop app', () => {
  const DAY = 86_400_000
  const keepRules = createRequire(import.meta.url)('../../../electron/keeplogin-rules.cjs') as {
    KEEP_LOGIN_DAYS: number
    KEEP_LOGIN_NOT_CLEARED_TEXT: string
    defaultKeepLogin: (k: unknown) => boolean
  }

  it('mirrors main: 30 days, the placement default and the "not cleared" text', () => {
    expect(KEEP_LOGIN_DAYS).toBe(keepRules.KEEP_LOGIN_DAYS)
    expect(KEEP_LOGIN_NOT_CLEARED_TEXT).toBe(keepRules.KEEP_LOGIN_NOT_CLEARED_TEXT)
    for (const k of ['installer', 'dev', 'portable', 'temp-copy', 'unknown', undefined, null, '']) expect(defaultKeepLogin(k as string)).toBe(keepRules.defaultKeepLogin(k))
  })

  it('every login cookie × switch × encryption: the login survives exactly when the rule says so', async () => {
    for (const loginCookie of DEV_LOGIN_COOKIES) {
      for (const keep of [true, false]) {
        for (const encryption of DEV_ENCRYPTIONS) {
          const s = setup({ loginCookie, encryption })
          s.server.login()
          await s.bridge.setKeepLogin(keep)
          const r = await s.bridge.simulateRestart()
          const want = loginSurvivesRestart({ authenticated: true, loginCookie, keepLogin: keep, encryption, daysSinceSaved: 0 })
          expect(r, `${loginCookie} ${keep} ${encryption}`).toMatchObject({ survived: want, keepLogin: keep })
          expect(r.outcome).toBe(loginCookie === 'persistent' ? 'persistent' : !keep ? 'keep-off' : encryption === 'ok' ? 'kept' : encryption === 'unavailable' ? 'encryption-unavailable' : 'decrypt-fails')
          expect(s.server.isAuthenticated()).toBe(want)
          if (want) expect(await s.api.me()).toMatchObject({ credits_balance: 1000 })
          else await expect(s.api.me()).rejects.toMatchObject({ code: 'login-required' })
        }
      }
    }
  })

  it('30 days from the login, not from use; the login time survives a reload of the simulated site', async () => {
    const storage = memoryStorage()
    const s = setup({}, { storage })
    s.server.login()
    s.advance(KEEP_LOGIN_DAYS * DAY)
    await s.api.me() // plain use does not extend it
    const reloaded = setup({}, { storage, t: s.clock.t })
    expect(await reloaded.bridge.simulateRestart()).toMatchObject({ survived: true, outcome: 'kept' })
    reloaded.advance(1)
    expect(await reloaded.bridge.simulateRestart()).toMatchObject({ survived: false, outcome: 'expired' })
    expect(reloaded.server.isAuthenticated()).toBe(false)
    // a new login starts a new 30 days
    reloaded.server.login()
    reloaded.advance(10 * DAY)
    expect(await reloaded.bridge.simulateRestart()).toMatchObject({ survived: true })
  })

  it('logged out before: nothing changes (an armed "Hết phiên" stays armed); faults and settings are the site’s', async () => {
    const s = setup({ loginCookie: 'persistent' })
    expect(await s.bridge.simulateRestart()).toMatchObject({ survived: false, outcome: 'not-logged-in' })
    s.server.login()
    s.server.expireSession()
    s.server.addFault({ endpoint: 'me', fault: { kind: 'network' }, sticky: true })
    expect(await s.bridge.simulateRestart()).toMatchObject({ outcome: 'not-logged-in' })
    expect(s.server.snapshot()).toMatchObject({ authenticated: false, sessionExpired: true, config: { loginCookie: 'persistent' } })
    expect(s.server.faults()).toHaveLength(1)
  })

  it('the switch: placement default (installer / source on, Portable / temp copy off), the user’s choice, strict input', async () => {
    for (const [placement, on] of [
      ['installer', true],
      ['dev', true],
      ['portable', false],
      ['temp-copy', false],
      ['unknown', false],
    ] as const) {
      expect(await setup({}, { placement }).bridge.keepLogin(), placement).toEqual({ ok: true, keepLogin: on, available: true, chosen: false })
    }
    const s = setup({}, { placement: 'portable' })
    expect(await s.bridge.setKeepLogin(true)).toEqual({ ok: true, keepLogin: true, available: true, chosen: true })
    expect(s.keepStore.get(DEV_KEEP_LOGIN_KEY)).toBe('true')
    expect(await s.bridge.setKeepLogin('yes' as unknown as boolean)).toMatchObject({ ok: false, code: 'bad-request' })
    expect(await s.bridge.keepLogin()).toMatchObject({ keepLogin: true })
    s.server.setConfig({ encryption: 'unavailable' })
    expect(await s.bridge.keepLogin()).toEqual({ ok: true, keepLogin: true, available: false, chosen: true })
    // a stored value that is not a boolean = never chose
    s.keepStore.set(DEV_KEEP_LOGIN_KEY, '1')
    expect(await s.bridge.keepLogin()).toMatchObject({ keepLogin: false, chosen: false })
  })

  it('login() says whether the login is kept (switch on AND the computer can encrypt)', async () => {
    const login = async (s: ReturnType<typeof setup>) => {
      const p = s.bridge.login()
      await until(() => useDevPrompts.getState().login !== null)
      answerDevLogin(true)
      return p
    }
    expect(await login(setup({}, { placement: 'portable' }))).toEqual({ ok: true, authenticated: true, keepLogin: false })
    expect(await login(setup({ encryption: 'unavailable' }))).toEqual({ ok: true, authenticated: true, keepLogin: false })
    expect(await login(setup({ encryption: 'decrypt-fails' }))).toEqual({ ok: true, authenticated: true, keepLogin: true })
  })

  it('settings are checked: unknown login cookie / encryption values fall back to the defaults', () => {
    const s = setup()
    s.server.setConfig({ loginCookie: 'forever' as never, encryption: 'maybe' as never })
    expect(s.server.config()).toMatchObject({ loginCookie: 'session', encryption: 'ok' })
    s.server.setConfig({ loginCookie: 'persistent', encryption: 'decrypt-fails' })
    expect(s.server.config()).toMatchObject({ loginCookie: 'persistent', encryption: 'decrypt-fails' })
  })

  it('fault "Đăng xuất: không xoá được bản sao": logged out all the same, the answer says so — once', async () => {
    const s = setup()
    s.server.login()
    s.server.setJobFaults({ logoutCopyStuck: true })
    expect(await s.bridge.logout()).toEqual({ ok: false, code: 'keep-login-not-cleared', message: KEEP_LOGIN_NOT_CLEARED_TEXT })
    expect(s.server.isAuthenticated()).toBe(false)
    expect(s.server.jobFaults().logoutCopyStuck).toBe(false)
    s.server.login()
    expect(await s.bridge.logout()).toEqual({ ok: true })
  })
})

describe('dev server: projects, canvas, uploads', () => {
  it('projects: POST without body (with a body → 422), PATCH {name}, list, GET with the saved canvas', async () => {
    const s = setup()
    const { projectId, entry } = await prepared(s)
    expect(await s.api.listProjects()).toEqual([{ project_id: projectId, name: 'SanoVids bridge' }])
    const got = await s.api.getProject(projectId)
    expect(got.canvas).toEqual(bridgeCanvas([entry]))
    const withBody = await s.bridge.request({ method: 'POST', path: '/api/projects', json: { name: 'x' } })
    expect(withBody).toMatchObject({ ok: true, status: 422 })
    await expect(s.api.renameProject(projectId, '   ')).rejects.toMatchObject({ code: 'bad-request', status: 422 })
    await expect(s.api.renameProject('nope', 'x')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('a canvas that is not canvasPayload()’s shape → 400 "Invalid canvas payload (<why>)", nothing saved', async () => {
    const s = setup()
    const { projectId, entry } = await prepared(s)
    const good = bridgeCanvas([entry])
    const extraTitle = { ...good, nodes: good.nodes.map((n) => (n.type === 'video' ? { ...n, data: { ...n.data, title: 'S01' } } : n)) } as unknown as CanvasPayload
    const e = await s.api.putCanvas(projectId, extraTitle).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(CanvasappError)
    expect((e as CanvasappError).message).toContain('Invalid canvas payload (video node data keys)')
    expect((e as CanvasappError).message).toContain('[PUT /api/projects/{id}/canvas · HTTP 400]')
    const xyViewport = { ...good, viewport: { x: 0, y: 0, zoom: 1 } } as unknown as CanvasPayload
    await expect(s.api.putCanvas(projectId, xyViewport)).rejects.toMatchObject({ status: 400, detail: 'Invalid canvas payload (viewport)' })
    const unknownUpload = bridgeCanvas([{ ...entry, uploadIds: ['not-uploaded'] }])
    await expect(s.api.putCanvas(projectId, unknownUpload)).rejects.toMatchObject({ detail: 'Invalid canvas payload (unknown upload_id)' })
    expect((await s.api.getProject(projectId)).canvas).toEqual(good)
  })

  it('uploads keep the file and its name: the dev UI maps upload_id → SanoVids image id; only JPG/PNG/WEBP', async () => {
    const s = setup()
    s.server.login()
    const id = await s.api.uploadImage(new Blob(['JPEG!'], { type: 'image/jpeg' }), uploadFilename('img_abc-123', 'image/jpeg'))
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await (await s.server.uploadBlob(id))!.text()).toBe('JPEG!')
    expect(s.server.snapshot().uploads[0]).toMatchObject({ upload_id: id, filename: 'img_abc-123.jpg', content_type: 'image/jpeg', size: 5, imageId: 'img_abc-123' })
    expect(imageIdFromUploadFilename('weird name.gif')).toBeNull()
    await expect(s.api.uploadImage(new Blob(['GIF'], { type: 'image/gif' }), 'a.gif')).rejects.toMatchObject({ code: 'bad-request', status: 400 })
  })
})

describe('dev server: video jobs', () => {
  it('accepts a runVideoNode() body, charges the real price, progresses by the clock and finishes', async () => {
    const s = setup()
    const { projectId, body } = await prepared(s)
    const r = await s.api.createVideoJob(body() as never)
    const jobId = jobIdOf(r)
    expect(r).toMatchObject({ status: 'queued' })
    expect(s.server.balance()).toBe(1000 - COST)
    const [debit] = (await s.api.creditHistory({ kind: 'video' })).items
    expect(debit).toMatchObject({ type: 'video', delta: -COST })

    // random 0.5 → queued for the middle of the range, total time in the middle of its range
    const queued = (DEV_SPEED_MS.fast.queued[0] + DEV_SPEED_MS.fast.queued[1]) / 2
    const total = (DEV_SPEED_MS.fast.total[0] + DEV_SPEED_MS.fast.total[1]) / 2
    expect((await s.api.listVideoJobs(projectId))[0]).toMatchObject({ job_id: jobId, status: 'queued', progress: 0, canvas_node_id: canvasNodeId('s1'), creation_mode: 'canvas' })
    s.advance(queued + (total - queued) / 2)
    const mid = (await s.api.listVideoJobs(projectId))[0]
    expect(mid).toMatchObject({ status: 'processing', download_available: false })
    expect(mid.progress).toBe(50)
    expect(mid).not.toHaveProperty('client_request_id') // like the live list (unknown): off by default
    s.advance(total)
    expect((await s.api.listVideoJobs(projectId))[0]).toMatchObject({ status: 'completed', progress: 100, download_available: true })
    expect(await s.api.jobPrompt(jobId)).toBe('@image_1 ôm @image_2')
  })

  it('strict like canvasapp: wrong keys / ids / uploads / limits / profiles are refused and nothing is charged', async () => {
    const s = setup()
    const { body, u1 } = await prepared(s)
    const refused = async (b: Json) => {
      const e = await s.api.createVideoJob(b as never).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(CanvasappError)
      return { status: (e as CanvasappError).status, detail: (e as CanvasappError).detail }
    }
    expect(await refused(body({ client_request_id: 'take_1' }))).toEqual({ status: 422, detail: 'client_request_id must be a UUID' })
    expect(await refused({ ...body(), title: 'S01' })).toEqual({ status: 422, detail: 'unexpected job fields' })
    expect(await refused(body({ upload_ids: [u1, 'nope'] }))).toEqual({ status: 400, detail: 'unknown upload_id' })
    expect(await refused(body({ resolution: '1080P' }))).toEqual({ status: 400, detail: 'resolution not available' })
    expect(await refused(body({ canvas_node_id: canvasNodeId('other') }))).toMatchObject({ status: 400 })
    expect(await refused(body({ prompt: 'x'.repeat(20_001) }))).toMatchObject({ status: 400, detail: expect.stringMatching(/prompt too long/) })
    expect(await refused(body({ upload_ids: Array.from({ length: 31 }, () => u1) }))).toMatchObject({ status: 400, detail: expect.stringMatching(/30/) })
    s.server.setConfig({ models: { ...s.server.config().models, seedance_2_5: { can_create: false, disabled_modes: [] } } })
    expect(await refused(body())).toMatchObject({ status: 400, detail: expect.stringMatching(/not available/) })
    expect(s.server.balance()).toBe(1000)
    expect(s.server.snapshot().jobs).toHaveLength(0)
  })

  it('idempotent on client_request_id (same job, one charge); with dedupe off every POST creates and bills', async () => {
    const s = setup()
    const { body } = await prepared(s)
    const a = await s.api.createVideoJob(body() as never)
    const b = await s.api.createVideoJob(body() as never)
    expect(jobIdOf(b)).toBe(jobIdOf(a))
    expect(s.server.balance()).toBe(1000 - COST)
    s.server.setConfig({ dedupe: false })
    const c = await s.api.createVideoJob(body() as never)
    expect(jobIdOf(c)).not.toBe(jobIdOf(a))
    expect(s.server.balance()).toBe(1000 - 2 * COST)
  })

  it('not enough credits → 402 (or 400) with canvasapp’s Vietnamese detail; NOT_ENOUGH_CREDITS for the app', async () => {
    const s = setup()
    const { body } = await prepared(s)
    s.server.setBalance(5)
    const e = (await s.api.createVideoJob(body() as never).catch((x: unknown) => x)) as CanvasappError
    expect(e).toMatchObject({ status: 402, noCredit: true, detail: `Số dư không đủ: cần ${COST} credit, còn 5` })
    s.server.setConfig({ insufficientStatus: 400 })
    await expect(s.api.createVideoJob(body() as never)).rejects.toMatchObject({ status: 400, noCredit: true })
    expect(s.server.balance()).toBe(5)
    expect((await s.api.creditHistory({ kind: 'adjustment' })).items[0]).toMatchObject({ delta: 5 - 1000 })
  })

  it('job faults: the next job fails (refunded, with a history line), the next one expires; forceJob', async () => {
    const s = setup()
    const { projectId, body } = await prepared(s)
    s.server.setJobFaults({ failNext: 'Nội dung vi phạm (giả lập)' })
    const failing = jobIdOf(await s.api.createVideoJob(body({ client_request_id: clientRequestIdFor('a') }) as never))
    s.server.setJobFaults({ expireNext: true })
    const expiring = jobIdOf(await s.api.createVideoJob(body({ client_request_id: clientRequestIdFor('b') }) as never))
    const forced = jobIdOf(await s.api.createVideoJob(body({ client_request_id: clientRequestIdFor('c') }) as never))
    expect(s.server.jobFaults()).toEqual({ failNext: null, expireNext: false, streamFailures: 0, logoutCopyStuck: false })
    expect(s.server.snapshot().jobs.map((j) => j.planned)).toEqual([null, 'expire', 'fail'])
    expect(s.server.balance()).toBe(1000 - 3 * COST)

    expect(s.server.forceJob(forced, 'complete')).toBe(true)
    expect(s.server.forceJob(forced, 'fail')).toBe(false) // already ended
    s.advance(60_000)
    const jobs = await s.api.listVideoJobs(projectId)
    const byId = new Map(jobs.map((j) => [j.job_id, j]))
    expect(byId.get(failing)).toMatchObject({ status: 'failed', error_message: 'Nội dung vi phạm (giả lập)', download_available: false })
    expect(byId.get(expiring)).toMatchObject({ status: 'expired', download_available: false })
    expect(byId.get(forced)).toMatchObject({ status: 'completed', download_available: true })
    expect(s.server.balance()).toBe(1000 - 2 * COST) // only the failed one is refunded
    expect((await s.api.creditHistory({ kind: 'refund' })).items).toEqual([expect.objectContaining({ type: 'refund', delta: COST })])
  })

  it('a random failure rate makes jobs fail by themselves', async () => {
    const s = setup({ failRate: 1 })
    const { projectId, body } = await prepared(s)
    await s.api.createVideoJob(body() as never)
    s.advance(60_000)
    expect((await s.api.listVideoJobs(projectId))[0]).toMatchObject({ status: 'failed' })
    expect(s.server.balance()).toBe(1000)
  })

  it('stream: 409 until finished, then a video drawn from the uploads IN upload_ids ORDER labelled @image_N, rendered once', async () => {
    const s = setup()
    const { body, u1, u2 } = await prepared(s)
    const jobId = jobIdOf(await s.api.createVideoJob(body({ upload_ids: [u2, u1] }) as never))
    await expect(s.api.fetchVideo(jobId)).rejects.toMatchObject({ status: 409 })
    s.advance(60_000)
    const video = await s.api.fetchVideo(jobId)
    expect(video.type).toBe('video/webm')
    expect(await video.text()).toBe('WEBM:#1')
    expect(s.renders).toHaveLength(1)
    expect(s.renders[0].input.images.map((i) => i.label)).toEqual(['@image_1', '@image_2'])
    expect(s.renders[0].contents).toEqual(['IMG:lumi', 'IMG:elara'])
    await s.api.fetchVideo(jobId)
    expect(s.renders).toHaveLength(1) // cached
    // the next N downloads fail with 503
    s.server.setJobFaults({ streamFailures: 2 })
    await expect(s.api.fetchVideo(jobId)).rejects.toMatchObject({ status: 503 })
    await expect(s.api.fetchVideo(jobId)).rejects.toMatchObject({ status: 503 })
    expect(await (await s.api.fetchVideo(jobId)).text()).toBe('WEBM:#1')
  })

  it('H3 transform: frames only (no upload_ids / aspect_ratio), drawn as khung đầu / khung cuối', async () => {
    const s = setup()
    const { projectId, u1, u2 } = await prepared(s)
    const entry: BridgeEntry = {
      sceneId: 's4',
      model: 'minimax_h3',
      mode: 'transform',
      duration: 5,
      resolution: '768p',
      ratio: '16:9',
      prompt: 'biến hình',
      uploadIds: [],
      firstFrameUploadId: u1,
      lastFrameUploadId: u2,
      usedAt: 2,
    }
    await s.api.putCanvas(projectId, bridgeCanvas([entry]))
    const frames: Json = {
      project_id: projectId,
      model_profile: 'minimax_h3',
      canvas_node_id: canvasNodeId('s4'),
      prompt: 'biến hình',
      mode: 'transform',
      duration: 5,
      resolution: '768p',
      generate_audio: true,
      first_frame_upload_id: u1,
      last_frame_upload_id: u2,
      client_request_id: clientRequestIdFor('h3'),
    }
    await expect(s.api.createVideoJob({ ...frames, upload_ids: [] } as never)).rejects.toMatchObject({ status: 422 })
    const jobId = jobIdOf(await s.api.createVideoJob(frames as never))
    s.advance(60_000)
    await s.api.fetchVideo(jobId)
    expect(s.renders[0].input.images.map((i) => i.label)).toEqual(['khung đầu', 'khung cuối'])
    expect(s.renders[0].contents).toEqual(['IMG:elara', 'IMG:lumi'])
  })
})

describe('dev server: top-up through the simulated SePay sheet', () => {
  it('order → SePay sheet → "Thanh toán thành công" → canvasapp marks it paid ~2 s later (+credits, history)', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.server.login()
    const order = await s.api.createTopup(50_000)
    expect(checkoutUrlAllowed(order.checkout_url)).toBe(true)
    expect(order.checkout_url.startsWith(DEV_CHECKOUT_ORIGIN + '/')).toBe(true)
    expect(order.order_id).toMatch(/^DEVTOP/)
    expect(order.fields).toMatchObject({ order_amount: '50000', order_invoice_number: order.order_id })
    expect(await s.api.getTopup(order.order_id!)).toMatchObject({ status: 'pending', amount_vnd: 50_000 })

    const done = openCheckout({ checkoutUrl: order.checkout_url, fields: order.fields }, () => s.bridge)
    await until(() => useDevPrompts.getState().checkout !== null)
    expect(useDevPrompts.getState().checkout).toMatchObject({ orderId: order.order_id, amountVnd: 50_000, credits: 50 })
    // a second window while one is open: busy (like the desktop gateway)
    await expect(openCheckout({ checkoutUrl: order.checkout_url, fields: order.fields }, () => s.bridge)).rejects.toMatchObject({ code: 'busy' })
    answerDevCheckout('success')
    expect(await done).toEqual({ result: 'success', orderId: order.order_id, blockedHost: null })
    expect((await s.api.getTopup(order.order_id!)).status).toBe('pending') // the app's polling sees "pending" first
    s.advance(DEV_PAYMENT_DELAY_MS)
    expect(await s.api.getTopup(order.order_id!)).toMatchObject({ status: 'paid', amount_vnd: 50_000 })
    expect(s.server.balance()).toBe(1050)
    expect((await s.api.creditHistory({ kind: 'topup' })).items[0]).toMatchObject({ type: 'topup', delta: 50, amount_vnd: 50_000, status: 'paid' })
  })

  it('cancel / error keep the order pending (it expires after 10 min); "closed" after paying on the phone still gets paid', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.server.login()
    const a = await s.api.createTopup(30_000)
    const pa = openCheckout({ checkoutUrl: a.checkout_url, fields: a.fields }, () => s.bridge)
    await until(() => useDevPrompts.getState().checkout !== null)
    answerDevCheckout('cancel')
    expect(await pa).toMatchObject({ result: 'cancel', orderId: a.order_id })
    const pe = openCheckout({ checkoutUrl: a.checkout_url, fields: a.fields }, () => s.bridge)
    await until(() => useDevPrompts.getState().checkout !== null)
    answerDevCheckout('error')
    expect(await pe).toMatchObject({ result: 'error', orderId: a.order_id })
    s.advance(TOPUP_ORDER_TTL_MS)
    expect((await s.api.getTopup(a.order_id!)).status).toBe('expired')

    const b = await s.api.createTopup(100_000)
    const pb = openCheckout({ checkoutUrl: b.checkout_url, fields: b.fields }, () => s.bridge)
    await until(() => useDevPrompts.getState().checkout !== null)
    answerDevCheckout('closed', { outcome: 'paid', delayMs: 0 })
    expect(await pb).toEqual({ result: 'closed', orderId: null, blockedHost: null })
    expect((await s.api.getTopup(b.order_id!)).status).toBe('paid')
    expect(s.server.balance()).toBe(1100)
  })

  it('other outcomes (reconcile_required, rejected), the 15-minute timeout, a refused URL, top-up switched off', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.server.login()
    const a = await s.api.createTopup(20_000)
    expect(s.server.simulatePayment(a.order_id!, 'reconcile_required', 0)).toBe(true)
    expect((await s.api.getTopup(a.order_id!)).status).toBe('reconcile_required')
    expect(s.server.simulatePayment(a.order_id!, 'paid')).toBe(false) // no longer pending
    const b = await s.api.createTopup(20_000)
    s.server.simulatePayment(b.order_id!, 'rejected', 0)
    expect((await s.api.getTopup(b.order_id!)).status).toBe('rejected')
    expect(s.server.balance()).toBe(1000)

    const c = await s.api.createTopup(20_000)
    const pc = openCheckout({ checkoutUrl: c.checkout_url, fields: c.fields }, () => s.bridge)
    await until(() => useDevPrompts.getState().checkout !== null)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(await pc).toMatchObject({ result: 'timeout', orderId: null })

    expect(await s.bridge.checkout!({ checkoutUrl: 'https://evil.example/pay', fields: {} })).toMatchObject({ ok: false, code: 'refused' })
    expect(await s.bridge.checkout!({ checkoutUrl: c.checkout_url, fields: { 'bad name': 'x' } })).toMatchObject({ ok: false, code: 'bad-request' })
    s.server.setConfig({ topupEnabled: false })
    expect(await s.api.authState()).toMatchObject({ topup_enabled: false })
    await expect(s.api.createTopup(50_000)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('credit history: newest first, kind filter, offset / limit / next_offset', async () => {
    const s = setup()
    const { body } = await prepared(s)
    for (const k of ['a', 'b', 'c']) await s.api.createVideoJob(body({ client_request_id: clientRequestIdFor(k) }) as never)
    const all = await s.api.creditHistory({ limit: 2 })
    expect(all).toMatchObject({ balance: 1000 - 3 * COST, next_offset: 2 })
    expect(all.items.map((i) => i.type)).toEqual(['video', 'video'])
    expect(all.items[0].description).toContain('#3')
    const rest = await s.api.creditHistory({ offset: 2, limit: 2 })
    expect(rest.items.map((i) => i.type)).toEqual(['video', 'adjustment'])
    expect(rest.next_offset).toBeNull()
    expect((await s.api.creditHistory({ kind: 'topup' })).items).toEqual([])
  })
})

describe('dev server: faults', () => {
  it('network: never reaches the server (nothing created, nothing billed)', async () => {
    const s = setup()
    const { body } = await prepared(s)
    s.server.addFault({ endpoint: 'job-create', fault: { kind: 'network' } })
    await expect(s.api.createVideoJob(body() as never)).rejects.toMatchObject({ code: 'network' })
    expect(s.server.snapshot().jobs).toHaveLength(0)
    expect(s.server.balance()).toBe(1000)
    expect(s.server.faults()).toEqual([]) // one-shot: gone
    const last = useDevLog.getState().entries.at(-1)!
    expect(last).toMatchObject({ method: 'POST', endpoint: 'job-create', status: null, fault: 'network', processed: false })
  })

  it('lost-response: the job IS created and billed, the app gets no answer; processed-then: created, then another answer', async () => {
    const s = setup()
    const { body } = await prepared(s)
    s.server.addFault({ endpoint: 'job-create', fault: { kind: 'lost-response' } })
    await expect(s.api.createVideoJob(body() as never)).rejects.toMatchObject({ code: 'network' })
    expect(s.server.snapshot().jobs).toHaveLength(1)
    expect(s.server.balance()).toBe(1000 - COST)
    expect(useDevLog.getState().entries.at(-1)).toMatchObject({ fault: 'lost-response', processed: true, status: null })

    s.server.addFault({ endpoint: 'job-create', fault: { kind: 'processed-then', status: 502, json: { detail: 'Bad gateway' } } })
    await expect(s.api.createVideoJob(body({ client_request_id: clientRequestIdFor('x') }) as never)).rejects.toMatchObject({ code: 'server', status: 502 })
    s.server.addFault({ endpoint: 'job-create', fault: { kind: 'processed-then', status: 200, json: { ok: true } } })
    expect(await s.api.createVideoJob(body({ client_request_id: clientRequestIdFor('y') }) as never)).toEqual({ ok: true })
    expect(s.server.snapshot().jobs).toHaveLength(3)
  })

  it('response faults answer without handling; slow adds latency; sticky rules stay, one-shot rules count down', async () => {
    const s = setup({ latencyMs: 40 })
    s.server.login()
    s.server.addFault({ endpoint: 'me', fault: { kind: 'response', status: 429, json: { detail: 'Too many requests' } }, times: 2 })
    await expect(s.api.me()).rejects.toMatchObject({ code: 'rate-limited' })
    expect(s.server.faults()).toMatchObject([{ endpoint: 'me', remaining: 1, hits: 1, sticky: false }])
    await expect(s.api.me()).rejects.toMatchObject({ code: 'rate-limited' })
    expect(await s.api.me()).toMatchObject({ credits_balance: 1000 })

    const slow = s.server.addFault({ endpoint: '*', fault: { kind: 'slow', ms: 3000 }, sticky: true })
    s.sleeps.length = 0
    await s.api.me()
    await s.api.authState()
    expect(s.sleeps).toEqual([3040, 3040])
    expect(s.server.faults()).toMatchObject([{ id: slow.id, hits: 2, sticky: true }])
    s.server.removeFault(slow.id)
    s.server.setJobFaults({ failNext: 'x', streamFailures: 3 })
    s.server.clearFaults()
    expect(s.server.faults()).toEqual([])
    expect(s.server.jobFaults()).toEqual({ failNext: null, expireNext: false, streamFailures: 0, logoutCopyStuck: false })
  })

  it('every preset targets a real endpoint and is accepted as is', () => {
    const s = setup()
    for (const p of DEV_FAULT_PRESETS) {
      expect(p.rule.endpoint === '*' || DEV_ENDPOINTS.includes(p.rule.endpoint)).toBe(true)
      s.server.addFault(p.rule)
    }
    expect(s.server.faults()).toHaveLength(DEV_FAULT_PRESETS.length)
    expect(new Set(DEV_FAULT_PRESETS.map((p) => p.id)).size).toBe(DEV_FAULT_PRESETS.length)
  })
})

describe('dev bridge: the desktop gateway, like electron/main.cjs', () => {
  it('its allowlist agrees with main.cjs on every request', () => {
    const main = loadMainRoutes()
    const id = canvasNodeId('x')
    const cases: [string, string][] = [
      ['GET', '/api/me'],
      ['GET', '/api/auth/state'],
      ['GET', '/api/video-profiles'],
      ['GET', '/api/projects'],
      ['POST', '/api/projects'],
      ['PATCH', '/api/projects'],
      ['GET', `/api/projects/${id}`],
      ['PATCH', `/api/projects/${id}`],
      ['DELETE', `/api/projects/${id}`],
      ['PUT', `/api/projects/${id}/canvas`],
      ['PATCH', `/api/projects/${id}/canvas`],
      ['POST', '/api/uploads/images'],
      ['GET', `/api/video-jobs?project_id=${id}`],
      ['GET', '/api/video-jobs?project_id=a&project_id=b'],
      ['GET', '/api/video-jobs?other=1'],
      ['POST', '/api/video-jobs'],
      ['GET', `/api/video-jobs/${id}/prompt`],
      ['GET', `/api/video-jobs/${id}/stream`],
      ['DELETE', `/api/video-jobs/${id}`],
      ['POST', `/api/video-jobs/${id}/download-token`],
      ['POST', '/api/payments/topups'],
      ['GET', '/api/payments/topups/DEVTOP1'],
      ['GET', '/api/credits/history?kind=topup&offset=0&limit=20'],
      ['GET', '/api/credits/history?kind=evil'],
      ['GET', '/api/credits/history?offset=9999999'],
      ['GET', '/api/../me'],
      ['GET', '/api/me#x'],
      ['GET', 'https://evil.example/api/me'],
      ['GET', '//evil.example/api/me'],
      ['PATCH', '/api/me'],
      ['GET', `/api/projects/${'a'.repeat(81)}`],
    ]
    for (const [method, path] of cases) expect([method, path, !!matchDevRoute(method, path)]).toEqual([method, path, !!main(method, path)])
  })

  it('refuses what is not allowlisted or too large (nothing reaches the server)', async () => {
    const s = setup()
    s.server.login()
    expect(await s.bridge.request({ method: 'DELETE', path: '/api/projects/abc' })).toMatchObject({ ok: false, code: 'not-allowed' })
    expect(useDevLog.getState().entries.at(-1)).toMatchObject({ fault: 'not-allowed', status: null, endpoint: null })
    const huge: TransportRequest = { method: 'PUT', path: '/api/projects/abc/canvas', json: { nodes: [], connections: [], viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 }, pad: 'x'.repeat(2 * 1024 * 1024) } }
    expect(await s.bridge.request(huge)).toMatchObject({ ok: false, code: 'too-large' })
    const big = new Uint8Array(20 * 1024 * 1024 + 1)
    expect(await s.bridge.request({ method: 'POST', path: '/api/uploads/images', form: { field: 'file', filename: 'a.png', contentType: 'image/png', bytes: big } })).toMatchObject({
      ok: false,
      code: 'too-large',
    })
    // the api maps a refusal by the gateway to a clear error naming the request
    const api = s.api as unknown as { transport: { request: (r: TransportRequest) => Promise<unknown> } }
    await expect(api.transport.request({ method: 'PATCH', path: '/api/me' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('JSON crosses it as JSON: what the app keeps is never shared with the server', async () => {
    const s = setup()
    const { projectId, entry } = await prepared(s)
    const got = await s.api.getProject(projectId)
    ;(got.canvas as CanvasPayload).nodes.length = 0
    expect(((await s.api.getProject(projectId)).canvas as CanvasPayload).nodes.length).toBe(bridgeCanvas([entry]).nodes.length)
  })

  it('reuses a job-list answer for a moment, but never across a POST /api/video-jobs', async () => {
    const s = setup({}, { cacheMs: 3000 })
    const { projectId, body } = await prepared(s)
    const reads = () => useDevLog.getState().entries.filter((e) => e.endpoint === 'jobs-list' && e.fault === null).length
    await s.api.listVideoJobs(projectId)
    await s.api.listVideoJobs(projectId)
    expect(reads()).toBe(1)
    expect(useDevLog.getState().entries.at(-1)).toMatchObject({ fault: 'gateway-cache' })
    await s.api.createVideoJob(body() as never)
    expect(await s.api.listVideoJobs(projectId)).toHaveLength(1) // fresh
    expect(reads()).toBe(2)
    s.advance(3000)
    await s.api.listVideoJobs(projectId)
    expect(reads()).toBe(3)
  })
})

describe('dev server: persistence and reset', () => {
  it('a reload (new server on the same storage) keeps the account, its data and settings; jobs keep running by the clock', async () => {
    const storage = memoryStorage()
    const blobs = memoryBlobStore()
    const s = setup({ speed: 'realistic', exposeKey: true }, { storage, blobs })
    const { projectId, body, u1 } = await prepared(s)
    const jobId = jobIdOf(await s.api.createVideoJob(body() as never))
    await s.api.createTopup(50_000)

    const t = s.clock.t + 120_000
    const again = setup({}, { storage, blobs, t })
    expect(again.server.isAuthenticated()).toBe(true)
    expect(again.server.config()).toMatchObject({ speed: 'realistic', exposeKey: true })
    expect(await again.api.me()).toMatchObject({ credits_balance: 1000 - COST })
    expect(await again.api.listProjects()).toEqual([{ project_id: projectId, name: 'SanoVids bridge' }])
    expect((await again.api.listVideoJobs(projectId))[0]).toMatchObject({ job_id: jobId, status: 'completed', client_request_id: clientRequestIdFor('take_1') })
    expect(await (await again.server.uploadBlob(u1))!.text()).toBe('IMG:elara')
    expect(again.server.snapshot()).toMatchObject({ topups: [{ status: 'pending', amount_vnd: 50_000 }], historyCount: 2 })
  })

  it('reset wipes the account, its blobs and the faults (settings kept on request); unreadable storage → a new account', async () => {
    const storage = memoryStorage()
    const s = setup({ speed: 'realistic' }, { storage })
    const { u1 } = await prepared(s)
    s.server.addFault({ endpoint: '*', fault: { kind: 'network' }, sticky: true })
    let notified = 0
    s.server.subscribe(() => notified++)
    await s.server.reset({ keepConfig: true })
    expect(notified).toBeGreaterThan(0)
    expect(s.server.snapshot()).toMatchObject({ authenticated: false, balance: 1000, projects: [], jobs: [], uploads: [], topups: [], faults: [], historyCount: 1 })
    expect(s.server.config().speed).toBe('realistic')
    expect(await s.server.uploadBlob(u1)).toBeNull()
    await s.server.reset()
    expect(s.server.config().speed).toBe('fast')

    storage.set('bdp:dev:state', '{not json')
    expect(setup({}, { storage }).server.snapshot()).toMatchObject({ authenticated: false, balance: 1000 })
  })
})

describe('dev server: one account for every tab (each tab runs its own copy on the same storage)', () => {
  it('nothing done in one tab is lost when another tab (started earlier) saves; a reload sees both', async () => {
    const storage = memoryStorage()
    const blobs = memoryBlobStore()
    const a = setup({}, { storage, blobs })
    const b = setup({}, { storage, blobs }) // opened before tab A did anything
    const { projectId, body } = await prepared(a)
    const jobId = jobIdOf(await a.api.createVideoJob(body() as never))
    expect(a.server.balance()).toBe(1000 - COST)

    // tab B sees tab A's account, and its own change keeps A's work
    expect(b.server.isAuthenticated()).toBe(true)
    expect(await b.api.me()).toMatchObject({ credits_balance: 1000 - COST })
    expect((await b.api.listVideoJobs(projectId)).map((j) => j.job_id)).toEqual([jobId])
    b.server.setBalance(b.server.balance() + 100)
    expect(a.server.balance()).toBe(1100 - COST)
    expect(a.server.snapshot().jobs.map((j) => j.job_id)).toEqual([jobId])

    // a reload (a third copy) has everything: login, project, job, both balance changes, every history line
    const c = setup({}, { storage, blobs })
    expect(c.server.snapshot()).toMatchObject({ authenticated: true, balance: 1100 - COST, historyCount: 3, jobs: [{ job_id: jobId }] })
    expect(await c.api.listProjects()).toEqual([{ project_id: projectId, name: 'SanoVids bridge' }])
    // logging out in one tab logs out the shared session (like canvasapp's cookie)
    c.server.logout()
    await expect(a.api.me()).rejects.toMatchObject({ code: 'login-required' })
  })

  it('sync() (the window "storage" event) takes another tab’s save and tells the listeners; ids never collide', async () => {
    const storage = memoryStorage()
    const a = setup({}, { storage })
    const b = setup({}, { storage })
    let told = 0
    b.server.subscribe(() => told++)
    expect(b.server.sync()).toBe(false)
    a.server.login()
    a.server.setConfig({ speed: 'realistic' })
    expect(b.server.sync()).toBe(true)
    expect(told).toBe(1)
    expect(b.server.snapshot()).toMatchObject({ authenticated: true, config: { speed: 'realistic' } })
    // uploads from both tabs: different ids, all kept
    const ua = await a.api.uploadImage(png('A'), uploadFilename('img_a', 'image/png'))
    const ub = await b.api.uploadImage(png('B'), uploadFilename('img_b', 'image/png'))
    expect(ua).not.toBe(ub)
    expect(setup({}, { storage }).server.snapshot().uploads.map((u) => u.imageId)).toEqual(['img_b', 'img_a'])
  })
})

describe('dev server: faults combine', () => {
  it('"slow" adds up with every other fault; a rule for the endpoint beats a "*" rule; nothing hides another', async () => {
    const s = setup({ latencyMs: 0 })
    const { body } = await prepared(s)
    s.server.addFault({ endpoint: '*', fault: { kind: 'slow', ms: 3000 }, sticky: true })
    s.server.addFault({ endpoint: '*', fault: { kind: 'response', status: 429, json: { detail: 'Too many requests' } }, sticky: true })
    s.server.addFault({ endpoint: 'job-create', fault: { kind: 'lost-response' } })
    s.sleeps.length = 0
    clearDevLog()
    await expect(s.api.createVideoJob(body() as never)).rejects.toMatchObject({ code: 'network' })
    // lost answer → created and billed, after the 3 s delay; the 429 "*" rule did not hide it
    expect(s.server.snapshot().jobs).toHaveLength(1)
    expect(s.sleeps).toEqual([3000])
    expect(useDevLog.getState().entries.at(-1)).toMatchObject({ endpoint: 'job-create', fault: 'slow 3000ms + lost-response', processed: true })
    // the one-shot rule is used up; the sticky ones stay (and fired)
    expect(s.server.faults().map((r) => [r.fault.kind, r.hits])).toEqual([
      ['slow', 1],
      ['response', 0],
    ])
    // other endpoints meet the "*" rules: slow AND 429
    s.sleeps.length = 0
    await expect(s.api.me()).rejects.toMatchObject({ code: 'rate-limited' })
    expect(s.sleeps).toEqual([3000])
    expect(s.server.faults().map((r) => r.hits)).toEqual([2, 1])
  })
})

describe('dev server: the clock moves on by itself', () => {
  it('a payment / a failed job that is due shows in /api/me and the credit history without reading the order / jobs', async () => {
    const s = setup()
    const { body } = await prepared(s)
    const order = await s.api.createTopup(50_000)
    expect(s.server.simulatePayment(order.order_id!, 'paid', 2_000)).toBe(true)
    s.server.setJobFaults({ failNext: 'Hỏng (giả lập)' })
    await s.api.createVideoJob(body() as never)
    expect((await s.api.me()).credits_balance).toBe(1000 - COST)
    s.advance(60_000)
    // nobody read GET /api/payments/topups/{id} or the job list: the account moved on anyway
    expect((await s.api.me()).credits_balance).toBe(1050)
    const kinds = (await s.api.creditHistory({})).items.map((h) => h.type)
    expect(kinds.slice(0, 2).sort()).toEqual(['refund', 'topup'])
  })
})

describe('dev server: what is saved', () => {
  /** A finished job record as the server saves it. */
  const savedJob = (n: number, over: Record<string, unknown> = {}) => ({
    job_id: `job-${n}`,
    number: n,
    project_id: 'p',
    canvas_node_id: 'n',
    client_request_id: `key-${n}`,
    model_profile: 'seedance_2_5',
    mode: 't2v',
    duration: 5,
    resolution: '480p',
    aspect_ratio: '16:9',
    prompt: 'x',
    generate_audio: true,
    upload_ids: [],
    first_frame_upload_id: null,
    last_frame_upload_id: null,
    cost: 1,
    created_at: START - 1_000_000 + n,
    plan: { queuedMs: 1, totalMs: 2, failAt: 0.5, failMessage: null, expire: false },
    status: 'completed',
    progress: 100,
    finished_at: START - 900_000,
    error_message: null,
    download_available: true,
    refunded: false,
    ...over,
  })
  const savedState = (over: Record<string, unknown>) =>
    JSON.stringify({ v: 1, salt: 'abc', seq: 10, authenticated: true, balance: 500, projects: [], uploads: [], jobs: [], history: [], topups: [], ...over })

  it('a damaged record is dropped, never fatal: the snapshot (and the dev panel) still work', () => {
    const storage = memoryStorage()
    storage.set('bdp:dev:state', savedState({ jobs: [{}, null, 7, savedJob(1), { ...savedJob(2), upload_ids: 'nope' }], topups: [null, { order_id: 'x' }], uploads: [null, {}], history: [null], projects: [null, { project_id: 'p' }] }))
    const s = setup({}, { storage })
    const snap = s.server.snapshot()
    expect(snap).toMatchObject({ authenticated: true, balance: 500, topups: [], uploads: [], historyCount: 0 })
    expect(snap.jobs.map((j) => j.job_id)).toEqual(['job-2', 'job-1'])
    expect(snap.jobs[0].upload_ids).toEqual([])
    expect(snap.projects).toEqual([{ project_id: 'p', name: 'Phiên mới', nodes: 0, savedAt: null }])
  })

  it('jobs let go (over the cap, or too big for localStorage) take their videos with them; running jobs stay', async () => {
    const storage = memoryStorage()
    const blobs = memoryBlobStore()
    const jobs = Array.from({ length: 205 }, (_, i) => savedJob(i + 1))
    storage.set('bdp:dev:state', savedState({ jobs }))
    for (const j of jobs) await blobs.set(`dev:video:${j.job_id}`, new Blob(['v']))
    const s = setup({}, { storage, blobs })
    s.server.setBalance(600) // any save
    await until(() => true)
    const kept = s.server.snapshot().jobs.map((j) => j.job_id)
    expect(kept).toHaveLength(200)
    expect(kept).not.toContain('job-5')
    expect(await blobs.get('dev:video:job-5')).toBeNull()
    expect(await blobs.get('dev:video:job-6')).not.toBeNull()

    // long prompts: the oldest FINISHED jobs go until the saved text fits
    const big = Array.from({ length: 100 }, (_, i) => savedJob(i + 1, { prompt: 'p'.repeat(20_000), ...(i < 3 ? { status: 'processing', progress: 50, finished_at: null, download_available: false, created_at: START, plan: { queuedMs: 1, totalMs: 3_600_000, failAt: 0.5, failMessage: null, expire: false } } : {}) }))
    storage.set('bdp:dev:state', savedState({ jobs: big }))
    const t = setup({}, { storage, blobs })
    t.server.setBalance(700)
    expect(storage.get('bdp:dev:state')!.length).toBeLessThanOrEqual(1_500_000)
    const left = t.server.snapshot().jobs.map((j) => j.job_id)
    expect(left).toEqual(expect.arrayContaining(['job-1', 'job-2', 'job-3'])) // running: never dropped
    expect(left.length).toBeLessThan(100)
    expect(left).toContain('job-100')
  })

  it('a save that fails (storage full) is reported and the change is not undone by the next read', () => {
    const inner = memoryStorage()
    let full = false
    const storage = {
      get: inner.get,
      remove: inner.remove,
      set: (k: string, v: string) => {
        if (full) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
        inner.set(k, v)
      },
    }
    const s = setup({}, { storage: storage as ReturnType<typeof memoryStorage> })
    s.server.login()
    full = true
    s.server.setBalance(500)
    expect(s.server.balance()).toBe(500)
    expect(s.server.snapshot().persistProblem).toMatch(/đầy/)
    full = false
    s.server.setBalance(400)
    expect(s.server.snapshot().persistProblem).toBeNull()
    expect(setup({}, { storage: storage as ReturnType<typeof memoryStorage> }).server.balance()).toBe(400)
  })

  it('"Hết phiên (401)" is remembered as an armed fault until the next login (a plain logout is not one)', () => {
    const storage = memoryStorage()
    const s = setup({}, { storage })
    s.server.login()
    s.server.expireSession()
    expect(s.server.snapshot()).toMatchObject({ authenticated: false, sessionExpired: true })
    expect(setup({}, { storage }).server.snapshot().sessionExpired).toBe(true)
    s.server.login()
    expect(s.server.snapshot()).toMatchObject({ authenticated: true, sessionExpired: false })
    s.server.logout()
    expect(s.server.snapshot()).toMatchObject({ authenticated: false, sessionExpired: false })
  })
})

describe('request log', () => {
  it('keeps the last 300 requests; long strings are cut, files are logged as sizes (never their bytes)', async () => {
    const s = setup()
    s.server.login()
    await s.api.uploadImage(png('PNGDATA'), 'img_1.png')
    const up = useDevLog.getState().entries.at(-1)!
    expect(up).toMatchObject({ endpoint: 'upload', status: 200, req: { field: 'file', filename: 'img_1.png', contentType: 'image/png', bytes: 7 } })
    expect(summarizeForLog('x'.repeat(1000))).toMatch(/^x{300}… \(\+700 ký tự\)$/)
    expect(summarizeForLog(new Uint8Array(12))).toBe('[12 bytes]')
    expect((summarizeForLog(Array.from({ length: 100 }, (_, i) => i)) as unknown[]).length).toBe(41)
    for (let i = 0; i < DEV_LOG_MAX + 20; i++) await s.api.authState()
    const entries = useDevLog.getState().entries
    expect(entries).toHaveLength(DEV_LOG_MAX)
    expect(entries.every((e, i) => i === 0 || e.id > entries[i - 1].id)).toBe(true)
    clearDevLog()
    expect(useDevLog.getState().entries).toEqual([])
  })
})
