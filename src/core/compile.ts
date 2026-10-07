import { MODELS, usesRefs } from './models'
import { labelFitsSlot, splitLabel } from './tokenLabels'
import type { Asset, CompiledImage, CompiledPrompt, Project, Scene } from './types'

/**
 * Legacy @Tag mention: letters (incl. Vietnamese), digits, underscore. Never a numbered token: "@image_1", "@Image 1",
 * "@image1" are media tokens, not tags — and never the start of a placeholder ("@image_?2(Lumi)" is no "@image_" tag).
 */
export const MENTION_RE = /@(?!(?:[iI][mM][aA][gG][eE]|[vV][iI][dD][eE][oO])(?:[ _]?\d|_\?))([\p{L}\p{N}_]+)/gu
/**
 * Numbered media token. Group 1 = kind, group 2 = number. Any case, and "_", a space or nothing before the number:
 * "@image_1", "@Image 1", "@IMAGE1" all name image 1 (prompts written elsewhere use all of these). `video` stays in
 * every token pattern although reference videos were retired: "@video1" must never read as a legacy @Tag, and no
 * asset may take the tag "video_1" (an old @video token is recognised, kept verbatim and blocks the run — see
 * retiredVideoTokens).
 */
export const TOKEN_RE = /@(image|video)[ _]?(\d+)\b/gi
/** Quick test: does a text contain any numbered media token? */
export const HAS_TOKEN_RE = /@(image|video)[ _]?\d/i
const RAW_TOKEN = /^(image|video)_?\d+$/i
/** The same token with another number, keeping how the user wrote it ("@Image 1" → "@Image 3"). */
export const withTokenNumber = (token: string, n: number) => token.replace(/\d+$/, String(n))
/** Placeholder for a number that has no image yet (e.g. left over by an edit or an import): "@image_?3". */
export const UNBOUND_RE = /@(image|video)_\?(\d+)/gi
export const unboundToken = (kind: 'image' | 'video', n: number | string) => `@${kind}_?${n}`
/**
 * A red placeholder with its optional label glued to it: "@image_?2(Lumi)" = the token "@image_2" whose picture
 * (Lumi) was removed from the scene (core/placeholders removalLabels). Group 1 = kind, 2 = the old number, 3 = the
 * label. The "(" must follow the number directly: in "@image_?2 (cười)" only "@image_?2" is the placeholder. Every
 * build since 0.2.0 blocks it (their UNBOUND_RE reads its "@image_?2" start) and it is never renumbered. `video` stays
 * so an old "@video_?1(…)" is read (it is retired text, see retiredVideoTokens); the app writes image ones only.
 */
export const PLACEHOLDER_RE = /@(image|video)_\?(\d+)(?:\(([^()\n]{1,120})\))?/giu
/** "@image_?2(Lumi)" (no label: "@image_?2"). The label must already be sanitized (core/tokenLabels sanitizeLabel). */
export const placeholderToken = (kind: 'image' | 'video', n: number | string, label?: string | null) => `@${kind}_?${n}${label ? `(${label})` : ''}`
/**
 * A real @image token with a label glued to it: "@image_2(Lumi)" (typically a placeholder whose "?" was deleted by
 * hand). Group 2 = number, 3 = label. compileScene blocks it unless the label fits the picture the number names now
 * (core/tokenLabels labelFitsSlot): deleting the "?" must never send Làng where the prompt says Lumi.
 */
export const LABELLED_TOKEN_RE = /@(image)[ _]?(\d+)\(([^()\n]{1,120})\)/giu

// ---------------------------------------------------------------------------------------------
// Retired reference videos (@video_N)
// ---------------------------------------------------------------------------------------------

/**
 * Every spelling of a @video token, exactly as the token parser reads it — TOKEN_RE's "@video_1", "@Video 2",
 * "@VIDEO3" (ASCII word boundary after the number: "@video_1ạ" is a token) — plus UNBOUND_RE's waiting placeholder
 * with an optional label ("@video_?2", "@video_?2(S01·T1)"). "@video2go" / "@video1abc" are plain text everywhere.
 */
const RETIRED_VIDEO_RE = /@video(?:_\?\d+(?:\([^()\n]{1,60}\))?|[ _]?\d+\b)/gi
const HAS_RETIRED_VIDEO_RE = /@video(?:_\?\d|[ _]?\d+\b)/i

export interface RetiredToken {
  /** As written ("@Video 2", "@video_?3(S01·T1)"). */
  text: string
  start: number
  end: number
}

