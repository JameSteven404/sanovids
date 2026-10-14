// Pure A-MAP helpers. No store, transport, clock, arrival gate or runtime registration.
import { hasRetiredVideoToken, parseTokens } from '../../core/compile'
import { imagePlaceholders } from '../../core/placeholders'
import type { Mode, ModelId, SeedvisModelId } from '../../core/services'
import { SEEDVIS_ROUTE_TABLE, type SeedvisRouteSpec } from '../../core/seedvisRoutes'
import type { VideoSettings } from '../../core/types'
import { uuidFromKey } from '../../lib/uuidKey'
import type { SettingsIssue } from '../types'
import type { SeedvisGenerationBody, SeedvisRequestImage, SeedvisRemoteStatus } from './contract'
import { imageBudget, imageFormat } from './prepareImages'
import {
  SEEDVIS_TEXT, SEEDVIS_SUBMIT_TEXT, SeedvisPreSendError, seedvisDevWording, seedvisEchoText,
  seedvisFailureText, seedvisImageProblem, seedvisImageRuleText, seedvisImageText, seedvisModelOffText,
  seedvisModelText, seedvisParameterText, seedvisPermissionText, seedvisRemoteText,
} from './wording'

// B1 will extend VideoSettings; reuse its existing fields without changing the app union in A-MAP.
export type SeedvisSettings = Omit<VideoSettings, 'model' | 'mode'> & { model: ModelId; mode: Mode }
type LimitedSettings = Pick<SeedvisSettings, 'model' | 'mode' | 'duration' | 'resolution' | 'ratio'>
/**
 * Everything a seedvis body is built from — the take's snapshot only. It deliberately has no scene id, code, title or
 * order, so moving / renaming a scene can never change a re-sent body (M2; B2 tests it on the engine's snapshot).
 */
export interface GenerationInput extends SeedvisSettings {
  prompt: string
  /** Prepared snapshot images in @image_N order; frame modes use first, then last. */
  images: readonly Pick<SeedvisRequestImage, 'mime' | 'bytes'>[]
}
export const seedvisIdempotencyKey = (takeId: string) => uuidFromKey(`sanovids:seedvis:${takeId}`)

export function routeOf(model: string): SeedvisRouteSpec | null {
  return Object.hasOwn(SEEDVIS_ROUTE_TABLE, model) ? SEEDVIS_ROUTE_TABLE[model as SeedvisModelId] : null
}

const NOT_SEEDVIS = 'Model này không thuộc seedvis.'
// Fallback names for a mode the route does not offer (its own modeLabels name only the offered ones). Never the raw
// id ("first", "FIRST") in user text (§3.2).
const MODE_NAMES: Readonly<Record<Mode, string>> = {
  t2v: 'Text → Video', i2v: 'Ảnh → Video', first: 'Khung đầu → Video', transform: 'Khung đầu → cuối',
}
/** "Khung đầu → cuối": the route's label of a mode, else a plain name; never the raw id. */
export function seedvisModeName(spec: SeedvisRouteSpec | null, mode: string): string {
  if (spec && Object.hasOwn(spec.modeLabels, mode)) return spec.modeLabels[mode as Mode]!
  return Object.hasOwn(MODE_NAMES, mode) ? MODE_NAMES[mode as Mode] : 'này'
}
/** "Veo 3.1 · seedvis" (the picker's name) for sentences that do not already name seedvis. */
export const seedvisModelName = (spec: SeedvisRouteSpec) => `${spec.name} · seedvis`

/** User names of the sent images, in order: "khung đầu" / "khung cuối" in a frame mode (Veo first / transform), else @image_N. */
export function imageSlotNames(model: string, mode: string, count: number): string[] {
  const spec = routeOf(model)
  const frames = !!spec && Object.hasOwn(spec.frameModes, mode)
  return Array.from({ length: count }, (_, i) => !frames ? `@image_${i + 1}` : i === 0 ? 'khung đầu' : i === 1 ? 'khung cuối' : `ảnh thứ ${i + 1}`)
}

