// UI state + controller of the "Test giới hạn" tab. Module-level on purpose: a run goes on when the dev panel is closed
// (StressHud shows it), and only one run can exist. Select primitives / existing objects from useStress.
// Light on purpose (StressHud imports it at start-up in development mode): the tester itself (sandbox → runner →
// actions…) and the report formatting load only when a run starts / a report is saved.
import { create } from 'zustand'
import { rememberReport } from './manifest'
import { randomSeed, parseSeed } from './rng'
import type { FaultLevel, StressProgress, StressReport, Tier } from './types'

export type StressPhase = 'idle' | 'running' | 'stopping' | 'restoring'

export interface StressForm {
  scenarios: string[]
  /** 'auto' = the scenarios' own size. */
  tier: Tier | 'auto'
  steps: number
  /** 0 = no time limit. */
  minutes: number
  seed: string
  faults: FaultLevel | 'auto'
  checkEvery: number
  stopOnFirst: boolean
}

export interface StressState extends StressForm {
  phase: StressPhase
  progress: StressProgress | null
  report: StressReport | null
  /** Why the last start was refused / what went wrong outside the run (Vietnamese). */
  error: string | null
  /** "Đang trả lại dự án của bạn…" while restoring. */
  phaseText: string
  /** A snapshot of the project at the first error exists ("Lưu dự án lỗi"). */
  hasFailureSnapshot: boolean
  setForm: (patch: Partial<StressForm>) => void
}

export const useStress = create<StressState>()((set) => ({
  scenarios: ['monkey'],
  tier: 'auto',
  steps: 2000,
  minutes: 10,
  seed: '',
  faults: 'auto',
  checkEvery: 25,
  stopOnFirst: true,
  phase: 'idle',
  progress: null,
  report: null,
  error: null,
  phaseText: '',
  hasFailureSnapshot: false,
  setForm: (patch) => set(patch),
}))

let stopRequested = false
let failureSnapshot: { project: unknown; takes: unknown } | null = null

/** Start a run with the form's settings. `sameSeed`: replay the last report's seed (and its scenarios / size). */
export async function startStress(opts: { sameSeed?: boolean } = {}): Promise<void> {
  const st = useStress.getState()
  if (st.phase !== 'idle') return
  const last = st.report
  const seed = opts.sameSeed && last ? last.seed : (parseSeed(st.seed) ?? randomSeed())
  const scenarios = opts.sameSeed && last ? last.spec.scenarios : st.scenarios
  stopRequested = false
  failureSnapshot = null
  useStress.setState({ phase: 'running', progress: null, error: null, seed, hasFailureSnapshot: false, phaseText: '' })
  let lastPaint = 0
  try {
    const [{ runInSandbox }, { summaryText }] = await Promise.all([import('./sandbox'), import('./report')])
    const report = await runInSandbox(
      {
        scenarios,
        seed,
        steps: opts.sameSeed && last ? last.spec.steps : Math.max(0, Math.floor(st.steps)),
        maxMs: opts.sameSeed && last ? last.spec.maxMs : Math.max(0, st.minutes) * 60_000,
        tier: opts.sameSeed && last ? last.spec.tier : st.tier === 'auto' ? undefined : st.tier,
        faults: opts.sameSeed && last ? last.spec.faults : st.faults === 'auto' ? undefined : st.faults,
        checkEvery: Math.max(1, Math.floor(st.checkEvery)),
        stopOnFirst: st.stopOnFirst,
        onProgress: (p) => {
          const now = performance.now()
          if (now - lastPaint < 200) return
          lastPaint = now
          useStress.setState({ progress: p })
        },
        shouldStop: () => stopRequested,
      },
      {
        onFailure: (project, takes) => {
          failureSnapshot = { project, takes }
          useStress.setState({ hasFailureSnapshot: true })
        },
        onPhase: (text) => useStress.setState({ phaseText: text, ...(text ? { phase: 'restoring' as const } : {}) }),
      },
    )
    rememberReport(report, summaryText(report))
    useStress.setState({ report })
  } catch (e) {
    useStress.setState({ error: (e as Error)?.message ?? String(e) })
  } finally {
    useStress.setState({ phase: 'idle', phaseText: '' })
  }
}

/** The "Dừng" button: the run stops before its next step, then everything is put back. */
export function stopStress(): void {
  if (useStress.getState().phase !== 'running') return
  stopRequested = true
  useStress.setState({ phase: 'stopping' })
}

/** Save text as a file (after the run: the download guard is gone). */
export function downloadText(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function downloadReport(kind: 'json' | 'md') {
  const r = useStress.getState().report
  if (!r) return
  const { reportFileName, toJSON, toMarkdown } = await import('./report')
  downloadText(reportFileName(r, kind), kind === 'json' ? toJSON(r) : toMarkdown(r), kind === 'json' ? 'application/json' : 'text/markdown')
}

/** The project at the first error as a .sanovids.json (Nhập dự án to look at it; its takes are not part of it). */
export function downloadFailureProject() {
  const r = useStress.getState().report
  if (!failureSnapshot || !r) return
  const file = { format: 'sanovids', version: 2, project: failureSnapshot.project, media: {}, stress: { seed: r.seed, failure: r.failure, takes: failureSnapshot.takes } }
  downloadText(`sanovids-stress-${r.seed}-du-an-loi.sanovids.json`, JSON.stringify(file))
}

export async function copySummary(): Promise<boolean> {
  const r = useStress.getState().report
  if (!r) return false
  try {
    const { toMarkdown } = await import('./report')
    await navigator.clipboard.writeText(toMarkdown(r))
    return true
  } catch {
    return false
  }
}

export async function cleanup(): Promise<string> {
  const { cleanupLeftovers } = await import('./sandbox')
  const text = await cleanupLeftovers()
  useStress.setState({ error: null })
  return text
}

/** A run of this window is going on (its manifest is not a leftover). */
export const stressRunning = () => useStress.getState().phase !== 'idle'
