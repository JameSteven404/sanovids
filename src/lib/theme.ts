// Light / dark appearance (Apple-style: "Sáng", "Tối", "Theo hệ thống").
// The resolved theme lives on <html data-theme="light|dark"> so CSS tokens in styles/base.css switch instantly.
// index.html applies the saved choice before React mounts (no flash).
import { create } from 'zustand'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

export const THEME_KEY = 'bdp:pref:theme'
const KEY = THEME_KEY
export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark']

export const isThemePref = (v: unknown): v is ThemePref => v === 'light' || v === 'dark' || v === 'system'

/** Stored JSON → theme choice ('system' when missing or not valid). */
export function parseThemePref(raw: string | null | undefined): ThemePref {
  try {
    const v: unknown = JSON.parse(raw ?? '"system"')
    return isThemePref(v) ? v : 'system'
  } catch {
    return 'system'
  }
}

function readPref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(KEY))
  } catch {
    return 'system'
  }
}

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

function resolve(pref: ThemePref): Theme {
  if (pref === 'system') return media?.matches === false ? 'light' : 'dark'
  return pref
}

function apply(theme: Theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#161618' : '#f5f5f7')
}

interface ThemeState {
  pref: ThemePref
  theme: Theme
  setPref: (pref: ThemePref) => void
  /** Cycle Hệ thống → Sáng → Tối (for a single toolbar button). */
  cycle: () => void
}

export const useTheme = create<ThemeState>()((set, get) => {
  const pref = readPref()
  return {
    pref,
    theme: resolve(pref),
    setPref: (next) => {
      if (!isThemePref(next)) return
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* storage unavailable */
      }
      const theme = resolve(next)
      apply(theme)
      set({ pref: next, theme })
    },
    cycle: () => {
      const order: ThemePref[] = ['system', 'light', 'dark']
      get().setPref(order[(order.indexOf(get().pref) + 1) % order.length])
    },
  }
})

/** Call once at startup: applies the theme and follows the OS while the preference is "system". */
export function initTheme() {
  apply(useTheme.getState().theme)
  media?.addEventListener?.('change', () => {
    const { pref } = useTheme.getState()
    if (pref !== 'system') return
    const theme = resolve('system')
    apply(theme)
    useTheme.setState({ theme })
  })
}

export const THEME_LABEL: Record<ThemePref, string> = { system: 'Theo hệ thống', light: 'Sáng', dark: 'Tối' }
