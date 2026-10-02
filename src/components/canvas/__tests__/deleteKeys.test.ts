// Delete / Backspace rules of the global shortcuts (src/hooks/useShortcuts.ts).
import { describe, expect, it, vi } from 'vitest'
import { deleteKeyAction, keyboardDeletePlan } from '../../../hooks/useShortcuts'

// (hoisted above the imports) keep IndexedDB persistence out of a pure-logic test
vi.mock('../../../store/persist', () => ({ flush: async () => true }))

describe('deleteKeyAction', () => {
  it('Delete deletes everywhere', () => {
    expect(deleteKeyAction('Delete', false)).toBe('now')
    expect(deleteKeyAction('Delete', true)).toBe('now')
  })
  it('Backspace never deletes on Windows / Linux (Unikey / EVKey send it to rewrite letters)', () => {
    expect(deleteKeyAction('Backspace', false)).toBeNull()
  })
  it('macOS ⌫ deletes after a grace period (cancelled when an input tool types right after it)', () => {
    expect(deleteKeyAction('Backspace', true)).toBe('deferred')
  })
  it('other keys do nothing', () => {
    expect(deleteKeyAction('e', false)).toBeNull()
    expect(deleteKeyAction('ê', true)).toBeNull()
  })
})

describe('keyboardDeletePlan', () => {
  const scenes = new Set(['s1', 's2', 's3'])
  const takeScene = new Map([
    ['t1', 's1'],
    ['t2', 's1'],
    ['t3', 's2'],
    ['t9', 'gone'],
  ])
  it('spares takes whose own scene is deleted too (they come back with Undo)', () => {
    const plan = keyboardDeletePlan(['s1', 't1', 't2', 't3'], scenes, takeScene)
    expect(plan.spared).toEqual(['t1', 't2'])
    expect(plan.ids).toEqual(['s1', 't3'])
    expect(plan.takes).toEqual(['t3'])
  })
  it('takes selected on their own are deleted for good', () => {
    const plan = keyboardDeletePlan(['t1', 't9', 'a1'], scenes, takeScene)
    expect(plan.spared).toEqual([])
    expect(plan.ids).toEqual(['t1', 't9', 'a1'])
    expect(plan.takes).toEqual(['t1', 't9'])
  })
})
