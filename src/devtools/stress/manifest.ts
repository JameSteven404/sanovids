// What an in-app stress run leaves behind, and its clean-up. Light on purpose: StressHud (mounted in development mode)
// imports it at start-up for the crash recovery; the heavy tester (runner, actions…) loads only when a run starts.
//
// While a run lasts (sandbox.ts) it holds the Web Lock RUN_LOCK and keeps a manifest in localStorage
// ('bdp:stress:session'): the user's project id, the temporary project id, the UI layout to give back and the folder
// node ids of the temporary project. A manifest whose lock is free belongs to a run that ended without its clean-up
// (crash, window closed, reload, update restart): recoverLeftover() — run at the next start by StressHud / StressTab —
// deletes the temporary project (and its videos), drops the folder saves it left waiting and gives the layout back.
// The run keeps 'bdp:active' on the user's project, so a restart in the middle reopens the user's project, never the
// temporary one (whose queue would otherwise start again).
import { deleteMedia } from '../../lib/imageStore'
import { markTrashWaiting, markWaiting, trashWaitingTakes, waitingTakes } from '../../lib/saveFolders'
import { deleteProject, switchProject, useSave } from '../../store/persist'
import { useProject } from '../../store/project'
import type { EdgeMode, ViewMode } from '../../core/types'
import { EDGE_MODES, toast, useUI, VIEW_MODES, type TakeDisplay } from '../../store/ui'

export const MANIFEST_KEY = 'bdp:stress:session'
export const LAST_REPORT_KEY = 'bdp:stress:last-report'
/** Web Lock held by a run for its whole duration (also across tabs / windows of this profile). */
export const RUN_LOCK = 'sanovids-stress-run'
/** Without Web Locks: a manifest whose heartbeat is older than this belongs to a run that is gone. */
export const STALE_BEAT_MS = 2 * 60_000
/** store/persist's "project to open at start" key (LS.active). */
export const ACTIVE_PROJECT_KEY = 'bdp:active'
/** At most this many folder node ids are remembered (the folder-loop scenario adds many). */
const MAX_FOLDER_IDS = 500

export interface UiLayout {
  view: ViewMode
  leftOpen: boolean
  rightOpen: boolean
  queueOpen: boolean
  showMinimap: boolean
  takeDisplay: TakeDisplay
  edgeMode: EdgeMode
}

export interface Manifest {
  originalId: string
  tempId: string | null
  startedAt: number
  seed: string
  /** Last sign of life of the run (only used where Web Locks are missing). */
  beat?: number
  ui?: UiLayout
  folderIds?: string[]
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

function parseLayout(raw: unknown): UiLayout | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const view = VIEW_MODES.find((v) => v === r.view)
  const edgeMode = EDGE_MODES.find((v) => v === r.edgeMode)
  if (!view || !edgeMode || !isBool(r.leftOpen) || !isBool(r.rightOpen) || !isBool(r.queueOpen) || !isBool(r.showMinimap)) return undefined
  if (r.takeDisplay !== 'all' && r.takeDisplay !== 'chosen') return undefined
  return { view, leftOpen: r.leftOpen, rightOpen: r.rightOpen, queueOpen: r.queueOpen, showMinimap: r.showMinimap, takeDisplay: r.takeDisplay, edgeMode }
}

/** The stored manifest, validated (anything malformed → null, never a throw). */
export function parseManifest(raw: unknown): Manifest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isStr(r.originalId) || !r.originalId || (r.tempId !== null && !isStr(r.tempId)) || typeof r.startedAt !== 'number' || !isStr(r.seed)) return null
  const m: Manifest = { originalId: r.originalId, tempId: r.tempId || null, startedAt: r.startedAt, seed: r.seed }
  if (typeof r.beat === 'number' && Number.isFinite(r.beat)) m.beat = r.beat
  const ui = parseLayout(r.ui)
  if (ui) m.ui = ui
  if (Array.isArray(r.folderIds)) m.folderIds = r.folderIds.filter((x): x is string => isStr(x) && !!x).slice(0, MAX_FOLDER_IDS)
  return m
}

