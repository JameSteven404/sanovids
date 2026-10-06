// The desktop transport's video download (providers/canvasapp/transport.ts download() + api.fetchVideo) against
// electron/main.cjs's OWN download sessions (its <canvasapp-downloads>, <canvasapp-lanes> and <canvasapp-routes>
// blocks, run as-is) in front of a scripted canvasapp: pieces into one Blob, progress, abort (also while waiting for a
// slot or during a stalled read), resume only with canvasapp's validator, 416 / 200 answers to a resume, the 1 GB cap,
// "too many at once", older desktop builds (one binary request), errors that name the request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'
import { CanvasappError, createCanvasappApi, type DownloadProgress, type TransportRequest } from '../canvasapp/api'
import { createDesktopTransport, MAX_STALLED_RESUMES, type BridgeDownloadOpen, type BridgeDownloadRead, type BridgeResponse, type CanvasappBridge } from '../canvasapp/transport'
import type * as Port from '../dev/downloads'
import type { ByteReader, DownloadDeps, DownloadLimits, ResponseLike } from '../dev/downloads'

function block(name: string): string {
  const m = new RegExp(`// <${name}>[^\\n]*\\n([\\s\\S]*?)// </${name}>`).exec(mainSource)
  if (!m) throw new Error(`${name} block not found in electron/main.cjs`)
  return m[1]
}
const mainDownloads = new Function(`${block('canvasapp-downloads')}\nreturn { createDownloadSessions }`)() as Pick<typeof Port, 'createDownloadSessions'>
const mainRoutes = (new Function('CANVASAPP_ORIGIN', `${block('canvasapp-routes')}\nreturn matchCanvasappRoute`) as (o: string) => (m: string, p: unknown) => { route: { binary?: boolean }; url: URL } | null)(
  'https://canvasapp.io.vn',
)
function lane() {
  const l = new Function(`${block('canvasapp-lanes')}\nreturn { withSlot: withCanvasappSlot, lanes: canvasappLanes }`)() as {
    withSlot: (lane: string, fn: () => Promise<unknown>) => Promise<unknown>
    lanes: { download: { active: number; waiters: unknown[] } }
  }
  return { withSlot: (fn: () => Promise<unknown>) => l.withSlot('download', fn), active: () => l.lanes.download.active, waiting: () => l.lanes.download.waiters.length }
}

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251)
const concat = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.byteLength, 0))
  let off = 0
  for (const x of a) {
    out.set(x, off)
    off += x.byteLength
  }
  return out
}

type Step = Uint8Array | 'done' | 'error' | 'hang'
interface Answer {
  status: number
  headers?: Record<string, string | undefined>
  body?: Step[]
}

function scripted(steps: Step[]): ByteReader {
  let wake: (() => void) | null = null
  return {
    read: () => {
      const step = steps.shift() ?? 'done'
      if (step === 'hang') return new Promise((resolve) => (wake = () => resolve({ done: true })))
      if (step === 'error') return Promise.reject(new Error('reset'))
      if (step === 'done') return Promise.resolve({ done: true })
      return Promise.resolve({ done: false, value: step })
    },
    cancel: () => {
      wake?.()
      wake = null
      return Promise.resolve()
    },
  }
}

