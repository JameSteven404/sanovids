import { describe, expect, it } from 'vitest'
import { SEEDVIS_ROUTE_TABLE } from '../../../core/seedvisRoutes'
import { useProject } from '../../../store/project'
import type { Project, Scene } from '../../../core/types'
import type { Mode, SeedvisModelId } from '../../../core/services'
import {
  echoCheck, errorOf, fieldToSlot, imageFileName, isJobNotFound, limitsFromModels,
  routeOf, seedvisIdempotencyKey, statusOf, toGenerationBody, toRequestImages, validateRequest,
  type GenerationInput,
} from '../mapping'
import {
  SEEDVIS_SUBMIT_TEXT, SEEDVIS_TEXT, seedvisDevWording, seedvisDeletePaidText,
  seedvisDownloadFailedText, seedvisExpiredLinkText, seedvisPaidText, seedvisSafeRetryText,
} from '../wording'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
function request(model: SeedvisModelId = 'seedvis/seedance_2.5', mode: Mode = 't2v', count = 0): GenerationInput {
  return {
    model, mode, duration: model === 'seedvis/veo_3.1' ? 8 : 5, resolution: 'auto', ratio: '16:9',
    prompt: '  Cảnh phim\n ánh sáng tự nhiên  ',
    images: Array.from({ length: count }, () => ({ mime: 'image/png', bytes: png.slice() })),
  }
}

