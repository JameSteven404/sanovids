// Capabilities derived from the local model table (core/models.ts).
import { MODELS } from '../core/models'
import type { ModelId } from '../core/types'
import type { ProviderCapabilities } from './types'

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
