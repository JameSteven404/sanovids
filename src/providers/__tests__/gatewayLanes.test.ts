// electron/main.cjs request lanes (its <canvasapp-lanes> block, run as-is): with up to 10 canvasapp jobs running,
// finished videos download in their own small lane, so the job-list poll / a submit never waits behind them.
// Also main's job-list cache (its <canvasapp-job-list-cache> block, run as-is).
import { describe, expect, it } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'

type Slot = <T>(lane: 'api' | 'download', fn: () => Promise<T>, signal?: { aborted: boolean } & Pick<AbortSignal, 'addEventListener' | 'removeEventListener'>) => Promise<T>

function loadLanes(): { withSlot: Slot; size: { api: number; download: number }; lanes: Record<'api' | 'download', { active: number; waiters: unknown[] }> } {
  const m = /\/\/ <canvasapp-lanes>[^\n]*\n([\s\S]*?)\/\/ <\/canvasapp-lanes>/.exec(mainSource)
  if (!m) throw new Error('canvasapp-lanes block not found in electron/main.cjs')
  return new Function(`${m[1]}\nreturn { withSlot: withCanvasappSlot, size: CANVASAPP_LANE_SIZE, lanes: canvasappLanes }`)() as ReturnType<typeof loadLanes>
}

/** A request that stays in flight until `finish()` is called. */
function pending() {
  let finish = () => undefined as void
  const done = new Promise<void>((resolve) => (finish = resolve))
  return { done, finish: () => finish() }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('canvasapp gateway lanes (electron/main.cjs)', () => {
  it('keeps 2 API requests + 2 video downloads in flight at most', () => {
    expect(loadLanes().size).toEqual({ api: 2, download: 2 })
  })

  it('a job-list poll is sent while two long video downloads are still running', async () => {
    const { withSlot } = loadLanes()
    const downloads = [pending(), pending(), pending()]
    const started: string[] = []
    downloads.forEach((d, i) => void withSlot('download', async () => (started.push('video' + i), d.done)))
    await flush()
    expect(started).toEqual(['video0', 'video1']) // the third waits for a download slot

    const poll = withSlot('api', async () => (started.push('poll'), 'jobs'))
    await expect(poll).resolves.toBe('jobs') // not behind the downloads
    expect(started).toEqual(['video0', 'video1', 'poll'])

    downloads[0].finish()
    await flush()
    expect(started).toEqual(['video0', 'video1', 'poll', 'video2'])
    downloads[1].finish()
    downloads[2].finish()
  })

  it('API requests beyond 2 wait their turn (first come, first served), even when the request fails', async () => {
    const { withSlot } = loadLanes()
    const a = pending()
    const b = pending()
    const order: string[] = []
    const p1 = withSlot('api', async () => (order.push('a'), a.done))
    const p2 = withSlot('api', async () => {
      order.push('b')
      await b.done
      throw new Error('network')
    })
    const p3 = withSlot('api', async () => order.push('c'))
    await flush()
    expect(order).toEqual(['a', 'b'])
    b.finish()
    await expect(p2).rejects.toThrow('network')
    await flush()
    expect(order).toEqual(['a', 'b', 'c'])
    a.finish()
    await Promise.all([p1, p3])
  })
})

describe('canvasapp gateway lanes: giving up while waiting (a download closed before its turn)', () => {
  it('leaves the line at once and never runs; the ones behind it keep their turn', async () => {
    const { withSlot, lanes } = loadLanes()
    const a = pending()
    const b = pending()
    const order: string[] = []
    void withSlot('download', async () => (order.push('a'), a.done))
    void withSlot('download', async () => (order.push('b'), b.done))
    const quit = new AbortController()
    const c = withSlot('download', async () => order.push('c'), quit.signal)
    const d = withSlot('download', async () => order.push('d'))
    await flush()
    expect(lanes.download.waiters).toHaveLength(2)
    quit.abort()
    await expect(c).rejects.toThrow('aborted')
    expect(lanes.download.waiters).toHaveLength(1) // only d still waits
    a.finish()
    await d
    expect(order).toEqual(['a', 'b', 'd'])
    // already given up: never waits, never runs
    await expect(withSlot('download', async () => order.push('e'), quit.signal)).rejects.toThrow('aborted')
    b.finish()
    await flush()
    expect(order).toEqual(['a', 'b', 'd'])
    expect(lanes.download).toEqual({ active: 0, waiters: [] })
  })

  it('woken for a slot but given up before its turn ran: the slot goes on to the next one (never lost)', async () => {
    const { withSlot, lanes } = loadLanes()
    const a = pending()
    const b = pending()
    const order: string[] = []
    void withSlot('download', async () => (order.push('a'), a.done))
    void withSlot('download', async () => (order.push('b'), b.done))
    // a signal that turns aborted without telling (the abort lands between the wake-up and its turn)
    const quiet = { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined }
    const c = withSlot('download', async () => order.push('c'), quiet)
    const d = withSlot('download', async () => order.push('d'))
    await flush()
    quiet.aborted = true
    a.finish() // wakes c, which gives up: d gets the slot
    await expect(c).rejects.toThrow('aborted')
    await d
    expect(order).toEqual(['a', 'b', 'd'])
    b.finish()
    await flush()
    expect(lanes.download).toEqual({ active: 0, waiters: [] })
  })
})

interface JobListCache {
  get(key: string): unknown
  ticket(): number
  put(key: string, ticket: number, sentAt: number, result: unknown): void
  drop(): void
}

function loadListCache(clock: { t: number }): JobListCache {
  const m = /\/\/ <canvasapp-job-list-cache>[^\n]*\n([\s\S]*?)\/\/ <\/canvasapp-job-list-cache>/.exec(mainSource)
  if (!m) throw new Error('canvasapp-job-list-cache block not found in electron/main.cjs')
  const create = new Function(`${m[1]}\nreturn createJobListCache`)() as (ttlMs: number, now: () => number) => JobListCache
  return create(15_000, () => clock.t)
}

describe('canvasapp job-list cache (electron/main.cjs)', () => {
  it('an answer is reused 15 s from when its request was SENT, never from when it arrived (a slow answer is never fresher than it is)', () => {
    const clock = { t: 100_000 }
    const cache = loadListCache(clock)
    const ticket = cache.ticket()
    const sentAt = clock.t
    clock.t += 3_000 // canvasapp built the list right away; the answer took 3 s to come back
    cache.put('?project_id=p', ticket, sentAt, { status: 200, json: [] })
    clock.t = sentAt + 14_999
    expect(cache.get('?project_id=p')).toEqual({ status: 200, json: [] })
    clock.t = sentAt + 15_000 // 12 s after it arrived: read again
    expect(cache.get('?project_id=p')).toBeNull()
  })

  it('a job POST (start or end) or a logout drops it, and a read that started before one is never kept', () => {
    const clock = { t: 100_000 }
    const cache = loadListCache(clock)
    cache.put('a', cache.ticket(), clock.t, 1)
    cache.drop() // a POST /api/video-jobs starts
    expect(cache.get('a')).toBeNull()
    const ticket = cache.ticket()
    cache.drop() // ...and ends while this read was on its way
    cache.put('a', ticket, clock.t, 2)
    expect(cache.get('a')).toBeNull()
    cache.put('a', cache.ticket(), clock.t, 3)
    expect(cache.get('a')).toBe(3)
  })

  it('the clock set back: an entry stamped later than now is never served (its age is unknown) — not for the minutes or hours the jump spans', () => {
    // fuzz root cause (canvasapp-fuzz.test.ts, clock set back): served while `now - at < ttl`, a read from before the
    // jump looked fresh until the clock caught up — a lookup after a lost answer then took it for a read that surely
    // shows the POST's job, found nothing and posted it again (a second charge)
    const clock = { t: 10_000_000 }
    const cache = loadListCache(clock)
    cache.put('a', cache.ticket(), clock.t, 1)
    clock.t -= 2 * 3600_000 // the user sets the clock back two hours
    expect(cache.get('a')).toBeNull()
    clock.t += 2 * 3600_000 + 5_000 // ...and the clock has caught up again: an ordinary 5 s old answer
    expect(cache.get('a')).toBe(1)
    clock.t -= 1 // a second ago, 1 ms earlier: still not from the future
    expect(cache.get('a')).toBe(1)
  })

  it('canvasappRequest times an entry from the moment its request goes out (inside its slot), not from the answer', () => {
    const body = /async function canvasappRequest\(req\) \{([\s\S]*?)\n\}\n/.exec(mainSource)?.[1] ?? ''
    const slot = body.indexOf("withCanvasappSlot('api'")
    const stamp = body.indexOf('sentAt = Date.now()')
    const fetch = body.indexOf('canvasappSession().fetch(')
    expect(slot).toBeGreaterThan(0)
    expect(stamp).toBeGreaterThan(slot)
    expect(fetch).toBeGreaterThan(stamp)
    expect(body).toContain('canvasappJobListCache.put(cacheKey, ticket, sentAt, result)')
    expect(body).not.toMatch(/canvasappJobListCache\.set\(/)
  })
})
