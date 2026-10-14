import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyDevAccessState, bareState } from '../../../devAccess'
import { SEEDVIS_API_BASE, SEEDVIS_IPC_ROUTES, SEEDVIS_KEY_MEMORY_MS, type SeedvisRequest, type SeedvisResponse } from '../../../seedvis/contract'
import { SEEDVIS_MODEL_IDS } from '../../../../core/services'
import { SEEDVIS_ROUTE_TABLE } from '../../../../core/seedvisRoutes'
import { createDevSeedvisBridge, SEEDVIS_DEV_KEY_TEXTS, SEEDVIS_DEV_UNVERIFIED_OFFER_MS } from '../bridge'
import { createDevSeedvis, SEEDVIS_SLOTS_FULL_MESSAGE, seedvisSizeLabel } from '../server'
import { SEEDVIS_FAULT_PRESETS, type SeedvisFaultInput } from '../faults'
import { initialSeedvisState, memorySeedvisStore, readSeedvisState, SEEDVIS_DEV_KEYS, SEEDVIS_DEV_MAX_JOBS, type SeedvisStateStore } from '../state'
import { matchSeedvisRoute } from '../routes'
import { SEEDVIS_DEV_FAILURE_TEXT, seedvisRequestProblem, seedvisUploadBytes, type SeedvisCreate } from '../validate'

const key = '12345678-1234-4234-8234-123456789abc'
const create = (patch: Partial<SeedvisCreate> = {}): SeedvisCreate => ({ route: 'generations.create', idempotencyKey: key,
  body: { model: 'seedance_2.5', mode: 'text-to-video', prompt: 'Một chú mèo', count: 1, duration: 5, aspect_ratio: '16:9' }, ...patch })
const png = (length = 16) => { const b = new Uint8Array(length); b.set([137, 80, 78, 71, 13, 10, 26, 10]); return b }
const withImage = (length = 16) => create({ body: { ...create().body, mode: 'image-to-video' }, images: [{ field: 'reference_images', index: 0, mime: 'image/png', bytes: png(length) }] })
function data(r: SeedvisResponse): any { expect(r.ok).toBe(true); return r.ok ? (r.json as any)?.data : undefined }
function status(r: SeedvisResponse) { expect(r.ok).toBe(true); return r.ok ? r.status : 0 }
function code(r: SeedvisResponse) { return r.ok ? ((r.json as any)?.code ?? (r.json as any)?.error?.code) : r.code }
function harness(store: SeedvisStateStore = memorySeedvisStore()) {
  let time = 1_800_000_000_000
  const now = () => time
  const sleep = async (ms: number) => { time += ms }
  const server = createDevSeedvis({ store, now, sleep })
  return { server, bridge: createDevSeedvisBridge(server), now, advance: (ms: number) => { time += ms }, store }
}
const snapshot = async (s: ReturnType<typeof createDevSeedvis>) => { const out = await s.snapshot(); if (!out || !('jobs' in out)) throw new Error('No snapshot'); return out }
afterEach(() => { applyDevAccessState(bareState('build')); vi.restoreAllMocks() })

describe('seedvis route and request boundary', () => {
  it('derives every allowed route from the frozen A0 contract', () => {
    for (const [endpoint, route] of Object.entries(SEEDVIS_IPC_ROUTES)) {
      const path = SEEDVIS_API_BASE + route.path.replace('{id}', 'job_123')
      expect(matchSeedvisRoute(route.method, path)?.endpoint).toBe(endpoint)
      expect(matchSeedvisRoute('DELETE', path)).toBeNull()
      expect(matchSeedvisRoute(route.method, `${path}#x`)).toBeNull()
    }
    for (const path of ['/api/v1/developer/generations/a?wait=1', '/api/v1/developer/generations/a?wait=0&wait=0', '/api/v1/developer/generations/a?next=https://x', '/api/v1/../v1/models', '/api/v1/developer/generations/%2e%2e', '/api/v1/developer/generations/a/b', 'https://seedvis.com/api/v1/models', '//seedvis.com/api/v1/models', '/api/v1/models?', '/api/v1/models\n', '/api/v1/developer/generations/a', '/api/v1/developer/generations/?wait=0']) expect(matchSeedvisRoute('GET', path)).toBeNull()
    expect(matchSeedvisRoute('GET', `/api/v1/developer/generations/${'a'.repeat(101)}`)).toBeNull()
    // Exactly the contract template: a poll without wait=0 could hold the connection (and a lane) on the real API.
    expect(matchSeedvisRoute('GET', '/api/v1/developer/generations/a?wait=0')).toMatchObject({ endpoint: 'generations.get', id: 'a' })
    expect(matchSeedvisRoute('POST', '/api/v1/developer/generations/a/cancel')).toMatchObject({ endpoint: 'generations.cancel', id: 'a' })
  })

  it('accepts all catalogue model/mode combinations and preserves reference order', async () => {
    const { bridge } = harness()
    for (const id of SEEDVIS_MODEL_IDS) {
      const spec = SEEDVIS_ROUTE_TABLE[id]
      for (const route of spec.requests) {
        const req = {
          route: 'generations.create', idempotencyKey: crypto.randomUUID(),
          body: { model: spec.remoteModel, mode: route.remoteMode, count: 1, prompt: '@image_1 đi dạo', aspect_ratio: spec.ratios[0], duration: spec.family === 'veo' ? '8s' : 5, ...(spec.family === 'veo' ? { upscale_video: 'none' } : {}) },
          images: Array.from({ length: route.maxImages }, (_, index) => ({ field: route.imageFields.length === 2 ? route.imageFields[index] : route.imageFields[0], index: route.imageFields.length === 2 ? 0 : index, mime: 'image/png', bytes: png() })),
        } as SeedvisCreate
        expect(seedvisRequestProblem(req)).toBeNull()
        const answer = data(await bridge.request(req))
        expect(answer.references.map((r: any) => [r.field, r.index])).toEqual(req.images!.map(r => [r.field, r.index]))
      }
    }
  })

  it('refuses unknown keys, aliases, bad enums, image signatures, ordering and budgets before billing', async () => {
    const { server } = harness()
    const req = create()
    const invalid: unknown[] = [null, {}, { route: 'toString' }, { route: 'models', url: 'https://example.invalid' },
      { ...req, idempotencyKey: 'nope' }, { ...req, idempotencyKey: key + '\n' }, { ...req, mustFinishBy: NaN }, { ...req, images: null },
      ...[{ count: 2 }, { model: 'Omni-Flash' }, { resolution: '1080p' }, { webhook: 'https://x' }, { prompt: '' }, { prompt: 'a'.repeat(20_001) }, { duration: '5s' }, { mode: 'multi-image-to-video' }, { aspect_ratio: '5:4' }, { video: 'x' }].map(body => ({ ...req, body: { ...req.body, ...body } })),
      { ...withImage(), images: [{ ...withImage().images![0], bytes: new Uint8Array(16) }] },
      { ...withImage(), images: [{ ...withImage().images![0], index: 1 }] },
      { ...withImage(), images: [{ ...withImage().images![0], mime: 'image/jpeg' }] },
      { ...req, images: withImage().images }, withImage(20 * 1024 * 1024 + 1),
      { ...withImage(), images: [0, 1].map(index => ({ ...withImage().images![0], index, bytes: png(15 * 1024 * 1024) })) },
    ]
    for (const bad of invalid) { expect(seedvisRequestProblem(bad)).not.toBeNull(); expect((await server.request(bad)).ok).toBe(false) }
    expect((await snapshot(server)).jobs).toHaveLength(0)
    expect((await snapshot(server)).balances.A001).toBe(1000)
  })
})

