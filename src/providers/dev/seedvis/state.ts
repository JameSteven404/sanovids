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
export const SEEDVIS_DEV_ACCOUNTS = Object.keys(SEEDVIS_DEV_KEYS) as SeedvisDevAccount[]
/** The fake account a sample key opens, or null for anything else (a real key is never accepted). */
export const seedvisDevAccountOf = (key: unknown): SeedvisDevAccount | null => SEEDVIS_DEV_ACCOUNTS.find(a => SEEDVIS_DEV_KEYS[a] === key) ?? null
export const SEEDVIS_DEV_SAMPLE_KEYS_ONLY = 'Chỉ nhận khoá mẫu của seedvis giả lập; không dán khoá thật.'

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
  /** Normalised Idempotency-Key that created the job (lowercase UUID, or `body:<sha256>` without a key). Outlives the key memory, so a snapshot can count jobs per key. */
  idempotencyKey: string
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
/** Usage of the finished jobs that compaction dropped, so /account/usage totals survive the job cap. */
export interface SeedvisDevTrimmed { generations: number; creditsUsed: number; completed: number; failed: number }
export interface SeedvisDevState {
  version: 1
  /** New on every write: a store re-validates a saved value only when another writer changed it. */
  rev: string
  epoch: string
  config: SeedvisDevConfig
  account: SeedvisDevAccount
  keyState: SeedvisDevKeyState
  savedAt: number
  /** The saved sample key was kept with "Lưu mà chưa kiểm tra" (no check reached the simulation): verifiedAt null. */
  keyUnchecked?: true
  balances: Record<SeedvisDevAccount, number>
  /** Creation order, oldest first. */
  jobs: SeedvisDevJob[]
  memory: { account: SeedvisDevAccount; key: string; hash: string; jobId: string; expiresAt: number }[]
  slotsFullUntil: number
  /** When the queue was last brought up to date: a queued job never starts before it. */
  clock: number
  trimmed: Record<SeedvisDevAccount, SeedvisDevTrimmed>
}

/** Finished jobs kept, like the canvasapp sim's MAX_JOBS. Queued / processing jobs and jobs an unexpired key points at are never dropped. */
export const SEEDVIS_DEV_MAX_JOBS = 200
export const SEEDVIS_JOB_KEY_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|body:[a-f0-9]{64})$/

const noTrim = (): SeedvisDevTrimmed => ({ generations: 0, creditsUsed: 0, completed: 0, failed: 0 })

