// "Phát liền" commands: one entry for the top-bar button (and later the canvas toolbar / scene context menu), the
// player's "Chọn N cảnh chưa có ★", and the empty-player guard of FilmPlayerDialog.
import { focusNodes } from './actions'
import { buildFilmItems, filmSummary, type FilmSummary, type PlayerItem } from './core/filmItems'
import { useProject } from './store/project'
import { useRuns } from './store/runs'
import { toast, useUI } from './store/ui'

const NO_SCENES = 'Dự án chưa có cảnh nào để phát liền.'

/**
 * Open the player on item `start` (0-based scene place; the player clamps it). A project without scenes has nothing
 * to play: explain instead of opening an empty player, which would hold every key until Esc.
 */
export function openFilmPlayer(start = 0): boolean {
  if (!useProject.getState().project.scenes.length) {
    toast(NO_SCENES, { tone: 'warning' })
    return false
  }
  useUI.getState().openDialog({ kind: 'player', start })
  return true
}

export interface Film {
  items: PlayerItem[]
  summary: FilmSummary
}

/** The film as it is now (the player keeps this snapshot while it plays); null when the project has no scene. */
export function currentFilm(): Film | null {
  const scenes = useProject.getState().project.scenes
  const takes = useRuns.getState().takes
  const items = buildFilmItems(scenes, takes)
  return items.length ? { items, summary: filmSummary(scenes, takes) } : null
}

/** The player opened with nothing to play (scenes deleted while its chunk loaded…): close it and explain. */
export function closeEmptyPlayer(): void {
  const ui = useUI.getState()
  if (ui.dialog.kind === 'player') ui.closeDialog()
  toast(NO_SCENES, { tone: 'warning' })
}

/** "Chọn N cảnh chưa có ★": close the player and select those scenes on the canvas. */
export function selectMissingStar(ids: readonly string[]): void {
  const ui = useUI.getState()
  ui.closeDialog()
  const live = new Set(useProject.getState().project.scenes.map((s) => s.id))
  const picked = ids.filter((id) => live.has(id))
  if (!picked.length) return
  ui.select(picked)
  focusNodes(picked)
  toast(`Đã chọn ${picked.length} cảnh chưa có take ★.`)
}
