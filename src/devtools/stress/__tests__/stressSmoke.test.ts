// Smoke test of the stress tester itself: every headless scenario runs a short seeded session through the real
// stores, queue engine, dev adapter and simulated canvasapp (no network, fake timers), and the runner is
// deterministic (same seed → same steps) and replayable.
// Problems of the APP found here are reported as findings (see _antigravity/KET-QUA-1.md), not hidden: a scenario
// whose known finding is listed in KNOWN is expected to report exactly that invariant.
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('idb-keyval', () => import('./memoryDb'))

const media = vi.hoisted(() => new Map<string, Blob>())
vi.mock('../../../lib/imageStore', () => {
  let n = 0
  return {
    putBlob: vi.fn(async (b: Blob, prefix = 'img') => {
      const id = `${prefix}_${++n}`
      media.set(id, b)
      return id
    }),
    getBlob: vi.fn(async (id: string) => media.get(id) ?? null),
    getUrl: vi.fn(async () => null),
    cachedUrl: () => null,
    deleteMedia: vi.fn(async (id: string) => void media.delete(id)),
    dataUrlToBlob: () => new Blob(),
    useMediaUrl: () => null,
    revokeUnusedUrls: () => undefined,
  }
})

import { clearDevLog, pushDevLog, useDevLog } from '../../../providers/dev'
import { devProvider, getProvider, useProviderPrefs } from '../../../providers'
import { applyDevAccessState, bareState, useDevAccess } from '../../../providers/devAccess'
import { getBlob } from '../../../lib/imageStore'
import { runStress, shrinkFailure } from '../runner'
import { SCENARIOS } from '../scenarios'
import { summaryText, toMarkdown } from '../report'
import { createRng } from '../rng'
import { matchesVideo, sessionActive, startSession, stopActiveSession, stressVideo } from '../session'
import { createHeadless, type Headless } from './headlessEnv'

let h: Headless | null = null
afterEach(() => {
  h?.dispose()
  h = null
  media.clear()
})

const run = async (scenario: string, seed: string, steps = 150, extra: Partial<Parameters<typeof runStress>[0]> = {}) => {
  h = createHeadless(seed)
  return runStress({ scenarios: [scenario], seed, steps, maxMs: 0, checkEvery: 10, stopOnFirst: true, tier: 'S', ...extra }, h.env)
}

describe('stress tester: every headless scenario runs', () => {
  for (const s of SCENARIOS.filter((x) => x.headless)) {
    it(`${s.id}`, async () => {
      const r = await run(s.id, 'c0ffee01')
      if (r.result !== 'pass') console.log(s.id, summaryText(r), JSON.stringify(r.failure?.detail ?? null).slice(0, 800))
      expect(r.result).not.toBe('harness-error')
      expect(r.result, summaryText(r)).toBe('pass')
      expect(r.steps).toBeGreaterThan(0)
      expect(r.log.length).toBeGreaterThan(0)
      expect(sessionActive()).toBe(false)
      // the app's providers are back
      expect(getProvider('dev').label).not.toContain('thử nghiệm')
      expect(useDevLog.getState().entries.filter((e) => e.fault === 'not-allowed')).toEqual([])
      expect(toMarkdown(r)).toContain(r.seed)
      const coverage: Record<string, string[]> = {
        'placeholder-churn': ['placeholder.filled', 'placeholder.replaced'],
        'editor-drafts': ['editor.persistPending', 'editor.persistSwitch', 'editor.operation.0', 'editor.operation.1', 'editor.operation.2', 'editor.operation.3', 'transport.checked', 'film.starred'],
        'library-bulk': ['library.deleteUndo.1', 'library.deleteUndo.200'],
        'download-chaos': ['download.cut', 'download.stall', 'download.oversize', 'download.resumed', 'download.savedVerified'],
        // imported while an app POST was still unresolved (lost answer / 502 / slow site): the ownership window was open
        'import-jobs': ['import.adopted', 'import.staleScanRetried', 'import.whileUnresolvedPost', 'import.forcedEnd'],
        // a take waited (queued / mid-submit) while logged out: RL3 had something to catch
        relogin: ['login.kept', 'login.notKept', 'login.workWhileOut'],
      }
      for (const key of coverage[s.id] ?? []) expect(r.coverage?.[key] ?? 0, key).toBeGreaterThan(0)
    }, 120_000)
  }
})

