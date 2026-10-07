import { createStore, get, update } from 'idb-keyval'
import type { SeedvisGenerationBody, SeedvisRemoteStatus } from '../../seedvis/contract'
import type { SeedvisImageField } from '../../../core/seedvisRoutes'
import { isObj } from '../validate'
import { SEEDVIS_ID_RE } from './routes'
import { seedvisRequestProblem, SEEDVIS_UUID_RE } from './validate'

export const SEEDVIS_DEV_DB = 'sanovids-dev-seedvis'
export const SEEDVIS_DEV_STATE_KEY = 'state-v1'
// Only these public fixture strings can enter the fake key store. Never accept a real API key.
export const SEEDVIS_DEV_KEYS = { A001: 'dev-seedvis-account-A001', B002: 'dev-seedvis-account-B002' } as const
export type SeedvisDevAccount = keyof typeof SEEDVIS_DEV_KEYS
export type SeedvisDevKeyState = 'verified' | 'none' | 'revoked' | 'forbidden' | 'unreadable'

export interface SeedvisDevConfig {
  keyMemoryMs: number
  uploadBytesPerSecond: number
  queuedMs: number
  processingMs: number
  retentionMs: number
  signedUrlMs: number
  concurrency: number
  queueLimit: number
  price: number
  online: boolean
  poll202: boolean
  modesShape: 'strings' | 'objects'
  foreignHost: boolean
  outputContentType: 'video/mp4' | 'application/octet-stream'
}

export const SEEDVIS_DEV_SPEEDS = {
  fast: { queuedMs: 1_000, processingMs: 6_000 },
  realistic: { queuedMs: 15_000, processingMs: 75_000 },
} as const

export const SEEDVIS_DEV_DEFAULTS: SeedvisDevConfig = {
  keyMemoryMs: 120_000, uploadBytesPerSecond: 20 * 1024 * 1024,
  ...SEEDVIS_DEV_SPEEDS.fast, retentionMs: 7 * 86_400_000, signedUrlMs: 60_000,
  concurrency: 2, queueLimit: 10, price: 10, online: true, poll202: false,
  modesShape: 'strings', foreignHost: false, outputContentType: 'application/octet-stream',
}

export function seedvisConfig(raw: unknown): SeedvisDevConfig {
  const out = { ...SEEDVIS_DEV_DEFAULTS }
  if (!isObj(raw)) return out
  for (const key of ['keyMemoryMs', 'uploadBytesPerSecond', 'queuedMs', 'processingMs', 'retentionMs', 'signedUrlMs', 'concurrency', 'queueLimit', 'price'] as const) {
    const v = raw[key]
    const min = ['uploadBytesPerSecond', 'processingMs', 'concurrency', 'signedUrlMs'].includes(key) ? 1 : 0
    const max = key === 'concurrency' ? 10 : key === 'queueLimit' ? 1000 : Number.MAX_SAFE_INTEGER
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max) out[key] = v
  }
  for (const key of ['online', 'poll202', 'foreignHost'] as const) if (typeof raw[key] === 'boolean') out[key] = raw[key]
  if (raw.modesShape === 'objects' || raw.modesShape === 'strings') out.modesShape = raw.modesShape
  if (raw.outputContentType === 'video/mp4' || raw.outputContentType === 'application/octet-stream') out.outputContentType = raw.outputContentType
  return out
}

export interface SeedvisDevJob {
  id: string
  account: SeedvisDevAccount
  body: SeedvisGenerationBody
  references: { field: SeedvisImageField; index: number }[]
  createdAt: number
  readyAt: number
  startAt: number | null
  endAt: number | null
  processingMs: number
  status: SeedvisRemoteStatus
  cost: number
  refunded: boolean
  code: string | null
  failCode: string | null
  held: boolean
  notStartedAt: number | null
  missingPolls: number
  emptyOutputs: boolean
  shortEcho: boolean
  links: { token: string; expiresAt: number }[]
  video: Uint8Array
}
export interface SeedvisDevState {
  version: 1
  epoch: string
  config: SeedvisDevConfig
  account: SeedvisDevAccount
  keyState: SeedvisDevKeyState
  savedAt: number
  balances: Record<SeedvisDevAccount, number>
  jobs: SeedvisDevJob[]
  memory: { account: SeedvisDevAccount; key: string; hash: string; jobId: string; expiresAt: number }[]
  slotsFullUntil: number
}

