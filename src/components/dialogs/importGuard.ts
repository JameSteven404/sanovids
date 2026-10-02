// "Nhập prompt cũ": keep absurd @image_N numbers out of the import helpers.
// Pure module — covered by ./__tests__/importGuard.test.ts.
//
// The dialog builds one row (and arrays) per number 1..max @image_N. A date-like or mistyped number pasted in a
// prompt ("@image_20241002") would build millions of rows and freeze the tab, or throw (invalid array length)
// and close the dialog with every pasted prompt lost. Numbers above MAX_IMPORT_IMAGE are hidden from the import
// helpers (masked while summarizing / mapping, restored afterwards) and stay exactly as written in the prompt.
import { TOKEN_RE } from '../../core/compile'
import { MAX_SUMMARY_TOKEN, type ImportItem } from '../../core/importPrompts'

/** Highest @image_N the import offers to map (models take far fewer reference images) — the summary's own cap. */
export const MAX_IMPORT_IMAGE = MAX_SUMMARY_TOKEN

/** Private-use character standing in for the "@" of a masked token: no longer matches TOKEN_RE, same length. */
const MASK = ''
const MASKED_RE = /(image_\d+)/gi

export interface GuardedItems {
  /** Items with out-of-range @image tokens masked (feed these to summarizeImport / applyImageMapping). */
  items: ImportItem[]
  /** Distinct out-of-range numbers, ascending (shown as a warning). */
  outOfRange: number[]
}

export function guardImportItems(items: ImportItem[], max = MAX_IMPORT_IMAGE): GuardedItems {
  const found = new Set<number>()
  const out = items.map((item) => {
    let masked = false
    const text = item.text.replace(TOKEN_RE, (whole, kind: string, raw: string) => {
      if (kind.toLowerCase() !== 'image') return whole
      const n = Number(raw)
      if (n <= max) return whole
      found.add(n)
      masked = true
      return MASK + whole.slice(1)
    })
    return masked ? { ...item, text } : item
  })
  return { items: out, outOfRange: [...found].sort((a, b) => a - b) }
}

/** Put the masked tokens back as they were written. */
export function unmaskTokens(text: string): string {
  return text.includes(MASK) ? text.replace(MASKED_RE, '@$1') : text
}
