// Development mode ("Phát triển (giả lập)") — the app's simulated canvasapp.io.vn. No network, ever: everything here
// runs in the page. See server.ts (the simulated site), bridge.ts (the simulated desktop gateway), prompts.ts (the
// simulated login / SePay windows), log.ts (request log), validate.ts / routes.ts (strict rules shared with tests).
// The provider that runs takes on it (the real canvasapp adapter as 'dev') is built in providers/index.ts.
//
// ---- API for the UI ----
//   devServer(): DevCanvasapp            the app's dev server (created on first use; state in localStorage
//                                        'bdp:dev:state' / 'bdp:dev:config', blobs in IndexedDB 'sanovids-dev').
//                                        Settings, faults, balance, login, force a job…: see DevCanvasapp in server.ts.
//                                        Every tab has its own copy on the SAME saved account: it re-reads it before
//                                        each request / change, and on the window 'storage' event (another tab saved).
//   devBridge(): CanvasappBridge         the simulated window.bdpDesktop.canvasapp (always available, web too).
//   devVideoRenderer                     the in-page renderer the dev server draws finished videos with (WebM).
//   useDevServer                         zustand store { snapshot: DevServerSnapshot | null } — refreshed on every
//                                        server change; startDevSnapshotTicker() also refreshes it every second while
//                                        jobs run (progress moves with the clock). Select fields of `snapshot`.
//   startDevSnapshotTicker(): () => void ref-counted; call from an effect of the dev panel, returns stop.
//   resetDevServer(): Promise<void>      wipe the simulated account (keeps the settings). Prefer providers/index
//                                        resetDevMode(), which also clears SanoVids' own dev-mode caches.
//   useDevLog / clearDevLog              request log (log.ts).   useDevPrompts / answerDevLogin / answerDevCheckout
//                                        the login + SePay sheets (prompts.ts).
//   devWording / withDevWording          development-mode words for the real gateway's messages (wording.ts).
// ---- For tests / embedding ----
//   setDevServer(server | null)          replace the app's dev server (null = the default one again, on next use).
import { clear, createStore, del, get, set } from 'idb-keyval'
import { create } from 'zustand'
import { renderMockBlobs } from '../../lib/mockProvider'
import type { KeyValueStorage } from '../canvasapp/adapter'
import type { CanvasappBridge } from '../canvasapp/transport'
import { createDevBridge } from './bridge'
import { closeDevPrompts } from './prompts'
import {
  createDevCanvasapp,
  DEV_CONFIG_KEY,
  DEV_STATE_KEY,
  memoryBlobStore,
  type DevBlobStore,
  type DevCanvasapp,
  type DevRenderer,
  type DevServerSnapshot,
} from './server'

export * from './server'
export * from './log'
export * from './prompts'
export { createDevBridge, DEV_CHECKOUT_TIMEOUT_MS, DEV_JOB_LIST_CACHE_MS, type DevBridgeOptions } from './bridge'
export { DEV_ENDPOINT_LABEL, DEV_ENDPOINTS, matchDevRoute, type DevEndpoint } from './routes'
export { canvasProblem, jobBodyProblem, jobKeyProblem, profileProblem, type DevProblem } from './validate'
export { devError, devResult, devWording, withDevWording } from './wording'

/** Blobs of the dev server in their own IndexedDB database (wiped by reset); in memory where IndexedDB is missing. */
function idbBlobStore(): DevBlobStore {
  if (typeof indexedDB === 'undefined') return memoryBlobStore()
  let store: ReturnType<typeof createStore> | null = null
  const db = () => (store ??= createStore('sanovids-dev', 'blobs'))
  return {
    get: async (k) => ((await get(k, db())) as Blob | undefined) ?? null,
    set: (k, b) => set(k, b, db()),
    del: (k) => del(k, db()),
    clear: () => clear(db()),
  }
}

/**
 * localStorage for the dev server's account. Unlike the adapter's browserStorage(), a failed write THROWS: the server
 * reports it (snapshot().persistProblem) instead of silently going back to the old account on the next read.
 */
const devAccountStorage: KeyValueStorage = {
  get: (k) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k, v) => localStorage.setItem(k, v),
  remove: (k) => localStorage.removeItem(k),
}

/** The finished video, drawn in the page by the demo renderer: the job's pictures labelled @image_N, a DEV tag. */
export const devVideoRenderer: DevRenderer = async (input) => {
  if (typeof document === 'undefined') return null
  const out = await renderMockBlobs({
    takeId: input.jobId,
    code: 'DEV',
    takeNumber: input.jobNumber,
    title: input.title,
    prompt: input.prompt,
    ratio: input.ratio,
    durationLabel: input.durationLabel,
    color: input.color,
    imageIds: input.images.map((i) => i.uploadId),
    imageBlobs: input.images.map((i) => i.blob),
    labels: input.images.map((i) => i.label),
    maxImages: 8,
    badge: '● DEV · canvasapp giả lập',
    recordVideo: true,
  })
  return out.video
}

export interface DevServerStore {
  /** null until the dev server exists (devServer() / startDevSnapshotTicker() create it). */
  snapshot: DevServerSnapshot | null
}

export const useDevServer = create<DevServerStore>()(() => ({ snapshot: null }))

let server: DevCanvasapp | null = null
let unwire: (() => void) | null = null

/** The server's snapshot for the UI store; a failure (should not happen) leaves the last one rather than throwing. */
function publish(s: DevCanvasapp) {
  try {
    useDevServer.setState({ snapshot: s.snapshot() })
  } catch (e) {
    console.error('[dev] snapshot failed', e)
  }
}

function wire(s: DevCanvasapp) {
  unwire?.()
  unwire = s.subscribe(() => {
    if (server === s) publish(s)
  })
  publish(s)
}

let storageListening = false

/** Another tab saved the dev account / settings: this tab's copy of the server takes it (and the UI follows). */
function listenToOtherTabs() {
  if (storageListening || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  storageListening = true
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== DEV_STATE_KEY && e.key !== DEV_CONFIG_KEY) return
    try {
      server?.sync()
    } catch (err) {
      console.error('[dev] sync failed', err)
    }
  })
}

export function devServer(): DevCanvasapp {
  if (!server) {
    server = createDevCanvasapp({ storage: devAccountStorage, blobs: idbBlobStore(), render: devVideoRenderer })
    wire(server)
    listenToOtherTabs()
  }
  return server
}

export function setDevServer(s: DevCanvasapp | null): void {
  unwire?.()
  unwire = null
  server = s
  if (s) wire(s)
  else useDevServer.setState({ snapshot: null })
}

const bridge = createDevBridge(() => devServer())

export function devBridge(): CanvasappBridge {
  return bridge
}

export async function resetDevServer(): Promise<void> {
  closeDevPrompts()
  await devServer().reset({ keepConfig: true })
}

let tickerRefs = 0
let ticker: ReturnType<typeof setInterval> | null = null

export function startDevSnapshotTicker(intervalMs = 1000): () => void {
  const s = devServer()
  tickerRefs++
  if (!ticker) {
    ticker = setInterval(() => {
      const cur = server ?? s
      const snap = useDevServer.getState().snapshot
      if (snap && !snap.jobs.some((j) => j.status === 'queued' || j.status === 'processing') && !snap.topups.some((o) => o.status === 'pending')) return
      publish(cur)
    }, intervalMs)
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    tickerRefs--
    if (tickerRefs === 0 && ticker) {
      clearInterval(ticker)
      ticker = null
    }
  }
}
