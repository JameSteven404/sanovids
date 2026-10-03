// lib/appSignature: strict validation of the self-check payload, which bridge answers (desktop / none / development-mode
// simulation), and a loader that asks once, follows the simulation live and never throws.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import {
  appSignatureSource,
  createAppSignatureLoader,
  parseAppSignature,
  SIGNER_MAX,
  type AppSignature,
  type AppSignatureLoaderDeps,
  type AppSignatureSource,
  type DesktopAppBridge,
} from '../appSignature'

const PIN = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
const AUTHOR = 'Nguyễn Giang Minh (Jame Steven)'
const UNKNOWN = { status: 'unknown', packaged: false }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseAppSignature', () => {
  it('accepts every valid payload of the contract', () => {
    expect(parseAppSignature({ status: 'signed', packaged: true, signer: AUTHOR, thumbprint: PIN })).toEqual({ status: 'signed', packaged: true, signer: AUTHOR, thumbprint: PIN })
    expect(parseAppSignature({ status: 'other-signer', packaged: true, signer: 'X', thumbprint: '0123456789ABCDEF0123456789ABCDEF01234567' })).toMatchObject({ status: 'other-signer' })
    expect(parseAppSignature({ status: 'unsigned', packaged: false })).toEqual({ status: 'unsigned', packaged: false })
    expect(parseAppSignature({ status: 'unsigned', packaged: true })).toEqual({ status: 'unsigned', packaged: true })
    expect(parseAppSignature({ status: 'tampered', packaged: true })).toEqual({ status: 'tampered', packaged: true })
    expect(parseAppSignature({ status: 'unknown', packaged: true })).toEqual({ status: 'unknown', packaged: true })
    expect(parseAppSignature({ status: 'signed', packaged: true })).toEqual({ status: 'signed', packaged: true })
  })

  it('rejects bad shapes', () => {
    for (const raw of [
      null,
      undefined,
      'signed',
      42,
      [],
      [{ status: 'signed', packaged: true }],
      {},
      { status: 'signed' },
      { status: 'SIGNED', packaged: true },
      { status: 'trusted', packaged: true },
      { status: 'signed', packaged: 'true' },
      { status: 'signed', packaged: 1 },
      { status: 'signed', packaged: true, signer: 42 },
      { status: 'signed', packaged: true, signer: { name: AUTHOR } },
      { status: 'signed', packaged: true, signer: 'x'.repeat(SIGNER_MAX + 1) },
      { status: 'signed', packaged: true, thumbprint: PIN.toLowerCase() },
      { status: 'signed', packaged: true, thumbprint: PIN.slice(1) },
      { status: 'signed', packaged: true, thumbprint: `${PIN} ` },
      { status: 'other-signer', packaged: true, thumbprint: 12345 },
    ]) {
      expect(parseAppSignature(raw)).toEqual(UNKNOWN)
    }
  })

  it('strips control characters from the signer, keeps at most 200 chars, drops an empty one', () => {
    expect(parseAppSignature({ status: 'signed', packaged: true, signer: 'Ngu\u0000yễn\u001b[31m\u007f\u0085 Minh' }).signer).toBe('Nguyễn[31m Minh')
    expect(parseAppSignature({ status: 'signed', packaged: true, signer: 'x'.repeat(SIGNER_MAX) }).signer).toHaveLength(SIGNER_MAX)
    // 200 visible chars + control characters still fit once stripped
    expect(parseAppSignature({ status: 'signed', packaged: true, signer: `${'x'.repeat(SIGNER_MAX)}\u0007\u0007` }).signer).toHaveLength(SIGNER_MAX)
    expect(parseAppSignature({ status: 'signed', packaged: true, signer: '\u0001\u0002' })).toEqual({ status: 'signed', packaged: true })
    expect(parseAppSignature({ status: 'signed', packaged: true, signer: null, thumbprint: null })).toEqual({ status: 'signed', packaged: true })
  })

  it('signer / thumbprint only with signed / other-signer; extra keys dropped', () => {
    expect(parseAppSignature({ status: 'tampered', packaged: true, signer: AUTHOR, thumbprint: PIN })).toEqual({ status: 'tampered', packaged: true })
    expect(parseAppSignature({ status: 'unsigned', packaged: true, signer: 42 })).toEqual({ status: 'unsigned', packaged: true })
    expect(parseAppSignature({ status: 'signed', packaged: true, thumbprint: PIN, evil: '<b>' })).toEqual({ status: 'signed', packaged: true, thumbprint: PIN })
  })
})

describe('appSignatureSource', () => {
  it('desktop when window.bdpDesktop.app.signature is a function', () => {
    vi.stubGlobal('window', { bdpDesktop: { version: '0.5.0', app: { signature: async () => ({}) } } })
    expect(appSignatureSource()).toBe('desktop')
  })

  it('none in a desktop build without the bridge (or with a broken one)', () => {
    vi.stubGlobal('window', { bdpDesktop: { version: '0.4.2' } })
    expect(appSignatureSource()).toBe('none')
    vi.stubGlobal('window', { bdpDesktop: { version: '0.5.0', app: { signature: 'nope' } } })
    expect(appSignatureSource()).toBe('none')
    vi.stubGlobal('window', { bdpDesktop: { version: '0.5.0', app: null } })
    expect(appSignatureSource()).toBe('none')
  })

  it('sim in a browser', () => {
    vi.stubGlobal('window', {})
    expect(appSignatureSource()).toBe('sim')
  })
})

