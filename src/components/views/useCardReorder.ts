// Storyboard: drag a card to a new place (mouse / pen past a few px, touch after a long press), the other cards shift
// live to make room, auto-scroll near the top / bottom edge, Esc cancels. Dropping calls `onDrop` (the view moves the
// scene with the store's moveScene: one undo step). Every scene-order change (drop, Alt + arrow, undo / redo) slides
// the moved cards from where they were (FLIP).
// The gesture runs outside React: inline transforms and data-* attributes on the card elements (React never renders
// either), so 100+ memoized cards do not re-render while the pointer moves. Only the drop marker is React state.
// Motion levels (lib/canvasPrefs 'Hoạt ảnh'): 'full' = lift + live shifting + slides; 'reduced' = cards stay put, an
// insertion bar marks the place, no slides (OS reduce-motion turns 'full' into this); 'off' = the same without fades.
// Pure math: ./storyboardOrder.ts.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { MotionLevel } from '../../lib/canvasPrefs'
import { autoScrollStep, flipOffsets, LIFT_SCALE, LONG_PRESS_MS, MAX_FLIP_CARDS, movedPast, moveItem, shiftedIndex, slotAt, type Offset, type Slot } from './storyboardOrder'

/** Where the dragged card would land (drives the drop marker). */
export interface DropTarget {
  id: string
  from: number
  to: number
  slots: Slot[]
}

export interface ReorderEnv {
  gridRef: RefObject<HTMLDivElement | null>
  scrollRef: RefObject<HTMLDivElement | null>
  /** Card ids in their current (scene) order. */
  ids: readonly string[]
  motion: MotionLevel
  /** A card was dropped at a new index: move the scene now (the slide starts after the re-render). */
  onDrop: (id: string, from: number, to: number) => void
  /** A card was lifted (pointer drag started). */
  onLift?: (id: string, from: number) => void
  /** A drag was cancelled (Esc, pointer lost, window blurred). */
  onCancel?: (id: string, from: number) => void
}

interface Gesture {
  pointerId: number
  pointerType: string
  id: string
  from: number
  to: number
  el: HTMLElement
  startX: number
  startY: number
  lastX: number
  lastY: number
  phase: 'press' | 'drag'
  timer: number
  raf: number
  motion: MotionLevel
  cards: HTMLElement[]
  slots: Slot[]
  /** Pointer position inside the card when it was pressed. */
  grab: Offset
  /** Current translation of the dragged card from its own slot. */
  offset: Offset
}

/** Positions (grid content coordinates) cards must slide from after the next order change. */
interface PendingSlide {
  key: string
  first: Map<string, Offset & { scale?: number }>
  /** The card that moved: drawn above the others while it slides, gets the "landed" ring. */
  lead: string
  /** Give the moved card the keyboard focus back (React may have moved its DOM node). */
  focus: boolean
  /** Scroll the moved card into view (keyboard moves). */
  reveal: boolean
}

const SLIDE_MS = 300
const LANDED_MS = 900

const cardsOf = (grid: HTMLElement) => Array.from(grid.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.card !== undefined)
const measure = (cards: HTMLElement[]): Slot[] => cards.map((c) => ({ x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight }))
const translate = (o: Offset, scale = 1) => `translate3d(${o.x}px, ${o.y}px, 0)${scale !== 1 ? ` scale(${scale})` : ''}`
/** Client point → grid content coordinates (the frame of offsetLeft / offsetTop). */
function contentPoint(grid: HTMLElement, cx: number, cy: number): Offset {
  const r = grid.getBoundingClientRect()
  return { x: cx - r.left - grid.clientLeft, y: cy - r.top - grid.clientTop }
}

