// Seeded, deterministic fault-injection simulation of the canvasapp gateway: the real queue engine (store/runs) + the
// real adapter / api / desktop transport (providers/canvasapp) → a model of electron/main.cjs (its <canvasapp-routes>,
// <canvasapp-lanes> and <canvasapp-job-list-cache> blocks run as-is, the 60 s request timeout, requests that go on
// after the page that sent them went away) → the strict fake canvasapp.io.vn of the e2e tests (./fakeCanvasapp.ts).
// No network, fake clock (vitest fake timers), own PRNG (mulberry32), numbered ids: a seed replays exactly.
//
// Each seed draws a server (client_request_id dedupe off — the worst case — or on, a repeated key answered 409 or with
// its job; the job list with client_request_id on all / some / no jobs, with or without canvas_node_id, model_profile
// and duration; created_at zoned, with an offset, naive in another time zone, epoch seconds / ms, unreadable,
// missing; a server clock off by up to hours) and a scenario: 1–3 SanoVids projects (one may be a copy with the same
// scene ids), 1–4 scenes each, takes queued at random times, jobs made on the bridge nodes on canvasapp's own page
// (sometimes edited there), "Nhập job" scans + claims, and faults at random points — a request that never reaches
// canvasapp, a POST processed whose answer is lost, an answer slower than main's 60 s timeout, 5xx / 429 / 402,
// job-list reads that fail, are slow or come from main's 15 s cache, a page reload (the page's state and in-flight
// answers gone, storage and main's requests kept; the takes as last saved) right now or at any await point, cancel,
// "Chạy lại" of uncertain takes, a new take for a failed one, project switches, logout / login, this computer's clock
// set back, storage that refuses writes for a while. Then the network heals and a diligent user presses "Chạy lại" on
// every take still "không rõ", in every project, until nothing changes.
//
// Invariants (docs/GATEWAY-CANVASAPP.md §4 / §6), checked after every step and at the end:
//   I1 money     with dedupe off, canvasapp holds at most ONE job per SanoVids take key (client_request_id).
//   I2 one owner no job is the remoteId (or the ledger's job) of two takes; an imported take's job is never a SanoVids
//                take's job.
//   I3 own job   a SanoVids take's remoteId / ledger job carries its own client_request_id; an imported take's job was
//                made on canvasapp's page. The one exception is the documented residual risk without client_request_id
//                in the list (VERIFY): a job made on the site from the take's node with the take's prompt (model,
//                duration — as far as the list says them), listed by the first read that surely showed the take's own
//                job, while the take's own POST made nothing (counted: residualSameRequest).
//   I4 liveness  after the healthy period no take is queued / processing (deferred, sending); a take left "không rõ"
//                is allowed only when its job genuinely cannot be told apart from what the page can know (another
//                candidate the page cannot rule out, or a job another unanswered POST may own: counted, reported).
//   I5 hygiene   no unhandled rejection; no timer left once the engine is reset; nothing electron/main.cjs would refuse,
//                no malformed body (422).
// Fault model (what the adapter is allowed to bet on, docs §4): a POST's job, if it makes one, exists by the time its
// answer / error reaches the page + SETTLE_MS (30 s) — here at most 20 s after main gave up on it — and a POST of a page
// that went away ends within POST_IN_FLIGHT_MS; the clock never jumps forward.
//
// `npm test` runs seeds 1…150. More: SANOVIDS_FUZZ_SEEDS=5000 [SANOVIDS_FUZZ_FROM=1] npx vitest run canvasapp-fuzz;
// one seed with its whole trace: SANOVIDS_FUZZ_SEED=1234; every residual / excused case: SANOVIDS_FUZZ_NOTES=1.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const media = vi.hoisted(() => new Map<string, Blob>())
const ids = vi.hoisted(() => ({ n: 0 }))
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
// Take ids, download ids…: numbered per seed (a seed must replay exactly).
vi.mock('../../core/ids', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../core/ids')>()
  return {
    ...orig,
    newId: (prefix = '') => {
      const id = `00000000-0000-4000-8000-${(++ids.n).toString(16).padStart(12, '0')}`
      return prefix ? `${prefix}_${id}` : id
    },
  }
})

import type { Asset, Project, Scene, Take } from '../../core/types'
import { reconstructSiteJob } from '../canvasapp/siteJobs'
import { scanForImport } from '../../siteJobActions'
import { useProject } from '../../store/project'
import { isUncertainSubmit, resumeProviderPolling, setEngineHooks, setEngineLockManager, useRuns } from '../../store/runs'
import { useTakeWaits } from '../../store/takeWaits'
import { createCanvasappApi, type CanvasJob, type TransportRequest } from '../canvasapp/api'
import { createCanvasappProvider, JOBS_KEY, type CanvasappProvider, type KeyValueStorage } from '../canvasapp/adapter'
import { clientRequestIdFor, decodeRemoteId, modelProfileOf, sceneNodeId } from '../canvasapp/mapping'
import { inPostWindow, listedDuration } from '../canvasapp/siteJobs'
import { createDesktopTransport, type BridgeResponse, type CanvasappBridge } from '../canvasapp/transport'
import { gatewayProvider, getProvider, registerProvider, useProviderPrefs } from '../index'
import { fakeCanvasapp, mainBlock, mainRoutes, mainSource, type FakeJob } from './fakeCanvasapp'

// ---------------------------------------------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG (32-bit state). */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Rng {
  private next: () => number
  constructor(seed: number) {
    this.next = mulberry32(seed * 2654435761 + 12345)
  }
  float(): number {
    return this.next()
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  /** Integer in [a, b]. */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1))
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]
  }
  /** One of the keys, weighted. */
  weighted<K extends string>(w: Record<K, number>): K {
    const entries = Object.entries(w) as [K, number][]
    let r = this.next() * entries.reduce((s, [, x]) => s + x, 0)
    for (const [k, x] of entries) {
      if ((r -= x) < 0) return k
    }
    return entries[entries.length - 1][0]
  }
}

// ---------------------------------------------------------------------------------------------------------------
// electron/main.cjs blocks, run as-is
// ---------------------------------------------------------------------------------------------------------------

interface MainJobListCache {
  get(key: string): BridgeResponse | null
  ticket(): number
  put(key: string, ticket: number, sentAt: number, result: BridgeResponse): void
  drop(): void
}
const makeJobListCache = new Function('ttlMs', 'now', `${mainBlock('canvasapp-job-list-cache')}\nreturn createJobListCache(ttlMs, now)`) as (
  ttlMs: number,
  now: () => number,
) => MainJobListCache
const makeLanes = () =>
  new Function(`${mainBlock('canvasapp-lanes')}\nreturn { withSlot: withCanvasappSlot }`)() as {
    withSlot: <T>(lane: string, fn: () => Promise<T>) => Promise<T>
  }
