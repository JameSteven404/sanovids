// Red placeholders "@image_?N(label)" — the commands behind the inspector bar "Chữ đỏ chờ ảnh"
// (components/inspector/PlaceholderBar), the link toast's "Gắn vào chỗ…" and the toasts of every change that removes a
// reference picture. Every command is an explicit click and ONE undo step; a refused one changes nothing. Nothing is
// ever filled automatically (not even when a character with the same name is linked).
import { platformText } from './lib/platformText'
import { sceneCode } from './core/compile'
import {
  allGroupsToText,
  groupOf,
  imagePlaceholders,
  keepTokenOnly,
  labelFitsSlot,
  linkFillOffer,
  membersToText,
  removeMembers,
  splitTokenLabel,
  type FillRefusal,
} from './core/placeholders'
import { mediaChangeNote } from './core/staleTokens'
import type { Project } from './core/types'
import { flushScenes } from './lib/promptDrafts'
import { undoToastAction, useProject } from './store/project'
import { toast } from './store/ui'

/** "S02, S05" (in order, at most 4, then "… (N cảnh)"). */
function codesOf(project: Project, sceneIds: readonly string[]): string {
  const orders = new Map(project.scenes.map((s) => [s.id, s.order]))
  const codes = sceneIds
    .map((id) => orders.get(id))
    .filter((o): o is number => o !== undefined)
    .sort((a, b) => a - b)
    .map(sceneCode)
  return codes.length > 4 ? `${codes.slice(0, 4).join(', ')}… (${codes.length} cảnh)` : codes.join(', ')
}

const assetName = (project: Project, id: string) => {
  const a = project.assets.find((x) => x.id === id)
  return a ? a.name || a.tag : 'nhân vật'
}

/** Why a fill was refused (toast, disabled menu item). `token`: the number already taken ('number-taken'). */
export function fillRefusalText(why: FillRefusal, name: string, token?: string): string {
  switch (why) {
    case 'number-taken': {
      const tok = token ?? 'số mới của nhân vật'
      return `Không gắn được “${name}”: ${tok} đã có trong prompt nhưng chưa trỏ tới ảnh nào — gắn vào sẽ biến nó thành ${name}. Sửa số đó trước, hoặc bật “Tự đánh lại số @image” trong Cài đặt.`
    }
    case 'over-limit':
      return `Không gắn được “${name}”: vượt giới hạn ảnh của model.`
    case 'no-image':
      return `“${name}” chưa có ảnh nào — thêm ảnh cho nhân vật trước.`
    case 'few-images':
      return `“${name}” không có đủ ảnh cho chỗ này.`
    case 'no-asset':
      return 'Nhân vật này không còn trong thư viện.'
    default:
      return 'Chữ đỏ này không còn trong prompt.'
  }
}

/**
 * Toast of a change that may have removed reference pictures (`run` does it): `done` ("Đã bỏ nối Lumi khỏi S03") +
 * the tail of mediaChangeNote (red placeholders left, stale numbers, renumbered prompts), with "Hoàn tác". `always`:
 * announce `done` even when no prompt changed.
 */
export function reportMediaChange(before: Project, done: string, opts: { always?: boolean } = {}): void {
  const after = useProject.getState().project
  const note = mediaChangeNote(before, after)
  if (!note && !opts.always) return
  toast(`${done}${note?.text ?? ''}.`, { action: undoToastAction(), ...(note ? { tone: note.tone, ...(note.ms ? { ms: note.ms } : {}) } : {}) })
}

