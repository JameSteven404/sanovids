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

  it('asks when a finished video is lost (never about @video users: reference videos were retired)', () => {
    const c = checkTakeDelete(['t1'], takes, { label: 'S01·T1' })
    expect(c.ids).toEqual(['t1'])
    expect(c.finished).toBe(1)
    expect(c).not.toHaveProperty('usedBy')
    expect(c.question).toBe('Xoá vĩnh viễn S01·T1? Video đã xoá không hoàn tác được.')
    expect(c.question).not.toContain('@video')
  })

  it('does not ask for failed takes', () => {
    expect(checkTakeDelete(['t2'], takes).question).toBeNull()
  })

  it('counts finished ones among several and ignores unknown ids', () => {
    const c = checkTakeDelete(['t1', 't2', 'nope'], takes, {})
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
    const c = checkTakeDelete(['r1'], running, { label: 'S01·T2' })
    expect(c.paidPending).toBe(1)
    expect(c.question).toContain('Xoá vĩnh viễn S01·T2?')
    expect(c.question).toContain('S01·T2 đã tạo xong trên canvasapp và đã trừ credit')
    expect(c.question).toContain('vẫn tải được trên canvasapp.io.vn')
    const dev = checkTakeDelete(['d1'], running).question!
    expect(dev).toContain('credit dev')
    expect(dev).not.toContain('canvasapp.io.vn')
    // still being made (nothing paid yet known), or the old demo: nothing to ask
    expect(checkTakeDelete(['r2', 'm1'], running).question).toBeNull()
    expect(checkTakeDelete(['r1'], running, { confirm: 'usedOnly' }).question).toBeNull()
  })

  it("'usedOnly' (the caller already confirmed) and false never ask", () => {
    expect(checkTakeDelete(['t3'], takes, { confirm: 'usedOnly' }).question).toBeNull()
    expect(checkTakeDelete(['t1'], takes, { confirm: false }).question).toBeNull()
    expect(checkTakeDelete(['t1'], takes, { confirm: 'usedOnly' }).ids).toEqual(['t1'])
  })
})
