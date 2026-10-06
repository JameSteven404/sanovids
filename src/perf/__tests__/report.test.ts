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
    expect(relativeBudget('tableScroll', 100)).toBe(60)
    expect(relativeBudget('storyboardReorder', 100)).toBe(100)
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
  it('applies relative A9 budgets to matching baselines', () => {
    const before = report(100), after = report(70)
    before.results[0].id = after.results[0].id = 'tableScroll'
    after.results[0].budget = null
    expect(reportExitCode(after, before)).toBe(1)
    const compared = withBaselineBudgets(after, before)
    expect(compared.results[0].budget).toBe(60)
    expect(compared.results[0].status).toBe('fail')
    expect(after.results[0].budget).toBeNull()
  })
})