export function initialSeedvisState(now = Date.now()): SeedvisDevState {
  return { version: 1, epoch: crypto.randomUUID(), config: { ...SEEDVIS_DEV_DEFAULTS }, account: 'A001', keyState: 'verified', savedAt: now,
    balances: { A001: 1000, B002: 1000 }, jobs: [], memory: [], slotsFullUntil: 0 }
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
const time = (n: unknown) => n === null || finite(n)
const account = (n: unknown): n is SeedvisDevAccount => n === 'A001' || n === 'B002'

/** Corrupt persisted state fails closed; do not silently reset a paid simulation's ledger. */
export function readSeedvisState(raw: unknown): SeedvisDevState {
  if (raw === undefined) return initialSeedvisState()
  if (!isObj(raw) || raw.version !== 1 || typeof raw.epoch !== 'string' || !account(raw.account)
    || !['verified', 'none', 'revoked', 'forbidden', 'unreadable'].includes(String(raw.keyState))
    || !finite(raw.savedAt) || !finite(raw.slotsFullUntil) || !isObj(raw.balances) || !finite(raw.balances.A001) || !finite(raw.balances.B002)
    || !Array.isArray(raw.jobs) || !Array.isArray(raw.memory)) throw new Error('Invalid seedvis dev state')
  const ids = new Set<string>()
  for (const j of raw.jobs) {
    if (!isObj(j) || typeof j.id !== 'string' || !SEEDVIS_ID_RE.test(j.id) || ids.has(j.id) || !account(j.account) || !isObj(j.body)
      || !['queued', 'processing', 'completed', 'failed'].includes(String(j.status))
      || ![j.createdAt, j.readyAt, j.processingMs, j.cost, j.missingPolls].every(finite) || ![j.startAt, j.endAt, j.notStartedAt].every(time)
      || !['refunded', 'held', 'emptyOutputs', 'shortEcho'].every(k => typeof j[k] === 'boolean')
      || ![j.code, j.failCode].every(v => v === null || (typeof v === 'string' && v.length <= 100))
      || !Array.isArray(j.references) || j.references.some(r => !isObj(r) || !['image', 'lastFrame', 'reference_images', 'referenceImages'].includes(String(r.field)) || !Number.isInteger(r.index) || (r.index as number) < 0)
      || !Array.isArray(j.links) || j.links.length > 64 || j.links.some(l => !isObj(l) || typeof l.token !== 'string' || !SEEDVIS_UUID_RE.test(l.token) || !finite(l.expiresAt))
      || !(j.video instanceof Uint8Array) || j.video.length > 4096) throw new Error('Invalid seedvis dev job')
    const images = j.references.map(r => ({ ...r, mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }))
    if (seedvisRequestProblem({ route: 'generations.create', idempotencyKey: '00000000-0000-4000-8000-000000000000', body: j.body, images })
      || ((j.status === 'processing' || j.status === 'completed') && (j.startAt === null || j.endAt === null))
      || ((j.startAt === null) !== (j.endAt === null))) throw new Error('Invalid seedvis dev job body or phase')
    ids.add(j.id)
  }
  for (const m of raw.memory) {
    if (!isObj(m) || !account(m.account) || typeof m.key !== 'string' || m.key.length > 100 || typeof m.hash !== 'string' || !/^[a-f0-9]{64}$/.test(m.hash)
      || !(SEEDVIS_UUID_RE.test(m.key) || /^body:[a-f0-9]{64}$/.test(m.key))
      || typeof m.jobId !== 'string' || !ids.has(m.jobId) || !finite(m.expiresAt)
      || raw.jobs.find(j => j.id === m.jobId)?.account !== m.account) throw new Error('Invalid seedvis dev memory')
  }
  return { ...(structuredClone(raw) as unknown as SeedvisDevState), config: seedvisConfig(raw.config) }
}

/** An atomic update prevents two tabs from billing the same idempotency key twice. */
export interface SeedvisStateStore {
  read(): Promise<SeedvisDevState>
  change<T>(fn: (state: SeedvisDevState) => T): Promise<T>
  reset(): Promise<void>
}

export function memorySeedvisStore(initial: SeedvisDevState = initialSeedvisState()): SeedvisStateStore {
  let saved = structuredClone(initial)
  return {
    read: async () => readSeedvisState(saved),
    async change(fn) {
      const state = readSeedvisState(saved)
      const result = fn(state)
      saved = structuredClone(state)
      return structuredClone(result)
    },
    async reset() { saved = initialSeedvisState() },
  }
}

/** Lazy: importing the simulator does not open IndexedDB or wire it into the app. */
export function indexedSeedvisStore(): SeedvisStateStore {
  const store = createStore(SEEDVIS_DEV_DB, 'simulation')
  return {
    read: async () => readSeedvisState(await get(SEEDVIS_DEV_STATE_KEY, store)),
    async change(fn) {
      let result!: ReturnType<typeof fn>
      await update<SeedvisDevState>(SEEDVIS_DEV_STATE_KEY, raw => {
        const state = readSeedvisState(raw)
        result = fn(state)
        return state
      }, store)
      return structuredClone(result)
    },
    async reset() { await update(SEEDVIS_DEV_STATE_KEY, () => initialSeedvisState(), store) },
  }
}