describe('seedvis lifecycle, account, faults and money', () => {
  it('starts with a fake verified key; supports both model shapes, balance, plan and usage', async () => {
    const { server, bridge } = harness()
    expect(await bridge.keyStatus()).toMatchObject({ hasKey: true, hint: 'A001', tag: 'dev-seedvis:A001' })
    expect(data(await bridge.request({ route: 'account.info' }))).toMatchObject({ plan: 'Giả lập', credit_balance: 1000, concurrency_limit: 2, simulated: true })
    expect(data(await bridge.request({ route: 'models' }))[0].modes[0]).toBe('text-to-video')
    await server.configure({ modesShape: 'objects' })
    expect(data(await bridge.request({ route: 'models' }))[0].modes[0]).toMatchObject({ id: 'text-to-video' })
    await bridge.request(create())
    expect(data(await bridge.request({ route: 'account.usage' }))).toMatchObject({ generations: 1, credits_used: 10, by_status: { queued: 1, processing: 0, completed: 0, failed: 0 } })
  })

  it('returns 202 queued, 202 polling, processing and final output using elapsed time', async () => {
    const { server, bridge, advance } = harness()
    await server.configure({ poll202: true })
    const first = await bridge.request(create())
    expect(status(first)).toBe(202)
    const job = data(first)
    expect(first).toMatchObject({ json: { success: true, status: 202 } })
    expect(job).toMatchObject({ object: 'generation', status: 'queued', is_final: false, queue: { position: 1 },
      next: { action: 'poll', url: `/api/v1/developer/generations/${job.id}`, after_seconds: 15 } })
    expect(status(await bridge.request({ route: 'generations.get', id: job.id }))).toBe(202)
    advance(1000)
    expect(data(await bridge.request({ route: 'generations.get', id: job.id }))).toMatchObject({ status: 'processing', next: { action: 'poll', url: `/api/v1/developer/generations/${job.id}?wait=0` } })
    advance(6000)
    expect(data(await bridge.request({ route: 'generations.get', id: job.id }))).toMatchObject({ status: 'completed', is_final: true, next: { action: 'done' }, outputs: [{ type: 'video' }] })
  })

  it('queues by available streams and rejects excess slots without billing', async () => {
    const { server, bridge, advance } = harness()
    await server.configure({ concurrency: 1, queueLimit: 1 })
    const a = data(await bridge.request(create()))
    const b = data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() })))
    expect(status(await bridge.request(create({ idempotencyKey: crypto.randomUUID() })))).toBe(422)
    advance(1000)
    expect(data(await bridge.request({ route: 'generations.get', id: a.id })).status).toBe('processing')
    expect(data(await bridge.request({ route: 'generations.get', id: b.id })).status).toBe('queued')
    advance(6000)
    expect(data(await bridge.request({ route: 'generations.get', id: b.id })).status).toBe('processing')
    expect((await snapshot(server)).balances.A001).toBe(980)
  })

  it('covers cancel queued/refund once, processing/finished refusal, partial and unavailable', async () => {
    const { server, bridge, advance } = harness()
    const id = data(await bridge.request(create())).id
    const cancel = { route: 'generations.cancel', id } as const
    expect(await bridge.request(cancel)).toMatchObject({ ok: true, status: 200, json: { cancellation: { outcome: 'cancelled', cancelled_outputs: 1, running_outputs: 0 } } })
    // Safe to call twice; the refund happens exactly once and no invented refund amount is reported.
    const again = await bridge.request(cancel)
    expect(again).toMatchObject({ ok: true, status: 200, json: { cancellation: { outcome: 'cancelled', cancelled_outputs: 0, running_outputs: 0 } } })
    expect(JSON.stringify(again)).not.toContain('refunded_credits')
    expect((await snapshot(server)).balances.A001).toBe(1000)
    const second = data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).id
    advance(1000)
    expect(code(await bridge.request({ ...cancel, id: second }))).toBe('not_cancellable')
    server.addFault({ endpoint: 'generations.cancel', fault: { kind: 'cancel-partial' } })
    expect(await bridge.request({ ...cancel, id: second })).toMatchObject({ ok: true, json: { cancellation: { outcome: 'partial', cancelled_outputs: 0, running_outputs: 1 } } })
    server.addFault({ endpoint: 'generations.cancel', fault: { kind: 'response', status: 503, code: 'cancel_unavailable', retryAfterSeconds: 2 } })
    expect(await bridge.request({ ...cancel, id: second })).toMatchObject({ status: 503, headers: { 'Retry-After': '2' } })
    advance(6000)
    expect(code(await bridge.request({ ...cancel, id: second }))).toBe('not_cancellable')
    expect(data(await bridge.request({ route: 'generations.get', id: second })).status).toBe('completed')
  })

  it('holds jobs, releases them, and refunds not_started / async insufficient credits exactly once', async () => {
    const { server, bridge, advance } = harness()
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'not-started', afterMs: 120_000 } })
    const id = data(await bridge.request(create())).id
    advance(120_000)
    for (let i = 0; i < 2; i++) expect(data(await bridge.request({ route: 'generations.get', id }))).toMatchObject({ status: 'failed', error: { code: 'not_started' } })
    expect((await snapshot(server)).balances.A001).toBe(1000)
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'hold' } })
    const held = data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).id
    advance(500_000)
    expect(data(await bridge.request({ route: 'generations.get', id: held })).status).toBe('queued')
    await server.releaseHeld(held)
    advance(7000)
    expect(data(await bridge.request({ route: 'generations.get', id: held })).status).toBe('completed')
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'fail-job', code: 'insufficient_credits' } })
    const failed = data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).id
    advance(7000)
    expect(data(await bridge.request({ route: 'generations.get', id: failed }))).toMatchObject({ status: 'failed', error: { code: 'insufficient_credits' } })
    expect((await snapshot(server)).balances.A001).toBe(990)
  })

  it('models temporary 404, maintenance without JSON, permanent not-found and key revocation', async () => {
    const { server, bridge } = harness()
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'poll-404', polls: 3 } })
    const id = data(await bridge.request(create())).id
    const poll = { route: 'generations.get', id } as const
    for (let i = 0; i < 3; i++) expect(code(await bridge.request(poll))).toBe('generation_not_found')
    expect(status(await bridge.request(poll))).toBe(200)
    server.addFault({ endpoint: 'generations.get', fault: { kind: 'html-404' } })
    expect(await bridge.request(poll)).toMatchObject({ ok: true, status: 404, json: undefined })
    server.addFault({ endpoint: 'generations.get', fault: { kind: 'not-found' }, sticky: true })
    expect(code(await bridge.request(poll))).toBe('generation_not_found')
    server.clearFaults()
    server.addFault({ endpoint: 'generations.get', fault: { kind: 'revoke-key' } })
    expect(status(await bridge.request(poll))).toBe(401)
    expect((await snapshot(server)).jobs[0].status).toBe('queued')
    await bridge.pasteKey()
    expect(status(await bridge.request(poll))).toBe(200)
  })

  it('implements the documented native/OpenAI/Google error bodies and pre/post-processing 5xx', async () => {
    const { server, bridge } = harness()
    for (const format of ['native', 'openai', 'google'] as const) {
      server.addFault({ endpoint: 'generations.create', fault: { kind: 'response', status: 400, code: 'invalid_image', field: 'reference_images[0]', format } })
      const answer = await bridge.request(create())
      expect(status(answer)).toBe(400)
      expect(JSON.stringify(answer)).toContain(format === 'google' ? 'invalid_image' : 'reference_images[0]')
      if (format === 'native') expect((answer as any).json).toEqual({ success: false, status: 400, code: 'invalid_image', message: expect.any(String), errors: { 'reference_images[0]': [expect.any(String)] } })
      if (format === 'google') expect((answer as any).json.error).toMatchObject({ code: 400, status: 'INVALID_ARGUMENT' })
    }
    // errors{} only for a field-keyed code; a 402 / 404 names no field.
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'response', status: 402, code: 'insufficient_credits' } })
    expect((await bridge.request(create()) as any).json).toEqual({ success: false, status: 402, code: 'insufficient_credits', message: expect.any(String) })
    expect((await bridge.request({ route: 'generations.get', id: 'missing' }) as any).json).toEqual({ success: false, status: 404, code: 'generation_not_found', message: expect.any(String) })
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'response', status: 502, code: 'generation_failed', afterProcessing: true } })
    expect(status(await bridge.request(create()))).toBe(502)
    expect((await snapshot(server)).jobs).toHaveLength(1)
    expect(await bridge.request(create())).toMatchObject({ headers: { 'Idempotency-Replayed': 'true' } })
  })

  it('simulates slots full for N minutes, synchronous 402 and chained lost/429/503/422', async () => {
    const { server, bridge, advance } = harness()
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'slots-full', forMs: 120_000 } })
    expect(status(await bridge.request(create()))).toBe(422)
    advance(119_000)
    expect(status(await bridge.request(create()))).toBe(422)
    advance(1000)
    await server.setBalance(0)
    expect(code(await bridge.request(create()))).toBe('insufficient_credits')
    await server.setBalance(1000)
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'lost-response' } })
    for (const status of [429, 503, 422]) server.addFault({ endpoint: 'generations.create', fault: { kind: 'response', status, code: 'server_busy', retryAfterSeconds: 2 } })
    expect(await bridge.request(create())).toMatchObject({ ok: false, code: 'network', sent: true })
    for (const status of [429, 503, 422]) {
      expect(await bridge.request(create())).toMatchObject({ ok: true, status, headers: { 'Retry-After': '2' } })
    }
    expect((await snapshot(server)).jobs).toHaveLength(1)
    expect((await snapshot(server)).balances.A001).toBe(990)
  })
})

