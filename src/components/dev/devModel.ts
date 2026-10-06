// What the development-mode UI shows (Bảng phát triển, top bar bug button) — pure, no stores, no React. Tested in
// __tests__/devModel.test.ts. docs/SPEC-v2.md §11.
//
// ---- API ----
//   DEV_PANEL_TABS / DevPanelTab              the panel's tabs (Trạng thái · Gây lỗi · Nhật ký · Job & đơn nạp · Cập nhật —
//                                             the simulated updater and the simulated signature of Cài đặt → Giới thiệu).
//   devPanelTabs({ simulatedUpdates })        the tabs to show ('Cập nhật' only where the updater is simulated).
//   activeFaultCount(snapshot)                faults armed on the simulated server (rules + job faults + session ended).
//   DEV_UI_FAULTS                             one-click faults of the "Gây lỗi" tab (Vietnamese label / hint / action).
//   uiFaultRule(item, sticky)                 the server rule (DevFaultInput) of a 'rule' item, sticky or one-shot.
//   faultArmedText(item, sticky, n)           the toast after "Bật": "Đã bật lỗi giả: … (2 lần)" / "(giữ)".
//   faultKindText(fault) / faultRuleText(rule) Vietnamese description of a fault / an armed rule.
//   customFaultInput(form)                    the custom-rule form → DevFaultInput, or a Vietnamese error.
//   faultKindsFor(endpoint)                   the kinds the custom-rule form offers for that request (the video
//                                             download ones — ngắt / treo / chậm / quá lớn — only for "Tải video").
//   statusTone(entry) / statusText(entry)     request-log status chip.
//   filterLog(entries, query, onlyProblems)   newest first, filtered.
//   logExport(entries, snapshot, now)         "Copy nhật ký" text (JSON) for bug reports.
//   characterCheck(body, ctx)                 "Kiểm tra nhân vật" of a POST /api/video-jobs body: each upload in order
//                                             as @image_N → SanoVids image → asset; @image_N of the prompt without an
//                                             upload are flagged.
//   jobNodeOwners(projectId, scenes)          canvas_node_id → which scene of the open project a job ran on (its node,
//   jobNodeText(nodeId, owner)                or the old one named by the scene id alone) + the job's label / tooltip.
//   siteNodeLabel(node, owner, title)         "Tạo job như trên trang canvasapp": a bridge node's option label;
//   siteJobToast(result) / SITE_JOB_HINT      what the card says.
//   limitsStatusText(info, limits)            "Model (video-profiles)": whether / when SanoVids read the simulated
//                                             site's model settings and what the inspector does with them.
//   limitsDifferFromConfig(limits, models)    what SanoVids knows ≠ the toggles now → suggest "Đọc lại ngay".
import { parseTokens, sceneCode } from '../../core/compile'
import { MODELS, normalizeSettings } from '../../core/models'
import type { Asset, ModelId, Scene } from '../../core/types'
import { canvasNodeId, sceneNodeId } from '../../providers/canvasapp/mapping'
import type { LimitField, LimitsInfo, SettingsLimits } from '../../providers/types'
import { fieldBlock } from '../inspector/settingsLimits'
import type { DevPanelTab } from '../../store/ui'
import type { DevLogEntry } from '../../providers/dev/log'
import { DEV_ENDPOINT_LABEL, DEV_ENDPOINTS, type DevEndpoint } from '../../providers/dev/routes'
import type { SiteNodeInfo } from '../../providers/dev/siteClient'
import {
  DEV_FAULT_PRESETS,
  DEV_STREAM_FAULT_KINDS,
  type DevConfig,
  type DevFault,
  type DevFaultInput,
  type DevFaultRule,
  type DevJobView,
  type DevServerSnapshot,
  type DevSiteJobResult,
  type DevUploadView,
} from '../../providers/dev/server'

// ---------------------------------------------------------------------------------------------
// Tabs, counts
// ---------------------------------------------------------------------------------------------

export type { DevPanelTab }

export const DEV_PANEL_TABS: { id: DevPanelTab; label: string }[] = [
  { id: 'status', label: 'Trạng thái' },
  { id: 'faults', label: 'Gây lỗi' },
  { id: 'log', label: 'Nhật ký' },
  { id: 'jobs', label: 'Job & đơn nạp' },
  { id: 'updates', label: 'Cập nhật' },
]

