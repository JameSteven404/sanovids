// What canvasapp's OWN page does when the user presses "Tạo video" on a video node — pure, no I/O. Shared by the
// in-app dev server ("Tạo job như trên trang canvasapp", DevCanvasapp.createSiteJob) and the strict e2e fake
// (providers/__tests__/canvasapp-e2e.test.ts), so "Nhập job" is tested against jobs made exactly like the site makes
// them: the node's data from the saved canvas, its reference edges in `order` → each image node's upload, the frames
// by handle, a random client_request_id (never one of a SanoVids take). The body must pass validate.ts.
//
// ---- API ----
//   siteJobBody(canvas, nodeId, projectId, clientRequestId)   → { body } | { problem } (runVideoNode())
//   applyNodeEdit(canvas, nodeId, edit)                         → the canvas after the user edited that node on the
//                                                                  page (prompt / resolution / duration), or a problem
//   siteNodeList(canvas)                                        the canvas' video nodes, for the dev panel
import { MODELS } from '../../core/models'
import type { Mode, ModelId } from '../../core/types'
import { inputShapeOf, modelProfileOf, resolutionOf } from '../canvasapp/mapping'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const modelOf = (profile: unknown): ModelId | null => (Object.keys(MODELS) as ModelId[]).find((m) => modelProfileOf(m) === profile) ?? null

function videoNode(canvas: unknown, nodeId: string): { nodes: Json[]; connections: Json[]; node: Json; data: Json } | null {
  if (!isObj(canvas) || !Array.isArray(canvas.nodes)) return null
  const nodes = canvas.nodes.filter(isObj)
  const node = nodes.find((n) => n.id === nodeId && n.type === 'video')
  if (!node || !isObj(node.data)) return null
  return { nodes, connections: Array.isArray(canvas.connections) ? canvas.connections.filter(isObj) : [], node, data: node.data }
}

/**
 * The POST /api/video-jobs body canvasapp's runVideoNode() sends for video node `nodeId` of a saved canvas, key for
 * key: project_id, model_profile, canvas_node_id, prompt (trimmed), mode, duration, resolution, generate_audio: true;
 * then upload_ids (references in `order`) + aspect_ratio ('16:9' fallback) — or, for MiniMax-H3 transform, the two
 * frames' uploads — and last client_request_id.
 */
export function siteJobBody(canvas: unknown, nodeId: string, projectId: string, clientRequestId: string): { body: Json } | { problem: string } {
  const v = videoNode(canvas, nodeId)
  if (!v) return { problem: 'Không có node video này trên canvas của phiên.' }
  const d = v.data
  const model = modelOf(d.model_profile)
  if (!model) return { problem: `Model ${String(d.model_profile)} không có trong bảng của SanoVids.` }
  const mode = String(d.mode) as Mode
  if (!MODELS[model].modes.includes(mode)) return { problem: `Chế độ ${String(d.mode)} không có cho ${MODELS[model].name}.` }
  if (typeof d.prompt !== 'string' || !d.prompt.trim()) return { problem: 'Node chưa có prompt — trang canvasapp không chạy node này.' }
  const uploadOf = (from: unknown): string | null => {
    const n = v.nodes.find((x) => x.id === from && x.type === 'images')
    const ids = n && isObj(n.data) && Array.isArray(n.data.upload_ids) ? n.data.upload_ids : []
    return typeof ids[0] === 'string' ? ids[0] : null
  }
  const into = v.connections.filter((c) => c.to === nodeId)
  const shape = inputShapeOf(model, mode)
  let inputs: Json
  if (shape === 'frames') {
    const frame = (handle: string) => uploadOf(into.find((c) => c.target_handle === handle)?.from)
    const first = frame('first_frame')
    const last = frame('last_frame')
    if (!first || !last) return { problem: 'Node Khung đầu → cuối chưa đủ hai khung — trang canvasapp không chạy node này.' }
    inputs = { first_frame_upload_id: first, last_frame_upload_id: last }
  } else {
    const refs =
      shape === 'refs'
        ? into
            .filter((c) => c.target_handle === 'reference')
            .sort((a, b) => Number(a.order) - Number(b.order))
            .map((c) => uploadOf(c.from))
        : []
    if (refs.some((u) => u === null)) return { problem: 'Một ảnh tham chiếu của node không có upload.' }
    inputs = { upload_ids: refs, aspect_ratio: typeof d.aspect_ratio === 'string' && d.aspect_ratio ? d.aspect_ratio : '16:9' }
  }
  return {
    body: {
      project_id: projectId,
      model_profile: d.model_profile,
      canvas_node_id: nodeId,
      prompt: d.prompt.trim(),
      mode,
      duration: d.duration,
      resolution: typeof d.resolution === 'string' ? resolutionOf(d.resolution) : d.resolution,
      generate_audio: true,
      ...inputs,
      client_request_id: clientRequestId,
    },
  }
}