describe('idempotency, arrival time, and persistent state', () => {
  it('replays one job/charge, detects changed content and forgets keys after configurable memory', async () => {
    const { server, bridge, advance } = harness()
    await server.configure({ keyMemoryMs: 2000 })
    const req = withImage()
    const first = data(await bridge.request(req))
    expect(data(await bridge.request(req)).id).toBe(first.id)
    const changed = withImage(); changed.images![0].bytes[12] = 1
    expect(code(await bridge.request(changed))).toBe('idempotency_conflict')
    expect(code(await bridge.request({ ...req, body: { ...req.body, prompt: 'khác' } }))).toBe('idempotency_conflict')
    advance(2000)
    expect(data(await bridge.request(req)).id).not.toBe(first.id)
    expect((await snapshot(server)).jobs).toHaveLength(2)
    expect((await snapshot(server)).balances.A001).toBe(980)
  })

  it('deduplicates requests without keys for 120s only on the server fixture', async () => {
    const { server, bridge, advance } = harness()
    const { idempotencyKey: _, ...req } = create()
    const id = data(await server.createWithoutKey(req)).id
    expect(data(await server.createWithoutKey(req)).id).toBe(id)
    expect(await bridge.request(req as SeedvisRequest)).toMatchObject({ ok: false, code: 'bad-request' })
    advance(120_000)
    expect(data(await server.createWithoutKey(req)).id).not.toBe(id)
  })

  it('2 Mbps / 8 MiB upload: lost answer, in-window replay, slowed replay aborted before deadline', async () => {
    const { server, bridge, now, advance } = harness()
    await server.configure({ uploadBytesPerSecond: 250_000, keyMemoryMs: 120_000 })
    const req = withImage(6 * 1024 * 1024)
    const start = now()
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'lost-response' } })
    const lost = await bridge.request(req)
    expect(lost).toMatchObject({ ok: false, sent: true, lastByteAt: start + Math.ceil(seedvisUploadBytes(req) * 1000 / 250_000) })
    const firstLastByteAt = now()
    advance(15_000)
    const deadline = firstLastByteAt + 120_000 - 20_000
    const replay = await bridge.request({ ...req, mustFinishBy: deadline })
    expect(replay).toMatchObject({ ok: true, headers: { 'Idempotency-Replayed': 'true' } })
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'slow-upload', bytesPerSecond: 62_500 } })
    expect(await bridge.request({ ...req, mustFinishBy: deadline })).toMatchObject({ ok: false, code: 'deadline', sent: false, lastByteAt: null })
    expect(now()).toBe(deadline)
    expect((await snapshot(server)).jobs).toHaveLength(1)
    expect((await snapshot(server)).balances.A001).toBe(990)
  })

  it('30 MiB at 2 Mbps cannot arrive by the retry deadline at +90s; null production window stays untouched', async () => {
    const { server, bridge, advance, now } = harness()
    await server.configure({ uploadBytesPerSecond: 250_000 })
    const req = withImage(15 * 1024 * 1024)
    req.images = [req.images![0], { ...req.images![0], index: 1, bytes: png(7.5 * 1024 * 1024) }]
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'lost-response' } })
    expect(await bridge.request(req)).toMatchObject({ ok: false, sent: true })
    const arrival = now()
    advance(90_000)
    expect(await bridge.request({ ...req, mustFinishBy: arrival + 100_000 })).toMatchObject({ ok: false, code: 'deadline', sent: false })
    expect((await snapshot(server)).jobs).toHaveLength(1)
    expect(SEEDVIS_KEY_MEMORY_MS).toBeNull()
  })

  it('persists jobs, key identity, settings, refunds and idempotency across server instances; atomic concurrent replay', async () => {
    const h = harness()
    await h.server.configure({ keyMemoryMs: 999_000 })
    const first = data(await h.bridge.request(create()))
    const second = createDevSeedvis({ store: h.store, now: h.now, sleep: async () => {} })
    const replies = await Promise.all([h.server.request(create()), second.request(create())])
    expect(replies.map(r => data(r).id)).toEqual([first.id, first.id])
    expect((await snapshot(second)).balances.A001).toBe(990)
    expect((await snapshot(second)).config.keyMemoryMs).toBe(999_000)
    await second.request({ route: 'generations.cancel', id: first.id })
    expect((await snapshot(h.server)).balances.A001).toBe(1000)
    await second.reset()
    expect((await snapshot(h.server)).jobs).toHaveLength(0)
    const concurrent = await Promise.all([h.server.request(create()), second.request(create())])
    expect(data(concurrent[0]).id).toBe(data(concurrent[1]).id)
    expect((await snapshot(h.server)).jobs).toHaveLength(1)
    expect((await snapshot(h.server)).balances.A001).toBe(990)
  })

  it('does not submit after key changes or reset during upload, and owns an immutable payload snapshot', async () => {
    for (const action of ['key', 'reset'] as const) {
      const server = createDevSeedvis({ sleep: async () => { if (action === 'key') await server.setKey({ key: SEEDVIS_DEV_KEYS.B002 }); else await server.reset() } })
      expect(await server.request(create())).toMatchObject({ ok: false, sent: false })
      expect((await snapshot(server)).jobs).toHaveLength(0)
    }
    const req = withImage()
    const server = createDevSeedvis({ sleep: async () => { req.body.prompt = 'changed'; req.images![0].bytes[12] = 77 } })
    const first = data(await server.request(req))
    expect((await snapshot(server)).jobs[0].body.prompt).toBe('Một chú mèo')
    expect(data(await server.request(withImage())).id).toBe(first.id)
  })

  it('reports corrupt/unwritable persistence without manufacturing a new account or charge', async () => {
    expect(() => readSeedvisState({ version: 2 })).toThrow()
    const base = initialSeedvisState(); base.balances.A001 = NaN
    expect(() => readSeedvisState(base)).toThrow()
    const store: SeedvisStateStore = { peek: async () => { throw new Error('secret') }, change: async () => { throw new Error('secret') }, reset: async () => { throw new Error('secret') } }
    const { server, bridge } = harness(store)
    expect(await bridge.request(create())).toMatchObject({ ok: false, code: 'storage-failed' })
    expect(JSON.stringify(await server.snapshot())).not.toContain('secret')
  })
})

