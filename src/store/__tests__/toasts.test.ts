import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUI } from '../ui'

beforeEach(() => {
  vi.useFakeTimers()
  useUI.setState({ toasts: [] })
})
afterEach(() => vi.useRealTimers())

describe('toasts', () => {
  it('a persistent toast never times out and is not pushed out by newer ones', () => {
    const id = useUI.getState().toast('Đã có phiên bản mới', { persistent: true, action: { label: 'Tải lại', run: () => undefined } })
    for (let i = 0; i < 6; i++) useUI.getState().toast('t' + i)
    expect(useUI.getState().toasts).toHaveLength(4)
    expect(useUI.getState().toasts[0]).toMatchObject({ id, persistent: true })
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(useUI.getState().toasts.map((t) => t.id)).toEqual([id])
    useUI.getState().dismissToast(id)
    expect(useUI.getState().toasts).toEqual([])
  })
  it('ordinary toasts go after their time', () => {
    useUI.getState().toast('x')
    vi.advanceTimersByTime(3000)
    expect(useUI.getState().toasts).toEqual([])
  })
})
