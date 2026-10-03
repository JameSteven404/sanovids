// Development mode's simulated signature self-check (providers/dev/appSignature): the presets of "Bảng phát triển →
// Cập nhật → Chữ ký số (Giới thiệu)", answers that are copies (never the store itself), and the "Lỗi chữ ký số" state
// of the simulated updater (providers/dev/updates failSignature).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { ABOUT_AUTHOR, ABOUT_OFFICIAL_THUMBPRINT, signatureView } from '../../lib/aboutModel'
import { parseAppSignature, type AppSignature } from '../../lib/appSignature'
import { UPDATE_ERROR_TEXT } from '../../lib/updateModel'
import {
  createDevSignatureBridge,
  DEV_OTHER_THUMBPRINT,
  DEV_SIGNATURE_DELAY_MS,
  DEV_SIGNATURE_OPTIONS,
  DEV_SIGNATURE_PRESET_IDS,
  DEV_SIGNATURE_PRESETS,
  devSignature,
  devSignatureBridge,
  devSignaturePresetOf,
  simulateDevSignature,
  useDevSignature,
  type DevSignaturePreset,
} from '../dev/appSignature'
import { createDevUpdatesBridge, DEV_UPDATES_DRAFT_DEFAULT, devUpdatesInitialState, type DevUpdatesStore } from '../dev/updates'

const PIN = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  devSignature.reset()
})

const newStore = () => create<AppSignature>()(() => ({ status: 'unsigned', packaged: false }))

describe('presets', () => {
  it('match the spec', () => {
    expect(DEV_SIGNATURE_PRESETS).toEqual({
      signed: { status: 'signed', packaged: true, signer: ABOUT_AUTHOR, thumbprint: PIN },
      dev: { status: 'unsigned', packaged: false },
      'unsigned-packaged': { status: 'unsigned', packaged: true },
      other: { status: 'other-signer', packaged: true, signer: 'Người lạ (giả lập)', thumbprint: '0123456789ABCDEF0123456789ABCDEF01234567' },
      tampered: { status: 'tampered', packaged: true },
      unknown: { status: 'unknown', packaged: true },
    })
    expect(DEV_SIGNATURE_PRESETS.signed.thumbprint).toBe(ABOUT_OFFICIAL_THUMBPRINT)
    expect(DEV_OTHER_THUMBPRINT).not.toBe(PIN)
  })

  it('every preset is a valid payload, maps back to itself and has an option', () => {
    expect(DEV_SIGNATURE_OPTIONS.map((o) => o.id)).toEqual([...DEV_SIGNATURE_PRESET_IDS])
    expect(DEV_SIGNATURE_OPTIONS.map((o) => o.label)).toEqual(['Đã ký', 'Chưa ký – bản phát triển', 'Chưa ký – bản cài', 'Người ký khác', 'Bị sửa', 'Không rõ'])
    for (const id of DEV_SIGNATURE_PRESET_IDS) {
      const p = DEV_SIGNATURE_PRESETS[id]
      expect(parseAppSignature(p)).toEqual(p)
      expect(devSignaturePresetOf(p)).toBe(id)
    }
  })

  it('each preset shows a different About state', () => {
    const titles = DEV_SIGNATURE_PRESET_IDS.map((id) => signatureView(DEV_SIGNATURE_PRESETS[id]).title)
    expect(new Set(titles).size).toBe(DEV_SIGNATURE_PRESET_IDS.length)
  })

  it('the app store starts as a development build (unsigned, not packaged)', () => {
    expect(useDevSignature.getState()).toEqual({ status: 'unsigned', packaged: false })
  })
})

