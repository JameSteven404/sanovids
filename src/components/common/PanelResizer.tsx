import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useUI } from '../../store/ui'
import { fitPanelWidths } from './panelFit'

export interface PanelSpec {
  /** CSS variable on the app root that holds the width, e.g. '--left-w'. */
  cssVar: string
  storageKey: string
  defaultWidth: number
  min: number
  max: number
}

export const LEFT_PANEL: PanelSpec = { cssVar: '--left-w', storageKey: 'bdp:pref:leftW', defaultWidth: 272, min: 200, max: 520 }
export const RIGHT_PANEL: PanelSpec = { cssVar: '--right-w', storageKey: 'bdp:pref:rightW', defaultWidth: 392, min: 300, max: 680 }
/** The center view never gets narrower than this while resizing. */
const MIN_CENTER = 360
/** Dragging this far below the minimum collapses the panel. */
const COLLAPSE_SLACK = 90

export function readPanelWidth(spec: PanelSpec): number {
  try {
    const v = Number(localStorage.getItem(spec.storageKey))
    return Number.isFinite(v) && v >= spec.min && v <= spec.max ? v : spec.defaultWidth
  } catch {
    return spec.defaultWidth
  }
}

function savePanelWidth(spec: PanelSpec, width: number) {
  try {
    localStorage.setItem(spec.storageKey, String(Math.round(width)))
  } catch {
    /* storage unavailable */
  }
}

/** The side panels as they are now (shown / hidden, saved widths): what "Hoàn tác" after a layout reset puts back. */
export interface PanelLayout {
  leftOpen: boolean
  rightOpen: boolean
  leftW: string | null
  rightW: string | null
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeRaw(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

export function panelLayout(): PanelLayout {
  const { leftOpen, rightOpen } = useUI.getState()
  return { leftOpen, rightOpen, leftW: readRaw(LEFT_PANEL.storageKey), rightW: readRaw(RIGHT_PANEL.storageKey) }
}

/** Put a layout back (or the default one: both panels shown at their default widths). Applied at once. */
export function restorePanelLayout(layout: PanelLayout = { leftOpen: true, rightOpen: true, leftW: null, rightW: null }) {
  writeRaw(LEFT_PANEL.storageKey, layout.leftW)
  writeRaw(RIGHT_PANEL.storageKey, layout.rightW)
  const ui = useUI.getState()
  ui.setLeftOpen(layout.leftOpen)
  ui.setRightOpen(layout.rightOpen)
  // usePanelWidths re-reads the saved widths on the next resize (also when no panel was shown / hidden).
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('resize'))
}

/** "Đặt lại bố cục khung bên" (Settings): both side panels shown, default widths. Returns the layout before. */
export function resetPanelLayout(): PanelLayout {
  const before = panelLayout()
  restorePanelLayout()
  return before
}

/**
 * Apply the saved panel widths to the app root, fitted to the window: on mount, when a panel is shown or hidden,
 * and on every window resize. Saved widths that leave the center narrower than MIN_CENTER (a smaller window, a
 * snapped half-screen window, another screen) are shrunk for display only — the saved preference is kept, so the
 * panels get their width back when the window grows again.
 */
export function usePanelWidths(root: RefObject<HTMLElement | null>) {
  const leftOpen = useUI((s) => s.leftOpen)
  const rightOpen = useUI((s) => s.rightOpen)
  useEffect(() => {
    const el = root.current
    if (!el) return
    const apply = () => {
      const left = readPanelWidth(LEFT_PANEL)
      const right = readPanelWidth(RIGHT_PANEL)
      const total = el.clientWidth || window.innerWidth
      const fit = fitPanelWidths(total, leftOpen ? left : null, rightOpen ? right : null, { left: LEFT_PANEL, right: RIGHT_PANEL }, MIN_CENTER)
      el.style.setProperty(LEFT_PANEL.cssVar, (fit.left ?? left) + 'px')
      el.style.setProperty(RIGHT_PANEL.cssVar, (fit.right ?? right) + 'px')
    }
    apply()
    let frame = 0
    const onResize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(apply)
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [root, leftOpen, rightOpen])
}

interface Props {
  spec: PanelSpec
  /** Which side of the center the panel is on: dragging right grows a left panel and shrinks a right one. */
  side: 'left' | 'right'
  /** App root element that carries the CSS variables. */
  root: RefObject<HTMLElement | null>
  onCollapse: () => void
}

/**
 * Vertical drag handle between a side panel and the center view.
 * Drag to resize (live, no React re-render), double-click to reset, arrow keys ±16px (Shift ±64), drag far past the minimum to collapse.
 */
export function PanelResizer({ spec, side, root, onCollapse }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  const current = () => {
    const raw = root.current ? getComputedStyle(root.current).getPropertyValue(spec.cssVar) : ''
    const n = parseFloat(raw)
    return Number.isFinite(n) ? n : spec.defaultWidth
  }
  const otherPanelWidth = () => {
    const el = root.current
    if (!el) return 0
    const sel = side === 'left' ? '.app-right' : '.app-left'
    return el.querySelector<HTMLElement>(sel)?.offsetWidth ?? 0
  }
  const clamp = (w: number) => {
    const total = root.current?.clientWidth ?? window.innerWidth
    const maxByCenter = total - otherPanelWidth() - MIN_CENTER
    return Math.max(spec.min, Math.min(spec.max, maxByCenter, w))
  }
  const apply = (w: number) => root.current?.style.setProperty(spec.cssVar, w + 'px')

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = ref.current
    if (!handle) return
    const startX = e.clientX
    const startW = current()
    let latest = startW
    let collapse = false
    let frame = 0
    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('is-resizing-panels')
    handle.classList.add('active')
    const move = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX) * (side === 'left' ? 1 : -1)
      const raw = startW + delta
      collapse = raw < spec.min - COLLAPSE_SLACK
      latest = clamp(raw)
      handle.classList.toggle('will-collapse', collapse)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => apply(latest))
    }
    const up = () => {
      cancelAnimationFrame(frame)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      document.body.classList.remove('is-resizing-panels')
      handle.classList.remove('active', 'will-collapse')
      if (collapse) {
        apply(startW)
        onCollapse()
        return
      }
      apply(latest)
      savePanelWidth(spec, latest)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const reset = () => {
    const w = clamp(spec.defaultWidth)
    apply(w)
    savePanelWidth(spec, w)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    const dir = (e.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1)
    const w = clamp(current() + dir * (e.shiftKey ? 64 : 16))
    apply(w)
    savePanelWidth(spec, w)
  }

  return (
    <div
      ref={ref}
      className={`panel-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Đổi độ rộng thanh bên trái' : 'Đổi độ rộng thanh bên phải'}
      tabIndex={0}
      title="Kéo để đổi độ rộng · bấm đúp để về mặc định · kéo hẳn vào mép để ẩn"
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  )
}
