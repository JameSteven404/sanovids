// "Nhập prompt cũ": turn a pile of old, copy-pasted prompts into scenes + reusable prompt blocks.
// Pure module (no React, no stores) — covered by src/core/__tests__/importPrompts.test.ts.
//
// Pipeline:
//   text / .txt files ──splitPrompts / parsePromptText──▶ prompts[]
//   prompts ──analyzePrompts──▶ paragraphs per prompt + candidate blocks (paragraphs repeated across prompts)
//   prompts + chosen candidates ──applyImport──▶ { blocks, scenes } ready for project.applyImport()
import { newId, pickColor } from './ids'
import type { BlockPlacement, PromptBlock, Scene } from './types'

export interface ImportItem {
  /** Scene title (from a `=== Title ===` header line or a file name). May be empty. */
  title: string
  text: string
}

export interface CandidateVariant {
  key: string
  text: string
  /** Number of prompts containing exactly this variant. */
  count: number
}

export interface ImportCandidate {
  /** Normalized key of the main (most frequent) variant. Unique per analysis. */
  key: string
  /** Original text of the main variant: becomes the block text. */
  text: string
  /** Number of prompts containing this paragraph or one of its near-duplicate variants. */
  count: number
  /** Main variant first, then the others by frequency. Always has at least one entry. */
  variants: CandidateVariant[]
  /** Average relative position inside the prompts (0 = first paragraph, 1 = last). */
  avgPosition: number
  /** Suggested block title (editable in the UI). */
  title: string
  /** Suggested placement (editable in the UI). */
  placement: BlockPlacement
  /** Indexes of the prompts that contain it (any variant). */
  prompts: number[]
}

/** A candidate chosen by the user, possibly with an edited title / placement. */
export interface SelectedCandidate extends ImportCandidate {
  /** Also replace near-duplicate variants by the block (their differences are dropped). Default false. */
  mergeVariants?: boolean
}

export interface PromptAnalysis {
  /** Paragraphs of each prompt (split on blank lines, trimmed). */
  paragraphs: string[][]
  candidates: ImportCandidate[]
  /** Minimum number of prompts a paragraph must appear in to be suggested. */
  threshold: number
}

export interface ImportStats {
  prompts: number
  /** Total characters of the original prompts. */
  charsBefore: number
  /** Total characters of the resulting scene prompts (blocks excluded). */
  charsAfter: number
  /** Average characters removed from each scene prompt. */
  savedPerScene: number
  /** Prompts that still contain raw `@image_N` tokens. */
  imageTokenPrompts: number
  /** Resulting scene prompts that are empty (everything moved into blocks). */
  emptyScenes: number
}

export interface ImportResult {
  blocks: PromptBlock[]
  /** Partial scenes for `useProject.applyImport` (id, title, prompt, blockOverrides). */
  scenes: (Partial<Scene> & { id: string; title: string; prompt: string; blockOverrides: Record<string, boolean> })[]
  stats: ImportStats
}

/** Near-duplicates are grouped when their normalized text shares this many leading characters. */
export const VARIANT_PREFIX = 48
/** Paragraphs shorter than this (normalized) are never suggested as blocks. */
export const MIN_BLOCK_CHARS = 12
/** Placement threshold: paragraphs that usually come in the first 35% of a prompt go before it. */
export const BEFORE_POSITION = 0.35

const SEPARATOR_LINE = /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/
const HEADER_LINE = /^\s*={3,}\s*(\S.*?)\s*={3,}\s*$/
const IMAGE_TOKEN = /@image_\d+/i

const toLF = (s: string) => s.replace(/\r\n?/g, '\n')

