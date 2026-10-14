// Accessibility pass (0.6.0, track A11Y) — what a bigger hit area or a motion / ARIA rule must NOT do. Each case is a
// review finding: an invisible hit area that took presses from the picture / the ★ / the take above, a blanket
// reduced-motion rule that froze the nodes but not the rest of the app, aria-pressed on a button whose name already
// flips with the state, and a focus ring that covered the rename text. The DOM is not available here: the structure is
// read from the sources, like takeNodeLayout.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TAKE_BAR_H } from '../canvasModel'
import { TITLE_LINE_GAP, TITLE_LINE_H } from '../takeNodeModel'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const takeCss = read('../takeNode.css')
const sceneCss = read('../sceneNode.css')
const canvasCss = read('../canvas.css')
const nodeEditor = read('../SceneNodeEditor.tsx')
const panelEditor = read('../../inspector/PromptEditor.tsx')
const film = read('../../player/FilmPlayer.tsx')
const library = read('../../sidebar/AssetLibrary.tsx')

interface Rule {
  selectors: string[]
  decls: Record<string, string>
  /** the enclosing at-rule preludes (`@media (hover: none)`), outermost first */
  at: string[]
}
/** Every style rule, also the ones inside @media / @container / @supports (comments dropped). */
function rules(css: string, at: string[] = []): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Rule[] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open < 0) break
    const prelude = src.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    for (; j < src.length && depth; j++) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0
    const body = src.slice(open + 1, j - 1)
    if (prelude.startsWith('@keyframes')) {
      // frames are not rules
    } else if (prelude.startsWith('@')) out.push(...rules(body, [...at, prelude]))
    else {
      const decls: Record<string, string> = {}
      for (const d of body.split(';')) {
        const c = d.indexOf(':')
        if (c > 0) decls[d.slice(0, c).trim()] = d.slice(c + 1).trim().replace(/\s+/g, ' ')
      }
      out.push({ selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decls, at })
    }
    i = j
  }
  return out
}
/** The rules whose selector list holds a selector matching `test`. */
const where = (css: string, test: (sel: string) => boolean) => rules(css).filter((r) => r.selectors.some(test))
const px = (v: string | undefined) => (v === undefined ? undefined : /^(-?\d+(?:\.\d+)?)px$/.exec(v)?.[1] ?? (v === '0' ? '0' : NaN))
const num = (v: string | undefined) => (v === undefined ? undefined : Number(px(v)))

describe('player scrub track: inside the bar, never over the picture', () => {
  // On the picture a press drags / selects the node and a double-click opens the viewer; in fullscreen a click
  // toggles play / pause. The player root is nodrag and takes presses, so the track must not reach up there.
  it('normal bar: the track is the bar’s top 8px (TAKE_BAR_H = 8px track + 22px row)', () => {
    const [base] = where(takeCss, (s) => s === '.cv-tp-track')
    expect(num(base.decls.top)).toBe(0)
    expect(num(base.decls.height)).toBe(8)
    expect(num(where(takeCss, (s) => s === '.cv-tp-row')[0].decls.top)).toBe(8)
    expect(8 + 22).toBe(TAKE_BAR_H)
  })
  it('no rule (fullscreen, hover, pinned, scrubbing…) moves the track above the bar or makes it taller than its strip', () => {
    for (const r of where(takeCss, (s) => /\.cv-tp-track$/.test(s))) {
      if (r.decls.top !== undefined) expect(num(r.decls.top), r.selectors.join()).toBeGreaterThanOrEqual(0)
      if (r.decls.bottom !== undefined) expect(num(r.decls.bottom), r.selectors.join()).toBeGreaterThanOrEqual(0)
      if (r.decls.inset !== undefined) expect(r.decls.inset, r.selectors.join()).not.toMatch(/-\d/)
      if (r.decls.transform !== undefined) expect(r.decls.transform, r.selectors.join()).toBe('none')
    }
    const [full] = where(takeCss, (s) => s === '.cv-take-stage:fullscreen .cv-tp-track')
    expect(num(full.decls.height)).toBe(12)
    expect(num(where(takeCss, (s) => s === '.cv-take-stage:fullscreen .cv-tp-row')[0].decls.top)).toBe(12)
    // the rail and the knob sit in the middle of the strip again
    expect(where(takeCss, (s) => s === '.cv-tp-rail')[0].decls.top).toBe('50%')
    expect(where(takeCss, (s) => s === '.cv-tp-knob > i')[0].decls.top).toBe('50%')
  })
})

