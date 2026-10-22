// What follows development mode LOCKING (devAccessActions.onAccessChange, via initDevAccess) for the open dialog:
// Bảng phát triển closes; "Nạp credit" / "Lịch sử credit" and "Nhập job" close when they were on the simulated gateway
// (otherwise they would silently follow the real canvasapp gateway — turned off, or real money); a sheet already on the
// real gateway and other dialogs stay. Regression for the review of TRACK DV (an unlock expiring with "Nạp credit" open).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { closesOnLock } from '../components/dev/devUnlockModel'
import { initDevAccess } from '../devAccessActions'
import { activeGateway, useProviderPrefs } from '../providers'
import { applyDevAccessState, bareState, whenDevAccessKnown } from '../providers/devAccess'
import { useUI, type DialogState } from '../store/ui'

const request = vi.fn(async () => ({}))
const desktopBridge = () => vi.stubGlobal('window', { bdpDesktop: { canvasapp: { request, status: request, login: request, logout: request } } })

beforeAll(async () => {
  initDevAccess()
  await whenDevAccessKnown()
  await Promise.resolve() // initDevAccess subscribes after the first answer
})

afterEach(() => {
  applyDevAccessState(bareState('build'))
  useProviderPrefs.getState().setProvider('dev')
  vi.unstubAllGlobals()
  useUI.setState({ toasts: [] })
  useUI.getState().closeDialog()
})

/** Unlocked with `saved` chosen, `dialog` open, then the lock flips (time ran out). → the dialog afterwards. */
function lockWith(dialog: DialogState, saved: 'dev' | 'canvasapp'): DialogState['kind'] {
  useProviderPrefs.getState().setProvider(saved)
  applyDevAccessState({ ...bareState('unlocked'), method: 'code', until: Date.now() + 60_000 })
  useUI.getState().openDialog(dialog)
  applyDevAccessState(bareState('locked'), 'expired')
  return useUI.getState().dialog.kind
}

describe('closesOnLock (pure)', () => {
  it('dev always; topup / importJobs only when they were on the simulation; everything else stays', () => {
    expect(closesOnLock({ kind: 'dev' }, false)).toBe(true)
    expect(closesOnLock({ kind: 'topup' }, true)).toBe(true)
    expect(closesOnLock({ kind: 'topup' }, false)).toBe(false)
    expect(closesOnLock({ kind: 'importJobs' }, true)).toBe(true)
    expect(closesOnLock({ kind: 'importJobs' }, false)).toBe(false)
    expect(closesOnLock({ kind: 'importJobs', provider: 'dev' }, false)).toBe(true)
    expect(closesOnLock({ kind: 'importJobs', provider: 'canvasapp' }, true)).toBe(false)
    for (const kind of ['settings', 'none', 'take', 'runConfirm', 'update']) expect(closesOnLock({ kind }, true)).toBe(false)
  })
})

describe('when development mode locks', () => {
  it('"Nạp credit" / "Lịch sử credit" on the simulated gateway close (they would follow the real canvasapp gateway)', () => {
    desktopBridge()
    useProviderPrefs.getState().setProvider('dev')
    expect(lockWith({ kind: 'topup', tab: 'topup' }, 'dev')).toBe('none')
    // locked + saved 'dev': the gateway is the REAL one (off) — the sheet must not be showing it
    expect(activeGateway().simulated).toBe(false)
    expect(lockWith({ kind: 'topup', tab: 'history' }, 'dev')).toBe('none')
    // the lock toast still says why
    expect(useUI.getState().toasts.at(-1)?.text).toContain('tự khoá')
    // no request went to canvasapp
    expect(request).not.toHaveBeenCalled()
  })

  it('"Nhập job" closes when it read the simulation (default gateway or provider "dev"), stays on an explicit canvasapp', () => {
    desktopBridge()
    expect(lockWith({ kind: 'importJobs' }, 'dev')).toBe('none')
    expect(lockWith({ kind: 'importJobs', provider: 'dev', back: { kind: 'dev', tab: 'jobs' } }, 'dev')).toBe('none')
    // closing never reopens its `back` (Bảng phát triển)
    expect(useUI.getState().dialog.kind).toBe('none')
    expect(lockWith({ kind: 'importJobs', provider: 'canvasapp', back: { kind: 'settings' } }, 'canvasapp')).toBe('importJobs')
  })

  it('a sheet already on the real gateway (canvasapp chosen, desktop bridge) stays; Bảng phát triển always closes', () => {
    desktopBridge()
    expect(lockWith({ kind: 'topup', tab: 'topup' }, 'canvasapp')).toBe('topup')
    expect(lockWith({ kind: 'dev' }, 'canvasapp')).toBe('none')
    expect(lockWith({ kind: 'settings', section: 'gateway' }, 'dev')).toBe('settings')
  })

  it('without the desktop bridge a saved "canvasapp" still meant the simulation: the sheet closes', () => {
    expect(lockWith({ kind: 'topup', tab: 'topup' }, 'canvasapp')).toBe('none')
  })
})
