// The seedvis job ledger (plan §7.2): what proves, across restarts, which Idempotency-Keys were sent and which jobs
// they made — the seedvis copy of the canvasapp adapter's JOBS_KEY discipline. Keyed by the Idempotency-Key
// (uuidFromKey('sanovids:seedvis:' + take id)). Persisted as one JSON value under `bdp:seedvis:ledger` (development
// mode: `bdp:dev:seedvis:ledger`; stress: a memory storage).
//
//   jobs[key]     the job seedvis made for the key: {remoteId, at, keyTag, keyHint, final?, miss?, echo?}. A key with a
//                 job is NEVER posted again (M4). `final` once a poll / cancel saw the end; openJobs() = no `final`.
//   sent[key]     a POST of the key was (about to be) sent: {at (first POST start, never overwritten), firstLastByteAt
//                 (first attempt's last byte, never overwritten), uploadBps (first attempt), lastAt, attempts, model,
//                 mode, imageCount, bodyHash, bodyBytes, lastStatus, lastCode, lastRequestId, keyTag, keyHint}. Written
//                 AND read back before every POST (markSent: not stored → nothing posted, M3). Its mere existence
//                 means "may have reached seedvis": only the arrival gate (window.ts) lets the key go again.
//   prep[key]     media-store ids of the prepared bytes (and the originals pinned) while a same-key re-send is possible.
//   orphans[key]  a job whose take disappeared while it was being sent (§6.4 b): {remoteId, at, outcome}.
//   dropped       keys whose record was trimmed or found damaged: never posted again (no record ≠ never sent, M8).
//
// Trimming: a job 30 days after its end (60 days after it was made when no end was seen), a sent record 30 days after
// its last attempt, an orphan after 30 days, and count caps (oldest first). Every trimmed / damaged key goes to
// `dropped`. The ledger never holds the API key, a URL or free text from seedvis (codes and ids are sanitized).
//
// Writes merge with what storage holds now (another tab may have written): records only accumulate, removals are
// explicit — a merge can resurrect a removed `sent` record, never lose one (the safe direction).
import type { CancelOutcome } from './contractExt'
import { sanitizeCode, sanitizeRequestId, SEEDVIS_ID_RE } from './api'
import type { NotFoundStreak } from './window'

export const SEEDVIS_LEDGER_KEY = 'bdp:seedvis:ledger'
export const SEEDVIS_DEV_LEDGER_KEY = 'bdp:dev:seedvis:ledger'

const DAY = 86_400_000
export const LEDGER_FINAL_KEEP_MS = 30 * DAY
export const LEDGER_OPEN_KEEP_MS = 60 * DAY
export const LEDGER_SENT_KEEP_MS = 30 * DAY
export const LEDGER_ORPHAN_KEEP_MS = 30 * DAY
export const MAX_JOBS = 1000
export const MAX_SENT = 300
export const MAX_PREP = 100
export const MAX_ORPHANS = 200
export const MAX_DROPPED = 2000

export interface KeyValueStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export const memoryStorage = (): KeyValueStorage => {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) }
}

export type FinalStatus = 'completed' | 'failed' | 'cancelled'

export interface LedgerJob {
  remoteId: string
  at: number
  keyTag: string | null
  keyHint: string | null
  final?: { status: FinalStatus; code: string | null; at: number }
  miss?: NotFoundStreak
  /** Echo check result (§7.6): images seedvis says it received / images sent. */
  echo?: { received: number; sent: number }
  /** The create answer carried Idempotency-Replayed: true (an earlier POST of the key had reached seedvis). */
  replayed?: true
}

export interface LedgerSent {
  at: number
  firstLastByteAt: number | null
  uploadBps: number | null
  lastAt: number
  attempts: number
  model: string
  mode: string
  imageCount: number
  bodyHash: string
  bodyBytes: number
  lastStatus: number | null
  lastCode: string | null
  lastRequestId: string | null
  keyTag: string | null
  keyHint: string | null
  /** An explicit retry found a different body (the same-key POST would be refused 409): never re-sent. */
  bodyChangedAt?: number
}