describe('take title line: ★ and "+N" hit areas', () => {
  // y from the card's outer top: the line is −17 … −4. An old project's 248px rows leave ~19px under the take above.
  const free = TITLE_LINE_H + TITLE_LINE_GAP + 2
  const [area] = where(takeCss, (s) => s === '.cv-take-star::before')
  it('reach the card’s top edge, never into the card, and never into the take above', () => {
    expect(area.selectors).toContain('.cv-take-label .cv-take-more::before')
    const height = num(area.decls.height)!
    // ★ has no border: its ::before is placed from its border box (bottom at −TITLE_LINE_GAP)
    expect(num(area.decls.bottom)).toBe(-TITLE_LINE_GAP)
    expect(height).toBeLessThanOrEqual(free)
    // "+N" has a 1px border: one more pixel down from its padding box lands on the same edge
    const more = where(takeCss, (s) => s === '.cv-take-label .cv-take-more::before').filter((r) => r.decls.bottom !== undefined)
    expect(num(more[more.length - 1].decls.bottom)).toBe(-(TITLE_LINE_GAP + 1))
    expect(where(takeCss, (s) => s === '.cv-take-label .cv-take-more')[0].decls.border).toMatch(/^1px /)
    // no other rule makes them taller or moves them
    for (const r of where(takeCss, (s) => /\.cv-take-(star|more)::before$/.test(s))) {
      const what = r.selectors.join(', ')
      for (const p of ['top', 'inset', 'margin-top', 'margin-bottom']) expect(r.decls[p], `${what} ${p}`).toBeUndefined()
      if (r.decls.height !== undefined) expect(num(r.decls.height), what).toBeLessThanOrEqual(free)
      if (r.decls.transform !== undefined) expect(r.decls.transform, what).toBe('translateX(-50%)')
    }
  })
  it('the resize corner’s grab area stays clear of the ★ (16px: −5px around the 6px inside)', () => {
    const [grab] = where(canvasCss, (s) => s === '.cv-stage .react-flow__resize-control.handle.cv-rs-handle::before')
    expect(grab.decls.inset).toBe('-5px')
    // the title line keeps its 9px from the left corner
    expect(where(takeCss, (s) => s === '.cv-take-label')[0].decls.left).toBe('9px')
  })
})

describe('scene node: the unlink badge (×) on a reference picture', () => {
  it('its hit area is the 14px badge itself: no ::before spreading "unlink" over the picture (whose click opens the viewer)', () => {
    expect(where(sceneCss, (s) => /\.cv-sn-th-x::(before|after)$/.test(s))).toEqual([])
    const [badge] = where(sceneCss, (s) => s === '.cv-sn-th-x')
    expect(badge.decls.width).toBe('14px')
    expect(badge.decls.height).toBe('14px')
    expect(badge.decls.padding).toBe('0')
  })
  it('clickable only while the picture is hovered or the badge has focus: never always-on (a touch tap would unlink)', () => {
    const [base] = where(sceneCss, (s) => s === '.cv-sn-th-x')
    expect(base.decls['pointer-events']).toBe('none')
    expect(base.decls.opacity).toBe('0')
    const shown = where(sceneCss, (s) => /\.cv-sn-th-x$/.test(s)).filter((r) => r.decls['pointer-events'] === 'auto' || r.decls.opacity === '1')
    expect(shown.length).toBeGreaterThan(0)
    for (const r of shown) {
      expect(r.at, r.selectors.join(', ')).toEqual([])
      for (const s of r.selectors) expect(s).toMatch(/^\.cv-sn-th:(hover|focus-within) \.cv-sn-th-x$/)
    }
  })
  it('the red-text chips keep their 24px hit area on the node’s strip (.cv-sn-strip, the r2 class), not on the empty-prompt hint', () => {
    const [chip] = where(sceneCss, (s) => s === '.cv-sn-strip .in-ph-chip::before')
    expect(chip.decls.height).toBe('24px')
    expect(where(sceneCss, (s) => s === '.cv-sn-strip .in-ph-chip')[0].decls.position).toBe('relative')
    expect(sceneCss).not.toContain('.cv-sn-ph .in-ph-chip')
  })
})

