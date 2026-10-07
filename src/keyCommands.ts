// Shared shortcut commands. Menu integration can reuse unlinkSelection without another cut implementation.
import * as actions from './actions'
import type { ActionId } from './core/keymap'
import { enterOpensEditor } from './components/canvas/sceneEditorModel'
import { edgeId } from './actions'
import { createFolderNode } from './folderActions'
import { noteCanvasCommand } from './libraryActions'
import { shortcutLabel } from './lib/keymapPrefs'
import { flushAll, flushScenes } from './lib/promptDrafts'
import { flush } from './store/persist'
import { useProject } from './store/project'
import { useRuns } from './store/runs'
import { toast, useUI } from './store/ui'

export const ZOOM_EVENT = 'zoom'
let panels: { left: boolean; right: boolean } | null = null

/** Enter opens a single selected take; focused controls keep their native activation. */
export function openSelectedTake(e: KeyboardEvent): boolean {
  if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return false
  const target = typeof Element !== 'undefined' && e.target instanceof Element ? e.target : null
  if (!enterOpensEditor(target) || target?.closest('[role="menuitemradio"], [role="menuitemcheckbox"]')) return false
  const ui = useUI.getState(), ids = actions.selectedTakeIds()
  if (ui.selectedIds.length !== 1 || ids.length !== 1) return false
  e.preventDefault()
  ui.openDialog({ kind: 'take', takeId: ids[0] })
  return true
}

export function toggleCanvasOnly(): void {
  const ui = useUI.getState()
  if (ui.leftOpen || ui.rightOpen) {
    panels = { left: ui.leftOpen, right: ui.rightOpen }
    ui.setLeftOpen(false)
    ui.setRightOpen(false)
    toast(`Đã ẩn hai khung bên — bấm ${shortcutLabel('panels.canvasOnly') || 'Chỉ canvas'} để hiện.`)
  } else {
    ui.setLeftOpen(panels?.left ?? true)
    ui.setRightOpen(panels?.right ?? true)
  }
}

export function focusPanel(which: 'library' | 'inspector'): void {
  const ui = useUI.getState()
  if (which === 'library') ui.setLeftOpen(true)
  else ui.setRightOpen(true)
  requestAnimationFrame(() => {
    const root = document.querySelector<HTMLElement>(which === 'library' ? '.sb' : '.in-root')
    if (root) { root.tabIndex = -1; root.focus({ preventScroll: true }) }
  })
}

function selectedImageWires(): string[] {
  const scenes = new Set(actions.selectedSceneIds()), assets = new Set(actions.selectedAssetIds())
  return useProject.getState().project.scenes.filter((s) => scenes.has(s.id)).flatMap((s) => [
    ...s.refs.filter((id) => assets.has(id)).map((id) => edgeId('ref', id, s.id)),
    ...(s.firstFrame && assets.has(s.firstFrame) ? [edgeId('first', s.firstFrame, s.id)] : []),
    ...(s.lastFrame && assets.has(s.lastFrame) ? [edgeId('last', s.lastFrame, s.id)] : []),
  ])
}

/** Route wires alone through the existing bulk delete: animation, placeholders, toast and ONE undo step. */
export function unlinkSelection(): void {
  const ui = useUI.getState()
  const wires = selectedImageWires()
  const edges = wires.length ? wires : ui.selectedEdgeIds
  if (!edges.length) { toast('Chọn ảnh và cảnh đã nối, hoặc dây cần bỏ nối.'); return }
  flushScenes(edges.flatMap((id) => { const edge = actions.parseEdgeId(id); return edge ? [edge.to] : [] }))
  const selectedIds = ui.selectedIds, selectedEdgeIds = ui.selectedEdgeIds
  useUI.setState({ selectedIds: [], selectedEdgeIds: edges })
  try { actions.deleteSelection() }
  finally { useUI.setState({ selectedIds, selectedEdgeIds: selectedEdgeIds.filter((id) => !edges.includes(id)) }) }
}

function toggleLink(): void {
  const scenes = actions.selectedSceneIds(), assets = actions.selectedAssetIds()
  const allLinked = scenes.length && assets.length && scenes.every((id) => {
    const s = useProject.getState().project.scenes.find((s) => s.id === id)!
    return assets.every((a) => s.refs.includes(a) || s.firstFrame === a || s.lastFrame === a)
  })
  if (allLinked) unlinkSelection()
  else actions.connectSelection()
}

