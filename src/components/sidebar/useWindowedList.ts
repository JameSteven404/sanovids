import { useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react'
import { listKeyIndex, rowScrollTop, windowedRows } from './windowing'

const rowOf = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('[data-window-id]') : null

/** Keep native focus/drag on keyed rows while their neighbours are windowed out. */
export function useWindowedList(ids: readonly string[], rowHeight: number, resetKey: string) {
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const [activeId, setActiveId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const pendingFocus = useRef<string | null>(null)
  const previousFocusIndex = useRef(0)
  const frame = useRef(0)
  const focusIndex = focusedId === null ? -1 : ids.indexOf(focusedId)
  const rows = windowedRows(ids.length, rowHeight, viewport.top, viewport.height, [focusIndex, ids.indexOf(dragId ?? '')])
  const activeIndex = ids.indexOf(activeId ?? '')
  const tabIndex = rows.includes(activeIndex) ? activeIndex : rows.find((i) => i >= Math.floor(viewport.top / rowHeight)) ?? rows[0] ?? -1

  const measure = () => {
    if (!body) return
    const top = body.scrollTop
    const height = body.clientHeight
    setViewport((old) => old.top === top && old.height === height ? old : { top, height })
  }

  useLayoutEffect(() => {
    if (!body) {
      setFocusedId(null)
      return
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [body])

  useLayoutEffect(() => {
    if (!body) return
    body.scrollTop = 0
    measure()
  }, [body, resetKey])

  const focusRow = (index: number) => {
    if (!body || index < 0 || index >= ids.length) return
    const id = ids[index]
    body.scrollTop = rowScrollTop(index, ids.length, rowHeight, body.scrollTop, body.clientHeight)
    pendingFocus.current = id
    setActiveId(id)
    setFocusedId(id)
    measure()
  }

  useLayoutEffect(() => {
    if (!body) return
    // Browser scroll clamping can happen after the list shrinks; read it before paint.
    measure()
    if (focusedId !== null && focusIndex < 0) {
      if (ids.length) focusRow(Math.min(previousFocusIndex.current, ids.length - 1))
      else {
        pendingFocus.current = null
        setFocusedId(null)
        setActiveId(null)
        body.focus({ preventScroll: true })
      }
      return
    }
    if (focusIndex >= 0) previousFocusIndex.current = focusIndex
    if (pendingFocus.current !== null) {
      const row = Array.from(body.querySelectorAll<HTMLElement>('[data-window-id]')).find((el) => el.dataset.windowId === pendingFocus.current)
      if (row) {
        pendingFocus.current = null
        row.focus({ preventScroll: true })
      }
    }
  }, [body, ids, focusedId, focusIndex, viewport.top, viewport.height])

  useLayoutEffect(() => {
    if (!dragId) return
    const clear = () => setDragId(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('pointerdown', clear, { once: true, capture: true })
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('pointerdown', clear, { capture: true })
    }
  }, [dragId])

  const bodyProps: HTMLAttributes<HTMLDivElement> = {
    tabIndex: -1,
    onScroll: () => {
      if (frame.current) return
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        measure()
      })
    },
    onFocus: (e) => {
      const id = rowOf(e.target)?.dataset.windowId
      if (id) {
        setActiveId(id)
        setFocusedId(id)
      }
    },
    onBlur: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setFocusedId(null)
    },
    onKeyDown: (e) => {
      if (e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return
      const row = rowOf(e.target)
      if (!row || row !== e.target) return
      const next = listKeyIndex(e.key, ids.indexOf(row.dataset.windowId!), ids.length, Math.floor(viewport.height / rowHeight))
      if (next === null) return
      e.preventDefault()
      e.stopPropagation()
      focusRow(next)
    },
    onDragStartCapture: (e) => setDragId(rowOf(e.target)?.dataset.windowId ?? null),
    onDragEnd: () => setDragId(null),
  }
  return { bodyRef: setBody, bodyProps, rows, tabIndex }
}
