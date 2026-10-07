// Builds every SanoVids icon file from the hand-written SVGs in build/icon-source/.
//
//   npm run icons                          (= node scripts/make-icons.mjs)
//   node scripts/make-icons.mjs --out tmp  (write the same tree under ./tmp instead of the repo)
//   node scripts/make-icons.mjs --src dir  (read the SVG sources from another folder)
//
// One devDependency: @resvg/resvg-js (SVG rasteriser). PNG comes from resvg; ICO, ICNS and BMP are encoded here with
// node built-ins only (the .icns is committed, so electron-builder never downloads an icon converter on the Mac).
//
// Sources (build/icon-source/):
//   icon-master.svg       D 512 master: white play triangle with an S cutout + source dot on a vertical Sano red plate.
//                         Plate inset 16, width 480, rx 108; used at 96 px and up, for web icons and installer art.
//   icon-small.svg        Same 512-unit glyph scaled to 32 units: 16, 32, 40, 48, 64 px (also installer icon).
//   icon-24.svg           Same glyph scaled to 24 units (taskbar at 100 %, in-app top-bar logo).
//   icon-20.svg           Same glyph scaled to 20 units (title bar / small icons at 125 %).
//   favicon.svg           Separate red play / white S on a dark tile, copied as is for browser tabs.
//   logo-mark.svg         512-unit glyph only, currentColor (reference for src/components/common/Logo.tsx; not copied).
//   installer-sidebar.svg NSIS welcome / finish sidebar 164x314 (href="icon:N" = the N px app icon).
//   installer-header.svg  NSIS header 150x57.
//   uninstaller-sidebar.svg (optional) else the installer sidebar is reused.
//
// Outputs (paths relative to the repo, or to --out):
//   build/icon.ico                16 20 24 32 40 48 64 96 128 (32-bit BMP entries) + 256 (PNG entry)
//   build/icon.png                512, rounded plate with transparent corners (electron-builder fallback)
//   build/icon-1024.png           1024, same (store / docs)
//   build/installerSidebar.bmp    164x314, 24-bit
//   build/uninstallerSidebar.bmp  164x314, 24-bit
//   build/installerHeader.bmp     150x57, 24-bit
//   build/icon.icns               macOS app icon (package.json build.mac.icon): PNG entries 16…1024 on Apple's macOS 11+
//                                 grid (824 px plate at 100,100 on a 1024 canvas, soft shadow below)
//   build/dmg-background.png      540x380 (+ @2x 1080x760, dmg-builder joins them into a HiDPI tiff): neutral charcoal
//                                 with a Sano red arrow from the app to Applications, no text (Finder draws the labels,
//                                 black or white by appearance, on mid-grey plates readable either way)
//   public/favicon.svg
//   public/icons/icon.ico         same as build/icon.ico (BrowserWindow icon on Windows, ships inside dist/)
//   public/icons/icon-192.png, icon-512.png      rounded plate, transparent corners (PWA purpose "any")
//   public/icons/maskable-512.png                full-bleed plate, glyph inside the 80 % safe circle
//   public/icons/apple-touch-icon-180.png        full-bleed plate (iOS rounds it)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import resvg from '@resvg/resvg-js'

const { Resvg } = resvg
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : fallback
}
const OUT = arg('--out', ROOT)
const SRC = arg('--src', join(ROOT, 'build', 'icon-source'))

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

// ---------------------------------------------------------------- sources
const source = (name) => readFileSync(join(SRC, name), 'utf8')
const SVG = {
  master: source('icon-master.svg'),
  small: source('icon-small.svg'),
  s24: source('icon-24.svg'),
  s20: source('icon-20.svg'),
}

/** Which drawing a pixel size is rendered from. */
function svgFor(size) {
  if (size === 20) return SVG.s20
  if (size === 24) return SVG.s24
  if (size < 96) return SVG.small
  return SVG.master
}

