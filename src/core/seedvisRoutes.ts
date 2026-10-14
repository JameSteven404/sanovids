import type { Mode, SeedvisModelId } from './services'

export type SeedvisRemoteModel = 'seedance_2.5' | 'seedance_2.0_fast' | 'Veo-3.1'
export type SeedvisRemoteMode = 'text-to-video' | 'image-to-video' | 'multi-image-to-video' | 'batch-frame'
export type SeedvisImageField = 'reference_images' | 'referenceImages' | 'image' | 'lastFrame'
export type SeedvisImageMime = 'image/png' | 'image/jpeg' | 'image/webp'
export type SeedvisRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9'
export type SeedvisResolution = 'auto' | '1080p'

// Plan §9: decoded bytes per image, base64 text per request (not decoded bytes).
export const SEEDVIS_IMAGE_LIMITS = {
  maxImages: 10,
  maxImageBytes: 20 * 1024 * 1024,
  maxBase64Bytes: 40 * 1024 * 1024,
  preparedBase64Bytes: 39 * 1024 * 1024,
  formats: ['image/png', 'image/jpeg', 'image/webp'],
} as const

export interface SeedvisModeRoute {
  mode: Mode
  remoteMode: SeedvisRemoteMode
  minImages: number
  maxImages: number
  imageFields: readonly SeedvisImageField[]
}

export interface SeedvisRouteSpec {
  id: SeedvisModelId
  service: 'seedvis'
  name: string
  short: string
  remoteModel: SeedvisRemoteModel
  family: 'seedance' | 'veo'
  modes: readonly Mode[]
  imageModes: readonly Mode[]
  frameModes: Readonly<Partial<Record<Mode, { readonly first: boolean; readonly last: boolean }>>>
  modeLabels: Readonly<Partial<Record<Mode, string>>>
  durations: readonly number[]
  defaultDuration: number
  ratios: readonly SeedvisRatio[]
  resolutions: readonly SeedvisResolution[]
  resolutionLabels: Readonly<Partial<Record<SeedvisResolution, string>>>
  maxRefImages: number
  promptLimit: number
  pricing: { readonly kind: 'reference' }
  notes: { readonly humanRefs?: true; readonly undocumentedTokens?: true; readonly firstImageStart?: true }
  imageLimits: typeof SEEDVIS_IMAGE_LIMITS
  count: 1
  durationEncoding: 'integer' | 'seconds-suffix'
  upscaleVideo: Readonly<Partial<Record<SeedvisResolution, 'none' | '1080p'>>>
  requests: readonly SeedvisModeRoute[]
}

// Plan §2.3 and §8. Seedance's one local mode selects a remote mode by image count.
const SEEDANCE = {
  service: 'seedvis', family: 'seedance', modes: ['t2v'], imageModes: ['t2v'], frameModes: {},
  modeLabels: { t2v: 'Text → Video (+ảnh)' }, defaultDuration: 5,
  ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  resolutions: ['auto'], resolutionLabels: { auto: 'Gốc' }, maxRefImages: 10,
  promptLimit: 20_000, pricing: { kind: 'reference' },
  notes: { humanRefs: true, undocumentedTokens: true, firstImageStart: true },
  imageLimits: SEEDVIS_IMAGE_LIMITS, count: 1, durationEncoding: 'integer', upscaleVideo: {},
  requests: [
    { mode: 't2v', remoteMode: 'text-to-video', minImages: 0, maxImages: 0, imageFields: [] },
    { mode: 't2v', remoteMode: 'image-to-video', minImages: 1, maxImages: 10, imageFields: ['reference_images'] },
  ],
} as const

export const SEEDVIS_ROUTE_TABLE = {
  'seedvis/seedance_2.5': {
    ...SEEDANCE, id: 'seedvis/seedance_2.5', name: 'Seedance 2.5', short: 'SD 2.5',
    remoteModel: 'seedance_2.5', durations: [5, 10, 15, 20, 25, 30],
  },
  'seedvis/seedance_2.0_fast': {
    ...SEEDANCE, id: 'seedvis/seedance_2.0_fast', name: 'Seedance 2.0 Fast', short: 'SD 2.0F',
    remoteModel: 'seedance_2.0_fast', durations: [5, 10, 15],
  },
  'seedvis/veo_3.1': {
    id: 'seedvis/veo_3.1', service: 'seedvis', name: 'Veo 3.1', short: 'Veo 3.1',
    remoteModel: 'Veo-3.1', family: 'veo', modes: ['t2v', 'first', 'i2v', 'transform'], imageModes: ['i2v'],
    frameModes: { first: { first: true, last: false }, transform: { first: true, last: true } },
    modeLabels: {
      t2v: 'Text → Video', first: 'Khung đầu → Video',
      i2v: 'Ảnh tham chiếu → Video (1–3 ảnh)', transform: 'Khung đầu → cuối',
    },
    durations: [4, 6, 8], defaultDuration: 8, ratios: ['16:9', '9:16'],
    resolutions: ['auto', '1080p'], resolutionLabels: { auto: 'Gốc', '1080p': '1080p (phóng to)' },
    maxRefImages: 3, promptLimit: 20_000, pricing: { kind: 'reference' }, notes: { undocumentedTokens: true },
    imageLimits: SEEDVIS_IMAGE_LIMITS, count: 1, durationEncoding: 'seconds-suffix',
    upscaleVideo: { auto: 'none', '1080p': '1080p' },
    requests: [
      { mode: 't2v', remoteMode: 'text-to-video', minImages: 0, maxImages: 0, imageFields: [] },
      { mode: 'first', remoteMode: 'image-to-video', minImages: 1, maxImages: 1, imageFields: ['image'] },
      { mode: 'i2v', remoteMode: 'multi-image-to-video', minImages: 1, maxImages: 3, imageFields: ['referenceImages'] },
      { mode: 'transform', remoteMode: 'batch-frame', minImages: 2, maxImages: 2, imageFields: ['image', 'lastFrame'] },
    ],
  },
} as const satisfies Record<SeedvisModelId, SeedvisRouteSpec>
