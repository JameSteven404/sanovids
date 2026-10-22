// Pure helpers for the "@" popup and the red-text picker of the prompt editors (no React / DOM / store imports —
// unit-tested in __tests__/inspector.test.ts and __tests__/placeholderPicker.test.ts).
import { groupAtOffset, placeholderAt, type PlaceholderGroup } from '../../core/placeholders'
import type { Asset } from '../../core/types'

// ---------------- red-text picker (PlaceholderBar usePlaceholderPicker: inspector + scene node editors) ----------------

/** The red text under a caret: its group and the span of the occurrence the caret is in. */
export interface PickerHit {
  group: PlaceholderGroup
  start: number
  end: number
}

/** The last answer (the field's caret event and its render ask the same question; a long prompt parses once). */
let lastHit: { text: string; at: number; assets: readonly Asset[]; refs: readonly string[]; hit: PickerHit | null } | null = null

/**
 * The red text (a placeholder "@image_?2(Lumi)", or a token whose glued label does not fit its picture) a collapsed
 * caret lies strictly inside of, with that occurrence's span: the same hit test as ONE picture dropped on red text
 * (core/placeholders groupAtOffset). null for a selection, at either edge, or outside red text.
 */
export function placeholderPickerAt(text: string, start: number, end: number, assets: readonly Asset[], refs: readonly string[]): PickerHit | null {
  if (start !== end || !/@image/i.test(text)) return null
  const c = lastHit
  if (c && c.text === text && c.at === start && c.assets === assets && c.refs === refs) return c.hit
  const group = groupAtOffset(text, assets, refs, start)
  const member = group?.members.find((m) => m.start < start && start < m.end)
  const hit = group && member ? { group, start: member.start, end: member.end } : null
  lastHit = { text, at: start, assets, refs, hit }
  return hit
}

/** What changed the caret of a prompt field: typing (onChange), a caret move (onSelect: arrows, undo, focus…), a click. */
export type PickerCause = 'type' | 'move' | 'click'

/** A caret position of a given text. */
export interface PickerCaret {
  text: string
  caret: number
}

/**
 * The red-text picker of a prompt field. `at`: the collapsed caret it follows, measured on that text (it shows only
 * while the field still holds that text and placeholderPickerAt finds red text there). `quiet`: where typing, Esc, a
 * command or a blur closed it — a caret move landing there again (the onSelect that follows each keystroke, a refocus)
 * keeps it closed; a click, or the caret moving anywhere else, reopens it.
 */
export interface PickerState {
  at: PickerCaret | null
  quiet: PickerCaret | null
}

export const PICKER_CLOSED: PickerState = { at: null, quiet: null }

const sameCaret = (a: PickerCaret | null, b: PickerCaret | null) => a === b || (!!a && !!b && a.text === b.text && a.caret === b.caret)

/** Next state of the picker after a caret change (`state` itself when nothing changed). Typing never opens it. */
export function pickerNext(state: PickerState, cause: PickerCause, text: string, start: number, end: number): PickerState {
  let next: PickerState
  if (cause === 'type') next = { at: null, quiet: { text, caret: start } }
  else if (start !== end) next = PICKER_CLOSED
  else if (cause === 'move' && sameCaret(state.quiet, { text, caret: start })) next = { at: null, quiet: state.quiet }
  else next = { at: { text, caret: start }, quiet: null }
  return sameCaret(next.at, state.at) && sameCaret(next.quiet, state.quiet) ? state : next
}

/** Closed by Esc, Tab, a command or a blur at `caret` of `text`: stays closed until the caret moves (or a click). */
export function pickerClosed(text: string, caret: number): PickerState {
  return { at: null, quiet: { text, caret } }
}

interface KeyLike {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * A key pressed in the prompt field while its red-text picker shows. 'menu': move the focus to the picker's first
 * command — Enter (a line break there would split the red text) or Alt+↓. Nothing is run by it. null: the field's own
 * key; bare ↑ / ↓ keep moving the caret line by line (they never put the focus on a fill or delete command).
 */
export function pickerFieldKey(e: KeyLike): 'menu' | null {
  if (e.ctrlKey || e.metaKey || e.shiftKey) return null
  if (e.key === 'Enter' && !e.altKey) return 'menu'
  if (e.key === 'ArrowDown' && e.altKey) return 'menu'
  return null
}

/**
 * A key pressed inside the picker / a chip's menu. 'close': Esc, Tab, Shift+Tab (the focus goes back to the field or
 * the chip). 'move': ↑ ↓ Home End between the enabled commands (placeholderMenuIndex). 'pass': Ctrl / ⌘ chords reach
 * the app's shortcuts (undo, save, run). 'keep': anything else stays in the menu — Enter / Space click the focused
 * command, Delete never deletes the selected scene, letters never run canvas keys.
 */
export function pickerMenuKey(e: KeyLike): 'close' | 'move' | 'pass' | 'keep' {
  if (e.key === 'Escape' || e.key === 'Tab') return 'close'
  if (e.ctrlKey || e.metaKey) return 'pass'
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') return 'move'
  return 'keep'
}

/** Arrow navigation wraps over enabled commands only (null: not a navigation key, or nothing enabled). */
export function placeholderMenuIndex(key: string, at: number, disabled: readonly boolean[]): number | null {
  const enabled = disabled.flatMap((off, i) => (off ? [] : [i]))
  if (!enabled.length) return null
  if (key === 'Home') return enabled[0]
  if (key === 'End') return enabled[enabled.length - 1]
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return null
  const i = enabled.indexOf(at)
  return enabled[i < 0 ? (key === 'ArrowDown' ? 0 : enabled.length - 1) : (i + (key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length]
}

// ---------------- "@" popup ----------------

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
  // Inside a red placeholder ("@image_|?2(Lumi)"): it is not an "@" being typed — the popup would replace part of it.
  if (text.includes('_?') && placeholderAt(text, caret)) return null
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
