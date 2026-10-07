import { create } from 'zustand'
import { fitNodes, placementHint } from './actions'
import { arrange, LEGACY_ROWS, overlaps, samePosition, type ArrangeInput, type ArrangeOptions, type Box } from './core/arrange'
import { FOLDER_H, FOLDER_W } from './core/folders'
import type { Project, XY } from './core/types'
import { assetNodeHeight, measuredOf, takeIndexOf } from './components/canvas/canvasModel'
import { resolveArrange, useArrangePrefs } from './lib/arrangePrefs'
import { drawnSceneSize, LAYOUT, onHistoryJump, undoToastAction, useProject } from './store/project'
import { computeTakeRows } from './store/takeRows'
import { useRuns } from './store/runs'
import { toast, useUI, type TakeDisplay } from './store/ui'

export const useArrangeMenu = create<{ open: boolean; toggle: () => void; close: () => void }>((set) => ({
  open: false, toggle: () => set((s) => ({ open: !s.open })), close: () => set({ open: false }),
}))

/** Read-only snapshot shared by the preview and the command. No canvas or project mutations. */
export function buildArrangeInput(opts: ArrangeOptions): ArrangeInput {
  const p = useProject.getState().project, takes = useRuns.getState().takes
  const selected = new Set(useUI.getState().selectedIds), idx = takeIndexOf(takes)
  const allRows = computeTakeRows(takes, p.scenes, 'all')
  const shownRows = computeTakeRows(takes, p.scenes, opts.video)
  const size = (id: string, w: number, h: number) => ({ w: Math.max(w, measuredOf(id)?.width ?? 0), h: Math.max(h, measuredOf(id)?.height ?? 0) })
  const firstUse = new Map<string, number>()
  for (const s of p.scenes) for (const id of [...s.refs, s.firstFrame, s.lastFrame]) if (id) firstUse.set(id, Math.min(firstUse.get(id) ?? Infinity, s.order))
  const takeInputs: ArrangeInput['takes'] = []
  const clusters = p.scenes.map((s) => {
    const card = size(s.id, drawnSceneSize(s.size)?.w ?? LAYOUT.sceneW, drawnSceneSize(s.size)?.h ?? LAYOUT.sceneH)
    let width = 0, height = 0
    for (const t of idx.byScene.get(s.id) ?? []) {
      const shown = opts.video === 'all' || idx.chosen.get(s.id) === t
      const offRow = (shown ? shownRows : allRows).offRow.has(t.id)
      const box = size(t.id, t.size?.w ?? LAYOUT.takeW, t.size?.h ?? LAYOUT.takeH)
      takeInputs.push({ id: t.id, sceneId: s.id, pos: t.position, offRow, shown, ...box, slot: width })
      if (shown && !(opts.placedTakes === 'follow' && offRow)) { width += box.w + LAYOUT.takeGapX; height = Math.max(height, box.h) }
    }
    return { id: s.id, order: s.order, pos: s.position, cardW: card.w, cardH: card.h, rowW: width ? LAYOUT.takeOffsetX + width - LAYOUT.takeGapX : 0, rowH: height, inScope: selected.has(s.id) }
  })
  const assets = p.assets.flatMap((a, libIndex) => a.position ? [{
    id: a.id, kind: a.kind, pos: a.position, ...size(a.id, a.size?.w ?? LAYOUT.assetW, Math.max(LAYOUT.assetH, assetNodeHeight(a))),
    libIndex, firstUse: firstUse.get(a.id) ?? Infinity, inScope: selected.has(a.id),
  }] : [])
  const order = new Map(p.scenes.map((s) => [s.id, s.order]))
  const folders = (p.folders ?? []).map((f) => {
    const linked = [...(f.autoScenes ?? []), ...(f.takes ?? []).map((id) => idx.byId.get(id)?.sceneId ?? '')]
    const first = Math.min(...linked.map((id) => order.get(id) ?? Infinity))
    return { id: f.id, pos: f.position, ...size(f.id, f.size?.w ?? FOLDER_W, f.size?.h ?? FOLDER_H), firstSceneOrder: Number.isFinite(first) ? first : null, inScope: selected.has(f.id) }
  })
  const obstacles: Box[] = []
  if (opts.scope === 'selection') {
    const current = computeTakeRows(takes, p.scenes, useUI.getState().takeDisplay)
    const sceneMap = new Map(clusters.map((s) => [s.id, s]))
    for (const s of clusters) if (!s.inScope) obstacles.push({ ...s.pos, w: s.cardW + (current.rows.get(s.id)?.w ?? 0), h: Math.max(s.cardH, current.rows.get(s.id)?.h ?? 0) })
    for (const a of [...assets, ...folders]) if (!a.inScope) obstacles.push({ ...a.pos, w: a.w, h: a.h })
    for (const t of takeInputs) if (t.pos && !sceneMap.get(t.sceneId)?.inScope) obstacles.push({ ...t.pos, w: t.w, h: t.h })
  }
  const stage = typeof document === 'undefined' ? null : document.querySelector('.cv-stage')?.getBoundingClientRect()
  return { clusters, assets, folders, takes: takeInputs, obstacles, stage: { w: stage?.width || 1440, h: stage?.height || 900 }, focusId: placementHint().anchorId ?? null, layout: LAYOUT }
}

