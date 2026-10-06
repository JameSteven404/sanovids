// Schema migrations for saved projects and takes. Pure functions (unit-tested).
import { scenePosition } from '../store/project'
import { assetByTag, imageSlotsFor, mediaKeys, MENTION_RE, remapTokens, uniqueTag } from './compile'
import { cleanTakeFileName } from './fileNames'
import { normalizeFolders } from './folders'
import { newId, pickColor } from './ids'
import { cleanForeignSettings, foreignId } from './foreignMark'
import { isModelId, normalizeSettings } from './models'
import type { Asset, AssetKind, ForeignSettings, JobStatus, Preset, Project, Scene, Take, TakeProvider, VideoSettings, XY } from './types'

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

// ---------------- data of a newer SanoVids build (see Scene.foreignModel, Take.foreignProvider) ----------------
// A newer build may save a model / provider this build does not know (e.g. a later provider's video model). Turning
// such a scene into Seedance 2.5 would let "Chạy" bill the user's canvasapp account for a scene they made for another
// service, so the id is kept as a marker that blocks running (core/runRules) and the original settings are kept too
// (the stand-in `settings`, which every reader keeps using, would otherwise overwrite them at the next autosave).

// The id / settings cleaning lives in ./foreignMark (pure, no store import: store/project uses it too).
export { cleanForeignSettings, FOREIGN_ID_MAX, FOREIGN_SETTINGS_MAX_BYTES, FOREIGN_SETTINGS_MAX_KEYS, foreignMarkOf } from './foreignMark'

/** Error of a take a newer build was still running (parked as 'failed' here, see migrateTake). */
export const FOREIGN_RUNNING_ERROR = 'Video này đang tạo bằng SanoVids bản mới hơn — mở bằng bản đó để theo dõi.'

const KNOWN_PROVIDERS: readonly string[] = ['mock', 'canvasapp', 'dev'] satisfies TakeProvider[]

/** Settings + newer-build marker of a scene or preset, as migrate keeps them. */
interface ModelMark {
  settings: VideoSettings
  foreignModel?: string
  foreignSettings?: ForeignSettings
}

const markOf = (settings: VideoSettings, model: string | null, foreign: ForeignSettings | null): ModelMark => ({
  settings,
  ...(model ? { foreignModel: model } : {}),
  ...(model && foreign ? { foreignSettings: foreign } : {}),
})

/**
 * Valid settings of a scene / preset and its newer-build marker:
 * - the saved settings name a model this build does not know (non-blank string, not a MODELS key) → the marker is
 *   that id + the saved settings (cleanForeignSettings), `settings` the stand-in values of normalizeSettings;
 * - else a marker saved with it (by a build that kept one) is validated and kept (foreignSettings without a
 *   foreignModel is dropped); once the build knows that model, `settings` are restored from the marker
 *   (foreignSettings + foreignModel) and the marker goes — what the build that brings the model does;
 * - else no marker (an empty / missing model is the old default, Seedance 2.5, as always).
 * `omit`: keys of `rawSettings` that are not settings (a preset is its own settings object: id, name, marker).
 */
function migrateModelMark(rawSettings: unknown, saved: { foreignModel?: unknown; foreignSettings?: unknown }, omit: readonly string[] = []): ModelMark {
  const raw = (rawSettings && typeof rawSettings === 'object' ? rawSettings : {}) as Partial<VideoSettings>
  const model: unknown = raw.model
  const settings = normalizeSettings(raw)
  if (typeof model === 'string' && model.trim() && !isModelId(model)) return markOf(settings, foreignId(model), cleanForeignSettings(raw, omit))
  const kept = typeof saved.foreignModel === 'string' && saved.foreignModel.trim() ? saved.foreignModel : null
  if (!kept) return markOf(settings, null, null)
  const keptSettings = cleanForeignSettings(saved.foreignSettings)
  if (isModelId(kept)) return markOf(normalizeSettings({ ...(keptSettings ?? {}), model: kept } as Partial<VideoSettings>), null, null)
  return markOf(settings, foreignId(kept), keptSettings)
}

const PRESET_NOT_SETTINGS = ['id', 'name', 'foreignModel', 'foreignSettings']

/**
 * Presets with an id, a name and valid settings (files from other sources may miss some). A preset of a newer
 * build's model keeps its marker (see migrateModelMark): applying it keeps the scenes blocked.
 */
export function normalizePresets(raw: unknown): Preset[] {
  const ids = new Set<string>()
  return (Array.isArray(raw) ? raw : [])
    .filter((r): r is Partial<Preset> => !!r && typeof r === 'object')
    .map((r) => {
      let id = typeof r.id === 'string' && r.id ? r.id : newId('pst')
      if (ids.has(id)) id = newId('pst')
      ids.add(id)
      const { settings, ...marker } = migrateModelMark(r, r, PRESET_NOT_SETTINGS)
      return { id, name: text(r.name).trim() || 'Preset', ...settings, ...marker }
    })
}

/**
 * Bring any saved project up to schema v2 (and repair what other sources may leave out).
 * v1 → v2: enabled prompt blocks are written into each scene's prompt (so no text is lost),
 * @Tag mentions become @image_N, continuity links and block data are dropped, scenes get videoRefs.
 * Always: unique ids, dense scene order (S01, S02… never "Sundefined"), a position and a title for every scene.
 * A file of a newer build (schemaVersion > 2) is read as v2; scenes / presets on a model this build does not know keep
 * it as a marker that blocks running (Scene.foreignModel / foreignSettings, see migrateModelMark). The result is
 * always schemaVersion 2.
 */
