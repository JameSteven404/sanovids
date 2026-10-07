// The page side of the development-mode lock (providers/devAccess) and what it does to the provider for new takes
// (providers/index): the initial access table, strict parsing, the effective provider in every state, the saved choice
// never rewritten, development mode never the fallback while locked, the canvasapp gateway silent until turned on, the
// credit store's 'off', Run / Nhập job / Bảng phát triển refused while locked, and the sync with main.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDevPanel, requestRun } from '../../actions'
import { openImportJobs, scanForImport } from '../../siteJobActions'
import { createRealCredits, creditInfoFrom, getCreditInfo } from '../../store/credits'
import { useUI } from '../../store/ui'
import {
  activeGateway,
  activeProviderId,
  CANVASAPP_OFF_REASON,
  canvasappEnabled,
  canvasappOff,
  DEV_LOCKED_REASON,
  effectiveProvider,
  providerBlockedReason,
  refreshProviderLimits,
  selectableProviders,
  useProviderPrefs,
} from '..'
import { WEB_UNAVAILABLE } from '../canvasapp/transport'
import {
  applyDevAccessState,
  bareState,
  initialDevAccess,
  isLoopbackHost,
  parseDevAccessResult,
  parseDevAccessState,
  startDevAccessSync,
  useDevAccess,
  type DevAccessEnv,
} from '../devAccess'

const env = (o: Partial<DevAccessEnv>): DevAccessEnv => ({ hasWindow: true, viteDev: false, perfBuild: false, electron: false, ...o })

afterEach(() => {
  applyDevAccessState(bareState('build'))
  useProviderPrefs.getState().setProvider('dev')
  vi.unstubAllGlobals()
  useUI.setState({ toasts: [] })
  useUI.getState().closeDialog()
})

describe('initial access (computed once at import)', () => {
  it('table: node / Electron / vite dev / perf / loopback / other hosts', () => {
    expect(initialDevAccess(env({ hasWindow: false }))).toBe('build')
    expect(initialDevAccess(env({ electron: true, desktopInitial: 'build' }))).toBe('build')
    expect(initialDevAccess(env({ electron: true, desktopInitial: 'unlocked' }))).toBe('unlocked')
    expect(initialDevAccess(env({ electron: true, desktopInitial: 'locked' }))).toBe('locked')
    // Electron with a missing / strange value → locked, whatever else says "open" (no renderer flag unlocks)
    for (const v of [undefined, '', 'open', 1, null]) expect(initialDevAccess(env({ electron: true, desktopInitial: v, viteDev: true, hostname: 'localhost' }))).toBe('locked')
    expect(initialDevAccess(env({ viteDev: true, hostname: 'localhost' }))).toBe('build')
    expect(initialDevAccess(env({ perfBuild: true, hostname: '127.0.0.1' }))).toBe('build')
    expect(initialDevAccess(env({ hostname: 'localhost' }))).toBe('build')
    expect(initialDevAccess(env({ hostname: '[::1]', simLocked: true }))).toBe('locked')
    expect(initialDevAccess(env({ viteDev: true, hostname: 'localhost', simLocked: true }))).toBe('locked')
    expect(initialDevAccess(env({ hostname: 'sanovids.example.com' }))).toBe('locked')
    expect(initialDevAccess(env({ hostname: 'sanovids.example.com', simLocked: false }))).toBe('locked')
    // the simulation flag can only lock: it never opens a locked host
    expect(initialDevAccess(env({ electron: true, desktopInitial: 'locked', simLocked: false }))).toBe('locked')
    expect(isLoopbackHost('localhost.evil.com')).toBe(false)
  })

  it('in tests (no window at import) development mode is open', () => {
    expect(useDevAccess.getState().state.access).toBe('build')
  })
})

describe('parsing what main says', () => {
  const good = { ...bareState('unlocked'), until: 5, method: 'code', deviceCode: '7KQ2-M9XD' }
  it('strict state', () => {
    expect(parseDevAccessState(good)).toMatchObject({ access: 'unlocked', until: 5, method: 'code' })
    expect(parseDevAccessState({ ...good, access: 'open' })).toBeNull()
    expect(parseDevAccessState({ ...good, keepDays: 3 })).toBeNull()
    expect(parseDevAccessState({ ...good, deviceCode: 'x' })).toBeNull()
    expect(parseDevAccessState({ ...good, totp: null })).toBeNull()
    expect(parseDevAccessState({ ...good, until: -1 })).toBeNull()
    expect(parseDevAccessState(null)).toBeNull()
    // fields of an unlock never survive a locked state
    expect(parseDevAccessState({ ...good, access: 'locked' })).toMatchObject({ until: null, method: null })
  })
  it('results', () => {
    expect(parseDevAccessResult({ ok: true, state: good }).ok).toBe(true)
    expect(parseDevAccessResult({ ok: true, state: { nope: 1 } })).toEqual({ ok: false, error: 'failed' })
    expect(parseDevAccessResult({ ok: false, error: 'other-device', codeDevice: 'AAAA-BBBB', thisDevice: 'bad', minutes: 3 })).toEqual({
      ok: false,
      error: 'other-device',
      codeDevice: 'AAAA-BBBB',
      minutes: 3,
    })
    expect(parseDevAccessResult('x')).toEqual({ ok: false, error: 'failed' })
  })
})

