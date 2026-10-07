import { SEEDVIS_MODEL_IDS } from '../../../core/services'
import { SEEDVIS_IMAGE_LIMITS, SEEDVIS_ROUTE_TABLE, type SeedvisRouteSpec } from '../../../core/seedvisRoutes'
import {
  SEEDVIS_API_BASE, SEEDVIS_IPC_LIMITS, SEEDVIS_IPC_ROUTES,
  type SeedvisBridgeErrorCode, type SeedvisBridgeFailure, type SeedvisRequest,
} from '../../seedvis/contract'
import { isObj } from '../validate'
import { matchSeedvisRoute, SEEDVIS_ID_RE } from './routes'

export { isObj }
export const SEEDVIS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One fixed Vietnamese text per gateway failure (the contract never carries raw exceptions). The brand stays lowercase. */
export const SEEDVIS_DEV_FAILURE_TEXT: Record<SeedvisBridgeErrorCode, string> = {
  'not-allowed': 'seedvis giả lập không cho phép yêu cầu này.',
  'no-key': 'Chưa có khoá giả lập seedvis.',
  'key-unreadable': 'Không đọc được khoá giả lập seedvis.',
  'bad-key': 'Khoá seedvis giả lập không dùng được.',
  'bad-request': 'Yêu cầu seedvis giả lập không hợp lệ.',
  'too-large': 'Yêu cầu hoặc video seedvis giả lập vượt giới hạn kích thước.',
  'bad-image': 'Ảnh gửi seedvis giả lập không hợp lệ (định dạng, thứ tự hoặc số ảnh).',
  'rate-limited': 'seedvis giả lập đang giới hạn tốc độ — thử lại sau.',
  network: 'Mất kết nối tới seedvis giả lập.',
  timeout: 'seedvis giả lập không trả lời kịp.',
  deadline: 'Đã dừng tải lên trước hạn gửi lại an toàn — seedvis chưa nhận yêu cầu.',
  'bad-response': 'seedvis giả lập trả về dữ liệu không đọc được.',
  'expired-link': 'Link video giả lập đã hết hạn.',
  offline: 'seedvis giả lập đang mất mạng.',
  'unknown-output': 'Không có video này trong các câu trả lời seedvis giả lập đã ghi nhận.',
  'idempotency-conflict': 'Cùng mã gửi nhưng nội dung khác — seedvis giả lập từ chối.',
  busy: 'Đang tải đủ số video cùng lúc — thử lại sau.',
  gone: 'Phiên tải video giả lập đã kết thúc.',
  'too-slow': 'Tải video giả lập quá chậm.',
  'storage-unavailable': 'Không có chỗ lưu dữ liệu seedvis giả lập.',
  'storage-failed': 'Không lưu hoặc đọc được dữ liệu seedvis giả lập.',
}
export const failure = (code: SeedvisBridgeErrorCode, message = SEEDVIS_DEV_FAILURE_TEXT[code]): SeedvisBridgeFailure => ({ ok: false, code, message })
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k))
const textBytes = (s: string) => new TextEncoder().encode(s).length

