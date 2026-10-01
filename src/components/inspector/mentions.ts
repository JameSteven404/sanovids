// Pure helpers for the @mention editor (no React / DOM / store imports — unit-tested).
import type { Asset } from '../../core/types'

export const MAX_SUGGESTIONS = 8
const WORD_CHAR = /[\p{L}\p{N}_]/u

/** Lowercase + strip Vietnamese diacritics, for search. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
}

export interface MentionToken {
  /** Index of "@". */
  start: number
  /** End of the token (the caret, or the end of the word under the caret). */
  end: number
  /** Letters typed between "@" and the caret. */
  query: string
}

/** The @mention being typed at `caret`, if any. Ignores e-mails ("a@b") and raw "@image_N" tokens. */
export function findMention(text: string, caret: number): MentionToken | null {
  let i = caret - 1
  let n = 0
  while (i >= 0 && WORD_CHAR.test(text[i]) && n < 48) {
    i--
    n++
  }
  if (i < 0 || text[i] !== '@') return null
  if (i > 0 && WORD_CHAR.test(text[i - 1])) return null
  const query = text.slice(i + 1, caret)
  if (/^image_\d*$/i.test(query) && query.length >= 5) return null
  let end = caret
  while (end < text.length && WORD_CHAR.test(text[end])) end++
  return { start: i, end, query }
}

export const sameToken = (a: MentionToken | null, b: MentionToken | null) =>
  a === b || (!!a && !!b && a.start === b.start && a.end === b.end && a.query === b.query)

/** Rank library assets for a mention query: tag prefix > name prefix > word prefix > contains. Linked refs first on ties. */
export function rankAssets(assets: Asset[], query: string, refs: string[], max = MAX_SUGGESTIONS): Asset[] {
  const q = fold(query)
  if (!q) {
    const linked = refs.map((id) => assets.find((a) => a.id === id)).filter((a): a is Asset => !!a)
    const rest = assets.filter((a) => !refs.includes(a.id))
    return [...linked, ...rest].slice(0, max)
  }
  const scored: { a: Asset; s: number }[] = []
  for (const a of assets) {
    const tag = fold(a.tag)
    const name = fold(a.name)
    let s = -1
    if (tag.startsWith(q)) s = 0
    else if (name.startsWith(q)) s = 1
    else if (name.split(/\s+/).some((w) => w.startsWith(q))) s = 2
    else if (tag.includes(q)) s = 3
    else if (name.includes(q)) s = 4
    if (s < 0) continue
    if (refs.includes(a.id)) s -= 0.5
    scored.push({ a, s })
  }
  scored.sort((x, y) => x.s - y.s || x.a.tag.length - y.a.tag.length)
  return scored.slice(0, max).map((x) => x.a)
}

/** Text to insert for a picked tag and where the caret goes afterwards. */
export function insertion(text: string, tok: MentionToken, tag: string): { insert: string; next: string; caret: number } {
  const after = text.slice(tok.end)
  const needsSpace = !/^[\s.,;:!?)\]"'’]/.test(after)
  const insert = '@' + tag + (needsSpace ? ' ' : '')
  const caret = tok.start + insert.length + (needsSpace || !after.startsWith(' ') ? 0 : 1)
  return { insert, next: text.slice(0, tok.start) + insert + after, caret }
}
