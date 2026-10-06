// Development mode end to end, as the app wires it, without any network:
//   the real queue engine (store/runs) → getProvider('dev') = the real canvasapp adapter as 'dev' → devApi() (real
//   api.ts + desktop transport) → devBridge() (simulated electron gateway) → the dev server (simulated canvasapp).
// Also the balance (store/credits through activeGateway()), the login sheet and the top-up flow (components/topup
// topupFlow) against the same simulated account.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const media = vi.hoisted(() => new Map<string, Blob>())
vi.mock('../../lib/imageStore', () => {
  let n = 0
  return {
    putBlob: vi.fn(async (b: Blob, prefix = 'img') => {
      const id = `${prefix}_${++n}`
      media.set(id, b)
      return id
    }),
    getBlob: vi.fn(async (id: string) => media.get(id) ?? null),
    getUrl: vi.fn(async () => null),
    cachedUrl: () => null,
    deleteMedia: vi.fn(async (id: string) => void media.delete(id)),
    dataUrlToBlob: () => new Blob(),
    useMediaUrl: () => null,
  }
})

import { createTopupFlow } from '../../components/topup/topupFlow'
import { costOf } from '../../core/models'
import type { Asset, Project, Scene, Take } from '../../core/types'
import { getCreditInfo, refreshRealCredits, resetRealCredits, startRealCreditsSync, useRealCredits } from '../../store/credits'
import { useProject } from '../../store/project'
import { DEV_UNKNOWN_SUBMIT_ERROR, isUncertainSubmit, onRunEvent, setEngineHooks, setEngineLockManager, useRuns, type RunEvent } from '../../store/runs'
import { createCanvasappProvider, memoryStorage } from '../canvasapp/adapter'
import { openCheckout } from '../canvasapp/transport'
import { clientRequestIdFor, sceneNodeId } from '../canvasapp/mapping'
import type { CanvasPayload } from '../canvasapp/api'
import {
  answerDevCheckout,
  answerDevLogin,
  clearDevLog,
  closeDevPrompts,
  createDevCanvasapp,
  DEV_FAULT_PRESETS,
  devBridge,
  memoryBlobStore,
  setDevServer,
  useDevLog,
  useDevPrompts,
  type DevCanvasapp,
  type DevRenderInput,
} from '../dev'
import {
  activeGateway,
  activeProviderId,
  DEV_LIST_CACHE_MS,
  DEV_POLL_MS,
  devApi,
  gatewayFor,
  getProvider,
  normalizeProviderChoice,
  PROVIDER_LABEL,
  registerProvider,
  resetDevMode,
  useProviderPrefs,
} from '../index'

const asset = (id: string, name: string, imageIds: string[]): Asset => ({ id, kind: 'character', name, tag: name, description: '', imageIds, color: '#fff', position: null })

const scene = (id: string, order: number, over: Partial<Scene> = {}): Scene => ({
  id,
  order,
  title: 'Cảnh ' + order,
  prompt: 'Một con đường vắng',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: order * 300 },
  note: '',
  ...over,
})

const PROMPT = '@image_1 ôm @image_3 dưới mưa'
const S1 = { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' } as const
const S1_COST = costOf(S1)

const project = (): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [asset('elara', 'Elara', ['img_e1']), asset('lumi', 'Lumi', ['img_l1', 'img_l2'])],
  scenes: [scene('s1', 1, { title: 'Ôm nhau', prompt: PROMPT, refs: ['elara', 'lumi'], settings: { ...S1 } }), scene('s2', 2)],
})

let server: DevCanvasapp
let renders: { input: DevRenderInput; contents: (string | null)[] }[] = []
let stopSync: () => void = () => undefined
let events: RunEvent[] = []
let offEvents: () => void = () => undefined

const takes = () => useRuns.getState().takes
const take = (id: string) => takes().find((t) => t.id === id)!
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const enqueue = (...ids: string[]): Take[] => {
  const r = useRuns.getState().enqueue(ids)
  expect(r.error).toBeUndefined()
  return takes().slice(-r.queued)
}
const logOf = (endpoint: string) => useDevLog.getState().entries.filter((e) => e.endpoint === endpoint)

