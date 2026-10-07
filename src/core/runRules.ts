// Why a scene cannot run yet: ONE rule list shared by the queue engine (store/runs check(), which RunConfirm shows),
// the scene card's ▶, the inspector's "Chạy" (head + Take section) and the hidden, frozen storyboard. Pure (no
// store, no provider): callers pass the gateway's sure refusal of the settings. core/runGate.ts only keeps the
// positional call shapes of the one-scene Run buttons (components/runs/shared useSceneRunBlock) over this same list.
//
// Order = the engine's; the first reason wins:
//   1. model of a newer SanoVids build (scene.foreignModel, kept by migrate), or values of a newer build for a model
//      this build knows (a config marker: scene.foreignSettings without foreignModel)
//   2. empty prompt                      3. prompt over the model's limit
//   4. i2v without any image             5. transform without both frames     6. a frame without an image
//   7. retired @video text left in the prompt (compiled.retiredTokens — reference videos were retired in 0.6.0: the
//      text is kept verbatim but never sent; named before rule 8 so the specific reason wins)
//   8. red placeholders left by a removed picture ("@image_?2(Lumi)": waitingReason, 3 names shown + "…"), then
//      a labelled token whose label does not fit the picture its number names now ("@image_2(Lumi)" while 2 is
//      Làng: mismatchReason — a placeholder whose "?" was deleted by hand), then any other token with no picture in
//      the request (compiled.unsentTokens without those: bare "@image_?N", numbers out of range…, 3 shown + "…")
//   9. settings the gateway surely refuses now (settingsBlock = providers/limits settingsRunBlock, a firm
//      /api/video-profiles read; last, like the profile checks of the submit's validateRequest)
// A scene that once used reference videos but whose prompt no longer names one runs with its images only.
import { compileScene, PLACEHOLDER_RE, retiredTokenList } from './compile'
import { labelledTokens } from './placeholders'
import { lostConfigValues, type ConfigKey } from './foreignMark'
import { MODELS, type ModelSpec } from './models'
import type { Asset, CompiledPrompt, Project, Scene } from './types'

export interface RunRuleInput {
  scene: Scene
  /** The project's assets (the frames of 'transform' must have an image). */
  assets: readonly Asset[]
  /** compileScene(project, scene): what would be sent. */
  compiled: CompiledPrompt
  /** Model of the scene (default MODELS[scene.settings.model]); reserved for the route rules of other providers. */
  spec?: ModelSpec
  /** The gateway's sure refusal of the scene's settings (providers/limits settingsRunBlock); null / omitted = none. */
  settingsBlock?: string | null
  /** @deprecated Ignored: reference videos were retired (0.6.0). Kept so older callers still compile. */
  takeStatus?: (takeId: string) => string | undefined
  /** @deprecated Ignored: reference videos were retired (0.6.0). Kept so older callers still compile. */
  providerVideoCap?: number | null
}

export const EMPTY_PROMPT_REASON = 'Prompt trống'
export const LONG_PROMPT_REASON = 'Prompt quá dài'
export const NO_IMAGE_REASON = 'Thiếu ảnh tham chiếu'
export const NO_FRAMES_REASON = 'Thiếu khung đầu/cuối'
export const FRAME_IMAGE_REASON = 'Khung đầu/cuối chưa có ảnh'

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

/** Retired @video text left in the prompt (compiled.retiredTokens): the first 3, then "…". */
export function retiredVideoReason(tokens: readonly string[]): string {
  return `Prompt còn ${retiredTokenList(tokens)} — SanoVids đã bỏ video tham chiếu: xoá hoặc viết lại chữ đó để chạy`
}

/** Tokens with no picture behind them in the request: the first 3, then "…". */
export function unsentTokensReason(tokens: readonly string[]): string {
  return `Prompt nhắc ${retiredTokenList(tokens)} nhưng không có ảnh đó trong lần gửi — sửa số hoặc nối thêm ảnh`
}

/**
 * Red placeholders with a label ("@image_?2(Lumi)") still in the prompt: who they waited for (the first 3, then "…")
 * and their placeholders.
 */
export function waitingReason(items: readonly { name: string; token: string }[]): string {
  const shown = items.slice(0, 3).map((x) => `${x.name} (${x.token})`).join(', ')
  return `Còn chữ đỏ chờ ảnh: ${shown}${items.length > 3 ? '…' : ''} — nối ảnh thay thế rồi bấm “Gắn vào chỗ…”, hoặc bấm “Đổi thành chữ” nếu không cần nhân vật đó`
}

/** A labelled token whose label does not fit the picture its number names now ("@image_2(Lumi)" while 2 is Làng). */
export function mismatchReason(n: number, now: string, label: string): string {
  return `@image_${n} đang là “${now}”, không phải “${label}” — kiểm tra ở dải “Chữ đỏ chờ ảnh” dưới ô prompt`
}

/** Why the scene cannot run (the first rule that fails), or null when it can. */
export function runBlockReason({ scene, assets, compiled, settingsBlock }: RunRuleInput): string | null {
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
  if (compiled.retiredTokens.length) return retiredVideoReason(compiled.retiredTokens)
  const retired = new Set(compiled.retiredTokens)
  const unsent = compiled.unsentTokens.filter((t) => !retired.has(t))
  if (unsent.length) {
    // labelled placeholders first (the usual case right after a cut), then labels that do not fit, then the rest
    const waiting: { name: string; token: string }[] = []
    for (const t of unsent) {
      for (const m of t.matchAll(PLACEHOLDER_RE)) if (m.index === 0 && m[0] === t && m[3] && m[1].toLowerCase() === 'image') waiting.push({ name: m[3], token: `@image_?${m[2]}` })
    }
    if (waiting.length) return waitingReason(waiting)
    const labelled = new Set(unsent.filter((t) => t.endsWith(')')))
    if (labelled.size) {
      const bad = labelledTokens(compiled.text, assets, scene.refs).find((x) => !x.fits && x.slotName !== undefined && labelled.has(x.text))
      if (bad) return mismatchReason(bad.n, bad.slotName!, bad.label)
    }
    return unsentTokensReason(unsent)
  }
  return settingsBlock || null
}

// ---------------- helpers for the UI (stable zustand selections) ----------------

const compiled = new WeakMap<Scene, { assets: readonly Asset[]; result: CompiledPrompt }>()

/**
 * compileScene for a scene of the store, cached per scene object + assets array (both are replaced, never mutated, by
 * the store): safe to call from a selector that runs on every store change.
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
export function sceneRunBlockReason(assets: readonly Asset[], scene: Scene, settingsBlock: string | null = null): string | null {
  return runBlockReason({ scene, assets, compiled: compiledOf(assets, scene), settingsBlock, spec: MODELS[scene.settings.model] })
}

/**
 * @deprecated Reference videos were retired (0.6.0): no take status matters to a run any more. Returns a lookup that
 * knows no take; kept so older callers still compile.
 */
export function refStatusLookup(_videoRefs: readonly string[], _joined: string): (takeId: string) => string | undefined {
  return () => undefined
}
