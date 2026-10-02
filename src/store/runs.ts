// Takes (generation attempts) and the job queue. Not undoable.
// The queue engine talks to video providers only through providers/types.ts (VideoProvider):
//   queued → submit(request) → remoteId stored on the take → poll(remoteIds) → fetchResult → putBlob → completed.
// The mock (demo) provider is the default; the canvasapp gateway is opt-in (desktop only, see docs/GATEWAY-CANVASAPP.md).
import { create } from 'zustand'
import { compileScene, imageSlotsFor, sceneCode, takeCode } from '../core/compile'
import { newId } from '../core/ids'
import { costOf, MODELS, usesRefs, usesVideoRefs } from '../core/models'
import { migrateTake } from '../core/migrate'
import type { Scene, Size, Take, XY } from '../core/types'
import { useDownloadPrefs } from '../lib/downloads'
import { putBlob } from '../lib/imageStore'
import { activeProviderId, getProvider, providerBlockedReason, registerProvider } from '../providers'
import { createMockProvider, DEFAULT_MOCK_SETTINGS, type MockSettings } from '../providers/mock'
import { posterFromVideo } from '../providers/poster'
import { providerOf, type JobFrame, type JobRequest, type ProviderId, type RemoteStatus, type RunTake } from '../providers/types'
import { clampSize, useProject } from './project'

export type { MockSettings, MockSpeed } from '../providers/mock'

export interface EnqueueResult {
  queued: number
  cost: number
  skipped: { sceneId: string; reason: string }[]
  error?: string
}

export interface SceneRunCheck {
  sceneId: string
  ok: boolean
  reason: string | null
  cost: number
  warnings: string[]
}

/** A provider-level problem (e.g. canvasapp session expired). Running takes are kept and polling resumes later. */
export interface ProviderIssue {
  provider: ProviderId
  code: string
  message: string
  at: number
}

export interface RunsState {
  takes: Take[]
  credits: number
  spent: number
  mock: MockSettings
  /** Last provider problem while polling (null = all good). UI may show it; cleared by the next successful poll. */
  providerIssue: ProviderIssue | null

  loadRuns: (data: { takes: Take[]; credits: number; spent: number } | null) => void
  /** Validate scenes before running (used by the confirm dialog). */
  check: (sceneIds: string[]) => SceneRunCheck[]
  enqueue: (sceneIds: string[]) => EnqueueResult
  cancel: (takeId: string) => void
  retry: (takeId: string) => EnqueueResult | null
  toggleStar: (takeId: string) => void
  removeTake: (takeId: string) => void
  /** Delete takes (cancelling running ones) and drop them from every scene's @video refs. */
  removeTakes: (takeIds: string[]) => void
  /** Canvas positions of take nodes (null = back to auto placement). */
  setTakePositions: (positions: Record<string, XY | null>) => void
  /** Canvas sizes of take nodes (null = default size). */
  setTakeSizes: (sizes: Record<string, Size | null>) => void
  setMock: (patch: Partial<MockSettings>) => void
  addCredits: (n: number) => void
}

// ---------------------------------------------------------------------------------------------
// Engine state (module level, not persisted)
// ---------------------------------------------------------------------------------------------

const TICK_MS = 200
/** Floor for remote providers, whatever they declare (canvasapp's own site polls every 60 s). */
const MIN_REMOTE_POLL_MS = 15_000
/** Hard cap for remote providers. */
const MAX_REMOTE_CONCURRENCY = 2

let engine: ReturnType<typeof setInterval> | null = null
/** Takes whose submit() is in flight. */
const submitting = new Set<string>()
/** Takes whose result is being downloaded / rendered. */
const fetching = new Set<string>()
/** Providers with a poll() in flight. */
const polling = new Set<ProviderId>()
const lastPoll = new Map<ProviderId, number>()
/** Back-off after poll errors: provider → time before which we don't poll again. */
const pollPausedUntil = new Map<ProviderId, number>()
const pollFailures = new Map<ProviderId, number>()
/** Bumped by loadRuns: async work started for a previous project is ignored. */
let generation = 0

