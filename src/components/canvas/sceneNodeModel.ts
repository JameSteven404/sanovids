// Pure decisions of the scene node (the node IS the editor: approved design E0 v3, "Số đo cho người làm app").
// Sizes are flow px at zoom 100%. No React / DOM / store imports (unit-tested in __tests__/sceneNodeModel.test.ts).
import { formatCredits, type CreditKind } from '../../lib/credits'
import type { JobStatus, Mode, VideoSettings } from '../../core/types'
import { transformFrameRatio } from '../../providers/canvasapp/mapping'

/**
 * Vertical recipe of a node (inside its 1px border): head 32 · settings line 24 + gap 6 · prompt (flexible, 194 at
 * the default 352 × 304) · [placeholder strip 6 + 22] · foot 6 + 32 · [reason line 16] · bottom padding 8.
 * The settings line opened in place (choice 2B) adds three 19px rows: the prompt gives up 3 lines, the node never grows.
 */
export const NODE = {
  border: 1,
  padX: 8,
  head: 32,
  settings: 24,
  gap: 6,
  settingsRows: 57,
  strip: 22,
  foot: 32,
  why: 16,
  padBottom: 8,
  /** Prompt text: 13.5 / 19px, insets top 6 · bottom 17 (counter line) · left 10 · right 16 (10 + the 6px scrollbar gutter). */
  promptLine: 19,
  promptPadTop: 6,
  promptPadBottom: 17,
  promptPadLeft: 10,
  promptPadRight: 16,
  /** Run button: min width ready, compact ("▶ 20 credit"). */
  runMin: 150,
  runCompact: 96,
  /** Foot thumbnails. */
  thumb: 28,
  thumbGap: 6,
  maxThumbs: 5,
} as const

/** Top of the prompt box inside the border: where the two dots sit (= the middle of an unresized take's poster). */
export const PROMPT_TOP = NODE.head + NODE.settings + NODE.gap

export interface NodeParts {
  /** The red placeholder strip ("Chữ đỏ chờ ảnh") is shown. */
  strip?: boolean
  /** The long-reason line under the foot is shown. */
  why?: boolean
  /** The settings line is opened in place (three rows of buttons). */
  settingsOpen?: boolean
}

/** Height of the prompt box of a node `h` px tall (outer height, borders included). */
export function promptBoxHeight(h: number, parts: NodeParts = {}): number {
  const inner = h - 2 * NODE.border
  const used =
    NODE.head +
    NODE.settings +
    NODE.gap +
    (parts.settingsOpen ? NODE.settingsRows : 0) +
    (parts.strip ? NODE.gap + NODE.strip : 0) +
    NODE.gap +
    NODE.foot +
    (parts.why ? NODE.why : 0) +
    NODE.padBottom
  return Math.max(0, inner - used)
}

/** Lines of prompt text a box `boxH` px tall shows (the static text's line-clamp; at least 1). */
export function promptLinesFor(boxH: number): number {
  return Math.max(1, Math.floor((boxH - NODE.promptPadTop - NODE.promptPadBottom) / NODE.promptLine))
}

/** Width of the text column of the prompt box in a node `w` px wide. */
export function promptTextWidth(w: number): number {
  return Math.max(40, w - 2 * NODE.border - 2 * NODE.padX - 2 - NODE.promptPadLeft - NODE.promptPadRight)
}

/**
 * The start of the prompt worth rendering as static text: always more than `lines` lines of a `textW` px column can
 * show (13.5px text ≈ 6.4px a character; +40% slack), never the whole 20,000-character prompt — 100 nodes of long
 * prompts would otherwise lay out megabytes of hidden text. Cut at the (lines + 1)-th line break at the latest.
 * The result is always a prefix of `prompt` (caretFromExcerptHit maps a click in it to the prompt's offset).
 */
export function staticExcerpt(prompt: string, lines: number, textW: number): string {
  const perLine = Math.max(8, Math.floor(textW / 6.4))
  const cap = Math.ceil(lines * perLine * 1.4) + 16
  let end = Math.min(prompt.length, cap)
  let breaks = 0
  for (let i = 0; i < end; i++) {
    if (prompt.charCodeAt(i) === 10 && ++breaks > lines) {
      end = i
      break
    }
  }
  return end >= prompt.length ? prompt : prompt.slice(0, end)
}

/** Character counter of the node: "4.478 / 20.000" (code points, like compile.ts). */
export function nodeCounter(prompt: string, limit: number): { text: string; over: boolean } {
  const count = [...prompt].length
  return { text: `${count.toLocaleString('vi-VN')} / ${limit.toLocaleString('vi-VN')}`, over: count > limit }
}

// ---------------- head: compact take status "● 2 · ★T2" ----------------
export interface StatusInput {
  count: number
  status: JobStatus | null
  progress: number
  starredNumber: number | null
  active: number
}
export type StatusTone = 'none' | 'ok' | 'going' | 'wait' | 'fail'

