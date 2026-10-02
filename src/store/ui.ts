// UI-only state: selection, view, dialogs, drag overlay, toasts. Never undoable, mostly not persisted.
import { create } from 'zustand'
import type { EdgeMode, ViewMode, XY } from '../core/types'

export interface ToastAction {
  label: string
  run: () => void
}
export interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'warning' | 'error'
  action?: ToastAction
}

export type DialogState =
  | { kind: 'none' }
  | { kind: 'import' }
  | { kind: 'settings' }
  | { kind: 'shortcuts' }
  | { kind: 'runConfirm'; sceneIds: string[] }
  | { kind: 'take'; takeId: string }
  | { kind: 'asset'; assetId: string }
  | { kind: 'image'; imageIds: string[]; index: number; title?: string }
  | { kind: 'projects' }

export type InteractionMode = 'hand' | 'select'
export type TakeDisplay = 'all' | 'chosen'

const pref = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem('bdp:pref:' + key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
const savePref = (key: string, value: unknown) => {
  try {
    localStorage.setItem('bdp:pref:' + key, JSON.stringify(value))
  } catch {
    /* storage may be unavailable */
  }
}

export interface UIState {
  view: ViewMode
  edgeMode: EdgeMode
  interaction: InteractionMode
  showMinimap: boolean
  queueOpen: boolean
  leftOpen: boolean
  rightOpen: boolean

  /** Canvas selection (scene ids and asset ids that are shown on canvas). Mirrors React Flow selection. */
  selectedIds: string[]
  /** Selected edge ids on the canvas. */
  selectedEdgeIds: string[]
  /** Asset ids selected in the left library (independent of canvas). */
  librarySelection: string[]
  hoveredId: string | null
  /** Asset id being dragged from the library (HTML5 DnD), used to highlight drop targets. */
  draggingAssetIds: string[] | null

  /** Live positions while a node is being dragged. Committed to the project store on drag end. */
  dragPos: Record<string, XY>
  /** Node sizes measured by React Flow (kept so derived nodes stay measured). */
  measured: Record<string, { width: number; height: number }>

  dialog: DialogState
  toasts: Toast[]

  setView: (v: ViewMode) => void
  setEdgeMode: (m: EdgeMode) => void
  cycleEdgeMode: () => void
  setInteraction: (m: InteractionMode) => void
  toggleMinimap: () => void
  /** Canvas: show every take node, or only the chosen (starred, else latest) take of each scene. */
  takeDisplay: TakeDisplay
  setTakeDisplay: (d: TakeDisplay) => void
  setQueueOpen: (open: boolean) => void
  setLeftOpen: (open: boolean) => void
  setRightOpen: (open: boolean) => void

  select: (ids: string[], opts?: { additive?: boolean }) => void
  setSelectedEdges: (ids: string[]) => void
  clearSelection: () => void
  setLibrarySelection: (ids: string[]) => void
  toggleLibrary: (id: string, additive: boolean) => void
  setHovered: (id: string | null) => void
  setDraggingAssets: (ids: string[] | null) => void
  /** Take ids being dragged (HTML5 DnD from the library / take strips), to highlight drop targets. */
  draggingTakeIds: string[] | null
  setDraggingTakes: (ids: string[] | null) => void

  setDragPos: (pos: Record<string, XY>) => void
  clearDragPos: (ids?: string[]) => void
  setMeasured: (id: string, size: { width: number; height: number }) => void

  openDialog: (d: DialogState) => void
  closeDialog: () => void

  toast: (text: string, opts?: { tone?: Toast['tone']; action?: ToastAction; ms?: number }) => number
  dismissToast: (id: number) => void
}

let toastSeq = 1
const EDGE_MODES: EdgeMode[] = ['hidden', 'selected', 'all']

export const useUI = create<UIState>()((set, get) => ({
  view: pref<ViewMode>('view', 'canvas'),
  edgeMode: pref<EdgeMode>('edgeMode', 'selected'),
  interaction: pref<InteractionMode>('interaction', 'hand'),
  showMinimap: pref('minimap', true),
  takeDisplay: pref<TakeDisplay>('takeDisplay', 'all'),
  queueOpen: false,
  leftOpen: pref('leftOpen', true),
  rightOpen: pref('rightOpen', true),

  selectedIds: [],
  selectedEdgeIds: [],
  librarySelection: [],
  hoveredId: null,
  draggingAssetIds: null,
  draggingTakeIds: null,
  dragPos: {},
  measured: {},
  dialog: { kind: 'none' },
  toasts: [],

  setView: (view) => {
    savePref('view', view)
    set({ view })
  },
  setEdgeMode: (edgeMode) => {
    savePref('edgeMode', edgeMode)
    set({ edgeMode })
  },
  cycleEdgeMode: () => {
    const next = EDGE_MODES[(EDGE_MODES.indexOf(get().edgeMode) + 1) % EDGE_MODES.length]
    get().setEdgeMode(next)
  },
  setInteraction: (interaction) => {
    savePref('interaction', interaction)
    set({ interaction })
  },
  setTakeDisplay: (takeDisplay) => {
    savePref('takeDisplay', takeDisplay)
    set({ takeDisplay })
  },
  toggleMinimap: () => {
    savePref('minimap', !get().showMinimap)
    set({ showMinimap: !get().showMinimap })
  },
  setQueueOpen: (queueOpen) => set({ queueOpen }),
  setLeftOpen: (leftOpen) => {
    savePref('leftOpen', leftOpen)
    set({ leftOpen })
  },
  setRightOpen: (rightOpen) => {
    savePref('rightOpen', rightOpen)
    set({ rightOpen })
  },

  select: (ids, opts) =>
    set((s) => {
      const next = opts?.additive ? [...new Set([...s.selectedIds, ...ids])] : ids
      return sameList(next, s.selectedIds) ? s : { selectedIds: next }
    }),
  setSelectedEdges: (ids) => set((s) => (sameList(ids, s.selectedEdgeIds) ? s : { selectedEdgeIds: ids })),
  clearSelection: () => set({ selectedIds: [], selectedEdgeIds: [] }),
  setLibrarySelection: (librarySelection) => set({ librarySelection }),
  toggleLibrary: (id, additive) =>
    set((s) => {
      if (!additive) return { librarySelection: s.librarySelection.length === 1 && s.librarySelection[0] === id ? [] : [id] }
      return { librarySelection: s.librarySelection.includes(id) ? s.librarySelection.filter((x) => x !== id) : [...s.librarySelection, id] }
    }),
  setHovered: (hoveredId) => set((s) => (s.hoveredId === hoveredId ? s : { hoveredId })),
  setDraggingAssets: (draggingAssetIds) => set({ draggingAssetIds }),
  setDraggingTakes: (draggingTakeIds) => set({ draggingTakeIds }),

  setDragPos: (pos) => set((s) => ({ dragPos: { ...s.dragPos, ...pos } })),
  clearDragPos: (ids) =>
    set((s) => {
      if (!ids) return { dragPos: {} }
      const next = { ...s.dragPos }
      for (const id of ids) delete next[id]
      return { dragPos: next }
    }),
  setMeasured: (id, size) =>
    set((s) => {
      const cur = s.measured[id]
      if (cur && cur.width === size.width && cur.height === size.height) return s
      return { measured: { ...s.measured, [id]: size } }
    }),

  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: { kind: 'none' } }),

  toast: (text, opts = {}) => {
    const id = toastSeq++
    const t: Toast = { id, text, tone: opts.tone ?? 'info', action: opts.action }
    set((s) => ({ toasts: [...s.toasts.slice(-3), t] }))
    const ms = opts.ms ?? (opts.action ? 6000 : 2800)
    setTimeout(() => get().dismissToast(id), ms)
    return id
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** Shorthand usable outside React. */
export const toast = (...args: Parameters<UIState['toast']>) => useUI.getState().toast(...args)
