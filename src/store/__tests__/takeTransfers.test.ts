// store/takeTransfers: the download progress of finished videos ("Đang tải về 45%" on the take node / Xem take).
import { beforeEach, describe, expect, it } from 'vitest'
import { clearTakeTransfer, clearTakeTransfers, formatMegabytes, reportTakeTransfer, transferLabel, transferPercent, useTakeTransfers } from '../takeTransfers'

beforeEach(() => clearTakeTransfers())

describe('take transfers', () => {
  it('labels: percent when the size is known (never 100 % before the take completes), else megabytes', () => {
    const MB = 1024 * 1024
    expect(transferLabel({ received: 47 * MB, total: 100 * MB })).toBe('Đang tải về 47%')
    expect(transferLabel({ received: 100 * MB, total: 100 * MB })).toBe('Đang tải về 99%')
    expect(transferLabel({ received: 0, total: 100 })).toBe('Đang tải về 0%')
    expect(transferLabel({ received: Math.round(12.34 * MB), total: null })).toBe('Đang tải về 12,3 MB')
    expect(transferLabel({ received: 0, total: null })).toBe('Đang tải về 0,0 MB')
    expect(transferLabel(undefined)).toBeNull()
    expect(transferPercent({ received: 5, total: null })).toBeNull()
    expect(transferPercent(undefined)).toBeNull()
    expect(formatMegabytes(1536 * 1024)).toBe('1,5')
  })

  it('report / clear: one entry per take, invalid numbers ignored, same value → no change', () => {
    reportTakeTransfer('a', { received: 10, total: 100 })
    reportTakeTransfer('b', { received: 5, total: 0 })
    reportTakeTransfer('c', { received: Number.NaN, total: 1 })
    expect(useTakeTransfers.getState().byTake).toEqual({ a: { received: 10, total: 100 }, b: { received: 5, total: null } })
    const before = useTakeTransfers.getState()
    reportTakeTransfer('a', { received: 10, total: 100 })
    expect(useTakeTransfers.getState()).toBe(before)
    clearTakeTransfer('a')
    clearTakeTransfer('zzz')
    expect(Object.keys(useTakeTransfers.getState().byTake)).toEqual(['b'])
    clearTakeTransfers()
    expect(useTakeTransfers.getState().byTake).toEqual({})
  })
})