export function sniffSeedvisImage(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

/** IPC validation is deliberately stricter than the public API (count is always one). */
export function seedvisRequestProblem(raw: unknown): SeedvisBridgeFailure | null {
  if (!isObj(raw) || typeof raw.route !== 'string' || !Object.hasOwn(SEEDVIS_IPC_ROUTES, raw.route)) return failure('not-allowed')
  const route = SEEDVIS_IPC_ROUTES[raw.route as keyof typeof SEEDVIS_IPC_ROUTES]
  const hasId = route.path.includes('{id}')
  if (hasId && (typeof raw.id !== 'string' || !SEEDVIS_ID_RE.test(raw.id))) return failure('bad-request')
  const path = SEEDVIS_API_BASE + route.path.replace('{id}', hasId ? raw.id as string : '')
  if (!matchSeedvisRoute(route.method, path)) return failure('not-allowed')
  if (raw.route !== 'generations.create') return only(raw, hasId ? ['route', 'id'] : ['route']) ? null : failure('bad-request')
  if (!only(raw, ['route', 'idempotencyKey', 'body', 'images', 'mustFinishBy'])) return failure('bad-request')
  if (typeof raw.idempotencyKey !== 'string' || !SEEDVIS_UUID_RE.test(raw.idempotencyKey)) return failure('bad-request')
  if (raw.mustFinishBy !== undefined && (typeof raw.mustFinishBy !== 'number' || !Number.isSafeInteger(raw.mustFinishBy) || raw.mustFinishBy < 0)) return failure('bad-request')
  const b = raw.body
  if (!isObj(b)) return failure('bad-request')
  const spec: SeedvisRouteSpec | undefined = SEEDVIS_MODEL_IDS.map(id => SEEDVIS_ROUTE_TABLE[id]).find(s => s.remoteModel === b.model)
  const mode = spec?.requests.find(m => m.remoteMode === b.mode)
  if (!spec || !mode || !only(b, ['model', 'mode', 'prompt', 'count', 'aspect_ratio', 'duration', ...(spec.family === 'veo' ? ['upscale_video'] : [])])) return failure('bad-request')
  if (b.count !== 1 || typeof b.prompt !== 'string' || !b.prompt.trim() || [...b.prompt].length > spec.promptLimit) return failure('bad-request')
  if (!spec.ratios.some(r => r === b.aspect_ratio) || !spec.durations.some(d => (spec.durationEncoding === 'integer' ? d : `${d}s`) === b.duration)) return failure('bad-request')
  if (spec.family === 'veo' && b.upscale_video !== 'none' && b.upscale_video !== '1080p') return failure('bad-request')
  if (textBytes(JSON.stringify(b)) > SEEDVIS_IPC_LIMITS.bodyBytes) return failure('too-large')
  const images = raw.images === undefined ? [] : raw.images
  if (!Array.isArray(images) || images.length < mode.minImages || images.length > mode.maxImages) return failure('bad-image')
  let base64Bytes = 0
  const indices = new Map<string, number>()
  for (const image of images) {
    if (!isObj(image) || !only(image, ['field', 'index', 'mime', 'bytes']) || !mode.imageFields.some(f => f === image.field)) return failure('bad-image')
    const field = image.field as string
    if (image.index !== (indices.get(field) ?? 0)) return failure('bad-image')
    indices.set(field, (indices.get(field) ?? 0) + 1)
    if ((field === 'image' || field === 'lastFrame') && image.index !== 0) return failure('bad-image')
    if (!(image.bytes instanceof Uint8Array) || image.bytes.length === 0 || sniffSeedvisImage(image.bytes) !== image.mime) return failure('bad-image')
    if (image.bytes.length > SEEDVIS_IMAGE_LIMITS.maxImageBytes) return failure('too-large')
    base64Bytes += 4 * Math.ceil(image.bytes.length / 3)
  }
  if (base64Bytes > SEEDVIS_IMAGE_LIMITS.preparedBase64Bytes) return failure('too-large')
  if (mode.imageFields.some(f => !indices.has(f))) return failure('bad-image')
  return null
}

export type SeedvisCreate = Extract<SeedvisRequest, { route: 'generations.create' }>

/** The upload includes base64, not just decoded image bytes. Keep serialization stable across retries. */
export function seedvisUploadBytes(req: SeedvisCreate): number {
  const body: Record<string, unknown> = { ...req.body }
  for (const image of req.images ?? []) {
    const ext = image.mime === 'image/jpeg' ? 'jpg' : image.mime.split('/')[1]
    const value = { data: '', file_name: image.field === 'image' ? `frame_first.${ext}` : image.field === 'lastFrame' ? `frame_last.${ext}` : `image_${image.index + 1}.${ext}` }
    if (image.field === 'image' || image.field === 'lastFrame') body[image.field] = value
    else {
      const list = (body[image.field] ??= []) as unknown[]
      list.push(value)
    }
  }
  return textBytes(JSON.stringify(body)) + (req.images ?? []).reduce((n, i) => n + 4 * Math.ceil(i.bytes.length / 3), 0)
}

/** Hash exact image content, never a filename, length-only signature or collision-prone short hash. */
export async function seedvisBodyHash(req: SeedvisCreate): Promise<string> {
  const hex = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)), n => n.toString(16).padStart(2, '0')).join('')
  const images = await Promise.all((req.images ?? []).map(async i => [i.field, i.index, i.mime, await hex(i.bytes)]))
  const body = Object.fromEntries(Object.entries(req.body).sort(([a], [b]) => a.localeCompare(b)))
  return hex(new TextEncoder().encode(JSON.stringify({ body, images })))
}
