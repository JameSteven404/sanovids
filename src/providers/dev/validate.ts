// Strict request validators of canvasapp.io.vn — ONE source of truth shared by the in-app dev server
// (providers/dev/server.ts) and the strict fake in providers/__tests__/canvasapp-e2e.test.ts.
// Pure (no I/O). They refuse exactly what canvasapp refuses (or is expected to refuse): a canvas that is not
// key for key what its client's canvasPayload() writes ("Invalid canvas payload"), a job body that is not
// runVideoNode()'s, ids that are not UUIDs, more than 30 images, prompts over the client's limits, models / modes /
// durations / resolutions / ratios the profile does not offer. See docs/canvasapp-api-notes.md.
//
// ---- API ----
//   canvasProblem(canvas)                       why a PUT /api/projects/{id}/canvas body is invalid, or null.
//   jobKeyProblem(body)                         client_request_id must be a UUID (checked first, before dedupe).
//   jobBodyProblem(body, { hasUpload })         every other job body rule, or null.
//   profileProblem(body, profiles)              refused by /api/video-profiles (can_create false, disabled mode).
//   DevProblem = { status, detail }             the HTTP status + FastAPI-style detail the server answers with.
import { MODELS } from '../../core/models'
import type { Mode, ModelId } from '../../core/types'
import type { VideoProfile } from '../canvasapp/api'
import { MAX_REF_IMAGES_PER_NODE, promptLimitOf } from '../canvasapp/mapping'

type Json = Record<string, unknown>

