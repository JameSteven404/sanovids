// Why a scene cannot run yet: ONE rule list shared by the queue engine (store/runs check(), which RunConfirm shows),
// the scene card's ▶, the inspector's "Chạy", the scene table and the storyboard. Pure (no store, no provider).
//
// Order = the engine's; the first reason wins:
//   1. model of a newer SanoVids build (scene.foreignModel, kept by migrate), or values of a newer build for a model
//      this build knows (a config marker: scene.foreignSettings without foreignModel)
//   2. empty prompt                      3. prompt over the model's limit
//   4. i2v without any image             5. transform without both frames     6. a frame without an image
//   7. tokens with no media in the request (compiled.unsentTokens: 3 shown + "…")
//   8. a reference video that no longer exists   9. a reference video that is not finished
//  10. more reference videos than the gateway of new takes accepts (providerVideoCap; canvasapp and development mode: 0)
// Rules 8–9 look at every @video of the scene (as the engine always did); rule 10 only at the videos really sent
// (compiled.videos: none in a mode that sends no video).
import { compileScene } from './compile'
import { lostConfigValues, type ConfigKey } from './foreignMark'
import { MODELS, type ModelSpec } from './models'
import type { Asset, CompiledPrompt, Project, Scene } from './types'

export interface RunRuleInput {
  scene: Scene
  /** The project's assets (the frames of 'transform' must have an image). */
  assets: readonly Asset[]
  /** compileScene(project, scene): what would be sent. Take statuses are not needed here (see `takeStatus`). */
  compiled: CompiledPrompt
  /** Status of a take by id (reference videos); undefined = the take no longer exists. */
  takeStatus: (takeId: string) => string | undefined
  /** Model of the scene (default MODELS[scene.settings.model]); reserved for the route rules of other providers. */
  spec?: ModelSpec
  /** Reference videos per request accepted by the gateway of new takes (capabilities().maxRefVideos); null = no limit. */
  providerVideoCap: number | null
}

/**
 * Why @video blocks a run: the canvasapp gateway — and development mode, which runs the same gateway code against the
 * simulation — takes no reference video yet. (components/sidebar/shared.ts keeps the same text; runRules.test.ts
 * checks they match.)
 */
export const NO_VIDEO_REFS_REASON = 'Cổng canvasapp (cả chế độ Phát triển) chưa hỗ trợ video tham chiếu (@video) — bỏ @video để chạy'
export const EMPTY_PROMPT_REASON = 'Prompt trống'
export const LONG_PROMPT_REASON = 'Prompt quá dài'
export const NO_IMAGE_REASON = 'Thiếu ảnh tham chiếu'
export const NO_FRAMES_REASON = 'Thiếu khung đầu/cuối'
export const FRAME_IMAGE_REASON = 'Khung đầu/cuối chưa có ảnh'
export const DELETED_VIDEO_REASON = 'Video tham chiếu đã bị xoá (bỏ @video đó)'
export const PENDING_VIDEO_REASON = 'Video tham chiếu chưa sẵn sàng'

/** The scene uses a model of a newer SanoVids build (scene.foreignModel). */
export function foreignModelReason(model: string): string {
  return `Cảnh dùng model của bản SanoVids mới hơn (${model}) — cập nhật SanoVids để chạy (hoặc chọn lại model để chạy bằng model này).`
}

const CONFIG_LABEL: Record<ConfigKey, (v: string | number) => string> = {
  mode: (v) => `chế độ ${v}`,
  duration: (v) => `thời lượng ${v}s`,
  resolution: (v) => `độ phân giải ${v}`,
  ratio: (v) => `tỉ lệ ${v}`,
}

/**
 * The scene keeps values of a newer SanoVids build for a model this build knows (scene.foreignSettings without
 * foreignModel): `settings` only hold stand-in values for them.
 */
export function foreignConfigReason(foreignSettings: Record<string, unknown>): string {
  const values = lostConfigValues(foreignSettings, true).map((x) => CONFIG_LABEL[x.key](x.value))
  return `Cảnh dùng cấu hình của bản SanoVids mới hơn${values.length ? ` (${values.join(', ')})` : ''} — cập nhật SanoVids để chạy (hoặc chọn lại cấu hình để chạy bằng cấu hình này).`
}

