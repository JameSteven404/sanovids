// Schema migrations for saved projects and takes. Pure functions (unit-tested).
import { scenePosition } from '../store/project'
import { assetByTag, imageSlotsFor, mediaKeys, MENTION_RE, remapTokens, uniqueTag } from './compile'
import { newId, pickColor } from './ids'
import { normalizeSettings } from './models'
import type { Asset, AssetKind, Preset, Project, Scene, Take, XY } from './types'

interface V1Block {
  id: string
  text: string
  placement: 'before' | 'after'
  defaultOn: boolean
}

const ASSET_KINDS: AssetKind[] = ['character', 'location', 'prop', 'style']
const isXY = (v: unknown): v is XY => !!v && typeof v === 'object' && Number.isFinite((v as XY).x) && Number.isFinite((v as XY).y)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [])
const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v))

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

/** Assets with every field present and unique ids/tags (files from other sources may miss some). */
function normalizeAssets(raw: unknown): Asset[] {
  const ids = new Set<string>()
  const tags: string[] = []
  return (Array.isArray(raw) ? raw : []).map((r, i) => {
    const a = (r ?? {}) as Partial<Asset>
    let id = typeof a.id === 'string' && a.id ? a.id : newId('ast')
    if (ids.has(id)) id = newId('ast')
    ids.add(id)
    const name = text(a.name).trim() ? text(a.name) : 'Không tên'
    const free = typeof a.tag === 'string' && !!a.tag && !tags.some((t) => t.toLowerCase() === a.tag!.toLowerCase())
    const tag = free ? a.tag! : uniqueTag(name, tags)
    tags.push(tag)
    return {
      ...a,
      id,
      kind: ASSET_KINDS.includes(a.kind as AssetKind) ? (a.kind as AssetKind) : 'character',
      name,
      tag,
      description: text(a.description),
      imageIds: strings(a.imageIds),
      color: typeof a.color === 'string' && a.color ? a.color : pickColor(i),
      position: isXY(a.position) ? a.position : null,
    }
  })
}

/** Presets with an id, a name and valid settings (files from other sources may miss some). */
export function normalizePresets(raw: unknown): Preset[] {
  const ids = new Set<string>()
  return (Array.isArray(raw) ? raw : [])
    .filter((r): r is Partial<Preset> => !!r && typeof r === 'object')
    .map((r) => {
      let id = typeof r.id === 'string' && r.id ? r.id : newId('pst')
      if (ids.has(id)) id = newId('pst')
      ids.add(id)
      return { id, name: text(r.name).trim() || 'Preset', ...normalizeSettings(r) }
    })
}

/**
 * Bring any saved project up to schema v2 (and repair what other sources may leave out).
 * v1 → v2: enabled prompt blocks are written into each scene's prompt (so no text is lost),
 * @Tag mentions become @image_N, continuity links and block data are dropped, scenes get videoRefs.
 * Always: unique ids, dense scene order (S01, S02… never "Sundefined"), a position and a title for every scene.
 */
