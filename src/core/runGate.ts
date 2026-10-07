// The call shapes of the one-scene Run buttons (scene card on the canvas, inspector head + Take section, Storyboard
// card, Bảng cảnh row: components/runs/shared useSceneRunBlock or sceneRunBlock) over the ONE rule list of
// core/runRules — the list store/runs check() uses too, so a button and the queue never disagree. No rule lives here.
// Buttons that run a selection only open the run dialog, which lists the refused scenes with these texts.
//
// Reference videos (@video_N): only the videos the request would really send count (`compiled.videos`: none when
// the model/mode takes no video, at most the model's cap). The gateway's own cap comes from ONE place,
// `getProvider(id).capabilities(model).maxRefVideos` — 0 for canvasapp and development mode (providers/capabilities
// CANVASAPP_MAX_REF_VIDEOS, docs/canvasapp-api-notes.md "Reference videos"). Over the cap the scene is refused, never
// sent with fewer videos.
//
// Settings the gateway refuses right now (/api/video-profiles: a model that cannot create, a mode switched off…): the
// caller passes `settingsBlock` = providers/limits settingsRunBlock(providerLimits(id), scene.settings) — only a sure
// refusal (a recent read); a guess or an older read never blocks (the submit reads again and decides).

import * as rules from './runRules'
import type { Asset, CompiledPrompt, Scene } from './types'

export { NO_VIDEO_REFS_REASON, refStatusLookup, refVideosProblem } from './runRules'

export interface RunGate {
  /** Reference videos the gateway of the next run takes for the scene's model (ProviderCapabilities.maxRefVideos). */
  maxRefVideos: number
  /** Status of a take by id; undefined = no such take (deleted). */
  takeStatus: (takeId: string) => string | undefined
  /** The gateway's sure refusal of the scene's settings (providers/limits settingsRunBlock); null / omitted = none. */
  settingsBlock?: string | null
}

/**
 * Why `scene` cannot run now (Vietnamese, short: shown on the card, the inspector and the run dialog); null = it can.
 * `compiled` = compileScene(project, scene); `assets` = the project's (transform frames need a picture).
 * = core/runRules runBlockReason (its order: newer-build markers → prompt → images / frames → tokens with no media →
 * the gateway's @video cap → each SENT video a finished take → settings the gateway refuses now).
 */
export function runBlockReason(scene: Scene, compiled: CompiledPrompt, assets: readonly Asset[], gate: RunGate): string | null {
  return rules.runBlockReason({ scene, assets, compiled, takeStatus: gate.takeStatus, providerVideoCap: gate.maxRefVideos, settingsBlock: gate.settingsBlock })
}

/**
 * runBlockReason from what a one-scene Run button holds: the project's assets, the statuses of `scene.videoRefs`
 * joined by ',' ('' = no such take, see refStatusLookup), the gateway's cap for the scene's model and its sure refusal
 * of the scene's settings. Uses the cached compile of core/runRules (per scene object + assets array).
 */
export function sceneRunBlock(scene: Scene, assets: readonly Asset[], videoStatus: string, maxRefVideos: number, settingsBlock: string | null = null): string | null {
  return rules.sceneRunBlockReason(assets, scene, rules.refStatusLookup(scene.videoRefs, videoStatus), maxRefVideos, settingsBlock)
}