export interface LedgerPrep {
  /** Media-store ids of converted / downscaled copies made for this key. */
  ids: string[]
  /** Original media-store ids sent unchanged: kept (pinned) while a re-send is possible. */
  pins: string[]
  at: number
}

export interface LedgerOrphan {
  remoteId: string
  at: number
  outcome: CancelOutcome | null
}

export interface LedgerData {
  v: 1
  jobs: Record<string, LedgerJob>
  sent: Record<string, LedgerSent>
  prep: Record<string, LedgerPrep>
  orphans: Record<string, LedgerOrphan>
  dropped: string[]
}

const emptyData = (): LedgerData => ({ v: 1, jobs: {}, sent: {}, prep: {}, orphans: {}, dropped: [] })

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const KEY_RE = /^[A-Za-z0-9_.:-]{1,100}$/
const isKey = (k: unknown): k is string => typeof k === 'string' && KEY_RE.test(k)
export const cleanTag = (v: unknown): string | null => (typeof v === 'string' && /^[0-9A-Za-z]{1,64}$/.test(v) ? v : null)
export const cleanHint = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,8}$/.test(v) ? v : null)
const cleanIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200) : [])
const FINALS: readonly FinalStatus[] = ['completed', 'failed', 'cancelled']
const OUTCOMES: readonly CancelOutcome[] = ['refunded', 'running', 'finished', 'unknown']

function parseStreak(v: unknown): NotFoundStreak | undefined {
  const s = obj(v)
  if (!s || !finite(s.misses) || !finite(s.count)) return undefined
  return { misses: s.misses, count: s.count, first: finite(s.first) ? s.first : null, last: finite(s.last) ? s.last : null }
}

function parseJob(v: unknown): LedgerJob | null {
  const r = obj(v)
  if (!r || typeof r.remoteId !== 'string' || !SEEDVIS_ID_RE.test(r.remoteId) || !finite(r.at)) return null
  const f = obj(r.final)
  const final =
    f && typeof f.status === 'string' && (FINALS as readonly string[]).includes(f.status) && finite(f.at)
      ? { status: f.status as FinalStatus, code: sanitizeCode(f.code), at: f.at }
      : undefined
  const e = obj(r.echo)
  const miss = parseStreak(r.miss)
  return {
    remoteId: r.remoteId,
    at: r.at,
    keyTag: cleanTag(r.keyTag),
    keyHint: cleanHint(r.keyHint),
    ...(final ? { final } : {}),
    ...(miss ? { miss } : {}),
    ...(e && finite(e.received) && finite(e.sent) ? { echo: { received: e.received, sent: e.sent } } : {}),
    ...(r.replayed === true ? { replayed: true as const } : {}),
  }
}

function parseSent(v: unknown): LedgerSent | null {
  const r = obj(v)
  if (!r || !finite(r.at) || !finite(r.lastAt) || !finite(r.attempts) || typeof r.bodyHash !== 'string' || !r.bodyHash || !finite(r.bodyBytes) || r.bodyBytes < 0) return null
  return {
    at: r.at,
    firstLastByteAt: finite(r.firstLastByteAt) ? r.firstLastByteAt : null,
    uploadBps: finite(r.uploadBps) && r.uploadBps > 0 ? r.uploadBps : null,
    lastAt: r.lastAt,
    attempts: r.attempts,
    model: typeof r.model === 'string' ? r.model.slice(0, 64) : '',
    mode: typeof r.mode === 'string' ? r.mode.slice(0, 32) : '',
    imageCount: finite(r.imageCount) ? r.imageCount : 0,
    bodyHash: r.bodyHash.slice(0, 200),
    bodyBytes: r.bodyBytes,
    lastStatus: finite(r.lastStatus) ? r.lastStatus : null,
    lastCode: sanitizeCode(r.lastCode),
    lastRequestId: sanitizeRequestId(r.lastRequestId),
    keyTag: cleanTag(r.keyTag),
    keyHint: cleanHint(r.keyHint),
    ...(finite(r.bodyChangedAt) ? { bodyChangedAt: r.bodyChangedAt } : {}),
  }
}

