// The stress runner: picks seeded actions, runs them against the real stores / engine / simulated canvasapp, checks the
// invariants after every step and stops at the first failure with a replayable report (seed + step log).
// Runs headless (vitest, fake timers) and in the app (real time) — the environment is given by the caller (StressEnv).
// Restoring the user's project in the app is the sandbox's job (sandbox.ts); the runner only owns its session.
import { version as APP_VERSION } from '../../../package.json'
import { activeProviderId } from '../../providers'
import { useDevLog } from '../../providers/dev'
import { clearHistory, useProject } from '../../store/project'
import { currentRestartWork, useRuns } from '../../store/runs'
import { ACTION_BY_ID, ACTIONS } from './actions'
import { checkEngine, checkHistorySize, checkProject, checkStructural, JobAudit, scenesWithVideoTokens } from './invariants'
import { createRng, parseSeed, randomSeed, type Seed } from './rng'
import { FAULT_SCALE, NOT_IMPLEMENTED, SCENARIO_BY_ID } from './scenarios'
import { goodImage, startSession, type Session } from './session'
import { generateProject, type GeneratedProject } from './synth'
import type { ActionStats, FaultLevel, LoggedStep, RingEntry, ScenarioDef, StressAction, StressContext, StressEnv, StressOptions, StressReport, Tier, Violation } from './types'

export const RING_MAX = 500
export const LOG_MAX = 20_000
/** An action that does not settle in this long (real time) is reported as hung. */
export const WATCHDOG_MS = 10_000
const TIER_RANK: Tier[] = ['S', 'M', 'L', 'XL', 'XXL', 'OVER']

export interface RunHooks {
  /** Open the generated project (the app: as a temporary project of its own). Default: straight into the stores. */
  load?: (gen: GeneratedProject) => Promise<void>
  /** The first error: the project and takes as they are at that moment ("Lưu dự án lỗi"). */
  onFailure?: (project: unknown, takes: unknown) => void
}

export const DEFAULT_OPTIONS: Omit<StressOptions, 'scenarios'> = { steps: 2000, maxMs: 0, checkEvery: 25, stopOnFirst: true }

/** Scenario specs merged: weights added, fault level / tier / project kind from the options or the scenarios. */
export function planOf(options: StressOptions, kind: StressEnv['kind']) {
  const defs = (options.scenarios.length ? options.scenarios : ['monkey']).map((id) => SCENARIO_BY_ID.get(id)).filter((d): d is ScenarioDef => !!d)
  if (!defs.length) throw new Error(`Không có kịch bản “${options.scenarios.join(', ')}”.`)
  const faults: FaultLevel = options.faults ?? defs.reduce<FaultLevel>((lvl, d) => (FAULT_SCALE[d.faults] > FAULT_SCALE[lvl] ? d.faults : lvl), 'none')
  const tier: Tier = options.tier ?? defs.reduce<Tier>((t, d) => (TIER_RANK.indexOf(d.tier) > TIER_RANK.indexOf(t) ? d.tier : t), 'S')
  const project = defs.find((d) => d.project && d.project !== 'generated')?.project ?? 'generated'
  const weights = new Map<string, number>()
  for (const d of defs) for (const [id, w] of Object.entries(d.weights)) weights.set(id, (weights.get(id) ?? 0) + w)
  const actions: { action: StressAction; weight: number }[] = []
  for (const action of ACTIONS) {
    let w = weights.get(action.id) ?? 0
    if (action.group === 'fault') w = faults === 'none' ? 0 : Math.max(w, 1) * FAULT_SCALE[faults]
    if (action.layer === 'ui' && kind === 'headless') w = 0
    if (w > 0) actions.push({ action, weight: w })
  }
  const server = Object.assign({}, ...defs.map((d) => d.server ?? {})) as NonNullable<ScenarioDef['server']>
  const drainEvery = Math.min(...defs.map((d) => d.drainEvery ?? 0).map((n) => (n > 0 ? n : Infinity)))
  return { defs, faults, tier, project, actions, server, drainEvery: Number.isFinite(drainEvery) ? drainEvery : 0 }
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

const round = (n: number) => Math.round(n * 10) / 10

function blobOf(kind: 'good' | 'big' | 'empty' | 'mime' | 'corrupt'): Blob {
  switch (kind) {
    case 'big':
      return new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'image/png' })
    case 'empty':
      return new Blob([], { type: 'image/png' })
    case 'mime':
      return new Blob(['GIF89a'], { type: 'image/gif' })
    case 'corrupt':
      return new Blob(['not a png at all'], { type: 'image/png' })
    default:
      return goodImage()
  }
}

