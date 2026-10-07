import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyDevAccessState, bareState } from '../../../devAccess'
import { SEEDVIS_API_BASE, SEEDVIS_IPC_ROUTES, SEEDVIS_KEY_MEMORY_MS, type SeedvisRequest, type SeedvisResponse } from '../../../seedvis/contract'
import { SEEDVIS_MODEL_IDS } from '../../../../core/services'
import { SEEDVIS_ROUTE_TABLE } from '../../../../core/seedvisRoutes'
import { createDevSeedvisBridge } from '../bridge'
import { createDevSeedvis } from '../server'
import { SEEDVIS_FAULT_PRESETS } from '../faults'
import { initialSeedvisState, memorySeedvisStore, readSeedvisState, SEEDVIS_DEV_KEYS, type SeedvisStateStore } from '../state'
import { matchSeedvisRoute } from '../routes'
import { seedvisRequestProblem, seedvisUploadBytes, type SeedvisCreate } from '../validate'

const key = '12345678-1234-4234-8234-123456789abc'
const create = (patch: Partial<SeedvisCreate> = {}): SeedvisCreate => ({ route: 'generations.create', idempotencyKey: key,
  body: { model: 'seedance_2.5', mode: 'text-to-video', prompt: 'Một chú mèo', count: 1, duration: 5, aspect_ratio: '16:9' }, ...patch })
const png = (length = 16) => { const b = new Uint8Array(length); b.set([137, 80, 78, 71, 13, 10, 26, 10]); return b }
const withImage = (length = 16) => create({ body: { ...create().body, mode: 'image-to-video' }, images: [{ field: 'reference_images', index: 0, mime: 'image/png', bytes: png(length) }] })
function data(r: SeedvisResponse): any { expect(r.ok).toBe(true); return r.ok ? (r.json as any)?.data : undefined }
function status(r: SeedvisResponse) { expect(r.ok).toBe(true); return r.ok ? r.status : 0 }
function code(r: SeedvisResponse) { return r.ok ? (r.json as any)?.error?.code : r.code }
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
    for (const path of ['/api/v1/developer/generations/a?wait=1', '/api/v1/developer/generations/a?wait=0&wait=0', '/api/v1/developer/generations/a?next=https://x', '/api/v1/../v1/models', '/api/v1/developer/generations/%2e%2e', '/api/v1/developer/generations/a/b', 'https://seedvis.com/api/v1/models', '//seedvis.com/api/v1/models', '/api/v1/models?', '/api/v1/models\n']) expect(matchSeedvisRoute('GET', path)).toBeNull()
    expect(matchSeedvisRoute('GET', `/api/v1/developer/generations/${'a'.repeat(101)}`)).toBeNull()
    expect(matchSeedvisRoute('GET', '/api/v1/developer/generations/a')).toMatchObject({ id: 'a' })
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
    expect(data(await bridge.request({ route: 'account.usage' }))).toMatchObject({ generations: 1, credits_used: 10 })
  })

  it('returns 202 queued, 202 polling, processing and final output using elapsed time', async () => {
    const { server, bridge, advance } = harness()
    await server.configure({ poll202: true })
    const first = await bridge.request(create())
    expect(status(first)).toBe(202)
    const job = data(first)
    expect(job).toMatchObject({ status: 'queued', is_final: false, queue: { position: 1 }, next: { after_seconds: 15 } })
    expect(status(await bridge.request({ route: 'generations.get', id: job.id }))).toBe(202)
    advance(1000)
    expect(data(await bridge.request({ route: 'generations.get', id: job.id })).status).toBe('processing')
    advance(6000)
    expect(data(await bridge.request({ route: 'generations.get', id: job.id }))).toMatchObject({ status: 'completed', is_final: true, outputs: [{ type: 'video' }] })
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
    expect(await bridge.request(cancel)).toMatchObject({ ok: true, status: 200, json: { cancellation: { refunded_credits: 10 } } })
    expect(status(await bridge.request(cancel))).toBe(200)
    expect((await snapshot(server)).balances.A001).toBe(1000)
    const second = data(await bridge.request(create({ idempotencyKey: crypto.randomUUID() }))).id
    advance(1000)
    expect(code(await bridge.request({ ...cancel, id: second }))).toBe('not_cancellable')
    server.addFault({ endpoint: 'generations.cancel', fault: { kind: 'cancel-partial' } })
    expect(await bridge.request({ ...cancel, id: second })).toMatchObject({ ok: true, json: { cancellation: { outcome: 'partial', running_outputs: 1, refunded_credits: 0 } } })
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

  it('implements the field-keyed native/OpenAI/Google errors and pre/post-processing 5xx', async () => {
    const { server, bridge } = harness()
    for (const format of ['native', 'openai', 'google'] as const) {
      server.addFault({ endpoint: 'generations.create', fault: { kind: 'response', status: 400, code: 'invalid_image', field: 'reference_images[0]', format } })
      const answer = await bridge.request(create())
      expect(status(answer)).toBe(400)
      expect(JSON.stringify(answer)).toContain(format === 'google' ? 'invalid_image' : 'reference_images[0]')
    }
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
    const store: SeedvisStateStore = { read: async () => { throw new Error('secret') }, change: async () => { throw new Error('secret') }, reset: async () => { throw new Error('secret') } }
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
    for (const [state, expected] of [['unreadable', 'key-unreadable'], ['revoked', 'invalid_api_key'], ['forbidden', 'api_disabled'], ['none', 'no-key']] as const) {
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
    expect(server.addFault(SEEDVIS_FAULT_PRESETS[0].rule)).toBeNull()
    applyDevAccessState(bareState('build'))
    expect((await snapshot(server)).jobs).toHaveLength(0)
    expect(await bridge.openBilling()).toEqual({ ok: true })
    expect(fetch).not.toHaveBeenCalled()
  })
})
