// The seedvis adapter (plan §7, money rules §14) over a fake bridge + fake seedvis server state machine
// (seedvisFakes.ts). No network. The full end-to-end run on the A-SIM simulation is seedvis-dev-e2e (integration).
import { describe, expect, it } from 'vitest'
import { isResultDeferred, isResultTooLarge, isSubmitCancelled, isSubmitDeferred, isSubmitUncertain, isSubmitUnverifiable, type VideoProvider } from '../../types'
import { createSeedvisProvider, EXPIRED_LINK_MIN_AGE_MS, FORBIDDEN_RETRY_MS, MIN_POLL_MS, seedvisIdempotencyKey, type SeedvisPrepared, type SeedvisProvider } from '../adapter'
import { classifyCreate, SeedvisError } from '../errors'
import { isResultExpired, isResultHeld, type ProviderContractExt } from '../contractExt'
import { parseGeneration } from '../api'
import { memoryStorage, SEEDVIS_LEDGER_KEY, type KeyValueStorage } from '../ledger'
import { uuidFromKey } from '../../../lib/uuidKey'
import type { SeedvisBridge, SeedvisKeyStatus } from '../contract'
import {
  createFakeSeedvis,
  fakeClock,
  fakePrepare,
  fakeWords,
  images,
  OK_KEY,
  OTHER_KEY,
  seedvisReq,
  UNKNOWN_TEXT,
  UNVERIFIABLE_TEXT,
  type CreateFault,
  type FakeSeedvisOptions,
} from './seedvisFakes'

const MiB = 1024 * 1024

interface SetupOptions {
  /** Key memory the adapter's gate uses (default 120 s like the simulation; null = the shipped default). */
  memory?: number | null
  fake?: Partial<Omit<FakeSeedvisOptions, 'clock'>>
  storage?: KeyValueStorage
  blobs?: Record<string, number>
  bridge?: (b: SeedvisBridge) => SeedvisBridge | null
  echo?: Parameters<typeof createSeedvisProvider>[0]['echo']
  autoAccount?: boolean
  prepIds?: boolean
  keyMemoryFrom?: 'request' | 'last-byte'
}

function setup(o: SetupOptions = {}) {
  const clock = fakeClock()
  const memory = o.memory === undefined ? 120_000 : o.memory
  const sv = createFakeSeedvis({ clock, keyMemoryMs: memory ?? 120_000, ...o.fake })
  const prep = fakePrepare(o.blobs)
  const prepare = o.prepIds
    ? async (...args: Parameters<typeof prep.prepare>): Promise<SeedvisPrepared> => ({ ...(await prep.prepare(...args)), prepIds: ['prep-copy-1'] })
    : prep.prepare
  const notes: [string, string | null][] = []
  const released: string[][] = []
  const logs: string[] = []
  const storage = o.storage ?? memoryStorage()
  const bridge = o.bridge ? o.bridge(sv.bridge) : sv.bridge
  const provider = createSeedvisProvider({
    bridge,
    words: fakeWords,
    prepare,
    now: clock.now,
    monotonic: clock.mono,
    sleep: clock.sleep,
    keyMemoryMs: memory,
    ...(o.keyMemoryFrom ? { keyMemoryFrom: o.keyMemoryFrom } : {}),
    storage,
    onSubmitNote: (id, n) => void notes.push([id, n]),
    releasePrep: (ids) => void released.push([...ids]),
    log: (line) => void logs.push(line),
    autoAccount: o.autoAccount ?? false,
    ...(o.echo ? { echo: o.echo } : {}),
  })
  return { clock, sv, prep, provider, notes, released, logs, storage, key: (takeId = 'take-1') => seedvisIdempotencyKey(takeId) }
}

const fail = async (p: Promise<unknown>): Promise<SeedvisError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  if (!(e instanceof SeedvisError)) throw new Error(`expected a SeedvisError, got ${String(e)}`)
  return e
}

describe('submit — one key per take for life (M1), never posted again once it has a job (M4), 202 = created (M14)', () => {
  it('creates the job with uuidFromKey("sanovids:seedvis:" + take id) and never posts that key again', async () => {
    const { provider, sv, key } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    expect(key()).toBe(uuidFromKey('sanovids:seedvis:take-1'))
    expect(sv.creates()).toHaveLength(1)
    expect(sv.creates()[0]).toMatchObject({ key: key(), mustFinishBy: undefined })
    expect(sv.jobOf(key())?.id).toBe(remoteId)
    // M4: a second submit and a recover of that take answer from the ledger
    expect(await provider.submit(seedvisReq())).toEqual({ remoteId })
    expect(await provider.recover(seedvisReq())).toEqual({ remoteId })
    expect(sv.creates()).toHaveLength(1)
    // another take, another key
    await provider.submit(seedvisReq({ key: 'take-2', takeId: 'take-2' }))
    expect(new Set(sv.creates().map((c) => c.key)).size).toBe(2)
    expect(seedvisIdempotencyKey('take-2')).not.toBe(key())
  })

  it('a second submit of the same take while the first runs joins it (one POST)', async () => {
    const { provider, sv } = setup()
    const [a, b] = await Promise.all([provider.submit(seedvisReq()), provider.submit(seedvisReq())])
    expect(a).toEqual(b)
    expect(sv.creates()).toHaveLength(1)
  })

  it('a 200 answer with the id is taken like a 202 (the job exists)', async () => {
    const { provider, sv } = setup()
    sv.state.createFaults.push({ status: 200, store: true })
    const { remoteId } = await provider.submit(seedvisReq())
    expect(remoteId).toMatch(/^gen_/)
  })

  it('a 2xx whose job already failed (no credits after a 202) is recorded final: the poll reports it without asking', async () => {
    const { provider, sv } = setup()
    sv.state.createFaults.push({ status: 202, store: true, jobStatus: 'failed', errorCode: 'insufficient_credits' })
    const { remoteId } = await provider.submit(seedvisReq())
    const before = sv.gets().length
    const [st] = await provider.poll([remoteId])
    expect(st).toMatchObject({ remoteId, state: 'failed', code: 'insufficient_credits' })
    expect(sv.gets().length).toBe(before)
  })
})

describe('submit — nothing is sent', () => {
  it('refuses a canvasapp model or a mode the route does not have, before preparing anything', async () => {
    const { provider, sv, prep } = setup()
    const e1 = await fail(provider.submit(seedvisReq({ model: 'seedance_2_5' })))
    expect(e1.code).toBe('unsupported')
    const e2 = await fail(provider.submit(seedvisReq({ mode: 'first' })))
    expect(e2.code).toBe('unsupported')
    expect(prep.calls).toHaveLength(0)
    expect(sv.creates()).toHaveLength(0)
  })

  it('outside the desktop app: unavailable', async () => {
    const { provider } = setup({ bridge: () => null })
    expect((await fail(provider.submit(seedvisReq()))).message).toBe('W:web')
    expect(await provider.available()).toEqual({ ok: false, reason: 'W:web' })
  })

  it.each<[string, Partial<SeedvisKeyStatus>, string]>([
    ['no key', { hasKey: false, hint: null, tag: null }, 'W:no-key'],
    ['unreadable key', { hasKey: false, hint: null, tag: null, problem: 'unreadable' }, 'W:key-unreadable'],
  ])('%s → login-required, nothing sent', async (_, ks, text) => {
    const { provider, sv } = setup()
    sv.state.keyStatus = { ...OK_KEY, ...ks }
    const e = await fail(provider.submit(seedvisReq()))
    expect(e).toMatchObject({ code: 'login-required', message: text })
    expect(sv.creates()).toHaveLength(0)
    expect(await provider.available()).toEqual({ ok: false, reason: text })
  })

  it('a key still being read at start-up (problem "unknown") does not block: main decides', async () => {
    const { provider, sv } = setup()
    sv.state.keyStatus = { ...OK_KEY, hasKey: false, problem: 'unknown' }
    await provider.submit(seedvisReq())
    expect(sv.creates()).toHaveLength(1)
  })

  it('cancelled before — or right after the record is stored — nothing is posted and the record goes', async () => {
    const { provider, sv, key } = setup()
    expect(isSubmitCancelled(await fail(provider.submit(seedvisReq(), { isCancelled: () => true })))).toBe(true)
    // checks: at the start (1), once prepared (2), right after the record is stored (3) → cancelled there
    let calls = 0
    const e = await fail(provider.submit(seedvisReq(), { isCancelled: () => ++calls >= 3 }))
    expect(isSubmitCancelled(e)).toBe(true)
    expect(calls).toBe(3)
    expect(sv.creates()).toHaveLength(0)
    expect(provider.sameKeyRetry('take-1')).toEqual({ safeUntil: null, reason: 'no-record' })
    expect(provider.diagnostics('take-1')).toEqual({ provider: 'seedvis', idempotencyKey: key() })
  })

  it('M3: the ledger record cannot be stored → nothing posted', async () => {
    const storage: KeyValueStorage = { get: () => null, set: () => undefined, remove: () => undefined }
    const { provider, sv } = setup({ storage })
    const e = await fail(provider.submit(seedvisReq()))
    expect(e).toMatchObject({ code: 'storage', message: 'W:ledger-not-saved' })
    expect(sv.creates()).toHaveLength(0)
  })

  it('the images cannot be prepared → not-sent "chưa gửi gì"', async () => {
    const { provider, sv, prep } = setup()
    prep.fail(new Error('Ảnh @image_2 là GIF'))
    const e = await fail(provider.submit(seedvisReq({ images: images(2) })))
    expect(e).toMatchObject({ code: 'not-sent', message: 'W:prepare-failed Ảnh @image_2 là GIF' })
    expect(sv.creates()).toHaveLength(0)
  })
})