describe('gateway downloads, key isolation and lock', () => {
  it('downloads only recorded outputs, sniffs octet-stream MP4, expires and refreshes signed links', async () => {
    const { server, bridge, advance } = harness()
    const id = data(await bridge.request(create())).id
    expect(await bridge.downloadOpen({ generationId: id, index: 0 })).toMatchObject({ ok: false, code: 'unknown-output' })
    advance(7000)
    await bridge.request({ route: 'generations.get', id })
    const open = await bridge.downloadOpen({ generationId: id, index: 0 })
    expect(open).toMatchObject({ ok: true, mime: 'video/mp4' })
    if (!open.ok) throw new Error('No download')
    expect(await bridge.downloadRead({ id: open.id })).toMatchObject({ ok: true, done: false, bytes: expect.any(Uint8Array) })
    expect(await bridge.downloadRead({ id: open.id })).toEqual({ ok: true, done: true })
    advance(60_000)
    expect(await bridge.downloadOpen({ generationId: id, index: 0 })).toMatchObject({ code: 'expired-link' })
    await bridge.request({ route: 'generations.get', id })
    expect(await bridge.downloadOpen({ generationId: id, index: 0 })).toMatchObject({ ok: true })
    advance(7 * 86_400_000)
    await bridge.request({ route: 'generations.get', id })
    expect(await bridge.downloadOpen({ generationId: id, index: 0 })).toMatchObject({ code: 'expired-link' })
    expect((await snapshot(server)).jobs).toHaveLength(1)
  })

  it('handles foreign CDN without auth, offline, oversized videos, unsafe redirects, failed attempts and session limits', async () => {
    const { server, bridge, advance } = harness()
    await server.configure({ foreignHost: true })
    const id = data(await bridge.request(create())).id
    advance(7000)
    const job = data(await bridge.request({ route: 'generations.get', id }))
    const forged = new URL(job.outputs[0].url)
    forged.searchParams.set('expires', String(Number(forged.searchParams.get('expires')) + 60_000))
    expect(await server.download(forged.href)).toMatchObject({ code: 'unknown-output' })
    for (const header of ['Authorization', 'Cookie', 'X-API-Key', 'x-goog-api-key']) expect(await server.download(job.outputs[0].url, { [header]: 'secret' })).toMatchObject({ code: 'not-allowed' })
    for (const [kind, code] of [['oversize', 'too-large'], ['insecure-redirect', 'not-allowed'], ['offline', 'offline'], ['lost-response', 'network']] as const) {
      server.addFault({ endpoint: 'download', fault: { kind }, times: 2 })
      for (let i = 0; i < 2; i++) expect(await bridge.downloadOpen({ generationId: id, index: 0 })).toMatchObject({ code })
    }
    const opens = await Promise.all([0, 1, 2].map(() => bridge.downloadOpen({ generationId: id, index: 0 })))
    expect(opens.filter(o => o.ok)).toHaveLength(2)
    expect(opens.filter(o => !o.ok)).toEqual([expect.objectContaining({ code: 'busy' })])
    const first = opens.find(o => o.ok)!
    if (!first.ok) throw new Error('No download')
    await server.configure({ online: false })
    expect(await bridge.isOnline()).toBe(false)
    expect(await bridge.downloadRead({ id: first.id })).toMatchObject({ code: 'offline' })
    await server.configure({ online: true })
    expect(await bridge.downloadRead({ id: first.id })).toMatchObject({ ok: true, done: false })
    expect((await snapshot(server)).logs.filter(l => l.endpoint === 'download').every(l => !l.authorization)).toBe(true)
    await server.reset()
    expect(await bridge.downloadRead({ id: first.id })).toMatchObject({ code: 'gone' })
  })

  it('supports empty outputs / short echoes and guards download argument shapes', async () => {
    const { server, bridge, advance } = harness()
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'empty-outputs' } })
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'short-echo' } })
    const job = data(await bridge.request(withImage()))
    expect(job.references).toHaveLength(0)
    advance(7000)
    expect(data(await bridge.request({ route: 'generations.get', id: job.id })).outputs).toEqual([])
    expect(await bridge.downloadOpen({ generationId: job.id, index: 0 })).toMatchObject({ code: 'unknown-output' })
    expect(await bridge.downloadOpen({ generationId: job.id, index: -1 })).toMatchObject({ code: 'bad-request' })
    expect(await bridge.downloadOpen({ generationId: job.id, index: 0, url: 'https://x' } as any)).toMatchObject({ code: 'bad-request' })
    expect(await bridge.downloadRead({ id: '../x' })).toMatchObject({ code: 'bad-request' })
  })

  it('never accepts real keys; another fake account cannot poll or download the first account job', async () => {
    const { server, bridge, advance } = harness()
    for (const key of ['sv_live_SUPERSECRET0123456789', 'sv_test_SECRET', 'any-possible-real-key-12345']) expect(await bridge.setKey({ key })).toMatchObject({ code: 'bad-key' })
    const a = await bridge.keyStatus()
    const id = data(await bridge.request(create())).id
    advance(7000)
    await bridge.request({ route: 'generations.get', id })
    await bridge.setKey({ key: SEEDVIS_DEV_KEYS.B002 })
    expect((await bridge.keyStatus()).tag).not.toBe(a.tag)
    expect(code(await bridge.request({ route: 'generations.get', id }))).toBe('generation_not_found')
    expect(await bridge.downloadOpen({ generationId: id, index: 0 })).toMatchObject({ code: 'unknown-output' })
    expect(data(await bridge.request(create())).id).not.toBe(id)
    await bridge.setKey({ key: SEEDVIS_DEV_KEYS.A001 })
    expect((await bridge.keyStatus()).tag).toBe(a.tag)
    expect(data(await bridge.request({ route: 'generations.get', id })).status).toBe('completed')
    expect(await bridge.downloadOpen({ generationId: id, index: 0 })).toMatchObject({ ok: true })
    for (const [state, expected] of [['unreadable', 'key-unreadable'], ['revoked', 'unauthorized'], ['forbidden', 'forbidden'], ['none', 'no-key']] as const) {
      await server.setKeyState(state)
      expect(code(await bridge.request({ route: 'account.info' }))).toBe(expected)
    }
    expect(JSON.stringify(await server.snapshot())).not.toMatch(/SUPERSECRET|sv_live_|dev-seedvis-account-/)
  })

  it('checks devAllowed at entry and after an upload; never invokes network or a GUI', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'))
    const server = createDevSeedvis({ sleep: async () => { applyDevAccessState(bareState('locked')) } })
    const bridge = createDevSeedvisBridge(server)
    expect(await bridge.request(create())).toMatchObject({ ok: false, code: 'not-allowed', sent: false })
    expect(await bridge.setKey({ key: SEEDVIS_DEV_KEYS.A001 })).toMatchObject({ code: 'not-allowed' })
    expect(await bridge.pasteKey()).toMatchObject({ code: 'not-allowed' })
    expect(await bridge.clearKey()).toMatchObject({ code: 'not-allowed' })
    expect(await bridge.openBilling()).toMatchObject({ code: 'not-allowed' })
    expect(await bridge.isOnline()).toBe(false)
    expect(await bridge.keyStatus()).toMatchObject({ hasKey: false })
    expect(await bridge.downloadOpen({ generationId: 'job', index: 0 })).toMatchObject({ code: 'not-allowed' })
    expect(await server.snapshot()).toBeNull()
    expect(server.addFault(SEEDVIS_FAULT_PRESETS[0].rule)).toMatchObject({ ok: false, code: 'not-allowed' })
    expect(server.faults()).toEqual([])
    applyDevAccessState(bareState('build'))
    expect((await snapshot(server)).jobs).toHaveLength(0)
    expect(await bridge.openBilling()).toEqual({ ok: true })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('review round 3: wording the mapping track relies on, money traces, faults, queue and cost', () => {
  // Recorded expectation for cx/sv-map: errorOf tells "slots full" from a schema 422 only by this wording. When the tracks
  // are wired, the integration test must assert errorOf classifies the slots body as 'deferred' and the schema body as an error.
  const SV_MAP_SLOTS_RE = /(?:slots?|streams?|concurrency).*(?:full|busy|limit).*(?:queue).*(?:full|limit|reached)|(?:queue).*(?:full|limit).*(?:slots?|streams?|concurrency).*(?:full|busy|limit|reached)/i
  const preset = (id: string) => SEEDVIS_FAULT_PRESETS.find(p => p.id === id)!.rule

  it('answers slots / queue full with one fixed realistic 422, distinct from a schema 422', async () => {
    const { server, bridge, advance } = harness()
    const slots = { success: false, status: 422, code: 'validation_error', message: SEEDVIS_SLOTS_FULL_MESSAGE }
    expect(SV_MAP_SLOTS_RE.test(SEEDVIS_SLOTS_FULL_MESSAGE)).toBe(true)
    await server.configure({ concurrency: 1, queueLimit: 0 })
    expect(status(await bridge.request(create()))).toBe(202)
    expect((await bridge.request(create({ idempotencyKey: crypto.randomUUID() })) as any).json).toEqual(slots)
    await server.configure({ concurrency: 2, queueLimit: 10 })
    expect(server.addFault(preset('slots-once'))).toMatchObject({ ok: true })
    expect((await bridge.request(create({ idempotencyKey: crypto.randomUUID() })) as any).json).toEqual(slots)
    expect(status(await bridge.request(create({ idempotencyKey: crypto.randomUUID() })))).toBe(202)
    server.addFault(preset('slots'))
    const later = crypto.randomUUID()
    expect((await bridge.request(create({ idempotencyKey: later })) as any).json).toEqual(slots)
    advance(119_000)
    expect((await bridge.request(create({ idempotencyKey: later })) as any).json).toEqual(slots)
    advance(1000)
    expect(status(await bridge.request(create({ idempotencyKey: later })))).toBe(202)
    server.addFault(preset('schema'))
    const schema = await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))
    expect(schema).toMatchObject({ ok: true, status: 422, json: { success: false, code: 'validation_error', errors: { prompt: [expect.any(String)] } } })
    expect(SV_MAP_SLOTS_RE.test((schema as any).json.message)).toBe(false)
    expect((await snapshot(server)).balances.A001).toBe(970)
  })

  it('records the Idempotency-Key on every job, also after the key memory expired (a double charge stays visible)', async () => {
    const { server, bridge, advance } = harness()
    await server.configure({ keyMemoryMs: 2000 })
    const first = data(await bridge.request(create())).id
    advance(2000)
    const second = data(await bridge.request(create())).id
    expect(second).not.toBe(first)
    const snap = await snapshot(server)
    expect(snap.memory.map(m => m.jobId)).toEqual([second])
    expect(snap.jobs.map(j => [j.id, j.idempotencyKey])).toEqual([[first, key], [second, key]])
    const { idempotencyKey: _, ...noKey } = create({ body: { ...create().body, prompt: 'khác' } })
    await server.createWithoutKey(noKey)
    expect((await snapshot(server)).jobs[2].idempotencyKey).toMatch(/^body:[a-f0-9]{64}$/)
  })

  it('keeps the job list bounded: the oldest finished jobs go, open and remembered ones stay, usage totals survive', async () => {
    const { server, bridge, advance } = harness()
    await server.configure({ keyMemoryMs: 100_000_000, concurrency: 10, queueLimit: 1000 })
    await server.setBalance(1_000_000)
    const pinnedKey = crypto.randomUUID()
    const ids = [data(await bridge.request(create({ idempotencyKey: pinnedKey }))).id]
    await server.configure({ keyMemoryMs: 1000 })
    for (let i = 1; i < SEEDVIS_DEV_MAX_JOBS + 50; i++) {
      advance(7000)
      ids.push(data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).id)
    }
    advance(7000)
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'hold' } })
    const held = data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).id
    const kept = (await snapshot(server)).jobs.map(j => j.id)
    expect(kept).toHaveLength(SEEDVIS_DEV_MAX_JOBS)
    expect(kept).toEqual([ids[0], ...ids.slice(52), held])
    expect(data(await bridge.request({ route: 'account.usage' }))).toMatchObject({ generations: 251, credits_used: 2510, by_status: { queued: 1, processing: 0, completed: 250, failed: 0 } })
    expect(code(await bridge.request({ route: 'generations.get', id: ids[1] }))).toBe('generation_not_found')
    expect(data(await bridge.request(create({ idempotencyKey: pinnedKey }))).id).toBe(ids[0])
  }, 60_000)

  it('refuses fault parameters the saved state could not hold, and stays usable', async () => {
    const { server, bridge } = harness()
    const bad: unknown[] = [
      { endpoint: 'generations.create', fault: { kind: 'slots-full', forMs: Infinity } },
      { endpoint: 'generations.create', fault: { kind: 'slots-full', forMs: NaN } },
      { endpoint: 'generations.create', fault: { kind: 'not-started', afterMs: -1 } },
      { endpoint: 'generations.create', fault: { kind: 'poll-404', polls: 1.5 } },
      { endpoint: 'generations.create', fault: { kind: 'slow-upload', bytesPerSecond: 0 } },
      { endpoint: 'generations.create', fault: { kind: 'fail-job', code: 'x'.repeat(101) } },
      { endpoint: 'generations.create', fault: { kind: 'fail-job', code: 42 } },
      { endpoint: 'generations.create', fault: { kind: 'response', status: 600, code: 'server_error' } },
      { endpoint: 'generations.create', fault: { kind: 'response', status: 422, code: 'Bad Code' } },
      { endpoint: 'generations.create', fault: { kind: 'response', status: 400, code: 'invalid_image', field: '<b>' } },
      { endpoint: 'generations.create', fault: { kind: 'lost-response' }, times: NaN },
      { endpoint: 'generations.create', fault: { kind: 'lost-response' }, times: Infinity },
      { endpoint: 'generations.create', fault: { kind: 'nope' } },
      { endpoint: 'nope', fault: { kind: 'offline' } },
      { endpoint: 'download', fault: { kind: 'slots-full', forMs: 1 } },
      { endpoint: 'generations.get', fault: { kind: 'hold' } },
    ]
    for (const input of bad) expect(server.addFault(input as SeedvisFaultInput)).toMatchObject({ ok: false, code: 'bad-request' })
    expect(server.faults()).toEqual([])
    expect(data(await bridge.request({ route: 'account.info' }))).toMatchObject({ credit_balance: 1000 })
    expect(status(await bridge.request(create()))).toBe(202)
    for (const p of SEEDVIS_FAULT_PRESETS) expect(server.addFault(p.rule)).toMatchObject({ ok: true })
    expect(server.addFault({ endpoint: 'generations.create', fault: { kind: 'lost-response' }, times: 2.7 })).toMatchObject({ ok: true, rule: { remaining: 2 } })
  })

  it('uses up a fault only where it acts: early exits keep it for the next request; list, remove and subscribe', async () => {
    const { server, bridge, now } = harness()
    const calls = vi.fn()
    const off = server.subscribe(calls)
    await server.configure({ uploadBytesPerSecond: 1000 })
    server.addFault(preset('lost'))
    expect(await bridge.request({ ...withImage(), mustFinishBy: now() + 10 })).toMatchObject({ code: 'deadline', sent: false })
    await server.configure({ online: false })
    expect(await bridge.request(create())).toMatchObject({ code: 'offline', sent: false })
    await server.configure({ online: true })
    expect(server.faults().map(f => f.fault.kind)).toEqual(['lost-response'])
    expect(await bridge.request(create())).toMatchObject({ ok: false, code: 'network', sent: true })
    expect(server.faults()).toEqual([])
    // Job modifiers are not spent by a replay, a 409 or a 402: only a new job takes them.
    server.addFault({ endpoint: 'generations.create', fault: { kind: 'poll-404', polls: 2 } })
    server.addFault(preset('hold'))
    expect(await bridge.request(create())).toMatchObject({ ok: true, headers: { 'Idempotency-Replayed': 'true' } })
    expect(code(await bridge.request(create({ body: { ...create().body, prompt: 'khác' } })))).toBe('idempotency_conflict')
    await server.setBalance(0)
    expect(code(await bridge.request(create({ idempotencyKey: crypto.randomUUID() })))).toBe('insufficient_credits')
    await server.setBalance(1000)
    expect(server.faults().map(f => f.fault.kind)).toEqual(['poll-404', 'hold'])
    const id = data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).id
    expect(server.faults()).toEqual([])
    expect(code(await bridge.request({ route: 'generations.get', id }))).toBe('generation_not_found')
    // A lost answer also hides a refusal: the server answered, the answer never came back.
    server.addFault(preset('lost'))
    await server.setBalance(0)
    expect(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).toMatchObject({ ok: false, code: 'network', sent: true })
    const added = server.addFault(preset('missing'))
    if (!added.ok) throw new Error('No rule')
    expect(server.faults()).toEqual([expect.objectContaining({ id: added.rule.id, sticky: true, hits: 0 })])
    server.removeFault(added.rule.id)
    expect(server.faults()).toEqual([])
    await Promise.resolve()
    expect(calls).toHaveBeenCalled()
    off()
  })

  it('never runs more jobs than the plan streams: a released held job waits behind the job already due', async () => {
    for (const pollBeforeRelease of [false, true]) {
      const { server, bridge, advance, now } = harness()
      const t0 = now()
      await server.configure({ concurrency: 1 })
      server.addFault(preset('hold'))
      const h = data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).id
      const b = data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).id
      const statusOf = async (id: string) => data(await bridge.request({ route: 'generations.get', id })).status
      advance(1200)
      if (pollBeforeRelease) expect(await statusOf(b)).toBe('processing')
      advance(300)
      await server.releaseHeld(h)
      advance(100)
      expect([await statusOf(b), await statusOf(h)]).toEqual(['processing', 'queued'])
      for (let i = 0; i < 15; i++) {
        advance(1000)
        expect((await snapshot(server)).jobs.filter(j => j.status === 'processing').length).toBeLessThanOrEqual(1)
      }
      const jobs = (await snapshot(server)).jobs
      const bJob = jobs.find(j => j.id === b)!
      expect(bJob).toMatchObject({ status: 'completed', startAt: bJob.readyAt, endAt: bJob.readyAt + 6000 })
      expect(bJob.readyAt - t0).toBeLessThan(1010)
      expect(jobs.find(j => j.id === h)).toMatchObject({ status: 'completed', startAt: bJob.endAt })
    }
  })

  it('cancel-partial never forces a queued job past the limit; more streams never start jobs in the past', async () => {
    const { server, bridge, advance, now } = harness()
    const t0 = now()
    await server.configure({ concurrency: 1 })
    const a = data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).id
    const q = data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).id
    advance(2000)
    server.addFault(preset('partial'))
    expect(await bridge.request({ route: 'generations.cancel', id: q })).toMatchObject({ ok: true, json: { data: { status: 'queued' }, cancellation: { outcome: 'partial', running_outputs: 1 } } })
    expect((await snapshot(server)).jobs.filter(j => j.status === 'processing').map(j => j.id)).toEqual([a])
    advance(1000)
    const more = now()
    await server.configure({ concurrency: 2 })
    advance(500)
    const queued = (await snapshot(server)).jobs.find(j => j.id === q)!
    expect(queued).toMatchObject({ status: 'processing', startAt: more })
    expect(queued.readyAt).toBeLessThan(t0 + 1010)
  })

  it('the simulated bridge owns a copy of the request before its first await, like IPC', async () => {
    const { server, bridge } = harness()
    const req = withImage()
    const pending = bridge.request(req)
    req.body.prompt = 'đã đổi'
    req.images![0].bytes[12] = 77
    const first = data(await pending)
    expect((await snapshot(server)).jobs[0].body.prompt).toBe('Một chú mèo')
    expect(data(await bridge.request(withImage())).id).toBe(first.id)
  })

  it('logs every request with its outcome, sent flag and bytes on the wire (offline, deadline and refusals included)', async () => {
    const { server, bridge, now } = harness()
    await server.configure({ uploadBytesPerSecond: 250_000 })
    const big = withImage(1_258_291)
    expect(status(await bridge.request(big))).toBe(202)
    const total = seedvisUploadBytes(big)
    await server.configure({ online: false })
    await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))
    await server.configure({ online: true })
    expect(await bridge.request({ ...big, idempotencyKey: crypto.randomUUID(), mustFinishBy: now() + 1000 })).toMatchObject({ code: 'deadline', message: SEEDVIS_DEV_FAILURE_TEXT.deadline })
    await bridge.request({ route: 'models', url: 'https://example.invalid' } as unknown as SeedvisRequest)
    await server.setKeyState('none')
    await bridge.request({ route: 'account.info' })
    const snap = await snapshot(server)
    expect(snap.logs).toEqual([
      expect.objectContaining({ endpoint: 'generations.create', status: 202, sent: true, uploadedBytes: total, authorization: 'Bearer ***', images: ['[png 1.2 MB]'] }),
      expect.objectContaining({ endpoint: 'generations.create', status: 'offline', sent: false, uploadedBytes: 0 }),
      expect.objectContaining({ endpoint: 'generations.create', status: 'deadline', sent: false, uploadedBytes: 250_000 }),
      expect.objectContaining({ endpoint: 'models', status: 'bad-request' }),
      expect.objectContaining({ endpoint: 'account.info', status: 'no-key' }),
    ])
    expect(snap.logs[3].authorization).toBeUndefined()
    expect(snap.uploadedBytes).toBe(total + 250_000)
    expect([seedvisSizeLabel(16), seedvisSizeLabel(2048)]).toEqual(['16 B', '2.0 KB'])
  })

  it('gives each gateway failure its own fixed Vietnamese text (brand in lowercase)', async () => {
    for (const [failureCode, text] of Object.entries(SEEDVIS_DEV_FAILURE_TEXT)) {
      expect(text).not.toMatch(/^Seedvis/)
      if (failureCode !== 'bad-request') expect(text).not.toBe(SEEDVIS_DEV_FAILURE_TEXT['bad-request'])
    }
    const { server, bridge, advance } = harness()
    await server.configure({ online: false })
    expect(await bridge.request(create())).toMatchObject({ code: 'offline', message: 'seedvis giả lập đang mất mạng.' })
    await server.configure({ online: true })
    const id = data(await bridge.request(create())).id
    advance(7000)
    await bridge.request({ route: 'generations.get', id })
    advance(60_000)
    expect(await bridge.downloadOpen({ generationId: id, index: 0 })).toEqual({ ok: false, code: 'expired-link', message: 'Link video giả lập đã hết hạn.' })
    expect(await server.download('not a url')).toMatchObject({ code: 'not-allowed' })
  })
})