// Installer text: Segoe UI from the Windows font folder when present (it has the Vietnamese diacritics);
// elsewhere fall back to the system fonts.
const WIN_FONTS = ['segoeui.ttf', 'seguisb.ttf', 'segoeuib.ttf'].map((f) => join(process.env.WINDIR || 'C:/Windows', 'Fonts', f))
const HAVE_SEGOE = WIN_FONTS.every((f) => existsSync(f))
const FONT = HAVE_SEGOE
  ? { loadSystemFonts: false, fontFiles: WIN_FONTS, defaultFontFamily: 'Segoe UI' }
  : { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' }

/** Renders an SVG to straight (not premultiplied) RGBA at `size` px wide. */
function rasterize(svg, size) {
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: FONT }).render()
  const rgba = Buffer.from(img.pixels) // resvg gives premultiplied RGBA
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]
    if (a === 0) rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
    else if (a < 255) for (let k = 0; k < 3; k++) rgba[i + k] = Math.min(255, Math.round((rgba[i + k] * 255) / a))
  }
  return { width: img.width, height: img.height, rgba, png: img.asPng() }
}

const iconPng = (size) => rasterize(svgFor(size), size).png

// ---------------------------------------------------------------- composed SVGs
/** The master's <defs> and its glyph group (between the glyph markers). */
function masterParts() {
  const defs = SVG.master.match(/<defs>[\s\S]*?<\/defs>/)?.[0]
  const glyph = SVG.master.match(/<!-- glyph:start -->([\s\S]*?)<!-- glyph:end -->/)?.[1]
  if (!defs || !glyph) throw new Error('icon-master.svg: <defs> or the glyph:start / glyph:end markers are missing')
  return { defs, glyph }
}

/** Full-bleed plate (no rounded corners) with the master glyph scaled by k around the centre. */
function fullBleed(k) {
  const { defs, glyph } = masterParts()
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}
<rect width="512" height="512" fill="url(#sv-plate)"/>
<g transform="translate(256 256) scale(${k}) translate(-256 -256)">${glyph}</g></svg>`
}

/** Installer art: replaces href="icon:N" with the N px icon (rendered from its own cut). */
function withIcons(svg) {
  return svg.replace(/href="icon:(\d+)"/g, (_, n) => `href="data:image/png;base64,${iconPng(+n).toString('base64')}"`)
}

// ---------------------------------------------------------------- encoders
/** .ico: BMP (32-bit BGRA + AND mask) entries below 256, PNG entry at 256. */
function encodeIco(sizes) {
  const images = sizes.map((size) => {
    const r = rasterize(svgFor(size), size)
    return { size, data: size >= 256 ? r.png : dib(r) }
  })
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, e)
    header.writeUInt8(size >= 256 ? 0 : size, e + 1)
    header.writeUInt8(0, e + 2) // palette
    header.writeUInt8(0, e + 3)
    header.writeUInt16LE(1, e + 4) // planes
    header.writeUInt16LE(32, e + 6) // bits per pixel
    header.writeUInt32LE(data.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...images.map((i) => i.data)])
}

/** Icon DIB: BITMAPINFOHEADER (height doubled), bottom-up BGRA rows, then the 1-bit AND mask. */
function dib({ width: w, height: h, rgba }) {
  const maskRow = Math.ceil(w / 32) * 4
  const head = Buffer.alloc(40)
  head.writeUInt32LE(40, 0)
  head.writeInt32LE(w, 4)
  head.writeInt32LE(h * 2, 8)
  head.writeUInt16LE(1, 12)
  head.writeUInt16LE(32, 14)
  head.writeUInt32LE(0, 16) // BI_RGB
  head.writeUInt32LE(w * h * 4 + maskRow * h, 20)
  const xor = Buffer.alloc(w * h * 4)
  const and = Buffer.alloc(maskRow * h)
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      const d = (row * w + x) * 4
      xor[d] = rgba[s + 2]
      xor[d + 1] = rgba[s + 1]
      xor[d + 2] = rgba[s]
      xor[d + 3] = rgba[s + 3]
      if (rgba[s + 3] === 0) and[row * maskRow + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return Buffer.concat([head, xor, and])
}

/** 24-bit BMP (no alpha) for NSIS. The SVG must paint an opaque background. */
function encodeBmp24({ width: w, height: h, rgba }) {
  const stride = Math.ceil((w * 3) / 4) * 4
  const file = Buffer.alloc(54 + stride * h)
  file.write('BM', 0, 'latin1')
  file.writeUInt32LE(file.length, 2)
  file.writeUInt32LE(54, 10)
  file.writeUInt32LE(40, 14)
  file.writeInt32LE(w, 18)
  file.writeInt32LE(h, 22) // positive = bottom-up
  file.writeUInt16LE(1, 26)
  file.writeUInt16LE(24, 28)
  file.writeUInt32LE(0, 30)
  file.writeUInt32LE(stride * h, 34)
  file.writeInt32LE(2835, 38) // 72 dpi
  file.writeInt32LE(2835, 42)
  for (let y = 0; y < h; y++) {
    const o = 54 + (h - 1 - y) * stride
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      if (rgba[s + 3] !== 255) throw new Error('installer art must be fully opaque (paint a background rect)')
      file[o + x * 3] = rgba[s + 2]
      file[o + x * 3 + 1] = rgba[s + 1]
      file[o + x * 3 + 2] = rgba[s]
    }
  }
  return file
}

// ---------------------------------------------------------------- macOS
/** An SVG's inner markup (its outer <svg …> tag removed), to nest it in another drawing. */
const innerSvg = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')

/**
 * The macOS app icon at `size` px, on Apple's macOS 11+ grid (1024 canvas): the plate is 824 wide at (100, 100) with a
 * soft shadow below it. D keeps the master's plate geometry (inset 16, rx 108 / 480 = 22.5 %) and paints it Sano red
 * top to bottom, with a white play/S glyph. It is only re-framed; 64 px and below use the same glyph on the 32-unit plate.
 */
function macIconSvg(size) {
  const small = size <= 64
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs><filter id="mac-shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/></filter></defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="#000" filter="url(#mac-shadow)" opacity="0.9"/>
<svg x="100" y="100" width="824" height="824" viewBox="${small ? '0 0 32 32' : '16 16 480 480'}">${innerSvg(small ? SVG.small : SVG.master)}</svg>
</svg>`
}