describe('stress tester: action timings', () => {
  it('an action\'s own pauses (env.advance) are not counted in its time — "Gõ nhanh" waits 40 ms every 10 keys', async () => {
    h = createHeadless('7177e5e1')
    // a clock that only moves when time is asked to pass, like the app's real sleeps would make it
    let now = 0
    const base = h.env
    const env = { ...base, clock: () => now, advance: async (ms: number) => { now += Math.max(0, ms); await base.advance(ms) } }
    const r = await runStress({ scenarios: ['typing-storm'], seed: '7177e5e1', steps: 60, maxMs: 0, checkEvery: 10, stopOnFirst: true, tier: 'S' }, env)
    const typing = r.metrics.perAction['scene.type']
    expect(typing?.n ?? 0).toBeGreaterThan(5)
    // before: up to 8 pauses of 40 ms each → p95 ≥ 40 on this clock; now the app's work only (0 on this clock)
    expect(typing!.max).toBeLessThan(40)
  }, 120_000)
})

describe('stress tester: reproducible and safe', () => {
  it('refuses a locked development mode without opening a session', async () => {
    h = createHeadless('deadbeef')
    const before = useDevAccess.getState().state
    try {
      applyDevAccessState(bareState('locked'))
      const r = await runStress({ scenarios: ['editor-drafts'], seed: 'deadbeef', steps: 10, maxMs: 0, checkEvery: 1, stopOnFirst: true }, h.env)
      expect(r.result).toBe('harness-error')
      expect(r.failure?.message).toContain('khoá')
      expect(r.steps).toBe(0)
      expect(sessionActive()).toBe(false)
    } finally { applyDevAccessState(before) }
  })

  it('stops when development mode is locked mid-run: result stopped, a note, the session closed', async () => {
    h = createHeadless('5eed10c4')
    const before = useDevAccess.getState().state
    try {
      let n = 0
      const r = await runStress(
        { scenarios: ['monkey'], seed: '5eed10c4', steps: 200, maxMs: 0, checkEvery: 10, stopOnFirst: true, tier: 'S', onProgress: () => { if (++n === 12) applyDevAccessState(bareState('locked')) } },
        h.env,
      )
      expect(r.result).toBe('stopped')
      expect(r.steps).toBe(12)
      expect(r.notes.some((t) => t.includes('khoá'))).toBe(true)
      expect(sessionActive()).toBe(false)
      expect(getProvider('dev').label).not.toContain('thử nghiệm')
    } finally { applyDevAccessState(before) }
  }, 120_000)

  it('keep-going: a failure recorded before development mode is locked stays the result', async () => {
    h = createHeadless('5eed10c5')
    const base = h.env
    const before = useDevAccess.getState().state
    try {
      let drains = 0
      let n = 0
      // drainErrors runs once before the loop, then once per step: the 5th call = an R1 error at step 4
      const env = { ...base, drainErrors: () => [...base.drainErrors(), ...(++drains === 5 ? ['Lỗi giả lập của test'] : [])] }
      const r = await runStress(
        { scenarios: ['monkey'], seed: '5eed10c5', steps: 200, maxMs: 0, checkEvery: 10, stopOnFirst: false, tier: 'S', onProgress: () => { if (++n === 10) applyDevAccessState(bareState('locked')) } },
        env,
      )
      expect(r.failure?.invariant).toBe('R1')
      expect(r.result).toBe('fail')
      expect(r.steps).toBe(10)
      expect(sessionActive()).toBe(false)
    } finally { applyDevAccessState(before) }
  }, 120_000)

  it('login.restart never resets the app\'s own dev gateway when the session is stopped during the action', async () => {
    h = createHeadless('70ce1a57')
    const base = h.env
    const appReset = vi.spyOn(devProvider(), 'reset')
    let stopped = false
    try {
      // what the in-app sandbox does when another project is opened / development mode locks mid-action
      const env = {
        ...base,
        advance: async (ms: number) => {
          await base.advance(ms)
          if (!stopped) {
            stopped = true
            stopActiveSession()
          }
        },
      }
      const r = await runStress(
        { scenarios: ['relogin'], seed: '70ce1a57', steps: 0, maxMs: 0, checkEvery: 10, stopOnFirst: true, tier: 'S', shouldStop: () => stopped, replay: [{ n: 1, id: 'login.restart', args: { s: 0, s2: 0, keep: false, logout: true, retry: false } }] },
        env,
      )
      expect(stopped).toBe(true)
      expect(r.result).not.toBe('harness-error')
      expect(appReset).not.toHaveBeenCalled()
      expect(sessionActive()).toBe(false)
    } finally { appReset.mockRestore() }
  }, 120_000)

  it('the job audit runs after a job POST, not on every change of the simulated site', async () => {
    h = createHeadless('0a0d17ed')
    const s = startSession({ rng: createRng('0a0d17ed'), kind: 'headless' })
    try {
      let calls = 0
      const off = s.onJobsChanged(() => calls++)
      s.server.setConfig({ latencyMs: 0 })
      s.server.logout()
      s.server.login()
      await s.server.request({ method: 'GET', path: '/api/me' })
      expect(calls).toBe(0)
      await s.server.request({ method: 'POST', path: '/api/video-jobs', json: {} })
      expect(calls).toBe(1)
      off()
      await s.server.request({ method: 'POST', path: '/api/video-jobs', json: {} })
      expect(calls).toBe(1)
    } finally { s.stop() }
    expect(sessionActive()).toBe(false)
  })

  it('RL3: a job POST is an error only once the app knows it is logged out', async () => {
    h = createHeadless('0a0d17ee')
    const s = startSession({ rng: createRng('0a0d17ee'), kind: 'headless' })
    const rl3 = () => s.trips.filter((t) => t.invariant === 'RL3').length
    try {
      s.server.setConfig({ latencyMs: 0 })
      // logged out on the site's side: the first refused request (here the POST itself) is how the app learns it
      s.server.logout()
      await s.server.request({ method: 'POST', path: '/api/video-jobs', json: {} })
      expect(rl3()).toBe(0)
      // ...after that answer, another POST is the bug
      await s.server.request({ method: 'POST', path: '/api/video-jobs', json: {} })
      expect(rl3()).toBe(1)
      // a login starts afresh; the app's own Đăng xuất counts as knowing at once
      s.server.login()
      await s.bridge.logout()
      await s.server.request({ method: 'POST', path: '/api/video-jobs', json: {} })
      expect(rl3()).toBe(2)
    } finally { s.stop() }
  })

  it('tiny videos unless the plan checks resumed downloads; the byte check catches any change', async () => {
    const small = stressVideo(7)
    expect(small.size).toBeLessThan(32)
    expect(await matchesVideo(small, 7)).toBe(true)
    expect(await matchesVideo(small, 8)).toBe(false)
    const big = stressVideo(7, true)
    // more than two 64 KB gateway chunks, and within one connection's 2 min even at "trickle 2 KB/s"
    expect(big.size).toBeGreaterThan(2 * 64 * 1024)
    expect(big.size).toBeLessThanOrEqual(2 * 1024 * 120)
    expect(await matchesVideo(big, 7, true)).toBe(true)
    expect(await matchesVideo(big, 7)).toBe(false)
    expect(await matchesVideo(stressVideo(17, true), 7, true)).toBe(false)
    const bytes = new Uint8Array(await big.arrayBuffer())
    expect(await matchesVideo(new Blob([bytes.slice(0, bytes.length - 1)]), 7, true)).toBe(false)
    bytes[bytes.length >> 1] ^= 1
    expect(await matchesVideo(new Blob([bytes]), 7, true)).toBe(false)
    expect(await matchesVideo(null, 7)).toBe(false)
  })

  it('detects corrupted persisted video bytes (DL1), not just a completed status', async () => {
    vi.mocked(getBlob).mockImplementation(async (id) => id.startsWith('video_') ? new Blob(['truncated']) : media.get(id) ?? null)
    try {
      const r = await run('download-chaos', '5a17c0de', 30)
      expect(r.result).toBe('fail')
      expect(r.failure?.invariant).toBe('DL1')
    } finally { vi.mocked(getBlob).mockImplementation(async (id) => media.get(id) ?? null) }
  }, 120_000)
  it('same seed → same steps; replay reproduces the run', async () => {
    const a = await run('monkey', 'abad1dea', 200)
    h?.dispose()
    const b = await run('monkey', 'abad1dea', 200)
    expect(b.log).toEqual(a.log)
    expect(b.result).toBe(a.result)
    h?.dispose()
    const c = await run('monkey', 'abad1dea', 0, { replay: a.log })
    expect(c.log.map((s) => s.id)).toEqual(a.log.map((s) => s.id))
    expect(c.result).toBe(a.result)
  }, 240_000)

  it('another seed draws other steps', async () => {
    const a = await run('monkey', '00000001', 80)
    h?.dispose()
    const b = await run('monkey', '00000002', 80)
    expect(b.log.map((s) => s.id)).not.toEqual(a.log.map((s) => s.id))
  }, 120_000)

  it('stops when asked and puts the providers back', async () => {
    let n = 0
    const r = await run('monkey', 'feedface', 1000, { shouldStop: () => ++n > 30 })
    expect(r.result).toBe('stopped')
    expect(r.steps).toBeLessThan(1000)
    expect(sessionActive()).toBe(false)
  }, 120_000)

  it('refuses to run when the real service is selected', async () => {
    h = createHeadless('deadbeef')
    // a fake desktop bridge makes 'canvasapp' the effective provider; it must never be called
    const request = vi.fn(async () => {
      throw new Error('real canvasapp called')
    })
    const hadWindow = typeof window !== 'undefined'
    if (hadWindow) (window as unknown as { bdpDesktop?: unknown }).bdpDesktop = { canvasapp: { request } }
    else vi.stubGlobal('window', { bdpDesktop: { canvasapp: { request } } })
    try {
      useProviderPrefs.setState({ provider: 'canvasapp' })
      const r = await runStress({ scenarios: ['monkey'], seed: 'deadbeef', steps: 50, maxMs: 0, checkEvery: 10, stopOnFirst: true, tier: 'S' }, h.env)
      expect(r.result).toBe('harness-error')
      expect(r.steps).toBe(0)
      expect(r.server.requests).toBe(0)
      expect(request).not.toHaveBeenCalled()
    } finally {
      useProviderPrefs.setState({ provider: 'dev' })
      if (hadWindow) delete (window as unknown as { bdpDesktop?: unknown }).bdpDesktop
      else vi.unstubAllGlobals()
    }
  })

  it('a request-log line from before the run (another run, the user) is never judged as this run\'s (S2)', async () => {
    pushDevLog({ at: 0, method: 'GET', path: '/api/admin', endpoint: null, status: null, ms: 0, req: null, res: null, fault: 'not-allowed', processed: false })
    try {
      const r = await run('run-cancel', 'c0ffee01')
      expect(r.failure?.invariant ?? null).not.toBe('S2')
      expect(r.result).toBe('pass')
      // the run did log requests of its own after that line (so they were looked at)
      expect(useDevLog.getState().entries.length).toBeGreaterThan(1)
    } finally {
      clearDevLog()
    }
  }, 120_000)

  it('shrinking a passing run changes nothing', async () => {
    const base = await run('link-unlink', '13572468', 60)
    expect(base.result).toBe('pass')
    const opts = { scenarios: ['link-unlink'], seed: '13572468', steps: 60, maxMs: 0, checkEvery: 10, stopOnFirst: true, tier: 'S' as const }
    const s = await shrinkFailure(base, opts, h!.env, 5)
    expect(s.runs).toBe(0)
    expect(s.log).toEqual(base.log)
  }, 120_000)
})