export interface DevProblem {
  status: number
  detail: string
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
export const sameKeys = (o: Json, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o)

/** canvasapp's client: at most 40 editable nodes and 30 image uploads on one canvas. */
export const MAX_CANVAS_NODES = 40
export const MAX_CANVAS_IMAGES = 30

/**
 * canvasapp refuses a canvas that is not exactly what its client's canvasPayload() writes. Returns why (short,
 * English, like a server detail) or null. Strict on purpose: the first real test failed on an extra `title` and a
 * {x, y, zoom} viewport.
 */
export function canvasProblem(c: unknown): string | null {
  if (!isObj(c) || !sameKeys(c, ['nodes', 'connections', 'viewport'])) return 'top-level keys'
  if (!isObj(c.viewport) || !sameKeys(c.viewport, ['zoom', 'scrollLeft', 'scrollTop']) || !Object.values(c.viewport).every((v) => typeof v === 'number')) return 'viewport'
  if (!Array.isArray(c.nodes) || !Array.isArray(c.connections) || c.nodes.length > MAX_CANVAS_NODES) return 'nodes / connections'
  const nodes = new Map<string, string>()
  for (const n of c.nodes) {
    if (!isObj(n) || typeof n.id !== 'string' || !UUID_RE.test(n.id) || nodes.has(n.id)) return 'node id'
    if (typeof n.x !== 'number' || typeof n.y !== 'number' || !isObj(n.data)) return 'node x / y / data'
    if (n.type === 'images') {
      if (!sameKeys(n, ['id', 'type', 'x', 'y', 'data'])) return 'image node keys'
      if (!sameKeys(n.data, ['upload_ids']) || !Array.isArray(n.data.upload_ids) || n.data.upload_ids.some((u) => typeof u !== 'string')) return 'image node data'
    } else if (n.type === 'video') {
      if (!sameKeys(n, ['id', 'type', 'x', 'y', 'w', 'h', 'data']) || typeof n.w !== 'number' || typeof n.h !== 'number') return 'video node keys'
      const d = n.data
      if (!sameKeys(d, ['model_profile', 'duration', 'resolution', 'aspect_ratio', 'mode', 'prompt'])) return 'video node data keys'
      if (typeof d.model_profile !== 'string' || typeof d.duration !== 'number' || typeof d.mode !== 'string' || typeof d.prompt !== 'string') return 'video node data types'
      if (typeof d.resolution !== 'string' || d.resolution !== d.resolution.toLowerCase()) return 'video node resolution'
      if (!(typeof d.aspect_ratio === 'string' || (d.aspect_ratio === null && d.mode === 'transform'))) return 'video node aspect_ratio'
    } else return 'node type'
    nodes.set(n.id, n.type)
  }
  // the client's imageIds() / upload guard: never more than 30 image uploads on one canvas (duplicates counted)
  const images = c.nodes.reduce((sum: number, n) => sum + (isObj(n) && n.type === 'images' && isObj(n.data) && Array.isArray(n.data.upload_ids) ? n.data.upload_ids.length : 0), 0)
  if (images > MAX_CANVAS_IMAGES) return 'more than 30 images'
  for (const e of c.connections) {
    if (!isObj(e) || !sameKeys(e, ['from', 'to', 'target_handle', 'order'])) return 'connection keys'
    if (nodes.get(String(e.from)) !== 'images' || nodes.get(String(e.to)) !== 'video') return 'connection ends'
    if (!['reference', 'first_frame', 'last_frame'].includes(String(e.target_handle)) || !Number.isInteger(e.order) || (e.order as number) < 1) return 'connection handle / order'
    if (e.target_handle === 'first_frame' && e.order !== 1) return 'first_frame order'
    if (e.target_handle === 'last_frame' && e.order !== 2) return 'last_frame order'
  }
  return null
}

/** Upload ids an (already valid) canvas references, in node order. */
export function canvasUploadIds(c: unknown): string[] {
  if (!isObj(c) || !Array.isArray(c.nodes)) return []
  return c.nodes.flatMap((n) => (isObj(n) && n.type === 'images' && isObj(n.data) && Array.isArray(n.data.upload_ids) ? (n.data.upload_ids as unknown[]).filter((u): u is string => typeof u === 'string') : []))
}

/** client_request_id must be a UUID (the client makes it with crypto.randomUUID()). Checked before anything else. */
export function jobKeyProblem(b: unknown): DevProblem | null {
  const key = isObj(b) ? b.client_request_id : undefined
  return typeof key === 'string' && UUID_RE.test(key) ? null : { status: 422, detail: 'client_request_id must be a UUID' }
}

const JOB_BASE_KEYS = ['project_id', 'model_profile', 'canvas_node_id', 'prompt', 'mode', 'duration', 'resolution', 'generate_audio', 'client_request_id']

/** H3 transform sends the two frames only (runVideoNode()); every other node upload_ids + aspect_ratio. */
export const isFramesJob = (b: Json) => b.model_profile === 'minimax_h3' && b.mode === 'transform'

/**
 * Every rule of POST /api/video-jobs but the key / project / canvas-node ones (the caller checks those against its
 * state first). `hasUpload`: the upload id belongs to this account. Same order and texts as the strict fake had.
 */
export function jobBodyProblem(body: unknown, ctx: { hasUpload: (uploadId: string) => boolean }): DevProblem | null {
  const bad = (detail: string, status = 400): DevProblem => ({ status, detail })
  if (!isObj(body)) return bad('body must be a JSON object', 422)
  const b = body
  const model = b.model_profile as ModelId
  const spec = typeof b.model_profile === 'string' ? MODELS[model] : undefined
  if (!spec) return bad('unknown model_profile')
  if (typeof b.prompt !== 'string' || !b.prompt.trim()) return bad('prompt required')
  if (!spec.modes.includes(b.mode as Mode)) return bad('mode not available')
  if (typeof b.duration !== 'number' || !spec.durations.includes(b.duration)) return bad('duration not available')
  if (typeof b.resolution !== 'string' || !spec.resolutions.includes(b.resolution)) return bad('resolution not available')
  if (typeof b.generate_audio !== 'boolean') return bad('generate_audio must be a boolean', 422)
  const frames = isFramesJob(b)
  if (!sameKeys(b, [...JOB_BASE_KEYS, ...(frames ? ['first_frame_upload_id', 'last_frame_upload_id'] : ['upload_ids', 'aspect_ratio'])])) return bad('unexpected job fields', 422)
  // runVideoNode() / promptLength(): the trimmed prompt in code points, 20.000 (H3 t2v / i2v 7.000)
  const limit = promptLimitOf(model, b.mode as Mode)
  if ([...b.prompt.trim()].length > limit) return bad(`prompt too long (max ${limit} characters)`)
  if (frames) {
    for (const k of ['first_frame_upload_id', 'last_frame_upload_id']) {
      if (typeof b[k] !== 'string' || !ctx.hasUpload(b[k] as string)) return bad(`${k} required`)
    }
    return null
  }
  if (typeof b.aspect_ratio !== 'string' || !spec.ratios.includes(b.aspect_ratio)) return bad('aspect_ratio not available')
  if (!Array.isArray(b.upload_ids) || b.upload_ids.some((id) => typeof id !== 'string' || !ctx.hasUpload(id))) return bad('unknown upload_id')
  if (b.upload_ids.length > MAX_REF_IMAGES_PER_NODE) return bad(`at most ${MAX_REF_IMAGES_PER_NODE} reference images`)
  if (model === 'minimax_h3' && b.mode === 't2v' && b.upload_ids.length) return bad('t2v takes no image')
  if (model === 'minimax_h3' && b.mode === 'i2v' && !b.upload_ids.length) return bad('i2v needs at least one image')
  return null
}

/** What /api/video-profiles forbids (runVideoNode() refuses can_create false and a disabled mode). */
export function profileProblem(body: unknown, profiles: readonly VideoProfile[]): DevProblem | null {
  if (!isObj(body)) return null
  const p = profiles.find((x) => x.model_profile === body.model_profile)
  if (!p) return null
  if (p.can_create === false) return { status: 400, detail: `${p.display_name ?? p.model_profile} is not available right now` }
  if (p.options?.disabled_modes?.includes(String(body.mode))) return { status: 400, detail: `mode ${String(body.mode)} is disabled` }
  return null
}
