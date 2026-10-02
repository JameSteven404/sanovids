// The canvas board. Nodes and edges are DERIVED from the stores: scenes, on-canvas assets and folder nodes (project
// store) and takes = video nodes (runs store). React Flow is fully controlled: drag positions live in ui.dragPos until drag end
// (scenes/assets: one undo step in the project; takes: runs.setTakePositions, not undoable), selection is mirrored
// into ui.selectedIds / ui.selectedEdgeIds. Resize handles (NodeSizer): the live box lives in useCanvasLocal.resizing
// until resize end, then one commit (scenes/assets: project.setNodeSizes, one undo step; takes: runs.setTakeSizes).
// Wires: a plain click on one cuts it (pref clickToCut, onWireClick below); the line drawn while dragging a wire and the
// cut animation live in Wires.tsx.
import {
  Background,
  BackgroundVariant,
  getViewportForBounds,
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
import { Clapperboard, Plus } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  canvasEvents,
  createAssetsFromFiles,
  createSceneFromTake,
  edgeId,
  linkAssets,
  linkTakes,
  newScene,
  nextScene,
  parseEdgeId,
  REVEAL_EVENT,
  setCanvasViewSource,
  takeLabel,
  videoLabel,
  type EdgeKind,
} from '../../actions'
import { sceneCode } from '../../core/compile'
import { folderMapOf } from '../../core/folders'
import { MODELS, usesVideoRefs } from '../../core/models'
import { keepsSlot } from '../../core/takes'
import type { Asset, SaveFolder, Scene, Size, XY } from '../../core/types'
import { linkScenesToFolder, linkTakesToFolder } from '../../folderActions'
import { useCanvasPrefs, useMotionLevel } from '../../lib/canvasPrefs'
import { usePlayback } from '../../lib/playback'
import { useTheme } from '../../lib/theme'
import { LAYOUT, refImageCount, undoToastAction, useProject, type Box } from '../../store/project'
import { useRuns } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { AssetNode, type AssetFlowNode } from './AssetNode'
import { CanvasToolbar, SelectionHint } from './CanvasToolbar'
import { ConnectMenu, type ConnectMenuState } from './ConnectMenu'
import { cutEdge, edgeTypes, VIDEO_COLOR, type LinkEdge, type LinkEdgeData } from './edges'
import { FolderNode, type FolderFlowNode } from './FolderNode'
import {
  assetMapOf,
  assetNodeHeight,
  ASSET_DEFAULT_W,
  autoTakePosition,
  clientPoint,
  drawerInset,
  fallbackNodeSize,
  FIT_EVENT,
  focusViewport,
  gridPositions,
  hasAssetDrag,
  hasFileDrag,
  hasTakeDrag,
  hitTest,
  imageFiles,
  isAutoSlot,
  isEmptyCanvasTarget,
  keepHover,
  layoutTakes,
  MINIMAP_LIFT_W,
  orphanTakePosition,
  readAssetIds,
  readTakeIds,
  resetNodeSize,
  revealViewport,
  sceneMapOf,
  scheduleHoverEnd,
  selectionSeed,
  snap,
  sourceAssetsFor,
  sourceTakesFor,
  STATUS_COLOR,
  takeIndexOf,
  takeLayoutSig,
  takeSlots,
  targetScenesFor,
  toolbarDensity,
  unionBox,
  useCanvasLocal,
  visibleFlowRect,
  type ResizeBox,
  type StageSize,
  type TakeLayout,
  type ToolbarDensity,
} from './canvasModel'
import { SceneNode, type SceneFlowNode } from './SceneNode'
import { TakeNode, type TakeFlowNode, type TakeNodeData } from './TakeNode'
import { isWireClick, markFreshWires, newWireIds, wireClickAction, type WirePress } from './wireFx'
import { WireConnectionLine, WireCutLayer } from './Wires'
import './canvas.css'
import './wires.css'

type CanvasNode = SceneFlowNode | AssetFlowNode | TakeFlowNode | FolderFlowNode
type NodeType = CanvasNode['type'] & string

const nodeTypes = { scene: SceneNode, asset: AssetNode, take: TakeNode, folder: FolderNode }
const NO_FOLDERS: SaveFolder[] = []
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
const sceneWidth = (s: Scene, live?: ResizeBox) => live?.w ?? s.size?.w ?? LAYOUT.sceneW

