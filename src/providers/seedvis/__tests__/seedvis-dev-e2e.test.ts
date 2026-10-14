// seedvis adapter end to end on the strict simulated seedvis (track A-SIM: providers/dev/seedvis/{server,bridge,
// validate,routes,state,faults,render}.ts) — plan §16.2 / §17.5 row A2: the §7 money paths and the §11.1 faults,
// driven on the adapter directly. The provider is built like index.ts seedvisProviderFor('seedvis-dev') will be (B2):
// the A-SIM bridge over a memory state, the real A-MAP request mapping (mapping.toGenerationBody / toRequestImages,
// mapping.echoCheck), the sim clock as now / sleep / monotonic, an explicit memory storage. Words are the adapter's fake
// words (the real wording.ts adapter is B2's): these tests assert codes, never texts.
// "0 duplicate jobs" = no Idempotency-Key with two jobs on the simulated server (any account).
// Cases still `it.todo` name the exact reason: the engine wiring (B2), or a fault the simulation cannot produce (then the
// adapter unit test seedvis-adapter.test.ts covers it on its scripted fake).
import { afterEach, describe, expect, it } from 'vitest'
import { isResultDeferred, isSubmitCancelled, isSubmitDeferred, isSubmitUncertain, isSubmitUnverifiable } from '../../types'
import { applyDevAccessState, bareState } from '../../devAccess'
import { createSeedvisProvider, type SeedvisPrepared } from '../adapter'
import { SeedvisError } from '../errors'
import { isResultExpired, isResultHeld, type SeedvisJobRequest } from '../contractExt'
import { memoryStorage, SEEDVIS_DEV_LEDGER_KEY, SEEDVIS_LEDGER_KEY, type KeyValueStorage } from '../ledger'
import { echoCheck, toGenerationBody, toRequestImages, type GenerationInput } from '../mapping'
import type { SeedvisBridge } from '../contract'
import { createDevSeedvisBridge } from '../../dev/seedvis/bridge'
import { createDevSeedvis } from '../../dev/seedvis/server'
import { initialSeedvisState, memorySeedvisStore, SEEDVIS_DEV_KEYS, type SeedvisDevConfig } from '../../dev/seedvis/state'
import { SEEDVIS_FAULT_PRESETS, type SeedvisFaultInput } from '../../dev/seedvis/faults'
import { fakeClock, fakeWords, images, seedvisReq } from './seedvisFakes'

const MiB = 1024 * 1024

/** Deterministic PNG-signed bytes of an image id (the simulation sniffs the signature; nothing decodes pixels). */
function pngOf(imageId: string, size = 64): Uint8Array {
  const b = new Uint8Array(size)
  for (let i = 8; i < size; i++) b[i] = (i * 31 + imageId.charCodeAt(i % imageId.length)) % 256
  b.set([137, 80, 78, 71, 13, 10, 26, 10])
  return b
}

/** The real A-MAP mapping: images in @image_N order, frames (first, last) in the frame modes. */
function simPrepare(sizes: Record<string, number> = {}) {
  return async (req: SeedvisJobRequest): Promise<SeedvisPrepared> => {
    const frames = [req.firstFrame, req.lastFrame].filter((f): f is NonNullable<typeof f> => !!f)
    const sources = req.mode === 'first' || req.mode === 'transform' ? frames : [...req.images].sort((a, b) => a.n - b.n)
    const input: GenerationInput = {
      model: req.model, mode: req.mode, duration: req.duration, resolution: req.resolution, ratio: req.ratio, prompt: req.prompt,
      images: sources.map((s) => ({ mime: 'image/png' as const, bytes: pngOf(s.imageId, sizes[s.imageId]) })),
    }
    return { body: toGenerationBody(input), images: toRequestImages(input), pinIds: sources.map((s) => s.imageId), prepIds: [] }
  }
}

/** mapping.echoCheck as the adapter's echo dep (what index.ts will pass): null = every sent image echoed. */
const echo = (p: SeedvisPrepared, refs: { field: string; index: number }[] | null) => {
  if (echoCheck(p.images, refs) === null) return null
  const got = new Set((refs ?? []).map((r) => `${r.field}:${r.index}`))
  return { received: p.images.filter((i) => got.has(`${i.field}:${i.index}`)).length, sent: p.images.length }
}

interface SimOptions {
  /** Key memory the adapter's gate assumes (default 120 s = the simulation's; null = the shipped default). */
  memory?: number | null
  config?: Partial<SeedvisDevConfig>
  storage?: KeyValueStorage
  sizes?: Record<string, number>
  /** Runs inside every simulated wait (the upload of a POST included). */
  onSleep?: () => void | Promise<void>
}