/** main's job-list cache life (CANVASAPP_JOBS_MIN_MS), read from main itself. */
const CANVASAPP_JOBS_MIN_MS = Number(/const CANVASAPP_JOBS_MIN_MS = ([\d_]+)/.exec(mainSource)![1].replace(/_/g, ''))
/** main's per-request timeout once sent (canvasappRequest: setTimeout(abort, 60_000)). */
const MAIN_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------------------------------------------
// One seed's world
// ---------------------------------------------------------------------------------------------------------------

type CreatedFmt = 'zoned' | 'offset' | 'naive' | 'epoch-s' | 'epoch-ms' | 'garbage' | 'missing'

interface Cfg {
  dedupe: boolean
  /** Which jobs the list shows with their client_request_id: none, all, or some (VERIFY). */
  keys: 'none' | 'all' | 'some'
  hideNode: boolean
  created: CreatedFmt
  /** The server's own time zone (hours) — a naive created_at is written in it. */
  zoneH: number
  /** How far the server's clock is from this computer's. */
  skewMs: number
  projects: number
  duplicate: boolean
  /** 0.3–1.5: how often faults strike during the fault phase. */
  intensity: number
  faultMs: number
  siteJobs: boolean
  /** The user sets this computer's clock back now and then. */
  clockJumps: boolean
  /** With dedupe: a POST of a key already made is answered 409. */
  dedupeConflict: boolean
  /** The job list leaves out model_profile and duration. */
  hideSettings: boolean
  /** SanoVids' storage refuses writes now and then (full). */
  storageFaults: boolean
}

interface Violation {
  seed: number
  invariant: string
  message: string
}

/** A page of the app (a reload makes a new one): its requests, answers, storage writes and sleeps die with it. */
interface Page {
  n: number
  alive: boolean
  bridge: CanvasappBridge
  provider: CanvasappProvider
}

const never = <T,>() => new Promise<T>(() => undefined)
const clone = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))
const T0 = Date.parse('2026-10-07T03:00:00Z')

function drawCfg(rng: Rng, seed: number): Cfg {
  const created = rng.weighted<CreatedFmt>({ zoned: 3, offset: 1, naive: 3, 'epoch-s': 1, 'epoch-ms': 1, garbage: 0.5, missing: 1 })
  return {
    dedupe: rng.chance(0.3),
    keys: rng.weighted({ none: 6, all: 3, some: 1 }),
    hideNode: rng.chance(0.2),
    created,
    zoneH: rng.int(-12, 14),
    skewMs: rng.chance(0.7) ? rng.int(-120_000, 120_000) : rng.int(-10, 10) * 3600_000 + rng.int(-600_000, 600_000),
    projects: rng.int(1, 3),
    duplicate: rng.chance(0.5),
    intensity: 0.3 + rng.float() * 1.2,
    faultMs: (seed % 7 === 0 ? 40 : 12) * 60_000 + rng.int(0, 10) * 60_000,
    siteJobs: rng.chance(0.6),
    clockJumps: rng.chance(0.25),
    dedupeConflict: rng.chance(0.5),
    hideSettings: rng.chance(0.2),
    storageFaults: rng.chance(0.25),
  }
}