describe('effective provider', () => {
  it('table: access × saved × bridge', () => {
    for (const access of ['build', 'unlocked'] as const) {
      expect(effectiveProvider({ access, saved: 'dev', bridge: true })).toBe('dev')
      expect(effectiveProvider({ access, saved: 'canvasapp', bridge: true })).toBe('canvasapp')
      expect(effectiveProvider({ access, saved: 'canvasapp', bridge: false })).toBe('dev')
    }
    for (const saved of ['dev', 'canvasapp', 'mock'] as const) {
      for (const bridge of [true, false]) expect(effectiveProvider({ access: 'locked', saved, bridge })).toBe('canvasapp')
    }
  })

  it('locked without the desktop bridge: canvasapp, unavailable here; dev refused; the saved choice untouched', () => {
    expect(activeProviderId()).toBe('dev')
    applyDevAccessState(bareState('locked'))
    expect(useProviderPrefs.getState().provider).toBe('dev')
    expect(useProviderPrefs.getState().active).toBe('canvasapp')
    expect(activeProviderId()).toBe('canvasapp')
    expect(activeGateway().id).toBe('canvasapp')
    expect(activeGateway().simulated).toBe(false)
    expect(selectableProviders()).toEqual(['canvasapp'])
    expect(providerBlockedReason('dev')).toBe(DEV_LOCKED_REASON)
    expect(providerBlockedReason('canvasapp')).toBe(WEB_UNAVAILABLE)
    applyDevAccessState(bareState('build'))
    expect(useProviderPrefs.getState().active).toBe('dev')
    expect(selectableProviders()).toEqual(['dev', 'canvasapp'])
    expect(providerBlockedReason('dev')).toBeNull()
  })

  it('locked with the desktop bridge: the gateway is OFF until chosen — nothing read, Run explains; unlocking brings the old choice back', async () => {
    const request = vi.fn(async () => ({ ok: true, status: 200, contentType: 'application/json', json: {} }))
    vi.stubGlobal('window', { bdpDesktop: { canvasapp: { request, status: request, login: request, logout: request } } })
    applyDevAccessState(bareState('locked'))
    expect(activeProviderId()).toBe('canvasapp')
    expect(canvasappEnabled()).toBe(false)
    expect(canvasappOff()).toBe(true)
    expect(providerBlockedReason('canvasapp')).toBe(CANVASAPP_OFF_REASON)
    expect(await refreshProviderLimits('canvasapp', { force: true })).toBe('unavailable')
    expect(getCreditInfo()).toMatchObject({ kind: 'canvasapp', status: 'off', balance: null })
    // Run: a toast with "Mở Cài đặt", never the cost dialog
    requestRun(['s1'])
    expect(useUI.getState().dialog.kind).toBe('none')
    const t = useUI.getState().toasts.at(-1)
    expect(t?.text).toBe(CANVASAPP_OFF_REASON)
    expect(t?.action?.label).toBe('Mở Cài đặt')
    // Nhập job: refused too, and the scan never reaches canvasapp
    openImportJobs()
    expect(useUI.getState().dialog.kind).toBe('none')
    await expect(scanForImport()).rejects.toThrow(CANVASAPP_OFF_REASON)
    expect(request).not.toHaveBeenCalled()
    // Bảng phát triển: nothing at all
    openDevPanel('faults')
    expect(useUI.getState().dialog.kind).toBe('none')
    // turned on by the user (Cài đặt switch): allowed
    useProviderPrefs.getState().setProvider('canvasapp')
    expect(canvasappOff()).toBe(false)
    expect(providerBlockedReason('canvasapp')).toBeNull()
    // unlock: the saved choice (canvasapp) stays the provider; choose dev → dev
    applyDevAccessState(bareState('unlocked'))
    expect(activeProviderId()).toBe('canvasapp')
    useProviderPrefs.getState().setProvider('dev')
    expect(activeProviderId()).toBe('dev')
    // lock again: never dev, the saved 'dev' means "off" again
    applyDevAccessState(bareState('locked'))
    expect(activeProviderId()).toBe('canvasapp')
    expect(useProviderPrefs.getState().provider).toBe('dev')
    expect(canvasappOff()).toBe(true)
  })

  it('open development mode keeps today’s behaviour (Bảng phát triển opens)', () => {
    openDevPanel('log')
    expect(useUI.getState().dialog).toMatchObject({ kind: 'dev', tab: 'log' })
  })
})

