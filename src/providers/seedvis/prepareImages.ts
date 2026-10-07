import { SEEDVIS_IMAGE_LIMITS, type SeedvisImageMime } from '../../core/seedvisRoutes'
import { SeedvisPreSendError, seedvisDownscaleText, seedvisFormatText } from './wording'

export interface SourceImage {
  /** Snapshot blob identity; unchanged images keep the original byte reference. */
  key: string
  bytes: Uint8Array
  width: number
  height: number
  alpha: boolean
}
export interface PreparedImage extends SourceImage {
  mime: SeedvisImageMime
  changed: boolean
}
export interface EncodePlan {
  mime: SeedvisImageMime
  width: number
  height: number
  quality?: number
}
/** Decoder/encoder owns pixel work and must reject undecodable input. No DOM or I/O here. */
export type ImageEncoder = (source: SourceImage, plan: EncodePlan) => Promise<Uint8Array>

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
export function imageFormat(bytes: Uint8Array): SeedvisImageMime | 'GIF' | 'SVG' | 'HEIC' | 'AVIF' | null {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  if (['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return 'GIF'
  if (ascii(bytes, 4, 8) === 'ftyp') {
    // Only inspect the ftyp box's brands, never arbitrary payload bytes.
    const size = bytes.length >= 12 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) : 0
    const brands = [ascii(bytes, 8, 12)]
    for (let i = 16; i + 4 <= Math.min(size, bytes.length, 256); i += 4) brands.push(ascii(bytes, i, i + 4))
    if (brands.some(b => ['avif', 'avis'].includes(b))) return 'AVIF'
    if (brands.some(b => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(b))) return 'HEIC'
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '').trimStart()
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(head)) return 'SVG'
  return null
}

export const base64Bytes = (bytes: number) => {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Kích thước ảnh không hợp lệ.')
  return 4 * Math.ceil(bytes / 3)
}
export function imageBudget(images: readonly { bytes: Uint8Array }[]) {
  const encodedBytes = images.reduce((sum, image) => sum + base64Bytes(image.bytes.byteLength), 0)
  return {
    encodedBytes,
    fits: images.length <= SEEDVIS_IMAGE_LIMITS.maxImages &&
      images.every(image => image.bytes.byteLength > 0 && image.bytes.byteLength <= SEEDVIS_IMAGE_LIMITS.maxImageBytes) &&
      encodedBytes <= SEEDVIS_IMAGE_LIMITS.preparedBase64Bytes,
  }
}

/** No enlargement, no cropping; repeatable integer dimensions. */
export function downscalePlan(image: SourceImage, longEdge: 2048 | 1536): EncodePlan {
  const scale = Math.min(1, longEdge / Math.max(image.width, image.height))
  return {
    mime: image.alpha ? 'image/webp' : 'image/jpeg',
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)), quality: 0.9,
  }
}

/**
 * Preserve slot order; only the processing order is largest-first (ties by slot). `slots` names the images in user
 * words, in order (default @image_N; Veo frame modes pass "khung đầu" / "khung cuối"). An image over 20 MiB is
 * downscaled like any image over budget and blocked only if it is still too big after 1536 px. Every refusal is a
 * SeedvisPreSendError (nothing sent).
 */
export async function prepareImages(images: readonly SourceImage[], encode: ImageEncoder, slots: readonly string[] = []): Promise<{
  images: PreparedImage[]; encodedBytes: number; remoteNote: string | null
}> {
  const fail = (why: string): never => { throw new SeedvisPreSendError(why) }
  const slotOf = (i: number) => slots[i] ?? `@image_${i + 1}`
  if (images.length > SEEDVIS_IMAGE_LIMITS.maxImages) fail('seedvis chỉ nhận tối đa 10 ảnh.')
  const prepared: PreparedImage[] = []
  for (const [i, source] of images.entries()) {
    const slot = slotOf(i)
    if (![source.width, source.height].every(n => Number.isSafeInteger(n) && n > 0) || typeof source.alpha !== 'boolean') fail(`Không đọc được kích thước ảnh ${slot}.`)
    const format = imageFormat(source.bytes)
    if (!format) fail(`Không đọc được ảnh ${slot}.`)
    let bytes = source.bytes
    let mime: SeedvisImageMime
    const native = SEEDVIS_IMAGE_LIMITS.formats.includes(format as SeedvisImageMime)
    if (native) mime = format as SeedvisImageMime
    else {
      mime = 'image/png'
      try { bytes = await encode(source, { mime, width: source.width, height: source.height }) }
      catch { fail(seedvisFormatText(slot, format!)) }
      if (imageFormat(bytes) !== mime) fail(`Không chuyển được ảnh ${slot} sang PNG.`)
    }
    // Over 20 MiB is not refused here: imageBudget().fits is false, so the passes below shrink it first.
    prepared.push({ ...source, bytes, mime, changed: !native })
  }
  const shrunk = new Set<number>()
  for (const edge of [2048, 1536] as const) {
    if (imageBudget(prepared).fits) break
    const order = prepared.map((image, index) => ({ index, size: image.bytes.byteLength }))
      .sort((a, b) => b.size - a.size || a.index - b.index)
    for (const { index } of order) {
      if (imageBudget(prepared).fits) break
      // Re-encode from the original snapshot, never from an earlier lossy pass.
      const source = images[index]
      const plan = downscalePlan(source, edge)
      let bytes: Uint8Array
      try { bytes = await encode(source, plan) }
      catch { fail(`Không thu nhỏ được ảnh ${slotOf(index)}.`) }
      if (imageFormat(bytes!) !== plan.mime) fail(`Không mã hoá được ảnh ${slotOf(index)}.`)
      if (bytes!.byteLength >= prepared[index].bytes.byteLength) continue
      prepared[index] = { ...source, bytes: bytes!, mime: plan.mime, width: plan.width, height: plan.height, changed: true }
      shrunk.add(index)
    }
  }
  const tooBig = prepared.findIndex(image => image.bytes.byteLength > SEEDVIS_IMAGE_LIMITS.maxImageBytes)
  if (tooBig >= 0) fail(`Ảnh ${slotOf(tooBig)} vẫn vượt 20 MiB sau khi thu nhỏ tới 1536 px.`)
  const budget = imageBudget(prepared)
  if (!budget.fits) fail('Ảnh vẫn vượt giới hạn seedvis sau khi thu nhỏ tới 1536 px (tối đa 39 MiB base64).')
  return {
    images: prepared, encodedBytes: budget.encodedBytes,
    remoteNote: shrunk.size ? seedvisDownscaleText([...shrunk].sort((a, b) => a - b).map(slotOf)) : null,
  }
}
