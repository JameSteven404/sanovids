// "Nhập prompt cũ": turn a pile of old prompts (pasted text or .txt files) into scenes.
// Pure module (no React, no stores) — covered by src/core/__tests__/importPrompts.test.ts.
//
// Every prompt is kept exactly as written: @image_N / @video_N tokens stay as they are.
// Optional "Gán ảnh theo số": the user maps image numbers to library assets (one mapping for every imported
// scene). The scenes then get those assets as reference images, and their @image_N tokens are renumbered so
// each one still points at the asset that was chosen for it.
//
//   text / .txt files ──parsePromptText / itemsFromFiles──▶ items (title + prompt)
//   items ──previewItem / summarizeImport──▶ what the dialog shows
//   items + mapping ──buildImportScenes──▶ { title, prompt, refs }[] for project.applyImport()
import { imageSlotsFor, TOKEN_RE, unboundToken, withTokenNumber } from './compile'
import type { Asset } from './types'

export interface ImportItem {
  /** Scene title (from a `=== Title ===` header line or a file name). May be empty. */
  title: string
  text: string
}

const SEPARATOR_LINE = /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/
const HEADER_LINE = /^\s*={3,}\s*(\S.*?)\s*={3,}\s*$/

const toLF = (s: string) => s.replace(/\r\n?/g, '\n')

