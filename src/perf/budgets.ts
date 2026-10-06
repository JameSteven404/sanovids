import type { PerfSize } from './synth'

// Wave A budgets, in milliseconds unless the id names a count or memory value.
const L: Record<string, number> = {
  open: 2400, returnCanvas: 2300, pan: 6, pan04: 6, panFar: 10, zoom: 12, select: 30, selectFirst: 120,
  drag: 8, drag50: 12, typeInspector: 4, promptCommit: 4, runsTick: 3, star: 8, hover: 6,
  allWires: 10, minimapOn: 6, typeNode: 5, nodeCommit: 5, openEditor: 60, closeEditor: 30,
  panWithEditor: 7, zoomWithEditor: 12, autosaveProject: 4, autosaveRuns: 6, dom: 8000,
}
export function budgetFor(id: string, size: PerfSize | 'custom'): number | null {
  if (size === 'custom' || !(id in L)) return null
  if (id === 'autosaveRuns' && size === 'XL') return 12
  return L[id] * (size === 'M' ? 0.6 : size === 'XL' ? 2 : 1)
}
export function relativeBudget(id: string, baseline: number): number | null {
  return id === 'tableScroll' || id === 'storyboardOpen' ? baseline * 0.6 : id === 'storyboardReorder' ? baseline : null
}
