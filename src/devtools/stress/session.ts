// One stress run's private world: its own simulated canvasapp (in memory, seeded, fast), its own dev provider
// (in-memory caches, never the app's bdp:dev:* records), and a trap in place of the real canvasapp provider (any call
// = a fatal guard trip). The app's own dev server and providers are put back on stop().
//
// No network is possible here: the dev provider talks to the simulated server through the in-app dev bridge.
import { getBlob as mediaGetBlob } from '../../lib/imageStore'
import { canvasappProvider, devProvider, DEV_PROVIDER_LABEL, registerProvider } from '../../providers'
import { createCanvasappProvider, memoryStorage } from '../../providers/canvasapp/adapter'
import { createCanvasappApi } from '../../providers/canvasapp/api'
import { decodeRemoteId } from '../../providers/canvasapp/mapping'
import { createDesktopTransport } from '../../providers/canvasapp/transport'
import { createDevBridge, createDevCanvasapp, devResult, devServer, memoryBlobStore, setDevServer, withDevWording, type DevCanvasapp, type DevBridge } from '../../providers/dev'
import { ProviderError, type VideoProvider } from '../../providers/types'
import type { Rng } from './rng'
import type { Violation } from './types'
import type { Take } from '../../core/types'

/** The session's simulated canvasapp: the dev server API + how many requests reached it. */
export type SessionServer = DevCanvasapp & { requestCount(): number }

export interface Session {
  server: SessionServer
  bridge: DevBridge
  coverage: Record<string, number>
  checkCompleted(takes: readonly Take[]): Promise<Violation[]>
  /** Pictures the session provider can upload (image id → blob). */
  media: Map<string, Blob>
  /** Fatal trips (the real provider was called). Drained by the runner. */
  trips: Violation[]
  /** Put the app's dev server and providers back. Idempotent. */
  stop(): void
}

/** Poll cadence of the session provider (the simulated site answers instantly). */
export const SESSION_POLL_MS = 1_000
export const SESSION_LIST_CACHE_MS = 600
/** Balance of the simulated account at the start: large, so credits never block a run by accident. */
export const SESSION_BALANCE = 1_000_000_000

/** A tiny, valid 1×1 PNG (what a 'good' picture uploads). */
const PNG_1PX = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)
export const goodImage = () => new Blob([PNG_1PX], { type: 'image/png' })

/** At least three gateway chunks, with a job-specific pattern: truncation / duplication / wrong-job bytes are detectable. */
export const stressVideo = (jobNumber: number) => new Blob([`WEBM:stress#${jobNumber}|`.repeat(16_384)], { type: 'video/webm' })

async function matchesVideo(blob: Blob | null, n: number): Promise<boolean> {
  if (!blob) return false
  const expected = new Uint8Array(await stressVideo(n).arrayBuffer())
  const actual = new Uint8Array(await blob.arrayBuffer())
  return actual.length === expected.length && actual.every((byte, i) => byte === expected[i])
}

let active: Session | null = null

/** Whether a stress session currently replaces the app's dev server / providers. */
export const sessionActive = () => active !== null

/**
 * Put the app's dev server and providers back now (idempotent). The sandbox calls it the moment another project is
 * opened during a run, so that project's queue never meets the session's private server or the trap.
 */
export const stopActiveSession = () => active?.stop()

export interface SessionOptions {
  rng: Rng
  /** 'app': the app's own dev server exists and must come back; 'headless': none (tests). */
  kind: 'app' | 'headless'
  checkResume?: boolean
}

