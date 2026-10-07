// The seedvis job ledger (plan §7.2, M3 / M4 / M8): stored and read back before a POST, never loses evidence, never
// holds a secret or a URL.
import { describe, expect, it } from 'vitest'
import {
  createSeedvisLedger,
  LEDGER_FINAL_KEEP_MS,
  LEDGER_SENT_KEEP_MS,
  MAX_JOBS,
  memoryStorage,
  parseLedger,
  SEEDVIS_DEV_LEDGER_KEY,
  SEEDVIS_LEDGER_KEY,
  type KeyValueStorage,
  type LedgerSent,
} from '../ledger'

const T0 = 1_800_000_000_000
const DAY = 86_400_000
const K1 = '11111111-1111-4111-8111-111111111111'
const K2 = '22222222-2222-4222-8222-222222222222'

const sentRec = (over: Partial<LedgerSent> = {}): LedgerSent => ({
  at: T0,
  firstLastByteAt: null,
  uploadBps: null,
  lastAt: T0,
  attempts: 1,
  model: 'seedvis/seedance_2.5',
  mode: 't2v',
  imageCount: 0,
  bodyHash: 'shash',
  bodyBytes: 1234,
  lastStatus: null,
  lastCode: null,
  lastRequestId: null,
  keyTag: 'aaaaaaaaaaaa',
  keyHint: 'AB12',
  ...over,
})

function clock(start = T0) {
  let t = start
  return { now: () => t, set: (v: number) => void (t = v), advance: (ms: number) => void (t += ms) }
}

describe('seedvis ledger — writes are stored and read back (M3)', () => {
  it('keys: real and simulated ledgers never share storage', () => {
    expect(SEEDVIS_LEDGER_KEY).toBe('bdp:seedvis:ledger')
    expect(SEEDVIS_DEV_LEDGER_KEY).toBe('bdp:dev:seedvis:ledger')
  })

  it('markSent persists and a new instance reads it back', () => {
    const storage = memoryStorage()
    const c = clock()
    const a = createSeedvisLedger({ storage, now: c.now })
    expect(a.markSent(K1, sentRec())).toBe(true)
    const b = createSeedvisLedger({ storage, now: c.now })
    expect(b.sent(K1)).toMatchObject({ at: T0, bodyHash: 'shash', keyHint: 'AB12' })
  })

  it('markSent fails — and leaves nothing in memory — when storage drops the write (full)', () => {
    const storage: KeyValueStorage = { get: () => null, set: () => undefined, remove: () => undefined }
    const l = createSeedvisLedger({ storage, now: () => T0 })
    expect(l.markSent(K1, sentRec())).toBe(false)
    expect(l.sent(K1)).toBeNull()
  })

  it('markSent fails when the value read back is not the one written, and when set throws', () => {
    const inner = memoryStorage()
    const stale: KeyValueStorage = { get: (k) => (k === SEEDVIS_LEDGER_KEY ? '{"v":1}' : inner.get(k)), set: inner.set, remove: inner.remove }
    expect(createSeedvisLedger({ storage: stale, now: () => T0 }).markSent(K1, sentRec())).toBe(false)
    const throwing: KeyValueStorage = {
      get: () => null,
      set: () => {
        throw new Error('QuotaExceededError')
      },
      remove: () => undefined,
    }
    const l = createSeedvisLedger({ storage: throwing, now: () => T0 })
    expect(l.markSent(K1, sentRec())).toBe(false)
    expect(l.sent(K1)).toBeNull()
  })

  it('updateSent never overwrites the first-attempt facts (at, firstLastByteAt, uploadBps)', () => {
    const l = createSeedvisLedger({ storage: memoryStorage(), now: () => T0 })
    l.markSent(K1, sentRec())
    expect(l.updateSent(K1, { firstLastByteAt: T0 + 5_000, uploadBps: 250_000, lastStatus: 202 })).toBe(true)
    l.updateSent(K1, { firstLastByteAt: T0 + 99_000, uploadBps: 1, attempts: 2, lastAt: T0 + 60_000 })
    expect(l.sent(K1)).toMatchObject({ at: T0, firstLastByteAt: T0 + 5_000, uploadBps: 250_000, attempts: 2, lastAt: T0 + 60_000, lastStatus: 202 })
    expect(l.updateSent(K2, { attempts: 3 })).toBe(false) // no record: nothing to update
  })
})

