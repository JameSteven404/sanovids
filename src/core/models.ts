// The model catalogue: one route per ModelId (the id carries its service, core/services), its capabilities and price.
//
//   CATALOGUE            every route this build has code for (canvasapp's two + seedvis's three), pure data.
//   MODELS               the routes this build OFFERS and RUNS: canvasapp always, seedvis only once SEEDVIS_ENABLED
//                        (core/seedvisFlag, flipped in wave C). Typed over every ModelId so lookups type-check; a route
//                        that is not offered is missing at run time, which every reader already tolerates (it is a
//                        newer build's model: isModelId false, normalizeSettings → Seedance 2.5, migrate keeps a marker).
//   specOf / serviceOf / modelLabel / frameSlots / referencePrice   read the CATALOGUE (data only, never a decision).
//   isModelId / normalizeSettings / usesRefs / modeLabel / costOf / priceOf / settingsLabel / PICKER_ORDER   read
//                        MODELS: with the flag off they answer exactly as before seedvis existed.
import { SEEDVIS_PRICE_REFERENCE, type SeedvisPriceReference } from '../providers/seedvis/contract'
import { SEEDVIS_ENABLED } from './seedvisFlag'
import { SEEDVIS_ROUTE_TABLE, type SeedvisRouteSpec } from './seedvisRoutes'
import { CANVASAPP_MODEL_IDS, SEEDVIS_MODEL_IDS, SERVICES } from './services'
import type { CanvasappModelId, Mode, ModelId, Preset, SeedvisModelId, ServiceId, VideoSettings } from './types'

export { SEEDVIS_ENABLED }

export type ModelFamily = 'seedance' | 'minimax' | 'veo'

/** credits[resolution][duration] per video (canvasapp's table, 1 credit ≈ 1.000đ). */
export type PriceTable = Record<string, Record<number, number>>

/** Which frames ("Khung đầu" / "Khung cuối") a mode sends. */
export interface FrameSlots {
  readonly first: boolean
  readonly last: boolean
}

interface ModelSpecBase {
  id: ModelId
  service: ServiceId
  /** Family name ("Seedance 2.5"): also the file-name token {model}. Not unique across services: see modelLabel. */
  name: string
  short: string
  /** canvasapp `model_profile`, or seedvis `model` ('seedance_2.5' / 'seedance_2.0_fast' / 'Veo-3.1'). */
  remoteModel: string
  /** Picker grouping and dot colour. */
  family: ModelFamily
  modes: Mode[]
  /** Modes that send the scene's reference images (@image_N); see usesRefs for canvasapp's rule. */
  imageModes: Mode[]
  /** Frames a mode needs (absent = none); see frameSlots for canvasapp's rule. */
  frameModes: Partial<Record<Mode, FrameSlots>>
  /** Modes whose ratio comes from the frames, not from `ratio` (MiniMax-H3 "Khung đầu → cuối"). */
  ratioFromFrames?: Mode[]
  /** Mode names of this route (else MODE_LABEL). */
  modeLabels?: Partial<Record<Mode, string>>
  durations: number[]
  /** Duration of new settings / when the stored one is not offered. */
  defaultDuration: number
  resolutions: string[]
  /** How a resolution value is shown ('auto' → "Gốc"); absent = the value itself. */
  resolutionLabels?: Record<string, string>
  ratios: string[]
  /** Reference images sent at most, per model and never per mode (compile and the request read the same cap). */
  maxRefImages: number
  promptLimit: (mode: Mode) => number
  /** A discontinued route: hidden from pickers and blocked from running; its id is never deleted. */
  hidden?: true
  /** Compile notes + the picker's capability line. */
  notes?: { humanRefs?: true; undocumentedTokens?: true; firstImageStart?: true }
  color: string
}