beforeEach(async () => {
  vi.useFakeTimers()
  setEngineLockManager(null)
  setEngineHooks({})
  media.clear()
  for (const id of ['img_e1', 'img_l1', 'img_l2']) media.set(id, new Blob(['IMG:' + id], { type: 'image/png' }))
  renders = []
  server = createDevCanvasapp({
    storage: memoryStorage(),
    blobs: memoryBlobStore(),
    random: () => 0.5,
    render: async (input) => {
      renders.push({ input, contents: await Promise.all(input.images.map((i) => (i.blob ? i.blob.text() : Promise.resolve(null)))) })
      return new Blob([`WEBM:#${input.jobNumber}`], { type: 'video/webm' })
    },
  })
  setDevServer(server)
  await resetDevMode() // the app's own reset: fresh simulated account + fresh dev provider (no leftovers)
  server.setConfig({ latencyMs: 0 })
  clearDevLog()
  useProviderPrefs.setState({ provider: 'dev' })
  useProject.getState().loadProject(project())
  useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
  resetRealCredits()
  stopSync = startRealCreditsSync()
  events = []
  offEvents = onRunEvent((e) => events.push(e))
})

afterEach(async () => {
  offEvents()
  stopSync()
  closeDevPrompts()
  useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
  await run(250)
  vi.useRealTimers()
  resetRealCredits()
  setDevServer(null)
  // no request ever left the gateway's allowlist
  expect(useDevLog.getState().entries.filter((e) => e.fault === 'not-allowed')).toEqual([])
})

afterAll(() => {
  setEngineLockManager(undefined)
  setEngineHooks({})
})

describe('dev mode e2e: the default for new takes', () => {
  it('new takes run on dev (web too): no desktop bridge needed, balance read from the simulated account', async () => {
    expect(activeProviderId()).toBe('dev')
    expect(activeGateway()).toMatchObject({ id: 'dev', simulated: true, label: PROVIDER_LABEL.dev })
    expect(activeGateway().api).toBe(devApi())
    expect(getProvider('dev')).toMatchObject({ id: 'dev', label: 'Phát triển (giả lập)', minPollIntervalMs: DEV_POLL_MS })
    useProviderPrefs.getState().setProvider('mock') // the old demo is not selectable any more
    expect(useProviderPrefs.getState().provider).toBe('dev')
    expect(['mock', 'dev', 'canvasapp', null, 'x'].map(normalizeProviderChoice)).toEqual(['dev', 'dev', 'canvasapp', 'dev', 'dev'])
    expect(gatewayFor('mock')).toBeNull()
    // without the desktop bridge, choosing canvasapp still runs new takes in dev mode (never a real request)
    useProviderPrefs.getState().setProvider('canvasapp')
    expect(activeProviderId()).toBe('dev')
    expect(gatewayFor('canvasapp')!.bridge()).toBeNull()
    useProviderPrefs.getState().setProvider('dev')
    server.login()
    await refreshRealCredits({ force: true })
    expect(getCreditInfo()).toMatchObject({ kind: 'dev', balance: 1000, status: 'ok' })
  })
})

