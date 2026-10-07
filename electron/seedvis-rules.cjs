// seedvis.com desktop gateway — the pure rules of electron/seedvis.cjs (seedvis plan v3.1 §10, §15).
//
// Everything that decides what may leave the computer, and what the page may learn, lives here:
//   - the route allowlist: main builds every URL from a symbolic route (models, account.info, account.usage,
//     generations.create / get / cancel) — the page never names a URL, a host, a header or a query;
//   - the submit allowlist: the three video models (never Omni Flash), their modes, fields, durations, ratios, image
//     counts and sizes, count 1, a UUID Idempotency-Key — anything else (video, mask, webhook, callback, aliases,
//     unknown keys) is refused before a byte is sent;
//   - the request body: fixed key order and scene-neutral file names, so the same take always sends the same bytes;
//   - the API key header only for the exact origin https://seedvis.com (never cdn.seedvis.com, never a redirect hop);
//   - downloads only from URLs main read from a seedvis answer: https, default port, no credentials, no local /
//     private / IP-literal host, ≤ 3 redirects, each hop checked; the type is sniffed from the first bytes;
//   - secret redaction (the exact stored key, Bearer, sv_live_ / sv_test_, header values, signed URL queries) and
//     account-info sanitizing (never the e-mail, never the account id);
//   - the upload clock of a submit: when it may have reached seedvis (`sent`), the earliest moment its last byte can
//     have left (`lastByteAt`), the stall / answer / same-key deadline aborts; main never re-sends;
//   - the request lanes (api 3, submit 2, download 2, ≤ 64 MiB of bodies in flight, Retry-After blocks, the submit
//     breaker, same-key coalescing), the video download sessions, and the close guard.
//
// No require (main, seedvis.cjs and the tests share it; app.asar cannot resolve npm helpers from electron/), no
// Electron, no fs, no Buffer, no process: every effect is injected. Never logs. The API key only ever comes in as the
// `secret` argument of redactSecrets / sanitizeApiJson, to be removed.
'use strict'

// ---------------------------------------------------------------------------------------------------------------
// Constants (mirror src/providers/seedvis/contract.ts and src/core/seedvisRoutes.ts — seedvisRoutesParity.test.ts)
// ---------------------------------------------------------------------------------------------------------------

const SEEDVIS_ORIGIN = 'https://seedvis.com'
const SEEDVIS_API_BASE = '/api/v1'
/** In-memory partition (no "persist:"): no cookie, cache or storage of seedvis ever reaches the disk. */
const SEEDVIS_PARTITION = 'sanovids-seedvis'
/** Result hosts seen in seedvis' docs. Log-only until the live test confirms them: never an allowlist (R13). */
const SEEDVIS_CDN_HOSTS = Object.freeze(['cdn.seedvis.com'])
/** "Nạp credit trên seedvis.com" (no top-up API). TODO(wave C): the real top-up page from the support answer. */
const SEEDVIS_BILLING_URL = 'https://seedvis.com/'

const MIB = 1024 * 1024
const SEEDVIS_IMAGE_LIMITS = Object.freeze({
  maxImages: 10,
  maxImageBytes: 20 * MIB,
  maxBase64Bytes: 40 * MIB,
  preparedBase64Bytes: 39 * MIB,
  formats: Object.freeze(['image/png', 'image/jpeg', 'image/webp']),
})
const SEEDVIS_IPC_LIMITS = Object.freeze({
  bodyBytes: 256 * 1024,
  jsonBytes: 2 * MIB,
  videoBytes: 1024 * MIB,
  imageBytes: 50 * MIB,
  chunkBytes: 4 * MIB,
  inFlightBytes: 64 * MIB,
  promptChars: 20_000,
  idChars: 100,
  pathChars: 300,
})
const SEEDVIS_RESPONSE_HEADERS = Object.freeze(['Retry-After', 'Idempotency-Replayed', 'X-Request-Id'])
const SEEDVIS_ACCOUNT_INFO_FIELDS = Object.freeze([
  'plan',
  'api_enabled',
  'credit_balance',
  'concurrency_limit',
  'queue_limit',
  'rate_limit_per_minute',
  'poll_rate_limit_per_minute',
  'poll_rate_limit_per_job_per_minute',
])
const SEEDVIS_ACCOUNT_USAGE_FIELDS = Object.freeze(['requests_today', 'requests_this_month', 'requests_total', 'credit_balance'])

/** Answer wait after the last byte of a video submit (contract SEEDVIS_ANSWER_WAIT_MS; seedvis answers `queued` at once). */
const SEEDVIS_ANSWER_WAIT_MS = 45_000
const SEEDVIS_TIMEOUTS = Object.freeze({
  /** A GET / cancel, from when it is sent. */
  apiMs: 60_000,
  /** The key check of "Dán key" (GET /account/info with the candidate key). */
  verifyMs: 20_000,
  /** No upload progress for this long while the body is not fully sent → aborted. */
  uploadStallMs: 60_000,
  answerWaitMs: SEEDVIS_ANSWER_WAIT_MS,
  /** Without upload progress information: 45 s + bytes ÷ 32 KiB/s, then aborted as "may have arrived". */
  noProgressBps: 32 * 1024,
  /** Reading a JSON answer once its headers arrived. */
  bodyReadMs: 30_000,
  progressPollMs: 250,
})
/** Requests in flight at once, per lane — separate from canvasapp's lanes. */
const SEEDVIS_LANE_SIZE = Object.freeze({ api: 3, submit: 2, download: 2 })
/** Submits per rolling minute: min(account rate_limit_per_minute, this). */
const SEEDVIS_SUBMIT_BREAKER_MAX = 30
const SEEDVIS_RETRY_AFTER_MIN_MS = 1000
const SEEDVIS_RETRY_AFTER_MAX_MS = 300_000
/** Generations whose output URLs main remembers (downloads only ever use these). */
const SEEDVIS_OUTPUTS_MAX = 256
const SEEDVIS_OUTPUTS_PER_JOB = 8
const SEEDVIS_REDIRECT_MAX = 3
const SEEDVIS_URL_MAX = 4096

