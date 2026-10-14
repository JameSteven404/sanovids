import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MODELS } from '../../../core/models'

type Triple = [number, number, number]
type Tokens = Record<string, string>
type Theme = 'dark' | 'light'
interface Rule { selector: string; tokens: Tokens }

function parseRules(source: string): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(), tokens: Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()])),
  }))
}

/**
 * What one `:root…` selector means: the themes it applies to (no data-theme = dark, the default), its `data-bg`
 * surface variant (null = every surface) and its specificity. Read from the meaning, never from a substring: design D
 * writes its dark-only surfaces as `:root[data-bg='deep']:not([data-theme='light'])`. null = not a `:root` rule; a
 * `:root` rule this cannot read throws instead of being silently dropped.
 */
function rootScope(part: string): { themes: Theme[]; bg: string | null; specificity: number } | null {
  if (!part.startsWith(':root')) return null
  let rest = part.slice(':root'.length)
  let themes: Theme[] = ['dark', 'light']
  let bg: string | null = null
  let specificity = 1
  while (rest) {
    const match = /^(:not\()?\[data-(theme|bg)=(['"]?)([\w-]+)\3\](\))?/.exec(rest)
    if (!match || !match[1] !== !match[5] || (match[2] === 'theme' && match[4] !== 'dark' && match[4] !== 'light')
      || (match[2] === 'bg' && match[1])) throw new Error(`Unsupported :root selector: ${part}`)
    const [, not, name, , value] = match
    if (name === 'theme') themes = themes.filter(theme => not ? theme !== value : theme === value)
    else bg = value
    specificity++
    rest = rest.slice(match[0].length)
  }
  return { themes, bg, specificity }
}

/** The theme's tokens and one merged token set per `data-bg` variant, in cascade order (specificity, then source). */
function themeTokens(rules: readonly Rule[], theme: Theme): { base: Tokens; variants: { bg: string; tokens: Tokens }[] } {
  const applied = rules.flatMap((rule, order) => {
    if (!Object.keys(rule.tokens).length) return []
    const scopes = rule.selector.split(',').map(part => rootScope(part.trim())).filter(scope => scope?.themes.includes(theme))
    // One entry per surface the rule reaches, with the specificity of its best-matching selector.
    return [...new Set(scopes.map(scope => scope!.bg))].map(bg => ({
      bg, order, tokens: rule.tokens, specificity: Math.max(...scopes.filter(scope => scope!.bg === bg).map(scope => scope!.specificity)),
    }))
  })
  const merge = (bg: string | null) => Object.assign({}, ...applied.filter(entry => entry.bg === null || entry.bg === bg)
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order).map(entry => entry.tokens)) as Tokens
  const bgs = [...new Set(applied.flatMap(entry => entry.bg === null ? [] : [entry.bg]))]
  return { base: merge(null), variants: bgs.map(bg => ({ bg, tokens: merge(bg) })) }
}

const rules = parseRules(readFileSync(new URL('../../../styles/base.css', import.meta.url), 'utf8'))
const providerNames = ['--provider-canvasapp', '--provider-seedvis']
const softNames = providerNames.map(name => `${name}-soft`)
const linear = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const srgb = (c: number) => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0)

// Resolve the repo's hex / rgb(a) tokens and aliases. Unsupported syntax fails instead of silently skipping a colour.
function color(value: string, tokens: Tokens, background: Triple = [1, 1, 1], seen = new Set<string>()): Triple {
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  if (alias) {
    if (seen.has(alias[1]) || !tokens[alias[1]]) throw new Error(`Missing/cyclic token ${alias[1]}`)
    return color(tokens[alias[1]], tokens, background, new Set([...seen, alias[1]]))
  }
  if (/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value)) {
    const hex = value.length === 4 ? [...value.slice(1)].map(c => c + c).join('') : value.slice(1)
    return [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255) as Triple
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value)
  if (!rgba) throw new Error(`Unsupported colour: ${value}`)
  const parts = rgba[1].split(/[\s,/]+/).map(Number)
  const alpha = parts[3] ?? 1
  return parts.slice(0, 3).map((c, index) => c / 255 * alpha + background[index] * (1 - alpha)) as Triple
}

function lab(rgb: Triple): Triple {
  const values = rgb.map(linear)
  const f = (t: number) => t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29
  const x = f(dot(values, [0.4124564, 0.3575761, 0.1804375]) / 0.95047)
  const y = f(dot(values, [0.2126729, 0.7151522, 0.0721750]))
  const z = f(dot(values, [0.0193339, 0.1191920, 0.9503041]) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

// CIEDE2000; adapted from the plan's local r3-cvd4.cjs, with unrounded RGB and checked against reference Lab pairs.
function deltaE([l1, a1, b1]: Triple, [l2, a2, b2]: Triple): number {
  const rad = Math.PI / 180
  const meanC = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const g = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)))
  const ap1 = (1 + g) * a1, ap2 = (1 + g) * a2
  const c1 = Math.hypot(ap1, b1), c2 = Math.hypot(ap2, b2)
  const h1 = (Math.atan2(b1, ap1) / rad + 360) % 360, h2 = (Math.atan2(b2, ap2) / rad + 360) % 360
  let dh = h2 - h1
  if (c1 * c2 === 0) dh = 0
  else if (dh > 180) dh -= 360
  else if (dh < -180) dh += 360
  let meanH = h1 + h2
  if (c1 * c2 !== 0) {
    if (Math.abs(h1 - h2) > 180) meanH += meanH < 360 ? 360 : -360
    meanH /= 2
  }
  const meanL = (l1 + l2) / 2, meanCp = (c1 + c2) / 2
  const t = 1 - 0.17 * Math.cos((meanH - 30) * rad) + 0.24 * Math.cos(2 * meanH * rad)
    + 0.32 * Math.cos((3 * meanH + 6) * rad) - 0.20 * Math.cos((4 * meanH - 63) * rad)
  const sl = 1 + 0.015 * (meanL - 50) ** 2 / Math.sqrt(20 + (meanL - 50) ** 2)
  const sc = 1 + 0.045 * meanCp, sh = 1 + 0.015 * meanCp * t
  const rt = -2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7))
    * Math.sin(60 * Math.exp(-(((meanH - 275) / 25) ** 2)) * rad)
  const dl = (l2 - l1) / sl, dc = (c2 - c1) / sc, dH = 2 * Math.sqrt(c1 * c2) * Math.sin(dh * rad / 2) / sh
  return Math.sqrt(dl ** 2 + dc ** 2 + dH ** 2 + rt * dc * dH)
}