describe('dev mode e2e: happy path through the real engine and adapter', () => {
  it('enqueue → uploads → bridge canvas → job → polling every 3 s → stream → completed; charged once, balance follows', async () => {
    server.login()
    const [t] = enqueue('s1')
    expect(t).toMatchObject({ provider: 'dev', charged: false, status: 'queued', cost: S1_COST })
    await run(300)
    const calls = useDevLog.getState().entries.filter((e) => !['me', 'auth-state'].includes(String(e.endpoint)))
    expect(calls.map((e) => e.endpoint).slice(0, 9)).toEqual([
      'video-profiles',
      'projects-list',
      'project-create',
      'project-rename',
      'upload',
      'upload',
      'upload',
      'canvas-put',
      'job-create',
    ])
    expect(calls.every((e) => e.status !== null && e.status < 300)).toBe(true)
    const [job] = server.snapshot().jobs
    expect(job).toMatchObject({ prompt: PROMPT, canvas_node_id: sceneNodeId('p', 's1'), client_request_id: clientRequestIdFor(t.id), cost: S1_COST })
    expect(server.snapshot().uploads.map((u) => u.imageId).reverse()).toEqual(['img_e1', 'img_l1', 'img_l2'])
    expect(take(t.id).remoteId).toBe(`${job.project_id}:${job.job_id}`)
    expect(events).toContainEqual({ type: 'submitted', takeId: t.id, provider: 'dev' })
    expect(useRealCredits.getState()).toMatchObject({ status: 'ok', balance: 1000 - S1_COST })
    expect(useRuns.getState()).toMatchObject({ credits: 1000, spent: 0 }) // the old demo wallet is untouched

    await run(4_000)
    expect(take(t.id).status).toBe('processing')
    expect(take(t.id).progress).toBeGreaterThan(1)
    await run(12_000)
    const done = take(t.id)
    expect(done.status).toBe('completed')
    expect(media.get(done.videoId!)!.type).toBe('video/webm')
    expect(await media.get(done.videoId!)!.text()).toBe('WEBM:#1')
    // the video shows the pictures canvasapp received, in @image order
    expect(renders).toHaveLength(1)
    expect(renders[0].input.images.map((i) => i.label)).toEqual(['@image_1', '@image_2', '@image_3'])
    expect(renders[0].contents).toEqual(['IMG:img_e1', 'IMG:img_l1', 'IMG:img_l2'])
    // polled gently: never closer than the dev floor (3 s)
    const at = logOf('jobs-list').filter((e) => e.fault === null).map((e) => e.at)
    expect(at.length).toBeGreaterThan(1)
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(DEV_POLL_MS)
    expect(server.balance()).toBe(1000 - S1_COST)
    expect(useRealCredits.getState().balance).toBe(1000 - S1_COST)
    expect(events).toContainEqual({ type: 'completed', takeId: t.id, provider: 'dev' })
  })

  it('logged out at first: the take fails with the login message; the simulated login sheet logs in and polling resumes', async () => {
    const [t] = enqueue('s1')
    await run(300)
    expect(take(t.id).status).toBe('failed')
    expect(take(t.id).error).toMatch(/đăng nhập/i)
    expect(useRuns.getState().providerIssue).toMatchObject({ provider: 'dev', code: 'login-required' })
    // in development-mode words: the simulated site, where to log in — never the real canvasapp.io.vn
    expect(take(t.id).error).toContain('canvasapp giả lập')
    expect(take(t.id).error).toContain('Nhà cung cấp video')
    expect(take(t.id).error).not.toContain('canvasapp.io.vn')
    expect(useRuns.getState().providerIssue?.message).not.toContain('canvasapp.io.vn')
    expect(server.snapshot().jobs).toHaveLength(0)
    expect(useRealCredits.getState().status).toBe('login-required')

    const login = devBridge().login()
    await vi.waitFor(() => expect(useDevPrompts.getState().login).not.toBeNull())
    answerDevLogin(true)
    expect(await login).toEqual({ ok: true, authenticated: true })
    await refreshRealCredits({ force: true })
    expect(useRealCredits.getState()).toMatchObject({ status: 'ok', balance: 1000 })
    const [again] = enqueue('s1')
    await run(20_000)
    expect(take(again.id).status).toBe('completed')
  })

  it('a job that fails on the simulated canvasapp: the take fails with its message, the credits come back', async () => {
    server.login()
    server.setJobFaults({ failNext: 'Nội dung vi phạm chính sách (giả lập)' })
    const [t] = enqueue('s1')
    await run(20_000)
    expect(take(t.id)).toMatchObject({ status: 'failed', error: 'canvasapp giả lập: Nội dung vi phạm chính sách (giả lập)' })
    expect(server.balance()).toBe(1000)
    expect(useRealCredits.getState().balance).toBe(1000)
  })
})

describe('dev mode e2e: polling cadence and ready-made faults', () => {
  it('with the default simulated latency the job list is really read every ~3 s (never every other poll)', async () => {
    server.login()
    server.setConfig({ latencyMs: 150, speed: 'realistic' })
    const [t] = enqueue('s1')
    await run(40_000)
    expect(take(t.id).status).toBe('processing')
    // requests that reached the simulated server (a gateway cache hit is logged with fault 'gateway-cache')
    const at = logOf('jobs-list')
      .filter((e) => e.fault === null)
      .map((e) => e.at)
    expect(at.length).toBeGreaterThan(6)
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeLessThan(2 * DEV_POLL_MS)
  })

  it('"Invalid canvas payload (400)" as shipped: the take fails without sending a job, even with older scenes on the canvas', async () => {
    server.login()
    const [first] = enqueue('s1')
    await run(20_000)
    expect(take(first.id).status).toBe('completed')
    const balance = server.balance()

    server.addFault(DEV_FAULT_PRESETS.find((p) => p.id === 'canvas-400')!.rule)
    const [t] = enqueue('s2')
    await run(5_000)
    expect(take(t.id).status).toBe('failed')
    expect(take(t.id).error).toContain('Invalid canvas payload')
    expect(take(t.id).error).toContain('không bị trừ credit')
    expect(logOf('canvas-put').slice(-2).map((e) => e.status)).toEqual([400, 400]) // the adapter's retry with only s2 too
    expect(server.snapshot().jobs).toHaveLength(1)
    expect(server.balance()).toBe(balance)
    expect(server.faults()).toEqual([])
  })
})

