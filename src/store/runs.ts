// Takes (generation attempts) and the job queue. Not undoable.
// The queue engine talks to video providers only through providers/types.ts (VideoProvider):
//   queued → submit(request) → remoteId stored on the take → poll(remoteIds) → fetchResult → putBlob → completed.
// New takes run on 'dev' (development mode: the canvasapp gateway code against an in-app simulation, providers/dev)
// or, when chosen in the desktop app, on the real canvasapp gateway (docs/GATEWAY-CANVASAPP.md). Both are remote
// providers here (no resubmission, recovery, download retries); only their poll floor differs. The old demo ('mock')
// only runs takes saved before development mode existed.
//
// One engine per project across tabs/windows: only the tab holding the Web Lock `sanovids-engine:<projectId>`
// (store/engineLock.ts) submits and polls; other tabs just show the takes they reload from storage (store/persist.ts)
// and try again every few seconds, so one of them takes over when the running tab closes. Taking over first syncs
// with storage (persist registers `beforeTakeover`), then adopts what the previous tab left running:
//   demo jobs restart from the queue; remote jobs with a remote id resume polling; a remote job without one (the
//   page closed while it was being submitted, or before its id was saved) is looked up at the provider
//   (provider.recover: finds the job without ever creating one) and resumes when found; otherwise it is marked failed
//   with UNKNOWN_SUBMIT_ERROR — it is NEVER submitted again by itself (that could pay twice).
// Paying once per take: the take id is the idempotency key (client_request_id). A remote take whose submit ended
// "unknown" (UNKNOWN_SUBMIT_ERROR) is re-sent only by an explicit retry(takeId), as THE SAME take (same key; the
// provider looks for the job first, and sends again only when it can prove no job was created — otherwise the take
// fails with UNVERIFIABLE_SUBMIT_ERROR and only a NEW take, "Tạo lại", can run). A take cancelled before its job
// was created is never billed (submit checks isCancelled before posting). A finished remote video that fails to
// download is retried, never failed at once.
//
// Credits (docs/SPEC-v2.md §9): `credits`/`spent` are the local DEMO wallet of the old demo (play money). Only takes
// run on the mock provider were charged to it (take.charged) — new takes never are: 'dev' takes bill the simulated
// account and 'canvasapp' takes the user's own account, both read in store/credits (useCreditInfo()). New runs data
// start at DEMO_CREDITS_DEFAULT (1000); saved balances are kept as they are.
// Engine events for other stores (e.g. store/credits refreshes the real balance after a canvasapp job):
//   onRunEvent(listener) → unsubscribe; events { type: 'submitted' | 'completed' | 'failed' | 'cancelled', takeId, provider }.
// (store/credits re-reads the balance of the active gateway after its jobs.)
import { create } from 'zustand'
import { compileScene, imageKey, imageSlotsFor, sceneCode, takeCode } from '../core/compile'
import { cleanTakeFileName } from '../core/fileNames'
import { newId } from '../core/ids'
import { costOf, isModelId, MODELS, usesRefs, usesVideoRefs } from '../core/models'
import { isForeignTake, migrateTake, parkForeignTake } from '../core/migrate'
import { runBlockReason } from '../core/runRules'
import type { Asset, ModelId, Scene, Size, Take, XY } from '../core/types'
import { chargedDemo, DEMO_CREDITS_DEFAULT, formatCreditNumber } from '../lib/credits'
import { useDownloadPrefs } from '../lib/downloads'
import { putBlob } from '../lib/imageStore'
import { activeProviderId, getProvider, providerBlockedReason, registerProvider } from '../providers'
import { createMockProvider, DEFAULT_MOCK_SETTINGS, parseMockSettings, type MockSettings } from '../providers/mock'
import { posterFromVideo } from '../providers/poster'
import {
  isSubmitCancelled,
  isSubmitDeferred,
  isSubmitUncertain,
  isSubmitUnverifiable,
  providerOf,
  type JobFrame,
  type JobImage,
  type JobRequest,
  type ProviderId,
  type RemoteStatus,
} from '../providers/types'
import { browserLocks, createEngineLock, engineLockName, type LockManagerLike } from './engineLock'
import { clampSize, useProject } from './project'

export type { MockSettings, MockSpeed } from '../providers/mock'
export { DEMO_CREDITS_DEFAULT } from '../lib/credits'

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
  /** DEMO credits (play money, local). Never the user's real canvasapp balance — see store/credits. */
  credits: number
  /** Demo credits spent (net of refunds). */
  spent: number
  mock: MockSettings
  /** Last provider problem while polling (null = all good). UI may show it; cleared by the next successful poll. */
  providerIssue: ProviderIssue | null
  /**
   * This tab has queued/running takes but another tab/window of the same project runs the queue (Web Lock held
   * there): progress shown here comes from that tab's saves. UI may say "Đang chạy ở một tab/cửa sổ khác".
   */
  engineElsewhere: boolean

  loadRuns: (data: { takes: Take[]; credits: number; spent: number } | null) => void
  /** Validate scenes before running (used by the confirm dialog). */
  check: (sceneIds: string[]) => SceneRunCheck[]
  enqueue: (sceneIds: string[]) => EnqueueResult
  cancel: (takeId: string) => void
  /**
   * Run a take again. A remote take that failed with UNKNOWN_SUBMIT_ERROR is re-queued AS IS (same take id = same
   * idempotency key: the provider first looks for the job it may already have created, so it is never paid twice);
   * any other take → a new take of its scene (enqueue).
   */
  retry: (takeId: string) => EnqueueResult | null
  toggleStar: (takeId: string) => void
  removeTake: (takeId: string) => void
  /** Delete takes (cancelling running ones) and drop them from every scene's @video refs. */
  removeTakes: (takeIds: string[]) => void
  /** Canvas positions of take nodes (null = back to auto placement). */
  setTakePositions: (positions: Record<string, XY | null>) => void
  /** Canvas sizes of take nodes (null = default size). */
  setTakeSizes: (sizes: Record<string, Size | null>) => void
  /** File name of a take's video (sanitized; null / empty = back to the default "S01_T1 - title"). */
  setTakeFileName: (takeId: string, name: string | null) => void
  setMock: (patch: Partial<MockSettings>) => void
  /** Add demo credits (Settings "+100"). */
  addCredits: (n: number) => void
  /** Settings "Đặt lại credit demo": demo balance back to DEMO_CREDITS_DEFAULT (1000), spent 0. */
  resetDemoCredits: () => void
}

