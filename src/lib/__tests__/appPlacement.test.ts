// lib/appPlacement: strict validation of the 'app:placement' payload ({ kind } only, never a path), which bridge answers
// (desktop / none / development-mode simulation), and a loader that asks once, follows the simulation live and never
// throws. Plus the simulated bridge of providers/dev/appPlacement.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createDevPlacementBridge, DEV_PLACEMENT_OPTIONS, devPlacement, simulateDevPlacement, useDevPlacement } from '../../providers/dev/appPlacement'
import {
  APP_PLACEMENT_KINDS,
  appPlacementSource,
  createAppPlacementLoader,
  isMacPlacementKind,
  MAC_PLACEMENT_KINDS,
  parseAppPlacement,
  placementToastsOnLaunch,
  type AppPlacementKind,
  type AppPlacementLoaderDeps,
  type AppPlacementSource,
  type DesktopPlacementBridge,
} from '../appPlacement'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  devPlacement.reset()
})

describe('parseAppPlacement', () => {
  it('accepts the Windows and the Mac kinds of the contract', () => {
    expect(APP_PLACEMENT_KINDS).toEqual(['installer', 'portable', 'temp-copy', 'dev', 'mac-applications', 'mac-translocated', 'mac-volume', 'mac-other'])
    for (const kind of APP_PLACEMENT_KINDS) expect(parseAppPlacement({ kind })).toEqual({ kind })
  })

  it('Mac kinds: exact names only, never a path; the updater kind "mac-manual" is not a placement', () => {
    for (const kind of ['mac-manual', 'mac', 'MAC-VOLUME', 'mac-applications ', 'applications', 'translocated', 'darwin']) {
      expect(parseAppPlacement({ kind }), kind).toEqual({ kind: 'unknown' })
    }
    expect(parseAppPlacement({ kind: 'mac-translocated', path: '/private/var/folders/x/T/AppTranslocation/1/d/SanoVids.app' })).toEqual({ kind: 'mac-translocated' })
  })

  it('anything else is unknown (never thrown on); extra keys such as a path are never kept', () => {
    for (const raw of [null, undefined, 'portable', 3, [], [{ kind: 'portable' }], {}, { kind: 'PORTABLE' }, { kind: 'temp' }, { kind: 1 }, { kind: null }, { type: 'portable' }]) {
      expect(parseAppPlacement(raw), JSON.stringify(raw)).toEqual({ kind: 'unknown' })
    }
    expect(parseAppPlacement({ kind: 'temp-copy', path: 'C:\\Users\\me\\AppData\\Local\\Temp\\x\\SanoVids.exe' })).toEqual({ kind: 'temp-copy' })
  })
})

describe('Mac placement helpers', () => {
  it('isMacPlacementKind: exactly the four Mac kinds', () => {
    expect(MAC_PLACEMENT_KINDS).toEqual(['mac-applications', 'mac-translocated', 'mac-volume', 'mac-other'])
    expect(APP_PLACEMENT_KINDS.filter(isMacPlacementKind)).toEqual(MAC_PLACEMENT_KINDS)
    for (const k of ['installer', 'portable', 'temp-copy', 'dev', 'unknown', 'mac-manual', null, undefined, 3]) expect(isMacPlacementKind(k), String(k)).toBe(false)
  })

  it('a toast at every launch only when running from the .dmg / Downloads (translocated) or an external drive', () => {
    expect(APP_PLACEMENT_KINDS.filter(placementToastsOnLaunch)).toEqual(['mac-translocated', 'mac-volume'])
    for (const k of ['unknown', null, undefined] as const) expect(placementToastsOnLaunch(k)).toBe(false)
  })
})

function deps(over: Partial<AppPlacementLoaderDeps> = {}): AppPlacementLoaderDeps & { emit: (raw: unknown) => void } {
  let listener: ((raw: unknown) => void) | null = null
  return {
    source: () => 'desktop',
    desktop: () => null,
    sim: () => ({ placement: async () => ({ kind: 'dev' }) }),
    watchSim: (fn) => {
      listener = fn
      return () => (listener = null)
    },
    emit: (raw) => listener?.(raw),
    ...over,
  }
}