export function starSelection(takeId?: string): void {
  const dialog = useUI.getState().dialog
  const ids = new Set(takeId ? [takeId] : dialog.kind === 'take' ? [dialog.takeId] : actions.selectedTakeIds())
  const takes = useRuns.getState().takes.filter((t) => ids.has(t.id) && t.status === 'completed')
  if (!takes.length) { toast('Chọn một video đã xong để đánh dấu ★.'); return }
  const scenes = new Set(takes.map((t) => t.sceneId))
  if (scenes.size !== takes.length) { toast('Mỗi cảnh chỉ chọn ★ được một video.'); return }
  const projectId = useProject.getState().project.id
  const before = new Map(useRuns.getState().takes.filter((t) => scenes.has(t.sceneId)).map((t) => [t.id, t.starred]))
  const star = !takes.every((t) => t.starred)
  for (const t of takes) if (!!t.starred !== star) useRuns.getState().toggleStar(t.id)
  toast(`${star ? 'Đã chọn' : 'Đã bỏ'} ★: ${takes.map((t) => actions.takeLabel(t.id)).join(', ')}`, {
    action: { label: 'Hoàn tác', run: () => {
      if (useProject.getState().project.id !== projectId) return
      useRuns.setState((s) => ({ takes: s.takes.map((t) => scenes.has(t.sceneId) ? { ...t, starred: before.get(t.id) ?? false } : t) }))
    } },
  })
}

export function downloadSelection(): void {
  const dialog = useUI.getState().dialog
  if (dialog.kind === 'take') { void actions.downloadTake(dialog.takeId); return }
  const ids = actions.selectedTakeIds().filter((id) => useRuns.getState().takes.some((t) => t.id === id && t.status === 'completed'))
  if (ids.length === 1) { void actions.downloadTake(ids[0]); return }
  if (ids.length > 1) { void actions.downloadTakesZip(ids); return }
  const scenes = new Set(actions.selectedSceneIds())
  if (scenes.size) {
    const selected = new Set(useRuns.getState().takes.filter((t) => scenes.has(t.sceneId)).map((t) => t.id))
    void actions.downloadTakesZip(actions.chosenTakeIds().filter((id) => selected.has(id)))
  } else if (useUI.getState().selectedIds.length) toast('Chọn cảnh hoặc video đã xong để tải.')
  else void actions.downloadChosenTakesZip()
}

const canvasCommand = (run: () => void) => () => { noteCanvasCommand(); run() }
const libraryEvent = (name: string) => {
  useUI.getState().setLeftOpen(true)
  requestAnimationFrame(() => window.dispatchEvent(new Event(name)))
}

export const KEY_COMMANDS: Record<Exclude<ActionId, 'settings.search'>, (e?: KeyboardEvent) => void> = {
  'project.save': () => { flushAll(); void flush().then((ok) => ok && toast('Đã lưu', { tone: 'success' })) },
  'project.open': () => useUI.getState().openDialog({ kind: 'projects' }),
  'scene.run': () => actions.requestRun(actions.selectedSceneIds()),
  'history.undo': actions.undo,
  'history.redo': actions.redo,
  'library.search': () => libraryEvent('bdp:search'),
  'library.addImages': () => libraryEvent('bdp:add-images'),
  'help.shortcuts': () => useUI.getState().openDialog({ kind: 'shortcuts' }),
  'scene.next': canvasCommand(actions.nextScene),
  'scene.new': canvasCommand(actions.newScene),
  'folder.new': () => { noteCanvasCommand(); void createFolderNode() },
  'selection.duplicate': canvasCommand(actions.duplicateSelection),
  'selection.delete': actions.deleteSelection,
  'selection.selectAll': canvasCommand(() => useUI.getState().select(useProject.getState().project.scenes.map((s) => s.id))),
  'selection.deselectAll': () => { useUI.getState().clearSelection(); useUI.getState().setLibrarySelection([]) },
  'selection.connect': toggleLink,
  unlinkSelection,
  'take.star': () => starSelection(),
  'take.download': downloadSelection,
  'panels.library': () => focusPanel('library'),
  'panels.inspector': () => focusPanel('inspector'),
  'panels.canvasOnly': toggleCanvasOnly,
  'canvas.fit': () => actions.canvasEvents.dispatchEvent(new CustomEvent(actions.FIT_EVENT, { detail: useUI.getState().selectedIds })),
  'canvas.zoomIn': (e) => { actions.canvasEvents.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: { dir: 1, repeat: !!e?.repeat } })) },
  'canvas.zoomOut': (e) => { actions.canvasEvents.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: { dir: -1, repeat: !!e?.repeat } })) },
  'canvas.cycleEdges': () => useUI.getState().cycleEdgeMode(),
  'canvas.hand': () => useUI.getState().setInteraction('hand'),
  'canvas.select': () => useUI.getState().setInteraction('select'),
  'canvas.minimap': () => useUI.getState().toggleMinimap(),
}