/**
 * The route's refusals of these settings, each tagged with its field, in the submit's order (model, mode, duration,
 * resolution, ratio) — the same texts validateRequest refuses with. Pure; `spec` may be a /models-narrowed route.
 */
export function settingsIssues(s: LimitedSettings, spec: SeedvisRouteSpec | null = routeOf(s.model)): SettingsIssue[] {
  if (!spec || spec.id !== s.model) return [{ field: 'model', reason: NOT_SEEDVIS }]
  const out: SettingsIssue[] = []
  if (!spec.modes.includes(s.mode)) out.push({ field: 'mode', reason: `seedvis không nhận chế độ ${seedvisModeName(spec, s.mode)} của ${spec.name}.` })
  if (!spec.durations.includes(s.duration)) out.push({ field: 'duration', reason: `seedvis không nhận thời lượng ${s.duration} giây của ${spec.name}.` })
  if (!spec.resolutions.some(r => r === s.resolution)) {
    const name = Object.hasOwn(spec.resolutionLabels, s.resolution) ? spec.resolutionLabels[s.resolution as keyof typeof spec.resolutionLabels] : s.resolution
    out.push({ field: 'resolution', reason: `seedvis không nhận độ phân giải ${name} của ${spec.name}.` })
  }
  if (!spec.ratios.some(r => r === s.ratio)) out.push({ field: 'ratio', reason: `seedvis không nhận tỉ lệ ${s.ratio} của ${spec.name}.` })
  return out
}

/**
 * Last line before a send (like canvasapp's validateRequest): the bare reason, or null. A route-level refusal of the
 * settings comes from settingsIssues; when a /models read is known, check issuesFor(limits, req) first (a model the
 * read does not list has no narrowed spec to pass here). Wrap the reason in SeedvisPreSendError for the user.
 */
export function validateRequest(req: GenerationInput, spec = routeOf(req.model)): string | null {
  if (!spec || spec.id !== req.model) return NOT_SEEDVIS
  const settings = settingsIssues(req, spec)[0]
  if (settings) return settings.reason
  const prompt = req.prompt.trim()
  if (!prompt) return 'Nhập prompt trước khi chạy trên seedvis.'
  if (prompt.length > spec.promptLimit) return `Prompt vượt ${spec.promptLimit} ký tự của seedvis.`
  if (hasRetiredVideoToken(prompt)) return 'seedvis không nhận video tham chiếu — hãy bỏ token @video khỏi prompt.'
  if (imagePlaceholders(prompt).length) return 'Prompt còn ảnh chưa gắn (@image_?N) — hãy gắn ảnh trước khi chạy.'
  const tokens = parseTokens(prompt).filter(t => t.kind === 'image')
  // Frames are not reference images: in a mode without references (Veo t2v / first / transform) every @image_N is a
  // token with no media in the request (character sync rule) — never billed as plain words.
  if (tokens.length && !spec.imageModes.includes(req.mode)) {
    return `Chế độ ${seedvisModeName(spec, req.mode)} của ${seedvisModelName(spec)} không gửi ảnh tham chiếu — hãy bỏ @image_${tokens[0].n} khỏi prompt.`
  }
  const missing = tokens.find(t => t.n < 1 || t.n > req.images.length)
  if (missing) return `Ảnh @image_${missing.n} không có trong các ảnh gửi tới seedvis.`
  const route = spec.requests.find(r => r.mode === req.mode && req.images.length >= r.minImages && req.images.length <= r.maxImages)
  if (!route) {
    const modeRoutes = spec.requests.filter(r => r.mode === req.mode)
    const min = Math.min(...modeRoutes.map(r => r.minImages)), max = Math.max(...modeRoutes.map(r => r.maxImages))
    return seedvisImageRuleText(seedvisModeName(spec, req.mode), seedvisModelName(spec),
      `chế độ này nhận ${min === max ? min : `${min}–${max}`} ảnh, cảnh gửi ${req.images.length}.`)
  }
  const slots = imageSlotNames(req.model, req.mode, req.images.length)
  for (const [i, image] of req.images.entries()) {
    if (!spec.imageLimits.formats.includes(image.mime) || imageFormat(image.bytes) !== image.mime) return seedvisImageProblem(slots[i])
  }
  if (!imageBudget(req.images).fits) return 'Ảnh vượt giới hạn seedvis (20 MiB mỗi ảnh, 39 MiB base64 mỗi yêu cầu).'
  return null
}