const LATEST: Record<JobStatus, string> = {
  queued: 'đang chờ',
  processing: 'đang tạo',
  completed: 'xong',
  failed: 'lỗi',
  cancelled: 'đã huỷ',
}

/** The head's compact take status and its full sentence (title). */
export function compactStatus(s: StatusInput): { text: string; title: string; tone: StatusTone } {
  if (!s.count) return { text: 'chưa có take', title: 'Chưa có take nào — bấm Tạo video để tạo T1.', tone: 'none' }
  const star = s.starredNumber !== null ? ` · ★T${s.starredNumber}` : ''
  const title = `${s.count} take${s.starredNumber !== null ? ` · đã chọn T${s.starredNumber}` : ''} · take mới nhất: ${s.status ? LATEST[s.status] : '—'}`
  if (s.status === 'processing') return { text: `${Math.max(0, Math.min(100, Math.round(s.progress)))}%`, title, tone: 'going' }
  if (s.active > 0) return { text: `${s.count}${star} · chờ`, title, tone: 'wait' }
  return { text: `${s.count}${star}`, title, tone: s.status === 'failed' ? 'fail' : s.status === 'completed' ? 'ok' : 'none' }
}

// ---------------- settings line (choice 2B: one summary line, opened in place) ----------------
/** Short mode names on the node (the full name is the title: modeLabel). */
export const MODE_SHORT: Record<Mode, string> = { t2v: 'Chữ→Video', i2v: 'Ảnh→Video', transform: 'Đầu→cuối' }

/** The ratio of an H3 "Đầu→cuối" scene: none is picked, canvasapp takes it from the two frames. */
export const FRAME_RATIO_LABEL = 'theo ảnh'

/**
 * "SD 2.5 · 30s · 480P · 16:9 · Nháp". `modelShort` = MODELS[model].short (or a newer build's model badge);
 * `modes` = how many modes the model has (the mode is named only when there is a choice, MiniMax-H3);
 * `preset` = the applied preset's name, null = "Tuỳ chỉnh". H3 "Đầu→cuối" sends no ratio (mapping: the frames give
 * it): "theo ảnh" instead of the stored one.
 */
export function settingsSummary(s: VideoSettings, modelShort: string, modes: number, preset: string | null): string {
  const parts = [modelShort]
  if (modes > 1) parts.push(MODE_SHORT[s.mode] ?? String(s.mode))
  parts.push(`${s.duration}s`, String(s.resolution).toUpperCase(), s.mode === 'transform' ? FRAME_RATIO_LABEL : s.ratio, preset ?? 'Tuỳ chỉnh')
  return parts.join(' · ')
}

/**
 * Hover text of the read-only "theo ảnh" ratio (H3 "Đầu→cuối"): the ratio both frames share, or why canvasapp would
 * refuse them (providers/canvasapp transformFrameRatio). `first` / `last` = each frame's ratio (ratioFromDimensions:
 * null = not a supported ratio); undefined = no such frame, or not measured yet.
 */
export function frameRatioTitle(first: string | null | undefined, last: string | null | undefined): string {
  if (first === undefined || last === undefined) return 'Tỉ lệ lấy theo khung đầu / khung cuối — nối đủ hai khung để biết tỉ lệ.'
  const r = transformFrameRatio(first, last)
  return 'ratio' in r ? `Tỉ lệ lấy theo khung đầu / khung cuối: ${r.ratio}.` : r.problem
}

// ---------------- Run button ----------------
/** Reasons short enough to stand on the button itself ("Chưa chạy · prompt trống"). */
const SHORT_REASONS = new Set(['Prompt trống', 'Prompt quá dài', 'Thiếu ảnh tham chiếu', 'Thiếu khung đầu/cuối'])

export interface RunView {
  blocked: boolean
  /** Text on the button. */
  label: string
  /** The red line under the foot (long reasons only), else null. */
  why: string | null
  /** Hover text: always the full sentence. */
  title: string
  /** Compact ready button ("▶ 20 credit"): the full label is in the title. */
  compact: boolean
}

/**
 * What the node's Run button says. `reason` = core/runRules runBlockReason (null = can run); `placeholders` = the
 * prompt still holds red "@image_?N" placeholders (Run blocked by them: "Chưa chạy · còn chữ đỏ"). The label never
 * repeats the duration (it is in the title and the run confirmation).
 */