describe('seedvis request mapping (§8, M1/M2)', () => {
  it.each([
    ['seedvis/seedance_2.5', 't2v', 0, 'seedance_2.5', 'text-to-video', []],
    ['seedvis/seedance_2.5', 't2v', 10, 'seedance_2.5', 'image-to-video', ['reference_images']],
    ['seedvis/seedance_2.0_fast', 't2v', 0, 'seedance_2.0_fast', 'text-to-video', []],
    ['seedvis/seedance_2.0_fast', 't2v', 10, 'seedance_2.0_fast', 'image-to-video', ['reference_images']],
    ['seedvis/veo_3.1', 't2v', 0, 'Veo-3.1', 'text-to-video', []],
    ['seedvis/veo_3.1', 'first', 1, 'Veo-3.1', 'image-to-video', ['image']],
    ['seedvis/veo_3.1', 'i2v', 3, 'Veo-3.1', 'multi-image-to-video', ['referenceImages']],
    ['seedvis/veo_3.1', 'transform', 2, 'Veo-3.1', 'batch-frame', ['image', 'lastFrame']],
  ] as const)('%s / %s / %i images', (model, mode, count, remoteModel, remoteMode, fields) => {
    const req = request(model, mode, count)
    const body = toGenerationBody(req)
    expect(body).toEqual({
      model: remoteModel, mode: remoteMode, prompt: 'Cảnh phim\n ánh sáng tự nhiên',
      aspect_ratio: '16:9', duration: model === 'seedvis/veo_3.1' ? '8s' : 5,
      ...(model === 'seedvis/veo_3.1' ? { upscale_video: 'none' } : {}), count: 1,
    })
    const images = toRequestImages(req)
    expect([...new Set(images.map(i => i.field))]).toEqual(fields)
    images.forEach((image, i) => {
      expect(image.bytes).toBe(req.images[i].bytes)
      expect(image.index).toBe(image.field === 'image' || image.field === 'lastFrame' ? 0 : i)
    })
    expect(Object.keys(body)).toEqual(['model', 'mode', 'prompt', 'aspect_ratio', 'duration', ...(model === 'seedvis/veo_3.1' ? ['upscale_video'] : []), 'count'])
  })

  it('covers every catalogued duration, ratio and upscale without aliases or hidden defaults', () => {
    for (const spec of Object.values(SEEDVIS_ROUTE_TABLE)) {
      for (const duration of spec.durations) for (const ratio of spec.ratios) for (const resolution of spec.resolutions) {
        const req = { ...request(spec.id), duration, ratio, resolution }
        const body = toGenerationBody(req)
        expect(body.duration).toBe(spec.family === 'veo' ? `${duration}s` : duration)
        expect(body.aspect_ratio).toBe(ratio)
        if (body.model === 'Veo-3.1') expect(body.upscale_video).toBe(resolution === 'auto' ? 'none' : '1080p')
      }
    }
  })

  it('sends every ordered image even if the prompt mentions them out of order or not at all', () => {
    const req = { ...request('seedvis/seedance_2.5', 't2v', 3), prompt: ' @image_3 đi tới @Image 1. ' }
    expect(toGenerationBody(req).prompt).toBe('@image_3 đi tới @Image 1.')
    expect(toRequestImages(req).map(i => i.bytes)).toEqual(req.images.map(i => i.bytes))
    expect(toRequestImages(req).map(imageFileName)).toEqual(['image_1.png', 'image_2.png', 'image_3.png'])
    expect(toRequestImages(request('seedvis/veo_3.1', 'transform', 2)).map(imageFileName)).toEqual(['frame_first.png', 'frame_last.png'])
    expect(imageFileName({ field: 'referenceImages', index: 1, mime: 'image/jpeg' })).toBe('image_2.jpg')
    expect(imageFileName({ field: 'lastFrame', index: 0, mime: 'image/webp' })).toBe('frame_last.webp')
  })

  it('keeps the actual snapshot body byte-identical after moveScene and a title/prompt edit', () => {
    const store = useProject.getState(), previous = store.project
    const scene = (id: string, order: number): Scene => ({
      id, order, title: id, prompt: 'live prompt', refs: [], videoRefs: [], presetId: null,
      settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, ratio: '16:9', resolution: '1080p' },
      firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: 0 }, note: '',
    })
    const project: Project = {
      id: 'map-test', schemaVersion: 2, name: 'test', createdAt: 0, updatedAt: 0,
      presets: [], assets: [], scenes: [scene('s1', 1), scene('s2', 2)], settings: { autoRenumber: true },
    }
    const req = { ...request('seedvis/seedance_2.5', 't2v', 2), takeId: 'take-1', sceneCode: 'S01', title: 'old' }
    const serialized = () => JSON.stringify({ key: seedvisIdempotencyKey(req.takeId), body: toGenerationBody(req), images: toRequestImages(req).map(i => ({ ...i, file_name: imageFileName(i) })) })
    try {
      store.loadProject(project)
      const before = serialized()
      store.moveScene('s1', 2)
      expect(useProject.getState().project.scenes.find(s => s.id === 's1')!.order).toBe(2)
      store.setScenePrompt('s1', 'changed live prompt')
      req.sceneCode = 'S02'; req.title = 'new title'
      expect(serialized()).toBe(before)
      expect(seedvisIdempotencyKey('take-1')).not.toBe(seedvisIdempotencyKey('take-2'))
      expect(seedvisIdempotencyKey('take-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    } finally { store.loadProject(previous); useProject.temporal.getState().clear() }
  })

  it.each([
    ['seedvis/seedance_2.5', 't2v', 11], ['seedvis/seedance_2.5', 'i2v', 1],
    ['seedvis/veo_3.1', 'i2v', 0], ['seedvis/veo_3.1', 'i2v', 4],
    ['seedvis/veo_3.1', 'first', 0], ['seedvis/veo_3.1', 'first', 2],
    ['seedvis/veo_3.1', 'transform', 1], ['seedvis/veo_3.1', 'transform', 3],
    ['seedvis/veo_3.1', 't2v', 1],
  ] as const)('refuses invalid image mode/count %s %s %i', (model, mode, count) => {
    expect(() => toGenerationBody(request(model, mode, count))).toThrow('Chưa gửi gì, không bị trừ credit.')
  })

  it.each([
    { model: 'minimax_h3' }, { model: 'toString' }, { duration: 7 }, { duration: NaN },
    { ratio: 'auto' }, { resolution: '1080p' }, { prompt: '   ' }, { prompt: 'a'.repeat(20_001) },
    { prompt: '@image_1' }, { prompt: '@image_0' }, { prompt: '@image_?1(Lumi)' },
    { prompt: '@video_1' }, { prompt: '@Video 2' }, { prompt: '@video_?1' },
  ])('refuses invalid settings/tokens %j', patch => {
    expect(validateRequest({ ...request(), ...patch } as GenerationInput)).not.toBeNull()
  })

  it('does not let a foreign spec bypass validation or accept fake image MIME', () => {
    expect(() => toGenerationBody(request(), SEEDVIS_ROUTE_TABLE['seedvis/veo_3.1'])).toThrow()
    expect(validateRequest({ ...request('seedvis/seedance_2.5', 't2v', 1), images: [{ mime: 'image/png', bytes: new Uint8Array([1]) }] })).toContain('Ảnh @image_1')
    expect(routeOf('__proto__')).toBeNull()
  })
})

describe('seedvis errors, statuses and money words (§7.7 / §12.6)', () => {
  it.each([
    [400, 'invalid_value', 'không nhận tham số', 'error', 'none'],
    [422, 'validation_error', 'không nhận tham số', 'error', 'none'],
    [400, 'invalid_image', 'Ảnh @image_2', 'error', 'none'],
    [422, 'image_rule', 'Số ảnh không hợp', 'error', 'none'],
    [400, 'content_policy', 'từ chối nội dung', 'error', 'none'],
    [400, 'reference_image_missing', 'từ chối nội dung', 'error', 'none'],
    [400, 'invalid_request', 'từ chối nội dung', 'error', 'none'],
    [401, '', 'Khoá API', 'error', 'none'], [402, 'insufficient_credits', 'không đủ credit', 'error', 'none'],
    [403, '', 'không có quyền', 'error', 'none'],
    [404, 'model_not_found', 'bảo trì hoặc gói chưa mở', 'error', 'none'],
    [503, 'model_maintenance', 'bảo trì hoặc gói chưa mở', 'error', 'none'],
    [409, 'idempotency_conflict', 'Không rõ yêu cầu', 'uncertain', 'none'],
    [429, '', 'đang đầy luồng', 'deferred', 'same-key-gated'],
    [503, 'server_busy', 'đang đầy luồng', 'deferred', 'same-key-gated'],
    [500, 'server_error', 'Không rõ yêu cầu', 'uncertain', 'same-key-gated'],
    [502, '', 'Không rõ yêu cầu', 'uncertain', 'same-key-gated'],
    [0, '', 'Không rõ yêu cầu', 'uncertain', 'none'],
  ])('submit %i %s', (http, code, text, cls, retry) => {
    const result = errorOf(http, { error: { code, message: 'Chi tiết', param: 'reference_images[1]' } })
    expect(result).toMatchObject({ class: cls, retry, detail: 'Chi tiết', code: code || `http_${http}` })
    expect(result.text).toContain(text)
  })

  it.each(['reference_images[1]', 'referenceImages[1]', 'image', 'lastFrame', 'unknown.key'])('parses field-keyed errors: %s', field => {
    const text = errorOf(400, { code: 'invalid_image', errors: { [field]: ['Sai ảnh'] } })
    expect(text.text).toContain(fieldToSlot(field))
    expect(text.detail).toBe('Sai ảnh')
  })
  it('maps the documented field positions, including unknown keys', () => {
    expect(['reference_images[0]', 'referenceImages[2]', 'image', 'lastFrame', 'x'].map(fieldToSlot))
      .toEqual(['@image_1', '@image_3', 'khung đầu', 'khung cuối', 'tham chiếu (x)'])
    expect(errorOf(400, { error: { message: 'Thông báo Google', code: 'invalid_value' } }).detail).toBe('Thông báo Google')
  })

  it('distinguishes full queues from schema validation 422', () => {
    expect(errorOf(422, { message: 'All slots are full and queue is full' }).class).toBe('deferred')
    expect(errorOf(422, { code: 'validation_error', message: 'Concurrency limit and queue limit reached' }).class).toBe('deferred')
    expect(errorOf(422, { code: 'validation_error', message: 'image queue metadata is invalid' }).class).toBe('error')
  })

  it('never auto-retries a moderation refusal even with a retryable HTTP status', () => {
    expect(errorOf(429, { code: 'content_policy' })).toMatchObject({ class: 'error', retry: 'none' })
    expect(errorOf(500, { code: 'content_policy' }, { priorSent: true })).toMatchObject({ class: 'uncertain', retry: 'none' })
  })

  it.each([400, 401, 402, 403, 404, 409, 422, 429, 500, 503])('keeps a prior uncertain POST uncertain after HTTP %i (M6)', status => {
    for (const code of ['content_policy', 'insufficient_credits', 'cancelled', 'model_maintenance', 'server_busy']) {
      const result = errorOf(status, { error: { code, message: 'detail' } }, { priorSent: true })
      expect(result.class).toBe('uncertain')
      expect(result.text).toBe(SEEDVIS_SUBMIT_TEXT.seedvis.unknown)
      expect(errorOf(status, {}, { priorSent: true, gateClosed: true }).text).toBe(SEEDVIS_SUBMIT_TEXT.seedvis.unverifiable)
    }
  })

  it.each([
    ['not_started', 'không bị trừ credit', 'error', 'new-take'],
    ['cancelled', 'đã hoàn credit', 'cancelled', 'none'],
    ['insufficient_credits', 'không đủ credit', 'error', 'none'],
    ['content_policy', 'seedvis: lỗi', 'error', 'none'],
    ['generation_failed', 'tạo video thất bại', 'error', 'none'],
    ['timeout', 'tạo video thất bại', 'error', 'none'],
    ['new_remote_code', 'seedvis: lỗi', 'error', 'none'],
  ])('poll failure %s does not invent a refund', (code, text, cls, retry) => {
    const result = errorOf(200, { data: { status: 'failed', error: { code, message: 'lỗi' } } }, { phase: 'poll' })
    expect(result).toMatchObject({ code, class: cls, retry })
    expect(result.text).toContain(text)
  })

  it('holds unauthorised polls and keeps transient 404/5xx jobs processing', () => {
    for (const http of [401, 403]) expect(errorOf(http, {}, { phase: 'poll' }).class).toBe('held')
    for (const http of [404, 429, 500, 503]) expect(errorOf(http, '<html>maintenance</html>', { phase: 'poll' })).toMatchObject({ class: 'processing', retry: 'poll' })
    expect(errorOf(409, { error: { code: 'not_cancellable' } }, { phase: 'cancel' }).text).toBe(SEEDVIS_TEXT.cancelRunning)
    expect(errorOf(503, { error: { code: 'cancel_unavailable' } }, { phase: 'cancel' }).text).toBe(SEEDVIS_TEXT.cancelUnknown)
  })

  it('keeps 202 jobs and maps failed + cancelled; malformed data never becomes success', () => {
    for (const state of ['queued', 'processing', 'completed', 'failed']) expect(statusOf({ status: 202, data: { status: state } })).toBe(state)
    expect(statusOf({ data: { status: 'failed', error: { code: 'cancelled' } } })).toBe('cancelled')
    for (const invalid of [null, [], 'completed', {}, { status: 'new_status' }, { status: 202 }]) expect(statusOf(invalid)).toBeNull()
  })

  it('does not assume a not-found code before support confirms it', () => {
    const body = { data: { error: { code: 'generation_not_found' } } }
    expect(isJobNotFound(404, body)).toBe(false)
    expect(isJobNotFound(404, body, 'generation_not_found')).toBe(true)
    for (const invalid of ['<html>generation_not_found</html>', null, {}, { code: 'model_not_found' }]) expect(isJobNotFound(404, invalid, 'generation_not_found')).toBe(false)
    expect(isJobNotFound(200, body, 'generation_not_found')).toBe(false)
    expect(isJobNotFound(404, { code: 'model_not_found' }, 'model_not_found')).toBe(false)
  })

  it('keeps fixed uncertain texts and preserves the existing unverifiable prefix (B2 wires recognition)', () => {
    for (const provider of ['seedvis', 'seedvis-dev'] as const) {
      expect(SEEDVIS_SUBMIT_TEXT[provider].unknown).toMatch(/^Không rõ yêu cầu đã tới seedvis/)
      expect(SEEDVIS_SUBMIT_TEXT[provider].unverifiable).toMatch(/^Không kiểm tra được lần gửi trước/)
      expect(errorOf(409, { message: 'case-specific' }, { provider })).toMatchObject({ text: SEEDVIS_SUBMIT_TEXT[provider].unknown, detail: 'case-specific' })
      expect(errorOf(409, {}, { provider, gateClosed: true }).retry).toBe('none')
    }
    for (const text of [...Object.values(SEEDVIS_TEXT), ...Object.values(SEEDVIS_SUBMIT_TEXT.seedvis)]) {
      const simulated = seedvisDevWording(text)
      expect(seedvisDevWording(simulated)).toBe(simulated)
      expect(simulated).not.toContain('seedvis.com')
      expect(simulated).not.toMatch(/credit(?! dev)/)
    }
    expect(SEEDVIS_SUBMIT_TEXT.seedvis.unknown).toBe('Không rõ yêu cầu đã tới seedvis chưa (có thể đã bị trừ credit).')
  })

  it('pins all money/status rows and retry/download warnings', () => {
    expect([seedvisPaidText(120), SEEDVIS_TEXT.noCharge, SEEDVIS_TEXT.refunded, SEEDVIS_TEXT.unknownCost, SEEDVIS_TEXT.uncertainCost, SEEDVIS_TEXT.fetchableCost]).toEqual([
      'đã trả ≈ 120 credit seedvis', 'không bị trừ', 'đã hoàn', 'không rõ — xem số dư seedvis', 'có thể đã bị trừ', 'đã trả — chưa tải về (Tải lại video)',
    ])
    expect(SEEDVIS_TEXT.cancelTitle).toBe('Huỷ trên seedvis — chỉ hoàn credit nếu job còn xếp hàng (hiếm); nếu đã bắt đầu tạo thì vẫn bị trừ và video vẫn được tải')
    expect(seedvisDownloadFailedText('mất mạng')).toContain('Đừng bấm Chạy lại: sẽ trừ credit lần nữa.')
    expect(seedvisDownloadFailedText('mất mạng', 7)).toContain('(gói của bạn: 7 ngày)')
    expect(seedvisExpiredLinkText()).toContain('(theo gói)')
    expect(seedvisExpiredLinkText(7)).toContain('(gói giữ 7 ngày)')
    expect(seedvisDeletePaidText('Take này')).toContain('chạy lại cảnh sẽ trừ credit lần nữa.')
    expect(seedvisSafeRetryText(61_999)).toBe('Gửi lại an toàn trong 1:01')
    expect(seedvisSafeRetryText(-1)).toBe('Gửi lại an toàn trong 0:00')
  })
})

describe('seedvis echo and model parsing', () => {
  it('matches field/index pairs regardless of role/source and only warns on missing/extra/duplicate echoes', () => {
    const sent = toRequestImages(request('seedvis/seedance_2.5', 't2v', 2))
    const refs = sent.map(i => ({ field: i.field, index: i.index, role: 'start', source: 'url' }))
    expect(echoCheck(sent, refs)).toBeNull()
    expect(echoCheck(sent, refs.map(i => ({ ...i, role: null, source: 'inline' })))).toBeNull()
    expect(echoCheck(sent, refs.slice(0, 1))).toBe('seedvis báo đã nhận 1/2 ảnh — xem lại video')
    expect(echoCheck(sent, [refs[0], refs[0]])).not.toBeNull()
    expect(echoCheck(sent, [...refs, { field: 'image', index: 0 }])).not.toBeNull()
    expect(echoCheck(sent, null)).toBe('seedvis báo đã nhận 0/2 ảnh — xem lại video')
  })

  it.each(['object', 'string'])('reads %s modes and only narrows catalogue constraints', shape => {
    const modes = shape === 'object' ? [
      { mode: 'text-to-video', images: { min: 0, max: 0 } },
      { mode: 'multi-image-to-video', images: { min: 1, max: 2 } },
    ] : ['text-to-video (0–0 images)', 'multi-image-to-video (1–2 images)']
    const limits = limitsFromModels({ data: [{
      id: 'Veo-3.1', modes, parameters: { duration: ['8s', '999s'], aspect_ratio: ['16:9', '1:1'], upscale_video: ['1080p'], prompt: { max_length: 1000 } },
    }] })
    expect(limits.source).toBe('server')
    const spec = limits.routes['seedvis/veo_3.1']!
    expect(spec).toMatchObject({ modes: ['t2v', 'i2v'], durations: [8], ratios: ['16:9'], resolutions: ['1080p'], promptLimit: 1000 })
    expect(spec.requests.find(r => r.mode === 'i2v')!.maxImages).toBe(2)
    expect(limits.routes['seedvis/seedance_2.5']).toBeUndefined()
    expect(() => toGenerationBody({ ...request('seedvis/veo_3.1', 'i2v', 3), resolution: '1080p' }, spec)).toThrow()
    expect(SEEDVIS_ROUTE_TABLE['seedvis/veo_3.1'].promptLimit).toBe(20_000)
  })

  it('accepts parameter schemas but never widens limits from server data', () => {
    const limits = limitsFromModels({ models: [{ id: 'seedance_2.5', modes: [{ name: 'image-to-video', images: { min: 0, max: 100 } }], parameters: { duration: { enum: [5, 999] }, aspect_ratio: { values: ['16:9', '99:1'] }, prompt: { maxLength: 999_999 } } }] })
    expect(limits.routes['seedvis/seedance_2.5']).toMatchObject({ durations: [5], ratios: ['16:9'], promptLimit: 20_000, requests: [{ minImages: 1, maxImages: 10 }] })
    expect(limitsFromModels({ data: [] })).toEqual({ source: 'server', routes: {} })
  })

  it('does not treat an unreadable /models answer as a firm empty catalogue', () => {
    for (const json of [null, {}, '<html>', { success: false, data: [] }, { status: 401, data: [] }, { data: [null] }, { data: [{ id: 'Veo-3.1' }] }, { data: [{ id: 'Veo-3.1', modes: [42] }] }]) expect(limitsFromModels(json)).toEqual({ source: 'none', routes: {} })
  })
})
