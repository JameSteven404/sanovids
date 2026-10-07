import { useReactFlow, useStore } from '@xyflow/react'
import { Film, FolderPlus, GripVertical, Hand, Link2, Map as MapIcon, Maximize, MoreHorizontal, MousePointer2, Play, Plus, Spline } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { connectSelection, downloadChosenTakesZip, nextScene, redo, requestRun, selectedSceneIds, selectScenesWithoutVideo, undo } from '../../actions'
import type { ActionId } from '../../core/keymap'
import { createFolderNode } from '../../folderActions'
import { useMotionLevel } from '../../lib/canvasPrefs'
import { DEFAULT_TOOLBAR_PLACE, useToolbarPrefs, type ToolbarDock } from '../../lib/toolbarPrefs'
import { useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { ArrangeToolbarSlot } from './ArrangeToolbarSlot'
import { sceneMapOf } from './canvasModel'
import { ToolbarButton, ToolbarMenu, toolbarArrowKey, type ToolbarMenuItem } from './ToolbarControls'
import { ToolbarTray } from './ToolbarTray'
import { minimapPosition, nudgeToolbar, toolbarSide, type ToolbarItemId } from './toolbarModel'
import { useToolbarPlace } from './useToolbarPlace'
import './toolbar.css'

const DOCK_LABELS: Record<ToolbarDock, string> = { bottom: 'Cạnh dưới', top: 'Cạnh trên', left: 'Cạnh trái', right: 'Cạnh phải', free: 'Đặt tự do' }

export const ToolbarBar = memo(function ToolbarBar({ onArrange, onFit, big }: { onArrange: () => void; onFit: (ids?: string[]) => void; big: boolean }) {
  const rf = useReactFlow()
  const zoom = useStore((s) => Math.round(s.transform[2] * 100))
  const interaction = useUI((s) => s.interaction)
  const edgeMode = useUI((s) => s.edgeMode)
  const takeDisplay = useUI((s) => s.takeDisplay)
  const minimapHidden = useUI((s) => !!s.minimapAutoHiddenFor && !s.minimapShownFor.includes(s.minimapAutoHiddenFor))
  const showMinimap = useUI((s) => s.showMinimap) && !minimapHidden
  const selected = useUI((s) => s.selectedIds)
  const wireCount = useUI((s) => s.selectedEdgeIds.length)
  const sceneCount = useProject((s) => selected.filter((id) => sceneMapOf(s.project.scenes).has(id)).length)
  const motion = useMotionLevel()
  const duration = motion === 'full' ? 150 : 0
  const placement = useToolbarPlace()
  const { host, fit, stage, rect, place, dragging } = placement
  const side = toolbarSide(fit.dock, rect, stage)
  const barRef = useRef<HTMLDivElement>(null)
  const menuOpener = useRef<HTMLElement | null>(null)
  const focused = useRef<string | null>(null)
  const [menu, setMenu] = useState<{ label: string; items: ToolbarMenuItem[] } | null>(null)
  const closeMenu = useCallback(() => {
    setMenu(null)
    if (menuOpener.current?.isConnected) menuOpener.current.focus({ preventScroll: true })
  }, [])
  const openMenu = useCallback((label: string, items: ToolbarMenuItem[]) => {
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('.cv-toolbar-menu')) menuOpener.current = document.activeElement
    setMenu({ label, items })
  }, [])
  useEffect(() => {
    if (!menu) return
    const closeOutside = (e: PointerEvent) => { if (!host.current?.contains(e.target as Node)) closeMenu() }
    window.addEventListener('pointerdown', closeOutside, true)
    window.addEventListener('blur', closeMenu)
    return () => { window.removeEventListener('pointerdown', closeOutside, true); window.removeEventListener('blur', closeMenu) }
  }, [menu, closeMenu, host])
  useLayoutEffect(() => {
    if (focused.current && !barRef.current?.querySelector(`[data-tool="${focused.current}"]`) && document.activeElement === document.body) {
      barRef.current?.querySelector<HTMLButtonElement>('[data-tool="more"]')?.focus()
    }
  }, [fit.shown.join(',')])
  useLayoutEffect(() => {
    const el = host.current
    const map = el?.parentElement?.querySelector<HTMLElement>('.react-flow__minimap')
    if (!el || !map) return
    const original = map.getAttribute('style')
    const position = () => {
      const origin = el.getBoundingClientRect()
      const blockers = [...el.querySelectorAll<HTMLElement>('.cv-toolbar-bar, .cv-toolbar-tray')].map((item) => {
        const r = item.getBoundingClientRect()
        return { x: r.left - origin.left - 6, y: r.top - origin.top - 6, w: r.width + 12, h: r.height + 12 }
      })
      const p = minimapPosition(stage, { w: map.offsetWidth, h: map.offsetHeight }, blockers)
      Object.assign(map.style, { left: `${p.x}px`, top: `${p.y}px`, right: 'auto', bottom: 'auto', margin: '0', transition: 'none' })
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(map)
    const tray = el.querySelector('.cv-toolbar-tray')
    if (tray) observer.observe(tray)
    return () => { observer.disconnect(); if (original === null) map.removeAttribute('style'); else map.setAttribute('style', original) }
  }, [host, rect.x, rect.y, rect.w, rect.h, stage, showMinimap, selected, wireCount, dragging])
  useEffect(() => {
    const el = host.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      if (menu || dragging) return
      const pane = el.parentElement?.querySelector('.react-flow__pane')
      if (!pane) return
      e.preventDefault()
      pane.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
        deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey }))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [host, menu, dragging])

  const ui = useUI.getState()
  const positionMenu = () => openMenu('Vị trí thanh công cụ', [
    ...(['bottom', 'top', 'left', 'right'] as const).map((dock) => ({ id: dock, label: DOCK_LABELS[dock], checked: place.dock === dock,
      run: () => useToolbarPrefs.getState().setPlace({ ...place, dock }) })),
    { id: 'reset', label: 'Đưa thanh về chỗ cũ', run: () => { useToolbarPrefs.getState().setPlace(DEFAULT_TOOLBAR_PLACE); toast('Đã đưa thanh công cụ về chỗ cũ.') } },
  ])
  const zoomMenu = () => openMenu('Thu phóng', [
    { id: 'in', label: 'Phóng to', run: () => { void rf.zoomIn({ duration }) } },
    { id: 'out', label: 'Thu nhỏ', run: () => { void rf.zoomOut({ duration }) } },
    ...[0.5, 1, 2].map((value) => ({ id: String(value), label: `${value * 100}%`, run: () => { void rf.zoomTo(value, { duration }) } })),
    { id: 'fit', label: 'Vừa màn hình', shortcut: 'canvas.fit', run: () => onFit() },
    { id: 'selection', label: 'Vừa vùng đang chọn', disabled: !selected.length, run: () => onFit(useUI.getState().selectedIds) },
  ])
  const edgeMenu = () => openMenu('Hiển thị dây nối', [
    { id: 'hidden', label: 'Ẩn · chỉ hiện dây đang trỏ', checked: edgeMode === 'hidden', run: () => ui.setEdgeMode('hidden') },
    { id: 'selected', label: 'Đang chọn', checked: edgeMode === 'selected', shortcut: 'canvas.cycleEdges', run: () => ui.setEdgeMode('selected') },
    { id: 'all', label: big ? 'Tất cả · chỉ vẽ dây gần vùng đang xem' : 'Tất cả', checked: edgeMode === 'all', run: () => ui.setEdgeMode('all') },
  ])
  const takeMenu = () => openMenu('Hiển thị video', [
    { id: 'all', label: 'Tất cả', checked: takeDisplay === 'all', run: () => ui.setTakeDisplay('all') },
    { id: 'chosen', label: 'Chỉ take chọn ★', checked: takeDisplay === 'chosen', run: () => ui.setTakeDisplay('chosen') },
  ])
  const entries: Record<ToolbarItemId, { label: string; icon: typeof Plus; run: () => void; shortcut?: ActionId; pressed?: boolean; disabled?: boolean; menu?: boolean }> = {
    new: { label: 'Cảnh mới', icon: Plus, run: () => { nextScene() }, shortcut: 'scene.next' },
    folder: { label: 'Thư mục lưu video…', icon: FolderPlus, run: () => { void createFolderNode() } },
    link: { label: 'Nối ảnh vào các cảnh đang chọn', icon: Link2, run: connectSelection, shortcut: 'selection.connect' },
    run: { label: sceneCount ? `Chạy ${sceneCount} cảnh đang chọn · xác nhận chi phí` : 'Chạy · chọn ít nhất một cảnh', icon: Play, run: () => requestRun(selectedSceneIds()), shortcut: 'scene.run', disabled: !sceneCount },
    arrange: { label: 'Sắp xếp lại canvas', icon: Maximize, run: onArrange },
    fit: { label: 'Vừa màn hình', icon: Maximize, run: () => onFit(useUI.getState().selectedIds), shortcut: 'canvas.fit' },
    hand: { label: 'Tay · kéo nền để di chuyển', icon: Hand, run: () => ui.setInteraction('hand'), shortcut: 'canvas.hand', pressed: interaction === 'hand' },
    select: { label: 'Chọn · kéo để chọn vùng', icon: MousePointer2, run: () => ui.setInteraction('select'), shortcut: 'canvas.select', pressed: interaction === 'select' },
    edges: { label: 'Hiển thị dây nối', icon: Spline, run: edgeMenu, shortcut: 'canvas.cycleEdges', menu: true },
    takes: { label: 'Hiển thị video', icon: Film, run: takeMenu, menu: true },
    minimap: { label: minimapHidden ? 'Bản đồ thu nhỏ · đang tạm ẩn vì dự án lớn' : 'Bản đồ thu nhỏ', icon: MapIcon, run: () => ui.toggleMinimap(), shortcut: 'canvas.minimap', pressed: showMinimap },
    zoom: { label: `Thu phóng ${zoom}%`, icon: Maximize, run: zoomMenu, menu: true },
  }
  const moreMenu = () => openMenu('Thêm thao tác', [
    ...fit.overflow.map((id) => ({ id, ...entries[id] })),
    { id: 'pending', label: 'Chọn cảnh chưa có video', run: () => { selectScenesWithoutVideo() } },
    { id: 'failed', label: 'Chọn cảnh bị lỗi', run: () => { selectScenesWithoutVideo(true) } },
    { id: 'undo', label: 'Hoàn tác', shortcut: 'history.undo', run: undo },
    { id: 'redo', label: 'Làm lại', shortcut: 'history.redo', run: redo },
    { id: 'zip', label: 'Tải tất cả video chọn ★ (.zip)', run: () => { void downloadChosenTakesZip() } },
    { id: 'panels', label: ui.leftOpen || ui.rightOpen ? 'Chỉ canvas (ẩn hai khung bên)' : 'Hiện hai khung bên', run: () => {
      const state = useUI.getState(), show = !state.leftOpen && !state.rightOpen
      state.setLeftOpen(show); state.setRightOpen(show)
    } },
    { id: 'shortcuts', label: 'Phím tắt', shortcut: 'help.shortcuts', run: () => ui.openDialog({ kind: 'shortcuts' }) },
  ])
  return <div ref={host} className="cv-toolbar-host" data-dock={fit.dock} data-dragging={dragging || undefined}
    onKeyDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'none' }}
    onDrop={(e) => { e.preventDefault(); e.stopPropagation() }}>
    <div ref={barRef} className="cv-toolbar cv-toolbar-bar material nodrag nopan" role="toolbar" aria-label="Công cụ canvas"
      aria-orientation={fit.vertical ? 'vertical' : 'horizontal'} data-orient={fit.vertical ? 'vertical' : 'horizontal'}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} onKeyDown={toolbarArrowKey}
      onFocus={(e) => { focused.current = (e.target as HTMLElement).closest<HTMLElement>('[data-tool]')?.dataset.tool ?? null }}>
      <ToolbarButton className="cv-toolbar-button cv-toolbar-grip" label="Kéo để dời thanh · bấm để mở menu của thanh" data-grip tabIndex={0}
        aria-haspopup="menu" aria-expanded={menu?.label === 'Vị trí thanh công cụ'} aria-describedby="cv-toolbar-grip-help"
        onPointerDown={placement.start} onPointerMove={placement.move} onPointerUp={() => placement.finish(true)}
        onPointerCancel={() => placement.finish(false)} onLostPointerCapture={() => placement.finish(false)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); positionMenu() }}
        onClick={() => { if (Date.now() >= placement.suppressClick.current) positionMenu() }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key.startsWith('Arrow') || e.key === 'Home') { e.preventDefault(); useToolbarPrefs.getState().setPlace(nudgeToolbar(place, e.key, stage, e.shiftKey, e.altKey)) }
        }}><GripVertical size={16} strokeWidth={1.75} /></ToolbarButton>
      {fit.shown.map((id, index) => {
        const item = entries[id]
        if (id === 'arrange') return <span key={id} data-tool={id} className="cv-toolbar-arrange"><ArrangeToolbarSlot onArrange={onArrange} /></span>
        return <ToolbarButton key={id} data-tool={id} className={`cv-toolbar-button ${id === 'run' ? 'cv-toolbar-run' : ''} ${id === 'zoom' ? 'cv-toolbar-zoom' : ''}`}
          label={item.label} shortcut={item.shortcut} disabled={item.disabled} aria-pressed={item.pressed} tabIndex={index === 0 ? 0 : -1}
          aria-haspopup={item.menu ? 'menu' : undefined} aria-expanded={item.menu ? menu?.label === (id === 'zoom' ? 'Thu phóng' : item.label) : undefined}
          onClick={item.run}>
          {id === 'zoom' ? `${zoom}%` : <item.icon size={16} strokeWidth={1.75} />}
          {id === 'run' && sceneCount > 0 && <span className="cv-toolbar-count" aria-hidden>{sceneCount}</span>}
        </ToolbarButton>
      })}
      <ToolbarButton data-tool="more" className="cv-toolbar-button" label="Thêm thao tác" aria-haspopup="menu" aria-expanded={menu?.label === 'Thêm thao tác'} onClick={moreMenu}>
        <MoreHorizontal size={16} strokeWidth={1.75} />
      </ToolbarButton>
    </div>
    {!dragging && <ToolbarTray anchor={rect} stage={stage} side={side} openMenu={openMenu} />}
    {menu && <ToolbarMenu key={menu.label} {...menu} anchor={rect} stage={stage} side={side} onClose={closeMenu} />}
    <span className="cv-toolbar-sr" id="cv-toolbar-grip-help">Kéo để dời. Enter: menu của thanh. Mũi tên: dời 16 px; Shift: 64 px. Alt + mũi tên: bám cạnh. Home: về chỗ cũ.</span>
    <span className="cv-toolbar-sr" role="status">{dragging ? '' : `Thanh công cụ: ${DOCK_LABELS[fit.dock]}.`}</span>
  </div>
})