function CanvasInner() {
  const rf = useReactFlow<CanvasNode, LinkEdge>()
  const rfStore = useStoreApi<CanvasNode, LinkEdge>()
  const stageRef = useRef<HTMLDivElement>(null)

  const scenes = useProject((s) => s.project.scenes)
  const assets = useProject((s) => s.project.assets)
  const folders = useProject((s) => s.project.folders ?? NO_FOLDERS)
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
  const takeDrag = useUI((s) => !!s.draggingTakeIds)
  const hoveredEdgeId = useCanvasLocal((s) => s.hoveredEdgeId)
  const resizing = useCanvasLocal((s) => s.resizing)
  const connecting = useConnection((c) => (c.inProgress ? `${c.fromNode.type ?? ''}|${c.fromNode.id}` : null))
  const connKind = connecting ? connecting.slice(0, connecting.indexOf('|')) : null
  const connFrom = connecting ? connecting.slice(connecting.indexOf('|') + 1) : null
  const [menu, setMenu] = useState<ConnectMenuState | null>(null)
  const theme = useTheme((s) => s.theme)
  const clickToCut = useCanvasPrefs((s) => s.clickToCut)
  const motion = useMotionLevel()

  // Canvas width → toolbar density (narrow center panel) and whether the minimap must sit above the toolbar.
  // Only the derived levels are state, so resizing a side panel does not re-render the board on every pixel.
  const [density, setDensity] = useState<ToolbarDensity>('full')
  const [liftMinimap, setLiftMinimap] = useState(false)
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const apply = (w: number) => {
      setDensity(toolbarDensity(w))
      setLiftMinimap(w > 0 && w < MINIMAP_LIFT_W)
    }
    apply(el.clientWidth)
    const ro = new ResizeObserver((entries) => apply(Math.round(entries[0]?.contentRect.width ?? el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---------------- take nodes: which are shown, where ----------------
  // `takeSig` stands for the layout-relevant part of runs.takes (read fresh here).
  const takeLayout = useMemo(() => layoutTakes(useRuns.getState().takes, scenes, takeDisplay), [takeSig, scenes, takeDisplay])
  const layoutRef = useRef<TakeLayout>(takeLayout)
  layoutRef.current = takeLayout

  // ---------------- derived nodes (cached per id so unchanged nodes keep their identity) ----------------
  const nodeCache = useRef(new Map<string, CanvasNode>())
  const takeData = useRef(new Map<string, TakeNodeData>())
  /** Row offset of each take (accumulated widths of the takes before it) and its current auto spot. */
  const slotsRef = useRef(new Map<string, number>())
  const autoRef = useRef(new Map<string, XY>())
  const nodes = useMemo(() => {
    const prevCache = nodeCache.current
    const next = new Map<string, CanvasNode>()
    const sel = new Set(selectedIds)
    const out: CanvasNode[] = []
    const push = (id: string, type: NodeType, base: XY, data: Record<string, unknown>, size: Size | null | undefined) => {
      const prev = prevCache.get(id)
      // A resize from the left / top edge moves the node live too.
      const live = resizing[id]
      let position = live && live.x !== undefined && live.y !== undefined ? { x: live.x, y: live.y } : (dragPos[id] ?? base)
      if (prev && samePos(prev.position, position)) position = prev.position
      const m = measured[id]
      const selected = sel.has(id)
      const dragging = id in dragPos
      // Stored (or live) size sizes the React Flow wrapper; the card fills it. No size = CSS default (auto height).
      const width = live?.w ?? size?.w
      const height = live?.h ?? size?.h
      let node: CanvasNode
      if (
        prev &&
        prev.type === type &&
        prev.position === position &&
        prev.selected === selected &&
        prev.measured === m &&
        prev.dragging === dragging &&
        prev.data === data &&
        prev.width === width &&
        prev.height === height
      ) {
        node = prev
      } else {
        node = { id, type, position, data, selected, dragging, measured: m, width, height } as CanvasNode
      }
      next.set(id, node)
      out.push(node)
    }
    for (const a of assets) if (a.position) push(a.id, 'asset', a.position, EMPTY_DATA, a.size)
    for (const f of folders) push(f.id, 'folder', f.position, EMPTY_DATA, null)
    for (const s of scenes) push(s.id, 'scene', s.position, EMPTY_DATA, s.size)
    const sm = sceneMapOf(scenes)
    const dataNext = new Map<string, TakeNodeData>()
    // Takes sit right of their scene's ACTUAL width, each after the summed widths of the takes in the row before it
    // (a take dragged away leaves the row; one only nudged on its slot keeps it).
    const widthOf = (id: string) => resizing[id]?.w ?? takeLayout.byId.get(id)?.size?.w ?? LAYOUT.takeW
    const slots = takeSlots(takeLayout.items, widthOf, (id, slotX) => {
      const item = takeLayout.byId.get(id)
      const anchor = item && sm.get(item.anchorId)
      if (!item?.explicit || !anchor) return false
      const slot = item.orphan
        ? orphanTakePosition(anchor.position, item.index, slotX, widthOf(id))
        : autoTakePosition(anchor.position, sceneWidth(anchor), slotX)
      return keepsSlot(item.explicit, slot, widthOf(id), item.size?.h ?? LAYOUT.takeH)
    })
    const autos = new Map<string, XY>()
    for (const item of takeLayout.items) {
      const anchor = sm.get(item.anchorId)!
      const slot = slots.get(item.id) ?? 0
      const live = resizing[anchor.id]
      const anchorPos = dragPos[anchor.id] ?? (live && live.x !== undefined && live.y !== undefined ? { x: live.x, y: live.y } : anchor.position)
      // Auto-placed takes follow their scene live while it is dragged or resized. An orphan (its scene was just
      // deleted) stays where it was shown; without a previous spot it goes next to the scene that uses it.
      const auto = item.orphan ? null : autoTakePosition(anchorPos, sceneWidth(anchor, live), slot)
      if (auto) autos.set(item.id, auto)
      const base =
        item.explicit ??
        auto ??
        prevCache.get(item.id)?.position ??
        orphanTakePosition(anchor.position, item.index, slot, item.size?.w ?? LAYOUT.takeW)
      let data = takeData.current.get(item.id)
      if (!data || data.hidden !== item.hidden || data.status !== item.status) data = { hidden: item.hidden, status: item.status }
      dataNext.set(item.id, data)
      push(item.id, 'take', base, data, item.size)
    }
    slotsRef.current = slots
    autoRef.current = autos
    takeData.current = dataNext
    nodeCache.current = next
    return out
  }, [scenes, assets, folders, takeLayout, dragPos, measured, selectedIds, resizing])

  // ---------------- derived edges ----------------
  // Wires that just appeared (a new link, the undo of a cut, a new take) draw themselves in once (wireFx). The first
  // build of a canvas (project opened) and big batches do not animate.
  const wireIds = useRef<Set<string> | null>(null)
  const rawEdges = useMemo(() => {
    const list = buildRawEdges(scenes, assets, takeLayout, folders)
    const ids = list.map((r) => r.id)
    const fresh = newWireIds(wireIds.current, ids)
    if (fresh.length) markFreshWires(fresh)
    wireIds.current = new Set(ids)
    return list
  }, [scenes, assets, takeLayout, folders])
  const edgeCache = useRef(new Map<string, LinkEdge>())
  const edges = useMemo(() => {
    const sel = new Set(selectedIds)
    const selEdges = new Set(selectedEdgeIds)
    const prevCache = edgeCache.current
    const next = new Map<string, LinkEdge>()
    const out: LinkEdge[] = []
    // Selected reference wires are drawn last, so their reconnect grip is on top of the other wires at the handle.
    const grabbable: LinkEdge[] = []
    for (const r of rawEdges) {
      const touchesHover = !!hoveredId && (r.source === hoveredId || r.target === hoveredId)
      const touchesSel = sel.has(r.source) || sel.has(r.target)
      const isSel = selEdges.has(r.id)
      const isHover = hoveredEdgeId === r.id
      // Scene → take wires are shown with their scene/take whenever it is selected or hovered, whatever the mode.
      const visible = edgeMode === 'all' || touchesHover || isSel || isHover || ((edgeMode === 'selected' || r.kind === 'out') && touchesSel)
      if (!visible) continue
      const highlight = touchesHover || touchesSel || isSel || isHover
      // React Flow puts every wire's reconnect grip at the same spot (the handle's center, not the spread-out end the
      // wire is drawn to), so with several wires at one handle the last-drawn one would always be the one moved.
      // Only a wire that is alone at its handle, or selected (clicked first), can be dragged by its end.
      const isRef = r.kind === 'ref' || r.kind === 'vref'
      const reconnectable = isRef && (isSel || r.count <= 1)
      const prev = prevCache.get(r.id)
      const d = prev?.data
      let edge: LinkEdge
      if (
        prev &&
        d &&
        prev.selected === isSel &&
        !!prev.reconnectable === reconnectable &&
        d.highlight === highlight &&
        d.index === r.index &&
        d.count === r.count &&
        d.color === r.color
      ) {
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
          reconnectable: reconnectable ? 'target' : false,
          data,
        }
      }
      next.set(r.id, edge)
      if (isRef && isSel) grabbable.push(edge)
      else out.push(edge)
    }
    edgeCache.current = next
    return grabbable.length ? out.concat(grabbable) : out
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

  // And for asset cards that left the canvas (undo of a drop, "Bỏ khỏi canvas" in the inspector): selected but
  // invisible, they would be linked by C or counted by Delete. The library has its own selection (librarySelection).
  useEffect(() => {
    const ui = useUI.getState()
    if (!ui.selectedIds.length) return
    const am = assetMapOf(assets)
    const kept = ui.selectedIds.filter((id) => {
      const a = am.get(id)
      return !a || !!a.position
    })
    if (kept.length !== ui.selectedIds.length) ui.select(kept)
  }, [assets])

  // Node selection changed outside React Flow (N, Ctrl+A, Inspector / queue "Đi tới cảnh", drops…): drop the wire
  // selection too, like a plain click on a node does. Wires are canvas-only, so leaving the canvas clears them as well.
  const rfSelecting = useRef(false)

  /** Is a gesture in progress that replaces the node selection (plain click, box) rather than adding to it? */
  const replacingSelection = useCallback(() => {
    const st = rfStore.getState()
    return !st.multiSelectionActive || st.userSelectionActive || !!st.userSelectionRect
  }, [rfStore])
  /** Drop selected ids that have no node on the canvas (see selectionSeed); keeps the wire selection. */
  const dropOffCanvasSelection = useCallback(() => {
    const ui = useUI.getState()
    if (!ui.selectedIds.length) return
    const lookup = rfStore.getState().nodeLookup
    const kept = selectionSeed(ui.selectedIds, true, (id) => lookup.has(id))
    if (kept.length === ui.selectedIds.length) return
    rfSelecting.current = true
    try {
      ui.select(kept)
    } finally {
      rfSelecting.current = false
    }
  }, [rfStore])
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
    if (!hoveredId || connecting || libraryDrag || takeDrag) return ''
    const lit = new Set([hoveredId])
    for (const r of rawEdges) {
      if (r.source === hoveredId) lit.add(r.target)
      else if (r.target === hoveredId) lit.add(r.source)
    }
    if (lit.size < 2) return ''
    const nots = [...lit].map((id) => `:not([data-id="${cssId(id)}"])`).join('')
    return `.cv-stage .react-flow__node${nots}{opacity:.38}`
  }, [hoveredId, rawEdges, connecting, libraryDrag, takeDrag])

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
    const lookup = rfStore.getState().nodeLookup
    const dims: Record<string, { width: number; height: number }> = {}
    const drag: Record<string, XY> = {}
    const commit: Record<string, XY> = {}
    let sel: Set<string> | null = null
    // NodeResizer: 'dimensions' changes carry `resizing` (true while dragging a handle, false on release) and come
    // with a plain 'position' change (no `dragging`) when the left / top edge moves the node.
    const resizeIds = new Set<string>()
    for (const c of changes) if (c.type === 'dimensions' && c.resizing !== undefined) resizeIds.add(c.id)
    const liveBoxes = useCanvasLocal.getState().resizing
    const live: Record<string, ResizeBox> = {}
    const ended: string[] = []
    const liveOf = (id: string): ResizeBox => live[id] ?? liveBoxes[id] ?? { w: 0, h: 0 }
    for (const c of changes) {
      if (c.type === 'dimensions') {
        if (c.resizing === true) {
          if (c.dimensions) live[c.id] = { ...liveOf(c.id), w: c.dimensions.width, h: c.dimensions.height }
        } else if (c.resizing === false) {
          ended.push(c.id)
        } else if (c.dimensions) dims[c.id] = { width: c.dimensions.width, height: c.dimensions.height }
      } else if (c.type === 'position') {
        if (!c.position) continue
        if (resizeIds.has(c.id)) live[c.id] = { ...liveOf(c.id), x: c.position.x, y: c.position.y }
        else if (c.dragging) drag[c.id] = c.position
        else commit[c.id] = c.position
      } else if (c.type === 'select') {
        // React Flow only sends deselects for nodes it has: a plain click / box starts from the on-canvas selection.
        sel ??= new Set(selectionSeed(ui.selectedIds, replacingSelection(), (id) => lookup.has(id)))
        if (c.selected) sel.add(c.id)
        else sel.delete(c.id)
      }
      // 'remove' / 'add' / 'replace' are ignored: deletion goes through actions.deleteSelection.
    }
    if (Object.keys(live).length) useCanvasLocal.getState().setResizing(live)
    for (const id of ended) commitResize(id, autoRef.current)
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
          const scene = item.orphan ? undefined : sm.get(item.sceneId)
          const take = takes.get(id)
          if (!take || (!scene && !item.orphan)) continue
          // Dropped on its auto slot (snapped to the grid): keep it auto-placed (it keeps following the scene).
          // Orphans (scene deleted) have no auto slot: wherever they are dropped is kept.
          const auto = scene ? autoTakePosition(commit[scene.id] ?? scene.position, sceneWidth(scene), slotsRef.current.get(id) ?? 0) : null
          const next = auto && isAutoSlot(auto, pos) ? null : pos
          takeCommit[id] = next
          if (!(next === null ? take.position === null : samePos(take.position ?? undefined, next))) takesMoved = true
        } else {
          // The node can vanish mid-drag (Delete or Ctrl+Z pressed while the mouse is held): React Flow still sends
          // its final position. Nothing to move then — and no empty undo step that would break the toast's Undo.
          const cur = sm.get(id)?.position ?? am.get(id)?.position ?? folderMapOf(project.folders).get(id)?.position
          if (!cur) continue
          projectCommit[id] = pos
          if (!samePos(cur, pos)) projectMoved = true
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
  }, [rfStore, replacingSelection])

  const onEdgesChange = useCallback(
    (changes: EdgeChange<LinkEdge>[]) => {
      const ui = useUI.getState()
      // Box selection also selects every wire touching a boxed node (even ones leaving the box): accept wire
      // selection only from explicit clicks, otherwise Delete would cut references outside the box.
      const { userSelectionActive, userSelectionRect, multiSelectionActive } = rfStore.getState()
      const boxing = userSelectionActive || !!userSelectionRect
      let sel: Set<string> | null = null
      let clicked = false
      for (const c of changes) {
        if (c.type !== 'select' || (c.selected && boxing)) continue
        if (c.selected && parseEdgeId(c.id)?.kind === 'out') continue
        sel ??= new Set(ui.selectedEdgeIds)
        if (c.selected) {
          sel.add(c.id)
          clicked = true
        } else sel.delete(c.id)
      }
      if (sel) ui.setSelectedEdges([...sel])
      // A plain click on a wire replaces the selection: React Flow deselected the nodes it has, drop the others too.
      if (clicked && !multiSelectionActive) dropOffCanvasSelection()
    },
    [rfStore, dropOffCanvasSelection],
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
      if (!from) return
      const pt = clientPoint(event)
      const project = useProject.getState().project
      if (from.type === 'folder') {
        // Wired from a folder's dot: released over a video saves it, over a scene saves the scene's new videos.
        const hit = hitTest(pt.x, pt.y, stageRef.current)
        if (hit?.kind === 'node' && hit.id !== from.id) linkIntoFolder(hit.id, from.id)
        return
      }
      if (state.fromHandle?.type !== 'source') return
      if (from.type !== 'asset' && from.type !== 'take' && from.type !== 'scene') return
      const hit = hitTest(pt.x, pt.y, stageRef.current)
      if (!hit) return
      if (hit.kind === 'node') {
        if (hit.id === from.id) return
        // Released anywhere over a folder node: save the video / the scene's videos there (not images).
        if (folderMapOf(project.folders).has(hit.id)) {
          if (from.type !== 'asset') linkIntoFolder(from.id, hit.id)
          return
        }
        // Released anywhere over a scene card (not only on its handle).
        if (from.type !== 'scene' && sceneMapOf(project.scenes).has(hit.id)) connectNodes(from.id, hit.id, 'ref')
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
        source:
          from.type === 'asset'
            ? { kind: 'asset', assetIds: sourceAssetsFor(from.id) }
            : from.type === 'take'
              ? { kind: 'take', takeId: from.id, takeIds: sourceTakesFor(from.id) }
              : { kind: 'scene', sceneId: from.id, sceneIds: targetScenesFor(from.id) },
      })
    },
    [rf],
  )

  const isValidConnection = useCallback((c: LinkEdge | Connection) => {
    if (c.source === c.target) return false
    const p = useProject.getState().project
    if (folderMapOf(p.folders).has(c.target)) {
      // Into a folder: a video from its purple dot, or a scene from its right dot (auto-save).
      if (sceneMapOf(p.scenes).has(c.source)) return c.sourceHandle === 'take'
      return c.sourceHandle === 'out' && takeIndexOf(useRuns.getState().takes).byId.has(c.source)
    }
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

  // Double-click on a resize handle: back to the default size.
  const onNodeDoubleClick: NodeMouseHandler<CanvasNode> = useCallback((e, node) => {
    const target = e.target as Element | null
    if (!target?.closest?.('.react-flow__resize-control')) return
    e.stopPropagation()
    resetNodeSize(node.id)
  }, [])

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

  // ---------------- focus / reveal / fit requests ----------------
  /** Stage size and the band the queue drawer (36px bar, 272px open) and the toolbar above it cover at the bottom. */
  const stageSize = useCallback((): StageSize | null => {
    const stage = stageRef.current
    if (!stage || !stage.clientWidth || !stage.clientHeight) return null
    return { w: stage.clientWidth, h: stage.clientHeight, bottom: drawerInset(stage) + TOOLBAR_ROOM }
  }, [])

  // New nodes are placed next to what the canvas shows (actions.placementHint → project.newScenePosition).
  useEffect(
    () =>
      setCanvasViewSource(() => {
        const size = stageSize()
        return size ? visibleFlowRect(rf.getViewport(), size) : null
      }),
    [rf, stageSize],
  )

  useEffect(() => {
    /**
     * Box of a node from its stored position and its size — the measured one, else the stored one, else the default
     * card size. A node React Flow has not measured yet (just created, or never rendered) still has a real box: fitting
     * "measured nodes only" gave empty bounds and sent the view to the canvas origin.
     */
    const boxOf = (id: string): Box | null => {
      const n = rf.getInternalNode(id)
      if (!n) return null
      const fb = fallbackNodeSize(n.type)
      const p = n.internals.positionAbsolute
      return { x: p.x, y: p.y, w: n.measured?.width || n.width || fb.w, h: n.measured?.height || n.height || fb.h }
    }
    type Mode = 'focus' | 'reveal' | 'fit'
    const run = (ids: string[], mode: Mode, attempt = 0) => {
      if (!ids.length) {
        if (mode === 'fit') void rf.fitView({ padding: 0.12, duration: 300, maxZoom: 1 })
        return
      }
      const boxes = ids.map(boxOf).filter((b): b is Box => !!b)
      // Nodes created a moment ago (or a canvas just opened) may not be on the board yet: look again a little later.
      if (!boxes.length && attempt < 3) {
        setTimeout(() => run(ids, mode, attempt + 1), 100)
        return
      }
      const box = unionBox(boxes)
      const size = stageSize()
      if (!box || !size) return
      const vp = rf.getViewport()
      let next: { x: number; y: number; zoom: number } | null
      if (mode === 'fit') {
        // Same 0.25 padding as before on top/sides; the bottom also keeps the covered band clear.
        const padding = { x: 0.25, top: 0.25, bottom: `${Math.round(size.bottom + size.h * 0.1)}px` as const }
        next = getViewportForBounds({ x: box.x, y: box.y, width: box.w, height: box.h }, size.w, size.h, 0.1, 1.2, padding)
      } else if (mode === 'reveal') next = revealViewport(box, vp, size)
      else next = focusViewport(box, vp, size)
      if (next) void rf.setViewport(next, { duration: 300 })
    }
    const listen = (type: string, mode: Mode, delay: number) => {
      const handler = (e: Event) => {
        const ids = ((e as CustomEvent<string[]>).detail ?? []).slice()
        setTimeout(() => run(ids, mode), delay)
      }
      canvasEvents.addEventListener(type, handler)
      return () => canvasEvents.removeEventListener(type, handler)
    }
    const offs = [listen('focus', 'focus', 60), listen(REVEAL_EVENT, 'reveal', 60), listen(FIT_EVENT, 'fit', 30)]
    return () => offs.forEach((off) => off())
  }, [rf, stageSize])

  // ---------------- wires: click to cut ----------------
  // A plain click on a wire cuts it (pref clickToCut). Decided in the capture phase, before React Flow's own click
  // handler would select the wire: a cut leaves the node selection alone. Never at the end of a pan / drag / pinch
  // (the press must start on the same wire and barely move), never with Ctrl / Shift / Cmd (they select, as before).
  const press = useRef<WirePress | null>(null)
  const pointers = useRef(new Set<number>())
  /** Last cut by click: a double-click on a wire must not create a scene on the canvas under it. */
  const wireCutAt = useRef(-Infinity)
  useEffect(() => {
    const up = (e: PointerEvent) => pointers.current.delete(e.pointerId)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
    }
  }, [])
  const onWirePress = (e: ReactPointerEvent) => {
    // The primary pointer starts a new gesture (also clears ids whose pointerup never reached us).
    if (e.isPrimary) pointers.current.clear()
    pointers.current.add(e.pointerId)
    if (pointers.current.size > 1) {
      if (press.current) press.current.multi = true
      return
    }
    const edgeEl = (e.target as Element | null)?.closest?.('.react-flow__edge')
    press.current = {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      pointerType: e.pointerType || 'mouse',
      edgeId: edgeEl?.getAttribute('data-id') ?? null,
      multi: false,
    }
  }
  const onWireClick = (e: ReactMouseEvent) => {
    const target = e.target as Element | null
    const edgeEl = target?.closest?.('.react-flow__edge')
    if (!edgeEl || !target) return
    const id = edgeEl.getAttribute('data-id')
    const p = press.current
    press.current = null
    const action = wireClickAction({
      clickToCut: useCanvasPrefs.getState().clickToCut,
      kind: id ? parseEdgeId(id)?.kind : null,
      modifier: e.ctrlKey || e.metaKey || e.shiftKey,
      onGrip: !!target.closest('.react-flow__edgeupdater'),
      click: isWireClick(p, { x: e.clientX, y: e.clientY, t: performance.now(), edgeId: id }),
    })
    if (action !== 'cut' || !id) return
    e.stopPropagation()
    e.preventDefault()
    setMenu(null)
    wireCutAt.current = performance.now()
    cutEdge(id, false, { x: e.clientX, y: e.clientY })
  }

  // ---------------- pane gestures: double-click to create, drop from library / OS ----------------
  // The empty canvas' "Cảnh mới" button disappears on its first click: when it was double-clicked, the second click
  // lands on the canvas below and must not create another scene there.
  const emptyActionAt = useRef(-Infinity)
  const onEmptyAction = () => {
    emptyActionAt.current = performance.now()
    nextScene()
  }
  const onDoubleClick = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains('react-flow__pane')) return
    if (performance.now() - emptyActionAt.current < 600) return
    if (performance.now() - wireCutAt.current < 500) return
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    newScene({ x: snap(p.x - 140), y: snap(p.y - 40) })
  }

  const onDragOver = (e: DragEvent) => {
    if (hasTakeDrag(e.dataTransfer)) {
      // A video only drops on empty canvas here (scene cards handle their own drop): elsewhere the drop is refused.
      if (isEmptyCanvasTarget(e.target)) e.preventDefault()
      return
    }
    if (!hasAssetDrag(e.dataTransfer) && !hasFileDrag(e.dataTransfer)) return
    e.preventDefault()
  }
  const onDrop = (e: DragEvent) => {
    if (hasTakeDrag(e.dataTransfer)) {
      e.preventDefault()
      useUI.getState().setDraggingTakes(null)
      if (!isEmptyCanvasTarget(e.target)) return
      const ids = readTakeIds(e.dataTransfer)
      if (ids.length === 1) {
        // Continuation scene (take as @video_1) with its card's top-left corner near the drop point.
        const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
        createSceneFromTake(ids[0], { x: snap(p.x - 140), y: snap(p.y - 40) })
      } else if (ids.length > 1) {
        toast('Thả từng video ra nền để tạo cảnh tiếp nối — hoặc thả vào một cảnh để dùng làm @video.', { tone: 'info' })
      }
      return
    }
    if (!hasAssetDrag(e.dataTransfer) && !hasFileDrag(e.dataTransfer)) return
    e.preventDefault()
    useUI.getState().setDraggingAssets(null)
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const base = { x: snap(p.x - 90), y: snap(p.y - 100) }
    const ids = readAssetIds(e.dataTransfer)
    if (ids && ids.length) {
      const map = assetMapOf(useProject.getState().project.assets)
      const valid = ids.filter((id) => map.has(id))
      if (!valid.length) return
      // One card goes where it is dropped (even one already on the canvas: the user moves it here). Several: the ones
      // not on the canvas yet, in rows of 4 from the drop point; cards already on the canvas stay where they are.
      const fresh = valid.length === 1 ? valid : valid.filter((id) => !map.get(id)!.position)
      const measured = useUI.getState().measured
      const spots = gridPositions(
        base,
        fresh.map((id) => {
          const a = map.get(id)!
          return { w: a.size?.w ?? ASSET_DEFAULT_W, h: assetNodeHeight(a, measured[id]?.height) }
        }),
      )
      if (fresh.length) useProject.getState().setAssetsOnCanvas(Object.fromEntries(fresh.map((id, i) => [id, spots[i]])))
      useUI.getState().select(valid)
      const kept = valid.length - fresh.length
      toast(
        fresh.length
          ? `Đã đặt ${fresh.length} mục lên canvas${kept ? ` (${kept} mục đã có sẵn trên canvas — giữ nguyên chỗ)` : ''} — kéo chấm bên phải vào cảnh để nối.`
          : `${kept} mục này đã có trên canvas — đã chọn chúng, giữ nguyên chỗ.`,
        { tone: fresh.length ? 'success' : 'info', ...(fresh.length ? { action: undoToastAction() } : {}) },
      )
      return
    }
    const files = imageFiles(e.dataTransfer)
    if (files.length) void createAssetsFromFiles(files, { position: base })
  }

  const closeMenu = useCallback(() => setMenu(null), [])
  // A click on empty canvas clears the whole selection: React Flow deselects its nodes, drop the off-canvas ids too.
  // It also closes a take player left open (pinned) after its controls were used.
  const onPaneClick = useCallback(() => {
    setMenu(null)
    dropOffCanvasSelection()
    usePlayback.getState().unpin()
  }, [dropOffCanvasSelection])

  const handMode = interaction === 'hand'
  const stageCls = [
    'cv-stage',
    handMode ? 'mode-hand' : 'mode-select',
    connKind && `cv-connecting cv-connecting-${connKind}`,
    libraryDrag && 'cv-library-drag',
    takeDrag && 'cv-take-drag',
    liftMinimap && 'cv-lift-minimap',
    clickToCut && 'cv-click-cut',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={stageRef}
      className={stageCls}
      data-motion={motion}
      onPointerDownCapture={onWirePress}
      onClickCapture={onWireClick}
      onDoubleClick={onDoubleClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
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
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={onEdgeMouseLeave}
        onPaneClick={onPaneClick}
        onMoveStart={closeMenu}
        deleteKeyCode={null}
        // The app has its own keyboard layer (useShortcuts). React Flow's would move the focused (= last clicked)
        // node with the arrow keys even while a dialog is open over the canvas (TakeViewer / image viewer ←/→).
        disableKeyboardA11y
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
        connectionLineComponent={WireConnectionLine}
        nodeDragThreshold={2}
        elevateEdgesOnSelect={false}
        fitView
        fitViewOptions={FIT_OPTIONS}
        colorMode={theme}
        attributionPosition="top-right"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="var(--canvas-dot, var(--border-strong))" />
        <WireCutLayer />
        {showMinimap && (
          <MiniMap<CanvasNode>
            position="bottom-right"
            pannable
            zoomable
            nodeColor={minimapColor}
            nodeStrokeWidth={0}
            nodeBorderRadius={10}
            // Theme tokens (React Flow passes these through CSS variables, so var() / color-mix() work): a veil of the canvas color
            // outside the viewport and a hairline around it, readable on the light and the dark panel.
            maskColor="color-mix(in srgb, var(--canvas-bg) 70%, transparent)"
            maskStrokeColor="color-mix(in srgb, var(--text) 28%, transparent)"
            maskStrokeWidth={1}
            bgColor="var(--panel)"
            ariaLabel="Bản đồ thu nhỏ"
          />
        )}
      </ReactFlow>
      <SelectionHint />
      <CanvasToolbar density={density} />
      {menu && <ConnectMenu menu={menu} onClose={closeMenu} />}
      {scenes.length === 0 && !folders.length && assets.every((a) => !a.position) && (
        <div className="cv-empty">
          <div className="cv-empty-glyph" aria-hidden>
            <Clapperboard size={24} strokeWidth={1.5} />
          </div>
          <div className="cv-empty-title">Canvas trống</div>
          <div className="cv-empty-text">
            Bấm đúp vào nền để tạo cảnh · kéo nhân vật từ Thư viện vào đây · hoặc bấm <span className="kbd">N</span>
          </div>
          <button className="btn btn-primary cv-empty-action nodrag nopan" onClick={onEmptyAction}>
            <Plus size={15} strokeWidth={2} />
            Cảnh mới
          </button>
        </div>
      )}
    </div>
  )
}