/**
 * A stored ledger, record by record. A damaged `jobs` / `sent` record never silently disappears: its key goes to
 * `dropped` (it may have been sent — never posted again).
 */
export function parseLedger(raw: string | null): { data: LedgerData; damaged: boolean } {
  if (!raw) return { data: emptyData(), damaged: false }
  let p: Record<string, unknown> | null
  try {
    p = obj(JSON.parse(raw))
  } catch {
    p = null
  }
  if (!p) return { data: emptyData(), damaged: true }
  const data = emptyData()
  const dropped = new Set(Array.isArray(p.dropped) ? p.dropped.filter(isKey) : [])
  let damaged = false
  for (const [k, v] of Object.entries(obj(p.jobs) ?? {})) {
    const job = isKey(k) ? parseJob(v) : null
    if (job) data.jobs[k] = job
    else if (isKey(k)) {
      dropped.add(k)
      damaged = true
    }
  }
  for (const [k, v] of Object.entries(obj(p.sent) ?? {})) {
    const s = isKey(k) ? parseSent(v) : null
    if (s) data.sent[k] = s
    else if (isKey(k)) {
      dropped.add(k)
      damaged = true
    }
  }
  for (const [k, v] of Object.entries(obj(p.prep) ?? {})) {
    const r = obj(v)
    if (isKey(k) && r && finite(r.at)) data.prep[k] = { ids: cleanIds(r.ids), pins: cleanIds(r.pins), at: r.at }
  }
  for (const [k, v] of Object.entries(obj(p.orphans) ?? {})) {
    const r = obj(v)
    if (isKey(k) && r && typeof r.remoteId === 'string' && SEEDVIS_ID_RE.test(r.remoteId) && finite(r.at)) {
      data.orphans[k] = { remoteId: r.remoteId, at: r.at, outcome: typeof r.outcome === 'string' && (OUTCOMES as readonly string[]).includes(r.outcome) ? (r.outcome as CancelOutcome) : null }
    }
  }
  data.dropped = [...dropped].slice(-MAX_DROPPED)
  return { data, damaged }
}

/** Union of two ledgers (the stored one and this tab's): records only accumulate. */
function merge(a: LedgerData, b: LedgerData): LedgerData {
  const jobs: Record<string, LedgerJob> = { ...a.jobs }
  for (const [k, j] of Object.entries(b.jobs)) {
    const x = jobs[k]
    // the first job recorded for a key wins; a final / miss / echo seen by either side is kept
    jobs[k] = x
      ? { ...x, ...(x.final ?? j.final ? { final: x.final ?? j.final } : {}), ...(x.miss || j.miss ? { miss: pickStreak(x.miss, j.miss) } : {}), ...(x.echo ?? j.echo ? { echo: x.echo ?? j.echo } : {}) }
      : j
  }
  const sent: Record<string, LedgerSent> = { ...a.sent }
  for (const [k, s] of Object.entries(b.sent)) {
    const x = sent[k]
    sent[k] = x ? mergeSent(x, s) : s
  }
  return {
    v: 1,
    jobs,
    sent,
    prep: { ...a.prep, ...b.prep },
    orphans: { ...a.orphans, ...b.orphans },
    dropped: [...new Set([...a.dropped, ...b.dropped])].slice(-MAX_DROPPED),
  }
}

function pickStreak(a?: NotFoundStreak, b?: NotFoundStreak): NotFoundStreak | undefined {
  if (!a) return b
  if (!b) return a
  return (b.last ?? 0) > (a.last ?? 0) || b.misses > a.misses ? b : a
}

