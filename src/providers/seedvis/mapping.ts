// Pure A-MAP helpers. No store, transport, clock, arrival gate or runtime registration.
import { hasRetiredVideoToken, parseTokens } from '../../core/compile'
import { imagePlaceholders } from '../../core/placeholders'
import type { Mode, ModelId, SeedvisModelId } from '../../core/services'
import { SEEDVIS_ROUTE_TABLE, type SeedvisRouteSpec } from '../../core/seedvisRoutes'
import type { VideoSettings } from '../../core/types'
import { uuidFromKey } from '../../lib/uuidKey'
import type { SeedvisGenerationBody, SeedvisRequestImage, SeedvisRemoteStatus } from './contract'
import { imageBudget, imageFormat } from './prepareImages'
import {
  SEEDVIS_TEXT, SEEDVIS_SUBMIT_TEXT, seedvisDevWording, seedvisEchoText,
  seedvisFailureText, seedvisImageRuleText, seedvisImageText, seedvisModelText,
  seedvisParameterText, seedvisPermissionText, seedvisRemoteText,
} from './wording'

// B1 will extend VideoSettings; reuse its existing fields without changing the app union in A-MAP.
export type SeedvisSettings = Omit<VideoSettings, 'model' | 'mode'> & { model: ModelId; mode: Mode }
export interface GenerationInput extends SeedvisSettings {
  prompt: string
  /** Prepared snapshot images in @image_N order; frame modes use first, then last. */
  images: readonly Pick<SeedvisRequestImage, 'mime' | 'bytes'>[]
}
export const seedvisIdempotencyKey = (takeId: string) => uuidFromKey(`sanovids:seedvis:${takeId}`)

export function routeOf(model: string): SeedvisRouteSpec | null {
  return Object.hasOwn(SEEDVIS_ROUTE_TABLE, model) ? SEEDVIS_ROUTE_TABLE[model as SeedvisModelId] : null
}

export function validateRequest(req: GenerationInput, spec = routeOf(req.model)): string | null {
  if (!spec || spec.id !== req.model) return 'Model này không thuộc seedvis.'
  if (!spec.modes.includes(req.mode)) return `seedvis không nhận chế độ ${req.mode} của ${spec.name}.`
  if (!spec.durations.includes(req.duration)) return `seedvis không nhận thời lượng ${req.duration} giây của ${spec.name}.`
  if (!spec.ratios.some(r => r === req.ratio)) return `seedvis không nhận tỉ lệ ${req.ratio} của ${spec.name}.`
  if (!spec.resolutions.some(r => r === req.resolution)) return `seedvis không nhận độ phân giải ${req.resolution} của ${spec.name}.`
  const prompt = req.prompt.trim()
  if (!prompt) return 'Nhập prompt trước khi chạy trên seedvis.'
  if (prompt.length > spec.promptLimit) return `Prompt vượt ${spec.promptLimit} ký tự của seedvis.`
  if (hasRetiredVideoToken(prompt)) return 'seedvis không nhận video tham chiếu — hãy bỏ token @video khỏi prompt.'
  if (imagePlaceholders(prompt).length) return 'Prompt còn ảnh chưa gắn (@image_?N) — hãy gắn ảnh trước khi chạy.'
  const missing = parseTokens(prompt).find(t => t.kind === 'image' && (t.n < 1 || t.n > req.images.length))
  if (missing) return `Ảnh @image_${missing.n} không có trong các ảnh gửi tới seedvis.`
  const route = spec.requests.find(r => r.mode === req.mode && req.images.length >= r.minImages && req.images.length <= r.maxImages)
  if (!route) return seedvisImageRuleText(req.mode, spec.name, `${req.images.length} ảnh không nằm trong giới hạn chế độ.`)
  for (const [i, image] of req.images.entries()) {
    if (!spec.imageLimits.formats.includes(image.mime) || imageFormat(image.bytes) !== image.mime) return seedvisImageText(`@image_${i + 1}`)
  }
  if (!imageBudget(req.images).fits) return 'Ảnh vượt giới hạn seedvis (20 MiB mỗi ảnh, 39 MiB base64 mỗi yêu cầu).'
  return null
}

