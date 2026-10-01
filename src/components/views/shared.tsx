// Helpers shared by the table and storyboard views (vw-).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MENTION_RE } from '../../core/compile'
import type { JobStatus, Take } from '../../core/types'
import { useRuns } from '../../store/runs'

/** HTML5 drag payloads (shared contract with the sidebar / canvas): JSON arrays of asset ids / take ids. */
export const ASSET_MIME = 'application/x-bdp-assets'
export const TAKES_MIME = 'application/x-bdp-takes'
export const SCENE_MIME = 'application/x-bdp-scene'

/** Parse a JSON array of ids from a drag payload ([] when missing or malformed). */
export function readIds(raw: string): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Đang chờ',
  processing: 'Đang chạy',
  completed: 'Xong',
  failed: 'Lỗi',
  cancelled: 'Đã huỷ',
}

/** Starred completed take (newest starred), else the newest completed take. */
export function pickShowcaseTake(takes: Take[]): Take | undefined {
  let starred: Take | undefined
  let completed: Take | undefined
  for (const t of takes) {
    if (t.status !== 'completed') continue
    if (t.starred && (!starred || t.number > starred.number)) starred = t
    if (!completed || t.number > completed.number) completed = t
  }
  return starred ?? completed
}

export function starredTake(takes: Take[]): Take | undefined {
  let best: Take | undefined
  for (const t of takes) if (t.starred && t.status === 'completed' && (!best || t.number > best.number)) best = t
  return best
}

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

/** 95 → "1:35", 30 → "0:30". */
export function formatRuntime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Text with @image_N (teal), @video_N (purple) and legacy @Tag mentions highlighted, truncated to `max` characters. */
export function MentionText({ text, max }: { text: string; max?: number }) {
  const clipped = max && text.length > max ? text.slice(0, max).trimEnd() + '…' : text
  const parts: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of clipped.matchAll(MENTION_RE)) {
    const i = m.index ?? 0
    if (i > last) parts.push(clipped.slice(last, i))
    const kind = /^@image_\d+$/i.test(m[0]) ? ' image' : /^@video_\d+$/i.test(m[0]) ? ' video' : ''
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
