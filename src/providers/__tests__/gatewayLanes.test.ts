// electron/main.cjs request lanes (its <canvasapp-lanes> block, run as-is): with up to 10 canvasapp jobs running,
// finished videos download in their own small lane, so the job-list poll / a submit never waits behind them.
import { describe, expect, it } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'

type Slot = <T>(lane: 'api' | 'download', fn: () => Promise<T>) => Promise<T>

function loadLanes(): { withSlot: Slot; size: { api: number; download: number } } {
  const m = /\/\/ <canvasapp-lanes>[^\n]*\n([\s\S]*?)\/\/ <\/canvasapp-lanes>/.exec(mainSource)
  if (!m) throw new Error('canvasapp-lanes block not found in electron/main.cjs')
  return new Function(`${m[1]}\nreturn { withSlot: withCanvasappSlot, size: CANVASAPP_LANE_SIZE }`)() as { withSlot: Slot; size: { api: number; download: number } }
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