/**
 * Fixed property order, snapshot prompt only; main appends inline images from toRequestImages. Build it ONCE for the
 * first send and store it: a same-key re-send reuses the stored body and bytes (M2), never a rebuild with a newer
 * (narrowed) spec. Throws SeedvisPreSendError, whose `text` ("không bị trừ credit") is only true before any send.
 */
export function toGenerationBody(req: GenerationInput, spec = routeOf(req.model)): SeedvisGenerationBody {
  const problem = validateRequest(req, spec)
  if (problem || !spec) throw new SeedvisPreSendError(problem ?? NOT_SEEDVIS)
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
  /**
   * What may happen next (§7.3 / §7.7):
   * - 'none': nothing automatic;
   * - 'same-key-gated': only a same-key re-send through the arrival gate (window.ts, A2; with
   *   SEEDVIS_KEY_MEMORY_MS = null it never opens) — a lost answer, a 5xx, or any answer to a re-send (step 7);
   * - 'queue': nothing reached seedvis as a job (429 / 503 server_busy / 422 slots full, nothing sent before):
   *   back to the queue with the deferral back-off (§6.5), not a gated re-send;
   * - 'new-take': only a new take (new key) by the user's choice (not_started);
   * - 'poll': keep polling with back-off (§6.9); 'cancel': the cancel may be tried again.
   */
  retry: 'none' | 'same-key-gated' | 'queue' | 'new-take' | 'poll' | 'cancel'
}
export interface ErrorContext {
  phase?: 'submit' | 'poll' | 'cancel'
  /** An earlier POST may already have reached seedvis; a later refusal cannot erase it. */
  priorSent?: boolean
  gateClosed?: boolean
  provider?: keyof typeof SEEDVIS_SUBMIT_TEXT
  /** A seedvis model id (named by its route) or a display name. */
  model?: string
  /** A mode id (named by the route's label) or a display name. */
  mode?: string
}

// Moderation is never re-sent automatically (§7.7 retry policy). Input refusals are never "deferred".
const MODERATION = ['content_policy', 'reference_image_missing', 'invalid_request']
const INPUT_REFUSAL = [...MODERATION, 'invalid_image', 'image_rule', 'invalid_value']
const SLOTS_FULL = /(?:slots?|streams?|concurrency).*(?:full|busy|limit).*(?:queue).*(?:full|limit|reached)|(?:queue).*(?:full|limit).*(?:slots?|streams?|concurrency).*(?:full|busy|limit|reached)/i

