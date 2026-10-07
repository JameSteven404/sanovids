// 0.6.0 hides Bảng cảnh and Storyboard: only the canvas is shown (core/shownViews). A stored pref of a hidden view
// falls back to the canvas without touching it, setView refuses hidden ids, no live file imports the frozen
// components/views folder (so it is not bundled), and no user-facing text still sends people to those views.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_VIEWS, isShownView, SHOWN_VIEW_LIST, SHOWN_VIEWS } from '../core/shownViews'
import { parsePref, VIEW_MODES } from '../store/ui'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VIEWS_DIR = join(SRC, 'components', 'views')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')

/**
 * Source without comments (line and block), so a note about the old views never counts as UI text; `literals`
 * collects the contents of the string / template literals met on the way.
 */
function stripComments(code: string, literals: string[] = []): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  let literal = ''
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (quote) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        literal += next ?? ''
        i += 2
        continue
      }
      if (c === quote) {
        quote = null
        literals.push(literal)
      } else literal += c
      i++
      continue
    }
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end < 0 ? code.length : end + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      literal = ''
    }
    out += c
    i++
  }
  return out
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

/** Every module specifier a file imports (static, dynamic, re-export). */
function specifiers(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)) out.push(m[2])
  return out
}

describe('which views are shown', () => {
  it('only the canvas', () => {
    expect(SHOWN_VIEWS).toEqual(['canvas'])
    expect(SHOWN_VIEW_LIST.map((v) => v.id)).toEqual(['canvas'])
    expect(isShownView('canvas')).toBe(true)
    for (const v of ['table', 'storyboard', '', null, undefined, 42, {}, ['canvas']]) expect(isShownView(v), String(v)).toBe(false)
  })
  it('view metadata: unique ids, every one a ViewMode; Bảng cảnh has no code any more', () => {
    const ids = ALL_VIEWS.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(VIEW_MODES).toContain(id)
    expect(ids).not.toContain('table')
    expect(existsSync(join(VIEWS_DIR, 'SceneTable.tsx'))).toBe(false)
    expect(existsSync(join(VIEWS_DIR, 'StoryboardPlayer.tsx'))).toBe(false)
  })
  it('a stored hidden view (or garbage) reads as the canvas', () => {
    for (const raw of ['"storyboard"', '"table"', 'garbage', '42', null, undefined]) expect(parsePref(raw, 'canvas', isShownView), String(raw)).toBe('canvas')
    expect(parsePref('"canvas"', 'canvas', isShownView)).toBe('canvas')
  })
})

describe('the UI store with a view saved by 0.5.0', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function freshStore(saved: Record<string, string>) {
    const data = new Map(Object.entries(saved))
    const writes: [string, string][] = []
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes.push([k, v])
        data.set(k, v)
      },
      removeItem: (k: string) => data.delete(k),
    })
    vi.resetModules()
    const { useUI } = await import('../store/ui')
    return { useUI, data, writes }
  }

  it('opens the canvas and leaves the stored value alone (a later version may show that view again)', async () => {
    for (const saved of ['"storyboard"', '"table"']) {
      const { useUI, data, writes } = await freshStore({ 'bdp:pref:view': saved })
      expect(useUI.getState().view).toBe('canvas')
      expect(writes).toEqual([])
      expect(data.get('bdp:pref:view')).toBe(saved)
    }
  })

  it('setView ignores hidden ids (nothing stored), the canvas still works', async () => {
    const { useUI, writes } = await freshStore({})
    useUI.getState().setView('table')
    useUI.getState().setView('storyboard')
    expect(useUI.getState().view).toBe('canvas')
    expect(writes).toEqual([])
    useUI.getState().setView('canvas')
    expect(writes).toEqual([['bdp:pref:view', '"canvas"']])
  })
})

