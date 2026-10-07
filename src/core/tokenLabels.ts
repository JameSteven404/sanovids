// Labels of the red placeholders a removed reference image leaves in a prompt ("@image_?2(Lumi)", see
// core/placeholders.ts) and of real tokens carrying such a label ("@image_2(Lumi)": the user deleted the "?").
// Pure, no imports: shared by core/compile (blocking a label that does not fit its slot) and core/placeholders
// (making labels, grouping, filling).

/** Longest label kept, in code points (a longer name is cut, then "…" is added). */
export const LABEL_MAX = 40

/**
 * A name made safe to stand between the parentheses of a placeholder: NFC; "( ) [ ] @ ?" and line breaks / tabs
 * become spaces (a "(" would end the label, an "@" or "?" could read as a token or a mention); spaces collapse; at most
 * LABEL_MAX code points (cut at a word boundary when one lies at least 20 code points in), then "…". Blank → null.
 */
export function sanitizeLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.normalize('NFC').replace(/[()[\]@?\n\r\t]/g, ' ').replace(/\s+/gu, ' ').trim()
  if (!s) return null
  const cps = [...s]
  if (cps.length <= LABEL_MAX) return s
  let head = cps.slice(0, LABEL_MAX)
  const space = head.lastIndexOf(' ')
  if (space >= 20) head = head.slice(0, space)
  return head.join('').trimEnd() + '…'
}

/** " · ảnh 2" at the end of a label: the picture number of the character (written by the app, NFC). */
const PICTURE_SUFFIX = /^(.*?\S)\s*·\s*ảnh\s*(\d+)$/u

/** The label without its " · ảnh k" suffix (`base`) and that picture number (`k`, 1 without a suffix). */
export function splitLabel(label: string): { base: string; k: number } {
  const s = label.normalize('NFC').trim()
  const m = PICTURE_SUFFIX.exec(s)
  if (m && Number(m[2]) >= 1) return { base: m[1].trim(), k: Number(m[2]) }
  return { base: s, k: 1 }
}

/** Comparison form of a label / name: NFC, trimmed, lower case. */
export const foldLabel = (s: string) => s.normalize('NFC').trim().toLowerCase()

/**
 * Text a character goes by in a label: its name — unless another character of the project has the same name (NFC,
 * trimmed, any case) or the name is blank: then its tag, which is unique (two roles both called "Lumi" never share a
 * label). Sanitized; null when there is nothing to show.
 */
export function characterLabel(asset: { id: string; name: string; tag: string }, all: readonly { id: string; name: string }[]): string | null {
  const name = sanitizeLabel(asset.name)
  if (name && !nameShared(asset, all)) return name
  return sanitizeLabel(asset.tag) ?? name
}

/** Does another character of `all` carry the same name (NFC, trimmed, any case)? */
export function nameShared(asset: { id: string; name: string }, all: readonly { id: string; name: string }[]): boolean {
  const key = foldLabel(asset.name)
  return !!key && all.some((a) => a.id !== asset.id && foldLabel(a.name) === key)
}

/**
 * Does `label` (as glued to a real token: "@image_2(Lumi)") describe the picture that token names now — picture
 * `imageIndex + 1` of `asset`? The label's base must be the character's name (only when no other character shares it)
 * or its tag, and its " · ảnh k" number (1 without one) must be that picture. A label that does not fit blocks the run:
 * the "?" of a placeholder was deleted by hand while the number now names another character.
 */
export function labelFitsSlot(label: string, asset: { id: string; name: string; tag: string }, imageIndex: number, all: readonly { id: string; name: string }[]): boolean {
  const { base, k } = splitLabel(label)
  if (k !== imageIndex + 1) return false
  const key = foldLabel(base)
  if (!key) return false
  const names = [asset.tag, ...(nameShared(asset, all) ? [] : [asset.name])]
  return names.some((n) => {
    const clean = sanitizeLabel(n)
    return (!!clean && foldLabel(clean) === key) || foldLabel(n) === key
  })
}
