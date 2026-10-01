// Pure helpers for the "@" popup of the prompt editor (no React / DOM / store imports — unit-tested).

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
  /** Letters typed between "@" and the caret ("ela", "2", "image_1"…). */
  query: string
}

/** The "@xxx" being typed at `caret`, if any. Ignores e-mails ("a@b"). */
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
  let end = caret
  while (end < text.length && WORD_CHAR.test(text[end])) end++
  return { start: i, end, query }
}

export const sameToken = (a: MentionToken | null, b: MentionToken | null) =>
  a === b || (!!a && !!b && a.start === b.start && a.end === b.end && a.query === b.query)