function savedMock(): MockSettings {
  try {
    const raw = localStorage.getItem('bdp:pref:mock')
    if (raw) return { ...DEFAULT_MOCK_SETTINGS, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_MOCK_SETTINGS }
}

const mockProvider = createMockProvider(() => useRuns.getState().mock)
registerProvider(mockProvider)

const isCharged = (t: Take) => (t as RunTake).charged !== false
const remoteIdOf = (t: Take) => (t as RunTake).remoteId ?? null

export const useRuns = create<RunsState>()((set, get) => ({
  takes: [],
  credits: 377,
  spent: 0,
  mock: savedMock(),
  providerIssue: null,

  loadRuns: (data) => {
    resetEngineState()
    // Demo jobs that were running when the page closed restart from the queue. Jobs already accepted by a remote
    // provider keep their remote id and resume polling (never submitted twice — that would cost twice).
    const takes = (data?.takes ?? []).map(migrateTake).map((t): Take => {
      if (t.status !== 'processing') return t
      if (providerOf(t) !== 'mock' && remoteIdOf(t)) return t
      return { ...t, status: 'queued', progress: 0, startedAt: null, remoteId: null } as RunTake
    })
    set({ takes, credits: data?.credits ?? 377, spent: data?.spent ?? 0, providerIssue: null })
    ensureEngine()
  },

  check: (sceneIds) => {
    const project = useProject.getState().project
    const providerId = activeProviderId()
    return sceneIds
      .map((id) => project.scenes.find((s) => s.id === id))
      .filter((s): s is Scene => !!s)
      .map((scene) => {
        const takes = get().takes
        const compiled = compileScene(project, scene, { takeStatus: (id) => takes.find((t) => t.id === id)?.status })
        let reason: string | null = null
        if (!scene.prompt.trim()) reason = 'Prompt trống'
        else if (compiled.charCount > compiled.limit) reason = 'Prompt quá dài'
        else if (scene.settings.mode === 'i2v' && compiled.images.length === 0) reason = 'Thiếu ảnh tham chiếu'
        else if (scene.settings.mode === 'transform' && (!scene.firstFrame || !scene.lastFrame)) reason = 'Thiếu khung đầu/cuối'
        else if (scene.videoRefs.some((id) => takes.find((t) => t.id === id)?.status !== 'completed')) reason = 'Video tham chiếu chưa sẵn sàng'
        else if (providerId !== 'mock' && compiled.videos.length > getProvider(providerId).capabilities(scene.settings.model).maxRefVideos) {
          reason = 'Cổng canvasapp chưa hỗ trợ video tham chiếu'
        }
        return { sceneId: scene.id, ok: !reason, reason, cost: costOf(scene.settings), warnings: compiled.warnings }
      })
  },

  enqueue: (sceneIds) => {
    const project = useProject.getState().project
    const providerId = activeProviderId()
    const checks = get().check(sceneIds)
    const ok = checks.filter((c) => c.ok)
    const cost = ok.reduce((t, c) => t + c.cost, 0)
    const skipped = checks.filter((c) => !c.ok).map((c) => ({ sceneId: c.sceneId, reason: c.reason! }))
    if (!ok.length) return { queued: 0, cost: 0, skipped, error: skipped.length ? 'Không có cảnh nào chạy được.' : 'Chưa chọn cảnh nào.' }
    const blocked = providerBlockedReason(providerId)
    if (blocked) return { queued: 0, cost, skipped, error: blocked }
    // Only the demo provider spends the local demo credits; a real provider charges the user's own account.
    const chargeLocal = providerId === 'mock'
    if (chargeLocal && cost > get().credits) return { queued: 0, cost, skipped, error: `Không đủ credit: cần ${cost}, còn ${get().credits}.` }

    const now = Date.now()
    const created: RunTake[] = ok.map((c, i) => {
      const scene = project.scenes.find((s) => s.id === c.sceneId)!
      const compiled = compileScene(project, scene)
      const number = Math.max(0, ...get().takes.filter((t) => t.sceneId === scene.id).map((t) => t.number)) + 1
      return {
        id: newId('take'),
        sceneId: scene.id,
        number,
        status: 'queued',
        progress: 0,
        createdAt: now + i,
        startedAt: null,
        finishedAt: null,
        promptSnapshot: compiled.text,
        rawPromptSnapshot: scene.prompt,
        refsSnapshot: [...scene.refs],
        videoRefsSnapshot: [...scene.videoRefs],
        settings: { ...scene.settings },
        cost: c.cost,
        starred: false,
        posterId: null,
        videoId: null,
        error: null,
        position: null,
        provider: providerId,
        remoteId: null,
        charged: chargeLocal,
        framesSnapshot: { first: scene.firstFrame, last: scene.lastFrame },
      }
    })
    const charge = chargeLocal ? cost : 0
    set((s) => ({ takes: [...s.takes, ...created], credits: s.credits - charge, spent: s.spent + charge }))
    ensureEngine()
    return { queued: created.length, cost, skipped }
  },

  cancel: (takeId) => {
    const take = get().takes.find((t) => t.id === takeId)
    if (!take || (take.status !== 'queued' && take.status !== 'processing')) return
    const remoteId = remoteIdOf(take)
    if (remoteId) {
      try {
        void getProvider(providerOf(take)).cancel?.(remoteId)
      } catch {
        /* provider gone: nothing to stop */
      }
    }
    const refund = isCharged(take) ? take.cost : 0
    set((s) => ({
      takes: s.takes.map((t) => (t.id === takeId ? { ...t, status: 'cancelled', finishedAt: Date.now(), error: 'Đã huỷ' } : t)),
      credits: s.credits + refund,
      spent: s.spent - refund,
    }))
  },

  retry: (takeId) => {
    const take = get().takes.find((t) => t.id === takeId)
    if (!take) return null
    return get().enqueue([take.sceneId])
  },

  /** One chosen (starred) take per scene: starring a take un-stars its siblings. */
  toggleStar: (takeId) =>
    set((s) => {
      const target = s.takes.find((t) => t.id === takeId)
      if (!target) return s
      const next = !target.starred
      return {
        takes: s.takes.map((t) =>
          t.id === takeId ? { ...t, starred: next } : next && t.sceneId === target.sceneId && t.starred ? { ...t, starred: false } : t,
        ),
      }
    }),
  removeTake: (takeId) => get().removeTakes([takeId]),
  removeTakes: (takeIds) => {
    const dead = new Set(takeIds)
    const project = useProject.getState().project
    const labels: Record<string, string> = {}
    for (const t of get().takes) {
      if (!dead.has(t.id)) continue
      labels[t.id] = 'video ' + takeCode(project.scenes.find((s) => s.id === t.sceneId)?.order, t.number)
      get().cancel(t.id)
    }
    set((s) => ({ takes: s.takes.filter((t) => !dead.has(t.id)) }))
    useProject.getState().removeTakesEverywhere(takeIds, labels)
  },
  setTakeSizes: (sizes) =>
    set((s) => ({ takes: s.takes.map((t) => (t.id in sizes ? { ...t, size: sizes[t.id] ? clampSize('take', sizes[t.id]!) : null } : t)) })),
  setTakePositions: (positions) =>
    set((s) => ({ takes: s.takes.map((t) => (t.id in positions ? { ...t, position: positions[t.id] } : t)) })),
  setMock: (patch) => {
    const mock = { ...get().mock, ...patch }
    try {
      localStorage.setItem('bdp:pref:mock', JSON.stringify(mock))
    } catch {
      /* ignore */
    }
    set({ mock })
  },
  addCredits: (n) => set((s) => ({ credits: s.credits + n })),
}))

// ---------------------------------------------------------------------------------------------
// Queue engine
// ---------------------------------------------------------------------------------------------

function resetEngineState() {
  generation++
  submitting.clear()
  fetching.clear()
  polling.clear()
  lastPoll.clear()
  pollPausedUntil.clear()
  pollFailures.clear()
  mockProvider.reset?.()
}

function ensureEngine() {
  if (engine) return
  engine = setInterval(tick, TICK_MS)
}

const findTake = (id: string) => useRuns.getState().takes.find((t) => t.id === id)
const stillProcessing = (id: string, gen: number) => gen === generation && findTake(id)?.status === 'processing'

function patchTake(id: string, patch: Partial<RunTake>) {
  useRuns.setState((s) => ({ takes: s.takes.map((t) => (t.id === id ? ({ ...t, ...patch } as Take) : t)) }))
}

/** Mark a running take failed, refunding demo credits when they were charged. */
function failTake(id: string, error: string, progress?: number) {
  const t = findTake(id)
  if (!t || t.status !== 'processing') return
  const refund = isCharged(t) ? t.cost : 0
  useRuns.setState((s) => ({
    takes: s.takes.map((x) => (x.id === id ? { ...x, status: 'failed', finishedAt: Date.now(), error, progress: progress ?? x.progress } : x)),
    credits: s.credits + refund,
    spent: s.spent - refund,
  }))
}

function concurrencyFor(pid: ProviderId): number {
  if (pid === 'mock') return Math.max(1, useRuns.getState().mock.concurrency)
  try {
    return Math.max(1, Math.min(MAX_REMOTE_CONCURRENCY, getProvider(pid).capabilities('seedance_2_5').maxConcurrency))
  } catch {
    return 1
  }
}

function pollIntervalFor(pid: ProviderId): number {
  if (pid === 'mock') return 0
  try {
    return Math.max(MIN_REMOTE_POLL_MS, getProvider(pid).capabilities('seedance_2_5').pollIntervalMs)
  } catch {
    return MIN_REMOTE_POLL_MS
  }
}

function tick() {
  const { takes } = useRuns.getState()
  const active = takes.filter((t) => t.status === 'processing')
  const queued = takes.filter((t) => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)
  if (!active.length && !queued.length) {
    if (engine) clearInterval(engine)
    engine = null
    return
  }
  const now = Date.now()

  // Start queued jobs up to each provider's concurrency cap.
  const running = new Map<ProviderId, number>()
  for (const t of active) running.set(providerOf(t), (running.get(providerOf(t)) ?? 0) + 1)
  const started: Take[] = []
  for (const t of queued) {
    const pid = providerOf(t)
    const n = running.get(pid) ?? 0
    if (n >= concurrencyFor(pid)) continue
    running.set(pid, n + 1)
    started.push(t)
  }
  if (started.length) {
    const ids = new Set(started.map((t) => t.id))
    useRuns.setState((s) => ({ takes: s.takes.map((t) => (ids.has(t.id) ? { ...t, status: 'processing', startedAt: now, progress: 1 } : t)) }))
    for (const t of started) void submitTake(t.id)
  }

  // Running takes without a remote id (submit lost, e.g. engine restarted) are submitted again with the same
  // idempotency key (take id).
  for (const t of active) if (!remoteIdOf(t) && !submitting.has(t.id) && !fetching.has(t.id)) void submitTake(t.id)

  // Poll each provider that has submitted, unfinished takes.
  const due = new Map<ProviderId, string[]>()
  for (const t of active) {
    const rid = remoteIdOf(t)
    if (!rid || fetching.has(t.id)) continue
    const pid = providerOf(t)
    due.set(pid, [...(due.get(pid) ?? []), rid])
  }
  for (const [pid, rids] of due) {
    if (polling.has(pid)) continue
    if (now < (pollPausedUntil.get(pid) ?? 0)) continue
    if (now - (lastPoll.get(pid) ?? 0) < pollIntervalFor(pid)) continue
    lastPoll.set(pid, now)
    polling.add(pid)
    const gen = generation
    void pollProvider(pid, rids, gen).finally(() => {
      if (gen === generation) polling.delete(pid)
    })
  }
}

/** Request for a take, built from its snapshot (refs, video refs, frames) and the current media of those assets. */
function buildRequest(t: Take): JobRequest {
  const project = useProject.getState().project
  const scene = project.scenes.find((s) => s.id === t.sceneId)
  const spec = MODELS[t.settings.model] ?? MODELS.seedance_2_5
  const takes = useRuns.getState().takes
  const images = usesRefs(t.settings)
    ? imageSlotsFor(project.assets, t.refsSnapshot)
        .slice(0, spec.maxRefImages)
        .map(({ n, assetId, imageId }) => ({ n, assetId, imageId }))
    : []
  const videos = usesVideoRefs(t.settings)
    ? t.videoRefsSnapshot.slice(0, spec.maxRefVideos).map((takeId, i) => {
        const v = takes.find((x) => x.id === takeId)
        return { n: i + 1, takeId, videoId: v?.videoId ?? null, posterId: v?.posterId ?? null }
      })
    : []
  const frames = (t as RunTake).framesSnapshot ?? { first: scene?.firstFrame ?? null, last: scene?.lastFrame ?? null }
  const frame = (assetId: string | null): JobFrame | null => {
    if (!assetId || t.settings.mode !== 'transform') return null
    const imageId = project.assets.find((a) => a.id === assetId)?.imageIds[0]
    return imageId ? { assetId, imageId } : null
  }
  return {
    key: t.id,
    takeId: t.id,
    sceneId: t.sceneId,
    sceneCode: scene ? sceneCode(scene.order) : 'S??',
    takeNumber: t.number,
    title: scene?.title ?? '',
    color: scene?.color ?? '#e8894a',
    model: t.settings.model,
    mode: t.settings.mode,
    duration: t.settings.duration,
    resolution: t.settings.resolution,
    ratio: t.settings.ratio,
    prompt: t.promptSnapshot,
    rawPrompt: t.rawPromptSnapshot,
    images,
    videos,
    firstFrame: frame(frames.first),
    lastFrame: frame(frames.last),
    startedAt: t.startedAt ?? Date.now(),
  }
}

async function submitTake(id: string) {
  const gen = generation
  const t = findTake(id)
  if (!t || submitting.has(id)) return
  submitting.add(id)
  const pid = providerOf(t)
  try {
    const provider = getProvider(pid)
    const { remoteId } = await provider.submit(buildRequest(t))
    if (!stillProcessing(id, gen)) {
      // Cancelled / removed while submitting: stop it at the provider when possible.
      void provider.cancel?.(remoteId)
      return
    }
    patchTake(id, { remoteId })
  } catch (e) {
    if (gen === generation) failTake(id, errorText(e))
  } finally {
    if (gen === generation) submitting.delete(id)
  }
}

async function pollProvider(pid: ProviderId, remoteIds: string[], gen: number) {
  let statuses: RemoteStatus[]
  try {
    statuses = await getProvider(pid).poll(remoteIds)
  } catch (e) {
    if (gen !== generation) return
    // Keep the takes running; back off (1 min, 2 min, … max 10 min) and tell the UI.
    const n = (pollFailures.get(pid) ?? 0) + 1
    pollFailures.set(pid, n)
    pollPausedUntil.set(pid, Date.now() + Math.min(10, 2 ** (n - 1)) * 60_000)
    useRuns.setState({ providerIssue: { provider: pid, code: (e as { code?: string })?.code ?? 'error', message: errorText(e), at: Date.now() } })
    return
  }
  if (gen !== generation) return
  pollFailures.delete(pid)
  pollPausedUntil.delete(pid)
  if (useRuns.getState().providerIssue?.provider === pid) useRuns.setState({ providerIssue: null })

  const byRemote = new Map(
    useRuns
      .getState()
      .takes.filter((t) => t.status === 'processing' && providerOf(t) === pid && remoteIdOf(t))
      .map((t) => [remoteIdOf(t)!, t]),
  )
  const progress = new Map<string, number>()
  for (const st of statuses) {
    const t = byRemote.get(st.remoteId)
    if (!t || fetching.has(t.id)) continue
    switch (st.state) {
      case 'queued':
      case 'processing': {
        const p = Math.max(1, Math.min(99, Math.round(st.progress ?? t.progress)))
        if (p !== t.progress) progress.set(t.id, p)
        break
      }
      case 'failed':
        failTake(t.id, st.error || 'Nhà cung cấp báo lỗi.', st.progress)
        break
      case 'cancelled': {
        const refund = isCharged(t) ? t.cost : 0
        useRuns.setState((s) => ({
          takes: s.takes.map((x) => (x.id === t.id ? { ...x, status: 'cancelled', finishedAt: Date.now(), error: 'Nhà cung cấp đã huỷ job' } : x)),
          credits: s.credits + refund,
          spent: s.spent - refund,
        }))
        break
      }
      case 'completed':
        fetching.add(t.id)
        if (t.progress !== 99) progress.set(t.id, 99)
        void finishTake(t.id, st.remoteId, gen)
        break
    }
  }
  if (progress.size) useRuns.setState((s) => ({ takes: s.takes.map((t) => (progress.has(t.id) && t.status === 'processing' ? { ...t, progress: progress.get(t.id)! } : t)) }))
}

async function finishTake(id: string, remoteId: string, gen: number) {
  const t = findTake(id)
  try {
    if (!t) return
    const result = await getProvider(providerOf(t)).fetchResult(remoteId)
    if (!stillProcessing(id, gen)) return // cancelled meanwhile
    const poster = result.poster ?? (result.video ? await posterFromVideo(result.video) : null)
    const posterId = poster ? await putBlob(poster, 'poster') : null
    const videoId = result.video ? await putBlob(result.video, 'video') : null
    if (!stillProcessing(id, gen)) return
    patchTake(id, { status: 'completed', progress: 100, finishedAt: Date.now(), posterId, videoId })
    if (useDownloadPrefs.getState().autoDownload) {
      // Lazy import avoids a static cycle (actions imports this store).
      void import('../actions').then(({ downloadTake }) => downloadTake(id, { auto: true }))
    }
  } catch (e) {
    if (gen === generation) failTake(id, errorText(e))
  } finally {
    if (gen === generation) fetching.delete(id)
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  return String(e ?? 'Lỗi không rõ')
}

/** Selectors */
export const takesOf = (sceneId: string) => (s: RunsState) => s.takes.filter((t) => t.sceneId === sceneId)
export const latestTake = (takes: Take[], sceneId: string) =>
  takes.filter((t) => t.sceneId === sceneId).sort((a, b) => b.number - a.number)[0]
export const activeCount = (s: RunsState) => s.takes.filter((t) => t.status === 'queued' || t.status === 'processing').length

// ---- React hooks with stable selections (zustand v5 needs useShallow for derived arrays) ----
import { useShallow } from 'zustand/react/shallow'

export function useSceneTakes(sceneId: string): Take[] {
  return useRuns(useShallow((s) => s.takes.filter((t) => t.sceneId === sceneId)))
}
export function useActiveCount(): number {
  return useRuns(activeCount)
}
