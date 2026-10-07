import { describe, expect, it } from 'vitest'
import { budgetFor } from '../budgets'
import { scenarios } from '../scenarios'
import { SIZES } from '../synth'

describe('performance scenario contract', () => {
  it('keeps existing ids and makes every E2/new scenario required and budgeted at every tier', () => {
    const list = scenarios('prf_project', 'prf_alternate')
    const old = ['open', 'pan', 'pan04', 'panFar', 'zoom', 'selectFirst', 'select', 'drag', 'drag50',
      'typeInspector', 'promptCommit', 'runsTick', 'star', 'hover', 'allWires', 'minimapOn', 'autosave']
    const added = ['typeNode', 'openEditor', 'closeEditor', 'panWithEditor', 'zoomWithEditor', 'expandSettings',
      'lodSwitch', 'librarySelect200', 'libraryDelete200', 'cutWire', 'undoWire']
    expect(new Set(list.map((s) => s.id)).size).toBe(list.length)
    expect(list.map((s) => s.id).sort()).toEqual([...old, ...added].sort())
    for (const id of added) {
      expect(list.find((s) => s.id === id)?.optional, id).toBeUndefined()
      for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) expect(budgetFor(id, size), `${id}/${size}`).toBeGreaterThan(0)
    }
    expect([SIZES.M.scenes, SIZES.XL.scenes, SIZES.XXL.scenes]).toEqual([300, 1000, 3000])
  })
})