/**
 * Tabs of the panel: "Cập nhật" drives the simulated updater (providers/dev/updates), which exists only outside Electron
 * (lib/updates updatesSource() === 'sim'); the desktop app always uses the real updater, so the tab is left out there.
 */
export function devPanelTabs({ simulatedUpdates }: { simulatedUpdates: boolean }): { id: DevPanelTab; label: string }[] {
  return simulatedUpdates ? DEV_PANEL_TABS : DEV_PANEL_TABS.filter((t) => t.id !== 'updates')
}

/** Faults armed on the simulated server: rules, job-level faults and a session ended by "Hết phiên (401)". */
export function activeFaultCount(s: Pick<DevServerSnapshot, 'faults' | 'jobFaults' | 'sessionExpired'> | null | undefined): number {
  if (!s) return 0
  const j = s.jobFaults
  return s.faults.length + (j.failNext !== null ? 1 : 0) + (j.expireNext ? 1 : 0) + (j.streamFailures > 0 ? 1 : 0) + (s.sessionExpired ? 1 : 0)
}

// ---------------------------------------------------------------------------------------------
// One-click faults
// ---------------------------------------------------------------------------------------------

export type DevUiFaultAction =
  /** A server rule (addFault): one-shot by default, "giữ" makes it sticky. */
  | { type: 'rule'; rule: DevFaultInput }
  /** The next job created fails (setJobFaults({ failNext })). */
  | { type: 'fail-next' }
  /** The next job created ends 'expired'. */
  | { type: 'expire-next' }
  /** The next N downloads fail with 503 (setJobFaults({ streamFailures })). */
  | { type: 'stream-failures' }
  /** The session ends on the server: every request answers 401 until the user logs in again. */
  | { type: 'expire-session' }

export interface DevUiFault {
  id: string
  label: string
  hint: string
  action: DevUiFaultAction
  /** The "giữ" toggle applies (rules only). */
  canStick: boolean
  /** Sticky unless the user turns "giữ" off (faults that only make sense while they last). */
  stickyByDefault: boolean
}

const preset = (id: string): DevFaultInput => {
  const p = DEV_FAULT_PRESETS.find((x) => x.id === id)
  if (!p) throw new Error(`unknown dev fault preset ${id}`)
  return p.rule
}
const hintOf = (id: string) => DEV_FAULT_PRESETS.find((x) => x.id === id)?.hint ?? ''

const rule = (id: string, label: string, opts: { hint?: string; input?: DevFaultInput; sticky?: boolean } = {}): DevUiFault => {
  const input = opts.input ?? preset(id)
  return {
    id,
    label,
    hint: opts.hint ?? hintOf(id),
    action: { type: 'rule', rule: input },
    canStick: true,
    stickyByDefault: opts.sticky ?? !!input.sticky,
  }
}