describe('submit — refusals and deferrals while nothing may have reached seedvis (§7.7)', () => {
  const refusals: [string, CreateFault, Partial<SeedvisError>][] = [
    ['400 invalid_image (native field)', { status: 400, json: { error: { code: 'invalid_image', message: 'bad' }, errors: { 'reference_images[1]': ['too big'] } } }, { remoteCode: 'invalid_image', field: 'reference_images[1]' }],
    ['400 OpenAI param', { status: 400, json: { error: { type: 'invalid_request_error', code: 'invalid_image', message: 'x', param: 'image' } } }, { remoteCode: 'invalid_image', field: 'image' }],
    ['400 Google format', { status: 400, json: { error: { code: 400, message: 'Bad lastFrame', status: 'INVALID_ARGUMENT' } } }, { remoteCode: 'INVALID_ARGUMENT' }],
    ['400 content_policy', { status: 400, json: { error: { code: 'content_policy', message: 'Dola refused' } } }, { remoteCode: 'content_policy' }],
    ['402 insufficient_credits', { status: 402, json: { error: { code: 'insufficient_credits', message: 'no credits' } } }, { remoteCode: 'insufficient_credits', status: 402 }],
    ['403 plan', { status: 403, json: { error: { code: 'forbidden', message: 'plan' } } }, { status: 403 }],
    ['404 model_not_found', { status: 404, json: { error: { code: 'model_not_found' } } }, { remoteCode: 'model_not_found' }],
    ['503 model_maintenance', { status: 503, json: { error: { code: 'model_maintenance' } } }, { remoteCode: 'model_maintenance' }],
    ['422 validation_error', { status: 422, json: { error: { code: 'validation_error', message: 'duration' } } }, { remoteCode: 'validation_error' }],
  ]
  it.each(refusals)('%s → a plain refusal, never "uncertain", the record goes', async (_, fault, expected) => {
    const { provider, sv } = setup()
    sv.state.createFaults.push(fault)
    const e = await fail(provider.submit(seedvisReq()))
    expect(e.code).toBe('refused')
    expect(e).toMatchObject(expected)
    expect(isSubmitUncertain(e)).toBe(false)
    expect(provider.sameKeyRetry('take-1').reason).toBe('no-record')
    expect(sv.creates()).toHaveLength(1)
  })

  it('401 → login-required (the engine raises the provider issue)', async () => {
    const { provider, sv } = setup()
    sv.state.createFaults.push({ status: 401, json: { error: { code: 'unauthorized' } } })
    expect(await fail(provider.submit(seedvisReq()))).toMatchObject({ code: 'login-required', message: 'W:bad-key' })
  })

  const busy: [string, CreateFault, number | null][] = [
    ['429 + Retry-After', { status: 429, json: { error: { code: 'rate_limited' } }, headers: { 'Retry-After': '42' } }, 42_000],
    ['503 server_busy', { status: 503, json: { error: { code: 'server_busy' } } }, null],
    ['422 slots full', { status: 422, json: { error: { code: 'concurrency_limit_reached', message: 'All slots busy' } } }, null],
    ['HTML 404 (maintenance)', { status: 404 }, null],
    ['main: lane rate-limited', { fail: 'rate-limited', retryAfterMs: 7_000 }, 7_000],
    ['main: busy', { fail: 'busy' }, null],
    ['main: offline', { fail: 'offline' }, null],
  ]
  it.each(busy)('%s → deferred (nothing sent, not billed), with the body size and Retry-After', async (_, fault, retryAfter) => {
    const { provider, sv } = setup()
    sv.state.createFaults.push(fault)
    const e = await fail(provider.submit(seedvisReq()))
    expect(isSubmitDeferred(e)).toBe(true)
    expect(e.bodyBytes).toBeGreaterThan(0)
    expect(e.retryAfterMs ?? null).toBe(retryAfter)
    expect(provider.sameKeyRetry('take-1').reason).toBe('no-record')
    if (retryAfter) expect(provider.deferDelayMs(1)).toBe(Math.max(15_000, retryAfter))
  })

  it('a 422 "slots full" lowers concurrency() to the jobs already open for a while', async () => {
    const { provider, sv, clock } = setup()
    await provider.submit(seedvisReq({ key: 'other', takeId: 'other' }))
    provider.noteAccountInfo({ concurrency_limit: 5 })
    expect(provider.concurrency()).toBe(5)
    sv.state.createFaults.push({ status: 422, json: { error: { code: 'slots_full' } } })
    await fail(provider.submit(seedvisReq()))
    expect(provider.concurrency()).toBe(1)
    clock.advance(10 * 60_000)
    provider.noteAccountInfo({ concurrency_limit: 5 })
    expect(provider.concurrency()).toBe(5)
  })

  it('the upload broke (sent:false) → not-sent "chưa gửi gì"; main refused it locally → its own text', async () => {
    const { provider, sv } = setup()
    sv.state.createFaults.push('stall')
    expect(await fail(provider.submit(seedvisReq()))).toMatchObject({ code: 'not-sent', message: 'W:not-sent-upload' })
    sv.state.createFaults.push({ fail: 'bad-image', message: 'Ảnh hỏng.' })
    expect(await fail(provider.submit(seedvisReq({ key: 't2', takeId: 't2' })))).toMatchObject({ code: 'not-sent', message: 'W:not-sent-local Ảnh hỏng.' })
    expect(sv.duplicates()).toBe(0)
  })
})