/** "Gắn ảnh đã nối": fill one group of a scene with a linked character (one undo step). */
export function fillPlaceholderAction(sceneId: string, groupKey: string, assetId: string): boolean {
  flushScenes([sceneId])
  const st = useProject.getState()
  const before = st.project
  const scene = before.scenes.find((s) => s.id === sceneId)
  const group = scene && groupOf(scene.prompt, before.assets, scene.refs, groupKey)
  const name = assetName(before, assetId)
  const res = st.fillPlaceholder(sceneId, groupKey, assetId)
  if (!res.ok) {
    toast(fillRefusalText(res.why, name, res.token), { tone: 'warning', ...(res.why === 'number-taken' ? { ms: 10000 } : {}) })
    return false
  }
  const after = useProject.getState().project
  const left = after.scenes.find((s) => s.id === sceneId)
  const still = left ? groupOf(left.prompt, after.assets, left.refs, groupKey) : undefined
  const who = group?.base ? `chỗ của ${group.base}` : `chỗ ${group?.text ?? 'chữ đỏ'}`
  toast(`Đã gắn ${name} vào ${who} → ${res.token}.${still ? ` Còn chữ đỏ ${still.members.map((m) => m.text).join(', ')}.` : ''}`, {
    tone: 'success',
    action: undoToastAction(),
  })
  return true
}

/** "Gắn vào chỗ Lumi (N cảnh)": the same label filled in several scenes, one undo step. */
export function fillPlaceholdersAction(sceneIds: readonly string[], base: string, assetId: string): void {
  flushScenes([...sceneIds])
  const st = useProject.getState()
  const name = assetName(st.project, assetId)
  const res = st.fillPlaceholders([...sceneIds], base, assetId)
  const after = useProject.getState().project
  if (!res.filled.length) {
    toast(res.refused.length ? fillRefusalText(res.refused[0].why, name, res.refused[0].token) : 'Chữ đỏ này không còn trong prompt.', { tone: 'warning' })
    return
  }
  const refused = res.refused.length
    ? ` · ${res.refused.length} cảnh không gắn được${res.refused.every((r) => r.why === 'over-limit') ? ' (vượt giới hạn ảnh)' : ''}: ${codesOf(after, res.refused.map((r) => r.sceneId))}`
    : ''
  const where = res.filled.length > 1 ? ` ở ${res.filled.length} cảnh` : ` ở ${codesOf(after, res.filled)}`
  toast(`Đã gắn ${name} vào chỗ của ${base}${where}${refused}.`, { tone: refused ? 'warning' : 'success', action: undoToastAction(), ...(refused ? { ms: 9000 } : {}) })
}

/** Apply a text fix to one group of a scene (one undo step via setPrompts) and say what it did. */
function editGroup(sceneId: string, groupKey: string, edit: (prompt: string, members: Parameters<typeof membersToText>[1]) => string, done: string): void {
  flushScenes([sceneId])
  const st = useProject.getState()
  const scene = st.project.scenes.find((s) => s.id === sceneId)
  const group = scene && groupOf(scene.prompt, st.project.assets, scene.refs, groupKey)
  if (!scene || !group) {
    toast('Chữ đỏ này không còn trong prompt.', { tone: 'info' })
    return
  }
  const next = edit(scene.prompt, group.members)
  if (next === scene.prompt) return
  st.setPrompts({ [sceneId]: next })
  toast(done, { action: undoToastAction() })
}

/** "Đổi thành chữ “Lumi”": the character is meant to go — the placeholders become its name as plain text. */
export function placeholderToTextAction(sceneId: string, groupKey: string, base: string): void {
  editGroup(sceneId, groupKey, membersToText, `Đã đổi chữ đỏ thành chữ “${base}”.`)
}

/** "Xoá chữ đỏ": the placeholders removed from the prompt (other text unchanged). */
export function removePlaceholderAction(sceneId: string, groupKey: string): void {
  editGroup(sceneId, groupKey, removeMembers, 'Đã xoá chữ đỏ khỏi prompt.')
}

/** "Giữ @image_1 = Elara, giữ chữ “(cô gái)”": the token keeps its number, the brackets stay as plain text after a space. */
export function splitTokenAction(sceneId: string, groupKey: string, token: string): void {
  editGroup(sceneId, groupKey, splitTokenLabel, `Đã giữ ${token}; chữ trong ngoặc giữ nguyên, tách ra bằng một dấu cách.`)
}