describe('source guards', () => {
  it('no live file imports from components/views (the hidden Storyboard is frozen and not bundled)', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      if (file.startsWith(VIEWS_DIR + sep)) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const spec of specifiers(code)) {
        const target = spec.startsWith('.') ? resolve(dirname(file), spec) : spec
        if (target.startsWith(VIEWS_DIR) || /components\/views(\/|$)/.test(spec)) offenders.push(`${relative(SRC, file)} → ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('App loads no view lazily; "Phát liền" is its own dialog chunk', () => {
    const app = stripComments(read('App.tsx'))
    expect(app).not.toContain('components/views')
    expect(app).not.toMatch(/\b(SceneTable|Storyboard)\b/)
    expect(app).toContain("import('./components/player/FilmPlayerDialog')")
    expect(app).toMatch(/case 'player':\s*return <FilmPlayerDialog start=\{dialog\.start\} \/>/)
    // The canvas never unmounts: no key on its boundary that would change with ui.view.
    expect(app).not.toMatch(/SectionBoundary key=\{view\}/)
  })

  it('no key switches to a hidden view', () => {
    const keys = stripComments(read('hooks/useShortcuts.ts'))
    expect(keys).not.toMatch(/setView\(\s*'(table|storyboard)'/)
    expect(keys).not.toMatch(/case '[123]'/)
  })

  it('no user-facing text names Bảng cảnh or Storyboard (string literals, JSX text)', () => {
    const files = [
      'components/dialogs/ShortcutsDialog.tsx',
      'components/dialogs/SettingsDialog.tsx',
      'components/runs/TakeViewer.tsx',
      'components/sidebar/AssetLibrary.tsx',
      'components/sidebar/PresetsPanel.tsx',
      'components/topbar/TopBar.tsx',
      'components/player/FilmPlayer.tsx',
      'components/player/FilmPlayerDialog.tsx',
      'components/inspector/SceneOrderControl.tsx',
      'filmActions.ts',
      'sceneOrderActions.ts',
    ]
    for (const rel of files) {
      const literals: string[] = []
      const code = stripComments(read(rel), literals)
      // No identifier spells Vietnamese, and UI text writes "Storyboard" capitalised (JSX text included); a lower-case
      // `storyboard` identifier (the ViewMode key of an icon map) is code, not text.
      expect(code, rel).not.toMatch(/bảng cảnh/i)
      expect(code, rel).not.toMatch(/\bStoryboard\b/)
      expect(literals.filter((t) => /storyboard|bảng cảnh/i.test(t)), rel).toEqual([])
    }
  })

  it('"Phát liền" keeps its look outside the hidden view: own CSS, own media tokens, all three motion levels', () => {
    const css = read('components/player/player.css')
    const player = read('components/player/FilmPlayer.tsx')
    const views = read('components/views/views.css')
    const app = read('styles/app.css')
    expect(player).toContain("import './player.css'")
    // The dark stage tokens live on the player itself (they used to come from .vw-root of the hidden views).
    const root = css.match(/\n\.vw-player \{([^}]*)\}/)?.[1] ?? ''
    for (const token of ['--vw-on-media', '--vw-on-media-dim', '--vw-on-media-faint', '--vw-media-chip', '--vw-media-bg', '--vw-media-btn', '--vw-media-btn-hover'])
      expect(root, token).toContain(`${token}:`)
    expect(css).not.toMatch(/\.vw-(root|sb-root)\b/)
    expect(views).not.toMatch(/\.vw-player|\.vw-seg\b/)
    // Its own spinner (.vw-spin stays with the hidden views).
    expect(player).toContain('vw-player-spin')
    expect(player).not.toMatch(/['" ]vw-spin['" ]/)
    expect(css).toMatch(/@keyframes vw-player-spin/)
    // OS reduce-motion: no fade-in, no transitions, slower spinner.
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.vw-player,\s*\.vw-player-end \{\s*animation: none;/)
    expect(reduced).toMatch(/\.vw-player-pp,\s*\.vw-seg \{\s*transition: none;/)
    // "Giảm bớt" / "Tắt" (<html data-motion>): app.css limits / drops every transition and animation app-wide, the
    // player only adds its scale.
    expect(app).toMatch(/:root\[data-motion='off'\] \*,[\s\S]*?animation-duration: 0\.01ms !important;/)
    expect(app).toMatch(/:root\[data-motion='reduced'\] \*,[\s\S]*?transition-property: opacity/)
    expect(css).toMatch(/:root\[data-motion='reduced'\] \.vw-player-pp:active,\s*:root\[data-motion='off'\] \.vw-player-pp:active \{\s*transform: none;/)
  })

  it('the player names what plays in its top bar, never over the picture', () => {
    const player = read('components/player/FilmPlayer.tsx')
    const top = player.slice(player.indexOf('<div className="vw-player-top">'), player.indexOf('<div className="vw-player-stage">'))
    const stage = player.slice(player.indexOf('<div className="vw-player-stage">'), player.indexOf('<div className="vw-player-controls">'))
    expect(top).toContain('className="vw-player-caption"')
    expect(top).toContain('className="vw-player-code"')
    expect(stage).not.toContain('vw-player-caption')
    expect(read('components/player/player.css')).not.toMatch(/\.vw-player-caption \{[^}]*position: absolute/)
  })

  it('the top bar keeps its centre cell (3-column grid) and renders the view switch only for 2+ shown views', () => {
    const bar = read('components/topbar/TopBar.tsx')
    expect(bar).toContain('className="tb-center"')
    expect(bar).toMatch(/SHOWN_VIEW_LIST\.length > 1 && <ViewSwitch \/>/)
  })
})
