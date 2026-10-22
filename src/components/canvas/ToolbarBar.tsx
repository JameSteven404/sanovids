import { useReactFlow, useStore } from '@xyflow/react'
import { ChevronDown, Eye, GripVertical, Hand, Maximize, MoreHorizontal, MousePointer2, Play, Plus } from 'lucide-react'
import { Fragment, lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { connectSelection, downloadChosenTakesZip, newScene, nextScene, redo, requestRun, selectedSceneIds, selectScenesWithoutVideo, undo } from '../../actions'
import { useArrangeMenu } from '../../arrangeActions'
import type { ActionId } from '../../core/keymap'
import { createFolderNode } from '../../folderActions'
import { toggleCanvasOnly as toggleCanvasOnlyPanels } from '../../keyCommands'
import { useMotionLevel } from '../../lib/canvasPrefs'
import { IS_MAC } from '../../lib/platform'
import { DEFAULT_TOOLBAR_PLACE, useToolbarPrefs, type ToolbarDock } from '../../lib/toolbarPrefs'
import { useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { ArrangeToolbarSlot } from './ArrangeToolbarSlot'
import { sceneMapOf } from './canvasModel'
import { ensureRovingStop, ToolbarButton, ToolbarMenu, toolbarArrowKey, useFocusRescue, type ToolbarMenuItem } from './ToolbarControls'
import { ToolbarTray } from './ToolbarTray'
import {
  canScrollBy, canvasOnlyLabel, gripHelpText, minimapPosition, nudgeToolbar, toolbarSide, viewDiffers,
  type ToolbarItemId,
} from './toolbarModel'
import { useToolbarPlace } from './useToolbarPlace'
import './toolbar.css'

// Opened from ▾ only: its own chunk (and arrange.css), loaded on the first open.
const ArrangePopover = lazy(() => import('./ArrangePopover').then((m) => ({ default: m.ArrangePopover })))

const DOCK_LABELS: Record<ToolbarDock, string> = { bottom: 'Cạnh dưới', top: 'Cạnh trên', left: 'Cạnh trái', right: 'Cạnh phải', free: 'Đặt tự do' }
const MENU = { place: 'Vị trí thanh công cụ', add: 'Thêm vào canvas', view: 'Hiển thị', zoom: 'Thu phóng', more: 'Thêm thao tác' } as const
const ICON = { size: 16, strokeWidth: 1.75 } as const
/** Where ArrangePopover opens, from the side toolbar panels open on (toolbarModel.toolbarSide). */
const POPOVER_SIDE = { top: 'up', bottom: 'down', left: 'left', right: 'right' } as const
// "Chỉ canvas" shares the key's memory of which panels it hid (keyCommands.toggleCanvasOnly); no toast here.
const toggleSidePanels = () => toggleCanvasOnlyPanels({ toast: false })

export const ToolbarBar = memo(function ToolbarBar({ onArrange, onFit, big }: { onArrange: () => void; onFit: (ids?: string[]) => void; big: boolean }) {
  const rf = useReactFlow()
  const zoom = useStore((s) => Math.round(s.transform[2] * 100))
  const interaction = useUI((s) => s.interaction)
  const edgeMode = useUI((s) => s.edgeMode)
  const takeDisplay = useUI((s) => s.takeDisplay)
  const minimapHidden = useUI((s) => !!s.minimapAutoHiddenFor && !s.minimapShownFor.includes(s.minimapAutoHiddenFor))
  const minimapPref = useUI((s) => s.showMinimap)
  const showMinimap = minimapPref && !minimapHidden
  const viewChanged = viewDiffers({ edgeMode, takeDisplay, showMinimap: minimapPref })
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
  const [menu, setMenu] = useState<{ label: string; items: ToolbarMenuItem[] } | null>(null)
  const focusMore = useCallback(() => barRef.current?.querySelector<HTMLButtonElement>('[data-tool="more"]'), [])
  const rescue = useFocusRescue(focusMore)
  const arrangeOpen = useArrangeMenu((s) => s.open)
  // The ▾ of "Sắp xếp", or "⋯" while the slot sits in the overflow menu.
  const arrangeAnchor = () => barRef.current?.querySelector<HTMLElement>('[data-arrange-menu]') ?? focusMore() ?? barRef.current
  const closeArrange = useCallback(() => {
    useArrangeMenu.getState().close()
    ;(barRef.current?.querySelector<HTMLElement>('[data-arrange-menu]') ?? focusMore())?.focus({ preventScroll: true })
  }, [focusMore])
  // A bar that leaves the page (another view, the canvas remounted) closes its popover.
  useEffect(() => () => useArrangeMenu.getState().close(), [])
  useLayoutEffect(() => { ensureRovingStop(barRef.current, document.activeElement) })
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
      // A tray that wraps past its max height scrolls under the wheel until its end; then the wheel zooms again.
      const box = e.target instanceof Element ? e.target.closest('.cv-toolbar-tray') : null
      if (box && !e.ctrlKey && !e.metaKey && canScrollBy(box, e.deltaX, e.deltaY)) return
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
  const positionMenu = () => openMenu(MENU.place, [
    ...(['bottom', 'top', 'left', 'right'] as const).map((dock) => ({ id: dock, label: DOCK_LABELS[dock], checked: place.dock === dock,
      run: () => useToolbarPrefs.getState().setPlace({ ...place, dock }) })),
    { id: 'reset', label: 'Đưa thanh về chỗ cũ', run: () => { useToolbarPrefs.getState().setPlace(DEFAULT_TOOLBAR_PLACE); toast('Đã đưa thanh công cụ về chỗ cũ.') } },
  ])
  const zoomMenu = () => openMenu(MENU.zoom, [
    { id: 'in', label: 'Phóng to', run: () => { void rf.zoomIn({ duration }) } },
    { id: 'out', label: 'Thu nhỏ', run: () => { void rf.zoomOut({ duration }) } },
    ...[0.5, 1, 2].map((value) => ({ id: String(value), label: `${value * 100}%`, run: () => { void rf.zoomTo(value, { duration }) } })),
    { id: 'fit', label: 'Vừa màn hình', shortcut: 'canvas.fit', run: () => onFit() },
    { id: 'selection', label: 'Vừa vùng đang chọn', disabled: !selected.length, run: () => onFit(useUI.getState().selectedIds) },
  ])
  // Dây nối / Video / Bản đồ thu nhỏ share one "Hiển thị" button (mockup A); E and M still switch them directly.
  const viewMenu = () => openMenu(MENU.view, [
    { id: 'edges', label: 'Dây nối', heading: true, shortcut: 'canvas.cycleEdges' },
    { id: 'edges-hidden', label: 'Ẩn · chỉ hiện dây đang trỏ', checked: edgeMode === 'hidden', run: () => ui.setEdgeMode('hidden') },
    { id: 'edges-selected', label: 'Đang chọn', checked: edgeMode === 'selected', run: () => ui.setEdgeMode('selected') },
    { id: 'edges-all', label: big ? 'Tất cả · chỉ vẽ dây gần vùng đang xem' : 'Tất cả', checked: edgeMode === 'all', run: () => ui.setEdgeMode('all') },
    { id: 'takes', label: 'Video', heading: true },
    { id: 'takes-all', label: 'Tất cả', checked: takeDisplay === 'all', run: () => ui.setTakeDisplay('all') },
    { id: 'takes-chosen', label: 'Chỉ take chọn ★', checked: takeDisplay === 'chosen', run: () => ui.setTakeDisplay('chosen') },
    { id: 'view-sep', label: '', separator: true },
    { id: 'minimap', label: minimapHidden ? 'Bản đồ thu nhỏ · đang tạm ẩn vì dự án lớn' : 'Bản đồ thu nhỏ', check: true, checked: showMinimap,
      shortcut: 'canvas.minimap', run: () => ui.toggleMinimap() },
  ])
  const addItems: ToolbarMenuItem[] = [
    { id: 'add-empty', label: 'Cảnh trống', run: () => { newScene() } },
    { id: 'add-folder', label: 'Thư mục lưu video…', run: () => { void createFolderNode() } },
    { id: 'add-import', label: 'Nhập nhiều prompt…', run: () => ui.openDialog({ kind: 'import' }) },
  ]
  const addMenu = () => openMenu(MENU.add, [{ id: 'add-next', label: 'Cảnh tiếp theo', shortcut: 'scene.next', run: () => { nextScene() } }, ...addItems])
  const hand = { label: 'Tay · kéo nền để di chuyển', shortcut: 'canvas.hand' as const, run: () => ui.setInteraction('hand'), pressed: interaction === 'hand' }
  const pick = { label: 'Chọn · kéo để chọn vùng', shortcut: 'canvas.select' as const, run: () => ui.setInteraction('select'), pressed: interaction === 'select' }
  const entries: Record<Exclude<ToolbarItemId, 'mouse' | 'arrange'>, { label: string; icon: ReactNode; run: () => void; shortcut?: ActionId; disabled?: boolean; menu?: string }> = {
    // nextScene copies the selected scene's references and settings (Ctrl+N "Cảnh mới (trống)" never does): say so
    new: { label: sceneCount ? 'Cảnh tiếp theo (giữ ảnh tham chiếu và cấu hình)' : 'Cảnh mới', icon: <Plus {...ICON} />, run: () => { nextScene() }, shortcut: 'scene.next' },
    add: { label: 'Thêm: cảnh trống, thư mục lưu video, nhập nhiều prompt', icon: <ChevronDown size={12} strokeWidth={2} />, run: addMenu, menu: MENU.add },
    run: { label: sceneCount ? `Chạy ${sceneCount} cảnh đang chọn · xác nhận chi phí` : 'Chạy · chọn ít nhất một cảnh', icon: <Play {...ICON} />, run: () => requestRun(selectedSceneIds()), shortcut: 'scene.run', disabled: !sceneCount },
    fit: { label: 'Vừa màn hình', icon: <Maximize {...ICON} />, run: () => onFit(useUI.getState().selectedIds), shortcut: 'canvas.fit' },
    view: { label: `Hiển thị: dây nối, video, bản đồ thu nhỏ${viewChanged ? ' (đang khác mặc định)' : ''}`, icon: <Eye {...ICON} />, run: viewMenu, menu: MENU.view },
    zoom: { label: `Thu phóng ${zoom}%`, icon: `${zoom}%`, run: zoomMenu, menu: MENU.zoom },
  }
  // A slot that does not fit is still one click away in "⋯" (Tay and Chọn together, the "+ ▾" rows one by one).
  const overflowRows = (id: ToolbarItemId): ToolbarMenuItem[] => id === 'mouse'
    ? [{ id: 'hand', ...hand, checked: hand.pressed }, { id: 'select', ...pick, checked: pick.pressed }]
    : id === 'add' ? addItems
      : id === 'arrange' ? [{ id, label: 'Sắp xếp lại canvas', run: onArrange }, { id: 'arrange-menu', label: 'Kiểu sắp xếp & tuỳ chỉnh…', run: () => useArrangeMenu.getState().toggle() }]
        : [{ id, ...entries[id], label: entries[id].menu ? `${entries[id].menu}…` : entries[id].label }]
  const moreMenu = () => {
    const now = useUI.getState()
    const overflow = fit.overflow.flatMap(overflowRows)
    openMenu(MENU.more, [
      ...(overflow.length ? [{ id: 'overflow', label: 'Không đủ chỗ trên thanh', heading: true }, ...overflow, { id: 'overflow-sep', label: '', separator: true }] : []),
      { id: 'link', label: 'Nối ảnh vào các cảnh đang chọn', shortcut: 'selection.connect', run: connectSelection },
      { id: 'pending', label: 'Chọn cảnh chưa có video', run: () => { selectScenesWithoutVideo() } },
      { id: 'failed', label: 'Chọn cảnh bị lỗi', run: () => { selectScenesWithoutVideo(true) } },
      { id: 'more-sep', label: '', separator: true },
      { id: 'zip', label: 'Tải tất cả video chọn ★ (.zip)', run: () => { void downloadChosenTakesZip() } },
      // Label read now, not at render: the panels may have been toggled elsewhere since.
      { id: 'panels', label: canvasOnlyLabel({ left: now.leftOpen, right: now.rightOpen }), run: toggleSidePanels },
      { id: 'undo', label: 'Hoàn tác', shortcut: 'history.undo', run: undo },
      { id: 'redo', label: 'Làm lại', shortcut: 'history.redo', run: redo },
      { id: 'shortcuts', label: 'Phím tắt', shortcut: 'help.shortcuts', run: () => ui.openDialog({ kind: 'shortcuts' }) },
    ])
  }
  const slot = (id: ToolbarItemId) => {
    if (id === 'arrange') return <span key={id} data-tool={id} className="cv-toolbar-arrange"><ArrangeToolbarSlot onArrange={onArrange} /></span>
    if (id === 'mouse') return <span key={id} className="cv-toolbar-pair" role="group" aria-label="Chế độ chuột">
      {([['hand', hand, Hand], ['select', pick, MousePointer2]] as const).map(([tool, item, Icon]) =>
        <ToolbarButton key={tool} data-tool={tool} className="cv-toolbar-button" label={item.label} shortcut={item.shortcut}
          aria-pressed={item.pressed} onClick={item.run}><Icon {...ICON} /></ToolbarButton>)}
    </span>
    const item = entries[id]
    return <ToolbarButton key={id} data-tool={id} className={`cv-toolbar-button cv-toolbar-${id}`}
      label={item.label} shortcut={item.shortcut} disabled={item.disabled} tabIndex={id === fit.shown[0] ? 0 : -1}
      aria-haspopup={item.menu ? 'menu' : undefined} aria-expanded={item.menu ? menu?.label === item.menu : undefined}
      onClick={item.run}>
      {item.icon}
      {id === 'run' && sceneCount > 0 && <span className="cv-toolbar-count" aria-hidden>{sceneCount}</span>}
      {id === 'view' && viewChanged && <span className="cv-toolbar-dot" aria-hidden />}
    </ToolbarButton>
  }
  // `nokey`: React Flow ignores plain keys typed here (Space on a button must not start panning); global shortcuts still run.
  return <div ref={host} className="cv-toolbar-host nokey" data-dock={fit.dock} data-dragging={dragging || undefined}
    onDoubleClick={(e) => e.stopPropagation()}
    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'none' }}
    onDrop={(e) => { e.preventDefault(); e.stopPropagation() }}>
    <div ref={barRef} className="cv-toolbar-bar material nodrag nopan" role="toolbar" aria-label="Công cụ canvas"
      aria-orientation={fit.vertical ? 'vertical' : 'horizontal'} data-orient={fit.vertical ? 'vertical' : 'horizontal'}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} onKeyDown={toolbarArrowKey} onFocus={rescue.onFocus} onBlur={rescue.onBlur}>
      <ToolbarButton className="cv-toolbar-button cv-toolbar-grip" label="Kéo để dời thanh · bấm để mở menu của thanh" data-grip tabIndex={0}
        aria-haspopup="menu" aria-expanded={menu?.label === MENU.place} aria-describedby="cv-toolbar-grip-help"
        onPointerDown={placement.start} onPointerMove={placement.move} onPointerUp={() => placement.finish(true)}
        onPointerCancel={() => placement.finish(false)} onLostPointerCapture={() => placement.finish(false)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); positionMenu() }}
        onClick={() => { if (Date.now() >= placement.suppressClick.current) positionMenu() }}
        onKeyDown={(e) => {
          if (e.key.startsWith('Arrow') || e.key === 'Home') {
            e.stopPropagation()
            e.preventDefault()
            useToolbarPrefs.getState().setPlace(nudgeToolbar(place, e.key, stage, e.shiftKey, e.altKey))
          }
        }}><GripVertical {...ICON} /></ToolbarButton>
      {fit.groups.map((group, index) => <Fragment key={group[0] ?? 'last'}>
        <span className="cv-toolbar-sep" aria-hidden />
        {group.map(slot)}
        {index === fit.groups.length - 1 && <ToolbarButton data-tool="more" className="cv-toolbar-button" label={MENU.more}
          aria-haspopup="menu" aria-expanded={menu?.label === MENU.more} onClick={moreMenu}>
          <MoreHorizontal {...ICON} />
        </ToolbarButton>}
      </Fragment>)}
    </div>
    {!dragging && <ToolbarTray anchor={rect} stage={stage} side={side} focusBar={focusMore} />}
    {menu && <ToolbarMenu key={menu.label} {...menu} anchor={rect} stage={stage} side={side} onClose={closeMenu} />}
    {arrangeOpen && !dragging && <Suspense fallback={null}><ArrangePopover anchor={arrangeAnchor() ?? document.body} side={POPOVER_SIDE[side]} onClose={closeArrange} /></Suspense>}
    <span className="cv-toolbar-sr" id="cv-toolbar-grip-help">{gripHelpText(IS_MAC)}</span>
    <span className="cv-toolbar-sr" role="status">{dragging ? '' : `Thanh công cụ: ${DOCK_LABELS[fit.dock]}.`}</span>
  </div>
})
