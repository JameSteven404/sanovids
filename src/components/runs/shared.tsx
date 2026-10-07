// Small helpers shared by the runs area (queue drawer, take strip, take viewer, run dialog).
import { Ban, Bug, CircleAlert, CircleArrowUp, CircleCheck, Cloud, Clock, LoaderCircle, Sparkles, Sprout } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { promptParts } from '../../core/compile'
import { sceneRunBlock } from '../../core/runGate'
import { sceneMapOf } from '../../core/sceneIndex'
import type { JobStatus, ModelId, Scene, Take, VideoSettings } from '../../core/types'
import { creditKindOf, type CreditKind } from '../../lib/credits'
import { getBlob } from '../../lib/imageStore'
import {
  activeProviderId,
  PROVIDER_LABEL,
  providerForModel,
  providerLimits,
  providerLimitsInfo,
  providerOf,
  refreshProviderLimits,
  useDevAllowed,
  useProviderLimits,
  useProviderPrefs,
  watchProviderLimits,
  type LimitsInfo,
  type ProviderId,
  type SettingsLimits,
} from '../../providers'
import { settingsRunBlock } from '../../providers/limits'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'

// ---- providers (Phát triển (giả lập) | canvasapp.io.vn | Demo cũ) ----

/**
 * Provider that NEW canvasapp takes will use (see providers/index activeProviderId); re-renders when Settings or the
 * lock change it. canvasapp alias: a scene's own provider is useSceneProvider(model) (seedvis routes run elsewhere).
 */
export function useActiveProvider(): ProviderId {
  useProviderPrefs((s) => s.active)
  return activeProviderId()
}

/**
 * The provider a scene of `model` runs on now (providers/index providerForModel): a primitive, re-rendered when Settings
 * or the development-mode lock change it — cheap with a card per scene.
 */
export function useSceneProvider(model: string): ProviderId {
  useProviderPrefs((s) => s.active)
  useDevAllowed()
  return providerForModel(model)
}

/** The wallet a scene of `model` is paid from (lib/credits creditKindOf of its provider): a primitive string. */
export function useWalletKind(model: string): CreditKind {
  return creditKindOf(useSceneProvider(model))
}

/**
 * @deprecated Reference videos were retired (0.6.0): no gateway takes a video, nothing asks for its cap. Always 0 (no
 * store subscription); kept so code written before the retirement still compiles.
 */
export function useGatewayRefVideoCap(_model: ModelId): number {
  return 0
}

// ---- what the gateway runs right now (/api/video-profiles; providers/index useProviderLimits) ----

/**
 * What `provider` refuses now and how it was read; re-renders only when its revision moves (a read, logout, expiry).
 * `limits` keeps its identity while what it refuses is unchanged — memo on it, not on `info`.
 */
export function useLimitsOf(provider: ProviderId): { limits: SettingsLimits; info: LimitsInfo } {
  const rev = useProviderLimits((s) => s.rev[provider] ?? 0)
  // rev: the accessors read the provider's own state, which the revision tracks
  return useMemo(() => ({ limits: providerLimits(provider), info: providerLimitsInfo(provider) }), [provider, rev])
}

/**
 * The limits of the provider NEW takes use, for a place where the user picks settings or runs (inspector settings,
 * run dialog): reads them when mounted (TTL-gated — nothing is sent while the last read is fresh, or within a minute
 * of a failed one) and keeps a firm read renewed while mounted (watchProviderLimits).
 */
export function useActiveLimits(): { provider: ProviderId; limits: SettingsLimits; info: LimitsInfo } {
  const provider = useActiveProvider()
  const { limits, info } = useLimitsOf(provider)
  useEffect(() => watchProviderLimits(provider), [provider])
  // an older read (seen as a guess) is read again: a firm one is renewed by the watcher before it gets there
  const stale = limits.source === 'server' && !limits.firm
  useEffect(() => {
    void refreshProviderLimits(provider)
  }, [provider, stale])
  return { provider, limits, info }
}

/**
 * The gateway's sure refusal of these settings (providers/limits settingsRunBlock: a firm 'server' read), or null —
 * as a string selected from the revision store, so a card per scene re-renders only when ITS answer changes.
 */
export function useSettingsRunBlock(settings: VideoSettings | undefined): string | null {
  // TODO(B3, before SEEDVIS_ENABLED flips): the limits of the scene's own provider (useSceneProvider(settings.model));
  // the active canvasapp one judges a Veo 8 s scene by canvasapp's Seedance profile and blocks it
  const provider = useActiveProvider()
  return useProviderLimits((s) => {
    void s.rev[provider]
    return settings ? settingsRunBlock(providerLimits(provider), settings) : null
  })
}

/**
 * Why a scene's Run button is off — the engine's rule list (core/runRules through core/runGate sceneRunBlock = store/
 * runs check()); null = it can run (or no scene). Pass the scene (a card that already holds it) or its id (the
 * inspector: the answer is selected as a string, so typing in the scene's prompt re-renders the caller only when the
 * answer changes). The compile is cached per scene object + assets array (core/runRules compiledOf), so a card per
 * scene stays cheap with 100+ scenes; the gateway's sure refusal of the settings changing re-reads it.
 */