export function startSession({ rng, kind, checkResume = false }: SessionOptions): Session {
  if (active) throw new Error('Đang có một phiên thử nghiệm khác.')
  const serverRng = rng.fork('server')
  const media = new Map<string, Blob>()
  const trips: Violation[] = []
  const coverage: Record<string, number> = {}
  const hit = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1 }
  const numbers = new Map<string, number>()
  // The app's own dev server (created if needed — it only reads its saved account) comes back on stop.
  const originalServer = kind === 'app' ? devServer() : null

  const base = createDevCanvasapp({
    storage: memoryStorage(),
    blobs: memoryBlobStore(),
    random: () => serverRng.next(),
    // Cheap "video": nothing is drawn (no canvas / MediaRecorder work during a stress run).
    render: async (input) => stressVideo(input.jobNumber),
  })
  let requests = 0
  const origRequest = base.request.bind(base)
  const server = base as SessionServer
  server.request = (req) => {
    requests++
    if (req.method === 'POST' && req.path === '/api/video-jobs') {
      hit('jobs.post')
      if (!server.isAuthenticated()) {
        hit('jobs.postLoggedOut')
        trips.push({ invariant: 'RL3', severity: 'error', kind: 'app', message: 'POST tạo job vẫn được gửi sau khi đăng xuất.' })
      }
    }
    return origRequest(req)
  }
  server.requestCount = () => requests
  server.setConfig({ latencyMs: 0, speed: 'fast', dedupe: true, failRate: 0 })
  server.login()
  server.setBalance(SESSION_BALANCE)
  setDevServer(server)
  const offNumbers = server.subscribe(() => {
    for (const j of server.snapshot().jobs) numbers.set(j.job_id, j.number)
  })
  const openStream = server.openStream.bind(server)
  const needsResume = new Set<string>()
  server.openStream = async (req) => {
    requests++
    hit('download.open')
    if (checkResume && needsResume.delete(req.path) && !(req.range && req.range.from > 0)) {
      trips.push({ invariant: 'DL2', severity: 'error', kind: 'app', message: 'Máy chủ cho tải tiếp nhưng lượt sau tải lại từ đầu.', detail: { path: req.path } })
    }
    const fault = server.faults().find((r) => r.endpoint === 'job-stream' && !['slow', 'trickle'].includes(r.fault.kind))?.fault
    const res = await openStream(req)
    if (res.ok && (res.status === 200 || res.status === 206)) {
      if (req.range?.from && res.status === 206) hit('download.resumed')
      if (fault) hit(`download.${fault.kind}`)
      if (server.config().rangeSupport && (fault?.kind === 'cut' || fault?.kind === 'stall')) needsResume.add(req.path)
    }
    return res
  }

  const bridge = createDevBridge(() => server, { keepLoginStorage: memoryStorage(), jobListCacheMs: SESSION_LIST_CACHE_MS })

  const adapter = createCanvasappProvider({
    id: 'dev',
    label: DEV_PROVIDER_LABEL,
    api: withDevWording(createCanvasappApi(createDesktopTransport(() => bridge))),
    getBlob: async (id) => media.get(id) ?? (await mediaGetBlob(id)),
    storage: memoryStorage(),
    minPollMs: SESSION_POLL_MS,
    pollIntervalMs: SESSION_POLL_MS,
    listCacheMs: SESSION_LIST_CACHE_MS,
    gatewayListCacheMs: SESSION_LIST_CACHE_MS,
  })
  const fetchResult = adapter.fetchResult.bind(adapter)
  adapter.fetchResult = async (remoteId, opts) => {
    const result = await fetchResult(remoteId, opts)
    const jobId = decodeRemoteId(remoteId)?.jobId
    const number = jobId ? numbers.get(jobId) : undefined
    if (number !== undefined && !await matchesVideo(result.video, number)) {
      trips.push({ invariant: 'DL1', severity: 'error', kind: 'app', message: 'Video tải xong khác toàn bộ byte nguồn giả lập.', detail: { jobId } })
    }
    hit('download.verified')
    return result
  }
  const sessionDev = withDevWording(adapter, { poll: devResult, available: devResult })
  registerProvider(sessionDev)

  const trip = (what: string): never => {
    trips.push({ invariant: 'S3', severity: 'error', kind: 'app', message: `Nhà cung cấp thật (canvasapp.io.vn) bị gọi: ${what}. Đã chặn.` })
    throw new ProviderError('blocked', 'ĐÃ CHẶN gọi nhà cung cấp thật trong lúc thử nghiệm giới hạn.')
  }
  const trap: VideoProvider = {
    id: 'canvasapp',
    label: 'canvasapp.io.vn (đã chặn khi thử nghiệm)',
    available: async () => trip('available()'),
    // Capabilities are only read (run rules): answer like the session's dev provider, never the real site.
    capabilities: (model) => sessionDev.capabilities(model),
    submit: async () => trip('submit()'),
    recover: async () => trip('recover()'),
    poll: async () => trip('poll()'),
    fetchResult: async () => trip('fetchResult()'),
    cancel: () => void trips.push({ invariant: 'S3', severity: 'error', kind: 'app', message: 'Nhà cung cấp thật bị gọi: cancel(). Đã chặn.' }),
  }
  registerProvider(trap)

  let stopped = false
  const session: Session = {
    server,
    bridge,
    coverage,
    checkCompleted: async (takes) => {
      const out: Violation[] = []
      for (const t of takes) {
        if (t.status !== 'completed' || t.provider !== 'dev' || !t.remoteId) continue
        const jobId = decodeRemoteId(t.remoteId)?.jobId
        const n = jobId ? numbers.get(jobId) : undefined
        if (n === undefined) continue
        const saved = t.videoId ? await mediaGetBlob(t.videoId) : null
        if (!await matchesVideo(saved, n)) out.push({ invariant: 'DL1', severity: 'error', kind: 'app', message: 'Take hoàn tất nhưng byte đã lưu thiếu hoặc hỏng.', detail: { takeId: t.id, jobId } })
        else hit('download.savedVerified')
      }
      return out
    },
    media,
    trips,
    stop: () => {
      if (stopped) return
      stopped = true
      bridge.reset()
      offNumbers()
      // The app's own providers (the same singletons getProvider() would build) and dev server.
      registerProvider(devProvider())
      registerProvider(canvasappProvider())
      setDevServer(originalServer)
      if (active === session) active = null
    },
  }
  active = session
  return session
}