describe('dev mode e2e: idempotency', () => {
  it('answer lost AND the job list unreadable → "không rõ" (never re-posted); retry finds the job — one job, one charge', async () => {
    server.login()
    server.addFault({ endpoint: 'job-create', fault: { kind: 'lost-response' } })
    const listDown = server.addFault({ endpoint: 'jobs-list', fault: { kind: 'network' }, sticky: true })
    const [t] = enqueue('s1')
    await run(60_000)
    // a dev take is sent to the Bảng phát triển, not to canvasapp.io.vn (that site never saw it)
    expect(take(t.id)).toMatchObject({ status: 'failed', error: DEV_UNKNOWN_SUBMIT_ERROR, submitUnknown: true, remoteId: null })
    expect(take(t.id).error).not.toContain('canvasapp.io.vn')
    expect(isUncertainSubmit(take(t.id))).toBe(true)
    expect(logOf('job-create')).toHaveLength(1) // never posted again by itself
    expect(server.snapshot().jobs).toHaveLength(1) // ...but the simulated canvasapp did create (and bill) it
    expect(server.balance()).toBe(1000 - S1_COST)
    await run(5 * 60_000)
    expect(logOf('job-create')).toHaveLength(1)

    // the network is back; the user retries THIS take: the adapter looks for the job first and adopts it
    server.removeFault(listDown.id)
    expect(useRuns.getState().retry(t.id)).toMatchObject({ queued: 1 })
    expect(takes()).toHaveLength(1)
    await run(30_000)
    const [job] = server.snapshot().jobs
    expect(take(t.id)).toMatchObject({ status: 'completed', remoteId: `${job.project_id}:${job.job_id}` })
    expect(logOf('job-create')).toHaveLength(1)
    expect(server.snapshot().jobs).toHaveLength(1)
    expect(server.balance()).toBe(1000 - S1_COST)
  })

  it('answer lost once (list readable) → the job is found and adopted 15 s later, never paid twice', async () => {
    server.login()
    server.setConfig({ dedupe: false }) // even a careless server: SanoVids must not post a second time when it finds the job
    server.addFault({ endpoint: 'job-create', fault: { kind: 'lost-response' } })
    const [t] = enqueue('s1')
    await run(60_000)
    expect(server.snapshot().jobs).toHaveLength(1)
    expect(server.balance()).toBe(1000 - S1_COST)
    expect(take(t.id).remoteId).toBe(`${server.snapshot().jobs[0].project_id}:${server.snapshot().jobs[0].job_id}`)
    expect(['processing', 'completed']).toContain(take(t.id).status)
  })
})

describe('dev mode e2e: a duplicated project (same scene ids)', () => {
  it('the original and its copy run the same scene: two jobs on two nodes of the simulated bridge canvas, each with its prompt', async () => {
    server.login()
    const [a] = enqueue('s1')
    await run(300)
    const pOnDisk = JSON.parse(JSON.stringify(takes())) as Take[]
    const copyPrompt = '@image_1 ôm @image_3 trên bãi biển đêm'
    useProject.getState().loadProject({ ...project(), id: 'p2', scenes: project().scenes.map((s) => (s.id === 's1' ? { ...s, prompt: copyPrompt } : s)) })
    useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
    const [b] = enqueue('s1')
    await run(300)
    const jobs = [...server.snapshot().jobs].reverse() // oldest first
    expect(jobs.map((j) => [j.canvas_node_id, j.prompt])).toEqual([
      [sceneNodeId('p', 's1'), PROMPT],
      [sceneNodeId('p2', 's1'), copyPrompt],
    ])
    // the request log shows the two POST /api/video-jobs with their own canvas_node_id
    expect(logOf('job-create').map((e) => (e.req as { canvas_node_id?: string } | undefined)?.canvas_node_id)).toEqual(jobs.map((j) => j.canvas_node_id))
    // the bridge canvas on the simulated canvasapp holds both nodes, each with its own prompt
    const bridge = (await devApi().getProject(jobs[0].project_id)) as { canvas: CanvasPayload }
    expect(bridge.canvas.nodes.flatMap((n) => (n.type === 'video' ? [[n.id, n.data.prompt]] : []))).toEqual([
      [sceneNodeId('p2', 's1'), copyPrompt],
      [sceneNodeId('p', 's1'), PROMPT],
    ])
    await run(20_000)
    expect(take(b.id).status).toBe('completed')
    useProject.getState().loadProject(project())
    useRuns.getState().loadRuns({ takes: pOnDisk, credits: 1000, spent: 0 })
    await run(20_000)
    expect(take(a.id)).toMatchObject({ status: 'completed', remoteId: `${jobs[0].project_id}:${jobs[0].job_id}` })
    expect(logOf('job-create')).toHaveLength(2)
    expect(server.balance()).toBe(1000 - 2 * S1_COST)
  })
})

