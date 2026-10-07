import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  CANVASAPP_MODEL_IDS, SEEDVIS_MODEL_IDS, SERVICES, SERVICE_OF_PROVIDER, isSimulatedProvider,
  type TakeProvider,
} from '../../../core/services'
import { SEEDVIS_ROUTE_TABLE, SEEDVIS_IMAGE_LIMITS, type SeedvisRouteSpec } from '../../../core/seedvisRoutes'
import { uuidFromKey } from '../../../lib/uuidKey'
import { uuidFromKey as canvasappUuidFromKey } from '../../canvasapp/mapping'
import {
  SEEDVIS_KEY_MEMORY_MS, SEEDVIS_SAME_KEY_MARGIN_MS, SEEDVIS_RESEND_SCHEDULE_MS,
  SEEDVIS_ANSWER_WAIT_MS, SEEDVIS_ECHO_AUTOCANCEL, SEEDVIS_PRICE_REFERENCE,
  SEEDVIS_IPC_ROUTES, SEEDVIS_RESPONSE_HEADERS, SEEDVIS_ACCOUNT_INFO_FIELDS, SEEDVIS_IPC_LIMITS,
  SEEDVIS_ROUTE_TABLE as contractRoutes,
  type SeedvisBridge, type SeedvisRequest, type SeedvisIpcRoute, type SeedvisResponse,
  type SeedvisAccountInfo, type SeedvisDownloadArgs, type SeedvisGenerationBody,
} from '../contract'