export function initialSeedvisState(now = Date.now()): SeedvisDevState {
  return { version: 1, rev: crypto.randomUUID(), epoch: crypto.randomUUID(), config: { ...SEEDVIS_DEV_DEFAULTS }, account: 'A001', keyState: 'verified', savedAt: now,
    balances: { A001: 1000, B002: 1000 }, jobs: [], memory: [], slotsFullUntil: 0, clock: 0, trimmed: { A001: noTrim(), B002: noTrim() } }
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
const time = (n: unknown) => n === null || finite(n)
const account = (n: unknown): n is SeedvisDevAccount => n === 'A001' || n === 'B002'
const shortText = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 100
const trimmedOk = (t: unknown) => isObj(t) && ['generations', 'creditsUsed', 'completed', 'failed'].every(k => finite(t[k]))

/** Corrupt persisted state fails closed; do not silently reset a paid simulation's ledger. Runs when a value is loaded, not per request. */
export function readSeedvisState(raw: unknown): SeedvisDevState {
  if (raw === undefined) return initialSeedvisState()
  if (!isObj(raw) || raw.version !== 1 || !shortText(raw.rev) || !shortText(raw.epoch) || !account(raw.account)
    || !['verified', 'none', 'revoked', 'forbidden', 'unreadable'].includes(String(raw.keyState))
    || !finite(raw.savedAt) || (raw.keyUnchecked !== undefined && raw.keyUnchecked !== true) || !finite(raw.slotsFullUntil) || !finite(raw.clock) || !isObj(raw.balances) || !finite(raw.balances.A001) || !finite(raw.balances.B002)
    || !isObj(raw.trimmed) || !trimmedOk(raw.trimmed.A001) || !trimmedOk(raw.trimmed.B002)
    || !Array.isArray(raw.jobs) || !Array.isArray(raw.memory)) throw new Error('Invalid seedvis dev state')
  const owner = new Map<string, string>()
  for (const j of raw.jobs) {
    if (!isObj(j) || typeof j.id !== 'string' || !SEEDVIS_ID_RE.test(j.id) || owner.has(j.id) || !account(j.account) || !isObj(j.body)
      || typeof j.idempotencyKey !== 'string' || !SEEDVIS_JOB_KEY_RE.test(j.idempotencyKey)
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
    owner.set(j.id, `${j.account} ${j.idempotencyKey}`)
  }
  for (const m of raw.memory) {
    if (!isObj(m) || !account(m.account) || typeof m.key !== 'string' || !SEEDVIS_JOB_KEY_RE.test(m.key) || typeof m.hash !== 'string' || !/^[a-f0-9]{64}$/.test(m.hash)
      || typeof m.jobId !== 'string' || owner.get(m.jobId) !== `${m.account} ${m.key}` || !finite(m.expiresAt)) throw new Error('Invalid seedvis dev memory')
  }
  return { ...(structuredClone(raw) as unknown as SeedvisDevState), config: seedvisConfig(raw.config) }
}

/** An atomic update prevents two tabs from billing the same idempotency key twice. */
export interface SeedvisStateStore {
  /** Runs fn on the saved state without writing (fn must not change it); returns a copy of fn's result. */
  peek<T>(fn: (state: Readonly<SeedvisDevState>) => T): Promise<T>
  /** Atomic read-modify-write: a throw leaves the saved state untouched. Returns a copy of fn's result. */
  change<T>(fn: (state: SeedvisDevState) => T): Promise<T>
  reset(): Promise<void>
}

/** Validated once, when created; later writes come from the simulator itself, so no request re-validates every job. */
export function memorySeedvisStore(initial?: SeedvisDevState): SeedvisStateStore {
  let saved = readSeedvisState(initial)
  return {
    peek: async fn => structuredClone(fn(saved)),
    async change(fn) {
      const draft = structuredClone(saved)
      const result = fn(draft)
      draft.rev = crypto.randomUUID()
      saved = draft
      return structuredClone(result)
    },
    async reset() { saved = initialSeedvisState() },
  }
}

/** Lazy: importing the simulator does not open IndexedDB or wire it into the app. */
export function indexedSeedvisStore(): SeedvisStateStore {
  const store = createStore(SEEDVIS_DEV_DB, 'simulation')
  let checkedRev: string | null = null
  // IndexedDB hands back a fresh copy on every read: validate it only when another writer (a tab, a reset) changed it.
  const accept = (raw: unknown): SeedvisDevState => {
    if (checkedRev !== null && isObj(raw) && raw.rev === checkedRev) return raw as unknown as SeedvisDevState
    const state = readSeedvisState(raw)
    if (raw !== undefined) checkedRev = state.rev
    return state
  }
  // The first read saves the initial state, so its epoch (the key session) is the one every later change sees.
  async function load(): Promise<SeedvisDevState> {
    const raw = await get(SEEDVIS_DEV_STATE_KEY, store)
    if (raw !== undefined) return accept(raw)
    await update(SEEDVIS_DEV_STATE_KEY, saved => saved ?? initialSeedvisState(), store)
    return accept(await get(SEEDVIS_DEV_STATE_KEY, store))
  }
  return {
    peek: async fn => fn(await load()),
    async change(fn) {
      let result!: ReturnType<typeof fn>
      let rev = ''
      await update<SeedvisDevState>(SEEDVIS_DEV_STATE_KEY, raw => {
        const state = accept(raw)
        result = fn(state)
        state.rev = rev = crypto.randomUUID()
        return state
      }, store)
      checkedRev = rev
      return result
    },
    async reset() { checkedRev = null; await update(SEEDVIS_DEV_STATE_KEY, () => initialSeedvisState(), store) },
  }
}