const cssId = (id: string) => id.replace(/["\\]/g, '')

// ---------------------------------------------------------------------------------------------
/** Every wire that can be drawn (visibility by edge mode is decided later). Only wires between shown nodes. */
function buildRawEdges(scenes: Scene[], assets: Asset[], takes: TakeLayout, folders: readonly SaveFolder[] = NO_FOLDERS): RawEdge[] {
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
          color: which === 'first' ? 'var(--first)' : 'var(--last)',
        })
      }
    }
  }
  for (const item of takes.items) {
    if (item.orphan) continue // its scene was deleted
    out.push({
      id: edgeId('out', item.sceneId, item.id),
      kind: 'out',
      source: item.sceneId,
      target: item.id,
      sourceHandle: 'take',
      targetHandle: 'in',
      index: 0,
      count: 1,
      color: 'var(--seq)',
    })
  }
  // Wires into folder nodes arrive at the folder's left dot: spread them together like a scene's references.
  if (folders.length) {
    const sm = sceneMapOf(scenes)
    for (const f of folders) {
      const incoming: RawEdge[] = []
      for (const sid of f.autoScenes ?? []) {
        if (!sm.has(sid)) continue
        incoming.push({ id: edgeId('autosave', sid, f.id), kind: 'autosave', source: sid, target: f.id, sourceHandle: 'take', targetHandle: 'in', index: 0, count: 0, color: 'var(--save)' })
      }
      for (const tid of f.takes ?? []) {
        if (!takes.byId.has(tid)) continue
        incoming.push({ id: edgeId('save', tid, f.id), kind: 'save', source: tid, target: f.id, sourceHandle: 'out', targetHandle: 'in', index: 0, count: 0, color: 'var(--save)' })
      }
      incoming.forEach((e, index) => {
        e.index = index
        e.count = incoming.length
        out.push(e)
      })
    }
  }
  return out
}

