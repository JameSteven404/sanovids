import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_PREFS, parseBackgroundPref } from '../theme'

const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]
const css = readFileSync(new URL('../../styles/base.css', import.meta.url), 'utf8')
const colors = { than: '#161618', deep: '#0c0c0d', slate: '#14171c' }

function device(pref: string | null, background: string | null, osDark = true, blocked = false) {
  const stored = new Map([['bdp:pref:theme', pref], ['bdp:pref:background', background]])
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> }
  const meta = { setAttribute: vi.fn() }
  const media = { matches: osDark, addEventListener: vi.fn() }
  const localStorage = {
    getItem: (key: string) => {
      if (blocked) throw new Error('Storage unavailable')
      return stored.get(key) ?? null
    },
    setItem: (key: string, value: string) => {
      if (blocked) throw new Error('Storage unavailable')
      stored.set(key, value)
    },
  }
  const document = { documentElement: root, querySelector: () => meta }
  const window = { matchMedia: (query: string) => query.includes(': light') ? { matches: !media.matches } : media }
  return { root, meta, media, stored, localStorage, document, window }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('background preference', () => {
  it('accepts only the three stored choices and defaults to Than', () => {
    for (const bg of BACKGROUND_PREFS) expect(parseBackgroundPref(JSON.stringify(bg))).toBe(bg)
    for (const bad of [null, undefined, '', '{', '"pink"', '"dark"', 'false', '1', '{}', '["deep"]']) {
      expect(parseBackgroundPref(bad)).toBe('than')
    }
  })

  it('keeps the demo variants dark-only and the new swatches independent of the active theme', () => {
    for (const bg of ['deep', 'slate']) {
      expect(css).toContain(`:root[data-bg='${bg}']:not([data-theme='light'])`)
    }
    for (const [bg, color] of Object.entries(colors)) {
      expect(css.toLowerCase()).toContain(`--bg-swatch-${bg}: ${color};`)
    }
  })

  it('uses one inline script before the body for the first paint', () => {
    expect(html.match(/<script>/g)).toHaveLength(1)
    expect(html.indexOf(script)).toBeLessThan(html.indexOf('<body>'))
  })

  it.each(BACKGROUND_PREFS)('matches first paint and runtime for %s in both themes and system mode', async (bg) => {
    for (const pref of ['dark', 'light', 'system']) {
      for (const osDark of [false, true]) {
        vi.resetModules()
        const d = device(JSON.stringify(pref), JSON.stringify(bg), osDark)
        runInNewContext(script, d)
        const dark = pref === 'dark' || (pref === 'system' && osDark)
        const color = dark ? colors[bg] : '#f5f5f7'
        expect(d.root.dataset).toEqual({ theme: dark ? 'dark' : 'light', bg })
        expect(d.root.style).toEqual({ colorScheme: dark ? 'dark' : 'light', background: color })
        vi.stubGlobal('localStorage', d.localStorage)
        vi.stubGlobal('window', d.window)
        vi.stubGlobal('document', d.document)
        const { initTheme, useTheme } = await import('../theme')
        initTheme()
        expect(useTheme.getState()).toMatchObject({ pref, background: bg, theme: dark ? 'dark' : 'light' })
        expect(d.root.style.background).toBe(color)
        expect(d.meta.setAttribute).toHaveBeenLastCalledWith('content', color)
      }
    }
  })

  it('updates live, persists, follows the OS and keeps the background choice through light mode', async () => {
    const d = device('"system"', '"deep"')
    vi.stubGlobal('localStorage', d.localStorage)
    vi.stubGlobal('window', d.window)
    vi.stubGlobal('document', d.document)
    const { initTheme, useTheme } = await import('../theme')
    initTheme()
    const state = useTheme.getState()
    state.setBackground('slate')
    expect(d.stored.get('bdp:pref:background')).toBe('"slate"')
    expect(d.root.style.background).toBe(colors.slate)
    const onChange = d.media.addEventListener.mock.calls[0][1]
    d.media.matches = false
    onChange()
    expect(d.root.dataset).toEqual({ theme: 'light', bg: 'slate' })
    expect(d.root.style.background).toBe('#f5f5f7')
    state.setBackground('deep')
    expect(d.root.style.background).toBe('#f5f5f7')
    d.media.matches = true
    onChange()
    expect(d.root.style.background).toBe(colors.deep)
    state.setPref('light')
    onChange()
    expect(d.root.style.background).toBe('#f5f5f7')
    state.setPref('dark')
    expect(d.root.style.background).toBe(colors.deep)
    state.setBackground('pink' as never)
    expect(useTheme.getState().background).toBe('deep')
    expect(d.stored.get('bdp:pref:background')).toBe('"deep"')
  })

  it.each([false, true])('survives corrupt or blocked storage (blocked=%s)', async (blocked) => {
    const d = device('{', '["deep"]', false, blocked)
    runInNewContext(script, d)
    expect(d.root.dataset).toEqual({ theme: 'light', bg: 'than' })
    vi.stubGlobal('localStorage', d.localStorage)
    vi.stubGlobal('window', d.window)
    vi.stubGlobal('document', d.document)
    const { initTheme, useTheme } = await import('../theme')
    initTheme()
    expect(useTheme.getState()).toMatchObject({ pref: 'system', background: 'than', theme: 'light' })
    useTheme.getState().setBackground('slate')
    useTheme.getState().setPref('dark')
    expect(d.root.style.background).toBe(colors.slate)
  })
})
