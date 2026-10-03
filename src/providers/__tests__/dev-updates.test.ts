// Development mode's simulated updater (providers/dev/updates): the same rules as the main process (no check for the
// 'dev' kind, download / install only for the installer build in the right state), a download that reaches 'ready',
// and an install that "restarts" into the new version with the 'updated' notice. No network, ever.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import {
  createDevUpdatesBridge,
  DEV_CHECK_MS,
  DEV_INSTALL_MS,
  DEV_UPDATE_SIZE,
  DEV_UPDATES_DRAFT_DEFAULT,
  devUpdatesInitialState,
  nextPatchVersion,
  reduceDevUpdateState,
  type DevUpdatesStore,
} from '../dev/updates'
import type { UpdateState } from '../../lib/updateTypes'
import pkg from '../../../package.json'

const CUR = DEV_UPDATES_DRAFT_DEFAULT.current
const NEW = DEV_UPDATES_DRAFT_DEFAULT.version

function setup() {
  const store = create<DevUpdatesStore>()(() => ({ state: devUpdatesInitialState(), nextCheck: 'available', draft: { ...DEV_UPDATES_DRAFT_DEFAULT } }))
  const notify = vi.fn()
  const sim = createDevUpdatesBridge({ store, notify })
  const pushes: UpdateState[] = []
  const off = sim.onState((s) => pushes.push(s))
  return { store, sim, notify, pushes, off, state: () => store.getState().state }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('simulated updater', () => {
  it('starts as a dev build that does not update', async () => {
    const { sim } = setup()
    expect(await sim.getState()).toEqual({ kind: 'dev', status: 'unsupported', current: CUR, autoDownload: true })
    expect(await sim.check()).toEqual({ ok: false, code: 'unsupported', message: 'Bản này không tự cập nhật.' })
    expect(await sim.download()).toMatchObject({ ok: false, code: 'unsupported' })
    expect(await sim.install()).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('installer: check finds the draft version, downloads in the background (auto on), reaches ready', async () => {
    const { sim, state, pushes } = setup()
    sim.simulate({ kind: 'installer' })
    expect(state().status).toBe('idle')
    const p = sim.check()
    expect(state().status).toBe('checking')
    expect(await sim.check()).toMatchObject({ ok: false, code: 'busy' }) // one at a time
    await vi.advanceTimersByTimeAsync(DEV_CHECK_MS)
    expect(await p).toEqual({ ok: true })
    expect(state()).toMatchObject({ status: 'downloading', version: NEW, size: DEV_UPDATE_SIZE, notes: DEV_UPDATES_DRAFT_DEFAULT.notes })
    expect(state().lastCheck).toEqual(expect.any(Number))
    await vi.advanceTimersByTimeAsync(2500)
    expect(state().status).toBe('downloading')
    expect(state().percent).toBe(50)
    expect(state().transferred).toBe(Math.round(DEV_UPDATE_SIZE / 2))
    await vi.advanceTimersByTimeAsync(2500)
    expect(state()).toMatchObject({ status: 'ready', version: NEW, percent: 100 })
    expect(pushes.map((s) => s.status)).toContain('available')
    // a new check while ready stays ready (same version)
    const again = sim.check()
    await vi.advanceTimersByTimeAsync(DEV_CHECK_MS)
    expect(await again).toEqual({ ok: true })
    expect(state().status).toBe('ready')
  })

  it('auto-download off: stays available until download(); setPrefs(true) starts it', async () => {
    const { sim, state } = setup()
    sim.simulate({ kind: 'installer' })
    expect(await sim.setPrefs({ autoDownload: 'yes' } as never)).toMatchObject({ ok: false, code: 'bad-request' })
    expect(await sim.setPrefs({ autoDownload: false })).toEqual({ ok: true })
    const p = sim.check()
    await vi.advanceTimersByTimeAsync(DEV_CHECK_MS)
    await p
    await vi.advanceTimersByTimeAsync(3000)
    expect(state().status).toBe('available')
    expect(await sim.install()).toMatchObject({ ok: false, code: 'not-ready' })
    await sim.setPrefs({ autoDownload: true })
    expect(state().status).toBe('downloading')
  })

  it('portable: finds the update but never downloads or installs', async () => {
    const { sim, state } = setup()
    sim.simulate({ kind: 'portable' })
    const p = sim.check()
    await vi.advanceTimersByTimeAsync(DEV_CHECK_MS)
    await p
    await vi.advanceTimersByTimeAsync(3000)
    expect(state()).toMatchObject({ status: 'available', version: NEW })
    expect(await sim.download()).toEqual({ ok: false, code: 'unsupported', message: 'Chỉ bản cài mới tự tải được bản cập nhật.' })
    expect(await sim.install()).toEqual({ ok: false, code: 'unsupported', message: 'Bản này không tự cài được.' })
  })

  it('check errors: offline / no release', async () => {
    const { sim, state } = setup()
    sim.simulate({ kind: 'installer' })
    sim.setNextCheck('offline')
    const p = sim.check()
    await vi.advanceTimersByTimeAsync(DEV_CHECK_MS)
    expect(await p).toEqual({ ok: false, code: 'offline', message: 'Không kết nối được máy chủ cập nhật.' })
    expect(state()).toMatchObject({ status: 'error', error: { code: 'offline' } })
    sim.setNextCheck('no-release')
    const q = sim.check()
    await vi.advanceTimersByTimeAsync(DEV_CHECK_MS)
    expect(await q).toMatchObject({ ok: false, code: 'no-release' })
    sim.setNextCheck('none')
    const r = sim.check()
    await vi.advanceTimersByTimeAsync(DEV_CHECK_MS)
    expect(await r).toEqual({ ok: true })
    expect(state().status).toBe('none')
    expect(state().error).toBeUndefined()
  })

  it('install: says what would happen, then "restarts" into the new version with the updated notice', async () => {
    const { sim, state, notify } = setup()
    sim.markReady()
    expect(state()).toMatchObject({ kind: 'installer', status: 'ready', version: NEW })
    expect(await sim.install()).toEqual({ ok: true })
    expect(notify).toHaveBeenCalledWith(`Giả lập: SanoVids sẽ khởi động lại và cài bản ${NEW}.`)
    await vi.advanceTimersByTimeAsync(DEV_INSTALL_MS)
    expect(state()).toMatchObject({ status: 'none', current: NEW, notice: { kind: 'updated', from: CUR, version: NEW } })
    expect(state().version).toBeUndefined()
    await sim.openReleasePage()
    expect(notify).toHaveBeenLastCalledWith('Giả lập: sẽ mở trang tải về trên GitHub.')
  })

  it('one-click states, draft and reset', async () => {
    const { sim, state, store, off, pushes } = setup()
    sim.failNetwork()
    expect(state()).toMatchObject({ kind: 'installer', status: 'error', error: { code: 'offline' } })
    sim.setDraft({ version: '0.6.0', notes: '- mới', current: '0.5.5' })
    expect(state().current).toBe('0.5.5')
    sim.setDraft({ current: 'không phải số' })
    expect(state().current).toBe('0.5.5') // invalid versions stay in the draft only
    sim.runDownload()
    expect(state()).toMatchObject({ status: 'downloading', version: '0.6.0', percent: 0 })
    sim.markNone()
    expect(state()).toMatchObject({ status: 'none' })
    await vi.advanceTimersByTimeAsync(10_000) // the download timer was stopped
    expect(state().status).toBe('none')
    sim.simulate({ kind: 'dev' })
    expect(state().status).toBe('unsupported')
    sim.reset()
    expect(store.getState()).toEqual({ state: devUpdatesInitialState(), nextCheck: 'available', draft: DEV_UPDATES_DRAFT_DEFAULT })
    off()
    const n = pushes.length
    sim.announce()
    expect(pushes).toHaveLength(n)
  })

  it('starts from the real app version and offers the next patch', () => {
    expect(CUR).toBe(pkg.version)
    expect(NEW).toBe(nextPatchVersion(pkg.version))
    expect(DEV_UPDATES_DRAFT_DEFAULT.notes).toContain('<b>thẻ HTML bị bỏ, chỉ còn chữ</b>')
  })

  it('a failed re-check keeps a known update announced (checking never hides it)', async () => {
    const { sim, state, pushes } = setup()
    sim.simulate({ kind: 'portable' })
    const p = sim.check()
    await vi.advanceTimersByTimeAsync(DEV_CHECK_MS)
    await p
    expect(state()).toMatchObject({ status: 'available', version: NEW })
    sim.setNextCheck('offline')
    const n = pushes.length
    const q = sim.check()
    expect(state().status).toBe('available') // no 'checking' flicker
    await vi.advanceTimersByTimeAsync(DEV_CHECK_MS)
    expect(await q).toMatchObject({ ok: false, code: 'offline' })
    expect(state()).toMatchObject({ status: 'available', version: NEW })
    expect(state().error).toBeUndefined()
    expect(pushes.slice(n).map((s) => s.status)).not.toContain('error')
  })

  it('reset keeps the auto-download pref (Settings only pushes it when it changes)', async () => {
    const { sim, state } = setup()
    await sim.setPrefs({ autoDownload: false })
    sim.reset()
    expect(state()).toEqual({ ...devUpdatesInitialState(), autoDownload: false })
    sim.announce() // the dev build becomes the installer: auto-download off ⇒ stays available
    expect(state()).toMatchObject({ kind: 'installer', status: 'available' })
  })

  it('another kind of build is a fresh launch', async () => {
    const { sim, state } = setup()
    sim.runDownload()
    await vi.advanceTimersByTimeAsync(1000)
    expect(state().status).toBe('downloading')
    sim.simulate({ kind: 'portable' })
    expect(state()).toEqual({ kind: 'portable', current: CUR, status: 'idle', autoDownload: true })
    await vi.advanceTimersByTimeAsync(10_000) // the download timer was stopped
    expect(state().status).toBe('idle')
    sim.failNetwork()
    sim.simulate({ kind: 'installer' })
    expect(state()).toEqual({ kind: 'installer', current: CUR, status: 'idle', autoDownload: true })
    // explicit fields of the patch still apply; the same kind keeps the rest
    sim.simulate({ kind: 'portable', status: 'available', version: '9.9.9' })
    expect(state()).toMatchObject({ kind: 'portable', status: 'available', version: '9.9.9' })
    sim.simulate({ lastCheck: 5 })
    expect(state()).toMatchObject({ kind: 'portable', status: 'available', version: '9.9.9', lastCheck: 5 })
    sim.simulate({ kind: 'dev' })
    expect(state()).toEqual({ kind: 'dev', current: CUR, status: 'unsupported', autoDownload: true })
  })

  it('reducer and helpers', () => {
    const s: UpdateState = { kind: 'installer', current: '0.5.0', status: 'ready', version: '0.5.1', autoDownload: true }
    // same version while ready: nothing changes but the check time
    expect(reduceDevUpdateState(s, { type: 'available', info: { version: '0.5.1', notes: '' } }, 5)).toEqual({ ...s, lastCheck: 5 })
    // a newer one replaces it
    expect(reduceDevUpdateState(s, { type: 'available', info: { version: '0.5.2', notes: 'n' } }, 5)).toMatchObject({ status: 'available', version: '0.5.2' })
    expect(reduceDevUpdateState(s, { type: 'check-error', error: { code: 'offline', message: 'x' } }, 6)).toEqual({ ...s, lastCheck: 6 })
    expect(reduceDevUpdateState({ ...s, status: 'available' }, { type: 'check-error', error: { code: 'offline', message: 'x' } }, 6).status).toBe('available')
    expect(reduceDevUpdateState(s, { type: 'checking' }, 1)).toBe(s)
    const avail: UpdateState = { ...s, status: 'available' }
    expect(reduceDevUpdateState(avail, { type: 'checking' }, 1)).toBe(avail)
    expect(reduceDevUpdateState(s, { type: 'install-error', error: { code: 'install-failed', message: 'x' } }, 1)).toMatchObject({ status: 'ready', error: { code: 'install-failed' } })
    expect(nextPatchVersion('0.5.9')).toBe('0.5.10')
    expect(nextPatchVersion('1.2.3-beta.1')).toBe('1.2.4')
  })
})