function createReorder(env: { current: ReorderEnv }, setTarget: (t: DropTarget | null) => void) {
  let g: Gesture | null = null
  let pending: PendingSlide | null = null
  let suppressClickUntil = 0
  /** Timers that remove a data-* flag from a card, one per card and flag (a newer flag restarts it). */
  const timers = new Map<string, { el: HTMLElement; t: number }>()
  const flagFor = (el: HTMLElement, flag: 'slide' | 'landed', value: string, ms: number) => {
    const k = flag + ':' + (el.dataset.card ?? '')
    const old = timers.get(k)
    if (old) window.clearTimeout(old.t)
    el.dataset[flag] = value
    const t = window.setTimeout(() => {
      timers.delete(k)
      delete el.dataset[flag]
    }, ms)
    timers.set(k, { el, t })
  }

  // ---------------- pointer gesture ----------------
  function listen(on: boolean) {
    if (on) {
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onPointerCancel, true)
      window.addEventListener('keydown', onKey, true)
      window.addEventListener('blur', onBlur)
    } else {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onPointerCancel, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }

  function pointerDown(e: ReactPointerEvent<HTMLElement>) {
    suppressClickUntil = 0
    if (g) {
      if (g.phase === 'drag') return
      end(false) // a press that never got its release
    }
    if (!e.isPrimary || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
    const target = e.target as Element
    // Buttons on the card (play, view, download, run) keep their own clicks.
    if (target.closest('button, a, input, textarea, select, [data-no-drag]')) return
    const grid = env.current.gridRef.current
    const el = target.closest<HTMLElement>('[data-card]')
    if (!grid || !el || el.parentElement !== grid) return
    const id = el.dataset.card ?? ''
    const ids = env.current.ids
    const from = ids.indexOf(id)
    if (from < 0 || ids.length < 2) return
    const s: Gesture = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      id,
      from,
      to: from,
      el,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      phase: 'press',
      timer: 0,
      raf: 0,
      motion: env.current.motion,
      cards: [],
      slots: [],
      grab: { x: 0, y: 0 },
      offset: { x: 0, y: 0 },
    }
    g = s
    listen(true)
    if (e.pointerType === 'touch') s.timer = window.setTimeout(() => g === s && s.phase === 'press' && lift(s), LONG_PRESS_MS)
  }

  function lift(s: Gesture) {
    const grid = env.current.gridRef.current
    if (!grid) return end(false)
    const cards = cardsOf(grid)
    // The DOM must match the scene order (it always does once React has committed).
    if (cards.length !== env.current.ids.length || cards[s.from] !== s.el) return end(false)
    s.cards = cards
    s.slots = measure(cards)
    s.motion = env.current.motion
    const start = contentPoint(grid, s.startX, s.startY)
    s.grab = { x: start.x - s.slots[s.from].x, y: start.y - s.slots[s.from].y }
    s.phase = 'drag'
    // A card still sliding from an earlier move: drop its transition so it follows the pointer at once.
    clearFlag(s.el, 'slide')
    s.el.dataset.dragging = ''
    grid.dataset.reordering = s.motion
    window.getSelection()?.removeAllRanges()
    env.current.scrollRef.current?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    follow(s)
    setTarget({ id: s.id, from: s.from, to: s.to, slots: s.slots })
    s.raf = requestAnimationFrame(tick)
    env.current.onLift?.(s.id, s.from)
  }

  /** Keep the card under the pointer and update the drop target. */
  function follow(s: Gesture) {
    const grid = env.current.gridRef.current
    if (!grid) return
    const p = contentPoint(grid, s.lastX, s.lastY)
    const home = s.slots[s.from]
    s.offset = { x: p.x - s.grab.x - home.x, y: p.y - s.grab.y - home.y }
    s.el.style.transform = translate(s.offset, s.motion === 'full' ? LIFT_SCALE : 1)
    const to = slotAt(s.slots, p.x, p.y)
    if (to < 0 || to === s.to) return
    const prev = s.to
    s.to = to
    if (s.motion === 'full') shift(s, Math.min(s.from, prev, to), Math.max(s.from, prev, to))
    setTarget({ id: s.id, from: s.from, to, slots: s.slots })
  }

  /** 'full': the cards between the old and new target slide over to make room (CSS transition on [data-reordering]). */
  function shift(s: Gesture, lo: number, hi: number) {
    for (let i = lo; i <= hi; i++) {
      if (i === s.from) continue
      const j = shiftedIndex(i, s.from, s.to)
      const a = s.slots[i]
      const b = s.slots[j]
      s.cards[i].style.transform = j === i ? '' : translate({ x: b.x - a.x, y: b.y - a.y })
    }
  }

  function tick() {
    const s = g
    if (!s || s.phase !== 'drag') return
    const sc = env.current.scrollRef.current
    if (sc) {
      const r = sc.getBoundingClientRect()
      const v = autoScrollStep(s.lastY, r.top, r.bottom)
      if (v) {
        const before = sc.scrollTop
        sc.scrollTop = before + v
        if (sc.scrollTop !== before) follow(s)
      }
    }
    s.raf = requestAnimationFrame(tick)
  }

  function onMove(e: PointerEvent) {
    const s = g
    if (!s || e.pointerId !== s.pointerId) return
    s.lastX = e.clientX
    s.lastY = e.clientY
    if (s.phase === 'press') {
      if (!movedPast(e.clientX - s.startX, e.clientY - s.startY, s.pointerType)) return
      // Touch moved before the long press: that is a scroll, not a drag.
      if (s.pointerType === 'touch') return end(false)
      lift(s)
      return
    }
    e.preventDefault()
    follow(s)
  }
  function onUp(e: PointerEvent) {
    if (g && e.pointerId === g.pointerId) end(true)
  }
  function onPointerCancel(e: PointerEvent) {
    if (g && e.pointerId === g.pointerId) end(false)
  }
  function onKey(e: KeyboardEvent) {
    if (!g || g.phase !== 'drag') return
    // While a card is in the air no shortcut runs (Delete, Ctrl+Z… would pull the list from under it); Esc cancels.
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') end(false)
  }
  function onBlur() {
    end(false)
  }
  function onScroll() {
    if (g?.phase === 'drag') follow(g)
  }
  function onResize() {
    const s = g
    if (!s || s.phase !== 'drag') return
    s.slots = measure(s.cards)
    if (s.motion === 'full') shift(s, 0, s.cards.length - 1)
    follow(s)
    setTarget({ id: s.id, from: s.from, to: s.to, slots: s.slots })
  }

  function clearFlag(el: HTMLElement, flag: 'slide' | 'landed') {
    const k = flag + ':' + (el.dataset.card ?? '')
    const old = timers.get(k)
    if (old) window.clearTimeout(old.t)
    timers.delete(k)
    delete el.dataset[flag]
  }

  /** Finish the gesture: `commit` = dropped (pointer up), else cancelled. `quiet`: no callbacks (unmount). */
  function end(commit: boolean, quiet = false) {
    const s = g
    if (!s) return
    g = null
    window.clearTimeout(s.timer)
    cancelAnimationFrame(s.raf)
    listen(false)
    if (s.phase !== 'drag') return
    env.current.scrollRef.current?.removeEventListener('scroll', onScroll)
    window.removeEventListener('resize', onResize)
    // The click that follows the release must not select / open anything.
    suppressClickUntil = performance.now() + 500
    const grid = env.current.gridRef.current
    if (grid) delete grid.dataset.reordering
    delete s.el.dataset.dragging
    setTarget(null)
    const ids = env.current.ids
    if (commit && s.to !== s.from && ids[s.from] === s.id) {
      const home = s.slots[s.from]
      const mine: PendingSlide = {
        key: moveItem(ids, s.from, s.to).join('|'),
        first: new Map([[s.id, { x: home.x + s.offset.x, y: home.y + s.offset.y, scale: s.motion === 'full' ? LIFT_SCALE : 1 }]]),
        lead: s.id,
        focus: false,
        reveal: false,
      }
      pending = mine
      env.current.onDrop(s.id, s.from, s.to)
      // The order did not change after all (refused): put the cards back.
      requestAnimationFrame(() => {
        if (pending !== mine) return
        pending = null
        putBack(s.cards, s.el, env.current.motion === 'full')
      })
      return
    }
    putBack(s.cards, s.el, s.motion === 'full' && !quiet)
    if (!commit && !quiet) env.current.onCancel?.(s.id, s.from)
  }

  /** Cards return to their own slots (animated: the lifted one settles, the shifted ones slide back). */
  function putBack(cards: HTMLElement[], lifted: HTMLElement, animate: boolean) {
    const touched = cards.filter((c) => c.style.transform)
    if (!animate) {
      instant(touched, () => touched.forEach((c) => (c.style.transform = '')))
      return
    }
    flagFor(lifted, 'slide', 'lead', SLIDE_MS + 80)
    touched.forEach((c) => (c.style.transform = ''))
  }

  /** Apply `write` with transitions off (inline), flush, then hand transitions back to the stylesheet. */
  function instant(cards: HTMLElement[], write: () => void) {
    if (!cards.length) return
    cards.forEach((c) => (c.style.transition = 'none'))
    write()
    void cards[0].offsetWidth
    cards.forEach((c) => (c.style.transition = ''))
  }

  // ---------------- order changes (after React re-rendered the cards in the new order) ----------------
  function afterOrderChange(prev: readonly string[], next: readonly string[]) {
    // The list changed under a lifted card (another window, a sync): drop the gesture, nothing moves.
    if (g) {
      const s = g
      g = null
      window.clearTimeout(s.timer)
      cancelAnimationFrame(s.raf)
      listen(false)
      env.current.scrollRef.current?.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      delete s.el.dataset.dragging
      const grid = env.current.gridRef.current
      if (grid) delete grid.dataset.reordering
      setTarget(null)
    }
    const key = next.join('|')
    const p = pending && pending.key === key ? pending : null
    pending = null
    const grid = env.current.gridRef.current
    if (!grid) return
    const motion = env.current.motion
    const cards = cardsOf(grid)
    if (cards.length !== next.length) return
    // Read every new slot before writing anything (one layout).
    const slots = measure(cards)
    const index = new Map(next.map((id, i) => [id, i]))
    const deltas = new Map<string, Offset & { scale: number }>()
    if (motion === 'full') {
      if (p) {
        for (const [id, at] of p.first) {
          const n = index.get(id)
          if (n !== undefined) deltas.set(id, { x: at.x - slots[n].x, y: at.y - slots[n].y, scale: at.scale ?? 1 })
        }
      } else {
        const off = flipOffsets(prev, next, slots)
        if (off && off.size <= MAX_FLIP_CARDS) for (const [id, o] of off) deltas.set(id, { ...o, scale: 1 })
      }
    }
    const sliding: HTMLElement[] = []
    const stale: HTMLElement[] = []
    cards.forEach((c, n) => {
      const d = deltas.get(next[n])
      if (d && (Math.abs(d.x) > 0.5 || Math.abs(d.y) > 0.5 || d.scale !== 1)) sliding.push(c)
      else if (c.style.transform) stale.push(c)
    })
    const all = [...sliding, ...stale]
    if (all.length) {
      // Start positions with transitions off: the shifted cards are already where they belong (no jump), the moved
      // ones jump back to where they were drawn…
      instant(all, () => {
        for (const c of stale) c.style.transform = ''
        for (const c of sliding) {
          const d = deltas.get(c.dataset.card ?? '')!
          c.style.transform = translate(d, d.scale)
        }
      })
      // …then slide to their new slots with the stylesheet's transition.
      for (const c of sliding) {
        flagFor(c, 'slide', p && c.dataset.card === p.lead ? 'lead' : '', SLIDE_MS + 80)
        c.style.transform = ''
      }
    }
    if (!p) return
    const n = index.get(p.lead)
    const el = n === undefined ? undefined : cards[n]
    if (!el) return
    if (p.focus) el.focus({ preventScroll: true })
    if (p.reveal) reveal(grid, slots[n!], motion)
    if (motion !== 'off') {
      // Restart the ring if the card landed again before it faded.
      clearFlag(el, 'landed')
      void el.offsetWidth
      flagFor(el, 'landed', '', LANDED_MS)
    }
  }

  /** Scroll the storyboard so the slot is visible (with a little air). */
  function reveal(grid: HTMLElement, slot: Slot, motion: MotionLevel) {
    const sc = env.current.scrollRef.current
    if (!sc) return
    const r = grid.getBoundingClientRect()
    const box = sc.getBoundingClientRect()
    const top = r.top + grid.clientTop + slot.y
    const bottom = top + slot.h
    const air = 12
    const dy = top < box.top + air ? top - box.top - air : bottom > box.bottom - air ? bottom - box.bottom + air : 0
    if (dy) sc.scrollBy({ top: dy, behavior: motion === 'full' ? 'smooth' : 'auto' })
  }

  /** Keyboard move about to happen: remember where the affected cards are drawn now (mid-slide included). */
  function prepareMove(id: string, from: number, to: number) {
    const grid = env.current.gridRef.current
    const ids = env.current.ids
    if (!grid || ids[from] !== id) return
    const cards = cardsOf(grid)
    const first = new Map<string, Offset>()
    if (env.current.motion === 'full' && cards.length === ids.length) {
      const r = grid.getBoundingClientRect()
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        const b = cards[i].getBoundingClientRect()
        first.set(ids[i], { x: b.left - r.left - grid.clientLeft, y: b.top - r.top - grid.clientTop })
      }
    }
    const focused = !!cards[from] && cards[from].contains(document.activeElement)
    const mine: PendingSlide = { key: moveItem(ids, from, to).join('|'), first, lead: id, focus: focused, reveal: true }
    pending = mine
    requestAnimationFrame(() => {
      if (pending === mine) pending = null
    })
  }

  function clickCapture(e: ReactMouseEvent) {
    if (performance.now() < suppressClickUntil) {
      suppressClickUntil = 0
      e.stopPropagation()
      e.preventDefault()
    }
  }

  function dispose() {
    end(false, true)
    timers.forEach(({ el, t }, k) => {
      window.clearTimeout(t)
      delete el.dataset[k.slice(0, k.indexOf(':')) as 'slide' | 'landed']
    })
    timers.clear()
  }

  return {
    pointerDown,
    clickCapture,
    prepareMove,
    afterOrderChange,
    dispose,
    /** A touch press is waiting for its long press, or a card is in the air. */
    busy: () => !!g && (g.phase === 'drag' || g.pointerType === 'touch'),
    dragging: () => g?.phase === 'drag',
  }
}

