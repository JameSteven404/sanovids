// PURE mapping between SanoVids and canvasapp.io.vn (no I/O). Unit-tested in providers/__tests__/canvasapp-mapping.test.ts.
//
//   SanoVids JobRequest ──toVideoJobBody──▶ POST /api/video-jobs body
//   SanoVids scenes     ──bridgeCanvas────▶ PUT /api/projects/{id}/canvas (one video node per scene, so canvas_node_id exists)
//   canvasapp job       ──mapJobStatus────▶ provider status (queued/processing/completed/failed/cancelled)
//
// Assumptions that still need to be verified against the live site are marked "VERIFY" (see docs/GATEWAY-CANVASAPP.md).
import type { Mode, ModelId } from '../../core/types'
import type { JobRequest, RemoteStatus } from '../types'
import type { CanvasConnection, CanvasJob, CanvasNode, CanvasPayload, VideoJobBody, VideoProfile } from './api'

export const BRIDGE_PROJECT_NAME = 'SanoVids bridge'
/** canvasapp's client allows 40 editable nodes per canvas. */
export const MAX_BRIDGE_NODES = 40
/** canvasapp's client allows 30 reference images per video node. */
export const MAX_REF_IMAGES_PER_NODE = 30
/** VERIFY: whether `order` on a reference connection is 1-based (= N in @image_N) or 0-based. */
export const ORDER_BASE = 1
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

const MODEL_PROFILE: Record<ModelId, string> = { seedance_2_5: 'seedance_2_5', minimax_h3: 'minimax_h3' }

export function modelProfileOf(model: ModelId): string {
  return MODEL_PROFILE[model]
}

/** Prompt limit enforced by canvasapp's client: 20.000 chars, H3 t2v/i2v 7.000. */
export function promptLimitOf(model: ModelId, mode: Mode): number {
  return model === 'minimax_h3' && mode !== 'transform' ? 7000 : 20000
}

/** canvas_node_id of the bridge video node for a SanoVids scene (stable, URL/JSON safe). */
export function canvasNodeId(sceneId: string): string {
  return 'sv_' + sceneId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 72)
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

/** Problems that make a request impossible through the gateway (Vietnamese). Empty = OK. */
export function validateRequest(req: JobRequest, profiles?: VideoProfile[] | null): string[] {
  const out: string[] = []
  if (!req.prompt.trim()) out.push('Prompt trống.')
  const limit = promptLimitOf(req.model, req.mode)
  if ([...req.prompt].length > limit) out.push(`Prompt dài hơn giới hạn ${limit.toLocaleString('vi-VN')} ký tự của canvasapp.`)
  if (req.videos.length) out.push('Cổng canvasapp chưa hỗ trợ video tham chiếu (@video_N) — bỏ video tham chiếu hoặc dùng Demo giả lập.')
  if (req.images.length > MAX_REF_IMAGES_PER_NODE) out.push(`canvasapp nhận tối đa ${MAX_REF_IMAGES_PER_NODE} ảnh tham chiếu.`)
  if (req.mode === 'i2v' && !req.images.length) out.push('Chế độ Ảnh → Video cần ít nhất 1 ảnh tham chiếu.')
  if (req.mode === 'transform' && (!req.firstFrame || !req.lastFrame)) out.push('Chế độ Khung đầu → cuối cần đủ khung đầu và khung cuối.')
  const profile = profiles?.find((p) => p.model_profile === modelProfileOf(req.model))
  if (profiles && !profile) out.push(`Tài khoản canvasapp không có model ${req.model}.`)
  if (profile) {
    if (profile.enabled === false || profile.can_create === false) out.push(`Model ${profile.display_name ?? req.model} đang tắt trên canvasapp.`)
    const o = profile.options ?? {}
    if (o.modes && !o.modes.includes(req.mode)) out.push(`canvasapp không có chế độ ${req.mode} cho ${profile.display_name ?? req.model}.`)
    if (o.disabled_modes?.includes(req.mode)) out.push(`Chế độ ${req.mode} đang tạm tắt trên canvasapp.`)
    if (o.durations && !o.durations.map(Number).includes(req.duration)) out.push(`canvasapp không có thời lượng ${req.duration}s.`)
    if (o.resolutions && !o.resolutions.includes(req.resolution)) out.push(`canvasapp không có độ phân giải ${req.resolution}.`)
    if (o.aspect_ratios && !o.aspect_ratios.includes(req.ratio)) out.push(`canvasapp không có tỉ lệ khung ${req.ratio}.`)
  }
  return out
}

export function uploadFilename(imageId: string, mime: string): string {
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
  return `${imageId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}.${ext}`
}

// ---------------------------------------------------------------------------------------------
// Job body
// ---------------------------------------------------------------------------------------------

export interface JobBodyContext {
  projectId: string
  /** upload_id for a SanoVids media-store image id (images + frames must already be uploaded). */
  uploadIdFor: (imageId: string) => string
  generateAudio?: boolean
}

/** SanoVids request → POST /api/video-jobs body. upload_ids follow @image_N order. */
export function toVideoJobBody(req: JobRequest, ctx: JobBodyContext): VideoJobBody {
  const images = [...req.images].sort((a, b) => a.n - b.n)
  const body: VideoJobBody = {
    project_id: ctx.projectId,
    model_profile: modelProfileOf(req.model),
    canvas_node_id: canvasNodeId(req.sceneId),
    prompt: req.prompt,
    mode: req.mode,
    duration: req.duration,
    resolution: req.resolution,
    generate_audio: ctx.generateAudio ?? true,
    upload_ids: req.mode === 'transform' ? [] : images.map((i) => ctx.uploadIdFor(i.imageId)),
    aspect_ratio: req.ratio,
    client_request_id: req.key,
  }
  if (req.mode === 'transform') {
    if (req.firstFrame) body.first_frame_upload_id = ctx.uploadIdFor(req.firstFrame.imageId)
    if (req.lastFrame) body.last_frame_upload_id = ctx.uploadIdFor(req.lastFrame.imageId)
  }
  return body
}

