// What the auto-update UI shows (top-bar pill, "Cập nhật SanoVids" dialog, Settings → Cập nhật, toasts) — pure: no
// stores, no React, no bridge. Tested in __tests__/updateModel.test.ts. The contract is lib/updateTypes.ts.
//
// ---- API ----
//   KIND_LABEL / STATUS_LABEL                 'Bản cài' / 'Bản portable' / 'Bản phát triển'; short status words.
//   UPDATE_ERROR_TEXT                         the fixed Vietnamese error texts (same as electron/updater-rules.cjs).
//   parseUpdateState(raw, fallback)           untrusted state (IPC / dev bridge) → a valid UpdateState.
//   noteBlocks(notes)                         release notes → text blocks (heading / list item / paragraph). Never HTML.
//   formatBytes / formatSpeed / formatPercent / formatReleaseDate / lastCheckText   numbers and dates in Vietnamese.
//   installBlockers(counts)                   "đang có việc chưa xong" lines shown before restarting.
//   pillView(state, ctx)                      the top-bar pill (null = hidden).
//   dialogView(state, ctx)                    status text, hint, callout and buttons of the dialog.
//   settingsStatusLine / settingsIntroTitle / autoDownloadNote   Settings → Cập nhật texts.
//   manualCheckToast(state, result)           the toast after "Kiểm tra ngay" (automatic checks never toast).
//   noticeToast(notice)                       the toast after a restart that installed (or failed to install) an update.
import {
  UPDATE_NOTES_MAX,
  type UpdateError,
  type UpdateErrorCode,
  type UpdateKind,
  type UpdateNotice,
  type UpdateResult,
  type UpdateState,
  type UpdateStatus,
} from './updateTypes'

export const UPDATE_KINDS: readonly UpdateKind[] = ['installer', 'portable', 'dev']
export const UPDATE_STATUSES: readonly UpdateStatus[] = ['idle', 'checking', 'none', 'available', 'downloading', 'ready', 'error', 'unsupported']
export const UPDATE_ERROR_CODES: readonly UpdateErrorCode[] = ['offline', 'no-release', 'rate-limited', 'checksum', 'signature', 'disk', 'install-failed', 'failed']

export const KIND_LABEL: Record<UpdateKind, string> = { installer: 'Bản cài', portable: 'Bản portable', dev: 'Bản phát triển' }

export const STATUS_LABEL: Record<UpdateStatus, string> = {
  idle: 'Chưa kiểm tra',
  checking: 'Đang kiểm tra…',
  none: 'Bản mới nhất',
  available: 'Có bản mới',
  downloading: 'Đang tải',
  ready: 'Sẵn sàng cập nhật',
  error: 'Lỗi',
  unsupported: 'Không tự cập nhật',
}

/** Fixed error texts (main sends the same ones; the development-mode simulation uses these). */
export const UPDATE_ERROR_TEXT: Record<UpdateErrorCode, string> = {
  offline: 'Không kết nối được máy chủ cập nhật.',
  'no-release': 'Chưa tìm thấy bản cập nhật nào trên trang tải về.',
  'rate-limited': 'Máy chủ cập nhật đang bận.',
  checksum: 'File cập nhật tải về bị lỗi (sai mã kiểm tra) nên đã bị bỏ.',
  signature: 'File cập nhật không có chữ ký hợp lệ nên đã bị từ chối.',
  disk: 'Ổ đĩa không đủ chỗ để tải bản cập nhật.',
  'install-failed': 'Không khởi động được trình cài bản cập nhật.',
  failed: 'Không kiểm tra được bản cập nhật.',
}

/** Texts every surface shares. */
export const UPDATE_UNSUPPORTED_TEXT = 'Bản này không tự cập nhật.'

// ---------------------------------------------------------------------------------------------
// Validation of a received state
// ---------------------------------------------------------------------------------------------

const VERSION_RE = /^\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?$/

/** A release version as main sends it (x.y.z with an optional suffix, at most 64 chars). */
export function isUpdateVersion(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && VERSION_RE.test(v)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const inList = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
const cap = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)

function parseError(v: unknown): UpdateError | undefined {
  if (!isObj(v) || !inList(UPDATE_ERROR_CODES, v.code) || typeof v.message !== 'string') return undefined
  return { code: v.code, message: v.message.slice(0, 300) }
}