describe('simulate', () => {
  it('replaces the state (no signer / thumbprint left from the previous preset)', () => {
    const store = newStore()
    simulateDevSignature(store, 'other')
    expect(store.getState()).toMatchObject({ status: 'other-signer', signer: 'Người lạ (giả lập)' })
    simulateDevSignature(store, 'tampered')
    expect(store.getState()).toEqual({ status: 'tampered', packaged: true })
    simulateDevSignature(store, 'bogus' as DevSignaturePreset)
    expect(store.getState()).toEqual({ status: 'tampered', packaged: true })
  })

  it('never shares the preset objects', () => {
    const store = newStore()
    simulateDevSignature(store, 'signed')
    ;(store.getState() as { signer?: string }).signer = 'hacked'
    expect(DEV_SIGNATURE_PRESETS.signed.signer).toBe(ABOUT_AUTHOR)
  })

  it('devSignature drives the app store; reset goes back to the development build', () => {
    devSignature.simulate('unknown')
    expect(useDevSignature.getState()).toEqual({ status: 'unknown', packaged: true })
    devSignature.reset()
    expect(useDevSignature.getState()).toEqual({ status: 'unsigned', packaged: false })
  })
})

describe('bridge', () => {
  it('resolves a copy of the state after the delay, taken when it resolves', async () => {
    const store = newStore()
    const bridge = createDevSignatureBridge(store)
    let got: AppSignature | null = null
    void bridge.signature().then((s) => (got = s))
    simulateDevSignature(store, 'signed') // changed while "checking"
    await vi.advanceTimersByTimeAsync(DEV_SIGNATURE_DELAY_MS - 1)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(got).toEqual(DEV_SIGNATURE_PRESETS.signed)
  })

  it('clone isolation: mutating an answer changes neither the store nor the next answer', async () => {
    const store = newStore()
    simulateDevSignature(store, 'signed')
    const bridge = createDevSignatureBridge(store, 0)
    const p = bridge.signature()
    await vi.advanceTimersByTimeAsync(0)
    const a = await p
    expect(a).not.toBe(store.getState())
    a.status = 'tampered'
    a.signer = 'x'
    expect(store.getState()).toEqual(DEV_SIGNATURE_PRESETS.signed)
    const q = bridge.signature()
    await vi.advanceTimersByTimeAsync(0)
    expect(await q).toEqual(DEV_SIGNATURE_PRESETS.signed)
  })

  it('devSignatureBridge is a singleton on the app store', async () => {
    expect(devSignatureBridge()).toBe(devSignatureBridge())
    devSignature.simulate('tampered')
    const p = devSignatureBridge().signature()
    await vi.advanceTimersByTimeAsync(DEV_SIGNATURE_DELAY_MS)
    expect(await p).toEqual({ status: 'tampered', packaged: true })
  })
})

describe('simulated updater: failSignature ("Lỗi chữ ký số")', () => {
  function setupUpdates() {
    const store = create<DevUpdatesStore>()(() => ({ state: devUpdatesInitialState(), nextCheck: 'available', draft: { ...DEV_UPDATES_DRAFT_DEFAULT } }))
    const sim = createDevUpdatesBridge({ store, notify: vi.fn() })
    return { store, sim, state: () => store.getState().state }
  }

  it('error with code signature for the draft version (a dev build becomes the installer)', () => {
    const { sim, state } = setupUpdates()
    sim.failSignature()
    expect(state()).toMatchObject({
      kind: 'installer',
      status: 'error',
      version: DEV_UPDATES_DRAFT_DEFAULT.version,
      notes: DEV_UPDATES_DRAFT_DEFAULT.notes,
      error: { code: 'signature', message: UPDATE_ERROR_TEXT.signature },
    })
    expect(state().percent).toBeUndefined()
    expect(state().lastCheck).toEqual(expect.any(Number))
  })

  it('stops a running download; "Thử lại" downloads again', async () => {
    const { sim, state } = setupUpdates()
    sim.runDownload()
    expect(state().status).toBe('downloading')
    sim.failSignature()
    expect(state()).toMatchObject({ status: 'error', error: { code: 'signature' } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(state().status).toBe('error') // the stopped download does not come back
    expect(await sim.download()).toEqual({ ok: true })
    expect(state().status).toBe('downloading')
  })
})