/** Fixed property order, snapshot prompt only; main appends inline images from toRequestImages. */
export function toGenerationBody(req: GenerationInput, spec = routeOf(req.model)): SeedvisGenerationBody {
  const problem = validateRequest(req, spec)
  if (problem || !spec) throw new Error(`${problem} ${SEEDVIS_TEXT.preSend}`)
  const route = spec.requests.find(r => r.mode === req.mode && req.images.length >= r.minImages && req.images.length <= r.maxImages)!
  // Validated against A0 above; the union's correlated fields cannot be inferred from the data table.
  return {
    model: spec.remoteModel, mode: route.remoteMode, prompt: req.prompt.trim(),
    aspect_ratio: req.ratio,
    duration: spec.durationEncoding === 'seconds-suffix' ? `${req.duration}s` : req.duration,
    ...(spec.family === 'veo' ? { upscale_video: spec.upscaleVideo[req.resolution as keyof typeof spec.upscaleVideo] } : {}),
    count: spec.count,
  } as SeedvisGenerationBody
}

export function toRequestImages(req: GenerationInput): SeedvisRequestImage[] {
  const body = toGenerationBody(req)
  const route = routeOf(req.model)!.requests.find(r => r.remoteMode === body.mode)!
  return req.images.map((image, i) => {
    const field = route.imageFields.length === 1 ? route.imageFields[0] : route.imageFields[i]
    return { field, index: field === 'image' || field === 'lastFrame' ? 0 : i, mime: image.mime, bytes: image.bytes }
  })
}