export function useSceneRunBlock(target: Scene | string | undefined): string | null {
  const id = typeof target === 'string' ? target : undefined
  const given = typeof target === 'string' ? undefined : target
  // by id: the map shared by every selector of this scenes array (core/sceneIndex), never a scan per keystroke
  const pick = (scenes: readonly Scene[]) => (id === undefined ? given : sceneMapOf(scenes).get(id))
  // TODO(B3, before SEEDVIS_ENABLED flips): settingsBlock from the scene's own provider (providerForModel), as
  // useSettingsRunBlock above and store/runs check() (B2) — not the active canvasapp provider's limits
  const provider = useActiveProvider()
  // re-renders (and so re-selects below) when what the gateway refuses was read again
  useProviderLimits((s) => s.rev[provider] ?? 0)
  return useProject((s) => {
    const scene = pick(s.project.scenes)
    if (!scene) return null
    const assets = s.project.assets
    const settingsBlock = settingsRunBlock(providerLimits(provider), scene.settings)
    return sceneRunBlock(scene, assets, settingsBlock)
  })
}

// Credit amounts: lib/credits formatCredits / formatVnd and ./creditText (which wallet paid a take).

const PROVIDER_SHORT: Record<ProviderId, string> = { mock: 'Demo cũ', dev: 'DEV', canvasapp: 'canvasapp', 'seedvis-dev': 'seedvis · DEV', seedvis: 'seedvis' }

const PROVIDER_TITLE: Record<ProviderId, string> = {
  mock: 'Demo cũ — video giả, trả bằng credit demo (không phải tiền thật)',
  dev: 'Phát triển (giả lập) — canvasapp giả lập trong máy, trả bằng credit dev (không phải tiền thật)',
  canvasapp: 'canvasapp.io.vn — video thật, trả bằng credit canvasapp của tài khoản bạn',
  'seedvis-dev': 'seedvis giả lập (chế độ Phát triển) — seedvis giả lập trong máy, trả bằng credit dev seedvis (không phải tiền thật)',
  seedvis: 'seedvis.com — video thật, trả bằng credit seedvis của tài khoản bạn',
}

/** Icon of each provider's chip: a distinct generic sign per service (never a logo), simulated ones a bug. */
const PROVIDER_ICON: Record<ProviderId, ReactNode> = {
  mock: <Sparkles size={10} />,
  dev: <Bug size={10} />,
  canvasapp: <Cloud size={10} />,
  'seedvis-dev': <Bug size={10} />,
  seedvis: <Sprout size={10} />,
}

/** Chip of a take made by a newer SanoVids build's provider (Take.foreignProvider) instead of "Demo cũ". */
export const NEWER_BUILD_SHORT = 'Bản mới hơn'
export const NEWER_BUILD_TITLE = 'Tạo bằng SanoVids bản mới hơn'

/**
 * Small chip naming the provider a take ran on (queue rows, take viewer). A take of a newer build's provider
 * (migrate: provider 'mock' + foreignProvider) says "Bản mới hơn", not "Demo cũ" — pass the take for that.
 */
export function ProviderBadge({ take, provider }: { take?: Pick<Take, 'provider' | 'foreignProvider'>; provider?: ProviderId }) {
  if (!provider && take?.foreignProvider) {
    return (
      <span className="rq-prov foreign" title={NEWER_BUILD_TITLE}>
        <CircleArrowUp size={10} />
        {NEWER_BUILD_SHORT}
      </span>
    )
  }
  const id = provider ?? (take ? providerOf(take) : 'mock')
  return (
    <span
      className={`rq-prov ${id}`}
      title={PROVIDER_TITLE[id] ?? PROVIDER_LABEL[id]}
    >
      {PROVIDER_ICON[id] ?? <Cloud size={10} />}
      {PROVIDER_SHORT[id] ?? PROVIDER_LABEL[id] ?? id}
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

/** Same model, mode, duration, resolution and ratio (lives in core/models; re-exported for the runs area's imports). */
export { sameSettings } from '../../core/models'

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

/**
 * Prompt text with @image_N tokens highlighted (teal) and retired @video text marked (red, struck through: reference
 * videos were retired — such a prompt does not run; core/compile promptParts = retiredVideoTokens).
 */
export function HighlightedPrompt({ text }: { text: string }) {
  const parts = useMemo(() => promptParts(text), [text])
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          p.text
        ) : p.kind === 'retired' ? (
          <mark key={i} className="rq-tok is-retired" title={`${p.text}: video tham chiếu không còn được hỗ trợ — prompt này không chạy được cho tới khi sửa`}>
            {p.text}
          </mark>
        ) : (
          <mark key={i} className="rq-tok">
            {p.text}
          </mark>
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