/** Run one stress session. Never throws: problems of the tester itself end as result 'harness-error'. */
export async function runStress(options: StressOptions, env: StressEnv, hooks: RunHooks = {}): Promise<StressReport> {
  const seed: Seed = parseSeed(options.seed) ?? randomSeed()
  const startedAt = Date.now()
  const t0 = env.clock()
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const report: StressReport = {
    v: 1,
    app: { version: APP_VERSION, build: env.kind },
    seed,
    startedAt,
    durationMs: 0,
    steps: 0,
    spec: {
      scenarios: opts.scenarios.length ? opts.scenarios : ['monkey'],
      tier: 'S',
      steps: opts.replay ? opts.replay.length : opts.steps,
      maxMs: opts.maxMs,
      faults: 'none',
      checkEvery: Math.max(1, opts.checkEvery),
      stopOnFirst: opts.stopOnFirst,
      expectVideoRetired: !!opts.expectVideoRetired,
      tokenKeep: !!opts.tokenKeep,
    },
    result: 'pass',
    failure: null,
    warnings: [],
    ring: [],
    log: [],
    metrics: { perAction: {}, longFrames: [], heap: [], dom: [], slowSteps: [] },
    server: { jobs: 0, uploads: 0, balance: 0, faultsArmed: 0, requests: 0 },
    guards: {},
    notes: NOT_IMPLEMENTED.map((t) => 'Chưa có: ' + t),
  }
  const harness = (message: string, stack?: string): StressReport => {
    report.result = 'harness-error'
    report.failure = { step: report.steps, action: '', args: {}, invariant: 'harness', kind: 'harness', message, stack }
    report.durationMs = Math.round(env.clock() - t0)
    return report
  }

  let plan: ReturnType<typeof planOf>
  try {
    plan = planOf(opts, env.kind)
  } catch (e) {
    return harness((e as Error).message)
  }
  report.spec.tier = plan.tier
  report.spec.faults = plan.faults
  if (activeProviderId() !== 'dev') return harness('Chỉ chạy được ở chế độ Phát triển (giả lập): đang chọn canvasapp.io.vn thật.')
  if (!plan.actions.length) return harness('Kịch bản không có thao tác nào chạy được ở đây.')

  const rng = createRng(seed)
  let session: Session | null = null
  const durations = new Map<string, number[]>()
  const warnings = new Map<string, { invariant: string; count: number; firstStep: number; message: string }>()
  const pending: Violation[] = []
  const audit = new JobAudit()
  const seenLog = new Set<number>()
  let offLog: () => void = () => undefined
  let stopping = false

  const note = (text: string) => {
    if (report.notes.length < 200) report.notes.push(text)
  }

  try {
    session = startSession({ rng, kind: env.kind })
    const s = session
    if (plan.server.dedupe !== undefined) s.server.setConfig({ dedupe: plan.server.dedupe })
    if (plan.server.failRate !== undefined) s.server.setConfig({ failRate: plan.server.failRate })
    if (plan.server.latencyMs !== undefined) s.server.setConfig({ latencyMs: plan.server.latencyMs })

    const gen = generateProject(rng.fork('project'), seed, plan.tier, plan.project)
    const good = goodImage()
    for (const id of gen.imageIds) s.media.set(id, good)
    if (hooks.load) await hooks.load(gen)
    else {
      useProject.getState().loadProject(gen.project)
      clearHistory()
      useRuns.getState().loadRuns({ takes: gen.takes, credits: 1000, spent: 0 })
    }
    note(`Dự án thử nghiệm: ${gen.project.scenes.length} cảnh, ${gen.project.assets.length} nhân vật, ${gen.takes.length} video${scenesWithVideoTokens(gen.project) ? `, ${scenesWithVideoTokens(gen.project)} cảnh còn @video cũ` : ''}.`)

    // Requests the simulated gateway refused (outside its allowlist) — must never happen.
    offLog = useDevLog.subscribe((st) => {
      for (const e of st.entries) {
        if (seenLog.has(e.id)) continue
        seenLog.add(e.id)
        if (e.fault === 'not-allowed') pending.push({ invariant: 'S2', severity: 'error', kind: 'app', message: `Cổng giả lập chặn một yêu cầu ngoài danh sách cho phép (${String(e.endpoint)}).`, detail: e })
      }
    })
    env.drainErrors() // errors from before the run are not ours

    let imageN = 0
    const ctx: StressContext = {
      rng,
      env,
      options: { checkEvery: report.spec.checkEvery, stopOnFirst: opts.stopOnFirst, expectVideoRetired: !!opts.expectVideoRetired, tokenKeep: !!opts.tokenKeep },
      tier: plan.tier,
      step: 0,
      server: s.server,
      report: (v) => pending.push(v),
      note,
      newImage: (kind = 'good') => {
        const id = `img_stx_${seed}_n${++imageN}`
        const blob = blobOf(kind)
        s.media.set(id, blob)
        env.putMedia(id, blob)
        return id
      },
      legacyTokens: gen.legacyTokens,
      badImages: new Set(),
    }

    const sample = () => {
      const m = env.sample?.()
      if (!m) return
      if (m.heap !== undefined) report.metrics.heap.push(m.heap)
      if (m.dom !== undefined) report.metrics.dom.push(m.dom)
      if (m.longFrames?.length) report.metrics.longFrames.push(...m.longFrames.slice(0, 50))
      const long = (m.longFrames ?? []).filter((f) => f > 1000)
      if (long.length) pending.push({ invariant: 'U1', severity: 'warning', kind: 'app', message: `Giao diện đứng ${Math.round(Math.max(...long))} ms.` })
      const heap = report.metrics.heap
      if (heap.length > 3 && heap[heap.length - 1] > 3 * heap[0] && heap[heap.length - 1] > 1.5e9) {
        pending.push({ invariant: 'U2', severity: 'warning', kind: 'app', message: `Bộ nhớ tăng mạnh (${Math.round(heap[heap.length - 1] / 1e6)} MB).` })
      }
    }

    /** Faults off, logged in, money back; wait for the queue to drain (E2), then audit the jobs. */
    const quiesce = async () => {
      s.server.clearFaults()
      s.server.setJobFaults({ failNext: null, expireNext: false, streamFailures: 0 })
      s.server.login()
      if (s.server.balance() < 1_000_000) s.server.setBalance(1_000_000_000)
      const chunk = env.kind === 'headless' ? 2_000 : 500
      const start = env.clock()
      // E2 = no progress: the budget counts from the last time the queue shrank (a big queue that keeps moving is
      // fine), with a hard cap of 20 budgets so a run always ends.
      let waited = 0
      let sinceProgress = 0
      let left = Infinity
      while (sinceProgress < env.drainBudgetMs && waited < env.drainBudgetMs * 20) {
        const w = currentRestartWork()
        const now = w.queued + w.processing
        if (now === 0) break
        if (opts.shouldStop?.()) return
        const before = env.kind === 'headless' ? waited : env.clock() - start
        if (now < left) {
          left = now
          sinceProgress = 0
        }
        await env.advance(chunk)
        waited = env.kind === 'headless' ? waited + chunk : env.clock() - start
        sinceProgress += waited - before
      }
      const w = currentRestartWork()
      if (w.queued + w.processing > 0) {
        const stuck = useRuns
          .getState()
          .takes.filter((t) => t.status === 'queued' || t.status === 'processing')
          .slice(0, 10)
          .map((t) => ({ id: t.id, status: t.status, remoteId: t.remoteId ?? null, error: t.error }))
        pending.push({
          invariant: 'E2',
          severity: env.kind === 'headless' ? 'error' : 'warning',
          kind: 'app',
          message: `Hàng đợi không chạy hết khi đã hết lỗi mạng: ${Math.round(sinceProgress / 1000)} giây không có take nào xong (đã chờ tổng ${Math.round(waited / 1000)} giây; ${w.queued} chờ, ${w.processing} đang chạy).`,
          detail: { stuck },
        })
      }
      pending.push(...audit.audit(s.server.snapshot(), useRuns.getState().takes, useProject.getState().project.assets, s.server.config().dedupe))
    }

    const fullChecks = () => {
      const p = useProject.getState().project
      const takes = useRuns.getState().takes
      pending.push(...checkProject(p, takes))
      pending.push(...audit.audit(s.server.snapshot(), takes, p.assets, s.server.config().dedupe))
      sample()
    }

    /** Sort what the step produced; true = stop now. */
    const settle = (n: number, id: string, args: LoggedStep['args'], stack?: string): boolean => {
      for (const msg of env.drainErrors()) pending.push({ invariant: 'R1', severity: 'error', kind: 'app', message: `Lỗi trong console: ${msg.slice(0, 300)}` })
      pending.push(...s.trips.splice(0))
      pending.push(...(env.guardTrips?.() ?? []))
      const list = pending.splice(0)
      let fatal: Violation | null = null
      for (const v of list) {
        if (v.severity === 'error') {
          fatal ??= v
          continue
        }
        const key = `${v.invariant}:${v.message}`
        const w = warnings.get(key)
        if (w) w.count++
        else if (warnings.size < 500) warnings.set(key, { invariant: v.invariant, count: 1, firstStep: n, message: v.message })
      }
      if (fatal) {
        const fatalStop = opts.stopOnFirst || fatal.invariant.startsWith('S')
        if (!report.failure) {
          report.failure = { step: n, action: id, args, invariant: fatal.invariant, kind: fatal.kind ?? 'app', message: fatal.message, detail: fatal.detail, stack }
          try {
            hooks.onFailure?.(JSON.parse(JSON.stringify(useProject.getState().project)), JSON.parse(JSON.stringify(useRuns.getState().takes)))
          } catch {
            /* a snapshot is a bonus */
          }
        }
        report.result = 'fail'
        if (!fatalStop) {
          const key = `${fatal.invariant}:${fatal.message}`
          const w = warnings.get(key)
          if (w) w.count++
          else warnings.set(key, { invariant: fatal.invariant, count: 1, firstStep: n, message: '[lỗi] ' + fatal.message })
        }
        return fatalStop
      }
      return false
    }

    const replay = opts.replay
    const total = replay ? replay.length : opts.steps
    for (let n = 1; ; n++) {
      if (total > 0 && n > total) break
      if (opts.maxMs > 0 && env.clock() - t0 > opts.maxMs) {
        note(`Hết thời gian (${Math.round(opts.maxMs / 1000)} giây) sau ${n - 1} bước.`)
        break
      }
      if (opts.shouldStop?.()) {
        report.result = 'stopped'
        stopping = true
        break
      }
      ctx.step = n
      // Choose the action (and its args) — or take it from the replayed log.
      let action: StressAction | undefined
      let args: LoggedStep['args']
      if (replay) {
        const entry = replay[n - 1]
        action = ACTION_BY_ID.get(entry.id)
        args = entry.args
        if (!action || (action.when && !action.when(ctx))) {
          report.steps = n
          continue
        }
      } else {
        const ready = plan.actions.filter((a) => !a.action.when || a.action.when(ctx))
        const i = rng.weighted(ready.map((a) => a.weight))
        if (i < 0) return harness('Không còn thao tác nào chạy được (dự án trống?).')
        action = ready[i].action
        args = action.args(rng, ctx)
      }
      const before = action.structural ? useProject.getState().project : null
      const start = env.clock()
      let stack: string | undefined
      try {
        const result = action.run(ctx, args)
        if (result instanceof Promise) {
          let settled = false
          const done = result.finally(() => {
            settled = true
          })
          await Promise.race([done, env.realSleep(WATCHDOG_MS)])
          if (!settled) pending.push({ invariant: 'watchdog', severity: 'error', kind: 'harness', message: `Thao tác “${action.label}” không xong sau ${WATCHDOG_MS / 1000} giây.` })
        }
      } catch (e) {
        stack = (e as Error)?.stack
        pending.push({ invariant: 'action', severity: 'error', kind: 'app', message: `Thao tác “${action.label}” ném lỗi: ${(e as Error)?.message ?? String(e)}` })
      }
      const ms = env.clock() - start
      await env.advance(env.kind === 'headless' ? 250 : 0)

      const after = useProject.getState().project
      if (before) pending.push(...checkStructural(before, after, action.label, !!opts.expectVideoRetired))
      pending.push(...checkHistorySize())
      pending.push(...checkEngine(useRuns.getState().takes))
      if (n % report.spec.checkEvery === 0) fullChecks()
      if (plan.drainEvery > 0 && n % plan.drainEvery === 0 && !replay) await quiesce()

      // Bookkeeping
      report.steps = n
      const list = durations.get(action.id) ?? []
      list.push(ms)
      durations.set(action.id, list)
      const takesNow = useRuns.getState().takes
      const entry: RingEntry = { n, id: action.id, args, ms: round(ms), scenes: after.scenes.length, takes: takesNow.length }
      report.ring.push(entry)
      if (report.ring.length > RING_MAX) report.ring.shift()
      if (report.log.length < LOG_MAX) report.log.push({ n, id: action.id, args })
      if (ms > 250) {
        report.metrics.slowSteps.push({ step: n, action: action.id, ms: round(ms) })
        report.metrics.slowSteps.sort((a, b) => b.ms - a.ms)
        report.metrics.slowSteps.length = Math.min(report.metrics.slowSteps.length, 20)
      }
      if (settle(n, action.id, args, stack)) break
      if (opts.onProgress) {
        const takes = { queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 }
        for (const t of takesNow) takes[t.status]++
        let errorsSoFar = report.failure ? 1 : 0
        let warningsSoFar = 0
        for (const w of warnings.values()) warningsSoFar += w.count
        if (report.result === 'fail' && !report.failure) errorsSoFar = 1
        opts.onProgress({ step: n, steps: total, elapsedMs: env.clock() - t0, action: action.label, errors: errorsSoFar, warnings: warningsSoFar, takes })
      }
    }

    // The end: everything must settle once the network is healthy again.
    if (!stopping && (report.result === 'pass' || !opts.stopOnFirst)) {
      await quiesce()
      fullChecks()
      settle(report.steps + 1, 'end', {})
    }
    const snap = s.server.snapshot()
    report.server = { jobs: audit.jobs, uploads: snap.uploads.length, balance: snap.balance, faultsArmed: snap.faults.length, requests: s.server.requestCount() }
  } catch (e) {
    harness(`Lỗi của bộ thử nghiệm: ${(e as Error)?.message ?? String(e)}`, (e as Error)?.stack)
  } finally {
    offLog()
    // Stop the engine before the session's provider goes away (in-flight work of this generation is then ignored).
    try {
      useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
    } catch {
      /* the caller restores the user's data anyway */
    }
    session?.stop()
  }

  for (const [id, list] of durations) {
    const sorted = [...list].sort((a, b) => a - b)
    const stats: ActionStats = { n: list.length, p50: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)), max: round(sorted[sorted.length - 1] ?? 0) }
    report.metrics.perAction[id] = stats
  }
  report.warnings = [...warnings.values()].sort((a, b) => b.count - a.count)
  report.guards = env.guardCounters?.() ?? {}
  report.durationMs = Math.round(env.clock() - t0)
  return report
}