/** A video or a scene wired into a folder node (from either end): save that video / the scene's new videos there. */
function linkIntoFolder(sourceId: string, folderId: string) {
  if (takeIndexOf(useRuns.getState().takes).byId.has(sourceId)) {
    linkTakesToFolder(sourceTakesFor(sourceId), folderId)
    return
  }
  if (sceneMapOf(useProject.getState().project.scenes).has(sourceId)) linkScenesToFolder(targetScenesFor(sourceId), folderId)
}

/**
 * Resize handle released: store the node's new size once (and its new position when the left / top edge moved it).
 * A press without any drag leaves no live box and changes nothing.
 */
function commitResize(id: string, autos: Map<string, XY>) {
  const local = useCanvasLocal.getState()
  const box = local.resizing[id]
  if (!box) return
  local.clearResizing(id)
  if (!box.w || !box.h) return
  const size = { w: Math.round(box.w), h: Math.round(box.h) }
  const pos = box.x !== undefined && box.y !== undefined ? { x: box.x, y: box.y } : null
  const project = useProject.getState().project
  const entity = sceneMapOf(project.scenes).get(id) ?? assetMapOf(project.assets).get(id)
  if (entity) {
    const cur = entity.size
    const moved = pos && entity.position && !samePos(entity.position, pos) ? { [id]: pos } : undefined
    if (cur && cur.w === size.w && cur.h === size.h && !moved) return
    useProject.getState().setNodeSizes({ [id]: size }, moved)
    return
  }
  const take = takeIndexOf(useRuns.getState().takes).byId.get(id)
  if (!take) return
  const runs = useRuns.getState()
  if (!take.size || take.size.w !== size.w || take.size.h !== size.h) runs.setTakeSizes({ [id]: size })
  // Resized from the left / top: it now stays where it was dragged to (an auto-placed take becomes explicit).
  const shown = take.position ?? autos.get(id)
  if (pos && !samePos(shown ?? undefined, pos)) runs.setTakePositions({ [id]: pos })
}