/** created_at as the server writes it (its clock, its format). */
function createdFormatter(cfg: Cfg): (ms: number) => unknown {
  const two = (n: number) => String(n).padStart(2, '0')
  const wall = (ms: number, zoneH: number) => {
    const d = new Date(ms + zoneH * 3600_000)
    return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}123`
  }
  return (local) => {
    const ms = local + cfg.skewMs
    switch (cfg.created) {
      case 'zoned':
        return new Date(ms).toISOString()
      case 'offset': {
        const h = cfg.zoneH
        return `${wall(ms, h)}${h < 0 ? '-' : '+'}${two(Math.abs(h))}:00`
      }
      case 'naive':
        return wall(ms, cfg.zoneH)
      case 'epoch-s':
        return Math.floor(ms / 1000)
      case 'epoch-ms':
        return ms
      case 'garbage': {
        const d = new Date(ms)
        return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
      }
      case 'missing':
        return undefined
    }
  }
}

const asset = (id: string, name: string, imageIds: string[]): Asset => ({ id, kind: 'character', name, tag: name, description: '', imageIds, color: '#fff', position: null })

function makeScene(id: string, order: number, rng: Rng): Scene {
  const refs = rng.chance(0.4) ? rng.pick([['elara'], ['elara', 'lumi'], ['lumi']]) : []
  return {
    id,
    order,
    title: 'Cảnh ' + order,
    prompt: refs.length ? '@image_1 đi dạo dưới mưa' : `Một con đường vắng ${order}`,
    refs,
    videoRefs: [],
    presetId: null,
    settings: { model: 'seedance_2_5', mode: 't2v', duration: rng.pick([5, 10]), resolution: '480p', ratio: '16:9' },
    firstFrame: null,
    lastFrame: null,
    color: null,
    position: { x: 0, y: order * 300 },
    note: '',
  }
}

function makeProjects(cfg: Cfg, rng: Rng): Project[] {
  const base = (id: string, scenes: Scene[]): Project => ({
    id,
    name: id,
    schemaVersion: 2,
    createdAt: 0,
    updatedAt: 0,
    presets: [],
    settings: { autoRenumber: true },
    assets: [asset('elara', 'Elara', ['img_e1']), asset('lumi', 'Lumi', ['img_l1', 'img_l2'])],
    scenes,
  })
  const n = rng.int(1, 4)
  const scenes = Array.from({ length: n }, (_, i) => makeScene(`s${i + 1}`, i + 1, rng))
  const out = [base('pA', scenes)]
  if (cfg.projects >= 2) out.push(cfg.duplicate ? base('pB', scenes.map((s) => ({ ...s }))) : base('pB', Array.from({ length: rng.int(1, 4) }, (_, i) => makeScene(`b${i + 1}`, i + 1, rng))))
  if (cfg.projects >= 3) out.push(base('pC', Array.from({ length: rng.int(1, 3) }, (_, i) => makeScene(`c${i + 1}`, i + 1, rng))))
  return out
}

function seedMedia() {
  media.clear()
  for (const id of ['img_e1', 'img_l1', 'img_l2']) media.set(id, new Blob(['IMG:' + id], { type: 'image/png' }))
}

type Ledger = {
  jobs: Record<string, { remoteId: string; nodeId?: string; before?: string[]; beforeAt?: number }>
  sent: Record<string, { projectId: string; nodeId: string; at: number; before?: string[]; beforeAt?: number; endedAt?: number; covered?: string[] }>
  imported: Record<string, { remoteId: string; nodeId: string }>
}

const SETTLE_MS = 30_000
const POST_IN_FLIGHT_MS = 5 * 60_000

async function runSeed(seed: number, verbose: boolean): Promise<{ violations: Violation[]; trace: string[]; unknownExcused: number; stats: Record<string, number> }> {
  const rng = new Rng(seed)
  const cfg = drawCfg(rng, seed)
  const violations: Violation[] = []
  const trace: string[] = []
  const stats: Record<string, number> = {}
  const count = (k: string) => (stats[k] = (stats[k] ?? 0) + 1)
  const fail = (invariant: string, message: string) => {
    if (!violations.some((v) => v.invariant === invariant && v.message === message)) violations.push({ seed, invariant, message })
  }
  const t = () => ((Date.now() - T0) / 1000).toFixed(1)
  const log = (s: string) => {
    trace.push(`${t()}s ${s}`)
    if (trace.length > 4000) trace.splice(0, 1000)
  }
  ids.n = 0
  seedMedia()
  vi.setSystemTime(T0)
  log(`cfg ${JSON.stringify(cfg)}`)
  const fake = fakeCanvasapp()
  Object.assign(fake.state, {
    dedupe: cfg.dedupe,
    dedupeConflict: cfg.dedupeConflict,
    exposeKey: cfg.keys === 'all',
    listKeyOf: cfg.keys === 'some' ? (j: FakeJob) => Number(j.job_id.replace(/\D/g, '')) % 2 === 0 : null,
    hideNode: cfg.hideNode,
    hideSettings: cfg.hideSettings,
    balance: 1e9,
    createdAt: createdFormatter(cfg),
  })
  const drawScript = (): Partial<FakeJob>[] => {
    const steps: Partial<FakeJob>[] = [{ status: 'queued', progress: 0 }]
    for (let i = rng.int(0, 3); i > 0; i--) steps.push({ status: 'processing', progress: 10 + i * 20 })
    steps.push(rng.chance(0.1) ? { status: 'failed', error_message: 'Lỗi giả lập' } : { status: 'completed', progress: 100, download_available: true })
    return steps
  }
  fake.state.script = drawScript()
  /**
   * This computer's clock, as SanoVids' page and main read it: the fake clock, set back now and then by the user (the
   * adapter's ledger is rewritten for that: unskewed). canvasapp's own clock is cfg.skewMs off, and never jumps.
   */
  let setBack = 0
  const localNow = () => Date.now() - setBack
  const cache = makeJobListCache(CANVASAPP_JOBS_MIN_MS, localNow)
  const lanes = makeLanes()
  const refusedByMain: string[] = []
  /** Faults strike only while this is true (the fault phase). */
  let faulty = true
  /** Requests answered by the fake server, per job POST: [sent by page n at, processed at]. */

  // ---- the network between main and canvasapp ----
  type Plan =
    | { kind: 'ok'; there: number; back: number }
    | { kind: 'refused'; there: number }
    | { kind: 'lost'; there: number; back: number }
    | { kind: 'hang'; process: number | null }
    | { kind: 'status'; there: number; status: number; json: unknown; process: boolean }
  const latency = () => (rng.chance(0.85) ? rng.int(20, 800) : rng.int(800, 8000))
  function plan(req: TransportRequest): Plan {
    const path = req.path.split('?')[0]
    const ok = (): Plan => ({ kind: 'ok', there: latency(), back: latency() })
    if (!faulty || path === '/api/auth/state') return ok()
    const f = cfg.intensity
    if (req.method === 'POST' && path === '/api/video-jobs') {
      const k = rng.weighted({
        ok: 3.2 / f,
        refused: 0.35,
        lost: 0.45,
        slow: 0.2,
        slowLost: 0.15,
        hangUnprocessed: 0.12,
        hangProcessed: 0.15,
        badGatewayAfter: 0.15,
        emptyAfter: 0.08,
        unavailable: 0.1,
        tooMany: 0.05,
        noCredit: 0.04,
      })
      switch (k) {
        case 'refused':
          return { kind: 'refused', there: latency() }
        case 'lost':
          return { kind: 'lost', there: latency(), back: latency() }
        case 'slow':
          return { kind: 'ok', there: rng.int(5_000, 80_000), back: latency() }
        case 'slowLost':
          return { kind: 'lost', there: rng.int(5_000, MAIN_TIMEOUT_MS + 20_000), back: latency() }
        case 'hangUnprocessed':
          return { kind: 'hang', process: null }
        case 'hangProcessed':
          return { kind: 'hang', process: rng.int(100, MAIN_TIMEOUT_MS + 20_000) }
        case 'badGatewayAfter':
          return { kind: 'status', there: latency(), status: 502, json: { detail: 'Bad gateway' }, process: true }
        case 'emptyAfter':
          return { kind: 'status', there: latency(), status: 200, json: { ok: true }, process: true }
        case 'unavailable':
          return { kind: 'status', there: latency(), status: 503, json: { detail: 'down' }, process: false }
        case 'tooMany':
          return { kind: 'status', there: latency(), status: 429, json: { detail: 'Too many requests' }, process: false }
        case 'noCredit':
          return { kind: 'status', there: latency(), status: 402, json: { detail: 'Insufficient credits' }, process: false }
        default:
          return ok()
      }
    }
    if (req.method === 'GET' && path === '/api/video-jobs') {
      const k = rng.weighted({ ok: 4 / f, refused: 0.4, unavailable: 0.25, slow: 0.35, hang: 0.08 })
      if (k === 'refused') return { kind: 'refused', there: latency() }
      if (k === 'unavailable') return { kind: 'status', there: latency(), status: 503, json: { detail: 'down' }, process: false }
      if (k === 'slow') return { kind: 'ok', there: rng.int(1_000, 40_000), back: rng.int(100, 40_000) }
      if (k === 'hang') return { kind: 'hang', process: null }
      return ok()
    }
    const k = rng.weighted({ ok: 6 / f, refused: 0.25, unavailable: 0.15, lost: 0.15, slow: 0.15 })
    if (k === 'refused') return { kind: 'refused', there: latency() }
    if (k === 'unavailable') return { kind: 'status', there: latency(), status: 503, json: { detail: 'down' }, process: false }
    if (k === 'lost') return { kind: 'lost', there: latency(), back: latency() }
    if (k === 'slow') return { kind: 'ok', there: rng.int(2_000, 70_000), back: latency() }
    return ok()
  }

  const describeReq = (req: TransportRequest) => {
    const path = req.path.split('?')[0]
    const body = req.json as { client_request_id?: string; canvas_node_id?: string; project_id?: string } | undefined
    const key = req.method === 'POST' && path === '/api/video-jobs' ? ` key=${String(body?.client_request_id).slice(-6)} node=${String(body?.canvas_node_id).slice(0, 6)} ${body?.project_id}` : ''
    return `${req.method} ${req.method === 'GET' ? req.path : path}${key}`
  }
  const netError = (timeout: boolean): BridgeResponse => ({
    ok: false,
    code: 'network',
    message: timeout ? 'canvasapp.io.vn không phản hồi (quá thời gian chờ).' : 'Không kết nối được tới canvasapp.io.vn (offline).',
  })
  /** What canvasapp does with a request main sent at `sentAt`, and what main gets back (null: nothing within 60 s). */
  function wire(req: TransportRequest, from: number): Promise<BridgeResponse> {
    const p = plan(req)
    const label = describeReq(req)
    const serve = () => {
      const res = fake.handle(req.json === undefined ? req : { ...req, json: clone(req.json) })
      if (req.method === 'POST' && req.path === '/api/video-jobs') log(`  server ${label} → ${res.ok ? `${res.status} ${JSON.stringify(res.json).slice(0, 60)}` : res.code}`)
      return res
    }
    if (p.kind !== 'ok' || req.method !== 'GET') log(`  main→ p${from} ${label} plan ${JSON.stringify(p)}`)
    return new Promise<BridgeResponse>((resolve) => {
      let done = false
      const finish = (r: BridgeResponse) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => finish(netError(true)), MAIN_TIMEOUT_MS)
      switch (p.kind) {
        case 'ok':
          setTimeout(() => {
            const res = serve()
            setTimeout(() => finish(res), p.back)
          }, p.there)
          break
        case 'refused':
          setTimeout(() => finish(netError(false)), p.there)
          break
        case 'lost':
          setTimeout(() => {
            serve()
            setTimeout(() => finish(netError(true)), p.back)
          }, p.there)
          break
        case 'hang':
          if (p.process !== null) setTimeout(serve, p.process)
          break
        case 'status':
          setTimeout(() => {
            if (p.process) serve()
            finish({ ok: true, status: p.status, contentType: 'application/json', json: p.json })
          }, p.there)
          break
      }
    })
  }

  /** electron/main.cjs canvasappRequest: allowlist, the job-list cache, the 'api' lane, the request. */
  async function mainRequest(req: TransportRequest, from: number): Promise<BridgeResponse> {
    const method = String(req.method || 'GET').toUpperCase()
    const m = mainRoutes.matchRequest(method, req.path) as { route: unknown; url: URL } | null
    fake.log.push({ ...req, at: Date.now() })
    if (!m) {
      refusedByMain.push(`${method} ${req.path}`)
      return { ok: false, code: 'not-allowed', message: `SanoVids không được phép gọi ${method} ${req.path}.` }
    }
    if (req.json !== undefined && new TextEncoder().encode(JSON.stringify(req.json)).byteLength > mainRoutes.maxJsonBytes) {
      refusedByMain.push(`${method} ${req.path} (too large)`)
      return { ok: false, code: 'too-large', message: 'Dữ liệu gửi đi quá lớn.' }
    }
    const cacheKey = method === 'GET' && m.url.pathname === '/api/video-jobs' ? m.url.search : null
    if (cacheKey !== null) {
      const hit = cache.get(cacheKey)
      if (hit) {
        if (verbose) log(`  main cache hit ${req.path}`)
        return clone(hit)
      }
    }
    const createsJob = method === 'POST' && m.url.pathname === '/api/video-jobs'
    if (createsJob) cache.drop()
    const ticket = cache.ticket()
    let sentAt = 0
    try {
      const result = await lanes.withSlot('api', async () => {
        sentAt = localNow() // (main's clock: this computer's, the cache's own)
        return wire(req, from)
      })
      if (cacheKey !== null && result.ok && result.status === 200) {
        cache.put(cacheKey, ticket, sentAt, clone(result))
      }
      return result
    } finally {
      if (createsJob) cache.drop()
    }
  }

  // ---- pages ----
  const shared = new Map<string, string>()
  /** Storage refuses writes (full) while set — what saveLedger reads back then is the old value. */
  let storageFull = false
  let page: Page | null = null
  let pages = 0
  function newPage(): Page {
    const me = { n: ++pages, alive: true } as Page
    /** An answer for this page — never once it went away (its JavaScript is gone). */
    const deliver = <T,>(p: Promise<T>): Promise<T> => (me.alive ? new Promise<T>((resolve, reject) => p.then((v) => me.alive && resolve(v), (e) => me.alive && reject(e))) : never<T>())
    me.bridge = {
      status: () => deliver(Promise.resolve({ ok: true as const, authenticated: fake.state.authenticated })),
      login: () => deliver(Promise.resolve({ ok: true as const, authenticated: true })),
      logout: () => deliver(Promise.resolve({ ok: true })),
      request: (req) => (me.alive ? deliver(mainRequest(req, me.n)) : never()),
      downloadOpen: (a) => (me.alive ? deliver(fake.bridge.downloadOpen!(a)) : never()),
      downloadRead: (a) => (me.alive ? deliver(fake.bridge.downloadRead!(a)) : never()),
      downloadClose: (a) => (me.alive ? deliver(fake.bridge.downloadClose!(a)) : never()),
    }
    const storage: KeyValueStorage = {
      get: (k) => shared.get(k) ?? null,
      set: (k, v) => {
        if (me.alive && !storageFull) shared.set(k, v)
      },
      remove: (k) => {
        if (me.alive) shared.delete(k)
      },
    }
    const api = createCanvasappApi(createDesktopTransport(() => me.bridge))
    const list = api.listVideoJobs.bind(api)
    api.listVideoJobs = async (projectId) => {
      const sentAt = localNow()
      const sentReal = Date.now()
      try {
        const jobs = await list(projectId)
        if (verbose) log(`  p${me.n} list ${projectId} sent@${((sentAt - T0) / 1000).toFixed(1)} → ${jobs.map((j) => j.job_id).join(',')}`)
        noteCovering(projectId, sentAt, jobs, me.n)
        return jobs
      } catch (e) {
        if (verbose) log(`  p${me.n} list failed: ${(e as Error).message.slice(0, 40)}`)
        throw e
      }
    }
    me.provider = createCanvasappProvider({
      api,
      getBlob: async (id) => media.get(id) ?? null,
      storage,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(() => me.alive && resolve(), ms)),
      imageSize: async () => ({ width: 1920, height: 1080 }),
      now: localNow,
    })
    registerProvider(me.provider)
    ;(globalThis as { window?: unknown }).window = { bdpDesktop: { canvasapp: me.bridge } }
    return me
  }

  // ---- projects and what is "on disk" ----
  const projects = makeProjects(cfg, rng)
  const disk = new Map<string, Take[]>(projects.map((p) => [p.id, []]))
  let openId = projects[0].id
  const projectOf = (id: string) => projects.find((p) => p.id === id)!
  const takes = () => useRuns.getState().takes
  const saveRuns = () => disk.set(openId, clone(takes()))
  const allTakes = (): Take[] => [...takes(), ...[...disk].filter(([id]) => id !== openId).flatMap(([, ts]) => ts)]
  const ledger = (): Ledger => {
    const raw = shared.get(JOBS_KEY)
    const p = raw ? (JSON.parse(raw) as Partial<Ledger>) : {}
    return { jobs: p.jobs ?? {}, sent: p.sent ?? {}, imported: p.imported ?? {} }
  }

  const open = (id: string) => {
    openId = id
    useProject.getState().loadProject(clone(projectOf(id)))
    useRuns.getState().loadRuns({ takes: clone(disk.get(id) ?? []), credits: 1000, spent: 0 })
  }

  function reload(why: string) {
    log(`RELOAD (${why})`)
    count('reload')
    if (page) page.alive = false
    fake.closeDownloads()
    page = newPage()
    open(openId)
  }

  // ---- what the page could know: the first job-list read that surely showed each unanswered POST's job ----
  /**
   * `${key}@${at}` → the jobs listed by the first read that surely shows that POST's job, if any; the page that read it;
   * whether storage kept what the page noted then (not while full: a reload forgets it).
   */
  const firstCovering = new Map<string, { jobs: Set<string>; page: number; durable: boolean }>()
  /** key → `at` of its unanswered POST as last seen in the ledger. */
  const lastPostAt = new Map<string, number>()
  function noteCovering(projectId: string, sentLocal: number, jobs: CanvasJob[], pageN: number) {
    const l = ledger()
    for (const [k, r] of Object.entries(l.sent)) {
      if (k in l.jobs || r.projectId !== projectId || !Number.isFinite(r.at)) continue
      lastPostAt.set(k, r.at)
      const id = `${k}@${r.at}`
      const listedBy = (r.endedAt ?? r.at + POST_IN_FLIGHT_MS) + SETTLE_MS
      if (!firstCovering.has(id) && sentLocal - CANVASAPP_JOBS_MIN_MS >= listedBy) {
        firstCovering.set(id, { jobs: new Set(jobs.map((j) => j.job_id)), page: pageN, durable: !storageFull })
      }
    }
  }

  // ---- invariants ----
  /**
   * The residual risk without client_request_id in the job list (VERIFY): a job made on canvasapp's page from the
   * take's own node (any node when the list has no canvas_node_id either) with the take's own prompt, model and
   * duration (when the list says them) — the same request, paid once — while the take's own POST made nothing. It cannot be told from the take's own job; the take settles on it (docs §6).
   */
  function sameRequestSiteJob(key: string, job: FakeJob): boolean {
    if (!fake.isSiteKey(job.client_request_id) || typeof fake.listView(job).client_request_id === 'string') return false
    if (fake.state.jobs.some((j) => j.client_request_id === clientRequestIdFor(key))) return false
    const own = fake.jobPosts().find((b) => b.client_request_id === clientRequestIdFor(key))
    if (!own) return false
    // not listed by a read that surely showed the take's own job, if any: the page knew it was not its own
    const at = lastPostAt.get(key)
    const covering = at === undefined ? undefined : firstCovering.get(`${key}@${at}`)
    if (covering && !covering.jobs.has(job.job_id) && (covering.durable || covering.page === page?.n)) return false
    return (
      // (a list without canvas_node_id cannot tell the node either: VERIFY)
      (cfg.hideNode || job.canvas_node_id === own.canvas_node_id) &&
      String(job.body.prompt).trim() === String(own.prompt).trim() &&
      // (a list without model_profile / duration cannot tell those either: VERIFY)
      (cfg.hideSettings || (job.body.model_profile === own.model_profile && job.body.duration === own.duration))
    )
  }
  const residuals = new Set<string>()
  function residual(key: string, job: FakeJob) {
    if (residuals.has(key)) return
    residuals.add(key)
    count('residualSameRequest')
    const posts = fake.log.filter((c) => c.method === 'POST' && c.path === '/api/video-jobs' && (c.json as { client_request_id?: string })?.client_request_id === clientRequestIdFor(key)).map((c) => c.at)
    log(`RESIDUAL take ${key.slice(-4)} settled on the same-request site job ${job.job_id} made ${posts.map((at) => Math.round((job.madeAt - at) / 1000)).join('/')} s after its POST(s) (its own POST made nothing)`)
  }
  const siteKeys = () => new Set(fake.state.jobs.filter((j) => fake.isSiteKey(j.client_request_id)).map((j) => j.job_id))
  function checkMoneyAndOwners(when: string) {
    // I1: one job per SanoVids key
    if (!cfg.dedupe) {
      const per = new Map<string, number>()
      for (const j of fake.state.jobs) if (!fake.isSiteKey(j.client_request_id)) per.set(j.client_request_id, (per.get(j.client_request_id) ?? 0) + 1)
      for (const [key, n] of per) if (n > 1) fail('I1', `${n} jobs carry key …${key.slice(-6)} (${when})`)
    }
    const jobById = new Map(fake.state.jobs.map((j) => [j.job_id, j]))
    const site = siteKeys()
    // I2 / I3 over every take (open project + disk)
    const owners = new Map<string, string[]>()
    for (const tk of allTakes()) {
      if (!tk.remoteId) continue
      const d = decodeRemoteId(tk.remoteId)
      if (!d) continue
      owners.set(d.jobId, [...(owners.get(d.jobId) ?? []), tk.id])
      const job = jobById.get(d.jobId)
      if (!job) continue
      if (tk.imported) {
        if (!site.has(d.jobId)) fail('I3', `imported take ${tk.id.slice(-4)} has SanoVids job ${d.jobId} (${when})`)
      } else if (job.client_request_id !== clientRequestIdFor(tk.id)) {
        if (sameRequestSiteJob(tk.id, job)) residual(tk.id, job)
        else fail('I3', `take ${tk.id.slice(-4)} has job ${d.jobId} of ${site.has(d.jobId) ? 'the site' : `key …${job.client_request_id.slice(-6)}`} (${when})`)
      }
    }
    for (const [jobId, who] of owners) if (who.length > 1) fail('I2', `job ${jobId} is the remoteId of ${who.map((x) => x.slice(-4)).join(', ')} (${when})`)
    // ...and over the adapter's ledger (takes lost by a reload still have records there)
    const l = ledger()
    const made = new Map<string, string>()
    for (const [key, r] of Object.entries(l.jobs)) {
      const d = decodeRemoteId(r.remoteId)
      if (!d) continue
      if (made.has(d.jobId)) fail('I2', `ledger: job ${d.jobId} is the job of ${made.get(d.jobId)!.slice(-4)} and ${key.slice(-4)} (${when})`)
      made.set(d.jobId, key)
      const job = jobById.get(d.jobId)
      if (job && job.client_request_id !== clientRequestIdFor(key) && sameRequestSiteJob(key, job)) residual(key, job)
      else if (job && job.client_request_id !== clientRequestIdFor(key)) fail('I3', `ledger: key ${key.slice(-4)} → job ${d.jobId} of ${site.has(d.jobId) ? 'the site' : `key …${job.client_request_id.slice(-6)}`} (${when})`)
    }
    for (const [key, r] of Object.entries(l.imported)) {
      const d = decodeRemoteId(r.remoteId)
      if (d && made.has(d.jobId)) fail('I2', `ledger: imported ${key.slice(-4)} and SanoVids ${made.get(d.jobId)!.slice(-4)} share job ${d.jobId} (${when})`)
      if (d && !site.has(d.jobId) && jobById.has(d.jobId)) fail('I3', `ledger: imported ${key.slice(-4)} → SanoVids job ${d.jobId} (${when})`)
    }
  }

  // ---- actions ----
  const pickTake = (pred: (x: Take) => boolean): Take | null => {
    const xs = takes().filter(pred)
    return xs.length ? rng.pick(xs) : null
  }
  let loggedOut = false
  async function importJobs() {
    const p = page!
    try {
      const scan = await scanForImport('canvasapp')
      if (!p.alive || !scan.scan.candidates.length) return
      const picked = scan.scan.candidates.filter(() => rng.chance(0.8)).slice(0, 20)
      if (!picked.length) return
      const prompts = await gatewayProvider('canvasapp').siteJobPrompts(picked.map((c) => c.jobId))
      if (!p.alive || useProject.getState().project.id !== scan.projectId) return
      const project = useProject.getState().project
      const drafts = picked.map((c) => reconstructSiteJob(c, prompts[c.jobId] ?? null, (imageId) => project.assets.find((a) => a.imageIds.includes(imageId))?.id ?? null))
      const res = useRuns.getState().importTakes({ projectId: scan.projectId, provider: 'canvasapp', drafts, claim: (claims) => p.provider.claimSiteJobs(claims) })
      log(`import → ${res.takeIds.map((x) => x.slice(-4)).join(',') || 'none'} (skipped ${res.skipped.map((s) => s.code).join(',')})`)
      if (res.takeIds.length) count('imported')
    } catch (e) {
      log(`import failed: ${(e as Error).message?.slice(0, 60)}`)
    }
  }
  function siteJob() {
    const bridge = fake.state.projects.find((x) => x.name === 'SanoVids bridge')
    const canvas = bridge && fake.state.canvases.get(bridge.project_id)
    const nodes = canvas?.nodes.filter((n) => n.type === 'video').map((n) => n.id) ?? []
    if (!nodes.length) return
    const node = rng.pick(nodes)
    try {
      const job = fake.siteJob(node, rng.chance(0.3) ? { prompt: `Sửa trên trang ${rng.int(1, 99)}` } : undefined)
      log(`SITE job ${job.job_id} on ${node.slice(0, 6)}`)
      count('siteJob')
    } catch (e) {
      log(`site job refused: ${(e as Error).message.slice(0, 60)}`)
    }
  }
  const later = (ms: number, fn: () => void) => setTimeout(fn, ms)

  async function act() {
    const kind = rng.weighted({
      enqueue: 3,
      cancel: 0.6,
      retry: 1.2,
      rerun: 0.2,
      reload: 0.5,
      reloadSoon: 0.6,
      cancelSoon: 0.3,
      switch: cfg.projects > 1 ? 0.5 : 0,
      logout: 0.15,
      site: cfg.siteJobs ? 0.6 : 0,
      import: cfg.siteJobs ? 0.5 : 0,
      persist: 1,
      script: 0.2,
      clockBack: cfg.clockJumps ? 0.08 : 0,
      storage: cfg.storageFaults ? 0.15 : 0,
    })
    switch (kind) {
      case 'enqueue': {
        const scenes = useProject.getState().project.scenes
        const picked = scenes.filter(() => rng.chance(0.5))
        const sceneIds = (picked.length ? picked : [rng.pick(scenes)]).map((s) => s.id)
        const r = useRuns.getState().enqueue(sceneIds)
        log(`enqueue ${sceneIds.join(',')} → ${takes().slice(-r.queued).map((x) => x.id.slice(-4)).join(',')}${r.error ? ' ' + r.error : ''}`)
        break
      }
      case 'cancel': {
        const x = pickTake((y) => y.status === 'queued' || y.status === 'processing')
        if (x) {
          log(`cancel ${x.id.slice(-4)} (${x.status}${x.remoteId ? ' ' + x.remoteId : ''})`)
          useRuns.getState().cancel(x.id)
        }
        break
      }
      case 'retry': {
        const x = pickTake(isUncertainSubmit)
        if (x) {
          log(`retry ${x.id.slice(-4)}`)
          useRuns.getState().retry(x.id)
          count('retry')
        }
        break
      }
      case 'rerun': {
        const x = pickTake((y) => y.status === 'failed' && !isUncertainSubmit(y))
        if (x) {
          log(`rerun ${x.id.slice(-4)} (new take)`)
          useRuns.getState().retry(x.id)
        }
        break
      }
      case 'reload':
        if (rng.chance(0.5)) saveRuns()
        reload('now')
        break
      case 'reloadSoon': {
        const ms = rng.int(0, 3000)
        const flush = rng.chance(0.4)
        later(ms, () => {
          if (flush) saveRuns()
          reload(`after ${ms} ms`)
        })
        break
      }
      case 'cancelSoon': {
        const x = pickTake((y) => y.status === 'queued' || y.status === 'processing')
        if (x) {
          const ms = rng.int(0, 3000)
          later(ms, () => {
            if (useProject.getState().project.id !== openId) return
            log(`cancel ${x.id.slice(-4)} (soon)`)
            useRuns.getState().cancel(x.id)
          })
        }
        break
      }
      case 'switch': {
        saveRuns()
        const other = rng.pick(projects.filter((p) => p.id !== openId))
        log(`switch → ${other.id}`)
        open(other.id)
        break
      }
      case 'logout': {
        if (loggedOut) break
        loggedOut = true
        log('LOGOUT')
        cache.drop()
        fake.closeDownloads()
        fake.state.authenticated = false
        page!.provider.reset()
        later(rng.int(5_000, 180_000), () => {
          log('LOGIN')
          loggedOut = false
          fake.state.authenticated = true
          resumeProviderPolling('canvasapp')
        })
        break
      }
      case 'site':
        siteJob()
        break
      case 'import':
        void importJobs()
        break
      case 'persist':
        saveRuns()
        break
      case 'script':
        fake.state.script = drawScript()
        break
      case 'storage': {
        storageFull = true
        log('STORAGE full')
        count('storageFull')
        later(rng.int(1_000, 120_000), () => {
          storageFull = false
          log('STORAGE ok')
        })
        break
      }
      case 'clockBack': {
        const ms = rng.pick([2_000, 20_000, 90_000, 10 * 60_000, 2 * 3600_000])
        setBack += ms
        log(`CLOCK set back ${ms / 1000} s`)
        count('clockBack')
        break
      }
    }
  }

  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms)
  }
  const randomGap = () => {
    const k = rng.weighted({ tiny: 4, small: 3, medium: 2, large: 1 })
    return k === 'tiny' ? rng.int(0, 400) : k === 'small' ? rng.int(400, 5_000) : k === 'medium' ? rng.int(5_000, 60_000) : rng.int(60_000, 240_000)
  }

  // ---- run ----
  // every change of a take's state, for the trace
  const seen = new Map<string, string>()
  const offTrace = useRuns.subscribe((st) => {
    for (const x of st.takes) {
      const sig = `${x.status}|${x.remoteId ?? ''}|${x.submitUnknown ? 'U' : ''}|${(x.error ?? '').slice(0, 50)}`
      if (seen.get(x.id) === sig) continue
      seen.set(x.id, sig)
      log(`    take ${x.id.slice(-4)} (key …${clientRequestIdFor(x.id).slice(-6)}) ${x.status}${x.remoteId ? ' ' + x.remoteId : ''}${x.submitUnknown ? ' U' : ''}${x.error ? ' — ' + x.error.slice(0, 70) : ''}`)
    }
  })
  useProviderPrefs.setState({ provider: 'canvasapp' })
  page = newPage()
  open(openId)
  const faultEnd = T0 + cfg.faultMs
  let steps = 0
  while (Date.now() < faultEnd && steps < 400) {
    steps++
    await act()
    await advance(randomGap())
    checkMoneyAndOwners(`step ${steps}`)
    if (violations.length) break
  }

  // ---- healthy period: the network heals, the user logs in again and retries every take "không rõ" ----
  faulty = false
  storageFull = false
  if (!violations.length) {
    log('=== HEALTHY ===')
    await advance(200_000) // pending logins, reloads, cancels of the fault phase happen
    fake.state.authenticated = true
    loggedOut = false
    resumeProviderPolling('canvasapp')
    const quiet = () => !takes().some((x) => x.status === 'queued' || x.status === 'processing')
    for (let round = 0; round < 4 && !violations.length; round++) {
      for (const p of projects) {
        saveRuns()
        open(p.id)
        for (const x of takes().filter(isUncertainSubmit)) {
          log(`healthy retry ${x.id.slice(-4)}`)
          useRuns.getState().retry(x.id)
        }
        for (let i = 0; i < 120 && !quiet(); i++) await advance(15_000)
        checkMoneyAndOwners(`healthy round ${round} ${p.id}`)
      }
      await advance(7 * 60_000)
    }
    saveRuns()
  }

  // ---- I4: liveness ----
  let unknownExcused = 0
  if (!violations.length) {
    const l = ledger()
    for (const [pid, ts] of disk) {
      for (const x of ts) {
        if (x.status === 'queued' || x.status === 'processing') {
          fail('I4', `take ${x.id.slice(-4)} of ${pid} still ${x.status}${x.remoteId ? ' ' + x.remoteId : ' (no job)'}${useTakeWaits.getState().byTake[x.id] ? ' waiting' : ''}: ${x.error ?? ''}`)
          continue
        }
        if (!isUncertainSubmit(x)) continue
        const why = excuse(x, l)
        if (why) {
          unknownExcused++
          log(`unknown ${x.id.slice(-4)} excused: ${why}`)
        } else {
          fail('I4', `take ${x.id.slice(-4)} of ${pid} stays "không rõ" although its job can be told apart: ${x.error?.slice(0, 160)}`)
          log(`  its record: ${JSON.stringify(l.sent[x.id])} local now ${((localNow() - T0) / 1000).toFixed(1)}`)
          if (verbose) {
            for (const [k, r] of Object.entries(l.jobs)) if (r.nodeId === l.sent[x.id]?.nodeId) log(`  job record ${k.slice(-4)}: ${JSON.stringify(r)}`)
            for (const [k, r] of Object.entries(l.sent)) if (k !== x.id) log(`  other sent ${k.slice(-4)}: ${JSON.stringify(r).slice(0, 300)}`)
            log(`  jobs: ${JSON.stringify(fake.state.jobs.slice(-4).map((j) => fake.listView(j)))}`)
          }
        }
      }
    }
  }

  // ---- I5: hygiene ----
  offTrace()
  page!.alive = false
  useRuns.getState().loadRuns(null)
  await advance(15 * 60_000)
  const timers = vi.getTimerCount()
  if (timers) fail('I5', `${timers} timer(s) still pending once the engine was reset`)
  if (refusedByMain.length) fail('I5', `main refused: ${refusedByMain.slice(0, 3).join('; ')}`)
  const malformed = fake.state.rejected.filter((r) => r.status === 422)
  if (malformed.length) fail('I5', `422: ${malformed[0].path} ${malformed[0].detail}`)
  vi.clearAllTimers()
  if (verbose || violations.length) log(`stats ${JSON.stringify(stats)} jobs=${fake.state.jobs.length}`)
  return { violations, trace, unknownExcused, stats }

  /**
   * Why take `x`, still "không rõ" after the healthy period, genuinely cannot be decided — or null when it can. Its job
   * (or none) can only be told apart without client_request_id in the list: some other job is a candidate the take's
   * own information (its node, the read before its POST, the window of its POST, the other takes' reads) cannot rule
   * out.
   */
  function excuse(x: Take, l: Ledger): string | null {
    const rec = l.sent[x.id]
    if (!rec) return null
    if (cfg.keys === 'all') return null
    const key = clientRequestIdFor(x.id)
    const view = (j: FakeJob) => fake.listView(j) as unknown as CanvasJob
    // its own job listed with its key: found exactly, never "không rõ"
    const ownJob = fake.state.jobs.find((j) => j.client_request_id === key)
    if (ownJob && typeof view(ownJob).client_request_id === 'string') return null
    const taken = new Set([...Object.entries(l.jobs).filter(([k]) => k !== x.id), ...Object.entries(l.imported)].map(([, r]) => decodeRemoteId(r.remoteId)?.jobId))
    const listedBy = (r: Ledger['sent'][string]) => (r.endedAt ?? r.at + POST_IN_FLIGHT_MS) + SETTLE_MS
    const covering = [
      ...Object.entries(l.sent).filter(([k, r]) => k !== x.id && !(k in l.jobs) && r.projectId === rec.projectId && r.nodeId === rec.nodeId),
      ...Object.entries(l.jobs).filter(([k, r]) => k !== x.id && r.nodeId === rec.nodeId && Array.isArray(r.before) && typeof r.beforeAt === 'number'),
    ]
      .map(([, r]) => r as { before?: string[]; beforeAt?: number })
      .filter((r) => r.beforeAt !== undefined && r.beforeAt >= listedBy(rec))
      .map((r) => new Set(r.before ?? []))
    const others = fake.state.jobs.filter((j) => {
      if (j.project_id !== rec.projectId || j.client_request_id === key) return false
      const v = view(j)
      if (typeof v.client_request_id === 'string') return false // listed with another key: never its own
      if (typeof v.canvas_node_id === 'string' && v.canvas_node_id !== rec.nodeId) return false
      if (rec.before?.includes(j.job_id) || taken.has(j.job_id)) return false
      if (rec.covered && !rec.covered.includes(j.job_id)) return false
      if (covering.some((b) => !b.has(j.job_id))) return false
      if (typeof v.model_profile === 'string' && v.model_profile !== modelProfileOf(x.settings.model)) return false
      const d = listedDuration(v.duration)
      if (d !== null && d !== x.settings.duration) return false
      return inPostWindow(v.created_at, rec.at) ?? true
    })
    // with its own job there, a job canvasapp gives another prompt for is told apart (the prompt check before settling)
    const own = fake.state.jobs.find((j) => j.client_request_id === key)
    const posted = fake.jobPosts().find((b) => b.client_request_id === key)
    const confusable = own && posted ? others.filter((j) => String(j.body.prompt).trim() === String(posted.prompt).trim()) : others
    if (others.length && !(own && !confusable.length && others.length <= 3)) {
      count(others.some((j) => fake.isSiteKey(j.client_request_id)) ? 'excusedSite' : 'excusedTake')
      return `${others.length} other candidate job(s) ${others.map((j) => `${j.job_id}${fake.isSiteKey(j.client_request_id) ? '(site)' : ''}`).join(',')}`
    }
    // its own job, the only candidate — but another take still without an answer could own it as well (its read before
    // did not show it, or this take's read before did not surely show that take's job)
    if (own) {
      const v = view(own)
      const rival = Object.entries(l.sent).find(([k, r]) => {
        if (k === x.id || k in l.jobs || r.projectId !== rec.projectId) return false
        if (!(typeof v.canvas_node_id !== 'string' || v.canvas_node_id === r.nodeId) || r.before?.includes(own.job_id)) return false
        if (r.covered && !r.covered.includes(own.job_id)) return false
        if (!(inPostWindow(v.created_at, r.at) ?? true)) return false
        return r.at >= rec.at || rec.beforeAt === undefined || rec.beforeAt < listedBy(r)
      })
      if (rival) {
        count('excusedContested')
        return `its job ${own.job_id} could be take ${rival[0].slice(-4)}'s too`
      }
    }
    return null
  }
}

