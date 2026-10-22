// Development mode's simulated signature self-check (providers/dev/appSignature): the presets of "Bảng phát triển →
// Cập nhật → Chữ ký số (Giới thiệu)", answers that are copies (never the store itself), and the "Lỗi chữ ký số" /
// "Chưa kiểm tra được chữ ký" states of the simulated updater (providers/dev/updates failSignature).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { ABOUT_AUTHOR, ABOUT_OFFICIAL_THUMBPRINT, MAC_SIGNATURE_TITLE, signatureView as signatureViewOn, thumbprintRows } from '../../lib/aboutModel'
import { parseAppSignature, type AppSignature } from '../../lib/appSignature'
import { UPDATE_ERROR_TEXT } from '../../lib/updateModel'
import {
  createDevSignatureBridge,
  DEV_OTHER_THUMBPRINT,
  DEV_SIGNATURE_DELAY_MS,
  DEV_SIGNATURE_MAC_OPTION,
  DEV_SIGNATURE_OPTIONS,
  DEV_SIGNATURE_PLATFORMS,
  DEV_SIGNATURE_PRESET_IDS,
  DEV_SIGNATURE_PRESETS,
  devSignature,
  devSignatureBridge,
  devSignaturePresetOf,
  simulateDevSignature,
  useDevSignature,
  useDevSignaturePlatform,
  type DevSignaturePreset,
} from '../dev/appSignature'
import { createDevUpdatesBridge, DEV_UPDATES_DRAFT_DEFAULT, devUpdatesInitialState, type DevUpdatesStore } from '../dev/updates'

const PIN = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
/** The About row of a preset, on the platform it simulates (Windows for every non-Mac answer). */
const signatureView = (sig: AppSignature | null, id?: DevSignaturePreset) => signatureViewOn(sig, (id && DEV_SIGNATURE_PLATFORMS[id]) || 'win')

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
      impostor: { status: 'other-signer', packaged: true, signer: 'Nguyễn Giang Minh (Jame Steven)', thumbprint: 'FEDCBA9876543210FEDCBA9876543210FEDCBA98' },
      tampered: { status: 'tampered', packaged: true },
      unknown: { status: 'unknown', packaged: true },
      'mac-adhoc': { status: 'unknown', packaged: true },
    })
    expect(DEV_SIGNATURE_PRESETS.signed.thumbprint).toBe(ABOUT_OFFICIAL_THUMBPRINT)
    expect(DEV_OTHER_THUMBPRINT).not.toBe(PIN)
    expect(DEV_SIGNATURE_PRESETS.impostor.thumbprint).not.toBe(PIN)
  })

  it('every preset is a valid payload, maps back to itself and has an option', () => {
    // the Windows answers are the dev panel's options; the Mac one has its own option (shown once the About block
    // reads the simulated platform)
    expect([...DEV_SIGNATURE_OPTIONS, DEV_SIGNATURE_MAC_OPTION].map((o) => o.id)).toEqual([...DEV_SIGNATURE_PRESET_IDS])
    expect(DEV_SIGNATURE_OPTIONS.map((o) => o.label)).toEqual(['Đã ký', 'Chưa ký – bản phát triển', 'Chưa ký – bản cài', 'Người ký khác', 'Giả tên tác giả', 'Bị sửa', 'Không rõ'])
    expect(DEV_SIGNATURE_MAC_OPTION.label).toBe('Bản Mac (ad-hoc)')
    for (const id of DEV_SIGNATURE_PRESET_IDS) {
      const p = DEV_SIGNATURE_PRESETS[id]
      expect(parseAppSignature(p)).toEqual(p)
      expect(devSignaturePresetOf(p, DEV_SIGNATURE_PLATFORMS[id])).toBe(id)
      expect(DEV_SIGNATURE_PLATFORMS[id]).toBe(id === 'mac-adhoc' ? 'mac' : null)
    }
  })

  it('each preset shows a different About state', () => {
    const titles = DEV_SIGNATURE_PRESET_IDS.map((id) => signatureView(DEV_SIGNATURE_PRESETS[id], id).title)
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
    expect(useDevSignaturePlatform.getState().platform).toBeNull()
    devSignature.reset()
    expect(useDevSignature.getState()).toEqual({ status: 'unsigned', packaged: false })
  })

  it('the Mac answer ("Bản Mac (ad-hoc)"): what a packaged Mac build sends, shown with the Mac texts — never "signed"', () => {
    devSignature.simulate('mac-adhoc')
    const sig = useDevSignature.getState()
    const platform = useDevSignaturePlatform.getState().platform
    expect(sig).toEqual({ status: 'unknown', packaged: true })
    expect(platform).toBe('mac')
    expect(devSignaturePresetOf(sig, platform)).toBe('mac-adhoc')
    // the same payload on Windows is the "could not check" answer
    expect(devSignaturePresetOf(sig)).toBe('unknown')
    const view = signatureViewOn(sig, platform ?? 'win')
    expect(view).toMatchObject({ tone: 'neutral', title: MAC_SIGNATURE_TITLE })
    expect(`${view.title} ${view.detail}`).not.toMatch(/Đã ký|✓|Bản gốc|PowerShell|Windows/)
    expect(thumbprintRows(sig, 'mac')).toEqual([])
    // any other answer goes back to this device's platform; so does reset
    devSignature.simulate('signed')
    expect(useDevSignaturePlatform.getState().platform).toBeNull()
    devSignature.simulate('mac-adhoc')
    devSignature.reset()
    expect(useDevSignaturePlatform.getState().platform).toBeNull()
    // a separate store without a platform store: only the signature changes
    const store = newStore()
    simulateDevSignature(store, 'mac-adhoc')
    expect(store.getState()).toEqual({ status: 'unknown', packaged: true })
    expect(useDevSignaturePlatform.getState().platform).toBeNull()
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

  it('"Chưa kiểm tra được chữ ký": code signature-unverified with its own text', () => {
    const { sim, state } = setupUpdates()
    sim.failSignature('signature-unverified')
    expect(state()).toMatchObject({
      kind: 'installer',
      status: 'error',
      version: DEV_UPDATES_DRAFT_DEFAULT.version,
      error: { code: 'signature-unverified', message: UPDATE_ERROR_TEXT['signature-unverified'] },
    })
  })
})

describe('impostor preset ("Giả tên tác giả")', () => {
  it('carries the author name with another thumbprint, and the About block calls it a possible impostor', () => {
    const p = DEV_SIGNATURE_PRESETS.impostor
    expect(p).toMatchObject({ status: 'other-signer', signer: ABOUT_AUTHOR })
    expect(p.thumbprint).not.toBe(ABOUT_OFFICIAL_THUMBPRINT)
    expect(signatureView(p).title).toBe('Không phải bản gốc — có thể là bản giả mạo')
    expect(devSignaturePresetOf(p)).toBe('impostor')
    expect(devSignaturePresetOf(DEV_SIGNATURE_PRESETS.other)).toBe('other')
  })
})