const SEEDVIS_DOWNLOAD_LIMITS = Object.freeze({
  maxBytes: SEEDVIS_IPC_LIMITS.videoBytes,
  chunkBytes: SEEDVIS_IPC_LIMITS.chunkBytes,
  flushMs: 1000,
  headersMs: 60_000,
  idleMs: 60_000,
  pullIdleMs: 10 * 60_000,
  maxMs: 60 * 60_000,
  maxSessions: 16,
  /** Bytes read before open() answers, to sniff the video type. */
  sniffBytes: 16,
})
/** Download ids are chosen by main (crypto.randomUUID()). */
const SEEDVIS_DOWNLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/
/** Idempotency-Key: a canonical lowercase UUID (src/lib/uuidKey.ts uuidFromKey). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ---------------------------------------------------------------------------------------------------------------
// Fixed texts (Vietnamese; never an exception message, never a value from the network)
// ---------------------------------------------------------------------------------------------------------------

const SEEDVIS_TEXTS = Object.freeze({
  notAllowed: 'Nguồn gọi không hợp lệ.',
  badRequest: 'Yêu cầu tới seedvis không hợp lệ — chưa gửi gì, không bị trừ credit.',
  omniFlash: 'SanoVids không dùng Omni Flash — chưa gửi gì, không bị trừ credit.',
  tooLarge: 'Ảnh gửi kèm quá lớn cho seedvis (tổng hơn 39 MB sau mã hoá) — chưa gửi gì, không bị trừ credit.',
  quitting: 'SanoVids đang thoát — chưa gửi tới seedvis, không bị trừ credit.',
  offline: 'Máy đang mất mạng — chưa gửi tới seedvis, không bị trừ credit.',
  notSent: 'Không kết nối được tới seedvis.com — chưa gửi gì, không bị trừ credit.',
  uploadStalled: 'Mạng chậm hoặc mất khi đang tải ảnh lên seedvis — chưa gửi gì, không bị trừ credit.',
  deadline: 'Không gửi kịp trong thời gian gửi lại an toàn — SanoVids dừng lần gửi này trước khi seedvis nhận đủ.',
  lostAnswer: 'Mất kết nối sau khi đã gửi yêu cầu tới seedvis — seedvis có thể đã nhận (và trừ credit).',
  answerTimeout: 'seedvis chưa trả lời sau khi nhận đủ yêu cầu — seedvis có thể đã nhận (và trừ credit).',
  redirect: 'seedvis.com chuyển hướng yêu cầu — SanoVids không đi theo.',
  badResponse: 'seedvis.com trả về câu trả lời lạ.',
  rateLimited: 'seedvis đang giới hạn số yêu cầu — SanoVids thử lại sau (chưa gửi gì lần này).',
  breaker: 'Đã gửi nhiều yêu cầu tới seedvis trong một phút — SanoVids gửi tiếp sau (chưa gửi gì lần này).',
  conflict: 'Cùng mã gửi nhưng nội dung khác đang được gửi tới seedvis — SanoVids không gửi bản này.',
  apiTimeout: 'seedvis.com không phản hồi (quá thời gian chờ).',
  apiNetwork: 'Không kết nối được tới seedvis.com.',
  unknownOutput: 'SanoVids chưa có link video này từ seedvis — hỏi lại trạng thái job trước khi tải.',
  expiredLink: 'Link video trên seedvis không còn dùng được (hết hạn hoặc bị từ chối).',
  notVideo: 'seedvis trả về một tệp không phải video.',
  downloadRefused: 'Link video của seedvis trỏ tới một địa chỉ SanoVids không tải (không phải https công khai).',
  downloadBusy: 'Đang tải quá nhiều video cùng lúc — SanoVids tải video này sau.',
  downloadOver: 'Lượt tải video này đã kết thúc.',
  downloadReadBusy: 'Lượt tải video này đang mở hoặc đang được đọc.',
  error: 'Lỗi nội bộ của SanoVids khi gọi seedvis.',
})

/** "@image_2", "khung đầu", "khung cuối" for an image field + index. */
function imageSlotText(field, index) {
  if (field === 'image') return 'khung đầu'
  if (field === 'lastFrame') return 'khung cuối'
  return `@image_${(Number.isSafeInteger(index) && index >= 0 ? index : 0) + 1}`
}

/** { ok: false, code, message, ...extra } — the one failure shape every IPC answer uses. */
function failure(code, message, extra) {
  const out = { ok: false, code, message: typeof message === 'string' ? message : SEEDVIS_TEXTS.error }
  if (extra && typeof extra === 'object') {
    if (typeof extra.sent === 'boolean') out.sent = extra.sent
    if (Number.isFinite(extra.retryAfterMs) && extra.retryAfterMs > 0) out.retryAfterMs = Math.round(extra.retryAfterMs)
    if (extra.lastByteAt === null || Number.isFinite(extra.lastByteAt)) out.lastByteAt = extra.lastByteAt
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/** UTF-8 length of a string (no TextEncoder / Buffer needed). */
function utf8Length(s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
      } else n += 3
    } else n += 3
  }
  return n
}

/** Characters of base64 text for `n` bytes (seedvis counts the base64 text against its 40 MiB). */
function base64Length(n) {
  return Number.isSafeInteger(n) && n > 0 ? 4 * Math.ceil(n / 3) : 0
}

function isBytes(v) {
  return v instanceof Uint8Array
}

// ---------------------------------------------------------------------------------------------------------------
// Routes (symbolic → URL) and the URL allowlist of the partition's webRequest layer
// ---------------------------------------------------------------------------------------------------------------

/** Same table as contract.ts SEEDVIS_IPC_ROUTES (+ the lane). Main builds paths; `{id}` is the only variable part. */
const SEEDVIS_ROUTES = Object.freeze({
  models: Object.freeze({ method: 'GET', path: '/models', lane: 'api' }),
  'account.info': Object.freeze({ method: 'GET', path: '/account/info', lane: 'api' }),
  'account.usage': Object.freeze({ method: 'GET', path: '/account/usage', lane: 'api' }),
  'generations.create': Object.freeze({ method: 'POST', path: '/developer/generations', lane: 'submit' }),
  'generations.get': Object.freeze({ method: 'GET', path: '/developer/generations/{id}?wait=0', lane: 'api' }),
  'generations.cancel': Object.freeze({ method: 'POST', path: '/developer/generations/{id}/cancel', lane: 'api' }),
})

/**
 * A symbolic request → { name, method, lane, url, hasId } or null. `id` only for the two job routes ([A-Za-z0-9_-],
 * ≤ 100); any other route must come without one. The page never sends a path.
 */
function matchSeedvisRoute(req) {
  if (!isPlainObject(req) || typeof req.route !== 'string' || !hasOwn(SEEDVIS_ROUTES, req.route)) return null
  const r = SEEDVIS_ROUTES[req.route]
  const hasId = r.path.includes('{id}')
  if (hasId) {
    if (typeof req.id !== 'string' || !ID_RE.test(req.id)) return null
  } else if (req.id !== undefined) return null
  const path = SEEDVIS_API_BASE + (hasId ? r.path.replace('{id}', req.id) : r.path)
  if (path.length > SEEDVIS_IPC_LIMITS.pathChars) return null
  return { name: req.route, method: r.method, lane: r.lane, url: SEEDVIS_ORIGIN + path, hasId }
}

/**
 * The second layer (session webRequest): which allowlisted route a request to `rawUrl` is, or null. Exact origin,
 * path under /api/v1, the route's method, `?wait=0` exactly on a job poll and no query anywhere else, no fragment.
 */
function matchSeedvisUrl(method, rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > SEEDVIS_URL_MAX) return null
  let u
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (u.origin !== SEEDVIS_ORIGIN || u.username || u.password || u.hash) return null
  if (!u.pathname.startsWith(SEEDVIS_API_BASE + '/') || u.pathname.length > SEEDVIS_IPC_LIMITS.pathChars) return null
  const p = u.pathname.slice(SEEDVIS_API_BASE.length)
  const m = String(method || '').toUpperCase()
  const job = /^\/developer\/generations\/([A-Za-z0-9_-]{1,100})(\/cancel)?$/.exec(p)
  if (job) {
    if (job[2]) return m === 'POST' && u.search === '' ? 'generations.cancel' : null
    return m === 'GET' && u.search === '?wait=0' ? 'generations.get' : null
  }
  if (u.search !== '') return null
  for (const name of ['models', 'account.info', 'account.usage', 'generations.create']) {
    const r = SEEDVIS_ROUTES[name]
    if (r.path === p && r.method === m) return name
  }
  return null
}

/** "Authorization: Bearer …" only to exactly https://seedvis.com (no subdomain — cdn.seedvis.com included —, no port). */
function authHeadersAllowed(rawUrl) {
  try {
    const u = new URL(String(rawUrl))
    return u.origin === SEEDVIS_ORIGIN && !u.username && !u.password
  } catch {
    return false
  }
}

const SECRET_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'cookie']

/**
 * Header names to delete from a request to `rawUrl` (session onBeforeSendHeaders, every redirect hop included):
 * Cookie, X-API-Key and x-goog-api-key always; Authorization unless authHeadersAllowed. Case-insensitive.
 */