function sim(o: SimOptions = {}) {
  const clock = fakeClock()
  let onSleep = o.onSleep ?? null
  const server = createDevSeedvis({
    store: memorySeedvisStore(initialSeedvisState(clock.now())),
    now: clock.now,
    sleep: async (ms) => {
      await clock.sleep(ms)
      if (onSleep) await onSleep()
    },
  })
  const bridge = createDevSeedvisBridge(server)
  // runs once, right before the adapter's next "is the network up?" — i.e. before an automatic same-key re-send
  let beforeResend: (() => void | Promise<void>) | null = null
  const wrapped: SeedvisBridge = {
    ...bridge,
    isOnline: async () => {
      const f = beforeResend
      beforeResend = null
      if (f) await f()
      return bridge.isOnline()
    },
  }
  const storage = o.storage ?? memoryStorage()
  const logs: string[] = []
  const make = (store: KeyValueStorage = storage, memory: number | null = o.memory === undefined ? 120_000 : o.memory) =>
    createSeedvisProvider({
      id: 'seedvis-dev', bridge: wrapped, words: fakeWords, prepare: simPrepare(o.sizes), echo,
      now: clock.now, monotonic: clock.mono, sleep: clock.sleep, keyMemoryMs: memory, storage: store, autoAccount: false,
      log: (l) => void logs.push(l),
    })
  const provider = make()
  const state = async () => {
    const s = await server.snapshot()
    if (!s || !('jobs' in s)) throw new Error('no simulated state')
    return s
  }
  const h = {
    clock, server, bridge, provider, storage, logs, make,
    setup: async () => {
      if (o.config) expect(await server.configure(o.config)).toEqual({ ok: true })
      return h
    },
    fault: (f: SeedvisFaultInput) => {
      const r = server.addFault(f)
      if (!r.ok) throw new Error(`fault refused: ${JSON.stringify(f)}`)
    },
    preset: (id: string) => h.fault(SEEDVIS_FAULT_PRESETS.find((p) => p.id === id)!.rule),
    beforeResend: (f: () => void | Promise<void>) => void (beforeResend = f),
    onSleep: (f: (() => void | Promise<void>) | null) => void (onSleep = f),
    jobs: async () => (await state()).jobs,
    creates: async () => (await state()).logs.filter((l) => l.endpoint === 'generations.create'),
    gets: async () => (await state()).logs.filter((l) => l.endpoint === 'generations.get').length,
    balance: async (account: 'A001' | 'B002' = 'A001') => (await state()).balances[account],
    duplicates: async () => {
      const per = new Map<string, number>()
      for (const j of (await state()).jobs) per.set(j.idempotencyKey, (per.get(j.idempotencyKey) ?? 0) + 1)
      return [...per.values()].filter((n) => n > 1).length
    },
    /** Poll one job until it is final (each round past its pacing); returns every state seen. */
    pollUntilFinal: async (remoteId: string, stepMs = 20_000, rounds = 40) => {
      const seen: string[] = []
      for (let i = 0; i < rounds; i++) {
        const [st] = await provider.poll([remoteId])
        seen.push(st.state)
        if (st.state === 'completed' || st.state === 'failed' || st.state === 'cancelled') return { seen, last: st }
        clock.advance(stepMs)
      }
      return { seen, last: null }
    },
  }
  return h.setup()
}

const fail = async (p: Promise<unknown>): Promise<SeedvisError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  if (!(e instanceof SeedvisError)) throw new Error(`expected a SeedvisError, got ${String(e)}`)
  return e
}

const textReq = (over: Partial<SeedvisJobRequest> = {}) => seedvisReq({ prompt: 'Một chú mèo đi dạo', rawPrompt: 'Một chú mèo đi dạo', ...over })

afterEach(() => {
  applyDevAccessState(bareState('build'))
})

