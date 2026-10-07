import type { PerfSize } from './synth'

// Wave A budgets, in milliseconds unless the id names a count or memory value.
const L: Record<string, number> = {
  open: 2400, pan: 6, pan04: 6, panFar: 10, zoom: 12, select: 30, selectFirst: 120,
  drag: 8, drag50: 12, typeInspector: 4, promptCommit: 4, runsTick: 3, star: 8, hover: 6,
  allWires: 10, minimapOn: 6, typeNode: 5, nodeCommit: 5, openEditor: 60, closeEditor: 30,
  panWithEditor: 7, zoomWithEditor: 12, autosaveProject: 4, autosaveRuns: 6, dom: 8000,
  // 0.6.0 canvas scenarios: initial values, not calibrated with GUI runs yet.
  expandSettings: 60, lodSwitch: 30, librarySelect200: 100, libraryDelete200: 150,
  cutWire: 30, undoWire: 30,
}
/** Every budgeted id: a scenario id, or one the runner derives (autosaveProject / autosaveRuns from autosave, dom). */
export const BUDGET_IDS: readonly string[] = Object.keys(L)
export function budgetFor(id: string, size: PerfSize | 'custom'): number | null {
  if (size === 'custom' || !(id in L)) return null
  // Perf XXL = 3,000 scenes (the stress tester's XXL is 2,000): 4 × L for every id.
  if (size === 'XXL') return L[id] * 4
  if (id === 'autosaveRuns' && size === 'XL') return 12
  return L[id] * (size === 'M' ? 0.6 : size === 'XL' ? 2 : 1)
}

/**
 * CI ceilings (ms) for the pure/store part of the 0.6.0 canvas scenarios (canvasScenarios.timing.test); never evidence
 * that a browser budget passed. Always compared with the MEDIAN of 25 samples, which stays put on a loaded machine
 * (parallel gates, shared CI runners: with six to eight copies at once the medians stayed ≤ 3.3 ms while single
 * samples reached 32 ms); SANOVIDS_TIMING=1 also compares the p95, on a quiet machine. Each ceiling is ≥ 3× the loaded
 * median and 13–80× the quiet one (the store-only toggles get 1 ms): CI catches an order-of-magnitude regression of
 * the store path, smaller ones are for the GUI runs.
 */
export const HEADLESS_BUDGETS = { typeNode: 5, editor: 1, expandSettings: 1, lodSwitch: 5,
  librarySelect200: 1, libraryDelete200: 15, cutWire: 3, undoWire: 1 } as const
export type HeadlessId = keyof typeof HEADLESS_BUDGETS
/** The browser scenario each headless measurement is part of: its budget at the tier caps the headless ceiling. */
export const HEADLESS_SCENARIO: Record<HeadlessId, string> = { typeNode: 'typeNode', editor: 'closeEditor',
  expandSettings: 'expandSettings', lodSwitch: 'lodSwitch', librarySelect200: 'librarySelect200',
  libraryDelete200: 'libraryDelete200', cutWire: 'cutWire', undoWire: 'undoWire' }
/** Headless ceiling at a tier: never above the browser budget of its scenario there (typeNode at M: 3 ms). */
export function headlessBudget(id: HeadlessId, size: PerfSize): number {
  return Math.min(HEADLESS_BUDGETS[id], budgetFor(HEADLESS_SCENARIO[id], size) ?? Infinity)
}
/**
 * Budgets as a share of a baseline run of the same scenario (report.withBaselineBudgets). Empty since 0.6.0: the only
 * ones were the hidden Bảng cảnh / Storyboard scenarios (tableScroll, storyboardOpen, storyboardReorder).
 */
const RELATIVE: Record<string, number> = {}
export function relativeBudget(id: string, baseline: number): number | null {
  return Object.hasOwn(RELATIVE, id) ? baseline * RELATIVE[id] : null
}