function headersToStrip(rawUrl, names) {
  const keepAuth = authHeadersAllowed(rawUrl)
  return (Array.isArray(names) ? names : []).filter((n) => {
    const k = String(n).toLowerCase()
    if (!SECRET_HEADERS.includes(k)) return false
    return !(k === 'authorization' && keepAuth)
  })
}

/**
 * The partition's onBeforeRequest: 'allow' an allowlisted API route, or a GET of a download URL main itself read from
 * a seedvis answer (or a redirect hop it checked); 'cancel' anything else.
 */
function webRequestVerdict(details, isDownloadUrl) {
  const url = details && typeof details.url === 'string' ? details.url : ''
  const method = details && typeof details.method === 'string' ? details.method.toUpperCase() : ''
  if (matchSeedvisUrl(method, url)) return 'allow'
  if (method === 'GET' && outputUrlAllowed(url) && typeof isDownloadUrl === 'function' && isDownloadUrl(normalizeUrl(url))) return 'allow'
  return 'cancel'
}

/** The WHATWG serialization of a URL (what webRequest reports), or ''. */
function normalizeUrl(raw) {
  try {
    return new URL(String(raw)).href
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Submit allowlist and body
// ---------------------------------------------------------------------------------------------------------------

const SEEDANCE_RATIOS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
const SEEDANCE_MODES = Object.freeze({
  'text-to-video': Object.freeze([]),
  'image-to-video': Object.freeze([Object.freeze({ field: 'reference_images', min: 1, max: 10 })]),
})

/**
 * The three video models (seedvis remote ids), their modes and the image fields each mode takes. Omni Flash and every
 * other model are refused. Mirrors src/core/seedvisRoutes.ts SEEDVIS_ROUTE_TABLE (parity test).
 */
const SEEDVIS_SUBMIT_MODELS = Object.freeze({
  'seedance_2.5': Object.freeze({ durations: Object.freeze([5, 10, 15, 20, 25, 30]), ratios: SEEDANCE_RATIOS, upscale: null, modes: SEEDANCE_MODES }),
  'seedance_2.0_fast': Object.freeze({ durations: Object.freeze([5, 10, 15]), ratios: SEEDANCE_RATIOS, upscale: null, modes: SEEDANCE_MODES }),
  'Veo-3.1': Object.freeze({
    durations: Object.freeze(['4s', '6s', '8s']),
    ratios: Object.freeze(['16:9', '9:16']),
    upscale: Object.freeze(['none', '1080p']),
    modes: Object.freeze({
      'text-to-video': Object.freeze([]),
      'image-to-video': Object.freeze([Object.freeze({ field: 'image', min: 1, max: 1 })]),
      'multi-image-to-video': Object.freeze([Object.freeze({ field: 'referenceImages', min: 1, max: 3 })]),
      'batch-frame': Object.freeze([Object.freeze({ field: 'image', min: 1, max: 1 }), Object.freeze({ field: 'lastFrame', min: 1, max: 1 })]),
    }),
  }),
})

/** Body keys, in the order they are sent. upscale_video only for Veo. Nothing else is ever sent. */
const BODY_KEYS = Object.freeze(['model', 'mode', 'prompt', 'aspect_ratio', 'duration', 'upscale_video', 'count'])
/** Image fields, in the order they are sent. */
const IMAGE_FIELDS = Object.freeze(['reference_images', 'referenceImages', 'image', 'lastFrame'])
const ARRAY_FIELDS = Object.freeze(['reference_images', 'referenceImages'])
const EXT_OF_MIME = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })

/** PNG / JPEG / WebP by their magic bytes, else null. */
function sniffImage(bytes) {
  if (!isBytes(bytes) || bytes.byteLength < 12) return null
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

/**
 * The video type from its first bytes (never from the CDN's Content-Type: an MP4 sent as application/octet-stream
 * must not be saved as .webm): ISO BMFF `ftyp` → 'video/quicktime' for the QuickTime brand, else 'video/mp4';
 * EBML → 'video/webm'; anything else → null.
 */
function sniffMedia(bytes) {
  if (!isBytes(bytes) || bytes.byteLength < 12) return null
  const b = bytes
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11])
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'
  return null
}

/** Key names from the page are shown in a refusal: letters, digits, _ . - only, ≤ 40 characters. */
const fieldName = (k) => String(k).replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 40)

/**
 * A generations.create request from the page → { ok: true, value: { idempotencyKey, body, images, mustFinishBy } }
 * (normalized: body keys in BODY_KEYS order, images sorted by field then index) or { ok: false, code, message }
 * (code bad-request | bad-image | too-large). Nothing is sent for a refusal.
 */
function checkSubmit(req) {
  const bad = (message) => ({ ok: false, code: 'bad-request', message: message || SEEDVIS_TEXTS.badRequest })
  if (!isPlainObject(req) || req.route !== 'generations.create') return bad()
  for (const k of Object.keys(req)) {
    if (!['route', 'idempotencyKey', 'body', 'images', 'mustFinishBy'].includes(k)) return bad()
  }
  if (typeof req.idempotencyKey !== 'string' || !UUID_RE.test(req.idempotencyKey)) return bad('Thiếu mã gửi (Idempotency-Key) hợp lệ — chưa gửi gì, không bị trừ credit.')
  let mustFinishBy
  if (req.mustFinishBy !== undefined) {
    if (typeof req.mustFinishBy !== 'number' || !Number.isFinite(req.mustFinishBy) || req.mustFinishBy <= 0) return bad()
    mustFinishBy = req.mustFinishBy
  }
  const b = req.body
  if (!isPlainObject(b)) return bad()
  for (const k of Object.keys(b)) {
    if (!BODY_KEYS.includes(k)) return bad(`seedvis: SanoVids không gửi trường “${fieldName(k)}” — chưa gửi gì, không bị trừ credit.`)
  }
  if (typeof b.model === 'string' && /omni/i.test(b.model)) return bad(SEEDVIS_TEXTS.omniFlash)
  if (typeof b.model !== 'string' || !hasOwn(SEEDVIS_SUBMIT_MODELS, b.model)) return bad()
  const spec = SEEDVIS_SUBMIT_MODELS[b.model]
  if (typeof b.mode !== 'string' || !hasOwn(spec.modes, b.mode)) return bad()
  if (typeof b.prompt !== 'string' || b.prompt.trim() === '' || b.prompt.length > SEEDVIS_IPC_LIMITS.promptChars) return bad()
  if (b.count !== 1) return bad()
  if (typeof b.aspect_ratio !== 'string' || !spec.ratios.includes(b.aspect_ratio)) return bad()
  if (!spec.durations.includes(b.duration)) return bad()
  if (spec.upscale) {
    if (typeof b.upscale_video !== 'string' || !spec.upscale.includes(b.upscale_video)) return bad()
  } else if (b.upscale_video !== undefined) return bad()

  const body = {}
  for (const k of BODY_KEYS) if (b[k] !== undefined) body[k] = b[k]
  if (utf8Length(JSON.stringify(body)) > SEEDVIS_IPC_LIMITS.bodyBytes) return bad()

  // images: ≤ 10, the mode's fields only, indexes 0..n-1 per field, PNG / JPEG / WebP by their bytes, ≤ 20 MiB each,
  // ≤ 39 MiB of base64 in total
  const raw = req.images === undefined ? [] : req.images
  if (!Array.isArray(raw) || raw.length > SEEDVIS_IMAGE_LIMITS.maxImages) return bad()
  const rules = spec.modes[b.mode]
  const allowed = rules.map((r) => r.field)
  const images = []
  let base64 = 0
  for (const img of raw) {
    if (!isPlainObject(img)) return bad()
    for (const k of Object.keys(img)) if (!['field', 'index', 'mime', 'bytes'].includes(k)) return bad()
    if (typeof img.field !== 'string' || !allowed.includes(img.field)) return bad()
    if (!Number.isSafeInteger(img.index) || img.index < 0 || img.index >= SEEDVIS_IMAGE_LIMITS.maxImages) return bad()
    const slot = imageSlotText(img.field, img.index)
    if (!isBytes(img.bytes) || img.bytes.byteLength === 0) return bad()
    if (!SEEDVIS_IMAGE_LIMITS.formats.includes(img.mime) || sniffImage(img.bytes) !== img.mime) {
      return { ok: false, code: 'bad-image', message: `Ảnh ${slot} không phải PNG/JPEG/WebP đúng định dạng — chưa gửi gì, không bị trừ credit.` }
    }
    if (img.bytes.byteLength > SEEDVIS_IMAGE_LIMITS.maxImageBytes) {
      return { ok: false, code: 'bad-image', message: `Ảnh ${slot} lớn hơn 20 MB — seedvis không nhận. Chưa gửi gì, không bị trừ credit.` }
    }
    base64 += base64Length(img.bytes.byteLength)
    images.push({ field: img.field, index: img.index, mime: img.mime, bytes: img.bytes })
  }
  for (const r of rules) {
    const got = images.filter((i) => i.field === r.field).map((i) => i.index).sort((x, y) => x - y)
    if (got.length < r.min || got.length > r.max) return bad()
    for (let i = 0; i < got.length; i++) if (got[i] !== i) return bad()
  }
  if (base64 > SEEDVIS_IMAGE_LIMITS.preparedBase64Bytes) return { ok: false, code: 'too-large', message: SEEDVIS_TEXTS.tooLarge }
  images.sort((x, y) => IMAGE_FIELDS.indexOf(x.field) - IMAGE_FIELDS.indexOf(y.field) || x.index - y.index)
  return { ok: true, value: { idempotencyKey: req.idempotencyKey, body, images, mustFinishBy } }
}