describe('seedvis ledger — jobs (M4)', () => {
  it('the first job recorded for a key wins; finals are set once; open jobs exclude finished ones', () => {
    const l = createSeedvisLedger({ storage: memoryStorage(), now: () => T0 })
    expect(l.recordJob(K1, { remoteId: 'gen_1', at: T0, keyTag: 'aaaaaaaaaaaa', keyHint: 'AB12' })).toBe(true)
    l.recordJob(K1, { remoteId: 'gen_999', at: T0 + 1, keyTag: null, keyHint: null })
    expect(l.job(K1)?.remoteId).toBe('gen_1')
    expect(l.keyOfRemote('gen_1')).toBe(K1)
    expect(l.keyOfRemote('gen_999')).toBeNull()
    l.recordJob(K2, { remoteId: 'gen_2', at: T0, keyTag: null, keyHint: null })
    expect(l.openJobs().map((o) => o.key).sort()).toEqual([K1, K2])
    l.setFinal(K1, { status: 'completed', code: null, at: T0 + 10 })
    l.setFinal(K1, { status: 'failed', code: 'x', at: T0 + 20 })
    expect(l.job(K1)?.final).toEqual({ status: 'completed', code: null, at: T0 + 10 })
    expect(l.openJobs().map((o) => o.key)).toEqual([K2])
  })

  it('refuses ids seedvis would never give (path characters) and keys that are not plain', () => {
    const l = createSeedvisLedger({ storage: memoryStorage(), now: () => T0 })
    expect(l.recordJob(K1, { remoteId: '../x', at: T0, keyTag: null, keyHint: null })).toBe(false)
    expect(l.recordJob('a/b', { remoteId: 'gen_1', at: T0, keyTag: null, keyHint: null })).toBe(false)
    expect(l.markSent('', sentRec())).toBe(false)
  })

  it('a not-found streak can be stored and cleared', () => {
    const l = createSeedvisLedger({ storage: memoryStorage(), now: () => T0 })
    l.recordJob(K1, { remoteId: 'gen_1', at: T0, keyTag: null, keyHint: null })
    l.setMiss(K1, { misses: 2, count: 1, first: T0, last: T0 })
    expect(l.job(K1)?.miss).toEqual({ misses: 2, count: 1, first: T0, last: T0 })
    l.setMiss(K1, null)
    expect(l.job(K1)?.miss).toBeUndefined()
    expect(createSeedvisLedger({ storage: memoryStorage(), now: () => T0 }).job(K1)).toBeNull()
  })
})

