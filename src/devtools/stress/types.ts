// Shapes shared by the stress tester (runner, actions, scenarios, invariants, report, UI).
import type { Rng, Seed } from './rng'

export type Severity = 'error' | 'warning'
/** Who is to blame: a bug of SanoVids, a limit of the simulated canvasapp, or the tester itself. */
export type FailureKind = 'app' | 'simulator' | 'harness'

export interface Violation {
  /** Invariant id (P1, C1, X2… see invariants.ts) or 'action' / 'watchdog' / 'R1'. */
  invariant: string
  severity: Severity
  /** Vietnamese, for the report. */
  message: string
  kind?: FailureKind
  detail?: unknown
}

export type ActionGroup = 'scene' | 'refs' | 'asset' | 'history' | 'run' | 'fault' | 'folder' | 'persist' | 'ui'
/** 'store' / 'command' run everywhere; 'ui' only in the app (stores of the UI: views, dialogs, panels). */
export type ActionLayer = 'store' | 'command' | 'ui'

/** JSON args of one step. Picks are raw integers resolved against the lists of the moment (`at(list, r)`), so a
 *  log replays (and shrinks) even when earlier steps are dropped. */
export type StepArgs = Record<string, number | string | boolean | null>

export interface StressAction {
  id: string
  /** Vietnamese label for reports. */
  label: string
  group: ActionGroup
  layer: ActionLayer
  /** Changes refs / assets / scenes so that the text-preservation invariant X1 applies to it. */
  structural?: boolean
  /** Can it run now? Default: yes. */
  when?: (ctx: StressContext) => boolean
  args: (rng: Rng, ctx: StressContext) => StepArgs
  run: (ctx: StressContext, args: StepArgs) => void | Promise<void>
}

export type Tier = 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'OVER'
export type FaultLevel = 'none' | 'sometimes' | 'storm'
export type ScenarioGroup = 'A' | 'B' | 'C' | 'D'

export interface ScenarioDef {
  id: string
  /** Vietnamese. */
  label: string
  group: ScenarioGroup
  /** One line, Vietnamese. */
  hint: string
  /** Suggested duration in the app (minutes). */
  minutes: number
  headless: boolean
  app: boolean
  /** Default project size. */
  tier: Tier
  faults: FaultLevel
  /** Action id → weight (actions not listed are never picked). */
  weights: Record<string, number>
  /** Changes to the simulated server's settings at the start (e.g. dedupe off). */
  server?: { dedupe?: boolean; failRate?: number; latencyMs?: number }
  /** Builds a special project instead of the generated one (legacy data…). */
  project?: 'generated' | 'legacy-video' | 'bridge-full'
  /** Quiescence (drain + E2 / $ invariants) every N steps; 0 = only at the end. */
  drainEvery?: number
}

export interface StressOptions {
  /** Scenario ids (several = their weights are added). Default ['monkey']. */
  scenarios: string[]
  seed?: Seed
  /** Steps; 0 = until stopped / maxMs. */
  steps: number
  /** Wall-clock budget (ms); 0 = none. */
  maxMs: number
  tier?: Tier
  faults?: FaultLevel
  /** Full invariants every N steps (cheap ones run every step). */
  checkEvery: number
  stopOnFirst: boolean
  /** After "Đợt V" (video references retired): @video tokens must stay byte-for-byte (X2 is an error, not a warning). */
  expectVideoRetired?: boolean
  /** After the "giữ token" track: image tokens keep their count (X3). */
  tokenKeep?: boolean
  /** Replay exactly these steps instead of drawing new ones. */
  replay?: LoggedStep[]
  /** Called after each step (UI progress); must be cheap. */
  onProgress?: (p: StressProgress) => void
  /** Checked before each step: true = stop now (the "Dừng" button). */
  shouldStop?: () => boolean
}

export interface StressProgress {
  step: number
  steps: number
  elapsedMs: number
  action: string
  errors: number
  warnings: number
  takes: { queued: number; processing: number; completed: number; failed: number; cancelled: number }
}

