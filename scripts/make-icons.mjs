// Generates the app icons without native dependencies: shapes are signed-distance functions rasterised with
// analytic anti-aliasing into an RGBA buffer, then encoded as PNG with node:zlib + CRC32.
//
//   node scripts/make-icons.mjs
//
// Outputs (commit them, they are small):
//   public/icons/icon-192.png, icon-512.png       rounded square, transparent corners (purpose "any")
//   public/icons/maskable-512.png                  full-bleed square, glyph inside the 80% safe zone (purpose "maskable")
//   public/icons/apple-touch-icon-180.png          full-bleed square (iOS rounds it itself)
//   public/favicon.svg                             hand-written SVG of the same logo
//   build/icon.png                                 512×512 for electron-builder (.exe / installer icon)
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ACCENT = [0xe8, 0x89, 0x4a]
const WHITE = [0xff, 0xff, 0xff]

// ---------------- SDF helpers (unit square coordinates, y down; negative = inside) ----------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

function box(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const qx = Math.abs(px - cx) - ((x1 - x0) / 2 - r)
  const qy = Math.abs(py - cy) - ((y1 - y0) / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/** Diagonal stripes: u = x + y (45°), stripe width = period / 2. */
function stripes(px, py, period, phase) {
  const u = px + py - phase
  const t = (((u - period / 4) % period) + period) % period - period / 2
  return (Math.abs(t) - period / 4) / Math.SQRT2
}

/** Convex polygon (clockwise in y-down space), approximate SDF: max of edge half-plane distances. */
function convex(px, py, pts) {
  let d = -Infinity
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[(i + 1) % pts.length]
    const ex = bx - ax
    const ey = by - ay
    const len = Math.hypot(ex, ey)
    // outward normal for clockwise winding in y-down coords
    const nx = ey / len
    const ny = -ex / len
    d = Math.max(d, (px - ax) * nx + (py - ay) * ny)
  }
  return d
}

const intersect = (a, b) => Math.max(a, b)

// ---------------- the logo: clapperboard with a play mark ----------------
const ARM_ANGLE = (-14 * Math.PI) / 180
const HINGE = [0.235, 0.395]
const COS = Math.cos(-ARM_ANGLE)
const SIN = Math.sin(-ARM_ANGLE)
const PLAY = [
  [0.455, 0.585],
  [0.575, 0.655],
  [0.455, 0.725],
]

/** Glyph layers in glyph space (unit square). Each returns an SDF; painted in order over the background. */
const LAYERS = [
  // board band (top of the body) and the body below it
  { color: WHITE, sdf: (x, y) => box(x, y, 0.22, 0.42, 0.78, 0.51, 0.025) },
  { color: ACCENT, sdf: (x, y) => intersect(box(x, y, 0.245, 0.437, 0.755, 0.493, 0.008), stripes(x, y, 0.12, 0.0)) },
  { color: WHITE, sdf: (x, y) => box(x, y, 0.22, 0.53, 0.78, 0.79, 0.04) },
  { color: ACCENT, sdf: (x, y) => convex(x, y, PLAY) },
  // clapper arm, rotated around its hinge
  {
    color: WHITE,
    sdf: (x, y) => {
      const [lx, ly] = armLocal(x, y)
      return box(lx, ly, 0.22, 0.3, 0.78, 0.39, 0.025)
    },
  },
  {
    color: ACCENT,
    sdf: (x, y) => {
      const [lx, ly] = armLocal(x, y)
      return intersect(box(lx, ly, 0.245, 0.317, 0.755, 0.373, 0.008), stripes(lx, ly, 0.12, 0.06))
    },
  },
]

function armLocal(x, y) {
  const dx = x - HINGE[0]
  const dy = y - HINGE[1]
  return [HINGE[0] + dx * COS - dy * SIN, HINGE[1] + dx * SIN + dy * COS]
}

/**
 * @param size      output pixels
 * @param variant   'any' (rounded square, transparent corners) | 'full' (full-bleed square)
 * @param scale     glyph scale around the centre (1 = as designed)
 */
function render(size, variant, scale) {
  const rgba = new Float64Array(size * size * 4) // premultiplied, 0..1
  const px = 1 / size
  const paint = (i, color, a) => {
    if (a <= 0) return
    const k = 1 - a
    rgba[i] = (color[0] / 255) * a + rgba[i] * k
    rgba[i + 1] = (color[1] / 255) * a + rgba[i + 1] * k
    rgba[i + 2] = (color[2] / 255) * a + rgba[i + 2] * k
    rgba[i + 3] = a + rgba[i + 3] * k
  }
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / size
      const y = (j + 0.5) / size
      const o = (j * size + i) * 4
      const bg = variant === 'any' ? box(x, y, 0, 0, 1, 1, 0.21) : -1
      paint(o, ACCENT, clamp(0.5 - bg / px, 0, 1))
      // glyph space: scaled around the centre, nudged down a little for optical balance
      const gx = (x - 0.5) / scale + 0.5
      const gy = (y - 0.5) / scale + 0.5 - 0.02
      for (const layer of LAYERS) {
        const d = layer.sdf(gx, gy) * scale
        paint(o, layer.color, clamp(0.5 - d / px, 0, 1))
      }
    }
  }
  // un-premultiply to 8-bit RGBA
  const out = Buffer.alloc(size * size * 4)
  for (let o = 0; o < rgba.length; o += 4) {
    const a = rgba[o + 3]
    out[o + 3] = Math.round(a * 255)
    if (a > 0) {
      out[o] = Math.round(clamp(rgba[o] / a, 0, 1) * 255)
      out[o + 1] = Math.round(clamp(rgba[o + 1] / a, 0, 1) * 255)
      out[o + 2] = Math.round(clamp(rgba[o + 2] / a, 0, 1) * 255)
    }
  }
  return out
}

// ---------------- PNG encoding ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------- favicon.svg (hand-written, same geometry) ----------------
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <pattern id="s" width="43.44" height="43.44" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="21.72" height="43.44" fill="#e8894a"/>
    </pattern>
  </defs>
  <rect width="512" height="512" rx="108" fill="#e8894a"/>
  <g transform="translate(0 10)">
    <rect x="113" y="215" width="286" height="46" rx="13" fill="#fff"/>
    <rect x="125" y="224" width="262" height="28" rx="4" fill="url(#s)"/>
    <rect x="113" y="271" width="286" height="133" rx="20" fill="#fff"/>
    <path d="M233 300 L294 335 L233 371 Z" fill="#e8894a"/>
    <g transform="rotate(-14 120 202)">
      <rect x="113" y="154" width="286" height="46" rx="13" fill="#fff"/>
      <rect x="125" y="162" width="262" height="29" rx="4" fill="url(#s)"/>
    </g>
  </g>
</svg>
`

// ---------------- write ----------------
function write(rel, data) {
  const file = join(ROOT, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
  console.log(`${rel.padEnd(36)} ${(data.length / 1024).toFixed(1)} kB`)
}

const png = (size, variant, scale) => encodePng(size, render(size, variant, scale))

write('public/icons/icon-192.png', png(192, 'any', 1))
write('public/icons/icon-512.png', png(512, 'any', 1))
// maskable: glyph must stay inside the central circle of radius 0.4 → scale it down
write('public/icons/maskable-512.png', png(512, 'full', 0.74))
write('public/icons/apple-touch-icon-180.png', png(180, 'full', 0.86))
write('build/icon.png', png(512, 'any', 1))
write('public/favicon.svg', Buffer.from(FAVICON, 'utf8'))