export interface CanvasappModelSpec extends ModelSpecBase {
  id: CanvasappModelId
  service: 'canvasapp'
  /**
   * credits[resolution][duration] per video, 1 credit ≈ 1.000đ — the same table as canvasapp. The demo provider
   * charges it to the local demo wallet (useRuns.credits); on canvasapp it is the estimate of what the user's real
   * account will be billed. Display amounts with lib/credits formatCredits(n, kind), never as a bare number.
   */
  pricing: PriceTable
}

export interface SeedvisModelSpec extends ModelSpecBase {
  id: SeedvisModelId
  service: 'seedvis'
  /** seedvis states no price: an estimate from SEEDVIS_PRICE_REFERENCE (priceOf), "—" when not measured. */
  pricing: { kind: 'reference' }
}

export type ModelSpec = CanvasappModelSpec | SeedvisModelSpec

const BOTH_FRAMES: FrameSlots = Object.freeze({ first: true, last: true })
const NO_FRAMES: FrameSlots = Object.freeze({ first: false, last: false })

export const CANVASAPP_MODELS: Readonly<Record<CanvasappModelId, CanvasappModelSpec>> = {
  seedance_2_5: {
    id: 'seedance_2_5',
    service: 'canvasapp',
    name: 'Seedance 2.5',
    short: 'SD 2.5',
    remoteModel: 'seedance_2_5',
    family: 'seedance',
    modes: ['t2v'],
    imageModes: ['t2v'],
    frameModes: {},
    durations: [5, 10, 15, 30],
    defaultDuration: 15,
    resolutions: ['480p', '720p', '1080p'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    maxRefImages: 30,
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
    service: 'canvasapp',
    name: 'MiniMax-H3',
    short: 'H3',
    remoteModel: 'minimax_h3',
    family: 'minimax',
    modes: ['t2v', 'i2v', 'transform'],
    imageModes: ['i2v'],
    frameModes: { transform: BOTH_FRAMES },
    ratioFromFrames: ['transform'],
    durations: [5, 10, 15],
    defaultDuration: 15,
    resolutions: ['768p', '2k'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    maxRefImages: 9,
    promptLimit: (mode) => (mode === 'transform' ? 20000 : 7000),
    pricing: {
      '768p': { 5: 4, 10: 6, 15: 8 },
      '2k': { 5: 6, 10: 8, 15: 10 },
    },
    color: '#7c9cff',
  },
}

/** Family dot colours of the seedvis routes (Seedance shares canvasapp's; Veo: a mint of its own). */
const SEEDVIS_COLOR: Record<SeedvisRouteSpec['family'], string> = { seedance: '#e8894a', veo: '#a8f0d8' }

/** A seedvis route of the A0 table (core/seedvisRoutes) as a ModelSpec. */
function seedvisSpec(id: SeedvisModelId): SeedvisModelSpec {
  const r: SeedvisRouteSpec = SEEDVIS_ROUTE_TABLE[id]
  return {
    id,
    service: 'seedvis',
    name: r.name,
    short: r.short,
    remoteModel: r.remoteModel,
    family: r.family,
    modes: [...r.modes],
    imageModes: [...r.imageModes],
    frameModes: { ...r.frameModes },
    modeLabels: { ...r.modeLabels },
    durations: [...r.durations],
    defaultDuration: r.defaultDuration,
    resolutions: [...r.resolutions],
    resolutionLabels: { ...r.resolutionLabels } as Record<string, string>,
    ratios: [...r.ratios],
    maxRefImages: r.maxRefImages,
    promptLimit: () => r.promptLimit,
    pricing: { kind: 'reference' },
    notes: { ...r.notes },
    color: SEEDVIS_COLOR[r.family],
  }
}

export const SEEDVIS_MODELS: Readonly<Record<SeedvisModelId, SeedvisModelSpec>> = Object.fromEntries(
  SEEDVIS_MODEL_IDS.map((id) => [id, seedvisSpec(id)]),
) as Record<SeedvisModelId, SeedvisModelSpec>

/** Every route this build has code for, offered or not (see MODELS). */
export const CATALOGUE: Readonly<Record<ModelId, ModelSpec>> = { ...CANVASAPP_MODELS, ...SEEDVIS_MODELS }

/** Ids of the routes this build offers and runs, in catalogue order. */
const OFFERED_IDS: readonly ModelId[] = SEEDVIS_ENABLED ? [...CANVASAPP_MODEL_IDS, ...SEEDVIS_MODEL_IDS] : [...CANVASAPP_MODEL_IDS]

/**
 * The routes this build offers and runs (see the header): canvasapp's always, seedvis's once SEEDVIS_ENABLED. Keyed by
 * every ModelId for the type checker only — a route that is not offered is missing here at run time.
 */
export const MODELS: Record<ModelId, ModelSpec> = Object.fromEntries(OFFERED_IDS.map((id) => [id, CATALOGUE[id]])) as Record<ModelId, ModelSpec>

/** Order of the model pickers: per family, canvasapp's Seedance first; hidden routes left out. */
const PICKER_IDS: readonly ModelId[] = ['seedance_2_5', 'seedvis/seedance_2.5', 'seedvis/seedance_2.0_fast', 'seedvis/veo_3.1', 'minimax_h3']

/** The picker order of a build with (`seedvis`) or without the seedvis routes. Pure. */
export function pickerOrder(seedvis: boolean): ModelId[] {
  return PICKER_IDS.filter((id) => !CATALOGUE[id].hidden && (seedvis || CATALOGUE[id].service !== 'seedvis'))
}

/** The models the pickers offer, in order (seedvis only once SEEDVIS_ENABLED). */
export const PICKER_ORDER: readonly ModelId[] = Object.freeze(pickerOrder(SEEDVIS_ENABLED))

/**
 * Mode names as shown for Seedance (its t2v sends reference images). Kept for compatibility: prefer
 * `modeLabel(mode, model)`, which is right for every model.
 */
export const MODE_LABEL: Record<Mode, string> = {
  t2v: 'Text → Video (+ảnh)',
  i2v: 'Ảnh → Video',
  transform: 'Khung đầu → cuối',
  first: 'Khung đầu → Video',
}

/**
 * Name of a mode for a model: the route's own name when it has one (Veo 3.1), "(+ảnh)" only where that model + mode
 * really sends reference images (MiniMax-H3's Text → Video sends none). Without a model (several models at once) the
 * plain name.
 */
export function modeLabel(mode: Mode, model?: ModelId): string {
  const spec = model !== undefined && isModelId(model) ? MODELS[model] : undefined
  const label = spec?.modeLabels?.[mode] ?? MODE_LABEL[mode] ?? String(mode)
  const sendsImages = !!model && usesRefs({ model, mode })
  return sendsImages ? label : label.replace(/\s*\(\+ảnh\)$/, '')
}

/**
 * A model this build offers and runs: an own key of MODELS (never an inherited name such as "constructor" or
 * "toString", which a file of a newer build or from elsewhere may hold). Anything else — a seedvis route while
 * SEEDVIS_ENABLED is false included — is a newer build's model (see Scene.foreignModel).
 */
export function isModelId(v: unknown): v is ModelId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MODELS, v)
}