function parseNotice(v: unknown): UpdateNotice | undefined {
  if (!isObj(v) || !isUpdateVersion(v.version)) return undefined
  if (v.kind === 'updated' && typeof v.from === 'string') return { kind: 'updated', from: v.from.slice(0, 64), version: v.version }
  if (v.kind === 'install-failed') return { kind: 'install-failed', version: v.version }
  return undefined
}

/**
 * An update state received over IPC (or from the development-mode bridge) → a valid UpdateState. Enums are checked,
 * strings capped, numbers finite and ≥ 0 (percent 0..100); a wrong optional field is dropped. A wrong root, kind or
 * status gives `fallback` (the state the UI already shows).
 */
export function parseUpdateState(raw: unknown, fallback: UpdateState): UpdateState {
  if (!isObj(raw) || !inList(UPDATE_KINDS, raw.kind) || !inList(UPDATE_STATUSES, raw.status)) return fallback
  const out: UpdateState = {
    kind: raw.kind,
    current: typeof raw.current === 'string' ? raw.current.slice(0, 64) : fallback.current,
    status: raw.status,
    autoDownload: typeof raw.autoDownload === 'boolean' ? raw.autoDownload : fallback.autoDownload,
  }
  if (isUpdateVersion(raw.version)) out.version = raw.version
  const releaseDate = cap(raw.releaseDate, 40)
  if (releaseDate) out.releaseDate = releaseDate
  const notes = cap(raw.notes, UPDATE_NOTES_MAX)
  if (notes !== undefined) out.notes = notes
  const size = num(raw.size)
  if (size !== undefined) out.size = size
  const percent = num(raw.percent)
  if (percent !== undefined) out.percent = Math.min(100, percent)
  for (const k of ['transferred', 'total', 'bytesPerSecond', 'lastCheck'] as const) {
    const n = num(raw[k])
    if (n !== undefined) out[k] = n
  }
  const error = parseError(raw.error)
  if (error) out.error = error
  const notice = parseNotice(raw.notice)
  if (notice) out.notice = notice
  return out
}

// ---------------------------------------------------------------------------------------------
// Release notes → text blocks (rendered as text only)
// ---------------------------------------------------------------------------------------------

export interface NoteBlock {
  kind: 'h' | 'li' | 'p'
  text: string
}

const MAX_BLOCKS = 80
const MAX_BLOCK_CHARS = 500

/** Real HTML element names (same list as electron/updater-rules.cjs): only these are stripped, "<phiên bản>" stays text. */
const HTML_TAGS =
  'a|abbr|article|aside|b|blockquote|body|br|button|caption|center|code|col|colgroup|dd|del|details|dfn|div|dl|dt|em|embed|' +
  'figcaption|figure|font|footer|form|g-emoji|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|kbd|li|link|main|mark|meta|' +
  'nav|object|ol|p|picture|pre|q|s|samp|script|section|small|source|span|strike|strong|style|sub|summary|sup|svg|table|' +
  'tbody|td|template|tfoot|th|thead|time|title|tr|tt|u|ul|var|video'
const HTML_TAG_RE = new RegExp(`</?(?:${HTML_TAGS})(?=[\\s/>])[^>]*>`, 'gi')