export interface LoggedStep {
  /** 1-based step number. */
  n: number
  id: string
  args: StepArgs
}

export interface RingEntry extends LoggedStep {
  ms: number
  scenes: number
  takes: number
}

export interface ActionStats {
  n: number
  p50: number
  p95: number
  max: number
}

export type StressResult = 'pass' | 'fail' | 'stopped' | 'harness-error'

export interface StressReport {
  v: 1
  app: { version: string; build: 'app' | 'headless' }
  seed: Seed
  startedAt: number
  durationMs: number
  steps: number
  spec: {
    scenarios: string[]
    tier: Tier
    steps: number
    maxMs: number
    faults: FaultLevel
    checkEvery: number
    stopOnFirst: boolean
    expectVideoRetired: boolean
    tokenKeep: boolean
  }
  result: StressResult
  failure: null | {
    step: number
    action: string
    args: StepArgs
    invariant: string
    kind: FailureKind
    message: string
    detail?: unknown
    stack?: string
  }
  warnings: { invariant: string; count: number; firstStep: number; message: string }[]
  /** Last steps (≤ 500). */
  ring: RingEntry[]
  /** Every step id + args (≤ 20.000) — enough to replay. */
  log: LoggedStep[]
  metrics: {
    perAction: Record<string, ActionStats>
    longFrames: number[]
    heap: number[]
    dom: number[]
    slowSteps: { step: number; action: string; ms: number }[]
  }
  server: { jobs: number; uploads: number; balance: number; faultsArmed: number; requests: number }
  /** Counters of the in-app guards (blocked writes / network / downloads). Empty in the headless runner. */
  guards: Record<string, number>
  notes: string[]
}

/** What a run needs from where it runs (vitest with fake timers, or the app with real time). */
export interface StressEnv {
  kind: 'headless' | 'app'
  /** Let simulated time pass: headless advances fake timers; the app waits for real (short) and yields. */
  advance: (ms: number) => Promise<void>
  /** Wall clock for measurements (never faked). */
  clock: () => number
  /** Sleep in real time (watchdog); never faked. */
  realSleep: (ms: number) => Promise<void>
  /** Make an image id readable by the session provider (uploads). */
  putMedia: (id: string, blob: Blob) => void
  /** Errors captured since the last call (console.error, unhandled rejections, window errors). */
  drainErrors: () => string[]
  /** How long the quiescence check may wait for the queue to drain (simulated ms). */
  drainBudgetMs: number
  /** Memory / DOM / long-frame samples (app only). */
  sample?: () => { heap?: number; dom?: number; longFrames?: number[] }
  /** Counters of blocked writes / requests (app only). */
  guardCounters?: () => Record<string, number>
  /** Fatal guard trips (real provider called, real file written…): stop at once. */
  guardTrips?: () => Violation[]
}

/** Mutable state of one run, handed to every action. */
export interface StressContext {
  rng: Rng
  env: StressEnv
  options: Required<Pick<StressOptions, 'checkEvery' | 'stopOnFirst' | 'expectVideoRetired' | 'tokenKeep'>>
  tier: Tier
  step: number
  /** The session's simulated canvasapp (control API). */
  server: import('./session').SessionServer
  /** Problems found by actions themselves (post-conditions). */
  report: (v: Violation) => void
  /** A free-form note for the report (Vietnamese). */
  note: (text: string) => void
  /** New image ids for assets ('good' = a small valid PNG). */
  newImage: (kind?: 'good' | 'big' | 'empty' | 'mime' | 'corrupt') => string
  /** @video tokens of legacy scenes at load (scene id → tokens, in order): X2 checks them byte for byte. */
  legacyTokens: Map<string, string[]>
  /** Scene ids whose prompt carries a "bad" image: their takes may fail, no job may be billed for them. */
  badImages: Set<string>
}
