// Small helpers shared by the runs area (queue drawer, take strip, take viewer, run dialog).
import { Ban, CircleAlert, CircleCheck, Cloud, Clock, LoaderCircle, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { JobStatus, Take, VideoSettings } from '../../core/types'
import { getBlob } from '../../lib/imageStore'
import { activeProviderId, PROVIDER_LABEL, providerOf, useProviderPrefs, type ProviderId } from '../../providers'
import { useRuns } from '../../store/runs'

// ---- providers (Demo giả lập | canvasapp.io.vn) ----

/** Provider that NEW takes will use (see providers/index activeProviderId); re-renders when Settings change it. */
export function useActiveProvider(): ProviderId {
  useProviderPrefs((s) => s.provider)
  return activeProviderId()
}

// Credit amounts: lib/credits formatCredits / formatVnd and ./creditText (which wallet paid a take).

const PROVIDER_SHORT: Record<ProviderId, string> = { mock: 'Demo', canvasapp: 'canvasapp' }

/** Small chip naming the provider a take ran on (queue rows, take viewer). */
export function ProviderBadge({ take, provider }: { take?: Pick<Take, 'provider'>; provider?: ProviderId }) {
  const id = provider ?? (take ? providerOf(take) : 'mock')
  return (
    <span
      className={`rq-prov ${id}`}
      title={id === 'mock' ? 'Demo giả lập — video giả, trả bằng credit demo (không phải tiền thật)' : `${PROVIDER_LABEL[id]} — video thật, trả bằng credit canvasapp của tài khoản bạn`}
    >
      {id === 'mock' ? <Sparkles size={10} /> : <Cloud size={10} />}
      {PROVIDER_SHORT[id]}
    </span>
  )
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Đang chờ',
  processing: 'Đang tạo',
  completed: 'Hoàn thành',
  failed: 'Lỗi',
  cancelled: 'Đã huỷ',
}

export function isActive(t: Pick<Take, 'status'>): boolean {
  return t.status === 'queued' || t.status === 'processing'
}

/** 8 s -> "0:08", 83 s -> "1:23", 3723 s -> "1:02:03". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Clock time; adds the date when it is not today. */
export function formatClock(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const time = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return time
  return `${time} · ${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}`
}

/** Elapsed time shown for a take: waiting time when queued, running time when processing, render time when finished. */
export function takeElapsed(t: Take, now: number): number | null {
  if (t.status === 'queued') return now - t.createdAt
  if (t.status === 'processing') return t.startedAt ? now - t.startedAt : null
  if (t.startedAt && t.finishedAt) return t.finishedAt - t.startedAt
  return null
}

/** Re-renders every `ms` while `active` (for live elapsed timers). */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [active, ms])
  return now
}

export function sameSettings(a: VideoSettings, b: VideoSettings): boolean {
  return a.model === b.model && a.mode === b.mode && a.duration === b.duration && a.resolution === b.resolution && a.ratio === b.ratio
}

/**
 * ★ = THE take chosen for its scene (Storyboard / Phát liền use it), so starring a take un-stars the
 * scene's other takes. Un-starring is a plain toggle.
 */
export function toggleChosenTake(takeId: string) {
  const { takes, toggleStar } = useRuns.getState()
  const take = takes.find((t) => t.id === takeId)
  if (!take) return
  if (!take.starred) {
    for (const t of takes) if (t.sceneId === take.sceneId && t.starred && t.id !== take.id) toggleStar(t.id)
  }
  toggleStar(take.id)
}

function extOf(blob: Blob, fallback: string): string {
  const t = blob.type
  if (t.includes('webm')) return 'webm'
  if (t.includes('mp4')) return 'mp4'
  if (t.includes('png')) return 'png'
  if (t.includes('webp')) return 'webp'
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  if (t.includes('svg')) return 'svg'
  return fallback
}

/** Download a stored blob as `<baseName>.<ext>`. Returns false when the blob is missing. */
export async function downloadMedia(id: string, baseName: string, fallbackExt: string): Promise<boolean> {
  const blob = await getBlob(id)
  if (!blob) return false
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${baseName.replace(/[<>:"/\\|?*]/g, '-')}.${extOf(blob, fallbackExt)}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return true
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'VIDEO' || el.isContentEditable
}

export function StatusIcon({ status, size = 13 }: { status: JobStatus; size?: number }) {
  switch (status) {
    case 'queued':
      return <Clock size={size} />
    case 'processing':
      return <LoaderCircle size={size} className="rq-spin" />
    case 'completed':
      return <CircleCheck size={size} />
    case 'failed':
      return <CircleAlert size={size} />
    default:
      return <Ban size={size} />
  }
}

export function StatusBadge({ take, showProgress = true }: { take: Pick<Take, 'status' | 'progress'>; showProgress?: boolean }) {
  return (
    <span className={`rq-badge ${take.status}`}>
      <StatusIcon status={take.status} size={11} />
      {STATUS_LABEL[take.status]}
      {showProgress && take.status === 'processing' ? <span className="mono">{take.progress}%</span> : null}
    </span>
  )
}

/** Prompt text with @image_N (teal) and @video_N (purple) tokens highlighted. */
export function HighlightedPrompt({ text }: { text: string }) {
  const parts = text.split(/(@(?:image|video)_\d+)\b/gi)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className={/^@video/i.test(p) ? 'rq-tok video' : 'rq-tok'}>
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  )
}

/** Paragraph-level diff between two prompts (blank-line separated). */
export function paragraphDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const split = (s: string) =>
    s
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
  const a = split(before)
  const b = split(after)
  const setA = new Set(a)
  const setB = new Set(b)
  return { removed: a.filter((p) => !setB.has(p)), added: b.filter((p) => !setA.has(p)) }
}