describe('createAppPlacementLoader', () => {
  it('desktop: asks the bridge once, keeps the answer', async () => {
    const placement = vi.fn(async () => ({ kind: 'portable' }))
    const loader = createAppPlacementLoader(deps({ desktop: () => ({ placement }) }))
    expect(loader.store.getState().placement).toBeNull()
    const [a, b] = await Promise.all([loader.load(), loader.load()])
    expect(a).toEqual({ kind: 'portable' })
    expect(b).toBe(a)
    await loader.load()
    expect(placement).toHaveBeenCalledTimes(1)
    expect(loader.store.getState().placement).toEqual({ kind: 'portable' })
  })

  it('a desktop build without the bridge, a bad payload or a throwing bridge → unknown (a failure is retried later)', async () => {
    expect(await createAppPlacementLoader(deps({ source: () => 'none' })).load()).toEqual({ kind: 'unknown' })
    expect(await createAppPlacementLoader(deps({ desktop: () => ({ placement: async () => ({ kind: 'cloud' }) }) })).load()).toEqual({ kind: 'unknown' })
    let calls = 0
    const flaky: DesktopPlacementBridge = {
      placement: async () => {
        calls++
        if (calls === 1) throw new Error('ipc gone')
        return { kind: 'installer' }
      },
    }
    const loader = createAppPlacementLoader(deps({ desktop: () => flaky }))
    expect(await loader.load()).toEqual({ kind: 'unknown' })
    expect(await loader.load()).toEqual({ kind: 'installer' })
  })

  it('simulation: follows the development-mode control live', async () => {
    const store = create<{ kind: AppPlacementKind }>()(() => ({ kind: 'dev' }))
    const d = deps({ source: (): AppPlacementSource => 'sim', sim: () => createDevPlacementBridge(store, 0) })
    const loader = createAppPlacementLoader(d)
    expect(await loader.load()).toEqual({ kind: 'dev' })
    d.emit({ kind: 'temp-copy' })
    expect(loader.store.getState().placement).toEqual({ kind: 'temp-copy' })
    d.emit({ kind: 'nope' })
    expect(loader.store.getState().placement).toEqual({ kind: 'unknown' })
  })
})

describe('appPlacementSource', () => {
  it('desktop bridge → desktop; Electron without it → none; a browser → sim', () => {
    vi.stubGlobal('window', { bdpDesktop: { version: '0.6.0', app: { signature: async () => ({}), placement: async () => ({ kind: 'installer' }) } } })
    expect(appPlacementSource()).toBe('desktop')
    vi.stubGlobal('window', { bdpDesktop: { version: '0.5.0', app: { signature: async () => ({}) } } })
    expect(appPlacementSource()).toBe('none')
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/140' })
    expect(appPlacementSource()).toBe('sim')
  })
})

describe('providers/dev/appPlacement', () => {
  it('simulates each kind, ignores anything else; the bridge answers a fresh copy after its delay', async () => {
    vi.useFakeTimers()
    // every simulated option is a contract kind, and every Windows kind can be simulated (the Mac ones come with the
    // Mac placement texts)
    const ids = DEV_PLACEMENT_OPTIONS.map((o) => o.id)
    expect(APP_PLACEMENT_KINDS).toEqual(expect.arrayContaining(ids))
    expect(ids).toEqual(expect.arrayContaining(APP_PLACEMENT_KINDS.filter((k) => !isMacPlacementKind(k))))
    expect(useDevPlacement.getState().kind).toBe('dev')
    devPlacement.simulate('portable')
    expect(useDevPlacement.getState()).toEqual({ kind: 'portable' })
    devPlacement.simulate('somewhere' as AppPlacementKind)
    expect(useDevPlacement.getState().kind).toBe('portable')
    const store = create<{ kind: AppPlacementKind }>()(() => ({ kind: 'installer' }))
    const bridge = createDevPlacementBridge(store, 100)
    const p = bridge.placement()
    simulateDevPlacement(store, 'temp-copy')
    await vi.advanceTimersByTimeAsync(100)
    expect(await p).toEqual({ kind: 'temp-copy' })
  })
})
