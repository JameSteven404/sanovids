// Right-click on the canvas: ONE delegated handler on .cv-stage (no handler on the node components — they stay
// memoized and subscription-free). It resolves what is under the pointer from the DOM (thumbnail on a scene card →
// node → wire stack → empty canvas), applies the right-click selection rule (menuModel.contextSelection), builds the
// menu from the stores once (canvasMenu) and opens it. Also the Mac ⌃+click guard and the keyboard opening
// (Menu key / Shift+F10) for the canvas selection.
import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { XY } from '../../core/types'
import { IS_MAC } from '../../lib/platform'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { useCanvasLocal } from '../canvas/canvasModel'
import { isTextEntry } from '../common/focus'
import { canvasMenu, type CanvasTarget } from './canvasMenu'
import { closeContextMenu, openContextMenu, type MenuOrigin } from './contextMenuStore'
import { contextSelection, isMacSecondaryPress, isMenuKey, type ContextKind, type MenuItem } from './menuModel'

/** Parts of the stage that have their own behaviour (or none): a right-click there opens no canvas menu. */
const NO_MENU = '.cv-toolbar, .cv-sel-hint, .react-flow__minimap, .react-flow__controls, .react-flow__attribution, .cv-menu, .cv-empty, .cv-ed, .react-flow__edgeupdater'
const NODE_TYPES = new Set(['scene', 'take', 'asset', 'folder'])
/** The browser may send its own contextmenu event after the Menu key / Shift+F10: ignored for this long. */
const KEYBOARD_ECHO_MS = 600
let keyboardOpenedAt = -Infinity

/** Text being selected under the pointer: the native "Sao chép" menu (Electron, CM-E) stays. */
function inTextSelection(target: Element): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false
  return sel.containsNode(target, true)
}

/** A text field (or a field inside it): the native text menu stays. */
function isTextField(target: Element): boolean {
  if (isTextEntry(target as HTMLElement)) return true
  return !!target.closest('textarea, input, [contenteditable="true"]')
}

/** An overlay that is not a context menu is open (dialog sheet, lightbox…): no menu behind it. */
function otherOverlayOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('[data-top-overlay]:not(.cm-menu)')
}

/** Node element → its React Flow type and id. */
function nodeOf(el: Element | null): { type: string; id: string; el: Element } | null {
  const node = el?.closest('.react-flow__node')
  if (!node) return null
  const id = node.getAttribute('data-id')
  const type = [...node.classList].find((c) => c.startsWith('react-flow__node-'))?.slice('react-flow__node-'.length)
  return id && type && NODE_TYPES.has(type) ? { type, id, el: node } : null
}

/** Every wire under a screen point, top first (one elementsFromPoint per right-click). */
function wiresAt(x: number, y: number, first: Element | null): string[] {
  const ids: string[] = []
  const push = (el: Element | null | undefined) => {
    const id = el?.closest('.react-flow__edge')?.getAttribute('data-id')
    if (id && !ids.includes(id)) ids.push(id)
  }
  push(first)
  if (typeof document !== 'undefined' && document.elementsFromPoint) for (const el of document.elementsFromPoint(x, y)) push(el)
  return ids
}

export interface ResolvedTarget {
  target: CanvasTarget
  /** Kind for the selection rule. */
  kind: ContextKind
  /** Id for the selection rule (node id). */
  id?: string
  /** Element outlined while the menu is open. */
  el?: Element | null
}

/** What a right-click at this DOM target means (null: no canvas menu there). Exported for tests. */
export function resolveTarget(target: Element, x: number, y: number): ResolvedTarget | null {
  if (target.closest(NO_MENU)) return null
  const ref = target.closest('[data-ctx="ref"]')
  const assetId = ref?.getAttribute('data-asset-id')
  const sceneId = ref?.getAttribute('data-scene-id')
  if (ref && assetId && sceneId) return { target: { kind: 'ref', assetId, sceneId }, kind: 'ref', el: ref }
  const node = nodeOf(target)
  if (node) return { target: { kind: node.type as 'scene' | 'take' | 'asset' | 'folder', id: node.id }, kind: node.type as ContextKind, id: node.id, el: node.el }
  if (target.closest('.react-flow__edge')) {
    const ids = wiresAt(x, y, target)
    if (ids.length) return { target: { kind: 'edges', ids }, kind: 'edge' }
  }
  if (target.closest('.react-flow__pane, .react-flow__renderer, .react-flow__edges, .react-flow__background') || target.classList.contains('cv-stage')) {
    return { target: { kind: 'pane' }, kind: 'pane' }
  }
  return null
}

/** Apply the right-click selection rule; returns whether the menu is the "several cards" one. */
function applySelection(kind: ContextKind, id: string | undefined): boolean {
  const ui = useUI.getState()
  const next = contextSelection({ kind, id, selectedIds: ui.selectedIds, selectedEdgeIds: ui.selectedEdgeIds })
  if (next.selectedIds !== ui.selectedIds) ui.select([...next.selectedIds])
  if (next.selectedEdgeIds !== ui.selectedEdgeIds) ui.setSelectedEdges([...next.selectedEdgeIds])
  return next.multi
}

