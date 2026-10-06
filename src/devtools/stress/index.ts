/**
 * "Test giới hạn" — stress / soak / fuzz tester (Development mode only).
 *
 * Public API
 * ----------
 * - `runStress(options, env, hooks?)` → `Promise<StressReport>`: the engine. Picks weighted random actions from the
 *   chosen `SCENARIOS` (seeded, reproducible), applies them to the stores, checks invariants (cheap ones every step,
 *   full ones every `checkEvery` steps and at quiescence) and returns a report (`report.log` replays the run via
 *   `options.replay`). `env` says where it runs: vitest (fake timers, see `__tests__/headlessEnv.ts`) or the app
 *   (`runInSandbox` builds it). It refuses to start unless the active provider is the simulated one (`'dev'`), uses a
 *   private simulated server, and never touches the network.
 * - `shrinkFailure(report, options, env)`: ddmin over the failing log → a shorter replay that still fails.
 * - `runInSandbox(options, hooks?)`: the in-app wrapper: saves the user's project, opens a temporary project, guards
 *   network / downloads / file pickers / dialogs, runs, then puts everything back (project, UI, preferences).
 * - `SCENARIOS` / `SCENARIO_BY_ID`: the 18 scenarios (groups A–D). `NOT_IMPLEMENTED`: what is left out on purpose.
 * - `StressTab`: the dev-panel tab (no props). `StressHud`: floating pill while running. `useStress`, `startStress`,
 *   `stopStress`: the tab's module-level controller (a run continues when the panel is closed).
 * - `summaryText` / `toMarkdown` / `toJSON` / `reportFileName`: report formatting.
 *
 * Wiring (outside this folder — not done here):
 *   DevPanel: add `'stress'` to `DevPanelTab` + the tab list with label "Test giới hạn", and render
 *     `const StressTab = lazy(() => import('../devtools/stress').then((m) => ({ default: m.StressTab })))`
 *     inside `<Suspense>` for that tab.
 *   App: `{import.meta.env.DEV-or-dev-mode && <StressHud />}` (lazy as well) so a run can be watched with the panel closed.
 * Command line soak: `node scripts/stress/run-stress.mjs` (see that file for the env variables).
 */
export { runStress, shrinkFailure, planOf, DEFAULT_OPTIONS } from './runner'
export type { RunHooks } from './runner'
export { runInSandbox, startBlockedReason, cleanupLeftovers, lastReportSummary } from './sandbox'
export { SCENARIOS, SCENARIO_BY_ID, NOT_IMPLEMENTED } from './scenarios'
export { ACTIONS, ACTION_BY_ID } from './actions'
export { summaryText, toMarkdown, toJSON, reportFileName } from './report'
export { useStress, startStress, stopStress } from './store'
export { StressTab } from './StressTab'
export { StressHud } from './StressHud'
export type * from './types'
