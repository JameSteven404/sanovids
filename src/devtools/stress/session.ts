// One stress run's private world: its own simulated canvasapp (in memory, seeded, fast), its own dev provider
// (in-memory caches, never the app's bdp:dev:* records), and a trap in place of the real canvasapp provider (any call
// = a fatal guard trip). The app's own dev server and providers are put back on stop().
//
// No network is possible here: the dev provider talks to the simulated server through the in-app dev bridge.
import { getBlob as mediaGetBlob } from '../../lib/imageStore'
import { canvasappProvider, devApi, devProvider, DEV_PROVIDER_LABEL, registerProvider } from '../../providers'
import { createCanvasappProvider, memoryStorage } from '../../providers/canvasapp/adapter'
import { createDevCanvasapp, devResult, devServer, memoryBlobStore, setDevServer, withDevWording, type DevCanvasapp } from '../../providers/dev'
import { ProviderError, type VideoProvider } from '../../providers/types'
import type { Rng } from './rng'
import type { Violation } from './types'

/** The session's simulated canvasapp: the dev server API + how many requests reached it. */
export type SessionServer = DevCanvasapp & { requestCount(): number }

export interface Session {
  server: SessionServer
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

let active: Session | null = null

/** Whether a stress session currently replaces the app's dev server / providers. */
export const sessionActive = () => active !== null

export interface SessionOptions {
  rng: Rng
  /** 'app': the app's own dev server exists and must come back; 'headless': none (tests). */
  kind: 'app' | 'headless'
}

export function startSession({ rng, kind }: SessionOptions): Session {
  if (active) throw new Error('Đang có một phiên thử nghiệm khác.')
  const serverRng = rng.fork('server')
  const media = new Map<string, Blob>()
  const trips: Violation[] = []
  // The app's own dev server (created if needed — it only reads its saved account) comes back on stop.
  const originalServer = kind === 'app' ? devServer() : null

  const base = createDevCanvasapp({
    storage: memoryStorage(),
    blobs: memoryBlobStore(),
    random: () => serverRng.next(),
    // Cheap "video": nothing is drawn (no canvas / MediaRecorder work during a stress run).
    render: async (input) => new Blob([`WEBM:stress#${input.jobNumber}`], { type: 'video/webm' }),
  })
  let requests = 0
  const origRequest = base.request.bind(base)
  const server = base as SessionServer
  server.request = (req) => {
    requests++
    return origRequest(req)
  }
  server.requestCount = () => requests
  server.setConfig({ latencyMs: 0, speed: 'fast', dedupe: true, failRate: 0 })
  server.login()
  server.setBalance(SESSION_BALANCE)
  setDevServer(server)

  const adapter = createCanvasappProvider({
    id: 'dev',
    label: DEV_PROVIDER_LABEL,
    api: devApi(),
    getBlob: async (id) => media.get(id) ?? (await mediaGetBlob(id)),
    storage: memoryStorage(),
    minPollMs: SESSION_POLL_MS,
    pollIntervalMs: SESSION_POLL_MS,
    listCacheMs: SESSION_LIST_CACHE_MS,
  })
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
    media,
    trips,
    stop: () => {
      if (stopped) return
      stopped = true
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
