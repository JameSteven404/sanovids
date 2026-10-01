// The canvas board. Nodes and edges are DERIVED from the project store (scenes, assets, refs);
// React Flow is fully controlled: drag positions live in ui.dragPos until drag end (one undo step),
// selection is mirrored into ui.selectedIds / ui.selectedEdgeIds.
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useConnection,
  useReactFlow,
  useStoreApi,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type HandleType,
  type NodeChange,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type OnConnectStart,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { canvasEvents, createAssetsFromFiles, edgeId, linkAssets, newScene, parseEdgeId, type EdgeKind } from '../../actions'
import { sceneCode } from '../../core/compile'
import { MODELS } from '../../core/models'
import type { Asset, Scene, XY } from '../../core/types'
import { refImageCount, undo, useProject , undoToastAction } from '../../store/project'
import { useRuns } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { AssetNode, type AssetFlowNode } from './AssetNode'
import { CanvasToolbar, SelectionHint } from './CanvasToolbar'
import { ConnectMenu, type ConnectMenuState } from './ConnectMenu'
import { cutEdge, edgeTypes, type LinkEdge, type LinkEdgeData } from './edges'
import {
  assetMapOf,
  clientPoint,
  drawerInset,
  FIT_EVENT,
  hasAssetDrag,
  hasFileDrag,
  hitTest,
  imageFiles,
  keepHover,
  readAssetIds,
  sceneMapOf,
  scheduleHoverEnd,
  snap,
  sourceAssetsFor,
  STATUS_HEX,
  takeSummary,
  targetScenesFor,
  useCanvasLocal,
} from './canvasModel'
import { SceneNode, type SceneFlowNode } from './SceneNode'
import './canvas.css'

type CanvasNode = SceneFlowNode | AssetFlowNode

const nodeTypes = { scene: SceneNode, asset: AssetNode }
const SEQ_MARKER = { type: MarkerType.ArrowClosed, color: '#8d93a0', width: 14, height: 14 }
const SNAP_GRID: [number, number] = [16, 16]
const MULTI_KEYS = ['Control', 'Meta', 'Shift']
const FIT_OPTIONS = { padding: 0.12, maxZoom: 1 }
/** Toolbar band above the queue drawer (toolbar sits at drawer + 12px, ~44px tall). */
const TOOLBAR_ROOM = 56
/** Room kept below the ConnectMenu's top edge (tallest menu ≈ 3 items) so it stays above the queue drawer. */
const MENU_ROOM = 154

interface RawEdge {
  id: string
  kind: EdgeKind
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  index: number
  count: number
  color: string
}

export function CanvasView() {
  const projectId = useProject((s) => s.project.id)
  return (
    <div className="cv-root">
      <ReactFlowProvider key={projectId}>
        <CanvasInner />
      </ReactFlowProvider>
    </div>
  )
}