// ---------------------------------------------------------------------------------------------
// Engine events (for other stores; kept here as a listener list so nothing has to import them back)
// ---------------------------------------------------------------------------------------------

export type RunEventType = 'submitted' | 'completed' | 'failed' | 'cancelled'

export interface RunEvent {
  type: RunEventType
  takeId: string
  provider: ProviderId
}

const runListeners = new Set<(e: RunEvent) => void>()

/**
 * Listen to take lifecycle events: 'submitted' (the provider accepted the job: a remote id exists — for canvasapp
 * the account may have been charged), 'completed', 'failed', 'cancelled'. Returns the unsubscribe function.
 * Listeners run synchronously after the store was updated; their errors are swallowed (never break the engine).
 */
export function onRunEvent(listener: (e: RunEvent) => void): () => void {
  runListeners.add(listener)
  return () => {
    runListeners.delete(listener)
  }
}

function emitRun(type: RunEventType, take: Pick<Take, 'id' | 'provider'>) {
  const e: RunEvent = { type, takeId: take.id, provider: providerOf(take) }
  for (const l of [...runListeners]) {
    try {
      l(e)
    } catch {
      /* a listener's problem is not the queue's */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Engine state (module level, not persisted)
// ---------------------------------------------------------------------------------------------

const TICK_MS = 200
/** Floor for remote providers, whatever they declare (canvasapp's own site polls every 60 s). */
const MIN_REMOTE_POLL_MS = 15_000
/** Hard cap of jobs running at once for remote providers (canvasapp: MAX_CONCURRENCY). */
export const MAX_REMOTE_CONCURRENCY = 10

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
/** A submit was deferred (provider: "try later", nothing sent): provider → time before which no queued take starts. */
const startPausedUntil = new Map<ProviderId, number>()
const pollFailures = new Map<ProviderId, number>()
/** Bumped by loadRuns: async work started for a previous project is ignored. */
let generation = 0
/** Takes whose submit (or recovery) this engine started since the last loadRuns: never "adopted" as left over. */
const ownedHere = new Set<string>()
/** Finished remote videos whose download failed: take id → failures so far / time before which not to retry. */
const fetchFailures = new Map<string, number>()
const fetchRetryAt = new Map<string, number>()

/**
 * Error of a remote take whose submit ended without a job id although the request may have reached the provider
 * (connection lost while sending, or the page closed / reloaded meanwhile): whether it was billed is unknown.
 */
export const UNKNOWN_SUBMIT_ERROR =
  'Không rõ yêu cầu đã tới canvasapp hay chưa (mất kết nối, hoặc trang bị đóng/tải lại đúng lúc đang gửi). Kiểm tra trên canvasapp.io.vn trước khi chạy lại để không trả credit hai lần.'
/** The same for a development-mode take: the simulated site never sent anything to canvasapp.io.vn. */
export const DEV_UNKNOWN_SUBMIT_ERROR =
  'Không rõ yêu cầu đã tới canvasapp giả lập hay chưa (mất kết nối, hoặc trang bị đóng/tải lại đúng lúc đang gửi). Xem tab “Job & đơn nạp” của Bảng phát triển trước khi chạy lại để không trả credit dev hai lần.'

/** UNKNOWN_SUBMIT_ERROR in the words of the take's provider ('dev': the Bảng phát triển, not canvasapp.io.vn). */
export const unknownSubmitError = (pid: ProviderId): string => (pid === 'dev' ? DEV_UNKNOWN_SUBMIT_ERROR : UNKNOWN_SUBMIT_ERROR)

/**
 * Error of a retried "unknown" take whose earlier request can no longer be checked (isSubmitUnverifiable: the job list
 * no longer reaches back to it, several jobs could be it, or its record is gone): it may have been billed, so the
 * provider never sends it again — only a NEW take ("Tạo lại", actions.rerunTake) can run, by the user's explicit choice.
 */
export const UNVERIFIABLE_SUBMIT_ERROR =
  'Không kiểm tra được lần gửi trước của take này nữa — canvasapp có thể đã nhận và trừ credit. SanoVids sẽ không gửi lại take này. Xem lịch sử credit và phiên “SanoVids bridge” trên canvasapp.io.vn; muốn thử lại thì bấm “Tạo lại” để tạo một take MỚI (nếu lần trước đã bị trừ thì sẽ trừ thêm một lần).'
/** The same for a development-mode take (the simulated site; nothing went to canvasapp.io.vn). */
export const DEV_UNVERIFIABLE_SUBMIT_ERROR =
  'Không kiểm tra được lần gửi trước của take này nữa — canvasapp giả lập có thể đã nhận và trừ credit dev. SanoVids sẽ không gửi lại take này. Xem tab “Job & đơn nạp” và Lịch sử credit trong Bảng phát triển; muốn thử lại thì bấm “Tạo lại” để tạo một take MỚI (nếu lần trước đã bị trừ thì sẽ trừ thêm credit dev một lần).'
/** UNVERIFIABLE_SUBMIT_ERROR in the words of the take's provider. */
export const unverifiableSubmitError = (pid: ProviderId): string => (pid === 'dev' ? DEV_UNVERIFIABLE_SUBMIT_ERROR : UNVERIFIABLE_SUBMIT_ERROR)
const UNVERIFIABLE_PREFIX = 'Không kiểm tra được lần gửi trước'
const isUnknownSubmitError = (error: string) =>
  error === UNKNOWN_SUBMIT_ERROR || error === DEV_UNKNOWN_SUBMIT_ERROR || error === UNVERIFIABLE_SUBMIT_ERROR || error === DEV_UNVERIFIABLE_SUBMIT_ERROR

/**
 * A remote take whose submit outcome is unknown (UNKNOWN_SUBMIT_ERROR, no job id): it may have been billed, so it is
 * only ever re-sent as THE SAME take (retry: same key, the job is looked up first) — never as a new take.
 */
export function isUncertainSubmit(t: Pick<Take, 'provider' | 'remoteId' | 'status' | 'error' | 'submitUnknown'>): boolean {
  if (providerOf(t) === 'mock' || (t.remoteId ?? null) || (t.status !== 'failed' && t.status !== 'cancelled')) return false
  return !!t.submitUnknown || hasUncertainSubmitText(t.error)
}

/** Takes saved before `submitUnknown` existed: recognised by their error text (current and earlier wordings). */
export function hasUncertainSubmitText(error: string | null | undefined): boolean {
  return !!error && (error.startsWith('Không rõ yêu cầu đã tới canvasapp') || error.includes('không trả mã job') || error.startsWith(UNVERIFIABLE_PREFIX))
}

/**
 * A "maybe billed" take whose earlier request can no longer be checked (UNVERIFIABLE_SUBMIT_ERROR): retrying it as
 * the same take cannot help — its rerun is "Tạo lại", a NEW take the user chooses explicitly (actions.rerunTake).
 */
export function isUnverifiableSubmit(t: Pick<Take, 'provider' | 'remoteId' | 'status' | 'error' | 'submitUnknown'>): boolean {
  return isUncertainSubmit(t) && !!t.error && t.error.startsWith(UNVERIFIABLE_PREFIX)
}

/** A finished remote video could not be downloaded after several tries (it is paid: re-running pays again). */
export const downloadFailedError = (detail: string, pid: ProviderId = 'canvasapp'): string => {
  const why = detail.trim().replace(/\.?$/, '.')
  return pid === 'dev'
    ? `Video đã tạo xong trên canvasapp giả lập (đã trừ credit dev) nhưng SanoVids không tải về được: ${why} Xem job trong Bảng phát triển (tab “Job & đơn nạp”, “Nhật ký”) — chạy lại cảnh sẽ trừ credit dev lần nữa.`
    : `Video đã tạo xong trên canvasapp (đã trừ credit) nhưng SanoVids không tải về được: ${why} Tải video trực tiếp trên canvasapp.io.vn (phiên “SanoVids bridge”) — chạy lại cảnh sẽ trừ credit lần nữa.`
}

/** Download tries of a finished remote video: retried after these delays, then the take fails. */
const FETCH_RETRY_MS = [30_000, 60_000, 120_000, 300_000]

// ---- engine ownership (one tab per project) ----
let lockManagerOverride: LockManagerLike | null | undefined
const engineLock = createEngineLock(() => (lockManagerOverride === undefined ? browserLocks() : lockManagerOverride))
/** While another tab holds the engine lock, try again this often (it is released when that tab idles or closes). */
const LOCK_RETRY_MS = 3000
let lockRetry: ReturnType<typeof setTimeout> | null = null
let acquiring = false

export interface EngineHooks {
  /** False = this tab must not run jobs (e.g. its copy of the project is stale). Checked before starting and every tick. */
  mayRun?: () => boolean
  /**
   * Called after this tab got the engine lock and before it runs anything: bring the open project up to date with
   * storage (another tab may have run jobs meanwhile). Resolve false to give the lock back without running.
   */
  beforeTakeover?: (projectId: string) => Promise<boolean>
}
let hooks: EngineHooks = {}

/** Registered by store/persist.ts (kept as a hook: persist imports this store). */
export function setEngineHooks(next: EngineHooks): void {
  hooks = next
}

/** Tests / embedding: the lock manager to use (null = no Web Locks API → this tab owns the engine; undefined = the browser's). */
export function setEngineLockManager(m: LockManagerLike | null | undefined): void {
  stopEngine()
  lockManagerOverride = m
}

/** Whether this tab currently runs the queue of the open project. */
export function ownsEngine(): boolean {
  return !!engine && engineLock.held() === engineLockName(useProject.getState().project.id)
}

// Before restarting to install an app update, updateActions.installNow holds new submits (queued takes stay queued;
// polling, recovery and downloads go on) and waits until sendingCount() is 0, so no submit is cut half-way.
let submitHold = false

/** Stop (true) / allow again (false) starting queued takes. Not saved: a restart starts with submits allowed. */
export function holdNewSubmits(on: boolean): void {
  submitHold = on === true
}

/** A running remote take whose submit has no remote id yet: it is being sent right now. */
export const isSendingTake = (t: Take): boolean => t.status === 'processing' && providerOf(t) !== 'mock' && !remoteIdOf(t)

/** Takes being sent to their provider right now (see isSendingTake). */
export function sendingCount(): number {
  return useRuns.getState().takes.reduce((n, t) => (isSendingTake(t) ? n + 1 : n), 0)
}

export interface RestartWork {
  /** Queued takes the queue will start (their scene exists). */
  queued: number
  processing: number
  /** Of `processing`: being sent right now (isSendingTake). */
  sending: number
}

/**
 * A take of a newer SanoVids build: its provider (migrateTake: provider 'mock' + foreignProvider) or its model
 * (foreignModel, e.g. a later canvasapp model) is unknown here. This build never runs, polls, looks up, re-queues or
 * refunds it: migrate parks a running one as 'failed' (parkForeignTake) and the engine parks any it still finds running.
 */
export { isForeignTake }

/**
 * A parked take of a newer build (parkForeignTake: 'failed' + foreignStatus): it may still be running — and be paid —
 * in that build, so bulk clean-ups ("Dọn job lỗi/đã huỷ") never delete it.
 */
export const isParkedTake = (t: Pick<Take, 'foreignStatus'>): boolean => !!t.foreignStatus

/** Takes "Dọn job lỗi/đã huỷ" deletes: failed / cancelled ones, never a parked take of a newer build (isParkedTake). */
export function clearableTakes<T extends Pick<Take, 'status' | 'foreignStatus'>>(takes: readonly T[]): T[] {
  return takes.filter((t) => (t.status === 'failed' || t.status === 'cancelled') && !isParkedTake(t))
}

/** Error of a take whose model this build does not know when it was about to be sent (never sent, nothing charged). */
export const UNKNOWN_MODEL_ERROR = 'Model của video này không có trong bản SanoVids này — cập nhật SanoVids để chạy (không gửi đi, không trừ credit).'

/**
 * What an app restart would interrupt (updateActions "Cập nhật khi xong", UpdateDialog, the update pill). A queued take
 * whose scene was deleted is left out: the queue never starts it (it waits for an Undo of the delete) and it is kept
 * across a restart, so waiting for it would wait forever. A newer build's take (isForeignTake) never counts either.
 */
export function restartWork(takes: readonly Take[], sceneIds: ReadonlySet<string>): RestartWork {
  let queued = 0
  let processing = 0
  let sending = 0
  for (const t of takes) {
    if (isForeignTake(t)) continue
    if (t.status === 'queued') {
      if (sceneIds.has(t.sceneId)) queued++
    } else if (t.status === 'processing') {
      processing++
      if (isSendingTake(t)) sending++
    }
  }
  return { queued, processing, sending }
}

/** restartWork() of the open project, right now. */
export function currentRestartWork(): RestartWork {
  return restartWork(useRuns.getState().takes, new Set(useProject.getState().project.scenes.map((s) => s.id)))
}

function savedMock(): MockSettings {
  try {
    const raw = localStorage.getItem('bdp:pref:mock')
    if (raw) return parseMockSettings(JSON.parse(raw))
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_MOCK_SETTINGS }
}

const mockProvider = createMockProvider(() => useRuns.getState().mock)
registerProvider(mockProvider)

/**
 * Reference videos (@video_N) per request that the gateway of new takes accepts for this model — its
 * capabilities().maxRefVideos (canvasapp and development mode: 0) — or null for the old demo, which had no gateway
 * limit. The run-block rules (core/runRules) use it in check() and on every Run button; a component calling it must
 * re-render when the provider choice changes (useCreditKind() does).
 */
export function providerVideoCapFor(model: ModelId, providerId: ProviderId = activeProviderId()): number | null {
  return providerId === 'mock' ? null : getProvider(providerId).capabilities(model).maxRefVideos
}

/** Paid with demo credits (so refunded on failure / cancel). canvasapp takes never are, whatever the flag says. */
const isCharged = (t: Take) => chargedDemo(t)
const remoteIdOf = (t: Take) => t.remoteId ?? null

export const useRuns = create<RunsState>()((set, get) => ({
  takes: [],
  credits: DEMO_CREDITS_DEFAULT,
  spent: 0,
  mock: savedMock(),
  providerIssue: null,
  engineElsewhere: false,

  loadRuns: (data) => {
    resetEngineState()
    // Takes are shown as saved. Takes left running are adopted when this tab gets the engine (see adoptOrphans):
    // another tab may still be running them right now.
    const takes = (data?.takes ?? []).map(migrateTake)
    // New runs data start with DEMO_CREDITS_DEFAULT; a saved demo balance is kept as it is.
    const credits = finite(data?.credits) ?? DEMO_CREDITS_DEFAULT
    const spent = finite(data?.spent) ?? 0
    set({ takes, credits, spent, providerIssue: null, engineElsewhere: false })
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
        const takeStatus = (id: string) => takes.find((t) => t.id === id)?.status
        const compiled = compileScene(project, scene, { takeStatus })
        // The one rule list (core/runRules) shared with every Run button.
        const reason = runBlockReason({
          scene,
          assets: project.assets,
          compiled,
          takeStatus,
          spec: MODELS[scene.settings.model],
          providerVideoCap: providerVideoCapFor(scene.settings.model, providerId),
        })
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
    // Only the demo provider spends the local demo credits; a real provider charges the user's own account (and is
    // never blocked by the demo balance — canvasapp itself refuses a job the account cannot pay).
    const chargeLocal = providerId === 'mock'
    if (chargeLocal && cost > get().credits) {
      return {
        queued: 0,
        cost,
        skipped,
        error: `Không đủ credit demo: cần ${formatCreditNumber(cost)}, còn ${formatCreditNumber(get().credits)} (credit giả lập — đặt lại hoặc thêm trong Cài đặt).`,
      }
    }

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
        videoRefsSnapshot: [...scene.videoRefs],
        // Every image of the refs in @image_N order (before the model's cap), so "restore prompt" renumbers exactly.
        imageKeysSnapshot: imageSlotsFor(project.assets, scene.refs).map(imageKey),
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
        framesSnapshot: { first: frameSnapshotKey(project.assets, scene.firstFrame), last: frameSnapshotKey(project.assets, scene.lastFrame) },
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
    emitRun('cancelled', take)
  },

  retry: (takeId) => {
    const take = get().takes.find((t) => t.id === takeId)
    if (!take) return null
    if (isUncertainSubmit(take)) {
      // Never a new take (new key) here: the first request may have been billed. The same take goes again.
      const blocked = providerBlockedReason(providerOf(take))
      if (blocked) return { queued: 0, cost: 0, skipped: [], error: blocked }
      ownedHere.delete(takeId)
      set((s) => ({
        takes: s.takes.map((t) => (t.id === takeId ? { ...t, status: 'queued', progress: 0, startedAt: null, finishedAt: null, error: null, submitUnknown: true } : t)),
      }))
      ensureEngine()
      return { queued: 1, cost: take.cost, skipped: [] }
    }
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
  setTakeFileName: (takeId, name) =>
    set((s) => {
      const clean = cleanTakeFileName(name)
      const cur = s.takes.find((t) => t.id === takeId)
      if (!cur || (cur.fileName ?? null) === clean) return s
      return {
        takes: s.takes.map((t) => {
          if (t.id !== takeId) return t
          const next = { ...t }
          if (clean) next.fileName = clean
          else delete next.fileName
          return next
        }),
      }
    }),
  setMock: (patch) => {
    const mock = parseMockSettings(patch, get().mock)
    try {
      localStorage.setItem('bdp:pref:mock', JSON.stringify(mock))
    } catch {
      /* ignore */
    }
    set({ mock })
  },
  addCredits: (n) => {
    if (!Number.isFinite(n)) return
    set((s) => ({ credits: s.credits + n }))
  },
  resetDemoCredits: () => set({ credits: DEMO_CREDITS_DEFAULT, spent: 0 }),
}))

function finite(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * take.framesSnapshot value for a frame asset: "assetId:imageId" (its primary image NOW, like core/compile imageKey),
 * so changing the asset's pictures while the take waits never changes the frame that is sent. The asset id alone
 * when it has no image (check() blocks that for transform); null without a frame.
 */
export function frameSnapshotKey(assets: Asset[], assetId: string | null): string | null {
  if (!assetId) return null
  const imageId = assets.find((a) => a.id === assetId)?.imageIds[0]
  return imageId ? imageKey({ assetId, imageId }) : assetId
}

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
  startPausedUntil.clear()
  pollFailures.clear()
  ownedHere.clear()
  fetchFailures.clear()
  fetchRetryAt.clear()
  mockProvider.reset?.()
  // The engine restarts for the loaded data (and adopts what was left running). The lock is kept for the same
  // project — persist reloads it right after this tab took over — and let go for another one.
  if (engine) clearInterval(engine)
  engine = null
  clearLockRetry()
  const held = engineLock.held()
  if (held && held !== engineLockName(useProject.getState().project.id)) engineLock.release()
}

const hasWork = (takes: Take[]) => takes.some((t) => t.status === 'queued' || t.status === 'processing')

function setElsewhere(v: boolean) {
  if (useRuns.getState().engineElsewhere !== v) useRuns.setState({ engineElsewhere: v })
}

function clearLockRetry() {
  if (lockRetry) clearTimeout(lockRetry)
  lockRetry = null
}

/**
 * Stop running jobs in this tab and let another tab take over (the lock is released). Takes keep their state.
 * Called by persist when this tab's copy of the project became stale; ensureEngine() starts again when allowed.
 */
export function stopEngine(): void {
  if (engine) clearInterval(engine)
  engine = null
  clearLockRetry()
  engineLock.release()
  setElsewhere(false)
}

/** Run the queue in this tab when there is work and this tab may own the engine of the open project. */
function ensureEngine() {
  if (engine || acquiring) return
  if (!hasWork(useRuns.getState().takes)) {
    // Nothing to run: never sit on the lock (another tab may need it).
    stopEngine()
    return
  }
  if (hooks.mayRun && !hooks.mayRun()) return
  const projectId = useProject.getState().project.id
  const got = engineLock.tryAcquire(engineLockName(projectId))
  if (got === true) {
    startEngine()
    return
  }
  acquiring = true
  void (async () => {
    let started = false
    try {
      if (!(await got)) {
        if (useProject.getState().project.id === projectId) {
          setElsewhere(true)
          clearLockRetry()
          lockRetry = setTimeout(() => {
            lockRetry = null
            ensureEngine()
          }, LOCK_RETRY_MS)
        }
        return
      }
      let may = useProject.getState().project.id === projectId
      if (may && hooks.beforeTakeover) {
        try {
          may = await hooks.beforeTakeover(projectId)
        } catch {
          may = false
        }
      }
      if (!may || useProject.getState().project.id !== projectId || (hooks.mayRun && !hooks.mayRun())) {
        if (engineLock.held() === engineLockName(projectId)) engineLock.release()
        return
      }
      startEngine()
      started = true
    } finally {
      acquiring = false
      // Another project was opened meanwhile: run its queue.
      if (!started && useProject.getState().project.id !== projectId) ensureEngine()
    }
  })()
}

function startEngine() {
  clearLockRetry()
  setElsewhere(false)
  adoptOrphans()
  if (!engine) engine = setInterval(tick, TICK_MS)
}

/** The provider can look up a job it may have created for a take (VideoProvider.recover). */
function canRecover(pid: ProviderId): boolean {
  try {
    return typeof getProvider(pid).recover === 'function'
  } catch {
    return false
  }
}

/**
 * Takes found "processing" that this engine did not start (left by a closed/reloaded tab, or by the tab that ran the
 * queue before this one): demo jobs go back to the queue (the mock lives in the page that closed); remote jobs with
 * a remote id are polled again; remote jobs without one are looked up at the provider (recoverTake), or fail with
 * UNKNOWN_SUBMIT_ERROR when it cannot look — never submitted twice.
 */
function adoptOrphans() {
  parkForeignTakes()
  const now = Date.now()
  let refund = 0
  let changed = false
  const failed: Take[] = []
  const lookUp: string[] = []
  const takes = useRuns.getState().takes.map((t): Take => {
    if (t.status !== 'processing' || ownedHere.has(t.id) || submitting.has(t.id) || fetching.has(t.id)) return t
    if (providerOf(t) === 'mock') {
      changed = true
      return { ...t, status: 'queued', progress: 0, startedAt: null, remoteId: null }
    }
    if (remoteIdOf(t)) return t
    if (canRecover(providerOf(t))) {
      lookUp.push(t.id)
      return t
    }
    changed = true
    if (isCharged(t)) refund += t.cost
    failed.push(t)
    return { ...t, status: 'failed', finishedAt: now, error: unknownSubmitError(providerOf(t)), submitUnknown: true }
  })
  if (changed) useRuns.setState((s) => ({ takes, credits: s.credits + refund, spent: s.spent - refund }))
  for (const t of failed) emitRun('failed', t)
  for (const id of lookUp) void recoverTake(id)
}

const isForeignRunning = (t: Take) => isForeignTake(t) && (t.status === 'queued' || t.status === 'processing')

/**
 * Backstop of migrateTake (every saved take goes through it in loadRuns): a newer build's take found queued / running
 * is parked (parkForeignTake) instead of being started, polled or adopted — it may still be running in that build.
 */
function parkForeignTakes() {
  if (useRuns.getState().takes.some(isForeignRunning)) useRuns.setState((s) => ({ takes: s.takes.map(parkForeignTake) }))
}

const findTake = (id: string) => useRuns.getState().takes.find((t) => t.id === id)
const stillProcessing = (id: string, gen: number) => gen === generation && findTake(id)?.status === 'processing'

function patchTake(id: string, patch: Partial<Take>) {
  useRuns.setState((s) => ({ takes: s.takes.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
}

/** Mark a running take failed, refunding demo credits when they were charged. */
function failTake(id: string, error: string, progress?: number) {
  const t = findTake(id)
  if (!t || t.status !== 'processing') return
  const refund = isCharged(t) ? t.cost : 0
  useRuns.setState((s) => ({
    takes: s.takes.map((x) =>
      x.id === id
        ? { ...x, status: 'failed', finishedAt: Date.now(), error, progress: progress ?? x.progress, ...(isUnknownSubmitError(error) ? { submitUnknown: true } : {}) }
        : x,
    ),
    credits: s.credits + refund,
    spent: s.spent - refund,
  }))
  emitRun('failed', t)
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
    const p = getProvider(pid)
    // The floor protects the real site; the in-app dev simulator declares its own (3 s).
    return Math.max(p.minPollIntervalMs ?? MIN_REMOTE_POLL_MS, p.capabilities('seedance_2_5').pollIntervalMs)
  } catch {
    return MIN_REMOTE_POLL_MS
  }
}

function tick() {
  // This tab may no longer run jobs (stale copy), or the lock is not for the open project: stop / start over.
  if ((hooks.mayRun && !hooks.mayRun()) || engineLock.held() !== engineLockName(useProject.getState().project.id)) {
    stopEngine()
    ensureEngine()
    return
  }
  parkForeignTakes()
  const { takes } = useRuns.getState()
  const active = takes.filter((t) => t.status === 'processing')
  const queued = takes.filter((t) => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)
  if (!active.length && !queued.length) {
    // Idle: let the lock go, so a tab that queued jobs meanwhile can run them.
    stopEngine()
    return
  }
  const now = Date.now()
  const scenes = new Set(useProject.getState().project.scenes.map((s) => s.id))

  // Start queued jobs up to each provider's concurrency cap. A take whose scene was deleted waits (never sent while
  // the scene is gone; Undo of the delete brings the scene back and the take runs).
  const running = new Map<ProviderId, number>()
  for (const t of active) running.set(providerOf(t), (running.get(providerOf(t)) ?? 0) + 1)
  // A remote provider gets ONE new submit at a time: a take is only marked running once the previous one has its
  // remote id (the canvasapp adapter sends them one by one anyway). The takes behind it stay honestly "queued": they
  // cancel cleanly, and a page closed meanwhile leaves at most one take whose submit is unknown — not up to 10.
  const sending = new Set<ProviderId>()
  for (const t of active) if (providerOf(t) !== 'mock' && !remoteIdOf(t)) sending.add(providerOf(t))
  const started: Take[] = []
  // An app update is about to restart SanoVids (holdNewSubmits): nothing new is sent meanwhile.
  for (const t of submitHold ? [] : queued) {
    if (!scenes.has(t.sceneId)) continue
    const pid = providerOf(t)
    const n = running.get(pid) ?? 0
    if (n >= concurrencyFor(pid)) continue
    if (pid !== 'mock') {
      if (sending.has(pid) || now < (startPausedUntil.get(pid) ?? 0)) continue
      sending.add(pid)
    }
    running.set(pid, n + 1)
    started.push(t)
  }
  if (started.length) {
    const ids = new Set(started.map((t) => t.id))
    useRuns.setState((s) => ({ takes: s.takes.map((t) => (ids.has(t.id) ? { ...t, status: 'processing', startedAt: now, progress: 1 } : t)) }))
    for (const t of started) void submitTake(t.id)
  }

  // Running takes without a remote id whose submit is not in flight: the demo submits again (free, same key);
  // a remote one is never submitted twice — it is looked up at the provider once (not found → fails with a hint).
  for (const t of active) {
    if (remoteIdOf(t) || submitting.has(t.id) || fetching.has(t.id)) continue
    if (providerOf(t) === 'mock') void submitTake(t.id)
    else if (!ownedHere.has(t.id) && canRecover(providerOf(t))) void recoverTake(t.id)
    else failTake(t.id, unknownSubmitError(providerOf(t)))
  }

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

/**
 * Reference images of a take, numbered EXACTLY like the prompt it was compiled with (@image_1 = first, …).
 * The prompt and imageKeysSnapshot are captured together when the take is queued, so editing a character's
 * images while the take waits in the queue can never shift the numbers (wrong character on @image_N).
 * Older takes without the snapshot fall back to the refs snapshot + current asset images.
 */
export function requestImages(t: Pick<Take, 'refsSnapshot' | 'imageKeysSnapshot'>, assets: Asset[], maxRefImages: number): JobImage[] {
  if (t.imageKeysSnapshot) {
    return t.imageKeysSnapshot.slice(0, maxRefImages).map((key, i) => {
      const cut = key.indexOf(':')
      return { n: i + 1, assetId: key.slice(0, cut), imageId: key.slice(cut + 1) }
    })
  }
  return imageSlotsFor(assets, t.refsSnapshot)
    .slice(0, maxRefImages)
    .map(({ n, assetId, imageId }) => ({ n, assetId, imageId }))
}

/** Request for a take, built from its snapshot (prompt, image keys, refs, video refs, frames). */
function buildRequest(t: Take): JobRequest {
  const project = useProject.getState().project
  const scene = project.scenes.find((s) => s.id === t.sceneId)
  const spec = MODELS[t.settings.model] ?? MODELS.seedance_2_5
  const takes = useRuns.getState().takes
  const images = usesRefs(t.settings) ? requestImages(t, project.assets, spec.maxRefImages) : []
  const videos = usesVideoRefs(t.settings)
    ? t.videoRefsSnapshot.slice(0, spec.maxRefVideos).map((takeId, i) => {
        const v = takes.find((x) => x.id === takeId)
        return { n: i + 1, takeId, videoId: v?.videoId ?? null, posterId: v?.posterId ?? null }
      })
    : []
  const frames = t.framesSnapshot ?? { first: scene?.firstFrame ?? null, last: scene?.lastFrame ?? null }
  const frame = (snap: string | null): JobFrame | null => {
    if (!snap || t.settings.mode !== 'transform') return null
    // "assetId:imageId" = the exact picture at enqueue (frameSnapshotKey); a bare asset id (older takes) = its
    // primary image now.
    const cut = snap.indexOf(':')
    if (cut > 0) return { assetId: snap.slice(0, cut), imageId: snap.slice(cut + 1) }
    const imageId = project.assets.find((a) => a.id === snap)?.imageIds[0]
    return imageId ? { assetId: snap, imageId } : null
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
  // A remote job is submitted once per take (a second submit could be paid twice) — except an explicit retry().
  if (providerOf(t) !== 'mock' && (ownedHere.has(id) || remoteIdOf(t))) return
  // Never sent with a model this build does not know (a newer build's take is parked by migrate; this is the backstop):
  // canvasapp would get no model_profile and could still bill the account.
  if (!isModelId(t.settings?.model)) return failTake(id, UNKNOWN_MODEL_ERROR)
  submitting.add(id)
  ownedHere.add(id)
  const pid = providerOf(t)
  const projectId = useProject.getState().project.id
  // Cancelled or deleted in SanoVids (the take, or its scene) → the provider stops before creating (billing) the
  // job. Another project opened meanwhile is no reason to stop: the job is found again when this project is
  // reopened (recoverTake).
  const isCancelled = () => {
    const p = useProject.getState().project
    return p.id === projectId && (findTake(id)?.status !== 'processing' || !p.scenes.some((s) => s.id === t.sceneId))
  }
  try {
    const provider = getProvider(pid)
    // resend: a retried "maybe billed" take (retry() marks it) — the provider never sends it again without proof
    const { remoteId } = await provider.submit(buildRequest(t), { isCancelled, resend: !!t.submitUnknown })
    // Runs reloaded meanwhile: the new engine adopts the take and asks the provider for this job (recoverTake).
    if (gen !== generation) return void emitRun('submitted', t)
    const cur = findTake(id)
    if (cur?.status === 'processing') patchTake(id, { remoteId })
    else {
      // Cancelled / removed while submitting: stop it at the provider when possible. A remote provider has the job
      // anyway (canvasapp may have charged the account): the cancelled take keeps its id so the UI can say so.
      if (cur && pid !== 'mock') patchTake(id, { remoteId })
      void provider.cancel?.(remoteId)
    }
    emitRun('submitted', t)
  } catch (e) {
    if (gen !== generation) return
    const deferred = isSubmitDeferred(e)
    if (deferred) {
      // The provider asks to try later (e.g. no room until a running job ends): no take of it starts for a while.
      startPausedUntil.set(pid, Date.now() + pollIntervalFor(pid))
    }
    if (deferred || isSubmitCancelled(e)) {
      // Given up before anything was sent: the take never started at the provider (UI: "không bị trừ credit").
      const cur = findTake(id)
      // (A take re-sent after a lost answer keeps its "maybe billed" state: the first request may have been charged.)
      if (cur?.status === 'cancelled' && !remoteIdOf(cur) && !cur.submitUnknown) patchTake(id, { startedAt: null })
      else if (cur?.status === 'processing' && !remoteIdOf(cur)) {
        // Deferred, or its scene was deleted: back to the queue (it waits there for its turn, or until an Undo brings
        // the scene back).
        ownedHere.delete(id)
        patchTake(id, { status: 'queued', progress: 0, startedAt: null })
      }
      return
    }
    if (isSubmitUncertain(e)) return failTake(id, isSubmitUnverifiable(e) ? unverifiableSubmitError(pid) : unknownSubmitError(pid))
    failTake(id, errorText(e))
    const code = (e as { code?: unknown })?.code
    if (pid !== 'mock' && code === 'login-required') {
      useRuns.setState({ providerIssue: { provider: pid, code, message: errorText(e), at: Date.now() } })
    }
  } finally {
    if (gen === generation) submitting.delete(id)
  }
}

/**
 * A remote take running without a remote id that this engine did not submit (the page closed / reloaded while it
 * was being submitted, or before its id was saved): ask the provider for the job that submit may have created —
 * never submit it again. Found → polled like any other; not found → failed with UNKNOWN_SUBMIT_ERROR.
 */
async function recoverTake(id: string) {
  const gen = generation
  const t = findTake(id)
  if (!t || submitting.has(id) || ownedHere.has(id)) return
  // A take of a model this build does not know is never looked up (its jobs cannot be matched): it may be running in
  // the build that knows it — parked, never failed over it.
  if (!isModelId(t.settings?.model)) {
    useRuns.setState((s) => ({ takes: s.takes.map((x) => (x.id === id ? parkForeignTake({ ...x, foreignModel: x.foreignModel || x.settings?.model || '?' }) : x)) }))
    return
  }
  submitting.add(id)
  ownedHere.add(id)
  try {
    const provider = getProvider(providerOf(t))
    const found = provider.recover ? await provider.recover(buildRequest(t)) : null
    if (gen !== generation) return
    const cur = findTake(id)
    if (!found) {
      failTake(id, unknownSubmitError(providerOf(t)))
      return
    }
    if (cur && !remoteIdOf(cur)) patchTake(id, { remoteId: found.remoteId })
    if (cur?.status === 'processing') emitRun('submitted', t)
  } catch {
    if (gen === generation) failTake(id, unknownSubmitError(providerOf(t)))
  } finally {
    if (gen === generation) submitting.delete(id)
  }
}

/**
 * The provider's session works again (e.g. the user logged in to canvasapp after a 401): poll at the next interval
 * instead of waiting out the back-off. Only when the last problem was the login (other back-offs stay).
 */
export function resumeProviderPolling(pid: ProviderId): void {
  const issue = useRuns.getState().providerIssue
  if (!issue || issue.provider !== pid || issue.code !== 'login-required') return
  pollPausedUntil.delete(pid)
  pollFailures.delete(pid)
  useRuns.setState({ providerIssue: null })
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
        emitRun('cancelled', t)
        break
      }
      case 'completed':
        if (t.progress !== 99) progress.set(t.id, 99)
        if (Date.now() < (fetchRetryAt.get(t.id) ?? 0)) break // last download failed: wait a little
        fetching.add(t.id)
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
    fetchFailures.delete(id)
    fetchRetryAt.delete(id)
    emitRun('completed', t)
    if (useDownloadPrefs.getState().autoDownload) {
      // Lazy import avoids a static cycle (actions imports this store).
      void import('../actions').then(({ downloadTake }) => downloadTake(id, { auto: true }))
    }
  } catch (e) {
    if (gen !== generation) return
    if (t && providerOf(t) !== 'mock') {
      // The remote video is finished and paid: a failed download (network, session…) must not end the take — a
      // "failed" take invites a re-run that pays again. Keep it at 99 % and try again later; give up after a while.
      const n = (fetchFailures.get(id) ?? 0) + 1
      fetchFailures.set(id, n)
      if (n <= FETCH_RETRY_MS.length) {
        fetchRetryAt.set(id, Date.now() + FETCH_RETRY_MS[n - 1])
        return
      }
      failTake(id, downloadFailedError(errorText(e), providerOf(t)))
      return
    }
    failTake(id, errorText(e))
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
/** restartWork() as a hook (stable object while the counts do not change). */
export function useRestartWork(): RestartWork {
  const sceneKey = useProject((s) => s.project.scenes.map((x) => x.id).join('|'))
  return useRuns(useShallow((s) => restartWork(s.takes, new Set(sceneKey ? sceneKey.split('|') : []))))
}
