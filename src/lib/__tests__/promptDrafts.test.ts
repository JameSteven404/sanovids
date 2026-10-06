// Prompt drafts registry: every editor of a scene is flushed before a structural change; unregistering one keeps the
// others; nested flushes (a flush whose commit leads to another flush) are safe; one failing flush stops nothing.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { draftCount, flushAll, flushScenes, register, unregister } from '../promptDrafts'

const offs: (() => void)[] = []
const reg = (sceneId: string, flush: () => void) => {
  const off = register(sceneId, flush)
  offs.push(off)
  return off
}
afterEach(() => {
  for (const off of offs.splice(0)) off()
  vi.restoreAllMocks()
})

describe('promptDrafts', () => {
  it('flushes every editor of the scenes asked for, and only those', () => {
    const panel = vi.fn()
    const card = vi.fn()
    const other = vi.fn()
    reg('s1', panel)
    reg('s1', card)
    reg('s2', other)
    expect(draftCount('s1')).toBe(2)
    flushScenes(['s1'])
    expect(panel).toHaveBeenCalledTimes(1)
    expect(card).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    // duplicates in the list flush once; unknown scenes are a no-op
    flushScenes(['s2', 's2', 'nope'])
    expect(other).toHaveBeenCalledTimes(1)
    flushScenes(new Set(['s1', 's2']))
    expect([panel, card, other].map((f) => f.mock.calls.length)).toEqual([2, 2, 2])
  })

  it('unregistering one editor keeps the other one of the same scene', () => {
    const panel = vi.fn()
    const card = vi.fn()
    const offPanel = reg('s1', panel)
    reg('s1', card)
    offPanel()
    expect(draftCount('s1')).toBe(1)
    flushScenes(['s1'])
    expect(panel).not.toHaveBeenCalled()
    expect(card).toHaveBeenCalledTimes(1)
    unregister('s1', card)
    expect(draftCount('s1')).toBe(0)
    flushScenes(['s1'])
    expect(card).toHaveBeenCalledTimes(1)
    // unregistering twice, or something never registered, is harmless
    offPanel()
    unregister('zz', card)
  })

  it('flushAll flushes every scene', () => {
    const a = vi.fn()
    const b = vi.fn()
    reg('s1', a)
    reg('s2', b)
    flushAll()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('nested flushes are safe: an editor is never re-entered, the others still run', () => {
    const order: string[] = []
    const inner = vi.fn(() => order.push('inner'))
    // A commit that triggers another structural change (which flushes the same scenes again, and everything).
    const outer = vi.fn(() => {
      order.push('outer')
      flushScenes(['s1', 's2'])
      flushAll()
    })
    reg('s1', outer)
    reg('s2', inner)
    flushScenes(['s1'])
    expect(outer).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['outer', 'inner', 'inner'])
    // and it runs again next time (the guard is released)
    flushScenes(['s1'])
    expect(outer).toHaveBeenCalledTimes(2)
  })

  it('an editor unmounted by an earlier flush is not called from the old snapshot', () => {
    const second = vi.fn()
    let offSecond = () => undefined as void
    const first = vi.fn(() => offSecond())
    reg('s1', first)
    offSecond = reg('s1', second)
    flushScenes(['s1'])
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('a failing flush is reported and does not stop the others', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const ok = vi.fn()
    reg('s1', () => {
      throw new Error('boom')
    })
    reg('s1', ok)
    expect(() => flushScenes(['s1'])).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalledTimes(1)
    expect(() => flushAll()).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(2)
  })
})