describe('submit — lost answers and the arrival gate (M5, M6, M9)', () => {
  it('shipped default (key memory null): a lost answer is unverifiable at once — exactly one POST, never a re-send', async () => {
    const { provider, sv } = setup({ memory: null })
    sv.state.createFaults.push('lost-after-store')
    const e = await fail(provider.submit(seedvisReq()))
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(e).toMatchObject({ message: UNVERIFIABLE_TEXT, detail: 'D:gate-disabled' })
    expect(sv.creates()).toHaveLength(1)
    expect(provider.sameKeyRetry('take-1')).toEqual({ safeUntil: null, reason: 'disabled' })
    // an explicit retry: refused by the gate before anything else
    const e2 = await fail(provider.submit(seedvisReq(), { retryOfUnknown: true }))
    expect(isSubmitUnverifiable(e2)).toBe(true)
    expect(sv.creates()).toHaveLength(1)
  })

  it.each<[string, CreateFault]>([
    ['2xx without an id', { status: 202, json: { data: { status: 'queued' } }, store: false }],
    ['a non-JSON 502', { status: 502 }],
    ['IPC rejected', 'ipc-reject'],
    ['409 idempotency_conflict', { status: 409, json: { error: { code: 'idempotency_conflict' } } }],
  ])('%s on the first POST is "maybe billed" (never a plain error, never a new key)', async (_, fault) => {
    const { provider, sv } = setup({ memory: null })
    sv.state.createFaults.push(fault)
    const e = await fail(provider.submit(seedvisReq()))
    expect(isSubmitUncertain(e)).toBe(true)
    expect(sv.creates()).toHaveLength(1)
  })

  it('lost answer, key stored: the re-send at +15 s carries the same key and mustFinishBy and gets the same job back', async () => {
    const { provider, sv, key, notes, clock } = setup()
    sv.state.createFaults.push('lost-after-store')
    const t0 = clock.now()
    const { remoteId } = await provider.submit(seedvisReq())
    const [first, second] = sv.creates()
    expect(sv.creates()).toHaveLength(2)
    expect(second.key).toBe(first.key)
    // measured from the first POST start (KEY_MEMORY_FROM 'request'), never from its last byte
    expect(second.mustFinishBy).toBe(first.at + 120_000 - 20_000)
    // +15 s after the lost answer (which came 45 s after the last byte)
    expect(second.at).toBe(sv.jobOf(key())!.storedAt + 45_000 + 15_000)
    expect(remoteId).toBe(sv.jobOf(key())!.id)
    expect(sv.duplicates()).toBe(0)
    expect(provider.diagnostics('take-1')).toMatchObject({ remoteId, attempts: '2', replayed: 'true' })
    expect(notes).toEqual([
      ['take-1', 'D:resending'],
      ['take-1', null],
    ])
    expect(t0).toBeLessThan(clock.now())
  })

  it('lost before seedvis stored it: the gated re-send creates the (first and only) job', async () => {
    const { provider, sv } = setup()
    sv.state.createFaults.push('lost-before-store')
    await provider.submit(seedvisReq())
    expect(sv.state.jobs.size).toBe(1)
    expect(sv.duplicates()).toBe(0)
  })

  it('a JSON 5xx generation_failed ("retrying is safe") is re-sent with the same key through the gate', async () => {
    const { provider, sv } = setup()
    sv.state.createFaults.push({ status: 502, json: { error: { code: 'generation_failed', message: 'retried internally' } } })
    const { remoteId } = await provider.submit(seedvisReq())
    expect(remoteId).toMatch(/^gen_/)
    expect(sv.creates()).toHaveLength(2)
    expect(sv.creates()[1].mustFinishBy).toBeDefined()
  })

  it('every re-send lost: stops when the gate closes → unverifiable; 0 duplicate jobs', async () => {
    const { provider, sv } = setup()
    sv.state.createFaults.push('lost-after-store', 'lost-after-store', 'lost-after-store', 'lost-after-store')
    const e = await fail(provider.submit(seedvisReq()))
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(e.detail).toBe('D:gate-expired')
    const creates = sv.creates()
    const start = sv.jobOf(seedvisIdempotencyKey('take-1'))!.storedAt
    for (const c of creates.slice(1)) expect(c.at).toBeLessThanOrEqual(start + 100_000)
    expect(sv.duplicates()).toBe(0)
  })

  it('schedule over while the gate is still open → uncertain (not unverifiable): an explicit retry then re-sends at once', async () => {
    const { provider, sv, clock, prep } = setup({ memory: 600_000, fake: { answerWaitMs: 5_000 } })
    sv.state.createFaults.push('lost-before-store', 'lost-before-store', 'lost-before-store', 'lost-before-store')
    const e = await fail(provider.submit(seedvisReq()))
    expect(isSubmitUncertain(e) && !isSubmitUnverifiable(e)).toBe(true)
    expect(e.message).toBe(UNKNOWN_TEXT)
    expect(sv.creates()).toHaveLength(4)
    const r = provider.sameKeyRetry('take-1')
    expect(r.reason).toBe('ok')
    expect(r.safeUntil).toBeGreaterThan(clock.now())
    // "Chạy lại" (same take, retryOfUnknown): the same key, the same bytes, with mustFinishBy
    const { remoteId } = await provider.submit(seedvisReq(), { retryOfUnknown: true })
    expect(remoteId).toMatch(/^gen_/)
    expect(sv.creates()).toHaveLength(5)
    expect(new Set(sv.creates().map((c) => c.key)).size).toBe(1)
    expect(sv.creates()[4].mustFinishBy).toBeDefined()
    expect(prep.calls).toHaveLength(1) // the exact bytes of the first POST, not rebuilt
    expect(sv.duplicates()).toBe(0)
  })

  it('M6: a lost answer, then 429 / 422 / 400 / 409 on the re-sends → still "maybe billed", never deferred or refused', async () => {
    const { provider, sv } = setup({ memory: 600_000, fake: { answerWaitMs: 5_000 } })
    sv.state.createFaults.push(
      'lost-before-store',
      { status: 429, json: { error: { code: 'rate_limited' } }, headers: { 'Retry-After': '30' } },
      { status: 422, json: { error: { code: 'slots_full' } } },
      { status: 400, json: { error: { code: 'invalid_value' } } },
    )
    const e = await fail(provider.submit(seedvisReq()))
    expect(isSubmitUncertain(e)).toBe(true)
    expect(isSubmitDeferred(e)).toBe(false)
    expect(e.code).toBe('uncertain')
    expect(e.detail).toBe('D:refused-after 400 invalid_value')
  })

  it('open decision 9: Huỷ while waiting to re-send → stops at once, "maybe billed" (never "cancelled")', async () => {
    const { provider, sv } = setup()
    sv.state.createFaults.push('lost-before-store')
    // cancelled in SanoVids as soon as the first POST has gone out
    const e = await fail(provider.submit(seedvisReq(), { isCancelled: () => sv.creates().length >= 1 }))
    expect(isSubmitCancelled(e)).toBe(false)
    expect(isSubmitUncertain(e)).toBe(true)
    expect(e.detail).toBe('D:cancelled-resending')
    expect(sv.creates()).toHaveLength(1)
    // the window is still open: "Chạy lại" may send the same key again
    expect(provider.sameKeyRetry('take-1').reason).toBe('ok')
  })

  it('waits for the network before a re-send; gives up when the gate closes meanwhile', async () => {
    const { provider, sv } = setup()
    sv.state.createFaults.push('lost-before-store')
    sv.state.online = () => false
    const e = await fail(provider.submit(seedvisReq()))
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(sv.creates()).toHaveLength(1)
    expect(sv.state.calls.filter((c) => c.route === 'isOnline').length).toBeGreaterThan(3)
  })

  it('8 MiB at 2 Mbps, lost answer: no re-send fits the window → unverifiable, one POST, 0 duplicates', async () => {
    const { provider, sv } = setup({ blobs: { 'img-1': Math.floor((8 * MiB * 3) / 4) }, fake: { bandwidthBps: 2_000_000 / 8 } })
    sv.state.createFaults.push('lost-after-store')
    const e = await fail(provider.submit(seedvisReq({ images: images(1) })))
    expect(e).toMatchObject({ detail: 'D:gate-expired' })
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(sv.creates()).toHaveLength(1)
    expect(sv.duplicates()).toBe(0)
  })

  it('30 MiB at 2 Mbps, lost answer, explicit "Chạy lại" at 1:30 → refused by the gate, no POST, 0 duplicates', async () => {
    const { provider, sv, clock, prep } = setup({ blobs: { 'img-1': Math.floor((30 * MiB * 3) / 4) }, fake: { bandwidthBps: 2_000_000 / 8 } })
    sv.state.createFaults.push('lost-after-store')
    const e = await fail(provider.submit(seedvisReq({ images: images(1) })))
    expect(isSubmitUnverifiable(e)).toBe(true)
    const lastByte = sv.jobOf(seedvisIdempotencyKey('take-1'))!.storedAt
    clock.set(lastByte + 90_000)
    const preparedBefore = prep.calls.length
    const e2 = await fail(provider.submit(seedvisReq({ images: images(1) }), { retryOfUnknown: true }))
    expect(isSubmitUnverifiable(e2)).toBe(true)
    expect(prep.calls.length).toBe(preparedBefore) // the gate decides before anything is prepared
    expect(sv.creates()).toHaveLength(1)
    expect(sv.duplicates()).toBe(0)
  })

  it('the upload slows to a quarter during the re-send → main aborts at mustFinishBy (deadline) → unverifiable, 0 duplicates', async () => {
    const bps = 1_000_000
    const { provider, sv, clock } = setup({ blobs: { 'img-1': Math.floor((15_000_000 * 3) / 4) }, fake: { bandwidthBps: (attempt) => (attempt === 1 ? bps : bps / 4) } })
    sv.state.createFaults.push('lost-before-store')
    const e = await fail(provider.submit(seedvisReq({ images: images(1) })))
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(e.detail).toBe('D:deadline')
    const [, resend] = sv.creates()
    expect(resend.mustFinishBy).toBeDefined()
    expect(clock.now()).toBe(resend.mustFinishBy)
    expect(sv.state.jobs.size).toBe(0) // the partial body never became a job
    expect(sv.duplicates()).toBe(0)
  })

  it('property: lost answers, slow / slowing uploads and explicit retries at any moment never create a second job (memory exactly 120 s)', async () => {
    let seed = 0x5a17c0de
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const faults: CreateFault[] = ['ok', 'lost-after-store', 'lost-before-store', 'stall', { status: 502 }, { status: 429 }, { fail: 'timeout', sent: true, store: true }]
    let resent = 0
    for (let i = 0; i < 160; i++) {
      const size = Math.floor(rnd() * 1.5 * MiB)
      const base = 10_000 + rnd() * 1_500_000
      const slow = 0.15 + rnd() * 1.5
      const { provider, sv, clock } = setup({
        blobs: { 'img-1': size },
        fake: { bandwidthBps: (a) => (a === 1 ? base : base * slow), answerWaitMs: 1_000 + rnd() * 60_000 },
      })
      for (let f = 0; f < 6; f++) sv.state.createFaults.push(faults[Math.floor(rnd() * faults.length)])
      const req = seedvisReq({ images: images(1) })
      const first = await provider.submit(req).then(
        () => null,
        (e: unknown) => e,
      )
      if (first && isSubmitUncertain(first)) {
        clock.advance(Math.floor(rnd() * 150_000))
        await provider.submit(req, { retryOfUnknown: true }).catch(() => null)
      }
      if (sv.creates().length > 1) resent++
      expect(sv.duplicates(), `scenario ${i}`).toBe(0)
      // M6: once something may have reached seedvis, never "deferred"
      if (first && isSubmitDeferred(first)) expect(sv.creates()).toHaveLength(1)
    }
    expect(resent).toBeGreaterThan(10)
  }, 60_000)
})

describe('submit — explicit retry (§7.4, M7, M8)', () => {
  it('M8: "Chạy lại" of a maybe-billed take with no record here (cleared storage, another computer) → unverifiable, no POST', async () => {
    const { provider, sv } = setup()
    const e = await fail(provider.submit(seedvisReq(), { retryOfUnknown: true }))
    expect(e).toMatchObject({ detail: 'D:no-record', message: UNVERIFIABLE_TEXT })
    expect(sv.creates()).toHaveLength(0)
  })

  it('M8: a key whose record was trimmed (dropped) is never posted again', async () => {
    const storage = memoryStorage()
    storage.set(SEEDVIS_LEDGER_KEY, JSON.stringify({ v: 1, jobs: {}, sent: {}, prep: {}, orphans: {}, dropped: [seedvisIdempotencyKey('take-1')] }))
    const { provider, sv } = setup({ storage })
    expect(isSubmitUnverifiable(await fail(provider.submit(seedvisReq())))).toBe(true)
    expect(sv.creates()).toHaveLength(0)
  })

  it('M7: after a restart, a rebuilt body that differs → unverifiable (body-changed), no POST; remembered by sameKeyRetry', async () => {
    const storage = memoryStorage()
    const clock = fakeClock()
    const sv = createFakeSeedvis({ clock, keyMemoryMs: 600_000, answerWaitMs: 1_000 })
    const mk = () =>
      createSeedvisProvider({ bridge: sv.bridge, words: fakeWords, prepare: fakePrepare().prepare, now: clock.now, monotonic: clock.mono, sleep: clock.sleep, keyMemoryMs: 600_000, storage, autoAccount: false })
    sv.state.createFaults.push('lost-before-store', 'lost-before-store', 'lost-before-store', 'lost-before-store')
    await fail(mk().submit(seedvisReq()))
    const after = mk() // restart: only the ledger is left
    const e = await fail(after.submit(seedvisReq({ prompt: 'Một chú chó' }), { retryOfUnknown: true }))
    expect(e).toMatchObject({ detail: 'D:body-changed' })
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(sv.creates()).toHaveLength(4)
    expect(after.sameKeyRetry('take-1').reason).toBe('body-changed')
    // from then on the key is never re-sent, not even with the original body (only "Tạo lại" can run)
    const again = mk()
    expect(isSubmitUnverifiable(await fail(again.submit(seedvisReq(), { retryOfUnknown: true })))).toBe(true)
    expect(sv.creates()).toHaveLength(4)
  })

  it('M7: after a restart, the same body inside the window → one same-key POST with mustFinishBy', async () => {
    const storage = memoryStorage()
    const clock = fakeClock()
    const sv = createFakeSeedvis({ clock, keyMemoryMs: 600_000, answerWaitMs: 1_000 })
    const mk = () =>
      createSeedvisProvider({ bridge: sv.bridge, words: fakeWords, prepare: fakePrepare().prepare, now: clock.now, monotonic: clock.mono, sleep: clock.sleep, keyMemoryMs: 600_000, storage, autoAccount: false })
    sv.state.createFaults.push('lost-after-store', 'lost-before-store', 'lost-before-store', 'lost-before-store')
    await fail(mk().submit(seedvisReq()))
    const { remoteId } = await mk().submit(seedvisReq(), { retryOfUnknown: true })
    expect(remoteId).toBe(sv.jobOf(seedvisIdempotencyKey('take-1'))!.id)
    expect(sv.creates()).toHaveLength(5)
    expect(sv.duplicates()).toBe(0)
  })

  it('M6: an explicit retry cancelled before its POST stays "maybe billed" (never "cancelled" = nothing sent)', async () => {
    const { provider, sv } = setup({ memory: 600_000, fake: { answerWaitMs: 1_000 } })
    sv.state.createFaults.push('lost-before-store', 'lost-before-store', 'lost-before-store', 'lost-before-store')
    await fail(provider.submit(seedvisReq()))
    const e = await fail(provider.submit(seedvisReq(), { retryOfUnknown: true, isCancelled: () => true }))
    expect(isSubmitCancelled(e)).toBe(false)
    expect(isSubmitUncertain(e)).toBe(true)
    expect(e.detail).toBe('D:cancelled-resending')
    expect(sv.creates()).toHaveLength(4)
  })

  it('the images of a re-send can no longer be prepared (deleted) → unverifiable, no POST', async () => {
    const storage = memoryStorage()
    const clock = fakeClock()
    const sv = createFakeSeedvis({ clock, keyMemoryMs: 600_000, answerWaitMs: 1_000 })
    const prep = fakePrepare()
    const mk = () => createSeedvisProvider({ bridge: sv.bridge, words: fakeWords, prepare: prep.prepare, now: clock.now, monotonic: clock.mono, sleep: clock.sleep, keyMemoryMs: 600_000, storage, autoAccount: false })
    sv.state.createFaults.push('lost-before-store', 'lost-before-store', 'lost-before-store', 'lost-before-store')
    await fail(mk().submit(seedvisReq()))
    prep.fail(new Error('Ảnh đã bị xoá'))
    const e = await fail(mk().submit(seedvisReq(), { retryOfUnknown: true }))
    expect(e).toMatchObject({ detail: 'D:prepare-resend Ảnh đã bị xoá' })
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(sv.creates()).toHaveLength(4)
  })

  it('sameKeyRetry: job known → always safe (no POST happens); window open → ok + safeUntil; passed → expired', async () => {
    const { provider, sv, clock } = setup({ memory: 600_000, fake: { answerWaitMs: 1_000 } })
    await provider.submit(seedvisReq({ key: 'done', takeId: 'done' }))
    expect(provider.sameKeyRetry('done')).toEqual({ safeUntil: Number.POSITIVE_INFINITY, reason: 'ok' })
    sv.state.createFaults.push('lost-before-store', 'lost-before-store', 'lost-before-store', 'lost-before-store')
    await fail(provider.submit(seedvisReq()))
    const r = provider.sameKeyRetry('take-1')
    expect(r.reason).toBe('ok')
    expect(r.safeUntil).toBeGreaterThan(clock.now())
    clock.set(r.safeUntil! + 1)
    expect(provider.sameKeyRetry('take-1')).toEqual({ safeUntil: r.safeUntil, reason: 'expired' })
  })
})

