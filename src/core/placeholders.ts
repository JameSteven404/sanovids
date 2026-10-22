// Red placeholders ("chữ đỏ chờ ảnh"): removing a reference image never deletes prompt text. The token of the removed
// picture becomes "@image_?N(label)" — N = its old number, label = who it was ("Lumi", "Elara · ảnh 2") — which blocks
// the run (core/compile + core/runRules) until the user fills it explicitly: "Gắn ảnh đã nối" (planFill), "Đổi thành
// chữ “Lumi”" (plain text), "Xoá chữ đỏ". Nothing is ever filled automatically, not even by a matching name.
// Pure (no stores, no React): the project store applies the plans in one undo step each; the inspector bar
// (components/inspector/PlaceholderBar), toasts (src/placeholderActions.ts) and the stress tester read the same helpers.
import { imageSlotsFor, joinPlain, LABELLED_TOKEN_RE, mediaKeys, PLACEHOLDER_RE, parseTokens, removeTokenAt, remapTokens } from './compile'
import { characterLabel, foldLabel, labelFitsSlot, splitLabel } from './tokenLabels'
import type { Asset, Project, Scene } from './types'

export { characterLabel, LABEL_MAX, labelFitsSlot, sanitizeLabel, splitLabel } from './tokenLabels'

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export interface Placeholder {
  kind: 'image' | 'video'
  /** The old number ("@image_?2" → 2). */
  n: number
  /** The label as written ("Lumi · ảnh 2"); none for a bare "@image_?2". */
  label?: string
  /** The label without its " · ảnh k" suffix ("Lumi"). */
  base?: string
  /** k of " · ảnh k" (1 without a suffix or a label). */
  imageNo: number
  start: number
  end: number
  text: string
}

/** Every placeholder of `text` in order, image and (retired, read-only) video ones. */
export function parsePlaceholders(text: string): Placeholder[] {
  if (!text.includes('_?')) return []
  const out: Placeholder[] = []
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const label = m[3]
    const split = label ? splitLabel(label) : null
    out.push({
      kind: m[1].toLowerCase() as 'image' | 'video',
      n: Number(m[2]),
      ...(label ? { label, base: split!.base } : {}),
      imageNo: split?.k ?? 1,
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
    })
  }
  return out
}

/** Image placeholders only. */
export const imagePlaceholders = (text: string) => parsePlaceholders(text).filter((p) => p.kind === 'image')

/** Does `text` hold an image placeholder? */
export const hasImagePlaceholder = (text: string) => imagePlaceholders(text).length > 0

/**
 * The placeholder the caret is strictly inside of (start < caret < end), or null: the "@" popup must not open there
 * (inspector/mentions findMention) and the picker of GT2 opens on it.
 */
export function placeholderAt(text: string, caret: number): Placeholder | null {
  for (const p of parsePlaceholders(text)) if (p.start < caret && caret < p.end) return p
  return null
}

/** Tooltip of a red placeholder (prompt backdrop, final prompt, scene card excerpt). */
export function placeholderTitle(ph: Pick<Placeholder, 'n' | 'label' | 'text' | 'kind'>): string {
  if (ph.kind === 'video') return `${ph.text}: video tham chiếu không còn được hỗ trợ — xoá hoặc viết lại bằng lời để chạy cảnh này.`
  if (ph.label) return `Ảnh @image_${ph.n} (${ph.label}) đã bị bỏ nối — nối ảnh thay thế rồi chọn ở dải dưới ô prompt`
  return `${ph.text}: chưa gắn ảnh nào — nối ảnh vào cảnh rồi chọn ở dải “Chữ đỏ chờ ảnh” dưới ô prompt`
}

export interface LabelledToken {
  n: number
  label: string
  base: string
  imageNo: number
  start: number
  end: number
  text: string
  /** The label fits the picture the number names now (labelFitsSlot): sent as written (label text included). */
  fits: boolean
  /** Who that number names now ("Làng"); undefined = no picture with that number (blocked as "không tồn tại"). */
  slotName?: string
}