/** Drag-to-reorder for the storyboard grid. Spread `gridProps` on the grid element (the cards' parent). */
export function useCardReorder(opts: ReorderEnv) {
  const env = useRef(opts)
  env.current = opts
  const [target, setTarget] = useState<DropTarget | null>(null)
  const [ctl] = useState(() => createReorder(env, setTarget))

  // Slide the cards whenever the order changes (drop, keyboard, undo / redo). Same cards in a new order only.
  const key = opts.ids.join('|')
  const prevRef = useRef<{ key: string; ids: readonly string[] }>({ key, ids: opts.ids })
  useLayoutEffect(() => {
    const prev = prevRef.current
    prevRef.current = { key, ids: env.current.ids }
    if (prev.key !== key) ctl.afterOrderChange(prev.ids, env.current.ids)
  }, [key, ctl])

  // Touch: once a card is lifted the finger must not scroll the storyboard (needs a non-passive listener).
  const hasCards = opts.ids.length > 0
  useEffect(() => {
    const grid = opts.gridRef.current
    if (!grid) return
    const onTouchMove = (e: TouchEvent) => {
      if (ctl.dragging() && e.cancelable) e.preventDefault()
    }
    grid.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => grid.removeEventListener('touchmove', onTouchMove)
  }, [ctl, hasCards, opts.gridRef])

  useEffect(() => () => ctl.dispose(), [ctl])

  const onContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      // A long press opens the context menu on touch screens: not while it lifts a card.
      if (ctl.busy()) e.preventDefault()
    },
    [ctl],
  )
  const onDragStart = useCallback((e: ReactMouseEvent) => e.preventDefault(), [])

  return {
    target,
    prepareMove: ctl.prepareMove,
    gridProps: {
      onPointerDown: ctl.pointerDown,
      onClickCapture: ctl.clickCapture,
      onContextMenu,
      onDragStart,
    },
  }
}