describe('integration (A1 contract): "Lưu mà chưa kiểm tra" and drops after a complete upload, as main does', () => {
  it('pasteKey / setKey save unchecked only the key whose check just failed with a network error, within 2 minutes', async () => {
    const { server, bridge, advance } = harness()
    expect(await bridge.clearKey()).toMatchObject({ ok: true })
    // no earlier network failure: refused, nothing saved
    expect(await bridge.pasteKey({ unverified: true })).toMatchObject({ ok: false, code: 'bad-key', message: SEEDVIS_DEV_KEY_TEXTS.unverifiedRefused })
    expect((await bridge.keyStatus()).hasKey).toBe(false)
    await server.configure({ online: false })
    expect(await bridge.pasteKey()).toMatchObject({ ok: false, code: 'network', message: SEEDVIS_DEV_KEY_TEXTS.verifyNetwork })
    expect((await bridge.keyStatus()).hasKey).toBe(false)
    // another key than the one that failed: refused (and the offer is gone)
    expect(await bridge.setKey({ key: SEEDVIS_DEV_KEYS.B002, unverified: true })).toMatchObject({ code: 'bad-key', message: SEEDVIS_DEV_KEY_TEXTS.unverifiedRefused })
    expect(await bridge.setKey({ key: SEEDVIS_DEV_KEYS.A001, unverified: true })).toMatchObject({ code: 'bad-key' })
    expect((await bridge.keyStatus()).hasKey).toBe(false)
    // the same key, in time: saved without a check (verifiedAt null)
    expect(await bridge.pasteKey()).toMatchObject({ code: 'network' })
    advance(SEEDVIS_DEV_UNVERIFIED_OFFER_MS)
    const saved = await bridge.pasteKey({ unverified: true })
    expect(saved).toMatchObject({ ok: true, status: { hasKey: true, verifiedAt: null } })
    // used once: a second unchecked save needs a new failed check
    expect(await bridge.pasteKey({ unverified: true })).toMatchObject({ code: 'bad-key' })
    // too late
    expect(await bridge.setKey({ key: SEEDVIS_DEV_KEYS.B002 })).toMatchObject({ code: 'network' })
    advance(SEEDVIS_DEV_UNVERIFIED_OFFER_MS + 1)
    expect(await bridge.setKey({ key: SEEDVIS_DEV_KEYS.B002, unverified: true })).toMatchObject({ code: 'bad-key' })
    // Xoá key withdraws it; a real-looking key is never kept, checked or not
    expect(await bridge.setKey({ key: SEEDVIS_DEV_KEYS.B002 })).toMatchObject({ code: 'network' })
    await bridge.clearKey()
    expect(await bridge.setKey({ key: SEEDVIS_DEV_KEYS.B002, unverified: true })).toMatchObject({ code: 'bad-key' })
    expect(await bridge.setKey({ key: 'sv_live_SUPERSECRET0123456789', unverified: true })).toMatchObject({ code: 'bad-key' })
    expect(await bridge.setKey({ key: 'sv_live_SUPERSECRET0123456789' })).toMatchObject({ code: 'bad-key' })
    // a new check withdraws the offer of an older one; a checked save is verified
    expect(await bridge.pasteKey()).toMatchObject({ code: 'network' })
    await server.configure({ online: true })
    expect(await bridge.setKey({ key: SEEDVIS_DEV_KEYS.B002 })).toMatchObject({ ok: true, status: { hasKey: true, verifiedAt: expect.any(Number) } })
    expect(await bridge.pasteKey({ unverified: true })).toMatchObject({ code: 'bad-key' })
    expect((await bridge.keyStatus()).tag).toBe('dev-seedvis:B002')
    expect(JSON.stringify(await server.snapshot())).not.toMatch(/SUPERSECRET|dev-seedvis-account-/)
    // the unchecked flag is part of the saved state (validated when loaded); a checked save clears it
    expect(readSeedvisState({ ...initialSeedvisState(), keyUnchecked: true }).keyUnchecked).toBe(true)
    expect(() => readSeedvisState({ ...initialSeedvisState(), keyUnchecked: 'yes' })).toThrow()
    expect(await bridge.pasteKey()).toMatchObject({ ok: true, status: { verifiedAt: expect.any(Number) } })
  })

  it('a connection lost once the whole body was uploaded may have arrived (sent:true), never "offline / not sent"', async () => {
    let time = 1_800_000_000_000
    const server: ReturnType<typeof createDevSeedvis> = createDevSeedvis({ now: () => time, sleep: async (ms) => { time += ms; await server.configure({ online: false }) } })
    const bridge = createDevSeedvisBridge(server)
    const answer = await bridge.request(withImage())
    expect(answer).toMatchObject({ ok: false, code: 'network', sent: true, lastByteAt: expect.any(Number) })
    // nothing was created here, but the client cannot know it: the adapter must treat it as a lost answer
    expect((await snapshot(server)).jobs).toHaveLength(0)
    // offline BEFORE anything was sent stays "not sent"
    expect(await bridge.request(create())).toMatchObject({ ok: false, code: 'offline', sent: false })
  })
})
