// Pure helpers for the @image_N / @video_N prompt editor (no React / DOM / store imports — unit-tested).
// - segmentPrompt: split a prompt into plain text and token runs for the highlight backdrop.
// - suggestMedia: what the "@" popup lists for a typed query (linked images, linked videos, library assets).
// - insertAt: insert a token at a selection with sensible spacing.
// - legacy @Tag helpers for the "Đổi @Tên → @image_N" quick fix.
import { imageSlotsFor, mediaKeys, remapTokens } from '../../core/compile'
import type { Asset, AssetKind } from '../../core/types'
import { fold } from './mentions'

// ---------------------------------------------------------------------------------------------
// Highlight segmentation
// ---------------------------------------------------------------------------------------------

export type SegKind = 'text' | 'image' | 'video' | 'legacy'

export interface Seg {
  kind: SegKind
  text: string
  /** N of @image_N / @video_N. */
  n?: number
  /** No picture/video behind this token in the request (see `reason`). */
  invalid?: boolean
  /**
   * Why it is invalid: 'missing' = number outside the scene's media, 'unsent' = linked but not sent (over the model's
   * limit, or a mode that sends no images), 'unbound' = an "@image_?N" placeholder waiting for the right number.
   */
  reason?: 'missing' | 'unsent' | 'unbound'
}

/** Tooltip for an invalid token. */
export function invalidTokenTitle(seg: Seg): string {
  if (seg.reason === 'unbound') return `${seg.text}: chưa gắn ảnh/video nào — nối vào cảnh rồi sửa thành số đúng`
  if (seg.reason === 'unsent') return `${seg.text}: sẽ không được gửi (vượt giới hạn của model, hoặc chế độ này không gửi tham chiếu)`
  return `${seg.text} không tồn tại`
}

/** One pass: numbered tokens (or "@image_?N" placeholders) first, otherwise any @Word (legacy tag in `legacyTags`). */
const SEG_RE = /@(?:(image|video)(?:_(\?)|[ _])?(\d+)\b|([\p{L}\p{N}_]+))/giu

/**
 * Split `text` into segments for the backdrop highlighter. Concatenating every `seg.text` gives back `text`.
 * `legacyTags` holds lower-cased asset tags; other @words stay plain text.
 * `sent`: how many images / videos the request really carries (model limit, mode) — tokens past it are invalid too,
 * because the model would never see that picture (wrong character in the video).
 */
export function segmentPrompt(
  text: string,
  imageCount: number,
  videoCount: number,
  legacyTags?: ReadonlySet<string>,
  sent?: { images: number; videos: number },
): Seg[] {
  const out: Seg[] = []
  let last = 0
  const push = (seg: Seg) => {
    const prev = out[out.length - 1]
    if (seg.kind === 'text' && prev?.kind === 'text') prev.text += seg.text
    else out.push(seg)
  }
  for (const m of text.matchAll(SEG_RE)) {
    const idx = m.index ?? 0
    const whole = m[0]
    let seg: Seg | null = null
    if (m[1]) {
      const kind = m[1].toLowerCase() as 'image' | 'video'
      const n = Number(m[3])
      const max = kind === 'image' ? imageCount : videoCount
      const sentMax = sent ? (kind === 'image' ? sent.images : sent.videos) : max
      const reason = m[2] ? 'unbound' : n < 1 || n > max ? 'missing' : n > sentMax ? 'unsent' : undefined
      seg = reason ? { kind, text: whole, n, invalid: true, reason } : { kind, text: whole, n, invalid: false }
    } else if (legacyTags && m[4] && legacyTags.has(m[4].toLowerCase())) {
      seg = { kind: 'legacy', text: whole }
    }
    if (!seg) continue
    if (idx > last) push({ kind: 'text', text: text.slice(last, idx) })
    push(seg)
    last = idx + whole.length
  }
  if (last < text.length) push({ kind: 'text', text: text.slice(last) })
  return out
}

// ---------------------------------------------------------------------------------------------
// "@" popup suggestions
// ---------------------------------------------------------------------------------------------

export interface ImageOpt {
  n: number
  assetId: string
  imageId: string
  /** 0 = primary image of the asset. */
  imageIndex: number
  /** How many images the asset has (to show "ảnh 2/3"). */
  imageTotal: number
  name: string
  tag: string
  kind: AssetKind
}

