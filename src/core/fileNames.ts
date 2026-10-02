// Pure file-name rules shared by downloads, the "Tên file" rename of a take and the folder node (unit-tested in
// ./__tests__/fileNames.test.ts). No stores, no DOM.

/** Characters Windows / macOS refuse in a file name, plus control characters (a path separator is one of them). */
const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g
/** Device names Windows reserves, with or without an extension ("CON", "nul.txt", "COM1"). */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
/** Longest base name kept (the extension and a " (12)" suffix are added after it). */
export const MAX_BASE_LENGTH = 120
/** Extensions SanoVids adds itself: typed at the end of a new name they are dropped ("Cảnh mở đầu.mp4" → "Cảnh mở đầu"). */
const OWN_EXT = /\.(mp4|webm|mov|mkv|m4v|txt|jpe?g|png|webp|zip)$/i

/**
 * A base name that is safe on every OS, or '' when nothing usable is left: forbidden characters and path separators
 * become "-", runs of spaces one space, no leading / trailing dots or spaces (Windows drops trailing ones, a leading
 * one hides the file), never "." / "..", never a reserved device name (prefixed with "_"), at most MAX_BASE_LENGTH.
 */
export function cleanFileBase(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let s = raw.normalize('NFC').replace(BAD_CHARS, '-').replace(/\s+/g, ' ').trim()
  s = s.slice(0, MAX_BASE_LENGTH).replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (RESERVED.test(s)) s = '_' + s
  return s
}

/** A safe file name, never empty ("video" when nothing usable is left). */
export function safeFileName(name: string): string {
  return cleanFileBase(name) || 'video'
}

/**
 * The custom file name a user typed for a take (without extension), or null = use the default name
 * ("S01_T1 - title"). An extension SanoVids adds itself (.mp4, .webm, .txt…) is dropped.
 */
export function cleanTakeFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return cleanFileBase(raw.trim().replace(OWN_EXT, '')) || null
}

/** "clip.v2.mp4" → { base: "clip.v2", ext: ".mp4" }; no extension → ext ''. A leading dot is not an extension. */
export function splitExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' }
}

/** "S01_T1.webm", 2 → "S01_T1 (2).webm" (the same rule as the browser / desktop app downloads). */
export function numberedName(name: string, n: number): string {
  if (n < 2) return name
  const { base, ext } = splitExt(name)
  return `${base} (${n})${ext}`
}

/**
 * Names for a group of files (a video and its .txt) that do not exist yet: the same " (n)" suffix for the whole
 * group, so the pair stays matched.
 */
export async function freeNames(names: string[], exists: (name: string) => boolean | Promise<boolean>): Promise<string[]> {
  for (let n = 1; n < 1000; n++) {
    const candidate = names.map((x) => numberedName(x, n))
    let free = true
    for (const c of candidate) {
      if (await exists(c)) {
        free = false
        break
      }
    }
    if (free) return candidate
  }
  return names.map((x) => numberedName(x, Date.now()))
}

/**
 * Unique names inside one archive (zip): a name already used gets " (2)", " (3)"… — two takes renamed alike must not
 * overwrite each other in the .zip. `used` is updated (case-insensitive, like Windows).
 */
export function uniqueInSet(name: string, used: Set<string>): string {
  let n = 1
  let out = name
  while (used.has(out.toLowerCase())) out = numberedName(name, ++n)
  used.add(out.toLowerCase())
  return out
}

/** Name of the companion file (the prompt .txt) for a video saved as `chosen`: same base name, its own extension. */
export function companionFor(chosen: string, companion: string): string {
  return splitExt(chosen).base + splitExt(companion).ext
}
