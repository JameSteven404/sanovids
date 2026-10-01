// Schema migrations for saved projects and takes. Pure functions (unit-tested).
import { assetByTag, imageSlotsFor, MENTION_RE } from './compile'
import { normalizeSettings } from './models'
import type { Asset, Project, Scene, Take } from './types'

interface V1Block {
  id: string
  text: string
  placement: 'before' | 'after'
  defaultOn: boolean
}

/** Replace legacy @Tag mentions with @image_N of the scene's refs (unlinked tags become the asset name). */
export function tagsToTokens(prompt: string, assets: Asset[], refs: string[]): string {
  const slots = imageSlotsFor(assets, refs)
  return prompt.replace(MENTION_RE, (whole, tag: string) => {
    if (/^(image|video)_\d+$/i.test(tag)) return whole
    const asset = assetByTag(assets, tag)
    if (!asset) return whole
    const slot = slots.find((s) => s.assetId === asset.id)
    return slot ? `@image_${slot.n}` : asset.name
  })
}

/**
 * Bring any saved project up to schema v2.
 * v1 → v2: enabled prompt blocks are written into each scene's prompt (so no text is lost),
 * @Tag mentions become @image_N, continuity links and block data are dropped, scenes get videoRefs.
 */
export function migrateProject(raw: unknown): Project {
  const p = raw as Record<string, unknown> & Partial<Project>
  const assets = (p.assets ?? []) as Asset[]
  const blocks = ((p as { blocks?: V1Block[] }).blocks ?? []) as V1Block[]
  const v1 = p.schemaVersion !== 2

  const scenes: Scene[] = ((p.scenes ?? []) as (Scene & { blockOverrides?: Record<string, boolean>; continueFrom?: unknown })[]).map((s) => {
    const { blockOverrides, continueFrom: _c, ...rest } = s
    let prompt = String(s.prompt ?? '')
    if (v1) {
      const on = (b: V1Block) => (blockOverrides ?? {})[b.id] ?? b.defaultOn
      const before = blocks.filter((b) => b.placement === 'before' && on(b) && b.text.trim()).map((b) => b.text.trim())
      const after = blocks.filter((b) => b.placement === 'after' && on(b) && b.text.trim()).map((b) => b.text.trim())
      prompt = [...before, prompt.trim(), ...after].filter(Boolean).join('\n\n')
      prompt = tagsToTokens(prompt, assets, s.refs ?? [])
    }
    return {
      ...rest,
      prompt,
      refs: Array.isArray(s.refs) ? s.refs : [],
      videoRefs: Array.isArray(s.videoRefs) ? s.videoRefs : [],
      settings: normalizeSettings(s.settings ?? {}),
      firstFrame: s.firstFrame ?? null,
      lastFrame: s.lastFrame ?? null,
      color: s.color ?? null,
      note: s.note ?? '',
      presetId: s.presetId ?? null,
    }
  })

  const { blocks: _b, ...restProject } = p as Record<string, unknown>
  return {
    ...(restProject as unknown as Project),
    schemaVersion: 2,
    assets,
    presets: (p.presets ?? []) as Project['presets'],
    scenes,
    settings: { autoRenumber: (p.settings as { autoRenumber?: boolean } | undefined)?.autoRenumber ?? true },
  }
}

export function migrateTake(raw: unknown): Take {
  const t = raw as Partial<Take>
  return {
    ...(t as Take),
    videoRefsSnapshot: Array.isArray(t.videoRefsSnapshot) ? t.videoRefsSnapshot : [],
    position: t.position ?? null,
  }
}