function cleanInline(s: string): string {
  return s
    .replace(HTML_TAG_RE, '') // real tags never render: "<b>x</b>" shows "x" (anything else is plain text for React)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // ![alt](url) → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) → text
    .replace(/\*\*|__|`/g, '')
    .trim()
}

/**
 * Release notes (plain text, markdown-ish) → one block per non-empty line: "## …" heading, "- / * / •" list item,
 * else a paragraph. Markdown marks, links and real HTML tags are stripped; at most 80 blocks of 500 chars.
 */
export function noteBlocks(notes: string | null | undefined): NoteBlock[] {
  if (typeof notes !== 'string' || !notes) return []
  const out: NoteBlock[] = []
  for (const line of notes.replace(/\r\n?/g, '\n').split('\n')) {
    if (out.length >= MAX_BLOCKS) break
    if (!line.trim()) continue
    let kind: NoteBlock['kind'] = 'p'
    let body = line
    if (/^#{1,6}\s/.test(line)) {
      kind = 'h'
      body = line.replace(/^#{1,6}\s+/, '')
    } else if (/^\s*[-*•]\s+/.test(line)) {
      kind = 'li'
      body = line.replace(/^\s*[-*•]\s+/, '')
    }
    const text = cleanInline(body).slice(0, MAX_BLOCK_CHARS)
    if (text) out.push({ kind, text })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Numbers and dates
// ---------------------------------------------------------------------------------------------

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** Bytes → "93,5 MB" (1024 base, comma decimal, one decimal under 100 — dropped when it is ",0"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  let v = n
  let u = 0
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024
    u++
  }
  if (u === 0) return `${Math.round(v)} B`
  const text = v < 100 ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : String(Math.round(v))
  return `${text.replace('.', ',')} ${UNITS[u]}`
}

/** Bytes per second → "2,1 MB/giây". */
export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/giây`
}

/** 0..100 → "42%" (floored, clamped). */
export function formatPercent(p: number | undefined): string {
  const v = typeof p === 'number' && Number.isFinite(p) ? Math.floor(Math.min(100, Math.max(0, p))) : 0
  return `${v}%`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** ISO date → "dd/mm/yyyy" (local date), '' when missing or unreadable. */
export function formatReleaseDate(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

/** When the last check finished: "vừa xong" · "5 phút trước" · "lúc 14:05 hôm nay" · "lúc 14:05, 02/10". */
export function lastCheckText(ts: number, now: number): string {
  const ago = now - ts
  if (ago < 60_000) return 'vừa xong'
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} phút trước`
  const d = new Date(ts)
  const n = new Date(now)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return `lúc ${time} hôm nay`
  return `lúc ${time}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}

// ---------------------------------------------------------------------------------------------
// Work in progress before a restart
// ---------------------------------------------------------------------------------------------

export interface InstallBlockerCounts {
  /** Takes waiting in the queue. */
  queued: number
  /** Takes running (sent or being sent). */
  processing: number
  /** Running takes whose submit has no remote id yet (being sent right now). */
  sending: number
  /** Auto-downloads waiting for a folder permission (lost on restart). */
  pendingDownloads: number
  /** A canvasapp top-up order is being confirmed. */
  topupInFlight: boolean
}

/** Lines of "Đang có việc chưa xong:" (nothing → no blockers). */
export function installBlockers(c: InstallBlockerCounts): string[] {
  const out: string[] = []
  const jobs = [c.processing > 0 ? `${c.processing} video đang tạo` : '', c.queued > 0 ? `${c.queued} video đang chờ` : ''].filter(Boolean)
  if (jobs.length) out.push(jobs.join(' · '))
  if (c.sending > 0) out.push(`${c.sending} video đang được gửi đi — SanoVids sẽ đợi gửi xong rồi mới khởi động lại.`)
  if (c.topupInFlight) out.push('Đang nạp credit — nên đợi xong rồi hãy cập nhật.')
  if (c.pendingDownloads > 0) out.push(`${c.pendingDownloads} video đang chờ lưu vào thư mục — sẽ mất nếu khởi động lại.`)
  return out
}

// ---------------------------------------------------------------------------------------------
// Top-bar pill
// ---------------------------------------------------------------------------------------------

export type PillTone = 'available' | 'downloading' | 'ready' | 'waiting'

export interface PillView {
  tone: PillTone
  /** Shown only on wide windows (.tb-hide-md), before `short`. */
  long: string
  /** Always visible. */
  short: string
  title: string
  version: string
}

/** "3 video", or "các việc đang dở" when the wait is for something else (a top-up, downloads waiting for a folder). */
const waitWhat = (activeJobs: number | undefined) => (activeJobs && activeJobs > 0 ? `${activeJobs} video` : 'các việc đang dở')

/** The pill of the top bar, or null (nothing to say: idle, checking, up to date, errors, unsupported, dev builds). */
export function pillView(state: UpdateState, ctx: { installWhenIdle: boolean; activeJobs: number }): PillView | null {
  const v = state.version
  if (state.kind === 'dev' || !v) return null
  if (state.kind === 'portable') {
    return state.status === 'available' ? { tone: 'available', long: 'Bản mới ', short: v, title: `Có bản SanoVids ${v} — bấm để xem cách tải`, version: v } : null
  }
  switch (state.status) {
    case 'available':
      return { tone: 'available', long: 'Có bản ', short: v, title: `Có bản SanoVids ${v} — bấm để xem`, version: v }
    case 'downloading': {
      const p = formatPercent(state.percent)
      return { tone: 'downloading', long: 'Đang tải ', short: p, title: `Đang tải bản SanoVids ${v} (${p}). Bạn cứ làm việc bình thường.`, version: v }
    }
    case 'ready':
      if (ctx.installWhenIdle) {
        return {
          tone: 'waiting',
          long: '',
          short: 'Chờ cập nhật',
          title: `SanoVids sẽ khởi động lại để cập nhật lên ${v} khi xong ${waitWhat(ctx.activeJobs)}. Bấm để xem.`,
          version: v,
        }
      }
      return { tone: 'ready', long: 'Cập nhật ', short: v, title: `Bản SanoVids ${v} đã tải xong — bấm để khởi động lại và cập nhật`, version: v }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------------------------

export type UpdateActionId = 'restart' | 'later' | 'installWhenIdle' | 'installNow' | 'cancelWait' | 'download' | 'openPage' | 'retry' | 'close'
export type InstallBusy = null | 'waiting-send' | 'saving' | 'restarting'

export interface UpdateDialogAction {
  id: UpdateActionId
  label: string
  primary?: boolean
  title?: string
}

export interface UpdateDialogCtx {
  /** installBlockers(...) right now. */
  blockers: string[]
  installWhenIdle: boolean
  /** The renderer pref (lib/updatePrefs), the source of truth. */
  autoDownload: boolean
  busy: InstallBusy
  /** Queued + running takes (the "khi xong N video" number). */
  activeJobs?: number
}

export interface UpdateDialogView {
  statusText: string
  hint?: string
  /** lines: a list (what is not finished); note: a paragraph under it. */
  callout?: { title: string; lines: string[]; note?: string }
  actions: UpdateDialogAction[]
  /** Replaces the primary button's label (with a spinner) while installing; every button is then disabled. */
  busyText?: string
  /** Show the progress bar (downloading). */
  showProgress: boolean
  /** Show "Có gì mới" (a newer version is known). */
  showNotes: boolean
}

export const BUSY_TEXT: Record<Exclude<InstallBusy, null>, string> = {
  'waiting-send': 'Đang đợi gửi xong video…',
  saving: 'Đang lưu dự án…',
  restarting: 'Đang khởi động lại…',
}

const CLOSE: UpdateDialogAction = { id: 'close', label: 'Đóng' }
const LATER: UpdateDialogAction = { id: 'later', label: 'Để sau' }
const READY_TEXT = 'Đã tải xong. Khởi động lại để cập nhật ngay — dự án, video và cài đặt giữ nguyên.'
const READY_BUSY_TEXT = 'Đã tải xong. Có thể cập nhật khi xong việc đang dở, hoặc cập nhật ngay — dự án, video và cài đặt giữ nguyên.'
const STUCK_NOTE = 'Nếu video bị kẹt (hết credit, cần đăng nhập…), bấm “Cập nhật ngay” hoặc “Huỷ chờ”.'
const LATER_HINT = 'Chọn “Để sau” thì bản mới tự cài khi bạn tắt SanoVids.'
const SAFE_NOW =
  'Cập nhật ngay vẫn an toàn: video đang tạo vẫn chạy tiếp trên máy chủ và SanoVids theo dõi lại sau khi mở lại; video đang chờ sẽ được gửi sau đó. Không bị trừ credit hai lần.'

/** "Đang tải về… 42% · 41 MB / 98 MB · 2,1 MB/giây" (unknown parts left out). */
export function downloadLine(state: Pick<UpdateState, 'percent' | 'transferred' | 'total' | 'bytesPerSecond'>): string {
  let text = `Đang tải về… ${formatPercent(state.percent)}`
  if (state.total && state.transferred !== undefined) text += ` · ${formatBytes(state.transferred)} / ${formatBytes(state.total)}`
  if (state.bytesPerSecond) text += ` · ${formatSpeed(state.bytesPerSecond)}`
  return text
}

/** Everything the "Cập nhật SanoVids" dialog shows for a state (E.2 of the spec). */
export function dialogView(state: UpdateState, ctx: UpdateDialogCtx): UpdateDialogView {
  const base = { showProgress: false, showNotes: false }
  const busyText = ctx.busy ? BUSY_TEXT[ctx.busy] : undefined
  if (state.kind === 'dev' || state.status === 'unsupported') {
    return { ...base, statusText: state.error?.message ?? UPDATE_UNSUPPORTED_TEXT, actions: [CLOSE] }
  }
  switch (state.status) {
    case 'idle':
      return { ...base, statusText: 'Chưa kiểm tra trong lần mở này.', actions: [{ id: 'retry', label: 'Kiểm tra ngay', primary: true }, CLOSE] }
    case 'checking':
      return { ...base, statusText: 'Đang kiểm tra bản mới…', actions: [CLOSE] }
    case 'none':
      return { ...base, statusText: `Bạn đang dùng bản mới nhất (${state.current}).`, actions: [CLOSE] }
    case 'error':
      return {
        ...base,
        showNotes: !!state.version,
        statusText: `${state.error?.message ?? UPDATE_ERROR_TEXT.failed} SanoVids sẽ tự thử lại sau.`,
        actions: [{ id: 'retry', label: 'Thử lại', primary: true }, CLOSE],
      }
    case 'available':
      if (state.kind === 'portable') {
        return {
          ...base,
          showNotes: true,
          statusText:
            'Bản portable không tự cài được. Tải bản mới ở trang tải về rồi dùng file đó thay file cũ — dự án và cài đặt giữ nguyên. Muốn từ nay tự cập nhật, hãy cài bản Setup.',
          actions: [{ id: 'openPage', label: 'Tải bản mới', primary: true, title: 'Mở trang tải về trên GitHub trong trình duyệt' }, LATER],
        }
      }
      if (ctx.autoDownload) return { ...base, showNotes: true, statusText: 'Đang chuẩn bị tải về…', actions: [CLOSE] }
      return {
        ...base,
        showNotes: true,
        statusText: 'Bấm “Tải bản cập nhật” để tải về. Trong lúc tải bạn vẫn làm việc bình thường.',
        actions: [{ id: 'download', label: 'Tải bản cập nhật', primary: true }, LATER],
      }
    case 'downloading':
      return {
        showProgress: true,
        showNotes: true,
        statusText: downloadLine(state),
        hint: 'Bạn cứ làm việc bình thường — tải xong SanoVids sẽ báo.',
        actions: [CLOSE],
      }
    case 'ready': {
      const hint = state.error ? state.error.message : LATER_HINT
      if (ctx.installWhenIdle) {
        return {
          ...base,
          showNotes: true,
          statusText: 'Đã tải xong.',
          callout: { title: `Sẽ tự khởi động lại để cập nhật khi xong ${waitWhat(ctx.activeJobs)}.`, lines: ctx.blockers, note: STUCK_NOTE },
          actions: [{ id: 'installNow', label: 'Cập nhật ngay', primary: true }, { id: 'cancelWait', label: 'Huỷ chờ' }, CLOSE],
          busyText,
        }
      }
      if (ctx.blockers.length) {
        return {
          ...base,
          showNotes: true,
          statusText: READY_BUSY_TEXT,
          hint,
          callout: { title: 'Đang có việc chưa xong:', lines: ctx.blockers, note: SAFE_NOW },
          actions: [{ id: 'installWhenIdle', label: 'Cập nhật khi xong', primary: true }, { id: 'installNow', label: 'Cập nhật ngay' }, LATER],
          busyText,
        }
      }
      return {
        ...base,
        showNotes: true,
        statusText: READY_TEXT,
        hint,
        actions: [{ id: 'restart', label: 'Khởi động lại để cập nhật', primary: true }, LATER],
        busyText,
      }
    }
    default:
      return { ...base, statusText: UPDATE_UNSUPPORTED_TEXT, actions: [CLOSE] }
  }
}

// ---------------------------------------------------------------------------------------------
// Settings → Cập nhật
// ---------------------------------------------------------------------------------------------

/** "Phiên bản 0.5.0 · Bản cài" (in a browser: "Phiên bản 0.5.0 · Trình duyệt"). */
export function settingsIntroTitle(state: UpdateState, web: boolean): string {
  const where = web && state.kind === 'dev' ? 'Trình duyệt' : KIND_LABEL[state.kind]
  return state.current ? `Phiên bản ${state.current} · ${where}` : where
}

/** The status line under the intro title. */
export function settingsStatusLine(state: UpdateState, ctx: { web: boolean; autoDownload: boolean }): string {
  const v = state.version ?? ''
  switch (state.status) {
    case 'idle':
      return 'Chưa kiểm tra trong lần mở này.'
    case 'checking':
      return 'Đang kiểm tra…'
    case 'none':
      return 'Bạn đang dùng bản mới nhất.'
    case 'available':
      if (state.kind === 'installer') return ctx.autoDownload ? `Có bản ${v} — đang tải về.` : `Có bản ${v} — bấm “Xem chi tiết” để tải.`
      return `Có bản ${v} — tải ở trang tải về.`
    case 'downloading':
      return `Đang tải bản ${v}… ${formatPercent(state.percent)}`
    case 'ready':
      return `Bản ${v} đã tải xong — khởi động lại để cập nhật (hoặc tự cài khi tắt app).`
    case 'error':
      return state.error?.message ?? UPDATE_ERROR_TEXT.failed
    case 'unsupported':
    default:
      if (state.error) return state.error.message
      return ctx.web && state.kind === 'dev'
        ? 'Trên trình duyệt luôn dùng bản mới nhất; tự cập nhật chỉ có ở bản cài Windows.'
        : 'Bản chạy từ mã nguồn không tự cập nhật.'
  }
}

/** Why "Tự động tải bản cập nhật" is disabled (null when it applies: installer builds). */
export function autoDownloadNote(kind: UpdateKind): string | null {
  if (kind === 'installer') return null
  return kind === 'portable' ? 'Bản portable không tự cài — chỉ báo có bản mới.' : 'Chỉ có ở bản cài (Setup).'
}

/** "Xem chi tiết" is offered for these statuses. */
export const hasUpdateDetails = (s: UpdateState): boolean => s.kind !== 'dev' && (s.status === 'available' || s.status === 'downloading' || s.status === 'ready')

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

export type UpdateToastTone = 'info' | 'success' | 'warning' | 'error'

export interface ManualCheckToast {
  text: string
  tone: UpdateToastTone
  /** 'restart': "Khởi động lại" · 'open': "Xem" (opens the dialog). */
  action?: 'restart' | 'open'
}

/** The toast after "Kiểm tra ngay": `state` is the state read AFTER the check resolved. */
export function manualCheckToast(state: UpdateState, result: UpdateResult): ManualCheckToast | null {
  if (!result.ok) {
    if (result.code === 'unsupported') return { text: UPDATE_UNSUPPORTED_TEXT, tone: 'info' }
    if (result.code === 'busy') return { text: result.message, tone: 'info' }
    return { text: state.status === 'error' && state.error ? state.error.message : result.message, tone: 'error' }
  }
  const v = state.version ?? ''
  switch (state.status) {
    case 'none':
      return { text: `Bạn đang dùng bản mới nhất (${state.current}).`, tone: 'success' }
    case 'available':
    case 'downloading':
      if (state.kind === 'installer' && (state.status === 'downloading' || state.autoDownload)) return { text: `Có bản ${v} — đang tải về trong nền.`, tone: 'info' }
      return { text: `Có bản ${v}.`, tone: 'info', action: 'open' }
    case 'ready':
      return { text: `Bản ${v} đã tải xong.`, tone: 'success', action: 'restart' }
    case 'error':
      return { text: state.error?.message ?? UPDATE_ERROR_TEXT.failed, tone: 'error' }
    case 'unsupported':
      return { text: UPDATE_UNSUPPORTED_TEXT, tone: 'info' }
    default:
      return null
  }
}

export interface NoticeToast {
  text: string
  tone: UpdateToastTone
  ms?: number
  /** 'openPage': "Trang tải về". */
  action?: 'openPage'
}

/** The toast of this launch's notice (once per page load). */
export function noticeToast(notice: UpdateNotice): NoticeToast {
  if (notice.kind === 'updated') return { text: `Đã cập nhật SanoVids lên ${notice.version}.`, tone: 'success', ms: 8000 }
  return { text: `Chưa cài được bản ${notice.version}. SanoVids sẽ thử lại khi bạn tắt app.`, tone: 'warning', action: 'openPage' }
}
