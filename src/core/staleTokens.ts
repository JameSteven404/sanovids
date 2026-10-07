// Prompts left as written while their @image_N tokens now point at another picture: what happens with automatic
// renumbering off (Settings) after a refs / asset-image change. Pure (no stores, no React): shared by the sidebar, the
// inspector, canvas wire edits and the action layer, so every such change can warn. (Retired @video text never
// points at anything: it is never counted here.) mediaChangeNote = the one toast tail of every refs / picture change:
// red placeholders left, numbers left stale, or prompts renumbered.
import { HAS_TOKEN_RE, mediaKeys, parseTokens, sceneCode } from './compile'
import { placeholdersAddedSince } from './placeholders'
import type { Project } from './types'

/**
 * Does an @image_N token of `prompt` point at another image after a media change? `before` / `after` are mediaKeys()
 * of the scene. A token that pointed at nothing before (number too high) is not counted.
 */
export function tokensShifted(prompt: string, before: { images: string[] }, after: { images: string[] }): boolean {
  return parseTokens(prompt).some((t) => {
    if (t.kind !== 'image') return false
    const was = before.images[t.n - 1]
    return was !== undefined && after.images[t.n - 1] !== was
  })
}

/**
 * Scenes whose prompt kept @image_N tokens that now point at another picture (automatic renumbering off, Settings),
 * comparing the project before and after a refs / asset-image change. With renumbering on, rewritten prompts are the
 * store's renumbering at work and are not listed; with it off the store only turns removed pictures' tokens red
 * (placeholders are not tokens), so the tokens left are checked as they are.
 */
export function scenesWithStaleTokens(before: Project, after: Project): string[] {
  const old = new Map(before.scenes.map((s) => [s.id, s]))
  const out: string[] = []
  const renumbers = after.settings?.autoRenumber !== false
  for (const sc of after.scenes) {
    const prev = old.get(sc.id)
    if (!prev || (renumbers && prev.prompt !== sc.prompt) || !HAS_TOKEN_RE.test(sc.prompt)) continue
    if (prev.refs === sc.refs && before.assets === after.assets) continue
    if (tokensShifted(sc.prompt, mediaKeys(before.assets, prev.refs), mediaKeys(after.assets, sc.refs))) out.push(sc.id)
  }
  return out
}

/** " · tự đánh lại số đang tắt — hãy sửa số @image trong S02, S05" (scene codes in order, at most 4 listed). */
export function staleTokenNote(project: Project, sceneIds: string[], what = '@image'): string {
  const orders = new Map(project.scenes.map((s) => [s.id, s.order]))
  const codes = sceneIds
    .map((id) => orders.get(id))
    .filter((o): o is number => o !== undefined)
    .sort((a, b) => a - b)
    .map(sceneCode)
  const list = codes.length > 4 ? `${codes.slice(0, 4).join(', ')}… (${codes.length} cảnh)` : codes.join(', ')
  return ` · tự đánh lại số đang tắt — hãy sửa số ${what} trong ${list}`
}

/** staleTokenNote for a change from `before` to `after`, or '' when every prompt still points at the same media. */
export function staleNoteSince(before: Project, after: Project, what = '@image'): string {
  const stale = scenesWithStaleTokens(before, after)
  return stale.length ? staleTokenNote(after, stale, what) : ''
}

/** "S02, S05" (scene codes in order, at most 4, then "… (N cảnh)"). */
function sceneList(project: Project, sceneIds: readonly string[]): string {
  const orders = new Map(project.scenes.map((s) => [s.id, s.order]))
  const codes = sceneIds
    .map((id) => orders.get(id))
    .filter((o): o is number => o !== undefined)
    .sort((a, b) => a - b)
    .map(sceneCode)
  return codes.length > 4 ? `${codes.slice(0, 4).join(', ')}… (${codes.length} cảnh)` : codes.join(', ')
}

export interface MediaChangeNote {
  /** Tail appended to the toast of the change ("Đã bỏ nối Lumi" + text + "."). */
  text: string
  tone: 'info' | 'warning'
  ms?: number
}

/**
 * The toast tail of a refs / picture change (cut wire, unlink, delete from the library, remove a picture, restore…),
 * comparing the project before and after it, or null when no prompt changed meaning:
 *  - red placeholders left (warning, 10 s): " — prompt giữ chữ đỏ @image_?2(Lumi) (chặn Chạy) để bạn gắn ảnh thay thế"
 *    for one scene, " · 3 cảnh giữ chữ đỏ (S02, S05, S07) — chưa chạy được cho tới khi gắn ảnh thay thế" for several;
 *  - numbers left pointing at another picture (renumbering off): staleTokenNote (warning), after the placeholders;
 *  - otherwise prompts renumbered (info): " · đánh lại số @image trong N prompt".
 */
export function mediaChangeNote(before: Project, after: Project): MediaChangeNote | null {
  const added = placeholdersAddedSince(before.scenes, after.scenes)
  const stale = scenesWithStaleTokens(before, after)
  const parts: string[] = []
  if (added.length === 1) {
    const list = added[0].added
    parts.push(` — prompt giữ chữ đỏ ${list[0]}${list.length > 1 ? ` (+${list.length - 1})` : ''} (chặn Chạy) để bạn gắn ảnh thay thế`)
  } else if (added.length > 1) {
    parts.push(` · ${added.length} cảnh giữ chữ đỏ (${sceneList(after, added.map((a) => a.sceneId))}) — chưa chạy được cho tới khi gắn ảnh thay thế`)
  }
  if (stale.length) parts.push(staleTokenNote(after, stale))
  if (parts.length) return { text: parts.join(''), tone: 'warning', ms: added.length ? 10000 : 8000 }
  const old = new Map(before.scenes.map((s) => [s.id, s.prompt]))
  const rewritten = after.scenes.filter((s) => old.has(s.id) && old.get(s.id) !== s.prompt).length
  return rewritten ? { text: ` · đánh lại số @image trong ${rewritten} prompt`, tone: 'info' } : null
}