describe('seedvis A0 contract (plan v3.1, shipping in 0.6.0)', () => {
  it('pins the shipped ids and gives every seedvis id exactly one route', () => {
    expect(CANVASAPP_MODEL_IDS).toEqual(['seedance_2_5', 'minimax_h3'])
    expect(SEEDVIS_MODEL_IDS).toEqual(['seedvis/seedance_2.5', 'seedvis/seedance_2.0_fast', 'seedvis/veo_3.1'])
    const ids = [...CANVASAPP_MODEL_IDS, ...SEEDVIS_MODEL_IDS]
    expect(new Set(ids).size).toBe(5)
    expect(Object.keys(SEEDVIS_ROUTE_TABLE)).toEqual([...SEEDVIS_MODEL_IDS])
    expect(contractRoutes).toBe(SEEDVIS_ROUTE_TABLE)
    expect(new Set(Object.values(SEEDVIS_ROUTE_TABLE).map(r => r.remoteModel)).size).toBe(3)
    for (const id of SEEDVIS_MODEL_IDS) {
      const route: SeedvisRouteSpec = SEEDVIS_ROUTE_TABLE[id]
      expect(route.id).toBe(id)
      expect(route.service).toBe('seedvis')
      expect(id.length).toBeLessThanOrEqual(64)
      expect(route.durations).toContain(route.defaultDuration)
      expect(route.promptLimit).toBe(20_000)
      expect(route.count).toBe(1)
      expect(route.pricing).toEqual({ kind: 'reference' })
      expect(route.imageLimits).toBe(SEEDVIS_IMAGE_LIMITS)
      expect(new Set(route.requests.map(r => r.mode))).toEqual(new Set(route.modes))
      for (const mode of [...route.imageModes, ...Object.keys(route.frameModes), ...Object.keys(route.modeLabels)]) {
        expect(route.modes).toContain(mode)
      }
      for (const request of route.requests) {
        expect(request.minImages).toBeLessThanOrEqual(request.maxImages)
        expect(request.maxImages).toBeLessThanOrEqual(SEEDVIS_IMAGE_LIMITS.maxImages)
        if (route.imageModes.includes(request.mode) && request.maxImages > 0) {
          expect(request.maxImages).toBe(route.maxRefImages)
        }
      }
    }
  })

  it.each([
    ['seedvis/seedance_2.5', 'seedance_2.5', [5, 10, 15, 20, 25, 30]],
    ['seedvis/seedance_2.0_fast', 'seedance_2.0_fast', [5, 10, 15]],
  ] as const)('pins the Seedance catalogue and both request variants: %s', (id, remoteModel, durations) => {
    const route = SEEDVIS_ROUTE_TABLE[id]
    expect(route.remoteModel).toBe(remoteModel)
    expect(route.modes).toEqual(['t2v'])
    expect(route.imageModes).toEqual(['t2v'])
    expect(route.frameModes).toEqual({})
    expect(route.durations).toEqual(durations)
    expect(route.defaultDuration).toBe(5)
    expect(route.ratios).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
    expect(route.resolutions).toEqual(['auto'])
    expect(route.resolutionLabels).toEqual({ auto: 'Gốc' })
    expect(route.durationEncoding).toBe('integer')
    expect(route.upscaleVideo).toEqual({})
    expect(route.maxRefImages).toBe(10)
    expect(route.notes).toEqual({ humanRefs: true, undocumentedTokens: true, firstImageStart: true })
    expect(route.requests).toEqual([
      { mode: 't2v', remoteMode: 'text-to-video', minImages: 0, maxImages: 0, imageFields: [] },
      { mode: 't2v', remoteMode: 'image-to-video', minImages: 1, maxImages: 10, imageFields: ['reference_images'] },
    ])
  })

  it('pins Veo constraints and all four image-field mappings', () => {
    const route = SEEDVIS_ROUTE_TABLE['seedvis/veo_3.1']
    expect(route.remoteModel).toBe('Veo-3.1')
    expect(route.modes).toEqual(['t2v', 'first', 'i2v', 'transform'])
    expect(route.imageModes).toEqual(['i2v'])
    expect(route.frameModes).toEqual({ first: { first: true, last: false }, transform: { first: true, last: true } })
    expect(route.modeLabels).toEqual({
      t2v: 'Text → Video', first: 'Khung đầu → Video',
      i2v: 'Ảnh tham chiếu → Video (1–3 ảnh)', transform: 'Khung đầu → cuối',
    })
    expect(route.durations).toEqual([4, 6, 8])
    expect(route.defaultDuration).toBe(8)
    expect(route.ratios).toEqual(['16:9', '9:16'])
    expect(route.resolutions).toEqual(['auto', '1080p'])
    expect(route.resolutionLabels).toEqual({ auto: 'Gốc', '1080p': '1080p (phóng to)' })
    expect(route.durationEncoding).toBe('seconds-suffix')
    expect(route.upscaleVideo).toEqual({ auto: 'none', '1080p': '1080p' })
    expect(route.maxRefImages).toBe(3)
    expect(route.requests).toEqual([
      { mode: 't2v', remoteMode: 'text-to-video', minImages: 0, maxImages: 0, imageFields: [] },
      { mode: 'first', remoteMode: 'image-to-video', minImages: 1, maxImages: 1, imageFields: ['image'] },
      { mode: 'i2v', remoteMode: 'multi-image-to-video', minImages: 1, maxImages: 3, imageFields: ['referenceImages'] },
      { mode: 'transform', remoteMode: 'batch-frame', minImages: 2, maxImages: 2, imageFields: ['image', 'lastFrame'] },
    ])
  })

  it('counts image limits in decoded bytes and base64 limits in encoded bytes', () => {
    expect(SEEDVIS_IMAGE_LIMITS).toEqual({
      maxImages: 10, maxImageBytes: 20 * 1024 ** 2, maxBase64Bytes: 40 * 1024 ** 2,
      preparedBase64Bytes: 39 * 1024 ** 2, formats: ['image/png', 'image/jpeg', 'image/webp'],
    })
    expect(SEEDVIS_IPC_LIMITS).toEqual({
      bodyBytes: 256 * 1024, jsonBytes: 2 * 1024 ** 2, videoBytes: 1024 ** 3,
      imageBytes: 50 * 1024 ** 2, chunkBytes: 4 * 1024 ** 2, inFlightBytes: 64 * 1024 ** 2,
      promptChars: 20_000, idChars: 100, pathChars: 300,
    })
  })

  it('keeps same-key retries disabled, echoes warn-only and reference prices unmeasured', () => {
    expect(SEEDVIS_KEY_MEMORY_MS).toBeNull()
    expect(SEEDVIS_SAME_KEY_MARGIN_MS).toBe(20_000)
    expect(SEEDVIS_RESEND_SCHEDULE_MS).toEqual([15_000, 45_000, 90_000])
    expect(SEEDVIS_ANSWER_WAIT_MS).toBe(45_000)
    expect(SEEDVIS_ECHO_AUTOCANCEL).toBe(false)
    expect(SEEDVIS_PRICE_REFERENCE).toEqual({ measuredAt: null, source: null, rows: [] })
  })

  it('names the provider tokens/icons and distinguishes every executor', () => {
    expect(SERVICES.canvasapp).toEqual({
      label: 'canvasapp', short: 'CA', site: 'canvasapp.io.vn', token: '--provider-canvasapp',
      softToken: '--provider-canvasapp-soft', icon: 'Cloud', executors: ['dev', 'canvasapp'], hasTopUp: true,
    })
    expect(SERVICES.seedvis).toEqual({
      label: 'seedvis', short: 'SV', site: 'seedvis.com', token: '--provider-seedvis',
      softToken: '--provider-seedvis-soft', icon: 'Sprout', executors: ['seedvis-dev', 'seedvis'], hasTopUp: false,
    })
    expect(SERVICE_OF_PROVIDER).toEqual({
      mock: 'canvasapp', dev: 'canvasapp', canvasapp: 'canvasapp', 'seedvis-dev': 'seedvis', seedvis: 'seedvis',
    })
    for (const provider of Object.keys(SERVICE_OF_PROVIDER) as TakeProvider[]) {
      expect(isSimulatedProvider(provider)).toBe(['mock', 'dev', 'seedvis-dev'].includes(provider))
      expect(SERVICES[SERVICE_OF_PROVIDER[provider]]).toBeDefined()
    }
  })

  it('allows only the six video/account routes and the documented response/account fields', () => {
    expect(SEEDVIS_IPC_ROUTES).toEqual({
      models: { method: 'GET', path: '/models' },
      'account.info': { method: 'GET', path: '/account/info' },
      'account.usage': { method: 'GET', path: '/account/usage' },
      'generations.create': { method: 'POST', path: '/developer/generations' },
      'generations.get': { method: 'GET', path: '/developer/generations/{id}?wait=0' },
      'generations.cancel': { method: 'POST', path: '/developer/generations/{id}/cancel' },
    })
    expect(SEEDVIS_RESPONSE_HEADERS).toEqual(['Retry-After', 'Idempotency-Replayed', 'X-Request-Id'])
    expect(SEEDVIS_ACCOUNT_INFO_FIELDS).toEqual([
      'plan', 'api_enabled', 'credit_balance', 'concurrency_limit', 'queue_limit',
      'rate_limit_per_minute', 'poll_rate_limit_per_minute', 'poll_rate_limit_per_job_per_minute',
    ])
    expectTypeOf<SeedvisRequest['route']>().toEqualTypeOf<SeedvisIpcRoute>()
    expectTypeOf<keyof SeedvisAccountInfo>().toEqualTypeOf<typeof SEEDVIS_ACCOUNT_INFO_FIELDS[number]>()
    expectTypeOf<SeedvisDownloadArgs>().toEqualTypeOf<{ generationId: string; index: number }>()
    expectTypeOf<Extract<SeedvisResponse, { ok: true }>['json']>().toBeUnknown()
    expectTypeOf<Extract<SeedvisGenerationBody, { model: 'Veo-3.1' }>['duration']>().toEqualTypeOf<'4s' | '6s' | '8s'>()
    expectTypeOf<Parameters<SeedvisBridge['request']>[0]>().toEqualTypeOf<SeedvisRequest>()
    expectTypeOf<Awaited<ReturnType<SeedvisBridge['keyStatus']>>>().not.toHaveProperty('key')
  })

  it('copies the existing UUID algorithm without changing persisted identities', () => {
    expect(uuidFromKey('')).toBe('027ae52e-cfc7-4621-9593-990d4b41437c')
    expect(uuidFromKey('sanovids')).toBe('407822d1-ff74-44a5-b939-9e563102e770')
    expect(uuidFromKey('Tiếng Việt 🎬')).toBe('3f98c97f-5460-4a69-8cd8-a53160121e88')
    const inputs = ['', 'Tiếng Việt 🎬', ...Array.from({ length: 2000 }, (_, i) => `sanovids:seedvis:take-${i}`)]
    const ids = inputs.map(uuidFromKey)
    expect(new Set(ids).size).toBe(inputs.length)
    inputs.forEach((input, i) => {
      expect(ids[i]).toBe(canvasappUuidFromKey(input))
      expect(ids[i]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })
  })
})
