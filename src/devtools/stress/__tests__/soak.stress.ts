// Long headless soak of the stress tester (not part of `npm test`: the file name does not match *.test.ts).
// Run it with `node scripts/stress/run-stress.mjs` (which uses scripts/stress/vitest.stress.config.mts). Env:
//   STRESS_SCENARIOS  comma list (default "monkey"); "all" = every headless scenario
//   STRESS_EACH       "1" = one run per scenario instead of their weights added together
//   STRESS_SEED       8 hex digits (default random)        STRESS_STEPS   default 2000 (0 = until STRESS_MINUTES)
//   STRESS_TIER       S | M | L | XL | XXL | OVER           STRESS_MINUTES wall-clock budget per run (default 10)
//   STRESS_FAULTS     none | sometimes | storm              STRESS_CHECK   full invariants every N steps (default 25)
//   STRESS_KEEP_GOING "1" = do not stop at the first error
//   STRESS_REPLAY     path of a report .json → replay its log exactly (same seed / scenarios / size)
//   STRESS_SHRINK     "1" = on failure, shrink the log (ddmin) and write the smaller replay too
//   STRESS_OUT        report folder (default .stress/reports)
// Reports: <out>/sanovids-stress-<seed>-<result>.json + .md. The run fails (exit code ≠ 0) when a run fails.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

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

import { runStress, shrinkFailure } from '../runner'
import { SCENARIOS } from '../scenarios'
import { parseSeed, randomSeed } from '../rng'
import { summaryText, toJSON, toMarkdown, reportFileName } from '../report'
import { createHeadless, type Headless } from './headlessEnv'
import type { FaultLevel, StressOptions, StressReport, Tier } from '../types'

const env = process.env
const outDir = resolve(env.STRESS_OUT || '.stress/reports')
const minutes = Number(env.STRESS_MINUTES ?? 10)
const replayFrom: StressReport | null = env.STRESS_REPLAY ? JSON.parse(readFileSync(resolve(env.STRESS_REPLAY), 'utf8')) : null

const all = SCENARIOS.filter((s) => s.headless).map((s) => s.id)
const picked = replayFrom ? replayFrom.spec.scenarios : !env.STRESS_SCENARIOS || env.STRESS_SCENARIOS === 'monkey' ? ['monkey'] : env.STRESS_SCENARIOS === 'all' ? all : env.STRESS_SCENARIOS.split(',').map((s) => s.trim()).filter(Boolean)
const groups = replayFrom ? [picked] : env.STRESS_EACH === '1' ? picked.map((s) => [s]) : [picked]
const seed = replayFrom?.seed ?? parseSeed(env.STRESS_SEED) ?? randomSeed()

const optionsFor = (scenarios: string[]): StressOptions =>
  replayFrom
    ? { ...replayFrom.spec, scenarios, seed, replay: replayFrom.log }
    : {
        scenarios,
        seed,
        steps: Math.max(0, Number(env.STRESS_STEPS ?? 2000)),
        maxMs: Math.max(0, minutes) * 60_000,
        tier: (env.STRESS_TIER as Tier | undefined) || undefined,
        faults: (env.STRESS_FAULTS as FaultLevel | undefined) || undefined,
        checkEvery: Math.max(1, Number(env.STRESS_CHECK ?? 25)),
        stopOnFirst: env.STRESS_KEEP_GOING !== '1',
      }

const write = (r: StressReport, suffix = '') => {
  mkdirSync(outDir, { recursive: true })
  const base = reportFileName(r, 'json').replace(/\.json$/, '') + (r.spec.scenarios.length === 1 ? `-${r.spec.scenarios[0]}` : '') + suffix
  writeFileSync(join(outDir, base + '.json'), toJSON(r))
  writeFileSync(join(outDir, base + '.md'), toMarkdown(r))
  return join(outDir, base)
}

let h: Headless | null = null
afterEach(() => {
  h?.dispose()
  h = null
  media.clear()
})

for (const scenarios of groups) {
  it(
    `soak ${scenarios.join('+')} seed ${seed}`,
    async () => {
      h = createHeadless(seed)
      const options = optionsFor(scenarios)
      const report = await runStress(options, h.env)
      const file = write(report)
      console.log(`\n${summaryText(report)}\n→ ${file}.json / .md\n`)
      if (report.result === 'fail' && env.STRESS_SHRINK === '1') {
        const s = await shrinkFailure(report, options, h.env)
        if (s.report) {
          const small = write({ ...s.report, log: s.log }, '-shrunk')
          console.log(`Rút gọn: ${report.failure?.step} → ${s.log.length} bước sau ${s.runs} lần chạy lại → ${small}.json`)
        }
      }
      expect(report.result, summaryText(report)).not.toBe('harness-error')
      expect(report.result, summaryText(report)).not.toBe('fail')
    },
    (minutes > 0 ? minutes * 60_000 : 24 * 3_600_000) * (env.STRESS_SHRINK === '1' ? 3 : 1) + 15 * 60_000,
  )
}
