// lib/updates: which bridge answers (desktop / development-mode simulation / none), the device pref is pushed before
// the first getState and on every change, pushed states are validated, results never throw.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { UpdatePrefsState } from '../updatePrefs'
import { createUpdatesClient, parseUpdateResult, updatesBridge, updatesSource } from '../updates'
import type { DesktopUpdatesBridge, UpdateState } from '../updateTypes'

const flushAsync = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function fakeBridge(initial: UpdateState) {
  const calls: string[] = []
  let state = initial
  const listeners = new Set<(s: UpdateState) => void>()
  const bridge: DesktopUpdatesBridge = {
    getState: async () => {
      calls.push('getState')
      return state
    },
    check: async () => {
      calls.push('check')
      return { ok: true }
    },
    download: async () => {
      calls.push('download')
      return { ok: false, code: 'not-ready', message: 'Chưa có bản cập nhật để tải.' }
    },
    install: async () => {
      calls.push('install')
      throw new Error('ipc broke')
    },
    setPrefs: async (p) => {
      calls.push(`setPrefs:${p.autoDownload}`)
      state = { ...state, autoDownload: p.autoDownload }
      return { ok: true }
    },
    openReleasePage: async () => {
      calls.push('openReleasePage')
      return { weird: true } as never
    },
    onState: (cb) => {
      calls.push('onState')
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  return {
    bridge,
    calls,
    listeners,
    push: (s: unknown) => {
      for (const l of listeners) l(s as UpdateState)
    },
  }
}

const prefsStore = (autoDownload = true) =>
  create<UpdatePrefsState>()((set) => ({ autoDownload, set: (p) => typeof p.autoDownload === 'boolean' && set({ autoDownload: p.autoDownload }) }))

const ready: UpdateState = { kind: 'installer', current: '0.5.0', status: 'ready', version: '0.5.1', autoDownload: true }

describe('createUpdatesClient', () => {
  it('connect: onState, then the pref, then getState; pushes update the store; a pref change is pushed', async () => {
    const f = fakeBridge(ready)
    const prefs = prefsStore(false)
    const client = createUpdatesClient({ bridge: () => f.bridge, source: () => 'desktop', prefs })
    expect(client.store.getState().state).toMatchObject({ kind: 'dev', status: 'unsupported', autoDownload: false })
    const stop = client.connect()
    await flushAsync()
    expect(f.calls.slice(0, 3)).toEqual(['onState', 'setPrefs:false', 'getState'])
    expect(client.store.getState().state).toEqual({ ...ready, autoDownload: false })
    expect(client.store.getState().source).toBe('desktop')

    // pushes are validated: garbage keeps what is shown
    f.push({ ...ready, status: 'downloading', percent: 500, notes: '<b>x</b>' })
    expect(client.store.getState().state).toMatchObject({ status: 'downloading', percent: 100, notes: '<b>x</b>' })
    const before = client.store.getState().state
    f.push('garbage')
    f.push({ ...ready, kind: 'store' })
    expect(client.store.getState().state).toBe(before)
    // an equal state does not notify
    const listener = vi.fn()
    const off = client.store.subscribe(listener)
    f.push({ ...before })
    expect(listener).not.toHaveBeenCalled()
    off()

    prefs.getState().set({ autoDownload: true })
    await flushAsync()
    expect(f.calls).toContain('setPrefs:true')

    // ref-counted: a second connect does not subscribe twice; the last stop unsubscribes everything
    const stop2 = client.connect()
    expect(f.calls.filter((c) => c === 'onState')).toHaveLength(1)
    stop()
    expect(f.listeners.size).toBe(1)
    stop2()
    stop2() // idempotent
    expect(f.listeners.size).toBe(0)
    prefs.getState().set({ autoDownload: false })
    await flushAsync()
    expect(f.calls.filter((c) => c === 'setPrefs:false')).toHaveLength(1) // not pushed after disconnect
  })

  it('results are validated and never throw; no bridge → unsupported', async () => {
    const f = fakeBridge(ready)
    const client = createUpdatesClient({ bridge: () => f.bridge, source: () => 'desktop', prefs: prefsStore() })
    expect(await client.check()).toEqual({ ok: true })
    expect(await client.download()).toEqual({ ok: false, code: 'not-ready', message: 'Chưa có bản cập nhật để tải.' })
    expect(await client.install()).toEqual({ ok: false, code: 'failed', message: 'Trình cập nhật gặp lỗi.' })
    expect(await client.openReleasePage()).toEqual({ ok: false, code: 'failed', message: 'Trình cập nhật gặp lỗi.' })
    await client.refresh()
    expect(client.store.getState().state.status).toBe('ready')

    const none = createUpdatesClient({ bridge: () => null, source: () => 'none', prefs: prefsStore() })
    expect(await none.check()).toEqual({ ok: false, code: 'unsupported', message: 'Bản này không tự cập nhật.' })
    const stop = none.connect()
    stop()
    expect(none.store.getState().state.status).toBe('unsupported')
  })

  it('parseUpdateResult', () => {
    expect(parseUpdateResult({ ok: true, extra: 1 })).toEqual({ ok: true })
    expect(parseUpdateResult({ ok: false, code: 'busy', message: 'm' })).toEqual({ ok: false, code: 'busy', message: 'm' })
    expect(parseUpdateResult({ ok: false, code: 'hacked', message: 'm' }).ok).toBe(false)
    expect(parseUpdateResult({ ok: false, code: 'hacked', message: 'm' })).toMatchObject({ code: 'failed' })
    expect(parseUpdateResult(null)).toMatchObject({ code: 'failed' })
    expect(parseUpdateResult({ ok: false, code: 'offline', message: 'x'.repeat(999) })).toMatchObject({ message: 'x'.repeat(300) })
  })
})

describe('updatesSource / updatesBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('desktop: every method of window.bdpDesktop.updates is a function', () => {
    const f = fakeBridge(ready)
    vi.stubGlobal('window', { bdpDesktop: { version: '0.5.0', updates: f.bridge } })
    expect(updatesSource()).toBe('desktop')
    expect(updatesBridge()).toBe(f.bridge)
  })

  it('none: a desktop build without (a complete) updates bridge', () => {
    vi.stubGlobal('window', { bdpDesktop: { version: '0.4.2' } })
    expect(updatesSource()).toBe('none')
    expect(updatesBridge()).toBeNull()
    const f = fakeBridge(ready)
    vi.stubGlobal('window', { bdpDesktop: { version: '0.5.0', updates: { ...f.bridge, install: 'nope' } } })
    expect(updatesSource()).toBe('none')
  })

  it('sim: a browser (development mode simulation)', () => {
    vi.stubGlobal('window', {})
    expect(updatesSource()).toBe('sim')
    const b = updatesBridge()
    expect(b && typeof b.getState).toBe('function')
  })
})
