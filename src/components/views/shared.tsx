// Helpers shared by the table and storyboard views (vw-).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { MENTION_RE } from '../../core/compile'

/** A numbered token in any spelling ("@image_1", "@Image 1") or a legacy @Tag mention. */
const MENTION_OR_TOKEN_RE = new RegExp(`@(?:image|video)[ _]?\\d+(?![\\p{L}\\p{N}_])|${MENTION_RE.source}`, 'giu')
import type { JobStatus, Take } from '../../core/types'
import { useRuns } from '../../store/runs'

// Asset / take drag payloads (ASSETS_MIME, TAKES_MIME, readIds) live in src/lib/dnd.ts — shared with the
// library, canvas and prompt editor. Only the table's own row-reorder payload is defined here.
/** Scene id being reordered with the table's drag handle. */
export const SCENE_MIME = 'application/x-bdp-scene'

/**
 * Window key handlers of a view must only act while the view is the area the user works in: focus inside `root`,
 * or nothing focused (body) and the last click landed in it. With focus in the Inspector, library, queue or top
 * bar the keys belong to those (scrolling, ↑/↓ on a reference grip…).
 */
export function useKeyboardArea(root: RefObject<HTMLElement | null>): (target: EventTarget | null) => boolean {
  const pointerInside = useRef(true)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      pointerInside.current = !!root.current && e.target instanceof Node && root.current.contains(e.target)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [root])
  return useCallback(
    (target: EventTarget | null) => {
      if (!(target instanceof Node) || target === document.body || target === document.documentElement) return pointerInside.current
      return !!root.current?.contains(target)
    },
    [root],
  )
}

/** Ctrl/Cmd+A without other modifiers. */
export const isSelectAllKey = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a'

/** Focus is in a text field (or an open menu): keys belong to it. */
export function isEditingTarget(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null
  return !!t?.closest?.('input:not([type="checkbox"]), textarea, select, [contenteditable="true"], [role="menu"]')
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Đang chờ',
  processing: 'Đang chạy',
  completed: 'Xong',
  failed: 'Lỗi',
  cancelled: 'Đã huỷ',
}

// Moved to core/filmItems (the "Phát liền" player lives outside this hidden folder); re-exported for the frozen
// Storyboard.
export { formatRuntime, pickShowcaseTake, starredTake } from '../../core/filmItems'

export function latestOf(takes: Take[]): Take | undefined {
  let best: Take | undefined
  for (const t of takes) if (!best || t.number > best.number) best = t
  return best
}

/** All takes grouped by scene id. Recomputed only when the takes array changes. */
export function useTakesByScene(): Map<string, Take[]> {
  const takes = useRuns((s) => s.takes)
  return useMemo(() => {
    const map = new Map<string, Take[]>()
    for (const t of takes) {
      const list = map.get(t.sceneId)
      if (list) list.push(t)
      else map.set(t.sceneId, [t])
    }
    return map
  }, [takes])
}

/** Text with @image_N (teal), @video_N (purple) and legacy @Tag mentions highlighted, truncated to `max` characters. */
export function MentionText({ text, max }: { text: string; max?: number }) {
  const clipped = max && text.length > max ? text.slice(0, max).trimEnd() + '…' : text
  const parts: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of clipped.matchAll(MENTION_OR_TOKEN_RE)) {
    const i = m.index ?? 0
    if (i > last) parts.push(clipped.slice(last, i))
    const kind = /^@image[ _]?\d+$/i.test(m[0]) ? ' image' : /^@video[ _]?\d+$/i.test(m[0]) ? ' video' : ''
    parts.push(
      <span key={k++} className={`vw-mention${kind}`}>
        {m[0]}
      </span>,
    )
    last = i + m[0].length
  }
  if (last < clipped.length) parts.push(clipped.slice(last))
  return <>{parts}</>
}

/** Button + dropdown panel. Closes on outside click and Escape (Escape does not reach global shortcuts). */
export function MenuButton({
  label,
  children,
  className = 'btn btn-sm',
  disabled,
  title,
  align = 'left',
  width = 280,
}: {
  label: ReactNode
  children: (close: () => void) => ReactNode
  className?: string
  disabled?: boolean
  title?: string
  align?: 'left' | 'right'
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <div className="vw-menu-wrap" ref={ref}>
      <button className={`${className} ${open ? 'open' : ''}`} disabled={disabled} title={title} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {label}
      </button>
      {open && (
        <div className={`vw-menu ${align}`} style={{ width }} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