/** Numbered image slots of a list of refs, with asset names (legend, popup, refs list). */
export function imageOptsFor(assets: Asset[], refs: string[]): ImageOpt[] {
  const byId = new Map(assets.map((a) => [a.id, a]))
  return imageSlotsFor(assets, refs).map((s) => {
    const a = byId.get(s.assetId)!
    return { n: s.n, assetId: s.assetId, imageId: s.imageId, imageIndex: s.imageIndex, imageTotal: a.imageIds.length, name: a.name, tag: a.tag, kind: a.kind }
  })
}

export interface VideoOpt {
  n: number
  takeId: string
  /** "S03·T2" */
  label: string
  posterId: string | null
  status: string
}

export interface LibraryOpt {
  assetId: string
  name: string
  tag: string
  kind: AssetKind
}

export type MediaSuggestion =
  | ({ type: 'image' } & ImageOpt)
  | ({ type: 'video' } & VideoOpt)
  | ({ type: 'link' } & LibraryOpt)

export const MAX_MEDIA_SUGGESTIONS = 40
const LIBRARY_WHEN_EMPTY = 8

/** Score of a text field against a folded query (lower is better, -1 = no match). */
function textScore(q: string, ...fields: string[]): number {
  let best = -1
  for (const raw of fields) {
    const f = fold(raw)
    let s = -1
    if (f.startsWith(q)) s = 1
    else if (f.split(/[\s·_-]+/).some((w) => w.startsWith(q))) s = 2
    else if (f.includes(q)) s = 3
    if (s >= 0 && (best < 0 || s < best)) best = s
  }
  return best
}

/** Score of a numbered token ("image_3") against the query: "3", "ima", "image_3". */
function tokenScore(q: string, kind: 'image' | 'video', n: number): number {
  const num = String(n)
  if (/^\d+$/.test(q)) return num === q ? 0 : num.startsWith(q) ? 1.2 : -1
  const tok = `${kind}_${n}`
  if (tok === q) return 0
  if (tok.startsWith(q)) return 0.5
  return -1
}

/**
 * Items for the "@" popup. `query` is what was typed after "@" (may be empty).
 * Order: best match first; on ties linked images, then linked videos, then library assets ("Nối & chèn").
 * Library assets that are already linked, or have no image, are not offered.
 */
export function suggestMedia(
  query: string,
  images: ImageOpt[],
  videos: VideoOpt[],
  library: LibraryOpt[],
  max = MAX_MEDIA_SUGGESTIONS,
): MediaSuggestion[] {
  const q = fold(query.trim())
  if (!q) {
    return [
      ...images.map((i) => ({ type: 'image' as const, ...i })),
      ...videos.map((v) => ({ type: 'video' as const, ...v })),
      ...library.slice(0, LIBRARY_WHEN_EMPTY).map((a) => ({ type: 'link' as const, ...a })),
    ].slice(0, max)
  }
  const scored: { item: MediaSuggestion; s: number; group: number; order: number }[] = []
  const add = (item: MediaSuggestion, s: number, group: number, order: number) => {
    if (s >= 0) scored.push({ item, s, group, order })
  }
  // "@2" means a number: only numbered media match it (not "S03·T2" or a name containing 2).
  const numeric = /^\d+$/.test(q)
  for (const i of images) {
    const t = tokenScore(q, 'image', i.n)
    const s = t >= 0 || numeric ? t : textScore(q, i.name, i.tag)
    add({ type: 'image', ...i }, s, 0, i.n)
  }
  for (const v of videos) {
    const t = tokenScore(q, 'video', v.n)
    const compact = v.label.replace(/[^\p{L}\p{N}]/gu, '')
    const s = t >= 0 || numeric ? t : textScore(q, v.label, compact)
    add({ type: 'video', ...v }, s, 1, v.n)
  }
  for (const [i, a] of library.entries()) {
    // Not linked yet: rank just below an equally good linked image. A number never offers them ("@5" + Enter must
    // not link "Lính 5").
    const s = numeric ? -1 : textScore(q, a.tag, a.name)
    add({ type: 'link', ...a }, s >= 0 ? s + 0.5 : -1, 2, i)
  }
  scored.sort((a, b) => a.s - b.s || a.group - b.group || a.order - b.order)
  return scored.slice(0, max).map((x) => x.item)
}

/** Token text a suggestion inserts (library items get theirs after linking). */
export function suggestionToken(s: MediaSuggestion): string | null {
  if (s.type === 'image') return `@image_${s.n}`
  if (s.type === 'video') return `@video_${s.n}`
  return null
}