export function migrateProject(raw: unknown): Project {
  const p = (raw ?? {}) as Record<string, unknown> & Partial<Project>
  const assets = normalizeAssets(p.assets)
  const presets = normalizePresets(p.presets)
  const presetIds = new Set(presets.map((x) => x.id))
  const blocks = ((p as { blocks?: V1Block[] }).blocks ?? []) as V1Block[]
  // Only versions before 2 are v1: a file of a newer build (schemaVersion 3…) must not get its @image_N / @Tag text
  // rewritten as v1 prompts (it is read as v2; unknown fields are kept, unknown models become markers).
  const v1 = !(typeof p.schemaVersion === 'number' && p.schemaVersion >= 2)
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
    const { blockOverrides, continueFrom: _c, foreignModel: _fm, foreignSettings: _fs, ...rest } = s
    // Valid settings + the marker of a newer build's model (validated, never taken from the file as is).
    const { settings, ...marker } = migrateModelMark(s.settings, s)
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
      settings,
      firstFrame: s.firstFrame ?? null,
      lastFrame: s.lastFrame ?? null,
      color: s.color ?? null,
      position: isXY(s.position) ? s.position : scenePosition(index),
      note: text(s.note),
      presetId: typeof s.presetId === 'string' && presetIds.has(s.presetId) ? s.presetId : null,
      ...marker,
    }
  })

  const { blocks: _b, folders: rawFolders, ...restProject } = p as Record<string, unknown>
  const now = Date.now()
  const out: Project = {
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
  // "Thư mục" nodes: ids that collide with no scene / asset node, links to scenes that still exist. Projects without
  // folders keep no `folders` key (older files stay byte-for-byte the same after a load).
  const folders = normalizeFolders(rawFolders, new Set([...assets.map((a) => a.id), ...scenes.map((s) => s.id)]), sceneIds)
  if (folders.length) out.folders = folders
  return out
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
 * A take of a newer build's provider (foreignProvider) that was still queued / running there: parked as 'failed' with
 * FOREIGN_RUNNING_ERROR, its status kept in foreignStatus and its remoteId kept, so this build's engine never submits,
 * polls, re-queues or fails it, and the queue counters / "Cập nhật khi xong" (restartWork) do not wait for it. A build
 * that knows the provider gives the status back. Any other take is returned as it is.
 */
export function parkForeignTake(t: Take): Take {
  if (!t.foreignProvider || (t.status !== 'queued' && t.status !== 'processing')) return t
  return { ...t, status: 'failed', foreignStatus: t.status, error: FOREIGN_RUNNING_ERROR }
}

const RUNNING: readonly JobStatus[] = ['queued', 'processing']

/**
 * Bring a saved take up to date. Provider fields default to the demo provider: takes saved before providers
 * existed ran on the mock, were never submitted anywhere (no remote id) and were paid with demo credits.
 * A non-blank provider id this build does not know (a newer build's provider) becomes provider 'mock' +
 * foreignProvider (the id) + charged false — never paid here, so never refunded — and a running one is parked
 * (parkForeignTake). Takes of 'canvasapp' / 'dev' / the old demo (missing provider) keep their `charged` as before.
 */
export function migrateTake(raw: unknown): Take {
  const t = (raw ?? {}) as Partial<Take>
  const frames = t.framesSnapshot
  const rawProvider: unknown = t.provider
  // A newer build's provider, as saved now (`provider`) or kept by a build that parked it (provider 'mock').
  const newer =
    typeof rawProvider === 'string' && rawProvider.trim() && !KNOWN_PROVIDERS.includes(rawProvider)
      ? foreignId(rawProvider)
      : (rawProvider === undefined || rawProvider === 'mock') && !KNOWN_PROVIDERS.includes(String(t.foreignProvider))
        ? foreignId(t.foreignProvider)
        : null
  const out: Take = {
    ...(t as Take),
    videoRefsSnapshot: Array.isArray(t.videoRefsSnapshot) ? t.videoRefsSnapshot : [],
    position: t.position ?? null,
    provider: t.provider === 'canvasapp' || t.provider === 'dev' ? t.provider : 'mock',
    remoteId: typeof t.remoteId === 'string' && t.remoteId ? t.remoteId : null,
    charged: newer ? false : t.charged !== false,
  }
  delete out.foreignProvider
  delete out.foreignStatus
  if (newer) {
    out.foreignProvider = newer
    // Kept from an earlier park: the status the newer build had (only next to the 'failed' it was parked as).
    if (t.status === 'failed' && RUNNING.includes(t.foreignStatus as JobStatus)) out.foreignStatus = t.foreignStatus
  }
  if (t.submitUnknown === true) out.submitUnknown = true
  else delete out.submitUnknown
  // Custom file name: sanitized again (a file from elsewhere may hold separators, "..", reserved names…).
  const fileName = cleanTakeFileName(t.fileName)
  if (fileName) out.fileName = fileName
  else delete out.fileName
  if (frames && typeof frames === 'object') out.framesSnapshot = { first: frames.first ?? null, last: frames.last ?? null }
  else delete out.framesSnapshot
  if (t.imageKeysSnapshot !== undefined) {
    if (Array.isArray(t.imageKeysSnapshot) && t.imageKeysSnapshot.every((k) => typeof k === 'string')) out.imageKeysSnapshot = [...t.imageKeysSnapshot]
    else delete out.imageKeysSnapshot
  }
  return parkForeignTake(out)
}
