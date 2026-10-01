import { MODELS, usesRefs, usesVideoRefs } from './models'
import type { Asset, CompiledImage, CompiledPrompt, CompiledVideo, Project, Scene } from './types'

/** Legacy @Tag mention: letters (incl. Vietnamese), digits, underscore. Also matches @image_N/@video_N. */
export const MENTION_RE = /@([\p{L}\p{N}_]+)/gu
/** Numbered media token. Group 1 = kind, group 2 = number. */
export const TOKEN_RE = /@(image|video)_(\d+)\b/gi
const RAW_TOKEN = /^(image|video)_\d+$/i

export function sceneCode(order: number): string {
  return 'S' + String(order).padStart(2, '0')
}

export function takeCode(sceneOrder: number | null | undefined, takeNumber: number): string {
  return `${sceneOrder ? sceneCode(sceneOrder) : 'S??'}·T${takeNumber}`
}

/** Strip Vietnamese diacritics and spaces to build a tag: "Bé An" -> "BeAn". */
export function slugTag(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9_ ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
  return base || 'Asset'
}

export function uniqueTag(name: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((t) => t.toLowerCase()))
  let base = slugTag(name)
  if (RAW_TOKEN.test(base)) base = base + 'X'
  if (!set.has(base.toLowerCase())) return base
  for (let i = 2; i < 999; i++) if (!set.has((base + i).toLowerCase())) return base + i
  return base + Date.now()
}