describe('seedvis ledger — evidence is never lost (M8)', () => {
  it('an unreadable stored value is kept aside and the ledger starts empty (damaged)', () => {
    const storage = memoryStorage()
    storage.set(SEEDVIS_LEDGER_KEY, '{not json')
    const l = createSeedvisLedger({ storage, now: () => T0 })
    expect(l.damaged()).toBe(true)
    expect(l.data().jobs).toEqual({})
    expect(storage.get(`${SEEDVIS_LEDGER_KEY}:damaged`)).toBe('{not json')
  })

  it('a damaged sent / job record never just disappears: its key goes to dropped (never posted again)', () => {
    const raw = JSON.stringify({
      v: 1,
      jobs: { [K1]: { remoteId: 'gen_1', at: T0 }, bad1: { remoteId: 42 } },
      sent: { [K2]: sentRec(), bad2: { at: 'yesterday' } },
      dropped: ['old'],
    })
    const { data, damaged } = parseLedger(raw)
    expect(damaged).toBe(true)
    expect(Object.keys(data.jobs)).toEqual([K1])
    expect(Object.keys(data.sent)).toEqual([K2])
    expect(data.dropped.sort()).toEqual(['bad1', 'bad2', 'old'])
  })

  it('trims a finished job 30 days after its end, a sent record 30 days after its last attempt — into dropped', () => {
    const storage = memoryStorage()
    const c = clock()
    const l = createSeedvisLedger({ storage, now: c.now })
    l.recordJob(K1, { remoteId: 'gen_1', at: T0, keyTag: null, keyHint: null })
    l.setFinal(K1, { status: 'completed', code: null, at: T0 })
    l.markSent(K2, sentRec())
    c.set(T0 + LEDGER_FINAL_KEEP_MS - 1)
    expect(l.trim()).toEqual([])
    c.set(T0 + Math.max(LEDGER_FINAL_KEEP_MS, LEDGER_SENT_KEEP_MS) + 1)
    expect(l.trim().sort()).toEqual([K1, K2].sort())
    expect(l.job(K1)).toBeNull()
    expect(l.sent(K2)).toBeNull()
    expect(l.isDropped(K1)).toBe(true)
    expect(l.isDropped(K2)).toBe(true)
    // …and it stays so in storage
    expect(createSeedvisLedger({ storage, now: c.now }).isDropped(K2)).toBe(true)
  })

  it('a key keeps being evidence while either of its records is kept', () => {
    const c = clock()
    const l = createSeedvisLedger({ storage: memoryStorage(), now: c.now })
    l.markSent(K1, sentRec({ lastAt: T0 + 40 * DAY }))
    l.recordJob(K1, { remoteId: 'gen_1', at: T0, keyTag: null, keyHint: null })
    l.setFinal(K1, { status: 'completed', code: null, at: T0 })
    c.set(T0 + 35 * DAY)
    l.trim()
    expect(l.job(K1)).toBeNull()
    expect(l.sent(K1)).not.toBeNull()
    expect(l.isDropped(K1)).toBe(false)
  })

  it('caps the number of jobs (oldest first), dropping their keys', () => {
    const l = createSeedvisLedger({ storage: memoryStorage(), now: () => T0 })
    for (let i = 0; i < MAX_JOBS + 3; i++) l.recordJob(`key-${i}`, { remoteId: `gen_${i}`, at: T0 + i, keyTag: null, keyHint: null })
    expect(Object.keys(l.data().jobs)).toHaveLength(MAX_JOBS)
    expect(l.isDropped('key-0')).toBe(true)
    expect(l.isDropped('key-2')).toBe(true)
    expect(l.isDropped('key-3')).toBe(false)
  })

  it('two tabs writing the same storage keep both records (merge, never overwrite)', () => {
    const storage = memoryStorage()
    const a = createSeedvisLedger({ storage, now: () => T0 })
    const b = createSeedvisLedger({ storage, now: () => T0 })
    expect(a.markSent(K1, sentRec())).toBe(true)
    expect(b.markSent(K2, sentRec())).toBe(true)
    a.recordJob(K1, { remoteId: 'gen_1', at: T0, keyTag: null, keyHint: null })
    const c = createSeedvisLedger({ storage, now: () => T0 })
    expect(c.sent(K1)).not.toBeNull()
    expect(c.sent(K2)).not.toBeNull()
    expect(c.job(K1)?.remoteId).toBe('gen_1')
    b.reload()
    expect(b.job(K1)?.remoteId).toBe('gen_1')
  })

  it('clearSent removes a record for good (a provably refused request)', () => {
    const storage = memoryStorage()
    const l = createSeedvisLedger({ storage, now: () => T0 })
    l.markSent(K1, sentRec())
    l.clearSent(K1)
    expect(l.sent(K1)).toBeNull()
    l.markSent(K2, sentRec())
    expect(createSeedvisLedger({ storage, now: () => T0 }).sent(K1)).toBeNull()
  })
})

describe('seedvis ledger — prepared bytes, orphans, no secrets', () => {
  it('stores prep ids / pins and orphans with their cancel outcome', () => {
    const l = createSeedvisLedger({ storage: memoryStorage(), now: () => T0 })
    l.setPrep(K1, { ids: ['prep-1'], pins: ['img-1', 'img-2'], at: T0 })
    expect(l.prep(K1)).toEqual({ ids: ['prep-1'], pins: ['img-1', 'img-2'], at: T0 })
    l.clearPrep(K1)
    expect(l.prep(K1)).toBeNull()
    l.recordOrphan(K2, { remoteId: 'gen_7', at: T0, outcome: null })
    l.setOrphanOutcome('gen_7', 'running')
    expect(l.data().orphans[K2]).toEqual({ remoteId: 'gen_7', at: T0, outcome: 'running' })
  })

  it('never stores a URL, a bearer token or a key-shaped string (codes, ids and hints are sanitized)', () => {
    const storage = memoryStorage()
    const l = createSeedvisLedger({ storage, now: () => T0 })
    l.markSent(
      K1,
      sentRec({
        lastCode: 'https://cdn.seedvis.com/x.mp4?sig=abc',
        lastRequestId: 'Bearer sv_live_abcdefghijklmnopqrstu',
        keyHint: 'sv_live_abcdefghijklmnopqrstu',
        keyTag: 'not a tag!',
      }),
    )
    l.updateSent(K1, { lastCode: 'generation_failed', lastRequestId: 'req_123' })
    l.updateSent(K1, { lastRequestId: 'https://evil.example/?k=sv_live_x' })
    const text = storage.get(SEEDVIS_LEDGER_KEY) ?? ''
    expect(text).not.toMatch(/https?:|sv_live|Bearer/)
    expect(l.sent(K1)).toMatchObject({ lastCode: 'generation_failed', lastRequestId: null, keyHint: null, keyTag: null })
  })
})