/** Main uses this helper when it builds {data, file_name}; never include scene titles/codes. */
export function imageFileName(image: Pick<SeedvisRequestImage, 'field' | 'index' | 'mime'>): string {
  const name = image.field === 'image' ? 'frame_first' : image.field === 'lastFrame' ? 'frame_last' : `image_${image.index + 1}`
  return `${name}.${image.mime === 'image/jpeg' ? 'jpg' : image.mime === 'image/webp' ? 'webp' : 'png'}`
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const dataOf = (json: unknown) => {
  const root = record(json)
  return root.data && !Array.isArray(root.data) && typeof root.data === 'object' ? record(root.data) : root
}
const string = (value: unknown) => typeof value === 'string' ? value : ''

export function fieldToSlot(field: string): string {
  if (field === 'image') return 'khung đầu'
  if (field === 'lastFrame') return 'khung cuối'
  const m = /^(?:reference_images|referenceImages)\[(\d+)\](?:\.(?:data|file_name))?$/.exec(field)
  if (m && Number.isSafeInteger(Number(m[1]))) return `@image_${Number(m[1]) + 1}`
  return field ? `tham chiếu (${field})` : 'tham chiếu'
}

export interface MappedError {
  text: string
  detail: string
  class: 'error' | 'uncertain' | 'deferred' | 'cancelled' | 'processing' | 'held'
  code: string
  retry: 'none' | 'same-key-gated' | 'new-take' | 'poll' | 'cancel'
}
export interface ErrorContext {
  phase?: 'submit' | 'poll' | 'cancel'
  /** An earlier POST may already have reached seedvis; a later refusal cannot erase it. */
  priorSent?: boolean
  gateClosed?: boolean
  provider?: keyof typeof SEEDVIS_SUBMIT_TEXT
  model?: string
  mode?: string
}

/** Native / OpenAI / Google error shapes; messages are plain text, never rendered as HTML. */
export function errorOf(status: number, json: unknown, context: ErrorContext = {}): MappedError {
  const data = dataOf(json), error = record(data.error), fields = record(data.errors)
  const field = string(error.param) || Object.keys(fields)[0] || ''
  const fieldValue = fields[field]
  const message = string(error.message) || string(data.message) || string(fieldValue) ||
    (Array.isArray(fieldValue) ? fieldValue.filter(v => typeof v === 'string').join('; ') : '')
  const code = string(error.code) || string(data.code) || `http_${status}`
  const inputRefusal = ['content_policy', 'reference_image_missing', 'invalid_request', 'invalid_image', 'image_rule', 'invalid_value'].includes(code)
  const retry = !inputRefusal && (status === 429 || status >= 500) ? 'same-key-gated' : 'none'
  const phase = context.phase ?? 'submit'
  const words = SEEDVIS_SUBMIT_TEXT[context.provider ?? 'seedvis']
  const finish = (text: string, cls: MappedError['class'] = 'error', retry: MappedError['retry'] = 'none'): MappedError => ({
    text: context.provider === 'seedvis-dev' ? seedvisDevWording(text) : text,
    detail: message, class: cls, code, retry,
  })
  const uncertain = (retry: MappedError['retry']) => finish(context.gateClosed ? words.unverifiable : words.unknown, 'uncertain', context.gateClosed ? 'none' : retry)
  if (phase === 'submit' && context.priorSent) return uncertain(retry)
  if (phase === 'cancel') return finish(code === 'not_cancellable' ? SEEDVIS_TEXT.cancelRunning : SEEDVIS_TEXT.cancelUnknown, 'processing', 'cancel')
  if (phase === 'poll') {
    if (status === 401 || status === 403) return finish(SEEDVIS_TEXT.keyRequired, 'held')
    if (status === 404 || status === 429 || status >= 500) return finish(SEEDVIS_TEXT.pollWaiting, 'processing', 'poll')
    if (code === 'not_started') return finish(SEEDVIS_TEXT.notStarted, 'error', 'new-take')
    if (code === 'cancelled') return finish(SEEDVIS_TEXT.cancelled, 'cancelled')
    if (code === 'insufficient_credits') return finish(SEEDVIS_TEXT.insufficientCredits)
    if (code === 'generation_failed' || code === 'timeout') return finish(seedvisFailureText(message))
    return finish(seedvisRemoteText(message || SEEDVIS_TEXT.invalidResponse))
  }
  if (code === 'idempotency_conflict' || status === 409) return uncertain('none')
  if (status === 401) return finish(SEEDVIS_TEXT.keyRequired)
  if (status === 402 || code === 'insufficient_credits') return finish(SEEDVIS_TEXT.insufficientCredits)
  if (status === 403) return finish(seedvisPermissionText(context.model ?? 'model này'))
  if (code === 'model_not_found' || code === 'model_maintenance') return finish(seedvisModelText(context.model ?? 'model này'))
  if (!inputRefusal && (status === 429 || code === 'server_busy' ||
      (status === 422 && /(?:slots?|streams?|concurrency).*(?:full|busy|limit).*(?:queue).*(?:full|limit|reached)|(?:queue).*(?:full|limit).*(?:slots?|streams?|concurrency).*(?:full|busy|limit|reached)/i.test(message)))) {
    return finish(SEEDVIS_TEXT.busy, 'deferred', retry)
  }
  if (status === 0 || status >= 500) return uncertain(retry)
  if (code === 'invalid_image') return finish(seedvisImageText(fieldToSlot(field)))
  if (code === 'image_rule') return finish(seedvisImageRuleText(context.mode ?? 'này', context.model ?? 'model này', message))
  if (['content_policy', 'reference_image_missing', 'invalid_request'].includes(code)) return finish(SEEDVIS_TEXT.contentPolicy)
  if (code === 'invalid_value' || code === 'validation_error') return finish(seedvisParameterText(message))
  return finish(seedvisRemoteText(message || SEEDVIS_TEXT.invalidResponse))
}

/** A 202 response is a normal job response. Unknown states stay unknown, never completed. */
export function statusOf(json: unknown): SeedvisRemoteStatus | 'cancelled' | null {
  const data = dataOf(json)
  if (data.status === 'failed' && record(data.error).code === 'cancelled') return 'cancelled'
  return ['queued', 'processing', 'completed', 'failed'].includes(string(data.status)) ? data.status as SeedvisRemoteStatus : null
}

/** Only evidence parsing; A2 owns elapsed time, repeat count and same-key checks. */
export function isJobNotFound(status: number, json: unknown, confirmedCode: string | null = null): boolean {
  if (status !== 404 || !confirmedCode || confirmedCode.startsWith('model_')) return false
  const data = dataOf(json)
  return (string(record(data.error).code) || string(data.code)) === confirmedCode
}

/** Compare pairs, not URLs/source/role. Even a short or malformed echo only warns. */
export function echoCheck(sent: readonly Pick<SeedvisRequestImage, 'field' | 'index'>[], references: unknown): string | null {
  const pairs = new Set<string>()
  for (const value of Array.isArray(references) ? references : []) {
    const ref = record(value)
    if (typeof ref.field === 'string' && Number.isSafeInteger(ref.index)) pairs.add(`${ref.field}:${ref.index}`)
  }
  const count = sent.filter(image => pairs.has(`${image.field}:${image.index}`)).length
  return count === sent.length && pairs.size === sent.length ? null : seedvisEchoText(count, sent.length)
}

/** Parse the two documented /models shapes. Pure narrowing; freshness/firmness belongs to A2. */
export function limitsFromModels(json: unknown): { source: 'server' | 'none'; routes: Partial<Record<SeedvisModelId, SeedvisRouteSpec>> } {
  const root = record(json)
  if (root.success === false || (typeof root.status === 'number' && root.status >= 400)) return { source: 'none', routes: {} }
  const data = record(root.data)
  const rows = Array.isArray(json) ? json : Array.isArray(root.data) ? root.data : root.models ?? data.models
  if (!Array.isArray(rows) || rows.some(row => typeof record(row).id !== 'string')) return { source: 'none', routes: {} }
  const routes: Partial<Record<SeedvisModelId, SeedvisRouteSpec>> = {}
  for (const builtIn of Object.values(SEEDVIS_ROUTE_TABLE) as SeedvisRouteSpec[]) {
    const matches = rows.filter(row => record(row).id === builtIn.remoteModel)
    if (matches.length > 1) return { source: 'none', routes: {} }
    if (!matches.length) continue
    const model = record(matches[0]), params = record(model.parameters)
    if (!Array.isArray(model.modes)) return { source: 'none', routes: {} }
    const modes = model.modes.map(value => {
      if (typeof value === 'string') {
        const m = /^([a-z-]+)(?:\s*\((\d+)\s*[–-]\s*(\d+) images\))?$/.exec(value)
        return m ? { name: m[1], min: m[2] === undefined ? undefined : Number(m[2]), max: m[3] === undefined ? undefined : Number(m[3]) } : null
      }
      const mode = record(value), images = record(mode.images)
      const name = string(mode.mode) || string(mode.id) || string(mode.name)
      if (!name || (images.min !== undefined && (!Number.isSafeInteger(images.min) || Number(images.min) < 0)) ||
          (images.max !== undefined && (!Number.isSafeInteger(images.max) || Number(images.max) < 0))) return null
      if (images.min !== undefined && images.max !== undefined && Number(images.min) > Number(images.max)) return null
      return { name, min: images.min as number | undefined, max: images.max as number | undefined }
    })
    if (modes.some(m => !m)) return { source: 'none', routes: {} }
    const requests = builtIn.requests.flatMap(route => {
      const mode = modes.find(m => m?.name === route.remoteMode)
      if (!mode) return []
      const minImages = Math.max(route.minImages, mode.min ?? route.minImages)
      const maxImages = Math.min(route.maxImages, mode.max ?? route.maxImages)
      return minImages <= maxImages ? [{ ...route, minImages, maxImages }] : []
    })
    const allowed = (field: string): unknown[] | null => {
      const value = params[field], spec = record(value)
      return Array.isArray(value) ? value : Array.isArray(spec.enum) ? spec.enum : Array.isArray(spec.values) ? spec.values : null
    }
    const durations = allowed('duration'), ratios = allowed('aspect_ratio'), upscale = allowed('upscale_video')
    const promptLimit = record(params.prompt).max_length ?? record(params.prompt).maxLength ?? model.prompt_limit
    routes[builtIn.id] = {
      ...builtIn, requests, modes: builtIn.modes.filter(mode => requests.some(r => r.mode === mode)),
      durations: builtIn.durations.filter(n => !durations || durations.includes(builtIn.durationEncoding === 'seconds-suffix' ? `${n}s` : n)),
      ratios: builtIn.ratios.filter(r => !ratios || ratios.includes(r)),
      resolutions: builtIn.resolutions.filter(r => builtIn.family !== 'veo' || !upscale || upscale.includes(builtIn.upscaleVideo[r])),
      promptLimit: Number.isSafeInteger(promptLimit) && Number(promptLimit) > 0 ? Math.min(builtIn.promptLimit, Number(promptLimit)) : builtIn.promptLimit,
    }
  }
  return { source: 'server', routes }
}