/** main.cjs's download sessions + a scripted canvasapp, exposed as window.bdpDesktop.canvasapp would be. */
function desktop(answer: (n: number, headers: Record<string, string>) => Answer | 'hang', limits: Partial<DownloadLimits> = {}) {
  const l = lane()
  const fetches: Record<string, string>[] = []
  const calls: string[] = []
  const fetch: DownloadDeps['fetch'] = (_url, init) => {
    fetches.push({ ...init.headers })
    const a = answer(fetches.length, init.headers)
    return new Promise<ResponseLike>((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      if (a === 'hang') return
      const reader = scripted([...(a.body ?? ['done'])])
      resolve({ status: a.status, url: 'https://canvasapp.io.vn/x', headers: { get: (n) => a.headers?.[n.toLowerCase()] ?? null }, body: { getReader: () => reader } })
    })
  }
  const sessions = mainDownloads.createDownloadSessions({
    fetch,
    withSlot: l.withSlot,
    matchRoute: (p) => {
      const m = mainRoutes('GET', p)
      return m ? { binary: !!m.route.binary, url: m.url.toString(), key: m.url.pathname } : null
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    limits: { chunkBytes: 100, ...limits },
  })
  const legacy: TransportRequest[] = []
  const bridge: CanvasappBridge = {
    status: async () => ({ ok: true, authenticated: true }),
    login: async () => ({ ok: true, authenticated: true }),
    logout: async () => {
      sessions.closeAll()
      return { ok: true }
    },
    request: async (req): Promise<BridgeResponse> => {
      legacy.push(req)
      return { ok: true, status: 200, contentType: 'video/mp4', bytes: bytes(10) }
    },
    downloadOpen: async (a) => {
      calls.push(`open ${a.from}`)
      return (await sessions.open('page', a)) as BridgeDownloadOpen
    },
    downloadRead: async (a) => {
      calls.push('read')
      return (await sessions.read('page', a)) as BridgeDownloadRead
    },
    downloadClose: async (a) => {
      calls.push('close')
      return sessions.close('page', a)
    },
  }
  let n = 0
  const transport = createDesktopTransport(() => bridge, { newId: () => `abcdef00-0000-4000-8000-${String(++n).padStart(12, '0')}` })
  return { bridge, transport, api: createCanvasappApi(transport), calls, fetches, legacy, lane: l, sessions }
}

const VIDEO_PATH = '/api/video-jobs/job1/stream'
const REQ: TransportRequest = { method: 'GET', path: VIDEO_PATH, binary: true }
const blobBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer())
const ETAG = '"v1"'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('desktop transport: streamed video download', () => {
  it('pieces become one Blob, byte for byte; typed video/mp4 even for octet-stream; progress monotonic, throttled, final', async () => {
    const video = bytes(1000)
    const d = desktop(() => ({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '1000' }, body: [video.slice(0, 600), video.slice(600), 'done'] }))
    const progress: DownloadProgress[] = []
    const blob = await d.api.fetchVideo('job1', { onProgress: (p) => progress.push(p) })
    expect(blob.type).toBe('video/mp4')
    expect(await blobBytes(blob)).toEqual(video)
    expect(d.calls.filter((c) => c === 'read')).toHaveLength(11) // 10 pieces of 100 + the end
    expect(progress.at(-1)).toEqual({ received: 1000, total: 1000 })
    expect(progress.length).toBeLessThanOrEqual(3) // ≤ every 250 ms (fake clock does not move) + the final one
    for (let i = 1; i < progress.length; i++) expect(progress[i].received).toBeGreaterThanOrEqual(progress[i - 1].received)
    expect(d.lane.active()).toBe(0)
    expect(d.sessions.size()).toBe(0)
  })

  it('an older desktop build (no downloadOpen): one binary request, like before', async () => {
    const d = desktop(() => 'hang')
    const { downloadOpen: _o, downloadRead: _r, downloadClose: _c, ...old } = d.bridge
    const api = createCanvasappApi(createDesktopTransport(() => old))
    const blob = await api.fetchVideo('job1')
    expect(await blobBytes(blob)).toEqual(bytes(10))
    expect(d.legacy).toEqual([REQ])
    // its refusals keep their meaning
    const tooBig = createCanvasappApi(createDesktopTransport(() => ({ ...old, request: async () => ({ ok: false, code: 'too-large', message: 'Video lớn hơn 1 GB — SanoVids không tải về máy được.' }) })))
    await expect(tooBig.fetchVideo('job1')).rejects.toMatchObject({ code: 'too-large' })
  })

  it.each([
    [401, 'login-required'],
    [404, 'not-found'],
    [409, 'bad-request'],
    [503, 'server'],
  ])('canvasapp answers %s → %s, naming the request', async (status, code) => {
    const d = desktop(() => ({ status, headers: { 'content-type': 'application/json' }, body: [new TextEncoder().encode('{"detail":"Video chưa sẵn sàng"}'), 'done'] }))
    const e = await d.api.fetchVideo('job1').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(CanvasappError)
    expect(e).toMatchObject({ code, status })
    if (status !== 401) expect((e as Error).message).toContain(`[GET /api/video-jobs/{id}/stream · HTTP ${status}]`)
    expect(d.calls).toEqual(['open 0'])
  })

  it('refused by SanoVids desktop itself: not allowlisted → forbidden, over 1 GB → too-large, too many at once → deferred', async () => {
    const d = desktop(() => ({ status: 200, headers: { 'content-length': String(1024 ** 3 + 1) } }))
    await expect(d.transport.download!({ method: 'GET', path: '/api/me', binary: true })).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('· SanoVids desktop]') })
    const big = await d.api.fetchVideo('job1').catch((x: unknown) => x)
    expect(big).toMatchObject({ code: 'too-large' })
    expect((big as Error).message).toBe('Video lớn hơn 1 GB — SanoVids không tải về máy được. [GET /api/video-jobs/{id}/stream · SanoVids desktop]')

    const full = desktop(() => 'hang', { maxSessions: 1 })
    const first = full.api.fetchVideo('job1')
    first.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    await expect(full.api.fetchVideo('job2')).rejects.toMatchObject({ code: 'deferred' })
    await full.bridge.logout()
  })

  it('cut with a validator → continues where it stopped (Range + If-Range), exact bytes, one video', async () => {
    const video = bytes(500)
    const d = desktop((n, h) =>
      n === 1
        ? { status: 200, headers: { 'content-length': '500', 'accept-ranges': 'bytes', etag: ETAG }, body: [video.slice(0, 300), 'error'] }
        : { status: 206, headers: { 'content-range': `bytes ${h.Range.slice(6, -1)}-499/500`, etag: ETAG }, body: [video.slice(Number(h.Range.slice(6, -1))), 'done'] },
    )
    const progress: DownloadProgress[] = []
    const blob = await d.api.fetchVideo('job1', { onProgress: (p) => progress.push(p) })
    expect(await blobBytes(blob)).toEqual(video)
    expect(d.fetches).toEqual([{ Accept: 'video/mp4,*/*' }, { Accept: 'video/mp4,*/*', Range: 'bytes=300-', 'If-Range': ETAG }])
    expect(d.calls.filter((c) => c.startsWith('open'))).toEqual(['open 0', 'open 300'])
    expect(progress.at(-1)).toEqual({ received: 500, total: 500 })
  })

  it('MONEY: cut WITHOUT a validator (Accept-Ranges alone) → no Range, the download fails (the engine tries again from 0)', async () => {
    const d = desktop(() => ({ status: 200, headers: { 'content-length': '500', 'accept-ranges': 'bytes' }, body: [bytes(300), 'error'] }))
    await expect(d.api.fetchVideo('job1')).rejects.toMatchObject({ code: 'network', message: 'Mất kết nối khi đang tải video từ canvasapp.io.vn.' })
    expect(d.fetches).toHaveLength(1)
    expect(d.lane.active()).toBe(0)
  })

  it('MONEY: a resume answered 200 (the video changed: If-Range failed) drops what came before — no doubled prefix', async () => {
    const before = bytes(500, 1)
    const after = bytes(400, 5)
    const d = desktop((n) =>
      n === 1
        ? { status: 200, headers: { 'content-length': '500', 'accept-ranges': 'bytes', etag: ETAG }, body: [before.slice(0, 300), 'error'] }
        : { status: 200, headers: { 'content-length': '400', 'accept-ranges': 'bytes', etag: '"v2"' }, body: [after, 'done'] },
    )
    const blob = await d.api.fetchVideo('job1')
    expect(await blobBytes(blob)).toEqual(after)
  })

  it('a resume answered 416 → once more from 0 (parts dropped) → complete', async () => {
    const video = bytes(500)
    const d = desktop((n) =>
      n === 1
        ? { status: 200, headers: { 'content-length': '500', 'accept-ranges': 'bytes', etag: ETAG }, body: [video.slice(0, 300), 'error'] }
        : n === 2
          ? { status: 416, headers: { 'content-range': 'bytes */500' } }
          : { status: 200, headers: { 'content-length': '500' }, body: [video, 'done'] },
    )
    expect(await blobBytes(await d.api.fetchVideo('job1'))).toEqual(video)
    expect(d.calls.filter((c) => c.startsWith('open'))).toEqual(['open 0', 'open 300', 'open 0'])
  })

  it('a 206 that serves a part: the rest is asked for until the whole size has come', async () => {
    const video = bytes(500)
    const d = desktop((n, h) => {
      if (n === 1) return { status: 206, headers: { 'content-range': 'bytes 0-199/500', etag: ETAG }, body: [video.slice(0, 200), 'done'] }
      const from = Number(h.Range.slice(6, -1))
      const to = Math.min(499, from + 199)
      return { status: 206, headers: { 'content-range': `bytes ${from}-${to}/500`, etag: ETAG }, body: [video.slice(from, to + 1), 'done'] }
    })
    expect(await blobBytes(await d.api.fetchVideo('job1'))).toEqual(video)
    expect(d.calls.filter((c) => c.startsWith('open'))).toEqual(['open 0', 'open 200', 'open 400'])
  })

  it(`gives up after ${MAX_STALLED_RESUMES} resumes in a row that bring no new byte`, async () => {
    const d = desktop((n) =>
      n === 1
        ? { status: 200, headers: { 'content-length': '500', 'accept-ranges': 'bytes', etag: ETAG }, body: [bytes(300), 'error'] }
        : { status: 206, headers: { 'content-range': 'bytes 300-499/500', etag: ETAG }, body: ['error'] },
    )
    await expect(d.api.fetchVideo('job1')).rejects.toMatchObject({ code: 'network' })
    expect(d.calls.filter((c) => c.startsWith('open'))).toEqual(['open 0', 'open 300', 'open 300'])
    expect(d.lane.active()).toBe(0)
  })

  it('MONEY: fewer bytes than announced, then the end → network error, never a short video', async () => {
    const d = desktop(() => ({ status: 200, headers: { 'content-length': '500' }, body: [bytes(300), 'done'] }))
    await expect(d.api.fetchVideo('job1')).rejects.toMatchObject({ code: 'network', message: 'Video tải về không khớp dung lượng canvasapp.io.vn báo (kết nối bị đóng giữa chừng).' })
  })

  it('MONEY: unknown size, cut by a logout mid-way → an error, never a truncated video', async () => {
    const d = desktop(() => ({ status: 200, headers: {}, body: [bytes(300), 'hang'] }), { chunkBytes: 1000 })
    const p = d.api.fetchVideo('job1')
    const result = p.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1500) // the first 300 bytes are handed out after the flush delay
    await d.bridge.logout()
    const e = await result
    expect(e).toBeInstanceOf(CanvasappError)
    expect(e).toMatchObject({ code: 'network' })
    expect(d.lane.active()).toBe(0)
  })

  it('abort while the download waits for a slot: closed at once with the id the page chose, nothing fetched for it', async () => {
    const d = desktop(() => ({ status: 200, headers: { 'content-length': '500' }, body: ['hang'] }))
    const busy = [d.api.fetchVideo('job1'), d.api.fetchVideo('job2')]
    busy.forEach((p) => p.catch(() => undefined))
    await vi.advanceTimersByTimeAsync(0)
    expect(d.lane.active()).toBe(2)
    const ctrl = new AbortController()
    const third = d.api.fetchVideo('job3', { signal: ctrl.signal }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(0)
    expect(d.lane.waiting()).toBe(1)
    ctrl.abort()
    expect(await third).toMatchObject({ code: 'aborted', message: 'Đã dừng tải video.' })
    expect(d.calls.filter((c) => c === 'close')).toHaveLength(1)
    expect(d.fetches).toHaveLength(2)
    await d.bridge.logout()
    await vi.advanceTimersByTimeAsync(0)
    expect(d.lane.active()).toBe(0)
    expect(d.fetches).toHaveLength(2) // the aborted one never went out
  })

  it('abort during a stalled read: rejects at once (not after the idle timeout), the slot comes back', async () => {
    const d = desktop(() => ({ status: 200, headers: { 'content-length': '500' }, body: [bytes(100), 'hang'] }))
    const ctrl = new AbortController()
    const p = d.api.fetchVideo('job1', { signal: ctrl.signal }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(10)
    expect(d.lane.active()).toBe(1)
    ctrl.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toMatchObject({ code: 'aborted' })
    expect(d.calls).toContain('close')
    expect(d.lane.active()).toBe(0)
    // already aborted: nothing is opened
    const again = await d.api.fetchVideo('job1', { signal: ctrl.signal }).catch((e: unknown) => e)
    expect(again).toMatchObject({ code: 'aborted' })
    expect(d.calls.filter((c) => c.startsWith('open'))).toHaveLength(1)
  })
})
