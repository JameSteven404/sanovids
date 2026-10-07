import { afterEach, describe, expect, it, vi } from 'vitest'
import { canvasEvents, REVEAL_EVENT } from '../../../actions'
import { useUI } from '../../../store/ui'
import { livePendingRename, RENAME_TAKE_EVENT, RENAME_WAIT_MS, requestTakeRename, takePendingRename, type RenameTakeDetail } from '../takeEvents'

const listeners: [string, EventListener][] = []
function on(type: string, fn: (e: Event) => void) {
  canvasEvents.addEventListener(type, fn)
  listeners.push([type, fn])
}

afterEach(() => {
  for (const [type, fn] of listeners.splice(0)) canvasEvents.removeEventListener(type, fn)
  vi.useRealTimers()
  useUI.getState().closeDialog()
})

describe('"Đổi tên file" from anywhere (RENAME_TAKE_EVENT)', () => {
  it('a rendered near node takes it at once: nothing waits, no pan', () => {
    const reveals: unknown[] = []
    on(REVEAL_EVENT, (e) => reveals.push((e as CustomEvent).detail))
    on(RENAME_TAKE_EVENT, (e) => {
      const d = (e as CustomEvent<RenameTakeDetail>).detail
      if (d.takeId === 't1') d.handled = true
    })
    requestTakeRename('t1')
    expect(reveals).toEqual([])
    expect(takePendingRename('t1')).toBe(false)
  })

  it('nobody renders it: the canvas pans there and the node takes it when it mounts (once)', () => {
    vi.useFakeTimers()
    const reveals: unknown[] = []
    on(REVEAL_EVENT, (e) => reveals.push((e as CustomEvent).detail))
    requestTakeRename('t2')
    expect(reveals).toEqual([['t2']])
    expect(takePendingRename('t9')).toBe(false)
    expect(takePendingRename('t2')).toBe(true)
    expect(takePendingRename('t2')).toBe(false)
    vi.advanceTimersByTime(RENAME_WAIT_MS + 10)
    expect(useUI.getState().dialog.kind).toBe('none')
  })

  it('still nobody after the wait: the take viewer opens (its "Tên file" field renames too)', () => {
    vi.useFakeTimers()
    requestTakeRename('t3')
    vi.advanceTimersByTime(RENAME_WAIT_MS + 10)
    expect(useUI.getState().dialog).toEqual({ kind: 'take', takeId: 't3' })
  })

  it('a pending rename belongs to one take and lasts RENAME_WAIT_MS', () => {
    expect(livePendingRename({ takeId: 'a', at: 100 }, 'a', 100 + RENAME_WAIT_MS)).toBe(true)
    expect(livePendingRename({ takeId: 'a', at: 100 }, 'a', 101 + RENAME_WAIT_MS)).toBe(false)
    expect(livePendingRename({ takeId: 'a', at: 100 }, 'b', 150)).toBe(false)
    expect(livePendingRename(null, 'a', 150)).toBe(false)
  })
})