export function previewArrange(opts: ArrangeOptions) { return arrange(buildArrangeInput(opts), opts) }
export const autoLayoutCanvas = () => arrangeCanvas(LEGACY_ROWS)

type Change<T> = { from: T; to: T }
interface ArrangeRecord {
  projectId: string; before: Project; after: Project; pastDepth: number
  nodes: Record<string, Change<XY>>; takes: Record<string, Change<XY | null>>; display?: Change<TakeDisplay>
}
let records: ArrangeRecord[] = []
let lastLayout: { projectId: string; opts: ArrangeOptions; warned: boolean } | null = null
const positionsOf = (p: Project) => new Map([...p.scenes, ...p.assets, ...(p.folders ?? [])].map((s) => [s.id, s.position]))

onHistoryJump((before, after, kind) => {
  lastLayout = null
  const depth = useProject.temporal.getState().pastStates.length
  const target = positionsOf(after)
  // Depth disambiguates repeated layouts with identical positions and millisecond timestamps. Node matching survives
  // applyEverywhere replacing snapshots; a branch prunes records when the next arrange is recorded.
  const candidates = records.filter((r) => r.projectId === after.id && (kind === 'undo' ? r.pastDepth === depth : r.pastDepth + 1 === depth))
  for (const r of candidates) {
    const nodeChanges = Object.entries(r.nodes)
    const direct = kind === 'undo' ? before === r.after || after === r.before : before === r.before || after === r.after
    const matches = nodeChanges.length ? nodeChanges.every(([id, c]) => !!target.get(id) && samePosition(target.get(id)!, kind === 'undo' ? c.from : c.to))
      : kind === 'undo' ? after.updatedAt === r.before.updatedAt : before.updatedAt === r.before.updatedAt
    if (!direct && !matches) continue
    const from = kind === 'undo' ? 'to' : 'from', to = kind === 'undo' ? 'from' : 'to'
    const patch: Record<string, XY | null> = {}
    for (const t of useRuns.getState().takes) { const c = r.takes[t.id]; if (c && samePosition(t.position, c[from])) patch[t.id] = c[to] }
    if (Object.keys(patch).length) useRuns.getState().setTakePositions(patch)
    if (r.display && useUI.getState().takeDisplay === r.display[from]) useUI.getState().setTakeDisplay(r.display[to])
  }
})
// zundo mutates its arrays with shift/splice before notifying subscribers, so keep shallow copies for comparison.
let historyPast = useProject.temporal.getState().pastStates.slice()
let historyFuture = useProject.temporal.getState().futureStates.slice()
useProject.temporal.subscribe((s) => {
  const past = historyPast, future = historyFuture
  historyPast = s.pastStates.slice()
  historyFuture = s.futureStates.slice()
  if (!s.pastStates.length && !s.futureStates.length) records = []
  else if (future.length && !s.futureStates.length && useProject.getState().project !== future[future.length - 1]?.project) {
    records = records.filter((r) => r.pastDepth < past.length)
  } else if (s.pastStates.length > 1 && s.pastStates.length === past.length && s.pastStates[0] === past[1] && !s.futureStates.length) {
    for (const r of records) r.pastDepth--
    records = records.filter((r) => r.pastDepth >= 0)
  }
})
useProject.subscribe((s, prev) => {
  if (s.project.id !== prev.project.id) { records = []; lastLayout = null; useArrangeMenu.getState().close() }
})

