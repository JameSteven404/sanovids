// Development-mode lock, simulated in a browser on a loopback host (`npm run dev`, vite preview, perf on the web) — so
// the locked look can be checked without the desktop app. It mirrors the desktop bridge (electron/preload.cjs
// devAccess) with a tiny in-memory model; the real cryptography is tested in src/lib/__tests__/devAccessRules.test.ts.
//
//   "Xem như bản phát hành (đã khoá)"  localStorage SIM_LOCKED_KEY: can only LOCK; never read inside Electron.
//   Unlock while sim-locked              the 6-digit TOTP of the public RFC 6238 test key "12345678901234567890"
//                                        (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ), computed with crypto.subtle.
//   SV1 codes                            'no-keys' (the simulation pins no owner key); linking never opens here.
//   setSimLocked(false)                  "Bỏ khoá giả lập": back to the build-opened state.
import { bareState, registerDevAccessSim, SIM_LOCKED_KEY, type DevAccessBridge, type DevAccessState, type DevKeepDays } from '../devAccess'

/** The public RFC 6238 test secret (Appendix B, SHA-1) — nothing to protect, it is printed in the standard. */
export const SIM_TOTP_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const SECRET = new TextEncoder().encode('12345678901234567890')
const DAY_MS = 24 * 3_600_000

let locked = readFlag()
let unlockedUntil: number | null | undefined = undefined // undefined = not unlocked; null = until locked
let keepDays: DevKeepDays = 7
let lastStep = -1
const listeners = new Set<(s: unknown) => void>()

function readFlag(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(SIM_LOCKED_KEY) === '1'
  } catch {
    return false
  }
}

function state(): DevAccessState {
  if (!locked) return { ...bareState('build'), keepDays }
  const now = Date.now()
  if (unlockedUntil !== undefined && unlockedUntil !== null && now >= unlockedUntil) unlockedUntil = undefined
  const base = { ...bareState(unlockedUntil === undefined ? 'locked' : 'unlocked'), keepDays, deviceCode: 'SIMU-1ATE' }
  return unlockedUntil === undefined ? base : { ...base, until: unlockedUntil, method: 'totp', totp: { linked: true, label: 'SanoVids · Máy SIMU', lost: false } }
}

function emit() {
  const s = state()
  for (const l of listeners) l(s)
}

async function hotp(step: number): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return ''
  const key = await subtle.importKey('raw', SECRET, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const msg = new Uint8Array(8)
  let c = step
  for (let i = 7; i >= 0; i--) {
    msg[i] = c % 256
    c = Math.floor(c / 256)
  }
  const h = new Uint8Array(await subtle.sign('HMAC', key, msg))
  const off = h[h.length - 1] & 15
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 1_000_000).padStart(6, '0')
}

const ok = () => ({ ok: true, state: state() })

export const simDevAccess: DevAccessBridge & { setSimLocked(on: boolean): void; isSimLocked(): boolean } = {
  initial: '',
  getState: async () => state(),
  async unlock(code) {
    if (!locked || unlockedUntil !== undefined) return ok()
    const raw = String(code ?? '').replace(/[\s-]+/g, '')
    if (/^SV1/i.test(raw)) return { ok: false, error: 'no-keys' }
    if (!/^\d{6}$/.test(raw)) return { ok: false, error: 'malformed' }
    const c = Math.floor(Date.now() / 30_000)
    for (const step of [c, c - 1, c + 1]) {
      if ((await hotp(step)) !== raw) continue
      if (step <= lastStep) return { ok: false, error: 'totp-replay' }
      lastStep = step
      unlockedUntil = keepDays ? Date.now() + keepDays * DAY_MS : null
      emit()
      return ok()
    }
    return { ok: false, error: 'totp-wrong', thisDevice: 'SIMU-1ATE' }
  },
  async lock() {
    unlockedUntil = undefined
    emit()
    return state()
  },
  async setKeep(days) {
    if (!locked) return { ok: false, error: 'build' }
    if (unlockedUntil === undefined) return { ok: false, error: 'locked' }
    if (![0, 1, 7, 30].includes(days)) return { ok: false, error: 'failed' }
    keepDays = days as DevKeepDays
    unlockedUntil = days ? Date.now() + days * DAY_MS : null
    emit()
    return ok()
  },
  totpBegin: async () => ({ ok: false, error: locked ? 'link-window' : 'build' }),
  totpConfirm: async () => ({ ok: false, error: locked ? 'link-window' : 'build' }),
  linkCancel: async () => state(),
  totpRemove: async () => ({ ok: false, error: locked ? (unlockedUntil === undefined ? 'locked' : 'failed') : 'build' }),
  onState(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  /** "Xem như bản phát hành (đã khoá)" on / off ("Bỏ khoá giả lập"). */
  setSimLocked(on) {
    locked = on
    unlockedUntil = undefined
    try {
      if (on) localStorage.setItem(SIM_LOCKED_KEY, '1')
      else localStorage.removeItem(SIM_LOCKED_KEY)
    } catch {
      /* the flag lasts for this page only */
    }
    emit()
  },
  isSimLocked: () => locked,
}

/** Registers the simulation (ignored inside Electron and on hosts other than loopback). */
export function installDevAccessSim(hostname: string | undefined): boolean {
  if (!(hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1')) return false
  registerDevAccessSim(simDevAccess)
  return true
}
