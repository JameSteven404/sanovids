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

import { cancelTake, createSceneFromTake, deleteSelection, deleteTakes } from '../../actions'
import { importSiteJobs, scanForImport } from '../../siteJobActions'
import { importWords } from '../../components/runs/importJobsModel'
import { takeCostLine } from '../../components/runs/creditText'
import { createTopupFlow } from '../../components/topup/topupFlow'
import { NO_VIDEO_REFS_REASON } from '../../core/runGate'
import { costOf } from '../../core/models'
import type { Asset, Project, Scene, Take } from '../../core/types'
import { getCreditInfo, refreshRealCredits, resetRealCredits, startRealCreditsSync, useRealCredits } from '../../store/credits'
import { useProject } from '../../store/project'
import { transferLabel, useTakeTransfers } from '../../store/takeTransfers'
import { useUI } from '../../store/ui'
import { DEV_UNKNOWN_SUBMIT_ERROR, isUncertainSubmit, onRunEvent, setEngineHooks, setEngineLockManager, useRuns, type RunEvent } from '../../store/runs'
import { browserStorage, createCanvasappProvider, JOBS_KEY, memoryStorage } from '../canvasapp/adapter'
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
  DEV_CLIENT_STORAGE_PREFIX,
  DEV_LIST_CACHE_MS,
  DEV_POLL_MS,
  devApi,
  gatewayFor,
  getProvider,
  LIMITS_RENEW_EARLY_MS,
  normalizeProviderChoice,
  PROVIDER_LABEL,
  providerLimits,
  providerLimitsInfo,
  refreshProviderLimits,
  registerProvider,
  resetDevMode,
  useProviderLimits,
  useProviderPrefs,
  watchProviderLimits,
} from '../index'
import { PROFILES_FORCE_MIN_MS, PROFILES_TTL_MS } from '../canvasapp/adapter'
import type { DevModelToggle } from '../dev'
import type { JobRequest } from '../types'

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
/** Size of the simulated videos (0 = the short text "WEBM:#n"). */
let videoSize = 0
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
/**
 * The job list goes down (sticky network fault) once the next job POST reached the simulated canvasapp: the read right
 * before that POST answered (every POST is sent with one), the lookups after it fail. `stop()` brings the list back.
 */
const listDownAfterNextPost = () => {
  const posts = logOf('job-create').length
  let rule: { id: string } | null = null
  const off = useDevLog.subscribe(() => {
    if (!rule && logOf('job-create').length > posts) rule = server.addFault({ endpoint: 'jobs-list', fault: { kind: 'network' }, sticky: true })
  })
  return {
    stop: () => {
      off()
      if (rule) server.removeFault(rule.id)
    },
  }
}