function headerTitle(raw: string): string {
  // "S01: Dawn climb" / "S01 · Dawn climb" / "S01" / "Dawn climb", plus the take code of the app's own
  // prompts.txt ("Tải tất cả take ★"): "S01_T2 - Dawn climb" / "S02_T1" / "S03·T2: Dawn climb".
  return raw
    .replace(/^S\d+(?:\s*[_·]?\s*T\d+\b)?\s*(?:[:·\-–—|.]\s*)?/i, '')
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

/** Title of a scene imported from a file: the file name without its extension. */
export function fileTitle(name: string): string {
  return name.replace(/\.[^.\\/]+$/, '').trim()
}

/**
 * One scene per file (canvasapp saves one .txt per video), title = file name.
 * Sorted by name with numbers in natural order ("2" before "10"); empty files are dropped.
 */
export function itemsFromFiles(files: { name: string; text: string }[]): ImportItem[] {
  return files
    .map((f) => ({ title: fileTitle(f.name), text: toLF(f.text).trim() }))
    .filter((i) => i.text)
    .sort((a, b) => a.title.localeCompare(b.title, 'vi', { numeric: true }))
}

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

export interface TokenScan {
  /** Distinct N of @image_N, ascending. */
  images: number[]
  /** Distinct N of @video_N, ascending. */
  videos: number[]
}

/** Numbers used by @image_N / @video_N tokens (case-insensitive, N ≥ 1). */
export function scanTokens(text: string): TokenScan {
  const images = new Set<number>()
  const videos = new Set<number>()
  for (const m of text.matchAll(TOKEN_RE)) {
    const n = Number(m[2])
    if (n < 1) continue
    if (m[1].toLowerCase() === 'image') images.add(n)
    else videos.add(n)
  }
  const asc = (a: number, b: number) => a - b
  return { images: [...images].sort(asc), videos: [...videos].sort(asc) }
}

export interface ImportPreview extends TokenScan {
  title: string
  /** First non-empty lines of the prompt. */
  excerpt: string
  /** Characters (code points) of the prompt. */
  chars: number
}

export function previewItem(item: ImportItem, maxLines = 3): ImportPreview {
  const lines = item.text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return { title: item.title, excerpt: lines.slice(0, maxLines).join('\n'), chars: [...item.text].length, ...scanTokens(item.text) }
}

/**
 * Highest @image_N / @video_N number the summary counts. Models take far fewer references; a bigger number is a
 * date or a typo ("@image_20241002") and would make the dialog build one mapping row per number up to it.
 */
export const MAX_SUMMARY_TOKEN = 99

export interface ImportSummary {
  prompts: number
  chars: number
  /** Distinct N of @image_N mentioned by at least one prompt (N ≤ the cap), ascending. */
  images: number[]
  /** Distinct N of @video_N mentioned by at least one prompt (N ≤ the cap), ascending. */
  videos: number[]
  /** Highest counted N of @image_N (0 = none). */
  maxImage: number
  /** Highest counted N of @video_N (0 = none). */
  maxVideo: number
  /** Prompts with at least one counted @image_N / @video_N token. */
  withImages: number
  withVideos: number
  /** imageUsage[N - 1] = number of prompts that mention @image_N (a prompt counts once per number). */
  imageUsage: number[]
  /** Distinct numbers above the cap, left out of everything above (kept as written in the prompts), ascending. */
  ignored: TokenScan
}

/**
 * What the import dialog shows about a batch of prompts. Only distinct numbers are counted (a prompt mentioning
 * @image_2 three times counts once for 2), and numbers above `cap` are ignored — so the usage array never grows
 * past `cap` entries, whatever was pasted.
 */
export function summarizeImport(items: ImportItem[], cap = MAX_SUMMARY_TOKEN): ImportSummary {
  const usage = new Map<number, number>()
  const videos = new Set<number>()
  const ignoredImages = new Set<number>()
  const ignoredVideos = new Set<number>()
  let chars = 0
  let withImages = 0
  let withVideos = 0
  for (const item of items) {
    chars += [...item.text].length
    // scanTokens: distinct numbers of this prompt.
    const scan = scanTokens(item.text)
    let image = false
    let video = false
    for (const n of scan.images) {
      if (n > cap) ignoredImages.add(n)
      else {
        usage.set(n, (usage.get(n) ?? 0) + 1)
        image = true
      }
    }
    for (const n of scan.videos) {
      if (n > cap) ignoredVideos.add(n)
      else {
        videos.add(n)
        video = true
      }
    }
    if (image) withImages++
    if (video) withVideos++
  }
  const asc = (a: number, b: number) => a - b
  const images = [...usage.keys()].sort(asc)
  const videoList = [...videos].sort(asc)
  const maxImage = images.length ? images[images.length - 1] : 0
  return {
    prompts: items.length,
    chars,
    images,
    videos: videoList,
    maxImage,
    maxVideo: videoList.length ? videoList[videoList.length - 1] : 0,
    withImages,
    withVideos,
    imageUsage: Array.from({ length: maxImage }, (_, i) => usage.get(i + 1) ?? 0),
    ignored: { images: [...ignoredImages].sort(asc), videos: [...ignoredVideos].sort(asc) },
  }
}

// ---------------------------------------------------------------------------------------------
// "Gán ảnh theo số"
// ---------------------------------------------------------------------------------------------

/** mapping[N - 1] = asset id chosen for @image_N, or null when that number is left unassigned. */
export type ImageMapping = (string | null)[]

export interface MappedPrompt {
  prompt: string
  /** Reference assets of the scene, in the order of the numbers they were assigned to. */
  refs: string[]
  /** Number of reference images those assets send (each image of an asset gets its own @image number). */
  images: number
  /** Original numbers mentioned in the prompt that have no asset: renumbered after the linked images. */
  pending: number[]
}

/** True when at least one number is assigned to an asset that has images. */
export function hasMapping(mapping: ImageMapping | undefined, assets: Asset[]): boolean {
  if (!mapping?.length) return false
  const withImages = new Set(assets.filter((a) => a.imageIds.length).map((a) => a.id))
  return mapping.some((id) => !!id && withImages.has(id))
}

/**
 * Apply an image mapping to one prompt.
 * - The scene's refs are the assigned assets in number order (each asset once). With `onlyMentioned`
 *   (default) only the assets whose number the prompt mentions are linked.
 * - The k-th number assigned to the same asset points at its k-th image (wrapping to the primary image when
 *   the asset has fewer images), so "@image_1 = Elara, @image_2 = Elara" keeps two different pictures.
 * - Tokens are renumbered to the image numbers of the new refs. Mentioned numbers without an asset become
 *   placeholders "@image_?N" (they must never silently point at whatever image is linked next); the scene
 *   will not run until the user links a picture and writes the right number.
 * - Assets without images are ignored (they would not get a number). @video_N tokens are never touched.
 * - Without any usable assignment the prompt is returned unchanged.
 */
export function applyImageMapping(
  prompt: string,
  mapping: ImageMapping,
  assets: Asset[],
  opts: { onlyMentioned?: boolean } = {},
): MappedPrompt {
  const onlyMentioned = opts.onlyMentioned ?? true
  const byId = new Map(assets.map((a) => [a.id, a]))
  const target = new Map<number, { assetId: string; imageIndex: number }>()
  const seen = new Map<string, number>()
  mapping.forEach((id, i) => {
    const asset = id ? byId.get(id) : undefined
    if (!asset || !asset.imageIds.length) return
    const k = seen.get(asset.id) ?? 0
    seen.set(asset.id, k + 1)
    target.set(i + 1, { assetId: asset.id, imageIndex: k < asset.imageIds.length ? k : 0 })
  })
  const mentioned = scanTokens(prompt).images
  if (!target.size) return { prompt, refs: [], images: 0, pending: mentioned }

  const used = onlyMentioned ? mentioned.filter((n) => target.has(n)) : [...target.keys()].sort((a, b) => a - b)
  const refs: string[] = []
  for (const n of used) {
    const id = target.get(n)!.assetId
    if (!refs.includes(id)) refs.push(id)
  }
  const slots = imageSlotsFor(assets, refs)
  const renumber = new Map<number, number>()
  for (const n of used) {
    const t = target.get(n)!
    const slot = slots.find((s) => s.assetId === t.assetId && s.imageIndex === t.imageIndex)
    if (slot) renumber.set(n, slot.n)
  }
  const pending = mentioned.filter((n) => !renumber.has(n))

  const text = prompt.replace(TOKEN_RE, (whole, kind: string, raw: string) => {
    if (kind.toLowerCase() !== 'image') return whole
    const next = renumber.get(Number(raw))
    return next === undefined ? unboundToken('image', raw) : withTokenNumber(whole, next)
  })
  return { prompt: text, refs, images: slots.length, pending }
}

export interface ImportScene {
  title: string
  prompt: string
  refs: string[]
}

/** Scenes for `project.applyImport`. Without a mapping the prompts are kept untouched and get no refs. */
export function buildImportScenes(
  items: ImportItem[],
  opts: { mapping?: ImageMapping; assets?: Asset[]; onlyMentioned?: boolean } = {},
): ImportScene[] {
  const assets = opts.assets ?? []
  const mapped = hasMapping(opts.mapping, assets)
  return items.map((item) => {
    const title = item.title.trim()
    if (!mapped) return { title, prompt: item.text, refs: [] }
    const m = applyImageMapping(item.text, opts.mapping!, assets, { onlyMentioned: opts.onlyMentioned })
    return { title, prompt: m.prompt, refs: m.refs }
  })
}

// ---------------------------------------------------------------------------------------------
// Sample used by the "Dùng ví dụ" button: 3 short original prompts written the canvasapp way, with
// numbered image references (@image_1 = the keeper, @image_2 = the dog, @image_3 = the lighthouse).
const SAMPLE_STYLE =
  'Cinematic live-action short film, quiet coastal drama. Overcast natural light, muted teal and amber palette, handheld camera, shallow depth of field.'
const SAMPLE_AUDIO = 'Audio: natural ambience only — wind, surf, footsteps on iron stairs. No music, no narration, no subtitles.'

export const SAMPLE_IMPORT_TEXT = [
  '=== S01: Ngọn đèn lúc bình minh ===',
  SAMPLE_STYLE,
  'Dawn. Mara (@image_1), an elderly lighthouse keeper in a yellow raincoat, climbs the spiral stairs of the lighthouse (@image_3) carrying a brass storm lantern. At the narrow window she stops and watches a small fishing boat fight the grey waves.',
  SAMPLE_AUDIO,
  '=== S02: Con chó dưới ghềnh đá ===',
  SAMPLE_STYLE,
  'On the rocky shore below the tower, Mara (@image_1) finds a soaked grey dog (@image_2) tangled in an old fishing net. She kneels, cuts the net with a pocket knife and wraps the shivering dog in her coat.',
  SAMPLE_AUDIO,
  '=== S03: Tín hiệu đáp lại ===',
  SAMPLE_STYLE,
  'Night. Mara (@image_1) and the dog (@image_2) sit by the iron stove inside the lighthouse (@image_3). The beam sweeps over the dark sea; far away the fishing boat blinks its lights twice, and Mara smiles.',
  SAMPLE_AUDIO,
].join('\n\n')