/** A route of the catalogue, offered or not (an own key of CATALOGUE). */
const isCatalogued = (v: unknown): v is ModelId => typeof v === 'string' && Object.prototype.hasOwnProperty.call(CATALOGUE, v)

/** The catalogue spec of `id`; an id this build has no route for falls back to Seedance 2.5 (canvasapp). Data only. */
export function specOf(id: string | null | undefined): ModelSpec {
  return isCatalogued(id) ? CATALOGUE[id] : CATALOGUE.seedance_2_5
}

/** Prefix of every seedvis route id, a newer build's included (design B: the id carries its service). */
const SEEDVIS_ID_PREFIX = 'seedvis/'

/**
 * The service of a model id: its route's; an id this build has no route for by its prefix — a newer build's
 * 'seedvis/…' route is seedvis's (its wallet and limits, never canvasapp's) — anything else canvasapp's. Unlike
 * specOf, whose fallback spec stays canvasapp's Seedance 2.5 for every unknown id.
 */
export function serviceOf(id: string | null | undefined): ServiceId {
  if (isCatalogued(id)) return CATALOGUE[id].service
  return typeof id === 'string' && id.startsWith(SEEDVIS_ID_PREFIX) ? 'seedvis' : 'canvasapp'
}

/**
 * The name of a model: "Seedance 2.5". `withService` adds the service where the family name alone is ambiguous —
 * "Seedance 2.5 · seedvis"; canvasapp's routes stay bare while canvasapp is the only service offered (SEEDVIS_ENABLED
 * false). An id this build has no route for is returned as it is (a newer build's model).
 */
