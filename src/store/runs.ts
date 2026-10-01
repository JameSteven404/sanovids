// Takes (generation attempts) and the demo job queue. Not undoable.
// The queue engine is provider-agnostic in shape: today it drives the mock provider.
import { create } from 'zustand'
import { compileScene, sceneCode } from '../core/compile'
import { newId } from '../core/ids'
import { costOf, settingsLabel } from '../core/models'
import type { Scene, Take } from '../core/types'
import { renderMockTake } from '../lib/mockProvider'
import { useProject } from './project'

export type MockSpeed = 'fast' | 'normal' | 'slow'
export interface MockSettings {
  speed: MockSpeed
  /** 0..1 probability that a job fails (to test error UI). */
  failRate: number
  concurrency: number
  recordVideo: boolean
}

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

export interface RunsState {
  takes: Take[]
  credits: number
  spent: number
  mock: MockSettings

  loadRuns: (data: { takes: Take[]; credits: number; spent: number } | null) => void
  /** Validate scenes before running (used by the confirm dialog). */
  check: (sceneIds: string[]) => SceneRunCheck[]
  enqueue: (sceneIds: string[]) => EnqueueResult
  cancel: (takeId: string) => void
  retry: (takeId: string) => EnqueueResult | null
  toggleStar: (takeId: string) => void
  removeTake: (takeId: string) => void
  setMock: (patch: Partial<MockSettings>) => void
  addCredits: (n: number) => void
}

const SPEED_MS: Record<MockSpeed, [number, number]> = { fast: [3000, 6000], normal: [9000, 16000], slow: [22000, 38000] }
const FAIL_MESSAGES = [
  'Nhà cung cấp từ chối nội dung (demo).',
  'Hết thời gian chờ từ nhà cung cấp (demo).',
  'Ảnh tham chiếu không hợp lệ (demo).',
]

const plans = new Map<string, { total: number; fail: boolean; start: number }>()
let engine: ReturnType<typeof setInterval> | null = null
const rendering = new Set<string>()

