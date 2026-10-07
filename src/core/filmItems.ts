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
  /**
   * How sure `duration` is, for a take imported with "Nhập job" (components/runs/importedTake: its `unknown` fields
   * hold placeholders, never facts): 'unknown' = canvasapp did not say — `duration` is the scene's (still timing only)
   * and the film's total leaves the take out; 'inferred' = a guess from the bridge node — counted, shown "≈". Absent =
   * known.
   */
  durationIs?: 'inferred' | 'unknown'
}

/** How sure the length of a take is (see PlayerItem.durationIs). */
function durationIsOf(take: Pick<Take, 'imported'>): PlayerItem['durationIs'] {
  if (take.imported?.unknown.includes('duration')) return 'unknown'
  return take.imported?.inferred.includes('duration') ? 'inferred' : undefined
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
 * null = the player shows the scene's slate) and how long it lasts (the take's duration, else the scene's — also for
 * a take whose length is not known: durationIs).
 */
export function buildFilmItems(scenes: readonly Scene[], takes: readonly Take[]): PlayerItem[] {
  const byScene = takesByScene(takes)
  return byOrder(scenes).map((scene) => {
    const take = pickShowcaseTake(byScene.get(scene.id) ?? []) ?? null
    const durationIs = take ? durationIsOf(take) : undefined
    const duration = take && durationIs !== 'unknown' ? take.settings.duration : scene.settings.duration
    return { sceneId: scene.id, code: sceneCode(scene.order), title: scene.title, take, duration, ...(durationIs ? { durationIs } : {}) }
  })
}

/** How long the takes the film plays last — what "tổng" says (runtimeText). */
export interface FilmRuntime {
  /** Seconds of the takes whose length is known or guessed (scenes without a take — a short slate — do not count). */
  totalS: number
  /** Takes played whose length is not known (imported, canvasapp did not say): left out of totalS. */
  unknown: number
  /** Takes played whose length is a guess (imported, from the bridge node): in totalS, which is then "≈". */
  inferred: number
}

/**
 * The "tổng" of the player (header, end screen). The same figures as the top-bar tooltip's (filmSummary): scenes
 * without a take (shown as a short slate) do not count, nor does a take whose length is not known.
 */
export function filmRuntimeOf(items: readonly PlayerItem[]): FilmRuntime {
  const out: FilmRuntime = { totalS: 0, unknown: 0, inferred: 0 }
  for (const item of items) {
    if (!item.take) continue
    if (item.durationIs === 'unknown') {
      out.unknown++
      continue
    }
    if (item.durationIs === 'inferred') out.inferred++
    out.totalS += item.duration
  }
  return out
}

/** Seconds of filmRuntimeOf (the known and guessed lengths). */
export function filmRuntime(items: readonly PlayerItem[]): number {
  return filmRuntimeOf(items).totalS
}

/**
 * "1:35", "≈1:35" (a length is a guess), "1:20 + 1 cảnh chưa rõ thời lượng", "chưa rõ (2 cảnh chưa rõ thời lượng)":
 * a placeholder length is never added in as a fact.
 */
export function runtimeText(r: FilmRuntime): string {
  const unknown = `${r.unknown} cảnh chưa rõ thời lượng`
  if (r.unknown && !r.totalS) return `chưa rõ (${unknown})`
  return `${r.inferred ? '≈' : ''}${formatRuntime(r.totalS)}${r.unknown ? ` + ${unknown}` : ''}`
}

export interface FilmSummary extends FilmRuntime {
  /** Scenes in the project. */
  scenes: number
  /** Scenes with a finished take to play. */
  withTake: number
  /** Scenes without a ★ take, in scene order. */
  missingStarIds: string[]
  // FilmRuntime (totalS / unknown / inferred) = filmRuntimeOf of buildFilmItems: the player shows the same "tổng".
  /** Seconds the scenes are set to (what the film would last once every scene has its take). */
  plannedS: number
}

export function filmSummary(scenes: readonly Scene[], takes: readonly Take[]): FilmSummary {
  const byScene = takesByScene(takes)
  const out: FilmSummary = { scenes: scenes.length, withTake: 0, missingStarIds: [], totalS: 0, unknown: 0, inferred: 0, plannedS: 0 }
  for (const scene of byOrder(scenes)) {
    const own = byScene.get(scene.id) ?? []
    const take = pickShowcaseTake(own)
    if (take) {
      out.withTake++
      const sure = durationIsOf(take)
      if (sure === 'unknown') out.unknown++
      else {
        if (sure === 'inferred') out.inferred++
        out.totalS += take.settings.duration
      }
    }
    if (!starredTake(own)) out.missingStarIds.push(scene.id)
    out.plannedS += scene.settings.duration
  }
  return out
}
