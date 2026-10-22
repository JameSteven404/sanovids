import { flushSync } from 'react-dom'
import { perfCanvas, probeVersion, readCounts, readProbe, resetProbe } from './probe'
import { stats, type PerfResult } from './report'

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export const frame = () => document.visibilityState === 'visible'
  ? new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) : pause(16)

export async function settle(selector: string) {
  const deadline = performance.now() + 10000
  let previous = '', stable = 0
  while (performance.now() < deadline) {
    await frame()
    const root = document.querySelector(selector)
    if (!root) continue
    const state = `${probeVersion()}:${root.childElementCount}:${root.getBoundingClientRect().height}`
    stable = state === previous ? stable + 1 : 0
    previous = state
    if (stable >= 3) return
  }
  throw new Error('Giao diện chưa ổn định sau 10 giây.')
}

/** Includes synchronous React work, RF measurement and style/layout; never calls this paint time. */
export async function work(action: () => void | Promise<void>): Promise<number> {
  const start = performance.now()
  let pending: void | Promise<void>
  flushSync(() => { pending = action() })
  await pending!
  await Promise.resolve()
  // The registered hook mirrors RF's ResizeObserver update, including the force flag when hidden.
  // Running it within this slice includes RF/layout work instead of counting idle rAF wait as work.
  if (document.querySelector('.react-flow')) {
    if (!perfCanvas()) throw new Error('Thiếu registerPerfCanvas để đo React Flow.')
    flushSync(() => perfCanvas()!.measure())
  }
  document.querySelector('.react-flow')?.getBoundingClientRect()
  void document.body.offsetHeight
  const elapsed = performance.now() - start
  // Idle time before the next frame is not main-thread work.
  await frame()
  return elapsed
}

export async function measure(run: (sample: typeof work) => Promise<void>, signal: AbortSignal) {
  resetProbe()
  const values: number[] = []
  const maxCounts: Record<string, number> = {}
  const intervals: number[] = []
  const loaf: number[] = []
  let visible = document.visibilityState === 'visible' && window.__SANOVIDS_PERF_HEADED__ !== false
  let last = performance.now(), raf = 0
  const tick = (time: number) => { visible &&= document.visibilityState === 'visible'; intervals.push(time - last); last = time; raf = requestAnimationFrame(tick) }
  let observer: PerformanceObserver | undefined
  if (visible) {
    raf = requestAnimationFrame(tick)
    if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
      observer = new PerformanceObserver((list) => loaf.push(...list.getEntries().map((e) => e.duration)))
      observer.observe({ type: 'long-animation-frame' })
    }
  }
  try {
    await run(async (action) => {
      signal.throwIfAborted()
      if (!values.length) {
        resetProbe(); intervals.length = 0; loaf.length = 0; last = performance.now(); observer?.takeRecords()
      }
      const before = readCounts()
      const ms = await work(action)
      for (const [key, count] of Object.entries(readCounts())) maxCounts[key] = Math.max(maxCounts[key] ?? 0, count - (before[key] ?? 0))
      values.push(ms)
      return ms
    })
  } finally {
    cancelAnimationFrame(raf)
    if (observer) { loaf.push(...observer.takeRecords().map((e) => e.duration)); observer.disconnect() }
  }
  return { values, maxCounts, frameIntervals: visible ? intervals : [], renders: readProbe(), estimated: !visible,
    frames: visible ? { intervals: stats(intervals), over33: intervals.length ? intervals.filter((x) => x > 33).length / intervals.length : 0,
      loafMax: Math.max(0, ...loaf) } satisfies PerfResult['frames'] : null }
}
