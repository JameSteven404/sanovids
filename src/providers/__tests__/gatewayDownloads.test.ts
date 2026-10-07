// electron/main.cjs video downloads (its <canvasapp-downloads> block, run as-is, with its <canvasapp-lanes> block for
// the slots) next to the TypeScript port development mode runs (providers/dev/downloads.ts): every case runs on BOTH
// and must give the same answers. Pieces ≤ 4 MiB pulled by the page, one slot per download from open to end (never
// leaked: closed while waiting, logout, pull-idle, max time), idle timeout, 1 GB cap, Range + If-Range only with a
// strong validator and a 206 only with that same validator, 416 / bad ranges, a truncated body never reported as done.
// Also main's <canvasapp-net-get> (the GET itself, over a fake net.request: a redirect is followed only to https).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'
import { MAX_CONCURRENCY } from '../canvasapp/adapter'
import * as port from '../dev/downloads'
import type { ByteReader, DownloadDeps, DownloadLimits, PumpAnswer, ResponseLike } from '../dev/downloads'

const NAMES = [
  'CANVASAPP_VIDEO_MAX_BYTES',
  'CANVASAPP_DOWNLOAD_CHUNK_BYTES',
  'CANVASAPP_DOWNLOAD_FLUSH_MS',
  'CANVASAPP_DOWNLOAD_HEADERS_MS',
  'CANVASAPP_DOWNLOAD_IDLE_MS',
  'CANVASAPP_DOWNLOAD_PULL_IDLE_MS',
  'CANVASAPP_DOWNLOAD_MAX_MS',
  'CANVASAPP_DOWNLOAD_MAX_SESSIONS',
  'CANVASAPP_DOWNLOAD_ERROR_BODY_BYTES',
  'CANVASAPP_DOWNLOAD_TAG_MS',
  'CANVASAPP_DOWNLOAD_MAX_TAGS',
  'CANVASAPP_DOWNLOAD_ID_RE',
  'parseContentLength',
  'parseContentRange',
  'downloadStartByte',
  'strongValidator',
  'downloadHeaders',
  'downloadPlan',
  'createDownloadPump',
  'downloadSizeText',
  'downloadFailure',
  'readErrorBody',
  'downloadAnswer',
  'createDownloadSessions',
] as const
type Impl = Pick<typeof port, (typeof NAMES)[number]>

function block(name: string): string {
  const m = new RegExp(`// <${name}>[^\\n]*\\n([\\s\\S]*?)// </${name}>`).exec(mainSource)
  if (!m) throw new Error(`${name} block not found in electron/main.cjs`)
  return m[1]
}

const main = new Function(`${block('canvasapp-downloads')}\nreturn { ${NAMES.join(', ')} }`)() as Impl

interface Lane {
  withSlot: (fn: () => Promise<unknown>, signal?: AbortSignal) => Promise<unknown>
  active: () => number
  /** Downloads in the line for a slot. */
  waiting: () => number
}
/** A fresh 'download' lane of main's <canvasapp-lanes> block (as-is). */
function mainLane(): Lane {
  const l = new Function(`${block('canvasapp-lanes')}\nreturn { withSlot: withCanvasappSlot, lanes: canvasappLanes }`)() as {
    withSlot: (lane: string, fn: () => Promise<unknown>, signal?: AbortSignal) => Promise<unknown>
    lanes: { download: { active: number; waiters: unknown[] } }
  }
  return { withSlot: (fn, signal) => l.withSlot('download', fn, signal), active: () => l.lanes.download.active, waiting: () => l.lanes.download.waiters.length }
}

const IMPLS: [string, Impl, () => Lane][] = [
  ['main.cjs', main, mainLane],
  ['dev port', port, () => port.createDevLane(2)],
]

/** Runs `scenario` on both implementations: the transcripts must be equal; returns main's. */
async function both<T>(scenario: (impl: Impl, lane: () => Lane) => Promise<T> | T): Promise<T> {
  const out: T[] = []
  for (const [, impl, lane] of IMPLS) out.push(await scenario(impl, lane))
  expect(out[1]).toEqual(out[0])
  return out[0]
}

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251)

/** A body reader driven by a script: bytes, 'done', 'error', 'hang' (pending until cancel, then done). */
function scripted(steps: (Uint8Array | 'done' | 'error' | 'hang')[]) {
  const st = { reads: 0, inFlight: 0, maxInFlight: 0, cancels: 0 }
  let wake: (() => void) | null = null
  const reader: ByteReader = {
    read: () => {
      st.reads++
      st.inFlight++
      st.maxInFlight = Math.max(st.maxInFlight, st.inFlight)
      const step = steps.shift() ?? 'done'
      const settle = <T,>(v: T) => {
        st.inFlight--
        return v
      }
      if (step === 'hang') return new Promise((resolve) => (wake = () => resolve(settle({ done: true }))))
      if (step === 'error') return Promise.reject(new Error('reset')).finally(() => void st.inFlight--)
      if (step === 'done') return Promise.resolve(settle({ done: true }))
      return Promise.resolve(settle({ done: false, value: step }))
    },
    cancel: () => {
      st.cancels++
      const w = wake
      wake = null
      w?.()
      return Promise.resolve()
    },
  }
  return { reader, st }
}

const timers = { setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>) }