// ---------------------------------------------------------------------------------------------
// Linking media from the editor (drop, "Nối & chèn", legacy fix) — planned first, applied in one store step
// ---------------------------------------------------------------------------------------------

export interface ImageLinkPlan {
  /** scene.refs after linking (new ones appended, so existing @image numbers do not move). */
  refs: string[]
  /** "@image_N" (first image) of each requested asset that has one, in request order. */
  tokens: Map<string, string>
  /** Asset ids newly linked. */
  linked: string[]
  /** Requested assets without any image (no number to insert). */
  noImage: number
  /** Not linked: the model's image limit would be exceeded. */
  overLimit: number
}

/** Link `ids` to a scene whose refs are `refs`, like the store's addRefs (appended, within `maxImages` images). */
export function planImageLinks(assets: Asset[], refs: string[], ids: string[], maxImages: number): ImageLinkPlan {
  const byId = new Map(assets.map((a) => [a.id, a]))
  // Same count as the store's refImageCount: an asset without image (or a deleted one) still takes one slot.
  const weight = (id: string) => Math.max(1, byId.get(id)?.imageIds.length ?? 0)
  let used = refs.reduce((t, id) => t + weight(id), 0)
  let next = refs
  const linked: string[] = []
  const wanted: string[] = []
  let noImage = 0
  let overLimit = 0
  for (const id of new Set(ids)) {
    const a = byId.get(id)
    if (!a) continue
    if (!a.imageIds.length) {
      noImage++
      continue
    }
    if (!next.includes(id)) {
      if (used + weight(id) > maxImages) {
        overLimit++
        continue
      }
      next = [...next, id]
      used += weight(id)
      linked.push(id)
    }
    wanted.push(id)
  }
  const slots = imageSlotsFor(assets, next)
  const tokens = new Map<string, string>()
  for (const id of wanted) {
    const slot = slots.find((s) => s.assetId === id)
    if (slot) tokens.set(id, `@image_${slot.n}`)
  }
  return { refs: next, tokens, linked, noImage, overLimit }
}

export interface VideoLinkPlan {
  videoRefs: string[]
  /** "@video_N" of each requested take that is (or gets) linked, in request order. */
  tokens: string[]
  linked: string[]
  /** Not finished yet (only completed takes can be used). */
  notReady: number
  /** Takes of this very scene (a scene cannot reference its own video). */
  own: number
  /** Not linked: over the model / mode's video limit (0 when the mode takes no video). */
  overLimit: number
}

/** Link takes to a scene as reference videos, like the store's addVideoRefs + actions.linkTakes' rules. */
export function planVideoLinks(
  sceneId: string,
  videoRefs: string[],
  ids: string[],
  takes: { id: string; sceneId: string; status: string }[],
  maxVideos: number,
): VideoLinkPlan {
  let next = videoRefs
  const linked: string[] = []
  const wanted: string[] = []
  let notReady = 0
  let own = 0
  let overLimit = 0
  for (const id of new Set(ids)) {
    if (!next.includes(id)) {
      const t = takes.find((x) => x.id === id)
      if (!t || t.status !== 'completed') {
        notReady++
        continue
      }
      if (t.sceneId === sceneId) {
        own++
        continue
      }
      if (next.length >= maxVideos) {
        overLimit++
        continue
      }
      next = [...next, id]
      linked.push(id)
    }
    wanted.push(id)
  }
  return { videoRefs: next, tokens: wanted.map((id) => `@video_${next.indexOf(id) + 1}`), linked, notReady, own, overLimit }
}

/**
 * `prompt` after a scene's image refs changed from `before` to `after` (same video refs): each @image_N keeps its
 * picture; tokens of images no longer referenced become the asset's name (its tag when the name is empty).
 */
export function renumberImageTokens(prompt: string, assets: Asset[], before: string[], after: string[], videoRefs: string[]): string {
  if (!/@image_\d/i.test(prompt)) return prompt
  const names = new Map(assets.map((a) => [a.id, a.name.trim() || a.tag]))
  const fallback = (kind: 'image' | 'video', key: string) => (kind === 'image' ? names.get(key.split(':')[0]) || 'ảnh' : 'video')
  return remapTokens(prompt, mediaKeys(assets, before, videoRefs), mediaKeys(assets, after, videoRefs), fallback).text
}

// ---------------------------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------------------------

