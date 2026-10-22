// Who may use development mode (the simulated canvasapp, credit dev, Bảng phát triển, Test giới hạn) — the page side of
// the development-mode lock. The main process decides (electron/devaccess.cjs, pure rules in electron/devaccess-rules.cjs);
// this module only mirrors what it says and forwards requests.
//
// ---- API ----
//   useDevAccess(s => s.state)        DevAccessState (below). Select a primitive (s.state.access…) or the state object.
//   devAllowed() / useDevAllowed()    true unless 'locked' — every development-mode surface checks this (never a
//                                     silent simulation for a locked build).
//   devAccessBridge()                 the desktop bridge (window.bdpDesktop.devAccess), the browser simulation
//                                     (providers/dev/devAccess.ts, loopback only) or null (another web host).
//   startDevAccessSync()              once at startup (devAccessActions.initDevAccess): reads the state again (a reload
//                                     keeps the window's old initial value) and follows main's pushes.
//   parseDevAccessState(raw)          strict: anything unexpected → null (the caller keeps / falls back to locked).
//   initialDevAccess(env)             pure: the access before any answer (table below).
//
// Initial access (computed ONCE at import — tests that stub `window` later keep 'build'):
//   no window (vitest, node)                     build
//   Electron (bdpDesktop or an Electron UA)      what main passed (--bdp-dev-access=…); missing / unknown → locked
//   `npm run dev` (import.meta.env.DEV)          build
//   perf build (__SANOVIDS_PERF__)               build
//   loopback host (vite preview, perf on web)    build, or locked with the simulation's "Xem như bản phát hành"
//   any other host                               locked, and no way to unlock ("Chỉ mở khoá được trong bản desktop")
// The page never decides 'unlocked' by itself in Electron: no localStorage flag is ever read there.
// NOTE: no store/* or lib/pwa import here (providers/index imports this module; avoid import cycles).
import { create } from 'zustand'

export type DevAccessKind = 'build' | 'unlocked' | 'locked'
export type DevKeepDays = 0 | 1 | 7 | 30
export const DEV_KEEP_DAYS: readonly DevKeepDays[] = [1, 7, 30, 0]

export interface DevAccessState {
  access: DevAccessKind
  /** Unlocked until (ms), null = until locked by hand (or not unlocked). */
  until: number | null
  /** The unlock code's own limit (a code for someone else's computer), else null. */
  capUntil: number | null
  method: 'code' | 'totp' | 'email' | null
  keepDays: DevKeepDays
  /** 'XXXX-XXXX' — the device code the owner's tool makes codes for ('' when unknown). */
  deviceCode: string
  totp: { linked: boolean; label: string | null; lost: boolean }
  /** The authenticator may be linked until then (5 min after a code unlock that allows it), else null. */
  linkUntil: number | null
  /** totpBegin already ran in this link window. */
  linkStarted: boolean
  /** Wrong 6-digit codes: no new try before then. */
  waitUntil: number | null
  /** false = this computer cannot store the unlock: it lasts until SanoVids closes. */
  persist: boolean
  /** The Gmail stage is pinned (not built yet: always false). */
  email: boolean
}

export type DevUnlockError =
  | 'malformed'
  | 'bad-signature'
  | 'newer-format'
  | 'unknown-key'
  | 'no-keys'
  | 'other-device'
  | 'expired'
  | 'used'
  | 'clock'
  | 'totp-none'
  | 'totp-wrong'
  | 'totp-replay'
  | 'totp-old'
  | 'totp-lost'
  | 'totp-skew'
  | 'wait'
  | 'too-fast'
  | 'link-window'
  | 'link-used'
  | 'locked'
  | 'build'
  | 'cap'
  | 'write-failed'
  | 'not-desktop'
  | 'failed'

export type DevAccessResult = { ok: true; state: DevAccessState } | { ok: false; error: DevUnlockError | string; waitUntil?: number; minutes?: number; codeDevice?: string; thisDevice?: string }
export type DevTotpBegin = { ok: true; uri: string; secretGroups: string[]; label: string } | { ok: false; error: DevUnlockError | string }

/** window.bdpDesktop.devAccess (electron/preload.cjs) — and the browser simulation (providers/dev/devAccess.ts). */
export interface DevAccessBridge {
  initial?: string
  getState(): Promise<unknown>
  unlock(code: string): Promise<unknown>
  lock(): Promise<unknown>
  setKeep(days: number): Promise<unknown>
  totpBegin(): Promise<unknown>
  totpConfirm(code: string): Promise<unknown>
  linkCancel(): Promise<unknown>
  totpRemove(): Promise<unknown>
  onState(cb: (state: unknown) => void): () => void
}