const describeAnswer = (a: PumpAnswer) => ('bytes' in a ? { bytes: a.bytes.byteLength, first: a.bytes[0] } : a)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('gateway downloads: constants and pure rules (main.cjs ≡ dev port)', () => {
  it('limits are pinned and the same on both sides', () => {
    for (const n of NAMES.filter((x) => x.startsWith('CANVASAPP_'))) expect([n, String(main[n])]).toEqual([n, String(port[n])])
    expect(main.CANVASAPP_VIDEO_MAX_BYTES).toBe(1024 ** 3)
    expect(main.CANVASAPP_DOWNLOAD_CHUNK_BYTES).toBe(4 * 1024 ** 2)
    expect(main.CANVASAPP_DOWNLOAD_IDLE_MS).toBe(60_000)
    expect(main.CANVASAPP_DOWNLOAD_PULL_IDLE_MS).toBe(30_000)
    expect(main.CANVASAPP_DOWNLOAD_MAX_MS).toBe(60 * 60_000)
    expect(main.CANVASAPP_DOWNLOAD_HEADERS_MS).toBe(5 * 60_000)
    // a download per job that may finish at once, plus room for abandoned ones still waiting for their slot
    expect(main.CANVASAPP_DOWNLOAD_MAX_SESSIONS).toBeGreaterThanOrEqual(MAX_CONCURRENCY)
    // the same cap as one saved file (main.cjs <save-rules>): a bigger video could not go through "Lưu video" either
    const save = /const SAVE_MAX_FILE_BYTES = ([0-9 *]+)/.exec(mainSource)
    expect(save).not.toBeNull()
    expect(main.CANVASAPP_VIDEO_MAX_BYTES).toBe(new Function(`return ${save![1]}`)())
  })

  it('Content-Length / Content-Range / start byte', async () => {
    await both((impl) => [
      ['0', '123', ' 42 ', '', '-1', '1e3', '12a', '1234567890123456', null, 5].map((v) => impl.parseContentLength(v)),
      ['bytes 0-99/100', 'bytes 10-19/*', 'BYTES 5-5/6', 'bytes 5-4/10', 'bytes 0-100/100', 'items 0-1/2', 'bytes 0-1', null].map((v) => impl.parseContentRange(v)),
      [0, 1, 99, 100, -5, 1.5, Number.MAX_SAFE_INTEGER, '7', null].map((v) => impl.downloadStartByte(v, 100)),
    ])
    expect(main.parseContentLength('123')).toBe(123)
    expect(main.parseContentLength('1234567890123456')).toBeNull()
    expect(main.parseContentRange('bytes 10-19/*')).toEqual({ start: 10, end: 19, total: null })
    expect(main.parseContentRange('bytes 0-100/100')).toBeNull()
  })

  it('validators: strong ETag or an HTTP date only (no W/, no CR/LF); Range + If-Range only to continue with one', async () => {
    const r = await both((impl) => ({
      v: [
        ['"abc-123"', null],
        ['W/"weak"', null],
        ['"a\r\nX: y"', null],
        ['"a"b"', null],
        [null, 'Tue, 06 Oct 2026 10:00:00 GMT'],
        [null, 'yesterday'],
        ['W/"weak"', 'Tue, 06 Oct 2026 10:00:00 GMT'],
      ].map(([e, d]) => impl.strongValidator(e, d)),
      h: [impl.downloadHeaders(0, '"x"'), impl.downloadHeaders(100, null), impl.downloadHeaders(100, '"x"')],
    }))
    expect(r.v).toEqual(['"abc-123"', null, null, null, 'Tue, 06 Oct 2026 10:00:00 GMT', null, 'Tue, 06 Oct 2026 10:00:00 GMT'])
    expect(r.h).toEqual([{ Accept: 'video/mp4,*/*' }, { Accept: 'video/mp4,*/*' }, { Accept: 'video/mp4,*/*', Range: 'bytes=100-', 'If-Range': '"x"' }])
  })

  it('plan: what to do with each answer', async () => {
    const base = { status: 200, from: 0, contentLength: null, contentRange: null, contentEncoding: null, acceptRanges: null, validator: null, sent: null, maxBytes: 1000 }
    const cases = [
      {},
      { contentLength: '500' },
      { contentLength: '1001' },
      { contentLength: '500', acceptRanges: 'bytes', validator: '"e"' },
      { contentLength: '500', acceptRanges: 'bytes' }, // no validator: never resumed
      { contentLength: '500', acceptRanges: 'bytes', validator: '"e"', contentEncoding: 'gzip' }, // decoded body: no length, no Range
      { contentLength: '500', contentEncoding: 'identity' },
      { from: 100, contentLength: '500' }, // a 200 to a resume: from the start
      { status: 206, from: 100, contentRange: 'bytes 100-499/500', validator: '"e"', sent: '"e"' },
      { status: 206, from: 100, contentRange: 'bytes 100-299/500', validator: '"e"', sent: '"e"' }, // a part
      { status: 206, from: 100, contentRange: 'bytes 0-499/500', validator: '"e"', sent: '"e"' }, // not where asked
      { status: 206, from: 100, contentRange: 'bytes 100-499/*', validator: '"e"', sent: '"e"' }, // unknown size
      { status: 206, from: 100, contentRange: 'nonsense', validator: '"e"', sent: '"e"' },
      { status: 206, from: 100, contentRange: 'bytes 100-1499/1500', validator: '"e"', sent: '"e"' },
      { status: 206, from: 100, contentRange: 'bytes 100-499/500', contentEncoding: 'br', validator: '"e"', sent: '"e"' },
      // MONEY: a 206 to a resume must carry the validator If-Range named (else maybe the rest of another file)
      { status: 206, from: 100, contentRange: 'bytes 100-499/500', validator: '"other"', sent: '"e"' },
      { status: 206, from: 100, contentRange: 'bytes 100-499/500', validator: null, sent: '"e"' },
      { status: 206, from: 100, contentRange: 'bytes 100-499/500', validator: '"e"', sent: null },
      { status: 206, from: 0, contentRange: 'bytes 0-499/500' }, // not a resume: nothing to match
      { status: 206, from: 100, contentRange: 'bytes 100-499/500', validator: 'Tue, 06 Oct 2026 10:00:00 GMT', sent: 'Tue, 06 Oct 2026 10:00:00 GMT' },
      { status: 416, from: 100 },
      { status: 416, from: 0 },
      { status: 404 },
      { status: 409 },
      { status: 503 },
      { status: 204 },
    ]
    const plans = await both((impl) => cases.map((c) => impl.downloadPlan({ ...base, ...c })))
    expect(plans).toEqual([
      { kind: 'stream', from: 0, end: null, total: null, resumable: false },
      { kind: 'stream', from: 0, end: 500, total: 500, resumable: false },
      { kind: 'too-large' },
      { kind: 'stream', from: 0, end: 500, total: 500, resumable: true },
      { kind: 'stream', from: 0, end: 500, total: 500, resumable: false },
      { kind: 'stream', from: 0, end: null, total: null, resumable: false },
      { kind: 'stream', from: 0, end: 500, total: 500, resumable: false },
      { kind: 'stream', from: 0, end: 500, total: 500, resumable: false },
      { kind: 'stream', from: 100, end: 500, total: 500, resumable: true },
      { kind: 'stream', from: 100, end: 300, total: 500, resumable: true },
      { kind: 'bad-range' },
      { kind: 'bad-range' },
      { kind: 'bad-range' },
      { kind: 'too-large' },
      { kind: 'bad-range' },
      { kind: 'bad-range' },
      { kind: 'bad-range' },
      { kind: 'bad-range' },
      { kind: 'stream', from: 0, end: 500, total: 500, resumable: false },
      { kind: 'stream', from: 100, end: 500, total: 500, resumable: true },
      { kind: 'bad-range' },
      { kind: 'answer' },
      { kind: 'answer' },
      { kind: 'answer' },
      { kind: 'answer' },
      { kind: 'answer' },
    ])
  })

  it('failure texts (one per reason) and the error-body reader', async () => {
    const r = await both(async (impl) => ({
      texts: ['idle', 'cut', 'length', 'size', 'max', 'closed', undefined].map((x) => impl.downloadFailure(x, { idleMs: 10_000, maxMs: 60 * 60_000, maxBytes: 1024 ** 3 })),
      half: impl.downloadSizeText(512 * 1024 ** 2),
      body: await impl.readErrorBody({ getReader: () => scripted([new TextEncoder().encode('{"detail":'), new TextEncoder().encode('"Video chưa sẵn sàng"}')]).reader }, 64),
      cutBody: await impl.readErrorBody({ getReader: () => scripted([bytes(10), bytes(10), bytes(10)]).reader }, 15),
      answers: [impl.downloadAnswer(409, 'application/json', '{"detail":"x"}'), impl.downloadAnswer(502, 'application/json', '<html>'), impl.downloadAnswer(500, 'text/html', 'x'.repeat(3000))].map(
        (a) => ({ ...a, text: a.text?.length }),
      ),
    }))
    expect(r.texts.map((t) => t.code)).toEqual(['network', 'network', 'network', 'too-large', 'too-slow', 'gone', 'gone'])
    expect(r.texts[0].message).toBe('canvasapp.io.vn ngừng gửi video giữa chừng (10 giây không nhận thêm dữ liệu).')
    expect(r.texts[3].message).toBe('Video lớn hơn 1 GB — SanoVids không tải về máy được.')
    expect(r.texts[4].message).toBe('Tải video quá 60 phút nên SanoVids dừng lại.')
    expect(r.half).toBe('512 MB')
    expect(r.body).toBe('{"detail":"Video chưa sẵn sàng"}')
    expect(r.cutBody).toHaveLength(15)
    expect(r.answers).toEqual([
      { ok: true, status: 409, contentType: 'application/json', json: { detail: 'x' } },
      { ok: true, status: 502, contentType: 'application/json', text: 6 },
      { ok: true, status: 500, contentType: 'text/html', text: 2000 },
    ])
  })
})