// Machado 2009, severity 1.0, applied to linear RGB (deuteranopia and protanopia).
const matrices = [
  [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
]
const simulate = (rgb: Triple, matrix: number[][]) => matrix.map(row => srgb(Math.max(0, Math.min(1, dot(row, rgb.map(linear)))))) as Triple
const distance = (a: Triple, b: Triple) => deltaE(lab(a), lab(b))
const luminance = (rgb: Triple) => dot(rgb.map(linear), [0.2126, 0.7152, 0.0722])
const contrast = (a: Triple, b: Triple) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
/** Surfaces a provider tag sits on: window, fields (the picker trigger), panels. */
const SURFACES = ['--bg', '--bg-elev', '--panel', '--panel-2']

describe('provider colour measurement', () => {
  it('checks CIEDE2000 reference pairs, contrast and linear-RGB simulation before testing tokens', () => {
    expect(deltaE([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4)
    expect(deltaE([50, 3.1571, -77.2803], [50, 0, -82.7485])).toBeCloseTo(2.8615, 4)
    expect(deltaE([50, 0, 0], [50, 0, 0])).toBe(0)
    expect(contrast([0, 0, 0], [1, 1, 1])).toBe(21)
    expect(simulate([1, 0, 0], matrices[0])[0]).toBeCloseTo(srgb(0.367322), 8)
    expect(color('rgba(0, 0, 0, 0.5)', {})).toEqual([0.5, 0.5, 0.5])
  })

  it("picks each theme's tokens and data-bg variants from what the selectors mean (design D's dark-only surfaces)", () => {
    const fixture = parseRules(`
      :root, :root[data-theme='dark'] { --bg: #111111; --ink: #222222; }
      :root[data-theme='light'] { --bg: #eeeeee; --ink: #333333; }
      /* a later plain :root must not beat the light block (lower specificity) */
      :root { --ink: var(--bg); --media: #000000; }
      :root[data-bg='deep']:not([data-theme='light']) { --bg: #000000; }
      :root[data-bg="slate"]:not([data-theme='light']) { --bg: #101820; }
      :root:not([data-theme='dark']) { --paper: #ffffff; }
      :root[data-bg='paper'][data-theme='light'] { --bg: #fafafa; }
      .btn { --bg: #ff0000; }
    `)
    const dark = themeTokens(fixture, 'dark'), light = themeTokens(fixture, 'light')
    expect(dark.base).toEqual({ '--bg': '#111111', '--ink': '#222222', '--media': '#000000' })
    expect(dark.variants.map(variant => [variant.bg, variant.tokens['--bg'], variant.tokens['--ink']])).toEqual([
      ['deep', '#000000', '#222222'], ['slate', '#101820', '#222222'],
    ])
    expect(light.base).toEqual({ '--bg': '#eeeeee', '--ink': '#333333', '--media': '#000000', '--paper': '#ffffff' })
    expect(light.variants.map(variant => [variant.bg, variant.tokens['--bg']])).toEqual([['paper', '#fafafa']])
    expect(() => themeTokens(parseRules(":root[data-motion='off'] { --x: #000000; }"), 'dark')).toThrow('Unsupported :root selector')
    expect(() => themeTokens(parseRules(":root:not([data-bg='deep']) { --x: #000000; }"), 'dark')).toThrow('Unsupported :root selector')
    expect(themeTokens(parseRules(":root[data-motion='off'] .x { animation: none; }"), 'dark').base).toEqual({})
  })

  for (const theme of ['dark', 'light'] as const) {
    describe(theme, () => {
      const { base: tokens, variants } = themeTokens(rules, theme)
      const surfaces = [{ bg: theme, tokens }, ...variants]
      // Each check waits only for the tokens it needs (H3 adds them): the provider colours are measured as soon as
      // they exist, even before the soft fills do.
      const mainMissing = providerNames.filter(name => !tokens[name])
      const softMissing = [...mainMissing, ...softNames.filter(name => !tokens[name])]
      const waiting = (missing: string[], title: string) => missing.length
        ? `${title} — chờ Claude thêm token provider vào base.css (H3): ${missing.join(', ')}. Chưa xác minh màu/CVD.`
        : title
      const main = mainMissing.length ? it.skip : it
      const soft = softMissing.length ? it.skip : it

      main(waiting(mainMissing, 'separates providers in normal vision and CVD'), () => {
        const [a, b] = providerNames.map(name => color(tokens[name], tokens))
        expect(distance(a, b)).toBeGreaterThanOrEqual(40)
        for (const matrix of matrices) expect(distance(simulate(a, matrix), simulate(b, matrix))).toBeGreaterThanOrEqual(15)
      })
      main(waiting(mainMissing, 'keeps text contrast >= 4.5 on every surface of every data-bg variant'), () => {
        for (const surface of surfaces) for (const name of SURFACES) {
          const background = color(surface.tokens[name], surface.tokens)
          for (const provider of providerNames) {
            const foreground = color(surface.tokens[provider], surface.tokens, background)
            expect(contrast(foreground, background), `${provider} on ${name} (${surface.bg})`).toBeGreaterThanOrEqual(4.5)
          }
        }
      })
      // Tags actually paint their soft fill, so check it too.
      soft(waiting(softMissing, 'keeps text contrast >= 4.5 on its own soft fill on every surface'), () => {
        for (const surface of surfaces) for (const name of SURFACES) {
          const background = color(surface.tokens[name], surface.tokens)
          for (const provider of providerNames) {
            const fill = color(surface.tokens[`${provider}-soft`], surface.tokens, background)
            const foreground = color(surface.tokens[provider], surface.tokens, fill)
            expect(contrast(foreground, fill), `${provider} on its soft fill over ${name} (${surface.bg})`).toBeGreaterThanOrEqual(4.5)
          }
        }
      })
      main(waiting(mainMissing, 'separates chromatic tokens and model dots, including summary neighbours'), () => {
        const neighbours = new Set(['--accent', '--danger', ...Object.keys(tokens).filter(name => /model.*(?:dot|color)|(?:veo|seedance|minimax)/.test(name))])
        const names = ['--accent', '--accent-strong', '--accent-ink', '--ref', '--ref-ink', '--video', '--video-ink', '--save', '--info', '--first', '--ok', '--warn', '--danger', '--danger-text', '--selection', '--brand-plate-top', '--brand-plate-bottom', '--text-dim', ...neighbours]
        const panel = color(tokens['--panel'], tokens)
        const comparison = [...new Set(names)].filter(name => tokens[name]).map(name => ({ name, rgb: color(tokens[name], tokens, panel), neighbour: neighbours.has(name) }))
        comparison.push(...Object.values(MODELS).map(model => ({ name: model.id, rgb: color(model.color, tokens), neighbour: true })))
        for (const provider of providerNames) for (const entry of comparison) {
          const threshold = entry.neighbour ? 20 : theme === 'dark' ? 20 : 15
          expect(distance(color(tokens[provider], tokens), entry.rgb), `${provider} vs ${entry.name}`).toBeGreaterThanOrEqual(threshold)
        }
      })
    })
  }
})
