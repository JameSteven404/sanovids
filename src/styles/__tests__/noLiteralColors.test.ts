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

function literalColors(css: string): string[] {
  // URLs are separate image resources (e.g. the fixed canvas cursor), not CSS colors.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\((?:"[^"]*"|'[^']*'|[^)])*\)/gi, '')
  return [...clean.matchAll(/(?:^|[;{])\s*[\w-]+\s*:\s*([^;{}]+)/g)].flatMap(([, value]) => {
    const tokens = value.replace(/--[\w-]+/g, '').match(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(|\b[a-z]+\b/gi) ?? []
    return tokens.filter((token) => token.startsWith('#') || token.includes('(') || namedColors.has(token.toLowerCase()))
  })
}

describe('component theme colors', () => {
  it('keeps every component stylesheet token-only (base.css owns theme and brand literals)', () => {
    // Deliberately scan every component, including future files; base.css is outside this directory.
    const files = cssFiles(join(src, 'components'))
    expect(files.length).toBeGreaterThan(0)
    const failures = files.flatMap((file) => literalColors(readFileSync(file, 'utf8')).map((color) => `${relative(src, file)}: ${color}`))
    expect(failures).toEqual([])
  })

  it('catches literals in fills, shadows, custom properties and token fallbacks', () => {
    expect(literalColors('.test { color: #fff; background: rgb(1 2 3); box-shadow: 0 0 2px rgba(0,0,0,.5); --ink: red; border-color: var(--text, white); fill: oklch(50% .2 30); }'))
      .toEqual(['#fff', 'rgb(', 'rgba(', 'red', 'white', 'oklch('])
    expect(literalColors('/* white #fff */ .test { white-space: nowrap; color: var(--text); background: color-mix(in srgb, var(--panel) 50%, transparent); fill: currentColor; }')).toEqual([])
  })
})
