// The canvas board. Nodes and edges are DERIVED from the stores: scenes and on-canvas assets (project store) and
// takes = video nodes (runs store). React Flow is fully controlled: drag positions live in ui.dragPos until drag end
// (scenes/assets: one undo step in the project; takes: runs.setTakePositions, not undoable), selection is mirrored
// into ui.selectedIds / ui.selectedEdgeIds.
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useConnection,
  useReactFlow,
  useStoreApi,
  type Connection,
  type EdgeChange,
  type EdgeMouseHandler,
  type FinalConnectionState,
  type HandleType,
  type NodeChange,
  type NodeMouseHandler,
  type OnConnectStart,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { canvasEvents, createAssetsFromFiles, edgeId, linkAssets, linkTakes, newScene, parseEdgeId, takeLabel, type EdgeKind } from '../../actions'
import { sceneCode } from '../../core/compile'
import { MODELS } from '../../core/models'
import type { Asset, Scene, XY } from '../../core/types'
import { defaultTakePosition, refImageCount, undo, undoToastAction, useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { AssetNode, type AssetFlowNode } from './AssetNode'
import { CanvasToolbar, SelectionHint } from './CanvasToolbar'
import { ConnectMenu, type ConnectMenuState } from './ConnectMenu'
import { cutEdge, edgeTypes, VIDEO_COLOR, type LinkEdge, type LinkEdgeData } from './edges'
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
  layoutTakes,
  readAssetIds,
  sceneMapOf,
  scheduleHoverEnd,
  snap,
  sourceAssetsFor,
  sourceTakesFor,
  STATUS_HEX,
  takeIndexOf,
  takeLayoutSig,
  targetScenesFor,
  useCanvasLocal,
  type TakeLayout,
} from './canvasModel'
import { SceneNode, type SceneFlowNode } from './SceneNode'
import { TakeNode, type TakeFlowNode, type TakeNodeData } from './TakeNode'
import './canvas.css'

type CanvasNode = SceneFlowNode | AssetFlowNode | TakeFlowNode
type NodeType = CanvasNode['type'] & string

const nodeTypes = { scene: SceneNode, asset: AssetNode, take: TakeNode }
const SNAP_GRID: [number, number] = [16, 16]
const MULTI_KEYS = ['Control', 'Meta', 'Shift']
const FIT_OPTIONS = { padding: 0.12, maxZoom: 1 }
/** Toolbar band above the queue drawer (toolbar sits at drawer + 12px, ~44px tall). */
const TOOLBAR_ROOM = 56
/** Room kept below the ConnectMenu's top edge (tallest menu ≈ 3 items) so it stays above the queue drawer. */
const MENU_ROOM = 154
const EMPTY_DATA: Record<string, unknown> = {}

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

const samePos = (a: XY | undefined, b: XY) => !!a && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5

