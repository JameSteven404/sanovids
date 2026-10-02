import type { ModelId, Mode, VideoSettings } from './types'

export interface ModelSpec {
  id: ModelId
  name: string
  short: string
  modes: Mode[]
  durations: number[]
  resolutions: string[]
  ratios: string[]
  maxRefImages: number
  /** Reference videos (@video_N) accepted per request. */
  maxRefVideos: number
  promptLimit: (mode: Mode) => number
  /** credits[resolution][duration] — demo credits, 1 credit ≈ 1.000đ (same table as canvasapp). */
  pricing: Record<string, Record<number, number>>
  color: string
}

export const MODELS: Record<ModelId, ModelSpec> = {
  seedance_2_5: {
    id: 'seedance_2_5',
    name: 'Seedance 2.5',
    short: 'SD 2.5',
    modes: ['t2v'],
    durations: [5, 10, 15, 30],
    resolutions: ['480p', '720p', '1080p'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    maxRefImages: 30,
    maxRefVideos: 10,
    promptLimit: () => 20000,
    pricing: {
      '480p': { 5: 4, 10: 5, 15: 10, 30: 15 },
      '720p': { 5: 5, 10: 10, 15: 15, 30: 20 },
      '1080p': { 5: 10, 10: 15, 15: 20, 30: 25 },
    },
    color: '#e8894a',
  },
  minimax_h3: {
    id: 'minimax_h3',
    name: 'MiniMax-H3',
    short: 'H3',
    modes: ['t2v', 'i2v', 'transform'],
    durations: [5, 10, 15],
    resolutions: ['768p', '2k'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    maxRefImages: 9,
    maxRefVideos: 3,
    promptLimit: (mode) => (mode === 'transform' ? 20000 : 7000),
    pricing: {
      '768p': { 5: 4, 10: 6, 15: 8 },
      '2k': { 5: 6, 10: 8, 15: 10 },
    },
    color: '#7c9cff',
  },
}

/**
 * Mode names as shown for Seedance (its t2v sends reference images). Kept for compatibility: prefer
 * `modeLabel(mode, model)`, which is right for every model.
 */
export const MODE_LABEL: Record<Mode, string> = {
  t2v: 'Text → Video (+ảnh)',
  i2v: 'Ảnh → Video',
  transform: 'Khung đầu → cuối',
}

/**
 * Name of a mode for a model: "(+ảnh)" only where that model + mode really sends reference images (MiniMax-H3's
 * Text → Video sends none). Without a model (several models at once) the plain name.
 */
export function modeLabel(mode: Mode, model?: ModelId): string {
  const label = MODE_LABEL[mode] ?? String(mode)
  const sendsImages = !!model && usesRefs({ model, mode, duration: 0, resolution: '', ratio: '' })
  return sendsImages ? label : label.replace(/\s*\(\+ảnh\)$/, '')
}

export function costOf(s: VideoSettings): number {
  const spec = MODELS[s.model]
  return spec?.pricing[s.resolution]?.[s.duration] ?? 0
}

/** Clamp settings so they are valid for the chosen model. */
export function normalizeSettings(s: Partial<VideoSettings> & { model?: ModelId }): VideoSettings {
  const model: ModelId = s.model && MODELS[s.model] ? s.model : 'seedance_2_5'
  const spec = MODELS[model]
  const mode = s.mode && spec.modes.includes(s.mode) ? s.mode : spec.modes[0]
  const duration = s.duration && spec.durations.includes(s.duration) ? s.duration : spec.durations.includes(15) ? 15 : spec.durations[0]
  const resolution = s.resolution && spec.resolutions.includes(s.resolution) ? s.resolution : spec.resolutions[0]
  const ratio = s.ratio && spec.ratios.includes(s.ratio) ? s.ratio : '16:9'
  return { model, mode, duration, resolution, ratio }
}

export function settingsLabel(s: VideoSettings): string {
  return `${s.duration}s · ${s.resolution.toUpperCase()} · ${s.ratio}`
}

/** Whether this mode sends reference images. */
export function usesRefs(s: VideoSettings): boolean {
  return s.model === 'seedance_2_5' || s.mode === 'i2v'
}

/** Whether this mode accepts reference videos (@video_N). Same modes as reference images. */
export function usesVideoRefs(s: VideoSettings): boolean {
  return usesRefs(s)
}
