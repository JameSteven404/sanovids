// Which credits paid a take, and the run dialog's balance preview (docs/SPEC-v2.md §9).
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/imageStore', () => ({
  putBlob: vi.fn(async () => 'x'),
  getBlob: vi.fn(async () => null),
  getUrl: vi.fn(async () => null),
  cachedUrl: () => null,
  deleteMedia: vi.fn(async () => undefined),
  dataUrlToBlob: () => new Blob(),
  useMediaUrl: () => null,
}))

import type { Take } from '../../../core/types'
import { UNKNOWN_SUBMIT_ERROR } from '../../../store/runs'
import { runCostPreview, takeCostLabel, takeCostLine, takeCreditKind } from '../creditText'

type T = Pick<Take, 'provider' | 'charged' | 'cost' | 'status' | 'remoteId' | 'error'>
const take = (patch: Partial<T>): T => ({ provider: 'mock', charged: true, cost: 20, status: 'completed', remoteId: null, error: null, ...patch })

describe('takeCreditKind / takeCostLabel', () => {
  it('follows the take provider (old takes without one ran on the demo)', () => {
    expect(takeCreditKind({})).toBe('demo')
    expect(takeCreditKind({ provider: 'canvasapp' })).toBe('canvasapp')
    expect(takeCostLabel({ provider: 'mock', cost: 1500 })).toBe('1.500 credit demo')
    expect(takeCostLabel({ provider: 'canvasapp', cost: 20 })).toBe('20 credit canvasapp')
    expect(takeCreditKind({ provider: 'dev' })).toBe('dev')
    expect(takeCostLabel({ provider: 'dev', cost: 20 })).toBe('20 credit dev')
  })
})

describe('takeCostLine — development mode (dev)', () => {
  it('paid with simulated credit dev once the simulation accepted the job — never "canvasapp" or "demo"', () => {
    const done = takeCostLine(take({ provider: 'dev', charged: false, remoteId: 'r1' }))
    expect(done).toMatchObject({ kind: 'dev', amount: '20 credit dev', struck: false })
    expect(done.note).toContain('đã trả bằng credit dev')
    expect(done.note).toContain('giả lập')
    expect(done.note).not.toMatch(/canvasapp|demo/)

    const failed = takeCostLine(take({ provider: 'dev', charged: false, remoteId: 'r1', status: 'failed' }))
    expect(failed.struck).toBe(false)
    expect(failed.note).toContain('máy chủ giả lập quyết định')
  })

  it('not accepted / unknown / cancelled point at the simulation and the dev panel', () => {
    expect(takeCostLine(take({ provider: 'dev', status: 'queued' })).note).toBe('credit dev · trừ trên máy chủ giả lập khi job được nhận')
    const rejected = takeCostLine(take({ provider: 'dev', status: 'failed', error: '402' }))
    expect(rejected).toMatchObject({ struck: true, note: 'máy chủ giả lập không nhận job — không bị trừ credit' })
    const unknown = takeCostLine(take({ provider: 'dev', status: 'failed', error: UNKNOWN_SUBMIT_ERROR }))
    expect(unknown.struck).toBe(false)
    expect(unknown.note).toContain('Bảng phát triển')
    const sending = takeCostLine({ ...take({ provider: 'dev', charged: false, status: 'cancelled' }), startedAt: 1000 })
    expect(sending.note).toContain('máy chủ giả lập đã nhận job')
    expect(sending.note).not.toContain('canvasapp')
  })
})

describe('takeCostLine', () => {
  it('demo: paid with demo credits, refunded when it failed or was cancelled', () => {
    const ok = takeCostLine(take({}))
    expect(ok).toMatchObject({ kind: 'demo', amount: '20 credit demo', struck: false })
    expect(ok.note).toContain('đã trả bằng credit demo')

    for (const status of ['failed', 'cancelled'] as const) {
      const r = takeCostLine(take({ status }))
      expect(r.struck).toBe(true)
      expect(r.note).toContain('đã hoàn')
    }
  })

  it('canvasapp: paid with canvasapp credits once accepted, never "refunded" by SanoVids', () => {
    const done = takeCostLine(take({ provider: 'canvasapp', charged: false, remoteId: 'r1' }))
    expect(done).toMatchObject({ kind: 'canvasapp', amount: '≈ 20 credit', struck: false })
    expect(done.note).toBe('đã trả bằng credit canvasapp')

    const failed = takeCostLine(take({ provider: 'canvasapp', charged: false, remoteId: 'r1', status: 'failed' }))
    expect(failed.struck).toBe(false)
    expect(failed.note).toContain('canvasapp quyết định')
  })

  it('canvasapp: a wrong charged flag never turns it into a demo refund', () => {
    const r = takeCostLine(take({ provider: 'canvasapp', charged: true, remoteId: 'r1', status: 'cancelled' }))
    expect(r.kind).toBe('canvasapp')
    expect(r.note).not.toContain('demo')
    expect(r.note).not.toContain('đã hoàn')
  })

  it('canvasapp: not accepted yet / never accepted / unknown', () => {
    expect(takeCostLine(take({ provider: 'canvasapp', status: 'queued' })).note).toContain('trừ trên canvasapp khi job được nhận')
    const rejected = takeCostLine(take({ provider: 'canvasapp', status: 'failed', error: 'Hết credit' }))
    expect(rejected.struck).toBe(true)
    expect(rejected.note).toContain('không bị trừ')
    const unknown = takeCostLine(take({ provider: 'canvasapp', status: 'failed', error: UNKNOWN_SUBMIT_ERROR }))
    expect(unknown.struck).toBe(false)
    expect(unknown.note).toContain('không rõ')
  })

  it('canvasapp: cancelled before sending is free; cancelled while sending may still be billed', () => {
    const notSent = takeCostLine({ ...take({ provider: 'canvasapp', charged: false, status: 'cancelled' }), startedAt: null })
    expect(notSent.struck).toBe(true)
    expect(notSent.note).toContain('không bị trừ')
    const sending = takeCostLine({ ...take({ provider: 'canvasapp', charged: false, status: 'cancelled' }), startedAt: 1000 })
    expect(sending.struck).toBe(false)
    expect(sending.note).toContain('có thể đã trừ')
    expect(sending.note).not.toContain('không bị trừ')
  })
})

describe('runCostPreview', () => {
  it('demo: before → after, blocked when short', () => {
    expect(runCostPreview('demo', 30, 1000)).toEqual({ kind: 'demo', total: 30, before: 1000, after: 970, short: false, mayBeShort: false })
    expect(runCostPreview('demo', 30, 20)).toMatchObject({ after: -10, short: true })
  })

  it('canvasapp: real balance → estimated after, never blocked (only a warning)', () => {
    expect(runCostPreview('canvasapp', 30, 377)).toMatchObject({ before: 377, after: 347, short: false, mayBeShort: false })
    expect(runCostPreview('canvasapp', 30, 10)).toMatchObject({ after: -20, short: false, mayBeShort: true })
  })

  it('dev (development mode): the simulated balance warns like canvasapp, never blocks', () => {
    expect(runCostPreview('dev', 30, 1000)).toMatchObject({ kind: 'dev', after: 970, short: false, mayBeShort: false })
    expect(runCostPreview('dev', 30, 10)).toMatchObject({ after: -20, short: false, mayBeShort: true })
  })

  it('canvasapp: unknown balance stays unknown', () => {
    expect(runCostPreview('canvasapp', 30, null)).toMatchObject({ before: null, after: null, short: false, mayBeShort: false })
    expect(runCostPreview('canvasapp', 30, Number.NaN)).toMatchObject({ before: null, after: null })
  })
})