/** Scene-neutral file name of an image (moving a scene never changes the body): image_3.png, frame_first.jpg, frame_last.webp. */
function imageFileName(field, index, mime) {
  const ext = EXT_OF_MIME[mime] || 'png'
  if (field === 'image') return `frame_first.${ext}`
  if (field === 'lastFrame') return `frame_last.${ext}`
  return `image_${index + 1}.${ext}`
}

/**
 * The JSON text of a checked submit (checkSubmit's value). Fixed key order (BODY_KEYS, then IMAGE_FIELDS), images as
 * { data: <base64>, file_name } — the same value always gives the same bytes (Idempotency-Key, plan M2).
 * `toBase64(bytes)` is injected (main: Buffer).
 */
function buildSubmitJson(value, toBase64) {
  const out = {}
  for (const k of BODY_KEYS) if (value.body[k] !== undefined) out[k] = value.body[k]
  for (const field of IMAGE_FIELDS) {
    const list = value.images.filter((i) => i.field === field)
    if (!list.length) continue
    const items = list.map((i) => ({ data: toBase64(i.bytes), file_name: imageFileName(i.field, i.index, i.mime) }))
    out[field] = ARRAY_FIELDS.includes(field) ? items : items[0]
  }
  return JSON.stringify(out)
}

// ---------------------------------------------------------------------------------------------------------------
// Answers: headers, Retry-After, outputs, sanitizing, redaction
// ---------------------------------------------------------------------------------------------------------------

/**
 * Retry-After (delta seconds or an HTTP date) → milliseconds clamped to 1–300 s, or null (missing / unreadable).
 */
function parseRetryAfter(value, now) {
  const s = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
  if (!s || s.length > 64) return null
  let ms
  if (/^\d{1,9}$/.test(s)) ms = Number(s) * 1000
  else {
    const at = Date.parse(s)
    if (!Number.isFinite(at) || !/[A-Za-z]/.test(s)) return null
    ms = at - (Number.isFinite(now) ? now : 0)
  }
  return Math.min(SEEDVIS_RETRY_AFTER_MAX_MS, Math.max(SEEDVIS_RETRY_AFTER_MIN_MS, Math.round(ms)))
}

/** The three response headers the page may see (contract SEEDVIS_RESPONSE_HEADERS), strictly shaped; `get(name)` reads one. */
function pickResponseHeaders(get) {
  const read = (n) => {
    try {
      const v = typeof get === 'function' ? get(n) : null
      return typeof v === 'string' ? v.trim() : null
    } catch {
      return null
    }
  }
  const out = {}
  const ra = read('retry-after')
  if (ra && ra.length <= 64 && /^[A-Za-z0-9 ,:-]+$/.test(ra)) out['Retry-After'] = ra
  const rep = read('idempotency-replayed')
  if (rep && /^(true|false)$/i.test(rep)) out['Idempotency-Replayed'] = rep.toLowerCase()
  const rid = read('x-request-id')
  if (rid && /^[A-Za-z0-9._:-]{1,128}$/.test(rid)) out['X-Request-Id'] = rid
  return out
}

/**
 * Is `raw` a URL main may download a result from (and follow a redirect to)? https, default port, no credentials,
 * a DNS name (never an IP literal), not localhost / *.localhost / *.local / *.internal / a single-label name. The CDN
 * host list is log-only (SEEDVIS_CDN_HOSTS): an unconfirmed CDN must never block a paid video.
 */
function outputUrlAllowed(raw) {
  if (typeof raw !== 'string' || raw.length > SEEDVIS_URL_MAX || /[\s\\\u0000-\u001f\u007f]/.test(raw)) return false
  let u
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '') return false
  const host = u.hostname.toLowerCase()
  if (!host || host.length > 253 || !host.includes('.') || host.endsWith('.')) return false
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return false // IP literals
  if (!/^[a-z0-9.-]+$/.test(host)) return false
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)) return false
  return true
}

