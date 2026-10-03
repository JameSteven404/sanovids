// Top-bar room for the project name: the left cluster gives way by its OWN width (a container query on .tb-left), so
// whatever widens the right cluster (running jobs, the update pill, the credit / provider pills) the wordmark, then the
// save / "Dự án" labels, then the divider go before the name is squeezed to nothing. Window-width breakpoints alone left
// the name with no room at all for some combinations (jobs + update at 1441px). Measured in the browser: with jobs +
// update and a right cluster up to 90px wider than the development-mode one, the name keeps ≥ 85px of text from 1100 to
// 1700px. Also the thumbprint lines of "Cài đặt → Giới thiệu" and of the update dialog never break halfway.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const topbarCss = read('../topbar.css')
const dialogsCss = read('../../dialogs/dialogs.css')

/** `@container tb-left (max-width: Npx) { <selector> { display: none; } }` blocks → [{ px, selector }] in file order. */
function containerRules(css: string): { px: number; selector: string }[] {
  const out: { px: number; selector: string }[] = []
  const re = /@container tb-left \(max-width: (\d+)px\) \{\s*([^{]+?)\s*\{\s*display: none;\s*\}\s*\}/g
  for (let m = re.exec(css); m; m = re.exec(css)) out.push({ px: Number(m[1]), selector: m[2].trim() })
  return out
}

/** Every `@media … { … }` block, braces matched. */
function mediaBlocks(css: string): string[] {
  const out: string[] = []
  for (let at = css.indexOf('@media'); at >= 0; at = css.indexOf('@media', at + 1)) {
    let depth = 0
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) {
        out.push(css.slice(at, i + 1))
        break
      }
    }
  }
  return out
}

describe('top bar: the project name keeps room', () => {
  it('.tb-left is a named inline-size container', () => {
    expect(topbarCss).toMatch(/\.tb-left \{\s*container: tb-left \/ inline-size;\s*\}/)
  })

  it('the left cluster gives way in order: wordmark, then the save / "Dự án" labels, then the divider', () => {
    const rules = containerRules(topbarCss)
    expect(rules.map((r) => r.selector)).toEqual(['.tb-brand-text', '.tb-left .tb-hide-sm', '.tb-left .tb-divider'])
    const [brand, labels, divider] = rules.map((r) => r.px)
    expect(brand).toBeGreaterThan(labels)
    expect(labels).toBeGreaterThan(divider)
    // Each threshold leaves the name about 112px or more next to what is still shown (cluster widths in topbar.css).
    const BRAND = 85.4
    const LOGO = 24
    const DIVIDER = 13
    const SAVE = 60.6
    const SAVE_DOT = 20
    const PROJECTS = 73.4
    const PROJECTS_ICON = 32
    const GAPS = 16
    expect(brand - (BRAND + DIVIDER + SAVE + PROJECTS + GAPS)).toBeGreaterThanOrEqual(112)
    expect(labels - (LOGO + DIVIDER + SAVE + PROJECTS + GAPS)).toBeGreaterThanOrEqual(112)
    expect(divider - (LOGO + DIVIDER + SAVE_DOT + PROJECTS_ICON + GAPS)).toBeGreaterThanOrEqual(110)
  })

  it('no window-width rule hides the wordmark or the left labels any more (the container decides)', () => {
    const media = mediaBlocks(topbarCss)
    expect(media.length).toBeGreaterThan(4)
    for (const block of media) {
      if (block.startsWith('@media (max-width: 1120px)')) continue // the global compact form keeps hiding everything
      expect(block).not.toMatch(/\.tb-brand-text\s*\{/)
      expect(block).not.toMatch(/\.tb-left \.tb-hide-sm/)
    }
  })

  it('a running job, an update or a provider problem hides the view-switch labels below 1240px', () => {
    expect(topbarCss).toMatch(/@media \(max-width: 1240px\) \{\s*\.tb:has\(\.tb-running, \.tb-update, \.tb-provider\) \.tb-seg-label \{\s*display: none;/)
  })
})

describe('thumbprints never break halfway', () => {
  it('Giới thiệu and the update dialog show them as atomic inline blocks', () => {
    expect(dialogsCss).toMatch(/\.dg-about-thumb \.mono \{\s*display: inline-block;/)
    expect(dialogsCss).toMatch(/\.dg-upd-callout-code \{\s*display: inline-block;/)
  })
})
