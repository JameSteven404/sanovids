// openWhenLoaded: a menu whose builder chunk is still loading never opens stale (PR #13 F2) — not after another menu
// request, nor after a press / key / wheel in between (it would act on a selection it was not built for).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openWhenLoaded } from '../contextMenuStore'

const deferred = () => {
  let resolve!: (v: string) => void
  const promise = new Promise<string>((r) => (resolve = r))
  return { promise, resolve }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('openWhenLoaded', () => {
  let win: EventTarget
  beforeEach(() => {
    win = new EventTarget()
    vi.stubGlobal('window', win)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('opens once loaded when nothing happened meanwhile (an already loaded chunk: same task)', async () => {
    const open = vi.fn()
    openWhenLoaded(Promise.resolve('m'), open)
    await flush()
    expect(open).toHaveBeenCalledWith('m')
  })

  it('a press, a key or a wheel while loading drops the menu', async () => {
    for (const type of ['pointerdown', 'keydown', 'wheel']) {
      const d = deferred()
      const open = vi.fn()
      openWhenLoaded(d.promise, open)
      win.dispatchEvent(new Event(type))
      d.resolve('m')
      await flush()
      expect(open, type).not.toHaveBeenCalled()
    }
  })

  it('a later menu request wins: only the last one opens, whichever loads first', async () => {
    const first = deferred()
    const second = deferred()
    const a = vi.fn()
    const b = vi.fn()
    openWhenLoaded(first.promise, a)
    openWhenLoaded(second.promise, b)
    second.resolve('b')
    first.resolve('a')
    await flush()
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledWith('b')
  })

  it('stops listening once settled (a failed load too): a later press does not cancel the next menu', async () => {
    openWhenLoaded(Promise.reject(new Error('chunk')), vi.fn())
    await flush()
    const d = deferred()
    const open = vi.fn()
    openWhenLoaded(d.promise, open)
    d.resolve('m')
    await flush()
    expect(open).toHaveBeenCalled()
  })
})
