// PURE mapping between SanoVids and canvasapp.io.vn (no I/O). Unit-tested in providers/__tests__/canvasapp-mapping.test.ts.
//
//   SanoVids JobRequest ──toVideoJobBody──▶ POST /api/video-jobs body
//   SanoVids scenes     ──bridgeCanvas────▶ PUT /api/projects/{id}/canvas (one video node per scene of a project —
//                                           sceneNodeKey — so canvas_node_id exists)
//   canvasapp job       ──mapJobStatus────▶ provider status (queued/processing/completed/failed/cancelled)
//
// Every request shape mirrors canvasapp's own client (/static/canvas.js: canvasPayload(), runVideoNode(),
// normalizeConnections(), createVideoNode(), newId()) key for key — the server refuses anything else
// ("Invalid canvas payload"). See docs/canvasapp-api-notes.md.
import { modeLabel } from '../../core/models'
import type { Mode, ModelId, VideoSettings } from '../../core/types'
import type { JobRequest, RemoteStatus, SettingsIssue } from '../types'
import type { CanvasConnection, CanvasImageNode, CanvasJob, CanvasNode, CanvasPayload, CanvasVideoNode, VideoJobBody, VideoProfile } from './api'

export const BRIDGE_PROJECT_NAME = 'SanoVids bridge'
/** canvasapp's client allows 40 editable nodes per canvas (MAX_CANVAS_NODES). */
export const MAX_BRIDGE_NODES = 40
/** canvasapp's client allows 30 reference images per video node (MAX_REFERENCE_IMAGES). */
export const MAX_REF_IMAGES_PER_NODE = 30
/**
 * ...and 30 image uploads on the whole canvas: imageIds() = every image node's upload_ids (duplicates counted),
 * and the upload handler refuses to go past MAX_REFERENCE_IMAGES ("Tổng cộng tối đa 30 ảnh").
 */
export const MAX_BRIDGE_IMAGES = 30
/** `order` of a reference connection is 1-based (= N in @image_N): normalizeConnections() renumbers them index + 1. */
export const ORDER_BASE = 1
/** setTransformFrame(): first_frame order 1, last_frame order 2. */
export const FIRST_FRAME_ORDER = 1
export const LAST_FRAME_ORDER = 2
/** Size of a video node as createVideoNode() makes it (the client's resize range is 340–900 × 470–1200). */
export const VIDEO_NODE_W = 390
export const VIDEO_NODE_H = 600
/** Prompts carried by one bridge canvas (UTF-16 units): keeps the PUT far below the desktop gateway's 2 MB JSON cap. */
export const MAX_BRIDGE_PROMPT_CHARS = 400_000
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

const MODEL_PROFILE: Record<ModelId, string> = { seedance_2_5: 'seedance_2_5', minimax_h3: 'minimax_h3' }

export function modelProfileOf(model: ModelId): string {
  return MODEL_PROFILE[model]
}

/** Prompt limit enforced by canvasapp's client: 20.000 chars, H3 t2v/i2v 7.000. */
export function promptLimitOf(model: ModelId, mode: Mode): number {
  return model === 'minimax_h3' && mode !== 'transform' ? 7000 : 20000
}

/**
 * Which pictures a video node takes, exactly like runVideoNode() / normalizeConnections():
 *   'refs'   Seedance (any mode) or H3 i2v → reference images (upload_ids in @image order + aspect_ratio)
 *   'frames' H3 transform → first_frame / last_frame (no upload_ids, no aspect_ratio)
 *   'none'   H3 t2v → no picture (upload_ids: [] + aspect_ratio)
 */
export type InputShape = 'refs' | 'frames' | 'none'

export function inputShapeOf(model: ModelId, mode: Mode): InputShape {
  if (model !== 'minimax_h3' || mode === 'i2v') return 'refs'
  return mode === 'transform' ? 'frames' : 'none'
}

/** canvasapp keeps resolutions lower-cased ('1080p', '768p', '2k'): normalizeVideoNode() / canvasPayload(). */
export const resolutionOf = (resolution: string) => String(resolution).toLowerCase()

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/**
 * Deterministic UUID for a text: a 128-bit hash (cyrb128 = 4 × 32-bit mixes) printed as an RFC 4122 id —
 * lowercase 8-4-4-4-12 hex, version nibble 4, variant 8–b. Pure and synchronous: the same text always gives the
 * same id. canvasapp's client makes every node id and client_request_id with crypto.randomUUID() (newId()), so the
 * server sees the same format; ours are stable so a scene keeps its node and a retried take keeps its key.
 */
