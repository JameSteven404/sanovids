// Shared shortcut commands (KEY_COMMANDS: one handler per registry command, run by hooks/useShortcuts).
import * as actions from './actions'
import type { ActionId } from './core/keymap'
import { enterOpensEditor } from './components/canvas/sceneEditorModel'
import { toggleCanvasOnly as canvasOnlyNext } from './components/canvas/toolbarModel'
import { createFolderNode } from './folderActions'
import { LIBRARY_ROOT, noteCanvasCommand } from './libraryActions'
import { shortcutLabel } from './lib/keymapPrefs'
import { flushAll, flushScenes } from './lib/promptDrafts'
import { linkedPairs, unlinkAssetsFromScenes, unlinkWires } from './menuActions'
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

/**
 * "Chỉ canvas" (the key and the toolbar's "⋯" entry share this one memory, `panels`): hides both side panels and
 * remembers which were open; again, shows exactly those (toolbarModel.toggleCanvasOnly). The toolbar passes toast: false.
 */
export function toggleCanvasOnly(opts: { toast?: boolean } = {}): void {
  const ui = useUI.getState()
  const { next, remember } = canvasOnlyNext({ left: ui.leftOpen, right: ui.rightOpen }, panels)
  panels = remember
  ui.setLeftOpen(next.left)
  ui.setRightOpen(next.right)
  if (!next.left && !next.right && opts.toast !== false) toast(`Đã ẩn hai khung bên — bấm ${shortcutLabel('panels.canvasOnly') || 'Chỉ canvas'} để hiện.`)
}

/**
 * Open a side panel (never closes it) and put the keyboard focus there. The library goes to its own section
 * (`LIBRARY_ROOT`), so the next Delete / Ctrl+A act on the library, not on the canvas (libraryActions.isLibraryKeyTarget).
 */
export function focusPanel(which: 'library' | 'inspector'): void {
  const ui = useUI.getState()
  if (which === 'library') ui.setLeftOpen(true)
  else ui.setRightOpen(true)
  requestAnimationFrame(() => {
    const root = which === 'library'
      ? document.querySelector<HTMLElement>(LIBRARY_ROOT) ?? document.querySelector<HTMLElement>('.sb')
      : document.querySelector<HTMLElement>('.in-root')
    if (root) { root.tabIndex = -1; root.focus({ preventScroll: true }) }
  })
}

/**
 * Unlink the selected images from the selected scenes (refs and first / last frames) — the right-click menu's own
 * command (menuActions). No such pair: the selected wires — wires alone go through Delete itself (folder wires
 * included); with nodes selected too, only the image wires. The selection is left alone.
 */
export function unlinkSelection(): void {
  if (unlinkAssetsFromScenes(actions.selectedAssetIds(), actions.selectedSceneIds())) return
  const ui = useUI.getState()
  if (ui.selectedEdgeIds.length && !ui.selectedIds.length) {
    flushScenes(ui.selectedEdgeIds.flatMap((id) => { const edge = actions.parseEdgeId(id); return edge ? [edge.to] : [] }))
    actions.deleteSelection()
    return
  }
  if (unlinkWires(ui.selectedEdgeIds)) return
  const label = shortcutLabel('unlinkSelection')
  toast(`Chọn ảnh và cảnh đã nối${label ? ` rồi bấm ${label}` : ''}.`)
}

/** Link toggle (Premiere's Link): every selected pair already linked → unlink them; anything else → link. */
function toggleLink(): void {
  const scenes = actions.selectedSceneIds(), assets = actions.selectedAssetIds()
  const pairs = linkedPairs(assets, scenes)
  const linked = new Set([...pairs.refs, ...pairs.frames].map((p) => `${p.sceneId}|${p.assetId}`))
  const allLinked = scenes.length > 0 && assets.length > 0 && scenes.every((s) => assets.every((a) => linked.has(`${s}|${a}`)))
  if (allLinked) unlinkSelection()
  else actions.connectSelection()
}

/**
 * ★ the viewed take (take viewer) / `takeId`, else the selected finished takes (one per scene). All starred → unstar.
 * The runs store has no undo, so the stars of every take of the scenes involved are kept for "Hoàn tác".
 */
export function starSelection(takeId?: string): void {
  const dialog = useUI.getState().dialog
  const ids = new Set(takeId ? [takeId] : dialog.kind === 'take' ? [dialog.takeId] : actions.selectedTakeIds())
  const takes = useRuns.getState().takes.filter((t) => ids.has(t.id) && t.status === 'completed')
  if (!takes.length) {
    const label = shortcutLabel('take.star')
    toast(`Chọn một video (thẻ video)${label ? ` rồi bấm ${label}` : ''} để đánh dấu ★.`)
    return
  }
  const scenes = new Set(takes.map((t) => t.sceneId))
  if (scenes.size !== takes.length) {
    toast('Mỗi cảnh chỉ chọn ★ được một video.')
    return
  }
  const projectId = useProject.getState().project.id
  const all = useRuns.getState().takes
  const before = new Map(all.filter((t) => scenes.has(t.sceneId)).map((t) => [t.id, t.starred]))
  const star = !takes.every((t) => t.starred)
  // "★ S03_T3 (thay S03_T2)": the sibling that loses its star.
  const said = takes.map((t) => {
    const replaced = star && !t.starred ? all.find((o) => o.sceneId === t.sceneId && o.id !== t.id && o.starred) : undefined
    return `${actions.takeLabel(t.id)}${replaced ? ` (thay ${actions.takeLabel(replaced.id)})` : ''}`
  })
  for (const t of takes) if (!!t.starred !== star) useRuns.getState().toggleStar(t.id)
  toast(star ? `★ ${said.join(', ')}` : `Đã bỏ ★: ${said.join(', ')}`, {
    action: { label: 'Hoàn tác', run: () => {
      if (useProject.getState().project.id !== projectId) return
      useRuns.setState((s) => ({ takes: s.takes.map((t) => (scenes.has(t.sceneId) ? { ...t, starred: before.get(t.id) ?? false } : t)) }))
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
  'panels.canvasOnly': () => toggleCanvasOnly(),
  'canvas.fit': () => actions.canvasEvents.dispatchEvent(new CustomEvent(actions.FIT_EVENT, { detail: useUI.getState().selectedIds })),
  'canvas.zoomIn': (e) => { actions.canvasEvents.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: { dir: 1, repeat: !!e?.repeat } })) },
  'canvas.zoomOut': (e) => { actions.canvasEvents.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: { dir: -1, repeat: !!e?.repeat } })) },
  'canvas.cycleEdges': () => useUI.getState().cycleEdgeMode(),
  'canvas.hand': () => useUI.getState().setInteraction('hand'),
  'canvas.select': () => useUI.getState().setInteraction('select'),
  'canvas.minimap': () => useUI.getState().toggleMinimap(),
}