export function migrateProject(raw: unknown): Project {
  const p = (raw ?? {}) as Record<string, unknown> & Partial<Project>
  const assets = normalizeAssets(p.assets)
  const presets = normalizePresets(p.presets)
  const presetIds = new Set(presets.map((x) => x.id))
  const blocks = ((p as { blocks?: V1Block[] }).blocks ?? []) as V1Block[]
  const v1 = p.schemaVersion !== 2
  const sceneIds = new Set<string>()

  const rawScenes = ((Array.isArray(p.scenes) ? p.scenes : []) as (Scene & { blockOverrides?: Record<string, boolean>; continueFrom?: unknown })[]).map(
    (s) => s ?? ({} as Scene),
  )
  // Dense order 1..n following the saved order (scenes without one go last, in file order); the list keeps its order.
  const orderKey = (s: Scene) => (Number.isFinite(s.order) ? s.order : Infinity)
  const rank = new Map(
    rawScenes
      .map((s, i) => ({ s, i }))
      .sort((a, b) => orderKey(a.s) - orderKey(b.s) || a.i - b.i)
      .map(({ s }, r) => [s, r] as const),
  )
  const scenes: Scene[] = rawScenes.map((s) => {
    const index = rank.get(s)!
    const { blockOverrides, continueFrom: _c, ...rest } = s
    const refs = strings(s.refs)
    let prompt = text(s.prompt)
    if (v1) {
      const on = (b: V1Block) => (blockOverrides ?? {})[b.id] ?? b.defaultOn
      const before = blocks.filter((b) => b.placement === 'before' && on(b) && b.text.trim()).map((b) => b.text.trim())
      const after = blocks.filter((b) => b.placement === 'after' && on(b) && b.text.trim()).map((b) => b.text.trim())
      prompt = [...before, prompt.trim(), ...after].filter(Boolean).join('\n\n')
      prompt = tagsToTokens(prompt, assets, refs)
    }
    let id = typeof s.id === 'string' && s.id ? s.id : newId('scn')
    if (sceneIds.has(id)) id = newId('scn')
    sceneIds.add(id)
    return {
      ...rest,
      id,
      order: index + 1,
      title: text(s.title),
      prompt,
      refs,
      videoRefs: strings(s.videoRefs),
      settings: normalizeSettings(s.settings ?? {}),
      firstFrame: s.firstFrame ?? null,
      lastFrame: s.lastFrame ?? null,
      color: s.color ?? null,
      position: isXY(s.position) ? s.position : scenePosition(index),
      note: text(s.note),
      presetId: typeof s.presetId === 'string' && presetIds.has(s.presetId) ? s.presetId : null,
    }
  })

  const { blocks: _b, ...restProject } = p as Record<string, unknown>
  const now = Date.now()
  return {
    ...(restProject as unknown as Project),
    id: typeof p.id === 'string' && p.id ? p.id : newId('prj'),
    name: text(p.name).trim() ? text(p.name) : 'Dự án',
    schemaVersion: 2,
    createdAt: Number.isFinite(p.createdAt) ? p.createdAt! : now,
    updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt! : now,
    assets,
    presets,
    scenes,
    settings: { autoRenumber: (p.settings as { autoRenumber?: boolean } | undefined)?.autoRenumber ?? true },
  }
}

/**
 * The project without any video reference (a copy or an imported file has none of the takes): every @video_N
 * becomes the plain text `label(takeId)` (e.g. "video S03·T2"), like removing the reference by hand.
 * @image_N tokens are unchanged.
 */
export function dropVideoRefs(p: Project, label: (takeId: string) => string = () => 'video'): Project {
  if (!p.scenes.some((s) => s.videoRefs.length)) return p
  return {
    ...p,
    scenes: p.scenes.map((s) => {
      if (!s.videoRefs.length) return s
      const before = mediaKeys(p.assets, s.refs, s.videoRefs)
      const prompt = remapTokens(s.prompt, before, { ...before, videos: [] }, (_kind, key) => label(key)).text
      return { ...s, videoRefs: [], prompt }
    }),
  }
}

/**
 * Bring a saved take up to date. Provider fields default to the demo provider: takes saved before providers
 * existed ran on the mock, were never submitted anywhere (no remote id) and were paid with demo credits.
 */
export function migrateTake(raw: unknown): Take {
  const t = (raw ?? {}) as Partial<Take>
  const frames = t.framesSnapshot
  const out: Take = {
    ...(t as Take),
    videoRefsSnapshot: Array.isArray(t.videoRefsSnapshot) ? t.videoRefsSnapshot : [],
    position: t.position ?? null,
    provider: t.provider === 'canvasapp' ? 'canvasapp' : 'mock',
    remoteId: typeof t.remoteId === 'string' && t.remoteId ? t.remoteId : null,
    charged: t.charged !== false,
  }
  if (t.submitUnknown === true) out.submitUnknown = true
  else delete out.submitUnknown
  if (frames && typeof frames === 'object') out.framesSnapshot = { first: frames.first ?? null, last: frames.last ?? null }
  else delete out.framesSnapshot
  if (t.imageKeysSnapshot !== undefined) {
    if (Array.isArray(t.imageKeysSnapshot) && t.imageKeysSnapshot.every((k) => typeof k === 'string')) out.imageKeysSnapshot = [...t.imageKeysSnapshot]
    else delete out.imageKeysSnapshot
  }
  return out
}