/** Lowercase + collapsed whitespace: the identity used to compare paragraphs. */
export function normalizeKey(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function headerTitle(raw: string): string {
  // "S01: Dawn climb" / "S01 · Dawn climb" / "S01" / "Dawn climb"
  return raw
    .replace(/^S\d+\s*(?:[:·\-–—|.]\s*)?/i, '')
    .replace(/^["“'](.*)["”']$/, '$1')
    .trim()
}

/**
 * Split a pasted text into prompts. Separators: a line made only of `---`, `===` or `***` (3+ chars).
 * A header line like `=== S03: Title ===` also separates and names the following prompt
 * (this is the format of "Copy tất cả prompt").
 */
export function parsePromptText(text: string): ImportItem[] {
  const items: ImportItem[] = []
  let buf: string[] = []
  let title = ''
  const push = () => {
    const body = buf.join('\n').trim()
    buf = []
    if (!body) return
    items.push({ title, text: body })
    title = ''
  }
  for (const line of toLF(text).split('\n')) {
    const header = HEADER_LINE.exec(line)
    if (header && !SEPARATOR_LINE.test(line)) {
      push()
      title = headerTitle(header[1])
      continue
    }
    if (SEPARATOR_LINE.test(line)) {
      push()
      continue
    }
    buf.push(line)
  }
  push()
  return items
}

export function splitPrompts(text: string): string[] {
  return parsePromptText(text).map((i) => i.text)
}

/** Paragraphs = chunks separated by blank lines. */
export function splitParagraphs(prompt: string): string[] {
  return toLF(prompt)
    .split(/\n[ \t]*\n\s*/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/** Title for a block made from a paragraph: its leading label (`Audio:` → "Audio") or its first words. */
export function suggestTitle(text: string): string {
  const clean = text
    .trim()
    .replace(/^[#>*\-_\s]+/, '')
    .replace(/[*_`]+/g, '')
  const label = /^([^:\n.!?]{2,48}):/.exec(clean)
  if (label) {
    const t = label[1]
      .split(',')[0]
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/\s*[-–—]\s*(repeated|again|lặp lại)$/i, '')
      .trim()
    if (t && t.split(/\s+/).length <= 6) return capitalize(t)
  }
  const firstClause = clean.split(/[,.;:!?\n—–]/)[0].trim()
  const words = firstClause.split(/\s+/).filter(Boolean)
  const head = words.slice(0, 5).join(' ')
  if (!head) return 'Khối nhập'
  return capitalize(head) + (words.length > 5 ? '…' : '')
}

function capitalize(s: string): string {
  return s ? s[0].toLocaleUpperCase() + s.slice(1) : s
}

function uniqueTitles<T extends { title: string }>(list: T[]): T[] {
  const used = new Map<string, number>()
  return list.map((c) => {
    const k = c.title.toLowerCase()
    const n = (used.get(k) ?? 0) + 1
    used.set(k, n)
    return n === 1 ? c : { ...c, title: `${c.title} (${n})` }
  })
}

/** Find paragraphs repeated across prompts (the "style bible" people copy-paste into every prompt). */
export function analyzePrompts(prompts: string[]): PromptAnalysis {
  const paragraphs = prompts.map(splitParagraphs)
  const threshold = Math.max(2, Math.ceil(prompts.length * 0.3))

  interface Variant {
    key: string
    text: string
    prompts: Set<number>
    seq: number
  }
  interface Group {
    variants: Map<string, Variant>
    prompts: Set<number>
    positions: number[]
  }
  const groups = new Map<string, Group>()
  let seq = 0

  paragraphs.forEach((paras, pi) => {
    const seen = new Set<string>()
    paras.forEach((text, idx) => {
      const key = normalizeKey(text)
      if (key.length < MIN_BLOCK_CHARS) return
      const prefix = key.slice(0, VARIANT_PREFIX)
      let g = groups.get(prefix)
      if (!g) {
        g = { variants: new Map(), prompts: new Set(), positions: [] }
        groups.set(prefix, g)
      }
      let v = g.variants.get(key)
      if (!v) {
        v = { key, text, prompts: new Set(), seq: seq++ }
        g.variants.set(key, v)
      }
      v.prompts.add(pi)
      if (!seen.has(prefix)) {
        seen.add(prefix)
        g.prompts.add(pi)
        g.positions.push(paras.length > 1 ? idx / (paras.length - 1) : 0)
      }
    })
  })

  const candidates: ImportCandidate[] = []
  for (const g of groups.values()) {
    if (g.prompts.size < threshold) continue
    const variants = [...g.variants.values()].sort((a, b) => b.prompts.size - a.prompts.size || a.seq - b.seq)
    const main = variants[0]
    // A paragraph that is never repeated verbatim is not boilerplate, just a common opening.
    if (main.prompts.size < 2) continue
    const avgPosition = g.positions.reduce((t, p) => t + p, 0) / g.positions.length
    candidates.push({
      key: main.key,
      text: main.text,
      count: g.prompts.size,
      variants: variants.map((v) => ({ key: v.key, text: v.text, count: v.prompts.size })),
      avgPosition,
      title: suggestTitle(main.text),
      placement: avgPosition < BEFORE_POSITION ? 'before' : 'after',
      prompts: [...g.prompts].sort((a, b) => a - b),
    })
  }
  candidates.sort((a, b) => a.avgPosition - b.avgPosition || b.count - a.count)
  return { paragraphs, candidates: uniqueTitles(candidates), threshold }
}

/**
 * Build blocks from the chosen candidates and strip them out of each prompt.
 * - A paragraph equal (normalized) to a block's text is removed and the block is ON for that scene.
 * - A near-duplicate variant stays inline (block OFF for that scene) unless `mergeVariants` is set.
 * - Block `defaultOn` follows the majority; scenes that differ get an override, so every scene compiles
 *   to the same paragraphs it had before (blocks first/last instead of in place).
 * - `@image_N` tokens are kept untouched (they can be mapped to library assets later).
 */
export function applyImport(
  prompts: string[],
  selected: SelectedCandidate[],
  opts: { titles?: string[]; colorOffset?: number } = {},
): ImportResult {
  const ordered = [...selected].sort((a, b) => a.avgPosition - b.avgPosition)
  const matchers = ordered.map((c, i) => ({
    c,
    id: newId('blk'),
    color: pickColor(i + (opts.colorOffset ?? 0)),
    variantKeys: new Set([c.key, ...c.variants.map((v) => v.key)]),
  }))

  const perScene = prompts.map((prompt) => {
    const on = new Set<string>()
    const keep: string[] = []
    for (const para of splitParagraphs(prompt)) {
      const key = normalizeKey(para)
      const m = matchers.find((x) => key === x.c.key || (x.c.mergeVariants && x.variantKeys.has(key)))
      if (m) on.add(m.id)
      else keep.push(para)
    }
    return { on, prompt: keep.join('\n\n') }
  })

  const half = prompts.length / 2
  const blocks: PromptBlock[] = matchers.map((m) => {
    const used = perScene.filter((s) => s.on.has(m.id)).length
    return {
      id: m.id,
      title: m.c.title.trim() || suggestTitle(m.c.text),
      text: m.c.text.trim(),
      placement: m.c.placement,
      defaultOn: used >= half,
      color: m.color,
    }
  })

  const scenes = perScene.map((s, i) => {
    const blockOverrides: Record<string, boolean> = {}
    for (const b of blocks) {
      const isOn = s.on.has(b.id)
      if (isOn !== b.defaultOn) blockOverrides[b.id] = isOn
    }
    return { id: newId('scn'), title: (opts.titles?.[i] ?? '').trim(), prompt: s.prompt, blockOverrides }
  })

  const charsBefore = prompts.reduce((t, p) => t + [...p.trim()].length, 0)
  const charsAfter = scenes.reduce((t, s) => t + [...s.prompt].length, 0)
  return {
    blocks,
    scenes,
    stats: {
      prompts: prompts.length,
      charsBefore,
      charsAfter,
      savedPerScene: prompts.length ? Math.round((charsBefore - charsAfter) / prompts.length) : 0,
      imageTokenPrompts: prompts.filter((p) => IMAGE_TOKEN.test(p)).length,
      emptyScenes: scenes.filter((s) => !s.prompt.trim()).length,
    },
  }
}

/** Raw `@image_N` tokens in a prompt (case-insensitive, in order, without duplicates). */
export function imageTokens(text: string): string[] {
  return [...new Set([...text.matchAll(/@image_(\d+)/gi)].map((m) => `@image_${m[1]}`))]
}

// ---------------------------------------------------------------------------------------------
// Sample used by the "Dùng ví dụ" button: 3 short original prompts that repeat a style header,
// audio rules and constraints (the last one with a small variation) so block detection shows up.
const SAMPLE_STYLE =
  'Cinematic live-action short film, quiet coastal drama. Overcast natural light, muted teal and amber palette, handheld camera with gentle motivated movement, shallow depth of field, soft cuts between shots.'
const SAMPLE_AUDIO =
  'Audio: natural ambience only — wind, surf, rain on glass, footsteps on iron stairs. No music, no score, no singing. No narration, no subtitles, no on-screen text.'
const SAMPLE_CONSTRAINTS =
  'Constraints, repeated: one lighthouse keeper and one grey dog only, never duplicated; same clothes and fur in every shot; no logos, no extra people.'

export const SAMPLE_IMPORT_TEXT = [
  '=== S01: Ngọn đèn lúc bình minh ===',
  SAMPLE_STYLE,
  'Dawn. Mara (@image_1), an elderly lighthouse keeper in a yellow raincoat, climbs the spiral stairs carrying a brass storm lantern. At the narrow window she stops and watches a small fishing boat fight the grey waves.',
  SAMPLE_AUDIO,
  SAMPLE_CONSTRAINTS,
  '=== S02: Con chó dưới ghềnh đá ===',
  SAMPLE_STYLE,
  'On the rocky shore below the tower, Mara finds a soaked grey dog tangled in an old fishing net. She kneels, cuts the net with a pocket knife and wraps the shivering dog in her coat.',
  SAMPLE_AUDIO,
  SAMPLE_CONSTRAINTS,
  '=== S03: Tín hiệu đáp lại ===',
  SAMPLE_STYLE,
  'Night. Mara and the dog sit by the iron stove inside the lighthouse. The beam sweeps over the dark sea; far away the fishing boat blinks its lights twice, and Mara smiles.',
  SAMPLE_AUDIO,
  SAMPLE_CONSTRAINTS + ' Keep the storm lantern lit on the table for the whole scene.',
].join('\n\n')
