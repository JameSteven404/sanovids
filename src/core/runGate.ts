// Why a scene cannot run yet — ONE rule list, in one order, for every place that decides it: the queue
// (store/runs check(), used by enqueue and the run dialog) and every one-scene Run button (scene card on the canvas,
// inspector head + Take section, Storyboard card, Bảng cảnh row: components/runs/shared useSceneRunBlock or
// sceneRunBlock). Buttons that run a selection only open the run dialog, which lists the refused scenes with these
// texts. Pure (no stores): callers pass the gateway's cap and how to read a take's status.
//
// Reference videos (@video_N): only the videos the request would really send count (`compiled.videos`: none when
// the model/mode takes no video, at most the model's cap). The gateway's own cap comes from ONE place,
// `getProvider(id).capabilities(model).maxRefVideos` — 0 for canvasapp and development mode (providers/capabilities
// CANVASAPP_MAX_REF_VIDEOS, docs/canvasapp-api-notes.md "Reference videos"). Over the cap the scene is refused, never
// sent with fewer videos.

import { compileScene } from './compile'
import type { Asset, CompiledPrompt, Project, Scene } from './types'

/** Why a scene that sends reference videos cannot run on the canvasapp gateway (and development mode, its simulation). */
export const NO_VIDEO_REFS_REASON = 'Cổng canvasapp (cả chế độ Phát triển) chưa hỗ trợ video tham chiếu (@video) — bỏ video tham chiếu khỏi cảnh để chạy'

/**
 * `sent` = the reference videos the request carries (compileScene(...).videos.length); `maxRefVideos` = what the
 * gateway takes for this model (ProviderCapabilities.maxRefVideos). Null = OK.
 */
export function refVideosProblem(sent: number, maxRefVideos: number): string | null {
  if (sent <= 0 || sent <= maxRefVideos) return null
  if (maxRefVideos <= 0) return NO_VIDEO_REFS_REASON
  return `Cổng canvasapp (cả chế độ Phát triển) nhận tối đa ${maxRefVideos} video tham chiếu (@video) — bỏ bớt video tham chiếu khỏi cảnh để chạy`
}

export interface RunGate {
  /** Reference videos the gateway of the next run takes for the scene's model (ProviderCapabilities.maxRefVideos). */
  maxRefVideos: number
  /** Status of a take by id; undefined = no such take (deleted). */
  takeStatus: (takeId: string) => string | undefined
}

/**
 * Why `scene` cannot run now (Vietnamese, short: shown on the card, the inspector and the run dialog); null = it can.
 * `compiled` = compileScene(project, scene); `assets` = the project's (transform frames need a picture).
 * Order: prompt → images / frames → tokens with no media → reference videos (gateway first: waiting for a video to
 * finish would not help, then each SENT video must be a finished take).
 */
export function runBlockReason(scene: Scene, compiled: CompiledPrompt, assets: readonly Asset[], gate: RunGate): string | null {
  if (!scene.prompt.trim()) return 'Prompt trống'
  if (compiled.charCount > compiled.limit) return 'Prompt quá dài'
  const mode = scene.settings.mode
  if (mode === 'i2v' && compiled.images.length === 0) return 'Thiếu ảnh tham chiếu'
  if (mode === 'transform') {
    if (!scene.firstFrame || !scene.lastFrame) return 'Thiếu khung đầu/cuối'
    if ([scene.firstFrame, scene.lastFrame].some((id) => !assets.find((a) => a.id === id)?.imageIds[0])) return 'Khung đầu/cuối chưa có ảnh'
  }
  const unsent = compiled.unsentTokens
  if (unsent.length) {
    return `Prompt nhắc ${unsent.slice(0, 3).join(', ')}${unsent.length > 3 ? '…' : ''} nhưng không có ảnh/video đó trong lần gửi — sửa số hoặc nối thêm`
  }
  const videos = refVideosProblem(compiled.videos.length, gate.maxRefVideos)
  if (videos) return videos
  // Leftover references a mode without videos never sends (H3 t2v / transform) do not block the run.
  const statuses = compiled.videos.map((v) => gate.takeStatus(v.takeId))
  if (statuses.includes(undefined)) return 'Video tham chiếu đã bị xoá — bỏ video đó khỏi cảnh'
  if (statuses.some((st) => st !== 'completed')) return 'Video tham chiếu chưa sẵn sàng'
  return null
}

/**
 * `RunGate.takeStatus` from the statuses of `videoRefs` joined by ',' in the same order ('' = no such take) — the
 * stable string the canvas card / inspector subscribe to (it only changes when a reference video changes status).
 */
export function refStatusLookup(videoRefs: readonly string[], joined: string): (takeId: string) => string | undefined {
  const statuses = joined.split(',')
  return (takeId) => {
    const i = videoRefs.indexOf(takeId)
    return i < 0 ? undefined : statuses[i] || undefined
  }
}

/**
 * runBlockReason from what a one-scene Run button holds: the project's assets, the statuses of `scene.videoRefs`
 * joined by ',' ('' = no such take, see refStatusLookup) and the gateway's cap for the scene's model. Compiles the
 * scene itself (compileScene reads nothing but `assets` from the project).
 */
export function sceneRunBlock(scene: Scene, assets: readonly Asset[], videoStatus: string, maxRefVideos: number): string | null {
  const project: Project = { id: '', name: '', schemaVersion: 2, createdAt: 0, updatedAt: 0, presets: [], settings: { autoRenumber: true }, assets: [...assets], scenes: [scene] }
  return runBlockReason(scene, compileScene(project, scene), assets, { maxRefVideos, takeStatus: refStatusLookup(scene.videoRefs, videoStatus) })
}
