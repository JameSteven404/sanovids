// Fake video renderer for the demo provider (providers/mock.ts): no network, no cost.
// Produces a poster image (and, when the browser supports it, a short animated webm) for each finished take.
// The picture is deterministic per take (seeded by take id) so re-opening a project shows the same frames.
import { getUrl, putBlob } from './imageStore'

export interface MockRenderInput {
  takeId: string
  code: string // "S07"
  takeNumber: number
  title: string
  prompt: string
  ratio: string
  durationLabel: string
  color: string
  /** Image-store keys of the reference images, in @image order. */
  imageIds: string[]
  recordVideo: boolean
}

export interface MockRenderOutput {
  posterId: string
  videoId: string | null
}

const RATIO: Record<string, [number, number]> = {
  '16:9': [640, 360],
  '9:16': [360, 640],
  '1:1': [480, 480],
  '4:3': [560, 420],
  '3:4': [420, 560],
}

const CLIP_MS = 3000
const FPS = 24

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Small seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed || 1
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r)
  else ctx.rect(x, y, w, h)
}

/** Draw `img` cropped to fill a square of `size` (object-fit: cover), zoomed by `zoom` around its center. */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, size: number, zoom: number) {
  const iw = img.naturalWidth || img.width || 1
  const ih = img.naturalHeight || img.height || 1
  const side = Math.min(iw, ih) / zoom
  const sx = (iw - side) / 2
  const sy = (ih - side) / 2
  ctx.drawImage(img, sx, sy, side, side, x, y, size, size)
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(' ').filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const next = line ? line + ' ' + w : w
    if (ctx.measureText(next).width <= maxWidth) {
      line = next
      continue
    }
    if (line) lines.push(line)
    line = w
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    let last = lines[maxLines - 1]
    while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1)
    lines[maxLines - 1] = last + '…'
  }
  return lines
}

function timecode(t: number): string {
  const s = Math.floor(t)
  const f = Math.floor((t - s) * FPS)
  return `00:00:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`
}

type Painter = (t: number) => void

