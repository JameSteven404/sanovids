// UI-only state: selection, view, dialogs, drag overlay, toasts. Never undoable, mostly not persisted.
import { create } from 'zustand'
import type { EdgeMode, ViewMode } from '../core/types'

export interface ToastAction {
  label: string
  run: () => void
}
export interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'warning' | 'error'
  action?: ToastAction
  /** Stays until dismissed (its action runs, or dismissToast) — never times out, never pushed out by newer toasts. */
  persistent?: boolean
}

export type DialogState =
  | { kind: 'none' }
  | { kind: 'import' }
  /**
   * "Cài đặt". `section`: id of a group of its GROUPS (components/dialogs/SettingsDialog, e.g. 'canvas', 'keys') to show
   * — the dialog switches to that group's level and scrolls it into view. Open it with actions.openSettings(section).
   */
  | { kind: 'settings'; section?: string }
  | { kind: 'shortcuts' }
  /** `follow`: after the run starts, open the take viewer on the new take (re-run from the viewer). */
  | { kind: 'runConfirm'; sceneIds: string[]; follow?: boolean }
  | { kind: 'take'; takeId: string }
  | { kind: 'asset'; assetId: string }
  | { kind: 'image'; imageIds: string[]; index: number; title?: string }
  | { kind: 'projects' }
  /** "Nạp credit canvasapp" sheet (components/topup, docs/SPEC-v2.md §10). Open it with actions.openTopUp(tab). */
  | { kind: 'topup'; tab?: TopUpTab }
  /** "Bảng phát triển" of development mode (components/dev/DevPanel). Open it with actions.openDevPanel(tab). */
  | { kind: 'dev'; tab?: DevPanelTab }
  /** "Cập nhật SanoVids" (components/dialogs/UpdateDialog). Open with updateActions.openUpdateDialog(). */
  | { kind: 'update' }
  /**
   * "Nhập job" — jobs made on canvasapp's own page become takes (components/runs/ImportJobsDialog, siteJobActions).
   * `back`: the dialog it was opened from (Settings, Bảng phát triển), shown again when it closes. `provider`: the
   * gateway to read (default: the one new takes use; the Bảng phát triển always reads the simulated one).
   */
  | { kind: 'importJobs'; back?: DialogState; provider?: 'dev' | 'canvasapp' }

/** Tabs of the top-up sheet: buy credits / the canvasapp credit history. */
export type TopUpTab = 'topup' | 'history'

/**
 * Tabs of the development panel: server state · faults · request log · jobs & top-up orders · simulated updater ·
 * stress tester ("Test giới hạn", src/devtools/stress) · performance ('perf': only in a perf build, see src/perf;
 * devPanelTabs leaves it out everywhere else).
 */
export type DevPanelTab = 'status' | 'faults' | 'log' | 'jobs' | 'updates' | 'stress' | 'perf'

export type InteractionMode = 'hand' | 'select'
export type TakeDisplay = 'all' | 'chosen'

/** "Thời gian hiện thông báo" (Cài đặt → Nâng cao): how long toasts stay. */
export type ToastTime = 'short' | 'normal' | 'long' | 'xlong'
export const TOAST_TIMES: readonly ToastTime[] = ['short', 'normal', 'long', 'xlong']
/** Multiplier of every toast's time on screen (2.8 s for a plain toast, 6 s with a button, at 'normal'). */
export const TOAST_SCALE: Record<ToastTime, number> = { short: 0.7, normal: 1, long: 1.8, xlong: 3 }
export const TOAST_TIME_LABEL: Record<ToastTime, string> = { short: 'Ngắn', normal: 'Vừa', long: 'Dài', xlong: 'Rất dài' }
/** Plain toast time (ms) at 'normal'; a toast with a button (Hoàn tác…) stays longer. */
export const TOAST_BASE_MS = 2800
export const TOAST_ACTION_MS = 6000

export const VIEW_MODES: readonly ViewMode[] = ['canvas', 'table', 'storyboard']
export const EDGE_MODES: readonly EdgeMode[] = ['hidden', 'selected', 'all']
export const INTERACTION_MODES: readonly InteractionMode[] = ['hand', 'select']
export const TAKE_DISPLAYS: readonly TakeDisplay[] = ['all', 'chosen']

/** Value check for a stored UI pref. */
export type PrefCheck<T> = (v: unknown) => v is T
export const oneOf =
  <T extends string>(list: readonly T[]): PrefCheck<T> =>
  (v): v is T =>
    typeof v === 'string' && (list as readonly string[]).includes(v)
export const isBool: PrefCheck<boolean> = (v): v is boolean => typeof v === 'boolean'

/** A stored pref (JSON text) → its value, or `fallback` when missing, unreadable or not valid. */
export function parsePref<T>(raw: string | null | undefined, fallback: T, valid: PrefCheck<T>): T {
  if (raw == null) return fallback
  try {
    const v: unknown = JSON.parse(raw)
    return valid(v) ? v : fallback
  } catch {
    return fallback
  }
}

