// Smoke test of the stress tester itself: every headless scenario runs a short seeded session through the real
// stores, queue engine, dev adapter and simulated canvasapp (no network, fake timers), and the runner is
// deterministic (same seed → same steps) and replayable.
// Problems of the APP found here are reported as findings (see _antigravity/KET-QUA-1.md), not hidden: a scenario
// whose known finding is listed in KNOWN is expected to report exactly that invariant.
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  }
})

import { clearDevLog, pushDevLog, useDevLog } from '../../../providers/dev'
import { getProvider, useProviderPrefs } from '../../../providers'
import { runStress, shrinkFailure } from '../runner'
import { SCENARIOS } from '../scenarios'
import { summaryText, toMarkdown } from '../report'
import { sessionActive } from '../session'
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
      expect(r.steps).toBeGreaterThan(0)
      expect(r.log.length).toBeGreaterThan(0)
      expect(sessionActive()).toBe(false)
      // the app's providers are back
      expect(getProvider('dev').label).not.toContain('thử nghiệm')
      expect(useDevLog.getState().entries.filter((e) => e.fault === 'not-allowed')).toEqual([])
      expect(toMarkdown(r)).toContain(r.seed)
    }, 120_000)
  }
})

describe('stress tester: reproducible and safe', () => {
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
