// The in-app sandbox of a stress run: the user's project is saved and put aside, the run works on a temporary project
// of its own ("Thử nghiệm giới hạn <seed>", stored like any project so the real autosave / engine code runs), and
// everything is put back at the end — even after an error or the "Dừng" button:
//   • the user's project is reopened (switchProject) and the temporary one deleted with its videos (deleteProject);
//   • the UI prefs (bdp:pref:*) and the download prefs come back as they were;
//   • the app's own dev server / providers come back (session.ts).
// While it runs, guards block what a stress run must never do: requests to the internet (fetch / XHR / WebSocket /
// sendBeacon outside this page's origin), file downloads and folder pickers, confirm / alert / prompt dialogs.
// A manifest (localStorage 'bdp:stress:session') lets "Dọn dữ liệu thử nghiệm" remove a temporary project left by a
// crash or a closed tab.
import { useDownloadPrefs } from '../../lib/downloads'
import { activeProviderId } from '../../providers'
import { refreshRealCredits } from '../../store/credits'
import { deleteProject, flush, importProjectFile, switchProject, useSave } from '../../store/persist'
import { clearHistory, useProject } from '../../store/project'
import { currentRestartWork, holdNewSubmits, useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { runStress } from './runner'
import { sessionActive } from './session'
import type { GeneratedProject } from './synth'
import type { StressEnv, StressOptions, StressReport, Violation } from './types'

export const MANIFEST_KEY = 'bdp:stress:session'
export const LAST_REPORT_KEY = 'bdp:stress:last-report'
/** How long the end-of-run drain may wait in the app (real time). */
export const APP_DRAIN_MS = 60_000
const PREF_PREFIX = 'bdp:pref:'

interface Manifest {
  originalId: string
  tempId: string | null
  startedAt: number
  seed: string
}

function readManifest(): Manifest | null {
  try {
    const raw = localStorage.getItem(MANIFEST_KEY)
    return raw ? (JSON.parse(raw) as Manifest) : null
  } catch {
    return null
  }
}

function writeManifest(m: Manifest | null) {
  try {
    if (m) localStorage.setItem(MANIFEST_KEY, JSON.stringify(m))
    else localStorage.removeItem(MANIFEST_KEY)
  } catch {
    /* storage unavailable: the cleanup button just finds nothing */
  }
}

/** A temporary project left behind (crash / closed tab during a run), or null. */
export function leftover(): { tempId: string; originalId: string } | null {
  const m = readManifest()
  return m?.tempId ? { tempId: m.tempId, originalId: m.originalId } : null
}

/** Why a run cannot start now (Vietnamese), or null. */
export function startBlockedReason(): string | null {
  if (activeProviderId() !== 'dev') return 'Chỉ chạy ở chế độ Phát triển (giả lập). Đang chọn canvasapp.io.vn thật trong Cài đặt — đổi về Phát triển rồi thử lại.'
  if (sessionActive()) return 'Đang có một lần thử nghiệm chạy.'
  const save = useSave.getState()
  if (!save.ready) return 'Dự án chưa mở xong.'
  if (save.stale) return 'Dự án đang mở đã cũ (một tab khác lưu bản mới hơn). Tải lại trang trước.'
  const w = currentRestartWork()
  if (w.queued + w.processing > 0) return `Dự án của bạn còn ${w.queued + w.processing} video đang chờ / đang tạo — đợi xong (hoặc huỷ) rồi chạy thử nghiệm.`
  if (leftover()) return 'Còn dự án thử nghiệm của lần trước — bấm “Dọn dữ liệu thử nghiệm” trước.'
  return null
}

// ---------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------

interface Guards {
  counters: Record<string, number>
  trips: Violation[]
  errors: string[]
  remove(): void
}

function sameOrigin(url: string): boolean {
  try {
    const u = new URL(url, location.href)
    if (u.protocol === 'blob:' || u.protocol === 'data:') return true
    return u.origin === location.origin
  } catch {
    return true // relative / unparsable: never leaves the page
  }
}

const REAL_HOSTS = /canvasapp\.io\.vn|seedvis\.com|sepay\.vn/i

function installGuards(): Guards {
  const counters: Record<string, number> = {}
  const trips: Violation[] = []
  const errors: string[] = []
  const count = (k: string) => (counters[k] = (counters[k] ?? 0) + 1)
  const restore: (() => void)[] = []
  const blockUrl = (url: string, via: string): boolean => {
    if (sameOrigin(url)) return false
    count(`Yêu cầu mạng bị chặn (${via})`)
    if (REAL_HOSTS.test(url)) trips.push({ invariant: 'S4', severity: 'error', kind: 'app', message: `Có yêu cầu tới máy chủ thật (${url.slice(0, 120)}) trong lúc thử nghiệm — đã chặn.` })
    return true
  }
  const w = window as unknown as Record<string, unknown>

  // network
  const origFetch = window.fetch
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (blockUrl(url, 'fetch')) return Promise.reject(new TypeError('ĐÃ CHẶN mạng trong lúc thử nghiệm giới hạn.'))
    return origFetch.call(window, input, init)
  }) as typeof fetch
  restore.push(() => void (window.fetch = origFetch))
  const origOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    if (blockUrl(String(url), 'XHR')) throw new TypeError('ĐÃ CHẶN mạng trong lúc thử nghiệm giới hạn.')
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
  } as typeof XMLHttpRequest.prototype.open
  restore.push(() => void (XMLHttpRequest.prototype.open = origOpen))
  const OrigWS = window.WebSocket
  if (OrigWS) {
    const Guarded = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      if (blockUrl(String(url).replace(/^ws/, 'http'), 'WebSocket')) throw new TypeError('ĐÃ CHẶN mạng trong lúc thử nghiệm giới hạn.')
      return new OrigWS(url, protocols)
    } as unknown as typeof WebSocket
    Object.assign(Guarded, OrigWS)
    Guarded.prototype = OrigWS.prototype
    window.WebSocket = Guarded
    restore.push(() => void (window.WebSocket = OrigWS))
  }
  if (typeof navigator.sendBeacon === 'function') {
    const origBeacon = navigator.sendBeacon
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => (blockUrl(String(url), 'sendBeacon') ? false : origBeacon.call(navigator, url, data))
    restore.push(() => void (navigator.sendBeacon = origBeacon))
  }

  // downloads and file pickers
  const origClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.hasAttribute('download')) {
      count('Tải file bị chặn')
      return
    }
    return origClick.call(this)
  }
  restore.push(() => void (HTMLAnchorElement.prototype.click = origClick))
  for (const name of ['showSaveFilePicker', 'showDirectoryPicker', 'showOpenFilePicker']) {
    if (!(name in w)) continue
    const orig = w[name]
    w[name] = () => {
      count('Hộp chọn file / thư mục bị chặn')
      return Promise.reject(new DOMException('ĐÃ CHẶN trong lúc thử nghiệm giới hạn.', 'AbortError'))
    }
    restore.push(() => void (w[name] = orig))
  }

  // dialogs
  const origConfirm = window.confirm
  const origAlert = window.alert
  const origPrompt = window.prompt
  window.confirm = () => (count('Hộp xác nhận (trả lời Huỷ)'), false)
  window.alert = () => void count('Hộp thông báo')
  window.prompt = () => (count('Hộp nhập'), null)
  restore.push(() => {
    window.confirm = origConfirm
    window.alert = origAlert
    window.prompt = origPrompt
  })

  // errors (R1)
  const origError = console.error
  console.error = (...args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeText(a))).join(' ')
    if (/^Warning:/.test(text)) count('Cảnh báo React (bỏ qua)')
    else errors.push(text)
    origError.apply(console, args)
  }
  restore.push(() => void (console.error = origError))
  const onError = (e: ErrorEvent) => errors.push(`Lỗi: ${e.message}`)
  const onRejection = (e: PromiseRejectionEvent) => errors.push(`Promise bị từ chối không ai bắt: ${(e.reason as Error)?.message ?? String(e.reason)}`)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  restore.push(() => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  })

  return {
    counters,
    trips,
    errors,
    remove: () => {
      for (const r of restore.reverse()) {
        try {
          r()
        } catch {
          /* keep restoring the others */
        }
      }
    },
  }
}