async function buildPainter(ctx: CanvasRenderingContext2D, w: number, h: number, input: MockRenderInput): Promise<Painter> {
  const seed = hashString(input.takeId)
  const rand = rng(seed)
  const hue = seed % 360
  const u = Math.min(w, h) / 360 // type scale
  const urls = (await Promise.all(input.imageIds.slice(0, 4).map(async (id) => (await getUrl(id)) ?? ''))).filter(Boolean)
  const loaded = (await Promise.all(urls.map(loadImage))).filter((x): x is HTMLImageElement => !!x)
  const words = input.prompt.replace(/@(\p{L}[\p{L}\p{N}_]*)/gu, '$1').replace(/\s+/g, ' ').trim()

  // Seeded scenery: two mountain ridges, a glow and floating dust.
  const ridge = (count: number, amp: number) => {
    const pts: number[] = []
    let v = rand()
    for (let i = 0; i <= count; i++) {
      v = Math.max(0, Math.min(1, v + (rand() - 0.5) * 0.7))
      pts.push(v * amp)
    }
    return pts
  }
  const far = ridge(10, 0.18)
  const near = ridge(7, 0.22)
  const glow = { x: 0.2 + rand() * 0.6, y: 0.18 + rand() * 0.2 }
  const dust = Array.from({ length: 26 }, () => ({ x: rand(), y: rand(), r: 0.6 + rand() * 2.2, v: 0.15 + rand() * 0.6, a: 0.12 + rand() * 0.35 }))

  const drawRidge = (pts: number[], base: number, shift: number, fill: string) => {
    const step = w / (pts.length - 2)
    ctx.beginPath()
    ctx.moveTo(-step, h)
    pts.forEach((p, i) => ctx.lineTo(i * step - step + (shift % step), h * (base - p)))
    ctx.lineTo(w + step, h)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
  }

  return (t: number) => {
    // Sky: slow drifting gradient ("camera move").
    const g = ctx.createLinearGradient(0, 0, w * 0.3, h)
    g.addColorStop(0, `hsl(${(hue + t * 12) % 360} 42% 24%)`)
    g.addColorStop(0.6, `hsl(${(hue + 40 + t * 10) % 360} 36% 14%)`)
    g.addColorStop(1, `hsl(${(hue + 160) % 360} 30% 8%)`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)

    // Light source glow.
    const gx = w * glow.x + t * 6
    const gy = h * glow.y
    const rg = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(w, h) * 0.45)
    rg.addColorStop(0, `hsla(${(hue + 30) % 360}, 80%, 75%, 0.38)`)
    rg.addColorStop(1, 'hsla(0, 0%, 0%, 0)')
    ctx.fillStyle = rg
    ctx.fillRect(0, 0, w, h)

    // Parallax ridges.
    drawRidge(far, 0.78, t * 8, `hsla(${(hue + 200) % 360}, 25%, 12%, 0.75)`)
    drawRidge(near, 0.98, t * 18, `hsla(${(hue + 210) % 360}, 30%, 6%, 0.9)`)

    // Floating dust.
    for (const d of dust) {
      const x = ((d.x + t * 0.01 * d.v) % 1) * w
      const y = ((d.y - t * 0.03 * d.v + 1) % 1) * h
      ctx.beginPath()
      ctx.arc(x, y, d.r * u, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 244, 220, ${d.a})`
      ctx.fill()
    }

    // Reference images as framed "subjects" with a slow Ken Burns push-in.
    const n = loaded.length
    loaded.forEach((img, i) => {
      const size = Math.min(w * (n > 2 ? 0.26 : n > 1 ? 0.34 : 0.42), h * 0.5)
      const slot = w / (n + 1)
      const x = slot * (i + 1) - size / 2 + Math.sin(t * 0.9 + i * 1.7) * 8 * u
      const y = h * 0.47 - size / 2 + Math.cos(t * 0.8 + i) * 6 * u
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowBlur = 24 * u
      ctx.shadowOffsetY = 8 * u
      roundedRect(ctx, x, y, size, size, 14 * u)
      ctx.fillStyle = 'rgba(0,0,0,0.3)'
      ctx.fill()
      ctx.restore()
      ctx.save()
      roundedRect(ctx, x, y, size, size, 14 * u)
      ctx.clip()
      ctx.globalAlpha = 0.94
      drawCover(ctx, img, x, y, size, 1 + t * 0.035)
      ctx.restore()
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1
      roundedRect(ctx, x + 0.5, y + 0.5, size - 1, size - 1, 14 * u)
      ctx.stroke()
      ctx.font = `600 ${11 * u}px "JetBrains Mono", monospace`
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.fillText(`@image_${i + 1}`, x + 6 * u, y + size + 16 * u)
    })

    // Vignette.
    const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75)
    v.addColorStop(0, 'rgba(0,0,0,0)')
    v.addColorStop(1, 'rgba(0,0,0,0.6)')
    ctx.fillStyle = v
    ctx.fillRect(0, 0, w, h)

    // Cinematic letterbox bars.
    const bar = Math.round(h * 0.075)
    ctx.fillStyle = 'rgba(0,0,0,0.82)'
    ctx.fillRect(0, 0, w, bar)
    ctx.fillRect(0, h - bar, w, bar)

    // Scene colour edge.
    ctx.fillStyle = input.color
    ctx.fillRect(0, bar, 5 * u, h - bar * 2)

    // Labels.
    const pad = 18 * u
    ctx.textBaseline = 'alphabetic'
    ctx.font = `700 ${24 * u}px "Be Vietnam Pro", Arial, sans-serif`
    ctx.fillStyle = 'rgba(255,255,255,0.96)'
    ctx.fillText(`${input.code} · T${input.takeNumber}`, pad, bar + 30 * u)
    if (input.title) {
      ctx.font = `500 ${14 * u}px "Be Vietnam Pro", Arial, sans-serif`
      ctx.fillStyle = 'rgba(255,255,255,0.82)'
      const [title] = wrapLines(ctx, input.title, w - pad * 2, 1)
      if (title) ctx.fillText(title, pad, bar + 52 * u)
    }

    // Top bar: DEMO tag + timecode.
    ctx.font = `600 ${10 * u}px "JetBrains Mono", monospace`
    ctx.fillStyle = input.color
    ctx.fillText('● DEMO', pad, bar * 0.68)
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    const tc = timecode(t)
    ctx.fillText(tc, w - pad - ctx.measureText(tc).width, bar * 0.68)

    // Bottom bar: settings + prompt excerpt (subtitle style).
    if (words) {
      ctx.font = `400 ${11.5 * u}px "Be Vietnam Pro", Arial, sans-serif`
      const lines = wrapLines(ctx, words, w - pad * 2, 2)
      lines.forEach((line, i) => {
        const y = h - bar - 14 * u - (lines.length - 1 - i) * 16 * u
        const lw = ctx.measureText(line).width
        ctx.fillStyle = 'rgba(0,0,0,0.5)'
        ctx.fillRect(w / 2 - lw / 2 - 6 * u, y - 12 * u, lw + 12 * u, 16 * u)
        ctx.fillStyle = 'rgba(255,255,255,0.88)'
        ctx.fillText(line, w / 2 - lw / 2, y)
      })
    }
    ctx.font = `500 ${10 * u}px "JetBrains Mono", monospace`
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.fillText(`${input.durationLabel}`, pad, h - bar * 0.32)

    // Fake playhead.
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    ctx.fillRect(0, h - 3, w, 3)
    ctx.fillStyle = input.color
    ctx.fillRect(0, h - 3, w * Math.min(1, t / (CLIP_MS / 1000)), 3)
  }
}

export interface MockRenderBlobs {
  poster: Blob
  video: Blob | null
}

/** Render the demo poster (and webm clip when enabled and supported) as Blobs, without storing them. */
export async function renderMockBlobs(input: MockRenderInput): Promise<MockRenderBlobs> {
  const [w, h] = RATIO[input.ratio] ?? RATIO['16:9']
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D không khả dụng')
  const paint = await buildPainter(ctx, w, h, input)

  // Poster frame.
  paint(1.2)
  const poster: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Không tạo được ảnh poster'))), 'image/jpeg', 0.86),
  )

  let video: Blob | null = null
  if (input.recordVideo && typeof MediaRecorder !== 'undefined' && 'captureStream' in canvas) {
    try {
      video = await recordClip(canvas, paint, CLIP_MS)
    } catch {
      video = null
    }
  }
  return { poster, video }
}

/** Render and store the demo media (media-store keys). Kept for callers that want ids directly. */
export async function renderMockTake(input: MockRenderInput): Promise<MockRenderOutput> {
  const { poster, video } = await renderMockBlobs(input)
  const posterId = await putBlob(poster, 'poster')
  const videoId = video ? await putBlob(video, 'video') : null
  return { posterId, videoId }
}

async function recordClip(canvas: HTMLCanvasElement, paint: Painter, ms: number): Promise<Blob | null> {
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) return null
  const stream = canvas.captureStream(FPS)
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_400_000 })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  const done = new Promise<void>((resolve) => {
    rec.onstop = () => resolve()
    rec.onerror = () => resolve()
  })
  const start = performance.now()
  paint(0)
  rec.start(250)
  await new Promise<void>((resolve) => {
    // rAF pauses in background tabs: frames come from rAF while visible and from a timer while hidden,
    // so the clip always finishes even if the user switches tabs mid-recording.
    let finished = false
    const step = () => {
      if (finished) return
      const elapsed = performance.now() - start
      paint(elapsed / 1000)
      if (elapsed >= ms) {
        finished = true
        clearInterval(timer)
        resolve()
      }
    }
    const timer = setInterval(() => {
      if (document.hidden) step()
    }, 1000 / FPS)
    const frame = () => {
      if (finished) return
      if (!document.hidden) step()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  if (rec.state !== 'inactive') rec.stop()
  stream.getTracks().forEach((t) => t.stop())
  await done
  if (!chunks.length) return null
  return new Blob(chunks, { type: 'video/webm' })
}