/** The canvas wire under a menu row lights up while the row is hovered / focused. */
function highlightWire(item: MenuItem | null) {
  useCanvasLocal.getState().setHoveredEdge(item?.edgeId ?? null)
}

const stageEl = () => (typeof document !== 'undefined' ? document.querySelector<HTMLElement>('.cv-stage') : null)

/** Open the canvas menu for a resolved target. */
function openFor(resolved: ResolvedTarget, opts: { flow: XY; at?: { x: number; y: number }; anchor?: DOMRect; origin: MenuOrigin }) {
  const multi = applySelection(resolved.kind, resolved.id)
  const target: CanvasTarget = multi ? { kind: 'multi' } : resolved.target
  const spec = canvasMenu(target, { flow: opts.flow, at: opts.at })
  if (!spec || !spec.entries.length) return
  openContextMenu({
    spec,
    at: opts.at,
    anchor: opts.anchor ? { left: opts.anchor.left, top: opts.anchor.top, right: opts.anchor.right, bottom: opts.anchor.bottom } : undefined,
    origin: opts.origin,
    target: resolved.el ?? null,
    fallbackFocus: stageEl,
    onHighlight: highlightWire,
  })
}

export interface CanvasMenuBridge {
  /** Screen → canvas coordinates (React Flow screenToFlowPosition). */
  toFlow: (p: { x: number; y: number }) => XY
  /** Something on the canvas is being dragged / wired: no menu now. */
  busy: () => boolean
  /** Close the canvas' own popover (ConnectMenu). */
  closeOthers: () => void
}

/**
 * The canvas' right-click wiring. Returns stable handlers for the stage: `onContextMenu` (bubble, delegated) and
 * `onPointerDownCapture` / `onMouseDownCapture` guards for ⌃+click on a Mac (stopped so React Flow does not start a
 * selection box / node drag; the browser then sends `contextmenu`). Also listens for the Menu key / Shift+F10.
 */
export function useCanvasContextMenu(bridge: CanvasMenuBridge) {
  const ref = useRef(bridge)
  ref.current = bridge

  const onContextMenu = useCallback((e: ReactMouseEvent) => {
    const target = e.target as Element | null
    if (e.defaultPrevented || !target) return
    // Text fields / selected text: the native text menu (CM-E) — never preventDefault there.
    if (isTextField(target) || inTextSelection(target)) return
    e.preventDefault()
    // The browser's own contextmenu event right after the Menu key / Shift+F10 opened the menu: keep that one.
    if (performance.now() - keyboardOpenedAt < KEYBOARD_ECHO_MS) return
    if (useUI.getState().dialog.kind !== 'none' || otherOverlayOpen() || ref.current.busy()) return
    const resolved = resolveTarget(target, e.clientX, e.clientY)
    if (!resolved) return
    ref.current.closeOthers()
    const pointerType = (e.nativeEvent as PointerEvent).pointerType
    const origin: MenuOrigin = pointerType === 'touch' ? 'touch' : pointerType === 'pen' ? 'pen' : 'mouse'
    openFor(resolved, { flow: ref.current.toFlow({ x: e.clientX, y: e.clientY }), at: { x: e.clientX, y: e.clientY }, origin })
  }, [])

  /** ⌃+click on a Mac: stop it before React Flow (returns true when stopped). */
  const onSecondaryGuard = useCallback((e: ReactPointerEvent | ReactMouseEvent): boolean => {
    if (!isMacSecondaryPress(e, IS_MAC)) return false
    e.stopPropagation()
    return true
  }, [])

  // Keyboard: Menu key / Shift+F10 with the canvas in front (focus on the page or in the canvas) → menu of the
  // selection, below its first card; nothing selected → the empty-canvas menu at the middle of the canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMenuKey(e) || e.defaultPrevented) return
      const active = document.activeElement
      const stage = stageEl()
      if (!stage) return
      if (active && active !== document.body && !stage.contains(active)) return
      if (useUI.getState().view !== 'canvas' || useUI.getState().dialog.kind !== 'none' || otherOverlayOpen()) return
      e.preventDefault()
      e.stopPropagation()
      const ui = useUI.getState()
      const project = useProject.getState().project
      const takes = useRuns.getState().takes
      const first = ui.selectedIds[0]
      const nodeEl = first ? stage.querySelector(`.react-flow__node[data-id="${CSS.escape(first)}"]`) : null
      const box = (nodeEl ?? stage).getBoundingClientRect()
      const center = { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 120) }
      let resolved: ResolvedTarget = { target: { kind: 'pane' }, kind: 'pane' }
      if (first && nodeEl) {
        const kind: ContextKind = project.scenes.some((s) => s.id === first)
          ? 'scene'
          : takes.some((t) => t.id === first)
            ? 'take'
            : project.assets.some((a) => a.id === first)
              ? 'asset'
              : 'folder'
        resolved = { target: { kind, id: first } as CanvasTarget, kind, id: first, el: nodeEl }
      }
      ref.current.closeOthers()
      keyboardOpenedAt = performance.now()
      openFor(resolved, { flow: ref.current.toFlow(center), anchor: nodeEl ? box : undefined, at: nodeEl ? undefined : center, origin: 'keyboard' })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const onMoveStart = useCallback(() => closeContextMenu(false), [])

  return { onContextMenu, onSecondaryGuard, onMoveStart }
}
