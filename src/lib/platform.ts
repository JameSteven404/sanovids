// Which operating system SanoVids runs on, for the Mac / Windows differences of the renderer (⌘ instead of Ctrl,
// Finder, Thùng rác…; the words themselves live in lib/platformText.ts). Pure detection plus constants computed once at
// load: no stores, no React.
//
// Sources, in order (the first one that decides wins):
//   1. the desktop bridge: window.bdpDesktop.platform (electron/preload.cjs = Node's process.platform). Trusted only
//      when it is one of Node's platform names; 'darwin' = Mac, any other known name = not Mac;
//   2. navigator.userAgentData.platform (Chromium: 'macOS', 'Windows', …);
//   3. navigator.platform ('MacIntel', 'Win32', …);
//   4. navigator.userAgent.
// The navigator tests keep the rule of the older copies (/Mac|iPhone|iPad|iPod/: Apple keyboards use ⌘). Anything that
// cannot decide means "not Mac": the Windows wording and Ctrl stay the default.
//
// ---- API ----
//   Platform                       'mac' | 'win' ('win' = every non-Mac system: Windows conventions, Ctrl).
//   isMacPlatform(nav, bridge)     the decision above with injected sources (tests); never throws.
//   platformOf(nav, bridge)        the same as a Platform.
//   detectPlatform()               reads the real navigator / window.bdpDesktop (safe without them, e.g. in Node).
//   PLATFORM / IS_MAC              this device, computed once at load (the preload runs before any page script).
//   initPlatform(root?)            sets <html data-platform="mac|win"> for CSS; idempotent, never throws. Wired at
//                                  startup by src/main.tsx (next to initMotion) — not by this module.

export type Platform = 'mac' | 'win'

/** The parts of `navigator` read here (all optional and untrusted). */
export interface NavigatorLike {
  userAgentData?: { platform?: unknown } | null
  platform?: unknown
  userAgent?: unknown
}

/** The part of window.bdpDesktop read here (electron/preload.cjs exposes `platform: process.platform`). */
export interface PlatformBridgeLike {
  platform?: unknown
}

/** Node's process.platform values: only these are taken from the bridge (anything else falls back to navigator). */
export const NODE_PLATFORMS: readonly string[] = ['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32']

const APPLE_RE = /Mac|iPhone|iPad|iPod/i
/** Longest navigator string looked at (a hostile or broken value is never scanned in full). */
const MAX_NAV_CHARS = 512

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, MAX_NAV_CHARS) : null)

/** The bridge's answer: true / false when it names a known platform, null when it says nothing usable. */
function bridgeSaysMac(bridge: PlatformBridgeLike | null | undefined): boolean | null {
  let p: unknown
  try {
    p = bridge && typeof bridge === 'object' ? bridge.platform : undefined
  } catch {
    return null
  }
  return typeof p === 'string' && NODE_PLATFORMS.includes(p) ? p === 'darwin' : null
}

function navigatorSaysMac(nav: NavigatorLike | null | undefined): boolean {
  if (!nav || typeof nav !== 'object') return false
  try {
    const uaData = nav.userAgentData && typeof nav.userAgentData === 'object' ? text(nav.userAgentData.platform) : null
    if (uaData) return APPLE_RE.test(uaData)
    const platform = text(nav.platform)
    if (platform) return APPLE_RE.test(platform)
    const ua = text(nav.userAgent)
    return ua ? APPLE_RE.test(ua) : false
  } catch {
    return false
  }
}

/** Mac? The desktop bridge decides first, then navigator (userAgentData → platform → userAgent). Never throws. */
export function isMacPlatform(nav?: NavigatorLike | null, bridge?: PlatformBridgeLike | null): boolean {
  const fromBridge = bridgeSaysMac(bridge)
  return fromBridge ?? navigatorSaysMac(nav)
}

export function platformOf(nav?: NavigatorLike | null, bridge?: PlatformBridgeLike | null): Platform {
  return isMacPlatform(nav, bridge) ? 'mac' : 'win'
}

/** This device, from the real globals (safe where they do not exist). */
export function detectPlatform(): Platform {
  let nav: NavigatorLike | null = null
  let bridge: PlatformBridgeLike | null = null
  try {
    nav = typeof navigator !== 'undefined' ? (navigator as NavigatorLike) : null
  } catch {
    nav = null
  }
  try {
    bridge = typeof window !== 'undefined' ? ((window as { bdpDesktop?: PlatformBridgeLike }).bdpDesktop ?? null) : null
  } catch {
    bridge = null
  }
  return platformOf(nav, bridge)
}

/** This device's platform (computed once when the module loads). */
export const PLATFORM: Platform = detectPlatform()
export const IS_MAC: boolean = PLATFORM === 'mac'

/** The `data-platform` attribute of <html> (CSS hooks). Returns the platform; never throws. */
export function initPlatform(root?: { setAttribute(name: string, value: string): void } | null, platform: Platform = PLATFORM): Platform {
  try {
    const el = root ?? (typeof document !== 'undefined' ? document.documentElement : null)
    el?.setAttribute('data-platform', platform)
  } catch {
    // An exotic host without a DOM: nothing to mark.
  }
  return platform
}