function safeText(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

// ---------------------------------------------------------------------------------------------
// Prefs snapshot
// ---------------------------------------------------------------------------------------------

function snapshotPrefs(): Map<string, string> {
  const out = new Map<string, string>()
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(PREF_PREFIX)) out.set(k, localStorage.getItem(k) ?? '')
    }
  } catch {
    /* unavailable */
  }
  return out
}

function restorePrefs(before: Map<string, string>) {
  try {
    const now = snapshotPrefs()
    for (const k of now.keys()) if (!before.has(k)) localStorage.removeItem(k)
    for (const [k, v] of before) if (now.get(k) !== v) localStorage.setItem(k, v)
  } catch {
    /* unavailable */
  }
}

// ---------------------------------------------------------------------------------------------
// The app environment
// ---------------------------------------------------------------------------------------------

function appEnv(guards: Guards): StressEnv & { dispose(): void } {
  const longFrames: number[] = []
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (longFrames.length < 500) longFrames.push(Math.round(e.duration))
    })
    observer.observe({ type: 'longtask', buffered: false })
  } catch {
    observer = null // no Long Tasks API here
  }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  return {
    kind: 'app',
    // Real time passes by itself; a step yields to the page (rendering, timers) and waits when asked to.
    advance: (ms) => sleep(Math.max(0, ms)),
    clock: () => performance.now(),
    realSleep: sleep,
    putMedia: () => undefined,
    drainErrors: () => guards.errors.splice(0),
    drainBudgetMs: APP_DRAIN_MS,
    sample: () => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      return { heap: mem?.usedJSHeapSize, dom: document.getElementsByTagName('*').length, longFrames: longFrames.splice(0) }
    },
    guardCounters: () => ({ ...guards.counters }),
    guardTrips: () => guards.trips.splice(0),
    dispose: () => observer?.disconnect(),
  }
}

