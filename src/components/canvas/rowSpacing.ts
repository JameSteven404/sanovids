// One-time "giãn hàng" for projects laid out before 0.6.0. Scene cards were 280 × 200 in rows 248 apart; the scene node
// is now 352 × 304 (rows 352 apart), and image tiles 220 × 275 instead of 180 × (image height). Opening such a project
// on the canvas spreads its rows ONCE — one undo step, a toast with "Hoàn tác":
// - scene rows are pushed down only as far as needed, every scene below in the same column keeps its distance to the
//   one above it (the user's own gaps stay);
// - sizes below today's minimum (old cards) go back to the default size (they already draw as the default node);
// - takes placed by hand follow their scene's row, and move right by the width the card gained (+72 for the default);
// - the image column on the left is re-spaced for the taller tiles, and default tiles keep their right edge (the wire
//   room to the scene column) instead of growing into it.
// Nothing else moves horizontally. Each project id is remembered per device (localStorage, best effort): the step never
// comes back, not even after its undo. Pure planner (planRowSpacing) + the runner the canvas calls when it opens.
import type { Asset, Project, Scene, Size, XY } from '../../core/types'
import { drawnSceneSize, LAYOUT, undoToastAction, useProject, type Box } from '../../store/project'
import { useRuns } from '../../store/runs'
import { takeLayoutSource } from '../../store/takeRows'
import { toast } from '../../store/ui'
import { MIN_WIRE_ROOM } from './canvasModel'

/** The card and tile sizes of 0.5.x (what saved positions were laid out for). */
export const OLD_LAYOUT = { sceneW: 280, sceneH: 200, assetW: 180 } as const

export interface RowSpacingInput {
  scenes: readonly Pick<Scene, 'id' | 'position' | 'size'>[]
  assets: readonly Pick<Asset, 'id' | 'position' | 'size'>[]
  /** Takes the user placed by hand (runs store: a position set). */
  takes: readonly { id: string; sceneId: string; position: XY }[]
  /** Height of the takes drawn in a scene's row (0 = none). */
  takeRowH?: (sceneId: string) => number
}

export interface RowSpacingPlan {
  scenes: Record<string, XY>
  /** Scene sizes below today's minimum: back to the default (null). */
  sizes: Record<string, null>
  assets: Record<string, XY>
  takes: Record<string, XY>
  changed: boolean
}

const validSize = (size: Size | null | undefined): size is Size => drawnSceneSize(size) !== null
const overlapsX = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w
const touches = (a: Box, b: Box, gy: number) => overlapsX(a, b) && a.y < b.y + b.h + gy && b.y < a.y + a.h + gy

/**
 * Push boxes (sorted top to bottom) down so none touches another: each inherits the shift of the boxes above it in its
 * column (gaps below an overlap stay as they were), then steps below whatever it still touches. Returns the shifts.
 */
function pushDown(items: { id: string; box: Box }[], gap: number): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
  const shift = new Map<string, number>()
  const placed: { id: string; orig: Box; box: Box }[] = []
  for (const it of sorted) {
    let inherited = 0
    for (const p of placed) if (p.orig.y < it.box.y && overlapsX(p.orig, it.box)) inherited = Math.max(inherited, shift.get(p.id) ?? 0)
    let box = { ...it.box, y: it.box.y + inherited }
    for (let g = 0; g < 10000; g++) {
      const hit = placed.find((p) => touches(p.box, box, gap / 2))
      if (!hit) break
      box = { ...box, y: hit.box.y + hit.box.h + gap }
    }
    shift.set(it.id, box.y - it.box.y)
    placed.push({ id: it.id, orig: it.box, box })
  }
  return shift
}

