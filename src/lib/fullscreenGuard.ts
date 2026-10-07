import { escapeDecision } from '../core/transportKeys'
export { escapeDecision } from '../core/transportKeys'

let exitedAt = -Infinity

/** One mount in useShortcuts; players also keep their own capture guards ahead of Modal. */
export function trackFullscreen(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const changed = () => { if (!document.fullscreenElement) exitedAt = performance.now() }
  document.addEventListener('fullscreenchange', changed)
  return () => document.removeEventListener('fullscreenchange', changed)
}

export function escapeForFullscreen(e: KeyboardEvent): boolean {
  if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || typeof document === 'undefined') return false
  const decision = escapeDecision({ fullscreen: !!document.fullscreenElement, exitedAt, now: performance.now() })
  if (decision === 'normal') return false
  e.preventDefault()
  e.stopImmediatePropagation()
  if (decision === 'exit-fullscreen') void document.exitFullscreen().catch(() => undefined)
  return true
}
