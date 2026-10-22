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
  })

  it('asks before deleting a "maybe billed" take (its "Chạy lại" finds the job; deleted, a run of its scene may pay again)', () => {
    const doubtful = [
      { id: 'u1', status: 'cancelled' as const, uncertain: true, provider: 'canvasapp' },
      { id: 'u2', status: 'failed' as const, uncertain: true, provider: 'dev' },
      { id: 'f1', status: 'failed' as const, uncertain: false, provider: 'canvasapp' },
      { id: 'm1', status: 'failed' as const, uncertain: true, provider: 'mock' },
    ]
    const c = checkTakeDelete(['u1'], doubtful, { label: 'S01·T2' })
    expect(c.maybeBilled).toBe(1)
    expect(c.question).toContain('Xoá vĩnh viễn S01·T2?')
    expect(c.question).toContain('S01·T2: không rõ canvasapp đã nhận (và trừ credit) chưa')
    expect(c.question).toContain('“Chạy lại” trên take tìm job cũ trước khi gửi')
    const dev = checkTakeDelete(['u2'], doubtful).question!
    expect(dev).toContain('canvasapp giả lập')
    expect(dev).toContain('credit dev')
    expect(checkTakeDelete(['u1', 'u2', 'f1'], doubtful).question).toContain('2 video: không rõ')
    // a plain failed take, or the old demo: nothing to ask
    expect(checkTakeDelete(['f1', 'm1'], doubtful).question).toBeNull()
    expect(checkTakeDelete(['u1'], doubtful, { confirm: false }).question).toBeNull()
  })

  it("'usedOnly' (a two-click button confirmed the file loss) never asks about the file; false never asks", () => {
    expect(checkTakeDelete(['t3'], takes, { confirm: 'usedOnly' }).question).toBeNull()
    expect(checkTakeDelete(['t1'], takes, { confirm: false }).question).toBeNull()
    expect(checkTakeDelete(['t1'], takes, { confirm: 'usedOnly' }).ids).toEqual(['t1'])
  })

  it("'usedOnly' still asks about credit: the node's trash / the viewer's button only said the file is lost", () => {
    const money = [
      { id: 'a', status: 'processing' as const, videoReady: true, provider: 'canvasapp' },
      { id: 'b', status: 'cancelled' as const, uncertain: true, provider: 'canvasapp' },
      { id: 'c', status: 'processing' as const, sent: true, provider: 'canvasapp' },
    ]
    const both = checkTakeDelete(['a', 'b'], money, { confirm: 'usedOnly' })
    expect([both.paidPending, both.maybeBilled]).toEqual([1, 1])
    expect(both.question).toContain('đã tạo xong trên canvasapp và đã trừ credit')
    expect(both.question).toContain('không rõ canvasapp đã nhận')
    expect(checkTakeDelete(['a'], money, { confirm: 'usedOnly', label: 'S01·T2' }).question).toContain('S01·T2 đã tạo xong')
    expect(checkTakeDelete(['b'], money, { confirm: 'usedOnly' }).question).not.toBeNull()
    expect(checkTakeDelete(['c'], money, { confirm: 'usedOnly' }).question).not.toBeNull()
    expect(checkTakeDelete(['a', 'b', 'c'], money, { confirm: false }).question).toBeNull()
  })

  it('asks before deleting a take whose job runs there (job id, or its request may have gone out), like the "Huỷ" toast', () => {
    const live = [
      { id: 's1', status: 'processing' as const, sent: true, provider: 'canvasapp' },
      { id: 's2', status: 'processing' as const, sent: true, provider: 'dev' },
      { id: 'n1', status: 'processing' as const, sent: false, provider: 'canvasapp' },
      { id: 'i1', status: 'processing' as const, sent: true, imported: true, provider: 'canvasapp' },
      { id: 'm1', status: 'processing' as const, sent: true, provider: 'mock' },
      { id: 'q1', status: 'queued' as const, sent: true, provider: 'canvasapp' },
    ]
    const c = checkTakeDelete(['s1'], live, { label: 'S02·T1' })
    expect(c.sentAway).toBe(1)
    expect(c.question).toContain('S02·T1 đang chạy trên canvasapp (job đã gửi hoặc đang gửi — có thể đã trừ credit)')
    expect(c.question).toContain('job vẫn chạy trên canvasapp.io.vn')
    const dev = checkTakeDelete(['s2'], live).question!
    expect(dev).toContain('canvasapp giả lập')
    expect(dev).toContain('Bảng phát triển')
    expect(dev).not.toContain('canvasapp.io.vn')
    // nothing sent yet (submit still before its POST), an imported job ("Nhập job" offers it again), the old demo,
    // a queued take: nothing to ask
    expect(checkTakeDelete(['n1', 'i1', 'm1', 'q1'], live).question).toBeNull()
    // a paid video still downloading is said once (paidPending), not also as "still running"
    const paid = checkTakeDelete(['p'], [{ id: 'p', status: 'processing', videoReady: true, sent: true, provider: 'canvasapp' }])
    expect([paid.paidPending, paid.sentAway]).toEqual([1, 0])
  })

  it('asks before deleting a parked take of a newer build (its job may still run, and bill, there), even as "failed" mock', () => {
    const parked = [{ id: 'k1', status: 'failed' as const, parked: true, provider: 'mock' }]
    const c = checkTakeDelete(['k1'], parked, { label: 'S01·T2' })
    expect(c.parked).toBe(1)
    expect(c.question).toBe('Xoá vĩnh viễn S01·T2? Video đã xoá không hoàn tác được.\nS01·T2 có thể vẫn đang chạy (và tính credit) ở bản SanoVids mới hơn: xoá ở đây không huỷ job đó.')
    // a credit case: asked even when the caller only confirms credit ('usedOnly'), never with false
    expect(checkTakeDelete(['k1'], parked, { confirm: 'usedOnly' }).question).toContain('1 video có thể vẫn đang chạy')
    expect(checkTakeDelete(['k1'], parked, { confirm: false }).question).toBeNull()
  })
})
