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
  /** End of the token: the caret, or the end of the word under the caret when that whole word is a token. */
  end: number
  /** Letters typed between "@" and the caret ("ela", "2", "image_1"…). */
  query: string
}

const RAW_TOKEN = /^(image|video)_\d+$/i

/**
 * The "@xxx" being typed at `caret`, if any. Ignores e-mails ("a@b").
 * Letters after the caret belong to the token only when the whole word is a token — "@image_N" / "@video_N", or a
 * word `isToken` accepts (a legacy asset @Tag) — so picking a suggestion replaces all of it. Otherwise the token ends
 * at the caret: an "@" typed right before a plain word ("the @|slope") must not swallow that word.
 */
export function findMention(text: string, caret: number, isToken?: (word: string) => boolean): MentionToken | null {
  let i = caret - 1
  let n = 0
  while (i >= 0 && WORD_CHAR.test(text[i]) && n < 48) {
    i--
    n++
  }
  if (i < 0 || text[i] !== '@') return null
  if (i > 0 && WORD_CHAR.test(text[i - 1])) return null
  const query = text.slice(i + 1, caret)
  let wordEnd = caret
  while (wordEnd < text.length && WORD_CHAR.test(text[wordEnd])) wordEnd++
  const word = text.slice(i + 1, wordEnd)
  const end = wordEnd > caret && (RAW_TOKEN.test(word) || !!isToken?.(word)) ? wordEnd : caret
  return { start: i, end, query }
}

export const sameToken = (a: MentionToken | null, b: MentionToken | null) =>
  a === b || (!!a && !!b && a.start === b.start && a.end === b.end && a.query === b.query)

/** Max height of the "@" popup (as in inspector.css `.in-mention`). */
export const POPUP_MAX_H = 380
const POPUP_MIN_H = 120
const MARGIN = 8

export interface PopupPlacement {
  top?: number
  bottom?: number
  maxHeight: number
}

/**
 * Vertical placement of the "@" popup for a caret line at `yTop` (viewport px, `lineH` tall): below the caret when
 * the estimated height `estH` fits, else on the side with more room. `maxHeight` keeps the whole popup (list +
 * footer) inside the viewport; the list scrolls inside it.
 */
export function popupPlacement(yTop: number, lineH: number, estH: number, viewH: number): PopupPlacement {
  const below = yTop + lineH + 6
  const roomBelow = viewH - MARGIN - below
  const roomAbove = yTop - 4 - MARGIN
  const fit = (room: number) => Math.floor(Math.max(Math.min(POPUP_MIN_H, viewH - 2 * MARGIN), Math.min(POPUP_MAX_H, room)))
  if (estH > roomBelow && roomAbove > roomBelow) {
    const maxHeight = fit(roomAbove)
    // bottom edge 4px above the caret line, but never pushed off the top / bottom of the viewport
    return { bottom: Math.round(Math.max(MARGIN, Math.min(viewH - yTop + 4, viewH - MARGIN - maxHeight))), maxHeight }
  }
  const maxHeight = fit(roomBelow)
  return { top: Math.round(Math.max(MARGIN, Math.min(below, viewH - MARGIN - maxHeight))), maxHeight }
}