describe('gateway downloads: the pump (one network read at a time, pieces ≤ chunk)', () => {
  const pumpOf = (impl: Impl, steps: Parameters<typeof scripted>[0], o: Partial<{ start: number; end: number | null; maxBytes: number; chunkBytes: number; flushMs: number; idleMs: number }> = {}) => {
    const s = scripted(steps)
    const pump = impl.createDownloadPump({ reader: s.reader, start: 0, end: null, maxBytes: 1000, chunkBytes: 100, flushMs: 1000, idleMs: 5000, ...timers, ...o })
    return { pump, st: s.st }
  }

  it('regroups the body into pieces ≤ chunkBytes (a big network chunk is split), then done', async () => {
    const r = await both(async (impl) => {
      const { pump, st } = pumpOf(impl, [bytes(250, 1), bytes(30, 2), bytes(20, 3), 'done'], { end: 300 })
      const answers = []
      for (let i = 0; i < 5; i++) answers.push(describeAnswer(await pump.read()))
      return { answers, maxInFlight: st.maxInFlight, received: pump.received() }
    })
    expect(r.answers).toEqual([{ bytes: 100, first: 1 }, { bytes: 100, first: bytes(250, 1)[100] }, { bytes: 100, first: bytes(250, 1)[200] }, { done: true }, { done: true }])
    expect(r.maxInFlight).toBe(1)
    expect(r.received).toBe(300)
  })

  it('reads the network only while a read waits (at most one chunk ahead)', async () => {
    const r = await both(async (impl) => {
      const { pump, st } = pumpOf(impl, [bytes(100), bytes(100), bytes(100), 'done'])
      await pump.read()
      await vi.advanceTimersByTimeAsync(10_000)
      const before = st.reads
      await pump.read()
      return { before, after: st.reads }
    })
    expect(r).toEqual({ before: 1, after: 2 })
  })

  it('a slow link: what arrived is handed out after flushMs (progress), never an empty piece', async () => {
    const r = await both(async (impl) => {
      const slow: ByteReader = (() => {
        const queue = [bytes(10), bytes(10)]
        return {
          read: () => new Promise((resolve) => setTimeout(() => resolve(queue.length ? { done: false, value: queue.shift() } : { done: true }), 600)),
          cancel: () => Promise.resolve(),
        }
      })()
      const pump = impl.createDownloadPump({ reader: slow, start: 0, end: 20, maxBytes: 1000, chunkBytes: 100, flushMs: 1000, idleMs: 5000, ...timers })
      const first = pump.read()
      await vi.advanceTimersByTimeAsync(1100)
      const a = describeAnswer(await first)
      const second = pump.read()
      await vi.advanceTimersByTimeAsync(2000)
      return [a, describeAnswer(await second), describeAnswer(await pump.read())]
    })
    expect(r).toEqual([{ bytes: 10, first: bytes(10)[0] }, { bytes: 10, first: bytes(10)[0] }, { done: true }])
  })

  it('idle: no byte for idleMs → network failure, reader cancelled once, the same failure afterwards', async () => {
    const r = await both(async (impl) => {
      const { pump, st } = pumpOf(impl, ['hang'], { idleMs: 5000 })
      const first = pump.read()
      await vi.advanceTimersByTimeAsync(4999)
      const early = st.cancels
      await vi.advanceTimersByTimeAsync(2)
      return { early, first: await first, again: await pump.read(), cancels: st.cancels }
    })
    expect(r).toEqual({ early: 0, first: { error: 'network', reason: 'idle' }, again: { error: 'network', reason: 'idle' }, cancels: 1 })
  })

  it('cut, a body shorter / longer than announced, past maxBytes, a second read at once', async () => {
    const r = await both(async (impl) => [
      await (async () => {
        // a cut: what arrived before it is handed out first (a resume continues after it), then the failure
        const { pump } = pumpOf(impl, [bytes(50), 'error'])
        return [describeAnswer(await pump.read()), await pump.read(), await pump.read()]
      })(),
      await (async () => {
        const { pump } = pumpOf(impl, [bytes(100), 'done'], { end: 150 })
        return [describeAnswer(await pump.read()), await pump.read()]
      })(),
      await pumpOf(impl, [bytes(60), bytes(60)], { end: 100 }).pump.read(),
      await (async () => {
        const { pump, st } = pumpOf(impl, [bytes(600), bytes(600), 'done'], { maxBytes: 1000, chunkBytes: 2000 })
        return [await pump.read(), st.cancels]
      })(),
      await pumpOf(impl, [bytes(10)], { start: 995, maxBytes: 1000 }).pump.read(), // a resume counts from its start
      await (async () => {
        const { pump } = pumpOf(impl, ['hang'])
        const a = pump.read()
        const b = await pump.read()
        return [await a, b]
      })(),
    ])
    expect(r).toEqual([
      [{ bytes: 50, first: 1 }, { error: 'network', reason: 'cut' }, { error: 'network', reason: 'cut' }],
      [{ bytes: 100, first: 1 }, { error: 'network', reason: 'length' }],
      { error: 'network', reason: 'length' },
      [{ error: 'too-large', reason: 'size' }, 1],
      { error: 'too-large', reason: 'size' },
      [
        { error: 'network', reason: 'closed' },
        { error: 'network', reason: 'closed' },
      ],
    ])
  })

  it('MONEY: cancel() while a read waits on a body of unknown length is "closed", never done (no truncated video)', async () => {
    const r = await both(async (impl) => {
      const { pump, st } = pumpOf(impl, [bytes(100), 'hang'], { chunkBytes: 1000 })
      const pending = pump.read()
      await vi.advanceTimersByTimeAsync(10)
      pump.cancel() // the reader's pending read now resolves { done: true }: must not count as the end
      return { answer: await pending, after: await pump.read(), cancels: st.cancels }
    })
    expect(r).toEqual({ answer: { error: 'network', reason: 'closed' }, after: { error: 'network', reason: 'closed' }, cancels: 1 })
  })

  it('abort("max") ends it with reason max; cancel after done changes nothing', async () => {
    const r = await both(async (impl) => {
      const a = pumpOf(impl, ['hang'])
      const pending = a.pump.read()
      a.pump.abort('max')
      const b = pumpOf(impl, [bytes(5), 'done'], { end: 5 })
      const got = [describeAnswer(await b.pump.read()), await b.pump.read()]
      b.pump.cancel()
      return { max: await pending, got, after: await b.pump.read(), cancels: b.st.cancels }
    })
    expect(r).toEqual({ max: { error: 'network', reason: 'max' }, got: [{ bytes: 5, first: 1 }, { done: true }], after: { done: true }, cancels: 0 })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Sessions: open / read / close with a fake canvasapp (fetch) and the real lanes
// ---------------------------------------------------------------------------------------------------------------

const ID = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`
const PATH = '/api/video-jobs/job1/stream'

interface FakeAnswer {
  status: number
  headers?: Record<string, string | undefined>
  body?: (Uint8Array | 'done' | 'error' | 'hang')[]
}

/**
 * A fake canvasapp: records each request (url + headers), answers with `answer(n, headers)` (or never: 'hang'; no
 * connection: 'throw'; a redirect to http that <canvasapp-net-get> refused to follow: 'insecure').
 */
function fakeSite(answer: (n: number, headers: Record<string, string>) => FakeAnswer | 'hang' | 'throw' | 'insecure') {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const readers: ReturnType<typeof scripted>['st'][] = []
  const fetch: DownloadDeps['fetch'] = (url, init) => {
    calls.push({ url, headers: { ...init.headers } })
    const a = answer(calls.length, init.headers)
    return new Promise<ResponseLike>((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      if (a === 'hang') return
      if (a === 'throw') return reject(new Error('ECONNREFUSED'))
      if (a === 'insecure') return reject(Object.assign(new Error('Chuyển hướng sang http bị từ chối.'), { code: 'insecure-redirect' }))
      const s = scripted([...(a.body ?? ['done'])])
      readers.push(s.st)
      const h = Object.fromEntries(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
      resolve({ status: a.status, headers: { get: (n) => h[n.toLowerCase()] ?? null }, body: { getReader: () => s.reader, cancel: () => s.reader.cancel() } })
    })
  }
  return { fetch, calls, readers }
}

function sessionsOf(impl: Impl, lane: Lane, fetch: DownloadDeps['fetch'], limits: Partial<DownloadLimits> = {}) {
  return impl.createDownloadSessions({
    fetch,
    withSlot: lane.withSlot,
    matchRoute: (p) => (typeof p === 'string' && /^\/api\/video-jobs\/[A-Za-z0-9_-]{1,80}\/stream$/.test(p) ? { binary: true, url: p, key: p } : p === '/api/me' ? { binary: false, url: p, key: p } : null),
    ...timers,
    now: () => Date.now(),
    limits: { chunkBytes: 100, ...limits },
  })
}

/** Reads a download to its end: [answers…]. */
async function drain(s: ReturnType<Impl['createDownloadSessions']>, owner: unknown, id: string) {
  const out: unknown[] = []
  for (let i = 0; i < 50; i++) {
    const r = await s.read(owner, { id })
    out.push(r.ok && !r.done ? { bytes: r.bytes.byteLength } : r)
    if (!r.ok || r.done) break
  }
  return out
}

const VIDEO = { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '250' }, body: [bytes(250), 'done' as const] }

describe('gateway downloads: sessions (main.cjs ≡ dev port, with the real lanes)', () => {
  it('opens, hands out pieces, ends; the slot is held from open to end', async () => {
    const r = await both(async (impl, laneOf) => {
      const lane = laneOf()
      const site = fakeSite(() => VIDEO)
      const s = sessionsOf(impl, lane, site.fetch)
      const open = await s.open('page', { id: ID(1), path: PATH, from: 0 })
      const during = lane.active()
      const reads = await drain(s, 'page', ID(1))
      return { open, during, reads, after: lane.active(), size: s.size(), headers: site.calls[0].headers }
    })
    expect(r.open).toEqual({ ok: true, id: ID(1), status: 200, contentType: 'video/mp4', from: 0, total: 250, resumable: false })
    expect(r.reads).toEqual([{ bytes: 100 }, { bytes: 100 }, { bytes: 50 }, { ok: true, done: true }])
    expect(r).toMatchObject({ during: 1, after: 0, size: 0, headers: { Accept: 'video/mp4,*/*' } })
  })

  it('refuses before anything is sent: bad id, id in use, not allowlisted / not a video route, too many at once', async () => {
    const r = await both(async (impl, laneOf) => {
      const site = fakeSite(() => 'hang')
      const s = sessionsOf(impl, laneOf(), site.fetch, { maxSessions: 3 })
      const out = [
        await s.open('page', { id: 'x', path: PATH }),
        await s.open('page', { id: ID(1).toUpperCase(), path: PATH }),
        await s.open('page', { id: ID(1), path: 'https://evil.example/video.mp4' }),
        await s.open('page', { id: ID(1), path: '/api/me' }),
      ]
      void s.open('page', { id: ID(1), path: PATH })
      out.push(await s.open('page', { id: ID(1), path: PATH }))
      void s.open('page', { id: ID(2), path: PATH })
      void s.open('page', { id: ID(3), path: PATH }) // waits for a slot (2 per lane): still counts
      out.push(await s.open('page', { id: ID(4), path: PATH }))
      const sent = site.calls.length
      s.closeAll()
      return { codes: out.map((o) => (o.ok ? 'ok' : o.code)), sent }
    })
    expect(r).toEqual({ codes: ['bad-request', 'bad-request', 'not-allowed', 'not-allowed', 'busy', 'busy'], sent: 2 })
  })

  it('SLOT SAFETY: closed while waiting for a slot → the slot is let go at once, the next download runs', async () => {
    const r = await both(async (impl, laneOf) => {
      const lane = laneOf()
      const site = fakeSite(() => VIDEO)
      const s = sessionsOf(impl, lane, site.fetch)
      await s.open('page', { id: ID(1), path: PATH })
      await s.open('page', { id: ID(2), path: PATH })
      const third = s.open('page', { id: ID(3), path: PATH }) // waits
      const fourth = s.open('page', { id: ID(4), path: PATH }) // waits behind it
      await vi.advanceTimersByTimeAsync(0)
      s.close('page', { id: ID(3) })
      await drain(s, 'page', ID(1)) // frees a slot: the closed one passes it on at once
      const t3 = await third
      const t4 = await fourth
      await vi.advanceTimersByTimeAsync(0)
      const active = lane.active()
      s.closeAll('page')
      await vi.advanceTimersByTimeAsync(0)
      return { t3, t4: t4.ok && 'id' in t4 ? 'open' : t4, active, end: lane.active(), sent: site.calls.length }
    })
    expect(r).toEqual({ t3: { ok: false, code: 'gone', message: 'Lượt tải video này đã kết thúc.' }, t4: 'open', active: 2, end: 0, sent: 3 })
  })

  it('SLOT SAFETY: a download closed while it waits for a slot leaves the line at once — open() answers “gone” then, nothing stays queued', async () => {
    const r = await both(async (impl, laneOf) => {
      const lane = laneOf()
      const site = fakeSite(() => 'hang') // both slots held: headers that take their time
      const s = sessionsOf(impl, lane, site.fetch, { maxSessions: 3 })
      void s.open('page', { id: ID(1), path: PATH })
      void s.open('page', { id: ID(2), path: PATH })
      await vi.advanceTimersByTimeAsync(0)
      const answers = new Set<string>()
      for (let i = 0; i < 200; i++) {
        const opening = s.open('page', { id: ID(3), path: PATH })
        await vi.advanceTimersByTimeAsync(0)
        s.close('page', { id: ID(3) })
        await vi.advanceTimersByTimeAsync(0)
        const a = await Promise.race([opening, Promise.resolve('still waiting')])
        answers.add(typeof a === 'string' ? a : a.ok ? 'ok' : a.code)
      }
      const waiting = lane.waiting()
      const size = s.size()
      // the session cap still has room for one that really waits
      const fourth = s.open('page', { id: ID(4), path: PATH })
      await vi.advanceTimersByTimeAsync(0)
      const counted = { waiting: lane.waiting(), size: s.size() }
      s.closeAll('page')
      await vi.advanceTimersByTimeAsync(0)
      const last = await fourth
      return { answers: [...answers], waiting, size, counted, last: last.ok ? 'ok' : last.code, end: { active: lane.active(), waiting: lane.waiting() }, sent: site.calls.length }
    })
    expect(r).toEqual({ answers: ['gone'], waiting: 0, size: 2, counted: { waiting: 1, size: 3 }, last: 'gone', end: { active: 0, waiting: 0 }, sent: 2 })
  })

  it('logout with 2 downloading and 3 waiting: every slot comes back, nothing more is sent', async () => {
    const r = await both(async (impl, laneOf) => {
      const lane = laneOf()
      const site = fakeSite(() => ({ ...VIDEO, body: [bytes(10), 'hang'] }))
      const s = sessionsOf(impl, lane, site.fetch)
      const opens = [1, 2, 3, 4, 5].map((n) => s.open('page', { id: ID(n), path: PATH }))
      await vi.advanceTimersByTimeAsync(0)
      const pending = s.read('page', { id: ID(1) })
      await vi.advanceTimersByTimeAsync(0)
      const before = lane.active()
      s.closeAll()
      const answers = await Promise.all(opens)
      await vi.advanceTimersByTimeAsync(0)
      return { before, after: lane.active(), size: s.size(), read: await pending, waiting: answers.slice(2).map((a) => (a.ok ? 'ok' : a.code)), sent: site.calls.length, cancelled: site.readers.map((x) => x.cancels) }
    })
    expect(r).toEqual({ before: 2, after: 0, size: 0, read: { ok: false, code: 'gone', message: 'Lượt tải video này đã kết thúc.' }, waiting: ['gone', 'gone', 'gone'], sent: 2, cancelled: [1, 1] })
  })

  it('a page that stops reading (reload / crash) loses its download after pullIdleMs; only the owner reads / closes', async () => {
    const r = await both(async (impl, laneOf) => {
      const lane = laneOf()
      const s = sessionsOf(impl, lane, fakeSite(() => VIDEO).fetch, { pullIdleMs: 30_000 })
      await s.open('page', { id: ID(1), path: PATH })
      const stranger = [await s.read('other', { id: ID(1) }), s.close('other', { id: ID(1) }), s.size()]
      await vi.advanceTimersByTimeAsync(29_000)
      const mid = s.size()
      await vi.advanceTimersByTimeAsync(2_000)
      return { stranger, mid, size: s.size(), active: lane.active(), late: await s.read('page', { id: ID(1) }) }
    })
    expect(r).toEqual({
      stranger: [{ ok: false, code: 'gone', message: 'Lượt tải video này đã kết thúc.' }, { ok: true }, 1],
      mid: 1,
      size: 0,
      active: 0,
      late: { ok: false, code: 'gone', message: 'Lượt tải video này đã kết thúc.' },
    })
  })

  it('stalls: idle → network with the idle text; headers that never come → timeout; max time → max', async () => {
    const r = await both(async (impl, laneOf) => {
      const lane = laneOf()
      const stall = sessionsOf(impl, lane, fakeSite(() => ({ ...VIDEO, body: [bytes(100), 'hang'] })).fetch, { idleMs: 60_000 })
      await stall.open('page', { id: ID(1), path: PATH })
      await stall.read('page', { id: ID(1) })
      const idle = stall.read('page', { id: ID(1) })
      await vi.advanceTimersByTimeAsync(60_001)

      const noHeaders = sessionsOf(impl, lane, fakeSite(() => 'hang').fetch, { headersMs: 300_000 })
      const late = noHeaders.open('page', { id: ID(2), path: PATH })
      await vi.advanceTimersByTimeAsync(300_001)

      const long = sessionsOf(impl, lane, fakeSite(() => ({ ...VIDEO, body: ['hang'] })).fetch, { maxMs: 3_600_000, idleMs: 10_000_000, pullIdleMs: 10_000_000 })
      await long.open('page', { id: ID(3), path: PATH })
      const max = long.read('page', { id: ID(3) })
      await vi.advanceTimersByTimeAsync(3_600_001)
      return { idle: await idle, late: await late, max: await max, active: lane.active() }
    })
    expect(r).toEqual({
      idle: { ok: false, code: 'network', message: 'canvasapp.io.vn ngừng gửi video giữa chừng (60 giây không nhận thêm dữ liệu).' },
      late: { ok: false, code: 'network', message: 'canvasapp.io.vn không phản hồi (quá thời gian chờ).' },
      max: { ok: false, code: 'too-slow', message: 'Tải video quá 60 phút nên SanoVids dừng lại.' },
      active: 0,
    })
  })

  it('answers that are not a video: 401 / 409 / 502 (JSON or text, body cut short), unreachable, a redirect to http, too large', async () => {
    const answers: (FakeAnswer | 'throw' | 'insecure')[] = [
      { status: 401, headers: { 'content-type': 'application/json' }, body: [new TextEncoder().encode('{"detail":"Not authenticated"}'), 'done'] },
      { status: 409, headers: { 'content-type': 'application/json; charset=utf-8' }, body: [new TextEncoder().encode('{"detail":"Video chưa sẵn sàng"}'), 'done'] },
      { status: 502, headers: { 'content-type': 'text/html' }, body: [new TextEncoder().encode('<h1>Bad gateway</h1>'), 'hang'] },
      'throw',
      'insecure',
      { status: 200, headers: { 'content-length': String(2 * 1024 ** 3) } },
    ]
    const r = await both(async (impl, laneOf) => {
      const lane = laneOf()
      const s = sessionsOf(impl, lane, fakeSite((n) => answers[n - 1]).fetch, { errorBodyBytes: 64, headersMs: 1000 })
      const out = []
      for (let i = 0; i < answers.length; i++) {
        const p = s.open('page', { id: ID(i + 1), path: PATH })
        await vi.advanceTimersByTimeAsync(1500)
        out.push(await p)
      }
      return { out, active: lane.active(), size: s.size() }
    })
    expect(r.out).toEqual([
      { ok: true, status: 401, contentType: 'application/json', json: { detail: 'Not authenticated' } },
      { ok: true, status: 409, contentType: 'application/json; charset=utf-8', json: { detail: 'Video chưa sẵn sàng' } },
      { ok: true, status: 502, contentType: 'text/html', text: '<h1>Bad gateway</h1>' },
      { ok: false, code: 'network', message: 'Không kết nối được tới canvasapp.io.vn (ECONNREFUSED).' },
      { ok: false, code: 'not-allowed', message: 'canvasapp.io.vn chuyển việc tải video sang một địa chỉ không mã hoá (http) — SanoVids không tải.' },
      { ok: false, code: 'too-large', message: 'Video lớn hơn 1 GB — SanoVids không tải về máy được.' },
    ])
    expect(r).toMatchObject({ active: 0, size: 0 })
  })

  it('MONEY: resume only with the validator canvasapp sent for that video (Range + If-Range); without one, from 0', async () => {
    const ETAG = '"v1-250"'
    const r = await both(async (impl, laneOf) => {
      const site = fakeSite((n, h) =>
        n === 1
          ? { status: 200, headers: { 'content-length': '250', 'accept-ranges': 'bytes', etag: ETAG }, body: [bytes(150), 'error'] }
          : h.Range === 'bytes=150-' && h['If-Range'] === ETAG
            ? { status: 206, headers: { 'content-range': 'bytes 150-249/250', etag: ETAG }, body: [bytes(100, 9), 'done'] }
            : { status: 200, headers: { 'content-length': '250' }, body: [bytes(250), 'done'] },
      )
      const s = sessionsOf(impl, laneOf(), site.fetch, { chunkBytes: 50 })
      const first = await s.open('page', { id: ID(1), path: PATH })
      const cut = await drain(s, 'page', ID(1))
      const resumed = await s.open('page', { id: ID(2), path: PATH, from: 150 })
      const rest = await drain(s, 'page', ID(2))
      // another video (no validator remembered for it): a resume request starts from 0, no Range header
      const other = '/api/video-jobs/job2/stream'
      const fresh = await s.open('page', { id: ID(3), path: other, from: 150 })
      s.closeAll()
      return { first, cut, resumed, rest, fresh, headers: site.calls.map((c) => c.headers) }
    })
    expect(r.first).toMatchObject({ ok: true, from: 0, total: 250, resumable: true })
    expect(r.cut).toEqual([{ bytes: 50 }, { bytes: 50 }, { bytes: 50 }, { ok: false, code: 'network', message: 'Mất kết nối khi đang tải video từ canvasapp.io.vn.' }])
    expect(r.resumed).toMatchObject({ ok: true, status: 206, from: 150, total: 250, resumable: true })
    expect(r.rest).toEqual([{ bytes: 50 }, { bytes: 50 }, { ok: true, done: true }])
    expect(r.fresh).toMatchObject({ ok: true, status: 200, from: 0, total: 250, resumable: false })
    expect(r.headers).toEqual([
      { Accept: 'video/mp4,*/*' },
      { Accept: 'video/mp4,*/*', Range: 'bytes=150-', 'If-Range': ETAG },
      { Accept: 'video/mp4,*/*' },
    ])
  })

  it('a resume answered 416, or with a part that does not start there → bad-range (the page starts over)', async () => {
    const ETAG = '"v1"'
    const r = await both(async (impl, laneOf) => {
      let second: FakeAnswer = { status: 416, headers: { 'content-range': 'bytes */250' } }
      const site = fakeSite((n) => (n % 2 === 1 ? { status: 200, headers: { 'content-length': '250', 'accept-ranges': 'bytes', etag: ETAG }, body: [bytes(150), 'error'] } : second))
      const s = sessionsOf(impl, laneOf(), site.fetch, { chunkBytes: 1000 })
      await s.open('page', { id: ID(1), path: PATH })
      await drain(s, 'page', ID(1))
      const a = await s.open('page', { id: ID(2), path: PATH, from: 150 })
      second = { status: 206, headers: { 'content-range': 'bytes 100-249/250', etag: ETAG }, body: [bytes(150), 'done'] }
      await s.open('page', { id: ID(3), path: PATH })
      await drain(s, 'page', ID(3))
      const b = await s.open('page', { id: ID(4), path: PATH, from: 150 })
      return { a, b, size: s.size() }
    })
    const badRange = { ok: false, code: 'bad-range', message: 'canvasapp.io.vn trả về phần video không khớp chỗ đang tải.' }
    expect(r).toEqual({ a: badRange, b: badRange, size: 0 })
  })

  it('the validator is kept 10 min after the LAST connection of that video ended: a download cut after 15 min still resumes', async () => {
    const ETAG = '"long"'
    const r = await both(async (impl, laneOf) => {
      const site = fakeSite((n, h) =>
        n === 1
          ? { status: 200, headers: { 'content-length': '1000', 'accept-ranges': 'bytes', etag: ETAG }, body: [bytes(100), 'hang'] }
          : h.Range
            ? { status: 206, headers: { 'content-range': 'bytes 100-999/1000', etag: ETAG }, body: [bytes(900, 3), 'done'] }
            : { status: 200, headers: { 'content-length': '1000', 'accept-ranges': 'bytes', etag: ETAG }, body: [bytes(1000), 'done'] },
      )
      const s = sessionsOf(impl, laneOf(), site.fetch, { chunkBytes: 100, idleMs: 60 * 60_000, maxMs: 60 * 60_000 })
      await s.open('page', { id: ID(1), path: PATH })
      await s.read('page', { id: ID(1) })
      const stalled = s.read('page', { id: ID(1) })
      await vi.advanceTimersByTimeAsync(15 * 60_000) // a long, slow download: opened 15 min ago
      s.close('page', { id: ID(1) }) // the connection ends now (cut / stall / closed)
      await stalled
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      const resumed = await s.open('page', { id: ID(2), path: PATH, from: 100 })
      const rest = await drain(s, 'page', ID(2))
      // 10 min after that one ended (completed), the validator is gone: a resume request starts from 0
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
      const late = await s.open('page', { id: ID(3), path: PATH, from: 100 })
      s.closeAll()
      return { resumed, rest: rest.length, late, headers: site.calls.map((c) => c.headers.Range ?? null) }
    })
    expect(r.resumed).toMatchObject({ ok: true, status: 206, from: 100, total: 1000 })
    expect(r.late).toMatchObject({ ok: true, from: 0 })
    expect(r.headers).toEqual([null, 'bytes=100-', null])
  })

  it('MONEY: a 206 to a resume that carries another ETag than the one If-Range named → bad-range, nothing spliced', async () => {
    const r = await both(async (impl, laneOf) => {
      const site = fakeSite((n, h) =>
        n === 1
          ? { status: 200, headers: { 'content-length': '1000', 'accept-ranges': 'bytes', etag: '"A"' }, body: [bytes(400, 1), 'error'] }
          : n === 2
            ? // a server that honours Range but ignores If-Range: the rest of ANOTHER file of the same size
              { status: 206, headers: { 'content-range': 'bytes 400-999/1000', etag: '"B"' }, body: [bytes(600, 9), 'done'] }
            : { status: 206, headers: { 'content-range': 'bytes 400-999/1000' }, body: [bytes(600, 9), 'done'] }, // no validator at all
      )
      const s = sessionsOf(impl, laneOf(), site.fetch, { chunkBytes: 1000 })
      await s.open('page', { id: ID(1), path: PATH })
      await drain(s, 'page', ID(1))
      const other = await s.open('page', { id: ID(2), path: PATH, from: 400 })
      const sentFirst = site.calls[1].headers
      // "B" was not remembered as the video's validator: the next resume still names "A"
      const none = await s.open('page', { id: ID(3), path: PATH, from: 400 })
      return { other, none, sentFirst, sentSecond: site.calls[2].headers, size: s.size(), cancelled: site.readers.map((x) => x.cancels) }
    })
    const badRange = { ok: false, code: 'bad-range', message: 'canvasapp.io.vn trả về phần video không khớp chỗ đang tải.' }
    expect(r.other).toEqual(badRange)
    expect(r.none).toEqual(badRange)
    expect(r.sentFirst).toEqual({ Accept: 'video/mp4,*/*', Range: 'bytes=400-', 'If-Range': '"A"' })
    expect(r.sentSecond).toEqual({ Accept: 'video/mp4,*/*', Range: 'bytes=400-', 'If-Range': '"A"' })
    expect(r.size).toBe(0)
    expect(r.cancelled.slice(1)).toEqual([1, 1]) // the refused bodies are never read
  })

  it('a decoded (gzip) body: no length check, no resume — the bytes as they come', async () => {
    const r = await both(async (impl, laneOf) => {
      const s = sessionsOf(impl, laneOf(), fakeSite(() => ({ status: 200, headers: { 'content-length': '40', 'content-encoding': 'gzip', 'accept-ranges': 'bytes', etag: '"g"' }, body: [bytes(90), 'done'] })).fetch)
      const open = await s.open('page', { id: ID(1), path: PATH })
      return { open, reads: await drain(s, 'page', ID(1)) }
    })
    expect(r.open).toMatchObject({ ok: true, total: null, resumable: false })
    expect(r.reads).toEqual([{ bytes: 90 }, { ok: true, done: true }])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// <canvasapp-net-get>: the GET itself over net.request (a fake ClientRequest with Electron's redirect semantics)
// ---------------------------------------------------------------------------------------------------------------

type NetGet = (o: unknown, url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; headers: { get(n: string): string | null }; body: unknown }>
const netGet = new Function(`${block('canvasapp-net-get')}\nreturn canvasappNetGet`)() as NetGet

/**
 * A ClientRequest like Electron's net-client-request.ts: redirect 'manual' emits 'redirect' and, unless
 * followRedirect() was called during it (or the request was aborted), dies with "Redirect was cancelled" ('error').
 */
function fakeNet() {
  type Listener = (...a: unknown[]) => void
  const made: { options: Record<string, unknown>; headers: Record<string, string>; events: string[]; aborted: boolean; ended: boolean; emit: (ev: string, ...a: unknown[]) => void; redirect: (url: string) => boolean }[] = []
  const request = (options: Record<string, unknown>) => {
    const listeners = new Map<string, Listener[]>()
    const r = {
      options,
      headers: {} as Record<string, string>,
      events: [] as string[],
      aborted: false,
      ended: false,
      following: false as boolean | null,
      emit(ev: string, ...a: unknown[]) {
        for (const l of listeners.get(ev) ?? []) l(...a)
      },
      /** canvasapp answers with a redirect: true when the request followed it. */
      redirect(url: string) {
        r.following = null
        r.emit('redirect', 302, 'GET', url, {})
        const followed = r.following === true
        r.following = false
        if (!followed && !r.aborted) r.emit('error', new Error('Redirect was cancelled'))
        return followed
      },
    }
    const api = {
      setHeader: (k: string, v: string) => void (r.headers[k] = v),
      on: (ev: string, l: Listener) => {
        listeners.set(ev, [...(listeners.get(ev) ?? []), l])
        return api
      },
      followRedirect: () => {
        if (r.following !== null) throw new Error('followRedirect() called, but was not waiting for a redirect')
        r.following = true
        r.events.push('follow')
      },
      abort: () => {
        if (!r.aborted) queueMicrotask(() => r.emit('abort'))
        r.aborted = true
        r.events.push('abort')
      },
      end: () => {
        r.ended = true
        r.events.push('end')
      },
    }
    made.push(r)
    return api
  }
  const toWeb = (res: { body: string }) => ({ webBody: res.body })
  return { o: { request, toWeb, session: 'SESSION' }, made }
}

describe('gateway downloads: <canvasapp-net-get> (main.cjs, a redirect is followed only to https)', () => {
  const HEADERS = { Accept: 'video/mp4,*/*', Range: 'bytes=100-', 'If-Range': '"e"' }
  const message = (status: number, headers: Record<string, string | string[]>) => ({ statusCode: status, headers, body: 'BODY' })

  it('sends a GET through the canvasapp session with the headers, redirect manual; follows https redirects; reads the answer', async () => {
    const net = fakeNet()
    const p = netGet(net.o, 'https://canvasapp.io.vn/api/video-jobs/j/stream', { headers: HEADERS, signal: new AbortController().signal })
    const req = net.made[0]
    expect(req.options).toEqual({ method: 'GET', url: 'https://canvasapp.io.vn/api/video-jobs/j/stream', session: 'SESSION', credentials: 'include', redirect: 'manual', bypassCustomProtocolHandlers: true })
    expect(req.headers).toEqual(HEADERS)
    expect(req.ended).toBe(true)
    expect(req.redirect('https://cdn.example/v.mp4?sig=1')).toBe(true)
    req.emit('response', message(206, { 'content-range': 'bytes 100-499/500', etag: '"e"', 'x-two': ['a', 'b'] }))
    const res = await p
    expect(res.status).toBe(206)
    expect([res.headers.get('Content-Range'), res.headers.get('etag'), res.headers.get('x-two'), res.headers.get('missing')]).toEqual(['bytes 100-499/500', '"e"', 'a, b', null])
    expect(res.body).toEqual({ webBody: 'BODY' })
    expect(req.events).toEqual(['end', 'follow'])
  })

  it('MONEY / SECURITY: a redirect to http (or any other scheme) is never followed — refused before it is sent', async () => {
    for (const to of ['http://canvasapp.io.vn/api/video-jobs/j/stream', 'http://cdn.example/v.mp4', 'ftp://x/v.mp4', 'not a url']) {
      const net = fakeNet()
      const p = netGet(net.o, 'https://canvasapp.io.vn/api/video-jobs/j/stream', { headers: {}, signal: new AbortController().signal })
      const req = net.made[0]
      expect(req.redirect(to)).toBe(false)
      await expect(p).rejects.toMatchObject({ code: 'insecure-redirect' })
      expect(req.events).toEqual(['end', 'abort'])
      req.emit('response', message(200, {})) // nothing can come after that
    }
  })

  it('an https redirect, then one to http: refused at the second hop', async () => {
    const net = fakeNet()
    const p = netGet(net.o, 'https://canvasapp.io.vn/x', { headers: {}, signal: new AbortController().signal })
    const req = net.made[0]
    expect(req.redirect('https://cdn.example/a')).toBe(true)
    expect(req.redirect('http://cdn.example/b')).toBe(false)
    await expect(p).rejects.toMatchObject({ code: 'insecure-redirect' })
  })

  it('network errors reject; abort rejects at once (AbortError) and aborts the request, also after the answer (body)', async () => {
    const net = fakeNet()
    const failed = netGet(net.o, 'https://canvasapp.io.vn/x', { headers: {}, signal: new AbortController().signal })
    net.made[0].emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    await expect(failed).rejects.toThrow('net::ERR_INTERNET_DISCONNECTED')

    const ctrl = new AbortController()
    const waiting = netGet(net.o, 'https://canvasapp.io.vn/x', { headers: {}, signal: ctrl.signal })
    ctrl.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(net.made[1].events).toContain('abort')

    const reading = new AbortController()
    const p = netGet(net.o, 'https://canvasapp.io.vn/x', { headers: {}, signal: reading.signal })
    net.made[2].emit('response', message(200, { 'content-length': '10' }))
    expect((await p).status).toBe(200)
    reading.abort() // <canvasapp-downloads> end(): the body being read stops too
    expect(net.made[2].events).toContain('abort')

    const already = new AbortController()
    already.abort()
    await expect(netGet(net.o, 'https://canvasapp.io.vn/x', { headers: {}, signal: already.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(net.made).toHaveLength(3) // nothing was created for it
  })

  it('statuses without a body have none (204, 304)', async () => {
    const net = fakeNet()
    const p = netGet(net.o, 'https://canvasapp.io.vn/x', { headers: {}, signal: new AbortController().signal })
    net.made[0].emit('response', message(204, {}))
    expect((await p).body).toBeNull()
  })
})