export function readManifest(): Manifest | null {
  try {
    const raw = localStorage.getItem(MANIFEST_KEY)
    return raw ? parseManifest(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function writeManifest(m: Manifest | null) {
  try {
    if (m) localStorage.setItem(MANIFEST_KEY, JSON.stringify(m))
    else localStorage.removeItem(MANIFEST_KEY)
  } catch {
    /* storage unavailable: the clean-up just finds nothing */
  }
}

/** Merge into the stored manifest (no-op without one). */
export function updateManifest(patch: Partial<Manifest>) {
  const m = readManifest()
  if (m) writeManifest({ ...m, ...patch })
}

/** Remember a folder node id of the temporary project (its waiting saves are dropped at the clean-up). */
export function rememberFolderIds(ids: readonly string[]) {
  const m = readManifest()
  if (!m) return
  const known = new Set(m.folderIds ?? [])
  const added = ids.filter((id) => !known.has(id))
  if (!added.length || known.size >= MAX_FOLDER_IDS) return
  writeManifest({ ...m, folderIds: [...known, ...added].slice(0, MAX_FOLDER_IDS) })
}

/** A temporary project left behind (crash / closed window during a run), or null. */
export function leftover(): { tempId: string; originalId: string } | null {
  const m = readManifest()
  return m?.tempId ? { tempId: m.tempId, originalId: m.originalId } : null
}

/** Keep 'bdp:active' on the user's project while the temporary one is open (see the header). */
export function pinActiveProject(id: string) {
  try {
    if (localStorage.getItem(ACTIVE_PROJECT_KEY) !== id) localStorage.setItem(ACTIVE_PROJECT_KEY, id)
  } catch {
    /* storage unavailable */
  }
}

export function uiLayout(): UiLayout {
  const ui = useUI.getState()
  return { view: ui.view, leftOpen: ui.leftOpen, rightOpen: ui.rightOpen, queueOpen: ui.queueOpen, showMinimap: ui.showMinimap, takeDisplay: ui.takeDisplay, edgeMode: ui.edgeMode }
}

export function restoreUiLayout(l: UiLayout) {
  const ui = useUI.getState()
  const steps: (() => void)[] = [
    () => ui.clearSelection(),
    () => ui.setView(l.view),
    () => ui.setLeftOpen(l.leftOpen),
    () => ui.setRightOpen(l.rightOpen),
    () => ui.setQueueOpen(l.queueOpen),
    () => ui.setMinimap(l.showMinimap),
    () => ui.setTakeDisplay(l.takeDisplay),
    () => ui.setEdgeMode(l.edgeMode),
  ]
  for (const s of steps) {
    try {
      s()
    } catch {
      /* keep restoring the others */
    }
  }
}

/** Saves of the temporary project's folder nodes still waiting for a folder (they never get one): forget them. */
export function forgetFolderSaves(folderIds: readonly string[]) {
  for (const id of folderIds) {
    try {
      const waiting = waitingTakes(id)
      if (waiting.length) markWaiting(id, waiting, false)
      const trash = trashWaitingTakes(id)
      if (trash.length) markTrashWaiting(id, trash, false)
    } catch {
      /* storage unavailable */
    }
  }
}

/** Videos / posters the run stored for its takes (the temporary project's runs are empty by the time it is deleted). */
export async function forgetMedia(ids: Iterable<string>) {
  const list = [...ids]
  for (let i = 0; i < list.length; i += 50) await Promise.all(list.slice(i, i + 50).map((id) => deleteMedia(id).catch(() => undefined)))
}

/**
 * Reopen the user's project (only when the temporary one is still the open one — a user who opened another project
 * meanwhile stays there) and delete the temporary project with its videos. True when the temporary project is gone.
 */
export async function restoreUser(originalId: string, tempId: string | null): Promise<boolean> {
  if (!tempId) return true
  const current = () => useProject.getState().project.id
  const wasOpen = current() === tempId
  if (wasOpen) await switchProject(originalId).catch(() => undefined)
  // Open or not: deleting it opens another project when it is still the open one (the user's project could not be
  // reopened — gone, or the temporary project could not be saved first).
  let gone = true
  await deleteProject(tempId).catch(() => {
    gone = false
  })
  if (wasOpen && current() !== originalId && current() !== tempId) await switchProject(originalId).catch(() => undefined)
  return gone
}

/** Run `fn` while holding RUN_LOCK; { ok: false } when another run (this window or another) holds it. */
export async function withRunLock<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) return { ok: true, value: await fn() }
  let out: { ok: true; value: T } | { ok: false } = { ok: false }
  await locks.request(RUN_LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) out = { ok: true, value: await fn() }
  })
  return out
}