// ---------------------------------------------------------------------------------------------------------------

const realMock = getProvider('mock')
const realDev = getProvider('dev')
const unhandled: string[] = []
let currentSeed = 0
const onUnhandled = (e: unknown) => {
  unhandled.push(`seed ${currentSeed}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
}

beforeAll(() => {
  process.on('unhandledRejection', onUnhandled)
  setEngineLockManager(null)
  setEngineHooks({})
})
afterEach(() => {
  vi.useRealTimers()
})
afterAll(() => {
  process.off('unhandledRejection', onUnhandled)
  registerProvider(realMock)
  registerProvider(realDev)
  useProviderPrefs.setState({ provider: 'dev' })
  setEngineLockManager(undefined)
  delete (globalThis as { window?: unknown }).window
})

const env = (k: string) => (typeof process !== 'undefined' ? process.env[k] : undefined)
const ONE = env('SANOVIDS_FUZZ_SEED')
/** The default run (`npm test`): seeds 1…150, ~15–20 s. */
const COUNT = Number(env('SANOVIDS_FUZZ_SEEDS') ?? 150)
const FROM = Number(env('SANOVIDS_FUZZ_FROM') ?? 1)
/** Print every residual / excused "không rõ" line (SANOVIDS_FUZZ_NOTES=1). */
const NOTES = !!env('SANOVIDS_FUZZ_NOTES')

describe('canvasapp gateway: seeded fault-injection simulation', () => {
  it(
    ONE ? `seed ${ONE}` : `${COUNT} seeds from ${FROM}: money, owners, liveness, hygiene`,
    async () => {
      const seeds = ONE ? [Number(ONE)] : Array.from({ length: COUNT }, (_, i) => FROM + i)
      const failures: Violation[] = []
      const realNow = globalThis.performance.now.bind(globalThis.performance)
      const started = realNow()
      let excused = 0
      const totals: Record<string, number> = {}
      for (const seed of seeds) {
        currentSeed = seed
        vi.useFakeTimers()
        const r = await runSeed(seed, !!ONE)
        vi.useRealTimers()
        excused += r.unknownExcused
        for (const [k, v] of Object.entries(r.stats)) totals[k] = (totals[k] ?? 0) + v
        if (NOTES) for (const line of r.trace.filter((l) => /RESIDUAL|excused/.test(l))) process.stderr.write(`seed ${seed} ${line}\n`)
        if (r.violations.length || ONE) {
          failures.push(...r.violations)
          const out = ONE ? r.trace : r.trace.slice(-150)
          process.stderr.write(`\n---- seed ${seed}: ${r.violations.map((v) => `${v.invariant} ${v.message}`).join(' | ') || 'ok'}\n${out.join('\n')}\n`)
        }
      }
      if (seeds.length > 1 || ONE) {
        process.stderr.write(
          `\nfuzz: ${seeds.length} seeds in ${Math.round(realNow() - started)} ms — ${failures.length} violation(s) in ${new Set(failures.map((f) => f.seed)).size} seed(s); ${excused} "không rõ" excused; ${JSON.stringify(totals)}\n`,
        )
      }
      expect(unhandled).toEqual([])
      expect(failures.map((f) => `seed ${f.seed} ${f.invariant}: ${f.message}`)).toEqual([])
    },
    30 * 60_000,
  )
})
