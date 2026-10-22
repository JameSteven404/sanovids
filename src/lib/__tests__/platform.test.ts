// lib/platform: the desktop bridge decides first (only a real Node platform name counts), then navigator
// (userAgentData → platform → userAgent); anything undecidable is the Windows default. Never throws, even on hostile
// or broken inputs; <html data-platform> is set by initPlatform.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectPlatform, initPlatform, IS_MAC, isMacPlatform, NODE_PLATFORMS, PLATFORM, platformOf, type NavigatorLike } from '../platform'

const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const winNav: NavigatorLike = { userAgentData: { platform: 'Windows' }, platform: 'Win32', userAgent: WIN_UA }
const macNav: NavigatorLike = { userAgentData: { platform: 'macOS' }, platform: 'MacIntel', userAgent: MAC_UA }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isMacPlatform: the desktop bridge first', () => {
  it("the bridge's Node platform decides over whatever navigator says", () => {
    expect(isMacPlatform(winNav, { platform: 'darwin' })).toBe(true)
    expect(isMacPlatform(macNav, { platform: 'win32' })).toBe(false)
    expect(isMacPlatform(macNav, { platform: 'linux' })).toBe(false)
    expect(isMacPlatform(null, { platform: 'darwin' })).toBe(true)
    expect(platformOf(winNav, { platform: 'darwin' })).toBe('mac')
    expect(platformOf(macNav, { platform: 'win32' })).toBe('win')
  })

  it('only a real Node platform name counts: anything else falls back to navigator', () => {
    expect(NODE_PLATFORMS).toContain('darwin')
    expect(NODE_PLATFORMS).toContain('win32')
    for (const platform of ['Darwin', 'macOS', 'mac', 'darwin ', '', 42, null, true, {}, ['darwin']]) {
      expect(isMacPlatform(macNav, { platform }), JSON.stringify(platform)).toBe(true)
      expect(isMacPlatform(winNav, { platform }), JSON.stringify(platform)).toBe(false)
    }
    for (const bridge of [null, undefined, {}, 'darwin' as never, 7 as never]) {
      expect(isMacPlatform(macNav, bridge)).toBe(true)
      expect(isMacPlatform(winNav, bridge)).toBe(false)
    }
  })

  it('a bridge whose platform getter throws is ignored, never thrown on', () => {
    const hostile = Object.defineProperty({}, 'platform', {
      get() {
        throw new Error('boom')
      },
    })
    expect(isMacPlatform(macNav, hostile)).toBe(true)
    expect(isMacPlatform(winNav, hostile)).toBe(false)
  })
})

describe('isMacPlatform: navigator fallbacks', () => {
  it('userAgentData.platform first, then navigator.platform, then the user agent', () => {
    // userAgentData decides when it says something
    expect(isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: 'Win32', userAgent: WIN_UA })).toBe(true)
    expect(isMacPlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel', userAgent: MAC_UA })).toBe(false)
    // empty / non-string userAgentData → navigator.platform
    expect(isMacPlatform({ userAgentData: { platform: '' }, platform: 'MacIntel', userAgent: WIN_UA })).toBe(true)
    expect(isMacPlatform({ userAgentData: { platform: 3 }, platform: 'Win32', userAgent: MAC_UA })).toBe(false)
    expect(isMacPlatform({ userAgentData: null, platform: 'MacIntel' })).toBe(true)
    // no platform → the user agent
    expect(isMacPlatform({ platform: '', userAgent: MAC_UA })).toBe(true)
    expect(isMacPlatform({ userAgent: WIN_UA })).toBe(false)
  })

  it('Apple devices use ⌘ (same rule as the older copies); Windows, Linux, Android do not', () => {
    for (const platform of ['MacIntel', 'Macintosh', 'iPad', 'iPhone', 'iPod touch']) expect(isMacPlatform({ platform }), platform).toBe(true)
    for (const platform of ['Win32', 'Win64', 'Linux x86_64', 'Linux armv8l', 'Android']) expect(isMacPlatform({ platform }), platform).toBe(false)
    expect(isMacPlatform({ userAgentData: { platform: 'Linux' } })).toBe(false)
    expect(isMacPlatform({ userAgentData: { platform: 'Chrome OS' } })).toBe(false)
  })

  it('nothing usable → the Windows default', () => {
    for (const nav of [null, undefined, {}, { platform: null, userAgent: 12 }, 'MacIntel' as never]) {
      expect(isMacPlatform(nav)).toBe(false)
      expect(platformOf(nav)).toBe('win')
    }
    expect(isMacPlatform()).toBe(false)
  })

  it('a huge user agent is not scanned in full; a throwing navigator is the Windows default', () => {
    expect(isMacPlatform({ userAgent: 'x'.repeat(10_000) + ' Macintosh' })).toBe(false)
    const hostile = Object.defineProperty({}, 'userAgentData', {
      get() {
        throw new Error('boom')
      },
    }) as NavigatorLike
    expect(isMacPlatform(hostile)).toBe(false)
    expect(isMacPlatform(hostile, { platform: 'darwin' })).toBe(true)
  })
})

describe('detectPlatform / PLATFORM / IS_MAC', () => {
  it('reads window.bdpDesktop first, then the real navigator', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: WIN_UA })
    vi.stubGlobal('window', { bdpDesktop: { version: '0.6.0', platform: 'darwin' } })
    expect(detectPlatform()).toBe('mac')
    vi.stubGlobal('window', { bdpDesktop: { version: '0.6.0', platform: 'win32' } })
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: MAC_UA })
    expect(detectPlatform()).toBe('win')
    // a browser (no bridge): navigator decides
    vi.stubGlobal('window', {})
    expect(detectPlatform()).toBe('mac')
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: WIN_UA })
    expect(detectPlatform()).toBe('win')
  })

  it('no window and no navigator (plain Node) → the Windows default', () => {
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('navigator', undefined)
    expect(detectPlatform()).toBe('win')
  })

  it('the constants agree with each other and with this machine', () => {
    expect(IS_MAC).toBe(PLATFORM === 'mac')
    expect(['mac', 'win']).toContain(PLATFORM)
    expect(PLATFORM).toBe(detectPlatform())
  })
})

describe('initPlatform', () => {
  it('marks the root with data-platform and returns the platform', () => {
    const setAttribute = vi.fn()
    expect(initPlatform({ setAttribute }, 'mac')).toBe('mac')
    expect(setAttribute).toHaveBeenCalledWith('data-platform', 'mac')
    initPlatform({ setAttribute }, 'win')
    expect(setAttribute).toHaveBeenLastCalledWith('data-platform', 'win')
    // idempotent: the same value again is harmless
    initPlatform({ setAttribute }, 'win')
    expect(setAttribute).toHaveBeenLastCalledWith('data-platform', 'win')
    expect(initPlatform({ setAttribute })).toBe(PLATFORM)
  })

  it('without a DOM, or with a root that throws: no error', () => {
    vi.stubGlobal('document', undefined)
    expect(initPlatform()).toBe(PLATFORM)
    expect(initPlatform(null, 'mac')).toBe('mac')
    const root = {
      setAttribute() {
        throw new Error('read-only')
      },
    }
    expect(initPlatform(root, 'win')).toBe('win')
    const setAttribute = vi.fn()
    vi.stubGlobal('document', { documentElement: { setAttribute } })
    initPlatform(undefined, 'mac')
    expect(setAttribute).toHaveBeenCalledWith('data-platform', 'mac')
  })
})
