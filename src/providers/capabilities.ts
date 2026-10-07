// Capabilities derived from the local model table (core/models.ts).
import { MODELS } from '../core/models'
import type { ModelId } from '../core/types'
import type { ProviderCapabilities } from './types'

// Reference videos (@video_N) were retired in 0.6.0: no provider is asked for a video cap any more; @video text left in
// a prompt is refused by core/runRules and mapping.validateRequest (core/compile retiredVideoTokens).
export function capabilitiesFromModels(model: ModelId, extra: { maxConcurrency: number; pollIntervalMs: number }): ProviderCapabilities {
  const spec = MODELS[model] ?? MODELS.seedance_2_5
  return {
    model: spec.id,
    modes: [...spec.modes],
    durations: [...spec.durations],
    resolutions: [...spec.resolutions],
    ratios: [...spec.ratios],
    maxRefImages: spec.maxRefImages,
    promptLimit: spec.promptLimit,
    maxConcurrency: extra.maxConcurrency,
    pollIntervalMs: extra.pollIntervalMs,
  }
}