export function modelLabel(id: string, opts: { withService?: boolean } = {}): string {
  if (!isCatalogued(id)) return id
  const spec = CATALOGUE[id]
  if (!opts.withService || (spec.service === 'canvasapp' && !SEEDVIS_ENABLED)) return spec.name
  return `${spec.name} · ${SERVICES[spec.service].label}`
}

/**
 * The frames `mode` sends on this route. canvasapp ties them to the mode whatever the model (0.6.0's rule: "Khung đầu →
 * cuối" needs both); seedvis per route (Veo "Khung đầu → Video": the first only).
 */
export function frameSlots(spec: ModelSpec, mode: Mode): FrameSlots {
  if (spec.service === 'canvasapp') return mode === 'transform' ? BOTH_FRAMES : NO_FRAMES
  return spec.frameModes[mode] ?? NO_FRAMES
}

/** Badge of a scene / preset on a model of a newer SanoVids build (Scene.foreignModel): "veo_3_1 · bản mới hơn". */
export const foreignModelBadge = (model: string): string => `${model} · bản mới hơn`
/** The model picker's stand-in entry for that model while it is selected: "veo_3_1 (bản mới hơn)". */
export const foreignModelOption = (model: string): string => `${model} (bản mới hơn)`

/** A price shown before running: `estimated` = from the seedvis reference table (shown "≈"). */
export interface Price {
  credits: number
  estimated: boolean
}

/** seedvis `upscale_video` of a resolution value (Veo: 'auto' → 'none', '1080p' → '1080p'); undefined = not sent. */
function upscaleOf(id: SeedvisModelId, resolution: string): 'none' | '1080p' | undefined {
  const map: Partial<Record<string, 'none' | '1080p'>> = SEEDVIS_ROUTE_TABLE[id].upscaleVideo
  return map[resolution]
}

/**
 * The reference price of a seedvis route (plan §7.9): the measured row of that model, upscale and duration; another
 * duration of the same model + upscale → linear between the nearest measured durations around it, or per second from
 * the nearest one on one side; nothing measured for that model + upscale → null ("—"). Always `estimated`.
 */
export function referencePrice(id: SeedvisModelId, duration: number, resolution: string, reference: SeedvisPriceReference = SEEDVIS_PRICE_REFERENCE): Price | null {
  if (!Number.isFinite(duration) || duration <= 0) return null
  const upscale = upscaleOf(id, resolution) ?? 'none'
  const rows = reference.rows
    .filter((r) => r.model === id && (r.upscale ?? 'none') === upscale && Number.isFinite(r.credits) && r.credits >= 0 && r.duration > 0)
    .sort((a, b) => a.duration - b.duration)
  if (!rows.length) return null
  const round = (n: number) => Math.round(n * 100) / 100
  const exact = rows.find((r) => r.duration === duration)
  if (exact) return { credits: exact.credits, estimated: true }
  const below = rows.filter((r) => r.duration < duration).at(-1)
  const above = rows.find((r) => r.duration > duration)
  if (below && above) {
    const t = (duration - below.duration) / (above.duration - below.duration)
    return { credits: round(below.credits + t * (above.credits - below.credits)), estimated: true }
  }
  const nearest = (below ?? above)!
  return { credits: round((nearest.credits / nearest.duration) * duration), estimated: true }
}

