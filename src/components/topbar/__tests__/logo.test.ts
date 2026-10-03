// The top-bar brand mark: the SanoVids "S-wire" Logo (inline SVG, currentColor) inside the orange tile painted with the
// fixed brand tokens of base.css, in place of the old lucide Clapperboard.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Logo } from '../../common/Logo'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const topbarCss = read('../topbar.css')
const topbarTsx = read('../TopBar.tsx')
const baseCss = read('../../../styles/base.css')

const BRAND_TOKENS = ['--brand-plate-top', '--brand-plate-bottom', '--brand-ink'] as const

/** The body of the first rule whose selector list starts exactly with `selector` (text between its braces). */
function ruleBody(css: string, selector: string): { start: number; end: number; body: string } {
  const start = css.indexOf(selector)
  expect(start, `rule ${selector}`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', start)
  const end = css.indexOf('}', open)
  return { start, end, body: css.slice(open + 1, end) }
}

describe('Logo', () => {
  it('is a decorative 24-unit SVG painted with currentColor by default', () => {
    const html = renderToStaticMarkup(createElement(Logo))
    expect(html).toContain('viewBox="0 0 24 24"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('fill="currentColor"')
    expect(html).toContain('width="24"')
    expect(html).toContain('height="24"')
    expect(html).not.toContain('role=')
    expect(html).not.toContain('<title>')
    // one colour only: nothing but currentColor
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('becomes an image with a title when one is given', () => {
    const html = renderToStaticMarkup(createElement(Logo, { size: 40, title: 'SanoVids', className: 'x' }))
    expect(html).toContain('role="img"')
    expect(html).toContain('<title>SanoVids</title>')
    expect(html).not.toContain('aria-hidden')
    expect(html).toContain('width="40"')
    expect(html).toContain('class="x"')
  })
})

describe('top bar brand', () => {
  it('renders the Logo in the tile instead of the lucide Clapperboard', () => {
    expect(topbarTsx).not.toContain('Clapperboard')
    expect(topbarTsx).toContain("import { Logo } from '../common/Logo'")
    expect(topbarTsx).toMatch(/<span className="tb-logo" aria-hidden="true">\s*<Logo size=\{24\} \/>\s*<\/span>/)
  })

  it('paints the tile with the brand tokens only (no hex colours in topbar.css)', () => {
    expect(topbarCss).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    const { body } = ruleBody(topbarCss, '.tb-logo {')
    expect(body).toContain('background: linear-gradient(180deg, var(--brand-plate-top), var(--brand-plate-bottom));')
    expect(body).toContain('color: var(--brand-ink);')
    expect(body).toContain('width: 24px;')
    expect(body).toContain('height: 24px;')
    expect(body).toContain('border-radius: 5.25px;')
    expect(body).toContain('display: inline-flex;')
    expect(body).toContain('flex: none;')
    expect(body).toContain('box-shadow:')
    expect(topbarCss).toContain('.tb-logo svg {\n  display: block;\n}')
    expect(topbarCss).not.toContain('.tb-logo .lucide')
  })

  it('defines each brand token once, in the dark (default) block only', () => {
    const dark = ruleBody(baseCss, ":root,\n:root[data-theme='dark'] {")
    const light = ruleBody(baseCss, ":root[data-theme='light'] {")
    for (const token of BRAND_TOKENS) {
      const decl = new RegExp(`${token}\\s*:`, 'g')
      const hits = [...baseCss.matchAll(decl)]
      expect(hits, token).toHaveLength(1)
      const at = hits[0].index ?? -1
      expect(at > dark.start && at < dark.end, `${token} in the dark block`).toBe(true)
      expect(light.body).not.toContain(token)
    }
    expect(dark.body).toMatch(/--brand-plate-top:\s*#ffb340;/)
    expect(dark.body).toMatch(/--brand-plate-bottom:\s*#ff9f0a;/)
    expect(dark.body).toMatch(/--brand-ink:\s*#1d1206;/)
  })

  it('credits the author in index.html (NFC)', () => {
    const html = read('../../../../index.html')
    const author = 'Nguyễn Giang Minh (Jame Steven)'
    const meta = `<meta name="author" content="${author}" />`
    expect(html.split(meta)).toHaveLength(2)
    expect(html.indexOf(meta)).toBeLessThan(html.indexOf('</head>'))
    expect(author).toBe(author.normalize('NFC'))
    expect(html).toBe(html.normalize('NFC'))
  })
})