/** Is `raw` on one of the CDN hosts seedvis documents? (for the log line only) */
function isKnownCdnHost(raw) {
  try {
    return SEEDVIS_CDN_HOSTS.includes(new URL(String(raw)).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** The host of a URL for a log line ("cdn.seedvis.com"), or '?' — never a path or a query. */
function hostOf(raw) {
  try {
    return new URL(String(raw)).hostname.toLowerCase().slice(0, 100) || '?'
  } catch {
    return '?'
  }
}

/**
 * A generation answer (create / get JSON) → { id, urls } — the job id when it is one, and the result URLs main may
 * download (outputUrlAllowed, ≤ 8, in order). Never trusts the shape.
 */
function outputsOf(json) {
  const d = isPlainObject(json) && isPlainObject(json.data) ? json.data : null
  if (!d) return { id: null, urls: [] }
  const id = typeof d.id === 'string' && ID_RE.test(d.id) ? d.id : null
  const urls = []
  for (const o of Array.isArray(d.outputs) ? d.outputs.slice(0, SEEDVIS_OUTPUTS_PER_JOB) : []) {
    const url = isPlainObject(o) && typeof o.url === 'string' ? o.url : null
    if (url && outputUrlAllowed(url)) urls.push(normalizeUrl(url))
  }
  return { id, urls }
}

/**
 * Removes secrets from a string for the page or a log: the exact stored key (literal match, whatever its shape),
 * "Bearer …", sv_live_ / sv_test_ keys, header values (Authorization / X-API-Key / x-goog-api-key / Cookie), and the
 * query / fragment of every http(s) URL (signed result links). ≤ 2000 characters.
 */
function redactSecrets(text, secret) {
  let s = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text)
  if (typeof secret === 'string' && secret.length >= 8) s = s.split(secret).join('***')
  s = s.replace(/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1')
  s = s.replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer ***')
  s = s.replace(/sv_(live|test)_[A-Za-z0-9_-]+/gi, 'sv_$1_***')
  // a header value runs to the end of its line (or quote): "Cookie: a=1; b=2" loses both cookies
  s = s.replace(/\b(authorization|x-api-key|x-goog-api-key|set-cookie|cookie)(["']?\s*[:=]\s*)[^\r\n"]*/gi, '$1$2***')
  return s.length > 2000 ? s.slice(0, 2000) : s
}

/**
 * A deep copy of an API answer for the page with every string redacted (redactSecrets: no signed URL query, no key).
 * Depth ≤ 24 (deeper values become null). The page never needs a result URL: downloads go through main by job id.
 */
function sanitizeApiJson(json, secret) {
  const walk = (v, depth) => {
    if (typeof v === 'string') return redactSecrets(v, secret)
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
    if (depth > 24 || typeof v !== 'object') return null
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
    const out = {}
    for (const k of Object.keys(v)) {
      if (k === '__proto__') continue
      out[redactSecrets(k, secret).slice(0, 200)] = walk(v[k], depth + 1)
    }
    return out
  }
  return walk(json, 0)
}

const numberOf = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^-?\d{1,12}(\.\d{1,6})?$/.test(v.trim())) return Number(v.trim())
  return null
}

/**
 * GET /account/info (2xx) → { success, data } with only SEEDVIS_ACCOUNT_INFO_FIELDS: plan as a name (≤ 60
 * characters), api_enabled, the balance (decimals tolerated) and the non-negative limits. Never the e-mail, the account
 * id or anything else.
 */
function sanitizeAccountInfo(json) {
  const env = isPlainObject(json) ? json : {}
  const d = isPlainObject(env.data) ? env.data : {}
  const out = {}
  const plan = typeof d.plan === 'string' ? d.plan : isPlainObject(d.plan) ? (typeof d.plan.name === 'string' ? d.plan.name : typeof d.plan.code === 'string' ? d.plan.code : null) : null
  if (plan && plan.trim()) out.plan = redactSecrets(plan.trim()).slice(0, 60)
  if (typeof d.api_enabled === 'boolean') out.api_enabled = d.api_enabled
  const balance = numberOf(d.credit_balance)
  if (balance !== null && Math.abs(balance) < 1e12) out.credit_balance = balance
  for (const k of SEEDVIS_ACCOUNT_INFO_FIELDS.slice(3)) {
    const n = numberOf(d[k])
    if (n !== null && n >= 0 && n < 1e9) out[k] = n
  }
  return { success: env.success === true, data: out }
}

/** GET /account/usage (2xx) → { success, data } with the counters, the balance and by_status (≤ 16 numeric entries). */
function sanitizeAccountUsage(json) {
  const env = isPlainObject(json) ? json : {}
  const d = isPlainObject(env.data) ? env.data : {}
  const out = {}
  for (const k of SEEDVIS_ACCOUNT_USAGE_FIELDS) {
    const n = numberOf(d[k])
    if (n !== null && Math.abs(n) < 1e12) out[k] = n
  }
  if (isPlainObject(d.by_status)) {
    const by = {}
    for (const k of Object.keys(d.by_status).slice(0, 16)) {
      const n = numberOf(d.by_status[k])
      if (/^[a-z_]{1,32}$/.test(k) && n !== null && n >= 0) by[k] = n
    }
    out.by_status = by
  }
  return { success: env.success === true, data: out }
}

/** Log label of a route (a fixed set: never a job id). */
function routeLabel(name) {
  return hasOwn(SEEDVIS_ROUTES, name) ? name : 'request'
}

/** "[SanoVids] seedvis <route> <status|code> <ms>ms" — only fixed words and numbers. */
function logLine(route, outcome, ms) {
  const o = typeof outcome === 'number' && Number.isSafeInteger(outcome) ? String(outcome) : /^[a-z][a-z0-9-]{0,40}$/.test(String(outcome)) ? String(outcome) : 'error'
  const t = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0
  return `[SanoVids] seedvis ${routeLabel(route)} ${o} ${t}ms`
}

// ---------------------------------------------------------------------------------------------------------------
// The upload clock of a submit (when it may have reached seedvis)
// ---------------------------------------------------------------------------------------------------------------

/** Net errors that happen before any byte of the request is written (DNS, connect, proxy, TLS, our own block). */
const PRE_SEND_NET_ERRORS = Object.freeze([
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_ADDRESS_INVALID',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_BLOCKED_BY_CLIENT',
  'ERR_NETWORK_ACCESS_DENIED',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID',
  'ERR_CERT_DATE_INVALID',
  'ERR_SSL_PROTOCOL_ERROR',
])

/** The Chromium net error name in an error text ("net::ERR_…"), or null. */
function netErrorName(text) {
  const m = /\b(ERR_[A-Z0-9_]{2,60})\b/.exec(String(text || ''))
  return m ? m[1] : null
}

/** An error that proves nothing of the request was written (so it cannot have reached seedvis). */
function preSendNetError(text) {
  const n = netErrorName(text)
  return !!n && PRE_SEND_NET_ERRORS.includes(n)
}

/** An error that means "no network" (said as offline, never "sent"). */
function offlineNetError(text) {
  const n = netErrorName(text)
  return n === 'ERR_INTERNET_DISCONNECTED' || n === 'ERR_NETWORK_CHANGED'
}

/**
 * How old a progress sample may be: Chromium's network service reports upload progress every ~100 ms and the answer
 * crosses a process boundary — a sample saying "incomplete" proves only that the body was incomplete this long before.
 */
const SEEDVIS_PROGRESS_STALE_MS = 1000
/** Bytes the network may still push before an abort lands (beyond the measured / assumed rate). */
const SEEDVIS_ABORT_SLACK_BYTES = 256 * 1024
const SEEDVIS_ABORT_FLOOR_BPS = MIB

/**
 * The clock of one submit, fed with ClientRequest.getUploadProgress() samples ({ active, started, current, total }).
 *   o: { total (body bytes), startedAt, mustFinishBy?, stallMs, answerWaitMs, noProgressBps }
 * Only samples with active: true count (the loader exists); progress is trusted once one arrived — an Electron that
 * never reports progress gets the plain timeout and every abort counts as "may have arrived".
 *   check(t)        → null | 'deadline' | 'stall' | 'answer-timeout' | 'no-progress-timeout' (abort now)
 *   abortSent(p, t) → may the body have reached seedvis if main aborts now? p = a sample taken right before aborting.
 *                     false only when more bytes were left than the network could still push before the abort lands
 *                     and the sample was taken: 256 KiB + (time since the sample + 1 s + 1 s staleness) at
 *                     max(4 × measured rate, 1 MiB/s). A small body is therefore never "not sent" on an abort: wrong
 *                     "not sent" could charge twice, wrong "may have arrived" only asks the user to check first.
 *   errorSent(text, t) → the same for a request that failed by itself (pre-send net errors → false).
 *   lastByteAt()    → a LOWER bound of when the last byte left (the last report of an incomplete body, minus its
 *                     staleness; never later than the real moment — the same-key gate measures the key memory from
 *                     it); null without progress.
 *   uploadMs(t)     → an UPPER bound of the upload time (the rate measured from it is never too high).
 */
function createUploadClock(o) {
  const total = Number.isSafeInteger(o.total) && o.total > 0 ? o.total : 0
  const startedAt = o.startedAt
  const stallMs = o.stallMs || SEEDVIS_TIMEOUTS.uploadStallMs
  const answerWaitMs = o.answerWaitMs || SEEDVIS_ANSWER_WAIT_MS
  const noProgressBps = o.noProgressBps || SEEDVIS_TIMEOUTS.noProgressBps
  const mustFinishBy = Number.isFinite(o.mustFinishBy) ? o.mustFinishBy : null
  let trusted = false
  let started = false
  let current = 0
  let lastSampleAt = startedAt
  let lastProgressAt = startedAt
  let incompleteAt = startedAt // last moment the body was known NOT fully sent
  let completeAt = null // first sample that showed it complete
  let answeredAt = null
  let firstByteAt = null

  function rate() {
    if (firstByteAt === null || current <= 0) return 0
    const ms = Math.max(1, lastProgressAt - firstByteAt)
    return (current * 1000) / ms
  }

  /** The body was reported incomplete at `t`: it was incomplete at t − staleness at the latest. */
  const seenIncomplete = (t) => {
    incompleteAt = Math.max(incompleteAt, t - SEEDVIS_PROGRESS_STALE_MS)
  }

  function sample(p, t) {
    // after the answer (or once complete) the loader may be gone: such samples say nothing
    if (!p || typeof p !== 'object' || completeAt !== null || answeredAt !== null || p.active !== true) return
    trusted = true
    lastSampleAt = t
    if (p.started !== true) {
      seenIncomplete(t)
      return
    }
    if (!started) {
      started = true
      lastProgressAt = t
    }
    const cur = Number.isSafeInteger(p.current) && p.current >= 0 ? p.current : 0
    if (cur > current) {
      if (firstByteAt === null) firstByteAt = incompleteAt
      current = cur
      lastProgressAt = t
    }
    if (total > 0 && current >= total) completeAt = t
    else seenIncomplete(t)
  }

  function margin(t) {
    const bps = Math.max(4 * rate(), SEEDVIS_ABORT_FLOOR_BPS)
    return SEEDVIS_ABORT_SLACK_BYTES + ((Math.max(0, t - lastSampleAt) + 1000 + SEEDVIS_PROGRESS_STALE_MS) * bps) / 1000
  }

  return {
    sample,
    answered(t) {
      if (answeredAt === null) answeredAt = t
    },
    check(t) {
      if (answeredAt !== null) return null
      if (completeAt !== null) return t - completeAt >= answerWaitMs ? 'answer-timeout' : null
      if (mustFinishBy !== null && t >= mustFinishBy) return 'deadline'
      if (trusted) return t - lastProgressAt >= stallMs ? 'stall' : null
      return t - startedAt >= answerWaitMs + (total / noProgressBps) * 1000 ? 'no-progress-timeout' : null
    },
    abortSent(p, t) {
      sample(p, t)
      if (!trusted || completeAt !== null) return true
      return !(total - current > margin(t))
    },
    errorSent(text, t) {
      if (preSendNetError(text)) return false
      if (!trusted || completeAt !== null) return true
      return !(total - current > margin(t))
    },
    lastByteAt: () => (trusted ? incompleteAt : null),
    uploadMs: (t) => Math.max(0, (completeAt !== null ? completeAt : answeredAt !== null ? answeredAt : t) - startedAt),
    complete: () => completeAt !== null,
    trusted: () => trusted,
  }
}

/** A clock abort → the failure the page gets ({ code, message, sent }). */
function abortFailure(reason, sent, lastByteAt) {
  if (reason === 'answer-timeout' || reason === 'no-progress-timeout') return failure('timeout', SEEDVIS_TEXTS.answerTimeout, { sent: true, lastByteAt })
  if (reason === 'deadline') return sent ? failure('timeout', SEEDVIS_TEXTS.lostAnswer, { sent: true, lastByteAt }) : failure('deadline', SEEDVIS_TEXTS.deadline, { sent: false })
  return sent ? failure('timeout', SEEDVIS_TEXTS.lostAnswer, { sent: true, lastByteAt }) : failure('timeout', SEEDVIS_TEXTS.uploadStalled, { sent: false })
}

// ---------------------------------------------------------------------------------------------------------------
// Lanes: slots, byte budget, Retry-After blocks, the submit breaker, same-key coalescing
// ---------------------------------------------------------------------------------------------------------------

/**
 * o: { now, sizes?, inFlightBytes?, breakerMax? }.
 *   run(lane, fn, { bytes, cancelled })  fn runs when the lane has a slot and the bodies in flight leave room for
 *                                        `bytes` (one body alone always runs); FIFO per lane. → fn's result.
 *   cancelWaiting(lane, value)           every request still waiting there resolves with `value` (fn never runs).
 *   block(lane, ms) / blockedFor(lane)   a Retry-After block (clamped 1–300 s) / ms left (0 = free).
 *   submitWaitMs() / noteSubmit()        the breaker: ≤ min(limit, 30) submits per rolling minute.
 *   setSubmitLimit(n)                    from /account/info rate_limit_per_minute.
 *   coalesce(key, hash, fn)              same key + same hash while in flight → the same promise; same key + another
 *                                        hash → { conflict: true }; else { promise }.
 *   active(lane) / waiting(lane) / bytesInFlight()
 */
function createSeedvisLanes(o) {
  const opts = o || {}
  const now = typeof opts.now === 'function' ? opts.now : () => 0
  const sizes = Object.assign({}, SEEDVIS_LANE_SIZE, opts.sizes || {})
  const budget = Number.isFinite(opts.inFlightBytes) ? opts.inFlightBytes : SEEDVIS_IPC_LIMITS.inFlightBytes
  const breakerMax = Number.isFinite(opts.breakerMax) ? opts.breakerMax : SEEDVIS_SUBMIT_BREAKER_MAX
  const lanes = {}
  for (const name of Object.keys(sizes)) lanes[name] = { active: 0, waiters: [], blockedUntil: 0 }
  let inFlight = 0
  let submitLimit = breakerMax
  let submits = []
  const byKey = new Map()

  const laneOf = (name) => {
    const l = lanes[name]
    if (!l) throw new Error('unknown lane')
    return l
  }

  function pump(name) {
    const lane = lanes[name]
    while (lane.waiters.length && lane.active < sizes[name]) {
      const w = lane.waiters[0]
      if (inFlight > 0 && inFlight + w.bytes > budget) return
      lane.waiters.shift()
      w.start()
    }
  }
  const pumpAll = () => {
    for (const name of Object.keys(lanes)) pump(name)
  }

  function run(name, fn, ro) {
    const lane = laneOf(name)
    const bytes = ro && Number.isSafeInteger(ro.bytes) && ro.bytes > 0 ? ro.bytes : 0
    return new Promise((resolve, reject) => {
      const w = {
        bytes,
        start: () => {
          lane.active++
          inFlight += bytes
          let p
          try {
            p = Promise.resolve(fn())
          } catch (e) {
            p = Promise.reject(e)
          }
          p.then(resolve, reject).finally(() => {
            lane.active--
            inFlight -= bytes
            pumpAll()
          })
        },
        cancel: (value) => resolve(value),
      }
      lane.waiters.push(w)
      pump(name)
    })
  }

  return {
    run,
    cancelWaiting(name, value) {
      const lane = laneOf(name)
      const waiting = lane.waiters.splice(0)
      for (const w of waiting) w.cancel(value)
      return waiting.length
    },
    block(name, ms) {
      const lane = laneOf(name)
      const d = Math.min(SEEDVIS_RETRY_AFTER_MAX_MS, Math.max(SEEDVIS_RETRY_AFTER_MIN_MS, Number.isFinite(ms) ? ms : SEEDVIS_RETRY_AFTER_MIN_MS))
      lane.blockedUntil = Math.max(lane.blockedUntil, now() + d)
    },
    blockedFor(name) {
      return Math.max(0, laneOf(name).blockedUntil - now())
    },
    submitWaitMs() {
      const t = now()
      submits = submits.filter((at) => t - at < 60_000)
      return submits.length >= submitLimit ? Math.max(1, submits[0] + 60_000 - t) : 0
    },
    noteSubmit() {
      submits.push(now())
    },
    setSubmitLimit(n) {
      if (Number.isFinite(n) && n >= 1) submitLimit = Math.min(Math.floor(n), breakerMax)
    },
    submitLimit: () => submitLimit,
    coalesce(key, hash, fn) {
      const cur = byKey.get(key)
      if (cur) return cur.hash === hash ? { promise: cur.promise, shared: true } : { conflict: true }
      const entry = { hash, promise: null }
      entry.promise = Promise.resolve()
        .then(fn)
        .finally(() => {
          if (byKey.get(key) === entry) byKey.delete(key)
        })
      byKey.set(key, entry)
      return { promise: entry.promise, shared: false }
    },
    active: (name) => laneOf(name).active,
    waiting: (name) => laneOf(name).waiters.length,
    bytesInFlight: () => inFlight,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Result downloads (pieces ≤ 4 MiB pulled by the page; the page names a job id + output index, never a URL)
// ---------------------------------------------------------------------------------------------------------------

/** { code, message } of a download that ended with a pump reason (createDownloadPump of main.cjs). */
function downloadFailure(reason) {
  switch (reason) {
    case 'idle':
      return failure('network', 'seedvis ngừng gửi video giữa chừng (60 giây không nhận thêm dữ liệu).')
    case 'cut':
      return failure('network', 'Mất kết nối khi đang tải video từ seedvis.')
    case 'length':
      return failure('network', 'Video tải về không khớp dung lượng seedvis báo (kết nối bị đóng giữa chừng).')
    case 'size':
      return failure('too-large', 'Video lớn hơn 1 GB — SanoVids không tải về máy được.')
    case 'max':
      return failure('too-slow', 'Tải video quá 60 phút nên SanoVids dừng lại.')
    default:
      return failure('gone', SEEDVIS_TEXTS.downloadOver)
  }
}

/**
 * The video downloads. deps: {
 *   fetch(url, { signal }) → { status, headers: { get }, body: web ReadableStream | null } (redirects checked inside;
 *                            rejects with error.code 'redirect-refused' for a hop that is not outputUrlAllowed),
 *   createPump(o)          main.cjs createDownloadPump (the same pump as canvasapp's downloads),
 *   withSlot(fn)           a slot of the 'download' lane, held until fn's promise settles,
 *   lookup(generationId, index) → the URL main recorded from a seedvis answer, or null,
 *   newId() → a UUID, setTimer, clearTimer, limits?, onEnd?(session) }
 *   open(owner, { generationId, index }) → { ok: true, id, total, mime } | failure (bad-request | unknown-output | busy |
 *                                          expired-link | network | too-large | bad-response | gone)
 *   read(owner, { id })  → { ok: true, done: false, bytes } | { ok: true, done: true } | failure
 *   close(owner, { id }) → { ok: true };  closeAll(owner?)
 */
function createSeedvisDownloads(deps) {
  const lim = Object.assign({}, SEEDVIS_DOWNLOAD_LIMITS, deps.limits || {})
  const sessions = new Map()

  function end(s) {
    if (s.ended) return
    s.ended = true
    for (const k of ['headerTimer', 'pullTimer', 'maxTimer']) {
      if (s[k] !== null) deps.clearTimer(s[k])
      s[k] = null
    }
    sessions.delete(s.id)
    if (s.pump) s.pump.cancel()
    try {
      s.controller.abort()
    } catch {
      /* nothing in flight */
    }
    const release = s.release
    s.release = null
    if (release) release()
    if (typeof deps.onEnd === 'function') {
      try {
        deps.onEnd(s)
      } catch {
        /* bookkeeping only */
      }
    }
  }

  function armPull(s) {
    if (s.pullTimer !== null) deps.clearTimer(s.pullTimer)
    s.pullTimer = deps.setTimer(() => {
      s.pullTimer = null
      end(s)
    }, lim.pullIdleMs)
  }

  function owned(owner, args) {
    const id = isPlainObject(args) && typeof args.id === 'string' ? args.id : ''
    if (!SEEDVIS_DOWNLOAD_ID_RE.test(id)) return null
    const s = sessions.get(id)
    return s && s.owner === owner ? s : null
  }

  function cancelBody(res) {
    try {
      const p = res && res.body && typeof res.body.cancel === 'function' ? res.body.cancel() : null
      if (p && typeof p.then === 'function') p.then(undefined, () => undefined)
    } catch {
      /* already closed */
    }
  }

  async function open(owner, args) {
    const a = isPlainObject(args) ? args : {}
    if (typeof a.generationId !== 'string' || !ID_RE.test(a.generationId) || !Number.isSafeInteger(a.index) || a.index < 0 || a.index >= SEEDVIS_OUTPUTS_PER_JOB) {
      return failure('bad-request', SEEDVIS_TEXTS.badRequest)
    }
    const url = deps.lookup(a.generationId, a.index)
    if (!url) return failure('unknown-output', SEEDVIS_TEXTS.unknownOutput)
    if (!outputUrlAllowed(url)) return failure('bad-response', SEEDVIS_TEXTS.downloadRefused)
    if (sessions.size >= lim.maxSessions) return failure('busy', SEEDVIS_TEXTS.downloadBusy)
    const id = deps.newId()
    if (typeof id !== 'string' || !SEEDVIS_DOWNLOAD_ID_RE.test(id) || sessions.has(id)) return failure('busy', SEEDVIS_TEXTS.downloadBusy)
    const s = { id, owner, url, controller: new AbortController(), pump: null, head: [], release: null, ended: false, reading: false, headerTimer: null, pullTimer: null, maxTimer: null, timedOut: false }
    sessions.set(id, s)

    const got = await new Promise((resolve) => {
      const held = () => {
        if (s.ended) {
          resolve(false)
          return Promise.resolve()
        }
        return new Promise((done) => {
          s.release = done
          resolve(true)
        })
      }
      let slot
      try {
        slot = Promise.resolve(deps.withSlot(held))
      } catch (e) {
        slot = Promise.reject(e)
      }
      slot.then(undefined, () => resolve(false))
    })
    if (!got || s.ended) {
      end(s)
      return downloadFailure('closed')
    }

    s.headerTimer = deps.setTimer(() => {
      s.headerTimer = null
      s.timedOut = true
      s.controller.abort()
    }, lim.headersMs)
    let res
    try {
      res = await deps.fetch(url, { signal: s.controller.signal })
    } catch (e) {
      const closed = s.ended && !s.timedOut
      end(s)
      if (closed) return downloadFailure('closed')
      if (e && e.code === 'redirect-refused') return failure('bad-response', SEEDVIS_TEXTS.downloadRefused)
      return failure('network', s.timedOut ? 'seedvis không gửi video (quá thời gian chờ).' : 'Không tải được video từ seedvis (lỗi mạng).')
    }
    if (s.ended) {
      cancelBody(res)
      return downloadFailure('closed')
    }
    if (!res || typeof res.status !== 'number') {
      end(s)
      return failure('bad-response', SEEDVIS_TEXTS.badResponse)
    }
    const header = (name) => {
      const v = res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null
      return typeof v === 'string' ? v : null
    }
    if ([401, 403, 404, 410].includes(res.status)) {
      cancelBody(res)
      end(s)
      return failure('expired-link', SEEDVIS_TEXTS.expiredLink)
    }
    if (res.status !== 200) {
      cancelBody(res)
      end(s)
      return failure('network', `seedvis không gửi video (mã ${res.status}).`)
    }
    const enc = (header('content-encoding') || '').trim()
    const lenText = (header('content-length') || '').trim()
    const len = enc === '' || /^identity$/i.test(enc) ? (/^\d{1,15}$/.test(lenText) ? Number(lenText) : null) : null
    if (len !== null && len > lim.maxBytes) {
      cancelBody(res)
      end(s)
      return downloadFailure('size')
    }
    let reader = null
    try {
      reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null
    } catch {
      reader = null
    }
    if (!reader) reader = { read: () => Promise.resolve({ done: true }), cancel: () => Promise.resolve() }
    s.pump = deps.createPump({
      reader,
      start: 0,
      end: len,
      maxBytes: lim.maxBytes,
      chunkBytes: lim.chunkBytes,
      flushMs: lim.flushMs,
      idleMs: lim.idleMs,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
    })
    // the first bytes decide the type (still under the headers timer)
    let have = 0
    let finished = false
    while (have < lim.sniffBytes) {
      const r = await s.pump.read()
      if (s.ended) return downloadFailure('closed')
      if (r && r.bytes) {
        s.head.push(r.bytes)
        have += r.bytes.byteLength
      } else if (r && r.done) {
        finished = true
        break
      } else {
        end(s)
        return downloadFailure(r && r.reason)
      }
    }
    const first = new Uint8Array(Math.min(have, 64))
    let off = 0
    for (const h of s.head) {
      if (off >= first.length) break
      const k = Math.min(h.byteLength, first.length - off)
      first.set(h.subarray(0, k), off)
      off += k
    }
    const mime = sniffMedia(first)
    if (!mime) {
      end(s)
      return failure('bad-response', SEEDVIS_TEXTS.notVideo)
    }
    if (s.headerTimer !== null) deps.clearTimer(s.headerTimer)
    s.headerTimer = null
    s.finished = finished
    s.maxTimer = deps.setTimer(() => {
      s.maxTimer = null
      if (s.pump) s.pump.abort('max')
    }, lim.maxMs)
    armPull(s)
    return { ok: true, id, total: len, mime }
  }

  async function read(owner, args) {
    const s = owned(owner, args)
    if (!s) return downloadFailure('closed')
    if (!s.pump || s.reading) return failure('busy', SEEDVIS_TEXTS.downloadReadBusy)
    s.reading = true
    if (s.pullTimer !== null) deps.clearTimer(s.pullTimer)
    s.pullTimer = null
    try {
      if (s.head.length) return { ok: true, done: false, bytes: s.head.shift() }
      if (s.finished) {
        end(s)
        return { ok: true, done: true }
      }
      const r = await s.pump.read()
      if (r && r.bytes) return { ok: true, done: false, bytes: r.bytes }
      end(s)
      if (r && r.done) return { ok: true, done: true }
      return downloadFailure(r && r.reason)
    } catch {
      end(s)
      return failure('network', 'Mất kết nối khi đang tải video từ seedvis.')
    } finally {
      s.reading = false
      if (!s.ended) armPull(s)
    }
  }

  function close(owner, args) {
    const s = owned(owner, args)
    if (s) end(s)
    return { ok: true }
  }

  function closeAll(owner) {
    for (const s of [...sessions.values()]) if (owner === undefined || s.owner === owner) end(s)
  }

  return { open, read, close, closeAll, size: () => sessions.size }
}

// ---------------------------------------------------------------------------------------------------------------
// Close guard (§10.6)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Should closing the window / quitting ask first? 'allow' | 'ask'.
 *   inFlight          submits not answered yet (uploading, awaiting the answer, or waiting for a slot);
 *   quittingForUpdate an update quits the app (updater.isQuittingForUpdate / macOS before-quit-for-update): never vetoed;
 *   confirmed         the user already chose "Thoát" (or the wait ended): never asked again;
 *   platform, phase   'window-close' asks on Windows / Linux; 'quit' (before-quit) asks on macOS only (there the
 *                     close button only hides the window).
 */
function closeGuardVerdict(o) {
  const v = o && typeof o === 'object' ? o : {}
  if (v.quittingForUpdate === true || v.confirmed === true) return 'allow'
  const mac = v.platform === 'darwin'
  if (v.phase === 'window-close' && mac) return 'allow'
  if (v.phase === 'quit' && !mac) return 'allow'
  if (v.phase !== 'window-close' && v.phase !== 'quit') return 'allow'
  return Number.isFinite(v.inFlight) && v.inFlight > 0 ? 'ask' : 'allow'
}

/** The native question of the close guard (buttons: 0 = Chờ gửi xong, 1 = Thoát). */
function closeGuardDialog(n) {
  const count = Number.isSafeInteger(n) && n > 0 ? n : 1
  return {
    type: 'warning',
    buttons: ['Chờ gửi xong', 'Thoát'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'SanoVids',
    message: `Đang gửi ${count} cảnh tới seedvis`,
    detail:
      'Thoát bây giờ có thể mất video đã trả tiền (seedvis có thể đã nhận và trừ credit, SanoVids sẽ không biết job đó). ' +
      '“Chờ gửi xong”: SanoVids tự thoát ngay khi gửi xong, không gửi thêm cảnh nào.',
  }
}

module.exports = {
  SEEDVIS_ORIGIN,
  SEEDVIS_API_BASE,
  SEEDVIS_PARTITION,
  SEEDVIS_CDN_HOSTS,
  SEEDVIS_BILLING_URL,
  SEEDVIS_IMAGE_LIMITS,
  SEEDVIS_IPC_LIMITS,
  SEEDVIS_RESPONSE_HEADERS,
  SEEDVIS_ACCOUNT_INFO_FIELDS,
  SEEDVIS_ACCOUNT_USAGE_FIELDS,
  SEEDVIS_ANSWER_WAIT_MS,
  SEEDVIS_TIMEOUTS,
  SEEDVIS_LANE_SIZE,
  SEEDVIS_SUBMIT_BREAKER_MAX,
  SEEDVIS_RETRY_AFTER_MIN_MS,
  SEEDVIS_RETRY_AFTER_MAX_MS,
  SEEDVIS_OUTPUTS_MAX,
  SEEDVIS_OUTPUTS_PER_JOB,
  SEEDVIS_REDIRECT_MAX,
  SEEDVIS_DOWNLOAD_LIMITS,
  SEEDVIS_DOWNLOAD_ID_RE,
  SEEDVIS_PROGRESS_STALE_MS,
  SEEDVIS_ABORT_SLACK_BYTES,
  SEEDVIS_ABORT_FLOOR_BPS,
  SEEDVIS_TEXTS,
  SEEDVIS_ROUTES,
  SEEDVIS_SUBMIT_MODELS,
  BODY_KEYS,
  IMAGE_FIELDS,
  PRE_SEND_NET_ERRORS,
  failure,
  imageSlotText,
  utf8Length,
  base64Length,
  matchSeedvisRoute,
  matchSeedvisUrl,
  authHeadersAllowed,
  headersToStrip,
  webRequestVerdict,
  normalizeUrl,
  sniffImage,
  sniffMedia,
  checkSubmit,
  imageFileName,
  buildSubmitJson,
  parseRetryAfter,
  pickResponseHeaders,
  outputUrlAllowed,
  isKnownCdnHost,
  hostOf,
  outputsOf,
  redactSecrets,
  sanitizeApiJson,
  sanitizeAccountInfo,
  sanitizeAccountUsage,
  routeLabel,
  logLine,
  netErrorName,
  preSendNetError,
  offlineNetError,
  createUploadClock,
  abortFailure,
  createSeedvisLanes,
  downloadFailure,
  createSeedvisDownloads,
  closeGuardVerdict,
  closeGuardDialog,
}