/** Two copies of one sent record: the earliest first-attempt facts, the latest attempt facts. */
function mergeSent(x: LedgerSent, y: LedgerSent): LedgerSent {
  const first = x.at <= y.at ? x : y
  const last = x.lastAt >= y.lastAt ? x : y
  return {
    ...last,
    at: first.at,
    firstLastByteAt: first.firstLastByteAt ?? (first === x ? y.firstLastByteAt : x.firstLastByteAt),
    uploadBps: first.uploadBps ?? (first === x ? y.uploadBps : x.uploadBps),
    attempts: Math.max(x.attempts, y.attempts),
    ...(x.bodyChangedAt ?? y.bodyChangedAt ? { bodyChangedAt: x.bodyChangedAt ?? y.bodyChangedAt } : {}),
  }
}

/** The ledger trimmed at `now`, and the keys that were dropped from it. */
export function trimLedger(data: LedgerData, now: number): { data: LedgerData; gone: string[] } {
  const gone: string[] = []
  const keepNewest = <T>(rec: Record<string, T>, max: number, at: (t: T) => number, alive: (t: T) => boolean) => {
    let entries = Object.entries(rec).filter(([k, v]) => {
      if (alive(v)) return true
      gone.push(k)
      return false
    })
    if (entries.length > max) {
      entries = entries.sort((p, q) => at(q[1]) - at(p[1]))
      for (const [k] of entries.slice(max)) gone.push(k)
      entries = entries.slice(0, max)
    }
    return Object.fromEntries(entries) as Record<string, T>
  }
  const jobs = keepNewest(data.jobs, MAX_JOBS, (j) => j.final?.at ?? j.at, (j) => (j.final ? now - j.final.at < LEDGER_FINAL_KEEP_MS : now - j.at < LEDGER_OPEN_KEEP_MS))
  const sent = keepNewest(data.sent, MAX_SENT, (s) => s.lastAt, (s) => now - s.lastAt < LEDGER_SENT_KEEP_MS)
  const orphanGone: string[] = []
  const orphans = Object.fromEntries(
    Object.entries(data.orphans)
      .filter(([k, o]) => (now - o.at < LEDGER_ORPHAN_KEEP_MS ? true : (orphanGone.push(k), false)))
      .sort((p, q) => q[1].at - p[1].at)
      .slice(0, MAX_ORPHANS),
  )
  const prep = Object.fromEntries(Object.entries(data.prep).sort((p, q) => q[1].at - p[1].at).slice(0, MAX_PREP))
  // A key keeps being "sent" evidence while either record of it is kept; it is dropped once neither is.
  const droppedNow = [...new Set(gone)].filter((k) => !(k in jobs) && !(k in sent))
  const dropped = droppedNow.length ? [...data.dropped.filter((k) => !droppedNow.includes(k)), ...droppedNow].slice(-MAX_DROPPED) : data.dropped
  return { data: { v: 1, jobs, sent, prep, orphans, dropped }, gone: droppedNow }
}