describe('reduced motion in the nodes follows the app (data-motion), no blanket freeze', () => {
  // initMotion maps the OS setting to data-motion='reduced', where fades / color changes stay and spinners turn
  // (styles/app.css): the running take's spinner and the queue must behave the same.
  it('no rule switches every animation / transition off inside a node', () => {
    for (const [name, css] of [['sceneNode.css', sceneCss], ['takeNode.css', takeCss]] as const) {
      for (const r of rules(css)) {
        const blanket = r.selectors.some((s) => /(^|\s)\*(::?(before|after))?$/.test(s))
        expect(blanket && ('animation' in r.decls || 'transition' in r.decls), `${name}: ${r.selectors.join(', ')}`).toBe(false)
        for (const p of ['animation', 'transition']) expect(r.decls[p] ?? '', `${name}: ${r.selectors.join(', ')}`).not.toContain('!important')
      }
    }
  })
  it('the press "squash" still goes for the OS setting and both app settings', () => {
    for (const sel of ['.cv-sn-run:active:not(.is-blocked)', '.cv-snf-run:active:not(:disabled)']) {
      expect(rules(sceneCss).some((r) => r.at.includes('@media (prefers-reduced-motion: reduce)') && r.selectors.includes(sel) && r.decls.transform === 'none'), sel).toBe(true)
      expect(sceneCss).toContain(`:root:is([data-motion='reduced'], [data-motion='off']) ${sel}`)
    }
    expect(rules(takeCss).some((r) => r.at.includes('@media (prefers-reduced-motion: reduce)') && r.selectors.includes('.cv-take-main:active:not(:disabled)'))).toBe(true)
    expect(takeCss).toContain(":root:is([data-motion='reduced'], [data-motion='off']) .cv-take-main:active:not(:disabled)")
  })
})

describe('take rename input: keyboard focus ring', () => {
  it('stays inside the 15px box as an explicit thin ring (never `inset var(--focus-ring)`: 3px over the text)', () => {
    /** commas outside parentheses = more than one shadow layer */
    const layers = (v: string) => {
      let depth = 0
      let n = 1
      for (const ch of v) {
        if (ch === '(') depth++
        else if (ch === ')') depth--
        else if (ch === ',' && depth === 0) n++
      }
      return n
    }
    for (const r of where(takeCss, (s) => s.startsWith('.cv-take-name-input'))) {
      const shadow = r.decls['box-shadow']
      if (shadow === undefined) continue
      expect(shadow, r.selectors.join()).not.toContain('--focus-ring')
      expect(shadow === 'none' || /^inset 0 0 0 1px /.test(shadow), r.selectors.join()).toBe(true)
      expect(layers(shadow), r.selectors.join()).toBe(1)
    }
    expect(where(takeCss, (s) => s === '.cv-take-name-input:focus-visible')[0].decls['box-shadow']).toBe('inset 0 0 0 1px var(--accent)')
  })
})

describe('ARIA on toggles whose name flips with the state', () => {
  // "The name says the action and changes with the state: no aria-pressed" (FilmPlayer, TakePlayer): a screen reader
  // would say "Thoát toàn màn hình, đã nhấn" / "Bỏ khỏi canvas: Lan, đã nhấn".
  /** The opening tag of the JSX element that holds `marker` (from its `<tag` to the `>` that closes the tag). */
  function openingTag(src: string, marker: string): string {
    const at = src.indexOf(marker)
    expect(at, marker).toBeGreaterThan(0)
    const start = src.lastIndexOf('<', at)
    let depth = 0
    for (let k = start; k < src.length; k++) {
      const ch = src[k]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) return src.slice(start, k + 1)
    }
    throw new Error(`unclosed tag at ${marker}`)
  }
  it('FilmPlayer fullscreen and the library’s place-on-canvas button carry no aria-pressed', () => {
    const fullscreen = openingTag(film, "aria-label={full ? 'Thoát toàn màn hình' : 'Toàn màn hình'}")
    expect(fullscreen).not.toContain('aria-pressed')
    const pin = openingTag(library, "aria-label={`${asset.position ? 'Bỏ khỏi canvas' : 'Đặt lên canvas'}: ${asset.name}`}")
    expect(pin).not.toContain('aria-pressed')
  })
  it('the node’s prompt and the panel’s prompt describe their suggestion list the same way', () => {
    // one pattern for both fields (the red-text track changes both together)
    const popupAttrs = (src: string) => {
      const tag = openingTag(src, '<textarea')
      return [...tag.matchAll(/\baria-(autocomplete|expanded|haspopup|controls|activedescendant)=(\{[^\n]*\}|"[^"]*")/g)].map((m) => `${m[1]}=${m[2]}`)
    }
    const node = popupAttrs(nodeEditor)
    expect(node.length).toBeGreaterThan(0)
    expect(node).toEqual(popupAttrs(panelEditor))
  })
})
