// docs/DESIGN.md says what the stylesheets really do for the details a contributor copies (segmented tracks, disabled
// opacity, the focus ring, the accent's two colours), and the DMG background keeps Finder's icon labels readable under
// both macOS appearances. Only facts that hold before and after the redesign D stylesheet lands are cross-checked here.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')))
const readText = (rel) => read(rel).toString('utf8')

/** The one DESIGN.md bullet that starts with `prefix`. */
function bullet(prefix) {
  const lines = readText('docs/DESIGN.md').split('\n').filter((l) => l.startsWith(prefix))
  expect(lines, prefix).toHaveLength(1)
  return lines[0]
}

/** Every component stylesheet under src/ (plain CSS files next to the components). */
function cssFiles(dir = path.join(root, 'src')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : cssFiles(p)
    return e.name.endsWith('.css') ? [p] : []
  })
}

/** The body of the first rule whose selector line is exactly `selector {`. */
function ruleBody(selector) {
  const head = `${selector} {`
  for (const file of cssFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const i = lines.indexOf(head)
    if (i >= 0) {
      const end = lines.indexOf('}', i)
      return lines.slice(i + 1, end).join('\n')
    }
  }
  throw new Error(`no rule "${head}" in src/**/*.css`)
}

describe('docs/DESIGN.md matches the stylesheets', () => {
  it('every segmented track named with its class uses the token the doc gives it', () => {
    const line = bullet('- **Segmented control**')
    const pairs = [...line.matchAll(/`(--[a-z0-9-]+)` for [^(`]*\(`(\.[a-z-]+)`\)/g)].map((m) => [m[2], m[1]])
    // The canvas toolbar (cx/tb1) has no segmented track any more: its display options are menu rows.
    expect(pairs.map(([cls]) => cls)).toEqual(expect.arrayContaining(['.dg-seg']))
    for (const [cls, token] of pairs) {
      expect(ruleBody(cls), cls).toMatch(new RegExp(`^\\s*background: var\\(${token}\\);$`, 'm'))
    }
  })

  it('the disabled opacity of the shared buttons is the one in base.css', () => {
    const line = bullet('- **Buttons**')
    for (const cls of ['.btn', '.icon-btn']) {
      const opacity = Number(ruleBody(`${cls}:disabled`).match(/opacity: ([\d.]+);/)?.[1])
      expect(opacity, cls).toBeGreaterThan(0)
      expect(line).toContain(`\`${cls}\` ${Math.round(opacity * 100)}%`)
    }
  })

  it('the focus bullet names the shared primitives that use --focus-ring', () => {
    const base = readText('src/styles/base.css')
    const rule = base.match(/^((?:[^\n{}]*:focus-visible,\n)*[^\n{}]*:focus-visible) \{\n\s*outline: none;\n\s*box-shadow: var\(--focus-ring\);/m)
    expect(rule, 'base.css shared focus-ring rule').toBeTruthy()
    const selectors = rule[1].split(',').map((s) => s.trim().replace(/:focus-visible$/, ''))
    expect(selectors.every((s) => /^\.[a-z-]+( \.[a-z-]+)?$/.test(s)), selectors.join(' | ')).toBe(true)
    expect(selectors).toEqual(expect.arrayContaining(['.btn', '.icon-btn']))
    expect(ruleBody('.dg-seg button:focus-visible')).toMatch(/box-shadow: var\(--focus-ring\);/)
    const line = bullet('- Focus:')
    for (const sel of [...selectors, '.dg-seg']) expect(line).toContain(`\`${sel}\``)
  })

  it('--accent is not described as coral only (light uses brick red)', () => {
    for (const rel of ['docs/DESIGN.md', 'CLAUDE.md']) {
      const text = readText(rel)
      expect(text, rel).not.toMatch(/`--accent` is decorative coral/)
      expect(text, rel).toMatch(/`--accent` is decorative \(coral in dark, brick red in light\)/)
    }
  })
})

// ------------------------------------------------------------------ DMG background

/** Minimal PNG reader for the generated art: 8-bit RGB / RGBA, not interlaced. */
function decodePng(buf) {
  expect(buf.readUInt32BE(0)).toBe(0x89504e47)
  let o = 8
  let ihdr
  const idat = []
  while (o < buf.length) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('latin1', o + 4, o + 8)
    const data = buf.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    o += 12 + len
  }
  const { width, height, depth, color, interlace } = ihdr
  if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) throw new Error(`unsupported PNG (depth ${depth}, colour ${color})`)
  const bpp = color === 6 ? 4 : 3
  const stride = width * bpp
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const px = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0
      let pred = 0
      if (filter === 1) pred = a
      else if (filter === 2) pred = b
      else if (filter === 3) pred = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[y * stride + x] = (line[x] + pred) & 255
    }
  }
  return { width, height, at: (x, y) => [...px.subarray(y * stride + x * bpp, y * stride + x * bpp + bpp)] }
}

const channel = (v) => {
  const s = v / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)

describe('DMG background (build/dmg-background*.png)', () => {
  const dmg = JSON.parse(readText('package.json')).build.dmg

  // Finder draws each label itself (dmg-builder's default 12 pt text, one line for "SanoVids" / "Applications",
  // about 75 pt wide) just below the icon, in black under macOS Light and white under Dark; a DMG cannot set that
  // colour. Every pixel of a generous box around each label must keep 4.5:1 with both.
  it.each([
    ['build/dmg-background.png', 1],
    ['build/dmg-background@2x.png', 2],
  ])('%s keeps the icon labels readable in Light and Dark', (rel, scale) => {
    const png = decodePng(read(rel))
    expect([png.width, png.height]).toEqual([540 * scale, 380 * scale])
    expect(luminance(png.at(4 * scale, 4 * scale)), 'charcoal window').toBeLessThan(0.03)
    expect(dmg.contents).toHaveLength(2)
    for (const { x, y } of dmg.contents) {
      const top = y + dmg.iconSize / 2 + 4
      let worst = Infinity
      for (let py = top * scale; py <= (top + 28) * scale; py++) {
        for (let px = (x - 40) * scale; px <= (x + 40) * scale; px++) {
          const rgba = png.at(px, py)
          if (rgba.length === 4) expect(rgba[3]).toBe(255)
          const l = luminance(rgba)
          worst = Math.min(worst, contrast(l, 0), contrast(l, 1))
        }
      }
      expect(worst, `label under (${x}, ${y})`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
