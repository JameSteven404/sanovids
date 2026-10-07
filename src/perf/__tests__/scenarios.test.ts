import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUDGET_IDS, budgetFor, HEADLESS_BUDGETS, HEADLESS_SCENARIO, headlessBudget, type HeadlessId } from '../budgets'
import { scenarios } from '../scenarios'
import { SIZES } from '../synth'

const TIERS = Object.keys(SIZES) as (keyof typeof SIZES)[]

describe('performance scenario contract', () => {
  it('keeps existing ids and makes every E2/new scenario required and budgeted at every tier', () => {
    const list = scenarios('prf_project', 'prf_alternate')
    const old = ['open', 'pan', 'pan04', 'panFar', 'zoom', 'selectFirst', 'select', 'drag', 'drag50',
      'typeInspector', 'promptCommit', 'runsTick', 'star', 'hover', 'allWires', 'minimapOn', 'autosave']
    const added = ['typeNode', 'nodeCommit', 'openEditor', 'closeEditor', 'panWithEditor', 'zoomWithEditor', 'expandSettings',
      'lodSwitch', 'librarySelect200', 'libraryDelete200', 'cutWire', 'undoWire']
    expect(new Set(list.map((s) => s.id)).size).toBe(list.length)
    expect(list.map((s) => s.id).sort()).toEqual([...old, ...added].sort())
    for (const id of added) {
      expect(list.find((s) => s.id === id)?.optional, id).toBeUndefined()
      for (const size of TIERS) expect(budgetFor(id, size), `${id}/${size}`).toBeGreaterThan(0)
    }
    expect([SIZES.M.scenes, SIZES.XL.scenes, SIZES.XXL.scenes]).toEqual([300, 1000, 3000])
  })

  it('measures every budget id: a scenario, or a value the runner derives (never an orphaned budget)', () => {
    const ids = new Set(scenarios('prf_project', 'prf_alternate').map((s) => s.id))
    const derived = ['autosaveProject', 'autosaveRuns', 'dom'] // runner.ts: from the autosave scenario, and the DOM count
    expect(BUDGET_IDS.filter((id) => !ids.has(id) && !derived.includes(id))).toEqual([])
    expect(derived.every((id) => BUDGET_IDS.includes(id))).toBe(true)
    expect(budgetFor('nodeCommit', 'L')).toBe(5)
  })

  it('keeps the headless CI ceilings tight: never above the browser budget of their scenario at any tier', () => {
    for (const id of Object.keys(HEADLESS_BUDGETS) as HeadlessId[]) {
      expect(BUDGET_IDS, id).toContain(HEADLESS_SCENARIO[id])
      for (const size of TIERS) {
        expect(headlessBudget(id, size), `${id}/${size}`).toBeLessThanOrEqual(budgetFor(HEADLESS_SCENARIO[id], size)!)
        expect(headlessBudget(id, size), `${id}/${size}`).toBeLessThanOrEqual(HEADLESS_BUDGETS[id])
      }
    }
    // The typing path: the browser per-key budget (3 ms at M, 5 at L) bounds it, not a 25 ms catch-all.
    expect(TIERS.map((size) => headlessBudget('typeNode', size))).toEqual([3, 5, 5, 5])
    expect(Math.max(...Object.values(HEADLESS_BUDGETS))).toBeLessThanOrEqual(15)
  })

  it('finds every element it measures by a class / attribute the app still renders (a re-skin must not break GUI runs silently)', () => {
    const source = readFileSync('src/perf/scenarios.ts', 'utf8')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== '__tests__' && entry.name !== 'perf') walk(path) }
        else if (/\.tsx?$/.test(entry.name)) files.push(readFileSync(path, 'utf8'))
      }
    }
    walk('src')
    const app = files.join('\n')
    const classes = new Set([
      ...[...source.matchAll(/\.((?:cv|sb|in|app|is|dv|tb|rq|vw|dg)-[a-z0-9-]*[a-z0-9])(?![\w-])/g)].map((m) => m[1]),
      ...[...source.matchAll(/classList\.contains\('([\w-]+)'\)/g)].map((m) => m[1]),
    ])
    // React Flow's own data-id on .react-flow__node / __edge is the library's, not the app's.
    const attributes = new Set([...source.matchAll(/(?<!react-flow__[a-z]+)\[((?:data|aria)-[a-z-]+)[=\]]/g)].map((m) => m[1]))
    const labels = new Set([...source.matchAll(/\[aria-label="([^"$]+)"\]/g)].map((m) => m[1]))
    // The selectors of the 0.6.0 scenarios (node editor, settings line, LOD, wires, library) are all found here.
    for (const token of ['cv-sn-pr', 'cv-sn-text', 'cv-sn-sum', 'cv-sn-setx', 'cv-sn-setx-close', 'cv-scene', 'is-far', 'in-tk',
      'is-invalid', 'cv-wire', 'sb-library', 'sb-libfoot-del', 'sb-kind', 'sb-sec-toggle', 'sb-search-input', 'sb-grid']) expect(classes).toContain(token)
    expect([...attributes].sort()).toEqual(['aria-expanded', 'aria-label', 'aria-selected', 'data-asset-id'])
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const missing = [
      ...[...classes].filter((token) => !new RegExp(`(?:^|[^\\w-])${escape(token)}(?![\\w-])`).test(app)),
      ...[...attributes].filter((name) => !app.includes(`${name}=`)),
      ...[...labels].filter((label) => !app.includes(`aria-label="${label}"`)),
    ]
    expect(missing, 'selectors in src/perf/scenarios.ts that no app component renders').toEqual([])
  })
})
