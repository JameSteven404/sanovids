// Capabilities derived from the local model table (core/models.ts).
import { MODELS } from '../core/models'
import type { ModelId } from '../core/types'
import type { ProviderCapabilities } from './types'

/**
 * Reference videos (@video_N) the canvasapp gateway — and development mode, the same code against the simulation —
 * takes per job: none. Nothing on record shows canvasapp accepting a video (docs/canvasapp-api-notes.md "Reference
 * videos — not observed"); a guessed body is refused at best and, at worst, accepted and billed without the video.
 * The ONE source of the @video gate: adapter capabilities() → store/runs check(), the scene card, the inspector
 * (core/runGate). Opening it also needs mapping.validateRequest / toVideoJobBody, api.ts and the dev server (see the
 * checklist there); /api/video-profiles never changes it.
 */
export const CANVASAPP_MAX_REF_VIDEOS = 0

export function capabilitiesFromModels(model: ModelId, extra: { maxConcurrency: number; pollIntervalMs: number; maxRefVideos?: number }): ProviderCapabilities {
  const spec = MODELS[model] ?? MODELS.seedance_2_5
  return {
    model: spec.id,
    modes: [...spec.modes],
    durations: [...spec.durations],
    resolutions: [...spec.resolutions],
    ratios: [...spec.ratios],
    maxRefImages: spec.maxRefImages,
    maxRefVideos: extra.maxRefVideos ?? spec.maxRefVideos,
    promptLimit: spec.promptLimit,
    maxConcurrency: extra.maxConcurrency,
    pollIntervalMs: extra.pollIntervalMs,
  }
}
