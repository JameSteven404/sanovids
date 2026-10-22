// Reference videos (@video_N) were retired in 0.6.0 ("bỏ video tham chiếu, giữ lại ảnh tham chiếu"). What is left for
// the old data, all explicit:
//   • the open-project notice — once per project on this device (localStorage `bdp:hint:video-retired:<id>`): how many
//     scenes still hold @video text (kept verbatim, blocked until edited) and how many once used reference videos
//     without naming one (Scene.legacyVideoRefs — they now run with their images only); "Xem" selects them;
//   • the quick fixes — run ONLY when the user clicks one, each ONE undo step (store setPrompts): remove one token
//     (every occurrence of it as written), remove the "Continue from @video_N: " starter older builds wrote, and the
//     multi-scene "Xoá chữ @video ở N cảnh". The app never removes or rewrites @video text by itself.
// Every layer finds the text with the ONE helper core/compile retiredVideoTokens (compile, runRules, the gateway's
// validateRequest, the red marking in the prompt editor): they can never disagree.
import { revealNodes } from './actions'
import { continueStarterOf, hasRetiredVideoToken, removeRetiredVideoTokens, removeTokenAt, retiredVideoTokens, sceneCode, stripContinueStarter } from './core/compile'
import type { Project, Scene } from './core/types'
import { flushScenes } from './lib/promptDrafts'
import { undoToastAction, useProject } from './store/project'
import { toast, useUI } from './store/ui'

/** localStorage key that remembers the notice was shown for a project on this device. */
export const RETIRED_NOTICE_KEY = (projectId: string) => `bdp:hint:video-retired:${projectId}`

/** Archived reference videos of a scene (Scene.legacyVideoRefs, see core/migrate). */
export const legacyVideoRefCount = (s: Pick<Scene, 'legacyVideoRefs'>): number => (Array.isArray(s.legacyVideoRefs) ? s.legacyVideoRefs.length : 0)

export interface RetiredVideoScenes {
  /** A: scenes whose prompt still holds @video text (blocked until edited), in scene order. */
  withText: string[]
  /** B: scenes that once used reference videos but whose prompt names none (they now send images only). */
  linkedOnly: string[]
}

/** The two groups of the notice (pure). */
export function retiredVideoScenes(p: Pick<Project, 'scenes'>): RetiredVideoScenes {
  const withText: string[] = []
  const linkedOnly: string[] = []
  for (const s of [...p.scenes].sort((a, b) => a.order - b.order)) {
    if (hasRetiredVideoToken(s.prompt)) withText.push(s.id)
    else if (legacyVideoRefCount(s) > 0) linkedOnly.push(s.id)
  }
  return { withText, linkedOnly }
}

/** Text of the open-project notice for `a` scenes with @video text and `b` scenes that only had links; null = none. */
export function retiredNoticeText(a: number, b: number): string | null {
  if (a && b) return `Dự án có ${a} cảnh còn chữ @video (chưa chạy được cho tới khi sửa) và ${b} cảnh từng nối video (nay chỉ gửi ảnh). SanoVids đã bỏ video tham chiếu.`
  if (a) return `Dự án có ${a} cảnh còn chữ @video: chữ được giữ nguyên, nhưng các cảnh đó chưa chạy được cho tới khi bạn sửa. SanoVids đã bỏ video tham chiếu.`
  if (b) return `Dự án có ${b} cảnh từng nối video tham chiếu. SanoVids đã bỏ tính năng này: các cảnh đó từ nay chỉ gửi ảnh.`
  return null
}

function seen(projectId: string): boolean {
  try {
    return localStorage.getItem(RETIRED_NOTICE_KEY(projectId)) === '1'
  } catch {
    return false
  }
}

function markSeen(projectId: string) {
  try {
    localStorage.setItem(RETIRED_NOTICE_KEY(projectId), '1')
  } catch {
    /* storage unavailable: the notice may come again next time */
  }
}

/**
 * Show the notice for `p` if it has retired-video data and the notice was not shown for it on this device yet.
 * Returns whether it was shown. Nothing is written for a project without such data.
 */