export function runButtonView(
  reason: string | null,
  o: { cost: number | null; kind: CreditKind; code: string; duration: number; compact?: boolean; placeholders?: boolean },
): RunView {
  const price = formatCredits(o.cost, o.kind)
  if (!reason) {
    return {
      blocked: false,
      label: o.compact ? price : `Tạo video · ${price}`,
      why: null,
      title: `Tạo video cho ${o.code} · ${o.duration} giây · ${price} (Ctrl+Enter)`,
      compact: !!o.compact,
    }
  }
  const title = `Chưa chạy được: ${reason}`
  if (o.placeholders) return { blocked: true, label: 'Chưa chạy · còn chữ đỏ', why: null, title, compact: false }
  if (SHORT_REASONS.has(reason)) return { blocked: true, label: `Chưa chạy · ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`, why: null, title, compact: false }
  return { blocked: true, label: 'Chưa chạy được', why: reason, title, compact: false }
}

// ---------------- foot: reference images ----------------
/** "2–3" for an asset whose images are @image_2…@image_3, "2" for one image, "" without image. */
export function imageBadge(first: number | undefined, count: number): string {
  if (first === undefined || count <= 0) return ''
  return count > 1 ? `${first}–${first + count - 1}` : String(first)
}

/** Width of a named reference pill (thumb 22 + badge + name ≤ 72 + paddings), from the name's length. */
export function pillWidth(name: string): number {
  return 2 + 22 + 5 + 15 + 5 + Math.min(72, Math.ceil(name.length * 6.6)) + 8 + 2
}

export interface FootLayout {
  /** Show names next to the pictures (1–2 images and the full Run button still fits). */
  names: boolean
  /** Thumbnails shown; the rest is "+N". */
  shown: number
  more: number
  /** Run button in its compact form ("▶ 20 credit"). */
  compact: boolean
}

/** Width the full Run button needs for `label` (12px semibold ≈ 6.6px a character + icon, gap and paddings; ≥ 150). */
export function runWidth(label: string): number {
  return Math.max(NODE.runMin, Math.ceil(38 + label.length * 6.6))
}

/**
 * How the foot (references on the left, Run on the right, one 32px row) fits a node `w` px wide with these linked
 * images (`names` = their names, in order) and the full Run label `runLabel`. Names while the full button still fits;
 * from about 4 images the button turns compact (≥ 96px, "▶ 20 credit"); past 5 pictures a "+N".
 */
export function footLayout(w: number, names: readonly string[], runLabel = 'Tạo video · 20 credit'): FootLayout {
  const content = w - 2 * NODE.border - 2 * NODE.padX
  const run = runWidth(runLabel)
  const n = names.length
  // [refs][6][+][8][Run]
  const plus = NODE.thumb
  const gap = 8
  if (n > 0 && n <= 2) {
    const pills = names.reduce((t, name) => t + pillWidth(name), 0) + n * NODE.thumbGap
    if (pills + plus + gap + run <= content) return { names: true, shown: n, more: 0, compact: false }
  }
  const refs = (k: number, more: boolean) => k * (NODE.thumb + NODE.thumbGap) + (more ? 34 + NODE.thumbGap : 0) + plus
  let shown = Math.min(n, NODE.maxThumbs)
  if (refs(shown, n > shown) + gap + run <= content) return { names: false, shown, more: n - shown, compact: false }
  while (shown > 1 && refs(shown, n > shown) + gap + NODE.runCompact > content) shown--
  return { names: false, shown, more: n - shown, compact: true }
}

// ---------------- far node (zoom < LOD_ZOOM) ----------------
export type FarTone = 'none' | 'ok' | 'going' | 'bad'
/** Top bar / dot of the far node: green = has a video, orange = generating, red = cannot run, grey = nothing yet. */
export function farTone(status: JobStatus | null, hasVideo: boolean, blocked: boolean): FarTone {
  if (status === 'processing' || status === 'queued') return 'going'
  if (blocked) return 'bad'
  return hasVideo ? 'ok' : 'none'
}

/** Far node text: 24px (≈ 11px a character), 20px side padding. */
const FAR_CHAR_W = 11
const FAR_PAD_X = 20

/**
 * The far node's two prompt lines (line-clamp 2): the first two lines of the prompt, leading blanks dropped, cut to
 * what two lines of a node `w` px wide can show (+40% slack) — never a whole 20,000-character paragraph laid out in
 * every far node (the far view is where 100+ nodes are on screen at once).
 */
export function farExcerpt(prompt: string, w: number): string {
  const perLine = Math.max(8, Math.floor((w - 2 * NODE.border - 2 * FAR_PAD_X) / FAR_CHAR_W))
  const cap = Math.ceil(2 * perLine * 1.4) + 8
  let start = 0
  while (start < prompt.length && start < 4096 && /\s/.test(prompt[start])) start++
  let end = Math.min(prompt.length, start + cap)
  const first = prompt.indexOf('\n', start)
  if (first !== -1 && first < end) {
    const second = prompt.indexOf('\n', first + 1)
    if (second !== -1 && second < end) end = second
  }
  return prompt.slice(start, end).trimEnd()
}

/** "SD 2.5 · 15s" in the far node's corner. */
export function farSummary(modelShort: string, duration: number): string {
  return `${modelShort} · ${duration}s`
}
