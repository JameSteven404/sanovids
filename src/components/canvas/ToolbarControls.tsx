import { memo, useLayoutEffect, useRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import type { ActionId } from '../../core/keymap'
import { useKeymap } from '../../lib/keymapPrefs'
import { useOverlayFocus } from '../common/focus'
import { placeToolbarPanel, type ToolbarRect, type ToolbarSize, type toolbarSide } from './toolbarModel'

/** Only the navigation keys stop here: N, C, Delete, Ctrl+Z… still reach the global shortcuts after a toolbar click. */
export function toolbarArrowKey(e: KeyboardEvent<HTMLElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
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

export interface ToolbarMenuItem {
  id: string; label: string; run: () => void; disabled?: boolean; checked?: boolean; shortcut?: ActionId
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
      {items.map((item, index) => <ToolbarButton key={item.id} role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
        aria-checked={item.checked} tabIndex={index === 0 ? 0 : -1} autoFocus={index === 0} label={item.label} shortcut={item.shortcut}
        disabled={item.disabled} onClick={() => { onClose(); item.run() }}>
        <span>{item.checked === undefined ? '' : item.checked ? '● ' : '○ '}{item.label}</span>
        {item.shortcut && <ToolbarMenuKey shortcut={item.shortcut} />}
      </ToolbarButton>)}
    </div>
  </>
}

function ToolbarMenuKey({ shortcut }: { shortcut: ActionId }) {
  const keys = useKeymap((s) => s.resolved.labels[shortcut])
  return keys ? <span className="kbd">{keys}</span> : null
}