describe('dev mode e2e: a lost answer next to a duplicated project', () => {
  it.each([
    ['dedupe on', true],
    ['dedupe off', false],
  ])('an unsure take of the original never takes the copy’s job (%s): one job, one charge', async (_label, dedupe) => {
    server.login()
    server.setConfig({ dedupe }) // the job list carries no client_request_id (exposeKey off, the default)
    const copyProject = (): Project => ({ ...project(), id: 'p2', scenes: project().scenes.map((s) => (s.id === 's1' ? { ...s, prompt: '@image_1 trên biển' } : s)) })
    // the dev adapter over its own storage, so the app can "restart" (a new adapter instance, same records)
    const records = memoryStorage()
    const boot = () =>
      registerProvider(
        createCanvasappProvider({
          id: 'dev',
          api: devApi(),
          getBlob: async (id) => media.get(id) ?? null,
          storage: records,
          minPollMs: DEV_POLL_MS,
          pollIntervalMs: DEV_POLL_MS,
          listCacheMs: DEV_LIST_CACHE_MS,
        }),
      )
    boot()
    // the original: take A's POST never gets through, the app closes while A is still "processing"
    const down = server.addFault({ endpoint: 'job-create', fault: { kind: 'network' }, sticky: true })
    const [a] = enqueue('s1')
    await run(300)
    const pOnDisk = JSON.parse(JSON.stringify(takes())) as Take[]
    await run(60_000) // (the closed app's last attempts: still nothing reaches the simulated canvasapp)
    server.removeFault(down.id)
    expect(server.snapshot().jobs).toHaveLength(0)
    boot() // restart
    // the copy: take B of the same scene; the simulated canvasapp creates its job, the answer is lost
    useProject.getState().loadProject(copyProject())
    useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
    server.addFault({ endpoint: 'job-create', fault: { kind: 'lost-response' } })
    const [b] = enqueue('s1')
    await run(300)
    expect(server.snapshot().jobs).toHaveLength(1)
    const p2OnDisk = JSON.parse(JSON.stringify(takes())) as Take[]
    // while B waits to look for its job, the original is opened: A is looked up — B's job is on another node
    useProject.getState().loadProject(project())
    useRuns.getState().loadRuns({ takes: pOnDisk, credits: 1000, spent: 0 })
    await run(60_000)
    expect(take(a.id)).toMatchObject({ status: 'failed', error: DEV_UNKNOWN_SUBMIT_ERROR, remoteId: null })
    useProject.getState().loadProject(copyProject())
    useRuns.getState().loadRuns({ takes: p2OnDisk, credits: 1000, spent: 0 })
    await run(30_000)
    const [job] = server.snapshot().jobs
    expect(job.canvas_node_id).toBe(sceneNodeId('p2', 's1'))
    expect(take(b.id)).toMatchObject({ status: 'completed', remoteId: `${job.project_id}:${job.job_id}` })
    expect(server.snapshot().jobs).toHaveLength(1)
    expect(server.balance()).toBe(1000 - S1_COST)
  })
})

describe('dev mode e2e: top-up', () => {
  it('the top-up flow runs end to end on the simulated account: order → SePay sheet → paid → balance', async () => {
    server.login()
    const flow = createTopupFlow({ api: () => activeGateway().api, checkout: (args) => openCheckout(args, activeGateway().bridge) })
    const started = flow.start(100_000)
    await vi.waitFor(() => expect(useDevPrompts.getState().checkout).not.toBeNull())
    expect(flow.store.getState().phase).toBe('checkout')
    answerDevCheckout('success')
    expect(await started).toBe(true)
    expect(flow.store.getState().phase).toBe('waiting')
    await run(10_000)
    expect(flow.store.getState()).toMatchObject({ phase: 'paid', paidCredits: 100 })
    expect(server.balance()).toBe(1100)
    expect((await activeGateway().api.creditHistory({ kind: 'topup' })).items[0]).toMatchObject({ delta: 100, amount_vnd: 100_000 })
    flow.dispose()
  })
})