/** Apply a finished connection gesture. Asset: `targetHandle` decides ref vs first/last frame. Take: @video ref. */
function connectNodes(source: string, target: string, targetHandle: string | null | undefined) {
  const project = useProject.getState().project
  if (folderMapOf(project.folders).has(target)) {
    linkIntoFolder(source, target)
    return
  }
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

/** Move a @video reference to another scene in one undo step; refused (original link kept) when the target is full. */
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
  if (!useProject.getState().moveVideoRefToScene(takeId, fromSceneId, newTarget, videoLabel(takeId))) {
    const spec = MODELS[target.settings.model]
    const why = usesVideoRefs(target.settings) ? `đã đủ ${spec.maxRefVideos} video của ${spec.name}` : `chế độ hiện tại của ${spec.name} không nhận video`
    toast(`${sceneCode(target.order)} không nhận thêm video tham chiếu (${why}) — giữ nguyên nối cũ.`, { tone: 'warning' })
    return
  }
  useUI.getState().setSelectedEdges([])
  toast(already ? `${sceneCode(target.order)} đã có ${label} — bỏ nối ở cảnh cũ.` : `Đã chuyển ${label} sang ${sceneCode(target.order)}.`, {
    tone: 'success',
    action: undoToastAction(),
  })
}

/** Minimap fill (React Flow sets it as an inline style, so theme tokens work). */
function minimapColor(node: CanvasNode): string {
  if (node.type === 'folder') return 'var(--save)'
  if (node.type === 'asset') return assetMapOf(useProject.getState().project.assets).get(node.id)?.color ?? 'var(--seq)'
  if (node.type === 'take') {
    const st = takeIndexOf(useRuns.getState().takes).byId.get(node.id)?.status
    return st ? STATUS_COLOR[st] : 'var(--panel-3)'
  }
  return sceneMapOf(useProject.getState().project.scenes).get(node.id)?.color ?? 'var(--text-faint)'
}