export interface SeedvisLedger {
  /** The current data (read-only view; re-read from storage by reload()). */
  data(): Readonly<LedgerData>
  reload(): void
  job(key: string): LedgerJob | null
  sent(key: string): LedgerSent | null
  prep(key: string): LedgerPrep | null
  isDropped(key: string): boolean
  /** The key whose job has this remote id (null = not known on this computer). */
  keyOfRemote(remoteId: string): string | null
  /** Store the record of a POST about to be sent — read back: false = not stored, nothing may be posted (M3). */
  markSent(key: string, rec: LedgerSent): boolean
  /**
   * Update a sent record after / before an attempt. `at`, `firstLastByteAt` and `uploadBps` are never overwritten once
   * set. Read back like markSent (false = not stored).
   */
  updateSent(key: string, patch: Partial<Omit<LedgerSent, 'at'>>): boolean
  /** Forget the sent record of a key whose request provably never created a job (refused / never fully sent). */
  clearSent(key: string): void
  /** The key got its job (first one wins: never replaced). */
  recordJob(key: string, job: LedgerJob): boolean
  setFinal(key: string, final: NonNullable<LedgerJob['final']>): void
  setMiss(key: string, miss: NotFoundStreak | null): void
  setEcho(key: string, echo: { received: number; sent: number }): void
  setPrep(key: string, prep: LedgerPrep): void
  clearPrep(key: string): void
  recordOrphan(key: string, orphan: LedgerOrphan): void
  setOrphanOutcome(remoteId: string, outcome: CancelOutcome): void
  /** Jobs without a final status, all projects (the "N take seedvis đang chạy" count of §6.4 e). */
  openJobs(): { key: string; job: LedgerJob }[]
  /** Trim now; returns the keys dropped. */
  trim(): string[]
  /** The stored value could not be read when this ledger was loaded (its keys could not be kept). */
  damaged(): boolean
}