/** The "Gây lỗi" tab, in the order of the panel. */
export const DEV_UI_FAULTS: DevUiFault[] = [
  rule('job-network', 'Mất mạng khi tạo job'),
  rule('job-lost', 'Mất phản hồi sau khi tạo job (đã trừ tiền)'),
  rule('job-502', '502 sau khi đã tạo job'),
  rule('job-no-id', '200 nhưng không có mã job'),
  rule('job-402', 'Không đủ credit (402)'),
  rule('job-422', 'Dữ liệu sai (422)'),
  rule('canvas-400', 'Invalid canvas payload (400)'),
  {
    id: 'session-401',
    label: 'Hết phiên (401)',
    hint: 'Máy chủ giả lập đăng xuất tài khoản: mọi yêu cầu trả 401 cho tới khi đăng nhập lại — SanoVids phải mời đăng nhập, không làm mất take đang chạy.',
    action: { type: 'expire-session' },
    canStick: false,
    stickyByDefault: false,
  },
  rule('rate-429', 'Quá nhiều yêu cầu (429)'),
  {
    id: 'fail-next',
    label: 'Job tiếp theo lỗi',
    hint: 'Job tạo tiếp theo chạy một lúc rồi lỗi — máy chủ hoàn credit, take phải báo lỗi rõ ràng.',
    action: { type: 'fail-next' },
    canStick: false,
    stickyByDefault: false,
  },
  {
    id: 'expire-next',
    label: 'Job tiếp theo hết hạn',
    hint: 'Job tạo tiếp theo kết thúc ở trạng thái “expired” — không có video để tải.',
    action: { type: 'expire-next' },
    canStick: false,
    stickyByDefault: false,
  },
  {
    id: 'stream-failures',
    label: 'Tải video lỗi N lần',
    hint: 'N lần tải video kế tiếp bị trả 503 — video đã xong (đã trả tiền), SanoVids phải tự tải lại chứ không báo take lỗi.',
    action: { type: 'stream-failures' },
    canStick: false,
    stickyByDefault: false,
  },
  rule('upload-500', 'Tải ảnh lên lỗi', {
    hint: 'Lần tải ảnh tham chiếu kế tiếp bị máy chủ từ chối (500) — take không được gửi đi, không bị trừ credit.',
    input: { endpoint: 'upload', fault: { kind: 'response', status: 500, json: { detail: 'Không lưu được ảnh (giả lập lỗi máy chủ).' } } },
  }),
  rule('slow-3s', 'Chậm 3 giây', {
    hint: 'Yêu cầu kế tiếp (bật “giữ”: mọi yêu cầu) phải chờ thêm 3 giây.',
    input: { endpoint: '*', fault: { kind: 'slow', ms: 3_000 } },
    sticky: false,
  }),
  rule('profiles-500', 'Cấu hình model lỗi (500)'),
  rule('list-network', 'Mất mạng khi đọc danh sách job'),
  rule('stream-network', 'Mất mạng khi tải video'),
  rule('stream-cut', 'Mất mạng giữa chừng khi tải video'),
  rule('stream-stall', 'Tải video bị treo'),
  rule('stream-slow', 'Tải video chậm (100 KB/giây)'),
  rule('stream-crawl', 'Tải video rất chậm (quá giới hạn mỗi kết nối)'),
  rule('stream-http', 'Tải video bị chuyển sang http'),
  rule('stream-oversize', 'Video quá lớn (> 1 GB)'),
  rule('offline', 'Mất mạng hoàn toàn'),
]

/** The server rule of a 'rule' item: one-shot (its own `times`, default 1) or sticky. */
export function uiFaultRule(item: DevUiFault, sticky: boolean): DevFaultInput | null {
  if (item.action.type !== 'rule') return null
  const { rule: r } = item.action
  return { endpoint: r.endpoint, fault: r.fault, sticky, ...(sticky ? {} : { times: r.times ?? 1 }), label: item.label }
}

/**
 * The toast after "Bật": how often the fault happens comes from the rule itself (a preset may fire several times),
 * "(giữ)" for a sticky one; `count` = N of "Tải video lỗi N lần".
 */
export function faultArmedText(item: DevUiFault, sticky: boolean, count = 1): string {
  let suffix = ''
  if (item.action.type === 'rule') suffix = sticky ? ' (giữ)' : ` (${uiFaultRule(item, false)?.times ?? 1} lần)`
  else if (item.action.type === 'stream-failures') suffix = ` (N = ${count})`
  return `Đã bật lỗi giả: ${item.label}${suffix}.`
}

export function faultKindText(f: DevFault): string {
  switch (f.kind) {
    case 'network':
      return 'mất mạng (không tới máy chủ)'
    case 'lost-response':
      return 'mất câu trả lời (máy chủ đã xử lý)'
    case 'processed-then':
      return `xử lý xong rồi trả ${f.status}`
    case 'response':
      return `trả ${f.status} (không xử lý)`
    case 'slow':
      return `chậm ${formatSeconds(f.ms)}`
    case 'cut':
      return `ngắt giữa chừng (sau ${formatShare(f.fraction)} video)`
    case 'stall':
      return `đứng, không gửi tiếp (sau ${formatShare(f.fraction)} video)`
    case 'trickle':
      return `chậm ${Math.round(f.bytesPerSec / 1024)} KB/giây`
    case 'oversize':
      return 'báo dung lượng > 1 GB'
    case 'insecure-redirect':
      return 'chuyển hướng sang http (không được theo)'
  }
}

