import { describe, expect, it } from 'vitest'
import { checkTakeDelete, keyboardDeletePlan } from '../deletePlan'

describe('keyboardDeletePlan (core)', () => {
  it('spares takes selected with their own scene', () => {
    const plan = keyboardDeletePlan(['s1', 't1', 't3'], new Set(['s1', 's2']), new Map([['t1', 's1'], ['t3', 's2']]))
    expect(plan).toEqual({ ids: ['s1', 't3'], spared: ['t1'], takes: ['t3'] })
  })
})

describe('checkTakeDelete', () => {
  const takes = [
    { id: 't1', status: 'completed' as const },
    { id: 't2', status: 'failed' as const },
    { id: 't3', status: 'completed' as const },
  ]
  const scenes = [
    { id: 's2', order: 2, videoRefs: ['t1'] },
    { id: 's1', order: 1, videoRefs: [] },
    { id: 's3', order: 3, videoRefs: ['t1', 't3'] },
  ]

  it('asks when a finished video is lost, naming the scenes that use it', () => {
    const c = checkTakeDelete(['t1'], takes, scenes, { label: 'S01·T1' })
    expect(c.ids).toEqual(['t1'])
    expect(c.finished).toBe(1)
    expect(c.usedBy.map((s) => s.id)).toEqual(['s2', 's3'])
    expect(c.question).toContain('Xoá vĩnh viễn S01·T1?')
    expect(c.question).toContain('S02, S03')
  })

  it('does not ask for failed takes nobody uses', () => {
    expect(checkTakeDelete(['t2'], takes, scenes).question).toBeNull()
  })

  it('counts finished ones among several and ignores unknown ids', () => {
    const c = checkTakeDelete(['t1', 't2', 'nope'], takes, [], {})
    expect(c.ids).toEqual(['t1', 't2'])
    expect(c.question).toContain('2 video (1 video đã tạo xong)')
  })

  it('asks before deleting a running take whose paid video is still downloading (like "Huỷ"), in the words of its gateway', () => {
    const running = [
      { id: 'r1', status: 'processing' as const, videoReady: true, provider: 'canvasapp' },
      { id: 'r2', status: 'processing' as const, videoReady: false, provider: 'canvasapp' },
      { id: 'd1', status: 'processing' as const, videoReady: true, provider: 'dev' },
      { id: 'm1', status: 'processing' as const, videoReady: true, provider: 'mock' },
    ]
    const c = checkTakeDelete(['r1'], running, [], { label: 'S01·T2' })
    expect(c.paidPending).toBe(1)
    expect(c.question).toContain('Xoá vĩnh viễn S01·T2?')
    expect(c.question).toContain('S01·T2 đã tạo xong trên canvasapp và đã trừ credit')
    expect(c.question).toContain('vẫn tải được trên canvasapp.io.vn')
    const dev = checkTakeDelete(['d1'], running, []).question!
    expect(dev).toContain('credit dev')
    expect(dev).not.toContain('canvasapp.io.vn')
    // still being made (nothing paid yet known), or the old demo: nothing to ask
    expect(checkTakeDelete(['r2', 'm1'], running, []).question).toBeNull()
    expect(checkTakeDelete(['r1'], running, [], { confirm: 'usedOnly' }).question).toBeNull()
  })

  it("'usedOnly' asks only for @video users; scenes deleted together do not count", () => {
    expect(checkTakeDelete(['t3'], takes, scenes, { confirm: 'usedOnly', ignoreScenes: new Set(['s3']) }).question).toBeNull()
    expect(checkTakeDelete(['t3'], takes, scenes, { confirm: 'usedOnly' }).question).toContain('S03')
    expect(checkTakeDelete(['t1'], takes, scenes, { confirm: false }).question).toBeNull()
  })
})