describe('recover — ledger only, never a request (M4)', () => {
  it('a take whose POST may have been sent but has no job id: null, and nothing is posted', async () => {
    const { provider, sv } = setup({ memory: null })
    sv.state.createFaults.push('lost-after-store')
    await fail(provider.submit(seedvisReq()))
    expect(await provider.recover(seedvisReq())).toBeNull()
    expect(sv.creates()).toHaveLength(1)
  })

  it('joins a submit in flight', async () => {
    const { provider } = setup()
    const p = provider.submit(seedvisReq())
    const r = await provider.recover(seedvisReq())
    expect(r).toEqual(await p)
  })
})

describe('poll (§7.5, §6.9, M14, M22, M23)', () => {
  it('queued (with position) → processing → completed, paced by next.after_seconds; a final status is never asked again', async () => {
    const { provider, sv, clock } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    let [st] = await provider.poll([remoteId])
    expect(st).toMatchObject({ state: 'queued', phase: 'queued', note: 'P:queued 2 60' })
    expect(sv.gets()).toHaveLength(1)
    // not due yet (after_seconds 20 > the 15 s floor): the last status, no request
    clock.advance(15_000)
    ;[st] = await provider.poll([remoteId])
    expect(st.state).toBe('queued')
    expect(sv.gets()).toHaveLength(1)
    clock.advance(5_000)
    ;[st] = await provider.poll([remoteId])
    expect(st).toMatchObject({ state: 'processing', phase: 'processing' })
    expect(st.progress).toBeGreaterThanOrEqual(5)
    expect(st.progress).toBeLessThanOrEqual(95)
    clock.advance(20_000)
    ;[st] = await provider.poll([remoteId])
    expect(st).toMatchObject({ state: 'completed', progress: 99 })
    clock.advance(60_000)
    ;[st] = await provider.poll([remoteId])
    expect(st.state).toBe('completed')
    expect(sv.gets()).toHaveLength(3)
    expect(provider.openJobs()).toEqual([])
    expect(provider.jobEndedAt()).not.toBeNull()
  })

  it('HTTP 202 on a poll is a normal answer (never an error or a re-send)', async () => {
    const { provider, sv } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.getScript.set(remoteId, [{ status: 202, json: { data: { id: remoteId, status: 'processing' } } }])
    const [st] = await provider.poll([remoteId])
    expect(st.state).toBe('processing')
    expect(sv.creates()).toHaveLength(1)
  })

  it.each<[string, string, Record<string, unknown>]>([
    ['cancelled (refunded)', 'cancelled', { state: 'cancelled', code: 'cancelled', error: 'P:cancelled-refunded' }],
    ['not_started (not billed)', 'not_started', { state: 'failed', code: 'not_started', error: 'P:not-started' }],
    ['generation_failed', 'generation_failed', { state: 'failed', code: 'generation_failed' }],
    ['content_policy via poll', 'content_policy', { state: 'failed', code: 'content_policy' }],
  ])('failed + %s', async (_, code, expected) => {
    const { provider, sv } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.getScript.set(remoteId, [{ status: 200, json: { data: { id: remoteId, status: 'failed', is_final: true, error: { code, message: 'x' } } } }])
    const [st] = await provider.poll([remoteId])
    expect(st).toMatchObject(expected)
  })

  it('M22: a JSON not-found keeps the paid take running with back-off; it ends only after ≥ 3 answers over ≥ 30 min with the same key', async () => {
    const { provider, sv, clock } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.jobs.delete(remoteId) // the fake now answers 404 { error: { code: 'generation_not_found' } }
    const start = clock.now()
    let st = (await provider.poll([remoteId]))[0]
    let minutes = 0
    while (st.state !== 'failed' && minutes < 120) {
      expect(st).toMatchObject({ state: 'processing', note: 'P:not-found-waiting' })
      if (clock.now() - start < 30 * 60_000) expect(st.state).toBe('processing')
      clock.advance(60_000)
      minutes++
      st = (await provider.poll([remoteId]))[0]
    }
    expect(st).toMatchObject({ state: 'failed', code: 'not_found', error: `P:not-found ${remoteId.slice(0, 8)}` })
    expect(clock.now() - start).toBeGreaterThanOrEqual(30 * 60_000)
    // back-off: far fewer requests than one per minute
    expect(sv.gets().length).toBeLessThan(15)
    expect(sv.gets().length).toBeGreaterThanOrEqual(3)
  })

  it('M22: an HTML 404 (maintenance) never ends a take — days of it, polled every 6 h at the end', async () => {
    const { provider, sv, clock } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.getFallback = () => ({ status: 404 })
    for (let h = 0; h < 7 * 24; h++) {
      const [st] = await provider.poll([remoteId])
      expect(st.state).toBe('processing')
      clock.advance(3_600_000)
    }
    expect(sv.gets().length).toBeLessThan(45)
  })

  it('M22: a JSON not-found for a job whose sending key is unknown never ends it', async () => {
    const { provider, sv, clock } = setup()
    sv.state.keyStatus = null // the key status could not be read at submit: the job has no key tag
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.keyStatus = OK_KEY
    sv.state.jobs.delete(remoteId)
    for (let h = 0; h < 48; h++) {
      expect((await provider.poll([remoteId]))[0].state).toBe('processing')
      clock.advance(3_600_000)
    }
  })

  it('M23: a job sent with another key is held — no request, never failed — until that key is back', async () => {
    const { provider, sv, clock } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.keyStatus = OTHER_KEY
    for (let i = 0; i < 10; i++) {
      const [st] = await provider.poll([remoteId])
      expect(st).toEqual({ remoteId, state: 'processing', held: { keyHint: 'AB12' }, note: 'P:held …AB12' })
      clock.advance(3_600_000)
    }
    expect(sv.gets()).toHaveLength(0)
    expect(provider.openJobs()).toEqual([{ remoteId, keyHint: 'AB12', at: expect.any(Number) }])
    sv.state.keyStatus = OK_KEY
    const [st] = await provider.poll([remoteId])
    expect(st.held).toBeUndefined()
    expect(sv.gets()).toHaveLength(1)
  })

  it('401 / 403 / no key → throws login-required (the engine pauses polling and keeps the takes)', async () => {
    const { provider, sv, clock } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.getScript.set(remoteId, [{ status: 401, json: { error: { code: 'unauthorized' } } }])
    expect(await fail(provider.poll([remoteId]))).toMatchObject({ code: 'login-required' })
    clock.advance(MIN_POLL_MS)
    sv.state.keyStatus = { ...OK_KEY, hasKey: false, tag: null, hint: null }
    expect(await fail(provider.poll([remoteId]))).toMatchObject({ code: 'login-required', message: 'W:no-key' })
  })

  it('one job answering 5xx does not stop the others; all failing throws (the engine backs off)', async () => {
    const { provider, sv, clock } = setup()
    const a = (await provider.submit(seedvisReq())).remoteId
    const b = (await provider.submit(seedvisReq({ key: 'take-2', takeId: 'take-2' }))).remoteId
    sv.state.getScript.set(a, [{ status: 503, json: { error: { code: 'server_error' } } }])
    const out = await provider.poll([a, b])
    expect(out.find((s) => s.remoteId === a)).toEqual({ remoteId: a, state: 'processing' })
    expect(out.find((s) => s.remoteId === b)?.state).toBe('queued')
    clock.advance(30_000)
    sv.state.getScript.set(a, [{ status: 500 }])
    sv.state.getScript.set(b, [{ fail: 'network' }])
    expect(await fail(provider.poll([a, b]))).toBeInstanceOf(SeedvisError)
  })

  it('at most 2 GETs at once', async () => {
    let inFlight = 0
    let max = 0
    const { provider } = setup({
      bridge: (b) => ({
        ...b,
        request: async (args) => {
          if (args.route !== 'generations.get') return b.request(args)
          inFlight++
          max = Math.max(max, inFlight)
          await new Promise((r) => setTimeout(r, 2))
          inFlight--
          return b.request(args)
        },
      }),
    })
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push((await provider.submit(seedvisReq({ key: `t${i}`, takeId: `t${i}` }))).remoteId)
    const out = await provider.poll(ids)
    expect(out).toHaveLength(6)
    expect(max).toBe(2)
  })

  it('an id seedvis would never give is failed without a request', async () => {
    const { provider, sv } = setup()
    expect(await provider.poll(['../etc'])).toEqual([{ remoteId: '../etc', state: 'failed', code: 'bad_id', error: 'P:bad-id' }])
    expect(sv.gets()).toHaveLength(0)
  })

  it('echo check is warn-only (M19): a short echo becomes a note, the job is kept', async () => {
    const { provider, sv } = setup({ echo: (p) => ({ received: 1, sent: p.images.length }) })
    const { remoteId } = await provider.submit(seedvisReq({ images: images(2) }))
    sv.state.autoAdvance = false
    sv.state.jobs.get(remoteId)!.status = 'processing'
    const [st] = await provider.poll([remoteId])
    expect(st).toMatchObject({ state: 'processing', note: 'P:echo 1/2' })
    expect(provider.diagnostics('take-1').echo).toBe('1/2')
  })
})

