// updateActions (createUpdateController with fakes): which toasts appear (ready once per version, the launch notice
// once, nothing for automatic checks), the install sequence (hold submits → wait for sends → commit drafts → save →
// install) and every way it gives the hold back, "Cập nhật khi xong", and the "Nhập prompt" guard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { UpdatesStore } from '../lib/updates'
import type { UpdateResult, UpdateState } from '../lib/updateTypes'
import { UPDATE_ERROR_TEXT } from '../lib/updateModel'
import { COUNTDOWN_MS, createUpdateController, INSTALL_WATCHDOG_MS, SEND_WAIT_MS, UPDATE_TOAST, type UpdateControllerDeps } from '../updateActions'

const ready = (version = '0.5.1', patch: Partial<UpdateState> = {}): UpdateState => ({
  kind: 'installer',
  current: '0.5.0',
  status: 'ready',
  version,
  percent: 100,
  autoDownload: true,
  ...patch,
})

interface ToastCall {
  id: number
  text: string
  opts?: Parameters<UpdateControllerDeps['toast']>[1]
}

function harness(initial: UpdateState = { kind: 'installer', current: '0.5.0', status: 'idle', autoDownload: true }) {
  const order: string[] = []
  const toasts: ToastCall[] = []
  const dismissed: number[] = []
  const store = create<UpdatesStore>()(() => ({ state: initial, source: 'desktop' }))
  const session = new Map<string, string>()
  let counts = { queued: 0, processing: 0 }
  let sending = 0
  let pending = 0
  let topup = false
  let dialog = 'none'
  let hold = false
  const activeListeners = new Set<() => void>()
  const results = { check: { ok: true } as UpdateResult, install: { ok: true } as UpdateResult, flush: true }
  let afterCheck: UpdateState | null = null
  let id = 0

  const deps: UpdateControllerDeps = {
    client: {
      store,
      connect: vi.fn(() => () => undefined),
      check: vi.fn(async () => {
        order.push('check')
        return results.check
      }),
      install: vi.fn(async () => {
        order.push('install')
        return results.install
      }),
      openReleasePage: vi.fn(async () => ({ ok: true }) as UpdateResult),
      refresh: vi.fn(async () => {
        if (afterCheck) store.setState({ state: afterCheck })
      }),
    },
    flush: vi.fn(async () => {
      order.push('flush')
      return results.flush
    }),
    saveReady: () => true,
    flushDrafts: vi.fn(() => void order.push('flushDrafts')),
    runs: {
      counts: () => counts,
      sendingCount: () => {
        order.push(`sending:${sending}`)
        return sending
      },
      subscribeActive: (l) => {
        activeListeners.add(l)
        return () => activeListeners.delete(l)
      },
      holdNewSubmits: (on) => {
        hold = on
        order.push(`hold:${on}`)
      },
    },
    topupInFlight: async () => topup,
    pendingDownloads: () => pending,
    toast: (text, opts) => {
      toasts.push({ id: ++id, text, opts })
      return id
    },
    dismissToast: (tid) => void dismissed.push(tid),
    ui: { dialogKind: () => dialog, openDialog: vi.fn(() => void (dialog = 'update')) },
    session: { get: (k) => session.get(k) ?? null, set: (k, v) => void session.set(k, v) },
  }
  const c = createUpdateController(deps)
  return {
    c,
    deps,
    store,
    order,
    toasts,
    dismissed,
    session,
    results,
    texts: () => toasts.map((t) => t.text),
    setState: (s: UpdateState) => store.setState({ state: s }),
    setCounts: (q: number, p: number) => {
      counts = { queued: q, processing: p }
      for (const l of [...activeListeners]) l()
    },
    setSending: (n: number) => void (sending = n),
    setPending: (n: number) => void (pending = n),
    setTopup: (v: boolean) => void (topup = v),
    setDialog: (k: string) => void (dialog = k),
    afterCheck: (s: UpdateState) => void (afterCheck = s),
    hold: () => hold,
    runToastAction: (text: string) => {
      const t = [...toasts].reverse().find((x) => x.text === text)
      if (!t?.opts?.action) throw new Error(`no action on toast ${text}`)
      t.opts.action.run()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('effects', () => {
  it('one "ready" toast per version (none while the dialog shows it)', () => {
    const h = harness()
    const stop = h.c.start()
    expect(h.deps.client.connect).toHaveBeenCalledTimes(1)
    h.setState({ ...ready(), status: 'downloading', percent: 50 })
    h.setState(ready())
    h.setState({ ...ready(), status: 'downloading', percent: 99 })
    h.setState(ready())
    expect(h.texts()).toEqual(['Đã tải xong SanoVids 0.5.1.'])
    expect(h.toasts[0].opts).toMatchObject({ tone: 'success', ms: 10_000, action: { label: 'Khởi động lại' } })
    h.setDialog('update')
    h.setState(ready('0.5.2'))
    expect(h.texts()).toHaveLength(1)
    h.setDialog('none')
    h.setState(ready('0.5.3'))
    expect(h.texts()).toEqual(['Đã tải xong SanoVids 0.5.1.', 'Đã tải xong SanoVids 0.5.3.'])
    // a portable build never downloads: no toast
    h.setState(ready('0.5.4', { kind: 'portable' }))
    expect(h.texts()).toHaveLength(2)
    stop()
  })

  it('the launch notice is shown once (page load and tab session)', () => {
    const h = harness()
    h.c.start()
    const notice = { kind: 'updated' as const, from: '0.4.2', version: '0.5.0' }
    h.setState({ kind: 'installer', current: '0.5.0', status: 'idle', autoDownload: true, notice })
    h.setState({ kind: 'installer', current: '0.5.0', status: 'checking', autoDownload: true, notice })
    expect(h.texts()).toEqual(['Đã cập nhật SanoVids lên 0.5.0.'])
    expect(h.session.get('bdp:upd-notice:installer:0.5.0')).toBe('1')

    // a reload of the page (same tab session): not again
    const again = harness({ kind: 'installer', current: '0.5.0', status: 'idle', autoDownload: true, notice })
    again.session.set('bdp:upd-notice:installer:0.5.0', '1')
    again.c.start()
    expect(again.texts()).toEqual([])

    const failed = harness({ kind: 'installer', current: '0.5.0', status: 'idle', autoDownload: true, notice: { kind: 'install-failed', version: '0.5.1' } })
    failed.c.start()
    expect(failed.texts()).toEqual(['Chưa cài được bản 0.5.1. SanoVids sẽ thử lại khi bạn tắt app.'])
    failed.runToastAction('Chưa cài được bản 0.5.1. SanoVids sẽ thử lại khi bạn tắt app.')
    expect(failed.deps.client.openReleasePage).toHaveBeenCalled()
  })

  it('a download refused for its signature: one toast per version with "Trang tải về" (none while the dialog shows it)', () => {
    const sigError = (version: string): UpdateState => ({
      kind: 'installer',
      current: '0.5.0',
      status: 'error',
      version,
      autoDownload: true,
      error: { code: 'signature', message: UPDATE_ERROR_TEXT.signature },
    })
    const h = harness()
    h.c.start()
    h.setState({ kind: 'installer', current: '0.5.0', status: 'downloading', version: '0.5.1', percent: 40, autoDownload: true })
    h.setState(sigError('0.5.1'))
    h.setState({ kind: 'installer', current: '0.5.0', status: 'available', version: '0.5.1', autoDownload: true })
    h.setState(sigError('0.5.1')) // the same version found again by a later check: no second toast
    expect(h.texts()).toEqual([UPDATE_ERROR_TEXT.signature])
    expect(h.toasts[0].opts).toMatchObject({ tone: 'error', action: { label: 'Trang tải về' } })
    h.runToastAction(UPDATE_ERROR_TEXT.signature)
    expect(h.deps.client.openReleasePage).toHaveBeenCalledTimes(1)
    h.setDialog('update')
    h.setState(sigError('0.5.2'))
    expect(h.texts()).toHaveLength(1)
  })

  it('automatic checks stay silent', () => {
    for (const kind of ['installer', 'portable'] as const) {
      const h = harness({ kind, current: '0.5.0', status: 'idle', autoDownload: true })
      h.c.start()
      h.setState({ kind, current: '0.5.0', status: 'checking', autoDownload: true })
      h.setState({ kind, current: '0.5.0', status: 'none', autoDownload: true, lastCheck: 1 })
      h.setState({ kind, current: '0.5.0', status: 'error', autoDownload: true, error: { code: 'offline', message: 'x' } })
      h.setState({ kind, current: '0.5.0', status: 'available', version: '0.5.1', autoDownload: true })
      h.setState({ kind, current: '0.5.0', status: 'downloading', version: '0.5.1', percent: 30, autoDownload: true })
      expect(h.texts()).toEqual([])
    }
  })
})

describe('manual check', () => {
  it('toasts the result read after the check', async () => {
    const h = harness()
    h.afterCheck({ kind: 'installer', current: '0.5.0', status: 'none', autoDownload: true, lastCheck: 1 })
    await h.c.checkNow()
    expect(h.texts()).toEqual(['Bạn đang dùng bản mới nhất (0.5.0).'])
    expect(h.c.installUi.getState().manualCheck).toBe(false)

    h.afterCheck({ kind: 'installer', current: '0.5.0', status: 'available', version: '0.5.1', autoDownload: false })
    await h.c.checkNow()
    expect(h.toasts.at(-1)).toMatchObject({ text: 'Có bản 0.5.1.', opts: { tone: 'info', action: { label: 'Xem' } } })
    h.runToastAction('Có bản 0.5.1.')
    expect(h.deps.ui.openDialog).toHaveBeenCalled()

    h.results.check = { ok: false, code: 'offline', message: 'Không kết nối được máy chủ cập nhật.' }
    h.afterCheck({ kind: 'installer', current: '0.5.0', status: 'error', autoDownload: true, error: { code: 'offline', message: 'Không kết nối được máy chủ cập nhật.' } })
    await h.c.checkNow()
    expect(h.toasts.at(-1)).toMatchObject({ text: 'Không kết nối được máy chủ cập nhật.', opts: { tone: 'error' } })
  })
})

describe('installNow', () => {
  it('holds submits, waits for sends, commits drafts, saves, then installs', async () => {
    const h = harness(ready())
    h.setSending(1)
    const done = h.c.installNow()
    expect(h.c.installUi.getState().busy).toBe('waiting-send')
    expect(h.hold()).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(h.deps.client.install).not.toHaveBeenCalled()
    h.setSending(0)
    await vi.advanceTimersByTimeAsync(300)
    await done
    const steps = h.order.filter((s) => !s.startsWith('sending:'))
    expect(steps).toEqual(['hold:true', 'flushDrafts', 'flush', 'hold:true', 'install'])
    expect(h.order.indexOf('sending:0')).toBeLessThan(h.order.indexOf('flushDrafts'))
    expect(h.c.installUi.getState().busy).toBe('restarting')
    expect(h.hold()).toBe(true) // kept: the app is quitting
    // still alive long after: the installer did not start
    await vi.advanceTimersByTimeAsync(INSTALL_WATCHDOG_MS)
    expect(h.c.installUi.getState().busy).toBeNull()
    expect(h.hold()).toBe(false)
    expect(h.texts()).toEqual([UPDATE_TOAST.installFailed])
  })

  it('sends that never end: gives the hold back after 15 s', async () => {
    const h = harness(ready())
    h.setSending(1)
    const done = h.c.installNow()
    await vi.advanceTimersByTimeAsync(SEND_WAIT_MS + 500)
    await done
    expect(h.hold()).toBe(false)
    expect(h.c.installUi.getState().busy).toBeNull()
    expect(h.deps.flush).not.toHaveBeenCalled()
    expect(h.deps.client.install).not.toHaveBeenCalled()
    expect(h.toasts.at(-1)).toMatchObject({ text: UPDATE_TOAST.sendTimeout, opts: { tone: 'warning' } })
  })

  it('a failed save stops before installing; "Vẫn cập nhật" installs anyway', async () => {
    const h = harness(ready())
    h.results.flush = false
    const done = h.c.installNow()
    await vi.advanceTimersByTimeAsync(10)
    await done
    expect(h.hold()).toBe(false)
    expect(h.c.installUi.getState().busy).toBeNull()
    expect(h.deps.client.install).not.toHaveBeenCalled()
    expect(h.toasts.at(-1)).toMatchObject({ text: UPDATE_TOAST.saveFailed, opts: { tone: 'error', action: { label: 'Vẫn cập nhật' } } })
    h.runToastAction(UPDATE_TOAST.saveFailed)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deps.client.install).toHaveBeenCalledTimes(1)
    expect(h.hold()).toBe(true)
    expect(h.c.installUi.getState().busy).toBe('restarting')
  })

  it('a refused install gives the hold back', async () => {
    const h = harness(ready())
    h.results.install = { ok: false, code: 'not-ready', message: 'Bản cập nhật chưa tải xong.' }
    const done = h.c.installNow()
    await vi.advanceTimersByTimeAsync(10)
    await done
    expect(h.hold()).toBe(false)
    expect(h.c.installUi.getState().busy).toBeNull()
    expect(h.texts()).toEqual([UPDATE_TOAST.installFailed])
  })

  it('main reports the install failed (pushed state) → the hold is given back at once', async () => {
    const h = harness(ready())
    h.c.start()
    h.toasts.length = 0
    const done = h.c.installNow()
    await vi.advanceTimersByTimeAsync(10)
    await done
    expect(h.c.installUi.getState().busy).toBe('restarting')
    h.setState(ready('0.5.1', { error: { code: 'install-failed', message: 'Không khởi động được trình cài bản cập nhật.' } }))
    expect(h.c.installUi.getState().busy).toBeNull()
    expect(h.hold()).toBe(false)
    expect(h.texts()).toEqual([UPDATE_TOAST.installFailed])
    await vi.advanceTimersByTimeAsync(INSTALL_WATCHDOG_MS)
    expect(h.texts()).toHaveLength(1) // the watchdog was cleared
  })

  it('main refuses the installer for its signature → the hold is given back, the signature toast (not "install failed")', async () => {
    const h = harness(ready())
    h.c.start()
    h.toasts.length = 0
    vi.mocked(h.deps.client.install).mockImplementationOnce(async () => {
      // main pushes the error state before it answers the install request
      h.setState({ ...ready(), status: 'error', percent: undefined, error: { code: 'signature', message: UPDATE_ERROR_TEXT.signature } })
      return { ok: false, code: 'signature', message: UPDATE_ERROR_TEXT.signature }
    })
    const done = h.c.installNow()
    await vi.advanceTimersByTimeAsync(10)
    await done
    expect(h.c.installUi.getState().busy).toBeNull()
    expect(h.hold()).toBe(false)
    expect(h.texts()).toEqual([UPDATE_ERROR_TEXT.signature])
    await vi.advanceTimersByTimeAsync(INSTALL_WATCHDOG_MS)
    expect(h.texts()).toHaveLength(1)

    // The answer before the push: still no "install failed" toast, and the hold is given back.
    const h2 = harness(ready())
    h2.results.install = { ok: false, code: 'signature', message: UPDATE_ERROR_TEXT.signature }
    const done2 = h2.c.installNow()
    await vi.advanceTimersByTimeAsync(10)
    await done2
    expect(h2.hold()).toBe(false)
    expect(h2.c.installUi.getState().busy).toBeNull()
    expect(h2.texts()).not.toContain(UPDATE_TOAST.installFailed)
  })

  it('does nothing unless an installer update is ready', async () => {
    for (const s of [ready('0.5.1', { kind: 'portable' }), ready('0.5.1', { status: 'available' }), ready('0.5.1', { kind: 'dev' })]) {
      const h = harness(s)
      await h.c.installNow()
      expect(h.order).toEqual([])
    }
  })
})

describe('requestInstall / dialog', () => {
  it('the toast installs at once when nothing is in progress, else opens the dialog; the pill always opens it', async () => {
    const h = harness(ready())
    await h.c.requestInstall('pill')
    expect(h.deps.ui.openDialog).toHaveBeenCalledTimes(1)
    expect(h.deps.client.install).not.toHaveBeenCalled()

    h.setDialog('none')
    h.setCounts(0, 2)
    await h.c.requestInstall('toast')
    expect(h.deps.ui.openDialog).toHaveBeenCalledTimes(2)
    expect(h.deps.client.install).not.toHaveBeenCalled()

    h.setDialog('none')
    h.setCounts(0, 0)
    h.setTopup(true)
    await h.c.requestInstall('toast')
    expect(h.deps.ui.openDialog).toHaveBeenCalledTimes(3)

    h.setDialog('none')
    h.setTopup(false)
    const p = h.c.requestInstall('toast')
    await vi.advanceTimersByTimeAsync(10)
    await p
    expect(h.deps.client.install).toHaveBeenCalledTimes(1)
  })

  it('never replaces an open “Nhập prompt”', async () => {
    const h = harness(ready())
    h.setDialog('import')
    h.c.openUpdateDialog()
    await h.c.requestInstall('pill')
    await h.c.requestInstall('toast')
    expect(h.deps.ui.openDialog).not.toHaveBeenCalled()
    expect(h.deps.client.install).not.toHaveBeenCalled()
    expect(h.texts()).toEqual([UPDATE_TOAST.importOpen, UPDATE_TOAST.importOpen, UPDATE_TOAST.importOpen])
  })
})

describe('Cập nhật khi xong', () => {
  it('waits for the queue, counts down 5 s, then installs', async () => {
    const h = harness(ready())
    h.c.start()
    expect(h.texts()).toEqual(['Đã tải xong SanoVids 0.5.1.'])
    h.toasts.length = 0
    h.setCounts(1, 2)
    h.c.setInstallWhenIdle(true)
    expect(h.c.installUi.getState().installWhenIdle).toBe(true)
    expect(h.texts()).toEqual([UPDATE_TOAST.waitSet(3)])
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 6000)
    expect(h.deps.client.install).not.toHaveBeenCalled()

    // a pending download still blocks
    h.setPending(1)
    h.setCounts(0, 0)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.texts()).not.toContain(UPDATE_TOAST.countdown)
    h.setPending(0)
    await vi.advanceTimersByTimeAsync(5000) // re-evaluated every 5 s
    expect(h.texts()).toContain(UPDATE_TOAST.countdown)
    expect(h.deps.client.install).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 10)
    expect(h.deps.client.install).toHaveBeenCalledTimes(1)
    expect(h.c.installUi.getState().installWhenIdle).toBe(false)
  })

  it('new jobs during the countdown cancel it and the wait goes on; "Huỷ" stops waiting', async () => {
    const h = harness(ready())
    h.c.start()
    h.c.setInstallWhenIdle(true) // nothing running: the countdown starts at once
    await vi.advanceTimersByTimeAsync(10)
    const countdown = h.toasts.find((t) => t.text === UPDATE_TOAST.countdown)
    expect(countdown).toBeTruthy()
    h.setCounts(1, 0)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.dismissed).toContain(countdown!.id)
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 10)
    expect(h.deps.client.install).not.toHaveBeenCalled()
    expect(h.c.installUi.getState().installWhenIdle).toBe(true)

    h.setCounts(0, 0)
    await vi.advanceTimersByTimeAsync(10)
    h.runToastAction(UPDATE_TOAST.countdown) // "Huỷ"
    expect(h.c.installUi.getState().installWhenIdle).toBe(false)
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 6000)
    expect(h.deps.client.install).not.toHaveBeenCalled()
  })

  it('never restarts over an open “Nhập prompt”: the wait goes on until it is closed', async () => {
    const h = harness(ready())
    h.c.start()
    h.toasts.length = 0
    h.setCounts(0, 1)
    h.c.setInstallWhenIdle(true)
    h.setDialog('import') // the user pastes a batch while the last video finishes
    h.setCounts(0, 0)
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 20_000)
    expect(h.texts()).not.toContain(UPDATE_TOAST.countdown)
    expect(h.deps.client.install).not.toHaveBeenCalled()
    expect(h.c.installUi.getState().installWhenIdle).toBe(true)

    // Opened during a countdown: the countdown is dropped at its end, nothing installs.
    h.setDialog('none')
    await vi.advanceTimersByTimeAsync(5000)
    const countdown = h.toasts.find((t) => t.text === UPDATE_TOAST.countdown)
    expect(countdown).toBeTruthy()
    h.setDialog('import')
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 10)
    expect(h.dismissed).toContain(countdown!.id)
    expect(h.deps.client.install).not.toHaveBeenCalled()
    expect(h.c.installUi.getState().installWhenIdle).toBe(true)

    // Closed: the next evaluation counts down again and installs.
    h.setDialog('none')
    await vi.advanceTimersByTimeAsync(5000 + COUNTDOWN_MS + 10)
    expect(h.deps.client.install).toHaveBeenCalledTimes(1)
  })

  it('installNow / "Vẫn cập nhật" refuse while “Nhập prompt” is open', async () => {
    const h = harness(ready())
    h.setDialog('import')
    await h.c.installNow()
    expect(h.order).toEqual([])
    expect(h.texts()).toEqual([UPDATE_TOAST.importOpen])

    h.setDialog('none')
    h.results.flush = false
    const done = h.c.installNow()
    await vi.advanceTimersByTimeAsync(10)
    await done
    h.setDialog('import')
    h.runToastAction(UPDATE_TOAST.saveFailed) // "Vẫn cập nhật"
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deps.client.install).not.toHaveBeenCalled()
    expect(h.hold()).toBe(false)
    expect(h.c.installUi.getState().busy).toBeNull()
    expect(h.texts().at(-1)).toBe(UPDATE_TOAST.importOpen)
  })

  it('says what it waits for when no video is running', () => {
    expect(UPDATE_TOAST.waitSet(3)).toBe('Sẽ cập nhật khi xong 3 video.')
    expect(UPDATE_TOAST.waitSet(0)).toBe('Sẽ cập nhật khi xong các việc đang dở.')
    const h = harness(ready())
    h.c.start()
    h.toasts.length = 0
    h.setPending(2)
    h.c.setInstallWhenIdle(true)
    expect(h.texts()).toEqual(['Sẽ cập nhật khi xong các việc đang dở.'])
  })

  it('is cleared when the update goes away', () => {
    const h = harness(ready())
    h.c.start()
    h.setCounts(0, 1)
    h.c.setInstallWhenIdle(true)
    h.setState({ kind: 'installer', current: '0.5.0', status: 'none', autoDownload: true })
    expect(h.c.installUi.getState().installWhenIdle).toBe(false)
  })
})
