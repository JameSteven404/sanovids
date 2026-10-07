import { Copy, Download, Folder, Link2, Play, Scissors, Star, Trash2 } from 'lucide-react'
import { memo, useLayoutEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { connectSelection, deleteSelection, downloadTake, duplicateSelection, parseEdgeId, pickAssetSelection, rerunTake, takeLabel } from '../../actions'
import { createFolderNode, linkTakesToFolder } from '../../folderActions'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { assetMapOf, sceneMapOf, takeIndexOf } from './canvasModel'
import { cutEdge } from './edges'
import { ToolbarButton, toolbarArrowKey, type ToolbarMenuItem } from './ToolbarControls'
import { placeToolbarPanel, toolbarTrayContents, type ToolbarRect, type ToolbarSize, type toolbarSide } from './toolbarModel'

export const ToolbarTray = memo(function ToolbarTray({ anchor, stage, side, openMenu }: {
  anchor: ToolbarRect; stage: ToolbarSize; side: ReturnType<typeof toolbarSide>
  openMenu: (label: string, items: ToolbarMenuItem[]) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [ids, wires, library] = useUI(useShallow((s) => [s.selectedIds, s.selectedEdgeIds, s.librarySelection] as const))
  const sceneCount = useProject((s) => ids.filter((id) => sceneMapOf(s.project.scenes).has(id)).length)
  const anyTake = useRuns((s) => ids.some((id) => takeIndexOf(s.takes).byId.has(id)))
  const assetCount = useProject((s) => pickAssetSelection(ids, anyTake ? [] : library, new Set(assetMapOf(s.project.assets).keys())).length)
  const take = useRuns((s) => ids.length === 1 ? takeIndexOf(s.takes).byId.get(ids[0]) : undefined)
  const cuttable = wires.filter((id) => { const edge = parseEdgeId(id); return edge && edge.kind !== 'out' })
  const contents = toolbarTrayContents({ nodes: ids.length, scenes: sceneCount, assets: assetCount, takeStatus: take?.status, cuttableWires: cuttable.length })
  const summary = take ? takeLabel(take.id) : sceneCount >= 2 ? `${sceneCount} cảnh${assetCount ? ` · ${assetCount} ảnh` : ''}` : `${cuttable.length} dây`
  const signature = contents.join(',')
  const maxWidth = Math.max(0, side === 'left' ? anchor.x - 18 : side === 'right' ? stage.w - anchor.x - anchor.w - 18 : stage.w - 24)
  const maxHeight = Math.max(0, side === 'top' ? anchor.y - 18 : side === 'bottom' ? stage.h - anchor.y - anchor.h - 18 : stage.h - 24)
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
  useLayoutEffect(() => () => {
    if (ref.current?.contains(document.activeElement)) ref.current.parentElement?.querySelector<HTMLButtonElement>('[data-tool="more"]')?.focus()
  }, [signature])
  if (!contents.length) return null
  const folderMenu = () => {
    if (!take) return
    openMenu('Lưu vào thư mục', [
      ...(useProject.getState().project.folders ?? []).map((folder) => ({ id: folder.id, label: folder.name, run: () => linkTakesToFolder([take.id], folder.id) })),
      { id: 'new-folder', label: 'Thư mục mới…', run: () => { void createFolderNode({ takeIds: [take.id] }) } },
    ])
  }
  const commands = {
    connect: { label: `Nối ${assetCount} ảnh vào ${sceneCount} cảnh`, icon: Link2, run: connectSelection, shortcut: 'selection.connect' as const },
    duplicate: { label: `Nhân bản ${sceneCount} cảnh`, icon: Copy, run: duplicateSelection, shortcut: 'selection.duplicate' as const },
    star: { label: take?.starred ? 'Bỏ chọn ★' : 'Chọn cho cảnh ★', icon: Star, run: () => take && useRuns.getState().toggleStar(take.id) },
    download: { label: 'Tải video', icon: Download, run: () => { if (take) void downloadTake(take.id) } },
    save: { label: 'Lưu vào thư mục…', icon: Folder, run: folderMenu },
    rerun: { label: 'Chạy lại…', icon: Play, run: () => take && rerunTake(take.id) },
    delete: { label: take ? 'Xoá video…' : 'Xoá vùng chọn…', icon: Trash2, run: deleteSelection, shortcut: 'selection.delete' as const },
    // Batch delete is the shared cut path with a single undo step and the existing file-trash confirmation.
    cut: { label: `Bỏ nối ${cuttable.length} dây đang chọn`, icon: Scissors, run: () => cuttable.length === 1 ? cutEdge(cuttable[0]) : deleteSelection() },
  }
  return <div ref={ref} className="cv-sel-hint cv-toolbar-tray material" role="toolbar" aria-label={`Thao tác với ${summary} đang chọn`}
    style={{ maxWidth, maxHeight }} onKeyDown={toolbarArrowKey}>
    <span className="cv-toolbar-summary">{summary}</span>
    {contents.map((id, index) => {
      const command = commands[id]
      return <ToolbarButton key={id} className={`cv-toolbar-button ${id === 'delete' ? 'cv-toolbar-danger' : ''}`}
        tabIndex={index === 0 ? 0 : -1} label={command.label} shortcut={'shortcut' in command ? command.shortcut : undefined}
        aria-pressed={id === 'star' ? take?.starred : undefined} aria-haspopup={id === 'save' ? 'menu' : undefined} onClick={command.run}>
        <command.icon size={16} strokeWidth={1.75} />
        <span>{command.label}</span>
      </ToolbarButton>
    })}
  </div>
})