export function noteRetiredVideos(p: Project): boolean {
  const { withText, linkedOnly } = retiredVideoScenes(p)
  const text = retiredNoticeText(withText.length, linkedOnly.length)
  if (!text || seen(p.id)) return false
  markSeen(p.id)
  const ids = [...withText, ...linkedOnly]
  toast(text, {
    tone: withText.length ? 'warning' : 'info',
    ms: 12000,
    action: {
      label: 'Xem',
      run: () => {
        // Only scenes that still exist in the project that is open now.
        const project = useProject.getState().project
        if (project.id !== p.id) return
        const alive = new Set(project.scenes.map((s) => s.id))
        const shown = ids.filter((id) => alive.has(id))
        if (!shown.length) return
        useUI.getState().select(shown)
        revealNodes(shown)
      },
    },
  })
  return true
}

/**
 * Show the notice whenever another project is opened (the project id changes: start-up, open, import, duplicate…).
 * Called once from main.tsx; returns the unsubscribe function. Undo / redo / edits never change the id.
 */
export function initRetiredVideoNotice(): () => void {
  let lastId = useProject.getState().project.id
  return useProject.subscribe((s) => {
    const id = s.project.id
    if (id === lastId) return
    lastId = id
    // After the opening code has finished (history cleared, runs loaded): the toast then belongs to that project.
    queueMicrotask(() => {
      const p = useProject.getState().project
      if (p.id === id) noteRetiredVideos(p)
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Quick fixes (only on the user's click; one undo step each)
// ---------------------------------------------------------------------------------------------

/** Distinct retired tokens of a prompt as written, in order, with how many times each appears. */
export function retiredTokenCounts(prompt: string): { text: string; count: number }[] {
  const out = new Map<string, number>()
  for (const t of retiredVideoTokens(prompt)) out.set(t.text, (out.get(t.text) ?? 0) + 1)
  return [...out].map(([text, count]) => ({ text, count }))
}

/** `prompt` without every occurrence of the retired token `token` (as written). Unchanged when it holds none. */
export function withoutRetiredToken(prompt: string, token: string): string {
  let out = prompt
  const found = retiredVideoTokens(prompt).filter((t) => t.text === token)
  for (let i = found.length - 1; i >= 0; i--) out = removeTokenAt(out, found[i].start, found[i].end)
  return out
}

/** `prompt` with no retired @video text: the starter older builds wrote first, then every remaining token. */
export function withoutRetiredText(prompt: string): string {
  return removeRetiredVideoTokens(stripContinueStarter(prompt))
}

function sceneOf(sceneId: string): Scene | undefined {
  return useProject.getState().project.scenes.find((s) => s.id === sceneId)
}

/** Apply prompt changes in one undo step and say so (the text typed in an open editor is committed first). */
function applyFix(ids: string[], fix: (prompt: string) => string, message: (changed: Scene[]) => string): number {
  flushScenes(ids)
  const scenes = ids.map(sceneOf).filter((s): s is Scene => !!s)
  const next: Record<string, string> = {}
  const changed: Scene[] = []
  for (const s of scenes) {
    const after = fix(s.prompt)
    if (after === s.prompt) continue
    next[s.id] = after
    changed.push(s)
  }
  if (!changed.length) return 0
  useProject.getState().setPrompts(next)
  toast(message(changed), { tone: 'success', action: undoToastAction() })
  return changed.length
}

/** "Xoá @video_1": remove that token (every occurrence of it as written) from one scene's prompt. */
export function removeRetiredTokenFromScene(sceneId: string, token: string): boolean {
  return applyFix([sceneId], (p) => withoutRetiredToken(p, token), (s) => `Đã xoá ${token} khỏi prompt ${sceneCode(s[0].order)}.`) > 0
}

/** "Xoá câu “Continue from @video_1:”": only when the prompt starts exactly with the starter older builds wrote. */
export function removeContinueStarter(sceneId: string): boolean {
  flushScenes([sceneId])
  const scene = sceneOf(sceneId)
  const starter = scene ? continueStarterOf(scene.prompt) : null
  if (!starter) return false
  return applyFix([sceneId], stripContinueStarter, (s) => `Đã xoá câu “${starter}” khỏi prompt ${sceneCode(s[0].order)}.`) > 0
}

/** "Xoá chữ @video ở N cảnh đang chọn": every retired text of the given scenes, in ONE undo step. */
export function removeRetiredTextFromScenes(sceneIds: string[]): number {
  return applyFix(sceneIds, withoutRetiredText, (s) => `Đã xoá chữ @video ở ${s.length} cảnh.`)
}