export function uuidFromKey(text: string): string {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  const hex = [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const NODE_KEY_PREFIX = 'node:'

/**
 * Key of the bridge video node of one scene of one SanoVids project (`projectId` = the SanoVids project, never
 * canvasapp's bridge project_id): `node:<length of projectId>:<projectId>:<sceneId>` — injective, and never a scene id
 * SanoVids generates (core/ids: "scn_<uuid>"). Projects sharing scene ids (Nhân bản dự án, a file imported twice) get
 * different nodes. It is what the bridge entries are keyed by (BridgeEntry.sceneId) and what canvasNodeId hashes.
 * An empty project id gives the bare scene id: the LEGACY key, the one builds before per-project nodes used for every
 * project (jobs they sent may still run on canvasNodeId(sceneId)).
 */
export function sceneNodeKey(projectId: string, sceneId: string): string {
  return projectId ? `${NODE_KEY_PREFIX}${projectId.length}:${projectId}:${sceneId}` : sceneId
}

/** The project + scene of a sceneNodeKey; null for a legacy key (a bare scene id) or anything else. */
export function parseSceneNodeKey(key: string): { projectId: string; sceneId: string } | null {
  const m = /^node:([1-9]\d{0,5}):/.exec(key)
  if (!m) return null
  const len = Number(m[1])
  const rest = key.slice(m[0].length)
  if (rest.length < len + 2 || rest[len] !== ':') return null
  return { projectId: rest.slice(0, len), sceneId: rest.slice(len + 1) }
}

/**
 * canvas_node_id of the bridge video node with key `nodeKey` (sceneNodeKey, or a legacy bare scene id): a UUID, stable
 * per key. The formula never changes: node ids recorded by older builds (ledger, running jobs) must stay valid.
 */
export function canvasNodeId(nodeKey: string): string {
  return uuidFromKey(`sanovids:video-node:${nodeKey}`)
}

/** canvas_node_id of the video node of scene `sceneId` of SanoVids project `projectId`. */
export const sceneNodeId = (projectId: string, sceneId: string): string => canvasNodeId(sceneNodeKey(projectId, sceneId))

/**
 * Id of a bridge image node: a UUID, stable per (upload, occurrence). One image node per upload feeds every video
 * node that uses it (the client lets one image node feed several video nodes); `occurrence` > 0 only when one video
 * node takes the same upload twice (the client keeps one edge per image node and target, and first/last frame must
 * be two different image nodes).
 */
export function imageNodeId(uploadId: string, occurrence = 0): string {
  return uuidFromKey(`sanovids:image-node:${uploadId}:${occurrence}`)
}

/**
 * client_request_id sent for a take (idempotency key `req.key` = take id): a UUID, stable per take, so a retry of
 * the same take always sends the same key. The local job ledger stays keyed by the take id itself.
 */
export function clientRequestIdFor(key: string): string {
  return uuidFromKey(`sanovids:client-request:${key}`)
}

// ---------------------------------------------------------------------------------------------
// Remote ids
// ---------------------------------------------------------------------------------------------

/** remoteId stored on the take = "<project_id>:<job_id>" so polling survives a change of bridge project. */
export function encodeRemoteId(projectId: string, jobId: string): string {
  return `${projectId}:${jobId}`
}

export function decodeRemoteId(remoteId: string): { projectId: string; jobId: string } | null {
  const i = remoteId.indexOf(':')
  if (i <= 0 || i === remoteId.length - 1) return null
  return { projectId: remoteId.slice(0, i), jobId: remoteId.slice(i + 1) }
}

/** The create response shape is not documented: accept `{job_id}`, `{job:{job_id}}` or `{id}`. VERIFY. */
export function jobIdFromCreateResponse(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const direct = o.job_id ?? o.id
  if (typeof direct === 'string' && direct) return direct
  const job = o.job as Record<string, unknown> | undefined
  if (job && typeof job.job_id === 'string' && job.job_id) return job.job_id
  return null
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Video profiles (/api/video-profiles)
// ---------------------------------------------------------------------------------------------

const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4']

/**
 * canvasapp's built-in profiles (its client's PROFILE_FALLBACKS, pricing left out): used for a model missing from
 * /api/video-profiles, or for every model when that list cannot be read — Seedance on, MiniMax-H3 locked
 * (can_create false, transform off).
 */
export const PROFILE_FALLBACKS: Readonly<Record<ModelId, VideoProfile>> = {
  seedance_2_5: {
    model_profile: 'seedance_2_5',
    display_name: 'Seedance 2.5',
    visible: true,
    enabled: true,
    can_create: true,
    options: { modes: ['t2v'], disabled_modes: [], durations: [5, 10, 15, 30], resolutions: ['480p', '720p', '1080p'], aspect_ratios: RATIOS },
  },
  minimax_h3: {
    model_profile: 'minimax_h3',
    display_name: 'MiniMax-H3',
    visible: true,
    enabled: false,
    can_create: false,
    options: { modes: ['t2v', 'i2v', 'transform'], disabled_modes: ['transform'], durations: [5, 10, 15], resolutions: ['768p', '2k'], aspect_ratios: RATIOS },
  },
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** validProfileList(): a non-empty list of `type` holding at least every `required` item. */
function validList<T extends string | number>(v: unknown, type: 'string' | 'number', required: readonly T[] | undefined): v is T[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((item) => typeof item === type && (type !== 'number' || Number.isFinite(item))) &&
    (required ?? []).every((item) => v.includes(item))
  )
}

/**
 * The profile canvasapp's own client works with for a model — its profileSpec(): the fallback when the model is not
 * in `profiles`; Seedance as loaded; MiniMax-H3 merged with its fallback (a list that is malformed or narrower than
 * the fallback's → the fallback's; enabled / can_create not a boolean → false).
 */
export function profileSpecOf(model: ModelId, profiles: readonly VideoProfile[]): VideoProfile {
  const fallback = PROFILE_FALLBACKS[model] ?? PROFILE_FALLBACKS.seedance_2_5
  const loaded = profiles.find((p) => isPlainObject(p) && p.model_profile === modelProfileOf(model))
  if (!loaded) return fallback
  if (model !== 'minimax_h3') return loaded
  const raw: Record<string, unknown> = isPlainObject(loaded.options) ? loaded.options : {}
  const f = fallback.options ?? {}
  return {
    ...loaded,
    model_profile: 'minimax_h3',
    display_name: typeof loaded.display_name === 'string' && loaded.display_name ? loaded.display_name : fallback.display_name,
    enabled: typeof loaded.enabled === 'boolean' ? loaded.enabled : false,
    can_create: typeof loaded.can_create === 'boolean' ? loaded.can_create : false,
    options: {
      ...raw,
      modes: validList(raw.modes, 'string', f.modes) ? raw.modes : f.modes,
      disabled_modes: Array.isArray(raw.disabled_modes) && raw.disabled_modes.every((m) => typeof m === 'string') ? raw.disabled_modes : f.disabled_modes,
      durations: validList(raw.durations, 'number', f.durations) ? raw.durations : f.durations,
      resolutions: validList(raw.resolutions, 'string', f.resolutions) ? raw.resolutions : f.resolutions,
      aspect_ratios: validList(raw.aspect_ratios, 'string', f.aspect_ratios) ? raw.aspect_ratios : f.aspect_ratios,
    },
  }
}

const listOf = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null)

/** A profile name shown in a message: canvasapp's display_name (trimmed, at most this long), else the built-in one. */
const MAX_PROFILE_NAME = 40

function profileName(model: ModelId, profile: VideoProfile): string {
  const raw = typeof profile.display_name === 'string' ? profile.display_name.trim() : ''
  if (raw) return raw.length > MAX_PROFILE_NAME ? `${raw.slice(0, MAX_PROFILE_NAME - 1)}…` : raw
  return PROFILE_FALLBACKS[model]?.display_name || model
}

/**
 * What canvasapp's page would refuse in these settings, per /api/video-profiles (`profiles` as read; [] = unreadable →
 * its fallbacks), each tagged with its field — in this order, with the texts of the submit refusal (validateRequest):
 * can_create → 'model'; a mode not offered or in disabled_modes → 'mode'; durations → 'duration'; resolutions (any
 * case) → 'resolution'; aspect_ratios → 'ratio' (not for H3 transform, whose ratio comes from its frames).
 * ONE rule for the submit, the inspector and the run check. Pure; defensive about malformed lists.
 */
export function profileIssues(s: Pick<VideoSettings, 'model' | 'mode' | 'duration' | 'resolution' | 'ratio'>, profiles: readonly VideoProfile[]): SettingsIssue[] {
  const out: SettingsIssue[] = []
  const profile = profileSpecOf(s.model, profiles)
  const name = profileName(s.model, profile)
  const mode = modeLabel(s.mode, s.model)
  // runVideoNode() refuses a profile that cannot create and a disabled mode (it only looks at can_create)
  if (profile.can_create === false) out.push({ field: 'model', reason: `${name} hiện không khả dụng trên canvasapp.` })
  const o: Record<string, unknown> = isPlainObject(profile.options) ? profile.options : {}
  const modes = listOf(o.modes)
  if (modes && !modes.includes(s.mode)) out.push({ field: 'mode', reason: `canvasapp không có chế độ ${mode} cho ${name}.` })
  if (listOf(o.disabled_modes)?.includes(s.mode)) out.push({ field: 'mode', reason: `Chế độ ${mode} hiện tạm ngừng trên canvasapp.` })
  const durations = listOf(o.durations)
  if (durations && !durations.map(Number).includes(s.duration)) out.push({ field: 'duration', reason: `canvasapp không có thời lượng ${s.duration}s cho ${name}.` })
  const resolutions = listOf(o.resolutions)
  if (resolutions && !resolutions.map((r) => resolutionOf(String(r))).includes(resolutionOf(s.resolution))) {
    out.push({ field: 'resolution', reason: `canvasapp không có độ phân giải ${s.resolution} cho ${name}.` })
  }
  // H3 transform takes its ratio from the two frames (no aspect_ratio is sent): checked by transformFrameRatio
  const ratios = listOf(o.aspect_ratios)
  if (ratios && inputShapeOf(s.model, s.mode) !== 'frames' && !ratios.includes(s.ratio)) out.push({ field: 'ratio', reason: `canvasapp không có tỉ lệ khung ${s.ratio} cho ${name}.` })
  return out
}

/**
 * What profileIssues reads of each model's profile, as one string: two reads with the same signature refuse exactly
 * the same settings (the adapter keeps its SettingsLimits object then). `ok` false = canvasapp's fallbacks.
 */
export function profilesSignature(profiles: readonly VideoProfile[], ok: boolean): string {
  const models = Object.keys(PROFILE_FALLBACKS) as ModelId[]
  return JSON.stringify([
    ok,
    models.map((m) => {
      const p = profileSpecOf(m, profiles)
      const o: Record<string, unknown> = isPlainObject(p.options) ? p.options : {}
      return [profileName(m, p), p.can_create === false, o.modes ?? null, o.disabled_modes ?? null, o.durations ?? null, o.resolutions ?? null, o.aspect_ratios ?? null]
    }),
  ])
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/**
 * Problems that make a request impossible through the gateway (Vietnamese). Empty = OK.
 * `profiles`: /api/video-profiles as read ([] = could not be read → canvasapp's fallbacks, like its client);
 * null / undefined = not known → no profile check.
 */
export function validateRequest(req: JobRequest, profiles?: readonly VideoProfile[] | null): string[] {
  const out: string[] = []
  const prompt = req.prompt.trim()
  if (!prompt) out.push('Prompt trống.')
  const limit = promptLimitOf(req.model, req.mode)
  // runVideoNode() / promptLength(): the trimmed prompt, counted in code points
  if ([...prompt].length > limit) out.push(`Prompt dài hơn giới hạn ${limit.toLocaleString('vi-VN')} ký tự của canvasapp.`)
  // Not tied to capabilities().maxRefVideos: toVideoJobBody / the bridge canvas carry no video, so a request with
  // videos must never reach a POST (it would be billed without them). Opened only with a captured request shape.
  if (req.videos.length) out.push('Cổng canvasapp (cả chế độ Phát triển) chưa hỗ trợ video tham chiếu (@video_N) — bỏ video tham chiếu khỏi cảnh.')
  if (req.images.length > MAX_REF_IMAGES_PER_NODE) out.push(`canvasapp nhận tối đa ${MAX_REF_IMAGES_PER_NODE} ảnh tham chiếu.`)
  if (req.mode === 'i2v' && !req.images.length) out.push('Chế độ Ảnh → Video cần ít nhất 1 ảnh tham chiếu.')
  if (req.mode === 'transform' && (!req.firstFrame || !req.lastFrame)) out.push('Chế độ Khung đầu → cuối cần đủ khung đầu và khung cuối.')
  // canvasapp's page refuses (runVideoNode) what /api/video-profiles says it cannot run — the SAME rule the inspector
  // and the run check use (profileIssues), so they never disagree with this.
  if (profiles) out.push(...profileIssues(req, profiles).map((i) => i.reason))
  return out
}

/** Ratios canvasapp's ratioFromDimensions() recognises. */
const FRAME_RATIOS: readonly (readonly [string, number])[] = [
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
]

/** canvasapp's ratioFromDimensions(): the nearest supported ratio within 2 %, else null. */
export function ratioFromDimensions(width: number, height: number): string | null {
  if (!width || !height) return null
  const observed = width / height
  const [name, off] = FRAME_RATIOS.map(([n, value]) => [n, Math.abs(observed - value) / value] as const).sort((a, b) => a[1] - b[1])[0]
  return off <= 0.02 ? name : null
}

/**
 * H3 transform: the ratio both frames share, or why canvasapp's page would refuse to run the node — its
 * transformInputState() (null = a picture whose ratio is not supported, or could not be read).
 */
export function transformFrameRatio(first: string | null, last: string | null): { ratio: string } | { problem: string } {
  if (!first || !last) return { problem: 'Tỷ lệ khung đầu / khung cuối chưa thuộc danh sách canvasapp hỗ trợ (16:9, 9:16, 1:1, 4:3, 3:4).' }
  if (first !== last) return { problem: `Khung đầu và khung cuối khác tỷ lệ (${first} / ${last}) — canvasapp chỉ nhận hai ảnh cùng tỷ lệ.` }
  return { ratio: first }
}

export function uploadFilename(imageId: string, mime: string): string {
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
  return `${imageId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}.${ext}`
}

// ---------------------------------------------------------------------------------------------
// Job body
// ---------------------------------------------------------------------------------------------

export interface JobBodyContext {
  /** canvasapp's bridge project_id. */
  projectId: string
  /** Key of the video node the job is sent on (default: sceneNodeKey of the request's project and scene). */
  nodeKey?: string
  /** upload_id for a SanoVids media-store image id (images + frames must already be uploaded). */
  uploadIdFor: (imageId: string) => string
  generateAudio?: boolean
}

const refImagesOf = (req: JobRequest) => [...req.images].sort((a, b) => a.n - b.n)

/**
 * SanoVids request → POST /api/video-jobs body, built like runVideoNode(): the same keys in the same order and, per
 * input shape, exactly the keys the client sends —
 *   refs   (Seedance, H3 i2v): upload_ids in @image_N order + aspect_ratio
 *   frames (H3 transform):     first_frame_upload_id + last_frame_upload_id (NO upload_ids, NO aspect_ratio)
 *   none   (H3 t2v):           upload_ids: [] + aspect_ratio
 * The prompt is trimmed at both ends only (runVideoNode sends node.data.prompt.trim()); take.promptSnapshot is untouched.
 */
export function toVideoJobBody(req: JobRequest, ctx: JobBodyContext): VideoJobBody {
  const shape = inputShapeOf(req.model, req.mode)
  const inputs: Pick<VideoJobBody, 'upload_ids' | 'aspect_ratio' | 'first_frame_upload_id' | 'last_frame_upload_id'> =
    shape === 'frames'
      ? {
          ...(req.firstFrame ? { first_frame_upload_id: ctx.uploadIdFor(req.firstFrame.imageId) } : {}),
          ...(req.lastFrame ? { last_frame_upload_id: ctx.uploadIdFor(req.lastFrame.imageId) } : {}),
        }
      : { upload_ids: shape === 'refs' ? refImagesOf(req).map((i) => ctx.uploadIdFor(i.imageId)) : [], aspect_ratio: req.ratio || '16:9' }
  return {
    project_id: ctx.projectId,
    model_profile: modelProfileOf(req.model),
    canvas_node_id: canvasNodeId(ctx.nodeKey ?? sceneNodeKey(req.sanovidsProjectId, req.sceneId)),
    prompt: req.prompt.trim(),
    mode: req.mode,
    duration: req.duration,
    resolution: resolutionOf(req.resolution),
    generate_audio: ctx.generateAudio ?? true,
    ...inputs,
    client_request_id: clientRequestIdFor(req.key),
  }
}

/** Every media-store image id the request needs uploaded, in upload order, without duplicates. */
export function imagesToUpload(req: JobRequest): string[] {
  const shape = inputShapeOf(req.model, req.mode)
  const ids = shape === 'frames' ? [req.firstFrame?.imageId, req.lastFrame?.imageId] : shape === 'refs' ? refImagesOf(req).map((i) => i.imageId) : []
  return [...new Set(ids.filter((x): x is string => !!x))]
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/**
 * canvasapp job → provider status. "completed" only once the file can be downloaded. `source` names the server in
 * error texts ("canvasapp giả lập" for the development-mode simulator).
 */
export function mapJobStatus(remoteId: string, job: CanvasJob, source = 'canvasapp'): RemoteStatus {
  const raw = typeof job.progress === 'number' && Number.isFinite(job.progress) ? job.progress : undefined
  const progress = raw === undefined ? undefined : Math.max(0, Math.min(100, Math.round(raw)))
  switch (job.status) {
    case 'queued':
      return { remoteId, state: 'queued', progress }
    case 'processing':
      return { remoteId, state: 'processing', progress }
    case 'completed':
      return job.download_available === false ? { remoteId, state: 'processing', progress: 99 } : { remoteId, state: 'completed', progress: 100 }
    case 'failed':
      return { remoteId, state: 'failed', progress, error: job.error_message ? `${source}: ${job.error_message}` : `${source} báo tạo video thất bại.` }
    case 'expired':
      return { remoteId, state: 'failed', progress, error: `Job trên ${source} đã hết hạn (không tải được nữa).` }
    case 'cancelled':
      return { remoteId, state: 'cancelled', progress }
    default:
      return { remoteId, state: 'processing', progress }
  }
}

// ---------------------------------------------------------------------------------------------
// Bridge canvas
// ---------------------------------------------------------------------------------------------

/** What the bridge canvas remembers about one video node (persisted: read back with bridgeEntriesFrom). */
export interface BridgeEntry {
  /**
   * The node key (sceneNodeKey of the scene's project + scene; a bare scene id for entries saved by older builds —
   * their jobs may still run on that node). Named `sceneId` and equal to the entry's storage key on purpose: older
   * builds read the same field, keep the entry and derive the same node id (downgrade keeps running nodes).
   */
  sceneId: string
  model: ModelId
  mode: Mode
  duration: number
  resolution: string
  ratio: string
  prompt: string
  /** Reference uploads in @image_N order (only for the 'refs' input shape). */
  uploadIds: string[]
  firstFrameUploadId: string | null
  lastFrameUploadId: string | null
  /** Last time a job was submitted for this scene (newest entries win when the canvas is full). */
  usedAt: number
}

/**
 * `frameRatio` (H3 transform): the ratio both frames share (transformFrameRatio), which canvasapp's client stores as
 * the transform node's aspect_ratio (setTransformFrame()); null = none. Omitted: the scene's ratio is kept.
 * `nodeKey`: the node the entry stands for (default: sceneNodeKey of the request's project and scene).
 */
export function entryFromRequest(
  req: JobRequest,
  uploadIdFor: (imageId: string) => string,
  usedAt: number,
  frameRatio?: string | null,
  nodeKey: string = sceneNodeKey(req.sanovidsProjectId, req.sceneId),
): BridgeEntry {
  const shape = inputShapeOf(req.model, req.mode)
  return {
    sceneId: nodeKey,
    model: req.model,
    mode: req.mode,
    duration: req.duration,
    resolution: req.resolution,
    ratio: shape === 'frames' && frameRatio !== undefined ? (frameRatio ?? '') : req.ratio,
    prompt: req.prompt,
    uploadIds: shape === 'refs' ? refImagesOf(req).map((i) => uploadIdFor(i.imageId)) : [],
    firstFrameUploadId: shape === 'frames' && req.firstFrame ? uploadIdFor(req.firstFrame.imageId) : null,
    lastFrameUploadId: shape === 'frames' && req.lastFrame ? uploadIdFor(req.lastFrame.imageId) : null,
    usedAt,
  }
}

const MODEL_IDS: readonly string[] = ['seedance_2_5', 'minimax_h3']
const MODES: readonly string[] = ['t2v', 'i2v', 'transform']
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isIdOrNull = (v: unknown): v is string | null => v === null || (isStr(v) && v.length > 0)

/**
 * Bridge entries read back from storage, keeping only well-formed ones (anything else is dropped, and simply rebuilt
 * by the next submit of that scene). Entries saved by older builds (v0.2.0: extra `label`; keyed by the bare scene id
 * before per-project nodes) stay valid: canvas ids are derived from the node key each time the canvas is built —
 * never stored — and unknown fields are dropped here.
 */
export function bridgeEntriesFrom(raw: unknown): Record<string, BridgeEntry> {
  const out: Record<string, BridgeEntry> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const e = v as Record<string, unknown>
    if (!isStr(e.sceneId) || !e.sceneId || e.sceneId !== key) continue
    if (!isStr(e.model) || !MODEL_IDS.includes(e.model) || !isStr(e.mode) || !MODES.includes(e.mode)) continue
    if (!isNum(e.duration) || !isStr(e.resolution) || !isStr(e.ratio) || !isStr(e.prompt) || !isNum(e.usedAt)) continue
    if (!Array.isArray(e.uploadIds) || !e.uploadIds.every((u) => isStr(u) && u.length > 0)) continue
    if (!isIdOrNull(e.firstFrameUploadId) || !isIdOrNull(e.lastFrameUploadId)) continue
    out[key] = {
      sceneId: e.sceneId,
      model: e.model as ModelId,
      mode: e.mode as Mode,
      duration: e.duration,
      resolution: e.resolution,
      ratio: e.ratio,
      prompt: e.prompt,
      uploadIds: [...(e.uploadIds as string[])],
      firstFrameUploadId: e.firstFrameUploadId,
      lastFrameUploadId: e.lastFrameUploadId,
      usedAt: e.usedAt,
    }
  }
  return out
}

interface Slot {
  uploadId: string
  handle: CanvasConnection['target_handle']
  order: number
}

/** Image inputs of an entry, wired as the client would (normalizeConnections / setTransformFrame). */
function slotsOf(e: BridgeEntry): Slot[] {
  const shape = inputShapeOf(e.model, e.mode)
  if (shape === 'refs') {
    return e.uploadIds.slice(0, MAX_REF_IMAGES_PER_NODE).map((uploadId, i): Slot => ({ uploadId, handle: 'reference', order: i + ORDER_BASE }))
  }
  const out: Slot[] = []
  if (shape === 'frames') {
    if (e.firstFrameUploadId) out.push({ uploadId: e.firstFrameUploadId, handle: 'first_frame', order: FIRST_FRAME_ORDER })
    if (e.lastFrameUploadId) out.push({ uploadId: e.lastFrameUploadId, handle: 'last_frame', order: LAST_FRAME_ORDER })
  }
  // 'none' (H3 t2v) takes no picture: the client drops every image edge into such a node
  return out
}

/** Image node of each slot: its upload + occurrence = how many earlier slots of the SAME entry use that upload. */
function slotImages(slots: Slot[]): { key: string; occurrence: number }[] {
  const seen = new Map<string, number>()
  return slots.map((s) => {
    const occurrence = seen.get(s.uploadId) ?? 0
    seen.set(s.uploadId, occurrence + 1)
    return { key: `${occurrence}:${s.uploadId}`, occurrence }
  })
}

const MARGIN = 60
const IMG_COL_W = 250
const IMG_ROW_H = 290
const IMG_COLS = 3
const VIDEO_X = MARGIN + IMG_COLS * IMG_COL_W + 80
const ROW_GAP = 80

/**
 * Minimal canvas for the bridge project, in exactly the shape canvasPayload() saves (no other key anywhere):
 *   { nodes, connections, viewport: { zoom, scrollLeft, scrollTop } }
 *   video node  { id, type:'video', x, y, w, h, data:{ model_profile, duration, resolution, aspect_ratio, mode, prompt } }
 *   image node  { id, type:'images', x, y, data:{ upload_ids:[one] } }
 *   connection  { from, to, target_handle, order }  (references 1..N in @image order, first_frame 1, last_frame 2)
 * One video node per entry (id = canvasNodeId(entry key) — a scene of a project); one image node per upload, shared by
 * every video node that uses it (a second one only when one video node takes the same upload twice). Ids are UUIDs,
 * coordinates integers. Within canvasapp's client limits: 40 nodes, 30 image uploads on the canvas — plus a prompt
 * budget. Newest entries first; an older entry that would go past a limit is left out — the newest entry is always
 * kept (validateRequest caps it at 30 references). See planBridgeCanvas for the entry being submitted and the entries
 * whose jobs still run.
 */
export function bridgeCanvas(entries: BridgeEntry[], opts: BridgeCanvasOptions = {}): CanvasPayload {
  return planBridgeCanvas(entries, opts).canvas
}

/** Entries are named by their key (BridgeEntry.sceneId = the node key). */
export interface BridgeCanvasOptions {
  /** Entry being submitted: placed first whatever its usedAt (equal or older timestamps never leave it out). */
  current?: string
  /** Entries whose job may still be running: placed right after `current` and never left out to make room. */
  keep?: ReadonlySet<string>
}

export interface BridgePlan {
  canvas: CanvasPayload
  /** Entries (keys) left off the canvas for lack of room (entries that may go). */
  dropped: string[]
  /** `keep` entries that do not fit: such a canvas must not be saved (a running job would lose its node). */
  missing: string[]
}

/**
 * bridgeCanvas, saying what did not fit. Order: `current`, then the `keep` entries, then the others — newest first in
 * each group. The first entry is always on the canvas; a later one past a limit is left out (`dropped`, or `missing`
 * for a `keep` entry).
 */
export function planBridgeCanvas(entries: BridgeEntry[], opts: BridgeCanvasOptions = {}): BridgePlan {
  const rank = (e: BridgeEntry) => (e.sceneId === opts.current ? 0 : opts.keep?.has(e.sceneId) ? 1 : 2)
  const sorted = [...entries].sort((a, b) => rank(a) - rank(b) || b.usedAt - a.usedAt)
  const dropped: string[] = []
  const missing: string[] = []
  const nodes: CanvasNode[] = []
  /** image node key (slotImages) → node id */
  const images = new Map<string, string>()
  const references: CanvasConnection[] = []
  const frames: CanvasConnection[] = []
  let promptChars = 0
  let y0 = MARGIN
  for (const e of sorted) {
    const slots = slotsOf(e)
    const wanted = slotImages(slots)
    const fresh = wanted.filter((w) => !images.has(w.key)).length
    // each image node holds exactly one upload: image uploads on the canvas = image nodes
    const tooBig = nodes.length + 1 + fresh > MAX_BRIDGE_NODES || images.size + fresh > MAX_BRIDGE_IMAGES || promptChars + e.prompt.length > MAX_BRIDGE_PROMPT_CHARS
    if (nodes.length > 0 && tooBig) {
      if (rank(e) === 1) missing.push(e.sceneId)
      else dropped.push(e.sceneId)
      continue
    }
    promptChars += e.prompt.length
    const vid = canvasNodeId(e.sceneId)
    const video: CanvasVideoNode = {
      id: vid,
      type: 'video',
      x: VIDEO_X,
      y: y0,
      w: VIDEO_NODE_W,
      h: VIDEO_NODE_H,
      data: {
        model_profile: modelProfileOf(e.model),
        duration: e.duration,
        resolution: resolutionOf(e.resolution),
        // canvasPayload(): a transform node keeps its ratio or null, every other node falls back to 16:9
        aspect_ratio: e.mode === 'transform' ? e.ratio || null : e.ratio || '16:9',
        mode: e.mode,
        prompt: e.prompt,
      },
    }
    nodes.push(video)
    let placed = 0
    slots.forEach((s, i) => {
      const w = wanted[i]
      let id = images.get(w.key)
      if (!id) {
        // a new image node goes on this scene's row; a shared one stays where its first scene put it
        id = imageNodeId(s.uploadId, w.occurrence)
        const image: CanvasImageNode = {
          id,
          type: 'images',
          x: MARGIN + (placed % IMG_COLS) * IMG_COL_W,
          y: y0 + Math.floor(placed / IMG_COLS) * IMG_ROW_H,
          data: { upload_ids: [s.uploadId] },
        }
        placed++
        images.set(w.key, id)
        nodes.push(image)
      }
      const edge: CanvasConnection = { from: id, to: vid, target_handle: s.handle, order: s.order }
      if (s.handle === 'reference') references.push(edge)
      else frames.push(edge)
    })
    y0 += Math.max(VIDEO_NODE_H, Math.ceil(placed / IMG_COLS) * IMG_ROW_H) + ROW_GAP
  }
  // normalizeConnections() returns every reference edge first, then the frame edges
  return { canvas: { nodes, connections: [...references, ...frames], viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 } }, dropped, missing }
}