const formatShare = (x: number | undefined) => `${Math.round((typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5) * 100)}%`

const formatSeconds = (ms: number) => `${Math.round((ms / 1000) * 10) / 10} giây`.replace('.', ',')

export const endpointText = (e: DevEndpoint | '*'): string => (e === '*' ? 'Mọi yêu cầu' : DEV_ENDPOINT_LABEL[e] ?? e)

/** "Tạo job video · mất mạng (không tới máy chủ) · còn 1 lần" */
export function faultRuleText(r: Pick<DevFaultRule, 'endpoint' | 'fault' | 'sticky' | 'remaining' | 'hits'>): string {
  const left = r.sticky ? 'giữ tới khi tắt' : `còn ${r.remaining} lần`
  const hits = r.hits ? ` · đã xảy ra ${r.hits} lần` : ''
  return `${endpointText(r.endpoint)} · ${faultKindText(r.fault)} · ${left}${hits}`
}

// ---------------------------------------------------------------------------------------------
// Custom rule
// ---------------------------------------------------------------------------------------------

export type DevFaultKind = DevFault['kind']

export const DEV_FAULT_KIND_LABEL: Record<DevFaultKind, string> = {
  network: 'Mất mạng',
  'lost-response': 'Mất câu trả lời (đã xử lý)',
  'processed-then': 'Xử lý rồi trả mã khác',
  response: 'Trả mã lỗi (không xử lý)',
  slow: 'Chậm',
  cut: 'Ngắt giữa chừng (tải video)',
  stall: 'Treo giữa chừng (tải video)',
  trickle: 'Tải chậm (KB/giây)',
  oversize: 'Báo video > 1 GB',
  'insecure-redirect': 'Chuyển hướng sang http (tải video)',
}

const isStreamKind = (k: DevFaultKind) => (DEV_STREAM_FAULT_KINDS as readonly string[]).includes(k)

/** Kinds the custom-rule form offers for a request: the video-download ones only for 'job-stream'. */
export function faultKindsFor(endpoint: DevEndpoint | '*'): DevFaultKind[] {
  return (Object.keys(DEV_FAULT_KIND_LABEL) as DevFaultKind[]).filter((k) => endpoint === 'job-stream' || !isStreamKind(k))
}

export interface CustomFaultForm {
  endpoint: DevEndpoint | '*'
  kind: DevFaultKind
  /** HTTP status for 'response' / 'processed-then'. */
  status: string
  /** Optional JSON answer body for 'response' / 'processed-then' ("" = {}). */
  json: string
  /** Delay for 'slow'. */
  ms: string
  /** KB per second for 'trickle'. */
  kbps: string
  /** One-shot count. */
  times: string
  sticky: boolean
}

export const CUSTOM_FAULT_DEFAULT: CustomFaultForm = { endpoint: 'job-create', kind: 'response', status: '500', json: '', ms: '3000', kbps: '100', times: '1', sticky: false }

export const isDevEndpoint = (v: string): v is DevEndpoint | '*' => v === '*' || (DEV_ENDPOINTS as string[]).includes(v)

