// The call shapes of the one-scene Run buttons (scene card on the canvas, inspector head + Take section — and the
// hidden, frozen Storyboard card: components/runs/shared useSceneRunBlock) over the ONE rule list of core/runRules —
// the list store/runs check() uses too, so a button and the queue never disagree. No rule lives here.
// Buttons that run a selection only open the run dialog, which lists the refused scenes with these texts.
//
// Reference videos (@video_N) were retired in 0.6.0: @video text left in a prompt blocks the run by itself (rule 7 of
// core/runRules, compiled.retiredTokens); nothing about takes or the gateway's video cap is asked any more.
//
// Settings the gateway refuses right now (/api/video-profiles: a model that cannot create, a mode switched off…): the
// caller passes `settingsBlock` = providers/limits settingsRunBlock(providerLimits(id), scene.settings) — only a sure
// refusal (a recent read); a guess or an older read never blocks (the submit reads again and decides).

import * as rules from './runRules'
import type { Asset, CompiledPrompt, Scene } from './types'

export interface RunGate {
  /** The gateway's sure refusal of the scene's settings (providers/limits settingsRunBlock); null / omitted = none. */
  settingsBlock?: string | null
}

/**
 * Why `scene` cannot run now (Vietnamese, short: shown on the card, the inspector and the run dialog); null = it can.
 * `compiled` = compileScene(project, scene); `assets` = the project's (transform frames need a picture).
 * = core/runRules runBlockReason (its order: newer-build markers → prompt → images / frames → retired @video text →
 * tokens with no picture → settings the gateway refuses now).
 */
export function runBlockReason(scene: Scene, compiled: CompiledPrompt, assets: readonly Asset[], gate: RunGate = {}): string | null {
  return rules.runBlockReason({ scene, assets, compiled, settingsBlock: gate.settingsBlock })
}

/**
 * runBlockReason from what a one-scene Run button holds: the project's assets and the gateway's sure refusal of the
 * scene's settings. Uses the cached compile of core/runRules (per scene object + assets array).
 */
export function sceneRunBlock(scene: Scene, assets: readonly Asset[], settingsBlock: string | null = null): string | null {
  return rules.sceneRunBlockReason(assets, scene, settingsBlock)
}