/**
 * The @video tokens of `text`, in order. Reference videos were retired (0.6.0): such text is kept verbatim (never
 * rewritten or deleted by the app) but never sent — the ONE source of every layer that blocks or marks it: compiled
 * `retiredTokens` / `unsentTokens`, core/runRules, the gateway's validateRequest, the red marking in the prompt
 * editor and the open-project notice (src/videoRetired.ts). A superset of what TOKEN_RE / UNBOUND_RE read as video.
 */
export function retiredVideoTokens(text: string): RetiredToken[] {
  if (!/@video/i.test(text)) return []
  const out: RetiredToken[] = []
  for (const m of text.matchAll(RETIRED_VIDEO_RE)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  return out
}

/** Does `text` hold any retired @video token (retiredVideoTokens(text).length > 0, without building the list)? */
export function hasRetiredVideoToken(text: string): boolean {
  return HAS_RETIRED_VIDEO_RE.test(text)
}

export interface PromptPart {
  text: string
  /** 'image' = an @image_N token, 'retired' = retired @video text (retiredVideoTokens). */
  kind: 'text' | 'image' | 'retired'
}

/**
 * `text` cut into plain text, @image_N tokens and retired @video text, for the read-only highlighters (queue, take
 * viewer, dev panel). Concatenating every part gives back `text`; the retired parts are exactly retiredVideoTokens.
 */
export function promptParts(text: string): PromptPart[] {
  const marks: { start: number; end: number; kind: 'image' | 'retired' }[] = retiredVideoTokens(text).map((t) => ({ start: t.start, end: t.end, kind: 'retired' }))
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m[1].toLowerCase() !== 'image') continue
    marks.push({ start: m.index, end: m.index + m[0].length, kind: 'image' })
  }
  marks.sort((a, b) => a.start - b.start)
  const out: PromptPart[] = []
  let last = 0
  for (const m of marks) {
    if (m.start < last) continue
    if (m.start > last) out.push({ text: text.slice(last, m.start), kind: 'text' })
    out.push({ text: text.slice(m.start, m.end), kind: m.kind })
    last = m.end
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'text' })
  return out
}

/** "@video_1, @video_2, @Video 3…": the first 3 tokens, then "…". */
export function retiredTokenList(tokens: readonly string[]): string {
  return `${tokens.slice(0, 3).join(', ')}${tokens.length > 3 ? '…' : ''}`
}

/** The prompt starter older builds wrote into a scene made from a video ("Tạo cảnh tiếp nối"). */
const CONTINUE_STARTER_RE = /^Continue from @video_\d+: /

/** "Continue from @video_1:" when `text` starts exactly with the starter older builds wrote, else null. */
export function continueStarterOf(text: string): string | null {
  const m = CONTINUE_STARTER_RE.exec(text)
  return m ? m[0].trimEnd() : null
}

/**
 * Quick fix "Xoá câu “Continue from @video_1:”" (only when the user clicks it): `text` without the starter older
 * builds wrote, only when it starts EXACTLY with it (one character off: unchanged).
 */
export function stripContinueStarter(text: string): string {
  const m = CONTINUE_STARTER_RE.exec(text)
  return m ? text.slice(m[0].length) : text
}

/**
 * Quick fix "Xoá @video_1" (only when the user clicks it): `text` without text[start, end) — a token found by
 * retiredVideoTokens, label included. When that leaves two spaces side by side (or a space at the very start), one
 * goes; nothing else changes.
 */
export function removeTokenAt(text: string, start: number, end: number): string {
  const before = text.slice(0, start)
  let after = text.slice(end)
  if ((!before || before.endsWith(' ')) && after.startsWith(' ')) after = after.slice(1)
  return before + after
}

/** Every retired @video token of `text` removed (removeTokenAt from the last one back: earlier offsets stay valid). */
export function removeRetiredVideoTokens(text: string): string {
  let out = text
  const found = retiredVideoTokens(text)
  for (let i = found.length - 1; i >= 0; i--) out = removeTokenAt(out, found[i].start, found[i].end)
  return out
}

export function sceneCode(order: number): string {
  return 'S' + String(order).padStart(2, '0')
}

export function takeCode(sceneOrder: number | null | undefined, takeNumber: number): string {
  return `${sceneOrder ? sceneCode(sceneOrder) : 'S??'}·T${takeNumber}`
}