const flushAsync = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function setup(over: Partial<AppSignatureLoaderDeps> & { src?: AppSignatureSource } = {}) {
  const desktopCalls = vi.fn(async (): Promise<AppSignature> => ({ status: 'signed', packaged: true, signer: AUTHOR, thumbprint: PIN }))
  const simStore = create<AppSignature>()(() => ({ status: 'unsigned', packaged: false }))
  const simCalls = vi.fn(async (): Promise<AppSignature> => ({ ...simStore.getState() }))
  const desktop: DesktopAppBridge = { signature: desktopCalls }
  const sim: DesktopAppBridge = { signature: simCalls }
  const watchSim = vi.fn((l: (raw: unknown) => void) => simStore.subscribe((s) => l(s)))
  const loader = createAppSignatureLoader({
    source: () => over.src ?? 'desktop',
    desktop: () => desktop,
    sim: () => sim,
    watchSim,
    ...over,
  })
  return { loader, desktopCalls, simCalls, simStore, watchSim, sig: () => loader.store.getState().sig }
}

describe('createAppSignatureLoader', () => {
  it('starts at null, then shows the validated desktop answer', async () => {
    const t = setup()
    expect(t.sig()).toBeNull()
    expect(await t.loader.load()).toEqual({ status: 'signed', packaged: true, signer: AUTHOR, thumbprint: PIN })
    expect(t.sig()).toEqual({ status: 'signed', packaged: true, signer: AUTHOR, thumbprint: PIN })
    expect(t.watchSim).not.toHaveBeenCalled()
  })

  it('is idempotent: one call in flight, none after success', async () => {
    const t = setup()
    const a = t.loader.load()
    const b = t.loader.load()
    expect(a).toBe(b)
    await a
    await t.loader.load()
    expect(t.desktopCalls).toHaveBeenCalledTimes(1)
  })

  it('validates what the bridge sends', async () => {
    const t = setup({ desktop: () => ({ signature: async () => ({ status: 'signed', packaged: true, thumbprint: 'nope' }) as unknown as AppSignature }) })
    expect(await t.loader.load()).toEqual(UNKNOWN)
    expect(t.sig()).toEqual(UNKNOWN)
  })

  it('never throws: a rejecting / throwing bridge gives unknown, and the next call asks again', async () => {
    let n = 0
    const signature = vi.fn(async (): Promise<AppSignature> => {
      n++
      if (n === 1) throw new Error('ipc broke')
      return { status: 'tampered', packaged: true }
    })
    const t = setup({ desktop: () => ({ signature }) })
    await expect(t.loader.load()).resolves.toEqual(UNKNOWN)
    expect(t.sig()).toEqual(UNKNOWN)
    expect(await t.loader.load()).toEqual({ status: 'tampered', packaged: true })
    expect(signature).toHaveBeenCalledTimes(2)

    const sync = setup({
      source: () => {
        throw new Error('boom')
      },
    })
    await expect(sync.loader.load()).resolves.toEqual(UNKNOWN)
    const syncBridge = setup({
      desktop: () => ({
        signature: () => {
          throw new Error('sync throw')
        },
      }),
    })
    await expect(syncBridge.loader.load()).resolves.toEqual(UNKNOWN)
  })

  it('none: unknown (packaged) without calling anything; desktop source without a bridge: unknown', async () => {
    const t = setup({ src: 'none' })
    expect(await t.loader.load()).toEqual({ status: 'unknown', packaged: true })
    expect(t.desktopCalls).not.toHaveBeenCalled()
    expect(t.simCalls).not.toHaveBeenCalled()
    const gone = setup({ desktop: () => null })
    expect(await gone.loader.load()).toEqual(UNKNOWN)
  })

  it('sim: asks the simulation, then follows its changes live (subscribed once)', async () => {
    const t = setup({ src: 'sim' })
    expect(await t.loader.load()).toEqual({ status: 'unsigned', packaged: false })
    expect(t.simCalls).toHaveBeenCalledTimes(1)
    expect(t.watchSim).toHaveBeenCalledTimes(1)
    t.simStore.setState({ status: 'other-signer', packaged: true, signer: 'Người lạ (giả lập)', thumbprint: '0123456789ABCDEF0123456789ABCDEF01234567' }, true)
    await flushAsync()
    expect(t.sig()).toEqual({ status: 'other-signer', packaged: true, signer: 'Người lạ (giả lập)', thumbprint: '0123456789ABCDEF0123456789ABCDEF01234567' })
    t.simStore.setState({ status: 'tampered', packaged: true }, true)
    expect(t.sig()).toEqual({ status: 'tampered', packaged: true })
    // live changes are validated too
    t.simStore.setState({ status: 'hacked', packaged: true } as unknown as AppSignature, true)
    expect(t.sig()).toEqual(UNKNOWN)
    await t.loader.load()
    expect(t.watchSim).toHaveBeenCalledTimes(1)
  })

  it('keeps the same object when nothing changed (stable selector)', async () => {
    const t = setup({ src: 'sim' })
    await t.loader.load()
    const first = t.sig()
    t.simStore.setState({ status: 'unsigned', packaged: false }, true)
    expect(t.sig()).toBe(first)
  })
})
