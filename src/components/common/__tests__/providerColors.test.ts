import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MODELS } from '../../../core/models'

type Triple = [number, number, number]
type Tokens = Record<string, string>
const css = readFileSync(new URL('../../../styles/base.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector.trim(), tokens: Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()])),
}))
const providerNames = ['--provider-canvasapp', '--provider-seedvis']
const missing = providerNames.flatMap(name => [name, `${name}-soft`]).filter(name => !rules.some(rule => rule.tokens[name]))
const skipReason = `Chờ Claude thêm token provider vào base.css (H3): ${missing.join(', ')}. Chưa xác minh màu/CVD.`
const tokensFor = (theme: 'dark' | 'light'): Tokens => Object.assign({}, ...rules.filter(rule =>
  rule.selector.split(',').some(selector => selector.trim() === ':root' || selector.trim() === `:root[data-theme='${theme}']`),
).map(rule => rule.tokens))
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

describe('provider colour measurement', () => {
  it('checks CIEDE2000 reference pairs, contrast and linear-RGB simulation before testing tokens', () => {
    expect(deltaE([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4)
    expect(deltaE([50, 3.1571, -77.2803], [50, 0, -82.7485])).toBeCloseTo(2.8615, 4)
    expect(deltaE([50, 0, 0], [50, 0, 0])).toBe(0)
    expect(contrast([0, 0, 0], [1, 1, 1])).toBe(21)
    expect(simulate([1, 0, 0], matrices[0])[0]).toBeCloseTo(srgb(0.367322), 8)
    expect(color('rgba(0, 0, 0, 0.5)', {})).toEqual([0.5, 0.5, 0.5])
  })

  for (const theme of ['dark', 'light'] as const) {
    describe(theme, () => {
      const tokens = tokensFor(theme)
      const check = missing.length ? it.skip : it
      check(missing.length ? skipReason : 'separates providers in normal vision and CVD', () => {
        const [a, b] = providerNames.map(name => color(tokens[name], tokens))
        expect(distance(a, b)).toBeGreaterThanOrEqual(40)
        for (const matrix of matrices) expect(distance(simulate(a, matrix), simulate(b, matrix))).toBeGreaterThanOrEqual(15)
      })
      check(missing.length ? skipReason : 'keeps contrast >= 4.5 on panels and every data-bg surface', () => {
        const variants = [tokens, ...rules.filter(rule => rule.selector.includes('data-bg')
          && !rule.selector.includes(`data-theme='${theme === 'dark' ? 'light' : 'dark'}'`))
          .map(rule => ({ ...tokens, ...rule.tokens }))]
        for (const variant of variants) for (const surface of ['--bg', '--panel', '--panel-2']) {
          const background = color(variant[surface], variant)
          for (const name of providerNames) {
            const foreground = color(variant[name], variant, background)
            expect(contrast(foreground, background), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5)
            // Tags actually paint their soft fill, so check it too.
            expect(contrast(foreground, color(variant[`${name}-soft`], variant, background)), `${name} on its soft fill`).toBeGreaterThanOrEqual(4.5)
          }
        }
      })
      check(missing.length ? skipReason : 'separates chromatic tokens and model dots, including summary neighbours', () => {
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