/** What the one-time spacing would change (`changed` false = nothing to do). Pure. */
export function planRowSpacing(input: RowSpacingInput): RowSpacingPlan {
  const plan: RowSpacingPlan = { scenes: {}, sizes: {}, assets: {}, takes: {}, changed: false }
  const takeRowH = input.takeRowH ?? (() => 0)
  const newSize = (s: Pick<Scene, 'size'>): Size => (validSize(s.size) ? s.size : { w: LAYOUT.sceneW, h: LAYOUT.sceneH })
  const oldW = (s: Pick<Scene, 'size'>) => s.size?.w ?? OLD_LAYOUT.sceneW

  // ---- scene rows ----
  for (const s of input.scenes) if (s.size && !validSize(s.size)) plan.sizes[s.id] = null
  const shifts = pushDown(
    input.scenes.map((s) => {
      const size = newSize(s)
      return { id: s.id, box: { x: s.position.x, y: s.position.y, w: size.w, h: Math.max(size.h, takeRowH(s.id)) } }
    }),
    LAYOUT.gapY,
  )
  const byId = new Map(input.scenes.map((s) => [s.id, s]))
  for (const s of input.scenes) {
    const dy = shifts.get(s.id) ?? 0
    if (dy) plan.scenes[s.id] = { x: s.position.x, y: s.position.y + dy }
  }

  // ---- the image column left of the scenes ----
  if (input.scenes.length) {
    const left = Math.min(...input.scenes.map((s) => s.position.x))
    const column = input.assets.filter((a): a is typeof a & { position: XY } => !!a.position && a.position.x + (a.size?.w ?? OLD_LAYOUT.assetW) <= left)
    const dxOf = (a: (typeof column)[number]) => {
      if (a.size) return 0
      const room = left - (a.position.x + LAYOUT.assetW)
      return room < MIN_WIRE_ROOM ? -Math.min(LAYOUT.assetW - OLD_LAYOUT.assetW, MIN_WIRE_ROOM - room) : 0
    }
    const assetShifts = pushDown(
      column.map((a) => ({ id: a.id, box: { x: a.position.x + dxOf(a), y: a.position.y, w: a.size?.w ?? LAYOUT.assetW, h: a.size?.h ?? LAYOUT.assetH } })),
      LAYOUT.assetGapY,
    )
    for (const a of column) {
      const dx = dxOf(a)
      const dy = assetShifts.get(a.id) ?? 0
      if (dx || dy) plan.assets[a.id] = { x: a.position.x + dx, y: a.position.y + dy }
    }
  }

  // ---- takes placed by hand: with their row, right of the card by what it gained ----
  // Only for a project that shows the old layout (rows, sizes or tiles to fix): a take's position alone cannot tell
  // whether it was already moved, and the step must stay idempotent (a second plan of the result changes nothing).
  const old = [plan.scenes, plan.sizes, plan.assets].some((m) => Object.keys(m).length > 0)
  if (old) {
    for (const t of input.takes) {
      const s = byId.get(t.sceneId)
      if (!s) continue
      const dy = shifts.get(s.id) ?? 0
      const right = t.position.x >= s.position.x + oldW(s) - 1
      const dx = right ? newSize(s).w - oldW(s) : 0
      if (dx || dy) plan.takes[t.id] = { x: t.position.x + dx, y: t.position.y + dy }
    }
  }

  plan.changed = old
  return plan
}

// ---------------- runner (the canvas calls it once per opened project) ----------------
export const ROW_SPACING_KEY = 'bdp:canvas:rows-v2'
const MAX_REMEMBERED = 300

function remembered(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ROW_SPACING_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function remember(id: string) {
  try {
    const list = remembered().filter((x) => x !== id)
    list.push(id)
    localStorage.setItem(ROW_SPACING_KEY, JSON.stringify(list.slice(-MAX_REMEMBERED)))
  } catch {
    /* private mode / blocked storage: the planner finds nothing to do the next time anyway */
  }
}

/**
 * Spread the rows of the open project once if it was laid out for the old card size. Returns whether it changed
 * anything. Scenes / assets / sizes: one project undo step. Hand-placed takes (runs store, not undoable) follow the
 * project history: back to their old spots on undo, again on redo.
 */
export function maybeSpaceRows(): boolean {
  const project = useProject.getState().project
  if (remembered().includes(project.id)) return false
  remember(project.id)
  const runs = useRuns.getState()
  const placed = runs.takes.flatMap((t) => (t.position ? [{ id: t.id, sceneId: t.sceneId, position: t.position }] : []))
  const plan = planRowSpacing({ scenes: project.scenes, assets: project.assets, takes: placed, takeRowH: takeLayoutSource.rowHeight })
  if (!plan.changed) return false
  const before = project
  useProject.getState().setNodeSizes(plan.sizes, { ...plan.scenes, ...plan.assets })
  const after = useProject.getState().project
  const takeIds = Object.keys(plan.takes)
  if (takeIds.length) {
    const prev = Object.fromEntries(placed.filter((t) => plan.takes[t.id]).map((t) => [t.id, t.position]))
    runs.setTakePositions(plan.takes)
    followHistory(before, after, prev, plan.takes)
  }
  toast('Node cảnh giờ lớn hơn: các hàng cảnh đã được giãn ra một lần cho khỏi chồng lên nhau.', { action: undoToastAction(), ms: 9000 })
  return true
}

const samePos = (a: XY, b: XY) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5
let stopFollowing: (() => void) | null = null

function followHistory(before: Project, after: Project, prev: Record<string, XY>, next: Record<string, XY>) {
  stopFollowing?.()
  const unsub = useProject.subscribe((s, p) => {
    if (s.project === p.project) return
    if (s.project.id !== before.id) {
      stop()
      return
    }
    const patch: Record<string, XY> = {}
    const [from, to] = s.project === before ? [next, prev] : s.project === after ? [prev, next] : [null, null]
    if (!from || !to) return
    for (const t of useRuns.getState().takes) if (from[t.id] && t.position && samePos(t.position, from[t.id])) patch[t.id] = to[t.id]
    if (Object.keys(patch).length) useRuns.getState().setTakePositions(patch)
  })
  const stop = () => {
    unsub()
    if (stopFollowing === stop) stopFollowing = null
  }
  stopFollowing = stop
}