const ACCESS: readonly DevAccessKind[] = ['build', 'unlocked', 'locked']

const isAccess = (v: unknown): v is DevAccessKind => typeof v === 'string' && (ACCESS as readonly string[]).includes(v)
const timeOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)

/** A state with `access` and nothing else known. */
export function bareState(access: DevAccessKind): DevAccessState {
  return {
    access,
    until: null,
    capUntil: null,
    method: null,
    keepDays: 7,
    deviceCode: '',
    totp: { linked: false, label: null, lost: false },
    linkUntil: null,
    linkStarted: false,
    waitUntil: null,
    persist: true,
    email: false,
  }
}

/** Strict reading of a state from main (or the simulation): any unexpected shape → null. */
export function parseDevAccessState(raw: unknown): DevAccessState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!isAccess(r.access) || !timeOrNull(r.until) || !timeOrNull(r.capUntil) || !timeOrNull(r.linkUntil) || !timeOrNull(r.waitUntil)) return null
  if (!(r.method === null || r.method === 'code' || r.method === 'totp' || r.method === 'email')) return null
  if (!(DEV_KEEP_DAYS as readonly unknown[]).includes(r.keepDays)) return null
  if (typeof r.deviceCode !== 'string' || !/^([0-9A-Z]{4}-[0-9A-Z]{4})?$/.test(r.deviceCode)) return null
  const t = r.totp as Record<string, unknown> | null
  if (!t || typeof t !== 'object' || typeof t.linked !== 'boolean' || typeof t.lost !== 'boolean' || !(t.label === null || (typeof t.label === 'string' && t.label.length <= 60))) return null
  if (typeof r.linkStarted !== 'boolean' || typeof r.persist !== 'boolean' || typeof r.email !== 'boolean') return null
  const access = r.access
  return {
    access,
    until: access === 'unlocked' ? r.until : null,
    capUntil: access === 'unlocked' ? r.capUntil : null,
    method: access === 'unlocked' ? r.method : null,
    keepDays: r.keepDays as DevKeepDays,
    deviceCode: r.deviceCode,
    totp: { linked: t.linked, label: t.label as string | null, lost: t.lost },
    linkUntil: r.linkUntil,
    linkStarted: r.linkStarted,
    waitUntil: r.waitUntil,
    persist: r.persist,
    email: r.email,
  }
}

/** { ok: true, state } | { ok: false, error, … } from an unlock / keep / link call; anything else → failed. */
export function parseDevAccessResult(raw: unknown): DevAccessResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'failed' }
  const r = raw as Record<string, unknown>
  if (r.ok === true) {
    const state = parseDevAccessState(r.state)
    return state ? { ok: true, state } : { ok: false, error: 'failed' }
  }
  const error = typeof r.error === 'string' && r.error.length <= 40 ? r.error : 'failed'
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const code = (v: unknown) => (typeof v === 'string' && /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(v) ? v : undefined)
  const out: DevAccessResult = { ok: false, error }
  if (num(r.waitUntil) !== undefined) out.waitUntil = num(r.waitUntil)
  if (num(r.minutes) !== undefined) out.minutes = num(r.minutes)
  if (code(r.codeDevice)) out.codeDevice = code(r.codeDevice)
  if (code(r.thisDevice)) out.thisDevice = code(r.thisDevice)
  return out
}

export interface DevAccessEnv {
  hasWindow: boolean
  viteDev: boolean
  perfBuild: boolean
  /** window.bdpDesktop exists or the user agent says Electron. */
  electron: boolean
  /** What main passed (bdpDesktop.devAccess.initial), when present. */
  desktopInitial?: unknown
  hostname?: string
  /** The browser simulation's "Xem như bản phát hành (đã khoá)" (never read in Electron). */
  simLocked?: boolean
}

/** Loopback hosts only (vite preview / perf on the web): the browser simulation may run there. */
export function isLoopbackHost(hostname: string | undefined): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/** Access before any answer (see the table at the top). */
export function initialDevAccess(env: DevAccessEnv): DevAccessKind {
  if (!env.hasWindow) return 'build'
  if (env.electron) return isAccess(env.desktopInitial) ? env.desktopInitial : 'locked'
  if (env.viteDev || env.perfBuild) return env.simLocked && isLoopbackHost(env.hostname) ? 'locked' : 'build'
  if (isLoopbackHost(env.hostname)) return env.simLocked ? 'locked' : 'build'
  return 'locked'
}

type DesktopLike = { bdpDesktop?: { devAccess?: unknown } }

