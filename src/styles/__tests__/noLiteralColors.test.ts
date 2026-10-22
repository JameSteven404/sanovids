import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = fileURLToPath(new URL('../../', import.meta.url))
const namedColors = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '))

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith('.css') ? [path] : []
  })
}

const COLOR_IN_VALUE = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(|\b[a-z]+\b/gi
const isColor = (token: string) => token.startsWith('#') || token.includes('(') || namedColors.has(token.toLowerCase())

/** The text of a `data:` URI (percent-decoded, or base64 for SVG); null for any other URL (a file has no CSS colors). */
function dataUriText(raw: string): string | null {
  const url = raw.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(url)
  if (!m) return null
  if (/;base64$/i.test(m[1])) return /svg/i.test(m[1]) ? Buffer.from(m[2], 'base64').toString('utf8') : ''
  try {
    return decodeURIComponent(m[2])
  } catch {
    return m[2].replace(/%23/gi, '#')
  }
}

/** Colors drawn by an image document inside the stylesheet (SVG markup / inline style), which no theme token reaches. */
function imageColors(svg: string): string[] {
  // in document order; the named value is read by a lookahead, so `fill: rgb(…)` still reports the rgb( after it
  const re = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklab|oklch)\s*\(|\b(?:fill|stroke|stop-color|flood-color|lighting-color|color)\s*[=:]\s*['"]?(?=([a-z]+))/gi
  const out: string[] = []
  for (const m of svg.matchAll(re)) {
    if (m[1] === undefined) out.push(m[0])
    else if (namedColors.has(m[1].toLowerCase())) out.push(m[1])
  }
  return out
}

interface Literal {
  color: string
  /** The declaration's property (`cursor`, `background`, `--ink`…). */
  prop: string
  /** Drawn by an image inside url(…) (a data: URI), not a CSS color value. */
  inUrl: boolean
}

function literals(css: string): Literal[] {
  // url(…) first: a data: URI may hold `;` / `{`, which would split the declaration. Each one becomes a placeholder.
  const urls: string[] = []
  const clean = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\(((?:"[^"]*"|'[^']*'|[^)])*)\)/gi, (_, inner: string) => `\u0000${urls.push(inner) - 1}\u0000`)
  return [...clean.matchAll(/(?:^|[;{])\s*([\w-]+)\s*:\s*([^;{}]+)/g)].flatMap(([, prop, value]) => {
    const found: Literal[] = []
    for (const [, i] of value.matchAll(/\u0000(\d+)\u0000/g)) {
      const text = dataUriText(urls[Number(i)])
      if (text) for (const color of imageColors(text)) found.push({ color, prop, inUrl: true })
    }
    const plain = value.replace(/\u0000\d+\u0000/g, ' ').replace(/--[\w-]+/g, '')
    for (const token of plain.match(COLOR_IN_VALUE) ?? []) if (isColor(token)) found.push({ color: token, prop, inUrl: false })
    return found
  })
}

const literalColors = (css: string): string[] => literals(css).map((l) => l.color)

/**
 * The ONLY literal colors a component stylesheet may hold: inside a cursor image (a cursor is its own document, drawn by
 * the OS, so theme tokens cannot reach it). Per file, the exact colors; anything else — another property, another
 * color, another file, a CSS value — fails.
 */
const CURSOR_IMAGE_COLORS: Record<string, string[]> = {
  // click-to-cut scissors: dark blades on a white halo read on the light and the dark canvas alike
  'components/canvas/wires.css': ['white', '#1c1c1e'],
}
const allowed = (file: string, l: Literal) => l.inUrl && l.prop === 'cursor' && (CURSOR_IMAGE_COLORS[file] ?? []).includes(l.color)

describe('component theme colors', () => {
  it('keeps every component stylesheet token-only (base.css owns theme and brand literals)', () => {
    // Deliberately scan every component, including future files; base.css is outside this directory.
    const files = cssFiles(join(src, 'components'))
    expect(files.length).toBeGreaterThan(0)
    const failures = files.flatMap((file) => {
      const rel = relative(src, file).replace(/\\/g, '/')
      return literals(readFileSync(file, 'utf8'))
        .filter((l) => !allowed(rel, l))
        .map((l) => `${rel}: ${l.prop}: ${l.color}${l.inUrl ? ' (in url)' : ''}`)
    })
    expect(failures).toEqual([])
  })

  it('the cursor allow-list is still needed (no stale entry)', () => {
    for (const [file, colors] of Object.entries(CURSOR_IMAGE_COLORS)) {
      const found = literals(readFileSync(join(src, file), 'utf8')).filter((l) => l.inUrl && l.prop === 'cursor').map((l) => l.color)
      for (const color of colors) expect(found, `${file}: ${color}`).toContain(color)
    }
  })

  it('catches literals in fills, shadows, custom properties and token fallbacks', () => {
    expect(literalColors('.test { color: #fff; background: rgb(1 2 3); box-shadow: 0 0 2px rgba(0,0,0,.5); --ink: red; border-color: var(--text, white); fill: oklch(50% .2 30); }'))
      .toEqual(['#fff', 'rgb(', 'rgba(', 'red', 'white', 'oklch('])
    expect(literalColors('/* white #fff */ .test { white-space: nowrap; color: var(--text); background: color-mix(in srgb, var(--panel) 50%, transparent); fill: currentColor; }')).toEqual([])
  })

  it('catches colors drawn by a data: URI image (percent-encoded, plain or base64 SVG)', () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'><path fill='%23ff0000' stroke='navy'/><circle style='fill: rgb(0 0 0)'/></svg>"
    expect(literalColors(`.a { background: url("data:image/svg+xml,${svg}") no-repeat; }`)).toEqual(['#ff0000', 'navy', 'rgb('])
    // a `;` in the URI (media type parameters) does not end the declaration
    expect(literalColors(`.a { mask: url('data:image/svg+xml;utf8,${svg.replace(/'/g, '"')}'); color: red; }`)).toEqual(['#ff0000', 'navy', 'rgb(', 'red'])
    const b64 = Buffer.from("<svg><rect fill='#00ff00'/></svg>").toString('base64')
    expect(literalColors(`.a { background-image: url(data:image/svg+xml;base64,${b64}); }`)).toEqual(['#00ff00'])
    // a file URL or an SVG fragment has no colors of its own; `none` / currentColor are not colors
    expect(literalColors(".a { background: url(./grain.png); } .b { fill: url(#grad); } .c { cursor: url(\"data:image/svg+xml,<svg fill='none' stroke='currentColor'/>\"), auto; }")).toEqual([])
  })

  it('allows the cursor image colors only in a cursor, only in the listed file', () => {
    const cursor = ".x { cursor: url(\"data:image/svg+xml,%3Csvg%3E%3Cg stroke='white'/%3E%3Cg stroke='%231c1c1e'/%3E%3C/svg%3E\") 12 12, pointer; }"
    const asBackground = cursor.replace('cursor:', 'background:')
    const bad = (file: string, css: string) => literals(css).filter((l) => !allowed(file, l)).map((l) => l.color)
    expect(bad('components/canvas/wires.css', cursor)).toEqual([])
    expect(bad('components/canvas/wires.css', asBackground)).toEqual(['white', '#1c1c1e'])
    expect(bad('components/canvas/canvas.css', cursor)).toEqual(['white', '#1c1c1e'])
    expect(bad('components/canvas/wires.css', cursor.replace('%231c1c1e', '%23ff0000'))).toEqual(['#ff0000'])
  })
})