/** The custom-rule form as a server rule, or why it cannot be one (Vietnamese). */
export function customFaultInput(f: CustomFaultForm): { ok: true; input: DevFaultInput } | { ok: false; error: string } {
  if (!isDevEndpoint(f.endpoint)) return { ok: false, error: 'Chọn một yêu cầu.' }
  if (!(f.kind in DEV_FAULT_KIND_LABEL)) return { ok: false, error: 'Chọn một kiểu lỗi.' }
  if (isStreamKind(f.kind) && f.endpoint !== 'job-stream') return { ok: false, error: 'Kiểu lỗi này chỉ dùng cho “Tải video”.' }
  let fault: DevFault
  if (f.kind === 'network' || f.kind === 'lost-response' || f.kind === 'oversize' || f.kind === 'insecure-redirect') fault = { kind: f.kind }
  else if (f.kind === 'cut' || f.kind === 'stall') fault = { kind: f.kind, fraction: 0.5 }
  else if (f.kind === 'trickle') {
    const kbps = Number(f.kbps)
    if (!Number.isInteger(kbps) || kbps < 1 || kbps > 100_000) return { ok: false, error: 'Tốc độ phải là số nguyên 1–100000 KB/giây.' }
    fault = { kind: 'trickle', bytesPerSec: kbps * 1024 }
  } else if (f.kind === 'slow') {
    const ms = Number(f.ms)
    if (!Number.isInteger(ms) || ms < 0 || ms > 120_000) return { ok: false, error: 'Thời gian chậm phải là số nguyên 0–120000 ms.' }
    fault = { kind: 'slow', ms }
  } else {
    const status = Number(f.status)
    if (!Number.isInteger(status) || status < 100 || status > 599) return { ok: false, error: 'Mã HTTP phải từ 100 đến 599.' }
    let json: unknown = {}
    if (f.json.trim()) {
      try {
        json = JSON.parse(f.json)
      } catch {
        return { ok: false, error: 'Nội dung trả về không phải JSON hợp lệ.' }
      }
    }
    fault = { kind: f.kind, status, json }
  }
  const times = Number(f.times)
  if (!f.sticky && (!Number.isInteger(times) || times < 1 || times > 100)) return { ok: false, error: 'Số lần phải từ 1 đến 100.' }
  return { ok: true, input: { endpoint: f.endpoint, fault, sticky: f.sticky, ...(f.sticky ? {} : { times }) } }
}

// ---------------------------------------------------------------------------------------------
// Request log
// ---------------------------------------------------------------------------------------------

export type LogTone = 'ok' | 'warn' | 'danger'

export function statusTone(e: Pick<DevLogEntry, 'status'>): LogTone {
  if (e.status === null || e.status >= 500) return 'danger'
  if (e.status >= 400) return 'warn'
  return 'ok'
}

/** "200" | "không trả lời" (network fault / refused by the gateway). */
export const statusText = (e: Pick<DevLogEntry, 'status'>): string => (e.status === null ? 'không trả lời' : String(e.status))

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "14:05:09" (local time). */
export function logTime(at: number): string {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** Newest first; `query` matches method, path, status, fault, endpoint name and note (all words, any case). */
export function filterLog(entries: readonly DevLogEntry[], query: string, onlyProblems = false): DevLogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const out: DevLogEntry[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (onlyProblems && statusTone(e) === 'ok' && !e.fault) continue
    if (words.length) {
      const hay = [e.method, e.path, statusText(e), e.fault ?? '', e.endpoint ? DEV_ENDPOINT_LABEL[e.endpoint] : '', e.note ?? ''].join(' ').toLowerCase()
      if (!words.every((w) => hay.includes(w))) continue
    }
    out.push(e)
  }
  return out
}

/** "Copy nhật ký": the log + the simulated server's settings and faults, as JSON for a bug report. */
export function logExport(entries: readonly DevLogEntry[], snapshot: DevServerSnapshot | null, now: number = Date.now()): string {
  return JSON.stringify(
    {
      app: 'SanoVids',
      mode: 'dev',
      exportedAt: new Date(now).toISOString(),
      server: snapshot
        ? {
            authenticated: snapshot.authenticated,
            balance: snapshot.balance,
            config: snapshot.config,
            faults: snapshot.faults,
            jobFaults: snapshot.jobFaults,
            jobs: snapshot.jobs.slice(0, 20).map((j) => ({
              job_id: j.job_id,
              number: j.number,
              status: j.status,
              progress: j.progress,
              cost: j.cost,
              refunded: j.refunded,
              client_request_id: j.client_request_id,
              upload_ids: j.upload_ids,
              error_message: j.error_message,
            })),
          }
        : null,
      entries: entries.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    },
    null,
    2,
  )
}

// ---------------------------------------------------------------------------------------------
// Simulated SePay page
// ---------------------------------------------------------------------------------------------

/**
 * A QR-looking placeholder for the simulated SePay page: `size`×`size` modules (true = dark), three finder squares,
 * the rest from a hash of `seed` — the same order always draws the same picture. It is NOT a scannable code.
 */
