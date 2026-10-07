// Headless environment for the stress runner (vitest, node): fake timers for simulated time, real timers for the
// watchdog, seeded ids, console.error / unhandled rejections captured as R1, and the app's engine wired like the
// dev-mode e2e tests (no Web Locks, no persistence hooks, development mode chosen).
// The test file that uses it must vi.mock('../../../lib/imageStore') (see stressSmoke.test.ts).
import { vi } from 'vitest'
import { setEngineHooks, setEngineLockManager, useRuns } from '../../../store/runs'
import { useProviderPrefs } from '../../../providers'
import { useDownloadPrefs } from '../../../lib/downloads'
import { createRng, seededUuid } from '../rng'
import type { StressEnv } from '../types'

const realSetTimeout = globalThis.setTimeout
const realPerfNow = performance.now.bind(performance)
const realNow = () => realPerfNow()

export interface Headless {
  env: StressEnv
  /** Undo everything (timers, spies, crypto, listeners). */
  dispose(): void
}

/** Simulated ms the end-of-run quiescence may wait (poll back-off up to 10 min + download retries ~8.5 min). */
export const HEADLESS_DRAIN_MS = 25 * 60_000

export function createHeadless(seed: string): Headless {
  vi.useFakeTimers()
  vi.setSystemTime(1_750_000_000_000)
  setEngineLockManager(null)
  setEngineHooks({})
  useProviderPrefs.setState({ provider: 'dev' })
  useDownloadPrefs.setState({ autoDownload: false })

  const errors: string[] = []
  const origError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safe(a))).join(' '))
  }
  const onRejection = (reason: unknown) => errors.push('Unhandled rejection: ' + ((reason as Error)?.message ?? String(reason)))
  process.on('unhandledRejection', onRejection)

  const cryptoObj = globalThis.crypto as Crypto & { randomUUID: () => string }
  const origUuid = cryptoObj.randomUUID
  const uuid = seededUuid(createRng(seed, `${seed}/uuid`))
  Object.defineProperty(cryptoObj, 'randomUUID', { value: uuid, configurable: true, writable: true })

  const env: StressEnv = {
    kind: 'headless',
    advance: async (ms) => {
      if (ms > 0) await vi.advanceTimersByTimeAsync(ms)
    },
    clock: realNow,
    realSleep: (ms) => new Promise((r) => realSetTimeout(r, ms)),
    putMedia: () => undefined,
    drainErrors: () => errors.splice(0),
    drainBudgetMs: HEADLESS_DRAIN_MS,
  }
  return {
    env,
    dispose: () => {
      useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
      vi.clearAllTimers()
      vi.useRealTimers()
      console.error = origError
      process.off('unhandledRejection', onRejection)
      Object.defineProperty(cryptoObj, 'randomUUID', { value: origUuid, configurable: true, writable: true })
    },
  }
}

function safe(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
