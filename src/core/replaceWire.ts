// Dragging the IMAGE end of an image → scene wire onto another character ("RS": store replaceRef, placeholders
// planReplace): the toast of the swap and of a refused drop. Pure (no stores, no React): CanvasView.replaceRefEdge
// shows them. The swap is a deliberate change of WHO a number names, so the stale-number check of other refs changes
// (staleTokens mediaChangeNote compares each token with the picture it named before) would call the swapped slot
// stale: here picture k of the old character counts as picture k of the new one, the mapping planReplace renumbers by.
import { mediaKeys, sceneCode } from './compile'
import { labelledTokens, placeholdersAddedSince, type ReplaceRefusal } from './placeholders'
import { staleTokenNote, tokensShifted } from './staleTokens'
import type { Asset, Project, Scene } from './types'

const ownerOf = (key: string) => key.slice(0, key.indexOf(':'))

/**
 * Picture keys ("assetId:imageId") of a scene BEFORE the swap, with picture k of the old character read as picture k
 * of the new one (old pictures past the new one's count keep their own key: they are the ones turned red).
 */
export function swapTranslatedKeys(assets: readonly Asset[], refs: readonly string[], oldAssetId: string, newAssetId: string): string[] {
  const oldImages = assets.find((a) => a.id === oldAssetId)?.imageIds ?? []
  const newImages = assets.find((a) => a.id === newAssetId)?.imageIds ?? []
  return mediaKeys(assets as Asset[], refs as string[]).images.map((key) => {
    if (ownerOf(key) !== oldAssetId) return key
    const k = oldImages.indexOf(key.slice(oldAssetId.length + 1))
    return k >= 0 && k < newImages.length ? `${newAssetId}:${newImages[k]}` : key
  })
}

/** Labelled tokens of the scene whose label does not fit the picture their number names ("@image_2(Lumi)" on Mira). */
function mismatches(project: Project, scene: Scene): string[] {
  return labelledTokens(scene.prompt, project.assets, scene.refs)
    .filter((t) => !t.fits && t.slotName !== undefined)
    .map((t) => t.text)
}

/** Items of `after` not in `before` (as multisets: a second copy of an older one counts). */
function newItems(before: readonly string[], after: readonly string[]): string[] {
  const had = new Map<string, number>()
  for (const x of before) had.set(x, (had.get(x) ?? 0) + 1)
  return after.filter((x) => {
    const n = had.get(x) ?? 0
    if (n > 0) had.set(x, n - 1)
    return n === 0
  })
}

/** As the other wire toasts name a character (moveRefEdge, cutEdge): its name, else its tag. */
const nameOf = (project: Project, id: string) => {
  const asset = project.assets.find((a) => a.id === id)
  return asset?.name || asset?.tag || 'ảnh'
}

const firstOf = (list: readonly string[]) => `${list[0]}${list.length > 1 ? ` (+${list.length - 1})` : ''}`

export interface ReplaceToast {
  text: string
  tone: 'success' | 'info' | 'warning'
  ms?: number
}

/**
 * Toast of a done swap ("Đã thay Lumi bằng Mira ở S01" + tail + "."), comparing the project before and after it:
 *  - red placeholders left (the new character has fewer pictures): " — prompt giữ chữ đỏ @image_?2(Elara · ảnh 2)
 *    (chặn Chạy) để bạn gắn ảnh thay thế" (warning, 10 s);
 *  - labelled tokens of the old character that no longer fit ("@image_2(Lumi)" now names Mira — the run is blocked):
 *    " — @image_2(Lumi) không còn khớp ảnh (chặn Chạy)" (warning);
 *  - renumbering off: tokens now naming another picture than the swap's mapping gives them (a later character moved
 *    because the new one has more pictures): staleTokenNote (warning);
 *  - otherwise " — prompt giữ nguyên" (success) or " · đánh lại số @image trong prompt" (info).
 */
export function replaceToast(before: Project, after: Project, sceneId: string, oldAssetId: string, newAssetId: string): ReplaceToast {
  const prev = before.scenes.find((s) => s.id === sceneId)
  const next = after.scenes.find((s) => s.id === sceneId)
  const head = `Đã thay ${nameOf(before, oldAssetId)} bằng ${nameOf(before, newAssetId)}${next ? ` ở ${sceneCode(next.order)}` : ''}`
  if (!prev || !next) return { text: `${head}.`, tone: 'success' }
  const parts: string[] = []
  const added = placeholdersAddedSince([prev], [next])[0]?.added ?? []
  if (added.length) parts.push(` — prompt giữ chữ đỏ ${firstOf(added)} (chặn Chạy) để bạn gắn ảnh thay thế`)
  const misfit = newItems(mismatches(before, prev), mismatches(after, next))
  if (misfit.length) parts.push(parts.length ? ` · ${firstOf(misfit)} không còn khớp ảnh` : ` — ${firstOf(misfit)} không còn khớp ảnh (chặn Chạy)`)
  const unchanged = prev.prompt === next.prompt
  if (after.settings?.autoRenumber === false) {
    const translated = swapTranslatedKeys(before.assets, prev.refs, oldAssetId, newAssetId)
    if (tokensShifted(next.prompt, { images: translated }, mediaKeys(after.assets, next.refs))) parts.push(staleTokenNote(after, [sceneId]))
  }
  if (parts.length) return { text: `${head}${parts.join('')}.`, tone: 'warning', ms: added.length ? 10000 : 8000 }
  return unchanged ? { text: `${head} — prompt giữ nguyên.`, tone: 'success' } : { text: `${head} · đánh lại số @image trong prompt.`, tone: 'info' }
}

/**
 * Why a drop of the image end on another character changed nothing (the wire stays), or null when there is nothing
 * worth saying (not a reference of that scene any more, not a character).
 */
export function replaceRefusalToast(
  why: ReplaceRefusal,
  project: Project,
  sceneId: string,
  oldAssetId: string,
  newAssetId: string,
): { text: string; tone: 'info' | 'warning' } | null {
  const scene = project.scenes.find((s) => s.id === sceneId)
  if (!scene) return null
  const code = sceneCode(scene.order)
  const what = `Không thay được ${nameOf(project, oldAssetId)} bằng ${nameOf(project, newAssetId)}`
  switch (why) {
    case 'already-linked':
      return { text: `${what}: ${code} đã có ${nameOf(project, newAssetId)} — giữ nguyên nối cũ.`, tone: 'info' }
    case 'no-image':
      return { text: `${what}: ${nameOf(project, newAssetId)} chưa có ảnh — giữ nguyên nối cũ.`, tone: 'info' }
    case 'over-limit':
      return { text: `${what} ở ${code} (vượt giới hạn ảnh của model) — giữ nguyên nối cũ.`, tone: 'warning' }
    default:
      return null
  }
}
