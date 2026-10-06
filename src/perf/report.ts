import type { ProbeSnapshot } from './probe'
import type { PerfSize, SynthSpec } from './synth'
import { relativeBudget } from './budgets'

export function stats(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const n = sorted.length
  return { median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    p95: sorted[Math.ceil(n * 0.95) - 1], max: sorted[n - 1], count: n }
}
export interface PerfResult {
  id: string
  label: string
  workMs: ReturnType<typeof stats>
  budget: number | null
  status: 'pass' | 'fail' | 'unavailable' | 'unbudgeted'
  reason?: string
  estimated: boolean
  renders: ProbeSnapshot
  maxRenders?: Record<string, number>
  frames: { intervals: ReturnType<typeof stats>; over33: number; loafMax: number } | null
  assertions: { label: string; passed: boolean }[]
}
export interface PerfReport {
  version: 1
  marker: string
  at: string
  machine: { userAgent: string; cores: number; viewport: number[]; dpr: number; target: 'web' | 'exe'; headed: boolean }
  size: PerfSize | 'custom'
  spec: SynthSpec
  dataHash: string
  runs: number
  results: PerfResult[]
  memory?: { heaps: number[]; urlCounts: number[]; passed: boolean }
  host?: { platform: string; release: string; cpu?: string; node: string }
  complete: boolean
}
export function verdict(value: number | null, budget: number | null): PerfResult['status'] {
  return value === null ? 'unavailable' : budget === null ? 'unbudgeted' : value <= budget ? 'pass' : 'fail'
}
export function compare(a: PerfReport, b: PerfReport) {
  if (a.version !== b.version || a.size !== b.size || a.dataHash !== b.dataHash
    || JSON.stringify(a.machine) !== JSON.stringify(b.machine) || JSON.stringify(a.host) !== JSON.stringify(b.host)) throw new Error('Hai lần đo khác dữ liệu hoặc điều kiện máy; không so sánh.')
  return b.results.flatMap((result) => {
    const before = a.results.find((r) => r.id === result.id)?.workMs?.p95
    const after = result.workMs?.p95
    return before !== undefined && after !== undefined && after > before * 1.15
      ? [{ id: result.id, label: 'Chậm hơn', percent: before ? (after / before - 1) * 100 : null }] : []
  })
}
export function reportExitCode(report: PerfReport, baseline?: PerfReport): 0 | 1 | 2 {
  if (!report.complete) return 2
  if (baseline) {
    const regressions = compare(baseline, report)
    report = withBaselineBudgets(report, baseline)
    if (regressions.length) return 1
  }
  if (report.memory?.passed === false || report.results.some((r) => r.assertions.some((a) => !a.passed)
    || (r.budget !== null && r.workMs !== null && r.workMs.p95 > r.budget * 1.1))) return 1
  return 0
}

export function withBaselineBudgets(report: PerfReport, baseline?: PerfReport): PerfReport {
  if (!baseline) return report
  compare(baseline, report) // Reject incompatible measurements before assigning relative budgets.
  return { ...report, results: report.results.map((result) => {
    const before = baseline.results.find((r) => r.id === result.id)?.workMs?.p95
    const budget = before === undefined ? null : relativeBudget(result.id, before)
    return budget === null ? result : { ...result, budget,
      status: result.assertions.some((a) => !a.passed) ? 'fail' : verdict(result.workMs?.p95 ?? null, budget) }
  }) }
}