/** Tokens with no picture / video behind them in the request: the first 3, then "…". */
export function unsentTokensReason(tokens: readonly string[]): string {
  return `Prompt nhắc ${tokens.slice(0, 3).join(', ')}${tokens.length > 3 ? '…' : ''} nhưng không có ảnh/video đó trong lần gửi — sửa số hoặc nối thêm`
}

/** Why the scene cannot run (the first rule that fails), or null when it can. */
export function runBlockReason({ scene, assets, compiled, takeStatus, providerVideoCap }: RunRuleInput): string | null {
  if (typeof scene.foreignModel === 'string' && scene.foreignModel) return foreignModelReason(scene.foreignModel)
  if (scene.foreignSettings && typeof scene.foreignSettings === 'object') return foreignConfigReason(scene.foreignSettings)
  if (!scene.prompt.trim()) return EMPTY_PROMPT_REASON
  if (compiled.charCount > compiled.limit) return LONG_PROMPT_REASON
  const mode = scene.settings.mode
  if (mode === 'i2v' && compiled.images.length === 0) return NO_IMAGE_REASON
  if (mode === 'transform') {
    if (!scene.firstFrame || !scene.lastFrame) return NO_FRAMES_REASON
    const frames = [scene.firstFrame, scene.lastFrame]
    if (frames.some((id) => !assets.find((a) => a.id === id)?.imageIds[0])) return FRAME_IMAGE_REASON
  }
  if (compiled.unsentTokens.length) return unsentTokensReason(compiled.unsentTokens)
  if (scene.videoRefs.length) {
    const statuses = scene.videoRefs.map(takeStatus)
    if (statuses.includes(undefined)) return DELETED_VIDEO_REASON
    if (statuses.some((st) => st !== 'completed')) return PENDING_VIDEO_REASON
  }
  if (providerVideoCap !== null && compiled.videos.length > providerVideoCap) return NO_VIDEO_REFS_REASON
  return null
}

// ---------------- helpers for the UI (stable zustand selections) ----------------

const compiled = new WeakMap<Scene, { assets: readonly Asset[]; result: CompiledPrompt }>()

/**
 * compileScene for a scene of the store, without take statuses, cached per scene object + assets array (both are
 * replaced, never mutated, by the store): safe to call from a selector that runs on every store change.
 */
export function compiledOf(assets: readonly Asset[], scene: Scene): CompiledPrompt {
  const hit = compiled.get(scene)
  if (hit && hit.assets === assets) return hit.result
  const project: Project = {
    id: '',
    name: '',
    schemaVersion: 2,
    createdAt: 0,
    updatedAt: 0,
    assets: assets as Asset[],
    presets: [],
    scenes: [scene],
    settings: { autoRenumber: true },
  }
  const result = compileScene(project, scene)
  compiled.set(scene, { assets, result })
  return result
}

/** runBlockReason of a scene of the store (cached compile). */
export function sceneRunBlockReason(
  assets: readonly Asset[],
  scene: Scene,
  takeStatus: (takeId: string) => string | undefined,
  providerVideoCap: number | null,
): string | null {
  return runBlockReason({ scene, assets, compiled: compiledOf(assets, scene), takeStatus, providerVideoCap, spec: MODELS[scene.settings.model] })
}

/**
 * Status of each reference video as one string — a stable selector result that only changes when a status does
 * (not on progress ticks): "takeId=status" pairs, "takeId=" for a take that no longer exists, '' without videos.
 */
export function videoStatusKey(videoRefs: readonly string[], statusOf: (takeId: string) => string | undefined): string {
  if (!videoRefs.length) return ''
  return videoRefs.map((id) => `${id}=${statusOf(id) ?? ''}`).join(',')
}

/** The take status lookup a videoStatusKey stands for (undefined = deleted, or not part of the key). */
export function takeStatusFromKey(key: string): (takeId: string) => string | undefined {
  const map = new Map<string, string>()
  if (key) {
    for (const pair of key.split(',')) {
      const i = pair.lastIndexOf('=')
      if (i > 0 && i < pair.length - 1) map.set(pair.slice(0, i), pair.slice(i + 1))
    }
  }
  return (takeId) => map.get(takeId)
}
