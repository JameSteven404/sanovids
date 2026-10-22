import { Copy, Link2, Scissors, Trash2 } from 'lucide-react'
import { memo, useLayoutEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { connectSelection, deleteSelection, duplicateSelection, parseEdgeId, pickAssetSelection } from '../../actions'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { assetMapOf, sceneMapOf, takeIndexOf } from './canvasModel'
import { cutEdge } from './edges'
import { ensureRovingStop, ToolbarButton, toolbarArrowKey, useFocusRescue } from './ToolbarControls'
import { placeToolbarPanel, toolbarTrayContents, traySummary, type ToolbarRect, type ToolbarSize, type toolbarSide } from './toolbarModel'

export const ToolbarTray = memo(function ToolbarTray({ anchor, stage, side, focusBar }: {
  anchor: ToolbarRect; stage: ToolbarSize; side: ReturnType<typeof toolbarSide>
  /** Where focus goes when the focused tray button disappears (the bar's "⋯"). */
  focusBar: () => HTMLElement | null | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [ids, wires, library] = useUI(useShallow((s) => [s.selectedIds, s.selectedEdgeIds, s.librarySelection] as const))
  const sceneCount = useProject((s) => ids.filter((id) => sceneMapOf(s.project.scenes).has(id)).length)
  const anyTake = useRuns((s) => ids.some((id) => takeIndexOf(s.takes).byId.has(id)))
  // Same rule as actions.selectedAssetIds / connectSelection: canvas images win, a selected video drops the library.
  const assetCount = useProject((s) => pickAssetSelection(ids, anyTake ? [] : library, new Set(assetMapOf(s.project.assets).keys())).length)
  const canvasAssets = useProject((s) => ids.filter((id) => assetMapOf(s.project.assets).has(id)).length)
  const cuttable = wires.filter((id) => { const edge = parseEdgeId(id); return edge && edge.kind !== 'out' })
  const selection = { nodes: ids.length, scenes: sceneCount, assets: assetCount, fromLibrary: assetCount > 0 && !canvasAssets, cuttableWires: cuttable.length }
  const contents = toolbarTrayContents(selection)
  const summary = traySummary(selection)
  const signature = contents.join(',')
  const maxWidth = Math.max(0, side === 'left' ? anchor.x - 18 : side === 'right' ? stage.w - anchor.x - anchor.w - 18 : stage.w - 24)
  const maxHeight = Math.max(0, side === 'top' ? anchor.y - 18 : side === 'bottom' ? stage.h - anchor.y - anchor.h - 18 : stage.h - 24)
  // Focus on a button that a tray action removed (Xoá…, Bỏ nối, the selection emptied) lands on the bar's "⋯".
  const rescue = useFocusRescue(focusBar)
  useLayoutEffect(() => { ensureRovingStop(ref.current, document.activeElement) })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const position = () => {
      const p = placeToolbarPanel(anchor, { w: el.offsetWidth, h: el.offsetHeight }, stage, side)
      el.style.left = `${p.x}px`
      el.style.top = `${p.y}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(el)
    return () => observer.disconnect()
  }, [anchor, stage, side, signature])
  if (!contents.length) return null
  const commands = {
    connect: { label: `Nối ${assetCount} ảnh vào ${sceneCount} cảnh`, icon: Link2, run: connectSelection, shortcut: 'selection.connect' as const },
    duplicate: { label: `Nhân bản ${sceneCount} cảnh`, icon: Copy, run: duplicateSelection, shortcut: 'selection.duplicate' as const },
    delete: { label: 'Xoá vùng chọn…', icon: Trash2, run: deleteSelection, shortcut: 'selection.delete' as const },
    // Batch delete is the shared cut path with a single undo step and the existing file-trash confirmation.
    cut: { label: `Bỏ nối ${cuttable.length} dây đang chọn`, icon: Scissors, run: () => cuttable.length === 1 ? cutEdge(cuttable[0]) : deleteSelection() },
  }
  return <div ref={ref} className="cv-toolbar-tray material" role="toolbar" aria-label={`Thao tác với ${summary} đang chọn`}
    style={{ maxWidth, maxHeight }} onKeyDown={toolbarArrowKey} onFocus={rescue.onFocus} onBlur={rescue.onBlur}>
    <span className="cv-toolbar-summary">{summary}</span>
    {contents.map((id, index) => {
      const command = commands[id]
      return <ToolbarButton key={id} className={`cv-toolbar-button ${id === 'delete' ? 'cv-toolbar-danger' : ''}`}
        tabIndex={index === 0 ? 0 : -1} label={command.label} shortcut={'shortcut' in command ? command.shortcut : undefined} onClick={command.run}>
        <command.icon size={16} strokeWidth={1.75} />
        <span>{command.label}</span>
      </ToolbarButton>
    })}
  </div>
})
