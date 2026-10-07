import { memo, useLayoutEffect, useRef, type ButtonHTMLAttributes, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { ActionId } from '../../core/keymap'
import { useKeymap } from '../../lib/keymapPrefs'
import { useOverlayFocus } from '../common/focus'
import { placeToolbarPanel, type ToolbarRect, type ToolbarSize, type toolbarSide } from './toolbarModel'

const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']

/**
 * Only the plain navigation keys stop here: N, C, Delete, Ctrl+Z… still reach the global shortcuts after a toolbar
 * click, and so do Alt / Ctrl / ⌘ + arrows (Alt+↑/↓ moves the selected scene).
 */
export function toolbarArrowKey(e: KeyboardEvent<HTMLElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey || !NAV_KEYS.includes(e.key)) return
  e.stopPropagation()
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([data-grip])')]
  if (!buttons.length) return
  e.preventDefault()
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const backward = e.key === 'ArrowLeft' || e.key === 'ArrowUp'
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
    : current < 0 ? backward ? buttons.length - 1 : 0 : (current + (backward ? -1 : 1) + buttons.length) % buttons.length
  buttons.forEach((button, index) => { button.tabIndex = index === next ? 0 : -1 })
  buttons[next].focus()
}

/**
 * Roving tabindex: exactly one item of `root` stays reachable with Tab. The arrows move the stop in the DOM (React
 * never resets it), so after a refit removed the item that held it — or added a second one — fix it up here.
 */
export function ensureRovingStop(root: { querySelectorAll(selector: string): ArrayLike<{ tabIndex: number }> } | null, active?: unknown) {
  if (!root) return
  const items = Array.from(root.querySelectorAll('button:not([data-grip])'))
  const stops = items.filter((item) => item.tabIndex === 0)
  if (!items.length || stops.length === 1) return
  const keep = items.find((item) => item === active) ?? stops[0] ?? items[0]
  for (const item of items) item.tabIndex = item === keep ? 0 : -1
}

/**
 * Focus inside a toolbar whose button disappears (moved to "⋯" by a refit, a tray action that emptied the selection)
 * goes to `fallback()` instead of dropping to <body>. A focus the user moved away (a click on the canvas) is
 * forgotten first, so a later refit never pulls focus back into the toolbar (Space would then press a button).
 * Chromium does not fire blur when a focused node is removed; when an engine does, the node is gone by the microtask.
 */
export function useFocusRescue(fallback: () => HTMLElement | null | undefined) {
  const last = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const el = last.current
    if (!el || el.isConnected) return
    last.current = null
    const active = document.activeElement
    if (!active || active === document.body) fallback()?.focus({ preventScroll: true })
  })
  return {
    onFocus: (e: FocusEvent<HTMLElement>) => { last.current = e.target as HTMLElement },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      const target = e.target as HTMLElement
      queueMicrotask(() => { if (last.current === target && target.isConnected && document.activeElement !== target) last.current = null })
    },
  }
}

export const ToolbarButton = memo(function ToolbarButton({ label, shortcut, children, disabled, onClick, ...props }:
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> & { label: string; shortcut?: ActionId; children: ReactNode }) {
  const keys = useKeymap((s) => shortcut ? s.resolved.labels[shortcut] : '')
  const aria = useKeymap((s) => shortcut ? s.resolved.aria[shortcut] : '')
  const title = keys ? `${label} (${keys})` : label
  return <button type="button" tabIndex={-1} {...props} aria-label={label} aria-keyshortcuts={aria || undefined}
    aria-disabled={disabled || undefined} data-tooltip={title}
    onClick={(e) => { if (!disabled) onClick?.(e) }}>
    {children}
  </button>
})

/** A menu row; `heading` / `separator` rows are not focusable. `check` = an on / off row (else `checked` = a radio). */
export interface ToolbarMenuItem {
  id: string; label: string; run?: () => void; disabled?: boolean; checked?: boolean; check?: boolean; shortcut?: ActionId
  heading?: boolean; separator?: boolean
}

// Toolbar-only surface. Shared overlay focus and native buttons keep it replaceable by the context-menu track.
export function ToolbarMenu({ label, items, anchor, stage, side, onClose }: {
  label: string; items: ToolbarMenuItem[]; anchor: ToolbarRect; stage: ToolbarSize
  side: ReturnType<typeof toolbarSide>; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useOverlayFocus(ref)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const position = () => {
      const p = placeToolbarPanel(anchor, { w: el.offsetWidth, h: el.offsetHeight }, stage, side)
      el.style.left = `${p.x}px`
      el.style.top = `${p.y}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(el)
    return () => observer.disconnect()
  }, [anchor, stage, side])
  const first = items.findIndex((item) => !item.heading && !item.separator)
  return <>
    <div className="cv-toolbar-backdrop" onPointerDown={(e) => { e.stopPropagation(); onClose() }} />
    <div ref={ref} className="cv-menu cv-toolbar-menu material" role="menu" aria-label={label} tabIndex={-1}
      style={{ maxWidth: Math.max(0, stage.w - 24), maxHeight: Math.max(0, stage.h - 24) }}
      onKeyDown={(e) => {
        // An open menu keeps every key to itself (no global shortcut fires behind it).
        e.stopPropagation()
        if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); onClose(); return }
        toolbarArrowKey(e)
      }}>
      <div className="cv-toolbar-menu-label">{label}</div>
      {items.map((item, index) => {
        if (item.separator) return <div key={item.id} className="cv-toolbar-menu-sep" role="separator" />
        if (item.heading) return <div key={item.id} className="cv-toolbar-menu-heading" role="presentation">
          <span>{item.label}</span>{item.shortcut && <ToolbarMenuKey shortcut={item.shortcut} />}
        </div>
        const toggle = item.checked !== undefined
        return <ToolbarButton key={item.id} role={!toggle ? 'menuitem' : item.check ? 'menuitemcheckbox' : 'menuitemradio'}
          aria-checked={item.checked} tabIndex={index === first ? 0 : -1} autoFocus={index === first} label={item.label} shortcut={item.shortcut}
          disabled={item.disabled} onClick={() => { onClose(); item.run?.() }}>
          <span>{!toggle ? '' : item.check ? item.checked ? '☑ ' : '☐ ' : item.checked ? '● ' : '○ '}{item.label}</span>
          {item.shortcut && <ToolbarMenuKey shortcut={item.shortcut} />}
        </ToolbarButton>
      })}
    </div>
  </>
}

function ToolbarMenuKey({ shortcut }: { shortcut: ActionId }) {
  const keys = useKeymap((s) => s.resolved.labels[shortcut])
  return keys ? <span className="kbd">{keys}</span> : null
}