function desktopBridgeObject(): DevAccessBridge | null {
  if (typeof window === 'undefined') return null
  const b = (window as DesktopLike).bdpDesktop?.devAccess as Partial<DevAccessBridge> | undefined
  if (!b || typeof b !== 'object') return null
  for (const k of ['getState', 'unlock', 'lock', 'setKeep', 'totpBegin', 'totpConfirm', 'linkCancel', 'totpRemove', 'onState'] as const) {
    if (typeof b[k] !== 'function') return null
  }
  return b as DevAccessBridge
}

function isElectronPage(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as DesktopLike).bdpDesktop || (typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent))
}

/** The browser simulation, registered by providers/dev/devAccess.ts (outside Electron, loopback only). */
let simBridge: DevAccessBridge | null = null

/** For providers/dev/devAccess.ts only (ignored inside Electron: there only main answers). */
export function registerDevAccessSim(bridge: DevAccessBridge): void {
  if (isElectronPage()) return
  simBridge = bridge
}

/** Where unlock requests go: the desktop bridge, the browser simulation, or null (another web host / no window). */
export function devAccessBridge(): DevAccessBridge | null {
  if (isElectronPage()) return desktopBridgeObject()
  return simBridge
}

function envNow(): DevAccessEnv {
  const hasWindow = typeof window !== 'undefined'
  const electron = isElectronPage()
  let hostname: string | undefined
  try {
    hostname = hasWindow ? window.location?.hostname : undefined
  } catch {
    hostname = undefined
  }
  const desktop = electron ? (window as DesktopLike).bdpDesktop?.devAccess : undefined
  return {
    hasWindow,
    viteDev: !!import.meta.env?.DEV,
    perfBuild: typeof __SANOVIDS_PERF__ !== 'undefined' && __SANOVIDS_PERF__,
    electron,
    desktopInitial: desktop && typeof desktop === 'object' ? (desktop as { initial?: unknown }).initial : undefined,
    hostname,
    simLocked: !electron && readSimLocked(),
  }
}

/** The simulation's "Xem như bản phát hành" flag, read only outside Electron (it can only LOCK, never unlock). */
export const SIM_LOCKED_KEY = 'bdp:dev:simLocked'
function readSimLocked(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(SIM_LOCKED_KEY) === '1'
  } catch {
    return false
  }
}

/** Why main locked by itself (pushed with the state): the unlock time ran out, or the clock went back. */
export type DevLockReason = 'expired' | 'clock-back' | 'key-removed'

export const useDevAccess = create<{ state: DevAccessState; reason: DevLockReason | null }>()(() => ({ state: bareState(initialDevAccess(envNow())), reason: null }))

/** Replace the mirrored state (a parsed answer of main / the simulation). Locked → unlocked only through these answers. */
export function applyDevAccessState(state: DevAccessState, reason: DevLockReason | null = null): void {
  const prev = useDevAccess.getState()
  if (prev.reason === reason && JSON.stringify(prev.state) === JSON.stringify(state)) return
  useDevAccess.setState({ state, reason })
}

const reasonOf = (raw: unknown): DevLockReason | null => {
  const r = raw && typeof raw === 'object' ? (raw as { reason?: unknown }).reason : undefined
  return r === 'expired' || r === 'clock-back' || r === 'key-removed' ? r : null
}

/** Development mode may be used here now. */
export function devAllowed(): boolean {
  return useDevAccess.getState().state.access !== 'locked'
}

export function useDevAllowed(): boolean {
  return useDevAccess((s) => s.state.access !== 'locked')
}

let syncStop: (() => void) | null = null
let known: Promise<void> = Promise.resolve()

/** Resolves once the first answer of main / the simulation arrived (at once without a bridge). Never rejects. */
export function whenDevAccessKnown(): Promise<void> {
  return known
}

/**
 * Follow main (or the simulation): read the state once and subscribe to pushes. A missing / broken answer in Electron
 * leaves the page locked (fail closed). Idempotent; returns a stop function.
 */
export function startDevAccessSync(): () => void {
  if (syncStop) return syncStop
  const bridge = devAccessBridge()
  if (!bridge) {
    if (isElectronPage()) applyDevAccessState(bareState('locked'))
    syncStop = () => undefined
    return syncStop
  }
  let alive = true
  const onRaw = (raw: unknown) => {
    if (!alive) return
    const st = parseDevAccessState(raw)
    if (st) applyDevAccessState(st, reasonOf(raw))
    else if (isElectronPage()) applyDevAccessState(bareState('locked'))
  }
  let off: () => void = () => undefined
  try {
    off = bridge.onState(onRaw)
  } catch {
    off = () => undefined
  }
  known = Promise.resolve()
    .then(() => bridge.getState())
    .then(onRaw, () => onRaw(null))
  syncStop = () => {
    alive = false
    off()
    syncStop = null
  }
  return syncStop
}