/** "Giữ @image_2 = Làng, xoá chữ “(Lumi)”": a labelled token keeps its number, its label goes. */
export function keepTokenAction(sceneId: string, groupKey: string, token: string): void {
  editGroup(sceneId, groupKey, keepTokenOnly, `Đã giữ ${token}, bỏ chữ trong ngoặc.`)
}

/** "Đổi tất cả thành chữ": every labelled placeholder of the scene becomes plain text (one undo step). */
export function allPlaceholdersToTextAction(sceneId: string): void {
  flushScenes([sceneId])
  const st = useProject.getState()
  const scene = st.project.scenes.find((s) => s.id === sceneId)
  if (!scene) return
  const next = allGroupsToText(scene.prompt, st.project.assets, scene.refs)
  if (next === scene.prompt) return
  st.setPrompts({ [sceneId]: next })
  toast('Đã đổi mọi chữ đỏ có tên thành chữ thường.', { action: undoToastAction() })
}

/**
 * The toast after linking characters (actions.linkAssets), when the linked scenes still hold labelled placeholders:
 * one character, one label everywhere → the button "Gắn vào chỗ Lumi (N cảnh)" (an explicit click, its own undo step;
 * Ctrl+Z still unlinks); otherwise a pointer to the bar under the prompt. Returns false when there is nothing to say
 * (the caller shows its usual toast).
 */
export function linkToastWithFill(before: Project, after: Project, assetIds: readonly string[], text: string): boolean {
  const { offer, pending } = linkFillOffer(before, after, assetIds)
  if (offer) {
    const many = offer.sceneIds.length > 1
    const where = many ? `${offer.sceneIds.length} cảnh` : codesOf(after, offer.sceneIds)
    toast(`${text}. ${where} còn chữ đỏ ${offer.example}. ${platformText.mod}+Z để bỏ nối.`, {
      tone: 'success',
      ms: 12000,
      action: { label: `Gắn vào chỗ ${offer.base}${many ? ` (${offer.sceneIds.length} cảnh)` : ''}`, run: () => fillPlaceholdersAction(offer.sceneIds, offer.base, offer.assetId) },
    })
    return true
  }
  if (pending.length) {
    toast(`${text} · ${codesOf(after, pending)} còn chữ đỏ — chọn ở dải dưới ô prompt.`, { tone: 'success', ms: 8000, action: undoToastAction() })
    return true
  }
  return false
}

/**
 * After ONE picture was added to a character: when scenes linking it still hold its "(Tên · ảnh k)" placeholders for a
 * single k, the toast offers "Gắn ảnh mới vào chỗ ảnh k (N cảnh)" (fillPictureSlot, its own undo step). Returns the
 * toast action, or null.
 */
export function pictureSlotOffer(assetId: string, imageId: string): { label: string; run: () => void } | null {
  const p = useProject.getState().project
  const asset = p.assets.find((a) => a.id === assetId)
  if (!asset) return null
  const ks = new Set<number>()
  let scenes = 0
  for (const s of p.scenes) {
    if (!s.refs.includes(assetId)) continue
    const own = imagePlaceholders(s.prompt).filter((ph) => ph.label && labelFitsSlot(ph.label, asset, ph.imageNo - 1, p.assets))
    if (own.length) scenes++
    for (const ph of own) ks.add(ph.imageNo)
  }
  if (ks.size !== 1 || !scenes) return null
  const k = [...ks][0]
  return {
    label: `Gắn ảnh mới vào chỗ ảnh ${k}${scenes > 1 ? ` (${scenes} cảnh)` : ''}`,
    run: () => {
      const done = useProject.getState().fillPictureSlot(assetId, k, imageId)
      if (done.length) toast(`Đã gắn ảnh mới của “${asset.name || asset.tag}” vào chỗ ảnh ${k} ở ${done.length} cảnh.`, { tone: 'success', action: undoToastAction() })
      else toast('Chữ đỏ này không còn trong prompt.', { tone: 'info' })
    },
  }
}
