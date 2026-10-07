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

  it("'usedOnly' asks only for @video users; scenes deleted together do not count", () => {
    expect(checkTakeDelete(['t3'], takes, scenes, { confirm: 'usedOnly', ignoreScenes: new Set(['s3']) }).question).toBeNull()
    expect(checkTakeDelete(['t3'], takes, scenes, { confirm: 'usedOnly' }).question).toContain('S03')
    expect(checkTakeDelete(['t1'], takes, scenes, { confirm: false }).question).toBeNull()
  })

  it('MONEY: a running take whose paid video is still downloading asks first (also after a two-click button), like “Huỷ”', () => {
    const running = [
      { id: 'r1', status: 'processing' as const, provider: 'canvasapp' as const },
      { id: 'r2', status: 'processing' as const, provider: 'canvasapp' as const },
      { id: 'r3', status: 'processing' as const, provider: 'dev' as const },
      { id: 'r4', status: 'processing' as const, provider: 'canvasapp' as const, imported: { at: 1 } },
    ]
    const ready = (id: string) => id !== 'r2'
    const one = checkTakeDelete(['r1'], running, [], { label: 'S03·T2', videoReady: ready })
    expect(one.paidPending).toBe(1)
    expect(one.question).toContain('Xoá vĩnh viễn S03·T2?')
    expect(one.question).toContain('video đã tạo xong trên canvasapp và đã trừ credit')
    expect(one.question).toContain('canvasapp.io.vn')
    expect(checkTakeDelete(['r1'], running, [], { confirm: 'usedOnly', videoReady: ready }).question).toContain('đã trừ credit')
    expect(checkTakeDelete(['r1'], running, [], { confirm: false, videoReady: ready }).question).toBeNull()
    // still being made (nothing paid lost yet): no question, as before
    expect(checkTakeDelete(['r2'], running, [], { videoReady: ready })).toMatchObject({ paidPending: 0, question: null })
    // development mode words
    expect(checkTakeDelete(['r3'], running, [], { label: 'S01·T1', videoReady: ready }).question).toContain('canvasapp giả lập và đã trừ credit dev')
    // an imported take loses nothing paid: "Nhập job" brings its job back
    expect(checkTakeDelete(['r4'], running, [], { confirm: 'usedOnly', videoReady: ready })).toMatchObject({ paidPending: 0, question: null })
    // several
    expect(checkTakeDelete(['r1', 'r2', 'r3'], running, [], { videoReady: ready }).question).toContain('2 video đã tạo xong')
  })
})