/** The page's localStorage (Node has none): the dev gateway's ledger is saved there, and a POST is only sent once it is. */
function pageStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  }
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', pageStorage())
  setEngineLockManager(null)
  setEngineHooks({})
  media.clear()
  for (const id of ['img_e1', 'img_l1', 'img_l2']) media.set(id, new Blob(['IMG:' + id], { type: 'image/png' }))
  renders = []
  videoSize = 0
  server = createDevCanvasapp({
    storage: memoryStorage(),
    blobs: memoryBlobStore(),
    random: () => 0.5,
    render: async (input) => {
      renders.push({ input, contents: await Promise.all(input.images.map((i) => (i.blob ? i.blob.text() : Promise.resolve(null)))) })
      if (videoSize) return new Blob([new Uint8Array(videoSize).fill(input.jobNumber)], { type: 'video/webm' })
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
  vi.unstubAllGlobals()
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
    expect(calls.map((e) => e.endpoint).slice(0, 10)).toEqual([
      'video-profiles',
      'projects-list',
      'project-create',
      'project-rename',
      'upload',
      'upload',
      'upload',
      'canvas-put',
      'jobs-list', // read right before the POST: every job already on the node is in its `before`
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
    // polled gently: never closer than the dev floor (3 s) — after the read right before the POST
    const [posted] = logOf('job-create')
    const at = logOf('jobs-list')
      .filter((e) => e.fault === null && e.at > posted.at)
      .map((e) => e.at)
    expect(logOf('jobs-list').filter((e) => e.at <= posted.at)).toHaveLength(1)
    expect(at.length).toBeGreaterThan(1)
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(DEV_POLL_MS)
    expect(server.balance()).toBe(1000 - S1_COST)
    expect(useRealCredits.getState().balance).toBe(1000 - S1_COST)
    expect(events).toContainEqual({ type: 'completed', takeId: t.id, provider: 'dev' })
  })

  it('site data blocked (localStorage throws): takes still run — the ledger is kept in memory, like everything else such a page has', async () => {
    const blocked = () => {
      throw new Error('SecurityError: The operation is insecure.')
    }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked, clear: blocked, key: blocked, length: 0 })
    await resetDevMode() // the dev provider, built again on that storage
    server.login()
    const [t] = enqueue('s1')
    await run(300)
    expect(take(t.id)).toMatchObject({ status: 'processing', error: null })
    expect(take(t.id).remoteId).not.toBeNull()
    expect(server.snapshot().jobs).toHaveLength(1)
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

describe('dev mode e2e: reference videos (@video_N) — refused like the real gateway, nothing sent, nothing paid', () => {
  const engineCalls = () => useDevLog.getState().entries.filter((e) => ['upload', 'canvas-put', 'job-create', 'project-create'].includes(String(e.endpoint)))
  const H3_T2V = { model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '768p', ratio: '16:9' } as const

  /** A finished dev take of s2 (a real run on the simulated site), ready to be a reference video. */
  async function finishedTake(): Promise<Take> {
    server.login()
    const [t] = enqueue('s2')
    await run(20_000)
    expect(take(t.id).status).toBe('completed')
    clearDevLog()
    return take(t.id)
  }

  it('"Tạo cảnh tiếp nối" warns in development mode; the new scene is skipped with the shared reason before any request', async () => {
    const t = await finishedTake()
    const balance = server.balance()
    useUI.setState({ toasts: [] })
    const id = createSceneFromTake(t.id)!
    const sc = useProject.getState().project.scenes.find((x) => x.id === id)!
    expect(sc).toMatchObject({ videoRefs: [t.id], prompt: 'Continue from @video_1: ' })
    expect(useUI.getState().toasts.at(-1)).toMatchObject({ tone: 'warning', text: expect.stringContaining('cả chế độ Phát triển') })
    useProject.getState().updateScene(id, { prompt: 'Continue from @video_1: trời mưa' })
    const r = useRuns.getState().enqueue([id])
    expect(r).toMatchObject({ queued: 0, skipped: [{ sceneId: id, reason: NO_VIDEO_REFS_REASON }] })
    await run(10_000)
    expect(engineCalls()).toEqual([])
    expect(server.snapshot().jobs).toHaveLength(1) // only the reference take's own job
    expect(server.balance()).toBe(balance)
  })

  it('the dev adapter itself refuses a request with a video (development-mode words) before uploading, saving the canvas or posting', async () => {
    const t = await finishedTake()
    const balance = server.balance()
    const req: JobRequest = {
      key: 'take_video',
      takeId: 'take_video',
      sceneId: 's1',
      sanovidsProjectId: 'p',
      sceneCode: 'S01',
      takeNumber: 9,
      title: '',
      color: '#fff',
      ...S1,
      prompt: '@image_1 tiếp nối @video_1',
      rawPrompt: '@image_1 tiếp nối @video_1',
      images: [{ n: 1, assetId: 'elara', imageId: 'img_e1' }],
      videos: [{ n: 1, takeId: t.id, videoId: t.videoId, posterId: t.posterId }],
      firstFrame: null,
      lastFrame: null,
      startedAt: 0,
    }
    const err = await getProvider('dev')
      .submit(req)
      .then(
        () => null,
        (e: unknown) => e as { code?: string; message: string },
      )
    expect(err).toMatchObject({ code: 'unsupported', message: expect.stringContaining('cả chế độ Phát triển') })
    expect(err!.message).not.toContain('canvasapp.io.vn')
    expect(engineCalls()).toEqual([])
    const ledger = JSON.parse(browserStorage(DEV_CLIENT_STORAGE_PREFIX).get(JOBS_KEY) ?? '{}') as { jobs?: object; sent?: object }
    expect(Object.keys(ledger.jobs ?? {})).not.toContain('take_video')
    expect(Object.keys(ledger.sent ?? {})).not.toContain('take_video')
    expect(server.snapshot().jobs).toHaveLength(1)
    expect(server.balance()).toBe(balance)
  })

  it('MiniMax-H3 t2v with a leftover reference video and no @video token runs: the strict simulated site gets no video', async () => {
    const t = await finishedTake()
    useProject.getState().loadProject({ ...project(), scenes: [...project().scenes, scene('s3', 3, { prompt: 'Một con mèo', videoRefs: [t.id], settings: { ...H3_T2V } })] })
    expect(useRuns.getState().check(['s3'])).toMatchObject([{ ok: true, reason: null }])
    const [t3] = enqueue('s3')
    await run(20_000)
    expect(take(t3.id).status).toBe('completed')
    const job = server.snapshot().jobs.find((j) => j.client_request_id === clientRequestIdFor(t3.id))!
    expect(job).toMatchObject({ model_profile: 'minimax_h3', mode: 't2v', upload_ids: [], prompt: 'Một con mèo' })
    expect(logOf('job-create').every((e) => e.status !== null && e.status < 300)).toBe(true)
  })
})

describe('dev mode e2e: the finished video comes in pieces through the simulated gateway', () => {
  const streamLog = () => logOf('job-stream')

  it('“Tải video chậm”: the take shows “Đang tải về …%” while the pieces come, then completes with the whole video', async () => {
    server.login()
    videoSize = 300 * 1024
    server.addFault(DEV_FAULT_PRESETS.find((p) => p.id === 'stream-slow')!.rule)
    const [t] = enqueue('s1')
    const labels = new Set<string>()
    const off = useTakeTransfers.subscribe((st) => {
      const l = transferLabel(st.byTake[t.id])
      if (l) labels.add(l)
    })
    await run(30_000)
    off()
    expect(take(t.id).status).toBe('completed')
    expect((await media.get(take(t.id).videoId!)!.arrayBuffer()).byteLength).toBe(300 * 1024)
    expect([...labels].some((l) => /^Đang tải về \d+%$/.test(l))).toBe(true)
    expect(useTakeTransfers.getState().byTake).toEqual({})
  })

  it('“Mất mạng giữa chừng” with “Cho tải tiếp video” on → continues with Range (206) in the same attempt', async () => {
    server.login()
    server.setConfig({ rangeSupport: true })
    server.addFault(DEV_FAULT_PRESETS.find((p) => p.id === 'stream-cut')!.rule)
    const [t] = enqueue('s1')
    await run(20_000)
    expect(take(t.id).status).toBe('completed')
    expect(await media.get(take(t.id).videoId!)!.text()).toBe('WEBM:#1')
    expect(streamLog().map((e) => e.status)).toEqual([200, null, 206])
    expect(server.snapshot().jobs).toHaveLength(1)
  })

  it('… with it off (default) → the engine downloads it again later from the start; never a failed take', async () => {
    server.login()
    server.addFault(DEV_FAULT_PRESETS.find((p) => p.id === 'stream-cut')!.rule)
    const [t] = enqueue('s1')
    await run(15_000)
    expect(take(t.id).status).toBe('processing')
    await run(40_000)
    expect(take(t.id).status).toBe('completed')
    expect(await media.get(take(t.id).videoId!)!.text()).toBe('WEBM:#1')
    expect(streamLog().filter((e) => e.status !== null).map((e) => e.status)).toEqual([200, 200])
    expect(events.filter((e) => e.type === 'failed')).toEqual([])
  })

  it('“Tải video bị treo” → stopped after 10 s without data, downloaded again later', async () => {
    server.login()
    server.addFault(DEV_FAULT_PRESETS.find((p) => p.id === 'stream-stall')!.rule)
    const [t] = enqueue('s1')
    await run(60_000)
    expect(take(t.id).status).toBe('completed')
    const failures = streamLog().filter((e) => e.status === null)
    expect(failures.map((e) => e.res)).toEqual([{ code: 'network', message: 'canvasapp giả lập ngừng gửi video giữa chừng (10 giây không nhận thêm dữ liệu).' }])
  })

  it('“Video quá lớn” → the take fails at once in development-mode words (paid in credit dev, Bảng phát triển)', async () => {
    server.login()
    server.addFault(DEV_FAULT_PRESETS.find((p) => p.id === 'stream-oversize')!.rule)
    const [t] = enqueue('s1')
    await run(20_000)
    expect(take(t.id).status).toBe('failed')
    expect(take(t.id).error).toContain('đã trừ credit dev')
    expect(take(t.id).error).toContain('Bảng phát triển')
    expect(take(t.id).error).toContain('Video lớn hơn 1 GB')
    expect(take(t.id).error).not.toContain('canvasapp.io.vn')
    await run(10 * 60_000)
    expect(streamLog().filter((e) => e.status !== null)).toHaveLength(1) // never tried again
  })

  it('“Xoá dữ liệu máy chủ giả lập” while a video downloads: the download stops — never completed with the wiped account’s video', async () => {
    server.login()
    videoSize = 300 * 1024
    server.addFault(DEV_FAULT_PRESETS.find((p) => p.id === 'stream-slow')!.rule)
    const [t] = enqueue('s1')
    await run(10_200)
    expect(take(t.id).status).toBe('processing')
    expect(useTakeTransfers.getState().byTake[t.id]).toBeDefined()
    await resetDevMode()
    await run(5 * 60_000)
    expect(take(t.id).status).not.toBe('completed')
    expect(take(t.id).videoId ?? null).toBeNull()
  })

  it('cancelling a take while its video downloads stops the download (cancelled, not failed); the slot is free for the next', async () => {
    server.login()
    videoSize = 300 * 1024
    server.addFault({ ...DEV_FAULT_PRESETS.find((p) => p.id === 'stream-slow')!.rule, sticky: false, times: 1 })
    const [a] = enqueue('s1')
    await run(10_200)
    expect(take(a.id).status).toBe('processing')
    expect(useTakeTransfers.getState().byTake[a.id]).toBeDefined()
    useRuns.getState().cancel(a.id)
    await run(0)
    expect(take(a.id).status).toBe('cancelled')
    expect(useTakeTransfers.getState().byTake[a.id]).toBeUndefined()
    const [b] = enqueue('s2')
    await run(20_000)
    expect(take(b.id).status).toBe('completed')
    expect(events.filter((e) => e.type === 'failed')).toEqual([])
  })
})

describe('dev mode e2e: “Huỷ” of a take whose video is already made (paid) and downloading', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks first (credit dev, Bảng phát triển): “no” keeps the download going to the end, “yes” cancels with that said', async () => {
    server.login()
    videoSize = 300 * 1024
    server.addFault({ ...DEV_FAULT_PRESETS.find((p) => p.id === 'stream-slow')!.rule, sticky: true })
    const confirm = vi.fn(() => false)
    vi.stubGlobal('window', { confirm })
    const [a] = enqueue('s1')
    await run(10_200)
    expect(take(a.id).status).toBe('processing')
    expect(useTakeTransfers.getState().byTake[a.id]).toBeDefined()
    expect(cancelTake(a.id)).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]).toEqual([expect.stringContaining('video đã tạo xong trên canvasapp giả lập và đã trừ credit dev')])
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain('Bảng phát triển')
    expect(take(a.id).status).toBe('processing')
    await run(20_000)
    expect(take(a.id).status).toBe('completed') // kept: the paid video came in full
    expect((await media.get(take(a.id).videoId!)!.arrayBuffer()).byteLength).toBe(300 * 1024)

    const [b] = enqueue('s2')
    await run(10_200)
    expect(useTakeTransfers.getState().byTake[b.id]).toBeDefined()
    confirm.mockReturnValue(true)
    useUI.setState({ toasts: [] })
    expect(cancelTake(b.id)).toBe(true)
    await run(0)
    expect(take(b.id)).toMatchObject({ status: 'cancelled', videoId: null })
    expect(useUI.getState().toasts.at(-1)).toMatchObject({
      tone: 'warning',
      text: expect.stringContaining('video đã tạo xong (đã trừ credit dev) không được tải về; job vẫn còn trong Bảng phát triển'),
    })
    expect(events.filter((e) => e.type === 'failed')).toEqual([])
  })

  it('MONEY: deleting it (trash button after its two clicks, Delete key) asks the same first: “no” keeps it downloading', async () => {
    server.login()
    videoSize = 300 * 1024
    server.addFault({ ...DEV_FAULT_PRESETS.find((p) => p.id === 'stream-slow')!.rule, sticky: true })
    const confirm = vi.fn(() => false)
    vi.stubGlobal('window', { confirm })
    const [a] = enqueue('s1')
    await run(10_200)
    expect(useTakeTransfers.getState().byTake[a.id]).toBeDefined()
    // the take node / Xem take trash button (already clicked twice)
    expect(deleteTakes([a.id], { confirm: 'usedOnly' })).toBeNull()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain('video đã tạo xong trên canvasapp giả lập và đã trừ credit dev')
    // the Delete key on the selected take node
    useUI.getState().select([a.id])
    deleteSelection()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(String((confirm.mock.calls[1] as unknown[])[0])).toContain('SanoVids chưa tải về xong')
    expect(take(a.id).status).toBe('processing')
    await run(20_000)
    expect(take(a.id).status).toBe('completed') // kept: the paid video came in full
  })

  it('a take whose job still runs (or waits in the queue) is cancelled without a question', async () => {
    server.login()
    const confirm = vi.fn(() => false)
    vi.stubGlobal('window', { confirm })
    const [a, b] = enqueue('s1', 's2')
    expect(cancelTake(b.id)).toBe(true) // queued
    await run(2_000)
    expect(take(a.id).status).toBe('processing')
    expect(cancelTake(a.id)).toBe(true) // its job runs on the simulated site
    expect(confirm).not.toHaveBeenCalled()
    expect(useUI.getState().toasts.at(-1)).toMatchObject({ tone: 'warning', text: expect.stringContaining('vẫn chạy ở đó') })
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
    const listDown = listDownAfterNextPost()
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
    listDown.stop()
    expect(useRuns.getState().retry(t.id)).toMatchObject({ queued: 1 })
    expect(takes()).toHaveLength(1)
    await run(30_000)
    const [job] = server.snapshot().jobs
    expect(take(t.id)).toMatchObject({ status: 'completed', remoteId: `${job.project_id}:${job.job_id}` })
    expect(logOf('job-create')).toHaveLength(1)
    expect(server.snapshot().jobs).toHaveLength(1)
    expect(server.balance()).toBe(1000 - S1_COST)
  })

  it('two takes of one scene in doubt: the later one reads the job list right before its POST — each its own job, one charge each', async () => {
    server.login()
    server.setConfig({ dedupe: false }) // the job list carries no client_request_id (exposeKey off): only node + timing tell
    // take A: the simulated canvasapp creates its job, the answer is lost and the job list is down → "không rõ"
    server.addFault({ endpoint: 'job-create', fault: { kind: 'lost-response' } })
    const listDown = listDownAfterNextPost()
    const [a] = enqueue('s1')
    await run(60_000)
    expect(take(a.id)).toMatchObject({ status: 'failed', submitUnknown: true, remoteId: null })
    // take B of the same scene while the list is still down: not sent — nothing billed, and not "không rõ"
    const [b] = enqueue('s1')
    await run(5_000)
    expect(take(b.id)).toMatchObject({ status: 'failed', remoteId: null })
    expect(take(b.id).error).toMatch(/^Không đọc được danh sách job .*Chưa gửi yêu cầu tạo video, không bị trừ credit dev\./)
    expect(isUncertainSubmit(take(b.id))).toBe(false)
    expect(logOf('job-create')).toHaveLength(1)
    // the list is back; take C of the scene loses its answer too, but the list was read right before its POST
    listDown.stop()
    server.addFault({ endpoint: 'job-create', fault: { kind: 'lost-response' } })
    const [c] = enqueue('s1')
    await run(60_000)
    const jobs = [...server.snapshot().jobs].reverse() // oldest first
    expect(jobs).toHaveLength(2)
    const remote = (j: (typeof jobs)[number]) => `${j.project_id}:${j.job_id}`
    expect(take(c.id).remoteId).toBe(remote(jobs[1])) // its own job (A's was listed before its POST)
    // A, retried: finds ITS job, never C's; nothing posted again
    expect(useRuns.getState().retry(a.id)).toMatchObject({ queued: 1 })
    await run(30_000)
    expect(take(a.id).remoteId).toBe(remote(jobs[0]))
    expect(logOf('job-create')).toHaveLength(2)
    expect(server.snapshot().jobs).toHaveLength(2)
    expect(server.balance()).toBe(1000 - 2 * S1_COST)
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
    // (a new bridge session, its job list empty: that never makes B, on the copy's node, wait for A's POST)
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
    // while B waits to look for its job, the original is opened: A is looked up — B's job is on another node, never A's:
    // nothing of A's in a read that surely shows its job → its POST made nothing → A is sent again (same key): its own job
    useProject.getState().loadProject(project())
    useRuns.getState().loadRuns({ takes: pOnDisk, credits: 1000, spent: 0 })
    await run(60_000)
    const jobOf = (id: string) => server.snapshot().jobs.find((j) => j.client_request_id === clientRequestIdFor(id))
    expect(jobOf(a.id)?.canvas_node_id).toBe(sceneNodeId('p', 's1'))
    expect(take(a.id)).toMatchObject({ remoteId: `${jobOf(a.id)!.project_id}:${jobOf(a.id)!.job_id}` })
    useProject.getState().loadProject(copyProject())
    useRuns.getState().loadRuns({ takes: p2OnDisk, credits: 1000, spent: 0 })
    await run(30_000)
    const job = jobOf(b.id)!
    expect(job.canvas_node_id).toBe(sceneNodeId('p2', 's1'))
    expect(take(b.id)).toMatchObject({ status: 'completed', remoteId: `${job.project_id}:${job.job_id}` })
    expect(server.snapshot().jobs).toHaveLength(2) // B's, A's: one each, nothing paid twice
    expect(server.balance()).toBe(1000 - 2 * S1_COST)
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

describe('dev mode e2e: what the simulated site runs now (inspector, run check, Bảng phát triển › Model)', () => {
  const H3 = { model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '768p', ratio: '16:9' } as const
  const setModel = (id: 'seedance_2_5' | 'minimax_h3', patch: Partial<DevModelToggle>) =>
    server.setConfig({ models: { ...server.config().models, [id]: { ...server.config().models[id], ...patch } } })
  const withScenes = (...extra: Scene[]) => useProject.getState().loadProject({ ...project(), scenes: [...project().scenes, ...extra] })
  const check = (...ids: string[]) => useRuns.getState().check(ids)
  const rev = () => useProviderLimits.getState().rev.dev

  it('H3 locked in the panel + "Đọc lại ngay": the signal moves, the run check skips H3 (no take, no request), ONE read', async () => {
    server.login()
    setModel('minimax_h3', { can_create: false })
    withScenes(scene('s3', 3, { settings: { ...H3 } }))
    expect(providerLimits('dev').source).toBe('none') // nothing read yet: nothing limited (the submit decides)
    expect(check('s3')[0]).toMatchObject({ ok: true, warnings: [] })
    const before = rev()
    expect(await refreshProviderLimits('dev', { force: true })).toBe('read')
    expect(rev()).toBeGreaterThan(before)
    expect(providerLimits('dev')).toMatchObject({ source: 'server', firm: true })
    expect(providerLimitsInfo('dev')).toMatchObject({ source: 'server', reading: false, lastAttempt: { result: 'read' } })
    // the dev provider is wrapped for development-mode words: the limits pass through as they are
    expect(providerLimits('dev').issues({ ...H3 })).toEqual([{ field: 'model', reason: 'MiniMax-H3 hiện không khả dụng trên canvasapp.' }])
    expect(check('s3')[0]).toMatchObject({ ok: false, reason: 'MiniMax-H3 hiện không khả dụng trên canvasapp' })
    expect(useRuns.getState().enqueue(['s3'])).toMatchObject({ queued: 0, error: 'Không có cảnh nào chạy được.' })
    await run(1000)
    expect(takes()).toEqual([])
    expect(logOf('video-profiles')).toHaveLength(1)
    expect(logOf('job-create')).toHaveLength(0)
    // fresh: an automatic refresh (inspector shown again) sends nothing
    expect(await refreshProviderLimits('dev')).toBe('fresh')
    expect(logOf('video-profiles')).toHaveLength(1)
  })

  it('Seedance’s lists narrowed in the panel are followed; MiniMax-H3’s are ignored (canvasapp’s page uses its own)', async () => {
    server.login()
    setModel('seedance_2_5', { off_durations: [30] })
    setModel('minimax_h3', { off_durations: [15] })
    withScenes(scene('s3', 3, { settings: { ...S1, duration: 30 } }), scene('s4', 4, { settings: { ...H3, duration: 15 } }))
    await refreshProviderLimits('dev', { force: true })
    const [sd30, h3] = check('s3', 's4')
    expect(sd30).toMatchObject({ ok: false, reason: 'canvasapp không có thời lượng 30s cho Seedance 2.5' })
    expect(h3).toMatchObject({ ok: true })
    expect(getProvider('dev').capabilities('seedance_2_5').durations).toEqual([5, 10, 15])
  })

  it('profiles unreadable ("Cấu hình model lỗi 500") → a guess: H3 runnable with a warning, refused at the submit (no credit)', async () => {
    server.login()
    server.addFault(DEV_FAULT_PRESETS.find((p) => p.id === 'profiles-500')!.rule)
    withScenes(scene('s3', 3, { settings: { ...H3 } }))
    expect(await refreshProviderLimits('dev')).toBe('failed')
    expect(providerLimits('dev')).toMatchObject({ source: 'fallback', firm: false })
    const [c] = check('s3')
    expect(c.ok).toBe(true)
    expect(c.warnings.join(' ')).toMatch(/Có thể bị từ chối khi gửi \(không tốn credit\): MiniMax-H3 hiện không khả dụng trên canvasapp/)
    const [t] = enqueue('s3')
    await run(1000)
    expect(take(t.id).status).toBe('failed')
    expect(take(t.id).error).toMatch(/không khả dụng/)
    expect(logOf('job-create')).toHaveLength(0)
    expect(server.balance()).toBe(1000)
  })

  it('logged out → "login" (and a minute’s pause); logging in seconds later reads at once → "server"', async () => {
    expect(await refreshProviderLimits('dev')).toBe('login') // the inspector's own read
    expect(await refreshProviderLimits('dev')).toBe('login')
    expect(logOf('video-profiles')).toHaveLength(1)
    expect(providerLimits('dev').source).toBe('none')
    await run(1_000) // well inside the 5 s limit of "Đọc lại" and the automatic reads' pause
    expect(PROFILES_FORCE_MIN_MS).toBeGreaterThan(1_000)
    expect(await refreshProviderLimits('dev', { force: true })).toBe('login') // a quick click: nothing sent
    expect(logOf('video-profiles')).toHaveLength(1)
    // the simulated login sheet (dev bridge) or "Đăng nhập ngay" (AccountCard), then refreshProviderLimits({ changed })
    server.login()
    const before = rev()
    expect(await refreshProviderLimits('dev', { changed: true })).toBe('read')
    expect(logOf('video-profiles')).toHaveLength(2)
    expect(providerLimits('dev').source).toBe('server')
    expect(rev()).toBeGreaterThan(before) // an inspector already shown re-renders with it
  })

  it('Bảng phát triển › Model: toggle, "Đọc lại ngay", toggle again, "Đọc lại ngay" seconds later → both changes read', async () => {
    server.login()
    withScenes(scene('s3', 3, { settings: { ...H3 } }))
    setModel('minimax_h3', { can_create: false })
    expect(await refreshProviderLimits('dev', { changed: true })).toBe('read')
    expect(check('s3')[0]).toMatchObject({ ok: false })
    setModel('minimax_h3', { can_create: true })
    await run(1_000)
    expect(await refreshProviderLimits('dev', { force: true })).toBe('fresh') // the inspector's "Đọc lại": click limit
    expect(await refreshProviderLimits('dev', { changed: true })).toBe('read') // the panel's button: always reads
    expect(logOf('video-profiles')).toHaveLength(2)
    expect(check('s3')[0]).toMatchObject({ ok: true, warnings: [] })
  })

  it('a one-shot fault armed while the read is fresh is not used up by an automatic refresh', async () => {
    server.login()
    await refreshProviderLimits('dev', { force: true })
    server.addFault(DEV_FAULT_PRESETS.find((p) => p.id === 'rate-429')!.rule)
    expect(await refreshProviderLimits('dev')).toBe('fresh')
    expect(server.faults()).toHaveLength(1)
    expect(logOf('video-profiles')).toHaveLength(1)
  })

  it('"Xoá dữ liệu máy chủ giả lập" (resetDevMode): a new provider knows nothing — "none", and the signal moves', async () => {
    server.login()
    await refreshProviderLimits('dev', { force: true })
    expect(providerLimits('dev').source).toBe('server')
    const before = rev()
    await resetDevMode()
    expect(rev()).toBeGreaterThan(before)
    expect(providerLimits('dev').source).toBe('none')
    expect(providerLimitsInfo('dev').lastAttempt).toBeNull()
  })

  it('while shown (watched) a firm read is renewed before it expires; unwatched it just stops being sure (no request)', async () => {
    server.login()
    await refreshProviderLimits('dev', { force: true })
    const stop = watchProviderLimits('dev')
    await run(PROFILES_TTL_MS - LIMITS_RENEW_EARLY_MS + 1_000)
    expect(logOf('video-profiles')).toHaveLength(2)
    expect(providerLimits('dev').firm).toBe(true)
    stop()
    const before = rev()
    await run(PROFILES_TTL_MS + 1_000)
    expect(logOf('video-profiles')).toHaveLength(2)
    expect(providerLimits('dev')).toMatchObject({ source: 'server', firm: false })
    expect(rev()).toBeGreaterThan(before)
  })
})

describe('dev mode e2e: "Nhập job" — a job made "on the site" (Bảng phát triển) becomes a take', () => {
  it('the simulated site’s job (edited node) is imported through the real engine: 720p from the node, billed once (by the site), dev words', async () => {
    server.login()
    const [t1] = enqueue('s1')
    await run(20_000)
    expect(take(t1.id).status).toBe('completed')
    const made = server.createSiteJob({ nodeId: sceneNodeId('p', 's1'), edit: { prompt: '@image_2 chạy dưới mưa', resolution: '720p' } })
    expect(made).toMatchObject({ ok: true })
    const cost720 = costOf({ ...S1, resolution: '720p' })
    expect(server.balance()).toBe(1000 - S1_COST - cost720)
    await run(DEV_LIST_CACHE_MS + 500) // the gateway's job-list cache (main: 15 s) may hide a job made a moment ago
    clearDevLog()
    const scan = await scanForImport()
    expect(scan).toMatchObject({ pid: 'dev', simulated: true })
    expect(scan.scan.candidates.map((c) => c.sceneId)).toEqual(['s1'])
    const res = await importSiteJobs(scan, scan.scan.candidates.map((c) => c.jobId))
    expect(res?.takeIds).toHaveLength(1)
    // read-only: nothing but GETs reached the simulated site
    expect(useDevLog.getState().entries.filter((e) => e.method !== 'GET')).toEqual([])
    const imp = take(res!.takeIds[0])
    expect(imp).toMatchObject({
      provider: 'dev',
      number: 2,
      promptSnapshot: '@image_2 chạy dưới mưa',
      settings: { resolution: '720p' },
      cost: cost720,
      imported: { inferred: ['resolution', 'refs'], unknown: [] },
    })
    expect(useUI.getState().toasts.at(-1)?.text).toBe('Đã nhập 1 video từ canvasapp giả lập vào S01 — không trừ credit dev.')
    expect(takeCostLine(imp).note).toBe('trả trên canvasapp giả lập khi tạo job (ngoài SanoVids) — nhập không trừ thêm')
    await run(20_000)
    expect(take(imp.id).status).toBe('completed')
    expect(await media.get(take(imp.id).videoId!)!.text()).toBe('WEBM:#2')
    // charged once — by the site, when it made the job; SanoVids sent no job
    expect(server.balance()).toBe(1000 - S1_COST - cost720)
    expect(server.snapshot().jobs.map((j) => j.origin)).toEqual(['site', 'app'])
    expect(logOf('job-create')).toEqual([])
  })

  it('a site job not imported yet on the node of a take whose answer is lost: the take finds its own job, the site job stays importable', async () => {
    server.login()
    server.setConfig({ dedupe: false }) // the job list carries no client_request_id (exposeKey off): only node + timing tell
    const [t1] = enqueue('s1')
    await run(20_000)
    expect(take(t1.id).status).toBe('completed')
    // the user presses "Tạo video" on S01's node "on the site" and does not import it
    const made = server.createSiteJob({ nodeId: sceneNodeId('p', 's1') })
    expect(made).toMatchObject({ ok: true })
    await run(DEV_LIST_CACHE_MS + 500)
    // back in SanoVids: S01 runs again and the answer of its POST is lost
    server.addFault({ endpoint: 'job-create', fault: { kind: 'lost-response' } })
    const [t2] = enqueue('s1')
    await run(60_000)
    const jobs = [...server.snapshot().jobs].reverse() // oldest first
    expect(jobs.map((j) => j.origin)).toEqual(['app', 'site', 'app'])
    expect(take(t2.id).remoteId).toBe(`${jobs[2].project_id}:${jobs[2].job_id}`) // never the site job
    expect(logOf('job-create')).toHaveLength(2)
    const scan = await scanForImport()
    expect(scan.scan.candidates.map((c) => c.jobId)).toEqual([jobs[1].job_id])
  })

  it('errors reach the dialog in development-mode words (never canvasapp.io.vn): session ended, network down', async () => {
    server.login()
    const [t1] = enqueue('s1')
    await run(20_000)
    expect(take(t1.id).status).toBe('completed')
    server.expireSession()
    const e401 = await scanForImport().catch((e: unknown) => e)
    expect(e401).toMatchObject({ code: 'login-required' })
    expect((e401 as Error).message).toContain('canvasapp giả lập')
    expect((e401 as Error).message).not.toContain('canvasapp.io.vn')
    server.login()
    server.addFault(DEV_FAULT_PRESETS.find((p) => p.id === 'list-network')!.rule)
    const eNet = await scanForImport().catch((e: unknown) => e)
    expect(eNet).toMatchObject({ code: 'network' })
    expect((eNet as Error).message).toContain('canvasapp giả lập')
    expect((eNet as Error).message).not.toContain('canvasapp.io.vn')
    expect(importWords(true)).toMatchObject({ site: 'canvasapp giả lập', credit: 'credit dev' })
  })
})