/** Strip Vietnamese diacritics and spaces to build a tag: "Bé An" -> "BeAn". */
export function slugTag(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9_ ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
  return base || 'Asset'
}

export function uniqueTag(name: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((t) => t.toLowerCase()))
  let base = slugTag(name)
  if (RAW_TOKEN.test(base)) base = base + 'X'
  if (!set.has(base.toLowerCase())) return base
  for (let i = 2; i < 999; i++) if (!set.has((base + i).toLowerCase())) return base + i
  return base + Date.now()
}

/** Legacy @Tag mentions in a text, in order of first appearance, without duplicates (case-insensitive). */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    const tag = m[1]
    const key = tag.toLowerCase()
    if (RAW_TOKEN.test(tag) || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

export function assetByTag(assets: Asset[], tag: string): Asset | undefined {
  const key = tag.toLowerCase()
  return assets.find((a) => a.tag.toLowerCase() === key)
}

// ---------------------------------------------------------------------------------------------
// Numbered tokens
// ---------------------------------------------------------------------------------------------

export interface TokenMatch {
  kind: 'image' | 'video'
  n: number
  start: number
  end: number
}

/** All @image_N / @video_N tokens with their positions (for highlighting and validation). */
export function parseTokens(text: string): TokenMatch[] {
  const out: TokenMatch[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    out.push({ kind: m[1].toLowerCase() as 'image' | 'video', n: Number(m[2]), start: m.index!, end: m.index! + m[0].length })
  }
  return out
}

export interface ImageSlot {
  n: number
  assetId: string
  imageId: string
  /** Index of the image inside its asset (0 = primary). */
  imageIndex: number
}

/** Numbered reference images of a list of asset ids (each image of an asset gets its own number). */
export function imageSlotsFor(assets: Asset[], refs: string[]): ImageSlot[] {
  const byId = new Map(assets.map((a) => [a.id, a]))
  const out: ImageSlot[] = []
  for (const id of refs) {
    const a = byId.get(id)
    if (!a) continue
    a.imageIds.forEach((imageId, imageIndex) => out.push({ n: out.length + 1, assetId: a.id, imageId, imageIndex }))
  }
  return out
}

export function imageSlots(project: Project, scene: Scene): ImageSlot[] {
  return imageSlotsFor(project.assets, scene.refs)
}

/** Stable identity of an image slot used by the renumbering (survives reorders). */
export const imageKey = (s: { assetId: string; imageId: string }) => `${s.assetId}:${s.imageId}`

/**
 * Text an @image_N token becomes when its image is removed from a scene: the asset name, else its tag, else "ảnh"
 * (a blank name must never leave an empty gap in the prompt). Without any "@": an asset named like a token ("@image_1")
 * or a mention ("@Lumi", which compileScene turns into Lumi's @image_N) would otherwise make the text point at another
 * picture — the character of that scene would change (Test giới hạn P3).
 */
export function imageFallbackName(asset: Pick<Asset, 'name' | 'tag'> | null | undefined): string {
  const inert = (s: string | undefined) => (typeof s === 'string' ? s.replace(/@/g, '').trim() : '')
  return inert(asset?.name) || inert(asset?.tag) || 'ảnh'
}

/** Fallback text per asset id (see imageFallbackName); unknown ids give "ảnh". */
export function imageFallbackNames(assets: readonly Pick<Asset, 'id' | 'name' | 'tag'>[]): (assetId: string) => string {
  const byId = new Map(assets.map((a) => [a.id, a]))
  return (assetId) => imageFallbackName(byId.get(assetId))
}

/** "@image_N" for the primary image of an asset in this scene, or null when the asset is not linked / has no image. */
export function tokenForAsset(project: Project, scene: Scene, assetId: string): string | null {
  const slot = imageSlots(project, scene).find((s) => s.assetId === assetId)
  return slot ? `@image_${slot.n}` : null
}

/**
 * Text that a word glued after it would extend into a mention / token / placeholder: an "@" followed only by word
 * characters or "?" ("@", "@Lu", "@image", "@image_", "@image_1", "@image_?9"), or a token written with a space,
 * with or without its number yet ("@image ", "@Image 2"). The only characters these patterns allow after an "@" besides
 * word characters are that space (TOKEN_RE) and "?" (UNBOUND_RE).
 */
const OPEN_AT_END = /@[\p{L}\p{N}_?]*$|@(?:image|video) \d*$/iu
/** ...after which a digit would complete a numbered token ("@image " / "@Video_"). */
const TOKEN_PREFIX_END = /@(?:image|video)[ _]?$/i

/**
 * What goes between the text written so far and a fallback that replaces a removed token, so that nothing glued at
 * the join reads as a mention / token / placeholder of another picture ("@" + "Lumi" → mention "@Lumi", "@image " +
 * "3 chị em" → "@image 3", "@image_1" + "3" → "@image_13", "@Lu" + "mi" → "@Lumi"). The fallback holds no "@", and the
 * text after a token starts with a non-word character, so the join with what precedes is the only place one can form.
 */
function fallbackGap(before: string, fallback: string): string {
  let gap = OPEN_AT_END.test(before) ? ' ' : ''
  // "@image" + " " + "3…" would still be "@image 3": one more space (TOKEN_RE takes one separator at most)
  if (TOKEN_PREFIX_END.test(before + gap) && /^[ _]?\d/.test(fallback)) gap += ' '
  return gap
}

/** `after` starts with every key of `before`, in the same order (only new media added at the end). */
const isAppend = (before: string[], after: string[]) => after.length >= before.length && before.every((k, i) => after[i] === k)
/** Asset id of an image key ("assetId:imageId"). */
const ownerOfKey = (key: string) => key.slice(0, key.indexOf(':'))

/** A label glued right after a token / placeholder: "(Lumi)" at the start of the rest of the text. */
const GLUED_LABEL = /^\([^()\n]{1,120}\)/u

export interface RemapOptions {
  /**
   * Tokens whose picture is still in the scene keep their number exactly as written (automatic renumbering off,
   * Settings: the switch promises not to renumber). Only a token whose picture is gone changes (`placeholder`).
   * Typed-ahead numbers are kept too.
   */
  keepNumbers?: boolean
  /**
   * A token whose picture is gone becomes a red placeholder "@image_?N(label)" (N = its number as written, label =
   * `placeholder(key, N)`, null = a bare "@image_?N") instead of `fallback`'s text: no prompt text is ever lost and the
   * scene cannot run until the user fills it (core/placeholders). `glued` = the text of a "(…)" glued right after the
   * token (undefined without one), kept byte for byte either way: with a null label it stays the placeholder's label
   * ("@image_2(Lumi)" → "@image_?2(Lumi)"), with a label it stays after it as plain text ("@image_2(cười)" →
   * "@image_?2(Lumi)(cười)"; core/placeholders removalLabels returns null only when it fits the removed picture).
   */
  placeholder?: (key: string, n: number, glued?: string) => string | null
}

/**
 * Rewrite @image_N tokens after the references changed so every token keeps pointing at the same image. Tokens whose
 * image disappeared become a red placeholder (`opts.placeholder`, what every removal in the app uses) or, without it,
 * `fallback(key, n)` as plain text (the asset name — only the explicit "undo auto link" of the prompt editor keeps
 * that). A token that pointed at nothing before (typed ahead: "write the prompt first, link the pictures later") keeps
 * its number only when the change is a pure append of NEW assets: it then names the newly linked one by position, or
 * still waits for one. Any other change (insert, removal, reorder, a character getting more pictures) would shift it
 * onto a picture it never meant — wrong character — so it becomes a visible "@image_?N" placeholder. Placeholders are
 * not tokens (never renumbered). Retired @video tokens are never touched (kept byte for byte, see retiredVideoTokens).
 */
export function remapTokens(
  text: string,
  before: { images: string[] },
  after: { images: string[] },
  fallback: (key: string, n: number) => string,
  opts: RemapOptions = {},
): { text: string; dropped: number; changed: boolean } {
  let dropped = 0
  let changed = false
  let out = ''
  let last = 0
  // Built piece by piece: a fallback is checked against the text really written before it (an earlier token may
  // have been renumbered or replaced right next to it).
  for (const m of text.matchAll(TOKEN_RE)) {
    const [whole, rawKind, rawN] = m
    out += text.slice(last, m.index)
    last = m.index + whole.length
    // A retired @video token: kept exactly as written (the app never rewrites or deletes it).
    if (rawKind.toLowerCase() !== 'image') {
      out += whole
      continue
    }
    const n = Number(rawN)
    const oldKeys = before.images
    const newKeys = after.images
    const key = oldKeys[n - 1]
    if (key === undefined) {
      const target = newKeys[n - 1]
      if (opts.keepNumbers || (isAppend(oldKeys, newKeys) && (target === undefined || !oldKeys.some((k) => ownerOfKey(k) === ownerOfKey(target))))) {
        out += whole
        continue
      }
      changed = true
      out += unboundToken('image', rawN)
      continue
    }
    const idx = newKeys.indexOf(key)
    let next: string
    if (idx >= 0) next = opts.keepNumbers ? whole : withTokenNumber(whole, idx + 1)
    else if (opts.placeholder) {
      dropped++
      // a "(…)" already glued after the token is never touched (what the user / an earlier removal wrote): the
      // callback decides whether it stays the label (null) or a new label goes in front of it
      const glued = GLUED_LABEL.exec(text.slice(last))?.[0].slice(1, -1)
      next = placeholderToken('image', n, opts.placeholder(key, n, glued))
    } else {
      dropped++
      // never an "@" in it (a name like "@Lumi" / "@image_1" would point at another picture), never glued to an open
      // "@…" before it (fallbackGap)
      const plain = fallback(key, n).replace(/@/g, '')
      next = fallbackGap(out, plain) + plain
    }
    if (next !== whole) changed = true
    out += next
  }
  out += text.slice(last)
  return { text: out, dropped, changed }
}

/**
 * `before` + `plain` + `after` with `plain` (text that replaces a token / placeholder, e.g. "Đổi thành chữ “Lumi”")
 * never reading as a mention / token / placeholder of another picture: "@" removed from it, a space put between it and
 * an open "@…" before it (see fallbackGap).
 */
export function joinPlain(before: string, plain: string, after: string): string {
  const clean = plain.replace(/@/g, '')
  return before + fallbackGap(before, clean) + clean + after
}

/** Keys of a scene's reference images before/after a change — input for remapTokens. */
export function mediaKeys(assets: Asset[], refs: string[]): { images: string[] } {
  return { images: imageSlotsFor(assets, refs).map(imageKey) }
}

// ---------------------------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------------------------

/**
 * Compile the prompt that would be sent for one scene. Pure function.
 * The text is the scene prompt as written; legacy @Tag mentions are converted to @image_N.
 */
export function compileScene(project: Project, scene: Scene): CompiledPrompt {
  const spec = MODELS[scene.settings.model]
  const limit = spec.promptLimit(scene.settings.mode)
  const warnings: string[] = []
  const notes: string[] = []
  const sendsImages = usesRefs(scene.settings)
  const assetMap = new Map(project.assets.map((a) => [a.id, a]))

  // Images
  const allSlots = imageSlots(project, scene)
  const images: CompiledImage[] = sendsImages ? allSlots.slice(0, spec.maxRefImages).map(({ n, assetId, imageId }) => ({ n, assetId, imageId })) : []
  if (sendsImages && allSlots.length > spec.maxRefImages) {
    warnings.push(`${spec.name} nhận tối đa ${spec.maxRefImages} ảnh; ${allSlots.length - spec.maxRefImages} ảnh cuối sẽ không được gửi.`)
  }
  for (const id of scene.refs) {
    const a = assetMap.get(id)
    if (a && !a.imageIds.length) warnings.push(`“${a.name}” chưa có ảnh nên không được gửi.`)
  }
  if (scene.settings.mode === 'i2v' && images.length === 0) warnings.push('Chế độ Ảnh → Video cần ít nhất 1 ảnh tham chiếu.')
  if (!sendsImages && scene.refs.length) notes.push(`Chế độ ${scene.settings.mode.toUpperCase()} của ${spec.name} không gửi ảnh tham chiếu.`)

  if (scene.settings.mode === 'transform' && (!scene.firstFrame || !scene.lastFrame)) {
    warnings.push('Chế độ Khung đầu → cuối cần đủ Khung đầu và Khung cuối.')
  }

  // Legacy @Tag mentions -> @image_N
  const unknown = new Set<string>()
  const notLinked = new Set<string>()
  const text = scene.prompt.trim().replace(MENTION_RE, (whole, tag: string) => {
    if (RAW_TOKEN.test(tag)) return whole
    const asset = assetByTag(project.assets, tag)
    if (!asset) {
      // Not an asset tag: probably just an "@" in the text. Only report things that look like tags.
      if (/^\p{Lu}/u.test(tag)) unknown.add(tag)
      return whole
    }
    const slot = allSlots.find((s) => s.assetId === asset.id)
    if (slot) return `@image_${slot.n}`
    notLinked.add(asset.name)
    return asset.name
  })
  for (const t of unknown) notes.push(`@${t} không phải nhân vật trong thư viện nên được giữ nguyên.`)
  for (const t of notLinked) warnings.push(`“${t}” được nhắc trong prompt nhưng chưa nối vào cảnh.`)

  // Token validation
  const tokens = parseTokens(text)
  const usedImages = new Set<number>()
  if (!sendsImages && tokens.some((t) => t.kind === 'image')) {
    warnings.push(`Chế độ ${scene.settings.mode.toUpperCase()} của ${spec.name} không gửi ảnh: các @image_N sẽ chỉ là chữ trong prompt.`)
  }
  const unsent = new Set<string>()
  // Retired @video tokens (kept as written, never sent): blocked by name, and as tokens with no media (two layers).
  const retired = [...new Set(retiredVideoTokens(text).map((t) => t.text))]
  if (retired.length) {
    warnings.push(`Prompt còn ${retiredTokenList(retired)}: SanoVids đã bỏ video tham chiếu, chữ này sẽ không kèm video nào — xoá hoặc viết lại bằng lời.`)
    for (const tok of retired) unsent.add(tok)
  }
  for (const t of tokens) {
    if (t.kind !== 'image') continue
    const tok = `@image_${t.n}`
    usedImages.add(t.n)
    if (t.n < 1 || t.n > allSlots.length) {
      warnings.push(`${tok} không tồn tại (cảnh có ${allSlots.length} ảnh).`)
      unsent.add(tok)
    } else if (sendsImages && t.n > images.length) {
      warnings.push(`${tok} sẽ không được gửi (${spec.name} nhận tối đa ${spec.maxRefImages} ảnh) — nhân vật đó không có trong video.`)
      unsent.add(tok)
    } else if (!sendsImages) unsent.add(tok)
  }
  // Red placeholders (a removed picture, an import, a typed-ahead number that could not keep its picture): verbatim,
  // label included — they never reach a request (core/runRules blocks the run).
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (m[1].toLowerCase() !== 'image') continue // a waiting @video_?N is a retired token (above)
    const tok = m[0]
    if (unsent.has(tok)) continue
    unsent.add(tok)
    warnings.push(
      m[3]
        ? `${tok}: ảnh “${m[3]}” đã bị bỏ nối khỏi cảnh — nối ảnh thay thế rồi chọn ở dải “Chữ đỏ chờ ảnh” dưới ô prompt, hoặc bấm “Đổi thành chữ” nếu không cần nhân vật đó.`
        : `${tok} chưa gắn ảnh nào — nối vào cảnh rồi sửa thành số đúng (vd. @image_1).`,
    )
  }
  // A real token with a label glued to it ("@image_2(Lumi)", e.g. a placeholder whose "?" was deleted): sent only
  // when the label fits the picture that number names now; otherwise it would send Làng where the prompt says Lumi.
  for (const m of text.matchAll(LABELLED_TOKEN_RE)) {
    const n = Number(m[2])
    const slot = allSlots[n - 1]
    const asset = slot && assetMap.get(slot.assetId)
    if (!slot || !asset) continue // out of range: already blocked above ("không tồn tại")
    const label = m[3]
    if (labelFitsSlot(label, asset, slot.imageIndex, project.assets)) {
      notes.push(`${m[0]}: chữ “(${label})” sẽ được gửi cùng prompt — xoá nếu không cần.`)
      continue
    }
    const now = asset.name || asset.tag
    const base = splitLabel(label).base
    unsent.add(m[0])
    warnings.push(
      `@image_${n} bây giờ là “${now}”, không phải “${label}” — nối ảnh thay thế rồi bấm “Gắn vào chỗ ${base}”; nếu đúng là ${now}, thêm một dấu cách trước “(${label})” (chữ được giữ) hoặc xoá chữ đó.`,
    )
  }
  const unusedImages = images.filter((i) => !usedImages.has(i.n)).map((i) => `@image_${i.n}`)
  if (unusedImages.length) notes.push(`${unusedImages.join(', ')} chưa được nhắc trong prompt (vẫn được gửi).`)

  if (!text) warnings.push('Prompt của cảnh đang trống.')
  const charCount = [...text].length
  if (charCount > limit) warnings.push(`Prompt dài ${charCount.toLocaleString('vi-VN')} ký tự, vượt giới hạn ${limit.toLocaleString('vi-VN')}.`)

  const assetIds = [...new Set(images.map((i) => i.assetId))]
  return { text, images, assetIds, charCount, limit, warnings: [...new Set(warnings)], notes, unsentTokens: [...unsent], retiredTokens: retired }
}