export function placeholderQr(seed: string, size = 25): boolean[][] {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0
  const next = () => {
    h ^= h << 13
    h >>>= 0
    h ^= h >>> 17
    h ^= h << 5
    h >>>= 0
    return h
  }
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => (next() & 3) === 0 || (next() & 7) === 1))
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r
        const cc = c0 + c
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue
        const ring = r === -1 || c === -1 || r === 7 || c === 7
        const edge = r === 0 || c === 0 || r === 6 || c === 6
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
        grid[rr][cc] = !ring && (edge || core)
      }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)
  return grid
}

/** "14:59" — minutes:seconds left until `until` (never negative). */
export function minutesLeft(until: number, now: number): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------------------------
// Character check (POST /api/video-jobs)
// ---------------------------------------------------------------------------------------------

export interface CharacterSlot {
  /** 1-based position in upload_ids (= N of @image_N); 0 for frames. */
  n: number
  /** "@image_1" | "khung đầu" | "khung cuối" */
  label: string
  uploadId: string
  /** The upload exists on the simulated server. */
  uploaded: boolean
  /** SanoVids media-store image id (from the upload's filename), null when unknown. */
  imageId: string | null
  /** The project asset holding that image, when found. */
  asset: { id: string; name: string; tag: string } | null
  /** The prompt mentions this @image_N (frames: always true). */
  mentioned: boolean
}

export interface CharacterCheck {
  kind: 'images' | 'frames'
  slots: CharacterSlot[]
  /** @image_N of the prompt that have no picture in this request (the model would get no image for them). */
  missing: { n: number; token: string }[]
  /** The prompt checked: the job's full prompt when the server has it, else the (maybe cut) logged one. */
  prompt: string
  /** Only the first characters of the prompt are known (the log cuts long strings). */
  promptTruncated: boolean
  /** The prompt came from the simulated server's job (complete). */
  promptFromJob: boolean
}

export interface CharacterCheckContext {
  uploads: readonly Pick<DevUploadView, 'upload_id' | 'imageId'>[]
  jobs: readonly Pick<DevJobView, 'client_request_id' | 'prompt'>[]
  assets: readonly Pick<Asset, 'id' | 'name' | 'tag' | 'imageIds'>[]
}

const TRUNCATED = /… \(\+\d+ ký tự\)$/

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Null when the body is not a job body (no upload_ids / frames). */
export function characterCheck(body: unknown, ctx: CharacterCheckContext): CharacterCheck | null {
  if (!isObj(body)) return null
  const ids = Array.isArray(body.upload_ids) ? body.upload_ids.filter((x): x is string => typeof x === 'string') : null
  const first = typeof body.first_frame_upload_id === 'string' ? body.first_frame_upload_id : null
  const last = typeof body.last_frame_upload_id === 'string' ? body.last_frame_upload_id : null
  if (!ids && !first && !last) return null

  const key = typeof body.client_request_id === 'string' ? body.client_request_id : null
  const job = key ? ctx.jobs.find((j) => j.client_request_id === key) : undefined
  const logged = typeof body.prompt === 'string' ? body.prompt : ''
  const prompt = job ? job.prompt : logged
  const promptTruncated = !job && TRUNCATED.test(logged)

  const uploads = new Map(ctx.uploads.map((u) => [u.upload_id, u]))
  const assetOf = (imageId: string | null) => {
    if (!imageId) return null
    const a = ctx.assets.find((x) => x.imageIds.includes(imageId))
    return a ? { id: a.id, name: a.name, tag: a.tag } : null
  }
  const slot = (uploadId: string, n: number, label: string, mentioned: boolean): CharacterSlot => {
    const u = uploads.get(uploadId)
    const imageId = u?.imageId ?? null
    return { n, label, uploadId, uploaded: !!u, imageId, asset: assetOf(imageId), mentioned }
  }

  const tokens = parseTokens(prompt).filter((t) => t.kind === 'image')
  const mentioned = new Set(tokens.map((t) => t.n))
  const frames = !ids && (first || last)
  const slots = frames
    ? [
        ...(first ? [slot(first, 0, 'khung đầu', true)] : []),
        ...(last ? [slot(last, 0, 'khung cuối', true)] : []),
      ]
    : (ids ?? []).map((id, i) => slot(id, i + 1, `@image_${i + 1}`, mentioned.has(i + 1)))
  const count = frames ? 0 : (ids ?? []).length
  const missing: { n: number; token: string }[] = []
  const seen = new Set<number>()
  for (const t of tokens) {
    if (t.n >= 1 && t.n <= count) continue
    if (seen.has(t.n)) continue
    seen.add(t.n)
    missing.push({ n: t.n, token: prompt.slice(t.start, t.end) })
  }
  return { kind: frames ? 'frames' : 'images', slots, missing, prompt, promptTruncated, promptFromJob: !!job }
}

