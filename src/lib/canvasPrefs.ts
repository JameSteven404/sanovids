// Canvas preferences (this device): how wires react to a click and how much the canvas animates.
// - clickToCut ("Bấm vào dây để bỏ nối", default on): one click on a reference / save wire cuts it (toast with Undo).
//   Off: a click selects the wire (old behaviour) and Delete or the wire's × cuts it. Ctrl / Shift + click always selects.
// - animations ("Hoạt ảnh", default 'full'): 'full' = wire cut / draw-in / drag effects; 'reduced' = short fades only,
//   no movement; 'off' = no canvas animation at all. The OS "reduce motion" setting turns 'full' into 'reduced'.
import { useSyncExternalStore } from 'react'
import { create } from 'zustand'

export type MotionLevel = 'full' | 'reduced' | 'off'

export interface CanvasPrefs {
  /** A click on a wire cuts it (default true). */
  clickToCut: boolean
  /** Canvas animation level (default 'full'). */
  animations: MotionLevel
}

export const CANVAS_PREFS_KEY = 'bdp:pref:canvas'
export const DEFAULT_CANVAS_PREFS: CanvasPrefs = { clickToCut: true, animations: 'full' }
export const MOTION_LEVELS: readonly MotionLevel[] = ['full', 'reduced', 'off']
export const MOTION_LABEL: Record<MotionLevel, string> = { full: 'Đầy đủ', reduced: 'Giảm bớt', off: 'Tắt' }

const isMotion = (v: unknown): v is MotionLevel => typeof v === 'string' && (MOTION_LEVELS as readonly string[]).includes(v)

/** Stored JSON → prefs (unknown keys ignored, wrong types / garbage → defaults). */
export function parseCanvasPrefs(raw: string | null | undefined): CanvasPrefs {
  if (!raw) return { ...DEFAULT_CANVAS_PREFS }
  try {
    const saved = JSON.parse(raw) as Partial<Record<keyof CanvasPrefs, unknown>> | null
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_CANVAS_PREFS }
    return {
      clickToCut: typeof saved.clickToCut === 'boolean' ? saved.clickToCut : DEFAULT_CANVAS_PREFS.clickToCut,
      animations: isMotion(saved.animations) ? saved.animations : DEFAULT_CANVAS_PREFS.animations,
    }
  } catch {
    return { ...DEFAULT_CANVAS_PREFS }
  }
}

function readPrefs(): CanvasPrefs {
  try {
    return parseCanvasPrefs(localStorage.getItem(CANVAS_PREFS_KEY))
  } catch {
    return { ...DEFAULT_CANVAS_PREFS }
  }
}

export const useCanvasPrefs = create<CanvasPrefs & { set: (patch: Partial<CanvasPrefs>) => void }>()((setState, getState) => ({
  ...readPrefs(),
  set: (patch) => {
    const next: Partial<CanvasPrefs> = {}
    if (typeof patch.clickToCut === 'boolean') next.clickToCut = patch.clickToCut
    if (isMotion(patch.animations)) next.animations = patch.animations
    if (!Object.keys(next).length) return
    setState(next)
    const { clickToCut, animations } = getState()
    try {
      localStorage.setItem(CANVAS_PREFS_KEY, JSON.stringify({ clickToCut, animations }))
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
  },
}))

// ---------------- OS "reduce motion" ----------------
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'
const reduceMedia = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(REDUCE_QUERY) : null)

/** The OS asks for less motion right now. */
export function systemReducedMotion(): boolean {
  return reduceMedia()?.matches === true
}

/** The level actually used: 'full' becomes 'reduced' when the OS asks for less motion. */
export function motionLevel(pref: MotionLevel, reducedMotion: boolean = systemReducedMotion()): MotionLevel {
  return pref === 'full' && reducedMotion ? 'reduced' : pref
}

function subscribeReduced(onChange: () => void) {
  const m = reduceMedia()
  m?.addEventListener?.('change', onChange)
  return () => m?.removeEventListener?.('change', onChange)
}

/** Effective canvas motion level (pref + OS setting), re-rendering when either changes. */
export function useMotionLevel(): MotionLevel {
  const pref = useCanvasPrefs((s) => s.animations)
  const reduced = useSyncExternalStore(subscribeReduced, systemReducedMotion, () => false)
  return motionLevel(pref, reduced)
}

/**
 * Call once at startup: mirrors the effective level on <html data-motion="full|reduced|off"> and keeps it in sync
 * with the pref (Settings → "Hiệu ứng chuyển động") and the OS setting. styles/app.css uses it app-wide: 'reduced'
 * keeps fades but nothing glides or scales, 'off' drops every transition and animation. Returns a cleanup.
 */
export function initMotion(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const apply = () => {
    document.documentElement.dataset.motion = motionLevel(useCanvasPrefs.getState().animations)
  }
  apply()
  const offPref = useCanvasPrefs.subscribe((s, prev) => {
    if (s.animations !== prev.animations) apply()
  })
  const offOs = subscribeReduced(apply)
  return () => {
    offPref()
    offOs()
  }
}