export function arrangeCanvas(override: Partial<ArrangeOptions> = {}) {
  const opts = { ...resolveArrange(useArrangePrefs.getState()), ...override }
  const input = buildArrangeInput(opts), res = arrange(input, opts)
  const before = useProject.getState().project, runs = useRuns.getState()
  const display = useUI.getState().takeDisplay
  const displayChange = opts.video === 'chosen' && display !== 'chosen' && input.clusters.some((s) => opts.scope === 'all' || s.inScope)
  lastLayout = null // Applying / undoing a layout must not emit the visibility warning.
  if (!res.stats.moved && !Object.keys(res.takes).length && !displayChange) toast('Canvas đã gọn sẵn.')
  else {
    const old = positionsOf(before), pastDepth = useProject.temporal.getState().pastStates.length
    records = records.filter((r) => r.pastDepth < pastDepth)
    useProject.getState().setPositions(res.positions)
    const after = useProject.getState().project
    const changes = Object.fromEntries(runs.takes.filter((t) => t.id in res.takes).map((t) => [t.id, { from: t.position, to: res.takes[t.id] }]))
    if (Object.keys(res.takes).length) runs.setTakePositions(res.takes)
    if (displayChange) useUI.getState().setTakeDisplay('chosen')
    records.push({ projectId: before.id, before, after, pastDepth: useProject.temporal.getState().pastStates.length - 1, nodes: Object.fromEntries(Object.entries(res.positions).map(([id, to]) => [id, { from: old.get(id)!, to }])), takes: changes, ...(displayChange ? { display: { from: display, to: 'chosen' as const } } : {}) })
    records = records.slice(-20)
    let message = opts.scope === 'selection' ? 'Đã sắp xếp các mục đang chọn.' : opts.style === 'grid' ? `Đã xếp canvas thành lưới ${res.cols} cột.` : opts.style === 'strip' ? 'Đã xếp các cảnh thành một dải ngang.' : 'Đã sắp xếp lại canvas.'
    if (res.stats.takesBack) message += ` ${res.stats.takesBack} video về cạnh cảnh của nó.`
    if (res.stats.takesFollow) message += ` ${res.stats.takesFollow} video đi theo cảnh của nó.`
    if (displayChange) message += ' Đã bật “Chỉ take chọn” (mọi dự án): video khác và video đang tạo tạm ẩn.'
    if (res.stats.foldersMoved) message += ` ${res.stats.foldersMoved} thư mục đã lên hàng phía trên.`
    if (res.stats.assetsMoved) message += ` ${res.stats.assetsMoved} thẻ tham chiếu bị đè đã vào cột bên trái.`
    if (res.stats.movedAway) message += ' Chỗ cũ không đủ, đã đặt sang chỗ trống bên phải.'
    toast(message, { action: undoToastAction() })
  }
  lastLayout = { projectId: before.id, opts, warned: false }
  setTimeout(() => { if (useProject.getState().project.id === before.id) fitNodes(res.fitIds) }, 60)
  return res
}

function warnOverlap(message: string) {
  if (!lastLayout || lastLayout.warned) return
  lastLayout.warned = true
  const projectId = lastLayout.projectId
  toast(message, { action: { label: 'Sắp xếp lại', run: () => {
    if (useProject.getState().project.id !== projectId) return
    useUI.getState().setView('canvas')
    setTimeout(() => { if (useProject.getState().project.id === projectId) arrangeCanvas({ video: 'all' }) }, 120)
  } } })
}
useUI.subscribe((s, prev) => {
  if (s.takeDisplay === 'all' && prev.takeDisplay === 'chosen' && lastLayout?.opts.style !== 'rows' && lastLayout?.opts.video === 'chosen') warnOverlap('Video ẩn đã hiện lại và có thể đè lên cảnh bên cạnh.')
})
useRuns.subscribe((s, prev) => {
  if (s.takes.length <= prev.takes.length || !lastLayout || lastLayout.warned || lastLayout.opts.style === 'rows' || lastLayout.opts.video !== 'all') return
  const p = useProject.getState().project
  if (p.id !== lastLayout.projectId) return
  const oldIds = new Set(prev.takes.map((t) => t.id)), rows = computeTakeRows(s.takes, p.scenes, 'all')
  const addedScenes = new Set(s.takes.filter((t) => !oldIds.has(t.id)).map((t) => t.sceneId))
  for (const scene of p.scenes) {
    if (!addedScenes.has(scene.id)) continue
    const w = drawnSceneSize(scene.size)?.w ?? LAYOUT.sceneW
    const box = { ...scene.position, w: w + (rows.rows.get(scene.id)?.w ?? 0), h: Math.max(LAYOUT.sceneH, rows.rows.get(scene.id)?.h ?? 0) }
    if (p.scenes.some((other) => other.id !== scene.id && overlaps(box, { ...other.position, w: drawnSceneSize(other.size)?.w ?? LAYOUT.sceneW, h: drawnSceneSize(other.size)?.h ?? LAYOUT.sceneH }))) {
      warnOverlap(`Video mới của S${String(scene.order).padStart(2, '0')} đè lên cảnh bên cạnh.`)
      break
    }
  }
})