const OPENERS = /[\s([{"'“‘]$/
const CLOSERS = /^[\s.,;:!?)\]}"'’”]/

const WORD_CH = /[\p{L}\p{M}\p{N}_@]/u

/** Where dropped media tokens go: a drop inside a word (or an @token) moves to the end of it, so it is never split. */
export function snapToWordEnd(text: string, at: number): number {
  let i = Math.max(0, Math.min(at, text.length))
  if (i === 0 || i === text.length || !WORD_CH.test(text[i - 1]) || !WORD_CH.test(text[i])) return i
  while (i < text.length && WORD_CH.test(text[i])) i++
  return i
}

/**
 * Insert `token` replacing text[start, end), padding with spaces so it never glues to a word.
 * `last`: index in `next` of the "@" of the last inserted token (`token` may be several joined tokens), where the
 * "@" popup must stay closed when the caret ends right after it (inserted before "." for example).
 */
export function insertAt(text: string, start: number, end: number, token: string): { insert: string; next: string; caret: number; last: number } {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before && !OPENERS.test(before) ? ' ' : ''
  const trail = CLOSERS.test(after) ? '' : ' '
  const insert = lead + token + trail
  // Caret after the token: skip an existing following space so the user can keep typing.
  const caret = start + insert.length + (!trail && after.startsWith(' ') ? 1 : 0)
  return { insert, next: before + insert + after, caret, last: start + lead.length + Math.max(0, token.lastIndexOf('@')) }
}

/**
 * Where offset `pos` of `prev` lands after an external rewrite into `next` (token renumbering, undo…): kept before
 * the first changed character, shifted by the length change after it.
 */
export function remapOffset(prev: string, next: string, pos: number): number {
  let p = 0
  const lim = Math.min(prev.length, next.length)
  while (p < lim && prev.charCodeAt(p) === next.charCodeAt(p)) p++
  return Math.min(next.length, pos <= p ? pos : Math.max(p, pos + next.length - prev.length))
}

// ---------------------------------------------------------------------------------------------
// Legacy @Tag mentions
// ---------------------------------------------------------------------------------------------

const MENTION = /@(?!(?:[iI][mM][aA][gG][eE]|[vV][iI][dD][eE][oO])[ _]?\d)([\p{L}\p{N}_]+)/gu
const RAW_TOKEN = /^(image|video)_?\d+$/i

/** Library assets mentioned with a legacy @Tag in `text`, in order of first appearance. */
export function legacyAssets(text: string, assets: Asset[]): Asset[] {
  if (!text.includes('@')) return []
  const byTag = new Map(assets.map((a) => [a.tag.toLowerCase(), a]))
  const seen = new Set<string>()
  const out: Asset[] = []
  for (const m of text.matchAll(MENTION)) {
    const key = m[1].toLowerCase()
    if (RAW_TOKEN.test(key) || seen.has(key)) continue
    seen.add(key)
    const a = byTag.get(key)
    if (a) out.push(a)
  }
  return out
}

/**
 * Toast after "Đổi @Tên → @image_N": how many were replaced and why the others were skipped (no image yet, or
 * over the model's image limit). Null when there is nothing to add (limit refusals were already reported).
 */
export function legacyFixMessage(replaced: number, noImage: number, overLimit: number): { text: string; tone: 'success' | 'warning' } | null {
  if (replaced) {
    const skipped = [noImage ? `${noImage} mục chưa có ảnh` : '', overLimit ? `${overLimit} mục vượt giới hạn ảnh của model` : ''].filter(Boolean).join(', ')
    return { text: `Đã đổi ${replaced} @Tên thành @image_N${skipped ? ` (bỏ qua ${skipped})` : ''}.`, tone: 'success' }
  }
  if (noImage) return { text: `Bỏ qua ${noImage} mục chưa có ảnh nên chưa có số @image. Thêm ảnh cho chúng trước.`, tone: 'warning' }
  return null
}

/** Replace legacy @Tag mentions whose lower-cased tag is in `tokens` with the mapped "@image_N". */
export function replaceLegacyTags(text: string, tokens: ReadonlyMap<string, string>): { text: string; replaced: number } {
  let replaced = 0
  const next = text.replace(MENTION, (whole, tag: string) => {
    const t = tokens.get(tag.toLowerCase())
    if (!t) return whole
    replaced++
    return t
  })
  return { text: next, replaced }
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

/** "3 ảnh · 1 video" */
export function mediaCountLabel(images: number, videos: number): string {
  return `${images} ảnh · ${videos} video`
}
