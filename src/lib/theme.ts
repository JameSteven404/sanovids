// Light / dark appearance (Apple-style: "Sáng", "Tối", "Theo hệ thống") and the dark background ("Màu nền": Than /
// Đen sâu / Xám xanh, device pref bdp:pref:background, ignored by the light theme).
// The resolved theme lives on <html data-theme="light|dark">, the background on <html data-bg>, so the CSS tokens in
// styles/base.css switch instantly. index.html applies both saved choices before React mounts (no flash).
import { create } from 'zustand'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'
export type BackgroundPref = 'than' | 'deep' | 'slate'

export const THEME_KEY = 'bdp:pref:theme'
export const BACKGROUND_KEY = 'bdp:pref:background'
export const BACKGROUND_PREFS: readonly BackgroundPref[] = ['than', 'deep', 'slate']
export const BACKGROUND_LABEL: Record<BackgroundPref, string> = { than: 'Than', deep: 'Đen sâu', slate: 'Xám xanh' }
/** The window colour of each background (= base.css --bg of that variant; index.html paints it before the CSS loads). */
export const BACKGROUND_COLOR: Record<BackgroundPref, string> = { than: '#161618', deep: '#0c0c0d', slate: '#14171c' }
/** The light theme's window colour (base.css --bg); the background choice does not apply to it. */
export const LIGHT_COLOR = '#f5f5f7'

/** Window colour for the browser / OS chrome (meta theme-color). */
export function themeColor(theme: Theme, background: BackgroundPref): string {
  return theme === 'dark' ? BACKGROUND_COLOR[background] : LIGHT_COLOR
}
const KEY = THEME_KEY
export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark']

export const isThemePref = (v: unknown): v is ThemePref => v === 'light' || v === 'dark' || v === 'system'
export const isBackgroundPref = (v: unknown): v is BackgroundPref => v === 'than' || v === 'deep' || v === 'slate'

export function parseBackgroundPref(raw: string | null | undefined): BackgroundPref {
  try {
    const v: unknown = JSON.parse(raw ?? '"than"')
    return isBackgroundPref(v) ? v : 'than'
  } catch {
    return 'than'
  }
}

function readBackground(): BackgroundPref {
  try {
    return parseBackgroundPref(localStorage.getItem(BACKGROUND_KEY))
  } catch {
    return 'than'
  }
}

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

function apply(theme: Theme, background: BackgroundPref) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = theme
  root.dataset.bg = background
  root.style.colorScheme = theme
  // The page colour itself comes from the CSS tokens (body: var(--bg), :root[data-bg]); the inline <html> background
  // index.html paints before the CSS loads is removed by main.tsx once the stylesheets are in.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor(theme, background))
}

interface ThemeState {
  pref: ThemePref
  theme: Theme
  background: BackgroundPref
  setBackground: (background: BackgroundPref) => void
  setPref: (pref: ThemePref) => void
  /** Cycle Hệ thống → Sáng → Tối (for a single toolbar button). */
  cycle: () => void
}

export const useTheme = create<ThemeState>()((set, get) => {
  const pref = readPref()
  return {
    pref,
    theme: resolve(pref),
    background: readBackground(),
    setBackground: (background) => {
      if (!isBackgroundPref(background)) return
      try {
        localStorage.setItem(BACKGROUND_KEY, JSON.stringify(background))
      } catch {
        /* storage unavailable */
      }
      apply(get().theme, background)
      set({ background })
    },
    setPref: (next) => {
      if (!isThemePref(next)) return
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* storage unavailable */
      }
      const theme = resolve(next)
      apply(theme, get().background)
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
  const { theme, background } = useTheme.getState()
  apply(theme, background)
  media?.addEventListener?.('change', () => {
    const { pref, background } = useTheme.getState()
    if (pref !== 'system') return
    const theme = resolve('system')
    apply(theme, background)
    useTheme.setState({ theme })
  })
}

export const THEME_LABEL: Record<ThemePref, string> = { system: 'Theo hệ thống', light: 'Sáng', dark: 'Tối' }