/** .icns entries: OSType → pixel size (PNG data; iconutil's own set for an iconset with every size). */
const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32],
  ['icp6', 64],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
]

/** .icns: 'icns' + big-endian total length, then per entry its OSType + big-endian length (8-byte header included) + PNG. */
function encodeIcns() {
  const pngs = new Map()
  const parts = ICNS_ENTRIES.map(([type, px]) => {
    if (!pngs.has(px)) pngs.set(px, Buffer.from(rasterize(macIconSvg(px), px).png))
    const data = pngs.get(px)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'latin1')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'latin1')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

/** Reads an .icns back (self-check after writing): every entry a PNG of the announced size. */
function readIcns(buf) {
  if (buf.toString('latin1', 0, 4) !== 'icns' || buf.readUInt32BE(4) !== buf.length) throw new Error('icon.icns: bad header')
  const out = []
  for (let o = 8; o < buf.length; ) {
    const type = buf.toString('latin1', o, o + 4)
    const len = buf.readUInt32BE(o + 4)
    if (len < 8 || o + len > buf.length) throw new Error(`icon.icns: entry ${type} overflows the file`)
    const png = buf.subarray(o + 8, o + len)
    if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(`icon.icns: entry ${type} is not a PNG`)
    out.push({ type, width: png.readUInt32BE(16), height: png.readUInt32BE(20) })
    o += len
  }
  return out
}

/**
 * DMG window background, 540 x 380 points: the app icon at (140, 190), the Applications link at (400, 190).
 * Finder draws the icon labels itself, black under the macOS Light appearance and white under Dark (a DMG cannot set
 * their colour), so each label row (y 240-274, below the 96 pt icon) sits on a mid-grey plate #757579 that keeps
 * about 4.6:1 contrast with both; on the bare charcoal a black label would vanish.
 * scripts/__tests__/designDocs.test.mjs checks the committed PNGs.
 */
function dmgBackgroundSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380" viewBox="0 0 540 380">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1F1F22"/><stop offset="1" stop-color="#161618"/></linearGradient></defs>
<rect width="540" height="380" fill="url(#bg)"/>
<rect x="80" y="240" width="120" height="34" rx="12" fill="#757579"/>
<rect x="340" y="240" width="120" height="34" rx="12" fill="#757579"/>
<path d="M212 190 H318" stroke="#FF3D14" stroke-width="6" stroke-linecap="round" fill="none"/>
<path d="M306 174 L328 190 L306 206" stroke="#FF3D14" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`
}

/** Reads an .ico directory back (used as a self-check after writing). */
function readIcoDirectory(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an .ico')
  const n = buf.readUInt16LE(4)
  return Array.from({ length: n }, (_, i) => {
    const e = 6 + 16 * i
    const size = buf.readUInt8(e) || 256
    const bytes = buf.readUInt32LE(e + 8)
    const offset = buf.readUInt32LE(e + 12)
    const isPng = buf.readUInt32BE(offset) === 0x89504e47
    const dims = isPng
      ? [buf.readUInt32BE(offset + 16), buf.readUInt32BE(offset + 20)]
      : [buf.readInt32LE(offset + 4), buf.readInt32LE(offset + 8) / 2]
    return { size, format: isPng ? 'png' : 'bmp', bits: buf.readUInt16LE(e + 6), bytes, offset, width: dims[0], height: dims[1] }
  })
}

// ---------------------------------------------------------------- write
const written = []
function write(rel, data) {
  const file = join(OUT, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
  written.push([rel, data.length])
}

const ico = encodeIco(ICO_SIZES)
const dir = readIcoDirectory(ico)
for (const [i, e] of dir.entries()) {
  const want = ICO_SIZES[i]
  if (e.width !== want || e.height !== want || e.format !== (want >= 256 ? 'png' : 'bmp')) {
    throw new Error(`icon.ico entry ${i} is ${e.format} ${e.width}x${e.height}, expected ${want}`)
  }
}
write('build/icon.ico', ico)
write('public/icons/icon.ico', ico)
write('build/icon.png', iconPng(512))
write('build/icon-1024.png', iconPng(1024))

const sidebar = source('installer-sidebar.svg')
const unSidebar = existsSync(join(SRC, 'uninstaller-sidebar.svg')) ? source('uninstaller-sidebar.svg') : sidebar
write('build/installerSidebar.bmp', encodeBmp24(rasterize(withIcons(sidebar), 164)))
write('build/uninstallerSidebar.bmp', encodeBmp24(rasterize(withIcons(unSidebar), 164)))
write('build/installerHeader.bmp', encodeBmp24(rasterize(withIcons(source('installer-header.svg')), 150)))

const icns = encodeIcns()
const icnsDir = readIcns(icns)
for (const [i, e] of icnsDir.entries()) {
  const [type, want] = ICNS_ENTRIES[i]
  if (e.type !== type || e.width !== want || e.height !== want) throw new Error(`icon.icns entry ${i} is ${e.type} ${e.width}x${e.height}, expected ${type} ${want}`)
}
write('build/icon.icns', icns)
write('build/dmg-background.png', rasterize(dmgBackgroundSvg(), 540).png)
write('build/dmg-background@2x.png', rasterize(dmgBackgroundSvg(), 1080).png)

write('public/favicon.svg', source('favicon.svg'))
write('public/icons/icon-192.png', iconPng(192))
write('public/icons/icon-512.png', iconPng(512))
// D maskable: glyph control points + source dot fit within radius 241; x0.8 < 193 < 204.8 (the 80 % safe circle).
write('public/icons/maskable-512.png', rasterize(fullBleed(0.8), 512).png)
write('public/icons/apple-touch-icon-180.png', rasterize(fullBleed(0.92), 180).png)

console.log(`make-icons: ${written.length} files -> ${OUT}`)
for (const [rel, n] of written) console.log(`  ${rel.padEnd(34)} ${String(n).padStart(7)} B`)
console.log('  icon.ico entries: ' + dir.map((e) => `${e.size}${e.format === 'png' ? ' (png)' : ''}`).join(', '))
console.log('  icon.icns entries: ' + icnsDir.map((e) => `${e.type}=${e.width}`).join(', '))
if (!HAVE_SEGOE) console.warn('  note: Segoe UI not found; installer text used a fallback system font')
