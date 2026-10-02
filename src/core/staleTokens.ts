// Prompts left as written while their @image_N / @video_N tokens now point at another picture or video: what
// happens with automatic renumbering off (Settings) after a refs / asset-image change. Pure (no stores, no React):
// shared by the sidebar, the inspector, canvas wire edits and the action layer, so every such change can warn.
import { HAS_TOKEN_RE, mediaKeys, parseTokens, sceneCode } from './compile'
import type { Project } from './types'

/**
 * Does an @image_N / @video_N token of `prompt` point at another image / video after a media change? `before` /
 * `after` are mediaKeys() of the scene. A token that pointed at nothing before (number too high) is not counted.
 */
export function tokensShifted(prompt: string, before: { images: string[]; videos: string[] }, after: { images: string[]; videos: string[] }): boolean {
  return parseTokens(prompt).some((t) => {
    const was = (t.kind === 'image' ? before.images : before.videos)[t.n - 1]
    return was !== undefined && (t.kind === 'image' ? after.images : after.videos)[t.n - 1] !== was
  })
}

/**
 * Scenes whose prompt was left as written although its @image_N / @video_N tokens now point at another picture or
 * video (automatic renumbering off, Settings), comparing the project before and after a refs / asset-image change.
 * Rewritten prompts are the store's renumbering at work and are not listed.
 */
export function scenesWithStaleTokens(before: Project, after: Project): string[] {
  const old = new Map(before.scenes.map((s) => [s.id, s]))
  const out: string[] = []
  for (const sc of after.scenes) {
    const prev = old.get(sc.id)
    if (!prev || prev.prompt !== sc.prompt || !HAS_TOKEN_RE.test(sc.prompt)) continue
    if (prev.refs === sc.refs && prev.videoRefs === sc.videoRefs && before.assets === after.assets) continue
    if (tokensShifted(sc.prompt, mediaKeys(before.assets, prev.refs, prev.videoRefs), mediaKeys(after.assets, sc.refs, sc.videoRefs))) out.push(sc.id)
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
export function staleNoteSince(before: Project, after: Project, what = '@image/@video'): string {
  const stale = scenesWithStaleTokens(before, after)
  return stale.length ? staleTokenNote(after, stale, what) : ''
}
