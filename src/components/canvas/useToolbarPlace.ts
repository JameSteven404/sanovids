import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { IS_MAC } from '../../lib/platform'
import { DRAG_SLOP } from '../../lib/gesture'
import { useToolbarPrefs, type ToolbarPlace } from '../../lib/toolbarPrefs'
import { fitToolbar, snapToolbar, toolbarRect, type ToolbarSize } from './toolbarModel'

export function useToolbarPlace() {
  const host = useRef<HTMLDivElement>(null)
  const place = useToolbarPrefs((s) => s.place)
  const [stage, setStage] = useState<ToolbarSize>({ w: 0, h: 0 })
  const [preview, setPreview] = useState<ToolbarPlace | null>(null)
  const gesture = useRef<{ id: number; x: number; y: number; grab: { x: number; y: number }; moved: boolean; place: ToolbarPlace; target: HTMLButtonElement } | null>(null)
  const suppressClick = useRef(0)
  const actual = preview ?? place
  const fit = fitToolbar(stage, actual.dock)
  const rect = toolbarRect({ ...actual, dock: fit.dock }, stage, fit.size)

  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setStage((old) => old.w === el.clientWidth && old.h === el.clientHeight ? old : { w: el.clientWidth, h: el.clientHeight })
    })
    observer.observe(el)
    setStage({ w: el.clientWidth, h: el.clientHeight })
    return () => observer.disconnect()
  }, [])

  const finish = (commit: boolean) => {
    const drag = gesture.current
    if (!drag) return
    gesture.current = null
    if (!commit) suppressClick.current = Date.now() + 500
    if (drag.moved) {
      suppressClick.current = Date.now() + 500
      if (commit) useToolbarPrefs.getState().setPlace(drag.place)
    }
    setPreview(null)
    if (drag.target.hasPointerCapture(drag.id)) drag.target.releasePointerCapture(drag.id)
  }
  useEffect(() => {
    const cancel = () => finish(false)
    const key = (e: KeyboardEvent) => {
      if (!gesture.current) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', cancel)
    }
  }, [])

  const start = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || (IS_MAC && e.ctrlKey)) return
    const bounds = e.currentTarget.getBoundingClientRect()
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, grab: { x: e.clientX - bounds.left + 6, y: e.clientY - bounds.top + 6 }, moved: false, place, target: e.currentTarget }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    e.stopPropagation()
  }
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const drag = gesture.current
    const el = host.current
    if (!drag || drag.id !== e.pointerId || !el) return
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < (DRAG_SLOP[e.pointerType as keyof typeof DRAG_SLOP] ?? DRAG_SLOP.mouse)) return
    drag.moved = true
    const bounds = el.getBoundingClientRect()
    drag.place = snapToolbar({ x: e.clientX - bounds.left, y: e.clientY - bounds.top }, drag.grab, { w: el.clientWidth, h: el.clientHeight }, e.altKey)
    setPreview(drag.place)
    e.preventDefault()
  }
  return { host, stage, place: actual, fit, rect, dragging: preview !== null, start, move, finish, suppressClick }
}