function CanvasInner() {
  const rf = useReactFlow<CanvasNode, LinkEdge>()
  const rfStore = useStoreApi<CanvasNode, LinkEdge>()
  const stageRef = useRef<HTMLDivElement>(null)

  const scenes = useProject((s) => s.project.scenes)
  const assets = useProject((s) => s.project.assets)
  const dragPos = useUI((s) => s.dragPos)
  const measured = useUI((s) => s.measured)
  const selectedIds = useUI((s) => s.selectedIds)
  const selectedEdgeIds = useUI((s) => s.selectedEdgeIds)
  const hoveredId = useUI((s) => s.hoveredId)
  const edgeMode = useUI((s) => s.edgeMode)
  const interaction = useUI((s) => s.interaction)
  const showMinimap = useUI((s) => s.showMinimap)
  const libraryDrag = useUI((s) => !!s.draggingAssetIds)
  const hoveredEdgeId = useCanvasLocal((s) => s.hoveredEdgeId)
  const connecting = useConnection((c) => (c.inProgress ? (c.fromNode.type === 'asset' ? 'asset' : 'scene') : null))
  const [menu, setMenu] = useState<ConnectMenuState | null>(null)

  // ---------------- derived nodes (cached per id so unchanged nodes keep their identity) ----------------
  const nodeCache = useRef(new Map<string, CanvasNode>())
  const dataCache = useRef(new Map<string, Record<string, unknown>>())
  const nodes = useMemo(() => {
    const prevCache = nodeCache.current
    const next = new Map<string, CanvasNode>()
    const sel = new Set(selectedIds)
    const out: CanvasNode[] = []
    const dataFor = (id: string) => {
      let d = dataCache.current.get(id)
      if (!d) {
        d = {}
        dataCache.current.set(id, d)
      }
      return d
    }
    const push = (id: string, type: 'scene' | 'asset', base: XY) => {
      const position = dragPos[id] ?? base
      const m = measured[id]
      const selected = sel.has(id)
      const dragging = id in dragPos
      const prev = prevCache.get(id)
      let node: CanvasNode
      if (prev && prev.type === type && prev.position === position && prev.selected === selected && prev.measured === m && prev.dragging === dragging) {
        node = prev
      } else {
        node = { id, type, position, data: dataFor(id), selected, dragging, measured: m } as CanvasNode
      }
      next.set(id, node)
      out.push(node)
    }
    for (const a of assets) if (a.position) push(a.id, 'asset', a.position)
    for (const s of scenes) push(s.id, 'scene', s.position)
    nodeCache.current = next
    return out
  }, [scenes, assets, dragPos, measured, selectedIds])

  // ---------------- derived edges ----------------
  const rawEdges = useMemo(() => buildRawEdges(scenes, assets), [scenes, assets])
  const edgeCache = useRef(new Map<string, LinkEdge>())
  const edges = useMemo(() => {
    const sel = new Set(selectedIds)
    const selEdges = new Set(selectedEdgeIds)
    const prevCache = edgeCache.current
    const next = new Map<string, LinkEdge>()
    const out: LinkEdge[] = []
    for (const r of rawEdges) {
      const touchesHover = !!hoveredId && (r.source === hoveredId || r.target === hoveredId)
      const touchesSel = sel.has(r.source) || sel.has(r.target)
      const isSel = selEdges.has(r.id)
      const isHover = hoveredEdgeId === r.id
      const visible = edgeMode === 'all' || touchesHover || isSel || isHover || (edgeMode === 'selected' && touchesSel)
      if (!visible) continue
      const highlight = touchesHover || touchesSel || isSel || isHover
      const prev = prevCache.get(r.id)
      const d = prev?.data
      let edge: LinkEdge
      if (prev && d && prev.selected === isSel && d.highlight === highlight && d.index === r.index && d.count === r.count && d.color === r.color) {
        edge = prev
      } else {
        const data: LinkEdgeData = { kind: r.kind, index: r.index, count: r.count, color: r.color, highlight }
        edge = {
          id: r.id,
          type: r.kind,
          source: r.source,
          target: r.target,
          sourceHandle: r.sourceHandle,
          targetHandle: r.targetHandle,
          selected: isSel,
          reconnectable: r.kind === 'ref' ? 'target' : false,
          markerEnd: r.kind === 'seq' ? SEQ_MARKER : undefined,
          data,
        }
      }
      next.set(r.id, edge)
      out.push(edge)
    }
    edgeCache.current = next
    return out
  }, [rawEdges, selectedIds, selectedEdgeIds, hoveredId, hoveredEdgeId, edgeMode])

  // Wire selection must only hold wires that exist on the canvas. React Flow can only deselect wires it renders, so a
  // wire that vanished (asset taken off the canvas, ref removed elsewhere, undo…) would stay selected and be cut by Delete.
  useEffect(() => {
    const ui = useUI.getState()
    if (!ui.selectedEdgeIds.length) return
    const live = new Set(rawEdges.map((r) => r.id))
    const kept = ui.selectedEdgeIds.filter((id) => live.has(id))
    if (kept.length !== ui.selectedEdgeIds.length) ui.setSelectedEdges(kept)
  }, [rawEdges])

  // Node selection changed outside React Flow (N, Ctrl+A, Inspector / queue "Đi tới cảnh", drops…): drop the wire
  // selection too, like a plain click on a node does. Wires are canvas-only, so leaving the canvas clears them as well.
  const rfSelecting = useRef(false)
  useEffect(() => {
    const unsub = useUI.subscribe((s, prev) => {
      if (s.selectedIds === prev.selectedIds || rfSelecting.current || !s.selectedEdgeIds.length) return
      s.setSelectedEdges([])
    })
    return () => {
      unsub()
      const ui = useUI.getState()
      if (ui.selectedEdgeIds.length) ui.setSelectedEdges([])
    }
  }, [])

  // Dim everything not connected to the hovered node (pure CSS, no node churn).
  const dimCss = useMemo(() => {
    if (!hoveredId || connecting || libraryDrag) return ''
    const lit = new Set([hoveredId])
    for (const r of rawEdges) {
      if (r.source === hoveredId) lit.add(r.target)
      else if (r.target === hoveredId) lit.add(r.source)
    }
    if (lit.size < 2) return ''
    const nots = [...lit].map((id) => `:not([data-id="${id.replace(/"/g, '')}"])`).join('')
    return `.cv-stage .react-flow__node${nots}{opacity:.38}`
  }, [hoveredId, rawEdges, connecting, libraryDrag])

  // ---------------- React Flow change handlers ----------------
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const ui = useUI.getState()
    const dims: Record<string, { width: number; height: number }> = {}
    const drag: Record<string, XY> = {}
    const commit: Record<string, XY> = {}
    let sel: Set<string> | null = null
    for (const c of changes) {
      if (c.type === 'dimensions') {
        if (c.dimensions) dims[c.id] = { width: c.dimensions.width, height: c.dimensions.height }
      } else if (c.type === 'position') {
        if (!c.position) continue
        if (c.dragging) drag[c.id] = c.position
        else commit[c.id] = c.position
      } else if (c.type === 'select') {
        sel ??= new Set(ui.selectedIds)
        if (c.selected) sel.add(c.id)
        else sel.delete(c.id)
      }
      // 'remove' / 'add' / 'replace' are ignored: deletion goes through actions.deleteSelection.
    }
    if (Object.keys(dims).length) {
      useUI.setState((s) => {
        let changed = false
        const m = { ...s.measured }
        for (const [id, d] of Object.entries(dims)) {
          const cur = m[id]
          if (!cur || cur.width !== d.width || cur.height !== d.height) {
            m[id] = d
            changed = true
          }
        }
        return changed ? { measured: m } : s
      })
    }
    if (Object.keys(drag).length) ui.setDragPos(drag)
    const commitIds = Object.keys(commit)
    if (commitIds.length) {
      const project = useProject.getState().project
      const sm = sceneMapOf(project.scenes)
      const am = assetMapOf(project.assets)
      const moved = commitIds.some((id) => {
        const cur = sm.get(id)?.position ?? am.get(id)?.position
        return !cur || cur.x !== commit[id].x || cur.y !== commit[id].y
      })
      if (moved) useProject.getState().setPositions(commit)
      ui.clearDragPos(commitIds)
    }
    if (sel) {
      const s = sel
      const prev = ui.selectedIds
      rfSelecting.current = true
      try {
        ui.select([...prev.filter((id) => s.has(id)), ...[...s].filter((id) => !prev.includes(id))])
      } finally {
        rfSelecting.current = false
      }
    }
  }, [])

  const onEdgesChange = useCallback(
    (changes: EdgeChange<LinkEdge>[]) => {
      const ui = useUI.getState()
      // Box selection also selects every wire touching a boxed node (even ones leaving the box): accept wire
      // selection only from explicit clicks, otherwise Delete would cut refs / continuity outside the box.
      const { userSelectionActive, userSelectionRect } = rfStore.getState()
      const boxing = userSelectionActive || !!userSelectionRect
      let sel: Set<string> | null = null
      for (const c of changes) {
        if (c.type !== 'select' || (c.selected && boxing)) continue
        sel ??= new Set(ui.selectedEdgeIds)
        if (c.selected) sel.add(c.id)
        else sel.delete(c.id)
      }
      if (sel) ui.setSelectedEdges([...sel])
    },
    [rfStore],
  )

  // ---------------- connecting ----------------
  const handled = useRef(false)
  const reconnecting = useRef<{ done: boolean } | null>(null)

  const onConnectStart: OnConnectStart = useCallback(() => {
    handled.current = false
    setMenu(null)
  }, [])

  const onConnect = useCallback((c: Connection) => {
    handled.current = true
    connectNodes(c.source, c.target, c.targetHandle)
  }, [])

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (reconnecting.current) return
      if (handled.current) {
        handled.current = false
        return
      }
      const from = state.fromNode
      if (!from || state.fromHandle?.type !== 'source') return
      const pt = clientPoint(event)
      const hit = hitTest(pt.x, pt.y, stageRef.current)
      if (!hit) return
      if (hit.kind === 'node') {
        if (hit.id !== from.id && sceneMapOf(useProject.getState().project.scenes).has(hit.id)) connectNodes(from.id, hit.id, 'ref')
        return
      }
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      setMenu({
        x: Math.max(8, Math.min(pt.x - rect.left, rect.width - 300)),
        // Keep the whole menu above the queue drawer (it paints over the canvas, z-index 40 > menu 20).
        y: Math.max(8, Math.min(pt.y - rect.top, rect.height - drawerInset(stage) - MENU_ROOM)),
        flow: rf.screenToFlowPosition(pt),
        source: from.type === 'asset' ? { kind: 'asset', assetIds: sourceAssetsFor(from.id) } : { kind: 'scene', sceneId: from.id },
      })
    },
    [rf],
  )

  const isValidConnection = useCallback((c: LinkEdge | Connection) => {
    if (c.source === c.target) return false
    const p = useProject.getState().project
    const sm = sceneMapOf(p.scenes)
    const am = assetMapOf(p.assets)
    if (!sm.has(c.target)) return false
    const th = c.targetHandle ?? 'ref'
    if (am.has(c.source)) return th === 'ref' || th === 'first' || th === 'last'
    if (sm.has(c.source)) return th === 'ref'
    return false
  }, [])

  const onReconnectStart = useCallback((_e: ReactMouseEvent, _edge: LinkEdge, _h: HandleType) => {
    reconnecting.current = { done: false }
    setMenu(null)
  }, [])
  const onReconnect = useCallback((oldEdge: LinkEdge, c: Connection) => {
    if (reconnecting.current) reconnecting.current.done = true
    moveRefEdge(oldEdge.id, c.target)
  }, [])
  const onReconnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, edge: LinkEdge, _h: HandleType, _state: FinalConnectionState) => {
      const r = reconnecting.current
      reconnecting.current = null
      if (!r || r.done) return
      const pt = clientPoint(event)
      const hit = hitTest(pt.x, pt.y, stageRef.current)
      if (!hit) return
      if (hit.kind === 'node') {
        if (hit.id !== edge.target && sceneMapOf(useProject.getState().project.scenes).has(hit.id)) moveRefEdge(edge.id, hit.id)
        return
      }
      // Dropped on empty canvas: cut the wire.
      cutEdge(edge.id)
    },
    [],
  )

  // ---------------- hover ----------------
  const onNodeMouseEnter: NodeMouseHandler<CanvasNode> = useCallback((_e, node) => {
    keepHover()
    useUI.getState().setHovered(node.id)
  }, [])
  const onNodeMouseLeave: NodeMouseHandler<CanvasNode> = useCallback(() => {
    scheduleHoverEnd(() => useUI.getState().setHovered(null))
  }, [])
  const onEdgeMouseEnter: EdgeMouseHandler<LinkEdge> = useCallback((_e, edge) => {
    keepHover()
    useCanvasLocal.getState().setHoveredEdge(edge.id)
  }, [])
  const onEdgeMouseLeave: EdgeMouseHandler<LinkEdge> = useCallback(() => {
    scheduleHoverEnd(() => useUI.getState().setHovered(null), 180)
  }, [])
  useEffect(
    () => () => {
      keepHover()
      useCanvasLocal.getState().setHoveredEdge(null)
      useUI.getState().setHovered(null)
    },
    [],
  )

  // ---------------- focus / fit requests ----------------
  useEffect(() => {
    const run = (ids: string[], force: boolean) => {
      if (!ids.length) {
        void rf.fitView({ padding: 0.12, duration: 300, maxZoom: 1 })
        return
      }
      const present = ids.filter((id) => rf.getInternalNode(id))
      if (!present.length) return
      const stage = stageRef.current
      // The queue drawer (36px bar, 272px open) and the toolbar above it cover the bottom of the stage.
      const covered = drawerInset(stage) + TOOLBAR_ROOM
      if (!force && stage) {
        const b = rf.getNodesBounds(present)
        const rect = stage.getBoundingClientRect()
        const tl = rf.screenToFlowPosition({ x: rect.left, y: rect.top })
        const br = rf.screenToFlowPosition({ x: rect.right, y: rect.bottom - covered })
        if (b.x >= tl.x && b.y >= tl.y && b.x + b.width <= br.x && b.y + b.height <= br.y) return
      }
      const zoom = rf.getZoom()
      // Same 0.25 padding as before on top/sides; the bottom also keeps the covered band clear.
      const h = stage?.clientHeight ?? 0
      const padding = { x: 0.25, top: 0.25, bottom: `${Math.round(covered + h * 0.1)}px` as const }
      void rf.fitView({ nodes: present.map((id) => ({ id })), padding, duration: 300, maxZoom: force ? 1.2 : Math.max(zoom, 0.8) })
    }
    const onFocus = (e: Event) => {
      const ids = ((e as CustomEvent<string[]>).detail ?? []).slice()
      setTimeout(() => run(ids, false), 60)
    }
    const onFit = (e: Event) => {
      const ids = ((e as CustomEvent<string[]>).detail ?? []).slice()
      setTimeout(() => run(ids, true), 30)
    }
    canvasEvents.addEventListener('focus', onFocus)
    canvasEvents.addEventListener(FIT_EVENT, onFit)
    return () => {
      canvasEvents.removeEventListener('focus', onFocus)
      canvasEvents.removeEventListener(FIT_EVENT, onFit)
    }
  }, [rf])

  // ---------------- pane gestures: double-click to create, drop from library / OS ----------------
  const onDoubleClick = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains('react-flow__pane')) return
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    newScene({ x: snap(p.x - 140), y: snap(p.y - 40) })
  }

  const onDragOver = (e: DragEvent) => {
    if (!hasAssetDrag(e.dataTransfer) && !hasFileDrag(e.dataTransfer)) return
    e.preventDefault()
  }
  const onDrop = (e: DragEvent) => {
    if (!hasAssetDrag(e.dataTransfer) && !hasFileDrag(e.dataTransfer)) return
    e.preventDefault()
    useUI.getState().setDraggingAssets(null)
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const base = { x: snap(p.x - 90), y: snap(p.y - 100) }
    const ids = readAssetIds(e.dataTransfer)
    if (ids && ids.length) {
      const map = assetMapOf(useProject.getState().project.assets)
      const valid = ids.filter((id) => map.has(id))
      useProject.getState().setAssetsOnCanvas(Object.fromEntries(valid.map((id, i) => [id, { x: base.x + i * 208, y: base.y }])))
      if (valid.length) {
        useUI.getState().select(valid)
        toast(`Đã đặt ${valid.length} mục lên canvas — kéo chấm bên phải vào cảnh để nối.`, { tone: 'success' })
      }
      return
    }
    const files = imageFiles(e.dataTransfer)
    if (files.length) void createAssetsFromFiles(files, { position: base })
  }

  const onPaneClick = useCallback(() => setMenu(null), [])
  const closeMenu = useCallback(() => setMenu(null), [])

  const handMode = interaction === 'hand'
  const stageCls = ['cv-stage', handMode ? 'mode-hand' : 'mode-select', connecting && `cv-connecting cv-connecting-${connecting}`, libraryDrag && 'cv-library-drag']
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={stageRef} className={stageCls} onDoubleClick={onDoubleClick} onDragOver={onDragOver} onDrop={onDrop}>
      {dimCss && <style>{dimCss}</style>}
      <ReactFlow<CanvasNode, LinkEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnectStart={onConnectStart}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        edgesReconnectable
        onReconnectStart={onReconnectStart}
        onReconnect={onReconnect}
        onReconnectEnd={onReconnectEnd}
        reconnectRadius={14}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={onEdgeMouseLeave}
        onPaneClick={onPaneClick}
        onMoveStart={onPaneClick}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={MULTI_KEYS}
        panActivationKeyCode="Space"
        panOnDrag={handMode ? true : [1]}
        selectionOnDrag={!handMode}
        selectionMode={SelectionMode.Partial}
        zoomOnScroll
        zoomOnPinch
        panOnScroll={false}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={2}
        snapToGrid
        snapGrid={SNAP_GRID}
        onlyRenderVisibleElements
        connectOnClick={false}
        connectionRadius={28}
        nodeDragThreshold={2}
        elevateEdgesOnSelect={false}
        fitView
        fitViewOptions={FIT_OPTIONS}
        colorMode="dark"
        attributionPosition="top-right"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="var(--border-strong)" />
        {showMinimap && (
          <MiniMap<CanvasNode>
            position="bottom-right"
            pannable
            zoomable
            nodeColor={minimapColor}
            nodeStrokeWidth={0}
            nodeBorderRadius={8}
            maskColor="rgba(8, 9, 11, 0.62)"
            bgColor="#15161a"
            ariaLabel="Bản đồ thu nhỏ"
          />
        )}
      </ReactFlow>
      <SelectionHint />
      <CanvasToolbar />
      {menu && <ConnectMenu menu={menu} onClose={closeMenu} />}
      {scenes.length === 0 && assets.every((a) => !a.position) && (
        <div className="cv-empty">
          <div className="cv-empty-title">Canvas trống</div>
          <div className="cv-empty-text">
            Bấm đúp vào nền để tạo cảnh · kéo nhân vật từ Thư viện vào đây · hoặc bấm <span className="kbd">N</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
function buildRawEdges(scenes: Scene[], assets: Asset[]): RawEdge[] {
  const onCanvas = new Map<string, Asset>()
  for (const a of assets) if (a.position) onCanvas.set(a.id, a)
  const sceneIds = new Set(scenes.map((s) => s.id))
  const out: RawEdge[] = []
  for (const s of scenes) {
    const refs = s.refs.filter((r) => onCanvas.has(r))
    refs.forEach((r, index) => {
      out.push({
        id: edgeId('ref', r, s.id),
        kind: 'ref',
        source: r,
        target: s.id,
        sourceHandle: 'out',
        targetHandle: 'ref',
        index,
        count: refs.length,
        color: onCanvas.get(r)!.color,
      })
    })
    if (s.continueFrom && sceneIds.has(s.continueFrom)) {
      out.push({
        id: edgeId('seq', s.continueFrom, s.id),
        kind: 'seq',
        source: s.continueFrom,
        target: s.id,
        sourceHandle: 'seq',
        targetHandle: 'ref',
        index: 0,
        count: 1,
        color: '#8d93a0',
      })
    }
    if (s.settings.mode === 'transform') {
      for (const which of ['first', 'last'] as const) {
        const aid = which === 'first' ? s.firstFrame : s.lastFrame
        if (!aid || !onCanvas.has(aid)) continue
        out.push({
          id: edgeId(which, aid, s.id),
          kind: which,
          source: aid,
          target: s.id,
          sourceHandle: 'out',
          targetHandle: which,
          index: 0,
          count: 1,
          color: which === 'first' ? '#4cc38a' : '#b48cff',
        })
      }
    }
  }
  return out
}

/** Apply a finished connection gesture. `targetHandle` decides ref vs first/last frame. */
function connectNodes(source: string, target: string, targetHandle: string | null | undefined) {
  const project = useProject.getState().project
  const sm = sceneMapOf(project.scenes)
  const am = assetMapOf(project.assets)
  const targetScene = sm.get(target)
  if (!targetScene || source === target) return
  const asset = am.get(source)
  if (asset) {
    if (targetHandle === 'first' || targetHandle === 'last') {
      useProject.getState().setFrame(target, targetHandle, source)
      toast(`@${asset.tag} → ${targetHandle === 'first' ? 'khung đầu' : 'khung cuối'} của ${sceneCode(targetScene.order)}.`, {
        tone: 'success',
        action: undoToastAction(),
      })
      return
    }
    linkAssets(targetScenesFor(target), sourceAssetsFor(source))
    return
  }
  const from = sm.get(source)
  if (!from) return
  if (targetScene.continueFrom === source) {
    toast(`${sceneCode(targetScene.order)} đã nối tiếp sau ${sceneCode(from.order)}.`, { tone: 'info' })
    return
  }
  const ok = useProject.getState().setContinueFrom(target, source)
  if (!ok) {
    toast('Không nối được: chuỗi cảnh sẽ bị vòng lặp.', { tone: 'warning' })
    return
  }
  toast(`${sceneCode(targetScene.order)} nối tiếp sau ${sceneCode(from.order)}.`, { tone: 'success', action: undoToastAction() })
}

/** Move a reference wire to another scene (reconnect gesture). */
function moveRefEdge(id: string, newTarget: string) {
  const e = parseEdgeId(id)
  if (!e || e.kind !== 'ref' || e.to === newTarget) return
  const project = useProject.getState().project
  const target = sceneMapOf(project.scenes).get(newTarget)
  const asset = assetMapOf(project.assets).get(e.from)
  if (!target || !asset) return
  const already = target.refs.includes(e.from)
  // Target at its image limit: refuse the move and keep the original link (nothing changes).
  if (!already && refImageCount(project, [...target.refs, e.from]) > MODELS[target.settings.model].maxRefImages) {
    toast(`Không chuyển được @${asset.tag} sang ${sceneCode(target.order)} (vượt giới hạn ảnh) — giữ nguyên nối cũ.`, { tone: 'warning' })
    return
  }
  useProject.getState().moveRefToScene(e.from, e.to, newTarget)
  const after = sceneMapOf(useProject.getState().project.scenes).get(newTarget)
  const added = !!after?.refs.includes(e.from)
  useUI.getState().setSelectedEdges([])
  toast(
    already
      ? `${sceneCode(target.order)} đã có @${asset.tag} — bỏ nối ở cảnh cũ.`
      : added
        ? `Đã chuyển @${asset.tag} sang ${sceneCode(target.order)}.`
        : `Không thêm được @${asset.tag} vào ${sceneCode(target.order)} (vượt giới hạn ảnh).`,
    { tone: added || already ? 'success' : 'warning', action: undoToastAction() },
  )
}

function minimapColor(node: CanvasNode): string {
  if (node.type === 'asset') return assetMapOf(useProject.getState().project.assets).get(node.id)?.color ?? '#6d7179'
  const st = takeSummary(useRuns.getState().takes, node.id).status
  return st ? STATUS_HEX[st] : '#3b3f47'
}