/**
 * Shrink a failing log (delta debugging): drop chunks of steps while the same invariant still fails. Headless only
 * (every try is a full replay). Returns the smallest log found and how many replays it took.
 */
export async function shrinkFailure(base: StressReport, options: StressOptions, env: StressEnv, maxRuns = 40): Promise<{ log: LoggedStep[]; runs: number; report: StressReport | null }> {
  if (!base.failure) return { log: base.log, runs: 0, report: null }
  const invariant = base.failure.invariant
  let log = base.log.slice(0, base.failure.step)
  let best: StressReport | null = null
  let runs = 0
  let chunks = 2
  const fails = async (candidate: LoggedStep[]) => {
    runs++
    const r = await runStress({ ...options, seed: base.seed, replay: candidate.map((s, i) => ({ ...s, n: i + 1 })), stopOnFirst: true }, env)
    if (r.result === 'fail' && r.failure?.invariant === invariant) {
      best = r
      return true
    }
    return false
  }
  while (log.length > 1 && runs < maxRuns) {
    const size = Math.ceil(log.length / chunks)
    let reduced = false
    for (let i = 0; i < chunks && runs < maxRuns; i++) {
      const candidate = [...log.slice(0, i * size), ...log.slice((i + 1) * size)]
      if (candidate.length && (await fails(candidate))) {
        log = candidate
        chunks = Math.max(chunks - 1, 2)
        reduced = true
        break
      }
    }
    if (!reduced) {
      if (chunks >= log.length) break
      chunks = Math.min(log.length, chunks * 2)
    }
  }
  return { log: log.map((s, i) => ({ ...s, n: i + 1 })), runs, report: best }
}
