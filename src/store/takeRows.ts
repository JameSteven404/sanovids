// Where the take (video) nodes are, for the layout of NEW nodes in the project store (project.setTakeLayoutSource).
// Same rules as the canvas (components/canvas: layoutTakes + takeSlots): a scene's row holds its takes that are
// shown under the "Video" display (all, or only the chosen one + takes used as @video) and auto-placed — plus the
// ones only nudged on their slot (core/takes keepsSlot). Takes dragged away are separate boxes; hidden ones are nothing.
import { chooseTake, keepsSlot, videoUsageOf } from '../core/takes'
import type { Scene, Take } from '../core/types'
import { LAYOUT, useProject, type Box, type TakeLayoutSource } from './project'
import { useRuns } from './runs'
import { useUI, type TakeDisplay } from './ui'

export interface TakeRows {
  /** Per scene: tallest take in its row and the row's width from the card's right edge (offset + takes + gaps). */
  rows: Map<string, { h: number; w: number }>
  /** Shown takes placed by hand (dragged away, or only nudged on their slot). */
  placed: Box[]
  /** Ids of the shown takes dragged out of their row (not only nudged: core/takes keepsSlot false). */
  offRow: Set<string>
}

const sizeOf = (t: Take) => ({ w: t.size?.w ?? LAYOUT.takeW, h: t.size?.h ?? LAYOUT.takeH })

/** Pure: the take rows of `scenes` (unit-tested). */
export function computeTakeRows(takes: readonly Take[], scenes: Scene[], mode: TakeDisplay): TakeRows {
  const byScene = new Map<string, Take[]>()
  for (const t of takes) {
    const list = byScene.get(t.sceneId)
    if (list) list.push(t)
    else byScene.set(t.sceneId, [t])
  }
  const used = videoUsageOf(scenes)
  const rows = new Map<string, { h: number; w: number }>()
  const placed: Box[] = []
  const offRow = new Set<string>()
  const alive = new Set<string>()
  for (const s of scenes) {
    alive.add(s.id)
    const list = byScene.get(s.id)
    if (!list) continue
    list.sort((a, b) => a.number - b.number)
    const chosen = mode === 'chosen' ? chooseTake(list) : undefined
    const shown = mode === 'chosen' ? list.filter((t) => t === chosen || used.has(t.id)) : list
    const cardW = s.size?.w ?? LAYOUT.sceneW
    let acc = 0
    let h = 0
    for (const t of shown) {
      const size = sizeOf(t)
      const slot = { x: s.position.x + cardW + LAYOUT.takeOffsetX + acc, y: s.position.y }
      if (t.position) placed.push({ x: t.position.x, y: t.position.y, ...size })
      if (t.position && !keepsSlot(t.position, slot, size.w, size.h)) {
        offRow.add(t.id)
        continue
      }
      acc += size.w + LAYOUT.takeGapX
      h = Math.max(h, size.h)
    }
    if (acc > 0) rows.set(s.id, { h, w: LAYOUT.takeOffsetX + acc - LAYOUT.takeGapX })
  }
  // Takes of deleted scenes stay on the canvas while a scene uses them as @video: in the way when placed by hand.
  for (const t of takes) if (!alive.has(t.sceneId) && used.has(t.id) && t.position) placed.push({ x: t.position.x, y: t.position.y, ...sizeOf(t) })
  return { rows, placed, offRow }
}

let cache: { takes: Take[]; scenes: Scene[]; mode: TakeDisplay; rows: TakeRows } | null = null
/** computeTakeRows of the current stores (cached until takes, scenes or the display change). */
export function currentTakeRows(): TakeRows {
  const takes = useRuns.getState().takes
  const scenes = useProject.getState().project.scenes
  const mode = useUI.getState().takeDisplay
  if (cache && cache.takes === takes && cache.scenes === scenes && cache.mode === mode) return cache.rows
  const rows = computeTakeRows(takes, scenes, mode)
  cache = { takes, scenes, mode, rows }
  return rows
}

/** For project.setTakeLayoutSource. */
export const takeLayoutSource: TakeLayoutSource = {
  rowHeight: (sceneId) => currentTakeRows().rows.get(sceneId)?.h ?? 0,
  rowWidth: (sceneId) => currentTakeRows().rows.get(sceneId)?.w ?? 0,
  placed: () => currentTakeRows().placed,
}
