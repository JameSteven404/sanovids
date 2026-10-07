// What the run check makes of a gateway's SettingsLimits (what /api/video-profiles says it runs now) — pure, no stores.
// Used by store/runs check() and every one-scene Run button (through core/runGate's `settingsBlock`), so they agree.
//
//   'server' + firm   → a sure refusal: the scene cannot run (settingsRunBlock), skipped by the queue, no credit spent.
//   'fallback' / older → a warning only (settingsRunWarning): the submit reads again first and decides then.
//   'none'            → nothing (not read yet: the submit reads and decides).
import type { VideoSettings } from '../core/types'
import type { ProviderId, SettingsLimits } from './types'

/** A refusal text as a short reason (the run gate's reasons carry no final period). */
const bare = (text: string) => text.replace(/\.\s*$/, '')

/** The gateway's sure refusal of `s` (the first reason of a firm 'server' read, without its final '.'), else null. */
export function settingsRunBlock(limits: SettingsLimits, s: VideoSettings): string | null {
  if (limits.source !== 'server' || !limits.firm) return null
  const issue = limits.issues(s)[0]
  return issue ? bare(issue.reason) : null
}

/** What the submit may still refuse in `s` when SanoVids is not sure (a guess or an older read): one line, else null. */
export function settingsRunWarning(limits: SettingsLimits, s: VideoSettings): string | null {
  if (limits.source === 'none' || (limits.source === 'server' && limits.firm)) return null
  const issues = limits.issues(s)
  if (!issues.length) return null
  const why =
    limits.source === 'fallback'
      ? 'chưa đọc được cấu hình model nên đang theo cấu hình mặc định như trang canvasapp'
      : 'theo lần đọc cấu hình model trước, SanoVids đọc lại trước khi gửi'
  return `Có thể bị từ chối khi gửi (không tốn credit): ${issues.map((i) => bare(i.reason)).join('; ')} — ${why}`
}

/** How the UI names the site whose limits these are: the real canvasapp, or its simulation in development mode. */
export function limitsSite(id: ProviderId): { short: string; full: string } {
  return id === 'dev' ? { short: 'canvasapp giả lập', full: 'canvasapp giả lập (chế độ Phát triển)' } : { short: 'canvasapp', full: 'canvasapp.io.vn' }
}
