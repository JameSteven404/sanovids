import { describe, expect, it, vi } from 'vitest'
import { SEEDVIS_IMAGE_LIMITS, type SeedvisImageMime } from '../../../core/seedvisRoutes'
import { base64Bytes, downscalePlan, imageBudget, imageFormat, prepareImages, type SourceImage } from '../prepareImages'

const MiB = 1024 ** 2
function bytes(mime: SeedvisImageMime, size = 32): Uint8Array {
  const data = new Uint8Array(size)
  if (mime === 'image/png') data.set([137, 80, 78, 71, 13, 10, 26, 10])
  else if (mime === 'image/jpeg') data.set([255, 216, 255])
  else { data.set(new TextEncoder().encode('RIFF')); data.set(new TextEncoder().encode('WEBP'), 8) }
  return data
}
const source = (key = 'original', size = 32, alpha = false): SourceImage => ({ key, bytes: bytes('image/png', size), width: 4096, height: 2048, alpha })

describe('seedvis headless image preparation (§9)', () => {
  it('counts base64 padding per image and the exact 39 MiB boundary', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(base64Bytes)).toEqual([0, 4, 4, 4, 8, 8, 8])
    const limit = SEEDVIS_IMAGE_LIMITS.preparedBase64Bytes
    const one = source('one', limit * 3 / 8), two = source('two', limit * 3 / 8)
    expect(imageBudget([one, two])).toEqual({ encodedBytes: limit, fits: true })
    expect(imageBudget([one, source('two', two.bytes.length + 1)]).fits).toBe(false)
    for (const invalid of [-1, NaN, Infinity, 0.5]) expect(() => base64Bytes(invalid)).toThrow()
  })

  it('detects PNG/JPEG/WebP from magic bytes and keeps original bytes without encoding', async () => {
    const encode = vi.fn()
    const images = (['image/png', 'image/jpeg', 'image/webp'] as const).map((mime, i) => ({ ...source(`key-${i}`), bytes: bytes(mime) }))
    const result = await prepareImages(images, encode)
    expect(encode).not.toHaveBeenCalled()
    expect(result.remoteNote).toBeNull()
    result.images.forEach((image, i) => {
      expect(image.bytes).toBe(images[i].bytes)
      expect(image.changed).toBe(false)
      expect(image.key).toBe(images[i].key)
      expect(image.mime).toBe(imageFormat(images[i].bytes))
    })
    expect(await prepareImages([], encode)).toEqual({ images: [], encodedBytes: 0, remoteNote: null })
  })

  it.each(['GIF', 'SVG', 'HEIC', 'AVIF'])('converts decodable %s to PNG behind the injected encoder', async format => {
    const raw = format === 'GIF' ? new TextEncoder().encode('GIF89a') : format === 'SVG' ? new TextEncoder().encode('<?xml version="1.0"?>\n<svg></svg>') : new Uint8Array(24)
    if (format === 'HEIC' || format === 'AVIF') {
      new DataView(raw.buffer).setUint32(0, 24)
      raw.set(new TextEncoder().encode(`ftyp${format === 'HEIC' ? 'heic' : 'avif'}`), 4)
    }
    expect(imageFormat(raw)).toBe(format)
    const original = { ...source(), bytes: raw, alpha: true }
    const encode = vi.fn(async () => bytes('image/png'))
    const result = await prepareImages([original], encode)
    expect(encode).toHaveBeenCalledExactlyOnceWith(original, { mime: 'image/png', width: 4096, height: 2048 })
    expect(result.images[0]).toMatchObject({ mime: 'image/png', changed: true, alpha: true })
    expect(original.bytes).toBe(raw)
  })

  it('blocks unknown/corrupt/conversion-failed images before any send and hides encoder errors', async () => {
    const encode = vi.fn(async () => { throw new Error('private decoder internals') })
    await expect(prepareImages([{ ...source(), bytes: new Uint8Array([1, 2, 3]) }], encode)).rejects.toThrow('Chưa gửi gì, không bị trừ credit.')
    expect(encode).not.toHaveBeenCalled()
    await expect(prepareImages([{ ...source(), bytes: new TextEncoder().encode('GIF89a') }], encode)).rejects.toThrow('Ảnh @image_1 là GIF — seedvis chỉ nhận PNG/JPEG/WebP. Chưa gửi gì, không bị trừ credit.')
    await expect(prepareImages([{ ...source(), bytes: new TextEncoder().encode('GIF89a') }], async () => bytes('image/jpeg'))).rejects.toThrow('Không chuyển được ảnh')
    expect(imageFormat(new TextEncoder().encode('not an image with <svg> text'))).toBeNull()
  })

  it('enforces decoded size/count/dimensions before downscale', async () => {
    const encode = vi.fn()
    await expect(prepareImages([source('too-big', 20 * MiB + 1)], encode)).rejects.toThrow('vượt 20 MiB')
    await expect(prepareImages(Array.from({ length: 11 }, () => source()), encode)).rejects.toThrow('tối đa 10 ảnh')
    for (const width of [0, -1, Infinity, NaN, 1.5]) await expect(prepareImages([{ ...source(), width }], encode)).rejects.toThrow('kích thước')
    expect(encode).not.toHaveBeenCalled()
    await expect(prepareImages([{ ...source(), bytes: new TextEncoder().encode('GIF89a') }], async () => bytes('image/png', 20 * MiB + 1))).rejects.toThrow('vượt 20 MiB')
  })

  it('uses JPEG for opaque and WebP for alpha, preserves ratio and never enlarges', () => {
    expect(downscalePlan(source(), 2048)).toEqual({ mime: 'image/jpeg', width: 2048, height: 1024, quality: 0.9 })
    expect(downscalePlan({ ...source(), alpha: true }, 1536)).toEqual({ mime: 'image/webp', width: 1536, height: 768, quality: 0.9 })
    expect(downscalePlan({ ...source(), width: 100, height: 200 }, 2048)).toMatchObject({ width: 100, height: 200 })
    expect(downscalePlan({ ...source(), width: 100_000, height: 1 }, 1536)).toMatchObject({ width: 1536, height: 1 })
  })

  it('downscales largest first but returns original @image_N order, stopping when the budget fits', async () => {
    const images = [source('small', 2 * MiB), source('large', 18 * MiB, true), source('medium', 12 * MiB)]
    const encode = vi.fn(async (_source: SourceImage, plan: { mime: SeedvisImageMime }) => bytes(plan.mime, 8 * MiB))
    const result = await prepareImages(images, encode)
    expect(encode).toHaveBeenCalledTimes(1)
    expect(encode.mock.calls[0][0].key).toBe('large')
    expect(encode.mock.calls[0][1]).toMatchObject({ mime: 'image/webp', width: 2048, quality: 0.9 })
    expect(result.images.map(i => i.key)).toEqual(['small', 'large', 'medium'])
    expect(result.images.map(i => i.changed)).toEqual([false, true, false])
    expect(result.remoteNote).toBe('Đã thu nhỏ 1 ảnh (@image_2) để vừa giới hạn seedvis')
    expect(result.images[0].bytes).toBe(images[0].bytes)
    expect(result.encodedBytes).toBeLessThanOrEqual(39 * MiB)
  })

  it('breaks size ties by slot, tries 2048 then 1536 from original bytes and is deterministic', async () => {
    const images = [source('a', 16 * MiB), source('b', 16 * MiB)]
    const run = async () => {
      const encode = vi.fn(async (_source: SourceImage, plan: { width: number; mime: SeedvisImageMime }) => bytes(plan.mime, (plan.width === 2048 ? 15 : 10) * MiB))
      const result = await prepareImages(images, encode)
      return { result, calls: encode.mock.calls }
    }
    const first = await run(), second = await run()
    expect(first.calls.map(([input, plan]) => [input.key, plan.width])).toEqual([['a', 2048], ['b', 2048], ['a', 1536]])
    expect(first.calls[2][0].bytes).toBe(images[0].bytes)
    expect(first.result.images.map(i => [i.key, i.width, i.mime, i.bytes.length])).toEqual(second.result.images.map(i => [i.key, i.width, i.mime, i.bytes.length]))
    expect(first.result.remoteNote).toBe('Đã thu nhỏ 2 ảnh (@image_1, @image_2) để vừa giới hạn seedvis')
  })

  it('blocks after both passes, never truncates images or accepts a larger/wrong encoding', async () => {
    const images = [source('a', 16 * MiB), source('b', 16 * MiB)]
    const encode = vi.fn(async (_source: SourceImage, plan: { mime: SeedvisImageMime }) => bytes(plan.mime, 17 * MiB))
    await expect(prepareImages(images, encode)).rejects.toThrow('1536 px')
    expect(encode).toHaveBeenCalledTimes(4)
    expect(images.map(i => i.bytes.length)).toEqual([16 * MiB, 16 * MiB])
    await expect(prepareImages(images, async () => bytes('image/png'))).rejects.toThrow('Không mã hoá được ảnh')
    await expect(prepareImages(images, async () => { throw new Error('secret') })).rejects.toThrow('Không thu nhỏ được ảnh')
  })
})