describe('fetchResult (§6.8, §7.5, M27)', () => {
  async function completed(o: SetupOptions = {}) {
    const s = setup(o)
    const { remoteId } = await s.provider.submit(seedvisReq())
    s.sv.state.jobs.get(remoteId)!.status = 'completed'
    return { ...s, remoteId }
  }

  it('GETs the job (main records its outputs), then downloads the pieces by (generationId, index) with progress', async () => {
    const { provider, sv, remoteId } = await completed({ fake: { videoBytes: 50_000, chunkBytes: 8_192 } })
    const progress: number[] = []
    const r = await provider.fetchResult(remoteId, { onProgress: (p) => progress.push(p.received) })
    expect(r.video?.size).toBe(50_000)
    expect(r.video?.type).toBe('video/mp4')
    expect(r.poster).toBeNull()
    expect(progress.at(-1)).toBe(50_000)
    const routes = sv.state.calls.map((c) => c.route)
    const open = routes.indexOf('downloadOpen')
    expect(routes.lastIndexOf('generations.get', open)).toBeGreaterThan(routes.lastIndexOf('generations.create'))
    expect(routes.filter((r) => r === 'downloadRead')).toHaveLength(Math.ceil(50_000 / 8_192) + 1)
  })

  it('offline → deferred (not one of the tries), nothing requested', async () => {
    const { provider, sv, remoteId } = await completed()
    sv.state.online = () => false
    const gets = sv.gets().length
    expect(isResultDeferred(await fail(provider.fetchResult(remoteId)))).toBe(true)
    expect(sv.gets().length).toBe(gets)
  })

  it('an expired link: GET again for a fresh one; expired again on a job that completed ≥ 24 h ago → the definitive "hết hạn"', async () => {
    const one = await completed()
    one.sv.state.expiredOpens = 1
    expect((await one.provider.fetchResult(one.remoteId)).video?.size).toBe(10_000)
    const two = await completed()
    expect((await two.provider.poll([two.remoteId]))[0].state).toBe('completed') // completion recorded in the ledger
    two.clock.advance(EXPIRED_LINK_MIN_AGE_MS)
    two.sv.state.expiredOpens = 2
    const e = await fail(two.provider.fetchResult(two.remoteId))
    expect(isResultExpired(e)).toBe(true)
    expect(e.message).toBe('F:expired')
  })

  it('M27: a CDN refusal right after completion is never the definitive expiry — the paid take stays recoverable', async () => {
    const s = await completed()
    expect((await s.provider.poll([s.remoteId]))[0].state).toBe('completed')
    // the CDN answers 404 to the link and to the fresh one, seconds after `completed` (not replicated yet)
    s.sv.state.expiredOpens = 2
    const e = await fail(s.provider.fetchResult(s.remoteId))
    expect(isResultExpired(e)).toBe(false)
    expect(e).toMatchObject({ code: 'expired-link', message: 'F:link-refused' })
    expect(e.definitive).toBeUndefined()
    // 23 h later still not definitive; the next try downloads it
    s.clock.advance(EXPIRED_LINK_MIN_AGE_MS - 3_600_000)
    s.sv.state.expiredOpens = 2
    expect(isResultExpired(await fail(s.provider.fetchResult(s.remoteId)))).toBe(false)
    expect((await s.provider.fetchResult(s.remoteId)).video?.size).toBe(10_000)
    // a job whose completion this computer never recorded (another computer…) is never declared expired either
    const other = await completed()
    other.clock.advance(30 * EXPIRED_LINK_MIN_AGE_MS)
    other.sv.state.expiredOpens = 2
    expect(isResultExpired(await fail(other.provider.fetchResult(other.remoteId)))).toBe(false)
  })

  it('M23: a finished job of another API key is held — no request, not a counted try — until that key is back', async () => {
    const { provider, sv, remoteId } = await completed()
    expect((await provider.poll([remoteId]))[0].state).toBe('completed') // cached final: the poll's hold is skipped
    sv.state.keyStatus = OTHER_KEY
    const before = sv.state.calls.filter((c) => c.route !== 'keyStatus').length
    const e = await fail(provider.fetchResult(remoteId))
    expect(isResultHeld(e)).toBe(true)
    expect(isResultDeferred(e)).toBe(true)
    expect(e).toMatchObject({ code: 'deferred', held: { keyHint: 'AB12' }, message: 'P:held …AB12' })
    expect(sv.state.calls.filter((c) => c.route !== 'keyStatus').length).toBe(before)
    sv.state.keyStatus = OK_KEY
    expect((await provider.fetchResult(remoteId)).video?.size).toBe(10_000)
  })

  it('completed without outputs: one more round, then "không có file"', async () => {
    const { provider, sv, remoteId } = await completed()
    sv.state.jobs.get(remoteId)!.outputs = 0
    const e = await fail(provider.fetchResult(remoteId))
    expect(e).toMatchObject({ code: 'no-output', message: 'F:no-output' })
  })

  it('cancelled / deleted while downloading → closes the download and stops', async () => {
    const { provider, sv, remoteId } = await completed({ fake: { videoBytes: 40_000, chunkBytes: 4_096 } })
    const ctrl = new AbortController()
    const e = await fail(
      provider.fetchResult(remoteId, {
        signal: ctrl.signal,
        onProgress: (p) => {
          if (p.received >= 8_192) ctrl.abort()
        },
      }),
    )
    expect(e.code).toBe('aborted')
    expect(sv.state.closed).toHaveLength(1)
  })

  it('bigger than SanoVids takes → too-large; a cut while offline with nothing received → deferred; with bytes → a counted failure', async () => {
    const big = await completed()
    big.sv.state.openFailure = { ok: false, code: 'too-large', message: 'x' }
    expect(isResultTooLarge(await fail(big.provider.fetchResult(big.remoteId)))).toBe(true)
    const cut = await completed({ fake: { videoBytes: 20_000 } })
    cut.sv.state.readFailure = { failure: { ok: false, code: 'network', message: 'x' }, afterBytes: 0 }
    cut.sv.state.online = () => true
    let calls = 0
    const onlineThenOff = () => ++calls <= 1
    cut.sv.state.online = onlineThenOff
    expect(isResultDeferred(await fail(cut.provider.fetchResult(cut.remoteId)))).toBe(true)
    const late = await completed({ fake: { videoBytes: 20_000 } })
    late.sv.state.readFailure = { failure: { ok: false, code: 'network', message: 'x' }, afterBytes: 8_192 }
    const e = await fail(late.provider.fetchResult(late.remoteId))
    expect(isResultDeferred(e)).toBe(false)
    expect(e.code).toBe('network')
  })

  it('a 401 on the GET → login-required', async () => {
    const { provider, sv, remoteId } = await completed()
    sv.state.getScript.set(remoteId, [{ status: 401 }])
    expect(await fail(provider.fetchResult(remoteId))).toMatchObject({ code: 'login-required' })
  })

  it('§6.8 rule 1: a cut while offline is not a try even after bytes arrived; a network failure before any byte is not one either', async () => {
    // bytes received, then the network went down
    const late = await completed({ fake: { videoBytes: 20_000 } })
    late.sv.state.readFailure = { failure: { ok: false, code: 'network', message: 'x' }, afterBytes: 8_192 }
    let n = 0
    late.sv.state.online = () => ++n <= 1
    expect(isResultDeferred(await fail(late.provider.fetchResult(late.remoteId)))).toBe(true)
    // nothing received while net.isOnline() still says yes (a captive portal, the ISP down)
    const early = await completed({ fake: { videoBytes: 20_000 } })
    early.sv.state.readFailure = { failure: { ok: false, code: 'network', message: 'x' }, afterBytes: 0 }
    expect(isResultDeferred(await fail(early.provider.fetchResult(early.remoteId)))).toBe(true)
    // a timeout after bytes while online stays a counted failure
    const slow = await completed({ fake: { videoBytes: 20_000 } })
    slow.sv.state.readFailure = { failure: { ok: false, code: 'timeout', message: 'x' }, afterBytes: 8_192 }
    expect(isResultDeferred(await fail(slow.provider.fetchResult(slow.remoteId)))).toBe(false)
  })
})

