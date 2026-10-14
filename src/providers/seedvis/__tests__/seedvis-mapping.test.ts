import { describe, expect, it } from 'vitest'
import { SEEDVIS_ROUTE_TABLE } from '../../../core/seedvisRoutes'
import type { Mode, SeedvisModelId } from '../../../core/services'
import {
  echoCheck, errorOf, fieldToSlot, imageFileName, imageSlotNames, isJobNotFound, issuesFor, limitsFromModels,
  routeOf, seedvisIdempotencyKey, settingsIssues, statusOf, toGenerationBody, toRequestImages, validateRequest,
  type GenerationInput,
} from '../mapping'
import {
  SEEDVIS_SUBMIT_TEXT, SEEDVIS_TEXT, SeedvisPreSendError, seedvisDevWording, seedvisDeletePaidText,
  seedvisDownloadFailedText, seedvisExpiredLinkText, seedvisKeyInUseText, seedvisNotFoundText,
  seedvisNotStartedGroupText, seedvisOrphanText, seedvisPaidText, seedvisProjectBusyText, seedvisRerunNewTakeText,
  seedvisRerunSameKeyText, seedvisSafeRetryText, withPreSend,
} from '../wording'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
function request(model: SeedvisModelId = 'seedvis/seedance_2.5', mode: Mode = 't2v', count = 0): GenerationInput {
  return {
    model, mode, duration: model === 'seedvis/veo_3.1' ? 8 : 5, resolution: 'auto', ratio: '16:9',
    prompt: '  Cảnh phim\n ánh sáng tự nhiên  ',
    images: Array.from({ length: count }, () => ({ mime: 'image/png', bytes: png.slice() })),
  }
}
function preSendError(build: () => unknown): SeedvisPreSendError {
  try { build() } catch (e) { if (e instanceof SeedvisPreSendError) return e; throw e }
  throw new Error('expected a SeedvisPreSendError')
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

  it('builds the same body, key and file names from the same snapshot input (the engine-level M2 test belongs to B2)', () => {
    // GenerationInput carries no scene id, code, title or order, so a moveScene / rename cannot reach the body.
    // @ts-expect-error scene-derived fields are not part of the request input
    const withScene: GenerationInput = { ...request('seedvis/seedance_2.5', 't2v', 2), sceneCode: 'S01' }
    expect(withScene).toBeTruthy()
    const serialized = (req: GenerationInput) => JSON.stringify({
      body: toGenerationBody(req),
      images: toRequestImages(req).map(i => ({ ...i, bytes: [...i.bytes], file_name: imageFileName(i) })),
    })
    expect(serialized(request('seedvis/seedance_2.5', 't2v', 2))).toBe(serialized(request('seedvis/seedance_2.5', 't2v', 2)))
    expect(seedvisIdempotencyKey('take-1')).toBe(seedvisIdempotencyKey('take-1'))
    expect(seedvisIdempotencyKey('take-1')).not.toBe(seedvisIdempotencyKey('take-2'))
    expect(seedvisIdempotencyKey('take-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it.each([
    ['seedvis/seedance_2.5', 't2v', 11], ['seedvis/seedance_2.5', 'i2v', 1],
    ['seedvis/veo_3.1', 'i2v', 0], ['seedvis/veo_3.1', 'i2v', 4],
    ['seedvis/veo_3.1', 'first', 0], ['seedvis/veo_3.1', 'first', 2],
    ['seedvis/veo_3.1', 'transform', 1], ['seedvis/veo_3.1', 'transform', 3],
    ['seedvis/veo_3.1', 't2v', 1],
  ] as const)('refuses invalid image mode/count %s %s %i', (model, mode, count) => {
    const error = preSendError(() => toGenerationBody(request(model, mode, count)))
    expect(error.text).toBe(`${error.problem} Chưa gửi gì, không bị trừ credit.`)
    // The bare message never claims anything about money (a rebuild for a re-send must not say "free").
    expect(error.message).not.toMatch(/bị trừ/)
    expect(error.message).not.toMatch(/\b(?:t2v|i2v|first|transform)\b/)
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

  it.each([
    ['seedvis/veo_3.1', 'first', 1, '@image_1 chạy tới'],
    ['seedvis/veo_3.1', 'transform', 2, '@image_2 biến thành'],
    ['seedvis/veo_3.1', 'transform', 2, '@Image 1 đứng yên'],
    ['seedvis/veo_3.1', 't2v', 0, '@image_1 chạy'],
  ] as const)('refuses @image tokens when %s %s sends frames, not references', (model, mode, count, prompt) => {
    const problem = validateRequest({ ...request(model, mode, count), prompt })
    expect(problem).toContain('không gửi ảnh tham chiếu')
    expect(problem).toContain('Veo 3.1 · seedvis')
    expect(problem).not.toMatch(/\b(?:t2v|first|transform)\b/)
  })

  it('still accepts @image tokens that name a sent reference image', () => {
    expect(validateRequest({ ...request('seedvis/veo_3.1', 'i2v', 1), prompt: '@image_1 chạy' })).toBeNull()
    expect(validateRequest({ ...request('seedvis/veo_3.1', 'i2v', 1), prompt: '@image_2 chạy' })).toBe('Ảnh @image_2 không có trong các ảnh gửi tới seedvis.')
    expect(validateRequest({ ...request('seedvis/seedance_2.5', 't2v', 1), prompt: '@image_1 chạy' })).toBeNull()
  })

  it('names frames and modes in user words, never raw ids', () => {
    expect(imageSlotNames('seedvis/veo_3.1', 'transform', 2)).toEqual(['khung đầu', 'khung cuối'])
    expect(imageSlotNames('seedvis/veo_3.1', 'first', 1)).toEqual(['khung đầu'])
    expect(imageSlotNames('seedvis/veo_3.1', 'i2v', 2)).toEqual(['@image_1', '@image_2'])
    const badLast = request('seedvis/veo_3.1', 'transform', 2)
    badLast.images = [badLast.images[0], { mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }]
    expect(validateRequest(badLast)).toBe('Ảnh khung cuối không dùng được trên seedvis (PNG/JPEG/WebP, ≤ 20 MB).')
    expect(validateRequest(request('seedvis/seedance_2.5', 'first'))).toBe('seedvis không nhận chế độ Khung đầu → Video của Seedance 2.5.')
    expect(validateRequest(request('seedvis/veo_3.1', 'transform', 1)))
      .toBe('Số ảnh không hợp với chế độ Khung đầu → cuối của Veo 3.1 · seedvis: chế độ này nhận 2 ảnh, cảnh gửi 1.')
    expect(validateRequest(request('seedvis/seedance_2.5', 't2v', 11)))
      .toBe('Số ảnh không hợp với chế độ Text → Video (+ảnh) của Seedance 2.5 · seedvis: chế độ này nhận 0–10 ảnh, cảnh gửi 11.')
    expect(validateRequest({ ...request(), resolution: '1080p' })).toBe('seedvis không nhận độ phân giải 1080p của Seedance 2.5.')
  })

  it('tags settings refusals by field in the submit order', () => {
    expect(settingsIssues({ model: 'seedvis/veo_3.1', mode: 'i2v', duration: 5, resolution: 'auto', ratio: '1:1' }).map(i => i.field))
      .toEqual(['duration', 'ratio'])
    expect(settingsIssues({ model: 'seedvis/seedance_2.5', mode: 'first', duration: 7, resolution: '1080p', ratio: '2:1' }).map(i => i.field))
      .toEqual(['mode', 'duration', 'resolution', 'ratio'])
    expect(settingsIssues({ ...request(), model: 'minimax_h3' })).toEqual([{ field: 'model', reason: 'Model này không thuộc seedvis.' }])
    expect(settingsIssues(request())).toEqual([])
  })

  it('wraps pre-send refusals once with the money sentence', () => {
    const bad = { ...request('seedvis/seedance_2.5', 't2v', 1), images: [{ mime: 'image/png' as const, bytes: new Uint8Array([1]) }] }
    const error = preSendError(() => toGenerationBody(bad))
    expect(error.text).toBe('Ảnh @image_1 không dùng được trên seedvis (PNG/JPEG/WebP, ≤ 20 MB). Chưa gửi gì, không bị trừ credit.')
    expect(error.text.match(/bị trừ/g)).toHaveLength(1)
    expect(withPreSend('seedvis không nhận tham số — chưa bị trừ credit.')).toBe('seedvis không nhận tham số — chưa bị trừ credit.')
    expect(withPreSend('Ảnh quá lớn')).toBe('Ảnh quá lớn. Chưa gửi gì, không bị trừ credit.')
    expect(() => toRequestImages(bad)).toThrow(SeedvisPreSendError)
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
    [429, '', 'đang đầy luồng', 'deferred', 'queue'],
    [503, 'server_busy', 'đang đầy luồng', 'deferred', 'queue'],
    [500, 'server_error', 'Không rõ yêu cầu', 'uncertain', 'same-key-gated'],
    [502, '', 'Không rõ yêu cầu', 'uncertain', 'same-key-gated'],
    [504, 'generation_failed', 'Không rõ yêu cầu', 'uncertain', 'same-key-gated'],
    // §7.7 "Lost answer / 5xx after sending → §7.3 step 6 (gated re-sends)"
    [0, '', 'Không rõ yêu cầu', 'uncertain', 'same-key-gated'],
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

  it('distinguishes full queues from schema validation 422; every deferral goes back to the queue', () => {
    expect(errorOf(422, { message: 'All slots are full and queue is full' })).toMatchObject({ class: 'deferred', retry: 'queue' })
    expect(errorOf(422, { code: 'validation_error', message: 'Concurrency limit and queue limit reached' })).toMatchObject({ class: 'deferred', retry: 'queue' })
    expect(errorOf(422, { code: 'validation_error', message: 'image queue metadata is invalid' }).class).toBe('error')
    expect(errorOf(429, null)).toMatchObject({ class: 'deferred', retry: 'queue' })
    expect(errorOf(503, { error: { code: 'server_busy' } })).toMatchObject({ class: 'deferred', retry: 'queue' })
  })

  it('treats a lost answer as the gated same-key case (§7.3 step 6) and closes with the gate', () => {
    expect(errorOf(0, null)).toMatchObject({ class: 'uncertain', retry: 'same-key-gated', text: SEEDVIS_SUBMIT_TEXT.seedvis.unknown })
    expect(errorOf(0, null, { gateClosed: true })).toMatchObject({ class: 'uncertain', retry: 'none', text: SEEDVIS_SUBMIT_TEXT.seedvis.unverifiable })
  })

  it('keeps an accepted (2xx) submit without a readable job uncertain, and maps a failed job body by code', () => {
    for (const body of [null, '<html>ok</html>', {}, { data: { status: 'queued' } }, { data: { status: 'running' } }]) {
      expect(errorOf(200, body)).toMatchObject({ class: 'uncertain', retry: 'same-key-gated', text: SEEDVIS_SUBMIT_TEXT.seedvis.unknown })
    }
    expect(errorOf(202, '<html>').detail).toBe(SEEDVIS_TEXT.invalidResponse)
    const failed = (code: string, message = 'x') => errorOf(200, { data: { id: 'job', status: 'failed', error: { code, message } } })
    expect(failed('generation_failed')).toMatchObject({ class: 'error', text: 'seedvis báo tạo video thất bại: x' })
    expect(failed('timeout')).toMatchObject({ class: 'error', text: 'seedvis báo tạo video thất bại: x' })
    expect(failed('not_started')).toMatchObject({ class: 'error', retry: 'new-take', text: SEEDVIS_TEXT.notStarted })
    expect(failed('insufficient_credits').text).toBe(SEEDVIS_TEXT.insufficientCredits)
    expect(failed('cancelled')).toMatchObject({ class: 'cancelled', text: SEEDVIS_TEXT.cancelled })
    expect(failed('generation_failed', '').text).toBe('seedvis báo tạo video thất bại.')
  })

  it('never doubles the seedvis prefix and names models / modes in user words', () => {
    expect(errorOf(418, {}).text).toBe('seedvis báo lỗi nhưng không nói lý do.')
    expect(errorOf(418, { message: 'teapot' }).text).toBe('seedvis: teapot')
    expect(errorOf(422, { code: 'image_rule', message: 'x' }, { model: 'seedvis/veo_3.1', mode: 'transform' }).text)
      .toBe('Số ảnh không hợp với chế độ Khung đầu → cuối của Veo 3.1: x')
    expect(errorOf(403, {}, { model: 'seedvis/veo_3.1' }).text).toBe('Gói seedvis hoặc khoá API không có quyền dùng Veo 3.1.')
    expect(errorOf(404, { code: 'model_not_found' }, { model: 'Seedance 2.5' }).text).toContain('không nhận Seedance 2.5')
    expect(errorOf(400, { code: 'invalid_value' }).text).toBe('seedvis không nhận tham số — chưa bị trừ credit.')
  })

  it('never auto-retries a moderation refusal even with a retryable HTTP status', () => {
    expect(errorOf(429, { code: 'content_policy' })).toMatchObject({ class: 'error', retry: 'none' })
    expect(errorOf(500, { code: 'content_policy' }, { priorSent: true })).toMatchObject({ class: 'uncertain', retry: 'none' })
  })

  it.each([0, 200, 400, 401, 402, 403, 404, 409, 422, 429, 500, 503])('keeps a prior uncertain POST uncertain after HTTP %i (M6, §7.3 step 7)', status => {
    for (const code of ['content_policy', 'insufficient_credits', 'cancelled', 'model_maintenance', 'server_busy', 'idempotency_conflict', 'invalid_value', '']) {
      const result = errorOf(status, { error: { code, message: 'detail' } }, { priorSent: true })
      expect(result.class).toBe('uncertain')
      expect(result.text).toBe(SEEDVIS_SUBMIT_TEXT.seedvis.unknown)
      // The automatic schedule continues while the gate allows; moderation is never re-sent automatically.
      expect(result.retry).toBe(code === 'content_policy' ? 'none' : 'same-key-gated')
      expect(errorOf(status, {}, { priorSent: true, gateClosed: true })).toMatchObject({ text: SEEDVIS_SUBMIT_TEXT.seedvis.unverifiable, retry: 'none' })
    }
    for (const code of ['reference_image_missing', 'invalid_request']) expect(errorOf(status, { code }, { priorSent: true }).retry).toBe('none')
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
    for (const http of [404, 500]) {
      expect(errorOf(http, { data: { status: 'failed', error: { code: 'generation_failed' } } }, { phase: 'poll' }).class).toBe('processing')
    }
    expect(errorOf(409, { error: { code: 'not_cancellable' } }, { phase: 'cancel' }).text).toBe(SEEDVIS_TEXT.cancelRunning)
    expect(errorOf(503, { error: { code: 'cancel_unavailable' } }, { phase: 'cancel' }).text).toBe(SEEDVIS_TEXT.cancelUnknown)
  })

  it.each([
    [400, '<html>bad gateway page</html>'], [408, '<html>timeout</html>'], [410, null], [422, ''], [400, {}],
    [410, { error: { code: 'gone', message: 'gone' } }], [418, { error: { code: 'insufficient_credits' } }],
    [0, null], [200, null], [200, '<html>'], [200, {}],
    [200, { data: { status: 'running' } }], [200, { data: { status: 'processing' } }], [202, { data: { status: 'queued' } }],
    [200, { data: { status: 'completed' } }], [200, { status: 'new_state', error: { code: 'not_started' } }],
  ])('never ends a paid take on a poll answer %i %j that is not a failed job (§6.9)', (http, body) => {
    expect(errorOf(http, body, { phase: 'poll' })).toMatchObject({ class: 'processing', retry: 'poll', text: SEEDVIS_TEXT.pollWaiting })
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
    const texts = [
      ...Object.values(SEEDVIS_TEXT), ...Object.values(SEEDVIS_SUBMIT_TEXT.seedvis), seedvisPaidText(120),
      seedvisDeletePaidText('Take này'), seedvisDownloadFailedText('mất mạng.', 7), seedvisNotFoundText('abcdef123456'),
      seedvisRerunSameKeyText('S01 · T2'), seedvisRerunNewTakeText('S01 · T2'), seedvisNotStartedGroupText(3),
      seedvisOrphanText('abcdef123456', 'refunded'), seedvisProjectBusyText(2), seedvisKeyInUseText(2, 'AB12'),
    ]
    for (const text of texts) {
      const simulated = seedvisDevWording(text)
      expect(seedvisDevWording(simulated)).toBe(simulated)
      expect(simulated).not.toContain('seedvis.com')
      expect(simulated).not.toMatch(/credit(?! dev)/)
      expect(simulated).not.toMatch(/Cài đặt › Bảng phát triển|giả lập giả lập|credit dev seedvis giả lập|credit dev dev/)
    }
    expect(SEEDVIS_SUBMIT_TEXT.seedvis.unknown).toBe('Không rõ yêu cầu đã tới seedvis chưa (có thể đã bị trừ credit).')
  })

  it('pins the simulated words: Dev panel tab, "seedvis giả lập", "credit dev seedvis"', () => {
    expect(seedvisDevWording(SEEDVIS_TEXT.keyRequired)).toBe('Khoá API seedvis giả lập thiếu hoặc sai — mở Bảng phát triển › seedvis giả lập.')
    expect(seedvisDevWording(seedvisPaidText(120))).toBe('đã trả ≈ 120 credit dev seedvis')
    expect(seedvisDevWording(SEEDVIS_TEXT.insufficientCredits))
      .toBe('Tài khoản seedvis giả lập không đủ credit dev — nạp trong Bảng phát triển › seedvis giả lập rồi bấm Chạy lại.')
    expect(SEEDVIS_SUBMIT_TEXT['seedvis-dev'].unknown).toBe('Không rõ yêu cầu đã tới seedvis giả lập chưa (có thể đã bị trừ credit dev).')
    expect(SEEDVIS_SUBMIT_TEXT['seedvis-dev'].unverifiable).toBe('Không kiểm tra được lần gửi trước của take này nữa — seedvis giả lập có thể đã nhận và trừ credit dev. SanoVids sẽ không gửi lại take này. Xem số dư và lịch sử trong Bảng phát triển › seedvis giả lập trước khi bấm “Tạo lại” để tạo một take MỚI (nếu lần trước đã bị trừ thì sẽ trừ thêm một lần).')
    expect(seedvisDevWording(SEEDVIS_TEXT.preSend)).toBe('Chưa gửi gì, không bị trừ credit dev.')
    expect(seedvisDevWording('seedvis: Not enough credits')).toBe('seedvis giả lập: Not enough credits')
    expect(errorOf(401, {}, { provider: 'seedvis-dev' }).text).toBe('Khoá API seedvis giả lập thiếu hoặc sai — mở Bảng phát triển › seedvis giả lập.')
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

  it('pins the remaining plan money texts (§6.4, §6.10, §7.3, §7.4)', () => {
    expect(SEEDVIS_TEXT.uploadIncomplete).toBe('Mạng chậm hoặc mất khi đang tải ảnh lên seedvis — chưa gửi gì, không bị trừ credit.')
    expect(SEEDVIS_TEXT.resending).toBe('Mất kết nối lúc gửi — SanoVids đang gửi lại cùng mã (an toàn, seedvis trả lại job cũ nếu đã nhận)')
    expect(SEEDVIS_TEXT.resendSameKey).toBe('gửi lại cùng mã — seedvis trả lại job cũ nếu còn nhớ mã')
    expect(seedvisRerunSameKeyText('S01 · T2')).toBe('S01 · T2: không rõ lần gửi trước đã tới seedvis chưa. SanoVids gửi lại NGAY với CÙNG mã: nếu seedvis đã nhận, nó trả lại đúng job đó, không trừ lần hai. Gửi lại?')
    expect(seedvisRerunNewTakeText('S01 · T2')).toBe('S01 · T2: SanoVids không kiểm tra được lần gửi trước — seedvis có thể đã nhận và trừ credit, và seedvis không cho tra job theo mã. Trước khi tạo lại, xem số dư và lịch sử trên seedvis.com: video có thể đã có ở đó. “Tạo lại” tạo một take MỚI (xem chi phí trước khi gửi); nếu lần trước đã bị trừ thì lần này trừ thêm. Tạo lại?')
    expect(seedvisNotStartedGroupText(3)).toBe('3 cảnh seedvis chưa bắt đầu (không bị trừ credit)')
    expect(SEEDVIS_TEXT.rerunAll).toBe('Chạy lại tất cả')
    expect(seedvisOrphanText('abcdef123456', 'refunded')).toBe('Một take bị xoá lúc đang gửi: job seedvis …abcdef12 đã huỷ, đã hoàn credit')
    expect(seedvisOrphanText('abcdef123456', 'running')).toBe('Một take bị xoá lúc đang gửi: job seedvis …abcdef12 vẫn chạy và bị trừ credit')
    expect(seedvisProjectBusyText(2)).toBe('Dự án còn 2 take seedvis chưa xong — mở dự án, huỷ hoặc đợi xong rồi xoá')
    expect(SEEDVIS_TEXT.openProject).toBe('Mở dự án')
    expect(seedvisKeyInUseText(2, 'AB12')).toBe('2 take seedvis đang chạy bằng khoá …AB12 — xoá thì SanoVids không theo dõi / tải được chúng cho đến khi bạn dán lại đúng khoá này')
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

  it('reads list values defensively and never narrows a list to nothing', () => {
    const veo = (parameters: Record<string, unknown>, modes: unknown[] = ['text-to-video']) =>
      limitsFromModels({ data: [{ id: 'Veo-3.1', modes, parameters }] }).routes['seedvis/veo_3.1']!
    expect(veo({ duration: { values: [{ value: '4s' }, { value: '8s' }] } }).durations).toEqual([4, 8])
    expect(veo({ duration: [4, 6, 8] }).durations).toEqual([4, 6, 8])
    expect(veo({ duration: ['6'] }).durations).toEqual([6])
    expect(veo({ duration: [5, 7] }).durations).toEqual([4, 6, 8])
    expect(veo({ duration: [{ seconds: 4 }, null, true] }).durations).toEqual([4, 6, 8])
    expect(veo({ aspect_ratio: [{ value: '9:16' }] }).ratios).toEqual(['9:16'])
    expect(veo({ aspect_ratio: ['4:5'] }).ratios).toEqual(['16:9', '9:16'])
    expect(veo({ upscale_video: ['NONE'] }).resolutions).toEqual(['auto'])
    expect(veo({ upscale_video: ['4k'] }).resolutions).toEqual(['auto', '1080p'])
    // Renamed modes / disjoint image ranges: the built-in routes stay (seedvis refuses what it no longer takes, unbilled).
    expect(veo({}, ['text-to-movie']).modes).toEqual(['t2v', 'first', 'i2v', 'transform'])
    expect(veo({}, [{ mode: 'txt2vid' }]).modes).toEqual(['t2v', 'first', 'i2v', 'transform'])
    expect(veo({}, [{ mode: 'batch-frame', images: { min: 5, max: 9 } }]).requests).toEqual(SEEDVIS_ROUTE_TABLE['seedvis/veo_3.1'].requests)
    const seedance = limitsFromModels({ data: [{ id: 'seedance_2.5', modes: ['text-to-video'], parameters: { duration: ['5', '10'] } }] })
    expect(seedance.routes['seedvis/seedance_2.5']!.durations).toEqual([5, 10])
    expect(validateRequest({ ...request('seedvis/veo_3.1'), duration: 8 }, veo({ duration: { values: [{ value: '8s' }] } }))).toBeNull()
  })

  it('gives SettingsLimits.issues per field from a /models read (§7.8)', () => {
    const read = limitsFromModels({ data: [{ id: 'Veo-3.1', modes: ['text-to-video', 'multi-image-to-video (1–3 images)'], parameters: { duration: ['8s'] } }] })
    const veo = { model: 'seedvis/veo_3.1' as const, mode: 't2v' as const, duration: 4, resolution: 'auto', ratio: '1:1' }
    expect(issuesFor(read, veo)).toEqual([
      { field: 'duration', reason: 'seedvis không nhận thời lượng 4 giây của Veo 3.1.' },
      { field: 'ratio', reason: 'seedvis không nhận tỉ lệ 1:1 của Veo 3.1.' },
    ])
    expect(issuesFor(read, { ...veo, mode: 'transform', duration: 8, ratio: '16:9' }).map(i => i.field)).toEqual(['mode'])
    expect(issuesFor(read, { ...veo, duration: 8, ratio: '16:9' })).toEqual([])
    expect(issuesFor(read, { ...veo, model: 'seedvis/seedance_2.5', duration: 5 }))
      .toEqual([{ field: 'model', reason: 'seedvis hiện không nhận Seedance 2.5 (bảo trì hoặc gói chưa mở).' }])
    expect(issuesFor({ source: 'none', routes: {} }, veo)).toEqual([])
    expect(issuesFor(read, { ...veo, model: 'seedance_2_5' })).toEqual([{ field: 'model', reason: 'Model này không thuộc seedvis.' }])
  })

  it('does not treat an unreadable /models answer as a firm empty catalogue', () => {
    for (const json of [null, {}, '<html>', { success: false, data: [] }, { status: 401, data: [] }, { data: [null] }, { data: [{ id: 'Veo-3.1' }] }, { data: [{ id: 'Veo-3.1', modes: [42] }] }]) expect(limitsFromModels(json)).toEqual({ source: 'none', routes: {} })
  })
})