const pref = <T,>(key: string, fallback: T, valid: PrefCheck<T>): T => {
  try {
    return parsePref(localStorage.getItem('bdp:pref:' + key), fallback, valid)
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
  /** Large-canvas override is session-only and never writes the user's minimap preference. */
  minimapAutoHiddenFor: string | null
  minimapShownFor: string[]
  queueOpen: boolean
  leftOpen: boolean
  rightOpen: boolean

  /** Canvas selection (scene ids and asset ids that are shown on canvas). Mirrors React Flow selection. */
  selectedIds: string[]
  /** Selected edge ids on the canvas. */
  selectedEdgeIds: string[]
  /** Asset ids selected in the left library (independent of canvas). */
  librarySelection: string[]
  /** Asset id being dragged from the library (HTML5 DnD), used to highlight drop targets. */
  draggingAssetIds: string[] | null


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
  setMinimap: (show: boolean) => void
  /** How long toasts stay on screen (Settings). */
  toastTime: ToastTime
  setToastTime: (t: ToastTime) => void
  setQueueOpen: (open: boolean) => void
  setLeftOpen: (open: boolean) => void
  setRightOpen: (open: boolean) => void

  select: (ids: string[], opts?: { additive?: boolean }) => void
  setSelectedEdges: (ids: string[]) => void
  clearSelection: () => void
  setLibrarySelection: (ids: string[]) => void
  toggleLibrary: (id: string, additive: boolean) => void
  setDraggingAssets: (ids: string[] | null) => void
  /** Take ids being dragged (HTML5 DnD from the library / take strips), to highlight drop targets. */
  draggingTakeIds: string[] | null
  setDraggingTakes: (ids: string[] | null) => void


  openDialog: (d: DialogState) => void
  closeDialog: () => void

  /** Show a toast; returns its id. `persistent` = no timeout (dismiss it with dismissToast). */
  toast: (text: string, opts?: { tone?: Toast['tone']; action?: ToastAction; ms?: number; persistent?: boolean }) => number
  dismissToast: (id: number) => void
}

let toastSeq = 1

export const useUI = create<UIState>()((set, get) => ({
  view: pref('view', 'canvas', oneOf(VIEW_MODES)),
  edgeMode: pref('edgeMode', 'selected', oneOf(EDGE_MODES)),
  interaction: pref('interaction', 'hand', oneOf(INTERACTION_MODES)),
  showMinimap: pref('minimap', true, isBool),
  minimapAutoHiddenFor: null,
  minimapShownFor: [],
  takeDisplay: pref('takeDisplay', 'all', oneOf(TAKE_DISPLAYS)),
  toastTime: pref('toastTime', 'normal', oneOf(TOAST_TIMES)),
  queueOpen: false,
  leftOpen: pref('leftOpen', true, isBool),
  rightOpen: pref('rightOpen', true, isBool),

  selectedIds: [],
  selectedEdgeIds: [],
  librarySelection: [],
  draggingAssetIds: null,
  draggingTakeIds: null,
  dialog: { kind: 'none' },
  toasts: [],

  setView: (view) => {
    savePref('view', view)
    set({ view })
  },
  setEdgeMode: (edgeMode) => {
    if (!EDGE_MODES.includes(edgeMode)) return
    savePref('edgeMode', edgeMode)
    set({ edgeMode })
  },
  cycleEdgeMode: () => {
    const next = EDGE_MODES[(EDGE_MODES.indexOf(get().edgeMode) + 1) % EDGE_MODES.length]
    get().setEdgeMode(next)
  },
  setInteraction: (interaction) => {
    if (!INTERACTION_MODES.includes(interaction)) return
    savePref('interaction', interaction)
    set({ interaction })
  },
  setTakeDisplay: (takeDisplay) => {
    if (!TAKE_DISPLAYS.includes(takeDisplay)) return
    savePref('takeDisplay', takeDisplay)
    set({ takeDisplay })
  },
  toggleMinimap: () => {
    const s = get()
    const id = s.minimapAutoHiddenFor
    if (id && s.showMinimap && !s.minimapShownFor.includes(id)) {
      set({ minimapShownFor: [...s.minimapShownFor, id] })
    } else get().setMinimap(!s.showMinimap)
  },
  setMinimap: (showMinimap) => {
    if (typeof showMinimap !== 'boolean') return
    savePref('minimap', showMinimap)
    const { minimapAutoHiddenFor: id, minimapShownFor } = get()
    set({ showMinimap, minimapShownFor: id ? [...minimapShownFor.filter((p) => p !== id), ...(showMinimap ? [id] : [])] : minimapShownFor })
  },
  setToastTime: (toastTime) => {
    if (!TOAST_TIMES.includes(toastTime)) return
    savePref('toastTime', toastTime)
    set({ toastTime })
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
  setDraggingAssets: (draggingAssetIds) => set({ draggingAssetIds }),
  setDraggingTakes: (draggingTakeIds) => set({ draggingTakeIds }),


  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: { kind: 'none' } }),

  toast: (text, opts = {}) => {
    const id = toastSeq++
    const t: Toast = { id, text, tone: opts.tone ?? 'info', action: opts.action }
    if (opts.persistent) t.persistent = true
    set((s) => ({ toasts: keepToasts([...s.toasts, t]) }))
    if (!opts.persistent) {
      // "Thời gian hiện thông báo" scales every toast (explicit times too: a 20 s "waiting" toast becomes 36 s on 'long').
      const ms = (opts.ms ?? (opts.action ? TOAST_ACTION_MS : TOAST_BASE_MS)) * (TOAST_SCALE[get().toastTime] ?? 1)
      // Clamp: setTimeout fires at once for delays above 2^31-1 ms.
      setTimeout(() => get().dismissToast(id), Math.min(Math.max(0, ms), 2 ** 31 - 1))
    }
    return id
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** At most 4 toasts on screen: the oldest non-persistent ones go first. */
function keepToasts(list: Toast[]): Toast[] {
  const out = [...list]
  while (out.length > 4) {
    const i = out.findIndex((t) => !t.persistent)
    if (i < 0) break
    out.splice(i, 1)
  }
  return out
}

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** Shorthand usable outside React. */
export const toast = (...args: Parameters<UIState['toast']>) => useUI.getState().toast(...args)