describe('cancel → CancelOutcome (§6.3, §7.5)', () => {
  it('queued → refunded: recorded final, the poll says cancelled without asking', async () => {
    const { provider, sv } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    expect(await provider.cancel(remoteId)).toBe('refunded')
    const gets = sv.gets().length
    expect((await provider.poll([remoteId]))[0]).toMatchObject({ state: 'cancelled', code: 'cancelled' })
    expect(sv.gets().length).toBe(gets)
  })

  it.each<[string, Parameters<typeof setup>[0], (sv: ReturnType<typeof setup>['sv'], id: string) => void, string]>([
    ['200 partial with running outputs → running', {}, (sv) => sv.state.cancelScript.push({ status: 200, json: { data: { cancellation: { outcome: 'partial', running_outputs: 1 } } } }), 'running'],
    ['409 not_cancellable, job processing → running', {}, (sv, id) => void (sv.state.jobs.get(id)!.status = 'processing'), 'running'],
    ['409 not_cancellable, job completed → finished', {}, (sv, id) => void (sv.state.jobs.get(id)!.status = 'completed'), 'finished'],
    ['a bridge failure → unknown', {}, (sv) => sv.state.cancelScript.push({ fail: 'network' }), 'unknown'],
  ])('%s', async (_, o, arrange, outcome) => {
    const s = setup(o)
    const { remoteId } = await s.provider.submit(seedvisReq())
    s.sv.state.autoAdvance = false
    arrange(s.sv, remoteId)
    expect(await s.provider.cancel(remoteId)).toBe(outcome)
  })

  it('409 + Retry-After: 2 → waits 2 s and tries once more', async () => {
    const { provider, sv, clock } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.cancelScript.push({ status: 409, json: { error: { code: 'cancel_in_progress' } }, headers: { 'Retry-After': '2' } })
    const t = clock.now()
    expect(await provider.cancel(remoteId)).toBe('refunded')
    expect(clock.now() - t).toBe(2_000)
  })

  it('503 cancel_unavailable: retried ≤ 3 times by Retry-After, then unknown', async () => {
    const { provider, sv } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    for (let i = 0; i < 4; i++) sv.state.cancelScript.push({ status: 503, json: { error: { code: 'cancel_unavailable' } }, headers: { 'Retry-After': '1' } })
    expect(await provider.cancel(remoteId)).toBe('unknown')
    expect(sv.state.calls.filter((c) => c.route === 'generations.cancel')).toHaveLength(4)
    const s2 = setup()
    const r2 = (await s2.provider.submit(seedvisReq())).remoteId
    s2.sv.state.cancelScript.push({ status: 503, json: { error: { code: 'cancel_unavailable' } } }, { status: 503, json: { error: { code: 'cancel_unavailable' } } })
    expect(await s2.provider.cancel(r2)).toBe('refunded')
  })

  it('§6.4 b: a take that disappeared (isGone) while its POST was in flight → the job is recorded as an orphan; the cancel outcome is kept', async () => {
    const { provider } = setup()
    let n = 0
    // not cancelled before the POST (3 checks), deleted (gone) by the time the answer came
    const { remoteId } = await provider.submit(seedvisReq(), { isCancelled: () => ++n > 3, isGone: () => n >= 3 })
    expect(provider.orphans()).toEqual([{ key: seedvisIdempotencyKey('take-1'), remoteId, at: expect.any(Number), outcome: null }])
    await provider.cancel(remoteId)
    expect(provider.orphans()[0].outcome).toBe('refunded')
  })

  it('§6.4 b: a take merely cancelled, or whose scene was deleted (the take is kept), is never an orphan — the engine still has it', async () => {
    const { provider } = setup()
    for (const takeId of ['cancelled-take', 'scene-deleted']) {
      let n = 0
      const { remoteId } = await provider.submit(seedvisReq({ key: takeId, takeId }), { isCancelled: () => ++n > 3, isGone: () => false })
      expect(remoteId).toMatch(/^gen_/)
    }
    // no isGone at all: never an orphan either
    let m = 0
    await provider.submit(seedvisReq({ key: 'no-isgone', takeId: 'no-isgone' }), { isCancelled: () => ++m > 3 })
    expect(provider.orphans()).toEqual([])
  })
})

describe('concurrency, deferral back-off, limits, availability', () => {
  it('concurrency(): 2 until /account/info is read, then min(10, concurrency_limit) (M15)', async () => {
    const { provider, sv } = setup()
    expect(provider.concurrency()).toBe(2)
    await provider.refreshAccount()
    expect(provider.concurrency()).toBe(4)
    provider.noteAccountInfo({ concurrency_limit: 25 })
    expect(provider.concurrency()).toBe(10)
    provider.noteAccountInfo({ concurrency_limit: 0 })
    expect(provider.concurrency()).toBe(2)
    expect(provider.capabilities('seedvis/veo_3.1')).toMatchObject({ model: 'seedvis/veo_3.1', maxRefImages: 3, durations: [4, 6, 8], maxConcurrency: 2, pollIntervalMs: MIN_POLL_MS })
    void sv
  })

  it('concurrency() reads /account/info by itself once when stale (autoAccount)', async () => {
    const { provider, sv } = setup({ autoAccount: true })
    provider.concurrency()
    provider.concurrency()
    await new Promise((r) => setTimeout(r, 0))
    expect(sv.state.calls.filter((c) => c.route === 'account.info')).toHaveLength(1)
    expect(provider.concurrency()).toBe(4)
  })

  it('deferDelayMs: 15 → 30 → 60 → 120 → 300 s; a recent Retry-After stretches it', () => {
    const { provider } = setup()
    expect([1, 2, 3, 4, 5, 9].map((n) => provider.deferDelayMs(n))).toEqual([15_000, 30_000, 60_000, 120_000, 300_000, 300_000])
    expect(provider.deferDelayMs(1, 45_000)).toBe(45_000)
  })

  it('/models feeds settingsLimits (source server, firm while fresh); without the parser nothing is limited', async () => {
    const clock = fakeClock()
    const sv = createFakeSeedvis({ clock })
    const p = createSeedvisProvider({
      bridge: sv.bridge,
      words: fakeWords,
      prepare: fakePrepare().prepare,
      now: clock.now,
      sleep: clock.sleep,
      storage: memoryStorage(),
      autoAccount: false,
      limitsFromModels: () => (s) => (s.duration > 10 ? [{ field: 'duration', reason: 'Quá dài.' }] : []),
    })
    expect(p.settingsLimits().source).toBe('none')
    expect(await p.refreshLimits()).toBe('read')
    const lim = p.settingsLimits()
    expect(lim).toMatchObject({ source: 'server', firm: true })
    expect(lim.issues({ duration: 15 } as never)).toEqual([{ field: 'duration', reason: 'Quá dài.' }])
    expect(p.settingsLimits()).toBe(lim)
    expect(await p.refreshLimits()).toBe('fresh')
    clock.advance(11 * 60_000)
    expect(p.settingsLimits().firm).toBe(false)
    const { provider } = setup()
    expect(provider.settingsLimits().source).toBe('none')
  })
})

describe('prepared bytes and pins (§9, M28)', () => {
  it('kept (originals pinned) only while a same-key re-send is possible; released on success / when the window closes', async () => {
    const { provider, sv, clock, released } = setup({ memory: 600_000, fake: { answerWaitMs: 1_000 }, prepIds: true })
    sv.state.createFaults.push('lost-before-store', 'lost-before-store', 'lost-before-store', 'lost-before-store')
    await fail(provider.submit(seedvisReq({ images: images(2) })))
    expect(provider.pinnedImageIds().sort()).toEqual(['img-1', 'img-2'])
    // the window closes: the sweep releases the copies and the pins
    clock.advance(20 * 60_000)
    provider.sweepPrep()
    expect(provider.pinnedImageIds()).toEqual([])
    expect(released).toEqual([['prep-copy-1']])
  })

  it('a successful re-send releases them at once', async () => {
    const { provider, sv, released } = setup({ memory: 600_000, fake: { answerWaitMs: 1_000 }, prepIds: true })
    sv.state.createFaults.push('lost-before-store')
    await provider.submit(seedvisReq({ images: images(1) }))
    expect(provider.pinnedImageIds()).toEqual([])
    expect(released).toEqual([['prep-copy-1']])
  })
})

describe('no secret, no URL anywhere (S3, S10)', () => {
  it('the ledger and the diagnostics never hold a URL (seedvis answers carry signed CDN links) or a key', async () => {
    const { provider, sv, storage, clock } = setup()
    sv.state.createFaults.push('lost-after-store')
    const { remoteId } = await provider.submit(seedvisReq({ images: images(1) }))
    sv.state.jobs.get(remoteId)!.status = 'completed'
    await provider.poll([remoteId])
    clock.advance(30_000)
    await provider.fetchResult(remoteId)
    const all = `${storage.get(SEEDVIS_LEDGER_KEY)}\n${JSON.stringify(provider.diagnostics('take-1'))}`
    expect(all).not.toMatch(/https?:|SECRETSIG|sv_live|Bearer/)
    expect(provider.diagnostics('take-1')).toMatchObject({ idempotencyKey: seedvisIdempotencyKey('take-1'), remoteId, requestId: 'req_2', keyHint: '…AB12' })
  })
})

