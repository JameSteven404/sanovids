import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { budgetFor, relativeBudget } from '../budgets'
import { compare, reportExitCode, withBaselineBudgets, stats, verdict, type PerfReport } from '../report'

const report = (value: number): PerfReport => ({ version: 1, marker: 'sanovids-perf-harness', at: '', size: 'L', spec: { scenes: 600, takes: 1200 }, dataHash: 'hash', runs: 3, complete: true,
  machine: { userAgent: 'test', cores: 8, viewport: [1440, 900], dpr: 1, target: 'web', headed: false },
  results: [{ id: 'pan', label: 'Kéo', workMs: stats([value]), budget: 6, status: verdict(value, 6), estimated: true, renders: { counts: {}, commits: {}, durations: {} }, frames: null, assertions: [] }] })
describe('performance report math', () => {
  it('uses median and nearest-rank p95; missing data never passes', () => {
    expect(stats([4, 1, 3, 2])).toEqual({ median: 2.5, p95: 4, max: 4, count: 4 })
    expect(stats(Array.from({ length: 100 }, (_, i) => i + 1))?.p95).toBe(95)
    expect(stats([])).toBeNull()
    expect(verdict(null, 6)).toBe('unavailable')
    expect(verdict(2, null)).toBe('unbudgeted')
  })
  it('uses tier and relative budgets and the 10% release tolerance', () => {
    expect(budgetFor('pan', 'M')).toBeCloseTo(3.6)
    expect(budgetFor('autosaveRuns', 'XL')).toBe(12)
    expect(budgetFor('pan', 'custom')).toBeNull()
    expect(reportExitCode(report(6.6))).toBe(0)
    expect(reportExitCode(report(6.61))).toBe(1)
    expect(reportExitCode({ ...report(1), complete: false })).toBe(2)
  })
  it('compares matching runs only, flags over 15%, and keeps memory/assertion failures', () => {
    expect(compare(report(4), report(4.6))).toEqual([])
    expect(compare(report(4), report(4.61))).toHaveLength(1)
    expect(() => compare(report(4), { ...report(4), dataHash: 'other' })).toThrow()
    expect(reportExitCode({ ...report(4), memory: { heaps: [], urlCounts: [], passed: false } })).toBe(1)
    const failed = report(4)
    failed.results[0].assertions.push({ label: 'Không commit', passed: false })
    expect(reportExitCode(failed)).toBe(1)
  })
  it('a baseline adds no budget where no relative budget exists (the A9 ones left with the hidden views)', () => {
    const before = report(100), after = report(70)
    before.results[0].id = after.results[0].id = 'tableScroll'
    after.results[0].budget = null
    after.results[0].status = 'unbudgeted'
    expect(withBaselineBudgets(after, before).results[0]).toEqual(after.results[0])
    expect(reportExitCode(after, before)).toBe(0)
    // Incompatible runs are still refused before any budget is assigned.
    expect(() => withBaselineBudgets(after, { ...before, dataHash: 'other' })).toThrow()
  })
})

describe('scenarios of the hidden views are gone (0.6.0 shows the canvas only)', () => {
  const RETIRED = ['returnCanvas', 'tableScroll', 'storyboardOpen', 'storyboardReorder']
  it('no budget, no relative budget', () => {
    for (const id of RETIRED) {
      for (const size of ['M', 'L', 'XL'] as const) expect(budgetFor(id, size), id).toBeNull()
      expect(relativeBudget(id, 100), id).toBeNull()
    }
    expect(relativeBudget('__proto__', 100)).toBeNull()
  })
  it('no scenario switches to Bảng cảnh / Storyboard', () => {
    const source = readFileSync(new URL('../scenarios.ts', import.meta.url), 'utf8')
    for (const id of RETIRED) expect(source).not.toContain(`id: '${id}'`)
    expect(source).not.toMatch(/view: '(table|storyboard)'|\.vw-(table|sb)/)
    expect(source).toContain("id: 'open'")
  })
})
