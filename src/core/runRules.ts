// Why a scene cannot run yet: ONE rule list shared by the queue engine (store/runs check(), which RunConfirm shows),
// the scene card's ▶, the inspector's "Chạy" (head + Take section) and the hidden, frozen storyboard. Pure (no
// store, no provider): callers pass the gateway's sure refusal of the settings. core/runGate.ts only keeps the
// positional call shapes of the one-scene Run buttons (components/runs/shared useSceneRunBlock) over this same list.
//
// Order = the engine's; the first reason wins:
//   1. model of a newer SanoVids build (scene.foreignModel, kept by migrate), or values of a newer build for a model
//      this build knows (a config marker: scene.foreignSettings without foreignModel); then a discontinued route
//      (ModelSpec.hidden, kind 'settings')
//   2. empty prompt                      3. prompt over the model's limit
//   4. i2v without any image (the upper bound is rule 8: tokens past the model's cap are unsent)
//   5. a mode's frames missing           6. a frame without an image — per route (models frameSlots: canvasapp
//      "Khung đầu → cuối" both, Veo 3.1 "Khung đầu → Video" the first only)
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
import { frameSlots, MODELS, modelLabel, specOf, type ModelSpec } from './models'
import type { Asset, CompiledPrompt, Project, Scene } from './types'

export interface RunRuleInput {
  scene: Scene
  /** The project's assets (the frames of 'transform' must have an image). */
  assets: readonly Asset[]
  /** compileScene(project, scene): what would be sent. */
  compiled: CompiledPrompt
  /** Model of the scene (default specOf(scene.settings.model)): its frames (rules 5 / 6) and whether it is discontinued. */
  spec?: ModelSpec
  /** The gateway's sure refusal of the scene's settings (providers/limits settingsRunBlock); null / omitted = none. */
  settingsBlock?: string | null
}

export const EMPTY_PROMPT_REASON = 'Prompt trống'
export const LONG_PROMPT_REASON = 'Prompt quá dài'
export const NO_IMAGE_REASON = 'Thiếu ảnh tham chiếu'
export const NO_FRAMES_REASON = 'Thiếu khung đầu/cuối'
export const FRAME_IMAGE_REASON = 'Khung đầu/cuối chưa có ảnh'
/** A mode that sends only the opening frame (Veo 3.1 "Khung đầu → Video"). */
export const NO_FIRST_FRAME_REASON = 'Thiếu khung đầu'
export const FIRST_FRAME_IMAGE_REASON = 'Khung đầu chưa có ảnh'

/** The scene's route was discontinued (ModelSpec.hidden): it is kept, never run. */
export function retiredModelReason(model: string): string {
  return `${modelLabel(model, { withService: true })} đã ngừng — chọn model khác để chạy`
}

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

/**
 * Which rule blocked a run (runBlock): newer-build markers, the prompt, images / frames, retired @video text, red
 * placeholders, labels that do not fit, other tokens with no picture, the gateway's settings refusal.
 */
export type RunBlockKind = 'foreign' | 'empty' | 'long' | 'no-image' | 'frames' | 'retired' | 'waiting' | 'mismatch' | 'unsent' | 'settings'

export interface RunBlock {
  reason: string
  kind: RunBlockKind
}

/**
 * Blocks caused by text in the prompt that every highlighter draws red (tokens.ts segmentPrompt): retired @video text,
 * red placeholders "@image_?N(…)", labelled tokens that do not fit their picture, numbers with no picture in the
 * request — the scene card says "Chưa chạy · còn chữ đỏ" for these.
 */
export function isRedTextBlock(block: RunBlock | null | undefined): boolean {
  return !!block && (block.kind === 'retired' || block.kind === 'waiting' || block.kind === 'mismatch' || block.kind === 'unsent')
}

/** The first rule that fails, with its kind (runBlockReason = its reason), or null when the scene can run. */
export function runBlock({ scene, assets, compiled, settingsBlock, spec: given }: RunRuleInput): RunBlock | null {
  const block = (kind: RunBlockKind, reason: string): RunBlock => ({ kind, reason })
  if (typeof scene.foreignModel === 'string' && scene.foreignModel) return block('foreign', foreignModelReason(scene.foreignModel))
  if (scene.foreignSettings && typeof scene.foreignSettings === 'object') return block('foreign', foreignConfigReason(scene.foreignSettings))
  const spec = given ?? specOf(scene.settings.model)
  if (spec.hidden) return block('settings', retiredModelReason(scene.settings.model))
  if (!scene.prompt.trim()) return block('empty', EMPTY_PROMPT_REASON)
  if (compiled.charCount > compiled.limit) return block('long', LONG_PROMPT_REASON)
  const mode = scene.settings.mode
  if (mode === 'i2v' && compiled.images.length === 0) return block('no-image', NO_IMAGE_REASON)
  // frames per route (models frameSlots): canvasapp "Khung đầu → cuối" both, Veo "Khung đầu → Video" the first only
  const slots = frameSlots(spec, mode)
  if (slots.first || slots.last) {
    const firstOnly = !slots.last
    if ((slots.first && !scene.firstFrame) || (slots.last && !scene.lastFrame)) return block('frames', firstOnly ? NO_FIRST_FRAME_REASON : NO_FRAMES_REASON)
    const frames = [slots.first ? scene.firstFrame : null, slots.last ? scene.lastFrame : null].filter((id): id is string => !!id)
    if (frames.some((id) => !assets.find((a) => a.id === id)?.imageIds[0])) return block('frames', firstOnly ? FIRST_FRAME_IMAGE_REASON : FRAME_IMAGE_REASON)
  }
  if (compiled.retiredTokens.length) return block('retired', retiredVideoReason(compiled.retiredTokens))
  const retired = new Set(compiled.retiredTokens)
  const unsent = compiled.unsentTokens.filter((t) => !retired.has(t))
  if (unsent.length) {
    // labelled placeholders first (the usual case right after a cut), then labels that do not fit, then the rest
    const waiting: { name: string; token: string }[] = []
    for (const t of unsent) {
      for (const m of t.matchAll(PLACEHOLDER_RE)) if (m.index === 0 && m[0] === t && m[3] && m[1].toLowerCase() === 'image') waiting.push({ name: m[3], token: `@image_?${m[2]}` })
    }
    if (waiting.length) return block('waiting', waitingReason(waiting))
    const labelled = new Set(unsent.filter((t) => t.endsWith(')')))
    if (labelled.size) {
      const bad = labelledTokens(compiled.text, assets, scene.refs).find((x) => !x.fits && x.slotName !== undefined && labelled.has(x.text))
      if (bad) return block('mismatch', mismatchReason(bad.n, bad.slotName!, bad.label))
    }
    return block('unsent', unsentTokensReason(unsent))
  }
  return settingsBlock ? block('settings', settingsBlock) : null
}

/** Why the scene cannot run (the first rule that fails), or null when it can. */
export function runBlockReason(input: RunRuleInput): string | null {
  return runBlock(input)?.reason ?? null
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