/**
 * The price of running these settings once: canvasapp's table (exact, `estimated` false); a seedvis route → its
 * reference price (≈); a model this build does not offer, a cell the table lacks, or a seedvis combination not measured
 * → null (show "—", never invent a number).
 */
export function priceOf(s: VideoSettings, reference: SeedvisPriceReference = SEEDVIS_PRICE_REFERENCE): Price | null {
  if (!isModelId(s.model)) return null
  const spec = MODELS[s.model]
  if (spec.service === 'seedvis') return referencePrice(spec.id, s.duration, s.resolution, reference)
  const credits = spec.pricing[s.resolution]?.[s.duration]
  return typeof credits === 'number' ? { credits, estimated: false } : null
}

/** Credits of one run as a number (0 when unknown). Compatibility layer: new displays use priceOf ("≈" / "—"). */
export function costOf(s: VideoSettings): number {
  return priceOf(s)?.credits ?? 0
}

/** Clamp settings so they are valid for the chosen model (a model this build does not offer becomes Seedance 2.5). */
export function normalizeSettings(s: Partial<VideoSettings> & { model?: ModelId }): VideoSettings {
  const model: ModelId = isModelId(s.model) ? s.model : 'seedance_2_5'
  const spec = MODELS[model]
  const mode = s.mode && spec.modes.includes(s.mode) ? s.mode : spec.modes[0]
  const duration = s.duration && spec.durations.includes(s.duration) ? s.duration : spec.defaultDuration
  const resolution = s.resolution && spec.resolutions.includes(s.resolution) ? s.resolution : spec.resolutions[0]
  const ratio = s.ratio && spec.ratios.includes(s.ratio) ? s.ratio : spec.ratios.includes('16:9') ? '16:9' : spec.ratios[0]
  return { model, mode, duration, resolution, ratio }
}

/**
 * "15s · 480P · 16:9" ("8s · Gốc · 9:16" where the route names its resolutions). Tolerates settings of another build
 * missing a field (a take of a newer build's route).
 */
export function settingsLabel(s: VideoSettings): string {
  const duration = typeof s?.duration === 'number' && Number.isFinite(s.duration) ? `${s.duration}s` : '?s'
  const named = isModelId(s?.model) ? MODELS[s.model].resolutionLabels?.[String(s.resolution)] : undefined
  return `${duration} · ${named ?? String(s?.resolution ?? '').toUpperCase()} · ${s?.ratio ?? ''}`
}

/**
 * Whether this mode sends reference images. canvasapp keeps 0.6.0's rule for every combination (Seedance 2.5 sends
 * them whatever the stored mode; i2v always does — a newer build's model too); a seedvis route in its imageModes only.
 */
export function usesRefs(s: Pick<VideoSettings, 'model' | 'mode'>): boolean {
  const spec = isModelId(s.model) ? MODELS[s.model] : undefined
  if (spec?.service === 'seedvis') return spec.imageModes.includes(s.mode)
  return s.model === 'seedance_2_5' || s.mode === 'i2v'
}

/** The video settings of a preset (without id / name). */
export function presetSettings(p: Preset): VideoSettings {
  return { model: p.model, mode: p.mode, duration: p.duration, resolution: p.resolution, ratio: p.ratio }
}

/** Same model, mode, duration, resolution and ratio. */
export function sameSettings(a: VideoSettings, b: VideoSettings): boolean {
  return a.model === b.model && a.mode === b.mode && a.duration === b.duration && a.resolution === b.resolution && a.ratio === b.ratio
}