export interface SandboxHooks {
  onFailure?: (project: unknown, takes: unknown) => void
  /** Restore phase messages for the UI ("Đang trả lại dự án của bạn…"). */
  onPhase?: (text: string) => void
}

/**
 * Run a stress session in the app, isolated from the user's data. Resolves with the report; throws only when the run
 * could not even start (the reason is in the message, nothing was changed).
 */
export async function runInSandbox(options: StressOptions, hooks: SandboxHooks = {}): Promise<StressReport> {
  const blocked = startBlockedReason()
  if (blocked) throw new Error(blocked)
  if (!(await flush())) throw new Error('Chưa lưu được dự án đang mở nên chưa chạy thử nghiệm (để không mất thay đổi). Thử lại sau.')
  const originalId = useProject.getState().project.id
  const seed = options.seed ?? ''
  writeManifest({ originalId, tempId: null, startedAt: Date.now(), seed })
  const prefs = snapshotPrefs()
  const ui = useUI.getState()
  const uiBefore = { view: ui.view, leftOpen: ui.leftOpen, rightOpen: ui.rightOpen, queueOpen: ui.queueOpen, showMinimap: ui.showMinimap, takeDisplay: ui.takeDisplay, edgeMode: ui.edgeMode }
  const autoDownload = useDownloadPrefs.getState().autoDownload
  useDownloadPrefs.setState({ autoDownload: false })
  const guards = installGuards()
  const env = appEnv(guards)
  let tempId: string | null = null

  const load = async (gen: GeneratedProject) => {
    // A stored project of its own: an empty stub through the normal import path (new id, list entry), then the
    // generated content under that id (the autosave writes it like any edit).
    const stub = { format: 'sanovids', version: 2, project: { name: gen.project.name, schemaVersion: 2, scenes: [], assets: [], presets: [] }, media: {} }
    await importProjectFile(new File([JSON.stringify(stub)], 'stress.sanovids.json', { type: 'application/json' }))
    tempId = useProject.getState().project.id
    writeManifest({ originalId, tempId, startedAt: Date.now(), seed })
    useProject.getState().loadProject({ ...gen.project, id: tempId })
    clearHistory()
    useRuns.getState().loadRuns({ takes: gen.takes, credits: 1000, spent: 0 })
  }

  try {
    return await runStress(options, env, { load, onFailure: hooks.onFailure })
  } finally {
    hooks.onPhase?.('Đang trả lại dự án của bạn…')
    holdNewSubmits(true)
    try {
      useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
    } catch {
      /* nothing running */
    }
    env.dispose()
    guards.remove()
    await restoreUser(originalId, tempId)
    useUI.getState().clearSelection()
    useUI.getState().setView(uiBefore.view)
    useUI.getState().setLeftOpen(uiBefore.leftOpen)
    useUI.getState().setRightOpen(uiBefore.rightOpen)
    useUI.getState().setQueueOpen(uiBefore.queueOpen)
    useUI.getState().setMinimap(uiBefore.showMinimap)
    useUI.getState().setTakeDisplay(uiBefore.takeDisplay)
    useUI.getState().setEdgeMode(uiBefore.edgeMode)
    restorePrefs(prefs)
    useDownloadPrefs.setState({ autoDownload })
    holdNewSubmits(false)
    writeManifest(null)
    void refreshRealCredits({ force: true }).catch(() => undefined)
    hooks.onPhase?.('')
  }
}

/** Reopen the user's project and delete the temporary one (with its videos). */
async function restoreUser(originalId: string, tempId: string | null) {
  const current = () => useProject.getState().project.id
  if (current() !== originalId) {
    try {
      await switchProject(originalId)
    } catch {
      // The temporary project could not be saved (storage full?): drop it first, then go back.
      if (tempId && current() === tempId) await deleteProject(tempId).catch(() => undefined)
      if (current() !== originalId) await switchProject(originalId).catch(() => undefined)
    }
  }
  if (tempId && current() !== tempId) await deleteProject(tempId).catch(() => undefined)
}

/** "Dọn dữ liệu thử nghiệm": remove a temporary project a crashed / closed run left behind. */
export async function cleanupLeftovers(): Promise<string> {
  const m = readManifest()
  if (!m) return 'Không có dữ liệu thử nghiệm nào còn sót.'
  if (sessionActive()) return 'Đang chạy thử nghiệm — dừng trước đã.'
  await restoreUser(m.originalId, m.tempId)
  writeManifest(null)
  return m.tempId ? 'Đã xoá dự án thử nghiệm còn sót và mở lại dự án của bạn.' : 'Đã dọn.'
}

/** Keep a short summary of the last report (survives a reload). */
export function rememberReport(r: StressReport, summary: string) {
  try {
    localStorage.setItem(LAST_REPORT_KEY, JSON.stringify({ seed: r.seed, result: r.result, summary, at: Date.now(), failure: r.failure ? { step: r.failure.step, invariant: r.failure.invariant, message: r.failure.message } : null }))
  } catch {
    /* full: not important */
  }
}

export function lastReportSummary(): { seed: string; result: string; summary: string; at: number } | null {
  try {
    const raw = localStorage.getItem(LAST_REPORT_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