describe('a same-key POST goes out only under the API key that sent the first one (seedvis scopes keys per account)', () => {
  it('"Chạy lại" after the user pasted another account\'s key: no POST (that account would bill a second job); the original key back → the same job', async () => {
    const { provider, sv, clock } = setup({ memory: 600_000, fake: { answerWaitMs: 1_000 } })
    sv.state.createFaults.push('lost-after-store', 'lost-after-store', 'lost-after-store', 'lost-after-store')
    const e = await fail(provider.submit(seedvisReq()))
    expect(isSubmitUncertain(e) && !isSubmitUnverifiable(e)).toBe(true)
    expect(sv.creates()).toHaveLength(4)
    expect(provider.sameKeyRetry('take-1').reason).toBe('ok')
    sv.state.keyStatus = OTHER_KEY
    const e2 = await fail(provider.submit(seedvisReq(), { retryOfUnknown: true }))
    expect(isSubmitUncertain(e2)).toBe(true)
    expect(e2.detail).toBe('D:key-changed')
    expect(sv.creates()).toHaveLength(4)
    // the engine's immediate dispatch / countdown never offers it while that key is saved
    expect(provider.sameKeyRetry('take-1')).toEqual({ safeUntil: null, reason: 'key-changed' })
    // no key saved at all: the same
    sv.state.keyStatus = { ...OK_KEY, hasKey: false, hint: null, tag: null }
    expect((await fail(provider.submit(seedvisReq(), { retryOfUnknown: true }))).detail).toBe('D:key-changed')
    // a key that cannot be read right now proves nothing either
    sv.state.keyStatus = { ...OK_KEY, hasKey: false, hint: null, tag: null, problem: 'unreadable' }
    expect((await fail(provider.submit(seedvisReq(), { retryOfUnknown: true }))).detail).toBe('D:key-unknown')
    expect(sv.creates()).toHaveLength(4)
    // the key that sent it is back, still inside the window: the same key, the same job, 0 duplicates
    sv.state.keyStatus = OK_KEY
    clock.advance(1_000)
    const { remoteId } = await provider.submit(seedvisReq(), { retryOfUnknown: true })
    expect(remoteId).toBe(sv.jobOf(seedvisIdempotencyKey('take-1'))!.id)
    expect(sv.creates()).toHaveLength(5)
    expect(sv.duplicates()).toBe(0)
    expect(provider.diagnostics('take-1').keyHint).toBe('…AB12')
  })

  it('a key swapped during the automatic +15 / +45 / +90 s re-sends stops them at once: no POST under the other key, 0 duplicate jobs', async () => {
    const { provider, sv } = setup()
    sv.state.createFaults.push('lost-after-store')
    // the user pastes another account's key while SanoVids waits to re-send
    sv.state.online = () => {
      sv.state.keyStatus = OTHER_KEY
      return true
    }
    const e = await fail(provider.submit(seedvisReq()))
    expect(isSubmitUncertain(e)).toBe(true)
    expect(e.detail).toBe('D:key-changed')
    expect(sv.creates()).toHaveLength(1)
    expect(sv.duplicates()).toBe(0)
  })

  it('the key that sent the first POST was never identified (its status unreadable then): never re-sent — unverifiable at once, no wait', async () => {
    const { provider, sv, notes } = setup()
    sv.state.keyStatus = null // the bridge cannot say which key is saved
    sv.state.createFaults.push('lost-after-store')
    const e = await fail(provider.submit(seedvisReq()))
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(e.detail).toBe('D:key-unknown')
    expect(notes.filter(([, n]) => n === 'D:resending')).toEqual([])
    sv.state.keyStatus = OK_KEY
    expect(await provider.available()).toEqual({ ok: true })
    expect(provider.sameKeyRetry('take-1')).toEqual({ safeUntil: null, reason: 'key-changed' })
    expect(isSubmitUnverifiable(await fail(provider.submit(seedvisReq(), { retryOfUnknown: true })))).toBe(true)
    expect(sv.creates()).toHaveLength(1)
  })

  it('property: lost answers, retries and key swaps at any moment against a per-account server never create a second job', async () => {
    let seed = 0x5a17c0de
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const faults: CreateFault[] = ['ok', 'lost-after-store', 'lost-before-store', { status: 502 }, { fail: 'timeout', sent: true, store: true }]
    const keys = [OK_KEY, OTHER_KEY, { ...OK_KEY, hasKey: false, hint: null, tag: null }]
    for (let i = 0; i < 120; i++) {
      const { provider, sv, clock } = setup({ memory: 600_000, fake: { answerWaitMs: 1_000 + rnd() * 30_000 } })
      for (let f = 0; f < 6; f++) sv.state.createFaults.push(faults[Math.floor(rnd() * faults.length)])
      sv.state.online = () => {
        if (rnd() < 0.3) sv.state.keyStatus = keys[Math.floor(rnd() * keys.length)]
        return true
      }
      const req = seedvisReq()
      const first = await provider.submit(req).then(
        () => null,
        (x: unknown) => x,
      )
      for (let r = 0; first && r < 3; r++) {
        clock.advance(Math.floor(rnd() * 60_000))
        sv.state.keyStatus = keys[Math.floor(rnd() * keys.length)]
        await provider.submit(req, { retryOfUnknown: true }).catch(() => null)
      }
      expect(sv.duplicates(), `scenario ${i}`).toBe(0)
    }
  }, 60_000)
})

describe('M6: once something may have reached seedvis, a missing bridge is "maybe billed"', () => {
  it('development mode locked after a lost answer → uncertain (gate open) / unverifiable (gate closed), never a plain "unavailable"', async () => {
    const clock = fakeClock()
    const sv = createFakeSeedvis({ clock, keyMemoryMs: 600_000, answerWaitMs: 1_000 })
    let on = true
    const mk = (memory: number | null) =>
      createSeedvisProvider({ bridge: () => (on ? sv.bridge : null), words: fakeWords, prepare: fakePrepare().prepare, now: clock.now, monotonic: clock.mono, sleep: clock.sleep, keyMemoryMs: memory, storage: memoryStorage(), autoAccount: false })
    const p = mk(600_000)
    sv.state.createFaults.push('lost-before-store', 'lost-before-store', 'lost-before-store', 'lost-before-store')
    await fail(p.submit(seedvisReq()))
    on = false
    const e = await fail(p.submit(seedvisReq(), { retryOfUnknown: true }))
    expect(e.code).toBe('uncertain')
    expect(isSubmitUncertain(e) && !isSubmitUnverifiable(e)).toBe(true)
    expect(sv.creates()).toHaveLength(4)
    // shipped default (gate disabled): unverifiable, decided before the bridge
    on = true
    const q = mk(null)
    sv.state.createFaults.push('lost-after-store')
    await fail(q.submit(seedvisReq({ key: 'b', takeId: 'b' })))
    on = false
    expect(isSubmitUnverifiable(await fail(q.submit(seedvisReq({ key: 'b', takeId: 'b' }), { retryOfUnknown: true })))).toBe(true)
    // nothing was ever sent for this one: a plain "unavailable"
    expect((await fail(q.submit(seedvisReq({ key: 'c', takeId: 'c' })))).code).toBe('unavailable')
  })
})

describe('the gate on a monotonic clock within a session (wall-clock steps)', () => {
  async function uncertainTake(memory: number) {
    const s = setup({ memory, fake: { answerWaitMs: 1_000 } })
    s.sv.state.createFaults.push('lost-before-store', 'lost-before-store', 'lost-before-store', 'lost-before-store')
    const e = await fail(s.provider.submit(seedvisReq()))
    expect(isSubmitUncertain(e) && !isSubmitUnverifiable(e)).toBe(true)
    return { ...s, first: s.sv.creates()[0].at }
  }

  it('a backward step smaller than the elapsed time cannot stretch the window (real 110 s, the clock stepped back 15 s → closed)', async () => {
    const { provider, sv, clock, first } = await uncertainTake(120_000)
    expect(provider.sameKeyRetry('take-1').reason).toBe('ok')
    clock.set(first + 110_000)
    clock.step(-15_000)
    expect(clock.now() - first).toBe(95_000) // the wall clock alone would still allow a re-send (95 + 2 + 20 ≤ 120 s)
    const r = provider.sameKeyRetry('take-1')
    expect(r.reason).toBe('expired')
    expect(r.safeUntil!).toBeLessThan(clock.now())
    const e = await fail(provider.submit(seedvisReq(), { retryOfUnknown: true }))
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(sv.creates()).toHaveLength(4)
  })

  it('mustFinishBy is given on the wall clock main enforces: after a backward step it moves earlier by that step', async () => {
    const { provider, sv, clock, first } = await uncertainTake(600_000)
    clock.step(-15_000)
    await provider.submit(seedvisReq(), { retryOfUnknown: true })
    expect(sv.creates()).toHaveLength(5)
    expect(sv.creates()[4].mustFinishBy).toBe(first + 600_000 - 20_000 - 15_000)
  })

  it('after a restart (no monotonic reference) a wall clock before the first POST closes the gate; sameKeyRetry offers no moment (safeUntil null)', async () => {
    const storage = memoryStorage()
    const clock = fakeClock()
    const sv = createFakeSeedvis({ clock, keyMemoryMs: 600_000, answerWaitMs: 1_000 })
    const mk = () => createSeedvisProvider({ bridge: sv.bridge, words: fakeWords, prepare: fakePrepare().prepare, now: clock.now, monotonic: clock.mono, sleep: clock.sleep, keyMemoryMs: 600_000, storage, autoAccount: false })
    sv.state.createFaults.push('lost-before-store', 'lost-before-store', 'lost-before-store', 'lost-before-store')
    await fail(mk().submit(seedvisReq()))
    const first = sv.creates()[0].at
    clock.step(first - clock.now() - 60_000)
    const after = mk()
    expect(after.sameKeyRetry('take-1')).toEqual({ safeUntil: null, reason: 'expired' })
    const e = await fail(after.submit(seedvisReq(), { retryOfUnknown: true }))
    expect(e).toMatchObject({ detail: 'D:clock' })
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(sv.creates()).toHaveLength(4)
  })
})

describe('key memory counted from the request: seedvis may store the key as the request arrives', () => {
  // 54 s first upload at 20 kB/s, the answer lost 1 s after the last byte, a server that stores the key when the
  // request starts arriving and forgets it 120 s later.
  const slowServer = { blobs: { 'img-1': 810_000 }, fake: { bandwidthBps: 20_000, answerWaitMs: 1_000, keyStoredAt: 'request' as const } }

  it('measured from the last byte, the +15 s re-send would arrive after the server forgot the key → a second, billed job', async () => {
    const { provider, sv } = setup({ ...slowServer, keyMemoryFrom: 'last-byte' })
    sv.state.createFaults.push('lost-after-store')
    await provider.submit(seedvisReq({ images: images(1) })).catch(() => null)
    expect(sv.creates()).toHaveLength(2)
    expect(sv.duplicates()).toBe(1)
  })

  it('measured from the request (the default): no re-send fits — unverifiable, one POST, 0 duplicates', async () => {
    const { provider, sv } = setup(slowServer)
    sv.state.createFaults.push('lost-after-store')
    const e = await fail(provider.submit(seedvisReq({ images: images(1) })))
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(e.detail).toBe('D:gate-expired')
    expect(sv.creates()).toHaveLength(1)
    expect(sv.duplicates()).toBe(0)
  })
})

describe('job ids in a create answer', () => {
  it('a numeric job id in a 2xx is the job (its decimal string), never "maybe billed"', async () => {
    const { provider, sv } = setup({ memory: null })
    sv.state.createFaults.push({ status: 202, json: { data: { id: 123456, status: 'queued' } } })
    expect(await provider.submit(seedvisReq())).toEqual({ remoteId: '123456' })
    expect(parseGeneration({ data: { id: 42 } })?.id).toBe('42')
    expect(parseGeneration({ data: { id: -1 } })?.id).toBeNull()
    expect(parseGeneration({ data: { id: 1.5 } })?.id).toBeNull()
    expect(parseGeneration({ data: { id: 2 ** 60 } })?.id).toBeNull()
  })

  it('a 2xx without a usable id: seedvis created it — its own detail (check the history, do not create again), the answer shape logged without values', async () => {
    const { provider, sv, logs } = setup({ memory: null })
    sv.state.createFaults.push({ status: 202, json: { data: { status: 'queued', url: 'https://cdn.seedvis.com/x.mp4?sig=SECRETSIG' } } })
    const e = await fail(provider.submit(seedvisReq()))
    expect(isSubmitUnverifiable(e)).toBe(true)
    expect(e.detail).toBe('D:created-no-id')
    expect(logs.find((l) => l.includes('without a usable job id'))).toContain('data.id=missing keys=[status,url]')
    expect(logs.join('\n')).not.toMatch(/https?:|SECRETSIG/)
  })
})