describe('seedvis-dev e2e — adapter on the A-SIM simulation (integration)', () => {
  describe('submit', () => {
    it('Seedance 2.5 text-to-video: 202 queued → queued (position, estimated start) → processing → completed → video downloaded', async () => {
      const h = await sim()
      expect(h.provider.id).toBe('seedvis-dev')
      const { remoteId } = await h.provider.submit(textReq())
      const [job] = await h.jobs()
      expect(job).toMatchObject({ id: remoteId, status: 'queued', body: { model: 'seedance_2.5', mode: 'text-to-video', duration: 5, aspect_ratio: '16:9', count: 1 } })
      const [first] = await h.provider.poll([remoteId])
      expect(first).toMatchObject({ state: 'queued', phase: 'queued', note: expect.stringMatching(/^P:queued 1 \d+$/) })
      const { last } = await h.pollUntilFinal(remoteId)
      expect(last).toMatchObject({ state: 'completed' })
      const result = await h.provider.fetchResult(remoteId)
      // the simulation answers application/octet-stream: the bridge sniffs the MP4 (never .webm)
      expect(result.video?.type).toBe('video/mp4')
      expect(result.video!.size).toBeGreaterThan(12)
      expect(await h.balance()).toBe(990)
      expect(await h.duplicates()).toBe(0)
    })
    it.todo('the take shows the badge "seedvis · DEV" — B3 (runs/shared ProviderBadge with the take of the engine; the adapter has no UI)')

    it('Seedance 2.0 Fast image-to-video with 3 images: reference_images in @image_N order, the sim echo matches, no note', async () => {
      const h = await sim()
      const req = seedvisReq({ model: 'seedvis/seedance_2.0_fast', prompt: '@image_1 @image_2 @image_3 đi dạo', images: [...images(3)].reverse() })
      const { remoteId } = await h.provider.submit(req)
      const [job] = await h.jobs()
      expect(job.body).toMatchObject({ model: 'seedance_2.0_fast', mode: 'image-to-video' })
      expect(job.references).toEqual([0, 1, 2].map((index) => ({ field: 'reference_images', index })))
      const [st] = await h.provider.poll([remoteId])
      expect(st.note).not.toMatch(/^P:echo/)
      expect(h.provider.diagnostics('take-1').echo).toBeUndefined()
    })

    it('Veo 3.1 all four modes: t2v / first (image) / i2v (referenceImages 1–3) / transform (image + lastFrame) — A-SIM validate accepts every body', async () => {
      const h = await sim()
      const veo = { model: 'seedvis/veo_3.1' as const, duration: 8, resolution: '1080p', ratio: '9:16' }
      const frame = (id: string) => ({ assetId: `asset-${id}`, imageId: id })
      await h.provider.submit(textReq({ ...veo, key: 'v1', takeId: 'v1', mode: 't2v' }))
      await h.provider.submit(textReq({ ...veo, key: 'v2', takeId: 'v2', mode: 'first', firstFrame: frame('f1') }))
      await h.provider.submit(seedvisReq({ ...veo, key: 'v3', takeId: 'v3', mode: 'i2v', prompt: '@image_1 @image_2 @image_3', images: images(3) }))
      await h.provider.submit(textReq({ ...veo, key: 'v4', takeId: 'v4', mode: 'transform', firstFrame: frame('f1'), lastFrame: frame('f2') }))
      const jobs = await h.jobs()
      expect(jobs.map((j) => j.body.mode)).toEqual(['text-to-video', 'image-to-video', 'multi-image-to-video', 'batch-frame'])
      expect(jobs.every((j) => j.body.model === 'Veo-3.1' && j.body.duration === '8s' && j.body.upscale_video === '1080p')).toBe(true)
      expect(jobs[3].references).toEqual([{ field: 'image', index: 0 }, { field: 'lastFrame', index: 0 }])
      expect(await h.balance()).toBe(960)
    })

    it('body is byte-identical before / after moveScene (scene-neutral file names): a same-key re-send is never answered 409', async () => {
      const h = await sim({ memory: 600_000, config: { keyMemoryMs: 600_000 } })
      h.fault({ endpoint: 'generations.create', fault: { kind: 'lost-response' }, times: 4 })
      const e = await fail(h.provider.submit(seedvisReq({ images: images(2), prompt: '@image_1 @image_2 đi dạo' })))
      expect(isSubmitUncertain(e) && !isSubmitUnverifiable(e)).toBe(true)
      // the scene moved / was renamed meanwhile: code, title, colour and scene id change — the body does not
      const moved = seedvisReq({ images: images(2), prompt: '@image_1 @image_2 đi dạo', sceneCode: 'S07', title: 'Cảnh đã dời', sceneId: 'scene-9', color: '#123456', takeNumber: 3 })
      const { remoteId } = await h.provider.submit(moved, { retryOfUnknown: true })
      const creates = await h.creates()
      expect(creates).toHaveLength(5)
      expect(creates.some((c) => c.status === 409)).toBe(false)
      expect((await h.jobs()).map((j) => j.id)).toEqual([remoteId])
      expect(await h.duplicates()).toBe(0)
    })

    it('202 then the job is created in the background: polls answer 404 for N polls after the 202, the take stays processing, then completes (M14, M22)', async () => {
      const h = await sim()
      h.preset('404') // 4 polls answer JSON generation_not_found
      const { remoteId } = await h.provider.submit(textReq())
      const { seen, last } = await h.pollUntilFinal(remoteId, 60_000)
      expect(seen.slice(0, 4)).toEqual(['processing', 'processing', 'processing', 'processing'])
      expect(seen).not.toContain('failed')
      expect(last).toMatchObject({ state: 'completed' })
    })

    it('lost answer after the job was created, key memory 120 s: the automatic +15 s re-send gets the same job (Idempotency-Replayed) — 0 duplicate jobs', async () => {
      const h = await sim()
      h.preset('lost')
      const { remoteId } = await h.provider.submit(textReq())
      const creates = await h.creates()
      expect(creates.map((c) => c.status)).toEqual(['network', 200])
      expect((await h.jobs()).map((j) => j.id)).toEqual([remoteId])
      expect(h.provider.diagnostics('take-1')).toMatchObject({ remoteId, attempts: '2', replayed: 'true' })
      expect(await h.balance()).toBe(990)
      expect(await h.duplicates()).toBe(0)
    })

    it('lost answer then 429 / 503 / 422 / 409 on the re-sends: uncertain, never deferred or refused (M6)', async () => {
      for (const [status, code] of [[429, 'rate_limit_exceeded'], [503, 'server_busy'], [422, 'validation_error'], [409, 'idempotency_conflict']] as const) {
        const h = await sim()
        h.preset('lost')
        h.fault({ endpoint: 'generations.create', fault: { kind: 'response', status, code, retryAfterSeconds: 1 }, times: 3 })
        const e = await fail(h.provider.submit(textReq()))
        expect(isSubmitUncertain(e), `${status}`).toBe(true)
        expect(isSubmitDeferred(e) || isSubmitCancelled(e), `${status}`).toBe(false)
        expect(await h.jobs(), `${status}`).toHaveLength(1)
        expect(await h.duplicates()).toBe(0)
      }
    })

    it('2 Mbps upload, 8 MiB body, lost answer: re-sends only while the gate holds — 0 duplicate jobs (M5)', async () => {
      const h = await sim({ sizes: { 'img-1': 6 * MiB } })
      h.preset('slow') // 2 Mbps, for the first upload
      h.preset('lost')
      const e = await fail(h.provider.submit(seedvisReq({ images: images(1) })))
      expect(isSubmitUncertain(e)).toBe(true)
      expect(await h.jobs()).toHaveLength(1)
      expect(await h.duplicates()).toBe(0)
      // the uploaded bytes stay bounded: never a re-send that could not arrive in time
      const sent = (await h.creates()).filter((c) => c.sent).length
      expect(sent).toBeLessThanOrEqual(2)
    })

    it('30 MiB body at 2 Mbps, lost answer, explicit "Chạy lại" at 1:30: refused by the gate (unverifiable), no POST — 0 duplicate jobs (M5)', async () => {
      const h = await sim({ sizes: { 'img-1': 7.4 * MiB, 'img-2': 7.4 * MiB, 'img-3': 7.4 * MiB } })
      h.fault({ endpoint: 'generations.create', fault: { kind: 'slow-upload', bytesPerSecond: 250_000 }, sticky: true })
      h.preset('lost')
      const req = seedvisReq({ images: images(3), prompt: '@image_1 @image_2 @image_3' })
      const t0 = h.clock.now()
      const e = await fail(h.provider.submit(req))
      expect(isSubmitUnverifiable(e)).toBe(true)
      const before = (await h.creates()).length
      h.clock.set(Math.max(h.clock.now(), t0 + 90_000))
      const e2 = await fail(h.provider.submit(req, { retryOfUnknown: true }))
      expect(isSubmitUnverifiable(e2)).toBe(true)
      expect(await h.creates()).toHaveLength(before)
      expect(before).toBe(1)
      expect(await h.duplicates()).toBe(0)
    })

    it('upload slows to a quarter during the re-send: the sim bridge aborts at mustFinishBy (deadline, sent:false) → unverifiable — 0 duplicate jobs (M5)', async () => {
      const h = await sim({ sizes: { 'img-1': 4 * MiB } })
      h.preset('lost')
      h.beforeResend(() => h.fault({ endpoint: 'generations.create', fault: { kind: 'slow-upload', bytesPerSecond: 62_500 }, sticky: true }))
      const e = await fail(h.provider.submit(seedvisReq({ images: images(1) })))
      expect(isSubmitUnverifiable(e)).toBe(true)
      expect((await h.creates()).map((c) => c.status)).toEqual(['network', 'deadline'])
      expect(await h.jobs()).toHaveLength(1)
      expect(await h.duplicates()).toBe(0)
    })

    it('key forgotten after N s (sim memory shorter than the gate assumes): documents why SEEDVIS_KEY_MEMORY_MS stays null until seedvis confirms in writing', async () => {
      // the adapter assumes 120 s, the server forgets after 10 s: the +15 s re-send creates — and bills — a second job
      const wrong = await sim({ config: { keyMemoryMs: 10_000 } })
      wrong.preset('lost')
      await wrong.provider.submit(textReq())
      expect(await wrong.duplicates()).toBe(1)
      expect(await wrong.balance()).toBe(980)
      // the shipped default never re-sends a key: one job, whatever the server remembers
      const shipped = await sim({ memory: null, config: { keyMemoryMs: 10_000 } })
      shipped.preset('lost')
      await fail(shipped.provider.submit(textReq()))
      expect(await shipped.duplicates()).toBe(0)
      expect(await shipped.creates()).toHaveLength(1)
    })

    it('SEEDVIS_KEY_MEMORY_MS = null (shipped): every lost answer is unverifiable at once — 0 same-key POSTs', async () => {
      const h = await sim({ memory: null })
      h.preset('lost')
      const e = await fail(h.provider.submit(textReq()))
      expect(isSubmitUnverifiable(e)).toBe(true)
      expect(e.detail).toBe('D:gate-disabled')
      expect(h.provider.sameKeyRetry('take-1')).toEqual({ safeUntil: null, reason: 'disabled' })
      expect(await fail(h.provider.submit(textReq(), { retryOfUnknown: true }))).toMatchObject({ unverifiable: true })
      expect(await h.creates()).toHaveLength(1)
      expect(await h.jobs()).toHaveLength(1)
    })

    it('explicit retry in the window with the same prepared bytes: one same-key POST with mustFinishBy; with a changed body: unverifiable, no POST (M7)', async () => {
      const h = await sim({ memory: 600_000, config: { keyMemoryMs: 600_000 } })
      h.fault({ endpoint: 'generations.create', fault: { kind: 'lost-response' }, times: 4 })
      await fail(h.provider.submit(textReq()))
      expect(h.provider.sameKeyRetry('take-1').reason).toBe('ok')
      const { remoteId } = await h.provider.submit(textReq(), { retryOfUnknown: true })
      expect(await h.creates()).toHaveLength(5)
      expect((await h.jobs()).map((j) => j.id)).toEqual([remoteId])
      // in this session a retry re-sends the stored bytes, whatever the request says now (never a 409, never a 2nd job)
      h.fault({ endpoint: 'generations.create', fault: { kind: 'lost-response' }, times: 4 })
      await fail(h.provider.submit(textReq({ key: 'take-2', takeId: 'take-2' })))
      await h.provider.submit(textReq({ key: 'take-2', takeId: 'take-2', prompt: 'Một chú chó đi dạo' }), { retryOfUnknown: true })
      expect((await h.jobs()).map((j) => j.body.prompt)).toEqual(['Một chú mèo đi dạo', 'Một chú mèo đi dạo'])
      // after a restart the body is rebuilt: an edited one is never sent under the old key
      h.fault({ endpoint: 'generations.create', fault: { kind: 'lost-response' }, times: 4 })
      await fail(h.provider.submit(textReq({ key: 'take-3', takeId: 'take-3' })))
      const creates = (await h.creates()).length
      const e = await fail(h.make().submit(textReq({ key: 'take-3', takeId: 'take-3', prompt: 'Một chú chó đi dạo' }), { retryOfUnknown: true }))
      expect(isSubmitUnverifiable(e)).toBe(true)
      expect(e.detail).toBe('D:body-changed')
      expect(await h.creates()).toHaveLength(creates)
      expect(await h.duplicates()).toBe(0)
    })

    it('retryOfUnknown with a cleared ledger / a dropped key: unverifiable, no POST (M8)', async () => {
      const h = await sim()
      h.fault({ endpoint: 'generations.create', fault: { kind: 'lost-response' }, times: 4 })
      await fail(h.provider.submit(textReq()))
      const creates = (await h.creates()).length
      // another computer / cleared storage: no record of the earlier POST is no proof it was never sent
      const fresh = h.make(memoryStorage())
      const e = await fail(fresh.submit(textReq(), { retryOfUnknown: true }))
      expect(isSubmitUnverifiable(e)).toBe(true)
      expect(e.detail).toBe('D:no-record')
      expect(await h.creates()).toHaveLength(creates)
    })

    it('409 idempotency_conflict (same key, other body): uncertain, never a new key (M9)', async () => {
      const h = await sim()
      await h.provider.submit(textReq())
      // the same take from a cleared ledger with an edited prompt: seedvis still holds the key with the first body
      const other = h.make(memoryStorage())
      const e = await fail(other.submit(textReq({ prompt: 'Một chú chó đi dạo' })))
      expect(isSubmitUncertain(e)).toBe(true)
      // the first answer is 202; every later POST carries the SAME key (the gated re-sends) and is answered 409
      const statuses = (await h.creates()).map((c) => c.status)
      expect(statuses[0]).toBe(202)
      expect(statuses.length).toBeGreaterThan(1)
      expect(statuses.slice(1).every((st) => st === 409)).toBe(true)
      expect(await h.jobs()).toHaveLength(1)
    })

    it('402 insufficient_credits sync → refused (remoteCode); 402 via poll after a 202 → failed, code insufficient_credits', async () => {
      const h = await sim()
      await h.server.setBalance(0)
      const e = await fail(h.provider.submit(textReq()))
      expect(e.uncertain).toBeUndefined()
      expect(e.remoteCode).toBe('insufficient_credits')
      expect(await h.jobs()).toHaveLength(0)
      await h.server.setBalance(1000)
      h.preset('poll-insufficient_credits')
      const { remoteId } = await h.provider.submit(textReq({ key: 'take-2', takeId: 'take-2' }))
      const { last } = await h.pollUntilFinal(remoteId)
      expect(last).toMatchObject({ state: 'failed', code: 'insufficient_credits' })
    })

    it('422 slots full → deferred (nothing sent before, not billed), concurrency() lowered', async () => {
      const h = await sim()
      h.provider.noteAccountInfo({ concurrency_limit: 4 })
      expect(h.provider.concurrency()).toBe(4)
      h.preset('slots-once')
      const e = await fail(h.provider.submit(textReq()))
      expect(isSubmitDeferred(e)).toBe(true)
      expect(e.uncertain).toBeUndefined()
      expect(h.provider.concurrency()).toBeLessThan(4)
      expect(await h.jobs()).toHaveLength(0)
      expect(await h.balance()).toBe(1000)
      // the slots free up: the same take goes through, once
      const { remoteId } = await h.provider.submit(textReq())
      expect((await h.jobs()).map((j) => j.id)).toEqual([remoteId])
    })
    it.todo('"slots full for 10 min": bytes uploaded ≤ body × 8, every take sent once the slots free up — B2 (the engine\'s deferral back-off 15 → 300 s and its big-body rule, M29, store/runs)')

    it('429 + Retry-After → deferred with retryAfterMs; deferDelayMs honours it', async () => {
      const h = await sim()
      h.fault({ endpoint: 'generations.create', fault: { kind: 'response', status: 429, code: 'rate_limit_exceeded', retryAfterSeconds: 42 } })
      const e = await fail(h.provider.submit(textReq()))
      expect(isSubmitDeferred(e)).toBe(true)
      expect(e.retryAfterMs).toBe(42_000)
      expect(h.provider.deferDelayMs(1, e.retryAfterMs)).toBeGreaterThanOrEqual(42_000)
      expect(await h.jobs()).toHaveLength(0)
    })

    it('503 server_busy → deferred; 503 model_maintenance / 404 model_not_found → refused', async () => {
      const h = await sim()
      h.preset('busy')
      expect(isSubmitDeferred(await fail(h.provider.submit(textReq())))).toBe(true)
      for (const [status, code] of [[503, 'model_maintenance'], [404, 'model_not_found']] as const) {
        h.fault({ endpoint: 'generations.create', fault: { kind: 'response', status, code } })
        const e = await fail(h.provider.submit(textReq()))
        expect(e).toMatchObject({ remoteCode: code })
        expect(isSubmitDeferred(e) || isSubmitUncertain(e)).toBe(false)
      }
      expect(await h.jobs()).toHaveLength(0)
    })
    it.todo('…and /models is read again after a model refusal — B2 (refreshLimits wiring of the seedvis provider in providers/index)')

    it('JSON 502 / 504 generation_failed → gated same-key re-send', async () => {
      for (const preset of ['502', '504']) {
        const h = await sim()
        h.preset(preset)
        const { remoteId } = await h.provider.submit(textReq())
        expect((await h.creates()).map((c) => c.status), preset).toEqual([Number(preset), 202])
        expect((await h.jobs()).map((j) => j.id)).toEqual([remoteId])
      }
    })

    it('content_policy sync (refused) and via poll (failed, no refund promise)', async () => {
      const h = await sim()
      h.preset('policy')
      const e = await fail(h.provider.submit(textReq()))
      expect(e).toMatchObject({ remoteCode: 'content_policy' })
      expect(isSubmitUncertain(e) || isSubmitDeferred(e)).toBe(false)
      h.preset('poll-content_policy')
      const { remoteId } = await h.provider.submit(textReq({ key: 'take-2', takeId: 'take-2' }))
      const { last } = await h.pollUntilFinal(remoteId)
      expect(last).toMatchObject({ state: 'failed', code: 'content_policy' })
      expect(last!.error).not.toMatch(/hoàn|refund/i)
    })

    it('invalid_image keyed reference_images[i] / referenceImages[i] / image / lastFrame → the slot named in the text', async () => {
      for (const field of ['reference_images[1]', 'referenceImages[2]', 'image', 'lastFrame']) {
        const h = await sim()
        h.fault({ endpoint: 'generations.create', fault: { kind: 'response', status: 400, code: 'invalid_image', field } })
        const e = await fail(h.provider.submit(seedvisReq({ images: images(2), prompt: '@image_1 @image_2' })))
        expect(e, field).toMatchObject({ remoteCode: 'invalid_image', field })
        expect(e.message, field).toContain(field)
      }
    })

    it('the three error formats (native errors map, OpenAI error.param, Google error.status) parse to the same refusal', async () => {
      const seen = []
      for (const format of ['native', 'openai', 'google'] as const) {
        const h = await sim()
        h.fault({ endpoint: 'generations.create', fault: { kind: 'response', status: 400, code: 'invalid_image', field: 'reference_images[0]', format } })
        const e = await fail(h.provider.submit(seedvisReq({ images: images(1) })))
        expect(isSubmitUncertain(e) || isSubmitDeferred(e), format).toBe(false)
        seen.push({ status: e.status, code: e.remoteCode, field: e.field })
      }
      expect(seen[1]).toEqual(seen[0])
      expect(seen[0]).toEqual({ status: 400, code: 'invalid_image', field: 'reference_images[0]' })
      // a Google-style body carries only the gRPC status (no seedvis code, no field): still the same plain refusal
      expect(seen[2]).toEqual({ status: 400, code: 'INVALID_ARGUMENT', field: undefined })
    })

    it('cancel during the first upload: the body was sent, so the submit ends with the job (never "cancelled") and no orphan for a take that still exists', async () => {
      let cancelled = false
      const h = await sim({ sizes: { 'img-1': 2 * MiB } })
      h.onSleep(() => void (cancelled = true))
      const { remoteId } = await h.provider.submit(seedvisReq({ images: images(1) }), { isCancelled: () => cancelled })
      h.onSleep(null)
      expect((await h.jobs()).map((j) => j.id)).toEqual([remoteId])
      expect(h.provider.orphans()).toEqual([])
      // cancelled before anything left: nothing sent
      const e = await fail(h.provider.submit(textReq({ key: 'take-2', takeId: 'take-2' }), { isCancelled: () => true }))
      expect(isSubmitCancelled(e)).toBe(true)
      expect(await h.jobs()).toHaveLength(1)
    })

    it('another account\'s key pasted after a lost answer (DevPanel "another account\'s key"): "Chạy lại" sends nothing (uncertain, key-changed) — the sim scopes keys per account: 0 duplicate jobs; the original key back inside the window → the same job', async () => {
      const h = await sim({ memory: 600_000, config: { keyMemoryMs: 600_000 } })
      h.fault({ endpoint: 'generations.create', fault: { kind: 'lost-response' }, times: 4 })
      await fail(h.provider.submit(textReq()))
      expect(await h.bridge.setKey({ key: SEEDVIS_DEV_KEYS.B002 })).toMatchObject({ ok: true })
      const e = await fail(h.provider.submit(textReq(), { retryOfUnknown: true }))
      expect(isSubmitUncertain(e) && !isSubmitUnverifiable(e)).toBe(true)
      expect(e.detail).toBe('D:key-changed')
      expect(h.provider.sameKeyRetry('take-1')).toEqual({ safeUntil: null, reason: 'key-changed' })
      expect(await h.creates()).toHaveLength(4)
      expect(await h.balance('B002')).toBe(1000)
      expect(await h.bridge.setKey({ key: SEEDVIS_DEV_KEYS.A001 })).toMatchObject({ ok: true })
      const { remoteId } = await h.provider.submit(textReq(), { retryOfUnknown: true })
      expect((await h.jobs()).map((j) => j.id)).toEqual([remoteId])
      expect(await h.duplicates()).toBe(0)
      expect(await h.balance()).toBe(990)
    })

    it('key swapped during the automatic +15 / +45 / +90 s re-sends → they stop, no POST under the other key (0 duplicate jobs)', async () => {
      const h = await sim()
      h.preset('lost')
      h.beforeResend(async () => void (await h.bridge.setKey({ key: SEEDVIS_DEV_KEYS.B002 })))
      const e = await fail(h.provider.submit(textReq()))
      expect(isSubmitUncertain(e)).toBe(true)
      expect(e.detail).toBe('D:key-changed')
      expect(await h.creates()).toHaveLength(1)
      expect(await h.balance('B002')).toBe(1000)
      expect(await h.duplicates()).toBe(0)
    })

    it.todo('key status unreadable at the first POST, then a lost answer → unverifiable at once (key-unknown) — the simulation always knows its key\'s tag (statusOfKey); covered by seedvis-adapter.test.ts on the scripted fake')
    it.todo('sim key memory counted from the request start (not the last byte) — the simulation remembers a key from the last byte only; the adapter\'s default (KEY_MEMORY_FROM = request) is covered by seedvis-adapter.test.ts')
    it.todo('wall clock stepped back during the window — the simulation\'s key memory runs on the same wall clock, so a step cannot produce a duplicate here; the monotonic gate is covered by seedvis-adapter.test.ts')

    it('development mode locked after a lost answer → "Chạy lại" is uncertain / unverifiable, never a plain "unavailable" (M6)', async () => {
      const h = await sim({ memory: 600_000, config: { keyMemoryMs: 600_000 } })
      h.fault({ endpoint: 'generations.create', fault: { kind: 'lost-response' }, times: 4 })
      await fail(h.provider.submit(textReq()))
      applyDevAccessState(bareState('locked'))
      const e = await fail(h.provider.submit(textReq(), { retryOfUnknown: true }))
      expect(isSubmitUncertain(e)).toBe(true)
      applyDevAccessState(bareState('build'))
      expect(await h.creates()).toHaveLength(4)
      expect(await h.duplicates()).toBe(0)
    })

    it.todo('2xx with a numeric job id / without any id — the simulation always answers string ids; covered by seedvis-adapter.test.ts (parseGeneration, created-no-id)')

    it('a take deleted (gone) while its POST is in flight → orphan; a take merely cancelled / its scene deleted → no orphan', async () => {
      let gone = false
      const h = await sim()
      h.onSleep(() => void (gone = true))
      const { remoteId } = await h.provider.submit(textReq(), { isCancelled: () => gone, isGone: () => gone })
      h.onSleep(null)
      expect(h.provider.orphans()).toEqual([expect.objectContaining({ remoteId, outcome: null })])
      // what the engine will do with it (B2): cancel it — queued on the simulation, so refunded
      expect(await h.provider.cancel(remoteId)).toBe('refunded')
      expect(h.provider.orphans()).toEqual([expect.objectContaining({ remoteId, outcome: 'refunded' })])
      expect(await h.balance()).toBe(1000)
    })
    it.todo('…the engine awaits that cancel and shows "Một take bị xoá lúc đang gửi" — B2 (store/runs submitTake isGone + orphan handling)')
  })

  describe('poll', () => {
    it('queue position + next.after_seconds pacing: ≤ 4 polls / min / job', async () => {
      const h = await sim({ config: { queuedMs: 600_000, processingMs: 600_000 } })
      const ids = []
      for (const k of ['a', 'b', 'c']) ids.push((await h.provider.submit(textReq({ key: k, takeId: k }))).remoteId)
      const gets0 = await h.gets()
      for (let s = 0; s < 60; s++) {
        await h.provider.poll(ids)
        h.clock.advance(1_000)
      }
      expect((await h.gets()) - gets0).toBeLessThanOrEqual(4 * ids.length)
      const [, , c] = await h.provider.poll(ids)
      expect(c).toMatchObject({ state: 'queued', note: expect.stringMatching(/^P:queued 3 /) })
    })
    it.todo('≤ 2 GETs in flight — the simulated bridge answers in one tick; covered by seedvis-adapter.test.ts (POLL_PARALLEL)')

    it('not_started after N minutes → failed, code not_started (not billed, M13)', async () => {
      const h = await sim()
      h.preset('not-started')
      const { remoteId } = await h.provider.submit(textReq())
      const { last } = await h.pollUntilFinal(remoteId, 30_000)
      expect(last).toMatchObject({ state: 'failed', code: 'not_started' })
      expect(await h.balance()).toBe(1000)
    })

    it('failed + cancelled → cancelled, code cancelled (refunded)', async () => {
      const h = await sim({ config: { queuedMs: 600_000 } })
      const { remoteId } = await h.provider.submit(textReq())
      expect(await h.provider.cancel(remoteId)).toBe('refunded')
      const [st] = await h.provider.poll([remoteId])
      expect(st).toMatchObject({ state: 'cancelled', code: 'cancelled' })
      expect(await h.balance()).toBe(1000)
    })

    it('HTML 404 (maintenance) for hours → never ends the take (M22)', async () => {
      const h = await sim()
      const { remoteId } = await h.provider.submit(textReq())
      h.fault({ endpoint: 'generations.get', fault: { kind: 'html-404' }, sticky: true })
      const { seen, last } = await h.pollUntilFinal(remoteId, 10 * 60_000, 30) // 5 hours
      expect(last).toBeNull()
      expect(new Set(seen)).toEqual(new Set(['processing']))
    })

    it('JSON generation_not_found forever → ends only after ≥ 3 answers over ≥ 30 min with the same key → failed not_found (M22)', async () => {
      const h = await sim()
      const { remoteId } = await h.provider.submit(textReq())
      h.preset('missing')
      const t0 = h.clock.now()
      const { last } = await h.pollUntilFinal(remoteId, 60_000, 200)
      expect(last).toMatchObject({ state: 'failed', code: 'not_found' })
      expect(h.clock.now() - t0).toBeGreaterThanOrEqual(30 * 60_000)
    })

    it('job of another key (DevPanel "another account\'s key") → held, never polled, never failed; re-pasting the key releases it (M23)', async () => {
      const h = await sim({ config: { queuedMs: 600_000 } })
      const { remoteId } = await h.provider.submit(textReq())
      await h.bridge.setKey({ key: SEEDVIS_DEV_KEYS.B002 })
      const gets = await h.gets()
      h.clock.advance(60_000)
      const [st] = await h.provider.poll([remoteId])
      expect(st).toMatchObject({ state: 'processing', held: { keyHint: 'A001' } })
      expect(await h.gets()).toBe(gets)
      await h.bridge.setKey({ key: SEEDVIS_DEV_KEYS.A001 })
      const [back] = await h.provider.poll([remoteId])
      expect(back.held).toBeUndefined()
      expect(await h.gets()).toBe(gets + 1)
    })

    it('401 / no key on a poll → login-required thrown, takes kept; 403 on every job → login-required', async () => {
      const h = await sim()
      const { remoteId } = await h.provider.submit(textReq())
      for (const state of ['revoked', 'forbidden', 'none'] as const) {
        await h.server.setKeyState(state)
        h.clock.advance(60_000)
        expect(await fail(h.provider.poll([remoteId])), state).toMatchObject({ code: 'login-required' })
      }
      await h.bridge.setKey({ key: SEEDVIS_DEV_KEYS.A001 })
      expect((await h.pollUntilFinal(remoteId)).last).toMatchObject({ state: 'completed' })
    })
    it.todo('403 on one job only → that take keeps running with a note, the others are polled — the simulation answers 403 per key, never per job; covered by seedvis-adapter.test.ts')
    it.todo('a final answer with an unknown status ("succeeded") → the take keeps running — the simulation only answers the documented statuses; covered by seedvis-adapter.test.ts')
  })

  describe('cancel', () => {
    it('queued → refunded; processing → 409 not_cancellable → running; finished → finished', async () => {
      const h = await sim({ config: { queuedMs: 30_000, processingMs: 60_000 } })
      const a = (await h.provider.submit(textReq({ key: 'a', takeId: 'a' }))).remoteId
      expect(await h.provider.cancel(a)).toBe('refunded')
      const b = (await h.provider.submit(textReq({ key: 'b', takeId: 'b' }))).remoteId
      h.clock.advance(40_000)
      expect(await h.provider.cancel(b)).toBe('running')
      h.clock.advance(120_000)
      expect(await h.provider.cancel(b)).toBe('finished')
      expect(await h.balance()).toBe(990)
    })

    it('409 + Retry-After: 2 → one retry; 503 cancel_unavailable → ≤ 3 retries then unknown; partial with running_outputs → running', async () => {
      const h = await sim({ config: { queuedMs: 600_000 } })
      const { remoteId } = await h.provider.submit(textReq())
      const cancels = async () => ((await h.server.snapshot()) as { logs: { endpoint: string }[] }).logs.filter((l) => l.endpoint === 'generations.cancel').length
      h.preset('cancel-busy')
      expect(await h.provider.cancel(remoteId)).toBe('refunded') // 409, waited 2 s once, then cancelled
      expect(await cancels()).toBe(2)
      const b = (await h.provider.submit(textReq({ key: 'b', takeId: 'b' }))).remoteId
      h.fault({ ...SEEDVIS_FAULT_PRESETS.find((p) => p.id === 'cancel-off')!.rule, sticky: true })
      expect(await h.provider.cancel(b)).toBe('unknown')
      expect(await cancels()).toBeLessThanOrEqual(2 + 4)
      h.server.clearFaults()
      h.preset('partial')
      expect(await h.provider.cancel(b)).toBe('running')
    })
    it.todo('a 2xx cancel without evidence (empty body / no cancellation / a running job) → the job is read — the simulation always answers with evidence; covered by seedvis-adapter.test.ts')
  })

  describe('downloads', () => {
    async function completed(h: Awaited<ReturnType<typeof sim>>) {
      const { remoteId } = await h.provider.submit(textReq())
      expect((await h.pollUntilFinal(remoteId)).last).toMatchObject({ state: 'completed' })
      return remoteId
    }

    it('expired CDN link → fresh GET → download; expired again on a job completed ≥ 24 h ago → definitive expired-link (isResultExpired)', async () => {
      const h = await sim()
      const remoteId = await completed(h)
      h.preset('expired')
      expect((await h.provider.fetchResult(remoteId)).video?.type).toBe('video/mp4')
      h.clock.advance(25 * 3_600_000)
      h.fault({ endpoint: 'download', fault: { kind: 'expired-link' }, sticky: true })
      const e = await fail(h.provider.fetchResult(remoteId))
      expect(isResultExpired(e)).toBe(true)
    })

    it('expired twice right after completion (CDN not replicated yet) → a plain, retried failure; the take stays fetchable (M27)', async () => {
      const h = await sim()
      const remoteId = await completed(h)
      h.fault({ endpoint: 'download', fault: { kind: 'expired-link' }, times: 2 })
      const e = await fail(h.provider.fetchResult(remoteId))
      expect(e.code).toBe('expired-link')
      expect(isResultExpired(e)).toBe(false)
      expect((await h.provider.fetchResult(remoteId)).video?.type).toBe('video/mp4')
    })

    it('a finished job of another key: fetchResult is held (deferred + held.keyHint), no request, until that key is back (M23)', async () => {
      const h = await sim()
      const remoteId = await completed(h)
      await h.bridge.setKey({ key: SEEDVIS_DEV_KEYS.B002 })
      const gets = await h.gets()
      const e = await fail(h.provider.fetchResult(remoteId))
      expect(isResultHeld(e) && isResultDeferred(e)).toBe(true)
      expect(e.held).toEqual({ keyHint: 'A001' })
      expect(await h.gets()).toBe(gets)
      await h.bridge.setKey({ key: SEEDVIS_DEV_KEYS.A001 })
      expect((await h.provider.fetchResult(remoteId)).video?.type).toBe('video/mp4')
    })

    it('download failing while offline, or a network failure before any byte → deferred, not counted (M27)', async () => {
      const h = await sim()
      const remoteId = await completed(h)
      h.preset('offline')
      expect(isResultDeferred(await fail(h.provider.fetchResult(remoteId)))).toBe(true)
      h.server.clearFaults()
      h.fault({ endpoint: 'download', fault: { kind: 'lost-response' } })
      expect(isResultDeferred(await fail(h.provider.fetchResult(remoteId)))).toBe(true)
      expect((await h.provider.fetchResult(remoteId)).video?.type).toBe('video/mp4')
    })
    it.todo('download failing N times → counted failures, the take ends fetchable — B2 (the engine counts the tries, store/runs finishTake)')

    it('completed with empty outputs → one more round, then no-output', async () => {
      const h = await sim()
      h.preset('empty')
      const remoteId = await completed(h)
      expect(await fail(h.provider.fetchResult(remoteId))).toMatchObject({ code: 'no-output' })
    })

    it('application/octet-stream video → mime sniffed (video/mp4), never .webm', async () => {
      const h = await sim({ config: { outputContentType: 'application/octet-stream' } })
      const remoteId = await completed(h)
      expect((await h.provider.fetchResult(remoteId)).video?.type).toBe('video/mp4')
    })
    it.todo('CDN requests carry no Authorization / X-API-Key / x-goog-api-key — the adapter never names a URL or header (downloadOpen by job id); covered by seedvis-dev-server.test.ts (the sim refuses them) and seedvisRules.test.ts (main strips them)')

    it('short echo (fewer references than images sent) → note only, the job is kept (M19)', async () => {
      const h = await sim()
      h.preset('echo')
      const { remoteId } = await h.provider.submit(seedvisReq({ images: images(2), prompt: '@image_1 @image_2' }))
      expect(h.provider.diagnostics('take-1').echo).toBe('1/2')
      h.clock.advance(2_000) // past the queue (its position note wins while queued)
      const [st] = await h.provider.poll([remoteId])
      expect(st).toMatchObject({ state: 'processing', note: 'P:echo 1/2' })
      expect((await h.pollUntilFinal(remoteId)).last).toMatchObject({ state: 'completed' })
    })
  })

  describe('ledger and restart', () => {
    it('restart with a remoteId → polling resumes; without → recover() reads the ledger only, never a POST (M4)', async () => {
      const h = await sim()
      const { remoteId } = await h.provider.submit(textReq())
      const restarted = h.make()
      expect(await restarted.recover(textReq())).toEqual({ remoteId })
      expect(await restarted.submit(textReq())).toEqual({ remoteId })
      expect(await h.creates()).toHaveLength(1)
      expect(await restarted.recover(textReq({ key: 'never', takeId: 'never' }))).toBeNull()
      const [st] = await restarted.poll([remoteId])
      expect(['queued', 'processing', 'completed']).toContain(st.state)
    })

    it('the simulated ledger (bdp:dev:seedvis:ledger) never mixes with the real one', async () => {
      const h = await sim()
      await h.provider.submit(textReq())
      expect(h.storage.get(SEEDVIS_DEV_LEDGER_KEY)).toContain('"jobs"')
      expect(h.storage.get(SEEDVIS_LEDGER_KEY)).toBeNull()
    })
    it.todo('resetDevMode wipes the simulated ledger — B2 (providers/index resetDevMode with the registered seedvis-dev provider)')
    it.todo('no request ever reaches real seedvis.com (stress trap registered as "seedvis", M21) — B2 / stress (the seedvis scenarios of devtools/stress)')
  })
})