describe('credits: off', () => {
  it('a blocked read answers "off" and never calls the gateway', async () => {
    const me = vi.fn()
    const available = vi.fn(async () => ({ ok: true }))
    const rc = createRealCredits({ api: () => ({ me, transport: { available } }) as never, blocked: () => 'tắt' })
    const st = await rc.refresh({ force: true })
    expect(st).toMatchObject({ status: 'off', balance: null, error: 'tắt' })
    expect(me).not.toHaveBeenCalled()
    expect(available).not.toHaveBeenCalled()
  })
  it('creditInfoFrom(off) → status off for canvasapp only', () => {
    const real = { balance: 12, status: 'ok' as const, updatedAt: 1, error: null, refreshing: false }
    expect(creditInfoFrom('canvasapp', 0, real, true)).toMatchObject({ status: 'off', balance: null })
    expect(creditInfoFrom('dev', 0, real, true)).toMatchObject({ status: 'ok', balance: 12 })
    expect(creditInfoFrom('canvasapp', 0, real)).toMatchObject({ status: 'ok', balance: 12 })
  })
})

describe('browser simulation (loopback only, never in Electron)', () => {
  it('"Xem như bản phát hành" locks; the RFC 6238 test code unlocks; SV1 codes have no key; back to build', async () => {
    const { simDevAccess } = await import('../dev/devAccess')
    const { createHmac } = await import('node:crypto')
    expect(((await simDevAccess.getState()) as { access: string }).access).toBe('build')
    simDevAccess.setSimLocked(true)
    expect(((await simDevAccess.getState()) as { access: string }).access).toBe('locked')
    expect(await simDevAccess.unlock('SV1-ABCD')).toEqual({ ok: false, error: 'no-keys' })
    const step = Math.floor(Date.now() / 30000)
    const hotp = (s: number) => {
      const msg = Buffer.alloc(8)
      msg.writeBigUInt64BE(BigInt(s))
      const h = createHmac('sha1', '12345678901234567890').update(msg).digest()
      const off = h[h.length - 1] & 15
      return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0')
    }
    const right = hotp(step)
    const wrong = right === '000000' ? '111111' : '000000'
    expect((await simDevAccess.unlock(wrong)) as { ok: boolean }).toMatchObject({ ok: false })
    const ok = (await simDevAccess.unlock(right)) as { ok: boolean; state: { access: string } }
    expect(ok.ok).toBe(true)
    expect(ok.state.access).toBe('unlocked')
    expect(((await simDevAccess.lock()) as { access: string }).access).toBe('locked')
    simDevAccess.setSimLocked(false)
    expect(((await simDevAccess.getState()) as { access: string }).access).toBe('build')
  })

  it('installDevAccessSim: only on loopback hosts, ignored inside Electron', async () => {
    const { installDevAccessSim } = await import('../dev/devAccess')
    const { devAccessBridge } = await import('../devAccess')
    expect(installDevAccessSim('sanovids.example.com')).toBe(false)
    vi.stubGlobal('window', { bdpDesktop: { canvasapp: {} } })
    installDevAccessSim('localhost')
    expect(devAccessBridge()).toBeNull() // Electron page without the desktop lock bridge: never the simulation
  })
})

describe('sync with main', () => {
  it('reads the state, follows pushes (with the reason), and a broken answer in Electron means locked', async () => {
    let push: (s: unknown) => void = () => undefined
    const unlocked = { ...bareState('unlocked'), until: 99, method: 'totp', deviceCode: 'AAAA-BBBB' }
    const devAccess = {
      initial: 'locked',
      getState: vi.fn(async () => unlocked),
      unlock: vi.fn(),
      lock: vi.fn(),
      setKeep: vi.fn(),
      totpBegin: vi.fn(),
      totpConfirm: vi.fn(),
      linkCancel: vi.fn(),
      totpRemove: vi.fn(),
      onState: (cb: (s: unknown) => void) => {
        push = cb
        return () => undefined
      },
    }
    vi.stubGlobal('window', { bdpDesktop: { devAccess } })
    const stop = startDevAccessSync()
    await vi.waitFor(() => expect(useDevAccess.getState().state.access).toBe('unlocked'))
    push({ ...bareState('locked'), reason: 'expired' })
    expect(useDevAccess.getState()).toMatchObject({ state: { access: 'locked' }, reason: 'expired' })
    push({ ...unlocked })
    expect(useDevAccess.getState().state.access).toBe('unlocked')
    push({ access: 'unlocked' }) // malformed → locked (fail closed in Electron)
    expect(useDevAccess.getState().state.access).toBe('locked')
    stop()
  })
})
