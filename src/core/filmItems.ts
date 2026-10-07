// "Phát liền": which take of each scene the film plays, in scene order, and the numbers shown about it (top-bar
// button tooltip, the player's "Chọn N cảnh chưa có ★"). Pure (no store).
import { sceneCode } from './compile'
import type { Scene, Take } from './types'

/** One scene of the film. */
export interface PlayerItem {
  sceneId: string
  code: string
  title: string
  take: Take | null
  /** Seconds (take or scene setting). Stills are shown for duration / 5. */
  duration: number
}

/** Starred completed take (newest starred), else the newest completed take. */
export function pickShowcaseTake(takes: readonly Take[]): Take | undefined {
  let starred: Take | undefined
  let completed: Take | undefined
  for (const t of takes) {
    if (t.status !== 'completed') continue
    if (t.starred && (!starred || t.number > starred.number)) starred = t
    if (!completed || t.number > completed.number) completed = t
  }
  return starred ?? completed
}

/** The newest starred completed take. */
export function starredTake(takes: readonly Take[]): Take | undefined {
  let best: Take | undefined
  for (const t of takes) if (t.starred && t.status === 'completed' && (!best || t.number > best.number)) best = t
  return best
}

/** 95 → "1:35", 30 → "0:30", 3725 → "1:02:05". */
export function formatRuntime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function takesByScene(takes: readonly Take[]): Map<string, Take[]> {
  const map = new Map<string, Take[]>()
  for (const t of takes) {
    const list = map.get(t.sceneId)
    if (list) list.push(t)
    else map.set(t.sceneId, [t])
  }
  return map
}

const byOrder = (scenes: readonly Scene[]) => [...scenes].sort((a, b) => a.order - b.order)

/**
 * The film: one item per scene in scene order (S01, S02…), with the take it plays (★, else the newest finished one;
 * null = the player shows the scene's slate) and how long it lasts (the take's duration, else the scene's).
 */
export function buildFilmItems(scenes: readonly Scene[], takes: readonly Take[]): PlayerItem[] {
  const byScene = takesByScene(takes)
  return byOrder(scenes).map((scene) => {
    const take = pickShowcaseTake(byScene.get(scene.id) ?? []) ?? null
    return { sceneId: scene.id, code: sceneCode(scene.order), title: scene.title, take, duration: take?.settings.duration ?? scene.settings.duration }
  })
}

export interface FilmSummary {
  /** Scenes in the project. */
  scenes: number
  /** Scenes with a finished take to play. */
  withTake: number
  /** Scenes without a ★ take, in scene order. */
  missingStarIds: string[]
  /** Seconds of the takes the film plays. */
  totalS: number
  /** Seconds the scenes are set to (what the film would last once every scene has its take). */
  plannedS: number
}

export function filmSummary(scenes: readonly Scene[], takes: readonly Take[]): FilmSummary {
  const byScene = takesByScene(takes)
  const out: FilmSummary = { scenes: scenes.length, withTake: 0, missingStarIds: [], totalS: 0, plannedS: 0 }
  for (const scene of byOrder(scenes)) {
    const own = byScene.get(scene.id) ?? []
    const take = pickShowcaseTake(own)
    if (take) {
      out.withTake++
      out.totalS += take.settings.duration
    }
    if (!starredTake(own)) out.missingStarIds.push(scene.id)
    out.plannedS += scene.settings.duration
  }
  return out
}
