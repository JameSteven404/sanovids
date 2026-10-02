// "Cách đặt tên file" (Cài đặt → Nâng cao): the default file name of a take's video comes from a small template
// with tokens — {scene} {take} {title} {project} {date} {time} {model}. The default '{scene}_{take} - {title}'
// gives today's "S03_T2 - Ánh sáng trong hang" ("S03_T2" when the scene has no title).
// Pure (no stores, no DOM); unit-tested in ./__tests__/nameTemplate.test.ts. A name the user typed for one take
// ("Tên file", Take.fileName) always wins over the template (actions.takeFileBase).
import { cleanFileBase } from './fileNames'

export type NameToken = 'scene' | 'take' | 'title' | 'project' | 'date' | 'time' | 'model'

/** Tokens offered in Settings, in the order they are shown. */
export const NAME_TOKENS: readonly { id: NameToken; label: string; example: string }[] = [
  { id: 'scene', label: 'Mã cảnh', example: 'S03' },
  { id: 'take', label: 'Số take', example: 'T2' },
  { id: 'title', label: 'Tên cảnh', example: 'Ánh sáng trong hang' },
  { id: 'project', label: 'Tên dự án', example: 'Phim ngắn' },
  { id: 'date', label: 'Ngày tạo video (năm-tháng-ngày)', example: '2026-10-02' },
  { id: 'time', label: 'Giờ tạo video', example: '14h05' },
  { id: 'model', label: 'Model', example: 'Seedance 2.5' },
]

export type NameValues = Partial<Record<NameToken, string>>

export const DEFAULT_NAME_TEMPLATE = '{scene}_{take} - {title}'
export const MAX_TEMPLATE_LENGTH = 100

const TOKEN_IDS = new Set<string>(NAME_TOKENS.map((t) => t.id))
const TOKEN_RE = /\{([^{}]*)\}/g
/** Characters a file name cannot hold (Windows / macOS), control characters included. */
const BAD_CHAR = /[<>:"/\\|?*\u0000-\u001f\u007f]/
/** What sits between two tokens: dropped next to a token that renders empty ("S01_T1 - " → "S01_T1"). */
const SEPARATORS = /[\s\-_.·,;~+#–—]/
const OPENERS: Record<string, string> = { '(': ')', '[': ']' }

type Part = { kind: 'text'; text: string } | { kind: 'token'; id: string; raw: string }

function parse(template: string): Part[] {
  const parts: Part[] = []
  let last = 0
  for (const m of template.matchAll(TOKEN_RE)) {
    if (m.index > last) parts.push({ kind: 'text', text: template.slice(last, m.index) })
    parts.push({ kind: 'token', id: m[1].trim().toLowerCase(), raw: m[0] })
    last = m.index + m[0].length
  }
  if (last < template.length) parts.push({ kind: 'text', text: template.slice(last) })
  return parts
}

export type TemplateCheck = { ok: true; template: string; warning?: string } | { ok: false; error: string }

const TOKEN_LIST = NAME_TOKENS.map((t) => `{${t.id}}`).join(' ')

/** Validate a template typed in Settings (or read from storage / a settings file). */
export function checkNameTemplate(raw: unknown): TemplateCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'Mẫu tên không hợp lệ.' }
  const template = raw.trim()
  if (!template) return { ok: false, error: 'Mẫu tên đang trống — thêm ít nhất một mã, ví dụ {scene}.' }
  if (template.length > MAX_TEMPLATE_LENGTH) return { ok: false, error: `Mẫu tên dài quá (tối đa ${MAX_TEMPLATE_LENGTH} ký tự).` }
  const bad = BAD_CHAR.exec(template)
  if (bad) {
    const ch = bad[0]
    return { ok: false, error: ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? 'Tên file không chứa được ký tự điều khiển.' : `Tên file không chứa được ký tự “${ch}”.` }
  }
  const parts = parse(template)
  if (parts.some((p) => p.kind === 'text' && /[{}]/.test(p.text))) return { ok: false, error: 'Dấu { } chỉ dùng để bao quanh một mã, ví dụ {scene}.' }
  const unknown = parts.find((p) => p.kind === 'token' && !TOKEN_IDS.has(p.id))
  if (unknown && unknown.kind === 'token') return { ok: false, error: `Không có mã ${unknown.raw}. Các mã dùng được: ${TOKEN_LIST}.` }
  const ids = new Set(parts.flatMap((p) => (p.kind === 'token' ? [p.id] : [])))
  if (!ids.size) return { ok: false, error: 'Thêm ít nhất một mã như {scene} hoặc {take} để mỗi video có tên riêng.' }
  if (!ids.has('take') && !ids.has('time')) {
    return { ok: true, template, warning: 'Không có {take}: các take của cùng một cảnh sẽ trùng tên (được thêm “ (2)”, “ (3)”… khi lưu).' }
  }
  return { ok: true, template }
}

/** A stored template, or the default one when it is missing / invalid. */
export function normalizeNameTemplate(raw: unknown): string {
  const c = checkNameTemplate(raw)
  return c.ok ? c.template : DEFAULT_NAME_TEMPLATE
}

const isSep = (ch: string | undefined) => !!ch && SEPARATORS.test(ch)
function trimSepEnd(s: string): string {
  let i = s.length
  while (i > 0 && isSep(s[i - 1])) i--
  return s.slice(0, i)
}
function trimSepStart(s: string): string {
  let i = 0
  while (i < s.length && isSep(s[i])) i++
  return s.slice(i)
}

/**
 * Render a template into a safe base name (no extension), '' when nothing usable is left. A token with no value
 * takes its separator with it: '{scene}_{take} - {title}' without a title → "S01_T1"; "({title})" → nothing.
 * Unknown tokens stay as typed (checkNameTemplate refuses them in Settings).
 */
export function renderNameTemplate(template: string, values: NameValues): string {
  const parts = parse(template)
  const out = parts.map((p) => {
    if (p.kind === 'text') return p.text
    if (!TOKEN_IDS.has(p.id)) return p.raw
    return (values[p.id as NameToken] ?? '').replace(/\s+/g, ' ').trim()
  })
  parts.forEach((p, i) => {
    if (p.kind !== 'token' || !TOKEN_IDS.has(p.id) || out[i]) return
    const prev = i > 0 && parts[i - 1].kind === 'text' ? i - 1 : -1
    const next = i + 1 < parts.length && parts[i + 1].kind === 'text' ? i + 1 : -1
    // "(…)" / "[…]" around an empty token go away together.
    if (prev >= 0 && next >= 0) {
      const open = out[prev].slice(-1)
      if (OPENERS[open] && out[next].startsWith(OPENERS[open])) {
        out[prev] = out[prev].slice(0, -1)
        out[next] = out[next].slice(1)
      }
    }
    // The separator in front of the token goes; when nothing real comes before it, the one after it goes too.
    const hasHead = trimSepStart(out.slice(0, i).join('')) !== ''
    if (prev >= 0) out[prev] = trimSepEnd(out[prev])
    if (!hasHead && next >= 0) out[next] = trimSepStart(out[next])
  })
  return cleanFileBase(out.join(''))
}

const pad = (n: number) => String(n).padStart(2, '0')

/** {date}: local "2026-10-02" ('' for an unknown time). */
export function nameDate(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** {time}: local "14h05" (a colon is not allowed in a file name). */
export function nameTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  return `${pad(d.getHours())}h${pad(d.getMinutes())}`
}