/** Real tokens with a label glued to them ("@image_2(Lumi)"), checked against the scene's pictures. */
export function labelledTokens(text: string, assets: readonly Asset[], refs: readonly string[]): LabelledToken[] {
  if (!text.includes('(')) return []
  const slots = imageSlotsFor(assets as Asset[], refs as string[])
  const byId = new Map(assets.map((a) => [a.id, a]))
  const out: LabelledToken[] = []
  for (const m of text.matchAll(LABELLED_TOKEN_RE)) {
    const n = Number(m[2])
    const label = m[3]
    const { base, k } = splitLabel(label)
    const slot = slots[n - 1]
    const asset = slot && byId.get(slot.assetId)
    out.push({
      n,
      label,
      base,
      imageNo: k,
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
      fits: !!asset && labelFitsSlot(label, asset, slot.imageIndex, assets),
      ...(asset ? { slotName: asset.name || asset.tag } : {}),
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Making labels (every removal path: store withMedia, restore from a take, replaceRef)
// ---------------------------------------------------------------------------------------------

const ownerOf = (key: string) => key.slice(0, key.indexOf(':'))

/**
 * Label of each removed picture key ("assetId:imageId"), for remapTokens' `placeholder` option. Read from the assets
 * BEFORE the change: picture k (its place among the character's keys in `beforeKeys`) of a character
 *  - removed from the scene / deleted: "Tên" for k = 1, "Tên · ảnh k" for k > 1;
 *  - still linked after the change (one of its pictures was removed): "Tên · ảnh k" for every k, 1 included — it must
 *    not read as "Elara was unlinked" while Elara is still there.
 * Tên = characterLabel (the tag when another character has the same name or the name is blank), sanitized ≤ 40 code
 * points. An unknown character (deleted earlier, a missing id): null = a bare "@image_?N". `glued` = the text of a
 * "(…)" glued right after the token (remapTokens passes it): null when it already fits the removed picture.
 */
export function removalLabels(
  assetsBefore: readonly Asset[],
  ctx: { beforeKeys: readonly string[]; refsAfter: readonly string[]; assetsAfter: readonly Asset[] },
): (key: string, n?: number, glued?: string) => string | null {
  let byId: Map<string, Asset> | null = null
  let alive: Set<string> | null = null
  return (key, _n, glued) => {
    byId ??= new Map(assetsBefore.map((a) => [a.id, a]))
    alive ??= new Set(ctx.assetsAfter.map((a) => a.id))
    const id = ownerOf(key)
    const asset = byId.get(id)
    if (!asset) return null
    let k = 0
    let seen = 0
    for (const other of ctx.beforeKeys) {
      if (ownerOf(other) !== id) continue
      seen++
      if (other === key) {
        k = seen
        break
      }
    }
    if (k < 1) k = asset.imageIds.indexOf(key.slice(id.length + 1)) + 1
    // A "(…)" already glued to the token stays the label only when it describes this very picture ("@image_2(Lumi)"
    // cut from Lumi). Any other text there ("@image_2(cười)", a description) stays as plain text after the new label,
    // so the prompt still says who was removed: "@image_?2(Lumi)(cười)" (remapTokens' `placeholder` contract).
    if (glued !== undefined && labelFitsSlot(glued, asset, Math.max(0, k - 1), assetsBefore)) return null
    const name = characterLabel(asset, assetsBefore)
    if (!name) return null
    if (k < 1) return name
    const stillLinked = ctx.refsAfter.includes(id) && alive.has(id)
    return stillLinked || k > 1 ? `${name} · ảnh ${k}` : name
  }
}

// ---------------------------------------------------------------------------------------------
// Groups (one chip of the bar = one group)
// ---------------------------------------------------------------------------------------------

export interface GroupMember {
  start: number
  end: number
  text: string
  n: number
  imageNo: number
  base?: string
}

export interface PlaceholderGroup {
  /**
   * 'L:' + label base for labelled placeholders (same base = same character: labels are unique per character), 'T:' +
   * text for bare ones (only identical text groups), 'M:' + text for a real token whose label does not fit its slot.
   */
  key: string
  kind: 'label' | 'bare' | 'mismatch'
  base?: string
  /** The first member's text ("@image_?2(Lumi)"). */
  text: string
  /** Smallest old number among the members (chip "@image_?2"). */
  n: number
  members: GroupMember[]
  /** 'mismatch': who the number names now ("Làng"). */
  slotName?: string
}

/** The groups of a prompt, in text order of their first member: what blocks it and what the bar offers to fill. */
export function placeholderGroups(prompt: string, assets: readonly Asset[], refs: readonly string[]): PlaceholderGroup[] {
  const groups = new Map<string, PlaceholderGroup & { first: number }>()
  const add = (key: string, kind: PlaceholderGroup['kind'], m: GroupMember, extra: Partial<PlaceholderGroup> = {}) => {
    const g = groups.get(key)
    if (g) {
      g.members.push(m)
      g.n = Math.min(g.n, m.n)
      return
    }
    groups.set(key, { key, kind, text: m.text, n: m.n, members: [m], first: m.start, ...(m.base !== undefined ? { base: m.base } : {}), ...extra })
  }
  for (const p of imagePlaceholders(prompt)) {
    const m: GroupMember = { start: p.start, end: p.end, text: p.text, n: p.n, imageNo: p.imageNo, ...(p.base !== undefined ? { base: p.base } : {}) }
    if (p.base !== undefined) add('L:' + p.base, 'label', m)
    else add('T:' + p.text, 'bare', m)
  }
  for (const t of labelledTokens(prompt, assets, refs)) {
    if (t.fits || t.slotName === undefined) continue
    add('M:' + t.text, 'mismatch', { start: t.start, end: t.end, text: t.text, n: t.n, imageNo: t.imageNo, base: t.base }, { slotName: t.slotName })
  }
  return [...groups.values()].sort((a, b) => a.first - b.first).map(({ first: _f, ...g }) => g)
}

/** The group of `prompt` with this key (placeholderGroups), or undefined. */
export function groupOf(prompt: string, assets: readonly Asset[], refs: readonly string[], key: string): PlaceholderGroup | undefined {
  return placeholderGroups(prompt, assets, refs).find((g) => g.key === key)
}

/**
 * The group (placeholderGroups) with a member that offset `at` of `prompt` lies strictly inside of, or null: ONE
 * picture dropped right on red text fills that group through the explicit fill path (planFill) — it is never inserted
 * into the middle of the red text.
 */
export function groupAtOffset(prompt: string, assets: readonly Asset[], refs: readonly string[], at: number): PlaceholderGroup | null {
  if (!prompt.includes('_?') && !prompt.includes('(')) return null
  for (const g of placeholderGroups(prompt, assets, refs)) if (g.members.some((m) => m.start < at && at < m.end)) return g
  return null
}

/** Key of the group a placeholder / labelled token text belongs to ("@image_?2(Lumi)" → "L:Lumi"). */
export function groupKeyOf(text: string): string {
  const ph = parsePlaceholders(text)[0]
  if (ph && ph.start === 0 && ph.end === text.length) return ph.base !== undefined ? 'L:' + ph.base : 'T:' + ph.text
  return 'M:' + text
}

// ---------------------------------------------------------------------------------------------
// Explicit text fixes (each one undo step in the store: setPrompts)
// ---------------------------------------------------------------------------------------------

/** Apply `edit` to the members from the last one back (earlier offsets stay valid). */
function editMembers(prompt: string, members: readonly GroupMember[], edit: (text: string, m: GroupMember) => string): string {
  let out = prompt
  for (const m of [...members].sort((a, b) => b.start - a.start)) {
    if (out.slice(m.start, m.end) !== m.text) continue
    out = edit(out, m)
  }
  return out
}

/** "Đổi thành chữ “Lumi”": each member becomes its label base as plain text (bare ones stay). */
export function membersToText(prompt: string, members: readonly GroupMember[]): string {
  return editMembers(prompt, members, (text, m) => (m.base ? joinPlain(text.slice(0, m.start), m.base, text.slice(m.end)) : text))
}

/** "Xoá chữ đỏ": the members removed (a double space left behind goes too). */
export function removeMembers(prompt: string, members: readonly GroupMember[]): string {
  return editMembers(prompt, members, (text, m) => removeTokenAt(text, m.start, m.end))
}

/**
 * "Giữ @image_1 = Elara, giữ chữ “(cô gái)”": a labelled token keeps its number AND its text — one space goes between
 * the token and the "(" so the brackets stop being a label and are sent as plain text ("@image_1 (cô gái)"). Nothing
 * is deleted (prompts of 0.5 often glue a description to a token).
 */
export function splitTokenLabel(prompt: string, members: readonly GroupMember[]): string {
  return editMembers(prompt, members, (text, m) => {
    const cut = m.text.indexOf('(')
    return cut > 0 ? text.slice(0, m.start) + m.text.slice(0, cut) + ' ' + m.text.slice(cut) + text.slice(m.end) : text
  })
}

/** "Giữ @image_2 = Làng, xoá chữ “(Lumi)”": a labelled token keeps its number, its label goes. */
export function keepTokenOnly(prompt: string, members: readonly GroupMember[]): string {
  return editMembers(prompt, members, (text, m) => {
    const cut = m.text.indexOf('(')
    return cut > 0 ? text.slice(0, m.start) + m.text.slice(0, cut) + text.slice(m.end) : text
  })
}

/**
 * "Đổi tất cả thành chữ": every labelled placeholder and every labelled token whose label does not fit becomes its
 * label as plain text (bare "@image_?N" have no text to become: they stay).
 */
export function allGroupsToText(prompt: string, assets: readonly Asset[], refs: readonly string[]): string {
  const members = placeholderGroups(prompt, assets, refs)
    .filter((g) => g.kind !== 'bare')
    .flatMap((g) => g.members)
  return membersToText(prompt, members)
}

/** `text` with labelled placeholders turned into their label base (`only`: those placeholders only). */
export function placeholdersToText(text: string, only?: (ph: Placeholder) => boolean): string {
  const members = imagePlaceholders(text).filter((p) => p.base !== undefined && (!only || only(p)))
  return membersToText(text, members)
}

// ---------------------------------------------------------------------------------------------
// Filling (always an explicit click)
// ---------------------------------------------------------------------------------------------

/** Pictures a scene would send if `refs` were its refs (an asset without picture still takes one place). */
function imageCount(assets: readonly Asset[], refs: readonly string[]): number {
  const byId = new Map(assets.map((a) => [a.id, a]))
  return refs.reduce((t, id) => t + Math.max(1, byId.get(id)?.imageIds.length ?? 0), 0)
}

export type FillRefusal = 'gone' | 'no-asset' | 'no-image' | 'few-images' | 'over-limit' | 'number-taken'

export interface FillOk {
  ok: true
  prompt: string
  refs: string[]
  /** The first token written ("@image_2"). */
  token: string
  filled: number
  /** Members of the group left (the new character has fewer pictures). */
  left: number
}
/** A refused fill. `token` ('number-taken'): the real token already written with a number the character would take. */
export type FillRefused = { ok: false; why: FillRefusal; token?: string }
export type FillPlan = FillOk | FillRefused

export interface FillOptions {
  /** project.settings.autoRenumber: with it off the character is appended and only the placeholders' text changes. */
  renumber: boolean
  /** The model's image limit of the scene (MODELS[…].maxRefImages). */
  maxImages: number
  /**
   * Where the character goes in the refs. 'auto' (default): at the removed character's place (so the numbers read as
   * before the cut) unless a real token already names one of its pictures (then it stays where it is); 'slot': at that
   * place too when linked but not named yet; 'end': appended / left where it is.
   */
  place?: 'auto' | 'slot' | 'end'
}

const SENTINEL = (i: number) => `${i}`
const SENTINEL_RE = /(\d+)/g

/**
 * Fill the group `groupKey` of a scene's prompt with `assetId`: picture k of the character replaces each member
 * "… · ảnh k" (k = 1 without a suffix); members past its picture count stay red. The character is linked when it is
 * not, at the place of the removed one (the asset holding number n0 − 1, n0 = the first picture of the removed
 * character), and the other tokens renumber so each keeps its picture. Refused — the scene stays exactly as it is —
 * when the group is gone, the character has no picture (or too few for any member), or linking it would pass the
 * model's image limit.
 */
export function planFill(scene: Pick<Scene, 'prompt' | 'refs'>, assets: readonly Asset[], groupKey: string, assetId: string, opts: FillOptions): FillPlan {
  const group = groupOf(scene.prompt, assets, scene.refs, groupKey)
  if (!group) return { ok: false, why: 'gone' }
  const asset = assets.find((a) => a.id === assetId)
  if (!asset) return { ok: false, why: 'no-asset' }
  if (!asset.imageIds.length) return { ok: false, why: 'no-image' }
  if (!group.members.some((m) => m.imageNo <= asset.imageIds.length)) return { ok: false, why: 'few-images' }
  const linked = scene.refs.includes(assetId)
  if (!linked && imageCount(assets, [...scene.refs, assetId]) > opts.maxImages) return { ok: false, why: 'over-limit' }

  const inGroup = (start: number) => group.members.some((m) => m.start === start)
  const slotsNow = imageSlotsFor(assets as Asset[], scene.refs)
  const named = linked && parseTokens(scene.prompt).some((t) => t.kind === 'image' && !inGroup(t.start) && slotsNow[t.n - 1]?.assetId === assetId)
  const place = opts.place ?? 'auto'
  const bySlot = opts.renumber && place !== 'end' && (!linked || !named)

  let refs = scene.refs
  if (bySlot) {
    const n0 = Math.max(1, Math.min(...group.members.map((m) => m.n - (m.imageNo - 1))))
    const without = scene.refs.filter((r) => r !== assetId)
    const slots = imageSlotsFor(assets as Asset[], without)
    const holder = n0 > 1 ? slots[n0 - 2] : undefined
    const at = n0 <= 1 ? 0 : holder ? without.indexOf(holder.assetId) + 1 : without.length
    refs = [...without.slice(0, at), assetId, ...without.slice(at)]
  } else if (!linked) refs = [...scene.refs, assetId]
  if (refs.length === scene.refs.length && refs.every((r, i) => r === scene.refs[i])) refs = scene.refs

  // Renumbering off: nothing moves, the character is appended and takes the numbers after the last picture. A real
  // token outside the group already written with one of those numbers pointed at nothing (typically left over by the
  // cut: "@image_3" while two pictures are left) — it would silently start sending the new character. Refused until
  // that number is fixed (the stale-token warnings name it); with renumbering on such a token became "@image_?N".
  if (!opts.renumber && !linked) {
    const fresh = new Set(imageSlotsFor(assets as Asset[], refs).filter((s) => s.assetId === assetId).map((s) => s.n))
    const taken = parseTokens(scene.prompt).find((t) => t.kind === 'image' && !inGroup(t.start) && fresh.has(t.n))
    if (taken) return { ok: false, why: 'number-taken', token: `@image_${taken.n}` }
  }

  // Members out of the way while the other tokens renumber (a labelled token is a real token to remapTokens).
  const members = [...group.members].sort((a, b) => a.start - b.start)
  let marked = scene.prompt
  for (let i = members.length - 1; i >= 0; i--) marked = marked.slice(0, members[i].start) + SENTINEL(i) + marked.slice(members[i].end)
  if (refs !== scene.refs) {
    marked = remapTokens(marked, mediaKeys(assets as Asset[], scene.refs), mediaKeys(assets as Asset[], refs), () => '', {
      keepNumbers: !opts.renumber,
      placeholder: () => null,
    }).text
  }
  const own = imageSlotsFor(assets as Asset[], refs).filter((s) => s.assetId === assetId)
  let filled = 0
  let token = ''
  const prompt = marked.replace(SENTINEL_RE, (_s, i: string) => {
    const m = members[Number(i)]
    const slot = own[m.imageNo - 1]
    if (!slot) return m.text
    filled++
    const t = `@image_${slot.n}`
    token ||= t
    return t
  })
  return { ok: true, prompt, refs, token, filled, left: members.length - filled }
}

export type ReplaceRefusal = 'not-linked' | 'already-linked' | 'no-asset' | 'no-image' | 'over-limit'
export type ReplacePlan = { ok: true; prompt: string; refs: string[] } | { ok: false; why: ReplaceRefusal }

/**
 * Swap a linked character for another at the same place in the refs (dragging the image end of a wire onto another
 * character, "RS"): picture k of the old one becomes picture k of the new one, so with the same picture count the
 * prompt stays byte for byte. Old pictures without a counterpart become "@image_?N(Tên · ảnh k)"; extra new pictures
 * are simply sent (not named). Refused (nothing changes) when the old one is not linked, the new one already is, has no
 * picture, or would pass the image limit.
 */
export function planReplace(
  scene: Pick<Scene, 'prompt' | 'refs'>,
  assets: readonly Asset[],
  oldAssetId: string,
  newAssetId: string,
  opts: { renumber: boolean; maxImages: number },
): ReplacePlan {
  if (!scene.refs.includes(oldAssetId)) return { ok: false, why: 'not-linked' }
  if (scene.refs.includes(newAssetId)) return { ok: false, why: 'already-linked' }
  const next = assets.find((a) => a.id === newAssetId)
  if (!next) return { ok: false, why: 'no-asset' }
  if (!next.imageIds.length) return { ok: false, why: 'no-image' }
  const refs = scene.refs.map((r) => (r === oldAssetId ? newAssetId : r))
  if (imageCount(assets, refs) > opts.maxImages && imageCount(assets, refs) > imageCount(assets, scene.refs)) return { ok: false, why: 'over-limit' }
  const before = mediaKeys(assets as Asset[], scene.refs).images
  const oldImages = assets.find((a) => a.id === oldAssetId)?.imageIds ?? []
  // picture k of the old character counts as picture k of the new one
  const translated = before.map((key) => {
    if (ownerOf(key) !== oldAssetId) return key
    const k = oldImages.indexOf(key.slice(oldAssetId.length + 1))
    return k >= 0 && k < next.imageIds.length ? `${newAssetId}:${next.imageIds[k]}` : key
  })
  const after = mediaKeys(assets as Asset[], refs)
  const labels = removalLabels(assets, { beforeKeys: before, refsAfter: refs, assetsAfter: assets })
  const prompt = remapTokens(scene.prompt, { images: translated }, after, () => '', { keepNumbers: !opts.renumber, placeholder: labels }).text
  return { ok: true, prompt, refs }
}

/**
 * Pictures the bar offers for a fill, newest link first: linked characters (with pictures) no real token names yet,
 * then the other linked ones.
 */
export function fillChoices(prompt: string, assets: readonly Asset[], refs: readonly string[]): { asset: Asset; named: boolean }[] {
  const byId = new Map(assets.map((a) => [a.id, a]))
  const slots = imageSlotsFor(assets as Asset[], refs as string[])
  const named = new Set<string>()
  for (const t of parseTokens(prompt)) if (t.kind === 'image' && slots[t.n - 1]) named.add(slots[t.n - 1].assetId)
  const linked = [...refs].reverse().flatMap((id) => {
    const a = byId.get(id)
    return a && a.imageIds.length ? [{ asset: a, named: named.has(id) }] : []
  })
  return [...linked.filter((x) => !x.named), ...linked.filter((x) => x.named)]
}

// ---------------------------------------------------------------------------------------------
// Changes between two projects (toasts, stress tester)
// ---------------------------------------------------------------------------------------------

/**
 * Image placeholders that appeared in each scene between `before` and `after` (counted as a multiset per scene: a
 * second "@image_?2(Lumi)" next to an older one counts). Scenes that did not exist before are skipped.
 */
export function placeholdersAddedSince(before: readonly Pick<Scene, 'id' | 'prompt'>[], after: readonly Pick<Scene, 'id' | 'prompt'>[]): { sceneId: string; added: string[] }[] {
  const old = new Map(before.map((s) => [s.id, s.prompt]))
  const out: { sceneId: string; added: string[] }[] = []
  for (const s of after) {
    const prev = old.get(s.id)
    if (prev === undefined || prev === s.prompt || !s.prompt.includes('_?')) continue
    const had = new Map<string, number>()
    for (const p of imagePlaceholders(prev)) had.set(p.text, (had.get(p.text) ?? 0) + 1)
    const added: string[] = []
    for (const p of imagePlaceholders(s.prompt)) {
      const n = had.get(p.text) ?? 0
      if (n > 0) had.set(p.text, n - 1)
      else added.push(p.text)
    }
    if (added.length) out.push({ sceneId: s.id, added })
  }
  return out
}

export interface LinkFillOffer {
  assetId: string
  /** Label base of the group to fill ("Lumi"). */
  base: string
  /** "@image_?2(Lumi)" of the first scene (toast text). */
  example: string
  /** Scenes where that group waits, in scene order. */
  sceneIds: string[]
}

/**
 * After linking characters (actions.linkAssets): may the toast offer "Gắn vào chỗ Lumi"? Only for ONE newly linked
 * character with pictures, in the scenes where it was newly linked and that still hold labelled placeholders (bare
 * "@image_?N" typed ahead never count): each such scene must have exactly one labelled group, or exactly one whose base
 * is the new character's name / tag, and all those scenes the same base. `pending` = scenes newly linked that still hold
 * labelled placeholders the offer does not cover (the toast points them at the bar). Never applied by itself.
 */
export function linkFillOffer(before: Project, after: Project, assetIds: readonly string[]): { offer: LinkFillOffer | null; pending: string[] } {
  const ids = [...new Set(assetIds)]
  const old = new Map(before.scenes.map((s) => [s.id, s]))
  const newly = [...after.scenes]
    .sort((a, b) => a.order - b.order)
    .filter((s) => {
      const prev = old.get(s.id)
      return !!prev && ids.some((id) => s.refs.includes(id) && !prev.refs.includes(id))
    })
  const waiting = newly.filter((s) => imagePlaceholders(s.prompt).some((p) => p.base !== undefined))
  if (!waiting.length) return { offer: null, pending: [] }
  const asset = ids.length === 1 ? after.assets.find((a) => a.id === ids[0]) : undefined
  if (!asset || !asset.imageIds.length) return { offer: null, pending: waiting.map((s) => s.id) }
  const names = new Set([asset.name, asset.tag].map((n) => foldLabel(n)).filter(Boolean))
  let base: string | null = null
  let example = ''
  const covered: string[] = []
  const pending: string[] = []
  for (const s of waiting) {
    const groups = placeholderGroups(s.prompt, after.assets, s.refs).filter((g) => g.kind === 'label')
    const byName = groups.filter((g) => names.has(foldLabel(g.base ?? '')))
    const pick = groups.length === 1 ? groups[0] : byName.length === 1 ? byName[0] : undefined
    if (!pick?.base || (base !== null && pick.base !== base)) {
      pending.push(s.id)
      continue
    }
    base = pick.base
    example ||= pick.text
    covered.push(s.id)
  }
  if (base === null || pending.length) return { offer: null, pending: waiting.map((s) => s.id) }
  return { offer: { assetId: asset.id, base, example, sceneIds: covered }, pending: [] }
}

// ---------------------------------------------------------------------------------------------
// Deleting characters from the library (confirmation BEFORE the change)
// ---------------------------------------------------------------------------------------------

export interface AssetDeleteImpact {
  /** Scenes whose prompt would get red placeholders (blocked until filled), in scene order. */
  sceneIds: string[]
  /** How many tokens would turn red in all. */
  placeholders: number
  /** Scenes using one of the characters as first / last frame (they lose it). */
  frameSceneIds: string[]
  /** Scenes linking one of the characters at all. */
  linkedSceneIds: string[]
}

/**
 * What deleting `assetIds` from the library would do, read before the change (the library delete of L1, the asset
 * dialog): the scenes whose @image tokens name one of their pictures get red placeholders and stop running — that
 * needs a confirmation; characters no prompt names delete in one click (`needsConfirm` false).
 */
export function assetDeleteImpact(project: Pick<Project, 'assets' | 'scenes'>, assetIds: readonly string[]): AssetDeleteImpact & { needsConfirm: boolean } {
  const dead = new Set(assetIds)
  const sceneIds: string[] = []
  const frameSceneIds: string[] = []
  const linkedSceneIds: string[] = []
  let placeholders = 0
  for (const s of [...project.scenes].sort((a, b) => a.order - b.order)) {
    if ((s.firstFrame && dead.has(s.firstFrame)) || (s.lastFrame && dead.has(s.lastFrame))) frameSceneIds.push(s.id)
    if (!s.refs.some((r) => dead.has(r))) continue
    linkedSceneIds.push(s.id)
    const slots = imageSlotsFor(project.assets, s.refs)
    const n = parseTokens(s.prompt).filter((t) => t.kind === 'image' && slots[t.n - 1] && dead.has(slots[t.n - 1].assetId)).length
    if (n) {
      sceneIds.push(s.id)
      placeholders += n
    }
  }
  return { sceneIds, placeholders, frameSceneIds, linkedSceneIds, needsConfirm: sceneIds.length > 0 || frameSceneIds.length > 0 }
}

/**
 * The question before deleting characters that are in use (assetDeleteImpact), or null when none is needed. `name` =
 * the character's name (one) or null (several). `undoKey`: how Undo is written on this platform (Mac: "⌘Z").
 */
export function assetDeleteQuestion(name: string | null, count: number, impact: AssetDeleteImpact, undoKey = 'Ctrl+Z'): string | null {
  const parts: string[] = []
  const who = count > 1 || !name ? `${count} mục` : `“${name}”`
  if (impact.sceneIds.length) {
    parts.push(
      `${impact.sceneIds.length} cảnh đang dùng ${count > 1 ? 'các mục này' : 'nhân vật này'} sẽ giữ chữ đỏ và chưa chạy được cho tới khi bạn gắn nhân vật khác`,
    )
  }
  if (impact.frameSceneIds.length) parts.push(`${impact.frameSceneIds.length} cảnh mất khung đầu / khung cuối`)
  if (!parts.length) return null
  return `Xoá ${who} khỏi thư viện? ${parts.join('; ')} (${undoKey} để hoàn tác).`
}