/** Every media-store image id the request needs uploaded, in upload order, without duplicates. */
export function imagesToUpload(req: JobRequest): string[] {
  const ids = req.mode === 'transform' ? [req.firstFrame?.imageId, req.lastFrame?.imageId] : [...req.images].sort((a, b) => a.n - b.n).map((i) => i.imageId)
  return [...new Set(ids.filter((x): x is string => !!x))]
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/** canvasapp job → provider status. "completed" only once the file can be downloaded. */
export function mapJobStatus(remoteId: string, job: CanvasJob): RemoteStatus {
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
      return { remoteId, state: 'failed', progress, error: job.error_message ? `canvasapp: ${job.error_message}` : 'canvasapp báo tạo video thất bại.' }
    case 'expired':
      return { remoteId, state: 'failed', progress, error: 'Job trên canvasapp đã hết hạn (không tải được nữa).' }
    case 'cancelled':
      return { remoteId, state: 'cancelled', progress }
    default:
      return { remoteId, state: 'processing', progress }
  }
}

// ---------------------------------------------------------------------------------------------
// Bridge canvas
// ---------------------------------------------------------------------------------------------

/** What the bridge canvas remembers about one SanoVids scene. */
export interface BridgeEntry {
  sceneId: string
  label: string
  model: ModelId
  mode: Mode
  duration: number
  resolution: string
  ratio: string
  prompt: string
  /** Reference uploads in @image_N order. */
  uploadIds: string[]
  firstFrameUploadId: string | null
  lastFrameUploadId: string | null
  /** Last time a job was submitted for this scene (newest entries win when the canvas is full). */
  usedAt: number
}

export function entryFromRequest(req: JobRequest, uploadIdFor: (imageId: string) => string, usedAt: number): BridgeEntry {
  const transform = req.mode === 'transform'
  return {
    sceneId: req.sceneId,
    label: `${req.sceneCode} · T${req.takeNumber}${req.title ? ' — ' + req.title : ''}`.slice(0, 120),
    model: req.model,
    mode: req.mode,
    duration: req.duration,
    resolution: req.resolution,
    ratio: req.ratio,
    prompt: req.prompt,
    uploadIds: transform ? [] : [...req.images].sort((a, b) => a.n - b.n).map((i) => uploadIdFor(i.imageId)),
    firstFrameUploadId: transform && req.firstFrame ? uploadIdFor(req.firstFrame.imageId) : null,
    lastFrameUploadId: transform && req.lastFrame ? uploadIdFor(req.lastFrame.imageId) : null,
    usedAt,
  }
}

const nodesOf = (e: BridgeEntry) => 1 + e.uploadIds.length + (e.firstFrameUploadId ? 1 : 0) + (e.lastFrameUploadId ? 1 : 0)

const ROW_H = 460
const IMG_W = 150
const IMG_COLS = 3
const VIDEO_X = IMG_COLS * IMG_W + 120

/**
 * Minimal canvas for the bridge project: one video node per scene (id = canvasNodeId(sceneId)), one image node per
 * reference/frame upload, wired with the right handle and @image order. Newest entries first; older entries are
 * dropped when the 40-node limit would be exceeded (the newest entry is always kept).
 */
export function bridgeCanvas(entries: BridgeEntry[]): CanvasPayload {
  const sorted = [...entries].sort((a, b) => b.usedAt - a.usedAt)
  const nodes: CanvasNode[] = []
  const connections: CanvasConnection[] = []
  let row = 0
  let y0 = 0
  for (const e of sorted) {
    const need = nodesOf(e)
    if (row > 0 && nodes.length + need > MAX_BRIDGE_NODES) continue
    const vid = canvasNodeId(e.sceneId)
    nodes.push({
      id: vid,
      type: 'video',
      x: VIDEO_X,
      y: y0,
      w: 360,
      h: 300,
      data: { model_profile: modelProfileOf(e.model), duration: e.duration, resolution: e.resolution, aspect_ratio: e.ratio, mode: e.mode, prompt: e.prompt, title: e.label },
    })
    const images: { uploadId: string; handle: CanvasConnection['target_handle']; order: number; suffix: string }[] = [
      ...e.uploadIds.map((uploadId, i) => ({ uploadId, handle: 'reference' as const, order: i + ORDER_BASE, suffix: `r${i + 1}` })),
      ...(e.firstFrameUploadId ? [{ uploadId: e.firstFrameUploadId, handle: 'first_frame' as const, order: ORDER_BASE, suffix: 'ff' }] : []),
      ...(e.lastFrameUploadId ? [{ uploadId: e.lastFrameUploadId, handle: 'last_frame' as const, order: ORDER_BASE, suffix: 'lf' }] : []),
    ]
    images.forEach((img, i) => {
      const id = `${vid}_${img.suffix}`
      nodes.push({ id, type: 'images', x: (i % IMG_COLS) * IMG_W, y: y0 + Math.floor(i / IMG_COLS) * IMG_W, data: { upload_ids: [img.uploadId] } })
      connections.push({ from: id, to: vid, target_handle: img.handle, order: img.order })
    })
    y0 += Math.max(ROW_H, Math.ceil(images.length / IMG_COLS) * IMG_W + 80)
    row++
  }
  return { nodes, connections, viewport: { x: 0, y: 0, zoom: 1 } }
}