// ---------------------------------------------------------------------------------------------
// Job → bridge canvas node (Job & đơn nạp)
// ---------------------------------------------------------------------------------------------

/** Which bridge canvas node a job ran on, seen from the open project. */
export type JobNodeOwner = { kind: 'scene' | 'legacy'; code: string } | { kind: 'other' }

/**
 * canvas_node_id → owner, for the open project: the node of each of its scenes ('scene', "S03") and the node builds
 * before per-project nodes named by the scene id alone ('legacy': a duplicated / re-imported project may share it).
 * Any other id — another project's, a deleted scene's — is not in the map ('other').
 */
export function jobNodeOwners(projectId: string, scenes: readonly Pick<Scene, 'id' | 'order'>[]): Map<string, JobNodeOwner> {
  const m = new Map<string, JobNodeOwner>()
  for (const s of scenes) m.set(canvasNodeId(s.id), { kind: 'legacy', code: sceneCode(s.order) })
  for (const s of scenes) m.set(sceneNodeId(projectId, s.id), { kind: 'scene', code: sceneCode(s.order) })
  return m
}

/** The job line's node label and its tooltip (which starts with the full canvas_node_id). */
export function jobNodeText(nodeId: string, owner: JobNodeOwner | undefined): { label: string; title: string } {
  const head = `canvas_node_id: ${nodeId}\n`
  if (owner?.kind === 'scene') return { label: `node ${owner.code}`, title: `${head}Node của cảnh ${owner.code} trong dự án đang mở.` }
  if (owner?.kind === 'legacy') {
    return {
      label: `node cũ ${owner.code}`,
      title: `${head}Node đặt theo riêng id cảnh (bản SanoVids cũ): dự án nhân bản hoặc nhập lại từ cùng tệp có thể dùng chung node này.`,
    }
  }
  return { label: 'node khác', title: `${head}Không thuộc cảnh nào đang có trong dự án đang mở (dự án khác, hoặc cảnh đã xoá).` }
}

// ---------------------------------------------------------------------------------------------
// "Tạo job như trên trang canvasapp" (Job & đơn nạp)
// ---------------------------------------------------------------------------------------------

export const SITE_JOB_HINT =
  'Giống bấm “Tạo video” trên node của phiên “SanoVids bridge” ở canvasapp: lưu canvas, tạo job với client_request_id ngẫu nhiên (không phải của take nào), trừ credit dev. SanoVids không biết job này cho tới khi bạn dùng “Nhập job” (Hàng đợi, Cài đặt hoặc nút “Nhập” ở dòng job).'

/** "S01 · Ôm nhau — Seedance 2.5 · 15s · 1080P" — a video node of the bridge session, named after its scene. */
export function siteNodeLabel(node: SiteNodeInfo, owner: JobNodeOwner | undefined, title?: string): string {
  const who =
    owner?.kind === 'scene' ? `${owner.code}${title ? ` · ${title}` : ''}` : owner?.kind === 'legacy' ? `node cũ ${owner.code}${title ? ` · ${title}` : ''}` : 'node lạ'
  const model = node.model ? MODELS[node.model].name : 'model lạ'
  const what = [model, node.duration !== null ? `${node.duration}s` : null, node.resolution ? node.resolution.toUpperCase() : null].filter(Boolean).join(' · ')
  return `${who} — ${what}`
}

