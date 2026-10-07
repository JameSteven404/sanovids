import type { PerfSize } from './synth'

// Browser work budgets, in milliseconds unless the id names a count or memory value.
const L: Record<string, number> = {
  open: 2400, pan: 6, pan04: 6, panFar: 10, zoom: 12, select: 30, selectFirst: 120,
  drag: 8, drag50: 12, typeInspector: 4, promptCommit: 4, runsTick: 3, star: 8, hover: 6,
  allWires: 10, minimapOn: 6, typeNode: 5, nodeCommit: 5, openEditor: 60, closeEditor: 30,
  panWithEditor: 7, zoomWithEditor: 12, autosaveProject: 4, autosaveRuns: 6, dom: 8000,
  expandSettings: 60, lodSwitch: 30, librarySelect200: 100, libraryDelete200: 150,
  cutWire: 30, undoWire: 30,
}
export function budgetFor(id: string, size: PerfSize | 'custom'): number | null {
  if (size === 'custom' || !(id in L)) return null
  if (id === 'autosaveRuns' && size === 'XL') return 12
  return L[id] * (size === 'M' ? 0.6 : size === 'XL' ? 2 : size === 'XXL' ? 4 : 1)
}

// Coarse CI regression ceilings for pure/store work only; never evidence that the browser budget passed.
export const HEADLESS_BUDGETS = { typeNode: 25, editor: 25, expandSettings: 25, lodSwitch: 25,
  librarySelect200: 25, libraryDelete200: 50, cutWire: 50, undoWire: 25 } as const
/**
 * Budgets as a share of a baseline run of the same scenario (report.withBaselineBudgets). Empty since 0.6.0: the only
 * ones were the hidden Bảng cảnh / Storyboard scenarios (tableScroll, storyboardOpen, storyboardReorder).
 */
const RELATIVE: Record<string, number> = {}
export function relativeBudget(id: string, baseline: number): number | null {
  return Object.hasOwn(RELATIVE, id) ? baseline * RELATIVE[id] : null
}