export function createSeedvisLedger(opts: { storage: KeyValueStorage; storageKey?: string; now?: () => number }): SeedvisLedger {
  const storage = opts.storage
  const storageKey = opts.storageKey ?? SEEDVIS_LEDGER_KEY
  const now = opts.now ?? Date.now
  let wasDamaged = false

  function readStored(): LedgerData {
    let raw: string | null = null
    try {
      raw = storage.get(storageKey)
    } catch {
      raw = null
    }
    const { data, damaged } = parseLedger(raw)
    if (damaged && raw) {
      wasDamaged = true
      // keep the unreadable value aside (diagnostics) before anything overwrites it
      try {
        if (storage.get(`${storageKey}:damaged`) === null) storage.set(`${storageKey}:damaged`, raw.slice(0, 200_000))
      } catch {
        /* ignore */
      }
    }
    return data
  }

  let data: LedgerData = trimLedger(readStored(), now()).data

  /** Merge with storage, apply `mutate`, trim, write, read back. Memory keeps the result even when storage failed. */
  function commit(mutate: (d: LedgerData) => LedgerData): boolean {
    const base = merge(readStored(), data)
    const next = trimLedger(mutate(base), now()).data
    data = next
    const text = JSON.stringify(next)
    try {
      storage.set(storageKey, text)
      return storage.get(storageKey) === text
    } catch {
      return false
    }
  }

  const without = <T>(rec: Record<string, T>, key: string): Record<string, T> => {
    if (!(key in rec)) return rec
    const { [key]: _gone, ...rest } = rec
    return rest
  }

  return {
    data: () => data,
    reload: () => {
      data = trimLedger(merge(readStored(), data), now()).data
    },
    job: (key) => data.jobs[key] ?? null,
    sent: (key) => data.sent[key] ?? null,
    prep: (key) => data.prep[key] ?? null,
    isDropped: (key) => data.dropped.includes(key),
    keyOfRemote: (remoteId) => Object.entries(data.jobs).find(([, j]) => j.remoteId === remoteId)?.[0] ?? null,

    markSent(key, rec) {
      if (!isKey(key)) return false
      const before = data
      const ok = commit((d) => ({ ...d, sent: { ...d.sent, [key]: { ...rec, lastCode: sanitizeCode(rec.lastCode), lastRequestId: sanitizeRequestId(rec.lastRequestId), keyTag: cleanTag(rec.keyTag), keyHint: cleanHint(rec.keyHint) } } }))
      if (!ok) data = before // as stored: nothing may be posted
      return ok
    },
    updateSent(key, patch) {
      if (!data.sent[key]) return false
      return commit((d) => {
        const cur = d.sent[key]
        if (!cur) return d
        const next: LedgerSent = {
          ...cur,
          ...patch,
          at: cur.at,
          firstLastByteAt: cur.firstLastByteAt ?? (finite(patch.firstLastByteAt) ? patch.firstLastByteAt : null),
          uploadBps: cur.uploadBps ?? (finite(patch.uploadBps) && patch.uploadBps > 0 ? patch.uploadBps : null),
          lastCode: patch.lastCode !== undefined ? sanitizeCode(patch.lastCode) : cur.lastCode,
          lastRequestId: patch.lastRequestId !== undefined ? sanitizeRequestId(patch.lastRequestId) : cur.lastRequestId,
          keyTag: cur.keyTag,
          keyHint: cur.keyHint,
        }
        return { ...d, sent: { ...d.sent, [key]: next } }
      })
    },
    clearSent(key) {
      if (!(key in data.sent)) return
      data = { ...data, sent: without(data.sent, key) }
      commit((d) => ({ ...d, sent: without(d.sent, key) }))
    },
    recordJob(key, job) {
      if (!isKey(key) || !SEEDVIS_ID_RE.test(job.remoteId)) return false
      return commit((d) => (d.jobs[key] ? d : { ...d, jobs: { ...d.jobs, [key]: { ...job, keyTag: cleanTag(job.keyTag), keyHint: cleanHint(job.keyHint) } } }))
    },
    setFinal(key, final) {
      if (!data.jobs[key] || data.jobs[key].final) return
      commit((d) => (d.jobs[key] && !d.jobs[key].final ? { ...d, jobs: { ...d.jobs, [key]: { ...d.jobs[key], final: { ...final, code: sanitizeCode(final.code) } } } } : d))
    },
    setMiss(key, miss) {
      if (!data.jobs[key]) return
      // a cleared streak must not come back from the merge: memory first, then commit
      if (!miss) data = { ...data, jobs: { ...data.jobs, [key]: (({ miss: _m, ...j }) => j)(data.jobs[key]) } }
      commit((d) => {
        const j = d.jobs[key]
        if (!j) return d
        if (!miss) {
          const { miss: _m, ...rest } = j
          return { ...d, jobs: { ...d.jobs, [key]: rest } }
        }
        return { ...d, jobs: { ...d.jobs, [key]: { ...j, miss } } }
      })
    },
    setEcho(key, echo) {
      if (!data.jobs[key]) return
      commit((d) => (d.jobs[key] ? { ...d, jobs: { ...d.jobs, [key]: { ...d.jobs[key], echo } } } : d))
    },
    setPrep(key, prep) {
      if (!isKey(key)) return
      commit((d) => ({ ...d, prep: { ...d.prep, [key]: { ids: cleanIds(prep.ids), pins: cleanIds(prep.pins), at: prep.at } } }))
    },
    clearPrep(key) {
      if (!(key in data.prep)) return
      data = { ...data, prep: without(data.prep, key) }
      commit((d) => ({ ...d, prep: without(d.prep, key) }))
    },
    recordOrphan(key, orphan) {
      if (!isKey(key) || !SEEDVIS_ID_RE.test(orphan.remoteId)) return
      commit((d) => ({ ...d, orphans: { ...d.orphans, [key]: orphan } }))
    },
    setOrphanOutcome(remoteId, outcome) {
      const key = Object.entries(data.orphans).find(([, o]) => o.remoteId === remoteId)?.[0]
      if (!key) return
      commit((d) => (d.orphans[key] ? { ...d, orphans: { ...d.orphans, [key]: { ...d.orphans[key], outcome } } } : d))
    },
    openJobs: () =>
      Object.entries(data.jobs)
        .filter(([, j]) => !j.final)
        .map(([key, job]) => ({ key, job })),
    trim() {
      const { data: next, gone } = trimLedger(merge(readStored(), data), now())
      data = next
      try {
        storage.set(storageKey, JSON.stringify(next))
      } catch {
        /* the next write tries again */
      }
      return gone
    },
    damaged: () => wasDamaged,
  }
}