function CanvasInner() {
  const rf = useReactFlow<CanvasNode, LinkEdge>()
  const rfStore = useStoreApi<CanvasNode, LinkEdge>()
  const stageRef = useRef<HTMLDivElement>(null)

  const scenes = useProject((s) => s.project.scenes)
  const assets = useProject((s) => s.project.assets)
  // Only what the take nodes' layout/status depends on (not progress): a string, so render ticks don't rebuild the graph.
  const takeSig = useRuns((s) => takeLayoutSig(s.takes))
  const takeDisplay = useUI((s) => s.takeDisplay)
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
  const connecting = useConnection((c) => (c.inProgress ? `${c.fromNode.type ?? ''}|${c.fromNode.id}` : null))
  const connKind = connecting ? connecting.slice(0, connecting.indexOf('|')) : null
  const connFrom = connecting ? connecting.slice(connecting.indexOf('|') + 1) : null
  const [menu, setMenu] = useState<ConnectMenuState | null>(null)

  // ---------------- take nodes: which are shown, where ----------------
  // `takeSig` stands for the layout-relevant part of runs.takes (read fresh here).
  const takeLayout = useMemo(() => layoutTakes(useRuns.getState().takes, scenes, takeDisplay), [takeSig, scenes, takeDisplay])
  const layoutRef = useRef<TakeLayout>(takeLayout)
  layoutRef.current = takeLayout

  // ---------------- derived nodes (cached per id so unchanged nodes keep their identity) ----------------
  const nodeCache = useRef(new Map<string, CanvasNode>())
  const takeData = useRef(new Map<string, TakeNodeData>())
  const nodes = useMemo(() => {
    const prevCache = nodeCache.current
    const next = new Map<string, CanvasNode>()
    const sel = new Set(selectedIds)
    const out: CanvasNode[] = []
    const push = (id: string, type: NodeType, base: XY, data: Record<string, unknown>) => {
      const prev = prevCache.get(id)
      let position = dragPos[id] ?? base
      if (prev && samePos(prev.position, position)) position = prev.position
      const m = measured[id]
      const selected = sel.has(id)
      const dragging = id in dragPos
      let node: CanvasNode
      if (prev && prev.type === type && prev.position === position && prev.selected === selected && prev.measured === m && prev.dragging === dragging && prev.data === data) {
        node = prev
      } else {
        node = { id, type, position, data, selected, dragging, measured: m } as CanvasNode
      }
      next.set(id, node)
      out.push(node)
    }
    for (const a of assets) if (a.position) push(a.id, 'asset', a.position, EMPTY_DATA)
    for (const s of scenes) push(s.id, 'scene', s.position, EMPTY_DATA)
    const sm = sceneMapOf(scenes)
    const dataNext = new Map<string, TakeNodeData>()
    for (const item of takeLayout.items) {
      const scene = sm.get(item.sceneId)!
      // Auto-placed takes follow their scene live while it is dragged.
      const base = item.explicit ?? defaultTakePosition(dragPos[scene.id] ?? scene.position, item.index)
      let data = takeData.current.get(item.id)
      if (!data || data.hidden !== item.hidden || data.status !== item.status) data = { hidden: item.hidden, status: item.status }
      dataNext.set(item.id, data)
      push(item.id, 'take', base, data)
    }
    takeData.current = dataNext
    nodeCache.current = next
    return out
  }, [scenes, assets, takeLayout, dragPos, measured, selectedIds])

  // ---------------- derived edges ----------------
  const rawEdges = useMemo(() => buildRawEdges(scenes, assets, takeLayout), [scenes, assets, takeLayout])
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
      // Scene → take wires are shown with their scene/take whenever it is selected or hovered, whatever the mode.
      const visible = edgeMode === 'all' || touchesHover || isSel || isHover || ((edgeMode === 'selected' || r.kind === 'out') && touchesSel)
      if (!visible) continue
      const highlight = touchesHover || touchesSel || isSel || isHover
      const prev = prevCache.get(r.id)
      const d = prev?.data
      let edge: LinkEdge
      if (prev && d && prev.selected === isSel && d.highlight === highlight && d.index === r.index && d.count === r.count && d.color === r.color) {
        edge = prev
      } else {
        const data: LinkEdgeData = { kind: r.kind, index: r.index, count: r.count, color: r.color, highlight }
        const isOut = r.kind === 'out'
        edge = {
          id: r.id,
          type: r.kind,
          source: r.source,
          target: r.target,
          sourceHandle: r.sourceHandle,
          targetHandle: r.targetHandle,
          selected: isSel,
          selectable: !isOut,
          deletable: !isOut,
          focusable: !isOut,
          reconnectable: r.kind === 'ref' || r.kind === 'vref' ? 'target' : false,
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

  // Same for take nodes hidden by "Chỉ take chọn": a hidden take must not stay selected (Delete would remove it).
  useEffect(() => {
    const ui = useUI.getState()
    if (!ui.selectedIds.length) return
    const all = takeIndexOf(useRuns.getState().takes).byId
    const kept = ui.selectedIds.filter((id) => !all.has(id) || takeLayout.byId.has(id))
    if (kept.length !== ui.selectedIds.length) ui.select(kept)
  }, [takeLayout])

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
    const nots = [...lit].map((id) => `:not([data-id="${cssId(id)}"])`).join('')
    return `.cv-stage .react-flow__node${nots}{opacity:.38}`
  }, [hoveredId, rawEdges, connecting, libraryDrag])

  // While wiring a take, its own scene is not a valid target (a scene cannot reference its own video).
  const ownSceneCss = useMemo(() => {
    if (connKind !== 'take' || !connFrom) return ''
    const sceneId = takeIndexOf(useRuns.getState().takes).byId.get(connFrom)?.sceneId
    if (!sceneId) return ''
    const sel = `.cv-stage .react-flow__node[data-id="${cssId(sceneId)}"] .cv-scene`
    return `${sel}{box-shadow:none!important;border-color:var(--border-strong)!important;opacity:.55}${sel} .cv-conn-hint{display:none!important}`
  }, [connKind, connFrom])

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

    // An auto-placed take dragged together with its scene just follows the scene (stays auto-placed).
    const layout = layoutRef.current
    const commitIds = Object.keys(commit)
    const movingIds = Object.keys(drag).concat(commitIds)
    if (movingIds.length) {
      const moving = new Set(movingIds)
      for (const id of movingIds) {
        const item = layout.byId.get(id)
        if (item && !item.explicit && moving.has(item.sceneId)) {
          delete drag[id]
          delete commit[id]
        }
      }
    }
    if (Object.keys(drag).length) ui.setDragPos(drag)
    if (commitIds.length) {
      const project = useProject.getState().project
      const sm = sceneMapOf(project.scenes)
      const am = assetMapOf(project.assets)
      const takes = takeIndexOf(useRuns.getState().takes).byId
      const projectCommit: Record<string, XY> = {}
      const takeCommit: Record<string, XY | null> = {}
      let projectMoved = false
      let takesMoved = false
      for (const [id, pos] of Object.entries(commit)) {
        const item = layout.byId.get(id)
        if (item) {
          const scene = sm.get(item.sceneId)
          const take = takes.get(id)
          if (!scene || !take) continue
          // Dropped exactly on its auto slot: keep it auto-placed (it keeps following the scene).
          const auto = defaultTakePosition(commit[scene.id] ?? scene.position, item.index)
          const next = samePos(auto, pos) ? null : pos
          takeCommit[id] = next
          if (!(next === null ? take.position === null : samePos(take.position ?? undefined, next))) takesMoved = true
        } else {
          projectCommit[id] = pos
          const cur = sm.get(id)?.position ?? am.get(id)?.position
          if (!samePos(cur ?? undefined, pos)) projectMoved = true
        }
      }
      if (projectMoved) useProject.getState().setPositions(projectCommit)
      if (takesMoved) useRuns.getState().setTakePositions(takeCommit)
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
      // selection only from explicit clicks, otherwise Delete would cut references outside the box.
      const { userSelectionActive, userSelectionRect } = rfStore.getState()
      const boxing = userSelectionActive || !!userSelectionRect
      let sel: Set<string> | null = null
      for (const c of changes) {
        if (c.type !== 'select' || (c.selected && boxing)) continue
        if (c.selected && parseEdgeId(c.id)?.kind === 'out') continue
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
      if (from.type !== 'asset' && from.type !== 'take') return
      const pt = clientPoint(event)
      const hit = hitTest(pt.x, pt.y, stageRef.current)
      if (!hit) return
      if (hit.kind === 'node') {
        // Released anywhere over a scene card (not only on its handle).
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
        source: from.type === 'asset' ? { kind: 'asset', assetIds: sourceAssetsFor(from.id) } : { kind: 'take', takeId: from.id, takeIds: sourceTakesFor(from.id) },
      })
    },
    [rf],
  )

  const isValidConnection = useCallback((c: LinkEdge | Connection) => {
    if (c.source === c.target) return false
    const p = useProject.getState().project
    if (!sceneMapOf(p.scenes).has(c.target)) return false
    const th = c.targetHandle ?? 'ref'
    if (assetMapOf(p.assets).has(c.source)) return th === 'ref' || th === 'first' || th === 'last'
    const take = takeIndexOf(useRuns.getState().takes).byId.get(c.source)
    if (take) return th === 'ref' && take.status === 'completed' && take.sceneId !== c.target
    return false
  }, [])

  const onReconnectStart = useCallback((_e: ReactMouseEvent, _edge: LinkEdge, _h: HandleType) => {
    reconnecting.current = { done: false }
    setMenu(null)
  }, [])
  const onReconnect = useCallback((oldEdge: LinkEdge, c: Connection) => {
    if (reconnecting.current) reconnecting.current.done = true
    moveEdge(oldEdge.id, c.target)
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
        if (hit.id !== edge.target && sceneMapOf(useProject.getState().project.scenes).has(hit.id)) moveEdge(edge.id, hit.id)
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
    if (edge.type === 'out') return
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
  const stageCls = ['cv-stage', handMode ? 'mode-hand' : 'mode-select', connKind && `cv-connecting cv-connecting-${connKind}`, libraryDrag && 'cv-library-drag']
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={stageRef} className={stageCls} onDoubleClick={onDoubleClick} onDragOver={onDragOver} onDrop={onDrop}>
      {(dimCss || ownSceneCss) && <style>{dimCss + ownSceneCss}</style>}
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

const cssId = (id: string) => id.replace(/["\\]/g, '')

// ---------------------------------------------------------------------------------------------
/** Every wire that can be drawn (visibility by edge mode is decided later). Only wires between shown nodes. */
function buildRawEdges(scenes: Scene[], assets: Asset[], takes: TakeLayout): RawEdge[] {
  const onCanvas = new Map<string, Asset>()
  for (const a of assets) if (a.position) onCanvas.set(a.id, a)
  const out: RawEdge[] = []
  for (const s of scenes) {
    // Image refs and video refs both arrive at the left 'ref' handle: spread them together.
    const incoming: RawEdge[] = []
    for (const r of s.refs) {
      const a = onCanvas.get(r)
      if (!a) continue
      incoming.push({ id: edgeId('ref', r, s.id), kind: 'ref', source: r, target: s.id, sourceHandle: 'out', targetHandle: 'ref', index: 0, count: 0, color: a.color })
    }
    for (const t of s.videoRefs) {
      if (!takes.byId.has(t)) continue
      incoming.push({ id: edgeId('vref', t, s.id), kind: 'vref', source: t, target: s.id, sourceHandle: 'out', targetHandle: 'ref', index: 0, count: 0, color: VIDEO_COLOR })
    }
    incoming.forEach((e, index) => {
      e.index = index
      e.count = incoming.length
      out.push(e)
    })
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
  for (const item of takes.items) {
    out.push({
      id: edgeId('out', item.sceneId, item.id),
      kind: 'out',
      source: item.sceneId,
      target: item.id,
      sourceHandle: 'take',
      targetHandle: 'in',
      index: 0,
      count: 1,
      color: '#6d7179',
    })
  }
  return out
}

/** Apply a finished connection gesture. Asset: `targetHandle` decides ref vs first/last frame. Take: @video ref. */
function connectNodes(source: string, target: string, targetHandle: string | null | undefined) {
  const project = useProject.getState().project
  const targetScene = sceneMapOf(project.scenes).get(target)
  if (!targetScene || source === target) return
  const asset = assetMapOf(project.assets).get(source)
  if (asset) {
    if (targetHandle === 'first' || targetHandle === 'last') {
      useProject.getState().setFrame(target, targetHandle, source)
      toast(`${asset.name} → ${targetHandle === 'first' ? 'khung đầu' : 'khung cuối'} của ${sceneCode(targetScene.order)}.`, {
        tone: 'success',
        action: undoToastAction(),
      })
      return
    }
    linkAssets(targetScenesFor(target), sourceAssetsFor(source))
    return
  }
  const take = takeIndexOf(useRuns.getState().takes).byId.get(source)
  if (!take) return
  if (take.status !== 'completed') {
    toast('Video chưa tạo xong.', { tone: 'warning' })
    return
  }
  // linkTakes checks readiness, own-scene loops and model limits, and reports.
  linkTakes(targetScenesFor(target), sourceTakesFor(source))
}

/** Reconnect gesture: move an image or video reference wire to another scene. */
function moveEdge(id: string, newTarget: string) {
  const e = parseEdgeId(id)
  if (!e || e.to === newTarget) return
  if (e.kind === 'ref') moveRefEdge(e.from, e.to, newTarget)
  else if (e.kind === 'vref') moveVideoEdge(e.from, e.to, newTarget)
}

function moveRefEdge(assetId: string, fromSceneId: string, newTarget: string) {
  const project = useProject.getState().project
  const target = sceneMapOf(project.scenes).get(newTarget)
  const asset = assetMapOf(project.assets).get(assetId)
  if (!target || !asset) return
  const already = target.refs.includes(assetId)
  // Target at its image limit: refuse the move and keep the original link (nothing changes).
  if (!already && refImageCount(project, [...target.refs, assetId]) > MODELS[target.settings.model].maxRefImages) {
    toast(`Không chuyển được ${asset.name} sang ${sceneCode(target.order)} (vượt giới hạn ảnh) — giữ nguyên nối cũ.`, { tone: 'warning' })
    return
  }
  useProject.getState().moveRefToScene(assetId, fromSceneId, newTarget)
  const after = sceneMapOf(useProject.getState().project.scenes).get(newTarget)
  const added = !!after?.refs.includes(assetId)
  useUI.getState().setSelectedEdges([])
  toast(
    already
      ? `${sceneCode(target.order)} đã có ${asset.name} — bỏ nối ở cảnh cũ.`
      : added
        ? `Đã chuyển ${asset.name} sang ${sceneCode(target.order)}.`
        : `Không thêm được ${asset.name} vào ${sceneCode(target.order)} (vượt giới hạn ảnh).`,
    { tone: added || already ? 'success' : 'warning', action: undoToastAction() },
  )
}

/** Move a @video reference: add it to the new scene first (may be refused), then drop it from the old one. */
function moveVideoEdge(takeId: string, fromSceneId: string, newTarget: string) {
  const take = takeIndexOf(useRuns.getState().takes).byId.get(takeId)
  const target = sceneMapOf(useProject.getState().project.scenes).get(newTarget)
  if (!take || !target) return
  const label = takeLabel(takeId)
  if (take.sceneId === newTarget) {
    toast('Không thể dùng video của chính cảnh này làm tham chiếu cho nó — giữ nguyên nối cũ.', { tone: 'warning' })
    return
  }
  const already = target.videoRefs.includes(takeId)
  if (!already) {
    const res = useProject.getState().addVideoRefs([newTarget], [takeId])
    if (!res.added) {
      toast(`${sceneCode(target.order)} không nhận thêm video tham chiếu (model/chế độ) — giữ nguyên nối cũ.`, { tone: 'warning' })
      return
    }
  }
  useProject.getState().removeVideoRef(fromSceneId, takeId, 'video ' + label)
  useUI.getState().setSelectedEdges([])
  // Two history steps (add + remove): the toast undoes both, if nothing changed since.
  const after = useProject.getState().project
  toast(already ? `${sceneCode(target.order)} đã có ${label} — bỏ nối ở cảnh cũ.` : `Đã chuyển ${label} sang ${sceneCode(target.order)}.`, {
    tone: 'success',
    action: {
      label: 'Hoàn tác',
      run: () => {
        if (useProject.getState().project !== after) {
          toast('Không hoàn tác được từ đây: đã có thay đổi mới hơn. Dùng Ctrl+Z để lùi từng bước.', { tone: 'warning' })
          return
        }
        undo()
        if (!already) undo()
      },
    },
  })
}

function minimapColor(node: CanvasNode): string {
  if (node.type === 'asset') return assetMapOf(useProject.getState().project.assets).get(node.id)?.color ?? '#6d7179'
  if (node.type === 'take') {
    const st = takeIndexOf(useRuns.getState().takes).byId.get(node.id)?.status
    return st ? STATUS_HEX[st] : '#3b3f47'
  }
  return sceneMapOf(useProject.getState().project.scenes).get(node.id)?.color ?? '#5b606b'
}