describe('cancel says "refunded" only on evidence', () => {
  it('a 2xx without a body proves nothing: the job is read — still queued → "unknown", nothing remembered, the poll keeps asking', async () => {
    const { provider, sv } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.autoAdvance = false
    sv.state.cancelScript.push({ status: 200 })
    expect(await provider.cancel(remoteId)).toBe('unknown')
    expect(provider.openJobs()).toHaveLength(1)
    const gets = sv.gets().length
    expect((await provider.poll([remoteId]))[0].state).toBe('queued')
    expect(sv.gets().length).toBe(gets + 1)
  })

  it('a 2xx without a body, the job read shows failed + cancelled → refunded (remembered)', async () => {
    const { provider, sv } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    Object.assign(sv.state.jobs.get(remoteId)!, { status: 'failed', errorCode: 'cancelled' })
    sv.state.cancelScript.push({ status: 200, json: {} })
    expect(await provider.cancel(remoteId)).toBe('refunded')
    expect(provider.openJobs()).toEqual([])
  })

  it.each<[string, unknown, string]>([
    ['a body showing the job completed', { data: { status: 'completed' } }, 'finished'],
    ['a body showing failed + cancelled', { data: { status: 'failed', error: { code: 'cancelled' } } }, 'refunded'],
    ['a refunded cancellation outcome', { data: { cancellation: { outcome: 'refunded', running_outputs: 0 } } }, 'refunded'],
    ['a body showing the job still processing (job still processing)', { data: { status: 'processing' } }, 'unknown'],
    ['an unknown cancellation outcome (job still processing)', { data: { cancellation: { outcome: 'pending' } } }, 'unknown'],
  ])('a 2xx with %s → %s', async (_, json, outcome) => {
    const { provider, sv } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.autoAdvance = false
    sv.state.jobs.get(remoteId)!.status = 'processing'
    sv.state.cancelScript.push({ status: 200, json })
    expect(await provider.cancel(remoteId)).toBe(outcome)
    expect(provider.openJobs().length).toBe(outcome === 'refunded' ? 0 : 1)
  })
})

describe('poll answers that must not end (or stop) paid takes', () => {
  it('a final answer with a status SanoVids does not know ("succeeded") keeps the take running and is never remembered', async () => {
    const { provider, sv, clock, logs } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.getScript.set(remoteId, [{ status: 200, json: { data: { id: remoteId, status: 'succeeded', is_final: true } } }])
    const [st] = await provider.poll([remoteId])
    expect(st).toMatchObject({ remoteId, state: 'processing', note: 'P:unknown-final succeeded' })
    expect(provider.openJobs()).toHaveLength(1)
    expect(logs.filter((l) => l.includes('unknown status "succeeded"'))).toHaveLength(1)
    clock.advance(MIN_POLL_MS)
    sv.state.jobs.get(remoteId)!.status = 'completed'
    expect((await provider.poll([remoteId]))[0].state).toBe('completed')
  })

  it.each(['cancelled', 'canceled'])('a plain "%s" status → the cancelled (refunded) outcome, remembered', async (status) => {
    const { provider, sv } = setup()
    const { remoteId } = await provider.submit(seedvisReq())
    sv.state.getScript.set(remoteId, [{ status: 200, json: { data: { id: remoteId, status, is_final: true } } }])
    expect((await provider.poll([remoteId]))[0]).toMatchObject({ state: 'cancelled', code: 'cancelled', error: 'P:cancelled-refunded' })
    expect(provider.openJobs()).toEqual([])
  })

  it('403 on one job while another answers: that job keeps running with a note (asked again later), polling goes on; 403 on every job → login-required', async () => {
    const { provider, sv, clock } = setup()
    const a = (await provider.submit(seedvisReq())).remoteId
    const b = (await provider.submit(seedvisReq({ key: 'take-2', takeId: 'take-2' }))).remoteId
    sv.state.getScript.set(a, [{ status: 403, json: { error: { code: 'forbidden' } } }])
    const out = await provider.poll([a, b])
    expect(out.find((s) => s.remoteId === a)).toEqual({ remoteId: a, state: 'processing', note: 'P:forbidden' })
    expect(out.find((s) => s.remoteId === b)?.state).toBe('queued')
    clock.advance(30_000)
    const asked = () => sv.gets().filter((g) => g.id === a).length
    const before = asked()
    await provider.poll([a, b])
    expect(asked()).toBe(before) // not due yet
    clock.advance(FORBIDDEN_RETRY_MS)
    await provider.poll([a, b])
    expect(asked()).toBe(before + 1)
    clock.advance(FORBIDDEN_RETRY_MS)
    sv.state.getScript.set(a, [{ status: 403 }])
    sv.state.getScript.set(b, [{ status: 403 }])
    expect(await fail(provider.poll([a, b]))).toMatchObject({ code: 'login-required', status: 403 })
    clock.advance(FORBIDDEN_RETRY_MS)
    sv.state.getScript.set(a, [{ status: 401 }])
    expect(await fail(provider.poll([a, b]))).toMatchObject({ code: 'login-required', status: 401 })
  })
})

describe('the money ledger needs a real storage', () => {
  it('no silent in-memory default: building the provider without one throws', () => {
    const clock = fakeClock()
    const sv = createFakeSeedvis({ clock })
    expect(() => createSeedvisProvider({ bridge: sv.bridge, words: fakeWords, prepare: fakePrepare().prepare, storage: undefined as unknown as KeyValueStorage })).toThrow(/storage/)
  })
})

// Compile-time: the adapter already fits VideoProvider as track B1 will widen it (§5.2) — only the members whose
// types B1 changes are left out here (id / model unions, submit / recover request type, cancel's outcome).
type FutureVideoProvider = Omit<VideoProvider, 'id' | 'capabilities' | 'submit' | 'recover' | 'cancel'> & ProviderContractExt
const _fits: FutureVideoProvider = null as unknown as SeedvisProvider
void _fits

describe('classifyCreate — what one answer proves', () => {
  const ok = (status: number, json?: unknown, headers: Record<string, string> = {}) => ({ ok: true as const, status, json, headers })
  it.each<[string, Parameters<typeof classifyCreate>[0], string]>([
    ['202 with id', ok(202, { data: { id: 'gen_1', status: 'queued' } }), 'created'],
    ['200 replayed', ok(200, { data: { id: 'gen_1', status: 'processing' } }, { 'Idempotency-Replayed': 'true' }), 'created'],
    ['flat body with id', ok(200, { id: 'gen_1', status: 'queued' }), 'created'],
    ['202 failed job', ok(202, { data: { id: 'gen_1', status: 'failed', error: { code: 'insufficient_credits' } } }), 'failed-final'],
    ['2xx no id', ok(202, { data: {} }), 'lost'],
    ['2xx bad id', ok(202, { data: { id: '../x' } }), 'lost'],
    ['409', ok(409, { error: { code: 'idempotency_conflict' } }), 'conflict'],
    ['401', ok(401), 'refused'],
    ['429', ok(429), 'busy'],
    ['503 busy', ok(503, { error: { code: 'server_busy' } }), 'busy'],
    ['503 maintenance (model)', ok(503, { error: { code: 'model_maintenance' } }), 'refused'],
    ['503 html', ok(503), 'lost'],
    ['500 server_error', ok(500, { error: { code: 'server_error' } }), 'lost'],
    ['504 timeout', ok(504, { error: { code: 'timeout' } }), 'lost'],
    ['422 slots by message', ok(422, { error: { message: 'All concurrency slots are busy' } }), 'busy'],
    ['422 field error', ok(422, { errors: { 'referenceImages[3]': ['too many'] } }), 'refused'],
    // seedvis answers "slots + queue full" as validation_error too: only a message naming both limits tells it apart
    // (the same rule as mapping.errorOf SLOTS_FULL; the simulation's SEEDVIS_SLOTS_FULL_MESSAGE)
    ['422 validation_error, streams + queue full', ok(422, { success: false, status: 422, code: 'validation_error', message: 'Concurrency + queue limit reached: all streams of your plan are busy and the queue is full.' }), 'busy'],
    ['422 validation_error naming slots only', ok(422, { success: false, status: 422, code: 'validation_error', message: 'too many slots in reference_images' }), 'refused'],
    ['422 validation_error, both limits but keyed to a field', ok(422, { success: false, code: 'validation_error', message: 'Concurrency limit reached and queue is full', errors: { prompt: ['x'] } }), 'refused'],
    ['404 html', ok(404), 'busy'],
    ['404 model', ok(404, { error: { code: 'model_not_found' } }), 'refused'],
    ['400', ok(400, { error: { code: 'invalid_value' } }), 'refused'],
    ['302', ok(302), 'lost'],
    ['network sent:true', { ok: false, code: 'network', message: '', sent: true }, 'lost'],
    ['network sent unknown', { ok: false, code: 'network', message: '' }, 'lost'],
    ['timeout sent:false', { ok: false, code: 'timeout', message: '', sent: false }, 'not-sent'],
    ['deadline', { ok: false, code: 'deadline', message: '', sent: false }, 'not-sent'],
    ['rate-limited (local)', { ok: false, code: 'rate-limited', message: '' }, 'busy'],
    ['rate-limited but sent', { ok: false, code: 'rate-limited', message: '', sent: true }, 'lost'],
    ['no-key', { ok: false, code: 'no-key', message: '' }, 'not-sent'],
    ['local idempotency conflict', { ok: false, code: 'idempotency-conflict', message: '' }, 'conflict'],
    ['bad-response, sent unknown', { ok: false, code: 'bad-response', message: '' }, 'lost'],
  ])('%s → %s', (_, res, kind) => {
    expect(classifyCreate(res).kind).toBe(kind)
  })
})
