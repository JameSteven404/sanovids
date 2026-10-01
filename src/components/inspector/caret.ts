// Caret coordinates inside a <textarea> using the "mirror div" technique:
// a hidden div copies the textarea's box + typography, receives the text up to the caret,
// and a marker <span> tells us where the caret would be drawn.

const COPIED = [
  'direction',
  'font-style',
  'font-variant',
  'font-weight',
  'font-stretch',
  'font-size',
  'font-size-adjust',
  'line-height',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-variation-settings',
  'text-align',
  'text-transform',
  'text-indent',
  'text-decoration',
  'letter-spacing',
  'word-spacing',
  'tab-size',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-style',
] as const

let mirror: HTMLDivElement | null = null
let marker: HTMLSpanElement | null = null

function ensureMirror(doc: Document): { mirror: HTMLDivElement; marker: HTMLSpanElement } {
  if (!mirror || !mirror.isConnected) {
    mirror = doc.createElement('div')
    mirror.setAttribute('aria-hidden', 'true')
    marker = doc.createElement('span')
    doc.body.appendChild(mirror)
  }
  return { mirror, marker: marker! }
}

export interface CaretCoords {
  /** Relative to the textarea's border box, ignoring its scroll offset. */
  top: number
  left: number
  /** Line height in px. */
  height: number
}

const WORD_TAIL = /^[^\s]*/

/** Pixel position of character index `position` inside `el` (before scrolling is applied). */
export function caretCoordinates(el: HTMLTextAreaElement, position: number): CaretCoords {
  const { mirror: m, marker: mk } = ensureMirror(el.ownerDocument)
  const cs = getComputedStyle(el)
  const s = m.style
  for (const prop of COPIED) s.setProperty(prop, cs.getPropertyValue(prop))
  s.position = 'absolute'
  s.visibility = 'hidden'
  s.pointerEvents = 'none'
  s.top = '0'
  s.left = '-99999px'
  s.whiteSpace = 'pre-wrap'
  s.overflowWrap = 'break-word'
  s.wordBreak = cs.wordBreak
  s.overflow = 'hidden'
  s.height = 'auto'
  // clientWidth excludes the vertical scrollbar (when shown) and borders but includes padding.
  const bl = parseFloat(cs.borderLeftWidth) || 0
  const br = parseFloat(cs.borderRightWidth) || 0
  s.boxSizing = 'border-box'
  s.width = `${el.clientWidth + bl + br}px`

  const value = el.value
  m.textContent = value.slice(0, position)
  // Only the rest of the current word matters for wrapping at the caret.
  const tail = WORD_TAIL.exec(value.slice(position, position + 64))?.[0] ?? ''
  mk.textContent = tail || '.'
  m.appendChild(mk)

  const lh = parseFloat(cs.lineHeight)
  const height = Number.isFinite(lh) ? lh : (parseFloat(cs.fontSize) || 13) * 1.4
  return {
    top: mk.offsetTop + (parseFloat(cs.borderTopWidth) || 0),
    left: mk.offsetLeft + bl,
    height,
  }
}

// ---------------- text offset under a point (drops) ----------------
interface CaretPointDoc {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as unknown as CaretPointDoc
  if (typeof d.caretPositionFromPoint === 'function') {
    const p = d.caretPositionFromPoint(x, y)
    return p ? { node: p.offsetNode, offset: p.offset } : null
  }
  if (typeof d.caretRangeFromPoint === 'function') {
    const r = d.caretRangeFromPoint(x, y)
    return r ? { node: r.startContainer, offset: r.startOffset } : null
  }
  return null
}

/**
 * Index in `ta.value` under the viewport point (x, y), or null when the browser cannot tell.
 * `mirror` renders the same text with the same metrics and scroll offset behind the textarea (the editor's
 * backdrop): browsers that cannot map a point inside a textarea (caretRangeFromPoint lands in its shadow tree)
 * are asked about the mirror instead, with the textarea made transparent to hit testing for that one query.
 */
export function offsetFromPoint(ta: HTMLTextAreaElement, mirror: HTMLElement | null, x: number, y: number): number | null {
  const len = ta.value.length
  try {
    // Spec behavior (Firefox, Chromium 128+): the text control itself, with an offset into its value.
    const hit = caretAt(x, y)
    if (hit && hit.node === ta) return Math.min(hit.offset, len)
  } catch {
    /* fall through */
  }
  if (!mirror) return null
  const taPointer = ta.style.pointerEvents
  const mirrorPointer = mirror.style.pointerEvents
  ta.style.pointerEvents = 'none'
  mirror.style.pointerEvents = 'auto'
  try {
    const hit = caretAt(x, y)
    if (!hit || !mirror.contains(hit.node)) return null
    const range = document.createRange()
    range.setStart(mirror, 0)
    range.setEnd(hit.node, hit.offset)
    return Math.min(range.toString().length, len)
  } catch {
    return null
  } finally {
    ta.style.pointerEvents = taPointer
    mirror.style.pointerEvents = mirrorPointer
  }
}