/** The toast after "Tạo job trên trang (giả lập)". */
export function siteJobToast(res: DevSiteJobResult): { text: string; ok: boolean } {
  if (!res.ok) return { text: `canvasapp giả lập không tạo job: ${res.detail}`, ok: false }
  return { text: `Đã tạo job #${res.number} trên canvasapp giả lập (như trên trang) — đã trừ ${res.cost} credit dev. Dùng “Nhập job” để đưa vào dự án.`, ok: true }
}

// ---------------------------------------------------------------------------------------------
// Model (video-profiles): what SanoVids knows (Trạng thái › Model)
// ---------------------------------------------------------------------------------------------

/**
 * The line under the model toggles: whether SanoVids has read /api/video-profiles of the simulated site, when, and
 * what it does with it (providers limitsInfo / settingsLimits of 'dev').
 */
export function limitsStatusText(info: LimitsInfo, limits: Pick<SettingsLimits, 'source' | 'firm'>): string {
  const last = info.lastAttempt
  const lastNote =
    last && info.source !== 'none' && last.result !== 'read'
      ? last.result === 'login'
        ? ` Lần đọc lại lúc ${logTime(last.at)}: chưa đăng nhập (401) — vẫn dùng lần đọc trước.`
        : last.result === 'kept'
          ? ` Lần đọc lại lúc ${logTime(last.at)} lỗi — vẫn dùng lần đọc trước.`
          : ''
      : ''
  if (info.source === 'none') {
    if (info.reading) return 'SanoVids đang đọc cấu hình model…'
    const tried = last?.result === 'login' ? ` Lần thử lúc ${logTime(last.at)}: chưa đăng nhập (401).` : ''
    return `SanoVids chưa đọc cấu hình model — đọc khi mở cấu hình video của một cảnh, hộp Chạy, hoặc trước lần gửi đầu (cần đăng nhập tài khoản giả lập).${tried}`
  }
  const at = info.at !== null ? logTime(info.at) : '—'
  if (info.source === 'fallback') {
    return `SanoVids không đọc được lúc ${at} — đang dùng cấu hình dự phòng như trang canvasapp (MiniMax-H3 khoá): chỉ cảnh báo, chưa khoá lựa chọn nào. Không tự đọc lại theo giờ: đọc lại khi mở cấu hình video của một cảnh / hộp Chạy (sau 1 phút), trước lần gửi tiếp theo (sau 1 phút nếu chính một lần gửi đọc hỏng) hoặc khi bấm “Đọc lại ngay”.${lastNote}`
  }
  if (!limits.firm) {
    return `SanoVids đọc lúc ${at} — đã quá 10 phút: inspector chỉ còn cảnh báo, lần gửi sau đọc lại trước.${lastNote}`
  }
  return `SanoVids đọc lúc ${at} — inspector, nút Chạy và hộp Chạy khoá đúng những gì đang tắt ở đây lúc đó.${lastNote}`
}

/**
 * Does what SanoVids knows (a 'server' read) differ from the toggles set here now? Then "Đọc lại ngay" shows the
 * change (SanoVids re-reads by itself only after 10 minutes, like the real site's cache). Mirrors canvasapp's own
 * rules: MiniMax-H3's narrowed lists are ignored (its built-in lists win), Seedance's are used as sent.
 */
export function limitsDifferFromConfig(limits: SettingsLimits, models: DevConfig['models']): boolean {
  if (limits.source !== 'server') return false
  for (const id of Object.keys(MODELS) as ModelId[]) {
    const spec = MODELS[id]
    const t = models[id]
    if (!t) continue
    const base = normalizeSettings({ model: id })
    const refused = (field: LimitField, v: string | number) => fieldBlock(limits, base, field, v) !== null
    const narrows = id !== 'minimax_h3'
    if (refused('model', id) !== !t.can_create) return true
    for (const m of spec.modes) if (refused('mode', m) !== t.disabled_modes.includes(m)) return true
    for (const d of spec.durations) if (refused('duration', d) !== (narrows && (t.off_durations ?? []).includes(d))) return true
    for (const r of spec.resolutions) if (refused('resolution', r) !== (narrows && (t.off_resolutions ?? []).includes(r))) return true
    for (const r of spec.ratios) if (refused('ratio', r) !== (narrows && (t.off_ratios ?? []).includes(r))) return true
  }
  return false
}