const hasLocks = () => typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function'

const NOT_DELETED = 'Chưa xoá được dự án thử nghiệm còn sót (lỗi bộ nhớ trình duyệt) — thử lại sau.'

/** Clean up after a run that did not finish (needs RUN_LOCK free). True when the temporary project is gone. */
async function cleanUp(m: Manifest): Promise<boolean> {
  const gone = await restoreUser(m.originalId, m.tempId)
  forgetFolderSaves(m.folderIds ?? [])
  if (m.ui) restoreUiLayout(m.ui)
  if (gone) writeManifest(null)
  return gone
}

let recovering: Promise<void> | null = null

/**
 * At start (StressHud / StressTab, development mode): a manifest whose run is gone is cleaned up, once. `running`:
 * a run of this window is going on (its manifest is not a leftover).
 */
export function recoverLeftover(running: () => boolean): Promise<void> {
  recovering ??= (async () => {
    if (!readManifest() || running()) return
    if (!useSave.getState().ready) {
      await new Promise<void>((resolve) => {
        const off = useSave.subscribe((s) => {
          if (s.ready) {
            off()
            resolve()
          }
        })
      })
    }
    const m = readManifest()
    if (!m || running()) return
    if (!hasLocks() && Date.now() - (m.beat ?? m.startedAt) < STALE_BEAT_MS) return
    const res = await withRunLock(async () => {
      const now = readManifest()
      return now && !running() ? { gone: await cleanUp(now), temp: !!now.tempId } : null
    })
    if (!res.ok || !res.value?.temp) return
    if (res.value.gone) toast('Lần Test giới hạn trước bị ngắt giữa chừng: đã xoá dự án thử nghiệm nó để lại.', { tone: 'info', ms: 8000 })
    else toast(NOT_DELETED, { tone: 'warning', ms: 8000 })
  })().catch(() => undefined)
  return recovering
}

/** "Dọn dữ liệu thử nghiệm": the same clean-up on request. */
export async function cleanupLeftovers(running: () => boolean): Promise<string> {
  const m = readManifest()
  if (!m) return 'Không có dữ liệu thử nghiệm nào còn sót.'
  if (running()) return 'Đang chạy thử nghiệm — dừng trước đã.'
  if (!hasLocks() && Date.now() - (m.beat ?? m.startedAt) < STALE_BEAT_MS) return 'Có một lần thử nghiệm vừa chạy ở cửa sổ khác — đợi nó xong (hoặc vài phút) rồi thử lại.'
  const res = await withRunLock(async () => {
    const now = readManifest()
    if (!now) return 'Không có dữ liệu thử nghiệm nào còn sót.'
    if (!(await cleanUp(now))) return NOT_DELETED
    return now.tempId ? 'Đã xoá dự án thử nghiệm còn sót và mở lại dự án của bạn.' : 'Đã dọn.'
  })
  return res.ok ? res.value : 'Đang có một lần thử nghiệm chạy ở cửa sổ khác — đợi nó xong rồi dọn.'
}

/** Keep a short summary of the last report (survives a reload). */
export function rememberReport(r: { seed: string; result: string; failure: { step: number; invariant: string; message: string } | null }, summary: string) {
  try {
    localStorage.setItem(LAST_REPORT_KEY, JSON.stringify({ seed: r.seed, result: r.result, summary, at: Date.now(), failure: r.failure ? { step: r.failure.step, invariant: r.failure.invariant, message: r.failure.message } : null }))
  } catch {
    /* full: not important */
  }
}

export function lastReportSummary(): { seed: string; result: string; summary: string; at: number } | null {
  try {
    const raw = localStorage.getItem(LAST_REPORT_KEY)
    const v: unknown = raw ? JSON.parse(raw) : null
    if (!v || typeof v !== 'object') return null
    const r = v as Record<string, unknown>
    return isStr(r.seed) && isStr(r.result) && isStr(r.summary) && typeof r.at === 'number' ? { seed: r.seed, result: r.result, summary: r.summary, at: r.at } : null
  } catch {
    return null
  }
}