/** What the user may change on a node before pressing "Tạo video" (the dev panel offers these). */
export interface SiteNodeEdit {
  prompt?: string
  resolution?: string
  duration?: number
}

/**
 * The canvas after the user edited node `nodeId` on canvasapp's page (saveCanvas() then sends it): only the node's
 * `data` changes — prompt as typed, resolution lower-cased, duration — values the node's model offers.
 */
export function applyNodeEdit(canvas: unknown, nodeId: string, edit: SiteNodeEdit): { canvas: Json } | { problem: string } {
  const v = videoNode(canvas, nodeId)
  if (!v || !isObj(canvas)) return { problem: 'Không có node video này trên canvas của phiên.' }
  const model = modelOf(v.data.model_profile)
  if (!model) return { problem: 'Model của node không có trong bảng của SanoVids.' }
  const spec = MODELS[model]
  const data: Json = { ...v.data }
  if (edit.prompt !== undefined) data.prompt = edit.prompt
  if (edit.resolution !== undefined) {
    const r = spec.resolutions.find((x) => resolutionOf(x) === resolutionOf(edit.resolution!))
    if (!r) return { problem: `${spec.name} không có độ phân giải ${edit.resolution}.` }
    data.resolution = resolutionOf(r)
  }
  if (edit.duration !== undefined) {
    if (!spec.durations.includes(edit.duration)) return { problem: `${spec.name} không có thời lượng ${edit.duration}s.` }
    data.duration = edit.duration
  }
  return { canvas: { ...canvas, nodes: (canvas.nodes as unknown[]).map((n) => (n === v.node ? { ...v.node, data } : n)) } }
}

export interface SiteNodeInfo {
  id: string
  model: ModelId | null
  mode: string
  duration: number | null
  resolution: string
  aspectRatio: string | null
  prompt: string
  /** Reference / frame pictures wired into it. */
  pictures: number
}

/** The video nodes of a saved canvas, in canvas order (the dev panel's "Node (cảnh)" list). */
export function siteNodeList(canvas: unknown): SiteNodeInfo[] {
  if (!isObj(canvas) || !Array.isArray(canvas.nodes)) return []
  const connections = Array.isArray(canvas.connections) ? canvas.connections.filter(isObj) : []
  return canvas.nodes.filter(isObj).flatMap((n): SiteNodeInfo[] => {
    if (n.type !== 'video' || typeof n.id !== 'string' || !isObj(n.data)) return []
    const d = n.data
    return [
      {
        id: n.id,
        model: modelOf(d.model_profile),
        mode: String(d.mode ?? ''),
        duration: typeof d.duration === 'number' ? d.duration : null,
        resolution: String(d.resolution ?? ''),
        aspectRatio: typeof d.aspect_ratio === 'string' ? d.aspect_ratio : null,
        prompt: typeof d.prompt === 'string' ? d.prompt : '',
        pictures: connections.filter((c) => c.to === n.id).length,
      },
    ]
  })
}
