// Transport for seedvis.com.
// Desktop (Electron): window.bdpDesktop.seedvis → IPC → electron/seedvis.cjs (track A1) → a dedicated non-persistent
//   session. Main adds the API key (exact origin https://seedvis.com only), builds every path from a symbolic route,
//   enforces the route / body allowlist and the `mustFinishBy` upload deadline, and never re-sends (plan §10).
// Development mode ('seedvis-dev'): the same adapter over the simulated bridge of providers/dev/seedvis (track A-SIM).
// Web: unavailable — the key never enters a browser page.
//
// Which bridge failures prove that nothing reached seedvis is decided here (preSendCode) and used by errors.ts.
import type { SeedvisBridge, SeedvisBridgeErrorCode, SeedvisBridgeFailure } from './contract'

/** The desktop bridge, or null in a browser / a desktop build without seedvis. */
export function seedvisBridge(): SeedvisBridge | null {
  if (typeof window === 'undefined') return null
  // lib/pwa DesktopInfo gains `seedvis?` in track B2 (§10.4); read through unknown until then.
  const b = (window.bdpDesktop as unknown as { seedvis?: SeedvisBridge } | undefined)?.seedvis
  return b && typeof b.request === 'function' && typeof b.keyStatus === 'function' ? b : null
}

export function hasSeedvisBridge(): boolean {
  return seedvisBridge() !== null
}

/**
 * Bridge failure codes main only ever answers BEFORE any byte of a create left this computer (a local refusal: lane
 * full, offline, key missing, body refused by the allowlist…). With `sent` missing they still mean "not sent".
 */
const PRE_SEND_CODES: ReadonlySet<SeedvisBridgeErrorCode> = new Set<SeedvisBridgeErrorCode>([
  'not-allowed',
  'no-key',
  'key-unreadable',
  'bad-key',
  'bad-request',
  'too-large',
  'bad-image',
  'rate-limited',
  'busy',
  'offline',
  'storage-unavailable',
  'storage-failed',
])

/** True when a failure of a create proves nothing reached seedvis: `sent === false`, or a pre-send code without `sent`. */
export function failureNotSent(f: Pick<SeedvisBridgeFailure, 'code' | 'sent'>): boolean {
  if (f.sent === true) return false
  if (f.sent === false) return true
  return PRE_SEND_CODES.has(f.code)
}

/**
 * A failure made up in the renderer (IPC rejected, malformed answer, no bridge). Its message is never shown: the
 * adapter words every failure by its code. `sent` undefined = unknown (a create then counts as maybe sent).
 */
export function bridgeFailure(code: SeedvisBridgeErrorCode, sent: boolean | undefined): SeedvisBridgeFailure {
  return { ok: false, code, message: 'Không gọi được cổng seedvis trong SanoVids.', ...(sent === undefined ? {} : { sent }) }
}
