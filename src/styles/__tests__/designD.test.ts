// Design D (base.css tokens + the token-only component ports): the colour rules the redesign must keep.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../../', import.meta.url)
const read = (rel: string) => readFileSync(new URL(rel, SRC), 'utf8').replace(/\r\n/g, '\n')
const base = read('styles/base.css')

/** Declarations of the first rule whose selector is exactly `selector` (`--name` → value). */
function block(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

const DARK = block(base, ":root,\n:root[data-theme='dark']")
const LIGHT = { ...DARK, ...block(base, ":root[data-theme='light']") }
const THEMES: Record<string, Record<string, string>> = {
  than: DARK,
  deep: { ...DARK, ...block(base, ":root[data-bg='deep']:not([data-theme='light'])") },
  slate: { ...DARK, ...block(base, ":root[data-bg='slate']:not([data-theme='light'])") },
  light: LIGHT,
}

function rgb(hex: string): [number, number, number] {
  expect(hex, 'a 6-digit hex colour').toMatch(/^#[0-9a-f]{6}$/i)
  const n = parseInt(hex.slice(1), 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** HSL hue (degrees) and lightness (0–1). */
function hsl(hex: string): { h: number; l: number } {
  const [r, g, b] = rgb(hex).map((c) => c / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: (h * 60 + 360) % 360, l: (max + min) / 2 }
}
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

describe('danger stays red ("chữ đỏ"), apart from the red / coral brand', () => {
  it.each(['than', 'light'])('%s: --danger and --danger-text are red, not pastel pink', (theme) => {
    const t = THEMES[theme]
    for (const token of ['--danger', '--danger-text']) {
      const { h, l } = hsl(t[token])
      // red … crimson (UI text calls the blocking placeholders "chữ đỏ"); the pastel pinks #FFA0BF / #FFB3CD were l ≥ 0.81
      expect(hueGap(h, 355), `${theme} ${token} hue ${h}`).toBeLessThanOrEqual(20)
      expect(l, `${theme} ${token} lightness`).toBeLessThanOrEqual(0.75)
      for (const brand of ['--accent', '--selection']) {
        expect(hueGap(h, hsl(t[brand]).h), `${theme} ${token} vs ${brand}`).toBeGreaterThanOrEqual(15)
      }
    }
  })

  it.each(Object.keys(THEMES))('%s: danger text keeps 4.5:1 on the surfaces and on its own soft fill', (theme) => {
    const t = THEMES[theme]
    for (const surface of ['--bg', '--panel', '--panel-2', '--danger-soft']) {
      expect(contrast(t['--danger-text'], t[surface]), `${theme} --danger-text on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    // the dot / border / 1px outline colour: non-text minimum
    for (const surface of ['--bg', '--panel', '--panel-2']) {
      expect(contrast(t['--danger'], t[surface]), `${theme} --danger on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('the dark soft fill is a dark red, not plum', () => {
    const { h, l } = hsl(DARK['--danger-soft'])
    expect(hueGap(h, 355)).toBeLessThanOrEqual(15)
    expect(l).toBeLessThan(0.25)
  })
})

/** Every CSS file under src/ (component styles + styles/). */
function cssFiles(dir = new URL('./', SRC)): { rel: string; css: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === '__tests__' ? [] : cssFiles(new URL(`${e.name}/`, dir))
    if (!e.name.endsWith('.css')) return []
    const url = new URL(e.name, dir)
    return [{ rel: url.pathname.slice(SRC.pathname.length), css: readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }]
  })
}

describe('white text never sits on a solid tint (the dark tints are light pastels)', () => {
  const TINTS = /^var\(--(accent|accent-strong|ref|video|danger|ok|warn|info|save|first|last|selection|seq)\)$/
  const WHITE = /^(var\(--(on-accent|cv-on-solid|cv-on-media|on-media|brand-ink)\)|white|#fff(fff)?)$/i

  it('no rule paints a solid tint behind --on-accent / white text outside the light theme', () => {
    const bad: string[] = []
    for (const { rel, css } of cssFiles()) {
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = m[1].trim()
        if (selector.startsWith(":root[data-theme='light']")) continue // light tints are deep: white is right there
        const bg = m[2].match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+);/)?.[1].trim()
        const color = m[2].match(/(?:^|;)\s*color\s*:\s*([^;]+);/)?.[1].trim()
        if (bg && color && TINTS.test(bg) && WHITE.test(color)) bad.push(`${rel}: ${selector} (${bg} + ${color})`)
      }
    }
    expect(bad).toEqual([])
  })

  it('the remove × of a scene node picture uses the soft danger chip (like D’s .cv-av-x)', () => {
    const sceneNode = read('components/canvas/sceneNode.css')
    const at = sceneNode.indexOf('.cv-sn-th-x {')
    expect(at).toBeGreaterThanOrEqual(0)
    const body = sceneNode.slice(at, sceneNode.indexOf('}', at))
    expect(body).toContain('background: var(--danger-soft);')
    expect(body).toContain('color: var(--danger-text);')
  })
})

describe('focus rings', () => {
  it('the global :focus-visible outline skips the text fields, which already show --focus-ring', () => {
    expect(base).toMatch(/\.input,\n\.select,\n\.textarea \{[^}]*outline: none;/)
    expect(base).toMatch(/\.input:focus,\n\.select:focus,\n\.textarea:focus \{[^}]*box-shadow: var\(--focus-ring\);/)
    const rule = base.match(/([^{}\n]+):focus-visible \{\n  outline: 2px solid var\(--info\);/)
    expect(rule).not.toBeNull()
    // zero specificity for the exclusion (inside :where), so every component rule still overrides the outline
    expect(rule![1]).toBe(':where(button, a, input, select, textarea, [tabindex]):not(:where(.input, .select, .textarea))')
  })
})

describe('fonts: the first face of each stack ships with the app', () => {
  const main = read('main.tsx')
  it.each([
    ['--font', 'Be Vietnam Pro', '@fontsource/be-vietnam-pro/'],
    ['--font-display', 'Be Vietnam Pro', '@fontsource/be-vietnam-pro/'],
    ['--mono', 'JetBrains Mono', '@fontsource/jetbrains-mono/'],
  ])('%s starts with %s (bundled)', (token, face, pkg) => {
    expect(DARK[token].split(',')[0].trim()).toBe(`'${face}'`)
    expect(main).toContain(`import '${pkg}`)
  })
})

describe('token-only component ports', () => {
  it('a preset of a newer build’s model keeps its warning tint on the neutral model badge', () => {
    const sidebar = read('components/sidebar/sidebar.css')
    const at = sidebar.indexOf('.sb-model.is-foreign {')
    const body = sidebar.slice(at, sidebar.indexOf('}', at))
    expect(body).toContain('background: var(--warn-soft);')
    expect(body).toContain('color: var(--warn);')
    for (const theme of Object.keys(THEMES)) {
      const t = THEMES[theme]
      expect(contrast(t['--warn'], t['--warn-soft']), theme).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('the take handles of a scene / take are the colour of the output wire between them', () => {
    const canvas = read('components/canvas/canvas.css')
    const at = canvas.indexOf('.cv-stage .cv-h-takes,\n.cv-stage .cv-h-take-in {')
    expect(at).toBeGreaterThanOrEqual(0)
    const dot = canvas.slice(at, canvas.indexOf('}', at)).match(/--h-c:\s*([^;]+);/)?.[1]
    const wire = read('components/canvas/edges.tsx').match(/\n\s*out: '([^']+)',/)?.[1]
    expect(wire).toBeTruthy()
    expect(dot).toBe(wire)
  })
})