/** Legacy @Tag mentions in a text, in order of first appearance, without duplicates (case-insensitive). */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    const tag = m[1]
    const key = tag.toLowerCase()
    if (RAW_TOKEN.test(tag) || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

export function assetByTag(assets: Asset[], tag: string): Asset | undefined {
  const key = tag.toLowerCase()
  return assets.find((a) => a.tag.toLowerCase() === key)
}

// ---------------------------------------------------------------------------------------------
// Numbered tokens
// ---------------------------------------------------------------------------------------------

export interface TokenMatch {
  kind: 'image' | 'video'
  n: number
  start: number
  end: number
}

/** All @image_N / @video_N tokens with their positions (for highlighting and validation). */
export function parseTokens(text: string): TokenMatch[] {
  const out: TokenMatch[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    out.push({ kind: m[1].toLowerCase() as 'image' | 'video', n: Number(m[2]), start: m.index!, end: m.index! + m[0].length })
  }
  return out
}

export interface ImageSlot {
  n: number
  assetId: string
  imageId: string
  /** Index of the image inside its asset (0 = primary). */
  imageIndex: number
}

/** Numbered reference images of a list of asset ids (each image of an asset gets its own number). */
export function imageSlotsFor(assets: Asset[], refs: string[]): ImageSlot[] {
  const byId = new Map(assets.map((a) => [a.id, a]))
  const out: ImageSlot[] = []
  for (const id of refs) {
    const a = byId.get(id)
    if (!a) continue
    a.imageIds.forEach((imageId, imageIndex) => out.push({ n: out.length + 1, assetId: a.id, imageId, imageIndex }))
  }
  return out
}

export function imageSlots(project: Project, scene: Scene): ImageSlot[] {
  return imageSlotsFor(project.assets, scene.refs)
}

/** Stable identity of an image slot used by the renumbering (survives reorders). */
export const imageKey = (s: { assetId: string; imageId: string }) => `${s.assetId}:${s.imageId}`

/** "@image_N" for the primary image of an asset in this scene, or null when the asset is not linked / has no image. */
export function tokenForAsset(project: Project, scene: Scene, assetId: string): string | null {
  const slot = imageSlots(project, scene).find((s) => s.assetId === assetId)
  return slot ? `@image_${slot.n}` : null
}

export function tokenForVideo(scene: Scene, takeId: string): string | null {
  const i = scene.videoRefs.indexOf(takeId)
  return i >= 0 ? `@video_${i + 1}` : null
}

/**
 * Rewrite @image_N / @video_N tokens after the references changed so every token keeps pointing at the same
 * image/video. Tokens whose image/video disappeared are replaced with `fallback(kind, key)` (e.g. the asset name).
 * Tokens that were already invalid (number out of range before the change) are left untouched.
 */
export function remapTokens(
  text: string,
  before: { images: string[]; videos: string[] },
  after: { images: string[]; videos: string[] },
  fallback: (kind: 'image' | 'video', key: string) => string,
): { text: string; dropped: number; changed: boolean } {
  let dropped = 0
  let changed = false
  const out = text.replace(TOKEN_RE, (whole, rawKind: string, rawN: string) => {
    const kind = rawKind.toLowerCase() as 'image' | 'video'
    const oldKeys = kind === 'image' ? before.images : before.videos
    const newKeys = kind === 'image' ? after.images : after.videos
    const key = oldKeys[Number(rawN) - 1]
    if (key === undefined) return whole
    const idx = newKeys.indexOf(key)
    const next = idx >= 0 ? `@${kind}_${idx + 1}` : fallback(kind, key)
    if (idx < 0) dropped++
    if (next !== whole) changed = true
    return next
  })
  return { text: out, dropped, changed }
}

/** Keys of a scene's media before/after a change — input for remapTokens. */
export function mediaKeys(assets: Asset[], refs: string[], videoRefs: string[]) {
  return { images: imageSlotsFor(assets, refs).map(imageKey), videos: [...videoRefs] }
}

// ---------------------------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------------------------

export interface CompileOptions {
  /** Status of takes by id, to warn about reference videos that are not usable. */
  takeStatus?: (takeId: string) => string | undefined
}

/**
 * Compile the prompt that would be sent for one scene. Pure function.
 * The text is the scene prompt as written; legacy @Tag mentions are converted to @image_N.
 */
export function compileScene(project: Project, scene: Scene, opts: CompileOptions = {}): CompiledPrompt {
  const spec = MODELS[scene.settings.model]
  const limit = spec.promptLimit(scene.settings.mode)
  const warnings: string[] = []
  const notes: string[] = []
  const sendsImages = usesRefs(scene.settings)
  const sendsVideos = usesVideoRefs(scene.settings)
  const assetMap = new Map(project.assets.map((a) => [a.id, a]))

  // Images
  const allSlots = imageSlots(project, scene)
  const images: CompiledImage[] = sendsImages ? allSlots.slice(0, spec.maxRefImages).map(({ n, assetId, imageId }) => ({ n, assetId, imageId })) : []
  if (sendsImages && allSlots.length > spec.maxRefImages) {
    warnings.push(`${spec.name} nhận tối đa ${spec.maxRefImages} ảnh; ${allSlots.length - spec.maxRefImages} ảnh cuối sẽ không được gửi.`)
  }
  for (const id of scene.refs) {
    const a = assetMap.get(id)
    if (a && !a.imageIds.length) warnings.push(`“${a.name}” chưa có ảnh nên không được gửi.`)
  }
  if (scene.settings.mode === 'i2v' && images.length === 0) warnings.push('Chế độ Ảnh → Video cần ít nhất 1 ảnh tham chiếu.')
  if (!sendsImages && scene.refs.length) notes.push(`Chế độ ${scene.settings.mode.toUpperCase()} của ${spec.name} không gửi ảnh tham chiếu.`)

  // Videos
  const videos: CompiledVideo[] = sendsVideos ? scene.videoRefs.slice(0, spec.maxRefVideos).map((takeId, i) => ({ n: i + 1, takeId })) : []
  if (sendsVideos && scene.videoRefs.length > spec.maxRefVideos) {
    warnings.push(`${spec.name} nhận tối đa ${spec.maxRefVideos} video tham chiếu; ${scene.videoRefs.length - spec.maxRefVideos} video cuối sẽ không được gửi.`)
  }
  if (!sendsVideos && scene.videoRefs.length) warnings.push(`Chế độ này của ${spec.name} không nhận video tham chiếu.`)
  if (opts.takeStatus) {
    scene.videoRefs.forEach((id, i) => {
      const st = opts.takeStatus!(id)
      if (st === undefined) warnings.push(`@video_${i + 1} trỏ tới một take đã bị xoá.`)
      else if (st !== 'completed') warnings.push(`@video_${i + 1} chưa tạo xong.`)
    })
  }

  if (scene.settings.mode === 'transform' && (!scene.firstFrame || !scene.lastFrame)) {
    warnings.push('Chế độ Khung đầu → cuối cần đủ Khung đầu và Khung cuối.')
  }

  // Legacy @Tag mentions -> @image_N
  const unknown = new Set<string>()
  const notLinked = new Set<string>()
  const text = scene.prompt.trim().replace(MENTION_RE, (whole, tag: string) => {
    if (RAW_TOKEN.test(tag)) return whole
    const asset = assetByTag(project.assets, tag)
    if (!asset) {
      // Not an asset tag: probably just an "@" in the text. Only report things that look like tags.
      if (/^\p{Lu}/u.test(tag)) unknown.add(tag)
      return whole
    }
    const slot = allSlots.find((s) => s.assetId === asset.id)
    if (slot) return `@image_${slot.n}`
    notLinked.add(asset.name)
    return asset.name
  })
  for (const t of unknown) notes.push(`@${t} không phải nhân vật trong thư viện nên được giữ nguyên.`)
  for (const t of notLinked) warnings.push(`“${t}” được nhắc trong prompt nhưng chưa nối vào cảnh.`)

  // Token validation
  const tokens = parseTokens(text)
  const usedImages = new Set<number>()
  const usedVideos = new Set<number>()
  if (!sendsImages && tokens.some((t) => t.kind === 'image')) {
    warnings.push(`Chế độ ${scene.settings.mode.toUpperCase()} của ${spec.name} không gửi ảnh: các @image_N sẽ chỉ là chữ trong prompt.`)
  }
  if (!sendsVideos && tokens.some((t) => t.kind === 'video')) {
    warnings.push(`Chế độ này của ${spec.name} không gửi video: các @video_N sẽ chỉ là chữ trong prompt.`)
  }
  for (const t of tokens) {
    if (t.kind === 'image') {
      usedImages.add(t.n)
      if (t.n < 1 || t.n > allSlots.length) warnings.push(`@image_${t.n} không tồn tại (cảnh có ${allSlots.length} ảnh).`)
    } else {
      usedVideos.add(t.n)
      if (t.n < 1 || t.n > scene.videoRefs.length) warnings.push(`@video_${t.n} không tồn tại (cảnh có ${scene.videoRefs.length} video).`)
    }
  }
  const unusedImages = images.filter((i) => !usedImages.has(i.n)).map((i) => `@image_${i.n}`)
  if (unusedImages.length) notes.push(`${unusedImages.join(', ')} chưa được nhắc trong prompt (vẫn được gửi).`)
  const unusedVideos = videos.filter((v) => !usedVideos.has(v.n)).map((v) => `@video_${v.n}`)
  if (unusedVideos.length) notes.push(`${unusedVideos.join(', ')} chưa được nhắc trong prompt (vẫn được gửi).`)

  if (!text) warnings.push('Prompt của cảnh đang trống.')
  const charCount = [...text].length
  if (charCount > limit) warnings.push(`Prompt dài ${charCount.toLocaleString('vi-VN')} ký tự, vượt giới hạn ${limit.toLocaleString('vi-VN')}.`)

  const assetIds = [...new Set(images.map((i) => i.assetId))]
  return { text, images, videos, assetIds, charCount, limit, warnings: [...new Set(warnings)], notes }
}