/** Native / OpenAI / Google error shapes; messages are plain text, never rendered as HTML. */
export function errorOf(status: number, json: unknown, context: ErrorContext = {}): MappedError {
  const data = dataOf(json), error = record(data.error), fields = record(data.errors)
  const field = string(error.param) || Object.keys(fields)[0] || ''
  const fieldValue = fields[field]
  const message = string(error.message) || string(data.message) || string(fieldValue) ||
    (Array.isArray(fieldValue) ? fieldValue.filter(v => typeof v === 'string').join('; ') : '')
  const code = string(error.code) || string(data.code) || `http_${status}`
  const moderation = MODERATION.includes(code)
  const phase = context.phase ?? 'submit'
  const words = SEEDVIS_SUBMIT_TEXT[context.provider ?? 'seedvis']
  const spec = context.model ? routeOf(context.model) : null
  const modelName = spec ? spec.name : context.model || 'model này'
  const modeName = !context.mode ? 'này' : Object.hasOwn(MODE_NAMES, context.mode) ? seedvisModeName(spec, context.mode) : context.mode
  const finish = (text: string, cls: MappedError['class'] = 'error', retry: MappedError['retry'] = 'none', detail = message): MappedError => ({
    text: context.provider === 'seedvis-dev' ? seedvisDevWording(text) : text,
    detail, class: cls, code, retry,
  })
  const uncertain = (retry: MappedError['retry'], detail = message) =>
    finish(context.gateClosed ? words.unverifiable : words.unknown, 'uncertain', context.gateClosed ? 'none' : retry, detail)
  const jobState = statusOf(json)
  /** A job body that says the job ended (`failed`, incl. failed + cancelled): seedvis's own final word on it. */
  const ended = (): MappedError => {
    if (jobState === 'cancelled') return finish(SEEDVIS_TEXT.cancelled, 'cancelled')
    if (code === 'not_started') return finish(SEEDVIS_TEXT.notStarted, 'error', 'new-take')
    if (code === 'insufficient_credits') return finish(SEEDVIS_TEXT.insufficientCredits)
    if (code === 'generation_failed' || code === 'timeout') return finish(seedvisFailureText(message))
    return finish(seedvisRemoteText(message))
  }

  if (phase === 'cancel') return finish(code === 'not_cancellable' ? SEEDVIS_TEXT.cancelRunning : SEEDVIS_TEXT.cancelUnknown, 'processing', 'cancel')
  if (phase === 'poll') {
    if (status === 401 || status === 403) return finish(SEEDVIS_TEXT.keyRequired, 'held')
    // §6.9 / §7.5: only a job body that says `failed` ends a paid take. 404 / 429 / 5xx, any other status, HTML or empty
    // bodies, a running or unknown state: keep polling with back-off (isJobNotFound + A2 decide a real not-found).
    if (status !== 404 && status !== 429 && status < 500 && (jobState === 'failed' || jobState === 'cancelled')) return ended()
    return finish(SEEDVIS_TEXT.pollWaiting, 'processing', 'poll')
  }

  // Submit (§7.3). Priority rule (step 7, M6): after any `sent: true`, only success or uncertain, and the gated
  // schedule continues whatever the re-send was answered — except moderation, never re-sent automatically.
  if (context.priorSent) return uncertain(moderation ? 'none' : 'same-key-gated')
  if (status >= 200 && status < 300) {
    // Step 5: `failed` in an accepted body maps by error.code; any other 2xx without a readable job may have created
    // (and billed) one — uncertain, never a final error that would invite a new key.
    return jobState === 'failed' || jobState === 'cancelled' ? ended() : uncertain('same-key-gated', message || SEEDVIS_TEXT.invalidResponse)
  }
  if (code === 'idempotency_conflict' || status === 409) return uncertain('none')
  if (status === 401) return finish(SEEDVIS_TEXT.keyRequired)
  if (status === 402 || code === 'insufficient_credits') return finish(SEEDVIS_TEXT.insufficientCredits)
  if (status === 403) return finish(seedvisPermissionText(modelName))
  if (code === 'model_not_found' || code === 'model_maintenance') return finish(seedvisModelText(modelName))
  if (!INPUT_REFUSAL.includes(code) && (status === 429 || code === 'server_busy' || (status === 422 && SLOTS_FULL.test(message)))) {
    return finish(SEEDVIS_TEXT.busy, 'deferred', 'queue')
  }
  // Step 6: a lost answer (status 0: network error after sending, no answer in time) or a 5xx.
  if (status === 0 || status >= 500) return uncertain(moderation ? 'none' : 'same-key-gated')
  if (code === 'invalid_image') return finish(seedvisImageText(fieldToSlot(field)))
  if (code === 'image_rule') return finish(seedvisImageRuleText(modeName, modelName, message))
  if (moderation) return finish(SEEDVIS_TEXT.contentPolicy)
  if (code === 'invalid_value' || code === 'validation_error') return finish(seedvisParameterText(message))
  return finish(seedvisRemoteText(message))
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

/** What a /models read says: the built-in routes it lists, narrowed. 'none' = unreadable (no limits known). */
export interface SeedvisModelLimits {
  source: 'server' | 'none'
  routes: Partial<Record<SeedvisModelId, SeedvisRouteSpec>>
}

// A /models list element as a number (5, '5', '5s', {value: '8s'}) or a lower-case word ('16:9', {value: '1080p'}).
const listed = (value: unknown): unknown => Object.hasOwn(record(value), 'value') ? record(value).value : value
const numberOf = (value: unknown): number | null => {
  const raw = listed(value)
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const m = typeof raw === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*s?\s*$/i.exec(raw) : null
  return m ? Number(m[1]) : null
}
const wordOf = (value: unknown): string | null => {
  const raw = listed(value)
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null
}
/**
 * The built-in values the server lists. Nothing readable, or no overlap (a shape or encoding surprise) → the built-in
 * list unchanged: a surprise never blocks every run, and seedvis itself refuses (unbilled) what it does not take.
 */
function narrowed<T, K>(builtIn: readonly T[], list: unknown[] | null, key: (value: T) => K, read: (value: unknown) => K | null): T[] {
  if (!list) return [...builtIn]
  const values = new Set<K | null>(list.map(read))
  values.delete(null)
  const kept = builtIn.filter(value => values.has(key(value)))
  return kept.length ? kept : [...builtIn]
}

/** Parse the two documented /models shapes. Pure narrowing; freshness/firmness belongs to A2. */
export function limitsFromModels(json: unknown): SeedvisModelLimits {
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
    const listedRequests = builtIn.requests.flatMap(route => {
      const mode = modes.find(m => m?.name === route.remoteMode)
      if (!mode) return []
      const minImages = Math.max(route.minImages, mode.min ?? route.minImages)
      const maxImages = Math.min(route.maxImages, mode.max ?? route.maxImages)
      return minImages <= maxImages ? [{ ...route, minImages, maxImages }] : []
    })
    // No listed mode we know (renamed modes, disjoint image ranges): the same rule as the parameters below.
    const requests = listedRequests.length ? listedRequests : [...builtIn.requests]
    const allowed = (field: string): unknown[] | null => {
      const value = params[field], spec = record(value)
      return Array.isArray(value) ? value : Array.isArray(spec.enum) ? spec.enum : Array.isArray(spec.values) ? spec.values : null
    }
    const promptLimit = record(params.prompt).max_length ?? record(params.prompt).maxLength ?? model.prompt_limit
    routes[builtIn.id] = {
      ...builtIn, requests, modes: builtIn.modes.filter(mode => requests.some(r => r.mode === mode)),
      durations: narrowed(builtIn.durations, allowed('duration'), n => n, numberOf),
      ratios: narrowed(builtIn.ratios, allowed('aspect_ratio'), r => r.toLowerCase(), wordOf),
      resolutions: builtIn.family !== 'veo' ? [...builtIn.resolutions]
        : narrowed(builtIn.resolutions, allowed('upscale_video'), (r): string => builtIn.upscaleVideo[r] ?? '', wordOf),
      promptLimit: Number.isSafeInteger(promptLimit) && Number(promptLimit) > 0 ? Math.min(builtIn.promptLimit, Number(promptLimit)) : builtIn.promptLimit,
    }
  }
  return { source: 'server', routes }
}

/**
 * SettingsLimits.issues of §7.8 (rule 9, the settings editor): the refusals of `s` per a /models read, each tagged
 * with its field, in the submit's order. 'none' → [] (like canvasapp); a seedvis model the read does not list →
 * {field: 'model'} (maintenance or not in the plan). Pure; `firm` (time) and prices stay with A2 / §7.9.
 */
export function issuesFor(limits: SeedvisModelLimits, s: LimitedSettings): SettingsIssue[] {
  const builtIn = routeOf(s.model)
  if (!builtIn) return [{ field: 'model', reason: NOT_SEEDVIS }]
  if (limits.source !== 'server') return []
  const spec = Object.hasOwn(limits.routes, builtIn.id) ? limits.routes[builtIn.id] : undefined
  if (!spec) return [{ field: 'model', reason: seedvisModelOffText(builtIn.name) }]
  return settingsIssues(s, spec)
}
