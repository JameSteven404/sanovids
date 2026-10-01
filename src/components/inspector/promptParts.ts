// Split a compiled prompt back into labelled parts (blocks / continuity / scene prompt / auto references)
// so the preview can show where each paragraph comes from. Pure; falls back to one raw part if the
// reconstruction does not match the compiler output exactly.
import { assetByTag, isBlockOn, MENTION_RE, sceneCode } from '../../core/compile'
import type { CompiledPrompt, Project, Scene } from '../../core/types'

export type PromptPartKind = 'block' | 'continuity' | 'body' | 'refs' | 'raw'

export interface PromptPart {
  key: string
  kind: PromptPartKind
  label: string
  color: string | null
  text: string
}

const RAW_IMAGE = /^image_\d+$/i

export function splitCompiled(project: Project, scene: Scene, compiled: CompiledPrompt): PromptPart[] {
  const raw: PromptPart[] = compiled.text ? [{ key: 'raw', kind: 'raw', label: '', color: null, text: compiled.text }] : []
  const firstN = new Map<string, number>()
  for (const img of compiled.images) if (!firstN.has(img.assetId)) firstN.set(img.assetId, img.n)
  const replace = (t: string) =>
    t.replace(MENTION_RE, (whole, tag: string) => {
      if (RAW_IMAGE.test(tag)) return whole
      const a = assetByTag(project.assets, tag)
      if (!a) return whole
      const n = firstN.get(a.id)
      return n ? `@image_${n}` : a.name
    })

  const head: PromptPart[] = []
  const tail: PromptPart[] = []
  for (const b of project.blocks) {
    if (!isBlockOn(scene, b) || !b.text.trim()) continue
    if (b.placement !== 'before') continue
    head.push({ key: 'b:' + b.id, kind: 'block', label: b.title || 'Khối', color: b.color, text: replace(b.text.trim()) })
  }
  if (project.settings.autoContinuity && scene.continueFrom) {
    const prev = project.scenes.find((s) => s.id === scene.continueFrom)
    if (prev && !/previous scene/i.test(scene.prompt)) {
      head.push({
        key: 'cont',
        kind: 'continuity',
        label: `Tiếp nối từ ${sceneCode(prev.order)}`,
        color: 'var(--seq)',
        text: `Continue directly from the previous scene (${sceneCode(prev.order)}${prev.title ? ': ' + prev.title : ''}).`,
      })
    }
  }
  const body = replace(scene.prompt.trim())
  if (body) head.push({ key: 'body', kind: 'body', label: 'Prompt cảnh', color: 'var(--accent)', text: body })
  for (const b of project.blocks) {
    if (!isBlockOn(scene, b) || !b.text.trim()) continue
    if (b.placement !== 'after') continue
    tail.push({ key: 'b:' + b.id, kind: 'block', label: b.title || 'Khối', color: b.color, text: replace(b.text.trim()) })
  }

  const headText = head.map((p) => p.text).join('\n\n')
  const tailText = tail.map((p) => p.text).join('\n\n')
  let rest = compiled.text
  if (headText) {
    if (!rest.startsWith(headText)) return raw
    rest = rest.slice(headText.length)
    if (rest.startsWith('\n\n')) rest = rest.slice(2)
    else if (rest) return raw
  }
  if (tailText) {
    if (!rest.endsWith(tailText)) return raw
    rest = rest.slice(0, rest.length - tailText.length)
    if (rest.endsWith('\n\n')) rest = rest.slice(0, -2)
    else if (rest) return raw
  }
  const middle: PromptPart[] = rest ? [{ key: 'refs', kind: 'refs', label: 'Tham chiếu (tự động)', color: 'var(--ref)', text: rest }] : []
  return [...head, ...middle, ...tail]
}
