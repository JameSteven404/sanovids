import { MODELS, usesRefs } from './models'
import type { Asset, CompiledImage, CompiledPrompt, Project, PromptBlock, Scene } from './types'

/** @Tag mention: letters (incl. Vietnamese), digits, underscore. */
export const MENTION_RE = /@([\p{L}\p{N}_]+)/gu
const RAW_IMAGE_TOKEN = /^image_\d+$/i

export function sceneCode(order: number): string {
  return 'S' + String(order).padStart(2, '0')
}

/** Strip Vietnamese diacritics and spaces to build a mention tag: "Bé An" -> "BeAn". */
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
  const base = slugTag(name)
  if (!set.has(base.toLowerCase())) return base
  for (let i = 2; i < 999; i++) if (!set.has((base + i).toLowerCase())) return base + i
  return base + Date.now()
}

/** Tags mentioned in a text, in order of first appearance, without duplicates (case-insensitive). */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    const tag = m[1]
    const key = tag.toLowerCase()
    if (RAW_IMAGE_TOKEN.test(tag) || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

export function assetByTag(assets: Asset[], tag: string): Asset | undefined {
  const key = tag.toLowerCase()
  return assets.find((a) => a.tag.toLowerCase() === key)
}

export function isBlockOn(scene: Scene, block: PromptBlock): boolean {
  return scene.blockOverrides[block.id] ?? block.defaultOn
}

export const DEFAULT_REFERENCES_TEMPLATE =
  "References (upload in this order; use each image only for that character's or place's look): {list}."

/**
 * The automatic "continue from the previous scene" line, or null when auto-continuity is off, the scene
 * continues from nothing, or its prompt / an active block already talks about the previous scene.
 */
export function continuityLine(project: Project, scene: Scene): string | null {
  if (!project.settings.autoContinuity || !scene.continueFrom) return null
  const prev = project.scenes.find((s) => s.id === scene.continueFrom)
  if (!prev) return null
  const texts = [scene.prompt, ...project.blocks.filter((b) => isBlockOn(scene, b)).map((b) => b.text)]
  if (texts.some((t) => /previous scene/i.test(t))) return null
  return `Continue directly from the previous scene (${sceneCode(prev.order)}${prev.title ? ': ' + prev.title : ''}).`
}

/**
 * Compile the final prompt that would be sent to the provider for one scene.
 * Pure function: same input -> same output. Used by the inspector preview, the run queue and "Copy".
 */
export function compileScene(project: Project, scene: Scene): CompiledPrompt {
  const spec = MODELS[scene.settings.model]
  const limit = spec.promptLimit(scene.settings.mode)
  const warnings: string[] = []
  const assetMap = new Map(project.assets.map((a) => [a.id, a]))
  const sendsRefs = usesRefs(scene.settings)

  // 1) Number the reference images in scene.refs order.
  const images: CompiledImage[] = []
  const firstN = new Map<string, number[]>()
  const refAssets: Asset[] = []
  if (sendsRefs) {
    for (const id of scene.refs) {
      const asset = assetMap.get(id)
      if (!asset) continue
      if (!asset.imageIds.length) {
        warnings.push(`@${asset.tag} chưa có ảnh nên không được gửi.`)
        continue
      }
      const ns: number[] = []
      for (const imageId of asset.imageIds) {
        if (images.length >= spec.maxRefImages) break
        const n = images.length + 1
        images.push({ n, assetId: asset.id, imageId })
        ns.push(n)
      }
      if (ns.length) {
        firstN.set(asset.id, ns)
        refAssets.push(asset)
      }
    }
    const totalImages = scene.refs.reduce((t, id) => t + (assetMap.get(id)?.imageIds.length ?? 0), 0)
    if (totalImages > spec.maxRefImages) {
      warnings.push(`${spec.name} nhận tối đa ${spec.maxRefImages} ảnh; ${totalImages - spec.maxRefImages} ảnh cuối bị bỏ.`)
    }
    if (scene.settings.mode === 'i2v' && images.length === 0) warnings.push('Chế độ Ảnh → Video cần ít nhất 1 ảnh tham chiếu.')
  }

  if (scene.settings.mode === 'transform') {
    if (!scene.firstFrame || !scene.lastFrame) warnings.push('Chế độ Khung đầu → cuối cần đủ Khung đầu và Khung cuối.')
  }

  // 2) Replace @Tag mentions.
  const unknown = new Set<string>()
  const notLinked = new Set<string>()
  const replaceMentions = (text: string) =>
    text.replace(MENTION_RE, (whole, tag: string) => {
      if (RAW_IMAGE_TOKEN.test(tag)) return whole
      const asset = assetByTag(project.assets, tag)
      if (!asset) {
        unknown.add(tag)
        return whole
      }
      const ns = firstN.get(asset.id)
      if (ns && ns.length) return `@image_${ns[0]}`
      // Linked but sending no image (no images / over the model limit) already has its own warning.
      if (sendsRefs && !scene.refs.includes(asset.id)) notLinked.add(asset.tag)
      return asset.name
    })

  const parts: string[] = []
  const before = project.blocks.filter((b) => b.placement === 'before' && isBlockOn(scene, b))
  const after = project.blocks.filter((b) => b.placement === 'after' && isBlockOn(scene, b))
  for (const b of before) if (b.text.trim()) parts.push(replaceMentions(b.text.trim()))

  const continuity = continuityLine(project, scene)
  if (continuity) parts.push(continuity)

  const body = replaceMentions(scene.prompt.trim())
  if (body) parts.push(body)
  else warnings.push('Prompt của cảnh đang trống.')

  if (project.settings.autoReferences && refAssets.length) {
    const list = refAssets
      .map((a) => {
        const ns = firstN.get(a.id) ?? []
        const tokens = ns.map((n) => `@image_${n}`).join(', ')
        const desc = a.description.trim() ? ` (${a.description.trim()})` : ''
        return `${tokens} = ${a.name}${desc}`
      })
      .join('; ')
    const template = project.settings.referencesTemplate || DEFAULT_REFERENCES_TEMPLATE
    parts.push(template.replace('{list}', list))
  }

  for (const b of after) if (b.text.trim()) parts.push(replaceMentions(b.text.trim()))

  for (const t of unknown) warnings.push(`Không tìm thấy @${t} trong thư viện.`)
  for (const t of notLinked) warnings.push(`@${t} có trong prompt nhưng chưa được nối vào cảnh.`)

  const text = parts.join('\n\n')
  const charCount = [...text].length
  if (charCount > limit) warnings.push(`Prompt dài ${charCount.toLocaleString('vi-VN')} ký tự, vượt giới hạn ${limit.toLocaleString('vi-VN')}.`)

  return { text, images, assetIds: refAssets.map((a) => a.id), charCount, limit, warnings }
}