function savedMock(): MockSettings {
  try {
    const raw = localStorage.getItem('bdp:pref:mock')
    if (raw) return { speed: 'fast', failRate: 0.1, concurrency: 3, recordVideo: true, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { speed: 'fast', failRate: 0.1, concurrency: 3, recordVideo: true }
}

export const useRuns = create<RunsState>()((set, get) => ({
  takes: [],
  credits: 377,
  spent: 0,
  mock: savedMock(),

  loadRuns: (data) => {
    plans.clear()
    // Anything that was running when the page closed restarts from the queue.
    const takes = (data?.takes ?? []).map((t) => (t.status === 'processing' ? { ...t, status: 'queued' as const, progress: 0, startedAt: null } : t))
    set({ takes, credits: data?.credits ?? 377, spent: data?.spent ?? 0 })
    ensureEngine()
  },

  check: (sceneIds) => {
    const project = useProject.getState().project
    return sceneIds
      .map((id) => project.scenes.find((s) => s.id === id))
      .filter((s): s is Scene => !!s)
      .map((scene) => {
        const compiled = compileScene(project, scene)
        let reason: string | null = null
        if (!scene.prompt.trim()) reason = 'Prompt trống'
        else if (compiled.charCount > compiled.limit) reason = 'Prompt quá dài'
        else if (scene.settings.mode === 'i2v' && compiled.images.length === 0) reason = 'Thiếu ảnh tham chiếu'
        else if (scene.settings.mode === 'transform' && (!scene.firstFrame || !scene.lastFrame)) reason = 'Thiếu khung đầu/cuối'
        return { sceneId: scene.id, ok: !reason, reason, cost: costOf(scene.settings), warnings: compiled.warnings }
      })
  },

  enqueue: (sceneIds) => {
    const project = useProject.getState().project
    const checks = get().check(sceneIds)
    const ok = checks.filter((c) => c.ok)
    const cost = ok.reduce((t, c) => t + c.cost, 0)
    const skipped = checks.filter((c) => !c.ok).map((c) => ({ sceneId: c.sceneId, reason: c.reason! }))
    if (!ok.length) return { queued: 0, cost: 0, skipped, error: skipped.length ? 'Không có cảnh nào chạy được.' : 'Chưa chọn cảnh nào.' }
    if (cost > get().credits) return { queued: 0, cost, skipped, error: `Không đủ credit: cần ${cost}, còn ${get().credits}.` }

    const now = Date.now()
    const created: Take[] = ok.map((c, i) => {
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
        settings: { ...scene.settings },
        cost: c.cost,
        starred: false,
        posterId: null,
        videoId: null,
        error: null,
      }
    })
    set((s) => ({ takes: [...s.takes, ...created], credits: s.credits - cost, spent: s.spent + cost }))
    ensureEngine()
    return { queued: created.length, cost, skipped }
  },

  cancel: (takeId) => {
    const take = get().takes.find((t) => t.id === takeId)
    if (!take || (take.status !== 'queued' && take.status !== 'processing')) return
    plans.delete(takeId)
    set((s) => ({
      takes: s.takes.map((t) => (t.id === takeId ? { ...t, status: 'cancelled', finishedAt: Date.now(), error: 'Đã huỷ' } : t)),
      credits: s.credits + take.cost,
      spent: s.spent - take.cost,
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
  removeTake: (takeId) => {
    get().cancel(takeId)
    plans.delete(takeId)
    set((s) => ({ takes: s.takes.filter((t) => t.id !== takeId) }))
  },
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

function ensureEngine() {
  if (engine) return
  engine = setInterval(tick, 200)
}

function tick() {
  const state = useRuns.getState()
  const { takes, mock } = state
  const active = takes.filter((t) => t.status === 'processing')
  const queued = takes.filter((t) => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)
  if (!active.length && !queued.length) {
    if (engine) clearInterval(engine)
    engine = null
    return
  }

  const updates = new Map<string, Partial<Take>>()
  // Start queued jobs up to the concurrency cap.
  const free = Math.max(0, mock.concurrency - active.length)
  for (const t of queued.slice(0, free)) {
    const [lo, hi] = SPEED_MS[mock.speed]
    plans.set(t.id, { total: lo + Math.random() * (hi - lo), fail: Math.random() < mock.failRate, start: Date.now() })
    updates.set(t.id, { status: 'processing', startedAt: Date.now(), progress: 1 })
  }
  // Advance running jobs.
  for (const t of active) {
    let plan = plans.get(t.id)
    if (!plan) {
      const [lo, hi] = SPEED_MS[mock.speed]
      plan = { total: lo + Math.random() * (hi - lo), fail: false, start: t.startedAt ?? Date.now() }
      plans.set(t.id, plan)
    }
    if (rendering.has(t.id)) continue
    // Wall-clock based so background-tab timer throttling doesn't slow the demo down.
    const progress = Math.min(99, Math.round(((Date.now() - plan.start) / plan.total) * 100))
    if (plan.fail && progress >= 40 + (t.number % 5) * 10) {
      plans.delete(t.id)
      updates.set(t.id, {
        status: 'failed',
        finishedAt: Date.now(),
        progress,
        error: FAIL_MESSAGES[t.number % FAIL_MESSAGES.length],
      })
      // Refund like a real provider failure.
      useRuns.setState((s) => ({ credits: s.credits + t.cost, spent: s.spent - t.cost }))
      continue
    }
    if (progress >= 99) {
      rendering.add(t.id)
      void finish(t)
    }
    if (progress !== t.progress) updates.set(t.id, { progress })
  }
  if (updates.size) useRuns.setState((s) => ({ takes: s.takes.map((t) => (updates.has(t.id) ? { ...t, ...updates.get(t.id)! } : t)) }))
}

async function finish(take: Take) {
  const project = useProject.getState().project
  const scene = project.scenes.find((s) => s.id === take.sceneId)
  const imageIds = take.refsSnapshot.flatMap((id) => project.assets.find((a) => a.id === id)?.imageIds ?? [])
  try {
    const out = await renderMockTake({
      takeId: take.id,
      code: scene ? sceneCode(scene.order) : 'S??',
      takeNumber: take.number,
      title: scene?.title ?? '',
      prompt: take.rawPromptSnapshot,
      ratio: take.settings.ratio,
      durationLabel: settingsLabel(take.settings),
      color: scene?.color ?? '#e8894a',
      imageIds,
      recordVideo: useRuns.getState().mock.recordVideo,
    })
    const still = useRuns.getState().takes.find((t) => t.id === take.id)
    if (!still || still.status !== 'processing') return // cancelled meanwhile
    useRuns.setState((s) => ({
      takes: s.takes.map((t) =>
        t.id === take.id ? { ...t, status: 'completed', progress: 100, finishedAt: Date.now(), posterId: out.posterId, videoId: out.videoId } : t,
      ),
    }))
  } catch (e) {
    useRuns.setState((s) => ({
      takes: s.takes.map((t) => (t.id === take.id ? { ...t, status: 'failed', finishedAt: Date.now(), error: String((e as Error).message ?? e) } : t)),
      credits: s.credits + take.cost,
      spent: s.spent - take.cost,
    }))
  } finally {
    rendering.delete(take.id)
    plans.delete(take.id)
  }
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
